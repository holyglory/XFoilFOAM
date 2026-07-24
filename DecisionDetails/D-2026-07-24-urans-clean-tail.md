# D-2026-07-24-urans-clean-tail

## Production evidence

Remote OpenCFD 2606 job `b43323ceef034f498731fe10c5871e64`
retained four coefficient segments for its AoA 0 preliminary case. The merged
trajectory contained 17,957 real samples from `t=7.999e-7 s` through
`t=0.12946055 s`. Its configured 40% discard began at `t=0.05179 s`, inside a
late numerical burst, so the period estimator returned no corroborated
physical shedding period and the transported history still included the
broken prefix. Later segments were materially calmer, proving that elapsed
fraction alone was not a truthful settling boundary.

The late signal in this exact case oscillated near 970 Hz, outside the
flow-owned 30–300 Hz shedding band. It therefore remains rejected and requires
one corrected physical continuation/rerun; visually repeated numerical
timesteps are not promoted into aerodynamic evidence.

## Options considered

1. Increase the fixed discard fraction. Rejected: the settling boundary varies
   by geometry, AoA, restart state, and timestep history. A larger constant can
   still retain a late burst or discard scarce valid periods.
2. Run all URANS permanently at `Co <= 1`. Rejected: safe but unnecessarily
   consumes roughly the throughput gained from the configured production
   Courant ceiling after the wake has settled.
3. Crop any visually periodic final suffix. Rejected: the reproduced tail had
   a strong but physically out-of-band numerical cadence. Appearance alone
   cannot certify CFD evidence.
4. Start every physical chunk at `Co <= 1`, release the configured ceiling only
   after two live repeatable, discontinuity-free periods with at least 20
   stored field frames per period, and search physically banded trailing
   suffixes only when the ordinary retained history cannot corroborate a
   period. A tentative cadence may change only the field-write interval; it
   cannot relax `maxCo` or `maxDeltaT`. Selected: it prevents large adaptive
   timesteps during the vulnerable restart/startup interval, restores normal
   throughput on fully evidenced settled cases, and salvages only evidence
   that passes the unchanged physical and stationarity gates.

## Evidence and retention contract

Raw coefficient files, logs, fields, restart segments, and archives are never
rewritten or deleted by clean-tail selection. The selector chooses a byte-backed
suffix, requires independent-half agreement in the existing flow-specific
shedding band, rejects isolated timestep discontinuities, and returns only the
exact final whole-period horizon. A wider candidate that still contains older
startup corruption is never republished merely because its final cycles are
clean.

The live controller uses the final two periods to detect repeatability and
rejects any candidate containing a one-step coefficient impulse. It may release
the conservative startup timestep only when those same periods have at least
20 real stored field frames each. A preliminary result still needs the existing
4.5-period certificate, including three whole cycles for established-
oscillation stationarity, and the published force history/media use exactly the
final three whole periods. Flat/no-shedding evidence preserves its complete
physical observation horizon; a tiny spectral ripple may not shorten it.

## Prevention and verification

The must-catch regression places a catastrophic startup burst after the legacy
40% boundary, followed by a clean in-band limit cycle. The old implementation
returns no period and transports the burst. The corrected path detects the
clean two-period live window and publishes exactly three clean periods.

The first v3 corrective run supplied a second must-catch observation before it
could publish: AoA 9 released to `maxCo=4` with only three field frames per
candidate period while the latest coefficient suffix still contained an
impulsive discontinuity. Both engines were closed to new admission and every
in-flight v3 task was cancelled through the normal evidence-preserving API.
The new regression proves that this force-only verdict keeps both `maxCo` and
`maxDeltaT` conservative, while a genuinely complete two-period window still
releases throughput.

Adjacent regressions preserve period-band/subharmonic behavior, ambiguous and
non-stationary rejection, no-shedding observation length, dense-field gates,
restart-seam ownership, finalization/live-window identity, and conservative
startup Courant release. The recovery capability is version 4 and solver
incident grouping uses `urans-recovery-2026-07-24-v4` so exact pre-fix
exhaustions remain auditable and may receive only the existing one
source-pinned remediation allowance.
