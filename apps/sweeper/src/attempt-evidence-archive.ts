import { CRC32C } from "@google-cloud/storage";
import {
  MAX_ATTEMPT_EVIDENCE_BYTES,
  prepareAttemptEvidenceCopy,
  type AttemptEvidenceCopyPlan,
  type AttemptEvidenceCopySource,
} from "@aerodb/db/attempt-evidence-storage";
import { canonicalAnalysisJson } from "@aerodb/db/analysis-target";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { createGzip, createGunzip } from "node:zlib";

const MAX_ENVELOPE_BYTES = 2 * MAX_ATTEMPT_EVIDENCE_BYTES + 65536;
const MAX_STORED_BYTES = MAX_ENVELOPE_BYTES + 131072;
const SHA256 = /^[a-f0-9]{64}$/;
const CRC = /^[A-Za-z0-9+/]{6}==$/;

export interface AttemptEvidenceCopyIdentity {
  attemptId: string;
  resultId: string | null;
  simJobId: string | null;
  sourceSha256: string;
  sourceByteSize: number;
  envelopeSha256: string;
  envelopeByteSize: number;
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
}

function assertIdentity(identity: AttemptEvidenceCopyIdentity) {
  if (
    ![
      identity.sourceSha256,
      identity.envelopeSha256,
      identity.storedSha256,
    ].every((value) => SHA256.test(value)) ||
    !CRC.test(identity.crc32c) ||
    [
      [identity.sourceByteSize, MAX_ATTEMPT_EVIDENCE_BYTES],
      [identity.envelopeByteSize, MAX_ENVELOPE_BYTES],
      [identity.storedByteSize, MAX_STORED_BYTES],
    ].some(
      ([size, limit]) =>
        !Number.isSafeInteger(size) || size <= 0 || size > limit,
    )
  )
    throw new Error("Invalid attempt evidence copy identity");
}

/** Bounded preparation only: this cannot replace any online field or register
 * an archive pointer. The caller owns the destination directory and cleanup. */
export async function writeAttemptEvidenceCopy(
  path: string,
  source: AttemptEvidenceCopySource,
): Promise<AttemptEvidenceCopyIdentity> {
  const plan = prepareAttemptEvidenceCopy(source);
  const envelope = Buffer.from(JSON.stringify(plan), "utf8");
  if (envelope.length > MAX_ENVELOPE_BYTES)
    throw new Error("Attempt evidence copy envelope exceeds its byte limit");
  const hash = createHash("sha256");
  const crc = new CRC32C();
  let size = 0;
  await pipeline(
    Readable.from([envelope]),
    createGzip({ level: 9 }),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_STORED_BYTES) {
          callback(
            new Error(
              "Attempt evidence copy exceeds its compressed byte limit",
            ),
          );
          return;
        }
        hash.update(chunk);
        crc.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  const identity: AttemptEvidenceCopyIdentity = {
    attemptId: source.attemptId,
    resultId: source.resultId,
    simJobId: source.simJobId,
    sourceSha256: plan.sourceSha256,
    sourceByteSize: plan.sourceByteSize,
    envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
    envelopeByteSize: envelope.length,
    storedSha256: hash.digest("hex"),
    storedByteSize: size,
    crc32c: crc.toString(),
  };
  await readAttemptEvidenceCopy(createReadStream(path), identity);
  return identity;
}

/** Returns exact PostgreSQL text after complete byte, gzip and owner proof.
 * Callers must never insert this envelope where a force-sample array belongs. */
export async function readAttemptEvidenceCopy(
  source: Readable,
  identity: AttemptEvidenceCopyIdentity,
  options: { signal?: AbortSignal } = {},
): Promise<AttemptEvidenceCopySource> {
  try {
    assertIdentity(identity);
  } catch (error) {
    source.destroy();
    throw error;
  }
  const storedHash = createHash("sha256");
  const envelopeHash = createHash("sha256");
  const crc = new CRC32C();
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let storedSize = 0;
  let envelopeSize = 0;
  let text = "";
  await pipeline(
    source,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        storedSize += chunk.length;
        if (storedSize > identity.storedByteSize) {
          callback(new Error("Attempt copy exceeded its compressed identity"));
          return;
        }
        storedHash.update(chunk);
        crc.update(chunk);
        callback(null, chunk);
      },
    }),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          envelopeSize += chunk.length;
          if (envelopeSize > identity.envelopeByteSize)
            throw new Error("Attempt copy exceeded its decoded identity");
          envelopeHash.update(chunk);
          text += utf8.decode(chunk, { stream: true });
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
      final(callback) {
        try {
          text += utf8.decode();
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    }),
    { signal: options.signal },
  );
  if (
    storedSize !== identity.storedByteSize ||
    storedHash.digest("hex") !== identity.storedSha256 ||
    crc.toString() !== identity.crc32c ||
    envelopeSize !== identity.envelopeByteSize ||
    envelopeHash.digest("hex") !== identity.envelopeSha256
  )
    throw new Error(
      "Attempt evidence copy failed complete compressed/envelope verification",
    );
  const envelope = JSON.parse(text) as AttemptEvidenceCopyPlan;
  const plan = prepareAttemptEvidenceCopy(envelope.source);
  if (
    canonicalAnalysisJson(envelope) !== canonicalAnalysisJson(plan) ||
    plan.source.attemptId !== identity.attemptId ||
    plan.source.resultId !== identity.resultId ||
    plan.source.simJobId !== identity.simJobId ||
    plan.sourceSha256 !== identity.sourceSha256 ||
    plan.sourceByteSize !== identity.sourceByteSize
  )
    throw new Error(
      "Attempt evidence copy changed its exact source, owner or inventory",
    );
  return plan.source;
}
