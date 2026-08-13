import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );

describe("solver terminology contract", () => {
  it("MUST-CATCH: unpublished point evidence stays calm and links to exact point tools", () => {
    const adminConsole = source("components/admin/AdminConsole.tsx");
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");
    const correctionForm = source("components/admin/PointCorrectionForm.tsx");

    expect(adminConsole).toContain('onOpenCampaignPoints(c.id, "unpublished")');
    expect(adminConsole).toContain("not published");
    expect(adminConsole).not.toContain("critical recover");
    expect(pointHistory).not.toContain(">verify blocked<");
    expect(pointHistory).not.toContain(">final URANS critical<");
    expect(pointHistory).toContain(">final URANS queued<");
    expect(pointHistory).toContain(">final not published<");
    expect(pointHistory).toContain(
      'data-testid="point-publication-explanation"',
    );
    expect(correctionForm).toContain('data-testid="point-correction-submit"');
    expect(correctionForm).toContain("new immutable, single-angle setup");
  });

  it("names the affected action instead of calling forecast reserve a storage block", () => {
    const solverState = source("lib/solver-state.ts");
    const campaignsHub = source("components/admin/campaigns/CampaignsHub.tsx");
    expect(solverState).toContain("new local starts paused");
    expect(solverState).toContain("forecast reserve, not a full disk");
    expect(solverState).not.toContain("scheduler · storage blocked");
    expect(campaignsHub).toContain("hub-storage-admission-status");
  });

  it("MUST-CATCH: aggregate surfaces never promote retained RANS evidence as a failed point", () => {
    const adminConsole = source("components/admin/AdminConsole.tsx");
    const campaignsHub = source("components/admin/campaigns/CampaignsHub.tsx");
    const campaignStatus = source(
      "components/admin/campaigns/campaign-status.ts",
    );
    const reviewStep = source("components/admin/campaigns/ReviewStep.tsx");

    expect(adminConsole).not.toContain("attention-inspect-failed");
    expect(adminConsole).not.toContain("backlog-failed-link");
    expect(adminConsole).not.toMatch(/failed result(?:s)? · inspect evidence/i);
    expect(campaignsHub).not.toContain("campaign-failed-link");
    expect(campaignsHub).not.toContain("campaign-rejected-link");
    const campaignDetail = source(
      "components/admin/campaigns/CampaignDetail.tsx",
    );
    expect(campaignDetail).not.toContain("campaign-failed-link");
    expect(campaignDetail).not.toContain("campaign-needs-review-chip");
    expect(campaignsHub).toContain("awaiting FAST URANS");
    expect(campaignStatus).toContain("Awaiting FAST URANS");
    expect(campaignStatus).toContain("not published");
    expect(campaignStatus).not.toContain("critical recover");
    expect(reviewStep).toContain("reviewQueueOperationalState");
    expect(reviewStep).not.toContain("{queue.engineUnreachableSince &&");
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
      "If FAST URANS is not accepted yet, it runs first automatically",
    );
    expect(pointHistory).toContain(
      'data-testid="point-request-final-verification"',
    );
    expect(pointHistory).toContain(
      'data-testid="point-row-request-final-verification"',
    );
    expect(pointHistory).not.toContain("point-request-urans-precalc");
    expect(pointHistory).not.toContain("point-row-request-urans-precalc");
    expect(pointHistory).not.toContain("point-request-urans-${fid}");
    expect(pointHistory).not.toContain("point-row-request-urans-${fid}");
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
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");
    const flowPanel = source(
      "components/admin/campaigns/PreliminaryOutcomePanel.tsx",
    );
    const flowModel = source("lib/preliminary-outcomes.ts");

    expect(cellPanel).not.toContain("RANS INTERRUPTIONS");
    expect(cellPanel).not.toContain("getCampaignFailures");
    expect(cellPanel).not.toContain("requeueCampaignFailed");
    expect(cellPanel).toContain('data-testid="cell-operator-overrides"');
    expect(cellPanel).toContain("Manual whole-polar verification");
    expect(cellPanel).toContain(
      'data-testid="cell-request-final-verification"',
    );
    expect(cellPanel).not.toContain("cell-request-urans-precalc");
    expect(cellPanel).not.toContain("cell-request-urans-${fidelity}");
    expect(cellPanel).not.toContain('(["precalc", "full"] as const)');
    expect(pointHistory).not.toContain('(["precalc", "full"] as const)');
    expect(flowPanel).toContain("RANS non-convergence is a normal handoff");
    expect(flowPanel).toContain('data-flow-stage="fast"');
    expect(flowPanel).toContain('data-flow-stage="final"');
    expect(flowModel).toContain("CRITICAL · SOLVER COULD NOT START");
    expect(flowModel).toContain("CRITICAL · PRE-URANS SYSTEM RECOVERY");
    expect(flowModel).not.toMatch(/RANS (?:failed|failure)/i);
    expect(flowModel).not.toContain("RESULT MISSING");
    expect(flowModel).not.toContain("UPDATE UNAVAILABLE");
  });

  it("MUST-CATCH: manual solver intervention stays collapsed and operator-only across per-point surfaces", () => {
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");
    const cellPanel = source("components/admin/campaigns/CellSidePanel.tsx");
    const solverWork = source("components/detail/SolverWorkPanel.tsx");
    const simModal = source("components/detail/SimModal.tsx");

    const pointOverrides = pointHistory.indexOf(
      'data-testid="point-operator-overrides"',
    );
    expect(pointOverrides).toBeGreaterThan(-1);
    expect(pointHistory.indexOf('data-testid="point-requeue"')).toBeGreaterThan(
      pointOverrides,
    );
    expect(
      pointHistory.indexOf("data-testid={`point-continue-${h}h`}"),
    ).toBeGreaterThan(pointOverrides);
    expect(
      pointHistory.indexOf('data-testid="point-request-final-verification"'),
    ).toBeGreaterThan(pointOverrides);
    expect(pointHistory).toContain("OPERATOR OVERRIDE");
    expect(pointHistory).toContain(
      "Normal recovery and final verification are automatic.",
    );

    const cellOverrides = cellPanel.indexOf(
      'data-testid="cell-operator-overrides"',
    );
    expect(
      cellPanel.indexOf('data-testid="cell-request-final-verification"'),
    ).toBeGreaterThan(cellOverrides);

    const workOverrides = solverWork.indexOf(
      'data-testid="solver-work-operator-overrides"',
    );
    expect(workOverrides).toBeGreaterThan(-1);
    expect(
      solverWork.indexOf("adminActions.map", workOverrides),
    ).toBeGreaterThan(workOverrides);

    const simOverrides = simModal.indexOf(
      'data-testid="sim-review-operator-overrides"',
    );
    expect(simOverrides).toBeGreaterThan(-1);
    expect(
      simModal.indexOf('data-testid="sim-review-continue-6h"'),
    ).toBeGreaterThan(simOverrides);
    expect(
      simModal.indexOf('data-testid="sim-review-request-full"'),
    ).toBeGreaterThan(simOverrides);
  });

  it("MUST-CATCH: Solver Points uses a true stacked modal with scroll and focus ownership", () => {
    const pointHistory = source("components/admin/PointHistoryPanel.tsx");

    expect(pointHistory).toContain("useModalLayer(storyOpen)");
    expect(pointHistory).toContain('data-testid="point-story-backdrop"');
    expect(pointHistory).toContain('aria-modal="true"');
    expect(pointHistory).toContain('aria-labelledby="point-story-title"');
    expect(pointHistory).toContain(
      'aria-hidden={simOpen ? "true" : undefined}',
    );
    expect(pointHistory).toContain("inert={simOpen}");
    expect(pointHistory).toContain("onKeyDown={trapStoryFocus}");
    expect(pointHistory).toContain("storyCloseButtonRef.current?.focus");
    expect(pointHistory).toContain("trigger.focus({ preventScroll: true })");
    expect(pointHistory).toContain("dialogs.at(-1) !== storyPanelRef.current");
    expect(pointHistory).toContain(
      "restoreFocusTo={storyResultTriggerRef.current}",
    );
  });

  it("MUST-CATCH: incident UI keeps solver-owned quality follow-up calm and progressively discloses diagnostics", () => {
    const incidentPanel = source("components/admin/SolverIncidentPanel.tsx");
    const incidentModel = source("lib/solver-incidents.ts");

    expect(incidentModel).toContain('return "PRE-SOLVER REPAIR"');
    expect(incidentModel).toContain('"RECOVERING"');
    expect(incidentModel).toContain('"AUTOMATIC"');
    expect(incidentModel).toContain('"SYSTEM OWNED"');
    expect(incidentModel).not.toContain('"INVESTIGATE"');
    expect(incidentModel).not.toContain('"SCREENING RECOVERY"');
    expect(incidentPanel).toContain(
      'const title = hasOpen ? "Solver quality log"',
    );
    expect(incidentPanel).toContain("<details");
    expect(incidentPanel).toContain("publication checks and");
    expect(incidentPanel).toContain("solver system · no user action");
    expect(incidentPanel).toContain("agent JSON ↗");
    expect(incidentPanel).toContain("DEBUG EVIDENCE");
    expect(incidentPanel).not.toContain("System investigation required");
    expect(incidentPanel).not.toContain("same cause → critical");
    expect(incidentPanel).not.toContain("has-critical");
    expect(incidentPanel).not.toContain('return { label: "solver fix"');
    expect(incidentPanel).not.toContain("view.remediationLabel");
  });
});
