import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import {
  EngineError,
  type EngineExecutionStopProof,
  type JobResult,
  type JobStatus,
} from "../../engine-client/src";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { analysisContentHash } from "../src/analysis-target";
import { observeProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-observation";
import { solverQueuePressure } from "../../../apps/sweeper/src/submit-lifecycle";
import { reconcileProgressiveRemoteWorker } from "../../../apps/sweeper/src/progressive-remote-reconciliation";
import type { EngineClient } from "../../engine-client/src";
import { assertProgressiveWorkerEvidenceJob } from "../../../apps/sweeper/src/progressive-remote-jobs";
import { verifyProgressiveWorkerEvidence } from "./progressive-worker-evidence-fixture";
import {
  progressiveArchiveManifestBytes,
  progressiveArchiveManifestSha256,
} from "./progressive-archive-data";

export async function verifyProgressiveWorkerObservation(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  proofFactory: (executionId: string) => EngineExecutionStopProof,
  mode: "timeout" | "success",
) {
  const executionId = envelope.scope.executionId;
  const runtime = {
    ...envelope.request.expected_engine!,
    build_id: "isolated-progressive-worker-submit",
    application_source_sha256: analysisContentHash({ fixture: executionId }),
  };
  const status: JobStatus = {
    job_id: executionId,
    state: "running",
    total_cases: envelope.scope.units.length,
    completed_cases: mode === "success" ? 1 : 0,
    engine: runtime,
  };
  const result: JobResult = {
    job_id: executionId,
    state: "running",
    engine: runtime,
    execution_pool: envelope.request.expected_execution_pool,
    polars: [
      {
        chord: envelope.request.chord_lengths![0],
        speed: envelope.request.speeds![0],
        reynolds: 2_000_000,
        points: [],
        attempts: [
          {
            aoa_deg: envelope.scope.units[0].alpha,
            case_slug: "isolated-reported-case",
            cl: 0.4,
            cd: 0.03,
            unsteady: false,
            converged: false,
            first_order_fallback: false,
            images: {},
            engine: runtime,
            error: "isolated unconverged observer fixture",
            failure_disposition: "hard_solver",
            solver_active_seconds: 48,
            evidence_artifacts: [
              {
                kind: "manifest",
                path: "isolated-case/evidence_manifest.json",
                mime_type: "application/json",
                sha256: progressiveArchiveManifestSha256,
                byte_size: progressiveArchiveManifestBytes.byteLength,
              },
            ],
          },
        ],
      },
    ],
  };
  const proof = proofFactory(executionId);
  const engine = {
    baseUrl: "http://isolated-progressive-engine.invalid",
    getJob: vi.fn(async () => structuredClone(status)),
    getResult: vi.fn(async () => structuredClone(result)),
    cancelJob: vi.fn(async () => ({ job_id: executionId, cancelled: true })),
    getExecutionStopProof: vi.fn(async () => structuredClone(proof)),
  };
  await db.execute(
    sql`UPDATE sync_api_settings SET remote_solver_enabled = false WHERE id = 1`,
  );
  engine.getJob.mockRejectedValueOnce(
    new EngineError("isolated missing engine job", 404),
  );
  await expect(
    observeProgressiveRemoteJob(db, engine, executionId),
  ).rejects.toThrow("engine job is missing");
  expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
  if (mode === "success") {
    engine.getResult.mockRejectedValueOnce(
      new EngineError("isolated incomplete result publication", 404),
    );
    await expect(
      observeProgressiveRemoteJob(db, engine, executionId),
    ).rejects.toThrow("incomplete result publication");
    const receipt = await observeProgressiveRemoteJob(db, engine, executionId);
    expect(receipt).toMatchObject({
      sequence: 1,
      stopped: false,
      completedCases: 1,
    });
    expect(
      await observeProgressiveRemoteJob(db, engine, executionId),
    ).toMatchObject({ sequence: 1, replayed: true });
    const [stored] = await db.execute(
      sql`SELECT report FROM progressive_worker_reports WHERE sim_job_id = ${executionId}::uuid AND sequence = 1`,
    );
    expect((stored.report as { result: JobResult }).result).toEqual(result);
    const evidenceInput = {
      simJobId: executionId,
      engineJobId: executionId,
      result,
      reportSequence: 1,
    };
    expect(await assertProgressiveWorkerEvidenceJob(db, evidenceInput)).toBe(
      true,
    );
    await expect(
      assertProgressiveWorkerEvidenceJob(db, {
        ...evidenceInput,
        reportSequence: undefined,
      }),
    ).rejects.toThrow("exact owned report");
    await expect(
      assertProgressiveWorkerEvidenceJob(db, {
        ...evidenceInput,
        engineJobId: randomUUID(),
      }),
    ).rejects.toThrow("exact owned report");
    const changedResult = structuredClone(result);
    changedResult.polars[0].attempts![0].cl = 99;
    await expect(
      assertProgressiveWorkerEvidenceJob(db, {
        ...evidenceInput,
        result: changedResult,
      }),
    ).rejects.toThrow("stored report bytes");
    const ordinaryId = randomUUID();
    try {
      await db.execute(sql`INSERT INTO sim_jobs(id, airfoil_id, bc_ids, simulation_preset_revision_id, reference_chord_m, status, request_payload)
        SELECT ${ordinaryId}::uuid, airfoil_id, bc_ids, simulation_preset_revision_id, reference_chord_m, 'cancelled', NULL FROM sim_jobs WHERE id = ${executionId}::uuid`);
      expect(
        await assertProgressiveWorkerEvidenceJob(db, {
          simJobId: ordinaryId,
          engineJobId: ordinaryId,
          result,
        }),
      ).toBe(false);
      await expect(
        assertProgressiveWorkerEvidenceJob(db, {
          ...evidenceInput,
          simJobId: ordinaryId,
          engineJobId: ordinaryId,
        }),
      ).rejects.toThrow("ordinary solver job");
    } finally {
      await db.execute(
        sql`DELETE FROM sim_jobs WHERE id = ${ordinaryId}::uuid`,
      );
    }
    expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = true WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET status = 'submitted' WHERE id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promises SET status = 'active', "expiresAt" = clock_timestamp() + interval '1 hour' WHERE id = ${envelope.promiseId}::uuid`,
    );
    const fetchControl: typeof fetch = async (url, options) => {
      expect(String(url)).toContain(
        `/progressive-executions/${executionId}/control`,
      );
      expect(options?.redirect).toBe("error");
      return Response.json({
        executionId,
        contentSignature: envelope.contentSignature,
        continuation: { kind: "continue" },
      });
    };
    engine.getResult.mockRejectedValueOnce(
      new EngineError("isolated result file not yet published", 404),
    );
    const missingResult = await reconcileProgressiveRemoteWorker(
      db,
      engine as unknown as EngineClient,
      { jobIds: [executionId], fetcher: fetchControl },
    );
    expect(missingResult).toMatchObject({
      inspected: 1,
      reported: 0,
      stopped: 0,
      errors: [
        {
          executionId,
          error: expect.stringContaining("result file not yet published"),
        },
      ],
    });
    expect(engine.cancelJob).not.toHaveBeenCalled();
    const offline = await reconcileProgressiveRemoteWorker(
      db,
      engine as unknown as EngineClient,
      {
        jobIds: [executionId],
        fetcher: async () => {
          throw new Error("isolated hub unavailable");
        },
      },
    );
    expect(offline).toMatchObject({
      inspected: 1,
      stopped: 0,
      errors: [{ executionId, error: "isolated hub unavailable" }],
    });
    expect(engine.cancelJob).not.toHaveBeenCalled();
    expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = false WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET status = 'cancelled' WHERE id = ${executionId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sync_sweep_promises SET status = 'expired', "expiresAt" = clock_timestamp() - interval '1 second' WHERE id = ${envelope.promiseId}::uuid`,
    );
  } else {
    proof.ownership_basis = "never_started_cancellation_fence";
    proof.fence = "cancel_marker";
    status.total_cases = 0;
    delete status.engine;
  }
  status.state = "cancelled";
  result.state = "cancelled";
  engine.getExecutionStopProof.mockResolvedValueOnce({
    ...proof,
    job_id: randomUUID(),
  });
  await expect(
    observeProgressiveRemoteJob(db, engine, executionId, { stop: true }),
  ).rejects.toThrow("foreign execution-stop");
  expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
  engine.getExecutionStopProof.mockResolvedValueOnce({
    ...proof,
    namespace_verified: false,
  });
  await expect(
    observeProgressiveRemoteJob(db, engine, executionId, { stop: true }),
  ).rejects.toThrow("verified execution-stop proof");
  expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
  engine.getExecutionStopProof.mockResolvedValueOnce({
    ...proof,
    execution_stopped: false,
  });
  if (mode === "success") {
    engine.getResult.mockResolvedValueOnce({
      ...structuredClone(result),
      state: "running",
    });
    engine.getResult.mockResolvedValueOnce({
      ...structuredClone(result),
      state: "running",
    });
  }
  const stopped = await reconcileProgressiveRemoteWorker(
    db,
    engine as unknown as EngineClient,
    { jobIds: [executionId] },
  );
  expect(stopped).toMatchObject({
    inspected: 1,
    reported: 1,
    stopped: 1,
    errors: [],
  });
  if (mode === "success") {
    expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(0);
    engine.getResult.mockResolvedValueOnce({
      ...structuredClone(result),
      state: "running",
    });
    expect(
      await reconcileProgressiveRemoteWorker(
        db,
        engine as unknown as EngineClient,
        {
          jobIds: [executionId],
        },
      ),
    ).toMatchObject({ inspected: 1, reported: 1, stopped: 1, errors: [] });
    const [latest] =
      await db.execute(sql`SELECT report FROM progressive_worker_reports
      WHERE sim_job_id = ${executionId}::uuid ORDER BY sequence DESC LIMIT 1`);
    expect((latest.report as { result: JobResult }).result.state).toBe(
      "cancelled",
    );
  }
  expect(
    await reconcileProgressiveRemoteWorker(
      db,
      engine as unknown as EngineClient,
      { jobIds: [executionId] },
    ),
  ).toMatchObject({ inspected: 0, reported: 0, stopped: 0, errors: [] });
  expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(0);
  const projections = await db.execute(sql`
    SELECT assignment_signature = report->>'assignmentSignature' AS assignment_matches,
      stopped_engine_job_id IS NOT DISTINCT FROM
        CASE WHEN report#>>'{stopProof,execution_stopped}' = 'true'
          THEN report#>>'{stopProof,job_id}' END AS stop_matches
    FROM progressive_worker_reports WHERE sim_job_id = ${executionId}::uuid
  `);
  expect(projections.length).toBeGreaterThan(0);
  expect(
    projections.every((row) => row.assignment_matches && row.stop_matches),
  ).toBe(true);
  await expect(
    db.execute(sql`
    UPDATE progressive_worker_reports SET stopped_engine_job_id = ${randomUUID()}
    WHERE sim_job_id = ${executionId}::uuid
  `),
  ).rejects.toThrow(
    'column "stopped_engine_job_id" can only be updated to DEFAULT',
  );
  if (mode === "timeout") expect(engine.getResult).not.toHaveBeenCalled();
  expect(engine.cancelJob).toHaveBeenCalledWith(
    executionId,
    expect.objectContaining({
      unregisteredExecution: {
        expected_engine: envelope.request.expected_engine,
        expected_execution_pool: envelope.request.expected_execution_pool,
      },
    }),
  );
  engine.cancelJob.mockClear();
  expect(
    await observeProgressiveRemoteJob(db, engine, executionId, { stop: true }),
  ).toMatchObject({ stopped: true, replayed: true });
  expect(engine.cancelJob).not.toHaveBeenCalled();
  proof.observed_at = "2026-09-07T19:40:00Z";
  expect(
    await observeProgressiveRemoteJob(db, engine, executionId, { stop: true }),
  ).toMatchObject({ stopped: true, replayed: true });
  if (mode === "success") {
    const changed = structuredClone(result);
    changed.polars[0].attempts![0].cl = 0.987654;
    engine.getResult
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(changed);
    await expect(
      observeProgressiveRemoteJob(db, engine, executionId, { stop: true }),
    ).rejects.toThrow("Final remote execution evidence cannot change");
  }
  const [evidence] = await db.execute(
    sql`SELECT count(*)::integer AS count FROM results WHERE sim_job_id = ${executionId}::uuid`,
  );
  expect(evidence.count).toBe(0);
  if (mode === "success")
    await verifyProgressiveWorkerEvidence(
      db,
      engine as unknown as EngineClient,
      envelope,
    );
  await db.execute(
    sql`UPDATE sim_jobs SET engine_job_id = ${randomUUID()} WHERE id = ${executionId}::uuid`,
  );
  engine.getJob.mockClear();
  engine.cancelJob.mockClear();
  await expect(
    observeProgressiveRemoteJob(db, engine, executionId, { stop: true }),
  ).rejects.toThrow("Foreign engine identity");
  expect(engine.getJob).not.toHaveBeenCalled();
  expect(engine.cancelJob).not.toHaveBeenCalled();
  expect(await solverQueuePressure(db, { jobIds: [executionId] })).toBe(1);
}
