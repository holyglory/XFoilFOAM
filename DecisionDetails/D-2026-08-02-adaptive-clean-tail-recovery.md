# D-2026-08-02-adaptive-clean-tail-recovery

## Production evidence

Two current OpenCFD 2606 preliminary-URANS trajectories at 17 degrees became
critical under recovery v11. Their immutable archives were complete: each
classified cycle had at least 206 coefficient samples and 28 field frames.
One trajectory ended with its first clean cycle after a settling prefix; the
other had three clean cycles followed by one soft shape outlier. Neither had an
engine interruption, missing field evidence, or infrastructure failure.

The controller nevertheless stopped them after 13 and 14 measured periods.
The v1 cross-runtime recovery contract advertised FAST 9 / FINAL 12 and hid a
cadence-estimation overrun by clamping its diagnostic counter. Ordinary
budget-based continuation also bypassed the pre-submit physical clamp, which
was applied only to archive-reducer continuations. A third equal incident would
have closed global admission even though the evidence described two isolated
high-AoA cells rather than a fleet outage.

## Decision

Keep the exact publication requirements unchanged: FAST selects only a final
contiguous three-cycle clean suffix and FINAL only a five-cycle suffix, with at
least 20 coefficient samples and 20 real field frames in every selected cycle.
Corrupt and settling prefixes remain immutable and unpublished.

Replace the short v1 recovery ceiling with the versioned
`adaptive-clean-tail-v2` emergency ceiling. The controller continues in
evidence-sized one-to-three-period chunks, up to FAST 18 and FINAL 27 measured
physical periods. Those bounds add three complete publication windows beyond
the legacy ceilings. Fidelity wall time, measured solve-rate projection,
one-chunk no-progress detection, and the finite 96-chunk guard remain
authoritative and unchanged. Every exact same-case continuation, including an
ordinary wall-budget continuation, is clamped before `pimpleFoam` starts.

The archive reducer reports measured periods truthfully. Historical unversioned
v1 proofs remain valid only at their exact 9/12 limits and gain no new
authority; only the explicit v2 policy may use 18/27. Recovery capability and
incident remediation identity advance to v12 so pre-fix incidents cannot
aggregate with corrected runs.

An exhausted clean-cycle quality trajectory remains a critical, visible result
for its exact physical cell, but it is cell-scoped for admission. Repetition of
that physical-quality outcome must not idle unrelated local or remote work.
Direct infrastructure or evidence-integrity loss still fences immediately, and
other repeated current-version systemic failures retain the existing threshold.

## Options considered

1. Keep 9/12 and suppress the alert. Rejected: it preserves the controller
   defect and still fails to produce the requested result.
2. Grant one special salvage run to only the two observed archives. Rejected:
   it needs new lineage persistence and leaves the same arbitrary boundary in
   live ordinary continuations.
3. Remove the period ceiling. Rejected: wall and no-progress controls are the
   normal safety bounds, but a finite emergency stop is still required for a
   broken or synthetic progress source.
4. Use versioned 18/27 emergency ceilings with adaptive small chunks and
   pre-submit enforcement for every continuation. Selected: it generalizes the
   observed recovery need without weakening evidence quality or permitting an
   unbounded loop.

## Verification

- Production-shaped tests place FAST's first clean terminal cycle after the
  legacy ceiling and three clean cycles before one soft outlier. Both continue
  below 18; neither publishes until the three-cycle suffix is exact.
- Permanently corrupt FAST/FINAL fixtures exhaust at 18/27 and stay
  non-publishing.
- Archive-client tests accept only exact v2 18/27 proofs, preserve legacy v1,
  reject unversioned widening, cross-fidelity caps, malformed chunks, and
  recommendations beyond the remaining physical allowance.
- Continuation tests use the farthest authenticated force sample and prove both
  ordinary and archive-owned work stop before the finite ceiling.
- Admission tests prove three cell-scoped quality exhaustions do not fence,
  while repeated non-quality hard failures and one direct evidence-integrity
  incident still do.
