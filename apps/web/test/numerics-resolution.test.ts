import { describe, expect, it } from "vitest";

import { resolveNumericsDefault } from "../components/admin/campaigns/numerics-resolution";

// Default resolution rule for the wizard's four numerics slots (spec §11/§12,
// DecisionHistory 2026-07-05): defaults only from real rows — single row of
// any origin, else exactly one seeded row; otherwise unresolved (null).
const row = (id: string, isSeeded: boolean) => ({ id, isSeeded });

describe("resolveNumericsDefault", () => {
  it("returns null for an empty library (unresolved — quick-create is the only path)", () => {
    expect(resolveNumericsDefault([])).toBeNull();
  });

  it("auto-selects a single row regardless of origin (single-option decision)", () => {
    expect(resolveNumericsDefault([row("a", false)])).toBe("a");
    expect(resolveNumericsDefault([row("a", true)])).toBe("a");
  });

  it("auto-selects the seeded row when it is the only seeded one among many", () => {
    expect(resolveNumericsDefault([row("a", false), row("b", true), row("c", false)])).toBe("b");
  });

  it("stays unresolved with multiple rows and no seeded row", () => {
    expect(resolveNumericsDefault([row("a", false), row("b", false)])).toBeNull();
  });

  it("stays unresolved with multiple seeded rows (ambiguous — never guess)", () => {
    expect(resolveNumericsDefault([row("a", true), row("b", true), row("c", false)])).toBeNull();
  });
});
