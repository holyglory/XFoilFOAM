import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  claimNextPendingUransRequest,
  claimNextPendingVerifyItem,
  createClient,
  enqueuePrecalcVerifications,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  schedulingProfiles,
  simJobs,
  simLadderSubmitRetries,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import {
  EngineError,
  type EngineClient,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  type LadderSubmitOwner,
  submitPendingJobWithLifecycleGuard,
} from "../src/submit-lifecycle";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `ladder-submit-${process.pid}-${Date.now().toString(36)}`;
const CHORD = 0.2317;

type OwnerKind = "request" | "verify";
interface OwnerFixture {
  kind: OwnerKind;
  id: string;
  submitOwner: LadderSubmitOwner;
  precalcResultId: string | null;
}

let airfoilId = "";
let bcId = "";
let revisionId = "";
let nextAoa = 1;
const fixtureIds = {
  category: "",
  medium: "",
  flow: "",
  geometry: "",
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
  sweep: "",
  preset: "",
};

async function createOwner(
  kind: OwnerKind,
  state: "pending" | "running" = "pending",
): Promise<OwnerFixture> {
  const aoaDeg = nextAoa++;
  if (kind === "request") {
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg,
        fidelity: "full",
        state,
        backgroundOwner: true,
        requestedBy: `${PREFIX}-test`,
      })
      .returning();
    return {
      kind,
      id: request.id,
      submitOwner: { uransRequestId: request.id },
      precalcResultId: null,
    };
  }

  const [precalc] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      fidelity: "urans_precalc",
      cl: 0.2 + aoaDeg / 100,
      cd: 0.02,
      cm: -0.01,
      converged: true,
      solvedAt: new Date(),
    })
    .returning();
  const [item] = await db
    .insert(simUransVerifyQueue)
    .values({
      airfoilId,
      revisionId,
      aoaDeg,
      state,
      backgroundOwner: true,
      precalcResultId: precalc.id,
    })
    .returning();
  return {
    kind,
    id: item.id,
    submitOwner: { verifyQueueId: item.id },
    precalcResultId: precalc.id,
  };
}

async function ownerState(owner: OwnerFixture): Promise<{
  state: string;
  simJobId: string | null;
}> {
  if (owner.kind === "request") {
    const [row] = await db
      .select({
        state: simUransRequests.state,
        simJobId: simUransRequests.simJobId,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, owner.id));
    return row;
  }
  const [row] = await db
    .select({
      state: simUransVerifyQueue.state,
      simJobId: simUransVerifyQueue.simJobId,
    })
    .from(simUransVerifyQueue)
    .where(eq(simUransVerifyQueue.id, owner.id));
  return row;
}

async function claimOwner(owner: OwnerFixture): Promise<void> {
  const claimed =
    owner.kind === "request"
      ? await claimNextPendingUransRequest(db, { requestIds: [owner.id] })
      : await claimNextPendingVerifyItem(db, { verifyIds: [owner.id] });
  expect(claimed?.id).toBe(owner.id);
}

async function composeJob(owner: OwnerFixture): Promise<string> {
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      campaignId: null,
      jobKind: owner.kind === "verify" ? "verify" : "targeted",
      referenceChordM: CHORD,
      wave: 2,
      status: "pending",
      totalCases: 1,
      requestPayload: {
        aoas: [nextAoa - 1],
        uransFidelity: "full",
        ...(owner.kind === "request"
          ? { uransRequestId: owner.id }
          : { verifyQueueItemId: owner.id }),
      },
    })
    .returning({ id: simJobs.id });
  if (owner.kind === "request") {
    const bound = await db
      .update(simUransRequests)
      .set({ simJobId: job.id })
      .where(
        and(
          eq(simUransRequests.id, owner.id),
          eq(simUransRequests.state, "running"),
        ),
      )
      .returning({ id: simUransRequests.id });
    expect(bound).toHaveLength(1);
  } else {
    const bound = await db
      .update(simUransVerifyQueue)
      .set({ simJobId: job.id })
      .where(
        and(
          eq(simUransVerifyQueue.id, owner.id),
          eq(simUransVerifyQueue.state, "running"),
        ),
      )
      .returning({ id: simUransVerifyQueue.id });
    expect(bound).toHaveLength(1);
  }
  await db
    .update(simLadderSubmitRetries)
    .set({ latestSimJobId: job.id })
    .where(
      owner.kind === "request"
        ? eq(simLadderSubmitRetries.uransRequestId, owner.id)
        : eq(simLadderSubmitRetries.verifyQueueId, owner.id),
    );
  return job.id;
}

async function submit(
  owner: OwnerFixture,
  jobId: string,
  engine: EngineClient,
) {
  return submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId,
    campaignId: null,
    request: {} as PolarRequest,
    connectionErrorPrefix: "connection: ",
    submitErrorPrefix: "full ladder submit: ",
    ladderSubmitOwner: owner.submitOwner,
  });
}

async function retryRow(owner: OwnerFixture) {
  const [row] = await db
    .select()
    .from(simLadderSubmitRetries)
    .where(
      owner.kind === "request"
        ? eq(simLadderSubmitRetries.uransRequestId, owner.id)
        : eq(simLadderSubmitRetries.verifyQueueId, owner.id),
    );
  return row ?? null;
}

async function seedDueRetry(owner: OwnerFixture): Promise<void> {
  await db.insert(simLadderSubmitRetries).values({
    ...(owner.kind === "request"
      ? { uransRequestId: owner.id }
      : { verifyQueueId: owner.id }),
    state: "retry_wait",
    attemptCount: 1,
    nextAttemptAt: new Date(Date.now() - 1_000),
    lastHttpStatus: 503,
    lastError: "first answered 503",
  });
}

async function expectNoSolverEvidence(jobIds: string[]): Promise<void> {
  const attempts = await db
    .select({ id: resultAttempts.id })
    .from(resultAttempts)
    .where(inArray(resultAttempts.simJobId, jobIds));
  const canonical = await db
    .select({ id: results.id })
    .from(results)
    .where(inArray(results.simJobId, jobIds));
  expect(attempts).toHaveLength(0);
  expect(canonical).toHaveLength(0);
}

beforeAll(async () => {
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-category`,
      name: `${PREFIX} category`,
      path: `${PREFIX}-category`,
      depth: 0,
    })
    .returning();
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-airfoil`,
      name: `${PREFIX} airfoil`,
      categoryId: category.id,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.04 },
        { x: 1, y: 0 },
      ],
    })
    .returning();
  fixtureIds.category = category.id;
  airfoilId = airfoil.id;
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-medium`,
      name: `${PREFIX} medium`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.46e-5,
      speedOfSound: 340.3,
    })
    .returning();
  fixtureIds.medium = medium.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId: medium.id,
      speedMps: 20,
    })
    .returning();
  fixtureIds.flow = flow.id;
  const [geometry] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${PREFIX}-geometry`,
      name: `${PREFIX} geometry`,
      referenceLengthM: CHORD,
    })
    .returning();
  fixtureIds.geometry = geometry.id;
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  fixtureIds.boundary = boundary.id;
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  fixtureIds.mesh = mesh.id;
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  fixtureIds.solver = solver.id;
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${PREFIX}-scheduling`, name: `${PREFIX} scheduling` })
    .returning();
  fixtureIds.scheduling = scheduling.id;
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  fixtureIds.output = output.id;
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({ slug: `${PREFIX}-sweep`, name: `${PREFIX} sweep`, aoaList: [1] })
    .returning();
  fixtureIds.sweep = sweep.id;
  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-legacy`,
      name: `${PREFIX} legacy`,
      mediumId: medium.id,
      reynolds: 315_000,
      referenceChordM: CHORD,
    })
    .returning();
  bcId = legacy.id;
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: geometry.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      enabled: false,
    })
    .returning();
  fixtureIds.preset = preset.id;
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber: 1,
      signatureHash: `${PREFIX}-signature`,
      reynolds: 315_000,
      mach: 0.06,
      referenceLengthM: CHORD,
      snapshot: {},
    })
    .returning();
  revisionId = revision.id;
});

afterEach(async () => {
  await db.execute(
    dsql`DROP TRIGGER IF EXISTS ladder_retry_test_fail ON sim_urans_requests`,
  );
  await db.execute(
    dsql`DROP TRIGGER IF EXISTS ladder_retry_test_fail ON sim_urans_verify_queue`,
  );
  await db.execute(dsql`DROP FUNCTION IF EXISTS ladder_retry_test_fail()`);
  await db
    .delete(simUransRequests)
    .where(eq(simUransRequests.revisionId, revisionId));
  await db
    .delete(simUransVerifyQueue)
    .where(eq(simUransVerifyQueue.revisionId, revisionId));
  await db
    .delete(resultClassifications)
    .where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
  await db
    .delete(resultAttempts)
    .where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
  await db
    .delete(results)
    .where(eq(results.simulationPresetRevisionId, revisionId));
  await db
    .delete(simJobs)
    .where(eq(simJobs.simulationPresetRevisionId, revisionId));
});

afterAll(async () => {
  if (revisionId) {
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.revisionId, revisionId));
    await db
      .delete(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    await db
      .delete(resultClassifications)
      .where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
    await db
      .delete(resultAttempts)
      .where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
    await db
      .delete(results)
      .where(eq(results.simulationPresetRevisionId, revisionId));
    await db
      .delete(simJobs)
      .where(eq(simJobs.simulationPresetRevisionId, revisionId));
  }
  if (fixtureIds.preset)
    await db
      .delete(simulationPresets)
      .where(eq(simulationPresets.id, fixtureIds.preset));
  if (bcId)
    await db.delete(boundaryConditions).where(eq(boundaryConditions.id, bcId));
  if (fixtureIds.flow)
    await db
      .delete(flowConditions)
      .where(eq(flowConditions.id, fixtureIds.flow));
  if (fixtureIds.geometry)
    await db
      .delete(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.id, fixtureIds.geometry));
  if (fixtureIds.boundary)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, fixtureIds.boundary));
  if (fixtureIds.mesh)
    await db.delete(meshProfiles).where(eq(meshProfiles.id, fixtureIds.mesh));
  if (fixtureIds.solver)
    await db
      .delete(solverProfiles)
      .where(eq(solverProfiles.id, fixtureIds.solver));
  if (fixtureIds.scheduling)
    await db
      .delete(schedulingProfiles)
      .where(eq(schedulingProfiles.id, fixtureIds.scheduling));
  if (fixtureIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, fixtureIds.output));
  if (fixtureIds.sweep)
    await db
      .delete(sweepDefinitions)
      .where(eq(sweepDefinitions.id, fixtureIds.sweep));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (fixtureIds.category)
    await db.delete(categories).where(eq(categories.id, fixtureIds.category));
  if (fixtureIds.medium)
    await db.delete(mediums).where(eq(mediums.id, fixtureIds.medium));
  await sql.end();
});

describe.sequential("durable full-ladder submit retry", () => {
  for (const kind of ["request", "verify"] as const) {
    it(`${kind}: deterministic 422 blocks immediately without solver evidence`, async () => {
      const owner = await createOwner(kind, "running");
      const jobId = await composeJob(owner);
      const outcome = await submit(owner, jobId, {
        submitPolar: async () => {
          throw new EngineError("validation rejected", 422);
        },
      } as unknown as EngineClient);

      expect(outcome).toMatchObject({
        kind: "submit_failed",
        httpStatus: 422,
        ladderDisposition: "blocked",
      });
      expect(await ownerState(owner)).toMatchObject({
        state: "blocked",
        simJobId: kind === "request" ? jobId : null,
      });
      expect(await retryRow(owner)).toMatchObject({
        state: "blocked",
        attemptCount: 0,
        nextAttemptAt: null,
        latestSimJobId: jobId,
        lastHttpStatus: 422,
        lastError: "full ladder submit: validation rejected",
      });
      await expectNoSolverEvidence([jobId]);
    });

    it(`${kind}: first 503 waits, early claim makes no call, due second 503 blocks`, async () => {
      const owner = await createOwner(kind);
      await claimOwner(owner);
      const firstJobId = await composeJob(owner);
      let calls = 0;
      const unavailable = {
        submitPolar: async () => {
          calls += 1;
          throw new EngineError("admission unavailable", 503);
        },
      } as unknown as EngineClient;

      const first = await submit(owner, firstJobId, unavailable);
      expect(first).toMatchObject({
        kind: "submit_failed",
        ladderDisposition: "retry_wait",
      });
      expect(await ownerState(owner)).toMatchObject({
        state: "pending",
        simJobId: null,
      });
      const delayed = await retryRow(owner);
      expect(delayed).toMatchObject({
        state: "retry_wait",
        attemptCount: 1,
        latestSimJobId: firstJobId,
        lastHttpStatus: 503,
      });
      expect(delayed?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());

      const early =
        kind === "request"
          ? await claimNextPendingUransRequest(db, { requestIds: [owner.id] })
          : await claimNextPendingVerifyItem(db, { verifyIds: [owner.id] });
      expect(early).toBeNull();
      expect(calls).toBe(1);

      await db.execute(dsql`
        UPDATE sim_ladder_submit_retries
        SET next_attempt_at = now() - interval '1 second'
        WHERE id = ${delayed!.id}
      `);
      await claimOwner(owner);
      const secondJobId = await composeJob(owner);
      const second = await submit(owner, secondJobId, unavailable);
      expect(second).toMatchObject({
        kind: "submit_failed",
        ladderDisposition: "blocked",
      });
      expect(calls).toBe(2);
      expect(await ownerState(owner)).toMatchObject({
        state: "blocked",
        simJobId: kind === "request" ? secondJobId : null,
      });
      expect(await retryRow(owner)).toMatchObject({
        state: "blocked",
        attemptCount: 1,
        nextAttemptAt: null,
        latestSimJobId: secondJobId,
      });
      await expectNoSolverEvidence([firstJobId, secondJobId]);
    });

    it(`${kind}: connection failures are unlimited and preserve the answered retry count`, async () => {
      const owner = await createOwner(kind);
      await seedDueRetry(owner);
      let calls = 0;
      const disconnected = {
        submitPolar: async () => {
          calls += 1;
          throw new Error("connection refused");
        },
      } as unknown as EngineClient;
      const jobs: string[] = [];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await claimOwner(owner);
        const jobId = await composeJob(owner);
        jobs.push(jobId);
        expect(await submit(owner, jobId, disconnected)).toMatchObject({
          kind: "connection_failure",
        });
        expect(await ownerState(owner)).toMatchObject({
          state: "pending",
          simJobId: null,
        });
        expect(await retryRow(owner)).toMatchObject({
          state: "retry_wait",
          attemptCount: 1,
          latestSimJobId: jobId,
          lastHttpStatus: null,
          lastError: "connection: connection refused",
        });
      }
      expect(calls).toBe(2);
      await expectNoSolverEvidence(jobs);
    });

    it(`${kind}: accepted retry clears the scheduling ledger`, async () => {
      const owner = await createOwner(kind);
      await seedDueRetry(owner);
      await claimOwner(owner);
      const jobId = await composeJob(owner);
      const outcome = await submit(owner, jobId, {
        submitPolar: async (): Promise<JobStatus> => ({
          job_id: `${PREFIX}-${kind}-accepted`,
          state: "pending",
          total_cases: 1,
          completed_cases: 0,
        }),
      } as unknown as EngineClient);

      expect(outcome.kind).toBe("submitted");
      expect(await retryRow(owner)).toBeNull();
      expect(await ownerState(owner)).toMatchObject({
        state: "running",
        simJobId: jobId,
      });
      const [job] = await db
        .select({ status: simJobs.status, engineJobId: simJobs.engineJobId })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(job).toMatchObject({
        status: "submitted",
        engineJobId: `${PREFIX}-${kind}-accepted`,
      });
      await expectNoSolverEvidence([jobId]);
    });

    it(`${kind}: owner-write failure rolls job and ledger back atomically`, async () => {
      const owner = await createOwner(kind, "running");
      const jobId = await composeJob(owner);
      await db.execute(dsql`
        CREATE OR REPLACE FUNCTION ladder_retry_test_fail()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.state = 'blocked' THEN
            RAISE EXCEPTION 'injected owner failure';
          END IF;
          RETURN NEW;
        END $$
      `);
      if (kind === "request") {
        await db.execute(dsql`
          CREATE TRIGGER ladder_retry_test_fail
          BEFORE UPDATE ON sim_urans_requests
          FOR EACH ROW EXECUTE FUNCTION ladder_retry_test_fail()
        `);
      } else {
        await db.execute(dsql`
          CREATE TRIGGER ladder_retry_test_fail
          BEFORE UPDATE ON sim_urans_verify_queue
          FOR EACH ROW EXECUTE FUNCTION ladder_retry_test_fail()
        `);
      }

      await expect(
        submit(owner, jobId, {
          submitPolar: async () => {
            throw new EngineError("validation rejected", 422);
          },
        } as unknown as EngineClient),
      ).rejects.toThrow("injected owner failure");

      const [job] = await db
        .select({ status: simJobs.status, engineState: simJobs.engineState })
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      expect(job).toMatchObject({
        status: "pending",
        engineState: "submitting",
      });
      expect(await ownerState(owner)).toMatchObject({
        state: "running",
        simJobId: jobId,
      });
      expect(await retryRow(owner)).toBeNull();
      await expectNoSolverEvidence([jobId]);
    });

    it(`${kind}: stale job cannot call the engine or overwrite a newer lease`, async () => {
      const owner = await createOwner(kind, "running");
      const staleJobId = await composeJob(owner);
      await db.insert(simLadderSubmitRetries).values({
        ...(kind === "request"
          ? { uransRequestId: owner.id }
          : { verifyQueueId: owner.id }),
        state: "retry_wait",
        attemptCount: 1,
        nextAttemptAt: new Date(Date.now() - 1_000),
        latestSimJobId: staleJobId,
        lastHttpStatus: 503,
        lastError: "older failure",
      });
      const currentJobId = await composeJob(owner);
      let calls = 0;
      const outcome = await submit(owner, staleJobId, {
        submitPolar: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      } as unknown as EngineClient);

      expect(outcome.kind).toBe("lifecycle_stopped");
      expect(calls).toBe(0);
      expect(await retryRow(owner)).toMatchObject({
        state: "retry_wait",
        attemptCount: 1,
        latestSimJobId: currentJobId,
        lastError: "older failure",
      });
      expect(await ownerState(owner)).toMatchObject({
        state: "running",
        simJobId: currentJobId,
      });
    });
  }

  it("same accepted preliminary evidence cannot reopen a blocked verification", async () => {
    const owner = await createOwner("verify", "pending");
    await db.insert(resultClassifications).values({
      resultId: owner.precalcResultId!,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: nextAoa - 1,
      regime: "urans",
      classifierVersion: `${PREFIX}-accepted-v1`,
      state: "accepted",
      region: "attached",
      confidence: 1,
      reasons: ["accepted preliminary evidence"],
    });
    await db
      .update(simUransVerifyQueue)
      .set({ state: "blocked" })
      .where(eq(simUransVerifyQueue.id, owner.id));
    await db.insert(simLadderSubmitRetries).values({
      verifyQueueId: owner.id,
      state: "blocked",
      attemptCount: 1,
      nextAttemptAt: null,
      lastHttpStatus: 503,
      lastError: "full verification submit exhausted",
    });

    expect(
      await enqueuePrecalcVerifications(db, {
        airfoilId,
        revisionId,
        aoaDeg: nextAoa - 1,
      }),
    ).toBe(0);
    const rows = await db
      .select({ id: simUransVerifyQueue.id })
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, owner.precalcResultId!));
    expect(rows).toHaveLength(1);
  });
});
