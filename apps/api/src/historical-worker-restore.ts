import { registeredWorkerArchiveOwner, type DB } from "@aerodb/db";
import { readRegisteredArchive } from "@aerodb/core/registered-archive-read";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { env } from "./env";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const params = z
  .object({
    job: z.string().uuid(),
    sequence: z.coerce.number().int().positive().safe(),
    point: hash,
    generation: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .refine((g) => BigInt(g) <= 18_446_744_073_709_551_615n),
  })
  .strict();
const query = z
  .object({
    report: hash,
    stored: hash,
    manifest: hash,
    directory: z
      .string()
      .regex(/^cases\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/evidence$/),
  })
  .strict();
const digest = (value: string) => createHash("sha256").update(value).digest();

// Only the local HZ engine may ask this adapter to reopen an original. The registered
// upstream bearer is looked up here and can only go to the exact assigned hub.
export function registerHistoricalWorkerRestore(app: FastifyInstance, db: DB) {
  app.get(
    "/internal/historical-raw/:job/:sequence/:point/:generation",
    async (req, reply) => {
      const token = env.engineControlPlaneToken;
      if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" || !token)
        return reply
          .code(403)
          .send({ error: "Historical worker restore is unavailable" });
      if (
        !timingSafeEqual(
          digest(req.headers.authorization ?? ""),
          digest("Bearer " + token),
        )
      )
        return reply.code(401).send({ error: "Engine authorization required" });
      const p = params.safeParse(req.params),
        q = query.safeParse(req.query);
      if (!p.success || !q.success)
        return reply.code(400).send({ error: "Invalid exact worker source" });
      const { job, sequence, point, generation } = p.data;
      try {
        const { baseUrl, authToken, envelope } =
          await registeredWorkerArchiveOwner(db, job);
        const rows = await db.execute<{ byte_size: string | number }>(sql`
        WITH stage AS MATERIALIZED (SELECT DISTINCT a.result_attempt_id FROM progressive_worker_evidence_attempts a
          WHERE a.sim_job_id=${job}::uuid AND a.point_content_signature=${point})
        SELECT b.byte_size FROM stage JOIN result_attempts a ON a.id=stage.result_attempt_id
        JOIN progressive_worker_reports r ON r.sim_job_id=a.sim_job_id AND r.sequence=${sequence}
          AND r.assignment_signature=${envelope.contentSignature} AND r.content_signature=${q.data.report}
          AND r.acknowledged_at IS NOT NULL
        JOIN solver_evidence_artifacts b ON b.result_attempt_id=a.id AND b.engine_job_id=a.engine_job_id
          AND b.engine_case_slug=a.engine_case_slug AND b.kind='engine_bundle' AND b.mime_type='application/zstd'
          AND b.sha256=${q.data.stored}
        JOIN solver_evidence_artifacts mf ON mf.result_attempt_id=a.id AND mf.engine_job_id=a.engine_job_id
          AND mf.engine_case_slug=a.engine_case_slug AND mf.kind='manifest' AND mf.sha256=${q.data.manifest}
          AND mf.storage_key=left(b.storage_key,-length('engine_evidence.tar.zst'))||'evidence_manifest.json'
        WHERE a.sim_job_id=${job}::uuid AND a.engine_job_id=${job} AND (SELECT count(*) FROM stage)=1
          AND b.storage_key='jobs/'||a.engine_job_id||'/'||${q.data.directory}||'/engine_evidence.tar.zst'
          AND b.storage_key='jobs/'||a.engine_job_id||'/cases/'||a.engine_case_slug||'/'||(b.metadata->>'evidenceBase')||'/engine_evidence.tar.zst'
          AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)
        LIMIT 2`);
        if (rows.length !== 1) throw Error("Worker archive ownership conflict");
        const size = Number(rows[0].byte_size);
        const url =
          baseUrl +
          `/progressive-executions/${job}/historical-raw-archives/${sequence}/${point}/generations/${generation}`;
        const response = await readRegisteredArchive(url, authToken, AbortSignal.timeout(20 * 60_000), "application/zstd");
        if (response.status === 503) {
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter && /^[1-9][0-9]{0,4}$/.test(retryAfter)) reply.header("retry-after", retryAfter);
        }
        if (
          !response.ok ||
          !response.body ||
          !Number.isSafeInteger(size) ||
          size <= 0 ||
          response.headers.get("content-length") !== String(size) ||
          response.headers.get("content-type") !== "application/zstd" ||
          response.headers.get("x-content-sha256") !== q.data.stored ||
          response.headers.get("x-gcs-generation") !== generation ||
          response.headers.get("content-encoding")
        ) {
          await response.body?.cancel();
          return reply
            .code(response.status === 503 ? 503 : 409)
            .send({ error: "Pinned source unavailable" });
        }
        return reply
          .header("content-type", "application/zstd")
          .header("content-length", size)
          .header("x-content-sha256", q.data.stored)
          .header("x-gcs-generation", generation)
          .header("cache-control", "private, no-store")
          .send(Readable.fromWeb(response.body));
      } catch {
        return reply
          .code(409)
          .send({ error: "Historical source changed or is unavailable" });
      }
    },
  );
}
