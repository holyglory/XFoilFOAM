# D-2026-07-22 — Remote capacity and promise caps

## Decision

Remote execution policy has two independent limits:

1. The downstream remote solver's CPU cap is the total number of worker CPU
   slots reserved by hub-issued work. A zero cap pauses new admission but lets
   active work drain and continue reconciliation/delivery.
2. The authoritative hub stores a per-registered-solver cap on active,
   unexpired polar promises. A promise is one airfoil plus one immutable setup
   revision and its ordered AoAs; it is not an engine-child count or an AoA
   count.

One continuous polar remains serial and reuses its mesh. Independent polars may
run concurrently until the remote CPU reservation is full. The local production
scheduler keeps its own capacity and is not charged for external promise
leases.

Partial remote points become deliverable as soon as their accepted exact
attempt, authenticated manifest, bundle, and manifest-backed field inventory
are complete. Numeric field extents and scaled default media remain deferred
presentation work and are repaired from generation-pinned evidence after hub
binding.

## Why

The existing remote admission path rejects any new job while one remote job is
active, despite a 40-slot worker. Its CPU setting is copied into each mirrored
job rather than used as a total lane limit. The hub claim route has no durable
per-solver lease cap, and its heartbeat counters are remote-reported telemetry,
not safe admission state. Finally, partial ingest defers extents until a job is
terminal while remote delivery requires extents, so running accepted points
cannot be returned incrementally.

The alternatives were rejected as follows:

- Parallel AoAs inside one polar would discard the continuous march and mesh
  reuse that make production polars physically comparable.
- A global hub promise cap would suppress independent solvers without a shared
  physical resource to justify it; per-solver caps match ownership and scale.
- Relaxing delivery to accept invented or unverified extents would violate the
  evidence contract. Manifest inventory is lossless and cheap, while derived
  extents can be repaired asynchronously.

## Verification evidence

- `apps/sweeper/src/remote-solver.ts` contains the singleton active-job gate and
  the per-job CPU-budget stamping.
- `apps/api/src/sync-routes.ts` creates promises without a solver-cap check.
- `apps/sweeper/src/ingest.ts` deliberately postpones extents until the
  producing job is terminal.
- `apps/sweeper/src/loop.ts` admits one remote/local batch per scheduler tick.

## Implemented

- Migration `0087_remote_capacity_and_field_inventory` adds durable per-job CPU
  weights, registered-solver ownership, per-solver promise caps, and exact
  manifest field inventory.
- The hub claim transaction locks the registered solver, expires its leases,
  and returns an explicit `at_cap` admission state. Admins can change the cap
  through `PATCH /api/admin/sync/solvers/:id/policy`; the Admin Sync panel
  exposes both the remote CPU-slot cap and each solver's polar-promise cap.
- Remote and local schedulers reserve weighted CPU slots independently; a
  remote node fills available capacity with independent serial polars while
  each polar keeps continuous AoA marching and mesh reuse.
- Ingest persists manifest-backed field inventory as soon as a point is
  accepted. Remote delivery no longer waits for terminal numeric extents; it
  still requires the exact manifest, accepted attempt, shipped field media,
  and normal broker/evidence checks.

## Checkout verification

- `apps/sweeper/test/remote-solver-validation.test.ts` and
  `apps/sweeper/test/build-request-transient-pin.test.ts`: 67/67 passed,
  including incremental running-result delivery, ownership isolation, weighted
  admission, retry/recovery, and serial promise lifecycle.
- `apps/api/test/catalog.test.ts`: 6/6 passed, including the authoritative
  one-polar promise cap (`at_cap`) claim response.
- DB/API/sweeper/web type checks, migration application, Prettier, and
  `git diff --check` passed. Formal UI verification of `/admin` at 390×844 and
  1440×900 found zero critical geometry/media findings; live API-backed admin
  controls remain unverified locally because the coordinator's API lease is
  stale and OpenFOAM dependencies are unavailable.
