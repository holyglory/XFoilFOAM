import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SolverIncidentPanel } from "../components/admin/SolverIncidentPanel";
import type {
  AdminSolverIncidentEvent,
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

function event(
  overrides: Partial<AdminSolverIncidentEvent> = {},
): AdminSolverIncidentEvent {
  return {
    id: "incident-1",
    stage: "preliminary",
    reason: "non-publishable-evidence",
    severity: "critical",
    status: "open",
    operationalState: "system_attention",
    userActionRequired: false,
    solverImplementationId: "solver-id",
    solverImplementationKey: "openfoam-2606",
    remediationVersion: "urans-recovery-2026-07-16-v1",
    occurrenceKey: "preliminary:incident-1",
    owner: { type: "precalc_obligation", id: "obligation-1" },
    simJobId: "job-1",
    resultAttemptId: "attempt-1",
    campaignIds: ["campaign-1"],
    metadata: {
      lastOutcome: "rejected_exhausted",
      attemptCount: 2,
    },
    occurredAt: "2026-07-16T02:00:00.000Z",
    resolvedAt: null,
    patternOccurrenceCount: 21,
    patternOpenCount: 21,
    ...overrides,
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

  it("humanizes grouped reason keys without hiding distinct causes", () => {
    expect(
      solverIncidentReasonLabel(
        "incomplete-urans-integration+insufficient-periods",
      ),
    ).toBe("incomplete averaging window · too few repeatable periods");
  });

  it("MUST-CATCH: collapses system-owned incidents into one status bar without instructing the user to investigate", () => {
    const incidents = summary([
      group({
        reason: "non-publishable-evidence",
        occurrenceCount: 21,
        openCount: 21,
        openCriticalCount: 21,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
      group({
        stage: "final",
        reason: "incomplete-urans-integration",
        occurrenceCount: 2,
        openCount: 2,
      }),
    ]);

    const html = renderToStaticMarkup(
      <SolverIncidentPanel
        summary={incidents}
        events={[event()]}
        surface="health"
      />,
    );

    expect(html).toContain('data-testid="solver-incidents-health"');
    expect(html).toContain(">Solver recovery<");
    expect(html).toContain("21 solver-owned");
    expect(html).toContain("2 retrying");
    expect(html).toContain("newest first · system");
    expect(html).toContain("no user action");
    expect(html).not.toContain("System investigation required");
    expect(html).not.toContain("same cause → critical");
    expect(html).not.toContain("INVESTIGATE");
  });

  it("MUST-CATCH: renders newest-first event rows and keeps raw diagnostics in individually expandable items", () => {
    const incidents = summary([
      group({
        occurrenceCount: 4,
        openCount: 2,
        openCriticalCount: 2,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
    ]);
    const older = event({
      id: "older",
      occurredAt: "2026-07-16T01:00:00.000Z",
      metadata: { marker: "older-debug" },
    });
    const newer = event({
      id: "newer",
      occurredAt: "2026-07-16T03:00:00.000Z",
      metadata: { marker: "newer-debug" },
    });

    const html = renderToStaticMarkup(
      <SolverIncidentPanel
        summary={incidents}
        events={[older, newer]}
        surface="health"
      />,
    );

    expect(html.indexOf('data-testid="solver-incident-event-0"')).toBeLessThan(
      html.indexOf('data-testid="solver-incident-event-1"'),
    );
    expect(html.indexOf("newer-debug")).toBeLessThan(
      html.indexOf("older-debug"),
    );
    expect(html).toContain("DEBUG EVIDENCE");
    expect(html).toContain("openfoam-2606");
    expect(html).toContain("urans-recovery-2026-07-16-v1");
    expect(html).toContain("preliminary:incident-1");
    expect(html).toContain("agent JSON ↗");
  });

  it("uses grouped patterns as the campaign fallback without exposing a global event log", () => {
    const incidents = summary([
      group({
        stage: "rans",
        reason: "mesh-quality-failure",
        openCriticalCount: 1,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
    ]);
    const html = renderToStaticMarkup(
      <SolverIncidentPanel summary={incidents} surface="campaign" />,
    );

    expect(html).toContain("mesh recovery exhausted");
    expect(html).toContain("solver system · no user action");
    expect(html).not.toContain("agent JSON");
  });

  it("renders a compact clear status on Health and omits it on campaign detail", () => {
    const clear = summary([]);

    const health = renderToStaticMarkup(
      <SolverIncidentPanel summary={clear} surface="health" showClear />,
    );
    const campaign = renderToStaticMarkup(
      <SolverIncidentPanel summary={clear} surface="campaign" />,
    );

    expect(health).toContain('data-testid="solver-incidents-health"');
    expect(health).toContain("Solver recovery clear");
    expect(health).toContain(">clear<");
    expect(campaign).toBe("");
  });

  it("keeps the compact status accessible to assistive technology", () => {
    const incidents = summary([
      group({
        occurrenceCount: 3,
        openCount: 1,
        openCriticalCount: 1,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
    ]);

    expect(solverIncidentSummaryLabel(incidents)).toContain(
      "critical system-owned pattern",
    );
    expect(
      renderToStaticMarkup(
        <SolverIncidentPanel summary={incidents} surface="health" showClear />,
      ),
    ).toContain('aria-label="Solver reliability, 1 active recovery event');
  });
});
