import {
  REPEATED_SOLVER_INCIDENT_THRESHOLD,
  RANS_RECOVERY_REMEDIATION_VERSION,
  URANS_RECOVERY_REMEDIATION_VERSION,
  airfoils,
  createClient,
  recordSolverIncident,
  refreshPolarCacheForRevision,
  resolveOlderRansMeshIncidentsInTransaction,
  resolveSolverIncidentsForOwner,
  resultAttempts,
  resultClassifications,
  results,
  simCampaigns,
  simSolverIncidents,
  simUransRequestCampaigns,
  simUransRequests,
  solverEvidenceArtifacts,
  solverIncidentSummary,
} from "@aerodb/db";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createMinimalSolverFixture,
  type MinimalSolverFixture,
} from "./solver-fixture";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `solver-incidents-${process.pid}-${Date.now().toString(36)}`;
const requestIds: string[] = [];
const resultIds: string[] = [];
let campaignId = "";
let airfoilId = "";
let fixture: MinimalSolverFixture;

beforeAll(async () => {
  const [airfoil] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .limit(1);
  if (!airfoil) throw new Error("seeded airfoil fixture missing");
  airfoilId = airfoil.id;
  fixture = await createMinimalSolverFixture(db, PREFIX);
  const [campaign] = await db
    .insert(simCampaigns)
    .values({
      slug: PREFIX,
      name: PREFIX,
      idempotencyKey: PREFIX,
    })
    .returning();
  campaignId = campaign.id;
  for (let index = 0; index < REPEATED_SOLVER_INCIDENT_THRESHOLD; index += 1) {
    const [request] = await db
      .insert(simUransRequests)
      .values({
        airfoilId: airfoil.id,
        revisionId: fixture.revisionId,
        aoaDeg: 70 + index + (process.pid % 1000) / 100_000,
        fidelity: "full",
        state: "blocked",
        backgroundOwner: true,
        requestedBy: PREFIX,
      })
      .returning();
    requestIds.push(request.id);
    await db.insert(simUransRequestCampaigns).values({
      requestId: request.id,
      campaignId,
      state: "active",
    });
    await recordSolverIncident(db, {
      stage: "final",
      reason: "non-stationary",
      severity: "warning",
      owner: { uransRequestId: request.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:repeat:${index}`,
      metadata: { index },
    });
  }
});

afterAll(async () => {
  if (resultIds.length) {
    await db.delete(results).where(inArray(results.id, resultIds));
  }
  if (requestIds.length) {
    await db
      .delete(simUransRequests)
      .where(inArray(simUransRequests.id, requestIds));
  }
  if (campaignId) {
    await db.delete(simCampaigns).where(eq(simCampaigns.id, campaignId));
  }
  await fixture?.cleanup();
  await sql.end();
});

describe("durable solver incident recurrence", () => {
  it("deduplicates immutable occurrences and raises a repeated-pattern alert by implementation/reason/remediation", async () => {
    const [first] = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.occurrenceKey, `${PREFIX}:repeat:0`));
    expect(first).toBeDefined();

    await recordSolverIncident(db, {
      stage: "final",
      reason: first.reason,
      severity: "critical",
      owner: { uransRequestId: first.uransRequestId! },
      solverImplementationId: first.solverImplementationId,
      occurrenceKey: first.occurrenceKey,
      remediationVersion: first.remediationVersion,
      metadata: { replay: true },
    });

    let summary = await solverIncidentSummary(db, { campaignId });
    expect(summary).toMatchObject({
      threshold: REPEATED_SOLVER_INCIDENT_THRESHOLD,
      occurrenceCount: REPEATED_SOLVER_INCIDENT_THRESHOLD,
      openCount: REPEATED_SOLVER_INCIDENT_THRESHOLD,
      criticalGroupCount: 1,
    });
    expect(summary.groups).toEqual([
      expect.objectContaining({
        stage: "final",
        reason: "non-stationary",
        remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
        occurrenceCount: REPEATED_SOLVER_INCIDENT_THRESHOLD,
        openCriticalCount: 0,
        requiresInvestigation: true,
        effectiveSeverity: "critical",
      }),
    ]);

    await resolveSolverIncidentsForOwner(db, {
      uransRequestId: requestIds[0]!,
    });
    summary = await solverIncidentSummary(db, { campaignId });
    expect(summary.occurrenceCount).toBe(REPEATED_SOLVER_INCIDENT_THRESHOLD);
    expect(summary.openCount).toBe(REPEATED_SOLVER_INCIDENT_THRESHOLD - 1);
    expect(summary.groups[0]).toMatchObject({
      occurrenceCount: REPEATED_SOLVER_INCIDENT_THRESHOLD,
      openCount: REPEATED_SOLVER_INCIDENT_THRESHOLD - 1,
      requiresInvestigation: true,
    });

    await recordSolverIncident(db, {
      stage: "preliminary",
      reason: "continuation-no-progress",
      severity: "critical",
      owner: { uransRequestId: requestIds[0]! },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:second-group`,
    });
    summary = await solverIncidentSummary(db, { campaignId, limit: 1 });
    expect(summary).toMatchObject({
      occurrenceCount: REPEATED_SOLVER_INCIDENT_THRESHOLD + 1,
      openCount: REPEATED_SOLVER_INCIDENT_THRESHOLD,
      criticalGroupCount: 2,
    });
    expect(summary.groups).toHaveLength(1);

    const [existingRequest] = await db
      .select({
        airfoilId: simUransRequests.airfoilId,
      })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, requestIds[0]!));
    const [lateSharedRequest] = await db
      .insert(simUransRequests)
      .values({
        airfoilId: existingRequest!.airfoilId,
        revisionId: fixture.revisionId,
        aoaDeg: 74 + (process.pid % 1000) / 100_000,
        fidelity: "full",
        state: "blocked",
        backgroundOwner: true,
        requestedBy: PREFIX,
      })
      .returning();
    requestIds.push(lateSharedRequest.id);
    await recordSolverIncident(db, {
      stage: "final",
      reason: "late-shared-owner",
      severity: "critical",
      owner: { uransRequestId: lateSharedRequest.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:late-shared-owner`,
    });
    await db.insert(simUransRequestCampaigns).values({
      requestId: lateSharedRequest.id,
      campaignId,
      state: "active",
    });
    await recordSolverIncident(db, {
      stage: "final",
      reason: "late-shared-owner",
      severity: "critical",
      owner: { uransRequestId: lateSharedRequest.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:late-shared-owner`,
    });
    summary = await solverIncidentSummary(db, { campaignId });
    expect(summary.occurrenceCount).toBe(
      REPEATED_SOLVER_INCIDENT_THRESHOLD + 1,
    );
    expect(
      summary.groups.some((group) => group.reason === "late-shared-owner"),
    ).toBe(false);
  });

  it("pins a result-owned incident to its exact attempt and resolves it only after accepted evidence is selected", async () => {
    const aoaDeg = 3.25 + (process.pid % 1000) / 100_000;
    const [result, otherResult] = await db
      .insert(results)
      .values([
        {
          airfoilId,
          bcId: fixture.bcId,
          simulationPresetRevisionId: fixture.revisionId,
          aoaDeg,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          fidelity: "rans",
          solverImplementationId: fixture.solverImplementationId,
        },
        {
          airfoilId,
          bcId: fixture.bcId,
          simulationPresetRevisionId: fixture.revisionId,
          aoaDeg: aoaDeg + 0.125,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          fidelity: "rans",
          solverImplementationId: fixture.solverImplementationId,
        },
      ])
      .returning();
    resultIds.push(result.id, otherResult.id);
    const [nonAcceptedAttempt, otherAttempt] = await db
      .insert(resultAttempts)
      .values([
        {
          resultId: result.id,
          airfoilId,
          bcId: fixture.bcId,
          simulationPresetRevisionId: fixture.revisionId,
          aoaDeg,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          validForPolar: false,
          cl: 0.28,
          cd: 0.019,
          cm: -0.02,
          clCd: 0.28 / 0.019,
          converged: false,
          stalled: true,
          solverImplementationId: fixture.solverImplementationId,
          evidencePayload: {
            fidelity: "rans",
            failure_disposition: "hard_solver",
          },
          solvedAt: new Date(),
        },
        {
          resultId: otherResult.id,
          airfoilId,
          bcId: fixture.bcId,
          simulationPresetRevisionId: fixture.revisionId,
          aoaDeg: aoaDeg + 0.125,
          status: "done" as const,
          source: "solved" as const,
          regime: "rans" as const,
          validForPolar: true,
          cl: 0.3,
          cd: 0.018,
          cm: -0.02,
          clCd: 0.3 / 0.018,
          converged: true,
          stalled: false,
          solverImplementationId: fixture.solverImplementationId,
          evidencePayload: { fidelity: "rans" },
          solvedAt: new Date(),
        },
      ])
      .returning();
    await db.insert(solverEvidenceArtifacts).values([
      {
        resultId: result.id,
        resultAttemptId: nonAcceptedAttempt.id,
        airfoilId,
        aoaDeg,
        kind: "manifest",
        storageKey: `${PREFIX}/result-incident/non-accepted.json`,
        mimeType: "application/json",
        sha256: "d".repeat(64),
        byteSize: 128,
      },
      {
        resultId: otherResult.id,
        resultAttemptId: otherAttempt.id,
        airfoilId,
        aoaDeg: aoaDeg + 0.125,
        kind: "manifest",
        storageKey: `${PREFIX}/result-incident/other.json`,
        mimeType: "application/json",
        sha256: "e".repeat(64),
        byteSize: 128,
      },
    ]);
    await db
      .update(results)
      .set({ currentResultAttemptId: nonAcceptedAttempt.id })
      .where(eq(results.id, result.id));

    await expect(
      recordSolverIncident(db, {
        stage: "rans",
        reason: "solver-execution-failed",
        severity: "critical",
        owner: { resultId: result.id },
        solverImplementationId: fixture.solverImplementationId,
        occurrenceKey: `${PREFIX}:wrong-result-attempt`,
        remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
        resultAttemptId: otherAttempt.id,
      }),
    ).rejects.toThrow();

    const incident = await recordSolverIncident(db, {
      stage: "rans",
      reason: "solver-execution-failed",
      severity: "critical",
      owner: { resultId: result.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:accepted-recovery`,
      remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
      resultAttemptId: nonAcceptedAttempt.id,
    });
    await refreshPolarCacheForRevision(db, airfoilId, fixture.revisionId);
    const [nonAcceptedClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, result.id));
    expect(nonAcceptedClassification?.state).not.toBe("accepted");
    let [storedIncident] = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.id, incident.id));
    expect(storedIncident).toMatchObject({
      status: "open",
      resolvedAt: null,
    });

    const [acceptedAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId: fixture.bcId,
        simulationPresetRevisionId: fixture.revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "rans",
        validForPolar: true,
        cl: 0.31,
        cd: 0.017,
        cm: -0.02,
        clCd: 0.31 / 0.017,
        converged: true,
        stalled: false,
        solverImplementationId: fixture.solverImplementationId,
        evidencePayload: { fidelity: "rans" },
        solvedAt: new Date(),
      })
      .returning();
    await db.insert(solverEvidenceArtifacts).values({
      resultId: result.id,
      resultAttemptId: acceptedAttempt.id,
      airfoilId,
      aoaDeg,
      kind: "manifest",
      storageKey: `${PREFIX}/result-incident/accepted.json`,
      mimeType: "application/json",
      sha256: "f".repeat(64),
      byteSize: 128,
    });
    await db
      .update(results)
      .set({ currentResultAttemptId: acceptedAttempt.id })
      .where(eq(results.id, result.id));
    await refreshPolarCacheForRevision(db, airfoilId, fixture.revisionId);
    const [acceptedClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, result.id));
    expect(acceptedClassification?.state).toBe("accepted");
    [storedIncident] = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.id, incident.id));
    expect(storedIncident.status).toBe("resolved");
    expect(storedIncident.resolvedAt).not.toBeNull();
  });

  it("resolves only older deterministic mesh incidents when a newer engine strategy reopens the result", async () => {
    const aoaDeg = 8.25 + (process.pid % 1000) / 100_000;
    const [result] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: fixture.bcId,
        simulationPresetRevisionId: fixture.revisionId,
        aoaDeg,
        status: "failed",
        source: "queued",
        regime: "rans",
        fidelity: "rans",
        solverImplementationId: fixture.solverImplementationId,
        error: "deterministic mesh quality failure",
      })
      .returning();
    resultIds.push(result.id);

    await recordSolverIncident(db, {
      stage: "rans",
      reason: "mesh-quality-failure",
      severity: "critical",
      owner: { resultId: result.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:mesh:v1`,
      remediationVersion: "rans-mesh-recovery-v1",
      metadata: { meshRecoveryVersion: 1 },
    });
    await recordSolverIncident(db, {
      stage: "rans",
      reason: "solver-execution-failed",
      severity: "critical",
      owner: { resultId: result.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:generic`,
      remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
    });

    expect(
      await resolveOlderRansMeshIncidentsInTransaction(db, [result.id], 2),
    ).toBe(1);
    let incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.resultId, result.id));
    expect(
      incidents.find((incident) => incident.reason === "mesh-quality-failure"),
    ).toMatchObject({ status: "resolved" });
    expect(
      incidents.find(
        (incident) => incident.reason === "solver-execution-failed",
      ),
    ).toMatchObject({ status: "open" });

    await recordSolverIncident(db, {
      stage: "rans",
      reason: "mesh-quality-failure",
      severity: "critical",
      owner: { resultId: result.id },
      solverImplementationId: fixture.solverImplementationId,
      occurrenceKey: `${PREFIX}:mesh:v2`,
      remediationVersion: "rans-mesh-recovery-v2",
      metadata: { meshRecoveryVersion: 2 },
    });
    expect(
      await resolveOlderRansMeshIncidentsInTransaction(db, [result.id], 2),
    ).toBe(0);
    incidents = await db
      .select()
      .from(simSolverIncidents)
      .where(eq(simSolverIncidents.occurrenceKey, `${PREFIX}:mesh:v2`));
    expect(incidents[0]).toMatchObject({ status: "open" });
  });
});
