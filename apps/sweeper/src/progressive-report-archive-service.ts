import {
  backfillWorkerReportPrefix,
  type WorkerPrefixCursor,
} from "@aerodb/db/progressive-report-prefix";
import type { DB } from "@aerodb/db";
import { cancelledReportSourceVerifier } from "./report-archive-source-proof";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configuredDeploymentRole } from "./config";
import {
  cancelledReportOwner,
  nextCancelledReportCopies,
  verifyColdReceiptSources,
  receiptedReportCopy,
  type ReportCopyCursor,
} from "./cancelled-report-copies";
import {
  putWorkerReportBundle,
  readWorkerReportArchiveText,
  WorkerReportFetchDisabled,
} from "./report-archive-broker-client";
import { retainWorkerReportVolume } from "./worker-report-volume";
import {
  ProgressiveReportArchiveStore,
  writeProgressiveReportBundle,
  type ProgressiveReportArchiveIdentity,
} from "./progressive-report-archive-store";

type Source = "remote" | "worker";
type Kind = "report" | "conflict";
type PutFile = (
  path: string,
  identity: { sha256: string; byteSize: number },
  source: Source,
  executionId: string,
  probe: Member,
) => Promise<ProgressiveReportArchiveIdentity>;
const maxMembers = 128;
const encodedByteTarget = 24 * 1024 * 1024;
const restoredByteTarget = 128 * 1024 * 1024;

interface Member {
  sequence: number;
  kind: Kind;
  signature: string;
  sha256: string;
  bytes: number;
  payload: string | null;
  sourceList?: string;
}

function reportTable(source: Source) {
  return sql.identifier(
    source === "remote"
      ? "progressive_remote_reports"
      : "progressive_worker_reports",
  );
}

function owner(source: Source) {
  return source === "remote"
    ? sql`FROM sim_jobs job JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
          JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id`
    : sql`FROM sim_jobs job JOIN sync_sweep_promises promise ON promise.id=(job.request_payload->>'syncPromiseId')::uuid`;
}

function closedScope(source: Source) {
  const stopped =
    source === "remote"
      ? sql`EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stop
          WHERE stop.sim_job_id=job.id AND stop.engine_job_id=job.engine_job_id)`
      : sql`job.request_payload->>'remoteSolver'='true'
         AND EXISTS (SELECT 1 FROM progressive_worker_reports stopped
           WHERE stopped.sim_job_id=job.id AND stopped.stopped_engine_job_id=job.engine_job_id)
         AND NOT EXISTS (SELECT 1 FROM progressive_worker_reports pending
           WHERE pending.sim_job_id=job.id AND pending.acknowledged_at IS NULL)`;
  return sql`job.status IN ('done','failed','cancelled') AND job."ingestedAt" IS NOT NULL
    AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
    AND promise.status IN ('fulfilled','cancelled','expired') AND ${stopped}`;
}

// A mixed-angle report stays online while any of its reported points still
// needs its first delivery. A rejected outbox report has a separate identity.
function settledReport(source: Source) {
  return source === "remote"
    ? sql`EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
           WHERE inventory.sim_job_id=r.sim_job_id AND inventory.sequence=r.sequence
             AND inventory.report_content_signature=r.content_signature)
         AND NOT EXISTS (SELECT 1 FROM progressive_remote_report_sources s
           WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence
             AND NOT EXISTS (SELECT 1 FROM progressive_remote_evidence_receipts e
               WHERE e.sim_job_id=s.sim_job_id AND e.point_content_signature=s.point_content_signature)
             AND NOT EXISTS (SELECT 1 FROM progressive_remote_diagnostic_receipts d
               WHERE d.sim_job_id=s.sim_job_id AND d.point_content_signature=s.point_content_signature))`
    : sql`r.acknowledged_at IS NOT NULL AND (
           EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
             WHERE staged.sim_job_id=r.sim_job_id AND staged.sequence=r.sequence AND staged.content_signature=r.content_signature)
           OR EXISTS (SELECT 1 FROM progressive_worker_report_conflicts c
             WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence AND c.content_signature=r.content_signature)
           OR (r.result_payload_hash IS NULL AND jsonb_typeof(r.report->'result') IS DISTINCT FROM 'object'))
         AND progressive_worker_report_evidence_settled(r.sim_job_id,r.sequence)`;
}

function memberKeys(source: Source, executionId: string) {
  const conflicts =
    source === "worker"
      ? sql`UNION ALL SELECT c.sequence, 'conflict' AS kind
      FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=${executionId}::uuid
        AND c.archived_at IS NULL AND c.body_source_sequence IS NULL
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_reports w WHERE w.sim_job_id=c.sim_job_id
          AND w.sequence=c.sequence AND w.content_signature=c.content_signature
          AND progressive_worker_conflict_body_matches(c.sim_job_id,c.sequence,c.content_signature,c.report))`
      : sql``;
  return sql`SELECT sequence, kind FROM (
    SELECT r.sequence,'report' AS kind FROM ${reportTable(source)} r
    WHERE r.sim_job_id=${executionId}::uuid AND r.archived_at IS NULL AND ${settledReport(source)}
    ${conflicts}
  ) keys ORDER BY sequence, kind DESC LIMIT ${maxMembers}`;
}

// Repeated snapshots usually differ only at the sequence or a status timestamp.
// Offsets refer to UTF-16 code units so even a split surrogate pair is reversible.
function archiveLine(
  metadata: object,
  current: string,
  previous?: string,
): string {
  const inline = () =>
    JSON.stringify(metadata).slice(0, -1) + ',"report":' + current + "}";
  if (!previous) return inline();
  const limit = Math.min(previous.length, current.length);
  let prefix = 0;
  while (
    prefix < limit &&
    previous.charCodeAt(prefix) === current.charCodeAt(prefix)
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    previous.charCodeAt(previous.length - 1 - suffix) ===
      current.charCodeAt(current.length - 1 - suffix)
  )
    suffix++;
  if (prefix + suffix < 128) return inline();
  const delta = JSON.stringify({
    ...metadata,
    reportDelta: {
      prefix,
      suffix,
      middle: current.slice(prefix, current.length - suffix),
    },
  });
  return delta.length < current.length ? delta : inline();
}

async function* archiveLines(
  db: DB,
  source: Source,
  executionId: string,
  keys: { sequence: unknown; kind: unknown; inventorySignature?: string }[],
  members: Member[],
) {
  let logicalBytes = 0;
  let encodedBytes = 0;
  let previous: string | undefined;
  const verifySource = cancelledReportSourceVerifier(executionId);
  for (const key of keys) {
    const sequence = Number(key.sequence);
    const kind = key.kind as Kind;
    const conflict = kind === "conflict";
    const table = conflict
      ? sql.identifier("progressive_worker_report_conflicts")
      : reportTable(source);
    // postgres-js would otherwise parse jsonb NUMERIC values as JS doubles.
    const body = conflict
      ? sql`report::text`
      : sql`public.resolve_progressive_report(report,result_payload_hash)::text`;
    const [row] =
      await db.execute(sql`SELECT content_signature, ${body} AS body,
      ${conflict ? sql`NULL::text` : sql`result_payload_hash`} AS payload FROM ${table}
      WHERE sim_job_id=${executionId}::uuid AND sequence=${sequence} AND archived_at IS NULL`);
    if (!row)
      throw new Error("Report was already archived while preparing its bundle");
    const raw = String(row.body);
    const bytes = Buffer.byteLength(raw);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const signature = String(row.content_signature);
    let sourceList: string | undefined;
    if (key.inventorySignature !== undefined) {
      // Bound an individual member for the full product reader. Verify the
      // actual PG numeric tokens and scientific source inventory before upload.
      if (bytes > restoredByteTarget) continue;
      sourceList = verifySource(raw, sequence, signature, key.inventorySignature);
    }
    members.push({
      sequence,
      kind,
      signature,
      bytes,
      sha256,
      payload: row.payload == null ? null : String(row.payload),
      sourceList,
    });
    const line = archiveLine(
      {
        kind,
        sourceKind: source,
        executionId,
        sequence,
        contentSignature: signature,
        reportSha256: sha256,
        reportByteSize: bytes,
      },
      raw,
      previous,
    );
    yield line;
    previous = raw;
    logicalBytes += bytes;
    encodedBytes += Buffer.byteLength(line) + 1;
    if (encodedBytes >= encodedByteTarget || logicalBytes >= restoredByteTarget)
      break;
  }
}

export async function archiveProgressiveReportBatch(
  db: DB,
  source: Source,
  executionId: string,
  putFile: PutFile,
  cancelledSequences?: readonly number[],
): Promise<number> {
  if (
    cancelledSequences &&
    (source !== "remote" ||
      !cancelledSequences.length ||
      cancelledSequences.length > maxMembers ||
      cancelledSequences.some((n) => !Number.isSafeInteger(n) || n < 1))
  )
    throw new Error(
      "Cancelled report copies require bounded exact hub sequences",
    );
  const scope = sql`SELECT job.id ${owner(source)} WHERE job.id=${executionId}::uuid
    AND ${cancelledSequences ? cancelledReportOwner : closedScope(source)}`;
  if (!(await db.execute(scope)).length) return 0;
  const keys = cancelledSequences
    ? await db.execute<{
        sequence: string;
        kind: string;
        inventorySignature: string;
      }>(sql`
        SELECT r.sequence,'report' AS kind,inventory.inventory_signature AS "inventorySignature"
        FROM progressive_remote_reports r JOIN progressive_remote_report_inventories inventory USING (sim_job_id,sequence)
        WHERE r.sim_job_id=${executionId}::uuid AND r.archived_at IS NULL AND r.sequence IN (
          ${sql.join(
            cancelledSequences.map((n) => sql`${n}::bigint`),
            sql`,`,
          )})
          AND ${receiptedReportCopy} ORDER BY r.sequence`)
    : (await db.execute(memberKeys(source, executionId))).map(
        ({ sequence, kind }) => ({ sequence, kind }),
      );
  if (!keys.length) return 0;
  if(cancelledSequences)await verifyColdReceiptSources(db,executionId,keys.map(k=>Number(k.sequence)));
  const dir = await mkdtemp(join(tmpdir(), "progressive-reports-"));
  const members: Member[] = [];
  try {
    const path = join(dir, "reports.jsonl.gz");
    const local = await writeProgressiveReportBundle(
      path,
      archiveLines(db, source, executionId, keys, members),
    );
    if (!members.length) return 0;
    const remote = await putFile(path, local, source, executionId, members[0]!);
    if (
      remote.storedSha256 !== local.sha256 ||
      remote.storedByteSize !== local.byteSize ||
      remote.mimeType !== "application/gzip" ||
      remote.compression !== "gzip" ||
      remote.archiveFormat !== "jsonl" ||
      !remote.bucket ||
      !remote.objectKey ||
      !Number.isFinite(remote.verifiedAt.getTime())
    )
      throw new Error("Archive readback differs from the uploaded bundle");

    return await db.transaction(async (tx) => {
      const conn = tx as unknown as DB;
      if (!(await conn.execute(sql`${scope} FOR UPDATE OF job,promise`)).length)
        return 0;
      const [inserted] =
        await conn.execute(sql`INSERT INTO progressive_report_archive_bundles
        (source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,archive_format,
         stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
        VALUES (${source},${executionId}::uuid,${remote.bucket},${remote.objectKey},${remote.generation},'application/gzip',
          'gzip','jsonl',${local.sha256},${local.byteSize},${remote.crc32c},${members.length},
          ${members[0]!.sequence},${members[members.length - 1]!.sequence},${remote.verifiedAt.toISOString()}::timestamptz)
        ON CONFLICT (bucket,object_key,generation,sim_job_id) DO NOTHING RETURNING id`);
      if (!inserted) {
        const [replay] =
          await conn.execute(sql`SELECT count(m.sequence)::int AS n
          FROM progressive_report_archive_bundles b JOIN progressive_report_archive_members m ON m.bundle_id=b.id
          WHERE b.bucket=${remote.bucket} AND b.object_key=${remote.objectKey} AND b.generation=${remote.generation}
            AND b.source_kind=${source} AND b.sim_job_id=${executionId}::uuid AND b.stored_sha256=${local.sha256}
            AND b.stored_byte_size=${local.byteSize} AND b.crc32c=${remote.crc32c}`);
        if (Number(replay?.n) !== members.length)
          throw new Error("Archive replay differs from its committed members");
        return 0;
      }
      const entries = JSON.stringify(
        members.map(({ sequence, kind, signature, bytes, sha256 }) => ({
          sequence,
          kind,
          signature,
          bytes,
          sha256,
        })),
      );
      await conn.execute(sql`INSERT INTO progressive_report_archive_members
        (bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
        SELECT ${inserted.id}::uuid,${source},${executionId}::uuid,s.sequence,s.kind,s.signature,s.sha256,s.bytes
        FROM jsonb_to_recordset(${entries}::jsonb) s(sequence bigint,kind text,signature text,sha256 text,bytes bigint)`);
      for (const kind of new Set(members.map((member) => member.kind))) {
        const conflict = kind === "conflict";
        const table = conflict
          ? sql.identifier("progressive_worker_report_conflicts")
          : reportTable(source);
        // Bind the live source rows to the exact list reconstructed from the
        // uploaded PG bytes. A same-count substitution cannot pass the update.
        const sourceLists = cancelledSequences
          ? JSON.stringify(
              Object.fromEntries(
                members.map((m) => [m.sequence, m.sourceList]),
              ),
            )
          : null;
        const changed =
          await conn.execute(sql`UPDATE ${table} r SET archive_bundle_id=${inserted.id}::uuid,
          archived_at=clock_timestamp(),${conflict ? sql`` : sql`result_payload_hash=NULL,`}
          report=progressive_report_compact_header(r.report)
          FROM progressive_report_archive_members m WHERE m.bundle_id=${inserted.id}::uuid
            AND m.member_kind=${kind} AND r.sim_job_id=m.sim_job_id AND r.sequence=m.sequence
            AND r.content_signature=m.content_signature AND r.archived_at IS NULL
            ${conflict ? sql`` : sql`AND ${cancelledSequences ? receiptedReportCopy : settledReport(source)}`}
            ${
              sourceLists
                ? sql`AND (SELECT jsonb_agg(jsonb_build_object('point_content_signature',s.point_content_signature,
              'aoa_deg',s.aoa_deg,'case_slug',s.case_slug) ORDER BY s.point_content_signature COLLATE "C")
              FROM progressive_remote_report_sources s WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence)
              =((${sourceLists}::jsonb)->>r.sequence::text)::jsonb`
                : sql``
            } RETURNING r.sequence`);
        if (changed.length !== members.filter((m) => m.kind === kind).length)
          throw new Error(
            "Report or evidence status changed before archive commit",
          );
      }
      const hashes = [
        ...new Set(members.flatMap((m) => (m.payload ? [m.payload] : []))),
      ];
      if (hashes.length)
        await conn.execute(sql`DELETE FROM progressive_report_result_payloads p
        WHERE p.content_hash IN (${sql.join(
          hashes.map((h) => sql`${h}`),
          sql`,`,
        )})
        AND NOT EXISTS (SELECT FROM progressive_worker_reports w WHERE w.result_payload_hash=p.content_hash)
        AND NOT EXISTS (SELECT FROM progressive_remote_reports r WHERE r.result_payload_hash=p.content_hash)`);
      return members.length;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function nextProgressiveReportArchiveJob(
  db: DB,
  source: Source,
  after: string | null,
) {
  // The hub's partial index starts at the first still-inline report. Seek
  // past the entire execution so even a large open job costs one index key.
  const batch =
    source === "remote"
      ? sql`WITH RECURSIVE batch(id, visited) AS (
          (SELECT r.sim_job_id, 1 FROM progressive_remote_reports r
           WHERE r.archived_at IS NULL ${after ? sql`AND r.sim_job_id>${after}::uuid` : sql``}
           ORDER BY r.sim_job_id,r.sequence LIMIT 1)
          UNION ALL
          SELECT next_job.id, prev.visited+1 FROM batch prev CROSS JOIN LATERAL (
            SELECT r.sim_job_id AS id FROM progressive_remote_reports r
            WHERE r.archived_at IS NULL AND r.sim_job_id>prev.id
            ORDER BY r.sim_job_id,r.sequence LIMIT 1
          ) next_job WHERE prev.visited<32
        )`
      : sql`WITH batch AS MATERIALIZED (
          SELECT j.id FROM sim_jobs j WHERE j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
            ${after ? sql`AND j.id>${after}::uuid` : sql``} ORDER BY j.id LIMIT 64
        )`;
  const workerPending =
    source === "worker"
      ? sql`AND (EXISTS (SELECT 1 FROM progressive_worker_reports r
          WHERE r.sim_job_id=job.id AND r.archived_at IS NULL)
        OR EXISTS (SELECT 1 FROM progressive_worker_report_conflicts c
          WHERE c.sim_job_id=job.id AND c.archived_at IS NULL AND c.body_source_sequence IS NULL))`
      : sql``;
  const [job] = await db.execute<{ id: string | null; last_id: string | null }>(
    sql`${batch}, eligible AS (
      SELECT job.id ${owner(source)} JOIN batch ON batch.id=job.id
      WHERE ${closedScope(source)} ${workerPending} ORDER BY job.id LIMIT 1
    ) SELECT (SELECT id FROM eligible) AS id, (SELECT id FROM batch ORDER BY id DESC LIMIT 1) AS last_id`,
  );
  return job;
}

export async function runProgressiveReportArchiveService(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  const source: Source =
    configuredDeploymentRole() === "remote-solver" ? "worker" : "remote";
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  const store =
    source === "remote" && bucket
      ? new ProgressiveReportArchiveStore(bucket)
      : null;
  if (source === "remote" && !store) {
    // Standalone installations without cloud storage leave full reports inline.
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    return;
  }
  const upload: PutFile = store
    ? store.putFile.bind(store)
    : async (path, identity, _source, id, member) => {
        const remote = await putWorkerReportBundle(db, path, identity, id);
        const probe = {
          ...remote,
          sourceKind: "worker" as const,
          memberKind: member.kind,
          executionId: id,
          sequence: member.sequence,
          signature: member.signature,
          reportSha256: member.sha256,
          reportByteSize: member.bytes,
        };
        try {
          await readWorkerReportArchiveText(db, probe, { upstreamOnly: true });
        } catch (error) {
          if (!(error instanceof WorkerReportFetchDisabled)) throw error;
          await retainWorkerReportVolume(path, remote);
          await readWorkerReportArchiveText(db, probe);
        }
        return remote;
      };
  let copyCursor: ReportCopyCursor | null = null;
  let nextCopyScan = 0;
  let after: string | null = null;
  let hubArchivedThisSweep = false;
  while (!signal.aborted) {
    let waitMs = 30000;
    let current: string | null = null;
    try {
      const job = await nextProgressiveReportArchiveJob(db, source, after);
      if (job?.id) {
        current = String(job.id);
        after = current;
        const n = await archiveProgressiveReportBatch(
          db,
          source,
          current,
          upload,
        );
        if (n) {
          if (source === "remote") hubArchivedThisSweep = true;
          console.info(
            JSON.stringify({
              component: "progressive-report-archive",
              source,
              executionId: current,
              members: n,
            }),
          );
        }
        waitMs = 100;
      } else {
        after = job?.last_id ?? null;
        if (after || hubArchivedThisSweep) waitMs = 100;
        if (!after) hubArchivedThisSweep = false;
      }
    } catch (error) {
      console.error(
        "[sweeper] report archive",
        source,
        current,
        error instanceof Error ? error.message : String(error),
      );
      if (current) waitMs = 1500;
    }
    const nextJobScan = Date.now() + waitMs;
    do {
      if (store && !signal.aborted && Date.now() >= nextCopyScan) {
        try {
          const page = await nextCancelledReportCopies(db, copyCursor);
          // Advance past refused or concurrently changed copies on this pass.
          copyCursor = page.after;
          nextCopyScan = Date.now() + (copyCursor ? 500 : 30_000);
          if (page.executionId) {
            const members = await archiveProgressiveReportBatch(
              db,
              "remote",
              page.executionId,
              upload,
              page.sequences,
            );
            if (members) {
              if (members < page.sequences.length)
                copyCursor = {
                  executionId: page.executionId,
                  sequence: page.sequences[members - 1]!,
                };
              console.info(
                JSON.stringify({
                  component: "cancelled-report-copies",
                  members,
                }),
              );
            }
          }
        } catch (error) {
          nextCopyScan = Date.now() + 30_000;
          console.error(
            "[sweeper] cancelled report copies",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      // Both use the same connection budget. A copy page never starts an
      // extra ordinary discovery pass during that pass's idle backoff.
      const wake = store ? Math.min(nextJobScan, nextCopyScan) : nextJobScan;
      try {
        await delay(Math.max(0, wake - Date.now()), undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    } while (!signal.aborted && Date.now() < nextJobScan);
  }
}

// Older rejected deliveries contain two independent copies of the same JSON.
// The DB trigger compares exact bytes before it replaces either with a pointer.
export async function runDuplicateReportCleanup(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  let cursor: { job: string; sequence: number } | undefined;
  while (!signal.aborted) {
    let pause = 60_000;
    try {
      const [page] = await db.execute(sql`
        WITH selected AS MATERIALIZED (
          SELECT c.sim_job_id,c.sequence FROM progressive_worker_report_conflicts c
          WHERE c.body_source_sequence IS NULL AND c.archived_at IS NULL
            ${cursor ? sql`AND (c.sim_job_id,c.sequence)>(${cursor.job}::uuid,${cursor.sequence})` : sql``}
          ORDER BY c.sim_job_id,c.sequence LIMIT 12 FOR UPDATE SKIP LOCKED
        ), changed AS (
          UPDATE progressive_worker_report_conflicts c SET body_source_sequence=c.sequence
          FROM selected WHERE c.sim_job_id=selected.sim_job_id AND c.sequence=selected.sequence
            AND c.body_source_sequence IS NULL AND c.archived_at IS NULL RETURNING c.sequence
        )
        SELECT selected.sim_job_id,selected.sequence,(SELECT count(*) FROM changed) AS linked
        FROM selected ORDER BY selected.sim_job_id DESC,selected.sequence DESC LIMIT 1
      `);
      if (page) {
        cursor = {
          job: String(page.sim_job_id),
          sequence: Number(page.sequence),
        };
        pause = 100;
        if (Number(page.linked))
          console.info(
            JSON.stringify({
              component: "progressive-duplicate-reports",
              linked: Number(page.linked),
            }),
          );
      } else cursor = undefined;
    } catch (error) {
      console.error(
        "[sweeper] duplicate report cleanup failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await delay(pause, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

interface NativeReportVisit {
  after: WorkerPrefixCursor | null;
  rows: number;
  readyAt: number;
  range?: { executionId: string; last: number };
}

// Comma-separated executionId:first-last. A deployment can prioritize a finite
// census without creating another worker or changing ongoing discovery.
function nativeReportPriorityRanges(): NativeReportVisit[] {
  const config = process.env.AIRFOILFOAM_NATIVE_REPORT_PRIORITY_RANGES?.trim();
  if (!config) return [];
  const entries = config.split(",");
  const plans: NativeReportVisit[] = [];
  const entry =
    /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([0-9]+)-([0-9]+)$/i;
  for (const value of entries) {
    const match = entry.exec(value.trim());
    const first = Number(match?.[2]),
      last = Number(match?.[3]);
    if (
      entries.length > 32 ||
      !match ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 1 ||
      first > last
    ) {
      console.error("[sweeper] invalid native report priority ranges");
      return [];
    }
    const executionId = match[1].toLowerCase();
    plans.push({
      after: { executionId, sequence: first - 1 },
      rows: 8,
      readyAt: 0,
      range: { executionId, last },
    });
  }
  return plans;
}

/** Local historical sharing has no cloud dependency. The existing report
 * storage process owns its lifetime, signal and bounded database pool. */
export async function runNativeWorkerReportSharing(
  db: DB,
  signal: AbortSignal,
  after: WorkerPrefixCursor | null = null,
): Promise<void> {
  if (
    configuredDeploymentRole() !== "remote-solver" ||
    process.env.AIRFOILFOAM_NATIVE_REPORT_SHARING !== "true"
  )
    return;
  const excludeJobs = (process.env.AIRFOILFOAM_NATIVE_REPORT_EXCLUDE_JOBS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const inspectedThrough = new Map<string, number>();
  const ordinary: NativeReportVisit = { after, rows: 8, readyAt: 0 };
  const priority = nativeReportPriorityRanges();
  let preferPriority = true;
  while (!signal.aborted) {
    const now = Date.now();
    const index = priority.findIndex((item) => item.readyAt <= now);
    const visit: NativeReportVisit =
      index >= 0 && (preferPriority || ordinary.readyAt > now)
        ? priority.splice(index, 1)[0]
        : ordinary;
    let pause = 100;
    if (visit.readyAt <= now) {
      preferPriority = visit === ordinary;
      const { range } = visit;
      let again = !!range;
      try {
        const result = await backfillWorkerReportPrefix(db, {
          apply: true,
          after: visit.after,
          excludeJobs,
          rows: visit.rows,
          ...(range
            ? {
                executionId: range.executionId,
                throughSequence: range.last,
                minStoredBytes: 32 * 1024,
              }
            : { inspectedThrough }),
        });
        if (
          result.normalized ||
          result.state === "reader-unverified" ||
          result.state === "timed-out"
        )
          console.info(
            JSON.stringify({
              component: "native-worker-report-sharing",
              ...result,
              ...(range ? { priorityThrough: range.last } : {}),
              physicalSpaceReleased: null,
            }),
          );
        if (result.state === "disabled") {
          inspectedThrough.clear();
          ordinary.after = null;
          ordinary.rows = 8;
          pause = 300_000;
        } else {
          visit.after = result.after;
          if (!range && visit.after && result.inspectedThrough !== null)
            inspectedThrough.set(
              visit.after.executionId,
              result.inspectedThrough,
            );
          if (result.state === "complete") visit.readyAt = Date.now() + 300_000;
          if (result.state === "timed-out" && visit.rows > 2) {
            visit.rows = Math.max(2, Math.floor(visit.rows / 2));
            visit.readyAt = Date.now() + 1500;
          } else if (
            (result.state === "busy" || result.state === "timed-out") &&
            visit.after
          ) {
            if (range) visit.readyAt = Date.now() + 30_000;
            else
              visit.after = {
                executionId: visit.after.executionId,
                sequence: null,
              };
          }
          if (visit.after?.sequence == null) visit.rows = 8;
          again =
            !!range &&
            visit.after?.sequence != null &&
            visit.after.sequence < range.last;
        }
      } catch (error) {
        console.error(
          "[sweeper] native worker report sharing",
          error instanceof Error ? error.message : String(error),
        );
        visit.readyAt = Date.now() + 30_000;
      }
      if (again) priority.push(visit);
    }
    const earliest = Math.min(
      ordinary.readyAt,
      ...priority.map((item) => item.readyAt),
    );
    await delay(Math.max(pause, earliest - Date.now()), undefined, {
      signal,
    }).catch((error) => {
      if (!signal.aborted) throw error;
    });
  }
}
