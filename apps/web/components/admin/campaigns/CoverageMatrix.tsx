"use client";

// Campaign coverage matrix (spec §11, approved mockup 1ed4374f; recolored per
// amendment A / design c19fd74a): virtualized airfoil rows over the keyset
// /airfoils pages with per-airfoil SEGMENTED BARS — one flex segment per
// condition (2px gap), teal fill = accepted result coverage, VIOLET overlay =
// awaiting FAST URANS (calm stage-2 queue), solid RED = critical unavailable
// evidence, empty = panel background (legacy payloads without the split keep
// the amber rejected overlay). The per-condition column headers are
// gone: a slim AIRFOIL | DONE | CONDITIONS legend row sits above and the
// hover tooltip + cell side panel carry the identification. Click on a
// segment opens the existing cell side panel (same onCellClick contract).
// Search, failed-first sort, "Show released (N)" and keyset paging/poll
// refresh are unchanged. The bar flexes inside the row, so there is NO
// horizontal overflow at any condition count or viewport; when segments
// would drop under MIN_SEGMENT_PX the matrix groups conditions by chord
// behind selector chips (see coverage-segments.ts). All counts are real
// counters from sim_campaign_progress — nothing is invented.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AdminCampaignAirfoilRow,
  type AdminCampaignConditionSummary,
  type CampaignProgressTotals,
  getCampaignAirfoils,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { conditionDisplayState } from "./ConditionStrip";
import {
  SEGMENT_GAP_PX,
  groupConditionsByChord,
  needsChordGrouping,
  rowDoneFraction,
  segmentFillHeight,
  segmentTitle,
  segmentView,
  segmentWorkflowFillHeight,
} from "./coverage-segments";
import { fCount, ghostBtn, inputStyle } from "./ui";

const PAGE_LIMIT = 50;
const ROW_H = 30; // 16px bar + 7px breathing top/bottom (mockup .cov)
const BAR_H = 16;
const VIEWPORT_H = 520;
const OVERSCAN = 6;
const FRAC_COL = 64;
const COL_GAP = 10;
const ROW_PAD_X = 12;

interface PageState {
  cursor: string | null; // cursor USED to fetch this page
  rows: AdminCampaignAirfoilRow[];
}

/** Attention weight for the critical-first sort. Failed solver/setup outcomes
 * remain unavailable evidence, not human coefficient-review assignments. */
function rowBlocked(row: AdminCampaignAirfoilRow): number {
  return row.perCondition.reduce(
    (s, c) => s + c.failed + (c.blocked ?? 0) + (c.needsReview ?? 0),
    0,
  );
}

interface HoverTip {
  key: string; // `${slug}:${conditionId}`
  label: string;
  failed: boolean;
  x: number;
  y: number;
}

export function CoverageMatrix({
  campaignId,
  conditions,
  airfoilCount,
  pollKey,
  onCellClick,
}: {
  campaignId: string;
  conditions: AdminCampaignConditionSummary[];
  airfoilCount: number;
  pollKey: number;
  onCellClick: (
    row: AdminCampaignAirfoilRow,
    condition: AdminCampaignConditionSummary,
    cell: CampaignProgressTotals | null,
  ) => void;
}) {
  const [pages, setPages] = useState<PageState[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [blockedFirst, setBlockedFirst] = useState(true);
  const [showReleased, setShowReleased] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [rootWidth, setRootWidth] = useState(1024);
  const [selectedChordKey, setSelectedChordKey] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverTip | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  // Measured root width drives the fixed name column (170–220px) and the
  // chord-grouping threshold — no matchMedia, no horizontal overflow. The
  // window-resize listener is a fallback for environments that throttle
  // ResizeObserver delivery (e.g. hidden/background tabs).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setRootWidth(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await getCampaignAirfoils(campaignId, null, PAGE_LIMIT);
      setPages([{ cursor: null, rows: page.items }]);
      setNextCursor(page.nextCursor);
      setExhausted(page.nextCursor == null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || nextCursor == null) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await getCampaignAirfoils(
        campaignId,
        nextCursor,
        PAGE_LIMIT,
      );
      setPages((prev) => [...prev, { cursor: nextCursor, rows: page.items }]);
      setNextCursor(page.nextCursor);
      setExhausted(page.nextCursor == null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [campaignId, nextCursor]);

  // Poll refresh (spec §10): refetch only the pages intersecting the current
  // viewport, using their original keyset cursors.
  const visiblePagesRef = useRef<Set<number>>(new Set([0]));
  useEffect(() => {
    if (pollKey === 0 || pages.length === 0) return;
    const targets = [...visiblePagesRef.current].filter(
      (i) => i < pages.length,
    );
    if (targets.length === 0) targets.push(0);
    let cancelled = false;
    void Promise.all(
      targets.map(async (i) => {
        const refreshed = await getCampaignAirfoils(
          campaignId,
          pages[i].cursor,
          PAGE_LIMIT,
        ).catch(() => null);
        return { i, refreshed };
      }),
    ).then((updates) => {
      if (cancelled) return;
      setPages((prev) => {
        const next = [...prev];
        for (const { i, refreshed } of updates) {
          if (refreshed && next[i])
            next[i] = { cursor: next[i].cursor, rows: refreshed.items };
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollKey]);

  const pageOfSlug = useMemo(() => {
    const map = new Map<string, number>();
    pages.forEach((p, i) => p.rows.forEach((r) => map.set(r.slug, i)));
    return map;
  }, [pages]);

  const loadedRows = useMemo(() => pages.flatMap((p) => p.rows), [pages]);

  const releasedConditions = conditions.filter((c) => c.status === "released");
  const visibleConditions = useMemo(
    () => conditions.filter((c) => c.status !== "released" || showReleased),
    [conditions, showReleased],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = loadedRows;
    if (q)
      out = out.filter(
        (r) =>
          r.slug.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      );
    if (blockedFirst) {
      out = [...out].sort(
        (a, b) =>
          Number(rowBlocked(b) > 0) - Number(rowBlocked(a) > 0) ||
          a.slug.localeCompare(b.slug),
      );
    }
    return out;
  }, [loadedRows, search, blockedFirst]);

  const cellByCondition = useCallback((row: AdminCampaignAirfoilRow) => {
    const map = new Map<
      string,
      CampaignProgressTotals & { conditionId: string }
    >();
    for (const c of row.perCondition) map.set(c.conditionId, c);
    return map;
  }, []);

  // ---- segmented-bar geometry (mockup grid: name | done | flex bar) ----
  const nameCol = rootWidth >= 720 ? 220 : 170;
  const barWidth = Math.max(
    0,
    rootWidth - 2 * ROW_PAD_X - nameCol - FRAC_COL - 2 * COL_GAP,
  );
  const gridColumns = `${nameCol}px ${FRAC_COL}px minmax(0, 1fr)`;

  // Chord grouping fallback: only when the measured bar cannot give every
  // visible condition MIN_SEGMENT_PX (threshold documented in
  // coverage-segments.ts) AND more than one chord exists to split by.
  const chordGroups = useMemo(
    () => groupConditionsByChord(visibleConditions),
    [visibleConditions],
  );
  const grouped =
    chordGroups.length > 1 &&
    needsChordGrouping(visibleConditions.length, barWidth);
  const activeGroup = grouped
    ? (chordGroups.find((g) => g.key === selectedChordKey) ?? chordGroups[0])
    : null;
  const renderedConditions = activeGroup
    ? activeGroup.conditions
    : visibleConditions;
  const renderedConditionIds = useMemo(
    () => new Set(renderedConditions.map((c) => c.id)),
    [renderedConditions],
  );

  // ---- windowing (constant-height rows) ----
  const totalHeight = rows.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_H / ROW_H) + OVERSCAN * 2;
  const end = Math.min(rows.length, start + visibleCount);

  useEffect(() => {
    const pagesInView = new Set<number>();
    for (let i = start; i < end; i++) {
      const idx = pageOfSlug.get(rows[i]?.slug ?? "");
      if (idx != null) pagesInView.add(idx);
    }
    if (pagesInView.size === 0) pagesInView.add(0);
    visiblePagesRef.current = pagesInView;
  }, [start, end, rows, pageOfSlug]);

  // fetch the next keyset page as the window approaches the loaded tail
  useEffect(() => {
    if (!exhausted && end >= loadedRows.length - OVERSCAN) void loadMore();
  }, [end, loadedRows.length, exhausted, loadMore]);

  const showTip = useCallback(
    (el: HTMLElement, key: string, label: string, failed: boolean) => {
      const r = el.getBoundingClientRect();
      setHover({ key, label, failed, x: r.left + r.width / 2, y: r.top });
    },
    [],
  );
  const hideTip = useCallback(() => setHover(null), []);

  return (
    <div
      ref={rootRef}
      data-testid="campaign-coverage-matrix"
      style={{
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "10px 12px",
          borderBottom: `1px solid ${C.borderSoft}`,
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.1em",
            color: C.dim,
          }}
        >
          COVERAGE
        </span>
        <input
          data-testid="matrix-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search airfoils…"
          aria-label="search airfoils"
          style={{
            ...inputStyle,
            width: 200,
            padding: "6px 9px",
            fontSize: 11,
          }}
        />
        <button
          type="button"
          data-testid="matrix-filter-failed-first"
          onClick={() => setBlockedFirst((v) => !v)}
          style={{
            ...ghostBtn,
            padding: "5px 10px",
            fontSize: 10,
            color: blockedFirst ? C.teal : C.muted,
            borderColor: blockedFirst ? C.tealBorder : C.stroke,
          }}
        >
          critical first
        </button>
        {releasedConditions.length > 0 && (
          <button
            type="button"
            data-testid="matrix-toggle-released"
            onClick={() => setShowReleased((v) => !v)}
            style={{
              ...ghostBtn,
              padding: "5px 10px",
              fontSize: 10,
              color: showReleased ? C.teal : C.muted,
              borderColor: showReleased ? C.tealBorder : C.stroke,
            }}
          >
            {showReleased
              ? `Hide released (${releasedConditions.length})`
              : `Show released (${releasedConditions.length})`}
          </button>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontFamily: MONO,
            fontSize: 10,
            color: C.dim,
          }}
        >
          {fCount(loadedRows.length)}/{fCount(airfoilCount)} airfoils loaded
        </span>
      </div>

      {error && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.red,
            padding: "8px 12px",
          }}
        >
          {error}
        </div>
      )}
      {search.trim() && !exhausted && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: C.amber,
            padding: "6px 12px",
          }}
        >
          search covers the {fCount(loadedRows.length)} loaded rows — scroll the
          matrix to load the rest
        </div>
      )}

      {grouped && (
        <div
          data-testid="matrix-chord-chips"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
            padding: "8px 12px",
            borderBottom: `1px solid ${C.borderSoft}`,
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim }}>
            {fCount(visibleConditions.length)} conditions — grouped by chord,
            one chord per view
          </span>
          {chordGroups.map((g) => {
            const active = g.key === (activeGroup?.key ?? "");
            return (
              <button
                key={g.key}
                type="button"
                data-testid={`matrix-chord-${g.key}`}
                onClick={() => setSelectedChordKey(g.key)}
                style={{
                  ...ghostBtn,
                  padding: "3px 9px",
                  fontSize: 10,
                  color: active ? C.teal : C.muted,
                  borderColor: active ? C.tealBorder : C.stroke,
                }}
              >
                {g.label} · {fCount(g.conditions.length)}
              </button>
            );
          })}
        </div>
      )}

      {/* slim legend row — replaces the per-condition column headers */}
      <div
        data-testid="matrix-legend"
        style={{
          display: "grid",
          gridTemplateColumns: gridColumns,
          gap: COL_GAP,
          alignItems: "center",
          padding: `6px ${ROW_PAD_X}px`,
          borderBottom: `1px solid ${C.borderRow}`,
          fontFamily: MONO,
          fontSize: 9.5,
          color: C.dimmest,
        }}
      >
        <span style={{ letterSpacing: "0.1em" }}>AIRFOIL</span>
        <span style={{ letterSpacing: "0.1em", textAlign: "right" }}>DONE</span>
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          CONDITIONS → fill = accepted results ·{" "}
          <span style={{ color: C.violet }}>violet</span> = awaiting fast URANS
          · <span style={{ color: C.redText }}>red</span> = critical · hover for
          detail · click opens the point flow
        </span>
      </div>

      <div
        data-testid="matrix-scroll"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          setHover(null);
        }}
        style={{
          height: Math.min(VIEWPORT_H, Math.max(ROW_H, totalHeight)),
          overflowY: "auto",
          position: "relative",
        }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          {rows.slice(start, end).map((row, sliceIdx) => {
            const i = start + sliceIdx;
            const byId = cellByCondition(row);
            const frac = rowDoneFraction(row, renderedConditionIds);
            return (
              <div
                key={row.slug}
                data-testid={`matrix-row-${row.slug}`}
                style={{
                  position: "absolute",
                  top: i * ROW_H,
                  left: 0,
                  right: 0,
                  height: ROW_H,
                  boxSizing: "border-box",
                  display: "grid",
                  gridTemplateColumns: gridColumns,
                  gap: COL_GAP,
                  alignItems: "center",
                  padding: `0 ${ROW_PAD_X}px`,
                  borderBottom: `1px solid ${C.borderRow}`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      color: C.text,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.name}
                  </span>
                  {row.isSymmetric && (
                    <span
                      title="symmetric airfoil — negative angles derived"
                      style={{
                        fontFamily: MONO,
                        fontSize: 9,
                        color: C.dim,
                        flex: "0 0 auto",
                      }}
                    >
                      sym
                    </span>
                  )}
                </div>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.dim,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {fCount(frac.done)}/{fCount(frac.total)}
                </span>
                <div
                  style={{
                    display: "flex",
                    gap: SEGMENT_GAP_PX,
                    height: BAR_H,
                    minWidth: 0,
                  }}
                >
                  {renderedConditions.map((c) => {
                    const cell = byId.get(c.id) ?? null;
                    const view = segmentView(cell);
                    const released = c.status === "released";
                    const label = segmentTitle(
                      c,
                      cell,
                      conditionDisplayState(c),
                    );
                    const hoverKey = `${row.slug}:${c.id}`;
                    const fillH = segmentFillHeight(view);
                    const workflowFillH = segmentWorkflowFillHeight(view);
                    // Amendment-A recolor: red strictly for needs-review /
                    // failed; violet = calm awaiting-URANS; amber only for
                    // legacy payloads without the split counters.
                    const red =
                      view.state === "failed" ||
                      view.state === "needs_review" ||
                      view.state === "blocked";
                    const fillColor = red ? C.red : C.teal;
                    const workflowColor =
                      view.state === "awaiting_urans" ? C.violet : C.amber;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        data-testid={`matrix-cell-${row.slug}-${c.ord}`}
                        aria-label={label}
                        onClick={() => onCellClick(row, c, cell)}
                        onMouseEnter={(e) =>
                          showTip(e.currentTarget, hoverKey, label, red)
                        }
                        onMouseLeave={hideTip}
                        onFocus={(e) =>
                          showTip(e.currentTarget, hoverKey, label, red)
                        }
                        onBlur={hideTip}
                        style={{
                          flex: "1 1 0",
                          minWidth: 0,
                          height: BAR_H,
                          position: "relative",
                          overflow: "hidden",
                          borderRadius: 2,
                          border: `1px solid ${C.borderRow}`,
                          background: C.panel3,
                          padding: 0,
                          cursor: "pointer",
                          opacity: released ? 0.55 : 1,
                          outline:
                            hover?.key === hoverKey
                              ? `1px solid ${C.teal}`
                              : undefined,
                        }}
                      >
                        {view.state !== "empty" && fillH > 0 && (
                          <span
                            style={{
                              position: "absolute",
                              left: 0,
                              right: 0,
                              bottom: 0,
                              height: `${fillH * 100}%`,
                              background: fillColor,
                              display: "block",
                            }}
                          />
                        )}
                        {!red && workflowFillH > 0 && (
                          <span
                            data-testid={`matrix-workflow-${row.slug}-${c.ord}`}
                            style={{
                              position: "absolute",
                              left: 0,
                              right: 0,
                              bottom: `${view.fillFraction * 100}%`,
                              height: `${workflowFillH * 100}%`,
                              background: workflowColor,
                              display: "block",
                            }}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "8px 12px",
          borderTop: `1px solid ${C.borderRow}`,
        }}
      >
        {loading && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
            loading rows…
          </span>
        )}
        {!loading && rows.length === 0 && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
            {loadedRows.length === 0
              ? "no airfoils in this campaign"
              : "no loaded airfoil matches the search"}
          </span>
        )}
        {showReleased && releasedConditions.length > 0 && (
          <span
            style={{
              marginLeft: "auto",
              fontFamily: MONO,
              fontSize: 9.5,
              color: C.dim,
            }}
          >
            dimmed — released (solved cells kept)
          </span>
        )}
      </div>

      {hover && (
        <div
          role="tooltip"
          data-testid="matrix-tooltip"
          style={{
            position: "fixed",
            left: hover.x,
            top: hover.y - 6,
            transform: "translate(-50%, -100%)",
            background: C.popover,
            border: `1px solid ${hover.failed ? C.red : C.tealBorder}`,
            borderRadius: 6,
            padding: "5px 8px",
            fontFamily: MONO,
            fontSize: 9.5,
            color: C.text,
            whiteSpace: "nowrap",
            zIndex: 40,
            pointerEvents: "none",
          }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}
