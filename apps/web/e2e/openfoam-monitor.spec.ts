import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";
const monitorIntervalMs = Number(process.env.OPENFOAM_MONITOR_INTERVAL_MS ?? "600000");
const monitorTimeoutMs = Number(process.env.OPENFOAM_MONITOR_TIMEOUT_MS ?? String(7 * 24 * 60 * 60 * 1000));
const monitorMaxIterations = Number(process.env.OPENFOAM_MONITOR_MAX_ITERATIONS ?? "0");
const maxNoProgressMs = Number(process.env.OPENFOAM_MONITOR_MAX_NO_PROGRESS_MS ?? String(45 * 60 * 1000));

const phaseBudgetsMs: Record<string, number> = {
  pending: Number(process.env.OPENFOAM_MONITOR_PENDING_MAX_MS ?? String(20 * 60 * 1000)),
  waiting_cpu: Number(process.env.OPENFOAM_MONITOR_WAITING_CPU_MAX_MS ?? String(30 * 60 * 1000)),
  meshing: Number(process.env.OPENFOAM_MONITOR_MESHING_MAX_MS ?? String(10 * 60 * 1000)),
  solving_rans: Number(process.env.OPENFOAM_MONITOR_RANS_CASE_MAX_MS ?? String(30 * 60 * 1000)),
  solving_urans: Number(process.env.OPENFOAM_MONITOR_URANS_CASE_MAX_MS ?? String(120 * 60 * 1000)),
  postprocessing: Number(process.env.OPENFOAM_MONITOR_POSTPROCESSING_MAX_MS ?? String(20 * 60 * 1000)),
  ingesting: Number(process.env.OPENFOAM_MONITOR_INGESTING_MAX_MS ?? String(10 * 60 * 1000)),
};

interface QueueJob {
  id: string;
  engineJobId?: string | null;
  airfoilSlug: string | null;
  status: string;
  engineState?: string | null;
  stale: boolean;
  pendingAgeSec: number;
  phase?: string | null;
  phaseStartedAt?: string | null;
  lastProgressAt?: string | null;
  activeSolver?: string | null;
  activeAoaDeg?: number | null;
  activeCaseSlug?: string | null;
  processCount?: number | null;
  cpuTokensWaiting?: number | null;
  cpuTokensHeld?: number | null;
  completedCases?: number;
  totalCases?: number;
  runtimeState?: string | null;
  staleReason?: string | null;
}

interface AdminQueue {
  sweeper: { enabled: boolean; maxConcurrentJobs: number; heartbeatAt: string | null };
  pendingSweepsTotal: number;
  pendingPointsTotal: number;
  results: Record<string, number>;
  engineQueue: {
    queue_depth?: number | null;
    active_count?: number | null;
    reserved_count?: number | null;
  } | null;
  engineQueueError: string | null;
  activeJobs: QueueJob[];
  finishedJobs: QueueJob[];
}

interface ProgressSnapshot {
  solvedRows: number;
  failedRows: number;
  pendingSweepsTotal: number;
  pendingPointsTotal: number;
  activeJobIds: Set<string>;
  jobCases: Map<string, number>;
  jobSteps: Map<string, string>;
}

test.describe.serial("observe existing OpenFOAM sweep", () => {
  test.skip(process.env.RUN_OPENFOAM_MONITOR !== "1", "Set RUN_OPENFOAM_MONITOR=1 to passively monitor the existing OpenFOAM sweep.");
  test.setTimeout(0);

  let artifactDir = "";

  test.beforeAll(async () => {
    artifactDir = path.resolve(process.cwd(), ".codex-artifacts", "openfoam-long-run-monitor", new Date().toISOString().replace(/[:.]/g, "-"));
    await fs.mkdir(artifactDir, { recursive: true });
  });

  test("queue progress until completion", async ({ page, request }) => {
    await preflight(request);
    let previous: ProgressSnapshot | null = null;
    let noProgressSince: number | null = null;
    const startedAt = Date.now();

    for (let iteration = 0; ; iteration++) {
      const now = Date.now();
      const queue = await getQueue(request);
      const current = snapshotProgress(queue);
      const budgetViolations = findBudgetViolations(queue, now);
      const runtimeTruthViolations = queue.activeJobs.filter(lacksRuntimeTruth);
      const progress = previous === null || hasProgress(previous, current);
      noProgressSince = progress ? null : noProgressSince ?? now;
      await appendProgress(`monitor-${iteration}`, queue, { budgetViolations, runtimeTruthViolations, progress, noProgressMs: noProgressSince === null ? 0 : now - noProgressSince });
      await captureQueue(page, `monitor-${String(iteration).padStart(4, "0")}`);

      if (queue.engineQueueError) throw new Error(`Engine queue unavailable: ${queue.engineQueueError}`);

      if (runtimeTruthViolations.length > 0) throw new Error(formatRuntimeTruthError(runtimeTruthViolations));
      if (budgetViolations.length > 0) throw new Error(formatBudgetError(budgetViolations));

      if (noProgressSince !== null && now - noProgressSince > maxNoProgressMs) {
        throw new Error(formatNoProgressError(queue, now - noProgressSince));
      }
      previous = current;

      const engineQueued = queue.engineQueue?.queue_depth ?? 0;
      const engineActive = queue.engineQueue?.active_count ?? 0;
      const engineReserved = queue.engineQueue?.reserved_count ?? 0;
      if (queue.pendingSweepsTotal === 0 && queue.activeJobs.length === 0 && engineQueued === 0 && engineActive === 0 && engineReserved === 0) {
        await appendEvent("complete", { at: new Date().toISOString() });
        await captureQueue(page, "complete");
        return;
      }

      if (monitorMaxIterations > 0 && iteration + 1 >= monitorMaxIterations) {
        await appendEvent("max-iterations", { iterations: iteration + 1, at: new Date().toISOString() });
        return;
      }

      if (now - startedAt > monitorTimeoutMs) {
        throw new Error(`OpenFOAM monitor exceeded ${monitorTimeoutMs}ms without completion.`);
      }

      await page.waitForTimeout(monitorIntervalMs);
    }
  });

  async function preflight(request: APIRequestContext) {
    const health = await request.get(`${apiURL}/health`);
    expect(health.ok(), `API health should be OK, got ${health.status()}`).toBeTruthy();
    const queue = await getQueue(request);
    expect(queue.engineQueueError, "OpenFOAM engine queue should be visible before monitoring").toBeNull();
  }

  async function getQueue(request: APIRequestContext): Promise<AdminQueue> {
    return json<AdminQueue>(request, "get", "/api/admin/queue");
  }

  async function appendProgress(
    labelText: string,
    queue: AdminQueue,
    health: { budgetViolations: BudgetViolation[]; runtimeTruthViolations: QueueJob[]; progress: boolean; noProgressMs: number },
  ) {
    const activeCompletedCases = queue.activeJobs.reduce((sum, job) => sum + (job.completedCases ?? 0), 0);
    const progressedActiveJobs = queue.activeJobs.filter((job) => (job.completedCases ?? 0) > 0 || job.lastProgressAt);
    const entry = {
      at: new Date().toISOString(),
      label: labelText,
      sweeperEnabled: queue.sweeper.enabled,
      sweeperHeartbeatAt: queue.sweeper.heartbeatAt,
      pendingSweepsTotal: queue.pendingSweepsTotal,
      pendingPointsTotal: queue.pendingPointsTotal,
      activeJobs: queue.activeJobs.length,
      staleJobs: queue.activeJobs.filter((job) => job.stale).length,
      celeryQueued: queue.engineQueue?.queue_depth ?? null,
      celeryActive: queue.engineQueue?.active_count ?? null,
      celeryReserved: queue.engineQueue?.reserved_count ?? null,
      failedRows: queue.results.failed ?? 0,
      solvedRows: queue.results.solved ?? 0,
      activeCompletedCases,
      progressedActiveJobs: progressedActiveJobs.length,
      progress: health.progress,
      noProgressMs: health.noProgressMs,
      budgetViolations: health.budgetViolations,
      runtimeTruthViolations: health.runtimeTruthViolations.map((job) => summarizeJob(job)),
      activeProgressSample: progressedActiveJobs.slice(0, 8).map((job) => summarizeJob(job)),
      activeSample: queue.activeJobs.slice(0, 8).map((job) => ({
        id: job.id,
        engineJobId: job.engineJobId ?? null,
        airfoilSlug: job.airfoilSlug,
        status: job.status,
        engineState: job.engineState ?? null,
        phase: job.phase ?? null,
        phaseStartedAt: job.phaseStartedAt ?? null,
        lastProgressAt: job.lastProgressAt ?? null,
        activeSolver: job.activeSolver ?? null,
        activeAoaDeg: job.activeAoaDeg ?? null,
        activeCaseSlug: job.activeCaseSlug ?? null,
        processCount: job.processCount ?? null,
        cpuTokensWaiting: job.cpuTokensWaiting ?? null,
        cpuTokensHeld: job.cpuTokensHeld ?? null,
        completedCases: job.completedCases ?? null,
        totalCases: job.totalCases ?? null,
        ageSec: job.pendingAgeSec,
        stale: job.stale,
        runtimeState: job.runtimeState ?? null,
      })),
      latestFinished: queue.finishedJobs.slice(0, 5).map((job) => ({ id: job.id, airfoilSlug: job.airfoilSlug, status: job.status })),
    };
    await fs.appendFile(path.join(artifactDir, "progress.jsonl"), JSON.stringify(entry) + "\n");
    console.log(
      `[openfoam-monitor] ${entry.label} pending=${entry.pendingSweepsTotal} points=${entry.pendingPointsTotal} active=${entry.activeJobs} activeCasesDone=${entry.activeCompletedCases} progressedJobs=${entry.progressedActiveJobs} celery=${entry.celeryQueued}/${entry.celeryActive}/${entry.celeryReserved} stale=${entry.staleJobs} failed=${entry.failedRows} solved=${entry.solvedRows} progress=${entry.progress ? "yes" : `no:${Math.round(entry.noProgressMs / 1000)}s`} budget=${entry.budgetViolations.length}`,
    );
  }

  async function appendEvent(type: string, payload: unknown) {
    await fs.appendFile(path.join(artifactDir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, payload }) + "\n");
  }

  async function captureQueue(page: Page, name: string) {
    try {
      await page.goto("/admin");
      await expect(page.getByTestId("openfoam-queue-page")).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
    } catch (e) {
      await appendEvent("screenshot-failed", { name, error: (e as Error).message });
    }
  }
});

async function json<T>(request: APIRequestContext, method: "get" | "post" | "patch", urlPath: string, data?: unknown): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await request[method](`${apiURL}${urlPath}`, data === undefined ? undefined : { data, timeout: 30_000 });
      if (res.ok()) return (await res.json()) as T;
      const body = await res.text().catch(() => "");
      lastError = new Error(`${method.toUpperCase()} ${urlPath} -> ${res.status()} ${body}`);
      if (res.status() < 500 || attempt === 4) break;
    } catch (e) {
      lastError = e;
      if (attempt === 4) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function lacksRuntimeTruth(job: QueueJob): boolean {
  if (!["submitted", "running", "ingesting"].includes(job.status)) return false;
  const phase = job.phase ?? null;
  const processCount = job.processCount ?? 0;
  if (!phase) return processCount <= 0;
  if (phase === "pending") return false;
  if (phase === "waiting_cpu") return (job.cpuTokensWaiting ?? 0) <= 0 && (job.cpuTokensHeld ?? 0) <= 0 && processCount <= 0;
  if (phase === "meshing" || phase === "solving_rans" || phase === "solving_urans") {
    return !job.activeSolver && processCount <= 0;
  }
  return false;
}

interface BudgetViolation {
  job: ReturnType<typeof summarizeJob>;
  elapsedMs: number;
  budgetMs: number;
  stepStartedAt: string | null;
  reason: string;
}

function findBudgetViolations(queue: AdminQueue, now: number): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const job of queue.activeJobs.filter((j) => ["submitted", "running", "ingesting"].includes(j.status))) {
      const phase = job.phase ?? "unknown";
      const budgetMs = phaseBudgetsMs[phase];
    if (budgetMs == null) continue;
    if (phase === "waiting_cpu" && (job.cpuTokensWaiting ?? 0) <= 0 && (job.cpuTokensHeld ?? 0) <= 0) continue;
      const startedAt = stepStartedAt(job, now);
      const elapsedMs = startedAt == null ? 0 : Math.max(0, now - startedAt);
    if (startedAt == null || elapsedMs <= budgetMs) continue;
    violations.push({
        job: summarizeJob(job),
        elapsedMs,
        budgetMs,
        stepStartedAt: new Date(startedAt).toISOString(),
        reason: `${phase} step exceeded ${formatDuration(budgetMs)} budget`,
    });
  }
  return violations;
}

function stepStartedAt(job: QueueJob, now: number): number | null {
  const phase = job.phase ?? null;
  if (phase === "solving_rans" || phase === "solving_urans") {
    return parseTime(job.lastProgressAt) ?? parseTime(job.phaseStartedAt) ?? fallbackStartFromAge(job, now);
  }
  return parseTime(job.phaseStartedAt) ?? parseTime(job.lastProgressAt) ?? fallbackStartFromAge(job, now);
}

function fallbackStartFromAge(job: QueueJob, now: number): number | null {
  return Number.isFinite(job.pendingAgeSec) ? now - Math.max(0, job.pendingAgeSec) * 1000 : null;
}

function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function snapshotProgress(queue: AdminQueue): ProgressSnapshot {
  return {
    solvedRows: queue.results.solved ?? 0,
    failedRows: queue.results.failed ?? 0,
    pendingSweepsTotal: queue.pendingSweepsTotal,
    pendingPointsTotal: queue.pendingPointsTotal,
    activeJobIds: new Set(queue.activeJobs.map((job) => job.engineJobId ?? job.id)),
    jobCases: new Map(queue.activeJobs.map((job) => [job.engineJobId ?? job.id, job.completedCases ?? 0])),
    jobSteps: new Map(queue.activeJobs.map((job) => [job.engineJobId ?? job.id, stepKey(job)])),
  };
}

function hasProgress(previous: ProgressSnapshot, current: ProgressSnapshot): boolean {
  if (current.solvedRows > previous.solvedRows) return true;
  if (current.failedRows > previous.failedRows) return true;
  if (current.pendingSweepsTotal < previous.pendingSweepsTotal) return true;
  if (current.pendingPointsTotal < previous.pendingPointsTotal) return true;
  for (const [id, cases] of current.jobCases) {
    if (cases > (previous.jobCases.get(id) ?? -1)) return true;
  }
  for (const id of previous.activeJobIds) {
    if (!current.activeJobIds.has(id)) return true;
  }
  for (const [id, step] of current.jobSteps) {
    if (previous.jobSteps.has(id) && previous.jobSteps.get(id) !== step) return true;
  }
  return false;
}

function stepKey(job: QueueJob): string {
  return [
    job.status,
    job.phase ?? "",
    job.activeSolver ?? "",
    job.activeCaseSlug ?? "",
    job.activeAoaDeg ?? "",
    job.completedCases ?? "",
  ].join("|");
}

function summarizeJob(job: QueueJob) {
  return {
    id: job.id,
    engineJobId: job.engineJobId ?? null,
    airfoilSlug: job.airfoilSlug,
    status: job.status,
    engineState: job.engineState ?? null,
    phase: job.phase ?? null,
    phaseStartedAt: job.phaseStartedAt ?? null,
    lastProgressAt: job.lastProgressAt ?? null,
    activeSolver: job.activeSolver ?? null,
    activeAoaDeg: job.activeAoaDeg ?? null,
    activeCaseSlug: job.activeCaseSlug ?? null,
    processCount: job.processCount ?? null,
    cpuTokensWaiting: job.cpuTokensWaiting ?? null,
    cpuTokensHeld: job.cpuTokensHeld ?? null,
    completedCases: job.completedCases ?? null,
    totalCases: job.totalCases ?? null,
    pendingAgeSec: job.pendingAgeSec,
    stale: job.stale,
    staleReason: job.staleReason ?? null,
    runtimeState: job.runtimeState ?? null,
  };
}

function formatRuntimeTruthError(jobs: QueueJob[]): string {
  return `Active jobs lack runtime phase/process truth: ${jobs
    .slice(0, 8)
    .map((job) => `${job.airfoilSlug ?? job.id}:phase=${job.phase ?? "none"} solver=${job.activeSolver ?? "none"} processes=${job.processCount ?? 0}`)
    .join(", ")}`;
}

function formatBudgetError(violations: BudgetViolation[]): string {
  return `OpenFOAM step budget exceeded: ${violations
    .slice(0, 8)
    .map(
      (v) =>
        `${v.job.airfoilSlug ?? v.job.id}:phase=${v.job.phase ?? "none"} aoa=${v.job.activeAoaDeg ?? "?"} case=${v.job.activeCaseSlug ?? "?"} elapsed=${formatDuration(v.elapsedMs)} budget=${formatDuration(v.budgetMs)} completed=${v.job.completedCases}/${v.job.totalCases}`,
    )
    .join("; ")}`;
}

function formatNoProgressError(queue: AdminQueue, noProgressMs: number): string {
  const sample = queue.activeJobs
    .slice(0, 8)
    .map((job) => `${job.airfoilSlug ?? job.id}:phase=${job.phase ?? "none"} aoa=${job.activeAoaDeg ?? "?"} completed=${job.completedCases ?? 0}/${job.totalCases ?? "?"}`)
    .join("; ");
  return `OpenFOAM monitor saw no solved/failed/job/case progress for ${formatDuration(noProgressMs)}. Active sample: ${sample}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 90) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return min ? `${hours}h${min}m` : `${hours}h`;
}
