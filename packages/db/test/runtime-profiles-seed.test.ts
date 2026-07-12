import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeCampaignLaunch } from "../src/campaigns";
import { createClient } from "../src/client";
import { databaseUrl } from "../src/env";
import {
  SEEDED_RUNTIME_PROFILE_SLUGS,
  seedRuntimeProfiles,
} from "../seed/runtime-profiles";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const dbName = `aerodb_seed_profiles_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  execFileSync("corepack", ["pnpm", "--filter", "@aerodb/db", "reset"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    stdio: "pipe",
  });
  client = postgres(targetUrl.toString(), { max: 1 });
});

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
});

describe("reset seed runtime profiles", () => {
  it("MUST-CATCH: the real reset command restores launchable runtime profiles exactly once", async () => {
    if (!client) throw new Error("seed profile test database is unavailable");
    const { db, sql } = createClient({ url: targetUrl.toString(), max: 1 });

    await seedRuntimeProfiles(db);
    await seedRuntimeProfiles(db);

    const rows = await client<
      Array<{ kind: string; slug: string; n: number; seeded: boolean }>
    >`
      SELECT 'boundary'::text AS kind, slug, count(*)::int AS n, bool_and(is_seeded) AS seeded
      FROM boundary_profiles GROUP BY slug
      UNION ALL
      SELECT 'mesh'::text AS kind, slug, count(*)::int AS n, bool_and(is_seeded) AS seeded
      FROM mesh_profiles GROUP BY slug
      UNION ALL
      SELECT 'solver'::text AS kind, slug, count(*)::int AS n, bool_and(is_seeded) AS seeded
      FROM solver_profiles GROUP BY slug
      UNION ALL
      SELECT 'output'::text AS kind, slug, count(*)::int AS n, bool_and(is_seeded) AS seeded
      FROM output_profiles GROUP BY slug
      UNION ALL
      SELECT 'scheduling'::text AS kind, slug, count(*)::int AS n, bool_and(is_seeded) AS seeded
      FROM scheduling_profiles GROUP BY slug
      ORDER BY kind, slug
    `;

    expect(rows).toEqual([
      {
        kind: "boundary",
        slug: SEEDED_RUNTIME_PROFILE_SLUGS.boundary,
        n: 1,
        seeded: true,
      },
      {
        kind: "mesh",
        slug: SEEDED_RUNTIME_PROFILE_SLUGS.mesh,
        n: 1,
        seeded: true,
      },
      {
        kind: "output",
        slug: SEEDED_RUNTIME_PROFILE_SLUGS.output,
        n: 1,
        seeded: true,
      },
      {
        kind: "scheduling",
        slug: SEEDED_RUNTIME_PROFILE_SLUGS.scheduling,
        n: 1,
        seeded: true,
      },
      {
        kind: "solver",
        slug: SEEDED_RUNTIME_PROFILE_SLUGS.solver,
        n: 1,
        seeded: true,
      },
    ]);

    const [baseline] = await client<
      Array<{
        turbulence: number;
        nSurface: number;
        nRadial: number;
        nWake: number;
        solver: string;
        fields: number;
      }>
    >`
      SELECT
        (SELECT turbulence_intensity FROM boundary_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.boundary}) AS turbulence,
        (SELECT n_surface FROM mesh_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.mesh}) AS "nSurface",
        (SELECT n_radial FROM mesh_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.mesh}) AS "nRadial",
        (SELECT n_wake FROM mesh_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.mesh}) AS "nWake",
        (SELECT turbulence_model FROM solver_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.solver}) AS solver,
        (SELECT jsonb_array_length(write_images) FROM output_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.output}) AS fields
    `;
    expect(baseline).toEqual({
      turbulence: 0.001,
      nSurface: 130,
      nRadial: 80,
      nWake: 60,
      solver: "kOmegaSST",
      fields: 8,
    });

    const [airfoil] = await client<{ id: string }[]>`
      SELECT id FROM airfoils WHERE "archivedAt" IS NULL AND "deletedAt" IS NULL ORDER BY slug LIMIT 1
    `;
    const [medium] = await client<{ id: string }[]>`
      SELECT id FROM mediums WHERE slug = 'air'
    `;
    const profiles = await client<Array<{ kind: string; id: string }>>`
      SELECT 'boundary'::text AS kind, id FROM boundary_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.boundary}
      UNION ALL SELECT 'mesh'::text, id FROM mesh_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.mesh}
      UNION ALL SELECT 'solver'::text, id FROM solver_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.solver}
      UNION ALL SELECT 'output'::text, id FROM output_profiles WHERE slug = ${SEEDED_RUNTIME_PROFILE_SLUGS.output}
    `;
    const profile = new Map(profiles.map((row) => [row.kind, row.id]));
    const launched = await materializeCampaignLaunch(db, {
      name: "Reset seed launch contract",
      notes: "Disposable reset-seed integration proof.",
      priority: 0,
      idempotencyKey: `reset-seed-${dbName}`,
      airfoilIds: [airfoil!.id],
      plan: {
        mediumId: medium!.id,
        ambients: [[288.15, 101325]],
        speedsMps: [30],
        chordsM: [0.1],
        spanM: 1,
        areaMode: "derived",
        excludedConditions: [],
        baseSweep: { fromDeg: -1, toDeg: 1, stepDeg: 1 },
        objectives: {
          ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
          clZero: { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
          clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
        },
        numerics: {
          boundaryProfileId: profile.get("boundary")!,
          meshProfileId: profile.get("mesh")!,
          uransMeshProfileId: profile.get("mesh")!,
          uransPrecalcMeshProfileId: profile.get("mesh")!,
          solverProfileId: profile.get("solver")!,
          outputProfileId: profile.get("output")!,
        },
      },
      markStaleAndResolve: false,
    });
    expect(launched.replayed).toBe(false);
    expect(launched.conditionCount).toBe(1);
    expect(launched.totals.requested).toBeGreaterThan(0);
    await sql.end();
  });
});
