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
const dbName = `aerodb_rans_promotion_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let through57 = "";

function latestMigrationTimestamp(): string {
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ when: number }> };
  const latest = journal.entries.at(-1)?.when;
  if (latest === undefined) throw new Error("migration journal is empty");
  return String(latest);
}

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
  through57 = makeMigrationFolder(57);
  await migrate(drizzle(client), { migrationsFolder: through57 });
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
  if (through57) rmSync(through57, { recursive: true, force: true });
});

describe("0058 conditional RANS whole-polar promotion ledger", () => {
  it("upgrades the latest predecessor and creates normalized event and coverage tables", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const before = await client<{ promotion: string | null }[]>`
      SELECT to_regclass('public.sim_rans_polar_promotions')::text AS promotion
    `;
    expect(before[0]?.promotion).toBeNull();

    await migrate(drizzle(client), { migrationsFolder: migrations });

    const tables = await client<
      { promotion: string | null; points: string | null; latest: string }[]
    >`
      SELECT
        to_regclass('public.sim_rans_polar_promotions')::text AS promotion,
        to_regclass('public.sim_rans_polar_promotion_points')::text AS points,
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations) AS latest
    `;
    expect(tables[0]).toEqual({
      promotion: "sim_rans_polar_promotions",
      points: "sim_rans_polar_promotion_points",
      latest: latestMigrationTimestamp(),
    });
  });

  it("enforces exact hard-solver provenance, bounded trigger angles, and one point per promoted AoA", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const rows = await client<{ name: string; definition: string }[]>`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'sim_rans_polar_promotions'::regclass,
        'sim_rans_polar_promotion_points'::regclass
      )
      ORDER BY conname
    `;
    const definitions = rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("trigger_aoa_deg >= (0)::double precision");
    expect(definitions).toContain("trigger_aoa_deg <= (5)::double precision");
    expect(definitions).toContain("failure_disposition = 'hard_solver'::text");
    expect(definitions).toContain("request_origin = 'continuous-polar'::text");
    expect(definitions).toContain(
      "owner_kind = ANY (ARRAY['campaign'::text, 'background'::text, 'sync_promise'::text])",
    );
    expect(definitions).toContain("owner_kind = 'sync_promise'::text");
    expect(definitions).toContain("sync_promise_id IS NOT NULL");
    expect(definitions).toContain("campaign_id IS NOT NULL");
    expect(definitions).toContain(
      "FOREIGN KEY (sync_promise_id) REFERENCES sync_sweep_promises(id) ON DELETE CASCADE",
    );
    expect(definitions).toContain("UNIQUE (trigger_result_attempt_id)");
    expect(definitions).toContain("UNIQUE (parent_job_id, revision_id)");
    expect(definitions).toContain("PRIMARY KEY (promotion_id, aoa_deg)");
    expect(definitions).toContain("UNIQUE (promotion_id, obligation_id)");
  });
});
