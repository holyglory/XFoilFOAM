/**
 * Durable queue integration coverage.  The pure policy suite covers the
 * ordering math; this suite proves the database receipt/lease transitions
 * against the real 0098/0099 schema.
 */
import {
  airfoils,
  createClient,
  type DB,
  resultArchiveReductionQueue,
  resultAttempts,
  resultCanonicalSelections,
  resultClassifications,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretations,
  resultMedia,
  resultReducerVersions,
  results,
  satisfyPrecalcObligationFromAcceptedResult,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simJobs,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simSolverIncidentCampaigns,
  simSolverIncidents,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import {
  EngineError,
  EngineTimeoutError,
  type ArchiveCleanCycleReductionResponse,
  type EngineClient,
  URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
} from "@aerodb/engine-client";
import { URANS_BUDGET_STOP_MARKER } from "@aerodb/core";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
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
import { discoverHistoricalUransInventory } from "../src/historical-urans-inventory";
import {
  createArchiveInterpretationBackfillRun,
  discoverExactArchiveInterpretationBackfillCandidate,
} from "../src/result-interpretation-backfill";

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
const fixtureJobIds: string[] = [];
const fixturePrecalcObligationIds: string[] = [];

/**
 * Reducer versions are intentionally append-only production scientific
 * identity.  The two precedence regressions need a newer version, but must
 * not leave that newer release behind to suppress ordinary V1 admissions in
 * later shared-DB tests.  Exercise the real nested queue transactions inside
 * one outer transaction, then deliberately roll it back.
 */
class RollbackIntegrationFixture extends Error {}

async function withRolledBackFixture<T>(
  work: (tx: DB) => Promise<T>,
): Promise<T> {
  let value!: T;
  try {
    await db.transaction(async (rawTx) => {
      value = await work(rawTx as unknown as DB);
      throw new RollbackIntegrationFixture();
    });
  } catch (error) {
    if (!(error instanceof RollbackIntegrationFixture)) throw error;
  }
  return value;
}

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

/** Prove the queue's second, locked publication-state read is really waiting
 * behind the concurrent result mutation. A sleep here would make the
 * released-to-live race non-deterministic and could let the regression pass
 * without exercising the recheck. */
async function waitForResultPublicationLockWait(
  blockingPid: number,
  message: string,
): Promise<void> {
  await waitFor(async () => {
    const rows = (await db.execute(drizzleSql`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND ${blockingPid} = ANY(pg_blocking_pids(pid))
      LIMIT 1
    `)) as unknown as Array<{ pid: number }>;
    return rows.length ? (rows[0] ?? null) : null;
  }, message);
}

async function createExactArchiveFixture(
  label: string,
  client: DB = db,
  opts: { withPrecalcJob?: boolean } = {},
) {
  const aoaDeg = 9_000 + (fixtureResultIds.length + 1) / 1000;
  if (!setup) throw new Error("archive queue solver setup fixture is missing");
  const [job] = opts.withPrecalcJob
    ? await client
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: setup.revisionId,
          solverImplementationId: solverFixture?.solverImplementationId,
          referenceChordM: 0.2,
          wave: 2,
          status: "done",
          engineJobId: `${PREFIX}-${label}-precalc`,
          totalCases: 1,
          completedCases: 1,
          requestPayload: { aoas: [aoaDeg], uransFidelity: "precalc" },
        })
        .returning({ id: simJobs.id })
    : [undefined];
  if (job) fixtureJobIds.push(job.id);
  const [result] = await client
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: setup.revisionId,
      solverImplementationId: solverFixture?.solverImplementationId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      fidelity: "urans_precalc",
      simJobId: job?.id,
    })
    .returning({ id: results.id });
  if (!result) throw new Error("could not create archive queue result fixture");

  const [attempt] = await client
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: setup.revisionId,
      solverImplementationId: solverFixture?.solverImplementationId,
      aoaDeg,
      simJobId: job?.id,
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
  await client
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, result.id));

  const [artifact] = await client
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

  // Archive selection authenticates the raw coefficients, but it must never
  // invent the independently persisted URANS video. Model the solver's real
  // finalized media artifact on this exact immutable attempt.
  await client.insert(resultMedia).values({
    resultId: result.id,
    resultAttemptId: attempt.id,
    kind: "video",
    field: "velocity_magnitude",
    role: "instantaneous",
    storageKey: `${PREFIX}/${label}/velocity_magnitude.mp4`,
    mimeType: "video/mp4",
    sha256: SHA_B,
    byteSize: 101,
  });

  const [blob] = await client
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

  const [archive] = await client
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
    simJobId: job?.id,
  };
}

/** Create a second immutable delivery for the same exact PRECALC job.  The
 * reducer must use stable attempt-generation precedence rather than queue
 * claim or engine-completion order when both deliveries are archive-ready. */
async function createSiblingArchiveAttempt(
  fixture: {
    resultId: string;
    aoaDeg: number;
    simJobId?: string;
  },
  label: string,
  opts: { createdAt: Date; archiveMimeType?: string },
) {
  if (!setup || !fixture.simJobId) {
    throw new Error("sibling archive attempt needs an exact PRECALC job");
  }
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: fixture.resultId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: setup.revisionId,
      solverImplementationId: solverFixture?.solverImplementationId,
      aoaDeg: fixture.aoaDeg,
      simJobId: fixture.simJobId,
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      converged: true,
      evidencePayload: { fidelity: "urans_precalc" },
      createdAt: opts.createdAt,
    })
    .returning({ id: resultAttempts.id });
  if (!attempt) throw new Error("could not create sibling archive attempt");

  const [artifact] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: fixture.resultId,
      resultAttemptId: attempt.id,
      airfoilId,
      aoaDeg: fixture.aoaDeg,
      kind: "openfoam_bundle",
      storageKey: `${PREFIX}/${label}/source.tar.zst`,
      mimeType: "application/zstd",
      sha256: SHA_A,
      byteSize: 101,
      metadata: {},
    })
    .returning({ id: solverEvidenceArtifacts.id });
  if (!artifact) throw new Error("could not create sibling archive artifact");
  await db.insert(resultMedia).values({
    resultId: fixture.resultId,
    resultAttemptId: attempt.id,
    kind: "video",
    field: "velocity_magnitude",
    role: "instantaneous",
    storageKey: `${PREFIX}/${label}/velocity_magnitude.mp4`,
    mimeType: "video/mp4",
    sha256: SHA_B,
    byteSize: 101,
  });
  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "archive-queue-test-bucket",
      objectKey: `${PREFIX}/${label}/evidence.tar.zst`,
      generation: `${1_000_000 + fixtureBlobIds.length}`,
      compression: "zstd",
      mimeType: opts.archiveMimeType ?? "application/zstd",
      sha256: SHA_A,
      byteSize: 101,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: SHA_B,
      uncompressedTarByteSize: 202,
      verifiedAt: new Date(),
      metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    })
    .returning({ id: solverEvidenceBlobs.id });
  if (!blob) throw new Error("could not create sibling archive blob");
  const [archive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId: fixture.resultId,
      resultAttemptId: attempt.id,
      sourceArtifactId: artifact.id,
      blobId: blob.id,
      state: "current",
    })
    .returning({ id: solverEvidenceArchives.id });
  if (!archive) throw new Error("could not create sibling evidence archive");
  fixtureBlobIds.push(blob.id);
  return { resultAttemptId: attempt.id, sourceArchiveId: archive.id };
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
    healthDetails: async () => ({
      status: "ok",
      version: "archive-reducer-v1",
      archive_reduction_version: 2,
    }),
    reduceRemoteEvidenceCleanCycles: async () => response,
  } as unknown as EngineClient;
}

async function attachCampaignPoint(
  fixture: {
    resultId: string;
    resultAttemptId: string;
    aoaDeg: number;
  },
  client: DB = db,
) {
  if (!setup) throw new Error("archive queue solver setup fixture is missing");
  const suffix = `${fixtureCampaignIds.length + 1}`;
  const [campaign] = await client
    .insert(simCampaigns)
    .values({
      slug: `${PREFIX}-campaign-${suffix}`,
      name: `${PREFIX} archive queue publication ${suffix}`,
      idempotencyKey: `${PREFIX}-campaign-${suffix}`,
      status: "active",
      currentConditionGeneration: 1,
    })
    .returning({ id: simCampaigns.id });
  if (!campaign)
    throw new Error("could not create archive queue campaign fixture");
  fixtureCampaignIds.push(campaign.id);
  const [plan] = await client
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
  await client
    .update(simCampaigns)
    .set({ currentPlanRevisionId: plan.id })
    .where(eq(simCampaigns.id, campaign.id));
  const [condition] = await client
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
  await client.insert(simCampaignPoints).values({
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
  return { campaignId: campaign.id, conditionId: condition.id };
}

async function attachExactLivePrecalcOwner(fixture: {
  resultId: string;
  resultAttemptId: string;
  aoaDeg: number;
  simJobId?: string;
}) {
  if (!fixture.simJobId || !setup) {
    throw new Error("exact PRECALC owner fixture is missing its job setup");
  }
  const { campaignId } = await attachCampaignPoint(fixture);
  const [obligation] = await db
    .insert(simPrecalcObligations)
    .values({
      airfoilId,
      revisionId: setup.revisionId,
      aoaDeg: fixture.aoaDeg,
      state: "blocked",
      attemptCount: 2,
      maxAttempts: 2,
      latestSimJobId: fixture.simJobId,
      lastOutcome: "rejected_exhausted",
      lastError: "fixture archive owner awaiting selection",
    })
    .returning({ id: simPrecalcObligations.id });
  if (!obligation) throw new Error("could not create exact PRECALC owner");
  fixturePrecalcObligationIds.push(obligation.id);
  await db.insert(simPrecalcObligationCampaigns).values({
    obligationId: obligation.id,
    campaignId,
    state: "active",
  });
  return { campaignId, obligationId: obligation.id };
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
    ? await Promise.all([
        db
          .select({ backfillRunId: resultArchiveReductionQueue.backfillRunId })
          .from(resultArchiveReductionQueue)
          .where(
            inArray(resultArchiveReductionQueue.resultId, fixtureResultIds),
          ),
        // A released queue receipt deliberately detaches a child that failed
        // only because publication was no longer live. Preserve that child as
        // forensic history during the test, then include it in cleanup even
        // though the queue no longer points at its run.
        db
          .select({ runId: resultInterpretationBackfillItems.runId })
          .from(resultInterpretationBackfillItems)
          .where(
            inArray(
              resultInterpretationBackfillItems.resultId,
              fixtureResultIds,
            ),
          ),
      ]).then(([queueRows, childRows]) => [
        ...queueRows.map((row) => row.backfillRunId),
        ...childRows.map((row) => row.runId),
      ])
    : [];
  if (fixturePrecalcObligationIds.length) {
    await db
      .delete(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, fixturePrecalcObligationIds));
  }
  if (fixtureResultIds.length) {
    await db.delete(results).where(eq(results.id, fixtureResultIds[0]));
    for (const id of fixtureResultIds.slice(1)) {
      await db.delete(results).where(eq(results.id, id));
    }
  }
  if (fixtureJobIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.id, fixtureJobIds));
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
          ...new Set(backfillRunIds.filter((id): id is string => id != null)),
        ]),
      );
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
      healthDetails: async () => ({
        status: "ok",
        version: "archive-reducer-v1",
        archive_reduction_version: 2,
      }),
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

  it("MUST-CATCH: native fetch failures retry, while answered 4xx and contract failures stay terminal", async () => {
    const nativeFetchFixture =
      await createExactArchiveFixture("native-fetch-retry");
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [nativeFetchFixture.resultAttemptId],
      limit: 1,
    });
    let nativeFetchCalls = 0;
    const nativeFetchEngine = {
      healthDetails: async () => ({
        status: "ok",
        version: "archive-reducer-v1",
        archive_reduction_version: 2,
      }),
      reduceRemoteEvidenceCleanCycles: async () => {
        nativeFetchCalls += 1;
        throw new TypeError("fetch failed");
      },
    } as unknown as EngineClient;
    await drainArchiveReductionQueue(
      db,
      nativeFetchEngine,
      {
        enqueue: false,
        resultAttemptIds: [nativeFetchFixture.resultAttemptId],
        maxItems: 1,
      },
    );
    const [nativeFetchQueue] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        attemptCount: resultArchiveReductionQueue.attemptCount,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        lastError: resultArchiveReductionQueue.lastError,
      })
      .from(resultArchiveReductionQueue)
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          nativeFetchFixture.resultAttemptId,
        ),
      )
      .limit(1);
    expect(nativeFetchQueue).toMatchObject({
      state: "pending",
      attemptCount: 1,
      lastError: "fetch failed",
    });
    expect(nativeFetchQueue?.backfillRunId).toBeTruthy();
    expect(
      await db
        .select({
          state: resultInterpretationBackfillItems.state,
          attemptCount: resultInterpretationBackfillItems.attemptCount,
          lastError: resultInterpretationBackfillItems.lastError,
        })
        .from(resultInterpretationBackfillItems)
        .where(
          eq(
            resultInterpretationBackfillItems.runId,
            nativeFetchQueue!.backfillRunId!,
          ),
        ),
    ).toEqual([
      { state: "pending", attemptCount: 1, lastError: "fetch failed" },
    ]);
    // Drive the same exact receipt through its remaining allowed attempts.
    // A transport failure must use the child budget, not create a fourth
    // engine call through the parent queue.
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      const due = new Date(0);
      await db
        .update(resultArchiveReductionQueue)
        .set({ nextAttemptAt: due })
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            nativeFetchFixture.resultAttemptId,
          ),
        );
      await db
        .update(resultInterpretationBackfillItems)
        .set({ nextAttemptAt: due })
        .where(
          eq(
            resultInterpretationBackfillItems.runId,
            nativeFetchQueue!.backfillRunId!,
          ),
        );
      await drainArchiveReductionQueue(db, nativeFetchEngine, {
        enqueue: false,
        resultAttemptIds: [nativeFetchFixture.resultAttemptId],
        maxItems: 1,
      });
    }
    expect(nativeFetchCalls).toBe(3);
    expect(
      await db
        .select({
          state: resultArchiveReductionQueue.state,
          attemptCount: resultArchiveReductionQueue.attemptCount,
          lastError: resultArchiveReductionQueue.lastError,
        })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            nativeFetchFixture.resultAttemptId,
          ),
        ),
    ).toEqual([
      { state: "failed", attemptCount: 3, lastError: "fetch failed" },
    ]);
    expect(
      await db
        .select({
          state: resultInterpretationBackfillItems.state,
          attemptCount: resultInterpretationBackfillItems.attemptCount,
          lastError: resultInterpretationBackfillItems.lastError,
        })
        .from(resultInterpretationBackfillItems)
        .where(
          eq(
            resultInterpretationBackfillItems.runId,
            nativeFetchQueue!.backfillRunId!,
          ),
        ),
    ).toEqual([
      { state: "failed", attemptCount: 3, lastError: "fetch failed" },
    ]);
    await drainArchiveReductionQueue(db, nativeFetchEngine, {
      enqueue: false,
      resultAttemptIds: [nativeFetchFixture.resultAttemptId],
      maxItems: 1,
    });
    expect(nativeFetchCalls).toBe(3);

    const answeredFixture = await createExactArchiveFixture(
      "answered-422-terminal",
    );
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [answeredFixture.resultAttemptId],
      limit: 1,
    });
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          throw new EngineError("engine rejected the immutable archive", 422);
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [answeredFixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(
      await db
        .select({ state: resultArchiveReductionQueue.state })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            answeredFixture.resultAttemptId,
          ),
        ),
    ).toEqual([{ state: "missing_evidence" }]);

    const driftFixture = await createExactArchiveFixture(
      "contract-drift-terminal",
    );
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [driftFixture.resultAttemptId],
      limit: 1,
    });
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          throw new EngineError(
            "archive reducer contract drift",
            undefined,
            "archive_reduction_contract_drift",
          );
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [driftFixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(
      await db
        .select({ state: resultArchiveReductionQueue.state })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            driftFixture.resultAttemptId,
          ),
        ),
    ).toEqual([{ state: "failed" }]);
  });

  it("MUST-CATCH: repairs only one preserved first-attempt native-fetch child when its source is still current", async () => {
    const fixture = await createExactArchiveFixture(
      "repair-legacy-native-fetch",
    );
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const originalRun = await createArchiveInterpretationBackfillRun({
      db,
      exactSource: {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
      },
      requestedBy: "test:preserved-native-fetch-child",
    });
    await db
      .update(resultInterpretationBackfillItems)
      .set({
        state: "failed",
        attemptCount: 1,
        lastError: "fetch failed",
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(eq(resultInterpretationBackfillItems.runId, originalRun.runId));
    await db
      .update(resultInterpretationBackfillRuns)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(resultInterpretationBackfillRuns.id, originalRun.runId));
    await db
      .update(resultArchiveReductionQueue)
      .set({
        state: "failed",
        attemptCount: 1,
        lastError: "fetch failed",
        backfillRunId: originalRun.runId,
        resultInterpretationId: null,
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      );

    let reducerCalls = 0;
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          return acceptedReduction({ aoaDeg: fixture.aoaDeg });
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(reducerCalls).toBe(1);
    const [repairedQueue] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        attemptCount: resultArchiveReductionQueue.attemptCount,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        resultInterpretationId:
          resultArchiveReductionQueue.resultInterpretationId,
      })
      .from(resultArchiveReductionQueue)
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      )
      .limit(1);
    expect(repairedQueue).toMatchObject({ state: "reduced" });
    expect(repairedQueue?.backfillRunId).toBeTruthy();
    expect(repairedQueue?.backfillRunId).not.toBe(originalRun.runId);
    expect(repairedQueue?.resultInterpretationId).toBeTruthy();
    expect(
      await db
        .select({
          state: resultInterpretationBackfillItems.state,
          attemptCount: resultInterpretationBackfillItems.attemptCount,
          lastError: resultInterpretationBackfillItems.lastError,
          resultInterpretationId:
            resultInterpretationBackfillItems.resultInterpretationId,
        })
        .from(resultInterpretationBackfillItems)
        .where(eq(resultInterpretationBackfillItems.runId, originalRun.runId)),
    ).toEqual([
      {
        state: "failed",
        attemptCount: 1,
        lastError: "fetch failed",
        resultInterpretationId: null,
      },
    ]);
  });

  it("MUST-CATCH: legacy native-fetch repair refuses a released source", async () => {
    const fixture = await createExactArchiveFixture(
      "repair-legacy-native-fetch-released",
    );
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const originalRun = await createArchiveInterpretationBackfillRun({
      db,
      exactSource: {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
      },
      requestedBy: "test:released-native-fetch-child",
    });
    await db
      .update(resultInterpretationBackfillItems)
      .set({ state: "failed", attemptCount: 1, lastError: "fetch failed" })
      .where(eq(resultInterpretationBackfillItems.runId, originalRun.runId));
    await db
      .update(resultInterpretationBackfillRuns)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(resultInterpretationBackfillRuns.id, originalRun.runId));
    await db
      .update(resultArchiveReductionQueue)
      .set({
        state: "failed",
        attemptCount: 1,
        lastError: "fetch failed",
        backfillRunId: originalRun.runId,
      })
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      );
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, fixture.resultId));

    let reducerCalls = 0;
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          return acceptedReduction({ aoaDeg: fixture.aoaDeg });
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(reducerCalls).toBe(0);
    expect(
      await db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
        })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
        ),
    ).toEqual([{ state: "failed", backfillRunId: originalRun.runId }]);
  });

  it("MUST-CATCH: legacy native-fetch repair refuses a superseded archive while its result remains current", async () => {
    const fixture = await createExactArchiveFixture(
      "repair-legacy-native-fetch-superseded-archive",
    );
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const originalRun = await createArchiveInterpretationBackfillRun({
      db,
      exactSource: {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
      },
      requestedBy: "test:superseded-native-fetch-child",
    });
    await db
      .update(resultInterpretationBackfillItems)
      .set({ state: "failed", attemptCount: 1, lastError: "fetch failed" })
      .where(eq(resultInterpretationBackfillItems.runId, originalRun.runId));
    await db
      .update(resultInterpretationBackfillRuns)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(resultInterpretationBackfillRuns.id, originalRun.runId));
    await db
      .update(resultArchiveReductionQueue)
      .set({
        state: "failed",
        attemptCount: 1,
        lastError: "fetch failed",
        backfillRunId: originalRun.runId,
      })
      .where(
        eq(
          resultArchiveReductionQueue.resultAttemptId,
          fixture.resultAttemptId,
        ),
      );
    await db
      .update(solverEvidenceArchives)
      .set({ state: "superseded", supersededAt: new Date() })
      .where(eq(solverEvidenceArchives.id, fixture.sourceArchiveId));

    const [currentResult] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, fixture.resultId))
      .limit(1);
    expect(currentResult?.currentResultAttemptId).toBe(fixture.resultAttemptId);

    let reducerCalls = 0;
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          return acceptedReduction({ aoaDeg: fixture.aoaDeg });
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );

    expect(reducerCalls).toBe(0);
    expect(
      await db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
        })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
        ),
    ).toEqual([{ state: "failed", backfillRunId: originalRun.runId }]);
  });

  it("MUST-CATCH: legacy native-fetch repair refuses an exact source with a newer staged interpretation", async () => {
    const fixture = await createExactArchiveFixture(
      "repair-legacy-native-fetch-newer-staged-interpretation",
    );
    const currentAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    // Keep this regression about the legacy repair receipt only. The current
    // reducer is represented by the immutable staged row below, rather than
    // by an independently runnable queue item.
    await db
      .delete(resultArchiveReductionQueue)
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(
            resultArchiveReductionQueue.reducerVersionId,
            currentAdmission.reducerVersionId,
          ),
        ),
      );
    await db.insert(resultInterpretations).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      reducerVersionId: currentAdmission.reducerVersionId,
      sourceArchiveId: fixture.sourceArchiveId,
      source: "archive_backfill",
      inputEvidenceSignature: "d".repeat(64),
      state: "terminal_failure",
      regime: "periodic",
      terminalReason: "newer reducer staged exact archive evidence",
      selectedWindow: {},
      statistics: {},
      diagnostics: {},
    });

    const [currentReducer] = await db
      .select({
        reducerKey: resultReducerVersions.reducerKey,
        createdAt: resultReducerVersions.createdAt,
      })
      .from(resultReducerVersions)
      .where(eq(resultReducerVersions.id, currentAdmission.reducerVersionId))
      .limit(1);
    if (!currentReducer) {
      throw new Error("current reducer fixture could not be found");
    }
    const [legacyReducer] = await db
      .insert(resultReducerVersions)
      .values({
        reducerKey: currentReducer.reducerKey,
        reducerVersion: `${PREFIX}-legacy-native-fetch-v1`,
        buildId: `${PREFIX}-legacy-native-fetch-build`,
        policySha256: "e".repeat(64),
        policy: { regression: "legacy-native-fetch-newer-staged" },
        source: "test",
        createdAt: new Date(currentReducer.createdAt.getTime() - 1_000),
      })
      .returning({ id: resultReducerVersions.id });
    if (!legacyReducer) {
      throw new Error("legacy reducer fixture could not be created");
    }
    const originalRun = await createArchiveInterpretationBackfillRun({
      db,
      reducerVersionId: legacyReducer.id,
      exactSource: {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
      },
      requestedBy: "test:newer-staged-native-fetch-child",
    });
    await db
      .update(resultInterpretationBackfillItems)
      .set({
        state: "failed",
        attemptCount: 1,
        lastError: "fetch failed",
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(eq(resultInterpretationBackfillItems.runId, originalRun.runId));
    await db
      .update(resultInterpretationBackfillRuns)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(resultInterpretationBackfillRuns.id, originalRun.runId));
    await db.insert(resultArchiveReductionQueue).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      sourceArchiveId: fixture.sourceArchiveId,
      reducerVersionId: legacyReducer.id,
      state: "failed",
      attemptCount: 1,
      lastError: "fetch failed",
      backfillRunId: originalRun.runId,
    });

    let reducerCalls = 0;
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          return acceptedReduction({ aoaDeg: fixture.aoaDeg });
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );

    expect(reducerCalls).toBe(0);
    expect(
      await db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
        })
        .from(resultArchiveReductionQueue)
        .where(
          and(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              fixture.resultAttemptId,
            ),
            eq(resultArchiveReductionQueue.reducerVersionId, legacyReducer.id),
          ),
        ),
    ).toEqual([{ state: "failed", backfillRunId: originalRun.runId }]);
    expect(
      await db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(
          and(
            eq(resultInterpretations.resultId, fixture.resultId),
            eq(resultInterpretations.resultAttemptId, fixture.resultAttemptId),
            eq(
              resultInterpretations.sourceArchiveId,
              fixture.sourceArchiveId,
            ),
            eq(
              resultInterpretations.reducerVersionId,
              currentAdmission.reducerVersionId,
            ),
          ),
        ),
    ).toHaveLength(1);
  });

  it("MUST-CATCH: normal exact discovery and child-run creation reject released evidence", async () => {
    const fixture = await createExactArchiveFixture(
      "released-normal-exact-discovery",
    );

    // The normal path is intentionally proved inside one rollback-only
    // transaction. It must refuse a fully released result before it can
    // persist an archive_backfill child receipt.
    await withRolledBackFixture(async (tx) => {
      await tx
        .update(results)
        .set({
          currentResultAttemptId: null,
          currentResultInterpretationId: null,
          currentCanonicalSelectionId: null,
        })
        .where(eq(results.id, fixture.resultId));

      const source = {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
      };
      await expect(
        discoverExactArchiveInterpretationBackfillCandidate(tx, source),
      ).resolves.toBeNull();

      const run = await createArchiveInterpretationBackfillRun({
        db: tx,
        exactSource: source,
        requestedBy: "test:released-normal-exact-discovery",
      });
      expect(run.enqueued).toBe(0);

      const items = await tx
        .select({ id: resultInterpretationBackfillItems.id })
        .from(resultInterpretationBackfillItems)
        .where(eq(resultInterpretationBackfillItems.runId, run.runId));
      expect(items).toEqual([]);
    });
  });

  it("MUST-CATCH: a release observed before the queue recheck cannot strand a result reactivated under its lock", async () => {
    const fixture = await createExactArchiveFixture(
      "released-then-live-under-result-lock",
    );
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    // Commit the released state first. The worker's optimistic read must see
    // this state; its subsequent locked recheck will be held until the
    // concurrent writer restores the exact live generation.
    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));

    const { db: lockerDb, sql: lockerSql } = createClient({ max: 1 });
    const locked = deferred<number>();
    const releaseLock = deferred<void>();
    let writer: Promise<unknown> | null = null;
    let drain: Promise<unknown> | null = null;
    let reducerCalls = 0;
    try {
      writer = lockerDb
        .transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          const rows = (await tx.execute(drizzleSql`
            SELECT pg_backend_pid()::integer AS pid
            FROM results
            WHERE id = ${fixture.resultId}
            FOR UPDATE
          `)) as unknown as Array<{ pid: number }>;
          const pid = rows[0]?.pid;
          if (!pid) throw new Error("result-lock fixture did not expose pid");
          locked.resolve(pid);
          await releaseLock.promise;
          await tx
            .update(results)
            .set({ currentResultAttemptId: fixture.resultAttemptId })
            .where(eq(results.id, fixture.resultId));
        })
        .catch((error) => {
          locked.reject(error);
          throw error;
        });
      const blockingPid = await locked.promise;

      drain = drainArchiveReductionQueue(
        db,
        {
          healthDetails: async () => ({
            status: "ok",
            version: "archive-reducer-v1",
            archive_reduction_version: 2,
          }),
          reduceRemoteEvidenceCleanCycles: async () => {
            reducerCalls += 1;
            return acceptedReduction({ aoaDeg: fixture.aoaDeg });
          },
        } as unknown as EngineClient,
        {
          enqueue: false,
          resultAttemptIds: [fixture.resultAttemptId],
          maxItems: 1,
        },
      );
      await waitForResultPublicationLockWait(
        blockingPid,
        "queue did not reach the locked released-evidence recheck",
      );

      releaseLock.resolve(undefined);
      await writer;
      const report = await drain;
      expect(report).toMatchObject({ processed: 1 });

      const [afterLockedRecheck] = await db
        .select({ state: resultArchiveReductionQueue.state })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
        )
        .limit(1);
      // A direct continuation is preferable, but an explicitly requeued
      // receipt is also safe. What must never happen is leaving live work in
      // the dormant historical-audit state after the locked recheck.
      expect(afterLockedRecheck?.state).not.toBe("historical_audit_required");
      if (afterLockedRecheck?.state === "pending") {
        const retry = await drainArchiveReductionQueue(
          db,
          {
            healthDetails: async () => ({
              status: "ok",
              version: "archive-reducer-v1",
              archive_reduction_version: 2,
            }),
            reduceRemoteEvidenceCleanCycles: async () => {
              reducerCalls += 1;
              return acceptedReduction({ aoaDeg: fixture.aoaDeg });
            },
          } as unknown as EngineClient,
          {
            enqueue: false,
            resultAttemptIds: [fixture.resultAttemptId],
            maxItems: 1,
          },
        );
        expect(retry).toMatchObject({ processed: 1 });
      }
      expect(reducerCalls).toBe(1);

      const [[queue], [result]] = await Promise.all([
        db
          .select({
            state: resultArchiveReductionQueue.state,
            backfillRunId: resultArchiveReductionQueue.backfillRunId,
            resultInterpretationId:
              resultArchiveReductionQueue.resultInterpretationId,
            lastError: resultArchiveReductionQueue.lastError,
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
            currentResultAttemptId: results.currentResultAttemptId,
            currentResultInterpretationId:
              results.currentResultInterpretationId,
            currentCanonicalSelectionId: results.currentCanonicalSelectionId,
          })
          .from(results)
          .where(eq(results.id, fixture.resultId))
          .limit(1),
      ]);
      expect(queue).toMatchObject({ state: "reduced" });
      expect(queue?.backfillRunId).toBeTruthy();
      expect(queue?.resultInterpretationId).toBeTruthy();
      expect(queue?.lastError ?? "").not.toContain(
        "historical released evidence requires explicit audit",
      );
      expect(result).toMatchObject({
        currentResultAttemptId: fixture.resultAttemptId,
        currentResultInterpretationId: queue?.resultInterpretationId,
      });
      expect(result?.currentCanonicalSelectionId).toBeTruthy();
    } finally {
      releaseLock.resolve(undefined);
      await Promise.allSettled(
        [writer, drain].filter(
          (value): value is Promise<unknown> => value != null,
        ),
      );
      await lockerSql.end();
    }
  }, 30_000);

  it("MUST-CATCH: an unrelated generation that becomes current under the child-run lock cannot receive a stale archive child", async () => {
    const fixture = await createExactArchiveFixture(
      "unrelated-current-before-child-attach",
    );
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    if (!setup)
      throw new Error("archive queue solver setup fixture is missing");
    const [unrelatedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: fixture.resultId,
        airfoilId,
        bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: fixture.aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        unsteady: true,
        converged: true,
        evidencePayload: { fidelity: "urans_full" },
      })
      .returning({ id: resultAttempts.id });
    if (!unrelatedAttempt) {
      throw new Error("could not create unrelated result generation fixture");
    }

    // The optimistic publication check sees A while this writer owns the
    // result row. The writer then commits B as current before the child-run
    // transaction can acquire that row. The second exact-state check must
    // settle A as superseded without creating an archive_backfill child.
    const { db: lockerDb, sql: lockerSql } = createClient({ max: 1 });
    const locked = deferred<number>();
    const releaseLock = deferred<void>();
    let writer: Promise<unknown> | null = null;
    let drain: Promise<unknown> | null = null;
    let reducerCalls = 0;
    try {
      writer = lockerDb
        .transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          const rows = (await tx.execute(drizzleSql`
            SELECT pg_backend_pid()::integer AS pid
            FROM results
            WHERE id = ${fixture.resultId}
            FOR UPDATE
          `)) as unknown as Array<{ pid: number }>;
          const pid = rows[0]?.pid;
          if (!pid) throw new Error("result-lock fixture did not expose pid");
          locked.resolve(pid);
          await releaseLock.promise;
          await tx
            .update(results)
            .set({ currentResultAttemptId: unrelatedAttempt.id })
            .where(eq(results.id, fixture.resultId));
        })
        .catch((error) => {
          locked.reject(error);
          throw error;
        });
      const blockingPid = await locked.promise;

      drain = drainArchiveReductionQueue(
        db,
        {
          healthDetails: async () => ({
            status: "ok",
            version: "archive-reducer-v1",
            archive_reduction_version: 2,
          }),
          reduceRemoteEvidenceCleanCycles: async () => {
            reducerCalls += 1;
            throw new Error("superseded A must not reach the reducer");
          },
        } as unknown as EngineClient,
        {
          enqueue: false,
          resultAttemptIds: [fixture.resultAttemptId],
          maxItems: 1,
        },
      );
      await waitForResultPublicationLockWait(
        blockingPid,
        "queue did not reach the locked exact-generation child fence",
      );

      releaseLock.resolve(undefined);
      await writer;
      const report = await drain;
      expect(report).toMatchObject({ processed: 1 });
      expect(reducerCalls).toBe(0);

      const [[queue], children] = await Promise.all([
        db
          .select({
            state: resultArchiveReductionQueue.state,
            backfillRunId: resultArchiveReductionQueue.backfillRunId,
            resultInterpretationId:
              resultArchiveReductionQueue.resultInterpretationId,
          })
          .from(resultArchiveReductionQueue)
          .where(
            and(
              eq(
                resultArchiveReductionQueue.resultAttemptId,
                fixture.resultAttemptId,
              ),
              eq(
                resultArchiveReductionQueue.sourceArchiveId,
                fixture.sourceArchiveId,
              ),
            ),
          )
          .limit(1),
        db
          .select({ id: resultInterpretationBackfillItems.id })
          .from(resultInterpretationBackfillItems)
          .where(
            and(
              eq(
                resultInterpretationBackfillItems.resultAttemptId,
                fixture.resultAttemptId,
              ),
              eq(
                resultInterpretationBackfillItems.sourceArchiveId,
                fixture.sourceArchiveId,
              ),
            ),
          ),
      ]);
      expect(queue).toEqual({
        state: "superseded",
        backfillRunId: null,
        resultInterpretationId: null,
      });
      expect(children).toEqual([]);
    } finally {
      releaseLock.resolve(undefined);
      await Promise.allSettled(
        [writer, drain].filter(
          (value): value is Promise<unknown> => value != null,
        ),
      );
      await lockerSql.end();
    }
  }, 30_000);

  it("MUST-CATCH: excludes released GCS evidence at admission and supersedes an inherited live queue row without reducer or canonical publication", async () => {
    const fixture = await createExactArchiveFixture("released-historical");
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    // This models a pre-safeguard queue row whose exact result was released
    // after it was admitted. It remains immutable history; clearing the live
    // pointer must stop both the normal scanner and the already-durable queue
    // claimant before any GCS reduction or canonical mutation.
    await db
      .update(results)
      .set({
        status: "failed",
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));

    const inventory = await discoverHistoricalUransInventory(db, {
      scope: { resultAttemptIds: [fixture.resultAttemptId] },
    });
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]).toMatchObject({
      publicationState: "historical_released",
      archiveState: "verified_gcs_archive",
      plan: "ineligible_released_evidence",
    });

    const reAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(reAdmission.enqueued).toBe(0);
    expect(reAdmission.admittedResultAttemptIds).toEqual([]);

    let reducerCalls = 0;
    const report = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          throw new Error("released history must not reach the reducer");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(report.processed).toBe(1);
    expect(reducerCalls).toBe(0);

    const [[queue], [result], interpretations] = await Promise.all([
      db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
          resultInterpretationId:
            resultArchiveReductionQueue.resultInterpretationId,
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
        .limit(1),
      db
        .select({
          currentResultAttemptId: results.currentResultAttemptId,
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
      db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(
          and(
            eq(resultInterpretations.resultAttemptId, fixture.resultAttemptId),
            eq(resultInterpretations.sourceArchiveId, fixture.sourceArchiveId),
          ),
        ),
    ]);
    expect(queue).toMatchObject({
      // This is not a deferred retry or an audit work item. Released
      // evidence is ineligible for publication and is discarded.
      state: "superseded",
      backfillRunId: null,
      resultInterpretationId: null,
      lastError: expect.stringContaining("ineligible for reduction"),
    });
    expect(queue?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(result).toEqual({
      currentResultAttemptId: null,
      currentResultInterpretationId: null,
      currentCanonicalSelectionId: null,
    });
    expect(interpretations).toEqual([]);
  });

  it("MUST-CATCH: a released receipt stays superseded if the same result generation becomes current again", async () => {
    const fixture = await createExactArchiveFixture(
      "released-superseded-then-current",
    );
    const firstAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(firstAdmission.enqueued).toBe(1);

    // A released source is terminal queue history: it must not run the
    // reducer or create an archive_backfill interpretation/canonical selection.
    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));
    let releasedReducerCalls = 0;
    const releasedReport = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          releasedReducerCalls += 1;
          throw new Error("released ineligible evidence must not be reduced");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(releasedReport.processed).toBe(1);
    expect(releasedReducerCalls).toBe(0);

    const [superseded] = await db
      .select({
        id: resultArchiveReductionQueue.id,
        state: resultArchiveReductionQueue.state,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
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
          eq(
            resultArchiveReductionQueue.sourceArchiveId,
            fixture.sourceArchiveId,
          ),
        ),
      )
      .limit(1);
    expect(superseded).toMatchObject({
      state: "superseded",
      backfillRunId: null,
      resultInterpretationId: null,
      lastError: expect.stringContaining("ineligible for reduction"),
    });

    // Reopening the projection cannot revive released evidence. A clean rerun
    // is required instead of resuming this exact immutable source.
    await db
      .update(results)
      .set({ currentResultAttemptId: fixture.resultAttemptId })
      .where(eq(results.id, fixture.resultId));
    const reopenedAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(reopenedAdmission.enqueued).toBe(0);
    expect(reopenedAdmission.admittedResultAttemptIds).toEqual([]);

    const [stillSuperseded] = await db
      .select({
        id: resultArchiveReductionQueue.id,
        state: resultArchiveReductionQueue.state,
        claimToken: resultArchiveReductionQueue.claimToken,
        claimExpiresAt: resultArchiveReductionQueue.claimExpiresAt,
        lastError: resultArchiveReductionQueue.lastError,
      })
      .from(resultArchiveReductionQueue)
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(
            resultArchiveReductionQueue.sourceArchiveId,
            fixture.sourceArchiveId,
          ),
        ),
      )
      .limit(1);
    expect(stillSuperseded).toEqual(
      expect.objectContaining({
        id: superseded?.id,
        state: "superseded",
        claimToken: null,
        claimExpiresAt: null,
        lastError: expect.stringContaining("ineligible for reduction"),
      }),
    );

    let reopenedReducerCalls = 0;
    const reopenedReport = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reopenedReducerCalls += 1;
          throw new Error("superseded receipt must stay non-executable");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(reopenedReport.processed).toBe(0);
    expect(reopenedReducerCalls).toBe(0);
  });

  it("settles a null-projection exact PRECALC owner from an accepted archive while the raw attempt remains rejected", async () => {
    const fixture = await createExactArchiveFixture(
      "precalc-owner-settlement",
      db,
      { withPrecalcJob: true },
    );
    if (!fixture.simJobId || !setup || !solverFixture) {
      throw new Error("PRECALC archive fixture is missing its exact job setup");
    }
    const { campaignId } = await attachCampaignPoint(fixture);
    const [obligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId: setup.revisionId,
        aoaDeg: fixture.aoaDeg,
        state: "blocked",
        attemptCount: 2,
        maxAttempts: 2,
        latestSimJobId: fixture.simJobId,
        lastOutcome: "rejected_exhausted",
        lastError: "stale owner before archive selection",
      })
      .returning({ id: simPrecalcObligations.id });
    fixturePrecalcObligationIds.push(obligation.id);
    await db.insert(simPrecalcObligationCampaigns).values({
      obligationId: obligation.id,
      campaignId,
      state: "active",
    });
    const [firstIncident] = await db
      .insert(simSolverIncidents)
      .values({
        stage: "preliminary",
        reason: "archive-selection-settlement-fixture",
        severity: "critical",
        status: "open",
        precalcObligationId: obligation.id,
        solverImplementationId: solverFixture.solverImplementationId,
        occurrenceKey: `${PREFIX}:archive-selection-normal:${fixture.resultId}`,
        remediationVersion: "archive-queue-test-v1",
      })
      .returning({ id: simSolverIncidents.id });
    await db.insert(simSolverIncidentCampaigns).values({
      incidentId: firstIncident.id,
      campaignId,
    });
    // The raw engine attempt did not carry the clean tail needed for a
    // publishable raw verdict. The authenticated archive reduction is the
    // accepted scientific authority, so its selected result must still close
    // this exact owner without rewriting or pretending that the raw attempt
    // itself was accepted.
    await db.insert(resultClassifications).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      airfoilId,
      simulationPresetRevisionId: setup.revisionId,
      aoaDeg: fixture.aoaDeg,
      regime: "urans",
      classifierVersion: "raw-engine-summary-fixture-v1",
      state: "rejected",
      region: "post_stall",
      confidence: 1,
      reasons: ["raw-summary-missing-clean-tail"],
    });
    // The raw controller reached its generic continuation budget before the
    // authenticated archive was reduced. That marker must remain historical
    // attempt evidence, but cannot veto the selected archive's clean result.
    await db
      .update(resultAttempts)
      .set({ qualityWarnings: [URANS_BUDGET_STOP_MARKER] })
      .where(eq(resultAttempts.id, fixture.resultAttemptId));
    // Model the production recovery shape: a prior controller cleared the
    // mutable projection after rejecting its raw summary, while its exact
    // campaign-owned PRECALC job and verified archive were already durable.
    // This is not released historical evidence; the strict owner predicate is
    // what may let the normal archive-publication queue reclaim it.
    await db
      .update(results)
      .set({
        status: "failed",
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));

    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    const normal = await drainArchiveReductionQueue(
      db,
      engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(normal.processed).toBe(1);
    expect(
      await db
        .select({ status: results.status })
        .from(results)
        .where(eq(results.id, fixture.resultId)),
    ).toEqual([{ status: "done" }]);
    expect(
      await db
        .select({
          state: simPrecalcObligations.state,
          sourceResultId: simPrecalcObligations.sourceResultId,
          sourceResultAttemptId: simPrecalcObligations.sourceResultAttemptId,
          lastOutcome: simPrecalcObligations.lastOutcome,
          lastError: simPrecalcObligations.lastError,
        })
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id)),
    ).toEqual([
      {
        state: "satisfied",
        sourceResultId: fixture.resultId,
        sourceResultAttemptId: fixture.resultAttemptId,
        lastOutcome: "accepted",
        lastError: null,
      },
    ]);
    expect(
      await db
        .select({ status: simSolverIncidents.status })
        .from(simSolverIncidents)
        .where(eq(simSolverIncidents.id, firstIncident.id)),
    ).toEqual([{ status: "resolved" }]);
    expect(
      await db
        .select({ state: resultClassifications.state })
        .from(resultClassifications)
        .where(eq(resultClassifications.resultId, fixture.resultId)),
    ).toEqual([{ state: "accepted" }]);

    // MUST-CATCH: owner settlement derives authority from the selected exact
    // archive interpretation, not a cache-maintained classification row. A
    // stale/raw rejected classification must not strand the accepted archive
    // if a process crashed after selection but before reconciliation.
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        sourceResultId: null,
        sourceResultAttemptId: null,
        lastOutcome: "rejected_exhausted",
        lastError: "direct selection settlement replay",
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["raw-summary-missing-clean-tail"] })
      .where(eq(resultClassifications.resultId, fixture.resultId));
    await expect(
      satisfyPrecalcObligationFromAcceptedResult(db, fixture.resultId),
    ).resolves.toMatchObject({
      obligationId: obligation.id,
      resultAttemptId: fixture.resultAttemptId,
      changed: true,
    });
    expect(
      await db
        .select({ state: simPrecalcObligations.state })
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id)),
    ).toEqual([{ state: "satisfied" }]);
    expect(
      await db
        .select({
          status: results.status,
          currentResultAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId)),
    ).toEqual([
      { status: "done", currentResultAttemptId: fixture.resultAttemptId },
    ]);

    // Model the narrow crash window after canonical selection, where the
    // queue receipt is re-leased before mutable owner settlement. The replay
    // must not invoke the reducer and must close the stale owner again.
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        sourceResultId: null,
        sourceResultAttemptId: null,
        lastOutcome: "rejected_exhausted",
        lastError: "crash after archive selection before owner settlement",
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    const [replayIncident] = await db
      .insert(simSolverIncidents)
      .values({
        stage: "preliminary",
        reason: "archive-selection-settlement-fixture",
        severity: "critical",
        status: "open",
        precalcObligationId: obligation.id,
        solverImplementationId: solverFixture.solverImplementationId,
        occurrenceKey: `${PREFIX}:archive-selection-replay:${fixture.resultId}`,
        remediationVersion: "archive-queue-test-v1",
      })
      .returning({ id: simSolverIncidents.id });
    await db.insert(simSolverIncidentCampaigns).values({
      incidentId: replayIncident.id,
      campaignId,
    });
    await db
      .update(resultArchiveReductionQueue)
      .set({
        state: "pending",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: new Date(),
      })
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(
            resultArchiveReductionQueue.sourceArchiveId,
            fixture.sourceArchiveId,
          ),
        ),
      );
    let reducerCalls = 0;
    const replay = await drainArchiveReductionQueue(
      db,
      {
        ...engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          throw new Error("already-selected replay must not reduce again");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(replay.processed).toBe(1);
    expect(reducerCalls).toBe(0);
    expect(
      await db
        .select({ state: simPrecalcObligations.state })
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id)),
    ).toEqual([{ state: "satisfied" }]);
    expect(
      await db
        .select({ status: simSolverIncidents.status })
        .from(simSolverIncidents)
        .where(eq(simSolverIncidents.id, replayIncident.id)),
    ).toEqual([{ status: "resolved" }]);
  });

  it("MUST-CATCH: a failed null-projection result without its exact live PRECALC owner remains historical and cannot publish", async () => {
    const fixture = await createExactArchiveFixture("failed-no-owner", db);
    await db
      .update(results)
      .set({
        status: "failed",
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));

    const outcome = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(outcome.enqueued).toBe(0);
    expect(
      await db
        .select({
          status: results.status,
          currentResultAttemptId: results.currentResultAttemptId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId)),
    ).toEqual([
      {
        status: "failed",
        currentResultAttemptId: null,
        currentCanonicalSelectionId: null,
      },
    ]);
  });

  it("MUST-CATCH: two completed archives for one exact PRECALC job select the stable newest generation even when workers finish in reverse order", async () => {
    const fixture = await createExactArchiveFixture(
      "precalc-owner-deterministic-winner",
      db,
      { withPrecalcJob: true },
    );
    await attachExactLivePrecalcOwner(fixture);
    const olderCreatedAt = new Date("2026-08-01T00:00:00.000Z");
    await db
      .update(resultAttempts)
      .set({ createdAt: olderCreatedAt })
      .where(eq(resultAttempts.id, fixture.resultAttemptId));
    await db
      .update(results)
      .set({
        status: "failed",
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));

    // The first receipt predates a second delivery, so it can exist in the
    // durable queue. Once the newer immutable attempt arrives, two workers
    // must still converge on the same source—not whichever reducer returns.
    expect(
      (
        await enqueueVerifiedArchiveReductions(db, {
          resultAttemptIds: [fixture.resultAttemptId],
          limit: 1,
        })
      ).enqueued,
    ).toBe(1);
    const newer = await createSiblingArchiveAttempt(
      fixture,
      "precalc-owner-deterministic-winner-newer",
      { createdAt: new Date("2026-08-01T00:00:01.000Z") },
    );
    expect(
      (
        await enqueueVerifiedArchiveReductions(db, {
          resultAttemptIds: [newer.resultAttemptId],
          limit: 1,
        })
      ).enqueued,
    ).toBe(1);

    await Promise.all([
      drainArchiveReductionQueue(
        db,
        engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
        {
          enqueue: false,
          resultAttemptIds: [fixture.resultAttemptId],
          maxItems: 1,
        },
      ),
      drainArchiveReductionQueue(
        db,
        engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
        {
          enqueue: false,
          resultAttemptIds: [newer.resultAttemptId],
          maxItems: 1,
        },
      ),
    ]);

    expect(
      await db
        .select({ currentResultAttemptId: results.currentResultAttemptId })
        .from(results)
        .where(eq(results.id, fixture.resultId)),
    ).toEqual([{ currentResultAttemptId: newer.resultAttemptId }]);
    const queueStates = await db
      .select({
        resultAttemptId: resultArchiveReductionQueue.resultAttemptId,
        state: resultArchiveReductionQueue.state,
      })
      .from(resultArchiveReductionQueue)
      .where(
        inArray(resultArchiveReductionQueue.resultAttemptId, [
          fixture.resultAttemptId,
          newer.resultAttemptId,
        ]),
      );
    expect(queueStates).toContainEqual({
      resultAttemptId: newer.resultAttemptId,
      state: "reduced",
    });
    expect(
      queueStates.some(
        (row) =>
          row.resultAttemptId === fixture.resultAttemptId &&
          ["historical_audit_required", "superseded"].includes(row.state),
      ),
    ).toBe(true);
  });

  it("MUST-CATCH: a reducer-unusable newer archive cannot suppress a verified exact sibling indefinitely", async () => {
    const fixture = await createExactArchiveFixture(
      "precalc-owner-unverified-newer",
      db,
      { withPrecalcJob: true },
    );
    await attachExactLivePrecalcOwner(fixture);
    await db
      .update(resultAttempts)
      .set({ createdAt: new Date("2026-08-01T00:00:00.000Z") })
      .where(eq(resultAttempts.id, fixture.resultAttemptId));
    await createSiblingArchiveAttempt(
      fixture,
      "precalc-owner-unusable-newer-delivery",
      {
        createdAt: new Date("2026-08-01T00:00:01.000Z"),
        archiveMimeType: "application/octet-stream",
      },
    );
    await db
      .update(results)
      .set({
        status: "failed",
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));

    // A current blob that the clean-cycle reducer cannot read is not an
    // archive-ready scientific candidate and cannot veto the verified older
    // sibling. It remains retained for normal repair/audit instead of parking
    // the live owner forever.
    expect(
      (
        await enqueueVerifiedArchiveReductions(db, {
          resultAttemptIds: [fixture.resultAttemptId],
          limit: 1,
        })
      ).enqueued,
    ).toBe(1);
    await drainArchiveReductionQueue(
      db,
      engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(
      await db
        .select({ currentResultAttemptId: results.currentResultAttemptId })
        .from(results)
        .where(eq(results.id, fixture.resultId)),
    ).toEqual([{ currentResultAttemptId: fixture.resultAttemptId }]);
  });

  it("MUST-CATCH: a latest-job change that wins while owner settlement waits cannot satisfy the stale selected archive", async () => {
    const fixture = await createExactArchiveFixture(
      "precalc-owner-latest-job-race",
      db,
      { withPrecalcJob: true },
    );
    const { obligationId } = await attachExactLivePrecalcOwner(fixture);
    await db
      .update(results)
      .set({
        status: "failed",
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));
    await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    await drainArchiveReductionQueue(
      db,
      engineReturning(acceptedReduction({ aoaDeg: fixture.aoaDeg })),
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    await db
      .update(simPrecalcObligations)
      .set({
        state: "blocked",
        sourceResultId: null,
        sourceResultAttemptId: null,
        lastOutcome: "rejected_exhausted",
        lastError: "fixture reopening settlement race",
      })
      .where(eq(simPrecalcObligations.id, obligationId));
    if (!setup || !solverFixture) {
      throw new Error("latest-job race fixture is missing solver setup");
    }
    const [replacementJob] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: setup.revisionId,
        solverImplementationId: solverFixture.solverImplementationId,
        referenceChordM: 0.2,
        wave: 3,
        status: "done",
        engineJobId: `${PREFIX}-precalc-owner-latest-job-race-replacement`,
        totalCases: 1,
        completedCases: 1,
        requestPayload: { aoas: [fixture.aoaDeg], uransFidelity: "precalc" },
      })
      .returning({ id: simJobs.id });
    if (!replacementJob) throw new Error("could not create replacement job");
    fixtureJobIds.push(replacementJob.id);

    const { db: lockerDb, sql: lockerSql } = createClient({ max: 1 });
    const locked = deferred<number>();
    const releaseLock = deferred<void>();
    let writer: Promise<unknown> | null = null;
    try {
      writer = lockerDb
        .transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          const rows = (await tx.execute(drizzleSql`
            SELECT pg_backend_pid()::integer AS pid
            FROM sim_precalc_obligations
            WHERE id = ${obligationId}
            FOR UPDATE
          `)) as unknown as Array<{ pid: number }>;
          const pid = rows[0]?.pid;
          if (!pid) throw new Error("owner-lock fixture did not expose pid");
          locked.resolve(pid);
          await releaseLock.promise;
          await tx
            .update(simPrecalcObligations)
            .set({ latestSimJobId: replacementJob.id })
            .where(eq(simPrecalcObligations.id, obligationId));
        })
        .catch((error) => {
          locked.reject(error);
          throw error;
        });
      const blockingPid = await locked.promise;
      const staleSettlement = satisfyPrecalcObligationFromAcceptedResult(
        db,
        fixture.resultId,
      );
      await waitForResultPublicationLockWait(
        blockingPid,
        "stale archive settlement did not wait for the owner latest-job lock",
      );
      releaseLock.resolve();
      await writer;
      await expect(staleSettlement).resolves.toBeNull();
    } finally {
      releaseLock.resolve();
      await Promise.allSettled([writer].filter(Boolean));
      await lockerSql.end();
    }
    expect(
      await db
        .select({
          state: simPrecalcObligations.state,
          latestSimJobId: simPrecalcObligations.latestSimJobId,
          sourceResultId: simPrecalcObligations.sourceResultId,
        })
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationId)),
    ).toEqual([
      {
        state: "blocked",
        latestSimJobId: replacementJob.id,
        sourceResultId: null,
      },
    ]);
  });

  it("MUST-CATCH: a normally reduced receipt replays its exact canonical selection after release and deliberate reopen", async () => {
    const fixture = await createExactArchiveFixture(
      "reduced-then-released-then-reopened",
    );
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    let initialReducerCalls = 0;
    const initialDrain = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          initialReducerCalls += 1;
          return acceptedReduction({ aoaDeg: fixture.aoaDeg });
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(initialDrain.processed).toBe(1);
    expect(initialReducerCalls).toBe(1);

    const [initialQueue] = await db
      .select({
        id: resultArchiveReductionQueue.id,
        state: resultArchiveReductionQueue.state,
        attemptCount: resultArchiveReductionQueue.attemptCount,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        resultInterpretationId:
          resultArchiveReductionQueue.resultInterpretationId,
      })
      .from(resultArchiveReductionQueue)
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(
            resultArchiveReductionQueue.sourceArchiveId,
            fixture.sourceArchiveId,
          ),
        ),
      )
      .limit(1);
    const originalRunId = initialQueue?.backfillRunId;
    const originalInterpretationId = initialQueue?.resultInterpretationId;
    if (!initialQueue || !originalRunId || !originalInterpretationId) {
      throw new Error(
        "first archive reduction did not retain its replay receipt",
      );
    }
    expect(initialQueue.state).toBe("reduced");

    // The release retracts the public projection but retains the immutable
    // normal interpretation. Exact reopening must re-arm that receipt for
    // selection replay; it must not leave the unique reduced row dormant or
    // repeat the evidence reduction.
    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));
    await db
      .update(results)
      .set({ currentResultAttemptId: fixture.resultAttemptId })
      .where(eq(results.id, fixture.resultId));
    const reopenedAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(reopenedAdmission.enqueued).toBe(0);
    expect(reopenedAdmission.admittedResultAttemptIds).toEqual([
      fixture.resultAttemptId,
    ]);

    const [rearmedQueue] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        attemptCount: resultArchiveReductionQueue.attemptCount,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        resultInterpretationId:
          resultArchiveReductionQueue.resultInterpretationId,
      })
      .from(resultArchiveReductionQueue)
      .where(eq(resultArchiveReductionQueue.id, initialQueue.id))
      .limit(1);
    expect(rearmedQueue).toEqual({
      state: "pending",
      attemptCount: 0,
      backfillRunId: originalRunId,
      resultInterpretationId: originalInterpretationId,
    });

    let replayReducerCalls = 0;
    const replayDrain = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          replayReducerCalls += 1;
          throw new Error(
            "a completed exact child must replay without reducer I/O",
          );
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(replayDrain.processed).toBe(1);
    expect(replayReducerCalls).toBe(0);

    const [[publishedQueue], [publishedResult]] = await Promise.all([
      db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
          resultInterpretationId:
            resultArchiveReductionQueue.resultInterpretationId,
        })
        .from(resultArchiveReductionQueue)
        .where(eq(resultArchiveReductionQueue.id, initialQueue.id))
        .limit(1),
      db
        .select({
          currentResultAttemptId: results.currentResultAttemptId,
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
    ]);
    expect(publishedQueue).toEqual({
      state: "reduced",
      backfillRunId: originalRunId,
      resultInterpretationId: originalInterpretationId,
    });
    expect(publishedResult).toMatchObject({
      currentResultAttemptId: fixture.resultAttemptId,
      currentResultInterpretationId: originalInterpretationId,
    });
    expect(publishedResult?.currentCanonicalSelectionId).toBeTruthy();
  });

  it("MUST-CATCH: a historical hold preserves an already reduced normal child for exact reopen replay", async () => {
    const fixture = await createExactArchiveFixture(
      "historical-hold-after-reduced-child",
    );
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    let firstReducerCalls = 0;
    const firstDrain = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          firstReducerCalls += 1;
          return acceptedReduction({ aoaDeg: fixture.aoaDeg });
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(firstDrain.processed).toBe(1);
    expect(firstReducerCalls).toBe(1);

    const [initialQueue] = await db
      .select({
        id: resultArchiveReductionQueue.id,
        state: resultArchiveReductionQueue.state,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        resultInterpretationId:
          resultArchiveReductionQueue.resultInterpretationId,
      })
      .from(resultArchiveReductionQueue)
      .where(
        and(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
          eq(
            resultArchiveReductionQueue.sourceArchiveId,
            fixture.sourceArchiveId,
          ),
        ),
      )
      .limit(1);
    const originalRunId = initialQueue?.backfillRunId;
    const originalInterpretationId = initialQueue?.resultInterpretationId;
    if (!initialQueue || !originalRunId || !originalInterpretationId) {
      throw new Error("normal reduced child fixture is incomplete");
    }
    expect(initialQueue.state).toBe("reduced");

    // Model the exact state produced when the child already staged an accepted
    // normal interpretation, then a release is observed before the parent can
    // settle its final publication selection. The real child stays immutable;
    // only the parent is held outside live scheduling. Reopening must recover
    // that child rather than re-reducing the same authenticated archive.
    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));
    await db
      .update(resultArchiveReductionQueue)
      .set({
        state: "historical_audit_required",
        claimToken: null,
        claimExpiresAt: null,
        resultInterpretationId: null,
        lastError: "legacy released evidence receipt",
        nextAttemptAt: new Date(),
      })
      .where(eq(resultArchiveReductionQueue.id, initialQueue.id));

    await db
      .update(results)
      .set({ currentResultAttemptId: fixture.resultAttemptId })
      .where(eq(results.id, fixture.resultId));
    const reopenedAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(reopenedAdmission.enqueued).toBe(0);
    expect(reopenedAdmission.admittedResultAttemptIds).toEqual([
      fixture.resultAttemptId,
    ]);

    const [rearmedQueue] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        resultInterpretationId:
          resultArchiveReductionQueue.resultInterpretationId,
      })
      .from(resultArchiveReductionQueue)
      .where(eq(resultArchiveReductionQueue.id, initialQueue.id))
      .limit(1);
    expect(rearmedQueue).toEqual({
      state: "pending",
      backfillRunId: originalRunId,
      resultInterpretationId: originalInterpretationId,
    });

    let replayReducerCalls = 0;
    const replayDrain = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          replayReducerCalls += 1;
          throw new Error(
            "reduced historical child must replay without reducer I/O",
          );
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(replayDrain.processed).toBe(1);
    expect(replayReducerCalls).toBe(0);

    const [[publishedQueue], [publishedResult]] = await Promise.all([
      db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
          resultInterpretationId:
            resultArchiveReductionQueue.resultInterpretationId,
        })
        .from(resultArchiveReductionQueue)
        .where(eq(resultArchiveReductionQueue.id, initialQueue.id))
        .limit(1),
      db
        .select({
          currentResultAttemptId: results.currentResultAttemptId,
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
    ]);
    expect(publishedQueue).toEqual({
      state: "reduced",
      backfillRunId: originalRunId,
      resultInterpretationId: originalInterpretationId,
    });
    expect(publishedResult).toMatchObject({
      currentResultAttemptId: fixture.resultAttemptId,
      currentResultInterpretationId: originalInterpretationId,
    });
    expect(publishedResult?.currentCanonicalSelectionId).toBeTruthy();
  });

  it("MUST-CATCH: a released receipt stays superseded when a different result generation becomes current", async () => {
    const fixture = await createExactArchiveFixture(
      "released-superseded-then-unrelated-generation",
    );
    const firstAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(firstAdmission.enqueued).toBe(1);

    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));
    let releasedReducerCalls = 0;
    await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          releasedReducerCalls += 1;
          throw new Error("released archive must stay outside live reduction");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(releasedReducerCalls).toBe(0);

    if (!setup)
      throw new Error("archive queue solver setup fixture is missing");
    const [unrelatedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: fixture.resultId,
        airfoilId,
        bcId,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: fixture.aoaDeg,
        status: "done",
        source: "solved",
        regime: "urans",
        unsteady: true,
        converged: true,
        evidencePayload: { fidelity: "urans_full" },
      })
      .returning({ id: resultAttempts.id });
    if (!unrelatedAttempt) {
      throw new Error("could not create unrelated current attempt fixture");
    }
    await db
      .update(results)
      .set({ currentResultAttemptId: unrelatedAttempt.id })
      .where(eq(results.id, fixture.resultId));

    // The scanner can still see A's valid immutable GCS archive, but A is not
    // the current result and has no exact PRECALC handoff to B. Admission must
    // not revive the superseded receipt merely because another generation is live.
    const unrelatedAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(unrelatedAdmission.enqueued).toBe(0);
    expect(unrelatedAdmission.admittedResultAttemptIds).toEqual([]);

    const [[queue], [result]] = await Promise.all([
      db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
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
            eq(
              resultArchiveReductionQueue.sourceArchiveId,
              fixture.sourceArchiveId,
            ),
          ),
        )
        .limit(1),
      db
        .select({
          currentResultAttemptId: results.currentResultAttemptId,
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, fixture.resultId))
        .limit(1),
    ]);
    expect(queue).toMatchObject({
      state: "superseded",
      backfillRunId: null,
      resultInterpretationId: null,
      lastError: expect.stringContaining("ineligible for reduction"),
    });
    expect(result).toEqual({
      currentResultAttemptId: unrelatedAttempt.id,
      currentResultInterpretationId: null,
      currentCanonicalSelectionId: null,
    });

    let unrelatedReducerCalls = 0;
    const unrelatedDrain = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          unrelatedReducerCalls += 1;
          throw new Error("superseded receipt must not reduce");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(unrelatedDrain.processed).toBe(0);
    expect(unrelatedReducerCalls).toBe(0);
  });

  it("MUST-CATCH: releasing a source during reduction settles its receipt as superseded and non-executable", async () => {
    const fixture = await createExactArchiveFixture(
      "released-after-child-then-current",
    );
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(admission.enqueued).toBe(1);

    // Let the first normal receipt create and claim its child, then release the
    // result while the reducer is in flight. The reducer response is valid,
    // but the source has become ineligible for publication.
    const firstReducerEntered = deferred<void>();
    const firstReduction = deferred<ArchiveCleanCycleReductionResponse>();
    const firstDrain = drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          firstReducerEntered.resolve();
          return firstReduction.promise;
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    await firstReducerEntered.promise;

    const initial = await waitFor(async () => {
      const [[queue], [child]] = await Promise.all([
        db
          .select({
            id: resultArchiveReductionQueue.id,
            state: resultArchiveReductionQueue.state,
            backfillRunId: resultArchiveReductionQueue.backfillRunId,
          })
          .from(resultArchiveReductionQueue)
          .where(
            and(
              eq(
                resultArchiveReductionQueue.resultAttemptId,
                fixture.resultAttemptId,
              ),
              eq(
                resultArchiveReductionQueue.sourceArchiveId,
                fixture.sourceArchiveId,
              ),
            ),
          )
          .limit(1),
        db
          .select({
            runId: resultInterpretationBackfillItems.runId,
            state: resultInterpretationBackfillItems.state,
          })
          .from(resultInterpretationBackfillItems)
          .where(
            and(
              eq(
                resultInterpretationBackfillItems.resultAttemptId,
                fixture.resultAttemptId,
              ),
              eq(
                resultInterpretationBackfillItems.sourceArchiveId,
                fixture.sourceArchiveId,
              ),
            ),
          )
          .limit(1),
      ]);
      if (!queue?.backfillRunId || child?.runId !== queue.backfillRunId) {
        return null;
      }
      return { queue, backfillRunId: queue.backfillRunId };
    }, "first archive publication child was not attached before release");
    expect(initial.queue.state).toBe("hydrating");

    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, fixture.resultId));
    firstReduction.resolve(acceptedReduction({ aoaDeg: fixture.aoaDeg }));
    await firstDrain;

    const [[superseded], [releasedChild]] = await Promise.all([
      db
        .select({
          state: resultArchiveReductionQueue.state,
          backfillRunId: resultArchiveReductionQueue.backfillRunId,
          resultInterpretationId:
            resultArchiveReductionQueue.resultInterpretationId,
          lastError: resultArchiveReductionQueue.lastError,
        })
        .from(resultArchiveReductionQueue)
        .where(eq(resultArchiveReductionQueue.id, initial.queue.id))
        .limit(1),
      db
        .select({ state: resultInterpretationBackfillItems.state })
        .from(resultInterpretationBackfillItems)
        .where(
          and(
            eq(resultInterpretationBackfillItems.runId, initial.backfillRunId),
            eq(
              resultInterpretationBackfillItems.resultAttemptId,
              fixture.resultAttemptId,
            ),
          ),
        )
        .limit(1),
    ]);
    expect(superseded).toMatchObject({
      state: "superseded",
      backfillRunId: initial.backfillRunId,
      resultInterpretationId: null,
      lastError: expect.stringContaining("ineligible for reduction"),
    });
    expect(releasedChild?.state).toBe("failed");

    // Making the same attempt current again cannot resume this released
    // source. It needs a clean replacement generation.
    await db
      .update(results)
      .set({ currentResultAttemptId: fixture.resultAttemptId })
      .where(eq(results.id, fixture.resultId));
    const reopenedAdmission = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [fixture.resultAttemptId],
      limit: 1,
    });
    expect(reopenedAdmission.enqueued).toBe(0);
    expect(reopenedAdmission.admittedResultAttemptIds).toEqual([]);

    const [stillSuperseded] = await db
      .select({
        state: resultArchiveReductionQueue.state,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
        resultInterpretationId:
          resultArchiveReductionQueue.resultInterpretationId,
        lastError: resultArchiveReductionQueue.lastError,
      })
      .from(resultArchiveReductionQueue)
      .where(eq(resultArchiveReductionQueue.id, initial.queue.id))
      .limit(1);
    expect(stillSuperseded).toEqual({
      state: "superseded",
      backfillRunId: initial.backfillRunId,
      resultInterpretationId: null,
      lastError: expect.stringContaining("ineligible for reduction"),
    });

    let reopenedReducerCalls = 0;
    const reopenedDrain = await drainArchiveReductionQueue(
      db,
      {
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reopenedReducerCalls += 1;
          throw new Error("released receipt must stay non-executable");
        },
      } as unknown as EngineClient,
      {
        enqueue: false,
        resultAttemptIds: [fixture.resultAttemptId],
        maxItems: 1,
      },
    );
    expect(reopenedDrain.processed).toBe(0);
    expect(reopenedReducerCalls).toBe(0);

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
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
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
        healthDetails: async () => ({
          status: "ok",
          version: "archive-reducer-v1",
          archive_reduction_version: 2,
        }),
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
          status: results.status,
          fidelity: results.fidelity,
          regime: results.regime,
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

    const [[queue], [result], [progress], [classification]] = await Promise.all(
      [
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
            currentResultInterpretationId:
              results.currentResultInterpretationId,
            currentCanonicalSelectionId: results.currentCanonicalSelectionId,
            status: results.status,
            fidelity: results.fidelity,
            regime: results.regime,
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
        db
          .select({
            state: resultClassifications.state,
            resultAttemptId: resultClassifications.resultAttemptId,
            reasons: resultClassifications.reasons,
          })
          .from(resultClassifications)
          .where(eq(resultClassifications.resultId, fixture.resultId)),
      ],
    );
    expect(queue).toMatchObject({ state: "reduced" });
    expect(queue?.backfillRunId).toBeTruthy();
    expect(queue?.resultInterpretationId).toBeTruthy();
    expect(result).toMatchObject({
      currentResultInterpretationId: queue?.resultInterpretationId,
      status: "done",
      fidelity: "urans_precalc",
      regime: "urans",
    });
    expect(result?.currentCanonicalSelectionId).toBeTruthy();
    expect(classification).toEqual({
      state: "accepted",
      resultAttemptId: null,
      reasons: [],
    });
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
    await withRolledBackFixture(async (tx) => {
      const fixture = await createExactArchiveFixture("reducer-precedence", tx);
      const firstAdmission = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });
      const v1 = firstAdmission.reducerVersionId;
      await tx
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
      const [v1Row] = await tx
        .select({ reducerKey: resultReducerVersions.reducerKey })
        .from(resultReducerVersions)
        .where(eq(resultReducerVersions.id, v1))
        .limit(1);
      if (!v1Row)
        throw new Error("archive queue V1 reducer fixture was not found");
      const [v2] = await tx
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
      await tx.insert(resultArchiveReductionQueue).values({
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
        reducerVersionId: v2.id,
        state: "pending",
      });

      const staleAdmission = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });
      expect(staleAdmission.enqueued).toBe(0);
      expect(staleAdmission.admittedResultAttemptIds).toEqual([]);
      const rows = await tx
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
  });

  it("MUST-CATCH: an explicit historical scope may repair an exact accepted clean-cycle-v5 selection with clean-cycle-v6", async () => {
    await withRolledBackFixture(async (tx) => {
      const fixture = await createExactArchiveFixture(
        "v5-selection-compatible-with-v6-scan",
        tx,
      );
      // Bootstrap the current app reducer, then remove only its test receipt.
      // The v5 selection below is the current projection under test, not a
      // hidden v6 queue row that could make the scanner pass incidentally.
      const bootstrap = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });
      expect(bootstrap.enqueued).toBe(1);
      const [v6Reducer] = await tx
        .select({
          buildId: resultReducerVersions.buildId,
          createdAt: resultReducerVersions.createdAt,
        })
        .from(resultReducerVersions)
        .where(eq(resultReducerVersions.id, bootstrap.reducerVersionId))
        .limit(1);
      expect(v6Reducer?.buildId).toBe("clean-cycle-v6");
      if (!v6Reducer) throw new Error("could not load v6 reducer fixture");
      await tx
        .delete(resultArchiveReductionQueue)
        .where(
          and(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              fixture.resultAttemptId,
            ),
            eq(
              resultArchiveReductionQueue.reducerVersionId,
              bootstrap.reducerVersionId,
            ),
          ),
        );

      const [v5Reducer] = await tx
        .insert(resultReducerVersions)
        .values({
          reducerKey: "airfoilfoam",
          reducerVersion: "result-interpretation-v2",
          buildId: "clean-cycle-v5",
          policySha256: "e".repeat(64),
          policy: { regression: "accepted-v5-selection-compatible-with-v6" },
          source: "test",
          createdAt: new Date(v6Reducer.createdAt.getTime() - 1_000),
        })
        .returning({ id: resultReducerVersions.id });
      if (!v5Reducer) throw new Error("could not create v5 reducer fixture");
      const [v5Interpretation] = await tx
        .insert(resultInterpretations)
        .values({
          resultId: fixture.resultId,
          resultAttemptId: fixture.resultAttemptId,
          reducerVersionId: v5Reducer.id,
          sourceArchiveId: fixture.sourceArchiveId,
          source: "archive_backfill",
          inputEvidenceSignature: "f".repeat(64),
          state: "accepted",
          regime: "periodic",
          cl: 0.8,
          cd: 0.02,
          cm: -0.04,
          clCd: 40,
          selectedWindow: {},
          statistics: {},
          diagnostics: {},
        })
        .returning({ id: resultInterpretations.id });
      if (!v5Interpretation)
        throw new Error("could not create v5 interpretation fixture");
      const [v5Selection] = await tx
        .insert(resultCanonicalSelections)
        .values({
          resultId: fixture.resultId,
          resultAttemptId: fixture.resultAttemptId,
          resultInterpretationId: v5Interpretation.id,
          selectionNamespace: "archive-clean-cycle-v3",
          reason: "test current v5 archive selection",
          actor: "test",
        })
        .returning({ id: resultCanonicalSelections.id });
      if (!v5Selection)
        throw new Error("could not create v5 selection fixture");
      await tx
        .update(results)
        .set({
          currentResultInterpretationId: v5Interpretation.id,
          currentCanonicalSelectionId: v5Selection.id,
        })
        .where(eq(results.id, fixture.resultId));

      const scopedRepair = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });
      expect(scopedRepair).toMatchObject({
        reducerVersionId: bootstrap.reducerVersionId,
        scanned: 1,
        enqueued: 1,
        admittedResultAttemptIds: [fixture.resultAttemptId],
      });
      expect(
        await tx
          .select({
            reducerVersionId: resultArchiveReductionQueue.reducerVersionId,
          })
          .from(resultArchiveReductionQueue)
          .where(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              fixture.resultAttemptId,
            ),
          ),
      ).toEqual([{ reducerVersionId: bootstrap.reducerVersionId }]);
    });
  });

  it("admits the current reducer generation after an older terminal missing-provenance receipt", async () => {
    await withRolledBackFixture(async (tx) => {
      const fixture = await createExactArchiveFixture(
        "legacy-missing-provenance-generation",
        tx,
      );
      const currentAdmission = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });
      const currentReducerId = currentAdmission.reducerVersionId;
      await tx
        .delete(resultArchiveReductionQueue)
        .where(
          and(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              fixture.resultAttemptId,
            ),
            eq(resultArchiveReductionQueue.reducerVersionId, currentReducerId),
          ),
        );
      const [currentReducer] = await tx
        .select({
          reducerKey: resultReducerVersions.reducerKey,
          createdAt: resultReducerVersions.createdAt,
        })
        .from(resultReducerVersions)
        .where(eq(resultReducerVersions.id, currentReducerId))
        .limit(1);
      if (!currentReducer)
        throw new Error("current reducer fixture was not found");
      const [legacyReducer] = await tx
        .insert(resultReducerVersions)
        .values({
          reducerKey: currentReducer.reducerKey,
          reducerVersion: `${PREFIX}-legacy-generic-409-v1`,
          buildId: `${PREFIX}-legacy-generic-409-build`,
          policySha256: "9".repeat(64),
          policy: { regression: "legacy-missing-unsteady-provenance" },
          source: "test",
          createdAt: new Date(currentReducer.createdAt.getTime() - 1_000),
        })
        .returning({ id: resultReducerVersions.id });
      if (!legacyReducer)
        throw new Error("legacy reducer fixture could not be created");
      await tx.insert(resultArchiveReductionQueue).values({
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
        reducerVersionId: legacyReducer.id,
        state: "missing_evidence",
        attemptCount: 1,
        lastError:
          'POST /internal/evidence-archives/reduce-clean-cycles → 409 {"detail":"raw archive is not marked as URANS evidence"}',
      });

      const admission = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });

      expect(admission).toMatchObject({
        reducerVersionId: currentReducerId,
        enqueued: 1,
        admittedResultAttemptIds: [fixture.resultAttemptId],
      });
      const rows = await tx
        .select({
          reducerVersionId: resultArchiveReductionQueue.reducerVersionId,
          state: resultArchiveReductionQueue.state,
        })
        .from(resultArchiveReductionQueue)
        .where(
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            fixture.resultAttemptId,
          ),
        );
      expect(rows).toEqual(
        expect.arrayContaining([
          { reducerVersionId: legacyReducer.id, state: "missing_evidence" },
          { reducerVersionId: currentReducerId, state: "pending" },
        ]),
      );
    });
  });

  it("cannot let an old V1 worker overwrite a V2 canonical selection that completed first", async () => {
    await withRolledBackFixture(async (tx) => {
      const fixture = await createExactArchiveFixture("stale-v1-after-v2", tx);
      const firstAdmission = await enqueueVerifiedArchiveReductions(tx, {
        resultAttemptIds: [fixture.resultAttemptId],
        limit: 1,
      });
      const v1 = firstAdmission.reducerVersionId;
      const [v1Row] = await tx
        .select({ reducerKey: resultReducerVersions.reducerKey })
        .from(resultReducerVersions)
        .where(eq(resultReducerVersions.id, v1))
        .limit(1);
      if (!v1Row)
        throw new Error("archive queue V1 reducer fixture was not found");
      const [v2] = await tx
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

      // V1 was admitted first but cannot be claimed yet; V2 is the later
      // release and completes first.  This models the real race where an old
      // reducer has already been queued while a rollout adds V2.
      await tx
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
      await tx.insert(resultArchiveReductionQueue).values({
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        sourceArchiveId: fixture.sourceArchiveId,
        reducerVersionId: v2.id,
        state: "pending",
        nextAttemptAt: new Date(),
      });

      await drainArchiveReductionQueue(
        tx,
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
      const [afterV2] = await tx
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
      await tx
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
        tx,
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
        tx
          .select({
            currentResultInterpretationId:
              results.currentResultInterpretationId,
            currentCanonicalSelectionId: results.currentCanonicalSelectionId,
          })
          .from(results)
          .where(eq(results.id, fixture.resultId))
          .limit(1),
        tx
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
