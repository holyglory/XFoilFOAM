import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, vi } from "vitest";
import { createClient, type DB } from "../src/client";
import { settleSpentProgressiveMaterialGaps } from "../src/progressive-cfd-recovery";
import { acquireProgressiveAdmissionLock, tryProgressiveAdmissionLock } from "../src/progressive-admission-lock";
import { runProgressiveBaselineService } from "../../../apps/sweeper/src/progressive-service";

// Reuse a genuinely composed, physically stopped material fixture. Fan out only
// its scheduling records in a private schema, retaining the real jobs, proofs
// and diagnostic source. Distinct generations preserve each sealed unit key.
export async function verifySpentMaterialPages(
  db: DB, url: string, firstCampaign: string, secondCampaign: string,
  sourceUnit: string, fallbackToken: string,
) {
  const schema = "spent_material_" + randomUUID().replaceAll("-", "");
  const connect = () => createClient({ url, max: 1, connection: { search_path: schema + ",public" } });
  let client = connect();
  let pageDb = client.db;
  try {
    await pageDb.transaction(async tx => {
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
      await tx.execute(sql`CREATE TABLE spent_cases AS SELECT n,
        CASE WHEN n=195 THEN ${secondCampaign}::uuid ELSE ${firstCampaign}::uuid END AS campaign_id,
        gen_random_uuid() AS generation_id,gen_random_uuid() AS work_id,gen_random_uuid() AS unit_id,
        gen_random_uuid() AS plan_id,gen_random_uuid() AS parent_token,gen_random_uuid() AS fallback_token
        FROM generate_series(1,195) n`);
      const shapes: [string, SQL, SQL][] = [
        ["progressive_generations", sql`original.id=source_work.generation_id`,
          sql`jsonb_build_object('id',f.generation_id,'scope_key',f.generation_id::text,'campaign_id',f.campaign_id,
            'plan_revision_id',c.current_plan_revision_id,'status','active','stage',source_work.stage)`],
        ["progressive_work", sql`original.id=source_work.id`,
          sql`jsonb_build_object('id',f.work_id,'generation_id',f.generation_id,'state','pending')`],
        ["progressive_cfd_units", sql`original.id=source.id`,
          sql`jsonb_build_object('id',f.unit_id,'work_id',f.work_id,'state','pending','retry_after',clock_timestamp())`],
        ["progressive_cfd_attempts", sql`original.unit_id=source.id`,
          sql`jsonb_build_object('unit_id',f.unit_id,'token',
            CASE WHEN original.token=${fallbackToken}::uuid THEN f.fallback_token ELSE f.parent_token END)`],
        ["progressive_cfd_recovery_plans", sql`original.unit_id=source.id`,
          sql`jsonb_build_object('id',f.plan_id,'unit_id',f.unit_id,'parent_attempt_token',f.parent_token)`],
        ["progressive_cfd_recovery_claims", sql`original.attempt_token=${fallbackToken}::uuid`,
          sql`jsonb_build_object('attempt_token',f.fallback_token,'recovery_plan_id',f.plan_id)`],
      ];
      for (const [table, sourceKey, overrides] of shapes) {
        const name = sql.identifier(table);
        await tx.execute(sql`CREATE TABLE ${sql.identifier(schema)}.${name} (LIKE public.${name} INCLUDING ALL)`);
        await tx.execute(sql`INSERT INTO ${sql.identifier(schema)}.${name}
          SELECT (jsonb_populate_record(NULL::${sql.identifier(schema)}.${name},to_jsonb(original) || ${overrides})).*
          FROM spent_cases f JOIN public.sim_campaigns c ON c.id=f.campaign_id
          JOIN public.progressive_cfd_units source ON source.id=${sourceUnit}::uuid
          JOIN public.progressive_work source_work ON source_work.id=source.work_id
          JOIN public.${name} original ON ${sourceKey}`);
        await tx.execute(sql`ANALYZE ${sql.identifier(schema)}.${name}`);
      }
    });
    const snapshot = async () => {
      const row = await pageDb.execute(sql`SELECT
        (SELECT md5(string_agg((to_jsonb(u)-'state'-'retry_after'-'error')::text,'' ORDER BY u.id)) FROM progressive_cfd_units u) units,
        (SELECT md5(string_agg(to_jsonb(a)::text,'' ORDER BY a.token)) FROM progressive_cfd_attempts a) attempts,
        (SELECT md5(string_agg(to_jsonb(c)::text,'' ORDER BY c.attempt_token)) FROM progressive_cfd_recovery_claims c) claims,
        (SELECT md5(string_agg(to_jsonb(p)::text,'' ORDER BY p.id)) FROM progressive_cfd_recovery_plans p) plans,
        (SELECT count(*)::int FROM progressive_cfd_attempts) AS attempt_count,
        (SELECT count(*)::int FROM progressive_cfd_evidence) AS receipts,
        (SELECT count(*)::int FROM result_attempts) AS science,
        (SELECT count(*)::int FROM sim_jobs) AS jobs,
        (SELECT count(*)::int FROM progressive_cfd_execution_stops) AS stops,
        (SELECT jsonb_agg(jsonb_build_array(e.result_attempt_id,e.evidence_signature,raw.cl,raw.cd,raw.cm)
                  ORDER BY e.result_attempt_id)
         FROM public.progressive_cfd_attempts a JOIN public.progressive_cfd_evidence e ON e.attempt_token=a.token
         JOIN public.result_attempts raw ON raw.id=e.result_attempt_id WHERE a.unit_id=${sourceUnit}::uuid) AS source_evidence`);
      return row[0];
    };
    const initial = await snapshot();
    expect(initial?.attempt_count).toBe(390);
    await db.transaction(async lock => {
      await acquireProgressiveAdmissionLock(lock as unknown as DB);
      expect(await settleSpentProgressiveMaterialGaps(pageDb)).toMatchObject({settled:0,busy:true});
    });
    await db.transaction(async lock => {
      await lock.execute(sql`SELECT id FROM sim_campaigns WHERE id=${firstCampaign}::uuid FOR UPDATE`);
      expect(await settleSpentProgressiveMaterialGaps(pageDb)).toMatchObject({settled:1,busy:false});
      expect(await settleSpentProgressiveMaterialGaps(pageDb)).toMatchObject({settled:0,busy:true});
    });
    // Stop a service instance immediately after its first real commit. Close
    // the connection and start with fresh process-local scheduling state.
    const firstOwner = new AbortController();
    const firstPages: number[] = [];
    const firstTimeout = setTimeout(() => firstOwner.abort(), 15_000);
    try {
      await runProgressiveBaselineService(pageDb, { listen: async () => ({unlisten: async () => {}}) } as never,
        {} as never, firstOwner.signal, receipt => {
          if (typeof receipt.settled === "number" && receipt.component === "progressive-spent-material-gaps") {
            firstPages.push(receipt.settled);
            firstOwner.abort();
          }
        });
    } finally {
      firstOwner.abort();
      clearTimeout(firstTimeout);
    }
    expect(firstPages).toEqual([64]);
    await client.sql.end();
    client = connect();
    pageDb = client.db;
    const owner = new AbortController();
    const pages: number[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    // Only the foreground uses the root execute method. Its slow dependency
    // is held across separate, real page transactions on this same DB pool.
    const actual = pageDb.execute.bind(pageDb);
    const dialect = new PgDialect();
    let foregroundReads = 0;
    const foreground = vi.spyOn(pageDb, "execute").mockImplementation(query => {
      if (dialect.sqlToQuery(query.getSQL()).sql.includes("FROM sweeper_state")) {
        foregroundReads++;
        entered();
        return blocked.then(() => { throw new Error("Disposable foreground wait ended"); }) as ReturnType<typeof actual>;
      }
      return actual(query);
    });
    const timeout = setTimeout(() => { owner.abort(); entered(); unblock(); }, 15_000);
    const running = runProgressiveBaselineService(pageDb, { listen: async () => ({unlisten: async () => {}}) } as never,
      {} as never, owner.signal, receipt => {
        if (receipt.component !== "progressive-spent-material-gaps" || typeof receipt.settled !== "number") return;
        pages.push(receipt.settled);
        if (pages.length === 3) { owner.abort(); unblock(); }
      });
    try {
      await reading;
      expect(await db.transaction(tx => tryProgressiveAdmissionLock(tx as unknown as DB))).toBe(true);
      await running;
      expect(foregroundReads).toBe(1);
    } finally {
      clearTimeout(timeout); owner.abort(); unblock(); foreground.mockRestore();
      await running;
    }
    expect(pages).toEqual([64,64,2]);
    expect(await settleSpentProgressiveMaterialGaps(pageDb)).toMatchObject({settled:0,busy:false});
    const [settled] = await pageDb.execute(sql`SELECT count(*)::int n FROM progressive_cfd_units u
      JOIN spent_cases f ON f.unit_id=u.id JOIN progressive_cfd_attempts a ON a.token=f.fallback_token
      WHERE u.state='gap' AND u.retry_after IS NULL AND u.error=a.error AND a.error IS NOT NULL`);
    expect(settled?.n).toBe(195);
    expect(await snapshot()).toEqual(initial);
  } finally {
    try {
      await client.sql.end();
    } finally {
      await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`);
    }
  }
}
