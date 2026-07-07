// Live-DB TEST-SUITE support only — never import from runtime/product code.
// (Not re-exported from index.ts on purpose; import as "@aerodb/db/test-cleanup".)
//
// Campaign-materialized fixtures form a dependency graph that several suites
// (and vitest files running in parallel against the same database) partially
// SHARE: flow_conditions and reference_geometry_profiles are find-or-create
// registries deduped on canonical keys of physical values only, so a row one
// campaign "created" can be referenced by presets/conditions of a campaign
// from a concurrently running file, and a campaign can reference rows it did
// not create. An unconditional delete of such a row is therefore an
// intermittent foreign-key violation waiting for the right interleaving
// (2026-07-07 worker-restart-orphan flake; DecisionHistory F6/F9).
//
// This helper deletes a suite's campaign fixture graph in dependency order and
// removes shared registry rows only when nothing references them anymore. The
// candidate set is the UNION of rows the suite's campaigns created
// (created_by_campaign_id) and rows its presets referenced — so whichever
// suite finishes last removes a shared row instead of leaking it with
// created_by NULL. (A stale shared row from a crashed run is removed only if
// a later run ADOPTS it via find-or-create — this helper never sweeps
// unrelated residue outside its own campaignIds/prefix scope.) Rows still
// referenced by a live foreign graph are left for that suite's own cleanup
// (or the admin purge) instead of exploding this one.

import { and, eq, inArray, like, notExists, sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  boundaryConditions,
  flowConditions,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  sweepDefinitions,
} from "./schema";

export interface CampaignFixtureCleanupOptions {
  /** Campaign ids this suite launched (empty entries are ignored). */
  campaignIds: (string | null | undefined)[];
  /**
   * Lowercase slug prefix of the presets/sweep definitions the suite's
   * campaigns materialized, e.g. `campaign-${PREFIX.toLowerCase()}`.
   * Must be unique per suite RUN (pid + timestamp) so it can never match
   * another file's rows.
   */
  presetSlugPrefix: string;
}

/**
 * Delete one suite's campaign-materialized fixture graph in dependency order:
 * evidence (fits/classifications/attempts/results) → jobs → campaigns
 * (cascades points/conditions/progress/plan revisions) → presets (cascades
 * revisions/targets) + legacy boundary conditions → guarded find-or-create
 * registry rows (flow_conditions, reference_geometry_profiles) → sweep
 * definitions.
 */
export async function cleanupCampaignFixtures(db: DB, opts: CampaignFixtureCleanupOptions): Promise<void> {
  const campaignIds = opts.campaignIds.filter((id): id is string => Boolean(id));
  // The prefix becomes a LIKE pattern against SHARED tables — a sloppy value
  // (empty, wildcards, missing run entropy) would delete other suites' or
  // even seeded rows. Fail loudly instead.
  const prefix = opts.presetSlugPrefix;
  if (prefix !== prefix.trim().toLowerCase()) {
    throw new Error(`cleanupCampaignFixtures: presetSlugPrefix must be trimmed lowercase, got ${JSON.stringify(prefix)}`);
  }
  if (/[%_\\]/.test(prefix)) {
    throw new Error(`cleanupCampaignFixtures: presetSlugPrefix must not contain LIKE wildcards, got ${JSON.stringify(prefix)}`);
  }
  if (!prefix.startsWith("campaign-") || prefix.length < "campaign-".length + 8) {
    throw new Error(
      `cleanupCampaignFixtures: presetSlugPrefix must be "campaign-" plus a run-unique suite prefix (pid+timestamp), got ${JSON.stringify(prefix)}`,
    );
  }
  const slugPattern = `${prefix}%`;

  const campaignPresets = await db
    .select({
      id: simulationPresets.id,
      legacyId: simulationPresets.legacyBoundaryConditionId,
      flowConditionId: simulationPresets.flowConditionId,
      referenceGeometryProfileId: simulationPresets.referenceGeometryProfileId,
    })
    .from(simulationPresets)
    .where(like(simulationPresets.slug, slugPattern));
  const presetIds = campaignPresets.map((p) => p.id);

  const revisionRows = presetIds.length
    ? await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(inArray(simulationPresetRevisions.presetId, presetIds))
    : [];
  const revisionIds = revisionRows.map((r) => r.id);
  if (revisionIds.length) {
    await db.delete(polarFitSets).where(inArray(polarFitSets.simulationPresetRevisionId, revisionIds));
    await db.delete(resultClassifications).where(inArray(resultClassifications.simulationPresetRevisionId, revisionIds));
    await db.delete(resultAttempts).where(inArray(resultAttempts.simulationPresetRevisionId, revisionIds));
    await db.delete(results).where(inArray(results.simulationPresetRevisionId, revisionIds));
    await db.delete(simJobs).where(inArray(simJobs.simulationPresetRevisionId, revisionIds));
  }

  // Capture registry candidates BEFORE deleting campaigns (created_by is
  // ON DELETE SET NULL) and BEFORE deleting presets (the reference union).
  const createdFlowIds = campaignIds.length
    ? (
        await db
          .select({ id: flowConditions.id })
          .from(flowConditions)
          .where(inArray(flowConditions.createdByCampaignId, campaignIds))
      ).map((r) => r.id)
    : [];
  const createdGeoIds = campaignIds.length
    ? (
        await db
          .select({ id: referenceGeometryProfiles.id })
          .from(referenceGeometryProfiles)
          .where(inArray(referenceGeometryProfiles.createdByCampaignId, campaignIds))
      ).map((r) => r.id)
    : [];
  const flowIds = [
    ...new Set([...createdFlowIds, ...campaignPresets.map((p) => p.flowConditionId).filter((x): x is string => Boolean(x))]),
  ];
  const geoIds = [
    ...new Set([
      ...createdGeoIds,
      ...campaignPresets.map((p) => p.referenceGeometryProfileId).filter((x): x is string => Boolean(x)),
    ]),
  ];

  if (campaignIds.length) {
    await db.delete(simJobs).where(inArray(simJobs.campaignId, campaignIds));
    await db.delete(simCampaigns).where(inArray(simCampaigns.id, campaignIds));
  }

  if (presetIds.length) {
    await db.delete(simulationPresets).where(inArray(simulationPresets.id, presetIds));
    const legacyIds = campaignPresets.map((p) => p.legacyId).filter((x): x is string => Boolean(x));
    if (legacyIds.length) await db.delete(boundaryConditions).where(inArray(boundaryConditions.id, legacyIds));
  }

  // Guarded registry deletes: every table with an FK into these registries
  // must appear here (simulation_presets AND sim_campaign_conditions), or the
  // guard is a different flake with the same shape.
  if (flowIds.length) {
    await db.delete(flowConditions).where(
      and(
        inArray(flowConditions.id, flowIds),
        notExists(
          db.select({ one: sql`1` }).from(simulationPresets).where(eq(simulationPresets.flowConditionId, flowConditions.id)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(simCampaignConditions)
            .where(eq(simCampaignConditions.flowConditionId, flowConditions.id)),
        ),
      ),
    );
  }
  if (geoIds.length) {
    await db.delete(referenceGeometryProfiles).where(
      and(
        inArray(referenceGeometryProfiles.id, geoIds),
        notExists(
          db
            .select({ one: sql`1` })
            .from(simulationPresets)
            .where(eq(simulationPresets.referenceGeometryProfileId, referenceGeometryProfiles.id)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(simCampaignConditions)
            .where(eq(simCampaignConditions.referenceGeometryProfileId, referenceGeometryProfiles.id)),
        ),
      ),
    );
  }

  await db.delete(sweepDefinitions).where(like(sweepDefinitions.slug, slugPattern));
}
