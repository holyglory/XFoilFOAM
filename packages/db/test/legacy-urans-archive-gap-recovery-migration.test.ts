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
const dbName = `aerodb_legacy_archive_gap_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let migrationDir = "";

function migrationFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "aerodb-migrations-0097-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 97);
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
}, 180_000);

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

describe("0097 legacy URANS archive-gap recovery migration", () => {
  it("pins a FAST-only, source-attempt-unique, leased action ledger", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const [shape] = await client<
      Array<{
        tableExists: boolean;
        indexes: string[];
        constraints: string[];
      }>
    >`
      SELECT
        to_regclass('public.legacy_urans_archive_gap_recovery_actions') IS NOT NULL
          AS "tableExists",
        ARRAY(
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'legacy_urans_archive_gap_recovery_actions'
            AND indexname IN (
              'legacy_urans_archive_gap_recovery_source_uq',
              'legacy_urans_archive_gap_recovery_active_request_uq',
              'legacy_urans_archive_gap_recovery_ready_idx',
              'legacy_urans_archive_gap_recovery_lease_idx'
            )
          ORDER BY indexname
        ) AS indexes,
        ARRAY(
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'public.legacy_urans_archive_gap_recovery_actions'::regclass
            AND conname IN (
              'legacy_urans_archive_gap_recovery_attempt_owner_fk',
              'legacy_urans_archive_gap_recovery_fidelity_check',
              'legacy_urans_archive_gap_recovery_lease_shape_check',
              'legacy_urans_archive_gap_recovery_routed_target_check'
            )
          ORDER BY conname
        ) AS constraints
    `;
    expect(shape).toEqual({
      tableExists: true,
      indexes: [
        "legacy_urans_archive_gap_recovery_active_request_uq",
        "legacy_urans_archive_gap_recovery_lease_idx",
        "legacy_urans_archive_gap_recovery_ready_idx",
        "legacy_urans_archive_gap_recovery_source_uq",
      ],
      constraints: [
        "legacy_urans_archive_gap_recovery_attempt_owner_fk",
        "legacy_urans_archive_gap_recovery_fidelity_check",
        "legacy_urans_archive_gap_recovery_lease_shape_check",
        "legacy_urans_archive_gap_recovery_routed_target_check",
      ],
    });
  });

  it("MUST-CATCH: a routed fresh-run receipt restricts deletion of its owned request", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const [foreignKey] = await client<
      Array<{ confdeltype: string }>
    >`
      SELECT confdeltype
      FROM pg_constraint
      WHERE conrelid = 'public.legacy_urans_archive_gap_recovery_actions'::regclass
        AND contype = 'f'
        AND confrelid = 'public.sim_urans_requests'::regclass
      ORDER BY conname
      LIMIT 1
    `;
    expect(foreignKey).toEqual({ confdeltype: "r" });
  });

  it("rejects a FINAL or unleased routing action before foreign-key source lookup", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await expect(
      client.unsafe(`
        INSERT INTO legacy_urans_archive_gap_recovery_actions
          (result_id, result_attempt_id, fidelity, state)
        VALUES
          ('11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           'urans_full', 'pending')
      `),
    ).rejects.toThrow(/legacy_urans_archive_gap_recovery_fidelity_check/);
    await expect(
      client.unsafe(`
        INSERT INTO legacy_urans_archive_gap_recovery_actions
          (result_id, result_attempt_id, fidelity, state)
        VALUES
          ('11111111-1111-4111-8111-111111111111',
           '22222222-2222-4222-8222-222222222222',
           'urans_precalc', 'routing')
      `),
    ).rejects.toThrow(/legacy_urans_archive_gap_recovery_lease_shape_check/);
  });
});

