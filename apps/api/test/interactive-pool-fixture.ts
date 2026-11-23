import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import {
  createClient,
  forceHistory,
  registeredRemoteSolvers,
  syncApiPermissions,
  syncApiSettings,
  syncSweepPromises,
  type DB,
} from "@aerodb/db";
import { COOKIE_NAME, signSession } from "../src/admin-auth";
import { createProgressiveReportFixture } from "./progressive-report-fixture";

/** Hold actual report import transactions at their dispatch lock. The observer
 * owns a separate connection so measuring contention cannot consume an API slot. */
export async function verifyInteractivePool(input: {
  db: DB;
  app: FastifyInstance;
  slots: number;
  slug: string;
  airfoilName: string;
  airfoilId: string;
  revisionId: string;
  bcId: string;
  resultId: string;
  attemptId: string;
}) {
  const { db, app, slots } = input;
  // Same offered load on the original ten-slot pool and the partitioned pools.
  const reportRequests = 11;
  const observer = createClient({
    max: 1,
    connection: { application_name: "test-report-lock-holder" },
  });
  const solverId = randomUUID(),
    promiseId = randomUUID(),
    token = randomUUID();
  const [settings] = await db
    .select({ enabled: syncApiSettings.enabled })
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1));
  const [permission] = await db
    .select({ canPush: syncApiPermissions.canPush })
    .from(syncApiPermissions)
    .where(eq(syncApiPermissions.dataType, "polars"));
  const [original] = await db
    .select()
    .from(forceHistory)
    .where(eq(forceHistory.resultAttemptId, input.attemptId));
  const t = Array.from({ length: 400 }, (_, i) => 10 + i / 100),
    cl = t.map((_, i) => 0.6 + i / 10000),
    cd = t.map((_, i) => 0.013 + i / 100000);
  let fixture:
    | Awaited<ReturnType<typeof createProgressiveReportFixture>>
    | undefined;
  let writers: Promise<{ statusCode: number; body: string }>[] = [];
  const timings: Record<string, number> = {};
  const read = (
    name: string,
    url: string,
    headers?: Record<string, string>,
  ) => {
    const started = performance.now();
    return app.inject({ method: "GET", url, headers }).then((response) => {
      timings[name] = Math.round(performance.now() - started);
      return response;
    });
  };
  const reads = () =>
    Promise.all([
      read(
        "point",
        `/api/airfoils/${input.slug}/sim?resultId=${input.resultId}`,
      ),
      read(
        "catalog",
        `/api/airfoils?q=${encodeURIComponent(input.airfoilName)}&limit=1`,
      ),
      read("admin", "/api/admin/sync", {
        cookie: `${COOKIE_NAME}=${signSession("operator@example.test")}`,
      }),
    ]);
  let reading: ReturnType<typeof reads> | undefined;
  try {
    await app.ready();
    await db
      .update(forceHistory)
      .set({ t, cl, cd, cm: null, sampleCount: t.length })
      .where(eq(forceHistory.id, original.id));
    await db
      .update(syncApiSettings)
      .set({ enabled: true })
      .where(eq(syncApiSettings.id, 1));
    await db
      .update(syncApiPermissions)
      .set({ canPush: true })
      .where(eq(syncApiPermissions.dataType, "polars"));
    await db.insert(registeredRemoteSolvers).values({
      id: solverId,
      instanceId: solverId,
      instanceName: "Pool isolation fixture",
      authTokenHash: createHash("sha256").update(token).digest("hex"),
      credentialVersion: 1,
    });
    await db.insert(syncSweepPromises).values({
      id: promiseId,
      sourceInstanceId: solverId,
      registeredSolverId: solverId,
      airfoilId: input.airfoilId,
      simulationPresetRevisionId: input.revisionId,
      aoaCount: 1,
      expiresAt: new Date(Date.now() + 3600000),
    });
    const report = await createProgressiveReportFixture({
      solverId,
      promiseId,
      airfoilId: input.airfoilId,
      revisionId: input.revisionId,
      bcId: input.bcId,
      alpha: 4,
    });
    fixture = report;
    const post = () =>
      app.inject({
        method: "POST",
        url: `/api/sync/v1/progressive-executions/${report.executionId}/reports`,
        headers: { "x-xfoilfoam-solver-token": token },
        payload: { promiseId, report: report.report },
      });
    let finishedWriters = 0;
    const observed = await observer.sql.begin(async (tx) => {
      await tx`SELECT sim_job_id FROM progressive_remote_dispatches WHERE sim_job_id=${report.executionId} FOR UPDATE`;
      // Count only real sessions blocked behind this fixture's transaction,
      // including tuple-lock waiters queued behind the first blocked writer.
      const waiters = async () => {
        await tx`SELECT pg_stat_clear_snapshot()`;
        return tx<
          { pid: number; application_name: string }[]
        >`WITH RECURSIVE chain(pid) AS (
          SELECT pg_backend_pid() UNION SELECT a.pid FROM chain c JOIN pg_stat_activity a
            ON c.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database())
          SELECT a.pid,a.application_name FROM pg_stat_activity a JOIN chain USING(pid)
          WHERE a.pid<>pg_backend_pid() AND a.wait_event_type='Lock'
            AND a.backend_type='client backend' AND a.application_name='xfoilfoam-api-sync'
            AND a.datname=current_database() AND a.usename=current_user
          ORDER BY a.pid`;
      };
      writers = Array.from({ length: reportRequests }, () =>
        post().then((response) => {
          finishedWriters++;
          return response;
        }),
      );
      const deadline = performance.now() + 15_000;
      let held = await waiters();
      while (
        held.length !== slots &&
        !finishedWriters &&
        performance.now() < deadline
      ) {
        await sleep(40);
        held = await waiters();
      }
      expect(
        held,
        "Expected all sync query slots to be held by actual report imports",
      ).toHaveLength(slots);
      const started = performance.now();
      reading = reads();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finishedBeforeRelease = await Promise.race([
        reading.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 4_000);
        }),
      ]).finally(() => clearTimeout(timer));
      const elapsedMs = Math.round(performance.now() - started),
        stillHeld = await waiters();
      return {
        finishedBeforeRelease,
        elapsedMs,
        routeMsBeforeRelease: { ...timings },
        held: held.map((x) => x.pid),
        stillHeld: stillHeld.map((x) => x.pid),
        applicationNames: [...new Set(held.map((x) => x.application_name))],
        finishedWriters,
      };
    });
    // Drain even on a regression. The report receipt and inventory are
    // committed once; the waiting requests must all acknowledge the same row.
    const responses = await Promise.all(writers);
    expect(responses.map((response) => response.statusCode)).toEqual(
      Array(reportRequests).fill(200),
    );
    const receipts = responses.map(
      (response) => JSON.parse(response.body).receipt,
    );
    expect(receipts.filter((row) => row.replayed === false)).toHaveLength(1);
    expect(receipts.filter((row) => row.replayed === true)).toHaveLength(
      reportRequests - 1,
    );
    expect(new Set(receipts.map((row) => row.contentSignature)).size).toBe(1);
    const [stored] =
      await observer.sql`SELECT (SELECT count(*)::int FROM progressive_remote_reports WHERE sim_job_id=${report.executionId}) AS reports,
      (SELECT count(*)::int FROM progressive_remote_report_inventories WHERE sim_job_id=${report.executionId}) AS inventories`;
    expect(stored).toEqual({ reports: 1, inventories: 1 });
    const [point, catalog, admin] = await reading!;
    expect(point.statusCode).toBe(200);
    expect(point.json()).toMatchObject({
      resultId: input.resultId,
      cl: 0.63,
      cd: 0.014,
      history: { t, cl, cd },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().items[0].slug).toBe(input.slug);
    expect(admin.statusCode).toBe(200);
    expect(
      admin
        .json()
        .registeredSolvers.some(
          (solver: { id: string }) => solver.id === solverId,
        ),
    ).toBe(true);
    console.info(
      "api-pool-contention",
      JSON.stringify({
        reportRequests,
        slots,
        waiters: observed.held.length,
        remainingWaiters: observed.stillHeld.length,
        finishedWriters: observed.finishedWriters,
        pointSamples: point.json().history.t.length,
        applicationNames: observed.applicationNames,
        interactiveElapsedMs: observed.elapsedMs,
        routeMsBeforeRelease: observed.routeMsBeforeRelease,
        completedWhileLocked: observed.finishedBeforeRelease,
      }),
    );
    expect(observed.stillHeld).toEqual(observed.held);
    expect(observed.finishedWriters).toBe(0);
    expect(
      observed.finishedBeforeRelease,
      "Interactive reads queued behind the held sync transactions",
    ).toBe(true);
    expect(observed.applicationNames).toEqual(["xfoilfoam-api-sync"]);
    expect(Object.keys(observed.routeMsBeforeRelease).sort()).toEqual([
      "admin",
      "catalog",
      "point",
    ]);
  } finally {
    await Promise.allSettled([...writers, ...(reading ? [reading] : [])]);
    try {
      await fixture?.cleanup();
      await db
        .delete(syncSweepPromises)
        .where(eq(syncSweepPromises.id, promiseId));
      await db
        .delete(registeredRemoteSolvers)
        .where(eq(registeredRemoteSolvers.id, solverId));
      await db
        .update(syncApiPermissions)
        .set(permission)
        .where(eq(syncApiPermissions.dataType, "polars"));
      await db
        .update(syncApiSettings)
        .set(settings)
        .where(eq(syncApiSettings.id, 1));
      await db
        .update(forceHistory)
        .set({
          t: original.t,
          cl: original.cl,
          cd: original.cd,
          cm: original.cm,
          sampleCount: original.sampleCount,
        })
        .where(eq(forceHistory.id, original.id));
    } finally {
      await observer.sql.end();
    }
  }
}
