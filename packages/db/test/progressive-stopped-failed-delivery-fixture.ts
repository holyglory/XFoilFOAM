import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import { progressiveReportedPointSources, type ProgressiveRemoteReport } from "../src/progressive-remote-report";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { progressiveRemotePointProjection } from "../src/progressive-remote-point-projection";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { resolveProgressiveRemoteEvidence } from "../src/progressive-remote-evidence";
import { readProgressiveRemoteRetention } from "../src/progressive-remote-retention";
import { claimProgressivePolarFit } from "../src/progressive-polar-cache";
import { issueProgressiveRemoteDiagnosticReceipts } from "../src/progressive-remote-diagnostic-receipts";
import { resultAttempts, solverEvidenceArtifacts, syncBrokeredEvidenceUploads } from "../src/schema";
import { registerVerifiedBrokeredEvidenceArchive } from "../src/brokered-evidence-archive";
import { readProgressiveEvidenceCustodyReceipt } from "../src/progressive-evidence-custody";
import type { ProgressiveRemoteEvidenceDelivery } from "../src/progressive-remote-evidence-receipts";
import { progressiveRemoteEvidenceResult } from "./progressive-remote-evidence-fixture";
import { progressiveArchiveManifestBytes, progressiveArchiveManifestSha256, progressiveArchiveMembers } from "./progressive-archive-data";
import { verifyDiagnosticWorkerDrain } from "./progressive-diagnostic-worker-drain-fixture";
import { withProgressiveSyncApi } from "../../../apps/api/test/progressive-polar-import-fixture";
import { applyProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { settleProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-settlement";
import { buildProgressiveFitRequest } from "../../../apps/sweeper/src/progressive-fitting";
import { deliverNextProgressiveWorkerEvidence } from "../../../apps/sweeper/src/progressive-worker-evidence-delivery";

async function verifyLegacyFailedAttemptAck(db: DB, executionId: string) {
  const [source] = await db.execute(sql`SELECT association.*,attempt.result_id,attempt.evidence_payload,original.token
    FROM progressive_worker_evidence_attempts association JOIN result_attempts attempt ON attempt.id=association.result_attempt_id
    JOIN progressive_cfd_units unit ON unit.aoa_deg=attempt.aoa_deg
    JOIN progressive_cfd_attempts original ON original.unit_id=unit.id AND original.sim_job_id=association.sim_job_id
    WHERE association.sim_job_id=${executionId}::uuid LIMIT 1`);
  await db.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
  await db.execute(sql`INSERT INTO progressive_remote_evidence_receipts
    (sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_id,remote_result_attempt_id,storage_only)
    VALUES(${executionId}::uuid,${source.sequence},${source.point_content_signature},${source.result_attempt_id}::uuid,
      ${source.result_id}::uuid,${source.result_attempt_id}::uuid,false)`);
  await db.execute(sql`INSERT INTO progressive_cfd_evidence
    (attempt_token,result_attempt_id,evidence_signature,solver_active_seconds,budget_guard_exhausted)
    VALUES(${source.token}::uuid,${source.result_attempt_id}::uuid,${analysisContentHash(source.evidence_payload)},1,false)`);
  await db.execute(sql`DELETE FROM progressive_worker_hub_receipts WHERE sim_job_id=${executionId}::uuid`);
  expect(await issueProgressiveRemoteDiagnosticReceipts(db, executionId)).toHaveLength(0);
  await withProgressiveSyncApi(db, async (app) => {
    const fetcher: typeof fetch = async (url, options) => {
      const response = await app.inject({ method: "POST", url: new URL(String(url)).pathname,
        headers: Object.fromEntries(new Headers(options?.headers)), payload: JSON.parse(String(options?.body)) });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    };
    expect(await deliverNextProgressiveWorkerEvidence(db, fetcher)).toBe(true);
    expect(await deliverNextProgressiveWorkerEvidence(db, fetcher)).toBe(false);
  });
  const [retained] = await db.execute(sql`SELECT receipt FROM progressive_worker_hub_receipts WHERE sim_job_id=${executionId}::uuid`);
  expect(retained.receipt).toMatchObject({ kind: "retained-progressive-attempt", resultAttemptId: source.result_attempt_id });
  expect(await db.execute(sql`SELECT sim_job_id FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
}

async function retainFailedArchive(db: DB, delivery: ProgressiveRemoteEvidenceDelivery, resultAttemptId: string) {
  const [raw] = await db.select().from(resultAttempts).where(eq(resultAttempts.id, resultAttemptId));
  const [solver] = await db.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${delivery.solverId}::uuid`);
  const [promised] = await db.execute(sql`SELECT id FROM sync_sweep_promise_points
    WHERE promise_id=${delivery.promiseId}::uuid AND aoa_deg=${delivery.aoaDeg}`);
  const uploadId = randomUUID();
  const identity = {
    bucket: "isolated-stopped-failed-custody", objectKey: `solver-evidence/v1/sha256/cc/${"c".repeat(64)}.tar.zst`,
    generation: "9007199254740993123", crc32c: "ImIEBA==", storedSha256: "c".repeat(64), storedByteSize: 500,
    tarSha256: "d".repeat(64), tarByteSize: 1500, manifestSha256: progressiveArchiveManifestSha256,
    manifestByteSize: progressiveArchiveManifestBytes.byteLength, zstdLevel: 3, bundledFileCount: 1, verifiedAt: new Date(),
  };
  await db.execute(sql`UPDATE sync_sweep_promises SET request_payload=coalesce(request_payload,'{}'::jsonb)||
    ${JSON.stringify({ solverId: delivery.solverId })}::jsonb WHERE id=${delivery.promiseId}::uuid`);
  await db.insert(syncBrokeredEvidenceUploads).values({
    ...identity, id: uploadId, idempotencyKey: randomUUID(), state: "verified", promiseId: delivery.promiseId,
    promisePointId: String(promised.id), solverId: delivery.solverId, sourceInstanceId: String(solver.instance_id),
    remoteResultId: delivery.remoteResultId, remoteResultAttemptId: delivery.remoteResultAttemptId,
    aoaDeg: delivery.aoaDeg, engineJobId: delivery.engineJobId, engineCaseSlug: delivery.engineCaseSlug,
  });
  const owner = {
    resultId: raw.resultId!, resultAttemptId: raw.id, airfoilId: raw.airfoilId, simJobId: raw.simJobId,
    engineJobId: raw.engineJobId, engineCaseSlug: raw.engineCaseSlug, methodKey: raw.methodKey,
    solverImplementationId: raw.solverImplementationId, solverRuntimeBuildId: raw.solverRuntimeBuildId, aoaDeg: raw.aoaDeg,
  };
  const [bundle] = await db.insert(solverEvidenceArtifacts).values({
    ...owner, kind: "engine_bundle", storageKey: identity.objectKey, mimeType: "application/zstd",
    sha256: identity.storedSha256, byteSize: identity.storedByteSize,
    metadata: { remoteEvidenceUploadId: uploadId, storageBackend: "gcs", ...identity },
  }).returning();
  const [manifest] = await db.insert(solverEvidenceArtifacts).values({
    ...owner, kind: "manifest", storageKey: `${identity.objectKey}.manifest`, mimeType: "application/json",
    sha256: identity.manifestSha256, byteSize: identity.manifestByteSize,
  }).returning();
  await db.update(syncBrokeredEvidenceUploads).set({
    state: "bound", boundAt: new Date(), canonicalResultId: raw.resultId,
    canonicalResultAttemptId: raw.id, canonicalArtifactId: bundle.id,
  }).where(eq(syncBrokeredEvidenceUploads.id, uploadId));
  await registerVerifiedBrokeredEvidenceArchive(db, {
    resultId: raw.resultId!, resultAttemptId: raw.id, sourceArtifactId: bundle.id,
    manifestArtifactId: manifest.id, evidenceBase: "isolated-case", identity, memberSet: progressiveArchiveMembers,
  });
  expect((await readProgressiveEvidenceCustodyReceipt(db, delivery, uploadId)).canonical.resultAttemptId).toBe(raw.id);
}

export async function verifyPriorRawStoppedProgressiveSettlement(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  const restore = new Error("Restore final progress with prior raw failures");
  await expect(db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const executionId = envelope.scope.executionId;
    expect(envelope.scope.units).toHaveLength(7);
    const result = progressiveRemoteEvidenceResult(envelope);
    result.mesh_recovery_version = 3;
    const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
      WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
    result.polars[0].reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
    const base = result.polars[0].attempts![0];
    const reported = envelope.scope.units.slice(0, 3).map((unit, index) => ({
      ...base, aoa_deg: unit.alpha, case_slug: `prior-raw-case-${index}`,
      cl: null, cd: null, cm: null, converged: false,
      failure_disposition: index === 0 ? "hard_solver" as const : "infrastructure" as const,
      error: index === 0 ? "Retained nonconverged physical history" : "Retained infrastructure attempt",
      evidence_artifacts: index === 0 ? base.evidence_artifacts : [],
      ...(index === 0 ? { force_history: { t: [0, 0.1, 0.2, 0.3], cl: [0.4, 0.4, 0.4, 0.4],
        cd: [0.03, 0.03, 0.03, 0.03], cm: [0, 0, 0, 0], window_start: 0, source_start_time: 0 } } : {}),
    }));
    result.polars[0].attempts = reported;
    const early: ProgressiveRemoteReport = {
      version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId,
      assignmentSignature: envelope.contentSignature, sequence: 282,
      status: { job_id: executionId, state: "failed", total_cases: 7, completed_cases: 2 }, result, stopProof: null,
    };
    await storeProgressiveRemoteReport(connection, {
      executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report: early,
    });
    expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({ kind: "applied", sequence: 282 });
    const token = "isolated-prior-raw-credential";
    const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN('polars','sweeps')`);
    await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
      WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id} WHERE id=${envelope.promiseId}::uuid`);
    const sources = progressiveReportedPointSources(result);
    await withProgressiveSyncApi(connection, async (app) => {
      for (const source of sources.slice(0, 2)) {
        const delivery = {
          solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
          aoaDeg: source.point.aoa_deg, engineCaseSlug: source.point.case_slug!,
          remoteResultId: randomUUID(), remoteResultAttemptId: randomUUID(),
          progressiveEvidence: { sequence: 282, reportContentSignature: analysisContentHash(early), pointContentSignature: source.contentSignature },
        };
        const resolved = await resolveProgressiveRemoteEvidence(connection, delivery);
        const response = await app.inject({ method: "POST", url: "/api/sync/v1/polars",
          headers: { "x-xfoilfoam-solver-token": token },
          payload: { promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
            results: [{ ...progressiveRemotePointProjection(resolved!), ...delivery, fieldExtents: [], evidenceArtifacts: [], media: [] }] } });
        expect(response.statusCode, response.body).toBe(200);
        const receipt = response.json().progressiveEvidenceReceipts[0];
        expect(receipt.storageOnly).toBe(false);
        if (source === sources[0]) await retainFailedArchive(connection, delivery, String(receipt.resultAttemptId));
      }
    });
    const before = await connection.execute(sql`SELECT point_content_signature,result_attempt_id,storage_only
      FROM progressive_remote_evidence_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`);
    expect(before).toHaveLength(2);
    const final = structuredClone(early);
    final.sequence = 283;
    final.result!.state = "failed";
    final.stopProof = { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
      namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
      fence: "terminal_result", ownership_basis: "recorded_execution_namespace" };
    await withProgressiveSyncApi(connection, async (app) => {
      const response = await app.inject({ method: "POST", url: `/api/sync/v1/progressive-executions/${executionId}/reports`,
        headers: { "x-xfoilfoam-solver-token": token }, payload: { promiseId: envelope.promiseId, report: final } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ received: true, receipt: { sequence: 283, contentSignature: analysisContentHash(final) } });
    });
    const remaining = envelope.scope.units.slice(2).map((unit) => unit.token);
    await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp()
      WHERE token IN(${sql.join(remaining.map((token) => sql`${token}::uuid`), sql`, `)})`);
    await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE token IN(${sql.join(remaining.map((token) => sql`${token}::uuid`), sql`, `)}))`);
    const [stillOwned] = await connection.execute(sql`SELECT count(*)::int AS count FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid AND attempt.outcome='running' AND unit.state='leased' AND unit.lease_token=attempt.token`);
    expect(stillOwned.count).toBe(2);
    expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({ kind: "applied", sequence: 283, stopped: true });
    expect(await connection.execute(sql`SELECT sequence FROM progressive_remote_progress_receipts
      WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`)).toEqual([{ sequence: 282 }, { sequence: 283 }]);
    expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({ kind: "retained", sources: [{}, {}] });
    expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
    const [finished] = await connection.execute(sql`SELECT status,"ingestedAt",completed_cases,total_cases FROM sim_jobs WHERE id=${executionId}::uuid`);
    expect(finished).toMatchObject({ status: "failed", completed_cases: 2, total_cases: 7 });
    expect(finished.ingestedAt).not.toBeNull();
    expect(await connection.execute(sql`SELECT point_content_signature,result_attempt_id,storage_only
      FROM progressive_remote_evidence_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`)).toEqual(before);
    const diagnostics = await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
      WHERE sim_job_id=${executionId}::uuid`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ point_content_signature: sources[2].contentSignature,
      receipt: { kind: "retained-progressive-diagnostic", failureKind: "infrastructure" } });
    expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(2);
    expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid AND valid_for_polar`)).toHaveLength(0);
    expect(await connection.execute(sql`SELECT token FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid AND outcome='running'`)).toHaveLength(0);
    const [original] = await connection.execute(sql`SELECT content_signature FROM progressive_remote_reports
      WHERE sim_job_id=${executionId}::uuid AND sequence=282`);
    expect(original.content_signature).toBe(analysisContentHash(early));
    throw restore;
  })).rejects.toBe(restore);
}

export async function verifyStoppedFailedProgressiveDelivery(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  for (const variant of ["physical", "divergent", "nonphysical", "startup", "infrastructure", "hard_solver", "history-without-manifest"] as const) {
    const restore = new Error(`Restore stopped failed delivery ${variant}`);
    await expect(db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const executionId = envelope.scope.executionId;
      const result = progressiveRemoteEvidenceResult(envelope);
      result.mesh_recovery_version = 3;
      const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
        WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
      result.polars[0].reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
      const point = result.polars[0].attempts![0];
      point.cl = null;
      point.cd = null;
      point.cm = null;
      point.converged = false;
      point.failure_disposition = variant === "infrastructure" ? "infrastructure" : "hard_solver";
      point.error = "Isolated authentic terminal failed attempt";
      const physical = !["infrastructure", "hard_solver", "history-without-manifest"].includes(variant);
      if (physical || variant === "history-without-manifest") {
        const samples = Array.from({ length: 64 }, (_, index) => index);
        point.force_history = {
          t: samples.map((index) => index * (variant === "startup" ? 0.000001 : 0.1)),
          cl: samples.map(() => 0.4), cd: samples.map(() => variant === "nonphysical" ? -0.03 : 0.03),
          cm: samples.map(() => 0), samples: samples.length,
          window_start: 0, source_start_time: 0,
        };
      }
      if (variant === "divergent") point.error = "FOAM FATAL ERROR: isolated divergent history";
      if (!physical) point.evidence_artifacts = [];
      result.state = "completed";
      const report: ProgressiveRemoteReport = {
        version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId,
        executionId, assignmentSignature: envelope.contentSignature, sequence: 1,
        status: { job_id: executionId, state: "completed", total_cases: envelope.scope.units.length, completed_cases: 1 },
        result,
        stopProof: {
          version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
          namespace_verified: true, remaining: [], observed_at: new Date().toISOString(),
          error: null, fence: "terminal_result", ownership_basis: "recorded_execution_namespace",
        },
      };
      await storeProgressiveRemoteReport(connection, {
        executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report,
      });
      await applyProgressiveRemoteProgress(connection, executionId);
      await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp()
        WHERE sim_job_id=${executionId}::uuid`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
        WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
      const before = await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.id`);
      const source = progressiveReportedPointSources(result)[0];
      const reference = { sequence: 1, reportContentSignature: analysisContentHash(report), pointContentSignature: source.contentSignature };
      const delivery = {
        solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
        aoaDeg: point.aoa_deg, engineCaseSlug: point.case_slug!, progressiveEvidence: reference,
        remoteResultId: randomUUID(), remoteResultAttemptId: randomUUID(),
      };
      const retainedSource = await resolveProgressiveRemoteEvidence(connection, delivery);
      expect(retainedSource).not.toBeNull();
      const projection = progressiveRemotePointProjection(retainedSource!);
      expect(projection.status).toBe("failed");
      const token = "isolated-stopped-failed-credential";
      const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
      await connection.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
      await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN('polars','sweeps')`);
      await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
        WHERE id=${envelope.solverId}::uuid`);
      await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id}
        WHERE id=${envelope.promiseId}::uuid`);
      await withProgressiveSyncApi(connection, async (app) => {
        const headers = { "x-xfoilfoam-solver-token": token };
        const payload = {
          promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
          results: [{ ...projection, ...delivery, progressiveEvidence: reference,
            fieldExtents: [], evidenceArtifacts: [], media: [] }],
        };
        const strict = await app.inject({ method: "POST", url: "/api/sync/v1/polars", headers, payload });
        expect(strict.statusCode, strict.body).toBe(409);
        if (physical) {
          if (variant === "physical") {
            const [original] = await connection.execute(sql`SELECT token,unit_id,execution_recipe_id,started_at
              FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
              WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${point.aoa_deg}`);
            const guards = [
              sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`,
              sql`UPDATE sim_campaigns SET current_plan_revision_id=NULL
                WHERE id=(SELECT campaign_id FROM sim_jobs WHERE id=${executionId}::uuid)`,
              sql`UPDATE calculation_epochs SET current=false WHERE id=${envelope.scope.epochId}::uuid`,
              sql`UPDATE sim_jobs SET ingest_lease_token='live-owner',ingest_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${executionId}::uuid`,
              sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
                VALUES(${randomUUID()}::uuid,${original.unit_id}::uuid,'newer-owner',${original.execution_recipe_id},
                  ${new Date(original.started_at as string | Date).toISOString()}::timestamptz+interval '1 second',clock_timestamp(),'failed')`,
              sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{engineRequest,speeds}', '[999]'::jsonb)
                WHERE id=${executionId}::uuid`,
            ];
            for (const mutation of guards) {
              const rollback = new Error("Restore stopped failure refusal");
              await expect(connection.transaction(async (nested) => {
                await nested.execute(mutation);
                const rejected = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
                expect([409, 503], rejected.body).toContain(rejected.statusCode);
                throw rollback;
              })).rejects.toBe(rollback);
            }
          }
          const response = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
          expect(response.statusCode, response.body).toBe(200);
          const receipt = response.json().progressiveEvidenceReceipts[0];
          expect(receipt).toMatchObject({ kind: "retained-progressive-attempt", storageOnly: true,
            executionId, pointContentSignature: source.contentSignature });
          const [raw] = await connection.execute(sql`SELECT status,valid_for_polar,evidence_payload FROM result_attempts WHERE id=${receipt.resultAttemptId}::uuid`);
          expect(raw.status).toBe("failed");
          expect(raw.valid_for_polar).toBe(false);
          expect(analysisContentHash(raw.evidence_payload)).toBe(analysisContentHash(projection.evidencePayload));
          const [linked] = await connection.execute(sql`SELECT evidence.attempt_token FROM progressive_cfd_evidence evidence
            JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token
            WHERE evidence.result_attempt_id=${receipt.resultAttemptId}::uuid AND attempt.sim_job_id=${executionId}::uuid`);
          expect(linked).toBeDefined();
          const [prediction] = await connection.execute(sql`SELECT id FROM neuralfoil_predictions
            WHERE target_id=${envelope.scope.targetId} AND epoch_id=${envelope.scope.epochId}::uuid ORDER BY created_at DESC,id LIMIT 1`);
          const fit = await claimProgressivePolarFit(connection, {
            owner: "isolated-stopped-failed-fit", leaseSeconds: 120, predictionId: String(prediction.id),
            requireCfdEvidence: true, currentCampaignEvidenceOnly: true,
          });
          expect(fit?.source.evidence.some((entry) => entry.resultAttemptId === receipt.resultAttemptId &&
            analysisContentHash(entry.payload) === analysisContentHash(projection.evidencePayload))).toBe(true);
          const request = buildProgressiveFitRequest(fit!);
          const observation = [...request.observations, ...request.histories.map((history) => history.observation)]
            .find((entry) => entry.attempt_id === receipt.resultAttemptId)!;
          expect(observation.eligible).toBe(variant === "physical");
          if (variant !== "physical") expect(observation.exclusion_reason).toBe(
            variant === "divergent" ? "divergent_or_fatal_solver_evidence"
              : variant === "nonphysical" ? "nonphysical_history_coefficients" : "startup_only_history",
          );
          expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({ kind: "waiting", reason: "archives" });
          expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "waiting", reason: "archives" });
          const replay = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
          expect(replay.statusCode, replay.body).toBe(200);
          expect(replay.json().progressiveEvidenceReceipts[0]).toEqual(receipt);
          const [canonical] = await connection.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${receipt.resultId}::uuid`);
          expect(canonical.current_result_attempt_id).toBeNull();
          if (variant === "physical") {
            const rollback = new Error("Restore lost stopped-failure ACK after retry");
            await expect(connection.transaction(async (nested) => {
              const [original] = await nested.execute(sql`SELECT attempt.unit_id,attempt.execution_recipe_id,attempt.started_at
                FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
                WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${point.aoa_deg}`);
              await nested.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
                VALUES(${randomUUID()}::uuid,${original.unit_id}::uuid,'retry-after-ACK',${original.execution_recipe_id},
                  ${new Date(original.started_at as string | Date).toISOString()}::timestamptz+interval '1 second',clock_timestamp(),'failed')`);
              const retried = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
              expect(retried.statusCode, retried.body).toBe(200);
              expect(retried.json().progressiveEvidenceReceipts[0]).toEqual(receipt);
              const changed = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers,
                payload: { ...payload, results: [{ ...payload.results[0], progressiveEvidence: { ...reference, pointContentSignature: "0".repeat(64) } }] } });
              expect(changed.statusCode, changed.body).toBe(409);
              throw rollback;
            })).rejects.toBe(rollback);
          }
          await retainFailedArchive(connection, delivery, String(receipt.resultAttemptId));
          expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({ kind: "retained",
            sources: [{ resultAttemptId: receipt.resultAttemptId, archived: true, storageOnly: true }] });
        } else {
          const response = await app.inject({ method: "POST", url: `/api/sync/v1/progressive-executions/${executionId}/reports`, headers,
            payload: { promiseId: envelope.promiseId, report, diagnostic: { aoaDeg: point.aoa_deg,
              engineCaseSlug: point.case_slug, remoteResultId: delivery.remoteResultId,
              remoteResultAttemptId: delivery.remoteResultAttemptId, pointContentSignature: source.contentSignature } } });
          if (variant === "history-without-manifest") {
            expect(response.statusCode, response.body).toBe(409);
            const physical = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
            expect(physical.statusCode, physical.body).toBe(409);
          } else {
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json().diagnosticReceipt).toMatchObject({ kind: "retained-progressive-diagnostic", failureKind: variant,
              executionId, pointContentSignature: source.contentSignature });
            expect(response.json().diagnosticReceipt).not.toHaveProperty("resultId");
            expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
          }
        }
      });
      expect(await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.id`)).toEqual(before);
      expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid AND valid_for_polar`)).toHaveLength(0);
      const [promise] = await connection.execute(sql`SELECT status FROM sync_sweep_promises WHERE id=${envelope.promiseId}::uuid`);
      expect(promise.status).toBe("active");
      expect(await connection.execute(sql`SELECT point_content_signature FROM progressive_remote_diagnostic_receipts
        WHERE sim_job_id=${executionId}::uuid AND point_content_signature<>${source.contentSignature}`)).toHaveLength(0);
      if (physical) {
        expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
        const [finished] = await connection.execute(sql`SELECT status,"ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`);
        expect(finished.status).toBe("done");
        expect(finished.ingestedAt).not.toBeNull();
        expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(1);
      } else if (variant !== "history-without-manifest") {
        await verifyDiagnosticWorkerDrain(connection, envelope, report);
        expect(await connection.execute(sql`SELECT evidence.result_attempt_id FROM progressive_cfd_evidence evidence
          JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token
          WHERE attempt.sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        if (variant === "infrastructure") await verifyLegacyFailedAttemptAck(connection, executionId);
        expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
      }
      throw restore;
    })).rejects.toBe(restore);
  }
}
