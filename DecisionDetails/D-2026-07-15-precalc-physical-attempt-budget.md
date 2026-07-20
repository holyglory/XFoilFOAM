# D-2026-07-15-precalc-physical-attempt-budget

## Production evidence

Campaign `c24047fa-743f-4ae5-bcd6-f3071ff79fb4` retained 28 blocked
preliminary-URANS obligations after PostgreSQL and the solver recovered from
root-disk exhaustion. All belong to the A20-32C physical setup. Twenty-one had
no completed point evidence: their workers disappeared and the zombie-task
recovery recorded the exact infrastructure diagnosis that the engine still
reported `running` while no OpenFOAM process existed. Seven had a prior
deterministic mesh/setup submission followed by a real non-stationary PRECALC
window that requested further same-case integration. The former two-submission
counter counted both setup/infrastructure tasks and physical solver windows,
so both groups appeared exhausted despite still having CFD budget.

## Decision and alternatives

The bounded PRECALC policy remains an initial physical solve plus one
corrective solve. `sim_precalc_obligation_attempts.attempt_number` is now the
monotonic immutable engine-submission sequence. A separate nullable
`solver_attempt_number` and `consumes_solver_attempt` record whether that
submission used physical CFD ordinal 1 or 2. Typed infrastructure loss and
deterministic mesh/setup failure retain their audit row but release the ordinal.
Real accepted, rejected, failed, or continuable CFD evidence retains and
consumes it.

Rejected alternatives were:

- Increase `max_attempts`: infrastructure could still consume the new bound,
  and the change would permit more than two physical solves.
- Delete/reset old attempts: this would erase immutable operational and solver
  evidence and make incident reconstruction impossible.
- Manually retry the affected points: this would regress machine-owned recovery
  into unexplained user work and recur after the next worker interruption.

## Exact engine-remediation exception

The 20-32C/Re≈102k/α12° remote broker canary later exposed evidence not
covered by the original alternatives. Two physical PRECALC runs reached stable
coefficients and retained complete transient evidence, but both were rejected
after the controller used a sparse field-directory timestamp instead of the
newer force-history timestamp and repeatedly selected an already-observed
period horizon. This was one reproduced controller defect, not two independent
physical failures or infrastructure submissions.

A blanket higher default remains rejected. Migration 0084 instead permits one
exact obligation to receive one audited remediation grant after the defect is
fixed. The grant raises only that row's physical ceiling from two to three and
stores the reason, exact fixing source revision, and timestamp. Both earlier
attempt rows, their physical ordinals, classifications, coefficients, and raw
evidence remain unchanged. The database rejects an unexplained third attempt,
a second remediation grant, an empty reason, or an unpinned source revision.
This qualifies the earlier rejection of `max_attempts` with materially new
production evidence while preserving its intent for every ordinary cell.

## Migration and runtime safety

Migration 0064 backfills existing submission ordinals, classifies structured
deterministic failures and the exact historic zombie-task signature as
non-consuming, recomputes physical attempt counts, and reopens only exhausted
obligations with a live owner, no active exact job, and no accepted exact
PRECALC evidence. Submission sequence uniqueness remains independent from the
partial unique physical-ordinal constraint. Runtime settlement performs the
same release transactionally and applies a 30-second infrastructure backoff.

## Verification

The prevention test first failed under the prior model after two infrastructure
losses exhausted both submissions. It now proves that both immutable rows are
retained as non-consuming and submission sequence 3 can use physical solver
attempt 1. The false-positive guard proves that a real continuable rejected
URANS window still consumes attempt 1 even when the job later receives a
transient cancellation. Full deterministic-mesh recovery, durable whole-polar
promotion, URANS ladder, migration, campaign remediation/query-plan, and DB
type-check suites are required before production deployment.

Migration 0084 adds a must-catch proof that an unaudited third run fails, one
audited grant succeeds without resetting the spent count, and a fourth run is
still rejected. Its false-positive guard proves every ungranted obligation
retains the original two-run ceiling and empty remediation metadata.

## Production rollout

Commit `8351844` deployed through GitHub Actions run `29411217404`. Migration
0064 preserved the old attempt rows and reopened exactly 28 live obligations:
21 now have zero physical attempts spent and seven retain one real solver
attempt. The campaign progress cache refreshed from 28 blocked to zero while
the campaign remained active. Eight existing engine tasks continued across the
control-plane-only deployment, and subsequent engine status showed completed
case counters advancing. The scheduler heartbeat remained current and the disk
admission measurement remained live; no engine API or worker restart was part
of this rollout.
