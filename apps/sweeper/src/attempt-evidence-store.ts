import { Storage } from "@google-cloud/storage";
import { pinExactGcsGeneration } from "@aerodb/core/gcs-exact-generation";
import {
  assertAttemptEvidenceArchive,
  type AttemptEvidenceArchiveIdentity,
} from "@aerodb/db/attempt-evidence-catalog";
import type { AttemptEvidenceCopySource } from "@aerodb/db/attempt-evidence-storage";
import {
  readAttemptEvidenceCopy,
  type AttemptEvidenceCopyIdentity,
} from "./attempt-evidence-archive";

export interface AttemptEvidenceArchiveStore {
  putFile(
    path: string,
    proof: AttemptEvidenceCopyIdentity,
    options: { bucket: string; sourceInstance: string },
  ): Promise<AttemptEvidenceArchiveIdentity>;
  read(
    identity: AttemptEvidenceArchiveIdentity,
    signal?: AbortSignal,
  ): Promise<AttemptEvidenceCopySource>;
}

function generationText(value: unknown): string {
  if (
    typeof value !== "string" &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
  )
    throw new Error(
      "Attempt evidence generation is not an exact decimal value",
    );
  return String(value);
}

export class AttemptEvidenceStore implements AttemptEvidenceArchiveStore {
  constructor(private readonly storage = new Storage()) {}

  async putFile(
    path: string,
    proof: AttemptEvidenceCopyIdentity,
    options: { bucket: string; sourceInstance: string },
  ) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.sourceInstance) ||
      !options.bucket.trim() ||
      options.bucket.includes("/")
    )
      throw new Error(
        "Attempt evidence GCS storage requires a bucket and stable source instance",
      );
    const objectKey = `attempt-evidence/v1/${options.sourceInstance}/${proof.attemptId}/${proof.sourceSha256}/${proof.storedSha256}.json.gz`;
    const bucket = this.storage.bucket(options.bucket);
    const file = bucket.file(objectKey);
    // An open-job snapshot or a lost registration response can leave this exact
    // immutable object available before a settled SQL receipt exists.
    let metadata;
    try {
      [metadata] = await file.getMetadata();
    } catch (error) {
      if (Number((error as { code?: unknown }).code) !== 404) throw error;
      try {
        await bucket.upload(path, {
          destination: objectKey,
          resumable: true,
          validation: "crc32c",
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: "application/gzip",
            cacheControl: "private, max-age=31536000, immutable",
            metadata: {
              format: "attempt-evidence-copy-v1",
              sha256: proof.storedSha256,
              byteSize: String(proof.storedByteSize),
              sourceInstance: options.sourceInstance,
              attemptId: proof.attemptId,
              resultId: proof.resultId ?? "",
              simJobId: proof.simJobId ?? "",
              sourceSha256: proof.sourceSha256,
              sourceByteSize: String(proof.sourceByteSize),
              envelopeSha256: proof.envelopeSha256,
              envelopeByteSize: String(proof.envelopeByteSize),
            },
          },
        });
      } catch (error) {
        if (Number((error as { code?: unknown })?.code) !== 412) throw error;
      }
      [metadata] = await file.getMetadata();
    }
    const identity: AttemptEvidenceArchiveIdentity = {
      ...proof,
      bucket: options.bucket,
      sourceInstance: options.sourceInstance,
      objectKey,
      generation: generationText(metadata.generation),
      crc32c: String(metadata.crc32c ?? ""),
      verifiedAt: new Date(),
    };
    assertAttemptEvidenceArchive(identity);
    if (identity.crc32c !== proof.crc32c)
      throw new Error("Attempt evidence upload CRC32C changed");
    await this.read(identity);
    identity.verifiedAt = new Date();
    return identity;
  }

  async read(
    identity: AttemptEvidenceArchiveIdentity,
    signal?: AbortSignal,
  ): Promise<AttemptEvidenceCopySource> {
    assertAttemptEvidenceArchive(identity);
    if (signal?.aborted)
      throw new Error("Attempt evidence restore was aborted");
    const file = pinExactGcsGeneration(
      this.storage
        .bucket(identity.bucket)
        .file(identity.objectKey, { generation: identity.generation }),
      identity.generation,
    );
    file.interceptors.push({
      request(options) {
        if (!("uri" in options) || typeof options.uri !== "string")
          throw new Error("Attempt evidence request URI is missing");
        return { ...options, uri: options.uri, timeout: 30_000 };
      },
    });
    const [metadata] = await file.getMetadata();
    const custom = metadata.metadata ?? {};
    if (
      generationText(metadata.generation) !== identity.generation ||
      String(metadata.size) !== String(identity.storedByteSize) ||
      metadata.crc32c !== identity.crc32c ||
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding ||
      custom.format !== "attempt-evidence-copy-v1" ||
      custom.sha256 !== identity.storedSha256 ||
      custom.byteSize !== String(identity.storedByteSize) ||
      custom.sourceInstance !== identity.sourceInstance ||
      custom.attemptId !== identity.attemptId ||
      custom.resultId !== (identity.resultId ?? "") ||
      custom.simJobId !== (identity.simJobId ?? "") ||
      custom.sourceSha256 !== identity.sourceSha256 ||
      custom.sourceByteSize !== String(identity.sourceByteSize) ||
      custom.envelopeSha256 !== identity.envelopeSha256 ||
      custom.envelopeByteSize !== String(identity.envelopeByteSize)
    )
      throw new Error("Attempt evidence pinned generation metadata changed");
    return readAttemptEvidenceCopy(
      file.createReadStream({ validation: "crc32c", decompress: false }),
      identity,
      { signal },
    );
  }
}
