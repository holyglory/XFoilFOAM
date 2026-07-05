// Default resolution for the wizard's four numerics slots (spec §11/§12,
// DecisionHistory 2026-07-05). Defaults come from REAL rows only — never
// invented values:
//   · exactly one profile row exists (any origin)   → it is the only possible
//     choice, auto-select it (single-option decision, 2026-07-01);
//   · multiple rows                                  → auto-select iff exactly
//     one seeded row exists (the library default);
//   · zero rows                                      → unresolved; the inline
//     quick-create is the only path forward.
export function resolveNumericsDefault(rows: ReadonlyArray<{ id: string; isSeeded: boolean }>): string | null {
  if (rows.length === 1) return rows[0].id;
  const seeded = rows.filter((row) => row.isSeeded);
  return seeded.length === 1 ? seeded[0].id : null;
}
