import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import { resultAttempts, solverEvidenceArtifacts, syncBrokeredEvidenceUploads } from "../src/schema";
import { registerVerifiedBrokeredEvidenceArchive } from "../src/brokered-evidence-archive";
import { readProgressiveEvidenceCustodyReceipt } from "../src/progressive-evidence-custody";
import { progressiveArchiveManifestBytes, progressiveArchiveManifestSha256, progressiveArchiveMembers } from "./progressive-archive-data";
import { assertProgressiveCfdEvidenceJob } from "../src/progressive-cfd-evidence";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { progressiveRemoteReportInventory } from "../src/progressive-remote-inventory";
import { progressiveRemotePointProjection } from "../src/progressive-remote-point-projection";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { recordProgressiveRemoteEvidenceReceipt } from "../src/progressive-remote-evidence-receipts";
import {
  readProgressiveRemoteRetention,
  terminalReportNoPhysicalEvidenceSignatures,
} from "../src/progressive-remote-retention";
import {
  retainedSolverReportDownload,
  retainedSolverReports,
} from "../src/retained-solver-reports";
import {
  assertProgressivePolarImportScope,
  prepareProgressivePolarImport,
} from "../../../apps/api/src/progressive-polar-import";
import { applyProgressiveRemoteProgress, reconcileProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { refreshPolarClassificationsForJob } from "../src/polar-cache";
import { settleProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-settlement";
import { progressiveRemoteEvidenceResult } from "./progressive-remote-evidence-fixture";
import { verifyDiagnosticWorkerDrain } from "./progressive-diagnostic-worker-drain-fixture";
import { recordProgressiveRemoteDiagnosticReceipt } from "../src/progressive-remote-diagnostic-receipts";

export async function verifyMixedProgressiveRemoteDelivery(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  for (const sibling of ["material", "physical", "infrastructure", "hard_solver", "history", "omitted", "same-angle"] as const)
    await exerciseMixedProgressiveRemoteDelivery(db, envelope, sibling);
  await verifySettledRemoteMaterialDiagnostics(db, envelope);
}

async function verifySettledRemoteMaterialDiagnostics(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  const restore = new Error("Restore already-settled material diagnostics");
  await expect(db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const executionId = envelope.scope.executionId;
    const result = progressiveRemoteEvidenceResult(envelope);
    const [physicalSetup] = await connection.execute(sql`SELECT revision.snapshot#>>'{derived,reynolds}' AS reynolds
      FROM sim_jobs job JOIN simulation_preset_revisions revision ON revision.id=job.simulation_preset_revision_id
      WHERE job.id=${executionId}::uuid`);
    result.polars[0].reynolds = Number(physicalSetup.reynolds);
    const point = result.polars[0].attempts![0];
    result.state = "failed";
    result.polars[0].attempts = envelope.scope.units.map((unit) => ({
      ...point, aoa_deg: unit.alpha, case_slug: `isolated-settled-material-${unit.alpha}`,
      cl: null, cd: null, cm: null, evidence_artifacts: [],
      failure_disposition: "material_domain", error: "MaterialDomainError: retained terminal diagnostic",
    }));
    const report: ProgressiveRemoteReport = {
      version: 1, solverId: envelope.solverId, promiseId: envelope.promiseId,
      executionId, assignmentSignature: envelope.contentSignature, sequence: 1,
      status: { job_id: executionId, state: "failed", total_cases: 2, completed_cases: 2 },
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
    await connection.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
    await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp()
      WHERE sim_job_id=${executionId}::uuid`);
    await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
    const before = await connection.execute(sql`SELECT token,outcome FROM progressive_cfd_attempts
      WHERE sim_job_id=${executionId}::uuid ORDER BY token`);
    for (const previous of ["failed", "cancelled"] as const) {
      const rollback = new Error("Restore terminal diagnostic settlement");
      await expect(connection.transaction(async (nested) => {
        const scoped = nested as unknown as DB;
        await scoped.execute(sql`UPDATE sim_jobs SET status='ingesting',
          ingest_lease_previous_status=${previous}::sim_job_status,ingest_lease_token='expired-material-owner',
          ingest_lease_expires_at=clock_timestamp()-interval '1 minute' WHERE id=${executionId}::uuid`);
        expect(await settleProgressiveRemoteJob(scoped, executionId)).toMatchObject({ kind: "settled" });
        const [job] = await scoped.execute(sql`SELECT status,"ingestedAt",ingest_lease_token,ingest_lease_previous_status
          FROM sim_jobs WHERE id=${executionId}::uuid`);
        expect(job.status).toBe(previous);
        expect(job.ingestedAt).not.toBeNull();
        expect(job.ingest_lease_token).toBeNull();
        expect(job.ingest_lease_previous_status).toBeNull();
        expect(await scoped.execute(sql`SELECT point_content_signature FROM progressive_remote_diagnostic_receipts
          WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(envelope.scope.units.length);
        expect(await scoped.execute(sql`SELECT token,outcome FROM progressive_cfd_attempts
          WHERE sim_job_id=${executionId}::uuid ORDER BY token`)).toEqual(before);
        expect(await scoped.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
        const [stored] = await scoped.execute(sql`SELECT report,content_signature FROM progressive_remote_reports
          WHERE sim_job_id=${executionId}::uuid AND sequence=1`);
        expect(stored.report).toEqual(report);
        expect(stored.content_signature).toBe(analysisContentHash(report));
        expect(await settleProgressiveRemoteJob(scoped, executionId)).toMatchObject({ kind: "settled" });
        throw rollback;
      })).rejects.toBe(rollback);
    }
    await verifyDiagnosticWorkerDrain(connection,envelope,report);
    throw restore;
  })).rejects.toBe(restore);
}

async function exerciseMixedProgressiveRemoteDelivery(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  sibling: "material" | "physical" | "infrastructure" | "hard_solver" | "history" | "omitted" | "same-angle",
) {
  const rollback = new Error("Restore isolated mixed remote delivery");
  await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const executionId = envelope.scope.executionId;
    expect(envelope.scope.units).toHaveLength(2);
    const result = progressiveRemoteEvidenceResult(envelope);
    const [physicalSetup] = await connection.execute(sql`SELECT revision.snapshot#>>'{derived,reynolds}' AS reynolds
      FROM sim_jobs job JOIN simulation_preset_revisions revision ON revision.id=job.simulation_preset_revision_id
      WHERE job.id=${executionId}::uuid`);
    result.polars[0].reynolds = Number(physicalSetup.reynolds);
    const polar = result.polars[0];
    const physical = {
      ...polar.attempts![0], converged: true, stalled: false, error: null, cm: 0,
    };
    delete physical.failure_disposition;
    const diagnostic = {
      ...physical,
      aoa_deg: sibling === "same-angle" ? physical.aoa_deg : envelope.scope.units[1].alpha,
      case_slug: "isolated-material-domain-diagnostic",
      cl: sibling === "physical" ? 0.1 : null,
      cd: null,
      cm: null,
      converged: false,
      failure_disposition: sibling === "infrastructure" || sibling === "history" ? "infrastructure" as const
        : sibling === "hard_solver" ? "hard_solver" as const : "material_domain" as const,
      error: "MaterialDomainError: isolated native temperature clamp",
      evidence_artifacts: [],
      ...(sibling === "history" ? { force_history: { t: [0, 1], cl: [0.1, 0.2], cd: [0.01, 0.02], cm: [0, 0] } } : {}),
    };
    polar.points = [physical];
    polar.attempts = sibling === "omitted" ? [] : [diagnostic];
    result.state = "completed";
    const report: ProgressiveRemoteReport = {
      version: 1,
      solverId: envelope.solverId,
      promiseId: envelope.promiseId,
      executionId,
      assignmentSignature: envelope.contentSignature,
      sequence: 1,
      status: {
        job_id: executionId,
        state: "completed",
        total_cases: 2,
        completed_cases: sibling === "omitted" ? 1 : 2,
      },
      result,
      stopProof: {
        version: 1,
        job_id: executionId,
        execution_stopped: true,
        producer_stopped: true,
        namespace_verified: true,
        remaining: [],
        observed_at: new Date().toISOString(),
        error: null,
        fence: "terminal_result",
        ownership_basis: "recorded_execution_namespace",
      },
    };
    const completedWithDiagnostic = structuredClone(report);
    const historyReport = structuredClone(report);
    historyReport.status.state = "running";
    historyReport.result!.state = "running";
    historyReport.stopProof = null;
    await storeProgressiveRemoteReport(connection, {
      executionId,
      solverId: envelope.solverId,
      promiseId: envelope.promiseId,
      report: historyReport,
    });
    report.sequence = 2;
    report.result!.polars[0].attempts = [];
    await storeProgressiveRemoteReport(connection, {
      executionId,
      solverId: envelope.solverId,
      promiseId: envelope.promiseId,
      report,
    });
    for (const sequence of [1, 2])
      expect(await applyProgressiveRemoteProgress(connection, executionId)).toMatchObject({
        kind: "applied", sequence, stopped: sequence === 2,
      });
    if (sibling !== "same-angle") await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp()
      WHERE sim_job_id=${executionId}::uuid AND unit_id IN (
        SELECT id FROM progressive_cfd_units WHERE aoa_deg=${diagnostic.aoa_deg})`);
    if (sibling !== "same-angle") await connection.execute(sql`UPDATE progressive_cfd_units SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL
      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)
        AND aoa_deg=${diagnostic.aoa_deg}`);
    const before = await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.aoa_deg`);
    const inventory = progressiveRemoteReportInventory(historyReport);
    if (sibling === "omitted") {
      expect(inventory.sources).toHaveLength(1);
      await expect(assertProgressiveCfdEvidenceJob(connection, executionId, executionId, [{
        alpha: physical.aoa_deg, speed: polar.speed, chord: polar.chord, solverActiveSeconds: physical.solver_active_seconds,
      }])).rejects.toThrow("Obsolete or settled progressive CFD execution scope");
      expect(await connection.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
      throw rollback;
    }
    const source = inventory.sources.find((entry) => entry.case_slug === physical.case_slug)!;
    const diagnosticSource = inventory.sources.find((entry) => entry.case_slug === diagnostic.case_slug)!;
    expect([...terminalReportNoPhysicalEvidenceSignatures(completedWithDiagnostic)]).toEqual(
      sibling !== "physical" && sibling !== "history" ? [diagnosticSource.point_content_signature] : [],
    );
    if (sibling === "material") for (const changed of [
      { ...diagnostic, cl: 0.1 },
      { ...diagnostic, evidence_artifacts: physical.evidence_artifacts },
      { ...diagnostic, failure_disposition: "deterministic_mesh" as const },
      { ...diagnostic, converged: true },
      { ...diagnostic, force_history: { t: [0, 1], cl: [0.1, 0.2], cd: [0.01, 0.02], cm: [0, 0] } },
      { ...diagnostic, images: { pressure: "/retained-pressure.png" } },
    ]) {
      const altered = structuredClone(completedWithDiagnostic);
      altered.result!.polars[0].attempts![0] = changed;
      expect(terminalReportNoPhysicalEvidenceSignatures(altered).size).toBe(0);
    }
    expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({
      kind: "waiting", reason: "raw_evidence", sourceCount: 2,
      pendingCount: sibling !== "physical" && sibling !== "history" ? 1 : 2,
    });
    const delivery = {
      solverId: envelope.solverId,
      promiseId: envelope.promiseId,
      engineJobId: executionId,
      aoaDeg: physical.aoa_deg,
      engineCaseSlug: physical.case_slug!,
      remoteResultId: randomUUID(),
      remoteResultAttemptId: randomUUID(),
      progressiveEvidence: {
        sequence: 1,
        reportContentSignature: inventory.reportContentSignature,
        pointContentSignature: source.point_content_signature,
      },
    };
    const payload = {
      promiseId: envelope.promiseId,
      results: [{ ...delivery }],
    };
    const prepared = await prepareProgressivePolarImport(connection, payload, envelope.solverId);
    if (sibling === "same-angle") {
      expect([...await assertProgressivePolarImportScope(connection,prepared)]).toEqual([physical.aoa_deg]);
      const receipt = await recordProgressiveRemoteDiagnosticReceipt(connection, {
        solverId: envelope.solverId,promiseId: envelope.promiseId,engineJobId: executionId,
        aoaDeg: diagnostic.aoa_deg,engineCaseSlug: diagnostic.case_slug,
        progressiveEvidence: { sequence: 1,reportContentSignature: inventory.reportContentSignature,
          pointContentSignature: diagnosticSource.point_content_signature },
      });
      expect(receipt).toMatchObject({ kind: "retained-progressive-diagnostic",pointContentSignature: diagnosticSource.point_content_signature });
      expect(await readProgressiveRemoteRetention(connection,executionId)).toMatchObject({
        kind: "waiting",reason: "raw_evidence",pendingCount: 1,
      });
      throw rollback;
    }
    if (sibling === "physical" || sibling === "history") {
      await expect(assertProgressivePolarImportScope(connection, prepared)).rejects.toThrow();
      expect(await connection.execute(sql`SELECT result_attempt_id FROM progressive_remote_evidence_receipts
        WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
      throw rollback;
    }
    expect([...await assertProgressivePolarImportScope(connection, prepared)]).toEqual([physical.aoa_deg]);
    await expect(assertProgressiveCfdEvidenceJob(connection, executionId, executionId)).rejects.toThrow(
      "Obsolete or settled progressive CFD execution scope",
    );
    const physicalCase = {
      alpha: physical.aoa_deg,
      speed: polar.speed,
      chord: polar.chord,
      solverActiveSeconds: physical.solver_active_seconds,
    };
    await expect(assertProgressiveCfdEvidenceJob(connection, executionId, executionId, [
      { ...physicalCase, alpha: diagnostic.aoa_deg },
    ])).rejects.toThrow();
    await expect(assertProgressiveCfdEvidenceJob(connection, executionId, executionId, [
      { ...physicalCase, speed: polar.speed + 1 },
    ])).rejects.toThrow("exact physical scope");
    for (const mutation of [
      sql`UPDATE progressive_cfd_units SET lease_token=${randomUUID()}::uuid
        WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)
          AND aoa_deg=${physical.aoa_deg}`,
      sql`UPDATE sim_campaigns SET status='cancelled'
        WHERE id=(SELECT campaign_id FROM sim_jobs WHERE id=${executionId}::uuid)`,
      sql`UPDATE progressive_generations SET status='cancelled'
        WHERE id=${envelope.scope.generationId}::uuid`,
      sql`INSERT INTO progressive_cfd_attempts
        (token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
        SELECT ${randomUUID()}::uuid,attempt.unit_id,'isolated newer owner',attempt.execution_recipe_id,
          attempt.started_at+interval '1 second',clock_timestamp(),'failed'
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${physical.aoa_deg}`,
      sql`DELETE FROM progressive_remote_report_inventories
        WHERE sim_job_id=${executionId}::uuid AND sequence=1`,
      sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{progressive,tokens}',${JSON.stringify([randomUUID(), randomUUID()])}::jsonb)
        WHERE id=${executionId}::uuid`,
      sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`,
      sql`INSERT INTO progressive_cfd_attempts
        (token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
        SELECT ${randomUUID()}::uuid,attempt.unit_id,'newer diagnostic owner',attempt.execution_recipe_id,
          attempt.started_at+interval '1 second',clock_timestamp(),'failed'
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${diagnostic.aoa_deg}`,
      ...(sibling === "material" ? [] : [sql`UPDATE progressive_cfd_units SET lease_owner='foreign diagnostic owner'
        WHERE id IN(SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)
          AND aoa_deg=${diagnostic.aoa_deg}`]),
    ]) {
      const restore = new Error("Restore rejected mixed delivery owner");
      await connection.transaction(async (nested) => {
        const scoped = nested as unknown as DB;
        await scoped.execute(mutation);
        await expect(assertProgressiveCfdEvidenceJob(scoped, executionId, executionId, [physicalCase])).rejects.toThrow();
        throw restore;
      }).catch((error) => { if (error !== restore) throw error; });
    }
    const entry = prepared.get(physical.aoa_deg)!;
    const projection = progressiveRemotePointProjection(entry.source);
    const [job] = await connection.execute(sql`SELECT airfoil_id,bc_ids,simulation_preset_revision_id,campaign_id
      FROM sim_jobs WHERE id=${executionId}::uuid`);
    const [cell] = await connection.execute(sql`SELECT id FROM results
      WHERE airfoil_id=${job.airfoil_id}::uuid AND simulation_preset_revision_id=${job.simulation_preset_revision_id}::uuid
        AND aoa_deg=${physical.aoa_deg}`);
    const values: typeof resultAttempts.$inferInsert = {
      resultId: String(cell.id),
      airfoilId: String(job.airfoil_id),
      bcId: (job.bc_ids as string[])[0],
      simulationPresetRevisionId: String(job.simulation_preset_revision_id),
      simJobId: executionId,
      aoaDeg: projection.aoaDeg,
      status: projection.status,
      source: projection.source,
      regime: projection.regime,
      cl: projection.cl,
      cd: projection.cd,
      cm: projection.cm,
      clCd: projection.clCd,
      clStd: projection.clStd,
      cdStd: projection.cdStd,
      cmStd: projection.cmStd,
      stalled: projection.stalled,
      unsteady: projection.unsteady,
      converged: projection.converged,
      finalResidual: projection.finalResidual,
      iterations: projection.iterations,
      yPlusAvg: projection.yPlusAvg,
      yPlusMax: projection.yPlusMax,
      nCells: projection.nCells,
      firstOrderFallback: projection.firstOrderFallback,
      strouhal: projection.strouhal,
      error: projection.error,
      qualityWarnings: projection.qualityWarnings,
      methodKey: projection.methodKey,
      engineJobId: projection.engineJobId,
      engineCaseSlug: projection.engineCaseSlug,
      evidencePayload: projection.evidencePayload,
      validForPolar: true,
    };
    for (const changed of [
      { cl: 99, validForPolar: false },
      { status: "failed" as const, source: "queued" as const, converged: false, validForPolar: false },
    ]) {
      const [changedRaw] = await connection.insert(resultAttempts).values({ ...values, ...changed }).returning();
      await expect(recordProgressiveRemoteEvidenceReceipt(connection, {
        ...delivery, resultAttemptId: changedRaw.id,
      })).rejects.toThrow("reported source values");
      await connection.delete(resultAttempts).where(eq(resultAttempts.id,changedRaw.id));
    }
    const [raw] = await connection.insert(resultAttempts).values(values).returning();
    if (!raw.resultId) throw new Error("Mixed delivery requires its exact stored result");
    const receipt = await recordProgressiveRemoteEvidenceReceipt(connection, { ...delivery, resultAttemptId: raw.id });
    expect(receipt).toMatchObject({
      executionId, resultAttemptId: raw.id, pointContentSignature: source.point_content_signature,
    });
    expect(await recordProgressiveRemoteEvidenceReceipt(connection, { ...delivery, resultAttemptId: raw.id })).toEqual(receipt);
    expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({
      kind: "waiting", reason: "archives", sourceCount: 2, pendingCount: 1,
    });
    const [association] = await connection.execute(sql`SELECT evidence.evidence_signature,attempt.sim_job_id,unit.aoa_deg
      FROM progressive_cfd_evidence evidence JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token
      JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id WHERE evidence.result_attempt_id=${raw.id}::uuid`);
    expect(association).toEqual({
      evidence_signature: analysisContentHash(raw.evidencePayload), sim_job_id: executionId, aoa_deg: physical.aoa_deg,
    });
    const history = await retainedSolverReports(connection, { campaignId: String(job.campaign_id), includeDelivered: true });
    const retained = history.items.find((item) => item.executionId === executionId && item.sequence === 1)!;
    expect(retained).toBeDefined();
    const downloaded = await retainedSolverReportDownload(connection, retained);
    expect(JSON.parse(downloaded.content).result.polars[0].attempts[0]).toEqual(diagnostic);
    expect(analysisContentHash(JSON.parse(downloaded.content))).toBe(inventory.reportContentSignature);
    expect(await connection.execute(sql`SELECT attempt.token,attempt.outcome,unit.id,unit.state,unit.lease_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.aoa_deg`)).toEqual(before);
    expect(await connection.execute(sql`SELECT id FROM result_attempts
      WHERE sim_job_id=${executionId}::uuid AND aoa_deg=${diagnostic.aoa_deg}`)).toHaveLength(0);
    const [promise] = await connection.execute(sql`SELECT status FROM sync_sweep_promises WHERE id=${envelope.promiseId}::uuid`);
    expect(promise.status).toBe("active");
    expect(await settleProgressiveRemoteJob(connection, executionId)).toMatchObject({ kind: "waiting", reason: "archives" });
    const uploadId = randomUUID();
    const [solver] = await connection.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
    const [promised] = await connection.execute(sql`SELECT id FROM sync_sweep_promise_points
      WHERE promise_id=${envelope.promiseId}::uuid AND aoa_deg=${physical.aoa_deg}`);
    const identity = {
      bucket: "isolated-mixed-terminal-custody",
      objectKey: `solver-evidence/v1/sha256/cc/${"c".repeat(64)}.tar.zst`,
      generation: "9007199254740993123", crc32c: "ImIEBA==",
      storedSha256: "c".repeat(64), storedByteSize: 500,
      tarSha256: "d".repeat(64), tarByteSize: 1500,
      manifestSha256: progressiveArchiveManifestSha256,
      manifestByteSize: progressiveArchiveManifestBytes.byteLength,
      zstdLevel: 3, bundledFileCount: 1, verifiedAt: new Date(),
    };
    await connection.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${solver.instance_id},
      request_payload=coalesce(request_payload,'{}'::jsonb)||${JSON.stringify({ solverId: envelope.solverId })}::jsonb
      WHERE id=${envelope.promiseId}::uuid`);
    await connection.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update("isolated-mixed-terminal-credential").digest("hex")}
      WHERE id=${envelope.solverId}::uuid`);
    await connection.insert(syncBrokeredEvidenceUploads).values({
      ...identity, id: uploadId, idempotencyKey: randomUUID(), state: "verified",
      promiseId: envelope.promiseId, promisePointId: String(promised.id), solverId: envelope.solverId,
      sourceInstanceId: String(solver.instance_id), remoteResultId: delivery.remoteResultId,
      remoteResultAttemptId: delivery.remoteResultAttemptId, aoaDeg: physical.aoa_deg,
      engineJobId: executionId, engineCaseSlug: physical.case_slug,
    });
    const owner = {
      resultId: raw.resultId, resultAttemptId: raw.id, airfoilId: raw.airfoilId,
      simJobId: raw.simJobId, engineJobId: raw.engineJobId, engineCaseSlug: raw.engineCaseSlug,
      methodKey: raw.methodKey, solverImplementationId: raw.solverImplementationId,
      solverRuntimeBuildId: raw.solverRuntimeBuildId, aoaDeg: raw.aoaDeg,
    };
    const [bundle] = await connection.insert(solverEvidenceArtifacts).values({
      ...owner, kind: "engine_bundle", storageKey: identity.objectKey,
      mimeType: "application/zstd", sha256: identity.storedSha256, byteSize: identity.storedByteSize,
      metadata: { remoteEvidenceUploadId: uploadId, storageBackend: "gcs", ...identity },
    }).returning();
    const [manifest] = await connection.insert(solverEvidenceArtifacts).values({
      ...owner, kind: "manifest", storageKey: `${identity.objectKey}.manifest`,
      mimeType: "application/json", sha256: identity.manifestSha256, byteSize: identity.manifestByteSize,
    }).returning();
    await connection.update(syncBrokeredEvidenceUploads).set({
      state: "bound", boundAt: new Date(), canonicalResultId: raw.resultId,
      canonicalResultAttemptId: raw.id, canonicalArtifactId: bundle.id,
    }).where(eq(syncBrokeredEvidenceUploads.id, uploadId));
    await registerVerifiedBrokeredEvidenceArchive(connection, {
      resultId: raw.resultId, resultAttemptId: raw.id, sourceArtifactId: bundle.id,
      manifestArtifactId: manifest.id, evidenceBase: "isolated-case", identity,
      memberSet: progressiveArchiveMembers,
    });
    await readProgressiveEvidenceCustodyReceipt(connection, delivery, uploadId);
    expect(await readProgressiveRemoteRetention(connection, executionId)).toMatchObject({
      kind: "retained", sources: [{ resultAttemptId: raw.id, archived: true, storageOnly: false }],
    });
    await refreshPolarClassificationsForJob(connection, String(job.airfoil_id), String(job.simulation_preset_revision_id), executionId);
    const [beforePublication] = await connection.execute(sql`SELECT result.current_result_attempt_id,classification.state
      FROM result_attempts attempt JOIN results result ON result.id=attempt.result_id
      JOIN result_classifications classification ON classification.result_attempt_id=attempt.id WHERE attempt.id=${raw.id}::uuid`);
    expect(beforePublication).toMatchObject({ current_result_attempt_id: null, state: "accepted" });
    if (sibling === "infrastructure") for (const verdict of ["exclude", "defer"] as const) {
      const restore = new Error(`Restore ${verdict} review publication guard`);
      await connection.transaction(async (nested) => {
        const scoped = nested as unknown as DB;
        await scoped.execute(sql`INSERT INTO result_review_verdicts(result_id,verdict,reviewer)
          VALUES(${raw.resultId}::uuid,${verdict},'isolated mixed diagnostic review')`);
        const reviewed = await reconcileProgressiveRemoteProgress(scoped, { jobIds: [executionId] });
        expect(reviewed.errors).toEqual([]);
        const [protectedResult] = await scoped.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${raw.resultId}::uuid`);
        expect(protectedResult.current_result_attempt_id).toBeNull();
        const [retainedRaw] = await scoped.execute(sql`SELECT evidence_payload FROM result_attempts WHERE id=${raw.id}::uuid`);
        expect(analysisContentHash(retainedRaw.evidence_payload)).toBe(analysisContentHash(raw.evidencePayload));
        throw restore;
      }).catch((error) => { if (error !== restore) throw error; });
    }
    expect(await reconcileProgressiveRemoteProgress(connection, { jobIds: [executionId] })).toMatchObject({
      settled: 1, waiting: 0, errors: [],
    });
    const [finished] = await connection.execute(sql`SELECT status,"ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`);
    expect(finished.status).toBe("done");
    expect(finished.ingestedAt).not.toBeNull();
    const [published] = await connection.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${raw.resultId}::uuid`);
    expect(published.current_result_attempt_id).toBe(raw.id);
    const [diagnosticState] = await connection.execute(sql`SELECT attempt.outcome,unit.state,unit.lease_token
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${diagnostic.aoa_deg}`);
    expect(diagnosticState).toMatchObject({ outcome: "failed", state: "gap", lease_token: null });
    const [accepted] = await connection.execute(sql`SELECT count(*)::integer AS count FROM result_attempts
      WHERE sim_job_id=${executionId}::uuid AND aoa_deg=${diagnostic.aoa_deg} AND valid_for_polar`);
    expect(accepted.count).toBe(0);
    throw rollback;
  }).catch((error) => { if (error !== rollback) throw error; });
}
