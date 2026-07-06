// Point History Explorer pure helpers (Solver ▸ Points tab): URL-param
// round-trip for the table filters, the one-line STORY digest builder, and
// the story-panel timeline assembly. Pure module — no React, no fetch — so
// the vitest node suite covers it with relative imports.

// ---------------------------------------------------------------------------
// Shared API payload types (mirrors apps/api point-history endpoints).
// ---------------------------------------------------------------------------
export const POINT_STATUS_CHIPS = ["all", "failed", "rejected", "accepted", "needs_urans", "solving"] as const;
export type PointStatusChip = (typeof POINT_STATUS_CHIPS)[number];

export const POINT_ERROR_CLASSES = ["mesh", "diverged", "timeout", "engine", "cancelled", "solver", "unknown"] as const;
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
}

export interface PointHistoryCounts {
  failed: number;
  rejected: number;
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
  simJob: { id: string; wave: number; jobKind: string; status: string; campaignId: string | null; engineJobId: string | null } | null;
  classification: { state: string; reasons: string[]; confidence: number } | null;
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
    classification: { state: string; reasons: string[]; confidence: number; classifierVersion: string } | null;
    revisionId: string | null;
    campaignId: string | null;
    campaignName: string | null;
    conditionId: string | null;
    solvedAt: string | null;
    updatedAt: string;
  };
  attempts: PointStoryAttempt[];
  interruptions: PointStoryInterruption[];
  closure: { campaignId: string; campaignName: string | null; conditionId: string; openAirfoils: number; totalAirfoils: number } | null;
}

// ---------------------------------------------------------------------------
// Filter ⇄ URL query-param round-trip. Filters live in the URL (replace
// semantics, same single-source-of-truth rule as ?section/?tab). Default
// values are OMITTED from the URL so plain ?section=queue&tab=points stays
// canonical.
// ---------------------------------------------------------------------------
export interface PointFilters {
  status: PointStatusChip;
  airfoil: string;
  campaignId: string;
  regime: "" | "rans" | "urans";
  errorClass: "" | PointErrorClass;
  reynolds: string; // keep as string: '' = any; URL/select round-trip value
}

export const DEFAULT_POINT_FILTERS: PointFilters = {
  status: "all",
  airfoil: "",
  campaignId: "",
  regime: "",
  errorClass: "",
  reynolds: "",
};

/** Parse the point filters out of a location.search string (extra params are
 *  ignored; malformed values fall back to defaults — the URL is user input). */
export function parsePointFilters(search: string): PointFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const status = params.get("pstatus") ?? "all";
  const regime = params.get("pregime") ?? "";
  const errorClass = params.get("perr") ?? "";
  const reynolds = params.get("pre") ?? "";
  return {
    status: (POINT_STATUS_CHIPS as readonly string[]).includes(status) ? (status as PointStatusChip) : "all",
    airfoil: params.get("pairfoil") ?? "",
    campaignId: params.get("pcampaign") ?? "",
    regime: regime === "rans" || regime === "urans" ? regime : "",
    errorClass: (POINT_ERROR_CLASSES as readonly string[]).includes(errorClass) ? (errorClass as PointErrorClass) : "",
    reynolds: /^\d+$/.test(reynolds) ? reynolds : "",
  };
}

/** Merge the filters into an existing search string (preserving foreign params
 *  like ?section/?tab) and return the canonical `?…` string ('' when empty). */
export function pointFiltersToSearch(search: string, filters: PointFilters): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
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
  const s = params.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Client mirror of the server's single bucket expression (BUCKET_SQL in
// packages/db point-history): used to keep the story-panel header chips
// truthful once the authoritative story payload has loaded (e.g. after
// jumping from a derived mirror to its +α source point).
// ---------------------------------------------------------------------------
export function bucketOfPoint(status: string, classificationState: string | null): string {
  if (status === "failed") return "failed";
  if (status === "pending" || status === "queued" || status === "running") return "solving";
  if (status === "done" && classificationState === "rejected") return "rejected";
  if (status === "done" && classificationState === "needs_urans") return "needs_urans";
  if (status === "done" && classificationState === "accepted") return "accepted";
  return "other";
}

// ---------------------------------------------------------------------------
// STORY digest: one line per table row summarizing the attempt chain, e.g.
//   "RANS ✗ → URANS ⏱ timeout ×3"
//   "RANS ✗ → URANS ✓ steady (no shedding)"
//   "derived by symmetry — mirror of +4°"
// Consecutive identical steps collapse into ×N. Honest fallbacks when there
// are no attempt records (pre-attempt-era rows, still-queued backlog).
// ---------------------------------------------------------------------------
const isTimeout = (error: string | null): boolean => !!error && /time[d]?\s*out|timeout/i.test(error);

function digestStep(e: PointAttemptDigestEvent): string {
  const regime = e.regime === "urans" ? "URANS" : e.regime === "rans" ? "RANS" : "solve";
  if (e.error) return isTimeout(e.error) ? `${regime} ⏱ timeout` : `${regime} ✗ ${shortErrorLabel(e.error)}`;
  if (e.validForPolar) {
    if (e.regime === "urans") {
      return e.unsteady && e.strouhal != null ? `${regime} ✓ shedding` : `${regime} ✓ steady (no shedding)`;
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

export function buildStoryDigest(item: Pick<PointHistoryItem, "kind" | "status" | "bucket" | "attemptDigest" | "attemptCount" | "sourceAoaDeg">): string {
  if (item.kind === "derived") {
    const src = item.sourceAoaDeg != null ? ` — mirror of ${item.sourceAoaDeg > 0 ? "+" : ""}${item.sourceAoaDeg}°` : "";
    return `derived by symmetry${src}`;
  }
  if (item.attemptDigest.length === 0) {
    if (item.status === "running") return "solving — no attempts recorded yet";
    if (item.status === "queued" || item.status === "pending") return "queued — not attempted yet";
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
  let chain = steps.map((s) => (s.n > 1 ? `${s.label} ×${s.n}` : s.label)).join(" → ");
  if (item.attemptCount > item.attemptDigest.length) chain += ` (+${item.attemptCount - item.attemptDigest.length} more)`;
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
  const regime = a.regime === "urans" ? "URANS" : a.regime === "rans" ? "RANS" : "solve";
  if (a.error) return isTimeout(a.error) ? `${regime} attempt — timeout` : `${regime} attempt — failed`;
  if (a.validForPolar) {
    if (a.regime === "urans") return a.unsteady && a.strouhal != null ? `${regime} attempt — valid, shedding measured` : `${regime} attempt — valid, steady (no shedding)`;
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
  timed.sort((x, y) => new Date(x.at ?? 0).getTime() - new Date(y.at ?? 0).getTime());

  const events = [...timed];
  const cls = story.point.classification;
  if (cls) {
    const tone: TimelineTone = cls.state === "accepted" ? "teal" : cls.state === "rejected" ? "red" : "amber";
    events.push({
      kind: "classification",
      at: null,
      tone,
      title: `classified ${cls.state.replaceAll("_", " ")} (confidence ${Math.round(cls.confidence * 100)}%)`,
      detail: cls.reasons.length ? cls.reasons.join(", ") : null,
      whyLines: [],
    });
  }

  const bucketTone: TimelineTone =
    story.point.status === "failed" ? "red" : cls?.state === "rejected" ? "red" : story.point.status === "done" ? "teal" : "amber";
  const evidence = `${story.attempts.length} attempt${story.attempts.length === 1 ? "" : "s"}${
    story.interruptions.length ? ` · ${story.interruptions.length} interruption${story.interruptions.length === 1 ? "" : "s"}` : ""
  }`;
  const closureLine = story.closure
    ? `this angle open for ${story.closure.openAirfoils} of ${story.closure.totalAirfoils} airfoils in this condition`
    : null;
  events.push({
    kind: "now",
    at: story.point.updatedAt,
    tone: bucketTone,
    title: `NOW: ${story.point.status}${cls ? ` · ${cls.state.replaceAll("_", " ")}` : ""}`,
    detail: [evidence, closureLine].filter(Boolean).join(" — "),
    whyLines: story.point.qualityWarnings,
  });
  return events;
}
