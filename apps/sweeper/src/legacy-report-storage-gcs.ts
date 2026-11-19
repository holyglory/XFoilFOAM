import { createHash } from "node:crypto";

export type LegacyStorageOperation =
  | "hub_put"
  | "hub_read"
  | "hub_identity"
  | "gcs_upload"
  | "gcs_metadata"
  | "gcs_download"
  | "worker_read"
  | "worker_sql"
  | "worker_custody"
  | "worker_volume"
  | "operator_cli"
  | "save_proof"
  | "apply_verified_page"
  | "checkpoint_write"
  | "checkpoint_read";
export type LegacyStorageCategory =
  | "ssh_disconnected"
  | "ssh_timeout"
  | "container_restarting"
  | "gcs_rate_limited"
  | "gcs_server_error"
  | "credentials_denied"
  | "host_key_denied"
  | "bad_input"
  | "integrity"
  | "protocol_error"
  | "operation_failed"
  | "local_name_too_long"
  | "local_space_exhausted"
  | "local_io_failure";
export interface LegacyStorageFailureDetails {
  operation: LegacyStorageOperation;
  category: LegacyStorageCategory;
  exitCode: number | null;
  signal: string | null;
  httpStatus: number | null;
  localCode: string | null;
}
const operations = new Set<string>([
  "hub_put",
  "hub_read",
  "hub_identity",
  "gcs_upload",
  "gcs_metadata",
  "gcs_download",
  "worker_read",
  "worker_sql",
  "worker_custody",
  "worker_volume",
  "operator_cli",
  "save_proof",
  "apply_verified_page",
  "checkpoint_write",
  "checkpoint_read",
]);
const categories = new Set<string>([
  "ssh_disconnected",
  "ssh_timeout",
  "container_restarting",
  "gcs_rate_limited",
  "gcs_server_error",
  "credentials_denied",
  "host_key_denied",
  "bad_input",
  "integrity",
  "protocol_error",
  "operation_failed",
  "local_name_too_long",
  "local_space_exhausted",
  "local_io_failure",
]);
const transientCategories = new Set<LegacyStorageCategory>([
  "ssh_disconnected",
  "ssh_timeout",
  "container_restarting",
  "gcs_rate_limited",
  "gcs_server_error",
]);
export class LegacyStorageOperationError extends Error {
  readonly details: LegacyStorageFailureDetails;
  readonly retryable: boolean;
  constructor(input: {
    operation: unknown;
    category: unknown;
    exitCode?: unknown;
    signal?: unknown;
    httpStatus?: unknown;
    localCode?: unknown;
  }) {
    const operation = (
      operations.has(String(input.operation)) ? input.operation : "operator_cli"
    ) as LegacyStorageOperation;
    const category = (
      operations.has(String(input.operation)) &&
      categories.has(String(input.category))
        ? input.category
        : "protocol_error"
    ) as LegacyStorageCategory;
    super(`Legacy storage operation failed: ${operation}/${category}`);
    this.name = "LegacyStorageOperationError";
    this.details = {
      operation,
      category,
      exitCode:
        typeof input.exitCode === "number" &&
        Number.isInteger(input.exitCode) &&
        input.exitCode >= 0 &&
        input.exitCode <= 255
          ? input.exitCode
          : null,
      signal:
        typeof input.signal === "string" &&
        /^SIG[A-Z0-9]{1,12}$/.test(input.signal)
          ? input.signal
          : null,
      httpStatus:
        typeof input.httpStatus === "number" &&
        Number.isInteger(input.httpStatus) &&
        input.httpStatus >= 100 &&
        input.httpStatus <= 599
          ? input.httpStatus
          : null,
      localCode: [
        "ENAMETOOLONG",
        "ENOSPC",
        "EIO",
        "EROFS",
        "EACCES",
        "EDQUOT",
      ].includes(String(input.localCode))
        ? String(input.localCode)
        : null,
    };
    this.retryable = transientCategories.has(category);
  }
}
export function legacyLocalStorageError(
  operation: LegacyStorageOperation,
  error: unknown,
): LegacyStorageOperationError | null {
  const code = (error as { code?: unknown })?.code;
  if (
    !["ENAMETOOLONG", "ENOSPC", "EIO", "EROFS", "EACCES", "EDQUOT"].includes(
      String(code),
    )
  )
    return null;
  return new LegacyStorageOperationError({
    operation,
    category:
      code === "ENAMETOOLONG"
        ? "local_name_too_long"
        : code === "ENOSPC" || code === "EDQUOT"
          ? "local_space_exhausted"
          : "local_io_failure",
    localCode: code,
  });
}
export function legacySshOperationError(
  operation: LegacyStorageOperation,
  error: unknown,
  stderr: string | Buffer = "",
  provenTarget = false,
): LegacyStorageOperationError {
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
  };
  const text = stderr.toString().slice(0, 16384);
  let category: LegacyStorageCategory = "operation_failed";
  if (
    /host key verification failed|remote host identification has changed|offending .* key/i.test(
      text,
    )
  )
    category = "host_key_denied";
  else if (
    /permission denied|authentication failed|too many authentication|no supported authentication|unprotected private key|bad owner or permissions|sign_and_send_pubkey.*failed/i.test(
      text,
    )
  )
    category = "credentials_denied";
  else if (
    /no such container|container .* (?:is restarting|is not running|is paused)|cannot exec in a stopped/i.test(
      text,
    )
  )
    category = provenTarget ? "container_restarting" : "bad_input";
  else if (
    /connection reset|connection closed|broken pipe|connection to .* closed|network is unreachable|no route to host|connection refused|temporary failure in name resolution/i.test(
      text,
    )
  )
    category = "ssh_disconnected";
  else if (
    /connection timed out|operation timed out/i.test(text) ||
    failure.killed === true
  )
    category = "ssh_timeout";
  else if (
    failure.code === "ENOENT" ||
    /could not resolve hostname|invalid port|unknown option|no such file or directory/i.test(
      text,
    )
  )
    category = "bad_input";
  return new LegacyStorageOperationError({
    operation,
    category,
    exitCode: failure.code,
    signal: failure.signal,
  });
}
function httpFailure(
  operation: LegacyStorageOperation,
  status: number,
): LegacyStorageOperationError {
  return new LegacyStorageOperationError({
    operation,
    httpStatus: status,
    category:
      status === 429
        ? "gcs_rate_limited"
        : status >= 500 && status <= 599
          ? "gcs_server_error"
          : status === 401 || status === 403
            ? "credentials_denied"
            : status === 404 && operation !== "gcs_upload"
              ? "integrity"
              : "operation_failed",
  });
}
function fetchFailure(
  operation: LegacyStorageOperation,
  error: unknown,
): LegacyStorageOperationError {
  if (error instanceof LegacyStorageOperationError) return error;
  const value = error as {
    name?: string;
    cause?: { code?: string; message?: string };
  };
  const code = value.cause?.code;
  const category: LegacyStorageCategory = /redirect/i.test(
    value.cause?.message ?? "",
  )
    ? "protocol_error"
    : value.name === "AbortError" ||
        value.name === "TimeoutError" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_CONNECT_TIMEOUT"
      ? "ssh_timeout"
      : [
            "ECONNRESET",
            "ECONNREFUSED",
            "EPIPE",
            "ENETUNREACH",
            "EAI_AGAIN",
            "UND_ERR_SOCKET",
          ].includes(code ?? "")
        ? "ssh_disconnected"
        : "operation_failed";
  return new LegacyStorageOperationError({ operation, category });
}

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
  acceptVerifiedTransportHistory?(): void;
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
      let response: Response;
      try {
        response = await this.request(base + path, {
          headers: { "Metadata-Flavor": "Google" },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        throw fetchFailure("hub_identity", error);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw httpFailure("hub_identity", response.status);
      }
      if (response.headers.get("Metadata-Flavor") !== "Google")
        throw new LegacyStorageOperationError({
          operation: "hub_identity",
          category: "credentials_denied",
        });
      try {
        return (await boundedBody(response, 16384)).toString("utf8");
      } catch (error) {
        throw fetchFailure("hub_identity", error);
      }
    };
    if ((await metadata("email")).trim() !== this.serviceAccount)
      throw new LegacyStorageOperationError({
        operation: "hub_identity",
        category: "credentials_denied",
      });
    const token = await metadata("token");
    let data: { access_token?: string; token_type?: string };
    try {
      data = JSON.parse(token);
    } catch {
      throw new LegacyStorageOperationError({
        operation: "hub_identity",
        category: "protocol_error",
      });
    }
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.token_type !== "Bearer"
    )
      throw new LegacyStorageOperationError({
        operation: "hub_identity",
        category: "credentials_denied",
      });
    return data.access_token;
  }
  private async call(
    url: string,
    init: RequestInit = {},
    operation: LegacyStorageOperation = "gcs_metadata",
  ): Promise<Response> {
    try {
      return await this.request(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(120000),
        headers: {
          ...init.headers,
          Authorization: `Bearer ${await this.token()}`,
          "Accept-Encoding": "identity",
        },
      });
    } catch (error) {
      throw fetchFailure(operation, error);
    }
  }
  private async body(
    response: Response,
    limit: number,
    operation: LegacyStorageOperation,
  ): Promise<Buffer> {
    if (!response.ok) {
      await response.body?.cancel();
      throw httpFailure(operation, response.status);
    }
    try {
      return await boundedBody(response, limit);
    } catch (error) {
      throw fetchFailure(operation, error);
    }
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
      throw new LegacyStorageOperationError({
        operation: "gcs_upload",
        category: "bad_input",
      });
    const url = new URL(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
    );
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", key);
    url.searchParams.set("ifGenerationMatch", "0");
    const upload = await this.call(
      url.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: bytes as unknown as NonNullable<RequestInit["body"]>,
      },
      "gcs_upload",
    );
    // A crash after upload is safe: the immutable key is read and checked again.
    if (!upload.ok && upload.status !== 412) {
      await upload.body?.cancel();
      throw httpFailure("gcs_upload", upload.status);
    }
    await upload.body?.cancel();
    const response = await this.call(this.url(key));
    const metadata = JSON.parse(
      (await this.body(response, 65536, "gcs_metadata")).toString("utf8"),
    );
    if (
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding ||
      String(metadata.size) !== String(bytes.length)
    )
      throw new LegacyStorageOperationError({
        operation: "gcs_metadata",
        category: "integrity",
      });
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
      throw new LegacyStorageOperationError({
        operation: "gcs_download",
        category: "integrity",
      });
    object.verifiedAt = new Date().toISOString();
    return object;
  }

  async read(object: LegacyBackupObject): Promise<Buffer> {
    assertLegacyObject(object);
    if (object.bucket !== this.bucket)
      throw new LegacyStorageOperationError({
        operation: "gcs_download",
        category: "bad_input",
      });
    const metadataResponse = await this.call(
      this.url(object.objectKey, object.generation),
    );
    const metadata = JSON.parse(
      (await this.body(metadataResponse, 65536, "gcs_metadata")).toString(
        "utf8",
      ),
    );
    if (
      String(metadata.generation) !== object.generation ||
      String(metadata.size) !== String(object.byteSize) ||
      metadata.crc32c !== object.crc32c ||
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding
    )
      throw new LegacyStorageOperationError({
        operation: "gcs_metadata",
        category: "integrity",
      });
    const response = await this.call(
      this.url(object.objectKey, object.generation) + "&alt=media",
      {},
      "gcs_download",
    );
    const bytes = await this.body(response, object.byteSize, "gcs_download");
    if (
      bytes.length !== object.byteSize ||
      legacySha256(bytes) !== object.sha256
    )
      throw new LegacyStorageOperationError({
        operation: "gcs_download",
        category: "integrity",
      });
    return bytes;
  }
}
