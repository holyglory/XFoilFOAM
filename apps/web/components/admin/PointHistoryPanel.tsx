"use client";

// Point History Explorer (Solver ▸ Points tab, approved mockups 268e8b16).
// Screen 1: a global filterable point table (campaigns + background) —
// status-count chips as click-filters, airfoil search, campaign / regime /
// error-class / Re dropdowns, keyset "load more" pagination, newest activity
// first. Screen 2: an in-place story side panel (row click; Escape/outside
// click closes) with the chronological attempt timeline, interruptions,
// classification verdicts, the NOW node, single-point requeue, the existing
// SimModal for stored solver results, and the pinned-revision detail link.
//
// Filters live in the URL (replace semantics — the admin console's single
// source of truth rule); the pure param round-trip + digest + timeline
// builders live in lib/point-history (unit-tested, no React).

import type { FieldId } from "@aerodb/core";
import type { Point, SimulationDetail } from "@aerodb/core";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { getPointHistory, getPointStory, isAdminApiError, requeuePoint } from "@/lib/admin";
import { getSim } from "@/lib/api";
import { airfoilDetailHref } from "@/lib/detail-links";
import {
  assembleTimeline,
  bucketOfPoint,
  buildStoryDigest,
  DEFAULT_POINT_FILTERS,
  parsePointFilters,
  type PointFilters,
  type PointHistoryCounts,
  type PointHistoryFacets,
  type PointHistoryItem,
  pointFiltersToSearch,
  type PointStoryPayload,
  POINT_ERROR_CLASSES,
  POINT_STATUS_CHIPS,
  type TimelineTone,
} from "@/lib/point-history";
import { C, MONO } from "@/lib/tokens";
import { ago, f, formatRe } from "./campaigns/ui";
import { SimModal } from "../detail/SimModal";

const PAGE_LIMIT = 50;
const EMPTY_CONTOUR: Point[] = [];
const PANEL_WIDTH = 520;

const smallBtn: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "4px 9px",
  cursor: "pointer",
};

const selectStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10.5,
  color: C.text,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "5px 7px",
  maxWidth: 190,
};

const toneColor = (tone: TimelineTone): string =>
  tone === "teal" ? C.teal : tone === "amber" ? C.amber : tone === "red" ? C.redText : C.dim;

function statusChipStyle(active: boolean, tone: "teal" | "amber" | "red" | "muted"): CSSProperties {
  const color = tone === "teal" ? C.teal : tone === "amber" ? C.amber : tone === "red" ? C.redText : C.muted;
  return {
    fontFamily: MONO,
    fontSize: 10,
    color: active ? color : C.muted,
    background: active ? C.tealFill : C.panel3,
    border: `1px solid ${active ? C.tealBorder : C.stroke}`,
    borderRadius: 999,
    padding: "4px 10px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

const CHIP_TONES: Record<string, "teal" | "amber" | "red" | "muted"> = {
  all: "muted",
  failed: "red",
  rejected: "red",
  accepted: "teal",
  needs_urans: "amber",
  solving: "amber",
};

const CHIP_LABELS: Record<string, string> = {
  all: "all",
  failed: "failed",
  rejected: "rejected",
  accepted: "accepted",
  needs_urans: "needs URANS",
  solving: "solving",
};

function rowStatusChip(item: PointHistoryItem) {
  const label =
    item.kind === "derived" ? "derived" : item.bucket === "other" ? item.status : CHIP_LABELS[item.bucket] ?? item.status;
  const tone =
    item.kind === "derived" ? C.dim : item.bucket === "failed" || item.bucket === "rejected" ? C.redText : item.bucket === "accepted" ? C.teal : item.bucket === "solving" || item.bucket === "needs_urans" ? C.amber : C.muted;
  return (
    <span style={{ fontFamily: MONO, fontSize: 9, color: tone, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 7px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function classificationChip(item: PointHistoryItem) {
  if (item.kind === "derived") {
    const src = item.sourceAoaDeg != null ? `mirror of ${item.sourceAoaDeg > 0 ? "+" : ""}${item.sourceAoaDeg}°` : "mirror";
    return <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 7px", whiteSpace: "nowrap" }}>{src}</span>;
  }
  const state = item.classificationState;
  const color = state === "accepted" ? C.teal : state === "needs_urans" ? C.amber : state === "rejected" ? C.redText : C.dim;
  return (
    <span style={{ fontFamily: MONO, fontSize: 9, color, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 7px", whiteSpace: "nowrap" }}>
      {state ? state.replaceAll("_", " ") : "unclassified"}
    </span>
  );
}

const ROW_COLUMNS = "minmax(0, 1.3fr) 46px 74px 86px minmax(80px, 0.8fr) minmax(0, 1.6fr) 40px 74px";

export function PointHistoryPanel() {
  const pathname = usePathname();
  const [filters, setFilters] = useState<PointFilters>(() =>
    typeof window === "undefined" ? DEFAULT_POINT_FILTERS : parsePointFilters(window.location.search),
  );
  const [items, setItems] = useState<PointHistoryItem[]>([]);
  const [counts, setCounts] = useState<PointHistoryCounts | null>(null);
  const [facets, setFacets] = useState<PointHistoryFacets | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Story side panel state.
  const [openItem, setOpenItem] = useState<PointHistoryItem | null>(null);
  const [story, setStory] = useState<PointStoryPayload | null>(null);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [requeueBusy, setRequeueBusy] = useState(false);
  const [requeueNotice, setRequeueNotice] = useState<string | null>(null);
  // SimModal state (same wiring as SolvedPointsPopover).
  const [simOpen, setSimOpen] = useState(false);
  const [sim, setSim] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [playing, setPlaying] = useState(true);
  const storyPanelRef = useRef<HTMLDivElement>(null);
  const openItemRef = useRef<PointHistoryItem | null>(null);
  openItemRef.current = openItem;
  const simOpenRef = useRef(false);
  simOpenRef.current = simOpen;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Monotonic fetch token: every first-page fetch bumps it, and any response
  // (first-page OR load-more) whose token is stale is dropped — out-of-order
  // network completions must never render a previous filter's rows/counts.
  const requestSeqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const fetchFirstPage = useCallback(async (f: PointFilters) => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await getPointHistory({ ...f, limit: PAGE_LIMIT, facets: true });
      if (seq !== requestSeqRef.current) return; // stale response — a newer filter fetch superseded it
      setItems(page.items);
      setCounts(page.counts);
      if (page.facets) setFacets(page.facets);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError((e as Error).message);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFirstPage(filtersRef.current);
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, [fetchFirstPage]);

  const applyFilters = useCallback(
    (next: PointFilters, opts?: { debounceMs?: number }) => {
      setFilters(next);
      // Replace-semantics URL update (single-source-of-truth params; no
      // history entry per keystroke/chip click).
      const searchAfter = pointFiltersToSearch(window.location.search, next);
      if (searchAfter !== (window.location.search || "")) {
        window.history.replaceState(null, "", `${pathname}${searchAfter}`);
      }
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (opts?.debounceMs) {
        // Text input: one fetch per typing pause, not one per keystroke (the
        // counts aggregate is a full scan server-side).
        debounceRef.current = window.setTimeout(() => {
          debounceRef.current = null;
          void fetchFirstPage(next);
        }, opts.debounceMs);
      } else {
        void fetchFirstPage(next);
      }
    },
    [pathname, fetchFirstPage],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const page = await getPointHistory({ ...filtersRef.current, cursor: nextCursor, limit: PAGE_LIMIT });
      if (seq !== requestSeqRef.current) return; // filters changed while this page was in flight
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.rowKey));
        return [...prev, ...page.items.filter((i) => !seen.has(i.rowKey))];
      });
      setCounts(page.counts);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  // ---- story side panel plumbing ----
  const openStory = useCallback((item: PointHistoryItem) => {
    setOpenItem(item);
    setStory(null);
    setStoryError(null);
    setRequeueNotice(null);
    getPointStory(item.resultId)
      .then((s) => {
        if (openItemRef.current?.rowKey === item.rowKey) setStory(s);
      })
      .catch((e) => {
        if (openItemRef.current?.rowKey === item.rowKey) setStoryError((e as Error).message);
      });
  }, []);

  const closeStory = useCallback(() => {
    setOpenItem(null);
    setStory(null);
    setStoryError(null);
    setSimOpen(false);
    setSim(null);
    setSimMessage(null);
  }, []);

  // Escape: SimModal open → back to the story panel; else close the panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !openItemRef.current) return;
      e.stopPropagation();
      if (simOpenRef.current) {
        setSimOpen(false);
        setSim(null);
        setSimMessage(null);
      } else {
        closeStory();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeStory]);

  // Outside click closes the story panel (suspended while the SimModal is up).
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!openItemRef.current || simOpenRef.current) return;
      const panel = storyPanelRef.current;
      if (panel && e.target instanceof Node && !panel.contains(e.target)) closeStory();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [closeStory]);

  // "solver results ▸": fetch the stored result via the existing sim endpoint
  // (resultId wins server-side) and open the existing SimModal in place.
  const openSolverResults = useCallback(() => {
    const item = openItemRef.current;
    if (!item) return;
    setSimOpen(true);
    setSim(null);
    setSimMessage(null);
    setPlaying(true);
    getSim(item.airfoilSlug, item.reynolds ?? 0, item.kind === "derived" ? (item.sourceAoaDeg ?? item.aoaDeg) : item.aoaDeg, item.resultId)
      .then((d) => {
        if (!simOpenRef.current) return;
        setSim(d);
        setSimField((current) => {
          if (d.status !== "solved" || d.availableFields.length === 0 || d.availableFields.includes(current)) return current;
          return d.availableFields[0];
        });
      })
      .catch((e) => {
        if (!simOpenRef.current) return;
        setSimMessage(`Could not load the stored OpenFOAM result (${(e as Error).message}).`);
      });
  }, []);

  const requeueEligible =
    story != null &&
    story.point.status !== "derived" &&
    (story.point.status === "failed" || (story.point.status === "done" && story.point.classification?.state === "rejected"));

  const doRequeue = useCallback(async () => {
    const item = openItemRef.current;
    if (!item || requeueBusy) return;
    if (!window.confirm(`Requeue this point (${item.airfoilName} α ${item.aoaDeg}°)? Its failed/rejected evidence returns to the solve queue.`)) return;
    setRequeueBusy(true);
    setRequeueNotice(null);
    try {
      const res = await requeuePoint(item.resultId);
      setRequeueNotice(`requeued (${res.scope}) — the point is back in the queue`);
      // Refresh both surfaces the action changed: story + table page 1.
      openStory(item);
      void fetchFirstPage(filtersRef.current);
    } catch (e) {
      setRequeueNotice(isAdminApiError(e) ? e.message : (e as Error).message);
    } finally {
      setRequeueBusy(false);
    }
  }, [requeueBusy, openStory, fetchFirstPage]);

  const chipCount = (k: string): number | null => {
    if (!counts) return null;
    if (k === "all") return counts.all;
    return counts[k as keyof PointHistoryCounts] ?? null;
  };

  const timeline = story ? assembleTimeline(story) : [];

  // Header chips truthfulness: once the authoritative story payload is in,
  // status/class chips reflect IT (the table row snapshot may be stale — e.g.
  // the "open source point" fallback synthesizes an item before the source's
  // real status is known). A synthesized fallback (kind 'result' but still
  // carrying the derived row's status) shows NO status/class chips until the
  // story answers — never a wrong "derived" chip on a real result.
  const storyMatchesOpen = story != null && openItem != null && openItem.kind === "result" && story.point.resultId === openItem.resultId;
  const headerItem: PointHistoryItem | null =
    openItem == null
      ? null
      : storyMatchesOpen
        ? {
            ...openItem,
            status: story.point.status,
            bucket: bucketOfPoint(story.point.status, story.point.classification?.state ?? null),
            classificationState: story.point.classification?.state ?? null,
          }
        : openItem;
  const headerChipsPending = openItem != null && openItem.kind === "result" && openItem.status === "derived" && !storyMatchesOpen;

  return (
    <div data-testid="point-history-panel" style={{ display: "grid", gap: 12 }}>
      {/* ---- filter bar ---- */}
      <section style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {POINT_STATUS_CHIPS.map((k) => (
            <button
              key={k}
              type="button"
              data-testid={`points-chip-${k}`}
              aria-pressed={filters.status === k}
              onClick={() => applyFilters({ ...filters, status: k })}
              style={statusChipStyle(filters.status === k, CHIP_TONES[k])}
            >
              {CHIP_LABELS[k]}
              {chipCount(k) != null ? ` ${chipCount(k)!.toLocaleString()}` : ""}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="search"
            data-testid="points-filter-airfoil"
            placeholder="filter by airfoil…"
            value={filters.airfoil}
            onChange={(e) => applyFilters({ ...filters, airfoil: e.target.value }, { debounceMs: 300 })}
            style={{ ...selectStyle, width: 180 }}
          />
          <select
            data-testid="points-filter-campaign"
            value={filters.campaignId}
            onChange={(e) => applyFilters({ ...filters, campaignId: e.target.value })}
            style={selectStyle}
          >
            <option value="">campaign: any</option>
            {/* The facet list caps at the 50 newest campaigns; a URL-provided
                campaign outside that list must still DISPLAY as active. */}
            {filters.campaignId && !(facets?.campaigns ?? []).some((c) => c.id === filters.campaignId) && (
              <option value={filters.campaignId}>campaign: {filters.campaignId.slice(0, 8)}…</option>
            )}
            {(facets?.campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            data-testid="points-filter-regime"
            value={filters.regime}
            onChange={(e) => applyFilters({ ...filters, regime: e.target.value as PointFilters["regime"] })}
            style={selectStyle}
          >
            <option value="">regime: any</option>
            <option value="rans">RANS</option>
            <option value="urans">URANS</option>
          </select>
          <select
            data-testid="points-filter-errclass"
            value={filters.errorClass}
            onChange={(e) => applyFilters({ ...filters, errorClass: e.target.value as PointFilters["errorClass"] })}
            style={selectStyle}
          >
            <option value="">error class: any</option>
            {POINT_ERROR_CLASSES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            data-testid="points-filter-re"
            value={filters.reynolds}
            onChange={(e) => applyFilters({ ...filters, reynolds: e.target.value })}
            style={selectStyle}
          >
            <option value="">Re: any</option>
            {(facets?.reynolds ?? []).map((re) => (
              <option key={re} value={String(re)}>
                Re {formatRe(re)}
              </option>
            ))}
          </select>
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim }}>sorted by last activity</span>
          <button type="button" data-testid="points-refresh" disabled={loading} onClick={() => void fetchFirstPage(filters)} style={{ ...smallBtn, marginLeft: "auto", opacity: loading ? 0.6 : 1 }}>
            {loading ? "loading…" : "refresh"}
          </button>
        </div>
      </section>

      {error && (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.redText }}>
          {error}
          <button type="button" onClick={() => void fetchFirstPage(filters)} style={{ ...smallBtn, marginLeft: 8 }}>
            retry
          </button>
        </div>
      )}

      {/* ---- table ---- */}
      <section style={{ background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 760 }}>
            <div style={{ display: "grid", gridTemplateColumns: ROW_COLUMNS, gap: 8, padding: "8px 12px", borderBottom: `1px solid ${C.borderSoft}`, fontFamily: MONO, fontSize: 9, color: C.dim }}>
              <span>Airfoil</span>
              <span style={{ textAlign: "right" }}>α</span>
              <span>Re</span>
              <span>Status</span>
              <span>Class</span>
              <span>Story</span>
              <span style={{ textAlign: "right" }}>Att.</span>
              <span style={{ textAlign: "right" }}>Activity</span>
            </div>
            {!loading && items.length === 0 && !error && (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, padding: "16px 12px" }}>
                No points match these filters.
              </div>
            )}
            {loading && items.length === 0 && (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, padding: "16px 12px" }}>Loading points…</div>
            )}
            {items.map((item) => (
              <button
                key={item.rowKey}
                type="button"
                data-testid="point-history-row"
                onClick={() => openStory(item)}
                style={{
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns: ROW_COLUMNS,
                  gap: 8,
                  alignItems: "center",
                  textAlign: "left",
                  fontFamily: MONO,
                  fontSize: 10.5,
                  padding: "8px 12px",
                  background: openItem?.rowKey === item.rowKey ? C.rowActive : "transparent",
                  border: "none",
                  borderBottom: `1px solid ${C.borderRow}`,
                  cursor: "pointer",
                  color: C.text,
                }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{item.airfoilName}</span>
                <span style={{ textAlign: "right" }}>{f(item.aoaDeg, 1)}°</span>
                <span style={{ color: C.muted }}>{item.reynolds != null ? formatRe(item.reynolds) : "—"}</span>
                <span>{rowStatusChip(item)}</span>
                <span>{classificationChip(item)}</span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.muted }} title={buildStoryDigest(item)}>
                  {buildStoryDigest(item)}
                </span>
                <span style={{ textAlign: "right", color: C.muted }}>{item.kind === "derived" ? "—" : item.attemptCount}</span>
                <span style={{ textAlign: "right", color: C.dim, fontSize: 9.5 }}>{ago(item.lastActivityAt)}</span>
              </button>
            ))}
          </div>
        </div>
        {nextCursor && !error && (
          <div style={{ padding: "9px 12px" }}>
            <button type="button" data-testid="points-load-more" disabled={loadingMore} onClick={() => void loadMore()} style={{ ...smallBtn, width: "100%", opacity: loadingMore ? 0.6 : 1 }}>
              {loadingMore ? "loading…" : "load more"}
            </button>
          </div>
        )}
      </section>

      {/* ---- story side panel (screen 2) ---- */}
      {openItem && (
        <div
          ref={storyPanelRef}
          data-testid="point-story-panel"
          role="dialog"
          aria-label="Point story"
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 40,
            width: `min(${PANEL_WIDTH}px, calc(100vw - 24px))`,
            background: C.popover,
            borderLeft: `1px solid ${C.stroke}`,
            boxShadow: `-18px 0 50px ${C.shadow}`,
            display: "grid",
            gridTemplateRows: "auto 1fr",
            overflow: "hidden",
          }}
        >
          {/* header */}
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.borderSoft}`, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {openItem.airfoilName} · α {f(openItem.aoaDeg, 2)}°
              </span>
              <button type="button" aria-label="Close point story" onClick={closeStory} style={{ ...smallBtn, marginLeft: "auto" }}>
                ×
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {openItem.reynolds != null && (
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 7px" }}>
                  Re {formatRe(openItem.reynolds)}
                </span>
              )}
              {openItem.regime && (
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 7px" }}>
                  {openItem.regime.toUpperCase()}
                </span>
              )}
              {openItem.campaignName && (
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "2px 7px", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {openItem.campaignName}
                </span>
              )}
              {!headerChipsPending && headerItem && rowStatusChip(headerItem)}
              {!headerChipsPending && headerItem && classificationChip(headerItem)}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                data-testid="point-requeue"
                disabled={!requeueEligible || requeueBusy}
                title={requeueEligible ? "Reset this point's failed/rejected evidence back to the solve queue" : "Only failed or rejected points can be requeued"}
                onClick={() => void doRequeue()}
                style={{
                  ...smallBtn,
                  color: requeueEligible ? C.redText : C.dimmest,
                  borderColor: requeueEligible ? "rgba(245, 101, 101, 0.4)" : C.stroke,
                  opacity: requeueBusy ? 0.6 : 1,
                  cursor: requeueEligible ? "pointer" : "not-allowed",
                }}
              >
                {requeueBusy ? "requeueing…" : "requeue point"}
              </button>
              <button type="button" data-testid="point-solver-results" onClick={openSolverResults} style={{ ...smallBtn, color: C.teal, borderColor: C.tealBorder }}>
                solver results ▸
              </button>
              <Link
                href={airfoilDetailHref(openItem.airfoilSlug, openItem.revisionId)}
                data-testid="point-detail-link"
                style={{ ...smallBtn, color: C.teal, borderColor: C.tealBorder, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
              >
                detail page ↗
              </Link>
            </div>
            {requeueNotice && <div style={{ fontFamily: MONO, fontSize: 10, color: C.amber }}>{requeueNotice}</div>}
          </div>

          {/* body */}
          <div style={{ overflowY: "auto", minHeight: 0, padding: "12px 14px", display: "grid", gap: 10, alignContent: "start" }}>
            {openItem.kind === "derived" ? (
              // Derived mirrors have no solve timeline of their own — honest
              // pointer to the +α source evidence instead.
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
                This −α point is <span style={{ color: C.text }}>derived by symmetry</span> from the solved{" "}
                <span style={{ color: C.text }}>
                  α {openItem.sourceAoaDeg != null ? `${openItem.sourceAoaDeg > 0 ? "+" : ""}${openItem.sourceAoaDeg}°` : "source"}
                </span>{" "}
                result of the same symmetric airfoil. It has no solver timeline of its own.
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    data-testid="point-open-source"
                    onClick={() => {
                      const src = items.find((i) => i.kind === "result" && i.resultId === openItem.resultId);
                      openStory(
                        src ?? {
                          ...openItem,
                          kind: "result",
                          rowKey: `r:${openItem.resultId}`,
                          aoaDeg: openItem.sourceAoaDeg ?? openItem.aoaDeg,
                          sourceAoaDeg: null,
                        },
                      );
                    }}
                    style={{ ...smallBtn, color: C.teal, borderColor: C.tealBorder }}
                  >
                    open source point α {openItem.sourceAoaDeg != null ? `${openItem.sourceAoaDeg > 0 ? "+" : ""}${openItem.sourceAoaDeg}` : ""}° ▸
                  </button>
                </div>
              </div>
            ) : storyError ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.redText, lineHeight: 1.5 }}>
                {storyError}
                <button type="button" onClick={() => openStory(openItem)} style={{ ...smallBtn, marginLeft: 8 }}>
                  retry
                </button>
              </div>
            ) : !story ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>Loading point story…</div>
            ) : (
              <>
                <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, letterSpacing: "0.08em" }}>TIMELINE</div>
                {timeline.map((ev, i) => (
                  <div key={i} data-testid={`timeline-${ev.kind}`} style={{ display: "grid", gridTemplateColumns: "14px 1fr", gap: 10 }}>
                    <div style={{ display: "grid", justifyItems: "center", gridTemplateRows: "14px 1fr", gap: 2 }}>
                      <span style={{ width: 8, height: 8, marginTop: 3, borderRadius: "50%", background: toneColor(ev.tone) }} />
                      {i < timeline.length - 1 && <span style={{ width: 1, background: C.borderRule, minHeight: 10 }} />}
                    </div>
                    <div style={{ display: "grid", gap: 3, paddingBottom: 8, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: toneColor(ev.tone), fontWeight: ev.kind === "now" ? 700 : 600 }}>
                          {ev.title}
                        </span>
                        {ev.at && <span style={{ fontFamily: MONO, fontSize: 9, color: C.dimmer }}>{ago(ev.at)}</span>}
                        {ev.kind === "attempt" && ev.attempt?.simJob && (
                          <span style={{ fontFamily: MONO, fontSize: 8.5, color: C.dim, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "1px 6px" }}>
                            wave {ev.attempt.simJob.wave} · {ev.attempt.simJob.jobKind}
                            {ev.attempt.simJob.campaignId ? " · campaign" : " · background"}
                          </span>
                        )}
                      </div>
                      {ev.detail && (
                        <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.muted, lineHeight: 1.5, overflowWrap: "anywhere" }}>{ev.detail}</div>
                      )}
                      {ev.whyLines.map((w) => (
                        <div key={w} style={{ fontFamily: MONO, fontSize: 9.5, color: C.amber, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                          ⚠ {w}
                        </div>
                      ))}
                      {ev.kind === "attempt" && ev.attempt?.classification && (
                        <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>
                          attempt verdict: {ev.attempt.classification.state.replaceAll("_", " ")}
                          {ev.attempt.classification.reasons.length ? ` — ${ev.attempt.classification.reasons.join(", ")}` : ""}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {timeline.length === 1 && (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, lineHeight: 1.5 }}>
                    No attempt records for this point yet — evidence appears here as the solver reports it.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ---- SimModal (existing viewer, opened in place) ---- */}
      {simOpen && openItem && (
        <SimModal
          open
          ctx={{
            re: openItem.reynolds ?? 0,
            aoa: openItem.kind === "derived" ? (openItem.sourceAoaDeg ?? openItem.aoaDeg) : openItem.aoaDeg,
            resultId: openItem.resultId,
            mirrored: false,
          }}
          sim={sim}
          name={openItem.airfoilName}
          machStr="—"
          contour={EMPTY_CONTOUR}
          field={simField}
          onField={setSimField}
          track={[]}
          onTrackPoint={() => undefined}
          playing={playing}
          onTogglePlay={() => setPlaying((p) => !p)}
          onClose={() => {
            setSimOpen(false);
            setSim(null);
            setSimMessage(null);
          }}
          unavailableMessage={simMessage}
        />
      )}
    </div>
  );
}
