import {
  buildPolarFit,
  canonicalAoa,
  classifyPolarEvidence,
  mirrorClassifiedEvidence,
  POLAR_CLASSIFIER_VERSION,
  POLAR_FIT_VERSION,
  type PolarEvidenceClassification,
  type PolarEvidencePoint,
  type ResultClassificationState,
} from "@aerodb/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DB } from "./client";
import {
  airfoils,
  forceHistory,
  polarFitPoints,
  polarFitSets,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  simulationPresetRevisions,
} from "./schema";

type EvidenceWithDbIds = PolarEvidencePoint & {
  resultId?: string | null;
  resultAttemptId?: string | null;
  simJobId?: string | null;
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

export interface RansRetryPlan {
  aoas: number[];
  queueCanonicalAoas: number[];
  retryMode: "whole-polar-urans" | "needs-urans-confirmation" | "invalid-rans-points";
  fullUrans: boolean;
  validRansPointCount: number;
  needsUransCount: number;
  hardRejectedCount: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toEvidence(row: {
  id?: string | null;
  attemptId?: string | null;
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
  simJobId?: string | null;
  updatedAt?: Date | null;
}): EvidenceWithDbIds {
  return {
    id: row.id ?? null,
    resultId: row.id ?? null,
    attemptId: row.attemptId ?? null,
    resultAttemptId: row.attemptId ?? null,
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
    simJobId: row.simJobId ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

async function loadResultEvidence(db: DB, airfoilId: string, simulationPresetRevisionId: string): Promise<EvidenceWithDbIds[]> {
  const rows = await db
    .select({
      id: results.id,
      aoaDeg: results.aoaDeg,
      cl: results.cl,
      cd: results.cd,
      cm: results.cm,
      clCd: results.clCd,
      status: results.status,
      source: results.source,
      regime: results.regime,
      converged: results.converged,
      stalled: results.stalled,
      unsteady: results.unsteady,
      error: results.error,
      finalResidual: results.finalResidual,
      iterations: results.iterations,
      firstOrderFallback: results.firstOrderFallback,
      updatedAt: results.updatedAt,
      // NOTE: the correlated column MUST be table-qualified by hand. Drizzle
      // renders `${results.id}` inside a sql`` fragment as unqualified "id",
      // which Postgres scope-resolves to the SUBQUERY's own table
      // (fh.result_id = fh.id — always false), silently reporting every
      // result as having no force history / video (prod defect, 2026-07-05).
      hasForceHistory: sql<boolean>`exists (select 1 from ${forceHistory} fh where fh.result_id = "results"."id")`,
      hasVideo: sql<boolean>`exists (select 1 from ${resultMedia} media where media.result_id = "results"."id" and media.kind = 'video' and media.role = 'instantaneous')`,
    })
    .from(results)
    .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, simulationPresetRevisionId)));
  return rows.map(toEvidence);
}

async function loadAttemptEvidence(db: DB, airfoilId: string, simulationPresetRevisionId: string): Promise<EvidenceWithDbIds[]> {
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
      updatedAt: resultAttempts.createdAt,
      // Same hand-qualification rule as loadResultEvidence: an unqualified
      // "result_id" here binds to the subquery's OWN result_id column
      // (media.result_id = media.result_id — always true), inventing
      // evidence for every attempt.
      hasForceHistory: sql<boolean>`exists (select 1 from ${forceHistory} fh where fh.result_id = "result_attempts"."result_id")`,
      hasVideo: sql<boolean>`exists (select 1 from ${resultMedia} media where media.result_id = "result_attempts"."result_id" and media.kind = 'video' and media.role = 'instantaneous')`,
    })
    .from(resultAttempts)
    .where(and(eq(resultAttempts.airfoilId, airfoilId), eq(resultAttempts.simulationPresetRevisionId, simulationPresetRevisionId)));
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

function signatureFor(classifications: PolarEvidenceClassification[], symmetryMirrored: boolean): string {
  const payload = classifications
    .filter((c) => {
      const e = c.evidence as EvidenceWithDbIds;
      return Boolean(e.resultId) && !e.resultAttemptId;
    })
    .map((c) => {
      const e = c.evidence as EvidenceWithDbIds;
      return [
        e.resultId,
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

async function supersedeRansWithAcceptedUrans(db: DB, airfoilId: string, simulationPresetRevisionId: string): Promise<void> {
  const uransRows = await db
    .select({ resultId: resultClassifications.resultId, aoaDeg: resultClassifications.aoaDeg })
    .from(resultClassifications)
    .where(
      and(
        eq(resultClassifications.airfoilId, airfoilId),
        eq(resultClassifications.simulationPresetRevisionId, simulationPresetRevisionId),
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
          eq(resultClassifications.simulationPresetRevisionId, simulationPresetRevisionId),
          eq(resultClassifications.aoaDeg, row.aoaDeg),
          eq(resultClassifications.regime, "rans"),
          inArray(resultClassifications.state, ["accepted", "needs_urans"]),
        ),
      );
  }
}

async function storeFit(
  db: DB,
  airfoilId: string,
  simulationPresetRevisionId: string,
  classifications: PolarEvidenceClassification[],
  symmetric: boolean,
): Promise<{ fitSetId: string | null; status: string }> {
  const [revision] = await db
    .select({ reynolds: simulationPresetRevisions.reynolds, mach: simulationPresetRevisions.mach })
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
  const acceptedPointCount = classifications.filter((c) => c.state === "accepted").length;
  const provisionalPointCount = classifications.filter((c) => c.state === "needs_urans").length;
  const rejectedPointCount = classifications.filter((c) => c.state === "rejected" || c.state === "superseded_by_urans").length;
  await db
    .update(polarFitSets)
    .set({ isCurrent: false })
    .where(
      and(
        eq(polarFitSets.airfoilId, airfoilId),
        eq(polarFitSets.simulationPresetRevisionId, simulationPresetRevisionId),
        eq(polarFitSets.fitVersion, POLAR_FIT_VERSION),
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
      target: [polarFitSets.airfoilId, polarFitSets.simulationPresetRevisionId, polarFitSets.fitVersion, polarFitSets.evidenceSignature],
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
): Promise<PolarCacheRefreshResult> {
  const [airfoilRow] = await db
    .select({ isSymmetric: airfoils.isSymmetric })
    .from(airfoils)
    .where(eq(airfoils.id, airfoilId))
    .limit(1);
  const symmetric = airfoilRow?.isSymmetric ?? false;
  const resultEvidence = await loadResultEvidence(db, airfoilId, simulationPresetRevisionId);
  const attemptEvidence = await loadAttemptEvidence(db, airfoilId, simulationPresetRevisionId);
  const resultClassified = classifyPolarEvidence(resultEvidence);
  const attemptEvidenceByJob = new Map<string, EvidenceWithDbIds[]>();
  for (const evidence of attemptEvidence) {
    const key = evidence.simJobId ?? "__unscoped__";
    const bucket = attemptEvidenceByJob.get(key);
    if (bucket) {
      bucket.push(evidence);
    } else {
      attemptEvidenceByJob.set(key, [evidence]);
    }
  }
  const attemptClassifiedGroups = [...attemptEvidenceByJob.values()].map((group) => classifyPolarEvidence(group));
  const attemptClassifications = attemptClassifiedGroups.flatMap((group) => group.classifications);

  for (const c of [...resultClassified.classifications, ...attemptClassifications]) {
    await upsertClassification(db, c, airfoilId, simulationPresetRevisionId);
  }
  await supersedeRansWithAcceptedUrans(db, airfoilId, simulationPresetRevisionId);

  const freshResultClassifications = await db
    .select({
      resultId: resultClassifications.resultId,
      aoaDeg: resultClassifications.aoaDeg,
      regime: resultClassifications.regime,
      state: resultClassifications.state,
      region: resultClassifications.region,
      confidence: resultClassifications.confidence,
      reasons: resultClassifications.reasons,
      cl: results.cl,
      cd: results.cd,
      cm: results.cm,
      clCd: results.clCd,
      status: results.status,
      source: results.source,
      converged: results.converged,
      stalled: results.stalled,
      unsteady: results.unsteady,
      error: results.error,
      finalResidual: results.finalResidual,
      iterations: results.iterations,
      firstOrderFallback: results.firstOrderFallback,
      updatedAt: results.updatedAt,
    })
    .from(resultClassifications)
    .innerJoin(results, eq(results.id, resultClassifications.resultId))
    .where(
      and(
        eq(resultClassifications.airfoilId, airfoilId),
        eq(resultClassifications.simulationPresetRevisionId, simulationPresetRevisionId),
      ),
    );
  const fitClassifications: PolarEvidenceClassification[] = freshResultClassifications.map((row) => ({
    evidence: toEvidence({ id: row.resultId, ...row, hasForceHistory: true, hasVideo: true }),
    state: row.state,
    region: row.region,
    confidence: row.confidence,
    reasons: row.reasons,
  }));
  const storedFit = await storeFit(db, airfoilId, simulationPresetRevisionId, fitClassifications, symmetric);
  const attemptNeeds = attemptClassifiedGroups.flatMap((group) => group.needsUransAoas);
  const resultNeeds = resultClassified.needsUransAoas;
  const attemptRejected = attemptClassifiedGroups.flatMap((group) => group.hardRejectedAoas);
  const resultRejected = resultClassified.hardRejectedAoas;

  return {
    airfoilId,
    simulationPresetRevisionId,
    needsUransAoas: [...new Set([...attemptNeeds, ...resultNeeds])].sort((a, b) => a - b),
    hardRejectedAoas: [...new Set([...attemptRejected, ...resultRejected])].sort((a, b) => a - b),
    lowAoaFailure: attemptClassifiedGroups.some((group) => group.lowAoaFailure) || resultClassified.lowAoaFailure,
    fitSetId: storedFit.fitSetId,
    fitStatus: storedFit.status,
  };
}

function shouldPromoteWholePolarToUrans(rows: { aoaDeg: number; state: ResultClassificationState }[]): boolean {
  const hasRejected = rows.some((r) => r.state === "rejected");
  if (rows.some((r) => r.aoaDeg >= 0 && r.aoaDeg <= 5 && r.state === "rejected")) return true;
  if (!hasRejected) return false;
  const validAoas = rows
    .filter((r) => r.state === "accepted" || r.state === "needs_urans")
    .map((r) => r.aoaDeg)
    .sort((a, b) => a - b);
  if (validAoas.length < 5) return true;
  const step = validAoas.length > 1 ? Math.min(...validAoas.slice(1).map((x, i) => x - validAoas[i]).filter((d) => d > 0)) : 1;
  let longest = validAoas.length ? 1 : 0;
  let current = longest;
  for (let i = 1; i < validAoas.length; i++) {
    if (validAoas[i] - validAoas[i - 1] <= step * 1.5 + 1e-9) {
      current += 1;
    } else {
      longest = Math.max(longest, current);
      current = 1;
    }
  }
  longest = Math.max(longest, current);
  return longest < 5;
}

export async function ransRetryPlanForJob(db: DB, parentJobId: string): Promise<RansRetryPlan | null> {
  const rows = await db
    .select({
      aoaDeg: resultAttempts.aoaDeg,
      state: resultClassifications.state,
    })
    .from(resultAttempts)
    .innerJoin(resultClassifications, eq(resultClassifications.resultAttemptId, resultAttempts.id))
    .where(and(eq(resultAttempts.simJobId, parentJobId), eq(resultAttempts.regime, "rans")));
  if (!rows.length) return null;

  const fullUrans = shouldPromoteWholePolarToUrans(rows);
  const hardRejectedAoas = rows.filter((r) => r.state === "rejected").map((r) => r.aoaDeg);
  const needsUransAoas = rows.filter((r) => r.state === "needs_urans").map((r) => r.aoaDeg);
  const aoas = (fullUrans ? rows.map((r) => r.aoaDeg) : [...needsUransAoas, ...hardRejectedAoas]).sort((a, b) => a - b);
  if (!aoas.length) return null;
  return {
    aoas: [...new Set(aoas)],
    queueCanonicalAoas: fullUrans ? [...new Set(aoas)] : [...new Set(hardRejectedAoas)].sort((a, b) => a - b),
    retryMode: fullUrans ? "whole-polar-urans" : needsUransAoas.length ? "needs-urans-confirmation" : "invalid-rans-points",
    fullUrans,
    validRansPointCount: rows.filter((r) => r.state === "accepted").length,
    needsUransCount: needsUransAoas.length,
    hardRejectedCount: hardRejectedAoas.length,
  };
}
