// Pure presentation logic for the campaign status line (§12 truth table:
// campaign status × sweeper process × enabled flag × engine health). Kept
// React-free so it unit-tests without dragging the client component tree.
// Relative imports (not @/ aliases): this module is covered by node vitest,
// which resolves no tsconfig paths.
//
// Composite shape (approved mockup fec7b453 screen 3): when a scheduler gate
// blocks work, `gate` carries the PRIMARY badge (amber/red "BLOCKED — …")
// and the lifecycle ("active") demotes to a small secondary chip in the
// renderers — never an "Active" headline next to a contradictory red line.
import type { AdminCampaignSummary } from "../../../lib/admin";
import { formatAge, isProcessDead, type SolverStateName, tickStalledForMs } from "../../../lib/solver-state";

// Local copy of ui.tsx's fCount: importing ui.tsx here would drag the React
// component tree into node vitest, defeating the point of this pure module.
function fCount(v: number): string {
  return v.toLocaleString("en-US");
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Primary badge shown INSTEAD of the lifecycle chip while a scheduler gate
 *  blocks all work for an active campaign. */
export interface CampaignGate {
  text: string;
  tone: "amber" | "red";
}

export interface CampaignStatusView {
  /** Non-null only while a scheduler gate blocks work (active campaigns). */
  gate: CampaignGate | null;
  /** Raw campaign lifecycle status ("active", "paused", …) — demoted to a
   *  small secondary chip whenever `gate` is present. */
  lifecycle: string;
  text: string;
  tone: "teal" | "amber" | "red" | "dim";
}

/** Gate badge from the GLOBAL solver derivation (lib/solver-state) — used by
 *  surfaces that only carry the shared list payload (hub cards before their
 *  per-card summary arrives, the Solver page backlog strip). Same precedence
 *  as campaignStatusLine: process dead / engine unreachable / engine
 *  unhealthy / sweeper disabled ("paused" solver state). */
export function gateFromSolverState(state: SolverStateName): CampaignGate | null {
  switch (state) {
    case "process_not_running":
      return { text: "BLOCKED — solver process not running", tone: "red" };
    case "engine_unreachable":
      return { text: "BLOCKED — engine unreachable", tone: "red" };
    case "engine_unhealthy":
      return { text: "BLOCKED — engine unhealthy", tone: "red" };
    case "paused":
      return { text: "BLOCKED — sweeper disabled", tone: "amber" };
    case "tick_stalled":
      // Not a BLOCKED gate: scheduling continues next tick — the badge is an
      // honest amber slowness signal, never a false red.
      return { text: "SLOW — tick running; engine responding slowly", tone: "amber" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Fidelity ladder phase (contract 7 — DERIVED server-side, rendered here).
// The phase badge decorates a RUNNING ladder; the liveness-split gate badge
// always outranks it (a blocked campaign shows BLOCKED, not a phase).
// ---------------------------------------------------------------------------
export type CampaignLadderPhase = "running_rans" | "running_precalc" | "running_refinement" | "completed" | null;

export interface CampaignTierCounts {
  ransOpen: number;
  precalcOpen: number;
  verifyOpen: number;
}

export interface CampaignPhaseBadge {
  key: Exclude<CampaignLadderPhase, null>;
  label: string;
  tone: "teal" | "amber";
}

/** null = no badge: no phase in the payload (older API), a gate is blocking
 *  (gate badge outranks the phase), or lifecycle already says "completed"
 *  (the status chip covers it — no duplicate badge). */
export function campaignPhaseBadge(
  phase: CampaignLadderPhase | undefined,
  lifecycleStatus: string,
  gate: CampaignGate | null,
): CampaignPhaseBadge | null {
  if (!phase || gate) return null;
  switch (phase) {
    case "running_rans":
      return { key: phase, label: "RUNNING RANS", tone: "teal" };
    case "running_precalc":
      return { key: phase, label: "RUNNING PRECALC URANS", tone: "amber" };
    case "running_refinement":
      return { key: phase, label: "RUNNING URANS REFINEMENT", tone: "amber" };
    case "completed":
      // Transient window: every tier terminal but the completion probe has
      // not flipped the lifecycle yet. Once the chip says COMPLETED the badge
      // would be a duplicate.
      return lifecycleStatus === "completed" ? null : { key: phase, label: "ALL TIERS TERMINAL", tone: "teal" };
  }
}

/** Header-strip per-tier open counts (contract 7). null = payload has no tier
 *  counts (older API) — render nothing rather than invented zeros. */
export function tierCountsLine(tiers: CampaignTierCounts | undefined | null): string | null {
  if (!tiers) return null;
  return `tiers open — RANS ${fCount(tiers.ransOpen)} · precalc ${fCount(tiers.precalcOpen)} · verify ${fCount(tiers.verifyOpen)}`;
}

/** Never a bare "Active" while nothing can run. `nowMs` is injectable for
 *  deterministic tests of the heartbeat/tick-staleness clauses. */
export function campaignStatusLine(s: AdminCampaignSummary, nowMs: number = Date.now()): CampaignStatusView {
  const { campaign, totals, scheduler } = s;
  const jobs = scheduler.campaignJobsRunning;
  const lifecycle = campaign.status;
  switch (campaign.status) {
    case "archived":
      return { gate: null, lifecycle, text: "Archived — read-only.", tone: "dim" };
    case "cancelled":
      return jobs > 0
        ? { gate: null, lifecycle, text: `Cancelled — ${fCount(jobs)} job${jobs === 1 ? "" : "s"} finishing.`, tone: "dim" }
        : { gate: null, lifecycle, text: "Cancelled.", tone: "dim" };
    case "completed": {
      // Honest close record (F2): a close from attention can be driven by
      // failed AND/OR rejected points. Omit each clause when 0/null — never
      // render "closed with 0 failed points" for a rejected-only close.
      const closedFailed = campaign.closedWithFailedCount ?? 0;
      const closedRejected = campaign.closedWithRejectedCount ?? 0;
      if (closedFailed > 0 && closedRejected > 0) {
        return {
          gate: null,
          lifecycle,
          text: `Completed — closed with ${fCount(closedFailed)} failed point${closedFailed === 1 ? "" : "s"} · ${fCount(closedRejected)} rejected.`,
          tone: "teal",
        };
      }
      if (closedFailed > 0) {
        return { gate: null, lifecycle, text: `Completed — closed with ${fCount(closedFailed)} failed point${closedFailed === 1 ? "" : "s"}.`, tone: "teal" };
      }
      if (closedRejected > 0) {
        return { gate: null, lifecycle, text: `Completed — closed with ${fCount(closedRejected)} rejected point${closedRejected === 1 ? "" : "s"}.`, tone: "teal" };
      }
      return { gate: null, lifecycle, text: "Completed — every obligated point is terminal.", tone: "teal" };
    }
    case "attention": {
      const parts: string[] = [];
      if (totals.failed > 0) parts.push(`${fCount(totals.failed)} failed`);
      if (totals.rejected > 0) parts.push(`${fCount(totals.rejected)} rejected`);
      const needs = parts.length ? parts.join(" + ") : "0 failed";
      return {
        gate: null,
        lifecycle,
        text: `All obligated work is terminal — ${needs} point${totals.failed + totals.rejected === 1 ? "" : "s"} need review.`,
        tone: "red",
      };
    }
    case "paused":
      return {
        gate: null,
        lifecycle,
        text: `Paused by you — no new points will be scheduled${jobs > 0 ? `; ${fCount(jobs)} running job${jobs === 1 ? "" : "s"} will finish` : ""}.`,
        tone: "amber",
      };
    default: {
      // active — gate precedence mirrors lib/solver-state deriveSolverState:
      // a dead solver process outranks every engine/enabled clause (the
      // stale-heartbeat state that misled a real launch on 2026-07-05).
      // With the liveness/progress split (migration 0033) a stale heartbeat
      // is TRUE process death — tick fields never excuse it.
      if (isProcessDead(scheduler.heartbeatAt, nowMs)) {
        return {
          gate: { text: "BLOCKED — solver process not running", tone: "red" },
          lifecycle,
          text: "Solver process is not running — nothing is being scheduled.",
          tone: "red",
        };
      }
      if (scheduler.engineUnreachableSince) {
        return {
          gate: { text: "BLOCKED — engine unreachable", tone: "red" },
          lifecycle,
          text: `Engine unreachable since ${hhmm(scheduler.engineUnreachableSince)} — no jobs are being submitted.`,
          tone: "red",
        };
      }
      if (!scheduler.sweeperEnabled) {
        return {
          gate: { text: "BLOCKED — sweeper disabled", tone: "amber" },
          lifecycle,
          text: "Sweeper disabled — nothing is being scheduled.",
          tone: "amber",
        };
      }
      if (!scheduler.engineHealthy) {
        return {
          gate: { text: "BLOCKED — engine unhealthy", tone: "red" },
          lifecycle,
          text: `Engine unhealthy${scheduler.engineError ? ` (${scheduler.engineError})` : ""} — no jobs are being submitted.`,
          tone: "red",
        };
      }
      // tick_stalled (liveness/progress split): heartbeat fresh but the
      // current tick started >5 min ago without completing — a slow engine
      // call is holding the tick. AMBER and non-blocking: scheduling
      // continues next tick, so this ranks below every BLOCKED gate above.
      const stalledForMs = tickStalledForMs(scheduler.lastTickStartedAt ?? null, scheduler.lastTickCompletedAt ?? null, nowMs);
      if (stalledForMs != null) {
        return {
          gate: { text: "SLOW — tick running; engine responding slowly", tone: "amber" },
          lifecycle,
          text: `Tick running ${formatAge(stalledForMs)} — engine responding slowly; scheduling continues next tick.`,
          tone: "amber",
        };
      }
      // Point counters update on INGEST, so between job submission and the
      // first partial ingest they read 0 while the engine is solving hard
      // (observed on the first prod campaign, 2026-07-05). The scheduler's
      // live job count covers that window truthfully.
      return {
        gate: null,
        lifecycle,
        text:
          jobs > 0
            ? `Active — ${fCount(jobs)} job${jobs === 1 ? "" : "s"} solving · ${fCount(totals.running)} point${totals.running === 1 ? "" : "s"} mid-ingest · ${fCount(totals.remaining)} remaining.`
            : `Active — ${fCount(totals.running)} point${totals.running === 1 ? "" : "s"} running, ${fCount(totals.remaining)} remaining.`,
        tone: "teal",
      };
    }
  }
}
