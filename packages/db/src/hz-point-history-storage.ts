import { solverHistorySha256 } from "@aerodb/core/solver-history-storage";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { getAttemptEvidenceArchive, type AttemptEvidenceArchiveRecord } from "./attempt-evidence-catalog";
import { storedCanonicalSubtree } from "./result-history-subtrees";
import {
  forceHistoryOffloadCandidates,
  loadSolverHistorySource,
  forceHistoryArchiveForRow,
  getSolverHistoryArchive,
  registerSolverHistoryArchive,
  offloadForceHistoryArrays,
} from "./solver-history-storage";
import {
  resultHistoryOffloadCandidates,
  loadResultHistorySource,
  resultHistoryArchiveForRow,
  getResultHistoryArchive,
  registerResultHistoryArchive,
  offloadResultHistory,
} from "./result-history-storage";
import {
  assertPointHistoryIdentity,
  pointHistoryIdentityDigest,
  historyArchiveIdentity,
  readPointHistoryWorkingCopy,
  type PointHistoryIdentity,
  type PointHistoryKind,
  type PointHistorySource,
  POINT_HISTORY_KINDS,
} from "@aerodb/core/point-history-working-copy";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export interface HistorySelection {
  kind: PointHistoryKind;
  id: string;
}
export interface PreparedHistory extends HistorySelection {
  source: PointHistorySource | null;
  prior: PointHistoryIdentity | null;
  subtree?: VerifiedSubtreeSelection;
}
export interface VerifiedSubtreeSelection {
  resultId: string;
  kind: "steady_history" | "frame_track";
  reference: string;
  solver: string;
  archive: AttemptEvidenceArchiveRecord;
  fieldSha: string;
  fieldBytes: number;
}
export type HistoryCursor = Record<PointHistoryKind, string | null>;
export const emptyHistoryCursor = (): HistoryCursor => ({
  force_history: null,
  steady_history: null,
  frame_track: null,
});
export function validateHistorySelection(value: HistorySelection) {
  if (!POINT_HISTORY_KINDS.includes(value.kind) || !UUID.test(value.id))
    throw new Error("Invalid exact history selection");
}
export async function hzHistoryInstance(db: DB) {
  const [row] = await db.execute(
    sql`SELECT instance_id::text AS id FROM sync_api_settings WHERE id=1`,
  );
  if (typeof row?.id !== "string" || !UUID.test(row.id))
    throw new Error("HZ instance is unavailable");
  return row.id;
}
export async function historyHighWater(db: DB): Promise<HistoryCursor> {
  const [row] = await db.execute(sql`SELECT
    (SELECT id::text FROM force_history ORDER BY id DESC LIMIT 1) AS force_history,
    (SELECT id::text FROM results ORDER BY id DESC LIMIT 1) AS steady_history,
    (SELECT id::text FROM results ORDER BY id DESC LIMIT 1) AS frame_track`);
  return row as unknown as HistoryCursor;
}
/** Bounded source export. JSONB numeric values remain inside payloadText. */
export async function prepareHzHistory(
  db: DB,
  selection: HistorySelection,
): Promise<PreparedHistory> {
  validateHistorySelection(selection);
  if (selection.kind === "force_history") {
    const pointed = await forceHistoryArchiveForRow(db, selection.id);
    if (pointed)
      return {
        ...selection,
        source: null,
        prior: historyArchiveIdentity(pointed),
      };
    const source = await loadSolverHistorySource(
      db,
      "force_history",
      selection.id,
    );
    const [existing] =
      await db.execute(sql`SELECT id FROM solver_history_archives
      WHERE source_id=${source.sourceId}::uuid AND result_id=${source.resultId}::uuid
        AND result_attempt_id IS NOT DISTINCT FROM ${source.resultAttemptId}::uuid
        AND source_sha256=${solverHistorySha256(Buffer.from(source.payloadText))}
      ORDER BY verified_at,id LIMIT 1`);
    return {
      ...selection,
      source,
      prior: existing
        ? historyArchiveIdentity(
            await getSolverHistoryArchive(db, String(existing.id)),
          )
        : null,
    };
  }
  const pointed = await resultHistoryArchiveForRow(
    db,
    selection.id,
    selection.kind,
  );
  if (pointed)
    return {
      ...selection,
      source: null,
      prior: historyArchiveIdentity(pointed),
    };
  const subtree=await storedCanonicalSubtree(db,selection.id,selection.kind);
  if(subtree){
    const [cfg]=await db.execute(sql`SELECT remote_solver_registered_id solver FROM sync_api_settings WHERE id=1 AND remote_solver_enabled`);
    if(typeof cfg?.solver!=="string") throw Error("Canonical field requires the registered worker");
    return {...selection,source:null,prior:null,subtree:{resultId:selection.id,kind:selection.kind,reference:subtree.ref,
      solver:cfg.solver,archive:await getAttemptEvidenceArchive(db,subtree.archive),fieldSha:subtree.sha,fieldBytes:subtree.bytes}};
  }
  const source = await loadResultHistorySource(
    db,
    selection.id,
    selection.kind,
  );
  const [existing] =
    await db.execute(sql`SELECT id FROM result_history_archives WHERE result_id=${source.resultId}::uuid AND source_kind=${selection.kind}
    AND result_attempt_id IS NOT DISTINCT FROM ${source.resultAttemptId}::uuid
    AND source_sha256=${solverHistorySha256(Buffer.from(source.payloadText))} ORDER BY verified_at,id LIMIT 1`);
  return {
    ...selection,
    source,
    prior: existing
      ? historyArchiveIdentity(
          await getResultHistoryArchive(db, String(existing.id)),
        )
      : null,
  };
}
/** Reuse the existing storage selectors. Metadata pages advance past small or
 * rejected histories; one source may exceed the soft budget, never 32 MiB. */
export async function scanHzHistories(
  db: DB,
  input: {
    kind: PointHistoryKind;
    after: string | null;
    high: string | null;
    limit: number;
    maxBytes: number;
  },
) {
  if (
    !POINT_HISTORY_KINDS.includes(input.kind) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 32 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.maxBytes > 64 * 1024 * 1024 ||
    [input.after, input.high].some((id) => id !== null && !UUID.test(id))
  )
    throw new Error("Invalid bounded history scan");
  if (input.high === null)
    return {
      items: [] as HistorySelection[],
      after: input.after,
      done: true,
      oversized: 0,
    };
  const candidates =
    input.kind === "force_history"
      ? (await forceHistoryOffloadCandidates(db, input.after, 32)).map(
          (row) => ({ id: row.id, bytes: row.byte_size, eligible: true }),
        )
      : (await resultHistoryOffloadCandidates(db, input.after, input.kind))
          .filter((row) => row.kind === input.kind)
          .map((row) => ({
            id: row.id,
            bytes: Number(row.byte_size ?? 0),
            eligible: row.eligible === true,
          }));
  let after = input.after,
    bytes = 0,
    oversized = 0;
  const items: HistorySelection[] = [];
  for (const row of candidates) {
    if (row.id > input.high) return { items, after, done: true, oversized };
    if (
      items.length >= input.limit ||
      (items.length > 0 && row.eligible && bytes + row.bytes > input.maxBytes)
    )
      return { items, after, done: false, oversized };
    after = row.id;
    if (row.bytes > MAX_SOURCE_BYTES) {
      oversized++;
      continue;
    }
    if (!row.eligible) continue;
    bytes += row.bytes;
    items.push({ kind: input.kind, id: row.id });
  }
  return {
    items,
    after,
    done: candidates.length === 0 || after === input.high,
    oversized,
  };
}
export interface HistoryCustodyResult {
  kind: PointHistoryKind;
  id: string;
  offloaded: boolean;
  replayed: boolean;
  inlineRetained: boolean;
  reason: string | null;
  sourceBytes: number;
  identity: PointHistoryIdentity;
}
const equalArchive = (a: PointHistoryIdentity, b: PointHistoryIdentity) =>
  pointHistoryIdentityDigest(a) === pointHistoryIdentityDigest(b);
/** Caller has independently verified the hub generation and the API container
 * working reader. This transaction does no network I/O; original 0204/0206
 * guards authenticate source bytes, scalars and exact owners again. */
export async function applyHzHistoryCustody(
  db: DB,
  identity: PointHistoryIdentity,
  options: { root?: string; hubReadbackAt: string },
): Promise<HistoryCustodyResult> {
  assertPointHistoryIdentity(identity);
  const restored = await readPointHistoryWorkingCopy(identity, options.root);
  const age = Date.now() - Date.parse(options.hubReadbackAt);
  if (!Number.isFinite(age) || age < -30000 || age > 120000)
    throw new Error("Fresh exact hub history readback required");
  if (
    (await hzHistoryInstance(db)) !== identity.sourceInstance &&
    !(await hasExactHzHistoryReceipt(db, identity))
  )
    throw new Error("History instance does not match HZ");
  const id =
    identity.sourceKind === "force_history"
      ? identity.sourceId
      : identity.resultId;
  const base = { kind: identity.sourceKind, id, identity };
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as DB;
    await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    // A repair of an already-pointed row changes only the working file.
    // Its original archive remains valid even if the job is active again.
    const table = sql.identifier(
      identity.sourceKind === "force_history" ? "force_history" : "results",
    );
    const pointer = sql.identifier(
      identity.sourceKind === "force_history"
        ? "history_archive_id"
        : identity.sourceKind + "_archive_id",
    );
    const [previous] = await tx.execute(
      sql`SELECT ${pointer} AS id FROM ${table} WHERE id=${id}::uuid AND ${pointer} IS NOT NULL FOR SHARE`,
    );
    if (previous) {
      const record =
        identity.sourceKind === "force_history"
          ? await getSolverHistoryArchive(tx, String(previous.id))
          : await getResultHistoryArchive(tx, String(previous.id));
      if (!equalArchive(record, identity))
        throw new Error("History points to another archive generation");
      return {
        ...base,
        offloaded: false,
        replayed: true,
        inlineRetained: false,
        reason: null,
        sourceBytes: 0,
      };
    }
    const [owner] =
      identity.sourceKind === "force_history"
        ? await tx.execute(sql`SELECT h.result_id,h.result_attempt_id AS attempt_id,r.sim_job_id AS result_job,a.sim_job_id AS attempt_job
      FROM force_history h JOIN results r ON r.id=h.result_id LEFT JOIN result_attempts a ON a.id=h.result_attempt_id WHERE h.id=${id}::uuid`)
        : await tx.execute(sql`SELECT r.id AS result_id,r.current_result_attempt_id AS attempt_id,r.sim_job_id AS result_job,a.sim_job_id AS attempt_job
      FROM results r LEFT JOIN result_attempts a ON a.id=r.current_result_attempt_id WHERE r.id=${id}::uuid`);
    if (
      !owner ||
      owner.result_id !== identity.resultId ||
      (owner.attempt_id ?? null) !== identity.resultAttemptId
    )
      throw new Error("History owner changed; inline bytes retained");
    const jobs = [
      ...new Set(
        [owner.result_job, owner.attempt_job].filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    ].sort();
    for (const jobId of jobs) {
      const [job] = await tx.execute(
        sql`SELECT status,ingest_lease_token IS NOT NULL AND (ingest_lease_expires_at IS NULL OR ingest_lease_expires_at > clock_timestamp()) AS live_ingest FROM sim_jobs WHERE id=${jobId}::uuid FOR SHARE`,
      );
      if (
        !job ||
        !["done", "failed", "cancelled"].includes(String(job.status)) ||
        job.live_ingest === true
      )
        return {
          ...base,
          offloaded: false,
          replayed: false,
          inlineRetained: true,
          reason: "job_or_ingestion_active",
          sourceBytes: 0,
        };
    }
    if (identity.resultAttemptId) {
      const [attempt] = await tx.execute(
        sql`SELECT status,sim_job_id FROM result_attempts WHERE id=${identity.resultAttemptId}::uuid AND result_id=${identity.resultId}::uuid FOR SHARE`,
      );
      if (!attempt || !["done", "failed"].includes(String(attempt.status)))
        return {
          ...base,
          offloaded: false,
          replayed: false,
          inlineRetained: true,
          reason: "attempt_active",
          sourceBytes: 0,
        };
      if ((attempt.sim_job_id ?? null) !== (owner.attempt_job ?? null))
        throw new Error("History job owner changed");
    }
    // Serialize with reingestion before comparing bytes or registering custody.
    const [result] = await tx.execute(
      identity.sourceKind === "force_history"
        ? sql`SELECT sim_job_id FROM results WHERE id=${identity.resultId}::uuid FOR SHARE`
        : sql`SELECT sim_job_id,current_result_attempt_id FROM results WHERE id=${identity.resultId}::uuid FOR UPDATE`,
    );
    if (
      !result ||
      (result.sim_job_id ?? null) !== (owner.result_job ?? null) ||
      (identity.sourceKind !== "force_history" &&
        (result.current_result_attempt_id ?? null) !== identity.resultAttemptId)
    )
      throw new Error("Result ownership changed during point history custody");
    if (identity.sourceKind === "force_history")
      await tx.execute(
        sql`SELECT id FROM force_history WHERE id=${id}::uuid FOR UPDATE`,
      );
    const pointed =
      identity.sourceKind === "force_history"
        ? await forceHistoryArchiveForRow(tx, id)
        : await resultHistoryArchiveForRow(tx, id, identity.sourceKind);
    if (pointed) {
      if (!equalArchive(pointed, identity))
        throw new Error(
          "Existing history receipt differs; restore its recorded generation",
        );
      return {
        ...base,
        offloaded: false,
        replayed: true,
        inlineRetained: false,
        reason: null,
        sourceBytes: 0,
      };
    }
    const source =
      identity.sourceKind === "force_history"
        ? await loadSolverHistorySource(tx, "force_history", id)
        : await loadResultHistorySource(tx, id, identity.sourceKind);
    if (
      source.resultId !== identity.resultId ||
      source.resultAttemptId !== identity.resultAttemptId ||
      source.payloadText !== restored.payloadText
    )
      throw new Error("History source changed; inline bytes retained");
    if (identity.sourceKind === "force_history") {
      const arrays = JSON.parse(source.payloadText);
      if (
        ![arrays.t, arrays.cl, arrays.cd].every(Array.isArray) ||
        !(arrays.cm === null || Array.isArray(arrays.cm))
      )
        throw new Error("Malformed force history remains inline");
    }
    if (
      identity.sourceKind !== "force_history" &&
      (identity.sourceByteSize < 4096 ||
        identity.sourceByteSize -
          (source as { compactByteSize: number }).compactByteSize <
          1024)
    )
      return {
        ...base,
        offloaded: false,
        replayed: false,
        inlineRetained: true,
        reason: "small_history",
        sourceBytes: 0,
      };
    const archive =
      identity.sourceKind === "force_history"
        ? await registerSolverHistoryArchive(tx, identity)
        : await registerResultHistoryArchive(tx, identity);
    if (!equalArchive(archive, identity))
      throw new Error(
        "Existing history receipt uses another generation; keep inline and retry that receipt",
      );
    const offloaded =
      identity.sourceKind === "force_history"
        ? (
            await offloadForceHistoryArrays(
              tx,
              archive as Parameters<typeof offloadForceHistoryArrays>[1],
            )
          ).offloaded
        : await offloadResultHistory(
            tx,
            archive as Parameters<typeof offloadResultHistory>[1],
          );
    if (!offloaded)
      throw new Error(
        "History compare-and-swap refused; inline bytes retained",
      );
    return {
      ...base,
      offloaded: true,
      replayed: false,
      inlineRetained: false,
      reason: null,
      sourceBytes: identity.sourceByteSize,
    };
  });
}

/** Imported/original receipts remain usable only when this database already
 * retains that exact archive for the same local result/attempt. No new owner is
 * asserted and no upstream authorization is inferred from a URL. */
export async function hasExactHzHistoryReceipt(
  db: DB,
  identity: PointHistoryIdentity,
): Promise<boolean> {
  const table = sql.identifier(
    identity.sourceKind === "force_history"
      ? "solver_history_archives"
      : "result_history_archives",
  );
  const [row] =
    await db.execute(sql`SELECT id FROM ${table} WHERE source_instance=${identity.sourceInstance} AND source_kind=${identity.sourceKind}
    AND result_id=${identity.resultId}::uuid AND result_attempt_id IS NOT DISTINCT FROM ${identity.resultAttemptId}::uuid
    ${identity.sourceKind === "force_history" ? sql`AND source_id=${identity.sourceId}::uuid` : sql``}
    AND source_sha256=${identity.sourceSha256} AND source_byte_size=${identity.sourceByteSize}
    AND envelope_sha256=${identity.envelopeSha256} AND envelope_byte_size=${identity.envelopeByteSize}
    AND stored_sha256=${identity.storedSha256} AND stored_byte_size=${identity.storedByteSize}
    AND bucket=${identity.bucket} AND object_key=${identity.objectKey} AND generation=${identity.generation} AND crc32c=${identity.crc32c} LIMIT 1`);
  return Boolean(row);
}
