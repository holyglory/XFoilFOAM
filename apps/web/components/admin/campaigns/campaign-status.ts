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
import {
  formatAge,
  isProcessDead,
  type SolverStateName,
  tickStalledForMs,
} from "../../../lib/solver-state";

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
  /** violet = the calm awaiting-URANS-only attention state (amendment A):
   *  nothing needs a human, the stage-2 queue just has not run yet. */
  tone: "teal" | "amber" | "red" | "dim" | "violet";
}

/** One concise operational message for the instrument-cluster campaign hero.
 * The lifecycle, scheduler gate and explanatory status line are deliberately
 * folded into one title/detail pair so the UI never repeats ACTIVE/BLOCKED/
 * phase badges around the same state. The full measured status line remains
 * available to renderers as a tooltip when the concise detail is used. */
export interface CampaignInstrumentStatus {
  title: string;
  detail: string;
  tone: CampaignStatusView["tone"];
  /** The only banner-level recovery action currently exposed. */
  action: "enable_sweeper" | null;
}

export function campaignInstrumentStatus(
  s: AdminCampaignSummary,
  line: CampaignStatusView = campaignStatusLine(s),
): CampaignInstrumentStatus {
  const { campaign, scheduler, totals } = s;
  const jobs = scheduler.campaignJobsRunning;
  const remaining = fCount(totals.remaining);

  if (campaign.status === "active" && scheduler.diskAdmissionBlocked) {
    return {
      title: "Capacity safeguard",
      detail:
        jobs > 0
          ? `${fCount(jobs)} active job${jobs === 1 ? "" : "s"} continue; new work resumes automatically when capacity returns`
          : "New work resumes automatically when storage capacity returns",
      tone: "amber",
      action: null,
    };
  }

  if (
    campaign.status === "active" &&
    !isProcessDead(scheduler.heartbeatAt) &&
    !scheduler.sweeperEnabled &&
    !scheduler.engineUnreachableSince
  ) {
    return {
      title: "Scheduling is off",
      detail: "Enable scheduling to continue this campaign",
      tone: "amber",
      action: "enable_sweeper",
    };
  }

  if (line.gate) {
    if (line.gate.text.includes("solver process not running")) {
      return {
        title: "Solver unavailable",
        detail: "Campaign scheduling resumes after the solver service restarts",
        tone: "red",
        action: null,
      };
    }
    if (line.gate.text.includes("engine unreachable")) {
      return {
        title: "Solver engine unreachable",
        detail:
          "Campaign scheduling resumes automatically after connectivity returns",
        tone: "red",
        action: null,
      };
    }
    if (line.gate.text.includes("engine unhealthy")) {
      return {
        title: "Solver engine unhealthy",
        detail:
          "Campaign scheduling is waiting for the engine health check to recover",
        tone: "red",
        action: null,
      };
    }
    if (line.gate.text.startsWith("SLOW")) {
      return {
        title: "Scheduler responding slowly",
        detail: "The current tick is still running; no action is required",
        tone: "amber",
        action: null,
      };
    }
    const title = line.gate.text.replace(/^BLOCKED\s*[—-]\s*/i, "");
    return {
      title: title.charAt(0).toUpperCase() + title.slice(1),
      detail: line.text,
      tone: line.tone,
      action: null,
    };
  }

  switch (campaign.status) {
    case "active":
      return {
        title: "Campaign running",
        detail:
          jobs > 0
            ? `${fCount(jobs)} active job${jobs === 1 ? "" : "s"} · ${remaining} points remain`
            : `${remaining} points remain · ready for the next scheduler tick`,
        tone: "teal",
        action: null,
      };
    case "paused":
      return {
        title: "Campaign paused",
        detail: "No new points are being scheduled",
        tone: "amber",
        action: null,
      };
    case "completed":
      return {
        title: "Campaign complete",
        detail: line.text.replace(/^Completed\s*[—-]\s*/i, ""),
        tone: line.tone,
        action: null,
      };
    case "cancelled":
      return {
        title: "Campaign cancelled",
        detail:
          line.text.replace(/^Cancelled\.?\s*/i, "") ||
          "Solved evidence is retained",
        tone: "dim",
        action: null,
      };
    case "archived":
      return {
        title: "Campaign archived",
        detail: "Read-only",
        tone: "dim",
        action: null,
      };
    case "attention":
      return {
        title:
          line.tone === "violet" ? "Unsteady recovery" : "Automatic recovery",
        detail: line.text,
        tone: line.tone,
        action: null,
      };
    default:
      return {
        title: campaign.status,
        detail: line.text,
        tone: line.tone,
        action: null,
      };
  }
}

export type CampaignLifecycleEventView =
  AdminCampaignSummary["latestLifecycleEvent"];

/** Plain-language pause provenance shared by hub and detail. Missing legacy
 *  history stays explicitly unknown; it is never attributed to the viewer. */
export function pausedCampaignStatusText(
  event: CampaignLifecycleEventView,
  runningJobs: number,
  nowMs: number = Date.now(),
): string {
  let provenance =
    "Paused — reason unavailable (this pause predates lifecycle history)";
  if (event?.action === "pause") {
    const parsed = Date.parse(event.createdAt);
    const age =
      Number.isFinite(parsed) && nowMs >= parsed
        ? ` ${formatAge(nowMs - parsed)} ago`
        : "";
    if (event.reason) {
      provenance = `Paused for ${event.reason} · reason recorded${age}`;
    } else if (event.actor) {
      provenance = `Paused by ${event.actor}${age}`;
    } else {
      provenance = `Paused · reason unavailable${age}`;
    }
  }
  const finishing =
    runningJobs > 0
      ? ` ${fCount(runningJobs)} running job${runningJobs === 1 ? "" : "s"} will finish.`
      : "";
  return `${provenance}. No new points are scheduled while paused.${finishing}`;
}

/** Gate badge from the GLOBAL solver derivation (lib/solver-state) — used by
 *  surfaces that only carry the shared list payload (hub cards before their
 *  per-card summary arrives, the Solver page backlog strip). Same precedence
 *  as campaignStatusLine: process dead / engine unreachable / engine
 *  unhealthy / sweeper disabled ("paused" solver state). */
export function gateFromSolverState(
  state: SolverStateName,
): CampaignGate | null {
  switch (state) {
    case "process_not_running":
      return { text: "BLOCKED — solver process not running", tone: "red" };
    case "engine_unreachable":
      return { text: "BLOCKED — engine unreachable", tone: "red" };
    case "engine_unhealthy":
      return { text: "BLOCKED — engine unhealthy", tone: "red" };
    case "storage_blocked":
      return { text: "BLOCKED — storage reserve reached", tone: "amber" };
    case "paused":
      return { text: "BLOCKED — sweeper disabled", tone: "amber" };
    case "tick_stalled":
      // Not a BLOCKED gate: scheduling continues next tick — the badge is an
      // honest amber slowness signal, never a false red.
      return {
        text: "SLOW — tick running; engine responding slowly",
        tone: "amber",
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Fidelity ladder phase (contract 7 — DERIVED server-side, rendered here).
// The phase badge decorates a RUNNING ladder; the liveness-split gate badge
// always outranks it (a blocked campaign shows BLOCKED, not a phase).
// ---------------------------------------------------------------------------
export type CampaignLadderPhase =
  | "running_rans"
  | "running_precalc"
  | "running_refinement"
  | "completed"
  | null;

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
      return lifecycleStatus === "completed"
        ? null
        : { key: phase, label: "ALL TIERS TERMINAL", tone: "teal" };
  }
}

/** Header-strip per-tier open counts (contract 7). null = payload has no tier
 *  counts (older API) — render nothing rather than invented zeros. */
export function tierCountsLine(
  tiers: CampaignTierCounts | undefined | null,
): string | null {
  if (!tiers) return null;
  return `tiers open — RANS ${fCount(tiers.ransOpen)} · precalc ${fCount(tiers.precalcOpen)} · verify ${fCount(tiers.verifyOpen)}`;
}

/** Never a bare "Active" while nothing can run. `nowMs` is injectable for
 *  deterministic tests of the heartbeat/tick-staleness clauses. */
export function campaignStatusLine(
  s: AdminCampaignSummary,
  nowMs: number = Date.now(),
): CampaignStatusView {
  const { campaign, totals, scheduler } = s;
  const blocked = totals.blocked ?? 0;
  const jobs = scheduler.campaignJobsRunning;
  const lifecycle = campaign.status;
  switch (campaign.status) {
    case "archived":
      return {
        gate: null,
        lifecycle,
        text: "Archived — read-only.",
        tone: "dim",
      };
    case "cancelled":
      return jobs > 0
        ? {
            gate: null,
            lifecycle,
            text: `Cancelled — ${fCount(jobs)} job${jobs === 1 ? "" : "s"} finishing.`,
            tone: "dim",
          }
        : { gate: null, lifecycle, text: "Cancelled.", tone: "dim" };
    case "completed": {
      // Honest close record (F2): a close from attention can be driven by
      // failed AND/OR rejected points. Omit each clause when 0/null — never
      // render "closed with 0 failed points" for a rejected-only close.
      const closedFailed = campaign.closedWithFailedCount ?? 0;
      const closedRejected = campaign.closedWithRejectedCount ?? 0;
      if (blocked > 0) {
        const unavailable = [
          closedFailed > 0
            ? `${fCount(closedFailed)} failed point${closedFailed === 1 ? "" : "s"}`
            : null,
          closedRejected > 0 ? `${fCount(closedRejected)} rejected` : null,
          `${fCount(blocked)} machine-blocked`,
        ].filter((part): part is string => part != null);
        return {
          gate: null,
          lifecycle,
          text: `Completed — closed with ${unavailable.join(" · ")}.`,
          tone: "amber",
        };
      }
      if (closedFailed > 0 && closedRejected > 0) {
        return {
          gate: null,
          lifecycle,
          text: `Completed — closed with ${fCount(closedFailed)} failed point${closedFailed === 1 ? "" : "s"} · ${fCount(closedRejected)} rejected.`,
          tone: "teal",
        };
      }
      if (closedFailed > 0) {
        return {
          gate: null,
          lifecycle,
          text: `Completed — closed with ${fCount(closedFailed)} failed point${closedFailed === 1 ? "" : "s"}.`,
          tone: "teal",
        };
      }
      if (closedRejected > 0) {
        return {
          gate: null,
          lifecycle,
          text: `Completed — closed with ${fCount(closedRejected)} rejected point${closedRejected === 1 ? "" : "s"}.`,
          tone: "teal",
        };
      }
      return {
        gate: null,
        lifecycle,
        text: "Completed — every obligated point is terminal.",
        tone: "teal",
      };
    }
    case "attention": {
      const automaticPrecalc = s.tierCounts?.precalcOpen ?? 0;
      if (automaticPrecalc > 0) {
        const blockedSuffix =
          blocked > 0
            ? ` ${fCount(blocked)} other point${blocked === 1 ? " is" : "s are"} machine-blocked and unavailable.`
            : "";
        return {
          gate: null,
          lifecycle,
          text: `Preliminary URANS work is queued or running for ${fCount(automaticPrecalc)} point${automaticPrecalc === 1 ? "" : "s"}; no human review is required.${blockedSuffix}`,
          tone: blocked > 0 ? "amber" : "violet",
        };
      }
      // Amendment-A split when the payload carries it: red strictly for
      // needs-review evidence; an awaiting-URANS-only attention state is the
      // calm violet stage-2 queue, never a false red.
      const rb = s.reviewBuckets;
      if (rb) {
        if (blocked > 0) {
          const unavailable = totals.failed + totals.rejected;
          const suffix = [
            rb.awaitingUrans > 0
              ? `${fCount(rb.awaitingUrans)} awaiting URANS`
              : null,
            unavailable > 0 ? `${fCount(unavailable)} other unavailable` : null,
          ].filter((part): part is string => part != null);
          return {
            gate: null,
            lifecycle,
            text: `All obligated work is terminal — ${fCount(blocked)} machine-blocked${suffix.length ? ` · ${suffix.join(" · ")}` : ""}. No human review is required.`,
            tone: "amber",
          };
        }
        if (rb.needsReview > 0) {
          const suffix =
            rb.awaitingUrans > 0
              ? ` · ${fCount(rb.awaitingUrans)} awaiting URANS`
              : "";
          return {
            gate: null,
            lifecycle,
            text: `All obligated work is terminal — ${fCount(rb.needsReview)} unavailable result${rb.needsReview === 1 ? "" : "s"}${suffix}. No human review is required.`,
            tone: "red",
          };
        }
        if (rb.awaitingUrans > 0) {
          return {
            gate: null,
            lifecycle,
            text: `All obligated work is terminal — ${fCount(rb.awaitingUrans)} point${rb.awaitingUrans === 1 ? "" : "s"} awaiting URANS.`,
            tone: "violet",
          };
        }
        const unavailable = totals.failed + totals.rejected + blocked;
        return {
          gate: null,
          lifecycle,
          text: `All obligated work is terminal — ${fCount(unavailable)} unavailable result${unavailable === 1 ? "" : "s"}. No human review is required.`,
          tone: "amber",
        };
      }
      // Older payloads have no refined machine-owned buckets. Failed and
      // rejected evidence is unavailable; it must never be relabelled as a
      // human-review obligation merely because the API predates the split.
      const unavailable = totals.failed + totals.rejected + blocked;
      return {
        gate: null,
        lifecycle,
        text: `All obligated work is terminal — ${fCount(unavailable)} unavailable result${unavailable === 1 ? "" : "s"}. No human review is required.`,
        tone: "amber",
      };
    }
    case "paused":
      return {
        gate: null,
        lifecycle,
        text: pausedCampaignStatusText(
          s.latestLifecycleEvent ?? null,
          jobs,
          nowMs,
        ),
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
      if (scheduler.diskAdmissionBlocked) {
        return {
          gate: {
            text: "BLOCKED — storage reserve reached",
            tone: "amber",
          },
          lifecycle,
          text:
            scheduler.diskAdmissionReason ??
            "Storage reserve reached — existing evidence remains available, but no new jobs are being submitted.",
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
      const stalledForMs = tickStalledForMs(
        scheduler.lastTickStartedAt ?? null,
        scheduler.lastTickCompletedAt ?? null,
        nowMs,
      );
      if (stalledForMs != null) {
        return {
          gate: {
            text: "SLOW — tick running; engine responding slowly",
            tone: "amber",
          },
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
