# D-2026-08-02-systemic-admission-fence

## Decision

Keep each isolated current-generation solver failure as a visible critical,
quarantined recovery record, without pausing global admission. Close the
admission latch only for direct infrastructure/evidence-integrity hazards or
for the configured number of open critical incidents that share the exact
stage, reason, solver implementation, and remediation version.

Accepted current archive-backed preliminary URANS selection settles the exact
PRECALC obligation, resolves its owner incidents, and refreshes campaign
progress. That reconciliation runs in both the normal reduction and the
already-selected replay path. The admission query has a narrow temporary
accepted-selection proof so a post-selection/pre-settlement read cannot
re-fence a healthy fleet; it requires the same latest job and therefore cannot
hide a later failure generation.

## Why

The previous fence treated any blocked owner or one current critical incident
as systemic. In production that made ordinary per-angle URANS recovery stop
both solvers and left stale owner rows to re-trip after resume. Conversely,
disabling the breaker entirely would let engine outages or evidence-integrity
loss multiply before the controller reacted.

The selected rule separates three states: normal point recovery, repeated
implementation-specific regression, and direct shared-system hazard. It also
prevents remediation generations from aggregating past incident history by
using a new URANS recovery remediation version.

## Verification

- Admission regressions prove blocked final/URANS owner rows and one critical
  incident preserve admission, three identical critical incidents fence it,
  and direct engine-infrastructure failure fences at both local and remote
  submit boundaries.
- Archive publication integration proves normal and already-selected replay
  selection settles the exact obligation and resolves its incident without a
  duplicate reducer call.
- Solver incident regressions prove v9, v10, and v11 remediation identities
  remain separate aggregation groups.
