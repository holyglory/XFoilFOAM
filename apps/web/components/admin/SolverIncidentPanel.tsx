import {
  Activity,
  ChevronDown,
  CircleCheck,
  CircleDot,
  ShieldAlert,
} from "lucide-react";
import React from "react";

import type {
  AdminSolverIncidentEvent,
  AdminSolverIncidentGroup,
  AdminSolverIncidentSummary,
} from "../../lib/admin";
import {
  solverIncidentStageLabel,
  solverIncidentSummaryLabel,
  solverIncidentView,
} from "../../lib/solver-incidents";
import { C, MONO } from "../../lib/tokens";

function eventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function newestAt(
  events: AdminSolverIncidentEvent[] | undefined,
  groups: AdminSolverIncidentGroup[],
): string | null {
  return events?.[0]?.occurredAt ?? groups[0]?.lastOccurredAt ?? null;
}

function stateCopy(event: AdminSolverIncidentEvent): {
  label: string;
  tone: "critical" | "warning" | "resolved";
} {
  if (event.operationalState === "resolved") {
    return { label: "resolved", tone: "resolved" };
  }
  if (event.operationalState === "automatic_recovery") {
    return { label: "auto retry", tone: "warning" };
  }
  return { label: "solver fix", tone: "critical" };
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="solver-event-json">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function EventRow({
  event,
  index,
}: {
  event: AdminSolverIncidentEvent;
  index: number;
}) {
  const state = stateCopy(event);
  const reason = solverIncidentView(
    {
      stage: event.stage,
      reason: event.reason,
      solverImplementationId: event.solverImplementationId,
      solverImplementationKey: event.solverImplementationKey,
      remediationVersion: event.remediationVersion,
      occurrenceCount: event.patternOccurrenceCount,
      openCount: event.patternOpenCount,
      openCriticalCount:
        event.severity === "critical" ? event.patternOpenCount : 0,
      firstOccurredAt: event.occurredAt,
      lastOccurredAt: event.occurredAt,
      requiresInvestigation: event.severity === "critical",
      effectiveSeverity: event.severity,
    },
    Number.MAX_SAFE_INTEGER,
  ).reasonLabel;
  return (
    <details
      className={`solver-event is-${state.tone}`}
      data-testid={`solver-incident-event-${index}`}
      data-stage={event.stage}
      data-status={event.status}
      data-operational-state={event.operationalState}
    >
      <summary>
        <time dateTime={event.occurredAt}>{eventTime(event.occurredAt)}</time>
        <span className="solver-event-stage">
          {solverIncidentStageLabel(event.stage)}
        </span>
        <strong title={event.reason}>{reason}</strong>
        <span className={`solver-event-state is-${state.tone}`}>
          <CircleDot size={10} aria-hidden="true" />
          {state.label}
        </span>
        <ChevronDown
          className="solver-event-chevron"
          size={14}
          aria-hidden="true"
        />
      </summary>
      <div className="solver-event-body">
        <dl>
          <div>
            <dt>Responsibility</dt>
            <dd>solver system · no user action</dd>
          </div>
          <div>
            <dt>Pattern</dt>
            <dd>
              {event.patternOccurrenceCount.toLocaleString()} recorded ·{" "}
              {event.patternOpenCount.toLocaleString()} unresolved
            </dd>
          </div>
          <div>
            <dt>Solver</dt>
            <dd>{event.solverImplementationKey}</dd>
          </div>
          <div>
            <dt>Recovery version</dt>
            <dd>{event.remediationVersion}</dd>
          </div>
          <div>
            <dt>Event</dt>
            <dd>{event.id}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>
              {event.owner.type} · {event.owner.id}
            </dd>
          </div>
          <div>
            <dt>Job / attempt</dt>
            <dd>
              {event.simJobId ?? "—"} / {event.resultAttemptId ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Occurrence key</dt>
            <dd>{event.occurrenceKey}</dd>
          </div>
          <div>
            <dt>Resolved</dt>
            <dd>
              {event.resolvedAt ? eventTime(event.resolvedAt) : "not yet"}
            </dd>
          </div>
        </dl>
        <div className="solver-event-debug">
          <strong>DEBUG EVIDENCE</strong>
          <JsonBlock value={event.metadata} />
        </div>
      </div>
    </details>
  );
}

function PatternRow({
  group,
  threshold,
  index,
}: {
  group: AdminSolverIncidentGroup;
  threshold: number;
  index: number;
}) {
  const view = solverIncidentView(group, threshold);
  return (
    <details
      className={`solver-event is-${view.tone}`}
      data-testid={`solver-incident-group-${index}`}
      data-stage={group.stage}
      data-status={view.tone}
    >
      <summary>
        <time dateTime={group.lastOccurredAt}>
          {eventTime(group.lastOccurredAt)}
        </time>
        <span className="solver-event-stage">{view.stageLabel}</span>
        <strong title={group.reason}>{view.reasonLabel}</strong>
        <span className={`solver-event-state is-${view.tone}`}>
          <CircleDot size={10} aria-hidden="true" />
          {view.tone === "critical"
            ? "solver fix"
            : view.tone === "warning"
              ? "auto retry"
              : "resolved"}
        </span>
        <ChevronDown
          className="solver-event-chevron"
          size={14}
          aria-hidden="true"
        />
      </summary>
      <div className="solver-event-body">
        <dl>
          <div>
            <dt>Responsibility</dt>
            <dd>solver system · no user action</dd>
          </div>
          <div>
            <dt>Occurrences</dt>
            <dd>
              {group.occurrenceCount.toLocaleString()} recorded ·{" "}
              {group.openCount.toLocaleString()} unresolved
            </dd>
          </div>
          <div>
            <dt>First / latest</dt>
            <dd>
              {eventTime(group.firstOccurredAt)} /{" "}
              {eventTime(group.lastOccurredAt)}
            </dd>
          </div>
          <div>
            <dt>Solver</dt>
            <dd>{group.solverImplementationKey}</dd>
          </div>
          <div>
            <dt>Recovery version</dt>
            <dd>{group.remediationVersion}</dd>
          </div>
          <div>
            <dt>Raw reason</dt>
            <dd>{group.reason}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

export function SolverIncidentPanel({
  summary,
  events,
  showClear = false,
  surface,
}: {
  summary: AdminSolverIncidentSummary | null | undefined;
  events?: AdminSolverIncidentEvent[];
  showClear?: boolean;
  surface: "campaign" | "health";
}) {
  if (!summary) return null;
  if (surface === "campaign" && summary.openCount === 0) return null;
  if (summary.groups.length === 0 && !showClear) return null;

  const visibleGroups =
    surface === "campaign"
      ? summary.groups.filter((group) => group.openCount > 0)
      : summary.groups;
  if (visibleGroups.length === 0 && !showClear) return null;

  const orderedGroups = [...visibleGroups].sort(
    (left, right) =>
      Date.parse(right.lastOccurredAt) - Date.parse(left.lastOccurredAt),
  );
  const eventRows =
    events && events.length > 0
      ? [...events].sort(
          (left, right) =>
            Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
        )
      : null;
  const criticalOpen = summary.groups.reduce(
    (total, group) =>
      total +
      (group.effectiveSeverity === "critical"
        ? group.openCount
        : group.openCriticalCount),
    0,
  );
  const recoveringOpen = Math.max(0, summary.openCount - criticalOpen);
  const latest = newestAt(eventRows ?? undefined, orderedGroups);
  const hasOpen = summary.openCount > 0;
  const title = hasOpen ? "Solver recovery" : "Solver recovery clear";
  const SummaryIcon = criticalOpen > 0 ? ShieldAlert : CircleCheck;

  return (
    <details
      className={`solver-log ${criticalOpen > 0 ? "has-critical" : hasOpen ? "has-warning" : "is-clear"}`}
      data-testid={`solver-incidents-${surface}`}
      aria-label={solverIncidentSummaryLabel(summary)}
    >
      <style>{`
        .solver-log {
          min-width: 0;
          border: 1px solid ${C.border};
          border-radius: 10px;
          background: ${C.panel};
          font-family: ${MONO};
          overflow: clip;
        }
        .solver-log > summary {
          min-width: 0;
          display: grid;
          grid-template-columns: auto minmax(120px, 1fr) auto auto auto auto;
          align-items: center;
          gap: 13px;
          min-height: 46px;
          padding: 0 14px;
          list-style: none;
          cursor: pointer;
        }
        .solver-log > summary::-webkit-details-marker,
        .solver-event > summary::-webkit-details-marker {
          display: none;
        }
        .solver-log > summary:focus-visible,
        .solver-event > summary:focus-visible {
          outline: 2px solid ${C.teal};
          outline-offset: -2px;
        }
        .solver-log-icon {
          display: inline-grid;
          place-items: center;
          color: ${criticalOpen > 0 ? C.redText : hasOpen ? C.amber : C.teal};
        }
        .solver-log-title {
          min-width: 0;
          overflow: hidden;
          color: ${C.text};
          font-size: 11px;
          letter-spacing: 0.045em;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .solver-log-indicator {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: ${C.muted};
          font-size: 9px;
          white-space: nowrap;
        }
        .solver-log-indicator::before {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: currentColor;
          content: "";
        }
        .solver-log-indicator.is-critical {
          color: ${C.redText};
        }
        .solver-log-indicator.is-warning {
          color: ${C.amber};
        }
        .solver-log-indicator.is-clear {
          color: ${C.teal};
        }
        .solver-log-latest {
          color: ${C.dim};
          font-size: 8.5px;
          white-space: nowrap;
        }
        .solver-log-chevron {
          color: ${C.muted};
          transition: transform 150ms ease;
        }
        .solver-log[open] > summary {
          border-bottom: 1px solid ${C.borderRow};
        }
        .solver-log[open] > summary .solver-log-chevron {
          transform: rotate(180deg);
        }
        .solver-log-content {
          min-width: 0;
        }
        .solver-log-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          min-height: 38px;
          padding: 0 14px;
          border-bottom: 1px solid ${C.borderRow};
          color: ${C.dim};
          font-size: 8.5px;
        }
        .solver-log-toolbar > span {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .solver-log-toolbar a {
          color: ${C.teal};
          text-decoration: none;
        }
        .solver-log-toolbar a:hover,
        .solver-log-toolbar a:focus-visible {
          text-decoration: underline;
        }
        .solver-event {
          min-width: 0;
          border-bottom: 1px solid ${C.borderRow};
        }
        .solver-event:last-child {
          border-bottom: 0;
        }
        .solver-event > summary {
          min-width: 0;
          display: grid;
          grid-template-columns:
            minmax(122px, auto) minmax(88px, 0.34fr)
            minmax(170px, 1fr) auto auto;
          align-items: center;
          gap: 12px;
          min-height: 45px;
          padding: 0 14px;
          list-style: none;
          cursor: pointer;
        }
        .solver-event > summary:hover {
          background: rgba(255, 255, 255, 0.018);
        }
        .solver-event > summary time {
          color: ${C.dim};
          font-size: 8.5px;
          white-space: nowrap;
        }
        .solver-event-stage {
          color: ${C.violet};
          font-size: 8.5px;
          letter-spacing: 0.035em;
          white-space: nowrap;
        }
        .solver-event > summary > strong {
          min-width: 0;
          overflow: hidden;
          color: ${C.text2};
          font-size: 10px;
          font-weight: 500;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .solver-event-state {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: ${C.muted};
          font-size: 8.5px;
          white-space: nowrap;
        }
        .solver-event-state.is-critical {
          color: ${C.redText};
        }
        .solver-event-state.is-warning {
          color: ${C.amber};
        }
        .solver-event-state.is-resolved {
          color: ${C.tealDim};
        }
        .solver-event-chevron {
          color: ${C.dim};
          transition: transform 150ms ease;
        }
        .solver-event[open] > summary .solver-event-chevron {
          transform: rotate(180deg);
        }
        .solver-event-body {
          display: grid;
          grid-template-columns: minmax(250px, 0.7fr) minmax(0, 1fr);
          gap: 18px;
          padding: 4px 38px 16px 148px;
          color: ${C.muted};
        }
        .solver-event-body dl {
          min-width: 0;
          display: grid;
          gap: 6px;
          margin: 0;
        }
        .solver-event-body dl > div {
          min-width: 0;
          display: grid;
          grid-template-columns: 106px minmax(0, 1fr);
          gap: 8px;
        }
        .solver-event-body dt {
          color: ${C.dim};
          font-size: 8px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .solver-event-body dd {
          min-width: 0;
          margin: 0;
          overflow-wrap: anywhere;
          color: ${C.muted};
          font-size: 8.5px;
          line-height: 1.4;
        }
        .solver-event-debug {
          min-width: 0;
        }
        .solver-event-debug > strong {
          display: block;
          margin-bottom: 6px;
          color: ${C.dim};
          font-size: 8px;
          letter-spacing: 0.04em;
        }
        .solver-event-json {
          max-height: 230px;
          margin: 0;
          padding: 10px;
          border: 1px solid ${C.borderRow};
          border-radius: 6px;
          background: ${C.bg};
          color: ${C.muted};
          font-family: ${MONO};
          font-size: 8px;
          line-height: 1.45;
          overflow: auto;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .solver-log-empty {
          padding: 16px 14px;
          color: ${C.muted};
          font-size: 9px;
        }
        @media (max-width: 760px) {
          .solver-log > summary {
            grid-template-columns: auto minmax(0, 1fr) auto auto;
            gap: 9px;
          }
          .solver-log-latest {
            display: none;
          }
          .solver-log-indicator.is-clear {
            display: none;
          }
          .solver-event > summary {
            grid-template-columns: minmax(0, 1fr) auto auto;
            grid-template-areas:
              "reason state chevron"
              "time stage chevron";
            gap: 3px 10px;
            min-height: 52px;
          }
          .solver-event > summary time {
            grid-area: time;
          }
          .solver-event-stage {
            grid-area: stage;
            text-align: right;
          }
          .solver-event > summary > strong {
            grid-area: reason;
          }
          .solver-event-state {
            grid-area: state;
          }
          .solver-event-chevron {
            grid-area: chevron;
          }
          .solver-event-body {
            grid-template-columns: minmax(0, 1fr);
            padding: 4px 14px 14px;
          }
        }
        @media (max-width: 420px) {
          .solver-log > summary {
            min-height: 42px;
            padding: 0 11px;
          }
          .solver-log-title {
            font-size: 10px;
          }
          .solver-log-indicator {
            font-size: 8px;
          }
          .solver-log-indicator.is-warning {
            display: none;
          }
          .solver-log-toolbar {
            padding: 0 11px;
          }
          .solver-event > summary {
            padding: 0 11px;
          }
          .solver-event-body dl > div {
            grid-template-columns: minmax(0, 1fr);
            gap: 1px;
          }
        }
      `}</style>

      <summary>
        <span className="solver-log-icon" aria-hidden="true">
          <SummaryIcon size={17} strokeWidth={1.8} />
        </span>
        <strong className="solver-log-title">{title}</strong>
        {criticalOpen > 0 && (
          <span className="solver-log-indicator is-critical">
            {criticalOpen.toLocaleString()} solver-owned
          </span>
        )}
        {recoveringOpen > 0 && (
          <span className="solver-log-indicator is-warning">
            {recoveringOpen.toLocaleString()} retrying
          </span>
        )}
        {!hasOpen && (
          <span className="solver-log-indicator is-clear">clear</span>
        )}
        <span className="solver-log-latest">
          {latest ? `last ${eventTime(latest)}` : "no events"}
        </span>
        <ChevronDown
          className="solver-log-chevron"
          size={15}
          aria-hidden="true"
        />
      </summary>

      <div className="solver-log-content">
        <div className="solver-log-toolbar">
          <span>
            <Activity size={11} aria-hidden="true" /> newest first · system
            owned · no user action
          </span>
          {surface === "health" && (
            <a
              href="/api/admin/solver-incidents?sinceHours=24&limit=100"
              target="_blank"
              rel="noreferrer"
            >
              agent JSON ↗
            </a>
          )}
        </div>
        {eventRows ? (
          eventRows.map((event, index) => (
            <EventRow key={event.id} event={event} index={index} />
          ))
        ) : orderedGroups.length > 0 ? (
          orderedGroups.map((group, index) => (
            <PatternRow
              key={[
                group.stage,
                group.reason,
                group.solverImplementationId,
                group.remediationVersion,
              ].join(":")}
              group={group}
              threshold={summary.threshold}
              index={index}
            />
          ))
        ) : (
          <div className="solver-log-empty">
            No solver recovery events in this window.
          </div>
        )}
      </div>
    </details>
  );
}
