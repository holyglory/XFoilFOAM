/**
 * Durable queue integration coverage.  The pure policy suite covers the
 * ordering math; this suite proves the database receipt/lease transitions
 * against the real 0098/0099 schema.
 */
import {
  airfoils,
  createClient,
  resultArchiveReductionQueue,
  resultAttempts,
  resultClassifications,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretations,
  resultReducerVersions,
  results,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import {
  EngineTimeoutError,
  type ArchiveCleanCycleReductionResponse,
  type EngineClient,
  URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
} from "@aerodb/engine-client";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "../../../packages/db/test/solver-fixture";

import {
  drainArchiveReductionQueue,
  enqueueVerifiedArchiveReductions,
  supersedeArchiveReductionQueueForRecoveredAction,
} from "../src/archive-reduction-queue";

const { db, sql } = createClient({ max: 3 });
const PREFIX = `archive-queue-${process.pid}-${Date.now().toString(36)}`;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let airfoilId = "";
let bcId = "";
let solverFixture: MinimalSolverFixture | null = null;
let setup: {
  revisionId: string;
  presetId: string;
  flowConditionId: string;
  referenceGeometryProfileId: string;
  reynolds: number;
  mach: number | null;
} | null = null;
const fixtureResultIds: string[] = [];
const fixtureBlobIds: string[] = [];
const fixtureCampaignIds: string[] = [];
const fixtureReducerVersionIds: string[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function createExactArchiveFixture(label: string) {
  const aoaDeg = 9_000 + (fixtureResultIds.length + 1) / 1000;
  if (!setup) throw new Error("archive queue solver setup fixture is missing");
  const [result] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
    })
    .returning({ id: results.id });
  if (!result) throw new Error("could not create archive queue result fixture");

  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      converged: true,
      evidencePayload: { fidelity: "urans_precalc" },
    })
    .returning({ id: resultAttempts.id });
  if (!attempt)
    throw new Error("could not create archive queue attempt fixture");
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, result.id));

  const [artifact] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      airfoilId,
      aoaDeg,
      kind: "openfoam_bundle",
      storageKey: `${PREFIX}/${label}/source.tar.zst`,
      mimeType: "application/zstd",
      sha256: SHA_A,
      byteSize: 101,
      metadata: {},
    })
    .returning({ id: solverEvidenceArtifacts.id });
  if (!artifact)
    throw new Error("could not create archive queue artifact fixture");

  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "archive-queue-test-bucket",
      objectKey: `${PREFIX}/${label}/evidence.tar.zst`,
      generation: `${1_000_000 + fixtureBlobIds.length}`,
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: SHA_A,
      byteSize: 101,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: SHA_B,
      uncompressedTarByteSize: 202,
      verifiedAt: new Date(),
      metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    })
    .returning({ id: solverEvidenceBlobs.id });
  if (!blob) throw new Error("could not create archive queue blob fixture");

  const [archive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      sourceArtifactId: artifact.id,
      blobId: blob.id,
      state: "current",
    })
    .returning({ id: solverEvidenceArchives.id });
  if (!archive)
    throw new Error("could not create archive queue archive fixture");

  fixtureResultIds.push(result.id);
  fixtureBlobIds.push(blob.id);
  return {
    resultId: result.id,
    resultAttemptId: attempt.id,
    sourceArchiveId: archive.id,
    aoaDeg,
  };
}

function cleanCycle(index: number, disposition: "startup" | "selected") {
  return {
    index,
    t_start: 10 + index * 0.137,
    t_end: 10 + (index + 1) * 0.137,
    coefficient_samples: 20,
    field_frames: 20,
    phase_max_gap: 0.02,
    phase_shift_bins: 1,
    cl_mean: 0.8,
    cd_mean: 0.02,
    cm_mean: -0.1,
    cl_shape_error: 0.02,
    cd_shape_error: 0.02,
    cm_shape_error: 0.02,
    cl_amplitude_deviation: 0.02,
    cd_amplitude_deviation: 0.02,
    cm_amplitude_deviation: 0.02,
    cl_high_frequency: 0.01,
    cd_high_frequency: 0.01,
    cm_high_frequency: 0.01,
    disposition,
    reasons: [] as string[],
  };
}

/** A certificate-valid response is important here: the test proves the real
 * queue → child → stage → selector path, not a mocked selection shortcut. */
function acceptedReduction(input: {
  aoaDeg: number;
  signature?: string;
}): ArchiveCleanCycleReductionResponse {
  return {
    state: "accepted",
    inputEvidenceSignature: input.signature ?? "c".repeat(64),
    point: {
      aoa_deg: input.aoaDeg,
      cl: 0.8,
      cd: 0.02,
      cm: -0.1,
      cl_cd: 40,
      cl_std: 0.01,
      cd_std: 0.001,
      cm_std: 0.005,
      unsteady: true,
      converged: true,
      first_order_fallback: false,
      images: {},
      urans_cycle_certificate: {
        reducer_version: URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
        period_s: 0.137,
        phase_samples: 96,
        required_clean_cycles: 3,
        terminal_clean_cycles: 3,
        selected_cycle_start_index: 1,
        certified: true,
        cadence_adjusted: false,
        cycles: [
          cleanCycle(0, "startup"),
          cleanCycle(1, "selected"),
          cleanCycle(2, "selected"),
          cleanCycle(3, "selected"),
        ],
      },
    },
    diagnostics: { source: "archive-queue-integration" },
  };
}

function engineReturning(
  response: ArchiveCleanCycleReductionResponse,
): EngineClient {
  return {
    reduceRemoteEvidenceCleanCycles: async () => response,
  } as unknown as EngineClient;
}

async function attachCampaignPoint(fixture: {
  resultId: string;
  resultAttemptId: string;
  aoaDeg: number;
}) {
  if (!setup) throw new Error("archive queue solver setup fixture is missing");
  const suffix = `${fixtureCampaignIds.length + 1}`;
  const [campaign] = await db
    .insert(simCampaigns)
    .values({
      slug: `${PREFIX}-campaign-${suffix}`,
      name: `${PREFIX} archive queue publication ${suffix}`,
      idempotencyKey: `${PREFIX}-campaign-${suffix}`,
      status: "active",
    })
    .returning({ id: simCampaigns.id });
  if (!campaign)
    throw new Error("could not create archive queue campaign fixture");
  fixtureCampaignIds.push(campaign.id);
  const [plan] = await db
    .insert(simCampaignPlanRevisions)
    .values({
      campaignId: campaign.id,
      revisionNumber: 1,
      kind: "initial",
      plan: { fixture: PREFIX },
      summary: { fixture: PREFIX },
      createdBy: "test:archive-reduction-queue",
    })
    .returning({ id: simCampaignPlanRevisions.id });
  if (!plan)
    throw new Error("could not create archive queue campaign plan fixture");
  await db
    .update(simCampaigns)
    .set({ currentPlanRevisionId: plan.id })
    .where(eq(simCampaigns.id, campaign.id));
  const [condition] = await db
    .insert(simCampaignConditions)
    .values({
      campaignId: campaign.id,
      ord: 0,
      generation: 1,
      flowConditionId: setup.flowConditionId,
      referenceGeometryProfileId: setup.referenceGeometryProfileId,
      presetId: setup.presetId,
      simulationPresetRevisionId: setup.revisionId,
      reynolds: setup.reynolds,
      mach: setup.mach,
      status: "active",
      introducedInPlanRevisionId: plan.id,
    })
    .returning({ id: simCampaignConditions.id });
  if (!condition)
    throw new Error(
      "could not create archive queue campaign condition fixture",
    );
  await db.insert(simCampaignPoints).values({
    campaignId: campaign.id,
    conditionId: condition.id,
    airfoilId,
    aoaDeg: fixture.aoaDeg,
    revisionId: setup.revisionId,
    planRevisionNumber: 1,
    state: "terminal",
    resultId: fixture.resultId,
    resultAttemptId: fixture.resultAttemptId,
    derivedBySymmetry: false,
  });
  await db.insert(resultClassifications).values({
    resultId: fixture.resultId,
    resultAttemptId: fixture.resultAttemptId,
    airfoilId,
    simulationPresetRevisionId: setup.revisionId,
    aoaDeg: fixture.aoaDeg,
    regime: "urans",
    classifierVersion: `${PREFIX}-classification`,
    state: "accepted",
    region: "attached",
    confidence: 1,
    reasons: [],
  });
  return { campaignId: campaign.id, conditionId: condition.id };
}

beforeAll(async () => {
  solverFixture = await createMinimalSolverFixture(db, PREFIX);
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  const [resolvedSetup] = await db
    .select({
      revisionId: simulationPresetRevisions.id,
      presetId: simulationPresets.id,
      flowConditionId: simulationPresets.flowConditionId,
      referenceGeometryProfileId: simulationPresets.referenceGeometryProfileId,
      reynolds: simulationPresetRevisions.reynolds,
      mach: simulationPresetRevisions.mach,
    })
    .from(simulationPresetRevisions)
    .innerJoin(
      simulationPresets,
      eq(simulationPresets.id, simulationPresetRevisions.presetId),
    )
    .where(eq(simulationPresetRevisions.id, solverFixture.revisionId))
    .limit(1);
  if (!airfoil || !resolvedSetup) {
    throw new Error(
      "seeded airfoil/solver setup fixture is required for archive queue integration",
    );
  }
  airfoilId = airfoil.id;
  bcId = solverFixture.bcId;
  setup = resolvedSetup;
});

afterAll(async () => {
  for (const id of fixtureCampaignIds) {
    await db.delete(simCampaigns).where(eq(simCampaigns.id, id));
  }
  // The result delete cascades the queue/interpretation evidence, but runs and
  // test-only V2 reducer rows are intentionally durable tables. Capture and
  // remove only our exact child runs/releases in dependency order.
  const backfillRunIds = fixtureResultIds.length
    ? (
        await db
          .select({ backfillRunId: resultArchiveReductionQueue.backfillRunId })
          .from(resultArchiveReductionQueue)
          .where(
            inArray(resultArchiveReductionQueue.resultId, fixtureResultIds),
          )
      )
        .map((row) => row.backfillRunId)
        .filter((id): id is string => id != null)
    : [];
  if (fixtureResultIds.length) {
    await db.delete(results).where(eq(results.id, fixtureResultIds[0]));
    for (const id of fixtureResultIds.slice(1)) {
      await db.delete(results).where(eq(results.id, id));
    }
  }
  if (fixtureBlobIds.length) {
    await db
      .delete(solverEvidenceBlobs)
      .where(eq(solverEvidenceBlobs.id, fixtureBlobIds[0]));
    for (const id of fixtureBlobIds.slice(1)) {
      await db
        .delete(solverEvidenceBlobs)
        .where(eq(solverEvidenceBlobs.id, id));
    }
  }
  // Result deletion cascades queue receipts, selected interpretations and
  // backfill items (and therefore releases the run's RESTRICT references).
  // Only then may this test remove its exact durable run rows.
  if (backfillRunIds.length) {
    await db
      .delete(resultInterpretationBackfillRuns)
      .where(
        inArray(resultInterpretationBackfillRuns.id, [
          ...new Set(backfillRunIds),
        ]),
      );
  }
  if (fixtureReducerVersionIds.length) {
    await db
      .delete(resultReducerVersions)
      .where(inArray(resultReducerVersions.id, fixtureReducerVersionIds));
  }
  await solverFixture?.cleanup();
  await sql.end();
});

describe("archive reduction publication queue", () => {
  it("durably admits, leases, retries, and releases an exact archive receipt", async () => {
    const fixture = await createExactArchiveFixture("lease-retry");
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);
    expect(admission.admittedResultAttemptIds).toEqual([
      fixture.resultAttemptId,
    ]);

    const gate = deferred<never>();
    const entered = deferred<void>();
    const engine = {
      reduceRemoteEvidenceCleanCycles: async () => {
        entered.resolve();
        return gate.promise;
      },
    } as unknown as EngineClient;
    const drain = drainArchiveReductionQueue(db, engine, {
      enqueue: false,
      resultAttemptIds: [fixture.resultAttemptId],
      maxItems: 1,
    });
    await entered.promise;

    const leased = await waitFor(async () => {
      const [row] = await db
        .select({
          state: resultArchiveReductionQueue.state,
          claimToken: resultArchiveReductionQueue.claimToken,
          claimExpiresAt: resultArchiveReductionQueue.claimExpiresAt,
          attemptCount: resultArchiveReductionQueue.attemptCount,
        })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
        )
        .limit(1);
      return row?.state === "hydrating" && row.claimToken && row.claimExpiresAt
        ? row
        : null;
    }, "archive reduction queue did not persist its hydrating lease");
    expect(leased.attemptCount).toBe(1);
    expect(leased.claimToken).toBeTruthy();
    expect(leased.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    gate.reject(new EngineTimeoutError("test archive reducer timeout", 1));
    await drain;
    const [retried] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        claimToken: resultArchiveReductionQueue.claimToken,
        claimExpiresAt: resultArchiveReductionQueue.claimExpiresAt,
        lastError: resultArchiveReductionQueue.lastError,
        nextAttemptAt: resultArchiveReductionQueue.nextAttemptAt,
      })
      .from(resultArchiveReductionQueue)
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      )
      .limit(1);
    expect(retried).toMatchObject({
      state: "pending",
      claimToken: null,
      claimExpiresAt: null,
      lastError: expect.stringContaining("test archive reducer timeout"),
    });
    expect(retried?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("fences an expired parent and child claimant before it can stage or publish", async () => {
    const fixture = await createExactArchiveFixture("expired-claim-fence");
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    const firstEntered = deferred<void>();
    const firstReduction = deferred<ArchiveCleanCycleReductionResponse>();
    const firstDrain = drainArchiveReductionQueue(
      db,
      {
        reduceRemoteEvidenceCleanCycles: async () => {
          firstEntered.resolve();
          return firstReduction.promise;
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    await firstEntered.promise;

    const firstClaims = await waitFor(async () => {
      const [[queue], [child]] = await Promise.all([
        db
          .select({
            id: resultArchiveReductionQueue.id,
            backfillRunId: resultArchiveReductionQueue.backfillRunId,
            claimToken: resultArchiveReductionQueue.claimToken,
            claimExpiresAt: resultArchiveReductionQueue.claimExpiresAt,
          })
          .from(resultArchiveReductionQueue)
          .where(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              fixture.resultAttemptId,
            ),
          )
          .limit(1),
        db
          .select({
            id: resultInterpretationBackfillItems.id,
            claimToken: resultInterpretationBackfillItems.claimToken,
            claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
          })
          .from(resultInterpretationBackfillItems)
          .where(
            eq(
              resultInterpretationBackfillItems.resultAttemptId,
              fixture.resultAttemptId,
            ),
          )
          .limit(1),
      ]);
      return queue?.backfillRunId &&
        queue.claimToken &&
        queue.claimExpiresAt &&
        child?.claimToken &&
        child.claimExpiresAt
        ? { queue, child }
        : null;
    }, "first archive reducer did not persist both parent and child leases");

    // Simulate a process pause longer than both leases. The next drainer must
    // own new parent and child tokens before the old reducer response returns.
    const expiredAt = new Date(Date.now() - 1_000);
    await Promise.all([
      db
        .update(resultArchiveReductionQueue)
        .set({ claimExpiresAt: expiredAt })
        .where(eq(resultArchiveReductionQueue.id, firstClaims.queue.id)),
      db
        .update(resultInterpretationBackfillItems)
        .set({ claimExpiresAt: expiredAt })
        .where(eq(resultInterpretationBackfillItems.id, firstClaims.child.id)),
    ]);

    const secondEntered = deferred<void>();
    const secondReduction = deferred<ArchiveCleanCycleReductionResponse>();
    const secondDrain = drainArchiveReductionQueue(
      db,
      {
        reduceRemoteEvidenceCleanCycles: async () => {
          secondEntered.resolve();
          return secondReduction.promise;
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    await secondEntered.promise;

    const secondClaims = await waitFor(async () => {
      const [[queue], [child]] = await Promise.all([
        db
          .select({
            claimToken: resultArchiveReductionQueue.claimToken,
            claimExpiresAt: resultArchiveReductionQueue.claimExpiresAt,
          })
          .from(resultArchiveReductionQueue)
          .where(eq(resultArchiveReductionQueue.id, firstClaims.queue.id))
          .limit(1),
        db
          .select({
            claimToken: resultInterpretationBackfillItems.claimToken,
            claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.id, firstClaims.child.id))
          .limit(1),
      ]);
      return queue?.claimToken &&
        queue.claimToken !== firstClaims.queue.claimToken &&
        queue.claimExpiresAt &&
        child?.claimToken &&
        child.claimToken !== firstClaims.child.claimToken &&
        child.claimExpiresAt
        ? { queue, child }
        : null;
    }, "second archive reducer did not replace both expired lease tokens");
    expect(secondClaims.queue.claimExpiresAt?.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(secondClaims.child.claimExpiresAt?.getTime()).toBeGreaterThan(
      Date.now(),
    );

    // Resolve the first reducer only after the second claimant owns both
    // rows. It must not leave an immutable staged interpretation or a live
    // result pointer behind; only the new owner is allowed to publish.
    firstReduction.resolve(acceptedReduction({ aoaDeg: fixture.aoaDeg }));
    await firstDrain;
    const [[staleInterpretation], [beforePublication]] = await Promise.all([
      db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(
          and(
            eq(resultInterpretations.resultAttemptId, fixture.resultAttemptId),
            eq(resultInterpretations.sourceArchiveId, fixture.sourceArchiveId),
          ),
        )
        .limit(1),
      db
        .select({
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
    ]);
    expect(staleInterpretation).toBeUndefined();
    expect(beforePublication).toEqual({
      currentResultInterpretationId: null,
      currentCanonicalSelectionId: null,
    });

    secondReduction.resolve(acceptedReduction({ aoaDeg: fixture.aoaDeg }));
    await secondDrain;
    const [[published], [afterPublication]] = await Promise.all([
      db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(
          and(
            eq(resultInterpretations.resultAttemptId, fixture.resultAttemptId),
            eq(resultInterpretations.sourceArchiveId, fixture.sourceArchiveId),
          ),
        )
        .limit(1),
      db
        .select({
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
    ]);
    expect(published?.id).toBeTruthy();
    expect(afterPublication).toMatchObject({
      currentResultInterpretationId: published?.id,
    });
    expect(afterPublication?.currentCanonicalSelectionId).toBeTruthy();
  });

  it("drains an accepted archive through canonical selection and settles its linked campaign progress", async () => {
    const fixture = await createExactArchiveFixture("success-selection");
    const campaign = await attachCampaignPoint(fixture);
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    const report = await drainArchiveReductionQueue(
      db,
      engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(report.processed).toBe(1);

    const [[queue], [result], [progress]] = await Promise.all([
      db
        .select({
          state: resultArchiveReductionQueue.state,
          resultInterpretationId:
            resultArchiveReductionQueue.resultInterpretationId,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
        })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
        )
        .limit(1),
      db
        .select({
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
      db
        .select({
          requested: simCampaignProgress.requested,
          solved: simCampaignProgress.solved,
          awaitingArchiveReduction:
            simCampaignProgress.awaitingArchiveReduction,
          blocked: simCampaignProgress.blocked,
        })
        .from(simCampaignProgress)
        .where(
          and(
            eq(simCampaignProgress.campaignId, campaign.campaignId),
            eq(simCampaignProgress.conditionId, campaign.conditionId),
            eq(simCampaignProgress.airfoilId, airfoilId),
          ),
        )
        .limit(1),
    ]);
    expect(queue).toMatchObject({ state: "reduced" });
    expect(queue?.backfillRunId).toBeTruthy();
    expect(queue?.resultInterpretationId).toBeTruthy();
    expect(result).toMatchObject({
      currentResultInterpretationId: queue?.resultInterpretationId,
    });
    expect(result?.currentCanonicalSelectionId).toBeTruthy();
    // This proves the real non-solver publication transition refreshes the
    // exact campaign cell rather than leaving it in "awaiting reduction".
    expect(progress).toEqual({
      requested: 1,
      solved: 1,
      awaitingArchiveReduction: 0,
      blocked: 0,
    });
  });

  it("does not re-admit V1 after a later V2 receipt has been persisted", async () => {
    const fixture = await createExactArchiveFixture("reducer-precedence");
    const firstAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const v1 = firstAdmission.reducerVersionId;
    await db
      .delete(resultArchiveReductionQueue)
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(resultArchiveReductionQueue.reducerVersionId, v1),
        ),
      );
    const [v1Row] = await db
      .select({ reducerKey: resultReducerVersions.reducerKey })
      .from(resultReducerVersions)
      .where(eq(resultReducerVersions.id, v1))
      .limit(1);
    if (!v1Row)
      throw new Error("archive queue V1 reducer fixture was not found");
    const [v2] = await db
      .insert(resultReducerVersions)
      .values({
        reducerKey: v1Row.reducerKey,
        reducerVersion: `${PREFIX}-v2`,
        buildId: `${PREFIX}-build-v2`,
        policySha256: "c".repeat(64),
        policy: { regression: "queue-v1-v2" },
        source: "test",
        createdAt: new Date(Date.now() + 1_000),
      })
      .returning({ id: resultReducerVersions.id });
    if (!v2) throw new Error("could not create V2 reducer fixture");
    fixtureReducerVersionIds.push(v2.id);
    await db.insert(resultArchiveReductionQueue).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      sourceArchiveId: fixture.sourceArchiveId,
      reducerVersionId: v2.id,
      state: "pending",
    });

    const staleAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(staleAdmission.enqueued).toBe(0);
    expect(staleAdmission.admittedResultAttemptIds).toEqual([]);
    const rows = await db
      .select({
        reducerVersionId: resultArchiveReductionQueue.reducerVersionId,
      })
      .from(resultArchiveReductionQueue)
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      );
    expect(rows).toEqual([{ reducerVersionId: v2.id }]);
  });

  it("cannot let an old V1 worker overwrite a V2 canonical selection that completed first", async () => {
    const fixture = await createExactArchiveFixture("stale-v1-after-v2");
    const firstAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const v1 = firstAdmission.reducerVersionId;
    const [v1Row] = await db
      .select({ reducerKey: resultReducerVersions.reducerKey })
      .from(resultReducerVersions)
      .where(eq(resultReducerVersions.id, v1))
      .limit(1);
    if (!v1Row)
      throw new Error("archive queue V1 reducer fixture was not found");
    const [v2] = await db
      .insert(resultReducerVersions)
      .values({
        reducerKey: v1Row.reducerKey,
        reducerVersion: `${PREFIX}-stale-v1-v2`,
        buildId: `${PREFIX}-stale-v1-build-v2`,
        policySha256: "d".repeat(64),
        policy: { regression: "stale-v1-after-v2-selection" },
        source: "test",
        createdAt: new Date(Date.now() + 1_000),
      })
      .returning({ id: resultReducerVersions.id });
    if (!v2) throw new Error("could not create V2 reducer fixture");
    fixtureReducerVersionIds.push(v2.id);

    // V1 was admitted first but cannot be claimed yet; V2 is the later
    // release and completes first.  This models the real race where an old
    // reducer has already been queued while a rollout adds V2.
    await db
      .update(resultArchiveReductionQueue)
      .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(resultArchiveReductionQueue.reducerVersionId, v1),
        ),
      );
    await db.insert(resultArchiveReductionQueue).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      sourceArchiveId: fixture.sourceArchiveId,
      reducerVersionId: v2.id,
      state: "pending",
      nextAttemptAt: new Date(),
    });

    await drainArchiveReductionQueue(
      db,
      engineReturning(
        acceptedReduction({
          aoaDeg: fixture.aoaDeg,
          signature: "e".repeat(64),
        }),
      ),
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    const [afterV2] = await db
      .select({
        currentResultInterpretationId: results.currentResultInterpretationId,
        currentCanonicalSelectionId: results.currentCanonicalSelectionId,
      })
      .from(results)
      .where(eq(results.id, fixture.resultId))
      .limit(1);
    expect(afterV2?.currentResultInterpretationId).toBeTruthy();
    expect(afterV2?.currentCanonicalSelectionId).toBeTruthy();

    // Let the already-admitted V1 worker finish after V2. Its immutable
    // historical interpretation may be retained, but the selector must see
    // V2's exact receipt/selection and refuse to retarget the projection.
    await db
      .update(resultArchiveReductionQueue)
      .set({ nextAttemptAt: new Date() })
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(resultArchiveReductionQueue.reducerVersionId, v1),
        ),
      );
    await drainArchiveReductionQueue(
      db,
      engineReturning(
        acceptedReduction({
          aoaDeg: fixture.aoaDeg,
          signature: "f".repeat(64),
        }),
      ),
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    const [[afterV1], [v1Queue]] = await Promise.all([
      db
        .select({
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
      db
        .select({
          state: resultArchiveReductionQueue.state,
          resultInterpretationId:
            resultArchiveReductionQueue.resultInterpretationId,
          lastError: resultArchiveReductionQueue.lastError,
        })
        .from(resultArchiveReductionQueue)
        .where(
          and(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              fixture.resultAttemptId,
            ),
            eq(resultArchiveReductionQueue.reducerVersionId, v1),
          ),
        )
        .limit(1),
    ]);
    expect(afterV1).toEqual(afterV2);
    expect(v1Queue).toMatchObject({
      state: "superseded",
      lastError: expect.stringContaining("older reducer release"),
    });
    expect(v1Queue?.resultInterpretationId).toBeTruthy();
  });

  it("supersedes only the recovered source receipt and clears its lease", async () => {
    const fixture = await createExactArchiveFixture("recovery-supersession");
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const changed = await supersedeArchiveReductionQueueForRecoveredAction(db, {
      ...fixture,
      reason: "integration recovery published a later accepted generation",
    });
    expect(changed).toBe(1);
    const [row] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        claimToken: resultArchiveReductionQueue.claimToken,
        claimExpiresAt: resultArchiveReductionQueue.claimExpiresAt,
      })
      .from(resultArchiveReductionQueue)
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      )
      .limit(1);
    expect(row).toEqual({
      state: "superseded",
      claimToken: null,
      claimExpiresAt: null,
    });
  });
});
