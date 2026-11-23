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

import { HubWorkloadGcs, boundedHubBody as body } from "./hub-workload-gcs";

export class PointHistoryHubStorage extends HubWorkloadGcs {
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
// A lost media/metadata response can follow a successful create-only upload.
// Report only explicit fetch/stream transport failures. Validation errors
// remain held, including a different owner, checksum or immutable generation.
function historyHubFailure(error: unknown, operation: unknown) {
  if (error instanceof HistoryOperationError) {
    return {
      operation: error.operation,
      category: error.category,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error && (operation === "put" || operation === "read")) {
    const code =
      (error.cause as { code?: unknown } | undefined)?.code ??
      (error as NodeJS.ErrnoException).code;
    if (
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      [
        "ETIMEDOUT",
        "ECONNRESET",
        "EAI_AGAIN",
        "UND_ERR_SOCKET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(String(code))
    ) {
      return {
        operation: "hub_history_" + operation + "_transport",
        category: "transport",
        retryable: true,
      };
    }
  }
  return { operation: "hub_history", category: "integrity", retryable: false };
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
        error: historyHubFailure(error, request.operation),
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
