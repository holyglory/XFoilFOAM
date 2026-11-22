import { CRC32C, Storage, type Bucket, type File } from "@google-cloud/storage";
import { pinExactGcsGeneration } from "@aerodb/core/gcs-exact-generation";
import type { DB } from "@aerodb/db";
import {
  canonicalReportJson,
  visitProgressiveReportArchive,
} from "@aerodb/db/progressive-report-archive";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldToRequests } from "node:timers/promises";
import { z } from "zod";
import { env } from "./env";

// A page may contain reports and their conflict copies. No whole-execution
// uniqueness or active scheduling lease is required for historical custody.
const MAX_STORED_BYTES = 256 * 1024 ** 2;
const MAX_JSON_BYTES = 512 * 1024 ** 2;
const MAX_LINE_BYTES = 64 * 1024 ** 2;
const MAX_MEMBERS = 256;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC = /^[A-Za-z0-9+/]{6}==$/;
const ROUTE =
  "/api/sync/v1/progressive-executions/:executionId/report-archives/:sha256";

type Solver = { id: string; instanceId: string };
type Dispatch = { promiseId: string; assignmentSignature: string };
type LocalIdentity = { sha256: string; byteSize: number };

export interface WorkerReportArchiveIdentity {
  bucket: string;
  objectKey: string;
  generation: string;
  mimeType: string;
  compression: "gzip";
  archiveFormat: "jsonl";
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  verifiedAt: Date;
}

export class ReportArchiveBrokerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function reject(message: string, status = 409): never {
  throw new ReportArchiveBrokerError(status, message);
}

function assertLocalIdentity(
  executionId: string,
  identity: LocalIdentity,
): void {
  if (
    !UUID.test(executionId) ||
    !SHA256.test(identity.sha256) ||
    !Number.isSafeInteger(identity.byteSize) ||
    identity.byteSize <= 0
  )
    reject("Invalid worker report archive identity", 400);
  if (identity.byteSize > MAX_STORED_BYTES)
    reject("Worker report archive page exceeds the byte limit", 413);
}

function objectScope(executionId: string, sha256: string) {
  const bucket = env.evidenceBucket?.trim();
  const prefix = (
    process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ?? "progressive-reports/v1"
  ).replace(/^\/+|\/+$/g, "");
  if (
    !bucket ||
    !/^[A-Za-z0-9_./-]+$/.test(prefix) ||
    prefix.split("/").some((part) => !part || part === "." || part === "..")
  )
    reject("Worker report archive storage is not configured", 503);
  return {
    bucket,
    objectKey: `${prefix}/worker/${executionId}/${sha256}.jsonl.gz`,
  };
}

async function ownedDispatch(
  db: DB,
  solver: Solver,
  executionId: string,
): Promise<Dispatch> {
  // security-assumptions.md: a closed promise stays closed. This query only
  // authenticates the immutable dispatch; it never renews or fulfills work.
  const [row] = await db.execute(sql`
    SELECT dispatch.promise_id, dispatch.content_signature
    FROM progressive_remote_dispatches dispatch
    JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id
    WHERE dispatch.sim_job_id = ${executionId}::uuid
      AND dispatch.solver_id = ${solver.id}::uuid
      AND solver.instance_id = ${solver.instanceId} AND solver.revoked_at IS NULL
  `);
  if (!row) reject("Remote solver does not own this execution", 403);
  return {
    promiseId: String(row.promise_id),
    assignmentSignature: String(row.content_signature),
  };
}

async function inspectBundle(
  path: string,
  identity: WorkerReportArchiveIdentity,
  solver: Solver,
  executionId: string,
  dispatch: Dispatch,
) {
  await visitProgressiveReportArchive(
    createReadStream(path),
    identity,
    async (entry, _line, report) => {
      // The shared decoder already parsed these exact PG bytes losslessly.
      // Verify the dispatch and canonical signature for every reconstructed member.
      if (
        entry.sourceKind !== "worker" ||
        entry.executionId !== executionId ||
        canonicalReportJson(report.version!) !== "1" ||
        report.executionId !== executionId ||
        report.solverId !== solver.id ||
        report.promiseId !== dispatch.promiseId ||
        report.assignmentSignature !== dispatch.assignmentSignature ||
        canonicalReportJson(report.sequence!) !== String(entry.sequence) ||
        createHash("sha256")
          .update(canonicalReportJson(report))
          .digest("hex") !== entry.contentSignature
      )
        reject(
          "Worker report archive member changed the exact dispatch scope or content",
        );
      // Small encoded deltas can expand into many full reports in one zlib
      // chunk. Yield to socket callbacks between members under sustained CPU work.
      await yieldToRequests();
    },
    {
      maxMembers: MAX_MEMBERS,
      maxDecodedBytes: MAX_JSON_BYTES,
      maxReportBytes: MAX_LINE_BYTES,
    },
  );
}

async function stage(
  source: Readable,
  identity: LocalIdentity,
  expectedCrc?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "worker-report-broker-"));
  const path = join(directory, "bundle.jsonl.gz");
  const remove = () => rm(directory, { recursive: true, force: true });
  const hash = createHash("sha256");
  const crc = new CRC32C();
  let size = 0;
  try {
    await pipeline(
      source,
      new Transform({
        transform(raw: Buffer, _encoding, callback) {
          size += raw.byteLength;
          if (size > identity.byteSize || size > MAX_STORED_BYTES)
            return callback(
              new ReportArchiveBrokerError(
                413,
                "Worker report archive exceeds its declared byte size",
              ),
            );
          hash.update(raw);
          crc.update(raw);
          callback(null, raw);
        },
      }),
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    if (
      size !== identity.byteSize ||
      hash.digest("hex") !== identity.sha256 ||
      (expectedCrc !== undefined && crc.toString() !== expectedCrc)
    )
      reject(
        "Worker report archive failed exact SHA-256, size or CRC32C verification",
      );
    return { path, remove, crc32c: crc.toString() };
  } catch (error) {
    await remove();
    throw error;
  }
}

let storage: Storage | undefined;
function storageClient() {
  // Only the hub resolves server-side credentials. Workers receive an archive
  // identity, never a credential, bearer capability, or caller-chosen object.
  return (storage ??= new Storage());
}

function generationPinnedFile(
  bucket: Bucket,
  objectKey: string,
  generation: string,
): File {
  return pinExactGcsGeneration(
    bucket.file(objectKey, { generation }),
    generation,
  );
}

async function exactFile(
  solver: Solver,
  executionId: string,
  identity: LocalIdentity,
  generation?: string,
  crc32c?: string,
): Promise<{ file: File; identity: WorkerReportArchiveIdentity }> {
  const scope = objectScope(executionId, identity.sha256);
  const bucket = storageClient().bucket(scope.bucket);
  const initialFile = generation
    ? generationPinnedFile(bucket, scope.objectKey, generation)
    : bucket.file(scope.objectKey);
  const [initial] = await initialFile.getMetadata();
  const pinned = String(initial.generation ?? "");
  if (
    !GENERATION.test(pinned) ||
    BigInt(pinned) > 18_446_744_073_709_551_615n ||
    (generation !== undefined && pinned !== generation)
  )
    reject("Worker report archive generation changed");
  const file = generationPinnedFile(bucket, scope.objectKey, pinned);
  const [metadata] = await file.getMetadata();
  const custom = metadata.metadata ?? {};
  if (
    String(metadata.generation) !== pinned ||
    Number(metadata.size) !== identity.byteSize ||
    metadata.contentType !== "application/gzip" ||
    metadata.contentEncoding ||
    !CRC.test(String(metadata.crc32c ?? "")) ||
    (crc32c !== undefined && metadata.crc32c !== crc32c) ||
    custom.sha256 !== identity.sha256 ||
    custom.byteSize !== String(identity.byteSize) ||
    custom.sourceKind !== "worker" ||
    custom.executionId !== executionId ||
    custom.solverId !== solver.id ||
    custom.sourceInstanceId !== solver.instanceId ||
    custom.archiveFormat !== "jsonl"
  )
    reject("Worker report archive immutable metadata changed");
  return {
    file,
    identity: {
      ...scope,
      generation: pinned,
      mimeType: "application/gzip",
      compression: "gzip",
      archiveFormat: "jsonl",
      storedSha256: identity.sha256,
      storedByteSize: identity.byteSize,
      crc32c: String(metadata.crc32c),
      verifiedAt: new Date(),
    },
  };
}

export async function putBrokeredWorkerReportBundle(
  db: DB,
  solver: Solver,
  executionId: string,
  identity: LocalIdentity,
  body: Readable,
): Promise<WorkerReportArchiveIdentity> {
  assertLocalIdentity(executionId, identity);
  const dispatch = await ownedDispatch(db, solver, executionId);
  const scope = objectScope(executionId, identity.sha256);
  const local = await stage(body, identity);
  try {
    await inspectBundle(
      local.path,
      {
        ...scope,
        generation: "1",
        mimeType: "application/gzip",
        compression: "gzip",
        archiveFormat: "jsonl",
        storedSha256: identity.sha256,
        storedByteSize: identity.byteSize,
        crc32c: local.crc32c,
        verifiedAt: new Date(),
      },
      solver,
      executionId,
      dispatch,
    );
    try {
      await storageClient()
        .bucket(scope.bucket)
        .upload(local.path, {
          destination: scope.objectKey,
          resumable: true,
          validation: "crc32c",
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: "application/gzip",
            cacheControl: "private, max-age=31536000, immutable",
            metadata: {
              sha256: identity.sha256,
              byteSize: String(identity.byteSize),
              sourceKind: "worker",
              executionId,
              solverId: solver.id,
              sourceInstanceId: solver.instanceId,
              archiveFormat: "jsonl",
            },
          },
        });
    } catch (error) {
      if (Number((error as { code?: unknown })?.code) !== 412) throw error;
    }
    const remote = await exactFile(
      solver,
      executionId,
      identity,
      undefined,
      local.crc32c,
    );
    const proof = await stage(
      remote.file.createReadStream({ validation: "crc32c", decompress: false }),
      identity,
      remote.identity.crc32c,
    );
    await proof.remove();
    await ownedDispatch(db, solver, executionId);
    return { ...remote.identity, verifiedAt: new Date() };
  } finally {
    await local.remove();
  }
}

export async function restoreBrokeredWorkerReportBundle(
  db: DB,
  solver: Solver,
  executionId: string,
  identity: LocalIdentity,
  generation: string,
  crc32c: string,
) {
  assertLocalIdentity(executionId, identity);
  if (
    !GENERATION.test(generation) ||
    BigInt(generation) > 18_446_744_073_709_551_615n ||
    !CRC.test(crc32c)
  )
    reject("Invalid worker report archive generation or CRC32C", 400);
  const dispatch = await ownedDispatch(db, solver, executionId);
  const remote = await exactFile(
    solver,
    executionId,
    identity,
    generation,
    crc32c,
  );
  const restored = await stage(
    remote.file.createReadStream({ validation: "crc32c", decompress: false }),
    identity,
    crc32c,
  );
  try {
    await inspectBundle(
      restored.path,
      remote.identity,
      solver,
      executionId,
      dispatch,
    );
    await ownedDispatch(db, solver, executionId);
    return { ...restored, identity: remote.identity };
  } catch (error) {
    await restored.remove();
    throw error;
  }
}

export async function registerReportArchiveBrokerRoutes(
  app: FastifyInstance,
  options: {
    db: DB;
    authenticate: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<Solver | null>;
    permit: (direction: "push" | "fetch") => Promise<boolean>;
  },
): Promise<void> {
  await app.register(async (routes) => {
    routes.addContentTypeParser("application/gzip", (_req, stream, done) =>
      done(null, stream),
    );
    const owners = new WeakMap<FastifyRequest, Solver>();
    const guard =
      (direction: "push" | "fetch") =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const solver = await options.authenticate(req, reply);
        if (!solver) return;
        if (!(await options.permit(direction)))
          return reply
            .code(403)
            .send({ error: `${direction} disabled for evidence_artifacts` });
        owners.set(req, solver);
      };
    const paramsSchema = z
      .object({
        executionId: z.string().uuid(),
        sha256: z.string().regex(SHA256),
      })
      .strict();
    const sizeSchema = z.coerce.number().int().positive().max(MAX_STORED_BYTES);
    const failure = (reply: FastifyReply, error: unknown) => {
      if (error instanceof ReportArchiveBrokerError)
        return reply.code(error.statusCode).send({ error: error.message });
      // Storage errors can contain credential material or upstream URLs.
      return reply.code(409).send({
        error: "Worker report archive transfer or verification failed",
      });
    };
    routes.post(
      ROUTE,
      { bodyLimit: MAX_STORED_BYTES, onRequest: guard("push") },
      async (req, reply) => {
        const solver = owners.get(req);
        if (!solver) return;
        const params = paramsSchema.safeParse(req.params);
        const query = z
          .object({ byteSize: sizeSchema })
          .strict()
          .safeParse(req.query);
        if (
          !params.success ||
          !query.success ||
          !(req.body instanceof Readable) ||
          req.headers["content-length"] !== String(query.data.byteSize) ||
          req.headers["content-encoding"]
        )
          return reply
            .code(400)
            .send({ error: "Invalid bounded worker report archive upload" });
        try {
          return await putBrokeredWorkerReportBundle(
            options.db,
            solver,
            params.data.executionId,
            { sha256: params.data.sha256, byteSize: query.data.byteSize },
            req.body,
          );
        } catch (error) {
          return failure(reply, error);
        }
      },
    );
    routes.get(ROUTE, { onRequest: guard("fetch") }, async (req, reply) => {
      const solver = owners.get(req);
      if (!solver) return;
      const params = paramsSchema.safeParse(req.params);
      const query = z
        .object({
          byteSize: sizeSchema,
          generation: z.string().regex(GENERATION),
          crc32c: z.string().regex(CRC),
        })
        .strict()
        .safeParse(req.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({ error: "Invalid exact worker report archive restore" });
      try {
        const restored = await restoreBrokeredWorkerReportBundle(
          options.db,
          solver,
          params.data.executionId,
          { sha256: params.data.sha256, byteSize: query.data.byteSize },
          query.data.generation,
          query.data.crc32c,
        );
        const body = createReadStream(restored.path);
        const disconnected = () => body.destroy();
        reply.raw.once("close", disconnected);
        body.once("close", () => {
          reply.raw.removeListener("close", disconnected);
          void restored.remove().catch(() => {
            req.log.error("Worker report archive scratch cleanup failed");
          });
        });
        return reply
          .header("content-type", restored.identity.mimeType)
          .header("content-length", String(restored.identity.storedByteSize))
          .header("x-content-sha256", restored.identity.storedSha256)
          .header("x-content-crc32c", restored.identity.crc32c)
          .header("x-gcs-generation", restored.identity.generation)
          .header("x-report-archive-bucket", restored.identity.bucket)
          .header("x-report-archive-object-key", restored.identity.objectKey)
          .header("cache-control", "private, no-store")
          .send(body);
      } catch (error) {
        return failure(reply, error);
      }
    });
  });
}
