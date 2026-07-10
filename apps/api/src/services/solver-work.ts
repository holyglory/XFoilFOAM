import {
  URANS_BUDGET_STOP_MARKER,
  canonicalAoa,
  type SimulationWorkItem,
} from "@aerodb/core";
import {
  CONTINUABLE_SQL,
  airfoils,
  simulationPresetRevisions,
} from "@aerodb/db";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db";
import { loadSimulationWorks } from "./detail";

export const SOLVER_WORK_STATES = [
  "verified",
  "provisional",
  "solving",
  "queued",
  "ladder",
  "needs_time",
  "needs_review",
  "blocked",
  "superseded",
] as const;

export type SolverWorkState = (typeof SOLVER_WORK_STATES)[number];
export type SolverWorkFidelity = "rans" | "urans_precalc" | "urans_full" | null;
export type SolverWorkTone =
  | "ok"
  | "ladder"
  | "warn"
  | "review"
  | "blocked"
  | "neutral";
export type SolverWorkAction = "continue" | "retry" | "request_full";

export interface SolverWorkGate {
  name:
    | "march-rate guard"
    | "stationarity gate"
    | "period detector"
    | "mesh QA gate"
    | "RANS validity gate"
    | "quality gate";
  detail: string;
}

export interface SolverWorkPointStateRow {
  resultId?: string | null;
  status?: string | null;
  source?: string | null;
  regime?: "rans" | "urans" | string | null;
  fidelity?: string | null;
  classificationState?: string | null;
  continuable?: boolean | null;
  openVerify?: boolean | null;
  openRequest?: boolean | null;
  autoRetriedAt?: Date | string | null;
  error?: string | null;
}

export interface SolverWorkPoint {
  aoaDeg: number;
  state: SolverWorkState;
  resultId: string | null;
  fidelity: SolverWorkFidelity;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  plain: string;
  gate: SolverWorkGate | null;
  chain: Array<{ label: string; tone: SolverWorkTone }>;
  continuable: boolean;
  actions: SolverWorkAction[];
  supersededBy: string | null;
}

export interface SolverWorkCondition {
  presetRevisionId: string;
  reynolds: number;
  mach: number | null;
  chordM: number | null;
  speedMps: number | null;
  updatedAt: string;
  attentionCount: number;
  points: SolverWorkPoint[];
  jobs: SimulationWorkItem[];
}

export interface SolverWorkPayload {
  conditions: SolverWorkCondition[];
}

export function solverWorkStateForPoint(
  row: SolverWorkPointStateRow,
): SolverWorkState {
  if (row.classificationState === "superseded_by_urans") return "superseded";

  if (row.status === "queued" || row.status === "running") return "solving";
  if (!row.resultId || row.status === "pending" || row.status === "stale")
    return "queued";

  if (row.status === "failed")
    return blockerFromError(row.error, row.autoRetriedAt)
      ? "blocked"
      : "needs_review";

  if (row.continuable) return "needs_time";
  if (row.status === "done" && row.error)
    return blockerFromError(row.error, row.autoRetriedAt)
      ? "blocked"
      : "needs_review";

  if (row.classificationState === "rejected") {
    if (row.openVerify || row.openRequest) return "ladder";
    if (
      row.regime === "rans" ||
      row.fidelity === "rans" ||
      row.fidelity == null
    )
      return "ladder";
    return "needs_review";
  }

  if (row.classificationState === "needs_urans") return "provisional";
  if (
    row.classificationState === "accepted" ||
    row.classificationState == null
  ) {
    return row.openVerify ? "provisional" : "verified";
  }

  return "queued";
}

type ResultPointRow = {
  result_id: string;
  revision_id: string;
  aoa_deg: number | string;
  status: string | null;
  source: string | null;
  regime: string | null;
  fidelity: string | null;
  cl: number | string | null;
  cd: number | string | null;
  cm: number | string | null;
  error: string | null;
  quality_warnings: string[] | null;
  auto_retried_at: Date | string | null;
  updated_at: Date | string;
  classification_state: string | null;
  classification_reasons: string[] | null;
  superseded_by_result_id: string | null;
  continuable: boolean | null;
  open_verify: boolean | null;
  open_request: boolean | null;
};

type CampaignPointRow = ResultPointRow & {
  result_id: string | null;
  source_aoa_deg: number | string | null;
  point_updated_at: Date | string;
  point_state: string;
  derived_by_symmetry: boolean;
};

type AttemptRow = {
  result_id: string;
  regime: string | null;
  status: string;
  valid_for_polar: boolean;
  error: string | null;
  quality_warnings: string[] | null;
  created_at: Date | string;
};

type JobActivityRow = {
  id: string;
  revision_id: string;
  request_payload: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  submitted_at: Date | string | null;
  finished_at: Date | string | null;
};

type RevisionRow = {
  id: string;
  reynolds: number | string;
  mach: number | string | null;
  reference_length_m: number | string;
  snapshot: Record<string, unknown>;
  created_at: Date | string;
};

type StoredPoint = {
  point: SolverWorkPoint;
  updatedAt: string;
  priority: number;
};

const ATTENTION_STATES = new Set<SolverWorkState>([
  "needs_time",
  "needs_review",
  "blocked",
]);

function isoOf(v: Date | string | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function latestIso(...values: Array<string | null | undefined>): string {
  let latest = new Date(0).toISOString();
  for (const value of values) {
    if (!value) continue;
    if (new Date(value).getTime() > new Date(latest).getTime()) latest = value;
  }
  return latest;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeFidelity(
  fidelity: string | null | undefined,
  regime: string | null | undefined,
): SolverWorkFidelity {
  if (
    fidelity === "rans" ||
    fidelity === "urans_precalc" ||
    fidelity === "urans_full"
  )
    return fidelity;
  return regime === "rans" ? "rans" : null;
}

function negated(v: number | null): number | null {
  if (v == null) return null;
  return v === 0 ? 0 : -v;
}

function blockerFromError(
  error: string | null | undefined,
  autoRetriedAt?: Date | string | null,
): boolean {
  const text = (error ?? "").toLowerCase();
  if (!text.trim()) return Boolean(autoRetriedAt);
  return (
    /mesh/.test(text) ||
    /degenerate/.test(text) ||
    /wall[- ]?rate/.test(text) ||
    /crash|segmentation|sigsegv|core dumped/.test(text) ||
    (Boolean(autoRetriedAt) &&
      /diverg|residual|nan|timeout|timed out|solver|engine/.test(text))
  );
}

function firstDetailLine(row: {
  qualityWarnings?: string[] | null;
  classificationReasons?: string[] | null;
  error?: string | null;
}): string | null {
  const lines = [
    ...(row.qualityWarnings ?? []),
    ...(row.classificationReasons ?? []),
    row.error ?? "",
  ]
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] ?? null;
}

function normalizedGateDetail(line: string): string {
  const retained = /retained\s+([\d.]+)\s+of\s+([\d.]+)\s+periods/i.exec(line);
  const marched = /marched\s+([\d.]+)\s*s\s+of\s+([\d.]+)\s*s/i.exec(line);
  const parts: string[] = [];
  if (retained) parts.push(`retained ${retained[1]} / ${retained[2]} periods`);
  if (marched) parts.push(`marched ${marched[1]} s of ${marched[2]} s`);
  return parts.length ? parts.join(" · ") : line;
}

function gateFromPoint(row: {
  qualityWarnings?: string[] | null;
  classificationReasons?: string[] | null;
  error?: string | null;
}): SolverWorkGate | null {
  const line = firstDetailLine(row);
  if (!line) return null;
  const detail = normalizedGateDetail(line);
  const lower = line.toLowerCase();
  if (
    lower.includes(URANS_BUDGET_STOP_MARKER) ||
    /march|wall-clock budget|budget guard/.test(lower)
  ) {
    return { name: "march-rate guard", detail };
  }
  if (/non[- ]stationary|stationar/.test(lower))
    return { name: "stationarity gate", detail };
  if (
    /insufficient[- ]period|period|dominant frequency|shedding unmeasurable/.test(
      lower,
    )
  ) {
    return { name: "period detector", detail };
  }
  if (
    /mesh|degenerate|negative volume|skew|non[- ]orthogonal|wall[- ]?rate|y\+/.test(
      lower,
    )
  ) {
    return { name: "mesh QA gate", detail };
  }
  if (
    /rans|stalled|did not converge|not[- ]converged|solver[- ]stalled|non[- ]physical|low[- ]aoa|positive[- ]drag|missing[- ]coefficients|out_of_family/.test(
      lower,
    )
  ) {
    return { name: "RANS validity gate", detail };
  }
  return { name: "quality gate", detail };
}

function plainForPoint(
  state: SolverWorkState,
  gate: SolverWorkGate | null,
): string {
  switch (state) {
    case "verified":
      return "This point is verified and is used in the stored polar.";
    case "provisional":
      return "This point is usable now, and a higher-fidelity check is still part of the workflow.";
    case "solving":
      return "The solver is working on this point and will publish evidence when the run settles.";
    case "queued":
      return "This point is queued and has not produced solver evidence yet.";
    case "ladder":
      return "RANS found that this point needs unsteady treatment, so the URANS ladder is the next step.";
    case "needs_time":
      return gate
        ? `URANS reached the time budget after ${gate.detail}; the saved case can be continued.`
        : "URANS reached the time budget with saved state, so the solve can be continued.";
    case "needs_review":
      return gate
        ? `The solver produced evidence, but the ${gate.name} needs review before this point can be used.`
        : "The solver produced evidence, but a quality gate needs review before this point can be used.";
    case "blocked":
      return gate
        ? `The point is blocked by the ${gate.name}; change the setup or repair the blocker before trying again.`
        : "The point is blocked by a solver or mesh issue; change the setup or repair the blocker before trying again.";
    case "superseded":
      return "A higher-fidelity result replaced this point, and the replacement is used instead.";
  }
}

function actionsForPoint(
  row: SolverWorkPointStateRow,
  state: SolverWorkState,
): SolverWorkAction[] {
  if (state === "needs_time") return ["continue"];
  if (state === "needs_review") return ["retry"];
  if (
    row.resultId &&
    (state === "verified" || state === "provisional") &&
    !row.openVerify &&
    !row.openRequest &&
    normalizeFidelity(row.fidelity, row.regime) !== "urans_full"
  ) {
    return ["request_full"];
  }
  return [];
}

function attemptTone(attempt: AttemptRow): SolverWorkTone {
  if (attempt.status === "failed")
    return blockerFromError(attempt.error) ? "blocked" : "review";
  if (attempt.valid_for_polar) return "ok";
  if (attempt.regime === "rans") return "ladder";
  return attempt.error || (attempt.quality_warnings?.length ?? 0) > 0
    ? "review"
    : "neutral";
}

function chainForPoint(
  row: SolverWorkPointStateRow,
  attempts: AttemptRow[],
  state: SolverWorkState,
): Array<{ label: string; tone: SolverWorkTone }> {
  if (attempts.length > 0) {
    return attempts.map((attempt) => {
      const labelBase = attempt.regime
        ? attempt.regime.toUpperCase()
        : "Attempt";
      const label =
        attempt.status === "failed"
          ? `${labelBase} blocked`
          : attempt.valid_for_polar
            ? `${labelBase} ok`
            : `${labelBase} ladder`;
      return { label, tone: attemptTone(attempt) };
    });
  }
  if (state === "queued") return [{ label: "Queued", tone: "neutral" }];
  if (state === "solving") return [{ label: "Solving", tone: "neutral" }];
  if (row.regime || row.fidelity) {
    const labelBase =
      normalizeFidelity(row.fidelity, row.regime)
        ?.toUpperCase()
        .replace("_", " ") ?? String(row.regime).toUpperCase();
    return [
      {
        label: labelBase,
        tone:
          state === "blocked"
            ? "blocked"
            : state === "needs_review"
              ? "review"
              : state === "ladder"
                ? "ladder"
                : "ok",
      },
    ];
  }
  return [{ label: state.replace("_", " "), tone: "neutral" }];
}

function numericAoas(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function makePoint(
  row: ResultPointRow,
  attempts: AttemptRow[],
  opts: { displayAoa?: number; derivedBySymmetry?: boolean } = {},
): SolverWorkPoint {
  const stateRow: SolverWorkPointStateRow = {
    resultId: row.result_id,
    status: row.status,
    source: row.source,
    regime: row.regime,
    fidelity: row.fidelity,
    classificationState: row.classification_state,
    continuable: row.continuable,
    openVerify: row.open_verify,
    openRequest: row.open_request,
    autoRetriedAt: row.auto_retried_at,
    error: row.error,
  };
  const state = solverWorkStateForPoint(stateRow);
  // A "deciding gate" only exists for states a gate actually decided; benign
  // disclosures on verified rows (e.g. "converged (oscillating steady…)")
  // must not render as a gate verdict in the popover.
  const gate = ["ladder", "needs_time", "needs_review", "blocked"].includes(state)
    ? gateFromPoint({
        qualityWarnings: row.quality_warnings,
        classificationReasons: row.classification_reasons,
        error: row.error,
      })
    : null;
  const cl = numberOrNull(row.cl);
  const cd = numberOrNull(row.cd);
  const cm = numberOrNull(row.cm);
  return {
    aoaDeg: opts.displayAoa ?? Number(row.aoa_deg),
    state,
    resultId: row.result_id,
    fidelity: normalizeFidelity(row.fidelity, row.regime),
    cl: opts.derivedBySymmetry ? negated(cl) : cl,
    cd,
    cm: opts.derivedBySymmetry ? negated(cm) : cm,
    plain: plainForPoint(state, gate),
    gate,
    chain: chainForPoint(stateRow, attempts, state),
    continuable: Boolean(row.continuable),
    actions: actionsForPoint(stateRow, state),
    supersededBy:
      row.classification_state === "superseded_by_urans"
        ? row.superseded_by_result_id
        : null,
  };
}

function queuedPoint(aoaDeg: number): SolverWorkPoint {
  const stateRow: SolverWorkPointStateRow = { resultId: null, status: null };
  const state = solverWorkStateForPoint(stateRow);
  return {
    aoaDeg,
    state,
    resultId: null,
    fidelity: null,
    cl: null,
    cd: null,
    cm: null,
    plain: plainForPoint(state, null),
    gate: null,
    chain: chainForPoint(stateRow, [], state),
    continuable: false,
    actions: [],
    supersededBy: null,
  };
}

function pointKey(revisionId: string, aoaDeg: number): string {
  return `${revisionId}:${canonicalAoa(aoaDeg)}`;
}

function addPoint(
  points: Map<string, StoredPoint>,
  revisionId: string,
  point: SolverWorkPoint,
  updatedAt: string,
  priority: number,
) {
  const key = pointKey(revisionId, point.aoaDeg);
  const existing = points.get(key);
  if (!existing || priority > existing.priority) {
    points.set(key, { point, updatedAt, priority });
  } else if (priority === existing.priority) {
    existing.updatedAt = latestIso(existing.updatedAt, updatedAt);
  }
}

function snapshotNumber(
  snapshot: Record<string, unknown>,
  path: string[],
): number | null {
  let value: unknown = snapshot;
  for (const segment of path) {
    if (!value || typeof value !== "object") return null;
    value = (value as Record<string, unknown>)[segment];
  }
  return numberOrNull(value);
}

async function loadResultRows(
  airfoilId: string,
  revisionId?: string | null,
): Promise<ResultPointRow[]> {
  return (await db.execute(sql`
    SELECT
      r.id AS result_id,
      r.simulation_preset_revision_id AS revision_id,
      r.aoa_deg::float8 AS aoa_deg,
      r.status::text AS status,
      r.source::text AS source,
      r.regime::text AS regime,
      r.fidelity AS fidelity,
      r.cl,
      r.cd,
      r.cm,
      r.error,
      r.quality_warnings,
      r.auto_retried_at,
      r."updatedAt" AS updated_at,
      rc.state::text AS classification_state,
      rc.reasons AS classification_reasons,
      rc.superseded_by_result_id,
      ${CONTINUABLE_SQL} AS continuable,
      EXISTS (
        SELECT 1 FROM sim_urans_verify_queue q
        WHERE q.airfoil_id = r.airfoil_id
          AND q.revision_id = r.simulation_preset_revision_id
          AND q.aoa_deg = r.aoa_deg
          AND q.state IN ('pending', 'running')
      ) AS open_verify,
      EXISTS (
        SELECT 1 FROM sim_urans_requests req
        WHERE req.airfoil_id = r.airfoil_id
          AND req.revision_id = r.simulation_preset_revision_id
          AND (req.aoa_deg = r.aoa_deg OR req.aoa_deg IS NULL OR req.continue_from_result_id = r.id)
          AND req.state IN ('pending', 'running')
      ) AS open_request
    FROM results r
    LEFT JOIN result_classifications rc ON rc.result_id = r.id
    WHERE r.airfoil_id = ${airfoilId}
      AND r.simulation_preset_revision_id IS NOT NULL
      ${revisionId ? sql`AND r.simulation_preset_revision_id = ${revisionId}` : sql``}
  `)) as unknown as ResultPointRow[];
}

async function loadCampaignPointRows(
  airfoilId: string,
  revisionId?: string | null,
): Promise<CampaignPointRow[]> {
  return (await db.execute(sql`
    SELECT
      p.revision_id,
      p.aoa_deg::float8 AS aoa_deg,
      p.state AS point_state,
      p.derived_by_symmetry,
      p."updatedAt" AS point_updated_at,
      r.id AS result_id,
      r.aoa_deg::float8 AS source_aoa_deg,
      r.status::text AS status,
      r.source::text AS source,
      r.regime::text AS regime,
      r.fidelity AS fidelity,
      r.cl,
      r.cd,
      r.cm,
      r.error,
      r.quality_warnings,
      r.auto_retried_at,
      COALESCE(r."updatedAt", p."updatedAt") AS updated_at,
      rc.state::text AS classification_state,
      rc.reasons AS classification_reasons,
      rc.superseded_by_result_id,
      ${CONTINUABLE_SQL} AS continuable,
      EXISTS (
        SELECT 1 FROM sim_urans_verify_queue q
        WHERE q.airfoil_id = p.airfoil_id
          AND q.revision_id = p.revision_id
          AND q.aoa_deg = p.aoa_deg
          AND q.state IN ('pending', 'running')
      ) AS open_verify,
      EXISTS (
        SELECT 1 FROM sim_urans_requests req
        WHERE req.airfoil_id = p.airfoil_id
          AND req.revision_id = p.revision_id
          AND (req.aoa_deg = p.aoa_deg OR req.aoa_deg IS NULL OR req.continue_from_result_id = r.id)
          AND req.state IN ('pending', 'running')
      ) AS open_request
    FROM sim_campaign_points p
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = r.id
    WHERE p.airfoil_id = ${airfoilId}
      ${revisionId ? sql`AND p.revision_id = ${revisionId}` : sql``}
  `)) as unknown as CampaignPointRow[];
}

async function loadJobActivityRows(
  airfoilId: string,
  revisionId?: string | null,
): Promise<JobActivityRow[]> {
  return (await db.execute(sql`
    SELECT
      id,
      simulation_preset_revision_id AS revision_id,
      request_payload,
      "createdAt" AS created_at,
      "updatedAt" AS updated_at,
      "submittedAt" AS submitted_at,
      "finishedAt" AS finished_at
    FROM sim_jobs
    WHERE airfoil_id = ${airfoilId}
      AND simulation_preset_revision_id IS NOT NULL
      ${revisionId ? sql`AND simulation_preset_revision_id = ${revisionId}` : sql``}
    ORDER BY "createdAt" DESC
    LIMIT 200
  `)) as unknown as JobActivityRow[];
}

async function loadAttempts(
  resultIds: string[],
): Promise<Map<string, AttemptRow[]>> {
  if (resultIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT result_id, regime::text AS regime, status::text AS status, valid_for_polar,
           error, quality_warnings, "createdAt" AS created_at
    FROM result_attempts
    WHERE result_id = ANY(${`{${resultIds.join(",")}}`}::uuid[])
    ORDER BY "createdAt" ASC
  `)) as unknown as AttemptRow[];
  const byResult = new Map<string, AttemptRow[]>();
  for (const row of rows) {
    (
      byResult.get(row.result_id) ??
      byResult.set(row.result_id, []).get(row.result_id)!
    ).push(row);
  }
  return byResult;
}

async function loadRevisions(
  revisionIds: string[],
): Promise<Map<string, RevisionRow>> {
  if (revisionIds.length === 0) return new Map();
  const rows = (await db
    .select({
      id: simulationPresetRevisions.id,
      reynolds: simulationPresetRevisions.reynolds,
      mach: simulationPresetRevisions.mach,
      reference_length_m: simulationPresetRevisions.referenceLengthM,
      snapshot: simulationPresetRevisions.snapshot,
      created_at: simulationPresetRevisions.createdAt,
    })
    .from(simulationPresetRevisions)
    .where(
      sql`${simulationPresetRevisions.id} = ANY(${`{${revisionIds.join(",")}}`}::uuid[])`,
    )) as unknown as RevisionRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

export async function assembleSolverWork(
  slug: string,
  opts: { revisionId?: string | null } = {},
): Promise<SolverWorkPayload | null> {
  const [a] = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .where(
      and(
        eq(airfoils.slug, slug),
        isNull(airfoils.archivedAt),
        isNull(airfoils.deletedAt),
      ),
    )
    .limit(1);
  if (!a) return null;

  const [resultRows, campaignRows, jobRows] = await Promise.all([
    loadResultRows(a.id, opts.revisionId),
    loadCampaignPointRows(a.id, opts.revisionId),
    loadJobActivityRows(a.id, opts.revisionId),
  ]);

  const revisionIds = new Set<string>();
  for (const row of resultRows) revisionIds.add(row.revision_id);
  for (const row of campaignRows) revisionIds.add(row.revision_id);
  for (const row of jobRows) revisionIds.add(row.revision_id);

  const resultIds = new Set<string>();
  for (const row of resultRows) resultIds.add(row.result_id);
  for (const row of campaignRows)
    if (row.result_id) resultIds.add(row.result_id);
  const [attemptsByResult, revisions] = await Promise.all([
    loadAttempts([...resultIds]),
    loadRevisions([...revisionIds]),
  ]);

  const points = new Map<string, StoredPoint>();
  const latestByRevision = new Map<string, string>();

  const touchRevision = (revisionId: string, updatedAt: string) => {
    latestByRevision.set(
      revisionId,
      latestIso(latestByRevision.get(revisionId), updatedAt),
    );
  };

  for (const row of resultRows) {
    const updatedAt = isoOf(row.updated_at);
    addPoint(
      points,
      row.revision_id,
      makePoint(row, attemptsByResult.get(row.result_id) ?? []),
      updatedAt,
      3,
    );
    touchRevision(row.revision_id, updatedAt);
  }

  for (const row of campaignRows) {
    const updatedAt = isoOf(row.point_updated_at);
    if (row.result_id) {
      addPoint(
        points,
        row.revision_id,
        makePoint(row, attemptsByResult.get(row.result_id) ?? [], {
          displayAoa: Number(row.aoa_deg),
          derivedBySymmetry:
            row.derived_by_symmetry &&
            numberOrNull(row.source_aoa_deg) !== numberOrNull(row.aoa_deg),
        }),
        latestIso(updatedAt, isoOf(row.updated_at)),
        row.derived_by_symmetry ? 2 : 1,
      );
    } else {
      addPoint(
        points,
        row.revision_id,
        queuedPoint(Number(row.aoa_deg)),
        updatedAt,
        1,
      );
    }
    touchRevision(row.revision_id, updatedAt);
  }

  for (const row of jobRows) {
    const activity = latestIso(
      isoOf(row.created_at),
      isoOf(row.updated_at),
      isoOf(row.submitted_at),
      isoOf(row.finished_at),
    );
    for (const aoa of numericAoas(
      (row.request_payload as { aoas?: unknown } | null)?.aoas,
    )) {
      addPoint(points, row.revision_id, queuedPoint(aoa), activity, 0);
    }
    touchRevision(row.revision_id, activity);
  }

  const conditions = await Promise.all(
    [...revisionIds].map(async (revisionId) => {
      const revision = revisions.get(revisionId);
      const snapshot = revision?.snapshot ?? {};
      const conditionPoints = [...points.entries()]
        .filter(([key]) => key.startsWith(`${revisionId}:`))
        .map(([, stored]) => stored.point)
        .sort((x, y) => x.aoaDeg - y.aoaDeg);
      const jobs = await loadSimulationWorks(a.id, { revisionId });
      const updatedAt = latestIso(
        latestByRevision.get(revisionId),
        revision ? isoOf(revision.created_at) : null,
        ...conditionPoints.map(
          (point) => points.get(pointKey(revisionId, point.aoaDeg))?.updatedAt,
        ),
      );
      return {
        presetRevisionId: revisionId,
        reynolds: Math.round(numberOrNull(revision?.reynolds) ?? 0),
        mach:
          numberOrNull(revision?.mach) ??
          snapshotNumber(snapshot, ["flowState", "mach"]) ??
          snapshotNumber(snapshot, ["operating", "mach"]),
        chordM:
          snapshotNumber(snapshot, ["referenceGeometry", "referenceLengthM"]) ??
          snapshotNumber(snapshot, ["operating", "referenceChordM"]) ??
          numberOrNull(revision?.reference_length_m),
        speedMps:
          snapshotNumber(snapshot, ["flowState", "speedMps"]) ??
          snapshotNumber(snapshot, ["operating", "speedMps"]),
        updatedAt,
        attentionCount: conditionPoints.filter((point) =>
          ATTENTION_STATES.has(point.state),
        ).length,
        points: conditionPoints,
        jobs,
      } satisfies SolverWorkCondition;
    }),
  );

  return {
    conditions: conditions.sort((x, y) => {
      const byActivity =
        new Date(y.updatedAt).getTime() - new Date(x.updatedAt).getTime();
      return (
        byActivity ||
        x.reynolds - y.reynolds ||
        x.presetRevisionId.localeCompare(y.presetRevisionId)
      );
    }),
  };
}
