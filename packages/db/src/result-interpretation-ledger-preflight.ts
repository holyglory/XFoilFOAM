/**
 * Fail closed before applying the result-interpretation ledger migrations.
 *
 * Drizzle decides which migrations to skip from `created_at`; inspecting the
 * maximum timestamp is therefore unsafe.  In particular, an interrupted
 * 0094–0099 upgrade can look newer than the production 0093 baseline while
 * leaving only a subset of the additive objects.  This guard admits exactly
 * three database states:
 *
 *   fresh             no application anchors and an absent/empty journal
 *   preledger_0093    the complete 0000..0093 journal plus its production
 *                     anchors, with no later ledger footprint
 *   postledger_0099   the complete 0000..0099 journal and final schema
 *
 * Any other state requires a deliberate restore/repair procedure.  Keep this
 * read-only: it is invoked before Drizzle begins its all-or-nothing migration
 * transaction and also after it commits.
 */
import { sql } from "drizzle-orm";

import type { DB } from "./client";

export type ResultInterpretationLedgerPreflightState =
  | "fresh"
  | "preledger_0093"
  | "postledger_0099"
  | "incompatible";

export type ResultInterpretationLedgerPreflight = {
  state: ResultInterpretationLedgerPreflightState;
  /** True when an interpretation-ledger object, type, or pointer is present. */
  footprintPresent: boolean;
  issues: string[];
};

export type ResultInterpretationLedgerPreflightFacts = {
  hasApplicationAnchors: boolean;
  journalState: "absent" | "empty" | "preledger_0093" | "postledger_0099" | "other";
  footprintPresent: boolean;
  preledger0093Issues: string[];
  post0093MarkersPresent: boolean;
  postledger0099Issues: string[];
};

/**
 * Pure classification is deliberately exposed so the acceptance matrix can be
 * tested without a production database.  The SQL reader below only gathers
 * facts; this function owns the fail-closed state machine.
 */
export function classifyResultInterpretationLedgerPreflight(
  facts: ResultInterpretationLedgerPreflightFacts,
): ResultInterpretationLedgerPreflight {
  const journalMissing = facts.journalState === "absent" || facts.journalState === "empty";

  if (journalMissing && !facts.hasApplicationAnchors && !facts.footprintPresent) {
    return { state: "fresh", footprintPresent: false, issues: [] };
  }

  if (
    facts.journalState === "preledger_0093" &&
    !facts.footprintPresent &&
    !facts.post0093MarkersPresent &&
    facts.preledger0093Issues.length === 0
  ) {
    return { state: "preledger_0093", footprintPresent: false, issues: [] };
  }

  if (
    facts.journalState === "postledger_0099" &&
    facts.footprintPresent &&
    facts.postledger0099Issues.length === 0
  ) {
    return { state: "postledger_0099", footprintPresent: true, issues: [] };
  }

  const issues = [
    ...(facts.hasApplicationAnchors && journalMissing
      ? ["application tables exist but the migration journal is absent or empty"]
      : []),
    ...(facts.journalState === "other"
      ? ["migration journal is not the exact 0000..0093 or 0000..0099 timestamp set"]
      : []),
    ...(facts.journalState === "preledger_0093" ? facts.preledger0093Issues : []),
    ...(facts.journalState === "preledger_0093" && facts.post0093MarkersPresent
      ? ["a 0094–0099 schema marker exists before the ledger journal is complete"]
      : []),
    ...(facts.journalState === "postledger_0099" ? facts.postledger0099Issues : []),
    ...(facts.journalState === "preledger_0093" && facts.footprintPresent
      ? ["interpretation-ledger footprint exists before the ledger journal is complete"]
      : []),
    ...(facts.journalState === "postledger_0099" && !facts.footprintPresent
      ? ["post-0099 journal exists without the interpretation-ledger footprint"]
      : []),
    ...(facts.journalState === "absent" || facts.journalState === "empty"
      ? ["database is neither fresh nor an accepted migration baseline"]
      : []),
  ];

  return {
    state: "incompatible",
    footprintPresent: facts.footprintPresent,
    issues: [...new Set(issues)],
  };
}

export function mayApplyResultInterpretationLedgerMigrations(
  fingerprint: ResultInterpretationLedgerPreflight,
): boolean {
  return fingerprint.state !== "incompatible";
}

export function assertResultInterpretationLedgerPreflight(
  fingerprint: ResultInterpretationLedgerPreflight,
): void {
  if (mayApplyResultInterpretationLedgerMigrations(fingerprint)) return;
  throw new Error(
    "refusing result-interpretation ledger migration against a partial or incompatible schema: " +
      fingerprint.issues.join("; ") +
      ". Restore the verified production backup or complete the recorded repair runbook before retrying.",
  );
}

// These are the immutable Drizzle `when` values for journal entries 0000..0093
// and 0000..0099.  Do not replace this with MAX(created_at): migration history
// contains historical timestamp collisions, and a max-only check accepts a
// missing or reordered journal.
const JOURNAL_THROUGH_0093 = [
  1781714999377, 1782051284648, 1782144000000, 1782262158000, 1782262159000,
  1782262160000, 1782262161000, 1782340200000, 1782383700000, 1782383760000,
  1782383820000, 1782656100000, 1782657000000, 1782661800000, 1782748200000,
  1782751800000, 1782755400000, 1782759000000, 1782762600000, 1782849000000,
  1782852600000, 1782856200000, 1782860400000, 1782864000000, 1782921600000,
  1783123200000, 1783209600000, 1783296000000, 1783382400000, 1783468800000,
  1783555200000, 1783641600000, 1783728000000, 1783814400000, 1783900800000,
  1783987200000, 1784073600000, 1784073600001, 1784160000000, 1784246400000,
  1784332800000, 1784419200000, 1784505600000, 1784592000000, 1784678400000,
  1784764800000, 1784851200000, 1784937600000, 1785024000000, 1785110400000,
  1785196800000, 1785283200000, 1785369600000, 1785456000000, 1785542400000,
  1785628800000, 1785715200000, 1785801600000, 1785888000000, 1785974400000,
  1786060800000, 1786147200000, 1786233600000, 1786320000000, 1786406400000,
  1786492800000, 1786579200000, 1786665600000, 1786752000000, 1786838400000,
  1786924800000, 1787011200000, 1787097600000, 1787184000000, 1787270400000,
  1787356800000, 1787443200000, 1787529600000, 1787616000000, 1787702400000,
  1787788800000, 1787875200000, 1787961600000, 1788048000000, 1788134400000,
  1788220800000, 1788307200000, 1788393600000, 1788480000000, 1788566400000,
  1788652800000, 1788739200000, 1788825600000, 1788912000000,
] as const;
const JOURNAL_THROUGH_0099 = [
  ...JOURNAL_THROUGH_0093,
  1788998400000,
  1789084800000,
  1789171200000,
  1789257600000,
  1789344000000,
  1789430400000,
] as const;

const journalArraySql = (timestamps: readonly number[]) =>
  sql.raw(`ARRAY[${timestamps.join(",")}]::bigint[]`);

export async function readResultInterpretationLedgerPreflight(
  db: DB,
): Promise<ResultInterpretationLedgerPreflight> {
  // PostgreSQL resolves relation names while planning, even inside an
  // unreachable CASE arm.  Probe first so the fresh-database path never
  // references drizzle.__drizzle_migrations before Drizzle has created it.
  const journalProbe = (await db.execute(sql`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present
  `)) as unknown as Array<{ present: boolean }>;
  const journalPresent = journalProbe[0]?.present === true;
  const journalCte = journalPresent
    ? sql`
      SELECT
        CASE
          WHEN (SELECT count(*) FROM drizzle.__drizzle_migrations) = 0 THEN 'empty'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0093.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0093.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0093)}
            THEN 'preledger_0093'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0099.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0099.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0099)}
            THEN 'postledger_0099'
          ELSE 'other'
        END AS journal_state
    `
    : sql`SELECT 'absent'::text AS journal_state`;
  const rows = (await db.execute(sql`
    WITH inspection AS (
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_class
          WHERE oid = ANY(ARRAY[
            to_regclass('public.airfoils'),
            to_regclass('public.results'),
            to_regclass('public.result_attempts'),
            to_regclass('public.solver_evidence_archives'),
            to_regclass('public.solver_evidence_artifacts'),
            to_regclass('public.result_media'),
            to_regclass('public.sim_campaign_progress'),
            to_regclass('public.sync_api_settings'),
            to_regclass('public.sim_urans_requests')
          ])
        ) AS application_anchors_present,
        EXISTS (
          SELECT 1
          FROM pg_class
          WHERE oid = ANY(ARRAY[
            to_regclass('public.result_reducer_versions'),
            to_regclass('public.result_interpretations'),
            to_regclass('public.result_interpretation_cycles'),
            to_regclass('public.result_interpretation_backfill_runs'),
            to_regclass('public.result_interpretation_backfill_items'),
            to_regclass('public.result_canonical_selections'),
            to_regclass('public.result_interpretation_recovery_actions'),
            to_regclass('public.legacy_urans_archive_gap_recovery_actions'),
            to_regclass('public.result_archive_reduction_queue')
          ])
        ) OR to_regtype('public.result_interpretation_state') IS NOT NULL
          OR to_regtype('public.result_interpretation_regime') IS NOT NULL
          OR to_regtype('public.result_interpretation_cycle_disposition') IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'results'
              AND column_name IN (
                'current_result_interpretation_id', 'current_canonical_selection_id'
              )
          ) AS footprint_present,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sim_urans_requests'
            AND column_name = 'corrective_tail_periods'
        ) OR to_regclass('public.ri_recovery_active_request_owner_uq') IS NOT NULL
          OR to_regclass('public.ri_recovery_active_verify_owner_uq') IS NOT NULL
          OR to_regclass('public.legacy_urans_archive_gap_recovery_source_uq') IS NOT NULL
          OR to_regclass('public.result_archive_reduction_queue_identity_uq') IS NOT NULL
          OR to_regclass('public.result_interpretations_archive_attempt_reducer_src_evidence_uq') IS NOT NULL
          OR to_regclass('public.result_interpretations_nonarchive_attempt_reducer_evidence_uq') IS NOT NULL
          AS post_0093_markers_present
    ), journal AS (${journalCte}), fingerprint AS (
      SELECT
        inspection.application_anchors_present,
        inspection.footprint_present,
        inspection.post_0093_markers_present,
        journal.journal_state,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN to_regclass('public.solver_evidence_artifacts_attempt_content_uq') IS NOT NULL
                    AND to_regclass('public.solver_evidence_artifacts_result_content_uq') IS NOT NULL
            THEN NULL ELSE '0090 frame-association indexes are missing' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sync_api_settings'
              AND column_name = 'default_promise_ttl_hours'
              AND column_default = '72'
          ) THEN NULL ELSE '0091 remote promise TTL default is not 72 hours' END,
          CASE WHEN to_regclass('public.result_media_storage_key_idx') IS NOT NULL
            THEN NULL ELSE '0092 result-media storage-key index is missing' END,
          CASE WHEN to_regclass('public.result_attempt_ingest_completions') IS NOT NULL
            THEN NULL ELSE '0093 ingest-completion table is missing' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.result_attempt_ingest_completions')
              AND conname = 'result_attempt_ingest_completions_attempt_owner_fk'
          ) THEN NULL ELSE '0093 ingest-completion ownership foreign key is missing' END,
          CASE WHEN (
            SELECT count(*) FROM pg_constraint
            WHERE conrelid = to_regclass('public.result_attempt_ingest_completions')
              AND conname IN (
                'result_attempt_ingest_completions_projection_version_check',
                'result_attempt_ingest_completions_payload_signature_check'
              )
          ) = 2 THEN NULL ELSE '0093 ingest-completion checks are incomplete' END
        ], NULL)::text[] AS preledger_0093_issues,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN (
            SELECT count(*) = 9
            FROM pg_class
            WHERE oid = ANY(ARRAY[
              to_regclass('public.result_reducer_versions'),
              to_regclass('public.result_interpretations'),
              to_regclass('public.result_interpretation_cycles'),
              to_regclass('public.result_interpretation_backfill_runs'),
              to_regclass('public.result_interpretation_backfill_items'),
              to_regclass('public.result_canonical_selections'),
              to_regclass('public.result_interpretation_recovery_actions'),
              to_regclass('public.legacy_urans_archive_gap_recovery_actions'),
              to_regclass('public.result_archive_reduction_queue')
            ])
          ) THEN NULL ELSE 'ledger tables are incomplete' END,
          CASE WHEN (
            SELECT COALESCE(array_agg(enumlabel::text ORDER BY enumsortorder), ARRAY[]::text[])
            FROM pg_enum
            WHERE enumtypid = to_regtype('public.result_interpretation_state')
          ) = ARRAY['accepted','continuation_required','terminal_failure','legacy_uncertified']::text[]
          THEN NULL ELSE 'result_interpretation_state enum is incompatible' END,
          CASE WHEN (
            SELECT COALESCE(array_agg(enumlabel::text ORDER BY enumsortorder), ARRAY[]::text[])
            FROM pg_enum
            WHERE enumtypid = to_regtype('public.result_interpretation_regime')
          ) = ARRAY['legacy_engine_reported','rans_hold','steady_equivalent','periodic','broadband_stationary','trending_unresolved']::text[]
          THEN NULL ELSE 'result_interpretation_regime enum is incompatible' END,
          CASE WHEN (
            SELECT COALESCE(array_agg(enumlabel::text ORDER BY enumsortorder), ARRAY[]::text[])
            FROM pg_enum
            WHERE enumtypid = to_regtype('public.result_interpretation_cycle_disposition')
          ) = ARRAY['selected','startup','hard_corrupt','settling_outlier','cadence_unresolved','numerically_noisy','insufficient_frames']::text[]
          THEN NULL ELSE 'result_interpretation_cycle_disposition enum is incompatible' END,
          CASE WHEN (
            SELECT count(*) = 2 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'results'
              AND column_name IN ('current_result_interpretation_id', 'current_canonical_selection_id')
          ) THEN NULL ELSE 'results canonical pointer columns are incomplete' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'result_interpretation_recovery_actions'
              AND column_name = 'corrective_tail_periods'
          ) THEN NULL ELSE 'recovery corrective-tail column is missing' END,
          CASE WHEN (
            SELECT count(*) = 4 FROM pg_indexes
            WHERE schemaname = 'public' AND indexname IN (
              'result_archive_reduction_queue_identity_uq',
              'result_archive_reduction_queue_ready_idx',
              'result_archive_reduction_queue_lease_idx',
              'result_archive_reduction_queue_result_idx'
            )
          ) THEN NULL ELSE 'archive-reduction queue indexes are incomplete' END,
          CASE WHEN (
            SELECT count(*) = 3 FROM pg_constraint
            WHERE conrelid = to_regclass('public.result_archive_reduction_queue')
              AND conname IN (
                'result_archive_reduction_queue_attempt_owner_fk',
                'result_archive_reduction_queue_archive_owner_fk',
                'result_archive_reduction_queue_interpretation_owner_fk'
              )
          ) THEN NULL ELSE 'archive-reduction queue ownership foreign keys are incomplete' END,
          CASE WHEN (
            SELECT count(*) = 4 FROM pg_constraint
            WHERE conrelid = to_regclass('public.result_archive_reduction_queue')
              AND conname IN (
                'result_archive_reduction_queue_state_check',
                'result_archive_reduction_queue_attempt_count_check',
                'result_archive_reduction_queue_lease_shape_check',
                'result_archive_reduction_queue_reduced_shape_check'
              )
          ) THEN NULL ELSE 'archive-reduction queue checks are incomplete' END,
          CASE WHEN to_regclass('public.result_interpretations_attempt_reducer_evidence_uq') IS NULL
            THEN NULL ELSE 'deprecated global interpretation uniqueness index remains' END,
          CASE WHEN (
            SELECT count(*) = 2 FROM pg_indexes
            WHERE schemaname = 'public' AND indexname IN (
              'result_interpretations_archive_attempt_reducer_src_evidence_uq',
              'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
            )
          ) THEN NULL ELSE 'source-scoped interpretation uniqueness indexes are incomplete' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretations_archive_attempt_reducer_src_evidence_uq'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '(source = ''archive_backfill''::text)'
          ) THEN NULL ELSE 'archive interpretation uniqueness predicate is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '(source <> ''archive_backfill''::text)'
          ) THEN NULL ELSE 'nonarchive interpretation uniqueness predicate is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sim_campaign_progress'
              AND column_name = 'awaiting_archive_reduction'
              AND is_nullable = 'NO'
              AND column_default = '0'
          ) THEN NULL ELSE 'campaign awaiting-archive column/default is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.sim_campaign_progress'::regclass
              AND conname = 'sim_campaign_progress_remediation_nonnegative_check'
              AND pg_get_constraintdef(oid) LIKE '%awaiting_archive_reduction >= 0%'
          ) THEN NULL ELSE 'campaign awaiting-archive nonnegative check is incompatible' END
        ], NULL)::text[] AS postledger_0099_issues
      FROM inspection, journal
    )
    SELECT
      application_anchors_present,
      footprint_present,
      post_0093_markers_present,
      journal_state,
      preledger_0093_issues,
      postledger_0099_issues
    FROM fingerprint
  `)) as unknown as Array<{
    application_anchors_present: boolean;
    footprint_present: boolean;
    post_0093_markers_present: boolean;
    journal_state: ResultInterpretationLedgerPreflightFacts["journalState"];
    preledger_0093_issues: string[] | null;
    postledger_0099_issues: string[] | null;
  }>;
  const row = rows[0];
  if (!row) {
    throw new Error("could not inspect result-interpretation ledger migration preflight");
  }
  return classifyResultInterpretationLedgerPreflight({
    hasApplicationAnchors: row.application_anchors_present,
    journalState: row.journal_state,
    footprintPresent: row.footprint_present,
    preledger0093Issues: row.preledger_0093_issues ?? [],
    post0093MarkersPresent: row.post_0093_markers_present,
    postledger0099Issues: row.postledger_0099_issues ?? [],
  });
}

/** Convenience boundary for the migration runner and read-only release gate. */
export async function assertResultInterpretationLedgerMigrationPreflight(
  db: DB,
): Promise<ResultInterpretationLedgerPreflight> {
  const fingerprint = await readResultInterpretationLedgerPreflight(db);
  assertResultInterpretationLedgerPreflight(fingerprint);
  return fingerprint;
}
