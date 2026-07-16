import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/env";
import {
  FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
  FOUNDATION_14_EXECUTION_POOL_ID,
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2406_EXECUTION_POOL_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
} from "../src/solver-implementations";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_solver_identity_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let through64 = "";
let through65 = "";
const historicalRevisionId = "65000000-0000-0000-0000-00000000000b";

function makeMigrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-00${upTo}-`));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= upTo);
  for (const entry of entries) {
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  through64 = makeMigrationFolder(64);
  through65 = makeMigrationFolder(65);
  await migrate(drizzle(client), { migrationsFolder: through64 });
  await client.unsafe(`
    INSERT INTO mediums
      (id, slug, name, phase, density, viscosity_model,
       constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
    VALUES
      ('65000000-0000-0000-0000-000000000001', 'pre-engine-air',
       'Pre-engine air', 'gas', 1.225, 'constant', 0.00001789,
       0.00001789, 0.000014604);
    INSERT INTO flow_conditions
      (id, slug, name, medium_id, speed_mps, density,
       dynamic_viscosity, kinematic_viscosity)
    VALUES
      ('65000000-0000-0000-0000-000000000002', 'pre-engine-flow',
       'Pre-engine flow', '65000000-0000-0000-0000-000000000001', 20,
       1.225, 0.00001789, 0.000014604);
    INSERT INTO reference_geometry_profiles (id, slug, name, reference_length_m)
    VALUES ('65000000-0000-0000-0000-000000000003', 'pre-engine-geometry',
            'Pre-engine geometry', 1);
    INSERT INTO boundary_profiles (id, slug, name)
    VALUES ('65000000-0000-0000-0000-000000000004', 'pre-engine-boundary',
            'Pre-engine boundary');
    INSERT INTO mesh_profiles (id, slug, name)
    VALUES ('65000000-0000-0000-0000-000000000005', 'pre-engine-mesh',
            'Pre-engine mesh');
    INSERT INTO solver_profiles (id, slug, name)
    VALUES ('65000000-0000-0000-0000-000000000006', 'pre-engine-profile',
            'Pre-engine profile');
    INSERT INTO scheduling_profiles (id, slug, name)
    VALUES ('65000000-0000-0000-0000-000000000007', 'pre-engine-scheduling',
            'Pre-engine scheduling');
    INSERT INTO output_profiles (id, slug, name)
    VALUES ('65000000-0000-0000-0000-000000000008', 'pre-engine-output',
            'Pre-engine output');
    INSERT INTO sweep_definitions (id, slug, name)
    VALUES ('65000000-0000-0000-0000-000000000009', 'pre-engine-sweep',
            'Pre-engine sweep');
    INSERT INTO simulation_presets
      (id, slug, name, flow_condition_id, reference_geometry_profile_id,
       boundary_profile_id, mesh_profile_id, solver_profile_id,
       scheduling_profile_id, output_profile_id, sweep_definition_id)
    VALUES
      ('65000000-0000-0000-0000-00000000000a', 'pre-engine-preset',
       'Pre-engine preset', '65000000-0000-0000-0000-000000000002',
       '65000000-0000-0000-0000-000000000003',
       '65000000-0000-0000-0000-000000000004',
       '65000000-0000-0000-0000-000000000005',
       '65000000-0000-0000-0000-000000000006',
       '65000000-0000-0000-0000-000000000007',
       '65000000-0000-0000-0000-000000000008',
       '65000000-0000-0000-0000-000000000009');
    INSERT INTO simulation_preset_revisions
      (id, preset_id, revision_number, signature_hash, reynolds,
       reference_length_m, snapshot)
    VALUES
      ('${historicalRevisionId}', '65000000-0000-0000-0000-00000000000a',
       1, 'pre-engine-signature', 1369491, 1,
       '{"marker":"pre-engine"}'::jsonb);
  `);
  await migrate(drizzle(client), { migrationsFolder: through65 });
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
  if (through64) rmSync(through64, { recursive: true, force: true });
  if (through65) rmSync(through65, { recursive: true, force: true });
});

describe("0065 solver engine identity migration", () => {
  it("seeds exact OpenFOAM implementations while keeping historical revisions explicitly unknown", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const implementations = await client<
      Array<{
        id: string;
        distribution: string;
        releaseVersion: string;
        adapterVersion: number;
        numericsRevision: string;
      }>
    >`
      SELECT id::text, distribution, release_version AS "releaseVersion",
             adapter_contract_version AS "adapterVersion",
             numerics_revision AS "numericsRevision"
      FROM solver_implementations
      ORDER BY id
    `;
    expect(implementations).toEqual(
      expect.arrayContaining([
        {
          id: LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
          distribution: "legacy",
          releaseVersion: "unknown",
          adapterVersion: 0,
          numericsRevision: "unknown",
        },
        {
          id: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
          distribution: "opencfd",
          releaseVersion: "2406",
          adapterVersion: 1,
          numericsRevision: "1",
        },
        {
          id: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
          distribution: "foundation",
          releaseVersion: "14",
          adapterVersion: 1,
          numericsRevision: "1",
        },
      ]),
    );

    const [profile] = await client<Array<{ solverImplementationId: string }>>`
      SELECT solver_implementation_id::text AS "solverImplementationId"
      FROM solver_profiles WHERE slug = 'pre-engine-profile'
    `;
    expect(profile?.solverImplementationId).toBe(
      OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    );

    const [revisionDefault] = await client<Array<{ defaultValue: string }>>`
      SELECT column_default AS "defaultValue"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'simulation_preset_revisions'
        AND column_name = 'solver_implementation_id'
    `;
    expect(revisionDefault?.defaultValue).toContain(
      LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
    );

    const [historical] = await client<
      Array<{
        solverImplementationId: string;
        snapshot: Record<string, unknown>;
        methodHash: string | null;
      }>
    >`
      SELECT solver_implementation_id::text AS "solverImplementationId",
             snapshot,
             method_compatibility_hash AS "methodHash"
      FROM simulation_preset_revisions
      WHERE id = ${historicalRevisionId}
    `;
    expect(historical).toEqual({
      solverImplementationId: LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
      snapshot: { marker: "pre-engine" },
      methodHash: null,
    });
  });

  it("does not invent runtime provenance and seeds truthful operational routing separately", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const [counts] = await client<Array<{ builds: number; pools: number }>>`
      SELECT
        (SELECT count(*)::int FROM solver_runtime_builds) AS builds,
        (SELECT count(*)::int FROM solver_execution_pools) AS pools
    `;
    expect(counts).toEqual({ builds: 0, pools: 2 });
    const pools = await client<
      Array<{ id: string; routingKey: string; enabled: boolean }>
    >`
      SELECT id::text, routing_key AS "routingKey", enabled
      FROM solver_execution_pools ORDER BY id
    `;
    expect(pools).toEqual(
      expect.arrayContaining([
        {
          id: OPENCFD_2406_EXECUTION_POOL_ID,
          routingKey: "celery",
          enabled: true,
        },
        {
          id: FOUNDATION_14_EXECUTION_POOL_ID,
          routingKey: "openfoam-foundation-14",
          enabled: false,
        },
      ]),
    );
  });

  it("allows reused build labels only as distinct immutable provenance rows", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const keyA = "a".repeat(64);
    const keyB = "b".repeat(64);
    await client.unsafe(`
      INSERT INTO solver_runtime_builds
        (solver_implementation_id, provenance_key, build_id, image_digest)
      VALUES
        ('${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}', '${keyA}', 'release', 'sha256:${"a".repeat(64)}'),
        ('${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}', '${keyB}', 'release', 'sha256:${"b".repeat(64)}')
    `);
    await expect(
      client.unsafe(`
        INSERT INTO solver_runtime_builds
          (solver_implementation_id, provenance_key, build_id, image_digest)
        VALUES
          ('${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}', '${keyA}', 'another-label', 'sha256:${"c".repeat(64)}')
      `),
    ).rejects.toThrow();
    await expect(
      client.unsafe(`
        UPDATE solver_runtime_builds SET image_digest = 'sha256:${"d".repeat(64)}'
        WHERE provenance_key = '${keyA}'
      `),
    ).rejects.toThrow(/immutable/);
    await expect(
      client.unsafe(`
        INSERT INTO solver_runtime_builds
          (solver_implementation_id, provenance_key, build_id, source_revision)
        VALUES
          ('${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}', '${"e".repeat(64)}', 'labels-only', 'main')
      `),
    ).rejects.toThrow();
    await expect(
      client.unsafe(`
        INSERT INTO solver_runtime_builds
          (solver_implementation_id, provenance_key, build_id)
        VALUES
          ('${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}', '${"f".repeat(64)}', 'all-null-digests')
      `),
    ).rejects.toThrow();
    await expect(
      client.unsafe(`
        INSERT INTO solver_runtime_builds
          (solver_implementation_id, provenance_key, build_id,
           application_source_sha256, image_digest)
        VALUES
          ('${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}', '${"1".repeat(64)}',
           'malformed-extra-digest', '${"2".repeat(64)}', 'sha256:not-a-digest')
      `),
    ).rejects.toThrow();
  });

  it("protects implementation identity and adds generic evidence/method provenance", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await expect(
      client.unsafe(`
        UPDATE solver_implementations SET release_version = '15'
        WHERE id = '${FOUNDATION_14_SOLVER_IMPLEMENTATION_ID}'
      `),
    ).rejects.toThrow(/immutable/);
    await expect(
      client.unsafe(`
        UPDATE solver_execution_pools SET routing_key = 'retargeted'
        WHERE id = '${OPENCFD_2406_EXECUTION_POOL_ID}'
      `),
    ).rejects.toThrow(/immutable/);
    await expect(
      client.unsafe(`
        INSERT INTO solver_profiles
          (slug, name, solver_implementation_id)
        VALUES
          ('invalid-legacy-profile', 'Invalid legacy profile', '${LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID}')
      `),
    ).rejects.toThrow(/retired/);

    const enumRows = await client<Array<{ label: string }>>`
      SELECT enumlabel AS label
      FROM pg_enum
      WHERE enumtypid = 'evidence_artifact_kind'::regtype
    `;
    expect(enumRows.map((row) => row.label)).toContain("engine_bundle");

    const methodColumns = await client<Array<{ tableName: string }>>`
      SELECT table_name AS "tableName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'method_key'
        AND table_name IN ('sim_jobs', 'result_attempts', 'results', 'solver_evidence_artifacts')
      ORDER BY table_name
    `;
    expect(methodColumns.map((row) => row.tableName)).toEqual([
      "result_attempts",
      "results",
      "sim_jobs",
      "solver_evidence_artifacts",
    ]);
  });
});
