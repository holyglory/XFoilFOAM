// Pure presentation logic for the campaign status line (§12 truth table:
// campaign status × sweeper process × enabled flag × engine health). Kept
// React-free so it unit-tests without dragging the client component tree.
// Relative imports (not @/ aliases): this module is covered by node vitest,
// which resolves no tsconfig paths.
import type { AdminCampaignSummary } from "../../../lib/admin";
import { isProcessDead } from "../../../lib/solver-state";

// Local copy of ui.tsx's fCount: importing ui.tsx here would drag the React
// component tree into node vitest, defeating the point of this pure module.
function fCount(v: number): string {
  return v.toLocaleString("en-US");
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Never a bare "Active" while nothing can run. */
export function campaignStatusLine(s: AdminCampaignSummary): { text: string; tone: "teal" | "amber" | "red" | "dim" } {
  const { campaign, totals, scheduler } = s;
  const jobs = scheduler.campaignJobsRunning;
  switch (campaign.status) {
    case "archived":
      return { text: "Archived — read-only.", tone: "dim" };
    case "cancelled":
      return jobs > 0
        ? { text: `Cancelled — ${fCount(jobs)} job${jobs === 1 ? "" : "s"} finishing.`, tone: "dim" }
        : { text: "Cancelled.", tone: "dim" };
    case "completed":
      return campaign.closedWithFailedCount != null
        ? { text: `Completed — closed with ${fCount(campaign.closedWithFailedCount)} failed point${campaign.closedWithFailedCount === 1 ? "" : "s"}.`, tone: "teal" }
        : { text: "Completed — every obligated point is terminal.", tone: "teal" };
    case "attention":
      return { text: `All obligated work is terminal — ${fCount(totals.failed)} failed point${totals.failed === 1 ? "" : "s"} need review.`, tone: "red" };
    case "paused":
      return {
        text: `Paused by you — no new points will be scheduled${jobs > 0 ? `; ${fCount(jobs)} running job${jobs === 1 ? "" : "s"} will finish` : ""}.`,
        tone: "amber",
      };
    default: {
      // active — gate precedence mirrors lib/solver-state deriveSolverState:
      // a dead solver process outranks every engine/enabled clause (the
      // stale-heartbeat state that misled a real launch on 2026-07-05).
      if (isProcessDead(scheduler.heartbeatAt)) {
        return { text: "Solver process is not running — nothing is being scheduled.", tone: "red" };
      }
      if (scheduler.engineUnreachableSince) {
        return { text: `Engine unreachable since ${hhmm(scheduler.engineUnreachableSince)} — no jobs are being submitted.`, tone: "red" };
      }
      if (!scheduler.sweeperEnabled) return { text: "Sweeper disabled — nothing is being scheduled.", tone: "amber" };
      if (!scheduler.engineHealthy) {
        return { text: `Engine unhealthy${scheduler.engineError ? ` (${scheduler.engineError})` : ""} — no jobs are being submitted.`, tone: "red" };
      }
      // Point counters update on INGEST, so between job submission and the
      // first partial ingest they read 0 while the engine is solving hard
      // (observed on the first prod campaign, 2026-07-05). The scheduler's
      // live job count covers that window truthfully.
      return {
        text:
          jobs > 0
            ? `Active — ${fCount(jobs)} job${jobs === 1 ? "" : "s"} solving · ${fCount(totals.running)} point${totals.running === 1 ? "" : "s"} mid-ingest · ${fCount(totals.remaining)} remaining.`
            : `Active — ${fCount(totals.running)} point${totals.running === 1 ? "" : "s"} running, ${fCount(totals.remaining)} remaining.`,
        tone: "teal",
      };
    }
  }
}
