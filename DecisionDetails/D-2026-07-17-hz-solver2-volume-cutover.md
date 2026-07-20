# D-2026-07-17 hz-solver2 volume-backed OpenCFD 2606 cutover

## Scope and authority

`hz-solver2` is a dedicated downstream solver, not the production hub. The hub
owns catalog/setup truth, promise identity, conflict resolution, accepted
result identity, and canonical GCS evidence. The downstream server may mirror
the exact promised setup, compute it, retain its transfer source, and deliver
evidence; it must not acquire the hub's storage authority or execute the hub's
campaign-successor migration.

Storage is deliberately excluded from numerical compatibility identity. A
result produced by the same exact OpenCFD release, numerics revision, adapter
contract, immutable setup, and physical condition remains the same numerical
implementation whether its transfer source is temporarily on a local volume or
its accepted canonical archive is in GCS. Storage provenance and delivery
state remain explicit evidence/sync metadata.

## Deployment identity and capacity

The authoritative deployment environment declares role `remote-solver` and
Compose project `hz-solver2`. An owner-controlled external override under
`/opt/airfoils-pro/state` is combined with the versioned base Compose file for
build, config, status, stop, recreate, and rollback operations. The merge is
validated before mutation and must resolve all of these values to 40:

- worker CPU-token budget
- in-worker case concurrency
- Celery task concurrency
- container CPU limit

It must also retain the `results`, `engine_runtime`, and PostgreSQL volumes.
This prevents a release promotion or maintenance command from silently using
the base profile's 8-slot defaults or another Compose project's volumes.

## Evidence boundary

The remote solver configures an empty bucket, canonical evidence path prefix,
Zstandard level 10, and `remote-only=false`. It receives no service-account
file or hub storage credential. Finalization creates the same immutable
manifest-backed tar.zst bundle but keeps it on the solver's results volume.

The cutover proof forces field extents and rendering through authenticated
extraction from that archive even when unpacked VTK still exists. Its receipt
records both stored-container and uncompressed-tar hashes and byte sizes. The
separate attestation binds the receipt to promoted source, verified database
backup, retained 2406 rollback images, and exact 2606 runtime.

Remote terminal jobs with a `syncPromiseId` remain ineligible for generic
stripping until their empty/job-level delivery row is `delivered` or
`superseded`. This is an explicit future-proof fence even though current
generic strip retains packaged evidence. The hub's GCS cleanup contract remains
unchanged and strict.

## Cutover and recovery

The dedicated workflow holds the shared deploy lock and fails closed unless
engine queues, local jobs, active promises, delivery/cancellation obligations,
media repair, and OpenFOAM child processes are drained. It records a
custom-format PostgreSQL dump, proves it through `pg_restore --list` and a
scratch restore with control counts, retains the prior environment, and tags
the exact running API/worker images before any executable mutation.

Durable phases distinguish preparation, target-image readiness, and installed
runtime. This lets the same target build ID resume safely after a build or
service-recreate interruption. Both OpenCFD pools stay disabled during
recreate. Scheduler and media writers remain stopped through the canary.

Certification uses three real scenarios: a serial two-angle RANS march proving
mesh reuse, two-rank MPI RANS, and forced preliminary URANS/no-shedding. The
terminal marker is installed only after immutable receipt publication, live
archive-only reproof, recovery-bound attestation, and restoration of the prior
writer state.

Explicit rollback is allowed only before a volume receipt exists and before
any database-tracked 2606 simulation job/evidence exists. It uses private
retained-image Compose overrides and restores the prior pool/build state while
leaving database migrations, named volumes, evidence, and backups intact.
After receipt publication, completing the exact attestation is safer than
abandoning verified 2606 evidence, so rollback is refused.

## Alternatives considered

- Reuse the production hub GCS profile: rejected because it distributes hub
  credentials and canonical-write authority to a downstream compute node.
- Run only the base deployment Compose file: rejected because it resolves the
  worker to 8 slots and risks project/volume identity drift.
- Change the OpenFOAM image with a raw `docker compose up --force-recreate`:
  rejected because it can kill active solver children and has no durable
  backup, rollback, source, or evidence proof.
- Run the hub's 2406→2606 campaign successor flow on the remote solver:
  rejected because the downstream mirror is not authoritative for campaign
  generations.
- Keep the remote server on 2406: operationally reversible, but rejected for
  the target state because accepted remote work must carry the same executable
  solver provenance expected by the production hub.

## Verification and remaining operation

Repository verification covers the strict volume canary and retained-receipt
reproof, local archive hydration and tamper cleanup, all archive-only render
routes, role/env/Compose validation, state/attestation tamper resistance,
no-clobber receipt publication, and acknowledgement-gated retention. Live
activation, backup hashes, receipt hashes, worker utilization, promise flow,
and hub acknowledgement remain production evidence and must be recorded during
the actual maintenance window.

## Live activation status

The guarded volume-backed OpenCFD 2606 cutover is installed on `hz-solver2`.
The production full-polar broker canary has accepted, delivered, and hub-bound
25 of its 26 exact requested angles. Each accepted transfer has an immutable
GCS generation and checksum; the only remaining angle is running its second
targeted preliminary-URANS recovery. The correction that created this run also
prevents a pending remote preliminary obligation from being downgraded into
ordinary RANS work when the downstream local scheduler is intentionally
disabled.

The canary exposed a separate Celery observability resource leak: every live
`inspect.conf()` queue poll created another worker eventpoll descriptor. The
running worker was protected without restart by raising its soft nofile limit
to 65,536 while the active solve continued. The durable correction caches one
validated runtime identity per exact worker/queue binding, single-flights a
cold inspection, invalidates on a binding change, and declares the same nofile
limit for both worker pools. It must be installed only through the guarded
engine rebuild after the current OpenFOAM child is idle, then verified by
repeated polling and descriptor-count stability before capacity is widened.
