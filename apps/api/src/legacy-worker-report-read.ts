import { CRC32C, Storage } from "@google-cloud/storage";
import { pinExactGcsGeneration } from "@aerodb/core/gcs-exact-generation";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import { readLegacyPageMember } from "@aerodb/db/legacy-report-storage-codec";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "./env";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const CRC = /^[A-Za-z0-9+/]{6}==$/;
const MAX_OBJECT = 256 * 1024 ** 2;
const MAX_MEMBER = 64 * 1024 ** 2;
const TIMEOUT = 120_000;
const ROUTE = "/api/sync/v1/legacy-worker-report-archives/:scopeSha256/:objectSha256/member";
type Worker = { id: string; instanceId: string };
const parameters = z.object({ scopeSha256: z.string().regex(HASH), objectSha256: z.string().regex(HASH) }).strict();
const querySchema = z.object({
  bucket: z.string().min(1).max(222),
  generation: z.string().regex(/^[1-9][0-9]{0,19}$/).refine((s) => /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 18_446_744_073_709_551_615n),
  byteSize: z.coerce.number().int().positive().max(MAX_OBJECT),
  crc32c: z.string().regex(CRC),
  executionId: z.string().regex(UUID),
  kind: z.enum(["report", "conflict"]),
  sequence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  signature: z.string().regex(HASH),
  reportSha256: z.string().regex(HASH),
  reportByteSize: z.coerce.number().int().positive().max(MAX_MEMBER),
}).strict();
type Query = z.infer<typeof querySchema>;

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(new Error("Legacy worker backup read aborted"));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([work, aborted]); }
  finally { if (listener) signal.removeEventListener("abort", listener); }
}

/** Existing registered-worker ownership and permissions still apply; see
 * security-assumptions.md. Namespace checks are not an access grant. No
 * dispatch, job, claim or result is read/written by this storage helper. */
export async function readLegacyWorkerReportMember(
  worker: Worker,
  scopeSha256: string,
  objectSha256: string,
  query: Query,
  signal: AbortSignal,
) {
  if (!UUID.test(worker.id) || !UUID.test(worker.instanceId) || !HASH.test(scopeSha256) || !HASH.test(objectSha256))
    throw new Error("Invalid current registered worker identity");
  query = querySchema.parse(query);
  const bucket = env.evidenceBucket?.trim();
  if (!bucket || bucket !== query.bucket) throw new Error("Legacy backup bucket is not configured");
  signal.throwIfAborted();
  // No caller-supplied key or configurable prefix can select another worker.
  const objectKey = `legacy-worker-reports/v1/${worker.instanceId}/${worker.id}/${scopeSha256}/${objectSha256}.jsonl.gz`;
  const storage = new Storage({ retryOptions: { maxRetries: 2, totalTimeout: 120 } });
  const file = pinExactGcsGeneration(storage.bucket(bucket).file(objectKey, { generation: query.generation }), query.generation);
  const [metadata] = await abortable(file.getMetadata({ timeout: 30_000 }), signal);
  if (String(metadata.generation) !== query.generation || String(metadata.size) !== String(query.byteSize) ||
      metadata.crc32c !== query.crc32c || metadata.contentType !== "application/gzip" || metadata.contentEncoding)
    throw new Error("Legacy backup immutable metadata differs");
  signal.throwIfAborted();
  const stream = file.createReadStream({ validation: "crc32c", decompress: false });
  const abort = () => { stream.destroy(new Error("Legacy worker backup read aborted")); };
  signal.addEventListener("abort", abort, { once: true });
  const hash = createHash("sha256"), crc = new CRC32C();
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    if (signal.aborted) abort();
    for await (const raw of stream) {
      signal.throwIfAborted();
      const chunk = Buffer.from(raw);
      size += chunk.length;
      if (size > query.byteSize || size > MAX_OBJECT) throw new Error("Legacy backup exceeds the byte bound");
      hash.update(chunk); crc.update(chunk); chunks.push(chunk);
    }
  } finally { signal.removeEventListener("abort", abort); stream.destroy(); }
  signal.throwIfAborted();
  if (size !== query.byteSize || hash.digest("hex") !== objectSha256 || crc.toString() !== query.crc32c)
    throw new Error("Legacy backup compressed size/SHA/CRC differs");
  // The shared decoder authenticates every chunk/member, EOF, uniqueness and
  // decoded limits. It never rewrites reportText or interprets physical data.
  const member = readLegacyPageMember(Buffer.concat(chunks), {
    storedSha256: objectSha256, storedByteSize: query.byteSize,
    sourceInstance: worker.instanceId, solverId: worker.id, scopeSha256,
    executionId: query.executionId, kind: query.kind, sequence: query.sequence,
    contentSignature: query.signature, reportSha256: query.reportSha256, reportByteSize: query.reportByteSize,
  });
  if (member.kind === "report" && member.solverId !== worker.id)
    throw new Error("Legacy backup member belongs to another worker");
  const proof = reportTextIdentity(member.reportText);
  if (member.reportSha256 !== query.reportSha256 || member.reportByteSize !== query.reportByteSize ||
      proof.sha256 !== query.reportSha256 || proof.byteSize !== query.reportByteSize)
    throw new Error("Legacy backup member text size/SHA differs");
  signal.throwIfAborted();
  return { text: member.reportText, bucket, objectKey };
}

export async function registerLegacyWorkerReportReadRoutes(app: FastifyInstance, options: {
  authenticate(req: FastifyRequest, reply: FastifyReply): Promise<Worker | null>;
  permit(): Promise<boolean>;
}): Promise<void> {
  const owners = new WeakMap<FastifyRequest, Worker>();
  app.get(ROUTE, { exposeHeadRoute: false, onRequest: async (req, reply) => {
    const worker = await options.authenticate(req, reply);
    if (!worker) return;
    if (!(await options.permit())) return reply.code(403).send({ error: "fetch disabled for evidence_artifacts" });
    owners.set(req, worker);
  } }, async (req, reply) => {
    const worker = owners.get(req);
    if (!worker) return;
    const params = parameters.safeParse(req.params), query = querySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid exact legacy backup read" });
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    req.raw.once("aborted", disconnect); reply.raw.once("close", disconnect);
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const restored = await readLegacyWorkerReportMember(worker, params.data.scopeSha256, params.data.objectSha256, query.data, controller.signal);
      // Revocation, token rotation, instance changes and permissions are read
      // again after storage I/O; no stale ownership grants the response.
      const current = await options.authenticate(req, reply);
      if (!current) return;
      if (current.id !== worker.id || current.instanceId !== worker.instanceId || !(await options.permit()))
        return reply.code(403).send({ error: "Registered worker access changed during backup read" });
      controller.signal.throwIfAborted();
      return reply.headers({
        "content-type": "application/json; charset=utf-8", "content-length": String(query.data.reportByteSize),
        "x-content-sha256": query.data.reportSha256, "x-report-signature": query.data.signature,
        "x-report-execution-id": query.data.executionId, "x-report-kind": query.data.kind, "x-report-sequence": String(query.data.sequence),
        "x-report-archive-bucket": restored.bucket, "x-report-archive-object-key": restored.objectKey,
        "x-gcs-generation": query.data.generation, "x-archive-sha256": params.data.objectSha256,
        "x-archive-byte-size": String(query.data.byteSize), "x-archive-crc32c": query.data.crc32c,
        "cache-control": "private, no-store, no-transform",
      }).send(Buffer.from(restored.text, "utf8"));
    } catch {
      return reply.code(controller.signal.aborted ? 408 : 409).send({ error: "Exact legacy worker backup read failed" });
    } finally {
      clearTimeout(timer); controller.abort();
      req.raw.removeListener("aborted", disconnect); reply.raw.removeListener("close", disconnect);
    }
  });
}
