// Momentum convection scheme (OpenFOAM div(phi,U)) — the engine supports
// exactly two values (src/airfoilfoam/case/builder.py _write_fv_schemes maps
// "upwind" -> "bounded Gauss upwind" and EVERYTHING ELSE silently to
// "bounded Gauss linearUpwind grad(U)"), so free text here was a
// silent-wrong-behavior trap. Keep this list in lockstep with the engine.
export const MOMENTUM_SCHEME_LABELS: Record<string, string> = {
  linearUpwind: "linearUpwind — 2nd order (default)",
  upwind: "upwind — 1st order, most robust",
};

/** Select options for a momentum-scheme field. An unrecognized stored value
 *  (none exist today, but rows predate validation) is surfaced honestly
 *  instead of being silently re-mapped by the UI. */
export function momentumSchemeSelect(current: string): { options: string[]; optionLabels: Record<string, string> } {
  const options = Object.keys(MOMENTUM_SCHEME_LABELS);
  const optionLabels = { ...MOMENTUM_SCHEME_LABELS };
  if (current && !options.includes(current)) {
    options.push(current);
    optionLabels[current] = `${current} — unrecognized; the engine runs linearUpwind`;
  }
  return { options, optionLabels };
}
