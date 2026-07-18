import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { PreliminaryOutcomePanel } from "../components/admin/campaigns/PreliminaryOutcomePanel";
import type {
  AdminCampaignPreliminaryOutcome,
  AdminCampaignPreliminaryOutcomes,
} from "../lib/admin";

vi.mock(
  "@/lib/preliminary-outcomes",
  async () => import("../lib/preliminary-outcomes"),
);
vi.mock("@/lib/tokens", async () => import("../lib/tokens"));

const source = readFileSync(
  fileURLToPath(
    new URL(
      "../components/admin/campaigns/PreliminaryOutcomePanel.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("per-point solver sequence panel", () => {
  it("MUST-CATCH: maps every AoA to one row containing the complete three-stage rail", () => {
    expect(source).toContain("POINT RESULTS");
    expect(source).toContain("outcomes.items.map((item)");
    expect(source).toContain("key={`${item.aoaDeg}:${item.sourceAoaDeg}`}");
    expect(source).toContain(
      "data-testid={`cell-preliminary-outcome-${item.aoaDeg}`}",
    );
    expect(source).toContain("testId={`cell-preliminary-rans-${item.aoaDeg}`}");
    expect(source).toContain("testId={`cell-preliminary-fast-${item.aoaDeg}`}");
    expect(source).toContain(
      "testId={`cell-preliminary-final-${item.aoaDeg}`}",
    );
    expect(source.match(/data-flow-stage="rans">/g)).toHaveLength(1);
    expect(source.match(/data-flow-stage="fast">/g)).toHaveLength(1);
    expect(source.match(/data-flow-stage="final">/g)).toHaveLength(1);
    expect(source).toContain('data-flow-exit="accepted"');
    expect(source).toContain('data-flow-exit="handoff"');
    expect(source).toContain("accepted RANS stops here");
    expect(source).toContain("<small>normal handoff</small>");
    expect(source).toContain("<strong>FAST URANS</strong>");
    expect(source).toContain("<small>preliminary</small>");
    expect(source).toContain("<strong>FINAL URANS</strong>");
    expect(source).toContain("<small>verify</small>");
    expect(source).toContain(
      "RANS non-convergence is a normal handoff; fast URANS starts automatically",
    );
  });

  it("keeps technical evidence nested and collapsed, and makes critical rows system-owned and visually red", () => {
    expect(source).toContain("<details");
    expect(source).not.toMatch(/<details[^>]+open=/);
    expect(source).toContain("Stage evidence for ${label}");
    expect(source).toContain("Technical evidence");
    expect(source).toContain("investigation required");
    expect(source).toContain("system-owned incident");
    expect(source).toContain("box-shadow: inset 3px 0 ${C.red}");
    expect(source).toContain(
      "SYSTEM INCIDENT · ENGINEERING INVESTIGATION REQUIRED",
    );
    expect(source).toContain("view.incidentLabel ?? view.statusLabel");
    expect(source).not.toContain("SYSTEM INCIDENT · AUTO-INVESTIGATE");
    expect(source).not.toContain("automatic investigation required");
    expect(source).not.toContain("RESULT MISSING");
    expect(source).not.toContain("UPDATE UNAVAILABLE");
    expect(source).not.toMatch(/RANS (?:failed|failure)/i);
    expect(source).not.toContain("FAILED POINTS");
    expect(source).not.toContain("no action required");
    expect(source).not.toContain("solver evidence rejected");
  });

  it("keeps stage controls accessible without enlarging their visual glyphs and holds disclosure geometry stable", () => {
    expect(source).toMatch(
      /\.stage-node \{[\s\S]*?width: 44px;[\s\S]*?height: 44px;/,
    );
    expect(source).toContain("button.stage-node:hover::before");
    expect(source).toContain("inset: 9px");
    expect(source).toMatch(
      /\.diagnostics\[open\] > summary \{\s*justify-self: end;/,
    );
    expect(source).toContain(
      "data-testid={`cell-preliminary-incident-${item.aoaDeg}`}",
    );
    expect(source).toContain("SYSTEM");
  });

  it("MUST-CATCH: renders the handoff, physical budget, and evidence accounting inside the existing disclosure", () => {
    const item: AdminCampaignPreliminaryOutcome = {
      aoaDeg: 10,
      sourceAoaDeg: 10,
      derivedBySymmetry: false,
      affectedAoaDegs: [10],
      affectedPointCount: 1,
      state: "satisfied",
      outcome: "accepted",
      ransStage: "screened",
      fastState: "accepted",
      finalState: "accepted",
      finalActivityState: null,
      finalComparison: "within_tolerance",
      finalDeltaCl: 0.002,
      finalDeltaCd: 0.0001,
      finalDeltaCm: null,
      finalSource: "verify",
      criticalStage: null,
      fastResultId: "fast-result",
      fastResultAttemptId: "fast-attempt",
      finalResultId: "final-result",
      finalResultAttemptId: "final-attempt",
      finalEvidenceReasons: [],
      finalSubmitError: null,
      finalSubmitHttpStatus: null,
      physicalAttemptsUsed: 1,
      physicalAttemptsMax: 2,
      recoverySubmissions: 2,
      nonPhysicalSubmissions: 1,
      interruptedPhysicalRuns: 0,
      ransEvidenceRuns: 2,
      preliminaryEvidenceRuns: 1,
      fullUransEvidenceRuns: 1,
      legacyUransEvidenceRuns: 0,
      evidenceReasons: ["not-converged", "solver-stalled"],
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const outcomes: AdminCampaignPreliminaryOutcomes = {
      total: 1,
      recovering: 0,
      critical: 0,
      unavailable: 0,
      verified: 1,
      items: [item],
    };

    // Next's styled-jsx transform removes the boolean `jsx` marker in the
    // browser build. Vitest renders the source TSX directly, so whitelist only
    // that known harness warning while keeping every other React error fatal.
    const reactError = vi
      .spyOn(console, "error")
      .mockImplementation((message, ...args) => {
        const rendered = [message, ...args].map(String).join(" ");
        if (
          !rendered.includes("non-boolean attribute") ||
          !rendered.includes("jsx")
        ) {
          throw new Error(`Unexpected React render error: ${rendered}`);
        }
      });
    vi.stubGlobal("React", React);
    let html: string;
    try {
      html = renderToStaticMarkup(
        React.createElement(PreliminaryOutcomePanel, {
          outcomes,
          error: null,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      reactError.mockRestore();
    }
    const disclosureStart = html.indexOf("<details");

    expect(disclosureStart).toBeGreaterThan(-1);
    expect(html.slice(disclosureStart)).toContain("RANS SCREEN");
    expect(html.slice(disclosureStart)).toContain("URANS FAST");
    expect(html.slice(disclosureStart)).toContain("URANS FINAL");
    expect(html.slice(disclosureStart)).toContain("2 evidence records");
    expect(html.slice(disclosureStart)).toContain("1/2 physical attempts");
    expect(html.slice(disclosureStart)).toContain("1 evidence record");
    expect(html.slice(disclosureStart)).toContain("Technical evidence");
    const technicalStart = html.indexOf("Technical evidence", disclosureStart);
    expect(technicalStart).toBeGreaterThan(disclosureStart);
    expect(html.slice(technicalStart)).toContain(
      "Fast URANS · 1/2 physical attempts",
    );
    expect(html.slice(technicalStart)).toContain(
      "Evidence · 2 RANS evidence records · 1 fast URANS evidence record · 1 final URANS evidence record",
    );
    expect(html.slice(technicalStart)).toContain(
      "1 engine submission ended before CFD; not a physical run.",
    );
    expect(html.match(/cell-preliminary-outcome-10/g)).toHaveLength(1);
    expect(html.match(/<details[^>]*\sopen(?:=|\s|>)/g)).toBeNull();
  });

  it("MUST-CATCH: keeps an accepted final result visible beside a compact system-owned fast-stage incident", () => {
    const item: AdminCampaignPreliminaryOutcome = {
      aoaDeg: 4,
      sourceAoaDeg: 4,
      derivedBySymmetry: false,
      affectedAoaDegs: [4],
      affectedPointCount: 1,
      state: "blocked",
      outcome: "evidence_unavailable",
      ransStage: "screened",
      fastState: "critical",
      finalState: "accepted",
      finalActivityState: null,
      finalComparison: "within_tolerance",
      finalDeltaCl: 0.003,
      finalDeltaCd: 0.0002,
      finalDeltaCm: null,
      finalSource: "full_request",
      criticalStage: "fast",
      fastResultId: null,
      fastResultAttemptId: null,
      finalResultId: "final-result",
      finalResultAttemptId: "final-attempt",
      finalEvidenceReasons: [],
      finalSubmitError: null,
      finalSubmitHttpStatus: null,
      physicalAttemptsUsed: 2,
      physicalAttemptsMax: 2,
      recoverySubmissions: 2,
      nonPhysicalSubmissions: 0,
      interruptedPhysicalRuns: 0,
      ransEvidenceRuns: 1,
      preliminaryEvidenceRuns: 2,
      fullUransEvidenceRuns: 1,
      legacyUransEvidenceRuns: 0,
      evidenceReasons: ["non-stationary"],
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const reactError = vi
      .spyOn(console, "error")
      .mockImplementation((message, ...args) => {
        const rendered = [message, ...args].map(String).join(" ");
        if (
          !rendered.includes("non-boolean attribute") ||
          !rendered.includes("jsx")
        ) {
          throw new Error(`Unexpected React render error: ${rendered}`);
        }
      });
    vi.stubGlobal("React", React);
    let html: string;
    try {
      html = renderToStaticMarkup(
        React.createElement(PreliminaryOutcomePanel, {
          outcomes: {
            total: 1,
            recovering: 0,
            critical: 1,
            unavailable: 1,
            verified: 1,
            items: [item],
          },
          error: null,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      reactError.mockRestore();
    }

    expect(html).toContain("URANS final · verified");
    expect(html).toContain('data-testid="cell-preliminary-incident-4"');
    expect(html).toContain("FAST URANS EXHAUSTED");
    expect(html).toContain("SYSTEM");
    expect(html).toContain(
      "Result and incident facets: 0 active, 0 RANS accepted, 0 fast ready, 1 verified, 1 critical",
    );
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|\s|>)/);
  });

  it("separates evidence-record counts from confirmed physical work in the compact stage summaries", () => {
    expect(source).toContain('data-detail-stage="rans"');
    expect(source).toContain('data-detail-stage="fast"');
    expect(source).toContain('data-detail-stage="final"');
    expect(source).toContain("RANS SCREEN");
    expect(source).toContain("URANS FAST");
    expect(source).toContain("URANS FINAL");
    expect(source).toContain("view.evidenceLabel");
    expect(source).not.toMatch(/ransEvidenceRuns\}\s*physical run/);
    expect(source).toContain("physical");
    expect(source).toContain("before CFD");
    expect(source).toContain(
      "SYSTEM INCIDENT · ENGINEERING INVESTIGATION REQUIRED",
    );
    expect(source).not.toContain("physical runs counted separately");
  });

  it("renders normal RANS handoff as a neutral transition, not an accepted result", () => {
    expect(source).toContain("const ransDidHandoff");
    expect(source).toContain('"handoff"');
    expect(source).toContain(".stage-node.handoff");
    expect(source).toContain(".connector.handoff");
    expect(source).not.toContain(
      'view.ransStage === "screened" ? (\\n                      <CheckCircle2',
    );
  });

  it("keeps accepted-final comparison/activity glyphs distinct from the row-level incident tone", () => {
    expect(source).toContain("comparison-warning");
    expect(source).toContain("update-warning");
    expect(source).toContain(".row-status.warning");
    expect(source).toContain("color: ${C.amber}");
    expect(source).not.toContain('state === "critical" || disagreed');
  });

  it("keeps the stage guide on the same responsive columns as each AoA row", () => {
    expect(
      source.match(
        /grid-template-columns: 72px minmax\(180px, 1fr\) 152px 28px;/g,
      ),
    ).toHaveLength(2);
    expect(
      source.match(
        /grid-template-columns: 58px minmax\(120px, 1fr\) 124px 26px;/g,
      ),
    ).toHaveLength(2);
    expect(
      source.match(/grid-template-columns: 50px minmax\(0, 1fr\) 26px;/g),
    ).toHaveLength(2);
  });
});
