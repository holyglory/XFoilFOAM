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

import { and, eq, inArray, like, notExists, or, sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  boundaryConditions,
  flowConditions,
  polarCompatibilityFitSets,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  simCampaignConditions,
  simCampaigns,
  simJobs,
  simPrecalcObligations,
  simUransRequests,
  simUransVerifyQueue,
  simulationPresetRevisions,
  simulationPresets,
  sweepDefinitions,
} from "./schema";
import {
  POLAR_COMPATIBILITY_VERSION,
  refreshPolarCompatibilityCache,
  resolveRevisionPhysicsHash,
} from "./polar-compatibility-cache";

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
export async function cleanupCampaignFixtures(
  rootDb: DB,
  opts: CampaignFixtureCleanupOptions,
): Promise<void> {
  const campaignIds = opts.campaignIds.filter((id): id is string =>
    Boolean(id),
  );
  // The prefix becomes a LIKE pattern against SHARED tables — a sloppy value
  // (empty, wildcards, missing run entropy) would delete other suites' or
  // even seeded rows. Fail loudly instead.
  const prefix = opts.presetSlugPrefix;
  if (prefix !== prefix.trim().toLowerCase()) {
    throw new Error(
      `cleanupCampaignFixtures: presetSlugPrefix must be trimmed lowercase, got ${JSON.stringify(prefix)}`,
    );
  }
  if (/[%_\\]/.test(prefix)) {
    throw new Error(
      `cleanupCampaignFixtures: presetSlugPrefix must not contain LIKE wildcards, got ${JSON.stringify(prefix)}`,
    );
  }
  if (
    !prefix.startsWith("campaign-") ||
    prefix.length < "campaign-".length + 8
  ) {
    throw new Error(
      `cleanupCampaignFixtures: presetSlugPrefix must be "campaign-" plus a run-unique suite prefix (pid+timestamp), got ${JSON.stringify(prefix)}`,
    );
  }
  const slugPattern = `${prefix}%`;
  const compatibilityScopes = new Map<
    string,
    { airfoilId: string; compatibilityHash: string }
  >();

  // One transaction plus row locks makes cleanup a closed fixture boundary.
  // In particular, a parallel ladder test must not be able to claim a request
  // and insert a new sim_job for one of these revisions after the helper's job
  // scan but before its preset delete (the 2026-07-11 full-suite flake).
  await rootDb.transaction(async (rawTx) => {
    const db = rawTx as unknown as DB;

    // Campaign conditions are the authoritative preset ownership edge. Slugs
    // are only a safety-net for a launch that failed after materialization or
    // for a test that deliberately renamed a generated preset.
    const conditionPresetRows = campaignIds.length
      ? await db
          .select({ id: simCampaignConditions.presetId })
          .from(simCampaignConditions)
          .where(inArray(simCampaignConditions.campaignId, campaignIds))
      : [];
    const conditionPresetIds = [
      ...new Set(conditionPresetRows.map((row) => row.id)),
    ];

    const campaignPresets = await db
      .select({
        id: simulationPresets.id,
        legacyId: simulationPresets.legacyBoundaryConditionId,
        flowConditionId: simulationPresets.flowConditionId,
        referenceGeometryProfileId:
          simulationPresets.referenceGeometryProfileId,
      })
      .from(simulationPresets)
      .where(
        conditionPresetIds.length
          ? or(
              like(simulationPresets.slug, slugPattern),
              inArray(simulationPresets.id, conditionPresetIds),
            )
          : like(simulationPresets.slug, slugPattern),
      );
    const presetIds = campaignPresets.map((p) => p.id);

    if (presetIds.length) {
      await db.execute(sql`
        SELECT id
        FROM simulation_presets
        WHERE id IN (${sql.join(
          presetIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        ORDER BY id
        FOR UPDATE
      `);
    }

    const revisionRows = presetIds.length
      ? await db
          .select({ id: simulationPresetRevisions.id })
          .from(simulationPresetRevisions)
          .where(inArray(simulationPresetRevisions.presetId, presetIds))
      : [];
    const revisionIds = revisionRows.map((r) => r.id);
    if (revisionIds.length) {
      const physicsHashByRevision = new Map<string, string>();
      for (const revisionId of revisionIds) {
        const compatibilityHash = await resolveRevisionPhysicsHash(
          db,
          revisionId,
        );
        if (compatibilityHash)
          physicsHashByRevision.set(revisionId, compatibilityHash);
      }
      const affectedResults = await db
        .select({
          airfoilId: results.airfoilId,
          revisionId: results.simulationPresetRevisionId,
        })
        .from(results)
        .where(inArray(results.simulationPresetRevisionId, revisionIds));
      for (const row of affectedResults) {
        if (!row.revisionId) continue;
        const compatibilityHash = physicsHashByRevision.get(row.revisionId);
        if (!compatibilityHash) continue;
        const key = `${row.airfoilId}:${compatibilityHash}`;
        compatibilityScopes.set(key, {
          airfoilId: row.airfoilId,
          compatibilityHash,
        });
      }
      // Match runtime cache lock order: aggregate before revision. Preset rows
      // are already locked above to close revision creation; runtime refreshes
      // never lock the preset, so this cannot invert their aggregate→revision
      // order. Sorted locks make two concurrent cleanup helpers deterministic.
      for (const scope of [...compatibilityScopes.values()].sort((a, b) =>
        `${a.airfoilId}:${a.compatibilityHash}`.localeCompare(
          `${b.airfoilId}:${b.compatibilityHash}`,
        ),
      )) {
        await db.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`polar-compatibility:${POLAR_COMPATIBILITY_VERSION}:${scope.airfoilId}:${scope.compatibilityHash}`}, 0))`,
        );
      }
      // FK inserts take a key-share lock on their referenced revision. Holding
      // UPDATE locks through the transaction prevents a late request consumer
      // from recreating a job after the dependency scan.
      await db.execute(sql`
        SELECT id
        FROM simulation_preset_revisions
        WHERE id IN (${sql.join(
          revisionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        ORDER BY id
        FOR UPDATE
      `);

      // Stop every new ladder composition before deleting jobs. Ownership
      // association rows cascade from these physical request/queue rows.
      await db
        .delete(simUransVerifyQueue)
        .where(inArray(simUransVerifyQueue.revisionId, revisionIds));
      await db
        .delete(simUransRequests)
        .where(inArray(simUransRequests.revisionId, revisionIds));
      await db
        .delete(simJobs)
        .where(inArray(simJobs.simulationPresetRevisionId, revisionIds));
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
            .where(
              inArray(
                referenceGeometryProfiles.createdByCampaignId,
                campaignIds,
              ),
            )
        ).map((r) => r.id)
      : [];
    const flowIds = [
      ...new Set([
        ...createdFlowIds,
        ...campaignPresets
          .map((p) => p.flowConditionId)
          .filter((x): x is string => Boolean(x)),
      ]),
    ];
    const geoIds = [
      ...new Set([
        ...createdGeoIds,
        ...campaignPresets
          .map((p) => p.referenceGeometryProfileId)
          .filter((x): x is string => Boolean(x)),
      ]),
    ];

    if (campaignIds.length) {
      await db.delete(simJobs).where(inArray(simJobs.campaignId, campaignIds));
      await db
        .delete(simCampaigns)
        .where(inArray(simCampaigns.id, campaignIds));
    }

    // Campaign deletion above first removes lane/step FKs into fitted evidence.
    if (revisionIds.length) {
      // Terminal remote PRECALC handoffs keep an exact source-attempt pointer.
      // Remove the revision-owned obligation before deleting immutable result
      // attempts; deleting the preset later would cascade it too late for the
      // attempt FK's deliberate NO ACTION policy.
      await db
        .delete(simPrecalcObligations)
        .where(inArray(simPrecalcObligations.revisionId, revisionIds));
      // Fit points do not own result FKs, so result/member cascades alone leave
      // a truthful-looking current aggregate backed by deleted fixture rows.
      // Retire affected aggregates in the same commit as evidence deletion;
      // committed survivors are rebuilt below after this transaction.
      for (const scope of compatibilityScopes.values()) {
        await db
          .update(polarCompatibilityFitSets)
          .set({ isCurrent: false })
          .where(
            and(
              eq(polarCompatibilityFitSets.airfoilId, scope.airfoilId),
              eq(
                polarCompatibilityFitSets.compatibilityHash,
                scope.compatibilityHash,
              ),
              eq(polarCompatibilityFitSets.isCurrent, true),
            ),
          );
      }
      await db
        .delete(polarFitSets)
        .where(inArray(polarFitSets.simulationPresetRevisionId, revisionIds));
      await db
        .delete(resultClassifications)
        .where(
          inArray(
            resultClassifications.simulationPresetRevisionId,
            revisionIds,
          ),
        );
      // Exact-generation results point back to their selected immutable
      // attempt. Break only this fixture graph's selection pointers before
      // deleting its attempts; deleting the result afterward still cascades
      // all result-owned media/evidence children in dependency order.
      await db
        .update(results)
        .set({ currentResultAttemptId: null })
        .where(inArray(results.simulationPresetRevisionId, revisionIds));
      await db
        .delete(resultAttempts)
        .where(inArray(resultAttempts.simulationPresetRevisionId, revisionIds));
      // result_media, result_media_repairs, extents, force history, render
      // cache, verify rows and result-bound artifacts all cascade here.
      await db
        .delete(results)
        .where(inArray(results.simulationPresetRevisionId, revisionIds));
    }

    if (presetIds.length) {
      await db
        .delete(simulationPresets)
        .where(inArray(simulationPresets.id, presetIds));
      const legacyIds = campaignPresets
        .map((p) => p.legacyId)
        .filter((x): x is string => Boolean(x));
      if (legacyIds.length)
        await db
          .delete(boundaryConditions)
          .where(inArray(boundaryConditions.id, legacyIds));
    }

    // Guarded registry deletes: every table with an FK into these registries
    // must appear here (simulation_presets AND sim_campaign_conditions), or the
    // guard is a different flake with the same shape.
    if (flowIds.length) {
      await db.delete(flowConditions).where(
        and(
          inArray(flowConditions.id, flowIds),
          notExists(
            db
              .select({ one: sql`1` })
              .from(simulationPresets)
              .where(eq(simulationPresets.flowConditionId, flowConditions.id)),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(simCampaignConditions)
              .where(
                eq(simCampaignConditions.flowConditionId, flowConditions.id),
              ),
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
              .where(
                eq(
                  simulationPresets.referenceGeometryProfileId,
                  referenceGeometryProfiles.id,
                ),
              ),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(simCampaignConditions)
              .where(
                eq(
                  simCampaignConditions.referenceGeometryProfileId,
                  referenceGeometryProfiles.id,
                ),
              ),
          ),
        ),
      );
    }

    await db
      .delete(sweepDefinitions)
      .where(like(sweepDefinitions.slug, slugPattern));
  });

  // Compatibility aggregation is intentionally a post-commit read of exact
  // selected evidence. Rebuild only when a surviving result still belongs to
  // the group; otherwise the retired cache stays unavailable instead of
  // publishing an invented empty polar for a deleted fixture graph.
  for (const scope of [...compatibilityScopes.values()].sort((a, b) =>
    `${a.airfoilId}:${a.compatibilityHash}`.localeCompare(
      `${b.airfoilId}:${b.compatibilityHash}`,
    ),
  )) {
    const [survivor] = (await rootDb.execute(sql`
      SELECT result.id
      FROM results result
      JOIN simulation_preset_revisions revision
        ON revision.id = result.simulation_preset_revision_id
      WHERE result.airfoil_id = ${scope.airfoilId}
        AND revision.physics_hash = ${scope.compatibilityHash}
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!survivor) continue;
    await refreshPolarCompatibilityCache(
      rootDb,
      scope.airfoilId,
      scope.compatibilityHash,
    );
  }
}
