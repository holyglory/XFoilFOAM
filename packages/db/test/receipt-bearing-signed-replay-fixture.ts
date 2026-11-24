import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import {
  readAttemptEvidenceText,
  type AttemptEvidenceArchiveReader,
} from "../src/attempt-evidence-reader";
import {
  assertAttemptSourcePins,
  loadAttemptSourcePins,
} from "../src/attempt-receipt-source";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { prepareProgressiveRemoteEvidence } from "../src/progressive-remote-evidence";
import {
  prepareProgressiveRemoteReceiptReplay,
  recordProgressiveRemoteEvidenceReceipt,
  type ProgressiveRemoteEvidenceDelivery,
} from "../src/progressive-remote-evidence-receipts";
import {
  readProgressiveEvidenceCustodyReceipt,
  verifyProgressiveEvidenceCustodyReceipt,
} from "../src/progressive-evidence-custody";
import {
  readProgressiveRemoteRetention,
  withPreparedProgressiveRemoteRetention,
} from "../src/progressive-remote-retention";
import { assertStoppedProgressiveStorageAdmission } from "../src/progressive-stopped-storage";
import {
  readStoredAttemptEvidenceText,
  apiAttemptEvidenceReader,
} from "../../../apps/api/src/attempt-evidence-reader";
import { withProgressiveSyncApi } from "../../../apps/api/test/progressive-polar-import-fixture";
import { env } from "../../../apps/api/src/env";
import {
  restoreAttemptEvidence,
  setAttemptEvidenceStoragePolicy,
  setShortAttemptProofPolicy,
} from "../src/attempt-evidence-projection";
import { archiveAttemptEvidence } from "../../../apps/sweeper/src/attempt-evidence-service";
import {
  configuredAttemptEvidenceSettlementDependencies,
  settleAttemptEvidenceHistory,
} from "../../../apps/sweeper/src/attempt-evidence-settlement";
import { AttemptEvidenceStore } from "../../../apps/sweeper/src/attempt-evidence-store";
import { SettlementGcs } from "../../../apps/sweeper/test-support/attempt-settlement-fixture";
import { advisoryLockSql } from "../../../apps/api/src/db";
import { EngineClient } from "../../engine-client/src";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBrokeredEvidenceUploads } from "../src/schema";
import type { ProgressiveEvidenceCustodyReceipt } from "../src/progressive-evidence-custody";
import {
  progressiveArchiveManifestBytes,
  progressiveArchiveManifestSha256,
} from "./progressive-archive-data";

function archivePost(
  app: Parameters<Parameters<typeof withProgressiveSyncApi>[1]>[0],
  token: string,
  instanceId: string,
  uploadId: string,
  remote: ProgressiveEvidenceCustodyReceipt["remote"],
  source: ProgressiveRemoteEvidenceDelivery,
) {
  return app.inject({
    method: "POST",
    url: "/api/sync/v1/polars",
    headers: { "x-xfoilfoam-solver-token": token },
    payload: {
      promiseId: source.promiseId,
      sourceInstanceId: instanceId,
      results: [
        {
          aoaDeg: source.aoaDeg,
          engineJobId: source.engineJobId,
          engineCaseSlug: source.engineCaseSlug,
          remoteResultId: source.remoteResultId,
          remoteResultAttemptId: source.remoteResultAttemptId,
          progressiveEvidence: source.progressiveEvidence,
          progressiveArchiveOnly: true,
          fieldExtents: [],
          media: [],
          evidenceArtifacts: [
            {
              kind: "manifest",
              mimeType: "application/json",
              sha256: remote.manifestSha256,
              byteSize: remote.manifestByteSize,
              contentBase64: progressiveArchiveManifestBytes.toString("base64"),
            },
            {
              kind: "engine_bundle",
              mimeType: "application/zstd",
              sha256: remote.storedSha256,
              byteSize: remote.storedByteSize,
              remoteEvidenceUploadId: uploadId,
              metadata: {
                ...remote,
                storageBackend: "gcs",
                evidenceBase: "isolated-case",
                tarByteSize: String(remote.tarByteSize),
                manifestByteSize: String(remote.manifestByteSize),
              },
            },
          ],
        },
      ],
    },
  });
}

async function expectNoArchiveConflict(
  db: DB,
  reply: Awaited<ReturnType<typeof archivePost>>,
) {
  expect(reply.statusCode, reply.body).toBe(200);
  const conflicts = reply.json().conflictIds as string[];
  const details = conflicts.length
    ? await db.execute(sql`SELECT data_type, status, natural_key, fingerprint,
    local_snapshot->>'id' AS local_result, local_snapshot->>'currentResultAttemptId' AS local_selected_attempt,
    incoming_payload->>'remoteResultId' AS remote_result, incoming_payload->>'remoteResultAttemptId' AS remote_attempt,
    incoming_payload->>'engineJobId' AS execution, incoming_payload->>'engineCaseSlug' AS solver_case,
    incoming_payload->'progressiveEvidence' AS reported_source, artifact_manifest->>'promiseId' AS promise
    FROM sync_import_conflicts WHERE id IN (${sql.join(
      conflicts.map((id) => sql`${id}::uuid`),
      sql`,`,
    )}) ORDER BY id`)
    : [];
  expect(
    conflicts,
    JSON.stringify({ response: reply.json(), storedConflicts: details }),
  ).toEqual([]);
}

/** Bind fixture artifacts using the registered import that will later replay
 * them, including exact manifest storage, provenance and runtime identities. */
export async function bindReceiptBearingSignedArchive(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery & { resultAttemptId: string },
) {
  const [owner] =
    await db.execute(sql`SELECT s.instance_id,p.id AS point FROM registered_remote_solvers s
    JOIN sync_sweep_promise_points p ON p.promise_id=${delivery.promiseId}::uuid AND p.aoa_deg=${delivery.aoaDeg}
    WHERE s.id=${delivery.solverId}::uuid`);
  const token = randomUUID(),
    uploadId = randomUUID();
  const remote = {
    bucket: "isolated-storage-recovery",
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
  };
  const oldMedia = env.mediaDir,
    localMedia = await mkdtemp(join(tmpdir(), "signed-source-import-"));
  const advisory = vi
    .spyOn(advisoryLockSql, "reserve")
    .mockImplementation(db.$client.reserve.bind(db.$client));
  const verifier = vi
    .spyOn(EngineClient.prototype, "verifyRemoteEvidenceManifest")
    .mockImplementation(async (request) => ({
      ...request,
      state: "verified" as const,
    }));
  env.mediaDir = localMedia;
  try {
    await db.execute(
      sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")} WHERE id=${delivery.solverId}::uuid`,
    );
    await db.execute(sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`);
    await db.execute(
      sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN ('polars','evidence_artifacts')`,
    );
    await db.execute(sql`UPDATE sync_sweep_promises SET source_instance_id=${owner.instance_id},request_payload=coalesce(request_payload,'{}'::jsonb)||
      jsonb_build_object('solverId',${delivery.solverId}::text) WHERE id=${delivery.promiseId}::uuid`);
    await db.insert(syncBrokeredEvidenceUploads).values({
      ...remote,
      id: uploadId,
      idempotencyKey: randomUUID(),
      state: "verified",
      verifiedAt: new Date(),
      promiseId: delivery.promiseId,
      promisePointId: String(owner.point),
      solverId: delivery.solverId,
      sourceInstanceId: String(owner.instance_id),
      remoteResultId: delivery.remoteResultId,
      remoteResultAttemptId: delivery.remoteResultAttemptId,
      aoaDeg: delivery.aoaDeg,
      engineJobId: delivery.engineJobId,
      engineCaseSlug: delivery.engineCaseSlug,
    });
    await withProgressiveSyncApi(db, async (app) => {
      const post = () =>
        archivePost(
          app,
          token,
          String(owner.instance_id),
          uploadId,
          remote,
          delivery,
        );
      const reply = await post();
      await expectNoArchiveConflict(db, reply);
      expect(reply.json().progressiveArchiveReceipts).toHaveLength(1);
      expect(reply.json().progressiveEvidenceReceipts[0].resultAttemptId).toBe(
        delivery.resultAttemptId,
      );
      const replay = await post();
      await expectNoArchiveConflict(db, replay);
      expect(replay.json().progressiveEvidenceReceipts).toEqual(
        reply.json().progressiveEvidenceReceipts,
      );
      expect(replay.json().progressiveArchiveReceipts).toEqual(
        reply.json().progressiveArchiveReceipts,
      );
      expect(replay.json().fulfilledAoas).toEqual([]);
    });
  } finally {
    advisory.mockRestore();
    verifier.mockRestore();
    env.mediaDir = oldMedia;
    await rm(localMedia, { recursive: true, force: true });
  }
}

export async function verifyReceiptBearingSignedTransition(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery & { resultAttemptId: string },
  shortReceipt = false,
) {
  const id = delivery.resultAttemptId;
  const [raw] =
    await db.execute(sql`SELECT a.evidence_payload::text AS original,e.attempt_token,e.evidence_signature
    FROM result_attempts a JOIN progressive_cfd_evidence e ON e.result_attempt_id=a.id WHERE a.id=${id}::uuid`);
  expect(raw.attempt_token).toBeTruthy();
  const memory = new SettlementGcs();
  const store = new AttemptEvidenceStore(
    memory as unknown as ConstructorParameters<typeof AttemptEvidenceStore>[0],
  );
  const saved = env.evidenceBucket;
  const localRead = store.read.bind(store);
  const read = vi
    .spyOn(AttemptEvidenceStore.prototype, "read")
    .mockImplementation(localRead);
  env.evidenceBucket = "fixture";
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "fixture");
  try {
    const { archive } = await archiveAttemptEvidence(db, store, {
      attemptId: id,
      bucket: "fixture",
      sourceInstance: "hub",
    });
    await setAttemptEvidenceStoragePolicy(db, {
      enabled: true,
      receiptBearing: true,
      canaryAttemptId: id,
      consumerContractVersion: 1,
    });
    if (shortReceipt) await setShortAttemptProofPolicy(db, true, id, "tiny-history");
    const before = await readProgressiveRemoteRetention(
      db,
      delivery.engineJobId,
    );
    expect(before.kind).toBe("retained");
    await settleAttemptEvidenceHistory(
      db,
      { ...(await configuredAttemptEvidenceSettlementDependencies(db)), store },
      { attemptId: id, archiveId: archive.id },
    );
    const [event] = await db.execute(sql`SELECT e.verification?'shortReceipt' AS packed,
      e.verification#>'{dependencies,progressiveScope,remote}' IS NOT NULL AS inline_remote,
      v.verification#>>'{dependencies,progressiveScope,remote,pointContentSignature}' AS point
      FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id
        AND e.archive_id=a.evidence_archive_id AND e.result_attempt_id=a.id
      JOIN attempt_evidence_read_events v ON v.id=e.id WHERE a.id=${id}::uuid`);
    expect(event).toMatchObject({ packed: shortReceipt, inline_remote: !shortReceipt,
      point: delivery.progressiveEvidence.pointContentSignature });
    await verifyReceiptBearingSignedReplay(db, delivery, store);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const view = tx as unknown as DB;
      const observed = await withPreparedProgressiveRemoteRetention(
        view,
        delivery.engineJobId,
        store,
        () => readProgressiveRemoteRetention(view, delivery.engineJobId),
      );
      expect(observed).toEqual(before);
    });
    expect(
      await readProgressiveRemoteRetention(db, delivery.engineJobId),
    ).toEqual(before);
    expect(
      await withPreparedProgressiveRemoteRetention(
        db,
        delivery.engineJobId,
        store,
        () => readProgressiveRemoteRetention(db, delivery.engineJobId),
      ),
    ).toEqual(before);
    await restoreAttemptEvidence(
      db,
      id,
      archive.id,
      String(raw.original),
      "restore disposable signed replay original",
    );
    expect(await readStoredAttemptEvidenceText(db, id)).toBe(raw.original);
    expect(
      await readProgressiveRemoteRetention(db, delivery.engineJobId),
    ).toEqual(before);
  } finally {
    read.mockRestore();
    env.evidenceBucket = saved;
    vi.unstubAllEnvs();
  }
}

/** Called with a real stopped dispatch, its retained remote attempt, a bound raw
 * archive and a committed 0211 transition in the disposable campaign database. */
export async function verifyReceiptBearingSignedReplay(
  db: DB,
  delivery: ProgressiveRemoteEvidenceDelivery & { resultAttemptId: string },
  reader: AttemptEvidenceArchiveReader,
) {
  const [row] =
    await db.execute(sql`SELECT e.id AS event_id,e.verification#>>'{dependencies,verifier}' AS verifier,
    a.evidence_archive_id AS archive_id,r.id AS result_id,r.current_result_attempt_id AS selected,u.id AS upload_id,
    er.sequence,er.storage_only,er.point_content_signature,s.instance_id
    FROM result_attempts a JOIN results r ON r.id=a.result_id JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id
    JOIN progressive_remote_evidence_receipts er ON er.result_attempt_id=a.id JOIN sync_brokered_evidence_uploads u
      ON u.canonical_result_attempt_id=a.id AND u.remote_result_attempt_id=er.remote_result_attempt_id AND u.state='bound'
    JOIN registered_remote_solvers s ON s.id=u.solver_id WHERE a.id=${delivery.resultAttemptId}::uuid`);
  expect(row?.verifier).toBe("server-consumers/receipt-bearing-rans-v1");
  const pin = (await loadAttemptSourcePins(db, [delivery.resultAttemptId])).get(
    delivery.resultAttemptId,
  )!;
  const good = await readAttemptEvidenceText(
    db,
    reader,
    delivery.resultAttemptId,
    { requireArchiveRead: true },
  );
  expect(analysisContentHash(JSON.parse(good))).toBe(pin.applicationSha256);
  expect(pin.storageEventId).toBe(row.event_id);
  const token = randomUUID();
  const probe = vi
    .spyOn(apiAttemptEvidenceReader, "read")
    .mockImplementation(reader.read.bind(reader));
  const rollback = new Error("rollback signed remote replay fixture");
  const mediaDir = env.mediaDir;
  const localMedia = await mkdtemp(join(tmpdir(), "signed-receipt-replay-"));
  env.mediaDir = localMedia;
  const advisory = vi
    .spyOn(advisoryLockSql, "reserve")
    .mockImplementation(db.$client.reserve.bind(db.$client));
  const manifestVerifier = vi
    .spyOn(EngineClient.prototype, "verifyRemoteEvidenceManifest")
    .mockImplementation(async (request) => ({
      ...request,
      state: "verified" as const,
    }));
  try {
    try {
      await db.transaction(async (tx) => {
        const connection = tx as unknown as DB;
        await connection.execute(
          sql`UPDATE registered_remote_solvers SET auth_token_hash=${createHash("sha256").update(token).digest("hex")} WHERE id=${delivery.solverId}::uuid`,
        );
        await connection.execute(
          sql`UPDATE sync_api_settings SET enabled=true WHERE id=1`,
        );
        await connection.execute(
          sql`UPDATE sync_api_permissions SET can_push=true WHERE data_type IN ('polars','evidence_artifacts')`,
        );
        const ref = {
          ...delivery,
          progressiveEvidence: { ...delivery.progressiveEvidence },
        };
        await prepareProgressiveRemoteEvidence(connection, ref);
        const receipt = await prepareProgressiveRemoteReceiptReplay(
          connection,
          ref,
          reader,
        );
        expect(receipt).toMatchObject({
          resultId: row.result_id,
          resultAttemptId: delivery.resultAttemptId,
          sequence: Number(row.sequence),
          pointContentSignature: row.point_content_signature,
          storageOnly: row.storage_only,
          remoteResultId: delivery.remoteResultId,
          remoteResultAttemptId: delivery.remoteResultAttemptId,
        });
        expect(
          await recordProgressiveRemoteEvidenceReceipt(connection, ref),
        ).toEqual(receipt);
        const originalReport = (await prepareProgressiveRemoteEvidence(
          connection,
          ref,
        ))!.report;
        const duplicate = await storeProgressiveRemoteReport(connection, {
          solverId: ref.solverId,
          promiseId: ref.promiseId,
          executionId: ref.engineJobId,
          report: { ...originalReport, sequence: originalReport.sequence + 1 },
        });
        const repeated = {
          ...ref,
          progressiveEvidence: {
            ...ref.progressiveEvidence,
            sequence: duplicate.sequence,
            reportContentSignature: duplicate.contentSignature,
          },
        };
        await prepareProgressiveRemoteEvidence(connection, repeated);
        expect(
          await prepareProgressiveRemoteReceiptReplay(
            connection,
            repeated,
            reader,
          ),
        ).toEqual(receipt);
        expect(
          await recordProgressiveRemoteEvidenceReceipt(connection, repeated),
        ).toEqual(receipt);
        for (const change of [
          { reportContentSignature: "0".repeat(64) },
          { pointContentSignature: "0".repeat(64) },
        ]) {
          await expect(
            prepareProgressiveRemoteReceiptReplay(
              connection,
              {
                ...ref,
                progressiveEvidence: { ...ref.progressiveEvidence, ...change },
              },
              reader,
            ),
          ).rejects.toThrow(/report|point/);
        }
        await expect(
          assertAttemptSourcePins(connection, [
            { ...pin, cfdAttemptToken: randomUUID() },
          ]),
        ).rejects.toThrow(/source|receipt/i);
        const undo = new Error("rollback source race");
        try {
          await connection.transaction(async (nested) => {
            const locked = nested as unknown as DB;
            await restoreAttemptEvidence(
              locked,
              delivery.resultAttemptId,
              String(row.archive_id),
              good,
              "disposable replay representation race",
            );
            await expect(
              recordProgressiveRemoteEvidenceReceipt(locked, ref),
            ).rejects.toThrow(/source|binding|receipt/i);
            throw undo;
          });
        } catch (error) {
          if (error !== undo) throw error;
        }
        if (row.storage_only)
          expect(
            (await assertStoppedProgressiveStorageAdmission(connection, ref))
              .kind,
          ).toBe("retained-replay");
        const custody = await readProgressiveEvidenceCustodyReceipt(
          connection,
          ref,
          String(row.upload_id),
        );
        const retained = await withPreparedProgressiveRemoteRetention(
          connection,
          delivery.engineJobId,
          reader,
          () =>
            readProgressiveRemoteRetention(connection, delivery.engineJobId),
        );
        expect(retained.kind).toBe("retained");
        expect(
          await readStoredAttemptEvidenceText(
            connection,
            delivery.resultAttemptId,
            { requireArchiveRead: true },
          ),
        ).toBe(good);
        // The endpoint signs precisely the remote delivery fields, without the local attempt ID.
        const { resultAttemptId: _localAttempt, ...signedSource } = ref;
        await withProgressiveSyncApi(connection, async (app) => {
          const getCustody = () =>
            app.inject({
              method: "POST",
              url: `/api/sync/v1/evidence-uploads/${row.upload_id}/custody`,
              headers: { "x-xfoilfoam-solver-token": token },
            });
          const reply = await getCustody();
          expect(reply.statusCode, reply.body).toBe(200);
          expect(
            verifyProgressiveEvidenceCustodyReceipt(
              reply.json().progressiveArchiveReceipt,
              token,
              {
                source: signedSource,
                brokeredUploadId: String(row.upload_id),
                remote: custody.remote,
              },
            ).canonical,
          ).toEqual(custody.canonical);
          expect((await getCustody()).json()).toEqual(reply.json());
          const postArchive = (source = signedSource) =>
            archivePost(
              app,
              token,
              String(row.instance_id),
              String(row.upload_id),
              custody.remote,
              source,
            );
          const archived = await postArchive();
          await expectNoArchiveConflict(connection, archived);
          expect(
            archived.json().progressiveEvidenceReceipts,
            archived.body,
          ).toEqual([receipt]);
          expect(archived.json().progressiveArchiveReceipts).toEqual([
            reply.json().progressiveArchiveReceipt,
          ]);
          expect(archived.json().fulfilledAoas).toEqual([]);
          expect(
            (
              await postArchive({
                ...signedSource,
                remoteResultAttemptId: randomUUID(),
              })
            ).statusCode,
          ).toBe(409);
          await expect(
            recordProgressiveRemoteEvidenceReceipt(connection, {
              ...ref,
              remoteResultAttemptId: randomUUID(),
            }),
          ).rejects.toThrow(/immutable remote evidence identity/);
          await expect(
            prepareProgressiveRemoteReceiptReplay(
              connection,
              { ...ref, solverId: randomUUID() },
              reader,
            ),
          ).rejects.toThrow(/own|dispatch/);
          const source = JSON.parse(good);
          probe.mockImplementation(async (...args) => ({
            ...(await reader.read(...args)),
            attemptId: randomUUID(),
          }));
          expect((await getCustody()).statusCode).toBeGreaterThanOrEqual(400);
          source.steady_history.cl[0] += 1;
          probe.mockImplementation(async (...args) => ({
            ...(await reader.read(...args)),
            payloadText: JSON.stringify(source),
          }));
          expect((await getCustody()).statusCode).toBeGreaterThanOrEqual(400);
          probe.mockRejectedValue(new Error("missing pinned generation"));
          expect((await getCustody()).statusCode).toBeGreaterThanOrEqual(400);
          expect((await postArchive()).statusCode).toBeGreaterThanOrEqual(400);
          await expect(
            readStoredAttemptEvidenceText(connection, delivery.resultAttemptId),
          ).rejects.toThrow();
        });
        const [after] =
          await connection.execute(sql`SELECT a.evidence_storage_event_id,a.evidence_archive_id,r.current_result_attempt_id
        FROM result_attempts a JOIN results r ON r.id=a.result_id WHERE a.id=${delivery.resultAttemptId}::uuid`);
        expect(after).toMatchObject({
          evidence_storage_event_id: row.event_id,
          evidence_archive_id: row.archive_id,
          current_result_attempt_id: row.selected,
        });
        throw rollback;
      });
      throw new Error("Signed replay fixture missed its rollback sentinel");
    } catch (error) {
      if (error !== rollback) throw error;
    }
  } finally {
    probe.mockRestore();
    manifestVerifier.mockRestore();
    advisory.mockRestore();
    env.mediaDir = mediaDir;
    await rm(localMedia, { recursive: true, force: true });
  }
}
