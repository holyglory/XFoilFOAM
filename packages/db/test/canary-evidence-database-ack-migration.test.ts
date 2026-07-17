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
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "../src/solver-implementations";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_canary_ack_migration_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let through71 = "";

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
  through71 = makeMigrationFolder(71);
  await migrate(drizzle(client), { migrationsFolder: through71 });
}, 120_000);

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  if (through71) rmSync(through71, { recursive: true, force: true });
});

describe("0072 canary evidence database acknowledgement migration", () => {
  it("refuses an untruthful backfill when an immutable historical attestation exists", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await client.unsafe(`
      INSERT INTO solver_runtime_builds
        (id, solver_implementation_id, provenance_key, build_id,
         application_source_sha256, metadata)
      VALUES
        ('72000000-0000-4000-8000-000000000001',
         '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}',
         '${"a".repeat(64)}', 'historical-canary-runtime',
         '${"c".repeat(64)}', '{}'::jsonb);
      INSERT INTO solver_engine_canary_attestations
        (id, solver_implementation_id, solver_runtime_build_id,
         solver_execution_pool_id, receipt_sha256, receipt, attested_by)
      VALUES
        ('72000000-0000-4000-8000-000000000002',
         '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}',
         '72000000-0000-4000-8000-000000000001',
         '${OPENCFD_2606_EXECUTION_POOL_ID}', '${"b".repeat(64)}',
         '{"historical":true}'::jsonb, 'migration-precondition-test');
    `);

    await expect(
      migrate(drizzle(client), { migrationsFolder: migrations }),
    ).rejects.toThrow(
      /requires zero historical solver_engine_canary_attestations/i,
    );

    const [column] = await client<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'solver_engine_canary_attestations'
        AND column_name = 'evidence_registration_id'
    `;
    expect(column?.count).toBe(0);
  }, 120_000);
});
