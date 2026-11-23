import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { LegacyBackupReceipt } from "@aerodb/db/legacy-report-storage-codec";

export interface LegacyCustodyWorkerRequest {
  receipt: LegacyBackupReceipt;
  hubReadbackAt: string;
}
type Rows = Array<Record<string, unknown>>;
export interface LegacyWorkerSqlTransaction {
  unsafe(
    text: string,
    parameters?: unknown[],
  ): PromiseLike<unknown> & { simple(): Promise<unknown> };
}
interface SqlLike extends LegacyWorkerSqlTransaction {
  begin<T>(callback: (sql: SqlLike) => Promise<T>): Promise<T>;
  end(options?: { timeout: number }): Promise<void>;
}
const workerPhases = [
  "worker",
  "replay_verification",
  "transaction_setup",
  "settings_lock",
  "job_lock",
  "catalog_read",
  "custody_registration",
  "report_state",
  "normalization",
  "readback",
] as const;
type WorkerPhase = (typeof workerPhases)[number];
export interface LegacyCustodyFailure {
  version: 1;
  workerPhase: WorkerPhase;
  sqlState: string | null;
  category:
    | "database_lock_timeout"
    | "database_deadlock"
    | "database_serialization_failure"
    | "database_unavailable"
    | "credentials_denied"
    | "integrity"
    | "operation_failed";
}

/** Carries only a phase and driver code across the remote worker boundary.
 * SQL text, row values, server detail/context and credentials are never emitted. */
export function legacyCustodyWorkerFailure(
  error: unknown,
): LegacyCustodyFailure {
  const value =
    error && typeof error === "object"
      ? (error as { code?: unknown; workerPhase?: unknown })
      : {};
  const code = typeof value.code === "string" ? value.code : "";
  const sqlState = /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const workerPhase = workerPhases.includes(value.workerPhase as WorkerPhase)
    ? (value.workerPhase as WorkerPhase)
    : "worker";
  const category =
    sqlState === "55P03"
      ? "database_lock_timeout"
      : sqlState === "40P01"
        ? "database_deadlock"
        : sqlState === "40001"
          ? "database_serialization_failure"
          : [
                "57P01",
                "57P02",
                "57P03",
                "08000",
                "08001",
                "08003",
                "08006",
              ].includes(code) ||
              [
                "CONNECTION_CLOSED",
                "CONNECTION_DESTROYED",
                "CONNECTION_ENDED",
                "CONNECT_TIMEOUT",
                "ECONNRESET",
                "ECONNREFUSED",
                "EPIPE",
                "ETIMEDOUT",
              ].includes(code)
            ? "database_unavailable"
            : ["42501", "28000", "28P01"].includes(code)
              ? "credentials_denied"
              : code === "P0001" || code.startsWith("23") || !code
                ? "integrity"
                : "operation_failed";
  return { version: 1, workerPhase, sqlState, category };
}

export function parseLegacyCustodyWorkerFailure(
  stderr: string | Buffer,
): LegacyCustodyFailure | null {
  const lines = stderr
    .toString()
    .slice(0, 16384)
    .split("\n")
    .filter((line) => line.startsWith("LEGACY_CUSTODY_FAILURE "));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]!.slice("LEGACY_CUSTODY_FAILURE ".length));
    if (
      value?.version !== 1 ||
      !workerPhases.includes(value.workerPhase) ||
      (value.sqlState !== null &&
        (typeof value.sqlState !== "string" ||
          !/^[0-9A-Z]{5}$/.test(value.sqlState)))
    )
      return null;
    if (
      ![
        "database_lock_timeout",
        "database_deadlock",
        "database_serialization_failure",
        "database_unavailable",
        "credentials_denied",
        "integrity",
        "operation_failed",
      ].includes(value.category)
    )
      return null;
    const expected = legacyCustodyWorkerFailure({
      code:
        value.sqlState ??
        (value.category === "database_unavailable" ? "CONNECTION_CLOSED" : ""),
      workerPhase: value.workerPhase,
    });
    return expected.category === value.category ? expected : null;
  } catch {
    return null;
  }
}

function workerFailure(error: unknown, workerPhase: WorkerPhase): Error {
  const failure = new Error(
    "Legacy custody worker failed; exact page retained",
    { cause: error },
  );
  return Object.assign(failure, {
    code:
      error && typeof error === "object"
        ? (error as { code?: unknown }).code
        : undefined,
    workerPhase,
  });
}

/** Same authority/ownership lock order as 0205, without waiting behind a busy
 * ingester while holding the singleton settings row needed by heartbeats. */
export async function lockLegacyCustodyWorkerScope(
  tx: LegacyWorkerSqlTransaction,
  executionIds: string[],
): Promise<void> {
  if (!executionIds.length) return;
  if (
    executionIds.length > 128 ||
    executionIds.some(
      (id) => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
    )
  )
    throw new Error("Invalid bounded legacy custody job scope");
  let phase: WorkerPhase = "settings_lock";
  try {
    await tx.unsafe(
      "SELECT id FROM public.sync_api_settings WHERE id=1 FOR SHARE NOWAIT",
    );
    phase = "job_lock";
    const jobs = JSON.stringify([...new Set(executionIds)].sort());
    await tx.unsafe(
      `SELECT job.id FROM public.sim_jobs job
      JOIN jsonb_array_elements_text($1::jsonb) AS selected(id) ON job.id=selected.id::uuid
      ORDER BY job.id FOR UPDATE OF job NOWAIT`,
      [jobs],
    );
  } catch (error) {
    throw workerFailure(error, phase);
  }
}
function rows(value: unknown): Rows {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) =>
    Array.isArray(row)
      ? rows(row)
      : row && typeof row === "object"
        ? [row as Record<string, unknown>]
        : [],
  );
}
/** Compose reviewed transaction bodies; never silently accept a changed wrapper. */
export function legacyTransactionBody(value: string): string {
  if (!/^\s*BEGIN;/.test(value) || !/(?:COMMIT|ROLLBACK);\s*$/.test(value))
    throw new Error("Unexpected legacy SQL transaction wrapper");
  return value
    .replace(/^\s*BEGIN;/, "")
    .replace(/(?:COMMIT|ROLLBACK);\s*$/, "");
}

/** Executes inside the deployed HZ sweeper, under the HOST shared deploy lock.
 * No cloud credentials or operator buffer can substitute for its product read. */
export async function runLegacyCustodyWorker(
  request: LegacyCustodyWorkerRequest,
  packed: Buffer,
) {
  const sha = (bytes: Buffer | string) =>
    createHash("sha256").update(bytes).digest("hex");
  const object = request.receipt.object;
  if (
    packed.length !== object.byteSize ||
    packed.length > 512 * 1024 ** 2 ||
    sha(packed) !== object.sha256
  )
    throw new Error("Invalid exact packed legacy object");
  const age = Date.now() - Date.parse(request.hubReadbackAt);
  if (!Number.isFinite(age) || age < -30000 || age > 120000)
    throw new Error("Fresh hub readback is required before worker custody");
  const app = "/app";
  let modules;
  try {
    modules = await Promise.all([
      import(`${app}/packages/db/src/client.ts`),
      import(`${app}/packages/db/src/legacy-report-storage-codec.ts`),
      import(`${app}/packages/db/src/legacy-report-custody.ts`),
      import(`${app}/packages/db/src/legacy-report-storage.ts`),
      import(`${app}/apps/sweeper/src/worker-report-volume.ts`),
      import(`${app}/apps/sweeper/src/legacy-worker-report-read.ts`),
      import(`${app}/apps/sweeper/src/config.ts`),
    ]);
  } catch {
    return {
      mode: "fallback" as const,
      reason: "deployed_custody_modules_unavailable",
    };
  }
  const [clientModule, codec, custody, normalization, volume, product, config] =
    modules;
  if (
    typeof product.readLegacyWorkerReportArchivePage !== "function" ||
    typeof codec.readLegacyPageMembers !== "function" ||
    typeof custody.verifyLegacyReportCustodyPage !== "function" ||
    typeof custody.legacyReportCustodySql !== "function" ||
    typeof volume.storeWorkerReportVolume !== "function" ||
    typeof normalization.legacyNormalizeSql !== "function" ||
    typeof config.configuredDeploymentRole !== "function" ||
    config.configuredDeploymentRole() !== "remote-solver"
  )
    return {
      mode: "fallback" as const,
      reason: "deployed_page_reader_unavailable",
    };
  const page = codec.decodeLegacyPage(packed, request.receipt);
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(page.sourceInstance)
  )
    return {
      mode: "fallback" as const,
      reason: "registered_source_instance_unproven",
    };
  const client = clientModule.createClient({ max: 1 });
  const sql = client.sql as SqlLike;
  let productReadStarted = false;
  try {
    let ready: Record<string, unknown> | undefined;
    try {
      ready = rows(
        await sql.unsafe(
          `SELECT to_regprocedure('public.register_legacy_report_archive_custody(jsonb)') IS NOT NULL AS installed,
        (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='progressive_report_archive_bundles'
          AND column_name IN ('legacy_read_mode','legacy_local_storage_key','legacy_local_verified_at'))=3 AS local_columns`,
        ),
      )[0];
    } catch {
      return {
        mode: "fallback" as const,
        reason: "supporting_worker_database_unavailable",
      };
    }
    if (ready?.installed !== true || ready.local_columns !== true)
      return { mode: "fallback" as const, reason: "migration_0205_not_ready" };
    await volume.storeWorkerReportVolume(Readable.from([packed]), {
      storedSha256: object.sha256,
      storedByteSize: object.byteSize,
    });
    let pageReads = 0;
    let verifiedMembers: Array<Record<string, unknown>> = [];
    let productReadback: Record<string, unknown> | null = null;
    let productBytes: Buffer | null = null;
    let proof;
    try {
      productReadStarted = true;
      proof = await custody.verifyLegacyReportCustodyPage({
        page,
        object,
        access: {
          mode: "hub-local-reader",
          readHubObject: async (identity: Record<string, unknown>) => {
            if (
              identity.sha256 !== object.sha256 ||
              identity.generation !== object.generation ||
              identity.byteSize !== object.byteSize
            )
              throw new Error("Hub read identity changed");
            return packed;
          },
          reader: {
            readPage: async (identity: Record<string, unknown>) => {
              pageReads++;
              if (pageReads !== 1)
                throw new Error("One product page read is required");
              const local = await product.readLegacyWorkerReportArchivePage(
                client.db,
                identity,
              );
              productBytes = local.storedBytes;
              const actual = local.proof;
              if (
                !actual ||
                actual.verified !== true ||
                actual.readSource !== "worker-report-volume" ||
                actual.volumeObjectReads !== 1 ||
                actual.decoderPasses !== 1 ||
                actual.storedBytesRead !== object.byteSize ||
                actual.memberCount !== page.members.length ||
                !Array.isArray(actual.members)
              )
                throw new Error(
                  "Normal worker reader did not prove one complete page traversal",
                );
              verifiedMembers = actual.members;
              productReadback = {
                storageKey: local.storageKey,
                durableAt: local.durableAt,
                proof: actual,
              };
              return local;
            },
          },
        },
      });
    } catch {
      return {
        mode: "fallback" as const,
        reason: "normal_worker_page_read_not_proven",
        pageReads,
        verifiedMembers: verifiedMembers.length,
      };
    }
    const result = await sql.begin((tx) =>
      applyLegacyCustodyWorkerTransaction(tx, {
        page,
        object,
        proof,
        custody,
        normalization,
        codec,
        productBytes,
        verifiedMembers,
      }),
    );
    return {
      mode: "custody" as const,
      ...result,
      pageReads,
      verifiedMembers,
      productReadback,
      coldReleaseComplete:
        Array.isArray(result.custody.skipped) &&
        result.custody.skipped.length === 0,
      transactionCommitted: true,
    };
  } catch (error) {
    if (!productReadStarted)
      return {
        mode: "fallback" as const,
        reason: "supporting_worker_service_unavailable",
      };
    throw error;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** Exact production SQL branch. Tests pass the real postgres-js transaction
 * from the migrated archive fixture; parameterized queries use extended protocol. */
export async function applyLegacyCustodyWorkerTransaction(
  tx: LegacyWorkerSqlTransaction,
  input: {
    page: any;
    object: LegacyBackupReceipt["object"];
    proof: any;
    custody: {
      legacyReportCustodySql: (
        proof: any,
        options: { apply: boolean; readersReady: boolean },
      ) => string;
    };
    normalization: {
      legacyNormalizeSql: (
        members: any[],
        options: {
          apply: boolean;
          readersReady: boolean;
          trackChanges: boolean;
        },
      ) => string;
    };
    codec: { readLegacyPageMembers: (bytes: Buffer, identity: any) => any[] };
    productBytes: Buffer | null;
    verifiedMembers: Array<Record<string, unknown>>;
  },
) {
  const {
    page,
    object,
    proof,
    custody,
    normalization,
    codec,
    productBytes,
    verifiedMembers,
  } = input;
  const reportMembers = page.members.filter(
    (member: { kind: string }) => member.kind === "report",
  );
  const targets = JSON.stringify(
    reportMembers.map((member: { executionId: string; sequence: number }) => ({
      id: member.executionId,
      seq: member.sequence,
    })),
  );
  let phase: WorkerPhase = "replay_verification";
  try {
    // This CPU-only replay uses the already reopened immutable product bytes.
    // Finish it before acquiring shared settings/job locks, not while heartbeats
    // or ingestion wait behind this page's row locks.
    if (!productBytes) throw new Error("Missing actual product page readback");
    const replay = codec.readLegacyPageMembers(productBytes, {
      storedSha256: object.sha256,
      storedByteSize: object.byteSize,
      sourceInstance: page.sourceInstance,
      solverId: page.solverId,
      scopeSha256: page.scopeSha256,
      members: page.members.map((member: Record<string, unknown>) => member),
    });
    if (replay.length !== verifiedMembers.length)
      throw new Error("Product replay member set differs");
    phase = "transaction_setup";
    await tx
      .unsafe(
        "SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='2s'; SET LOCAL idle_in_transaction_session_timeout='35s'",
      )
      .simple();
    // Match 0205's settings -> sorted jobs lock order. NOWAIT rolls back and
    // releases settings immediately when an ingester owns a job; the existing
    // receipt loop backs off instead of holding settings while waiting on jobs.
    phase = "job_lock";
    await lockLegacyCustodyWorkerScope(
      tx,
      page.members.map((member: { executionId: string }) => member.executionId),
    );
    const catalog = async () =>
      rows(
        await tx.unsafe(
          `SELECT
        (SELECT count(*) FROM public.progressive_report_archive_bundles WHERE bucket=$1 AND object_key=$2 AND generation=$3)::integer AS bundles,
        (SELECT count(*) FROM public.progressive_report_archive_members m JOIN public.progressive_report_archive_bundles b ON b.id=m.bundle_id
          WHERE b.bucket=$1 AND b.object_key=$2 AND b.generation=$3)::integer AS members`,
          [object.bucket, object.objectKey, object.generation],
        ),
      )[0];
    phase = "catalog_read";
    const before = await catalog();
    phase = "custody_registration";
    const registered = rows(
      await tx
        .unsafe(
          legacyTransactionBody(
            custody.legacyReportCustodySql(proof, {
              apply: true,
              readersReady: true,
            }),
          ),
        )
        .simple(),
    );
    const values = registered
      .flatMap((row) => Object.values(row))
      .filter((value): value is string => typeof value === "string");
    if (values.length !== 1)
      throw new Error("Missing exact custody SQL result");
    const custodyResult = JSON.parse(values[0]);
    phase = "report_state";
    const states = reportMembers.length
      ? rows(
          await tx.unsafe(
            `SELECT r.sim_job_id::text AS id,r.sequence,r.archived_at,r.result_payload_hash,jsonb_typeof(r.report->'result') AS result_type
        FROM jsonb_to_recordset($1::jsonb) AS e(id uuid,seq bigint)
        JOIN public.progressive_worker_reports r ON r.sim_job_id=e.id AND r.sequence=e.seq FOR UPDATE OF r`,
            [targets],
          ),
        )
      : [];
    if (states.length !== reportMembers.length)
      throw new Error("Source report disappeared during custody");
    const warm = new Set(
      states
        .filter((row) => row.archived_at === null)
        .map((row) => `${row.id}:${row.sequence}`),
    );
    const remaining = reportMembers.filter(
      (member: { executionId: string; sequence: number }) =>
        warm.has(`${member.executionId}:${member.sequence}`),
    );
    let newlyNormalizedReports = states.filter(
      (row) =>
        row.archived_at === null &&
        row.result_payload_hash === null &&
        row.result_type === "object",
    ).length;
    if (remaining.length) {
      phase = "normalization";
      await tx
        .unsafe(
          legacyTransactionBody(
            normalization.legacyNormalizeSql(remaining, {
              apply: true,
              readersReady: true,
              trackChanges: false,
            }),
          ),
        )
        .simple();
    }
    phase = "readback";
    const after = await catalog();
    const normalized = reportMembers.length
      ? rows(
          await tx.unsafe(
            `SELECT count(r.result_payload_hash)::integer AS n
        FROM jsonb_to_recordset($1::jsonb) AS e(id uuid,seq bigint)
        JOIN public.progressive_worker_reports r ON r.sim_job_id=e.id AND r.sequence=e.seq`,
            [targets],
          ),
        )[0]
      : { n: 0 };
    if (remaining.length) {
      const afterStates = rows(
        await tx.unsafe(
          `SELECT r.sim_job_id::text AS id,r.sequence,r.result_payload_hash
          FROM jsonb_to_recordset($1::jsonb) AS e(id uuid,seq bigint) JOIN public.progressive_worker_reports r ON r.sim_job_id=e.id AND r.sequence=e.seq`,
          [targets],
        ),
      );
      for (const state of states)
        if (
          state.archived_at === null &&
          state.result_payload_hash === null &&
          state.result_type === "object" &&
          !afterStates.some(
            (row) =>
              row.id === state.id &&
              String(row.sequence) === String(state.sequence) &&
              row.result_payload_hash !== null,
          )
        )
          throw new Error(
            "Guarded fallback normalization did not commit its exact representation change",
          );
    }
    const released =
      Number(custodyResult.compactedReports) +
      Number(custodyResult.compactedConflicts);
    if (
      !Number.isSafeInteger(released) ||
      released < 0 ||
      released > page.members.length
    )
      throw new Error("Invalid actual custody release count");
    return {
      custody: custodyResult,
      newlyNormalizedReports,
      verifiedReports: reportMembers.length,
      sourceDatabaseWrites:
        released > 0 ||
        newlyNormalizedReports > 0 ||
        Number(after.bundles) > Number(before.bundles) ||
        Number(after.members) > Number(before.members),
      archiveMembersReleased: released,
      replayMembersVerified: replay.length,
      remainingWarmReports: remaining.length,
      normalizedReports: Number(normalized.n),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      workerPhases.includes(
        (error as { workerPhase?: WorkerPhase }).workerPhase!,
      )
    )
      throw error;
    throw workerFailure(error, phase);
  }
}

export async function legacyCustodyWorkerStdin(): Promise<void> {
  const startCpu = process.cpuUsage(),
    start = performance.now();
  let header = Buffer.alloc(0),
    request: LegacyCustodyWorkerRequest | undefined,
    size = 0;
  const parts: Buffer[] = [];
  for await (const raw of process.stdin) {
    let bytes = Buffer.from(raw);
    if (!request) {
      header = Buffer.concat([header, bytes]);
      const newline = header.indexOf(10);
      if (newline < 0) {
        if (header.length > 65536) throw new Error("Oversized custody header");
        continue;
      }
      if (newline > 65536) throw new Error("Oversized custody header");
      request = JSON.parse(header.subarray(0, newline).toString("utf8"));
      bytes = header.subarray(newline + 1);
      header = Buffer.alloc(0);
      if (
        !request ||
        !Number.isSafeInteger(request.receipt.object.byteSize) ||
        request.receipt.object.byteSize < 1 ||
        request.receipt.object.byteSize > 512 * 1024 ** 2
      )
        throw new Error("Invalid custody byte bound");
    }
    size += bytes.length;
    if (size > request.receipt.object.byteSize)
      throw new Error("Custody input exceeds byte bound");
    parts.push(bytes);
  }
  if (!request || size !== request.receipt.object.byteSize)
    throw new Error("Truncated custody input");
  const result = await runLegacyCustodyWorker(request, Buffer.concat(parts));
  const cpu = process.cpuUsage(startCpu);
  process.stdout.write(
    JSON.stringify({
      ...result,
      workerCost: {
        elapsedMs: performance.now() - start,
        cpuMs: (cpu.user + cpu.system) / 1000,
        peakRssKiB: process.resourceUsage().maxRSS,
      },
    }) + "\n",
  );
}
