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
all 26 exact requested angles. Each accepted transfer has an immutable GCS
generation and checksum. The second targeted preliminary-URANS run for the
final angle produced stable force coefficients and complete raw evidence,
then exposed a continuation-controller boundary defect: sparse field writes
lagged force sampling at the 20-guessed-period horizon, so the controller
requested that already-observed horizon again and rejected the zero-progress
chunk just short of the physical flat-wake observation floor. A
production-shaped regression now requires horizon selection to use the
strongest same-case physical progress token and skip directly to the next
meaningful slow-edge horizon. The earlier scheduling correction also prevents
a pending remote preliminary obligation from being downgraded into ordinary
RANS work when the downstream local scheduler is intentionally disabled.

The canary exposed a separate Celery observability resource leak: every live
`inspect.conf()` queue poll created another worker eventpoll descriptor. The
running worker was protected without restart by raising its soft nofile limit
to 65,536 while the active solve continued. The durable correction caches one
validated runtime identity per exact worker/queue binding, single-flights a
cold inspection, invalidates on a binding change, and declares the same nofile
limit for both worker pools. It must be installed only through the guarded
engine rebuild while OpenFOAM is idle, then verified by repeated polling and
descriptor-count stability before capacity is widened.

The completed 26th-angle transfer exposed the last hub ownership gap after the
broker had already authenticated and acknowledged the exact object. The import
stored the canonical result, attempt, bundle, and manifest, but did not create
the hub's blob, archive, archive-member, exact campaign-attempt, or FINAL-owner
records. That made the bytes durable yet invisible to restart admission.
Brokered import now asks the authenticated engine to freshly verify the
declared manifest against the exact GCS generation, registers every
evidence-derived member under the exact attempt, repairs only a terminal
campaign row whose current attempt matches when one exists, and creates one
durable FINAL owner before acknowledging the point. A non-campaign canary is
owned by the background lane instead of inventing a campaign association. A
bounded, default-dry-run backfill performs the same fail-closed sequence for
transfers accepted before this correction. The production canary object is
generation `1784546127477342`, with 2,620 declared files plus the exact
manifest; no declared member lacks an evidence role. The hub registered all
2,621 members, created one background FINAL item, and returned the identical
archive and queue on replay before the remote copy was reclaimed.

Post-cutover remote engine maintenance is a distinct complete-state branch of
the same guarded remote workflow. An active promise remains an inert durable
lease while both downstream writers are stopped, so it is preserved across
maintenance; live jobs, unsettled delivery/cancellation work, Redis queue
depth, media repair, and OpenFOAM children still fail closed. The branch moves
both build-id expectations atomically, proves the live container nofile limit,
and restores the exact prior execution-pool and writer states only after health
and runtime identity pass.

Maintenance must not infer transfer quiescence from one read followed by
`docker stop`. A July 24 v4 maintenance attempt proved that the background
single-flight transfer can claim a new result in that interval, verify its GCS
object, and then lose the process before the final polar-binding receipt is
stored locally. The evidence remains safe, but its exact delivery lease
correctly blocks the engine rebuild until normal expiry and replay.

The complete-state path therefore uses the database-backed
`remote_solver_transfer_paused` fence. It records the prior value, raises the
fence while the sweeper is still running, and waits for the pass that already
owns a claim to settle normally. Each later transfer pass rereads the setting
and performs no reclaim, cancellation, delivery, reuse, or hub call while it is
raised. Only after both delivery and cancellation outboxes are quiescent may
the workflow stop the writer and enter the existing engine/Redis/OpenFOAM
guards. A pre-stop timeout or interruption restores the prior fence and leaves
the running engine and writers alone; a post-stop failure remains fail-closed
with writers stopped and OpenCFD admission disabled. Successful maintenance
restores the exact prior fence value after the prior writer state is restored.
This control is deliberately separate from the user CPU cap and solver-enabled
state: maintenance must not cancel hub promises or change compute policy merely
to stop new transfer claims.
