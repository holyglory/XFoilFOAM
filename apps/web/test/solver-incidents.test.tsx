import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SolverIncidentPanel } from "../components/admin/SolverIncidentPanel";
import type {
  AdminSolverIncidentGroup,
  AdminSolverIncidentSummary,
} from "../lib/admin";
import {
  solverIncidentReasonLabel,
  solverIncidentSummaryLabel,
  solverIncidentView,
} from "../lib/solver-incidents";

function group(
  overrides: Partial<AdminSolverIncidentGroup> = {},
): AdminSolverIncidentGroup {
  return {
    stage: "preliminary",
    reason: "non-stationary",
    solverImplementationId: "solver-id",
    solverImplementationKey: "openfoam-2606",
    remediationVersion: "urans-recovery-2026-07-16-v1",
    occurrenceCount: 1,
    openCount: 1,
    openCriticalCount: 0,
    firstOccurredAt: "2026-07-16T00:00:00.000Z",
    lastOccurredAt: "2026-07-16T01:00:00.000Z",
    requiresInvestigation: false,
    effectiveSeverity: "warning",
    ...overrides,
  };
}

function summary(
  groups: AdminSolverIncidentGroup[],
): AdminSolverIncidentSummary {
  return {
    threshold: 3,
    occurrenceCount: groups.reduce(
      (total, item) => total + item.occurrenceCount,
      0,
    ),
    openCount: groups.reduce((total, item) => total + item.openCount, 0),
    criticalGroupCount: groups.filter((item) => item.requiresInvestigation)
      .length,
    groups,
  };
}

describe("solver incident presentation", () => {
  it("keeps an isolated open URANS warning distinct from normal RANS handoff", () => {
    const view = solverIncidentView(group(), 3);

    expect(view.stageLabel).toBe("FAST URANS");
    expect(view.reasonLabel).toBe("no repeatable cycle");
    expect(view.tone).toBe("warning");
    expect(view.statusLabel).toBe("RECOVERING");
    expect(view.actionLabel).toBe("AUTOMATIC");
    expect(view.ariaLabel).not.toContain("RANS failure");
  });

  it("presents exhausted non-aerodynamic RANS recovery as a critical system incident", () => {
    const view = solverIncidentView(
      group({
        stage: "rans",
        reason: "engine-infrastructure-failure",
        remediationVersion: "rans-recovery-2026-07-16-v1",
        openCriticalCount: 1,
        effectiveSeverity: "critical",
        requiresInvestigation: true,
      }),
      3,
    );

    expect(view.stageLabel).toBe("PRE-SOLVER REPAIR");
    expect(view.reasonLabel).toBe("engine infrastructure failed");
    expect(view.statusLabel).toBe("CRITICAL");
    expect(view.actionLabel).toBe("SYSTEM OWNED");
    expect(view).not.toHaveProperty("remediationLabel");
    expect(view.ariaLabel).not.toContain("rans-recovery-2026-07-16-v1");
  });

  it("keeps remediation generations out of the primary incident UI", () => {
    const incidents = summary([
      group({
        stage: "rans",
        reason: "mesh-quality-failure",
        remediationVersion: "rans-mesh-recovery-v7",
        openCriticalCount: 1,
        effectiveSeverity: "critical",
      }),
    ]);
    const html = renderToStaticMarkup(
      <SolverIncidentPanel summary={incidents} surface="campaign" />,
    );

    expect(html).toContain("mesh recovery exhausted");
    expect(html).not.toContain("rans-mesh-recovery-v7");
    expect(html).not.toContain("openfoam-2606");
    expect(html).not.toContain(">RECOVERY<");
  });

  it("shows exhausted mesh/runtime recovery as a critical pre-solver incident", () => {
    const incidents = summary([
      group({
        stage: "rans",
        reason: "auto-retry-exhausted",
        occurrenceCount: 1,
        openCount: 1,
        openCriticalCount: 1,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
    ]);
    const view = solverIncidentView(incidents.groups[0]!, incidents.threshold);
    const html = renderToStaticMarkup(
      <SolverIncidentPanel summary={incidents} surface="campaign" />,
    );

    expect(view.stageLabel).toBe("PRE-SOLVER REPAIR");
    expect(view.reasonLabel).toBe("automatic pre-solver repair exhausted");
    expect(view.statusLabel).toBe("CRITICAL");
    expect(view.actionLabel).toBe("SYSTEM OWNED");
    expect(html).toContain('data-stage="rans"');
    expect(html).toContain("SOLVER RELIABILITY");
    expect(html).toContain("System investigation required");
    expect(html).not.toContain("RANS failure");
    expect(html).not.toContain("FAST URANS");
    expect(html).not.toContain("FINAL URANS");
  });

  it("makes a repeated open incident critical and explicitly system owned", () => {
    const view = solverIncidentView(
      group({
        occurrenceCount: 3,
        openCount: 2,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
      3,
    );

    expect(view.tone).toBe("critical");
    expect(view.statusLabel).toBe("CRITICAL");
    expect(view.actionLabel).toBe("SYSTEM OWNED");
    expect(view.recurrenceLabel).toBe("same cause ≥3");
  });

  it("keeps a resolved repeated pattern visible without presenting a current failure", () => {
    const incidents = summary([
      group({
        stage: "final",
        reason: "media-repair-exhausted",
        occurrenceCount: 4,
        openCount: 0,
        openCriticalCount: 0,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
    ]);
    const view = solverIncidentView(incidents.groups[0]!, incidents.threshold);

    expect(view.stageLabel).toBe("FINAL URANS");
    expect(view.tone).toBe("resolved");
    expect(view.statusLabel).toBe("RESOLVED");
    expect(view.actionLabel).toBe("HISTORY");
    expect(solverIncidentSummaryLabel(incidents)).toContain("currently clear");
    expect(
      renderToStaticMarkup(
        <SolverIncidentPanel summary={incidents} surface="health" showClear />,
      ),
    ).toContain('data-signal="resolved-final"');
    expect(
      renderToStaticMarkup(
        <SolverIncidentPanel summary={incidents} surface="campaign" />,
      ),
    ).toBe("");
  });

  it("humanizes grouped reason keys without hiding distinct causes", () => {
    expect(
      solverIncidentReasonLabel(
        "incomplete-urans-integration+insufficient-periods",
      ),
    ).toBe("incomplete averaging window · too few repeatable periods");
  });

  it("renders a compact campaign rail without implementation diagnostics or user actions", () => {
    const incidents = summary([
      group({
        stage: "final",
        reason: "continuation-no-progress",
        occurrenceCount: 3,
        openCount: 1,
        openCriticalCount: 1,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
      group({
        reason: "insufficient-periods",
        occurrenceCount: 2,
        openCount: 0,
      }),
    ]);

    const html = renderToStaticMarkup(
      <SolverIncidentPanel summary={incidents} surface="campaign" />,
    );

    expect(html).toContain('data-testid="solver-incidents-campaign"');
    expect(html).toContain("FINAL URANS");
    expect(html).toContain("continuation made no progress");
    expect(html).toContain("×3");
    expect(html).toContain("1 active");
    expect(html).toContain("CRITICAL");
    expect(html).toContain("SYSTEM OWNED");
    expect(html).toContain('data-signal="alert"');
    expect(html).not.toContain('data-signal="resolved-final"');
    expect(html).toContain("3+ same cause → critical");
    expect(html).not.toContain("INVESTIGATE");
    expect(html).not.toContain("urans-recovery-2026-07-16-v1");
    expect(html).not.toContain("openfoam-2606");
    expect(html).not.toContain("solver evidence rejected");
  });

  it("renders an open warning as automatic recovery rather than a failure", () => {
    const incidents = summary([group()]);
    const html = renderToStaticMarkup(
      <SolverIncidentPanel summary={incidents} surface="campaign" />,
    );

    expect(html).toContain("Automatic recovery active");
    expect(html).toContain("RECOVERING");
    expect(html).toContain("AUTOMATIC");
    expect(html).not.toContain("FAILED");
    expect(html).not.toContain("BLOCKED");
  });

  it("renders an honest clear state on Health and omits it on campaign detail", () => {
    const clear = summary([]);

    const health = renderToStaticMarkup(
      <SolverIncidentPanel summary={clear} surface="health" showClear />,
    );
    const campaign = renderToStaticMarkup(
      <SolverIncidentPanel summary={clear} surface="campaign" />,
    );

    expect(health).toContain('data-testid="solver-incidents-health"');
    expect(health).toContain("No recovery incidents");
    expect(campaign).toBe("");
  });
});
