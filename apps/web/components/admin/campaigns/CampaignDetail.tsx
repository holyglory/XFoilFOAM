"use client";

// Campaign detail page (spec §11, dashboard per approved design c19fd74a):
// ≤2-row header with truthful status line from the campaign × sweeper ×
// engine truth table (§12), Pause primary + "⋯" overflow for everything
// else (Requeue-rejected is GONE from the header — repair verbs live on the
// Points tab per point), legacy unavailable-evidence compatibility count
// linking to Points filtered needs_review, the 3-stage pipeline hero
// (steady → unsteady → verify), one live semicircular completion dial with
// an honest measured-rate ETA, the stats wall collapsed to three operational
// readouts + a "details" disclosure, restore
// suggestion, condition strip, virtualized coverage matrix, cell side panel,
// refinement board and the plan-edit / add-airfoils dialogs. Every number
// rendered here is a real counter from the API — no projections beyond the
// measured trailing-24h ingest, no calendar dates.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  MoreHorizontal,
  Pause,
  Play,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Wrench,
} from "lucide-react";

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
import { isProcessDead } from "@/lib/solver-state";
import type { CampaignPointsBucket } from "@/lib/point-history";
import { SolverIncidentPanel } from "../SolverIncidentPanel";
import {
  campaignInstrumentStatus,
  campaignStatusLine,
} from "./campaign-status";
export { campaignStatusLine };
import { AddAirfoilsDialog } from "./AddAirfoilsDialog";
import {
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
import { CampaignProgressGauge } from "./CampaignProgressGauge";
import { fCount, ghostBtn, primaryBtn } from "./ui";
import { usePoll } from "./usePoll";

const PRIORITY_LABEL: Record<number, string> = {
  0: "Background",
  5: "Standard",
  8: "High",
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
  const instrumentStatus = campaignInstrumentStatus(summary, line);
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
  const stageRailProgress = pipeline
    ? Math.min(2, pipeline.stages.filter((stage) => stage.settled).length)
    : 0;
  const barSegments = progressBarSegments(totals, reviewBuckets);
  const completionPercent =
    totals.requested > 0
      ? Math.min(100, (barSegments.doneCount / totals.requested) * 100)
      : 0;
  const completionPercentLabel =
    completionPercent > 0 && completionPercent < 0.01
      ? "<0.01%"
      : `${completionPercent < 1 ? completionPercent.toFixed(2) : completionPercent.toFixed(1)}%`;
  const throughputPerHour = rate
    ? Math.round(rate.pointsLast24h / rate.windowHours)
    : null;
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
        display: "inline-flex",
        alignItems: "center",
        justifyContent: fullWidth ? "flex-start" : "center",
        gap: 6,
        opacity: busyAction != null ? 0.6 : 1,
        ...(fullWidth ? { width: "100%", textAlign: "left" as const } : {}),
      }}
    >
      {!fullWidth && a.key === "pause" && <Pause size={13} aria-hidden />}
      {!fullWidth && a.key === "resume" && <Play size={13} aria-hidden />}
      {a.label}
    </button>
  );

  return (
    <div data-testid="campaign-detail" style={{ display: "grid", gap: 14 }}>
      {/* One identity line: campaign name is the only headline. */}
      <div className="campaign-instrument-title-row">
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
          className="campaign-instrument-icon-button"
        >
          <ChevronLeft size={18} aria-hidden />
        </button>
        <h2 className="campaign-instrument-title">{campaign.name}</h2>
        <span className="campaign-instrument-actions">
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
              className="campaign-instrument-icon-button"
            >
              <MoreHorizontal size={18} aria-hidden />
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

      {/* One operational ribbon replaces lifecycle, gate and phase badge
          repetition. The precise measured reason remains in the title. */}
      <div
        className={`campaign-instrument-status campaign-instrument-status-${instrumentStatus.tone}`}
        role="status"
        title={line.text}
      >
        <span data-testid={line.gate ? "campaign-gate-badge" : undefined}>
          {instrumentStatus.tone === "teal" ? (
            <ShieldCheck size={22} aria-hidden />
          ) : (
            <ShieldAlert size={22} aria-hidden />
          )}
        </span>
        <span className="campaign-instrument-status-copy">
          <strong data-testid="campaign-status-chip">
            {instrumentStatus.title}
          </strong>
          <span data-testid="campaign-status-line">
            {instrumentStatus.detail}
          </span>
        </span>
        {instrumentStatus.action === "enable_sweeper" && (
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
                // The next poll surfaces the unchanged state truthfully.
              } finally {
                setEnablingSweeper(false);
              }
            }}
            style={{ ...ghostBtn, marginLeft: "auto", whiteSpace: "nowrap" }}
          >
            {enablingSweeper ? "enabling…" : "Enable scheduling"}
          </button>
        )}
      </div>

      <SolverIncidentPanel
        summary={summary.solverIncidents}
        surface="campaign"
      />

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

      {/* The approved instrument is a real completion dial: exact arc fraction,
          calibrated ticks, no speedometer needle and no duplicate linear bar. */}
      <section
        data-testid="campaign-instrument-hero"
        className="campaign-instrument-hero"
        aria-label="Campaign progress"
      >
        <CampaignProgressGauge
          value={barSegments.doneCount}
          max={totals.requested}
          valueLabel={fCount(barSegments.doneCount)}
          stateLabel={totals.derived > 0 ? "points complete" : "solved"}
          totalLabel={fCount(totals.requested)}
          percentLabel={completionPercentLabel}
        />

        {pipeline && (
          <ol
            data-testid="campaign-stage-rail"
            className="campaign-instrument-stage-rail"
          >
            <progress
              data-testid="campaign-stage-connector"
              className="campaign-instrument-stage-connector"
              max={2}
              value={stageRailProgress}
              aria-hidden="true"
            />
            {pipeline.stages.map((stage, index) => (
              <li
                key={stage.key}
                data-testid={`campaign-stage-${stage.key}`}
                className={`campaign-instrument-stage ${stage.active ? "is-active" : ""} ${stage.settled ? "is-settled" : ""}`}
                aria-current={stage.active ? "step" : undefined}
              >
                <span
                  data-testid={`campaign-stage-node-${stage.key}`}
                  className="campaign-instrument-stage-node"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <strong
                  data-testid={
                    stage.active ? "campaign-phase-badge" : undefined
                  }
                >
                  {stage.key === "steady"
                    ? "RANS"
                    : stage.key === "unsteady"
                      ? "PRELIMINARY URANS"
                      : "VERIFY"}
                </strong>
                <span>
                  {stage.settled
                    ? "settled"
                    : stage.open === 0
                      ? "waiting"
                      : (stage.detail ?? `${fCount(stage.open)} open`)}
                </span>
              </li>
            ))}
          </ol>
        )}

        {/* Exactly three live readouts finish the primary instrument. Recovery
            and unavailable-evidence actions remain reachable in Details. */}
        <div
          data-testid="campaign-counts-line"
          className="campaign-instrument-metrics"
        >
          <div
            data-testid="campaign-metric-processing"
            className="campaign-instrument-metric campaign-instrument-metric-amber"
          >
            <Clock3 size={30} strokeWidth={1.6} aria-hidden />
            <span>
              <strong>{fCount(barSegments.solvingCount)}</strong>
              <small>processing</small>
            </span>
          </div>
          <div
            data-testid="campaign-metric-auto-repair"
            className="campaign-instrument-metric campaign-instrument-metric-violet"
          >
            <Wrench size={30} strokeWidth={1.6} aria-hidden />
            <span>
              <strong>{fCount(summary.remediation.repairing)}</strong>
              <small>auto-repair</small>
            </span>
          </div>
          <div
            data-testid="campaign-metric-throughput"
            className="campaign-instrument-metric campaign-instrument-metric-teal"
          >
            <TrendingUp size={30} strokeWidth={1.6} aria-hidden />
            <span>
              <strong>
                {throughputPerHour == null ? "—" : fCount(throughputPerHour)}
              </strong>
              <small>solver pts / h · 24 h avg</small>
              {eta && (
                <em
                  data-testid="campaign-eta"
                  title="From the measured trailing-24h ingest rate"
                >
                  ETA {eta.label} · stage {eta.stage}
                </em>
              )}
            </span>
          </div>
        </div>
        <div className="campaign-instrument-closing-rule" aria-hidden="true" />
      </section>

      <div className="campaign-instrument-lower">
        <button
          type="button"
          data-testid="campaign-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls="campaign-instrument-details"
          onClick={() => setDetailsOpen((v) => !v)}
          className="campaign-instrument-details-toggle"
        >
          {detailsOpen ? (
            <ChevronDown size={15} aria-hidden />
          ) : (
            <ChevronRight size={15} aria-hidden />
          )}
          Campaign details
        </button>
        <div
          id="campaign-instrument-details"
          data-testid="campaign-details"
          className="campaign-instrument-details"
          hidden={!detailsOpen}
        >
          <div className="campaign-instrument-detail-strip">
            <span>
              {fCount(summary.airfoilCount)} airfoils ·{" "}
              {fCount(conditions.filter((c) => c.status !== "released").length)}{" "}
              conditions
            </span>
            {totals.derived > 0 && (
              <span title="derived by symmetry — not solver runs">
                {fCount(totals.derived)} symmetry-derived
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
                  fontSize: 10,
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
          </div>
          {(barSegments.awaitingCount > 0 ||
            (barSegments.blockedCount > 0 && remediationCopy) ||
            needsReview > 0) && (
            <div
              data-testid="campaign-exception-actions"
              className="campaign-instrument-exceptions"
            >
              {barSegments.awaitingCount > 0 && (
                <button
                  type="button"
                  data-testid="campaign-awaiting-urans-link"
                  className="campaign-instrument-exception-action is-violet"
                  title="Open preliminary URANS work in the Points explorer"
                  onClick={() => onOpenPoints("awaiting_urans")}
                >
                  <CircleDot size={18} strokeWidth={1.6} aria-hidden />
                  <span>
                    <strong>{fCount(barSegments.awaitingCount)}</strong>
                    <small>awaiting URANS</small>
                  </span>
                </button>
              )}
              {barSegments.blockedCount > 0 && remediationCopy && (
                <div
                  data-testid="campaign-blocked-count"
                  className="campaign-instrument-exception-action is-red"
                  title={remediationCopy.title}
                >
                  <ShieldAlert size={18} strokeWidth={1.6} aria-hidden />
                  <span>
                    <strong>{fCount(barSegments.blockedCount)}</strong>
                    <small>{remediationCopy.label}</small>
                  </span>
                </div>
              )}
              {needsReview > 0 && (
                <button
                  type="button"
                  data-testid="campaign-needs-review-chip"
                  className="campaign-instrument-exception-action is-red"
                  title="Open unavailable evidence in the Points explorer"
                  onClick={() => onOpenPoints("needs_review")}
                >
                  <ShieldAlert size={18} strokeWidth={1.6} aria-hidden />
                  <span>
                    <strong>{fCount(needsReview)}</strong>
                    <small>unavailable evidence</small>
                  </span>
                </button>
              )}
            </div>
          )}
          {remediationCopy && (
            <div
              data-testid="campaign-remediation-detail"
              style={{
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.text2,
                border: "1px solid rgba(245,101,101,0.42)",
                background: "rgba(245,101,101,0.07)",
                borderRadius: 8,
                padding: "8px 10px",
                lineHeight: 1.5,
              }}
            >
              <span style={{ color: C.redText, fontWeight: 700 }}>
                {fCount(blocked)} {remediationCopy.label}
              </span>
              {" — "}
              {remediationCopy.detail}
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
              This condition will stop counting against completion.{" "}
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
