import { describe, expect, it } from "vitest";
import { polarEvidencePublicationRank } from "../src/polar-publication";

describe("stored polar publication precedence", () => {
  it("keeps accepted evidence ahead of provisional evidence at every fidelity", () => {
    for (const fidelity of [null, "urans_precalc", "urans_full"])
      expect(
        polarEvidencePublicationRank("accepted", null, "rans"),
      ).toBeGreaterThan(
        polarEvidencePublicationRank("needs_urans", fidelity, "urans"),
      );
  });

  it("preserves the existing full, preliminary, then steady ordering", () => {
    expect(
      polarEvidencePublicationRank("accepted", "urans_full", "urans"),
    ).toBe(230);
    expect(
      polarEvidencePublicationRank("accepted", "urans_precalc", "urans"),
    ).toBe(220);
    expect(polarEvidencePublicationRank("accepted", null, "urans")).toBe(220);
    expect(polarEvidencePublicationRank("accepted", null, "rans")).toBe(210);
    expect(polarEvidencePublicationRank("accepted", "unknown", null)).toBe(210);
    expect(
      polarEvidencePublicationRank("needs_urans", "urans_full", "urans"),
    ).toBe(130);
  });
});
