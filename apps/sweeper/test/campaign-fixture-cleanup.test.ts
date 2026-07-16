// MUST-CATCH suite for the shared campaign-fixture cleanup helper
// (@aerodb/db/test-cleanup) pinning the 2026-07-07 worker-restart-orphan
// file-level flake (DecisionHistory F9): flow_conditions and
// reference_geometry_profiles are FIND-OR-CREATE registries deduped on
// canonical keys of physical values only, so two campaigns launched by
// different vitest files with the same chord/span share ONE geometry row.
// The file that finishes first must not delete it unconditionally (23503 FK
// violation — the flake), must not skip-and-leak it either, and the helper's
// created-by ∪ referenced-by candidate set means the LAST suite standing
// removes it.
//
// This is deliberately shaped like the real breakage (two live
// materializeCampaignLaunch campaigns, real FK graph), not like the helper's
// implementation.

import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  createClient,
  flowConditions,
  materializeCampaignLaunch,
  mediums,
  meshProfiles,
  outputProfiles,
  polarCompatibilityFitSets,
  referenceGeometryProfiles,
  refreshPolarCacheForRevision,
  resultAttempts,
  results,
  simCampaignConditions,
  simCampaigns,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import { and, eq, inArray, like, sql as dsql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-clean-${process.pid}-${Date.now().toString(36)}`;

// File-unique chord (see AGENTS.md "Live-DB Test Fixture Cleanup"): 0.223 is
// used by no other suite, so the shared row exercised here is provably ours.
const CHORD = 0.223;
const NU = 1.789e-5 / 1.225;

let campaignA = "";
let campaignB = "";
let airfoilId = "";
let categoryId = "";
let mediumId = "";
const profileIds = { boundary: "", mesh: "", solver: "", output: "" };

async function launchCampaign(name: string, speed: number): Promise<string> {
  const launch = await materializeCampaignLaunch(db, {
    name,
    priority: 8,
    idempotencyKey: name,
    airfoilIds: [airfoilId],
    plan: {
      mediumId,
      ambients: [[288.15, 101325]],
      speedsMps: [speed],
      chordsM: [CHORD],
      spanM: 1,
      areaMode: "derived",
      excludedConditions: [],
      baseSweep: {
        fromDeg: null,
        toDeg: null,
        stepDeg: null,
        listDeg: [6, 7, 8],
      },
      objectives: {
        ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
        clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
      },
      numerics: {
        boundaryProfileId: profileIds.boundary,
        meshProfileId: profileIds.mesh,
        solverProfileId: profileIds.solver,
        outputProfileId: profileIds.output,
      },
    },
  });
  return launch.campaign.id;
}

beforeAll(async () => {
  const [cat] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} cat`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = cat.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId: cat.id,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.09 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.03 },
        { x: 1, y: 0 },
      ],
      isSymmetric: false,
    })
    .returning();
  airfoilId = airfoil.id;
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-air`,
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: NU,
      speedOfSound: 340.3,
    })
    .returning();
  mediumId = medium.id;
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.output = output.id;

  // Two "suites": same chord/span → the SAME find-or-create geometry row.
  campaignA = await launchCampaign(`${PREFIX} aaa`, 10);
  campaignB = await launchCampaign(`${PREFIX} bbb`, 20);
});

afterAll(async () => {
  // Safety net if an assertion aborted mid-flow; idempotent over deleted rows.
  await cleanupCampaignFixtures(db, {
    campaignIds: [campaignA, campaignB],
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  if (profileIds.boundary)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, profileIds.boundary));
  if (profileIds.mesh)
    await db.delete(meshProfiles).where(eq(meshProfiles.id, profileIds.mesh));
  if (profileIds.solver)
    await db
      .delete(solverProfiles)
      .where(eq(solverProfiles.id, profileIds.solver));
  if (profileIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, profileIds.output));
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  await sql.end();
});

describe("campaign fixture cleanup: shared find-or-create registry rows", () => {
  it("rejects sloppy presetSlugPrefix values before touching shared tables", async () => {
    await expect(
      cleanupCampaignFixtures(db, { campaignIds: [], presetSlugPrefix: "" }),
    ).rejects.toThrow(/presetSlugPrefix/);
    await expect(
      cleanupCampaignFixtures(db, {
        campaignIds: [],
        presetSlugPrefix: "campaign-%",
      }),
    ).rejects.toThrow(/wildcards/);
    await expect(
      cleanupCampaignFixtures(db, {
        campaignIds: [],
        presetSlugPrefix: `Campaign-${PREFIX}`,
      }),
    ).rejects.toThrow(/lowercase/);
    await expect(
      cleanupCampaignFixtures(db, {
        campaignIds: [],
        presetSlugPrefix: "campaign-ab",
      }),
    ).rejects.toThrow(/run-unique/);
  });

  it("shares ONE geometry row between the two campaigns (the flake precondition)", async () => {
    const created = await db
      .select({ id: referenceGeometryProfiles.id })
      .from(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.createdByCampaignId, campaignA));
    expect(created.length).toBe(1);
    const referents = await db
      .select({ id: simulationPresets.id })
      .from(simulationPresets)
      .where(eq(simulationPresets.referenceGeometryProfileId, created[0].id));
    expect(referents.length).toBe(2);
  });

  it("MUST-CATCH: an unconditional delete of the shared row is exactly the F9 FK flake", async () => {
    const [geo] = await db
      .select({ id: referenceGeometryProfiles.id })
      .from(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.createdByCampaignId, campaignA));
    expect(geo).toBeTruthy();
    // worker-restart-orphan.test.ts's pre-F9 afterAll shape, inside a
    // transaction so the failed statement leaves no state behind.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          dsql`DELETE FROM reference_geometry_profiles WHERE id = ${geo.id}::uuid`,
        );
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("suite A's helper cleanup skips the still-referenced shared row instead of exploding or leaking early", async () => {
    const [geo] = await db
      .select({ id: referenceGeometryProfiles.id })
      .from(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.createdByCampaignId, campaignA));
    const [setup] = await db
      .select({
        revisionId: simCampaignConditions.simulationPresetRevisionId,
        bcId: simulationPresets.legacyBoundaryConditionId,
      })
      .from(simCampaignConditions)
      .innerJoin(
        simulationPresets,
        eq(simulationPresets.id, simCampaignConditions.presetId),
      )
      .where(eq(simCampaignConditions.campaignId, campaignA))
      .limit(1);
    expect(setup?.bcId).toBeTruthy();
    const [evidenceResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: setup.bcId!,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 6,
        status: "done",
        source: "solved",
        regime: "rans",
        reynolds: Math.round((10 * CHORD) / NU),
        speed: 10,
        chord: CHORD,
        cl: 0.61,
        cd: 0.018,
        cm: -0.02,
        clCd: 0.61 / 0.018,
        converged: true,
        stalled: false,
        fidelity: "rans",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: evidenceResult.id,
        airfoilId,
        bcId: setup.bcId!,
        simulationPresetRevisionId: setup.revisionId,
        aoaDeg: 6,
        engineJobId: `${PREFIX}-cleanup-evidence`,
        engineCaseSlug: "a6",
        status: "done",
        source: "solved",
        regime: "rans",
        validForPolar: true,
        cl: 0.61,
        cd: 0.018,
        cm: -0.02,
        clCd: 0.61 / 0.018,
        converged: true,
        stalled: false,
        evidencePayload: { fidelity: "rans" },
        solvedAt: new Date(),
      })
      .returning({ id: resultAttempts.id });
    await db.insert(solverEvidenceArtifacts).values({
      resultId: evidenceResult.id,
      resultAttemptId: attempt.id,
      airfoilId,
      engineJobId: `${PREFIX}-cleanup-evidence`,
      engineCaseSlug: "a6",
      aoaDeg: 6,
      kind: "manifest",
      storageKey: `${PREFIX}/cleanup-evidence/manifest.json`,
      mimeType: "application/json",
      sha256: "a".repeat(64),
      byteSize: 64,
      metadata: { evidenceBase: `${PREFIX}/cleanup-evidence` },
    });
    await db
      .update(results)
      .set({ currentResultAttemptId: attempt.id })
      .where(eq(results.id, evidenceResult.id));
    await refreshPolarCacheForRevision(db, airfoilId, setup.revisionId);
    const [revision] = await db
      .select({
        methodCompatibilityHash:
          simulationPresetRevisions.methodCompatibilityHash,
      })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, setup.revisionId));
    expect(revision.methodCompatibilityHash).toBeTruthy();
    const currentBefore = await db
      .select({ id: polarCompatibilityFitSets.id })
      .from(polarCompatibilityFitSets)
      .where(
        and(
          eq(polarCompatibilityFitSets.airfoilId, airfoilId),
          eq(
            polarCompatibilityFitSets.compatibilityHash,
            revision.methodCompatibilityHash!,
          ),
          eq(polarCompatibilityFitSets.isCurrent, true),
        ),
      );
    expect(currentBefore).toHaveLength(1);

    await cleanupCampaignFixtures(db, {
      campaignIds: [campaignA],
      presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}-aaa`,
    });
    // A's graph is gone…
    const aCampaign = await db
      .select({ id: simCampaigns.id })
      .from(simCampaigns)
      .where(eq(simCampaigns.id, campaignA));
    expect(aCampaign.length).toBe(0);
    const aPresets = await db
      .select({ id: simulationPresets.id })
      .from(simulationPresets)
      .where(
        like(simulationPresets.slug, `campaign-${PREFIX.toLowerCase()}-aaa%`),
      );
    expect(aPresets.length).toBe(0);
    // …but the shared geometry row SURVIVES: campaign B still references it.
    const survivors = await db
      .select({ id: referenceGeometryProfiles.id })
      .from(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.id, geo.id));
    expect(survivors.length).toBe(1);
    const staleCurrent = await db
      .select({ id: polarCompatibilityFitSets.id })
      .from(polarCompatibilityFitSets)
      .where(
        and(
          eq(polarCompatibilityFitSets.airfoilId, airfoilId),
          eq(
            polarCompatibilityFitSets.compatibilityHash,
            revision.methodCompatibilityHash!,
          ),
          eq(polarCompatibilityFitSets.isCurrent, true),
        ),
      );
    expect(staleCurrent).toHaveLength(0);
  });

  it("suite B's helper cleanup removes the shared row via the referenced-by union (no created_by NULL leak)", async () => {
    // After A's campaign delete the row's created_by is NULL, so a
    // created-by-only candidate set would leak it forever. The union picks it
    // up from B's preset references.
    const geoBefore = await db
      .select({ id: referenceGeometryProfiles.id })
      .from(referenceGeometryProfiles)
      .innerJoin(
        simulationPresets,
        eq(
          simulationPresets.referenceGeometryProfileId,
          referenceGeometryProfiles.id,
        ),
      )
      .where(
        like(simulationPresets.slug, `campaign-${PREFIX.toLowerCase()}-bbb%`),
      );
    expect(geoBefore.length).toBeGreaterThan(0);
    const geoIds = [...new Set(geoBefore.map((r) => r.id))];

    // MUST-CATCH for the 2026-07-11 full-suite output_profiles FK flake:
    // campaign-condition ownership is authoritative even if a generated
    // preset's presentation slug no longer matches the launch prefix. The old
    // slug-only helper leaked this preset, then afterAll could not delete the
    // file-owned output profile it still referenced.
    const [campaignPreset] = await db
      .select({ id: simulationPresets.id })
      .from(simulationPresets)
      .where(
        like(simulationPresets.slug, `campaign-${PREFIX.toLowerCase()}-bbb%`),
      );
    expect(campaignPreset).toBeTruthy();
    await db
      .update(simulationPresets)
      .set({ slug: `${PREFIX.toLowerCase()}-renamed-preset` })
      .where(eq(simulationPresets.id, campaignPreset.id));

    await cleanupCampaignFixtures(db, {
      campaignIds: [campaignB],
      presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}-bbb`,
    });

    const leftoverGeo = await db
      .select({ id: referenceGeometryProfiles.id })
      .from(referenceGeometryProfiles)
      .where(inArray(referenceGeometryProfiles.id, geoIds));
    expect(leftoverGeo.length).toBe(0);
    // Full-suite residue check: nothing campaign-materialized survives.
    const leftoverPresets = await db
      .select({ id: simulationPresets.id })
      .from(simulationPresets)
      .where(eq(simulationPresets.id, campaignPreset.id));
    expect(leftoverPresets.length).toBe(0);
    const leftoverFlows = await db
      .select({ id: flowConditions.id })
      .from(flowConditions)
      .where(eq(flowConditions.mediumId, mediumId));
    expect(leftoverFlows.length).toBe(0);
    const leftoverSweeps = await db
      .select({ id: sweepDefinitions.id })
      .from(sweepDefinitions)
      .where(like(sweepDefinitions.slug, `campaign-${PREFIX.toLowerCase()}%`));
    expect(leftoverSweeps.length).toBe(0);
  });
});
