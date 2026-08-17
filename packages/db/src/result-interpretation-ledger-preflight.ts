/**
 * Fail closed before applying the result-interpretation ledger migrations.
 *
 * Drizzle decides which migrations to skip from `created_at`; inspecting the
 * maximum timestamp is therefore unsafe.  In particular, an interrupted
 * 0094–0099 upgrade can look newer than the production 0093 baseline while
 * leaving only a subset of the additive objects. This guard admits only these
 * declared database states:
 *
 *   fresh             no application anchors and an absent/empty journal
 *   preledger_0093    the complete 0000..0093 journal plus its production
 *                     anchors, with no later ledger footprint
 *   postledger_0099   a complete 0000..0099 shape that can run 0100's
 *                     deterministic source-index reconciliation
 *   postledger_0100   a complete 0000..0100 shape that can add the
 *                     non-publishing historical-audit receipt
 *   postledger_0101   a complete 0000..0101 shape that can add the distinct
 *                     historical-audit interpretation provenance fence
 *   postledger_0102   a complete 0000..0102 shape that can tighten the
 *                     historical-audit decision source/state fence
 *   postledger_0103   a complete 0000..0103 shape that can add the direct-SQL
 *                     historical-audit canonical-selection fence
 *   postledger_0104   a complete 0000..0104 shape that can freeze one
 *                     historical audit run to one exact source/reducer
 *   postledger_0105   a complete 0000..0105 shape that can add the binding
 *                     from each audit decision to its actual child receipt
 *   postledger_0106   the complete 0000..0106 journal and final schema
 *   postledger_0107   the complete 0000..0107 journal and final schema
 *   postledger_0108   the complete 0000..0108 journal and final schema
 *   postledger_0109   the complete 0000..0109 journal and final schema
 *   postledger_0110   the complete 0000..0110 journal and final schema
 *   postledger_0116   the complete 0000..0116 journal and final schema
 *   postledger_0118   the complete 0000..0118 journal and final schema
 *   postledger_0119   the complete 0000..0119 journal and final schema
 *   postledger_0120   the complete 0000..0120 journal, terminal-evidence
 *                     schema, and exact period-roundoff reconciliation data
 *   postledger_0121   the complete 0000..0121 journal after removal of the
 *                     terminal-forensic and zero-owner quarantine schema
 *
 * Any other state requires a deliberate restore/repair procedure.  Keep this
 * read-only: it is invoked before Drizzle begins its all-or-nothing migration
 * transaction and also after it commits.
 */
import { sql } from "drizzle-orm";

import type { DB } from "./client";

export type ResultInterpretationLedgerPreflightState =
  | "fresh"
  | "preledger_0091"
  | "preledger_0093"
  | "postledger_0099_upgrade"
  | "postledger_0100_upgrade"
  | "postledger_0101_upgrade"
  | "postledger_0102_upgrade"
  | "postledger_0103_upgrade"
  | "postledger_0104_upgrade"
  | "postledger_0105"
  | "postledger_0106"
  | "postledger_0107"
  | "postledger_0108"
  | "postledger_0109"
  | "postledger_0110"
  | "postledger_0116"
  | "postledger_0118"
  | "postledger_0119"
  | "postledger_0120"
  | "postledger_0121"
  | "incompatible";

export type ResultInterpretationLedgerPreflight = {
  state: ResultInterpretationLedgerPreflightState;
  /** True when an interpretation-ledger object, type, or pointer is present. */
  footprintPresent: boolean;
  issues: string[];
};

export type ResultInterpretationLedgerPreflightFacts = {
  hasApplicationAnchors: boolean;
  journalState:
    | "absent"
    | "empty"
    | "preledger_0091"
    | "preledger_0093"
    | "postledger_0099"
    | "postledger_0100"
    | "postledger_0101"
    | "postledger_0102"
    | "postledger_0103"
    | "postledger_0104"
    | "postledger_0105"
    | "postledger_0106"
    | "postledger_0107"
    | "postledger_0108"
    | "postledger_0109"
    | "postledger_0110"
    | "postledger_0116"
    | "postledger_0118"
    | "postledger_0119"
    | "postledger_0120"
    | "postledger_0121"
    | "other";
  footprintPresent: boolean;
  preledger0093Issues: string[];
  post0093MarkersPresent: boolean;
  postledger0099Issues: string[];
  postledger0100Issues: string[];
  postledger0101Issues: string[];
  postledger0102Issues: string[];
  postledger0103Issues: string[];
  postledger0104Issues: string[];
  postledger0105Issues: string[];
  postledger0106Issues: string[];
  /** Exact 0111–0116 terminal-evidence broker footprint, also inherited at 0118. */
  postledger0116Issues: string[];
  /** Exact 0117 reciprocal terminal-receipt fence, inspected only at 0118. */
  postledger0118Issues: string[];
  /** Exact 0120 reducer identity and the completed roundoff-only repair. */
  postledger0120Issues: string[];
  /** 0121 removes terminal forensic/quarantine tables and their guards. */
  postledger0121Issues: string[];
};

/**
 * Pure classification is deliberately exposed so the acceptance matrix can be
 * tested without a production database.  The SQL reader below only gathers
 * facts; this function owns the fail-closed state machine.
 */
export function classifyResultInterpretationLedgerPreflight(
  facts: ResultInterpretationLedgerPreflightFacts,
): ResultInterpretationLedgerPreflight {
  const journalMissing =
    facts.journalState === "absent" || facts.journalState === "empty";

  if (
    journalMissing &&
    !facts.hasApplicationAnchors &&
    !facts.footprintPresent
  ) {
    return { state: "fresh", footprintPresent: false, issues: [] };
  }

  if (
    facts.journalState === "preledger_0091" &&
    !facts.footprintPresent &&
    !facts.post0093MarkersPresent
  ) {
    return { state: "preledger_0091", footprintPresent: false, issues: [] };
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
    return {
      state: "postledger_0099_upgrade",
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0100" &&
    facts.footprintPresent &&
    facts.postledger0100Issues.length === 0
  ) {
    return {
      state: "postledger_0100_upgrade",
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0101" &&
    facts.footprintPresent &&
    facts.postledger0101Issues.length === 0
  ) {
    return {
      state: "postledger_0101_upgrade",
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0102" &&
    facts.footprintPresent &&
    facts.postledger0102Issues.length === 0
  ) {
    return {
      state: "postledger_0102_upgrade",
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0103" &&
    facts.footprintPresent &&
    facts.postledger0103Issues.length === 0
  ) {
    return {
      state: "postledger_0103_upgrade",
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0104" &&
    facts.footprintPresent &&
    facts.postledger0104Issues.length === 0
  ) {
    return {
      state: "postledger_0104_upgrade",
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0105" &&
    facts.footprintPresent &&
    facts.postledger0105Issues.length === 0
  ) {
    return { state: "postledger_0105", footprintPresent: true, issues: [] };
  }

  if (
    facts.journalState === "postledger_0106" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0
  ) {
    return { state: "postledger_0106", footprintPresent: true, issues: [] };
  }

  if (
    facts.journalState === "postledger_0107" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0
  ) {
    return { state: "postledger_0107", footprintPresent: true, issues: [] };
  }

  if (
    facts.journalState === "postledger_0108" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0
  ) {
    return { state: "postledger_0108", footprintPresent: true, issues: [] };
  }

  if (
    facts.journalState === "postledger_0109" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0
  ) {
    return { state: "postledger_0109", footprintPresent: true, issues: [] };
  }

  if (
    facts.journalState === "postledger_0110" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0
  ) {
    return { state: "postledger_0110", footprintPresent: true, issues: [] };
  }

  if (
    facts.journalState === "postledger_0116" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0 &&
    facts.postledger0116Issues.length === 0
  ) {
    return { state: "postledger_0116", footprintPresent: true, issues: [] };
  }

  if (
    (facts.journalState === "postledger_0118" ||
      facts.journalState === "postledger_0119" ||
      facts.journalState === "postledger_0120") &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0 &&
    facts.postledger0116Issues.length === 0 &&
    facts.postledger0118Issues.length === 0 &&
    (facts.journalState !== "postledger_0120" ||
      facts.postledger0120Issues.length === 0)
  ) {
    return {
      state: facts.journalState,
      footprintPresent: true,
      issues: [],
    };
  }

  if (
    facts.journalState === "postledger_0121" &&
    facts.footprintPresent &&
    facts.postledger0106Issues.length === 0 &&
    facts.postledger0120Issues.length === 0 &&
    facts.postledger0121Issues.length === 0
  ) {
    return { state: "postledger_0121", footprintPresent: true, issues: [] };
  }

  const issues = [
    ...(facts.hasApplicationAnchors && journalMissing
      ? [
          "application tables exist but the migration journal is absent or empty",
        ]
      : []),
    ...(facts.journalState === "other"
      ? [
            "migration journal is not the exact 0000..0093, 0000..0099, 0000..0100, 0000..0101, 0000..0102, 0000..0103, 0000..0104, 0000..0105, 0000..0106, 0000..0107, 0000..0108, 0000..0109, 0000..0110, 0000..0116, 0000..0118, 0000..0119, 0000..0120, or 0000..0121 timestamp set",
        ]
      : []),
    ...(facts.journalState === "preledger_0093"
      ? facts.preledger0093Issues
      : []),
    ...(facts.journalState === "preledger_0093" && facts.post0093MarkersPresent
      ? [
          "a 0094–0099 schema marker exists before the ledger journal is complete",
        ]
      : []),
    ...(facts.journalState === "postledger_0099"
      ? facts.postledger0099Issues
      : []),
    ...(facts.journalState === "postledger_0100"
      ? facts.postledger0100Issues
      : []),
    ...(facts.journalState === "postledger_0101"
      ? facts.postledger0101Issues
      : []),
    ...(facts.journalState === "postledger_0102"
      ? facts.postledger0102Issues
      : []),
    ...(facts.journalState === "postledger_0103"
      ? facts.postledger0103Issues
      : []),
    ...(facts.journalState === "postledger_0104"
      ? facts.postledger0104Issues
      : []),
    ...(facts.journalState === "postledger_0105"
      ? facts.postledger0105Issues
      : []),
    ...(facts.journalState === "postledger_0106"
      ? facts.postledger0106Issues
      : []),
    ...(facts.journalState === "postledger_0116" ||
    facts.journalState === "postledger_0118" ||
    facts.journalState === "postledger_0119" ||
    facts.journalState === "postledger_0120"
      ? facts.postledger0116Issues
      : []),
    ...(facts.journalState === "postledger_0118" ||
    facts.journalState === "postledger_0119" ||
    facts.journalState === "postledger_0120"
      ? facts.postledger0118Issues
      : []),
    ...(facts.journalState === "postledger_0120" ||
    facts.journalState === "postledger_0121"
      ? facts.postledger0120Issues
      : []),
    ...(facts.journalState === "postledger_0121"
      ? facts.postledger0121Issues
      : []),
    ...(facts.journalState === "preledger_0093" && facts.footprintPresent
      ? [
          "interpretation-ledger footprint exists before the ledger journal is complete",
        ]
      : []),
    ...((facts.journalState === "postledger_0100" ||
      facts.journalState === "postledger_0101" ||
      facts.journalState === "postledger_0102" ||
      facts.journalState === "postledger_0103" ||
      facts.journalState === "postledger_0104" ||
      facts.journalState === "postledger_0105" ||
      facts.journalState === "postledger_0106" ||
      facts.journalState === "postledger_0107" ||
      facts.journalState === "postledger_0108" ||
      facts.journalState === "postledger_0109" ||
      facts.journalState === "postledger_0110" ||
      facts.journalState === "postledger_0116" ||
      facts.journalState === "postledger_0118" ||
      facts.journalState === "postledger_0119" ||
      facts.journalState === "postledger_0120" ||
      facts.journalState === "postledger_0121") &&
    !facts.footprintPresent
      ? [
          "post-ledger journal exists without the interpretation-ledger footprint",
        ]
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

// These are the immutable Drizzle `when` values for journal entries 0000..0091
// and 0000..0093
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
const JOURNAL_THROUGH_0091 = JOURNAL_THROUGH_0093.slice(0, -2);
const JOURNAL_THROUGH_0099 = [
  ...JOURNAL_THROUGH_0093,
  1788998400000,
  1789084800000,
  1789171200000,
  1789257600000,
  1789344000000,
  1789430400000,
] as const;
const JOURNAL_THROUGH_0100 = [...JOURNAL_THROUGH_0099, 1789516800000] as const;
const JOURNAL_THROUGH_0101 = [...JOURNAL_THROUGH_0100, 1789603200000] as const;
const JOURNAL_THROUGH_0102 = [...JOURNAL_THROUGH_0101, 1789689600000] as const;
const JOURNAL_THROUGH_0103 = [...JOURNAL_THROUGH_0102, 1789776000000] as const;
const JOURNAL_THROUGH_0104 = [...JOURNAL_THROUGH_0103, 1789862400000] as const;
const JOURNAL_THROUGH_0105 = [...JOURNAL_THROUGH_0104, 1789948800000] as const;
const JOURNAL_THROUGH_0106 = [...JOURNAL_THROUGH_0105, 1790035200000] as const;
const JOURNAL_THROUGH_0107 = [...JOURNAL_THROUGH_0106, 1790121600000] as const;
const JOURNAL_THROUGH_0108 = [...JOURNAL_THROUGH_0107, 1790208000000] as const;
const JOURNAL_THROUGH_0109 = [...JOURNAL_THROUGH_0108, 1790294400000] as const;
const JOURNAL_THROUGH_0110 = [...JOURNAL_THROUGH_0109, 1790380800000] as const;
const JOURNAL_THROUGH_0111 = [...JOURNAL_THROUGH_0110, 1790467200000] as const;
const JOURNAL_THROUGH_0112 = [...JOURNAL_THROUGH_0111, 1790553600000] as const;
const JOURNAL_THROUGH_0113 = [...JOURNAL_THROUGH_0112, 1790640000000] as const;
const JOURNAL_THROUGH_0114 = [...JOURNAL_THROUGH_0113, 1790726400000] as const;
const JOURNAL_THROUGH_0115 = [...JOURNAL_THROUGH_0114, 1790812800000] as const;
const JOURNAL_THROUGH_0116 = [...JOURNAL_THROUGH_0115, 1790899200000] as const;
const JOURNAL_THROUGH_0117 = [...JOURNAL_THROUGH_0116, 1790985600000] as const;
const JOURNAL_THROUGH_0118 = [...JOURNAL_THROUGH_0117, 1791072000000] as const;
const JOURNAL_THROUGH_0119 = [...JOURNAL_THROUGH_0118, 1791158400000] as const;
const JOURNAL_THROUGH_0120 = [...JOURNAL_THROUGH_0119, 1791244800000] as const;
const JOURNAL_THROUGH_0121 = [...JOURNAL_THROUGH_0120, 1791331200000] as const;

const EXACT_JOURNAL_BASELINES = [
  ["preledger_0091", JOURNAL_THROUGH_0091],
  ["preledger_0093", JOURNAL_THROUGH_0093],
  ["postledger_0099", JOURNAL_THROUGH_0099],
  ["postledger_0100", JOURNAL_THROUGH_0100],
  ["postledger_0101", JOURNAL_THROUGH_0101],
  ["postledger_0102", JOURNAL_THROUGH_0102],
  ["postledger_0103", JOURNAL_THROUGH_0103],
  ["postledger_0104", JOURNAL_THROUGH_0104],
  ["postledger_0105", JOURNAL_THROUGH_0105],
  ["postledger_0106", JOURNAL_THROUGH_0106],
  ["postledger_0107", JOURNAL_THROUGH_0107],
  ["postledger_0108", JOURNAL_THROUGH_0108],
  ["postledger_0109", JOURNAL_THROUGH_0109],
  ["postledger_0110", JOURNAL_THROUGH_0110],
  ["postledger_0116", JOURNAL_THROUGH_0116],
  ["postledger_0118", JOURNAL_THROUGH_0118],
  ["postledger_0119", JOURNAL_THROUGH_0119],
  ["postledger_0120", JOURNAL_THROUGH_0120],
  ["postledger_0121", JOURNAL_THROUGH_0121],
] as const satisfies ReadonlyArray<
  readonly [
    Exclude<
      ResultInterpretationLedgerPreflightFacts["journalState"],
      "absent" | "empty" | "other"
    >,
    readonly number[],
  ]
>;

/**
 * Classify a materialized Drizzle journal without accepting a prefix that is
 * not a deliberate release baseline.  0111–0115 and 0117 are not accepted
 * persisted release states: production admits the atomic 0116 terminal shape,
 * then the complete 0118 reciprocal-fence release, its data-only 0119
 * recovery migration, and the exact 0120 period-roundoff reconciliation.
 */
export function classifyResultInterpretationLedgerJournal(
  timestamps: readonly number[],
): Exclude<ResultInterpretationLedgerPreflightFacts["journalState"], "absent"> {
  if (timestamps.length === 0) return "empty";
  for (const [state, baseline] of EXACT_JOURNAL_BASELINES) {
    if (
      timestamps.length === baseline.length &&
      timestamps.every((timestamp, index) => timestamp === baseline[index])
    ) {
      return state;
    }
  }
  return "other";
}

/**
 * The journal is necessary but not sufficient after the terminal-evidence
 * release.  These migrations introduce the deletion authority for remote
 * solver work, so a journal that was manually repaired while its immutable
 * receipt/quarantine fence is absent is unsafe to start against.  Keep this
 * inspection separate from the older ledger fingerprint: it touches tables
 * that intentionally do not exist on every upgradeable pre-0116 baseline.
 */
async function readPostledger0116FootprintIssues(db: DB): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(ARRAY_REMOVE(ARRAY[
      CASE WHEN (
        SELECT count(*) = 3
        FROM pg_class
        WHERE oid = ANY(ARRAY[
          to_regclass('public.sync_remote_terminal_evidence_receipts'),
          to_regclass('public.sync_remote_terminal_evidence_uploads'),
          to_regclass('public.sync_brokered_terminal_evidence_uploads')
        ])
      ) THEN NULL ELSE '0111–0112 terminal evidence tables are incomplete' END,
      CASE WHEN (
        SELECT count(*) = 9
        FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_remote_terminal_evidence_receipts')
          AND conname IN (
            'sync_remote_terminal_evidence_receipts_job_fk',
            'sync_remote_terminal_evidence_receipts_promise_fk',
            'sync_remote_terminal_evidence_receipts_job_uq',
            'sync_remote_terminal_evidence_receipts_upload_uq',
            'sync_remote_terminal_evidence_receipts_shape_check',
            'sync_remote_terminal_evidence_receipts_remote_identity_check',
            'sync_remote_terminal_evidence_receipts_reclaim_state_check',
            'sync_remote_terminal_evidence_receipts_reclaim_claim_check',
            'sync_remote_terminal_evidence_receipts_reclaimed_check'
          )
      ) THEN NULL ELSE '0111 terminal receipt constraints are incomplete' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_remote_terminal_evidence_receipts')
          AND conname = 'sync_remote_terminal_evidence_receipts_shape_check'
          AND pg_get_constraintdef(oid) LIKE '%receipt_canonical%'
          AND pg_get_constraintdef(oid) LIKE '%receipt_hmac%'
          AND pg_get_constraintdef(oid) LIKE '%terminalState%'
          AND pg_get_constraintdef(oid) LIKE '%storedSha256%'
      ) THEN NULL ELSE '0111 terminal receipt identity check is incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_remote_terminal_evidence_receipts')
          AND conname = 'sync_remote_terminal_evidence_receipts_remote_identity_check'
          AND pg_get_constraintdef(oid) LIKE '%generation%'
          AND pg_get_constraintdef(oid) LIKE '%stored_byte_size%'
          AND pg_get_constraintdef(oid) LIKE '%crc32c%'
      ) THEN NULL ELSE '0111 terminal receipt remote identity check is incompatible' END,
      CASE WHEN (
        SELECT count(*) = 4
        FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_remote_terminal_evidence_uploads')
          AND conname IN (
            'sync_remote_terminal_evidence_uploads_job_uq',
            'sync_remote_terminal_evidence_uploads_terminal_state_check',
            'sync_remote_terminal_evidence_uploads_identity_check',
            'sync_remote_terminal_evidence_uploads_claim_shape_check'
          )
      ) THEN NULL ELSE '0112 remote terminal outbox constraints are incomplete' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_remote_terminal_evidence_uploads')
          AND conname = 'sync_remote_terminal_evidence_uploads_identity_check'
          AND pg_get_constraintdef(oid) LIKE '%stored_sha256%'
          AND pg_get_constraintdef(oid) LIKE '%local_archive_storage_key%'
          AND pg_get_constraintdef(oid) LIKE '%zstd_level%'
      ) THEN NULL ELSE '0112 remote terminal outbox identity check is incompatible' END,
      CASE WHEN (
        SELECT count(*) = 9
        FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_brokered_terminal_evidence_uploads')
          AND conname IN (
            'sync_brokered_terminal_evidence_uploads_idempotency_uq',
            'sync_brokered_terminal_evidence_uploads_job_uq',
            'sync_brokered_terminal_evidence_uploads_terminal_upload_uq',
            'sync_brokered_terminal_evidence_uploads_hash_check',
            'sync_brokered_terminal_evidence_uploads_size_check',
            'sync_brokered_terminal_evidence_uploads_state_check',
            'sync_brokered_terminal_evidence_uploads_claim_shape_check',
            'sync_brokered_terminal_evidence_uploads_issued_shape_check',
            'sync_brokered_terminal_evidence_uploads_verified_shape_check'
          )
      ) THEN NULL ELSE '0112 brokered terminal quarantine constraints are incomplete' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('public.sync_brokered_terminal_evidence_uploads')
          AND conname = 'sync_brokered_terminal_evidence_uploads_verified_shape_check'
          AND pg_get_constraintdef(oid) LIKE '%generation IS NOT NULL%'
          AND pg_get_constraintdef(oid) LIKE '%crc32c IS NOT NULL%'
          AND pg_get_constraintdef(oid) LIKE '%verified_at IS NOT NULL%'
      ) THEN NULL ELSE '0112 brokered terminal quarantine verified shape is incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'sync_remote_terminal_evidence_uploads'
          AND column_name = 'next_attempt_at'
          AND is_nullable = 'NO'
          AND column_default IS NOT NULL
      ) THEN NULL ELSE '0115 terminal outbox retry timestamp is incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1
        FROM pg_class index_class
        WHERE index_class.oid = to_regclass('public.sync_remote_terminal_evidence_uploads_ready_idx')
          AND pg_get_indexdef(index_class.oid) LIKE '%(state, next_attempt_at, "updatedAt")%'
      ) THEN NULL ELSE '0115 terminal outbox retry index is incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1
        FROM pg_class index_class
        WHERE index_class.oid = to_regclass('public.sync_remote_terminal_evidence_uploads_hub_upload_uq')
          AND pg_get_indexdef(index_class.oid) LIKE '%UNIQUE%'
          AND pg_get_indexdef(index_class.oid) LIKE '%(hub_upload_id)%'
          AND pg_get_indexdef(index_class.oid) LIKE '%WHERE (hub_upload_id IS NOT NULL)%'
      ) AND EXISTS (
        SELECT 1
        FROM pg_class index_class
        WHERE index_class.oid = to_regclass('public.sync_remote_terminal_evidence_receipts_reclaim_ready_idx')
          AND pg_get_indexdef(index_class.oid) LIKE '%(reclaim_state, reclaim_next_attempt_at)%'
      ) AND EXISTS (
        SELECT 1
        FROM pg_class index_class
        WHERE index_class.oid = to_regclass('public.sync_remote_terminal_evidence_receipts_source_idx')
          AND pg_get_indexdef(index_class.oid) LIKE '%(engine_job_id, generation)%'
      ) AND EXISTS (
        SELECT 1
        FROM pg_class index_class
        WHERE index_class.oid = to_regclass('public.sync_brokered_terminal_evidence_uploads_state_idx')
          AND pg_get_indexdef(index_class.oid) LIKE '%(state, upload_expires_at)%'
      ) AND EXISTS (
        SELECT 1
        FROM pg_class index_class
        WHERE index_class.oid = to_regclass('public.sync_brokered_terminal_evidence_uploads_verified_engine_job_idx')
          AND pg_get_indexdef(index_class.oid) LIKE '%(engine_job_id)%'
          AND pg_get_indexdef(index_class.oid) LIKE '%WHERE (state = ''verified''::text)%'
      ) THEN NULL ELSE '0111–0116 terminal evidence indexes are incompatible' END,
      CASE WHEN to_regprocedure('public.prevent_remote_terminal_evidence_receipt_mutation()') IS NOT NULL
        AND to_regprocedure('public.enforce_remote_terminal_evidence_receipt_scope()') IS NOT NULL
        AND to_regprocedure('public.enforce_brokered_terminal_evidence_zero_result()') IS NOT NULL
        AND to_regprocedure('public.prevent_verified_brokered_terminal_evidence_mutation()') IS NOT NULL
        AND to_regprocedure('public.prevent_verified_brokered_terminal_evidence_delete()') IS NOT NULL
        AND to_regprocedure('public.prevent_result_ownership_of_verified_terminal_quarantine()') IS NOT NULL
      THEN NULL ELSE '0111–0116 terminal evidence fence functions are incomplete' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.enforce_remote_terminal_evidence_receipt_scope()')
          AND pg_get_functiondef(oid) LIKE '%result_row.sim_job_id%'
          AND pg_get_functiondef(oid) LIKE '%attempt_row.engine_job_id%'
      ) AND EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.enforce_brokered_terminal_evidence_zero_result()')
          AND pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%'
          AND pg_get_functiondef(oid) LIKE '%remote-terminal-evidence-engine:%'
      ) AND EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prevent_result_ownership_of_verified_terminal_quarantine()')
          AND pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%'
          AND pg_get_functiondef(oid) LIKE '%sync_brokered_terminal_evidence_uploads%'
          AND pg_get_functiondef(oid) LIKE '%quarantine.state = ''verified''%'
      ) THEN NULL ELSE '0113 and 0116 terminal evidence zero-result fences are incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.sync_remote_terminal_evidence_receipts')
          AND trigger_row.tgname = 'sync_remote_terminal_evidence_receipts_immutable'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_remote_terminal_evidence_receipt_mutation()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 0
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.sync_remote_terminal_evidence_receipts')
          AND trigger_row.tgname = 'sync_remote_terminal_evidence_receipts_scope_guard'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.enforce_remote_terminal_evidence_receipt_scope()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 4
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) THEN NULL ELSE '0111 terminal receipt triggers are incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.sync_brokered_terminal_evidence_uploads')
          AND trigger_row.tgname = 'sync_brokered_terminal_evidence_uploads_zero_result_fence'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.enforce_brokered_terminal_evidence_zero_result()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 4
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.sync_brokered_terminal_evidence_uploads')
          AND trigger_row.tgname = 'sync_brokered_terminal_evidence_uploads_immutable_verified'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_verified_brokered_terminal_evidence_mutation()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 0
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.sync_brokered_terminal_evidence_uploads')
          AND trigger_row.tgname = 'sync_brokered_terminal_evidence_uploads_no_verified_delete'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_verified_brokered_terminal_evidence_delete()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 0
          AND (trigger_row.tgtype::integer & 8) = 8
          AND (trigger_row.tgtype::integer & 16) = 0
      ) THEN NULL ELSE '0114 terminal quarantine immutability triggers are incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.results')
          AND trigger_row.tgname = 'results_verified_terminal_quarantine_owner_fence'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_result_ownership_of_verified_terminal_quarantine()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 4
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.result_attempts')
          AND trigger_row.tgname = 'result_attempts_verified_terminal_quarantine_owner_fence'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_result_ownership_of_verified_terminal_quarantine()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 4
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) THEN NULL ELSE '0116 reverse terminal quarantine ownership triggers are incompatible' END
    ], NULL), ARRAY[]::text[]) AS issues
  `)) as unknown as Array<{ issues: string[] | null }>;
  const row = rows[0];
  if (!row) {
    return ["could not inspect the 0111–0116 terminal evidence footprint"];
  }
  return row.issues ?? [];
}

/**
 * Migration 0117 closes the reciprocal race between receipt insertion and
 * delayed result ingestion. Its modified receipt guard and reverse owner
 * guard must share the exact engine-identity advisory lock. This is checked
 * only after 0118, because 0116 remains a supported pre-0117 upgrade point.
 */
async function readPostledger0118FootprintIssues(db: DB): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(ARRAY_REMOVE(ARRAY[
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.enforce_remote_terminal_evidence_receipt_scope()')
          AND pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%'
          AND pg_get_functiondef(oid) LIKE '%remote-terminal-evidence-engine:%'
      ) AND EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.prevent_result_ownership_of_remote_terminal_receipt()')
          AND pg_get_functiondef(oid) LIKE '%pg_advisory_xact_lock%'
          AND pg_get_functiondef(oid) LIKE '%remote-terminal-evidence-engine:%'
          AND pg_get_functiondef(oid) LIKE '%sync_remote_terminal_evidence_receipts%'
          AND pg_get_functiondef(oid) LIKE '%quarantine.sim_job_id = NEW.sim_job_id%'
          AND pg_get_functiondef(oid) LIKE '%quarantine.engine_job_id = NEW.engine_job_id%'
      ) THEN NULL ELSE '0117 remote terminal receipt reciprocal ownership function fence is incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.results')
          AND trigger_row.tgname = 'results_remote_terminal_receipt_owner_fence'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_result_ownership_of_remote_terminal_receipt()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 4
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) AND EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgrelid = to_regclass('public.result_attempts')
          AND trigger_row.tgname = 'result_attempts_remote_terminal_receipt_owner_fence'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgfoid = to_regprocedure('public.prevent_result_ownership_of_remote_terminal_receipt()')
          AND (trigger_row.tgtype::integer & 1) = 1
          AND (trigger_row.tgtype::integer & 2) = 2
          AND (trigger_row.tgtype::integer & 4) = 4
          AND (trigger_row.tgtype::integer & 8) = 0
          AND (trigger_row.tgtype::integer & 16) = 16
      ) THEN NULL ELSE '0117 remote terminal receipt reciprocal ownership triggers are incompatible' END
    ], NULL), ARRAY[]::text[]) AS issues
  `)) as unknown as Array<{ issues: string[] | null }>;
  const row = rows[0];
  if (!row) {
    return [
      "could not inspect the 0117 remote terminal receipt reciprocal fence",
    ];
  }
  return row.issues ?? [];
}

/**
 * 0120 is data-only.  An exact journal must therefore prove both the v6
 * reducer identity and that the narrow v12 boundary incident was actually
 * reconciled; a journal row alone cannot provide that proof.
 */
async function readPostledger0120ReconciliationIssues(
  db: DB,
): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(ARRAY_REMOVE(ARRAY[
      CASE WHEN EXISTS (
        SELECT 1
        FROM "result_reducer_versions" reducer
        WHERE reducer."reducer_key" = 'airfoilfoam'
          AND reducer."reducer_version" = 'result-interpretation-v2'
          AND reducer."build_id" = 'clean-cycle-v6'
          AND reducer."policy_sha256" = '782075da76b45b55e7ec98c6bb653a4c52cc3fc9931d3dc0cf1d8a18adc3e92d'
          AND reducer."policy" -> 'urans' ->> 'periodBoundaryUlps' = '4'
      ) THEN NULL ELSE '0120 period-roundoff reducer identity or policy is incompatible' END,
      CASE WHEN EXISTS (
        SELECT 1
        FROM "sim_solver_incidents" incident
        JOIN "result_attempts" attempt
          ON attempt."id" = incident."result_attempt_id"
        JOIN "result_classifications" classification
          ON classification."result_attempt_id" = attempt."id"
        JOIN "results" result ON result."id" = attempt."result_id"
        JOIN "solver_evidence_archives" archive
          ON archive."result_id" = result."id"
          AND archive."result_attempt_id" = attempt."id"
          AND archive."state" = 'current'
        JOIN "solver_evidence_blobs" blob ON blob."id" = archive."blob_id"
        JOIN "result_archive_reduction_queue" v5_receipt
          ON v5_receipt."result_id" = result."id"
          AND v5_receipt."result_attempt_id" = attempt."id"
          AND v5_receipt."source_archive_id" = archive."id"
        JOIN "result_reducer_versions" v5_reducer
          ON v5_reducer."id" = v5_receipt."reducer_version_id"
        WHERE incident."stage" = 'preliminary'
          AND incident."reason" = 'insufficient-periods'
          AND incident."severity" = 'critical'
          AND incident."status" = 'open'
          AND incident."remediation_version" = 'urans-recovery-2026-08-02-v12'
          AND incident."result_id" IS NULL
          AND incident."verify_queue_id" IS NULL
          AND incident."urans_request_id" IS NULL
          AND incident."precalc_obligation_id" IS NOT NULL
          AND incident."sim_job_id" = attempt."sim_job_id"
          AND incident."metadata" ->> 'lastOutcome' = 'rejected_exhausted'
          AND incident."metadata" ->> 'failureDisposition' = 'none'
          AND incident."metadata" -> 'classificationReasons' = '["insufficient-periods"]'::jsonb
          AND attempt."status" = 'done'
          AND attempt."source" = 'solved'
          AND attempt."regime" = 'urans'
          AND attempt."unsteady" = TRUE
          AND attempt."evidence_payload" ->> 'fidelity' = 'urans_precalc'
          AND attempt."evidence_payload" #>> '{frame_track,stationary}' = 'true'
          AND jsonb_typeof(attempt."evidence_payload" #> '{frame_track,periods_retained}') = 'number'
          AND (attempt."evidence_payload" #>> '{frame_track,periods_retained}') ~ '^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
          AND (attempt."evidence_payload" #>> '{frame_track,periods_retained}')::double precision < 3.0
          AND 3.0 - (attempt."evidence_payload" #>> '{frame_track,periods_retained}')::double precision <= 4.0 * 2.0 * 2.220446049250313e-16
          AND attempt."evidence_payload" #>> '{urans_cycle_certificate,reducer_version}' = 'clean-cycle-v3'
          AND attempt."evidence_payload" #>> '{urans_cycle_certificate,certified}' = 'true'
          AND classification."classifier_version" = 'fidelity-ladder-v7'
          AND classification."state" = 'rejected'
          AND classification."reasons" = ARRAY['insufficient-periods']::text[]
          AND blob."backend" = 'gcs'
          AND blob."compression" = 'zstd'
          AND blob."mime_type" = 'application/zstd'
          AND btrim(COALESCE(blob."bucket", '')) <> ''
          AND blob."generation" ~ '^[1-9][0-9]{0,19}$'
          AND blob."verifiedAt" IS NOT NULL
          AND v5_receipt."state" = 'failed'
          AND v5_receipt."last_error" = 'fetch failed'
          AND v5_reducer."reducer_key" = 'airfoilfoam'
          AND v5_reducer."reducer_version" = 'result-interpretation-v2'
          AND v5_reducer."build_id" = 'clean-cycle-v5'
      ) THEN '0120 period-roundoff reconciliation left an exact incident unresolved' END
    ], NULL), ARRAY[]::text[]) AS issues
  `)) as unknown as Array<{ issues: string[] | null }>;
  const row = rows[0];
  return (
    row?.issues ?? ["could not inspect the 0120 period-roundoff reconciliation"]
  );
}

/** 0121 removes only the obsolete terminal forensic/quarantine paths. */
async function readPostledger0121RemovalIssues(db: DB): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT COALESCE(ARRAY_REMOVE(ARRAY[
      CASE WHEN to_regclass('public.sync_remote_terminal_evidence_receipts') IS NULL
        AND to_regclass('public.sync_remote_terminal_evidence_uploads') IS NULL
        AND to_regclass('public.sync_brokered_terminal_evidence_uploads') IS NULL
        AND to_regclass('public.solver_evidence_orphan_quarantines') IS NULL
        AND to_regclass('public.solver_evidence_incomplete_quarantines') IS NULL
      THEN NULL ELSE '0121 obsolete terminal-forensic or quarantine table remains' END,
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM pg_trigger trigger_row
        WHERE trigger_row.tgname IN (
          'results_remote_terminal_receipt_owner_fence',
          'result_attempts_remote_terminal_receipt_owner_fence',
          'results_verified_terminal_quarantine_owner_fence',
          'result_attempts_verified_terminal_quarantine_owner_fence',
          'aaa_incomplete_quarantine_artifact_guard',
          'aaa_incomplete_quarantine_archive_guard'
        ) AND NOT trigger_row.tgisinternal
      ) THEN NULL ELSE '0121 obsolete terminal-forensic or quarantine trigger remains' END,
      CASE WHEN to_regprocedure('public.prevent_result_ownership_of_remote_terminal_receipt()') IS NULL
        AND to_regprocedure('public.prevent_result_ownership_of_verified_terminal_quarantine()') IS NULL
        AND to_regprocedure('public.prevent_remote_terminal_evidence_receipt_mutation()') IS NULL
        AND to_regprocedure('public.enforce_remote_terminal_evidence_receipt_scope()') IS NULL
        AND to_regprocedure('public.enforce_brokered_terminal_evidence_zero_result()') IS NULL
        AND to_regprocedure('public.enforce_solver_evidence_incomplete_quarantine()') IS NULL
        AND to_regprocedure('public.enforce_solver_evidence_orphan_quarantine()') IS NULL
      THEN NULL ELSE '0121 obsolete terminal-forensic or quarantine function remains' END,
      CASE WHEN EXISTS (
        SELECT 1 FROM pg_proc
        WHERE oid = to_regprocedure('public.reject_linked_solver_evidence_artifact_update()')
          AND pg_get_functiondef(oid) NOT LIKE '%solver_evidence_orphan_quarantines%'
      ) THEN NULL ELSE '0121 accepted artifact immutability function still references orphan quarantine' END
    ], NULL), ARRAY[]::text[]) AS issues
  `)) as unknown as Array<{ issues: string[] | null }>;
  const row = rows[0];
  return row?.issues ?? ["could not inspect the 0121 forensic-removal footprint"];
}

const HISTORICAL_AUDIT_CURRENT_PROJECTION_ISSUE =
  "historical audit interpretation is exposed by a current result projection";
const HISTORICAL_AUDIT_RUN_IDENTITY_ISSUE =
  "historical archive audit decision does not match its immutable audit run identity";
const HISTORICAL_AUDIT_RUN_CARDINALITY_ISSUE =
  "historical archive audit run has more than one immutable decision";
const HISTORICAL_AUDIT_CHILD_RECEIPT_ISSUE =
  "historical archive audit decision does not match its terminal child execution receipt";
const HISTORICAL_AUDIT_RUN_CHILD_CARDINALITY_ISSUE =
  "historical archive audit run does not have exactly one immutable child execution receipt";

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
            (SELECT count(*) FROM drizzle.__drizzle_migrations) = ${JOURNAL_THROUGH_0091.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0091.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0091)}
          )
            THEN 'preledger_0091'
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
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0100.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0100.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0100)}
            THEN 'postledger_0100'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0101.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0101.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0101)}
            THEN 'postledger_0101'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0102.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0102.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0102)}
            THEN 'postledger_0102'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0103.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0103.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
            FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0103)}
            THEN 'postledger_0103'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0104.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0104.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0104)}
            THEN 'postledger_0104'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0105.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0105.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0105)}
            THEN 'postledger_0105'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0106.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0106.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0106)}
            THEN 'postledger_0106'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0107.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0107.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0107)}
            THEN 'postledger_0107'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0108.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0108.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0108)}
            THEN 'postledger_0108'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0109.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0109.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0109)}
            THEN 'postledger_0109'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0110.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0110.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0110)}
            THEN 'postledger_0110'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0116.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0116.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0116)}
            THEN 'postledger_0116'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0118.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0118.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0118)}
            THEN 'postledger_0118'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0119.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0119.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0119)}
            THEN 'postledger_0119'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0120.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0120.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0120)}
            THEN 'postledger_0120'
          WHEN (
            SELECT count(*) FROM drizzle.__drizzle_migrations
          ) = ${JOURNAL_THROUGH_0121.length}
            AND (
              SELECT count(DISTINCT created_at) FROM drizzle.__drizzle_migrations
            ) = ${JOURNAL_THROUGH_0121.length}
            AND (
              SELECT array_agg(created_at ORDER BY created_at)
              FROM drizzle.__drizzle_migrations
            ) = ${journalArraySql(JOURNAL_THROUGH_0121)}
            THEN 'postledger_0121'
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
            to_regclass('public.result_archive_reduction_queue'),
            to_regclass('public.historical_archive_audit_decisions')
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
          OR to_regclass('public.historical_archive_audit_decisions_identity_uq') IS NOT NULL
          OR to_regclass('public.ri_historical_archive_attempt_reducer_source_evidence_uq') IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM pg_trigger
            WHERE tgrelid = to_regclass('public.historical_archive_audit_decisions')
              AND tgname = 'historical_archive_audit_decisions_validate_insert'
              AND NOT tgisinternal
          )
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
            SELECT count(*) = 2
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND (
                (
                  constraint_row.conname = 'ri_recovery_tail_periods_ck'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%corrective_tail_periods >= 1%'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%corrective_tail_periods <= 3%'
                ) OR (
                  constraint_row.conname = 'result_interpretation_recovery_actions_target_shape_check'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%target_urans_request_id IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%target_verify_queue_id IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%NOT%'
                )
              )
          ) THEN NULL ELSE 'recovery action tail/target-shape constraints are incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'sim_urans_requests'
              AND column_name = 'corrective_tail_periods'
          ) THEN NULL ELSE '0094 URANS corrective-tail column is missing' END,
          CASE WHEN (
            SELECT count(*) = 2
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.sim_urans_requests')
              AND (
                (
                  constraint_row.conname = 'sim_urans_tail_periods_ck'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%corrective_tail_periods >= 1%'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%corrective_tail_periods <= 3%'
                ) OR (
                  constraint_row.conname = 'sim_urans_tail_continue_ck'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%continue_from_result_id IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid)
                    LIKE '%continue_from_result_attempt_id IS NOT NULL%'
                )
              )
          ) THEN NULL ELSE '0094 URANS corrective-tail constraints are incomplete' END,
          CASE WHEN (
            SELECT count(*) = 4
            FROM pg_constraint
            WHERE conrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND conname IN (
                'result_interpretation_recovery_actions_attempt_owner_fk',
                'result_interpretation_recovery_actions_archive_owner_fk',
                'result_interpretation_recovery_actions_lease_shape_check',
                'result_interpretation_recovery_actions_routed_target_check'
              )
          ) THEN NULL ELSE 'recovery action ownership or lease constraints are incomplete' END,
          CASE WHEN (
            SELECT count(*) = 4
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND constraint_row.contype = 'f'
              AND (
                (
                  constraint_row.conname = 'result_interpretation_recovery_actions_attempt_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (result_attempt_id, result_id) REFERENCES result_attempts(id, result_id) ON DELETE CASCADE'
                ) OR (
                  constraint_row.conname = 'result_interpretation_recovery_actions_archive_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (source_archive_id, result_attempt_id) REFERENCES solver_evidence_archives(id, result_attempt_id) ON DELETE RESTRICT'
                ) OR pg_get_constraintdef(constraint_row.oid) =
                  'FOREIGN KEY (target_urans_request_id) REFERENCES sim_urans_requests(id) ON DELETE RESTRICT'
                OR pg_get_constraintdef(constraint_row.oid) =
                  'FOREIGN KEY (target_verify_queue_id) REFERENCES sim_urans_verify_queue(id) ON DELETE RESTRICT'
              )
          ) THEN NULL ELSE 'recovery action foreign-key ownership is incompatible' END,
          CASE WHEN (
            SELECT count(*) = 2
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND (
                (
                  constraint_row.conname = 'result_interpretation_recovery_actions_lease_shape_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%state = ''routing''::text%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%claim_token IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%claim_expires_at IS NOT NULL%'
                ) OR (
                  constraint_row.conname = 'result_interpretation_recovery_actions_routed_target_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%waiting_for_precalc%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%continuation_routed%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%fresh_rerun_routed%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%target_urans_request_id IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%target_verify_queue_id IS NOT NULL%'
                )
              )
          ) THEN NULL ELSE 'recovery action lease/routing constraints are incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'ri_recovery_active_request_owner_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 1
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'target_urans_request_id'
              AND pg_get_expr(index_row.indpred, index_row.indrelid) =
                '((target_urans_request_id IS NOT NULL) AND (state = ANY (ARRAY[''waiting_for_precalc''::text, ''continuation_routed''::text, ''fresh_rerun_routed''::text])))'
          ) THEN NULL ELSE 'recovery action request-owner fence is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'ri_recovery_active_verify_owner_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 1
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'target_verify_queue_id'
              AND pg_get_expr(index_row.indpred, index_row.indrelid) =
                '((target_verify_queue_id IS NOT NULL) AND (state = ''continuation_routed''::text))'
          ) THEN NULL ELSE 'recovery action verify-owner fence is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretation_recovery_actions_source_fidelity_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretation_recovery_actions')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 3
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'source_archive_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'fidelity'
          ) THEN NULL ELSE 'recovery action source-fidelity uniqueness is incompatible' END,
          CASE WHEN (
            SELECT count(*) = 3
            FROM pg_constraint
            WHERE conrelid = to_regclass('public.legacy_urans_archive_gap_recovery_actions')
              AND conname IN (
                'legacy_urans_archive_gap_recovery_attempt_owner_fk',
                'legacy_urans_archive_gap_recovery_lease_shape_check',
                'legacy_urans_archive_gap_recovery_routed_target_check'
              )
          ) THEN NULL ELSE 'legacy archive-gap ownership or lease constraints are incomplete' END,
          CASE WHEN (
            SELECT count(*) = 2
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.legacy_urans_archive_gap_recovery_actions')
              AND constraint_row.contype = 'f'
              AND (
                (
                  constraint_row.conname = 'legacy_urans_archive_gap_recovery_attempt_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (result_attempt_id, result_id) REFERENCES result_attempts(id, result_id) ON DELETE CASCADE'
                ) OR pg_get_constraintdef(constraint_row.oid) =
                  'FOREIGN KEY (target_urans_request_id) REFERENCES sim_urans_requests(id) ON DELETE RESTRICT'
              )
          ) THEN NULL ELSE 'legacy archive-gap foreign-key ownership is incompatible' END,
          CASE WHEN (
            SELECT count(*) = 2
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.legacy_urans_archive_gap_recovery_actions')
              AND (
                (
                  constraint_row.conname = 'legacy_urans_archive_gap_recovery_lease_shape_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%state = ''routing''::text%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%claim_token IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%claim_expires_at IS NOT NULL%'
                ) OR (
                  constraint_row.conname = 'legacy_urans_archive_gap_recovery_routed_target_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%fresh_rerun_routed%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%target_urans_request_id IS NOT NULL%'
                )
              )
          ) THEN NULL ELSE 'legacy archive-gap lease/routing constraints are incompatible' END,
          CASE WHEN (
            SELECT count(*) = 5
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname IN (
                'legacy_urans_archive_gap_recovery_source_uq',
                'legacy_urans_archive_gap_recovery_ready_idx',
                'legacy_urans_archive_gap_recovery_lease_idx',
                'legacy_urans_archive_gap_recovery_request_idx',
                'legacy_urans_archive_gap_recovery_active_request_uq'
              )
          ) THEN NULL ELSE 'legacy archive-gap indexes are incomplete' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'legacy_urans_archive_gap_recovery_active_request_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.legacy_urans_archive_gap_recovery_actions')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 1
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'target_urans_request_id'
              AND pg_get_expr(index_row.indpred, index_row.indrelid) =
                '((target_urans_request_id IS NOT NULL) AND (state = ''fresh_rerun_routed''::text))'
          ) THEN NULL ELSE 'legacy archive-gap active request fence is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'legacy_urans_archive_gap_recovery_source_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.legacy_urans_archive_gap_recovery_actions')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 1
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
          ) THEN NULL ELSE 'legacy archive-gap source uniqueness is incompatible' END,
          CASE WHEN (
            SELECT count(*) = 4 FROM pg_indexes
            WHERE schemaname = 'public' AND indexname IN (
              'result_archive_reduction_queue_identity_uq',
              'result_archive_reduction_queue_ready_idx',
              'result_archive_reduction_queue_lease_idx',
              'result_archive_reduction_queue_result_idx'
            )
          ) THEN NULL ELSE 'archive-reduction queue indexes are incomplete' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_archive_reduction_queue_identity_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_archive_reduction_queue')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 3
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'source_archive_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'reducer_version_id'
          ) THEN NULL ELSE 'archive-reduction queue identity fence is incompatible' END,
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
            SELECT count(*) = 3
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_archive_reduction_queue')
              AND constraint_row.contype = 'f'
              AND (
                (
                  constraint_row.conname = 'result_archive_reduction_queue_attempt_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (result_attempt_id, result_id) REFERENCES result_attempts(id, result_id) ON DELETE CASCADE'
                ) OR (
                  constraint_row.conname = 'result_archive_reduction_queue_archive_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (source_archive_id, result_attempt_id) REFERENCES solver_evidence_archives(id, result_attempt_id) ON DELETE RESTRICT'
                ) OR (
                  constraint_row.conname = 'result_archive_reduction_queue_interpretation_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (result_interpretation_id, result_attempt_id, result_id) REFERENCES result_interpretations(id, result_attempt_id, result_id) ON DELETE RESTRICT'
                )
              )
          ) THEN NULL ELSE 'archive-reduction queue foreign-key ownership is incompatible' END,
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
          CASE WHEN (
            SELECT count(*) = 4
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_archive_reduction_queue')
              AND (
                (
                  constraint_row.conname = 'result_archive_reduction_queue_state_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%hydrating%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%continuation_required%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%terminal_failure%'
                ) OR (
                  constraint_row.conname = 'result_archive_reduction_queue_attempt_count_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%attempt_count >= 0%'
                ) OR (
                  constraint_row.conname = 'result_archive_reduction_queue_lease_shape_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%state = ''hydrating''::text%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%claim_token IS NOT NULL%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%claim_expires_at IS NOT NULL%'
                ) OR (
                  constraint_row.conname = 'result_archive_reduction_queue_reduced_shape_check'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%state <> ''reduced''::text%'
                  AND pg_get_constraintdef(constraint_row.oid) LIKE '%result_interpretation_id IS NOT NULL%'
                )
              )
          ) THEN NULL ELSE 'archive-reduction queue lifecycle checks are incompatible' END,
          CASE WHEN to_regclass('public.result_interpretations_attempt_reducer_evidence_uq') IS NULL
            THEN NULL ELSE 'deprecated global interpretation uniqueness index remains' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_interpretations')
              AND constraint_row.conname = 'result_interpretations_archive_owner_fk'
              AND pg_get_constraintdef(constraint_row.oid) =
                'FOREIGN KEY (source_archive_id, result_attempt_id) REFERENCES solver_evidence_archives(id, result_attempt_id) ON DELETE RESTRICT'
          ) THEN NULL ELSE 'interpretation archive ownership is incompatible' END,
          CASE WHEN journal.journal_state IN (
            'postledger_0102', 'postledger_0103', 'postledger_0104',
            'postledger_0105', 'postledger_0106', 'postledger_0107',
            'postledger_0108', 'postledger_0109', 'postledger_0110',
            'postledger_0116', 'postledger_0118', 'postledger_0119',
            'postledger_0120', 'postledger_0121'
          )
            OR EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_interpretations')
              AND constraint_row.conname = 'result_interpretations_source_check'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%engine_reported%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%archive_backfill%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%continuation%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%corrective_generation%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%input_evidence_signature%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%source_archive_id IS NOT NULL%'
          ) THEN NULL ELSE 'interpretation source provenance check is incompatible' END,
          CASE WHEN journal.journal_state IN (
            'postledger_0102', 'postledger_0103', 'postledger_0104',
            'postledger_0105', 'postledger_0106', 'postledger_0107',
            'postledger_0108', 'postledger_0109', 'postledger_0110',
            'postledger_0116', 'postledger_0118', 'postledger_0119',
            'postledger_0120', 'postledger_0121'
          )
            OR (
            (
              EXISTS (
                SELECT 1
                FROM pg_index index_row
                JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
                WHERE index_class.relname = 'result_interpretations_archive_attempt_reducer_src_evidence_uq'
                  AND index_class.relnamespace = 'public'::regnamespace
                  AND index_row.indrelid = to_regclass('public.result_interpretations')
                  AND index_row.indisunique
                  AND index_row.indnkeyatts = 4
                  AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
                  AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
                  AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
                  AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
                  AND pg_get_expr(index_row.indpred, index_row.indrelid)
                    = '(source = ''archive_backfill''::text)'
              )
              AND to_regclass('public.result_interpretations_archive_attempt_reducer_source_evidence_') IS NULL
            ) OR (
              EXISTS (
                SELECT 1
                FROM pg_index index_row
                JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
                WHERE index_class.relname = 'result_interpretations_archive_attempt_reducer_source_evidence_'
                  AND index_class.relnamespace = 'public'::regnamespace
                  AND index_row.indrelid = to_regclass('public.result_interpretations')
                  AND index_row.indisunique
                  AND index_row.indnkeyatts = 4
                  AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
                  AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
                  AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
                  AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
                  AND pg_get_expr(index_row.indpred, index_row.indrelid)
                    = '(source = ''archive_backfill''::text)'
              )
              AND to_regclass('public.result_interpretations_archive_attempt_reducer_src_evidence_uq') IS NULL
            )
          ) AND EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretations')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 3
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'input_evidence_signature'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '(source <> ''archive_backfill''::text)'
          ) THEN NULL ELSE 'source-scoped interpretation uniqueness topology is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'sim_campaign_progress'
              AND column_name = 'awaiting_archive_reduction'
              AND is_nullable = 'NO'
              AND column_default = '0'
          ) THEN NULL ELSE 'campaign awaiting-archive column/default is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = to_regclass('public.sim_campaign_progress')
              AND conname = 'sim_campaign_progress_remediation_nonnegative_check'
              AND pg_get_constraintdef(oid) LIKE '%awaiting_archive_reduction >= 0%'
          ) THEN NULL ELSE 'campaign awaiting-archive nonnegative check is incompatible' END
        ], NULL)::text[] AS postledger_0099_issues
      FROM inspection, journal
    ), final_fingerprint AS (
      SELECT
        fingerprint.*,
        fingerprint.postledger_0099_issues || ARRAY_REMOVE(ARRAY[
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretations_archive_attempt_reducer_src_evidence_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretations')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 4
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
              AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '(source = ''archive_backfill''::text)'
          )
          AND to_regclass('public.result_interpretations_archive_attempt_reducer_source_evidence_') IS NULL
          THEN NULL ELSE '0100 archive interpretation source identity is incompatible' END,
          CASE WHEN fingerprint.journal_state <> 'postledger_0100'
            OR (
              to_regclass('public.historical_archive_audit_decisions') IS NULL
              AND to_regclass('public.historical_archive_audit_decisions_identity_uq') IS NULL
            )
          THEN NULL ELSE '0101 historical audit marker exists before its journal entry' END
        ], NULL)::text[] AS postledger_0100_issues
      FROM fingerprint
    ), audit_fingerprint AS (
      SELECT
        final_fingerprint.*,
        final_fingerprint.postledger_0100_issues || ARRAY_REMOVE(ARRAY[
          CASE WHEN to_regclass('public.historical_archive_audit_decisions') IS NOT NULL
            THEN NULL ELSE '0101 historical archive audit decision table is missing' END,
          CASE WHEN (
            SELECT COALESCE(
              array_agg(column_name::text ORDER BY ordinal_position),
              ARRAY[]::text[]
            )
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'historical_archive_audit_decisions'
          ) = ARRAY[
            'id', 'audit_run_id', 'result_id', 'result_attempt_id',
            'source_archive_id', 'reducer_version_id', 'input_evidence_signature',
            'reducer_state', 'result_interpretation_id',
            'advisory_continuation_action', 'advisory_tail_periods',
            'diagnostics', 'createdAt'
          ]::text[]
            THEN NULL ELSE '0101 historical archive audit decision columns are incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'historical_archive_audit_decisions'
              AND column_name = 'result_interpretation_id'
              AND is_nullable = 'YES'
          ) THEN NULL ELSE '0101 historical audit interpretation pointer must be optional' END,
          CASE WHEN NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'historical_archive_audit_decisions'
              AND column_name IN ('target_urans_request_id', 'target_verify_queue_id')
          ) AND NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.historical_archive_audit_decisions')
              AND constraint_row.contype = 'f'
              AND constraint_row.confrelid = ANY(ARRAY[
                to_regclass('public.sim_urans_requests'),
                to_regclass('public.sim_urans_verify_queue')
              ])
          ) THEN NULL ELSE '0101 historical audit must not carry scheduler targets' END,
          CASE WHEN (
            SELECT count(*)
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.historical_archive_audit_decisions')
              AND constraint_row.contype = 'f'
              AND (
                (
                  constraint_row.conname = 'historical_archive_audit_decisions_attempt_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (result_attempt_id, result_id) REFERENCES result_attempts(id, result_id) ON DELETE CASCADE'
                ) OR (
                  constraint_row.conname = 'historical_archive_audit_decisions_archive_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (source_archive_id, result_attempt_id) REFERENCES solver_evidence_archives(id, result_attempt_id) ON DELETE RESTRICT'
                ) OR (
                  constraint_row.conname = 'historical_archive_audit_decisions_interpretation_owner_fk'
                  AND pg_get_constraintdef(constraint_row.oid) =
                    'FOREIGN KEY (result_interpretation_id, result_attempt_id, result_id) REFERENCES result_interpretations(id, result_attempt_id, result_id) ON DELETE RESTRICT'
                ) OR pg_get_constraintdef(constraint_row.oid) =
                  'FOREIGN KEY (audit_run_id) REFERENCES result_interpretation_backfill_runs(id) ON DELETE RESTRICT'
                OR pg_get_constraintdef(constraint_row.oid) =
                  'FOREIGN KEY (result_id) REFERENCES results(id) ON DELETE CASCADE'
                OR pg_get_constraintdef(constraint_row.oid) =
                  'FOREIGN KEY (reducer_version_id) REFERENCES result_reducer_versions(id) ON DELETE RESTRICT'
              )
          ) = 6 AND (
            SELECT count(*)
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.historical_archive_audit_decisions')
              AND constraint_row.contype = 'f'
          ) = 6
            THEN NULL ELSE '0101 historical audit ownership foreign keys are incompatible' END,
          CASE WHEN (
            SELECT count(*)
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.historical_archive_audit_decisions')
              AND constraint_row.conname IN (
                'historical_archive_audit_decisions_signature_check',
                'historical_archive_audit_decisions_reducer_state_check',
                'historical_archive_audit_decisions_advisory_shape_check',
                'historical_archive_audit_decisions_diagnostics_shape_check'
              )
          ) = 4 THEN NULL ELSE '0101 historical audit constraints are incomplete' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'historical_archive_audit_decisions_identity_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.historical_archive_audit_decisions')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 4
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'source_archive_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'reducer_version_id'
              AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
              AND pg_get_expr(index_row.indpred, index_row.indrelid) IS NULL
          ) THEN NULL ELSE '0101 historical audit idempotence identity is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_trigger trigger_row
            WHERE trigger_row.tgrelid = to_regclass('public.historical_archive_audit_decisions')
              AND trigger_row.tgname = 'historical_archive_audit_decisions_append_only'
              AND NOT trigger_row.tgisinternal
              AND pg_get_triggerdef(trigger_row.oid) LIKE
                '%EXECUTE FUNCTION reject_result_interpretation_ledger_mutation()%'
          ) THEN NULL ELSE '0101 historical audit append-only trigger is missing' END
        ], NULL)::text[] AS postledger_0101_issues
      FROM final_fingerprint
    ), provenance_upgrade_fingerprint AS (
      SELECT
        audit_fingerprint.*,
        audit_fingerprint.postledger_0101_issues || ARRAY_REMOVE(ARRAY[
          CASE WHEN audit_fingerprint.journal_state <> 'postledger_0101'
            OR (
              to_regclass('public.ri_historical_archive_attempt_reducer_source_evidence_uq') IS NULL
              AND to_regprocedure('public.validate_historical_archive_audit_decision_insert()') IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM pg_trigger trigger_row
                WHERE trigger_row.tgrelid = to_regclass('public.historical_archive_audit_decisions')
                  AND trigger_row.tgname = 'historical_archive_audit_decisions_validate_insert'
                  AND NOT trigger_row.tgisinternal
              )
            )
          THEN NULL ELSE '0102 historical audit provenance marker exists before its journal entry' END
        ], NULL)::text[] AS postledger_0101_issues_upgrade
      FROM audit_fingerprint
    ), provenance_fingerprint AS (
      SELECT
        provenance_upgrade_fingerprint.*,
        provenance_upgrade_fingerprint.postledger_0101_issues_upgrade || ARRAY_REMOVE(ARRAY[
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_interpretations')
              AND constraint_row.conname = 'result_interpretations_source_check'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%engine_reported%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%archive_backfill%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%historical_archive_audit%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%continuation%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%corrective_generation%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%input_evidence_signature%'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%source_archive_id IS NOT NULL%'
          ) THEN NULL ELSE '0102 historical audit interpretation source provenance check is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretations_archive_attempt_reducer_src_evidence_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretations')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 4
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
              AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '(source = ''archive_backfill''::text)'
          ) THEN NULL ELSE '0102 publication archive interpretation identity is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'ri_historical_archive_attempt_reducer_source_evidence_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretations')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 4
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
              AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '(source = ''historical_archive_audit''::text)'
          ) THEN NULL ELSE '0102 historical audit interpretation identity is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
            WHERE index_class.relname = 'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
              AND index_class.relnamespace = 'public'::regnamespace
              AND index_row.indrelid = to_regclass('public.result_interpretations')
              AND index_row.indisunique
              AND index_row.indnkeyatts = 3
              AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
              AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
              AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'input_evidence_signature'
              AND pg_get_expr(index_row.indpred, index_row.indrelid)
                = '((source <> ''archive_backfill''::text) AND (source <> ''historical_archive_audit''::text))'
          ) THEN NULL ELSE '0102 nonarchive interpretation identity must exclude both archive sources' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass('public.result_archive_reduction_queue')
              AND constraint_row.conname = 'result_archive_reduction_queue_state_check'
              AND pg_get_constraintdef(constraint_row.oid) LIKE '%historical_audit_required%'
          ) THEN NULL ELSE '0102 historical audit queue hold state is missing' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_proc procedure_row
            WHERE procedure_row.oid = to_regprocedure(
              'public.validate_historical_archive_audit_decision_insert()'
            )
              AND pg_get_functiondef(procedure_row.oid) LIKE '%archive-clean-cycle-historical-released-audit-v1%'
              AND pg_get_functiondef(procedure_row.oid) LIKE '%canonicalSelection%'
              AND pg_get_functiondef(procedure_row.oid) LIKE '%physicalRecovery%'
              AND pg_get_functiondef(procedure_row.oid) LIKE '%campaignMutation%'
              AND pg_get_functiondef(procedure_row.oid) LIKE '%interpretation."source" = ''historical_archive_audit''%'
          ) THEN NULL ELSE '0102 historical audit decision provenance validator is incompatible' END,
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_trigger trigger_row
            WHERE trigger_row.tgrelid = to_regclass('public.historical_archive_audit_decisions')
              AND trigger_row.tgname = 'historical_archive_audit_decisions_validate_insert'
              AND NOT trigger_row.tgisinternal
              AND pg_get_triggerdef(trigger_row.oid) LIKE
                '%EXECUTE FUNCTION validate_historical_archive_audit_decision_insert()%'
          ) THEN NULL ELSE '0102 historical audit decision provenance trigger is missing' END
        ], NULL)::text[] AS postledger_0102_issues
      FROM provenance_upgrade_fingerprint
    ), hardening_upgrade_fingerprint AS (
      SELECT
        provenance_fingerprint.*,
        provenance_fingerprint.postledger_0102_issues || ARRAY_REMOVE(ARRAY[
          CASE WHEN provenance_fingerprint.journal_state <> 'postledger_0102'
            OR NOT EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_decision_insert()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%requires a released, completed URANS-compatible attempt%'
            )
          THEN NULL ELSE '0103 historical audit decision hardening marker exists before its journal entry' END
        ], NULL)::text[] AS postledger_0102_issues_upgrade
      FROM provenance_fingerprint
    ), hardening_fingerprint AS (
      SELECT
        hardening_upgrade_fingerprint.*,
        hardening_upgrade_fingerprint.postledger_0102_issues_upgrade || ARRAY_REMOVE(ARRAY[
          CASE WHEN EXISTS (
            SELECT 1
            FROM pg_proc procedure_row
            WHERE procedure_row.oid = to_regprocedure(
              'public.validate_historical_archive_audit_decision_insert()'
            )
              -- 0103 turns the audit admission proof into a lock-held
              -- decision fence.  These markers intentionally cover both the
              -- released-source predicates and the strict lock sequence so a
              -- later function replacement cannot quietly restore a racy
              -- joined snapshot check.
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%INTO locked_result%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%INTO locked_attempt%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%INTO locked_archive%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%INTO locked_source_artifact%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%INTO locked_blob%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%INTO locked_audit_run%'
              AND position('INTO locked_result' IN pg_get_functiondef(procedure_row.oid)) > 0
              AND position('INTO locked_attempt' IN pg_get_functiondef(procedure_row.oid))
                > position('INTO locked_result' IN pg_get_functiondef(procedure_row.oid))
              AND position('INTO locked_archive' IN pg_get_functiondef(procedure_row.oid))
                > position('INTO locked_attempt' IN pg_get_functiondef(procedure_row.oid))
              AND position('INTO locked_source_artifact' IN pg_get_functiondef(procedure_row.oid))
                > position('INTO locked_archive' IN pg_get_functiondef(procedure_row.oid))
              AND position('INTO locked_blob' IN pg_get_functiondef(procedure_row.oid))
                > position('INTO locked_source_artifact' IN pg_get_functiondef(procedure_row.oid))
              AND position('INTO locked_audit_run' IN pg_get_functiondef(procedure_row.oid))
                > position('INTO locked_blob' IN pg_get_functiondef(procedure_row.oid))
              AND pg_get_functiondef(procedure_row.oid) LIKE '%FOR UPDATE NOWAIT%'
              AND pg_get_functiondef(procedure_row.oid) LIKE '%WHEN lock_not_available%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_result."current_result_attempt_id" IS NOT NULL%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_result."current_result_interpretation_id" IS NOT NULL%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_result."current_canonical_selection_id" IS NOT NULL%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_result."status" IS DISTINCT FROM ''done''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_result."source" IS DISTINCT FROM ''solved''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_attempt."status" IS DISTINCT FROM ''done''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_attempt."source" IS DISTINCT FROM ''solved''%'
              -- These predicates intentionally prove the NULL-safe wrappers,
              -- not only the inner field names.  A bare SQL comparison can
              -- return NULL and bypass an OR-based admission rejection.
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%NOT COALESCE((%locked_attempt."regime" = ''urans''%locked_attempt."unsteady" IS FALSE%), false)%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_attempt."regime" = ''urans''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_attempt."unsteady" IS FALSE%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%NOT COALESCE(%locked_attempt."evidence_payload" ->> ''fidelity''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%IN (''urans_precalc'', ''urans_full'')%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_attempt."evidence_payload" ->> ''fidelity''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_archive."state" IS DISTINCT FROM ''current''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_source_artifact."kind" IN (''engine_bundle'', ''openfoam_bundle'')%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."backend" IS DISTINCT FROM ''gcs''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%btrim(COALESCE(locked_blob."bucket", '''')) = ''''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%btrim(locked_blob."bucket") <> locked_blob."bucket"%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%btrim(COALESCE(locked_blob."object_key", '''')) = ''''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%btrim(locked_blob."object_key") <> locked_blob."object_key"%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."object_key" LIKE ''/%''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."object_key" ~ ''(^|/)[.]{1,2}(/|$)''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%position(%locked_blob."object_key") <> 0%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%NOT COALESCE(%locked_blob."generation" ~ ''^[1-9][0-9]{0,19}$'', false%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."generation" ~ ''^[1-9][0-9]{0,19}$''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."compression" IS DISTINCT FROM ''zstd''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."mime_type" IS DISTINCT FROM ''application/zstd''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%NOT COALESCE(locked_blob."sha256" ~ ''^[0-9a-f]{64}$'', false)%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."sha256" ~ ''^[0-9a-f]{64}$''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%COALESCE(locked_blob."byte_size", 0) <= 0%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%NOT COALESCE(locked_blob."crc32c" ~ ''^[A-Za-z0-9+/]{6}==$'', false)%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."crc32c" ~ ''^[A-Za-z0-9+/]{6}==$''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%NOT COALESCE(%locked_blob."uncompressed_tar_sha256" ~ ''^[0-9a-f]{64}$'', false%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."uncompressed_tar_sha256" ~ ''^[0-9a-f]{64}$''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%COALESCE(locked_blob."uncompressed_tar_byte_size", 0) <= 0%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."verifiedAt" IS NULL%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."metadata" ->> ''archiveFormat''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."metadata" ->> ''archiveFormat'' <> ''tar+zstd''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%jsonb_typeof(locked_blob."metadata" -> ''zstdLevel'') IS DISTINCT FROM ''number''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."metadata" ->> ''zstdLevel''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_blob."metadata" ->> ''zstdLevel''%!~ ''^(?:[1-9]|1[0-9]|2[0-2])$''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" ->> ''contract''%IS DISTINCT FROM ''archive-clean-cycle-historical-released-audit-v1''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" ->> ''canonicalSelection''%IS DISTINCT FROM ''forbidden''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" ->> ''physicalRecovery''%IS DISTINCT FROM ''record-only''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" ->> ''campaignMutation''%IS DISTINCT FROM ''forbidden''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" ->> ''rawEvidenceImmutable''%IS DISTINCT FROM ''true''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" ->> ''rawEvidenceImmutable''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" #>> ''{exactSource,resultId}''%IS DISTINCT FROM NEW."result_id"::text%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" #>> ''{exactSource,resultId}''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" #>> ''{exactSource,resultAttemptId}''%IS DISTINCT FROM NEW."result_attempt_id"::text%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" #>> ''{exactSource,resultAttemptId}''%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" #>> ''{exactSource,sourceArchiveId}''%IS DISTINCT FROM NEW."source_archive_id"::text%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%locked_audit_run."scope" #>> ''{exactSource,sourceArchiveId}''%'
              AND (
                hardening_upgrade_fingerprint.journal_state IN (
                  'postledger_0103', 'postledger_0104', 'postledger_0105'
                )
                OR pg_get_functiondef(procedure_row.oid) LIKE
                  '%missing-evidence decision requires a pointer-free missing-evidence child receipt%'
              )
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%requires a matching historical interpretation%'
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%matching historical % interpretation%'
          ) AND EXISTS (
            SELECT 1
            FROM pg_trigger trigger_row
            WHERE trigger_row.tgrelid = to_regclass('public.historical_archive_audit_decisions')
              AND trigger_row.tgname = 'historical_archive_audit_decisions_validate_insert'
              AND NOT trigger_row.tgisinternal
              AND pg_get_triggerdef(trigger_row.oid) LIKE
                '%EXECUTE FUNCTION validate_historical_archive_audit_decision_insert()%'
          ) THEN NULL ELSE '0103 historical audit decision source/state fence is incompatible' END
        ], NULL)::text[] AS postledger_0103_issues
      FROM hardening_upgrade_fingerprint
    ), canonical_selection_fence_upgrade_fingerprint AS (
      SELECT
        hardening_fingerprint.*,
        hardening_fingerprint.postledger_0103_issues || ARRAY_REMOVE(ARRAY[
          -- validate_result_canonical_selection already exists from 0096,
          -- so function presence is not a 0104 marker. Require both new
          -- source-specific bodies to be absent before accepting an exact
          -- 0103 baseline as upgradeable.
          CASE WHEN hardening_fingerprint.journal_state <> 'postledger_0103'
            OR (
              NOT EXISTS (
                SELECT 1
                FROM pg_proc procedure_row
                WHERE procedure_row.oid = to_regprocedure(
                  'public.validate_result_canonical_selection()'
                )
                  AND pg_get_functiondef(procedure_row.oid) LIKE
                    '%interpretation_source = ''historical_archive_audit''%'
              )
              AND NOT EXISTS (
                SELECT 1
                FROM pg_proc procedure_row
                WHERE procedure_row.oid = to_regprocedure(
                  'public.validate_result_interpretation_projection()'
                )
                  AND pg_get_functiondef(procedure_row.oid) LIKE
                    '%selected_interpretation_source = ''historical_archive_audit''%'
              )
            )
          THEN NULL ELSE '0104 canonical selection fence marker exists before its journal entry' END
        ], NULL)::text[] AS postledger_0103_issues_upgrade
      FROM hardening_fingerprint
    ), canonical_selection_fence_fingerprint AS (
      SELECT
        canonical_selection_fence_upgrade_fingerprint.*,
        canonical_selection_fence_upgrade_fingerprint.postledger_0103_issues_upgrade
          || ARRAY_REMOVE(ARRAY[
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_result_canonical_selection()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%interpretation_source = ''historical_archive_audit''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%canonical selection cannot reference a historical archive audit interpretation%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_result_interpretation_projection()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."current_result_attempt_id" IS NULL%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%selection."result_attempt_id" = NEW."current_result_attempt_id"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%selected_interpretation_source = ''historical_archive_audit''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%result projection cannot reference a historical archive audit interpretation%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass('public.results')
                AND trigger_row.tgname = 'results_validate_interpretation_projection'
                AND NOT trigger_row.tgisinternal
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%EXECUTE FUNCTION validate_result_interpretation_projection()%'
                -- The validator's attempt-ownership proof is meaningful only
                -- if this trigger also fires when a direct writer changes the
                -- current attempt alone.  0096 subscribed only to the other
                -- two pointers, which left that mismatch route unguarded.
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%UPDATE OF current_result_attempt_id, current_result_interpretation_id, current_canonical_selection_id%'
            ) THEN NULL ELSE '0104 canonical selection and projection fence is incompatible' END
          ], NULL)::text[] AS postledger_0104_issues
      FROM canonical_selection_fence_upgrade_fingerprint
    ), audit_run_identity_fence_upgrade_fingerprint AS (
      SELECT
        canonical_selection_fence_fingerprint.*,
        canonical_selection_fence_fingerprint.postledger_0104_issues
          AS postledger_0104_issues_upgrade,
        -- 0105 introduces a function, trigger, and one-outcome index. Any one
        -- of those footprints before the matching journal entry means a prior
        -- interrupted or hand-edited deployment, never an upgradeable older
        -- ledger baseline.
        CASE WHEN canonical_selection_fence_fingerprint.journal_state IN (
          'preledger_0093',
          'postledger_0099',
          'postledger_0100',
          'postledger_0101',
          'postledger_0102',
          'postledger_0103',
          'postledger_0104'
        ) AND (
          EXISTS (
            SELECT 1
            FROM pg_proc procedure_row
            WHERE procedure_row.oid = to_regprocedure(
              'public.validate_historical_archive_audit_run_identity()'
            )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_trigger trigger_row
            WHERE trigger_row.tgrelid = to_regclass(
              'public.result_interpretation_backfill_runs'
            )
              AND trigger_row.tgname =
                'result_interpretation_backfill_runs_validate_historical_audit_identity'
              AND NOT trigger_row.tgisinternal
          )
          OR to_regclass(
            'public.historical_archive_audit_decisions_audit_run_uq'
          ) IS NOT NULL
        ) THEN true ELSE false END AS has_unjournaled_0105_marker
      FROM canonical_selection_fence_fingerprint
    ), audit_run_identity_fence_fingerprint AS (
      SELECT
        audit_run_identity_fence_upgrade_fingerprint.*,
        audit_run_identity_fence_upgrade_fingerprint.postledger_0104_issues_upgrade
          || ARRAY_REMOVE(ARRAY[
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_run_identity()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."scope" ->> ''contract''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ->> ''contract''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" IS DISTINCT FROM OLD."scope"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."reducer_version_id" IS DISTINCT FROM OLD."reducer_version_id"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ->> ''canonicalSelection'' IS DISTINCT FROM ''forbidden''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ->> ''physicalRecovery'' IS DISTINCT FROM ''record-only''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ->> ''campaignMutation'' IS DISTINCT FROM ''forbidden''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%jsonb_typeof(NEW."scope" -> ''rawEvidenceImmutable'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ->> ''rawEvidenceImmutable'' IS DISTINCT FROM ''true''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%jsonb_typeof(NEW."scope" -> ''exactSource'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%jsonb_object_keys(NEW."scope" -> ''exactSource'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%jsonb_typeof(NEW."scope" #> ''{exactSource,resultId}'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%jsonb_typeof(NEW."scope" #> ''{exactSource,resultAttemptId}'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%jsonb_typeof(NEW."scope" #> ''{exactSource,sourceArchiveId}'')%'
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%NEW."scope" #>> ''{exactSource,resultId}'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''%'
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%NEW."scope" #>> ''{exactSource,resultAttemptId}'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''%'
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%NEW."scope" #>> ''{exactSource,sourceArchiveId}'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ? ''resultIds''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ? ''resultAttemptIds''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."scope" ? ''limit''%'
                -- The field-name checks above are not enough: changing either
                -- OR to AND leaves the names in place but permits one-way
                -- retargeting. Normalize whitespace and prove the exact
                -- bidirectional contract and either-identity-change guards.
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%IF TG_OP = ''UPDATE'' AND ( OLD."scope" ->> ''contract'' = ''archive-clean-cycle-historical-released-audit-v1'' OR NEW."scope" ->> ''contract'' = ''archive-clean-cycle-historical-released-audit-v1'' ) AND ( NEW."scope" IS DISTINCT FROM OLD."scope"%'
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%NEW."scope" IS DISTINCT FROM OLD."scope" OR NEW."reducer_version_id" IS DISTINCT FROM OLD."reducer_version_id"%'
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE '%TG_OP = ''UPDATE''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit run identity is immutable%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit run requires its exact no-publication authority contract%'
                -- An immutable scope alone is insufficient: a direct writer
                -- could revive a stopped audit and lease its pending child.
                -- Require the narrowly permitted transition graph, including
                -- the completed -> failed source-owner forensic correction.
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."state" IN (''failed'', ''cancelled'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."state" = ''completed'' AND NEW."state" <> ''failed''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."state" = ''planned''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."state" NOT IN (''running'', ''failed'', ''cancelled'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."state" = ''running''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."state" NOT IN (''completed'', ''failed'', ''cancelled'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit run is terminal and cannot be resumed%'
                -- The UPDATE identity branch below also mentions the audit
                -- literal. Prove that a NEW-side INSERT authority gate exists
                -- before the no-publication predicates, otherwise a rewritten
                -- An IF-false branch could accept a malformed first receipt
                -- while still freezing later updates correctly.
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%IF NEW."scope" ->> ''contract'' = ''archive-clean-cycle-historical-released-audit-v1'' AND ( NEW."scope" ->> ''canonicalSelection'' IS DISTINCT FROM ''forbidden''%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_runs'
              )
                AND trigger_row.tgname =
                  'result_interpretation_backfill_runs_validate_historical_audit_identity'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_run_identity()'
                )
                -- A WHEN (false) trigger has the expected name and function
                -- but never invokes the fence. A statement-level trigger
                -- likewise has no OLD/NEW row for this validator.
                AND trigger_row.tgqual IS NULL
                AND (trigger_row.tgtype::integer & 1) = 1
                -- pg_get_triggerdef may schema-qualify the target relation.
                -- tgrelid above proves the exact table, so match the complete
                -- insert/update timing without depending on deparser
                -- qualification style.
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%BEFORE INSERT OR UPDATE ON%'
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%FOR EACH ROW EXECUTE FUNCTION validate_historical_archive_audit_run_identity()%'
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%EXECUTE FUNCTION validate_historical_archive_audit_run_identity()%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_index index_row
              JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
              WHERE index_class.relname =
                  'historical_archive_audit_decisions_audit_run_uq'
                AND index_class.relnamespace = 'public'::regnamespace
                AND index_row.indrelid = to_regclass(
                  'public.historical_archive_audit_decisions'
                )
                AND index_row.indisunique
                AND index_row.indisvalid
                AND index_row.indisready
                AND index_row.indislive
                AND index_row.indnkeyatts = 1
                AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'audit_run_id'
                AND index_row.indpred IS NULL
            ) THEN NULL ELSE '0105 historical audit run identity fence is incompatible' END
          ], NULL)::text[] AS postledger_0105_issues
      FROM audit_run_identity_fence_upgrade_fingerprint
    ), audit_child_receipt_fence_upgrade_fingerprint AS (
      SELECT
        audit_run_identity_fence_fingerprint.*,
        audit_run_identity_fence_fingerprint.postledger_0105_issues
          AS postledger_0105_issues_upgrade,
        -- 0106 is intentionally detectable before the journal reaches 0106.
        -- The decision validator existed in 0103, so its marker must include
        -- the new child-receipt proof rather than merely its function name.
        CASE WHEN audit_run_identity_fence_fingerprint.journal_state IN (
          'preledger_0093',
          'postledger_0099',
          'postledger_0100',
          'postledger_0101',
          'postledger_0102',
          'postledger_0103',
          'postledger_0104',
          'postledger_0105'
        ) AND (
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'result_interpretation_backfill_items'
              AND column_name IN (
                'historical_audit_decision_id',
                'historical_audit_reducer_state',
                'historical_audit_input_evidence_signature'
              )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_constraint constraint_row
            WHERE constraint_row.conrelid = to_regclass(
              'public.result_interpretation_backfill_items'
            )
              AND constraint_row.conname IN (
                'ri_bf_item_audit_receipt_shape_ck',
                'ri_bf_item_audit_decision_fk'
              )
          )
          OR to_regclass(
            'public.ri_bf_item_audit_decision_uq'
          ) IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM pg_proc procedure_row
            WHERE procedure_row.oid IN (
              to_regprocedure(
                'public.validate_historical_archive_audit_item_admission()'
              ),
              to_regprocedure(
                'public.validate_historical_archive_audit_item_receipt_identity()'
              ),
              to_regprocedure(
                'public.validate_historical_archive_audit_item_lifecycle()'
              ),
              to_regprocedure(
                'public.validate_historical_archive_audit_decision_child_pair()'
              ),
              to_regprocedure(
                'public.validate_historical_archive_audit_run_child_shape()'
              ),
              to_regprocedure(
                'public.close_historical_archive_audit_after_owner_cascade()'
              ),
              to_regprocedure(
                'public.close_historical_archive_audit_after_attempt_owner_cascade()'
              )
            )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_trigger trigger_row
            WHERE trigger_row.tgrelid = ANY(ARRAY[
              to_regclass('public.result_interpretation_backfill_items'),
              to_regclass('public.result_attempts'),
              to_regclass('public.result_interpretation_backfill_runs'),
              to_regclass('public.historical_archive_audit_decisions')
            ])
              AND trigger_row.tgname IN (
                'ri_bf_item_audit_admission',
                'ri_bf_item_audit_receipt',
                'ri_bf_item_audit_lifecycle',
                'hist_audit_decision_child_pair',
                'ri_bf_item_audit_decision_pair',
                'ri_bf_run_audit_child_shape',
                'ri_bf_item_audit_parent_shape',
                'ri_bf_item_audit_owner_cascade',
                'result_attempt_audit_owner_cascade'
              )
              AND NOT trigger_row.tgisinternal
          )
          OR EXISTS (
            SELECT 1
            FROM pg_proc procedure_row
            WHERE procedure_row.oid = to_regprocedure(
              'public.validate_historical_archive_audit_decision_insert()'
            )
              AND pg_get_functiondef(procedure_row.oid) LIKE
                '%historical_audit_decision_id%'
          )
        ) THEN true ELSE false END AS has_unjournaled_0106_marker
      FROM audit_run_identity_fence_fingerprint
    ), audit_child_receipt_fence_fingerprint AS (
      SELECT
        audit_child_receipt_fence_upgrade_fingerprint.*,
        audit_child_receipt_fence_upgrade_fingerprint.postledger_0105_issues_upgrade
          || ARRAY_REMOVE(ARRAY[
            CASE WHEN (
              SELECT count(*) = 3
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'result_interpretation_backfill_items'
                AND (
                  (column_name = 'historical_audit_decision_id'
                    AND data_type = 'uuid'
                    AND is_nullable = 'YES'
                    AND column_default IS NULL)
                  OR (column_name = 'historical_audit_reducer_state'
                    AND data_type = 'text'
                    AND is_nullable = 'YES'
                    AND column_default IS NULL)
                  OR (column_name = 'historical_audit_input_evidence_signature'
                    AND data_type = 'text'
                    AND is_nullable = 'YES'
                    AND column_default IS NULL)
                )
            ) THEN NULL ELSE '0106 historical audit child receipt columns are incompatible' END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_constraint constraint_row
              WHERE constraint_row.conrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND constraint_row.conname =
                  'ri_bf_item_audit_receipt_shape_ck'
                AND constraint_row.contype = 'c'
                AND constraint_row.convalidated
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%historical_audit_decision_id IS NULL%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%historical_audit_reducer_state IS NULL%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%historical_audit_input_evidence_signature IS NULL%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%historical_audit_decision_id IS NOT NULL%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%''accepted''%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%''continuation_required''%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%''recovery_exhausted''%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%''rerun_required''%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%''missing_evidence''%'
                AND pg_get_constraintdef(constraint_row.oid) LIKE
                  '%historical_audit_input_evidence_signature ~ ''^[0-9a-f]{64}$''%'
            ) THEN NULL ELSE '0106 historical audit child receipt shape constraint is incompatible' END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_constraint constraint_row
              WHERE constraint_row.conrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND constraint_row.conname =
                  'ri_bf_item_audit_decision_fk'
                AND constraint_row.contype = 'f'
                AND constraint_row.confrelid = to_regclass(
                  'public.historical_archive_audit_decisions'
                )
                AND constraint_row.condeferrable
                AND constraint_row.condeferred
                AND constraint_row.confdeltype = 'a'
                AND constraint_row.conkey = ARRAY[
                  (
                    SELECT attnum
                    FROM pg_attribute
                    WHERE attrelid = to_regclass(
                      'public.result_interpretation_backfill_items'
                    )
                      AND attname = 'historical_audit_decision_id'
                      AND NOT attisdropped
                  )
                ]::smallint[]
                AND constraint_row.confkey = ARRAY[
                  (
                    SELECT attnum
                    FROM pg_attribute
                    WHERE attrelid = to_regclass(
                      'public.historical_archive_audit_decisions'
                    )
                      AND attname = 'id'
                      AND NOT attisdropped
                  )
                ]::smallint[]
            ) THEN NULL ELSE '0106 historical audit child decision foreign key is incompatible' END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_index index_row
              JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
              WHERE index_class.relname =
                  'ri_bf_item_audit_decision_uq'
                AND index_class.relnamespace = 'public'::regnamespace
                AND index_row.indrelid = to_regclass(
                  'public.result_interpretation_backfill_items'
                )
                AND index_row.indisunique
                AND index_row.indisvalid
                AND index_row.indisready
                AND index_row.indislive
                AND index_row.indnkeyatts = 1
                AND pg_get_indexdef(index_row.indexrelid, 1, true) =
                  'historical_audit_decision_id'
                AND pg_get_expr(index_row.indpred, index_row.indrelid) LIKE
                  '%historical_audit_decision_id IS NOT NULL%'
            ) THEN NULL ELSE '0106 historical audit child decision uniqueness fence is incompatible' END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_item_admission()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%FROM "result_interpretation_backfill_runs" audit_run%'
                AND pg_get_functiondef(procedure_row.oid) LIKE '%FOR UPDATE NOWAIT%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child must match its parent run exact source%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit run may own exactly one child execution receipt%'
                -- Moving the sole child out of an old audit run can leave
                -- that immutable run empty. The new-run admission mutex alone
                -- cannot observe it, so require the OLD-parent guard too.
                AND pg_get_functiondef(procedure_row.oid) LIKE '%old_parent_scope%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."run_id" IS DISTINCT FROM NEW."run_id"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child cannot be moved out of its exact audit run%'
                -- A generic queue child may not be repurposed into an audit
                -- receipt either. The audit lifecycle is deliberately born
                -- through one explicit pending INSERT, not a direct run_id
                -- rewrite that happens to share the same source identity.
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child must be inserted directly into its exact audit run%'
                -- The message alone could survive a weakened IF-false
                -- branch. Normalize whitespace and require the reciprocal
                -- NEW-parent audit-contract condition that makes the error
                -- reachable for a direct run_id reparent.
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%IF existing_parent_scope ->> ''contract'' = ''archive-clean-cycle-historical-released-audit-v1'' THEN RAISE EXCEPTION ''historical archive audit child must be inserted directly into its exact audit run'';%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_item_receipt_identity()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical_audit_decision_id%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical_audit_reducer_state%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical_audit_input_evidence_signature%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit scientific terminal state requires its immutable decision receipt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child receipt is immutable after its decision is recorded%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_item_lifecycle()'
              )
                -- A receipt must be created by the audit command first, then
                -- claimed. Without this lifecycle proof a direct writer can
                -- pair a synthetic terminal child with a deferred decision.
                AND pg_get_functiondef(procedure_row.oid) LIKE '%TG_OP = ''INSERT''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."state" IS DISTINCT FROM ''pending''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."attempt_count" <> 0%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child must be inserted as an unclaimed pending receipt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."state" = ''pending''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."state" = ''hydrating''%'
                -- Lease entry, renewal, and reclaim own the child row before
                -- they lock a still-running audit parent. Terminal settlement
                -- deliberately retains the direct-decision child→result→
                -- source→parent order instead.
                AND pg_get_functiondef(procedure_row.oid) LIKE '%parent_state%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."state" IN (''pending'', ''hydrating'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE '%INTO parent_state%'
                AND pg_get_functiondef(procedure_row.oid) LIKE '%FOR UPDATE NOWAIT%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child lease requires a running parent audit run%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."attempt_count" = 1%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."claim_token" IS NOT NULL%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."claim_expires_at" IS NOT NULL%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NEW."claim_expires_at" <= clock_timestamp()%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."claim_expires_at" <= clock_timestamp()%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child must move pending % claimed hydrating before any terminal settlement%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit scientific terminal settlement requires a still-live claimed lease%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child lifecycle is immutable after settlement%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_decision_child_pair()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit decision requires exactly one final child execution receipt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit decision and child execution receipt have incompatible identity or terminal lifecycle%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%child_row."historical_audit_reducer_state"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%child_row."historical_audit_input_evidence_signature"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%decision_row."reducer_state" = ''accepted''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%decision_row."reducer_state" = ''continuation_required''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%decision_row."reducer_state" = ''recovery_exhausted''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%decision_row."reducer_state" = ''rerun_required''%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%decision_row."reducer_state" = ''missing_evidence''%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_run_child_shape()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit run requires exactly one child execution receipt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit child does not match its parent exact source%'
                -- A true owner cascade retains the audit run but removes its
                -- child/decision. Require this narrow zero-child exception;
                -- accepting any arbitrary empty run would hide forged audit
                -- receipts instead of preserving only removed-source history.
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE '%IF child_count = 0 AND NOT EXISTS (%FROM "result_attempts" attempt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%attempt."id"::text%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%attempt."result_id"::text%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%{exactSource,resultId}%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%{exactSource,resultAttemptId}%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%{exactSource,sourceArchiveId}%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.close_historical_archive_audit_after_owner_cascade()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%FROM "result_attempts" attempt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%attempt."id" = OLD."result_attempt_id"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%attempt."result_id" = OLD."result_id"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%audit_run."state" IN (''planned'', ''running'', ''completed'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historicalAuditIncompleteReason%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical audit exact source owner was removed before its child execution could complete%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.close_historical_archive_audit_after_attempt_owner_cascade()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."result_id"::text%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%OLD."id"::text%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%audit_run."state" IN (''planned'', ''running'', ''completed'')%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%NOT EXISTS (%FROM "result_interpretation_backfill_items" child%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historicalAuditIncompleteReason%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical audit exact source owner was removed before its child execution could complete%'
            ) THEN NULL ELSE '0106 historical audit child receipt validator functions are incompatible' END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_proc procedure_row
              WHERE procedure_row.oid = to_regprocedure(
                'public.validate_historical_archive_audit_decision_insert()'
              )
                AND pg_get_functiondef(procedure_row.oid) LIKE '%INTO locked_child%'
                AND position('INTO locked_child' IN pg_get_functiondef(procedure_row.oid)) > 0
                AND position('INTO locked_result' IN pg_get_functiondef(procedure_row.oid))
                  > position('INTO locked_child' IN pg_get_functiondef(procedure_row.oid))
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%child."historical_audit_decision_id" = NEW."id"%'
                AND regexp_replace(
                  pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g'
                ) LIKE
                  '%INTO locked_child FROM "result_interpretation_backfill_items" child WHERE child."historical_audit_decision_id" = NEW."id" FOR UPDATE NOWAIT%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%locked_child."historical_audit_reducer_state" IS DISTINCT FROM NEW."reducer_state"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%locked_child."historical_audit_input_evidence_signature"%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit decision requires one exact terminal child execution receipt%'
                AND pg_get_functiondef(procedure_row.oid) LIKE
                  '%historical archive audit decision interpretation must match its terminal child receipt%'
            ) THEN NULL ELSE '0106 historical audit decision child-first validator is incompatible' END,
            CASE WHEN EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND trigger_row.tgname =
                  'ri_bf_item_audit_admission'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_item_admission()'
                )
                AND trigger_row.tgqual IS NULL
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 2
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 0
                AND (trigger_row.tgtype::integer & 16) = 16
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%BEFORE INSERT OR UPDATE OF run_id, result_id, result_attempt_id, source_archive_id ON%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND trigger_row.tgname =
                  'ri_bf_item_audit_receipt'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_item_receipt_identity()'
                )
                AND trigger_row.tgqual IS NULL
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 2
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 0
                AND (trigger_row.tgtype::integer & 16) = 16
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%BEFORE INSERT OR UPDATE ON%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND trigger_row.tgname =
                  'ri_bf_item_audit_lifecycle'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_item_lifecycle()'
                )
                AND trigger_row.tgqual IS NULL
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 2
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 0
                AND (trigger_row.tgtype::integer & 16) = 16
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%BEFORE INSERT OR UPDATE ON%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.historical_archive_audit_decisions'
              )
                AND trigger_row.tgname =
                  'hist_audit_decision_child_pair'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_decision_child_pair()'
                )
                AND trigger_row.tgqual IS NULL
                AND trigger_row.tgdeferrable
                AND trigger_row.tginitdeferred
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 0
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 0
                AND (trigger_row.tgtype::integer & 16) = 0
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND trigger_row.tgname =
                  'ri_bf_item_audit_decision_pair'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_decision_child_pair()'
                )
                AND trigger_row.tgqual IS NULL
                AND trigger_row.tgdeferrable
                AND trigger_row.tginitdeferred
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 0
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 8
                AND (trigger_row.tgtype::integer & 16) = 16
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_runs'
              )
                AND trigger_row.tgname =
                  'ri_bf_run_audit_child_shape'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_run_child_shape()'
                )
                AND trigger_row.tgqual IS NULL
                AND trigger_row.tgdeferrable
                AND trigger_row.tginitdeferred
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 0
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 0
                AND (trigger_row.tgtype::integer & 16) = 16
                AND pg_get_triggerdef(trigger_row.oid) LIKE
                  '%AFTER INSERT OR UPDATE OF scope ON%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND trigger_row.tgname =
                  'ri_bf_item_audit_parent_shape'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.validate_historical_archive_audit_run_child_shape()'
                )
                AND trigger_row.tgqual IS NULL
                AND trigger_row.tgdeferrable
                AND trigger_row.tginitdeferred
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 0
                AND (trigger_row.tgtype::integer & 4) = 4
                AND (trigger_row.tgtype::integer & 8) = 8
                AND (trigger_row.tgtype::integer & 16) = 16
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass(
                'public.result_interpretation_backfill_items'
              )
                AND trigger_row.tgname =
                  'ri_bf_item_audit_owner_cascade'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.close_historical_archive_audit_after_owner_cascade()'
                )
                AND trigger_row.tgqual IS NULL
                AND NOT trigger_row.tgdeferrable
                AND NOT trigger_row.tginitdeferred
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 0
                AND (trigger_row.tgtype::integer & 4) = 0
                AND (trigger_row.tgtype::integer & 8) = 8
                AND (trigger_row.tgtype::integer & 16) = 0
                AND pg_get_triggerdef(trigger_row.oid) LIKE '%AFTER DELETE ON%'
            ) AND EXISTS (
              SELECT 1
              FROM pg_trigger trigger_row
              WHERE trigger_row.tgrelid = to_regclass('public.result_attempts')
                AND trigger_row.tgname =
                  'result_attempt_audit_owner_cascade'
                AND NOT trigger_row.tgisinternal
                AND trigger_row.tgenabled = 'O'
                AND trigger_row.tgfoid = to_regprocedure(
                  'public.close_historical_archive_audit_after_attempt_owner_cascade()'
                )
                AND trigger_row.tgqual IS NULL
                AND NOT trigger_row.tgdeferrable
                AND NOT trigger_row.tginitdeferred
                AND (trigger_row.tgtype::integer & 1) = 1
                AND (trigger_row.tgtype::integer & 2) = 0
                AND (trigger_row.tgtype::integer & 4) = 0
                AND (trigger_row.tgtype::integer & 8) = 8
                AND (trigger_row.tgtype::integer & 16) = 0
                AND pg_get_triggerdef(trigger_row.oid) LIKE '%AFTER DELETE ON%'
            ) THEN NULL ELSE '0106 historical audit child receipt triggers are incompatible' END
          ], NULL)::text[] AS postledger_0106_issues
      FROM audit_child_receipt_fence_upgrade_fingerprint
    )
    SELECT
      application_anchors_present,
      footprint_present,
      post_0093_markers_present
        OR has_unjournaled_0105_marker
        OR has_unjournaled_0106_marker
        AS post_0093_markers_present,
      journal_state,
      COALESCE(preledger_0093_issues, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS preledger_0093_issues,
      COALESCE(postledger_0099_issues, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0099_issues,
      COALESCE(postledger_0100_issues, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0100_issues,
      COALESCE(postledger_0101_issues_upgrade, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0101_issues,
      COALESCE(postledger_0102_issues_upgrade, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0102_issues,
      COALESCE(postledger_0103_issues_upgrade, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0103_issues,
      COALESCE(postledger_0104_issues_upgrade, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0105_marker
            THEN '0105 historical audit run identity fence marker exists before its journal entry'
          END,
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0104_issues,
      COALESCE(postledger_0105_issues_upgrade, ARRAY[]::text[])
        || ARRAY_REMOVE(ARRAY[
          CASE WHEN has_unjournaled_0106_marker
            THEN '0106 historical audit child receipt fence marker exists before its journal entry'
          END
        ], NULL)::text[] AS postledger_0105_issues,
      postledger_0106_issues
    FROM audit_child_receipt_fence_fingerprint
  `)) as unknown as Array<{
    application_anchors_present: boolean;
    footprint_present: boolean;
    post_0093_markers_present: boolean;
    journal_state: ResultInterpretationLedgerPreflightFacts["journalState"];
    preledger_0093_issues: string[] | null;
    postledger_0099_issues: string[] | null;
    postledger_0100_issues: string[] | null;
    postledger_0101_issues: string[] | null;
    postledger_0102_issues: string[] | null;
    postledger_0103_issues: string[] | null;
    postledger_0104_issues: string[] | null;
    postledger_0105_issues: string[] | null;
    postledger_0106_issues: string[] | null;
  }>;
  const row = rows[0];
  if (!row) {
    throw new Error(
      "could not inspect result-interpretation ledger migration preflight",
    );
  }

  const postledger0116Issues =
    row.journal_state === "postledger_0116" ||
    row.journal_state === "postledger_0118" ||
    row.journal_state === "postledger_0119" ||
    row.journal_state === "postledger_0120"
      ? await readPostledger0116FootprintIssues(db)
      : [];
  const postledger0118Issues =
    row.journal_state === "postledger_0118" ||
    row.journal_state === "postledger_0119" ||
    row.journal_state === "postledger_0120"
      ? await readPostledger0118FootprintIssues(db)
      : [];
  const postledger0120Issues =
    (row.journal_state === "postledger_0120" ||
      row.journal_state === "postledger_0121")
      ? await readPostledger0120ReconciliationIssues(db)
      : [];
  const postledger0121Issues =
    row.journal_state === "postledger_0121"
      ? await readPostledger0121RemovalIssues(db)
      : [];

  // The main fingerprint must be able to run against a fresh database, so it
  // cannot mention application relations directly. Once an exact 0103–0106
  // journal proves those relations should exist, inspect the live projection
  // separately. This mirrors 0104's migration-time admission check and keeps
  // an old direct-SQL audit projection from being grandfathered into public
  // reads just because the new trigger only governs future writes.
  const shouldInspectHistoricalAuditProjection =
    row.journal_state === "postledger_0103" ||
    row.journal_state === "postledger_0104" ||
    row.journal_state === "postledger_0105" ||
    row.journal_state === "postledger_0106" ||
    row.journal_state === "postledger_0107" ||
    row.journal_state === "postledger_0108" ||
    row.journal_state === "postledger_0109" ||
    row.journal_state === "postledger_0110" ||
    row.journal_state === "postledger_0116" ||
    row.journal_state === "postledger_0118" ||
    row.journal_state === "postledger_0119" ||
    row.journal_state === "postledger_0120" ||
    row.journal_state === "postledger_0121";
  let historicalAuditCurrentProjection = false;
  if (shouldInspectHistoricalAuditProjection) {
    const projectionTables = (await db.execute(sql`
      SELECT
        to_regclass('public.results') IS NOT NULL AS results_present,
        to_regclass('public.result_canonical_selections') IS NOT NULL
          AS canonical_selections_present,
        to_regclass('public.result_interpretations') IS NOT NULL
          AS interpretations_present
    `)) as unknown as Array<{
      results_present: boolean;
      canonical_selections_present: boolean;
      interpretations_present: boolean;
    }>;
    const projectionTablesPresent =
      projectionTables[0]?.results_present === true &&
      projectionTables[0]?.canonical_selections_present === true &&
      projectionTables[0]?.interpretations_present === true;

    if (projectionTablesPresent) {
      const currentProjection = (await db.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM "results" result
          JOIN "result_canonical_selections" selection
            ON selection."id" = result."current_canonical_selection_id"
           AND selection."result_id" = result."id"
          JOIN "result_interpretations" interpretation
            ON interpretation."id" = selection."result_interpretation_id"
           AND interpretation."result_id" = selection."result_id"
           AND interpretation."result_attempt_id" = selection."result_attempt_id"
          WHERE interpretation."source" = 'historical_archive_audit'
        ) AS present
      `)) as unknown as Array<{ present: boolean }>;
      historicalAuditCurrentProjection = currentProjection[0]?.present === true;
    }
  }

  // 0105 freezes the audit run's exact source, reducer, and non-publication
  // authority contract. A trigger protects future writes, but a prior direct
  // writer could have disabled it, changed a run, and re-enabled it. Read the
  // immutable decision/run join and one-decision cardinality as well so a
  // structurally healthy fence never grandfathers bad provenance.
  const shouldInspectHistoricalAuditRunIdentity =
    row.journal_state === "postledger_0104" ||
    row.journal_state === "postledger_0105" ||
    row.journal_state === "postledger_0106" ||
    row.journal_state === "postledger_0107" ||
    row.journal_state === "postledger_0108" ||
    row.journal_state === "postledger_0109" ||
    row.journal_state === "postledger_0110" ||
    row.journal_state === "postledger_0116" ||
    row.journal_state === "postledger_0118" ||
    row.journal_state === "postledger_0119" ||
    row.journal_state === "postledger_0120" ||
    row.journal_state === "postledger_0121";
  let historicalAuditRunIdentityMismatch = false;
  let historicalAuditRunCardinalityMismatch = false;
  if (shouldInspectHistoricalAuditRunIdentity) {
    const auditRunTables = (await db.execute(sql`
      SELECT
        to_regclass('public.historical_archive_audit_decisions') IS NOT NULL
          AS decisions_present,
        to_regclass('public.result_interpretation_backfill_runs') IS NOT NULL
          AS runs_present
    `)) as unknown as Array<{
      decisions_present: boolean;
      runs_present: boolean;
    }>;
    const auditRunTablesPresent =
      auditRunTables[0]?.decisions_present === true &&
      auditRunTables[0]?.runs_present === true;
    if (auditRunTablesPresent) {
      const auditRunMismatch = (await db.execute(sql`
        WITH invalid_audit_scope AS (
          SELECT audit_run."id"
          FROM "result_interpretation_backfill_runs" audit_run
          WHERE audit_run."scope" ->> 'contract'
                  = 'archive-clean-cycle-historical-released-audit-v1'
            AND (
              audit_run."scope" ->> 'canonicalSelection' IS DISTINCT FROM 'forbidden'
              OR audit_run."scope" ->> 'physicalRecovery' IS DISTINCT FROM 'record-only'
              OR audit_run."scope" ->> 'campaignMutation' IS DISTINCT FROM 'forbidden'
              OR jsonb_typeof(audit_run."scope" -> 'rawEvidenceImmutable')
                IS DISTINCT FROM 'boolean'
              OR audit_run."scope" ->> 'rawEvidenceImmutable' IS DISTINCT FROM 'true'
              OR jsonb_typeof(audit_run."scope" -> 'exactSource')
                IS DISTINCT FROM 'object'
              OR NOT COALESCE(
                (audit_run."scope" -> 'exactSource') ?& ARRAY[
                  'resultId', 'resultAttemptId', 'sourceArchiveId'
                ]::text[],
                false
              )
              OR CASE
                WHEN jsonb_typeof(audit_run."scope" -> 'exactSource') = 'object' THEN
                  EXISTS (
                    SELECT 1
                    FROM jsonb_object_keys(audit_run."scope" -> 'exactSource')
                      AS exact_source_key(key)
                    WHERE exact_source_key.key NOT IN (
                      'resultId', 'resultAttemptId', 'sourceArchiveId'
                    )
                  )
                ELSE false
              END
              OR jsonb_typeof(audit_run."scope" #> '{exactSource,resultId}')
                IS DISTINCT FROM 'string'
              OR jsonb_typeof(audit_run."scope" #> '{exactSource,resultAttemptId}')
                IS DISTINCT FROM 'string'
              OR jsonb_typeof(audit_run."scope" #> '{exactSource,sourceArchiveId}')
                IS DISTINCT FROM 'string'
              OR NOT COALESCE(
                audit_run."scope" #>> '{exactSource,resultId}'
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                false
              )
              OR NOT COALESCE(
                audit_run."scope" #>> '{exactSource,resultAttemptId}'
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                false
              )
              OR NOT COALESCE(
                audit_run."scope" #>> '{exactSource,sourceArchiveId}'
                  ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
                false
              )
              OR audit_run."scope" ? 'resultIds'
              OR audit_run."scope" ? 'resultAttemptIds'
              OR audit_run."scope" ? 'limit'
            )
        )
        SELECT
          (
            EXISTS (
              SELECT 1
              FROM "historical_archive_audit_decisions" decision
              JOIN "result_interpretation_backfill_runs" audit_run
                ON audit_run."id" = decision."audit_run_id"
              WHERE audit_run."reducer_version_id"
                    IS DISTINCT FROM decision."reducer_version_id"
                 OR audit_run."scope" ->> 'contract'
                    IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1'
                 OR audit_run."scope" #>> '{exactSource,resultId}'
                    IS DISTINCT FROM decision."result_id"::text
                 OR audit_run."scope" #>> '{exactSource,resultAttemptId}'
                    IS DISTINCT FROM decision."result_attempt_id"::text
                 OR audit_run."scope" #>> '{exactSource,sourceArchiveId}'
                    IS DISTINCT FROM decision."source_archive_id"::text
            ) OR EXISTS (
              SELECT 1 FROM invalid_audit_scope
            )
          ) AS identity_mismatch,
          EXISTS (
            SELECT 1
            FROM "historical_archive_audit_decisions"
            GROUP BY "audit_run_id"
            HAVING count(*) > 1
          ) AS cardinality_mismatch
      `)) as unknown as Array<{
        identity_mismatch: boolean;
        cardinality_mismatch: boolean;
      }>;
      historicalAuditRunIdentityMismatch =
        auditRunMismatch[0]?.identity_mismatch === true;
      historicalAuditRunCardinalityMismatch =
        auditRunMismatch[0]?.cardinality_mismatch === true;
    }
  }

  // 0106 adds the reverse pointer from the one claimed child lifecycle to the
  // immutable decision.  The deferred triggers protect future commits, but a
  // past privileged writer could have disabled them. Inspect both directions
  // after the final journal state so no direct-SQL orphan or forged receipt is
  // grandfathered as valid forensic history.
  const shouldInspectHistoricalAuditChildReceipt =
    row.journal_state === "postledger_0106" ||
    row.journal_state === "postledger_0107" ||
    row.journal_state === "postledger_0108" ||
    row.journal_state === "postledger_0109" ||
    row.journal_state === "postledger_0110" ||
    row.journal_state === "postledger_0116" ||
    row.journal_state === "postledger_0118" ||
    row.journal_state === "postledger_0119" ||
    row.journal_state === "postledger_0120" ||
    row.journal_state === "postledger_0121";
  let historicalAuditChildReceiptMismatch = false;
  let historicalAuditRunChildCardinalityMismatch = false;
  if (shouldInspectHistoricalAuditChildReceipt) {
    const auditChildReceiptTables = (await db.execute(sql`
      SELECT
        to_regclass('public.historical_archive_audit_decisions') IS NOT NULL
          AS decisions_present,
        to_regclass('public.result_interpretation_backfill_runs') IS NOT NULL
          AS runs_present,
        to_regclass('public.result_interpretation_backfill_items') IS NOT NULL
          AS items_present
    `)) as unknown as Array<{
      decisions_present: boolean;
      runs_present: boolean;
      items_present: boolean;
    }>;
    const auditChildReceiptTablesPresent =
      auditChildReceiptTables[0]?.decisions_present === true &&
      auditChildReceiptTables[0]?.runs_present === true &&
      auditChildReceiptTables[0]?.items_present === true;
    if (auditChildReceiptTablesPresent) {
      const auditChildReceiptMismatch = (await db.execute(sql`
        SELECT
          EXISTS (
            SELECT 1
            FROM "historical_archive_audit_decisions" decision
            LEFT JOIN "result_interpretation_backfill_items" child
              ON child."historical_audit_decision_id" = decision."id"
            GROUP BY decision."id"
            HAVING count(child."id") <> 1
          ) OR EXISTS (
            SELECT 1
            FROM "result_interpretation_backfill_items" child
            LEFT JOIN "historical_archive_audit_decisions" decision
              ON decision."id" = child."historical_audit_decision_id"
            LEFT JOIN "result_interpretation_backfill_runs" audit_run
              ON audit_run."id" = child."run_id"
            WHERE child."historical_audit_decision_id" IS NOT NULL
              AND (
                decision."id" IS NULL
                OR audit_run."scope" ->> 'contract'
                  IS DISTINCT FROM 'archive-clean-cycle-historical-released-audit-v1'
                OR child."run_id" IS DISTINCT FROM decision."audit_run_id"
                OR child."result_id" IS DISTINCT FROM decision."result_id"
                OR child."result_attempt_id"
                  IS DISTINCT FROM decision."result_attempt_id"
                OR child."source_archive_id"
                  IS DISTINCT FROM decision."source_archive_id"
                OR child."historical_audit_reducer_state"
                  IS DISTINCT FROM decision."reducer_state"
                OR child."historical_audit_input_evidence_signature"
                  IS DISTINCT FROM decision."input_evidence_signature"
                OR child."attempt_count" < 1
                OR child."claim_token" IS NOT NULL
                OR child."claim_expires_at" IS NOT NULL
                OR child."result_interpretation_id"
                  IS DISTINCT FROM decision."result_interpretation_id"
                OR NOT (
                  (decision."reducer_state" = 'accepted'
                    AND child."state" = 'reduced')
                  OR (decision."reducer_state" = 'continuation_required'
                    AND child."state" = 'continuation_required')
                  OR (decision."reducer_state" = 'recovery_exhausted'
                    AND child."state" = 'terminal_failure')
                  OR (decision."reducer_state" = 'rerun_required'
                    AND child."state" = 'rerun_required')
                  OR (decision."reducer_state" = 'missing_evidence'
                    AND child."state" = 'missing_evidence'
                    AND child."result_interpretation_id" IS NULL
                    AND decision."result_interpretation_id" IS NULL)
                )
              )
          ) OR EXISTS (
            SELECT 1
            FROM "result_interpretation_backfill_items" child
            JOIN "result_interpretation_backfill_runs" audit_run
              ON audit_run."id" = child."run_id"
            WHERE audit_run."scope" ->> 'contract'
                    = 'archive-clean-cycle-historical-released-audit-v1'
              AND (
                (
                  child."historical_audit_decision_id" IS NULL
                  AND (
                    child."historical_audit_reducer_state" IS NOT NULL
                    OR child."historical_audit_input_evidence_signature" IS NOT NULL
                  )
                )
                OR (
                  child."historical_audit_decision_id" IS NOT NULL
                  AND (
                    child."historical_audit_reducer_state" IS NULL
                    OR child."historical_audit_input_evidence_signature" IS NULL
                  )
                )
                OR (
                  child."state" IN (
                    'reduced', 'missing_evidence', 'continuation_required',
                    'rerun_required', 'terminal_failure'
                  )
                  AND child."historical_audit_decision_id" IS NULL
                )
                OR child."result_id"::text IS DISTINCT FROM
                  audit_run."scope" #>> '{exactSource,resultId}'
                OR child."result_attempt_id"::text IS DISTINCT FROM
                  audit_run."scope" #>> '{exactSource,resultAttemptId}'
                OR child."source_archive_id"::text IS DISTINCT FROM
                  audit_run."scope" #>> '{exactSource,sourceArchiveId}'
              )
          ) AS receipt_mismatch,
          EXISTS (
            SELECT 1
            FROM "result_interpretation_backfill_runs" audit_run
            LEFT JOIN "result_interpretation_backfill_items" child
              ON child."run_id" = audit_run."id"
            WHERE audit_run."scope" ->> 'contract'
                    = 'archive-clean-cycle-historical-released-audit-v1'
            GROUP BY audit_run."id", audit_run."scope", audit_run."state"
            HAVING count(child."id") <> 1
              -- A result/attempt owner cascade intentionally retains the
              -- audit run as a non-executable forensic record after it
              -- deletes the exact child and decision. Match 0106's immediate
              -- failure/cancelled exception precisely; every other empty run
              -- is bad.
              AND NOT (
                count(child."id") = 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM "result_attempts" attempt
                  WHERE attempt."id"::text
                          = audit_run."scope" #>> '{exactSource,resultAttemptId}'
                    AND attempt."result_id"::text
                          = audit_run."scope" #>> '{exactSource,resultId}'
                )
                AND audit_run."state" IN ('failed', 'cancelled')
              )
          ) AS run_child_cardinality_mismatch
      `)) as unknown as Array<{
        receipt_mismatch: boolean;
        run_child_cardinality_mismatch: boolean;
      }>;
      historicalAuditChildReceiptMismatch =
        auditChildReceiptMismatch[0]?.receipt_mismatch === true;
      historicalAuditRunChildCardinalityMismatch =
        auditChildReceiptMismatch[0]?.run_child_cardinality_mismatch === true;
    }
  }

  return classifyResultInterpretationLedgerPreflight({
    hasApplicationAnchors: row.application_anchors_present,
    journalState: row.journal_state,
    footprintPresent: row.footprint_present,
    preledger0093Issues: row.preledger_0093_issues ?? [],
    post0093MarkersPresent: row.post_0093_markers_present,
    postledger0099Issues: row.postledger_0099_issues ?? [],
    postledger0100Issues: row.postledger_0100_issues ?? [],
    postledger0101Issues: row.postledger_0101_issues ?? [],
    postledger0102Issues: row.postledger_0102_issues ?? [],
    postledger0103Issues: [
      ...(row.postledger_0103_issues ?? []),
      ...(row.journal_state === "postledger_0103" &&
      historicalAuditCurrentProjection
        ? [HISTORICAL_AUDIT_CURRENT_PROJECTION_ISSUE]
        : []),
    ],
    postledger0104Issues: [
      ...(row.postledger_0104_issues ?? []),
      ...(row.journal_state === "postledger_0104"
        ? [
            ...(historicalAuditCurrentProjection
              ? [HISTORICAL_AUDIT_CURRENT_PROJECTION_ISSUE]
              : []),
            ...(historicalAuditRunIdentityMismatch
              ? [HISTORICAL_AUDIT_RUN_IDENTITY_ISSUE]
              : []),
            ...(historicalAuditRunCardinalityMismatch
              ? [HISTORICAL_AUDIT_RUN_CARDINALITY_ISSUE]
              : []),
          ]
        : []),
    ],
    postledger0105Issues: [
      ...(row.postledger_0105_issues ?? []),
      ...(row.journal_state === "postledger_0105"
        ? [
            ...(historicalAuditCurrentProjection
              ? [HISTORICAL_AUDIT_CURRENT_PROJECTION_ISSUE]
              : []),
            ...(historicalAuditRunIdentityMismatch
              ? [HISTORICAL_AUDIT_RUN_IDENTITY_ISSUE]
              : []),
            ...(historicalAuditRunCardinalityMismatch
              ? [HISTORICAL_AUDIT_RUN_CARDINALITY_ISSUE]
              : []),
          ]
        : []),
    ],
    postledger0106Issues: [
      ...(row.postledger_0106_issues ?? []),
      ...(row.journal_state === "postledger_0106" ||
      row.journal_state === "postledger_0107" ||
      row.journal_state === "postledger_0108" ||
      row.journal_state === "postledger_0109" ||
      row.journal_state === "postledger_0110" ||
      row.journal_state === "postledger_0116" ||
      row.journal_state === "postledger_0118" ||
      row.journal_state === "postledger_0119" ||
      row.journal_state === "postledger_0120" ||
      row.journal_state === "postledger_0121"
        ? [
            ...(historicalAuditCurrentProjection
              ? [HISTORICAL_AUDIT_CURRENT_PROJECTION_ISSUE]
              : []),
            ...(historicalAuditRunIdentityMismatch
              ? [HISTORICAL_AUDIT_RUN_IDENTITY_ISSUE]
              : []),
            ...(historicalAuditRunCardinalityMismatch
              ? [HISTORICAL_AUDIT_RUN_CARDINALITY_ISSUE]
              : []),
            ...(historicalAuditChildReceiptMismatch
              ? [HISTORICAL_AUDIT_CHILD_RECEIPT_ISSUE]
              : []),
            ...(historicalAuditRunChildCardinalityMismatch
              ? [HISTORICAL_AUDIT_RUN_CHILD_CARDINALITY_ISSUE]
              : []),
          ]
        : []),
    ],
    postledger0116Issues,
    postledger0118Issues,
    postledger0120Issues,
    postledger0121Issues,
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
