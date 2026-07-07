"use client";

// Campaign detail page (spec §11): ≤2-row header with truthful status line
// from the campaign × sweeper × engine truth table (§12), lifecycle actions
// (overflow menu <940), progress + measured-rate line, restore-suggestion
// chip, condition strip, virtualized coverage matrix, cell side panel,
// refinement board and the plan-edit / requeue / add-airfoils dialogs.
// Every number rendered here is a real counter from the API — no projections
// beyond the measured trailing-24h ingest, no calendar dates.

import { useCallback, useEffect, useRef, useState } from "react";

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
import { campaignPhaseBadge, campaignStatusLine, tierCountsLine } from "./campaign-status";
export { campaignStatusLine };
import { AddAirfoilsDialog } from "./AddAirfoilsDialog";
import { CellSidePanel, type CellPanelAirfoil } from "./CellSidePanel";
import { ConditionStrip, nextUpConditionId } from "./ConditionStrip";
import { CoverageMatrix } from "./CoverageMatrix";
import { PlanEditDialogs, type PlanEditMode } from "./PlanEditDialogs";
import { RefinementBoard } from "./RefinementBoard";
import { RequeueDialog } from "./RequeueDialog";
import { fCount, ghostBtn, primaryBtn } from "./ui";
import { usePoll } from "./usePoll";

const PRIORITY_LABEL: Record<number, string> = { 0: "Background", 5: "Standard", 8: "High" };

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
  onOpenPoints: (status: "failed" | "rejected") => void;
}) {
  const [summary, setSummary] = useState<AdminCampaignSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [busyConditionId, setBusyConditionId] = useState<string | null>(null);

  const [planEditMode, setPlanEditMode] = useState<PlanEditMode | null>(null);
  const [requeueOpen, setRequeueOpen] = useState(false);
  const [addAirfoilsOpen, setAddAirfoilsOpen] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [forceReleaseTarget, setForceReleaseTarget] = useState<AdminCampaignConditionSummary | null>(null);
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
      else if (requeueOpen) setRequeueOpen(false);
      else if (addAirfoilsOpen) setAddAirfoilsOpen(false);
      else if (cancelConfirm) setCancelConfirm(false);
      else if (forceReleaseTarget) setForceReleaseTarget(null);
      else {
        // Leaving the page is more destructive than closing a dialog: never
        // do it while a stacked dialog is open or while typing in a field
        // (Escape there means "abandon this input", not "leave the page").
        const t = e.target as HTMLElement | null;
        const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
        if (!typing && !document.querySelector('[role="dialog"][aria-modal="true"]')) onBack();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [planEditMode, requeueOpen, addAirfoilsOpen, cancelConfirm, forceReleaseTarget, onBack]);

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
      const res = await forceReleaseCondition(campaignId, condition.id, { expectedCancelledPoints: condition.counters.remaining });
      setNotice(`condition force-released — ${fCount(res.cancelledPoints)} pending point${res.cancelledPoints === 1 ? "" : "s"} cancelled; solved evidence kept`);
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
      const condition = summary?.conditions.find((c) => c.id === lane.conditionId);
      if (!condition) return;
      setCellPanel({
        airfoil: { airfoilId: lane.airfoilId, slug: lane.airfoilSlug, name: lane.airfoilName },
        condition,
        cell: null,
      });
    },
    [summary?.conditions],
  );

  const openCellFromMatrix = useCallback(
    (row: AdminCampaignAirfoilRow, condition: AdminCampaignConditionSummary, cell: CampaignProgressTotals | null) => {
      setCellPanel({
        airfoil: { airfoilId: row.airfoilId, slug: row.slug, name: row.name, isSymmetric: row.isSymmetric },
        condition,
        cell,
      });
      setKnownAirfoilIds((prev) => (prev.includes(row.airfoilId) ? prev : [...prev, row.airfoilId]));
    },
    [],
  );

  // ---- not found / loading ----
  if (loadError && !summary) {
    const notFound = loadError.includes("not found");
    return (
      <div data-testid="campaign-not-found" style={{ display: "grid", gap: 12, justifyItems: "start", padding: "30px 0" }}>
        <div style={{ fontFamily: MONO, fontSize: 13, color: notFound ? C.text : C.red }}>
          {notFound ? "This campaign does not exist (or was purged)." : loadError}
        </div>
        <button type="button" onClick={onBack} style={ghostBtn}>
          ← back to campaigns
        </button>
      </div>
    );
  }
  if (!summary) {
    return <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim, padding: "30px 0" }}>loading campaign…</div>;
  }

  const { campaign, totals, scheduler, rate, conditions } = summary;
  const status = campaign.status;
  const line = campaignStatusLine(summary);
  const lineColor = line.tone === "teal" ? C.teal : line.tone === "amber" ? C.amber : line.tone === "red" ? C.redText : C.dim;
  const statusChip = STATUS_CHIP_COLOR[status] ?? STATUS_CHIP_COLOR.active;
  // Fidelity ladder phase (contract 7): rendered only while nothing blocks —
  // the liveness-split gate badge always outranks the phase.
  const phaseBadge = campaignPhaseBadge(summary.phase, status, line.gate);
  const tiersLine = tierCountsLine(summary.tierCounts);

  const objectives = campaign.plan.objectives;
  const editable = ["active", "paused", "attention", "completed"].includes(status);
  const gainedEvidence = conditions.filter((c) => c.gainedEvidenceAfterRelease);
  const nextUpId = nextUpConditionId(
    conditions,
    status === "active" &&
      !isProcessDead(scheduler.heartbeatAt) &&
      scheduler.sweeperEnabled &&
      scheduler.engineHealthy &&
      !scheduler.engineUnreachableSince,
  );
  const hasLanes = Object.keys(summary.lanesSummary).length > 0;

  const pct = (n: number) => (totals.requested > 0 ? `${Math.min(100, (n / totals.requested) * 100)}%` : "0%");

  interface ActionDef {
    key: string;
    label: string;
    tone?: "primary" | "amber" | "red";
    onClick: () => void;
    testId: string;
  }
  const actions: ActionDef[] = [];
  if (status === "active" || status === "attention") {
    actions.push({ key: "pause", label: busyAction === "pause" ? "pausing…" : "Pause", onClick: () => void runVerb("pause"), testId: "campaign-action-pause" });
  }
  if (status === "paused") {
    actions.push({ key: "resume", label: busyAction === "resume" ? "resuming…" : "Resume", tone: "primary", onClick: () => void runVerb("resume"), testId: "campaign-action-resume" });
  }
  if (editable) {
    actions.push(
      { key: "edit-angle", label: "Edit angle plan", onClick: () => setPlanEditMode("angle"), testId: "campaign-action-edit-angle" },
      { key: "edit-conditions", label: "Edit conditions", onClick: () => setPlanEditMode("conditions"), testId: "campaign-action-edit-conditions" },
      { key: "add-airfoils", label: "Add airfoils", onClick: () => setAddAirfoilsOpen(true), testId: "campaign-action-add-airfoils" },
    );
  }
  if ((totals.failed > 0 || totals.rejected > 0) && editable) {
    // Both review buckets open the same dialog: failed points always, rejected
    // (done-but-physics-rejected) points behind the dialog's opt-in section.
    const parts = [
      ...(totals.failed > 0 ? [`failed (${fCount(totals.failed)})`] : []),
      ...(totals.rejected > 0 ? [`rejected (${fCount(totals.rejected)})`] : []),
    ];
    actions.push({
      key: "requeue",
      label: `Requeue ${parts.join(" / ")}`,
      tone: "amber",
      onClick: () => setRequeueOpen(true),
      testId: "campaign-action-requeue",
    });
  }
  actions.push({ key: "duplicate", label: busyAction === "duplicate" ? "preparing…" : "Duplicate", onClick: () => void duplicate(), testId: "campaign-action-duplicate" });
  if (status === "attention") {
    actions.push({
      key: "close-with-failures",
      label: busyAction === "close-with-failures" ? "closing…" : `Close with failures (${fCount(totals.failed)})`,
      tone: "amber",
      onClick: () => void runVerb("close-with-failures"),
      testId: "campaign-action-close-with-failures",
    });
  }
  if (["active", "paused", "attention"].includes(status)) {
    actions.push({ key: "cancel", label: "Cancel…", tone: "red", onClick: () => setCancelConfirm(true), testId: "campaign-action-cancel" });
  }
  if (["completed", "cancelled"].includes(status)) {
    actions.push({ key: "archive", label: busyAction === "archive" ? "archiving…" : "Archive", onClick: () => void runVerb("archive"), testId: "campaign-action-archive" });
  }
  if (status === "archived") {
    actions.push({ key: "unarchive", label: busyAction === "archive" ? "restoring…" : "Unarchive", onClick: () => void runVerb("archive"), testId: "campaign-action-unarchive" });
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
        ...(a.tone === "red" ? { color: C.redText, borderColor: "rgba(245,101,101,0.45)" } : {}),
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
      <style jsx>{`
        .campaign-actions-inline {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          align-items: center;
        }
        .campaign-actions-overflow {
          display: none;
          position: relative;
        }
        @media (max-width: 940px) {
          .campaign-actions-inline {
            display: none;
          }
          .campaign-actions-overflow {
            display: inline-block;
          }
        }
      `}</style>

      {/* ---- header row 1: identity ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", color: C.text }}>{campaign.name}</h2>
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
              background: line.gate.tone === "red" ? "rgba(245,101,101,0.08)" : "rgba(245,158,11,0.08)",
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
              ? { fontFamily: MONO, fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", color: C.dim, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 8px" }
              : { fontFamily: MONO, fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", color: statusChip.color, border: `1px solid ${statusChip.border}`, borderRadius: 999, padding: "3px 9px" }
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
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "3px 9px" }}>
          polar sweep
        </span>
        {objectives.ldMax.enabled && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "3px 9px" }}>
            max L/D ±{objectives.ldMax.toleranceDeg}°
          </span>
        )}
        {objectives.clZero.enabled && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "3px 9px" }}>
            α₀ ±{objectives.clZero.toleranceDeg}°
          </span>
        )}
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "3px 9px" }}>
          {PRIORITY_LABEL[campaign.priority] ?? `priority ${campaign.priority}`}
        </span>
      </div>

      {/* ---- header row 2: truthful status + actions ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span data-testid="campaign-status-line" style={{ fontFamily: MONO, fontSize: 11.5, color: lineColor }}>
          {line.text}
        </span>
        {/* Enabling the sweeper flag while the process is dead would be a
            fake control — guidance text renders instead (approved design). */}
        {status === "active" && isProcessDead(scheduler.heartbeatAt) && (
          <span data-testid="campaign-solver-guidance" style={{ fontFamily: MONO, fontSize: 10, color: C.redText }}>
            {PROCESS_NOT_RUNNING_DETAIL}
          </span>
        )}
        {status === "active" && !isProcessDead(scheduler.heartbeatAt) && !scheduler.sweeperEnabled && !scheduler.engineUnreachableSince && (
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
            style={{ ...ghostBtn, color: C.amber, borderColor: "rgba(245,165,36,.45)", padding: "3px 9px", fontSize: 10 }}
          >
            {enablingSweeper ? "enabling…" : "enable sweeper"}
          </button>
        )}
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
          <span className="campaign-actions-inline">{actions.map((a) => actionButton(a))}</span>
          <span
            className="campaign-actions-overflow"
            onBlur={(e) => {
              const next = e.relatedTarget;
              if (!(next instanceof Node) || !e.currentTarget.contains(next)) setOverflowOpen(false);
            }}
          >
            <button
              type="button"
              data-testid="campaign-actions-overflow"
              aria-expanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
              style={{ ...ghostBtn, padding: "6px 12px", fontSize: 11 }}
            >
              actions ▾
            </button>
            {overflowOpen && (
              <span style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 30, minWidth: 220, background: C.popover, border: `1px solid ${C.stroke}`, borderRadius: 8, boxShadow: `0 12px 28px ${C.shadow}`, padding: 6, display: "grid", gap: 4 }}>
                {actions.map((a) => actionButton(a, true))}
              </span>
            )}
          </span>
        </span>
      </div>

      {notice && (
        <div data-testid="campaign-notice" style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber }}>
          {notice}
        </div>
      )}
      {loadError && summary && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red }}>poll failed: {loadError}</div>}

      {/* ---- progress + counts + measured rate ---- */}
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 14px", display: "grid", gap: 8 }}>
        <div style={{ height: 8, background: C.panel3, borderRadius: 5, overflow: "hidden", display: "flex" }} aria-hidden>
          <span style={{ width: pct(totals.solved), background: C.teal, display: "block" }} />
          <span style={{ width: pct(totals.derived), background: "rgba(45,212,191,0.45)", display: "block" }} />
          <span style={{ width: pct(totals.running), background: C.amber, display: "block" }} />
          <span style={{ width: pct(totals.failed), background: C.red, display: "block" }} />
          <span style={{ width: pct(totals.rejected), background: C.red, opacity: 0.55, display: "block" }} />
        </div>
        <div data-testid="campaign-counts-line" style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span style={{ color: C.teal }}>{fCount(totals.solved)} solved</span>
          {totals.derived > 0 && <span title="derived by symmetry — not solver runs">◌ {fCount(totals.derived)} derived</span>}
          {totals.running > 0 && <span style={{ color: C.amber }}>{fCount(totals.running)} running</span>}
          {/* Non-zero failed/rejected counts link to the Points explorer
              pre-filtered to this campaign + bucket; zero counts never render
              (no link to an empty view). */}
          {totals.failed > 0 && (
            <button
              type="button"
              data-testid="campaign-failed-link"
              title="Open these failed points in the Points explorer"
              onClick={() => onOpenPoints("failed")}
              style={{ fontFamily: MONO, fontSize: 10.5, color: C.redText, background: "transparent", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
            >
              {fCount(totals.failed)} failed
            </button>
          )}
          {totals.rejected > 0 && (
            <button
              type="button"
              data-testid="campaign-rejected-link"
              title="Solver finished but the evidence classified rejected — open these points in the Points explorer"
              onClick={() => onOpenPoints("rejected")}
              style={{ fontFamily: MONO, fontSize: 10.5, color: C.redText, background: "transparent", border: "none", padding: 0, cursor: "pointer", textDecoration: "underline" }}
            >
              {fCount(totals.rejected)} rejected
            </button>
          )}
          {totals.superseded > 0 && <span style={{ color: C.dim }}>{fCount(totals.superseded)} superseded</span>}
          <span>{fCount(totals.remaining)} remaining of {fCount(totals.requested)} points</span>
          <span style={{ color: C.dim }}>
            {fCount(summary.airfoilCount)} airfoils · {fCount(conditions.filter((c) => c.status !== "released").length)} conditions
          </span>
          {tiersLine && (
            <span data-testid="campaign-tier-counts" style={{ color: C.dim }} title="Fidelity ladder: RANS gaps, then precalc URANS, then full-fidelity verification">
              {tiersLine}
            </span>
          )}
        </div>
        {rate && (
          <div data-testid="campaign-rate-line" style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
            measured ingest: {fCount(rate.pointsLast24h)} solver points in the trailing 24 h · {fCount(rate.remainingPoints)} solver points of work remain
          </div>
        )}
        {gainedEvidence.length > 0 && (
          <button
            type="button"
            data-testid="campaign-restore-suggestion"
            onClick={() => stripRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
            style={{ justifySelf: "start", fontFamily: MONO, fontSize: 10, color: C.amber, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 999, padding: "4px 10px", cursor: "pointer" }}
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

      {requeueOpen && (
        <RequeueDialog
          campaignId={campaignId}
          conditions={conditions}
          onClose={() => setRequeueOpen(false)}
          onApplied={(requeued) => {
            setNotice(`requeued ${fCount(requeued)} point${requeued === 1 ? "" : "s"}`);
            void refresh();
          }}
        />
      )}

      {addAirfoilsOpen && (
        <AddAirfoilsDialog
          campaignId={campaignId}
          conditions={conditions}
          knownIncludedIds={knownAirfoilIds}
          onClose={() => setAddAirfoilsOpen(false)}
          onApplied={(added, points) => {
            setNotice(`added ${fCount(added)} airfoil${added === 1 ? "" : "s"} — ${fCount(points)} points queued`);
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
          style={{ position: "fixed", inset: 0, zIndex: 60, background: C.overlay, display: "grid", placeItems: "center", padding: 20 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCancelConfirm(false);
          }}
        >
          <div style={{ background: C.modalBg, border: `1px solid ${C.border}`, borderRadius: 12, width: "min(460px, 94vw)", padding: 16, display: "grid", gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.redText }}>CANCEL CAMPAIGN</span>
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.text, lineHeight: 1.55 }}>
              {fCount(totals.remaining)} pending point{totals.remaining === 1 ? "" : "s"} will be removed from the queue.
              {scheduler.campaignJobsRunning > 0
                ? ` ${fCount(scheduler.campaignJobsRunning)} running job${scheduler.campaignJobsRunning === 1 ? "" : "s"} will finish and ingest.`
                : ""}
              {totals.failed > 0 ? ` ${fCount(totals.failed)} failed point${totals.failed === 1 ? "" : "s"} stay recorded.` : ""}
              {" "}All solved evidence, attempts and fits are kept. This cannot be undone.
            </span>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setCancelConfirm(false)} style={ghostBtn}>
                keep running
              </button>
              <button
                type="button"
                data-testid="campaign-cancel-confirm"
                disabled={busyAction != null}
                onClick={() => void runVerb("cancel")}
                style={{ ...ghostBtn, color: C.redText, borderColor: "rgba(245,101,101,0.5)", opacity: busyAction != null ? 0.6 : 1 }}
              >
                {busyAction === "cancel" ? "cancelling…" : `Cancel campaign — remove ${fCount(totals.remaining)} pending`}
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
          style={{ position: "fixed", inset: 0, zIndex: 60, background: C.overlay, display: "grid", placeItems: "center", padding: 20 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setForceReleaseTarget(null);
          }}
        >
          <div style={{ background: C.modalBg, border: `1px solid ${C.border}`, borderRadius: 12, width: "min(460px, 94vw)", padding: 16, display: "grid", gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.redText }}>FORCE-RELEASE CONDITION</span>
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.text, lineHeight: 1.55 }}>
              This blocked condition stops counting against completion. {fCount(forceReleaseTarget.counters.remaining)} pending point
              {forceReleaseTarget.counters.remaining === 1 ? "" : "s"} will be cancelled, {fCount(forceReleaseTarget.counters.failed)} failed point
              {forceReleaseTarget.counters.failed === 1 ? "" : "s"} stay recorded, and all solved evidence is kept. The release is recorded as a plan revision.
            </span>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setForceReleaseTarget(null)} style={ghostBtn}>
                keep
              </button>
              <button
                type="button"
                data-testid="force-release-confirm"
                disabled={busyConditionId != null}
                onClick={() => void doForceRelease(forceReleaseTarget)}
                style={{ ...ghostBtn, color: C.redText, borderColor: "rgba(245,101,101,0.5)", opacity: busyConditionId != null ? 0.6 : 1 }}
              >
                {busyConditionId ? "releasing…" : `Force-release — cancel ${fCount(forceReleaseTarget.counters.remaining)} pending`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
