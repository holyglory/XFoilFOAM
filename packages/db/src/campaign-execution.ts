// Sweeper-side campaign execution helpers (docs/simulation-campaigns-spec.md
// §7 scheduling & execution, §8 refinement lanes). Everything the sweeper
// needs lives here — campaign candidate selection, the unified ordering
// contract with the continuous branch, ingest-time point terminal-linking and
// counter maintenance, the refinement lane state machine, and the
// low-frequency campaign reconciler. This module is independent of the
// API-side launch/plan-edit code (campaigns.ts).

import {
  canonicalAoa,
  canonicalSi,
  canonicalSiString,
  DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER,
  DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER,
  POLAR_FIT_VERSION,
} from "@aerodb/core";
import { and, asc, desc, eq, sql, type SQLWrapper } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DB } from "./client";
import { lockPrecalcCells } from "./precalc-cell-lock";
import {
  RANS_RECOVERY_REMEDIATION_VERSION,
  ransMeshRecoveryRemediationVersion,
  recordSolverIncidentInTransaction,
  resolveOlderRansMeshIncidentsInTransaction,
  resolveSolverIncidentsForAcceptedResultsInTransaction,
} from "./solver-incidents";
import {
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_SNAPSHOT,
  type SolverImplementationSnapshot,
} from "./solver-implementations";
import {
  airfoils,
  polarFitSets,
  simCampaignConditions,
  simCampaignLaneSteps,
  simCampaignLanes,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaigns,
} from "./schema";

// ---------------------------------------------------------------------------
// Unified ordering contract (spec §7 "one total order"): both branches are
// ranked by effectivePriority DESC, reynolds ASC, slug ASC, aoa ASC. The
// continuous branch head carries effectivePriority = the group's max
// results.priority (0 default, 10 public); the campaign branch head carries
// effectivePriority = campaign.priority (capped at 9 so public always wins).
// ---------------------------------------------------------------------------
export interface ScheduleCandidate {
  effectivePriority: number;
  reynolds: number;
  slug: string;
  aoa: number;
}

/** Negative → a schedules before b. Pure so the winner-per-tick rule is unit-testable. */
export function compareScheduleCandidates(
  a: ScheduleCandidate,
  b: ScheduleCandidate,
): number {
  if (a.effectivePriority !== b.effectivePriority)
    return b.effectivePriority - a.effectivePriority;
  if (a.reynolds !== b.reynolds) return a.reynolds - b.reynolds;
  if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
  return a.aoa - b.aoa;
}

// ---------------------------------------------------------------------------
// Campaign gap candidates (spec §7): sim_campaign_points state='requested' of
// ACTIVE campaigns, minus active sync-promise points, minus points whose
// results row is already queued/running/done/failed (failed rows are evidence;
// admins requeue them explicitly), excluding derivedBySymmetry rows and — for
// symmetric airfoils — any α < 0 defensively (spec §9.2/§9.4).
//
// Batching (execution-efficiency decision, 2026-07-04): one campaign job =
// (campaign, airfoil, chord, compatible physics group, identical open-angle
// set) × ALL its open speeds, so the engine meshes once per airfoil-chord and
// marches every speed×angle warm-started. Conditions may share a job ONLY if
// their pinned revision snapshots have identical ambient fluid state
// (temperature/pressure/density/dynamicViscosity — speed excluded) AND
// identical boundary/mesh/solver/output blocks plus any pinned per-tier URANS
// mesh blocks (value-compared, row identity excluded), a single chord per job,
// and identical open-angle sets (ONE aoa list per engine request; unioning
// would re-solve already-solved points).
// ---------------------------------------------------------------------------

/** Case budget per batched campaign job: speeds × angles ≤ this, min 1 speed. */
export const CAMPAIGN_MAX_CASES_PER_JOB = 256;

/** Durable wave-2 child settlement predicate.
 *
 * Live children and done children with no routed retry already block duplicate
 * composition. A done, failed, OR cancelled precalc child also settles its
 * parent when EVERY angle in that
 * child's stored request has immutable deterministic mesh-QA evidence:
 * replaying the same revision can only rebuild the same rejected mesh.
 * Requiring full requested-angle coverage is important for partially-ingested
 * cancellations: one blocked angle must not hide an unattempted/transient
 * sibling that still deserves a precalc retry.
 *
 * The column arguments make this one predicate reusable with both the real
 * sim_jobs table and an aliased correlated child table. */
export function settledCampaignUransChildSql(columns: {
  id: SQLWrapper;
  status: SQLWrapper;
  requestPayload: SQLWrapper;
}) {
  // A parent can drain several physical cells through sequential children.
  // Settlement is parent-wide: inspect every obligation id carried by every
  // sibling payload.  latest_sim_job_id is deliberately not the ownership
  // relation here (a crash before ledger submission, or a later continuation,
  // may leave it null/pointing elsewhere while the original payload still
  // proves that the parent owns the cell).
  const noOpenSiblingObligation = sql`NOT EXISTS (
    SELECT 1
    FROM sim_jobs current_child
    JOIN sim_jobs sibling_child
      ON sibling_child.parent_job_id = current_child.parent_job_id
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(sibling_child.request_payload -> 'precalcObligationIds') = 'array'
        THEN sibling_child.request_payload -> 'precalcObligationIds'
        ELSE '[]'::jsonb
      END
    ) payload_obligation(id)
    JOIN sim_precalc_obligations sibling_obligation
      ON sibling_obligation.id = payload_obligation.id::uuid
    WHERE current_child.id = ${columns.id}
      AND sibling_obligation.state IN ('pending', 'running')
  )`;
  return sql`(
    ${columns.status} IN ('pending', 'submitted', 'running', 'ingesting')
    OR (
      ${columns.status} = 'done'
      AND (${noOpenSiblingObligation})
      AND NOT EXISTS (
        SELECT 1
        FROM result_attempts routed_attempt
        JOIN results routed_result ON routed_result.id = routed_attempt.result_id
        WHERE routed_attempt.sim_job_id = ${columns.id}
          AND routed_result.status = 'queued'
          AND routed_result.sim_job_id IS NULL
          AND routed_result.fidelity = 'urans_precalc'
          AND routed_result.auto_retried_at IS NOT NULL
      )
    )
    OR (
      ${columns.status} IN ('done', 'failed', 'cancelled')
      AND (${noOpenSiblingObligation})
      AND jsonb_typeof(${columns.requestPayload} -> 'precalcObligationIds') = 'array'
      AND jsonb_array_length(${columns.requestPayload} -> 'precalcObligationIds') > 0
    )
    OR (
      ${columns.status} IN ('done', 'failed', 'cancelled')
      AND (${noOpenSiblingObligation})
      AND EXISTS (
        SELECT 1 FROM sim_precalc_obligations known_obligation
        WHERE known_obligation.latest_sim_job_id = ${columns.id}
      )
      AND NOT EXISTS (
        SELECT 1 FROM sim_precalc_obligations open_obligation
        WHERE open_obligation.latest_sim_job_id = ${columns.id}
          AND open_obligation.state IN ('pending', 'running')
      )
    )
    OR (
      ${columns.status} IN ('done', 'failed', 'cancelled')
      AND (${noOpenSiblingObligation})
      AND ${columns.requestPayload} ->> 'uransFidelity' = 'precalc'
      AND jsonb_typeof(${columns.requestPayload} -> 'aoas') = 'array'
      AND jsonb_array_length(${columns.requestPayload} -> 'aoas') > 0
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${columns.requestPayload} -> 'aoas') requested_aoa(value)
        WHERE NOT EXISTS (
          SELECT 1
          FROM results deterministic_result
          WHERE deterministic_result.sim_job_id = ${columns.id}
            AND deterministic_result.aoa_deg = requested_aoa.value::float8
            AND position('mesh degenerate at this fidelity tier' in lower(COALESCE(deterministic_result.error, ''))) > 0
            AND position('max non-orthogonality' in lower(COALESCE(deterministic_result.error, ''))) > 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM result_attempts deterministic_attempt
          WHERE deterministic_attempt.sim_job_id = ${columns.id}
            AND deterministic_attempt.aoa_deg = requested_aoa.value::float8
            AND position('mesh degenerate at this fidelity tier' in lower(COALESCE(deterministic_attempt.error, ''))) > 0
            AND position('max non-orthogonality' in lower(COALESCE(deterministic_attempt.error, ''))) > 0
        )
      )
    )
  )`;
}

/** Minimal structural view of the pinned revision snapshot the grouping rules
 *  read (the jsonb payload always carries these blocks). */
export interface CampaignBatchSnapshot {
  preset?: { legacyBoundaryConditionId?: string | null };
  engine?: SolverImplementationSnapshot;
  flowState: {
    mediumId: string;
    temperatureK: number;
    pressurePa: number;
    speedMps: number;
    density: number;
    dynamicViscosity: number;
    mach?: number | null;
  };
  referenceGeometry: {
    geometryType: string;
    referenceLengthKind: string;
    referenceLengthM: number;
    spanM: number | null;
    referenceAreaM2: number | null;
  };
  boundary: {
    turbulenceIntensity: number;
    viscosityRatio: number;
    sandGrainHeight: number;
    roughnessConstant: number;
  };
  mesh: Record<string, unknown>;
  uransMesh?: Record<string, unknown> | null;
  uransPrecalcMesh?: Record<string, unknown> | null;
  solver: Record<string, unknown>;
  output: Record<string, unknown>;
}

/** One (condition, speed) member of a batched campaign job. bcId is resolved
 *  by the sweeper claim path (snapshot legacy id first, live preset fallback). */
export interface CampaignBatchEntry {
  conditionId: string;
  revisionId: string;
  presetId: string;
  /** Canonical SI speed (canonicalSi('speedMps', …)) — the engine request and
   *  the ingest speed→condition mapping both use this exact value. */
  speed: number;
  reynolds: number;
  /** Immutable complete non-derived AoA request for this campaign condition and
   * airfoil, including cells already solved before this gap batch. */
  requestedPolarAoas: number[];
}

/** Open (condition, angle-set) aggregate used by the pure grouping rules. */
export interface CampaignConditionCandidate {
  conditionId: string;
  revisionId: string;
  presetId: string;
  reynolds: number;
  /** Open aoas of this (campaign, condition, airfoil), ascending canonical. */
  aoas: number[];
  /** Complete non-derived requested polar, not merely the currently open gaps. */
  requestedPolarAoas: number[];
  snapshot: CampaignBatchSnapshot;
}

export interface CampaignGapBatch {
  campaignId: string;
  airfoilId: string;
  /** Single chord per job (canonical m) — a mesh is per-chord anyway. */
  chord: number;
  /** Shared open-angle set of every entry, ascending canonical. */
  angles: number[];
  /** Batched (condition, speed) members, reynolds ASC; [0] is the min-Re
   *  anchor whose pinned snapshot supplies the job physics. */
  entries: CampaignBatchEntry[];
  effectivePriority: number;
  /** Ordering key of the one-total-order comparator: min reynolds over entries. */
  reynolds: number;
  slug: string;
  /** Ordering key of the head candidate (first row of the total order). */
  headAoa: number;
  /** Distinct open (campaign, airfoil, revision) groups among fetched candidates. */
  openGroupCount: number;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function withoutRowIdentity(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const { id: _id, slug: _slug, name: _name, ...values } = block ?? {};
  return values;
}

/**
 * Physics-group signature (binding batching rules 1–2): conditions may share a
 * job ONLY when this key matches — identical ambient fluid state (T, P,
 * density, dynamicViscosity; speed deliberately excluded), single chord, and
 * identical boundary/mesh/solver/output blocks compared by VALUES. Optional
 * per-tier URANS mesh pins join the key only when present. Row id/slug/name is
 * excluded, mirroring physicsHashForSnapshot's discipline so value-identical
 * profiles group together across presets.
 */
export function campaignBatchGroupKey(snapshot: CampaignBatchSnapshot): string {
  const engine =
    snapshot.engine ?? LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_SNAPSHOT;
  const subset = {
    // Execution grouping includes the adapter contract even though public
    // polar compatibility does not: one engine job must use one wire dialect.
    engine: {
      key: engine.key,
      family: engine.family,
      distribution: engine.distribution,
      releaseVersion: engine.releaseVersion,
      methodFamily: engine.methodFamily,
      adapterContractVersion: engine.adapterContractVersion,
      numericsRevision: engine.numericsRevision,
    },
    ambient: {
      mediumId: snapshot.flowState.mediumId,
      temperatureK: snapshot.flowState.temperatureK,
      pressurePa: snapshot.flowState.pressurePa,
      density: snapshot.flowState.density,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
    },
    referenceGeometry: {
      geometryType: snapshot.referenceGeometry.geometryType,
      referenceLengthKind: snapshot.referenceGeometry.referenceLengthKind,
      chord: canonicalSiString(
        "chordM",
        snapshot.referenceGeometry.referenceLengthM,
      ),
      spanM: snapshot.referenceGeometry.spanM,
      referenceAreaM2: snapshot.referenceGeometry.referenceAreaM2,
    },
    boundary: {
      turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
      viscosityRatio: snapshot.boundary.viscosityRatio,
      sandGrainHeight: snapshot.boundary.sandGrainHeight,
      roughnessConstant: snapshot.boundary.roughnessConstant,
    },
    mesh: withoutRowIdentity(snapshot.mesh),
    ...(snapshot.uransMesh
      ? { uransMesh: withoutRowIdentity(snapshot.uransMesh) }
      : {}),
    ...(snapshot.uransPrecalcMesh
      ? { uransPrecalcMesh: withoutRowIdentity(snapshot.uransPrecalcMesh) }
      : {}),
    solver: withoutRowIdentity(snapshot.solver),
    output: withoutRowIdentity(snapshot.output),
  };
  return createHash("sha256").update(stableStringify(subset)).digest("hex");
}

function angleSetKey(aoas: number[]): string {
  return aoas.map((a) => canonicalAoa(a)).join(",");
}

/**
 * Pure grouping (binding rules 1–3): the head condition anchors the group;
 * every candidate with the same physics-group key AND the same open-angle set
 * joins as one (condition, speed) entry, sorted reynolds ASC (conditionId as a
 * deterministic tiebreak). Different ambients, different chords, different
 * numerics blocks, or different open-angle sets NEVER share a job.
 */
export function groupCampaignBatchEntries(
  head: CampaignConditionCandidate,
  candidates: CampaignConditionCandidate[],
): { chord: number; angles: number[]; entries: CampaignBatchEntry[] } {
  const headGroup = campaignBatchGroupKey(head.snapshot);
  const headAngles = angleSetKey(head.aoas);
  const headRequestedPolar = angleSetKey(head.requestedPolarAoas);
  const entries = candidates
    .filter(
      (c) =>
        campaignBatchGroupKey(c.snapshot) === headGroup &&
        angleSetKey(c.aoas) === headAngles &&
        angleSetKey(c.requestedPolarAoas) === headRequestedPolar,
    )
    .map((c) => ({
      conditionId: c.conditionId,
      revisionId: c.revisionId,
      presetId: c.presetId,
      speed: canonicalSi("speedMps", c.snapshot.flowState.speedMps),
      reynolds: Number(c.reynolds),
      requestedPolarAoas: [
        ...new Set(c.requestedPolarAoas.map(canonicalAoa)),
      ].sort((x, y) => x - y),
    }))
    .sort((x, y) =>
      x.reynolds !== y.reynolds
        ? x.reynolds - y.reynolds
        : x.conditionId < y.conditionId
          ? -1
          : 1,
    );
  return {
    chord: canonicalSi(
      "chordM",
      head.snapshot.referenceGeometry.referenceLengthM,
    ),
    angles: [...new Set(head.aoas.map((a) => canonicalAoa(a)))].sort(
      (x, y) => x - y,
    ),
    entries,
  };
}

/** Case-budget chunking (binding rule 4): greedily take the lowest-Re speeds
 *  so speeds × angles ≤ maxCases, min 1 speed per job. Entries must already be
 *  reynolds ASC, so the min-Re anchor is always in the head chunk. */
export function chunkCampaignSpeeds(
  entries: CampaignBatchEntry[],
  angleCount: number,
  maxCases: number = CAMPAIGN_MAX_CASES_PER_JOB,
): CampaignBatchEntry[] {
  const maxSpeeds = Math.max(1, Math.floor(maxCases / Math.max(1, angleCount)));
  return entries.slice(0, maxSpeeds);
}

interface CampaignGapRow {
  campaign_id: string;
  condition_id: string;
  airfoil_id: string;
  aoa_deg: number;
  revision_id: string;
  preset_id: string;
  priority: number;
  reynolds: number;
  slug: string;
}

interface CampaignConditionAggregateRow {
  condition_id: string;
  revision_id: string;
  preset_id: string;
  reynolds: number;
  snapshot: CampaignBatchSnapshot;
  aoas: number[];
  requested_aoas: number[];
}

export async function findCampaignGapBatch(
  db: DB,
  opts: { limit?: number; campaignIds?: string[] } = {},
): Promise<CampaignGapBatch | null> {
  const limit = opts.limit ?? 500;
  const campaignFilter = opts.campaignIds?.length
    ? sql`AND p.campaign_id = ANY(${sql`ARRAY[${sql.join(
        opts.campaignIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})`
    : sql``;
  const exclusions = sql`
      p.state = 'requested'
      AND p.derived_by_symmetry = false
      AND NOT (a.is_symmetric AND p.aoa_deg < 0)
      AND a."archivedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND (
        r.id IS NULL
        OR (
          r.status IN ('pending', 'stale')
          AND (
            submit_retry.result_id IS NULL
            OR submit_retry.state <> 'retry_wait'
            OR submit_retry.next_attempt_at <= now()
          )
        )
      )
      AND (r.id IS NULL OR (
        r.regime IS DISTINCT FROM 'urans'
        AND COALESCE(r.fidelity::text, '') NOT LIKE 'urans%'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM sim_precalc_obligations obligation
        WHERE obligation.airfoil_id = p.airfoil_id
          AND obligation.revision_id = p.revision_id
          AND obligation.aoa_deg = p.aoa_deg
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sync_sweep_promise_points pp
        JOIN sync_sweep_promises pr ON pr.id = pp.promise_id
        WHERE pp.airfoil_id = p.airfoil_id
          AND pp.simulation_preset_revision_id = p.revision_id
          AND pp.aoa_deg = p.aoa_deg
          AND pp.status = 'active'
          AND pr.status = 'active'
          AND pr."expiresAt" > now()
      )`;
  const rows = (await db.execute(sql`
    SELECT p.campaign_id, p.condition_id, p.airfoil_id, p.aoa_deg::float8 AS aoa_deg,
           p.revision_id, cond.preset_id, camp.priority, cond.reynolds, a.slug
    FROM sim_campaign_points p
    JOIN sim_campaigns camp ON camp.id = p.campaign_id AND camp.status = 'active'
    JOIN sim_campaign_conditions cond
      ON cond.id = p.condition_id
     AND cond.generation = camp.current_condition_generation
     AND cond.status IN ('active', 'kept')
    JOIN airfoils a ON a.id = p.airfoil_id
    LEFT JOIN results r
      ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
    LEFT JOIN sim_result_submit_retries submit_retry ON submit_retry.result_id = r.id
    WHERE ${exclusions}
      ${campaignFilter}
    ORDER BY camp.priority DESC, cond.reynolds ASC, a.slug ASC, p.aoa_deg ASC
    LIMIT ${limit}
  `)) as unknown as CampaignGapRow[];
  if (!rows.length) return null;
  const head = rows[0];
  const groupOf = (r: CampaignGapRow) =>
    `${r.campaign_id}:${r.airfoil_id}:${r.revision_id}`;

  // Aggregate ALL open points of the head (campaign, airfoil) per condition —
  // never the LIMITed candidate page, so open-angle-set equality is judged on
  // complete sets (a truncated page must not make two conditions look equal).
  const aggregates = (await db.execute(sql`
    SELECT p.condition_id, p.revision_id, cond.preset_id, cond.reynolds,
           rev.snapshot AS snapshot,
           ARRAY(
             SELECT DISTINCT full_point.aoa_deg::float8
             FROM sim_campaign_points full_point
             WHERE full_point.campaign_id = ${head.campaign_id}
               AND full_point.airfoil_id = ${head.airfoil_id}
               AND full_point.condition_id = p.condition_id
               AND full_point.derived_by_symmetry = false
             ORDER BY full_point.aoa_deg::float8
           ) AS requested_aoas,
           array_agg(p.aoa_deg::float8 ORDER BY p.aoa_deg) AS aoas
    FROM sim_campaign_points p
    JOIN sim_campaigns camp ON camp.id = p.campaign_id
    JOIN sim_campaign_conditions cond
      ON cond.id = p.condition_id
     AND cond.generation = camp.current_condition_generation
     AND cond.status IN ('active', 'kept')
    JOIN simulation_preset_revisions rev ON rev.id = p.revision_id
    JOIN airfoils a ON a.id = p.airfoil_id
    LEFT JOIN results r
      ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
    LEFT JOIN sim_result_submit_retries submit_retry ON submit_retry.result_id = r.id
    WHERE p.campaign_id = ${head.campaign_id}
      AND p.airfoil_id = ${head.airfoil_id}
      AND ${exclusions}
    GROUP BY p.condition_id, p.revision_id, cond.preset_id, cond.reynolds, rev.snapshot
  `)) as unknown as CampaignConditionAggregateRow[];
  const candidates: CampaignConditionCandidate[] = aggregates.map((r) => ({
    conditionId: r.condition_id,
    revisionId: r.revision_id,
    presetId: r.preset_id,
    reynolds: Number(r.reynolds),
    aoas: (r.aoas ?? []).map(Number),
    requestedPolarAoas: (r.requested_aoas ?? []).map(Number),
    snapshot: r.snapshot,
  }));
  const headCandidate = candidates.find(
    (c) => c.conditionId === head.condition_id,
  );
  if (!headCandidate) return null;

  const grouped = groupCampaignBatchEntries(headCandidate, candidates);
  const entries = chunkCampaignSpeeds(grouped.entries, grouped.angles.length);
  if (!entries.length || !grouped.angles.length) return null;
  return {
    campaignId: head.campaign_id,
    airfoilId: head.airfoil_id,
    chord: grouped.chord,
    angles: grouped.angles,
    entries,
    effectivePriority: Number(head.priority),
    reynolds: entries[0].reynolds,
    slug: head.slug,
    headAoa: Number(head.aoa_deg),
    openGroupCount: new Set(rows.map(groupOf)).size,
  };
}

// ---------------------------------------------------------------------------
// Ingest hooks (spec §7): terminal-link campaign points, flip derived-by-
// symmetry cells alongside their +α source, bump progress counters
// idempotently (recompute from points+results, never blind increments),
// enqueue dirty lane keys, and run the cheap completion probe.
// ---------------------------------------------------------------------------
export interface CampaignLaneKey {
  campaignId: string;
  airfoilId: string;
  conditionId: string;
  objective: string;
}

export function laneKeyId(key: CampaignLaneKey): string {
  return `${key.campaignId}:${key.airfoilId}:${key.conditionId}:${key.objective}`;
}

export interface ResultIngestSignal {
  airfoilId: string;
  revisionId: string | null;
  aoaDeg: number;
  resultId: string;
  status: string;
  regime?: string | null;
}

interface ProgressKeyRow {
  campaign_id: string;
  condition_id: string;
  airfoil_id: string;
}

function dedupeProgressKeys(rows: ProgressKeyRow[]): ProgressKeyRow[] {
  const seen = new Map<string, ProgressKeyRow>();
  for (const row of rows)
    seen.set(`${row.campaign_id}:${row.condition_id}:${row.airfoil_id}`, row);
  return [...seen.values()];
}

/** Idempotent counter maintenance: recompute the affected (campaign, condition,
 *  airfoil) rows from sim_campaign_points + results instead of incrementing.
 *  CANONICAL counter model (shared verbatim with recomputeProgressForCampaign
 *  and the launch/plan-edit recomputeCampaignProgress wrapper in campaigns.ts):
 *   - requested:  state <> 'released' — TOTAL obligation (the UI denominator
 *                 and deriveCampaignCompletion both read it as the whole
 *                 obligated cell count, not just still-open cells)
 *   - solved:     terminal, non-derived, result.status='done' AND an explicit
 *                 usable classification (accepted / needs_urans /
 *                 superseded_by_urans); unclassified evidence fails closed
 *   - blocked:    physical cell whose bounded PRECALC obligation is terminal
 *                 blocked, plus terminal unclassified/unrecognized evidence;
 *                 this bucket takes precedence over failed/rejected. While an
 *                 exact obligation is pending/running, its retained parent
 *                 failure/rejection stays in evidence but in none of these
 *                 terminal attention buckets; machine remediation still owns
 *                 the remaining work.
 *   - rejected:   terminal, non-derived, result.status='done' AND
 *                 result_classifications.state='rejected', unless blocked
 *   - failed:     terminal, non-derived, result.status='failed' (mirrors are
 *                 excluded like solved/rejected: a failed source's mirror is
 *                 terminal-linked to the SAME failed results row, so counting
 *                 it here double-books the cell — once in derived, once in
 *                 failed — and the failed chip exceeds its Points-tab
 *                 click-through list, which lists source rows only)
 *   - running:    requested AND live-cell result.status IN (queued, running)
 *                 AND its owning sim_job is submitted/running/ingesting;
 *                 ownerless or terminal-job queue residue is waiting work,
 *                 never an active solve
 *   - superseded: result_classifications.state='superseded_by_urans'
 *   - derived:    terminal mirror whose linked source has an explicit usable
 *                 classification and no blocked physical PRECALC obligation
 *   - blocked:    additionally includes terminal mirrors whose linked source
 *                 is failed/unclassified, or whose SOURCE-cell obligation is
 *                 blocked; rejected mirrors with open ladder work stay open
 *                 exactly balanced
 *  Do not diverge these between the incremental and whole-campaign paths — the
 *  first production campaign drifted precisely because two paths disagreed. */
/** Tuple lists are bounded per statement: beyond this, template flattening
 *  overflows the JS stack and postgres's 65,534-parameter cap looms. Callers
 *  with whole-campaign scope use recomputeProgressForCampaign instead. */
const PROGRESS_KEY_CHUNK = 500;

/** A results-row status is not execution ownership. Composition cancellation,
 * a lost submit boundary, or an older cleanup path can leave a queued row with
 * no sim_job (the production incident had 60). Only a live owning job may
 * contribute to the user-visible running counter. Keep this predicate and the
 * live_job join identical in both recompute paths. */
const ACTIVE_LIVE_RESULT_SQL = sql`(
  live.status IN ('queued', 'running')
  AND live_job.status IN ('submitted', 'running', 'ingesting')
)`;

/** A retained parent result may enter a terminal attention bucket only when
 * no exact preliminary-URANS remediation is active or terminal-blocked. The
 * explicit blocked branch owns `blocked`; pending/running obligations remain
 * machine-owned work. NULL, satisfied, and cancelled obligations fall back to
 * the canonical result/classification state. Keep this fragment shared by the
 * incremental and whole-campaign aggregations. */
const PRECALC_RESULT_TERMINAL_BUCKET_SQL = sql`
  precalc_obligation.state IS DISTINCT FROM 'pending'
  AND precalc_obligation.state IS DISTINCT FROM 'running'
  AND precalc_obligation.state IS DISTINCT FROM 'blocked'
`;

/** Operator-facing failure/rejection is a terminal URANS outcome only.
 * Steady RANS rejection is normal ladder input and remains unfinished work,
 * even if its canonical result projection is `failed`. The correlated
 * obligation exclusion keeps the progress counters and failure/rejection
 * drawers exactly disjoint from machine-owned pending/running/blocked work.
 *
 * This fragment deliberately uses the canonical `p` / `r` aliases shared by
 * the progress queries and campaigns.ts failure-list queries. */
export const USER_TERMINAL_CAMPAIGN_RESULT_SQL = sql`(
  (
    COALESCE(r.regime::text, '') = 'urans'
    OR COALESCE(r.fidelity::text, '') LIKE 'urans%'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM sim_precalc_obligations user_terminal_obligation
    WHERE user_terminal_obligation.airfoil_id = p.airfoil_id
      AND user_terminal_obligation.revision_id = p.revision_id
      AND user_terminal_obligation.aoa_deg = p.aoa_deg
      AND user_terminal_obligation.state IN ('pending', 'running', 'blocked')
  )
)`;

const USER_TERMINAL_URANS_FIDELITY_SQL = sql`(
  COALESCE(r.regime::text, '') = 'urans'
  OR COALESCE(r.fidelity::text, '') LIKE 'urans%'
)`;

const NON_URANS_RESULT_SQL = sql`(
  NOT (${USER_TERMINAL_URANS_FIDELITY_SQL})
)`;

/** Exact immutable RANS evidence that owns the normal automatic handoff.
 *
 * Rejected attempts are deliberately allowed to be pointer-null, so this
 * predicate cannot rely on results.current_result_attempt_id or the
 * result-scoped classification projection. It fences the latest attempt to
 * the canonical result AND exact producing job/cell. Typed hard_solver
 * evidence is authoritative. The pre-contract fallback is intentionally much
 * narrower: only a completed, solved, error-free RANS attempt with an
 * aerodynamic rejection reason may enter the ladder. Failed/queued shells are
 * infrastructure-shaped even when a legacy classifier happened to stamp
 * "not-converged".
 *
 * This fragment uses the canonical `r` alias shared by both progress paths and
 * the completion probe. */
const AUTOMATIC_RANS_HANDOFF_RESULT_SQL = sql`(
  (${NON_URANS_RESULT_SQL})
  AND EXISTS (
    SELECT 1
    FROM result_attempts handoff_attempt
    JOIN result_classifications handoff_classification
      ON handoff_classification.result_attempt_id = handoff_attempt.id
    WHERE handoff_attempt.result_id = r.id
      AND handoff_attempt.airfoil_id = r.airfoil_id
      AND handoff_attempt.simulation_preset_revision_id
            IS NOT DISTINCT FROM r.simulation_preset_revision_id
      AND handoff_attempt.aoa_deg = r.aoa_deg
      AND handoff_attempt.sim_job_id IS NOT DISTINCT FROM r.sim_job_id
      AND handoff_attempt.regime = 'rans'
      AND NOT EXISTS (
        SELECT 1
        FROM result_attempts newer_handoff_attempt
        WHERE newer_handoff_attempt.result_id = handoff_attempt.result_id
          AND newer_handoff_attempt.sim_job_id
                IS NOT DISTINCT FROM handoff_attempt.sim_job_id
          AND (
            newer_handoff_attempt."createdAt" > handoff_attempt."createdAt"
            OR (
              newer_handoff_attempt."createdAt" = handoff_attempt."createdAt"
              AND newer_handoff_attempt.id > handoff_attempt.id
            )
          )
      )
      AND (
        handoff_classification.state = 'needs_urans'
        OR (
          handoff_classification.state = 'rejected'
          AND (
            handoff_attempt.evidence_payload ->> 'failure_disposition' = 'hard_solver'
            OR (
              handoff_attempt.evidence_payload ->> 'failure_disposition' IS NULL
              AND handoff_attempt.status = 'done'
              AND handoff_attempt.source = 'solved'
              AND NULLIF(btrim(handoff_attempt.error), '') IS NULL
              AND handoff_classification.reasons
                    && ARRAY['not-converged', 'solver-stalled']::text[]
            )
          )
        )
      )
  )
)`;

/** Deterministic RANS mesh/setup evidence is terminal without consuming the
 * generic crash retry. Typed disposition wins over text. Only when the latest
 * exact attempt predates typed dispositions (or no attempt exists at all) may
 * the paired legacy markers classify the result as mesh-quality work. */
const TERMINAL_RANS_DETERMINISTIC_MESH_SQL = sql`(
  (${NON_URANS_RESULT_SQL})
  AND COALESCE(
    (
      SELECT CASE
        WHEN deterministic_attempt.evidence_payload ->> 'failure_disposition' = 'deterministic_mesh'
          THEN true
        WHEN deterministic_attempt.evidence_payload ->> 'failure_disposition' IS NULL
          THEN (
            position(${DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER} in lower(COALESCE(deterministic_attempt.error, ''))) > 0
            AND position(${DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER} in lower(COALESCE(deterministic_attempt.error, ''))) > 0
          )
        ELSE false
      END
      FROM result_attempts deterministic_attempt
      WHERE deterministic_attempt.result_id = r.id
        AND deterministic_attempt.airfoil_id = r.airfoil_id
        AND deterministic_attempt.simulation_preset_revision_id
              IS NOT DISTINCT FROM r.simulation_preset_revision_id
        AND deterministic_attempt.aoa_deg = r.aoa_deg
        AND deterministic_attempt.sim_job_id IS NOT DISTINCT FROM r.sim_job_id
        AND deterministic_attempt.regime = 'rans'
      ORDER BY deterministic_attempt."createdAt" DESC, deterministic_attempt.id DESC
      LIMIT 1
    ),
    (
      position(${DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER} in lower(COALESCE(r.error, ''))) > 0
      AND position(${DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER} in lower(COALESCE(r.error, ''))) > 0
    )
  )
)`;

const RESULT_SUBMIT_BLOCKED_SQL = sql`EXISTS (
  SELECT 1
  FROM sim_result_submit_retries submit_retry
  WHERE submit_retry.result_id = r.id
    AND submit_retry.state = 'blocked'
)`;

/** A non-aerodynamic RANS terminal becomes a user-visible critical blocker
 * only after machine recovery is genuinely terminal:
 *   - deterministic mesh/setup evidence has no unchanged retry;
 *   - an answered engine submission is durably blocked; or
 *   - the one generic crash retry was already consumed.
 *
 * The first untyped/infrastructure-shaped crash remains transient between
 * partial ingest and autoRetryCrashedResultsForJob; otherwise fast polling can
 * flash a false critical state before the retry transaction reopens it. A
 * done-but-rejected RANS row that is not exact handoff evidence has no retry
 * owner and is therefore also terminal unavailable evidence. */
const TERMINAL_RANS_MACHINE_BLOCKER_SQL = sql`(
  (${NON_URANS_RESULT_SQL})
  AND NOT (${AUTOMATIC_RANS_HANDOFF_RESULT_SQL})
  AND (
    (${RESULT_SUBMIT_BLOCKED_SQL})
    OR (
      r.status = 'failed'
      AND (
        r.auto_retried_at IS NOT NULL
        OR (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
      )
    )
    OR (
      r.status = 'done'
      AND rc.state = 'rejected'
    )
  )
)`;

/** Temporary visibility guard for the narrow ingest→generic-retry boundary.
 * This state is still machine-owned open work, never a failed/rejected point
 * and never a critical blocker until retry exhaustion is persisted. */
const TRANSIENT_RANS_MACHINE_RECOVERY_SQL = sql`(
  r.status = 'failed'
  AND (${NON_URANS_RESULT_SQL})
  AND NOT (${AUTOMATIC_RANS_HANDOFF_RESULT_SQL})
  AND NOT (${TERMINAL_RANS_MACHINE_BLOCKER_SQL})
)`;

/** Legacy rows predate typed obligation-attempt outcomes. They qualify as a
 * deterministic mesh blocker only when BOTH pinned engine markers are
 * present; a generic infrastructure error which merely contains "mesh" must
 * never enter the mesh-remediation bucket. */
const PRECALC_LEGACY_DETERMINISTIC_MESH_SQL = sql`(
  position(${DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER} in lower(COALESCE(precalc_obligation.last_error, ''))) > 0
  AND position(${DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER} in lower(COALESCE(precalc_obligation.last_error, ''))) > 0
)`;

/** Typed immutable attempt evidence survives the repairing transition even
 * after recordPrecalcObligationSubmission clears last_error. Fall back to the
 * paired legacy markers only when no typed attempt outcome is available. */
const PRECALC_PRIOR_DETERMINISTIC_MESH_SQL = sql`(
  EXISTS (
    SELECT 1
    FROM sim_precalc_obligation_attempts mesh_attempt
    WHERE mesh_attempt.obligation_id = precalc_obligation.id
      AND mesh_attempt.outcome = 'deterministic_failure'
  )
  OR (
    NOT EXISTS (
      SELECT 1
      FROM sim_precalc_obligation_attempts typed_attempt
      WHERE typed_attempt.obligation_id = precalc_obligation.id
        AND typed_attempt.outcome IS NOT NULL
    )
    AND (${PRECALC_LEGACY_DETERMINISTIC_MESH_SQL})
  )
)`;

const PRECALC_MESH_REPAIRING_SQL = sql`(
  precalc_obligation.state IN ('pending', 'running')
  AND precalc_obligation.last_outcome IN ('mesh_recovery_upgrade_pending', 'composed', 'submitted')
  AND (${PRECALC_PRIOR_DETERMINISTIC_MESH_SQL})
  AND NOT EXISTS (
    SELECT 1
    FROM result_attempts accepted_attempt
    JOIN result_classifications accepted_classification
      ON accepted_classification.result_attempt_id = accepted_attempt.id
     AND accepted_classification.state = 'accepted'
    WHERE accepted_attempt.airfoil_id = precalc_obligation.airfoil_id
      AND accepted_attempt.simulation_preset_revision_id = precalc_obligation.revision_id
      AND accepted_attempt.aoa_deg = precalc_obligation.aoa_deg
      AND (
        accepted_attempt.regime = 'urans'
        OR accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      )
  )
)`;

const PRECALC_BLOCKED_MESH_SQL = sql`(
  (
    precalc_obligation.state = 'blocked'
    AND (
      precalc_obligation.last_outcome = 'deterministic_failure'
      OR (
        precalc_obligation.last_outcome IS NULL
        AND (${PRECALC_PRIOR_DETERMINISTIC_MESH_SQL})
      )
    )
  )
  OR (
    (${TERMINAL_RANS_MACHINE_BLOCKER_SQL})
    AND (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
  )
)`;

const PRECALC_BLOCKED_EXHAUSTED_SQL = sql`(
  precalc_obligation.state = 'blocked'
  AND precalc_obligation.last_outcome IN (
    'failed_exhausted',
    'rejected_exhausted',
    'cancelled_exhausted',
    'continuation_permanent_failure',
    'continuation_no_progress_exhausted',
    'continuation_segment_exhausted'
  )
)`;

const PRECALC_BLOCKED_ENGINE_SUBMIT_SQL = sql`(
  (
    precalc_obligation.state = 'blocked'
    AND precalc_obligation.last_outcome = 'submit_blocked'
  )
  OR (
    (${TERMINAL_RANS_MACHINE_BLOCKER_SQL})
    AND (${RESULT_SUBMIT_BLOCKED_SQL})
    AND NOT (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
  )
)`;

/** The canonical terminal blocked predicate is shared by the headline count
 * and every reason group. The catch-all group below makes those groups exactly
 * exhaustive without turning ordinary pending work into a terminal reason. */
const CANONICAL_BLOCKED_SQL = sql`(
  precalc_obligation.state = 'blocked'
  OR (
    (${PRECALC_RESULT_TERMINAL_BUCKET_SQL})
    AND (
      (
        p.state = 'terminal' AND p.derived_by_symmetry = false
        AND (
          (${TERMINAL_RANS_MACHINE_BLOCKER_SQL})
          OR (
            r.status = 'done'
            AND (rc.state IS NULL OR rc.state NOT IN ('accepted', 'needs_urans', 'superseded_by_urans', 'rejected'))
          )
        )
      )
      OR (
        p.state = 'terminal' AND p.derived_by_symmetry = true
        AND (
          (${TERMINAL_RANS_MACHINE_BLOCKER_SQL})
          OR (r.status = 'failed' AND (${USER_TERMINAL_URANS_FIDELITY_SQL}))
          OR (
            r.status = 'done'
            AND (rc.state IS NULL OR rc.state NOT IN ('accepted', 'needs_urans', 'superseded_by_urans', 'rejected'))
          )
        )
      )
    )
  )
)`;

const PRECALC_BLOCKED_OTHER_SQL = sql`(
  (${CANONICAL_BLOCKED_SQL})
  AND NOT COALESCE((${PRECALC_BLOCKED_MESH_SQL}), false)
  AND NOT COALESCE((${PRECALC_BLOCKED_EXHAUSTED_SQL}), false)
  AND NOT COALESCE((${PRECALC_BLOCKED_ENGINE_SUBMIT_SQL}), false)
)`;

async function recomputeProgressForKeys(
  db: DB,
  keys: ProgressKeyRow[],
): Promise<void> {
  if (!keys.length) return;
  if (keys.length > PROGRESS_KEY_CHUNK) {
    for (let i = 0; i < keys.length; i += PROGRESS_KEY_CHUNK) {
      await recomputeProgressForKeys(db, keys.slice(i, i + PROGRESS_KEY_CHUNK));
    }
    return;
  }
  const tuples = sql.join(
    keys.map(
      (k) =>
        sql`(${k.campaign_id}::uuid, ${k.condition_id}::uuid, ${k.airfoil_id}::uuid)`,
    ),
    sql`, `,
  );
  await db.execute(sql`
    INSERT INTO sim_campaign_progress (
      campaign_id, condition_id, airfoil_id,
      requested, solved, failed, running, superseded, derived, rejected, blocked,
      precalc_mesh_repairing, blocked_mesh_quality, blocked_precalc_exhausted,
      blocked_engine_submit, blocked_other
    )
    SELECT p.campaign_id, p.condition_id, p.airfoil_id,
           COUNT(*) FILTER (WHERE p.state <> 'released')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state IN ('accepted', 'needs_urans', 'superseded_by_urans') AND precalc_obligation.state IS DISTINCT FROM 'blocked')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'failed' AND (${USER_TERMINAL_CAMPAIGN_RESULT_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state = 'requested' AND (${ACTIVE_LIVE_RESULT_SQL}))::int,
           COUNT(*) FILTER (WHERE rc.state = 'superseded_by_urans')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = true AND r.status = 'done' AND rc.state IN ('accepted', 'needs_urans', 'superseded_by_urans') AND precalc_obligation.state IS DISTINCT FROM 'blocked')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state = 'rejected' AND (${USER_TERMINAL_CAMPAIGN_RESULT_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${PRECALC_MESH_REPAIRING_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}) AND (${PRECALC_BLOCKED_MESH_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}) AND (${PRECALC_BLOCKED_EXHAUSTED_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}) AND (${PRECALC_BLOCKED_ENGINE_SUBMIT_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${PRECALC_BLOCKED_OTHER_SQL}))::int
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN results live
      ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
    LEFT JOIN sim_jobs live_job ON live_job.id = live.sim_job_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    LEFT JOIN sim_precalc_obligations precalc_obligation
      ON precalc_obligation.airfoil_id = p.airfoil_id
     AND precalc_obligation.revision_id = p.revision_id
     AND precalc_obligation.aoa_deg = CASE WHEN p.derived_by_symmetry THEN r.aoa_deg ELSE p.aoa_deg END
    WHERE (p.campaign_id, p.condition_id, p.airfoil_id) IN (${tuples})
    GROUP BY p.campaign_id, p.condition_id, p.airfoil_id
    ON CONFLICT (campaign_id, condition_id, airfoil_id) DO UPDATE SET
      requested = excluded.requested,
      solved = excluded.solved,
      failed = excluded.failed,
      running = excluded.running,
      superseded = excluded.superseded,
      derived = excluded.derived,
      rejected = excluded.rejected,
      blocked = excluded.blocked,
      precalc_mesh_repairing = excluded.precalc_mesh_repairing,
      blocked_mesh_quality = excluded.blocked_mesh_quality,
      blocked_precalc_exhausted = excluded.blocked_precalc_exhausted,
      blocked_engine_submit = excluded.blocked_engine_submit,
      blocked_other = excluded.blocked_other,
      "updatedAt" = now()
  `);
}

/** Recompute only progress rows whose canonical physical cell references one
 * of the bounded PRECALC obligations. This is the requeue path's write model:
 * it preserves the same source-result AoA symmetry rule as the canonical
 * aggregate without rescanning every airfoil in a large campaign. */
export async function recomputeProgressForPrecalcObligations(
  db: DB,
  obligationIds: string[],
): Promise<string[]> {
  if (!obligationIds.length) return [];
  const keys: ProgressKeyRow[] = [];
  for (let i = 0; i < obligationIds.length; i += PROGRESS_KEY_CHUNK) {
    const chunk = obligationIds.slice(i, i + PROGRESS_KEY_CHUNK);
    const idArray = sql`ARRAY[${sql.join(
      chunk.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    const rows = (await db.execute(sql`
      SELECT DISTINCT p.campaign_id, p.condition_id, p.airfoil_id
      FROM sim_campaign_points p
      LEFT JOIN results r ON r.id = p.result_id
      JOIN sim_precalc_obligations obligation
        ON obligation.airfoil_id = p.airfoil_id
       AND obligation.revision_id = p.revision_id
       AND obligation.aoa_deg = CASE
         WHEN p.derived_by_symmetry THEN r.aoa_deg
         ELSE p.aoa_deg
       END
      WHERE obligation.id = ANY(${idArray})
    `)) as unknown as ProgressKeyRow[];
    keys.push(...rows);
  }
  const deduped = dedupeProgressKeys(keys);
  await recomputeProgressForKeys(db, deduped);
  return [...new Set(deduped.map((row) => row.campaign_id))].sort();
}

/** Whole-campaign counter recompute, fully set-based (no key enumeration):
 *  the reconciler's heal path for campaigns whose key count can reach 10^5. */
export async function recomputeProgressForCampaign(
  db: DB,
  campaignId: string,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO sim_campaign_progress (
      campaign_id, condition_id, airfoil_id,
      requested, solved, failed, running, superseded, derived, rejected, blocked,
      precalc_mesh_repairing, blocked_mesh_quality, blocked_precalc_exhausted,
      blocked_engine_submit, blocked_other
    )
    SELECT p.campaign_id, p.condition_id, p.airfoil_id,
           COUNT(*) FILTER (WHERE p.state <> 'released')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state IN ('accepted', 'needs_urans', 'superseded_by_urans') AND precalc_obligation.state IS DISTINCT FROM 'blocked')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'failed' AND (${USER_TERMINAL_CAMPAIGN_RESULT_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state = 'requested' AND (${ACTIVE_LIVE_RESULT_SQL}))::int,
           COUNT(*) FILTER (WHERE rc.state = 'superseded_by_urans')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = true AND r.status = 'done' AND rc.state IN ('accepted', 'needs_urans', 'superseded_by_urans') AND precalc_obligation.state IS DISTINCT FROM 'blocked')::int,
           COUNT(*) FILTER (WHERE p.state = 'terminal' AND p.derived_by_symmetry = false AND r.status = 'done' AND rc.state = 'rejected' AND (${USER_TERMINAL_CAMPAIGN_RESULT_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${PRECALC_MESH_REPAIRING_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}) AND (${PRECALC_BLOCKED_MESH_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}) AND (${PRECALC_BLOCKED_EXHAUSTED_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${CANONICAL_BLOCKED_SQL}) AND (${PRECALC_BLOCKED_ENGINE_SUBMIT_SQL}))::int,
           COUNT(*) FILTER (WHERE p.state <> 'released' AND (${PRECALC_BLOCKED_OTHER_SQL}))::int
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN results live
      ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
    LEFT JOIN sim_jobs live_job ON live_job.id = live.sim_job_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    LEFT JOIN sim_precalc_obligations precalc_obligation
      ON precalc_obligation.airfoil_id = p.airfoil_id
     AND precalc_obligation.revision_id = p.revision_id
     AND precalc_obligation.aoa_deg = CASE WHEN p.derived_by_symmetry THEN r.aoa_deg ELSE p.aoa_deg END
    WHERE p.campaign_id = ${campaignId}
    GROUP BY p.campaign_id, p.condition_id, p.airfoil_id
    ON CONFLICT (campaign_id, condition_id, airfoil_id) DO UPDATE SET
      requested = excluded.requested,
      solved = excluded.solved,
      failed = excluded.failed,
      running = excluded.running,
      superseded = excluded.superseded,
      derived = excluded.derived,
      rejected = excluded.rejected,
      blocked = excluded.blocked,
      precalc_mesh_repairing = excluded.precalc_mesh_repairing,
      blocked_mesh_quality = excluded.blocked_mesh_quality,
      blocked_precalc_exhausted = excluded.blocked_precalc_exhausted,
      blocked_engine_submit = excluded.blocked_engine_submit,
      blocked_other = excluded.blocked_other,
      "updatedAt" = now()
  `);
}

/** Cheap completion probe (partial-index EXISTS; spec §6.4): flips an active
 *  campaign to completed (zero failed/rejected) or attention (all terminal,
 *  failed>0 OR rejected>0) once no obligated cell is open, no lane is still
 *  seeding/iterating, and no terminal point's live cell is being re-solved.
 *
 *  The in-flight guard closes the premature-completion window: during a
 *  wave-2 URANS re-solve the campaign point stays 'terminal' while its
 *  cell-key results row is queued/running — neither "open" nor "running" by
 *  the older probes, so any probe could flip the campaign to completed
 *  mid-solve. Such a point now blocks the transition. 'pending' and 'stale'
 *  block too: a lost wave-2 job resets its cell row to 'pending' (reconcile
 *  requeueLostJob) — still re-solve intent, and the sweeper re-claims pending
 *  rows, so this cannot deadlock the probe. */
export async function probeCampaignCompletion(
  db: DB,
  campaignId: string,
): Promise<void> {
  const [probe] = (await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'requested' AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND NOT EXISTS (
            SELECT 1 FROM sim_precalc_obligations blocked_obligation
            WHERE blocked_obligation.airfoil_id = p.airfoil_id
              AND blocked_obligation.revision_id = p.revision_id
              AND blocked_obligation.aoa_deg = p.aoa_deg
              AND blocked_obligation.state = 'blocked'
          )
      ) AS open,
      EXISTS (
        SELECT 1
        FROM sim_campaign_lanes l
        JOIN sim_campaign_conditions lane_condition
          ON lane_condition.id = l.condition_id
        JOIN sim_campaigns lane_campaign
          ON lane_campaign.id = l.campaign_id
        WHERE l.campaign_id = ${campaignId}
          AND lane_condition.generation = lane_campaign.current_condition_generation
          AND lane_condition.status IN ('active', 'kept')
          AND l.state IN ('awaiting_seed', 'iterating')
      ) AS lanes_open,
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results live
          ON live.airfoil_id = p.airfoil_id AND live.simulation_preset_revision_id = p.revision_id AND live.aoa_deg = p.aoa_deg
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND live.status IN ('queued', 'running', 'pending', 'stale')
      ) AS in_flight,
      EXISTS (
        -- Mirrors are NOT filtered out here (unlike the failed COUNTER, which
        -- excludes them): an EXISTS is truth-equivalent either way because a
        -- derived mirror can only be terminal-linked to a failed results row
        -- alongside its +α source — mirror-exclusion in the counter can never
        -- hide a failure from this attention gate.
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND r.status = 'failed'
          AND (${USER_TERMINAL_CAMPAIGN_RESULT_SQL})
      ) AS has_failed,
      EXISTS (
        -- Exact aerodynamic RANS handoff stays open until PRECALC owns or
        -- settles it. A first generic crash also stays machine-open only
        -- across the narrow ingest→auto-retry boundary. Exhausted crashes,
        -- deterministic mesh/setup evidence and blocked submit policy are
        -- canonical critical blockers instead of an infinite "remaining"
        -- fallback.
        SELECT 1
        FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        LEFT JOIN result_classifications rc ON rc.result_id = r.id
        WHERE p.campaign_id = ${campaignId}
          AND p.state = 'terminal'
          AND NOT p.derived_by_symmetry
          AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND (
            (${AUTOMATIC_RANS_HANDOFF_RESULT_SQL})
            OR (${TRANSIENT_RANS_MACHINE_RECOVERY_SQL})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sim_precalc_obligations terminal_recovery
            WHERE terminal_recovery.airfoil_id = p.airfoil_id
              AND terminal_recovery.revision_id = p.revision_id
              AND terminal_recovery.aoa_deg = p.aoa_deg
              AND terminal_recovery.state = 'blocked'
          )
      ) AS automatic_recovery_open,
      EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        LEFT JOIN results r ON r.id = p.result_id
        LEFT JOIN result_classifications rc ON rc.result_id = r.id
        WHERE p.campaign_id = ${campaignId} AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND p.derived_by_symmetry = false
          AND (
            (p.state = 'terminal' AND r.status = 'done' AND (${USER_TERMINAL_CAMPAIGN_RESULT_SQL}) AND (
              rc.state = 'rejected'
              OR rc.state IS NULL
              OR rc.state NOT IN ('accepted', 'needs_urans', 'superseded_by_urans', 'rejected')
            ))
            OR EXISTS (
              SELECT 1 FROM sim_precalc_obligations blocked_obligation
              WHERE blocked_obligation.airfoil_id = p.airfoil_id
                AND blocked_obligation.revision_id = p.revision_id
                AND blocked_obligation.aoa_deg = p.aoa_deg
              AND blocked_obligation.state = 'blocked'
            )
          )
      ) AS has_rejected,
      EXISTS (
        SELECT 1
        FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        LEFT JOIN result_classifications rc ON rc.result_id = r.id
        LEFT JOIN sim_precalc_obligations precalc_obligation
          ON precalc_obligation.airfoil_id = p.airfoil_id
         AND precalc_obligation.revision_id = p.revision_id
         AND precalc_obligation.aoa_deg = CASE
           WHEN p.derived_by_symmetry THEN r.aoa_deg
           ELSE p.aoa_deg
         END
        WHERE p.campaign_id = ${campaignId}
          AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND (${CANONICAL_BLOCKED_SQL})
      ) AS has_blocked,
      (EXISTS (
        -- Fidelity ladder tier 2: exact immutable aerodynamic RANS evidence
        -- owns the preliminary handoff. The exact-evidence predicate excludes
        -- queued/failed legacy shells and non-aerodynamic dispositions.
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id
        JOIN results r ON r.id = p.result_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'terminal' AND c.status IN ('active', 'kept')
          AND c.generation = (SELECT current_condition_generation FROM sim_campaigns WHERE id = ${campaignId})
          AND p.derived_by_symmetry = false
          AND (${AUTOMATIC_RANS_HANDOFF_RESULT_SQL})
          AND (
            NOT EXISTS (
              SELECT 1 FROM sim_precalc_obligations known_obligation
              WHERE known_obligation.airfoil_id = p.airfoil_id
                AND known_obligation.revision_id = p.revision_id
                AND known_obligation.aoa_deg = p.aoa_deg
            )
            OR EXISTS (
              SELECT 1 FROM sim_precalc_obligations open_obligation
              WHERE open_obligation.airfoil_id = p.airfoil_id
                AND open_obligation.revision_id = p.revision_id
                AND open_obligation.aoa_deg = p.aoa_deg
                AND open_obligation.state IN ('pending', 'running')
            )
          )
      ) OR EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_campaigns ownership
        JOIN sim_precalc_obligations obligation
          ON obligation.id = ownership.obligation_id
        WHERE ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
          AND obligation.state IN ('pending', 'running')
      ) OR EXISTS (
        SELECT 1 FROM sim_urans_request_campaigns ownership
        JOIN sim_urans_requests req ON req.id = ownership.request_id
        WHERE ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
          AND req.state IN ('pending', 'running')
      ) OR EXISTS (
        SELECT 1
        FROM result_media_repairs repair
        JOIN sim_campaign_points media_point ON media_point.result_id = repair.result_id
        JOIN sim_campaign_conditions media_condition
          ON media_condition.id = media_point.condition_id
        JOIN sim_campaigns media_campaign
          ON media_campaign.id = media_point.campaign_id
        WHERE media_point.campaign_id = ${campaignId}
          AND media_condition.generation = media_campaign.current_condition_generation
          AND media_condition.status IN ('active', 'kept')
          AND NOT media_point.derived_by_symmetry
          AND repair.state IN ('pending', 'running', 'retry_wait')
      )) AS precalc_open,
      EXISTS (
        -- Fidelity ladder tier 3 (contract 7): open verify-queue items block
        -- completion — the campaign is running_refinement, not done.
        SELECT 1 FROM sim_urans_verify_queue_campaigns ownership
        JOIN sim_urans_verify_queue q ON q.id = ownership.queue_id
        WHERE ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
          AND q.state IN ('pending', 'running')
      ) AS verify_open
  `)) as unknown as {
    open: boolean;
    lanes_open: boolean;
    in_flight: boolean;
    has_failed: boolean;
    automatic_recovery_open: boolean;
    has_rejected: boolean;
    has_blocked: boolean;
    precalc_open: boolean;
    verify_open: boolean;
  }[];
  if (
    !probe ||
    probe.open ||
    probe.lanes_open ||
    probe.in_flight ||
    probe.automatic_recovery_open ||
    probe.precalc_open ||
    probe.verify_open
  )
    return;
  if (probe.has_failed || probe.has_rejected || probe.has_blocked) {
    await db
      .update(simCampaigns)
      .set({ status: "attention" })
      .where(
        and(eq(simCampaigns.id, campaignId), eq(simCampaigns.status, "active")),
      );
  } else {
    await db
      .update(simCampaigns)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(simCampaigns.id, campaignId),
          sql`${simCampaigns.status} IN ('active', 'attention')`,
        ),
      );
  }
}

async function lanesForProgressKeys(
  db: DB,
  keys: ProgressKeyRow[],
): Promise<CampaignLaneKey[]> {
  if (!keys.length) return [];
  const tuples = sql.join(
    keys.map(
      (k) =>
        sql`(${k.campaign_id}::uuid, ${k.airfoil_id}::uuid, ${k.condition_id}::uuid)`,
    ),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT campaign_id, airfoil_id, condition_id, objective
    FROM sim_campaign_lanes
    WHERE (campaign_id, airfoil_id, condition_id) IN (${tuples})
  `)) as unknown as {
    campaign_id: string;
    airfoil_id: string;
    condition_id: string;
    objective: string;
  }[];
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    airfoilId: r.airfoil_id,
    conditionId: r.condition_id,
    objective: r.objective,
  }));
}

/**
 * Ingest hook: link the matching campaign points to the just-upserted results
 * row, flip derived-by-symmetry cells when their +α source lands (canonical
 * negation), recompute the affected progress counters, run the completion
 * probe, and return the dirty lane keys the caller should drain via laneTick
 * AFTER refreshing the polar fit cache for the revision.
 */
export async function onResultIngested(
  db: DB,
  signal: ResultIngestSignal,
): Promise<CampaignLaneKey[]> {
  if (!signal.revisionId) return [];
  const aoa = canonicalAoa(signal.aoaDeg);
  const terminal = signal.status === "done" || signal.status === "failed";
  const affected: ProgressKeyRow[] = [];

  if (terminal) {
    // Direct point terminal-linking. Released points are NEVER resurrected
    // (spec §6.3 no-resurrection): late evidence stays evidence and the
    // condition's "gained evidence" state is derived at read time.
    const direct = (await db.execute(sql`
      UPDATE sim_campaign_points
      SET state = 'terminal', result_id = ${signal.resultId}, "updatedAt" = now()
      WHERE airfoil_id = ${signal.airfoilId} AND revision_id = ${signal.revisionId}
        AND aoa_deg = ${aoa} AND derived_by_symmetry = false AND state = 'requested'
      RETURNING campaign_id, condition_id, airfoil_id
    `)) as unknown as ProgressKeyRow[];
    affected.push(...direct);

    // Symmetric airfoils: the −α derived cell goes terminal alongside its +α
    // source, resultId pointing at the +α results row (spec §9.2).
    if (aoa > 0) {
      const mirrored = (await db.execute(sql`
        UPDATE sim_campaign_points p
        SET state = 'terminal', result_id = ${signal.resultId}, "updatedAt" = now()
        FROM airfoils a
        WHERE a.id = p.airfoil_id AND a.is_symmetric = true
          AND p.airfoil_id = ${signal.airfoilId} AND p.revision_id = ${signal.revisionId}
          AND p.aoa_deg = ${canonicalAoa(-aoa)} AND p.derived_by_symmetry = true AND p.state = 'requested'
        RETURNING p.campaign_id, p.condition_id, p.airfoil_id
      `)) as unknown as ProgressKeyRow[];
      affected.push(...mirrored);
    }

    // Idempotent re-ingest: rows already linked to this result still need
    // their counters recomputed (status may have changed failed → done).
    const linked = (await db.execute(sql`
      SELECT campaign_id, condition_id, airfoil_id
      FROM sim_campaign_points
      WHERE result_id = ${signal.resultId}
    `)) as unknown as ProgressKeyRow[];
    affected.push(...linked);
  } else {
    // queued/running transitions only move the `running` counter.
    const runningKeys = (await db.execute(sql`
      SELECT campaign_id, condition_id, airfoil_id
      FROM sim_campaign_points
      WHERE airfoil_id = ${signal.airfoilId} AND revision_id = ${signal.revisionId}
        AND aoa_deg = ${aoa} AND state = 'requested'
    `)) as unknown as ProgressKeyRow[];
    affected.push(...runningKeys);
  }

  // Result-owned RANS incidents close only when the canonical classifier has
  // selected real accepted evidence for this exact result. Merely requeueing,
  // receiving another failed attempt, or handing RANS to PRECALC must not make
  // a critical incident disappear.
  if (terminal && signal.status === "done") {
    const accepted = (await db.execute(sql`
      SELECT 1
      FROM results accepted_result
      JOIN result_classifications accepted_classification
        ON accepted_classification.result_id = accepted_result.id
       AND accepted_classification.state = 'accepted'
      WHERE accepted_result.id = ${signal.resultId}
        AND accepted_result.status = 'done'
      LIMIT 1
    `)) as unknown as unknown[];
    if (accepted.length) {
      await resolveSolverIncidentsForAcceptedResultsInTransaction(db, [
        signal.resultId,
      ]);
    }
  }

  const keys = dedupeProgressKeys(affected);
  if (!keys.length) return [];
  await recomputeProgressForKeys(db, keys);
  if (!terminal) return [];

  const laneKeys = await lanesForProgressKeys(db, keys);
  for (const campaignId of new Set(keys.map((k) => k.campaign_id))) {
    await probeCampaignCompletion(db, campaignId);
  }
  return laneKeys;
}

// ---------------------------------------------------------------------------
// Auto-retry-once (approved design c19fd74a, amendment B): a crash-class
// failed point (results.status = 'failed') gets ONE automatic requeue before
// remaining failed/blocked. Marker = results.auto_retried_at (migration 0036):
// it lives on the durable cell row so it survives re-ingest of the same failed
// job (the ingest upsert never writes it). Wave-1 failures return to `pending`
// for the ordinary gap finder. Campaign precalc failures remain on their
// wave-2 ownership path: legacy scalar jobs are reclaimed by the parent scan,
// while association-owned jobs reopen the same physical precalc request.
// ---------------------------------------------------------------------------
export interface AutoRetriedCell {
  resultId: string;
  airfoilId: string;
  revisionId: string | null;
  aoaDeg: number;
  error: string | null;
}

export interface AutoRetryOutcome {
  /** Cells flipped back to pending/requested — their ONE automatic retry. */
  retried: AutoRetriedCell[];
  /** Campaign precalc failures released from their dead child but deliberately
   *  left `queued`, not `pending`: the URANS ladder must create their next
   *  wave-2/forced-transient job. Treating them as an ordinary campaign gap
   *  would silently downgrade the retry to wave-1 RANS. */
  precalcRouted: AutoRetriedCell[];
  /** Cells that failed AGAIN after their automatic retry (marker already
   *  present): left failed/blocked. The caller logs these loudly. */
  escalated: AutoRetriedCell[];
  /** First-attempt deterministic precalc mesh-QA failures. Their campaign
   *  revision and tier pin the same setup/mesh for the generic retry, so an
   *  unchanged requeue cannot succeed. They stay failed/terminal with the
   *  original attempt evidence and surface through the existing blocked /
   *  needs-attention read models. */
  suppressed: AutoRetriedCell[];
  /** Ladder-scoped precalc failures that cannot be retried: every owner is
   * terminal/cancelled, or the physical work was a bounded continuation whose
   * engine submission already spent its one attempt. Evidence stays failed. */
  terminalBlocked: AutoRetriedCell[];
  /** A completed evidence row whose only rejection is missing URANS video.
   * This is output-repair work, not a CFD crash: the bounded media-repair
   * queue owns it and generic solver retry must not submit a duplicate solve. */
  mediaRepairDeferred: AutoRetriedCell[];
}

// Production campaign b96594a6 proved that the generic crash retry was not
// safe for every `failed` row: the precalc checkMesh gate rejected the same
// immutable revision 4-5 times at max non-orthogonality 88.2/88.3 degrees.
// Scope this suppression narrowly to that deterministic engine QA class and
// to campaign wave-2 precalc jobs whose job revision is the result revision.
// Other mesh errors, wave-1 work, admin jobs, and transient crashes keep the
// existing one-shot retry policy.
const PRECALC_WAVE2_JOB_SQL = sql`
  EXISTS (
    SELECT 1
    FROM sim_jobs j
    WHERE j.id = r.sim_job_id
      AND j.wave = 2
      AND j.simulation_preset_revision_id = r.simulation_preset_revision_id
      AND j.request_payload ->> 'uransFidelity' = 'precalc'
  )
`;

/** Any ladder-scoped precalc job, including a campaign_id=NULL physical
 * request. Historical/cancelled request ownership still counts as ladder
 * provenance so a failed URANS row can never fall through to wave-1 RANS. */
const LADDER_SCOPED_PRECALC_SQL = sql`
  (${PRECALC_WAVE2_JOB_SQL})
  AND EXISTS (
    SELECT 1
    FROM sim_jobs scoped_job
    WHERE scoped_job.id = r.sim_job_id
      AND (
        scoped_job.campaign_id IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM sim_urans_requests scoped_request
          WHERE scoped_request.id::text = scoped_job.request_payload ->> 'uransRequestId'
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(scoped_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN scoped_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) payload_obligation(id)
          JOIN sim_precalc_obligations obligation
            ON obligation.id = payload_obligation.id::uuid
          WHERE obligation.airfoil_id = r.airfoil_id
            AND obligation.revision_id = r.simulation_preset_revision_id
            AND obligation.aoa_deg = r.aoa_deg
        )
      )
  )
`;

/** An exact preliminary-URANS obligation created for this physical cell by a
 * different job. This is intentionally cell-scoped rather than derived from
 * r.sim_job_id: submitUransRetryForJob creates the obligation/child for a
 * failed wave-1 row before the generic crash-retry pass runs. Looking only at
 * the wave-1 payload would then reopen that same cell as pending RANS and
 * double-schedule it. A cancelled obligation only fences the cell after it
 * spent a physical attempt; an unsubmitted cancellation does not consume the
 * ordinary one-shot crash retry. */
const EXACT_PRECALC_OBLIGATION_SQL = sql`
  EXISTS (
    SELECT 1
    FROM sim_precalc_obligations exact_obligation
    WHERE exact_obligation.airfoil_id = r.airfoil_id
      AND exact_obligation.revision_id = r.simulation_preset_revision_id
      AND exact_obligation.aoa_deg = r.aoa_deg
      AND (
        exact_obligation.state <> 'cancelled'
        OR exact_obligation.attempt_count > 0
      )
  )
`;

/** Current owners that still authorize/freeze this work. A background owner
 * is independent of campaign lifecycle; cancelled/archived campaign owners
 * are deliberately absent. */
const LIVE_LADDER_PRECALC_SQL = sql`
  (${PRECALC_WAVE2_JOB_SQL})
  AND EXISTS (
    SELECT 1
    FROM sim_jobs live_job
    WHERE live_job.id = r.sim_job_id
      AND (
        EXISTS (
          SELECT 1 FROM sim_campaigns direct_campaign
          WHERE direct_campaign.id = live_job.campaign_id
            AND direct_campaign.status IN ('active', 'attention', 'paused')
        )
        OR EXISTS (
          SELECT 1
          FROM sim_urans_requests live_request
          WHERE live_request.id::text = live_job.request_payload ->> 'uransRequestId'
            AND (
              live_request.background_owner
              OR EXISTS (
                SELECT 1
                FROM sim_urans_request_campaigns live_owner
                JOIN sim_campaigns owner_campaign
                  ON owner_campaign.id = live_owner.campaign_id
                WHERE live_owner.request_id = live_request.id
                  AND live_owner.state = 'active'
                  AND owner_campaign.status IN ('active', 'attention', 'paused')
              )
            )
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(live_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN live_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) payload_obligation(id)
          JOIN sim_precalc_obligations obligation
            ON obligation.id = payload_obligation.id::uuid
          WHERE obligation.airfoil_id = r.airfoil_id
            AND obligation.revision_id = r.simulation_preset_revision_id
            AND obligation.aoa_deg = r.aoa_deg
            AND obligation.state IN ('pending', 'running')
            AND (
              obligation.background_owner
              OR EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_campaigns ownership
                JOIN sim_campaigns owner_campaign
                  ON owner_campaign.id = ownership.campaign_id
                WHERE ownership.obligation_id = obligation.id
                  AND ownership.state = 'active'
                  AND owner_campaign.status IN ('active', 'attention', 'paused')
              )
            )
        )
      )
  )
`;

/** A continuation is already the bounded second physical attempt for its
 * result. It must remain terminal when that engine submission fails; otherwise
 * one request can loop forever without ever reaching campaign attention. */
const BOUNDED_CONTINUATION_PRECALC_SQL = sql`
  (${PRECALC_WAVE2_JOB_SQL})
  AND EXISTS (
    SELECT 1
    FROM sim_jobs continuation_job
    JOIN sim_urans_requests continuation_request
      ON continuation_request.id::text = continuation_job.request_payload ->> 'uransRequestId'
    WHERE continuation_job.id = r.sim_job_id
      AND continuation_request.continue_from_result_id IS NOT NULL
  )
`;

/** A fresh automatic precalc request may receive the normal one crash retry.
 * Bounded same-result continuations are spent at engine submission and stay
 * terminal on failure instead of silently receiving another continuation.
 * The shared request is reopened only after terminal ingest has settled it to
 * `done`; partial evidence published by a still-running engine job must not
 * create a duplicate submission. */
const ROUTABLE_CAMPAIGN_PRECALC_SQL = sql`
  (${LIVE_LADDER_PRECALC_SQL})
  AND NOT EXISTS (
    SELECT 1
    FROM sim_jobs ledger_job
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(ledger_job.request_payload -> 'precalcObligationIds') = 'array'
        THEN ledger_job.request_payload -> 'precalcObligationIds'
        ELSE '[]'::jsonb
      END
    ) payload_obligation(id)
    JOIN sim_precalc_obligations obligation
      ON obligation.id = payload_obligation.id::uuid
    WHERE ledger_job.id = r.sim_job_id
      AND obligation.airfoil_id = r.airfoil_id
      AND obligation.revision_id = r.simulation_preset_revision_id
      AND obligation.aoa_deg = r.aoa_deg
  )
  AND EXISTS (
    SELECT 1
    FROM sim_jobs routable_job
    WHERE routable_job.id = r.sim_job_id
      AND (
        routable_job.campaign_id IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM sim_urans_requests routable_request
          WHERE routable_request.id::text = routable_job.request_payload ->> 'uransRequestId'
            AND routable_request.continue_from_result_id IS NULL
            AND routable_request.state = 'done'
        )
      )
  )
`;

const DETERMINISTIC_PRECALC_MESH_QA_SQL = sql`
  (${LIVE_LADDER_PRECALC_SQL})
  AND position('mesh degenerate at this fidelity tier' in lower(COALESCE(r.error, ''))) > 0
  AND position('max non-orthogonality' in lower(COALESCE(r.error, ''))) > 0
`;

/** A typed hard RANS failure is owned by the conditional promotion policy,
 * not by the generic crash retry. Read the latest exact attempt from this job,
 * independently of the public selected pointer: rejected attempts are
 * deliberately pointer-null after cache refresh, and partial ingest runs this
 * guard after that refresh. */
const CURRENT_HARD_SOLVER_ATTEMPT_SQL = sql`EXISTS (
  SELECT 1
  FROM result_attempts current_attempt
  WHERE current_attempt.result_id = r.id
    AND current_attempt.sim_job_id = r.sim_job_id
    AND current_attempt.regime = 'rans'
    AND current_attempt.evidence_payload ->> 'failure_disposition' = 'hard_solver'
    AND NOT EXISTS (
      SELECT 1
      FROM result_attempts newer_attempt
      WHERE newer_attempt.result_id = current_attempt.result_id
        AND newer_attempt.sim_job_id = current_attempt.sim_job_id
        AND (
          newer_attempt."createdAt" > current_attempt."createdAt"
          OR (
            newer_attempt."createdAt" = current_attempt."createdAt"
            AND newer_attempt.id > current_attempt.id
          )
        )
    )
)`;

/** A completed exact attempt can be unavailable solely because default URANS
 * video has not yet been rendered. That classification is deliberately
 * pointer-null, which also leaves the durable cell in `failed` until media
 * repair re-publishes the same immutable evidence. It is not a solver failure:
 * the result-media repair queue has the bounded, token-fenced retry budget.
 *
 * Read only the latest exact attempt from this job. A later actual CFD crash
 * for the same cell must still receive the normal one-shot retry even if an
 * earlier attempt from this job once awaited media repair. */
const MEDIA_REPAIR_OWNED_SQL = sql`EXISTS (
  SELECT 1
  FROM result_attempts media_attempt
  JOIN result_classifications media_classification
    ON media_classification.result_attempt_id = media_attempt.id
  WHERE media_attempt.result_id = r.id
    AND media_attempt.sim_job_id = r.sim_job_id
    AND media_attempt.status = 'done'
    AND media_attempt.source = 'solved'
    AND media_classification.state = 'rejected'
    AND media_classification.reasons = ARRAY['missing-urans-video']::text[]
    AND NOT EXISTS (
      SELECT 1
      FROM result_attempts newer_attempt
      WHERE newer_attempt.result_id = media_attempt.result_id
        AND newer_attempt.sim_job_id = media_attempt.sim_job_id
        AND (
          newer_attempt."createdAt" > media_attempt."createdAt"
          OR (
            newer_attempt."createdAt" = media_attempt."createdAt"
            AND newer_attempt.id > media_attempt.id
          )
        )
    )
)`;

type ExhaustedRansIncidentRow = {
  result_id: string;
  airfoil_id: string;
  revision_id: string | null;
  aoa_deg: number;
  error: string | null;
  result_attempt_id: string | null;
  failure_disposition: string | null;
  solver_implementation_id: string;
  mesh_recovery_version?: number;
};

function exhaustedRansIncidentReason(
  row: Pick<ExhaustedRansIncidentRow, "error" | "failure_disposition">,
): string {
  const error = (row.error ?? "").toLowerCase();
  if (
    row.failure_disposition === "deterministic_mesh" ||
    (error.includes(DETERMINISTIC_MESH_BLOCKER_ERROR_MARKER) &&
      error.includes(DETERMINISTIC_MESH_BLOCKER_NONORTHO_MARKER))
  ) {
    return "mesh-quality-failure";
  }
  if (
    row.failure_disposition === "infrastructure" ||
    /\b(engine|worker|container|openmpi|mpi|queue|database|storage|disk)\b/.test(
      error,
    ) ||
    /\b(connection refused|http 5\d\d|no space left|out of memory|oom[- ]killed)\b/.test(
      error,
    )
  ) {
    return "engine-infrastructure-failure";
  }
  return "solver-execution-failed";
}

/** Route every generic crash-class unmarked failed row of one sim job exactly once:
 *  result → pending for wave-1 or queued-without-owner for campaign
 *  precalc (claim links cleared, marker stamped, error text kept as evidence
 *  of the crash), linked campaign points → requested, counters
 *  recomputed. Deterministic identical precalc mesh-QA failures stay failed
 *  and are returned as `suppressed`; rows already carrying the marker stay
 *  failed and are returned as `escalated`. Exact current `hard_solver` RANS
 *  attempts stay attached to their parent for targeted/whole-polar URANS
 *  routing and are never silently downgraded to another generic RANS try.
 *  Callers MUST invoke this AFTER
 *  every polar-cache refresh of the job's ingest path — flipping a row to
 *  pending and re-refreshing would overwrite its stored at-ingest
 *  classification (prod row 741db07a). */
export async function autoRetryCrashedResultsForJob(
  db: DB,
  simJobId: string,
): Promise<AutoRetryOutcome> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Serialize the route decision with pause/cancel. Once this transaction
    // reopens a live owner's point/request, a waiting lifecycle transaction can
    // release it normally; it can never observe a half-routed ownerless row.
    await tx.execute(sql`
    SELECT campaign.id
    FROM sim_jobs job
    JOIN sim_campaigns campaign ON campaign.id = job.campaign_id
    WHERE job.id = ${simJobId}
      AND campaign.status IN ('active', 'attention', 'paused')
    ORDER BY campaign.id
    FOR SHARE OF campaign
  `);
    await tx.execute(sql`
    SELECT campaign.id
    FROM sim_jobs job
    JOIN sim_urans_requests request_item
      ON request_item.id::text = job.request_payload ->> 'uransRequestId'
    JOIN sim_urans_request_campaigns ownership
      ON ownership.request_id = request_item.id
     AND ownership.state = 'active'
    JOIN sim_campaigns campaign
      ON campaign.id = ownership.campaign_id
     AND campaign.status IN ('active', 'attention', 'paused')
    WHERE job.id = ${simJobId}
    ORDER BY campaign.id
    FOR SHARE OF campaign
  `);

    const suppressed = (await tx.execute(sql`
    SELECT r.id AS result_id, r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
           r.aoa_deg::float8 AS aoa_deg, r.error
    FROM results r
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NULL
      AND r.simulation_preset_revision_id IS NOT NULL
      AND (
        (${DETERMINISTIC_PRECALC_MESH_QA_SQL})
        OR (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
      )
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }>;

    const terminalBlocked = (await tx.execute(sql`
    SELECT r.id AS result_id, r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
           r.aoa_deg::float8 AS aoa_deg, r.error
    FROM results r
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NULL
      AND r.simulation_preset_revision_id IS NOT NULL
      AND (${LADDER_SCOPED_PRECALC_SQL})
      AND (
        NOT (${LIVE_LADDER_PRECALC_SQL})
        OR (${BOUNDED_CONTINUATION_PRECALC_SQL})
      )
      AND NOT (${DETERMINISTIC_PRECALC_MESH_QA_SQL})
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }>;

    const escalated = (await tx.execute(sql`
    SELECT r.id AS result_id, r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
           r.aoa_deg::float8 AS aoa_deg, r.error
    FROM results r
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NOT NULL
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }>;

    // A second non-aerodynamic steady-RANS crash is not the normal
    // RANS->preliminary handoff. Record it as a critical result-owned solver
    // incident in the same transaction that observes the exhausted retry.
    //
    // Do not derive this set from `escalated` in application code: that broad
    // return list intentionally also contains exhausted wave-2 rows. Those are
    // already owned by preliminary/final recovery ledgers and must not acquire
    // a duplicate, misleading RANS incident.
    const exhaustedRansIncidents = (await tx.execute(sql`
    SELECT
      r.id AS result_id,
      r.airfoil_id,
      r.simulation_preset_revision_id AS revision_id,
      r.aoa_deg::float8 AS aoa_deg,
      COALESCE(latest.error, r.error) AS error,
      latest.id AS result_attempt_id,
      latest.failure_disposition,
      COALESCE(
        latest.solver_implementation_id,
        r.solver_implementation_id,
        job.solver_implementation_id,
        revision.solver_implementation_id,
        ${LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID}::uuid
      ) AS solver_implementation_id
    FROM results r
    JOIN sim_jobs job ON job.id = r.sim_job_id
    LEFT JOIN simulation_preset_revisions revision
      ON revision.id = r.simulation_preset_revision_id
    LEFT JOIN LATERAL (
      SELECT
        attempt.id,
        attempt.error,
        attempt.regime,
        attempt.solver_implementation_id,
        attempt.evidence_payload ->> 'fidelity' AS fidelity,
        attempt.evidence_payload ->> 'failure_disposition'
          AS failure_disposition
      FROM result_attempts attempt
      WHERE attempt.result_id = r.id
        AND attempt.sim_job_id = r.sim_job_id
      ORDER BY attempt."createdAt" DESC, attempt.id DESC
      LIMIT 1
    ) latest ON true
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NOT NULL
      AND job.wave = 1
      AND COALESCE(job.request_payload ->> 'uransFidelity', 'rans') = 'rans'
      AND COALESCE(latest.regime::text, r.regime::text, 'rans') = 'rans'
      AND COALESCE(latest.fidelity, r.fidelity::text, 'rans') = 'rans'
      AND COALESCE(latest.failure_disposition, '') <> 'hard_solver'
      AND NOT (${EXACT_PRECALC_OBLIGATION_SQL})
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as ExhaustedRansIncidentRow[];
    for (const incident of exhaustedRansIncidents) {
      await recordSolverIncidentInTransaction(tx, {
        stage: "rans",
        reason: exhaustedRansIncidentReason(incident),
        severity: "critical",
        owner: { resultId: incident.result_id },
        solverImplementationId: incident.solver_implementation_id,
        occurrenceKey: `rans:${incident.result_id}:${simJobId}:auto-retry-exhausted`,
        remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
        simJobId,
        resultAttemptId: incident.result_attempt_id,
        metadata: {
          airfoilId: incident.airfoil_id,
          revisionId: incident.revision_id,
          aoaDeg: Number(incident.aoa_deg),
          error: incident.error,
          failureDisposition: incident.failure_disposition,
          recovery: "auto-retry-exhausted",
        },
      });
    }
    const deterministicRansIncidents = (await tx.execute(sql`
    SELECT
      r.id AS result_id,
      r.airfoil_id,
      r.simulation_preset_revision_id AS revision_id,
      r.aoa_deg::float8 AS aoa_deg,
      COALESCE(latest.error, r.error) AS error,
      latest.id AS result_attempt_id,
      latest.failure_disposition,
      CASE
        WHEN latest.mesh_recovery_version ~ '^[0-9]+$'
        THEN latest.mesh_recovery_version::int
        WHEN job.request_payload ->> 'executedMeshRecoveryVersion'
               ~ '^[0-9]+$'
        THEN (job.request_payload ->> 'executedMeshRecoveryVersion')::int
        ELSE 0
      END AS mesh_recovery_version,
      COALESCE(
        latest.solver_implementation_id,
        r.solver_implementation_id,
        job.solver_implementation_id,
        revision.solver_implementation_id,
        ${LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID}::uuid
      ) AS solver_implementation_id
    FROM results r
    JOIN sim_jobs job ON job.id = r.sim_job_id
    LEFT JOIN simulation_preset_revisions revision
      ON revision.id = r.simulation_preset_revision_id
    LEFT JOIN LATERAL (
      SELECT
        attempt.id,
        attempt.error,
        attempt.regime,
        attempt.solver_implementation_id,
        attempt.evidence_payload ->> 'fidelity' AS fidelity,
        attempt.evidence_payload ->> 'mesh_recovery_version'
          AS mesh_recovery_version,
        attempt.evidence_payload ->> 'failure_disposition'
          AS failure_disposition
      FROM result_attempts attempt
      WHERE attempt.result_id = r.id
        AND attempt.sim_job_id = r.sim_job_id
      ORDER BY attempt."createdAt" DESC, attempt.id DESC
      LIMIT 1
    ) latest ON true
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NULL
      AND job.wave = 1
      AND COALESCE(job.request_payload ->> 'uransFidelity', 'rans') = 'rans'
      AND COALESCE(latest.regime::text, r.regime::text, 'rans') = 'rans'
      AND COALESCE(latest.fidelity, r.fidelity::text, 'rans') = 'rans'
      AND (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
      AND NOT (${EXACT_PRECALC_OBLIGATION_SQL})
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as ExhaustedRansIncidentRow[];
    for (const incident of deterministicRansIncidents) {
      await recordSolverIncidentInTransaction(tx, {
        stage: "rans",
        reason: "mesh-quality-failure",
        severity: "critical",
        owner: { resultId: incident.result_id },
        solverImplementationId: incident.solver_implementation_id,
        occurrenceKey: `rans:${incident.result_id}:${simJobId}:deterministic-mesh:v${incident.mesh_recovery_version ?? 0}`,
        remediationVersion: ransMeshRecoveryRemediationVersion(
          incident.mesh_recovery_version ?? 0,
        ),
        simJobId,
        resultAttemptId: incident.result_attempt_id,
        metadata: {
          airfoilId: incident.airfoil_id,
          revisionId: incident.revision_id,
          aoaDeg: Number(incident.aoa_deg),
          error: incident.error,
          failureDisposition:
            incident.failure_disposition ?? "deterministic_mesh",
          recovery: "deterministic-mesh",
          meshRecoveryVersion: incident.mesh_recovery_version ?? 0,
        },
      });
    }
    // A completed RANS evidence row can still fail the canonical publication
    // classifier for a non-aerodynamic reason (for example, malformed or
    // incomplete evidence). Ordinary non-convergence/stall evidence is
    // excluded by AUTOMATIC_RANS_HANDOFF_RESULT_SQL and remains normal
    // RANS→preliminary-URANS input. Everything selected here has no automatic
    // fidelity owner and is therefore a critical machine incident, not a
    // user-review task.
    const rejectedRansIncidents = (await tx.execute(sql`
    SELECT
      r.id AS result_id,
      r.airfoil_id,
      r.simulation_preset_revision_id AS revision_id,
      r.aoa_deg::float8 AS aoa_deg,
      COALESCE(latest.error, r.error) AS error,
      latest.id AS result_attempt_id,
      latest.failure_disposition,
      result_classification.reasons AS classification_reasons,
      COALESCE(
        latest.solver_implementation_id,
        r.solver_implementation_id,
        job.solver_implementation_id,
        revision.solver_implementation_id,
        ${LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID}::uuid
      ) AS solver_implementation_id
    FROM results r
    JOIN sim_jobs job ON job.id = r.sim_job_id
    JOIN result_classifications result_classification
      ON result_classification.result_id = r.id
     AND result_classification.state = 'rejected'
    LEFT JOIN simulation_preset_revisions revision
      ON revision.id = r.simulation_preset_revision_id
    LEFT JOIN LATERAL (
      SELECT
        attempt.id,
        attempt.error,
        attempt.regime,
        attempt.solver_implementation_id,
        attempt.evidence_payload ->> 'fidelity' AS fidelity,
        attempt.evidence_payload ->> 'failure_disposition'
          AS failure_disposition
      FROM result_attempts attempt
      WHERE attempt.result_id = r.id
        AND attempt.sim_job_id = r.sim_job_id
      ORDER BY attempt."createdAt" DESC, attempt.id DESC
      LIMIT 1
    ) latest ON true
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'done'
      AND job.wave = 1
      AND COALESCE(job.request_payload ->> 'uransFidelity', 'rans') = 'rans'
      AND COALESCE(latest.regime::text, r.regime::text, 'rans') = 'rans'
      AND COALESCE(latest.fidelity, r.fidelity::text, 'rans') = 'rans'
      AND NOT (${AUTOMATIC_RANS_HANDOFF_RESULT_SQL})
      AND NOT (${EXACT_PRECALC_OBLIGATION_SQL})
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as Array<
      ExhaustedRansIncidentRow & { classification_reasons: string[] }
    >;
    for (const incident of rejectedRansIncidents) {
      await recordSolverIncidentInTransaction(tx, {
        stage: "rans",
        reason: "non-publishable-rans-evidence",
        severity: "critical",
        owner: { resultId: incident.result_id },
        solverImplementationId: incident.solver_implementation_id,
        occurrenceKey: `rans:${incident.result_id}:${simJobId}:evidence-rejected`,
        remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
        simJobId,
        resultAttemptId: incident.result_attempt_id,
        metadata: {
          airfoilId: incident.airfoil_id,
          revisionId: incident.revision_id,
          aoaDeg: Number(incident.aoa_deg),
          error: incident.error,
          failureDisposition: incident.failure_disposition,
          classificationReasons: incident.classification_reasons,
          recovery: "evidence-rejected",
        },
      });
    }

    // A failed campaign precalc cell must never fall through the ordinary
    // campaign gap finder: that composer is wave-1 RANS by definition. Release
    // ownership from the dead child, retain the failed evidence/one-shot marker,
    // and use `queued` as the durable "awaiting another wave-2 child" state.
    // campaignHasOpenRansGaps and findCampaignGapBatch both already distinguish
    // this from a schedulable pending/stale RANS gap; the gated parent rescan
    // creates the actual precalc request and reclaims the row.
    const precalcRouted = (await tx.execute(sql`
    UPDATE results r
    SET status = 'queued', source = 'queued', sim_job_id = NULL, engine_job_id = NULL,
        engine_case_slug = NULL, auto_retried_at = now(), "updatedAt" = now()
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NULL
      AND r.simulation_preset_revision_id IS NOT NULL
      AND (${ROUTABLE_CAMPAIGN_PRECALC_SQL})
      AND NOT (${DETERMINISTIC_PRECALC_MESH_QA_SQL})
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
    RETURNING r.id AS result_id, r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
              r.aoa_deg::float8 AS aoa_deg, r.error
  `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }>;

    // A ladder-scoped precalc row may be terminal-blocked, but it must never
    // fall through to the generic pending/wave-1 path.
    const retried = (await tx.execute(sql`
    UPDATE results r
    SET status = 'pending', source = 'queued', sim_job_id = NULL, engine_job_id = NULL,
        engine_case_slug = NULL, auto_retried_at = now(), "updatedAt" = now()
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NULL
      AND NOT (${LADDER_SCOPED_PRECALC_SQL})
      AND NOT (${EXACT_PRECALC_OBLIGATION_SQL})
      AND NOT (${DETERMINISTIC_PRECALC_MESH_QA_SQL})
      AND NOT (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
      AND NOT (${CURRENT_HARD_SOLVER_ATTEMPT_SQL})
      AND NOT (${MEDIA_REPAIR_OWNED_SQL})
    RETURNING r.id AS result_id, r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
              r.aoa_deg::float8 AS aoa_deg, r.error
  `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }>;

    // A live association-owned fresh request retries through the same physical
    // precalc request, never through the wave-1 campaign gap finder.
    if (precalcRouted.length) {
      await tx.execute(sql`
      UPDATE sim_urans_requests request_item
      SET state = 'pending', sim_job_id = NULL, "updatedAt" = now()
      FROM sim_jobs failed_job
      WHERE failed_job.id = ${simJobId}
        AND request_item.id::text = failed_job.request_payload ->> 'uransRequestId'
        AND request_item.continue_from_result_id IS NULL
        AND (
          request_item.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_urans_request_campaigns ownership
            JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
            WHERE ownership.request_id = request_item.id
              AND ownership.state = 'active'
              AND campaign.status IN ('active', 'attention', 'paused')
          )
        )
    `);
    }

    const reopened = [...retried, ...precalcRouted];
    if (reopened.length) {
      // A crash retry is a fresh submit lifecycle too. This is normally a
      // no-op because an accepted engine submission already clears the
      // pre-submit ledger, but keeping the reset atomic prevents stale rows
      // from stranding repaired/imported legacy cells.
      await tx.execute(sql`
      DELETE FROM sim_result_submit_retries
      WHERE result_id = ANY(${sql`ARRAY[${sql.join(
        reopened.map((r) => sql`${r.result_id}::uuid`),
        sql`, `,
      )}]`})
    `);
      // Terminal campaign points linked to the requeued rows reopen (the same
      // reset semantics as requeueSinglePoint, bulk + non-derived only), and the
      // affected counters recompute idempotently.
      const keys = (await tx.execute(sql`
      UPDATE sim_campaign_points p
      SET state = 'requested', "updatedAt" = now()
      WHERE p.result_id = ANY(${sql`ARRAY[${sql.join(
        reopened.map((r) => sql`${r.result_id}::uuid`),
        sql`, `,
      )}]`})
        AND p.state = 'terminal' AND NOT p.derived_by_symmetry
        AND EXISTS (
          SELECT 1 FROM sim_campaigns campaign
          WHERE campaign.id = p.campaign_id
            AND campaign.status IN ('active', 'attention', 'paused', 'completed')
        )
      RETURNING p.campaign_id, p.condition_id, p.airfoil_id
    `)) as unknown as ProgressKeyRow[];
      await recomputeProgressForKeys(tx, dedupeProgressKeys(keys));
      // The completion probe may have flipped the campaign to 'attention' the
      // instant its last point terminal-failed — BEFORE this retry reopened it.
      // An attention/completed campaign is invisible to the gap finder
      // (camp.status = 'active'), which would strand the requeued points
      // forever. Same re-derivation refreshCampaignCompletion performs: open
      // requested work ⇒ active.
      const campaignIds = [...new Set(keys.map((k) => k.campaign_id))];
      if (campaignIds.length) {
        await tx.execute(sql`
        UPDATE sim_campaigns c
        SET status = 'active'
        WHERE c.id = ANY(${sql`ARRAY[${sql.join(
          campaignIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})
          AND c.status IN ('attention', 'completed')
          AND EXISTS (SELECT 1 FROM sim_campaign_points p WHERE p.campaign_id = c.id AND p.state = 'requested')
      `);
      }
    }

    const toCell = (row: {
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }): AutoRetriedCell => ({
      resultId: row.result_id,
      airfoilId: row.airfoil_id,
      revisionId: row.revision_id,
      aoaDeg: Number(row.aoa_deg),
      error: row.error,
    });
    const mediaRepairDeferred = (await tx.execute(sql`
    SELECT r.id AS result_id, r.airfoil_id, r.simulation_preset_revision_id AS revision_id,
           r.aoa_deg::float8 AS aoa_deg, r.error
    FROM results r
    WHERE r.sim_job_id = ${simJobId}
      AND r.status = 'failed'
      AND r.auto_retried_at IS NULL
      AND (${MEDIA_REPAIR_OWNED_SQL})
  `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string | null;
      aoa_deg: number;
      error: string | null;
    }>;
    return {
      retried: retried.map(toCell),
      precalcRouted: precalcRouted.map(toCell),
      escalated: escalated.map(toCell),
      suppressed: suppressed.map(toCell),
      terminalBlocked: terminalBlocked.map(toCell),
      mediaRepairDeferred: mediaRepairDeferred.map(toCell),
    };
  });
}

export interface RansMeshRecoveryRequeueScope {
  /** Test/repair closed world. An explicitly empty list matches nothing. */
  resultIds?: string[];
  /** Scheduler closed world for shared test databases. */
  campaignIds?: string[];
  /** Bounded production scan; deliberately capped even for manual repair. */
  limit?: number;
}

export interface RansMeshRecoveryRequeueResult {
  resultIds: string[];
  campaignIds: string[];
}

/**
 * Reopen deterministic wave-1 RANS mesh failures only when the live engine
 * advertises a strictly newer recovery strategy than the immutable attempt
 * that failed.
 *
 * The failed result attempt and incident remain historical evidence. The
 * canonical result/point ownership moves back to ordinary RANS scheduling in
 * one transaction, older mesh incidents resolve in that same transaction, and
 * a same-version pass is a no-op. Campaign lifecycle locks precede natural-cell
 * advisory locks so concurrent pause/cancel/composition cannot create an
 * ownerless or duplicate retry.
 */
export async function requeueDeterministicRansMeshFailuresForRecoveryVersion(
  db: DB,
  meshRecoveryVersion: number,
  scope: RansMeshRecoveryRequeueScope = {},
): Promise<RansMeshRecoveryRequeueResult> {
  const empty: RansMeshRecoveryRequeueResult = {
    resultIds: [],
    campaignIds: [],
  };
  if (!Number.isSafeInteger(meshRecoveryVersion) || meshRecoveryVersion <= 0) {
    return empty;
  }
  const limit = Math.min(Math.max(scope.limit ?? 500, 1), 500);
  const resultScopeSql =
    scope.resultIds === undefined
      ? sql`true`
      : scope.resultIds.length
        ? sql`r.id = ANY(${sql`ARRAY[${sql.join(
            scope.resultIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`false`;
  const campaignScopeSql =
    scope.campaignIds === undefined
      ? sql`true`
      : scope.campaignIds.length
        ? sql`owner_campaign.id = ANY(${sql`ARRAY[${sql.join(
            scope.campaignIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`false`;
  const sourceMeshVersionSql = sql`COALESCE(
    (
      SELECT CASE
        WHEN immutable_attempt.evidence_payload ->> 'mesh_recovery_version'
               ~ '^[0-9]+$'
         AND (
           immutable_attempt.evidence_payload ->> 'mesh_recovery_version'
         )::numeric <= 2147483647
        THEN (
          immutable_attempt.evidence_payload ->> 'mesh_recovery_version'
        )::numeric::bigint
        ELSE NULL
      END
      FROM result_attempts immutable_attempt
      WHERE immutable_attempt.result_id = r.id
        AND immutable_attempt.airfoil_id = r.airfoil_id
        AND immutable_attempt.simulation_preset_revision_id
              IS NOT DISTINCT FROM r.simulation_preset_revision_id
        AND immutable_attempt.aoa_deg = r.aoa_deg
        AND immutable_attempt.sim_job_id IS NOT DISTINCT FROM r.sim_job_id
        AND immutable_attempt.regime = 'rans'
      ORDER BY immutable_attempt."createdAt" DESC, immutable_attempt.id DESC
      LIMIT 1
    ),
    (
      SELECT CASE
        WHEN source_job.request_payload ->> 'executedMeshRecoveryVersion'
               ~ '^[0-9]+$'
         AND (
           source_job.request_payload ->> 'executedMeshRecoveryVersion'
         )::numeric <= 2147483647
        THEN (
          source_job.request_payload ->> 'executedMeshRecoveryVersion'
        )::numeric::bigint
        ELSE NULL
      END
      FROM sim_jobs source_job
      WHERE source_job.id = r.sim_job_id
    ),
    0::bigint
  )`;
  const liveOwnerSql = sql`EXISTS (
    SELECT 1
    FROM sim_campaign_points owner_point
    JOIN sim_campaigns owner_campaign
      ON owner_campaign.id = owner_point.campaign_id
    JOIN sim_campaign_conditions owner_condition
      ON owner_condition.id = owner_point.condition_id
     AND owner_condition.campaign_id = owner_campaign.id
    WHERE owner_point.result_id = r.id
      AND owner_point.state = 'terminal'
      AND owner_point.revision_id = r.simulation_preset_revision_id
      AND owner_campaign.status IN ('active', 'attention')
      AND owner_condition.generation =
            owner_campaign.current_condition_generation
      AND owner_condition.status IN ('active', 'kept')
      AND (${campaignScopeSql})
  )`;
  const noPrecalcOwnerSql = sql`NOT EXISTS (
    SELECT 1
    FROM sim_precalc_obligations existing_precalc
    WHERE existing_precalc.airfoil_id = r.airfoil_id
      AND existing_precalc.revision_id = r.simulation_preset_revision_id
      AND existing_precalc.aoa_deg = r.aoa_deg
  )`;
  const noActiveSourceJobSql = sql`NOT EXISTS (
    SELECT 1
    FROM sim_jobs active_source_job
    WHERE active_source_job.id = r.sim_job_id
      AND active_source_job.status IN (
        'pending', 'submitted', 'running', 'ingesting'
      )
  )`;

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const candidates = (await tx.execute(sql`
      SELECT DISTINCT
        r.id AS result_id,
        r.airfoil_id,
        r.simulation_preset_revision_id AS revision_id,
        r.aoa_deg::float8 AS aoa_deg
      FROM results r
      WHERE (${resultScopeSql})
        AND r.status = 'failed'
        AND r.simulation_preset_revision_id IS NOT NULL
        AND (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
        AND (${sourceMeshVersionSql}) < ${meshRecoveryVersion}
        AND (${noPrecalcOwnerSql})
        AND (${noActiveSourceJobSql})
        AND (${liveOwnerSql})
      ORDER BY r.id
      LIMIT ${limit}
    `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
    }>;
    if (!candidates.length) return empty;

    const candidateIds = candidates.map((row) => row.result_id);
    const candidateIdArray = sql`ARRAY[${sql.join(
      candidateIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;

    // Repository-wide order: campaign lifecycle owner first, then natural cell.
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_campaigns campaign
      JOIN sim_campaign_points point ON point.campaign_id = campaign.id
      WHERE point.result_id = ANY(${candidateIdArray})
        AND campaign.status IN ('active', 'attention', 'paused')
      ORDER BY campaign.id
      FOR SHARE OF campaign
    `);
    await lockPrecalcCells(
      tx,
      candidates.map((row) => ({
        airfoilId: row.airfoil_id,
        revisionId: row.revision_id,
        aoaDeg: Number(row.aoa_deg),
      })),
    );

    // Recheck after both locks. A lifecycle edit, accepted late evidence, or
    // concurrent PRECALC handoff may have won since the bounded read.
    const reopened = (await tx.execute(sql`
      UPDATE results r
      SET status = 'pending',
          source = 'queued',
          sim_job_id = NULL,
          engine_job_id = NULL,
          engine_case_slug = NULL,
          "updatedAt" = now()
      WHERE r.id = ANY(${candidateIdArray})
        AND r.status = 'failed'
        AND r.simulation_preset_revision_id IS NOT NULL
        AND (${TERMINAL_RANS_DETERMINISTIC_MESH_SQL})
        AND (${sourceMeshVersionSql}) < ${meshRecoveryVersion}
        AND (${noPrecalcOwnerSql})
        AND (${noActiveSourceJobSql})
        AND (${liveOwnerSql})
      RETURNING
        r.id AS result_id,
        r.airfoil_id,
        r.simulation_preset_revision_id AS revision_id,
        r.aoa_deg::float8 AS aoa_deg
    `)) as unknown as Array<{
      result_id: string;
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
    }>;
    if (!reopened.length) return empty;

    const reopenedIds = reopened.map((row) => row.result_id).sort();
    const reopenedIdArray = sql`ARRAY[${sql.join(
      reopenedIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    await tx.execute(sql`
      DELETE FROM sim_result_submit_retries
      WHERE result_id = ANY(${reopenedIdArray})
    `);

    const keys = (await tx.execute(sql`
      UPDATE sim_campaign_points point
      SET state = 'requested', "updatedAt" = now()
      FROM sim_campaigns campaign, sim_campaign_conditions condition
      WHERE point.result_id = ANY(${reopenedIdArray})
        AND point.state = 'terminal'
        AND campaign.id = point.campaign_id
        AND campaign.status IN ('active', 'attention', 'paused')
        AND condition.id = point.condition_id
        AND condition.campaign_id = campaign.id
        AND condition.generation = campaign.current_condition_generation
        AND condition.status IN ('active', 'kept')
      RETURNING point.campaign_id, point.condition_id, point.airfoil_id
    `)) as unknown as ProgressKeyRow[];

    await resolveOlderRansMeshIncidentsInTransaction(
      tx,
      reopenedIds,
      meshRecoveryVersion,
    );
    const dedupedKeys = dedupeProgressKeys(keys);
    await recomputeProgressForKeys(tx, dedupedKeys);

    const campaignIds = [
      ...new Set(dedupedKeys.map((row) => row.campaign_id)),
    ].sort();
    if (campaignIds.length) {
      await tx.execute(sql`
        UPDATE sim_campaigns campaign
        SET status = 'active', "completedAt" = NULL, "updatedAt" = now()
        WHERE campaign.id = ANY(${sql`ARRAY[${sql.join(
          campaignIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})
          AND campaign.status = 'attention'
          AND EXISTS (
            SELECT 1
            FROM sim_campaign_points point
            WHERE point.campaign_id = campaign.id
              AND point.state = 'requested'
          )
      `);
    }
    return { resultIds: reopenedIds, campaignIds };
  });
}

// ---------------------------------------------------------------------------
// Refinement lanes (spec §8).
// ---------------------------------------------------------------------------
const CONVERGED_STATES = new Set([
  "converged_provisional",
  "converged_final",
  "converged_window",
  "converged_stale",
]);

/** Oscillation window (spec §8 step 4): the last 3 predictions fit inside a
 *  2·tolerance window. Pure so it is unit-testable. */
export function isOscillationConverged(
  predictions: number[],
  toleranceDeg: number,
): boolean {
  if (predictions.length < 3) return false;
  const last = predictions.slice(-3);
  return Math.max(...last) - Math.min(...last) <= 2 * toleranceDeg + 1e-9;
}

export interface LaneTickResult {
  state: string;
  enqueuedAoaDeg: number | null;
}

interface PlanObjectiveConfig {
  enabled?: boolean;
  toleranceDeg?: string | number;
  maxRounds?: number;
}

const OBJECTIVE_DEFAULTS: Record<
  string,
  { toleranceDeg: number; maxRounds: number }
> = {
  ld_max: { toleranceDeg: 0.1, maxRounds: 8 },
  cl_zero: { toleranceDeg: 0.05, maxRounds: 6 },
  // Same defaults as ld_max: the Cl curve is flat near its peak, so α(Cl_max)
  // is ill-conditioned — a tighter tolerance would burn rounds for negligible
  // Cl gain (per-campaign adjustable in the wizard as usual).
  cl_max: { toleranceDeg: 0.1, maxRounds: 8 },
};

/** Lane objective key (text column) → plan jsonb objectives key. */
const OBJECTIVE_PLAN_KEYS: Record<string, "ldMax" | "clZero" | "clMax"> = {
  ld_max: "ldMax",
  cl_zero: "clZero",
  cl_max: "clMax",
};

async function updateLaneState(
  db: DB,
  key: CampaignLaneKey,
  set: Partial<{
    state: string;
    currentTargetAlpha: number | null;
    iterationCount: number;
    witnessFitSetId: string | null;
  }>,
): Promise<void> {
  await db
    .update(simCampaignLanes)
    .set(set)
    .where(
      and(
        eq(simCampaignLanes.campaignId, key.campaignId),
        eq(simCampaignLanes.airfoilId, key.airfoilId),
        eq(simCampaignLanes.conditionId, key.conditionId),
        eq(simCampaignLanes.objective, key.objective),
      ),
    );
}

const LANE_TERMINAL_STATES = new Set([
  "converged_provisional",
  "converged_final",
  "converged_window",
  "converged_stale",
  "stalled",
  "insufficient_evidence",
  "failed",
  "symmetric_definition",
]);

/**
 * Lane state machine tick (spec §8, event-driven via the ingest dirty queue +
 * a 60 s safety sweep). Witness = the fit convergence was judged against; no
 * |α_new − α_prev| term — a base sweep that already brackets the target
 * converges at iteration 1. Enqueued refinement points are single-angle
 * campaign points at canonical 0.01°-rounded predictions.
 */
export async function laneTick(
  db: DB,
  key: CampaignLaneKey,
): Promise<LaneTickResult | null> {
  const [lane] = await db
    .select()
    .from(simCampaignLanes)
    .where(
      and(
        eq(simCampaignLanes.campaignId, key.campaignId),
        eq(simCampaignLanes.airfoilId, key.airfoilId),
        eq(simCampaignLanes.conditionId, key.conditionId),
        eq(simCampaignLanes.objective, key.objective),
      ),
    )
    .limit(1);
  if (!lane) return null;
  const frozen: LaneTickResult = { state: lane.state, enqueuedAoaDeg: null };

  const [campaign] = await db
    .select()
    .from(simCampaigns)
    .where(eq(simCampaigns.id, key.campaignId))
    .limit(1);
  // Pause/cancel semantics (§6.4): lanes only move while the campaign is active.
  if (!campaign || campaign.status !== "active") return frozen;

  const [condition] = await db
    .select()
    .from(simCampaignConditions)
    .where(eq(simCampaignConditions.id, key.conditionId))
    .limit(1);
  if (
    !condition ||
    !["active", "kept"].includes(condition.status) ||
    condition.generation !== campaign.currentConditionGeneration
  )
    return frozen;

  const [planRev] = campaign.currentPlanRevisionId
    ? await db
        .select()
        .from(simCampaignPlanRevisions)
        .where(eq(simCampaignPlanRevisions.id, campaign.currentPlanRevisionId))
        .limit(1)
    : [];
  const objectives = (
    planRev?.plan as
      | { objectives?: Record<string, PlanObjectiveConfig> }
      | undefined
  )?.objectives;
  const objectiveConfig =
    objectives?.[OBJECTIVE_PLAN_KEYS[key.objective] ?? "ldMax"];
  // Disabling an objective freezes its lanes at their last evidence-backed state.
  if (!objectiveConfig?.enabled) return frozen;
  const defaults =
    OBJECTIVE_DEFAULTS[key.objective] ?? OBJECTIVE_DEFAULTS.ld_max;
  const toleranceRaw = Number(objectiveConfig.toleranceDeg);
  const tolerance =
    Number.isFinite(toleranceRaw) && toleranceRaw > 0
      ? toleranceRaw
      : defaults.toleranceDeg;
  const maxRounds =
    (objectiveConfig.maxRounds ?? defaults.maxRounds) + lane.extraRoundsGranted;

  const [airfoil] = await db
    .select({ isSymmetric: airfoils.isSymmetric })
    .from(airfoils)
    .where(eq(airfoils.id, key.airfoilId))
    .limit(1);
  const symmetric = airfoil?.isSymmetric ?? false;

  // Symmetric shortcut (§8/§9): α₀ = 0° by definition — no solve, stated as such.
  if (symmetric && key.objective === "cl_zero") {
    if (lane.state !== "symmetric_definition") {
      await updateLaneState(db, key, {
        state: "symmetric_definition",
        currentTargetAlpha: 0,
      });
    }
    return { state: "symmetric_definition", enqueuedAoaDeg: null };
  }

  const revisionId = condition.simulationPresetRevisionId;
  const [fit] = await db
    .select()
    .from(polarFitSets)
    .where(
      and(
        eq(polarFitSets.airfoilId, key.airfoilId),
        eq(polarFitSets.simulationPresetRevisionId, revisionId),
        eq(polarFitSets.fitVersion, POLAR_FIT_VERSION),
        eq(polarFitSets.isCurrent, true),
      ),
    )
    .orderBy(desc(polarFitSets.createdAt))
    .limit(1);
  const rawTarget = fit
    ? key.objective === "ld_max"
      ? fit.alphaLdmaxFine
      : key.objective === "cl_max"
        ? fit.alphaClmaxFine
        : fit.alphaClZeroFine
    : null;

  const openRows = (await db.execute(sql`
    SELECT 1 FROM sim_campaign_points
    WHERE campaign_id = ${key.campaignId} AND condition_id = ${key.conditionId} AND airfoil_id = ${key.airfoilId}
      AND state = 'requested' AND derived_by_symmetry = false
    LIMIT 1
  `)) as unknown as unknown[];
  const openPoints = openRows.length > 0;

  // Step 1: missing/insufficient fit.
  if (
    !fit ||
    fit.status === "insufficient" ||
    rawTarget == null ||
    !Number.isFinite(rawTarget)
  ) {
    // Seed-once rule: the base sweep is the seed — while any of its points are
    // still pending the lane waits; once everything is terminal and the fit is
    // still insufficient the lane parks in insufficient_evidence (the
    // lane-scoped requeue-failed affordance is the way back in — we never
    // auto-requeue a second seed).
    const nextState = openPoints ? "awaiting_seed" : "insufficient_evidence";
    if (lane.state !== nextState)
      await updateLaneState(db, key, { state: nextState });
    if (nextState === "insufficient_evidence")
      await probeCampaignCompletion(db, key.campaignId);
    return { state: nextState, enqueuedAoaDeg: null };
  }

  // Converged lane with an unchanged witness fit: nothing to do.
  const wasConverged = CONVERGED_STATES.has(lane.state);
  if (wasConverged && lane.witnessFitSetId === fit.id) return frozen;

  // Symmetric ld_max / cl_max lanes search α ≥ 0 only (§8/§9): both are real
  // nonzero-α targets on symmetric airfoils (unlike cl_zero's 0°-by-definition
  // shortcut above), and the negative side is the mirror of the positive.
  const alphaStar =
    symmetric && (key.objective === "ld_max" || key.objective === "cl_max")
      ? Math.max(0, rawTarget)
      : rawTarget;
  const predicted = canonicalAoa(Math.round(alphaStar * 100) / 100);
  // Supersession reopen (§8 step 6): witness replaced within tolerance keeps
  // the lane converged_stale unless the machine re-confirms or re-runs.
  const reopenWithinTolerance =
    wasConverged &&
    lane.currentTargetAlpha != null &&
    Math.abs(predicted - lane.currentTargetAlpha) <= tolerance + 1e-9;

  // Append-only step evidence maintenance: link solved outcomes first.
  await db.execute(sql`
    UPDATE sim_campaign_lane_steps s
    SET outcome = 'solved', solved_result_id = r.id
    FROM results r
    WHERE s.campaign_id = ${key.campaignId} AND s.airfoil_id = ${key.airfoilId}
      AND s.condition_id = ${key.conditionId} AND s.objective = ${key.objective}
      AND s.outcome = 'predicted'
      AND r.airfoil_id = ${key.airfoilId} AND r.simulation_preset_revision_id = ${revisionId}
      AND r.aoa_deg = s.predicted_alpha AND r.status = 'done'
  `);
  const steps = await db
    .select()
    .from(simCampaignLaneSteps)
    .where(
      and(
        eq(simCampaignLaneSteps.campaignId, key.campaignId),
        eq(simCampaignLaneSteps.airfoilId, key.airfoilId),
        eq(simCampaignLaneSteps.conditionId, key.conditionId),
        eq(simCampaignLaneSteps.objective, key.objective),
      ),
    )
    .orderBy(asc(simCampaignLaneSteps.iteration));
  const last = steps.length ? steps[steps.length - 1] : null;

  // Step 2: append (iteration, predictedAlpha, fitSetId) when it advances the
  // lane — i.e. when the PREDICTED α actually moved. A fit refresh whose
  // argmax lands on the same canonical α is NOT an advance: appending a step
  // per refit flooded lanes with identical rows during tier-2 ingest (prod
  // 2026-07-09: twelve duplicate 7.67° steps on one clarky ld_max lane, all
  // swept to 'superseded' at once when the target finally moved).
  const advances = !last || canonicalAoa(last.predictedAlpha) !== predicted;
  if (advances) {
    await db.execute(sql`
      UPDATE sim_campaign_lane_steps
      SET outcome = 'superseded'
      WHERE campaign_id = ${key.campaignId} AND airfoil_id = ${key.airfoilId}
        AND condition_id = ${key.conditionId} AND objective = ${key.objective}
        AND outcome = 'predicted' AND solved_result_id IS NULL AND predicted_alpha <> ${predicted}
    `);
    await db
      .insert(simCampaignLaneSteps)
      .values({
        campaignId: key.campaignId,
        airfoilId: key.airfoilId,
        conditionId: key.conditionId,
        objective: key.objective,
        iteration: (last?.iteration ?? 0) + 1,
        predictedAlpha: predicted,
        fitSetId: fit.id,
        outcome: "predicted",
      })
      .onConflictDoNothing();
  }
  const predictions = [
    ...steps.map((s) => canonicalAoa(s.predictedAlpha)),
    ...(advances ? [predicted] : []),
  ];

  // Step 3: CONVERGED iff (a) no in-flight/requested lane point, (b) accepted
  // evidence within tolerance of α* at the pinned revision, (c) the fit did
  // not move since the last prediction (fitSetId equals the latest step's).
  const evidenceRows = (await db.execute(sql`
    SELECT 1 FROM result_classifications rc
    WHERE rc.airfoil_id = ${key.airfoilId} AND rc.simulation_preset_revision_id = ${revisionId}
      AND rc.state = 'accepted' AND rc.result_id IS NOT NULL
      AND (
        abs(rc.aoa_deg - ${alphaStar}) <= ${tolerance + 1e-9}
        OR (${symmetric} AND abs(-rc.aoa_deg - ${alphaStar}) <= ${tolerance + 1e-9})
      )
    LIMIT 1
  `)) as unknown as unknown[];
  const evidenceWithinTolerance = evidenceRows.length > 0;
  // Fit stability = TARGET stability: the current fit's prediction equals the
  // last recorded step's α (advances just appended that witness), or the lane
  // has a step at this very α from an earlier fit. A refreshed fit id whose
  // argmax did not move must not block convergence — same-α refits no longer
  // append witness steps, so the old fit-id equality test would deadlock.
  const fitStable =
    advances ||
    (last != null && canonicalAoa(last.predictedAlpha) === predicted);

  if (!openPoints && evidenceWithinTolerance && fitStable) {
    const state =
      fit.status === "final" ? "converged_final" : "converged_provisional";
    await updateLaneState(db, key, {
      state,
      witnessFitSetId: fit.id,
      currentTargetAlpha: predicted,
    });
    await probeCampaignCompletion(db, key.campaignId);
    return { state, enqueuedAoaDeg: null };
  }

  // Step 4: the canonical prediction duplicates an already-requested lane angle.
  const duplicateRows = (await db.execute(sql`
    SELECT p.state, r.status AS result_status
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    WHERE p.campaign_id = ${key.campaignId} AND p.condition_id = ${key.conditionId}
      AND p.airfoil_id = ${key.airfoilId} AND p.aoa_deg = ${predicted}
    LIMIT 1
  `)) as unknown as { state: string; result_status: string | null }[];
  const duplicate = duplicateRows[0];

  if (duplicate) {
    let state: string;
    if (
      duplicate.state === "terminal" &&
      duplicate.result_status === "failed"
    ) {
      state = "failed";
    } else if (isOscillationConverged(predictions, tolerance)) {
      state = "converged_window";
    } else if (reopenWithinTolerance) {
      state = "converged_stale";
    } else if (lane.iterationCount >= maxRounds) {
      state = "stalled";
    } else {
      state = "iterating";
    }
    await updateLaneState(db, key, {
      state,
      currentTargetAlpha: predicted,
      ...(state === "converged_window" || state === "converged_stale"
        ? { witnessFitSetId: fit.id }
        : {}),
    });
    if (LANE_TERMINAL_STATES.has(state))
      await probeCampaignCompletion(db, key.campaignId);
    return { state, enqueuedAoaDeg: null };
  }

  // Step 5: enqueue α* as a single-angle campaign point (targeted job at the
  // campaign priority band), bounded by maxRounds + extraRoundsGranted.
  if (lane.iterationCount >= maxRounds) {
    await updateLaneState(db, key, {
      state: "stalled",
      currentTargetAlpha: predicted,
    });
    await probeCampaignCompletion(db, key.campaignId);
    return { state: "stalled", enqueuedAoaDeg: null };
  }
  await db
    .insert(simCampaignPoints)
    .values({
      campaignId: key.campaignId,
      conditionId: key.conditionId,
      airfoilId: key.airfoilId,
      aoaDeg: predicted,
      revisionId,
      planRevisionNumber: planRev?.revisionNumber ?? 1,
      state: "requested",
    })
    .onConflictDoNothing();
  await recomputeProgressForKeys(db, [
    {
      campaign_id: key.campaignId,
      condition_id: key.conditionId,
      airfoil_id: key.airfoilId,
    },
  ]);
  await updateLaneState(db, key, {
    state: "iterating",
    iterationCount: lane.iterationCount + 1,
    currentTargetAlpha: predicted,
  });
  return { state: "iterating", enqueuedAoaDeg: predicted };
}

// ---------------------------------------------------------------------------
// Low-frequency reconciler (spec §7): counters healing (≤1 campaign per call,
// oldest-checked first), orphaned pending rows of cancelled/released campaign
// work, and lane-state consistency (stale lanes are returned for re-ticking).
// ---------------------------------------------------------------------------
export interface CampaignReconcileResult {
  campaignId: string | null;
  staleLanes: CampaignLaneKey[];
  orphanedPendingDeleted: number;
}

export async function reconcileCampaigns(
  db: DB,
): Promise<CampaignReconcileResult> {
  // Oldest-checked first: the campaign whose progress rows were refreshed the
  // longest ago (missing rows count as never checked).
  const [target] = (await db.execute(sql`
    SELECT c.id
    FROM sim_campaigns c
    LEFT JOIN sim_campaign_progress pr ON pr.campaign_id = c.id
    WHERE c.status IN ('active', 'paused', 'attention', 'completed')
    GROUP BY c.id
    ORDER BY COALESCE(MIN(pr."updatedAt"), 'epoch'::timestamptz) ASC, c."createdAt" ASC
    LIMIT 1
  `)) as unknown as { id: string }[];
  const campaignId = target?.id ?? null;

  if (campaignId) {
    // Full counter recompute for this campaign + drop counter rows whose
    // points disappeared entirely. Set-based and scoped by campaign_id: a
    // large campaign has 10^4-10^5 (condition, airfoil) keys, and enumerating
    // them as SQL tuples overflows both the JS stack (template flattening)
    // and postgres's 65,534-parameter cap.
    await recomputeProgressForCampaign(db, campaignId);
    await db.execute(sql`
      DELETE FROM sim_campaign_progress pr
      WHERE pr.campaign_id = ${campaignId}
        AND NOT EXISTS (
          SELECT 1 FROM sim_campaign_points p
          WHERE p.campaign_id = pr.campaign_id AND p.condition_id = pr.condition_id AND p.airfoil_id = pr.airfoil_id
        )
    `);
    await probeCampaignCompletion(db, campaignId);
  }

  // Orphaned pending results of cancelled/released campaign work: rows on
  // campaign-origin, disabled presets that no live campaign point requests and
  // no active sync promise covers. Continuous/library demand is untouched
  // (its presets are origin='library' or enabled).
  const deleted = (await db.execute(sql`
    DELETE FROM results r
    WHERE r.status = 'pending' AND r.source = 'queued' AND r.sim_job_id IS NULL
      AND r.simulation_preset_revision_id IN (
        SELECT rev.id FROM simulation_preset_revisions rev
        JOIN simulation_presets sp ON sp.id = rev.preset_id
        WHERE sp.origin = 'campaign' AND sp.enabled = false
      )
      AND NOT EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaigns sc ON sc.id = p.campaign_id
        WHERE p.revision_id = r.simulation_preset_revision_id AND p.airfoil_id = r.airfoil_id
          AND p.aoa_deg = r.aoa_deg AND p.state = 'requested'
          AND sc.status IN ('active', 'paused', 'attention')
      )
      AND NOT EXISTS (
        SELECT 1 FROM sync_sweep_promise_points pp
        JOIN sync_sweep_promises pr ON pr.id = pp.promise_id
        WHERE pp.airfoil_id = r.airfoil_id AND pp.simulation_preset_revision_id = r.simulation_preset_revision_id
          AND pp.aoa_deg = r.aoa_deg AND pp.status = 'active' AND pr.status = 'active' AND pr."expiresAt" > now()
      )
    RETURNING r.id
  `)) as unknown as { id: string }[];

  // Lane-state consistency: seeding/iterating lanes of the selected campaign
  // plus converged lanes whose witness fit was replaced (supersession safety
  // net) get re-ticked by the caller.
  const staleLaneRows = campaignId
    ? ((await db.execute(sql`
        SELECT l.campaign_id, l.airfoil_id, l.condition_id, l.objective
        FROM sim_campaign_lanes l
        JOIN sim_campaign_conditions condition ON condition.id = l.condition_id
        JOIN sim_campaigns campaign ON campaign.id = l.campaign_id
        LEFT JOIN polar_fit_sets f ON f.id = l.witness_fit_set_id
        WHERE l.campaign_id = ${campaignId}
          AND condition.generation = campaign.current_condition_generation
          AND condition.status IN ('active', 'kept')
          AND (
            l.state IN ('awaiting_seed', 'iterating')
            OR (l.state IN ('converged_provisional', 'converged_final', 'converged_window')
                AND (f.id IS NULL OR f.is_current = false))
          )
      `)) as unknown as {
        campaign_id: string;
        airfoil_id: string;
        condition_id: string;
        objective: string;
      }[])
    : [];

  return {
    campaignId,
    staleLanes: staleLaneRows.map((r) => ({
      campaignId: r.campaign_id,
      airfoilId: r.airfoil_id,
      conditionId: r.condition_id,
      objective: r.objective,
    })),
    orphanedPendingDeleted: deleted.length,
  };
}

/**
 * Released-condition "gained evidence" derivation (spec §6.3 no-resurrection):
 * a released condition whose requested angle set has since gained solved
 * evidence at the pinned revision for any campaign airfoil. Derived at read
 * time — 0026 adds no flag column. API phase: surface these condition ids as
 * the non-blocking "restore it to keep the dataset closed?" suggestion on the
 * campaign detail payload.
 */
export async function releasedConditionsWithGainedEvidence(
  db: DB,
  campaignId: string,
): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT cond.id
    FROM sim_campaign_conditions cond
    JOIN sim_campaigns campaign ON campaign.id = cond.campaign_id
    WHERE cond.campaign_id = ${campaignId}
      AND cond.generation = campaign.current_condition_generation
      AND cond.status = 'released'
      AND EXISTS (
        SELECT 1
        FROM sim_campaign_points p
        JOIN results r
          ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
        WHERE p.condition_id = cond.id AND r.status = 'done' AND r.source = 'solved'
      )
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
