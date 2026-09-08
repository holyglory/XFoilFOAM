import { randomUUID } from "node:crypto";
import { verifyProgressiveArchiveCustody } from "./progressive-evidence-custody-fixture";
import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { resultAttempts, results } from "../src/schema";
import { resolveProgressiveRemoteEvidence } from "../src/progressive-remote-evidence";
import { progressiveRemotePointProjection } from "../src/progressive-remote-point-projection";
import {
  readProgressiveRemoteEvidenceReceipt,
  recordProgressiveRemoteEvidenceReceipt,
  type ProgressiveRemoteEvidenceDelivery,
} from "../src/progressive-remote-evidence-receipts";

export async function verifyProgressiveRemoteEvidenceReceipt(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery,
) {
  const source = await resolveProgressiveRemoteEvidence(db, delivery);
  if (!source) throw new Error("Missing isolated receipt source");
  const projection = progressiveRemotePointProjection(source);
  const [job] =
    await db.execute(sql`SELECT airfoil_id, simulation_preset_revision_id, bc_ids, campaign_id, engine_job_id
    FROM sim_jobs WHERE id = ${delivery.engineJobId}::uuid`);
  const [campaign] = await db.execute(
    sql`SELECT status FROM sim_campaigns WHERE id = ${job.campaign_id}::uuid`,
  );
  const [existing] =
    await db.execute(sql`SELECT id FROM results WHERE airfoil_id = ${job.airfoil_id}::uuid
    AND simulation_preset_revision_id = ${job.simulation_preset_revision_id}::uuid AND aoa_deg = ${projection.aoaDeg}`);
  const createdResultId = existing ? null : randomUUID();
  const resultId = existing ? String(existing.id) : createdResultId!;
  const ownedAttemptIds: string[] = [];
  try {
    if (createdResultId)
      await db.insert(results).values({
        id: resultId,
        airfoilId: String(job.airfoil_id),
        bcId: (job.bc_ids as string[])[0],
        simulationPresetRevisionId: String(job.simulation_preset_revision_id),
        aoaDeg: projection.aoaDeg,
        status: "queued",
        source: "queued",
        simJobId: delivery.engineJobId,
      });
    expect(await readProgressiveRemoteEvidenceReceipt(db, delivery)).toBeNull();
    const values: typeof resultAttempts.$inferInsert = {
      resultId,
      airfoilId: String(job.airfoil_id),
      bcId: (job.bc_ids as string[])[0],
      simulationPresetRevisionId: String(job.simulation_preset_revision_id),
      simJobId: delivery.engineJobId,
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
      validForPolar: false,
    };
    const changedAttemptId = randomUUID();
    ownedAttemptIds.push(changedAttemptId);
    await db
      .insert(resultAttempts)
      .values({ ...values, id: changedAttemptId, cl: 99 });
    await expect(
      recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        resultAttemptId: changedAttemptId,
      }),
    ).rejects.toThrow("reported source values");
    expect(await readProgressiveRemoteEvidenceReceipt(db, delivery)).toBeNull();
    await db
      .delete(resultAttempts)
      .where(eq(resultAttempts.id, changedAttemptId));
    const attemptId = randomUUID();
    ownedAttemptIds.push(attemptId);
    await db.insert(resultAttempts).values({ ...values, id: attemptId });
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id = id::text WHERE id = ${delivery.engineJobId}::uuid`,
    );
    const receipts = await Promise.all([
      recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        resultAttemptId: attemptId,
      }),
      recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        resultAttemptId: attemptId,
      }),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]).toMatchObject({
      executionId: delivery.engineJobId,
      resultId,
      resultAttemptId: attemptId,
      pointContentSignature: delivery.progressiveEvidence.pointContentSignature,
    });
    await verifyProgressiveArchiveCustody(db, delivery, attemptId);
    await expect(
      readProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        remoteResultAttemptId: randomUUID(),
      }),
    ).rejects.toThrow("remote evidence identity");
    await db.execute(
      sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id = ${job.campaign_id}::uuid`,
    );
    expect(
      await recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        resultAttemptId: attemptId,
      }),
    ).toEqual(receipts[0]);
    await expect(
      recordProgressiveRemoteEvidenceReceipt(db, {
        ...delivery,
        resultAttemptId: randomUUID(),
      }),
    ).rejects.toThrow("another local attempt");
    const [retained] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, attemptId));
    expect(retained.validForPolar).toBe(false);
    expect(retained.cl).toBe(projection.cl);
    await expect(
      db.execute(sql`UPDATE progressive_remote_evidence_receipts SET remote_result_attempt_id = ${randomUUID()}::uuid
      WHERE sim_job_id = ${delivery.engineJobId}::uuid`),
    ).rejects.toThrow();
  } finally {
    await db.execute(
      sql`UPDATE sim_jobs SET engine_job_id = ${job.engine_job_id} WHERE id = ${delivery.engineJobId}::uuid`,
    );
    await db.execute(
      sql`UPDATE sim_campaigns SET status = ${campaign.status} WHERE id = ${job.campaign_id}::uuid`,
    );
    for (const attemptId of ownedAttemptIds)
      await db.delete(resultAttempts).where(eq(resultAttempts.id, attemptId));
    if (createdResultId)
      await db.delete(results).where(eq(results.id, createdResultId));
  }
}
