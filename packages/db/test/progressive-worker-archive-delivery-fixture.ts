import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { EngineClient } from "../../engine-client/src";
import type { DB } from "../src/client";
import { solverEvidenceArtifacts } from "../src/schema";
import {
  signProgressiveEvidenceCustodyReceipt,
  type ProgressiveEvidenceCustodyReceipt,
} from "../src/progressive-evidence-custody";
import { progressiveArchiveManifestBytes } from "./progressive-archive-data";
import { deliverNextProgressiveWorkerArchive } from "../../../apps/sweeper/src/remote-solver";
import {
  claimProgressiveWorkerArchive,
  renewProgressiveWorkerArchiveClaim,
  settleProgressiveWorkerArchiveClaim,
} from "../../../apps/sweeper/src/progressive-worker-archive-delivery";

export async function verifyProgressiveWorkerArchiveDelivery(
  db: DB,
  executionId: string,
) {
  const [originalSettings] = await db.execute(
    sql`SELECT remote_solver_enabled, remote_solver_transfer_paused FROM sync_api_settings WHERE id = 1`,
  );
  const ownedClaims: Awaited<
    ReturnType<typeof claimProgressiveWorkerArchive>
  >[] = [];
  try {
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_enabled = true, remote_solver_transfer_paused = false WHERE id = 1`,
    );
    ownedClaims.push(
      ...(await Promise.all([
        claimProgressiveWorkerArchive(db),
        claimProgressiveWorkerArchive(db),
      ])),
    );
    expect(ownedClaims.filter(Boolean)).toHaveLength(1);
    expect(ownedClaims.find(Boolean)).toMatchObject({ executionId });
  } finally {
    for (const owned of ownedClaims)
      if (owned) {
        await db.execute(sql`DELETE FROM progressive_worker_archive_deliveries WHERE sim_job_id = ${owned.executionId}::uuid
        AND point_content_signature = ${owned.pointContentSignature} AND claim_token = ${owned.token}::uuid`);
      }
    await db.execute(sql`UPDATE sync_api_settings SET remote_solver_enabled = ${originalSettings.remote_solver_enabled},
      remote_solver_transfer_paused = ${originalSettings.remote_solver_transfer_paused} WHERE id = 1`);
  }
  const rollback = new Error("Rollback isolated archive transport fixture");
  const fetcher = vi.spyOn(globalThis, "fetch");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_enabled = false, remote_solver_transfer_paused = false WHERE id = 1`,
      );
      const [source] = await connection.execute(sql`
        SELECT retained.result_attempt_id, retained.receipt, retained.point_content_signature,
          settings.remote_solver_auth_token, settings.remote_solver_registered_id
        FROM progressive_worker_hub_receipts retained JOIN sync_api_settings settings ON settings.id = 1
        WHERE retained.sim_job_id = ${executionId}::uuid LIMIT 1
      `);
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = true WHERE id = 1`,
      );
      expect(await claimProgressiveWorkerArchive(connection)).toBeNull();
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = false, remote_solver_auth_token = '' WHERE id = 1`,
      );
      expect(await claimProgressiveWorkerArchive(connection)).toBeNull();
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_auth_token = ${source.remote_solver_auth_token} WHERE id = 1`,
      );
      const [originalAttempt] = await connection.execute(sql`
        SELECT evidence_payload FROM result_attempts WHERE id = ${source.result_attempt_id}::uuid
      `);
      for (const artifacts of [null, [], [{ kind: "log" }]]) {
        await connection.execute(sql`
          UPDATE result_attempts SET evidence_payload = jsonb_set(evidence_payload, '{evidence_artifacts}', ${JSON.stringify(artifacts)}::jsonb)
          WHERE id = ${source.result_attempt_id}::uuid
        `);
        expect(await claimProgressiveWorkerArchive(connection)).toBeNull();
      }
      await connection.execute(sql`
        UPDATE result_attempts SET evidence_payload = ${JSON.stringify(originalAttempt.evidence_payload)}::jsonb
        WHERE id = ${source.result_attempt_id}::uuid
      `);
      const claim = await claimProgressiveWorkerArchive(connection);
      expect(claim).toMatchObject({
        executionId,
        resultAttemptId: source.result_attempt_id,
      });
      expect(await claimProgressiveWorkerArchive(connection)).toBeNull();
      await expect(
        settleProgressiveWorkerArchiveClaim(connection, claim!),
      ).rejects.toThrow("custody receipt");
      await connection.execute(sql`UPDATE progressive_worker_archive_deliveries SET claim_expires_at = clock_timestamp() - interval '1 second'
        WHERE sim_job_id = ${executionId}::uuid`);
      const replacement = await claimProgressiveWorkerArchive(connection);
      expect(replacement?.token).not.toBe(claim!.token);
      await expect(
        renewProgressiveWorkerArchiveClaim(connection, claim!),
      ).rejects.toThrow("lost its source claim");
      await settleProgressiveWorkerArchiveClaim(
        connection,
        claim!,
        new Error("old failure"),
      );
      await renewProgressiveWorkerArchiveClaim(connection, replacement!);
      await settleProgressiveWorkerArchiveClaim(
        connection,
        replacement!,
        new Error("isolated retry"),
      );
      expect(await claimProgressiveWorkerArchive(connection)).toBeNull();
      const makeDue = () =>
        connection.execute(sql`UPDATE progressive_worker_archive_deliveries
        SET retry_after = clock_timestamp() - interval '1 second' WHERE sim_job_id = ${executionId}::uuid`);
      await makeDue();
      const [manifest] = await connection
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(
              solverEvidenceArtifacts.resultAttemptId,
              String(source.result_attempt_id),
            ),
            eq(solverEvidenceArtifacts.kind, "manifest"),
          ),
        );
      const root = process.env.MEDIA_DIR!;
      expect(
        manifest,
        "The reported manifest must survive exact attempt ingestion",
      ).toBeDefined();
      expect(root).toContain("progressive-worker-media-");
      const manifestPath = join(root, manifest.storageKey);
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, progressiveArchiveManifestBytes);
      const bundleBytes = Buffer.from(
        "isolated transport bytes; GCS verification is a test boundary",
      );
      const bundleHash = createHash("sha256").update(bundleBytes).digest("hex");
      const bundleKey = `archive-transport-${randomUUID()}.tar.zst`;
      await writeFile(join(root, bundleKey), bundleBytes);
      await connection.insert(solverEvidenceArtifacts).values({
        ...manifest,
        id: randomUUID(),
        kind: "engine_bundle",
        storageKey: bundleKey,
        mimeType: "application/zstd",
        sha256: bundleHash,
        byteSize: bundleBytes.byteLength,
        metadata: {
          uncompressedTarSha256: "d".repeat(64),
          uncompressedTarByteSize: 1500,
          zstdLevel: 3,
          bundledFileCount: 1,
          evidenceBase: "isolated-case",
        },
      });
      const uploadId = randomUUID();
      const remote = {
        bucket: "isolated-progressive-worker",
        objectKey: `solver-evidence/v1/sha256/${bundleHash.slice(0, 2)}/${bundleHash}.tar.zst`,
        generation: "9007199254740993123",
        crc32c: "ImIEBA==",
      };
      const capability = `https://storage.googleapis.com/upload/storage/v1/b/${remote.bucket}/o?uploadType=resumable&upload_id=isolated&ifGenerationMatch=0&name=${encodeURIComponent(remote.objectKey)}`;
      let brokerRequest: Record<string, unknown>;
      let brokerVerified = false;
      let rejectReceipt = true;
      const canonical = {
        resultId: (source.receipt as { resultId: string }).resultId,
        resultAttemptId: (source.receipt as { resultAttemptId: string })
          .resultAttemptId,
        artifactId: randomUUID(),
        archiveId: randomUUID(),
      };
      const boundAt = new Date().toISOString();
      const brokerRequests: unknown[] = [];
      const consume = async (body: unknown) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<Buffer | string>)
          chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
      };
      fetcher.mockImplementation(async (input, init) => {
        const url = String(input);
        expect(init?.signal).toBeDefined();
        if (url.endsWith("/evidence-uploads")) {
          brokerRequest = JSON.parse(String(init?.body));
          brokerRequests.push(brokerRequest);
          expect(brokerRequest).toMatchObject({
            engineJobId: executionId,
            remoteResultAttemptId: source.result_attempt_id,
            storedSha256: bundleHash,
            storedByteSize: bundleBytes.byteLength,
          });
          return Response.json(
            brokerVerified
              ? { id: uploadId, state: "verified", remote }
              : {
                  id: uploadId,
                  state: "issued",
                  bucket: remote.bucket,
                  objectKey: remote.objectKey,
                  uploadUrl: capability,
                },
          );
        }
        if (url === capability) {
          expect(init?.method).toBe("PUT");
          expect(
            new Headers(init?.headers).has("x-xfoilfoam-solver-token"),
          ).toBe(false);
          expect(await consume(init?.body)).toEqual(bundleBytes);
          return Response.json({ generation: remote.generation });
        }
        if (url.endsWith(`/evidence-uploads/${uploadId}/verify`)) {
          expect(JSON.parse(String(init?.body))).toEqual({
            generation: remote.generation,
          });
          brokerVerified = true;
          return Response.json({ id: uploadId, state: "verified", remote });
        }
        expect(url.endsWith("/polars")).toBe(true);
        const bytes = await consume(init?.body);
        expect(bytes.byteLength).toBe(
          Number(new Headers(init?.headers).get("content-length")),
        );
        const sections = bytes.toString().split("\r\n\r\n");
        const payload = JSON.parse(sections[1].split("\r\n--")[0]);
        expect(bytes.includes(progressiveArchiveManifestBytes)).toBe(true);
        expect(payload.results).toHaveLength(1);
        expect(payload.results[0]).not.toHaveProperty("cl");
        expect(payload.results[0]).not.toHaveProperty("converged");
        expect(payload.results[0].progressiveArchiveOnly).toBe(true);
        expect(
          payload.results[0].evidenceArtifacts[1].remoteEvidenceUploadId,
        ).toBe(uploadId);
        const receipt: ProgressiveEvidenceCustodyReceipt = {
          schemaVersion: 1,
          kind: "hub-progressive-evidence-custody",
          source: {
            solverId: String(source.remote_solver_registered_id),
            promiseId: payload.promiseId,
            engineJobId: executionId,
            aoaDeg: payload.results[0].aoaDeg,
            engineCaseSlug: payload.results[0].engineCaseSlug,
            remoteResultId: payload.results[0].remoteResultId,
            remoteResultAttemptId: payload.results[0].remoteResultAttemptId,
            progressiveEvidence: payload.results[0].progressiveEvidence,
          },
          brokeredUploadId: uploadId,
          remote: {
            ...remote,
            storedSha256: String(brokerRequest.storedSha256),
            storedByteSize: Number(brokerRequest.storedByteSize),
            tarSha256: String(brokerRequest.tarSha256),
            tarByteSize: Number(brokerRequest.tarByteSize),
            manifestSha256: String(brokerRequest.manifestSha256),
            manifestByteSize: Number(brokerRequest.manifestByteSize),
            zstdLevel: Number(brokerRequest.zstdLevel),
            bundledFileCount: Number(brokerRequest.bundledFileCount),
          },
          canonical,
          boundAt,
        };
        return Response.json({
          fulfilledAoas: [],
          progressiveArchiveReceipts: rejectReceipt
            ? []
            : [
                signProgressiveEvidenceCustodyReceipt(
                  receipt,
                  String(source.remote_solver_auth_token),
                ),
              ],
        });
      });
      const engine = {} as EngineClient;
      expect(
        await deliverNextProgressiveWorkerArchive(connection, engine),
      ).toBe(false);
      const [failed] =
        await connection.execute(sql`SELECT attempt_count, claim_token, retry_after > clock_timestamp() AS delayed,
        last_error FROM progressive_worker_archive_deliveries WHERE sim_job_id = ${executionId}::uuid`);
      expect(failed).toMatchObject({
        attempt_count: 2,
        claim_token: null,
        delayed: true,
        last_error: "Progressive archive import did not return exact custody",
      });
      const calls = fetcher.mock.calls.length;
      expect(
        await deliverNextProgressiveWorkerArchive(connection, engine),
      ).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(calls);
      await makeDue();
      rejectReceipt = false;
      expect(
        await deliverNextProgressiveWorkerArchive(connection, engine),
      ).toBe(true);
      expect(brokerRequests).toHaveLength(2);
      expect(brokerRequests[0]).toEqual(brokerRequests[1]);
      expect(await claimProgressiveWorkerArchive(connection)).toBeNull();
      expect(
        await connection.execute(
          sql`SELECT 1 FROM progressive_worker_archive_deliveries WHERE sim_job_id = ${executionId}::uuid`,
        ),
      ).toHaveLength(0);
      expect(await readFile(join(root, bundleKey))).toEqual(bundleBytes);
      const [state] = await connection.execute(sql`SELECT job.status,
        (SELECT count(*)::integer FROM sync_sweep_promise_points point WHERE point.promise_id::text = job.request_payload->>'syncPromiseId' AND point.status = 'fulfilled') AS fulfilled,
        (SELECT valid_for_polar FROM result_attempts WHERE id = ${source.result_attempt_id}::uuid) AS valid
        FROM sim_jobs job WHERE job.id = ${executionId}::uuid`);
      expect(state).toEqual({
        status: "cancelled",
        fulfilled: 0,
        valid: false,
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    fetcher.mockRestore();
  }
}
