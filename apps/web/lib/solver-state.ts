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

/** A tick that started this long ago without completing (while the liveness
 *  heartbeat stays fresh) is "stalled": the process is alive but a slow
 *  engine call is holding the current scheduler tick. Amber, never red —
 *  the 2026-07-06 prod incident showed a saturated engine starving the old
 *  in-tick heartbeat into a false "PROCESS NOT RUNNING". */
export const TICK_STALLED_AFTER_MS = 300_000;

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
  | "storage_blocked"
  | "tick_stalled"
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
  /** Tick-progress pair (liveness/progress split, migration 0033): stamped by
   *  the sweeper loop at tick begin/end. undefined/null (payload without the
   *  columns, or pre-migration DB) simply never derives tick_stalled. */
  lastTickStartedAt?: string | null;
  lastTickCompletedAt?: string | null;
  diskAdmissionBlocked?: boolean;
  diskAdmissionReason?: string | null;
  diskUsedPct?: number | null;
  diskFreeBytes?: number | null;
  diskRequiredFreeBytes?: number | null;
  diskCheckedAt?: string | null;
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
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  diskAdmissionBlocked?: boolean;
  diskAdmissionReason?: string | null;
  diskUsedPct?: number | null;
  diskFreeBytes?: number | null;
  diskRequiredFreeBytes?: number | null;
  diskCheckedAt?: string | null;
}

export function heartbeatAgeMs(
  heartbeatAt: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!heartbeatAt) return null;
  const t = new Date(heartbeatAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

/** null / unparsable / >90 s stale heartbeat ⇒ the process is not running.
 *  With the liveness/progress split this is TRUE process death: the liveness
 *  timer writes every 15 s regardless of tick work, so tick fields can never
 *  rescue (or excuse) a stale heartbeat. */
export function isProcessDead(
  heartbeatAt: string | null,
  nowMs: number = Date.now(),
): boolean {
  const age = heartbeatAgeMs(heartbeatAt, nowMs);
  return age == null || age > HEARTBEAT_STALE_MS;
}

/** How long the CURRENT tick has been running when it counts as stalled
 *  (started, not completed, older than 5 min); null otherwise. Unparsable
 *  stamps are treated as absent — never invent a stall. */
export function tickStalledForMs(
  lastTickStartedAt: string | null | undefined,
  lastTickCompletedAt: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!lastTickStartedAt) return null;
  const started = new Date(lastTickStartedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const completed = lastTickCompletedAt
    ? new Date(lastTickCompletedAt).getTime()
    : Number.NaN;
  if (Number.isFinite(completed) && completed >= started) return null; // last tick finished
  const age = nowMs - started;
  return age > TICK_STALLED_AFTER_MS ? age : null;
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
    case "storage_blocked":
      return "STORAGE BLOCKED";
    case "tick_stalled":
      return "TICK STALLED";
    case "idle":
      return "IDLE";
    case "running":
      return "RUNNING";
  }
}

/** Compact hub chip copy. Service readiness and active solve count are
 *  separate facts: an enabled healthy scheduler with zero active jobs is
 *  ready, not a running CFD solve. */
export function solverChipText(
  state: SolverStateName,
  activeJobCount?: number,
): string {
  switch (state) {
    case "running":
      if (activeJobCount === 0) return "scheduler · ready · 0 active jobs";
      return activeJobCount != null
        ? `scheduler · running · ${activeJobCount} active job${activeJobCount === 1 ? "" : "s"}`
        : "scheduler · running";
    case "idle":
      return "scheduler · ready";
    case "paused":
      return "scheduler · paused";
    case "process_not_running":
      return "scheduler · process not running";
    case "engine_unreachable":
      return "scheduler · engine unreachable";
    case "engine_unhealthy":
      return "scheduler · engine unhealthy";
    case "storage_blocked":
      return "scheduler · storage blocked";
    case "tick_stalled":
      return "scheduler · tick stalled";
    case "unknown":
      return "scheduler · status unknown";
  }
}

/** GATE PRECEDENCE (approved design, binding):
 *  fetch failed → unknown; heartbeat null/stale → process_not_running (TRUE
 *  process death now that liveness is an independent timer — red regardless
 *  of tick fields); alive+disabled → paused (the pinned paused-first order:
 *  while disabled, engine trouble and slow ticks are secondary because
 *  "scheduling continues" copy would be false); alive+enabled+unreachable →
 *  engine_unreachable; reachable but unhealthy/build-mismatch →
 *  engine_unhealthy (advisory); heartbeat fresh but the current tick started
 *  >5 min ago without completing → tick_stalled (AMBER, never red — the
 *  2026-07-06 false "PROCESS NOT RUNNING"); else running / idle. Enabled-path
 *  order matches the locked design: process death > engine unreachable >
 *  engine unhealthy > tick_stalled > healthy. engineQueueError is always
 *  secondary. */
export function deriveSolverState(
  input: SolverStateInput,
  nowMs: number = Date.now(),
): DerivedSolverState {
  const secondary: string[] = [];
  if (input.engineQueueError)
    secondary.push("celery introspection unavailable");
  if (input.diskAdmissionBlocked)
    secondary.push("new-job admission stopped by storage reserve");

  if (!input.fetchOk) {
    return {
      state: "unknown",
      tone: "amber",
      headline:
        "Solver status unknown — the status endpoint has not responded.",
      detail: "No state is assumed while status is unavailable.",
      secondary,
    };
  }

  const age = heartbeatAgeMs(input.heartbeatAt, nowMs);
  if (age == null || age > HEARTBEAT_STALE_MS) {
    if (input.engineUnreachableSince) {
      secondary.unshift(
        `engine also unreachable since ${timeOfDay(input.engineUnreachableSince)}`,
      );
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
      detail:
        "Already-started OpenFOAM processes continue until they finish or are cancelled.",
      secondary,
    };
  }

  if (input.engineUnreachableSince) {
    return {
      state: "engine_unreachable",
      tone: "red",
      headline: `Engine unreachable since ${timeOfDay(input.engineUnreachableSince)} — no jobs are being submitted.`,
      detail:
        "Submissions are held with backoff; composed work is released, jobs are not marked failed.",
      secondary,
    };
  }

  if (input.diskAdmissionBlocked) {
    return {
      state: "storage_blocked",
      tone: "amber",
      headline:
        "Storage reserve reached — existing evidence is safe; no new solver jobs are being submitted.",
      detail:
        input.diskAdmissionReason ??
        "Free storage before resuming job admission. Reconciliation and evidence ingestion continue automatically.",
      secondary: secondary.filter(
        (item) => item !== "new-job admission stopped by storage reserve",
      ),
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

  const stalledForMs = tickStalledForMs(
    input.lastTickStartedAt ?? null,
    input.lastTickCompletedAt ?? null,
    nowMs,
  );
  if (stalledForMs != null) {
    return {
      state: "tick_stalled",
      tone: "amber",
      headline: `Tick running ${formatAge(stalledForMs)} — engine responding slowly; scheduling continues next tick.`,
      detail:
        "Process heartbeat is fresh — the sweeper is alive; a slow engine call is holding the current scheduler tick.",
      secondary,
    };
  }

  const heartbeat = `heartbeat ${formatAge(age)} ago`;
  if (input.activeJobCount === 0 && input.backlogOpen === false) {
    return {
      state: "idle",
      tone: "teal",
      headline: `Idle — running, nothing pending · ${heartbeat}`,
      detail:
        "The next enabled sweep or campaign point will be picked up automatically.",
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
    headline:
      jobsInFlight != null
        ? `Running — ${jobsInFlight} · ${heartbeat}`
        : `Running — ${heartbeat}`,
    secondary,
  };
}
