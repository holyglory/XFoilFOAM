import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import { expireBrokeredEvidenceUploads } from "../../../apps/api/src/remote-evidence-broker";
import type { DB } from "../src/client";
import { registerVerifiedBrokeredEvidenceArchive } from "../src/brokered-evidence-archive";
import {
  progressiveArchiveManifestBytes,
  progressiveArchiveManifestSha256,
  progressiveArchiveMembers,
} from "./progressive-archive-data";
import {
  readProgressiveEvidenceCustodyReceipt,
  signProgressiveEvidenceCustodyReceipt,
  verifyProgressiveEvidenceCustodyReceipt,
} from "../src/progressive-evidence-custody";
import type { ProgressiveRemoteEvidenceDelivery } from "../src/progressive-remote-evidence-receipts";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { readProgressiveRemoteRetention } from "../src/progressive-remote-retention";
import { applyProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { settleProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-settlement";
import {
  resultAttempts,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  syncBrokeredEvidenceUploads,
} from "../src/schema";

export async function verifyProgressiveArchiveCustody(
  db: DB,
  source: ProgressiveRemoteEvidenceDelivery,
  resultAttemptId: string,
) {
  const rollback = new Error("Rollback isolated archive custody fixture");
  for (const status of [
    "active",
    "expired",
    "cancelled",
    "fulfilled",
  ] as const) {
    try {
      await db.transaction(async (transaction) => {
        await exerciseProgressiveArchiveCustody(
          transaction as unknown as DB,
          source,
          resultAttemptId,
          status,
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
}

async function exerciseProgressiveArchiveCustody(
  db: DB,
  source: ProgressiveRemoteEvidenceDelivery,
  resultAttemptId: string,
  status: "active" | "expired" | "cancelled" | "fulfilled",
) {
  expect(await readProgressiveRemoteRetention(db, source.engineJobId)).toEqual({
    kind: "waiting",
    reason: "final_report",
  });
  const [latest] =
    await db.execute(sql`SELECT report FROM progressive_remote_reports
    WHERE sim_job_id = ${source.engineJobId}::uuid ORDER BY sequence DESC LIMIT 1`);
  const terminal = structuredClone(latest.report) as ProgressiveRemoteReport;
  const [requested] =
    await db.execute(sql`SELECT request_payload#>'{engineRequest,aoa,angles}' AS angles
    FROM sim_jobs WHERE id = ${source.engineJobId}::uuid`);
  const angles = requested.angles as number[];
  if (status === "active") {
    expect(angles.length).toBeGreaterThan(1);
    expect(source.aoaDeg).toBe(0);
    const promotion = structuredClone(terminal);
    promotion.sequence += 1;
    promotion.result!.polars[0].rans_precalc_promotion = {
      trigger_aoa_deg: source.aoaDeg,
      failure_disposition: "hard_solver",
      attempted_aoas: [source.aoaDeg],
      intentionally_omitted_aoas: [...angles]
        .sort((left, right) => left - right)
        .filter((angle) => angle !== source.aoaDeg),
    };
    await storeProgressiveRemoteReport(db, {
      executionId: source.engineJobId,
      solverId: source.solverId,
      promiseId: source.promiseId,
      report: promotion,
    });
    terminal.sequence = promotion.sequence;
  }
  terminal.sequence += 1;
  terminal.status.state = "failed";
  for (const progress of terminal.status.solver_budget_progress?.cases ?? [])
    progress.solver_running = false;
  if (terminal.status.solver_budget_progress)
    terminal.status.solver_budget_progress.observed_at = new Date(
      Date.parse(terminal.status.solver_budget_progress.observed_at) + 1,
    ).toISOString();
  terminal.result = { ...terminal.result!, state: "failed", polars: [] };
  terminal.stopProof = {
    version: 1,
    job_id: source.engineJobId,
    execution_stopped: true,
    producer_stopped: true,
    namespace_verified: true,
    remaining: [],
    observed_at: "2026-09-07T20:00:00Z",
    error: null,
    fence: "terminal_result",
    ownership_basis: "recorded_execution_namespace",
  };
  await storeProgressiveRemoteReport(db, {
    executionId: source.engineJobId,
    solverId: source.solverId,
    promiseId: source.promiseId,
    report: terminal,
  });
  expect(
    await readProgressiveRemoteRetention(db, source.engineJobId),
  ).toMatchObject({
    kind: "waiting",
    reason: "archives",
    sourceCount: 1,
    pendingCount: 1,
  });
  expect(
    await settleProgressiveRemoteJob(db, source.engineJobId),
  ).toMatchObject({ kind: "waiting", reason: "report_progress" });
  for (let sequence = 1; sequence <= terminal.sequence; sequence += 1)
    expect(
      await applyProgressiveRemoteProgress(db, source.engineJobId),
    ).toMatchObject({ kind: "applied", sequence });
  expect(
    await settleProgressiveRemoteJob(db, source.engineJobId),
  ).toMatchObject({ kind: "waiting", reason: "archives" });
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(eq(resultAttempts.id, resultAttemptId));
  if (!attempt?.resultId)
    throw new Error("Isolated archive fixture requires its retained attempt");
  const [solver] = await db.execute(
    sql`SELECT instance_id FROM registered_remote_solvers WHERE id = ${source.solverId}::uuid`,
  );
  await db.execute(sql`UPDATE sync_sweep_promises SET status = ${status}::sync_promise_status,
    "expiresAt" = CASE WHEN ${status} = 'active' THEN clock_timestamp() + interval '1 hour' ELSE clock_timestamp() - interval '1 second' END
    WHERE id = ${source.promiseId}::uuid`);
  await db.execute(sql`UPDATE sync_sweep_promise_points SET status = ${status}::sync_promise_status
    WHERE promise_id = ${source.promiseId}::uuid AND aoa_deg = ${source.aoaDeg}`);
  if (status === "fulfilled") {
    const otherAttemptId = randomUUID();
    await db.insert(resultAttempts).values({
      ...attempt,
      id: otherAttemptId,
      simJobId: null,
      engineJobId: randomUUID(),
    });
    await db.execute(sql`UPDATE sync_sweep_promise_points SET result_id = ${attempt.resultId}::uuid, result_attempt_id = ${otherAttemptId}::uuid
      WHERE promise_id = ${source.promiseId}::uuid AND aoa_deg = ${source.aoaDeg}`);
  }
  const [point] = await db.execute(
    sql`SELECT id, status, result_id, result_attempt_id FROM sync_sweep_promise_points WHERE promise_id = ${source.promiseId}::uuid AND aoa_deg = ${source.aoaDeg}`,
  );
  const uploadId = randomUUID();
  const identity = {
    bucket: "isolated-progressive-custody",
    objectKey: `solver-evidence/v1/sha256/cc/${"c".repeat(64)}.tar.zst`,
    generation: "9007199254740993123",
    crc32c: "ImIEBA==",
    storedSha256: "c".repeat(64),
    storedByteSize: 500,
    tarSha256: "d".repeat(64),
    tarByteSize: 1500,
    manifestSha256: progressiveArchiveManifestSha256,
    manifestByteSize: progressiveArchiveManifestBytes.byteLength,
    zstdLevel: 3,
    bundledFileCount: 1,
    verifiedAt: new Date(),
  };
  const owner = {
    resultId: attempt.resultId,
    resultAttemptId,
    airfoilId: attempt.airfoilId,
    simJobId: attempt.simJobId,
    engineJobId: attempt.engineJobId,
    engineCaseSlug: attempt.engineCaseSlug,
    methodKey: attempt.methodKey,
    solverImplementationId: attempt.solverImplementationId,
    solverRuntimeBuildId: attempt.solverRuntimeBuildId,
    aoaDeg: attempt.aoaDeg,
  };
  {
    await expect(
      readProgressiveEvidenceCustodyReceipt(db, source, uploadId),
    ).rejects.toThrow("complete registered archive");
    await db.execute(sql`UPDATE sync_sweep_promises SET source_instance_id = ${solver.instance_id},
      request_payload = coalesce(request_payload, '{}'::jsonb) || ${JSON.stringify({ solverId: source.solverId })}::jsonb WHERE id = ${source.promiseId}::uuid`);
    await db.execute(
      sql`UPDATE registered_remote_solvers SET auth_token_hash = ${createHash("sha256").update(`isolated-custody-${randomUUID()}`).digest("hex")} WHERE id = ${source.solverId}::uuid`,
    );
    await db.insert(syncBrokeredEvidenceUploads).values({
      ...identity,
      id: uploadId,
      idempotencyKey: randomUUID(),
      promiseId: source.promiseId,
      promisePointId: String(point.id),
      solverId: source.solverId,
      sourceInstanceId: String(solver.instance_id),
      remoteResultId: source.remoteResultId,
      remoteResultAttemptId: source.remoteResultAttemptId,
      aoaDeg: source.aoaDeg,
      engineJobId: source.engineJobId,
      engineCaseSlug: source.engineCaseSlug,
      state: "verified",
    });
    const [eligible] =
      await db.execute(sql`SELECT is_exact_retained_progressive_archive(candidate) AS eligible
      FROM sync_brokered_evidence_uploads candidate WHERE id = ${uploadId}::uuid`);
    expect(eligible.eligible).toBe(true);
    await expireBrokeredEvidenceUploads(db);
    const [unrevoked] = await db
      .select()
      .from(syncBrokeredEvidenceUploads)
      .where(eq(syncBrokeredEvidenceUploads.id, uploadId));
    expect(unrevoked.state).toBe("verified");
    const restoreCredential = new Error("Restore isolated credential state");
    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(
          sql`UPDATE registered_remote_solvers SET revoked_at = clock_timestamp() WHERE id = ${source.solverId}::uuid`,
        );
        const [revoked] =
          await transaction.execute(sql`SELECT is_exact_retained_progressive_archive(candidate) AS eligible
          FROM sync_brokered_evidence_uploads candidate WHERE id = ${uploadId}::uuid`);
        expect(revoked.eligible).toBe(false);
        await expireBrokeredEvidenceUploads(transaction as unknown as DB);
        const [upload] = await transaction
          .select()
          .from(syncBrokeredEvidenceUploads)
          .where(eq(syncBrokeredEvidenceUploads.id, uploadId));
        expect(upload.state).toBe("revoked");
        throw restoreCredential;
      });
    } catch (error) {
      if (error !== restoreCredential) throw error;
    }
    for (const changed of [
      { remote_result_id: randomUUID() },
      { remote_result_attempt_id: randomUUID() },
      { engine_job_id: randomUUID() },
      { engine_case_slug: "unrelated-case" },
      { aoa_deg: source.aoaDeg + 0.125 },
      { solver_id: randomUUID() },
      { promise_id: randomUUID() },
      { manifest_sha256: "b".repeat(64) },
      { manifest_byte_size: identity.manifestByteSize + 1 },
      { canonical_result_id: randomUUID() },
      { canonical_result_attempt_id: randomUUID() },
    ]) {
      const [invalid] =
        await db.execute(sql`SELECT is_exact_retained_progressive_archive(
        jsonb_populate_record(NULL::sync_brokered_evidence_uploads, to_jsonb(candidate) || ${JSON.stringify(changed)}::jsonb)) AS eligible
        FROM sync_brokered_evidence_uploads candidate WHERE id = ${uploadId}::uuid`);
      expect(invalid.eligible, JSON.stringify(changed)).toBe(false);
    }
    const [bundle] = await db
      .insert(solverEvidenceArtifacts)
      .values({
        ...owner,
        kind: "engine_bundle",
        storageKey: identity.objectKey,
        mimeType: "application/zstd",
        sha256: identity.storedSha256,
        byteSize: identity.storedByteSize,
        metadata: {
          remoteEvidenceUploadId: uploadId,
          storageBackend: "gcs",
          ...identity,
        },
      })
      .returning();
    const [manifest] = await db
      .insert(solverEvidenceArtifacts)
      .values({
        ...owner,
        kind: "manifest",
        storageKey: `${identity.objectKey}.manifest`,
        mimeType: "application/json",
        sha256: identity.manifestSha256,
        byteSize: identity.manifestByteSize,
      })
      .returning();
    await db
      .update(syncBrokeredEvidenceUploads)
      .set({
        state: "bound",
        boundAt: new Date(),
        canonicalResultId: attempt.resultId,
        canonicalResultAttemptId: resultAttemptId,
        canonicalArtifactId: bundle.id,
      })
      .where(eq(syncBrokeredEvidenceUploads.id, uploadId));
    await expect(
      readProgressiveEvidenceCustodyReceipt(db, source, uploadId),
    ).rejects.toThrow("complete registered archive");
    const registered = await registerVerifiedBrokeredEvidenceArchive(db, {
      resultId: attempt.resultId,
      resultAttemptId,
      sourceArtifactId: bundle.id,
      manifestArtifactId: manifest.id,
      evidenceBase: "isolated-case",
      identity,
      memberSet: progressiveArchiveMembers,
    });
    const archiveId = registered.archiveId;
    const receipt = await readProgressiveEvidenceCustodyReceipt(
      db,
      source,
      uploadId,
    );
    const retention = await readProgressiveRemoteRetention(
      db,
      source.engineJobId,
    );
    expect(retention).toMatchObject({
      kind: "retained",
      report: terminal,
      sources: [{ resultAttemptId, archived: true, delivery: source }],
    });
    const rollbackInventory = new Error(
      "Rollback isolated missing source inventory",
    );
    await expect(
      db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        await connection.execute(sql`DELETE FROM progressive_remote_report_inventories
        WHERE sim_job_id = ${source.engineJobId}::uuid AND sequence = ${source.progressiveEvidence.sequence}`);
        expect(
          await readProgressiveRemoteRetention(connection, source.engineJobId),
        ).toEqual({ kind: "waiting", reason: "source_inventory" });
        throw rollbackInventory;
      }),
    ).rejects.toBe(rollbackInventory);
    expect(receipt).toMatchObject({
      kind: "hub-progressive-evidence-custody",
      source,
      remote: { generation: identity.generation },
      canonical: {
        resultId: attempt.resultId,
        resultAttemptId,
        artifactId: bundle.id,
        archiveId,
      },
    });
    expect(receipt).not.toHaveProperty("promisePointState");
    const signed = signProgressiveEvidenceCustodyReceipt(
      receipt,
      "isolated-custody-credential",
    );
    expect(
      verifyProgressiveEvidenceCustodyReceipt(
        signed,
        "isolated-custody-credential",
        receipt,
      ),
    ).toEqual(receipt);
    expect(() =>
      verifyProgressiveEvidenceCustodyReceipt(
        signed,
        "another-credential",
        receipt,
      ),
    ).toThrow("signature");
    expect(() =>
      verifyProgressiveEvidenceCustodyReceipt(
        {
          ...signed,
          receipt: { ...receipt, kind: "hub-canonical-evidence-binding" },
        },
        "isolated-custody-credential",
        receipt,
      ),
    ).toThrow("exact delivery");
    expect(() =>
      verifyProgressiveEvidenceCustodyReceipt(
        signed,
        "isolated-custody-credential",
        {
          ...receipt,
          remote: { ...receipt.remote, generation: "9007199254740993124" },
        },
      ),
    ).toThrow("exact delivery");
    expect(() =>
      verifyProgressiveEvidenceCustodyReceipt(
        signed,
        "isolated-custody-credential",
        { ...receipt, source: { ...source, solverId: randomUUID() } },
      ),
    ).toThrow("exact delivery");
    expect(() =>
      verifyProgressiveEvidenceCustodyReceipt(
        { ...signed, receiptHmac: "a" },
        "isolated-custody-credential",
        receipt,
      ),
    ).toThrow("exact delivery");
    const [retained] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, resultAttemptId));
    expect(retained.validForPolar).toBe(false);
    const [unchangedPoint] = await db.execute(
      sql`SELECT id, status, result_id, result_attempt_id FROM sync_sweep_promise_points WHERE id = ${point.id}::uuid`,
    );
    expect(unchangedPoint).toEqual(point);
    const [member] = await db
      .select()
      .from(solverEvidenceArtifactMembers)
      .where(eq(solverEvidenceArtifactMembers.archiveId, archiveId));
    await db
      .delete(solverEvidenceArtifactMembers)
      .where(
        and(
          eq(solverEvidenceArtifactMembers.archiveId, member.archiveId),
          eq(solverEvidenceArtifactMembers.artifactId, member.artifactId),
        ),
      );
    await expect(
      readProgressiveEvidenceCustodyReceipt(db, source, uploadId),
    ).rejects.toThrow("every authenticated manifest member");
    await expect(
      readProgressiveRemoteRetention(db, source.engineJobId),
    ).rejects.toThrow("every authenticated manifest member");
    await db.insert(solverEvidenceArtifactMembers).values(member);
    expect(
      await readProgressiveEvidenceCustodyReceipt(db, source, uploadId),
    ).toEqual(receipt);
    await expect(
      readProgressiveEvidenceCustodyReceipt(
        db,
        { ...source, remoteResultId: randomUUID() },
        uploadId,
      ),
    ).rejects.toThrow("remote evidence identity");
    const settled = await settleProgressiveRemoteJob(db, source.engineJobId);
    expect(settled).toMatchObject({
      kind: "settled",
      counts: { retry: status === "active" ? angles.length : 1, waiting: 0 },
    });
    const [recovery] = await db.execute(sql`SELECT count(*)::integer AS count,
      bool_and(scope = ${status === "active" ? "original_sweep" : "targeted"}) AS exact_scope
      FROM progressive_cfd_recovery_plans WHERE parent_job_id = ${source.engineJobId}::uuid`);
    expect(recovery).toEqual({
      count: status === "active" ? angles.length : 1,
      exact_scope: true,
    });
    const [finished] = await db.execute(
      sql`SELECT status, "ingestedAt" FROM sim_jobs WHERE id = ${source.engineJobId}::uuid`,
    );
    expect(finished.status).toBe("failed");
    expect(finished.ingestedAt).not.toBeNull();
    expect(
      await settleProgressiveRemoteJob(db, source.engineJobId),
    ).toMatchObject({
      kind: "settled",
      counts: { complete: 0, retry: 0, gaps: 0, cancelled: 0, waiting: 0 },
    });
    const replay = structuredClone(terminal);
    replay.sequence += 1;
    replay.stopProof!.observed_at = "2026-09-07T20:01:00Z";
    await storeProgressiveRemoteReport(db, {
      executionId: source.engineJobId,
      solverId: source.solverId,
      promiseId: source.promiseId,
      report: replay,
    });
    await applyProgressiveRemoteProgress(db, source.engineJobId);
    const [afterReplay] = await db.execute(
      sql`SELECT status, "ingestedAt" FROM sim_jobs WHERE id = ${source.engineJobId}::uuid`,
    );
    expect(afterReplay).toEqual(finished);
  }
}
