// Single derivation of the solver-process truth (Solver page redesign,
// DecisionHistory 2026-07-05 "First Real Campaign Run"): the enabled flag is
// only half the truth — a stale heartbeat means the sweeper PROCESS is not
// running and no flag flip will schedule anything. Every surface that talks
// about scheduling (Solver banner, hub chip, hub row suffixes, campaign
// status line, wizard Review) derives from this module so the four surfaces
// can never disagree. Pure module — no React, unit-tested in
// test/solver-state.test.ts (the must-catch layer for the stale-heartbeat
// regression).

export const HEARTBEAT_STALE_MS = 90_000;

/** Guidance shown wherever Pause/Resume/enable controls would be fake while
 *  the process is down. A Start button is never rendered — the web app
 *  cannot start an OS process, so the honest affordance is instructions. */
export const PROCESS_NOT_RUNNING_DETAIL =
  "Pause/Resume has no effect until it is started (dev: coordinator runtime sweeper; prod: sweeper service)";

export type SolverStateName =
  | "unknown"
  | "process_not_running"
  | "paused"
  | "engine_unreachable"
  | "engine_unhealthy"
  | "idle"
  | "running";

export type SolverTone = "red" | "amber" | "teal";

export interface SolverStateInput {
  /** false while the status payload has not been fetched successfully —
   *  derives "unknown", never green-by-default. */
  fetchOk: boolean;
  heartbeatAt: string | null;
  enabled: boolean;
  engineUnreachableSince: string | null;
  engineHealthy: boolean;
  engineBuildMismatch?: boolean;
  /** celery introspection failed — ALWAYS a secondary chip, never primary. */
  engineQueueError?: boolean;
  activeJobCount?: number;
  /** Campaign points currently claimed by running jobs (sum of the activity
   *  payload's backlogStrip runningPoints) — a POINTS unit, distinct from
   *  activeJobCount's ENGINE-JOB-BATCH unit (2026-07-06 user report: "7 jobs
   *  in flight but 15 are running?"). null/undefined = not carried by the
   *  caller's payload; the headline then labels the job count "engine jobs"
   *  instead of inventing a points number. */
  campaignPointsSolving?: number | null;
  /** true while any pending work exists (sweeps, campaign points). */
  backlogOpen?: boolean;
}

export interface DerivedSolverState {
  state: SolverStateName;
  tone: SolverTone;
  headline: string;
  detail?: string;
  secondary: string[];
}

/** Mirrors the pinned GET /api/admin/campaigns list `solverState` block. */
export interface SolverStateListPayload {
  heartbeatAt: string | null;
  enabled: boolean;
  engineUnreachableSince: string | null;
  engineHealthy: boolean;
  activeJobCount: number;
}

export function heartbeatAgeMs(heartbeatAt: string | null, nowMs: number = Date.now()): number | null {
  if (!heartbeatAt) return null;
  const t = new Date(heartbeatAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

/** null / unparsable / >90 s stale heartbeat ⇒ the process is not running. */
export function isProcessDead(heartbeatAt: string | null, nowMs: number = Date.now()): boolean {
  const age = heartbeatAgeMs(heartbeatAt, nowMs);
  return age == null || age > HEARTBEAT_STALE_MS;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export function solverStateLabel(state: SolverStateName): string {
  switch (state) {
    case "unknown":
      return "STATUS UNKNOWN";
    case "process_not_running":
      return "PROCESS NOT RUNNING";
    case "paused":
      return "PAUSED";
    case "engine_unreachable":
      return "ENGINE UNREACHABLE";
    case "engine_unhealthy":
      return "ENGINE UNHEALTHY";
    case "idle":
      return "IDLE";
    case "running":
      return "RUNNING";
  }
}

/** Compact hub chip copy (approved mockups): "solver · running · N jobs" /
 *  "solver · paused" / "solver · process not running" / … */
export function solverChipText(state: SolverStateName, activeJobCount?: number): string {
  switch (state) {
    case "running":
      return activeJobCount != null
        ? `solver · running · ${activeJobCount} job${activeJobCount === 1 ? "" : "s"}`
        : "solver · running";
    case "idle":
      return "solver · idle";
    case "paused":
      return "solver · paused";
    case "process_not_running":
      return "solver · process not running";
    case "engine_unreachable":
      return "solver · engine unreachable";
    case "engine_unhealthy":
      return "solver · engine unhealthy";
    case "unknown":
      return "solver · status unknown";
  }
}

/** GATE PRECEDENCE (approved design, binding):
 *  fetch failed → unknown; heartbeat null/stale → process_not_running;
 *  alive+disabled → paused; alive+enabled+unreachable → engine_unreachable;
 *  reachable but unhealthy/build-mismatch → engine_unhealthy (advisory);
 *  else running / idle. engineQueueError is always secondary. */
export function deriveSolverState(input: SolverStateInput, nowMs: number = Date.now()): DerivedSolverState {
  const secondary: string[] = [];
  if (input.engineQueueError) secondary.push("celery introspection unavailable");

  if (!input.fetchOk) {
    return {
      state: "unknown",
      tone: "amber",
      headline: "Solver status unknown — the status endpoint has not responded.",
      detail: "No state is assumed while status is unavailable.",
      secondary,
    };
  }

  const age = heartbeatAgeMs(input.heartbeatAt, nowMs);
  if (age == null || age > HEARTBEAT_STALE_MS) {
    if (input.engineUnreachableSince) {
      secondary.unshift(`engine also unreachable since ${timeOfDay(input.engineUnreachableSince)}`);
    }
    return {
      state: "process_not_running",
      tone: "red",
      headline:
        age == null
          ? "Solver process is not running — it has never reported a heartbeat."
          : `Solver process is not running — last heartbeat ${formatAge(age)} ago.`,
      detail: PROCESS_NOT_RUNNING_DETAIL,
      secondary,
    };
  }

  if (!input.enabled) {
    if (input.engineUnreachableSince) {
      secondary.unshift(
        `engine also unreachable since ${timeOfDay(input.engineUnreachableSince)} — resuming will hold in backoff`,
      );
    }
    return {
      state: "paused",
      tone: "amber",
      headline: "Paused — no new submissions are scheduled.",
      detail: "Already-started OpenFOAM processes continue until they finish or are cancelled.",
      secondary,
    };
  }

  if (input.engineUnreachableSince) {
    return {
      state: "engine_unreachable",
      tone: "red",
      headline: `Engine unreachable since ${timeOfDay(input.engineUnreachableSince)} — no jobs are being submitted.`,
      detail: "Submissions are held with backoff; composed work is released, jobs are not marked failed.",
      secondary,
    };
  }

  if (!input.engineHealthy || input.engineBuildMismatch) {
    return {
      state: "engine_unhealthy",
      tone: "amber",
      headline: input.engineBuildMismatch
        ? "Engine build mismatch — the running engine build differs from the expected build."
        : "Engine reachable but reporting unhealthy.",
      detail: "Advisory — scheduling continues; inspect the Engine tab.",
      secondary,
    };
  }

  const heartbeat = `heartbeat ${formatAge(age)} ago`;
  if (input.activeJobCount === 0 && input.backlogOpen === false) {
    return {
      state: "idle",
      tone: "teal",
      headline: `Idle — running, nothing pending · ${heartbeat}`,
      detail: "The next enabled sweep or campaign point will be picked up automatically.",
      secondary,
    };
  }
  // Unit-label truth (2026-07-06 "7 jobs in flight but 15 are running?"):
  // the banner counts ENGINE JOB BATCHES while the campaign backlog strip
  // counts POINTS. When the same payload carries the campaign points-solving
  // total, both units render side by side; otherwise the job count is
  // labelled "engine jobs" so it can never read as a points count.
  // campaignPointsSolving covers CAMPAIGN points only, so 0 is treated as
  // absent — printing "0 points solving" next to live background gap-fill
  // jobs (whose non-campaign points ARE solving) would be a false number.
  const jobsInFlight =
    input.activeJobCount != null
      ? input.campaignPointsSolving != null && input.campaignPointsSolving > 0
        ? `${input.activeJobCount} job${input.activeJobCount === 1 ? "" : "s"} in flight · ${input.campaignPointsSolving.toLocaleString()} point${input.campaignPointsSolving === 1 ? "" : "s"} solving`
        : `${input.activeJobCount} engine job${input.activeJobCount === 1 ? "" : "s"} in flight`
      : null;
  return {
    state: "running",
    tone: "teal",
    headline: jobsInFlight != null ? `Running — ${jobsInFlight} · ${heartbeat}` : `Running — ${heartbeat}`,
    secondary,
  };
}
