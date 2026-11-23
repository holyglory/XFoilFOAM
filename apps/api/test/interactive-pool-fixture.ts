import { SYNC_REPORT_LIMIT } from "../src/sync-admission";
import { request as httpRequest } from "node:http";
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
import { syncSql } from "../src/db";
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
  const [sweepPermission] = await db
    .select({ canFetch: syncApiPermissions.canFetch })
    .from(syncApiPermissions)
    .where(eq(syncApiPermissions.dataType, "sweeps"));
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
  let sibling: typeof fixture;
  const siblingPromise = randomUUID();
  let releaseAck = () => {};
  let sawCommitted = () => {};
  const ackGate = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    sawCommitted = resolve;
  });
  let parsedHeaders = 0;
  let bothHeaders = () => {};
  const partialBodies = new Promise<void>((resolve) => {
    bothHeaders = resolve;
  });
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (req.headers["x-fixture-partial"] === "yes" && ++parsedHeaders === 2)
      bothHeaders();
    return payload;
  });
  app.addHook("onSend", async (req, _reply, body) => {
    if (req.headers["x-fixture-hold-ack"] === "yes") {
      sawCommitted();
      await ackGate;
    }
    return body;
  });
  let heldFetch: Promise<unknown> | undefined;
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
    await db
      .update(syncApiPermissions)
      .set({ canFetch: true })
      .where(eq(syncApiPermissions.dataType, "sweeps"));
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
    await db.insert(syncSweepPromises).values({
      id: siblingPromise,
      sourceInstanceId: solverId,
      registeredSolverId: solverId,
      airfoilId: input.airfoilId,
      simulationPresetRevisionId: input.revisionId,
      aoaCount: 1,
      expiresAt: new Date(Date.now() + 3600000),
    });
    sibling = await createProgressiveReportFixture({
      solverId,
      promiseId: siblingPromise,
      airfoilId: input.airfoilId,
      revisionId: input.revisionId,
      bcId: input.bcId,
      alpha: 5,
    });
    const live = sibling;
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const post = (
      target: typeof report,
      promise: string,
      sequence: number,
      signal?: AbortSignal,
      hold = false,
    ) =>
      fetch(
        `${base}/api/sync/v1/progressive-executions/${target.executionId}/reports`,
        {
          method: "POST",
          headers: {
            "x-xfoilfoam-solver-token": token,
            "content-type": "application/json",
            ...(hold ? { "x-fixture-hold-ack": "yes" } : {}),
          },
          body: JSON.stringify({
            promiseId: promise,
            report: { ...target.report, sequence },
          }),
          signal: signal ?? AbortSignal.timeout(6000),
        },
      );
    const heartbeat = () =>
      fetch(`${base}/api/sync/v1/sweeps/${promiseId}/heartbeat`, {
        method: "POST",
        headers: {
          "x-xfoilfoam-solver-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttlHours: 1 }),
        signal: AbortSignal.timeout(5000),
      });
    const getControl = () =>
      fetch(
        `${base}/api/sync/v1/progressive-executions/${report.executionId}/control`,
        {
          headers: { "x-xfoilfoam-solver-token": token },
          signal: AbortSignal.timeout(5000),
        },
      );
    const abort = new AbortController();
    let rejected = 0,
      acks = 0,
      beats = 0;
    await observer.sql.begin(async (tx) => {
      await tx`SELECT sim_job_id FROM progressive_remote_dispatches WHERE sim_job_id=${report.executionId} FOR UPDATE`;
      const waiters = async () => {
        await tx`SELECT pg_stat_clear_snapshot()`;
        return tx<
          { pid: number; application_name: string }[]
        >`WITH RECURSIVE chain(pid) AS (
          SELECT pg_backend_pid() UNION SELECT a.pid FROM pg_stat_activity a JOIN chain c
            ON c.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database())
          SELECT a.pid,a.application_name FROM pg_stat_activity a JOIN chain USING(pid)
          WHERE a.pid<>pg_backend_pid() AND a.wait_event_type='Lock' AND a.backend_type='client backend'
            AND a.application_name='xfoilfoam-api-sync' AND a.datname=current_database() AND a.usename=current_user
          ORDER BY a.pid`;
      };
      const openSibling = new Error(
        "release only the second fixture dispatch lock",
      );
      let second: Promise<Response> | undefined;
      try {
        await tx.savepoint(async (inner) => {
          await inner`SELECT sim_job_id FROM progressive_remote_dispatches WHERE sim_job_id=${live.executionId} FOR UPDATE`;
          heldFetch = post(report, promiseId, 1, abort.signal).catch(
            () => null,
          );
          second = post(live, siblingPromise, 1);
          const deadline = performance.now() + 6000;
          let held = await waiters();
          while (
            held.length < SYNC_REPORT_LIMIT &&
            performance.now() < deadline
          ) {
            await sleep(30);
            held = await waiters();
          }
          expect(
            held.length,
            "admitted report writers must actually block on this gate backend",
          ).toBe(SYNC_REPORT_LIMIT);
          expect(new Set(held.map((x) => x.pid)).size).toBe(SYNC_REPORT_LIMIT);
          const reserved = await Promise.all(
            Array.from({ length: slots - SYNC_REPORT_LIMIT }, () =>
              syncSql.reserve(),
            ),
          );
          try {
            const hr = await heartbeat();
            expect(hr.status).toBe(200);
            expect(await hr.json()).toMatchObject({ ok: true });
            beats++;
            const control = await getControl();
            expect(control.status).toBe(200);
            await control.arrayBuffer();
            reading = reads();
            await Promise.race([
              reading,
              sleep(4000).then(() => {
                throw new Error("Interactive reads queued behind data writers");
              }),
            ]);
            expect(await waiters()).toEqual(held);
            abort.abort();
            await heldFetch;
            const busy = await post(report, promiseId, 1);
            expect(busy.status).toBe(503);
            expect(await busy.json()).toMatchObject({
              code: "sync_capacity_busy",
            });
            expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
            expect(await waiters()).toEqual(held);
          } finally {
            for (const slot of reserved) slot.release();
          }
          throw openSibling;
        });
      } catch (e) {
        if (e !== openSibling) throw e;
      }
      const released = await second!;
      expect(released.status).toBe(200);
      expect((await released.json()).receipt).toMatchObject({
        sequence: 1,
        replayed: false,
      });
      acks++;
      // Maintain retry pressure on the abandoned execution while a different
      // dispatch publishes consecutive real reports through the normal route.
      for (let n = 2; n <= 7; n++) {
        const retries = Array.from({ length: reportRequests }, async () => {
          const r = await post(report, promiseId, 1);
          expect(r.status).toBe(503);
          expect(r.headers.get("retry-after")).toMatch(/^[2-4]$/);
          const body = await r.json();
          expect(body).toMatchObject({ code: "sync_capacity_busy" });
          expect(body).not.toHaveProperty("receipt");
          rejected++;
        });
        const [accepted, hb] = await Promise.all([
          post(live, siblingPromise, n),
          heartbeat(),
          ...retries,
        ]);
        expect(accepted.status).toBe(200);
        expect((await accepted.json()).receipt).toMatchObject({
          sequence: n,
          replayed: false,
        });
        acks++;
        expect(hb.status).toBe(200);
        await hb.arrayBuffer();
        beats++;
      }
      reading = reads();
      await Promise.race([
        reading,
        sleep(4000).then(() => {
          throw new Error("Public reads waited behind a stale report");
        }),
      ]);
    });
    // The disconnected request had not inserted anything before the dispatch
    // lock. Its transaction releases the permit only after it rolls back.
    async function acceptedAfterBusy(n: number) {
      const limit = performance.now() + 5000;
      do {
        const r = await post(report, promiseId, n);
        if (r.status !== 503) return r;
        await r.arrayBuffer();
        await sleep(30);
      } while (performance.now() < limit);
      throw new Error("Report permit did not return after rollback");
    }
    const outOfOrder = await acceptedAfterBusy(2);
    expect(outOfOrder.status).toBe(409);
    await outOfOrder.arrayBuffer();
    const first = await acceptedAfterBusy(1);
    expect(first.status).toBe(200);
    expect((await first.json()).receipt.replayed).toBe(false);
    // Conversely, disconnecting after commit must preserve the exact receipt.
    const afterCommit = new AbortController();
    const lost = post(report, promiseId, 2, afterCommit.signal, true).catch(
      () => null,
    );
    try {
      await Promise.race([
        committed,
        sleep(5000).then(() => {
          throw Error("Commit did not reach the response");
        }),
      ]);
      afterCommit.abort();
      await lost;
    } finally {
      releaseAck();
    }
    const replay = await acceptedAfterBusy(2);
    expect(replay.status).toBe(200);
    expect((await replay.json()).receipt).toMatchObject({
      replayed: true,
      sequence: 2,
    });
    // Two incomplete non-report bodies hold real parser slots. A new report
    // and control must still work. Closing the partial requests returns both slots.
    const partial = ["polars", "evidence-uploads"].map((path) => {
      const req = httpRequest(base + "/api/sync/v1/" + path, {
        method: "POST",
        headers: {
          "x-fixture-partial": "yes",
          "content-type": "application/json",
          "content-length": "100",
          "x-xfoilfoam-solver-token": token,
        },
      });
      req.on("error", () => {});
      req.write("{");
      return req;
    });
    const smallUpload = () =>
      fetch(base + "/api/sync/v1/evidence-uploads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xfoilfoam-solver-token": token,
        },
        body: "{}",
        signal: AbortSignal.timeout(3000),
      });
    try {
      await Promise.race([
        partialBodies,
        sleep(3000).then(() => {
          throw Error("Both upload headers must reach the parser");
        }),
      ]);
      const busy = await smallUpload();
      expect(busy.status).toBe(503);
      expect((await busy.json()).code).toBe("sync_capacity_busy");
      const [next, control] = await Promise.all([
        post(live, siblingPromise, 8),
        getControl(),
      ]);
      expect(next.status).toBe(200);
      expect((await next.json()).receipt).toMatchObject({
        sequence: 8,
        replayed: false,
      });
      acks++;
      expect(control.status).toBe(200);
      await control.arrayBuffer();
    } finally {
      for (const req of partial) req.destroy();
    }
    const deadline = performance.now() + 3000;
    for (;;) {
      const again = await smallUpload();
      await again.arrayBuffer();
      if (again.status !== 503) {
        expect([400, 401, 403]).toContain(again.status);
        break;
      }
      if (performance.now() >= deadline)
        throw Error("Disconnected upload kept its slot");
      await sleep(25);
    }
    const [stored] =
      await observer.sql`SELECT (SELECT count(*)::int FROM progressive_remote_reports WHERE sim_job_id=${report.executionId}) AS a,
       (SELECT count(*)::int FROM progressive_remote_report_inventories WHERE sim_job_id=${report.executionId}) AS ai,
       (SELECT array_agg(sequence::integer ORDER BY sequence) FROM progressive_remote_reports WHERE sim_job_id=${live.executionId}) AS positions`;
    expect(stored).toMatchObject({
      a: 2,
      ai: 2,
      positions: [1, 2, 3, 4, 5, 6, 7, 8],
    });
    console.info(
      "sync-admission-fixture",
      JSON.stringify({
        rejected,
        consecutiveAcknowledgements: acks,
        heartbeats: beats,
        slotCount: slots,
        timings,
      }),
    );
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
  } finally {
    releaseAck();
    await Promise.allSettled([
      ...(heldFetch ? [heldFetch] : []),
      ...(reading ? [reading] : []),
    ]);
    try {
      await sibling?.cleanup();
      await fixture?.cleanup();
      await db
        .delete(syncSweepPromises)
        .where(eq(syncSweepPromises.id, siblingPromise));
      await db
        .delete(syncSweepPromises)
        .where(eq(syncSweepPromises.id, promiseId));
      await db
        .delete(registeredRemoteSolvers)
        .where(eq(registeredRemoteSolvers.id, solverId));
      await db
        .update(syncApiPermissions)
        .set(sweepPermission)
        .where(eq(syncApiPermissions.dataType, "sweeps"));
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
