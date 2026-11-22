import { sql, type SQL } from "drizzle-orm";
import { attemptEvidenceArrayFactsSql } from "./attempt-evidence-projection";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  type ReportJson,
} from "./progressive-report-archive";

export const ATTEMPT_HISTORY_ARRAY_PATHS = [
  ...["force_history", "forceHistory"].flatMap((parent) =>
    ["t", "cl", "cd", "cm"].map((child) => [parent, child]),
  ),
  ...["steady_history", "steadyHistory"].flatMap((parent) =>
    ["iterations", "cl", "cd", "cm"].map((child) => [parent, child]),
  ),
  ...["frame_track", "frameTrack"].map((parent) => [parent, "frames"]),
] as readonly (readonly string[])[];

export interface AttemptEvidenceArrayFact {
  path: string[];
  type: "array";
  length: number;
  byteSize: number;
  sha256: string;
}

/** Only actual arrays at the agreed paths move. Unknown fields, certificates,
 * nulls, malformed values, parent objects and snake/camel precedence survive.
 * The original PG text remains the archive identity; this is not that text. */
export function projectAttemptEvidenceForConsumers(
  payloadText: string,
  removedPaths: readonly (readonly string[])[] = ATTEMPT_HISTORY_ARRAY_PATHS,
): {
  projectionText: string;
  arrayFacts: AttemptEvidenceArrayFact[];
} {
  const roots = new Map<string, string>();
  const root = reportJsonObject(parseReportJson(payloadText, roots));
  const requested = new Set<string>();
  for (const path of removedPaths) {
    const key = JSON.stringify(path);
    if (
      requested.has(key) ||
      !ATTEMPT_HISTORY_ARRAY_PATHS.some(
        (known) => JSON.stringify(known) === key,
      )
    )
      throw new Error("Unknown or duplicate attempt history array path");
    requested.add(key);
  }
  const arrayFacts: AttemptEvidenceArrayFact[] = [];
  const parents = new Map<
    string,
    { object: Record<string, ReportJson>; texts: Map<string, string> }
  >();
  for (const path of removedPaths) {
    const [parent, child] = path as [string, string];
    let parsed = parents.get(parent);
    if (!parsed) {
      const raw = roots.get(parent);
      if (!raw) continue;
      const texts = new Map<string, string>();
      const value = parseReportJson(raw, texts);
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      try {
        parsed = { object: { ...reportJsonObject(value) }, texts };
      } catch {
        continue;
      }
      parents.set(parent, parsed);
    }
    const value = parsed.object[child];
    if (!Array.isArray(value)) continue;
    const proof = reportTextIdentity(parsed.texts.get(child)!);
    arrayFacts.push({
      path: [...path],
      type: "array",
      length: value.length,
      byteSize: proof.byteSize,
      sha256: proof.sha256,
    });
    delete parsed.object[child];
    root[parent] = parsed.object;
  }
  return { projectionText: canonicalReportJson(root), arrayFacts };
}

/** Original type/cardinality only. An explicit null/non-array is never replaced
 * by an archived fact. The shared 0208 helper verifies the archive/projection
 * owner and compact fingerprint; no payload-supplied marker is trusted. */
export function attemptEvidenceArrayLengthSql(
  attempt: SQL,
  path: readonly string[],
  projection: SQL = sql`NULL::jsonb`,
): SQL<number | null> {
  if (
    path.length !== 2 ||
    !ATTEMPT_HISTORY_ARRAY_PATHS.some((candidate) =>
      candidate.every((part, index) => part === path[index]),
    )
  )
    throw new Error("Unknown archived attempt array path");
  const value = sql`${attempt}.evidence_payload -> ${path[0]}::text -> ${path[1]}::text`;
  const fact = attemptEvidenceArrayFactsSql(
    attemptEvidenceSqlSource(attempt, projection),
    path,
  );
  return sql<number | null>`CASE WHEN ${attempt}.evidence_archive_id IS NULL
    THEN CASE WHEN jsonb_typeof(${value})='array' THEN jsonb_array_length(${value}) END
    ELSE (WITH ae_fact AS MATERIALIZED (SELECT ${fact} AS value)
      SELECT ${factLength(sql`ae_fact.value`)} FROM ae_fact)
    END`;
}

function attemptEvidenceSqlSource(attempt: SQL, projection: SQL) {
  return {
    attemptId: sql`${attempt}.id`,
    archiveId: sql`${attempt}.evidence_archive_id`,
    payload: sql`${attempt}.evidence_payload`,
    projection,
  };
}

function factLength(fact: SQL): SQL<number | null> {
  return sql<
    number | null
  >`CASE WHEN ${fact}->'present'='true'::jsonb AND ${fact}->>'jsonType'='array'
    AND jsonb_typeof(${fact}->'length')='number' AND ${fact}->>'length' ~ '^(0|[1-9][0-9]{0,7})$'
    THEN (${fact}->>'length')::integer END`;
}

export function attemptEvidenceHasForceHistorySql(
  payload: SQL,
  attempt: SQL,
  projection: SQL = sql`NULL::jsonb`,
): SQL<boolean> {
  const snake = sql`NULLIF(${payload}->'force_history','null'::jsonb)`;
  const normalized = sql`COALESCE(${snake},${payload}->'forceHistory')`;
  const native = sql<boolean>`(jsonb_typeof(${normalized})='object'
    AND jsonb_typeof((${normalized})->'t')='array' AND jsonb_typeof((${normalized})->'cl')='array'
    AND jsonb_typeof((${normalized})->'cd')='array'
    AND jsonb_array_length((${normalized})->'t')>0 AND jsonb_array_length((${normalized})->'cl')>0
    AND jsonb_array_length((${normalized})->'cd')>0)`;
  const source = attemptEvidenceSqlSource(attempt, projection);
  const facts = ["t", "cl", "cd"].map(
    (child) => sql`CASE WHEN ${snake} IS NOT NULL
      THEN ${attemptEvidenceArrayFactsSql(source, ["force_history", child])}
      ELSE ${attemptEvidenceArrayFactsSql(source, ["forceHistory", child])} END`,
  );
  const columns = [sql`ae_facts.t`, sql`ae_facts.cl`, sql`ae_facts.cd`];
  const lengths = columns.map(factLength);
  return sql<boolean>`CASE WHEN ${attempt}.evidence_archive_id IS NULL THEN ${native}
    ELSE (WITH ae_facts AS MATERIALIZED (
      SELECT ${facts[0]} AS t,${facts[1]} AS cl,${facts[2]} AS cd)
      SELECT jsonb_typeof(${normalized})='object'
        AND ${columns[0]}->>'jsonType'='array' AND ${columns[1]}->>'jsonType'='array' AND ${columns[2]}->>'jsonType'='array'
        AND ${lengths[0]}>0 AND ${lengths[1]}>0 AND ${lengths[2]}>0
      FROM ae_facts) END`;
}

/** Initial removable cohort: settled local, historical steady-RANS only.
 * Referenced progressive/remote/continuation/interpretation work stays inline.
 * Galileo must repeat this predicate in the final locked compare-and-set. */
export function attemptEvidenceColdCohortSql(a: SQL): SQL<boolean> {
  return sql<boolean>`(
    ${a}.status IN ('done','failed') AND ${a}.regime = 'rans' AND ${a}.unsteady = false
    AND jsonb_typeof(${a}.evidence_payload) = 'object'
    AND coalesce(${a}.evidence_payload->'mesh_recovery_version' = '1'::jsonb,false)
    AND ${a}.result_id IS NOT NULL AND ${a}.sim_job_id IS NOT NULL
    AND coalesce(${a}.evidence_payload->>'fidelity','rans') = 'rans'
    AND (${a}.engine_job_id IS NULL OR ${a}.engine_job_id !~ '^sync:')
    AND EXISTS (SELECT 1 FROM sim_jobs job WHERE job.id=${a}.sim_job_id
      AND job.status IN ('done','failed','cancelled') AND job."ingestedAt" IS NOT NULL
      AND (job.ingest_lease_token IS NULL OR coalesce(job.ingest_lease_expires_at <= clock_timestamp(),false))
      AND coalesce(job.engine_state,'') NOT IN ('pending','queued','submitting','submitted','running','meshing','cancelling','cancel_pending')
      AND coalesce(job.request_payload->>'remoteSolver','false') <> 'true'
      AND NOT (job.request_payload ?| ARRAY['progressive','remoteProgressiveExecution','syncPromiseId','progressiveExecutionId','campaignId']))
    AND NOT EXISTS (SELECT 1 FROM results r WHERE r.current_result_attempt_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM progressive_remote_dispatches d WHERE d.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts p WHERE p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence p WHERE p.result_attempt_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence_reuses p WHERE p.source_result_attempt_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM progressive_cfd_budget_extensions p WHERE p.source_result_attempt_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans p WHERE p.diagnostic_attempt_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM progressive_polar_model_evidence p WHERE p.result_attempt_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM progressive_remote_evidence_receipts p WHERE p.result_attempt_id=${a}.id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_attempts p WHERE p.result_attempt_id=${a}.id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sim_campaign_points p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM sim_precalc_obligations p WHERE p.source_result_attempt_id=${a}.id OR p.source_result_id=${a}.result_id OR p.latest_sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sim_precalc_obligation_attempts p WHERE p.result_attempt_id=${a}.id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sim_urans_verify_queue p WHERE p.precalc_result_attempt_id=${a}.id OR p.latest_result_attempt_id=${a}.id OR p.precalc_result_id=${a}.result_id OR p.verify_result_id=${a}.result_id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sim_urans_requests p WHERE p.continue_from_result_attempt_id=${a}.id OR p.continue_from_result_id=${a}.result_id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sim_rans_polar_promotions p WHERE p.trigger_result_attempt_id=${a}.id OR p.parent_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM point_correction_runs p WHERE p.source_result_attempt_id=${a}.id OR p.source_result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM sim_solver_incidents p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM result_interpretations p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM result_canonical_selections p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM result_interpretation_backfill_items p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM result_interpretation_recovery_actions p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM legacy_urans_archive_gap_recovery_actions p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM result_media_repairs p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM sync_sweep_promise_points p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id)
    AND NOT EXISTS (SELECT 1 FROM sync_remote_result_deliveries p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sync_remote_hub_binding_receipts p WHERE p.result_attempt_id=${a}.id OR p.result_id=${a}.result_id OR p.sim_job_id=${a}.sim_job_id)
    AND NOT EXISTS (SELECT 1 FROM sync_brokered_evidence_uploads p WHERE p.canonical_result_attempt_id=${a}.id OR p.canonical_result_id=${a}.result_id OR p.engine_job_id=${a}.engine_job_id)
  )`;
}
