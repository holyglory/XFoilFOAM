import {
  buildPolarFit,
  canonicalAoa,
  hasIncompleteUransIntegrationWarning,
  INCOMPLETE_URANS_INTEGRATION_REASON,
  mirrorClassifiedEvidence,
  POLAR_CLASSIFIER_VERSION,
  POLAR_FIT_VERSION,
  type PolarEvidenceClassification,
  type PolarEvidencePoint,
} from "@aerodb/core";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DB } from "./client";
import { activeReviewVerdicts } from "./review-verdicts";
import {
  airfoils,
  polarCompatibilityFitMembers,
  polarCompatibilityFitPoints,
  polarCompatibilityFitSets,
  resultAttempts,
  resultClassifications,
  results,
  simulationPresetRevisions,
} from "./schema";
import {
  physicsHashForSnapshot,
  type SimulationSetupSnapshot,
} from "./simulation-setup";

// v4 makes the selected immutable attempt (including its attempt id) the
// complete compatibility-cache evidence source. Older v3 rows can contain a
// mutable result projection and are therefore never read as current v4 data.
export const POLAR_COMPATIBILITY_VERSION = "polar-compat-v4";
export const POLAR_COMPATIBILITY_MEMBER_ROLES = [
  "selected",
  "shadowed",
  "conflict",
] as const;
export type PolarCompatibilityMemberRole =
  (typeof POLAR_COMPATIBILITY_MEMBER_ROLES)[number];

export function polarCompatibilitySeriesId(compatibilityHash: string): string {
  return `${POLAR_COMPATIBILITY_VERSION}:${compatibilityHash}`;
}

function physicsHashFromStoredSnapshot(
  snapshot: Record<string, unknown>,
): string | null {
  try {
    return physicsHashForSnapshot(
      snapshot as unknown as SimulationSetupSnapshot,
    );
  } catch {
    // Historical malformed snapshots must not break exact revision ingestion
    // or merge with unrelated evidence. Leaving the hash NULL fails closed:
    // the revision stays isolated until an explicit repair can validate it.
    return null;
  }
}

type CompatibilityState = PolarEvidenceClassification["state"];
type CompatibilityRegion = PolarEvidenceClassification["region"];

export function compatibilityClassificationWithQualityGate(row: {
  state: CompatibilityState;
  region: CompatibilityRegion;
  reasons: string[];
  regime: "rans" | "urans" | null;
  qualityWarnings: string[] | null;
}): Pick<CompatibilityEvidenceRow, "state" | "region" | "reasons"> {
  const incompleteUrans =
    row.regime === "urans" &&
    hasIncompleteUransIntegrationWarning(row.qualityWarnings);
  return incompleteUrans
    ? {
        state: "rejected",
        region: "unknown",
        reasons: [
          ...new Set([...row.reasons, INCOMPLETE_URANS_INTEGRATION_REASON]),
        ],
      }
    : { state: row.state, region: row.region, reasons: row.reasons };
}

type CompatibilityEvidenceRow = {
  resultId: string;
  resultAttemptId: string;
  simulationPresetRevisionId: string;
  aoaDeg: number;
  state: CompatibilityState;
  region: CompatibilityRegion;
  reasons: string[];
  confidence: number;
  regime: "rans" | "urans" | null;
  fidelity: string | null;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  clCd: number | null;
  clStd: number | null;
  cdStd: number | null;
  cmStd: number | null;
  status: string;
  source: string;
  converged: boolean;
  stalled: boolean;
  unsteady: boolean;
  error: string | null;
  finalResidual: number | null;
  iterations: number | null;
  firstOrderFallback: boolean;
  resultUpdatedAt: Date;
  solvedAt: Date | null;
  qualityWarnings: string[] | null;
  reviewVerdict: null;
};

type CompatibilityCandidate = CompatibilityEvidenceRow & {
  cl: number;
  cd: number;
  selectionRank: number;
};
export type PolarCompatibilityCandidate = CompatibilityCandidate;

type CompatibilityMember = CompatibilityCandidate & {
  role: PolarCompatibilityMemberRole;
  selectionReason: string;
};

export interface PolarCompatibilityCacheRefreshResult {
  airfoilId: string;
  compatibilityVersion: string;
  compatibilityHash: string;
  fitSetId: string | null;
  fitStatus: string;
  conflictAoas: number[];
  selectedResultIds: string[];
}

export function polarCompatibilitySelectionRank(row: {
  state: CompatibilityState;
  fidelity: string | null;
  regime: "rans" | "urans" | null;
}): number {
  const classification =
    row.state === "accepted" ? 200 : row.state === "needs_urans" ? 100 : 0;
  const fidelity =
    row.fidelity === "urans_full"
      ? 30
      : row.fidelity === "urans_precalc"
        ? 20
        : row.fidelity === "rans" || row.regime === "rans"
          ? 10
          : row.regime === "urans"
            ? 20
            : 0;
  return classification + fidelity;
}

function asCandidate(
  row: CompatibilityEvidenceRow,
): CompatibilityCandidate | null {
  if (row.state !== "accepted" && row.state !== "needs_urans") return null;
  if (
    row.cl == null ||
    !Number.isFinite(row.cl) ||
    row.cd == null ||
    !Number.isFinite(row.cd) ||
    row.cd <= 0
  ) {
    return null;
  }
  return {
    ...row,
    cl: row.cl,
    cd: row.cd,
    selectionRank: polarCompatibilitySelectionRank(row),
  };
}

function deterministicCandidateOrder(
  a: CompatibilityCandidate,
  b: CompatibilityCandidate,
): number {
  const solved = (b.solvedAt?.getTime() ?? 0) - (a.solvedAt?.getTime() ?? 0);
  if (solved !== 0) return solved;
  const updated = b.resultUpdatedAt.getTime() - a.resultUpdatedAt.getTime();
  if (updated !== 0) return updated;
  return a.resultId.localeCompare(b.resultId);
}

function exactSameCoefficients(
  a: CompatibilityCandidate,
  b: CompatibilityCandidate,
): boolean {
  return a.cl === b.cl && a.cd === b.cd && a.cm === b.cm;
}

export function resolvePolarCompatibilityMembers(
  candidates: CompatibilityCandidate[],
): {
  members: CompatibilityMember[];
  selected: CompatibilityCandidate[];
  conflictAoas: number[];
} {
  const byAoa = new Map<number, CompatibilityCandidate[]>();
  for (const candidate of candidates) {
    const aoa = canonicalAoa(candidate.aoaDeg);
    const bucket = byAoa.get(aoa);
    if (bucket) bucket.push(candidate);
    else byAoa.set(aoa, [candidate]);
  }

  const members: CompatibilityMember[] = [];
  const selected: CompatibilityCandidate[] = [];
  const conflictAoas: number[] = [];
  for (const [aoa, bucket] of [...byAoa.entries()].sort(([a], [b]) => a - b)) {
    const maxRank = Math.max(
      ...bucket.map((candidate) => candidate.selectionRank),
    );
    const top = bucket
      .filter((candidate) => candidate.selectionRank === maxRank)
      .sort(deterministicCandidateOrder);
    const lower = bucket.filter(
      (candidate) => candidate.selectionRank !== maxRank,
    );
    const exactTie = top.every((candidate) =>
      exactSameCoefficients(top[0], candidate),
    );

    if (top.length > 1 && !exactTie) {
      conflictAoas.push(aoa);
      for (const candidate of top) {
        members.push({
          ...candidate,
          role: "conflict",
          selectionReason:
            "equal-ranked compatible evidence has differing coefficients; angle excluded from aggregate fit",
        });
      }
      for (const candidate of lower) {
        members.push({
          ...candidate,
          role: "shadowed",
          selectionReason: "lower-ranked evidence at a conflicting angle",
        });
      }
      continue;
    }

    const winner = top[0];
    selected.push(winner);
    members.push({
      ...winner,
      role: "selected",
      selectionReason:
        top.length > 1
          ? "deterministic winner among exact-equal top-ranked evidence"
          : "highest-ranked compatible evidence",
    });
    for (const candidate of top.slice(1)) {
      members.push({
        ...candidate,
        role: "shadowed",
        selectionReason:
          "exact-equal duplicate of selected top-ranked evidence",
      });
    }
    for (const candidate of lower) {
      members.push({
        ...candidate,
        role: "shadowed",
        selectionReason: "lower-ranked compatible evidence",
      });
    }
  }
  return { members, selected, conflictAoas };
}

function asClassification(
  candidate: CompatibilityCandidate,
): PolarEvidenceClassification {
  const evidence: PolarEvidencePoint = {
    id: candidate.resultId,
    a: candidate.aoaDeg,
    cl: candidate.cl,
    cd: candidate.cd,
    cm: candidate.cm,
    ld: candidate.clCd,
    status: candidate.status,
    source: candidate.source,
    regime: candidate.regime,
    converged: candidate.converged,
    stalled: candidate.stalled,
    unsteady: candidate.unsteady,
    error: candidate.error,
    finalResidual: candidate.finalResidual,
    iterations: candidate.iterations,
    firstOrderFallback: candidate.firstOrderFallback,
    fidelity: candidate.fidelity,
  };
  return {
    evidence,
    state: candidate.state,
    region: candidate.region,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
  };
}

function evidenceSignature(
  rows: CompatibilityEvidenceRow[],
  members: CompatibilityMember[],
  symmetric: boolean,
): string {
  const evidence = rows
    .map((row) => [
      row.resultId,
      row.resultAttemptId,
      row.simulationPresetRevisionId,
      canonicalAoa(row.aoaDeg),
      row.state,
      row.region,
      row.regime,
      row.fidelity,
      row.cl,
      row.cd,
      row.cm,
      row.clCd,
      row.reviewVerdict,
      row.qualityWarnings,
      row.resultUpdatedAt.toISOString(),
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const resolution = members
    .map((member) => [
      member.resultId,
      member.role,
      member.selectionRank,
      member.selectionReason,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return createHash("sha256")
    .update(
      JSON.stringify({
        compatibilityVersion: POLAR_COMPATIBILITY_VERSION,
        classifierVersion: POLAR_CLASSIFIER_VERSION,
        fitVersion: POLAR_FIT_VERSION,
        symmetric,
        evidence,
        resolution,
      }),
    )
    .digest("hex");
}

export async function ensureRevisionPhysicsHash(
  db: DB,
  simulationPresetRevisionId: string,
): Promise<string | null> {
  const [revision] = await db
    .select({
      id: simulationPresetRevisions.id,
      physicsHash: simulationPresetRevisions.physicsHash,
      snapshot: simulationPresetRevisions.snapshot,
    })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, simulationPresetRevisionId))
    .limit(1);
  if (!revision) return null;
  if (revision.physicsHash) return revision.physicsHash;
  const physicsHash = physicsHashFromStoredSnapshot(revision.snapshot);
  if (!physicsHash) return null;
  await db
    .update(simulationPresetRevisions)
    .set({ physicsHash, isCanonicalPhysics: false })
    .where(
      and(
        eq(simulationPresetRevisions.id, revision.id),
        isNull(simulationPresetRevisions.physicsHash),
      ),
    );
  return physicsHash;
}

/** Read/derive a revision compatibility hash without mutating the revision.
 * Writers that need ordered aggregate/revision locks call this first solely
 * to identify the aggregate lock, then persist through
 * `ensureRevisionPhysicsHash` after both locks are held. */
export async function resolveRevisionPhysicsHash(
  db: DB,
  simulationPresetRevisionId: string,
): Promise<string | null> {
  const [revision] = await db
    .select({
      physicsHash: simulationPresetRevisions.physicsHash,
      snapshot: simulationPresetRevisions.snapshot,
    })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, simulationPresetRevisionId))
    .limit(1);
  if (!revision) return null;
  return (
    revision.physicsHash ?? physicsHashFromStoredSnapshot(revision.snapshot)
  );
}

/** Re is only an indexed prefilter here. Every NULL legacy candidate is
 * admitted to the group solely after its immutable snapshot hashes exactly. */
async function populateLegacyHashes(
  db: DB,
  compatibilityHash: string,
): Promise<void> {
  const [anchor] = await db
    .select({ reynolds: simulationPresetRevisions.reynolds })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.physicsHash, compatibilityHash))
    .limit(1);
  if (!anchor) return;
  const legacy = await db
    .select({
      id: simulationPresetRevisions.id,
      snapshot: simulationPresetRevisions.snapshot,
    })
    .from(simulationPresetRevisions)
    .where(
      and(
        isNull(simulationPresetRevisions.physicsHash),
        eq(simulationPresetRevisions.reynolds, anchor.reynolds),
      ),
    );
  for (const revision of legacy) {
    const physicsHash = physicsHashFromStoredSnapshot(revision.snapshot);
    if (!physicsHash) continue;
    await db
      .update(simulationPresetRevisions)
      .set({ physicsHash, isCanonicalPhysics: false })
      .where(
        and(
          eq(simulationPresetRevisions.id, revision.id),
          isNull(simulationPresetRevisions.physicsHash),
        ),
      );
  }
}

export async function refreshPolarCompatibilityCache(
  db: DB,
  airfoilId: string,
  compatibilityHash: string,
): Promise<PolarCompatibilityCacheRefreshResult> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polar-compatibility:${POLAR_COMPATIBILITY_VERSION}:${airfoilId}:${compatibilityHash}`}, 0))`,
    );
    await populateLegacyHashes(tx, compatibilityHash);

    const rawRows = await tx
      .select({
        resultId: results.id,
        resultAttemptId: resultAttempts.id,
        simulationPresetRevisionId: results.simulationPresetRevisionId,
        // Compatibility caches are public evidence read models. Every
        // solver-derived value and verdict therefore comes from the one
        // immutable attempt selected by current_result_attempt_id. A stale
        // mutable results projection, a pointer-less historical row, or an
        // accepted verdict belonging to another attempt must fail closed.
        aoaDeg: resultAttempts.aoaDeg,
        state: resultClassifications.state,
        region: resultClassifications.region,
        reasons: resultClassifications.reasons,
        confidence: resultClassifications.confidence,
        regime: resultAttempts.regime,
        fidelity: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
        cl: resultAttempts.cl,
        cd: resultAttempts.cd,
        cm: resultAttempts.cm,
        clCd: resultAttempts.clCd,
        clStd: resultAttempts.clStd,
        cdStd: resultAttempts.cdStd,
        cmStd: resultAttempts.cmStd,
        status: resultAttempts.status,
        source: resultAttempts.source,
        converged: resultAttempts.converged,
        stalled: resultAttempts.stalled,
        unsteady: resultAttempts.unsteady,
        error: resultAttempts.error,
        finalResidual: resultAttempts.finalResidual,
        iterations: resultAttempts.iterations,
        firstOrderFallback: resultAttempts.firstOrderFallback,
        resultUpdatedAt:
          sql<Date>`COALESCE(${resultAttempts.solvedAt}, ${resultAttempts.createdAt})`.mapWith(
            resultAttempts.createdAt,
          ),
        solvedAt: resultAttempts.solvedAt,
        qualityWarnings: resultAttempts.qualityWarnings,
      })
      .from(results)
      .innerJoin(
        resultAttempts,
        and(
          eq(resultAttempts.id, results.currentResultAttemptId),
          eq(resultAttempts.resultId, results.id),
        ),
      )
      .innerJoin(
        resultClassifications,
        and(
          eq(resultClassifications.resultAttemptId, resultAttempts.id),
          eq(resultClassifications.airfoilId, results.airfoilId),
          eq(
            resultClassifications.simulationPresetRevisionId,
            results.simulationPresetRevisionId,
          ),
          eq(resultClassifications.aoaDeg, resultAttempts.aoaDeg),
          sql`${resultClassifications.regime} IS NOT DISTINCT FROM ${resultAttempts.regime}`,
        ),
      )
      .innerJoin(
        simulationPresetRevisions,
        eq(simulationPresetRevisions.id, results.simulationPresetRevisionId),
      )
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(simulationPresetRevisions.physicsHash, compatibilityHash),
        ),
      );
    const verdicts = await activeReviewVerdicts(
      tx,
      rawRows.map((row) => row.resultId),
    );
    const rows: CompatibilityEvidenceRow[] = [];
    for (const row of rawRows) {
      if (!row.simulationPresetRevisionId) continue;
      const review = verdicts.get(row.resultId);
      if (review?.verdict === "exclude") continue;
      const gated = compatibilityClassificationWithQualityGate(row);
      rows.push({
        ...row,
        simulationPresetRevisionId: row.simulationPresetRevisionId,
        ...gated,
        reviewVerdict: null,
      });
    }
    const candidates = rows
      .map(asCandidate)
      .filter(
        (candidate): candidate is CompatibilityCandidate => candidate != null,
      );
    const resolved = resolvePolarCompatibilityMembers(candidates);
    const [airfoil] = await tx
      .select({ isSymmetric: airfoils.isSymmetric })
      .from(airfoils)
      .where(eq(airfoils.id, airfoilId))
      .limit(1);
    const symmetric = airfoil?.isSymmetric ?? false;
    let fitInput = resolved.selected.map(asClassification);
    if (symmetric) {
      const realAoas = new Set(
        fitInput.map((classification) =>
          canonicalAoa(classification.evidence.a),
        ),
      );
      fitInput = [
        ...fitInput,
        ...mirrorClassifiedEvidence(fitInput).filter(
          (classification) =>
            !realAoas.has(canonicalAoa(classification.evidence.a)),
        ),
      ];
    }
    const fit = buildPolarFit(fitInput);
    const metrics = fit.metrics;
    const fitAoas = fit.points.map((point) => point.a);
    const signature = evidenceSignature(rows, resolved.members, symmetric);
    const [revision] = await tx
      .select({
        reynolds: simulationPresetRevisions.reynolds,
        mach: simulationPresetRevisions.mach,
      })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.physicsHash, compatibilityHash))
      .limit(1);
    const acceptedPointCount = resolved.selected.filter(
      (candidate) => candidate.state === "accepted",
    ).length;
    const provisionalPointCount = resolved.selected.filter(
      (candidate) => candidate.state === "needs_urans",
    ).length;
    const rejectedPointCount = rows.filter(
      (row) => row.state === "rejected" || row.state === "superseded_by_urans",
    ).length;

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
    const currentValues = {
      status: fit.status,
      confidence: fit.confidence,
      acceptedPointCount,
      provisionalPointCount,
      rejectedPointCount,
      conflictPointCount: resolved.conflictAoas.length,
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
      aoaMin: fitAoas.length ? Math.min(...fitAoas) : null,
      aoaMax: fitAoas.length ? Math.max(...fitAoas) : null,
      isCurrent: true,
    };
    const [fitSet] = await tx
      .insert(polarCompatibilityFitSets)
      .values({
        airfoilId,
        compatibilityVersion: POLAR_COMPATIBILITY_VERSION,
        compatibilityHash,
        fitVersion: POLAR_FIT_VERSION,
        evidenceSignature: signature,
        ...currentValues,
      })
      .onConflictDoUpdate({
        target: [
          polarCompatibilityFitSets.airfoilId,
          polarCompatibilityFitSets.compatibilityVersion,
          polarCompatibilityFitSets.compatibilityHash,
          polarCompatibilityFitSets.fitVersion,
          polarCompatibilityFitSets.evidenceSignature,
        ],
        set: currentValues,
      })
      .returning({ id: polarCompatibilityFitSets.id });
    if (!fitSet) {
      return {
        airfoilId,
        compatibilityVersion: POLAR_COMPATIBILITY_VERSION,
        compatibilityHash,
        fitSetId: null,
        fitStatus: "insufficient",
        conflictAoas: resolved.conflictAoas,
        selectedResultIds: resolved.selected.map(
          (candidate) => candidate.resultId,
        ),
      };
    }

    await tx
      .delete(polarCompatibilityFitPoints)
      .where(eq(polarCompatibilityFitPoints.fitSetId, fitSet.id));
    await tx
      .delete(polarCompatibilityFitMembers)
      .where(eq(polarCompatibilityFitMembers.fitSetId, fitSet.id));
    if (fit.points.length) {
      await tx.insert(polarCompatibilityFitPoints).values(
        fit.points.map((point) => ({
          fitSetId: fitSet.id,
          aoaDeg: point.a,
          cl: point.cl,
          cd: point.cd,
          cm: point.cm,
          clCd: point.ld,
        })),
      );
    }
    if (resolved.members.length) {
      await tx.insert(polarCompatibilityFitMembers).values(
        resolved.members.map((member) => ({
          fitSetId: fitSet.id,
          resultId: member.resultId,
          simulationPresetRevisionId: member.simulationPresetRevisionId,
          aoaDeg: canonicalAoa(member.aoaDeg),
          role: member.role,
          selectionRank: member.selectionRank,
          selectionReason: member.selectionReason,
          classificationState: member.state,
          classificationRegion: member.region,
          classificationReasons: member.reasons,
          classificationConfidence: member.confidence,
          reviewVerdict: member.reviewVerdict,
          fidelity: member.fidelity,
          regime: member.regime,
          cl: member.cl,
          cd: member.cd,
          cm: member.cm,
          clCd: member.clCd,
          clStd: member.clStd,
          cdStd: member.cdStd,
          cmStd: member.cmStd,
          stalled: member.stalled,
          unsteady: member.unsteady,
          converged: member.converged,
          resultUpdatedAt: member.resultUpdatedAt,
        })),
      );
    }
    return {
      airfoilId,
      compatibilityVersion: POLAR_COMPATIBILITY_VERSION,
      compatibilityHash,
      fitSetId: fitSet.id,
      fitStatus: fit.status,
      conflictAoas: resolved.conflictAoas,
      selectedResultIds: resolved.selected.map(
        (candidate) => candidate.resultId,
      ),
    };
  });
}
