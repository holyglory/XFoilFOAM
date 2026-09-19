# Source-fitted air for progressive compressible polars

The compressible adapter supports an explicitly supplied perfect-gas model with
temperature-dependent NASA7 heat capacity and independently fitted viscosity
and thermal conductivity. This is a thermally perfect, non-reacting gas
approximation, not the full CoolProp real-gas equation of state. A supported
request format or a successful solver exit does not establish a valid polar.

## Material source and measured approximation

The audit uses pinned CoolProp 8.0.0 `HEOS::Air`, identity `AIR.PPF`, matching
the catalog air source. It retains the library revision, fluid JSON, original
sample values, their checksums, the fit, and a separate dense verification
grid. Calorics use the source's ideal-gas properties; transport is sampled at
101325 Pa. No audit automatically installs a catalog material or changes a
campaign target.

The initial 150–2000 K audit used 3704 verification temperatures. Its maximum
sampled relative errors were:

| Approximation | Heat capacity | Viscosity | Conductivity |
| --- | --- | --- | --- |
| NASA7 plus Sutherland/Eucken | 0.1791% | 4.9653% | 6.1164% |
| Same NASA7 plus independent polynomial transport | 0.1791% | 0.04457% | 0.01568% |

These are source-grid discrepancies, not rigorous continuous bounds, a
validated pressure envelope, or aerodynamic error estimates. The temperature
domain is explicit; the adapter does not extrapolate these coefficients.
The source audit also rejects sampled transport states outside the gas or
supercritical-gas phase.

## Native OpenCFD integration

The pinned OpenCFD 2606 runtime does not register the required
`hePsiThermo/pureMixture/polynomial/janaf/perfectGas/sensibleInternalEnergy`
combination. `src/airfoilfoam/native/thermophysics` registers the existing
OpenCFD templates; it does not replace the gas equation of state or implement
a different solver. Matching source and build-tool packages are checksum
pinned for both image architectures. Compilation happens in the worker
image's build stage, not in response to a solver request. The production stage
receives the compiled library; the separate check stage adds the native probe.

The adapter converts molecular weight using the pinned engine's actual
universal gas constant. Substituting modern SI constants here changes the
specific gas constant used by the engine. NASA7 records also retain the
pressure at which their entropy coefficients are referenced; serialization
converts that reference to OpenCFD's 100000 Pa standard without changing heat
capacity or enthalpy.

The native probe checks registration and evaluates viscosity, conductivity,
heat capacity, enthalpy, entropy, and density against the supplied material.
Real-flow smokes additionally exercise library loading through all three
compressible solver families. Their short initialization histories are kept
outside campaign results and are never accepted polars.

## Material-domain acceptance

The first full-worker Mach-3 smoke exited successfully but produced 172 JANAF
temperature clamps, with attempted temperatures down to about 104.43 K. That
run does not validate the initial 150 K lower bound. Its raw evidence remains
retained; subsequent canaries reject this warning even after a zero exit.

The next audit sampled the same real gas source down to 100 K, checking gas
phase throughout both source grids. Its maximum sampled errors are 0.2019%
for heat capacity, 0.07217% for polynomial viscosity and 0.04594% for polynomial
conductivity. The prior source fixture is retained separately. This is a new
source-backed candidate, not a relabeling of old coefficients with a wider
range. The repeated four-family initialization smokes produced no JANAF clamps,
including Mach 3; native property checks at 16 temperatures agreed with the
adapter to within 4.10e-16 relative error. These are implementation and short-run
checks, not physical polar convergence. If an updated run exceeds the sourced
domain, investigate the material coverage and numerical behavior rather than
repeatedly extending bounds or treating a clamped run as converged.

Normal solver-result checks now reject JANAF clamps as a distinct material-domain
failure, retaining the exact raw log and diagnostic. A timeout cannot make a
clamped history eligible, and this failure cannot justify a whole-polar URANS
promotion or an automatic conservative numerical retry.

The diagnostic parser also reports the minimum and maximum temperatures actually
printed in clamp warnings and the declared ranges in those warnings. These are
attempted property-evaluation temperatures, not extrema of an accepted solution.
Malformed, truncated and nonfinite details remain unparsed, with null extrema
when no valid numeric warning details can be recovered. They still reject the run. The summary
retains at most 16 distinct ranges and marks truncation; warning counts, extrema
and the original checksum-bound log are not truncated. This diagnostic extension
is locally tested and awaits the next authorized engine rollout.

Failure-log preservation must cover early rejected angles with no completed
evidence archive. Cleanup retains every `log.material-domain-<sha256>` file in
the case and nested transient directories, not only the latest diagnostic JSON.
Keeping such a file is preservation, not checksum authentication or acceptance
as CFD evidence. A September 18 regression reproduced removal of these logs by
the former generic `log.*` cleanup rule; the correction is local pending rollout.
Two inspected historical Mach-3 failures have locally missing referenced logs;
their summaries cannot reconstruct the lost bytes or establish the temperatures
that triggered the rejection.

A read-only production check on September 18 confirmed that campaign revision 5
and its latest sealed Mach-3 requests select the source-backed 100–2000 K model,
at 288.15 K and 1021.025 m/s with `rhoCentralFoam`. This rules out the obsolete
150 K setting for those requests; it is not proof of converged Mach-3 flow, and
does not authorize widening the model's bounds after a numerical excursion.

Explicit material models now persist on reusable media and in immutable setup
snapshots. The controller and engine derive operating properties from the same
selected model; editing a reusable medium does not alter historical revisions.
Strict import validation checks the full declared polynomial intervals and
caloric joins. Sync preserves the model and treats changed or omitted models as
conflicts rather than overwriting local material identity.

Reusable-material editing now supports explicit copy, update, clear and protected
removal through both API families and the preview editor. Changes refresh current
derived flow properties and future setup revisions without rewriting old evidence.
Physical compatibility uses active model values rather than source descriptions
or inactive legacy reference observations; provenance remains in the full snapshot.
Catalog installation in production, pressure applicability, and physical mesh/time
convergence remain separate required work. Neither these smokes nor the source fit
establish Mach-3 production readiness.

The real controller check exercises actual NeuralFoil prediction, ordered fast
OpenFOAM dispatch, evidence ingestion and the public curve read model. An earlier
version incorrectly counted retained model-evidence associations as contributors.
The 166 m/s run `t20260908T145105Z-bec0d1` delivered its baseline after about two
seconds, but its two CFD attempts were excluded for material-domain failure.
The 1020 m/s run `t20260908T152312Z-8eb5cf` similarly excluded both attempts for
insufficient informative evidence. Neither run proves CFD refinement, despite
the old verifier's passing status. The strengthened check requires two distinct
angles in the actual contributor set and changed coefficients; excluded attempts
remain visible as exclusions. These real-flow failures require diagnosis rather
than weakening material or startup-history gates.

## Pressure-dependence audit

The pinned-source comparison also evaluates density, full-EOS heat capacity,
sound speed, viscosity and conductivity at explicit temperature/pressure pairs.
It includes gas and supercritical source states; excluded phases and source or
candidate errors remain separate from successful comparisons, never zero error.
Full source values and the candidate model are retained as a hash-bound governed
artifact rather than only a temporary report path.

For the reference state 288.15 K / 101325 Pa, the audit samples idealized
isentropic paths for campaign speeds 30, 90 and 166 m/s, and Mach 3. These paths
extend down to the model's 100 K lower limit; they are deliberately broad
comparisons, not predictions that each campaign reaches those temperatures.
Enthalpy determines stagnation temperature using the variable heat capacity.
They are not shock solutions or bounds on the actual viscous flow field.

| Sampled path | Density | Heat capacity | Sound speed | Viscosity | Conductivity |
| --- | --- | --- | --- | --- | --- |
| Campaign reference paths, largest relative discrepancy | 0.0671% | 0.2416% | 0.0443% | 0.2289% | 1.1191% |
| Mach-3 reference path, largest relative discrepancy | 1.3654% | 0.5639% | 1.5395% | 0.6560% | 1.1191% |

The Mach-3 reference stagnation state is about 788.61 K / 3.8081 MPa. An
independent exploratory grid (100–2000 K, six pressures from 1000 Pa to 4 MPa)
shows much larger discrepancies near dense-fluid conditions. Consequently,
neither the temperature interval alone nor these path measurements define a
validated operating envelope. Material applicability and aerodynamic convergence
must be checked separately before high-Mach production acceptance.

## Source-air shock verification

The September 18 isolated Mach-3, 15-degree wedge study uses the same
100–2000 K NASA7/polynomial material fixture as the campaign material audit.
Its upstream temperature is the original wedge benchmark's 520 degrees Rankine
(288.8889 K), not the campaign's 288.15 K. The variable-heat-capacity reference
solves mass, momentum and total enthalpy balances; it is not NASA-tabulated
experimental data or a frozen-upstream-gamma approximation. Constant-heat-capacity
limits are checked against the independent closed-form shock relations.

All four native calculations start from uniform upstream fields, use the
registered thermophysical library, and retain their material-domain, conservation,
entropy, stationarity and measured Courant checks. No downstream reference
solution is inserted into the initial fields.

| Resolution parameter | Time integration | Maximum downstream relative discrepancy | Maximum measured Courant number |
| --- | --- | --- | --- |
| 64 | Local pseudo-time, 3000 iterations | 1.2211% | 0.500000 |
| 128 | Local pseudo-time, 3000 iterations | 0.5947% | 0.500000 |
| 128 | Physical time, target Courant 0.49 | 0.5947% | 0.491019 |
| 128 | Physical time, target Courant 0.245 | 0.5947% | 0.245237 |

Discrepancies cover pressure, density, temperature and downstream Mach at three
downstream probes. Halving the physical timestep target changes those saved
stationary measurements by at most 2.49e-12 relative. The two physical runs
finish at 0.00297935349 and 0.00298049823 seconds respectively, with 3472 and
6922 Courant samples. They use the same physical horizon and input dictionaries
except for the Courant target; their final adaptive steps need not coincide.

These results verify shock coupling for this particular source-air wedge case.
Two meshes do not establish a formal grid-convergence order. A stationary wedge
does not validate airfoil geometry, viscous drag, separation, URANS histories,
or the uncertainty on a Mach-3 polar. Every report explicitly retains
`airfoil_polar_validation: false`; no benchmark values enter campaign evidence.

The sealed local deployments are `source-air-shock` generation 1
(`d40417a8caa9d681d`) and `source-air-shock-half-step` generation 1
(`d2aac3a5104cda832`). Their numerical containers have networking disabled and
no production credentials. Reports and input dictionaries are retained under
`.codex-artifacts/source-air-shock-20260918/`; raw cases remain in the separate
deployment-owned evidence volumes. The half-step report SHA256 is
`49981de4549ff627cbae6b61b1e90d11e9261522636c270c0ac212dd56d741d6`.
The focused reference/control regression run is
`t20260918T165614Z-bfbb00`; it is not complete release validation.

## High-angle Mach-3 failure diagnosis

The September 18 FX60-100 diagnosis reproduces a real campaign failure using
the repository's original `fx60100.dat`: all 97 coordinate pairs match the
production request's SHA256
`62678a8b062a9cdd2d0d18fe4791944044cc74f43986759ba7ec646172654b8e`.
The source case is job `c8827f4c-65d8-4490-bdc8-e84c98529a57`, with a
0.1 m chord, 1021.025 m/s, 288.15 K, 101325 Pa, smooth wall and fully turbulent
SST. The diagnostic preserves its mesh dimensions, upwind scheme, 5000-iteration
limit and 900-second active solver budget. It runs serially from an empty local
cache without rendering media or publishing campaign data.

The first isolated run starts directly at 13 degrees rather than marching from
-4 degrees. It fails at iteration 3 with 40 material warnings and attempted
temperatures of 69.81–90.40 K. Thus the preceding angle is not necessary to
produce the failure. The raw diagnostic log is retained with SHA256
`e345ecc6e1b39f6adba4dda1f14c91244819d67d6fd86ccc0695c760d90eba7e`.

Two further isolated runs change only the existing Courant setting in their
immutable requests, before case generation. Both complete 5000 iterations
without material warnings, but neither earns the required convergence proof.

| Effective local Courant target | Active solver time | Cl | Cd | Cm | Classification |
| --- | --- | --- | --- | --- | --- |
| 0.5 | 1.09 s | unavailable | unavailable | unavailable | Material-domain failure |
| 0.25 | 246.41 s | 0.25910 | 0.12980 | -0.09081 | Unconverged calculation |
| 0.1 | 241.52 s | 0.27689 | 0.13293 | -0.09737 | Unconverged calculation |

The coefficient difference is material: avoiding temperature clamps is not
convergence, physical validation, or a calibrated error bound. The two point
and attempt collections retain the same underlying outcome; they are not
independent repeated measurements. These calculations do not establish which
Courant value should be adopted across the campaign. They justify investigating
startup stepping before extending material bounds, which remain unchanged.

The sealed deployments are `mach3-failure-diagnosis` generation 1
(`d060e0517ea1bc6a4`) and `mach3-smaller-steps` generation 1
(`d20b97ea87530d712`). Reports and source requests are retained under
`.codex-artifacts/mach3-failure-20260918/`; raw cases remain in their respective
deployment-owned volumes. Diagnostic completion means an actual case outcome
and intact material logs were collected, not that the solver converged.
The protocol regression run is `t20260918T172646Z-54bdca`.

## Governed checks

The isolated startup-field study retains every saved early field of the same
FX60-100, Mach-3, 13-degree case. Its diagnostic request uses the existing
50-iteration minimum, rather than bypassing request validation. The global
iteration clock stays at `deltaT 1`; only the actual local Courant limit differs.
Every other generated physical input and mesh file has the same checksum.

At local Courant 0.5, two completed updates leave minimum temperatures of
161.138 K and 102.637 K in upper aft-surface cells near 0.79–0.80 chord, before
the third update triggers the material-domain guard. At 0.25, all 50 updates
finish without material warnings: the minimum over saved frames is 133.635 K,
and the last frame's minimum is 198.201 K. Neither run is converged. These
measurements locate the startup problem and support testing smaller local
updates; they do not establish a generally valid production setting.

`inspect_mach3_startup` preserves the original request alongside the shortened
diagnostic, hashes the generated inputs and every saved field member, and reports
missing or corrupt frames rather than substituting another time. Cell locations
are explicitly averages of their vertices, not volume centroids. The private
`mach3-startup-fields` deployment uses network-isolated solvers and a read-only
artifact server; it never creates campaign results or an accuracy certificate.

The two full-horizon continuations use the same hash-verified state at iteration
50. They include the startup's 6.710 seconds in the original 900-second allocation
and perform exactly 4950 further updates to iteration 5000. Keeping Courant 0.25
takes 334.990 seconds in total; restoring 0.5 takes 328.487 seconds. Neither
trajectory reports material warnings, but neither meets field convergence or
the complete Cl/Cd/Cm hold test. The final normalized field-change measures are
11558.778 and 1600.227 respectively, not aerodynamic error estimates. Their final
50-sample means are (Cl, Cd, Cm) = (0.259101, 0.129801, -0.090807) and
(0.265287, 0.129026, -0.088385). Thus surviving startup is distinct from solving
the physical steady-flow problem.

The candidate bounded-start implementation caps only the first 50 cold
local-steady updates at Courant 0.25, then restores the requested effective limit.
It does not change the global iteration clock, total iteration ceiling, gas
bounds, convergence criteria, seeded starts, or physical-time integration.
Both native logs and each stage's complete control dictionary are retained.
`local-steady-startup` replays the actual isolated job pipeline for both the
13-degree cold case and the original two-angle request. Its completion is a
numerical-repair check, not campaign-wide accuracy or uncertainty validation.

- `progressive / air-pressure-audit`: analytic energy/entropy and failure-state
  regressions, then the exact-source pressure comparison with retained artifact
  `source-pressure`. The 2026-09-07 retained report has SHA256
  `169ffa92759a5aa41a79b56482ab81eac2974a254f5b33b8cc9e2ed005f72023`.
- `progressive / material-lifecycle`: both material-editing API families preserve,
  copy and explicitly clear models; incompatible changes leave stored data intact.
- `progressive-live`: actual prediction and CFD evidence update the same public
  curve read model, with two distinct contributing angles and retained stop proofs.
  The release tier additionally exercises 1020 m/s using the density-based solver;
  its actual material-derived Mach is retained with the target, not assumed to be
  exactly three from the rounded speed.
- `progressive / air-material-audit`: focused contract and dictionary tests,
  detector regressions, then the pinned source comparison (currently 100 K
  lower bound).
- `thermophysics-check` local deployment: native property probe followed by
  source-fitted real-flow smokes at Mach 0.72, 0.9, 2, and 3. Report and case
  directories are isolated from production and retain unique run identities.
