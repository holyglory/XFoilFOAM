// ---------------------------------------------------------------------------
// Point History Explorer (Solver ▸ Points tab, approved 2026-07-06).
//
// Read model: the results table is the canonical per-(airfoil, revision, aoa)
// point state, so the explorer's row universe is
//   1. every results row (solved, failed, rejected, in-flight, backlog), plus
//   2. terminal derived-by-symmetry campaign cells (the −α mirror rows whose
//      result_id points at the +α source results row).
// Keyset pagination on (last_activity DESC, row_key DESC) where last_activity
// is results."updatedAt" (arm 1) / sim_campaign_points."updatedAt" (arm 2) and
// row_key is 'r:<result uuid>' / 'd:<campaign>:<condition>:<airfoil>:<aoa>'.
// Bounded page + one lateral attempt digest per page row — no per-row N+1.
//
// Status buckets are derived in ONE SQL expression shared by the chip counts
// and the page filter so the numbers always describe exactly the rows listed.
// ---------------------------------------------------------------------------
import {
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
  isDeterministicMeshBlockerError,
} from "@aerodb/core";
import { sql } from "drizzle-orm";

import {
  CampaignError,
  ERROR_CLASS_SQL,
  recomputeCampaignProgress,
  refreshCampaignCompletion,
  type CampaignErrorClass,
} from "./campaigns";
import type { DB } from "./client";
import {
  exactValidSolverManifestSql,
  exactVerifiedRestartableEvidenceArchiveSql,
} from "./evidence-manifest";
import { lockPrecalcCells } from "./precalc-cell-lock";

/** Filterable status buckets. 'rejected' is a DEPRECATED alias kept for old
 *  links/clients: it matches every done+physics-rejected row, i.e. the union
 *  the amendment-A semantic split ('awaiting_urans' violet vs the rejected
 *  part of 'needs_review' red) replaced in the UI. */
export const POINT_HISTORY_BUCKETS = [
  "failed",
  "rejected",
  "awaiting_urans",
  "needs_review",
  "accepted",
  "needs_urans",
  "solving",
] as const;
export type PointHistoryBucket = (typeof POINT_HISTORY_BUCKETS)[number];

// ---------------------------------------------------------------------------
// Amendment-A semantic split, applied to RAW results rows — the same rule the
// campaign payloads derive from sim_campaign_points (see the canonical
// definition + rationale in urans-ladder.ts campaignReviewBucketRows):
//   awaiting_urans — rejected/needs-URANS evidence or a typed hard RANS
//     non-convergence/stall while runnable FAST URANS owns the exact cell:
//     the normal stage-1 → stage-2 handoff, violet, no repair verbs.
//   needs_review — reserved for an explicit future evidence-adjudication
//     workflow. Solver crashes, setup/mesh defects, exhausted period
//     acquisition and missing media are machine failures: they stay visible
//     under failed/rejected/all and Solver Work's blocked state, but never ask
//     a human to repair them by reviewing coefficients.
// ---------------------------------------------------------------------------
const BLOCKED_WORK_SQL = sql`(
  EXISTS (
    SELECT 1 FROM sim_precalc_obligations blocked_obligation
    WHERE blocked_obligation.airfoil_id = r.airfoil_id
      AND blocked_obligation.revision_id = r.simulation_preset_revision_id
      AND blocked_obligation.aoa_deg = r.aoa_deg
      AND blocked_obligation.state = 'blocked'
  )
  OR EXISTS (
    SELECT 1 FROM sim_urans_verify_queue blocked_verify
    WHERE blocked_verify.airfoil_id = r.airfoil_id
      AND blocked_verify.revision_id = r.simulation_preset_revision_id
      AND blocked_verify.aoa_deg = r.aoa_deg
      AND blocked_verify.state = 'blocked'
  )
)`;

const SCHEDULED_WORK_SQL = sql`(
  EXISTS (
    SELECT 1 FROM sim_precalc_obligations open_obligation
    WHERE open_obligation.airfoil_id = r.airfoil_id
      AND open_obligation.revision_id = r.simulation_preset_revision_id
      AND open_obligation.aoa_deg = r.aoa_deg
      AND open_obligation.state IN ('pending', 'running')
  )
  OR EXISTS (
    SELECT 1 FROM sim_urans_requests open_request
    WHERE open_request.airfoil_id = r.airfoil_id
      AND open_request.revision_id = r.simulation_preset_revision_id
      AND (open_request.aoa_deg = r.aoa_deg OR open_request.aoa_deg IS NULL)
      AND open_request.state IN ('pending', 'running')
  )
  OR EXISTS (
    SELECT 1 FROM sim_urans_verify_queue open_verify
    WHERE open_verify.airfoil_id = r.airfoil_id
      AND open_verify.revision_id = r.simulation_preset_revision_id
      AND open_verify.aoa_deg = r.aoa_deg
      AND open_verify.state IN ('pending', 'running')
  )
)`;

/** One per-point journey: a typed hard RANS failure (or legacy explicit
 * non-convergence/stall) is a normal handoff while FAST URANS owns runnable
 * work for the same physical cell. Structured deterministic-mesh and
 * infrastructure failures remain critical even if some unrelated request is
 * open; the conservative legacy fallback also excludes obvious machine,
 * storage, archive and mesh failures. */
const RANS_FAST_HANDOFF_SQL = sql`(
  r.status IN ('done', 'failed')
  AND (
    r.fidelity = 'rans'
    OR (r.fidelity IS NULL AND r.regime IS DISTINCT FROM 'urans')
  )
  AND ${SCHEDULED_WORK_SQL}
  AND NOT ${BLOCKED_WORK_SQL}
  AND NOT EXISTS (
    SELECT 1
    FROM result_attempts infrastructure_attempt
    WHERE infrastructure_attempt.id = r.current_result_attempt_id
      AND infrastructure_attempt.result_id = r.id
      AND infrastructure_attempt.evidence_payload ->> 'failure_disposition'
          IN ('deterministic_mesh', 'infrastructure')
  )
  AND (
    (r.status = 'done' AND rc.state IN ('rejected', 'needs_urans'))
    OR (
      r.status = 'failed'
      AND (
        EXISTS (
          SELECT 1
          FROM result_attempts handoff_attempt
          WHERE handoff_attempt.id = r.current_result_attempt_id
            AND handoff_attempt.result_id = r.id
            AND handoff_attempt.evidence_payload ->> 'failure_disposition'
                = 'hard_solver'
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM result_attempts typed_attempt
            WHERE typed_attempt.id = r.current_result_attempt_id
              AND typed_attempt.result_id = r.id
              AND typed_attempt.evidence_payload ? 'failure_disposition'
          )
          AND (
            r.stalled IS TRUE
            OR COALESCE(r.error, '') ~* '(not[- ]?converg|solver[- ]?stall)'
          )
          AND COALESCE(r.error, '') !~* '(mesh|storage|archive|gcs|blob|disk|connect|unreachable|econn|segmentation|out of memory|\\boom\\b|\\bkilled\\b|\\bcrash)'
        )
      )
    )
  )
)`;

/** Single source of truth for the status chips AND the bucket filter.
 *  `r` = results row, `rc` = LEFT-joined result-level classification.
 *  - solving covers the whole open pipeline: pending (re-claimable), queued
 *    (claimed) and running rows.
 *  - a failed/stalled RANS generation already handed to FAST URANS is part of
 *    the calm automatic journey, never a critical failed-point bucket.
 *  - done rows without a matching classification state (superseded /
 *    unclassified / stale) fall into 'other' — they appear under "all" only,
 *    never silently inflate a chip. */
const BUCKET_SQL = sql`CASE
  WHEN ${RANS_FAST_HANDOFF_SQL} THEN 'rejected'
  WHEN r.status = 'failed' THEN 'failed'
  WHEN r.status IN ('pending', 'queued', 'running') THEN 'solving'
  WHEN r.status = 'done' AND rc.state = 'rejected' THEN 'rejected'
  WHEN r.status = 'done' AND rc.state = 'needs_urans' THEN 'needs_urans'
  WHEN r.status = 'done' AND rc.state = 'accepted' THEN 'accepted'
  ELSE 'other'
END`;

const WORK_DISPOSITION_SQL = sql`CASE
  WHEN ${BLOCKED_WORK_SQL} THEN 'blocked'
  WHEN ${SCHEDULED_WORK_SQL} THEN 'scheduled'
  ELSE NULL
END`;

const AWAITING_URANS_RESULT_SQL = RANS_FAST_HANDOFF_SQL;

/** Continuable (amendment C): a rejected urans_* row whose engine warning says
 * either (a) wall-clock budget stopped a restartable solve or (b) the bounded
 * in-run controller still requires same-case integration, and whose saved case
 * state is addressable. This is machine/action time, never human review. */
export const CONTINUABLE_SQL = sql`(
  r.status = 'done'
  AND EXISTS (
    SELECT 1
    FROM result_attempts continuation_attempt
    JOIN result_classifications continuation_classification
      ON continuation_classification.result_attempt_id = continuation_attempt.id
     AND continuation_classification.state = 'rejected'
    JOIN simulation_preset_revisions continuation_revision
      ON continuation_revision.id = continuation_attempt.simulation_preset_revision_id
    WHERE continuation_attempt.id = r.current_result_attempt_id
      AND continuation_attempt.result_id = r.id
      AND continuation_attempt.airfoil_id = r.airfoil_id
      AND continuation_attempt.bc_id = r.bc_id
      AND continuation_attempt.simulation_preset_revision_id =
          r.simulation_preset_revision_id
      AND continuation_attempt.aoa_deg = r.aoa_deg
      AND continuation_attempt.status IN ('done', 'failed')
      AND continuation_attempt.source = 'solved'
      AND continuation_attempt.evidence_payload ->> 'fidelity'
          IN ('urans_precalc', 'urans_full')
      AND continuation_attempt.engine_job_id IS NOT NULL
      AND continuation_attempt.engine_case_slug IS NOT NULL
      AND continuation_attempt.solver_implementation_id IS NOT NULL
      AND continuation_revision.solver_implementation_id IS NOT NULL
      AND continuation_attempt.solver_implementation_id =
          continuation_revision.solver_implementation_id
      AND EXISTS (
        SELECT 1
        FROM unnest(
          COALESCE(continuation_attempt.quality_warnings, ARRAY[]::text[])
        ) warning
        WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
           OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
      )
      AND (
        SELECT count(*) = 1
          AND bool_and(
            artifact.airfoil_id = continuation_attempt.airfoil_id
            AND artifact.sim_job_id IS NOT DISTINCT FROM
                continuation_attempt.sim_job_id
            AND artifact.engine_job_id IS NOT DISTINCT FROM
                continuation_attempt.engine_job_id
            AND artifact.engine_case_slug IS NOT DISTINCT FROM
                continuation_attempt.engine_case_slug
            AND artifact.aoa_deg IS NOT DISTINCT FROM continuation_attempt.aoa_deg
            AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
            AND artifact.byte_size > 0
            AND length(trim(artifact.storage_key)) > 0
            AND length(trim(artifact.mime_type)) > 0
          )
        FROM solver_evidence_artifacts artifact
        WHERE artifact.result_id = continuation_attempt.result_id
          AND artifact.result_attempt_id = continuation_attempt.id
          AND artifact.kind = 'manifest'
      )
  )
)`;

const NEEDS_REVIEW_RESULT_SQL = sql`FALSE`;

/** Rolling-compatibility ladder bucket of a row (NULL for rows in neither).
 *  `needs_review` has an empty canonical predicate; machine failures are
 *  reported through status and workDisposition. */
const REVIEW_BUCKET_SQL = sql`CASE
  WHEN ${AWAITING_URANS_RESULT_SQL} THEN 'awaiting_urans'
  WHEN ${NEEDS_REVIEW_RESULT_SQL} THEN 'needs_review'
  ELSE NULL
END`;

export interface PointHistoryCursor {
  /** Raw timestamp text carried losslessly back to Postgres. The sort key is
   *  a timestamptz(6) (µs) column; round-tripping through a JS Date (ms)
   *  truncates it and silently DROPS every row whose sub-millisecond digits
   *  exceed the truncated cursor (bulk `now()` stamps share one µs value
   *  across whole batches). The cursor therefore stays a string end to end
   *  and is only compared server-side via `::timestamptz`. */
  lastActivity: string;
  rowKey: string;
}

export const POINT_VERIFY_FILTERS = [
  "pending",
  "disagreed",
  "blocked",
] as const;
export type PointVerifyFilter = (typeof POINT_VERIFY_FILTERS)[number];

export interface PointHistoryFilters {
  bucket?: PointHistoryBucket;
  /** Case-insensitive substring over airfoil name/slug. */
  airfoilQuery?: string;
  campaignId?: string;
  regime?: "rans" | "urans";
  errorClass?: CampaignErrorClass;
  reynolds?: number;
  /** Fidelity-ladder verify-queue filter: 'pending' = an open (pending or
   *  running) verify item covers the cell+angle; 'disagreed' = the latest
   *  settled item flagged a full-vs-precalc disagreement. */
  verify?: PointVerifyFilter;
}

/** Compact per-attempt digest event for the STORY column (bounded: first 12
 *  attempts, error truncated server-side). */
export interface PointAttemptDigestEvent {
  regime: "rans" | "urans" | null;
  validForPolar: boolean;
  converged: boolean;
  stalled: boolean;
  unsteady: boolean;
  strouhal: number | null;
  error: string | null;
}

export interface PointHistoryItem {
  kind: "result" | "derived";
  rowKey: string;
  /** For derived rows this is the +α SOURCE results row. */
  resultId: string;
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  aoaDeg: number;
  /** Derived rows: the +α source angle this mirror was derived from. */
  sourceAoaDeg: number | null;
  reynolds: number | null;
  regime: "rans" | "urans" | null;
  status: string;
  bucket: string;
  classificationState: string | null;
  errorClass: string | null;
  error: string | null;
  attemptCount: number;
  attemptDigest: PointAttemptDigestEvent[];
  campaignId: string | null;
  campaignName: string | null;
  conditionId: string | null;
  revisionId: string | null;
  lastActivityAt: string;
  /** Fidelity ladder echo (results.fidelity). Derived mirrors carry their +α
   *  source row's fidelity. null = pre-ladder/unsolved row. */
  fidelity: string | null;
  /** Rolling-compatibility ladder bucket. `needs_review` is a legacy wire value
   *  with an empty canonical predicate; new unavailable work uses status and
   *  workDisposition instead. */
  reviewBucket: "awaiting_urans" | "needs_review" | null;
  /** Explicit machine disposition for rejected/failed evidence. Scheduling is
   *  claimed only when an open obligation/request/verify row actually exists. */
  workDisposition: "scheduled" | "blocked" | null;
  /** Amendment C: the rejected urans solve has restartable saved case state
   *  after either a wall-budget stop or the bounded same-case chunk cap. */
  continuable: boolean;
  /** Latest verify-queue item covering this point's cell+angle; null = never
   *  queued for full-fidelity verification. */
  verify: PointVerifyInfo | null;
}

/** Latest sim_urans_verify_queue item for a point (contract 4). */
export interface PointVerifyInfo {
  state: string;
  deltaCl: number | null;
  deltaCd: number | null;
  deltaCm: number | null;
  submitError: string | null;
  submitHttpStatus: number | null;
}

export interface PointHistoryCounts {
  failed: number;
  /** Deprecated alias bucket: every done+physics-rejected row (the union the
   *  awaiting_urans / needs_review split refines). */
  rejected: number;
  awaiting_urans: number;
  needs_review: number;
  accepted: number;
  needs_urans: number;
  solving: number;
  all: number;
}

export interface PointHistoryFacets {
  campaigns: Array<{ id: string; name: string; status: string }>;
  reynolds: number[];
}

export interface PointHistoryPage {
  items: PointHistoryItem[];
  nextCursor: string | null;
  counts: PointHistoryCounts;
  facets?: PointHistoryFacets;
}

export function encodePointHistoryCursor(
  lastActivityIso: string,
  rowKey: string,
): string {
  return `${lastActivityIso}|${rowKey}`;
}

/** Cursor format: `<lastActivity ISO>|<row key>` — row keys never contain `|`.
 *  Returns null for malformed values (the API layer maps that to 400). */
export function parsePointHistoryCursor(
  raw: string,
): PointHistoryCursor | null {
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const ts = raw.slice(0, sep);
  const rowKey = raw.slice(sep + 1);
  // Validate parseability only (V8 accepts µs ISO, truncating for the check);
  // the ORIGINAL string is kept so Postgres sees the full µs precision.
  if (Number.isNaN(new Date(ts).getTime()) || !/^(r:|d:)/.test(rowKey))
    return null;
  return { lastActivity: ts, rowKey };
}

/** Shared non-status filters for the results arm (page + counts coherence). */
function resultArmFilters(
  f: PointHistoryFilters,
  opts: { includeBucket: boolean },
) {
  const parts = [sql`TRUE`];
  if (f.airfoilQuery?.trim()) {
    const like = `%${f.airfoilQuery.trim()}%`;
    parts.push(sql`(af.name ILIKE ${like} OR af.slug ILIKE ${like})`);
  }
  if (f.campaignId) {
    // Terminal points link by result_id; in-flight points still match by cell
    // key — both EXISTS branches ride their own sim_campaign_points index.
    parts.push(sql`(
      EXISTS (SELECT 1 FROM sim_campaign_points p WHERE p.result_id = r.id AND p.campaign_id = ${f.campaignId})
      OR EXISTS (
        SELECT 1 FROM sim_campaign_points p
        WHERE p.state = 'requested' AND p.revision_id = r.simulation_preset_revision_id
          AND p.airfoil_id = r.airfoil_id AND p.aoa_deg = r.aoa_deg AND p.campaign_id = ${f.campaignId}
      )
    )`);
  }
  if (f.regime) parts.push(sql`r.regime = ${f.regime}`);
  if (f.reynolds != null) parts.push(sql`r.reynolds = ${f.reynolds}`);
  if (f.errorClass)
    parts.push(
      sql`r.status = 'failed' AND ${ERROR_CLASS_SQL} = ${f.errorClass}`,
    );
  if (f.verify === "pending") {
    parts.push(sql`EXISTS (
      SELECT 1 FROM sim_urans_verify_queue q
      WHERE q.airfoil_id = r.airfoil_id AND q.revision_id = r.simulation_preset_revision_id
        AND q.aoa_deg = r.aoa_deg AND q.state IN ('pending', 'running')
    )`);
  } else if (f.verify === "disagreed") {
    // Latest item decides: a cell whose disagreement was re-verified clean
    // must not keep matching the disagreed filter.
    parts.push(sql`(
      SELECT q.state FROM sim_urans_verify_queue q
      WHERE q.airfoil_id = r.airfoil_id AND q.revision_id = r.simulation_preset_revision_id
        AND q.aoa_deg = r.aoa_deg
      ORDER BY q."createdAt" DESC LIMIT 1
    ) = 'disagreed'`);
  } else if (f.verify === "blocked") {
    parts.push(sql`(
      SELECT q.state FROM sim_urans_verify_queue q
      WHERE q.airfoil_id = r.airfoil_id AND q.revision_id = r.simulation_preset_revision_id
        AND q.aoa_deg = r.aoa_deg
      ORDER BY q."createdAt" DESC LIMIT 1
    ) = 'blocked'`);
  }
  if (opts.includeBucket && f.bucket) {
    // Amendment-A filters are dedicated expressions (they cut ACROSS the raw
    // bucket CASE: needs_review unions failed + a rejected subset); every
    // other value — including the deprecated 'rejected' alias — matches the
    // raw bucket label as before.
    if (f.bucket === "awaiting_urans") parts.push(AWAITING_URANS_RESULT_SQL);
    else if (f.bucket === "needs_review") parts.push(NEEDS_REVIEW_RESULT_SQL);
    else parts.push(sql`${BUCKET_SQL} = ${f.bucket}`);
  }
  return sql.join(parts, sql` AND `);
}

/** Derived (mirror) rows join their SOURCE results row as r, so regime /
 *  reynolds / airfoil filters apply identically. A status-bucket or
 *  error-class filter excludes the whole derived arm — mirrors are neither
 *  failed nor solving nor classified in their own right. */
function derivedArmFilters(f: PointHistoryFilters) {
  const parts = [
    sql`p.derived_by_symmetry AND p.state = 'terminal' AND p.result_id IS NOT NULL`,
  ];
  if (f.airfoilQuery?.trim()) {
    const like = `%${f.airfoilQuery.trim()}%`;
    parts.push(sql`(af.name ILIKE ${like} OR af.slug ILIKE ${like})`);
  }
  if (f.campaignId) parts.push(sql`p.campaign_id = ${f.campaignId}`);
  if (f.regime) parts.push(sql`r.regime = ${f.regime}`);
  if (f.reynolds != null) parts.push(sql`r.reynolds = ${f.reynolds}`);
  return sql.join(parts, sql` AND `);
}

interface PageRow {
  kind: "result" | "derived";
  row_key: string;
  result_id: string;
  airfoil_id: string;
  airfoil_slug: string;
  airfoil_name: string;
  aoa_deg: number;
  source_aoa_deg: number | null;
  reynolds: number | string | null;
  regime: "rans" | "urans" | null;
  status: string;
  bucket: string;
  classification_state: string | null;
  error_class: string | null;
  error: string | null;
  revision_id: string | null;
  last_activity: Date | string;
  attempt_count: number | null;
  attempt_digest: PointAttemptDigestEvent[] | null;
  campaign_id: string | null;
  campaign_name: string | null;
  condition_id: string | null;
  fidelity: string | null;
  review_bucket: "awaiting_urans" | "needs_review" | null;
  work_disposition: "scheduled" | "blocked" | null;
  continuable: boolean | null;
  verify_state: string | null;
  verify_delta_cl: number | string | null;
  verify_delta_cd: number | string | null;
  verify_delta_cm: number | string | null;
  verify_submit_error: string | null;
  verify_submit_http_status: number | null;
}

const isoOf = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export async function pointHistoryPage(
  db: DB,
  filters: PointHistoryFilters,
  page: {
    cursor?: PointHistoryCursor | null;
    limit: number;
    includeFacets?: boolean;
  },
): Promise<PointHistoryPage> {
  const limit = Math.max(1, Math.min(50, page.limit));
  const cursorSql = (
    activityCol: ReturnType<typeof sql>,
    keyExpr: ReturnType<typeof sql>,
  ) =>
    page.cursor
      ? sql`AND (${activityCol}, ${keyExpr}) < (${page.cursor.lastActivity}::timestamptz, ${page.cursor.rowKey})`
      : sql``;

  const includeDerived =
    !filters.bucket && !filters.errorClass && !filters.verify;
  const resultKey = sql`('r:' || r.id::text)`;
  const derivedKey = sql`('d:' || p.campaign_id::text || ':' || p.condition_id::text || ':' || p.airfoil_id::text || ':' || p.aoa_deg::text)`;

  const derivedArm = includeDerived
    ? sql`
      UNION ALL
      (SELECT
        'derived' AS kind,
        ${derivedKey} AS row_key,
        r.id AS result_id,
        p.airfoil_id,
        af.slug AS airfoil_slug,
        af.name AS airfoil_name,
        p.aoa_deg::float8 AS aoa_deg,
        r.aoa_deg::float8 AS source_aoa_deg,
        r.reynolds,
        r.regime,
        'derived' AS status,
        'derived' AS bucket,
        rc.state::text AS classification_state,
        NULL AS error_class,
        NULL AS error,
        p.revision_id AS revision_id,
        p."updatedAt" AS last_activity,
        p.campaign_id AS campaign_id,
        p.condition_id AS condition_id,
        r.fidelity AS fidelity,
        -- Mirrors are never review-bucketed or continuable in their own right.
        NULL AS review_bucket,
        FALSE AS continuable,
        NULL AS work_disposition
      FROM sim_campaign_points p
      JOIN results r ON r.id = p.result_id
      JOIN airfoils af ON af.id = p.airfoil_id
      LEFT JOIN result_classifications rc ON rc.result_id = r.id
      WHERE ${derivedArmFilters(filters)}
        ${cursorSql(sql`p."updatedAt"`, derivedKey)}
      ORDER BY p."updatedAt" DESC, row_key DESC
      LIMIT ${limit + 1})`
    : sql``;

  const rows = (await db.execute(sql`
    WITH base AS (
      (SELECT
        'result' AS kind,
        ${resultKey} AS row_key,
        r.id AS result_id,
        r.airfoil_id,
        af.slug AS airfoil_slug,
        af.name AS airfoil_name,
        r.aoa_deg::float8 AS aoa_deg,
        NULL::float8 AS source_aoa_deg,
        r.reynolds,
        r.regime,
        r.status::text AS status,
        ${BUCKET_SQL} AS bucket,
        rc.state::text AS classification_state,
        CASE WHEN r.status = 'failed' THEN ${ERROR_CLASS_SQL} ELSE NULL END AS error_class,
        left(r.error, 300) AS error,
        r.simulation_preset_revision_id AS revision_id,
        r."updatedAt" AS last_activity,
        NULL::uuid AS campaign_id,
        NULL::uuid AS condition_id,
        r.fidelity AS fidelity,
        ${REVIEW_BUCKET_SQL} AS review_bucket,
        ${CONTINUABLE_SQL} AS continuable,
        ${WORK_DISPOSITION_SQL} AS work_disposition
      FROM results r
      JOIN airfoils af ON af.id = r.airfoil_id
      LEFT JOIN result_classifications rc ON rc.result_id = r.id
      WHERE ${resultArmFilters(filters, { includeBucket: true })}
        ${cursorSql(sql`r."updatedAt"`, resultKey)}
      ORDER BY r."updatedAt" DESC, row_key DESC
      LIMIT ${limit + 1})
      ${derivedArm}
    ),
    page AS (
      SELECT * FROM base ORDER BY last_activity DESC, row_key DESC LIMIT ${limit + 1}
    )
    SELECT
      page.*,
      -- Lossless µs cursor key: the timestamptz(6) sort column rendered as
      -- strict ISO text (JS Date would truncate to ms and break the keyset).
      to_char(page.last_activity AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_us,
      att.attempt_count,
      att.attempt_digest,
      vq.verify_state,
      vq.verify_delta_cl,
      vq.verify_delta_cd,
      vq.verify_delta_cm,
      vq.verify_submit_error,
      vq.verify_submit_http_status,
      COALESCE(page.campaign_id, cp.campaign_id) AS campaign_id_final,
      COALESCE(page.condition_id, cp.condition_id) AS condition_id_final,
      sc.name AS campaign_name
    FROM page
    LEFT JOIN LATERAL (
      SELECT
        (SELECT count(*)::int FROM result_attempts ra WHERE ra.result_id = page.result_id) AS attempt_count,
        (SELECT jsonb_agg(jsonb_build_object(
            'regime', e.regime,
            'validForPolar', e.valid_for_polar,
            'converged', e.converged,
            'stalled', e.stalled,
            'unsteady', e.unsteady,
            'strouhal', e.strouhal,
            'error', e.err
          ) ORDER BY e.created_at ASC)
         FROM (
           SELECT ra.regime, ra.valid_for_polar, ra.converged, ra.stalled, ra.unsteady, ra.strouhal,
                  left(ra.error, 200) AS err, ra."createdAt" AS created_at
           FROM result_attempts ra
           WHERE ra.result_id = page.result_id
           ORDER BY ra."createdAt" ASC
           LIMIT 12
         ) e) AS attempt_digest
    ) att ON page.kind = 'result'
    LEFT JOIN LATERAL (
      SELECT x.campaign_id, x.condition_id FROM (
        SELECT p.campaign_id, p.condition_id
        FROM sim_campaign_points p
        WHERE p.result_id = page.result_id AND NOT p.derived_by_symmetry
        UNION ALL
        SELECT p.campaign_id, p.condition_id
        FROM sim_campaign_points p
        WHERE p.state = 'requested' AND p.revision_id = page.revision_id
          AND p.airfoil_id = page.airfoil_id AND p.aoa_deg = page.aoa_deg
          AND NOT p.derived_by_symmetry
      ) x LIMIT 1
    ) cp ON page.kind = 'result'
    -- Latest verify-queue item for the cell+angle (fidelity ladder contract
    -- 4): 'latest decides' so a re-verified cell stops reading disagreed.
    -- Derived mirrors are never verified in their own right (kind gate).
    LEFT JOIN LATERAL (
      SELECT q.state AS verify_state, q.delta_cl AS verify_delta_cl,
             q.delta_cd AS verify_delta_cd, q.delta_cm AS verify_delta_cm,
             submit_retry.last_error AS verify_submit_error,
             submit_retry.last_http_status AS verify_submit_http_status
      FROM sim_urans_verify_queue q
      LEFT JOIN sim_ladder_submit_retries submit_retry
        ON submit_retry.verify_queue_id = q.id
      WHERE q.airfoil_id = page.airfoil_id AND q.revision_id = page.revision_id AND q.aoa_deg = page.aoa_deg
      ORDER BY q."createdAt" DESC LIMIT 1
    ) vq ON page.kind = 'result'
    LEFT JOIN sim_campaigns sc ON sc.id = COALESCE(page.campaign_id, cp.campaign_id)
    ORDER BY page.last_activity DESC, page.row_key DESC
  `)) as unknown as Array<
    PageRow & {
      last_activity_us: string;
      campaign_id_final: string | null;
      condition_id_final: string | null;
    }
  >;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];

  const countRows = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE b.bucket = 'failed')::int AS failed,
      count(*) FILTER (WHERE b.bucket = 'rejected')::int AS rejected,
      count(*) FILTER (WHERE b.review_bucket = 'awaiting_urans')::int AS awaiting_urans,
      count(*) FILTER (WHERE b.review_bucket = 'needs_review')::int AS needs_review,
      count(*) FILTER (WHERE b.bucket = 'accepted')::int AS accepted,
      count(*) FILTER (WHERE b.bucket = 'needs_urans')::int AS needs_urans,
      count(*) FILTER (WHERE b.bucket = 'solving')::int AS solving,
      count(*)::int AS all_results
    FROM (
      SELECT ${BUCKET_SQL} AS bucket, ${REVIEW_BUCKET_SQL} AS review_bucket
      FROM results r
      JOIN airfoils af ON af.id = r.airfoil_id
      LEFT JOIN result_classifications rc ON rc.result_id = r.id
      WHERE ${resultArmFilters(filters, { includeBucket: false })}
    ) b
  `)) as unknown as Array<{
    failed: number;
    rejected: number;
    awaiting_urans: number;
    needs_review: number;
    accepted: number;
    needs_urans: number;
    solving: number;
    all_results: number;
  }>;
  const c = countRows[0] ?? {
    failed: 0,
    rejected: 0,
    awaiting_urans: 0,
    needs_review: 0,
    accepted: 0,
    needs_urans: 0,
    solving: 0,
    all_results: 0,
  };

  let derivedCount = 0;
  if (!filters.errorClass) {
    const derivedCountRows = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM sim_campaign_points p
      JOIN results r ON r.id = p.result_id
      JOIN airfoils af ON af.id = p.airfoil_id
      WHERE ${derivedArmFilters(filters)}
    `)) as unknown as Array<{ n: number }>;
    derivedCount = Number(derivedCountRows[0]?.n ?? 0);
  }

  let facets: PointHistoryFacets | undefined;
  if (page.includeFacets) {
    const [campaignRows, reynoldsRows] = await Promise.all([
      db.execute(
        sql`SELECT id, name, status FROM sim_campaigns ORDER BY "createdAt" DESC LIMIT 50`,
      ) as unknown as Promise<
        Array<{ id: string; name: string; status: string }>
      >,
      db.execute(
        sql`SELECT DISTINCT reynolds FROM results WHERE reynolds IS NOT NULL ORDER BY reynolds ASC LIMIT 40`,
      ) as unknown as Promise<Array<{ reynolds: number | string }>>,
    ]);
    facets = {
      campaigns: campaignRows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
      })),
      reynolds: reynoldsRows.map((row) => Number(row.reynolds)),
    };
  }

  return {
    items: pageRows.map((row) => ({
      kind: row.kind,
      rowKey: row.row_key,
      resultId: row.result_id,
      airfoilId: row.airfoil_id,
      airfoilSlug: row.airfoil_slug,
      airfoilName: row.airfoil_name,
      aoaDeg: Number(row.aoa_deg),
      sourceAoaDeg:
        row.source_aoa_deg == null ? null : Number(row.source_aoa_deg),
      reynolds: row.reynolds == null ? null : Number(row.reynolds),
      regime: row.regime,
      status: row.status,
      bucket: row.bucket,
      classificationState: row.classification_state,
      errorClass: row.error_class,
      error: row.error,
      attemptCount: Number(row.attempt_count ?? 0),
      attemptDigest: row.attempt_digest ?? [],
      campaignId: row.campaign_id_final,
      campaignName: row.campaign_name,
      conditionId: row.condition_id_final,
      revisionId: row.revision_id,
      lastActivityAt: isoOf(row.last_activity),
      fidelity: row.fidelity,
      reviewBucket: row.review_bucket ?? null,
      workDisposition: row.work_disposition ?? null,
      continuable: Boolean(row.continuable),
      verify:
        row.verify_state == null
          ? null
          : {
              state: row.verify_state,
              deltaCl:
                row.verify_delta_cl == null
                  ? null
                  : Number(row.verify_delta_cl),
              deltaCd:
                row.verify_delta_cd == null
                  ? null
                  : Number(row.verify_delta_cd),
              deltaCm:
                row.verify_delta_cm == null
                  ? null
                  : Number(row.verify_delta_cm),
              submitError: row.verify_submit_error,
              submitHttpStatus: row.verify_submit_http_status,
            },
    })),
    nextCursor:
      hasMore && last
        ? encodePointHistoryCursor(last.last_activity_us, last.row_key)
        : null,
    counts: {
      failed: Number(c.failed),
      rejected: Number(c.rejected),
      awaiting_urans: Number(c.awaiting_urans),
      needs_review: Number(c.needs_review),
      accepted: Number(c.accepted),
      needs_urans: Number(c.needs_urans),
      solving: Number(c.solving),
      all: Number(c.all_results) + derivedCount,
    },
    facets,
  };
}

// ---------------------------------------------------------------------------
// Point story (screen 2).
// ---------------------------------------------------------------------------
export interface PointStoryAttempt {
  id: string;
  regime: "rans" | "urans" | null;
  status: string;
  validForPolar: boolean;
  converged: boolean;
  stalled: boolean;
  unsteady: boolean;
  firstOrderFallback: boolean;
  cl: number | null;
  cd: number | null;
  clCd: number | null;
  strouhal: number | null;
  error: string | null;
  qualityWarnings: string[];
  engineCaseSlug: string | null;
  simJob: {
    id: string;
    wave: number;
    jobKind: string;
    status: string;
    campaignId: string | null;
    engineJobId: string | null;
  } | null;
  classification: {
    state: string;
    reasons: string[];
    confidence: number;
  } | null;
  createdAt: string;
  solvedAt: string | null;
}

export interface PointStoryInterruption {
  simJobId: string;
  engineJobId: string | null;
  wave: number;
  jobKind: string;
  campaignId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface PointStory {
  point: {
    resultId: string;
    airfoilId: string;
    airfoilSlug: string;
    airfoilName: string;
    aoaDeg: number;
    reynolds: number | null;
    mach: number | null;
    speed: number | null;
    regime: "rans" | "urans" | null;
    status: string;
    error: string | null;
    qualityWarnings: string[];
    classification: {
      state: string;
      reasons: string[];
      confidence: number;
      classifierVersion: string;
    } | null;
    revisionId: string | null;
    campaignId: string | null;
    campaignName: string | null;
    conditionId: string | null;
    solvedAt: string | null;
    updatedAt: string;
    /** Fidelity ladder echo (results.fidelity); null = pre-ladder/unsolved. */
    fidelity: string | null;
    /** Rolling-compatibility ladder bucket (see PointHistoryItem.reviewBucket). */
    reviewBucket: "awaiting_urans" | "needs_review" | null;
    workDisposition: "scheduled" | "blocked" | null;
    /** Amendment C: rejected urans row with restartable saved case state — the
     *  story panel renders Continue +2h/+6h on exactly these. */
    continuable: boolean;
    /** Exact immutable generation that the Continue action must name. */
    continuationResultAttemptId: string | null;
    /** Latest verify-queue item for this cell+angle; null = never queued. */
    verify: PointVerifyInfo | null;
  };
  attempts: PointStoryAttempt[];
  interruptions: PointStoryInterruption[];
  /** Campaign closure context: how many airfoils still have this angle open
   *  in the same condition. null for non-campaign points. */
  closure: {
    campaignId: string;
    campaignName: string | null;
    conditionId: string;
    openAirfoils: number;
    totalAirfoils: number;
  } | null;
}

export async function pointStory(
  db: DB,
  resultId: string,
): Promise<PointStory> {
  const pointRows = (await db.execute(sql`
    SELECT
      r.id AS result_id, r.airfoil_id, af.slug AS airfoil_slug, af.name AS airfoil_name,
      r.aoa_deg::float8 AS aoa_deg, r.reynolds, r.mach, r.speed, r.regime, r.status::text AS status,
      r.error, r.quality_warnings, r.simulation_preset_revision_id AS revision_id,
      r."solvedAt" AS solved_at, r."updatedAt" AS updated_at, r.fidelity,
      ${REVIEW_BUCKET_SQL} AS review_bucket, ${CONTINUABLE_SQL} AS continuable,
      CASE WHEN ${CONTINUABLE_SQL}
        THEN r.current_result_attempt_id ELSE NULL
      END AS continuation_result_attempt_id,
      ${WORK_DISPOSITION_SQL} AS work_disposition,
      rc.state::text AS cls_state, rc.reasons AS cls_reasons, rc.confidence AS cls_confidence,
      rc.classifier_version AS cls_version,
      cp.campaign_id, cp.condition_id, sc.name AS campaign_name,
      vq.verify_state, vq.verify_delta_cl, vq.verify_delta_cd, vq.verify_delta_cm,
      vq.verify_submit_error, vq.verify_submit_http_status
    FROM results r
    JOIN airfoils af ON af.id = r.airfoil_id
    LEFT JOIN result_classifications rc ON rc.result_id = r.id
    LEFT JOIN LATERAL (
      SELECT x.campaign_id, x.condition_id FROM (
        SELECT p.campaign_id, p.condition_id FROM sim_campaign_points p
        WHERE p.result_id = r.id AND NOT p.derived_by_symmetry
        UNION ALL
        SELECT p.campaign_id, p.condition_id FROM sim_campaign_points p
        WHERE p.state = 'requested' AND p.revision_id = r.simulation_preset_revision_id
          AND p.airfoil_id = r.airfoil_id AND p.aoa_deg = r.aoa_deg AND NOT p.derived_by_symmetry
      ) x LIMIT 1
    ) cp ON TRUE
    LEFT JOIN sim_campaigns sc ON sc.id = cp.campaign_id
    LEFT JOIN LATERAL (
      SELECT q.state AS verify_state, q.delta_cl AS verify_delta_cl,
             q.delta_cd AS verify_delta_cd, q.delta_cm AS verify_delta_cm,
             submit_retry.last_error AS verify_submit_error,
             submit_retry.last_http_status AS verify_submit_http_status
      FROM sim_urans_verify_queue q
      LEFT JOIN sim_ladder_submit_retries submit_retry
        ON submit_retry.verify_queue_id = q.id
      WHERE q.airfoil_id = r.airfoil_id AND q.revision_id = r.simulation_preset_revision_id AND q.aoa_deg = r.aoa_deg
      ORDER BY q."createdAt" DESC LIMIT 1
    ) vq ON TRUE
    WHERE r.id = ${resultId}
    LIMIT 1
  `)) as unknown as Array<{
    result_id: string;
    airfoil_id: string;
    airfoil_slug: string;
    airfoil_name: string;
    aoa_deg: number;
    reynolds: number | string | null;
    mach: number | null;
    speed: number | null;
    regime: "rans" | "urans" | null;
    status: string;
    error: string | null;
    quality_warnings: string[] | null;
    revision_id: string | null;
    solved_at: Date | string | null;
    updated_at: Date | string;
    cls_state: string | null;
    cls_reasons: string[] | null;
    cls_confidence: number | null;
    cls_version: string | null;
    campaign_id: string | null;
    condition_id: string | null;
    campaign_name: string | null;
    fidelity: string | null;
    review_bucket: "awaiting_urans" | "needs_review" | null;
    work_disposition: "scheduled" | "blocked" | null;
    continuable: boolean | null;
    continuation_result_attempt_id: string | null;
    verify_state: string | null;
    verify_delta_cl: number | string | null;
    verify_delta_cd: number | string | null;
    verify_delta_cm: number | string | null;
    verify_submit_error: string | null;
    verify_submit_http_status: number | null;
  }>;
  const p = pointRows[0];
  if (!p) throw new CampaignError("not_found", "point not found");

  const attemptRows = (await db.execute(sql`
    SELECT
      ra.id, ra.regime, ra.status::text AS status, ra.valid_for_polar, ra.converged, ra.stalled,
      ra.unsteady, ra.first_order_fallback, ra.cl, ra.cd, ra.cl_cd, ra.strouhal,
      left(ra.error, 500) AS error, ra.quality_warnings, ra.engine_case_slug,
      ra."createdAt" AS created_at, ra."solvedAt" AS solved_at,
      j.id AS job_id, j.wave AS job_wave, j.job_kind, j.status AS job_status,
      j.campaign_id AS job_campaign_id, j.engine_job_id AS job_engine_id,
      rca.state::text AS cls_state, rca.reasons AS cls_reasons, rca.confidence AS cls_confidence
    FROM result_attempts ra
    LEFT JOIN sim_jobs j ON j.id = ra.sim_job_id
    LEFT JOIN result_classifications rca ON rca.result_attempt_id = ra.id
    WHERE ra.result_id = ${resultId}
    ORDER BY ra."createdAt" ASC
    LIMIT 50
  `)) as unknown as Array<{
    id: string;
    regime: "rans" | "urans" | null;
    status: string;
    valid_for_polar: boolean;
    converged: boolean;
    stalled: boolean;
    unsteady: boolean;
    first_order_fallback: boolean;
    cl: number | null;
    cd: number | null;
    cl_cd: number | null;
    strouhal: number | null;
    error: string | null;
    quality_warnings: string[] | null;
    engine_case_slug: string | null;
    created_at: Date | string;
    solved_at: Date | string | null;
    job_id: string | null;
    job_wave: number | null;
    job_kind: string | null;
    job_status: string | null;
    job_campaign_id: string | null;
    job_engine_id: string | null;
    cls_state: string | null;
    cls_reasons: string[] | null;
    cls_confidence: number | null;
  }>;

  // Interrupted solves: cancelled sim_jobs that had claimed this exact cell.
  // The claim link (results.sim_job_id) is cleared on release, so membership
  // is re-derived from the job's immutable requestPayload: the aoa list plus
  // either the job-level pinned revision or the batched conditionMap.
  // Points the cancelled job actually SOLVED are excluded: the worker-restart
  // reconcile ingests partially solved points as kept evidence (their
  // result_attempts.sim_job_id = that job) BEFORE cancelling, so a cancel is
  // an interruption only for the points it released, never for the ones whose
  // attempt evidence it produced.
  const interruptionRows = (await db.execute(sql`
    SELECT j.id, j.engine_job_id, j.wave, j.job_kind, j.campaign_id, j.error,
           j."createdAt" AS created_at, j."finishedAt" AS finished_at
    FROM sim_jobs j
    WHERE j.airfoil_id = ${p.airfoil_id}
      AND j.status = 'cancelled'
      AND COALESCE(j.request_payload->'aoas', '[]'::jsonb) @> to_jsonb(${p.aoa_deg}::float8)
      AND NOT EXISTS (
        SELECT 1 FROM result_attempts ra WHERE ra.result_id = ${resultId} AND ra.sim_job_id = j.id
      )
      AND (
        j.simulation_preset_revision_id = ${p.revision_id}
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(j.request_payload->'conditionMap', '[]'::jsonb)) cm
          WHERE cm->>'revisionId' = ${p.revision_id}::text
        )
      )
    ORDER BY j."createdAt" ASC
    LIMIT 20
  `)) as unknown as Array<{
    id: string;
    engine_job_id: string | null;
    wave: number;
    job_kind: string;
    campaign_id: string | null;
    error: string | null;
    created_at: Date | string;
    finished_at: Date | string | null;
  }>;

  let closure: PointStory["closure"] = null;
  if (p.campaign_id && p.condition_id) {
    const closureRows = (await db.execute(sql`
      SELECT count(*) FILTER (WHERE p2.state = 'requested')::int AS open, count(*)::int AS total
      FROM sim_campaign_points p2
      WHERE p2.condition_id = ${p.condition_id} AND p2.aoa_deg = ${p.aoa_deg}
    `)) as unknown as Array<{ open: number; total: number }>;
    closure = {
      campaignId: p.campaign_id,
      campaignName: p.campaign_name,
      conditionId: p.condition_id,
      openAirfoils: Number(closureRows[0]?.open ?? 0),
      totalAirfoils: Number(closureRows[0]?.total ?? 0),
    };
  }

  const iso = (v: Date | string): string =>
    v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  const isoOrNull = (v: Date | string | null): string | null =>
    v == null ? null : iso(v);

  return {
    point: {
      resultId: p.result_id,
      airfoilId: p.airfoil_id,
      airfoilSlug: p.airfoil_slug,
      airfoilName: p.airfoil_name,
      aoaDeg: Number(p.aoa_deg),
      reynolds: p.reynolds == null ? null : Number(p.reynolds),
      mach: p.mach == null ? null : Number(p.mach),
      speed: p.speed == null ? null : Number(p.speed),
      regime: p.regime,
      status: p.status,
      error: p.error,
      qualityWarnings: p.quality_warnings ?? [],
      classification:
        p.cls_state == null
          ? null
          : {
              state: p.cls_state,
              reasons: p.cls_reasons ?? [],
              confidence: Number(p.cls_confidence ?? 1),
              classifierVersion: p.cls_version ?? "",
            },
      revisionId: p.revision_id,
      campaignId: p.campaign_id,
      campaignName: p.campaign_name,
      conditionId: p.condition_id,
      solvedAt: isoOrNull(p.solved_at),
      updatedAt: iso(p.updated_at),
      fidelity: p.fidelity,
      reviewBucket: p.review_bucket ?? null,
      workDisposition: p.work_disposition ?? null,
      continuable: Boolean(p.continuable),
      continuationResultAttemptId: p.continuation_result_attempt_id,
      verify:
        p.verify_state == null
          ? null
          : {
              state: p.verify_state,
              deltaCl:
                p.verify_delta_cl == null ? null : Number(p.verify_delta_cl),
              deltaCd:
                p.verify_delta_cd == null ? null : Number(p.verify_delta_cd),
              deltaCm:
                p.verify_delta_cm == null ? null : Number(p.verify_delta_cm),
              submitError: p.verify_submit_error,
              submitHttpStatus: p.verify_submit_http_status,
            },
    },
    attempts: attemptRows.map((a) => ({
      id: a.id,
      regime: a.regime,
      status: a.status,
      validForPolar: a.valid_for_polar,
      converged: a.converged,
      stalled: a.stalled,
      unsteady: a.unsteady,
      firstOrderFallback: a.first_order_fallback,
      cl: a.cl == null ? null : Number(a.cl),
      cd: a.cd == null ? null : Number(a.cd),
      clCd: a.cl_cd == null ? null : Number(a.cl_cd),
      strouhal: a.strouhal == null ? null : Number(a.strouhal),
      error: a.error,
      qualityWarnings: a.quality_warnings ?? [],
      engineCaseSlug: a.engine_case_slug,
      simJob:
        a.job_id == null
          ? null
          : {
              id: a.job_id,
              wave: Number(a.job_wave ?? 1),
              jobKind: a.job_kind ?? "sweep",
              status: a.job_status ?? "done",
              campaignId: a.job_campaign_id,
              engineJobId: a.job_engine_id,
            },
      classification:
        a.cls_state == null
          ? null
          : {
              state: a.cls_state,
              reasons: a.cls_reasons ?? [],
              confidence: Number(a.cls_confidence ?? 1),
            },
      createdAt: iso(a.created_at),
      solvedAt: isoOrNull(a.solved_at),
    })),
    interruptions: interruptionRows.map((j) => ({
      simJobId: j.id,
      engineJobId: j.engine_job_id,
      wave: Number(j.wave),
      jobKind: j.job_kind,
      campaignId: j.campaign_id,
      error: j.error,
      createdAt: iso(j.created_at),
      finishedAt: isoOrNull(j.finished_at),
    })),
    closure,
  };
}

// ---------------------------------------------------------------------------
// Single-point requeue — the same reset semantics as requeueCampaignFailed
// (spec §10 / PR #1 requeue-rejected), scoped to ONE result row. Eligible:
//   - status='failed' (any scope: campaign or background), or
//   - status='done' with a 'rejected' result-level classification.
// Campaign-linked terminal cells flip back to 'requested' and the campaign's
// counters/completion are recomputed in the same transaction.
// ---------------------------------------------------------------------------
export async function requeueSinglePoint(
  db: DB,
  resultId: string,
): Promise<{
  requeued: 1;
  scope: "failed" | "rejected";
  campaignIds: string[];
}> {
  return db.transaction(async (rawTx) => {
    // Same DB/Tx narrowing campaigns.ts uses (asDb): the tx client executes
    // the identical SQL surface.
    const tx = rawTx as unknown as DB;
    const initialRows = (await tx.execute(sql`
      SELECT r.id, r.status::text AS status, r.error, r.airfoil_id,
        r.simulation_preset_revision_id AS revision_id,
        r.aoa_deg::float8 AS aoa_deg, r.regime, r.fidelity,
        EXISTS (SELECT 1 FROM result_classifications rc WHERE rc.result_id = r.id AND rc.state = 'rejected') AS rejected
      FROM results r WHERE r.id = ${resultId}
    `)) as unknown as Array<{
      id: string;
      status: string;
      error: string | null;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      regime: string | null;
      fidelity: string | null;
      rejected: boolean;
    }>;
    const initial = initialRows[0];
    if (!initial) throw new CampaignError("not_found", "point not found");
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_campaigns campaign
      WHERE EXISTS (
        SELECT 1 FROM sim_campaign_points point
        WHERE point.campaign_id = campaign.id
          AND (
            point.result_id = ${resultId}
            OR (
              point.airfoil_id = ${initial.airfoil_id}
              AND point.revision_id = ${initial.revision_id}
              AND point.aoa_deg = ${initial.aoa_deg}
            )
          )
      )
      ORDER BY campaign.id
      FOR UPDATE OF campaign
    `);
    if (initial.revision_id) {
      await lockPrecalcCells(tx, [
        {
          airfoilId: initial.airfoil_id,
          revisionId: initial.revision_id,
          aoaDeg: initial.aoa_deg,
        },
      ]);
    }
    // Re-read and lock only after the cell lock. Obligation creation follows
    // the same order and therefore cannot appear between this check and reset.
    const rows = (await tx.execute(sql`
      SELECT r.id, r.status::text AS status, r.error, r.airfoil_id,
        r.simulation_preset_revision_id AS revision_id,
        r.aoa_deg::float8 AS aoa_deg, r.regime, r.fidelity,
        EXISTS (SELECT 1 FROM result_classifications rc WHERE rc.result_id = r.id AND rc.state = 'rejected') AS rejected
      FROM results r WHERE r.id = ${resultId} FOR UPDATE OF r
    `)) as unknown as typeof initialRows;
    const row = rows[0];
    if (!row) throw new CampaignError("not_found", "point not found");
    if (row.regime === "urans" || (row.fidelity ?? "").startsWith("urans")) {
      throw new CampaignError(
        "invalid_state",
        "URANS evidence is owned by the bounded fidelity ladder and cannot be sent to the ordinary RANS retry queue",
      );
    }
    const obligations = row.revision_id
      ? ((await tx.execute(sql`
          SELECT id, state
          FROM sim_precalc_obligations
          WHERE airfoil_id = ${row.airfoil_id}
            AND revision_id = ${row.revision_id}
            AND aoa_deg = ${row.aoa_deg}
          FOR UPDATE
        `)) as unknown as Array<{ id: string; state: string }>)
      : [];
    if (obligations.length > 0) {
      throw new CampaignError(
        "invalid_state",
        `this physical cell is owned by the bounded PRECALC ledger (${obligations[0].state}); ordinary RANS retry is unavailable`,
      );
    }
    if (row.status === "failed" && isDeterministicMeshBlockerError(row.error)) {
      throw new CampaignError(
        "invalid_state",
        "this point is blocked by deterministic mesh QA; repair or change the mesh setup before requeueing",
      );
    }
    const scope: "failed" | "rejected" | null =
      row.status === "failed"
        ? "failed"
        : row.status === "done" && row.rejected
          ? "rejected"
          : null;
    if (!scope) {
      throw new CampaignError(
        "invalid_state",
        `point is '${row.status}'${row.rejected ? " (rejected)" : ""} — only failed or rejected points can be requeued`,
      );
    }
    await tx.execute(sql`
      UPDATE results SET status = 'pending', sim_job_id = NULL, "updatedAt" = now() WHERE id = ${resultId}
    `);
    // An explicit retry starts a fresh submit lifecycle. A stale answered-HTTP
    // delay/block row would otherwise make the API report success while the
    // gap/claim gates silently keep this cell unschedulable.
    await tx.execute(sql`
      DELETE FROM sim_result_submit_retries WHERE result_id = ${resultId}
    `);
    const flipped = (await tx.execute(sql`
      UPDATE sim_campaign_points
      SET state = 'requested', "updatedAt" = now()
      WHERE result_id = ${resultId} AND state = 'terminal' AND NOT derived_by_symmetry
      RETURNING campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    const campaignIds = [...new Set(flipped.map((f) => f.campaign_id))];
    for (const campaignId of campaignIds) {
      await recomputeCampaignProgress(rawTx, campaignId);
      await refreshCampaignCompletion(rawTx, campaignId);
    }
    return { requeued: 1 as const, scope, campaignIds };
  });
}

/** Bulk resume compatibility helper: every CONTINUABLE row — rejected URANS
 * evidence with restartable saved engine case state and nothing further
 * scheduled. Continuable rows are machine-time/availability, never human
 * adjudication. The bulk endpoint feeds each
 *  row into createUransRequest (idempotent per cell+fidelity), so replays
 *  and races with single-row Continue actions are safe. */
export async function listContinuableNeedsReview(
  db: DB,
  opts: { campaignId?: string | null } = {},
): Promise<
  Array<{
    resultId: string;
    resultAttemptId: string;
    airfoilId: string;
    revisionId: string;
    aoaDeg: number;
    fidelity: string | null;
  }>
> {
  const campaignCond = opts.campaignId
    ? sql`AND EXISTS (
        SELECT 1 FROM sim_campaign_points p
        WHERE p.campaign_id = ${opts.campaignId} AND NOT p.derived_by_symmetry
          AND ((p.result_id = r.id AND p.result_attempt_id = attempt.id)
            OR (p.state = 'requested' AND p.revision_id = r.simulation_preset_revision_id
                AND p.airfoil_id = r.airfoil_id AND p.aoa_deg = r.aoa_deg))
      )`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT r.id AS result_id, attempt.id AS result_attempt_id,
           r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
           r.aoa_deg::float8 AS aoa_deg,
           attempt.evidence_payload ->> 'fidelity' AS fidelity
    FROM results r
    JOIN result_attempts attempt
      ON attempt.id = r.current_result_attempt_id
     AND attempt.result_id = r.id
     AND attempt.airfoil_id = r.airfoil_id
     AND attempt.simulation_preset_revision_id = r.simulation_preset_revision_id
     AND attempt.aoa_deg = r.aoa_deg
    JOIN result_classifications rc
      ON rc.result_attempt_id = attempt.id
     AND rc.state = 'rejected'
    JOIN simulation_preset_revisions revision
      ON revision.id = attempt.simulation_preset_revision_id
    WHERE r.status = 'done'
      AND attempt.status IN ('done', 'failed')
      AND attempt.source = 'solved'
      AND attempt.evidence_payload ->> 'fidelity'
          IN ('urans_precalc', 'urans_full')
      AND attempt.engine_job_id IS NOT NULL
      AND attempt.engine_case_slug IS NOT NULL
      AND attempt.solver_implementation_id IS NOT NULL
      AND revision.solver_implementation_id IS NOT NULL
      AND attempt.solver_implementation_id = revision.solver_implementation_id
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(attempt.quality_warnings, ARRAY[]::text[])) warning
        WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
           OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
      )
      AND ${exactValidSolverManifestSql(sql`r.id`, sql`attempt.id`)}
      AND ${exactVerifiedRestartableEvidenceArchiveSql(
        sql`r.id`,
        sql`attempt.id`,
      )}
      AND NOT EXISTS (
        SELECT 1 FROM sim_urans_requests req
        WHERE req.airfoil_id = r.airfoil_id
          AND req.revision_id = r.simulation_preset_revision_id
          AND (req.aoa_deg = r.aoa_deg OR req.aoa_deg IS NULL)
          AND req.state IN ('pending', 'running')
      )
      AND r.simulation_preset_revision_id IS NOT NULL
      ${campaignCond}
    ORDER BY r."updatedAt" ASC
  `)) as unknown as Array<{
    result_id: string;
    result_attempt_id: string;
    airfoil_id: string;
    revision_id: string;
    aoa_deg: number;
    fidelity: string | null;
  }>;
  return rows.map((r) => ({
    resultId: r.result_id,
    resultAttemptId: r.result_attempt_id,
    airfoilId: r.airfoil_id,
    revisionId: r.revision_id,
    aoaDeg: Number(r.aoa_deg),
    fidelity: r.fidelity,
  }));
}
