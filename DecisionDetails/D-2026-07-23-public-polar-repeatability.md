# Bounded repeat noise does not erase a public polar

## Context

The production 20-32C `Re 102k · M 0.09 · condition 1` compatibility series
contained two immutable equal-ranked results at every requested angle. The v5
cache required bit-exact Cl/Cd/Cm values before selecting a primary result.
Only 14° and 15° had a higher-ranked winner, so the public solid curve rendered
only that one interval even though stored evidence covered −5° through 20°.

## Decision

Compatibility selection remains scoped to one exact method-compatibility hash,
AoA, classification rank, and fidelity rank. Within that scope, repeated
results agree when:

- `|ΔCl| ≤ max(0.02, 3% × max(|Cl|))`
- `|ΔCd| ≤ max(0.002, 5% × max(|Cd|))`
- when both Cm values exist, `|ΔCm| ≤ max(0.01, 5% × max(|Cm|))`

The existing deterministic newest-result ordering chooses the real primary
measurement. Agreeing repetitions remain immutable shadow/alternate evidence.
Any coefficient outside the bounds keeps every top-ranked result as conflict
evidence and excludes that AoA from the fit. Missing Cm does not erase an
otherwise usable Cl/Cd point.

The cache namespace advances from `polar-compat-v5` to
`polar-compat-v6`; the cache-absent public API fallback uses the same shared
comparison function so rollout and backfill cannot disagree.

## Alternatives considered

- Exact equality preserved maximum conservatism but treated ordinary iterative
  and averaging noise as a contradiction, destroying real coverage.
- Always selecting the newest equal-ranked result would keep a continuous
  curve but hide materially different aerodynamic branches.
- Averaging repetitions would create a coefficient value that no immutable
  solver result actually produced.
- A UI-only line through conflict points would misrepresent unresolved evidence
  and leave fitted metrics inconsistent with the chart.

The bounded selector is reversible through the versioned cache and preserves
every source result.

## Evidence and verification

- Before the change, the production API returned 52 stored rows across 26 AoAs
  for the affected series: 48 conflict rows, two primary rows, and two
  alternates. The fit accepted only two points.
- The focused unit guard first failed under v5 for a representative repeat
  pair and then passed under v6, while a material Cl disagreement still
  remains a conflict.
- The exact-route browser regression asserts the affected production series
  exposes at least 20 primary angles and that 14°/15° remain present.
- Tooltip containment and chart maximization are covered in the same 20-32C
  narrow-viewport journey so the corrected evidence remains usable.
