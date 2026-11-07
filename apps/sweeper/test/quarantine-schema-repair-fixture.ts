import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { expect } from "vitest";

const migration = (name: string) => readFileSync(new URL(`../../../packages/db/migrations/${name}.sql`, import.meta.url), "utf8");
const repair = migration("0193_restore_quarantine_schema");
const legacy = migration("0067_solver_evidence_object_storage").match(/CREATE OR REPLACE FUNCTION reject_linked_solver_evidence_artifact_update\(\)[\s\S]*?\$\$;/)![0];
const functions = [...new Set([...repair.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]*quarantine[a-z_]*)\(\)/g)].map(match => match[1]))];

async function snapshot(connection: DB) {
  const rows = await connection.execute(sql`
    SELECT
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM results record) AS results,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM result_attempts record) AS attempts,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM solver_evidence_archives record) AS archives,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM solver_evidence_blobs record) AS blobs,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM solver_evidence_artifacts record) AS artifacts,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM sim_jobs record) AS jobs,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM sim_campaigns record) AS campaigns,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM simulation_preset_revisions record) AS revisions,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM sync_api_settings record) AS configuration,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM solver_execution_pools record) AS capacity,
      (SELECT md5(coalesce(string_agg(row_to_json(record)::text,',' ORDER BY record.id),'')) FROM drizzle.__drizzle_migrations record) AS journal,
      (SELECT md5(string_agg(procedure.proname||':'||regexp_replace(regexp_replace(procedure.prosrc,'--[^\n]*','','g'),'[[:space:]]+','','g'),',' ORDER BY procedure.proname,procedure.oid))
        FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname='public') AS functions,
      (SELECT md5(string_agg(pg_get_functiondef(procedure.oid),',' ORDER BY procedure.proname,procedure.oid))
        FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        WHERE namespace.nspname='public' AND procedure.proname NOT LIKE '%quarantine%'
          AND procedure.proname<>'reject_linked_solver_evidence_artifact_update') AS preserved_function_bytes,
      (SELECT md5(string_agg(relation.relname||':'||pg_get_triggerdef(trigger.oid)||':'||trigger.tgenabled::text,',' ORDER BY relation.relname,trigger.tgname))
        FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='public' AND NOT trigger.tgisinternal) AS triggers
  `);
  return rows[0];
}

export async function rehearseQuarantineSchemaRepair(connection: DB, restore: boolean) {
  const before = await snapshot(connection);
  if (restore) {
    const [population] = await connection.execute(sql`SELECT
      (SELECT count(*)::int FROM solver_evidence_orphan_quarantines) +
      (SELECT count(*)::int FROM solver_evidence_incomplete_quarantines) AS count`);
    expect(population.count).toBe(0);
    await connection.execute(sql`DROP TABLE public.solver_evidence_incomplete_quarantines,public.solver_evidence_orphan_quarantines`);
    for (const name of functions)
      await connection.execute(sql.raw(`DROP FUNCTION public.${name}() CASCADE`));
    await connection.execute(sql.raw(legacy));
    expect((await connection.execute(sql`SELECT to_regclass('public.solver_evidence_orphan_quarantines') AS orphan,
      to_regclass('public.solver_evidence_incomplete_quarantines') AS incomplete`))[0]).toEqual({ orphan: null, incomplete: null });
  }
  await connection.execute(sql.raw(repair));
  expect(await snapshot(connection)).toEqual(before);
  const [identities] = await connection.execute(sql`SELECT
    to_regclass('public.solver_evidence_orphan_quarantines')::oid AS orphan,
    to_regclass('public.solver_evidence_incomplete_quarantines')::oid AS incomplete`);
  await connection.execute(sql.raw(repair));
  expect(await snapshot(connection)).toEqual(before);
  expect((await connection.execute(sql`SELECT to_regclass('public.solver_evidence_orphan_quarantines')::oid AS orphan,
    to_regclass('public.solver_evidence_incomplete_quarantines')::oid AS incomplete`))[0]).toEqual(identities);
}

export async function refusePartialQuarantineSchemaRepair(connection: DB) {
  const before = await snapshot(connection);
  for (const mutation of [
    sql`DROP TABLE public.solver_evidence_incomplete_quarantines`,
    sql`ALTER TABLE public.solver_evidence_orphan_quarantines ADD COLUMN unexpected_owner text`,
    sql`ALTER TABLE public.solver_evidence_orphan_quarantines DISABLE TRIGGER solver_evidence_orphan_quarantines_source_guard`,
    sql`ALTER TABLE public.solver_evidence_incomplete_quarantines DROP CONSTRAINT solver_evidence_incomplete_quarantines_count_checks`,
    sql`CREATE OR REPLACE FUNCTION public.reject_linked_solver_evidence_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END;$$`,
  ]) {
    await expect(connection.transaction(async rawTransaction => {
      const transaction = rawTransaction as unknown as DB;
      await transaction.execute(mutation);
      await transaction.execute(sql.raw(repair));
    })).rejects.toThrow(/0193 refuses/);
    expect(await snapshot(connection)).toEqual(before);
  }
}
