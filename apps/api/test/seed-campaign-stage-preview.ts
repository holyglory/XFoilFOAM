// Opt-in startup seed for the stopped, private loopback preview. The attempt
// data and classifiers are the same test inputs used in campaigns.test.ts.
import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DB, campaignPreliminaryOutcomes, createClient, ensurePrecalcObligations,
  materializeCampaignLaunch, results, simJobs, simPrecalcObligationAttempts,
  simPrecalcObligations, simUransVerifyQueue, simUransVerifyQueueCampaigns,
} from "@aerodb/db";
import { eq, sql } from "drizzle-orm";
import { SEEDED_RUNTIME_PROFILE_SLUGS as profiles } from "../../../packages/db/seed/runtime-profiles";
import { insertCampaignStageAttempt, stageCoefficients } from "./campaign-stage-fixture";

const env = process.env;
assert(env.DC2_COMPONENT === "api" && env.DC2_POSTGRES_DB_URL && env.DATABASE_URL === env.DC2_POSTGRES_DB_URL);
assert(env.API_HOST === "127.0.0.1" && env.ENGINE_URL === "http://127.0.0.1:1" && env.ADMIN_AUTH_REQUIRED === "true");
assert(env.DC2_GENERATION && /^[a-zA-Z0-9_-]+$/.test(env.DC2_GENERATION));
const url = new URL(env.DC2_POSTGRES_DB_URL);
assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/aerodb_campaign_stage");
const directory = join(fileURLToPath(new URL("../../../.codex-artifacts/campaign-stage-preview/", import.meta.url)), env.DC2_GENERATION);
const client = createClient({ max: 1 });
try {
  const metadata = await client.db.transaction(async (tx) => {
    const db = tx as unknown as DB;
    const [state] = await db.execute(sql`SELECT enabled, current_database() AS name FROM sweeper_state WHERE id=1 FOR SHARE`);
    assert(state?.enabled === false && state.name === "aerodb_campaign_stage");
    const airfoilSlug = "ag24";
    const aoaDeg = 4;
    const [source] = await db.execute(sql`
      SELECT af.id AS airfoil, m.id AS medium, b.id AS boundary, mesh.id AS mesh, s.id AS solver, o.id AS output
      FROM airfoils af, mediums m, boundary_profiles b, mesh_profiles mesh, solver_profiles s, output_profiles o
      WHERE af.slug=${airfoilSlug} AND m.slug='air' AND b.slug=${profiles.boundary}
        AND mesh.slug=${profiles.mesh} AND s.slug=${profiles.solver} AND o.slug=${profiles.output}`);
    assert(source, "The ordinary imported AG24 and runtime profiles are required");
    const airfoilId = String(source.airfoil);
    const { campaign, replayed } = await materializeCampaignLaunch(db, {
      name: "Private stage fixture · AG24", idempotencyKey: "private-stage-attempt-fixture-v1",
      priority: 5, airfoilIds: [airfoilId], plan: {
        mediumId: String(source.medium), ambients: [[288.15, 101325]], speedsMps: [30.097],
        chordsM: [0.2847], spanM: 1, areaMode: "derived", excludedConditions: [],
        baseSweep: { fromDeg: null, toDeg: null, stepDeg: null, listDeg: [aoaDeg] },
        objectives: {
          ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
          clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        },
        numerics: { boundaryProfileId: String(source.boundary), meshProfileId: String(source.mesh),
          solverProfileId: String(source.solver), outputProfileId: String(source.output) },
      },
    });
    const [condition] = await db.execute(sql`
      SELECT c.id, c.ord, c.simulation_preset_revision_id AS revision, p.legacy_boundary_condition_id AS bc
      FROM sim_campaign_conditions c JOIN simulation_presets p ON p.id=c.preset_id
      WHERE c.campaign_id=${campaign.id} AND c.generation=${campaign.currentConditionGeneration}`);
    assert(condition?.bc && condition.revision);
    if (!replayed) {
      const cell = { airfoilId, aoaDeg, bcId: String(condition.bc), simulationPresetRevisionId: String(condition.revision) };
      async function createJob(uransFidelity: "precalc" | "full") {
        const [job] = await db.insert(simJobs).values({
          airfoilId, campaignId: campaign.id, bcIds: [cell.bcId], simulationPresetRevisionId: cell.simulationPresetRevisionId,
          referenceChordM: 0.2847, jobKind: "targeted", wave: 2, status: "done", completedCases: 1, totalCases: 1,
          finishedAt: new Date(), requestPayload: { aoas: [aoaDeg], uransFidelity },
        }).returning({ id: simJobs.id });
        return job;
      }
      const fastJob = await createJob("precalc");
      const finalJob = await createJob("full");
      const [result] = await db.insert(results).values({ ...cell, ...stageCoefficients.final, simJobId: finalJob.id,
        status: "done", source: "solved", regime: "urans", unsteady: true, converged: true, solvedAt: new Date() })
        .returning({ id: results.id });
      const owner = { ...cell, resultId: result.id };
      const { attempt: fast } = await insertCampaignStageAttempt(db, owner, "fast", fastJob.id, "private-stage-fixture-fast");
      const { attempt: final } = await insertCampaignStageAttempt(db, owner, "final", finalJob.id, "private-stage-fixture-final");
      await db.update(results).set({ currentResultAttemptId: final.id }).where(eq(results.id, result.id));
      const [obligation] = await ensurePrecalcObligations(db, [{ airfoilId, revisionId: cell.simulationPresetRevisionId,
        aoaDeg, sourceResultId: result.id, sourceResultAttemptId: fast.id }], { campaignIds: [campaign.id] });
      await db.update(simPrecalcObligations).set({ state: "satisfied", attemptCount: 1, lastOutcome: "accepted",
        completedAt: new Date() }).where(eq(simPrecalcObligations.id, obligation.id));
      await db.insert(simPrecalcObligationAttempts).values({ obligationId: obligation.id, simJobId: fastJob.id,
        attemptNumber: 1, solverAttemptNumber: 1, consumesSolverAttempt: true, state: "accepted",
        outcome: "accepted", resultAttemptId: fast.id, completedAt: new Date() });
      const [verification] = await db.insert(simUransVerifyQueue).values({ airfoilId, revisionId: cell.simulationPresetRevisionId,
        aoaDeg, state: "done", simJobId: finalJob.id, precalcResultId: result.id, precalcResultAttemptId: fast.id,
        verifyResultId: result.id, deltaCl: 0.01, deltaCd: 0.001, deltaCm: -0.001 }).returning({ id: simUransVerifyQueue.id });
      await db.insert(simUransVerifyQueueCampaigns).values({ campaignId: campaign.id, queueId: verification.id });
    }
    const { items } = await campaignPreliminaryOutcomes(db, campaign.id, { conditionId: String(condition.id), airfoilId });
    assert.equal(items.length, 1);
    const [point] = items;
    assert(point.aoaDeg === aoaDeg && point.fastState === "accepted" && point.finalState === "accepted");
    assert(point.fastResultId && point.finalResultId === point.fastResultId && point.fastResultAttemptId &&
      point.finalResultAttemptId && point.finalResultAttemptId !== point.fastResultAttemptId);
    return { campaignId: campaign.id, airfoilSlug, conditionOrd: Number(condition.ord), aoaDeg,
      resultId: point.fastResultId, fastAttemptId: point.fastResultAttemptId, finalAttemptId: point.finalResultAttemptId };
  });
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `fixture.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, join(directory, "fixture.json"));
} finally {
  await client.sql.end();
}
