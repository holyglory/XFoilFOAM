import {
  airfoils,
  claimNextPendingUransRequest,
  createClient,
  PREVIOUS_URANS_RECOVERY_REMEDIATION_VERSION,
  resultAttempts,
  resultInterpretationRecoveryActions,
  releaseClaimedUransRequest,
  results,
  simJobs,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simSolverIncidents,
  simUransRequests,
  simUransVerifyQueue,
  simulationPresetRevisions,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "@aerodb/db";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMinimalSolverFixture } from "../../../packages/db/test/solver-fixture";
import {
  ARCHIVE_BACKFILL_FINAL_CONTINUATION_OUTCOME,
  archiveBackfillPrecalcContinuationForRequest,
  archiveBackfillFinalContinuationForVerifyItem,
  repairPendingProvenanceRerunOwners,
  repairTerminalProvenanceRerunOwners,
  routeArchiveInterpretationRecoveryActions,
  routeOneArchiveRecoveryAction,
} from "../src/archive-interpretation-recovery";
import { enqueueVerifiedArchiveReductions } from "../src/archive-reduction-queue";
import { hasExactLegacyUransArchiveGapRecoveryLineage } from "../src/result-interpretations";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `archive-recovery-released-${process.pid}-${Date.now().toString(36)}`;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const AOA_DEG = 70_000 + (Date.now() % 10_000) / 10_000;

let airfoilId = "";
let bcId = "";
let revisionId = "";
let solverImplementationId = "";
let resultId = "";
let resultAttemptId = "";
let sourceArchiveId = "";
let recoveryActionId = "";
let continuationRequestId = "";
let evidenceBlobId = "";
let fullResultAttemptId = "";
let fullSourceArchiveId = "";
let fullRecoveryActionId = "";
let fullEvidenceBlobId = "";
let verifyQueueId = "";
let precalcObligationId = "";
let cleanupFixture: (() => Promise<void>) | null = null;
let recoveryJobId = "";
let terminalRecoveryJobId = "";
let terminalRecoveryRequestId = "";
let replacementEvidenceBlobId = "";
let ordinaryBacklogRequestId = "";
let olderRecoveryBacklogRequestId = "";

beforeAll(async () => {
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  if (!airfoil) throw new Error("seeded airfoil fixture is required");
  const fixture = await createMinimalSolverFixture(db, PREFIX);
  airfoilId = airfoil.id;
  bcId = fixture.bcId;
  revisionId = fixture.revisionId;
  solverImplementationId = fixture.solverImplementationId;
  cleanupFixture = fixture.cleanup;

  const [result] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: AOA_DEG,
      status: "done",
      source: "solved",
      regime: "urans",
    })
    .returning({ id: results.id });
  if (!result) throw new Error("could not create released-evidence result");
  resultId = result.id;

  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: AOA_DEG,
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      converged: true,
      evidencePayload: { fidelity: "urans_precalc" },
    })
    .returning({ id: resultAttempts.id });
  if (!attempt) throw new Error("could not create released-evidence attempt");
  resultAttemptId = attempt.id;

  const [artifact] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId,
      resultAttemptId,
      airfoilId,
      aoaDeg: AOA_DEG,
      kind: "engine_bundle",
      storageKey: `${PREFIX}/source.tar.zst`,
      mimeType: "application/zstd",
      sha256: SHA_A,
      byteSize: 128,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  if (!artifact) throw new Error("could not create released-evidence artifact");

  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "archive-recovery-released-test",
      objectKey: `${PREFIX}/evidence.tar.zst`,
      generation: "1",
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: SHA_A,
      byteSize: 128,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: SHA_B,
      uncompressedTarByteSize: 256,
      verifiedAt: new Date(),
      metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    })
    .returning({ id: solverEvidenceBlobs.id });
  if (!blob) throw new Error("could not create released-evidence blob");
  evidenceBlobId = blob.id;

  const [archive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId,
      resultAttemptId,
      sourceArtifactId: artifact.id,
      blobId: blob.id,
      state: "current",
    })
    .returning({ id: solverEvidenceArchives.id });
  if (!archive) throw new Error("could not create released-evidence archive");
  sourceArchiveId = archive.id;

  // This models the production release transition: the immutable attempt and
  // GCS archive remain retained, but this result cell has no live generation.
  await db
    .update(results)
    .set({ currentResultAttemptId: null })
    .where(eq(results.id, resultId));

  const [fullAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: AOA_DEG,
      status: "done",
      source: "solved",
      regime: "urans",
      unsteady: true,
      converged: true,
      evidencePayload: { fidelity: "urans_full" },
    })
    .returning({ id: resultAttempts.id });
  if (!fullAttempt) throw new Error("could not create released FULL attempt");
  fullResultAttemptId = fullAttempt.id;

  const [fullArtifact] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId,
      resultAttemptId: fullResultAttemptId,
      airfoilId,
      aoaDeg: AOA_DEG,
      kind: "engine_bundle",
      storageKey: `${PREFIX}/full-source.tar.zst`,
      mimeType: "application/zstd",
      sha256: SHA_B,
      byteSize: 128,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  if (!fullArtifact) throw new Error("could not create released FULL artifact");

  const [fullBlob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: "archive-recovery-released-test",
      objectKey: `${PREFIX}/full-evidence.tar.zst`,
      generation: "2",
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: SHA_B,
      byteSize: 128,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: SHA_A,
      uncompressedTarByteSize: 256,
      verifiedAt: new Date(),
      metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    })
    .returning({ id: solverEvidenceBlobs.id });
  if (!fullBlob) throw new Error("could not create released FULL blob");
  fullEvidenceBlobId = fullBlob.id;

  const [fullArchive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId,
      resultAttemptId: fullResultAttemptId,
      sourceArtifactId: fullArtifact.id,
      blobId: fullBlob.id,
      state: "current",
    })
    .returning({ id: solverEvidenceArchives.id });
  if (!fullArchive) throw new Error("could not create released FULL archive");
  fullSourceArchiveId = fullArchive.id;
});

afterAll(async () => {
  if (recoveryActionId) {
    await db
      .delete(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
  }
  if (fullRecoveryActionId) {
    await db
      .delete(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, fullRecoveryActionId));
  }
  if (verifyQueueId) {
    await db
      .delete(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, verifyQueueId));
  }
  if (precalcObligationId) {
    await db
      .delete(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, precalcObligationId));
  }
  if (continuationRequestId) {
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, continuationRequestId));
  }
  if (terminalRecoveryRequestId) {
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, terminalRecoveryRequestId));
  }
  if (ordinaryBacklogRequestId) {
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, ordinaryBacklogRequestId));
  }
  if (olderRecoveryBacklogRequestId) {
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, olderRecoveryBacklogRequestId));
  }
  if (recoveryJobId) {
    await db.delete(simJobs).where(eq(simJobs.id, recoveryJobId));
  }
  if (terminalRecoveryJobId) {
    await db.delete(simJobs).where(eq(simJobs.id, terminalRecoveryJobId));
  }
  if (resultId) {
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, resultId));
    await db.delete(results).where(eq(results.id, resultId));
  }
  if (evidenceBlobId) {
    await db
      .delete(solverEvidenceBlobs)
      .where(eq(solverEvidenceBlobs.id, evidenceBlobId));
  }
  if (fullEvidenceBlobId) {
    await db
      .delete(solverEvidenceBlobs)
      .where(eq(solverEvidenceBlobs.id, fullEvidenceBlobId));
  }
  if (replacementEvidenceBlobId) {
    await db
      .delete(solverEvidenceBlobs)
      .where(eq(solverEvidenceBlobs.id, replacementEvidenceBlobId));
  }
  await cleanupFixture?.();
  await sql.end();
});

describe("archive recovery released-evidence fence", () => {
  it("MUST-CATCH: blocks released historical evidence before it can create solver or verify work", async () => {
    const claimToken = randomUUID();
    const [action] = await db
      .insert(resultInterpretationRecoveryActions)
      .values({
        resultId,
        resultAttemptId,
        sourceArchiveId,
        inputEvidenceSignature: SHA_A,
        fidelity: "urans_precalc",
        requestedAction: "continue_exact_case",
        state: "routing",
        attemptCount: 1,
        claimToken,
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: resultInterpretationRecoveryActions.id });
    if (!action) throw new Error("could not create released-evidence action");
    recoveryActionId = action.id;

    await routeOneArchiveRecoveryAction(db, {
      id: action.id,
      resultId,
      resultAttemptId,
      sourceArchiveId,
      inputEvidenceSignature: SHA_A,
      fidelity: "urans_precalc",
      requestedAction: "continue_exact_case",
      priorState: "pending",
      targetUransRequestId: null,
      targetVerifyQueueId: null,
      correctiveTailPeriods: null,
      cleanCycleRecoveryPolicyVersion: null,
      claimToken,
    });

    const [afterAction] = await db
      .select({
        state: resultInterpretationRecoveryActions.state,
        decisionReason: resultInterpretationRecoveryActions.decisionReason,
        lastError: resultInterpretationRecoveryActions.lastError,
      })
      .from(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, action.id));
    expect(afterAction?.state).toBe("blocked");
    expect(afterAction?.decisionReason).toContain(
      "released from live publication",
    );
    expect(afterAction?.lastError).toContain("historical evidence");

    const requests = await db
      .select({ id: simUransRequests.id })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, revisionId),
          eq(simUransRequests.aoaDeg, AOA_DEG),
        ),
      );
    const verifyItems = await db
      .select({ id: simUransVerifyQueue.id })
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.airfoilId, airfoilId),
          eq(simUransVerifyQueue.revisionId, revisionId),
          eq(simUransVerifyQueue.aoaDeg, AOA_DEG),
        ),
      );
    expect(requests).toHaveLength(0);
    expect(verifyItems).toHaveLength(0);
  });

  it("MUST-CATCH: submit-time continuation proof rejects a released archive and creates no replacement work", async () => {
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: AOA_DEG,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}-fixture`,
        continueFromResultId: resultId,
        continueFromResultAttemptId: resultAttemptId,
      })
      .returning({ id: simUransRequests.id });
    if (!request) throw new Error("could not create continuation request");
    continuationRequestId = request.id;

    await db
      .update(resultInterpretationRecoveryActions)
      .set({
        state: "continuation_routed",
        targetUransRequestId: request.id,
        targetVerifyQueueId: null,
        decisionReason: "fixture continuation receipt before source release",
        lastError: null,
      })
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));

    await expect(
      archiveBackfillPrecalcContinuationForRequest(db, {
        requestId: request.id,
        resultId,
        resultAttemptId,
        airfoilId,
        revisionId,
        bcId,
        aoaDeg: AOA_DEG,
        correctiveTailPeriods: null,
        cleanCycleRecoveryPolicyVersion: null,
      }),
    ).resolves.toBe(false);

    const requests = await db
      .select({ id: simUransRequests.id })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, revisionId),
          eq(simUransRequests.aoaDeg, AOA_DEG),
        ),
      );
    const verifyItems = await db
      .select({ id: simUransVerifyQueue.id })
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.airfoilId, airfoilId),
          eq(simUransVerifyQueue.revisionId, revisionId),
          eq(simUransVerifyQueue.aoaDeg, AOA_DEG),
        ),
      );
    expect(requests).toEqual([{ id: request.id }]);
    expect(verifyItems).toHaveLength(0);
  });

  it("MUST-CATCH: FINAL submit-time continuation proof also rejects released historical evidence", async () => {
    const [queue] = await db
      .insert(simUransVerifyQueue)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: AOA_DEG,
        state: "pending",
        backgroundOwner: true,
        precalcResultId: resultId,
        precalcResultAttemptId: resultAttemptId,
        latestResultAttemptId: fullResultAttemptId,
        lastOutcome: ARCHIVE_BACKFILL_FINAL_CONTINUATION_OUTCOME,
      })
      .returning({ id: simUransVerifyQueue.id });
    if (!queue) throw new Error("could not create FINAL verification queue");
    verifyQueueId = queue.id;

    const [action] = await db
      .insert(resultInterpretationRecoveryActions)
      .values({
        resultId,
        resultAttemptId: fullResultAttemptId,
        sourceArchiveId: fullSourceArchiveId,
        inputEvidenceSignature: SHA_B,
        fidelity: "urans_full",
        requestedAction: "continue_exact_case",
        state: "continuation_routed",
        attemptCount: 1,
        targetVerifyQueueId: queue.id,
        decisionReason:
          "fixture FINAL continuation receipt before source release",
      })
      .returning({ id: resultInterpretationRecoveryActions.id });
    if (!action) throw new Error("could not create FINAL recovery action");
    fullRecoveryActionId = action.id;

    const [item] = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.id, queue.id));
    if (!item) throw new Error("could not reload FINAL verification queue");

    await expect(
      archiveBackfillFinalContinuationForVerifyItem(db, item, bcId),
    ).resolves.toBeNull();

    const requests = await db
      .select({ id: simUransRequests.id })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, revisionId),
          eq(simUransRequests.aoaDeg, AOA_DEG),
        ),
      );
    expect(requests).toEqual([{ id: continuationRequestId }]);
  });

  it("MUST-CATCH: one live legacy provenance action creates one fresh FAST owner before resolving only its obsolete incident", async () => {
    await db
      .update(resultInterpretationRecoveryActions)
      .set({
        state: "blocked",
        targetUransRequestId: null,
        targetVerifyQueueId: null,
        decisionReason: "reset released-evidence fixture for live recovery",
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, continuationRequestId));
    continuationRequestId = "";

    const [revision] = await db
      .select({ snapshot: simulationPresetRevisions.snapshot })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId));
    await db
      .update(simulationPresetRevisions)
      .set({
        snapshot: {
          ...(revision!.snapshot as Record<string, unknown>),
          preset: { legacyBoundaryConditionId: bcId },
        } as typeof revision.snapshot,
      })
      .where(eq(simulationPresetRevisions.id, revisionId));
    await db
      .update(results)
      .set({ currentResultAttemptId: resultAttemptId })
      .where(eq(results.id, resultId));

    const [obligation] = await db
      .insert(simPrecalcObligations)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: AOA_DEG,
        sourceResultId: resultId,
        sourceResultAttemptId: resultAttemptId,
        state: "pending",
        backgroundOwner: true,
        lastOutcome: "missing-urans-video",
      })
      .returning({ id: simPrecalcObligations.id });
    precalcObligationId = obligation!.id;
    const [obsoleteIncident] = await db
      .insert(simSolverIncidents)
      .values({
        stage: "preliminary",
        reason: "missing-urans-video",
        severity: "critical",
        status: "open",
        precalcObligationId,
        solverImplementationId,
        occurrenceKey: `${PREFIX}:live-legacy-video`,
        remediationVersion: PREVIOUS_URANS_RECOVERY_REMEDIATION_VERSION,
      })
      .returning({ id: simSolverIncidents.id });
    const [retainedIncident] = await db
      .insert(simSolverIncidents)
      .values({
        stage: "preliminary",
        reason: "solver-execution-failed",
        severity: "critical",
        status: "open",
        precalcObligationId,
        solverImplementationId,
        occurrenceKey: `${PREFIX}:live-physical-failure`,
        remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
      })
      .returning({ id: simSolverIncidents.id });

    const [ordinaryBacklogRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: AOA_DEG + 1,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}:older-ordinary-backlog`,
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: simUransRequests.id });
    ordinaryBacklogRequestId = ordinaryBacklogRequest!.id;
    const [olderRecoveryBacklogRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: AOA_DEG,
        fidelity: "full",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}:older-noncritical-recovery`,
        createdAt: new Date(Date.now() - 120_000),
      })
      .returning({ id: simUransRequests.id });
    olderRecoveryBacklogRequestId = olderRecoveryBacklogRequest!.id;
    await db
      .update(resultInterpretationRecoveryActions)
      .set({
        state: "continuation_routed",
        targetUransRequestId: olderRecoveryBacklogRequestId,
        targetVerifyQueueId: null,
      })
      .where(eq(resultInterpretationRecoveryActions.id, fullRecoveryActionId));

    const claimToken = randomUUID();
    await db
      .update(resultInterpretationRecoveryActions)
      .set({
        state: "routing",
        requestedAction: "verify_restart_proof_then_rerun",
        claimToken,
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    await routeOneArchiveRecoveryAction(db, {
      id: recoveryActionId,
      resultId,
      resultAttemptId,
      sourceArchiveId,
      inputEvidenceSignature: SHA_A,
      fidelity: "urans_precalc",
      requestedAction: "verify_restart_proof_then_rerun",
      priorState: "pending",
      targetUransRequestId: null,
      targetVerifyQueueId: null,
      correctiveTailPeriods: null,
      cleanCycleRecoveryPolicyVersion: null,
      claimToken,
    });

    const requests = await db
      .select({
        id: simUransRequests.id,
        continueFromResultId: simUransRequests.continueFromResultId,
      })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, revisionId),
          eq(simUransRequests.aoaDeg, AOA_DEG),
          eq(simUransRequests.state, "pending"),
        ),
      );
    expect(requests).toEqual([
      { id: expect.any(String), continueFromResultId: null },
    ]);
    continuationRequestId = requests[0]!.id;
    const ownership = await db
      .select()
      .from(simPrecalcObligationRequests)
      .where(
        eq(simPrecalcObligationRequests.obligationId, precalcObligationId),
      );
    expect(ownership).toHaveLength(1);
    expect(ownership[0]!.requestId).toBe(continuationRequestId);

    const [action] = await db
      .select({
        state: resultInterpretationRecoveryActions.state,
        targetUransRequestId:
          resultInterpretationRecoveryActions.targetUransRequestId,
      })
      .from(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    expect(action).toEqual({
      state: "fresh_rerun_routed",
      targetUransRequestId: continuationRequestId,
    });
    expect(
      await claimNextPendingUransRequest(db, {
        requestIds: [ordinaryBacklogRequestId],
        recoveryOwnedOnly: true,
      }),
    ).toBeNull();
    const prioritizedRecovery = await claimNextPendingUransRequest(db, {
      requestIds: [
        olderRecoveryBacklogRequestId,
        ordinaryBacklogRequestId,
        continuationRequestId,
      ],
      recoveryOwnedOnly: true,
    });
    expect(prioritizedRecovery?.id).toBe(continuationRequestId);
    await releaseClaimedUransRequest(db, continuationRequestId);
    const [ordinaryStillPending] = await db
      .select({ state: simUransRequests.state })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, ordinaryBacklogRequestId));
    expect(ordinaryStillPending?.state).toBe("pending");
    const [olderRecoveryStillPending] = await db
      .select({ state: simUransRequests.state })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, olderRecoveryBacklogRequestId));
    expect(olderRecoveryStillPending?.state).toBe("pending");
    const incidents = await db
      .select({ id: simSolverIncidents.id, status: simSolverIncidents.status })
      .from(simSolverIncidents)
      .where(
        inArray(simSolverIncidents.id, [
          obsoleteIncident!.id,
          retainedIncident!.id,
        ]),
      );
    expect(
      incidents.find((incident) => incident.id === obsoleteIncident!.id),
    ).toMatchObject({ status: "resolved" });
    expect(
      incidents.find((incident) => incident.id === retainedIncident!.id),
    ).toMatchObject({ status: "open" });

    // Regression for the short-lived v2 production defect: preserve the one
    // durable owner, but correct an unexecuted continuation receipt to a normal
    // fresh request before admission can submit it.
    await db
      .update(simUransRequests)
      .set({
        continueFromResultId: resultId,
        continueFromResultAttemptId: resultAttemptId,
      })
      .where(eq(simUransRequests.id, continuationRequestId));
    await db
      .update(resultInterpretationRecoveryActions)
      .set({ state: "continuation_routed" })
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    expect(await repairPendingProvenanceRerunOwners(db)).toBe(1);
    const [repairedRequest] = await db
      .select({
        continueFromResultId: simUransRequests.continueFromResultId,
        continueFromResultAttemptId:
          simUransRequests.continueFromResultAttemptId,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, continuationRequestId));
    expect(repairedRequest).toEqual({
      continueFromResultId: null,
      continueFromResultAttemptId: null,
    });
    const [repairedAction] = await db
      .select({ state: resultInterpretationRecoveryActions.state })
      .from(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    expect(repairedAction?.state).toBe("fresh_rerun_routed");

    // Production-shaped legacy recovery: the first fresh owner reached a
    // terminal blocked/cancelled generation without accepted publication.
    // Preserve it, return only the source-pinned action to routing, and attach
    // exactly one remaining-budget request to the same obligation.
    terminalRecoveryRequestId = continuationRequestId;
    const [terminalRecoveryJob] = await db
      .insert(simJobs)
      .values({
        engineJobId: `${PREFIX}-legacy-provenance-terminal`,
        engineState: "cancelled",
        methodKey: "openfoam.urans",
        solverImplementationId,
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: 1,
        wave: 2,
        status: "done",
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          aoas: [AOA_DEG],
          uransFidelity: "precalc",
          uransRequestId: terminalRecoveryRequestId,
        },
      })
      .returning({ id: simJobs.id });
    terminalRecoveryJobId = terminalRecoveryJob!.id;
    await db
      .update(simUransRequests)
      .set({ state: "blocked", simJobId: terminalRecoveryJobId })
      .where(eq(simUransRequests.id, terminalRecoveryRequestId));
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        attemptCount: 1,
        maxAttempts: 2,
        latestSimJobId: null,
        lastOutcome: "corrective_engine_fix_retry_pending",
        lastError: null,
      })
      .where(eq(simPrecalcObligations.id, precalcObligationId));

    await expect(repairTerminalProvenanceRerunOwners(db)).resolves.toBe(1);
    await expect(repairTerminalProvenanceRerunOwners(db)).resolves.toBe(0);
    const [pendingAction] = await db
      .select({
        state: resultInterpretationRecoveryActions.state,
        targetUransRequestId:
          resultInterpretationRecoveryActions.targetUransRequestId,
      })
      .from(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    expect(pendingAction).toEqual({
      state: "pending",
      targetUransRequestId: terminalRecoveryRequestId,
    });

    await expect(routeArchiveInterpretationRecoveryActions(db)).resolves.toBe(
      1,
    );
    const openRequests = await db
      .select({
        id: simUransRequests.id,
        state: simUransRequests.state,
        continueFromResultId: simUransRequests.continueFromResultId,
        continueFromResultAttemptId:
          simUransRequests.continueFromResultAttemptId,
      })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, airfoilId),
          eq(simUransRequests.revisionId, revisionId),
          eq(simUransRequests.aoaDeg, AOA_DEG),
          eq(simUransRequests.state, "pending"),
        ),
      );
    expect(openRequests).toEqual([
      {
        id: expect.any(String),
        state: "pending",
        continueFromResultId: null,
        continueFromResultAttemptId: null,
      },
    ]);
    continuationRequestId = openRequests[0]!.id;
    expect(continuationRequestId).not.toBe(terminalRecoveryRequestId);
    const [reroutedAction] = await db
      .select({
        state: resultInterpretationRecoveryActions.state,
        targetUransRequestId:
          resultInterpretationRecoveryActions.targetUransRequestId,
      })
      .from(resultInterpretationRecoveryActions)
      .where(eq(resultInterpretationRecoveryActions.id, recoveryActionId));
    expect(reroutedAction).toEqual({
      state: "fresh_rerun_routed",
      targetUransRequestId: continuationRequestId,
    });
    const recoveryOwners = await db
      .select({ requestId: simPrecalcObligationRequests.requestId })
      .from(simPrecalcObligationRequests)
      .where(
        eq(simPrecalcObligationRequests.obligationId, precalcObligationId),
      );
    expect(recoveryOwners.map((owner) => owner.requestId).sort()).toEqual(
      [terminalRecoveryRequestId, continuationRequestId].sort(),
    );
    const incidentsAfterReroute = await db
      .select({ id: simSolverIncidents.id, status: simSolverIncidents.status })
      .from(simSolverIncidents)
      .where(
        inArray(simSolverIncidents.id, [
          obsoleteIncident!.id,
          retainedIncident!.id,
        ]),
      );
    expect(
      incidentsAfterReroute.find(
        (incident) => incident.id === obsoleteIncident!.id,
      ),
    ).toMatchObject({ status: "resolved" });
    expect(
      incidentsAfterReroute.find(
        (incident) => incident.id === retainedIncident!.id,
      ),
    ).toMatchObject({ status: "open" });

    const [recoveryJob] = await db
      .insert(simJobs)
      .values({
        engineJobId: `${PREFIX}-legacy-provenance-fresh`,
        methodKey: "openfoam.urans",
        solverImplementationId,
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        jobKind: "targeted",
        referenceChordM: 1,
        wave: 2,
        status: "done",
        totalCases: 1,
        completedCases: 1,
        requestPayload: {
          aoas: [AOA_DEG],
          uransFidelity: "precalc",
          uransRequestId: continuationRequestId,
        },
      })
      .returning({ id: simJobs.id });
    recoveryJobId = recoveryJob!.id;
    await db
      .update(simUransRequests)
      .set({ state: "running", simJobId: recoveryJobId })
      .where(eq(simUransRequests.id, continuationRequestId));
    const [replacementAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        simJobId: recoveryJobId,
        aoaDeg: AOA_DEG,
        status: "done",
        source: "solved",
        regime: "urans",
        unsteady: false,
        converged: true,
        evidencePayload: { fidelity: "urans_precalc" },
      })
      .returning({ id: resultAttempts.id });
    expect(
      await hasExactLegacyUransArchiveGapRecoveryLineage({
        db,
        resultId,
        currentLegacyAttemptId: resultAttemptId,
        targetUransAttemptId: replacementAttempt!.id,
      }),
    ).toBe(true);
    expect(
      await hasExactLegacyUransArchiveGapRecoveryLineage({
        db,
        resultId,
        currentLegacyAttemptId: resultAttemptId,
        targetUransAttemptId: fullResultAttemptId,
      }),
    ).toBe(false);

    const replacementSha = "c".repeat(64);
    const [replacementArtifact] = await db
      .insert(solverEvidenceArtifacts)
      .values({
        resultId,
        resultAttemptId: replacementAttempt!.id,
        airfoilId,
        aoaDeg: AOA_DEG,
        kind: "engine_bundle",
        storageKey: `${PREFIX}/replacement.tar.zst`,
        mimeType: "application/zstd",
        sha256: replacementSha,
        byteSize: 512,
      })
      .returning({ id: solverEvidenceArtifacts.id });
    const [replacementBlob] = await db
      .insert(solverEvidenceBlobs)
      .values({
        backend: "gcs",
        bucket: "archive-recovery-released-test",
        objectKey: `${PREFIX}/replacement.tar.zst`,
        generation: "2",
        compression: "zstd",
        mimeType: "application/zstd",
        sha256: replacementSha,
        byteSize: 512,
        crc32c: "AAAAAA==",
        uncompressedTarSha256: "d".repeat(64),
        uncompressedTarByteSize: 1024,
        verifiedAt: new Date(),
        metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
      })
      .returning({ id: solverEvidenceBlobs.id });
    replacementEvidenceBlobId = replacementBlob!.id;
    await db.insert(solverEvidenceArchives).values({
      resultId,
      resultAttemptId: replacementAttempt!.id,
      sourceArtifactId: replacementArtifact!.id,
      blobId: replacementEvidenceBlobId,
      state: "current",
    });
    const queued = await enqueueVerifiedArchiveReductions(db, {
      resultAttemptIds: [replacementAttempt!.id],
      limit: 1,
    });
    expect(queued.admittedResultAttemptIds).toEqual([replacementAttempt!.id]);
    expect(queued.enqueued).toBe(1);

    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, resultId));
  });
});
