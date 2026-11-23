import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import {
  registeredRemoteSolvers,
  syncSweepPromises,
  quarantineProgressiveWorkerReportConflict,
  type DB,
} from "@aerodb/db";
import {
  OPENCFD_2606_ENGINE,
  type JobStatus,
  type JobResult,
  type PolarPoint,
} from "@aerodb/engine-client";
import { observeProgressiveRemoteJob } from "../../sweeper/src/progressive-remote-observation";
import { publishProgressiveWorkerReport } from "../../sweeper/src/progressive-remote-publication";
import { createProgressiveReportFixture } from "./progressive-report-fixture";

export async function verifyProgressivePublicationBatch(
  db: DB,
  app: FastifyInstance,
  ids: { airfoilId: string; revisionId: string; bcId: string },
) {
  const solver = randomUUID(),
    promise = randomUUID(),
    credential = randomUUID();
  const baseUrl = "https://publication-fixture.invalid/api/sync/v1";
  await db.insert(registeredRemoteSolvers).values({
    id: solver,
    instanceId: solver,
    instanceName: "Report publication test",
    authTokenHash: createHash("sha256").update(credential).digest("hex"),
    credentialVersion: 1,
  });
  await db.insert(syncSweepPromises).values({
    id: promise,
    sourceInstanceId: solver,
    registeredSolverId: solver,
    sourceBaseUrl: baseUrl,
    airfoilId: ids.airfoilId,
    simulationPresetRevisionId: ids.revisionId,
    aoaCount: 2,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.execute(sql`UPDATE sync_api_settings SET enabled=true,remote_solver_registered_id=${solver}::uuid,
    remote_solver_transfer_paused=false,remote_solver_auth_token=${credential},upstream_base_url=${baseUrl} WHERE id=1`);
  await db.execute(
    sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type='polars'`,
  );
  await db.execute(
    sql`UPDATE progressive_report_storage_policy SET normalization_enabled=true WHERE id=1`,
  );
  const { executionId: job, envelope } = await createProgressiveReportFixture({
    ...ids,
    solverId: solver,
    promiseId: promise,
    alpha: [-2, -3],
  });
  await db.execute(sql`UPDATE sim_jobs SET engine_job_id=${job},status='running',
    request_payload=request_payload||${JSON.stringify({
      remoteSolver: true,
      syncPromiseId: promise,
      upstreamBaseUrl: baseUrl,
      remoteProgressiveExecution: envelope,
    })}::jsonb WHERE id=${job}::uuid`);
  await db.execute(sql`INSERT INTO progressive_worker_submission_intents
    (sim_job_id,token,assignment_signature,"authorization") VALUES
    (${job}::uuid,${randomUUID()}::uuid,${envelope.contentSignature},
    ${JSON.stringify({ kind: "authorized", executionId: job, contentSignature: envelope.contentSignature })}::jsonb)`);
  const engine = {
    ...OPENCFD_2606_ENGINE,
    build_id: "publication-fixture",
    application_source_sha256: createHash("sha256")
      .update("isolated report producer fixture")
      .digest("hex"),
  };
  const makePoint = (alpha: number): PolarPoint => ({
    aoa_deg: alpha,
    engine,
    solver_active_seconds: 1,
    cl: 0.27,
    cd: 0.012,
    cm: -0.03,
    converged: false,
    unsteady: true,
    first_order_fallback: false,
    images: {},
    fidelity: "urans_full",
    case_slug: "fixture-case",
    force_history: {
      t: [0, 1, 2],
      cl: [0.2, 0.22, 0.27],
      cd: [0.01, 0.011, 0.012],
      cm: [-0.03, -0.03, -0.03],
    },
  });
  const result: JobResult = {
    job_id: job,
    state: "running",
    engine,
    execution_pool: envelope.request.expected_execution_pool,
    polars: [{ chord: 1, speed: 30, reynolds: 2e6, points: [makePoint(-2)] }],
  };
  const now = new Date().toISOString();
  const status: JobStatus = {
    job_id: job,
    state: "running",
    completed_cases: 1,
    total_cases: 2,
    engine,
    solver_budget_progress: {
      version: 1,
      job_id: job,
      observed_at: now,
      cases: [
        {
          chord: 1,
          speed: 30,
          aoa_deg: -2,
          limit_seconds: 900,
          solver_running: true,
          solver_active_seconds: 1,
        },
      ],
    },
  };
  const service = {
    getJob: async () => structuredClone(status),
    getResult: async () => structuredClone(result),
    getExecutionStopProof: async () => ({
      version: 1 as const,
      job_id: job,
      execution_stopped: true,
      producer_stopped: true,
      namespace_verified: true,
      remaining: [],
      observed_at: now,
      error: null,
      fence: "terminal_result" as const,
    }),
    cancelJob: async () => {
      throw new Error("unexpected solver cancellation");
    },
  };
  const observe = (seconds: number, connection = db) => {
    status.solver_budget_progress!.cases[0]!.solver_active_seconds = seconds;
    return observeProgressiveRemoteJob(connection, service, job);
  };
  const bodies: Array<Record<string, any>> = [];
  const post = async (payload: Record<string, unknown>, token = credential) =>
    app.inject({
      method: "POST",
      url: `/api/sync/v1/progressive-executions/${job}/reports`,
      headers: { "x-xfoilfoam-solver-token": token },
      payload,
    });
  const relay: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const response = await post(
      body,
      new Headers(init?.headers).get("x-xfoilfoam-solver-token")!,
    );
    return new Response(response.body, { status: response.statusCode });
  };
  const wireReport = async (sequence: number) => {
    const [r] =
      await db.execute(sql`SELECT resolve_progressive_report(report,result_payload_hash) AS body
      FROM progressive_remote_reports WHERE sim_job_id=${job}::uuid AND sequence=${sequence}`);
    return r?.body as any;
  };
  const sigs = [await observe(1), await observe(2), await observe(3)];
  const lost: typeof fetch = async (url, init) => {
    const response = await relay(url, init);
    expect(response.status).toBe(200);
    throw new Error("response lost after hub commit");
  };
  await expect(publishProgressiveWorkerReport(db, job, lost)).rejects.toThrow(
    "response lost",
  );
  const original = bodies[0]!;
  expect(
    original.updates.map(
      (u: { contentSignature: string }) => u.contentSignature,
    ),
  ).toEqual(sigs.slice(1).map((r) => r.contentSignature));
  expect(JSON.stringify(original.updates)).not.toContain("force_history");
  const [unconfirmed] = await db.execute(
    sql`SELECT count(*)::int n FROM progressive_worker_reports WHERE sim_job_id=${job}::uuid AND acknowledged_at IS NULL`,
  );
  expect(unconfirmed!.n).toBe(3);
  const corrupted = structuredClone(original);
  corrupted.updates[0].status.solver_budget_progress.cases[0].solver_active_seconds += 1;
  expect((await post(corrupted)).statusCode).toBe(409);
  expect(
    (await post({ ...original, promiseId: randomUUID() })).statusCode,
  ).toBe(403);
  expect((await post(original, randomUUID())).statusCode).toBe(401);
  const forgedAck: typeof fetch = async (url, init) => {
    const report = (await (await relay(url, init)).json()) as {
      receipts: Array<{ contentSignature: string }>;
    };
    report.receipts[1]!.contentSignature = "0".repeat(64);
    return Response.json(report);
  };
  await expect(
    publishProgressiveWorkerReport(db, job, forgedAck),
  ).rejects.toThrow("exact ordered");
  expect(await publishProgressiveWorkerReport(db, job, relay)).toMatchObject({
    kind: "published",
    sequence: 3,
  });
  expect(await wireReport(3)).toEqual({
    ...original.report,
    sequence: 3,
    status: original.updates[1].status,
  });
  await observe(4);
  await observe(5);
  status.solver_budget_progress!.observed_at = new Date(
    Date.parse(now) + 1000,
  ).toISOString();
  expect(await observe(5)).toMatchObject({ sequence: 5, replayed: true });
  for (const seq of [4, 5]) {
    expect(await publishProgressiveWorkerReport(db, job, relay)).toMatchObject({
      sequence: seq,
    });
    expect((await wireReport(seq)).result).toBeNull();
  }
  const [prior] =
    await db.execute(sql`SELECT count(*)::int n FROM progressive_remote_report_sources
    WHERE sim_job_id=${job}::uuid AND sequence=3`);
  const [light] =
    await db.execute(sql`SELECT source_count FROM progressive_remote_report_inventories
    WHERE sim_job_id=${job}::uuid AND sequence=5`);
  expect(prior!.n).toBe(1);
  expect(light!.source_count).toBe(0);
  result.polars[0]!.points[0]!.force_history!.cl[1] = 0.211;
  await observe(6);
  await observe(7);
  const legacy: typeof fetch = async (url, init) =>
    JSON.parse(String(init?.body)).updates
      ? Response.json(
          { error: "invalid progressive report request" },
          { status: 400 },
        )
      : relay(url, init);
  expect(await publishProgressiveWorkerReport(db, job, legacy)).toMatchObject({
    sequence: 6,
  });
  expect(
    (await wireReport(6)).result.polars[0].points[0].force_history.cl[1],
  ).toBe(0.211);
  expect(await publishProgressiveWorkerReport(db, job, relay)).toMatchObject({
    sequence: 7,
  });
  const rollback = new Error("rollback quarantined source probe");
  await expect(
    db.transaction(async (tx) => {
      const connection = tx as unknown as DB;
      result.polars[0]!.points[0]!.force_history!.cl[1] = 0.251;
      const base = await observe(8, connection);
      await quarantineProgressiveWorkerReportConflict(connection, {
        executionId: job,
        solverId: solver,
        sequence: base.sequence,
        contentSignature: base.contentSignature,
        reason: "Remote report replay changed immutable content",
      });
      const next = await observe(9, connection);
      const [q] = await tx.execute(
        sql`SELECT result_payload_hash FROM progressive_worker_reports WHERE sim_job_id=${job}::uuid AND sequence=${next.sequence}`,
      );
      expect(q!.result_payload_hash).toBeTruthy();
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  result.polars[0]!.points.push(makePoint(-3));
  status.completed_cases = 2;
  await observe(10);
  expect(await publishProgressiveWorkerReport(db, job, relay)).toMatchObject({
    sequence: 8,
  });
  expect(
    (await wireReport(8)).result.polars[0].points.map(
      (point: PolarPoint) => point.aoa_deg,
    ),
  ).toEqual([-2, -3]);
  status.state = "completed";
  result.state = "completed";
  status.solver_budget_progress!.cases[0]!.solver_running = false;
  await observe(11);
  expect(await publishProgressiveWorkerReport(db, job, relay)).toMatchObject({
    sequence: 9,
  });
  const terminal = await wireReport(9);
  expect(terminal.stopProof.execution_stopped).toBe(true);
  expect(terminal.result.polars[0].points[1].converged).toBe(false);
  const changed = structuredClone(terminal);
  changed.sequence++;
  changed.result.polars[0].points[1].cl += 0.01;
  expect((await post({ promiseId: promise, report: changed })).statusCode).toBe(
    409,
  );
}
