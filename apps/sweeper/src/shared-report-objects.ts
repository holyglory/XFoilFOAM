import { CRC32C, Storage, type File, type Bucket } from "@google-cloud/storage";
import { pinExactGcsGeneration } from "@aerodb/core/gcs-exact-generation";
import { createHash } from "node:crypto";
import { addAbortSignal } from "node:stream";

export const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
export const hashPattern = /^[a-f0-9]{64}$/;
const generationPattern = /^[1-9][0-9]{0,19}$/;
export interface ReportObjectPin {
  key: string;
  generation: string;
  sha256: string;
  size: number;
  crc32c: string;
}
export interface ReportObjects {
  bucket: string;
  prefix: string;
  find(key: string): Promise<ReportObjectPin | null>;
  create(key: string, compressed: Buffer): Promise<ReportObjectPin>;
  read(
    pin: ReportObjectPin,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
}

export function checkReportObjectPin(
  pin: ReportObjectPin,
  key: string,
  limit: number,
) {
  if (
    !pin ||
    pin.key !== key ||
    typeof pin.generation !== "string" ||
    !generationPattern.test(pin.generation) ||
    BigInt(pin.generation) > 18446744073709551615n ||
    typeof pin.sha256 !== "string" ||
    !hashPattern.test(pin.sha256) ||
    !Number.isSafeInteger(pin.size) ||
    pin.size < 1 ||
    pin.size > limit ||
    typeof pin.crc32c !== "string" ||
    !/^[A-Za-z0-9+/]{6}==$/.test(pin.crc32c)
  )
    throw new Error("Invalid shared report object identity");
}

/** Canonical report upload contract for both legacy JSONL and factored
 * objects. A pre-existing object must still pass the caller's subsequent
 * generation metadata, compressed-byte, and format-specific readback. */
export async function putImmutableReportObject(
  bucket: Bucket,
  key: string,
  source: { path: string } | { bytes: Buffer },
  metadata: Record<string, string>,
) {
  const file = bucket.file(key);
  const options = {
    validation: "crc32c" as const,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      cacheControl: "private, max-age=31536000, immutable",
      contentType: "application/gzip",
      metadata,
    },
  };
  try {
    if ("path" in source)
      await bucket.upload(source.path, {
        ...options,
        resumable: true,
        destination: key,
      });
    else await file.save(source.bytes, { ...options, resumable: false });
    return { file, created: true };
  } catch (e) {
    if (Number((e as { code?: unknown }).code) !== 412) throw e;
    return { file, created: false };
  }
}
/** Same create-only upload and exact-generation/CRC read used by canonical report storage. */
export class HubReportObjects implements ReportObjects {
  constructor(
    readonly bucket: string,
    readonly prefix: string,
    private readonly storage = new Storage(),
  ) {
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
    if (
      !bucket.trim() ||
      !this.prefix ||
      this.prefix
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid hub report object namespace");
  }
  private async metadata(file: File): Promise<ReportObjectPin> {
    const [v] = await file.getMetadata();
    if (
      v.contentType !== "application/gzip" ||
      v.contentEncoding ||
      typeof v.generation !== "string" ||
      typeof v.metadata?.sha256 !== "string"
    )
      throw new Error("Invalid shared report generation metadata");
    return {
      key: file.name,
      generation: v.generation,
      sha256: v.metadata.sha256,
      size: Number(v.size),
      crc32c: String(v.crc32c),
    };
  }
  async find(key: string) {
    try {
      return await this.metadata(this.storage.bucket(this.bucket).file(key));
    } catch (e) {
      if (Number((e as { code?: unknown }).code) === 404) return null;
      throw e;
    }
  }
  async create(key: string, compressed: Buffer) {
    const { file } = await putImmutableReportObject(
      this.storage.bucket(this.bucket),
      key,
      { bytes: compressed },
      { sha256: sha256(compressed) },
    );
    return this.metadata(file);
  }
  async read(pin: ReportObjectPin, limit: number, signal?: AbortSignal) {
    checkReportObjectPin(pin, pin.key, limit);
    const file = pinExactGcsGeneration(
      this.storage.bucket(this.bucket).file(pin.key),
      pin.generation,
    );
    const actual = await this.metadata(file);
    if (
      actual.generation !== pin.generation ||
      actual.sha256 !== pin.sha256 ||
      actual.size !== pin.size ||
      actual.crc32c !== pin.crc32c
    )
      throw new Error("Shared report generation changed");
    const stream = file.createReadStream({
      validation: "crc32c",
      decompress: false,
    });
    if (signal) addAbortSignal(signal, stream);
    const chunks: Buffer[] = [];
    const hash = createHash("sha256"),
      crc = new CRC32C();
    let size = 0;
    for await (const bytes of stream) {
      const chunk = Buffer.from(bytes);
      size += chunk.length;
      if (size > pin.size)
        throw new Error("Shared report object exceeds its pinned size");
      hash.update(chunk);
      crc.update(chunk);
      chunks.push(chunk);
    }
    if (
      size !== pin.size ||
      hash.digest("hex") !== pin.sha256 ||
      crc.toString() !== pin.crc32c
    )
      throw new Error(
        "Shared report generation failed compressed-byte verification",
      );
    return Buffer.concat(chunks, size);
  }
}
