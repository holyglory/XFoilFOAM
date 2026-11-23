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
import {
  verifyProgressiveEvidenceCustodyReceipt,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db/progressive-evidence-custody";
import { verifyProgressiveRemoteExecution } from "@aerodb/db/progressive-remote-execution";
import { progressiveReportedPointSources } from "@aerodb/db/progressive-remote-report";
import { projectSignedProgressivePoint } from "@aerodb/db/progressive-remote-point-projection";
import { periodicPoint } from "../../../packages/db/test-support/periodic-urans-point";
import { recoverOriginalSignedPoint } from "../src/retained-polar-point";
import * as reportObject from "../src/progressive-report-archive-reader";

export async function verifyOriginalPointReceiptReturn(
  db: DB,
  app: FastifyInstance,
  token: string,
  sourceInstanceId: string,
  delivery: ProgressiveRemoteEvidenceDelivery,
  setConnection: (db: DB) => void,
  archive: Pick<
    ProgressiveEvidenceCustodyReceipt,
    "brokeredUploadId" | "remote"
  >,
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
        const readCustody = () =>
          app.inject({
            method: "POST",
            url: `/api/sync/v1/evidence-uploads/${archive.brokeredUploadId}/custody`,
            headers: { "x-xfoilfoam-solver-token": token },
            payload: {},
          });
        const owned = await readCustody();
        expect(owned.statusCode, owned.body).toBe(200);
        const signed = verifyProgressiveEvidenceCustodyReceipt(
          owned.json().progressiveArchiveReceipt,
          token,
          { source: delivery, ...archive },
        );
        expect(signed.canonical.resultAttemptId).toBe(
          original.result_attempt_id,
        );
        expect(fullReads).toBe(0);

        // A normalized missing-frame sentinel is reversible only when the original
        // null reproduces the complete point signature in its signed physical polar.
        const [assigned] = await conn.execute(
          sql`SELECT envelope,content_signature FROM progressive_remote_dispatches WHERE sim_job_id=${job}::uuid`,
        );
        const envelope = verifyProgressiveRemoteExecution(assigned.envelope, {
          executionId: job,
          solverId: delivery.solverId,
          promiseId: delivery.promiseId,
          contentSignature: String(assigned.content_signature),
        });
        const rawPoint = {
          ...periodicPoint(aoaDeg, 2, false),
          frame_track: null,
          steady_history: null,
          quality_warnings: [],
          error: null,
          fidelity: "urans_full" as const,
          engine: {
            ...envelope.request.expected_engine!,
            build_id: "original-null-frame",
          },
        };
        const polar = {
          speed: envelope.request.speeds![0]!,
          chord: envelope.request.chord_lengths![0]!,
          reynolds:
            (envelope.request.speeds![0]! *
              envelope.request.chord_lengths![0]!) /
            envelope.request.fluid!.kinematic_viscosity!,
          points: [rawPoint],
        };
        const [witness] = progressiveReportedPointSources({
          job_id: job,
          state: "running",
          polars: [polar],
        });
        const projection = projectSignedProgressivePoint(
          rawPoint,
          polar,
          envelope,
          rawPoint.engine,
          envelope.request.expected_mesh_recovery_version,
        );
        expect(projection.evidencePayload.frame_track).toMatchObject({
          missing: true,
        });
        expect(
          recoverOriginalSignedPoint(
            projection.evidencePayload,
            envelope,
            witness!.contentSignature,
          )?.point,
        ).toEqual(rawPoint);
        expect(
          recoverOriginalSignedPoint(
            { ...projection.evidencePayload, cl: 47 },
            envelope,
            witness!.contentSignature,
          ),
        ).toBeNull();
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
        const badCustody = await readCustody();
        expect(badCustody.statusCode).toBe(409);
        expect(badCustody.json().progressiveArchiveReceipt).toBeUndefined();
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
