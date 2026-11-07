import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { resultAttempts } from "../src/schema";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { progressiveReportedPointSources, type ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { progressiveRemotePointProjection } from "../src/progressive-remote-point-projection";
import { recordProgressiveRemoteDiagnosticReceipt } from "../src/progressive-remote-diagnostic-receipts";
import { acknowledgeProgressiveWorkerReport, enqueueProgressiveWorkerReport } from "../src/progressive-worker-reports";
import { solverCpuReservationSql } from "../src/solver-reservations";
import { deliverNextProgressiveWorkerEvidence, recordProgressiveWorkerEvidenceReceipt } from "../../../apps/sweeper/src/progressive-worker-evidence-delivery";
import { nextProgressiveEvidenceWakeAt } from "../../../apps/sweeper/src/progressive-evidence-service";
import { progressiveArchiveSelectionSql } from "../../../apps/sweeper/src/progressive-worker-archive-delivery";
import { replayProgressiveWorkerOutbox } from "../../../apps/sweeper/src/progressive-worker-outbox-replay";
import { withProgressiveSyncApi } from "../../../apps/api/test/progressive-polar-import-fixture";

export async function verifyDiagnosticWorkerDrain(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  report: ProgressiveRemoteReport,
) {
  const executionId = envelope.scope.executionId;
  const baseUrl = "https://isolated-diagnostic-hub.invalid/api/sync/v1";
  const [solver] = await db.execute(sql`SELECT instance_id FROM registered_remote_solvers WHERE id=${envelope.solverId}::uuid`);
  await db.execute(sql`UPDATE sync_api_settings SET remote_solver_registered_id=${envelope.solverId}::uuid,
    instance_id=${solver.instance_id}::uuid,remote_solver_enabled=true,
    remote_solver_auth_token='isolated-diagnostic-credential',upstream_base_url=${baseUrl},
    remote_solver_transfer_paused=false,enabled=true WHERE id=1`);
  await db.execute(sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type='polars'`);
  await db.execute(sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update("isolated-diagnostic-credential").digest("hex")}
    WHERE id=${envelope.solverId}::uuid`);
  await db.execute(sql`UPDATE sync_sweep_promises SET source_base_url=${baseUrl} WHERE id=${envelope.promiseId}::uuid`);
  await db.execute(sql`UPDATE sim_jobs SET status='failed',engine_job_id=id::text,
    ingest_lease_token=NULL,ingest_lease_expires_at=NULL,
    request_payload=request_payload||${JSON.stringify({
      remoteSolver: true, syncPromiseId: envelope.promiseId, upstreamBaseUrl: baseUrl,
      remoteProgressiveExecution: envelope,
    })}::jsonb WHERE id=${executionId}::uuid`);
  await db.execute(sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
    VALUES (${executionId}::uuid,${randomUUID()}::uuid,${envelope.contentSignature},${JSON.stringify({
      kind: "authorized", executionId, contentSignature: envelope.contentSignature,
    })}::jsonb)`);
  const queued = await enqueueProgressiveWorkerReport(db, {
    executionId,solverId: envelope.solverId,promiseId: envelope.promiseId,
    assignmentSignature: envelope.contentSignature,status: report.status,result: report.result,stopProof: report.stopProof,
  });
  await acknowledgeProgressiveWorkerReport(db, { executionId,solverId: envelope.solverId,
    sequence: queued.sequence,contentSignature: queued.contentSignature });
  await db.execute(sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature)
    VALUES (${executionId}::uuid,${queued.sequence},${queued.contentSignature})`);
  const [job] = await db.execute(sql`SELECT airfoil_id,bc_ids,simulation_preset_revision_id
    FROM sim_jobs WHERE id=${executionId}::uuid`);
  const originals = await db.execute(sql`SELECT token,outcome,unit_id,execution_recipe_id,started_at
    FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid ORDER BY token`);
  const references: Array<{
    source: ReturnType<typeof progressiveReportedPointSources>[number];
    attempt: typeof resultAttempts.$inferSelect;
    delivery: Parameters<typeof recordProgressiveRemoteDiagnosticReceipt>[1];
  }> = [];
  for (const source of progressiveReportedPointSources(report.result!)) {
    const projection = progressiveRemotePointProjection({ ...source,envelope,report });
    const [cell] = await db.execute(sql`SELECT id FROM results WHERE airfoil_id=${job.airfoil_id}::uuid
      AND simulation_preset_revision_id=${job.simulation_preset_revision_id}::uuid AND aoa_deg=${source.point.aoa_deg}`);
    expect(await db.execute(sql`UPDATE results SET reynolds=${Math.round(projection.reynolds)},
      speed=${projection.speed},chord=${projection.chord},mach=${projection.mach}
      WHERE id=${cell.id}::uuid AND current_result_attempt_id IS NULL RETURNING id`)).toHaveLength(1);
    const [attempt] = await db.insert(resultAttempts).values({
      resultId: String(cell.id),airfoilId: String(job.airfoil_id),bcId: (job.bc_ids as string[])[0],
      simulationPresetRevisionId: String(job.simulation_preset_revision_id),simJobId: executionId,
      aoaDeg: projection.aoaDeg,status: "failed",source: "queued",regime: projection.regime,
      converged: false,unsteady: projection.unsteady,error: projection.error,
      engineJobId: executionId,engineCaseSlug: projection.engineCaseSlug,
      evidencePayload: projection.evidencePayload,validForPolar: false,
    }).returning();
    await db.execute(sql`INSERT INTO progressive_worker_evidence_attempts
      (sim_job_id,sequence,result_attempt_id,point_content_signature)
      VALUES (${executionId}::uuid,${queued.sequence},${attempt.id}::uuid,${source.contentSignature})`);
    await db.execute(sql`INSERT INTO progressive_worker_delivery_failures
      (sim_job_id,sequence,result_attempt_id,point_content_signature,state,attempt_count,last_http_status,last_error,remote_conflict_ids)
      VALUES (${executionId}::uuid,${queued.sequence},${attempt.id}::uuid,${source.contentSignature},'conflict',2,409,
        'Progressive evidence delivery failed (409): progressive_scope_closed Obsolete or settled progressive CFD execution scope','[]'::jsonb)`);
    references.push({ source,attempt,delivery: {
      solverId: envelope.solverId,promiseId: envelope.promiseId,engineJobId: executionId,
      aoaDeg: source.point.aoa_deg,engineCaseSlug: source.point.case_slug ?? null,
      progressiveEvidence: { sequence: queued.sequence,reportContentSignature: queued.contentSignature,
        pointContentSignature: source.contentSignature },
    } });
  }
  const explicitReplays = references.filter((reference) => reference.source.point.failure_disposition !== "material_domain");
  if (explicitReplays.length) {
    expect(await nextProgressiveEvidenceWakeAt(db, "delivery")).toBeNull();
    const previousRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    try {
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
      const selection = {
        executionId,
        expectedCount: explicitReplays.length,
        points: explicitReplays.map((reference) => ({
          pointContentSignature: reference.source.contentSignature,
          resultAttemptId: reference.attempt.id,
          sequence: queued.sequence,
        })),
      };
      const preview = await replayProgressiveWorkerOutbox(db, selection);
      expect(preview.requeuedCount).toBe(0);
      expect(await replayProgressiveWorkerOutbox(db, {
        ...selection, manifestSignature: preview.manifestSignature,
      }, { apply: true })).toMatchObject({ requeuedCount: explicitReplays.length });
    } finally {
      if (previousRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
      else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = previousRole;
    }
  }
  const first = references[0];
  const issued = await recordProgressiveRemoteDiagnosticReceipt(db, first.delivery);
  expect(issued.kind).toBe("retained-progressive-diagnostic");
  expect(issued).not.toHaveProperty("resultId");
  expect(issued).not.toHaveProperty("resultAttemptId");
  for (const changed of [
    { ...first.delivery,solverId: randomUUID() },
    { ...first.delivery,progressiveEvidence: { ...first.delivery.progressiveEvidence,sequence: 999 } },
    { ...first.delivery,progressiveEvidence: { ...first.delivery.progressiveEvidence,pointContentSignature: "0".repeat(64) } },
  ]) await expect(recordProgressiveRemoteDiagnosticReceipt(db,changed)).rejects.toThrow();
  for (const mutation of [
    sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
      SELECT ${randomUUID()}::uuid,attempt.unit_id,'isolated new owner',attempt.execution_recipe_id,attempt.started_at+interval '1 second',
        clock_timestamp(),'failed' FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        WHERE attempt.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${first.delivery.aoaDeg}`,
    sql`UPDATE calculation_epochs SET current=false WHERE id=${envelope.scope.epochId}::uuid`,
  ]) {
    const restore = new Error("Restore diagnostic first-issuance refusal");
    await expect(db.transaction(async (nested) => {
      const scoped = nested as unknown as DB;
      await scoped.execute(sql`DELETE FROM progressive_remote_diagnostic_receipts WHERE sim_job_id=${executionId}::uuid`);
      await scoped.execute(mutation);
      await expect(recordProgressiveRemoteDiagnosticReceipt(scoped,first.delivery)).rejects.toThrow();
      throw restore;
    })).rejects.toBe(restore);
  }
  const restore = new Error("Restore diagnostic ACK lost after commit");
  await expect(db.transaction(async (nested) => {
    const scoped = nested as unknown as DB;
    for (const original of originals)
      await scoped.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,started_at,lease_until,outcome)
        VALUES (${randomUUID()}::uuid,${original.unit_id}::uuid,'isolated retry',${original.execution_recipe_id},
          ${new Date(original.started_at as string | Date).toISOString()}::timestamptz+interval '1 second',clock_timestamp(),'failed')`);
    await scoped.execute(sql`UPDATE progressive_generations SET stage=3 WHERE id=${envelope.scope.generationId}::uuid`);
    expect(await recordProgressiveRemoteDiagnosticReceipt(scoped,first.delivery)).toEqual(issued);
    throw restore;
  })).rejects.toBe(restore);
  let calls = 0;
  await withProgressiveSyncApi(db,async (app) => {
  const url = `/api/sync/v1/progressive-executions/${executionId}/reports`;
  const diagnostic = { aoaDeg: first.delivery.aoaDeg,engineCaseSlug: first.delivery.engineCaseSlug,
    remoteResultId: first.attempt.resultId,remoteResultAttemptId: first.attempt.id,
    pointContentSignature: first.source.contentSignature };
  const payload = { promiseId: envelope.promiseId,report,diagnostic };
  for (const token of [undefined,"wrong-credential"]) {
    const rejected = await app.inject({ method: "POST",url,payload,
      headers: token ? { "x-xfoilfoam-solver-token": token } : {} });
    expect(rejected.statusCode).toBe(401);
  }
  const changed = await app.inject({ method: "POST",url,
    headers: { "x-xfoilfoam-solver-token": "isolated-diagnostic-credential" },
    payload: { ...payload,report: { ...report,status: { ...report.status,message: "changed immutable report" } } } });
  expect(changed.statusCode).toBe(409);
  const wrongSource = await app.inject({ method: "POST",url,
    headers: { "x-xfoilfoam-solver-token": "isolated-diagnostic-credential" },
    payload: { ...payload,diagnostic: { ...diagnostic,pointContentSignature: "0".repeat(64) } } });
  expect(wrongSource.statusCode).toBe(409);
  const fetcher: typeof fetch = async (url,options) => {
    calls += 1;
    expect(String(url)).toBe(`${baseUrl}/progressive-executions/${executionId}/reports`);
    expect(new Headers(options?.headers).get("x-xfoilfoam-solver-token")).toBe("isolated-diagnostic-credential");
    const response = await app.inject({ method: "POST",url: new URL(String(url)).pathname,
      headers: Object.fromEntries(new Headers(options?.headers)),payload: JSON.parse(String(options?.body)) });
    return new Response(response.body,{ status: response.statusCode,headers: { "content-type": "application/json" } });
  };
  expect(await nextProgressiveEvidenceWakeAt(db,"delivery")).not.toBeNull();
  for (const reference of references) {
    await expect(recordProgressiveWorkerEvidenceReceipt(db,{ ...issued,pointContentSignature: "0".repeat(64) }, {
      executionId,pointContentSignature: reference.source.contentSignature,
      resultId: reference.attempt.resultId!,resultAttemptId: reference.attempt.id,
    })).rejects.toThrow();
    expect(await deliverNextProgressiveWorkerEvidence(db,fetcher)).toBe(true);
  }
  expect(await deliverNextProgressiveWorkerEvidence(db,fetcher)).toBe(false);
  expect(calls).toBe(references.length);
  expect(await nextProgressiveEvidenceWakeAt(db,"delivery")).toBeNull();
  expect(await db.execute(progressiveArchiveSelectionSql())).toHaveLength(0);
  expect(await db.execute(sql`SELECT sim_job_id FROM progressive_worker_delivery_failures WHERE sim_job_id=${executionId}::uuid`)).toHaveLength(0);
  const receipts = await db.execute(sql`SELECT receipt FROM progressive_worker_hub_receipts WHERE sim_job_id=${executionId}::uuid`);
  expect(receipts).toHaveLength(references.length);
  for (const retained of receipts) {
    expect(retained.receipt).toMatchObject({ kind: "retained-progressive-diagnostic" });
    expect(retained.receipt).not.toHaveProperty("resultId");
  }
  const [reserved] = await db.execute(sql`SELECT ${solverCpuReservationSql("job")} AS reserved
    FROM sim_jobs job WHERE id=${executionId}::uuid`);
  expect(reserved.reserved).toBe(false);
  expect(await db.execute(sql`SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid AND valid_for_polar`)).toHaveLength(0);
  });
}
