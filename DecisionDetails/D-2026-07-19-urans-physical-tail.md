# D-2026-07-19-urans-physical-tail

## Evidence

Production preliminary URANS for the live campaign's AoA 20 condition restored
14 coefficient segments spanning `0.0000008..0.15624685 s` from its exact
generation-pinned GCS evidence. The required trailing physical amplitude
horizon was `0.07 s`. That full tail was non-flat and still relaxing, but
period extraction returned only the last three apparent cycles
(`0.14529156..0.15624685 s`, `0.01095529 s`). The cropped slice fell below the
amplitude threshold and was then misread as an undersampled steady wake,
producing another physical-horizon exhaustion instead of a continuation.

## Options considered

1. Keep one compact period window for both amplitude and publication. Rejected:
   a locally quiet phase can erase the long-tail physical verdict, which is the
   reproduced production defect.
2. Accept any compact quiet slice as steady. Rejected: it bypasses the
   slow-shedding horizon and the mandatory stationarity gate.
3. Extend all preliminary URANS runs to a fixed duration. Rejected: it is safe
   but needlessly expensive for already stationary periodic and genuinely
   steady points.
4. Preserve an independent physical-tail history for amplitude classification
   and retain the compact integer-period history for periodic publication.
   Selected: it uses the same immutable real coefficients, keeps each window's
   responsibility explicit, and sends a non-flat relaxing trace through the
   existing bounded same-case stationarity continuation.

## Implementation and verification

`force_history` now has an internal `preserve_observation_window` mode. It still
measures an in-band period but does not crop samples or statistics when used by
the physical-tail classifier. The ordinary result/publication path remains
unchanged. A realistic multi-segment-shaped regression proves the old code
shrinks `0.07 s` to the final three quiet cycles and the corrected code retains
the complete horizon as non-flat. Adjacent no-shedding, period-tracker,
stationarity, and transient-attempt tests cover true steady wakes, real slow
shedding, locally quiet periodic slices, and the live caller wiring.
