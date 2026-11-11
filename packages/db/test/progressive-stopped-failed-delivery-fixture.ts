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
import { issueProgressiveRemoteDiagnosticReceipts, recordProgressiveRemoteDiagnosticReceipt } from "../src/progressive-remote-diagnostic-receipts";
import { readProgressiveDiagnosticRecoveryTrigger } from "../src/progressive-cfd-evidence";
import { settleProgressiveCfdExecution } from "../src/progressive-cfd-settlement";
import { recordProgressiveCfdRecoveryPlans, type ProgressiveRansPromotion } from "../src/progressive-cfd-numerical-recovery";
import { claimProgressiveCfdBatch } from "../src/progressive-cfd";
import { acknowledgeProgressiveWorkerReport, enqueueProgressiveWorkerReport } from "../src/progressive-worker-reports";
import { resultAttempts, resultMedia, solverEvidenceArtifacts, syncBrokeredEvidenceUploads } from "../src/schema";
import { refreshPolarClassificationsForJob } from "../src/polar-cache";
import { readStoppedAcceptedProgressivePublication } from "../src/progressive-stopped-publication";
import { registerRoutes } from "../../../apps/api/src/routes";
import { registerVerifiedBrokeredEvidenceArchive } from "../src/brokered-evidence-archive";
import { readProgressiveEvidenceCustodyReceipt } from "../src/progressive-evidence-custody";
import type { ProgressiveRemoteEvidenceDelivery } from "../src/progressive-remote-evidence-receipts";
import { progressiveRemoteEvidenceResult } from "./progressive-remote-evidence-fixture";
import { progressiveArchiveManifestBytes, progressiveArchiveManifestSha256, progressiveArchiveMembers } from "./progressive-archive-data";
import { verifyDiagnosticWorkerDrain } from "./progressive-diagnostic-worker-drain-fixture";
import { withProgressiveSyncApi } from "../../../apps/api/test/progressive-polar-import-fixture";
import { applyProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { settleProgressiveRemoteJob, promoteRetainedProgressiveAttempts } from "../../../apps/sweeper/src/progressive-remote-settlement";
import { buildProgressiveFitRequest } from "../../../apps/sweeper/src/progressive-fitting";
import { deliverNextProgressiveWorkerEvidence } from "../../../apps/sweeper/src/progressive-worker-evidence-delivery";
import { resolveEngineRuntimeBuild } from "../../../apps/api/src/engine-provenance";

// Roll back fixture writes without replacing the original API/guard/assertion
// failure with a second assertion about the rollback sentinel.
async function withRollbackFixture(db: DB, label: string, run: (connection: DB) => Promise<void>) {
  const rollback = new Error(label);
  try {
    await db.transaction(async (transaction) => {
      await run(transaction as unknown as DB);
      throw rollback;
    });
  } catch (error) {
    if (error === rollback) return;
    throw error;
  }
  throw new Error(`Fixture did not roll back: ${label}`);
}

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
  for (const failureKind of ["material_domain", "infrastructure", "hard_solver"] as const) {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      for (const retired of failureKind === "infrastructure" && state === "completed"
        ? ["current", "gap", "leased"] as const : ["current"] as const) {
      const restore = new Error(`Restore diagnostic-only settlement ${failureKind}/${state}`);
      try {
        await db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        const executionId = envelope.scope.executionId;
        const result = progressiveRemoteEvidenceResult(envelope);
        const polar = result.polars[0];
        const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
          WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
        polar.reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
        const template = polar.attempts![0];
        polar.attempts = envelope.scope.units.map((unit) => ({
          ...template, aoa_deg: unit.alpha, case_slug: `diagnostic-${unit.alpha}`,
          cl: null, cd: null, cm: null, evidence_artifacts: [],
          failure_disposition: failureKind, error: "Retained terminal diagnostic only",
        }));
        result.state = state;
        const report: ProgressiveRemoteReport = {
          version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId,
          assignmentSignature: envelope.contentSignature, sequence: 1,
          status: { job_id: executionId, state, total_cases: envelope.scope.units.length,
            completed_cases: polar.attempts.length }, result,
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
        if (retired !== "current") {
          for (const unit of envelope.scope.units) {
            const successor = randomUUID();
            await connection.execute(sql`INSERT INTO progressive_cfd_attempts
              (token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome,finished_at)
              SELECT ${successor}::uuid,unit_id,'successor diagnostic fixture',execution_recipe_id,
                started_at+interval '1 second',clock_timestamp()+interval '1 hour',
                ${retired === "leased" ? "running" : "failed"},
                ${retired === "leased" ? null : new Date().toISOString()}::timestamptz
              FROM progressive_cfd_attempts WHERE token=${unit.token}::uuid`);
            if (retired === "leased") await connection.execute(sql`UPDATE progressive_cfd_units
              SET state='leased',lease_token=${successor}::uuid,lease_owner='successor diagnostic fixture',
                lease_until=clock_timestamp()+interval '1 hour' WHERE id=${unit.unitId}::uuid`);
          }
        }
        const owners = await connection.execute(sql`SELECT * FROM progressive_cfd_attempts
          WHERE sim_job_id=${executionId}::uuid ORDER BY token`);
        await connection.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
        if (retired !== "current") {
          const source = progressiveReportedPointSources(result)[0];
          const delivery = { solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
            aoaDeg: source.point.aoa_deg, engineCaseSlug: source.point.case_slug ?? null,
            progressiveEvidence: { sequence: report.sequence, reportContentSignature: analysisContentHash(report),
              pointContentSignature: source.contentSignature } };
          for (const changed of [
            { ...delivery, solverId: randomUUID() },
            { ...delivery, promiseId: randomUUID() },
            { ...delivery, engineCaseSlug: 'foreign-case' },
            { ...delivery, progressiveEvidence: { ...delivery.progressiveEvidence, reportContentSignature: "0".repeat(64) } },
            { ...delivery, progressiveEvidence: { ...delivery.progressiveEvidence, pointContentSignature: "0".repeat(64) } },
          ]) await expect(recordProgressiveRemoteDiagnosticReceipt(connection, changed)).rejects.toThrow();
          for (const mutation of [
            sql`UPDATE calculation_epochs SET current=false WHERE id=${envelope.scope.epochId}::uuid`,
            sql`UPDATE progressive_cfd_attempts SET finished_at=NULL WHERE sim_job_id=${executionId}::uuid`,
            sql`UPDATE progressive_cfd_attempts SET outcome='cancelled',finished_at=NULL WHERE sim_job_id=${executionId}::uuid`,
            sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`,
            sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{progressive,recipeId}', '"foreign-recipe"'::jsonb)
              WHERE id=${executionId}::uuid`,
          ]) await withRollbackFixture(connection, "Restore retired diagnostic refusal", async (scoped) => {
            await scoped.execute(mutation);
            await expect(recordProgressiveRemoteDiagnosticReceipt(scoped, delivery)).rejects.toThrow();
            expect(await scoped.execute(sql`SELECT receipt FROM progressive_remote_diagnostic_receipts
              WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
          });
        }
        const unitOwners = await connection.execute(sql`SELECT * FROM progressive_cfd_units
          WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid) ORDER BY id`);
        const successorOwners = await connection.execute(sql`SELECT * FROM progressive_cfd_attempts
          WHERE sim_job_id IS NULL AND unit_id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)
          ORDER BY token`);
        const diagnosticRetention = await readProgressiveRemoteRetention(connection, executionId);
        expect(diagnosticRetention).toMatchObject({ kind: "retained", sources: [] });
        const diagnosticSettlement = await settleProgressiveRemoteJob(connection, executionId);
        expect(diagnosticSettlement).toMatchObject({ kind: "settled", counts: { complete: 0 } });
        const [job] = await connection.execute(sql`SELECT status,"ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`);
        expect(job.status).toBe(state === "completed" ? "done" : state);
        expect(job.ingestedAt).not.toBeNull();
        expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        expect(await connection.execute(sql`SELECT result_attempt_id FROM progressive_remote_evidence_receipts
          WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        const receipts = await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
          WHERE sim_job_id=${executionId}::uuid`);
        expect(receipts).toHaveLength(polar.attempts.length);
        if (retired !== "current") {
          const source = progressiveReportedPointSources(result)[0];
          await expect(readProgressiveDiagnosticRecoveryTrigger(connection, executionId, {
            sequence: report.sequence, reportContentSignature: analysisContentHash(report),
            pointContentSignature: source.contentSignature,
          })).rejects.toThrow("Numerical recovery changed its exact diagnostic receipt or stop proof");
        }
        for (const source of progressiveReportedPointSources(result)) {
          const receipt = receipts.find((entry) => entry.point_content_signature === source.contentSignature);
          expect(receipt).toMatchObject({ point_content_signature: source.contentSignature,
            receipt: { kind: "retained-progressive-diagnostic", executionId,
              ...(retired !== "current" ? { version: 3, failureKind, custody: "terminal_history",
                attemptToken: envelope.scope.units.find((unit) => unit.alpha === source.point.aoa_deg)!.token }
                : failureKind === "material_domain" ? { version: 1 } : { version: 2, failureKind }) } });
        }
        expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
        expect(await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
          WHERE sim_job_id=${executionId}::uuid`)).toEqual(receipts);
        expect(await connection.execute(sql`SELECT * FROM progressive_cfd_attempts
          WHERE sim_job_id=${executionId}::uuid ORDER BY token`)).toEqual(owners);
        if (retired !== "current") {
          expect(await connection.execute(sql`SELECT * FROM progressive_cfd_units
            WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid) ORDER BY id`)).toEqual(unitOwners);
          expect(await connection.execute(sql`SELECT * FROM progressive_cfd_attempts
            WHERE sim_job_id IS NULL AND unit_id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)
            ORDER BY token`)).toEqual(successorOwners);
          expect(await connection.execute(sql`SELECT id FROM progressive_cfd_recovery_plans
            WHERE parent_job_id=${executionId}::uuid`)).toHaveLength(0);
          if (retired === "leased") await verifyDiagnosticWorkerDrain(connection, envelope, report);
        }
        const [stored] = await connection.execute(sql`SELECT report,content_signature FROM progressive_remote_reports
          WHERE sim_job_id=${executionId}::uuid AND sequence=1`);
        expect(stored).toMatchObject({ report, content_signature: analysisContentHash(report) });
        throw restore;
        });
        throw new Error("Diagnostic-only settlement fixture did not reach its rollback sentinel");
      } catch (error) {
        if (error !== restore) throw error;
      }
      }
    }
  }
}

export async function verifyDiagnosticMixedPromotionRecovery(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  const restore = new Error("Restore remote promotion trigger custody");
  try {
    await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const executionId = envelope.scope.executionId;
    const result = progressiveRemoteEvidenceResult(envelope);
    result.mesh_recovery_version = 3;
    const polar = result.polars[0];
    const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
      WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
    polar.reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
    const angles = [...(envelope.request.aoa?.angles ?? [])].sort((a, b) => a - b);
    expect(envelope.scope.stage).toBe(2);
    expect(envelope.request.solver?.rans_failure_policy).toBe("abort_for_precalc");
    expect(angles).toContain(0);
    expect(angles).toContain(1);
    const accepted = { ...polar.attempts![0], aoa_deg: 0, case_slug: "promotion-accepted-sibling",
      converged: true, stalled: false, cm: 0, error: null, fidelity: "rans" as const };
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
    const promotionRetention = await readProgressiveRemoteRetention(connection, executionId);
    expect(promotionRetention).toMatchObject({
      kind: "retained", sources: [{ archived: true, storageOnly: false }],
    });
    const before = await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.state,unit.lease_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY attempt.token`);
    const receipts = await connection.execute(sql`SELECT * FROM progressive_remote_evidence_receipts
      WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`);
    const diagnostics = await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
      WHERE sim_job_id=${executionId}::uuid`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ point_content_signature: triggerSource.contentSignature,
      receipt: { kind: "retained-progressive-diagnostic", failureKind: "hard_solver" } });
    const diagnostic = await readProgressiveDiagnosticRecoveryTrigger(connection, executionId, {
      sequence: early.sequence, reportContentSignature: analysisContentHash(early), pointContentSignature: triggerSource.contentSignature,
    });
    expect(diagnostic).not.toBeNull();
    const promotion: ProgressiveRansPromotion = {
      revisionId: diagnostic!.revisionId, triggerDiagnosticReceipt: diagnostic!.reference, triggerAoaDeg: 1,
      attemptedAoas: [0, 1], intentionallyOmittedAoas: polar.rans_precalc_promotion!.intentionally_omitted_aoas,
    };
    const rejects = async (mutate: (scoped: DB) => Promise<unknown>, candidate: ProgressiveRansPromotion = promotion) => {
      await withRollbackFixture(connection, "Restore diagnostic recovery rejection probe", async (nested) => {
        const scoped = nested as unknown as DB;
        await mutate(scoped);
        await expect(recordProgressiveCfdRecoveryPlans(scoped, executionId, [candidate])).rejects.toThrow();
        expect(await scoped.execute(sql`SELECT id FROM progressive_cfd_recovery_plans WHERE parent_job_id=${executionId}::uuid`)).toHaveLength(0);
      });
    };
    // Shadow immutable rows only inside rollback probes. Production immutability
    // stays enforced; these probes exercise authentic retained-source validation.
    const shadow = async (scoped: DB, table: string) => {
      await scoped.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} ON COMMIT DROP AS SELECT * FROM public.${sql.identifier(table)}`);
    };
    for (const changed of [false, true]) {
      await rejects(async (scoped) => {
        await shadow(scoped, "progressive_remote_diagnostic_receipts");
        if (changed) await scoped.execute(sql`UPDATE progressive_remote_diagnostic_receipts
          SET receipt=jsonb_set(receipt,'{receivedAt}','"changed"'::jsonb) WHERE sim_job_id=${executionId}::uuid`);
        else await scoped.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
      });
      await rejects(async (scoped) => {
        await shadow(scoped, "progressive_remote_reports");
        if (changed) await scoped.execute(sql`UPDATE progressive_remote_reports
          SET report=jsonb_set(report,'{status,message}','"changed report bytes"'::jsonb)
          WHERE sim_job_id=${executionId}::uuid AND sequence=${early.sequence}`);
        else await scoped.execute(sql`DELETE FROM progressive_remote_reports WHERE sim_job_id=${executionId}::uuid AND sequence=${early.sequence}`);
      });
      await rejects(async (scoped) => {
        await shadow(scoped, "progressive_cfd_execution_stops");
        if (changed) await scoped.execute(sql`UPDATE progressive_cfd_execution_stops SET proof_signature=${"0".repeat(64)} WHERE sim_job_id=${executionId}::uuid`);
        else await scoped.execute(sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`);
      });
    }
    await rejects(async (scoped) => {
      await shadow(scoped, "progressive_cfd_execution_stops");
      const invalid = { ...final.stopProof!, producer_stopped: false };
      await scoped.execute(sql`UPDATE progressive_cfd_execution_stops SET proof=${JSON.stringify(invalid)}::jsonb,
        proof_signature=${analysisContentHash(invalid)} WHERE sim_job_id=${executionId}::uuid`);
    });
    await rejects(async (scoped) => {
      await shadow(scoped, "calculation_epochs");
      await scoped.execute(sql`UPDATE calculation_epochs SET current=false WHERE id=${envelope.scope.epochId}::uuid`);
    });
    await rejects(async (scoped) => {
      await shadow(scoped, "sim_campaigns");
      await scoped.execute(sql`UPDATE sim_campaigns SET current_plan_revision_id=${randomUUID()}::uuid
        WHERE id=(SELECT campaign_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
    });
    await rejects(async (scoped) => {
      await shadow(scoped, "progressive_cfd_units");
      await scoped.execute(sql`UPDATE progressive_cfd_units SET state='leased',lease_token=${randomUUID()}::uuid
        WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
    });
    await rejects(async (scoped) => {
      await shadow(scoped, "progressive_cfd_units");
      await scoped.execute(sql`UPDATE progressive_cfd_units SET lease_owner='another-owner'
        WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
    });
    await rejects(async (scoped) => {
      const [parent] = await scoped.execute(sql`SELECT unit_id,execution_recipe_id,started_at
        FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid ORDER BY token LIMIT 1`);
      await scoped.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
        VALUES(${randomUUID()}::uuid,${parent.unit_id}::uuid,'newer-diagnostic-owner',${parent.execution_recipe_id},
          ${new Date(parent.started_at as string | Date).toISOString()}::timestamptz+interval '1 second',clock_timestamp(),'failed')`);
    });
    await rejects(async (scoped) => {
      await scoped.execute(sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp() WHERE id=${envelope.solverId}::uuid`);
    });
    const untouched = async () => {};
    await rejects(untouched, { ...promotion, triggerDiagnosticReceipt: { ...diagnostic!.reference, pointContentSignature: siblingSource.contentSignature } });
    await rejects(untouched, { ...promotion, triggerDiagnosticReceipt: { ...diagnostic!.reference, receiptSignature: "0".repeat(64) } });
    await rejects(untouched, { ...promotion, triggerDiagnosticReceipt: { ...diagnostic!.reference, historySignature: "0".repeat(64) } });
    await rejects(untouched, { ...promotion, triggerDiagnosticReceipt: { ...diagnostic!.reference, reportContentSignature: "0".repeat(64) } });
    for (const triggerAoaDeg of [-1, 0, 6]) await rejects(untouched, { ...promotion, triggerAoaDeg });
    await rejects(untouched, { ...promotion, attemptedAoas: [0], intentionallyOmittedAoas: angles.filter((alpha) => alpha !== 0) });
    await rejects(untouched, { ...promotion,
      intentionallyOmittedAoas: promotion.intentionallyOmittedAoas.length ? [] : [promotion.triggerAoaDeg] });
    const sibling = String(receipts[0].result_attempt_id);
    await rejects(untouched, { revisionId: promotion.revisionId, triggerResultAttemptId: sibling, triggerAoaDeg: 1,
      attemptedAoas: promotion.attemptedAoas, intentionallyOmittedAoas: promotion.intentionallyOmittedAoas });
    // Runtime inputs must also respect the exclusive TypeScript contract.
    await rejects(untouched, { ...promotion, triggerResultAttemptId: sibling } as unknown as ProgressiveRansPromotion);
    await rejects(async (scoped) => {
      await shadow(scoped, "result_attempts");
      await scoped.execute(sql`UPDATE result_attempts SET evidence_payload=jsonb_set(evidence_payload,'{error}','"changed physical bytes"'::jsonb)
        WHERE id=${sibling}::uuid`);
    });
    await rejects(async (scoped) => {
      await shadow(scoped, "progressive_cfd_evidence");
      await scoped.execute(sql`UPDATE progressive_cfd_evidence SET evidence_signature=${"0".repeat(64)} WHERE result_attempt_id=${sibling}::uuid`);
    });
    await rejects(async (scoped) => {
      await shadow(scoped, "progressive_remote_evidence_receipts");
      await scoped.execute(sql`DELETE FROM progressive_remote_evidence_receipts WHERE result_attempt_id=${sibling}::uuid`);
    });
    expect(await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.state,unit.lease_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY attempt.token`)).toEqual(before);
    expect(await recordProgressiveCfdRecoveryPlans(connection, executionId, [promotion])).toBe(angles.length);
    expect(await recordProgressiveCfdRecoveryPlans(connection, executionId, [promotion])).toBe(0);
    const plans = await connection.execute(sql`SELECT plan.*,unit.aoa_deg,unit.recipe AS original_recipe
      FROM progressive_cfd_recovery_plans plan JOIN progressive_cfd_units unit ON unit.id=plan.unit_id
      WHERE plan.parent_job_id=${executionId}::uuid ORDER BY unit.aoa_deg`);
    expect(plans.map((plan) => plan.aoa_deg)).toEqual(angles);
    for (const plan of plans) {
      expect(plan).toMatchObject({ ordinal: 1, scope: "original_sweep", reason: "hard_solver", diagnostic_attempt_id: null,
        diagnostic_point_content_signature: triggerSource.contentSignature, diagnostic_signature: analysisContentHash(diagnostic!.reference) });
      expect(plan.recipe).toMatchObject({ mesh: (plan.original_recipe as Record<string, unknown>).mesh, uransFidelity: "precalc" });
    }
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
      const [job] = await connection.execute(sql`SELECT "ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`);
      expect(job.ingestedAt).not.toBeNull();
      expect(await connection.execute(sql`SELECT plan.*,unit.aoa_deg,unit.recipe AS original_recipe
        FROM progressive_cfd_recovery_plans plan JOIN progressive_cfd_units unit ON unit.id=plan.unit_id
        WHERE plan.parent_job_id=${executionId}::uuid ORDER BY unit.aoa_deg`)).toEqual(plans);
      expect(await connection.execute(sql`SELECT * FROM progressive_remote_evidence_receipts
        WHERE sim_job_id=${executionId}::uuid ORDER BY point_content_signature`)).toEqual(receipts);
      expect(await connection.execute(sql`SELECT point_content_signature,receipt FROM progressive_remote_diagnostic_receipts
        WHERE sim_job_id=${executionId}::uuid`)).toEqual(diagnostics);
      const [published] = await connection.execute(sql`SELECT raw.aoa_deg,raw.valid_for_polar,classification.state
        FROM results result JOIN result_attempts raw ON raw.id=result.current_result_attempt_id
        JOIN result_classifications classification ON classification.result_attempt_id=raw.id
        WHERE raw.sim_job_id=${executionId}::uuid`);
      expect(published).toMatchObject({ aoa_deg: 0, valid_for_polar: true, state: "accepted" });
      expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(1);
    }
    expect(await connection.execute(sql`SELECT unit.id FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id WHERE attempt.sim_job_id=${executionId}::uuid AND unit.state<>'pending'`)).toHaveLength(0);
    expect(await connection.execute(sql`SELECT id FROM results WHERE sim_job_id=${executionId}::uuid AND aoa_deg<>0
      AND current_result_attempt_id IS NOT NULL`)).toHaveLength(0);
    const retry = await claimProgressiveCfdBatch(connection, {
      owner: "diagnostic-original-sweep-retry", leaseSeconds: 120, maximumUnits: angles.length,
      solverBudgetVersion: 2, remoteSolverId: envelope.solverId,
    });
    expect(retry.map((unit) => unit.alpha).sort((a, b) => a - b)).toEqual(angles);
    expect(retry.every((unit) => unit.recoveryParentJobId === executionId && unit.recoveryPlanId)).toBe(true);
    expect(await connection.execute(sql`SELECT raw.id FROM result_attempts raw WHERE raw.sim_job_id=${executionId}::uuid AND raw.aoa_deg<>0`)).toHaveLength(0);
    const [original] = await connection.execute(sql`SELECT report,content_signature FROM progressive_remote_reports
      WHERE sim_job_id=${executionId}::uuid AND sequence=${early.sequence}`);
    expect(original).toMatchObject({ report: early, content_signature: analysisContentHash(early) });
    throw restore;
    });
    throw new Error("Promotion-custody fixture did not reach its rollback sentinel");
  } catch (error) {
    if (error !== restore) throw error;
  }
}

export async function verifyDiagnosticOnlyPromotionRecovery(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  triggerAoaDeg: number,
  earlyState: "gap" | "pending" | null,
) {
  await withRollbackFixture(db, "Restore all-diagnostic original sweep recovery", async (transaction) => {
    const connection = transaction as unknown as DB;
    const executionId = envelope.scope.executionId;
    const originalUnits = await connection.execute(sql`SELECT unit.id,unit.recipe FROM progressive_cfd_units unit
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id WHERE attempt.sim_job_id=${executionId}::uuid`);
    const angles = [...(envelope.request.aoa?.angles ?? [])].sort((a, b) => a - b);
    expect(envelope.scope.stage).toBe(2);
    expect(envelope.request.solver?.rans_failure_policy).toBe("abort_for_precalc");
    const ordered = angles.includes(0)
      ? [0, ...angles.filter((angle) => angle > 0), ...angles.filter((angle) => angle < 0).reverse()]
      : angles;
    const attempted = ordered.slice(0, ordered.indexOf(triggerAoaDeg) + 1);
    const omitted = angles.filter((angle) => !attempted.includes(angle));
    const result = progressiveRemoteEvidenceResult(envelope);
    result.mesh_recovery_version = 3;
    const [revision] = await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
      WHERE id=(SELECT simulation_preset_revision_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
    const polar = result.polars[0];
    polar.reynolds = Number((revision.snapshot as { derived: { reynolds: number } }).derived.reynolds);
    const base = polar.attempts![0];
    polar.attempts = attempted.map((alpha) => ({ ...base, aoa_deg: alpha, case_slug: `diagnostic-only-${alpha}`,
      fidelity: "rans" as const, cl: null, cd: null, cm: null, evidence_artifacts: [], solver_active_seconds: 7 }));
    polar.points = [];
    polar.rans_precalc_promotion = { trigger_aoa_deg: triggerAoaDeg, failure_disposition: "hard_solver",
      attempted_aoas: attempted, intentionally_omitted_aoas: omitted };
    const partial: ProgressiveRemoteReport = {
      version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId, executionId,
      assignmentSignature: envelope.contentSignature, sequence: 1,
      status: { job_id: executionId, state: "running", completed_cases: 1, total_cases: angles.length },
      result: { ...result, polars: [{ ...polar, attempts: polar.attempts.slice(0, 1), rans_precalc_promotion: undefined }] },
      stopProof: null,
    };
    const promotionReport: ProgressiveRemoteReport = {
      ...partial, sequence: 2,
      status: { ...partial.status, completed_cases: attempted.length },
      result,
      stopProof: null,
    };
    // The latest report deliberately has JSON null for its promotion. Recovery
    // must retain the actual original promotion, not require it in the last row.
    const final = structuredClone(promotionReport);
    final.sequence = 3;
    final.status.state = "completed";
    final.result!.state = "completed";
    final.result!.polars[0].attempts = [];
    final.result!.polars[0].rans_precalc_promotion = null;
    final.stopProof = { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
      namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
      fence: "terminal_result", ownership_basis: "recorded_execution_namespace" };
    const token = "isolated-all-diagnostic-recovery-credential";
    await connection.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN ('polars','sweeps')`);
    await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
      WHERE id=${envelope.solverId}::uuid`);
    await withProgressiveSyncApi(connection, async (app) => {
      for (const report of [partial, promotionReport, final]) {
        const response = await app.inject({ method: "POST", url: `/api/sync/v1/progressive-executions/${executionId}/reports`,
          headers: { "x-xfoilfoam-solver-token": token }, payload: { promiseId: envelope.promiseId, report } });
        expect(response.statusCode, response.body).toBe(200);
        expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({ kind: "applied", sequence: report.sequence });
      }
      // A later report may not replace the terminal result. The promotion must
      // already exist in the running history before the one final stop fence.
      const changed = structuredClone(final);
      changed.sequence += 1;
      changed.result!.polars[0] = structuredClone(promotionReport.result!.polars[0]);
      const refused = await app.inject({ method: "POST", url: `/api/sync/v1/progressive-executions/${executionId}/reports`,
        headers: { "x-xfoilfoam-solver-token": token }, payload: { promiseId: envelope.promiseId, report: changed } });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error).toBe("Final remote execution evidence cannot change after its stop fence");
    });
    const diagnostics = await issueProgressiveRemoteDiagnosticReceipts(connection, executionId);
    expect(diagnostics).toHaveLength(attempted.length);
    // The first attempted diagnostic is anchored to the earlier running report.
    expect(diagnostics.some((receipt) => receipt.sequence === 1)).toBe(true);
    if (earlyState) {
      await connection.execute(sql`UPDATE progressive_cfd_attempts attempt SET outcome='failed',finished_at=clock_timestamp(),
        active_seconds=CASE WHEN unit.aoa_deg IN (${sql.join(attempted.map((alpha) => sql`${alpha}`), sql`, `)}) THEN 7 ELSE 0 END
        FROM progressive_cfd_units unit WHERE unit.id=attempt.unit_id AND attempt.sim_job_id=${executionId}::uuid`);
      await connection.execute(sql`UPDATE progressive_cfd_units unit SET state=${earlyState},
        active_seconds=attempt.active_seconds,lease_token=NULL,lease_owner=NULL,lease_until=NULL
        FROM progressive_cfd_attempts attempt WHERE attempt.unit_id=unit.id AND attempt.sim_job_id=${executionId}::uuid`);
      if (earlyState === "gap") await connection.execute(sql`UPDATE progressive_work SET state='gap'
        WHERE id IN (SELECT unit.work_id FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
          WHERE attempt.sim_job_id=${executionId}::uuid)`);
    }
    const triggerSource = progressiveReportedPointSources(result).find((source) => source.point.aoa_deg === triggerAoaDeg)!;
    const trigger = await readProgressiveDiagnosticRecoveryTrigger(connection, executionId, {
      sequence: promotionReport.sequence, reportContentSignature: analysisContentHash(promotionReport),
      pointContentSignature: triggerSource.contentSignature,
    });
    expect(trigger).not.toBeNull();
    const promotion: ProgressiveRansPromotion = { revisionId: trigger!.revisionId, triggerDiagnosticReceipt: trigger!.reference,
      triggerAoaDeg, attemptedAoas: attempted, intentionallyOmittedAoas: omitted };
    const probe = async (mutate: (scoped: DB) => Promise<unknown>) => {
      await withRollbackFixture(connection, "Restore all-diagnostic source probe", async (nested) => {
        const scoped = nested as unknown as DB;
        await mutate(scoped);
        await expect(recordProgressiveCfdRecoveryPlans(scoped, executionId, [promotion])).rejects.toThrow();
        expect(await scoped.execute(sql`SELECT id FROM progressive_cfd_recovery_plans WHERE parent_job_id=${executionId}::uuid`)).toHaveLength(0);
      });
    };
    await probe(async (scoped) => {
      await scoped.execute(sql`CREATE TEMP TABLE progressive_generation_cohorts ON COMMIT DROP AS SELECT * FROM public.progressive_generation_cohorts`);
      await scoped.execute(sql`UPDATE progressive_generation_cohorts SET stage=3 WHERE generation_id=${envelope.scope.generationId}::uuid`);
      await scoped.execute(sql`CREATE TEMP TABLE progressive_generations ON COMMIT DROP AS SELECT * FROM public.progressive_generations`);
      await scoped.execute(sql`UPDATE progressive_generations SET stage=3 WHERE id=${envelope.scope.generationId}::uuid`);
    });
    if (attempted.length > 1) {
      const earlier = diagnostics.find((receipt) => receipt.pointContentSignature !== triggerSource.contentSignature)!;
      for (const changed of [false, true]) await probe(async (scoped) => {
        await scoped.execute(sql`CREATE TEMP TABLE progressive_remote_diagnostic_receipts ON COMMIT DROP AS
          SELECT * FROM public.progressive_remote_diagnostic_receipts`);
        if (changed) await scoped.execute(sql`UPDATE progressive_remote_diagnostic_receipts SET receipt=jsonb_set(receipt,'{receivedAt}','"changed earlier receipt"'::jsonb)
          WHERE sim_job_id=${executionId}::uuid AND point_content_signature=${earlier.pointContentSignature}`);
        else await scoped.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts
          WHERE sim_job_id=${executionId}::uuid AND point_content_signature=${earlier.pointContentSignature}`);
      });
      await probe(async (scoped) => {
        await scoped.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS SELECT * FROM public.progressive_remote_reports`);
        await scoped.execute(sql`UPDATE progressive_remote_reports SET report=jsonb_set(report,'{status,message}','"changed earlier report"'::jsonb)
          WHERE sim_job_id=${executionId}::uuid AND sequence=1`);
      });
    }
    if (omitted.length) {
      for (const table of ["progressive_cfd_attempts", "progressive_cfd_units"]) await probe(async (scoped) => {
        await scoped.execute(sql`UPDATE ${sql.identifier(table)} SET active_seconds=1
          WHERE ${table === "progressive_cfd_attempts" ? sql`token` : sql`id`}=${table === "progressive_cfd_attempts"
            ? envelope.scope.units.find((unit) => unit.alpha === omitted[0])!.token
            : envelope.scope.units.find((unit) => unit.alpha === omitted[0])!.unitId}::uuid`);
      });
      await probe(async (scoped) => {
        await scoped.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS SELECT * FROM public.result_attempts`);
        await scoped.execute(sql`INSERT INTO result_attempts(id,sim_job_id,aoa_deg) VALUES(${randomUUID()}::uuid,${executionId}::uuid,${omitted[0]})`);
      });
      await probe(async (scoped) => {
        await scoped.execute(sql`CREATE TEMP TABLE progressive_cfd_runtime_progress ON COMMIT DROP AS SELECT * FROM public.progressive_cfd_runtime_progress`);
        await scoped.execute(sql`INSERT INTO progressive_cfd_runtime_progress(attempt_token,active_seconds)
          VALUES(${envelope.scope.units.find((unit) => unit.alpha === omitted[0])!.token}::uuid,1)`);
      });
    }
    expect(await recordProgressiveCfdRecoveryPlans(connection, executionId, [promotion])).toBe(angles.length);
    expect(await recordProgressiveCfdRecoveryPlans(connection, executionId, [promotion])).toBe(0);
    const plans = await connection.execute(sql`SELECT * FROM progressive_cfd_recovery_plans WHERE parent_job_id=${executionId}::uuid ORDER BY unit_id`);
    for (const plan of plans) expect(plan).toMatchObject({ ordinal: 1, scope: "original_sweep", reason: "hard_solver",
      diagnostic_attempt_id: null, diagnostic_point_content_signature: triggerSource.contentSignature,
      diagnostic_signature: analysisContentHash(trigger!.reference) });
    if (earlyState) for (const unit of envelope.scope.units) {
      await withRollbackFixture(connection, "Restore diagnostic settlement lease-owner probe", async (nested) => {
        const scoped = nested as unknown as DB;
        await scoped.execute(sql`UPDATE sim_jobs SET status='done',"ingestedAt"=clock_timestamp() WHERE id=${executionId}::uuid`);
        await scoped.execute(sql`UPDATE progressive_cfd_units SET lease_owner='foreign-diagnostic-recovery-owner'
          WHERE id=${unit.unitId}::uuid`);
        const ownership = sql`SELECT attempt.outcome,unit.state,unit.lease_token,unit.lease_owner,unit.lease_until
          FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
          WHERE attempt.token=${unit.token}::uuid`;
        const before = await scoped.execute(ownership);
        for (let replay = 0; replay < 2; replay += 1) {
          await settleProgressiveCfdExecution(scoped, executionId);
          expect(await scoped.execute(ownership)).toEqual(before);
        }
      });
    }
    if (!omitted.length) {
      await withRollbackFixture(connection, "Restore exhausted diagnostic retry budgets", async (nested) => {
        const scoped = nested as unknown as DB;
        await scoped.execute(sql`UPDATE progressive_cfd_units SET active_seconds=active_budget_seconds
          WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
        await scoped.execute(sql`UPDATE sim_jobs SET status='done',"ingestedAt"=clock_timestamp() WHERE id=${executionId}::uuid`);
        const counts = await settleProgressiveCfdExecution(scoped, executionId);
        expect(counts).toMatchObject({ retry: 0, gaps: angles.length });
      });
    }
    for (let replay = 0; replay < 2; replay += 1) {
      expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled" });
      expect(await connection.execute(sql`SELECT * FROM progressive_cfd_recovery_plans WHERE parent_job_id=${executionId}::uuid ORDER BY unit_id`)).toEqual(plans);
      expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
      expect(await connection.execute(sql`SELECT evidence.result_attempt_id FROM progressive_cfd_evidence evidence
        JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token WHERE attempt.sim_job_id=${executionId}::uuid`)).toHaveLength(0);
      expect(await connection.execute(sql`SELECT id FROM results WHERE sim_job_id=${executionId}::uuid AND current_result_attempt_id IS NOT NULL`)).toHaveLength(0);
      expect(await connection.execute(sql`SELECT unit.id FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
        WHERE attempt.sim_job_id=${executionId}::uuid AND (unit.state<>'pending' OR attempt.outcome<>'failed')`)).toHaveLength(0);
    }
    const retry = await claimProgressiveCfdBatch(connection, { owner: "diagnostic-only-bounded-retry", leaseSeconds: 120,
      maximumUnits: angles.length, solverBudgetVersion: 2, remoteSolverId: envelope.solverId });
    expect(retry.map((unit) => unit.alpha).sort((a, b) => a - b)).toEqual(angles);
    expect(retry.every((unit) => unit.recoveryParentJobId === executionId && unit.recoveryPlanId)).toBe(true);
    for (const unit of retry) {
      const original = envelope.scope.units.find((candidate) => candidate.alpha === unit.alpha)!;
      const [saved] = await connection.execute(sql`SELECT active_seconds FROM progressive_cfd_units WHERE id=${unit.id}::uuid`);
      expect(unit.remainingActiveSeconds).toBe(original.activeBudgetSeconds - Number(saved.active_seconds));
      const originalRecipe = originalUnits.find((candidate) => candidate.id === unit.id)!.recipe as Record<string, unknown>;
      expect(unit.recipe).toMatchObject({ mesh: originalRecipe.mesh, uransFidelity: "precalc" });
    }
    // The retry has a new owner. Replaying the old authenticated request cannot
    // mutate its plan or take the newly claimed units back.
    await expect(recordProgressiveCfdRecoveryPlans(connection, executionId, [promotion])).rejects.toThrow();
  });
}

async function verifyCancelledAcceptedPublication(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  for (const retired of [false, true]) await withRollbackFixture(db, "Restore cancelled accepted publication", async (connection) => {
    const executionId = envelope.scope.executionId;
    expect(envelope.scope.stage).toBe(3);
    const [job] = await connection.execute(sql`SELECT job.airfoil_id,job.simulation_preset_revision_id,job.campaign_id,
      revision.snapshot,airfoil.slug FROM sim_jobs job JOIN simulation_preset_revisions revision ON revision.id=job.simulation_preset_revision_id
      JOIN airfoils airfoil ON airfoil.id=job.airfoil_id WHERE job.id=${executionId}::uuid`);
    const result = progressiveRemoteEvidenceResult(envelope);
    result.mesh_recovery_version = 3;
    const polar = result.polars[0];
    polar.reynolds = Number((job.snapshot as { derived: { reynolds: number } }).derived.reynolds);
    const accepted = { ...polar.attempts![0], aoa_deg: envelope.scope.units[0].alpha, case_slug: "cancelled-accepted",
      converged: true, unsteady: true, stalled: false, cl: 0.4, cd: 0.03, cm: 0, error: null, fidelity: "urans_full" as const,
      force_history: { t: [0, 1, 2, 3], cl: [0.4, 0.4, 0.4, 0.4], cd: [0.03, 0.03, 0.03, 0.03], cm: [0, 0, 0, 0] },
      frame_track: {
        period_s: 1, periods_retained: 5, stationary: true, drift_frac: 0,
        window: { t_start: 0, t_end: 3 },
        stats: {
          cl: { mean: 0.4, std: 0, min: 0.4, max: 0.4 },
          cd: { mean: 0.03, std: 0, min: 0.03, max: 0.03 },
          cm: { mean: 0, std: 0, min: 0, max: 0 },
        },
        fields: ["U"], frames: [{ i: 0, t: 0, cl: 0.4, cd: 0.03, cm: 0 }],
        image_pattern: "frames/{field}/f{i04}.png",
      } };
    delete accepted.failure_disposition;
    const { force_history: _acceptedForceHistory, frame_track: _acceptedFrameTrack, ...acceptedWithoutHistory } = accepted;
    const rejected = { ...acceptedWithoutHistory, aoa_deg: envelope.scope.units[1].alpha, case_slug: "cancelled-rejected",
      converged: false, cl: null, cd: null, cm: null, error: "Retained rejected physical sibling", failure_disposition: "hard_solver" as const };
    const diagnostic = { ...rejected, aoa_deg: envelope.scope.units[2].alpha, case_slug: "cancelled-diagnostic",
      evidence_artifacts: [], failure_disposition: "infrastructure" as const };
    polar.points = [accepted];
    polar.attempts = [accepted, rejected, diagnostic];
    const report: ProgressiveRemoteReport = { version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId,
      executionId, assignmentSignature: envelope.contentSignature, sequence: 1,
      status: { job_id: executionId, state: "running", total_cases: envelope.scope.units.length, completed_cases: 3 }, result, stopProof: null };
    await storeProgressiveRemoteReport(connection, { executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report });
    await applyProgressiveRemoteProgress(connection, executionId);
    const token = "isolated-cancelled-publication";
    const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await connection.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN('polars','sweeps')`);
    await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")}
      WHERE id=${envelope.solverId}::uuid`);
    await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id},
      request_payload=coalesce(request_payload,'{}'::jsonb)||${JSON.stringify({ solverId: envelope.solverId, executionContract: "progressive-cfd-v1" })}::jsonb
      WHERE id=${envelope.promiseId}::uuid`);
    const ids: string[] = [];
    await withProgressiveSyncApi(connection, async (app) => {
      for (const source of progressiveReportedPointSources(result).filter((entry) => entry.point.evidence_artifacts?.length)) {
        const delivery = { solverId: envelope.solverId, promiseId: envelope.promiseId, engineJobId: executionId,
          aoaDeg: source.point.aoa_deg, engineCaseSlug: source.point.case_slug!, remoteResultId: randomUUID(), remoteResultAttemptId: randomUUID(),
          progressiveEvidence: { sequence: 1, reportContentSignature: analysisContentHash(report), pointContentSignature: source.contentSignature } };
        const response = await app.inject({ method: "POST", url: "/api/sync/v1/polars", headers: { "x-xfoilfoam-solver-token": token },
          payload: { promiseId: envelope.promiseId, sourceInstanceId: String(solver.instance_id), fieldColorScales: [],
            results: [{ ...delivery, fieldExtents: [], evidenceArtifacts: [], media: [] }] } });
        expect(response.statusCode, response.body).toBe(200);
        const receipt = response.json().progressiveEvidenceReceipts[0];
        expect(receipt.storageOnly).toBe(false);
        ids.push(String(receipt.resultAttemptId));
        await retainStoppedArchive(connection, delivery, String(receipt.resultAttemptId));
      }
    });
    const [raw] = await connection.select().from(resultAttempts).where(eq(resultAttempts.id, ids[0]));
    await connection.insert(resultMedia).values({ resultId: raw.resultId!, resultAttemptId: raw.id,
      kind: "video", role: "instantaneous", field: "velocity", mimeType: "video/mp4", storageKey: `isolated/${raw.id}.mp4`,
      sha256: "a".repeat(64), byteSize: 1 });
    await refreshPolarClassificationsForJob(connection, String(job.airfoil_id), String(job.simulation_preset_revision_id), executionId);
    expect(await connection.execute(sql`SELECT state FROM result_classifications WHERE result_attempt_id=${raw.id}::uuid`)).toEqual([{ state: "accepted" }]);
    const final = structuredClone(report);
    final.sequence = 2; final.status.state = "completed"; final.result!.state = "completed";
    final.stopProof = { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true,
      namespace_verified: true, remaining: [], observed_at: new Date().toISOString(), error: null,
      fence: "terminal_result", ownership_basis: "recorded_execution_namespace" };
    await storeProgressiveRemoteReport(connection, { executionId, solverId: envelope.solverId, promiseId: envelope.promiseId, report: final });
    await applyProgressiveRemoteProgress(connection, executionId);
    await connection.execute(sql`UPDATE sim_jobs SET status='cancelled',"ingestedAt"=NULL WHERE id=${executionId}::uuid`);
    await connection.execute(sql`UPDATE sync_sweep_promises SET status='expired' WHERE id=${envelope.promiseId}::uuid`);
    await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='cancelled',finished_at=clock_timestamp() WHERE sim_job_id=${executionId}::uuid`);
    await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed' WHERE token=${envelope.scope.units[2].token}::uuid`);
    await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
    if (!retired) await connection.execute(sql`UPDATE progressive_cfd_units SET state='pending' WHERE id=${envelope.scope.units[0].unitId}::uuid`);
    for (const unit of [envelope.scope.units[2], ...(retired ? [envelope.scope.units[0]] : [])])
      await connection.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome,finished_at)
        SELECT ${randomUUID()}::uuid,unit_id,'later terminal owner',execution_recipe_id,started_at+interval '1 second',clock_timestamp(),'cancelled',clock_timestamp()
        FROM progressive_cfd_attempts WHERE token=${unit.token}::uuid`);
    await connection.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
    expect(await issueProgressiveRemoteDiagnosticReceipts(connection, executionId)).toMatchObject([{ version: 3, custody: "terminal_history" }]);
    await connection.execute(sql`UPDATE results SET current_result_attempt_id=NULL,sim_job_id=NULL,status='pending'
      WHERE id IN(SELECT result_id FROM result_attempts WHERE sim_job_id=${executionId}::uuid)`);
    const protectedState = async (scoped: DB) => {
      const state = [];
      for (const table of ["result_attempts", "progressive_remote_reports", "progressive_remote_evidence_receipts", "progressive_remote_diagnostic_receipts", "progressive_cfd_execution_stops", "progressive_cfd_recovery_plans"])
        state.push(await scoped.execute(sql`SELECT to_jsonb(row) AS row FROM ${sql.identifier(table)} row
          WHERE ${sql.identifier(table === "progressive_cfd_recovery_plans" ? "parent_job_id" : "sim_job_id")}=${executionId}::uuid ORDER BY to_jsonb(row)::text`));
      state.push(await scoped.execute(sql`SELECT to_jsonb(unit) AS unit,to_jsonb(attempt) AS attempt FROM progressive_cfd_units unit
        JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id WHERE unit.id IN
        (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid) ORDER BY unit.id,attempt.token`));
      return analysisContentHash(state);
    };
    const before = await protectedState(connection);
    const shadow = async (scoped: DB, table: string) => scoped.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)} ON COMMIT DROP AS SELECT * FROM public.${sql.identifier(table)}`);
    const refusals: Array<[string, (scoped: DB) => Promise<unknown>]> = [
      ["obsolete epoch", (scoped) => scoped.execute(sql`UPDATE calculation_epochs SET current=false WHERE id=${envelope.scope.epochId}::uuid`)],
      ["foreign plan", (scoped) => scoped.execute(sql`UPDATE sim_campaigns SET current_plan_revision_id=NULL WHERE id=${job.campaign_id}::uuid`)],
      ["foreign unit recipe", async (scoped) => { await shadow(scoped, "progressive_cfd_units"); return scoped.execute(sql`UPDATE progressive_cfd_units SET recipe=recipe||'{"foreign":true}'::jsonb WHERE id=${envelope.scope.units[0].unitId}::uuid`); }],
      ["revoked solver", (scoped) => scoped.execute(sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp() WHERE id=${envelope.solverId}::uuid`)],
      ["missing archive", async (scoped) => { await shadow(scoped, "solver_evidence_archives"); return scoped.execute(sql`DELETE FROM solver_evidence_archives WHERE result_attempt_id=${raw.id}::uuid`); }],
      ["review exclude", (scoped) => scoped.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
        VALUES(${raw.resultId}::uuid,'exclude','isolated publication refusal')`)],
      ["review defer", (scoped) => scoped.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
        VALUES(${raw.resultId}::uuid,'defer','isolated publication refusal')`)],
      ["tampered report", async (scoped) => { await shadow(scoped, "progressive_remote_reports"); return scoped.execute(sql`UPDATE progressive_remote_reports
        SET report=jsonb_set(report,'{status,message}','"changed"'::jsonb) WHERE sim_job_id=${executionId}::uuid`); }],
      ["missing stop proof", async (scoped) => { await shadow(scoped, "progressive_cfd_execution_stops"); return scoped.execute(sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`); }],
      ["missing physical receipt", async (scoped) => { await shadow(scoped, "progressive_remote_evidence_receipts"); return scoped.execute(sql`DELETE FROM progressive_remote_evidence_receipts WHERE sim_job_id=${executionId}::uuid AND result_attempt_id=${raw.id}::uuid`); }],
      ["tampered raw coefficients", async (scoped) => { await shadow(scoped, "result_attempts"); return scoped.execute(sql`UPDATE result_attempts SET cl=cl+1 WHERE id=${raw.id}::uuid`); }],
      ["missing manifest", async (scoped) => { await shadow(scoped, "solver_evidence_artifacts"); return scoped.execute(sql`DELETE FROM solver_evidence_artifacts WHERE result_attempt_id=${raw.id}::uuid AND kind='manifest'`); }],
      ["foreign evidence token", async (scoped) => { await shadow(scoped, "progressive_cfd_evidence"); return scoped.execute(sql`UPDATE progressive_cfd_evidence SET attempt_token=${envelope.scope.units[1].token}::uuid WHERE result_attempt_id=${raw.id}::uuid`); }],
      ["live result owner", async (scoped) => {
        const owner = randomUUID();
        await scoped.execute(sql`INSERT INTO sim_jobs(id,engine_job_id,airfoil_id,bc_ids,reference_chord_m,status)
          SELECT ${owner}::uuid,${owner},airfoil_id,bc_ids,reference_chord_m,'running' FROM sim_jobs WHERE id=${executionId}::uuid`);
        return scoped.execute(sql`UPDATE results SET sim_job_id=${owner}::uuid,status='running' WHERE id=${raw.resultId}::uuid`);
      }],
      ["live successor unit", async (scoped) => {
        const newer = randomUUID();
        await shadow(scoped, "progressive_cfd_attempts");
        await shadow(scoped, "progressive_cfd_units");
        await scoped.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
          SELECT ${newer}::uuid,unit_id,'live successor',execution_recipe_id,clock_timestamp(),clock_timestamp()+interval '1 hour','running'
          FROM progressive_cfd_attempts WHERE token=${envelope.scope.units[0].token}::uuid`);
        return scoped.execute(sql`UPDATE progressive_cfd_units SET state='leased',lease_token=${newer}::uuid,
          lease_owner='live successor',lease_until=clock_timestamp()+interval '1 hour' WHERE id=${envelope.scope.units[0].unitId}::uuid`);
      }],
    ];
    for (const [label, mutate] of refusals) await withRollbackFixture(connection, `Restore historical publication refusal: ${label}`, async (scoped) => {
      await mutate(scoped);
      try { await settleProgressiveRemoteJob(scoped, executionId); } catch (error) { expect(error).toBeInstanceOf(Error); }
      expect(await scoped.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${raw.resultId}::uuid`), label).toEqual([{ current_result_attempt_id: null }]);
    });
    await withRollbackFixture(connection, "Protect newer accepted canonical result", async (scoped) => {
      const newer = randomUUID();
      await scoped.insert(resultAttempts).values({ ...raw, id: newer, solvedAt: new Date() });
      await scoped.execute(sql`INSERT INTO result_classifications(result_attempt_id,airfoil_id,simulation_preset_revision_id,aoa_deg,state,region,reasons,confidence,classifier_version)
        SELECT ${newer}::uuid,airfoil_id,simulation_preset_revision_id,aoa_deg,state,region,reasons,confidence,classifier_version
        FROM result_classifications WHERE result_attempt_id=${raw.id}::uuid`);
      await scoped.execute(sql`UPDATE results SET current_result_attempt_id=${newer}::uuid WHERE id=${raw.resultId}::uuid`);
      await settleProgressiveRemoteJob(scoped, executionId);
      expect(await scoped.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${raw.resultId}::uuid`)).toEqual([{ current_result_attempt_id: newer }]);
    });
    for (const change of ["classification", "review"] as const)
      await withRollbackFixture(connection, "Revalidate publication under cache locks", async (scoped) => {
        const publication = await readStoppedAcceptedProgressivePublication(scoped, executionId);
        expect(publication?.attemptIds).toEqual([raw.id]);
        if (change === "classification") await scoped.execute(sql`UPDATE result_classifications SET state='rejected'
          WHERE result_attempt_id=${raw.id}::uuid`);
        else await scoped.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
          VALUES(${raw.resultId}::uuid,'exclude','publication race fixture')`);
        await expect(promoteRetainedProgressiveAttempts(scoped, { ...publication!, stoppedPublication: true })).rejects.toThrow("Stopped accepted publication");
        expect(await scoped.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${raw.resultId}::uuid`)).toEqual([{ current_result_attempt_id: null }]);
      });
    expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled", counts: { complete: 0 } });
    expect(await connection.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${raw.resultId}::uuid`)).toEqual([{ current_result_attempt_id: raw.id }]);
    expect(await connection.execute(sql`SELECT id FROM results WHERE current_result_attempt_id=${ids[1]}::uuid`)).toHaveLength(0);
    const [cache] = await connection.execute(sql`SELECT accepted_point_count,evidence_signature FROM polar_fit_sets
      WHERE airfoil_id=${job.airfoil_id}::uuid AND simulation_preset_revision_id=${job.simulation_preset_revision_id}::uuid`);
    expect(cache).toMatchObject({ accepted_point_count: 1 });
    expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "settled", counts: { complete: 0 } });
    expect(await protectedState(connection)).toBe(before);
    expect(await connection.execute(sql`SELECT accepted_point_count,evidence_signature FROM polar_fit_sets
      WHERE airfoil_id=${job.airfoil_id}::uuid AND simulation_preset_revision_id=${job.simulation_preset_revision_id}::uuid`)).toEqual([cache]);
    await withProgressiveSyncApi(connection, async (app) => {
      await registerRoutes(app);
      const detail = await app.inject({ method: "GET", url: `/api/airfoils/${job.slug}?revisionId=${job.simulation_preset_revision_id}` });
      expect(detail.statusCode, detail.body).toBe(200);
      const points = detail.json().polars.flatMap((entry: { points: Array<{ resultId?: string }> }) => entry.points);
      expect(points.some((point: { resultId?: string }) => point.resultId === raw.resultId)).toBe(true);
      const sim = await app.inject({ method: "GET", url: `/api/airfoils/${job.slug}/sim?resultId=${raw.resultId}&resultAttemptId=${raw.id}` });
      expect(sim.statusCode, sim.body).toBe(200);
      expect(sim.json()).toMatchObject({ resultId: raw.resultId });
    });
  });
}

export async function verifyPriorRawStoppedProgressiveSettlement(db: DB, envelope: ProgressiveRemoteExecutionEnvelope) {
  await verifyCancelledAcceptedPublication(db, envelope);
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
            await withRollbackFixture(connection, "Restore lost stopped-failure ACK after retry", async (nested) => {
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
            });
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
    await withRollbackFixture(db, `Restore legacy closed storage ${variant}`, async (transaction) => {
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
        await withRollbackFixture(connection, "Restore active promise refusal for cancelled original", async (nested) => {
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
        });
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
    });
  }
}
