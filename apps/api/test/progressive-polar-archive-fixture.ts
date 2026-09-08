import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import { EngineClient } from "@aerodb/engine-client";
import * as polarCache from "@aerodb/db/polar-cache";
import {
  syncBrokeredEvidenceUploads,
  verifyProgressiveEvidenceCustodyReceipt,
  storeProgressiveRemoteReport,
  type ProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteEvidenceDelivery,
} from "@aerodb/db";
import {
  progressiveArchiveManifestBytes,
  progressiveArchiveManifestSha256,
} from "../../../packages/db/test/progressive-archive-data";
import type { importPolarPush } from "../src/sync-routes";
import { env } from "../src/env";
import { applyProgressiveRemoteProgress } from "../../sweeper/src/progressive-remote-progress";
import { settleProgressiveRemoteJob } from "../../sweeper/src/progressive-remote-settlement";
import { verifyProgressivePublicationPrecedence } from "./progressive-publication-settlement-fixture";

export async function verifyProgressivePolarArchiveImport(input: {
  db: DB;
  app: FastifyInstance;
  token: string;
  payload: Parameters<typeof importPolarPush>[0];
  delivery: ProgressiveRemoteEvidenceDelivery;
  retained: { resultId: string; resultAttemptId: string };
  setConnection: (connection: DB) => void;
}) {
  const originalMediaDir = env.mediaDir;
  const mediaDir = await mkdtemp(join(tmpdir(), "progressive-archive-http-"));
  env.mediaDir = mediaDir;
  const verifier = vi.spyOn(
    EngineClient.prototype,
    "verifyRemoteEvidenceManifest",
  );
  try {
    for (const closed of [false, true]) {
      const rollback = new Error("Rollback isolated HTTP archive fixture");
      try {
        await input.db.transaction(async (transaction) => {
          const connection = transaction as unknown as DB;
          input.setConnection(connection);
          if (closed) {
            await connection.execute(sql`UPDATE sim_campaigns SET status = 'cancelled' WHERE id =
              (SELECT campaign_id FROM sim_jobs WHERE id = ${input.delivery.engineJobId}::uuid)`);
            await connection.execute(sql`UPDATE sync_sweep_promises SET status = 'cancelled', "expiresAt" = clock_timestamp() - interval '1 second'
              WHERE id = ${input.delivery.promiseId}::uuid`);
            await connection.execute(
              sql`UPDATE sync_sweep_promise_points SET status = 'cancelled' WHERE promise_id = ${input.delivery.promiseId}::uuid`,
            );
          }
          const [point] = await connection.execute(
            sql`SELECT id FROM sync_sweep_promise_points WHERE promise_id = ${input.delivery.promiseId}::uuid AND aoa_deg = ${input.delivery.aoaDeg}`,
          );
          const identity = {
            bucket: "isolated-progressive-http",
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
          const uploadId = randomUUID();
          await connection.insert(syncBrokeredEvidenceUploads).values({
            ...identity,
            id: uploadId,
            idempotencyKey: randomUUID(),
            state: "verified",
            verifiedAt: new Date(),
            promiseId: input.delivery.promiseId,
            promisePointId: String(point.id),
            solverId: input.delivery.solverId,
            sourceInstanceId: input.payload.sourceInstanceId!,
            remoteResultId: input.delivery.remoteResultId,
            remoteResultAttemptId: input.delivery.remoteResultAttemptId,
            aoaDeg: input.delivery.aoaDeg,
            engineJobId: input.delivery.engineJobId,
            engineCaseSlug: input.delivery.engineCaseSlug,
          });
          const payload = {
            ...input.payload,
            results: [
              {
                ...input.payload.results[0],
                evidenceArtifacts: [
                  {
                    kind: "manifest",
                    mimeType: "application/json",
                    sha256: identity.manifestSha256,
                    byteSize: identity.manifestByteSize,
                    contentBase64:
                      progressiveArchiveManifestBytes.toString("base64"),
                  },
                  {
                    kind: "engine_bundle",
                    mimeType: "application/zstd",
                    sha256: identity.storedSha256,
                    byteSize: identity.storedByteSize,
                    remoteEvidenceUploadId: uploadId,
                    metadata: {
                      ...identity,
                      storageBackend: "gcs",
                      evidenceBase: "isolated-case",
                      tarByteSize: String(identity.tarByteSize),
                      manifestByteSize: String(identity.manifestByteSize),
                    },
                  },
                ],
              },
            ],
          };
          const post = () =>
            input.app.inject({
              method: "POST",
              url: "/api/sync/v1/polars",
              headers: { "x-xfoilfoam-solver-token": input.token },
              payload,
            });
          const callsBeforeDeniedPush = verifier.mock.calls.length;
          const forbidden = await post();
          expect(forbidden.statusCode, forbidden.body).toBe(403);
          expect(verifier.mock.calls).toHaveLength(callsBeforeDeniedPush);
          await connection.execute(
            sql`UPDATE sync_api_permissions SET can_push = true WHERE data_type = 'evidence_artifacts'`,
          );
          verifier.mockRejectedValueOnce(
            new Error("isolated archive verification failure"),
          );
          const rejected = await post();
          expect(rejected.statusCode, rejected.body).toBe(500);
          const [missing] = await connection.execute(
            sql`SELECT count(*)::integer AS count FROM solver_evidence_archives WHERE result_attempt_id = ${input.retained.resultAttemptId}::uuid`,
          );
          expect(missing.count).toBe(0);
          verifier.mockImplementation(async (request) => {
            expect(request.manifestBase64).toBe(
              progressiveArchiveManifestBytes.toString("base64"),
            );
            expect(request.remote.generation).toBe(identity.generation);
            expect(request.manifestSha256).toBe(identity.manifestSha256);
            expect(request.manifestMemberCount).toBe(2);
            return { ...request, state: "verified" as const };
          });
          const [reported] = await connection.execute(
            sql`SELECT converged FROM result_attempts WHERE id = ${input.retained.resultAttemptId}::uuid`,
          );
          if (reported.converged && !closed) {
            const refresh = vi.spyOn(
              polarCache,
              "refreshPolarCacheForRevision",
            );
            try {
              refresh.mockRejectedValueOnce(
                new Error("isolated interruption after archive binding"),
              );
              const interrupted = await post();
              expect(interrupted.statusCode, interrupted.body).toBe(500);
              expect(refresh).toHaveBeenCalledOnce();
              const [bound] =
                await connection.execute(sql`SELECT upload.state, result.current_result_attempt_id
                FROM sync_brokered_evidence_uploads upload JOIN results result ON result.id = upload.canonical_result_id
                WHERE upload.id = ${uploadId}::uuid`);
              expect(bound).toEqual({
                state: "bound",
                current_result_attempt_id: null,
              });
            } finally {
              refresh.mockRestore();
            }
          }
          const publish = Boolean(reported.converged) && !closed;
          if (publish) {
            const custodyOnly = await input.app.inject({
              method: "POST",
              url: "/api/sync/v1/polars",
              headers: { "x-xfoilfoam-solver-token": input.token },
              payload: {
                ...payload,
                results: [
                  { ...payload.results[0], progressiveArchiveOnly: true },
                ],
              },
            });
            expect(custodyOnly.statusCode, custodyOnly.body).toBe(200);
            expect(custodyOnly.json().fulfilledAoas).toEqual([]);
            expect(custodyOnly.json().bindingReceipts).toEqual([]);
            expect(custodyOnly.json().progressiveArchiveReceipts).toHaveLength(
              1,
            );
            const [unselected] = await connection.execute(
              sql`SELECT current_result_attempt_id FROM results WHERE id = ${input.retained.resultId}::uuid`,
            );
            expect(unselected.current_result_attempt_id).toBeNull();
            const [latest] =
              await connection.execute(sql`SELECT report FROM progressive_remote_reports
              WHERE sim_job_id = ${input.delivery.engineJobId}::uuid ORDER BY sequence DESC LIMIT 1`);
            const terminal = structuredClone(
              latest.report,
            ) as ProgressiveRemoteReport;
            terminal.sequence += 1;
            terminal.status.state = "completed";
            if (terminal.status.solver_budget_progress) {
              terminal.status.solver_budget_progress.observed_at = new Date(
                Date.parse(terminal.status.solver_budget_progress.observed_at) +
                  1,
              ).toISOString();
              for (const progress of terminal.status.solver_budget_progress
                .cases)
                progress.solver_running = false;
            }
            terminal.result!.state = "completed";
            terminal.result!.polars[0].points = [
              ...terminal.result!.polars[0].attempts!,
            ];
            terminal.stopProof = {
              version: 1,
              job_id: input.delivery.engineJobId,
              execution_stopped: true,
              producer_stopped: true,
              namespace_verified: true,
              remaining: [],
              observed_at: "2026-09-07T20:00:00Z",
              error: null,
              fence: "terminal_result",
              ownership_basis: "recorded_execution_namespace",
            };
            await storeProgressiveRemoteReport(connection, {
              executionId: input.delivery.engineJobId,
              solverId: input.delivery.solverId,
              promiseId: input.delivery.promiseId,
              report: terminal,
            });
            for (let sequence = 1; sequence <= terminal.sequence; sequence += 1)
              expect(
                await applyProgressiveRemoteProgress(
                  connection,
                  input.delivery.engineJobId,
                ),
              ).toMatchObject({ kind: "applied", sequence });
            expect(
              await settleProgressiveRemoteJob(
                connection,
                input.delivery.engineJobId,
              ),
            ).toMatchObject({
              kind: "waiting",
              reason: "accepted_point_publication",
            });
            await verifyProgressivePublicationPrecedence(
              connection,
              input.delivery.engineJobId,
              input.retained.resultAttemptId,
            );
          }
          const accepted = await post();
          expect(accepted.statusCode, accepted.body).toBe(200);
          const response = accepted.json();
          expect(response.fulfilledAoas).toEqual(
            publish ? [input.delivery.aoaDeg] : [],
          );
          expect(response.bindingReceipts).toHaveLength(publish ? 1 : 0);
          expect(response.progressiveArchiveReceipts).toHaveLength(1);
          const receipt = verifyProgressiveEvidenceCustodyReceipt(
            response.progressiveArchiveReceipts[0],
            input.token,
            {
              source: input.delivery,
              brokeredUploadId: uploadId,
              remote: identity,
            },
          );
          expect(receipt.canonical).toMatchObject(input.retained);
          const [retained] =
            await connection.execute(sql`SELECT attempt.valid_for_polar, result.current_result_attempt_id,
            (SELECT count(*)::integer FROM solver_evidence_archives archive WHERE archive.result_attempt_id = attempt.id) AS archives
            FROM result_attempts attempt JOIN results result ON result.id = attempt.result_id WHERE attempt.id = ${input.retained.resultAttemptId}::uuid`);
          expect(retained).toEqual({
            valid_for_polar: Boolean(reported.converged),
            current_result_attempt_id: publish
              ? input.retained.resultAttemptId
              : null,
            archives: 1,
          });
          const replay = await post();
          expect(replay.statusCode, replay.body).toBe(200);
          expect(replay.json().progressiveArchiveReceipts).toEqual(
            response.progressiveArchiveReceipts,
          );
          expect(replay.json().fulfilledAoas).toEqual(
            publish ? [input.delivery.aoaDeg] : [],
          );
          if (publish) {
            expect(
              await settleProgressiveRemoteJob(
                connection,
                input.delivery.engineJobId,
              ),
            ).toMatchObject({
              kind: "settled",
              counts: { complete: 1, waiting: 0 },
            });
            const [finished] =
              await connection.execute(sql`SELECT status, "ingestedAt" FROM sim_jobs
              WHERE id = ${input.delivery.engineJobId}::uuid`);
            expect(finished.status).toBe("done");
            expect(finished.ingestedAt).not.toBeNull();
          }
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      } finally {
        input.setConnection(input.db);
      }
    }
  } finally {
    verifier.mockRestore();
    env.mediaDir = originalMediaDir;
    await rm(mediaDir, { recursive: true, force: true });
  }
}
