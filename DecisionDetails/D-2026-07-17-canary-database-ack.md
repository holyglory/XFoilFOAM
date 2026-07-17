# Direct canary database-acknowledged evidence cleanup

## Context

The production OpenCFD 2606 cutover canaries submit directly to the Python
engine while ordinary scheduling is paused. They intentionally do not create
canonical simulation-job, result-attempt, result, or artifact-association rows.
The evidence engine uploads each complete content-addressed tar.zst archive to
GCS, verifies the pinned object generation by restoring every non-excluded
manifest member, removes the duplicated raw evidence tree, and retains the
complete local tar.zst until the control plane durably acknowledges its exact
evidence identity.

The 2026-07-17 production canary failure exposed a contract mismatch rather
than a failed upload: the engine truthfully reported
`remote-copy-plus-local-archive-pending-database-ack`, while the direct canary
verifier required `remote-only` before any database registration existed. A
direct retry could therefore repeat real CFD work but could never satisfy the
old gate.

## Decision

Use a two-phase database-backed transition for direct canary evidence:

1. Validate the live runtime, exact canary workload, coefficients, scheduling,
   immutable artifacts, GCS generation, all-member restore, and remote render
   proof for every point. Persist the canonical preliminary receipt in
   `solver_engine_canary_evidence_registrations`. This row is immutable and is
   not a successful cutover attestation.
2. Send the engine an authenticated cleanup request for one exact point and
   evidence base. The request identifies either ordinary canonical result rows
   or one direct-canary registration kind, never both. For a canary it binds
   the registration, preliminary receipt digest, scenario, AoA, artifact
   inventory, manifest-member count and digest, and pinned remote pointer.
3. Before its first acknowledgement, the engine verifies that the retained
   local tar.zst is a regular file whose size and SHA-256 match the remote
   pointer. It atomically records the exact authorization, performs a new
   generation-pinned restore of every bundled manifest member, and only then
   removes the packaged local bytes. An exact replay after a lost response may
   return `no_local_bytes`; a changed authorization fails closed.
4. Persist the engine response as one immutable
   `solver_engine_canary_evidence_cleanup_proofs` row per evidence base. Only
   the exact four required cells qualify: serial RANS 2° and 5° from one job,
   MPI-2 RANS 5°, and forced preliminary URANS 0°, with distinct scenario job
   identities.
5. Persist the successful canary attestation only when its canonical final
   receipt is the exact preliminary receipt plus the registration binding and
   those four database proof rows. Every attestation read revalidates runtime,
   pool, registration, proof-set, point semantics, and receipt digest before a
   cutover may use it.

The control-plane cleanup timeout is independently configurable and defaults
to 960 seconds: the engine's production GCS operation has a 900-second budget,
with one additional minute for HTTP and receipt overhead. The TypeScript and
Python manifest-member digests use deterministic Unicode code-point ordering
so the database acknowledgement is identical across runtimes.

Unrelated old-contract canary jobs remain terminal engine evidence. They are
not imported as canonical results, retrospectively registered, deleted, or
included in a new attestation. A fresh repaired canary owns new job IDs and its
own exact four-point proof set.

## Alternatives rejected

- **Delete the archive immediately after GCS restore.** This leaves no durable
  control-plane association if the canary process or attestation request fails
  after deletion.
- **Create ordinary result rows for direct canaries.** These jobs bypass the
  normal submission and ingestion path; fabricating canonical results would
  violate the solver-evidence boundary.
- **Use the final successful attestation as the cleanup acknowledgement.** The
  attestation requires proof that cleanup succeeded, so making cleanup require
  that same attestation creates a circular gate.
- **Retain the local archive permanently.** This is safe but defeats the
  content-addressed remote evidence and bounded VPS-capacity decision.
- **Accept one job-level cleanup flag.** The serial canary owns two independent
  point archives, and each GCS generation must be restored, acknowledged, and
  replayable independently.

## Verification

The focused verification covers canonical registration replay and conflict,
immutable proof replay, wrong-runtime and wrong-pool ownership, missing/wrong
scenario cells, mismatched point semantics, direct attestation-row insertion,
lost cleanup responses, exact ACK replay, local archive size/SHA mismatch,
mixed/duplicate association kinds, cross-language digest parity, every-point
remote rendering, and the presence of unrelated retained old-contract jobs.
Migration verification also proves 0072 refuses to invent registrations for
historical immutable attestations.

Production remains incomplete until migration 0072, the matching Node
control-plane services, and the matching Python gateway/worker are deployed
together through the guarded staged cutover; a fresh four-point canary reaches
a successful durable attestation; the successor campaign generation is
materialized; and the ordinary continuation proof completes.
