import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deriveGeometry,
  parseCoordinates,
  type AirfoilGeometry,
} from "@aerodb/core";
import { eq } from "drizzle-orm";

import { createClient } from "../src/client";
import {
  airfoilHashtags,
  airfoils,
  categories,
  hashtags,
  mediumViscosityTablePoints,
  mediums,
  sweeperState,
} from "../src/schema";
import {
  assertSeedCoordinateIntegrity,
  seedSourceDisposition,
} from "./coordinate-integrity";
import { seedRuntimeProfiles } from "./runtime-profiles";

const here = dirname(fileURLToPath(import.meta.url));
const seligDir = join(here, "selig-database");
const mediumsFile = join(here, "mediums.json");

interface CategorySeed {
  slug: string;
  name: string;
  parentSlug: string | null;
  sortOrder: number;
  description?: string;
}

interface MediumTableSeed {
  temperatureK: number;
  dynamicViscosity: number;
  sortOrder?: number;
}

interface MediumSeed {
  slug: string;
  name: string;
  phase: "gas" | "liquid";
  density: number;
  refTemperatureK: number;
  refPressurePa: number;
  viscosityModel: "constant" | "sutherland" | "table";
  constantDynamicViscosity?: number | null;
  sutherlandMuRef?: number | null;
  sutherlandTRef?: number | null;
  sutherlandS?: number | null;
  dynamicViscosity: number;
  kinematicViscosity: number;
  speedOfSound?: number | null;
  notes?: string | null;
  viscosityTable?: MediumTableSeed[];
}

interface MediumSeedFile {
  schemaVersion: number;
  source: Record<string, unknown>;
  mediums: MediumSeed[];
}

const CATEGORY_SEEDS: CategorySeed[] = [
  {
    slug: "selig-database",
    name: "Selig Database",
    parentSlug: null,
    sortOrder: 0,
    description:
      "Airfoil coordinate files imported from the Selig/UIUC coordinate database.",
  },
  { slug: "naca", name: "NACA", parentSlug: "selig-database", sortOrder: 0 },
  {
    slug: "naca-4-digit",
    name: "NACA 4-digit",
    parentSlug: "naca",
    sortOrder: 0,
  },
  {
    slug: "naca-5-digit",
    name: "NACA 5-digit",
    parentSlug: "naca",
    sortOrder: 1,
  },
  {
    slug: "naca-6-series",
    name: "NACA 6-series",
    parentSlug: "naca",
    sortOrder: 2,
  },
  { slug: "naca-other", name: "NACA other", parentSlug: "naca", sortOrder: 3 },
  {
    slug: "gottingen",
    name: "Gottingen",
    parentSlug: "selig-database",
    sortOrder: 1,
  },
  {
    slug: "eppler",
    name: "Eppler",
    parentSlug: "selig-database",
    sortOrder: 2,
  },
  {
    slug: "wortmann-fx",
    name: "Wortmann FX",
    parentSlug: "selig-database",
    sortOrder: 3,
  },
  {
    slug: "drela-ag",
    name: "Drela AG",
    parentSlug: "selig-database",
    sortOrder: 4,
  },
  {
    slug: "selig-series",
    name: "Selig series",
    parentSlug: "selig-database",
    sortOrder: 5,
  },
  {
    slug: "selig-sd",
    name: "SD series",
    parentSlug: "selig-series",
    sortOrder: 0,
  },
  {
    slug: "selig-sg",
    name: "SG series",
    parentSlug: "selig-series",
    sortOrder: 1,
  },
  {
    slug: "selig-s",
    name: "S/SC series",
    parentSlug: "selig-series",
    sortOrder: 2,
  },
  {
    slug: "hepperle",
    name: "Hepperle",
    parentSlug: "selig-database",
    sortOrder: 6,
  },
  {
    slug: "mh-series",
    name: "MH series",
    parentSlug: "hepperle",
    sortOrder: 0,
  },
  {
    slug: "hq-series",
    name: "HQ series",
    parentSlug: "hepperle",
    sortOrder: 1,
  },
  {
    slug: "aircraft-and-classic",
    name: "Aircraft and classic",
    parentSlug: "selig-database",
    sortOrder: 7,
  },
  {
    slug: "research",
    name: "Research",
    parentSlug: "selig-database",
    sortOrder: 8,
  },
  {
    slug: "other-families",
    name: "Other families",
    parentSlug: "selig-database",
    sortOrder: 9,
  },
];

function categoryPath(
  slug: string,
  bySlug: Map<string, CategorySeed>,
): { path: string; depth: number } {
  const chain: string[] = [];
  let cur: string | null = slug;
  while (cur) {
    const node = bySlug.get(cur);
    if (!node) break;
    chain.unshift(node.slug);
    cur = node.parentSlug;
  }
  return { path: chain.join("/"), depth: chain.length - 1 };
}

function tagSlug(tag: string): string {
  return (
    tag
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tag"
  );
}

function slugifyName(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "airfoil"
  );
}

function slugForStem(stem: string): string {
  const lower = stem.toLowerCase().trim();
  const nacaShort = lower.match(/^n(\d.*)$/);
  if (nacaShort) return slugifyName(`naca-${nacaShort[1]}`);
  const nacaCompact = lower.match(/^naca(\d.*)$/);
  if (nacaCompact) return slugifyName(`naca-${nacaCompact[1]}`);
  return slugifyName(stem);
}

function uniqueSlug(base: string, stem: string, used: Set<string>): string {
  let slug = base;
  if (used.has(slug)) slug = `${base}-${slugifyName(stem)}`;
  let suffix = 2;
  while (used.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(slug);
  return slug;
}

function isNacaFamily(stem: string): boolean {
  return /^(naca|n)\d/.test(stem);
}

function categoryForStem(stem: string): string {
  if (/^(naca|n)\d{4}($|[^0-9])/.test(stem)) return "naca-4-digit";
  if (/^(naca|n)\d{5}($|[^0-9])/.test(stem)) return "naca-5-digit";
  if (/^(naca|n)(6|7|8)\d/.test(stem)) return "naca-6-series";
  if (isNacaFamily(stem)) return "naca-other";
  if (/^goe\d/.test(stem)) return "gottingen";
  if (/^e\d/.test(stem)) return "eppler";
  if (/^fx/.test(stem)) return "wortmann-fx";
  if (/^ag\d/.test(stem)) return "drela-ag";
  if (/^sd\d/.test(stem)) return "selig-sd";
  if (/^sg\d/.test(stem)) return "selig-sg";
  if (/^s(c)?\d/.test(stem)) return "selig-s";
  if (/^mh\d/.test(stem)) return "mh-series";
  if (/^hq\d/.test(stem)) return "hq-series";
  if (/^(nlf|nlr|rae|tsagi|dfv|dfvlr|hsnlf|oaf|r(ae)?|ui|ls|ms)/.test(stem))
    return "research";
  if (
    /^(clark|raf|usa|p51|b737|kc135|curtis|supermarine|davis|davissm|hobie|boeing|dae|dga)/.test(
      stem,
    )
  ) {
    return "aircraft-and-classic";
  }
  return "other-families";
}

function spacedPrefix(stem: string): string {
  const upper = stem.toUpperCase();
  const known = [
    ["NACA", /^NACA(.+)/],
    ["GOE", /^GOE(.+)/],
    ["FX", /^FX(.+)/],
    ["AG", /^AG(.+)/],
    ["SD", /^SD(.+)/],
    ["SG", /^SG(.+)/],
    ["MH", /^MH(.+)/],
    ["HQ", /^HQ(.+)/],
    ["RAF", /^RAF(.+)/],
    ["USA", /^USA(.+)/],
    ["NLR", /^NLR(.+)/],
    ["NLF", /^NLF(.+)/],
    ["RAE", /^RAE(.+)/],
  ] as const;
  for (const [prefix, pattern] of known) {
    const match = upper.match(pattern);
    if (match) return `${prefix} ${match[1]}`;
  }
  if (/^N\d/.test(upper)) return `NACA ${upper.slice(1)}`;
  return upper;
}

function titleFromFile(stem: string, parsedName: string): string {
  const firstHeaderPart = parsedName.split("|")[0]?.trim();
  const candidate =
    firstHeaderPart && firstHeaderPart.toLowerCase() !== "airfoil"
      ? firstHeaderPart
      : "";
  const stemName = spacedPrefix(stem);
  if (!candidate) return stemName;

  const upperStem = stemName.replace(/\s+/g, "");
  const headerToken = candidate.split(/\s+/).slice(0, 3).join(" ");
  const upperHeader = headerToken.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (upperHeader.includes(upperStem.replace(/[^A-Za-z0-9]/g, "")))
    return headerToken;
  return stemName;
}

function tagsFor(category: CategorySeed, geo: AirfoilGeometry): string[] {
  const tags = [
    "SELIG-DATABASE",
    category.name.toUpperCase(),
    geo.camberPct > 0.5 ? "CAMBERED" : "SYMMETRIC",
  ];
  if (geo.thicknessPct <= 8) tags.push("THIN");
  if (geo.thicknessPct >= 15) tags.push("THICK");
  return Array.from(new Set(tags));
}

function seligFiles(): string[] {
  return readdirSync(seligDir)
    .filter(
      (file) => !file.startsWith(".") && extname(file).toLowerCase() === ".dat",
    )
    .sort((a, b) => a.localeCompare(b));
}

function mediumSeeds(): MediumSeed[] {
  const parsed = JSON.parse(
    readFileSync(mediumsFile, "utf8"),
  ) as MediumSeedFile;
  if (parsed.schemaVersion !== 1)
    throw new Error(`unsupported mediums seed schema ${parsed.schemaVersion}`);
  if (!Array.isArray(parsed.mediums) || parsed.mediums.length < 50) {
    throw new Error("mediums seed must contain at least 50 verified mediums");
  }
  for (const requiredSlug of [
    "air",
    "water",
    "hydrogen",
    "nitrogen",
    "carbon-dioxide",
  ]) {
    if (!parsed.mediums.some((medium) => medium.slug === requiredSlug)) {
      throw new Error(
        `mediums seed is missing required medium ${requiredSlug}`,
      );
    }
  }
  return parsed.mediums;
}

async function seedMediums(db: ReturnType<typeof createClient>["db"]) {
  const rows = mediumSeeds();
  for (const medium of rows) {
    const [row] = await db
      .insert(mediums)
      .values({
        slug: medium.slug,
        name: medium.name,
        phase: medium.phase,
        density: medium.density,
        refTemperatureK: medium.refTemperatureK,
        refPressurePa: medium.refPressurePa,
        viscosityModel: medium.viscosityModel,
        constantDynamicViscosity: medium.constantDynamicViscosity ?? null,
        sutherlandMuRef: medium.sutherlandMuRef ?? null,
        sutherlandTRef: medium.sutherlandTRef ?? null,
        sutherlandS: medium.sutherlandS ?? null,
        dynamicViscosity: medium.dynamicViscosity,
        kinematicViscosity: medium.kinematicViscosity,
        speedOfSound: medium.speedOfSound ?? null,
        notes: medium.notes ?? null,
        isSeeded: true,
      })
      .onConflictDoUpdate({
        target: mediums.slug,
        set: {
          name: medium.name,
          phase: medium.phase,
          density: medium.density,
          refTemperatureK: medium.refTemperatureK,
          refPressurePa: medium.refPressurePa,
          viscosityModel: medium.viscosityModel,
          constantDynamicViscosity: medium.constantDynamicViscosity ?? null,
          sutherlandMuRef: medium.sutherlandMuRef ?? null,
          sutherlandTRef: medium.sutherlandTRef ?? null,
          sutherlandS: medium.sutherlandS ?? null,
          dynamicViscosity: medium.dynamicViscosity,
          kinematicViscosity: medium.kinematicViscosity,
          speedOfSound: medium.speedOfSound ?? null,
          notes: medium.notes ?? null,
          isSeeded: true,
        },
      })
      .returning({ id: mediums.id });

    await db
      .delete(mediumViscosityTablePoints)
      .where(eq(mediumViscosityTablePoints.mediumId, row.id));
    const table =
      medium.viscosityModel === "table" ? (medium.viscosityTable ?? []) : [];
    if (table.length) {
      await db.insert(mediumViscosityTablePoints).values(
        table.map((point, i) => ({
          mediumId: row.id,
          temperatureK: point.temperatureK,
          dynamicViscosity: point.dynamicViscosity,
          sortOrder: point.sortOrder ?? i,
        })),
      );
    }
  }
  console.log(`  ok ${rows.length} CoolProp verified mediums`);
}

async function main() {
  const { db, sql } = createClient({ max: 1 });
  console.log(
    "Seeding Airfoils.Pro from Selig coordinate files and verified medium data...",
  );

  const catBySlug = new Map(CATEGORY_SEEDS.map((c) => [c.slug, c]));
  const catId = new Map<string, string>();
  const ordered = [...CATEGORY_SEEDS].sort(
    (a, b) =>
      categoryPath(a.slug, catBySlug).depth -
        categoryPath(b.slug, catBySlug).depth || a.sortOrder - b.sortOrder,
  );
  for (const c of ordered) {
    const { path, depth } = categoryPath(c.slug, catBySlug);
    const parentId = c.parentSlug ? (catId.get(c.parentSlug) ?? null) : null;
    const [row] = await db
      .insert(categories)
      .values({
        slug: c.slug,
        name: c.name,
        parentId,
        path,
        depth,
        sortOrder: c.sortOrder,
        description: c.description,
      })
      .onConflictDoUpdate({
        target: categories.slug,
        set: {
          name: c.name,
          parentId,
          path,
          depth,
          sortOrder: c.sortOrder,
          description: c.description,
        },
      })
      .returning({ id: categories.id });
    catId.set(c.slug, row.id);
  }
  console.log(`  ok ${CATEGORY_SEEDS.length} categories`);

  await seedMediums(db);
  await seedRuntimeProfiles(db);
  console.log("  ok campaign runtime profiles");

  const files = seligFiles();
  let imported = 0;
  const errors: string[] = [];
  const usedAirfoilSlugs = new Set<string>();
  for (const file of files) {
    const stem = file.slice(0, -extname(file).length);
    const categorySlug = categoryForStem(stem.toLowerCase());
    const category = catBySlug.get(categorySlug);
    const categoryId = category ? catId.get(category.slug) : null;
    if (!category || !categoryId) {
      errors.push(`${file}: missing category ${categorySlug}`);
      continue;
    }

    try {
      const text = readFileSync(join(seligDir, file), "utf8");
      const parsed = parseCoordinates(text);
      assertSeedCoordinateIntegrity(text, file);
      const sourceDisposition = seedSourceDisposition(file);
      const geo = deriveGeometry(parsed.points);
      const tags = tagsFor(category, geo);
      if (!sourceDisposition.catalogEligible) {
        tags.push("source-component", "solver-unsupported");
      }
      const baseSlug = slugForStem(stem);
      const values = {
        slug: uniqueSlug(baseSlug, stem, usedAirfoilSlugs),
        name: titleFromFile(stem, parsed.name),
        categoryId,
        source: "selig-database",
        points: geo.contour,
        pointFormat: parsed.format,
        nacaT: null,
        nacaM: null,
        nacaP: null,
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
        refMetricsSource: "queued" as const,
        tags,
        // These two authoritative files are valid source records but not
        // closed airfoils. Preserve their coordinates/provenance while keeping
        // them out of browse and campaign selection; never synthesize closure.
        archivedAt: sourceDisposition.catalogEligible
          ? null
          : new Date("2026-07-13T00:00:00.000Z"),
        deletedAt: null,
      };
      const { slug: _slug, ...updatable } = values;
      const [row] = await db
        .insert(airfoils)
        .values(values)
        .onConflictDoUpdate({ target: airfoils.slug, set: updatable })
        .returning({ id: airfoils.id });

      await db
        .delete(airfoilHashtags)
        .where(eq(airfoilHashtags.airfoilId, row.id));
      for (const tag of tags) {
        const [h] = await db
          .insert(hashtags)
          .values({ slug: tagSlug(tag), name: tag })
          .onConflictDoUpdate({ target: hashtags.slug, set: { name: tag } })
          .returning({ id: hashtags.id });
        await db
          .insert(airfoilHashtags)
          .values({ airfoilId: row.id, hashtagId: h.id })
          .onConflictDoNothing();
      }
      imported += 1;
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  console.log(`  ok ${imported}/${files.length} airfoils imported`);
  if (errors.length) {
    console.error(errors.slice(0, 25).join("\n"));
    if (errors.length > 25)
      console.error(`... ${errors.length - 25} more errors`);
    throw new Error(`failed to import ${errors.length} Selig coordinate files`);
  }

  await db.insert(sweeperState).values({ id: 1 }).onConflictDoNothing();
  console.log("  ok sweeper_state");

  await sql.end();
  console.log(
    "Done. Airfoils and mediums are seeded; boundary conditions, jobs, results, and media are intentionally empty after reset.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
