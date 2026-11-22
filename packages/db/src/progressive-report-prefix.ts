import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { readProgressiveReport } from "./progressive-report-reader";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const scanRows = 128;

export interface WorkerPrefixCursor {
  executionId: string;
  /** Null seeks past this entire execution using the report index. */
  sequence: number | null;
}

export interface WorkerPrefixOptions {
  apply?: boolean;
  after?: WorkerPrefixCursor | null;
  executionId?: string;
  excludeJobs?: readonly string[];
  /** Completed metadata ranges within the current automatic worker lifetime. */
  inspectedThrough?: ReadonlyMap<string, number>;
  rows?: number;
  minStoredBytes?: number;
  maxBytes?: number;
}

type State =
  | "complete"
  | "excluded"
  | "ineligible"
  | "disabled"
  | "scanned"
  | "busy"
  | "timed-out"
  | "reader-unverified"
  | "preview"
  | "no-saving"
  | "shared";

function receipt(state: State, after: WorkerPrefixCursor | null, matched = 0) {
  return {
    state,
    after,
    matched,
    normalized: 0,
    inspectedThrough: null as number | null,
    reusedPreviousPayload: false,
    binaryVerified: 0,
    contentSignaturesSha256: null as string | null,
    sharedHash: null as string | null,
    firstSequence: null as number | null,
    originalReportValueBytes: 0,
    reportValueBytesReduced: 0,
    retainedPayloadBytes: 0,
    referenceBytesAdded: 0,
    sharedValueBytesCharged: 0,
    netValueBytesSavedAtLeast: 0,
  };
}

// Rolling back also reverses a newly inserted shared payload. Returning a skip
// from inside the transaction would commit an unprofitable representation.
class DeclinedPrefix extends Error {
  constructor(readonly result: ReturnType<typeof receipt>) {
    super(result.state);
  }
}

/** A worker-only fast path for closed historical reports. Each call visits at
 * most one execution and one ordered metadata page, including a lookahead row. */
export async function backfillWorkerReportPrefix(
  db: DB,
  input: WorkerPrefixOptions = {},
) {
  const rows = input.rows ?? 8,
    min = input.minStoredBytes ?? 256 * 1024,
    max = input.maxBytes ?? 96 * 1024 * 1024;
  const cursor = input.after;
  let visiting = cursor ?? null;
  if (
    !Number.isSafeInteger(rows) ||
    rows < 2 ||
    rows > scanRows ||
    !Number.isSafeInteger(min) ||
    min < 1 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 512 * 1024 ** 2 ||
    (input.executionId !== undefined && !uuid.test(input.executionId)) ||
    input.excludeJobs?.some((id) => !uuid.test(id)) ||
    (cursor &&
      (!uuid.test(cursor.executionId) ||
        (input.executionId && cursor.executionId !== input.executionId) ||
        (cursor.sequence !== null &&
          (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0))))
  )
    throw new Error("Invalid native report prefix options");
  try {
    return await db.transaction(async (tx) => {
      const conn = tx as unknown as DB;
      await tx.execute(sql`SET LOCAL statement_timeout='30s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='1500ms'`);
      const [policy] =
        await tx.execute(sql`SELECT normalization_enabled FROM public.progressive_report_storage_policy WHERE id=1
        ${input.apply ? sql`FOR SHARE` : sql``}`);
      if (policy?.normalization_enabled !== true)
        return receipt("disabled", cursor ?? null);
      if (input.executionId && cursor?.sequence === null)
        return receipt("complete", null);
      let job =
        input.executionId ??
        (cursor && cursor.sequence !== null ? cursor.executionId : undefined);
      if (!job) {
        const [next] = await tx.execute<{
          id: string;
        }>(sql`SELECT sim_job_id::text AS id FROM public.progressive_worker_reports
          WHERE archived_at IS NULL ${cursor ? sql`AND sim_job_id>${cursor.executionId}::uuid` : sql``}
          ORDER BY sim_job_id,sequence LIMIT 1`);
        if (!next) return receipt("complete", null);
        job = next.id;
      }
      const nextJob = { executionId: job, sequence: null };
      const sequence =
        cursor?.executionId === job && cursor.sequence !== null
          ? cursor.sequence
          : (input.inspectedThrough?.get(job) ?? 0);
      const start = { executionId: job, sequence };
      visiting = start;
      if (
        input.excludeJobs?.some((id) => id.toLowerCase() === job!.toLowerCase())
      )
        return receipt("excluded", nextJob);
      // Native sharing needs no hub dispatch, stage receipt or cloud object.
      // The worker and its existing closed promise retain their normal ownership.
      const [owner] =
        await tx.execute(sql`SELECT j.id FROM public.sim_jobs j JOIN public.sync_sweep_promises p
        ON p.id=CASE WHEN j.request_payload->>'syncPromiseId' ~* ${uuid.source} THEN (j.request_payload->>'syncPromiseId')::uuid END AND p.status IN ('fulfilled','expired','cancelled')
        WHERE j.id=${job}::uuid AND j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
          AND j.request_payload->>'remoteSolver'='true' AND j.engine_job_id=j.id::text
          AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
          AND EXISTS(SELECT 1 FROM public.progressive_worker_reports r WHERE r.sim_job_id=j.id AND r.stopped_engine_job_id=j.engine_job_id)
          AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_reports r WHERE r.sim_job_id=j.id AND r.acknowledged_at IS NULL)
        ${input.apply ? sql`FOR SHARE OF j,p NOWAIT` : sql``}`);
      if (!owner) return receipt("ineligible", nextJob);

      const page = await tx.execute<{
        n: number;
        bytes: number;
        signature: string;
        referenced: boolean;
      }>(sql`SELECT sequence::float8 AS n,result_payload_hash IS NOT NULL AS referenced,
        CASE WHEN result_payload_hash IS NULL THEN pg_column_size(report) ELSE 0 END AS bytes,content_signature AS signature
        FROM public.progressive_worker_reports WHERE sim_job_id=${job}::uuid AND sequence>${sequence} AND archived_at IS NULL
        ORDER BY sequence LIMIT ${scanRows + 1}`);
      const eligible = (r: { bytes: number }) =>
        r.bytes >= min && r.bytes <= max;
      const first = page.findIndex(
        (r, i) =>
          i < scanRows &&
          eligible(r) &&
          (i === 0 ||
            page[i - 1].referenced ||
            (!!page[i + 1] &&
              eligible(page[i + 1]) &&
              r.bytes + page[i + 1].bytes <= max)),
      );
      if (first === -1)
        return {
          ...receipt(
            "scanned",
            page.length > scanRows
              ? { executionId: job, sequence: page[scanRows - 1].n }
              : nextJob,
          ),
          inspectedThrough:
            page.length > scanRows
              ? null
              : Math.max(0, (page.at(-1)?.n ?? sequence) - 1),
        };
      const selected: number[] = [];
      let storedBytes = 0;
      for (const r of page.slice(first, first + rows)) {
        if (!eligible(r) || storedBytes + r.bytes > max) break;
        selected.push(r.n);
        storedBytes += r.bytes;
      }
      const firstKey = { executionId: job, sequence: selected[0] };
      const keys = sql.join(
        selected.map((n) => sql`${n}::bigint`),
        sql`,`,
      );
      const source = sql`WITH RECURSIVE src AS MATERIALIZED (
        SELECT sequence,content_signature,pg_column_size(report) AS stored_bytes,report AS original
        FROM public.progressive_worker_reports WHERE sim_job_id=${job}::uuid AND sequence IN (${keys})
          AND archived_at IS NULL AND result_payload_hash IS NULL ORDER BY sequence
          ${input.apply ? sql`FOR UPDATE SKIP LOCKED` : sql``}
      ), ordered AS MATERIALIZED (
        SELECT src.*,row_number() OVER(ORDER BY sequence) AS position FROM src
      ), anchor AS MATERIALIZED (
        SELECT original->'result' AS body FROM ordered WHERE position=1
      ), walk(position,binary_bytes) AS (
        SELECT position,pg_column_size(original || '{}'::jsonb)::bigint FROM ordered CROSS JOIN anchor
        WHERE position=1 AND (SELECT count(*) FROM src)=${selected.length} AND jsonb_typeof(body)='object'
          AND original->>'archivedReport' IS DISTINCT FROM 'true'
        UNION ALL
        SELECT n.position,w.binary_bytes+pg_column_size(n.original || '{}'::jsonb)
        FROM walk w JOIN ordered n ON n.position=w.position+1 CROSS JOIN anchor
        WHERE w.binary_bytes<=${max} AND n.original->>'archivedReport' IS DISTINCT FROM 'true'
          AND pg_catalog.record_image_eq(ROW(n.original->'result'),ROW(anchor.body))
      ), prefix AS MATERIALIZED (
        SELECT ordered.* FROM ordered JOIN walk USING(position) WHERE walk.binary_bytes<=${max}
      ), retained AS MATERIALIZED (
        SELECT p.content_hash FROM public.progressive_report_result_payloads p CROSS JOIN anchor
        WHERE p.content_hash=(SELECT result_payload_hash FROM public.progressive_worker_reports
          WHERE sim_job_id=${job}::uuid AND sequence<${selected[0]} AND archived_at IS NULL ORDER BY sequence DESC LIMIT 1)
          AND EXISTS(SELECT 1 FROM prefix) AND p.byte_size<=${max}
          AND pg_catalog.record_image_eq(ROW(p.result),ROW(anchor.body))
        ${input.apply ? sql`FOR KEY SHARE OF p` : sql``}
      )`;
      const summary = sql`(SELECT count(*)::int FROM src) AS locked,(SELECT count(*)::int FROM prefix) AS matched,
        (SELECT max(sequence)::float8 FROM prefix) AS last, EXISTS(SELECT 1 FROM retained) AS reused`;
      if (!input.apply) {
        const [preview] = await tx.execute(sql`${source} SELECT ${summary},
          (SELECT sum(stored_bytes)::float8 FROM prefix) AS prior_bytes`);
        const matched = Number(preview.matched);
        const useful = matched >= 2 || preview.reused === true;
        return {
          ...receipt(
            useful ? "preview" : "scanned",
            useful
              ? { executionId: job, sequence: Number(preview.last) }
              : firstKey,
            matched,
          ),
          firstSequence: matched ? firstKey.sequence : null,
          originalReportValueBytes: Number(preview.prior_bytes ?? 0),
          reusedPreviousPayload: preview.reused === true,
        };
      }

      const [result] = await tx.execute(sql`${source}, shared AS MATERIALIZED (
        SELECT coalesce((SELECT content_hash FROM retained),public.store_progressive_report_result(body)) AS hash, public.progressive_report_result_header(body) AS header
        FROM anchor WHERE (SELECT count(*) FROM prefix)>=2 OR EXISTS(SELECT 1 FROM retained)
      ), written AS (
        UPDATE public.progressive_worker_reports r SET result_payload_hash=s.hash,report=jsonb_set(p.original,'{result}',s.header,false)
        FROM prefix p CROSS JOIN shared s WHERE r.sim_job_id=${job}::uuid AND r.sequence=p.sequence AND r.content_signature=p.content_signature
          AND r.archived_at IS NULL AND r.result_payload_hash IS NULL
        RETURNING r.sequence,r.content_signature,r.report,r.result_payload_hash,p.original,p.content_signature AS expected,p.stored_bytes
      ) SELECT ${summary},count(*)::int AS changed,
        count(*) FILTER(WHERE expected=content_signature AND pg_catalog.record_image_eq(
          ROW(public.resolve_progressive_report(report,result_payload_hash)),ROW(original)))::int AS exact,
        sum(stored_bytes)::float8 AS prior_bytes,min(result_payload_hash) AS hash,
        EXISTS(SELECT 1 FROM public.progressive_report_result_payloads p WHERE p.content_hash=(SELECT hash FROM shared) FOR KEY SHARE OF p) AS already_present,
        encode(sha256(convert_to(string_agg(sequence::text||':'||content_signature,',' ORDER BY sequence),'UTF8')),'hex') AS signatures
        FROM written`);
      if (Number(result.locked) !== selected.length)
        return receipt("busy", start);
      const changed = Number(result.changed);
      if (Number(result.matched) < 2 && changed === 0)
        return receipt("scanned", firstKey, Number(result.matched));
      if (
        changed !== Number(result.matched) ||
        changed !== Number(result.exact) ||
        !sha256.test(String(result.hash)) ||
        !sha256.test(String(result.signatures))
      )
        throw new Error("Worker report binary reconstruction failed");
      const end = { executionId: job, sequence: Number(result.last) };
      // This second statement measures the persisted (possibly toasted) values.
      // Charge all shared value columns unless a pre-existing payload was visible
      // and locked in the original statement snapshot. Concurrent insertion can
      // only make this estimate conservative.
      const [sizes] =
        await tx.execute(sql`SELECT count(*)::int AS n,sum(pg_column_size(report))::float8 AS headers,sum(pg_column_size(result_payload_hash))::float8 AS refs,
        (SELECT pg_column_size(result) FROM public.progressive_report_result_payloads WHERE content_hash=${result.hash}) AS payload,
        (SELECT pg_column_size(content_hash)+pg_column_size(result)+pg_column_size(byte_size)+pg_column_size(created_at)
         FROM public.progressive_report_result_payloads WHERE content_hash=${result.hash}) AS shared_values
        FROM public.progressive_worker_reports WHERE sim_job_id=${job}::uuid AND sequence IN (${keys}) AND sequence<=${end.sequence}
          AND archived_at IS NULL AND result_payload_hash=${result.hash}`);
      if (Number(sizes.n) !== changed || sizes.payload == null)
        throw new Error("Native report size readback differs");
      const reduced = Number(result.prior_bytes) - Number(sizes.headers),
        retained = Number(sizes.payload);
      const refs = Number(sizes.refs),
        charged =
          result.already_present === true ? 0 : Number(sizes.shared_values);
      const saved = reduced - refs - charged;
      if (saved <= 0)
        throw new DeclinedPrefix(receipt("no-saving", end, changed));
      // Every original already passed binary readback. Verify one reference
      // through the ordinary full reader before any update can commit.
      try {
        await readProgressiveReport(conn, {
          sourceKind: "worker",
          ...firstKey,
          contentSignature: page[first].signature,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message ===
            "Progressive full report differs from its exact stored identity"
        )
          throw new DeclinedPrefix(receipt("reader-unverified", firstKey));
        throw error;
      }
      return {
        ...receipt("shared", end, changed),
        normalized: changed,
        binaryVerified: changed,
        sharedHash: String(result.hash),
        firstSequence: firstKey.sequence,
        originalReportValueBytes: Number(result.prior_bytes),
        reusedPreviousPayload: result.reused === true,
        contentSignaturesSha256: String(result.signatures),
        reportValueBytesReduced: reduced,
        retainedPayloadBytes: retained,
        referenceBytesAdded: refs,
        sharedValueBytesCharged: charged,
        netValueBytesSavedAtLeast: saved,
      };
    });
  } catch (error) {
    if (error instanceof DeclinedPrefix) return error.result;
    if (error instanceof Error && "code" in error) {
      if (error.code === "57014") return receipt("timed-out", visiting);
      if (["55P03", "40P01", "40001"].includes(String(error.code)))
        return receipt("busy", visiting);
    }
    throw error;
  }
}
