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
import { acknowledgeProgressiveWorkerReport, enqueueProgressiveWorkerReport } from "../src/progressive-worker-reports";
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
import { resolveEngineRuntimeBuild } from "../../../apps/api/src/engine-provenance";

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

async function retainStoppedArchive(db: DB, delivery: ProgressiveRemoteEvidenceDelivery, resultAttemptId: string) {
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

async function verifyDiagnosticOnlyRemoteSettlement(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  for (const failureKind of ["infrastructure", "hard_solver"] as const) {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      const restore = new Error(`Restore diagnostic-only settlement ${failureKind}/${state}`);
      await expect(db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        const executionId = envelope.scope.executionId;
        const result = progressiveRemoteEvidenceResult(envelope);
        const polar = result.polars[0];
        const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
          WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
        polar.reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
        polar.attempts = [{ ...polar.attempts![0], cl: null, cd: null, cm: null,
          evidence_artifacts: [], failure_disposition: failureKind, error: "Retained terminal diagnostic only" }];
        result.state = state;
        const report: ProgressiveRemoteReport = {
          version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId,
          assignmentSignature: envelope.contentSignature, sequence: 1,
          status: { job_id: executionId, state, total_cases: envelope.scope.units.length, completed_cases: 1 }, result,
          stopProof: { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
            namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
            fence: "terminal_result", ownership_basis: "recorded_execution_namespace" },
        };
        await storeProgressiveRemoteReport(connection, {
          executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report,
        });
        await applyProgressiveRemoteProgress(connection, executionId);
        await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp()
          WHERE sim_job_id=${executionId}::uuid`);
        await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
          WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
        const owners = await connection.execute(sql`SELECT token,outcome FROM progressive_cfd_attempts
          WHERE sim_job_id=${executionId}::uuid ORDER BY token`);
        await connection.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
        expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({ kind: "retained", sources: [] });
        const source = progressiveReportedPointSources(result)[0];
        expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled", counts: { complete: 0 } });
        const [job] = await connection.execute(sql`SELECT status,"ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`);
        expect(job.status).toBe(state === "completed" ? "done" : state);
        expect(job.ingestedAt).not.toBeNull();
        expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        expect(await connection.execute(sql`SELECT result_attempt_id FROM progressive_remote_evidence_receipts
          WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        const receipts = await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
          WHERE sim_job_id=${executionId}::uuid`);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ point_content_signature: source.contentSignature,
          receipt: { kind: "retained-progressive-diagnostic", failureKind, executionId } });
        expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
        expect(await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
          WHERE sim_job_id=${executionId}::uuid`)).toEqual(receipts);
        expect(await connection.execute(sql`SELECT token,outcome FROM progressive_cfd_attempts
          WHERE sim_job_id=${executionId}::uuid ORDER BY token`)).toEqual(owners);
        const [stored] = await connection.execute(sql`SELECT report,content_signature FROM progressive_remote_reports
          WHERE sim_job_id=${executionId}::uuid AND sequence=1`);
        expect(stored).toMatchObject({ report, content_signature: analysisContentHash(report) });
        throw restore;
      })).rejects.toBe(restore);
    }
  }
}

async function verifyMissingRemotePromotionTrigger(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  const restore = new Error("Restore remote promotion trigger custody");
  await expect(db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const executionId = envelope.scope.executionId;
    const result = progressiveRemoteEvidenceResult(envelope);
    result.mesh_recovery_version = 3;
    const polar = result.polars[0];
    const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
      WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
    polar.reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
    const angles = [...envelope.request.aoa!.angles].sort((a, b) => a - b);
    expect(angles).toContain(0);
    expect(angles).toContain(1);
    const accepted = { ...polar.attempts![0], aoa_deg: 0, case_slug: "promotion-accepted-sibling",
      converged: true, stalled: false, cm: 0, error: null };
    delete accepted.failure_disposition;
    const trigger = { ...accepted, aoa_deg: 1, case_slug: "promotion-missing-trigger",
      cl: null, cd: null, cm: null, converged: false, evidence_artifacts: [],
      failure_disposition: "hard_solver" as const, error: "Exact reported RANS trigger without physical custody" };
    polar.points = [accepted];
    polar.attempts = [accepted, trigger];
    polar.rans_precalc_promotion = { trigger_aoa_deg: 1, failure_disposition: "hard_solver",
      attempted_aoas: [0, 1], intentionally_omitted_aoas: angles.filter((angle) => angle !== 0 && angle !== 1) };
    const early: ProgressiveRemoteReport = {
      version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId,
      assignmentSignature: envelope.contentSignature, sequence: 1,
      status: { job_id: executionId, state: "running", total_cases: angles.length, completed_cases: 2 },
      result, stopProof: null,
    };
    const final = structuredClone(early);
    final.sequence = 2;
    final.status.state = "completed";
    final.result!.state = "completed";
    final.result!.polars[0].attempts = [];
    delete final.result!.polars[0].rans_precalc_promotion;
    final.stopProof = { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
      namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
      fence: "terminal_result", ownership_basis: "recorded_execution_namespace" };
    for (const report of [early, final]) {
      await storeProgressiveRemoteReport(connection, {
        executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report,
      });
      expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({ kind: "applied", sequence: report.sequence });
    }
    const token = "isolated-promotion-custody-credential";
    const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN('polars','sweeps')`);
    await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
      WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id},
      request_payload=coalesce(request_payload,'{}'::jsonb)||${JSON.stringify({ solverId: envelope.solverId, executionContract: "progressive-cfd-v1" })}::jsonb
      WHERE id=${envelope.promiseId}::uuid`);
    const sources = progressiveReportedPointSources(result);
    const siblingSource = sources.find((source) => source.point.aoa_deg === 0)!;
    const triggerSource = sources.find((source) => source.point.aoa_deg === 1)!;
    const delivery = {
      solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
      aoaDeg: accepted.aoa_deg, engineCaseSlug: accepted.case_slug,
      remoteResultId: randomUUID(), remoteResultAttemptId: randomUUID(),
      progressiveEvidence: { sequence: early.sequence, reportContentSignature: analysisContentHash(early),
        pointContentSignature: siblingSource.contentSignature },
    };
    await withProgressiveSyncApi(connection, async (app) => {
      const response = await app.inject({ method: "POST", url: "/api/sync/v1/polars",
        headers: { "x-xfoilfoam-solver-token": token },
        payload: { promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
          results: [{ ...delivery, fieldExtents: [], evidenceArtifacts: [], media: [] }] } });
      expect(response.statusCode, response.body).toBe(200);
      const receipt = response.json().progressiveEvidenceReceipts[0];
      expect(receipt.storageOnly).toBe(false);
      await retainStoppedArchive(connection, delivery, String(receipt.resultAttemptId));
    });
    expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({
      kind: "retained", sources: [{ archived: true, storageOnly: false }],
    });
    const before = await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.state,unit.lease_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY attempt.token`);
    const receipts = await connection.execute(sql`SELECT * FROM progressive_remote_evidence_receipts
      WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`);
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "waiting", reason: "promotion_trigger" });
      const [job] = await connection.execute(sql`SELECT "ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`);
      expect(job.ingestedAt).toBeNull();
      expect(await connection.execute(sql`SELECT id FROM progressive_cfd_recovery_plans WHERE parent_job_id=${executionId}::uuid`)).toHaveLength(0);
      expect(await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.state,unit.lease_token
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY attempt.token`)).toEqual(before);
      expect(await connection.execute(sql`SELECT * FROM progressive_remote_evidence_receipts
        WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`)).toEqual(receipts);
      const diagnostics = await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
        WHERE sim_job_id=${executionId}::uuid`);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ point_content_signature: triggerSource.contentSignature,
        receipt: { kind: "retained-progressive-diagnostic", failureKind: "hard_solver" } });
      const [published] = await connection.execute(sql`SELECT raw.aoa_deg,raw.valid_for_polar,classification.state
        FROM results result JOIN result_attempts raw ON raw.id=result.current_result_attempt_id
        JOIN result_classifications classification ON classification.result_attempt_id=raw.id
        WHERE raw.sim_job_id=${executionId}::uuid`);
      expect(published).toMatchObject({ aoa_deg: 0, valid_for_polar: true, state: "accepted" });
      expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(1);
    }
    const [original] = await connection.execute(sql`SELECT report,content_signature FROM progressive_remote_reports
      WHERE sim_job_id=${executionId}::uuid AND sequence=${early.sequence}`);
    expect(original).toMatchObject({ report: early, content_signature: analysisContentHash(early) });
    throw restore;
  })).rejects.toBe(restore);
}

export async function verifyPriorRawStoppedProgressiveSettlement(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  await verifyMissingRemotePromotionTrigger(db, envelope);
  const restore = new Error("Restore final progress with prior raw failures");
  await db.transaction(async (transaction) => {
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
      fidelity: "urans_full" as const,
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
      assignmentSignature: envelope.contentSignature, sequence: 1,
      status: { job_id: executionId, state: "failed", total_cases: 7, completed_cases: 2 }, result, stopProof: null,
    };
    await storeProgressiveRemoteReport(connection, {
      executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report: early,
    });
    expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({ kind: "applied", sequence: early.sequence });
    const token = "isolated-prior-raw-credential";
    const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN('polars','sweeps')`);
    await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
      WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id},
      request_payload=coalesce(request_payload,'{}'::jsonb)||${JSON.stringify({ solverId: envelope.solverId, executionContract: "progressive-cfd-v1" })}::jsonb
      WHERE id=${envelope.promiseId}::uuid`);
    const sources = progressiveReportedPointSources(result);
    await withProgressiveSyncApi(connection, async (app) => {
      for (const source of sources.slice(0, 2)) {
        const delivery = {
          solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
          aoaDeg: source.point.aoa_deg, engineCaseSlug: source.point.case_slug!,
          remoteResultId: randomUUID(), remoteResultAttemptId: randomUUID(),
          progressiveEvidence: { sequence: early.sequence, reportContentSignature: analysisContentHash(early), pointContentSignature: source.contentSignature },
        };
        const resolved = await resolveProgressiveRemoteEvidence(connection, delivery);
        expect(resolved).not.toBeNull();
        const response = await app.inject({ method: "POST", url: "/api/sync/v1/polars",
          headers: { "x-xfoilfoam-solver-token": token },
          payload: { promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
            results: [{ ...delivery, fieldExtents: [], evidenceArtifacts: [], media: [] }] } });
        expect(response.statusCode, response.body).toBe(200);
        const receipt = response.json().progressiveEvidenceReceipts[0];
        expect(receipt.storageOnly).toBe(false);
        if (source === sources[0]) await retainStoppedArchive(connection, delivery, String(receipt.resultAttemptId));
      }
    });
    const before = await connection.execute(sql`SELECT point_content_signature,result_attempt_id,storage_only
      FROM progressive_remote_evidence_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`);
    expect(before).toHaveLength(2);
    const final = structuredClone(early);
    final.sequence = early.sequence + 1;
    final.result!.state = "failed";
    final.stopProof = { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
      namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
      fence: "terminal_result", ownership_basis: "recorded_execution_namespace" };
    await withProgressiveSyncApi(connection, async (app) => {
      const response = await app.inject({ method: "POST", url: `/api/sync/v1/progressive-executions/${executionId}/reports`,
        headers: { "x-xfoilfoam-solver-token": token }, payload: { promiseId: envelope.promiseId, report: final } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ received: true, receipt: { sequence: final.sequence, contentSignature: analysisContentHash(final) } });
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
    expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({ kind: "applied", sequence: final.sequence, stopped: true });
    expect(await connection.execute(sql`SELECT sequence::integer AS sequence FROM progressive_remote_progress_receipts
      WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`)).toEqual([{ sequence: early.sequence }, { sequence: final.sequence }]);
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
      WHERE sim_job_id=${executionId}::uuid AND sequence=${early.sequence}`);
    expect(original.content_signature).toBe(analysisContentHash(early));
    throw restore;
  }).catch((error) => {
    if (error !== restore) throw error;
  });
}

export async function verifyStoppedFailedProgressiveDelivery(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  await verifyDiagnosticOnlyRemoteSettlement(db, envelope);
  for (const variant of ["physical", "running-leased", "running-blocked", "divergent", "nonphysical", "startup", "infrastructure", "hard_solver", "history-without-manifest"] as const) {
    const restore = new Error(`Restore stopped failed delivery ${variant}`);
    await db.transaction(async (transaction) => {
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
      const selectedToken = envelope.scope.units[0].token;
      const running = variant === "running-leased" || variant === "running-blocked";
      await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp()
        WHERE sim_job_id=${executionId}::uuid AND (${!running} OR token<>${selectedToken}::uuid)`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
        WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid
          AND (${!running} OR token<>${selectedToken}::uuid))`);
      if (variant === "running-blocked")
        await connection.execute(sql`UPDATE progressive_cfd_units SET state='blocked',lease_token=NULL,lease_owner=NULL,lease_until=NULL
          WHERE id=(SELECT unit_id FROM progressive_cfd_attempts WHERE token=${selectedToken}::uuid)`);
      const before = await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token,unit.lease_owner,unit.lease_until
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.id`);
      if (running) {
        expect(before.find((unit) => unit.token === selectedToken)).toMatchObject({ outcome: "running",
          state: variant === "running-leased" ? "leased" : "blocked",
          lease_token: variant === "running-leased" ? selectedToken : null });
        expect(before.filter((unit) => unit.token !== selectedToken).every((unit) => unit.outcome === "failed" && unit.state === "gap")).toBe(true);
      }
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
      await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id},
        request_payload=coalesce(request_payload,'{}'::jsonb)||${JSON.stringify({ solverId: envelope.solverId, executionContract: "progressive-cfd-v1" })}::jsonb
        WHERE id=${envelope.promiseId}::uuid`);
      await withProgressiveSyncApi(connection, async (app) => {
        const headers = { "x-xfoilfoam-solver-token": token };
        const payload = {
          promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
          results: [{ ...delivery, progressiveEvidence: reference,
            fieldExtents: [], evidenceArtifacts: [], media: [] }],
        };
        const strict = await app.inject({ method: "POST", url: "/api/sync/v1/polars", headers, payload });
        expect(strict.statusCode, strict.body).toBe(409);
        if (physical) {
          if (variant === "physical" || running) {
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
              sql`UPDATE progressive_cfd_units SET lease_token=${randomUUID()}::uuid
                WHERE id=${original.unit_id}::uuid`,
              sql`UPDATE progressive_cfd_units SET lease_owner='foreign-owner'
                WHERE id=${original.unit_id}::uuid`,
            ];
            for (const [guardIndex, mutation] of guards.entries()) {
              const rollback = new Error("Restore stopped failure refusal");
              await connection.transaction(async (nested) => {
                await nested.execute(mutation);
                const rejected = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
                if (![409, 503].includes(rejected.statusCode))
                  throw new Error(`Stopped failure guard ${guardIndex} returned ${rejected.statusCode}: ${rejected.body}`);
                expect([409, 503], rejected.body).toContain(rejected.statusCode);
                throw rollback;
              }).catch((error) => {
                if (error !== rollback) throw error;
              });
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
          expect(observation.eligible).toBe(variant === "physical" || running);
          if (variant !== "physical" && !running) expect(observation.exclusion_reason).toBe(
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
          await retainStoppedArchive(connection, delivery, String(receipt.resultAttemptId));
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
      expect(await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token,unit.lease_owner,unit.lease_until
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
    }).catch((error) => {
      if (error !== restore) throw error;
    });
  }
  await verifyLegacyClosedProgressiveStorage(db, envelope);
}

async function verifyLegacyClosedProgressiveStorage(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  for (const variant of ["failed", "untyped-failed", "accepted"] as const) {
    const accepted = variant === "accepted";
    const restore = new Error(`Restore legacy closed storage ${variant}`);
    await expect(db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const executionId = envelope.scope.executionId;
      const result = progressiveRemoteEvidenceResult(envelope);
      result.state = "completed";
      result.mesh_recovery_version = 3;
      const [job] = await connection.execute(sql`SELECT job.airfoil_id,job.bc_ids,job.simulation_preset_revision_id,revision.snapshot
        FROM sim_jobs job JOIN simulation_preset_revisions revision ON revision.id=job.simulation_preset_revision_id
        WHERE job.id=${executionId}::uuid`);
      result.polars[0].reynolds = Number((job.snapshot as { derived: { reynolds: number } }).derived.reynolds);
      const point = result.polars[0].attempts![0];
      point.cl = accepted ? 0.4 : null;
      point.cd = accepted ? 0.03 : null;
      point.cm = accepted ? 0 : null;
      point.converged = accepted;
      point.error = accepted ? null : "Retained physical failure from cancelled assignment";
      if (accepted || variant === "untyped-failed") delete point.failure_disposition;
      const report: ProgressiveRemoteReport = {
        version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId,
        assignmentSignature: envelope.contentSignature, sequence: 1,
        status: { job_id: executionId, state: "completed", total_cases: envelope.scope.units.length, completed_cases: 1 },
        result, stopProof: { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
          namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
          fence: "terminal_result", ownership_basis: "recorded_execution_namespace" },
      };
      await storeProgressiveRemoteReport(connection, {
        executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report,
      });
      await applyProgressiveRemoteProgress(connection, executionId);
      await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='cancelled',finished_at=clock_timestamp()
        WHERE sim_job_id=${executionId}::uuid`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
        WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
      const newerToken = randomUUID();
      await connection.execute(sql`INSERT INTO progressive_cfd_attempts
        (token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
        SELECT ${newerToken}::uuid,attempt.unit_id,'newer-sibling-owner',attempt.execution_recipe_id,
          attempt.started_at+interval '1 second',clock_timestamp()+interval '1 hour','running'
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg<>${point.aoa_deg} ORDER BY unit.ordinal LIMIT 1`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET state='leased',lease_token=${newerToken}::uuid,
        lease_owner='newer-sibling-owner',lease_until=clock_timestamp()+interval '1 hour'
        WHERE id=(SELECT unit_id FROM progressive_cfd_attempts WHERE token=${newerToken}::uuid)`);
      const ownership = sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token,unit.lease_owner,unit.lease_until
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE unit.id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid) ORDER BY unit.id,attempt.token`;
      const before = await connection.execute(ownership);
      expect(before.some((unit) => unit.token === newerToken && unit.outcome === "running")).toBe(true);
      const source = progressiveReportedPointSources(result)[0];
      const projection = progressiveRemotePointProjection({ ...source, envelope, report });
      expect(projection.status).toBe(accepted ? "done" : "failed");
      if (variant === "untyped-failed") expect(projection.evidencePayload.failure_disposition ?? null).toBeNull();
      const [cell] = await connection.execute(sql`SELECT id,status,current_result_attempt_id FROM results
        WHERE airfoil_id=${job.airfoil_id}::uuid AND simulation_preset_revision_id=${job.simulation_preset_revision_id}::uuid
          AND aoa_deg=${point.aoa_deg}`);
      const token = "isolated-legacy-storage-credential";
      const baseUrl = "https://isolated-legacy-storage.invalid/api/sync/v1";
      const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
      await connection.execute(sql`UPDATE sync_api_settings SET enabled=true,remote_solver_transfer_paused=false,
        instance_id=${solver.instance_id},remote_solver_registered_id=${envelope.solverId}::uuid,
        remote_solver_auth_token=${token},upstream_base_url=${baseUrl} WHERE id=1`);
      await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN('polars','sweeps')`);
      await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
        WHERE id=${envelope.solverId}::uuid`);
      await connection.execute(sql`UPDATE sync_sweep_promises SET status='cancelled',source_base_url=${baseUrl},
        source_instance_id=${solver.instance_id},
        request_payload=coalesce(request_payload,'{}'::jsonb)||${JSON.stringify({ solverId: envelope.solverId, executionContract: "progressive-cfd-v1" })}::jsonb
        WHERE id=${envelope.promiseId}::uuid`);
      await connection.execute(sql`UPDATE sim_jobs SET status='cancelled',ingest_lease_token=NULL,ingest_lease_expires_at=NULL,
        request_payload=request_payload||${JSON.stringify({ remoteSolver: true, syncPromiseId: envelope.promiseId,
          upstreamBaseUrl: baseUrl, remoteProgressiveExecution: envelope })}::jsonb WHERE id=${executionId}::uuid`);
      await connection.execute(sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
        VALUES(${executionId}::uuid,${randomUUID()}::uuid,${envelope.contentSignature},${JSON.stringify({
          kind: "authorized", executionId, contentSignature: envelope.contentSignature,
        })}::jsonb)`);
      const queued = await enqueueProgressiveWorkerReport(connection, { executionId, solverId: envelope.solverId,
        promiseId: envelope.promiseId, assignmentSignature: envelope.contentSignature,
        status: report.status, result, stopProof: report.stopProof });
      expect(queued.contentSignature).toBe(analysisContentHash(report));
      await acknowledgeProgressiveWorkerReport(connection, { executionId, solverId: envelope.solverId,
        sequence: queued.sequence, contentSignature: queued.contentSignature });
      await connection.execute(sql`INSERT INTO progressive_worker_evidence_receipts
        (sim_job_id,sequence,content_signature)
        VALUES(${executionId}::uuid,${queued.sequence},${queued.contentSignature})`);
      const runtime = await resolveEngineRuntimeBuild(connection, projection.engine);
      const [raw] = await connection.insert(resultAttempts).values({
        resultId: String(cell.id), airfoilId: String(job.airfoil_id), bcId: (job.bc_ids as string[])[0],
        simulationPresetRevisionId: String(job.simulation_preset_revision_id), simJobId: executionId,
        aoaDeg: projection.aoaDeg, status: projection.status, source: projection.source, regime: projection.regime,
        cl: projection.cl, cd: projection.cd, cm: projection.cm, converged: projection.converged,
        unsteady: projection.unsteady, error: projection.error, engineJobId: executionId,
        engineCaseSlug: projection.engineCaseSlug, evidencePayload: projection.evidencePayload,
        methodKey: projection.methodKey, solverImplementationId: runtime?.solverImplementationId ?? null,
        solverRuntimeBuildId: runtime?.solverRuntimeBuildId ?? null,
        qualityWarnings: projection.qualityWarnings, stalled: projection.stalled,
        firstOrderFallback: projection.firstOrderFallback,
        validForPolar: projection.status === "done" && projection.converged && !projection.error && Number(projection.cd ?? 0) > 0,
      }).returning();
      await connection.execute(sql`INSERT INTO progressive_worker_evidence_attempts
        (sim_job_id,sequence,result_attempt_id,point_content_signature)
        VALUES(${executionId}::uuid,${queued.sequence},${raw.id}::uuid,${source.contentSignature})`);
      const delivery = { solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
        aoaDeg: point.aoa_deg, engineCaseSlug: point.case_slug!, remoteResultId: String(cell.id), remoteResultAttemptId: raw.id,
        progressiveEvidence: { sequence: queued.sequence, reportContentSignature: queued.contentSignature,
          pointContentSignature: source.contentSignature } };
      await withProgressiveSyncApi(connection, async (app) => {
        const headers = { "x-xfoilfoam-solver-token": token };
        const payload = { promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
          results: [{ ...delivery, fieldExtents: [], evidenceArtifacts: [], media: [] }] };
        const paths: string[] = [];
        const fetcher: typeof fetch = async (url, options) => {
          const route = new URL(String(url)).pathname;
          paths.push(route);
          const response = await app.inject({ method: "POST", url: route,
            headers: Object.fromEntries(new Headers(options?.headers)), payload: JSON.parse(String(options?.body)) });
          return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
        };
        const rollback = new Error("Restore active promise refusal for cancelled original");
        await expect(connection.transaction(async (nested) => {
          await nested.execute(sql`UPDATE sync_sweep_promises SET status='active' WHERE id=${envelope.promiseId}::uuid`);
          if (variant === "untyped-failed") {
            await nested.execute(sql`UPDATE progressive_cfd_attempts SET outcome='running',finished_at=NULL
              WHERE sim_job_id=${executionId}::uuid AND token=${envelope.scope.units[0].token}::uuid`);
            await nested.execute(sql`UPDATE progressive_cfd_units SET state='blocked'
              WHERE id=(SELECT unit_id FROM progressive_cfd_attempts WHERE token=${envelope.scope.units[0].token}::uuid)`);
          }
          const rejected = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
          expect(rejected.statusCode, rejected.body).toBe(409);
          if (variant === "untyped-failed") {
            await expect(deliverNextProgressiveWorkerEvidence(nested as unknown as DB, fetcher)).rejects.toThrow("409");
            expect(paths).toEqual(["/api/sync/v1/polars"]);
            expect(await nested.execute(sql`SELECT receipt FROM progressive_worker_hub_receipts
              WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
          }
          throw rollback;
        })).rejects.toBe(rollback);
        paths.length = 0;
        expect(await deliverNextProgressiveWorkerEvidence(connection, fetcher)).toBe(true);
        expect(paths).toEqual(["/api/sync/v1/polars", "/api/sync/v1/retained-progressive-evidence"]);
        const [stored] = await connection.execute(sql`SELECT receipt FROM progressive_worker_hub_receipts
          WHERE sim_job_id=${executionId}::uuid AND point_content_signature=${source.contentSignature}`);
        expect(stored.receipt).toMatchObject({ kind: "retained-progressive-attempt", storageOnly: true,
          remoteResultAttemptId: raw.id, pointContentSignature: source.contentSignature });
        const replay = await app.inject({ method: "POST", url: "/api/sync/v1/retained-progressive-evidence", headers, payload });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json().progressiveEvidenceReceipts[0]).toEqual(stored.receipt);
        expect(await connection.select().from(resultAttempts).where(eq(resultAttempts.id, raw.id))).toEqual([raw]);
        expect(await deliverNextProgressiveWorkerEvidence(connection, fetcher)).toBe(false);
        expect(await connection.execute(sql`SELECT evidence.result_attempt_id FROM progressive_cfd_evidence evidence
          JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token
          WHERE attempt.sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        await retainStoppedArchive(connection, delivery, String((stored.receipt as { resultAttemptId: string }).resultAttemptId));
        expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({ kind: "retained",
          sources: [{ archived: true, storageOnly: true }] });
      });
      expect(await connection.execute(ownership)).toEqual(before);
      expect(await connection.execute(sql`SELECT id,status,current_result_attempt_id FROM results WHERE id=${cell.id}::uuid`)).toEqual([cell]);
      expect(await connection.select().from(resultAttempts).where(eq(resultAttempts.id, raw.id))).toEqual([raw]);
      expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid AND valid_for_polar`)).toHaveLength(accepted ? 1 : 0);
      expect(await connection.execute(sql`SELECT classification.result_attempt_id FROM result_classifications classification
        JOIN result_attempts attempt ON attempt.id=classification.result_attempt_id
        WHERE attempt.sim_job_id=${executionId}::uuid AND classification.state='accepted'`)).toHaveLength(0);
      expect(await connection.execute(sql`SELECT result_id,result_attempt_id FROM sync_sweep_promise_points
        WHERE promise_id=${envelope.promiseId}::uuid AND (result_id IS NOT NULL OR result_attempt_id IS NOT NULL)`)).toHaveLength(0);
      expect(await connection.execute(sql`SELECT status FROM sync_sweep_promises WHERE id=${envelope.promiseId}::uuid`)).toEqual([{ status: "cancelled" }]);
      throw restore;
    })).rejects.toBe(restore);
  }
}
