import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  acknowledgeProgressiveWorkerReport,
  analysisContentHash,
  createClient,
  progressiveReportedPointSources,
  readProgressiveRemoteAssignment,
  sealProgressiveRemoteExecution,
  validateProgressiveRemoteReport,
  type ProgressiveRemoteExecutionEnvelope,
  type DB,
} from "@aerodb/db";
import { sql, type SQL } from "drizzle-orm";
import { withArchiveFixture } from "./progressive-report-archive-fixture";
import { verifyDiagnosticMirror } from "./progressive-terminal-diagnostic-fixture";
import { reconcileTerminalProgressiveMirror } from "../src/progressive-terminal-mirror";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
const url = "https://registered.invalid/api/sync/v1",
  token = "registered-worker-test-token";

async function verifyUnstartedCancellation(
  db: DB,
  sourceJob: string,
  sourcePromise: string,
  withIntent: boolean,
) {
  const id = randomUUID(),
    promiseId = randomUUID();
  const [owner] =
    await db.execute(sql`SELECT request_payload->'remoteProgressiveExecution' envelope
    FROM sim_jobs WHERE id=${sourceJob}::uuid`);
  const template = owner!.envelope as ProgressiveRemoteExecutionEnvelope;
  const units = template.scope.units.map((u) => ({
    ...u,
    unitId: randomUUID(),
    token: randomUUID(),
  }));
  const envelope = sealProgressiveRemoteExecution({
    solverId: template.solverId,
    promiseId,
    scope: {
      ...template.scope,
      executionId: id,
      units,
      tokens: units.map((u) => u.token),
    },
    request: { ...template.request, execution_id: id },
  });
  await db.execute(sql`INSERT INTO sync_sweep_promises(id,registered_solver_id,airfoil_id,simulation_preset_revision_id,
    aoa_count,status,"expiresAt",source_base_url,request_payload,response_payload)
    SELECT ${promiseId}::uuid,registered_solver_id,airfoil_id,simulation_preset_revision_id,aoa_count,'active',"expiresAt",
    source_base_url,request_payload||jsonb_build_object('progressiveExecutionId',${id}::text),'{"prior":"keep"}'::jsonb
    FROM sync_sweep_promises WHERE id=${sourcePromise}::uuid`);
  await db.execute(sql`INSERT INTO sim_jobs(id,airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,
    status,engine_state,request_payload,total_cases,completed_cases)
    SELECT ${id}::uuid,airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,'cancelled','cancelled',
    jsonb_build_object('syncPromiseId',${promiseId}::text,'remoteSolver',true,'upstreamBaseUrl',${url}::text,
      'remoteProgressiveExecution',${JSON.stringify(envelope)}::jsonb,'engineRequest',${JSON.stringify(envelope.request)}::jsonb),
    0,0 FROM sim_jobs WHERE id=${sourceJob}::uuid`);
  if (withIntent)
    await db.execute(sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
      VALUES(${id}::uuid,gen_random_uuid(),${envelope.contentSignature},jsonb_build_object('kind','authorized',
      'executionId',${id}::text,'contentSignature',${envelope.contentSignature}::text))`);
  await db.execute(sql`INSERT INTO sync_sweep_promise_points(promise_id,airfoil_id,simulation_preset_revision_id,aoa_deg,status)
    SELECT id,airfoil_id,simulation_preset_revision_id,${units[0]!.alpha},'active' FROM sync_sweep_promises WHERE id=${promiseId}::uuid`);
  const stop = {
    version: 1,
    job_id: id,
    execution_stopped: true,
    producer_stopped: true,
    namespace_verified: true,
    remaining: [],
    observed_at: new Date().toISOString(),
    error: null,
    fence: "cancel_marker",
    ownership_basis: "never_started_cancellation_fence",
  };
  const { report, contentSignature } = validateProgressiveRemoteReport(
    {
      version: 1,
      solverId: envelope.solverId,
      promiseId,
      executionId: id,
      assignmentSignature: envelope.contentSignature,
      sequence: 1,
      status: {
        job_id: id,
        state: "cancelled",
        total_cases: 0,
        completed_cases: 0,
        active_pids: [],
        started_at: null,
      },
      result: null,
      stopProof: stop,
    },
    envelope,
  );
  await db.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report)
    VALUES(${id}::uuid,1,${contentSignature},${JSON.stringify(report)}::jsonb)`);
  await acknowledgeProgressiveWorkerReport(db, {
    executionId: id,
    solverId: envelope.solverId,
    sequence: 1,
    contentSignature,
  });
  const rollback = new Error("roll back independent hub or worker snapshot");
  async function fork(operation: (forked: DB) => Promise<void>) {
    try {
      await db.transaction(async (tx) => {
        await operation(tx as unknown as DB);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  let remote!: NonNullable<
    Awaited<ReturnType<typeof readProgressiveRemoteAssignment>>
  >;
  await fork(async (hub) => {
    await hub.execute(
      sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${promiseId}::uuid`,
    );
    await hub.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
      VALUES(${id}::uuid,${promiseId}::uuid,${envelope.solverId}::uuid,1,${envelope.contentSignature},${JSON.stringify(envelope)}::jsonb)`);
    await hub.execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report)
      VALUES(${id}::uuid,1,${contentSignature},${JSON.stringify(report)}::jsonb)`);
    await hub.execute(sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
      VALUES(${id}::uuid,${id},${envelope.scope.epochId}::uuid,${JSON.stringify(stop)}::jsonb,${analysisContentHash(stop)},${stop.observed_at}::timestamptz)`);
    remote = (await readProgressiveRemoteAssignment(hub, {
      solverId: envelope.solverId,
      executionId: id,
    }))!;
  });
  const run = (
    conn: DB,
    remoteOwner: unknown,
    preview = false,
    named = true,
    beforeReply?: () => Promise<void>,
  ) =>
    reconcileTerminalProgressiveMirror(conn, {
      ...(named ? { promiseId } : {}),
      preview,
      fetcher: async (input, init) => {
        expect(String(input)).toBe(url + "/progressive-executions/" + id);
        expect(new Headers(init?.headers).get("x-xfoilfoam-solver-token")).toBe(
          token,
        );
        await beforeReply?.();
        return Response.json({ assignment: remoteOwner });
      },
    });
  expect(remote.terminalReceipt).toEqual({
    reportSignature: contentSignature,
    stopProofSignature: analysisContentHash(stop),
  });
  expect(await run(db, remote, true)).toMatchObject({
    outcome: "eligible",
    reports: 1,
    provedResults: 0,
  });
  for (const invalid of [
    null,
    { ...remote.terminalReceipt, reportSignature: "0".repeat(64) },
    { ...remote.terminalReceipt, stopProofSignature: "1".repeat(64) },
  ])
    expect(
      (await run(db, { ...remote, terminalReceipt: invalid })).outcome,
    ).toBe("no-terminal-proof");
  await fork(async (conn) => {
    await conn.execute(
      sql`UPDATE sim_jobs SET ingest_lease_token=gen_random_uuid(),ingest_lease_expires_at=now()+interval '10 minutes' WHERE id=${id}::uuid`,
    );
    expect((await run(conn, remote)).outcome).toBe("no-candidate");
  });
  await fork(async (conn) => {
    const changed = await run(conn, remote, false, true, async () => {
      if (withIntent) {
        await conn.execute(
          sql`UPDATE sim_jobs SET engine_job_id=id::text WHERE id=${id}::uuid`,
        );
      } else {
        await conn.execute(sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
          VALUES(${id}::uuid,gen_random_uuid(),${envelope.contentSignature},jsonb_build_object('kind','authorized',
          'executionId',${id}::text,'contentSignature',${envelope.contentSignature}::text))`);
      }
    });
    expect(changed.outcome).toBe("changed");
    expect(
      (
        await conn.execute(
          sql`SELECT status FROM sync_sweep_promises WHERE id=${promiseId}::uuid`,
        )
      )[0]?.status,
    ).toBe("active");
  });
  await fork(async (conn) => {
    const other = validateProgressiveRemoteReport(
      {
        ...report,
        status: { ...report.status, message: "different observation" },
      },
      envelope,
    );
    await conn.execute(sql`INSERT INTO progressive_worker_report_conflicts(sim_job_id,sequence,content_signature,report,reason)
      VALUES(${id}::uuid,1,${other.contentSignature},${JSON.stringify(other.report)}::jsonb,'changed remote report')`);
    expect((await run(conn, remote)).outcome).toBe("unsettled");
  });
  // The controller must retain this exact object until its own lease has expired.
  await db.execute(
    sql`UPDATE sim_jobs SET ingest_lease_token=gen_random_uuid(),ingest_lease_expires_at=now()-interval '1 minute' WHERE id=${id}::uuid`,
  );
  expect((await run(db, remote, false, false)).outcome).toBe("reconciled");
  const [done] =
    await db.execute(sql`SELECT p.status,p.response_payload->>'prior' AS prior,j.engine_job_id,
    j.ingest_lease_token IS NOT NULL AS original_ingest_token,j."ingestedAt",
    (SELECT count(*)::int FROM progressive_worker_submission_intents WHERE sim_job_id=j.id) AS intents,
    (SELECT count(*)::int FROM result_attempts WHERE sim_job_id=j.id) AS attempts,
    (SELECT content_signature FROM progressive_worker_reports WHERE sim_job_id=j.id AND sequence=1) AS original_report,
    (SELECT status FROM sync_sweep_promise_points WHERE promise_id=p.id) AS claim,
    p.response_payload#>>'{registeredTerminalMirror,stopProofSignature}' AS stop
    FROM sync_sweep_promises p JOIN sim_jobs j ON j.id=${id}::uuid WHERE p.id=${promiseId}::uuid`);
  expect(done).toEqual({
    status: "cancelled",
    prior: "keep",
    engine_job_id: null,
    original_ingest_token: true,
    ingestedAt: null,
    intents: withIntent ? 1 : 0,
    attempts: 0,
    original_report: contentSignature,
    claim: "cancelled",
    stop: analysisContentHash(stop),
  });
  expect((await run(db, remote)).outcome).toBe("no-candidate");
}

describe("registered terminal progressive mirror reconciliation", () => {
  it.each([true, false])(
    "closes only cutoff-matched, stopped, delivery-settled local ownership (normalized %s)",
    async (normalized) => {
      const reportCount = normalized ? 4 : 130;
      vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
      try {
        await withArchiveFixture(
          client,
          "worker",
          async (fixture) => {
            const { db, executionId, promiseId, attemptId } = fixture;
            const [j] = await db.execute(
              sql`SELECT request_payload->'remoteProgressiveExecution' AS envelope FROM sim_jobs WHERE id=${executionId}::uuid`,
            );
            const envelope = j!.envelope as {
              solverId: string;
              contentSignature: string;
              request: unknown;
            };
            const { solverId, contentSignature } = envelope;
            const instanceId = randomUUID();
            await db.execute(
              sql`UPDATE registered_remote_solvers SET instance_id=${instanceId} WHERE id=${solverId}::uuid`,
            );
            await db.execute(
              sql`INSERT INTO sync_api_settings(id) VALUES(1) ON CONFLICT DO NOTHING`,
            );
            await db.execute(sql`UPDATE sync_api_settings SET instance_id=${instanceId}::uuid,
        upstream_base_url=${url},remote_solver_enabled=true,remote_solver_transfer_paused=false,remote_solver_registered_id=${solverId}::uuid,remote_solver_auth_token=${token}
        WHERE id=1`);
            await db.execute(sql`UPDATE sync_sweep_promises SET status='active',"expiresAt"=clock_timestamp()+interval '3 hours',source_base_url=${url},
        request_payload=jsonb_build_object('executionContract','progressive-cfd-v1','remoteSolver',true,'solverId',${solverId}::text,
        'upstreamBaseUrl',${url}::text,'progressiveExecutionId',${executionId}::text),response_payload='{"existing":true}'
        WHERE id=${promiseId}::uuid`);
            await db.execute(sql`UPDATE sim_jobs SET "ingestedAt"=NULL,request_payload=request_payload||jsonb_build_object('upstreamBaseUrl',${url}::text,'engineRequest',${JSON.stringify(envelope.request)}::jsonb)
        WHERE id=${executionId}::uuid`);
            await db.execute(sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
        VALUES(${executionId}::uuid,gen_random_uuid(),${contentSignature},jsonb_build_object('kind','authorized','executionId',${executionId}::text,'contentSignature',${contentSignature}::text))`);
            await db.execute(sql`INSERT INTO sync_sweep_promise_points(promise_id,airfoil_id,simulation_preset_revision_id,aoa_deg,status)
        SELECT p.id,p.airfoil_id,p.simulation_preset_revision_id,a,s::sync_promise_status FROM sync_sweep_promises p
        CROSS JOIN(VALUES(0,'fulfilled'),(1,'active')) points(a,s) WHERE p.id=${promiseId}::uuid`);
            const rollback = new Error("rollback independent fixture state");
            const fork = async (operation: (db: DB) => Promise<void>) => {
              try {
                await db.transaction(async (tx) => {
                  await operation(tx as unknown as DB);
                  throw rollback;
                });
              } catch (error) {
                if (error !== rollback) throw error;
              }
            };
            // Render an actual registered hub assignment from migrated dispatch,
            // stop and report rows, then restore the worker's independent DB view.
            let assignment:
              | NonNullable<
                  Awaited<ReturnType<typeof readProgressiveRemoteAssignment>>
                >
              | undefined;
            await fork(async (hub) => {
              await hub.execute(
                sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${promiseId}::uuid`,
              );
              await hub.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
          VALUES(${executionId}::uuid,${promiseId}::uuid,${solverId}::uuid,1,${contentSignature},${JSON.stringify(envelope)}::jsonb)`);
              const last = fixture.reports.at(-1)!;
              await hub.execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report)
          VALUES(${executionId}::uuid,${last.sequence},${last.contentSignature},${last.text}::jsonb)`);
              assignment = (await readProgressiveRemoteAssignment(hub, {
                solverId,
                executionId,
              }))!;
              await hub.execute(
                sql`UPDATE sync_sweep_promises SET registered_solver_id=NULL WHERE id=${promiseId}::uuid`,
              );
              expect(
                await readProgressiveRemoteAssignment(hub, {
                  solverId,
                  executionId,
                }),
              ).toBeNull();
            });
            expect(assignment).toMatchObject({
              executionStopped: true,
              receivedSequence: reportCount,
              promise: { id: promiseId, status: "cancelled" },
            });
            const upstream = assignment!;
            const http = (
              data: unknown = upstream,
              status = 200,
              hook?: () => Promise<void>,
            ): typeof fetch => {
              let calls = 0;
              return async (input, init) => {
                expect(input).toBe(
                  url + "/progressive-executions/" + executionId,
                );
                expect(init?.method ?? "GET").toBe("GET");
                expect(init?.redirect).toBe("error");
                expect(
                  new Headers(init?.headers).get("x-xfoilfoam-solver-token"),
                ).toBe(token);
                if (++calls === 1 && hook) await hook();
                return Response.json({ assignment: data }, { status });
              };
            };
            const run = (c = db, fetcher = http(), preview = false) =>
              reconcileTerminalProgressiveMirror(c, {
                promiseId,
                fetcher,
                preview,
              });
            const promise = (c = db) =>
              c.execute(
                sql`SELECT status,"expiresAt","lastHeartbeatAt",response_payload FROM sync_sweep_promises WHERE id=${promiseId}::uuid`,
              );
            const before = (await promise())[0]!;
            const reject = async (q: SQL, outcome: string) => {
              await fork(async (c) => {
                await c.execute(q);
                expect((await run(c)).outcome).toBe(outcome);
                expect((await promise(c))[0]).toEqual(before);
              });
            };
            await db.execute(
              sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${executionId}::uuid AND sequence<>2`,
            );
            expect((await run()).outcome).toBe("unsettled");
            await db.execute(
              sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${executionId}::uuid AND sequence=2`,
            );
            const stage = (seq: number) =>
              db.execute(sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature)
        SELECT sim_job_id,sequence,content_signature FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid AND sequence=${seq}`);
            await stage(2);
            const point = progressiveReportedPointSources(
              JSON.parse(fixture.reports[1]!.text).result,
            )[0]!.contentSignature;
            await db.execute(sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id,point_content_signature)
        VALUES(${executionId}::uuid,2,${attemptId}::uuid,${point})`);
            expect((await run()).outcome).toBe("unsettled");
            if (normalized)
              await fork((c) =>
                verifyDiagnosticMirror(
                  c,
                  envelope as ProgressiveRemoteExecutionEnvelope,
                  attemptId!,
                  fixture.reports[1]!.text,
                  fixture.reports.at(-1)!.text,
                  url,
                  token,
                ),
              );
            await db.execute(sql`INSERT INTO progressive_worker_hub_receipts(sim_job_id,sequence,result_attempt_id,point_content_signature,receipt)
        VALUES(${executionId}::uuid,2,${attemptId}::uuid,${point},'{}')`);
            // The still-unclaimed archive is an obligation even with an empty outbox.
            expect((await run()).outcome).toBe("unsettled");
            await db.execute(sql`INSERT INTO progressive_worker_archive_receipts(sim_job_id,point_content_signature,brokered_upload_id,receipt)
        VALUES(${executionId}::uuid,${point},gen_random_uuid(),'{}')`);
            // The final result differs from the staged running result.
            expect((await run()).outcome).toBe("unsettled-reports");
            await stage(reportCount);
            // A stage receipt without all of its actual point generations is incomplete.
            expect((await run()).outcome).toBe("unsettled-reports");
            await db.execute(sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id,point_content_signature)
              VALUES(${executionId}::uuid,${reportCount},${attemptId}::uuid,${point})`);
            for (const body of [
              {
                ...upstream,
                promise: { ...upstream.promise, status: "active" },
              },
              {
                ...upstream,
                promise: { ...upstream.promise, id: randomUUID() },
              },
              { ...upstream, executionStopped: false },
              { ...upstream, receivedSequence: 3 },
              {
                ...upstream,
                job: { status: "running", engineState: "running" },
              },
              {
                ...upstream,
                envelope: { ...envelope, solverId: randomUUID() },
              },
              { ...upstream, envelope: { ...envelope, request: {} } },
            ])
              expect((await run(db, http(body))).outcome).toBe(
                "no-terminal-proof",
              );
            for (const denied of [403, 404])
              expect((await run(db, http(null, denied))).outcome).toBe(
                "no-terminal-proof",
              );
            await reject(
              sql`UPDATE sim_jobs SET status='running' WHERE id=${executionId}::uuid`,
              "no-candidate",
            );
            await reject(
              sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true WHERE id=1`,
              "no-candidate",
            );
            await reject(
              sql`UPDATE sim_jobs SET ingest_lease_token=gen_random_uuid(),ingest_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${executionId}::uuid`,
              "no-candidate",
            );
            await reject(
              sql`INSERT INTO sim_jobs(id,airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,status,request_payload)
        SELECT gen_random_uuid(),airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,'failed',request_payload FROM sim_jobs WHERE id=${executionId}::uuid`,
              "no-candidate",
            );
            await reject(
              sql`INSERT INTO progressive_worker_archive_deliveries(sim_job_id,point_content_signature) VALUES(${executionId}::uuid,${point})`,
              "unsettled",
            );
            await reject(
              sql`INSERT INTO progressive_worker_staging_failures(sim_job_id,sequence,attempt_count,retry_after,last_error)
        VALUES(${executionId}::uuid,3,1,now(),'fixture')`,
              "unsettled",
            );
            await reject(
              sql`INSERT INTO sync_remote_promise_cancellations(promise_id,state) VALUES(${promiseId}::uuid,'retry_wait')`,
              "unsettled",
            );
            await reject(
              sql`INSERT INTO progressive_worker_evidence_delivery_claims(sim_job_id,sequence,result_attempt_id,point_content_signature,claim_token,claim_expires_at)
              VALUES(${executionId}::uuid,2,${attemptId}::uuid,${point},gen_random_uuid(),clock_timestamp()+interval '10 minutes')`,
              "unsettled",
            );
            await reject(
              sql`UPDATE results SET status='running' WHERE sim_job_id=${executionId}::uuid`,
              "unsettled",
            );
            const pending = (
              state: string,
            ) => sql`INSERT INTO sync_remote_result_deliveries(promise_id,sim_job_id,result_id,result_attempt_id,aoa_deg,generation_key,state,claim_token,claimed_at,claim_expires_at)
               SELECT ${promiseId}::uuid,${executionId}::uuid,result_id,id,aoa_deg,${randomUUID()},${state},
                 CASE WHEN ${state}::text='pushing' THEN gen_random_uuid() END,
                 CASE WHEN ${state}::text='pushing' THEN clock_timestamp() END,
                 CASE WHEN ${state}::text='pushing' THEN clock_timestamp()+interval '1 hour' END FROM result_attempts WHERE id=${attemptId}::uuid`;
            for (const state of ["pending", "pushing", "retry_wait", "blocked"])
              await reject(pending(state), "unsettled");
            await fork(async (c) => {
              expect(
                (
                  await run(
                    c,
                    http(upstream, 200, async () => {
                      await c.execute(pending("pending"));
                    }),
                  )
                ).outcome,
              ).toBe("changed");
              expect((await promise(c))[0]).toEqual(before);
            });
            vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
            expect((await run()).outcome).toBe("inactive-role");
            vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
            expect((await run(db, http(), true)).outcome).toBe("eligible");
            if (normalized) {
              let probes = 0;
              const registered = http();
              const capacityProbe: typeof fetch = (request, init) =>
                ++probes <= 3
                  ? Promise.resolve(
                      new Response(null, {
                        status: 503,
                        headers: { "retry-after": "0" },
                      }),
                    )
                  : registered(request, init);
              expect(
                (
                  await reconcileTerminalProgressiveMirror(db, {
                    promiseId,
                    preview: true,
                    waitForCapacity: true,
                    fetcher: capacityProbe,
                  })
                ).outcome,
              ).toBe("eligible");
              expect(probes).toBe(4);
            }
            expect((await promise())[0]).toEqual(before);
            const normal = () =>
              reconcileTerminalProgressiveMirror(db, { fetcher: http() });
            if (!normalized) expect((await normal()).outcome).toBe("checking");
            expect((await normal()).outcome).toBe("reconciled");
            expect((await promise())[0]).toMatchObject({
              status: "cancelled",
              expiresAt: before.expiresAt,
              lastHeartbeatAt: before.lastHeartbeatAt,
              response_payload: {
                existing: true,
                registeredTerminalMirror: {
                  executionId,
                  solverId,
                  sequence: reportCount,
                },
              },
            });
            const points = await db.execute(
              sql`SELECT status FROM sync_sweep_promise_points WHERE promise_id=${promiseId}::uuid ORDER BY aoa_deg`,
            );
            expect(points.map((x) => x.status)).toEqual([
              "fulfilled",
              "cancelled",
            ]);
            const [unchanged] =
              await db.execute(sql`SELECT j.status,j.engine_state,j."ingestedAt",
        (SELECT count(*)::int FROM progressive_worker_evidence_receipts WHERE sim_job_id=j.id) AS staged,
        (SELECT count(*)::int FROM progressive_worker_reports WHERE sim_job_id=j.id) AS reports
        FROM sim_jobs j WHERE j.id=${executionId}::uuid`);
            expect(unchanged).toEqual({
              status: "failed",
              engine_state: "failed",
              ingestedAt: null,
              staged: 2,
              reports: reportCount,
            });
            expect((await run()).outcome).toBe("no-candidate");
            if (normalized) {
              for (const withIntent of [false, true])
                await verifyUnstartedCancellation(
                  db,
                  executionId,
                  promiseId,
                  withIntent,
                );
            }
          },
          {
            normalized,
            settled: false,
            reportCount,
            historyRepeats: 1,
            metadataOnlyDiagnostic: normalized,
          },
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
    30000,
  );
});
