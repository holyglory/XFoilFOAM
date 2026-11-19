import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import type { DB } from "@aerodb/db/client";
import { reportTextIdentity, type ProgressiveReportArchiveReadIdentity } from "@aerodb/db/progressive-report-archive";
import { CRC32C } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { readLegacyPageMember } from "@aerodb/db/legacy-report-storage-codec";
import { readWorkerReportVolume } from "./worker-report-volume";
export { readLegacyWorkerReportArchivePage } from "./legacy-worker-report-product-read";

const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const HASH = /^[a-f0-9]{64}$/;
const KEY = new RegExp(`^legacy-worker-reports/v1/(${UUID})/(${UUID})/([a-f0-9]{64})/([a-f0-9]{64})\\.jsonl\\.gz$`);
const MAX_OBJECT = 256 * 1024 ** 2;
const MAX_MEMBER = 64 * 1024 ** 2;
const TIMEOUT = 120_000;
type Identity = ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal };
type Settings = { source_instance: string; solver_id: string | null; auth_token: string; upstream_base_url: string | null };

function checkedKey(identity: Identity): RegExpExecArray {
  const key = KEY.exec(identity.objectKey);
  if (!key || key[4] !== identity.storedSha256 ||
      !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(identity.bucket) ||
      identity.sourceKind !== "worker" || identity.archiveFormat !== "legacy-jsonl" ||
      identity.compression !== "gzip" || identity.mimeType !== "application/gzip" ||
      !new RegExp(`^${UUID}$`).test(identity.executionId) ||
      !["report", "conflict"].includes(identity.memberKind) ||
      !Number.isSafeInteger(identity.sequence) || identity.sequence < 1 ||
      !HASH.test(identity.signature) || !HASH.test(identity.reportSha256) ||
      typeof identity.generation !== "string" || !/^[1-9][0-9]{0,19}$/.test(identity.generation) ||
      BigInt(identity.generation) > 18_446_744_073_709_551_615n ||
      !/^[A-Za-z0-9+/]{6}==$/.test(identity.crc32c) ||
      !Number.isSafeInteger(identity.storedByteSize) || identity.storedByteSize < 1 || identity.storedByteSize > MAX_OBJECT ||
      !Number.isSafeInteger(identity.reportByteSize) || identity.reportByteSize < 1 || identity.reportByteSize > MAX_MEMBER)
    throw new Error("Invalid exact legacy worker backup identity");
  return key;
}

async function owner(db: DB, identity: Identity) {
  const key = checkedKey(identity);
  identity.signal?.throwIfAborted();
  const [settings] = await db.execute(sql`
    SELECT instance_id::text AS source_instance, remote_solver_registered_id::text AS solver_id,
      remote_solver_auth_token AS auth_token, upstream_base_url
    FROM sync_api_settings WHERE id = 1
  `) as unknown as Settings[];
  if (!settings || settings.source_instance !== key[1] || settings.solver_id !== key[2])
    throw new Error("Legacy backup does not belong to the current registered worker instance");
  identity.signal?.throwIfAborted();
  return { key, settings };
}

function boundedSignal(signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
}

async function localText(source: Readable, identity: Identity, key: RegExpExecArray, settings: Settings) {
  const signal = boundedSignal(identity.signal);
  const abort = () => { source.destroy(new Error("Legacy worker backup read aborted")); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [], hash = createHash("sha256"), crc = new CRC32C();
  let size = 0;
  try {
    if (signal.aborted) abort();
    for await (const raw of source) {
      signal.throwIfAborted();
      const chunk = Buffer.from(raw); size += chunk.length;
      if (size > identity.storedByteSize || size > MAX_OBJECT) throw new Error("Local legacy backup exceeds byte bound");
      hash.update(chunk); crc.update(chunk); chunks.push(chunk);
    }
  } finally { signal.removeEventListener("abort", abort); source.destroy(); }
  signal.throwIfAborted();
  if (size !== identity.storedByteSize || hash.digest("hex") !== identity.storedSha256 || crc.toString() !== identity.crc32c)
    throw new Error("Local legacy backup compressed size/SHA/CRC differs");
  const member = readLegacyPageMember(Buffer.concat(chunks), {
    storedSha256: identity.storedSha256, storedByteSize: identity.storedByteSize,
    sourceInstance: settings.source_instance, solverId: key[2], scopeSha256: key[3],
    executionId: identity.executionId, kind: identity.memberKind, sequence: identity.sequence,
    contentSignature: identity.signature, reportSha256: identity.reportSha256, reportByteSize: identity.reportByteSize,
  });
  if (member.kind === "report" && member.solverId !== settings.solver_id)
    throw new Error("Local legacy backup member belongs to another worker source");
  const proof = reportTextIdentity(member.reportText);
  if (member.reportSha256 !== identity.reportSha256 || member.reportByteSize !== identity.reportByteSize ||
      proof.sha256 !== identity.reportSha256 || proof.byteSize !== identity.reportByteSize)
    throw new Error("Local legacy backup member failed exact text verification");
  signal.throwIfAborted();
  return member.reportText;
}

/** Uses the worker's already-local private compressed working copy first.
 * The common volume module owns private file safety and content-addressed
 * retention. This reader independently checks source, full compressed
 * bytes/CRC and the exact member. A corrupt present copy fails closed; it is
 * never replaced by a network retry or scheduling/publication operation. */
export async function readLegacyWorkerReportArchiveText(db: DB, identity: Identity): Promise<string> {
  const { key, settings } = await owner(db, identity);
  const source = await readWorkerReportVolume(identity);
  const text = source ? await localText(source, identity, key, settings) : await hubText(identity, key, settings);
  await owner(db, identity); // Current instance/registration must still match after I/O.
  return text;
}

/** Explicit network-only reader for permission/transport verification. Local
 * possession never bypasses the hub's existing registered GET permissions. */
export async function readLegacyWorkerReportFromHub(db: DB, identity: Identity): Promise<string> {
  const { key, settings } = await owner(db, identity);
  const text = await hubText(identity, key, settings);
  await owner(db, identity);
  return text;
}

async function hubText(identity: Identity, key: RegExpExecArray, settings: Settings): Promise<string> {
  if (!settings.auth_token || !settings.upstream_base_url)
    throw new Error("Legacy worker backup has no current authenticated upstream");
  const baseUrl = canonicalRemoteHubBaseUrl(settings.upstream_base_url), signal = boundedSignal(identity.signal);
  signal.throwIfAborted();
  const query = new URLSearchParams({
    bucket: identity.bucket, generation: identity.generation, byteSize: String(identity.storedByteSize), crc32c: identity.crc32c,
    executionId: identity.executionId, kind: identity.memberKind, sequence: String(identity.sequence),
    signature: identity.signature, reportSha256: identity.reportSha256, reportByteSize: String(identity.reportByteSize),
  });
  const response = await fetch(`${baseUrl}/legacy-worker-report-archives/${key[3]}/${key[4]}/member?${query}`, {
    method: "GET", redirect: "error", signal,
    headers: { "x-xfoilfoam-solver-token": settings.auth_token, "accept-encoding": "identity" },
  });
  const expected = {
    "content-type": "application/json; charset=utf-8", "content-length": String(identity.reportByteSize),
    "x-content-sha256": identity.reportSha256, "x-report-signature": identity.signature,
    "x-report-execution-id": identity.executionId, "x-report-kind": identity.memberKind, "x-report-sequence": String(identity.sequence),
    "x-report-archive-bucket": identity.bucket, "x-report-archive-object-key": identity.objectKey,
    "x-gcs-generation": identity.generation, "x-archive-sha256": identity.storedSha256,
    "x-archive-byte-size": String(identity.storedByteSize), "x-archive-crc32c": identity.crc32c,
  };
  if (response.status !== 200 || !response.body || response.headers.has("content-encoding") ||
      Object.entries(expected).some(([header, value]) => response.headers.get(header) !== value)) {
    await response.body?.cancel();
    throw new Error(`Exact legacy worker backup response differs (${response.status})`);
  }
  const reader = response.body.getReader(), abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > identity.reportByteSize || size > MAX_MEMBER) throw new Error("Legacy worker backup member exceeds its byte bound");
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = Buffer.concat(chunks), text = bytes.toString("utf8"), proof = reportTextIdentity(text);
  if (!Buffer.from(text, "utf8").equals(bytes) || size !== identity.reportByteSize ||
      proof.sha256 !== identity.reportSha256 || proof.byteSize !== identity.reportByteSize)
    throw new Error("Legacy worker backup member failed exact text verification");
  return text;
}
