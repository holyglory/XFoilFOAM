/**
 * The historical released-evidence path is intentionally unlike an ordinary
 * archive backfill: it may append forensic/scientific interpretation evidence,
 * but it must never revive the result cell or cause another CFD obligation.
 *
 * This suite uses a real database receipt and the same certificate-valid
 * reducer payload as the live archive queue integration coverage.  Mocking the
 * staging/selection boundary here would miss the important guarantee: a
 * successful audit has exactly one immutable decision but no live projection
 * or scheduler side effect.
 */
import {
  airfoils,
  createClient,
  historicalArchiveAuditDecisions,
  resultAttempts,
  resultCanonicalSelections,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretationCycles,
  resultInterpretationRecoveryActions,
  resultInterpretations,
  resultMedia,
  results,
  polarFitSets,
  resultClassifications,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import {
  type ArchiveCleanCycleReductionResponse,
  type EngineClient,
  EngineError,
  URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
} from "@aerodb/engine-client";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "../../../packages/db/test/solver-fixture";
import {
  createArchiveInterpretationBackfillRun,
  createHistoricalReleasedArchiveAuditRun,
  discoverArchiveInterpretationBackfill,
  discoverHistoricalReleasedArchiveAuditCandidate,
  runArchiveInterpretationBackfill,
  upsertArchiveBackfillRecoveryAction,
} from "../src/result-interpretation-backfill";
import {
  HistoricalArchiveAuditClaimLostError,
  stageArchiveResultInterpretation,
} from "../src/result-interpretations";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `historical-audit-e2e-${process.pid}-${Date.now().toString(36)}`;
const STORED_SHA = "a".repeat(64);
const TAR_SHA = "b".repeat(64);

let airfoilId = "";
let bcId = "";
let revisionId = "";
let presetId = "";
let flowConditionId = "";
let referenceGeometryProfileId = "";
let revisionReynolds = 0;
let revisionMach: number | null = null;
let fixture: MinimalSolverFixture | null = null;
const resultIds: string[] = [];
const blobIds: string[] = [];
const runIds: string[] = [];
const campaignIds: string[] = [];

type ReleasedFixture = {
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  sourceArtifactId: string;
  blobId: string;
  aoaDeg: number;
};

type HistoricalAuditCampaignProjection = {
  campaignId: string;
  conditionId: string;
};

function cleanCycle(
  index: number,
  disposition: "startup" | "selected" | "settling_outlier",
) {
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

function acceptedReduction(aoaDeg: number): ArchiveCleanCycleReductionResponse {
  return {
    state: "accepted",
    inputEvidenceSignature: "c".repeat(64),
    point: {
      aoa_deg: aoaDeg,
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
    diagnostics: { source: "historical-released-evidence-audit-e2e" },
  };
}

/** A reducer may have scientifically useful evidence but need a bounded
 * additional tail.  For a released result this is an audit fact only: the
 * decision may carry the advisory, but must never create live recovery work. */
function continuationRequiredReduction(
  aoaDeg: number,
): ArchiveCleanCycleReductionResponse {
  const accepted = acceptedReduction(aoaDeg);
  const certificate = accepted.point.urans_cycle_certificate;
  if (!certificate) {
    throw new Error("fixture clean-cycle certificate is missing");
  }
  return {
    ...accepted,
    state: "continuation_required",
    point: {
      ...accepted.point,
      converged: false,
      urans_cycle_certificate: {
        ...certificate,
        certified: false,
        terminal_clean_cycles: 2,
        selected_cycle_start_index: null,
        cycles: [
          cleanCycle(0, "startup"),
          cleanCycle(1, "selected"),
          cleanCycle(2, "selected"),
          {
            ...cleanCycle(3, "settling_outlier"),
            reasons: ["terminal tail needs another clean period"],
          },
        ],
      },
    },
    diagnostics: {
      source: "historical-released-evidence-audit-e2e",
      recommendedAdditionalPeriods: 2,
    },
  };
}

/** A cadence-free archive can truthfully require a rerun.  The historical
 * route must retain that verdict without staging a fabricated interpretation
 * or submitting the physical rerun itself. */
function rerunRequiredReduction(
  aoaDeg: number,
): ArchiveCleanCycleReductionResponse {
  return {
    state: "rerun_required",
    inputEvidenceSignature: "c".repeat(64),
    point: {
      aoa_deg: aoaDeg,
      unsteady: true,
      converged: false,
      first_order_fallback: false,
      images: {},
    },
    diagnostics: {
      source: "historical-released-evidence-audit-e2e",
      reason: "no recoverable cadence in the retained archive",
    },
  };
}

/**
 * A rerun recommendation can still carry a complete cycle record. Historical
 * audit retains those cycles for diagnosis, but must stage them as terminal
 * scalar-free evidence rather than allowing the valid-looking point to appear
 * as an accepted coefficient.
 */
function rerunRequiredReductionWithCycleEvidence(
  aoaDeg: number,
): ArchiveCleanCycleReductionResponse {
  const accepted = acceptedReduction(aoaDeg);
  return {
    ...accepted,
    state: "rerun_required",
    diagnostics: {
      source: "historical-released-evidence-audit-e2e",
      reason: "retained cycles require a clean rerun before publication",
    },
  };
}

function acceptedEngine(aoaDeg: number): EngineClient {
  return {
    healthDetails: async () => ({
      status: "ok",
      version: "historical-audit-reducer-v1",
      archive_reduction_version: 3,
    }),
    reduceRemoteEvidenceCleanCycles: async () => acceptedReduction(aoaDeg),
  } as unknown as EngineClient;
}

async function createReleasedFixture(label: string): Promise<ReleasedFixture> {
  if (!fixture) throw new Error("minimal solver fixture is missing");
  const aoaDeg = 80_000 + (resultIds.length + 1) / 1_000;
  const [result] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
    })
    .returning({ id: results.id });
  if (!result) throw new Error("could not create historical-audit result");

  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      converged: true,
      evidencePayload: { fidelity: "urans_precalc" },
    })
    .returning({ id: resultAttempts.id });
  if (!attempt) throw new Error("could not create historical-audit attempt");

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
      sha256: STORED_SHA,
      byteSize: 101,
      metadata: {},
    })
    .returning({ id: solverEvidenceArtifacts.id });
  if (!artifact) throw new Error("could not create historical-audit artifact");

  // The archive's raw CFD result and the independently persisted URANS video
  // are both retained evidence.  The audit may inspect them; it must not
  // manufacture a replacement solve merely because it sees this history.
  await db.insert(resultMedia).values({
    resultId: result.id,
    resultAttemptId: attempt.id,
    kind: "video",
    field: "velocity_magnitude",
    role: "instantaneous",
    storageKey: `${PREFIX}/${label}/velocity_magnitude.mp4`,
    mimeType: "video/mp4",
    sha256: TAR_SHA,
    byteSize: 101,
  });

  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "historical-audit-e2e-bucket",
      objectKey: `${PREFIX}/${label}/evidence.tar.zst`,
      generation: `${1_000_000 + blobIds.length}`,
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: STORED_SHA,
      byteSize: 101,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: TAR_SHA,
      uncompressedTarByteSize: 202,
      verifiedAt: new Date(),
      metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    })
    .returning({ id: solverEvidenceBlobs.id });
  if (!blob) throw new Error("could not create historical-audit GCS blob");

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
  if (!archive) throw new Error("could not create historical-audit archive");

  // Model an actually released historical cell, rather than a newly inserted
  // result that merely happened to have null defaults: it once had a live
  // generation, and release deliberately cleared every projection pointer.
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, result.id));
  await db
    .update(results)
    .set({
      currentResultAttemptId: null,
      currentResultInterpretationId: null,
      currentCanonicalSelectionId: null,
    })
    .where(eq(results.id, result.id));

  resultIds.push(result.id);
  blobIds.push(blob.id);
  return {
    resultId: result.id,
    resultAttemptId: attempt.id,
    sourceArchiveId: archive.id,
    sourceArtifactId: artifact.id,
    blobId: blob.id,
    aoaDeg,
  };
}

/**
 * Attach a campaign cell with an intentionally all-zero materialized progress
 * row.  A normal archive publication refresh would recompute this row; a
 * historical audit has no authority to touch either the campaign projection
 * or the polar cache.  Snapshotting this exact isolated cell makes that
 * otherwise invisible no-side-effect guarantee observable end to end.
 */
async function attachHistoricalAuditCampaignProjection(
  source: ReleasedFixture,
): Promise<HistoricalAuditCampaignProjection> {
  if (!fixture) throw new Error("minimal solver fixture is missing");
  const suffix = campaignIds.length + 1;
  const [campaign] = await db
    .insert(simCampaigns)
    .values({
      slug: `${PREFIX}-campaign-${suffix}`,
      name: `${PREFIX} historical audit campaign ${suffix}`,
      idempotencyKey: `${PREFIX}-campaign-${suffix}`,
      status: "active",
      currentConditionGeneration: 1,
    })
    .returning({ id: simCampaigns.id });
  if (!campaign) {
    throw new Error("could not create historical audit campaign");
  }
  campaignIds.push(campaign.id);

  const [plan] = await db
    .insert(simCampaignPlanRevisions)
    .values({
      campaignId: campaign.id,
      revisionNumber: 1,
      kind: "initial",
      plan: { fixture: PREFIX, kind: "historical-audit" },
      summary: { fixture: PREFIX, kind: "historical-audit" },
      createdBy: "test:historical-released-audit-e2e",
    })
    .returning({ id: simCampaignPlanRevisions.id });
  if (!plan) throw new Error("could not create historical audit plan");
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
      flowConditionId,
      referenceGeometryProfileId,
      presetId,
      simulationPresetRevisionId: revisionId,
      reynolds: revisionReynolds,
      mach: revisionMach,
      status: "active",
      introducedInPlanRevisionId: plan.id,
    })
    .returning({ id: simCampaignConditions.id });
  if (!condition) {
    throw new Error("could not create historical audit condition");
  }

  await db.insert(simCampaignPoints).values({
    campaignId: campaign.id,
    conditionId: condition.id,
    airfoilId,
    aoaDeg: source.aoaDeg,
    revisionId,
    planRevisionNumber: 1,
    state: "terminal",
    resultId: source.resultId,
    resultAttemptId: source.resultAttemptId,
    derivedBySymmetry: false,
  });
  // A live publication refresh would replace this deliberately inert snapshot
  // with a derived counter set.  The audit must leave it byte-for-byte alone.
  await db.insert(simCampaignProgress).values({
    campaignId: campaign.id,
    conditionId: condition.id,
    airfoilId,
  });
  return { campaignId: campaign.id, conditionId: condition.id };
}

beforeAll(async () => {
  fixture = await createMinimalSolverFixture(db, PREFIX);
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  if (!airfoil) throw new Error("seeded airfoil fixture is required");
  airfoilId = airfoil.id;
  bcId = fixture.bcId;
  revisionId = fixture.revisionId;
  const [revision] = await db
    .select({
      presetId: simulationPresets.id,
      flowConditionId: simulationPresets.flowConditionId,
      referenceGeometryProfileId:
        simulationPresets.referenceGeometryProfileId,
      reynolds: simulationPresetRevisions.reynolds,
      mach: simulationPresetRevisions.mach,
    })
    .from(simulationPresetRevisions)
    .innerJoin(
      simulationPresets,
      eq(simulationPresets.id, simulationPresetRevisions.presetId),
    )
    .where(eq(simulationPresetRevisions.id, revisionId))
    .limit(1);
  if (!revision) {
    throw new Error("historical audit revision fixture is missing");
  }
  presetId = revision.presetId;
  flowConditionId = revision.flowConditionId;
  referenceGeometryProfileId = revision.referenceGeometryProfileId;
  revisionReynolds = revision.reynolds;
  revisionMach = revision.mach;
});

afterAll(async () => {
  // Delete result-owned immutable records before their durable run containers,
  // then remove exact GCS blobs that have no remaining archive owner.
  for (const campaignId of campaignIds) {
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  }
  for (const resultId of resultIds) {
    await db
      .update(results)
      .set({
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      })
      .where(eq(results.id, resultId));
    await db.delete(results).where(eq(results.id, resultId));
  }
  if (runIds.length) {
    await db
      .delete(resultInterpretationBackfillRuns)
      .where(inArray(resultInterpretationBackfillRuns.id, runIds));
  }
  for (const blobId of blobIds) {
    await db.delete(solverEvidenceBlobs).where(eq(solverEvidenceBlobs.id, blobId));
  }
  await fixture?.cleanup();
  await sql.end();
});

describe("historical released GCS evidence audit end to end", () => {
  it("MUST-CATCH: an inert legacy action may adopt each missing authenticated clean-tail field once, but never overwrite either field or a routed action", async () => {
    const source = await createReleasedFixture("pending-action-adoption");
    const handoff = {
      contract: "archive-clean-cycle-recovery-handoff-v1" as const,
      action: "continue_exact_case" as const,
      scheduled: false as const,
      reducerState: "continuation_required" as const,
      fidelity: "urans_precalc" as const,
      resultId: source.resultId,
      resultAttemptId: source.resultAttemptId,
      sourceArchiveId: source.sourceArchiveId,
      inputEvidenceSignature: STORED_SHA,
    };
    try {
      await upsertArchiveBackfillRecoveryAction(db, {
        ...handoff,
        correctiveTailPeriods: null,
        cleanCycleRecoveryPolicyVersion: null,
      });
      await upsertArchiveBackfillRecoveryAction(db, {
        ...handoff,
        correctiveTailPeriods: 2,
        cleanCycleRecoveryPolicyVersion: null,
      });
      await upsertArchiveBackfillRecoveryAction(db, {
        ...handoff,
        correctiveTailPeriods: 3,
        cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2",
      });

      const [enriched] = await db
        .select({
          id: resultInterpretationRecoveryActions.id,
          state: resultInterpretationRecoveryActions.state,
          correctiveTailPeriods:
            resultInterpretationRecoveryActions.correctiveTailPeriods,
          cleanCycleRecoveryPolicyVersion:
            resultInterpretationRecoveryActions.cleanCycleRecoveryPolicyVersion,
        })
        .from(resultInterpretationRecoveryActions)
        .where(
          and(
            eq(resultInterpretationRecoveryActions.resultAttemptId, source.resultAttemptId),
            eq(resultInterpretationRecoveryActions.sourceArchiveId, source.sourceArchiveId),
          ),
        );
      expect(enriched).toMatchObject({
        state: "pending",
        correctiveTailPeriods: 2,
        cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2",
      });

      // A replay cannot replace the first authenticated value. Once the
      // scheduler has routed the action, it cannot even alter an omitted one.
      await upsertArchiveBackfillRecoveryAction(db, {
        ...handoff,
        correctiveTailPeriods: 1,
        cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2",
      });
      await db
        .update(resultInterpretationRecoveryActions)
        .set({
          state: "routing",
          claimToken: randomUUID(),
          claimExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(resultInterpretationRecoveryActions.id, enriched!.id));
      await upsertArchiveBackfillRecoveryAction(db, {
        ...handoff,
        correctiveTailPeriods: 3,
        cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2",
      });
      const [immutable] = await db
        .select({
          state: resultInterpretationRecoveryActions.state,
          correctiveTailPeriods:
            resultInterpretationRecoveryActions.correctiveTailPeriods,
          cleanCycleRecoveryPolicyVersion:
            resultInterpretationRecoveryActions.cleanCycleRecoveryPolicyVersion,
        })
        .from(resultInterpretationRecoveryActions)
        .where(eq(resultInterpretationRecoveryActions.id, enriched!.id));
      expect(immutable).toEqual({
        state: "routing",
        correctiveTailPeriods: 2,
        cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2",
      });
    } finally {
      await db
        .delete(resultInterpretationRecoveryActions)
        .where(
          and(
            eq(resultInterpretationRecoveryActions.resultAttemptId, source.resultAttemptId),
            eq(resultInterpretationRecoveryActions.sourceArchiveId, source.sourceArchiveId),
          ),
        );
    }
  });

  it("MUST-CATCH: records exactly one audit interpretation and decision without reviving or scheduling a released result", async () => {
    const source = await createReleasedFixture("accepted-audit");
    const receipt = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource: {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      },
      requestedBy: "test:historical-released-audit-e2e",
    });
    runIds.push(receipt.runId);
    expect(receipt.enqueued).toBe(1);

    const report = await runArchiveInterpretationBackfill({
      db,
      engine: acceptedEngine(source.aoaDeg),
      runId: receipt.runId,
      maxItems: 1,
      historicalAuditExactSource: {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      },
    });
    expect(report).toMatchObject({
      state: "completed",
      processed: 1,
      canonicalSelectionsCreated: 0,
      resultProjectionsUpdated: 0,
      counts: { reduced: 1 },
    });

    const [resultRows, interpretations, decisions, canonicalSelections, recoveryActions, requests, verifyItems, runRows, itemRows] =
      await Promise.all([
        db
          .select({
            currentResultAttemptId: results.currentResultAttemptId,
            currentResultInterpretationId:
              results.currentResultInterpretationId,
            currentCanonicalSelectionId: results.currentCanonicalSelectionId,
          })
          .from(results)
          .where(eq(results.id, source.resultId)),
        db
          .select({
            id: resultInterpretations.id,
            source: resultInterpretations.source,
            state: resultInterpretations.state,
          })
          .from(resultInterpretations)
          .where(
            and(
              eq(resultInterpretations.resultId, source.resultId),
              eq(resultInterpretations.resultAttemptId, source.resultAttemptId),
              eq(resultInterpretations.sourceArchiveId, source.sourceArchiveId),
            ),
          ),
        db
          .select({
            auditRunId: historicalArchiveAuditDecisions.auditRunId,
            resultInterpretationId:
              historicalArchiveAuditDecisions.resultInterpretationId,
            reducerState: historicalArchiveAuditDecisions.reducerState,
            advisoryContinuationAction:
              historicalArchiveAuditDecisions.advisoryContinuationAction,
          })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
        db
          .select({ id: resultCanonicalSelections.id })
          .from(resultCanonicalSelections)
          .where(eq(resultCanonicalSelections.resultId, source.resultId)),
        db
          .select({ id: resultInterpretationRecoveryActions.id })
          .from(resultInterpretationRecoveryActions)
          .where(eq(resultInterpretationRecoveryActions.resultId, source.resultId)),
        db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, airfoilId),
              eq(simUransRequests.revisionId, revisionId),
              eq(simUransRequests.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select({ id: simUransVerifyQueue.id })
          .from(simUransVerifyQueue)
          .where(
            and(
              eq(simUransVerifyQueue.airfoilId, airfoilId),
              eq(simUransVerifyQueue.revisionId, revisionId),
              eq(simUransVerifyQueue.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select({
            state: resultInterpretationBackfillRuns.state,
            summary: resultInterpretationBackfillRuns.summary,
          })
          .from(resultInterpretationBackfillRuns)
          .where(eq(resultInterpretationBackfillRuns.id, receipt.runId)),
        db
          .select({
            state: resultInterpretationBackfillItems.state,
            resultInterpretationId:
              resultInterpretationBackfillItems.resultInterpretationId,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
      ]);

    expect(resultRows).toEqual([
      {
        currentResultAttemptId: null,
        currentResultInterpretationId: null,
        currentCanonicalSelectionId: null,
      },
    ]);
    expect(interpretations).toHaveLength(1);
    expect(interpretations[0]).toMatchObject({
      source: "historical_archive_audit",
      state: "accepted",
    });
    expect(decisions).toEqual([
      {
        auditRunId: receipt.runId,
        resultInterpretationId: interpretations[0]?.id,
        reducerState: "accepted",
        advisoryContinuationAction: null,
      },
    ]);
    expect(canonicalSelections).toEqual([]);
    expect(recoveryActions).toEqual([]);
    expect(requests).toEqual([]);
    expect(verifyItems).toEqual([]);
    expect(runRows).toEqual([
      {
        state: "completed",
        summary: expect.objectContaining({
          canonicalSelectionsCreated: 0,
          resultProjectionsUpdated: 0,
          historicalAuditDecisions: 1,
          historicalAuditIncomplete: false,
        }),
      },
    ]);
    expect(itemRows).toEqual([
      {
        state: "reduced",
        resultInterpretationId: interpretations[0]?.id,
      },
    ]);
  });

  it.each(["cancelled", "failed"] as const)(
    "MUST-CATCH: a %s audit parent cannot lease its pending child or start the reducer",
    async (terminalState) => {
      const source = await createReleasedFixture(
        `terminal-parent-${terminalState}`,
      );
      const exactSource = {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      };
      const receipt = await createHistoricalReleasedArchiveAuditRun({
        db,
        exactSource,
        requestedBy: `test:historical-audit-terminal-parent-${terminalState}`,
      });
      runIds.push(receipt.runId);

      // A terminal parent is forensic history, not an inactive queue that a
      // later generic drainer may reclaim. The child remains pending so no
      // reducer I/O or fabricated terminal scientific outcome is possible.
      await db
        .update(resultInterpretationBackfillRuns)
        .set({ state: terminalState, completedAt: new Date() })
        .where(eq(resultInterpretationBackfillRuns.id, receipt.runId));

      let reducerCalls = 0;
      const report = await runArchiveInterpretationBackfill({
        db,
        engine: {
          reduceRemoteEvidenceCleanCycles: async () => {
            reducerCalls += 1;
            return acceptedReduction(source.aoaDeg);
          },
        } as unknown as EngineClient,
        runId: receipt.runId,
        maxItems: 1,
        historicalAuditExactSource: exactSource,
      });

      expect(reducerCalls).toBe(0);
      expect(report).toMatchObject({
        state: terminalState,
        processed: 0,
        counts: { pending: 1 },
        canonicalSelectionsCreated: 0,
        resultProjectionsUpdated: 0,
      });

      const [items, decisions] = await Promise.all([
        db
          .select({
            state: resultInterpretationBackfillItems.state,
            attemptCount: resultInterpretationBackfillItems.attemptCount,
            claimToken: resultInterpretationBackfillItems.claimToken,
            claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
        db
          .select({ id: historicalArchiveAuditDecisions.id })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
      ]);
      expect(items).toEqual([
        {
          state: "pending",
          attemptCount: 0,
          claimToken: null,
          claimExpiresAt: null,
        },
      ]);
      expect(decisions).toEqual([]);
    },
  );

  it.each(["cancelled", "failed"] as const)(
    "MUST-CATCH: a %s parent committed after activation but before claim cannot start audit reducer I/O",
    async (terminalState) => {
      const source = await createReleasedFixture(
        `terminal-parent-after-activation-${terminalState}`,
      );
      const exactSource = {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      };
      const receipt = await createHistoricalReleasedArchiveAuditRun({
        db,
        exactSource,
        requestedBy:
          `test:historical-audit-terminal-parent-after-activation-${terminalState}`,
      });
      runIds.push(receipt.runId);
      // The receipt is created running by the explicit audit command. Do not
      // manufacture a running -> planned reversal here: terminal-state fences
      // deliberately allow only planned -> running and running settlement.
      // Interpose at the child-claim transaction boundary so this test proves
      // the claim's own locked parent-state recheck—not merely the run's
      // initial terminal-state short-circuit. No production hook is added for
      // this test.
      let terminalStateCommittedBetweenActivationAndClaim = false;
      const dbWithTerminalParentRace = new Proxy(db, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== "transaction") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            if (!terminalStateCommittedBetweenActivationAndClaim) {
              const [activatedRun] = await db
                .select({ state: resultInterpretationBackfillRuns.state })
                .from(resultInterpretationBackfillRuns)
                .where(eq(resultInterpretationBackfillRuns.id, receipt.runId));
              expect(activatedRun).toEqual({ state: "running" });
              const [terminalRun] = await db
                .update(resultInterpretationBackfillRuns)
                .set({ state: terminalState, completedAt: new Date() })
                .where(eq(resultInterpretationBackfillRuns.id, receipt.runId))
                .returning({ id: resultInterpretationBackfillRuns.id });
              expect(terminalRun).toEqual({ id: receipt.runId });
              terminalStateCommittedBetweenActivationAndClaim = true;
            }
            return Reflect.apply(
              value as (...transactionArgs: unknown[]) => unknown,
              target,
              args,
            );
          };
        },
      }) as typeof db;

      let reducerCalls = 0;
      const report = await runArchiveInterpretationBackfill({
        db: dbWithTerminalParentRace,
        engine: {
          reduceRemoteEvidenceCleanCycles: async () => {
            reducerCalls += 1;
            return acceptedReduction(source.aoaDeg);
          },
        } as unknown as EngineClient,
        runId: receipt.runId,
        maxItems: 1,
        historicalAuditExactSource: exactSource,
      });

      expect(terminalStateCommittedBetweenActivationAndClaim).toBe(true);
      expect(reducerCalls).toBe(0);
      expect(report).toMatchObject({
        state: terminalState,
        processed: 0,
        counts: { pending: 1 },
        canonicalSelectionsCreated: 0,
        resultProjectionsUpdated: 0,
      });

      const [items, decisions] = await Promise.all([
        db
          .select({
            state: resultInterpretationBackfillItems.state,
            attemptCount: resultInterpretationBackfillItems.attemptCount,
            claimToken: resultInterpretationBackfillItems.claimToken,
            claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
        db
          .select({ id: historicalArchiveAuditDecisions.id })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
      ]);
      expect(items).toEqual([
        {
          state: "pending",
          attemptCount: 0,
          claimToken: null,
          claimExpiresAt: null,
        },
      ]);
      expect(decisions).toEqual([]);
    },
  );

  it("MUST-CATCH: a historical audit interpretation never suppresses a later queue-authorized publication for the same live archive", async () => {
    const source = await createReleasedFixture("audit-does-not-suppress-live");
    const audit = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource: {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      },
      requestedBy: "test:historical-audit-source-is-not-publication-source",
    });
    runIds.push(audit.runId);

    await runArchiveInterpretationBackfill({
      db,
      engine: acceptedEngine(source.aoaDeg),
      runId: audit.runId,
      maxItems: 1,
      historicalAuditExactSource: {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      },
    });

    const historicalRows = await db
      .select({ source: resultInterpretations.source })
      .from(resultInterpretations)
      .where(
        and(
          eq(resultInterpretations.resultId, source.resultId),
          eq(resultInterpretations.resultAttemptId, source.resultAttemptId),
          eq(resultInterpretations.sourceArchiveId, source.sourceArchiveId),
        ),
      );
    expect(historicalRows).toEqual([
      { source: "historical_archive_audit" },
    ]);

    // A later explicit operator action may make the result live again. It
    // still needs the queue-owned interpretation path; historical scientific
    // provenance must not masquerade as an archive_backfill row merely
    // because reducer version and source archive happen to match.
    await db
      .update(results)
      .set({ currentResultAttemptId: source.resultAttemptId })
      .where(eq(results.id, source.resultId));

    const discovery = await discoverArchiveInterpretationBackfill(db, {
      reducerVersionId: audit.reducerVersionId,
      scope: {
        resultIds: [source.resultId],
        resultAttemptIds: [source.resultAttemptId],
        limit: 1,
      },
    });
    expect(discovery).toMatchObject({
      scanned: 1,
      skippedExistingInterpretations: 0,
      candidates: [
        {
          resultId: source.resultId,
          resultAttemptId: source.resultAttemptId,
          sourceArchiveId: source.sourceArchiveId,
        },
      ],
    });

    const queueRun = await createArchiveInterpretationBackfillRun({
      db,
      reducerVersionId: audit.reducerVersionId,
      scope: {
        resultIds: [source.resultId],
        resultAttemptIds: [source.resultAttemptId],
        limit: 1,
      },
      requestedBy: "test:normal-publication-after-historical-audit",
    });
    runIds.push(queueRun.runId);
    expect(queueRun).toMatchObject({
      enqueued: 1,
      skippedExistingInterpretations: 0,
      state: "running",
    });
  });

  it.each([
    {
      label: "a released result is not done",
      invalidate: async (source: ReleasedFixture) => {
        await db
          .update(results)
          .set({ status: "running" })
          .where(eq(results.id, source.resultId));
      },
    },
    {
      label: "a released result is not solver-owned",
      invalidate: async (source: ReleasedFixture) => {
        await db
          .update(results)
          .set({ source: "queued" })
          .where(eq(results.id, source.resultId));
      },
    },
    {
      label: "the exact archive source artifact is not an archive bundle",
      invalidate: async (source: ReleasedFixture) => {
        await db
          .update(solverEvidenceArtifacts)
          .set({ kind: "log" })
          .where(eq(solverEvidenceArtifacts.id, source.sourceArtifactId));
      },
    },
    {
      label: "the exact archive source artifact is missing",
      invalidate: async (source: ReleasedFixture) => {
        // The archive references this artifact through the same exact-owner
        // foreign key the admission query repeats. Its removal cascades that
        // archive, so the old sourceArchiveId cannot become a loose blob
        // pointer for an audit.
        await db
          .delete(solverEvidenceArtifacts)
          .where(eq(solverEvidenceArtifacts.id, source.sourceArtifactId));
      },
    },
    {
      label: "the exact GCS object key contains a traversal segment",
      invalidate: async (source: ReleasedFixture) => {
        await db
          .update(solverEvidenceBlobs)
          .set({ objectKey: `${PREFIX}/safe/../invalid/evidence.tar.zst` })
          .where(eq(solverEvidenceBlobs.id, source.blobId));
      },
    },
  ])(
    "MUST-CATCH: planning and admission reject when $label before any audit receipt or reducer I/O",
    async ({ label, invalidate }) => {
      const source = await createReleasedFixture(
        `invalid-admission-${label.replace(/[^a-z]+/gi, "-").toLowerCase()}`,
      );
      await invalidate(source);
      const exactSource = {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      };

      // Planning uses the same strict source proof as the pre-I/O worker
      // guard.  A null candidate means the CLI cannot create a reducer task.
      await expect(
        discoverHistoricalReleasedArchiveAuditCandidate(db, exactSource),
      ).resolves.toBeNull();
      await expect(
        createHistoricalReleasedArchiveAuditRun({
          db,
          exactSource,
          requestedBy: "test:historical-released-audit-invalid-admission",
        }),
      ).rejects.toThrow(/released completed solved result|exact current GCS archive/);

      // With no durable child receipt, there is no run id that can be handed
      // to the reducer.  Assert all durable output rows are absent rather
      // than relying on a mock engine that the admission path should never
      // know about.
      const [items, interpretations, decisions] = await Promise.all([
        db
          .select({ id: resultInterpretationBackfillItems.id })
          .from(resultInterpretationBackfillItems)
          .where(
            and(
              eq(resultInterpretationBackfillItems.resultId, source.resultId),
              eq(
                resultInterpretationBackfillItems.resultAttemptId,
                source.resultAttemptId,
              ),
              eq(
                resultInterpretationBackfillItems.sourceArchiveId,
                source.sourceArchiveId,
              ),
            ),
          ),
        db
          .select({ id: resultInterpretations.id })
          .from(resultInterpretations)
          .where(eq(resultInterpretations.resultId, source.resultId)),
        db
          .select({ id: historicalArchiveAuditDecisions.id })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.resultId, source.resultId)),
      ]);
      expect(items).toEqual([]);
      expect(interpretations).toEqual([]);
      expect(decisions).toEqual([]);
    },
  );

  it("MUST-CATCH: if the released-state proof changes before settlement, the audit fails incomplete without a decision or CFD work", async () => {
    const source = await createReleasedFixture("source-revived-before-run");
    const receipt = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource: {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      },
      requestedBy: "test:historical-released-audit-e2e-revived-source",
    });
    runIds.push(receipt.runId);

    // Admission was valid, but another canonical workflow restored a live
    // generation before this audit could claim its reducer result.  This must
    // not be treated as a retryable CFD failure: the immutable audit receipt
    // becomes terminal/incomplete and emits no decision.
    await db
      .update(results)
      .set({ currentResultAttemptId: source.resultAttemptId })
      .where(eq(results.id, source.resultId));

    let reducerCalls = 0;
    const report = await runArchiveInterpretationBackfill({
      db,
      engine: {
        healthDetails: async () => ({
          status: "ok",
          version: "historical-audit-reducer-v1",
          archive_reduction_version: 3,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          return acceptedReduction(source.aoaDeg);
        },
      } as unknown as EngineClient,
      runId: receipt.runId,
      maxItems: 1,
      historicalAuditExactSource: {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      },
    });
    expect(reducerCalls).toBe(0);
    expect(report).toMatchObject({
      state: "failed",
      processed: 1,
      canonicalSelectionsCreated: 0,
      resultProjectionsUpdated: 0,
      counts: { failed: 1 },
    });

    const [interpretations, decisions, canonicalSelections, recoveryActions, requests, verifyItems, runRows, itemRows] =
      await Promise.all([
        db
          .select({ id: resultInterpretations.id })
          .from(resultInterpretations)
          .where(eq(resultInterpretations.resultId, source.resultId)),
        db
          .select({ id: historicalArchiveAuditDecisions.id })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
        db
          .select({ id: resultCanonicalSelections.id })
          .from(resultCanonicalSelections)
          .where(eq(resultCanonicalSelections.resultId, source.resultId)),
        db
          .select({ id: resultInterpretationRecoveryActions.id })
          .from(resultInterpretationRecoveryActions)
          .where(eq(resultInterpretationRecoveryActions.resultId, source.resultId)),
        db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, airfoilId),
              eq(simUransRequests.revisionId, revisionId),
              eq(simUransRequests.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select({ id: simUransVerifyQueue.id })
          .from(simUransVerifyQueue)
          .where(
            and(
              eq(simUransVerifyQueue.airfoilId, airfoilId),
              eq(simUransVerifyQueue.revisionId, revisionId),
              eq(simUransVerifyQueue.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select({
            state: resultInterpretationBackfillRuns.state,
            summary: resultInterpretationBackfillRuns.summary,
          })
          .from(resultInterpretationBackfillRuns)
          .where(eq(resultInterpretationBackfillRuns.id, receipt.runId)),
        db
          .select({
            state: resultInterpretationBackfillItems.state,
            claimToken: resultInterpretationBackfillItems.claimToken,
            claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
            resultInterpretationId:
              resultInterpretationBackfillItems.resultInterpretationId,
            historicalAuditDecisionId:
              resultInterpretationBackfillItems.historicalAuditDecisionId,
            historicalAuditReducerState:
              resultInterpretationBackfillItems.historicalAuditReducerState,
            historicalAuditInputEvidenceSignature:
              resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
      ]);
    expect(interpretations).toEqual([]);
    expect(decisions).toEqual([]);
    expect(canonicalSelections).toEqual([]);
    expect(recoveryActions).toEqual([]);
    expect(requests).toEqual([]);
    expect(verifyItems).toEqual([]);
    expect(itemRows).toEqual([
      {
        state: "failed",
        claimToken: null,
        claimExpiresAt: null,
        resultInterpretationId: null,
        historicalAuditDecisionId: null,
        historicalAuditReducerState: null,
        historicalAuditInputEvidenceSignature: null,
      },
    ]);
    expect(runRows).toEqual([
      {
        state: "failed",
        summary: expect.objectContaining({
          canonicalSelectionsCreated: 0,
          resultProjectionsUpdated: 0,
          historicalAuditDecisions: 0,
          historicalAuditIncomplete: true,
          historicalAuditIncompleteReason: expect.stringContaining(
            "one-to-one completion",
          ),
        }),
      },
    ]);
  });

  it.each([409, 422] as const)(
    "MUST-CATCH: answered reducer status %i leaves a historical audit operationally failed without a scientific decision",
    async (status) => {
      const source = await createReleasedFixture(`answered-${status}`);
      const exactSource = {
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
      };
      const receipt = await createHistoricalReleasedArchiveAuditRun({
        db,
        exactSource,
        requestedBy: `test:historical-audit-answered-${status}`,
      });
      runIds.push(receipt.runId);

      let reducerCalls = 0;
      const rejectedEngine = {
        healthDetails: async () => ({
          status: "ok",
          version: "historical-audit-reducer-v1",
          archive_reduction_version: 3,
        }),
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          throw new EngineError(`reducer rejected ${status}`, status);
        },
      } as unknown as EngineClient;

      const report = await runArchiveInterpretationBackfill({
        db,
        engine: rejectedEngine,
        runId: receipt.runId,
        maxItems: 1,
        historicalAuditExactSource: exactSource,
      });
      expect(reducerCalls).toBe(1);
      expect(report).toMatchObject({
        state: "failed",
        processed: 1,
        canonicalSelectionsCreated: 0,
        resultProjectionsUpdated: 0,
        counts: { failed: 1 },
      });

      const [items, decisions, interpretations, runRows] = await Promise.all([
        db
          .select({
            state: resultInterpretationBackfillItems.state,
            claimToken: resultInterpretationBackfillItems.claimToken,
            claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
            resultInterpretationId:
              resultInterpretationBackfillItems.resultInterpretationId,
            historicalAuditDecisionId:
              resultInterpretationBackfillItems.historicalAuditDecisionId,
            historicalAuditReducerState:
              resultInterpretationBackfillItems.historicalAuditReducerState,
            historicalAuditInputEvidenceSignature:
              resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature,
            lastError: resultInterpretationBackfillItems.lastError,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
        db
          .select({ id: historicalArchiveAuditDecisions.id })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
        db
          .select({ id: resultInterpretations.id })
          .from(resultInterpretations)
          .where(eq(resultInterpretations.resultId, source.resultId)),
        db
          .select({
            state: resultInterpretationBackfillRuns.state,
            summary: resultInterpretationBackfillRuns.summary,
          })
          .from(resultInterpretationBackfillRuns)
          .where(eq(resultInterpretationBackfillRuns.id, receipt.runId)),
      ]);

      // A 409/422 is an operationally incomplete audit, not scientific
      // `missing_evidence`: the engine never produced a reducer verdict.
      // The receipt must drain with no lease, decision, interpretation, or
      // reverse decision provenance that could falsely look complete.
      expect(items).toEqual([
        {
          state: "failed",
          claimToken: null,
          claimExpiresAt: null,
          resultInterpretationId: null,
          historicalAuditDecisionId: null,
          historicalAuditReducerState: null,
          historicalAuditInputEvidenceSignature: null,
          lastError: expect.stringContaining(`reducer rejected ${status}`),
        },
      ]);
      expect(decisions).toEqual([]);
      expect(interpretations).toEqual([]);
      expect(runRows).toEqual([
        {
          state: "failed",
          summary: expect.objectContaining({
            counts: expect.objectContaining({ failed: 1 }),
            historicalAuditDecisions: 0,
            historicalAuditIncomplete: true,
          }),
        },
      ]);

      // A failed historical audit is not a generic queue retry. Re-entering
      // the runner only reports the preserved incomplete receipt and must not
      // call the reducer again.
      const replay = await runArchiveInterpretationBackfill({
        db,
        engine: rejectedEngine,
        runId: receipt.runId,
        maxItems: 1,
        historicalAuditExactSource: exactSource,
      });
      expect(reducerCalls).toBe(1);
      expect(replay).toMatchObject({
        state: "failed",
        processed: 0,
        counts: { failed: 1 },
      });
    },
  );

  it("MUST-CATCH: a reducer-time revival of the result fails the original audit receipt without retrying CFD", async () => {
    const source = await createReleasedFixture("reducer-time-source-revival");
    const exactSource = {
      resultId: source.resultId,
      resultAttemptId: source.resultAttemptId,
      sourceArchiveId: source.sourceArchiveId,
    };
    const receipt = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource,
      requestedBy: "test:historical-audit-reducer-time-source-revival",
    });
    runIds.push(receipt.runId);

    let reducerCalls = 0;
    const racingEngine = {
      healthDetails: async () => ({
        status: "ok",
        version: "historical-audit-reducer-v1",
        archive_reduction_version: 3,
      }),
      reduceRemoteEvidenceCleanCycles: async () => {
        reducerCalls += 1;
        // The source was valid at audit admission and immediately before the
        // remote reducer call. A competing workflow makes it live only while
        // that reducer is executing; staging must re-check under its result
        // lock, roll back, and settle this original audit as operationally
        // failed rather than leave it hydrating or issue another reduction.
        await db
          .update(results)
          .set({ currentResultAttemptId: source.resultAttemptId })
          .where(eq(results.id, source.resultId));
        return acceptedReduction(source.aoaDeg);
      },
    } as unknown as EngineClient;

    const report = await runArchiveInterpretationBackfill({
      db,
      engine: racingEngine,
      runId: receipt.runId,
      maxItems: 1,
      historicalAuditExactSource: exactSource,
    });
    expect(reducerCalls).toBe(1);
    expect(report).toMatchObject({
      state: "failed",
      processed: 1,
      counts: { failed: 1 },
      canonicalSelectionsCreated: 0,
      resultProjectionsUpdated: 0,
    });

    const [resultRows, items, interpretations, decisions] = await Promise.all([
      db
        .select({ currentResultAttemptId: results.currentResultAttemptId })
        .from(results)
        .where(eq(results.id, source.resultId)),
      db
        .select({
          state: resultInterpretationBackfillItems.state,
          claimToken: resultInterpretationBackfillItems.claimToken,
          claimExpiresAt: resultInterpretationBackfillItems.claimExpiresAt,
          resultInterpretationId:
            resultInterpretationBackfillItems.resultInterpretationId,
          historicalAuditDecisionId:
            resultInterpretationBackfillItems.historicalAuditDecisionId,
          historicalAuditReducerState:
            resultInterpretationBackfillItems.historicalAuditReducerState,
          historicalAuditInputEvidenceSignature:
            resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature,
        })
        .from(resultInterpretationBackfillItems)
        .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
      db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(eq(resultInterpretations.resultId, source.resultId)),
      db
        .select({ id: historicalArchiveAuditDecisions.id })
        .from(historicalArchiveAuditDecisions)
        .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
    ]);
    expect(resultRows).toEqual([
      { currentResultAttemptId: source.resultAttemptId },
    ]);
    expect(items).toEqual([
      {
        state: "failed",
        claimToken: null,
        claimExpiresAt: null,
        resultInterpretationId: null,
        historicalAuditDecisionId: null,
        historicalAuditReducerState: null,
        historicalAuditInputEvidenceSignature: null,
      },
    ]);
    expect(interpretations).toEqual([]);
    expect(decisions).toEqual([]);

    const replay = await runArchiveInterpretationBackfill({
      db,
      engine: racingEngine,
      runId: receipt.runId,
      maxItems: 1,
      historicalAuditExactSource: exactSource,
    });
    expect(reducerCalls).toBe(1);
    expect(replay).toMatchObject({
      state: "failed",
      processed: 0,
      counts: { failed: 1 },
    });
  });

  it("MUST-CATCH: a truthy historical finalizer without the exact child decision receipt rolls back staging", async () => {
    const source = await createReleasedFixture("truthy-finalizer-without-receipt");
    const exactSource = {
      resultId: source.resultId,
      resultAttemptId: source.resultAttemptId,
      sourceArchiveId: source.sourceArchiveId,
    };
    const receipt = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource,
      requestedBy: "test:historical-audit-truthy-finalizer-without-receipt",
    });
    runIds.push(receipt.runId);

    const [item] = await db
      .select({ id: resultInterpretationBackfillItems.id })
      .from(resultInterpretationBackfillItems)
      .where(eq(resultInterpretationBackfillItems.runId, receipt.runId))
      .limit(1);
    if (!item) throw new Error("historical audit item is missing");

    const claimToken = "test-truthy-finalizer-without-receipt";
    await db
      .update(resultInterpretationBackfillItems)
      .set({
        state: "hydrating",
        attemptCount: 1,
        claimToken,
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(resultInterpretationBackfillItems.id, item.id));

    const reduction = acceptedReduction(source.aoaDeg);
    let finalizerCalls = 0;
    await expect(
      stageArchiveResultInterpretation({
        db,
        resultId: source.resultId,
        resultAttemptId: source.resultAttemptId,
        sourceArchiveId: source.sourceArchiveId,
        reducerVersionId: receipt.reducerVersionId,
        backfillRunId: receipt.runId,
        authority: {
          kind: "historical_released_audit",
          auditClaim: {
            backfillItemId: item.id,
            backfillClaimToken: claimToken,
          },
        },
        inputEvidenceSignature: reduction.inputEvidenceSignature,
        historicalAuditDecision: {
          inputEvidenceSignature: reduction.inputEvidenceSignature,
          reducerState: "accepted",
          advisoryContinuationAction: null,
          advisoryTailPeriods: null,
          diagnostics: { fixture: "truthy-finalizer-without-receipt" },
        },
        historicalAuditFinalize: async () => {
          finalizerCalls += 1;
          // This models an accidental no-op in the work-receipt layer.  The
          // immutable staging transaction must not trust the boolean alone.
          return true;
        },
        point: reduction.point,
        fidelity: "urans_precalc",
        diagnostics: reduction.diagnostics,
      }),
    ).rejects.toBeInstanceOf(HistoricalArchiveAuditClaimLostError);
    expect(finalizerCalls).toBe(1);

    const [interpretations, decisions, itemRows] = await Promise.all([
      db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(eq(resultInterpretations.resultId, source.resultId)),
      db
        .select({ id: historicalArchiveAuditDecisions.id })
        .from(historicalArchiveAuditDecisions)
        .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
      db
        .select({
          state: resultInterpretationBackfillItems.state,
          attemptCount: resultInterpretationBackfillItems.attemptCount,
          claimToken: resultInterpretationBackfillItems.claimToken,
          resultInterpretationId:
            resultInterpretationBackfillItems.resultInterpretationId,
          historicalAuditDecisionId:
            resultInterpretationBackfillItems.historicalAuditDecisionId,
          historicalAuditReducerState:
            resultInterpretationBackfillItems.historicalAuditReducerState,
          historicalAuditInputEvidenceSignature:
            resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature,
        })
        .from(resultInterpretationBackfillItems)
        .where(eq(resultInterpretationBackfillItems.id, item.id)),
    ]);
    expect(interpretations).toEqual([]);
    expect(decisions).toEqual([]);
    // The entire transaction rolls back, including its lease renewal and
    // interpretation insert. The pre-existing live claim remains retryable.
    expect(itemRows).toEqual([
      {
        state: "hydrating",
        attemptCount: 1,
        claimToken,
        resultInterpretationId: null,
        historicalAuditDecisionId: null,
        historicalAuditReducerState: null,
        historicalAuditInputEvidenceSignature: null,
      },
    ]);
  });

  it("MUST-CATCH: an owner-cascaded historical audit with zero children is incomplete, not a completed empty run", async () => {
    const source = await createReleasedFixture("owner-cascade-zero-child");
    const exactSource = {
      resultId: source.resultId,
      resultAttemptId: source.resultAttemptId,
      sourceArchiveId: source.sourceArchiveId,
    };
    const receipt = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource,
      requestedBy: "test:historical-audit-owner-cascade-zero-child",
    });
    runIds.push(receipt.runId);
    expect(receipt.enqueued).toBe(1);

    // The run receipt is deliberately retained after its source owner is
    // deleted, while the result/attempt-owned child cascades away. A zero-row
    // audit is forensic incompleteness, never a successful no-op.
    await db.delete(results).where(eq(results.id, source.resultId));

    // The cascade trigger closes the retained audit at the mutation boundary;
    // operators should not need a later worker tick to learn that there is no
    // reducible child left.
    const [immediatelyClosed] = await db
      .select({
        state: resultInterpretationBackfillRuns.state,
        summary: resultInterpretationBackfillRuns.summary,
      })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, receipt.runId))
      .limit(1);
    expect(immediatelyClosed).toEqual({
      state: "failed",
      summary: expect.objectContaining({
        historicalAuditDecisions: 0,
        historicalAuditIncomplete: true,
        historicalAuditIncompleteReason: expect.stringContaining(
          "exact source owner was removed",
        ),
      }),
    });

    let reducerCalls = 0;
    const engine = {
      reduceRemoteEvidenceCleanCycles: async () => {
        reducerCalls += 1;
        throw new Error("an owner-cascaded audit has no child to reduce");
      },
    } as unknown as EngineClient;
    const report = await runArchiveInterpretationBackfill({
      db,
      engine,
      runId: receipt.runId,
      maxItems: 1,
      historicalAuditExactSource: exactSource,
    });

    expect(reducerCalls).toBe(0);
    expect(report).toMatchObject({
      state: "failed",
      processed: 0,
      counts: {},
      canonicalSelectionsCreated: 0,
      resultProjectionsUpdated: 0,
    });

    const [items, decisions, runRows] = await Promise.all([
      db
        .select({ id: resultInterpretationBackfillItems.id })
        .from(resultInterpretationBackfillItems)
        .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
      db
        .select({ id: historicalArchiveAuditDecisions.id })
        .from(historicalArchiveAuditDecisions)
        .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
      db
        .select({
          state: resultInterpretationBackfillRuns.state,
          summary: resultInterpretationBackfillRuns.summary,
        })
        .from(resultInterpretationBackfillRuns)
        .where(eq(resultInterpretationBackfillRuns.id, receipt.runId)),
    ]);
    expect(items).toEqual([]);
    expect(decisions).toEqual([]);
    expect(runRows).toEqual([
      {
        state: "failed",
        summary: expect.objectContaining({
          counts: {},
          historicalAuditDecisions: 0,
          historicalAuditIncomplete: true,
          // The runner may observe this terminal audit, but it must not
          // replace the source-owner trigger's precise forensic reason with a
          // generic empty-child summary on a later refresh.
          historicalAuditIncompleteReason: expect.stringContaining(
            "exact source owner was removed",
          ),
        }),
      },
    ]);
  });

  it("MUST-CATCH: deleting an audit child before its exact attempt still closes the empty audit as incomplete", async () => {
    const source = await createReleasedFixture("owner-cascade-child-before-attempt");
    const exactSource = {
      resultId: source.resultId,
      resultAttemptId: source.resultAttemptId,
      sourceArchiveId: source.sourceArchiveId,
    };
    const receipt = await createHistoricalReleasedArchiveAuditRun({
      db,
      exactSource,
      requestedBy: "test:historical-audit-owner-cascade-child-before-attempt",
    });
    runIds.push(receipt.runId);
    expect(receipt.enqueued).toBe(1);

    // A maintenance transaction can delete the mutable child before it deletes
    // the source attempt. The child-level cascade hook correctly sees a live
    // owner at the first statement, so the attempt-owner hook must close the
    // now-empty exact audit before this transaction commits.
    await db.transaction(async (tx) => {
      await tx
        .delete(resultInterpretationBackfillItems)
        .where(
          and(
            eq(resultInterpretationBackfillItems.runId, receipt.runId),
            eq(
              resultInterpretationBackfillItems.resultAttemptId,
              source.resultAttemptId,
            ),
          ),
        );
      await tx
        .delete(resultAttempts)
        .where(eq(resultAttempts.id, source.resultAttemptId));
    });

    const [runRows, childRows, decisionRows] = await Promise.all([
      db
        .select({
          state: resultInterpretationBackfillRuns.state,
          summary: resultInterpretationBackfillRuns.summary,
        })
        .from(resultInterpretationBackfillRuns)
        .where(eq(resultInterpretationBackfillRuns.id, receipt.runId)),
      db
        .select({ id: resultInterpretationBackfillItems.id })
        .from(resultInterpretationBackfillItems)
        .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
      db
        .select({ id: historicalArchiveAuditDecisions.id })
        .from(historicalArchiveAuditDecisions)
        .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
    ]);

    expect(runRows).toEqual([
      {
        state: "failed",
        summary: expect.objectContaining({
          historicalAuditDecisions: 0,
          historicalAuditIncomplete: true,
          historicalAuditIncompleteReason: expect.stringContaining(
            "exact source owner was removed",
          ),
        }),
      },
    ]);
    expect(childRows).toEqual([]);
    expect(decisionRows).toEqual([]);
  });

  const recoveryScenarios: Array<{
    label: string;
    reducerState: "continuation_required" | "rerun_required";
    reduce: (aoaDeg: number) => ArchiveCleanCycleReductionResponse;
    interpretationState: "continuation_required" | "terminal_failure" | null;
    advisoryContinuationAction: "continue_exact_case" | null;
    advisoryTailPeriods: number | null;
    expectedCycleCount: number;
    terminalScalarsCleared: boolean;
    lastError: string;
  }> = [
    {
      label: "continuation_required",
      reducerState: "continuation_required",
      reduce: continuationRequiredReduction,
      interpretationState: "continuation_required",
      advisoryContinuationAction: "continue_exact_case",
      advisoryTailPeriods: 2,
      expectedCycleCount: 4,
      terminalScalarsCleared: false,
      lastError: "raw archive reducer: continuation_required",
    },
    {
      label: "rerun_required without cycle certificate",
      reducerState: "rerun_required",
      reduce: rerunRequiredReduction,
      interpretationState: null,
      advisoryContinuationAction: null,
      advisoryTailPeriods: null,
      expectedCycleCount: 0,
      terminalScalarsCleared: false,
      lastError:
        "raw archive reducer: rerun_required; no recoverable cadence in the retained archive",
    },
    {
      label: "rerun_required with valid cycle certificate",
      reducerState: "rerun_required",
      reduce: rerunRequiredReductionWithCycleEvidence,
      interpretationState: "terminal_failure",
      advisoryContinuationAction: null,
      advisoryTailPeriods: null,
      expectedCycleCount: 4,
      terminalScalarsCleared: true,
      lastError:
        "raw archive reducer: rerun_required; retained cycles require a clean rerun before publication",
    },
  ];

  it.each(recoveryScenarios)(
    "MUST-CATCH: records $label only as a completed released-history audit, never as live solver or projection work",
    async (scenario) => {
      const source = await createReleasedFixture(`record-only-${scenario.label}`);
      const campaign = await attachHistoricalAuditCampaignProjection(source);
      const [progressBefore, cacheBefore] = await Promise.all([
        db
          .select()
          .from(simCampaignProgress)
          .where(
            and(
              eq(simCampaignProgress.campaignId, campaign.campaignId),
              eq(simCampaignProgress.conditionId, campaign.conditionId),
              eq(simCampaignProgress.airfoilId, airfoilId),
            ),
          ),
        db
          .select({ id: polarFitSets.id })
          .from(polarFitSets)
          .where(
            and(
              eq(polarFitSets.airfoilId, airfoilId),
              eq(polarFitSets.simulationPresetRevisionId, revisionId),
            ),
          ),
      ]);
      // This fixture revision has no normal publication result. A historical
      // audit must not quietly synthesize or refresh a cache before it begins.
      expect(progressBefore).toHaveLength(1);
      expect(cacheBefore).toEqual([]);

      const receipt = await createHistoricalReleasedArchiveAuditRun({
        db,
        exactSource: {
          resultId: source.resultId,
          resultAttemptId: source.resultAttemptId,
          sourceArchiveId: source.sourceArchiveId,
        },
        requestedBy: `test:historical-released-audit-e2e-${scenario.label}`,
      });
      runIds.push(receipt.runId);
      expect(receipt.enqueued).toBe(1);

      const report = await runArchiveInterpretationBackfill({
        db,
        engine: {
          healthDetails: async () => ({
            status: "ok",
            version: "historical-audit-reducer-v1",
            archive_reduction_version: 3,
          }),
          reduceRemoteEvidenceCleanCycles: async () =>
            scenario.reduce(source.aoaDeg),
        } as unknown as EngineClient,
        runId: receipt.runId,
        maxItems: 1,
        historicalAuditExactSource: {
          resultId: source.resultId,
          resultAttemptId: source.resultAttemptId,
          sourceArchiveId: source.sourceArchiveId,
        },
      });
      // `completed` means the immutable audit receipt is fully settled. The
      // item's reducer state below remains the truthful non-publication fact;
      // it does not mean a continuation/rerun has been scheduled.
      expect(report).toMatchObject({
        state: "completed",
        processed: 1,
        canonicalSelectionsCreated: 0,
        resultProjectionsUpdated: 0,
        counts: { [scenario.reducerState]: 1 },
      });

      const [
        resultRows,
        interpretations,
        cycles,
        decisions,
        canonicalSelections,
        recoveryActions,
        requests,
        verifyItems,
        classifications,
        cacheAfter,
        campaignPoints,
        progressAfter,
        runRows,
        itemRows,
      ] = await Promise.all([
        db
          .select({
            status: results.status,
            source: results.source,
            regime: results.regime,
            currentResultAttemptId: results.currentResultAttemptId,
            currentResultInterpretationId:
              results.currentResultInterpretationId,
            currentCanonicalSelectionId: results.currentCanonicalSelectionId,
          })
          .from(results)
          .where(eq(results.id, source.resultId)),
        db
          .select({
            id: resultInterpretations.id,
            source: resultInterpretations.source,
            state: resultInterpretations.state,
            cl: resultInterpretations.cl,
            cd: resultInterpretations.cd,
            cm: resultInterpretations.cm,
            clCd: resultInterpretations.clCd,
          })
          .from(resultInterpretations)
          .where(
            and(
              eq(resultInterpretations.resultId, source.resultId),
              eq(resultInterpretations.resultAttemptId, source.resultAttemptId),
              eq(resultInterpretations.sourceArchiveId, source.sourceArchiveId),
            ),
          ),
        db
          .select({
            resultInterpretationId:
              resultInterpretationCycles.resultInterpretationId,
            cycleIndex: resultInterpretationCycles.cycleIndex,
          })
          .from(resultInterpretationCycles)
          .where(
            and(
              eq(resultInterpretationCycles.resultId, source.resultId),
              eq(
                resultInterpretationCycles.resultAttemptId,
                source.resultAttemptId,
              ),
            ),
          )
          .orderBy(asc(resultInterpretationCycles.cycleIndex)),
        db
          .select({
            reducerState: historicalArchiveAuditDecisions.reducerState,
            resultInterpretationId:
              historicalArchiveAuditDecisions.resultInterpretationId,
            advisoryContinuationAction:
              historicalArchiveAuditDecisions.advisoryContinuationAction,
            advisoryTailPeriods:
              historicalArchiveAuditDecisions.advisoryTailPeriods,
          })
          .from(historicalArchiveAuditDecisions)
          .where(eq(historicalArchiveAuditDecisions.auditRunId, receipt.runId)),
        db
          .select({ id: resultCanonicalSelections.id })
          .from(resultCanonicalSelections)
          .where(eq(resultCanonicalSelections.resultId, source.resultId)),
        db
          .select({ id: resultInterpretationRecoveryActions.id })
          .from(resultInterpretationRecoveryActions)
          .where(eq(resultInterpretationRecoveryActions.resultId, source.resultId)),
        db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            and(
              eq(simUransRequests.airfoilId, airfoilId),
              eq(simUransRequests.revisionId, revisionId),
              eq(simUransRequests.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select({ id: simUransVerifyQueue.id })
          .from(simUransVerifyQueue)
          .where(
            and(
              eq(simUransVerifyQueue.airfoilId, airfoilId),
              eq(simUransVerifyQueue.revisionId, revisionId),
              eq(simUransVerifyQueue.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select({ id: resultClassifications.id })
          .from(resultClassifications)
          .where(eq(resultClassifications.resultId, source.resultId)),
        db
          .select({ id: polarFitSets.id })
          .from(polarFitSets)
          .where(
            and(
              eq(polarFitSets.airfoilId, airfoilId),
              eq(polarFitSets.simulationPresetRevisionId, revisionId),
            ),
          ),
        db
          .select({
            state: simCampaignPoints.state,
            resultId: simCampaignPoints.resultId,
            resultAttemptId: simCampaignPoints.resultAttemptId,
          })
          .from(simCampaignPoints)
          .where(
            and(
              eq(simCampaignPoints.campaignId, campaign.campaignId),
              eq(simCampaignPoints.conditionId, campaign.conditionId),
              eq(simCampaignPoints.airfoilId, airfoilId),
              eq(simCampaignPoints.aoaDeg, source.aoaDeg),
            ),
          ),
        db
          .select()
          .from(simCampaignProgress)
          .where(
            and(
              eq(simCampaignProgress.campaignId, campaign.campaignId),
              eq(simCampaignProgress.conditionId, campaign.conditionId),
              eq(simCampaignProgress.airfoilId, airfoilId),
            ),
          ),
        db
          .select({
            state: resultInterpretationBackfillRuns.state,
            summary: resultInterpretationBackfillRuns.summary,
          })
          .from(resultInterpretationBackfillRuns)
          .where(eq(resultInterpretationBackfillRuns.id, receipt.runId)),
        db
          .select({
            state: resultInterpretationBackfillItems.state,
            lastError: resultInterpretationBackfillItems.lastError,
            resultInterpretationId:
              resultInterpretationBackfillItems.resultInterpretationId,
          })
          .from(resultInterpretationBackfillItems)
          .where(eq(resultInterpretationBackfillItems.runId, receipt.runId)),
      ]);

      expect(resultRows).toEqual([
        {
          status: "done",
          source: "solved",
          regime: "urans",
          currentResultAttemptId: null,
          currentResultInterpretationId: null,
          currentCanonicalSelectionId: null,
        },
      ]);
      if (scenario.interpretationState) {
        expect(interpretations).toHaveLength(1);
        expect(interpretations[0]).toMatchObject({
          source: "historical_archive_audit",
          state: scenario.interpretationState,
        });
      } else {
        expect(interpretations).toEqual([]);
      }
      expect(cycles.map((cycle) => cycle.cycleIndex)).toEqual(
        Array.from({ length: scenario.expectedCycleCount }, (_, index) => index),
      );
      if (cycles.length) {
        expect(new Set(cycles.map((cycle) => cycle.resultInterpretationId))).toEqual(
          new Set([interpretations[0]?.id]),
        );
      }
      if (scenario.terminalScalarsCleared) {
        expect(interpretations[0]).toMatchObject({
          state: "terminal_failure",
          cl: null,
          cd: null,
          cm: null,
          clCd: null,
        });
      }
      expect(decisions).toEqual([
        {
          reducerState: scenario.reducerState,
          resultInterpretationId: scenario.interpretationState
            ? interpretations[0]?.id
            : null,
          advisoryContinuationAction: scenario.advisoryContinuationAction,
          advisoryTailPeriods: scenario.advisoryTailPeriods,
        },
      ]);
      expect(canonicalSelections).toEqual([]);
      expect(recoveryActions).toEqual([]);
      expect(requests).toEqual([]);
      expect(verifyItems).toEqual([]);
      expect(classifications).toEqual([]);
      // A released-history audit cannot rebuild a public fit cache or refresh
      // a campaign's materialized counters. The isolated campaign row makes a
      // future accidental call to the normal publication path observable.
      expect(cacheAfter).toEqual(cacheBefore);
      expect(campaignPoints).toEqual([
        {
          state: "terminal",
          resultId: source.resultId,
          resultAttemptId: source.resultAttemptId,
        },
      ]);
      expect(progressAfter).toEqual(progressBefore);
      expect(runRows).toEqual([
        {
          state: "completed",
          summary: expect.objectContaining({
            counts: expect.objectContaining({ [scenario.reducerState]: 1 }),
            canonicalSelectionsCreated: 0,
            resultProjectionsUpdated: 0,
            historicalAuditDecisions: 1,
            historicalAuditIncomplete: false,
          }),
        },
      ]);
      expect(itemRows).toEqual([
        {
          state: scenario.reducerState,
          lastError: scenario.lastError,
          resultInterpretationId: scenario.interpretationState
            ? interpretations[0]?.id
            : null,
        },
      ]);
    },
  );
});
