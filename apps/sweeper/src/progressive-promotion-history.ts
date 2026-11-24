import { sql } from "drizzle-orm";
import {
  analysisContentHash,
  canonicalAnalysisJson,
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import {
  assertProgressiveReportArchiveIdentity,
  parseReportJson,
  reportTextIdentity,
  reportValidationValue,
  type ProgressiveReportArchiveReadIdentity,
  type ProgressiveReportArchiveEntry,
} from "@aerodb/db/progressive-report-archive";
import {
  readProgressiveReport,
  visitInstalledRemoteJsonl,
} from "@aerodb/db/progressive-report-reader";
import { hasProgressStorageColumns } from "./progressive-repeated-progress";
import { withSharedReportPageReads } from "./shared-report-archive";
import { validateRansPrecalcPromotionSignal } from "./ingest";

type Assignment = ProgressiveRemoteExecutionEnvelope;
export interface ObservedRansPromotion {
  sequence: number;
  signature: string;
  pointSignature: string;
  triggerAoaDeg: number;
  attemptedAoas: number[];
  intentionallyOmittedAoas: number[];
}
export interface PreparedPromotionHistory {
  executionId: string;
  assignmentSignature: string;
  catalog: string;
  promotion: ObservedRansPromotion | null;
}
export class ColdPromotionHistoryRequired extends Error {
  constructor(readonly envelope: Assignment) {
    super("Cold promotion history requires unlocked verification");
  }
}
export class PromotionHistoryChanged extends Error {
  constructor() {
    super("Remote promotion history changed during verification");
  }
}

// Compare database versions as well as immutable signatures. A concurrent
// offload, new sparse sequence, member reassignment or root change invalidates
// the old preparation. Each intermediate aggregate contains at most 128 rows.
export async function coldPromotionCatalog(
  db: DB,
  executionId: string,
): Promise<string | null> {
  if (!(await hasProgressStorageColumns(db))) return null;
  const [cold] = await db.execute(sql`SELECT 1 FROM progressive_remote_reports
    WHERE sim_job_id=${executionId}::uuid AND (archive_bundle_id IS NOT NULL OR archived_at IS NOT NULL
      OR report->>'archivedReport'='true') LIMIT 1`);
  if (!cold) return null;
  const [row] = await db.execute(sql`WITH chunks AS (
    SELECT (r.sequence-1)/128 AS page,
      encode(sha256(convert_to(jsonb_agg(jsonb_build_array(r.sequence,r.content_signature,r.xmin::text,
        r.archive_bundle_id,b.id,b.xmin::text,b.generation,b.stored_sha256,b.verified_at IS NOT NULL,
        m.xmin::text,m.report_sha256,m.report_byte_size) ORDER BY r.sequence)::text,'UTF8')),'hex') AS digest
    FROM progressive_remote_reports r LEFT JOIN progressive_report_archive_bundles b
      ON b.id=r.archive_bundle_id AND b.sim_job_id=r.sim_job_id AND b.source_kind='remote'
    LEFT JOIN progressive_report_archive_members m ON m.bundle_id=b.id AND m.sim_job_id=r.sim_job_id
      AND m.source_kind='remote' AND m.member_kind='report' AND m.sequence=r.sequence AND m.content_signature=r.content_signature
    WHERE r.sim_job_id=${executionId}::uuid GROUP BY (r.sequence-1)/128)
    SELECT encode(sha256(convert_to(string_agg(digest,'' ORDER BY page),'UTF8')),'hex') AS digest FROM chunks`);
  if (typeof row?.digest !== "string") throw new PromotionHistoryChanged();
  return row.digest;
}

type Signals = {
  key?: string;
  selected?: ObservedRansPromotion;
  archived?: boolean;
};

function combine(target: Signals, source: Signals) {
  if (!source.selected) return;
  if (target.key !== undefined && target.key !== source.key)
    throw new Error("Remote execution has competing RANS promotion scopes");
  if (
    !target.selected ||
    (source.archived &&
      (!target.archived || target.selected.sequence < source.selected.sequence))
  ) {
    target.key = source.key;
    target.selected = source.selected;
    target.archived = source.archived;
  }
}

function observe(
  signals: Signals,
  report: ProgressiveRemoteReport,
  signature: string,
  archived: boolean,
  envelope: Assignment,
) {
  const polar = report.result?.polars[0];
  const promotion = polar?.rans_precalc_promotion;
  if (promotion == null || !polar) return;
  const attempts = new Map(
    (polar.attempts ?? []).map((point) => [point.aoa_deg, point]),
  );
  const trigger = attempts.get(promotion.trigger_aoa_deg);
  const scope = validateRansPrecalcPromotionSignal({
    promotion,
    stagedAttemptAoas: [...attempts.keys()],
    triggerFailureDisposition: trigger?.failure_disposition ?? null,
    jobAoas: envelope.request.aoa?.angles ?? [],
  });
  if (!trigger || !scope)
    throw new Error(
      "Remote RANS promotion changed its exact attempt and omission scope",
    );
  const [source] = progressiveReportedPointSources({
    ...report.result!,
    polars: [{ ...polar, points: [], attempts: [trigger] }],
  });
  combine(signals, {
    key: canonicalAnalysisJson(promotion),
    archived,
    selected: {
      sequence: report.sequence,
      signature,
      pointSignature: source.contentSignature,
      triggerAoaDeg: promotion.trigger_aoa_deg,
      ...scope,
    },
  });
}

async function inlineSignals(db: DB, envelope: Assignment, signals: Signals) {
  const reports = await db.execute(sql`WITH owners AS MATERIALIZED (
    SELECT DISTINCT ON (coalesce(r.result_payload_hash,r.content_signature)) r.sim_job_id,r.sequence
    FROM progressive_remote_reports r WHERE r.sim_job_id=${envelope.scope.executionId}::uuid
      AND to_jsonb(r.*)->>'archived_at' IS NULL AND to_jsonb(r.*)->>'archive_bundle_id' IS NULL
      AND r.report->>'archivedReport' IS DISTINCT FROM 'true'
    ORDER BY coalesce(r.result_payload_hash,r.content_signature),r.sequence
  ), signals AS MATERIALIZED (
    SELECT o.sim_job_id,o.sequence,public.resolve_progressive_report(r.report,r.result_payload_hash)#>'{result,polars,0,rans_precalc_promotion}' AS promotion
    FROM owners o JOIN progressive_remote_reports r USING(sim_job_id,sequence)
  ), selected AS MATERIALIZED (
    SELECT DISTINCT ON (promotion) sim_job_id,sequence FROM signals
    WHERE promotion IS NOT NULL AND promotion<>'null'::jsonb ORDER BY promotion,sequence LIMIT 2
  ) SELECT public.resolve_progressive_report(to_jsonb(r.*)) AS report,r.content_signature
    FROM selected JOIN progressive_remote_reports r USING(sim_job_id,sequence)`);
  for (const r of reports) {
    const valid = validateProgressiveRemoteReport(r.report, envelope);
    if (valid.contentSignature !== r.content_signature)
      throw new Error("Remote RANS promotion has changed report bytes");
    observe(signals, valid.report, valid.contentSignature, false, envelope);
  }
}
export async function readInlinePromotion(db: DB, envelope: Assignment) {
  const signals: Signals = {};
  await inlineSignals(db, envelope, signals);
  return signals.selected ?? null;
}

// Keep compact, fully verified root projections across a concurrent inline-to-archive
// transition. A changed member, root generation, owner or scientific scope is a miss.
const rootFindings = new Map<string, Readonly<Signals>>();
function retainRoot(key: string, result: Signals) {
  rootFindings.set(key, result);
  if (rootFindings.size > 512)
    rootFindings.delete(rootFindings.keys().next().value!);
}

type Member = {
  sequence: number;
  signature: string;
  sha: string;
  bytes: number;
  typedNull: boolean;
};
async function readRoot(
  db: DB,
  envelope: Assignment,
  id: string,
  signals: Signals,
) {
  const executionId = envelope.scope.executionId;
  const [root] =
    await db.execute(sql`SELECT id,archive_format,bucket,object_key,generation,stored_sha256,stored_byte_size,crc32c,
    mime_type,compression,member_count,first_sequence,last_sequence FROM progressive_report_archive_bundles
    WHERE id=${id}::uuid AND source_kind='remote' AND sim_job_id=${executionId}::uuid AND verified_at IS NOT NULL`);
  if (!root)
    throw new Error("Cold promotion history has no verified archive root");
  const members =
    await db.execute(sql`SELECT r.sequence,r.content_signature,m.report_sha256,m.report_byte_size,
    (r.archived_at IS NOT NULL AND r.result_payload_hash IS NULL AND r.report @> '{"version":1,"archivedReport":true,"result":null}'::jsonb
      AND r.report->>'executionId'=${executionId} AND r.report->>'sequence'=r.sequence::text
      AND r.report->>'solverId'=${envelope.solverId} AND r.report->>'promiseId'=${envelope.promiseId}
      AND r.report->>'assignmentSignature'=${envelope.contentSignature}) AS typed_null
    FROM progressive_remote_reports r LEFT JOIN progressive_report_archive_members m ON m.bundle_id=r.archive_bundle_id
      AND m.source_kind='remote' AND m.member_kind='report' AND m.sim_job_id=r.sim_job_id
      AND m.sequence=r.sequence AND m.content_signature=r.content_signature
    WHERE r.sim_job_id=${executionId}::uuid AND r.archive_bundle_id=${id}::uuid ORDER BY r.sequence`);
  const rootKey = analysisContentHash({
    id,
    root,
    executionId,
    owner: envelope.contentSignature,
    members,
  });
  const found = rootFindings.get(rootKey);
  if (found) {
    combine(signals, found);
    return;
  }
  const projected: Signals = {};
  const wanted = new Map<number, Member>();
  let representative: Member | undefined;
  for (const row of members) {
    const m = {
      sequence: Number(row.sequence),
      signature: String(row.content_signature),
      bytes: Number(row.report_byte_size),
      sha: String(row.report_sha256),
      typedNull: row.typed_null === true,
    };
    if (
      !Number.isSafeInteger(m.bytes) ||
      m.bytes < 1 ||
      m.bytes > 512 * 1024 * 1024 ||
      !/^[0-9a-f]{64}$/.test(m.sha)
    )
      throw new Error(
        "Cold promotion report lost its exact member registration",
      );
    if (
      !Number.isSafeInteger(m.sequence) ||
      m.sequence < 1 ||
      !/^[0-9a-f]{64}$/.test(m.signature) ||
      m.sequence < Number(root.first_sequence) ||
      m.sequence > Number(root.last_sequence)
    )
      throw new Error("Cold promotion report changed its member scope");
    representative ??= m;
    if (
      !m.typedNull ||
      !["jsonl", "shared-result-v1"].includes(String(root.archive_format))
    )
      wanted.set(m.sequence, m);
  }
  if (!representative) throw new PromotionHistoryChanged();
  const owner = {
    executionId,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    assignmentSignature: envelope.contentSignature,
  };
  const first = representative;
  const rootPin: ProgressiveReportArchiveReadIdentity = {
    sourceKind: "remote",
    memberKind: "report",
    executionId,
    sequence: first.sequence,
    signature: first.signature,
    reportSha256: first.sha,
    reportByteSize: first.bytes,
    bucket: String(root.bucket),
    objectKey: String(root.object_key),
    generation: String(root.generation),
    storedSha256: String(root.stored_sha256),
    storedByteSize: Number(root.stored_byte_size),
    crc32c: String(root.crc32c),
    mimeType: String(root.mime_type),
    compression: String(root.compression),
    archiveFormat: String(root.archive_format),
    memberCount: Number(root.member_count),
    firstSequence: Number(root.first_sequence),
    lastSequence: Number(root.last_sequence),
  };
  if (rootPin.archiveFormat !== "jsonl" && rootPin.archiveFormat !== "shared-result-v1")
    throw new Error("Unsupported remote promotion archive format");
  assertProgressiveReportArchiveIdentity(rootPin, rootPin.archiveFormat);
  if (!wanted.size) {
    retainRoot(rootKey, projected);
    return;
  }
  const inspect = (entry: ProgressiveReportArchiveEntry) => {
    if (entry.kind !== "report") return;
    const m = wanted.get(entry.sequence);
    if (!m) return;
    const raw = reportTextIdentity(entry.reportText);
    if (
      entry.sourceKind !== "remote" ||
      entry.executionId !== executionId ||
      entry.contentSignature !== m.signature ||
      raw.byteSize !== m.bytes ||
      raw.sha256 !== m.sha
    )
      throw new Error(
        "Cold RANS promotion member bytes differ from registration",
      );
    const checked = validateProgressiveRemoteReport(
      reportValidationValue(parseReportJson(entry.reportText)),
      envelope,
    );
    if (
      checked.contentSignature !== m.signature ||
      checked.report.sequence !== m.sequence
    )
      throw new Error("Cold RANS promotion changed its signed report");
    observe(projected, checked.report, m.signature, true, envelope);
    wanted.delete(m.sequence);
  };
  if (await visitInstalledRemoteJsonl(rootPin, owner, inspect)) {
    if (wanted.size)
      throw new Error("Promotion archive omitted registered report members");
  } else
    await withSharedReportPageReads(async () => {
      for (const m of wanted.values()) {
        const report = await readProgressiveReport(
          db,
          {
            executionId,
            sourceKind: "remote",
            sequence: m.sequence,
            contentSignature: m.signature,
          },
          owner,
        );
        const checked = validateProgressiveRemoteReport(report, envelope);
        if (checked.contentSignature !== m.signature)
          throw new Error(
            "Remote RANS promotion has changed archived report bytes",
          );
        observe(projected, checked.report, m.signature, true, envelope);
      }
    });
  retainRoot(rootKey, projected);
  combine(signals, projected);
}

// Only compact results enter the cache. Every hit still has to bind the
// current dispatch and complete SQL catalog inside the settlement transaction.
const recent = new Map<string, PreparedPromotionHistory>();
export async function preparePromotionHistory(
  db: DB,
  envelope: Assignment,
): Promise<PreparedPromotionHistory> {
  const executionId = envelope.scope.executionId;
  const [dispatch] =
    await db.execute(sql`SELECT envelope FROM progressive_remote_dispatches
    WHERE sim_job_id=${executionId}::uuid AND solver_id=${envelope.solverId}::uuid
      AND promise_id=${envelope.promiseId}::uuid AND content_signature=${envelope.contentSignature}`);
  if (!dispatch)
    throw new Error("Cold promotion history has a foreign dispatch owner");
  envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
    executionId,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    contentSignature: envelope.contentSignature,
  });
  const catalog = await coldPromotionCatalog(db, executionId);
  if (!catalog) throw new PromotionHistoryChanged();
  const cached = recent.get(executionId);
  if (
    cached?.catalog === catalog &&
    cached.assignmentSignature === envelope.contentSignature
  )
    return structuredClone(cached);
  const signals: Signals = {};
  await inlineSignals(db, envelope, signals);
  const roots =
    await db.execute(sql`SELECT DISTINCT archive_bundle_id FROM progressive_remote_reports
    WHERE sim_job_id=${executionId}::uuid AND (archived_at IS NOT NULL OR archive_bundle_id IS NOT NULL OR report->>'archivedReport'='true')
    ORDER BY archive_bundle_id`);
  for (const row of roots) {
    if (!row.archive_bundle_id)
      throw new Error("Compacted promotion history has no archive binding");
    await readRoot(db, envelope, String(row.archive_bundle_id), signals);
  }
  const promotion = signals.selected ?? null;
  if ((await coldPromotionCatalog(db, executionId)) !== catalog)
    throw new PromotionHistoryChanged();
  const result = {
    executionId,
    assignmentSignature: envelope.contentSignature,
    catalog,
    promotion,
  };
  recent.set(executionId, result);
  if (recent.size > 16) recent.delete(recent.keys().next().value!);
  return structuredClone(result);
}

// The action owns the normal transaction and its exact scientific checks. A
// missing or stale cold projection leaves that transaction before any I/O.
export async function withUnlockedPromotionHistory<T>(
  db: DB,
  execute: (prepared?: PreparedPromotionHistory) => Promise<T>,
): Promise<T | { kind: "waiting"; reason: "promotion_history_changed" }> {
  let prepared: PreparedPromotionHistory | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await execute(prepared);
    } catch (error) {
      if (!(error instanceof ColdPromotionHistoryRequired)) throw error;
      if (attempt === 2) break;
      try {
        prepared = await preparePromotionHistory(db, error.envelope);
      } catch (changed) {
        if (!(changed instanceof PromotionHistoryChanged)) throw changed;
        prepared = undefined;
      }
    }
  }
  return { kind: "waiting", reason: "promotion_history_changed" };
}

export async function promotionForSettlement(
  db: DB,
  envelope: Assignment,
  prepared?: PreparedPromotionHistory,
) {
  const catalog = await coldPromotionCatalog(db, envelope.scope.executionId);
  if (
    catalog &&
    (!prepared ||
      prepared.catalog !== catalog ||
      prepared.executionId !== envelope.scope.executionId ||
      prepared.assignmentSignature !== envelope.contentSignature)
  )
    throw new ColdPromotionHistoryRequired(envelope);
  const observed = catalog
    ? prepared!.promotion
    : await readInlinePromotion(db, envelope);
  if (!observed) return null;
  // A URANS/continue assignment cannot authorize a RANS promotion. Only a
  // positively observed conflicting signal enters this disclosure path.
  const solver = envelope.request.solver;
  if (
    solver?.rans_failure_policy === "continue" ||
    solver?.flow_solver_family === "pimpleFoam" ||
    solver?.flow_solver_family === "rhoPimpleFoam"
  )
    throw new Error(
      "Numerical recovery changed the exact original RANS promotion scope: signed request is not promotable",
    );
  return observed;
}
