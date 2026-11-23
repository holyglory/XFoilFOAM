import { MAX_ATTEMPT_EVIDENCE_BYTES } from "@aerodb/db/attempt-evidence-storage";
import { Readable } from "node:stream";
import {
  type AttemptEvidenceArchiveIdentity,
  assertAttemptEvidenceArchive,
} from "@aerodb/db/attempt-evidence-catalog";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import { HubWorkloadGcs, boundedHubBody } from "./hub-workload-gcs";
import {
  type AttemptEvidenceCopyIdentity,
  readAttemptEvidenceCopy,
} from "./attempt-evidence-archive";
import { hzAttemptKey } from "./hz-attempt-volume";

function custom(p: AttemptEvidenceCopyIdentity, instance: string) {
  return {
    format: "attempt-evidence-copy-v1",
    sha256: p.storedSha256,
    byteSize: String(p.storedByteSize),
    sourceInstance: instance,
    attemptId: p.attemptId,
    resultId: p.resultId ?? "",
    simJobId: p.simJobId ?? "",
    sourceSha256: p.sourceSha256,
    sourceByteSize: String(p.sourceByteSize),
    envelopeSha256: p.envelopeSha256,
    envelopeByteSize: String(p.envelopeByteSize),
  };
}
export class HzAttemptHubStore extends HubWorkloadGcs {
  constructor(
    bucket: string,
    account: string,
    request: typeof fetch = fetch,
    private readonly originalCopy = false,
  ) {
    super(bucket, account, request);
  }
  private withinBounds(source: number, packed: number, existingGeneration = false) {
    const max = this.originalCopy ? MAX_ATTEMPT_EVIDENCE_BYTES : existingGeneration ? 8 * 1024 * 1024 : 262144;
    return (
      source > 0 &&
      source <= max &&
      packed > 0 &&
      packed <= (this.originalCopy ? max * 2 + 196608 : 1048576)
    );
  }
  async put(instance: string, p: AttemptEvidenceCopyIdentity, packed: Buffer) {
    if (
      !/^[a-f0-9-]{36}$/.test(instance) ||
      !this.withinBounds(p.sourceByteSize, packed.length)
    )
      throw new Error("Invalid worker attempt transfer");
    await readAttemptEvidenceCopy(Readable.from([packed]), p);
    const objectKey = hzAttemptKey(instance, p),
      boundary = "hz-attempt-" + p.storedSha256;
    const metadata = {
      name: objectKey,
      contentType: "application/gzip",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: custom(p, instance),
    };
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
      ),
      packed,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = new URL(
      "https://storage.googleapis.com/upload/storage/v1/b/" +
        encodeURIComponent(this.bucket) +
        "/o",
    );
    url.searchParams.set("ifGenerationMatch", "0");
    url.searchParams.set("uploadType", "multipart");
    const response = await this.call(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "multipart/related; boundary=" + boundary },
      body: body as unknown as NonNullable<RequestInit["body"]>,
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 412)
      throw new HistoryOperationError(
        "attempt_put",
        response.status === 429 || response.status >= 500
          ? "transport"
          : response.status === 401 || response.status === 403
            ? "denied"
            : "integrity",
        response.status === 429 || response.status >= 500,
      );
    const metadataResponse = JSON.parse(
      (
        await boundedHubBody(
          await this.call(this.url(objectKey).toString()),
          65536,
        )
      ).toString("utf8"),
    );
    return this.read({
      ...p,
      sourceInstance: instance,
      bucket: this.bucket,
      objectKey,
      generation: metadataResponse.generation,
      verifiedAt: new Date(),
    });
  }
  async read(identity: AttemptEvidenceArchiveIdentity) {
    assertAttemptEvidenceArchive(identity);
    if (
      identity.bucket !== this.bucket ||
      !this.withinBounds(identity.sourceByteSize, identity.storedByteSize, true) ||
      identity.objectKey !== hzAttemptKey(identity.sourceInstance, identity)
    )
      throw new Error("Invalid attempt generation");
    const url = this.url(identity.objectKey, identity.generation);
    const m = JSON.parse(
      (await boundedHubBody(await this.call(url.toString()), 65536)).toString(
        "utf8",
      ),
    );
    if (
      m.bucket !== identity.bucket ||
      m.name !== identity.objectKey ||
      m.generation !== identity.generation ||
      String(m.size) !== String(identity.storedByteSize) ||
      m.contentType !== "application/gzip" ||
      m.contentEncoding ||
      m.crc32c !== identity.crc32c ||
      Object.entries(custom(identity, identity.sourceInstance)).some(
        ([k, v]) => m.metadata?.[k] !== v,
      )
    )
      throw new Error("Pinned attempt metadata mismatch");
    url.searchParams.set("alt", "media");
    const packed = await boundedHubBody(
      await this.call(url.toString()),
      identity.storedByteSize,
    );
    await readAttemptEvidenceCopy(Readable.from([packed]), identity);
    return {
      identity: { ...identity, verifiedAt: new Date() },
      packed: packed.toString("base64"),
    };
  }
}
