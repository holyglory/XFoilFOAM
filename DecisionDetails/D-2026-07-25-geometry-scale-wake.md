# D-2026-07-25-geometry-scale-wake

## Production evidence

AH81K144WFKLAPPE preliminary-URANS obligation
`84412eba-f92a-4464-812a-9bf8d0a0d94f` continued its exact rejected checkpoint
in engine job `6b383e456c9f4aacbba3bd88705bb97a`. It reused the saved mesh
(`mesh_build_count=0`) and advanced from `t=0.08199649906810502 s` to
`t=0.1336025374212836 s` under OpenCFD 2606 recovery v8, `Co<=1`, the persisted
pressure/transport tolerances, and the 4×3 PIMPLE loop. The continuation
remained free of one-step impulses.

The final physical segment contains 25,090 real force samples. Its dominant
frequency is 1,075.69 Hz in the full segment, 1,075.70 Hz in the first half,
and 1,075.68 Hz in the second half. The former chord-only window is 30–300 Hz
and therefore returned no period. The immutable source geometry has maximum
thickness `t/c≈0.22`; using that projected wake height gives
`St_t = f·t/U = 0.394`, inside the existing physical 0.05–0.5 wake band.

With geometry context, the unchanged preliminary finalizer selects a
stationary 4.5-period certificate from `t=0.12945697827437624 s` through
`t=0.1336025374212836 s`. The public force-history projection contains exactly
the last three periods, `t=0.13081137590314415 s` through
`t=0.1336025374212836 s`, with 1,358 real samples. All earlier startup and
continuation bytes remain immutable evidence but are absent from the published
window.

## Decision and boundaries

The high-frequency side of the shedding band uses the greater of the airfoil's
projected AoA height and measured maximum section thickness, but only when that
ratio exceeds the existing 0.15 projected-height floor. The slow side remains
chord-based. Geometry is derived from the normalized immutable contour inside
the engine and attached to the internal case specification; it is not a new
user-editable solver setting.

This change does not make arbitrary high-frequency repetition acceptable.
Both half-windows must corroborate the period, a trailing physical suffix must
be free of impulses, preliminary certification must span 4.5 periods with
stationarity, every accepted period must have the required real field frames,
and publication retains exactly three whole periods. Missing geometry, invalid
geometry, and ordinary thin sections keep the previous chord-only band.

## Options considered

1. Continue or rerun under the same chord-only band. Rejected: the exact v8
   continuation already reproduced the cadence under conservative, tightened
   numerics; another identical run cannot change the classifier and wastes the
   retained physical trajectory.
2. Widen the Strouhal band globally. Rejected: it could promote genuine
   timestep/numerical modes on thin sections and would discard the geometry
   evidence that distinguishes this case.
3. Manually accept the point. Rejected: operator judgement must not bypass the
   immutable evidence and publication gates.
4. Use immutable projected section height for only the high-frequency bound.
   Selected: the resulting thickness-scale Strouhal is physical, the exact
   halves agree, thin/default behavior is unchanged, and every existing
   clean-tail safeguard remains active.

## Verification

The must-catch regression uses the production 30 m/s, 0.05 m chord, 0°,
`t/c=0.22`, 1,075.7 Hz class. It proves that chord-only measurement returns no
period, geometry-aware measurement corroborates both halves, and a late
corrupt prefix is excluded before the exact three-period window is returned.
The exact production coefficient files were also graded offline by the v9
code. The focused 201-test geometry/URANS/API suite and the complete 1,290-test
non-integration engine suite pass; 22 Docker/OpenFOAM integration tests remain
separately selected by their existing marker.

## Corrective rollout

Recovery v9 is deployed on both guarded OpenCFD 2606 engines. The first exact
remote generation accepted AoA 1 from retained bytes and bound its complete
archive to GCS without another CFD solve. A historical promotion then exposed
two scheduling defects outside the physical classifier: its original remote
promise was cancelled, its replacement promise owned only selected angles, and
some normalized obligations had no source-attempt FK. The recovery scheduler
now uses the current exact promise point as its sole authority, retains the old
promotion only as immutable provenance, and cannot widen the replacement into
the old whole-polar scope.

The production-scale candidate query initially embedded the complete
authenticated-archive predicate and spent minutes scanning millions of
artifact associations. The corrected query selects only small due ownership
candidates; the existing bounded per-point phase remains the sole authority
for restartability. AoA 7 and 9 subsequently resumed their exact retained
engine cases, with AoA 7 reporting `mesh_build_count=0` and continuation from
`t=0.12888 s`. Their raw prefixes remain immutable, and neither result is
publishable until v9 selects a later clean 4.5-period certificate and exact
three-period output window.
