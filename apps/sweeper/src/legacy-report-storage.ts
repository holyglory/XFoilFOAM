import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  lstat,
  link,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  readNormalizedPrefix,
  type NormalizedPrefix,
} from "./legacy-report-normalized-batch";
import { LegacyResultTransport } from "./legacy-report-result-transport";

import {
  assertLegacyScope,
  legacyBound,
  legacyKeysSql,
  legacyMemberSql,
  legacyReadOnlySql,
  type LegacyReportMember,
  type LegacyReportScope,
  type LegacyReportKind,
} from "@aerodb/db/legacy-report-storage";
import {
  legacySha256,
  LegacyStorageOperationError,
  legacySshOperationError,
  legacyLocalStorageError,
  type LegacyBackupObject,
  type LegacyBackupStore,
} from "./legacy-report-storage-gcs";

import {
  checkLegacyMember,
  encodeLegacyPage,
  decodeLegacyPage,
  inspectLegacyPage,
  sameLegacyCursor as sameCursor,
  type LegacyCursor,
  type LegacyBackupPage,
  type LegacyBackupReceipt,
} from "@aerodb/db/legacy-report-storage-codec";
export {
  checkLegacyMember,
  encodeLegacyPage,
  decodeLegacyPage,
  inspectLegacyPage,
  readLegacyPageMember,
} from "@aerodb/db/legacy-report-storage-codec";
export type {
  LegacyCursor,
  LegacyBackupPage,
  LegacyBackupReceipt,
} from "@aerodb/db/legacy-report-storage-codec";

export interface LegacySqlReader {
  acceptVerifiedTransportHistory?(): void;
  query(sql: string, maxBytes: number): Promise<Record<string, unknown>[]>;
  readNormalizedPrefix?(
    executionId: string,
    sequences: number[],
    maxBytes: number,
  ): Promise<NormalizedPrefix | null>;
  readMember?(
    executionId: string,
    kind: LegacyReportKind,
    sequence: number,
    maxBytes: number,
  ): Promise<Record<string, unknown>[]>;
}
export interface LegacyPageApplyStats {
  sourceDatabaseWrites: boolean | null;
  sourceReportRowsVerified: number | null;
  sourceReportBodiesRetained: number | null;
  rowsNewlyNormalized: number | null;
  archiveMembersReleased: number | null;
  migrationTransactionsCommitted: number | null;
  reportRowsVerified?: number | null;
  archiveMembersVerified?: number | null;
}
export const legacyScopeHash = (scope: LegacyReportScope) =>
  legacySha256(JSON.stringify(scope));
const initialCursor = (scope: LegacyReportScope): LegacyCursor => ({
  execution: 0,
  kind: "report",
  after: scope.executions[0].reportAfter ?? 0,
  copied: 0,
});

/** Existing SSH principal/config only; no commands, keys or credentials are copied to HZ. */
export class LegacySshReader implements LegacySqlReader {
  readonly command: string;
  private provenTarget = false;
  private stderrText = "";
  acceptVerifiedTransportHistory() {
    this.provenTarget = true;
  }
  private readonly resultTransport = new LegacyResultTransport(this);
  get resultTransportStats() {
    return { ...this.resultTransport.stats };
  }
  connectionCount = 0;
  queryCount = 0;
  responseBytes = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private active: {
    marker: string;
    text: string;
    tail: string;
    bytes: number;
    maxBytes: number;
    decoder: StringDecoder;
    resolve: (rows: Record<string, unknown>[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  constructor(
    readonly host: string,
    container: string,
    user = "aerodb",
    database = "aerodb",
  ) {
    if (
      !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) ||
      [container, user, database].some(
        (v) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v),
      )
    )
      throw new Error(
        "Use an existing SSH host alias and exact PostgreSQL container/user/database",
      );
    this.command = `docker exec -i ${container} psql -X -w -qAt -v ON_ERROR_STOP=1 -U ${user} -d ${database}`;
  }
  private connect(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(
      "ssh",
      [
        "-T",
        "-C",
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        "-oConnectTimeout=10",
        "-oServerAliveInterval=15",
        "-oServerAliveCountMax=3",
        this.host,
        this.command,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    this.connectionCount++;
    this.stderrText = "";
    child.stderr.on("data", (bytes: Buffer) => {
      if (this.stderrText.length < 16384)
        this.stderrText = (this.stderrText + bytes.toString("utf8")).slice(
          0,
          16384,
        );
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (error) =>
      this.fail(
        legacySshOperationError(
          "worker_read",
          error,
          this.stderrText,
          this.provenTarget,
        ),
      ),
    );
    child.on("close", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.fail(
          code === 0
            ? new LegacyStorageOperationError({
                operation: "worker_read",
                category: this.provenTarget
                  ? "ssh_disconnected"
                  : "protocol_error",
                exitCode: code,
                signal,
              })
            : legacySshOperationError(
                "worker_read",
                { code, signal },
                this.stderrText,
                this.provenTarget,
              ),
        );
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const active = this.active;
      if (!active) return;
      this.responseBytes += chunk.length;
      active.bytes += chunk.length;
      if (active.bytes > active.maxBytes + 128) {
        this.fail("Read-only HZ response exceeded byte bound");
        child.kill("SIGTERM");
        return;
      }
      const decoded = active.decoder.write(chunk);
      active.text += decoded;
      const marker = active.marker + "\n";
      active.tail = (active.tail + decoded).slice(-marker.length - 1);
      if (!active.tail.endsWith(marker)) return;
      const index = active.text.length - marker.length;
      if (index > 0 && active.text[index - 1] !== "\n") return;
      const text = active.text.slice(0, index);
      clearTimeout(active.timer);
      this.active = null;
      try {
        this.provenTarget = true;
        active.resolve(
          text
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      } catch {
        active.reject(
          new LegacyStorageOperationError({
            operation: "worker_read",
            category: "protocol_error",
          }),
        );
      }
    });
    return child;
  }
  private fail(message: string | Error) {
    const active = this.active;
    if (active) {
      clearTimeout(active.timer);
      this.active = null;
      active.reject(
        message instanceof Error
          ? message
          : new LegacyStorageOperationError({
              operation: "worker_read",
              category: "integrity",
            }),
      );
    }
  }
  async query(
    sql: string,
    maxBytes: number,
  ): Promise<Record<string, unknown>[]> {
    if (
      !sql.startsWith(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;",
      )
    )
      throw new Error("SSH is restricted to generated read-only SQL");
    legacyBound(maxBytes, 2 * 1024 ** 3, "SSH output bytes");
    if (this.active)
      throw new Error(
        "Concurrent queries on one report-copy session are unsupported",
      );
    const child = this.connect();
    this.queryCount++;
    return new Promise((resolve, reject) => {
      const marker = "LEGACY_REPORT_QUERY_" + randomUUID().replace(/-/g, "");
      const timer = setTimeout(() => {
        this.fail(
          new LegacyStorageOperationError({
            operation: "worker_read",
            category: "ssh_timeout",
            signal: "SIGTERM",
          }),
        );
        child.kill("SIGTERM");
      }, 45000);
      this.active = {
        marker,
        text: "",
        tail: "",
        bytes: 0,
        maxBytes,
        decoder: new StringDecoder("utf8"),
        resolve,
        reject,
        timer,
      };
      child.stdin.write(sql + "\n\\echo " + marker + "\n");
    });
  }
  async readNormalizedPrefix(
    executionId: string,
    keys: number[],
    budget: number,
  ) {
    const prefix = await readNormalizedPrefix(this, executionId, keys, budget);
    if (prefix) {
      const stats = this.resultTransport.stats;
      stats.definitions++;
      stats.reuses += prefix.members.length - 1;
      stats.resultBytesReceived += prefix.dictionaryBytes;
      stats.decodedBytes += prefix.decodedBytes;
    }
    return prefix;
  }
  readMember(
    executionId: string,
    kind: LegacyReportKind,
    sequence: number,
    maxBytes: number,
  ) {
    return this.resultTransport.readMember(
      executionId,
      kind,
      sequence,
      maxBytes,
    );
  }
  async close(): Promise<void> {
    this.resultTransport.clear();
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise<void>((resolve) => {
      const term = setTimeout(() => child.kill("SIGTERM"), 3000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("close", () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
    });
  }
}

function checkCursor(scope: LegacyReportScope, cursor: LegacyCursor): void {
  legacyBound(cursor.execution, scope.executions.length, "execution cursor", 0);
  legacyBound(cursor.after, Number.MAX_SAFE_INTEGER, "sequence cursor", 0);
  legacyBound(cursor.copied, Number.MAX_SAFE_INTEGER, "copied count", 0);
  if (!["report", "conflict"].includes(cursor.kind))
    throw new Error("Invalid cursor kind");
}

/** One bounded page, including sparse sequences and both tables. An error never advances a cursor. */
export async function readLegacyPage(
  source: LegacySqlReader,
  scope: LegacyReportScope,
  start = initialCursor(scope),
  rows = 16,
  maxBytes = 64 * 1024 ** 2,
  checkRead?: (cursor: LegacyCursor) => void,
): Promise<LegacyBackupPage> {
  assertLegacyScope(scope);
  checkCursor(scope, start);
  legacyBound(rows, 128, "page rows");
  legacyBound(maxBytes, 256 * 1024 ** 2, "page bytes");
  const next = { ...start };
  const members: LegacyReportMember[] = [];
  let bytes = 0;
  // Bound metadata requests as well, including runs through zero-conflict executions.
  let queries = 0;
  while (
    next.execution < scope.executions.length &&
    members.length < rows &&
    queries < 2 * rows + 4
  ) {
    checkRead?.(next);
    const item = scope.executions[next.execution];
    const highWater =
      next.kind === "report" ? item.reportHighWater : item.conflictHighWater;
    const count = next.kind === "report" ? item.reports : item.conflicts;
    queries++;
    const keys = await source.query(
      legacyKeysSql(
        item.executionId,
        next.kind,
        next.after,
        highWater,
        rows - members.length,
        Boolean(source.readNormalizedPrefix),
      ),
      65536,
    );
    checkRead?.(next);
    if (keys.length === 0) {
      if (next.copied !== count || next.after !== highWater)
        throw new Error(
          "Frozen history count/high water changed; inspect source and retain checkpoint",
        );
      if (next.kind === "report") next.kind = "conflict";
      else {
        next.execution++;
        next.kind = "report";
      }
      next.after =
        next.kind === "report"
          ? (scope.executions[next.execution]?.reportAfter ?? 0)
          : 0;
      next.copied = 0;
      continue;
    }
    if (keys.length > rows - members.length)
      throw new Error("Unbounded source key result");
    const sequences = keys.map((key) =>
      legacyBound(Number(key.sequence), highWater, "source sequence"),
    );
    if (
      sequences.some(
        (sequence, index) =>
          sequence <= (index ? sequences[index - 1]! : next.after),
      )
    )
      throw new Error("Source keys out of order");
    // This hint avoids an extra round trip for inline/unique results. The
    // batch query independently rechecks its exact keys, hash and member bytes.
    const hint = keys[0].normalizedHash;
    const batch =
      next.kind === "report" &&
      source.readNormalizedPrefix &&
      typeof hint === "string" &&
      hint === keys[1]?.normalizedHash
        ? await source.readNormalizedPrefix(
            item.executionId,
            sequences,
            maxBytes - bytes,
          )
        : null;
    for (const [index, sequence] of sequences.entries()) {
      if (batch?.nextCost != null && index === batch.members.length)
        return page();
      queries++;
      const sealed = batch?.members[index];
      const result = sealed
        ? [sealed as unknown as Record<string, unknown>]
        : source.readMember
          ? await source.readMember(
              item.executionId,
              next.kind,
              sequence,
              maxBytes - bytes,
            )
          : await source.query(
              legacyMemberSql(
                item.executionId,
                next.kind,
                sequence,
                maxBytes - bytes,
              ),
              (maxBytes - bytes) * 6 + 1024 * 1024,
            );
      if (result.length !== 1) throw new Error("Frozen source member missing");
      if (result[0].blocked) {
        if (
          members.length &&
          result[0].blocked === "row exceeds remaining byte budget"
        )
          return page();
        throw new Error(`Legacy copy blocked: ${result[0].blocked}`);
      }
      const member = result[0] as unknown as LegacyReportMember;
      checkRead?.(next);
      checkLegacyMember(member);
      if (
        member.executionId !== item.executionId ||
        member.kind !== next.kind ||
        member.sequence !== sequence ||
        (member.kind === "report" && member.solverId !== scope.solverId)
      )
        throw new Error("Source report identity differs from frozen scope");
      bytes += Buffer.byteLength(member.rowText) + member.reportByteSize;
      if (bytes > maxBytes)
        throw new Error("Source exceeded the page byte budget");
      members.push(member);
      next.after = sequence;
      next.copied++;
      if (next.copied > count)
        throw new Error("Frozen history grew behind its cursor");
      if (bytes === maxBytes) return page();
    }
  }
  return page();
  function page(): LegacyBackupPage {
    return {
      version: 1,
      scopeSha256: legacyScopeHash(scope),
      sourceInstance: scope.sourceInstance,
      solverId: scope.solverId,
      start: { ...start },
      next: { ...next },
      members,
    };
  }
}

// Keep only the encoded bytes and receipt fields while another page is read.
// The apply callback receives a separate decode of the verified object.
function packedPage(page: LegacyBackupPage, packed = encodeLegacyPage(page)) {
  const { members, ...header } = page;
  return {
    ...header,
    ...packed,
    memberCount: members.length,
    reportRows: members.filter((member) => member.kind === "report").length,
  };
}

// Acknowledgement or representation changes can alter the original row text
// without changing its report signature. Compare the indexed heap versions
// around a speculative read, including insertion/deletion among sparse keys.
// Whole-row JSON and the resolver can also change on metadata-only DDL.
async function reportWindowVersion(
  source: LegacySqlReader,
  scope: LegacyReportScope,
  cursor: LegacyCursor,
  rows: number,
): Promise<string | undefined> {
  const item = scope.executions[cursor.execution];
  const [result] = await source.query(
    legacyReadOnlySql(`SELECT jsonb_build_object(
    'count', count(*), 'version', encode(sha256(convert_to(concat_ws('/',
      (SELECT string_agg(concat_ws(':',attnum,xmin,ctid), ',' ORDER BY attnum)
       FROM pg_attribute WHERE attrelid='public.progressive_worker_reports'::regclass AND attnum>0),
      (SELECT string_agg(concat_ws(':',oid,xmin,ctid), ',' ORDER BY oid)
       FROM pg_proc WHERE oid IN ('public.resolve_progressive_report(jsonb)'::regprocedure,
         'public.resolve_progressive_report(jsonb,text)'::regprocedure,
         'public.progressive_report_result_header(jsonb)'::regprocedure)),
      string_agg(concat_ws(':',sequence,tableoid,xmin,ctid), ',' ORDER BY sequence)), 'UTF8')), 'hex'))::text
    FROM (SELECT sequence,tableoid,xmin,ctid FROM public.progressive_worker_reports
      WHERE sim_job_id='${item.executionId}'::uuid AND sequence>${cursor.after}
        AND sequence<=${item.reportHighWater} ORDER BY sequence LIMIT ${rows}) AS bounded;`),
    1024,
  );
  if (result?.count !== rows) return undefined;
  if (
    typeof result.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.version)
  )
    throw new Error("Invalid legacy report window version");
  return result.version;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Kernel-owned lock: stdin closes on process death, releasing flock without a stale directory. */
async function acquireLegacyCopyLock(
  path: string,
): Promise<() => Promise<void>> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error("Copy lock must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const child = spawn(
    "flock",
    [
      "-n",
      path,
      "sh",
      "-c",
      "printf 'LEGACY_REPORT_LOCKED\\n'; cat >/dev/null",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.on("data", () => undefined);
  child.stdin.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Copy lock acquisition timed out"));
    }, 5000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new Error("Linux flock is required for restart-safe copy locking"),
      );
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Another copy holds this backup directory"));
    });
    child.stdout.once("data", (data: Buffer) => {
      clearTimeout(timer);
      data.toString().startsWith("LEGACY_REPORT_LOCKED")
        ? resolve()
        : reject(new Error("Invalid copy lock handshake"));
    });
  });
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  };
}

async function durableWrite(
  path: string,
  bytes: Buffer,
  immutable: boolean,
): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (immutable) {
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await readFile(path)).equals(bytes))
          throw new Error("Existing immutable backup artifact differs");
      }
    } else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** State is backup progress, not application custody and never authorizes report removal. */
export async function exportLegacyReports(input: {
  source: LegacySqlReader;
  store: LegacyBackupStore;
  scope: LegacyReportScope;
  directory: string;
  sourceBinding: string;
  pages?: number;
  rows?: number;
  maxBytes?: number;
  keepLocal?: boolean;
  /** Overlap one read-only page with the independent store/apply callback. */
  prepareNextPage?: boolean;
  shouldStop?: () => boolean;
  onVerifiedHistory?: () => void;
  applyVerifiedPage?: (
    page: LegacyBackupPage,
    receipt: LegacyBackupReceipt,
    receiptFile: string,
    verifiedPackedBytes: Buffer,
  ) => Promise<void | LegacyPageApplyStats>;
  adoptCopy?: {
    sourceBinding: string;
    applyReceipts: (
      through: LegacyCursor,
    ) => Promise<void | LegacyPageApplyStats>;
  };
}) {
  assertLegacyScope(input.scope);
  const pages = legacyBound(input.pages ?? 1, 32, "pages per invocation");
  const rows = legacyBound(input.rows ?? 16, 128, "page rows");
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(input.directory)).isDirectory())
    throw new Error("Backup directory must be a real directory");
  const releaseLock = await acquireLegacyCopyLock(
    join(input.directory, "copy.lock"),
  );
  const totals = {
    reportRowsVerified: 0 as number | null,
    archiveMembersVerified: 0 as number | null,
    sourceDatabaseWrites: false as boolean | null,
    sourceReportRowsVerified: 0 as number | null,
    sourceReportBodiesRetained:
      input.applyVerifiedPage || input.adoptCopy ? (0 as number | null) : null,
    rowsNewlyNormalized: 0 as number | null,
    archiveMembersReleased: 0 as number | null,
    migrationTransactionsCommitted: 0 as number | null,
  };
  const add = (
    key: keyof Omit<typeof totals, "sourceDatabaseWrites">,
    value: number | null | undefined,
  ) => {
    if (value === null || value === undefined || totals[key] === null) {
      totals[key] = null;
      return;
    }
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid page-application count");
    totals[key] = (totals[key] as number) + value;
  };
  const applied = (
    stats: void | LegacyPageApplyStats,
    includeVerified = false,
  ) => {
    if (stats?.sourceDatabaseWrites === true)
      totals.sourceDatabaseWrites = true;
    else if (
      stats?.sourceDatabaseWrites !== false &&
      totals.sourceDatabaseWrites !== true
    )
      totals.sourceDatabaseWrites = null;
    for (const key of [
      "sourceReportRowsVerified",
      "sourceReportBodiesRetained",
      "rowsNewlyNormalized",
      "archiveMembersReleased",
      "migrationTransactionsCommitted",
    ] as const)
      add(key, stats?.[key]);
    if (includeVerified) {
      add("reportRowsVerified", stats?.reportRowsVerified);
      add("archiveMembersVerified", stats?.archiveMembersVerified);
    }
  };
  type Packed = ReturnType<typeof packedPage>;
  let ahead:
    | Promise<
        { page: Packed; version: string } | { error: unknown } | undefined
      >
    | undefined;
  let closing = false;
  const prepare = async (
    cursor: LegacyCursor,
    check?: (cursor: LegacyCursor) => void,
  ) => {
    const page = await readLegacyPage(
      input.source,
      input.scope,
      cursor,
      rows,
      input.maxBytes,
      check,
    );
    check?.(page.next);
    return packedPage(page);
  };
  const speculate = async (cursor: LegacyCursor) => {
    const version = await reportWindowVersion(
      input.source,
      input.scope,
      cursor,
      rows,
    );
    if (!version) return;
    // Conflict aliases can refer to a report in the page being committed.
    // Speculation is confined to later reports in one execution.
    const abandoned = new Error("Speculative legacy page abandoned");
    const check = (at: LegacyCursor) => {
      if (
        closing ||
        input.shouldStop?.() ||
        at.execution !== cursor.execution ||
        at.kind !== "report"
      )
        throw abandoned;
    };
    try {
      return { page: await prepare(cursor, check), version };
    } catch (error) {
      if (error !== abandoned) throw error;
    }
  };
  try {
    const binding = legacySha256(
      JSON.stringify({
        scope: input.scope,
        sourceBinding: input.sourceBinding,
      }),
    );
    const statePath = join(input.directory, "checkpoint.json");
    const pendingPath = join(input.directory, "pending.jsonl.gz");
    let next = initialCursor(input.scope),
      lastReceipt: string | null = null;
    let state: {
      binding: string;
      next: LegacyCursor;
      lastReceipt: string | null;
    } | null = null;
    try {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (state) {
      next = state.next;
      lastReceipt = state.lastReceipt;
      checkCursor(input.scope, next);
      const oldCopy =
        input.adoptCopy &&
        legacySha256(
          JSON.stringify({
            scope: input.scope,
            sourceBinding: input.adoptCopy.sourceBinding,
          }),
        );
      if (
        (state.binding === binding || state.binding === oldCopy) &&
        lastReceipt &&
        /^[a-f0-9]{64}\.[a-f0-9]{64}\.[0-9]+\.receipt\.json$/.test(lastReceipt)
      ) {
        let bytes: Buffer;
        try {
          bytes = await readFile(join(input.directory, lastReceipt));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const failure = Object.assign(
            new Error(
              "Receipt coverage incomplete; cannot resume or adopt this checkpoint",
            ),
            {
              legacyStorageOperation: "checkpoint_read",
              code: "legacy_receipt_coverage_incomplete",
            },
          );
          throw failure;
        }
        if (legacySha256(bytes) !== lastReceipt.split(".")[0])
          throw new Error("Verified source history receipt changed");
        input.store.acceptVerifiedTransportHistory?.();
        input.source.acceptVerifiedTransportHistory?.();
        input.onVerifiedHistory?.();
      }
      if (state.binding !== binding) {
        const copyBinding =
          input.adoptCopy &&
          legacySha256(
            JSON.stringify({
              scope: input.scope,
              sourceBinding: input.adoptCopy.sourceBinding,
            }),
          );
        if (state.binding !== copyBinding)
          throw new Error("Backup source/scope binding changed");
        applied(await input.adoptCopy!.applyReceipts(next), true);
        await durableWrite(
          join(
            input.directory,
            `adopted-copy-checkpoint.${legacySha256(JSON.stringify(state))}.json`,
          ),
          Buffer.from(JSON.stringify(state) + "\n"),
          true,
        );
        await saveState();
      }
    } else await saveState();
    const receipts: string[] = [];
    for (let index = 0; index < pages; index++) {
      if (input.shouldStop?.()) break;
      let page: Packed;
      try {
        const details = await lstat(pendingPath);
        if (!details.isFile() || details.size > 512 * 1024 ** 2)
          throw new Error(
            "Invalid/oversized pending page; preserve for inspection",
          );
        const bytes = await readFile(pendingPath);
        const inspected = inspectLegacyPage(bytes);
        page = packedPage(inspected.page, {
          bytes,
          rawByteSize: inspected.rawByteSize,
        });
        if (
          page.scopeSha256 !== legacyScopeHash(input.scope) ||
          page.sourceInstance !== input.scope.sourceInstance ||
          page.solverId !== input.scope.solverId
        )
          throw new Error(
            "Pending page belongs to another source/scope; preserved",
          );
        checkCursor(input.scope, page.start);
        checkCursor(input.scope, page.next);
        if (!sameCursor(page.start, next)) {
          if (
            !sameCursor(page.next, next) ||
            !lastReceipt ||
            !/^[a-f0-9]{64}\.[a-f0-9]{64}\.[0-9]+\.receipt\.json$/.test(
              lastReceipt,
            )
          )
            throw new Error("Pending page/checkpoint disagree; preserved");
          const receiptBytes = await readFile(
            join(input.directory, lastReceipt),
          );
          if (legacySha256(receiptBytes) !== lastReceipt.split(".")[0])
            throw new Error("Saved receipt changed; pending bytes preserved");
          const receipt = JSON.parse(
            receiptBytes.toString("utf8"),
          ) as LegacyBackupReceipt;
          if (receipt.object.sha256 !== legacySha256(page.bytes))
            throw new Error("Pending page does not match committed receipt");
          decodeLegacyPage(await input.store.read(receipt.object), receipt); // Fresh pinned recovery proof before delayed drop.
          await unlink(pendingPath);
          await syncDirectory(input.directory);
          if (next.execution === input.scope.executions.length) break;
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (next.execution === input.scope.executions.length) break;
        let reusable: Packed | undefined;
        if (ahead) {
          const prepared = await ahead;
          ahead = undefined;
          if (input.shouldStop?.()) break;
          if (prepared && "error" in prepared) throw prepared.error;
          if (prepared) {
            if (!sameCursor(prepared.page.start, next))
              throw new Error(
                "Speculative page differs from the durable cursor",
              );
            const current = await reportWindowVersion(
              input.source,
              input.scope,
              next,
              rows,
            );
            if (input.shouldStop?.()) break;
            if (current === prepared.version) reusable = prepared.page;
          }
        }
        page = reusable ?? (await prepare(next));
        // Exactly one transfer file. A crash during this write leaves a bounded
        // incomplete page for inspection, never another unbounded capture batch.
        const file = await open(pendingPath, "wx", 0o600);
        try {
          await file.writeFile(page.bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await syncDirectory(input.directory);
      }
      const following = page.next;
      const target = input.scope.executions[following.execution];
      if (
        input.prepareNextPage &&
        index + 1 < pages &&
        following.kind === "report" &&
        target &&
        target.reports - following.copied >= rows &&
        !input.shouldStop?.()
      ) {
        // Only the committed cursor may publish these bytes. Attach the error
        // handler now, and finish the current durable operation first.
        ahead = speculate(following).catch((error: unknown) => ({ error }));
      }
      const hash = legacySha256(page.bytes);
      const objectKey = `legacy-worker-reports/v1/${input.scope.sourceInstance}/${input.scope.solverId}/${page.scopeSha256}/${hash}.jsonl.gz`;
      const object = await input.store.put(objectKey, page.bytes);
      if (
        object.objectKey !== objectKey ||
        object.sha256 !== hash ||
        object.byteSize !== page.bytes.length
      )
        throw new Error("Backup store returned another object");
      const receipt: LegacyBackupReceipt = {
        version: 1,
        scopeSha256: page.scopeSha256,
        sourceInstance: page.sourceInstance,
        solverId: page.solverId,
        start: page.start,
        next: page.next,
        object,
        memberCount: page.memberCount,
        rawByteSize: page.rawByteSize,
      };
      const restored = await input.store.read(object);
      decodeLegacyPage(restored, receipt);
      if (!restored.equals(page.bytes))
        throw new Error("Backup bytes changed during readback");
      add("reportRowsVerified", page.reportRows);
      add("archiveMembersVerified", page.memberCount);
      const receiptBytes = Buffer.from(JSON.stringify(receipt) + "\n");
      const receiptFile = `${legacySha256(receiptBytes)}.${hash}.${object.generation}.receipt.json`;
      await durableWrite(
        join(input.directory, receiptFile),
        receiptBytes,
        true,
      );
      if (input.keepLocal)
        await durableWrite(
          join(input.directory, `${hash}.jsonl.gz`),
          page.bytes,
          true,
        );
      await syncDirectory(input.directory); // Receipt/optional retained copy BEFORE progress.
      if (input.applyVerifiedPage)
        try {
          applied(
            await input.applyVerifiedPage(
              decodeLegacyPage(restored, receipt),
              receipt,
              receiptFile,
              restored,
            ),
          );
        } catch (error) {
          const local = legacyLocalStorageError("save_proof", error);
          if (local) throw local;
          if (error && typeof error === "object")
            try {
              Object.defineProperty(error, "legacyStorageOperation", {
                value: "apply_verified_page",
                configurable: true,
              });
            } catch {}
          throw error;
        }
      next = page.next;
      lastReceipt = receiptFile;
      await saveState();
      await unlink(pendingPath);
      await syncDirectory(input.directory);
      receipts.push(receiptFile);
    }
    return {
      complete: next.execution === input.scope.executions.length,
      next,
      receipts,
      ...totals,
      countsArePerInvocation: true,
      localBodiesRemoved:
        totals.archiveMembersReleased === null
          ? null
          : totals.archiveMembersReleased > 0,
      transferBytesRetained: input.keepLocal === true,
    };
    async function saveState() {
      await durableWrite(
        statePath,
        Buffer.from(
          JSON.stringify({ version: 1, binding, next, lastReceipt }) + "\n",
        ),
        false,
      );
      await syncDirectory(input.directory);
    }
  } finally {
    closing = true;
    await ahead;
    await releaseLock();
  }
}
