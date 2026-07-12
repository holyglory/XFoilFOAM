import {
  type AirfoilSummary,
  type CategoryNode,
  POLAR_FIT_VERSION,
  RELIST,
} from "@aerodb/core";
import { airfoils, categories, polarFitSets } from "@aerodb/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { db } from "../db";
import { hashtagsByAirfoilIds } from "./hashtags";

export async function categoriesTree(): Promise<CategoryNode[]> {
  const cats = await db
    .select()
    .from(categories)
    .orderBy(asc(categories.sortOrder));
  const afRows = await db
    .select({ path: categories.path })
    .from(airfoils)
    .innerJoin(categories, eq(airfoils.categoryId, categories.id))
    .where(and(isNull(airfoils.archivedAt), isNull(airfoils.deletedAt)));
  const paths = afRows.map((r) => r.path);
  const directCount = (catPath: string) =>
    paths.filter((p) => p === catPath).length;
  const subtreeCount = (catPath: string) =>
    paths.filter((p) => p === catPath || p.startsWith(catPath + "/")).length;

  const byId = new Map<string, CategoryNode>();
  for (const c of cats) {
    byId.set(c.id, {
      id: c.id,
      slug: c.slug,
      name: c.name,
      path: c.path,
      depth: c.depth,
      directAirfoilCount: directCount(c.path),
      airfoilCount: subtreeCount(c.path),
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const c of cats) {
    const node = byId.get(c.id)!;
    if (c.parentId && byId.has(c.parentId))
      byId.get(c.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export interface ListOpts {
  category?: string;
  includeSubcategories?: boolean;
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  hashtags?: string[];
  thicknessMin?: number;
  thicknessMax?: number;
  areaMin?: number;
  areaMax?: number;
  upperAreaMin?: number;
  upperAreaMax?: number;
  upperPositiveMin?: number;
  upperPositiveMax?: number;
  upperNegativeMin?: number;
  upperNegativeMax?: number;
  lowerAreaMin?: number;
  lowerAreaMax?: number;
  lowerPositiveMin?: number;
  lowerPositiveMax?: number;
  lowerNegativeMin?: number;
  lowerNegativeMax?: number;
  camberAreaMin?: number;
  camberAreaMax?: number;
  camberPositiveMin?: number;
  camberPositiveMax?: number;
  camberNegativeMin?: number;
  camberNegativeMax?: number;
  includePoints?: boolean;
}

// Default ceiling when no explicit limit is given. The portal is meant to hold a
// large, continuously-growing catalog (the UIUC set alone is ~1,600 airfoils), so
// this must be well above the old 100 or Browse silently hides most of the database.
const DEFAULT_LIMIT = 5000;

const SORT_COLS = {
  name: airfoils.name,
  family: categories.name,
  thickness: airfoils.thicknessPct,
  camber: airfoils.camberPct,
  area: airfoils.areaProfile,
} as const;

function addRange(
  conds: SQL[],
  col: Parameters<typeof gte>[0],
  min?: number,
  max?: number,
): void {
  if (typeof min === "number" && Number.isFinite(min))
    conds.push(gte(col, min));
  if (typeof max === "number" && Number.isFinite(max))
    conds.push(lte(col, max));
}

export async function listAirfoils(opts: ListOpts): Promise<AirfoilSummary[]> {
  const conds: SQL[] = [
    isNull(airfoils.archivedAt),
    isNull(airfoils.deletedAt),
  ];
  if (opts.category) {
    const [c] = await db
      .select({ id: categories.id, path: categories.path })
      .from(categories)
      .where(eq(categories.slug, opts.category))
      .limit(1);
    if (c) {
      const cond =
        opts.includeSubcategories === false
          ? eq(categories.id, c.id)
          : or(
              eq(categories.path, c.path),
              like(categories.path, c.path + "/%"),
            );
      if (cond) conds.push(cond);
    }
  }
  if (opts.q) {
    conds.push(ilike(airfoils.name, `%${opts.q}%`));
  }
  addRange(conds, airfoils.thicknessPct, opts.thicknessMin, opts.thicknessMax);
  addRange(conds, airfoils.areaProfile, opts.areaMin, opts.areaMax);
  addRange(conds, airfoils.areaUpper, opts.upperAreaMin, opts.upperAreaMax);
  addRange(
    conds,
    airfoils.areaUpperPositive,
    opts.upperPositiveMin,
    opts.upperPositiveMax,
  );
  addRange(
    conds,
    airfoils.areaUpperNegative,
    opts.upperNegativeMin,
    opts.upperNegativeMax,
  );
  addRange(conds, airfoils.areaLower, opts.lowerAreaMin, opts.lowerAreaMax);
  addRange(
    conds,
    airfoils.areaLowerPositive,
    opts.lowerPositiveMin,
    opts.lowerPositiveMax,
  );
  addRange(
    conds,
    airfoils.areaLowerNegative,
    opts.lowerNegativeMin,
    opts.lowerNegativeMax,
  );
  addRange(conds, airfoils.areaCamber, opts.camberAreaMin, opts.camberAreaMax);
  addRange(
    conds,
    airfoils.areaCamberPositive,
    opts.camberPositiveMin,
    opts.camberPositiveMax,
  );
  addRange(
    conds,
    airfoils.areaCamberNegative,
    opts.camberNegativeMin,
    opts.camberNegativeMax,
  );

  const sort = opts.sort ?? "name";
  const sortCol = SORT_COLS[sort as keyof typeof SORT_COLS] ?? airfoils.name;
  const solvedSort = sort === "ldmax" || sort === "clmax" || sort === "cdmin";
  // Geometry-metric sorts must keep NULL-metric rows LAST in both directions
  // (postgres defaults DESC to NULLS FIRST, which put metric-less rows above
  // "FX 79-W-660A" at 66.39% t/c) — mirroring the solved-metric in-memory
  // sort below, which already sends missing values to the tail.
  const nullableMetricSort =
    sort === "thickness" || sort === "camber" || sort === "area";
  const rows = await db
    .select({
      id: airfoils.id,
      slug: airfoils.slug,
      name: airfoils.name,
      categoryId: categories.id,
      categorySlug: categories.slug,
      categoryPath: categories.path,
      family: categories.name,
      tags: airfoils.tags,
      points: opts.includePoints === false ? sql`'[]'::jsonb` : airfoils.points,
      thicknessPct: airfoils.thicknessPct,
      areaProfile: airfoils.areaProfile,
      areaUpper: airfoils.areaUpper,
      areaLower: airfoils.areaLower,
      areaCamber: airfoils.areaCamber,
      areaUpperPositive: airfoils.areaUpperPositive,
      areaUpperNegative: airfoils.areaUpperNegative,
      areaLowerPositive: airfoils.areaLowerPositive,
      areaLowerNegative: airfoils.areaLowerNegative,
      areaCamberPositive: airfoils.areaCamberPositive,
      areaCamberNegative: airfoils.areaCamberNegative,
      camberPct: airfoils.camberPct,
      camberPosPct: airfoils.camberXPct,
    })
    .from(airfoils)
    .innerJoin(categories, eq(airfoils.categoryId, categories.id))
    .where(and(...conds))
    .orderBy(
      solvedSort
        ? asc(airfoils.name)
        : nullableMetricSort
          ? opts.dir === "desc"
            ? sql`${sortCol} DESC NULLS LAST`
            : sql`${sortCol} ASC NULLS LAST`
          : opts.dir === "desc"
            ? desc(sortCol)
            : asc(sortCol),
      asc(airfoils.name),
    )
    .limit(opts.limit ?? DEFAULT_LIMIT)
    .offset(0);

  const tagMap = await hashtagsByAirfoilIds(rows.map((r) => r.id));
  const wantedTags = (opts.hashtags ?? []).map((h) => h.trim()).filter(Boolean);
  const filtered = wantedTags.length
    ? rows.filter((row) => {
        const slugs = new Set((tagMap.get(row.id) ?? []).map((h) => h.slug));
        return wantedTags.every((h) => slugs.has(h));
      })
    : rows;

  const candidateIds = filtered.map((r) => r.id);
  const metricRows = candidateIds.length
    ? await db
        .select({
          airfoilId: polarFitSets.airfoilId,
          ldmax: polarFitSets.ldmax,
          clmax: polarFitSets.clmax,
          cdmin: polarFitSets.cdmin,
          fitStatus: polarFitSets.status,
          fitConfidence: polarFitSets.confidence,
          pointCount: sql<number>`(${polarFitSets.acceptedPointCount} + ${polarFitSets.provisionalPointCount})::int`,
          provisionalPointCount: polarFitSets.provisionalPointCount,
          updatedAt: polarFitSets.updatedAt,
        })
        .from(polarFitSets)
        .where(
          and(
            inArray(polarFitSets.airfoilId, candidateIds),
            eq(polarFitSets.isCurrent, true),
            eq(polarFitSets.fitVersion, POLAR_FIT_VERSION),
            inArray(polarFitSets.status, ["final", "provisional"]),
            sql`${polarFitSets.ldmax} IS NOT NULL`,
            sql`exists (
              select 1
              from simulation_preset_revisions rev
              inner join simulation_presets preset on preset.id = rev.preset_id
              inner join flow_conditions fc on fc.id = preset.flow_condition_id
              inner join mediums medium on medium.id = fc.medium_id
              where rev.id = ${polarFitSets.simulationPresetRevisionId}
                and preset.enabled = true
                and medium.slug = 'air'
            )`,
          ),
        )
    : [];
  const metricMap = new Map<string, (typeof metricRows)[number]>();
  for (const row of metricRows) {
    const current = metricMap.get(row.airfoilId);
    const statusRank = (status: string) =>
      status === "final" ? 2 : status === "provisional" ? 1 : 0;
    if (
      !current ||
      statusRank(row.fitStatus) > statusRank(current.fitStatus) ||
      (statusRank(row.fitStatus) === statusRank(current.fitStatus) &&
        row.pointCount > current.pointCount) ||
      (statusRank(row.fitStatus) === statusRank(current.fitStatus) &&
        row.pointCount === current.pointCount &&
        row.updatedAt > current.updatedAt)
    ) {
      metricMap.set(row.airfoilId, row);
    }
  }

  const summaries = filtered.map((r) => {
    const normalizedTags = tagMap.get(r.id) ?? [];
    const metric = metricMap.get(r.id);
    const polarCount = Number(metric?.pointCount ?? 0);
    const metricsSource: AirfoilSummary["metricsSource"] =
      polarCount > 0 ? "solved" : "queued";
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      categoryId: r.categoryId,
      categorySlug: r.categorySlug,
      categoryPath: r.categoryPath,
      family: r.family,
      tags: normalizedTags.length ? normalizedTags.map((h) => h.name) : r.tags,
      hashtags: normalizedTags,
      points: r.points as AirfoilSummary["points"],
      // Missing geometry metrics stay NULL in the DTO — a zero here is a lie
      // (and camber 0.0 is REAL for symmetric airfoils, so the UI must be
      // able to tell "0.0" from "not computed").
      thicknessPct: r.thicknessPct ?? null,
      areaProfile: r.areaProfile ?? null,
      areaUpper: r.areaUpper ?? 0,
      areaLower: r.areaLower ?? 0,
      areaCamber: r.areaCamber ?? 0,
      areaUpperPositive: r.areaUpperPositive ?? Math.max(0, r.areaUpper ?? 0),
      areaUpperNegative: r.areaUpperNegative ?? Math.min(0, r.areaUpper ?? 0),
      areaLowerPositive: r.areaLowerPositive ?? Math.max(0, r.areaLower ?? 0),
      areaLowerNegative: r.areaLowerNegative ?? Math.min(0, r.areaLower ?? 0),
      areaCamberPositive:
        r.areaCamberPositive ?? Math.max(0, r.areaCamber ?? 0),
      areaCamberNegative:
        r.areaCamberNegative ?? Math.min(0, r.areaCamber ?? 0),
      camberPct: r.camberPct ?? null,
      camberPosPct: r.camberPosPct ?? null,
      reMin: RELIST[0],
      reMax: RELIST[RELIST.length - 1],
      polarCount,
      ldmax: metric?.ldmax == null ? null : Number(metric.ldmax),
      clmax: metric?.clmax == null ? null : Number(metric.clmax),
      cdmin: metric?.cdmin == null ? null : Number(metric.cdmin),
      metricsSource,
      fitStatus: metric?.fitStatus ?? null,
      fitConfidence: metric?.fitConfidence ?? null,
    };
  });

  if (solvedSort) {
    const metricValue = (a: AirfoilSummary): number | null => {
      if (sort === "ldmax") return a.ldmax;
      if (sort === "clmax") return a.clmax;
      return a.cdmin;
    };
    summaries.sort((a, b) => {
      const av = metricValue(a);
      const bv = metricValue(b);
      const aMissing = av == null || !Number.isFinite(av);
      const bMissing = bv == null || !Number.isFinite(bv);
      if (aMissing && bMissing) return a.name.localeCompare(b.name);
      if (aMissing) return 1;
      if (bMissing) return -1;
      const metricDelta = opts.dir === "asc" ? av - bv : bv - av;
      return metricDelta || a.name.localeCompare(b.name);
    });
  }

  return summaries.slice(
    opts.offset ?? 0,
    (opts.offset ?? 0) + (opts.limit ?? DEFAULT_LIMIT),
  );
}
