"use client";

// Campaigns hub (spec §11): Active/All segments (Active = active + paused +
// attention, default), attention-first sort, truthful status lines composed
// only from real API fields (never optimistic text), real progress bars from
// counters, per-row Duplicate/Open, 10 s polling paused on hidden tabs.

import { useCallback, useMemo, useRef, useState } from "react";

import {
  type AdminCampaignListItem,
  type AdminCampaignsSolverState,
  type AdminCampaignSummary,
  campaignVerb,
  getCampaign,
  getCampaignDuplicatePrefill,
  listCampaigns,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import {
  deriveSolverState,
  solverChipText,
  type SolverStateName,
} from "@/lib/solver-state";
import type { CampaignPointsBucket } from "@/lib/point-history";
import {
  campaignAutomaticFastCount,
  campaignHubSchedulerStatusText,
  gateFromSolverState,
  pausedCampaignStatusText,
} from "./campaign-status";
import { stashDuplicatePrefill } from "./wizard-draft";
import { usePoll } from "./usePoll";
import {
  ago,
  card,
  ErrorLine,
  fCount,
  formatRe,
  ghostBtn,
  primaryBtn,
} from "./ui";

const ACTIVE_STATUSES = ["active", "paused", "attention"];

const STATUS_COLOR: Record<string, string> = {
  active: C.teal,
  paused: C.amber,
  attention: C.red,
  completed: C.teal,
  cancelled: C.muted,
  archived: C.dim,
};

export interface CampaignsHubProps {
  onOpenCampaign: (id: string) => void;
  onNewCampaign: (kind: "polar_sweep" | "ld_refine") => void;
  /** Router-navigates to ?section=queue (the Solver page). */
  onOpenSolver: () => void;
  /** Opens Solver ▸ Points pre-filtered to a campaign + bucket. */
  onOpenPoints: (campaignId: string, status: CampaignPointsBucket) => void;
}

function priorityLabel(priority: number): string {
  if (priority === 0) return "Background";
  if (priority === 5) return "Standard";
  if (priority === 8) return "High";
  return `P${priority}`;
}

/** Truthful status line from the campaign × sweeper × engine truth table
 *  (spec §12) — every clause reads a real field; nothing is projected.
 *  `solverState` is the SAME derivation the Solver banner uses (list-payload
 *  solverState → deriveSolverState), so an active row can never read as
 *  quietly waiting while the solver process is down or the engine is gone. */
export function campaignHubStatusLine(
  item: AdminCampaignListItem,
  summary: AdminCampaignSummary | undefined,
  solverState: SolverStateName,
): string {
  const totals = summary?.totals ?? item.totals;
  const blocked = totals.blocked ?? 0;
  const automaticFast = campaignAutomaticFastCount(item);
  const scheduler = summary?.scheduler;
  if (item.status === "archived") return "Archived — read-only.";
  if (item.status === "cancelled") {
    const finishing = scheduler?.campaignJobsRunning ?? 0;
    return finishing > 0
      ? `Cancelled — ${finishing} job${finishing === 1 ? "" : "s"} finishing.`
      : "Cancelled — evidence kept.";
  }
  if (item.status === "completed") {
    if (blocked > 0) {
      return `Completed · ${fCount(blocked)} critical recover${blocked === 1 ? "y" : "ies"} exhausted; system investigation required.`;
    }
    return (item.closedWithFailedCount ?? 0) > 0 ||
      (item.closedWithRejectedCount ?? 0) > 0
      ? "Completed · evidence retained in Solver logs."
      : `Completed${item.completedAt ? ` ${ago(item.completedAt)}` : ""}.`;
  }
  if (item.status === "paused") {
    const running = scheduler?.campaignJobsRunning ?? 0;
    return pausedCampaignStatusText(
      summary?.latestLifecycleEvent ?? item.latestLifecycleEvent,
      running,
    );
  }
  if (item.status === "attention") {
    if (blocked > 0) {
      const fastSuffix =
        automaticFast > 0
          ? ` · ${fCount(automaticFast)} awaiting FAST URANS`
          : "";
      return `${fCount(blocked)} critical recover${blocked === 1 ? "y" : "ies"} exhausted${fastSuffix}; system investigation required.`;
    }
    if (automaticFast > 0) {
      return `Awaiting FAST URANS · ${fCount(automaticFast)} point${automaticFast === 1 ? "" : "s"}`;
    }
    // Legacy result counters remain inspectable in Solver job logs, but they
    // cannot become a red campaign failure without typed exhausted recovery.
    return "Evidence retained · details in Solver logs.";
  }
  // active — scheduler-dependent clause from the shared solver derivation
  // first: never a bare "Active — waiting" while nothing can run. Gated
  // lines drop the "Active —" prefix entirely (mockup fec7b453 screen 3):
  // the gate badge is the headline and the small lifecycle chip says active.
  const schedulerGate = campaignHubSchedulerStatusText(solverState, scheduler);
  if (schedulerGate) return schedulerGate;
  const parts = [`${fCount(totals.remaining)} points remaining`];
  if (totals.running > 0) parts.push(`${fCount(totals.running)} running`);
  if (automaticFast > 0)
    parts.push(`${fCount(automaticFast)} awaiting FAST URANS`);
  if (blocked > 0)
    parts.push(
      `${fCount(blocked)} critical recover${blocked === 1 ? "y" : "ies"} exhausted`,
    );
  return `Active — ${parts.join(" · ")}.`;
}

function kindChip(summary: AdminCampaignSummary | undefined): string | null {
  if (!summary) return null;
  const { ldMax, clZero, clMax } = summary.campaign.plan.objectives;
  // clMax is optional on pre-clMax plan revisions — absence means disabled.
  const enabled = [
    ldMax.enabled ? "max L/D" : null,
    clZero.enabled ? "zero-lift" : null,
    clMax?.enabled ? "Cl_max" : null,
  ].filter((x): x is string => x != null);
  if (enabled.length === 0) return "polar sweep";
  if (enabled.length === 1)
    return enabled[0] === "max L/D" ? "max-L/D refine" : `${enabled[0]} refine`;
  return `${enabled.join(" + ")} refine`;
}

export function CampaignsHub({
  onOpenCampaign,
  onNewCampaign,
  onOpenSolver,
  onOpenPoints,
}: CampaignsHubProps) {
  const [segment, setSegment] = useState<"active" | "all">("active");
  const [items, setItems] = useState<AdminCampaignListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summaries, setSummaries] = useState<
    Record<string, AdminCampaignSummary>
  >({});
  const [solverPayload, setSolverPayload] =
    useState<AdminCampaignsSolverState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"duplicate" | "resume" | null>(
    null,
  );
  const segmentRef = useRef(segment);
  segmentRef.current = segment;

  const refresh = useCallback(async () => {
    try {
      const seg = segmentRef.current;
      const result = await listCampaigns({
        statuses: seg === "active" ? ACTIVE_STATUSES : undefined,
        limit: 50,
      });
      setErr(null);
      setItems(result.items);
      setTotal(result.total);
      setSolverPayload(result.solverState ?? null);
      // Bounded per-card summaries (limit 50, O(conditions) each) give the
      // real kind/objective chips, Re chips and scheduler truth fields.
      const detail = await Promise.all(
        result.items.map(async (item) => {
          try {
            return [item.id, await getCampaign(item.id)] as const;
          } catch {
            return null;
          }
        }),
      );
      setSummaries(
        Object.fromEntries(
          detail.filter(
            (d): d is readonly [string, AdminCampaignSummary] => d != null,
          ),
        ),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  usePoll(refresh, 10_000);

  // Same derivation module as the Solver banner (lib/solver-state) — the hub
  // chip and the row suffixes can never disagree with the Solver page.
  const solver = deriveSolverState(
    solverPayload
      ? {
          fetchOk: true,
          heartbeatAt: solverPayload.heartbeatAt,
          enabled: solverPayload.enabled,
          engineUnreachableSince: solverPayload.engineUnreachableSince,
          engineHealthy: solverPayload.engineHealthy,
          activeJobCount: solverPayload.activeJobCount,
          lastTickStartedAt: solverPayload.lastTickStartedAt ?? null,
          lastTickCompletedAt: solverPayload.lastTickCompletedAt ?? null,
          diskAdmissionBlocked: solverPayload.diskAdmissionBlocked,
          diskAdmissionReason: solverPayload.diskAdmissionReason,
          diskUsedPct: solverPayload.diskUsedPct,
          diskFreeBytes: solverPayload.diskFreeBytes,
          diskRequiredFreeBytes: solverPayload.diskRequiredFreeBytes,
          diskCheckedAt: solverPayload.diskCheckedAt,
          admissionFenceActive: solverPayload.admissionFenceActive,
          lastAdmissionFenceAt: solverPayload.lastAdmissionFenceAt,
          lastAdmissionFenceReason: solverPayload.lastAdmissionFenceReason,
        }
      : {
          fetchOk: false,
          heartbeatAt: null,
          enabled: false,
          engineUnreachableSince: null,
          engineHealthy: false,
        },
  );
  const solverChipColor =
    solver.tone === "red"
      ? C.redText
      : solver.tone === "amber"
        ? C.amber
        : C.teal;
  const solverChipBorder =
    solver.tone === "red"
      ? "rgba(245,101,101,0.45)"
      : solver.tone === "amber"
        ? "rgba(245,165,36,0.45)"
        : C.tealBorder;

  const sorted = useMemo(() => {
    if (!items) return null;
    return [...items].sort(
      (a, b) =>
        Number(b.status === "attention") - Number(a.status === "attention") ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [items]);

  const duplicate = async (item: AdminCampaignListItem) => {
    setBusyId(item.id);
    setBusyAction("duplicate");
    setErr(null);
    try {
      const prefill = await getCampaignDuplicatePrefill(item.id);
      stashDuplicatePrefill(prefill);
      onNewCampaign(
        prefill.plan.objectives.ldMax.enabled ? "ld_refine" : "polar_sweep",
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const resume = async (item: AdminCampaignListItem) => {
    setBusyId(item.id);
    setBusyAction("resume");
    setErr(null);
    try {
      await campaignVerb(item.id, "resume");
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  return (
    <div data-testid="campaigns-hub">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          Simulations
        </h2>
        {/* Compact solver chip (approved mockups): closed, no popover — it
            router-links to the Solver page for anything beyond the summary. */}
        <button
          type="button"
          data-testid="hub-solver-chip"
          title="Open the Solver page"
          onClick={onOpenSolver}
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: solverChipColor,
            background: "transparent",
            border: `1px solid ${solverChipBorder}`,
            borderRadius: 999,
            padding: "3px 10px",
            cursor: "pointer",
          }}
        >
          {solverChipText(solver.state, solverPayload?.activeJobCount)}
        </button>
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            data-testid="new-polar-sweep"
            onClick={() => onNewCampaign("polar_sweep")}
            style={primaryBtn(false)}
          >
            New polar sweep
          </button>
          <button
            type="button"
            data-testid="new-ld-refine"
            onClick={() => onNewCampaign("ld_refine")}
            style={{ ...ghostBtn, color: C.teal, borderColor: C.tealBorder }}
          >
            New max-L/D refinement
          </button>
        </div>
      </div>

      {err && <ErrorLine text={err} />}

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {(["active", "all"] as const).map((seg) => {
          const on = segment === seg;
          return (
            <button
              key={seg}
              type="button"
              data-testid={`campaigns-segment-${seg}`}
              aria-pressed={on}
              onClick={() => {
                setSegment(seg);
                segmentRef.current = seg;
                setItems(null);
                void refresh();
              }}
              style={{
                ...ghostBtn,
                padding: "6px 12px",
                color: on ? C.teal : C.muted,
                borderColor: on ? C.tealBorder : C.stroke,
                background: on ? C.tealFill : C.panel3,
              }}
            >
              {seg === "active"
                ? "Active"
                : `All${total && segment === "all" ? ` (${total})` : ""}`}
            </button>
          );
        })}
      </div>

      {sorted == null ? (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 13,
            color: C.muted,
            padding: 30,
          }}
        >
          loading campaigns…
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ ...card, fontFamily: MONO, fontSize: 12, color: C.dim }}>
          {segment === "active"
            ? "No active campaigns. Launch one with “New polar sweep”."
            : "No campaigns yet."}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {sorted.map((item) => {
            const summary = summaries[item.id];
            const totals = summary?.totals ?? item.totals;
            const blocked = totals.blocked ?? 0;
            const automaticFast = campaignAutomaticFastCount(item);
            const repairing =
              summary?.remediation.repairing ?? item.remediation.repairing;
            const settled = totals.solved + totals.derived;
            const progress =
              totals.requested > 0
                ? Math.min(1, settled / totals.requested)
                : 0;
            const blockedProgress =
              totals.requested > 0
                ? Math.min(1 - progress, blocked / totals.requested)
                : 0;
            const chip = kindChip(summary);
            const reValues = summary
              ? [
                  ...new Set(
                    summary.conditions
                      .filter((c) => c.status !== "released")
                      .map((c) => formatRe(c.reynolds)),
                  ),
                ]
              : [];
            const attentionColor =
              blocked > 0 ? C.red : automaticFast > 0 ? C.violet : C.amber;
            const statusColor =
              blocked > 0
                ? C.red
                : item.status === "attention"
                  ? attentionColor
                  : (STATUS_COLOR[item.status] ?? C.muted);
            // Gate badge (mockup fec7b453 screen 3): while a scheduler gate
            // blocks an ACTIVE campaign, the gate is the PRIMARY chip and the
            // lifecycle demotes to a small dim chip — never an "Active"
            // headline next to a contradictory red line.
            const gate =
              item.status === "active"
                ? gateFromSolverState(solver.state)
                : null;
            return (
              <div
                key={item.id}
                data-testid={`campaign-row-${item.slug}`}
                style={{ ...card, display: "grid", gap: 8 }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 14,
                      fontWeight: 600,
                      color: C.text,
                    }}
                  >
                    {item.name}
                  </span>
                  {gate && (
                    <span
                      data-testid={`campaign-gate-${item.slug}`}
                      style={{
                        fontFamily: MONO,
                        fontSize: 9,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        color: gate.tone === "red" ? C.redText : C.amber,
                        background:
                          gate.tone === "red"
                            ? "rgba(245,101,101,0.08)"
                            : "rgba(245,158,11,0.08)",
                        border: `1px solid ${gate.tone === "red" ? "rgba(245,101,101,0.5)" : "rgba(245,158,11,0.45)"}`,
                        borderRadius: 999,
                        padding: "2px 9px",
                      }}
                    >
                      {gate.text}
                    </span>
                  )}
                  <span
                    style={
                      gate
                        ? {
                            fontFamily: MONO,
                            fontSize: 9,
                            letterSpacing: "0.06em",
                            color: C.dim,
                            border: `1px solid ${C.borderSoft}`,
                            borderRadius: 999,
                            padding: "2px 8px",
                            textTransform: "uppercase" as const,
                          }
                        : {
                            fontFamily: MONO,
                            fontSize: 9,
                            letterSpacing: "0.06em",
                            color: statusColor,
                            border: `1px solid ${statusColor}`,
                            borderRadius: 999,
                            padding: "2px 8px",
                            textTransform: "uppercase" as const,
                          }
                    }
                  >
                    {item.status}
                  </span>
                  {chip && (
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: 9,
                        color: C.dim,
                        border: `1px solid ${C.borderSoft}`,
                        borderRadius: 999,
                        padding: "2px 8px",
                      }}
                    >
                      {chip}
                    </span>
                  )}
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 9,
                      color: C.dim,
                      border: `1px solid ${C.borderSoft}`,
                      borderRadius: 999,
                      padding: "2px 8px",
                    }}
                  >
                    {priorityLabel(item.priority)}
                  </span>
                  <span
                    className={`campaign-card-actions${item.status === "paused" ? " campaign-card-actions-paused" : ""}`}
                    style={{ marginLeft: "auto", display: "flex", gap: 6 }}
                  >
                    {item.status === "paused" && (
                      <button
                        type="button"
                        data-testid={`campaign-resume-${item.slug}`}
                        disabled={busyId === item.id}
                        onClick={() => void resume(item)}
                        style={{
                          ...primaryBtn(busyId === item.id),
                          padding: "5px 14px",
                          fontSize: 10,
                        }}
                      >
                        {busyId === item.id && busyAction === "resume"
                          ? "resuming…"
                          : "Resume"}
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid={`campaign-open-${item.slug}`}
                      onClick={() => onOpenCampaign(item.id)}
                      style={{
                        ...ghostBtn,
                        padding: "5px 10px",
                        fontSize: 10,
                        color: C.teal,
                        borderColor: C.tealBorder,
                      }}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      data-testid={`campaign-duplicate-${item.slug}`}
                      disabled={busyId === item.id}
                      onClick={() => duplicate(item)}
                      style={{
                        ...ghostBtn,
                        padding: "5px 10px",
                        fontSize: 10,
                        opacity: busyId === item.id ? 0.6 : 1,
                      }}
                    >
                      {busyId === item.id && busyAction === "duplicate"
                        ? "preparing…"
                        : "Duplicate"}
                    </button>
                  </span>
                </div>

                {repairing > 0 && (
                  <div
                    data-testid={`campaign-mesh-repair-${item.slug}`}
                    style={{
                      display: "grid",
                      gap: 3,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid rgba(245,158,11,0.45)",
                      background: "rgba(245,158,11,0.06)",
                      fontFamily: MONO,
                    }}
                  >
                    <span
                      style={{
                        color: C.amber,
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                      }}
                    >
                      AUTOMATIC MESH REPAIR · {fCount(repairing)} POINTS
                    </span>
                    <span style={{ color: C.text2, fontSize: 10 }}>
                      Trying a safer mesh automatically — no action needed.
                    </span>
                  </div>
                )}

                <div
                  data-testid={`campaign-status-line-${item.slug}`}
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    color:
                      blocked > 0
                        ? C.redText
                        : automaticFast > 0
                          ? C.violet
                          : item.status === "attention"
                            ? attentionColor
                            : gate
                              ? gate.tone === "red"
                                ? C.redText
                                : C.amber
                              : C.text2,
                  }}
                >
                  {campaignHubStatusLine(item, summary, solver.state)}
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <div
                    aria-label={`progress ${settled} done and ${blocked} critical recoveries exhausted of ${totals.requested}`}
                    style={{
                      height: 6,
                      borderRadius: 4,
                      background: C.panel3,
                      overflow: "hidden",
                      display: "flex",
                    }}
                  >
                    {/* Red marks critical exhausted recovery; automatic
                        precalc and awaiting-URANS work keep the teal bar. */}
                    <div
                      style={{
                        width: `${progress * 100}%`,
                        height: "100%",
                        background: C.teal,
                      }}
                    />
                    {blockedProgress > 0 && (
                      <div
                        style={{
                          width: `${blockedProgress * 100}%`,
                          height: "100%",
                          background: C.red,
                        }}
                      />
                    )}
                  </div>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      color: C.dim,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fCount(settled)} / {fCount(totals.requested)}
                    {/* Only typed states belong in the campaign summary:
                        exhausted automatic recovery is red; queued/running
                        FAST URANS is calm violet. Raw failed/rejected evidence
                        stays in technical Solver logs. */}
                    {blocked > 0 && (
                      <>
                        {" · "}
                        <span
                          data-testid={`campaign-blocked-${item.slug}`}
                          title="Critical: automatic recovery exhausted without a publishable result"
                          style={{ color: C.redText }}
                        >
                          {fCount(blocked)} critical
                        </span>
                      </>
                    )}
                    {automaticFast > 0 && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          data-testid={`campaign-awaiting-urans-link-${item.slug}`}
                          title="Open points moving automatically from RANS screening to FAST URANS"
                          onClick={() =>
                            onOpenPoints(item.id, "awaiting_urans")
                          }
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: C.violet,
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}
                        >
                          {fCount(automaticFast)} awaiting FAST URANS
                        </button>
                      </>
                    )}
                  </span>
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.dim,
                  }}
                >
                  <span>{fCount(item.airfoilCount)} airfoils</span>
                  <span>· {fCount(item.conditionCount)} conditions</span>
                  {item.excludedAirfoilCount > 0 && (
                    <span>
                      · {fCount(item.excludedAirfoilCount)} incomplete source
                      record{item.excludedAirfoilCount === 1 ? "" : "s"}{" "}
                      excluded
                    </span>
                  )}
                  {reValues.slice(0, 6).map((re) => (
                    <span
                      key={re}
                      style={{
                        color: C.text2,
                        border: `1px solid ${C.borderSoft}`,
                        borderRadius: 999,
                        padding: "1px 7px",
                      }}
                    >
                      Re {re}
                    </span>
                  ))}
                  {reValues.length > 6 && (
                    <span>+{reValues.length - 6} more</span>
                  )}
                  <span style={{ marginLeft: "auto", color: C.dimmest }}>
                    updated {ago(item.updatedAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
