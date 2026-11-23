import { pinExactGcsGeneration } from "@aerodb/core/gcs-exact-generation";
import {
  manifestMemberSetSha256,
  parseEvidenceManifest,
  type DB,
} from "@aerodb/db";
import type { RemoteEvidencePointerPayload } from "@aerodb/engine-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { makeEngineClient } from "./engine-client";
import { env } from "./env";
import {
  acknowledgeHistoricalRaw,
  checkHistoricalRawOwner,
  readHistoricalRawSource,
  readHistoricalRawRegistration,
  type HistoricalRawOwner,
  type HistoricalRawReference,
  type HistoricalRawSource,
} from "./historical-raw-source";
import {
  brokerArchiveStorage,
  stageBrokerArchive,
} from "./report-archive-broker";

const route =
  "/api/sync/v1/progressive-executions/:executionId/historical-raw-archives/:sequence/:pointSignature";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const params = z
  .object({
    executionId: z.string().uuid(),
    sequence: z.coerce.number().int().positive().safe(),
    pointSignature: digest,
  })
  .strict();
const query = z
  .object({
    reportSignature: digest,
    storedSha256: digest,
    manifestSha256: digest,
  })
  .strict();
const generationSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine((g) => BigInt(g) <= 18_446_744_073_709_551_615n);
const MAX_BUNDLE_BYTES = 1024 ** 3;
const MAX_MANIFEST_BYTES = 8 * 1024 ** 2;
const MAX_BASE64 = 4 * Math.ceil(MAX_MANIFEST_BYTES / 3);
const verifyBody = z
  .object({
    generation: generationSchema,
    manifestBase64: z.string().min(4).max(MAX_BASE64),
  })
  .strict();

function location(ref: HistoricalRawReference) {
  const bucket = env.evidenceBucket;
  if (!bucket || process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub")
    throw new Error("Historical archive storage requires the configured hub");
  return {
    bucket,
    objectKey: `solver-evidence/v1/sha256/${ref.storedSha256.slice(0, 2)}/${ref.storedSha256}.tar.zst`,
  };
}

function metadata(ref: HistoricalRawReference, source: HistoricalRawSource) {
  return {
    "airfoilfoam-schema-version": "1",
    format: "tar+zstd",
    "stored-sha256": ref.storedSha256,
    "stored-size": String(source.storedBytes),
    "tar-sha256": source.tarSha256,
    "tar-size": String(source.tarBytes),
    "zstd-level": String(source.zstdLevel),
    "manifest-sha256": ref.manifestSha256,
    "manifest-size": String(source.manifestBytes),
    "bundled-file-count": String(source.bundledFileCount),
  };
}

async function pinnedPointer(
  ref: HistoricalRawReference,
  source: HistoricalRawSource,
  requested?: string,
): Promise<RemoteEvidencePointerPayload> {
  const loc = location(ref);
  const bucket = brokerArchiveStorage().bucket(loc.bucket);
  const generation = generationSchema.parse(
    requested ?? (await bucket.file(loc.objectKey).getMetadata())[0].generation,
  );
  const [m] = await pinExactGcsGeneration(
    bucket.file(loc.objectKey),
    generation,
  ).getMetadata();
  const expected = metadata(ref, source);
  if (
    m.generation !== generation ||
    Number(m.size) !== source.storedBytes ||
    m.contentType !== "application/zstd" ||
    m.contentEncoding ||
    typeof m.crc32c !== "string" ||
    !/^[A-Za-z0-9+/]{6}==$/.test(m.crc32c) ||
    !m.timeCreated ||
    Object.keys(m.metadata ?? {}).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([k, v]) => m.metadata?.[k] !== v)
  )
    throw new Error("GCS generation differs from the signed raw archive");
  return {
    schemaVersion: 1,
    format: "tar+zstd",
    ...loc,
    generation,
    crc32c: m.crc32c,
    storedSha256: ref.storedSha256,
    storedSize: source.storedBytes,
    tarSha256: source.tarSha256,
    tarSize: source.tarBytes,
    zstdLevel: source.zstdLevel,
    createdAt: new Date(m.timeCreated).toISOString(),
  };
}

// A missing registered generation is an integrity conflict. Only a never-acknowledged
// source can create its first immutable object after a 404.
async function existingHistoricalRawPointer(
  db: DB,
  solver: HistoricalRawOwner,
  ref: HistoricalRawReference,
  source: HistoricalRawSource,
  requested?: string,
) {
  const prior = await readHistoricalRawRegistration(db, solver, ref, source);
  const loc = location(ref);
  if (
    prior &&
    (prior.bucket !== loc.bucket ||
      prior.object_key !== loc.objectKey ||
      (requested !== undefined && requested !== prior.generation))
  )
    throw new Error("Requested historical object differs from its receipt");
  try {
    const pointer = await pinnedPointer(
      ref,
      source,
      prior?.generation ?? requested,
    );
    if (prior && pointer.crc32c !== prior.crc32c)
      throw new Error("Registered historical CRC32C changed");
    return pointer;
  } catch (error) {
    if (
      !prior &&
      requested === undefined &&
      Number((error as { code?: number }).code) === 404
    )
      return null;
    throw error;
  }
}

export async function registerHistoricalRawArchiveRoutes(
  app: FastifyInstance,
  access: {
    db: DB;
    authenticate: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<HistoricalRawOwner | null>;
    permit: (direction: "push") => Promise<boolean>;
  },
) {
  await app.register(async (routes) => {
    routes.addContentTypeParser("application/zstd", (_req, stream, done) =>
      done(null, stream),
    );
    const owners = new WeakMap<FastifyRequest, HistoricalRawOwner>();
    async function guard(req: FastifyRequest, reply: FastifyReply) {
      const solver = await access.authenticate(req, reply);
      if (!solver) return;
      if (
        process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub" ||
        !(await access.permit("push"))
      )
        return reply.code(403).send({
          error: "Historical raw storage is unavailable to this sender",
        });
      owners.set(req, solver);
    }
    function requestRef(req: FastifyRequest) {
      return { ...params.parse(req.params), ...query.parse(req.query) };
    }
    routes.post(route + "/plan", { onRequest: guard }, async (req, reply) => {
      const solver = owners.get(req);
      if (!solver) return;
      try {
        const ref = requestRef(req);
        const source = await readHistoricalRawSource(access.db, solver, ref);
        if (
          source.storedBytes > MAX_BUNDLE_BYTES ||
          source.manifestBytes > MAX_MANIFEST_BYTES
        )
          return reply.code(413).send({
            error:
              "Signed raw source exceeds the historical transfer size limit",
          });
        const pointer = await existingHistoricalRawPointer(
          access.db,
          solver,
          ref,
          source,
        );
        return {
          ...ref,
          ...source,
          generation: pointer?.generation ?? null,
          solverId: solver.id,
          sourceInstanceId: solver.instanceId,
        };
      } catch {
        return reply
          .code(409)
          .send({ error: "Historical raw source or existing object differs" });
      }
    });
    routes.put(
      route,
      { onRequest: guard, bodyLimit: MAX_BUNDLE_BYTES },
      async (req, reply) => {
        const solver = owners.get(req);
        if (!solver) return;
        try {
          const ref = requestRef(req);
          const source = await readHistoricalRawSource(access.db, solver, ref);
          if (
            !(req.body instanceof Readable) ||
            req.headers["content-type"] !== "application/zstd" ||
            req.headers["content-encoding"] ||
            req.headers["content-length"] !== String(source.storedBytes) ||
            source.storedBytes > MAX_BUNDLE_BYTES ||
            source.manifestBytes > MAX_MANIFEST_BYTES
          )
            return reply
              .code(409)
              .send({ error: "Body differs from the bounded signed archive" });
          const local = await stageBrokerArchive(
            req.body,
            { sha256: ref.storedSha256, byteSize: source.storedBytes },
            undefined,
            MAX_BUNDLE_BYTES,
          );
          try {
            await checkHistoricalRawOwner(access.db, solver, ref);
            if (!(await access.permit("push")))
              return reply
                .code(403)
                .send({ error: "Historical archive push disabled" });
            let pointer = await existingHistoricalRawPointer(
              access.db,
              solver,
              ref,
              source,
            );
            if (!pointer) {
              const loc = location(ref);
              try {
                await brokerArchiveStorage()
                  .bucket(loc.bucket)
                  .upload(local.path, {
                    destination: loc.objectKey,
                    resumable: true,
                    validation: "crc32c",
                    preconditionOpts: { ifGenerationMatch: 0 },
                    metadata: {
                      contentType: "application/zstd",
                      metadata: metadata(ref, source),
                    },
                  });
              } catch (error) {
                if (Number((error as { code?: number }).code) !== 412)
                  throw error;
              }
              pointer = await existingHistoricalRawPointer(
                access.db,
                solver,
                ref,
                source,
              );
            }
            if (!pointer || pointer.crc32c !== local.crc32c)
              throw new Error("Cloud CRC32C differs from this full body");
            return {
              state: "stored",
              generation: pointer.generation,
              storedSha256: ref.storedSha256,
            };
          } finally {
            await local.remove();
          }
        } catch {
          return reply.code(409).send({
            error:
              "Historical raw source or storage identity could not be verified",
          });
        }
      },
    );
    routes.post(
      route + "/verify",
      { onRequest: guard, bodyLimit: MAX_BASE64 + 512 },
      async (req, reply) => {
        const solver = owners.get(req);
        if (!solver) return;
        try {
          const ref = requestRef(req);
          const body = verifyBody.parse(req.body);
          const source = await readHistoricalRawSource(access.db, solver, ref);
          if (
            body.manifestBase64.length !==
            4 * Math.ceil(source.manifestBytes / 3)
          )
            throw new Error("Wrong encoded manifest length");
          const manifest = Buffer.from(body.manifestBase64, "base64");
          if (
            manifest.byteLength !== source.manifestBytes ||
            manifest.toString("base64") !== body.manifestBase64 ||
            createHash("sha256").update(manifest).digest("hex") !==
              ref.manifestSha256
          )
            throw new Error("Wrong manifest");
          const parsed = parseEvidenceManifest(manifest);
          if (
            parsed.bundled.length !== source.bundledFileCount ||
            parsed.memberSet.length !== source.bundledFileCount + 1
          )
            throw new Error("Changed manifest member count");
          const memberSet = manifestMemberSetSha256(parsed.memberSet);
          const remote = await existingHistoricalRawPointer(
            access.db,
            solver,
            ref,
            source,
            body.generation,
          );
          if (!remote) throw new Error("Missing historical archive generation");
          // The existing engine client checks the complete echo, including the generation and exact member set.
          await makeEngineClient().verifyRemoteEvidenceManifest({
            remote,
            manifestBase64: body.manifestBase64,
            manifestSha256: ref.manifestSha256,
            manifestByteSize: source.manifestBytes,
            manifestMemberSetSha256: memberSet,
            manifestMemberCount: parsed.memberSet.length,
          });
          if (!(await access.permit("push")))
            return reply
              .code(403)
              .send({ error: "Historical archive push disabled" });
          return await acknowledgeHistoricalRaw(
            access.db,
            solver,
            ref,
            source,
            remote,
            memberSet,
          );
        } catch {
          return reply.code(409).send({
            error:
              "Historical raw custody requires this exact owner, manifest and verified generation",
          });
        }
      },
    );
  });
}
