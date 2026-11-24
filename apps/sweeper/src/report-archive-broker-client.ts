import { WORKER_REPORT_TRANSFER_TIMEOUT_MS } from "@aerodb/core/registered-archive-read";
import { readWorkerReportVolume } from "./worker-report-volume";
import { readLegacyWorkerReportArchiveText } from "./legacy-worker-report-read";
import { readRegisteredWorkerReportArchiveText } from "./registered-worker-report-read";
import { CRC32C } from "@google-cloud/storage";
import { registeredWorkerArchiveOwner, type DB } from "@aerodb/db";
export { registeredWorkerArchiveOwner };
import {
  assertProgressiveReportArchiveIdentity,
  reportTextIdentity,
  type ProgressiveReportArchiveReadIdentity,
  type ProgressiveReportArchiveStoredIdentity,
} from "@aerodb/db/progressive-report-archive";
import { createHash } from "node:crypto";
import { currentClosedWorkerPageRead } from "./closed-worker-page-read";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type {
  ProgressiveReportArchiveIdentity,
  ProgressiveReportArchiveMember,
} from "./progressive-report-archive-store";

export type {
  ProgressiveReportArchiveIdentity,
  ProgressiveReportArchiveMember,
} from "./progressive-report-archive-store";

import { visitWorkerReportGeneration, WorkerResultReadCache, WORKER_RESULT_REF } from "./worker-result-archive";

const workerResults = new WorkerResultReadCache();
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC = /^[A-Za-z0-9+/]{6}==$/;
const MAX_STORED_BYTES = 256 * 1024 ** 2;
const MAX_JSON_BYTES = 512 * 1024 ** 2;
const MAX_LINE_BYTES = 64 * 1024 ** 2;
const MAX_MEMBERS = 256;

function assertLocalIdentity(
  executionId: string,
  identity: { sha256: string; byteSize: number },
) {
  if (
    !UUID.test(executionId) ||
    !SHA256.test(identity.sha256) ||
    !Number.isSafeInteger(identity.byteSize) ||
    identity.byteSize <= 0 ||
    identity.byteSize > MAX_STORED_BYTES
  )
    throw new Error("Invalid bounded worker report archive identity");
}

function assertArchive(
  archive: ProgressiveReportArchiveStoredIdentity,
  executionId: string,
) {
  assertProgressiveReportArchiveIdentity(archive, archive.archiveFormat === WORKER_RESULT_REF ? WORKER_RESULT_REF : "jsonl");
  assertLocalIdentity(executionId, {
    sha256: archive.storedSha256,
    byteSize: archive.storedByteSize,
  });
  const suffix = `/worker/${executionId}/${archive.storedSha256}.jsonl.gz`;
  if (
    typeof archive.bucket !== "string" ||
    !archive.bucket.trim() ||
    typeof archive.objectKey !== "string" ||
    !archive.objectKey.endsWith(suffix) ||
    !/^[A-Za-z0-9_./-]+$/.test(archive.objectKey) ||
    archive.objectKey
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    typeof archive.generation !== "string" ||
    !GENERATION.test(archive.generation) ||
    BigInt(archive.generation) > 18_446_744_073_709_551_615n ||
    archive.mimeType !== "application/gzip" ||
    archive.compression !== "gzip" ||
    typeof archive.crc32c !== "string" ||
    !CRC.test(archive.crc32c)
  )
    throw new Error(
      "Worker report archive receipt changed its immutable scope",
    );
}

function archiveUrl(baseUrl: string, executionId: string, sha256: string) {
  return `${baseUrl}/progressive-executions/${executionId}/report-archives/${sha256}`;
}

export async function readArchiveBrokerResponse(response: Response): Promise<unknown> {
  if (!response.body)
    throw new Error("Worker report archive receipt is missing");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of Readable.fromWeb(response.body)) {
    const chunk = Buffer.from(raw);
    size += chunk.byteLength;
    if (size > 16 * 1024)
      throw new Error("Worker report archive receipt exceeds the byte limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Upload one bounded gzip/JSONL page through the trusted hub. No cloud
 * credentials or direct object-store access are needed on the worker. */
export async function putWorkerReportBundle<F extends "jsonl" | typeof WORKER_RESULT_REF = "jsonl">(
  db: DB,
  path: string,
  identity: { sha256: string; byteSize: number },
  executionId: string,
  format: F = "jsonl" as F,
): Promise<Omit<ProgressiveReportArchiveIdentity, "archiveFormat"> & { archiveFormat: F }> {
  assertLocalIdentity(executionId, identity);
  const owned = await registeredWorkerArchiveOwner(db, executionId);
  const file = await open(path, "r");
  let body: Readable | undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== identity.byteSize)
      throw new Error("Worker report archive changed its declared local size");
    const hash = createHash("sha256");
    const crc = new CRC32C();
    let size = 0;
    for await (const raw of file.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      size += raw.byteLength;
      if (size > identity.byteSize)
        throw new Error(
          "Worker report archive changed its declared local size",
        );
      hash.update(raw);
      crc.update(raw);
    }
    if (size !== identity.byteSize || hash.digest("hex") !== identity.sha256)
      throw new Error(
        "Worker report archive failed local SHA-256 verification",
      );
    body = file.createReadStream({
      start: 0,
      end: identity.byteSize - 1,
      autoClose: false,
    });
    const response = await fetch(
      `${archiveUrl(owned.baseUrl, executionId, identity.sha256)}?byteSize=${identity.byteSize}${format === "jsonl" ? "" : "&format=" + format}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(WORKER_REPORT_TRANSFER_TIMEOUT_MS),
        headers: {
          "content-type": "application/gzip",
          "content-length": String(identity.byteSize),
          "x-xfoilfoam-solver-token": owned.authToken,
        },
        body: body as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Worker report archive upload failed (${response.status})`,
      );
    }
    const value = (await readArchiveBrokerResponse(response)) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.verifiedAt !== "string"
    )
      throw new Error("Worker report archive receipt is invalid");
    const archive = {
      ...value,
      verifiedAt: new Date(value.verifiedAt),
    } as unknown as Omit<ProgressiveReportArchiveIdentity, "archiveFormat"> & { archiveFormat: F };
    assertArchive(archive, executionId);
    if (!Number.isFinite(archive.verifiedAt.getTime()))
      throw new Error(
        "Worker report archive receipt has no verification timestamp",
      );
    if (
      archive.archiveFormat !== format || archive.storedSha256 !== identity.sha256 ||
      archive.storedByteSize !== identity.byteSize ||
      archive.crc32c !== crc.toString()
    )
      throw new Error(
        "Worker report archive receipt changed the uploaded bytes",
      );
    return archive;
  } finally {
    body?.destroy();
    await file.close();
  }
}

/** Restore a single exact report/conflict body for post-terminal readers.
 * Every byte of the pinned bundle is verified, including data after the match. */
export async function readWorkerArchivedReport(
  db: DB,
  archive: ProgressiveReportArchiveIdentity,
  member: ProgressiveReportArchiveMember,
): Promise<unknown> {
  return readWorkerReportArchive(db, {
    ...archive,
    ...member,
    signature: member.contentSignature,
  });
}

/** Direct adapter for the database report-reader registry. */
export async function readWorkerReportArchive(
  db: DB,
  identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
): Promise<unknown> {
  return JSON.parse(await readWorkerReportArchiveText(db, identity)) as unknown;
}

export class WorkerReportFetchDisabled extends Error {
  constructor() {
    super("The hub disables evidence downloads for this worker");
  }
}

export function readStoredWorkerArchiveText(
  db: DB,
  identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
  dictionaryCache = workerResults,
) {
  return identity.archiveFormat === "legacy-jsonl"
    ? readLegacyWorkerReportArchiveText(db, identity)
    : readWorkerReportArchiveText(db, identity, { dictionaryCache });
}

/** Lossless PG ::text reader for archive, conflict and post-terminal callers. */
export async function readWorkerReportArchiveText(
  db: DB,
  identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
  options: { upstreamOnly?: boolean; dictionaryCache?: WorkerResultReadCache } = {},
): Promise<string> {
  if (
    identity.sourceKind === "worker" &&
    identity.archiveFormat === "jsonl" &&
    typeof identity.objectKey === "string" &&
    identity.objectKey.endsWith(
      `/remote/${identity.executionId}/${identity.storedSha256}.jsonl.gz`,
    )
  ) {
    return readRegisteredWorkerReportArchiveText(db, identity, options);
  }
  assertArchive(identity, identity.executionId);
  if (
    identity.sourceKind !== "worker" ||
    (identity.memberKind !== "report" && identity.memberKind !== "conflict") ||
    !Number.isSafeInteger(identity.sequence) ||
    identity.sequence <= 0 ||
    !SHA256.test(identity.signature) ||
    !SHA256.test(identity.reportSha256) ||
    !Number.isSafeInteger(identity.reportByteSize) ||
    identity.reportByteSize <= 0 ||
    identity.reportByteSize > MAX_LINE_BYTES
  )
    throw new Error("Invalid exact worker report archive member");
  const owned = await registeredWorkerArchiveOwner(db, identity.executionId);
  const open = (p: ProgressiveReportArchiveReadIdentity) =>
    openWorkerGeneration({ ...p, signal: identity.signal }, owned, options.upstreamOnly);
  const owner = {
    executionId: identity.executionId,
    workerInstance: owned.workerInstance,
    solverId: owned.envelope.solverId,
    promiseId: owned.envelope.promiseId,
    assignmentSignature: owned.envelope.contentSignature,
  };
  const page = !options.upstreamOnly && currentClosedWorkerPageRead();
  if (page) {
    identity.signal?.throwIfAborted();
    const text = await page.read(identity, JSON.stringify([owner, owned.baseUrl]), async (head, accept) => {
      const stream = await open(head);
      try {
        await visitWorkerReportGeneration(stream, head, owner, accept, {
          maxMembers: 8, maxDecodedBytes: 64 * 1024 ** 2, maxReportBytes: 32 * 1024 ** 2,
        }, open, identity.signal, options.dictionaryCache ?? workerResults);
      } finally {
        stream.destroy();
      }
    });
    identity.signal?.throwIfAborted();
    return text;
  }
  const stream = await open(identity);
  let found: string | undefined;
  try {
    await visitWorkerReportGeneration(
      stream,
      identity,
      owner,
      (entry) => {
        if (
          entry.kind === identity.memberKind &&
          entry.sequence === identity.sequence &&
          entry.contentSignature === identity.signature
        ) {
          const proof = reportTextIdentity(entry.reportText);
          if (
            proof.sha256 !== identity.reportSha256 ||
            proof.byteSize !== identity.reportByteSize
          )
            throw new Error(
              "Worker report archive member failed exact SHA-256 or size verification",
            );
          found = entry.reportText;
        }
      },
      {
        maxMembers: MAX_MEMBERS,
        maxDecodedBytes: MAX_JSON_BYTES,
        maxReportBytes: MAX_LINE_BYTES,
      },
      open, identity.signal, options.dictionaryCache ?? workerResults,
    );
  } finally {
    stream.destroy();
  }
  if (found === undefined)
    throw new Error("Exact worker report archive member was not found");
  return found;
}

async function openWorkerGeneration(
  identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
  owned: Awaited<ReturnType<typeof registeredWorkerArchiveOwner>>, upstreamOnly?: boolean,
) {
  let stream = upstreamOnly
    ? null
    : await readWorkerReportVolume(identity);
  if (!stream) {
    const query = new URLSearchParams({
      byteSize: String(identity.storedByteSize),
      generation: identity.generation,
      crc32c: identity.crc32c,
    });
    const response = await fetch(
      `${archiveUrl(owned.baseUrl, identity.executionId, identity.storedSha256)}?${query}`,
      {
        redirect: "error",
        signal: identity.signal
          ? AbortSignal.any([
              identity.signal,
              AbortSignal.timeout(WORKER_REPORT_TRANSFER_TIMEOUT_MS),
            ])
          : AbortSignal.timeout(WORKER_REPORT_TRANSFER_TIMEOUT_MS),
        headers: { "x-xfoilfoam-solver-token": owned.authToken },
      },
    );
    if (response.status === 403) {
      const body = (await readArchiveBrokerResponse(response)) as {
        error?: unknown;
      };
      if (body?.error === "fetch disabled for evidence_artifacts")
        throw new WorkerReportFetchDisabled();
      throw new Error("The registered worker has no access to this archive");
    }
    if (
      !response.ok ||
      !response.body ||
      response.headers.get("content-type") !== identity.mimeType ||
      response.headers.get("content-length") !==
        String(identity.storedByteSize) ||
      response.headers.has("content-encoding") ||
      response.headers.get("x-content-sha256") !== identity.storedSha256 ||
      response.headers.get("x-content-crc32c") !== identity.crc32c ||
      response.headers.get("x-gcs-generation") !== identity.generation ||
      response.headers.get("x-report-archive-bucket") !== identity.bucket ||
      response.headers.get("x-report-archive-object-key") !== identity.objectKey
    ) {
      await response.body?.cancel();
      throw new Error(
        `Worker report archive restore changed the exact identity (${response.status})`,
      );
    }

    stream = Readable.fromWeb(response.body);
  }
  return stream;
}
