import {
  type AirfoilDetailPayload,
  canonicalAoa,
  colorForRe,
  fRe,
  POLAR_FIT_VERSION,
  type PolarFit,
  type Polar,
  type PolarPointData,
  type ResultClassificationRegion,
  type ResultClassificationState,
  type SimulationWorkItem,
} from "@aerodb/core";
import {
  airfoils,
  categories,
  flowConditions,
  mediums,
  polarCompatibilityFitMembers,
  polarCompatibilityFitPoints,
  polarCompatibilityFitSets,
  type Result,
  resultClassifications,
  resultReviewVerdicts,
  polarFitPoints,
  polarFitSets,
  resultAttempts,
  results,
  simCampaignConditions,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
} from "@aerodb/db";
import {
  POLAR_COMPATIBILITY_VERSION,
  polarCompatibilitySeriesId,
} from "@aerodb/db/polar-cache";
import {
  physicsHashForSnapshot,
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "../db";
import { geometryFor } from "./geometry";
import { hashtagsByAirfoilIds } from "./hashtags";

type PublicEvidenceRole = NonNullable<PolarPointData["evidenceRole"]>;

function solvedToPoint(
  r: Result,
  classification: {
    state: ResultClassificationState;
    region: ResultClassificationRegion;
    reasons: string[] | null;
    confidence: number | null;
  },
): PolarPointData {
  const cl = r.cl ?? 0;
  const cd = r.cd ?? 0;
  const point: PolarPointData = {
    a: r.aoaDeg,
    cl,
    cd,
    cm: r.cm,
    ld: r.clCd ?? (cd !== 0 ? cl / cd : 0),
    stalled: r.stalled,
    source: "solved",
    unsteady: r.unsteady,
    converged: r.converged,
    clStd: r.clStd,
    cdStd: r.cdStd,
    cmStd: r.cmStd,
    resultId: r.id,
    classificationState: classification.state,
    classificationRegion: classification.region,
    classificationReasons: classification.reasons ?? [],
    classificationConfidence: classification.confidence ?? null,
  };
  return point;
}

/** Display-only mirrored polar point for a symmetric airfoil (spec §9.2–§9.3).
 *  The UI codes against the exact field names derived/derivedFromResultId/
 *  derivedFromAoaDeg; resultId keeps pointing at the +α source row so evidence
 *  navigation opens the real solve. */
type DerivedPolarPointData = PolarPointData & {
  derived: true;
  derivedFromResultId: string;
  derivedFromAoaDeg: number;
};

type SolvedClassification = {
  state: ResultClassificationState;
  region: ResultClassificationRegion;
  reasons: string[] | null;
  confidence: number | null;
};

type SolvedRow = {
  result: Result;
  classification: SolvedClassification;
};

type DetailRevision = {
  id: string;
  reynolds: number;
  mach: number | null;
  createdAt: Date;
  revisionNumber: number;
  physicsHash: string | null;
  snapshot: Record<string, unknown>;
};

function effectivePhysicsHash(revision: DetailRevision): string {
  if (revision.physicsHash?.trim()) return revision.physicsHash;
  try {
    return physicsHashForSnapshot(
      revision.snapshot as unknown as SimulationSetupSnapshot,
    );
  } catch {
    // A malformed historical snapshot must not take down the public Detail
    // route or be guessed compatible with another setup. Isolate it under its
    // immutable revision identity until the backfill can repair the row.
    return `legacy-revision:${revision.id}`;
  }
}

function classificationRank(row: SolvedRow): number {
  return row.classification.state === "accepted" ? 2 : 1;
}

function fidelityRank(row: SolvedRow): number {
  if (row.result.fidelity === "urans_full") return 3;
  if (row.result.fidelity === "urans_precalc") return 2;
  return row.result.regime === "urans" ? 2 : 1;
}

function sameCoefficients(a: SolvedRow, b: SolvedRow): boolean {
  return (
    a.result.cl === b.result.cl &&
    a.result.cd === b.result.cd &&
    a.result.cm === b.result.cm
  );
}

/** Rollout fallback used only while a compatibility cache is absent. It
 * mirrors the cache's conservative selector: accepted before provisional,
 * full URANS before precalc before RANS, exact-equal ties shadow
 * deterministically, and contradictory equal-rank evidence remains visible
 * as point-only conflict evidence. */
function resolveFallbackCompatibilityRows(
  rows: SolvedRow[],
): Array<{ row: SolvedRow; role: PublicEvidenceRole }> {
  const byAoa = new Map<number, SolvedRow[]>();
  for (const row of rows) {
    const aoa = canonicalAoa(row.result.aoaDeg);
    const list = byAoa.get(aoa) ?? [];
    list.push(row);
    byAoa.set(aoa, list);
  }
  const resolved: Array<{ row: SolvedRow; role: PublicEvidenceRole }> = [];
  for (const candidates of byAoa.values()) {
    const topClassification = Math.max(...candidates.map(classificationRank));
    const classified = candidates.filter(
      (row) => classificationRank(row) === topClassification,
    );
    const topFidelity = Math.max(...classified.map(fidelityRank));
    const top = classified
      .filter((row) => fidelityRank(row) === topFidelity)
      .sort((x, y) => {
        const solved =
          (y.result.solvedAt?.getTime() ?? 0) -
          (x.result.solvedAt?.getTime() ?? 0);
        if (solved !== 0) return solved;
        const updated =
          y.result.updatedAt.getTime() - x.result.updatedAt.getTime();
        return updated || x.result.id.localeCompare(y.result.id);
      });
    const lower = candidates.filter((row) => !top.includes(row));
    if (top.length === 1 || top.every((row) => sameCoefficients(row, top[0]))) {
      resolved.push({ row: top[0], role: "primary" });
      for (const row of top.slice(1)) resolved.push({ row, role: "alternate" });
    } else {
      for (const row of top) resolved.push({ row, role: "conflict" });
    }
    for (const row of lower) resolved.push({ row, role: "alternate" });
  }
  const roleRank = (role: PublicEvidenceRole) =>
    role === "primary" ? 0 : role === "conflict" ? 1 : 2;
  return resolved.sort(
    (x, y) =>
      x.row.result.aoaDeg - y.row.result.aoaDeg ||
      roleRank(x.role) - roleRank(y.role) ||
      x.row.result.id.localeCompare(y.row.result.id),
  );
}

function seriesHue(seriesId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seriesId.length; i += 1) {
    hash ^= seriesId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

/** Public labels describe operating conditions, never internal batches or
 * revisions. Same-Re series get identity-derived colors; residual identical
 * Re+Mach collisions receive a neutral deterministic condition ordinal. */
export function decoratePublicPolars(input: Polar[]): Polar[] {
  const polars = [...input].sort(
    (x, y) =>
      x.re - y.re ||
      (x.mach ?? Number.NEGATIVE_INFINITY) -
        (y.mach ?? Number.NEGATIVE_INFINITY) ||
      x.seriesId.localeCompare(y.seriesId),
  );
  const baseLabelBySeries = new Map<string, string>();
  const byBaseLabel = new Map<string, Polar[]>();
  for (const polar of polars) {
    const machLabel = polar.mach == null ? "" : polar.mach.toFixed(2);
    const baseLabel = `Re ${fRe(polar.re)}${machLabel ? ` · M ${machLabel}` : ""}`;
    baseLabelBySeries.set(polar.seriesId, baseLabel);
    const list = byBaseLabel.get(baseLabel) ?? [];
    list.push(polar);
    byBaseLabel.set(baseLabel, list);
  }
  const usedHues = new Set<number>();
  for (const polar of polars) {
    const baseLabel = baseLabelBySeries.get(polar.seriesId)!;
    const collisions = byBaseLabel.get(baseLabel) ?? [];
    const ordinal = collisions.findIndex(
      (candidate) => candidate.seriesId === polar.seriesId,
    );
    polar.label =
      collisions.length > 1
        ? `${baseLabel} · condition ${ordinal + 1}`
        : baseLabel;
    if (polars.length === 1) {
      polar.color = colorForRe(polar.re);
    } else {
      let hue = seriesHue(polar.seriesId);
      while (usedHues.has(hue)) hue = (hue + 47) % 360;
      usedHues.add(hue);
      polar.color = `hsl(${hue} 72% 62%)`;
    }
  }
  return polars;
}

/** Odd-function negation that never emits -0. */
function negated(v: number): number;
function negated(v: null): null;
function negated(v: number | null): number | null;
function negated(v: number | null): number | null {
  if (v == null) return null;
  return v === 0 ? 0 : -v;
}

/** Mirror accepted/needs_urans +α solved points onto the negative side for
 *  display (Cl/Cm/L/D negated, Cd kept). Mirrors are evidence-navigation
 *  entries only — never counted as solver runs — and a real solve at the
 *  mirrored α suppresses the mirror. */
function mirroredSolvedPoints(
  rows: { result: Result; classification: SolvedClassification }[],
  evidenceRoles?: Map<string, PublicEvidenceRole>,
): DerivedPolarPointData[] {
  const realAoas = new Set(rows.map((row) => canonicalAoa(row.result.aoaDeg)));
  const mirrored: DerivedPolarPointData[] = [];
  for (const row of rows) {
    const sourceAoa = row.result.aoaDeg;
    if (sourceAoa <= 0) continue;
    const state = row.classification.state ?? "accepted";
    if (state !== "accepted" && state !== "needs_urans") continue;
    const mirroredAoa = canonicalAoa(-sourceAoa);
    if (realAoas.has(mirroredAoa)) continue;
    const source = solvedToPoint(row.result, row.classification);
    mirrored.push({
      ...source,
      evidenceRole: evidenceRoles?.get(row.result.id),
      a: mirroredAoa,
      cl: negated(source.cl),
      cm: negated(source.cm),
      ld: negated(source.ld),
      derived: true,
      derivedFromResultId: row.result.id,
      derivedFromAoaDeg: sourceAoa,
    });
  }
  return mirrored;
}

function numericAoas(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

type WorkPayload = {
  aoas?: unknown;
  retryMode?: string;
  setupSnapshot?: {
    preset?: { name?: string };
    derived?: { reynolds?: number };
    flowState?: { mach?: number | null };
  };
  speedMap?: { mach?: number | null }[];
};

export async function loadSimulationWorks(
  airfoilId: string,
  opts: { revisionId?: string | null; limit?: number } = {},
): Promise<SimulationWorkItem[]> {
  const where = opts.revisionId
    ? and(
        eq(simJobs.airfoilId, airfoilId),
        eq(simJobs.simulationPresetRevisionId, opts.revisionId),
      )
    : eq(simJobs.airfoilId, airfoilId);
  const jobs = await db
    .select()
    .from(simJobs)
    .where(where)
    .orderBy(desc(simJobs.createdAt))
    .limit(opts.limit ?? 16);
  if (jobs.length === 0) return [];

  const jobIds = jobs.map((job) => job.id);
  const resultStatsRows = await db
    .select({
      simJobId: results.simJobId,
      resultCount: sql<number>`count(*)::int`,
      solvedCount: sql<number>`count(*) filter (where ${results.status} = 'done' and ${results.source} = 'solved')::int`,
      pendingCount: sql<number>`count(*) filter (where ${results.status} in ('pending', 'queued', 'running', 'stale'))::int`,
      failedCount: sql<number>`count(*) filter (where ${results.status} = 'failed')::int`,
      aoaMin: sql<number | null>`min(${results.aoaDeg})::float8`,
      aoaMax: sql<number | null>`max(${results.aoaDeg})::float8`,
    })
    .from(results)
    .where(inArray(results.simJobId, jobIds))
    .groupBy(results.simJobId);
  const resultStats = new Map(
    resultStatsRows
      .filter((row) => row.simJobId)
      .map((row) => [row.simJobId!, row]),
  );

  const attemptStatsRows = await db
    .select({
      simJobId: resultAttempts.simJobId,
      acceptedRansCount: sql<number>`count(*) filter (where ${resultAttempts.regime} = 'rans' and ${resultAttempts.validForPolar} = true)::int`,
      rejectedRansCount: sql<number>`count(*) filter (where ${resultAttempts.regime} = 'rans' and ${resultAttempts.validForPolar} = false)::int`,
      uransAttemptCount: sql<number>`count(*) filter (where ${resultAttempts.regime} = 'urans')::int`,
    })
    .from(resultAttempts)
    .where(inArray(resultAttempts.simJobId, jobIds))
    .groupBy(resultAttempts.simJobId);
  const attemptStats = new Map(
    attemptStatsRows
      .filter((row) => row.simJobId)
      .map((row) => [row.simJobId!, row]),
  );

  return jobs.map((job) => {
    const payload = (job.requestPayload ?? {}) as WorkPayload;
    const aoas = numericAoas(payload.aoas);
    const rstats = resultStats.get(job.id);
    const astats = attemptStats.get(job.id);
    const aoaMin = aoas.length ? aoas[0] : (rstats?.aoaMin ?? null);
    const aoaMax = aoas.length
      ? aoas[aoas.length - 1]
      : (rstats?.aoaMax ?? null);
    return {
      id: job.id,
      kind: job.wave === 2 ? "urans-retry" : "rans-sweep",
      status: job.status,
      wave: job.wave,
      engineState: job.engineState,
      engineJobId: job.engineJobId,
      retryMode: payload.retryMode ?? null,
      // Public solver-work summaries describe physical conditions and status;
      // internal preset/batch names are deliberately not exposed.
      setupName: null,
      aoas,
      aoaMin,
      aoaMax,
      totalCases: job.totalCases || aoas.length || rstats?.resultCount || 0,
      completedCases: job.completedCases,
      solvedCount: rstats?.solvedCount ?? 0,
      pendingCount: rstats?.pendingCount ?? 0,
      failedCount: rstats?.failedCount ?? 0,
      acceptedRansCount: astats?.acceptedRansCount ?? 0,
      rejectedRansCount: astats?.rejectedRansCount ?? 0,
      uransAttemptCount: astats?.uransAttemptCount ?? 0,
      reynolds: payload.setupSnapshot?.derived?.reynolds ?? null,
      mach:
        payload.setupSnapshot?.flowState?.mach ??
        payload.speedMap?.[0]?.mach ??
        null,
      createdAt: job.createdAt.toISOString(),
      submittedAt: job.submittedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      error: job.error,
    };
  });
}

async function loadSolvedRows(
  airfoilId: string,
  revisionIds: string[],
): Promise<Map<string, SolvedRow[]>> {
  const solvedByRevision = new Map<string, SolvedRow[]>();
  if (revisionIds.length === 0) return solvedByRevision;
  const rows = await db
    .select({
      result: results,
      attempt: resultAttempts,
      state: resultClassifications.state,
      region: resultClassifications.region,
      reasons: resultClassifications.reasons,
      confidence: resultClassifications.confidence,
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
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .leftJoin(
      resultReviewVerdicts,
      and(
        eq(resultReviewVerdicts.resultId, results.id),
        isNull(resultReviewVerdicts.revokedAt),
        eq(resultReviewVerdicts.verdict, "exclude"),
      ),
    )
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        inArray(results.simulationPresetRevisionId, revisionIds),
        eq(resultAttempts.source, "solved"),
        eq(resultAttempts.status, "done"),
        isNotNull(resultAttempts.cl),
        isNotNull(resultAttempts.cd),
        isNull(resultReviewVerdicts.id),
        inArray(resultClassifications.state, ["accepted", "needs_urans"]),
      ),
    );
  for (const row of rows) {
    const revisionId = row.result.simulationPresetRevisionId;
    if (!revisionId) continue;
    const payload =
      row.attempt.evidencePayload &&
      typeof row.attempt.evidencePayload === "object" &&
      !Array.isArray(row.attempt.evidencePayload)
        ? (row.attempt.evidencePayload as Record<string, unknown>)
        : {};
    const frameTrack = payload.frame_track ?? payload.frameTrack ?? null;
    const steadyHistory =
      payload.steady_history ?? payload.steadyHistory ?? null;
    const fidelity =
      typeof payload.fidelity === "string" ? payload.fidelity : null;
    // The result row owns the stable physical-cell identity and setup values;
    // every solver-derived/publication value comes from its explicitly selected
    // immutable attempt. A stale mutable projection can therefore neither
    // replace coefficients nor keep pointer-null historical evidence public.
    const exactResult: Result = {
      ...row.result,
      bcId: row.attempt.bcId,
      status: row.attempt.status,
      source: row.attempt.source,
      regime: row.attempt.regime,
      cl: row.attempt.cl,
      cd: row.attempt.cd,
      cm: row.attempt.cm,
      clCd: row.attempt.clCd,
      clStd: row.attempt.clStd,
      cdStd: row.attempt.cdStd,
      cmStd: row.attempt.cmStd,
      stalled: row.attempt.stalled,
      unsteady: row.attempt.unsteady,
      converged: row.attempt.converged,
      finalResidual: row.attempt.finalResidual,
      iterations: row.attempt.iterations,
      yPlusAvg: row.attempt.yPlusAvg,
      yPlusMax: row.attempt.yPlusMax,
      nCells: row.attempt.nCells,
      firstOrderFallback: row.attempt.firstOrderFallback,
      strouhal: row.attempt.strouhal,
      error: row.attempt.error,
      qualityWarnings: row.attempt.qualityWarnings,
      frameTrack,
      fidelity,
      steadyHistory,
      simJobId: row.attempt.simJobId,
      engineJobId: row.attempt.engineJobId,
      engineCaseSlug: row.attempt.engineCaseSlug,
      solvedAt: row.attempt.solvedAt,
      updatedAt: row.attempt.solvedAt ?? row.attempt.createdAt,
    };
    const list = solvedByRevision.get(revisionId) ?? [];
    list.push({
      result: exactResult,
      classification: {
        state: row.state,
        region: row.region,
        reasons: row.reasons,
        confidence: row.confidence,
      },
    });
    solvedByRevision.set(revisionId, list);
  }
  return solvedByRevision;
}

type FitRowShape = {
  status: PolarFit["status"];
  confidence: number;
  acceptedPointCount: number;
  provisionalPointCount: number;
  rejectedPointCount: number;
  evidenceSignature: string;
  ldmax: number | null;
  alphaLdmax: number | null;
  alphaLdmaxFine: number | null;
  alphaClZeroFine: number | null;
  alphaClmaxFine: number | null;
  cdmin: number | null;
  clAtCdmin: number | null;
  cd0: number | null;
  clmax: number | null;
  alphaClmax: number | null;
  cm0: number | null;
};

function polarFitFromRows(
  row: FitRowShape,
  points: Array<{ a: number; cl: number; cd: number; cm: number; ld: number }>,
): PolarFit {
  return {
    status: row.status,
    confidence: row.confidence,
    acceptedPointCount: row.acceptedPointCount,
    provisionalPointCount: row.provisionalPointCount,
    rejectedPointCount: row.rejectedPointCount,
    evidenceSignature: row.evidenceSignature,
    points,
    metrics:
      row.ldmax == null ||
      row.alphaLdmax == null ||
      row.cdmin == null ||
      row.clAtCdmin == null ||
      row.cd0 == null ||
      row.clmax == null ||
      row.alphaClmax == null ||
      row.cm0 == null
        ? null
        : {
            ldmax: row.ldmax,
            aLd: row.alphaLdmax,
            alphaLdmaxFine: row.alphaLdmaxFine ?? row.alphaLdmax,
            alphaClZeroFine: row.alphaClZeroFine ?? null,
            alphaClmaxFine: row.alphaClmaxFine ?? null,
            cdmin: row.cdmin,
            clCd: row.clAtCdmin,
            cd0: row.cd0,
            clmax: row.clmax,
            aStall: row.alphaClmax,
            cm0: row.cm0,
          },
  };
}

async function loadRevisionFits(
  airfoilId: string,
  revisionIds: string[],
): Promise<Map<string, PolarFit>> {
  const fitByRevision = new Map<string, PolarFit>();
  if (revisionIds.length === 0) return fitByRevision;
  const fitRows = await db
    .select()
    .from(polarFitSets)
    .where(
      and(
        inArray(polarFitSets.simulationPresetRevisionId, revisionIds),
        eq(polarFitSets.airfoilId, airfoilId),
        eq(polarFitSets.fitVersion, POLAR_FIT_VERSION),
        eq(polarFitSets.isCurrent, true),
      ),
    );
  const fitIds = fitRows.map((row) => row.id);
  const pointRows = fitIds.length
    ? await db
        .select()
        .from(polarFitPoints)
        .where(inArray(polarFitPoints.fitSetId, fitIds))
    : [];
  const pointsBySet = new Map<string, typeof pointRows>();
  for (const point of pointRows) {
    const list = pointsBySet.get(point.fitSetId) ?? [];
    list.push(point);
    pointsBySet.set(point.fitSetId, list);
  }
  for (const fit of fitRows) {
    const points = (pointsBySet.get(fit.id) ?? [])
      .sort((x, y) => x.aoaDeg - y.aoaDeg)
      .map((point) => ({
        a: point.aoaDeg,
        cl: point.cl,
        cd: point.cd,
        cm: point.cm,
        ld: point.clCd,
      }));
    fitByRevision.set(
      fit.simulationPresetRevisionId,
      polarFitFromRows(fit, points),
    );
  }
  return fitByRevision;
}

type CompatibilityCache = {
  fitByHash: Map<string, PolarFit>;
  measuredResultIdsByHash: Map<string, Set<string>>;
  memberRolesByHash: Map<string, Map<string, PublicEvidenceRole>>;
  cachedHashes: Set<string>;
};

async function loadCompatibilityCache(
  airfoilId: string,
  hashes: string[],
): Promise<CompatibilityCache> {
  const fitByHash = new Map<string, PolarFit>();
  const measuredResultIdsByHash = new Map<string, Set<string>>();
  const memberRolesByHash = new Map<string, Map<string, PublicEvidenceRole>>();
  const cachedHashes = new Set<string>();
  if (hashes.length === 0) {
    return {
      fitByHash,
      measuredResultIdsByHash,
      memberRolesByHash,
      cachedHashes,
    };
  }
  const fitRows = await db
    .select()
    .from(polarCompatibilityFitSets)
    .where(
      and(
        eq(polarCompatibilityFitSets.airfoilId, airfoilId),
        eq(
          polarCompatibilityFitSets.compatibilityVersion,
          POLAR_COMPATIBILITY_VERSION,
        ),
        inArray(polarCompatibilityFitSets.compatibilityHash, hashes),
        eq(polarCompatibilityFitSets.isCurrent, true),
      ),
    );
  const fitIds = fitRows.map((row) => row.id);
  const [pointRows, memberRows] = fitIds.length
    ? await Promise.all([
        db
          .select()
          .from(polarCompatibilityFitPoints)
          .where(inArray(polarCompatibilityFitPoints.fitSetId, fitIds)),
        db
          .select({
            fitSetId: polarCompatibilityFitMembers.fitSetId,
            resultId: polarCompatibilityFitMembers.resultId,
            role: polarCompatibilityFitMembers.role,
          })
          .from(polarCompatibilityFitMembers)
          .where(inArray(polarCompatibilityFitMembers.fitSetId, fitIds)),
      ])
    : [[], []];
  const pointsBySet = new Map<string, typeof pointRows>();
  for (const point of pointRows) {
    const list = pointsBySet.get(point.fitSetId) ?? [];
    list.push(point);
    pointsBySet.set(point.fitSetId, list);
  }
  const hashBySetId = new Map(
    fitRows.map((row) => [row.id, row.compatibilityHash]),
  );
  for (const member of memberRows) {
    const hash = hashBySetId.get(member.fitSetId);
    if (!hash) continue;
    const measuredIds = measuredResultIdsByHash.get(hash) ?? new Set<string>();
    measuredIds.add(member.resultId);
    measuredResultIdsByHash.set(hash, measuredIds);
    const publicRole: PublicEvidenceRole =
      member.role === "selected"
        ? "primary"
        : member.role === "conflict"
          ? "conflict"
          : "alternate";
    const roles =
      memberRolesByHash.get(hash) ?? new Map<string, PublicEvidenceRole>();
    roles.set(member.resultId, publicRole);
    memberRolesByHash.set(hash, roles);
  }
  for (const fit of fitRows) {
    cachedHashes.add(fit.compatibilityHash);
    const points = (pointsBySet.get(fit.id) ?? [])
      .sort((x, y) => x.aoaDeg - y.aoaDeg)
      .map((point) => ({
        a: point.aoaDeg,
        cl: point.cl,
        cd: point.cd,
        cm: point.cm,
        ld: point.clCd,
      }));
    fitByHash.set(fit.compatibilityHash, polarFitFromRows(fit, points));
  }
  return {
    fitByHash,
    measuredResultIdsByHash,
    memberRolesByHash,
    cachedHashes,
  };
}

/** Assemble the public airfoil detail payload.
 *
 *  `opts.revisionId` (campaign spec §11 surgical exception): scope the polar
 *  evidence to ONE pinned simulation_preset_revisions row so the campaign
 *  cell side panel can reuse this payload for its pinned-revision PolarViewer.
 *  Scoped mode always emits that revision's Re entry (possibly with zero
 *  points) so "no solved points yet" renders honestly instead of hiding the
 *  curve. Public mode groups all evidence under enabled, physics-compatible
 *  setup anchors; internal batch/revision names never define a curve. */
export async function assembleDetail(
  slug: string,
  opts: { revisionId?: string | null } = {},
): Promise<AirfoilDetailPayload | null> {
  const [a] = await db
    .select()
    .from(airfoils)
    .where(
      and(
        eq(airfoils.slug, slug),
        isNull(airfoils.archivedAt),
        isNull(airfoils.deletedAt),
      ),
    )
    .limit(1);
  if (!a) return null;
  const [cat] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, a.categoryId))
    .limit(1);
  const normalizedTags = (await hashtagsByAirfoilIds([a.id])).get(a.id) ?? [];

  const geo = geometryFor(a);

  // Public curves are grouped by physics/numerics compatibility, never by a
  // batch/revision name and never by rounded Reynolds alone. Enabled library
  // revisions and immutable air campaign conditions anchor which compatibility
  // hashes are public; once anchored, accepted evidence from every equivalent
  // immutable revision participates. Campaign presets intentionally stay
  // disabled so this read-only inclusion must never imply scheduling. A pinned
  // admin journey remains scoped to exactly the requested revision.
  const revisionSelection = {
    id: simulationPresetRevisions.id,
    reynolds: simulationPresetRevisions.reynolds,
    mach: simulationPresetRevisions.mach,
    createdAt: simulationPresetRevisions.createdAt,
    revisionNumber: simulationPresetRevisions.revisionNumber,
    physicsHash: simulationPresetRevisions.physicsHash,
    snapshot: simulationPresetRevisions.snapshot,
  };
  let pinnedRevision: DetailRevision | null = null;
  const anchorsByHash = new Map<string, DetailRevision[]>();
  const revisionById = new Map<string, DetailRevision>();

  if (opts.revisionId) {
    const [row] = await db
      .select(revisionSelection)
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, opts.revisionId))
      .limit(1);
    if (row && Math.round(row.reynolds) > 0) {
      pinnedRevision = row;
      revisionById.set(row.id, row);
    }
  } else {
    const [air] = await db
      .select({ id: mediums.id })
      .from(mediums)
      .where(eq(mediums.slug, "air"))
      .limit(1);
    if (air) {
      const [libraryAnchorRows, campaignAnchorRows] = await Promise.all([
        db
          .select(revisionSelection)
          .from(simulationPresets)
          .innerJoin(
            flowConditions,
            eq(flowConditions.id, simulationPresets.flowConditionId),
          )
          .innerJoin(
            simulationPresetRevisions,
            eq(simulationPresetRevisions.presetId, simulationPresets.id),
          )
          .where(
            and(
              eq(flowConditions.mediumId, air.id),
              eq(simulationPresets.enabled, true),
            ),
          ),
        // A campaign condition is an immutable public-physics anchor even
        // though its generated preset is disabled by design. Do not filter on
        // campaign lifecycle or condition status: those control scheduling,
        // not the validity of already stored solver evidence. Drafts without
        // evidence remain omitted below, so this never invents a polar.
        db
          .select(revisionSelection)
          .from(simCampaignConditions)
          .innerJoin(
            flowConditions,
            eq(flowConditions.id, simCampaignConditions.flowConditionId),
          )
          .innerJoin(
            simulationPresetRevisions,
            eq(
              simulationPresetRevisions.id,
              simCampaignConditions.simulationPresetRevisionId,
            ),
          )
          .where(eq(flowConditions.mediumId, air.id)),
      ]);
      for (const row of [...libraryAnchorRows, ...campaignAnchorRows]) {
        if (Math.round(row.reynolds) <= 0) continue;
        const hash = effectivePhysicsHash(row);
        const anchors = anchorsByHash.get(hash) ?? [];
        anchors.push(row);
        anchorsByHash.set(hash, anchors);
        revisionById.set(row.id, row);
      }
    }

    if (anchorsByHash.size > 0) {
      // Result-bearing revisions are the bounded rollout fallback for legacy
      // NULL physics_hash rows. Compatibility cache members cover this same
      // set after the production backfill, but the public page must not lose
      // real evidence while that additive cache is being populated.
      const evidenceRevisionRows = await db
        .selectDistinct(revisionSelection)
        .from(simulationPresetRevisions)
        .innerJoin(
          results,
          eq(results.simulationPresetRevisionId, simulationPresetRevisions.id),
        )
        .where(eq(results.airfoilId, a.id));
      for (const row of evidenceRevisionRows) {
        const hash = effectivePhysicsHash(row);
        if (anchorsByHash.has(hash)) revisionById.set(row.id, row);
      }
    }
  }

  const revisionIds = [...revisionById.keys()];
  const solvedByRevision = await loadSolvedRows(a.id, revisionIds);
  let polars: Polar[];
  if (pinnedRevision) {
    const rows = (solvedByRevision.get(pinnedRevision.id) ?? []).sort(
      (x, y) => x.result.aoaDeg - y.result.aoaDeg,
    );
    const fit = (await loadRevisionFits(a.id, [pinnedRevision.id])).get(
      pinnedRevision.id,
    );
    const points = rows.map((row) =>
      solvedToPoint(row.result, row.classification),
    );
    if (a.isSymmetric) {
      points.push(...mirroredSolvedPoints(rows));
      points.sort((x, y) => x.a - y.a);
    }
    const re = Math.round(pinnedRevision.reynolds);
    const mach = pinnedRevision.mach ?? undefined;
    polars = [
      {
        seriesId: `revision:${pinnedRevision.id}`,
        label: `Re ${fRe(re)}${mach == null ? "" : ` · M ${mach.toFixed(2)}`}`,
        re,
        mach,
        color: colorForRe(re),
        source: rows.length > 0 ? "solved" : "queued",
        points,
        fit,
      },
    ];
  } else if (opts.revisionId) {
    polars = [];
  } else {
    const hashes = [...anchorsByHash.keys()];
    const compatibility = await loadCompatibilityCache(a.id, hashes);
    const hashByRevision = new Map<string, string>();
    for (const revision of revisionById.values()) {
      const hash = effectivePhysicsHash(revision);
      if (anchorsByHash.has(hash)) hashByRevision.set(revision.id, hash);
    }
    const rowsByHash = new Map<string, SolvedRow[]>();
    for (const [revisionId, rows] of solvedByRevision) {
      const hash = hashByRevision.get(revisionId);
      if (!hash) continue;
      const list = rowsByHash.get(hash) ?? [];
      list.push(...rows);
      rowsByHash.set(hash, list);
    }

    const drafts: Polar[] = [];
    for (const [hash, anchors] of anchorsByHash) {
      const allRows = rowsByHash.get(hash) ?? [];
      const measuredIds = compatibility.measuredResultIdsByHash.get(hash);
      const cachedRoles = compatibility.memberRolesByHash.get(hash);
      const resolvedRows = compatibility.cachedHashes.has(hash)
        ? allRows
            .filter((row) => measuredIds?.has(row.result.id))
            .map((row) => ({
              row,
              role: cachedRoles?.get(row.result.id) ?? ("alternate" as const),
            }))
            .sort(
              (x, y) =>
                x.row.result.aoaDeg - y.row.result.aoaDeg ||
                x.row.result.id.localeCompare(y.row.result.id),
            )
        : resolveFallbackCompatibilityRows(allRows);
      const rows = resolvedRows.map(({ row }) => row);
      if (rows.length === 0) continue;
      const anchor = [...anchors].sort(
        (x, y) =>
          x.createdAt.getTime() - y.createdAt.getTime() ||
          x.revisionNumber - y.revisionNumber ||
          x.id.localeCompare(y.id),
      )[0];
      const evidenceRoles = new Map(
        resolvedRows.map(({ row, role }) => [row.result.id, role]),
      );
      const displayRows = resolvedRows.map(({ row, role }) => ({
        result: row.result,
        classification:
          role === "conflict"
            ? {
                ...row.classification,
                reasons: [
                  ...(row.classification.reasons ?? []),
                  "compatibility_conflict",
                ],
              }
            : row.classification,
      }));
      const points: PolarPointData[] = displayRows.map((row) => ({
        ...solvedToPoint(row.result, row.classification),
        evidenceRole: evidenceRoles.get(row.result.id),
      }));
      if (a.isSymmetric) {
        points.push(...mirroredSolvedPoints(displayRows, evidenceRoles));
        points.sort((x, y) => x.a - y.a);
      }
      const cacheComplete =
        !measuredIds ||
        [...measuredIds].every((resultId) =>
          rows.some((row) => row.result.id === resultId),
        );
      drafts.push({
        seriesId: polarCompatibilitySeriesId(hash),
        label: "",
        re: Math.round(anchor.reynolds),
        mach: anchor.mach ?? undefined,
        color: "",
        source: "solved",
        points,
        fit: cacheComplete ? compatibility.fitByHash.get(hash) : undefined,
      });
    }
    polars = decoratePublicPolars(drafts);
  }
  const reList = [...new Set(polars.map((polar) => polar.re))].sort(
    (x, y) => x - y,
  );
  const simulationWorks = await loadSimulationWorks(a.id);
  const displayedMach =
    polars.find((polar) => polar.points.length > 0)?.mach ??
    simulationWorks.find((work) => work.mach !== null)?.mach ??
    0;

  const family = cat?.name ?? "—";
  const subtitle = `${geo.camberPct > 0.5 ? "Cambered" : "Symmetric"} · ${geo.thicknessPct.toFixed(0)}% thick · low-to-mid Re`;

  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    categoryId: cat?.id ?? a.categoryId,
    categorySlug: cat?.slug ?? "",
    categoryPath: cat?.path ?? "",
    family,
    subtitle,
    tags: normalizedTags.length ? normalizedTags.map((h) => h.name) : a.tags,
    hashtags: normalizedTags,
    breadcrumb: { db: "database", family, name: a.name },
    geometry: geo,
    mach: displayedMach,
    reList,
    polars,
    simulationWorks,
    downloads: {
      selig: `/api/airfoils/${a.slug}/coords.dat?format=selig`,
      lednicer: `/api/airfoils/${a.slug}/coords.dat?format=lednicer`,
      xfoil: `/api/airfoils/${a.slug}/coords.dat?format=xfoil`,
      csv: `/api/airfoils/${a.slug}/coords.dat?format=csv`,
      dxf: null,
    },
  };
}
