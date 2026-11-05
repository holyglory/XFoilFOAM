import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createClient, type DB } from "../src/client";
import { advanceGeneration } from "../src/progressive-campaigns";
import {
  adoptProgressiveSubsonicPriority,
  effectiveProgressiveStageSql,
} from "../src/progressive-execution-policy";

async function withCohortFixture(
  verify: (fixture: {
    db: DB;
    campaignId: string;
    generations: string[];
    preciseCampaignId: string;
    preciseGenerationId: string;
  }) => Promise<void>,
) {
  const client = createClient({ max: 1 });
  try {
    await client.db.transaction(async (transaction) => {
      const db = transaction as unknown as DB;
      for (const definition of [
        "calculation_epochs (id uuid PRIMARY KEY, current boolean NOT NULL)",
        "sim_campaigns (id uuid PRIMARY KEY, status text NOT NULL, priority integer NOT NULL, current_plan_revision_id uuid NOT NULL)",
        "campaign_progressive_execution_policies (campaign_id uuid PRIMARY KEY, policy text NOT NULL, adopted_at timestamptz NOT NULL DEFAULT clock_timestamp())",
        "progressive_generations (id uuid PRIMARY KEY, campaign_id uuid NOT NULL, epoch_id uuid NOT NULL, plan_revision_id uuid NOT NULL, benchmark_only boolean NOT NULL, stage smallint NOT NULL, status text NOT NULL, scope_signature text NOT NULL, completed_at timestamptz)",
        "polar_analysis_targets (id text PRIMARY KEY, physical jsonb NOT NULL)",
        "progressive_generation_targets (generation_id uuid NOT NULL, target_id text NOT NULL, revision_id uuid NOT NULL, angles double precision[] NOT NULL, recipes jsonb NOT NULL, PRIMARY KEY (generation_id, target_id))",
        "progressive_work (id uuid PRIMARY KEY, generation_id uuid NOT NULL, target_id text NOT NULL, stage smallint NOT NULL, state text NOT NULL)",
        "progressive_cfd_units (id uuid PRIMARY KEY, work_id uuid NOT NULL, state text NOT NULL)",
        "progressive_generation_cohorts (generation_id uuid NOT NULL, cohort text NOT NULL, stage smallint NOT NULL DEFAULT 1 CHECK (stage IN (1,2,3)), status text NOT NULL DEFAULT 'active', updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (generation_id, cohort))",
        "progressive_generation_cohort_targets (generation_id uuid NOT NULL, target_id text NOT NULL, cohort text NOT NULL, PRIMARY KEY (generation_id, target_id))",
        "sim_jobs (id uuid PRIMARY KEY, campaign_id uuid NOT NULL, status text NOT NULL, request_payload jsonb NOT NULL)",
      ]) {
        await db.execute(
          sql.raw(`CREATE TEMP TABLE ${definition} ON COMMIT DROP`),
        );
      }
      const epochId = randomUUID();
      const campaignId = randomUUID();
      const preciseCampaignId = randomUUID();
      const planId = randomUUID();
      const preciseGenerationId = randomUUID();
      const generations = [randomUUID(), randomUUID()];
      const targetId = randomUUID();
      await db.execute(
        sql`INSERT INTO calculation_epochs VALUES (${epochId},true)`,
      );
      await db.execute(sql`INSERT INTO sim_campaigns VALUES
        (${campaignId},'active',4,${planId}),(${preciseCampaignId},'active',5,${planId})`);
      await db.execute(sql`INSERT INTO polar_analysis_targets VALUES
        (${targetId},${JSON.stringify({ derived: { mach: 0.08814658492111002 }, geometrySignature: "retained-geometry" })}::jsonb)`);
      for (const generationId of [...generations, preciseGenerationId]) {
        const benchmarkOnly = generationId !== preciseGenerationId;
        await db.execute(sql`INSERT INTO progressive_generations
          (id,campaign_id,epoch_id,plan_revision_id,benchmark_only,stage,status,scope_signature)
          VALUES (${generationId},${benchmarkOnly ? campaignId : preciseCampaignId},${epochId},${planId},${benchmarkOnly},${benchmarkOnly ? 1 : 3},'active',${`sealed-${generationId}`})`);
        await db.execute(sql`INSERT INTO progressive_generation_targets VALUES
          (${generationId},${targetId},${randomUUID()},ARRAY[-4,7]::double precision[],
          ${JSON.stringify({ fast: { recipeId: generationId === generations[1] ? "fast-v2" : "current-fast" }, precise: { recipeId: "unchanged-precise", solverProcesses: 4 } })}::jsonb)`);
        for (const stage of benchmarkOnly ? [1, 2] : [1, 2, 3]) {
          await db.execute(sql`INSERT INTO progressive_work VALUES
            (${randomUUID()},${generationId},${targetId},${stage},${benchmarkOnly ? "pending" : stage === 3 ? "leased" : "complete"})`);
        }
      }
      await db.execute(sql`INSERT INTO sim_jobs VALUES
        (${randomUUID()},${preciseCampaignId},'running',${JSON.stringify({ recipe: "sealed-precise", solver_processes: 4, case_concurrency: 1 })}::jsonb)`);
      await verify({
        db,
        campaignId,
        generations,
        preciseCampaignId,
        preciseGenerationId,
      });
    });
  } finally {
    await client.sql.end();
  }
}

async function sealedState(db: DB) {
  return {
    targets: await db.execute(
      sql`SELECT * FROM progressive_generation_targets ORDER BY generation_id,target_id`,
    ),
    physical: await db.execute(
      sql`SELECT * FROM polar_analysis_targets ORDER BY id`,
    ),
    signatures: await db.execute(
      sql`SELECT id,scope_signature,plan_revision_id FROM progressive_generations ORDER BY id`,
    ),
    priorities: await db.execute(
      sql`SELECT id,priority,current_plan_revision_id FROM sim_campaigns ORDER BY id`,
    ),
    jobs: await db.execute(sql`SELECT * FROM sim_jobs ORDER BY id`),
  };
}

async function benchmarkStages(db: DB, campaignId: string) {
  return db.execute(sql`SELECT generation.id,generation.stage,generation.status,cursor.stage AS cohort_stage,cursor.status AS cohort_status,
    member.cohort,work.stage AS work_stage,${effectiveProgressiveStageSql()} AS effective_stage
    FROM progressive_generations generation JOIN progressive_generation_cohorts cursor ON cursor.generation_id=generation.id
    JOIN progressive_generation_cohort_targets member ON member.generation_id=generation.id AND member.cohort=cursor.cohort
    JOIN progressive_work work ON work.generation_id=generation.id AND work.target_id=member.target_id
    WHERE generation.campaign_id=${campaignId}::uuid AND work.stage=2 ORDER BY generation.id`);
}

describe.skipIf(!process.env.DATABASE_URL)(
  "fast-v2 benchmark cohort lifecycle",
  () => {
    it("waits for baselines, then admits low-Mach fast work without changing precise work or sealed setup", async () => {
      await withCohortFixture(
        async ({ db, campaignId, generations, preciseGenerationId }) => {
          const immutable = await sealedState(db);
          const preciseBefore = await db.execute(
            sql`SELECT * FROM progressive_generations WHERE id=${preciseGenerationId}::uuid`,
          );
          await adoptProgressiveSubsonicPriority(db, campaignId);
          const before = await benchmarkStages(db, campaignId);
          expect(before).toHaveLength(2);
          expect(
            before.every(
              (row) =>
                row.cohort === "low" &&
                row.cohort_stage === 1 &&
                row.effective_stage === 1,
            ),
          ).toBe(true);
          await db.execute(sql`UPDATE progressive_work work SET state='complete' FROM progressive_generations generation
        WHERE work.generation_id=generation.id AND generation.campaign_id=${campaignId}::uuid AND work.stage=1`);
          for (const generationId of generations)
            await advanceGeneration(db, generationId);
          const after = await benchmarkStages(db, campaignId);
          expect(
            after.every(
              (row) =>
                row.stage === 2 &&
                row.cohort_stage === 2 &&
                row.effective_stage === 2 &&
                row.status === "active",
            ),
          ).toBe(true);
          expect(await sealedState(db)).toEqual(immutable);
          expect(
            await db.execute(
              sql`SELECT * FROM progressive_generations WHERE id=${preciseGenerationId}::uuid`,
            ),
          ).toEqual(preciseBefore);
          expect(
            await db.execute(
              sql`SELECT work.id FROM progressive_work work JOIN progressive_generations generation ON generation.id=work.generation_id WHERE generation.benchmark_only AND work.stage=3`,
            ),
          ).toHaveLength(0);
        },
      );
    });

    it("repairs an already-adopted benchmark stuck at stage 1 and restores missing membership idempotently", async () => {
      await withCohortFixture(async ({ db, campaignId, generations }) => {
        await db.execute(sql`UPDATE progressive_work work SET state='complete' FROM progressive_generations generation
        WHERE work.generation_id=generation.id AND generation.campaign_id=${campaignId}::uuid AND work.stage=1`);
        await db.execute(
          sql`UPDATE progressive_generations SET stage=2 WHERE campaign_id=${campaignId}::uuid`,
        );
        await db.execute(
          sql`INSERT INTO campaign_progressive_execution_policies(campaign_id,policy) VALUES (${campaignId},'subsonic-through-precise-v1')`,
        );
        await db.execute(
          sql`INSERT INTO progressive_generation_cohorts(generation_id,cohort) VALUES (${generations[0]},'low')`,
        );
        const immutable = await sealedState(db);
        const workBefore = await db.execute(
          sql`SELECT * FROM progressive_work ORDER BY id`,
        );
        for (let replay = 0; replay < 2; replay += 1) {
          expect(
            await adoptProgressiveSubsonicPriority(db, campaignId),
          ).toMatchObject({ replayed: true });
          const stages = await benchmarkStages(db, campaignId);
          expect(stages).toHaveLength(2);
          expect(
            stages.every(
              (row) =>
                row.cohort === "low" &&
                row.cohort_stage === 2 &&
                row.effective_stage === 2,
            ),
          ).toBe(true);
          expect(
            await db.execute(
              sql`SELECT * FROM progressive_generation_cohort_targets`,
            ),
          ).toHaveLength(2);
        }
        expect(await sealedState(db)).toEqual(immutable);
        expect(
          await db.execute(sql`SELECT * FROM progressive_work ORDER BY id`),
        ).toEqual(workBefore);
      });
    });

    it("finishes complete or gapped benchmark fast cohorts at stage 2 without creating stage 3", async () => {
      await withCohortFixture(async ({ db, campaignId, generations }) => {
        await db.execute(sql`UPDATE progressive_work work SET state='complete' FROM progressive_generations generation
        WHERE work.generation_id=generation.id AND generation.campaign_id=${campaignId}::uuid AND work.stage=1`);
        await adoptProgressiveSubsonicPriority(db, campaignId);
        const immutable = await sealedState(db);
        await db.execute(
          sql`UPDATE progressive_work SET state='complete' WHERE generation_id=${generations[0]}::uuid AND stage=2`,
        );
        await db.execute(
          sql`UPDATE progressive_work SET state='gap' WHERE generation_id=${generations[1]}::uuid AND stage=2`,
        );
        for (const generationId of generations)
          await advanceGeneration(db, generationId);
        const rows = await benchmarkStages(db, campaignId);
        expect(rows.find((row) => row.id === generations[0])).toMatchObject({
          stage: 2,
          status: "complete",
          cohort_stage: 2,
          cohort_status: "complete",
        });
        expect(rows.find((row) => row.id === generations[1])).toMatchObject({
          stage: 2,
          status: "attention",
          cohort_stage: 2,
          cohort_status: "attention",
        });
        expect(
          await db.execute(
            sql`SELECT work.id FROM progressive_work work JOIN progressive_generations generation ON generation.id=work.generation_id WHERE generation.benchmark_only AND work.stage=3`,
          ),
        ).toHaveLength(0);
        expect(await sealedState(db)).toEqual(immutable);
      });
    });

    it("preserves the normal precise stage for non-benchmark cohorts", async () => {
      await withCohortFixture(async ({ db, preciseCampaignId }) => {
        const immutable = await sealedState(db);
        await adoptProgressiveSubsonicPriority(db, preciseCampaignId);
        expect(
          await db.execute(
            sql`SELECT cursor.stage,cursor.status FROM progressive_generation_cohorts cursor JOIN progressive_generations generation ON generation.id=cursor.generation_id WHERE generation.campaign_id=${preciseCampaignId}::uuid`,
          ),
        ).toEqual([{ stage: 3, status: "active" }]);
        expect(await sealedState(db)).toEqual(immutable);
      });
    });
  },
);
