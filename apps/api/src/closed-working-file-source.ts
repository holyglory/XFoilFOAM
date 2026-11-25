import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  registeredWorkerArchiveOwner,
  verifyProgressiveEvidenceCustodyReceipt,
  type DB,
  type ProgressiveEvidenceCustodyReceipt,
} from "@aerodb/db";
import { readRegisteredArchive } from "@aerodb/core/registered-archive-read";
import { env } from "./env";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((g) => BigInt(g) <= (1n << 64n) - 1n);
const segment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/);
const params = z.object({
  job: z.string().uuid(),
  plan: hash,
  inventory: hash,
  caseSlug: segment,
});
const source = z.object({
  upload: z.string().uuid(),
  manifest: hash,
  generation,
  directory: z
    .string()
    .regex(
      /^cases\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\/evidence$/,
    ),
});
type Params = z.infer<typeof params>;
const index = z.object({
  version: z.literal(1),
  plan: hash,
  filesSha256: hash,
  files: z.number().int().positive(),
  bytes: z.number().int().positive().safe(),
  workerInstance: z.string().uuid(),
  assignment: hash,
  sources: z.array(source).nonempty().max(256),
});
const tokensEqual = (a: string, b: string) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );

async function authorizedSources(db: DB, key: Params) {
  const [row] =
    await db.execute(sql`SELECT j.strip_report->'closedWorkingFileRead' AS witness,
      j.strip_report->'closedProgressiveFiles' AS prior
    FROM sim_jobs j JOIN sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
    WHERE j.id=${key.job}::uuid AND j.engine_job_id=j.id::text AND j.stripped_at IS NULL
      AND j.status IN ('done','failed','cancelled') AND p.status IN ('fulfilled','cancelled','expired')
      AND j.strip_report#>>'{closedProgressiveFiles,complete}'='true'
      AND j.strip_report#>>'{closedProgressiveFiles,outcome}'='duplicate-files'
      AND j.strip_report#>>'{closedProgressiveFiles,planSha256}'=${key.plan}
      AND NOT EXISTS(SELECT FROM progressive_historical_raw_archives h WHERE h.sim_job_id=j.id)`);
  if (!row?.witness) return null;
  const manifest = index.parse(row.witness);
  const prior = row.prior as {
    files: number;
    bytes: number;
    verifiedArchives: number;
  };
  const owner = await registeredWorkerArchiveOwner(db, key.job);
  if (
    manifest.plan !== key.plan ||
    manifest.filesSha256 !== key.inventory ||
    prior.files !== manifest.files ||
    prior.bytes !== manifest.bytes ||
    prior.verifiedArchives !== manifest.sources.length ||
    new Set(manifest.sources.map((s) => s.directory)).size !==
      manifest.sources.length ||
    new Set(manifest.sources.map((s) => s.upload)).size !==
      manifest.sources.length ||
    owner.envelope.contentSignature !== manifest.assignment ||
    owner.workerInstance !== manifest.workerInstance
  )
    throw Error("Completed working-file inventory changed");
  return {
    owner,
    sources: manifest.sources.filter(
      (s) => s.directory.split("/")[1] === key.caseSlug,
    ),
  };
}

// Local file-serving engine only. The hub download is the existing exact bound-upload GET.
export function registerClosedWorkingFileSource(app: FastifyInstance, db: DB) {
  const prefix =
    "/internal/closed-working-files/:job/:plan/:inventory/:caseSlug";
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    if (
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" ||
      !env.engineControlPlaneToken
    )
      return reply
        .code(403)
        .send({ error: "Registered worker file reader unavailable" });
    if (
      !tokensEqual(
        req.headers.authorization ?? "",
        "Bearer " + env.engineControlPlaneToken,
      )
    )
      return reply.code(401).send({ error: "Engine authorization required" });
  };
  app.get(prefix, { preHandler: authenticate }, async (req, reply) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success)
      return reply.code(400).send({ error: "Invalid file source identity" });
    try {
      const available = await authorizedSources(db, parsed.data);
      if (!available?.sources.length)
        return reply
          .code(404)
          .send({ error: "No registered working-file source" });
      return reply.header("cache-control", "private, no-store").send({
        job: parsed.data.job,
        plan: parsed.data.plan,
        filesSha256: parsed.data.inventory,
        sources: available.sources,
      });
    } catch {
      return reply
        .code(409)
        .send({ error: "Working-file source identity changed" });
    }
  });
  app.get(
    prefix + "/:upload/:generation",
    { preHandler: authenticate },
    async (req, reply) => {
      const parsed = params
        .extend({ upload: z.string().uuid(), generation })
        .safeParse(req.params);
      if (!parsed.success)
        return reply.code(400).send({ error: "Invalid file archive identity" });
      const key = parsed.data;
      const abort = new AbortController();
      const close = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", close);
      try {
        const available = await authorizedSources(db, key);
        const held = available?.sources.find(
          (s) => s.upload === key.upload && s.generation === key.generation,
        );
        if (!available || !held)
          return reply
            .code(404)
            .send({ error: "No registered working-file archive" });
        const { owner } = available;
        const rows =
          await db.execute(sql`SELECT a.id,a.result_id,a.aoa_deg,ar.receipt,
          ar.point_content_signature,h.receipt AS hub,r.content_signature AS report_signature
        FROM progressive_worker_archive_receipts ar
        JOIN progressive_worker_hub_receipts h USING(sim_job_id,point_content_signature)
        JOIN progressive_worker_archive_reclaims reclaimed USING(sim_job_id,point_content_signature)
        JOIN result_attempts a ON a.id=h.result_attempt_id AND a.sim_job_id=ar.sim_job_id
          AND a.engine_job_id=${key.job} AND a.engine_case_slug=${key.caseSlug}
        JOIN progressive_worker_reports r ON r.sim_job_id=ar.sim_job_id
          AND r.sequence=(ar.receipt#>>'{receipt,source,progressiveEvidence,sequence}')::bigint
          AND r.assignment_signature=${owner.envelope.contentSignature} AND r.acknowledged_at IS NOT NULL
        JOIN solver_evidence_artifacts mf ON mf.result_attempt_id=a.id AND mf.result_id=a.result_id
          AND mf.engine_job_id=${key.job} AND mf.kind='manifest' AND mf.sha256=${held.manifest}
          AND mf.storage_key=${"jobs/" + key.job + "/" + held.directory + "/evidence_manifest.json"}
        WHERE ar.sim_job_id=${key.job}::uuid AND ar.brokered_upload_id=${key.upload}::uuid
          AND reclaimed.completed_at IS NOT NULL AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c
            WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)
        LIMIT 2`);
        if (rows.length !== 1) throw Error("Ambiguous or missing source");
        const r = rows[0];
        const signed = r.receipt as {
          receipt: ProgressiveEvidenceCustodyReceipt;
          receiptHmac: string;
        };
        const bound = verifyProgressiveEvidenceCustodyReceipt(
          signed,
          owner.authToken,
          signed.receipt,
        );
        const remote = bound.remote,
          src = bound.source;
        const hub = r.hub as { resultId: string; resultAttemptId: string };
        if (
          bound.brokeredUploadId !== key.upload ||
          src.solverId !== owner.envelope.solverId ||
          src.promiseId !== owner.envelope.promiseId ||
          src.engineJobId !== key.job ||
          src.engineCaseSlug !== key.caseSlug ||
          src.remoteResultAttemptId !== r.id ||
          src.remoteResultId !== r.result_id ||
          r.aoa_deg == null ||
          src.aoaDeg !== Number(r.aoa_deg) ||
          src.progressiveEvidence.pointContentSignature !==
            r.point_content_signature ||
          src.progressiveEvidence.reportContentSignature !==
            r.report_signature ||
          bound.canonical.resultId !== hub.resultId ||
          bound.canonical.resultAttemptId !== hub.resultAttemptId ||
          remote.generation !== key.generation ||
          remote.manifestSha256 !== held.manifest
        )
          throw Error("Changed working-file archive owner");
        const signal = AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(20 * 60_000),
        ]);
        const control = await readRegisteredArchive(
          owner.baseUrl +
            "/progressive-executions/" +
            key.job +
            "/historical-raw-archives/retention-owner",
          owner.authToken,
          signal,
          "application/json",
        );
        if (
          control.status !== 200 ||
          !control.body ||
          control.headers.get("content-type")?.split(";")[0] !==
            "application/json"
        ) {
          await control.body?.cancel();
          return reply
            .code(control.status === 503 ? 503 : 409)
            .send({ error: "Registered file owner unavailable" });
        }
        const parts: Buffer[] = [];
        let length = 0;
        for await (const chunk of control.body as unknown as AsyncIterable<Uint8Array>) {
          length += chunk.length;
          if (length > 1024) throw Error("Oversized registered owner response");
          parts.push(Buffer.from(chunk));
        }
        const current = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (
          current?.version !== 1 ||
          current.executionId !== key.job ||
          current.solverId !== src.solverId ||
          current.promiseId !== src.promiseId ||
          current.assignmentSignature !== owner.envelope.contentSignature
        )
          throw Error("Registered file owner changed");
        if (current.historicalRaw !== false)
          return reply
            .code(404)
            .send({ error: "Source belongs to a separate registered reader" });
        // The volume restorer rebinds the same terminal and historical owner after the full read.
        if ((req.query as { verifyOwner?: string }).verifyOwner === "1")
          return reply.code(204)
            .header("cache-control", "private, no-store")
            .header("x-content-sha256", remote.storedSha256)
            .header("x-gcs-generation", remote.generation)
            .send();
        const response = await readRegisteredArchive(
          owner.baseUrl + "/evidence-uploads/" + key.upload + "/download",
          owner.authToken,
          signal,
          "application/zstd",
        );
        if (
          response.status !== 200 ||
          !response.body ||
          response.headers.get("content-encoding") ||
          response.headers.get("content-type")?.split(";")[0] !==
            "application/zstd" ||
          response.headers.get("content-length") !==
            String(remote.storedByteSize) ||
          response.headers.get("x-content-sha256") !== remote.storedSha256 ||
          response.headers.get("x-gcs-generation") !== remote.generation
        ) {
          await response.body?.cancel();
          return reply
            .code(response.status === 503 ? 503 : 409)
            .send({ error: "Pinned working-file archive unavailable" });
        }
        return reply
          .header("content-type", "application/zstd")
          .header("cache-control", "private, no-store")
          .header("content-length", remote.storedByteSize)
          .header("x-content-sha256", remote.storedSha256)
          .header("x-gcs-generation", remote.generation)
          .header("x-archive-tar-sha256", remote.tarSha256)
          .header("x-archive-tar-size", String(remote.tarByteSize))
          .header("x-archive-crc32c", remote.crc32c)
          .header(
            "x-archive-locator-sha256",
            createHash("sha256")
              .update(remote.bucket + "\0" + remote.objectKey)
              .digest("hex"),
          )
          .header("x-archive-manifest-sha256", remote.manifestSha256)
          .send(Readable.fromWeb(response.body));
      } catch {
        return reply
          .code(409)
          .send({
            error: "Working-file archive ownership or transport changed",
          });
      }
    },
  );
}
