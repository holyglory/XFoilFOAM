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

A remote promise release is also typed. `terminal_local_state` means the exact
unchanged physical cell has no authorized local attempt left;
`operator_release` and `authority_rejected` relinquish scheduling ownership
without claiming physical exhaustion. The hub suppresses a terminal cell only
for the same registered solver and build version. Another solver or a later
build remains eligible.

## Why

The existing remote admission path rejects any new job while one remote job is
active, despite a 40-slot worker. Its CPU setting is copied into each mirrored
job rather than used as a total lane limit. The hub claim route has no durable
per-solver lease cap, and its heartbeat counters are remote-reported telemetry,
not safe admission state. Finally, partial ingest defers extents until a job is
terminal while remote delivery requires extents, so running accepted points
cannot be returned incrementally.

The live July 24 burn-in also produced more than 1,400 cancelled promises for
one exact cell already exhausted on the remote node. The untyped cancellation
gave the hub no durable reason to avoid immediately leasing it back to the same
build, starving eligible work behind it.

The alternatives were rejected as follows:

- Parallel AoAs inside one polar would discard the continuous march and mesh
  reuse that make production polars physically comparable.
- A global hub promise cap would suppress independent solvers without a shared
  physical resource to justify it; per-solver caps match ownership and scale.
- Relaxing delivery to accept invented or unverified extents would violate the
  evidence contract. Manifest inventory is lossless and cheap, while derived
  extents can be repaired asynchronously.
- Retrying terminal work unchanged preserves the starvation loop. Excluding a
  terminal cell globally or forever prevents recovery by another solver or a
  corrected build. A same-solver, same-build exclusion is the narrow durable
  boundary.

## Verification evidence

- Migration `0087_remote_capacity_and_field_inventory` owns the durable CPU
  weights, registered-solver promise ownership, promise-cap policy, and exact
  manifest field inventory.
- `apps/api/src/sync-routes.ts` enforces the authoritative per-solver promise
  cap under the registered-solver row lock.
- `apps/sweeper/src/remote-solver.ts` counts local CPU reservations separately
  from hub leases, walks independent mirrored polars, claims further hub work
  while CPU slots remain, and keeps artifact transfer outside admission.
- `apps/sweeper/src/reconcile.ts` rotates a bounded foreground active-job batch
  and ingests one running partial snapshot only once per pass.
- `apps/sweeper/src/loop.ts` admits higher-priority FAST work, fills remote and
  local CPU slots, then starts one background transfer drain.

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
- Hub-lease reconciliation, CPU admission, and artifact transfer are separate
  phases. Slow generation-pinned GCS restore/upload is process-local
  single-flight background work and cannot hold the next admission tick.
- Foreground reconciliation is limited to eight oldest active jobs per
  unscoped pass. Status updates rotate each visited job to the back, preserving
  eventual partial publication while giving CPU refill a bounded opportunity.
- A newly claimed serial polar no longer becomes a node-wide busy stop. The
  same admission pass continues claiming independent polars until the 40-slot
  CPU cap or the authoritative promise cap is reached.

## Checkout verification

- The earlier migration/API baseline passed 67/67 focused sweeper tests and 6/6
  catalog tests, including weighted admission and the authoritative `at_cap`
  response.
- New MUST-CATCH regressions cover transfer I/O versus admission, duplicate
  running-partial ingestion, the bounded reconciliation budget, and multiple
  newly claimed promises filling one tick. A terminal-burst regression also
  proves four bounded reconciliation workers run concurrently and that jobs
  absent from the live engine queue are retired before still-active rows.
- Sweeper TypeScript checking, Prettier, `git diff --check`, and isolated
  runtime contracts passed for the deployed changes. The focused Vitest files
  were discovered but could not execute in this checkout because their global
  setup requires PostgreSQL on localhost:5432 and that service is offline;
  this is an environmental test limitation, not a reported green run.

## Live deployment and operating proof

- Production and `hz-solver2` run exact source
  `1f6a7cf7144e5c7aa1a2a52b95b0d8ecad9da609`. Production deployment
  [30010786769](https://github.com/holyglory/XFoilFOAM/actions/runs/30010786769)
  completed successfully. Both deployments recreated only Node control-plane
  services; the OpenFOAM API and worker containers remained two days old and
  their active CFD children were preserved.
- The production OpenCFD 2606 pool is enabled at 8 CPU slots. OpenCFD 2406 and
  Foundation 14 remain disabled. The remote CPU budget is 40; its hub promise
  cap is 48 so transient ingest/delivery ownership cannot strand executable
  CPU slots while the execution cap remains hard at 40.
- A terminal burst first exposed 13 stale reservations and dropped the remote
  engine to 26 active jobs. Concurrent bounded reconciliation reduced a pass
  from more than four minutes to about 69 seconds; queue-aware terminal
  priority then restored 40 active jobs plus one engine-reserved task. Docker
  measured 4006% worker CPU against its 40-core quota. Production independently
  reported eight active engine jobs. Remote delivery advanced from 794 to 815
  delivered generations with 21 superseded, zero blocked deliveries, and one
  ordinary automatic retry wait.
- An authenticated browser-equivalent request rendered the live campaign as
  running with eight active production jobs, and the public AG24 detail route
  rendered its stored profile and 86-point polar. Both routes had zero browser
  errors and zero console errors. The loaded campaign API returned HTTP 200,
  although its cold under-load response took about 18 seconds.
- Before the promise-cap policy update, a fresh production dump was copied
  off-host and restored into an isolated scratch database:
  `aerodb-pre-remote-promise-headroom-20260723T125240Z.dump`, 525,581,420
  bytes, SHA-256
  `eb90183bd3347a5b7f7a5039d3a72b98d51a7a2817d65b6d803cfde47b4dd555`.
  Primary and restored inventories matched at 91 public tables, 44 public
  functions, and 0 public sequences before the scratch database was dropped.
