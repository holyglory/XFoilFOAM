import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );

describe("solver terminology contract", () => {
  it("MUST-CATCH: never presents exhausted URANS recovery as an ordinary blocked point", () => {
    const adminConsole = source("components/admin/AdminConsole.tsx");
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");

    expect(adminConsole).not.toContain("failed or blocked point");
    expect(adminConsole).not.toContain(
      "{(c.blockedPoints ?? 0).toLocaleString()} blocked",
    );
    expect(adminConsole).toContain(
      "{(c.blockedPoints ?? 0).toLocaleString()} critical",
    );
    expect(pointHistory).not.toContain(">verify blocked<");
    expect(pointHistory).toContain(">final URANS critical<");
    expect(pointHistory).toContain(">final URANS queued<");
  });

  it("keeps blocked terminology for the real storage-admission gate", () => {
    const solverState = source("lib/solver-state.ts");
    expect(solverState).toContain("scheduler · storage blocked");
  });

  it("MUST-CATCH: final verification is presented as the third stage, never as a direct full-tier bypass", () => {
    const solverWork = source("components/detail/SolverWorkPanel.tsx");
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");
    const simModal = source("components/detail/SimModal.tsx");
    const solverWorkModel = source("lib/solver-work.ts");

    for (const text of [solverWork, pointHistory]) {
      expect(text).not.toContain("after all RANS gaps");
    }
    expect(solverWork).toContain(
      "If a fast preliminary result is not available yet, that stage runs first",
    );
    expect(pointHistory).toContain(
      "If fast preliminary URANS is not accepted yet, it runs first",
    );
    expect(pointHistory).toContain(
      'fid === "precalc" ? "fast URANS" : "final verification"',
    );
    expect(simModal).toContain("Request final verification");
    expect(solverWorkModel).toContain("Request final verification");
    expect(solverWorkModel).not.toContain('label: "Request full tier"');
  });

  it("MUST-CATCH: an accepted final/fast difference is comparison context, not a failed verification", () => {
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");

    expect(pointHistory).toContain(
      '<option value="disagreed">final differs from fast</option>',
    );
    expect(pointHistory).not.toContain(">verify disagreed<");
  });

  it("MUST-CATCH: campaign cell status is one per-point flow, not a separate RANS failure/requeue panel", () => {
    const cellPanel = source("components/admin/campaigns/CellSidePanel.tsx");
    const flowPanel = source(
      "components/admin/campaigns/PreliminaryOutcomePanel.tsx",
    );
    const flowModel = source("lib/preliminary-outcomes.ts");

    expect(cellPanel).not.toContain("RANS INTERRUPTIONS");
    expect(cellPanel).not.toContain("getCampaignFailures");
    expect(cellPanel).not.toContain("requeueCampaignFailed");
    expect(cellPanel).toContain("Whole-polar request");
    expect(flowPanel).toContain("RANS non-convergence is a normal handoff");
    expect(flowPanel).toContain('data-flow-stage="fast"');
    expect(flowPanel).toContain('data-flow-stage="final"');
    expect(flowModel).toContain("CRITICAL · AUTO-REPAIR");
    expect(flowModel).not.toMatch(/RANS (?:failed|failure)/i);
  });

  it("MUST-CATCH: incident UI is automatic/system-owned and never exposes recovery implementation labels", () => {
    const incidentPanel = source("components/admin/SolverIncidentPanel.tsx");
    const incidentModel = source("lib/solver-incidents.ts");

    expect(incidentModel).toContain('return "PRE-SOLVER REPAIR"');
    expect(incidentModel).toContain('"RECOVERING"');
    expect(incidentModel).toContain('"AUTOMATIC"');
    expect(incidentModel).toContain('"SYSTEM OWNED"');
    expect(incidentModel).not.toContain('"INVESTIGATE"');
    expect(incidentModel).not.toContain('"SCREENING RECOVERY"');
    expect(incidentPanel).toContain("? Wrench");
    expect(incidentPanel).not.toContain("solver-incident-remediation");
    expect(incidentPanel).not.toContain("group.solverImplementationKey");
    expect(incidentPanel).not.toContain("view.remediationLabel");
  });
});
