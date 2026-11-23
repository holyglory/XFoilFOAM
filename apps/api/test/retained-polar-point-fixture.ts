import { CRC32C, Storage } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { expect, vi } from "vitest";
import type { DB } from "@aerodb/db/client";
import { verifyProgressiveReportArchive } from "@aerodb/db/progressive-report-archive";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import type { ProgressiveRemoteEvidenceDelivery } from "@aerodb/db/progressive-remote-evidence-receipts";
import { settleProgressiveRemoteJob } from "../../sweeper/src/progressive-remote-settlement";
import { archiveProgressiveReportBatch } from "../../sweeper/src/progressive-report-archive-service";
import { SettlementGcs } from "../../sweeper/test-support/attempt-settlement-fixture";
import { env } from "../src/env";
import * as reportObject from "../src/progressive-report-archive-reader";

export async function verifyOriginalPointReceiptReturn(
  db: DB,
  app: FastifyInstance,
  token: string,
  sourceInstanceId: string,
  delivery: ProgressiveRemoteEvidenceDelivery,
  setConnection: (db: DB) => void,
) {
  const rollback = new Error("Rollback closed point receipt fixture"),
    store = new SettlementGcs();
  const priorBucket = env.evidenceBucket,
    role = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  const bucket = "closed-point-fixture";
  const transport = vi
    .spyOn(Storage.prototype, "bucket")
    .mockImplementation((b) => {
      expect(b).toBe(bucket);
      return store.bucket(b) as unknown as ReturnType<Storage["bucket"]>;
    });
  let fullReads = 0;
  try {
    env.evidenceBucket = bucket;
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    await expect(
      db.transaction(async (tx) => {
        const conn = tx as unknown as DB;
        setConnection(conn);
        const job = delivery.engineJobId;
        await conn.execute(
          sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${delivery.promiseId}::uuid`,
        );
        await conn.execute(
          sql`UPDATE sync_sweep_promise_points SET status='cancelled' WHERE promise_id=${delivery.promiseId}::uuid`,
        );
        expect(await settleProgressiveRemoteJob(conn, job)).toMatchObject({
          kind: "settled",
        });
        const [original] =
          await conn.execute(sql`SELECT e.result_attempt_id,a.result_id,e.received_at FROM progressive_remote_evidence_receipts e
        JOIN result_attempts a ON a.id=e.result_attempt_id WHERE e.sim_job_id=${job}::uuid AND e.point_content_signature=${delivery.progressiveEvidence.pointContentSignature}`);
        expect(original).toBeDefined();
        const archived = await archiveProgressiveReportBatch(
          conn,
          "remote",
          job,
          async (path, local) => {
            const bytes = await readFile(path),
              crc = new CRC32C();
            crc.update(bytes);
            const objectKey = `progressive-reports/v1/remote/${job}/${local.sha256}.jsonl.gz`;
            const proof = {
              bucket,
              objectKey,
              generation: "18446744073709551615",
              mimeType: "application/gzip" as const,
              compression: "gzip" as const,
              archiveFormat: "jsonl" as const,
              storedSha256: local.sha256,
              storedByteSize: local.byteSize,
              crc32c: crc.toString(),
              verifiedAt: new Date(),
            };
            await verifyProgressiveReportArchive(Readable.from([bytes]), proof);
            store.objects.set(bucket + "/" + objectKey, {
              bytes,
              metadata: {
                generation: proof.generation,
                contentType: proof.mimeType,
                crc32c: proof.crc32c,
                size: String(bytes.length),
                metadata: {
                  sha256: local.sha256,
                  byteSize: String(bytes.length),
                },
              },
            });
            return proof;
          },
        );
        expect(archived).toBeGreaterThan(0);
        const [report] = await conn.execute(
          sql`SELECT archive_bundle_id FROM progressive_remote_reports WHERE sim_job_id=${job}::uuid AND sequence=${delivery.progressiveEvidence.sequence}`,
        );
        expect(report.archive_bundle_id).toBeTruthy();
        installProgressiveReportArchiveReader({
          read: async () => {
            fullReads++;
            throw new Error("Test refused complete report inflation");
          },
        });
        const {
          aoaDeg,
          engineJobId,
          engineCaseSlug,
          remoteResultId,
          remoteResultAttemptId,
          progressiveEvidence,
        } = delivery;
        const send = () =>
          app.inject({
            method: "POST",
            url: "/api/sync/v1/polars",
            headers: { "x-xfoilfoam-solver-token": token },
            payload: {
              promiseId: delivery.promiseId,
              sourceInstanceId,
              results: [
                {
                  aoaDeg,
                  engineJobId,
                  engineCaseSlug,
                  remoteResultId,
                  remoteResultAttemptId,
                  progressiveEvidence,
                },
              ],
            },
          });
        const recovered = await send();
        expect(recovered.statusCode, recovered.body).toBe(200);
        expect(recovered.json()).toMatchObject({
          attempts: 0,
          imported: 0,
          artifacts: 0,
          media: 0,
          conflictIds: [],
          fulfilledAoas: [],
          progressiveArchiveReceipts: [],
          progressiveEvidenceReceipts: [
            {
              resultId: original.result_id,
              resultAttemptId: original.result_attempt_id,
              remoteResultAttemptId,
              sequence: progressiveEvidence.sequence,
              receivedAt: new Date(String(original.received_at)).toISOString(),
            },
          ],
        });
        expect(fullReads).toBe(0);
        expect(transport).toHaveBeenCalled();
        const check = reportObject.verifyRetainedReportGeneration;
        const revoked = vi
          .spyOn(reportObject, "verifyRetainedReportGeneration")
          .mockImplementationOnce(async (ref) => {
            await check(ref);
            await conn.execute(
              sql`UPDATE registered_remote_solvers SET revoked_at=clock_timestamp() WHERE id=${delivery.solverId}::uuid`,
            );
          });
        try {
          const denied = await send();
          expect(denied.statusCode, denied.body).toBe(409);
          expect(denied.json().progressiveEvidenceReceipts).toBeUndefined();
          expect(fullReads).toBe(0);
        } finally {
          revoked.mockRestore();
          await conn.execute(
            sql`UPDATE registered_remote_solvers SET revoked_at=NULL WHERE id=${delivery.solverId}::uuid`,
          );
        }
        store.failReads = true;
        const corrupt = await send();
        expect(corrupt.statusCode, corrupt.body).toBeGreaterThanOrEqual(400);
        expect(corrupt.json().progressiveEvidenceReceipts).toBeUndefined();
        expect(fullReads).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    installProgressiveReportArchiveReader(null);
    transport.mockRestore();
    env.evidenceBucket = priorBucket;
    if (role === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = role;
    setConnection(db);
  }
}
