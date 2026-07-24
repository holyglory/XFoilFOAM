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
   cannot relax `maxCo` or `maxDeltaT`. If the discontinuity gate later fires,
   tighten the linear solves and PIMPLE loop in place, restore the conservative
   ceiling, and restart certification after the contaminated prefix. Selected:
   it prevents large adaptive timesteps during the vulnerable restart/startup
   interval, restores normal throughput on ordinary settled cases, and pays
   for the stronger numerics only when real evidence requires them.

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

The first v4 burn-in then exposed the remaining source of those impulses.
After the live monitor densified field writes, OpenFOAM's
`adjustableRunTime` write control shortened one physical timestep to land
exactly on each output boundary. In the live AoA 9 trace, a step contracted
from about 1.15 microseconds to 0.23 microseconds while Cl jumped from about
`-0.056` to `+0.292`; Cd and Cm jumped on the same step. The pattern repeated
at later write boundaries even though `maxCo` remained 1. The v4
discontinuity guard correctly prevented publication, but waiting or trimming
could not create a permanently clean suffix while output alignment kept
injecting new impulses. Both v4 pools were fenced and the affected generation
was cancelled before publication.

Version 5 keeps adaptive Courant control but changes transient field output to
`runTime`. OpenFOAM now writes the first completed physical state after a
requested boundary instead of changing the timestep to hit the boundary
exactly. Field times remain real solver states and the existing
20-frames-per-period gate still measures their actual density. A structural
must-catch regression covers both OpenCFD 2606 and Foundation 14 dictionaries
and forbids `adjustableRunTime` on transient field output.

The first v5 corrective burn-in passed the decisive dense-output test: twelve
successive AoA 9 field writes kept the physical timestep near 1.13 microseconds
and coefficient changes at roughly `1e-7` to `1e-6`, rather than the v4
simultaneous Cl/Cd/Cm spikes. It also exposed a separate AoA 13 numerical
pressure mode that began before cadence densification. Reducing `maxCo` from 1
to 0.25 changed that mode's frequency but did not remove it. Tightening `p` to
`1e-8/0.01`, final pressure to `1e-8/0`, transport to `1e-9/0.01`, and the
PIMPLE loop from 3×2 to 4×3 removed the recurrence; after the two samples at
the live dictionary-reload boundary, the normal Courant-1 trace remained
clean. The manually altered diagnostic generation was cancelled before
publication and its exact obligations returned to pending without consuming a
physical attempt.

Version 6 makes that measured cure automatic. The first impulsive candidate
arms the stronger live numerics once, restores the startup Courant/timestep
ceiling, clears the certification clock, and permanently forbids a Courant
release for that physical chunk. Its marker and final dictionaries are
immutable quality evidence and survive same-case/cross-job continuation.
Publication still requires a fresh clean trailing certificate; raw condemned
samples remain preserved as attempt evidence.

The first v6 corrective burn-in exposed a continuation-boundary gap in that
contract. A regenerated continuation dictionary could restore a larger
`maxDeltaT`, and the new monitor closure could later replace it with the
cadence-sized field-write interval even though the recovery marker and
`maxCo=1` remained. Version 7 reads the marker before every monitor closure and
same-case continuation, atomically reapplies both the stronger `fvSolution`
blocks and the original conservative `maxCo`/`maxDeltaT`, and prevents cadence
refinement from changing `maxDeltaT` while the marker is armed. The
must-catch regression first reproduced the old continuation increase, then
proves both the initial and restarted monitor retain the exact conservative
ceiling.

During that burn-in, an emergency operator command attempted to change a live
`controlDict` with `foamDictionary`. OpenFOAM observed the transient empty
value and stopped four cases with `attempt to read beyond EOF`. Their original
failed blobs, manifests, and canonical archives remain immutable; the unpacked
duplicates were restored byte-for-byte from archives that authenticated every
manifest member. The production runbook now forbids direct edits of a live
OpenFOAM dictionary: versioned atomic generator changes plus normal
evidence-preserving retries are the only supported correction path.

Adjacent regressions preserve period-band/subharmonic behavior, ambiguous and
non-stationary rejection, no-shedding observation length, dense-field gates,
restart-seam ownership, finalization/live-window identity, and conservative
startup Courant release. The recovery capability is version 7 and solver
incident grouping uses `urans-recovery-2026-07-24-v7` so exact pre-fix
exhaustions remain auditable and may receive only the existing one
source-pinned remediation allowance.
