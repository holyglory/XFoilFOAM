import {
  type AirfoilDetailPayload,
  canonicalAoa,
  colorForRe,
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
  type Result,
  resultClassifications,
  polarFitPoints,
  polarFitSets,
  resultAttempts,
  results,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
} from "@aerodb/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "../db";
import { geometryFor } from "./geometry";
import { hashtagsByAirfoilIds } from "./hashtags";

function solvedToPoint(
  r: Result,
  classification?: {
    state: ResultClassificationState | null;
    region: ResultClassificationRegion | null;
    reasons: string[] | null;
    confidence: number | null;
  },
): PolarPointData {
  const cl = r.cl ?? 0;
  const cd = r.cd ?? 0;
  return {
    a: r.aoaDeg,
    cl,
    cd,
    cm: r.cm ?? 0,
    ld: r.clCd ?? (cd !== 0 ? cl / cd : 0),
    stalled: r.stalled,
    source: "solved",
    unsteady: r.unsteady,
    converged: r.converged,
    clStd: r.clStd,
    cdStd: r.cdStd,
    cmStd: r.cmStd,
    resultId: r.id,
    classificationState: classification?.state ?? "accepted",
    classificationRegion: classification?.region ?? "attached",
    classificationReasons: classification?.reasons ?? [],
    classificationConfidence: classification?.confidence ?? null,
  };
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
  state: ResultClassificationState | null;
  region: ResultClassificationRegion | null;
  reasons: string[] | null;
  confidence: number | null;
};

/** Odd-function negation that never emits -0. */
function negated(v: number): number {
  return v === 0 ? 0 : -v;
}

/** Mirror accepted/needs_urans +α solved points onto the negative side for
 *  display (Cl/Cm/L/D negated, Cd kept). Mirrors are evidence-navigation
 *  entries only — never counted as solver runs — and a real solve at the
 *  mirrored α suppresses the mirror. */
function mirroredSolvedPoints(
  rows: { result: Result; classification: SolvedClassification }[],
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
      setupName: payload.setupSnapshot?.preset?.name ?? null,
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

const validPolarPoint = sql<boolean>`(
  ${results.error} IS NULL
  AND ${results.cl} IS NOT NULL
  AND ${results.cd} IS NOT NULL
  AND ${results.cd} > 0
  AND (
    (
      ${results.unsteady} = true
      AND ${results.converged} = true
      AND EXISTS (
        SELECT 1
        FROM force_history fh
        WHERE fh.result_id = ${results.id}
      )
      AND EXISTS (
        SELECT 1
        FROM result_media media
        WHERE media.result_id = ${results.id}
          AND media.kind = 'video'
          AND media.role = 'instantaneous'
      )
    )
    OR (
      ${results.regime} = 'rans'
      AND ${results.converged} = true
      AND ${results.stalled} = false
      AND NOT EXISTS (
        SELECT 1
        FROM results core
        WHERE core.airfoil_id = ${results.airfoilId}
          AND core.simulation_preset_revision_id = ${results.simulationPresetRevisionId}
          AND core.source = 'solved'
          AND core.status = 'done'
          AND core.regime = 'rans'
          AND core.aoa_deg BETWEEN 0 AND 5
          AND (
            core.error IS NOT NULL
            OR core.converged = false
            OR core.stalled = true
            OR core.cl IS NULL
            OR core.cd IS NULL
            OR core.cd <= 0
          )
        )
      AND NOT EXISTS (
        SELECT 1
        FROM result_attempts core_attempt
        WHERE core_attempt.airfoil_id = ${results.airfoilId}
          AND core_attempt.simulation_preset_revision_id = ${results.simulationPresetRevisionId}
          AND core_attempt.source = 'solved'
          AND core_attempt.status = 'done'
          AND core_attempt.regime = 'rans'
          AND core_attempt.aoa_deg BETWEEN 0 AND 5
          AND core_attempt.valid_for_polar = false
      )
    )
  )
)`;

/** Assemble the public airfoil detail payload.
 *
 *  `opts.revisionId` (campaign spec §11 surgical exception): scope the polar
 *  evidence to ONE pinned simulation_preset_revisions row so the campaign
 *  cell side panel can reuse this payload for its pinned-revision PolarViewer.
 *  Scoped mode always emits that revision's Re entry (possibly with zero
 *  points) so "no solved points yet" renders honestly instead of hiding the
 *  curve. Default (no revisionId) behaviour is unchanged. */
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

  // The Detail-page curves are accepted stored solver evidence only. Scheduled
  // work is exposed separately so empty queue placeholders never look like polars.
  const [air] = await db
    .select({ id: mediums.id })
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  const revisionsByRe = new Map<
    number,
    {
      id: string;
      createdAt: Date;
      revisionNumber: number;
      mach: number | null;
    }[]
  >();
  const reByRevision = new Map<string, number>();
  const machByRevision = new Map<string, number | null>();
  let scopedRe: number | null = null;
  if (opts.revisionId) {
    // Pinned-revision scope: exactly this revision, regardless of preset
    // enabled state or medium (campaign presets are disabled by design).
    const [rev] = await db
      .select({
        revisionId: simulationPresetRevisions.id,
        reynolds: simulationPresetRevisions.reynolds,
        mach: simulationPresetRevisions.mach,
        createdAt: simulationPresetRevisions.createdAt,
        revisionNumber: simulationPresetRevisions.revisionNumber,
      })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, opts.revisionId))
      .limit(1);
    if (rev) {
      const roundedRe = Math.round(rev.reynolds);
      if (roundedRe > 0) {
        scopedRe = roundedRe;
        reByRevision.set(rev.revisionId, roundedRe);
        machByRevision.set(rev.revisionId, rev.mach);
        revisionsByRe.set(roundedRe, [
          {
            id: rev.revisionId,
            createdAt: rev.createdAt,
            revisionNumber: rev.revisionNumber,
            mach: rev.mach,
          },
        ]);
      }
    }
  } else if (air) {
    const rows = await db
      .select({
        revisionId: simulationPresetRevisions.id,
        reynolds: simulationPresetRevisions.reynolds,
        mach: simulationPresetRevisions.mach,
        createdAt: simulationPresetRevisions.createdAt,
        revisionNumber: simulationPresetRevisions.revisionNumber,
      })
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
      )
      .orderBy(
        desc(simulationPresetRevisions.createdAt),
        desc(simulationPresetRevisions.revisionNumber),
      );
    for (const row of rows) {
      const roundedRe = Math.round(row.reynolds);
      if (roundedRe <= 0) continue;
      reByRevision.set(row.revisionId, roundedRe);
      machByRevision.set(row.revisionId, row.mach);
      const list = revisionsByRe.get(roundedRe) ?? [];
      list.push({
        id: row.revisionId,
        createdAt: row.createdAt,
        revisionNumber: row.revisionNumber,
        mach: row.mach,
      });
      revisionsByRe.set(roundedRe, list);
    }
  }

  // Any solved results across enabled setup revisions upgrade the corresponding curve in place.
  const revisionIds = [...reByRevision.keys()];
  const solvedByRevision = new Map<
    string,
    {
      result: Result;
      classification: {
        state: ResultClassificationState | null;
        region: ResultClassificationRegion | null;
        reasons: string[] | null;
        confidence: number | null;
      };
    }[]
  >();
  if (revisionIds.length) {
    const rows = await db
      .select({
        result: results,
        state: resultClassifications.state,
        region: resultClassifications.region,
        reasons: resultClassifications.reasons,
        confidence: resultClassifications.confidence,
      })
      .from(results)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultId, results.id),
      )
      .where(
        and(
          eq(results.airfoilId, a.id),
          inArray(results.simulationPresetRevisionId, revisionIds),
          eq(results.source, "solved"),
          eq(results.status, "done"),
          or(
            inArray(resultClassifications.state, ["accepted", "needs_urans"]),
            and(isNull(resultClassifications.id), validPolarPoint),
          ),
        ),
      );
    for (const row of rows) {
      const r = row.result;
      if (
        !r.simulationPresetRevisionId ||
        !reByRevision.has(r.simulationPresetRevisionId)
      )
        continue;
      (
        solvedByRevision.get(r.simulationPresetRevisionId) ??
        solvedByRevision
          .set(r.simulationPresetRevisionId, [])
          .get(r.simulationPresetRevisionId)!
      ).push({
        result: r,
        classification: {
          state: row.state,
          region: row.region,
          reasons: row.reasons,
          confidence: row.confidence,
        },
      });
    }
  }

  const fitByRevision = new Map<string, PolarFit>();
  if (revisionIds.length) {
    const fitRows = await db
      .select()
      .from(polarFitSets)
      .where(
        and(
          inArray(polarFitSets.simulationPresetRevisionId, revisionIds),
          eq(polarFitSets.airfoilId, a.id),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const fitIds = fitRows.map((row) => row.id);
    const fitPointRows = fitIds.length
      ? await db
          .select()
          .from(polarFitPoints)
          .where(inArray(polarFitPoints.fitSetId, fitIds))
      : [];
    const fitPointsBySet = new Map<string, typeof fitPointRows>();
    for (const row of fitPointRows) {
      (
        fitPointsBySet.get(row.fitSetId) ??
        fitPointsBySet.set(row.fitSetId, []).get(row.fitSetId)!
      ).push(row);
    }
    for (const row of fitRows) {
      const points = (fitPointsBySet.get(row.id) ?? [])
        .sort((x, y) => x.aoaDeg - y.aoaDeg)
        .map((p) => ({
          a: p.aoaDeg,
          cl: p.cl,
          cd: p.cd,
          cm: p.cm,
          ld: p.clCd,
        }));
      fitByRevision.set(row.simulationPresetRevisionId, {
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
                // pre-v2 fit rows have no fine targets; the coarse peak stands in until refit
                alphaLdmaxFine: row.alphaLdmaxFine ?? row.alphaLdmax,
                alphaClZeroFine: row.alphaClZeroFine ?? null,
                // pre-v3 fit rows: null until refit — no coarse stand-in, a
                // boundary argmax must stay an honest absence (see 0035).
                alphaClmaxFine: row.alphaClmaxFine ?? null,
                cdmin: row.cdmin,
                clCd: row.clAtCdmin,
                cd0: row.cd0,
                clmax: row.clmax,
                aStall: row.alphaClmax,
                cm0: row.cm0,
              },
      });
    }
  }

  const solvedReValues = new Set<number>();
  for (const [revisionId, rows] of solvedByRevision) {
    if (rows.length) {
      const re = reByRevision.get(revisionId);
      if (re !== undefined) solvedReValues.add(re);
    }
  }
  for (const [revisionId, fit] of fitByRevision) {
    if (fit.points.length || fit.metrics) {
      const re = reByRevision.get(revisionId);
      if (re !== undefined) solvedReValues.add(re);
    }
  }
  // Pinned-revision scope: always surface the revision's Re so an empty
  // polar renders as explicitly-empty evidence, never as a missing curve.
  if (scopedRe != null) solvedReValues.add(scopedRe);
  const reList = [...solvedReValues].sort((a, b) => a - b);
  const polars: Polar[] = reList.map((re) => {
    const revision =
      (revisionsByRe.get(re) ?? []).find(
        (candidate) =>
          (solvedByRevision.get(candidate.id)?.length ?? 0) > 0 ||
          Boolean(fitByRevision.get(candidate.id)?.points.length),
      ) ?? (scopedRe != null ? (revisionsByRe.get(re) ?? [])[0] : undefined);
    const rows = revision ? solvedByRevision.get(revision.id) : undefined;
    const fit = revision ? fitByRevision.get(revision.id) : undefined;
    if (revision && rows && rows.length) {
      const points: PolarPointData[] = rows
        .sort((x, y) => x.result.aoaDeg - y.result.aoaDeg)
        .map((row) => solvedToPoint(row.result, row.classification));
      if (a.isSymmetric) {
        // Spec §9.2–§9.3: append display-only mirrored points; results rows and
        // solver-run counts stay real solves only.
        points.push(...mirroredSolvedPoints(rows));
        points.sort((x, y) => x.a - y.a);
      }
      return {
        re,
        mach: machByRevision.get(revision.id) ?? undefined,
        color: colorForRe(re),
        source: "solved",
        points,
        fit,
      };
    }
    return { re, color: colorForRe(re), source: "queued", points: [], fit };
  });
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
