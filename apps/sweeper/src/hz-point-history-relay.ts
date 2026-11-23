import { readFileSync } from "node:fs";
import {
  LEGACY_HZ_FENCE_PROBE,
  hzFenceProgram,
} from "./hz-attempt-fence-probe";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  HistoryMessages,
  boundedPacked,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import {
  decodePointHistory,
  historyArchiveIdentity,
  pointHistoryIdentityDigest,
  type PointHistoryIdentity,
  type PointHistoryKind,
  POINT_HISTORY_KINDS,
} from "@aerodb/core/point-history-working-copy";
import type {
  HistorySelection,
  PreparedHistory,
  HistoryCustodyResult,
  HistoryCursor,
} from "@aerodb/db/hz-point-history-storage";

export interface HZRelayOptions {
  hzHost: string;
  hzSweeperContainer: string;
  hzApiContainer: string;
  hubHost: string;
  hubSweeperContainer: string;
  bucket: string;
  hubServiceAccount: string;
  sourceInstance?: string;
  kind: PointHistoryKind | "all";
  limit: number;
  maxBytes: number;
}
const HOST = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export function validateRelayOptions(value: HZRelayOptions) {
  if (
    !HOST.test(value.hzHost) ||
    !HOST.test(value.hubHost) ||
    [
      value.hzSweeperContainer,
      value.hzApiContainer,
      value.hubSweeperContainer,
    ].some((name) => !CONTAINER.test(name)) ||
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 32 ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > 64 * 1024 * 1024 ||
    (value.kind !== "all" && !POINT_HISTORY_KINDS.includes(value.kind))
  )
    throw new HistoryOperationError("options", "input");
}
export const HZ_ORIGINAL_VERSION_READ = Symbol("hzOriginalVersionRead");
export class HistorySshEndpoint {
  private child: ChildProcessWithoutNullStreams;
  private wire: HistoryMessages;
  private stderr = "";
  private ended: Promise<unknown>;
  constructor(
    host: string,
    container: string,
    entry:
      | string
      | typeof LEGACY_HZ_FENCE_PROBE
      | typeof HZ_ORIGINAL_VERSION_READ,
    write = false,
  ) {
    if (
      !HOST.test(host) ||
      !CONTAINER.test(container) ||
      (typeof entry !== "string"
        ? write ||
          (entry !== LEGACY_HZ_FENCE_PROBE &&
            entry !== HZ_ORIGINAL_VERSION_READ)
        : !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.ts$/.test(entry))
    )
      throw new HistoryOperationError("ssh_target", "input");
    const program =
      entry === LEGACY_HZ_FENCE_PROBE
        ? hzFenceProgram
        : entry === HZ_ORIGINAL_VERSION_READ
          ? readFileSync(
              new URL(
                "./hz-attempt-original-version-worker.mjs",
                import.meta.url,
              ),
              "utf8",
            ) + "\nawait serveOriginalVersion();"
          : null;
    const command =
      program !== null
        ? `docker exec -i ${container} node --import tsx --input-type=module -e '${program.replaceAll("'", "'\\''")}'`
        : `docker exec -i ${container} node --import tsx ${String(entry)}`;
    this.child = spawn(
      "ssh",
      [
        "-T",
        "-C",
        "-oBatchMode=yes",
        "-oForwardAgent=no",
        "-oClearAllForwardings=yes",
        "-oStrictHostKeyChecking=yes",
        "-oConnectTimeout=10",
        "-oServerAliveInterval=15",
        "-oServerAliveCountMax=3",
        host,
        write || entry === HZ_ORIGINAL_VERSION_READ
          ? `flock -s -w 15 -E 75 /tmp/airfoils-pro-deploy.lock ${command}`
          : command,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.on("error", () => {
      this.child.stdout.destroy();
    });
    this.ended = once(this.child, "close").catch(() => undefined);
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.length < 8192)
        this.stderr += chunk
          .toString("utf8")
          .slice(0, 8192 - this.stderr.length);
    });
    this.wire = new HistoryMessages(this.child.stdout, this.child.stdin);
  }
  async ask(request: Record<string, unknown>, timeout = 180000) {
    const id = randomUUID();
    try {
      await this.wire.send({ ...request, id });
      const response = await this.wire.read(timeout);
      if (response.id !== id)
        throw new HistoryOperationError("response", "integrity");
      if (response.error) {
        const category = response.error.category;
        const operation = String(response.error.operation ?? "worker");
        if (
          category === "transport" &&
          response.error.retryable === true &&
          operation === "worker_transfer_paused"
        )
          throw new HistoryOperationError(operation, "transfer_paused", true);
        if (
          category === "transport" &&
          response.error.retryable === true &&
          /^(worker_(hello|status|scan|prepare|apply)|attempt_(bound|page|pending|prepare|stage|replay|commit|confirm|restore|science|catalog)|original_(bound|inventory|prepare|register))_(lock_timeout|serialization|deadlock)$/.test(
            operation,
          )
        )
          throw new HistoryOperationError(operation, "database_busy", true);
        throw new HistoryOperationError(
          operation,
          category === "denied"
            ? "denied"
            : category === "transport"
              ? "transport"
              : "integrity",
          category === "transport" && response.error.retryable === true,
        );
      }
      if (!Object.hasOwn(response, "result"))
        throw new HistoryOperationError("response", "integrity");
      return response.result;
    } catch (error) {
      if (
        error instanceof HistoryOperationError &&
        error.category !== "transport"
      )
        throw error;
      // EPIPE on the first write can precede stdout EOF, the exit status
      // and stderr. Allow the child close event to deliver its sanitized cause.
      await Promise.race([
        this.ended,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
      if (this.child.exitCode === 75)
        throw new HistoryOperationError("deploy_lock", "deployment_busy", true);
      if (
        /permission denied|host key verification|identification has changed|authentication failed/i.test(
          this.stderr,
        )
      )
        throw new HistoryOperationError("ssh", "denied");
      if (
        this.child.exitCode === 1 &&
        /(?:container [a-z0-9_.-]{1,128} is (?:not running|restarting)|cannot exec in a stopped container)/i.test(
          this.stderr,
        )
      )
        throw new HistoryOperationError("container_restart", "transport", true);
      if (
        this.child.exitCode !== null &&
        this.child.exitCode !== 255 &&
        ![137, 143].includes(this.child.exitCode)
      )
        throw new HistoryOperationError("remote_helper", "input");
      throw new HistoryOperationError("ssh", "transport", true);
    }
  }
  async close() {
    this.wire.close();
    const term = setTimeout(() => this.child.kill("SIGTERM"), 2000),
      kill = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    try {
      await this.ended;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}
export function openHistoryWorker(
  host: string,
  container: string,
  write = false,
) {
  return new HistorySshEndpoint(
    host,
    container,
    "/app/apps/sweeper/src/hz-point-history-custody-cli.ts",
    write,
  );
}
export interface HistoryRelayServices {
  prepare(selection: HistorySelection): Promise<PreparedHistory>;
  put(
    source: NonNullable<PreparedHistory["source"]>,
    instance: string,
  ): Promise<{ identity: PointHistoryIdentity; packed: Buffer }>;
  read(identity: PointHistoryIdentity): Promise<Buffer>;
  store(identity: PointHistoryIdentity, packed: Buffer): Promise<unknown>;
  releaseWriteLock?(): Promise<void>;
  apiRead(
    identity: PointHistoryIdentity,
    throughCatalog?: boolean,
  ): Promise<{
    throughCatalog: boolean;
    identityDigest: string;
    sourceSha256: string;
    sourceByteSize: number;
    checkedAt: string;
  }>;
  apply(
    identity: PointHistoryIdentity,
    proof: unknown,
    hubReadbackAt: string,
  ): Promise<HistoryCustodyResult>;
}
export interface HistoryRelayReceipt {
  version: 1;
  selection: HistorySelection;
  identity: PointHistoryIdentity;
  hubReadbackAt: string;
}
/** Also used to retry a receipt after acknowledgement loss, without fetching
 * a new generation. Recording this receipt precedes every source write. */
export async function migrateHzHistory(
  selection: HistorySelection,
  instance: string,
  services: HistoryRelayServices,
  save: (receipt: HistoryRelayReceipt) => Promise<void>,
  pending?: HistoryRelayReceipt,
) {
  if (
    pending &&
    (pending.version !== 1 ||
      pending.selection.id !== selection.id ||
      pending.selection.kind !== selection.kind)
  )
    throw new HistoryOperationError("pending_receipt", "integrity");
  const prepared = await services.prepare(selection);
  const prior = prepared.prior && historyArchiveIdentity(prepared.prior);
  let identity: PointHistoryIdentity;
  let uploaded: Buffer | undefined;
  if (pending || prior) {
    identity = pending ? historyArchiveIdentity(pending.identity) : prior!;
    if (
      prior &&
      pointHistoryIdentityDigest(prior) !== pointHistoryIdentityDigest(identity)
    )
      throw new HistoryOperationError("conflicting_receipt", "integrity");
  } else {
    if (!prepared.source)
      throw new HistoryOperationError("source", "integrity");
    const result = await services.put(prepared.source, instance);
    identity = historyArchiveIdentity(result.identity);
    uploaded = result.packed;
  }
  // Always reopen the selected generation, including a catalog entry left by
  // an earlier upload. Only a new upload has a second byte stream to compare.
  const packed = await services.read(identity);
  if (uploaded && !uploaded.equals(packed))
    throw new HistoryOperationError("hub_readback", "integrity");
  const restored = decodePointHistory(packed, identity);
  if (
    (identity.sourceInstance !== instance &&
      (!prior ||
        pointHistoryIdentityDigest(prior) !==
          pointHistoryIdentityDigest(identity))) ||
    identity.sourceKind !== selection.kind ||
    (identity.sourceKind === "force_history"
      ? identity.sourceId
      : identity.resultId) !== selection.id ||
    (prepared.source &&
      (restored.payloadText !== prepared.source.payloadText ||
        restored.resultId !== prepared.source.resultId ||
        restored.resultAttemptId !== prepared.source.resultAttemptId))
  )
    throw new HistoryOperationError("custody_identity", "integrity");
  const hubReadbackAt = new Date().toISOString();
  if (!pending) await save({ version: 1, selection, identity, hubReadbackAt });
  try {
    const saved = (await services.store(identity, packed)) as {
      verified?: boolean;
      storedSha256?: string;
      storedByteSize?: number;
    };
    if (
      !saved?.verified ||
      saved.storedSha256 !== identity.storedSha256 ||
      saved.storedByteSize !== packed.length
    )
      throw new HistoryOperationError("worker_store", "integrity");
    const api = await services.apiRead(identity);
    if (
      api.identityDigest !== pointHistoryIdentityDigest(identity) ||
      api.sourceSha256 !== identity.sourceSha256 ||
      api.sourceByteSize !== identity.sourceByteSize
    )
      throw new HistoryOperationError("api_readback", "integrity");
    const result = await services.apply(identity, api, hubReadbackAt);
    if (
      result.id !== selection.id ||
      result.kind !== selection.kind ||
      pointHistoryIdentityDigest(historyArchiveIdentity(result.identity)) !==
        pointHistoryIdentityDigest(identity)
    )
      throw new HistoryOperationError("commit_receipt", "integrity");
    // Real API read-through after commit; retries reuse the immutable receipt.
    const post = await services.apiRead(identity, !result.inlineRetained);
    if (
      post.throughCatalog !== !result.inlineRetained ||
      post.identityDigest !== api.identityDigest ||
      post.sourceSha256 !== api.sourceSha256
    )
      throw new HistoryOperationError("api_postcommit", "integrity");
    return {
      ...result,
      identity: historyArchiveIdentity(result.identity),
      api: post,
    };
  } finally {
    await services.releaseWriteLock?.();
  }
}

/** Operator acceptance uses only the recorded generation and normal API reader. */
export async function verifyStoredHzHistory(
  selection: HistorySelection,
  services: HistoryRelayServices,
) {
  const prepared = await services.prepare(selection);
  if (!prepared.prior || prepared.source !== null)
    throw new HistoryOperationError("stored_pointer", "input");
  const identity = historyArchiveIdentity(prepared.prior);
  const restored = decodePointHistory(await services.read(identity), identity);
  const api = await services.apiRead(identity, true);
  if (
    !api.throughCatalog ||
    api.identityDigest !== pointHistoryIdentityDigest(identity) ||
    api.sourceSha256 !== identity.sourceSha256 ||
    api.sourceByteSize !== Buffer.byteLength(restored.payloadText)
  )
    throw new HistoryOperationError("verify", "integrity");
  return { verified: true, selection, archive: identity, api };
}
export class HzHistoryConnections {
  private worker: HistorySshEndpoint;
  private hub?: HistorySshEndpoint;
  private api?: HistorySshEndpoint;
  private hubReady = false;
  private writer?: HistorySshEndpoint;
  constructor(readonly options: HZRelayOptions) {
    validateRelayOptions(options);
    this.worker = openHistoryWorker(options.hzHost, options.hzSweeperContainer);
  }
  async hello() {
    const value = await this.worker.ask({ operation: "hello" });
    if (
      value.protocol !== 1 ||
      (this.options.sourceInstance &&
        value.instance !== this.options.sourceInstance)
    )
      throw new HistoryOperationError("worker_instance", "integrity");
    return value as { instance: string; high: HistoryCursor };
  }
  async scan(input: unknown) {
    return this.worker.ask({ operation: "scan", input }) as Promise<{
      items: HistorySelection[];
      after: string | null;
      done: boolean;
      oversized: number;
    }>;
  }
  private async cloud(request: Record<string, unknown>) {
    this.hub ??= new HistorySshEndpoint(
      this.options.hubHost,
      this.options.hubSweeperContainer,
      "/app/apps/sweeper/src/hz-point-history-hub.ts",
    );
    if (!this.hubReady) {
      const hello = await this.hub.ask({
        bucket: this.options.bucket,
        account: this.options.hubServiceAccount,
      });
      if (hello?.ready !== true)
        throw new HistoryOperationError("hub_hello", "integrity");
      this.hubReady = true;
    }
    return this.hub.ask(request);
  }
  services(): HistoryRelayServices {
    return {
      prepare: (selection) =>
        this.worker.ask({ operation: "prepare", selection }),
      put: async (source, instance) => {
        const value = await this.cloud({ operation: "put", instance, source });
        return {
          identity: value.identity,
          packed: boundedPacked(value.packed),
        };
      },
      read: async (identity) =>
        boundedPacked(
          (await this.cloud({ operation: "read", identity })).packed,
        ),
      releaseWriteLock: () => this.releaseWriter(),
      store: (identity, packed) =>
        this.write({
          operation: "store",
          identity,
          packed: packed.toString("base64"),
        }),
      apiRead: async (identity, throughCatalog = false) => {
        this.api ??= new HistorySshEndpoint(
          this.options.hzHost,
          this.options.hzApiContainer,
          "/app/apps/api/src/hz-point-history-verify-cli.ts",
        );
        return this.api.ask({ identity, throughCatalog });
      },
      apply: (identity, apiReadback, hubReadbackAt) =>
        this.write({
          operation: "apply",
          identity,
          apiReadback,
          hubReadbackAt,
        }) as Promise<HistoryCustodyResult>,
    };
  }
  private async write(request: Record<string, unknown>) {
    this.writer ??= openHistoryWorker(
      this.options.hzHost,
      this.options.hzSweeperContainer,
      true,
    );
    return this.writer.ask(request);
  }
  private async releaseWriter() {
    const writer = this.writer;
    this.writer = undefined;
    await writer?.close();
  }
  async close() {
    await Promise.all([
      this.worker.close(),
      this.hub?.close(),
      this.api?.close(),
      this.releaseWriter(),
    ]);
  }
}
