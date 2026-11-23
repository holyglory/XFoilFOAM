import { pinExactGcsGeneration } from "@aerodb/core/gcs-exact-generation";
import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { env } from "./env";
import { registerRetentionOwnerRead } from "./registered-retention-owner";
import type { HistoricalRawOwner } from "./historical-raw-source";
import {
  brokerArchiveStorage,
  stageBrokerArchive,
} from "./report-archive-broker";

const base =
  "/api/sync/v1/progressive-executions/:executionId/historical-raw-archives";
const key = z
  .object({
    executionId: z.string().uuid(),
    sequence: z.coerce.number().int().positive().safe(),
    pointSignature: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((s) => BigInt(s) <= 18_446_744_073_709_551_615n),
  })
  .strict();
type Ref = z.infer<typeof key>;

async function owned(
  db: DB,
  solver: HistoricalRawOwner,
  job: string,
  ref?: Ref,
) {
  // As with the bound evidence-upload download, only the original registered sender
  // can reopen its own receipt. This grants no catalogue fetch or scientific receipt.
  return Array.from(
    await db.execute<{ receipt: Record<string, unknown> }>(sql`
    SELECT to_jsonb(c) AS receipt FROM progressive_historical_raw_archives c
    JOIN registered_remote_solvers s ON s.id=c.solver_id AND s.instance_id=c.source_instance_id
      AND s.revoked_at IS NULL AND s.auth_token_hash=${solver.authTokenHash}
    JOIN progressive_remote_dispatches d ON d.sim_job_id=c.sim_job_id AND d.solver_id=c.solver_id
      AND d.promise_id=c.promise_id AND d.content_signature=c.assignment_signature
    JOIN progressive_remote_reports r ON (r.sim_job_id,r.sequence,r.content_signature)
      =(c.sim_job_id,c.sequence,c.report_signature)
    JOIN progressive_remote_report_sources p ON (p.sim_job_id,p.sequence,p.point_content_signature)
      =(c.sim_job_id,c.sequence,c.point_content_signature)
    JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id=c.sim_job_id AND stop.engine_job_id=c.sim_job_id::text
      AND stop.proof_signature=c.stop_signature
    WHERE c.sim_job_id=${job}::uuid AND c.solver_id=${solver.id}::uuid AND c.source_instance_id=${solver.instanceId}
      ${ref ? sql`AND c.sequence=${ref.sequence} AND c.point_content_signature=${ref.pointSignature} AND c.generation=${ref.generation}` : sql``}
    ORDER BY c.sequence,c.point_content_signature LIMIT 257`),
  ).map((r) => r.receipt);
}

export async function registerHistoricalRawDownloads(
  app: FastifyInstance,
  db: DB,
  authenticate: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<HistoricalRawOwner | null>,
) {
  async function principal(req: FastifyRequest, reply: FastifyReply) {
    const p = await authenticate(req, reply);
    if (p && process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub") {
      await reply
        .code(403)
        .send({ error: "Historical custody is served by its hub" });
      return null;
    }
    return p;
  }
  registerRetentionOwnerRead(app, db, principal);
  app.get(base + "/receipts", async (req, reply) => {
    const solver = await principal(req, reply);
    if (!solver) return;
    const parsed = z
      .object({ executionId: z.string().uuid() })
      .safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid job" });
    const rows = await owned(db, solver, parsed.data.executionId);
    if (!rows.length || rows.length > 256)
      return reply
        .code(409)
        .send({ error: "Complete registered historical custody unavailable" });
    return { receipts: rows };
  });
  app.get(
    base + "/:sequence/:pointSignature/generations/:generation",
    async (req, reply) => {
      const solver = await principal(req, reply);
      if (!solver) return;
      const params = key.safeParse(req.params);
      if (!params.success || Object.keys(req.query as object).length)
        return reply
          .code(400)
          .send({ error: "Invalid historical archive reference" });
      const ref = params.data;
      const absent = () =>
        reply
          .code(409)
          .send({
            error: "Exact registered historical archive is unavailable",
          });
      try {
        const [row] = await owned(db, solver, ref.executionId, ref);
        if (!row || !env.evidenceBucket || row.bucket !== env.evidenceBucket)
          return absent();
        const sha = String(row.stored_sha256),
          bytes = Number(row.stored_bytes),
          crc = String(row.crc32c);
        const objectKey = `solver-evidence/v1/sha256/${sha.slice(0, 2)}/${sha}.tar.zst`;
        if (
          !/^[0-9a-f]{64}$/.test(sha) ||
          !Number.isSafeInteger(bytes) ||
          bytes <= 0 ||
          bytes > 1024 ** 3 ||
          row.object_key !== objectKey ||
          !/^[A-Za-z0-9+/]{6}==$/.test(crc)
        )
          return absent();
        const file = pinExactGcsGeneration(
          brokerArchiveStorage()
            .bucket(env.evidenceBucket)
            .file(objectKey, { generation: ref.generation }),
          ref.generation,
        );
        const [m] = await file.getMetadata();
        const expected = {
          "airfoilfoam-schema-version": "1",
          format: "tar+zstd",
          "stored-sha256": sha,
          "stored-size": String(bytes),
          "tar-sha256": row.tar_sha256,
          "tar-size": String(row.tar_bytes),
          "manifest-sha256": row.manifest_sha256,
          "manifest-size": String(row.manifest_bytes),
          "zstd-level": String(row.zstd_level),
          "bundled-file-count": String(row.bundled_file_count),
        };
        if (
          m.generation !== ref.generation ||
          m.crc32c !== crc ||
          Number(m.size) !== bytes ||
          m.contentType !== "application/zstd" ||
          m.contentEncoding ||
          Object.keys(m.metadata ?? {}).length !==
            Object.keys(expected).length ||
          Object.entries(expected).some(([k, v]) => m.metadata?.[k] !== v)
        )
          return absent();
        const local = await stageBrokerArchive(
          file.createReadStream({ validation: "crc32c", decompress: false }),
          { sha256: sha, byteSize: bytes },
          crc,
          1024 ** 3,
        );
        try {
          if (
            !(await owned(db, solver, ref.executionId, ref)).length ||
            reply.raw.destroyed
          ) {
            await local.remove();
            return absent();
          }
          const body = createReadStream(local.path);
          const disconnected = () => {
            body.destroy();
          };
          reply.raw.once("close", disconnected);
          body.once("close", () => {
            reply.raw.off("close", disconnected);
            void local.remove().catch(() => {});
          });
          return reply
            .header("content-type", "application/zstd")
            .header("content-length", bytes)
            .header("x-content-sha256", sha)
            .header("x-gcs-generation", ref.generation)
            .header("cache-control", "private, no-store")
            .send(body);
        } catch (error) {
          await local.remove();
          throw error;
        }
      } catch {
        return absent();
      }
    },
  );
}
