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

## Governed checks

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
