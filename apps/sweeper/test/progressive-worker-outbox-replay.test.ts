import {
  analysisContentHash,
  createClient,
  progressiveRemotePointProjection,
  resolveProgressiveReportedPoint,
  sealProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import {
  OPENCFD_2606_ENGINE,
  type ProgressiveExecutionScope,
} from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { progressiveDeliverySelectionSql } from "../src/progressive-delivery-selection";
import { deliverNextProgressiveWorkerEvidence } from "../src/progressive-worker-evidence-delivery";
import {
  replayProgressiveWorkerOutbox,
  type ProgressiveWorkerOutboxReplayInput,
} from "../src/progressive-worker-outbox-replay";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
beforeEach(() => vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver"));
afterEach(() => vi.unstubAllEnvs());

const TABLES = [
  "sync_api_settings",
  "registered_remote_solvers",
  "sim_jobs",
  "sync_sweep_promises",
  "progressive_worker_submission_intents",
  "progressive_worker_reports",
  "progressive_worker_report_conflicts",
  "progressive_worker_evidence_receipts",
  "progressive_worker_evidence_attempts",
  "result_attempts",
  "results",
  "progressive_worker_evidence_delivery_claims",
  "progressive_worker_hub_receipts",
  "progressive_worker_delivery_failures",
] as const;

async function snapshot(connection: DB, tables: readonly string[] = TABLES) {
  const values: Record<string, unknown> = {};
  for (const table of tables) {
    values[table] =
      table === "sim_jobs"
        ? await connection.execute(sql`SELECT to_jsonb(retained) AS row FROM sim_jobs retained
          WHERE retained.id = (SELECT id FROM replay_target)
          ORDER BY to_jsonb(retained)::text`)
        : await connection.execute(sql`SELECT to_jsonb(retained) AS row FROM ${sql.identifier(table)} retained
          ORDER BY to_jsonb(retained)::text`);
  }
  return values;
}

async function withFixture(
  run: (fixture: {
    connection: DB;
    input: ProgressiveWorkerOutboxReplayInput;
    receipt: (
      point: ProgressiveWorkerOutboxReplayInput["points"][number],
    ) => Record<string, unknown>;
  }) => Promise<void>,
  pendingCount = 2,
) {
  await client.db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`CREATE TEMP TABLE sync_api_settings (
      id integer PRIMARY KEY, instance_id uuid, instance_name text, remote_solver_registered_id uuid,
      remote_solver_enabled boolean, remote_solver_transfer_paused boolean, remote_solver_auth_token text,
      upstream_base_url text) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE registered_remote_solvers (
      id uuid PRIMARY KEY, instance_id text, revoked_at timestamptz) ON COMMIT DROP`);
    await connection.execute(
      sql`CREATE TEMP TABLE replay_target (id uuid PRIMARY KEY) ON COMMIT DROP`,
    );
    await connection.execute(sql`CREATE TEMP TABLE sync_sweep_promises (
      id uuid PRIMARY KEY, registered_solver_id uuid, source_base_url text, airfoil_id uuid,
      simulation_preset_revision_id uuid, status text, "expiresAt" timestamptz, response_payload jsonb) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_submission_intents (
      sim_job_id uuid PRIMARY KEY, assignment_signature text, "authorization" jsonb) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_reports (
      sim_job_id uuid, sequence bigint, content_signature text, report jsonb, acknowledged_at timestamptz,
      created_at timestamptz DEFAULT clock_timestamp(),
      assignment_signature text GENERATED ALWAYS AS (report->>'assignmentSignature') STORED,
      stopped_engine_job_id text GENERATED ALWAYS AS (report#>>'{stopProof,job_id}') STORED,
      PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_report_conflicts (
      sim_job_id uuid, sequence bigint, PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_receipts (
      sim_job_id uuid, sequence bigint, content_signature text, PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_attempts (
      sim_job_id uuid, sequence bigint, result_attempt_id uuid, point_content_signature text,
      PRIMARY KEY(sim_job_id,sequence,result_attempt_id)) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE result_attempts (
      id uuid PRIMARY KEY, sim_job_id uuid, engine_job_id text, result_id uuid, airfoil_id uuid, bc_id uuid,
      simulation_preset_revision_id uuid, aoa_deg double precision, engine_case_slug text, evidence_payload jsonb,
      cl double precision, cd double precision, cm double precision, converged boolean, unsteady boolean) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE results (
      id uuid PRIMARY KEY, airfoil_id uuid, bc_id uuid, simulation_preset_revision_id uuid, aoa_deg double precision,
      reynolds bigint, speed double precision, chord double precision, mach double precision) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_delivery_claims (
      sim_job_id uuid, sequence bigint, result_attempt_id uuid, point_content_signature text, claim_token uuid,
      claim_expires_at timestamptz, PRIMARY KEY(sim_job_id,point_content_signature),
      FOREIGN KEY(sim_job_id,sequence,result_attempt_id)
        REFERENCES progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id)) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts (
      sim_job_id uuid, sequence bigint, result_attempt_id uuid, point_content_signature text, receipt jsonb,
      PRIMARY KEY(sim_job_id,point_content_signature)) ON COMMIT DROP`);
    await connection.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures (
      sim_job_id uuid, sequence bigint, result_attempt_id uuid, point_content_signature text, state text,
      attempt_count integer, retry_after timestamptz, last_http_status integer, last_error text,
      remote_conflict_ids jsonb, updated_at timestamptz DEFAULT clock_timestamp(),
      PRIMARY KEY(sim_job_id,point_content_signature)) ON COMMIT DROP`);

    const executionId = randomUUID();
    const instanceId = randomUUID();
    const solverId = randomUUID();
    const promiseId = randomUUID();
    const flowId = randomUUID();
    const geometryId = randomUUID();
    const bcId = randomUUID();
    const presetId = randomUUID();
    const revisionId = randomUUID();
    const sweepId = randomUUID();
    const [airfoil] = await connection.execute(
      sql`SELECT id FROM airfoils ORDER BY id LIMIT 1`,
    );
    const [medium] = await connection.execute(
      sql`SELECT id FROM mediums ORDER BY id LIMIT 1`,
    );
    const [profiles] = await connection.execute(sql`
      SELECT boundary_profiles.id AS boundary_profile_id,
        mesh_profiles.id AS mesh_profile_id,
        solver_profiles.id AS solver_profile_id,
        scheduling_profiles.id AS scheduling_profile_id,
        output_profiles.id AS output_profile_id,
        solver_profiles.solver_implementation_id
      FROM boundary_profiles
      CROSS JOIN mesh_profiles
      CROSS JOIN solver_profiles
      CROSS JOIN scheduling_profiles
      CROSS JOIN output_profiles
      WHERE boundary_profiles.slug = 'standard-airfoil-boundary'
        AND mesh_profiles.slug = 'standard-airfoil-cgrid'
        AND solver_profiles.slug = 'standard-airfoil-komega-sst'
        AND scheduling_profiles.slug = 'campaign-auto'
        AND output_profiles.slug = 'standard-airfoil-fields'
      LIMIT 1
    `);
    if (!airfoil || !medium || !profiles)
      throw new Error(
        "migrated fixture database is missing seeded setup prerequisites",
      );
    const airfoilId = String(airfoil.id);
    await connection.execute(sql`INSERT INTO flow_conditions
      (id,slug,name,medium_id,speed_mps,density,dynamic_viscosity,kinematic_viscosity)
      VALUES (${flowId}::uuid,${`worker-replay-flow-${executionId}`},'worker replay flow',${medium.id}::uuid,30,1.225,0.00001789,0.000014604)`);
    await connection.execute(sql`INSERT INTO reference_geometry_profiles
      (id,slug,name,reference_length_m)
      VALUES (${geometryId}::uuid,${`worker-replay-geometry-${executionId}`},'worker replay geometry',1)`);
    await connection.execute(sql`INSERT INTO boundary_conditions
      (id,slug,name,medium_id,reynolds,reference_chord_m,speed_mps,density,dynamic_viscosity,kinematic_viscosity)
      VALUES (${bcId}::uuid,${`worker-replay-boundary-${executionId}`},'worker replay boundary',${medium.id}::uuid,2000000,1,30,1.225,0.00001789,0.000014604)`);
    await connection.execute(sql`INSERT INTO sweep_definitions
      (id,slug,name,aoa_list)
      VALUES (${sweepId}::uuid,${`worker-replay-sweep-${executionId}`},'worker replay sweep','[0,1,2,3,4,5,6]'::jsonb)`);
    await connection.execute(sql`INSERT INTO simulation_presets
      (id,slug,name,flow_condition_id,reference_geometry_profile_id,boundary_profile_id,mesh_profile_id,
       solver_profile_id,scheduling_profile_id,output_profile_id,sweep_definition_id,legacy_boundary_condition_id)
      VALUES (${presetId}::uuid,${`worker-replay-preset-${executionId}`},'worker replay preset',${flowId}::uuid,${geometryId}::uuid,
        ${profiles.boundary_profile_id}::uuid,${profiles.mesh_profile_id}::uuid,${profiles.solver_profile_id}::uuid,
        ${profiles.scheduling_profile_id}::uuid,${profiles.output_profile_id}::uuid,${sweepId}::uuid,${bcId}::uuid)`);
    await connection.execute(sql`INSERT INTO simulation_preset_revisions
      (id,preset_id,revision_number,signature_hash,reynolds,reference_length_m,solver_implementation_id,snapshot)
      VALUES (${revisionId}::uuid,${presetId}::uuid,1,${`worker-replay-revision-${executionId}`},2000000,1,
        ${profiles.solver_implementation_id}::uuid,'{}'::jsonb)`);
    await connection.execute(
      sql`INSERT INTO replay_target VALUES (${executionId}::uuid)`,
    );
    const upstream = "https://worker-replay.invalid/api/sync/v1";
    const angles = [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      ...Array.from(
        { length: pendingCount },
        (_value, index) => 10 + index / 10,
      ),
    ];
    const units = angles.map((alpha) => ({
      unitId: randomUUID(),
      token: randomUUID(),
      alpha,
      activeBudgetSeconds: 900,
    }));
    const scope: ProgressiveExecutionScope = {
      executionContract: "progressive-cfd-v1",
      executionId,
      epochId: randomUUID(),
      generationId: randomUUID(),
      targetId: "a".repeat(64),
      recipeId: "b".repeat(64),
      stage: 2,
      units,
      tokens: units.map((unit) => unit.token),
    };
    const envelope = sealProgressiveRemoteExecution({
      solverId,
      promiseId,
      scope,
      request: {
        execution_id: executionId,
        expected_engine: { ...OPENCFD_2606_ENGINE },
        expected_execution_pool: "replay-test-pool",
        expected_solver_budget_version: 2,
        expected_mesh_recovery_version: 1,
        airfoil: { name: "isolated-replay-fixture" },
        chord_lengths: [1],
        speeds: [30],
        aoa: { angles },
        solver: { warm_start: true },
        resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
      },
    });
    const runtime = {
      ...OPENCFD_2606_ENGINE,
      build_id: "replay-fixture",
      application_source_sha256: "c".repeat(64),
    };
    const report: ProgressiveRemoteReport = {
      version: 1,
      solverId,
      promiseId,
      executionId,
      assignmentSignature: envelope.contentSignature,
      sequence: 3,
      status: {
        job_id: executionId,
        state: "completed",
        total_cases: angles.length,
        completed_cases: angles.length,
        engine: runtime,
      },
      result: {
        job_id: executionId,
        state: "completed",
        engine: runtime,
        execution_pool: "replay-test-pool",
        polars: [
          {
            chord: 1,
            speed: 30,
            reynolds: 2_000_000.4,
            mach: null,
            points: angles.map((alpha) => ({
              aoa_deg: alpha,
              case_slug: `fixture-${alpha}`,
              cl: alpha / 10,
              cd: 0.03,
              cm: -0.01,
              converged: true,
              unsteady: false,
              first_order_fallback: false,
              images: {},
              engine: runtime,
              solver_active_seconds: 48,
              evidence_artifacts: [
                {
                  kind: "log",
                  path: "fixture/log.txt",
                  mime_type: "text/plain",
                  sha256: "d".repeat(64),
                  byte_size: 24,
                },
              ],
            })),
          },
        ],
      },
      stopProof: {
        version: 1,
        job_id: executionId,
        execution_stopped: true,
        producer_stopped: true,
        namespace_verified: true,
        remaining: [],
        observed_at: "2026-09-09T00:00:00Z",
        error: null,
        fence: "terminal_result",
        ownership_basis: "recorded_execution_namespace",
      },
    };
    await connection.execute(sql`INSERT INTO sync_api_settings VALUES
      (1,${instanceId}::uuid,'fixture',${solverId}::uuid,true,false,'fixture-credential',${upstream})`);
    await connection.execute(
      sql`INSERT INTO registered_remote_solvers VALUES (${solverId}::uuid,${instanceId},NULL)`,
    );
    await connection.execute(sql`INSERT INTO sim_jobs
      (id,engine_job_id,airfoil_id,bc_ids,simulation_preset_revision_id,job_kind,reference_chord_m,status,
       request_payload,total_cases,completed_cases,ingest_lease_token,ingest_lease_expires_at)
      VALUES (${executionId}::uuid,${executionId},${airfoilId}::uuid,jsonb_build_array(${bcId}::uuid),
      ${revisionId}::uuid,'sweep',1,'done',${JSON.stringify({
        remoteSolver: true,
        syncPromiseId: promiseId,
        upstreamBaseUrl: upstream,
        remoteProgressiveExecution: envelope,
        engineRequest: envelope.request,
      })}::jsonb,
      0,0,NULL,NULL)`);
    await connection.execute(sql`INSERT INTO sync_sweep_promises VALUES
      (${promiseId}::uuid,${solverId}::uuid,${upstream},${airfoilId}::uuid,${revisionId}::uuid,
        'active',clock_timestamp()+interval '1 day','{}'::jsonb)`);
    await connection.execute(sql`INSERT INTO progressive_worker_submission_intents VALUES (${executionId}::uuid,
      ${envelope.contentSignature},${JSON.stringify({ kind: "authorized", executionId, contentSignature: envelope.contentSignature })}::jsonb)`);
    await connection.execute(sql`INSERT INTO progressive_worker_reports (sim_job_id,sequence,content_signature,report,acknowledged_at)
      VALUES (${executionId}::uuid,${report.sequence},${analysisContentHash(report)},${JSON.stringify(report)}::jsonb,clock_timestamp())`);
    await connection.execute(sql`INSERT INTO progressive_worker_evidence_receipts VALUES
      (${executionId}::uuid,${report.sequence},${analysisContentHash(report)})`);
    const points: ProgressiveWorkerOutboxReplayInput["points"] = [];
    const resultIds = new Map<string, string>();
    const receipt = (
      point: ProgressiveWorkerOutboxReplayInput["points"][number],
    ) => ({
      version: 1,
      kind: "retained-progressive-attempt",
      executionId,
      sequence: point.sequence,
      pointContentSignature: point.pointContentSignature,
      remoteResultId: resultIds.get(point.resultAttemptId),
      remoteResultAttemptId: point.resultAttemptId,
      resultId: randomUUID(),
      resultAttemptId: randomUUID(),
      storageOnly: false,
      receivedAt: "2026-09-09T00:01:00Z",
    });
    for (const alpha of angles) {
      const reported = resolveProgressiveReportedPoint(report.result!, {
        alpha,
        speed: 30,
        chord: 1,
        caseSlug: `fixture-${alpha}`,
      });
      const projection = progressiveRemotePointProjection({
        ...reported,
        envelope,
        report,
      });
      const resultId = randomUUID();
      const resultAttemptId = randomUUID();
      resultIds.set(resultAttemptId, resultId);
      const point = {
        pointContentSignature: reported.contentSignature,
        resultAttemptId,
        sequence: report.sequence,
      };
      await connection.execute(sql`INSERT INTO result_attempts VALUES (${resultAttemptId}::uuid,${executionId}::uuid,
        ${executionId},${resultId}::uuid,${airfoilId}::uuid,${bcId}::uuid,${revisionId}::uuid,${alpha},
        ${reported.point.case_slug!},${JSON.stringify(projection.evidencePayload)}::jsonb,
        ${projection.cl},${projection.cd},${projection.cm},${projection.converged},${projection.unsteady})`);
      await connection.execute(sql`INSERT INTO results VALUES (${resultId}::uuid,${airfoilId}::uuid,${bcId}::uuid,
        ${revisionId}::uuid,${alpha},2000000,30,1,0.09)`);
      await connection.execute(sql`INSERT INTO progressive_worker_evidence_attempts VALUES
        (${executionId}::uuid,${point.sequence},${resultAttemptId}::uuid,${point.pointContentSignature})`);
      if (alpha < 7) {
        await connection.execute(sql`INSERT INTO progressive_worker_hub_receipts VALUES
          (${executionId}::uuid,${point.sequence},${resultAttemptId}::uuid,${point.pointContentSignature},${JSON.stringify(receipt(point))}::jsonb)`);
      } else {
        points.push(point);
        await connection.execute(sql`INSERT INTO progressive_worker_delivery_failures
          (sim_job_id,sequence,result_attempt_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error,remote_conflict_ids)
          VALUES (${executionId}::uuid,${point.sequence},${resultAttemptId}::uuid,${point.pointContentSignature},'conflict',5,NULL,
            409,'Progressive evidence delivery failed (409): progressive_scope_closed Original ingestion scope is closed','[]'::jsonb)`);
      }
    }
    try {
      await run({
        connection,
        input: { executionId, points, expectedCount: points.length },
        receipt,
      });
    } finally {
      await connection.execute(
        sql`DELETE FROM sim_jobs WHERE id=${executionId}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM simulation_preset_revisions WHERE id=${revisionId}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM simulation_presets WHERE id=${presetId}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM sweep_definitions WHERE id=${sweepId}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM boundary_conditions WHERE id=${bcId}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM flow_conditions WHERE id=${flowId}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM reference_geometry_profiles WHERE id=${geometryId}::uuid`,
      );
    }
  });
}

it("dry-runs by default, then requeues exactly one selected source without altering evidence, leases, or attempts", async () => {
  await withFixture(async ({ connection, input }) => {
    input.points = input.points.slice(0, 1);
    input.expectedCount = 1;
    const before = await snapshot(connection);
    const preview = await replayProgressiveWorkerOutbox(connection, input);
    expect(preview).toMatchObject({
      mode: "dry-run",
      selectedCount: 1,
      requeuedCount: 0,
    });
    expect(preview.points[0].outcome).toBe("would_requeue");
    expect(await snapshot(connection)).toEqual(before);
    const applied = await replayProgressiveWorkerOutbox(
      connection,
      {
        ...input,
        expectedCount: undefined,
        manifestSignature: preview.manifestSignature,
      },
      { apply: true },
    );
    expect(applied.requeuedCount).toBe(1);
    expect(
      await snapshot(
        connection,
        TABLES.filter(
          (table) => table !== "progressive_worker_delivery_failures",
        ),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(before).filter(
          ([table]) => table !== "progressive_worker_delivery_failures",
        ),
      ),
    );
    const failures = await connection.execute(
      sql`SELECT to_jsonb(failure) AS row FROM progressive_worker_delivery_failures failure ORDER BY point_content_signature`,
    );
    for (const { row } of failures) {
      const failure = row as Record<string, unknown>;
      const original = (
        before.progressive_worker_delivery_failures as {
          row: Record<string, unknown>;
        }[]
      ).find(
        ({ row }) =>
          row.point_content_signature === failure.point_content_signature,
      )!.row;
      expect({
        ...failure,
        state: original.state,
        retry_after: original.retry_after,
      }).toEqual(original);
      expect(failure.state).toBe(
        failure.point_content_signature ===
          input.points[0].pointContentSignature
          ? "retry"
          : "conflict",
      );
    }
    await expect(
      replayProgressiveWorkerOutbox(connection, input, { apply: true }),
    ).rejects.toThrow("exact 409");
  });
});

it("retargets one stale closed-scope failure to the newer final report", async () => {
  await withFixture(async ({ connection, input }) => {
    input.points = input.points.slice(0, 1);
    input.expectedCount = 1;
    const point = input.points[0];
    await connection.execute(sql`UPDATE progressive_worker_delivery_failures
      SET sequence = 2
      WHERE sim_job_id = ${input.executionId}::uuid
        AND point_content_signature = ${point.pointContentSignature}`);
    const beforeEvidence = await snapshot(
      connection,
      TABLES.filter(
        (table) => table !== "progressive_worker_delivery_failures",
      ),
    );
    const preview = await replayProgressiveWorkerOutbox(connection, input);
    expect(preview.points[0].outcome).toBe("would_requeue");
    const applied = await replayProgressiveWorkerOutbox(
      connection,
      {
        ...input,
        expectedCount: undefined,
        manifestSignature: preview.manifestSignature,
      },
      { apply: true },
    );
    expect(applied.requeuedCount).toBe(1);
    const [failure] = await connection.execute(sql`
      SELECT sequence, result_attempt_id, state
      FROM progressive_worker_delivery_failures
      WHERE sim_job_id = ${input.executionId}::uuid
        AND point_content_signature = ${point.pointContentSignature}`);
    expect(failure).toEqual({
      sequence: String(point.sequence),
      result_attempt_id: point.resultAttemptId,
      state: "retry",
    });
    expect(await snapshot(connection, Object.keys(beforeEvidence))).toEqual(
      beforeEvidence,
    );
    await connection.execute(sql`UPDATE progressive_worker_delivery_failures
      SET sequence = 999, result_attempt_id = md5('future-reported-attempt')::uuid, state = 'conflict'
      WHERE sim_job_id = ${input.executionId}::uuid
        AND point_content_signature = ${point.pointContentSignature}`);
    await expect(
      replayProgressiveWorkerOutbox(connection, input),
    ).rejects.toThrow("exact 409");
  });
});

it("uses the migrated sim_jobs boundary array and rejects a foreign boundary", async () => {
  await withFixture(async ({ connection, input }) => {
    const columns = await connection.execute(sql`SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'sim_jobs'`);
    expect(columns.map((column) => column.column_name)).toContain("bc_ids");
    expect(columns.map((column) => column.column_name)).not.toContain("bc_id");
    const [job] = await connection.execute(sql`SELECT bc_ids FROM sim_jobs
      WHERE id=${input.executionId}::uuid`);
    expect(job.bc_ids).toHaveLength(1);
    expect(
      await replayProgressiveWorkerOutbox(connection, input),
    ).toMatchObject({
      selectedCount: input.points.length,
      mode: "dry-run",
    });
    await connection.execute(sql`UPDATE sim_jobs
      SET bc_ids=jsonb_build_array(md5('foreign-boundary')::uuid)
      WHERE id=${input.executionId}::uuid`);
    await expect(
      replayProgressiveWorkerOutbox(connection, input, { apply: true }),
    ).rejects.toThrow("local attempt or physical source");
  });
});

it("delivers a replay through the unchanged normal loop and removes only its failure after an exact hub receipt", async () => {
  await withFixture(async ({ connection, input, receipt }) => {
    input.points = input.points.slice(0, 1);
    input.expectedCount = 1;
    expect(
      await connection.execute(progressiveDeliverySelectionSql(false)),
    ).toHaveLength(0);
    const before = await snapshot(
      connection,
      TABLES.filter(
        (table) =>
          ![
            "progressive_worker_delivery_failures",
            "progressive_worker_hub_receipts",
            "progressive_worker_evidence_delivery_claims",
          ].includes(table),
      ),
    );
    const originalReceipts = await snapshot(connection, [
      "progressive_worker_hub_receipts",
    ]);
    await replayProgressiveWorkerOutbox(connection, input, { apply: true });
    const selected = await connection.execute(
      progressiveDeliverySelectionSql(false),
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].result_attempt_id).toBe(input.points[0].resultAttemptId);
    const fetcher = vi.fn<typeof fetch>(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      expect(body.results[0].remoteResultAttemptId).toBe(
        input.points[0].resultAttemptId,
      );
      expect(body.results[0].progressiveEvidence.pointContentSignature).toBe(
        input.points[0].pointContentSignature,
      );
      return Response.json({
        progressiveEvidenceReceipts: [receipt(input.points[0])],
      });
    });
    expect(
      await deliverNextProgressiveWorkerEvidence(connection, fetcher),
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      await connection.execute(sql`SELECT * FROM progressive_worker_delivery_failures
      WHERE result_attempt_id=${input.points[0].resultAttemptId}::uuid`),
    ).toHaveLength(0);
    expect(
      (await replayProgressiveWorkerOutbox(connection, input, { apply: true }))
        .points[0].outcome,
    ).toBe("already_delivered");
    expect(await snapshot(connection, Object.keys(before))).toEqual(before);
    const currentReceipts = await snapshot(connection, [
      "progressive_worker_hub_receipts",
    ]);
    expect(currentReceipts.progressive_worker_hub_receipts).toHaveLength(8);
    expect(currentReceipts.progressive_worker_hub_receipts).toEqual(
      expect.arrayContaining(
        originalReceipts.progressive_worker_hub_receipts as unknown[],
      ),
    );
    expect(
      await connection.execute(progressiveDeliverySelectionSql(false)),
    ).toHaveLength(0);
  });
});

it.each([
  [
    "wrong execution",
    sql`UPDATE result_attempts SET sim_job_id=md5('foreign-job')::uuid`,
  ],
  [
    "wrong engine",
    sql`UPDATE result_attempts SET engine_job_id='foreign-engine'`,
  ],
  [
    "wrong attempt signature",
    sql`UPDATE progressive_worker_evidence_attempts SET point_content_signature=repeat('d',64)`,
  ],
  [
    "wrong owner",
    sql`UPDATE sync_sweep_promises SET registered_solver_id=md5('foreign-owner')::uuid`,
  ],
  [
    "revoked owner",
    sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp()`,
  ],
  [
    "wrong instance",
    sql`UPDATE registered_remote_solvers SET instance_id='foreign-instance'`,
  ],
  [
    "wrong upstream",
    sql`UPDATE sync_api_settings SET upstream_base_url='https://foreign.invalid/api/sync/v1'`,
  ],
  [
    "multiple job boundaries",
    sql`UPDATE sim_jobs SET bc_ids=jsonb_build_array(bc_ids->>0,md5('foreign-boundary')::uuid)`,
  ],
  [
    "foreign attempt boundary",
    sql`UPDATE result_attempts SET bc_id=md5('foreign-boundary')::uuid`,
  ],
  [
    "foreign result boundary",
    sql`UPDATE results SET bc_id=md5('foreign-boundary')::uuid`,
  ],
  [
    "wrong original upstream",
    sql`UPDATE sync_sweep_promises SET source_base_url='https://foreign.invalid/api/sync/v1'`,
  ],
  [
    "changed request",
    sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{engineRequest,chord_lengths}','[2]'::jsonb)`,
  ],
  [
    "changed authorization",
    sql`UPDATE progressive_worker_submission_intents SET "authorization"='{}'::jsonb`,
  ],
  [
    "disabled worker",
    sql`UPDATE sync_api_settings SET remote_solver_enabled=false`,
  ],
  [
    "paused transfers",
    sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
  ],
  [
    "missing credential",
    sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
  ],
  [
    "wrong failure sequence",
    sql`UPDATE progressive_worker_delivery_failures SET sequence=999`,
  ],
  [
    "wrong failure attempt",
    sql`UPDATE progressive_worker_delivery_failures SET result_attempt_id=md5('foreign-attempt')::uuid`,
  ],
  [
    "wrong conflict class",
    sql`UPDATE progressive_worker_delivery_failures SET last_error='Progressive evidence delivery failed (409): promise_inactive progressive_scope_closed'`,
  ],
  [
    "code prefix only",
    sql`UPDATE progressive_worker_delivery_failures SET last_error='Progressive evidence delivery failed (409): progressive_scope_closed_other'`,
  ],
  [
    "wrong HTTP status",
    sql`UPDATE progressive_worker_delivery_failures SET last_http_status=403`,
  ],
  [
    "already queued",
    sql`UPDATE progressive_worker_delivery_failures SET state='retry',retry_after=clock_timestamp()`,
  ],
  [
    "import conflict",
    sql`UPDATE progressive_worker_delivery_failures SET remote_conflict_ids=jsonb_build_array(md5('import-conflict')::uuid)`,
  ],
  [
    "unacknowledged report",
    sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL`,
  ],
  [
    "changed report signature",
    sql`UPDATE progressive_worker_reports SET content_signature=repeat('d',64)`,
  ],
  [
    "changed stage receipt",
    sql`UPDATE progressive_worker_evidence_receipts SET content_signature=repeat('d',64)`,
  ],
  [
    "changed evidence",
    sql`UPDATE result_attempts SET evidence_payload='{}'::jsonb`,
  ],
  ["wrong physical source", sql`UPDATE results SET chord=2`],
  ["wrong local coefficient", sql`UPDATE result_attempts SET cl=100`],
  [
    "foreign result identity",
    sql`UPDATE results SET simulation_preset_revision_id=md5('foreign-revision')::uuid`,
  ],
  [
    "active ingest claim",
    sql`UPDATE sim_jobs SET ingest_lease_token=md5('claim'),ingest_lease_expires_at=clock_timestamp()+interval '1 day'`,
  ],
  [
    "unknown ingest expiry",
    sql`UPDATE sim_jobs SET ingest_lease_token=md5('claim'),ingest_lease_expires_at=NULL`,
  ],
  [
    "report conflict",
    sql`INSERT INTO progressive_worker_report_conflicts SELECT sim_job_id,sequence FROM progressive_worker_reports`,
  ],
  [
    "active delivery claim",
    sql`INSERT INTO progressive_worker_evidence_delivery_claims
    SELECT sim_job_id,sequence,result_attempt_id,point_content_signature,md5('claim')::uuid,clock_timestamp()+interval '1 day'
    FROM progressive_worker_evidence_attempts`,
  ],
  [
    "unknown delivery expiry",
    sql`INSERT INTO progressive_worker_evidence_delivery_claims
    SELECT sim_job_id,sequence,result_attempt_id,point_content_signature,md5('claim')::uuid,NULL
    FROM progressive_worker_evidence_attempts`,
  ],
] as const)(
  "refuses %s without changing any retained row",
  async (_name, mutation) => {
    await withFixture(async ({ connection, input }) => {
      await connection.execute(mutation);
      const before = await snapshot(connection);
      await expect(
        replayProgressiveWorkerOutbox(connection, input, { apply: true }),
      ).rejects.toThrow();
      expect(await snapshot(connection)).toEqual(before);
    });
  },
);

it("refuses the whole selection if only one point has drifted", async () => {
  await withFixture(async ({ connection, input }) => {
    await connection.execute(sql`UPDATE progressive_worker_delivery_failures SET last_http_status=500
      WHERE result_attempt_id=${input.points[1].resultAttemptId}::uuid`);
    const before = await snapshot(connection);
    await expect(
      replayProgressiveWorkerOutbox(connection, input, { apply: true }),
    ).rejects.toThrow("exact 409");
    expect(await snapshot(connection)).toEqual(before);
  });
});

it("requires a final stopped report even when its running bytes have a matching staging signature", async () => {
  await withFixture(async ({ connection, input }) => {
    const [stored] = await connection.execute(
      sql`SELECT report FROM progressive_worker_reports`,
    );
    const report = structuredClone(
      stored.report,
    ) as unknown as ProgressiveRemoteReport;
    report.status.state = "running";
    report.result!.state = "running";
    report.stopProof = null;
    const signature = analysisContentHash(report);
    await connection.execute(
      sql`UPDATE progressive_worker_reports SET report=${JSON.stringify(report)}::jsonb,content_signature=${signature}`,
    );
    await connection.execute(
      sql`UPDATE progressive_worker_evidence_receipts SET content_signature=${signature}`,
    );
    const before = await snapshot(connection);
    await expect(
      replayProgressiveWorkerOutbox(connection, input, { apply: true }),
    ).rejects.toThrow("final report");
    expect(await snapshot(connection)).toEqual(before);
  });
});

it("leaves another scope-closed rejection terminal after one explicit replay", async () => {
  await withFixture(async ({ connection, input }) => {
    input.points = input.points.slice(0, 1);
    input.expectedCount = 1;
    await replayProgressiveWorkerOutbox(connection, input, { apply: true });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          code: "progressive_scope_closed",
          error: "Original ingestion scope is closed",
        },
        { status: 409 },
      ),
    );
    await expect(
      deliverNextProgressiveWorkerEvidence(connection, fetcher),
    ).rejects.toThrow("progressive_scope_closed");
    const [failure] =
      await connection.execute(sql`SELECT state,attempt_count,retry_after
      FROM progressive_worker_delivery_failures WHERE result_attempt_id=${input.points[0].resultAttemptId}::uuid`);
    expect(failure).toEqual({
      state: "conflict",
      attempt_count: 6,
      retry_after: null,
    });
    expect(
      await deliverNextProgressiveWorkerEvidence(connection, fetcher),
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

it("quarantines an exact stale remote-owner rejection instead of retrying forever", async () => {
  await withFixture(async ({ connection, input }) => {
    input.points = input.points.slice(0, 1);
    input.expectedCount = 1;
    await replayProgressiveWorkerOutbox(connection, input, { apply: true });
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: "remote solver does not own this exact promise payload" },
        { status: 403 },
      ),
    );
    await expect(
      deliverNextProgressiveWorkerEvidence(connection, fetcher),
    ).rejects.toThrow("remote solver does not own this exact promise payload");
    const [failure] = await connection.execute(sql`
      SELECT state, attempt_count, retry_after
      FROM progressive_worker_delivery_failures
      WHERE result_attempt_id=${input.points[0].resultAttemptId}::uuid`);
    expect(failure).toEqual({
      state: "conflict",
      attempt_count: 6,
      retry_after: null,
    });
    expect(
      await deliverNextProgressiveWorkerEvidence(connection, fetcher),
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

it("refuses selection/count/manifest drift and the hub role before any mutation", async () => {
  await withFixture(async ({ connection, input }) => {
    const before = await snapshot(connection);
    const invalid: ProgressiveWorkerOutboxReplayInput[] = [
      { ...input, executionId: randomUUID() },
      {
        ...input,
        points: input.points.map((point) => ({
          ...point,
          sequence: point.sequence + 1,
        })),
      },
      {
        ...input,
        points: input.points.map((point) => ({
          ...point,
          resultAttemptId: randomUUID(),
        })),
      },
      {
        ...input,
        points: input.points.map((point, index) => ({
          ...point,
          pointContentSignature: String(index).repeat(64),
        })),
      },
      { ...input, expectedCount: undefined },
      { ...input, expectedCount: 1 },
      { ...input, manifestSignature: "f".repeat(64) },
      { ...input, points: [], expectedCount: 0 },
      {
        ...input,
        points: Array.from({ length: 65 }, () => input.points[0]),
        expectedCount: 65,
      },
      { ...input, points: [input.points[0], input.points[0]] },
    ];
    for (const candidate of invalid)
      await expect(
        replayProgressiveWorkerOutbox(connection, candidate, { apply: true }),
      ).rejects.toThrow();
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
    await expect(
      replayProgressiveWorkerOutbox(connection, input, { apply: true }),
    ).rejects.toThrow("remote-solver");
    expect(await snapshot(connection)).toEqual(before);
  });
});

it("allows an expired claim without changing it and rejects a changed hub receipt", async () => {
  await withFixture(async ({ connection, input, receipt }) => {
    await connection.execute(sql`INSERT INTO progressive_worker_evidence_delivery_claims
      SELECT sim_job_id,sequence,result_attempt_id,point_content_signature,md5('expired-claim')::uuid,clock_timestamp()-interval '1 day'
      FROM progressive_worker_evidence_attempts`);
    const before = await snapshot(connection, [
      "progressive_worker_evidence_delivery_claims",
    ]);
    expect(
      (await replayProgressiveWorkerOutbox(connection, input)).selectedCount,
    ).toBe(2);
    expect(
      await snapshot(connection, [
        "progressive_worker_evidence_delivery_claims",
      ]),
    ).toEqual(before);
    const point = input.points[0];
    await connection.execute(sql`INSERT INTO progressive_worker_hub_receipts VALUES
      (${input.executionId}::uuid,${point.sequence},${point.resultAttemptId}::uuid,${point.pointContentSignature},
        ${JSON.stringify({ ...receipt(point), remoteResultAttemptId: randomUUID() })}::jsonb)`);
    const changed = await snapshot(connection);
    await expect(
      replayProgressiveWorkerOutbox(connection, input, { apply: true }),
    ).rejects.toThrow("hub receipt differs");
    expect(await snapshot(connection)).toEqual(changed);
  });
});

it("accepts the maximum 64 exact points in one finite operation", async () => {
  await withFixture(async ({ connection, input }) => {
    expect(input.points).toHaveLength(64);
    const before = await snapshot(
      connection,
      TABLES.filter(
        (table) => table !== "progressive_worker_delivery_failures",
      ),
    );
    expect(
      (await replayProgressiveWorkerOutbox(connection, input, { apply: true }))
        .requeuedCount,
    ).toBe(64);
    expect(await snapshot(connection, Object.keys(before))).toEqual(before);
    const [counts] =
      await connection.execute(sql`SELECT count(*)::int AS total, min(attempt_count) AS min_attempts,
      max(attempt_count) AS max_attempts FROM progressive_worker_delivery_failures WHERE state='retry' AND retry_after IS NOT NULL`);
    expect(counts).toEqual({ total: 64, min_attempts: 5, max_attempts: 5 });
  }, 64);
});

it("runs CLI help and refuses ambiguous flags before connecting to a database", async () => {
  const cli = fileURLToPath(
    new URL("../src/progressive-worker-outbox-replay-cli.ts", import.meta.url),
  );
  const execute = promisify(execFile);
  const help = await execute(process.execPath, [
    "--import",
    "tsx",
    cli,
    "--help",
  ]);
  expect(help.stdout).toContain("Default: dry-run");
  expect(help.stdout).toContain("1..64");
  await expect(
    execute(process.execPath, ["--import", "tsx", cli, "--apply", "--dry-run"]),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Usage:"),
  });
}, 30000);
