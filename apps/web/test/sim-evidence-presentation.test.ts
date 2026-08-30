import { describe, expect, it } from "vitest";

import { simEvidencePresentation } from "../lib/sim-evidence-presentation";

const allVisibleLabels = (view: ReturnType<typeof simEvidencePresentation>) =>
  `${view.methodChip} ${view.mediaTag} ${view.provenance} ${view.historyTitle} ${view.historyText}`;

describe("simEvidencePresentation", () => {
  it("labels an explicit RANS result as steady RANS evidence", () => {
    const view = simEvidencePresentation({
      fidelity: "rans",
      regime: "attached",
      turbulenceModel: "kOmegaSST",
    });

    expect(view).toEqual({
      method: "RANS",
      methodChip: "RANS · steady",
      mediaTag: "RANS · steady static",
      provenance:
        "RANS kOmegaSST · steady result evidence · stored media/evidence only",
      historyTitle: "Final coefficients recorded",
      historyText:
        "This pointwise-converged RANS solve records its final coefficients and convergence summary, not an iteration-by-iteration coefficient series.",
    });
  });

  it("keeps explicit RANS method provenance separate from a stalled-flow outcome", () => {
    const view = simEvidencePresentation({
      fidelity: "rans",
      regime: "stalled",
      turbulenceModel: "kOmegaSST",
    });

    expect(view.method).toBe("RANS");
    expect(view.methodChip).toBe("RANS · stalled");
    expect(view.mediaTag).toBe("RANS · stalled static");
    expect(view.provenance).toContain(
      "RANS kOmegaSST · stalled-flow screening evidence",
    );
  });

  it.each([
    ["urans_precalc", "URANS fast"],
    ["urans_full", "URANS final"],
  ] as const)(
    "keeps %s visibly URANS when the measured flow is steady and has no shedding",
    (fidelity, tier) => {
      const view = simEvidencePresentation({
        fidelity,
        regime: "attached",
        turbulenceModel: "kOmegaSST",
      });

      expect(view.methodChip).toBe("URANS · steady (no shedding)");
      expect(view.mediaTag).toBe(`${tier} · steady static`);
      expect(view.provenance).toContain(
        `${tier} kOmegaSST · steady/no-shedding result evidence`,
      );
      expect(view.historyTitle).toBe(
        "Steady/no-shedding coefficients recorded",
      );
      expect(view.historyText).toContain(
        `This ${tier} solve certified a steady, no-shedding outcome`,
      );
      expect(allVisibleLabels(view)).not.toMatch(/(^|\s)RANS(\s|$)/);
    },
  );

  it.each([
    ["urans_precalc", "URANS fast"],
    ["urans_full", "URANS final"],
  ] as const)(
    "labels periodic %s media and provenance with its URANS tier",
    (fidelity, tier) => {
      const view = simEvidencePresentation({
        fidelity,
        regime: "stalled",
        turbulenceModel: "kOmegaSST",
        transportActive: true,
        hasRecordedFrames: true,
      });

      expect(view.methodChip).toBe("URANS · vortex shedding");
      expect(view.mediaTag).toBe(`RECORDED FRAMES · ${tier}`);
      expect(view.provenance).toContain(
        `${tier} kOmegaSST · engine-recorded period-locked frame evidence`,
      );
      expect(allVisibleLabels(view)).not.toMatch(/(^|\s)RANS(\s|$)/);
    },
  );

  it("keeps a legacy stalled row visibly URANS when explicit fidelity is absent", () => {
    const view = simEvidencePresentation({
      fidelity: null,
      regime: "stalled",
      turbulenceModel: null,
    });

    expect(view.method).toBe("URANS");
    expect(view.methodChip).toBe("URANS · vortex shedding");
    expect(view.mediaTag).toBe("URANS · mean static");
    expect(view.provenance).toContain(
      "URANS solver · periodic result evidence",
    );
  });

  it("keeps a legacy attached row RANS when no URANS provenance exists", () => {
    const view = simEvidencePresentation({
      fidelity: null,
      regime: "attached",
    });

    expect(view.method).toBe("RANS");
    expect(view.methodChip).toBe("RANS · steady");
  });
});
