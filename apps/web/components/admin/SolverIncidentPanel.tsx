import { Activity, ShieldAlert, ShieldCheck, Wrench } from "lucide-react";
import React from "react";

import type {
  AdminSolverIncidentGroup,
  AdminSolverIncidentSummary,
} from "../../lib/admin";
import {
  solverIncidentSummaryLabel,
  solverIncidentView,
} from "../../lib/solver-incidents";
import { C, MONO } from "../../lib/tokens";

const PRIMARY_GROUP_LIMIT = 4;

function IncidentRow({
  group,
  threshold,
  index,
}: {
  group: AdminSolverIncidentGroup;
  threshold: number;
  index: number;
}) {
  const view = solverIncidentView(group, threshold);
  const SignalIcon =
    group.stage === "rans"
      ? Wrench
      : group.stage === "preliminary"
        ? Activity
        : ShieldCheck;
  return (
    <div
      className={`solver-incident-row is-${view.tone}`}
      data-testid={`solver-incident-group-${index}`}
      data-stage={group.stage}
      data-severity={view.severity}
      data-status={view.tone}
      aria-label={view.ariaLabel}
    >
      <span className="solver-incident-signal" aria-hidden="true">
        <SignalIcon size={16} strokeWidth={1.8} />
      </span>
      <span className="solver-incident-stage">
        <strong>{view.stageLabel}</strong>
        <small>
          {view.occurrenceLabel} · {view.openLabel}
        </small>
      </span>
      <span className="solver-incident-cause" title={`reason: ${group.reason}`}>
        <strong>{view.reasonLabel}</strong>
        <small>{view.recurrenceLabel}</small>
      </span>
      <strong className="solver-incident-action">
        {view.statusLabel}
        <small>{view.actionLabel}</small>
      </strong>
    </div>
  );
}

function IncidentRows({
  groups,
  threshold,
  offset = 0,
}: {
  groups: AdminSolverIncidentGroup[];
  threshold: number;
  offset?: number;
}) {
  return groups.map((group, index) => (
    <IncidentRow
      key={[
        group.stage,
        group.reason,
        group.solverImplementationId,
        group.remediationVersion,
      ].join(":")}
      group={group}
      threshold={threshold}
      index={offset + index}
    />
  ));
}

export function SolverIncidentPanel({
  summary,
  showClear = false,
  surface,
}: {
  summary: AdminSolverIncidentSummary | null | undefined;
  showClear?: boolean;
  surface: "campaign" | "health";
}) {
  if (!summary) return null;
  if (surface === "campaign" && summary.openCount === 0) return null;
  if (summary.groups.length === 0 && !showClear) return null;

  const surfaceGroups =
    surface === "campaign"
      ? summary.groups.filter((group) => group.openCount > 0)
      : summary.groups;
  if (surfaceGroups.length === 0 && !showClear) return null;
  const orderedGroups = [...surfaceGroups].sort(
    (left, right) =>
      Number(right.openCount > 0) - Number(left.openCount > 0) ||
      Number(right.openCriticalCount > 0) -
        Number(left.openCriticalCount > 0) ||
      Number(right.requiresInvestigation) -
        Number(left.requiresInvestigation) ||
      Date.parse(right.lastOccurredAt) - Date.parse(left.lastOccurredAt),
  );
  const primary = orderedGroups.slice(0, PRIMARY_GROUP_LIMIT);
  const overflow = orderedGroups.slice(PRIMARY_GROUP_LIMIT);
  const currentCritical = orderedGroups.some(
    (group) =>
      group.openCount > 0 &&
      (group.openCriticalCount > 0 ||
        group.occurrenceCount >= summary.threshold ||
        group.effectiveSeverity === "critical"),
  );
  const hasOpen = summary.openCount > 0;
  const hasInvestigationHistory = orderedGroups.some(
    (group) => group.requiresInvestigation,
  );
  const headline =
    summary.groups.length === 0
      ? "No recovery incidents"
      : currentCritical
        ? "System investigation required"
        : hasOpen
          ? "Automatic recovery active"
          : "Recovery history";

  return (
    <section
      className={`solver-incident-panel ${summary.groups.length === 0 ? "is-clear" : currentCritical ? "has-critical" : hasOpen ? "has-warning" : "has-history"}`}
      data-testid={`solver-incidents-${surface}`}
      aria-label={solverIncidentSummaryLabel(summary)}
    >
      <style>{`
        .solver-incident-panel {
          min-width: 0;
          display: grid;
          gap: 0;
          padding: 10px 0;
          font-family: ${MONO};
        }
        .solver-incident-head {
          min-width: 0;
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 10px;
          padding: 0 2px 9px;
        }
        .solver-incident-head > svg {
          color: ${currentCritical ? C.redText : hasOpen ? C.amber : C.teal};
        }
        .is-clear .solver-incident-head {
          padding-bottom: 0;
        }
        .is-clear .solver-incident-head > svg {
          color: ${C.teal};
        }
        .solver-incident-title {
          min-width: 0;
          display: grid;
          gap: 2px;
        }
        .solver-incident-title strong {
          color: ${C.text};
          font-size: 11px;
          letter-spacing: 0.055em;
        }
        .solver-incident-title span {
          color: ${C.muted};
          font-size: 9.5px;
          line-height: 1.35;
        }
        .solver-incident-threshold {
          color: ${
            currentCritical
              ? C.redText
              : hasInvestigationHistory
                ? C.amber
                : C.dim
          };
          font-size: 9px;
          white-space: nowrap;
        }
        .solver-incident-row {
          min-width: 0;
          display: grid;
          grid-template-columns:
            20px minmax(112px, 0.52fr) minmax(170px, 1fr)
            minmax(92px, auto);
          align-items: center;
          gap: 9px;
          padding: 9px 2px;
          border-top: 1px solid ${C.borderRow};
        }
        .solver-incident-signal {
          display: inline-grid;
          place-items: center;
          color: ${C.amber};
        }
        .solver-incident-row.is-critical .solver-incident-signal {
          color: ${C.redText};
        }
        .solver-incident-row.is-resolved .solver-incident-signal {
          color: ${C.tealDim};
        }
        .solver-incident-stage,
        .solver-incident-cause,
        .solver-incident-action {
          min-width: 0;
        }
        .solver-incident-stage,
        .solver-incident-cause {
          display: grid;
          gap: 2px;
        }
        .solver-incident-stage strong {
          color: ${C.violet};
          font-size: 9.5px;
          letter-spacing: 0.04em;
        }
        .solver-incident-row[data-stage="rans"] .solver-incident-stage strong {
          color: ${C.amber};
        }
        .solver-incident-row[data-stage="final"] .solver-incident-stage strong {
          color: ${C.teal};
        }
        .solver-incident-stage small,
        .solver-incident-cause small {
          color: ${C.dim};
          font-size: 8.5px;
          line-height: 1.3;
        }
        .solver-incident-cause strong {
          overflow: hidden;
          color: ${C.text2};
          font-size: 10.5px;
          font-weight: 500;
          line-height: 1.35;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .solver-incident-action {
          display: grid;
          justify-items: end;
          gap: 1px;
          color: ${C.amber};
          font-size: 9px;
          letter-spacing: 0.045em;
        }
        .solver-incident-row.is-critical .solver-incident-action {
          color: ${C.redText};
        }
        .solver-incident-row.is-resolved .solver-incident-action {
          color: ${C.dim};
        }
        .solver-incident-action small {
          color: currentColor;
          font-size: 8px;
          font-weight: 500;
          letter-spacing: 0.02em;
        }
        .solver-incident-more {
          border-top: 1px solid ${C.borderRow};
        }
        .solver-incident-more summary {
          padding: 8px 2px 0 31px;
          color: ${C.muted};
          font-size: 9px;
          cursor: pointer;
        }
        .solver-incident-more summary:hover,
        .solver-incident-more summary:focus-visible {
          color: ${C.teal};
        }
        @media (max-width: 720px) {
          .solver-incident-head {
            grid-template-columns: auto minmax(0, 1fr);
          }
          .solver-incident-threshold {
            grid-column: 2;
            white-space: normal;
          }
          .solver-incident-row {
            grid-template-columns: 20px minmax(0, 1fr) auto;
            grid-template-areas:
              "signal stage action"
              "signal cause cause";
            align-items: start;
            row-gap: 5px;
          }
          .solver-incident-signal {
            grid-area: signal;
            padding-top: 1px;
          }
          .solver-incident-stage {
            grid-area: stage;
          }
          .solver-incident-cause {
            grid-area: cause;
          }
          .solver-incident-action {
            grid-area: action;
          }
          .solver-incident-cause strong {
            white-space: normal;
          }
        }
      `}</style>

      <div className="solver-incident-head">
        {summary.groups.length === 0 || !hasOpen ? (
          <ShieldCheck size={19} strokeWidth={1.7} aria-hidden="true" />
        ) : (
          <ShieldAlert size={19} strokeWidth={1.7} aria-hidden="true" />
        )}
        <span className="solver-incident-title">
          <strong>SOLVER RELIABILITY</strong>
          <span>{headline}</span>
        </span>
        {summary.groups.length > 0 && (
          <span
            className="solver-incident-threshold"
            data-testid="solver-incident-threshold"
          >
            {summary.threshold.toLocaleString()}+ same cause → critical
          </span>
        )}
      </div>

      <IncidentRows groups={primary} threshold={summary.threshold} />
      {overflow.length > 0 && (
        <details className="solver-incident-more">
          <summary>
            +{overflow.length.toLocaleString()} more reliability group
            {overflow.length === 1 ? "" : "s"}
          </summary>
          <IncidentRows
            groups={overflow}
            threshold={summary.threshold}
            offset={PRIMARY_GROUP_LIMIT}
          />
        </details>
      )}
    </section>
  );
}
