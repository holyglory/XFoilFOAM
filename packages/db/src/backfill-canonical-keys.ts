import { asc, eq } from "drizzle-orm";

import { createClient } from "./client";
import { flowConditions, referenceGeometryProfiles, simCampaignConditions, simulationPresets } from "./schema";
import { flowConditionCanonicalKey, referenceGeometryCanonicalKey } from "./simulation-setup";

// Backfills flow_conditions.canonicalKey and
// reference_geometry_profiles.canonicalKey with the CONSERVATIVE dedupe from
// spec §3.2: value-identical rows are merged (deleted) only when they are
// unreferenced; referenced duplicates keep their rows and get a deterministic
// '#2', '#3' suffix on the canonical key, with a console log. The surviving
// key owner is elected deterministically: prefer a referenced row, then a
// seeded row, then oldest createdAt, tie-break lowest id.

type RegistryRow = {
  id: string;
  slug: string;
  isSeeded: boolean;
  createdAt: Date;
  canonicalKey: string | null;
  key: string;
};

const { db, sql } = createClient({ max: 1 });

let keyed = 0;
let merged = 0;
let suffixed = 0;

function groupByKey(rows: RegistryRow[]): Map<string, RegistryRow[]> {
  const byKey = new Map<string, RegistryRow[]>();
  for (const row of rows) {
    const group = byKey.get(row.key);
    if (group) group.push(row);
    else byKey.set(row.key, [row]);
  }
  return byKey;
}

function electOwner(group: RegistryRow[], referenced: Set<string>): RegistryRow {
  return [...group].sort((a, b) => {
    const aRef = referenced.has(a.id);
    const bRef = referenced.has(b.id);
    if (aRef !== bRef) return aRef ? -1 : 1;
    if (a.isSeeded !== b.isSeeded) return a.isSeeded ? -1 : 1;
    const at = a.createdAt.getTime();
    const bt = b.createdAt.getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : 1;
  })[0];
}

async function backfillRegistry(
  label: string,
  table: typeof flowConditions | typeof referenceGeometryProfiles,
  rows: RegistryRow[],
  referenced: Set<string>,
): Promise<void> {
  const byKey = groupByKey(rows);
  const assignments: Array<{ row: RegistryRow; key: string }> = [];
  for (const [key, group] of byKey) {
    const owner = electOwner(group, referenced);
    assignments.push({ row: owner, key });
    let suffix = 2;
    for (const row of group) {
      if (row.id === owner.id) continue;
      if (!referenced.has(row.id)) {
        await db.delete(table).where(eq(table.id, row.id));
        merged += 1;
        console.log(`✓ ${label} ${row.slug} (${row.id}): unreferenced duplicate of ${owner.slug}, merged (deleted)`);
        continue;
      }
      const suffixedKey = `${key}#${suffix}`;
      suffix += 1;
      assignments.push({ row, key: suffixedKey });
      suffixed += 1;
      console.log(
        `⚠ ${label} ${row.slug} (${row.id}): referenced duplicate of ${owner.slug}, kept with canonicalKey suffix '${suffixedKey}'`,
      );
    }
  }
  // Clear every stale key before writing any new one so re-runs after value
  // edits cannot trip the unique index across groups mid-update.
  for (const { row, key: nextKey } of assignments) {
    if (row.canonicalKey !== null && row.canonicalKey !== nextKey) {
      await db.update(table).set({ canonicalKey: null }).where(eq(table.id, row.id));
      row.canonicalKey = null;
    }
  }
  for (const { row, key: nextKey } of assignments) {
    if (row.canonicalKey !== nextKey) {
      await db.update(table).set({ canonicalKey: nextKey }).where(eq(table.id, row.id));
      keyed += 1;
    }
  }
}

try {
  const flowReferenced = new Set<string>();
  for (const { id } of await db
    .select({ id: simulationPresets.flowConditionId })
    .from(simulationPresets)) {
    flowReferenced.add(id);
  }
  for (const { id } of await db
    .select({ id: simCampaignConditions.flowConditionId })
    .from(simCampaignConditions)) {
    flowReferenced.add(id);
  }

  const geometryReferenced = new Set<string>();
  for (const { id } of await db
    .select({ id: simulationPresets.referenceGeometryProfileId })
    .from(simulationPresets)) {
    geometryReferenced.add(id);
  }
  for (const { id } of await db
    .select({ id: simCampaignConditions.referenceGeometryProfileId })
    .from(simCampaignConditions)) {
    geometryReferenced.add(id);
  }

  const flowRows: RegistryRow[] = (
    await db
      .select({
        id: flowConditions.id,
        slug: flowConditions.slug,
        isSeeded: flowConditions.isSeeded,
        createdAt: flowConditions.createdAt,
        canonicalKey: flowConditions.canonicalKey,
        mediumId: flowConditions.mediumId,
        temperatureK: flowConditions.temperatureK,
        pressurePa: flowConditions.pressurePa,
        speedMps: flowConditions.speedMps,
      })
      .from(flowConditions)
      .orderBy(asc(flowConditions.createdAt), asc(flowConditions.id))
  ).map((row) => ({
    id: row.id,
    slug: row.slug,
    isSeeded: row.isSeeded,
    createdAt: row.createdAt,
    canonicalKey: row.canonicalKey,
    key: flowConditionCanonicalKey(row),
  }));
  await backfillRegistry("flow condition", flowConditions, flowRows, flowReferenced);

  const geometryRows: RegistryRow[] = (
    await db
      .select({
        id: referenceGeometryProfiles.id,
        slug: referenceGeometryProfiles.slug,
        isSeeded: referenceGeometryProfiles.isSeeded,
        createdAt: referenceGeometryProfiles.createdAt,
        canonicalKey: referenceGeometryProfiles.canonicalKey,
        geometryType: referenceGeometryProfiles.geometryType,
        referenceLengthKind: referenceGeometryProfiles.referenceLengthKind,
        referenceLengthM: referenceGeometryProfiles.referenceLengthM,
        spanM: referenceGeometryProfiles.spanM,
        referenceAreaM2: referenceGeometryProfiles.referenceAreaM2,
      })
      .from(referenceGeometryProfiles)
      .orderBy(asc(referenceGeometryProfiles.createdAt), asc(referenceGeometryProfiles.id))
  ).map((row) => ({
    id: row.id,
    slug: row.slug,
    isSeeded: row.isSeeded,
    createdAt: row.createdAt,
    canonicalKey: row.canonicalKey,
    key: referenceGeometryCanonicalKey(row),
  }));
  await backfillRegistry("reference geometry", referenceGeometryProfiles, geometryRows, geometryReferenced);

  console.log(`canonical key backfill complete: ${keyed} keys written, ${merged} duplicates merged, ${suffixed} suffixed`);
} finally {
  await sql.end();
}
