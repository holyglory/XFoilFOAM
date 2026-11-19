import {
  MAX_SOLVER_HISTORY_STORED_BYTES,
  assertSolverHistoryArchive,
  decodeSolverHistory,
  encodeSolverHistory,
  type SolverHistoryArchiveIdentity,
  type SolverHistorySource,
} from "./solver-history-storage";

// Credentials and SDK construction stay in the calling API/sweeper.
interface HistoryObjectMetadata {
  generation?: string | number; size?: string | number; crc32c?: string; contentType?: string;
  metadata?: Record<string, unknown>;
}
interface HistoryObject {
  interceptors: { push(interceptor: {
    request(options: { uri?: unknown; qs?: Record<string, unknown> }): { uri: string; qs: Record<string, unknown>; timeout: number };
  }): number };
  getMetadata(): Promise<[HistoryObjectMetadata, ...unknown[]]>;
  save(data: Buffer, options: {
    resumable: false; validation: "crc32c"; preconditionOpts: { ifGenerationMatch: 0 };
    metadata: { contentType: string; cacheControl: string; metadata: Record<string, string> };
  }): Promise<unknown>;
  createReadStream(options: { validation: "crc32c"; decompress: false }): AsyncIterable<Uint8Array>;
}
export interface SolverHistoryGcsClient {
  bucket(name: string): { file(key: string, options?: { generation: string }): HistoryObject };
}

export class SolverHistoryGcsStore {
  constructor(private readonly storage: SolverHistoryGcsClient) {}

  async put(bucket: string, sourceInstance: string, source: SolverHistorySource): Promise<SolverHistoryArchiveIdentity> {
    if (!bucket.trim() || bucket.includes("/")) throw new Error("A solver history bucket is required");
    const encoded = encodeSolverHistory(sourceInstance, source);
    const objectKey = `solver-histories/v1/${sourceInstance}/${source.sourceId}/${encoded.storedSha256}.json.gz`;
    const file = this.storage.bucket(bucket).file(objectKey);
    try {
      await file.save(encoded.stored, {
        resumable: false, validation: "crc32c", preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: "application/gzip", cacheControl: "private, max-age=31536000, immutable",
          metadata: { format: "solver-history-v1", sha256: encoded.storedSha256 },
        },
      });
    } catch (error) {
      if (Number((error as { code?: unknown })?.code) !== 412) throw error;
    }
    const [metadata] = await file.getMetadata();
    if (metadata.contentType !== "application/gzip" || Number(metadata.size) !== encoded.storedByteSize ||
        metadata.metadata?.format !== "solver-history-v1" || metadata.metadata?.sha256 !== encoded.storedSha256)
      throw new Error("Solver history object metadata differs from the exact upload");
    const identity: SolverHistoryArchiveIdentity = {
      sourceInstance, sourceKind: source.sourceKind, sourceId: source.sourceId,
      resultId: source.resultId, resultAttemptId: source.resultAttemptId,
      sourceSha256: encoded.sourceSha256, sourceByteSize: encoded.sourceByteSize,
      envelopeSha256: encoded.envelopeSha256, envelopeByteSize: encoded.envelopeByteSize,
      storedSha256: encoded.storedSha256, storedByteSize: encoded.storedByteSize,
      bucket, objectKey, generation: String(metadata.generation ?? ""), crc32c: String(metadata.crc32c ?? ""),
    };
    await this.read(identity);
    return identity;
  }

  async read(identity: SolverHistoryArchiveIdentity) {
    assertSolverHistoryArchive(identity);
    const file = this.storage.bucket(identity.bucket).file(identity.objectKey, { generation: identity.generation });
    // Storage 7.16 converts FileOptions.generation to Number. Override the
    // final metadata/media request with the exact decimal string; never round
    // a 64-bit generation through JS number precision.
    file.interceptors.push({ request(options) {
      if (typeof options.uri !== "string") throw new Error("Solver history request URI is missing");
      return { ...options, uri: options.uri, qs: { ...options.qs, generation: identity.generation }, timeout: 30_000 };
    } });
    const [metadata] = await file.getMetadata();
    if (String(metadata.generation) !== identity.generation || String(metadata.crc32c) !== identity.crc32c ||
        Number(metadata.size) !== identity.storedByteSize || metadata.contentType !== "application/gzip")
      throw new Error("Solver history pinned generation metadata changed");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of file.createReadStream({ validation: "crc32c", decompress: false })) {
      const chunk = Buffer.from(raw);
      size += chunk.byteLength;
      if (size > identity.storedByteSize || size > MAX_SOLVER_HISTORY_STORED_BYTES)
        throw new Error("Solver history archive stream exceeds its declared bound");
      chunks.push(chunk);
    }
    return decodeSolverHistory(Buffer.concat(chunks), identity);
  }
}
