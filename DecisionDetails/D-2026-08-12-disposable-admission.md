# Disposable CFD does not infer fleet-wide failure from one rejected point

## Decision

Production hub and remote scheduling use the `disposable_compute` admission
policy. Solver evidence remains fail-closed: a result without the required
convergence, clean-cycle certificate, field frames, or stored media is rejected
and cannot become a canonical polar point. Those per-job and per-angle outcomes
do not, however, infer a global admission hazard or stop unrelated work.

An already-latched stop is not cleared implicitly. The operator must explicitly
Resume once after changing policy, preserving a clear mutation boundary and the
saved capacity. The older `durable_evidence` breaker remains available for a
deployment that explicitly values bounded incident investigation over
continuous disposable compute.

## Why

The active campaign contains more than 631,000 points. Fifty FAST-URANS angles
across four aggregate jobs exhausted their quality/retry path, mostly without a
publishable clean-cycle certificate or video, while both solver hosts remained
healthy and other jobs continued. At this scale, an isolated non-publishable
angle is expected solver work, not evidence that every unrelated submission is
unsafe.

Bypassing evidence validation was rejected because it could publish false CFD.
Blindly clearing the latch under the old policy was rejected because the same
ledger would immediately re-trip it. Deleting all solver state alone was also
insufficient because fresh validly-rejected angles would recreate the stop.
Separating publication safety from fleet admission preserves truthful results
and the owner's explicit disposable-compute policy while keeping the existing
durable mode reversible.

## Verification

- Durable mode still detects and latches current-generation hazards.
- Disposable mode does not scan those per-point ledgers, but it continues to
  honor an already-latched operator stop until explicit Resume.
- Invalid URANS evidence remains rejected by the unchanged classifier.
- Production must resume at eight hub slots, continue issuing remote promises,
  and remain unfenced when another angle fails its evidence gate.
