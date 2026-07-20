# D-2026-07-20-urans-continuation-wall-budget

## Evidence

The exact `hz-solver2` AoA 18 preliminary-URANS remediation ran one saved
transient through 25 coefficient segments: the first segment plus all 24
allowed continuations. At simulated time `0.2045956949887159 s`, the final
4.5-cycle certification tail was locally stable and the complete physical tail
finally classified as no-shedding. The engine accepted the point, the remote
node delivered it to the production hub, the hub bound GCS generation
`1784567638818547`, and the obligation became satisfied. This was not a failed
run, but it consumed the entire old emergency allowance and would have rejected
an otherwise identical trajectory that needed one more healthy chunk.

The loop already owns stronger runtime bounds: one monotonic fidelity deadline,
a measured simulated-time/wall-time projection that stops work before 80% of
the tier budget would be exceeded, and a one-chunk stop when neither saved time
nor force history advances. The 24-chunk ceiling was therefore not the
authoritative resource limit; it was a last-resort protection that had become
shorter than demonstrated physical settling time.

## Options considered

1. Keep 24 chunks. Rejected: the live accepted result used every slot, leaving
   zero safety margin and allowing healthy CFD to become a terminal controller
   failure while most of its time budget remains.
2. Remove the chunk ceiling. Rejected: real runs are budget-bounded, but a
   broken or synthetic runner with negligible recorded wall cost could still
   loop indefinitely despite advancing fabricated progress.
3. Relax or discard the stationarity/context gate. Rejected: that would accept
   startup-biased coefficients and weaken physical evidence instead of giving
   the same case enough time to satisfy the existing gate.
4. Raise the emergency ceiling to 96 while keeping the wall budget, measured
   rate, no-progress stop, and stationarity gates unchanged. Selected: 96
   three-period extensions give slowly relaxing wakes meaningful headroom,
   while the real time budget normally stops an uneconomic case first and a
   finite final bound remains.

## Prevention and verification

A must-catch controller regression models a preliminary trajectory that stays
monotonically relaxing through the legacy 24-continuation boundary and becomes
acceptable on call 27. It fails under the old ceiling after 25 total physical
attempt calls and passes with the raised guard. Adjacent tests retain the
finite-cap behavior for permanently drifting preliminary and full-fidelity
signals, plus the immediate stop for a successful process that produces no
physical progress.
