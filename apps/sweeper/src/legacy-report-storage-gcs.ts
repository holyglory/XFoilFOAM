import { createHash } from "node:crypto";

export interface LegacyBackupObject {
  bucket: string;
  objectKey: string;
  generation: string;
  sha256: string;
  byteSize: number;
  crc32c: string;
  verifiedAt: string;
}
export interface LegacyBackupStore {
  put(key: string, bytes: Buffer): Promise<LegacyBackupObject>;
  read(object: LegacyBackupObject): Promise<Buffer>;
}
export const legacySha256 = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export function assertLegacyObject(object: LegacyBackupObject): void {
  if (
    !/^[a-z0-9][a-z0-9_.-]{1,220}[a-z0-9]$/.test(object.bucket) ||
    !/^legacy-worker-reports\/v1\/[a-zA-Z0-9_.\/-]+\.jsonl\.gz$/.test(
      object.objectKey,
    ) ||
    object.objectKey.split("/").some((p) => !p || p === "." || p === "..") ||
    !/^[1-9][0-9]{0,19}$/.test(object.generation) ||
    !/^[a-f0-9]{64}$/.test(object.sha256) ||
    !Number.isSafeInteger(object.byteSize) ||
    object.byteSize < 1 ||
    object.byteSize > 512 * 1024 ** 2 ||
    !/^[A-Za-z0-9+/]{6}==$/.test(object.crc32c) ||
    !Number.isFinite(Date.parse(object.verifiedAt))
  )
    throw new Error("Invalid immutable legacy backup object");
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) throw new Error("Missing backup response body");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Backup response exceeds byte limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** No ADC, key file, impersonation, environment token or worker credential path.
 * security-assumptions.md: only the owner's canonical hub workload identity. */
export class LegacyHubGcsStore implements LegacyBackupStore {
  constructor(
    private readonly bucket: string,
    private readonly serviceAccount: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (
      (process.env.DEPLOYMENT_ROLE !== undefined &&
        process.env.DEPLOYMENT_ROLE !== "hub") ||
      !/^(?:[a-z0-9-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com|[0-9]+-compute@developer\.gserviceaccount\.com)$/.test(
        serviceAccount,
      )
    )
      throw new Error(
        "Run on the hub with its explicitly confirmed canonical service account",
      );
    if (!/^[a-z0-9][a-z0-9_.-]{1,220}[a-z0-9]$/.test(bucket))
      throw new Error("Invalid backup bucket");
  }

  private async token(): Promise<string> {
    const base =
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";
    const metadata = async (path: string) => {
      const response = await this.request(base + path, {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok || response.headers.get("Metadata-Flavor") !== "Google")
        throw new Error("Hub metadata workload identity is unavailable");
      return (await boundedBody(response, 16384)).toString("utf8");
    };
    if ((await metadata("email")).trim() !== this.serviceAccount)
      throw new Error("Canonical hub service-account identity mismatch");
    let data: { access_token?: string; token_type?: string };
    try {
      data = JSON.parse(await metadata("token"));
    } catch {
      throw new Error("Invalid metadata token response");
    }
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.token_type !== "Bearer"
    )
      throw new Error("Invalid metadata access token");
    return data.access_token;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    return this.request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: {
        ...init.headers,
        Authorization: `Bearer ${await this.token()}`,
        "Accept-Encoding": "identity",
      },
    });
  }

  private url(key: string, generation?: string): string {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
    );
    if (generation) url.searchParams.set("generation", generation);
    return url.toString();
  }

  async put(key: string, bytes: Buffer): Promise<LegacyBackupObject> {
    const sha256 = legacySha256(bytes);
    assertLegacyObject({
      bucket: this.bucket,
      objectKey: key,
      generation: "1",
      sha256,
      byteSize: bytes.length,
      crc32c: "AAAAAA==",
      verifiedAt: new Date().toISOString(),
    });
    if (!key.endsWith(`/${sha256}.jsonl.gz`))
      throw new Error("Backup key must be content addressed");
    const url = new URL(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
    );
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", key);
    url.searchParams.set("ifGenerationMatch", "0");
    const upload = await this.call(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/gzip" },
      body: bytes as unknown as NonNullable<RequestInit["body"]>,
    });
    // A crash after upload is safe: the immutable key is read and checked again.
    if (!upload.ok && upload.status !== 412)
      throw new Error(`Legacy backup upload failed (${upload.status})`);
    await upload.body?.cancel();
    const response = await this.call(this.url(key));
    if (!response.ok)
      throw new Error(`Legacy backup metadata failed (${response.status})`);
    const metadata = JSON.parse(
      (await boundedBody(response, 65536)).toString("utf8"),
    );
    if (
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding ||
      String(metadata.size) !== String(bytes.length)
    )
      throw new Error("Legacy backup metadata mismatch");
    const object: LegacyBackupObject = {
      bucket: this.bucket,
      objectKey: key,
      generation: String(metadata.generation),
      sha256,
      byteSize: bytes.length,
      crc32c: String(metadata.crc32c),
      verifiedAt: new Date().toISOString(),
    };
    assertLegacyObject(object);
    const restored = await this.read(object);
    if (!restored.equals(bytes))
      throw new Error("Legacy backup full readback mismatch");
    object.verifiedAt = new Date().toISOString();
    return object;
  }

  async read(object: LegacyBackupObject): Promise<Buffer> {
    assertLegacyObject(object);
    if (object.bucket !== this.bucket)
      throw new Error("Backup bucket mismatch");
    const metadataResponse = await this.call(
      this.url(object.objectKey, object.generation),
    );
    if (!metadataResponse.ok)
      throw new Error(
        `Pinned backup metadata unavailable (${metadataResponse.status})`,
      );
    const metadata = JSON.parse(
      (await boundedBody(metadataResponse, 65536)).toString("utf8"),
    );
    if (
      String(metadata.generation) !== object.generation ||
      String(metadata.size) !== String(object.byteSize) ||
      metadata.crc32c !== object.crc32c ||
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding
    )
      throw new Error("Pinned legacy backup metadata mismatch");
    const response = await this.call(
      this.url(object.objectKey, object.generation) + "&alt=media",
    );
    if (!response.ok)
      throw new Error(`Pinned backup unavailable (${response.status})`);
    const bytes = await boundedBody(response, object.byteSize);
    if (
      bytes.length !== object.byteSize ||
      legacySha256(bytes) !== object.sha256
    )
      throw new Error("Pinned legacy backup size/SHA256 mismatch");
    return bytes;
  }
}
