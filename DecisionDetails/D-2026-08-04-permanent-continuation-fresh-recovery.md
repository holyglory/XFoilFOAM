# Permanent-continuation fresh recovery

## Evidence

Production had seven exact preliminary-URANS cells whose first physical run
ended with a valid saved continuation source. The continuation path later
proved that exact immutable source permanently unusable. Reconciliation kept
submitting the same source, so no new physics could be produced even though
each cell had consumed only one of its two permitted physical runs.

## Decision

Record `continuation_permanent_failure` as the terminal outcome of that exact
source generation. Never mutate, relabel, or resubmit it. When the live
cell-owned PRECALC obligation has `attempt_count < max_attempts`, atomically
return it to `pending`, clear every continuation source and continuation wall
override, and mark `fresh_recovery_pending`. The next admitted job is a new
physical PRECALC generation and consumes the remaining ordinary attempt.

When `attempt_count >= max_attempts`, retain the obligation as blocked and the
incident as critical. In both cases the incident remains scoped to the exact
physical cell and solver generation; unrelated local and remote work continues.
Migration repair applies only to a live obligation whose failed submission,
source job, source case, source attempt, and physical cell all agree. It never
reopens an already superseded owner or a different generation.

## Options considered

1. Retry the same continuation again. Rejected because the source has an exact
   typed permanent failure and another identical submission cannot change it.
2. Block immediately after the first physical run. Rejected because this
   discards the second run already allowed by the bounded PRECALC policy.
3. Reset the attempt counter or rewrite the old run. Rejected because it would
   erase provenance and could create an unbounded retry loop.
4. Spend only the pre-existing unused run on one fresh generation. Selected
   because it can produce new physical evidence without widening the budget.

## Verification

- A permanent source with one remaining run schedules exactly one new job with
  no continuation fields and no duplicate request.
- A permanent source at the limit stays blocked and schedules nothing.
- The failed source attempt and critical incident remain immutable and visible.
- An unrelated live PRECALC cell still admits while the exhausted cell remains
  blocked.
- The versioned database migration reopens only an exact live, non-exhausted,
  failed permanent-continuation owner and is idempotent.
