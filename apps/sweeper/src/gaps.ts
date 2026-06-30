import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";

export interface Gap {
  airfoilId: string;
  bcId: string;
  presetId: string;
  presetRevisionId: string;
  aoaDeg: number;
}

/**
 * Find (airfoil × enabled boundary-condition × aoa) triples that need solving:
 * no result row yet, or one that's pending/stale (and not currently claimed
 * by a live job). Failed rows are evidence and are not automatically retried;
 * admins can explicitly requeue them back to pending. Enqueued points
 * (priority > 0) sort first, then cheapest Re.
 */
export async function findGaps(db: DB, limit = 500): Promise<Gap[]> {
  await db.execute(sql`
    WITH expired AS (
      UPDATE sync_sweep_promises
      SET status = 'expired', "expiredAt" = now(), "updatedAt" = now()
      WHERE status = 'active' AND "expiresAt" <= now()
      RETURNING id
    )
    UPDATE sync_sweep_promise_points
    SET status = 'expired', "updatedAt" = now()
    WHERE status = 'active' AND promise_id IN (SELECT id FROM expired)
  `);
  const rows = await db.execute(sql`
    WITH latest_revision AS (
      SELECT DISTINCT ON (preset_id) preset_id, id, reynolds
      FROM simulation_preset_revisions
      ORDER BY preset_id, revision_number DESC
    )
    SELECT a.id AS airfoil_id, b.id AS bc_id, g.aoa::float8 AS aoa_deg,
           p.id AS preset_id, rev.id AS preset_revision_id,
           COALESCE(r.priority, 0) AS priority
    FROM airfoils a
    CROSS JOIN simulation_presets p
    JOIN latest_revision rev ON rev.preset_id = p.id
    JOIN boundary_conditions b ON b.id = p.legacy_boundary_condition_id
    JOIN sweep_definitions sw ON sw.id = p.sweep_definition_id
    CROSS JOIN LATERAL (
      SELECT jsonb_array_elements_text(sw.aoa_list)::numeric AS aoa WHERE sw.aoa_list IS NOT NULL
      UNION ALL
      SELECT generate_series(sw.aoa_start::numeric, sw.aoa_stop::numeric, sw.aoa_step::numeric) AS aoa WHERE sw.aoa_list IS NULL
    ) AS g
    LEFT JOIN results r
      ON r.airfoil_id = a.id AND r.simulation_preset_revision_id = rev.id AND r.aoa_deg = g.aoa
    WHERE p.enabled = true
      AND (
        p.target_scope = 'all'
        OR EXISTS (
          SELECT 1
          FROM simulation_preset_airfoil_targets target
          WHERE target.preset_id = p.id AND target.airfoil_id = a.id
        )
      )
      AND a."archivedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND (r.id IS NULL OR r.status IN ('pending', 'stale'))
      AND NOT EXISTS (
        SELECT 1
        FROM sync_sweep_promise_points pp
        JOIN sync_sweep_promises pr ON pr.id = pp.promise_id
        WHERE pp.airfoil_id = a.id
          AND pp.simulation_preset_revision_id = rev.id
          AND pp.aoa_deg = g.aoa
          AND pp.status = 'active'
          AND pr.status = 'active'
          AND pr."expiresAt" > now()
      )
    ORDER BY COALESCE(r.priority, 0) DESC, rev.reynolds ASC, a.slug ASC, g.aoa ASC
    LIMIT ${limit}
  `);
  return (rows as unknown as { airfoil_id: string; bc_id: string; preset_id: string; preset_revision_id: string; aoa_deg: number }[]).map((r) => ({
    airfoilId: r.airfoil_id,
    bcId: r.bc_id,
    presetId: r.preset_id,
    presetRevisionId: r.preset_revision_id,
    aoaDeg: Number(r.aoa_deg),
  }));
}

/** Pick the highest-priority (airfoil, bc) group from a gap list — one job's worth
 *  of work (one mesh, the BC's gap AoAs). */
export function firstBatch(gaps: Gap[]): { airfoilId: string; bcId: string; presetId: string; presetRevisionId: string; aoas: number[] } | null {
  if (gaps.length === 0) return null;
  const head = gaps[0];
  const aoas = gaps
    .filter((g) => g.airfoilId === head.airfoilId && g.presetRevisionId === head.presetRevisionId)
    .map((g) => g.aoaDeg)
    .sort((x, y) => x - y);
  return { airfoilId: head.airfoilId, bcId: head.bcId, presetId: head.presetId, presetRevisionId: head.presetRevisionId, aoas };
}
