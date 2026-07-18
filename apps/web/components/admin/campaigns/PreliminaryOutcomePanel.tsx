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
  preliminaryOutcomeCriticalAnnouncement,
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
  if (state === "critical") {
    return <ShieldAlert size={16} strokeWidth={1.9} aria-hidden />;
  }
  if (state === "accepted") {
    if (disagreed || activityState) {
      return (
        <span className="final-icon-stack" aria-hidden>
          <ShieldCheck className="accepted-mark" size={16} strokeWidth={1.9} />
          {disagreed || activityState === "critical" ? (
            <Info
              className="activity-mark warning"
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
  const criticalAnnouncement = outcomes
    ? preliminaryOutcomeCriticalAnnouncement(outcomes.items)
    : "";

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
          color: ${C.teal};
        }
        .handoff-counts .verified {
          color: ${C.teal};
        }
        .handoff-counts .critical {
          color: ${C.red};
          font-weight: 700;
        }
        .flow-guide {
          display: grid;
          grid-template-columns: 72px minmax(180px, 1fr) 152px 28px;
          align-items: center;
          gap: 10px;
          padding: 8px 12px 9px;
          background: ${C.panel2};
        }
        .guide-label {
          font-family: ${MONO};
          font-size: 8px;
          font-weight: 600;
          letter-spacing: 0.1em;
          color: ${C.dimmest};
        }
        .guide-label.now {
          text-align: right;
        }
        .shared-rail {
          min-width: 0;
          display: grid;
          grid-template-columns:
            auto minmax(56px, 1fr) auto minmax(16px, 1fr)
            auto;
          align-items: center;
          gap: 4px;
        }
        .shared-stage {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 5px;
          font-family: ${MONO};
          color: ${C.muted};
          text-align: left;
        }
        .shared-stage[data-flow-stage="fast"] {
          justify-self: center;
        }
        .shared-stage[data-flow-stage="final"] {
          justify-self: end;
        }
        .shared-stage[data-flow-stage="rans"] {
          color: ${C.teal};
        }
        .shared-stage[data-flow-stage="fast"] {
          color: ${C.violet};
        }
        .shared-stage strong {
          display: block;
          font-size: 10px;
          letter-spacing: 0.04em;
          line-height: 1.25;
          color: ${C.text};
          white-space: nowrap;
        }
        .shared-stage small {
          display: block;
          margin-top: 1px;
          font-size: 9.5px;
          line-height: 1.25;
          color: ${C.muted};
        }
        .flow-branch {
          min-width: 0;
          display: grid;
          gap: 4px;
        }
        .flow-exit {
          min-width: 0;
          display: grid;
          grid-template-columns: minmax(8px, 1fr) auto auto;
          align-items: center;
          gap: 3px;
          font-family: ${MONO};
          white-space: nowrap;
        }
        .flow-exit::before {
          content: "";
          height: 1px;
          background: currentColor;
          opacity: 0.6;
        }
        .flow-exit.accepted {
          color: ${C.teal};
        }
        .flow-exit.handoff {
          color: ${C.violet};
        }
        .flow-exit small {
          overflow: hidden;
          font-size: 7px;
          font-weight: 700;
          letter-spacing: 0.05em;
          line-height: 1;
          text-overflow: ellipsis;
        }
        .shared-arrow {
          justify-self: center;
          display: grid;
          place-items: center;
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
          box-shadow: inset 3px 0 ${C.red};
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
            44px minmax(12px, 1fr) 44px minmax(12px, 1fr)
            44px;
          align-items: center;
        }
        .stage-node {
          position: relative;
          width: 44px;
          height: 44px;
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
          background: transparent;
        }
        button.stage-node:hover::before {
          content: "";
          position: absolute;
          inset: 9px;
          z-index: 0;
          border-radius: 999px;
          background: ${C.panel3};
        }
        .stage-node > svg,
        .stage-node > .final-icon-stack,
        .stage-node > .sr-only {
          position: relative;
          z-index: 1;
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
        .stage-node.handoff {
          color: ${C.muted};
        }
        .stage-node.skipped {
          color: ${C.muted};
        }
        .stage-node.queued,
        .stage-node.running {
          color: ${C.violet};
        }
        .stage-node.automatic-next {
          color: ${C.violet};
        }
        .stage-node.critical {
          color: ${C.red};
        }
        .stage-node.comparison-warning,
        .stage-node.update-warning {
          color: ${C.amber};
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
        .final-icon-stack .activity-mark.warning {
          color: ${C.amber};
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
        .connector.warning {
          background: color-mix(in srgb, ${C.amber} 72%, ${C.stroke});
        }
        .connector.polar_handoff {
          background: color-mix(in srgb, ${C.violet} 72%, ${C.stroke});
        }
        .connector.handoff {
          background: color-mix(in srgb, ${C.violet} 72%, ${C.stroke});
        }
        .connector.skipped {
          height: 0;
          background: transparent;
          border-top: 1px dashed ${C.dimmer};
        }
        .row-result {
          min-width: 0;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 6px;
          text-align: right;
        }
        .row-status {
          min-width: 0;
          font-family: ${MONO};
          font-size: 10px;
          font-weight: 700;
          white-space: normal;
        }
        .system-incident-marker {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 2px 4px;
          border: 1px solid color-mix(in srgb, ${C.red} 55%, ${C.border});
          border-radius: 999px;
          font-family: ${MONO};
          font-size: 7.5px;
          font-weight: 800;
          letter-spacing: 0.055em;
          line-height: 1;
          color: ${C.red};
          white-space: nowrap;
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
        .row-status.warning {
          color: ${C.amber};
        }
        .row-status.critical {
          color: ${C.red};
          letter-spacing: 0.025em;
        }
        .diagnostics {
          min-width: 0;
          justify-self: end;
          font-family: ${MONO};
          font-size: 9.5px;
          color: ${C.dim};
        }
        .diagnostics > summary {
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
        .diagnostics > summary::-webkit-details-marker {
          display: none;
        }
        .diagnostics > summary:hover {
          color: ${C.text};
          background: ${C.panel2};
        }
        .diagnostics > summary:focus-visible {
          color: ${C.text};
          outline: 2px solid ${C.teal};
          outline-offset: 2px;
        }
        .diagnostics[open] {
          grid-column: 1 / -1;
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          width: 100%;
        }
        .diagnostics[open] > summary {
          justify-self: end;
        }
        .diagnostics[open] > summary svg:last-child {
          transform: rotate(180deg);
        }
        .detail-body {
          display: grid;
          gap: 8px;
          margin-top: 7px;
          padding: 8px;
          background: ${C.panel2};
          border-radius: 7px;
        }
        .stage-evidence-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px;
        }
        .stage-evidence {
          min-width: 0;
          display: grid;
          grid-template-columns: 22px minmax(0, 1fr);
          align-items: center;
          gap: 6px;
          padding: 7px 8px;
          background: ${C.panel3};
          border-radius: 6px;
        }
        .detail-stage-icon {
          width: 22px;
          height: 22px;
          display: inline-grid;
          place-items: center;
          border-radius: 999px;
          color: ${C.muted};
          background: color-mix(in srgb, ${C.stroke} 28%, transparent);
        }
        .detail-stage-icon.active {
          color: ${C.violet};
        }
        .detail-stage-icon.accepted {
          color: ${C.teal};
        }
        .detail-stage-icon.handoff {
          color: ${C.muted};
        }
        .detail-stage-icon.critical {
          color: ${C.red};
        }
        .detail-stage-copy {
          min-width: 0;
          display: grid;
          gap: 1px;
        }
        .detail-stage-copy strong {
          overflow: hidden;
          font-size: 8px;
          font-weight: 600;
          letter-spacing: 0.08em;
          color: ${C.dim};
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .detail-stage-copy span {
          font-size: 10px;
          font-weight: 700;
          color: ${C.text};
        }
        .detail-stage-copy small {
          overflow: hidden;
          font-size: 8.5px;
          color: ${C.muted};
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .incident-banner {
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 7px 8px;
          border: 1px solid color-mix(in srgb, ${C.red} 45%, ${C.border});
          border-radius: 6px;
          color: ${C.red};
          background: color-mix(in srgb, ${C.red} 6%, transparent);
        }
        .incident-banner strong {
          font-size: 8.5px;
          letter-spacing: 0.055em;
        }
        .incident-banner span {
          margin-left: auto;
          font-size: 8.5px;
          color: ${C.text2};
        }
        .technical-evidence {
          padding-top: 2px;
          border-top: 1px solid ${C.borderSoft};
        }
        .technical-evidence > summary {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 5px 2px 1px;
          cursor: pointer;
          font-size: 8.5px;
          font-weight: 600;
          letter-spacing: 0.05em;
          color: ${C.dim};
          list-style: none;
        }
        .technical-evidence > summary::-webkit-details-marker {
          display: none;
        }
        .technical-evidence > summary:focus-visible {
          outline: 2px solid ${C.teal};
          outline-offset: 2px;
        }
        .technical-evidence[open] > summary svg {
          transform: rotate(180deg);
        }
        .technical-body {
          display: grid;
          gap: 6px;
          padding: 7px 2px 1px;
        }
        .detail-summary {
          min-width: 0;
          display: grid;
          gap: 3px;
          font-size: 8.5px;
          line-height: 1.4;
          color: ${C.dim};
        }
        .detail-summary .rans-explanation {
          color: ${C.text2};
        }
        .detail-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 5px 12px;
          font-size: 8.5px;
          color: ${C.dim};
        }
        .detail-meta .system-owned {
          color: ${C.red};
          font-weight: 700;
          letter-spacing: 0.05em;
        }
        .diagnostic-list {
          display: grid;
          gap: 4px;
          padding: 0;
          color: ${C.muted};
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
          .flow-guide {
            grid-template-columns: 58px minmax(120px, 1fr) 124px 26px;
            gap: 7px;
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
            min-width: 12px;
          }
          .shared-arrow small {
            display: none;
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
          .flow-guide {
            grid-template-columns: 50px minmax(0, 1fr) 26px;
            row-gap: 4px;
          }
          .guide-label.now {
            display: none;
          }
          .flow-guide > .sr-only {
            grid-column: 3;
          }
          .shared-rail {
            grid-template-columns:
              auto minmax(12px, 1fr) auto minmax(12px, 1fr)
              auto;
          }
          .shared-stage svg {
            display: none;
          }
          .shared-stage strong {
            font-size: 8.5px;
          }
          .shared-stage small {
            font-size: 7.5px;
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
          .row-result {
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
          .stage-evidence-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <header className="handoff-header">
        <h3 id="cell-preliminary-outcomes-title" className="handoff-title">
          POINT RESULTS
        </h3>
        {outcomes && (
          <span
            className="handoff-counts"
            data-testid="cell-preliminary-current-counts"
            aria-live="polite"
            aria-label={`Result and incident facets: ${currentCounts?.active ?? 0} active, ${currentCounts?.ransAccepted ?? 0} RANS accepted, ${currentCounts?.fastReady ?? 0} fast ready, ${currentCounts?.verified ?? 0} verified, ${currentCounts?.critical ?? 0} critical`}
            title="Result availability and active-work totals; critical incidents can overlap"
          >
            <span className="label">STATUS</span>
            {(currentCounts?.active ?? 0) > 0 && (
              <span className="active">
                {fCount(currentCounts?.active ?? 0)} active
              </span>
            )}
            {(currentCounts?.ransAccepted ?? 0) > 0 && (
              <span className="ready">
                {fCount(currentCounts?.ransAccepted ?? 0)} RANS accepted
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

      <span
        className="sr-only"
        data-testid="cell-preliminary-critical-announcement"
        role="status"
        aria-live="assertive"
        aria-atomic="true"
      >
        {criticalAnnouncement
          ? `Critical solver incidents: ${criticalAnnouncement}`
          : ""}
      </span>

      <div className="flow-guide">
        <span className="guide-label">POINT</span>
        <div
          className="shared-rail"
          data-testid="cell-preliminary-handoff-rail"
          aria-label="Each point starts with RANS screening. An accepted RANS result stops there; aerodynamic non-convergence hands off automatically to fast preliminary URANS, then final verified URANS."
        >
          <div className="shared-stage" data-flow-stage="rans">
            <CircleDot size={15} strokeWidth={1.8} aria-hidden />
            <span>
              <strong>RANS</strong>
              <small>screen</small>
            </span>
          </div>
          <div className="flow-branch" aria-hidden>
            <span
              className="flow-exit accepted"
              data-flow-exit="accepted"
              title="accepted RANS stops here"
            >
              <CheckCircle2 size={11} strokeWidth={2} />
              <small>accepted</small>
            </span>
            <span
              className="flow-exit handoff"
              data-flow-exit="handoff"
              title="RANS non-convergence is a normal handoff; fast URANS starts automatically"
            >
              <ArrowRight size={11} strokeWidth={2} />
              <small>normal handoff</small>
            </span>
          </div>
          <div className="shared-stage" data-flow-stage="fast">
            <CircleDot size={15} strokeWidth={1.8} aria-hidden />
            <span>
              <strong>FAST URANS</strong>
              <small>preliminary</small>
            </span>
          </div>
          <span className="shared-arrow">
            <ArrowRight size={14} strokeWidth={1.7} aria-hidden />
          </span>
          <div className="shared-stage" data-flow-stage="final">
            <ShieldCheck size={15} strokeWidth={1.8} aria-hidden />
            <span>
              <strong>FINAL URANS</strong>
              <small>verify</small>
            </span>
          </div>
        </div>
        <span className="guide-label now">RESULT</span>
        <span className="sr-only">Technical details</span>
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
              (view.ransStage === "not_started" && !view.critical) ||
              view.ransHandoffPending ||
              view.finalAutomaticNext ||
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
                : view.finalState === "accepted" || view.statusTone === "teal"
                  ? "is-verified"
                  : "";
            const currentStage = preliminaryOutcomeCurrentStage(item);
            const ransDidHandoff =
              view.ransStage === "screened" &&
              !view.ransAcceptedResult &&
              item.criticalStage !== "preflight" &&
              item.criticalStage !== "rans";
            const ransConnectorClass =
              item.criticalStage === "preflight" ||
              item.criticalStage === "rans"
                ? "critical"
                : view.ransStage === "not_started"
                  ? "active"
                  : view.ransAcceptedResult
                    ? "skipped"
                    : ransDidHandoff
                      ? "handoff"
                      : view.ransStage === "polar_handoff"
                        ? "polar_handoff"
                        : "skipped";
            return (
              <li
                key={`${item.aoaDeg}:${item.sourceAoaDeg}`}
                className={`outcome-row ${rowClass}`}
                data-testid={`cell-preliminary-outcome-${item.aoaDeg}`}
                data-current-stage={currentStage}
                data-rans-stage={view.ransStage}
                data-critical-stage={view.incidentStage ?? undefined}
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
                  aria-label={`${label}: RANS ${view.ransLabel.toLowerCase()}, ${view.ransProvenanceLabel}; fast URANS ${view.fastLabel.toLowerCase()}, ${view.fastProvenanceLabel}; final URANS ${view.finalLabel.toLowerCase()}, ${view.finalProvenanceLabel}`}
                >
                  <SolverStageNode
                    className={`stage-node ${
                      item.criticalStage === "preflight" ||
                      item.criticalStage === "rans"
                        ? "critical"
                        : ransDidHandoff
                          ? "handoff"
                          : view.ransStage
                    }`}
                    testId={`cell-preliminary-rans-${item.aoaDeg}`}
                    current={currentStage === "rans"}
                    title={
                      item.criticalStage === "preflight"
                        ? "RANS: not started; automatic mesh/runtime repair is critical"
                        : item.criticalStage === "rans"
                          ? "RANS: evidence recorded; a machine fault exhausted system recovery before FAST URANS"
                          : ransDidHandoff
                            ? "RANS: screened; normal handoff to fast URANS, which starts automatically"
                            : `RANS: ${view.ransLabel}`
                    }
                  >
                    {item.criticalStage === "preflight" ||
                    item.criticalStage === "rans" ? (
                      <ShieldAlert size={16} strokeWidth={1.9} aria-hidden />
                    ) : ransDidHandoff ? (
                      <ArrowRight size={15} strokeWidth={1.9} aria-hidden />
                    ) : view.ransStage === "screened" ? (
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
                      view.ransStage === "screened" &&
                      view.fastState === "not_started" &&
                      view.finalState === "not_started"
                        ? view.ransAcceptedResult
                          ? "skipped"
                          : ""
                        : view.finalAutomaticNext
                          ? "active"
                          : view.fastState === "critical"
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
                      view.finalState === "critical"
                        ? "critical"
                        : view.finalAutomaticNext
                          ? "automatic-next"
                          : item.finalComparison === "disagreed"
                            ? "comparison-warning"
                            : item.finalActivityState === "critical"
                              ? "update-warning"
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

                <div
                  className="row-result"
                  role="group"
                  aria-label={
                    view.critical
                      ? `${view.statusLabel}; ${view.incidentLabel}; system-owned incident; engineering investigation required`
                      : view.statusLabel
                  }
                >
                  <span className={`row-status ${view.statusTone}`}>
                    {view.statusLabel}
                  </span>
                  {view.incidentLabel && (
                    <span
                      className="system-incident-marker"
                      data-testid={`cell-preliminary-incident-${item.aoaDeg}`}
                      title={`${view.incidentLabel}; system-owned incident; engineering investigation required`}
                    >
                      <ShieldAlert size={10} strokeWidth={2.2} aria-hidden />
                      SYSTEM
                    </span>
                  )}
                </div>

                <details
                  className="diagnostics"
                  data-testid={`cell-preliminary-diagnostics-${item.aoaDeg}`}
                >
                  <summary
                    aria-label={`Stage evidence for ${label}`}
                    title={`Stage evidence for ${label}`}
                  >
                    <Info size={13} strokeWidth={1.7} aria-hidden />
                    <ChevronDown size={11} strokeWidth={1.7} aria-hidden />
                  </summary>
                  <div className="detail-body">
                    <div
                      className="stage-evidence-grid"
                      aria-label={`Solver stage history for ${label}`}
                    >
                      <div className="stage-evidence" data-detail-stage="rans">
                        <span
                          className={`detail-stage-icon ${
                            item.criticalStage === "preflight" ||
                            item.criticalStage === "rans"
                              ? "critical"
                              : ransDidHandoff
                                ? "handoff"
                                : view.ransAcceptedResult
                                  ? "accepted"
                                  : currentStage === "rans"
                                    ? "active"
                                    : ""
                          }`}
                          aria-hidden
                        >
                          {item.criticalStage === "preflight" ||
                          item.criticalStage === "rans" ? (
                            <ShieldAlert size={14} strokeWidth={1.9} />
                          ) : ransDidHandoff ||
                            view.ransStage === "polar_handoff" ? (
                            <ArrowRight size={14} strokeWidth={1.9} />
                          ) : view.ransAcceptedResult ? (
                            <CheckCircle2 size={14} strokeWidth={1.9} />
                          ) : (
                            <CircleDot size={14} strokeWidth={1.9} />
                          )}
                        </span>
                        <span className="detail-stage-copy">
                          <strong>RANS SCREEN</strong>
                          <span>{view.ransLabel}</span>
                          <small>{view.ransProvenanceLabel}</small>
                        </span>
                      </div>
                      <div className="stage-evidence" data-detail-stage="fast">
                        <span
                          className={`detail-stage-icon ${
                            view.fastState === "critical"
                              ? "critical"
                              : view.fastState === "accepted"
                                ? "accepted"
                                : currentStage === "fast"
                                  ? "active"
                                  : ""
                          }`}
                          aria-hidden
                        >
                          <FastStageIcon state={view.fastState} />
                        </span>
                        <span className="detail-stage-copy">
                          <strong>FAST URANS</strong>
                          <span>{view.fastLabel}</span>
                          <small>{view.fastProvenanceLabel}</small>
                        </span>
                      </div>
                      <div className="stage-evidence" data-detail-stage="final">
                        <span
                          className={`detail-stage-icon ${
                            view.finalState === "critical"
                              ? "critical"
                              : view.finalState === "accepted"
                                ? "accepted"
                                : currentStage === "final"
                                  ? "active"
                                  : ""
                          }`}
                          aria-hidden
                        >
                          <FinalStageIcon
                            state={view.finalState}
                            activityState={item.finalActivityState}
                            disagreed={item.finalComparison === "disagreed"}
                          />
                        </span>
                        <span className="detail-stage-copy">
                          <strong>FINAL URANS</strong>
                          <span>{view.finalLabel}</span>
                          <small>{view.finalProvenanceLabel}</small>
                        </span>
                      </div>
                    </div>
                    {view.critical && (
                      <div className="incident-banner" role="alert">
                        <ShieldAlert size={15} strokeWidth={1.9} aria-hidden />
                        <strong>
                          SYSTEM INCIDENT · ENGINEERING INVESTIGATION REQUIRED
                        </strong>
                        <span>{view.incidentLabel ?? view.statusLabel}</span>
                      </div>
                    )}
                    <details className="technical-evidence">
                      <summary>
                        Technical evidence
                        <ChevronDown size={11} strokeWidth={1.7} aria-hidden />
                      </summary>
                      <div className="technical-body">
                        <div
                          className="detail-summary"
                          data-testid={`cell-preliminary-detail-summary-${item.aoaDeg}`}
                        >
                          <span className="rans-explanation">
                            {view.ransDiagnostic}
                          </span>
                          <span>{view.budgetLabel}</span>
                          <span>{view.evidenceLabel}</span>
                        </div>
                        <div className="detail-meta">
                          {item.recoverySubmissions > 0 && (
                            <span>{item.recoverySubmissions} submissions</span>
                          )}
                          {item.nonPhysicalSubmissions > 0 && (
                            <span>
                              {item.nonPhysicalSubmissions} before CFD
                            </span>
                          )}
                          {item.interruptedPhysicalRuns > 0 && (
                            <span>
                              {item.interruptedPhysicalRuns} interrupted
                              physical
                            </span>
                          )}
                          {item.legacyUransEvidenceRuns > 0 && (
                            <span>
                              {item.legacyUransEvidenceRuns} URANS tier
                              unrecorded
                            </span>
                          )}
                        </div>
                        {view.diagnostics.length > 0 && (
                          <ul className="diagnostic-list">
                            {view.diagnostics.map((diagnostic) => (
                              <li key={diagnostic}>{diagnostic}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
