"use client";

// Campaign detail page (spec §11, dashboard per approved design c19fd74a):
// ≤2-row header with truthful status line from the campaign × sweeper ×
// engine truth table (§12), Pause primary + "⋯" overflow for everything
// else (Requeue-rejected is GONE from the header — repair verbs live on the
// Points tab per point), legacy unavailable-evidence compatibility count
// linking to Points filtered needs_review, the 3-stage pipeline hero
// (steady → unsteady → verify), ONE progress bar (teal done / amber solving /
// violet awaiting-URANS / empty open) with an honest measured-rate ETA, the
// stats wall collapsed to one line + a "details" disclosure, restore
// suggestion, condition strip, virtualized coverage matrix, cell side panel,
// refinement board and the plan-edit / add-airfoils dialogs. Every number
// rendered here is a real counter from the API — no projections beyond the
// measured trailing-24h ingest, no calendar dates.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  type AdminCampaignAirfoilRow,
  type AdminCampaignConditionSummary,
  type AdminCampaignLane,
  type AdminCampaignSummary,
  type CampaignDuplicatePrefill,
  type CampaignLifecycleVerb,
  type CampaignProgressTotals,
  campaignVerb,
  forceReleaseCondition,
  getCampaign,
  getCampaignDuplicatePrefill,
  patchSweeper,
  restoreCondition,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { PROCESS_NOT_RUNNING_DETAIL, isProcessDead } from "@/lib/solver-state";
import type { CampaignPointsBucket } from "@/lib/point-history";
import {
  campaignPhaseBadge,
  campaignStatusLine,
  tierCountsLine,
} from "./campaign-status";
export { campaignStatusLine };
import { AddAirfoilsDialog } from "./AddAirfoilsDialog";
import {
  PIPELINE_STAGE_NOTES,
  assemblePipelineModel,
  progressBarSegments,
  stageEta,
  sweepChipLabel,
} from "./campaign-pipeline";
import { CellSidePanel, type CellPanelAirfoil } from "./CellSidePanel";
import { ConditionStrip, nextUpConditionId } from "./ConditionStrip";
import { CoverageMatrix } from "./CoverageMatrix";
import { PlanEditDialogs, type PlanEditMode } from "./PlanEditDialogs";
import { RefinementBoard } from "./RefinementBoard";
import { campaignRemediationCopy } from "./campaign-remediation";
import { fCount, ghostBtn, primaryBtn } from "./ui";
import { usePoll } from "./usePoll";

const PRIORITY_LABEL: Record<number, string> = {
  0: "Background",
  5: "Standard",
  8: "High",
};

const STATUS_CHIP_COLOR: Record<string, { color: string; border: string }> = {
  active: { color: "var(--aero-teal)", border: "var(--aero-teal-border)" },
  paused: { color: "var(--aero-amber)", border: "rgba(245,158,11,0.45)" },
  attention: { color: "var(--aero-red-text)", border: "rgba(245,101,101,0.5)" },
  completed: { color: "var(--aero-teal)", border: "var(--aero-teal-border)" },
  cancelled: { color: "var(--aero-muted)", border: "var(--aero-stroke)" },
  archived: { color: "var(--aero-dim)", border: "var(--aero-stroke)" },
};

interface CellPanelState {
  airfoil: CellPanelAirfoil;
  condition: AdminCampaignConditionSummary;
  cell: CampaignProgressTotals | null;
}

export function CampaignDetail({
  campaignId,
  onBack,
  onDuplicate,
  onOpenPoints,
}: {
  campaignId: string;
  onBack: () => void;
  onDuplicate: (prefill: CampaignDuplicatePrefill) => void;
  /** Opens Solver ▸ Points pre-filtered to this campaign + bucket. */
  onOpenPoints: (status: CampaignPointsBucket) => void;
}) {
  const [summary, setSummary] = useState<AdminCampaignSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyConditionId, setBusyConditionId] = useState<string | null>(null);

  const [planEditMode, setPlanEditMode] = useState<PlanEditMode | null>(null);
  // Details disclosure state is URL-owned (?cdetails=1 — spec §11 "search
  // params are the single source of truth"; same replaceState mechanism as
  // the finished-job log's ?flog=1): back/reload/shared links land with the
  // stats wall in the state the admin left it.
  const searchParams = useSearchParams();
  const detailsOpen = searchParams.get("cdetails") === "1";
  const setDetailsOpen = useCallback((updater: (v: boolean) => boolean) => {
    const params = new URLSearchParams(window.location.search);
    const next = updater(params.get("cdetails") === "1");
    if (next) params.set("cdetails", "1");
    else params.delete("cdetails");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, []);
  const [addAirfoilsOpen, setAddAirfoilsOpen] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [forceReleaseTarget, setForceReleaseTarget] =
    useState<AdminCampaignConditionSummary | null>(null);
  const [cellPanel, setCellPanel] = useState<CellPanelState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [knownAirfoilIds, setKnownAirfoilIds] = useState<string[]>([]);
  const [enablingSweeper, setEnablingSweeper] = useState(false);

  const stripRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getCampaign(campaignId);
      setSummary(next);
      setLoadError(null);
      setPollKey((k) => k + 1);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [campaignId]);

  usePoll(refresh, 10_000);

  // Escape closes dialogs first, then the side panel (spec §11 routing:
  // Escape/Back close the side panel before leaving the page). The cell
  // panel's own capture-phase handler runs first when it is open (it stops
  // propagation, so this handler never fires while the panel consumes it).
  // With nothing left to close, Escape leaves the page back to the hub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (planEditMode) setPlanEditMode(null);
      else if (addAirfoilsOpen) setAddAirfoilsOpen(false);
      else if (cancelConfirm) setCancelConfirm(false);
      else if (forceReleaseTarget) setForceReleaseTarget(null);
      else {
        // Leaving the page is more destructive than closing a dialog: never
        // do it while a stacked dialog is open or while typing in a field
        // (Escape there means "abandon this input", not "leave the page").
        const t = e.target as HTMLElement | null;
        const typing =
          !!t &&
          (t.tagName === "INPUT" ||
            t.tagName === "TEXTAREA" ||
            t.tagName === "SELECT" ||
            t.isContentEditable);
        if (
          !typing &&
          !document.querySelector('[role="dialog"][aria-modal="true"]')
        )
          onBack();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    planEditMode,
    addAirfoilsOpen,
    cancelConfirm,
    forceReleaseTarget,
    onBack,
  ]);

  const runVerb = async (verb: CampaignLifecycleVerb) => {
    setBusyAction(verb);
    setNotice(null);
    try {
      await campaignVerb(campaignId, verb);
      await refresh();
      setNotice(
        verb === "pause"
          ? "campaign paused — claimed pending rows are frozen"
          : verb === "resume"
            ? "campaign resumed"
            : verb === "cancel"
              ? "campaign cancelled — solved evidence kept"
              : verb === "close-with-failures"
                ? "closed with failures recorded"
                : summary?.campaign.status === "archived"
                  ? "campaign unarchived"
                  : "campaign archived",
      );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusyAction(null);
      setCancelConfirm(false);
      setOverflowOpen(false);
    }
  };

  const duplicate = async () => {
    setBusyAction("duplicate");
    try {
      onDuplicate(await getCampaignDuplicatePrefill(campaignId));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusyAction(null);
      setOverflowOpen(false);
    }
  };

  const doForceRelease = async (condition: AdminCampaignConditionSummary) => {
    setBusyConditionId(condition.id);
    setNotice(null);
    try {
      const res = await forceReleaseCondition(campaignId, condition.id, {
        expectedCancelledPoints: condition.counters.remaining,
      });
      setNotice(
        `condition force-released — ${fCount(res.cancelledPoints)} pending point${res.cancelledPoints === 1 ? "" : "s"} cancelled; solved evidence kept`,
      );
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusyConditionId(null);
      setForceReleaseTarget(null);
    }
  };

  const doRestore = async (condition: AdminCampaignConditionSummary) => {
    setBusyConditionId(condition.id);
    setNotice(null);
    try {
      await restoreCondition(campaignId, condition.id);
      setNotice("condition restored — the dataset closes over it again");
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusyConditionId(null);
    }
  };

  const openCellFromLane = useCallback(
    (lane: AdminCampaignLane) => {
      const condition = summary?.conditions.find(
        (c) => c.id === lane.conditionId,
      );
      if (!condition) return;
      setCellPanel({
        airfoil: {
          airfoilId: lane.airfoilId,
          slug: lane.airfoilSlug,
          name: lane.airfoilName,
        },
        condition,
        cell: null,
      });
    },
    [summary?.conditions],
  );

  const openCellFromMatrix = useCallback(
    (
      row: AdminCampaignAirfoilRow,
      condition: AdminCampaignConditionSummary,
      cell: CampaignProgressTotals | null,
    ) => {
      setCellPanel({
        airfoil: {
          airfoilId: row.airfoilId,
          slug: row.slug,
          name: row.name,
          isSymmetric: row.isSymmetric,
        },
        condition,
        cell,
      });
      setKnownAirfoilIds((prev) =>
        prev.includes(row.airfoilId) ? prev : [...prev, row.airfoilId],
      );
    },
    [],
  );

  // ---- not found / loading ----
  if (loadError && !summary) {
    const notFound = loadError.includes("not found");
    return (
      <div
        data-testid="campaign-not-found"
        style={{
          display: "grid",
          gap: 12,
          justifyItems: "start",
          padding: "30px 0",
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 13,
            color: notFound ? C.text : C.red,
          }}
        >
          {notFound
            ? "This campaign does not exist (or was purged)."
            : loadError}
        </div>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← back to campaigns
        </button>
      </div>
    );
  }
  if (!summary) {
    return (
      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          color: C.dim,
          padding: "30px 0",
        }}
      >
        loading campaign…
      </div>
    );
  }

  const { campaign, totals, scheduler, rate, conditions } = summary;
  const status = campaign.status;
  const line = campaignStatusLine(summary);
  const lineColor =
    line.tone === "teal"
      ? C.teal
      : line.tone === "amber"
        ? C.amber
        : line.tone === "red"
          ? C.redText
          : line.tone === "violet"
            ? C.violet
            : C.dim;
  const statusChip = STATUS_CHIP_COLOR[status] ?? STATUS_CHIP_COLOR.active;
  // Fidelity ladder phase (contract 7): rendered only while nothing blocks —
  // the liveness-split gate badge always outranks the phase.
  const phaseBadge = campaignPhaseBadge(summary.phase, status, line.gate);
  const tiersLine = tierCountsLine(summary.tierCounts);

  const objectives = campaign.plan.objectives;
  const editable = ["active", "paused", "attention", "completed"].includes(
    status,
  );
  const gainedEvidence = conditions.filter((c) => c.gainedEvidenceAfterRelease);
  // ---- dashboard hero models (approved design c19fd74a) — every input is a
  // real payload counter; the pure assembly lives in campaign-pipeline.ts ----
  const reviewBuckets = summary.reviewBuckets ?? null;
  const needsReview = reviewBuckets?.needsReview ?? 0;
  const blocked = totals.blocked ?? 0;
  const remediationCopy = campaignRemediationCopy(summary.remediation);
  const pipeline = assemblePipelineModel({
    tierCounts: summary.tierCounts ?? null,
    reviewBuckets,
    phase: summary.phase,
    jobsRunning: scheduler.campaignJobsRunning,
  });
  const barSegments = progressBarSegments(totals, reviewBuckets);
  const eta = stageEta({
    phase: summary.phase,
    stageOpenByPhase: summary.tierCounts
      ? {
          ransOpen: summary.tierCounts.ransOpen,
          unsteadyOpen:
            summary.tierCounts.precalcOpen +
            (reviewBuckets?.awaitingUrans ?? 0),
          verifyOpen: summary.tierCounts.verifyOpen,
        }
      : null,
    rate: rate
      ? { pointsLast24h: rate.pointsLast24h, measuredSince: rate.measuredSince }
      : null,
  });
  const sweepChip = sweepChipLabel(campaign.plan.baseSweep);
  const nextUpId = nextUpConditionId(
    conditions,
    status === "active" &&
      !isProcessDead(scheduler.heartbeatAt) &&
      scheduler.sweeperEnabled &&
      scheduler.engineHealthy &&
      !scheduler.diskAdmissionBlocked &&
      !scheduler.engineUnreachableSince,
  );
  const hasLanes = Object.keys(summary.lanesSummary).length > 0;

  // ---- actions (approved design D): ONE visible primary lifecycle action
  // (Pause/Resume) + a "⋯" overflow with everything else at every width.
  // Requeue-rejected is gone from the header — per-point repair verbs live on
  // the Points tab (needs-review chip → filtered view). ----
  interface ActionDef {
    key: string;
    label: string;
    tone?: "primary" | "amber" | "red";
    onClick: () => void;
    testId: string;
  }
  const primaryAction: ActionDef | null =
    status === "active" || status === "attention"
      ? {
          key: "pause",
          label: busyAction === "pause" ? "pausing…" : "Pause",
          onClick: () => void runVerb("pause"),
          testId: "campaign-action-pause",
        }
      : status === "paused"
        ? {
            key: "resume",
            label: busyAction === "resume" ? "resuming…" : "Resume",
            tone: "primary",
            onClick: () => void runVerb("resume"),
            testId: "campaign-action-resume",
          }
        : null;
  const menuActions: ActionDef[] = [];
  if (editable) {
    menuActions.push(
      {
        key: "edit-angle",
        label: "Edit angle plan",
        onClick: () => setPlanEditMode("angle"),
        testId: "campaign-action-edit-angle",
      },
      {
        key: "edit-conditions",
        label: "Edit conditions",
        onClick: () => setPlanEditMode("conditions"),
        testId: "campaign-action-edit-conditions",
      },
      {
        key: "add-airfoils",
        label: "Add airfoils",
        onClick: () => setAddAirfoilsOpen(true),
        testId: "campaign-action-add-airfoils",
      },
    );
  }
  menuActions.push({
    key: "duplicate",
    label: busyAction === "duplicate" ? "preparing…" : "Duplicate",
    onClick: () => void duplicate(),
    testId: "campaign-action-duplicate",
  });
  if (status === "attention") {
    menuActions.push({
      key: "close-with-failures",
      label:
        busyAction === "close-with-failures"
          ? "closing…"
          : `Close with failures (${fCount(totals.failed)})`,
      tone: "amber",
      onClick: () => void runVerb("close-with-failures"),
      testId: "campaign-action-close-with-failures",
    });
  }
  if (["active", "paused", "attention"].includes(status)) {
    menuActions.push({
      key: "cancel",
      label: "Cancel…",
      tone: "red",
      onClick: () => setCancelConfirm(true),
      testId: "campaign-action-cancel",
    });
  }
  if (["completed", "cancelled"].includes(status)) {
    menuActions.push({
      key: "archive",
      label: busyAction === "archive" ? "archiving…" : "Archive",
      onClick: () => void runVerb("archive"),
      testId: "campaign-action-archive",
    });
  }
  if (status === "archived") {
    menuActions.push({
      key: "unarchive",
      label: busyAction === "archive" ? "restoring…" : "Unarchive",
      onClick: () => void runVerb("archive"),
      testId: "campaign-action-unarchive",
    });
  }

  const actionButton = (a: ActionDef, fullWidth = false) => (
    <button
      key={a.key}
      type="button"
      data-testid={a.testId}
      disabled={busyAction != null}
      onClick={a.onClick}
      style={{
        ...(a.tone === "primary" ? primaryBtn(busyAction != null) : ghostBtn),
        ...(a.tone === "amber" ? { color: C.amber } : {}),
        ...(a.tone === "red"
          ? { color: C.redText, borderColor: "rgba(245,101,101,0.45)" }
          : {}),
        padding: "6px 12px",
        fontSize: 11,
        opacity: busyAction != null ? 0.6 : 1,
        ...(fullWidth ? { width: "100%", textAlign: "left" as const } : {}),
      }}
    >
      {a.label}
    </button>
  );

  return (
    <div data-testid="campaign-detail" style={{ display: "grid", gap: 14 }}>
      {/* ---- header row 1: identity ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          data-testid="campaign-back"
          aria-label="Back to campaigns"
          onClick={() => {
            // §11 routing order: Back closes the matrix side panel first;
            // only a second Back leaves the campaign page.
            if (cellPanel) setCellPanel(null);
            else onBack();
          }}
          style={{ ...ghostBtn, padding: "5px 10px" }}
        >
          ←
        </button>
        <h2
          style={{
            margin: 0,
            fontSize: 19,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: C.text,
          }}
        >
          {campaign.name}
        </h2>
        {/* Gate badge is PRIMARY while a scheduler gate blocks work (mockup
            fec7b453 screen 3): never an "Active" headline next to a
            contradictory red line — the lifecycle demotes to a small chip. */}
        {line.gate && (
          <span
            data-testid="campaign-gate-badge"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: line.gate.tone === "red" ? C.redText : C.amber,
              background:
                line.gate.tone === "red"
                  ? "rgba(245,101,101,0.08)"
                  : "rgba(245,158,11,0.08)",
              border: `1px solid ${line.gate.tone === "red" ? "rgba(245,101,101,0.5)" : "rgba(245,158,11,0.45)"}`,
              borderRadius: 999,
              padding: "3px 10px",
            }}
          >
            {line.gate.text}
          </span>
        )}
        <span
          data-testid="campaign-status-chip"
          style={
            line.gate
              ? {
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  color: C.dim,
                  border: `1px solid ${C.stroke}`,
                  borderRadius: 999,
                  padding: "2px 8px",
                }
              : {
                  fontFamily: MONO,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  color: statusChip.color,
                  border: `1px solid ${statusChip.border}`,
                  borderRadius: 999,
                  padding: "3px 9px",
                }
          }
        >
          {status.toUpperCase()}
        </span>
        {phaseBadge && (
          <span
            data-testid="campaign-phase-badge"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.06em",
              color: phaseBadge.tone === "amber" ? C.amber : C.teal,
              border: `1px solid ${phaseBadge.tone === "amber" ? "rgba(245,158,11,0.45)" : "var(--aero-teal-border)"}`,
              borderRadius: 999,
              padding: "3px 10px",
            }}
          >
            {phaseBadge.label}
          </span>
        )}
        {/* The legacy needsReview wire count is rendered as unavailable evidence.
            It never promises a routine human-adjudication workflow. */}
        {needsReview > 0 && (
          <button
            type="button"
            data-testid="campaign-needs-review-chip"
            title="Open unavailable evidence in the Points explorer"
            onClick={() => onOpenPoints("needs_review")}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: C.redText,
              background: "rgba(245,101,101,0.08)",
              border: "1px solid rgba(245,101,101,0.5)",
              borderRadius: 999,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            unavailable · {fCount(needsReview)}
          </button>
        )}
        {blocked > 0 && remediationCopy && (
          <button
            type="button"
            data-testid="campaign-blocked-chip"
            title={remediationCopy.title}
            onClick={() => setDetailsOpen(() => true)}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: C.amber,
              background: "rgba(245,158,11,0.08)",
              border: "1px solid rgba(245,158,11,0.45)",
              borderRadius: 999,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            {remediationCopy.label} · {fCount(blocked)}
          </button>
        )}
      </div>

      {/* ---- header row 2: truthful status + actions ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          data-testid="campaign-status-line"
          style={{ fontFamily: MONO, fontSize: 11.5, color: lineColor }}
        >
          {line.text}
        </span>
        {/* Enabling the sweeper flag while the process is dead would be a
            fake control — guidance text renders instead (approved design). */}
        {status === "active" && isProcessDead(scheduler.heartbeatAt) && (
          <span
            data-testid="campaign-solver-guidance"
            style={{ fontFamily: MONO, fontSize: 10, color: C.redText }}
          >
            {PROCESS_NOT_RUNNING_DETAIL}
          </span>
        )}
        {status === "active" &&
          !isProcessDead(scheduler.heartbeatAt) &&
          !scheduler.sweeperEnabled &&
          !scheduler.engineUnreachableSince && (
            <button
              type="button"
              data-testid="campaign-enable-sweeper"
              disabled={enablingSweeper}
              onClick={async () => {
                setEnablingSweeper(true);
                try {
                  await patchSweeper({ enabled: true });
                  await refresh();
                } catch {
                  // refresh() surfaces state truthfully on the next poll; the
                  // button re-enables so the action can be retried.
                } finally {
                  setEnablingSweeper(false);
                }
              }}
              style={{
                ...ghostBtn,
                color: C.amber,
                borderColor: "rgba(245,165,36,.45)",
                padding: "3px 9px",
                fontSize: 10,
              }}
            >
              {enablingSweeper ? "enabling…" : "enable sweeper"}
            </button>
          )}
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          {primaryAction && actionButton(primaryAction)}
          <span
            style={{ position: "relative", display: "inline-block" }}
            onBlur={(e) => {
              const next = e.relatedTarget;
              if (!(next instanceof Node) || !e.currentTarget.contains(next))
                setOverflowOpen(false);
            }}
          >
            <button
              type="button"
              data-testid="campaign-actions-overflow"
              aria-label="More campaign actions"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
              style={{ ...ghostBtn, padding: "6px 12px", fontSize: 11 }}
            >
              ⋯
            </button>
            {overflowOpen && (
              <span
                style={{
                  position: "absolute",
                  right: 0,
                  top: "calc(100% + 4px)",
                  zIndex: 30,
                  minWidth: 220,
                  background: C.popover,
                  border: `1px solid ${C.stroke}`,
                  borderRadius: 8,
                  boxShadow: `0 12px 28px ${C.shadow}`,
                  padding: 6,
                  display: "grid",
                  gap: 4,
                }}
              >
                {menuActions.map((a) => actionButton(a, true))}
              </span>
            )}
          </span>
        </span>
      </div>

      {notice && (
        <div
          data-testid="campaign-notice"
          style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber }}
        >
          {notice}
        </div>
      )}
      {loadError && summary && (
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red }}>
          poll failed: {loadError}
        </div>
      )}

      {/* ---- 3-stage pipeline hero (approved design c19fd74a) ---- */}
      {pipeline && (
        <div
          data-testid="campaign-pipeline"
          style={{
            background: C.panel,
            border: `1px solid ${C.border}`,
            borderRadius: 12,
            padding: "12px 14px",
            display: "flex",
            gap: 8,
            alignItems: "stretch",
            flexWrap: "wrap",
          }}
        >
          {pipeline.stages.map((stage, i) => (
            <div
              key={stage.key}
              style={{
                display: "flex",
                alignItems: "stretch",
                gap: 8,
                flex: "1 1 180px",
                minWidth: 0,
              }}
            >
              {i > 0 && (
                <span
                  aria-hidden
                  style={{
                    alignSelf: "center",
                    fontFamily: MONO,
                    fontSize: 12,
                    color: C.dimmer,
                  }}
                >
                  →
                </span>
              )}
              <div
                data-testid={`campaign-stage-${stage.key}`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: `1px solid ${stage.active ? "var(--aero-teal-border)" : C.borderSoft}`,
                  background: stage.active ? C.tealFill : "transparent",
                  borderRadius: 9,
                  padding: "8px 10px",
                  display: "grid",
                  gap: 3,
                  alignContent: "start",
                  opacity: stage.settled && !stage.active ? 0.65 : 1,
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9.5,
                    letterSpacing: "0.08em",
                    color: stage.active ? C.teal : C.dim,
                  }}
                >
                  {stage.title.toUpperCase()}
                </span>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: stage.settled || stage.open === 0 ? C.dim : C.text,
                  }}
                >
                  {/* "—" = not started (upstream stages still feed this one);
                      "settled ✓" only when nothing can arrive any more. */}
                  {stage.settled
                    ? "settled ✓"
                    : stage.open === 0
                      ? "—"
                      : (stage.detail ?? `${fCount(stage.open)} open`)}
                </span>
                {stage.active && pipeline.jobsRunning > 0 && (
                  <span
                    style={{ fontFamily: MONO, fontSize: 9.5, color: C.amber }}
                  >
                    {fCount(pipeline.jobsRunning)} job
                    {pipeline.jobsRunning === 1 ? "" : "s"} solving now
                  </span>
                )}
                {PIPELINE_STAGE_NOTES[stage.key] && (
                  <span
                    style={{ fontFamily: MONO, fontSize: 9, color: C.dimmest }}
                  >
                    {PIPELINE_STAGE_NOTES[stage.key]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- ONE progress bar + one-line stats + details disclosure ---- */}
      <div
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "12px 14px",
          display: "grid",
          gap: 8,
        }}
      >
        <div
          data-testid="campaign-progress-bar"
          style={{
            height: 8,
            background: C.panel3,
            borderRadius: 5,
            overflow: "hidden",
            display: "flex",
          }}
          aria-hidden
        >
          <span
            style={{
              width: `${barSegments.done * 100}%`,
              background: C.teal,
              display: "block",
            }}
          />
          <span
            style={{
              width: `${barSegments.solving * 100}%`,
              background: C.amber,
              display: "block",
            }}
          />
          <span
            style={{
              width: `${barSegments.awaitingUrans * 100}%`,
              background: C.violet,
              display: "block",
            }}
          />
          <span
            style={{
              width: `${barSegments.blocked * 100}%`,
              background: C.amber,
              display: "block",
            }}
          />
          {/* remainder of the track = open work (panel background) */}
        </div>
        <div
          data-testid="campaign-counts-line"
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: C.muted,
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={{ color: C.teal }}>
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: 2,
                background: C.teal,
                marginRight: 4,
                verticalAlign: -1,
              }}
            />
            {fCount(barSegments.doneCount)} done
          </span>
          {barSegments.solvingCount > 0 && (
            <span style={{ color: C.amber }}>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: C.amber,
                  marginRight: 4,
                  verticalAlign: -1,
                }}
              />
              {fCount(barSegments.solvingCount)} solving
            </span>
          )}
          {/* Calm violet stage-2 queue link (never red, no repair verbs):
              opens Solver ▸ Points filtered to awaiting_urans. */}
          {barSegments.awaitingCount > 0 && (
            <button
              type="button"
              data-testid="campaign-awaiting-urans-link"
              title="Tier-1 rejects queued for the unsteady re-solve — open them in the Points explorer"
              onClick={() => onOpenPoints("awaiting_urans")}
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.violet,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: C.violet,
                  marginRight: 4,
                  verticalAlign: -1,
                }}
              />
              {fCount(barSegments.awaitingCount)} awaiting URANS
            </button>
          )}
          {barSegments.blockedCount > 0 && remediationCopy && (
            <button
              type="button"
              data-testid="campaign-blocked-count"
              title={remediationCopy.title}
              onClick={() => setDetailsOpen(() => true)}
              style={{
                color: C.amber,
                fontFamily: MONO,
                fontSize: 10.5,
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: C.amber,
                  marginRight: 4,
                  verticalAlign: -1,
                }}
              />
              {fCount(barSegments.blockedCount)} {remediationCopy.label}
            </button>
          )}
          <span>
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 7,
                height: 7,
                borderRadius: 2,
                background: C.panel3,
                border: `1px solid ${C.stroke}`,
                marginRight: 4,
                verticalAlign: -1,
              }}
            />
            {fCount(barSegments.openCount)} open of {fCount(totals.requested)}
          </span>
          {eta && (
            <span
              data-testid="campaign-eta"
              style={{ color: C.dim }}
              title="From the measured trailing-24h ingest rate — hidden while the rate is unstable"
            >
              {eta.label} to finish stage {eta.stage}
            </span>
          )}
          <button
            type="button"
            data-testid="campaign-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              color: C.teal,
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            {detailsOpen ? "▾ details" : "▸ details"}
          </button>
        </div>
        {detailsOpen && (
          <div
            data-testid="campaign-details"
            style={{
              display: "grid",
              gap: 7,
              borderTop: `1px solid ${C.borderRow}`,
              paddingTop: 8,
            }}
          >
            <div
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.muted,
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <span style={{ color: C.teal }}>
                {fCount(totals.solved)} solved
              </span>
              {totals.derived > 0 && (
                <span title="derived by symmetry — not solver runs">
                  ◌ {fCount(totals.derived)} derived
                </span>
              )}
              {totals.failed > 0 && (
                <button
                  type="button"
                  data-testid="campaign-failed-link"
                  title="Crash-class failures (after the automatic retry) — open them in the Points explorer"
                  onClick={() => onOpenPoints("failed")}
                  style={{
                    fontFamily: MONO,
                    fontSize: 10.5,
                    color: C.redText,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  {fCount(totals.failed)} failed
                </button>
              )}
              {totals.superseded > 0 && (
                <span style={{ color: C.dim }}>
                  {fCount(totals.superseded)} superseded
                </span>
              )}
              <span>
                {fCount(totals.remaining)} remaining of{" "}
                {fCount(totals.requested)} points
              </span>
              <span style={{ color: C.dim }}>
                {fCount(summary.airfoilCount)} airfoils ·{" "}
                {fCount(
                  conditions.filter((c) => c.status !== "released").length,
                )}{" "}
                conditions
              </span>
            </div>
            {remediationCopy && (
              <div
                data-testid="campaign-remediation-detail"
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: C.text2,
                  border: "1px solid rgba(245,158,11,0.38)",
                  background: "rgba(245,158,11,0.06)",
                  borderRadius: 8,
                  padding: "8px 10px",
                  lineHeight: 1.5,
                }}
              >
                <span style={{ color: C.amber, fontWeight: 700 }}>
                  {fCount(blocked)} {remediationCopy.label}
                </span>
                {" — "}
                {remediationCopy.detail}
              </div>
            )}
            {tiersLine && (
              <div
                data-testid="campaign-tier-counts"
                style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}
                title="Fidelity ladder: RANS gaps, then precalc URANS, then full-fidelity verification"
              >
                {tiersLine}
              </div>
            )}
            {rate && (
              <div
                data-testid="campaign-rate-line"
                style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}
              >
                measured ingest: {fCount(rate.pointsLast24h)} solver points in
                the trailing 24 h · {fCount(rate.remainingPoints)} solver points
                of work remain
              </div>
            )}
            <div
              data-testid="campaign-plan-chips"
              style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.muted,
                  border: `1px solid ${C.stroke}`,
                  borderRadius: 999,
                  padding: "3px 9px",
                }}
              >
                polar sweep
              </span>
              {sweepChip && (
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.muted,
                    border: `1px solid ${C.stroke}`,
                    borderRadius: 999,
                    padding: "3px 9px",
                  }}
                >
                  {sweepChip}
                </span>
              )}
              {objectives.ldMax.enabled && (
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.muted,
                    border: `1px solid ${C.stroke}`,
                    borderRadius: 999,
                    padding: "3px 9px",
                  }}
                >
                  max L/D ±{objectives.ldMax.toleranceDeg}°
                </span>
              )}
              {objectives.clZero.enabled && (
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.muted,
                    border: `1px solid ${C.stroke}`,
                    borderRadius: 999,
                    padding: "3px 9px",
                  }}
                >
                  α₀ ±{objectives.clZero.toleranceDeg}°
                </span>
              )}
              {objectives.clMax?.enabled && (
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.muted,
                    border: `1px solid ${C.stroke}`,
                    borderRadius: 999,
                    padding: "3px 9px",
                  }}
                >
                  Cl_max ±{objectives.clMax.toleranceDeg}°
                </span>
              )}
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.dim,
                  border: `1px solid ${C.stroke}`,
                  borderRadius: 999,
                  padding: "3px 9px",
                }}
              >
                {PRIORITY_LABEL[campaign.priority] ??
                  `priority ${campaign.priority}`}
              </span>
            </div>
          </div>
        )}
        {gainedEvidence.length > 0 && (
          <button
            type="button"
            data-testid="campaign-restore-suggestion"
            onClick={() =>
              stripRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "center",
              })
            }
            style={{
              justifySelf: "start",
              fontFamily: MONO,
              fontSize: 10,
              color: C.amber,
              background: "rgba(245,158,11,0.06)",
              border: "1px solid rgba(245,158,11,0.4)",
              borderRadius: 999,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            {gainedEvidence.length === 1
              ? "1 released condition gained evidence after release — restore it to keep the dataset closed?"
              : `${gainedEvidence.length} released conditions gained evidence after release — restore them to keep the dataset closed?`}
          </button>
        )}
      </div>

      {/* ---- condition strip ---- */}
      {/* minWidth 0: as a grid item this wrapper's automatic minimum is the
          strip's min-content (all nowrap condition cards side by side, which
          can be thousands of px on set-valued campaigns); without it the grid
          track inflates and the strip's own overflowX:auto never engages —
          the whole PAGE scrolled horizontally (formal-ui critical,
          2026-07-07). */}
      <div ref={stripRef} style={{ minWidth: 0 }}>
        <ConditionStrip
          conditions={conditions}
          nextUpId={nextUpId}
          busyConditionId={busyConditionId}
          onForceRelease={(c) => setForceReleaseTarget(c)}
          onRestore={(c) => void doRestore(c)}
        />
      </div>

      {/* ---- coverage matrix ---- */}
      <CoverageMatrix
        campaignId={campaignId}
        conditions={conditions}
        airfoilCount={summary.airfoilCount}
        pollKey={pollKey}
        onCellClick={openCellFromMatrix}
      />

      {/* ---- refinement board (only when objective lanes exist) ---- */}
      {hasLanes && (
        <RefinementBoard
          campaignId={campaignId}
          lanesSummary={summary.lanesSummary}
          conditions={conditions}
          pollKey={pollKey}
          onOpenCell={openCellFromLane}
          onChanged={() => void refresh()}
        />
      )}

      {/* ---- side panel + dialogs ---- */}
      {cellPanel && (
        <CellSidePanel
          campaignId={campaignId}
          airfoil={cellPanel.airfoil}
          condition={cellPanel.condition}
          cell={cellPanel.cell}
          campaignCreatedAt={campaign.createdAt}
          onClose={() => setCellPanel(null)}
          onChanged={() => void refresh()}
        />
      )}

      {planEditMode && (
        <PlanEditDialogs
          mode={planEditMode}
          campaignId={campaignId}
          summary={summary}
          onClose={() => setPlanEditMode(null)}
          onApplied={(result) => {
            setNotice(
              `plan r${result.planRevisionNumber} applied — ${fCount(result.addedPoints)} added, ${fCount(result.cancelledPoints)} cancelled${result.reactivatedPoints > 0 ? `, ${fCount(result.reactivatedPoints)} reactivated` : ""}`,
            );
            void refresh();
          }}
          onRefreshSummary={refresh}
        />
      )}

      {addAirfoilsOpen && (
        <AddAirfoilsDialog
          campaignId={campaignId}
          conditions={conditions}
          knownIncludedIds={knownAirfoilIds}
          onClose={() => setAddAirfoilsOpen(false)}
          onApplied={(added, points) => {
            setNotice(
              `added ${fCount(added)} airfoil${added === 1 ? "" : "s"} — ${fCount(points)} points queued`,
            );
            void refresh();
          }}
        />
      )}

      {cancelConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Cancel campaign"
          data-testid="campaign-cancel-dialog"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: C.overlay,
            display: "grid",
            placeItems: "center",
            padding: 20,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCancelConfirm(false);
          }}
        >
          <div
            style={{
              background: C.modalBg,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              width: "min(460px, 94vw)",
              padding: 16,
              display: "grid",
              gap: 10,
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                color: C.redText,
              }}
            >
              CANCEL CAMPAIGN
            </span>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11.5,
                color: C.text,
                lineHeight: 1.55,
              }}
            >
              {fCount(totals.remaining)} pending point
              {totals.remaining === 1 ? "" : "s"} will be removed from the
              queue.
              {scheduler.campaignJobsRunning > 0
                ? ` ${fCount(scheduler.campaignJobsRunning)} running job${scheduler.campaignJobsRunning === 1 ? "" : "s"} will finish and ingest.`
                : ""}
              {totals.failed > 0
                ? ` ${fCount(totals.failed)} failed point${totals.failed === 1 ? "" : "s"} stay recorded.`
                : ""}{" "}
              All solved evidence, attempts and fits are kept. This cannot be
              undone.
            </span>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                type="button"
                onClick={() => setCancelConfirm(false)}
                style={ghostBtn}
              >
                keep running
              </button>
              <button
                type="button"
                data-testid="campaign-cancel-confirm"
                disabled={busyAction != null}
                onClick={() => void runVerb("cancel")}
                style={{
                  ...ghostBtn,
                  color: C.redText,
                  borderColor: "rgba(245,101,101,0.5)",
                  opacity: busyAction != null ? 0.6 : 1,
                }}
              >
                {busyAction === "cancel"
                  ? "cancelling…"
                  : `Cancel campaign — remove ${fCount(totals.remaining)} pending`}
              </button>
            </div>
          </div>
        </div>
      )}

      {forceReleaseTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Force-release condition"
          data-testid="force-release-dialog"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 60,
            background: C.overlay,
            display: "grid",
            placeItems: "center",
            padding: 20,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setForceReleaseTarget(null);
          }}
        >
          <div
            style={{
              background: C.modalBg,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              width: "min(460px, 94vw)",
              padding: 16,
              display: "grid",
              gap: 10,
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                color: C.redText,
              }}
            >
              FORCE-RELEASE CONDITION
            </span>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11.5,
                color: C.text,
                lineHeight: 1.55,
              }}
            >
              This blocked condition stops counting against completion.{" "}
              {fCount(forceReleaseTarget.counters.remaining)} pending point
              {forceReleaseTarget.counters.remaining === 1 ? "" : "s"} will be
              cancelled, {fCount(forceReleaseTarget.counters.failed)} failed
              point
              {forceReleaseTarget.counters.failed === 1 ? "" : "s"} stay
              recorded, and all solved evidence is kept. The release is recorded
              as a plan revision.
            </span>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                type="button"
                onClick={() => setForceReleaseTarget(null)}
                style={ghostBtn}
              >
                keep
              </button>
              <button
                type="button"
                data-testid="force-release-confirm"
                disabled={busyConditionId != null}
                onClick={() => void doForceRelease(forceReleaseTarget)}
                style={{
                  ...ghostBtn,
                  color: C.redText,
                  borderColor: "rgba(245,101,101,0.5)",
                  opacity: busyConditionId != null ? 0.6 : 1,
                }}
              >
                {busyConditionId
                  ? "releasing…"
                  : `Force-release — cancel ${fCount(forceReleaseTarget.counters.remaining)} pending`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
