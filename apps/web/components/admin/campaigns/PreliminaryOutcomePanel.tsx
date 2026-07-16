import { f1 } from "@aerodb/core";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Info,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  AdminCampaignPreliminaryFastState,
  AdminCampaignPreliminaryFinalActivityState,
  AdminCampaignPreliminaryFinalState,
  AdminCampaignPreliminaryOutcomes,
} from "@/lib/admin";
import {
  preliminaryOutcomeCurrentCounts,
  preliminaryOutcomeCurrentStage,
  preliminaryOutcomeView,
} from "@/lib/preliminary-outcomes";
import { C, MONO } from "@/lib/tokens";
import { fCount } from "./ui";

const angleLabel = (aoaDeg: number) => `α ${f1(aoaDeg)}°`;

export interface PreliminaryResultTarget {
  resultId: string;
  aoaDeg: number;
  sourceAoaDeg: number;
  tier: "fast" | "final";
}

function SolverStageNode({
  className,
  testId,
  current,
  title,
  openLabel,
  onOpen,
  children,
}: {
  className: string;
  testId: string;
  current: boolean;
  title: string;
  openLabel?: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  if (onOpen) {
    return (
      <button
        type="button"
        className={className}
        data-testid={testId}
        aria-current={current ? "step" : undefined}
        aria-label={openLabel}
        title={title}
        onClick={onOpen}
      >
        {children}
      </button>
    );
  }
  return (
    <span
      className={className}
      data-testid={testId}
      aria-current={current ? "step" : undefined}
      title={title}
    >
      {children}
    </span>
  );
}

function FastStageIcon({
  state,
}: {
  state: AdminCampaignPreliminaryFastState;
}) {
  if (state === "critical") {
    return <ShieldAlert size={16} strokeWidth={1.9} aria-hidden />;
  }
  if (state === "accepted") {
    return <CheckCircle2 size={16} strokeWidth={1.9} aria-hidden />;
  }
  if (state === "running") {
    return <Clock3 size={16} strokeWidth={1.9} aria-hidden />;
  }
  return <CircleDot size={16} strokeWidth={1.9} aria-hidden />;
}

function FinalStageIcon({
  state,
  activityState,
  disagreed,
}: {
  state: AdminCampaignPreliminaryFinalState;
  activityState: AdminCampaignPreliminaryFinalActivityState | null;
  disagreed: boolean;
}) {
  if (state === "critical" || disagreed) {
    return <ShieldAlert size={16} strokeWidth={1.9} aria-hidden />;
  }
  if (state === "accepted") {
    if (activityState) {
      return (
        <span className="final-icon-stack" aria-hidden>
          <ShieldCheck className="accepted-mark" size={16} strokeWidth={1.9} />
          {activityState === "critical" ? (
            <ShieldAlert
              className="activity-mark critical"
              size={10}
              strokeWidth={2.2}
            />
          ) : activityState === "running" ? (
            <Clock3
              className="activity-mark running"
              size={10}
              strokeWidth={2.2}
            />
          ) : (
            <CircleDot
              className="activity-mark queued"
              size={10}
              strokeWidth={2.2}
            />
          )}
        </span>
      );
    }
    return <ShieldCheck size={16} strokeWidth={1.9} aria-hidden />;
  }
  if (state === "running") {
    return <Clock3 size={16} strokeWidth={1.9} aria-hidden />;
  }
  return <CircleDot size={16} strokeWidth={1.9} aria-hidden />;
}

export function PreliminaryOutcomePanel({
  outcomes,
  error,
  onOpenResult,
}: {
  outcomes: AdminCampaignPreliminaryOutcomes | null;
  error: string | null;
  onOpenResult?: (target: PreliminaryResultTarget) => void;
}) {
  if (!error && outcomes?.total === 0) return null;
  const currentCounts = outcomes
    ? preliminaryOutcomeCurrentCounts(outcomes.items)
    : null;

  return (
    <section
      data-testid="cell-preliminary-outcomes"
      aria-labelledby="cell-preliminary-outcomes-title"
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <style jsx>{`
        .handoff-header {
          min-height: 38px;
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          padding: 9px 12px 7px;
          border-bottom: 1px solid ${C.borderSoft};
        }
        .handoff-title {
          margin: 0;
          font-family: ${MONO};
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.1em;
          color: ${C.dim};
        }
        .handoff-counts {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-family: ${MONO};
          font-size: 9.5px;
          white-space: nowrap;
        }
        .handoff-counts .active {
          color: ${C.violet};
        }
        .handoff-counts .label {
          color: ${C.dimmest};
          letter-spacing: 0.08em;
        }
        .handoff-counts .ready {
          color: ${C.muted};
        }
        .handoff-counts .verified {
          color: ${C.teal};
        }
        .handoff-counts .critical {
          color: ${C.red};
          font-weight: 700;
        }
        .shared-rail {
          list-style: none;
          display: grid;
          grid-template-columns:
            minmax(0, 1fr) 22px minmax(0, 1fr) 22px
            minmax(0, 1fr);
          align-items: center;
          gap: 6px;
          margin: 0;
          padding: 10px 12px;
          background: ${C.panel2};
        }
        .shared-stage {
          min-width: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          font-family: ${MONO};
          color: ${C.muted};
          text-align: left;
        }
        .shared-stage:first-child {
          color: ${C.teal};
        }
        .shared-stage:nth-child(3) {
          color: ${C.violet};
        }
        .shared-stage strong {
          display: block;
          font-size: 10px;
          line-height: 1.25;
          color: ${C.text};
        }
        .shared-stage small {
          display: block;
          margin-top: 1px;
          font-size: 9.5px;
          line-height: 1.25;
          color: ${C.muted};
        }
        .shared-arrow {
          justify-self: center;
          color: ${C.stroke};
        }
        .outcome-list,
        .diagnostic-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .outcome-row {
          display: grid;
          grid-template-columns: 72px minmax(180px, 1fr) 152px 28px;
          gap: 10px;
          align-items: center;
          min-height: 48px;
          padding: 7px 12px;
          border-top: 1px solid ${C.borderRow};
        }
        .outcome-row.is-active {
          background: color-mix(in srgb, ${C.violet} 3%, transparent);
        }
        .outcome-row.is-verified {
          background: color-mix(in srgb, ${C.teal} 2.5%, transparent);
        }
        .outcome-row.is-critical {
          background: color-mix(in srgb, ${C.red} 5%, transparent);
        }
        .angle {
          min-width: 0;
          font-family: ${MONO};
          font-size: 11px;
          color: ${C.text};
          white-space: nowrap;
        }
        .angle small {
          display: block;
          overflow: hidden;
          margin-top: 1px;
          font-size: 8.5px;
          color: ${C.dim};
          text-overflow: ellipsis;
        }
        .row-track {
          min-width: 0;
          display: grid;
          grid-template-columns:
            20px minmax(20px, 1fr) 20px minmax(20px, 1fr)
            20px;
          align-items: center;
        }
        .stage-node {
          width: 20px;
          height: 20px;
          display: inline-grid;
          place-items: center;
          border-radius: 999px;
          color: ${C.dimmer};
        }
        button.stage-node {
          padding: 0;
          border: 0;
          background: transparent;
          font: inherit;
          cursor: pointer;
        }
        button.stage-node:hover {
          background: ${C.panel3};
        }
        button.stage-node:focus-visible {
          outline: 2px solid ${C.teal};
          outline-offset: 2px;
        }
        .stage-node.screened,
        .stage-node.accepted {
          color: ${C.teal};
        }
        .stage-node.polar_handoff {
          color: ${C.violet};
        }
        .stage-node.skipped {
          color: ${C.muted};
        }
        .stage-node.queued,
        .stage-node.running {
          color: ${C.violet};
        }
        .stage-node.critical,
        .stage-node.disagreed {
          color: ${C.red};
        }
        .stage-node.not_started {
          color: ${C.dimmer};
        }
        .final-icon-stack {
          position: relative;
          width: 20px;
          height: 20px;
          display: inline-grid;
          place-items: center;
        }
        .final-icon-stack .accepted-mark {
          color: ${C.teal};
        }
        .final-icon-stack .activity-mark {
          position: absolute;
          right: -3px;
          bottom: -3px;
          padding: 1px;
          border-radius: 999px;
          background: ${C.panel};
          box-sizing: content-box;
        }
        .final-icon-stack .activity-mark.queued,
        .final-icon-stack .activity-mark.running {
          color: ${C.violet};
        }
        .final-icon-stack .activity-mark.critical {
          color: ${C.red};
        }
        .connector {
          height: 1px;
          min-width: 20px;
          background: ${C.stroke};
        }
        .connector.complete {
          background: color-mix(in srgb, ${C.teal} 72%, ${C.stroke});
        }
        .connector.active {
          background: color-mix(in srgb, ${C.violet} 72%, ${C.stroke});
        }
        .connector.critical {
          background: color-mix(in srgb, ${C.red} 72%, ${C.stroke});
        }
        .connector.polar_handoff {
          background: color-mix(in srgb, ${C.violet} 72%, ${C.stroke});
        }
        .connector.skipped {
          height: 0;
          background: transparent;
          border-top: 1px dashed ${C.dimmer};
        }
        .row-status {
          min-width: 0;
          font-family: ${MONO};
          font-size: 10px;
          font-weight: 700;
          text-align: right;
          white-space: normal;
        }
        .row-status.teal {
          color: ${C.teal};
        }
        .row-status.violet {
          color: ${C.violet};
        }
        .row-status.muted {
          color: ${C.muted};
        }
        .row-status.critical {
          color: ${C.red};
        }
        .diagnostics {
          min-width: 0;
          font-family: ${MONO};
          font-size: 9.5px;
          color: ${C.dim};
        }
        .diagnostics summary {
          width: 26px;
          height: 26px;
          display: inline-grid;
          grid-template-columns: auto auto;
          place-content: center;
          gap: 2px;
          cursor: pointer;
          border-radius: 6px;
          color: ${C.dim};
        }
        .diagnostics summary::-webkit-details-marker {
          display: none;
        }
        .diagnostics summary:hover {
          color: ${C.text};
          background: ${C.panel2};
        }
        .diagnostics summary:focus-visible {
          color: ${C.text};
          outline: 2px solid ${C.teal};
          outline-offset: 2px;
        }
        .diagnostics[open] {
          grid-column: 1 / -1;
          width: 100%;
        }
        .diagnostics[open] summary svg:last-child {
          transform: rotate(180deg);
        }
        .diagnostic-list {
          display: grid;
          gap: 4px;
          margin-top: 7px;
          padding: 8px 10px;
          color: ${C.muted};
          background: ${C.panel2};
          border-radius: 7px;
          line-height: 1.45;
        }
        .diagnostic-list li::before {
          content: "—";
          margin-right: 6px;
          color: ${C.dimmest};
        }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        @media (max-width: 700px) {
          .shared-rail {
            grid-template-columns:
              minmax(0, 1fr) 16px minmax(0, 1fr) 16px
              minmax(0, 1fr);
            gap: 3px;
            padding-inline: 9px;
          }
          .shared-stage {
            gap: 4px;
          }
          .shared-stage strong {
            font-size: 9px;
          }
          .shared-stage small {
            font-size: 8.5px;
          }
          .shared-arrow {
            width: 13px;
          }
          .outcome-row {
            grid-template-columns: 58px minmax(120px, 1fr) 124px 26px;
            gap: 7px;
            padding-inline: 9px;
          }
          .row-status {
            font-size: 9.5px;
          }
        }
        @media (max-width: 500px) {
          .handoff-header {
            align-items: flex-start;
          }
          .handoff-counts {
            display: grid;
            justify-items: end;
            gap: 1px;
          }
          .shared-stage {
            display: grid;
            justify-items: center;
            text-align: center;
          }
          .outcome-row {
            grid-template-columns: 50px minmax(0, 1fr) 26px;
            row-gap: 4px;
          }
          .row-track {
            box-sizing: border-box;
            /* Reserve the final activity badge's four-pixel overhang without
               clipping it or making the compact solver rail horizontally
               scrollable. */
            padding-right: 4px;
          }
          .row-status {
            grid-column: 2;
            grid-row: 2;
            justify-self: end;
          }
          .diagnostics {
            grid-column: 3;
            grid-row: 1 / span 2;
          }
          .diagnostics[open] {
            grid-column: 1 / -1;
            grid-row: 3;
          }
        }
      `}</style>

      <header className="handoff-header">
        <h3 id="cell-preliminary-outcomes-title" className="handoff-title">
          AUTOMATIC SOLVER FLOW
        </h3>
        {outcomes && (
          <span
            className="handoff-counts"
            data-testid="cell-preliminary-current-counts"
            aria-live="polite"
            aria-label={`Current states: ${currentCounts?.active ?? 0} active, ${currentCounts?.fastReady ?? 0} fast ready, ${currentCounts?.verified ?? 0} verified, ${currentCounts?.critical ?? 0} critical`}
            title="Mutually exclusive current-state totals"
          >
            <span className="label">CURRENT</span>
            {(currentCounts?.active ?? 0) > 0 && (
              <span className="active">
                {fCount(currentCounts?.active ?? 0)} active
              </span>
            )}
            {(currentCounts?.fastReady ?? 0) > 0 && (
              <span className="ready">
                {fCount(currentCounts?.fastReady ?? 0)} fast ready
              </span>
            )}
            {(currentCounts?.verified ?? 0) > 0 && (
              <span className="verified">
                {fCount(currentCounts?.verified ?? 0)} verified
              </span>
            )}
            {(currentCounts?.critical ?? 0) > 0 && (
              <span className="critical">
                {fCount(currentCounts?.critical ?? 0)} critical
              </span>
            )}
          </span>
        )}
      </header>

      <div
        className="shared-rail"
        data-testid="cell-preliminary-handoff-rail"
        aria-label="RANS screening, preliminary URANS fast usable result, verified URANS final result"
      >
        <div className="shared-stage">
          <CheckCircle2 size={17} strokeWidth={1.8} aria-hidden />
          <span>
            <strong>RANS screening</strong>
            <small>non-convergence → fast</small>
          </span>
        </div>
        <ArrowRight
          className="shared-arrow"
          size={15}
          strokeWidth={1.6}
          aria-hidden
        />
        <div className="shared-stage">
          <CircleDot size={17} strokeWidth={1.8} aria-hidden />
          <span>
            <strong>Preliminary URANS</strong>
            <small>fast usable result</small>
          </span>
        </div>
        <ArrowRight
          className="shared-arrow"
          size={15}
          strokeWidth={1.6}
          aria-hidden
        />
        <div className="shared-stage">
          <ShieldCheck size={17} strokeWidth={1.8} aria-hidden />
          <span>
            <strong>Verified URANS</strong>
            <small>final result</small>
          </span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            borderTop: `1px solid ${C.borderRow}`,
            padding: "10px 12px",
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.red,
          }}
        >
          Couldn&apos;t load automatic solver status: {error}
        </div>
      )}

      {!outcomes && !error && (
        <div
          role="status"
          style={{
            borderTop: `1px solid ${C.borderRow}`,
            padding: "10px 12px",
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.dim,
          }}
        >
          Loading automatic solver status…
        </div>
      )}

      {outcomes && (
        <ul className="outcome-list" aria-label="Per-angle solver flow">
          {outcomes.items.map((item) => {
            const view = preliminaryOutcomeView(item);
            const label = angleLabel(item.aoaDeg);
            const hasActiveWork =
              view.fastState === "queued" ||
              view.fastState === "running" ||
              view.finalState === "queued" ||
              view.finalState === "running" ||
              item.finalActivityState === "queued" ||
              item.finalActivityState === "running";
            const rowClass = view.critical
              ? "is-critical"
              : hasActiveWork
                ? "is-active"
                : view.finalState === "accepted"
                  ? "is-verified"
                  : "";
            const currentStage = preliminaryOutcomeCurrentStage(item);
            const ransConnectorClass =
              item.criticalStage === "preflight"
                ? "critical"
                : view.ransStage === "screened"
                  ? "complete"
                  : view.ransStage === "polar_handoff"
                    ? "polar_handoff"
                    : "skipped";
            return (
              <li
                key={`${item.aoaDeg}:${item.sourceAoaDeg}`}
                className={`outcome-row ${rowClass}`}
                data-testid={`cell-preliminary-outcome-${item.aoaDeg}`}
                data-current-stage={currentStage}
              >
                <span className="angle">
                  {label}
                  {item.derivedBySymmetry && (
                    <small>from {angleLabel(item.sourceAoaDeg)}</small>
                  )}
                </span>

                <div
                  className="row-track"
                  role="group"
                  data-testid={`cell-preliminary-track-${item.aoaDeg}`}
                  aria-label={`${label}: RANS ${view.ransLabel.toLowerCase()}, fast URANS ${view.fastLabel.toLowerCase()}, final URANS ${view.finalLabel.toLowerCase()}`}
                >
                  <SolverStageNode
                    className={`stage-node ${view.ransStage}`}
                    testId={`cell-preliminary-rans-${item.aoaDeg}`}
                    current={currentStage === "preflight"}
                    title={
                      item.criticalStage === "preflight"
                        ? "RANS: not started; automatic mesh/runtime repair is critical"
                        : `RANS: ${view.ransLabel}`
                    }
                  >
                    {view.ransStage === "screened" ? (
                      <CheckCircle2 size={16} strokeWidth={1.9} aria-hidden />
                    ) : view.ransStage === "polar_handoff" ? (
                      <ArrowRight size={15} strokeWidth={1.9} aria-hidden />
                    ) : (
                      <CircleDot size={15} strokeWidth={1.9} aria-hidden />
                    )}
                    <span className="sr-only">RANS {view.ransLabel}</span>
                  </SolverStageNode>
                  <span
                    className={`connector ${ransConnectorClass}`}
                    aria-hidden
                  />
                  <SolverStageNode
                    className={`stage-node ${view.fastState}`}
                    testId={`cell-preliminary-fast-${item.aoaDeg}`}
                    current={currentStage === "fast"}
                    title={
                      item.fastResultId
                        ? `Open preliminary URANS result: ${view.fastLabel}`
                        : `Preliminary URANS: ${view.fastLabel}`
                    }
                    openLabel={
                      item.fastResultId
                        ? `Open preliminary URANS result for ${label}`
                        : undefined
                    }
                    onOpen={
                      item.fastResultId && onOpenResult
                        ? () =>
                            onOpenResult({
                              resultId: item.fastResultId!,
                              aoaDeg: item.aoaDeg,
                              sourceAoaDeg: item.sourceAoaDeg,
                              tier: "fast",
                            })
                        : undefined
                    }
                  >
                    <FastStageIcon state={view.fastState} />
                    <span className="sr-only">{view.fastLabel}</span>
                  </SolverStageNode>
                  <span
                    className={`connector ${
                      view.fastState === "critical"
                        ? "critical"
                        : view.fastState === "accepted"
                          ? "complete"
                          : view.finalState === "queued" ||
                              view.finalState === "running"
                            ? "active"
                            : ""
                    }`}
                    aria-hidden
                  />
                  <SolverStageNode
                    className={`stage-node ${
                      item.finalComparison === "disagreed"
                        ? "disagreed"
                        : item.finalActivityState === "critical"
                          ? "critical"
                          : view.finalState
                    }`}
                    testId={`cell-preliminary-final-${item.aoaDeg}`}
                    current={currentStage === "final"}
                    title={
                      item.finalResultId
                        ? `Open verified URANS result: ${view.finalLabel}`
                        : `Verified URANS: ${view.finalLabel}`
                    }
                    openLabel={
                      item.finalResultId
                        ? `Open verified URANS result for ${label}`
                        : undefined
                    }
                    onOpen={
                      item.finalResultId && onOpenResult
                        ? () =>
                            onOpenResult({
                              resultId: item.finalResultId!,
                              aoaDeg: item.aoaDeg,
                              sourceAoaDeg: item.sourceAoaDeg,
                              tier: "final",
                            })
                        : undefined
                    }
                  >
                    <FinalStageIcon
                      state={view.finalState}
                      activityState={item.finalActivityState}
                      disagreed={item.finalComparison === "disagreed"}
                    />
                    <span className="sr-only">{view.finalLabel}</span>
                  </SolverStageNode>
                </div>

                <span className={`row-status ${view.statusTone}`}>
                  {view.statusLabel}
                </span>

                <details
                  className="diagnostics"
                  data-testid={`cell-preliminary-diagnostics-${item.aoaDeg}`}
                >
                  <summary
                    aria-label={`Diagnostics for ${label}`}
                    title={`Diagnostics for ${label}`}
                  >
                    <Info size={13} strokeWidth={1.7} aria-hidden />
                    <ChevronDown size={11} strokeWidth={1.7} aria-hidden />
                  </summary>
                  <ul className="diagnostic-list">
                    <li>{view.ransDiagnostic}</li>
                    <li>{view.budgetLabel}</li>
                    {item.recoverySubmissions > 0 && (
                      <li>
                        Solver submissions: {item.recoverySubmissions} total.
                      </li>
                    )}
                    <li>{view.evidenceLabel}</li>
                    {view.diagnostics.map((diagnostic) => (
                      <li key={diagnostic}>{diagnostic}</li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
