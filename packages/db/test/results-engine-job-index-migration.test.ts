import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/env";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, "../migrations/0176_results_engine_job_index.sql"),
  "utf8",
);
const dbName = `aerodb_results_engine_idx_${process.pid}_${Date.now()}`;
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
  client = postgres(targetUrl.toString(), { max: 1 });
  await client.unsafe(`
    CREATE TABLE results (
      id integer PRIMARY KEY,
      sim_job_id uuid,
      engine_job_id text
    );
    CREATE INDEX results_sim_job_idx ON results (sim_job_id);
    INSERT INTO results (id, sim_job_id, engine_job_id)
    SELECT
      value,
      ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid,
      'engine-' || value::text
    FROM generate_series(1, 100000) AS value;
    ANALYZE results;
  `);
  await client.unsafe(migration);
  await client.unsafe(migration);
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

describe("0176 results engine job index migration", () => {
  it("supports the retention lookup on either job identity", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    const indexes = await client<
      Array<{ indexName: string; indexDefinition: string }>
    >`
      SELECT indexname AS "indexName", indexdef AS "indexDefinition"
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'results'
        AND indexname = 'results_engine_job_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexDefinition).toContain("engine_job_id");

    await client.unsafe("SET enable_seqscan = off");
    const explain = await client.unsafe(`
      EXPLAIN (FORMAT JSON)
      SELECT id
      FROM results
      WHERE sim_job_id = '00000000-0000-0000-0000-000000000001'::uuid
         OR engine_job_id = 'engine-2'
    `);
    const plan = JSON.stringify(explain);
    expect(plan).toContain("results_engine_job_idx");
    expect(plan).toContain("results_sim_job_idx");
  });
});
