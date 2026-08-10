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

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_interpretation_ledger_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const ID = {
  category: "91000000-0000-0000-0000-000000000001",
  airfoil: "91000000-0000-0000-0000-000000000002",
  medium: "91000000-0000-0000-0000-000000000003",
  boundary: "91000000-0000-0000-0000-000000000004",
  result: "91000000-0000-0000-0000-000000000005",
  resultOther: "91000000-0000-0000-0000-000000000006",
  attempt: "91000000-0000-0000-0000-000000000007",
  attemptOther: "91000000-0000-0000-0000-000000000008",
  reducer: "91000000-0000-0000-0000-000000000009",
  mesh: "91000000-0000-0000-0000-00000000000a",
  interpretation: "91000000-0000-0000-0000-00000000000b",
  terminalInterpretation: "91000000-0000-0000-0000-00000000000c",
  selection: "91000000-0000-0000-0000-00000000000d",
  resultCascade: "91000000-0000-0000-0000-00000000000e",
  attemptCascade: "91000000-0000-0000-0000-00000000000f",
  interpretationCascade: "91000000-0000-0000-0000-000000000010",
  selectionCascade: "91000000-0000-0000-0000-000000000011",
} as const;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let migrationDir = "";

function migrationFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "aerodb-migrations-0096-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 96);
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
  migrationDir = migrationFolder();
  await migrate(drizzle(client), { migrationsFolder: migrationDir });

  await client.unsafe(`
    INSERT INTO categories (id, slug, name, path)
    VALUES ('${ID.category}', 'interpretation-ledger', 'Interpretation ledger', 'interpretation-ledger');
    INSERT INTO airfoils (id, slug, name, category_id, source, points)
    VALUES (
      '${ID.airfoil}', 'interpretation-ledger-foil', 'Interpretation ledger foil',
      '${ID.category}', 'test-coordinates',
      '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb
    );
    INSERT INTO mediums
      (id, slug, name, phase, density, viscosity_model,
       constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
    VALUES
      ('${ID.medium}', 'interpretation-ledger-air', 'Interpretation ledger air', 'gas',
       1.225, 'constant', 0.00001789, 0.00001789, 0.000014604);
    INSERT INTO boundary_conditions (id, slug, name, medium_id, reynolds)
    VALUES
      ('${ID.boundary}', 'interpretation-ledger-bc', 'Interpretation ledger BC',
       '${ID.medium}', 100000);
    INSERT INTO results
      (id, airfoil_id, bc_id, aoa_deg, status, source, regime)
    VALUES
      ('${ID.result}', '${ID.airfoil}', '${ID.boundary}', 3, 'done', 'solved', 'urans'),
      ('${ID.resultOther}', '${ID.airfoil}', '${ID.boundary}', 4, 'done', 'solved', 'urans'),
      ('${ID.resultCascade}', '${ID.airfoil}', '${ID.boundary}', 5, 'done', 'solved', 'urans');
    INSERT INTO result_attempts
      (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime)
    VALUES
      ('${ID.attempt}', '${ID.result}', '${ID.airfoil}', '${ID.boundary}', 3,
       'done', 'solved', 'urans'),
      ('${ID.attemptOther}', '${ID.resultOther}', '${ID.airfoil}', '${ID.boundary}', 4,
       'done', 'solved', 'urans'),
      ('${ID.attemptCascade}', '${ID.resultCascade}', '${ID.airfoil}', '${ID.boundary}', 5,
       'done', 'solved', 'urans');
    INSERT INTO result_reducer_versions
      (id, reducer_key, reducer_version, build_id, policy_sha256, policy)
    VALUES
      ('${ID.reducer}', 'urans-statistical', 'v2', 'test-build', '${SHA_A}',
       '{"phaseBins":96}'::jsonb);
    INSERT INTO result_attempt_mesh_identities
      (id, result_id, result_attempt_id, fingerprint_version, content_sha256,
       recipe_sha256, resolved_params, source, source_evidence_signature)
    VALUES
      ('${ID.mesh}', '${ID.result}', '${ID.attempt}', 1, '${SHA_A}', '${SHA_B}',
       '{"cellCount":12000}'::jsonb, 'engine_reported', 'engine-evidence-v1');
    INSERT INTO result_interpretations
      (id, result_id, result_attempt_id, reducer_version_id, mesh_identity_id,
       source, input_evidence_signature, state, regime, selected_window,
       terminal_reason, statistics, diagnostics, cl, cd, cm, cl_cd, cl_cd_interval_state,
       uncertainty_basis, effective_blocks)
    VALUES
      ('${ID.interpretation}', '${ID.result}', '${ID.attempt}', '${ID.reducer}', '${ID.mesh}',
       'engine_reported', 'engine-evidence-v1', 'accepted', 'periodic',
       '{"cycleCount":3}'::jsonb, NULL, '{"covariance":[]}'::jsonb, '{}'::jsonb,
       0.6, 0.03, -0.04, 20, 'bounded', 'paired_cycles', 3),
      ('${ID.terminalInterpretation}', '${ID.result}', '${ID.attempt}', '${ID.reducer}', '${ID.mesh}',
       'engine_reported', 'engine-evidence-terminal-v1', 'terminal_failure',
       'trending_unresolved', '{}'::jsonb,
       'no certified terminal clean-cycle suffix', '{}'::jsonb, '{}'::jsonb,
       NULL, NULL, NULL, NULL,
       'unavailable', 'not_available', NULL),
      ('${ID.interpretationCascade}', '${ID.resultCascade}', '${ID.attemptCascade}', '${ID.reducer}', NULL,
       'engine_reported', 'engine-evidence-cascade-v1', 'accepted', 'periodic',
       '{"cycleCount":3}'::jsonb, NULL, '{"covariance":[]}'::jsonb, '{}'::jsonb,
       0.6, 0.03, -0.04, 20, 'bounded', 'paired_cycles', 3);
    INSERT INTO result_interpretation_cycles
      (result_id, result_attempt_id, result_interpretation_id, cycle_index,
       start_time_s, end_time_s, period_s, disposition, coefficient_sample_count,
       field_frame_count, phase_max_gap_fraction, metrics)
    VALUES
      ('${ID.result}', '${ID.attempt}', '${ID.interpretation}', 0,
       1, 2, 1, 'selected', 24, 24, 0.01, '{"shapeRmse":0.01}'::jsonb),
      ('${ID.result}', '${ID.attempt}', '${ID.interpretation}', 1,
       2, 3, 1, 'selected', 24, 24, 0.01, '{"shapeRmse":0.01}'::jsonb),
      ('${ID.result}', '${ID.attempt}', '${ID.interpretation}', 2,
       3, 4, 1, 'selected', 24, 24, 0.01, '{"shapeRmse":0.01}'::jsonb);
    INSERT INTO result_canonical_selections
      (id, result_id, result_attempt_id, result_interpretation_id,
       selection_namespace, reason, actor)
    VALUES
      ('${ID.selection}', '${ID.result}', '${ID.attempt}', '${ID.interpretation}',
       'canonical-v7', 'authenticated archive reduction', 'test'),
      ('${ID.selectionCascade}', '${ID.resultCascade}', '${ID.attemptCascade}', '${ID.interpretationCascade}',
       'canonical-v7', 'parent deletion fixture', 'test');
  `);
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
  if (migrationDir) rmSync(migrationDir, { recursive: true, force: true });
});

describe("0096 result interpretation ledger reconciliation", () => {
  it("binds current result projection to one same-result append-only selection", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await client.unsafe(`
      UPDATE results
      SET current_result_interpretation_id = '${ID.interpretation}',
          current_canonical_selection_id = '${ID.selection}'
      WHERE id = '${ID.result}'
    `);
    const [row] = await client<
      Array<{ interpretation: string; selection: string }>
    >`
      SELECT current_result_interpretation_id::text AS interpretation,
             current_canonical_selection_id::text AS selection
      FROM results WHERE id = ${ID.result}
    `;
    expect(row).toEqual({
      interpretation: ID.interpretation,
      selection: ID.selection,
    });

    await expect(
      client.unsafe(`
        UPDATE results
        SET current_result_interpretation_id = '${ID.interpretation}',
            current_canonical_selection_id = NULL
        WHERE id = '${ID.result}'
      `),
    ).rejects.toThrow(/must be set or cleared together/);
  });

  it("rejects nonpublishable selection and mutation of immutable evidence", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await expect(
      client.unsafe(`
        INSERT INTO result_canonical_selections
          (result_id, result_attempt_id, result_interpretation_id,
           selection_namespace, reason)
        VALUES
          ('${ID.result}', '${ID.attempt}', '${ID.terminalInterpretation}',
           'canonical-v7', 'must not select a terminal reduction')
      `),
    ).rejects.toThrow(/accepted or legacy interpretation/);

    await expect(
      client.unsafe(`
        UPDATE result_interpretations SET cl = 0.61
        WHERE id = '${ID.interpretation}'
      `),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.unsafe(`
        DELETE FROM result_canonical_selections WHERE id = '${ID.selection}'
      `),
    ).rejects.toThrow(/append-only/);
  });

  it("allows fixture cleanup to cascade from a parent result without weakening append-only rows", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await client.unsafe(`DELETE FROM results WHERE id = '${ID.resultCascade}'`);
    const [counts] = await client<
      Array<{ attempts: number; interpretations: number; selections: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM result_attempts WHERE result_id = ${ID.resultCascade}) AS attempts,
        (SELECT count(*)::int FROM result_interpretations WHERE result_id = ${ID.resultCascade}) AS interpretations,
        (SELECT count(*)::int FROM result_canonical_selections WHERE result_id = ${ID.resultCascade}) AS selections
    `;
    expect(counts).toEqual({ attempts: 0, interpretations: 0, selections: 0 });
  });

  it("records an exhausted archive recovery as terminal rather than a retriable receipt", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const [constraint] = await client<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conname = 'result_interpretation_backfill_items_state_check'
    `;
    expect(constraint?.definition).toContain("terminal_failure");
  });
});
