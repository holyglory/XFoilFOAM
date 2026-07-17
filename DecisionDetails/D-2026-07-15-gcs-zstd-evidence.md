# GCS Zstandard evidence storage

## Decision

Finalized solver evidence is stored as a versioned, content-addressed
Zstandard tar archive in the private Google Cloud Storage bucket
`airfoils-pro-storage-bucket`.  The archive remains the canonical immutable
copy of the mesh, dictionaries, logs, force histories, retained time window,
and VTK fields.  Uncompressed finalized VTK and other archive members are not
retained on the VPS after upload, checksum verification, manifest verification,
and a restore proof succeed.

Rendering hydrates only the required archive members into a bounded,
content-addressed temporary cache.  Concurrent requests share a per-content
lock; extracted members are checked against the immutable evidence manifest;
cache entries are disposable and expire by size and age.  A missing, corrupt,
or unavailable object fails closed and is reported as unavailable evidence.

New archives use the generic `engine_bundle` artifact and
`application/zstd`.  Existing gzip evidence is transcoded without changing the
uncompressed tar byte stream.  Migration records the old compressed identity,
the uncompressed tar identity, the new Zstandard identity, the GCS object
generation and CRC32C, and never removes a local source before the verified
remote generation is durable.  The bucket has a 30-day soft-delete window.
Production uses the GCE VM's attached service-account identity through
Application Default Credentials; no downloadable service-account key is
introduced.

## Why

The VPS currently duplicates renderable VTK inside compressed evidence and as
an uncompressed tree, while the complete campaign remains tens of TiB even
after compression.  Expanding the persistent disk again postpones the same
capacity boundary; filesystem compression does not remove the duplicate and
would require a risky filesystem migration; keeping gzip leaves a measured
26--45% archive reduction unused; storing each VTU independently creates a
large-object-count lifecycle and makes atomic evidence verification harder.
One immutable tar.zst per exact solver result preserves the complete evidence
contract, produces materially smaller and faster-restoring archives, and lets
the 500 GiB VPS serve as active-solve and temporary-render capacity.  The owner
explicitly selected the GCS bucket, Zstandard conversion, and removal of local
raw evidence.

## Evidence and verification

The pre-change production snapshot contained approximately 166 GiB of retained
uncompressed evidence VTK and 132 GiB of gzip bundles.  Representative real
bundles shrank 26--45% under the selected Zstandard settings, and selective VTK
restore completed in 0.25--2.02 seconds on local storage with byte-identical
decompressed tar checksums.  Deployment verification must additionally prove
GCS upload idempotency, generation/CRC/SHA checks, malicious-path rejection,
render-field/extents/default-media restoration with no local VTK, legacy gzip
transcoding, and production storage reclamation.

The 2026-07-17 production reconciliation found 546 complete legacy migration
receipts, 588 current GCS Zstandard objects registered in Postgres
(29,519,552,851 stored bytes), and 605 local immutable remote pointers. The
remaining local corpus still held 3,029 gzip bundles
(147,646,075,989 bytes), 59 temporary/local Zstandard archives
(1,633,338,784 bytes), and 190,833,139,011 bytes of packaged raw evidence.
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
policy.  Fresh canary artifact bindings remain truthfully
`remote-copy-plus-local-archive-pending-database-ack`: raw evidence has been
removed, but the compressed archive is retained until the control plane proves
every database association.  A full case strip deliberately does not perform
that acknowledgement.  The receipt therefore preserves the pending-ack state,
the exact `archive+manifest+all-members-restore:<count>` proof, and the matching
bundle member count.  Node attestation independently requires the full strip to
already be an idempotent no-op with no unknown entries; it never converts an
artifact to `remote-only` merely because stripping or remote rendering worked.

The guarded workflow stores a canonical contract SHA-256 atomically with the
attestation; subsequent engine and control-plane deploys fail before mutation
when that marker is missing or the otherwise-valid storage configuration has
drifted. The only markerless paths are the explicit pristine pre-canary state
and recovery of an exact retained receipt that has not yet been attested.

The guarded production sequence, three-pass legacy migration, reconciliation,
and rollback procedure are defined in
[the GCS Zstandard evidence migration runbook](../docs/evidence-object-storage-runbook.md).
