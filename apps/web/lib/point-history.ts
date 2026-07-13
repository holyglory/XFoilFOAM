// Point History Explorer pure helpers (Solver ▸ Points tab): URL-param
// round-trip for the table filters, the one-line STORY digest builder, and
// the story-panel timeline assembly. Pure module — no React, no fetch — so
// the vitest node suite covers it with relative imports.

// ---------------------------------------------------------------------------
// Shared API payload types (mirrors apps/api point-history endpoints).
// ---------------------------------------------------------------------------
/** Primary chip row. `needs_review` is reserved for a future explicit
 *  evidence-adjudication workflow, so it remains a valid legacy/deep-link
 *  filter but is not advertised while no active solver path can assign it. */
export const POINT_STATUS_CHIPS = [
  "all",
  "failed",
  "awaiting_urans",
  "accepted",
  "needs_urans",
  "solving",
] as const;
/** Deprecated aliases keep old links filtering server-side, but render no
 *  primary chip until their workflow exists. */
export type PointStatusChip =
  | (typeof POINT_STATUS_CHIPS)[number]
  | "needs_review"
  | "rejected";
const POINT_STATUS_VALUES: readonly string[] = [
  ...POINT_STATUS_CHIPS,
  "needs_review",
  "rejected",
];

export const POINT_ERROR_CLASSES = [
  "mesh",
  "diverged",
  "timeout",
  "engine",
  "cancelled",
  "solver",
  "unknown",
] as const;
export type PointErrorClass = (typeof POINT_ERROR_CLASSES)[number];

export interface PointAttemptDigestEvent {
  regime: "rans" | "urans" | null;
  validForPolar: boolean;
  converged: boolean;
  stalled: boolean;
  unsteady: boolean;
  strouhal: number | null;
  error: string | null;
}

/** Latest sim_urans_verify_queue item for a point (fidelity ladder contract 4). */
export interface PointVerifyInfo {
  state: string;
  deltaCl: number | null;
  deltaCd: number | null;
  deltaCm: number | null;
  submitError?: string | null;
  submitHttpStatus?: number | null;
}

export interface PointHistoryItem {
  kind: "result" | "derived";
  rowKey: string;
  resultId: string;
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  aoaDeg: number;
  sourceAoaDeg: number | null;
  reynolds: number | null;
  regime: "rans" | "urans" | null;
  status: string;
  bucket: string;
  classificationState: string | null;
  errorClass: string | null;
  error: string | null;
  attemptCount: number;
  attemptDigest: PointAttemptDigestEvent[];
  campaignId: string | null;
  campaignName: string | null;
  conditionId: string | null;
  revisionId: string | null;
  lastActivityAt: string;
  /** Fidelity ladder echo (results.fidelity): 'rans' | 'urans_precalc' |
   *  'urans_full' | null (pre-ladder/unsolved). */
  fidelity: string | null;
  /** Rolling-compatibility ladder bucket. `needs_review` is a legacy wire value
   *  and is presented as unavailable, never as required human adjudication. */
  reviewBucket: "awaiting_urans" | "needs_review" | null;
  workDisposition: "scheduled" | "blocked" | null;
  /** Amendment C: the rejected urans solve has restartable saved case state
   *  after a budget stop or bounded same-case continuation (Continue +2h/+6h). */
  continuable: boolean;
  /** Latest verify-queue item covering this cell+angle; null = never queued. */
  verify: PointVerifyInfo | null;
}

export interface PointHistoryCounts {
  failed: number;
  /** Deprecated union bucket (every done+physics-rejected row); kept for old
   *  links only — the chips render the split counts below instead. */
  rejected: number;
  awaiting_urans: number;
  needs_review: number;
  accepted: number;
  needs_urans: number;
  solving: number;
  all: number;
}

export interface PointHistoryFacets {
  campaigns: Array<{ id: string; name: string; status: string }>;
  reynolds: number[];
}

export interface PointHistoryPagePayload {
  items: PointHistoryItem[];
  nextCursor: string | null;
  counts: PointHistoryCounts;
  facets?: PointHistoryFacets;
}

export interface PointStoryAttempt {
  id: string;
  regime: "rans" | "urans" | null;
  status: string;
  validForPolar: boolean;
  converged: boolean;
  stalled: boolean;
  unsteady: boolean;
  firstOrderFallback: boolean;
  cl: number | null;
  cd: number | null;
  clCd: number | null;
  strouhal: number | null;
  error: string | null;
  qualityWarnings: string[];
  engineCaseSlug: string | null;
  simJob: {
    id: string;
    wave: number;
    jobKind: string;
    status: string;
    campaignId: string | null;
    engineJobId: string | null;
  } | null;
  classification: {
    state: string;
    reasons: string[];
    confidence: number;
  } | null;
  createdAt: string;
  solvedAt: string | null;
}

export interface PointStoryInterruption {
  simJobId: string;
  engineJobId: string | null;
  wave: number;
  jobKind: string;
  campaignId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface PointStoryPayload {
  point: {
    resultId: string;
    airfoilId: string;
    airfoilSlug: string;
    airfoilName: string;
    aoaDeg: number;
    reynolds: number | null;
    mach: number | null;
    speed: number | null;
    regime: "rans" | "urans" | null;
    status: string;
    error: string | null;
    qualityWarnings: string[];
    classification: {
      state: string;
      reasons: string[];
      confidence: number;
      classifierVersion: string;
    } | null;
    revisionId: string | null;
    campaignId: string | null;
    campaignName: string | null;
    conditionId: string | null;
    solvedAt: string | null;
    updatedAt: string;
    /** Fidelity ladder echo (results.fidelity); null = pre-ladder/unsolved. */
    fidelity: string | null;
    /** Rolling-compatibility ladder bucket (see PointHistoryItem.reviewBucket). */
    reviewBucket: "awaiting_urans" | "needs_review" | null;
    workDisposition: "scheduled" | "blocked" | null;
    /** Amendment C: rejected urans row with restartable saved case state — the
     *  story panel renders Continue +2h/+6h on exactly these. */
    continuable: boolean;
    /** Latest verify-queue item for this cell+angle; null = never queued. */
    verify: PointVerifyInfo | null;
  };
  attempts: PointStoryAttempt[];
  interruptions: PointStoryInterruption[];
  closure: {
    campaignId: string;
    campaignName: string | null;
    conditionId: string;
    openAirfoils: number;
    totalAirfoils: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Filter ⇄ URL query-param round-trip. Filters live in the URL (replace
// semantics, same single-source-of-truth rule as ?section/?tab). Default
// values are OMITTED from the URL so plain ?section=queue&tab=points stays
// canonical.
// ---------------------------------------------------------------------------
export const POINT_VERIFY_FILTERS = [
  "pending",
  "disagreed",
  "blocked",
] as const;
export type PointVerifyFilterValue = "" | (typeof POINT_VERIFY_FILTERS)[number];

export interface PointFilters {
  status: PointStatusChip;
  airfoil: string;
  campaignId: string;
  regime: "" | "rans" | "urans";
  errorClass: "" | PointErrorClass;
  reynolds: string; // keep as string: '' = any; URL/select round-trip value
  /** Fidelity-ladder verify filter: '' = any, 'pending' = open verify item,
   *  'disagreed' = latest verify item flagged a disagreement. */
  verify: PointVerifyFilterValue;
}

export const DEFAULT_POINT_FILTERS: PointFilters = {
  status: "all",
  airfoil: "",
  campaignId: "",
  regime: "",
  errorClass: "",
  reynolds: "",
  verify: "",
};

/** Parse the point filters out of a location.search string (extra params are
 *  ignored; malformed values fall back to defaults — the URL is user input). */
export function parsePointFilters(search: string): PointFilters {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const status = params.get("pstatus") ?? "all";
  const regime = params.get("pregime") ?? "";
  const errorClass = params.get("perr") ?? "";
  const reynolds = params.get("pre") ?? "";
  const verify = params.get("pverify") ?? "";
  return {
    status: POINT_STATUS_VALUES.includes(status)
      ? (status as PointStatusChip)
      : "all",
    airfoil: params.get("pairfoil") ?? "",
    campaignId: params.get("pcampaign") ?? "",
    regime: regime === "rans" || regime === "urans" ? regime : "",
    errorClass: (POINT_ERROR_CLASSES as readonly string[]).includes(errorClass)
      ? (errorClass as PointErrorClass)
      : "",
    reynolds: /^\d+$/.test(reynolds) ? reynolds : "",
    verify: (POINT_VERIFY_FILTERS as readonly string[]).includes(verify)
      ? (verify as PointVerifyFilterValue)
      : "",
  };
}

/** Merge the filters into an existing search string (preserving foreign params
 *  like ?section/?tab) and return the canonical `?…` string ('' when empty). */
export function pointFiltersToSearch(
  search: string,
  filters: PointFilters,
): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const setOrDelete = (key: string, value: string, defaultValue: string) => {
    if (value && value !== defaultValue) params.set(key, value);
    else params.delete(key);
  };
  setOrDelete("pstatus", filters.status, "all");
  setOrDelete("pairfoil", filters.airfoil.trim(), "");
  setOrDelete("pcampaign", filters.campaignId, "");
  setOrDelete("pregime", filters.regime, "");
  setOrDelete("perr", filters.errorClass, "");
  setOrDelete("pre", filters.reynolds, "");
  setOrDelete("pverify", filters.verify, "");
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Buckets campaign surfaces link to (amendment A): the split buckets replace
 *  the deprecated 'rejected' union in every gate badge / count link; 'failed'
 *  stays for surfaces whose payload only carries a failed count (backlog
 *  strip); 'rejected' is accepted for old callers only. */
export type CampaignPointsBucket =
  | "failed"
  | "rejected"
  | "awaiting_urans"
  | "needs_review";

/** Canonical explorer link target for a campaign's review-bucket counts
 *  (hub cards, campaign detail header, backlog strip): the Solver ▸ Points
 *  tab pre-filtered to that campaign + bucket. Built through
 *  pointFiltersToSearch so the param names can never drift from the
 *  explorer's own URL round-trip. */
export function campaignPointsSearch(
  campaignId: string,
  status: CampaignPointsBucket,
): string {
  return pointFiltersToSearch("?section=queue&tab=points", {
    ...DEFAULT_POINT_FILTERS,
    campaignId,
    status,
  });
}

/** Explorer link for a cell's verify-ladder chips (campaign cell panel):
 *  Solver ▸ Points pre-filtered to the airfoil + verify state, built through
 *  the same round-trip so param names can never drift. */
export function verifyPointsSearch(
  airfoilSlug: string,
  verify: "pending" | "disagreed" | "blocked",
): string {
  return pointFiltersToSearch("?section=queue&tab=points", {
    ...DEFAULT_POINT_FILTERS,
    airfoil: airfoilSlug,
    verify,
  });
}

// ---------------------------------------------------------------------------
// Bulk resume (unavailable-evidence toolbar): one honest outcome line from the
// bulk-continue response. Counts come straight from the server — created /
// reused / conflicted always sum to continuable, and non-resumable rows
// (crashes and rejections without restartable state) were never in the set.
// ---------------------------------------------------------------------------
export interface BulkContinueOutcome {
  continuable: number;
  created: number;
  reused: number;
  conflicted: number;
}

export function formatBulkContinueOutcome(o: BulkContinueOutcome): string {
  if (o.continuable === 0)
    return "nothing to resume — no unavailable point in this scope has restartable saved state";
  const parts = [`queued ${o.created}`, `already open ${o.reused}`];
  if (o.conflicted > 0) parts.push(`conflicting open request ${o.conflicted}`);
  return `${parts.join(" · ")} — non-resumable rows are excluded`;
}

// ---------------------------------------------------------------------------
// Fidelity chip (ladder contract): the ONE presentation rule for every surface
// that renders a classification chip (Points rows, story header, cell panel,
// solver-results modal). Pure so node vitest pins the truth table.
//   rans / null            → no chip (plain — steady evidence needs no badge)
//   urans_precalc          → amber 'precalc' (+ honest verify-queue suffix)
//   urans_full             → teal 'verified' (full-fidelity tier)
//   latest verify disagreed → red 'verify disagreed (Δcl 0.06)' — the deltas
//     rendered are the REAL stored deltas, bound-annotated by the pinned
//     contract limits below.
// ---------------------------------------------------------------------------
/** Contract-4 disagreement bounds — pinned here for label emphasis only; the
 *  authoritative comparison lives in the sweeper (engine-client fidelity.ts).
 *  Drift is caught by the fidelity-ladder web test pinning the same values. */
export const URANS_VERIFY_DELTA_CL_LIMIT = 0.05;
export const URANS_VERIFY_DELTA_CD_LIMIT = 0.01;

export interface FidelityChipView {
  label: string;
  tone: "teal" | "amber" | "red";
}

function fmtDelta(v: number): string {
  const s = Math.abs(v).toFixed(3);
  return s.replace(/0+$/, "").replace(/\.$/, ".0");
}

/** Human label for the offending deltas of a disagreed verify item. Lists the
 *  deltas that exceeded their contract bound; falls back to every recorded
 *  delta (a disagreement always stores its evidence — an empty suffix means
 *  the deltas were never recorded, and we say nothing rather than invent). */
export function disagreedDeltaLabel(verify: PointVerifyInfo): string {
  const parts: string[] = [];
  if (
    verify.deltaCl != null &&
    Math.abs(verify.deltaCl) > URANS_VERIFY_DELTA_CL_LIMIT
  )
    parts.push(`Δcl ${fmtDelta(verify.deltaCl)}`);
  if (
    verify.deltaCd != null &&
    Math.abs(verify.deltaCd) > URANS_VERIFY_DELTA_CD_LIMIT
  )
    parts.push(`Δcd ${fmtDelta(verify.deltaCd)}`);
  if (parts.length === 0) {
    if (verify.deltaCl != null) parts.push(`Δcl ${fmtDelta(verify.deltaCl)}`);
    if (verify.deltaCd != null) parts.push(`Δcd ${fmtDelta(verify.deltaCd)}`);
  }
  return parts.join(" · ");
}

/** null = render nothing (plain RANS / pre-ladder rows stay unbadged). */
export function fidelityChipView(
  fidelity: string | null,
  verify: PointVerifyInfo | null,
): FidelityChipView | null {
  if (verify?.state === "disagreed") {
    const deltas = disagreedDeltaLabel(verify);
    return {
      label: deltas ? `verify disagreed (${deltas})` : "verify disagreed",
      tone: "red",
    };
  }
  if (verify?.state === "blocked")
    return { label: "precalc · verify blocked", tone: "amber" };
  if (fidelity === "urans_full") return { label: "verified", tone: "teal" };
  if (fidelity === "urans_precalc") {
    if (verify?.state === "pending" || verify?.state === "running")
      return { label: "precalc · verify pending", tone: "amber" };
    if (verify?.state === "done")
      return { label: "precalc · verified", tone: "teal" };
    if (verify?.state === "cancelled")
      return { label: "precalc · verify cancelled", tone: "amber" };
    return { label: "precalc", tone: "amber" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Client mirror of the server's single bucket expression (BUCKET_SQL in
// packages/db point-history): used to keep the story-panel header chips
// truthful once the authoritative story payload has loaded (e.g. after
// jumping from a derived mirror to its +α source point).
// ---------------------------------------------------------------------------
export function bucketOfPoint(
  status: string,
  classificationState: string | null,
): string {
  if (status === "failed") return "failed";
  if (status === "pending" || status === "queued" || status === "running")
    return "solving";
  if (status === "done" && classificationState === "rejected")
    return "rejected";
  if (status === "done" && classificationState === "needs_urans")
    return "needs_urans";
  if (status === "done" && classificationState === "accepted")
    return "accepted";
  return "other";
}

// ---------------------------------------------------------------------------
// Review-bucket display (amendment A recolor): the ONE presentation rule for
// status chips wherever a raw bucket + refined reviewBucket pair is known
// (Points rows, story header). Violet is CALM (stage-2 queue, no repair
// verbs); red is strictly failed / needs-review.
// ---------------------------------------------------------------------------
export type StatusChipTone = "teal" | "amber" | "red" | "violet" | "muted";

export interface StatusChipDisplay {
  label: string;
  tone: StatusChipTone;
}

/** Chip label + tone for a table/story status chip. Explicit machine work
 *  disposition wins over legacy bucket values. */
export function statusChipDisplay(
  bucket: string,
  reviewBucket: "awaiting_urans" | "needs_review" | null,
  workDisposition: "scheduled" | "blocked" | null = null,
): StatusChipDisplay {
  switch (bucket) {
    case "failed":
      if (reviewBucket === "awaiting_urans" && workDisposition === "scheduled")
        return { label: "URANS queued", tone: "violet" };
      return { label: "failed", tone: "red" };
    case "rejected":
      if (workDisposition === "blocked")
        return { label: "blocked · unavailable", tone: "amber" };
      if (reviewBucket === "awaiting_urans")
        return { label: "awaiting URANS", tone: "violet" };
      if (reviewBucket === "needs_review")
        return { label: "unavailable", tone: "red" };
      if (workDisposition === "scheduled")
        return { label: "rejected · rescheduled", tone: "amber" };
      return { label: "rejected", tone: "amber" };
    case "accepted":
      return { label: "accepted", tone: "teal" };
    case "needs_urans":
      return { label: "needs URANS", tone: "amber" };
    case "solving":
      return { label: "solving", tone: "amber" };
    default:
      return { label: bucket, tone: "muted" };
  }
}

// ---------------------------------------------------------------------------
// STORY digest: one line per table row summarizing the attempt chain, e.g.
//   "RANS ✗ → URANS ⏱ timeout ×3"
//   "RANS ✗ → URANS ✓ steady (no shedding)"
//   "derived by symmetry — mirror of +4°"
// Consecutive identical steps collapse into ×N. Honest fallbacks when there
// are no attempt records (pre-attempt-era rows, still-queued backlog).
// ---------------------------------------------------------------------------
const isTimeout = (error: string | null): boolean =>
  !!error && /time[d]?\s*out|timeout/i.test(error);

function digestStep(e: PointAttemptDigestEvent): string {
  const regime =
    e.regime === "urans" ? "URANS" : e.regime === "rans" ? "RANS" : "solve";
  if (e.error)
    return isTimeout(e.error)
      ? `${regime} ⏱ timeout`
      : `${regime} ✗ ${shortErrorLabel(e.error)}`;
  if (e.validForPolar) {
    if (e.regime === "urans") {
      return e.unsteady && e.strouhal != null
        ? `${regime} ✓ shedding`
        : `${regime} ✓ steady (no shedding)`;
    }
    return `${regime} ✓`;
  }
  return e.stalled || !e.converged ? `${regime} ✗` : `${regime} ✗ invalid`;
}

/** Compact honest error label for the digest line (full text lives in the
 *  story panel). */
export function shortErrorLabel(error: string): string {
  const t = error.trim();
  if (/mesh/i.test(t)) return "mesh";
  if (/diverg|residual| nan/i.test(t)) return "diverged";
  if (isTimeout(t)) return "timeout";
  if (/cancel/i.test(t)) return "cancelled";
  if (/connect|unreachable|engine|econn/i.test(t)) return "engine";
  return "solver error";
}

export function buildStoryDigest(
  item: Pick<
    PointHistoryItem,
    | "kind"
    | "status"
    | "bucket"
    | "attemptDigest"
    | "attemptCount"
    | "sourceAoaDeg"
  >,
): string {
  if (item.kind === "derived") {
    const src =
      item.sourceAoaDeg != null
        ? ` — mirror of ${item.sourceAoaDeg > 0 ? "+" : ""}${item.sourceAoaDeg}°`
        : "";
    return `derived by symmetry${src}`;
  }
  if (item.attemptDigest.length === 0) {
    if (item.status === "running") return "solving — no attempts recorded yet";
    if (item.status === "queued" || item.status === "pending")
      return "queued — not attempted yet";
    if (item.status === "done") return "solved (no attempt records)";
    if (item.status === "failed") return "failed (no attempt records)";
    return item.status;
  }
  const steps: Array<{ label: string; n: number }> = [];
  for (const e of item.attemptDigest) {
    const label = digestStep(e);
    const lastStep = steps[steps.length - 1];
    if (lastStep && lastStep.label === label) lastStep.n++;
    else steps.push({ label, n: 1 });
  }
  let chain = steps
    .map((s) => (s.n > 1 ? `${s.label} ×${s.n}` : s.label))
    .join(" → ");
  if (item.attemptCount > item.attemptDigest.length)
    chain += ` (+${item.attemptCount - item.attemptDigest.length} more)`;
  return chain;
}

// ---------------------------------------------------------------------------
// Timeline assembly for the story side panel. Chronological attempt +
// interruption events, then the classification verdict, then the NOW node.
// Escalation semantics: RANS→URANS is amber/normal operation; red is strictly
// crashes/timeouts (attempt errors, failed status).
// ---------------------------------------------------------------------------
export type TimelineTone = "teal" | "amber" | "red" | "muted";

export interface TimelineEvent {
  kind: "attempt" | "interruption" | "classification" | "now";
  at: string | null;
  tone: TimelineTone;
  title: string;
  detail: string | null;
  /** Honest per-attempt engine "why" lines (persisted quality warnings). */
  whyLines: string[];
  attempt?: PointStoryAttempt;
  interruption?: PointStoryInterruption;
}

function attemptTitle(a: PointStoryAttempt): string {
  const regime =
    a.regime === "urans" ? "URANS" : a.regime === "rans" ? "RANS" : "solve";
  if (a.error)
    return isTimeout(a.error)
      ? `${regime} attempt — timeout`
      : `${regime} attempt — failed`;
  if (a.validForPolar) {
    if (a.regime === "urans")
      return a.unsteady && a.strouhal != null
        ? `${regime} attempt — valid, shedding measured`
        : `${regime} attempt — valid, steady (no shedding)`;
    return `${regime} attempt — valid`;
  }
  return `${regime} attempt — ${a.stalled ? "stalled" : "invalid"} (escalation evidence)`;
}

function attemptDetailLine(a: PointStoryAttempt): string {
  const bits: string[] = [];
  bits.push(a.converged ? "converged" : "not converged");
  if (a.stalled) bits.push("stalled");
  if (a.validForPolar) bits.push("valid for polar");
  if (a.cl != null) bits.push(`Cl ${a.cl.toFixed(3)}`);
  if (a.strouhal != null) bits.push(`St ${a.strouhal.toFixed(3)}`);
  if (a.firstOrderFallback) bits.push("1st-order fallback");
  if (a.error) bits.push(a.error);
  return bits.join(" · ");
}

const WORKER_RESTART_RE = /worker restarted mid-solve/i;

export function assembleTimeline(story: PointStoryPayload): TimelineEvent[] {
  const timed: TimelineEvent[] = [];
  for (const a of story.attempts) {
    timed.push({
      kind: "attempt",
      at: a.solvedAt ?? a.createdAt,
      // Red strictly for crashes/timeouts; a rejected/stalled attempt that
      // escalated to URANS is amber (normal operation); valid is teal.
      tone: a.error ? "red" : a.validForPolar ? "teal" : "amber",
      title: attemptTitle(a),
      detail: attemptDetailLine(a),
      whyLines: a.qualityWarnings,
      attempt: a,
    });
  }
  for (const j of story.interruptions) {
    timed.push({
      kind: "interruption",
      at: j.finishedAt ?? j.createdAt,
      tone: "amber",
      title: WORKER_RESTART_RE.test(j.error ?? "")
        ? "interrupted — worker restarted mid-solve; point released"
        : "interrupted — job cancelled; point released",
      detail: j.error,
      whyLines: [],
      interruption: j,
    });
  }
  timed.sort(
    (x, y) => new Date(x.at ?? 0).getTime() - new Date(y.at ?? 0).getTime(),
  );

  const events = [...timed];
  const cls = story.point.classification;
  const uransQueued =
    story.point.reviewBucket === "awaiting_urans" &&
    story.point.workDisposition === "scheduled";
  if (cls) {
    const tone: TimelineTone = uransQueued
      ? "amber"
      : cls.state === "accepted"
        ? "teal"
        : cls.state === "rejected"
          ? "red"
          : "amber";
    events.push({
      kind: "classification",
      at: null,
      tone,
      title: uransQueued
        ? "RANS did not converge — preliminary URANS queued"
        : `classified ${cls.state.replaceAll("_", " ")} (confidence ${Math.round(cls.confidence * 100)}%)`,
      detail: uransQueued
        ? "the steady-solver evidence is retained; targeted preliminary URANS is the next automatic calculation"
        : cls.reasons.length
          ? cls.reasons.join(", ")
          : null,
      whyLines: [],
    });
  }

  // Fidelity ladder verification (contract 4): the verify queue's REAL state
  // for this cell+angle. Pending/running = honest "scheduled last" note;
  // disagreed = red event carrying the stored deltas.
  const verify = story.point.verify;
  if (verify && (verify.state === "pending" || verify.state === "running")) {
    events.push({
      kind: "classification",
      at: null,
      tone: "amber",
      title:
        verify.state === "running"
          ? "full-fidelity verification running"
          : "full-fidelity verification queued",
      detail:
        "precalc URANS evidence — a full-mesh 7-period re-solve verifies it at the lowest scheduler priority",
      whyLines: [],
    });
  } else if (verify && verify.state === "disagreed") {
    const deltas = disagreedDeltaLabel(verify);
    events.push({
      kind: "classification",
      at: null,
      tone: "red",
      title: "full-fidelity verification DISAGREED",
      detail: `${deltas ? `${deltas} — ` : ""}classification stays on the verified full-fidelity row; the precalc/full disagreement is flagged for review`,
      whyLines: [],
    });
  } else if (verify && verify.state === "blocked") {
    events.push({
      kind: "classification",
      at: null,
      tone: "amber",
      title: "full-fidelity verification blocked",
      detail: `${verify.submitHttpStatus ? `HTTP ${verify.submitHttpStatus} — ` : ""}${verify.submitError ?? "the engine rejected the full-fidelity submit after its bounded automatic retry"}`,
      whyLines: [
        "accepted preliminary evidence is retained; this is terminal machine work, not a coefficient-review task",
      ],
    });
  }

  const bucketTone: TimelineTone = uransQueued
    ? "amber"
    : story.point.status === "failed"
      ? "red"
      : cls?.state === "rejected"
        ? "red"
        : story.point.status === "done"
          ? "teal"
          : "amber";
  const evidence = `${story.attempts.length} attempt${story.attempts.length === 1 ? "" : "s"}${
    story.interruptions.length
      ? ` · ${story.interruptions.length} interruption${story.interruptions.length === 1 ? "" : "s"}`
      : ""
  }`;
  const closureLine = story.closure
    ? `this angle open for ${story.closure.openAirfoils} of ${story.closure.totalAirfoils} airfoils in this condition`
    : null;
  events.push({
    kind: "now",
    at: story.point.updatedAt,
    tone: bucketTone,
    title: uransQueued
      ? "NOW: preliminary URANS queued"
      : `NOW: ${story.point.status}${cls ? ` · ${cls.state.replaceAll("_", " ")}` : ""}`,
    detail: [evidence, closureLine].filter(Boolean).join(" — "),
    whyLines: story.point.qualityWarnings,
  });
  return events;
}
