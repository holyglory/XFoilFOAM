import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createClient, type DB } from "../src/client";
import { advanceGeneration } from "../src/progressive-campaigns";
import { readFastV2BenchmarkReport } from "../src/progressive-fast-v2-benchmark";
import { SOURCE_GEOMETRY_POLICY_VERSION } from "../src/progressive-evidence-geometry";
import { advanceProgressiveCfdStages } from "../src/progressive-cfd-stages";
import {
  adoptProgressiveSubsonicPriority,
  effectiveProgressiveStageSql,
  progressiveCohortReadinessSql,
  progressiveCohortInitializedSql,
  progressiveInitialCoverageCompleteSql,
} from "../src/progressive-execution-policy";

async function withCohortFixture(
  verify: (fixture: {
    db: DB;
    campaignId: string;
    generations: string[];
    preciseCampaignId: string;
    preciseGenerationId: string;
  }) => Promise<void>,
  benchmarkAngles: number[] = [-4, 7],
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
        const angles = benchmarkOnly ? benchmarkAngles : [-4, 7];
        await db.execute(sql`INSERT INTO progressive_generation_targets VALUES
          (${generationId},${targetId},${randomUUID()},ARRAY[${sql.join(angles.map(alpha => sql`${alpha}::double precision`), sql`,`)}],
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

async function installStageTables(db: DB) {
  await db.execute(sql`ALTER TABLE sim_campaigns
    ADD COLUMN "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    ADD COLUMN "updatedAt" timestamptz,
    ADD COLUMN "completedAt" timestamptz`);
  await db.execute(sql`ALTER TABLE progressive_generations
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp()`);
  await db.execute(sql`ALTER TABLE progressive_work
    ADD COLUMN error text, ADD COLUMN completed_at timestamptz`);
  await db.execute(sql`ALTER TABLE progressive_generation_cohorts
    ADD COLUMN adaptive_fast_deferred boolean NOT NULL DEFAULT false`);
  await db.execute(sql`DROP TABLE progressive_cfd_units`);
  for (const table of [
    "progressive_cfd_units",
    "progressive_cfd_attempts",
    "progressive_cfd_execution_stops",
    "progressive_cfd_evidence",
    "progressive_cfd_evidence_reuses",
    "progressive_prediction_links",
    "neuralfoil_predictions",
    "progressive_polar_fit_work",
    "progressive_polar_geometry_verifications",
    "progressive_polar_models",
    "progressive_cfd_stage_decisions",
    "progressive_scope_requests",
  ]) {
    await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)}
      (LIKE public.${sql.identifier(table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)
      ON COMMIT DROP`);
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
    it("preserves whole-cohort initialization and adaptive coverage for one pinned work", async () => {
      await withCohortFixture(async ({ db, campaignId, generations }) => {
        const generation = generations[0];
        const [w] = await db.execute(
          sql`SELECT work.id,work.target_id,g.epoch_id FROM progressive_work work JOIN progressive_generations g ON g.id=work.generation_id WHERE work.generation_id=${generation}::uuid AND work.stage=2`,
        );
        const workId = String(w.id),
          epoch = String(w.epoch_id),
          high = "b".repeat(64);
        const addSibling = async (target: string, mach: number) => {
          const sibling = randomUUID();
          await db.execute(
            sql`INSERT INTO polar_analysis_targets(id,physical) VALUES (${target},${JSON.stringify({ derived: { mach }, geometrySignature: target })}::jsonb)`,
          );
          await db.execute(sql`INSERT INTO progressive_generation_targets(generation_id,target_id,revision_id,angles,recipes)
            SELECT generation_id,${target},${randomUUID()}::uuid,angles,recipes FROM progressive_generation_targets
            WHERE generation_id=${generation}::uuid AND target_id=${w.target_id}`);
          await db.execute(
            sql`INSERT INTO progressive_work(id,generation_id,target_id,stage,state) VALUES (${sibling}::uuid,${generation}::uuid,${target},2,'pending')`,
          );
          return sibling;
        };
        await db.execute(
          sql`ALTER TABLE pg_temp.progressive_cfd_units ADD COLUMN purpose text NOT NULL DEFAULT 'initial'`,
        );
        await db.execute(
          sql`UPDATE progressive_generations SET stage=2 WHERE id=${generation}::uuid`,
        );
        await addSibling(high, 1.2);
        const initial = randomUUID(),
          adaptive = randomUUID();
        await db.execute(
          sql`INSERT INTO progressive_cfd_units(id,work_id,state,purpose) VALUES (${initial}::uuid,${workId}::uuid,'pending','initial')`,
        );
        const accepted = async (pinned: boolean) => {
          const readiness = progressiveCohortReadinessSql(
            epoch,
            sql`generation.campaign_id=${campaignId}::uuid`,
            true,
            pinned ? workId : undefined,
          );
          return db.execute(sql`WITH ${readiness} SELECT unit.purpose,${progressiveCohortInitializedSql()} AS initialized,
            (unit.purpose<>'adaptive' OR ${progressiveInitialCoverageCompleteSql()}) AS coverage,
            (SELECT count(*)::int FROM progressive_cohort_readiness) AS computed
            FROM progressive_cfd_units unit JOIN progressive_work work ON work.id=unit.work_id JOIN progressive_generations generation ON generation.id=work.generation_id
            WHERE work.id=${workId}::uuid AND unit.state='pending' ORDER BY unit.purpose,unit.id`);
        };
        const parity = async (
          initialized: boolean,
          adaptiveCovered?: boolean,
        ) => {
          const full = await accepted(false),
            scoped = await accepted(true);
          const consumed = (rows: typeof full) =>
            rows.map((r) => [r.purpose, r.initialized, r.coverage]);
          expect(consumed(scoped)).toEqual(consumed(full));
          expect(scoped.length).toBeGreaterThan(0);
          expect(
            scoped.every(
              (r) => r.computed === 1 && r.initialized === initialized,
            ),
          ).toBe(true);
          for (const row of scoped)
            expect(row.coverage).toBe(
              row.purpose === "adaptive" ? adaptiveCovered : true,
            );
        };
        // Legacy generations have a NULL cohort covering every sibling.
        await parity(false);
        await db.execute(
          sql`INSERT INTO campaign_progressive_execution_policies(campaign_id,policy) VALUES(${campaignId}::uuid,'subsonic-through-precise-v1')`,
        );
        await db.execute(sql`INSERT INTO progressive_generation_cohorts(generation_id,cohort,stage) VALUES
          (${generation}::uuid,'low',2),(${generation}::uuid,'high',2)`);
        await db.execute(
          sql`INSERT INTO progressive_generation_cohort_targets VALUES (${generation}::uuid,${w.target_id},'low'),(${generation}::uuid,${high},'high')`,
        );
        await parity(true); // the uninitialized high sibling belongs to another cohort
        await db.execute(
          sql`INSERT INTO progressive_cfd_units(id,work_id,state,purpose) VALUES (${adaptive}::uuid,${workId}::uuid,'pending','adaptive')`,
        );
        await parity(true, false); // an initial unit is still pending
        await db.execute(
          sql`UPDATE progressive_cfd_units SET state='gap' WHERE id=${initial}::uuid`,
        );
        await parity(true, true);
        const low = "c".repeat(64);
        const lowWork = await addSibling(low, 0.24);
        await db.execute(
          sql`INSERT INTO progressive_generation_cohort_targets VALUES (${generation}::uuid,${low},'low')`,
        );
        await parity(false, false); // an uninitialized low sibling is a genuine barrier
        await db.execute(
          sql`INSERT INTO progressive_cfd_units(id,work_id,state,purpose) VALUES (${randomUUID()}::uuid,${lowWork}::uuid,'gap','initial')`,
        );
        await parity(true, true);
      });
    });

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


    it("settles physically stopped benchmark gaps with exhausted measured angles beside 8,208 open precise units", async () => {
      const grid = Array.from({ length: 26 }, (_, index) => index - 5);
      await withCohortFixture(async ({ db, campaignId, generations, preciseGenerationId }) => {
        await installStageTables(db);
        await db.execute(sql`ALTER TABLE progressive_generations ADD COLUMN scope_key text`);
        await db.execute(sql`UPDATE progressive_generations SET scope_key='fast-v2-benchmark:test:' ||
          CASE WHEN id=${generations[0]}::uuid THEN 'current-fast' ELSE 'fast-v2' END
          WHERE campaign_id=${campaignId}`);
        await db.execute(sql`UPDATE progressive_work SET state='complete'
          WHERE generation_id IN (${generations[0]},${generations[1]}) AND stage=1`);
        await adoptProgressiveSubsonicPriority(db, campaignId);

        // A separate, current precise generation owns the open backlog.
        const backlog = randomUUID();
        await db.execute(sql`INSERT INTO progressive_generations
          (id,campaign_id,epoch_id,plan_revision_id,benchmark_only,stage,status,scope_signature)
          SELECT ${backlog},campaign_id,epoch_id,plan_revision_id,false,3,'active','precise-backlog'
          FROM progressive_generations WHERE id=${preciseGenerationId}`);
        await db.execute(sql`INSERT INTO progressive_generation_targets
          SELECT ${backlog},md5('other-target-' || n),gen_random_uuid(),
            ARRAY(SELECT generate_series(-5,10))::double precision[],source.recipes
          FROM generate_series(1,513) n CROSS JOIN progressive_generation_targets source
          WHERE source.generation_id=${preciseGenerationId}`);
        await db.execute(sql`INSERT INTO progressive_work(id,generation_id,target_id,stage,state)
          SELECT gen_random_uuid(),generation_id,target_id,3,'pending' FROM progressive_generation_targets WHERE generation_id=${backlog}`);
        await db.execute(sql`INSERT INTO progressive_cfd_units
          (work_id,aoa_deg,ordinal,purpose,recipe,reason,policy_version,active_budget_seconds)
          SELECT work.id,angle,ordinal-1,'precise',scope.recipes->'precise','sealed grid','test',43200
          FROM progressive_generation_targets scope JOIN progressive_work work USING (generation_id,target_id)
          CROSS JOIN LATERAL unnest(scope.angles) WITH ORDINALITY a(angle,ordinal)
          WHERE scope.generation_id=${backlog}`);

        await db.execute(sql`INSERT INTO progressive_cfd_units
          (work_id,aoa_deg,ordinal,purpose,recipe,reason,policy_version,active_budget_seconds,active_seconds,attempts,state)
          SELECT work.id,angle,ordinal-1,CASE WHEN ordinal <= 2 THEN 'initial' ELSE 'adaptive' END,
            scope.recipes->'fast','sealed benchmark','test',900,20,1,CASE WHEN angle=7 THEN 'complete' ELSE 'gap' END
          FROM progressive_generation_targets scope JOIN progressive_work work USING (generation_id,target_id)
          JOIN progressive_generations generation ON generation.id=work.generation_id
          CROSS JOIN unnest(ARRAY[-4,7,14,13,16]) WITH ORDINALITY a(angle,ordinal)
          WHERE generation.benchmark_only AND work.stage=2`);
        await db.execute(sql`INSERT INTO progressive_cfd_attempts
          (token,unit_id,owner,lease_until,outcome,active_seconds,finished_at,sim_job_id)
          SELECT gen_random_uuid(),id,'test',now(),CASE WHEN state='complete' THEN 'complete' ELSE 'failed' END,
            active_seconds,now(),gen_random_uuid() FROM progressive_cfd_units WHERE purpose <> 'precise'`);
        await db.execute(sql`INSERT INTO sim_jobs SELECT attempt.sim_job_id,${campaignId},
          CASE WHEN unit.state='complete' THEN 'done' ELSE 'failed' END,unit.recipe
          FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id`);
        await db.execute(sql`INSERT INTO progressive_cfd_evidence
          (attempt_token,result_attempt_id,evidence_signature,solver_active_seconds)
          SELECT token,gen_random_uuid(),encode(sha256(uuid_send(token)),'hex'),active_seconds FROM progressive_cfd_attempts`);
        await db.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
          SELECT id,result_id,aoa_deg,regime,"createdAt",status,valid_for_polar,cl,cd,cm FROM public.result_attempts WITH NO DATA`);
        await db.execute(sql`CREATE TEMP TABLE result_classifications ON COMMIT DROP AS
          SELECT id,result_attempt_id,"createdAt",state FROM public.result_classifications WITH NO DATA`);
        await db.execute(sql`INSERT INTO result_attempts
          SELECT evidence.result_attempt_id,gen_random_uuid(),unit.aoa_deg,'rans',now(),
            (CASE WHEN unit.state='complete' THEN 'done' ELSE 'failed' END)::result_status,unit.state='complete',
            CASE WHEN unit.state='complete' THEN 1.01 END,CASE WHEN unit.state='complete' THEN 0.04 END,
            CASE WHEN unit.state='complete' THEN -0.07 END
          FROM progressive_cfd_evidence evidence JOIN progressive_cfd_attempts attempt ON attempt.token=evidence.attempt_token
          JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id`);
        await db.execute(sql`INSERT INTO result_classifications
          SELECT gen_random_uuid(),id,now(),'accepted' FROM result_attempts WHERE valid_for_polar`);

        const prediction = "a".repeat(64);
        const [target] = await db.execute(sql`SELECT target_id FROM progressive_generation_targets WHERE generation_id=${generations[0]}`);
        await db.execute(sql`INSERT INTO neuralfoil_predictions(id,epoch_id,target_id,payload)
          SELECT ${prediction},id,${target.target_id},'{"kind":"prediction","method":"neuralfoil","cfd_evidence":false}'::jsonb FROM calculation_epochs`);
        await db.execute(sql`INSERT INTO progressive_prediction_links SELECT work.id,${prediction}
          FROM progressive_work work JOIN progressive_generations generation ON generation.id=work.generation_id
          WHERE generation.benchmark_only AND work.stage=1`);
        const [contributor] = await db.execute(sql`SELECT evidence_signature,result_attempt_id FROM progressive_cfd_evidence
          JOIN result_attempts raw ON raw.id=result_attempt_id WHERE valid_for_polar LIMIT 1`);
        const exhaustedModel = "b".repeat(64);
        const openModel = "c".repeat(64);
        const partialGridModel = "d".repeat(64);
        for (const [id, candidateAngles] of [
          [exhaustedModel, [16]], [openModel, [15, 16]], [partialGridModel, [16]],
        ] as const) {
          const response = { estimate: { version: "progressive-polar-gp-v2", target_signature: target.target_id,
            alpha: id === partialGridModel ? grid.slice(1) : grid,
            contributors: [{ attempt_id: contributor.result_attempt_id, evidence_signature: contributor.evidence_signature }],
            acquisition: { version: "fixed-posterior-coverage-v1", status: "available",
              candidates: candidateAngles.map(alpha => ({ alpha, integrated_variance_reduction_fraction: 0.8 })) } } };
          await db.execute(sql`INSERT INTO progressive_polar_models(id,prediction_id,source_signature,request,response)
            VALUES (${id},${prediction},${contributor.evidence_signature},'{}'::jsonb,${JSON.stringify(response)}::jsonb)`);
          await db.execute(sql`INSERT INTO progressive_polar_geometry_verifications(model_id,policy_version,source_geometry_compatible)
            VALUES (${id},${SOURCE_GEOMETRY_POLICY_VERSION},true)`);
        }
        await db.execute(sql`INSERT INTO progressive_polar_fit_work(prediction_id,state,model_id) VALUES (${prediction},'ready',${exhaustedModel})`);
        await db.execute(sql`ANALYZE progressive_cfd_units`);
        await db.execute(sql`ANALYZE progressive_work`);

        const immutable = await sealedState(db);
        const before = await readFastV2BenchmarkReport(db, campaignId);
        expect(before.status).toBe("running");
        // A terminal database unit still waits for its physical stop proof.
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 0 });
        await db.execute(sql`INSERT INTO progressive_cfd_execution_stops
          (sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
          SELECT sim_job_id,sim_job_id::text,epoch.id,'{"execution_stopped":true}'::jsonb,
            encode(sha256(uuid_send(sim_job_id)),'hex'),now() FROM progressive_cfd_attempts CROSS JOIN calculation_epochs epoch`);

        // A genuinely untried measured angle follows normal admission. Roll back this alternative fixture.
        await db.execute(sql`SAVEPOINT untried_angle`);
        await db.execute(sql`UPDATE progressive_polar_fit_work SET model_id=${openModel}`);
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 2, closed: 0 });
        expect(await db.execute(sql`SELECT aoa_deg FROM progressive_cfd_units WHERE purpose='adaptive' AND state='pending'`))
          .toEqual([{ aoa_deg: 15 }, { aoa_deg: 15 }]);
        await db.execute(sql`ROLLBACK TO SAVEPOINT untried_angle`);

        await db.execute(sql`UPDATE progressive_polar_fit_work SET state='pending',model_id=NULL`);
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 0 });
        await db.execute(sql`UPDATE progressive_polar_fit_work SET state='ready',model_id=${partialGridModel}`);
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 0 });
        await db.execute(sql`UPDATE progressive_polar_fit_work SET model_id=${exhaustedModel}`);

        // A gap without a retained execution attempt cannot exhaust a measured candidate.
        await db.execute(sql`SAVEPOINT missing_attempt`);
        await db.execute(sql`DELETE FROM progressive_cfd_attempts attempt USING progressive_cfd_units unit
          WHERE unit.id=attempt.unit_id AND unit.aoa_deg=16`);
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 0 });
        await db.execute(sql`ROLLBACK TO SAVEPOINT missing_attempt`);
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 2 });
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 0 });
        const after = await readFastV2BenchmarkReport(db, campaignId);
        expect(after).toMatchObject({ status: "inconclusive", preciseWorkCreated: false, summary: {
          unfinishedCases: 0, unfinishedPoints: 0, failedAttempts: 8, runningAttempts: 0,
          finalComparison: { status: "inconclusive", allAttemptCostRatio: null, speedup: null },
        } });
        expect(after.cases[0]).toMatchObject({ speedup: null, coefficientDeltas: before.cases[0]!.coefficientDeltas,
          accuracy: { matchedPoints: 1, physicalTruthCertified: false }, firstPassTiming: before.cases[0]!.firstPassTiming });
        const decisions = await db.execute(sql`SELECT work.state,decision.kind,decision.reason,decision.candidate_alpha
          FROM progressive_cfd_stage_decisions decision JOIN progressive_work work ON work.id=decision.work_id`);
        expect(decisions).toEqual(Array(2).fill({ state: "gap", kind: "close_fast", candidate_alpha: null,
          reason: "fast_acquisition_candidates_already_attempted" }));
        expect(await sealedState(db)).toEqual(immutable);
        expect(await db.execute(sql`SELECT count(*)::int AS open FROM progressive_cfd_units WHERE state='pending'`)).toEqual([{ open: 8208 }]);
      }, grid);
    });

    it.each([2, 3])("appends immutable stage-%s closure history after the same units are reopened", async (stage) => {
      await withCohortFixture(async ({ db, generations, preciseGenerationId }) => {
        await installStageTables(db);
        const generationId = stage === 2 ? generations[0] : preciseGenerationId;
        await db.execute(sql`UPDATE progressive_work SET state='complete'
          WHERE generation_id=${generationId}::uuid AND stage < ${stage}`);
        await db.execute(sql`UPDATE progressive_generations SET stage=${stage}
          WHERE id=${generationId}::uuid`);
        const [work] = await db.execute(sql`UPDATE progressive_work SET state='pending'
          WHERE generation_id=${generationId}::uuid AND stage=${stage}
          RETURNING id, target_id`);
        const [target] = await db.execute(sql`SELECT recipes FROM progressive_generation_targets
          WHERE generation_id=${generationId}::uuid AND target_id=${work.target_id}`);
        const recipe = (target.recipes as Record<string, unknown>)[stage === 2 ? "fast" : "precise"];
        for (const [ordinal, alpha] of [-4, 7].entries()) {
          await db.execute(sql`INSERT INTO progressive_cfd_units
            (work_id,aoa_deg,ordinal,purpose,recipe,reason,policy_version,active_budget_seconds,state)
            VALUES (${work.id}::uuid,${alpha},${ordinal},${stage === 2 ? "initial" : "precise"},
              ${JSON.stringify(recipe)}::jsonb,'sealed fixture','stage-decision-fixture',${stage === 2 ? 900 : 43200},
              ${ordinal === 0 ? "gap" : "complete"})`);
        }
        const immutable = await sealedState(db);
        const units = await db.execute(sql`SELECT * FROM progressive_cfd_units ORDER BY ordinal`);
        const kind = stage === 2 ? "close_fast" : "close_precise";
        expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 1 });
        let history = await db.execute(sql`SELECT * FROM progressive_cfd_stage_decisions
          WHERE work_id=${work.id}::uuid ORDER BY ordinal`);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ ordinal: 2, kind });

        for (const ordinal of [3, 4]) {
          await db.execute(sql`UPDATE progressive_work SET state='pending', error=NULL, completed_at=NULL
            WHERE id=${work.id}::uuid`);
          await db.execute(sql`UPDATE progressive_generations SET status='active', completed_at=NULL
            WHERE id=${generationId}::uuid`);
          expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 1 });
          const decisions = await db.execute(sql`SELECT * FROM progressive_cfd_stage_decisions
            WHERE work_id=${work.id}::uuid ORDER BY ordinal`);
          expect(decisions.slice(0, -1)).toEqual(history);
          expect(decisions.at(-1)).toMatchObject({ ordinal, kind });
          history = decisions;
          expect(await advanceProgressiveCfdStages(db)).toMatchObject({ admitted: 0, closed: 0 });
          expect(await db.execute(sql`SELECT * FROM progressive_cfd_units ORDER BY ordinal`)).toEqual(units);
          expect(await sealedState(db)).toEqual(immutable);
        }
      });
    });
  },
);
