# D-2026-07-17-remote-polar-parallel-admission

## Trigger and evidence

`hz-solver2` was configured with a 40-CPU worker budget, 40 Celery worker
processes, a 40-CPU Docker limit, and a remote CPU budget of 40. Nevertheless,
the live AG24 job showed exactly one `simpleFoam` process and one held CPU token.
Case logs advanced one AoA at a time. This was not an OpenFOAM capacity or
container defect: production polar requests intentionally set `warm_start`, so
angles within one chord-and-speed polar are marched serially. The advertised
case-concurrency value is only a ceiling across independent polar units, and a
remote promise currently contains one such unit.

The remote controller then imposed an unintended global serialization. Both
ordinary work and preliminary-URANS recovery required zero active remote jobs,
and only the oldest mirrored promise was considered. Consequently one
single-token polar could leave 39 worker tokens idle indefinitely.

## Contract

- Preserve the ordered warm-start AoA march and its low-angle hard-failure
  whole-polar promotion semantics. Parallelism is across independent complete
  polars, never by splitting dependent angles.
- Resolve the Node admission cap from the narrowest positive remote budget,
  explicit/automatic local job cap, and worker CPU budget. Count every active
  local or remote engine job against that shared cap; do not infer token demand
  from the case-concurrency metadata of a marched polar.
- The engine's durable shared CPU-token pool is the final oversubscription
  guard. A case-parallel preliminary job or multi-process solver may wait for
  tokens, but cannot exceed the worker budget.
- Admit at most one new engine job per five-second scheduler tick. Scan all
  mirrors oldest-first, skip busy/waiting mirrors, and give due bounded PRECALC
  recovery the first free slot. This fills 40 slots in roughly 195 seconds
  without a claim or mesh-start burst.
- Renew every due lease before new physical work. An exact 404/409 releases
  only that promise and its jobs; transient uncertainty blocks new admission
  for that tick but does not prevent sibling renewals, evidence delivery, or
  cancellation processing.
- Result delivery, terminal settlement, and promise completion may each make
  progress without returning before compute admission. Process at most one
  upload and one admission per tick.
- Bound active mirrored promises to two job-cap windows: one computing window
  and one settlement window. This prevents slow evidence uploads from idling
  CPUs without allowing unbounded hub-lease accumulation.
- Storage admission blocks new engine submissions and claims only. It does not
  stop active CFD, lease renewal, cancellation, evidence delivery, or truthful
  aggregate heartbeat reporting.

## Alternatives

Increasing `case_concurrency`, changing MPI ranks, or cold-solving all angles
in parallel was rejected because it changes the numerical march and bypasses
the whole-polar RANS-to-URANS decision contract. Running one giant multi-speed
engine request could parallelize conditions but would require a broader sync
protocol and couple unrelated promise lifecycles. A one-off manual second job
would not survive deployment or continuously refill capacity. Independent
promise admission uses existing engine isolation, durable leases, and token
accounting and is reversible by lowering the remote CPU budget.

## Verification

Automated coverage must prove that an active oldest mirror does not block a
later runnable mirror, only one admission occurs per tick, the global cap and
two-window promise cap stop claims, due PRECALC recovery wins a free slot,
delivery does not starve refill, storage blocking preserves reconciliation,
and sibling lease renewals continue after one transient failure. Production
rollout must recreate only the sweeper control plane, preserve the OpenFOAM API
and worker container identities, observe multiple independent engine jobs and
`simpleFoam`/`pimpleFoam` processes, and confirm the hub receives exact results
while aggregate promise/angle heartbeats remain truthful.
