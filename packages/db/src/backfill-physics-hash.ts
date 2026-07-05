import { asc, eq } from "drizzle-orm";

import { createClient } from "./client";
import { simulationPresetRevisions, simulationPresets } from "./schema";
import { physicsHashForSnapshot, type SimulationSetupSnapshot } from "./simulation-setup";

// Backfills simulation_preset_revisions.physicsHash from each stored snapshot
// and elects one canonical revision per hash (spec §14.2): prefer a revision
// belonging to an enabled preset, else oldest createdAt, tie-break lowest id.
// Safe to re-run: canonical flags are cleared before being set so the partial
// unique index on (physics_hash) WHERE is_canonical_physics never conflicts.

type RevisionRow = {
  id: string;
  presetSlug: string;
  presetEnabled: boolean;
  snapshot: Record<string, unknown>;
  physicsHash: string | null;
  isCanonicalPhysics: boolean;
  createdAt: Date;
};

const { db, sql } = createClient({ max: 1 });

let hashed = 0;
let elected = 0;
let cleared = 0;
let failed = 0;

try {
  const rows: RevisionRow[] = await db
    .select({
      id: simulationPresetRevisions.id,
      presetSlug: simulationPresets.slug,
      presetEnabled: simulationPresets.enabled,
      snapshot: simulationPresetRevisions.snapshot,
      physicsHash: simulationPresetRevisions.physicsHash,
      isCanonicalPhysics: simulationPresetRevisions.isCanonicalPhysics,
      createdAt: simulationPresetRevisions.createdAt,
    })
    .from(simulationPresetRevisions)
    .innerJoin(simulationPresets, eq(simulationPresets.id, simulationPresetRevisions.presetId))
    .orderBy(asc(simulationPresetRevisions.createdAt), asc(simulationPresetRevisions.id));

  const byHash = new Map<string, RevisionRow[]>();
  for (const row of rows) {
    let hash: string;
    try {
      hash = physicsHashForSnapshot(row.snapshot as unknown as SimulationSetupSnapshot);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${row.presetSlug} revision ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (row.physicsHash !== hash) {
      // A changed hash also drops any stale canonical flag in the same write so
      // the partial unique index on (physics_hash) cannot conflict mid-run.
      await db
        .update(simulationPresetRevisions)
        .set({ physicsHash: hash, isCanonicalPhysics: false })
        .where(eq(simulationPresetRevisions.id, row.id));
      row.isCanonicalPhysics = false;
      hashed += 1;
    }
    row.physicsHash = hash;
    const group = byHash.get(hash);
    if (group) group.push(row);
    else byHash.set(hash, [row]);
  }

  for (const group of byHash.values()) {
    const canonical = [...group].sort((a, b) => {
      if (a.presetEnabled !== b.presetEnabled) return a.presetEnabled ? -1 : 1;
      const at = a.createdAt.getTime();
      const bt = b.createdAt.getTime();
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : 1;
    })[0];
    // Clear stale flags first so the partial unique index cannot conflict.
    for (const row of group) {
      if (row.id !== canonical.id && row.isCanonicalPhysics) {
        await db.update(simulationPresetRevisions).set({ isCanonicalPhysics: false }).where(eq(simulationPresetRevisions.id, row.id));
        cleared += 1;
      }
    }
    if (!canonical.isCanonicalPhysics) {
      await db.update(simulationPresetRevisions).set({ isCanonicalPhysics: true }).where(eq(simulationPresetRevisions.id, canonical.id));
      elected += 1;
    }
    if (group.length > 1) {
      console.log(
        `✓ ${canonical.physicsHash}: ${group.length} value-identical revisions, canonical → ${canonical.presetSlug} (${canonical.id})`,
      );
    }
  }

  console.log(
    `physics hash backfill complete: ${hashed} hashed, ${byHash.size} distinct hashes, ${elected} canonical elected, ${cleared} canonical cleared, ${failed} failed`,
  );
  if (failed) process.exitCode = 1;
} finally {
  await sql.end();
}
