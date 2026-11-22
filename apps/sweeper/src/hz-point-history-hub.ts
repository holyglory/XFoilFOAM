import { pathToFileURL } from "node:url";
import {
  HistoryMessages,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import {
  assertPointHistoryIdentity,
  historyArchiveIdentity,
  decodePointHistory,
  encodePointHistory,
  pointHistoryKey,
  type PointHistoryIdentity,
  type PointHistorySource,
} from "@aerodb/core/point-history-working-copy";

/** Hub-only metadata identity. No ADC, key files, impersonation or worker cloud identity. */
export class PointHistoryHubStorage {
  constructor(
    private readonly bucket: string,
    private readonly account: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (
      !/^[a-z0-9][a-z0-9_.-]{1,220}[a-z0-9]$/.test(bucket) ||
      !/^(?:[a-z0-9-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com|[0-9]+-compute@developer\.gserviceaccount\.com)$/.test(
        account,
      )
    )
      throw new Error("Invalid confirmed hub storage configuration");
  }
  private async token() {
    const base =
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/";
    const metadata = async (path: string) => {
      const r = await this.request(base + path, {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok || r.headers.get("Metadata-Flavor") !== "Google")
        throw new Error("Canonical hub workload identity unavailable");
      return (await body(r, 16384)).toString("utf8");
    };
    if ((await metadata("email")).trim() !== this.account)
      throw new Error("Canonical hub workload identity differs");
    const value = JSON.parse(await metadata("token"));
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      value.token_type !== "Bearer"
    )
      throw new Error("Invalid hub identity token");
    return value.access_token as string;
  }
  private async call(url: string, options: RequestInit = {}) {
    return this.request(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        ...options.headers,
        Authorization: `Bearer ${await this.token()}`,
        "Accept-Encoding": "identity",
      },
    });
  }
  private url(key: string, generation?: string) {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
    );
    if (generation) url.searchParams.set("generation", generation);
    return url;
  }
  async put(instance: string, source: PointHistorySource) {
    const encoded = encodePointHistory(instance, source),
      key = pointHistoryKey(instance, source, encoded.storedSha256);
    const format =
      source.sourceKind === "force_history"
        ? "solver-history-v1"
        : "result-history-v1";
    const boundary = `point-history-${encoded.storedSha256}`;
    const metadata = {
      name: key,
      contentType: "application/gzip",
      cacheControl: "private, max-age=31536000, immutable",
      metadata: { format, sha256: encoded.storedSha256 },
    };
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
      ),
      encoded.stored,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = new URL(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
    );
    url.searchParams.set("uploadType", "multipart");
    url.searchParams.set("ifGenerationMatch", "0");
    const uploaded = await this.call(url.toString(), {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: multipart as unknown as NonNullable<RequestInit["body"]>,
    });
    if (!uploaded.ok && uploaded.status !== 412) {
      await uploaded.body?.cancel();
      throw new HistoryOperationError(
        "hub_upload",
        uploaded.status === 429 || uploaded.status >= 500
          ? "transport"
          : uploaded.status === 401 || uploaded.status === 403
            ? "denied"
            : "integrity",
        uploaded.status === 429 || uploaded.status >= 500,
      );
    }
    await uploaded.body?.cancel();
    const response = await this.call(this.url(key).toString());
    const info = JSON.parse((await body(response, 65536)).toString("utf8"));
    const { stored: _bytes, ...hashes } = encoded;
    const identity = historyArchiveIdentity({
      ...source,
      ...hashes,
      sourceInstance: instance,
      bucket: this.bucket,
      objectKey: key,
      generation: info.generation,
      crc32c: String(info.crc32c),
      verifiedAt: new Date(),
    } as PointHistoryIdentity);
    const packed = await this.read(identity);
    if (!packed.equals(encoded.stored))
      throw new Error("Hub exact history readback differs");
    return { identity, packed };
  }
  async read(identity: PointHistoryIdentity) {
    assertPointHistoryIdentity(identity);
    if (identity.bucket !== this.bucket)
      throw new Error("Hub history bucket differs");
    const response = await this.call(
      this.url(identity.objectKey, identity.generation).toString(),
    );
    const metadata = JSON.parse((await body(response, 65536)).toString("utf8"));
    if (
      String(metadata.generation) !== identity.generation ||
      Number(metadata.size) !== identity.storedByteSize ||
      metadata.crc32c !== identity.crc32c ||
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding ||
      metadata.metadata?.sha256 !== identity.storedSha256 ||
      metadata.metadata?.format !==
        (identity.sourceKind === "force_history"
          ? "solver-history-v1"
          : "result-history-v1")
    )
      throw new Error("Pinned history metadata differs");
    const url = this.url(identity.objectKey, identity.generation);
    url.searchParams.set("alt", "media");
    const bytes = await body(
      await this.call(url.toString()),
      identity.storedByteSize,
    );
    decodePointHistory(bytes, identity);
    return bytes;
  }
}
async function body(response: Response, max: number) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new HistoryOperationError(
      "hub_storage",
      response.status === 429 || response.status >= 500
        ? "transport"
        : response.status === 401 || response.status === 403
          ? "denied"
          : "integrity",
      response.status === 429 || response.status >= 500,
    );
  }
  if (!response.body) throw new Error("Hub history body missing");
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.length;
      if (size > max) throw new Error("Hub history response exceeds bound");
      chunks.push(Buffer.from(value.value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function runHistoryHubSession(
  channel: HistoryMessages,
  bucket: string,
  createStore = (bucket: string, account: string) =>
    new PointHistoryHubStorage(bucket, account),
) {
  const config = await channel.read();
  if (config.bucket !== bucket)
    throw new HistoryOperationError("hub_bucket", "denied");
  const store = createStore(config.bucket, config.account);
  await channel.send({ id: config.id, result: { ready: true, protocol: 1 } });
  for (;;) {
    let request;
    try {
      request = await channel.read();
    } catch (error) {
      if (channel.ended) return;
      throw error;
    }
    if (request.operation === "close") return;
    try {
      if (request.operation === "put") {
        const result = await store.put(request.instance, request.source);
        await channel.send({
          id: request.id,
          result: {
            identity: result.identity,
            packed: result.packed.toString("base64"),
          },
        });
      } else if (request.operation === "read") {
        const bytes = await store.read(
          historyArchiveIdentity(request.identity),
        );
        await channel.send({
          id: request.id,
          result: { packed: bytes.toString("base64") },
        });
      } else throw new Error("Unknown history operation");
    } catch (error) {
      await channel.send({
        id: request.id,
        error:
          error instanceof HistoryOperationError
            ? {
                operation: error.operation,
                category: error.category,
                retryable: error.retryable,
              }
            : {
                operation: "hub_history",
                category: "integrity",
                retryable: false,
              },
      });
    }
  }
}
export async function runHistoryHub() {
  if ((process.env.AIRFOILFOAM_DEPLOYMENT_ROLE ?? "hub") !== "hub")
    throw new HistoryOperationError("hub_role", "denied");
  await runHistoryHubSession(
    new HistoryMessages(process.stdin, process.stdout),
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim() ?? "",
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runHistoryHub().catch(() => {
    process.stderr.write("Hub point history helper failed\n");
    process.exitCode = 1;
  });
