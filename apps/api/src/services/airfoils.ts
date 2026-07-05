import {
  type AirfoilGeometry,
  type AirfoilSummary,
  deriveGeometry,
  isAirfoilSymmetric,
  nacaGeometry,
  type NacaParams,
  parseCoordinates,
  type Point,
  RELIST,
} from "@aerodb/core";
import { type Airfoil, airfoils, categories } from "@aerodb/db";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { syncAirfoilHashtagNames } from "./hashtags";

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "airfoil"
  );
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  // bounded loop; slugs are short and collisions rare
  for (let i = 0; i < 1000; i++) {
    const [exists] = await db.select({ id: airfoils.id }).from(airfoils).where(eq(airfoils.slug, slug)).limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

async function resolveCategory(categorySlug?: string): Promise<{ id: string; slug: string; name: string; path: string }> {
  if (categorySlug) {
    const [c] = await db
      .select({ id: categories.id, slug: categories.slug, name: categories.name, path: categories.path })
      .from(categories)
      .where(eq(categories.slug, categorySlug))
      .limit(1);
    if (c) return c;
  }
  const [existing] = await db
    .select({ id: categories.id, slug: categories.slug, name: categories.name, path: categories.path })
    .from(categories)
    .where(eq(categories.slug, "custom"))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(categories)
    .values({ slug: "custom", name: "Custom", path: "custom", depth: 0, sortOrder: 99, description: "User-added airfoils." })
    .onConflictDoUpdate({ target: categories.slug, set: { name: "Custom" } })
    .returning({ id: categories.id, slug: categories.slug, name: categories.name, path: categories.path });
  return created;
}

function summaryFromRow(
  row: Airfoil,
  family: { id: string; slug: string; name: string; path: string },
  hashtags: { id: string; slug: string; name: string }[] = [],
): AirfoilSummary {
  const tags = hashtags.length ? hashtags.map((h) => h.name) : row.tags;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    categoryId: family.id,
    categorySlug: family.slug,
    categoryPath: family.path,
    family: family.name,
    tags,
    hashtags,
    points: row.points as Point[],
    thicknessPct: row.thicknessPct ?? 0,
    areaProfile: row.areaProfile ?? 0,
    areaUpper: row.areaUpper ?? 0,
    areaLower: row.areaLower ?? 0,
    areaCamber: row.areaCamber ?? 0,
    areaUpperPositive: row.areaUpperPositive ?? Math.max(0, row.areaUpper ?? 0),
    areaUpperNegative: row.areaUpperNegative ?? Math.min(0, row.areaUpper ?? 0),
    areaLowerPositive: row.areaLowerPositive ?? Math.max(0, row.areaLower ?? 0),
    areaLowerNegative: row.areaLowerNegative ?? Math.min(0, row.areaLower ?? 0),
    areaCamberPositive: row.areaCamberPositive ?? Math.max(0, row.areaCamber ?? 0),
    areaCamberNegative: row.areaCamberNegative ?? Math.min(0, row.areaCamber ?? 0),
    camberPct: row.camberPct ?? 0,
    camberPosPct: row.camberXPct ?? 0,
    reMin: RELIST[0],
    reMax: RELIST[RELIST.length - 1],
    polarCount: 0,
    ldmax: null,
    clmax: null,
    cdmin: null,
    metricsSource: "queued",
  };
}

export interface CreateAirfoilInput {
  name?: string;
  categorySlug?: string;
  naca?: NacaParams;
  coordinates?: string;
}

/** Create one airfoil from NACA params or pasted coordinates. Derives geometry,
 *  assigns a unique slug, and leaves aerodynamic metrics queued. */
export async function createAirfoil(input: CreateAirfoilInput): Promise<AirfoilSummary> {
  let geo: AirfoilGeometry;
  let source = "user";
  let pointFormat = "selig";
  let naca: NacaParams | null = null;
  let name = input.name?.trim();

  if (input.naca) {
    naca = input.naca;
    geo = nacaGeometry(input.naca);
    source = "naca-analytic";
  } else if (input.coordinates?.trim()) {
    const parsed = parseCoordinates(input.coordinates);
    if (parsed.points.length < 10) throw new Error("not enough coordinate points (need ≥ 10)");
    geo = deriveGeometry(parsed.points);
    pointFormat = parsed.format;
    source = "coordinate-file";
    if (!name) name = parsed.name;
  } else {
    throw new Error("provide either naca params or coordinates");
  }
  if (!name) throw new Error("name is required");

  const cat = await resolveCategory(input.categorySlug);
  const slug = await uniqueSlug(slugify(name));
  const tags = [cat.name.toUpperCase(), geo.camberPct > 0.5 ? "CAMBERED" : "SYMMETRIC"];

  // Real geometric symmetry (spec §9.1) — computed at creation time from the
  // stored contour so campaign symmetry planning applies to new airfoils, not
  // only rows touched by the one-off backfill script. Detection failure is
  // recorded honestly: isSymmetric=false with symmetryCheckedAt=null (unknown).
  let isSymmetric = false;
  let symmetryCheckedAt: Date | null = null;
  try {
    isSymmetric = isAirfoilSymmetric(geo.contour);
    symmetryCheckedAt = new Date();
  } catch {
    isSymmetric = false;
    symmetryCheckedAt = null;
  }

  const [row] = await db
    .insert(airfoils)
    .values({
      slug,
      name,
      categoryId: cat.id,
      source,
      points: geo.contour,
      pointFormat,
      nacaT: naca?.t ?? null,
      nacaM: naca?.m ?? null,
      nacaP: naca?.p ?? null,
      isSymmetric,
      symmetryCheckedAt,
      thicknessPct: geo.thicknessPct,
      thicknessXPct: geo.thicknessXPct,
      camberPct: geo.camberPct,
      camberXPct: geo.camberXPct,
      leRadiusPct: geo.leRadiusPct,
      teThicknessPct: geo.teThicknessPct,
      areaProfile: geo.areaProfile,
      areaUpper: geo.areaUpper,
      areaLower: geo.areaLower,
      areaCamber: geo.areaCamber,
      areaUpperPositive: geo.areaUpperPositive,
      areaUpperNegative: geo.areaUpperNegative,
      areaLowerPositive: geo.areaLowerPositive,
      areaLowerNegative: geo.areaLowerNegative,
      areaCamberPositive: geo.areaCamberPositive,
      areaCamberNegative: geo.areaCamberNegative,
      refRe: null,
      refLdmax: null,
      refClmax: null,
      refCdmin: null,
      refMetricsSource: "queued",
      tags,
    })
    .returning();
  const hashtags = await syncAirfoilHashtagNames(row.id, tags);
  return summaryFromRow(row, cat, hashtags);
}

export interface BulkItem {
  name?: string;
  coordinates: string;
}

export async function createAirfoilsBulk(
  items: BulkItem[],
  categorySlug?: string,
): Promise<{ created: AirfoilSummary[]; errors: { name: string; error: string }[] }> {
  const created: AirfoilSummary[] = [];
  const errors: { name: string; error: string }[] = [];
  for (const item of items) {
    try {
      created.push(await createAirfoil({ name: item.name, coordinates: item.coordinates, categorySlug }));
    } catch (e) {
      errors.push({ name: item.name || "(unnamed)", error: (e as Error).message });
    }
  }
  return { created, errors };
}
