import {
  registeredRemoteSolvers,
  simJobs,
  sweeperState,
  type DB,
} from "@aerodb/db";
import { count, sql } from "drizzle-orm";

import type { SystemHealthSample } from "./system-health";
import { parseRemoteSolverHealth } from "./remote-solver-health";

const PERFORMANCE_WINDOW_DAYS = 7;
const ONLINE_AFTER_MS = 3 * 60_000;
const STALE_AFTER_MS = 15 * 60_000;

type FidelityKey = "rans" | "urans_precalc" | "urans_full";

interface ThroughputRow {
  day?: string;
  source_id: string;
  source_name: string;
  source_kind: "local" | "remote";
  fidelity: string | null;
  points: number | string;
}

interface DailyPointCounts {
  day: string;
  rans: number;
  preliminary: number;
  final: number;
  total: number;
}

function emptyCounts(day: string): DailyPointCounts {
  return { day, rans: 0, preliminary: 0, final: 0, total: 0 };
}

function addFidelity(
  counts: DailyPointCounts,
  fidelity: string | null,
  amount: number,
): void {
  if (fidelity === "rans") counts.rans += amount;
  if (fidelity === "urans_precalc") counts.preliminary += amount;
  if (fidelity === "urans_full") counts.final += amount;
  counts.total += amount;
}

function utcDays(count: number): string[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - (count - index - 1));
    return day.toISOString().slice(0, 10);
  });
}

function connectivity(
  lastHeartbeatAt: Date | null,
): "online" | "stale" | "offline" {
  if (!lastHeartbeatAt) return "offline";
  const age = Date.now() - lastHeartbeatAt.getTime();
  if (age <= ONLINE_AFTER_MS) return "online";
  if (age <= STALE_AFTER_MS) return "stale";
  return "offline";
}

async function throughputRows(
  db: DB,
  predicate: ReturnType<typeof sql>,
  includeDay: boolean,
): Promise<ThroughputRow[]> {
  const daySelect = includeDay
    ? sql`date_trunc('day', r."solvedAt" AT TIME ZONE 'UTC')::date::text AS day,`
    : sql``;
  const dayGroup = includeDay ? sql`, 1` : sql``;
  const sourcePosition = includeDay ? sql`2, 3, 4, 5` : sql`1, 2, 3, 4`;
  return (await db.execute(sql`
    WITH remote_owner AS (
      SELECT DISTINCT ON (point.result_id)
        point.result_id,
        promise.registered_solver_id,
        remote.instance_name
      FROM sync_sweep_promise_points point
      JOIN sync_sweep_promises promise ON promise.id = point.promise_id
      LEFT JOIN registered_remote_solvers remote
        ON remote.id = promise.registered_solver_id
      WHERE point.result_id IS NOT NULL
        AND point.status = 'fulfilled'
      ORDER BY point.result_id, point."updatedAt" DESC, point.id DESC
    )
    SELECT
      ${daySelect}
      COALESCE(owner.registered_solver_id::text, 'local') AS source_id,
      COALESCE(owner.instance_name, 'Production') AS source_name,
      CASE
        WHEN owner.registered_solver_id IS NULL THEN 'local'
        ELSE 'remote'
      END AS source_kind,
      r.fidelity,
      count(*)::integer AS points
    FROM results r
    JOIN result_classifications classification
      ON classification.result_id = r.id
      AND classification.state = 'accepted'
    LEFT JOIN remote_owner owner ON owner.result_id = r.id
    WHERE r.status = 'done'
      AND r.source = 'solved'
      AND r."solvedAt" IS NOT NULL
      AND ${predicate}
    GROUP BY ${sourcePosition}${dayGroup}
    ORDER BY ${includeDay ? sql`day,` : sql``} source_name, r.fidelity
  `)) as unknown as ThroughputRow[];
}

export async function solverFleetHealth(
  db: DB,
  localHealth: SystemHealthSample,
) {
  const [remoteRows, localExecutionRows, sweeperRows, dailyRows, rows24h] =
    await Promise.all([
      db
        .select()
        .from(registeredRemoteSolvers)
        .orderBy(registeredRemoteSolvers.instanceName),
      db
        .select({
          activeJobs: count(),
          reservedCpuSlots: sql<number>`COALESCE(SUM(GREATEST(${simJobs.admissionCpuSlots}, 1)), 0)::integer`,
        })
        .from(simJobs).where(sql`(
          ${simJobs.status} IN ('submitted', 'running')
          OR (
            ${simJobs.status} = 'pending'
            AND ${simJobs.engineState} = 'submitting'
          )
          OR (
            ${simJobs.status} = 'cancelled'
            AND ${simJobs.engineState} IN ('cancelling', 'cancel_pending')
          )
        )`),
      db.select().from(sweeperState).limit(1),
      throughputRows(
        db,
        sql`r."solvedAt" >= CURRENT_DATE - (${PERFORMANCE_WINDOW_DAYS - 1} * interval '1 day')`,
        true,
      ),
      throughputRows(
        db,
        sql`r."solvedAt" >= now() - interval '24 hours'`,
        false,
      ),
    ]);

  const localExecution = localExecutionRows[0];
  const localSweeper = sweeperRows[0];
  const days = utcDays(PERFORMANCE_WINDOW_DAYS);
  const overallByDay = new Map(
    days.map((day) => [day, emptyCounts(day)] as const),
  );
  const sourceMeta = new Map<
    string,
    { id: string; name: string; kind: "local" | "remote" }
  >([
    ["local", { id: "local", name: "Production", kind: "local" as const }],
    ...remoteRows.map(
      (row) =>
        [
          row.id,
          { id: row.id, name: row.instanceName, kind: "remote" as const },
        ] as const,
    ),
  ]);
  const sourceDaily = new Map<string, Map<string, DailyPointCounts>>();
  const ensureSourceDays = (sourceId: string) => {
    const existing = sourceDaily.get(sourceId);
    if (existing) return existing;
    const created = new Map(
      days.map((day) => [day, emptyCounts(day)] as const),
    );
    sourceDaily.set(sourceId, created);
    return created;
  };
  for (const sourceId of sourceMeta.keys()) ensureSourceDays(sourceId);

  for (const row of dailyRows) {
    if (!row.day || !overallByDay.has(row.day)) continue;
    const amount = Number(row.points) || 0;
    addFidelity(overallByDay.get(row.day)!, row.fidelity, amount);
    if (!sourceMeta.has(row.source_id)) {
      sourceMeta.set(row.source_id, {
        id: row.source_id,
        name: row.source_name,
        kind: row.source_kind,
      });
    }
    addFidelity(
      ensureSourceDays(row.source_id).get(row.day)!,
      row.fidelity,
      amount,
    );
  }

  const totals24h = emptyCounts("24h");
  const source24h = new Map<string, DailyPointCounts>();
  for (const sourceId of sourceMeta.keys())
    source24h.set(sourceId, emptyCounts("24h"));
  for (const row of rows24h) {
    const amount = Number(row.points) || 0;
    addFidelity(totals24h, row.fidelity, amount);
    if (!sourceMeta.has(row.source_id)) {
      sourceMeta.set(row.source_id, {
        id: row.source_id,
        name: row.source_name,
        kind: row.source_kind,
      });
    }
    const current = source24h.get(row.source_id) ?? emptyCounts("24h");
    addFidelity(current, row.fidelity, amount);
    source24h.set(row.source_id, current);
  }

  const localStorage = localHealth.storage
    ? {
        usedPct: localHealth.storage.usedPct,
        freeBytes: localHealth.storage.freeBytes,
        requiredFreeBytes: localSweeper?.diskRequiredFreeBytes ?? null,
        admissionBlocked: localSweeper?.diskAdmissionBlocked ?? false,
        reason: localSweeper?.diskAdmissionReason ?? null,
        checkedAt: localSweeper?.diskCheckedAt?.toISOString() ?? null,
      }
    : null;

  return {
    fleet: {
      local: {
        id: "local",
        instanceName: process.env.INSTANCE_NAME || "Production",
        connectivity: "online" as const,
        status: localSweeper?.enabled === false ? "paused" : "running",
        lastHeartbeatAt: localSweeper?.heartbeatAt?.toISOString() ?? null,
        activeJobs: Number(localExecution?.activeJobs ?? 0),
        reservedCpuSlots: Number(localExecution?.reservedCpuSlots ?? 0),
        capacityCpuSlots: Number(localSweeper?.cpuSlots ?? 0),
        health: {
          schemaVersion: 1 as const,
          sampledAt: localHealth.at,
          cpu: localHealth.cpu,
          memory: localHealth.memory,
          storage: localStorage,
          execution: {
            activeJobs: Number(localExecution?.activeJobs ?? 0),
            reservedCpuSlots: Number(localExecution?.reservedCpuSlots ?? 0),
            capacityCpuSlots: Number(localSweeper?.cpuSlots ?? 0),
            activeAoaCount: 0,
          },
        },
      },
      remotes: remoteRows.map((row) => {
        const health = parseRemoteSolverHealth(row.metadata);
        return {
          id: row.id,
          instanceName: row.instanceName,
          connectivity: connectivity(row.lastHeartbeatAt),
          status: row.status,
          lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
          activeJobs: health?.execution.activeJobs ?? 0,
          reservedCpuSlots: health?.execution.reservedCpuSlots ?? 0,
          capacityCpuSlots: health?.execution.capacityCpuSlots ?? row.cpuBudget,
          activePromiseCount: row.activePromiseCount,
          activeAoaCount: row.activeAoaCount,
          solvedCount: row.solvedCount,
          pushedCount: row.pushedCount,
          recentError: row.recentError,
          buildVersion: row.buildVersion,
          health,
        };
      }),
    },
    performance: {
      windowDays: PERFORMANCE_WINDOW_DAYS,
      daily: days.map((day) => overallByDay.get(day)!),
      totals24h,
      sources: Array.from(sourceMeta.values()).map((source) => {
        const daily = days.map((day) => ensureSourceDays(source.id).get(day)!);
        const total = daily.reduce((sum, item) => sum + item.total, 0);
        return {
          ...source,
          totals24h: source24h.get(source.id) ?? emptyCounts("24h"),
          averagePerDay: total / PERFORMANCE_WINDOW_DAYS,
          daily,
        };
      }),
    },
  };
}
