import {
  buildPolarFit,
  canonicalAoa,
  classifyPolarEvidence,
  type FrameTrackEvidence,
  mirrorClassifiedEvidence,
  type SteadyHistoryEvidence,
  POLAR_CLASSIFIER_VERSION,
  POLAR_FIT_VERSION,
  type PolarEvidenceClassification,
  type PolarEvidencePoint,
} from "@aerodb/core";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DB } from "./client";
import { activeReviewVerdicts } from "./review-verdicts";
import {
  airfoils,
  polarCompatibilityFitSets,
  polarFitPoints,
  polarFitSets,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  simulationPresetRevisions,
} from "./schema";
import {
  ensureRevisionPhysicsHash,
  POLAR_COMPATIBILITY_VERSION,
  refreshPolarCompatibilityCache,
  resolveRevisionPhysicsHash,
} from "./polar-compatibility-cache";
export * from "./polar-compatibility-cache";

type EvidenceWithDbIds = PolarEvidencePoint & {
  resultId?: string | null;
  resultAttemptId?: string | null;
  currentGenerationAttemptId?: string | null;
  simJobId?: string | null;
  engineJobId?: string | null;
  updatedAt?: Date | null;
};

export interface PolarCacheRefreshResult {
  airfoilId: string;
  simulationPresetRevisionId: string;
  needsUransAoas: number[];
  hardRejectedAoas: number[];
  lowAoaFailure: boolean;
  fitSetId: string | null;
  fitStatus: string;
}

/** Deterministic transaction-observation hooks used only by DB regressions. */
export interface PolarCacheRefreshHooks {
  /** Runs under the revision advisory lock, before any evidence snapshot is
   * loaded. Writers use this to CAS-promote one exact attempt and rebuild the
   * classifications/fit in the same commit as that pointer transition. */
  beforeEvidenceLoad?: (tx: DB) => Promise<void>;
  /** Runs after immutable attempt evidence has been classified, while the
   * revision advisory lock is still held, and before canonical result
   * evidence is loaded. Exact-generation writers use it to CAS-select an
   * eligible attempt so result classification and fit see that pointer in
   * the same transaction. */
  afterAttemptClassifications?: (tx: DB) => Promise<void>;
  afterFitPointsDeleted?: () => Promise<void>;
}

/** Attempt force history is immutable evidence inside the exact attempt
 * payload. Accept both engine snake_case and normalized camelCase envelopes,
 * but fail closed on placeholders, JSON null, or empty coefficient arrays. */
function hasAttemptForceHistory(payload: SQL): SQL<boolean> {
  const normalized = sql`COALESCE(
    NULLIF(${payload} -> 'force_history', 'null'::jsonb),
    ${payload} -> 'forceHistory'
  )`;
  return sql<boolean>`(
    jsonb_typeof(${normalized}) = 'object'
    AND jsonb_typeof((${normalized}) -> 't') = 'array'
    AND jsonb_typeof((${normalized}) -> 'cl') = 'array'
    AND jsonb_typeof((${normalized}) -> 'cd') = 'array'
    AND jsonb_array_length((${normalized}) -> 't') > 0
    AND jsonb_array_length((${normalized}) -> 'cl') > 0
    AND jsonb_array_length((${normalized}) -> 'cd') > 0
  )`;
}

function toEvidence(row: {
  id?: string | null;
  attemptId?: string | null;
  currentGenerationAttemptId?: string | null;
  aoaDeg: number;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  clCd: number | null;
  status: string;
  source: string;
  regime: "rans" | "urans" | null;
  converged: boolean;
  stalled: boolean;
  unsteady?: boolean | null;
  error: string | null;
  finalResidual: number | null;
  iterations: number | null;
  firstOrderFallback: boolean | null;
  validForPolar?: boolean | null;
  hasForceHistory?: boolean | null;
  hasVideo?: boolean | null;
  frameTrack?: unknown;
  fidelity?: string | null;
  steadyHistory?: unknown;
  qualityWarnings?: string[] | null;
  simJobId?: string | null;
  engineJobId?: string | null;
  updatedAt?: Date | null;
}): EvidenceWithDbIds {
  return {
    id: row.id ?? null,
    resultId: row.id ?? null,
    attemptId: row.attemptId ?? null,
    resultAttemptId: row.attemptId ?? null,
    currentGenerationAttemptId: row.currentGenerationAttemptId ?? null,
    a: row.aoaDeg,
    cl: row.cl,
    cd: row.cd,
    cm: row.cm,
    ld: row.clCd,
    status: row.status,
    source: row.source,
    regime: row.regime,
    converged: row.converged,
    stalled: row.stalled,
    unsteady: row.unsteady ?? false,
    error: row.error,
    finalResidual: row.finalResidual,
    iterations: row.iterations,
    firstOrderFallback: row.firstOrderFallback,
    validForPolar: row.validForPolar,
    hasForceHistory: row.hasForceHistory ?? false,
    hasVideo: row.hasVideo ?? false,
    // Raw jsonb passthrough: null/undefined = legacy pre-contract evidence →
    // the classifier's frame-track gate is not applied (no mass-reject).
    frameTrack: (row.frameTrack ?? null) as FrameTrackEvidence | null,
    // Fidelity ladder (v4): tier string drives the fidelity-aware period bar;
    // steady_history.mean_stable === true accepts oscillating-steady rows.
    fidelity: row.fidelity ?? null,
    steadyHistory: (row.steadyHistory ?? null) as SteadyHistoryEvidence | null,
    qualityWarnings: row.qualityWarnings ?? null,
    simJobId: row.simJobId ?? null,
    engineJobId: row.engineJobId ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

async function loadResultEvidence(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
): Promise<EvidenceWithDbIds[]> {
  const currentAttemptForce = hasAttemptForceHistory(
    sql.raw('"current_attempt"."evidence_payload"'),
  );
  const rows = await db
    .select({
      id: results.id,
      currentGenerationAttemptId: results.currentResultAttemptId,
      // The canonical results row is a mutable projection. Under an explicit
      // current-attempt pointer every classifier input and provenance value
      // comes from that immutable attempt, never from a mixed generation.
      // AoA remains the canonical cell key when the pointer is absent, but no
      // solver evidence is read from the mutable result projection.  A null
      // pointer is explicitly unavailable/repairable (DecisionHistory 0053),
      // so the synthetic pending/null shape below fails classification closed.
      aoaDeg: sql<number>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.aoaDeg} ELSE ${results.aoaDeg} END`,
      cl: sql<
        number | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.cl} ELSE NULL END`,
      cd: sql<
        number | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.cd} ELSE NULL END`,
      cm: sql<
        number | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.cm} ELSE NULL END`,
      clCd: sql<
        number | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.clCd} ELSE NULL END`,
      status: sql<string>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.status} ELSE 'pending' END`,
      source: sql<string>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.source} ELSE 'queued' END`,
      regime: sql<
        "rans" | "urans" | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.regime} ELSE NULL END`,
      converged: sql<boolean>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.converged} ELSE FALSE END`,
      stalled: sql<boolean>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.stalled} ELSE FALSE END`,
      unsteady: sql<boolean>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.unsteady} ELSE FALSE END`,
      error: sql<
        string | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.error} ELSE NULL END`,
      finalResidual: sql<
        number | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.finalResidual} ELSE NULL END`,
      iterations: sql<
        number | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.iterations} ELSE NULL END`,
      firstOrderFallback: sql<
        boolean | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.firstOrderFallback} ELSE NULL END`,
      validForPolar: sql<
        boolean | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.validForPolar} ELSE NULL END`,
      simJobId: sql<
        string | null
      >`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.simJobId} ELSE NULL END`,
      updatedAt: sql<Date | null>`CASE WHEN ${results.currentResultAttemptId} IS NOT NULL THEN COALESCE(${resultAttempts.solvedAt}, ${resultAttempts.createdAt}) ELSE NULL END`,
      // A current attempt pointer is an evidence-generation fence. Once set,
      // result-level classification reads force/video from that exact attempt
      // only; artifacts from an older solve of the same canonical result must
      // not make the replacement look complete. Pointer-less rows fail closed;
      // unscoped legacy artifacts remain historical/admin evidence only.
      hasForceHistory: sql<boolean>`CASE
        WHEN "results"."current_result_attempt_id" IS NOT NULL THEN EXISTS (
          SELECT 1
          FROM ${resultAttempts} current_attempt
          WHERE current_attempt.id = "results"."current_result_attempt_id"
            AND current_attempt.result_id = "results"."id"
            AND ${currentAttemptForce}
        )
        ELSE FALSE
      END`,
      hasVideo: sql<boolean>`CASE
        WHEN "results"."current_result_attempt_id" IS NOT NULL THEN EXISTS (
          SELECT 1 FROM ${resultMedia} media
          WHERE media.result_id = "results"."id"
            AND media.result_attempt_id = "results"."current_result_attempt_id"
            AND media.kind = 'video'
            AND media.role = 'instantaneous'
            AND media.mime_type LIKE 'video/%'
            AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
            AND media.byte_size > 0
            AND length(trim(media.storage_key)) > 0
        )
        ELSE FALSE
      END`,
      frameTrack: sql<unknown>`CASE
        WHEN ${results.currentResultAttemptId} IS NOT NULL THEN COALESCE(
          NULLIF(${resultAttempts.evidencePayload} -> 'frame_track', 'null'::jsonb),
          ${resultAttempts.evidencePayload} -> 'frameTrack'
        )
        ELSE NULL
      END`,
      fidelity: sql<string | null>`CASE
        WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.evidencePayload} ->> 'fidelity'
        ELSE NULL
      END`,
      steadyHistory: sql<unknown>`CASE
        WHEN ${results.currentResultAttemptId} IS NOT NULL THEN COALESCE(
          NULLIF(${resultAttempts.evidencePayload} -> 'steady_history', 'null'::jsonb),
          ${resultAttempts.evidencePayload} -> 'steadyHistory'
        )
        ELSE NULL
      END`,
      qualityWarnings: sql<string[] | null>`CASE
        WHEN ${results.currentResultAttemptId} IS NOT NULL THEN ${resultAttempts.qualityWarnings}
        ELSE NULL
      END`,
    })
    .from(results)
    .leftJoin(
      resultAttempts,
      and(
        eq(resultAttempts.id, results.currentResultAttemptId),
        eq(resultAttempts.resultId, results.id),
      ),
    )
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, simulationPresetRevisionId),
      ),
    );
  return rows.map(toEvidence);
}

async function loadAttemptEvidence(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
): Promise<EvidenceWithDbIds[]> {
  const exactAttemptForce = hasAttemptForceHistory(
    sql.raw('"result_attempts"."evidence_payload"'),
  );
  const rows = await db
    .select({
      id: resultAttempts.resultId,
      attemptId: resultAttempts.id,
      aoaDeg: resultAttempts.aoaDeg,
      cl: resultAttempts.cl,
      cd: resultAttempts.cd,
      cm: resultAttempts.cm,
      clCd: resultAttempts.clCd,
      status: resultAttempts.status,
      source: resultAttempts.source,
      regime: resultAttempts.regime,
      converged: resultAttempts.converged,
      stalled: resultAttempts.stalled,
      unsteady: resultAttempts.unsteady,
      error: resultAttempts.error,
      finalResidual: resultAttempts.finalResidual,
      iterations: resultAttempts.iterations,
      firstOrderFallback: resultAttempts.firstOrderFallback,
      validForPolar: resultAttempts.validForPolar,
      simJobId: resultAttempts.simJobId,
      engineJobId: resultAttempts.engineJobId,
      updatedAt: sql<Date>`COALESCE(${resultAttempts.solvedAt}, ${resultAttempts.createdAt})`,
      hasForceHistory: exactAttemptForce,
      hasVideo: sql<boolean>`exists (
        select 1 from ${resultMedia} media
        where media.result_id = "result_attempts"."result_id"
          and media.result_attempt_id = "result_attempts"."id"
          and media.kind = 'video'
          and media.role = 'instantaneous'
          and media.mime_type LIKE 'video/%'
          and media.sha256 ~ '^[0-9a-fA-F]{64}$'
          and media.byte_size > 0
          and length(trim(media.storage_key)) > 0
      )`,
      // Attempts keep the whole engine PolarPoint as evidence_payload; the
      // frame_track key inside it feeds the same stationarity gate. JSON null
      // and key-absent both surface as SQL NULL → legacy gate.
      frameTrack: sql<unknown>`COALESCE(
        NULLIF("result_attempts"."evidence_payload" -> 'frame_track', 'null'::jsonb),
        "result_attempts"."evidence_payload" -> 'frameTrack'
      )`,
      // Ladder evidence lives inside the same verbatim engine PolarPoint.
      fidelity: sql<
        string | null
      >`"result_attempts"."evidence_payload" ->> 'fidelity'`,
      steadyHistory: sql<unknown>`COALESCE(
        NULLIF("result_attempts"."evidence_payload" -> 'steady_history', 'null'::jsonb),
        "result_attempts"."evidence_payload" -> 'steadyHistory'
      )`,
      qualityWarnings: resultAttempts.qualityWarnings,
    })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.airfoilId, airfoilId),
        eq(
          resultAttempts.simulationPresetRevisionId,
          simulationPresetRevisionId,
        ),
      ),
    );
  return rows.map(toEvidence);
}

async function upsertClassification(
  db: DB,
  c: PolarEvidenceClassification,
  airfoilId: string,
  simulationPresetRevisionId: string,
): Promise<void> {
  const evidence = c.evidence as EvidenceWithDbIds;
  const values = {
    resultId: evidence.resultAttemptId ? null : (evidence.resultId ?? null),
    resultAttemptId: evidence.resultAttemptId ?? null,
    airfoilId,
    simulationPresetRevisionId,
    aoaDeg: evidence.a,
    regime: evidence.regime,
    classifierVersion: POLAR_CLASSIFIER_VERSION,
    state: c.state,
    region: c.region,
    confidence: c.confidence,
    reasons: c.reasons,
    supersededByResultId: null,
  };
  // The conflict UPDATE must rewrite EVERY verdict-scoped column, regime and
  // classifierVersion included: a results row re-solved under a different
  // regime keeps its classification row, and an in-place update that skips
  // regime leaves 'rans' stamped on an accepted URANS verdict (prod row
  // 3db79ff8, 2026-07-05).
  if (values.resultAttemptId) {
    await db
      .insert(resultClassifications)
      .values(values)
      .onConflictDoUpdate({
        target: resultClassifications.resultAttemptId,
        set: {
          regime: values.regime,
          classifierVersion: values.classifierVersion,
          state: values.state,
          region: values.region,
          confidence: values.confidence,
          reasons: values.reasons,
          supersededByResultId: null,
        },
      });
    return;
  }
  if (!values.resultId) return;
  await db
    .insert(resultClassifications)
    .values(values)
    .onConflictDoUpdate({
      target: resultClassifications.resultId,
      set: {
        regime: values.regime,
        classifierVersion: values.classifierVersion,
        state: values.state,
        region: values.region,
        confidence: values.confidence,
        reasons: values.reasons,
        supersededByResultId: null,
      },
    });
}

/**
 * A canonical result projection may never upgrade the verdict of its selected
 * immutable attempt. Attempt classification is intentionally scoped to the
 * physical solver job that produced the evidence, while result classification
 * also evaluates the assembled public polar. The latter can add a conservative
 * downgrade, but it must not erase a job-local `needs_urans` verdict merely
 * because the rejected sibling that caused it has been withdrawn from the
 * public projection.
 */
function preserveSelectedAttemptDowngrades(
  resultClassificationsForFit: PolarEvidenceClassification[],
  attemptClassificationById: ReadonlyMap<string, PolarEvidenceClassification>,
): void {
  for (const resultClassification of resultClassificationsForFit) {
    const resultEvidence = resultClassification.evidence as EvidenceWithDbIds;
    const selectedAttemptId = resultEvidence.currentGenerationAttemptId;
    if (!selectedAttemptId || resultClassification.state !== "accepted") {
      continue;
    }
    const selectedAttemptClassification =
      attemptClassificationById.get(selectedAttemptId);
    if (selectedAttemptClassification?.state !== "needs_urans") continue;

    resultClassification.state = "needs_urans";
    resultClassification.region = selectedAttemptClassification.region;
    resultClassification.confidence = selectedAttemptClassification.confidence;
    resultClassification.reasons = [
      ...new Set([
        ...resultClassification.reasons,
        ...selectedAttemptClassification.reasons,
      ]),
    ];
  }
}

function signatureFor(
  classifications: PolarEvidenceClassification[],
  symmetryMirrored: boolean,
): string {
  const payload = classifications
    .filter((c) => {
      const e = c.evidence as EvidenceWithDbIds;
      return Boolean(e.resultId) && !e.resultAttemptId;
    })
    .map((c) => {
      const e = c.evidence as EvidenceWithDbIds;
      return [
        e.resultId,
        e.currentGenerationAttemptId ?? "",
        e.a,
        e.regime,
        c.state,
        e.cl,
        e.cd,
        e.cm,
        e.updatedAt?.toISOString?.() ?? "",
      ].join(":");
    })
    .sort()
    .join("|");
  // Toggling airfoils.isSymmetric must refresh fit sets even when the real
  // evidence rows are unchanged (spec §9.2), so mirroring marks the signature.
  return createHash("sha256")
    .update(symmetryMirrored ? `${payload}|sym:1` : payload)
    .digest("hex");
}

async function supersedeRansWithAcceptedUrans(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
): Promise<void> {
  const uransRows = await db
    .select({
      resultId: resultClassifications.resultId,
      aoaDeg: resultClassifications.aoaDeg,
    })
    .from(resultClassifications)
    .where(
      and(
        eq(resultClassifications.airfoilId, airfoilId),
        eq(
          resultClassifications.simulationPresetRevisionId,
          simulationPresetRevisionId,
        ),
        eq(resultClassifications.regime, "urans"),
        eq(resultClassifications.state, "accepted"),
      ),
    );
  for (const row of uransRows) {
    if (!row.resultId) continue;
    await db
      .update(resultClassifications)
      .set({
        state: "superseded_by_urans",
        region: "post_stall",
        confidence: 1,
        supersededByResultId: row.resultId,
        reasons: sql`array(select distinct unnest(${resultClassifications.reasons} || ARRAY['urans-replacement']::text[]))`,
      })
      .where(
        and(
          eq(resultClassifications.airfoilId, airfoilId),
          eq(
            resultClassifications.simulationPresetRevisionId,
            simulationPresetRevisionId,
          ),
          eq(resultClassifications.aoaDeg, row.aoaDeg),
          eq(resultClassifications.regime, "rans"),
          inArray(resultClassifications.state, ["accepted", "needs_urans"]),
        ),
      );
  }
}

/** Fidelity ladder (contract 4): once a cell's results row holds an ACCEPTED
 *  full-fidelity URANS verification, the surviving precalc ATTEMPT evidence at
 *  the same angle is marked superseded_by_urans pointing at the verified row.
 *  Runs after every classification upsert pass (same re-assert discipline as
 *  supersedeRansWithAcceptedUrans — the upsert rewrites attempt verdicts each
 *  refresh, so the supersession must be re-derived each refresh too). */
async function supersedePrecalcWithVerifiedUrans(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE result_classifications rc
    SET state = 'superseded_by_urans',
        superseded_by_result_id = r.id,
        reasons = array(SELECT DISTINCT unnest(rc.reasons || ARRAY['urans-verify-replacement']::text[])),
        "updatedAt" = now()
    FROM results r
    JOIN result_classifications vrc ON vrc.result_id = r.id
    LEFT JOIN result_attempts current_attempt
      ON current_attempt.id = r.current_result_attempt_id
     AND current_attempt.result_id = r.id
    CROSS JOIN result_attempts precalc_attempt
    WHERE r.airfoil_id = ${airfoilId}
      AND r.simulation_preset_revision_id = ${simulationPresetRevisionId}
      AND r.current_result_attempt_id IS NOT NULL
      AND current_attempt.regime = 'urans'
      AND current_attempt.evidence_payload ->> 'fidelity' = 'urans_full'
      AND vrc.state = 'accepted'
      AND rc.result_attempt_id IS NOT NULL
      AND precalc_attempt.id = rc.result_attempt_id
      AND precalc_attempt.result_id = r.id
      AND precalc_attempt.id <> current_attempt.id
      AND precalc_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      AND rc.airfoil_id = ${airfoilId}
      AND rc.simulation_preset_revision_id = ${simulationPresetRevisionId}
      AND rc.aoa_deg = current_attempt.aoa_deg
      AND rc.regime = 'urans'
      AND rc.state IN ('accepted', 'needs_urans')
  `);
}

/** Enforce the exact-generation publication invariant after every attempt
 * classification pass. Promotion hooks run first so a newly accepted attempt
 * can replace a previously selected generation using its observed-pointer
 * CAS. Any pointer still lacking its own accepted/provisional verdict is then
 * removed before result evidence or fitted read models are published.
 *
 * Cache retirement and pointer clearing share the revision-locked transaction;
 * readers therefore observe either the previous complete generation or the
 * rebuilt fail-closed generation, never a rejected pointer with a current fit.
 */
async function retireInvalidSelectedAttempts(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
  compatibilityHash: string | null,
): Promise<number> {
  const eligibleExactClassification = sql`EXISTS (
    SELECT 1
    FROM ${resultClassifications} selected_classification
    JOIN ${resultAttempts} selected_attempt
      ON selected_attempt.id = selected_classification.result_attempt_id
     AND selected_attempt.result_id = ${results.id}
    WHERE selected_classification.result_attempt_id = ${results.currentResultAttemptId}
      AND selected_attempt.airfoil_id = ${results.airfoilId}
      AND selected_attempt.simulation_preset_revision_id = ${results.simulationPresetRevisionId}
      AND selected_attempt.aoa_deg = ${results.aoaDeg}
      AND selected_classification.airfoil_id = ${results.airfoilId}
      AND selected_classification.simulation_preset_revision_id = ${results.simulationPresetRevisionId}
      AND selected_classification.aoa_deg = selected_attempt.aoa_deg
      AND selected_classification.regime IS NOT DISTINCT FROM selected_attempt.regime
      AND selected_classification.state IN ('accepted', 'needs_urans')
      AND EXISTS (
        SELECT 1
        FROM solver_evidence_artifacts selected_manifest
        WHERE selected_manifest.result_id = ${results.id}
          AND selected_manifest.result_attempt_id = selected_attempt.id
          AND selected_manifest.kind = 'manifest'
        HAVING count(*) = 1
          AND bool_and(
            selected_manifest.airfoil_id = ${results.airfoilId}
            AND selected_manifest.aoa_deg IS NOT DISTINCT FROM selected_attempt.aoa_deg
            AND selected_manifest.sim_job_id IS NOT DISTINCT FROM selected_attempt.sim_job_id
            AND selected_manifest.engine_job_id IS NOT DISTINCT FROM selected_attempt.engine_job_id
            AND selected_manifest.engine_case_slug IS NOT DISTINCT FROM selected_attempt.engine_case_slug
            AND selected_manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
            AND selected_manifest.byte_size > 0
            AND length(trim(selected_manifest.storage_key)) > 0
            AND length(trim(selected_manifest.mime_type)) > 0
          )
      )
  )`;
  const invalidSelected = await db
    .select({ id: results.id })
    .from(results)
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, simulationPresetRevisionId),
        isNotNull(results.currentResultAttemptId),
        sql`NOT (${eligibleExactClassification})`,
      ),
    )
    .orderBy(results.id)
    .for("update");
  if (!invalidSelected.length) return 0;

  // Retire every current version for the affected revision/hash before the
  // pointer is removed. The normal refresh below creates the replacement fit;
  // compatibility aggregation is rebuilt only from committed exact pointers.
  await db
    .update(polarFitSets)
    .set({ isCurrent: false })
    .where(
      and(
        eq(polarFitSets.airfoilId, airfoilId),
        eq(polarFitSets.simulationPresetRevisionId, simulationPresetRevisionId),
        eq(polarFitSets.isCurrent, true),
      ),
    );
  if (compatibilityHash) {
    await db
      .update(polarCompatibilityFitSets)
      .set({ isCurrent: false })
      .where(
        and(
          eq(polarCompatibilityFitSets.airfoilId, airfoilId),
          eq(polarCompatibilityFitSets.compatibilityHash, compatibilityHash),
          eq(polarCompatibilityFitSets.isCurrent, true),
        ),
      );
  }

  const cleared = await db
    .update(results)
    .set({ currentResultAttemptId: null, updatedAt: new Date() })
    .where(
      and(
        inArray(
          results.id,
          invalidSelected.map((row) => row.id),
        ),
        isNotNull(results.currentResultAttemptId),
        sql`NOT (${eligibleExactClassification})`,
      ),
    )
    .returning({ id: results.id });
  return cleared.length;
}

async function storeFit(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
  classifications: PolarEvidenceClassification[],
  symmetric: boolean,
  hooks?: PolarCacheRefreshHooks,
): Promise<{ fitSetId: string | null; status: string }> {
  const [revision] = await db
    .select({
      reynolds: simulationPresetRevisions.reynolds,
      mach: simulationPresetRevisions.mach,
    })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, simulationPresetRevisionId))
    .limit(1);
  // Symmetric airfoils mirror accepted/needs_urans +α evidence onto the negative
  // side at fit-assembly time only (spec §9.2) — result_classifications rows stay
  // real solves. A real solve at the mirrored α always wins over a mirror copy.
  let fitInput = classifications;
  if (symmetric) {
    const realUsableAoas = new Set(
      classifications
        .filter((c) => c.state === "accepted" || c.state === "needs_urans")
        .map((c) => canonicalAoa(c.evidence.a)),
    );
    const mirrored = mirrorClassifiedEvidence(classifications).filter(
      (m) => !realUsableAoas.has(canonicalAoa(m.evidence.a)),
    );
    fitInput = [...classifications, ...mirrored];
  }
  const fit = buildPolarFit(fitInput);
  const metrics = fit.metrics;
  const aoas = fit.points.map((p) => p.a);
  const evidenceSignature = signatureFor(classifications, symmetric);
  // Stored point counts stay real-solve-only (they feed Browse polarCount and
  // ranking tie-breaks); mirrored copies only widen fit points/metrics.
  const acceptedPointCount = classifications.filter(
    (c) => c.state === "accepted",
  ).length;
  const provisionalPointCount = classifications.filter(
    (c) => c.state === "needs_urans",
  ).length;
  const rejectedPointCount = classifications.filter(
    (c) => c.state === "rejected" || c.state === "superseded_by_urans",
  ).length;
  // Retire EVERY current row for the pair, not just same-version rows: a
  // POLAR_FIT_VERSION bump refreshes lazily, and leaving the prior-version
  // row co-current makes single-current readers (detail fitByRevision map,
  // catalog metrics) nondeterministic between the stale and fresh fit.
  await db
    .update(polarFitSets)
    .set({ isCurrent: false })
    .where(
      and(
        eq(polarFitSets.airfoilId, airfoilId),
        eq(polarFitSets.simulationPresetRevisionId, simulationPresetRevisionId),
        eq(polarFitSets.isCurrent, true),
      ),
    );
  const [fitSet] = await db
    .insert(polarFitSets)
    .values({
      airfoilId,
      simulationPresetRevisionId,
      fitVersion: POLAR_FIT_VERSION,
      evidenceSignature,
      status: fit.status,
      confidence: fit.confidence,
      acceptedPointCount,
      provisionalPointCount,
      rejectedPointCount,
      reynolds: revision?.reynolds ?? null,
      mach: revision?.mach ?? null,
      ldmax: metrics?.ldmax ?? null,
      alphaLdmax: metrics?.aLd ?? null,
      alphaLdmaxFine: metrics?.alphaLdmaxFine ?? null,
      alphaClZeroFine: metrics?.alphaClZeroFine ?? null,
      alphaClmaxFine: metrics?.alphaClmaxFine ?? null,
      clmax: metrics?.clmax ?? null,
      alphaClmax: metrics?.aStall ?? null,
      cdmin: metrics?.cdmin ?? null,
      clAtCdmin: metrics?.clCd ?? null,
      cd0: metrics?.cd0 ?? null,
      cm0: metrics?.cm0 ?? null,
      aoaMin: aoas.length ? Math.min(...aoas) : null,
      aoaMax: aoas.length ? Math.max(...aoas) : null,
      isCurrent: true,
    })
    .onConflictDoUpdate({
      target: [
        polarFitSets.airfoilId,
        polarFitSets.simulationPresetRevisionId,
        polarFitSets.fitVersion,
        polarFitSets.evidenceSignature,
      ],
      set: {
        status: fit.status,
        confidence: fit.confidence,
        acceptedPointCount,
        provisionalPointCount,
        rejectedPointCount,
        reynolds: revision?.reynolds ?? null,
        mach: revision?.mach ?? null,
        ldmax: metrics?.ldmax ?? null,
        alphaLdmax: metrics?.aLd ?? null,
        alphaLdmaxFine: metrics?.alphaLdmaxFine ?? null,
        alphaClZeroFine: metrics?.alphaClZeroFine ?? null,
        alphaClmaxFine: metrics?.alphaClmaxFine ?? null,
        clmax: metrics?.clmax ?? null,
        alphaClmax: metrics?.aStall ?? null,
        cdmin: metrics?.cdmin ?? null,
        clAtCdmin: metrics?.clCd ?? null,
        cd0: metrics?.cd0 ?? null,
        cm0: metrics?.cm0 ?? null,
        aoaMin: aoas.length ? Math.min(...aoas) : null,
        aoaMax: aoas.length ? Math.max(...aoas) : null,
        isCurrent: true,
      },
    })
    .returning({ id: polarFitSets.id, status: polarFitSets.status });

  if (!fitSet) return { fitSetId: null, status: "insufficient" };
  await db.delete(polarFitPoints).where(eq(polarFitPoints.fitSetId, fitSet.id));
  await hooks?.afterFitPointsDeleted?.();
  if (fit.points.length) {
    await db.insert(polarFitPoints).values(
      fit.points.map((p) => ({
        fitSetId: fitSet.id,
        aoaDeg: p.a,
        cl: p.cl,
        cd: p.cd,
        cm: p.cm,
        clCd: p.ld,
      })),
    );
  }
  return { fitSetId: fitSet.id, status: fit.status };
}

export async function refreshPolarCacheForRevision(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
  hooks?: PolarCacheRefreshHooks,
): Promise<PolarCacheRefreshResult> {
  const refreshed = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const compatibilityHash = await resolveRevisionPhysicsHash(
      tx,
      simulationPresetRevisionId,
    );
    // Global lock order is compatibility aggregate -> revision -> result rows.
    // The post-commit compatibility rebuild also starts with the aggregate
    // lock; taking revision first here can deadlock when a concurrent refresh
    // holds a result-row update while the prior rebuild inserts FK members.
    if (compatibilityHash) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polar-compatibility:${POLAR_COMPATIBILITY_VERSION}:${airfoilId}:${compatibilityHash}`}, 0))`,
      );
    }
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polar-revision:${airfoilId}:${simulationPresetRevisionId}`}, 0))`,
    );
    const persistedCompatibilityHash = await ensureRevisionPhysicsHash(
      tx,
      simulationPresetRevisionId,
    );
    if (persistedCompatibilityHash !== compatibilityHash) {
      throw new Error(
        `revision physics hash changed while acquiring ordered polar locks (${simulationPresetRevisionId})`,
      );
    }
    await hooks?.beforeEvidenceLoad?.(tx);
    const [airfoilRow] = await tx
      .select({ isSymmetric: airfoils.isSymmetric })
      .from(airfoils)
      .where(eq(airfoils.id, airfoilId))
      .limit(1);
    const symmetric = airfoilRow?.isSymmetric ?? false;
    const attemptEvidence = await loadAttemptEvidence(
      tx,
      airfoilId,
      simulationPresetRevisionId,
    );
    const attemptEvidenceByJob = new Map<string, EvidenceWithDbIds[]>();
    for (const evidence of attemptEvidence) {
      // Attempt classification is scoped to the physical solver job/sweep that
      // produced it.  Retention sets sim_job_id NULL, and remote attempts are
      // intentionally unbound locally, so collapsing every such row into one
      // "unscoped" sweep lets an unrelated low-AoA failure downgrade all other
      // historical/remote attempts.  The immutable engine job is the durable
      // fallback; a truly legacy attempt with neither id is isolated by its own
      // attempt id rather than guessed into a shared sweep.
      const key = evidence.simJobId
        ? `sim:${evidence.simJobId}`
        : evidence.engineJobId
          ? `engine:${evidence.engineJobId}`
          : `attempt:${evidence.resultAttemptId ?? evidence.resultId ?? "unknown"}`;
      const bucket = attemptEvidenceByJob.get(key);
      if (bucket) {
        bucket.push(evidence);
      } else {
        attemptEvidenceByJob.set(key, [evidence]);
      }
    }
    const attemptClassifiedGroups = [...attemptEvidenceByJob.values()].map(
      (group) => classifyPolarEvidence(group),
    );
    const attemptClassifications = attemptClassifiedGroups.flatMap(
      (group) => group.classifications,
    );
    const attemptClassificationById = new Map(
      attemptClassifications.flatMap((classification) => {
        const evidence = classification.evidence as EvidenceWithDbIds;
        return evidence.resultAttemptId
          ? ([[evidence.resultAttemptId, classification]] as const)
          : [];
      }),
    );

    for (const c of attemptClassifications) {
      await upsertClassification(tx, c, airfoilId, simulationPresetRevisionId);
    }
    await hooks?.afterAttemptClassifications?.(tx);

    // Promotion hooks must run first because they compare against the pointer
    // observed while staging/importing. Once a valid replacement had that
    // opportunity, withdraw every still-selected ineligible generation before
    // loading the canonical result projection.
    await retireInvalidSelectedAttempts(
      tx,
      airfoilId,
      simulationPresetRevisionId,
      compatibilityHash,
    );

    // Canonical result evidence is intentionally loaded only after the exact
    // generation-selection hook. Result classification and fit therefore
    // observe the selected pointer from the same revision-locked transaction,
    // never a pre-promotion snapshot.
    let resultEvidence = await loadResultEvidence(
      tx,
      airfoilId,
      simulationPresetRevisionId,
    );
    let resultClassified = classifyPolarEvidence(resultEvidence);
    preserveSelectedAttemptDowngrades(
      resultClassified.classifications,
      attemptClassificationById,
    );
    for (const c of resultClassified.classifications) {
      await upsertClassification(tx, c, airfoilId, simulationPresetRevisionId);
    }
    await supersedeRansWithAcceptedUrans(
      tx,
      airfoilId,
      simulationPresetRevisionId,
    );
    await supersedePrecalcWithVerifiedUrans(
      tx,
      airfoilId,
      simulationPresetRevisionId,
    );

    // Supersession normally targets historical RANS/PRECALC attempts, not the
    // selected URANS/full generation that proves the replacement. Reassert the
    // same invariant after those derived writes anyway, so a future change to
    // supersession cannot leave a newly ineligible exact pointer published.
    const supersededPointerCount = await retireInvalidSelectedAttempts(
      tx,
      airfoilId,
      simulationPresetRevisionId,
      compatibilityHash,
    );
    if (supersededPointerCount > 0) {
      // The first snapshot intentionally let supersession observe the selected
      // generation. Once invalid pointers are retired, rebuild result-level
      // classifications from the final pointer-null projection before fitting.
      resultEvidence = await loadResultEvidence(
        tx,
        airfoilId,
        simulationPresetRevisionId,
      );
      resultClassified = classifyPolarEvidence(resultEvidence);
      preserveSelectedAttemptDowngrades(
        resultClassified.classifications,
        attemptClassificationById,
      );
      for (const c of resultClassified.classifications) {
        await upsertClassification(
          tx,
          c,
          airfoilId,
          simulationPresetRevisionId,
        );
      }
    }

    const resultEvidenceById = new Map(
      resultEvidence
        .filter((evidence) => evidence.resultId)
        .map((evidence) => [evidence.resultId!, evidence]),
    );
    const freshResultClassifications = await tx
      .select({
        resultId: resultClassifications.resultId,
        state: resultClassifications.state,
        region: resultClassifications.region,
        confidence: resultClassifications.confidence,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(
        and(
          eq(resultClassifications.airfoilId, airfoilId),
          eq(
            resultClassifications.simulationPresetRevisionId,
            simulationPresetRevisionId,
          ),
          isNotNull(resultClassifications.resultId),
        ),
      );
    const activeVerdicts = await activeReviewVerdicts(
      tx,
      freshResultClassifications
        .map((row) => row.resultId)
        .filter((id): id is string => Boolean(id)),
    );
    const fitClassifications: PolarEvidenceClassification[] =
      freshResultClassifications
        .map((row): PolarEvidenceClassification | null => {
          const evidence = row.resultId
            ? resultEvidenceById.get(row.resultId)
            : undefined;
          if (!evidence) return null;
          return {
            evidence,
            state: row.state,
            region: row.region,
            confidence: row.confidence,
            reasons: row.reasons,
          };
        })
        .filter(
          (classification): classification is PolarEvidenceClassification =>
            classification !== null,
        )
        .filter((classification) => {
          const evidence = classification.evidence as EvidenceWithDbIds;
          return (
            activeVerdicts.get(evidence.resultId ?? "")?.verdict !== "exclude"
          );
        });
    const storedFit = await storeFit(
      tx,
      airfoilId,
      simulationPresetRevisionId,
      fitClassifications,
      symmetric,
      hooks,
    );
    if (compatibilityHash) {
      // Publication is two-phase by design: make stale aggregate data
      // unavailable in the same commit as pointer/classification/revision-fit
      // promotion, then rebuild the aggregate from committed state below.
      // The aggregate lock was acquired before the revision lock above, so a
      // concurrent compatibility rebuild cannot republish the old projection
      // in this pointer-commit window.
      await tx
        .update(polarCompatibilityFitSets)
        .set({ isCurrent: false })
        .where(
          and(
            eq(polarCompatibilityFitSets.airfoilId, airfoilId),
            eq(
              polarCompatibilityFitSets.compatibilityVersion,
              POLAR_COMPATIBILITY_VERSION,
            ),
            eq(polarCompatibilityFitSets.compatibilityHash, compatibilityHash),
            eq(polarCompatibilityFitSets.isCurrent, true),
          ),
        );
    }
    const attemptNeeds = attemptClassifiedGroups.flatMap(
      (group) => group.needsUransAoas,
    );
    const resultNeeds = resultClassified.needsUransAoas;
    const attemptRejected = attemptClassifiedGroups.flatMap(
      (group) => group.hardRejectedAoas,
    );
    const resultRejected = resultClassified.hardRejectedAoas;

    return {
      compatibilityHash,
      result: {
        airfoilId,
        simulationPresetRevisionId,
        needsUransAoas: [...new Set([...attemptNeeds, ...resultNeeds])].sort(
          (a, b) => a - b,
        ),
        hardRejectedAoas: [
          ...new Set([...attemptRejected, ...resultRejected]),
        ].sort((a, b) => a - b),
        lowAoaFailure:
          attemptClassifiedGroups.some((group) => group.lowAoaFailure) ||
          resultClassified.lowAoaFailure,
        fitSetId: storedFit.fitSetId,
        fitStatus: storedFit.status,
      },
    };
  });
  // Compatibility aggregation owns a separate lock/transaction and must read
  // only committed revision classification + fit state.  Keeping it outside
  // the revision transaction avoids a pseudo-nested transaction on the same
  // connection and preserves clear lock ordering.
  if (refreshed.compatibilityHash) {
    await refreshPolarCompatibilityCache(
      db,
      airfoilId,
      refreshed.compatibilityHash,
    );
  }
  return refreshed.result;
}

// Whole-polar URANS promotion was KILLED by the fidelity ladder (R2,
// 2026-07-07): background retries are targeted-only (apps/sweeper/src/
// retry-plan.ts decideRansRetry); whole-polar URANS is an explicit admin
// request (sim_urans_requests, aoa_deg NULL). The old shouldPromoteWholePolar
// heuristics and ransRetryPlanForJob were removed so no future caller can
// silently revive the escalation.
