# D-2026-07-14-auto-job-admission — Auto admission follows the worker token budget

## Evidence

On 2026-07-14 the production worker exposed eight logical CPU tokens. The
campaign's first 78-case RANS job had historically received a synthetic
`queue_pressure=20`, which forced one serial polar branch. After that was
removed, a newly submitted job correctly saw a real queue depth of one but
engine auto-mode selected `airfoil_parallel`, one CPU per job. The sweeper's
unexposed legacy `max_concurrent_jobs=2` then admitted only two such jobs,
leaving six worker tokens idle.

## Alternatives considered

1. Set the production row to eight. This would address one VPS immediately,
   but the hidden default would return on a reset or a new deployment and
   would still conflict with the visible CPU-slot control.
2. Change MPI rank counts or the continuous warm-start march. That changes
   numerical execution and cache/warm-start behavior; it is not necessary to
   admit independent, already supported polar jobs.
3. Treat the legacy cap as automatic when it is zero and derive it from the
   same worker token budget (or an explicitly selected CPU-slot cap) that
   guards actual OpenFOAM work.

Option 3 is selected. A positive cap is retained as a documented API-only
override for installations that intentionally constrain breadth. The database
migration changes only the old default value of two, preserving any other
positive value. Docker passes the engine's logical worker-budget setting to the
sweeper, and the engine's durable token pool remains the final authority that
prevents oversubscription.

## Verification contract

- A fresh migrated database has `max_concurrent_jobs=0` and default `0`.
- Auto admission resolves to the worker budget; a positive CPU-slot cap and a
  positive explicit job cap take precedence in that order.
- The authenticated API accepts `0` as auto.
- Production control-plane deployment must not recreate `api` or `worker`.
- With open campaign work, the sweeper submits enough independent polar jobs
  to fill available worker tokens while no job reports a synthetic
  `queue_pressure` value.
