# GCS Zstandard evidence storage

## Decision

Finalized solver evidence is stored as a versioned, content-addressed
Zstandard tar archive in the private Google Cloud Storage bucket
`airfoils-pro-storage-bucket`. The archive remains the canonical immutable
copy of the mesh, dictionaries, logs, force histories, retained time window,
and VTK fields. Uncompressed finalized VTK and other archive members are not
retained on the VPS after upload, checksum verification, manifest verification,
and a restore proof succeed.

Rendering hydrates only the required archive members into a bounded,
content-addressed temporary cache. Concurrent requests share a per-content
lock; extracted members are checked against the immutable evidence manifest;
cache entries are disposable and expire by size and age. A missing, corrupt,
or unavailable object fails closed and is reported as unavailable evidence.

New archives use the generic `engine_bundle` artifact and
`application/zstd`. Existing gzip evidence is transcoded without changing the
uncompressed tar byte stream. Migration records the old compressed identity,
the uncompressed tar identity, the new Zstandard identity, the GCS object
generation and CRC32C, and never removes a local source before the verified
remote generation is durable. The bucket has a 30-day soft-delete window.
Production uses the GCE VM's attached service-account identity through
Application Default Credentials; no downloadable service-account key is
introduced.

## Why

The VPS currently duplicates renderable VTK inside compressed evidence and as
an uncompressed tree, while the complete campaign remains tens of TiB even
after compression. Expanding the persistent disk again postpones the same
capacity boundary; filesystem compression does not remove the duplicate and
would require a risky filesystem migration; keeping gzip leaves a measured
26--45% archive reduction unused; storing each VTU independently creates a
large-object-count lifecycle and makes atomic evidence verification harder.
One immutable tar.zst per exact solver result preserves the complete evidence
contract, produces materially smaller and faster-restoring archives, and lets
the 500 GiB VPS serve as active-solve and temporary-render capacity. The owner
explicitly selected the GCS bucket, Zstandard conversion, and removal of local
raw evidence.

## Evidence and verification

The pre-change production snapshot contained approximately 166 GiB of retained
uncompressed evidence VTK and 132 GiB of gzip bundles. Representative real
bundles shrank 26--45% under the selected Zstandard settings, and selective VTK
restore completed in 0.25--2.02 seconds on local storage with byte-identical
decompressed tar checksums. Deployment verification must additionally prove
GCS upload idempotency, generation/CRC/SHA checks, malicious-path rejection,
render-field/extents/default-media restoration with no local VTK, legacy gzip
transcoding, and production storage reclamation.

The latest 2026-07-17 production reconciliation found 549 complete
receipt-covered legacy evidence directories and zero incomplete
receipt-covered directories. The remaining local corpus still held 3,026 gzip
bundles (145,861,216,428 bytes), 16 temporary/local Zstandard archives
(216,240,757 bytes), and 60,471 packaged raw files
(187,927,660,666 bytes). No terminal raw directory lacked a protecting archive
or remote pointer.
Those measurements prove that the remote-only write/read path is active and
already reclaimed capacity, but not that the requested legacy migration is
finished. Completion still requires three-pass migration and restore proof for
every remaining eligible terminal bundle, distinct attested cleanup for
canary-only archives, zero unprotected terminal raw evidence, and reconciled
filesystem/database/GCS counts.

A terminal engine job can contain genuine durable evidence even when its
worker died before exact result-attempt ingestion. For that zero-owner case,
the migration records an immutable orphan quarantine rather than inventing a
result or rediscovering ownership from rounded AoA. The quarantine is pinned
to the exact sim job, engine job/case/path, manifest/member set, source
archives, migration receipt, and GCS generation, with fixed reason
`terminal_engine_evidence_not_ingested`. Pass 3 accepts the distinct
acknowledgement only after recomputing those identities and then performs the
same fresh generation-pinned all-member restore before deleting local raw
bytes. Quarantine is intentionally immutable-only: any future recovery must
reference an independently ingested exact result/attempt rather than mutating
preserved evidence into a result.

OpenCFD 2606 certification binds the canary receipt to the live gateway's exact
bucket, object prefix, Zstandard level, and top-level remote-only storage
policy. Fresh canary artifact bindings remain truthfully
`remote-copy-plus-local-archive-pending-database-ack`: raw evidence has been
removed, but the compressed archive is retained until the control plane proves
every database association. A full case strip deliberately does not perform
that acknowledgement. The receipt therefore preserves the pending-ack state,
the exact `archive+manifest+all-members-restore:<count>` proof, and the matching
bundle member count. Node attestation independently requires the full strip to
already be an idempotent no-op with no unknown entries; it never converts an
artifact to `remote-only` merely because stripping or remote rendering worked.

The protected production proof set contains six explicitly enumerated legacy
gzip case migrations and one separate OpenCFD 2606 successor-evidence proof.
The six legacy cases and their protected pass-1 audit identities are:

- job `920ea7cb6dfd48f6936497fc6d08ae0e`,
  `cases/c0p05_u90_a19/evidence`, object SHA-256
  `7079fa3c3524fe70d0805f27f0d145fdc3e316e45d9fa28b68386a9bec7333ec`;
- job `7e5aabfeac8c46299af2c5ec09687a72`,
  `cases/c0p05_u90_a14/evidence`, object SHA-256
  `acf356cb3074355fe8d6623b2b12f3450a149432e87c28f264b4ef1fd5ccf1d4`;
- job `30021fb0a55e466da43df992baa1fd41`,
  `cases/c0p05_u166_a20/evidence`, object SHA-256
  `f8516f0c9235f66d004459e11497be3cce704ff9c4eb185ce481df1d3ba789fc`;
- job `d1a335e15fa74204978a64948f41644a`, cases
  `cases/c0p05_u30/a0/evidence`, `a1/evidence`, and `a2/evidence`, with
  object SHA-256 values
  `e24d897dc0912ce179587a957780f2a63b195a8692c80d689ce5c6550f284c2e`,
  `7fb277bd6de4353d68ad9250add30b593da9658d80982c1bdb9257c597c2070f`,
  and
  `67215409b485063bc2bc867453c65d7675af1baf57f3512d793d7165e9f722b2`.

Their pass-1/pass-2/pass-3 receipts are retained below
`/opt/airfoils-pro/state/audit/2026-07-17-three-stage-urans-rollout/`.
The seventh proof is not an inferred orphan or a synthetic database binding:
campaign job `28d9ac1c-ad4d-4c60-a34b-f090842eeb54` produced canonical result
`fa5ec6aa-cbd4-4035-900d-3f2dd44a92bc`, bound to exact continuation attempt
`e59a73ff-c84a-473f-8f5e-1ce7ab5c7087`. Its retained certification log is
`/opt/airfoils-pro/state/audit/2026-07-17-successor-continuation/certify-successor-continuation.log`.
This makes the seven-case claim auditable while keeping the 11 zero-owner
canary-only archives outside legacy registration and orphan quarantine.

The guarded workflow stores a canonical contract SHA-256 atomically with the
attestation; subsequent engine and control-plane deploys fail before mutation
when that marker is missing or the otherwise-valid storage configuration has
drifted. The only markerless paths are the explicit pristine pre-canary state
and recovery of an exact retained receipt that has not yet been attested.

The guarded production sequence, three-pass legacy migration, reconciliation,
and rollback procedure are defined in
[the GCS Zstandard evidence migration runbook](../docs/evidence-object-storage-runbook.md).
