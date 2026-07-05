"use client";

// Campaign coverage matrix (spec §11): virtualized airfoil rows over the
// keyset /airfoils pages, sticky condition headers ≥940, stacked per-row
// segment bars below 940 with tap-to-expand, search + failed-first filter,
// "Show released (N)" toggle, derived-by-symmetry and sync-promise cell
// states, legend only when non-active condition states exist. All counts are
// real counters from sim_campaign_progress — nothing is invented.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type AdminCampaignAirfoilRow,
  type AdminCampaignConditionSummary,
  type CampaignProgressTotals,
  getCampaignAirfoils,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { conditionDisplayState } from "./ConditionStrip";
import { fCount, formatRe, ghostBtn, inputStyle } from "./ui";

const PAGE_LIMIT = 50;
const DESKTOP_ROW_H = 34;
const NARROW_ROW_H = 46;
const EXPANDED_LINE_H = 26;
const VIEWPORT_H = 520;
const OVERSCAN = 6;
const NAME_COL = 220;
const CELL_W = 92;

/** Optional per-cell sync-promise flag: rendered ONLY when the row payload
 *  actually carries it (spec §11 "when the row payload flags it"). */
function syncPromisedCount(cell: CampaignProgressTotals): number {
  const v = (cell as CampaignProgressTotals & { syncPromised?: number }).syncPromised;
  return typeof v === "number" && v > 0 ? v : 0;
}

interface PageState {
  cursor: string | null; // cursor USED to fetch this page
  rows: AdminCampaignAirfoilRow[];
}

function rowFailed(row: AdminCampaignAirfoilRow): number {
  return row.perCondition.reduce((s, c) => s + c.failed, 0);
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
  onCellClick: (row: AdminCampaignAirfoilRow, condition: AdminCampaignConditionSummary, cell: CampaignProgressTotals | null) => void;
}) {
  const [pages, setPages] = useState<PageState[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [failedFirst, setFailedFirst] = useState(true);
  const [showReleased, setShowReleased] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 940px)");
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
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
      const page = await getCampaignAirfoils(campaignId, nextCursor, PAGE_LIMIT);
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
    const targets = [...visiblePagesRef.current].filter((i) => i < pages.length);
    if (targets.length === 0) targets.push(0);
    let cancelled = false;
    void Promise.all(
      targets.map(async (i) => {
        const refreshed = await getCampaignAirfoils(campaignId, pages[i].cursor, PAGE_LIMIT).catch(() => null);
        return { i, refreshed };
      }),
    ).then((updates) => {
      if (cancelled) return;
      setPages((prev) => {
        const next = [...prev];
        for (const { i, refreshed } of updates) {
          if (refreshed && next[i]) next[i] = { cursor: next[i].cursor, rows: refreshed.items };
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
    if (q) out = out.filter((r) => r.slug.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    if (failedFirst) {
      out = [...out].sort((a, b) => Number(rowFailed(b) > 0) - Number(rowFailed(a) > 0) || a.slug.localeCompare(b.slug));
    }
    return out;
  }, [loadedRows, search, failedFirst]);

  const cellByCondition = useCallback((row: AdminCampaignAirfoilRow) => {
    const map = new Map<string, CampaignProgressTotals & { conditionId: string }>();
    for (const c of row.perCondition) map.set(c.conditionId, c);
    return map;
  }, []);

  // ---- windowing (single optionally-expanded row) ----
  const rowH = narrow ? NARROW_ROW_H : DESKTOP_ROW_H;
  const expandedIndex = narrow && expandedSlug ? rows.findIndex((r) => r.slug === expandedSlug) : -1;
  const expandedExtra = expandedIndex >= 0 ? visibleConditions.length * EXPANDED_LINE_H + 10 : 0;
  const totalHeight = rows.length * rowH + expandedExtra;
  const rowTop = (i: number) => i * rowH + (expandedIndex >= 0 && i > expandedIndex ? expandedExtra : 0);
  let start = Math.floor(scrollTop / rowH);
  if (expandedIndex >= 0 && rowTop(start) > scrollTop) {
    start = Math.max(0, Math.floor((scrollTop - expandedExtra) / rowH));
  }
  start = Math.max(0, start - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_H / rowH) + OVERSCAN * 2;
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

  const anyDerived = useMemo(() => loadedRows.some((r) => r.perCondition.some((c) => c.derived > 0)), [loadedRows]);
  const anySync = useMemo(() => loadedRows.some((r) => r.perCondition.some((c) => syncPromisedCount(c) > 0)), [loadedRows]);
  const anyKept = conditions.some((c) => c.status === "kept");
  const showLegend = anyKept || (showReleased && releasedConditions.length > 0) || anyDerived || anySync;

  const minWidth = NAME_COL + visibleConditions.length * CELL_W;

  const headerCell = (c: AdminCampaignConditionSummary) => {
    const state = conditionDisplayState(c);
    const released = state === "released";
    return (
      <div
        key={c.id}
        title={`Re ${formatRe(c.reynolds)} · condition #${c.ord}${released ? " · released" : state === "kept" || state === "blocked" || state === "retired" ? " · kept to finish" : ""}`}
        style={{
          width: CELL_W,
          flex: "0 0 auto",
          padding: "7px 6px",
          fontFamily: MONO,
          fontSize: 10,
          color: released ? C.dimmest : state === "blocked" ? C.redText : C.muted,
          borderLeft: `1px solid ${C.borderRow}`,
          textAlign: "center",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          opacity: released ? 0.6 : 1,
        }}
      >
        {(state === "kept" || state === "blocked" || state === "retired") && <span style={{ color: C.amber }}>⚑ </span>}
        Re {formatRe(c.reynolds)}
        <span style={{ color: C.dimmest }}> · #{c.ord}</span>
      </div>
    );
  };

  const cellContent = (cell: (CampaignProgressTotals & { conditionId: string }) | undefined, released: boolean) => {
    if (!cell || cell.requested === 0) {
      return <span style={{ color: C.dimmest }}>·</span>;
    }
    const solvedish = cell.solved + cell.derived;
    const complete = cell.remaining === 0 && cell.failed === 0;
    const sync = syncPromisedCount(cell);
    const color = released ? C.dim : cell.failed > 0 ? C.redText : complete ? C.teal : cell.running > 0 ? C.amber : C.muted;
    return (
      <span style={{ color, display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
        {fCount(solvedish)}/{fCount(cell.requested)}
        {cell.derived > 0 && (
          <span title={`${cell.derived} derived by symmetry`} style={{ color: C.dim }}>◌</span>
        )}
        {cell.failed > 0 && <span title={`${cell.failed} failed`}>✕{cell.failed}</span>}
        {cell.running > 0 && <span title={`${cell.running} running`} style={{ color: C.amber }}>●</span>}
        {sync > 0 && <span title={`${sync} sync-promised to a remote solver`} style={{ color: C.dim }}>⇄</span>}
      </span>
    );
  };

  const narrowBar = (row: AdminCampaignAirfoilRow) => {
    const agg = { solved: 0, derived: 0, running: 0, failed: 0, remaining: 0, requested: 0 };
    const byId = cellByCondition(row);
    for (const c of visibleConditions) {
      const cell = byId.get(c.id);
      if (!cell) continue;
      agg.solved += cell.solved;
      agg.derived += cell.derived;
      agg.running += cell.running;
      agg.failed += cell.failed;
      agg.remaining += cell.remaining;
      agg.requested += cell.requested;
    }
    const total = Math.max(1, agg.requested);
    const seg = (n: number, color: string, key: string) =>
      n > 0 ? <span key={key} style={{ width: `${(n / total) * 100}%`, background: color, display: "block" }} /> : null;
    return (
      <div style={{ height: 6, borderRadius: 3, overflow: "hidden", background: C.panel3, display: "flex" }}>
        {seg(agg.solved, C.teal, "s")}
        {seg(agg.derived, "rgba(45,212,191,0.45)", "d")}
        {seg(agg.running, C.amber, "r")}
        {seg(agg.failed, C.red, "f")}
      </div>
    );
  };

  return (
    <div data-testid="campaign-coverage-matrix" style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 12px", borderBottom: `1px solid ${C.borderSoft}` }}>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim }}>COVERAGE</span>
        <input
          data-testid="matrix-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search airfoils…"
          aria-label="search airfoils"
          style={{ ...inputStyle, width: 200, padding: "6px 9px", fontSize: 11 }}
        />
        <button
          type="button"
          data-testid="matrix-filter-failed-first"
          onClick={() => setFailedFirst((v) => !v)}
          style={{ ...ghostBtn, padding: "5px 10px", fontSize: 10, color: failedFirst ? C.teal : C.muted, borderColor: failedFirst ? C.tealBorder : C.stroke }}
        >
          failed first
        </button>
        {releasedConditions.length > 0 && (
          <button
            type="button"
            data-testid="matrix-toggle-released"
            onClick={() => setShowReleased((v) => !v)}
            style={{ ...ghostBtn, padding: "5px 10px", fontSize: 10, color: showReleased ? C.teal : C.muted, borderColor: showReleased ? C.tealBorder : C.stroke }}
          >
            {showReleased ? `Hide released (${releasedConditions.length})` : `Show released (${releasedConditions.length})`}
          </button>
        )}
        <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, color: C.dim }}>
          {fCount(loadedRows.length)}/{fCount(airfoilCount)} airfoils loaded
        </span>
      </div>

      {error && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, padding: "8px 12px" }}>{error}</div>}
      {search.trim() && !exhausted && (
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.amber, padding: "6px 12px" }}>
          search covers the {fCount(loadedRows.length)} loaded rows — scroll the matrix to load the rest
        </div>
      )}

      {/* own overflow-x container: the page body never scrolls horizontally */}
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: narrow ? undefined : minWidth }}>
          {!narrow && (
            <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 2, background: C.panel, borderBottom: `1px solid ${C.borderRow}` }}>
              <div style={{ width: NAME_COL, flex: "0 0 auto", padding: "7px 12px", fontFamily: MONO, fontSize: 10, color: C.dim }}>
                airfoil
              </div>
              {visibleConditions.map(headerCell)}
            </div>
          )}
          <div
            ref={scrollRef}
            data-testid="matrix-scroll"
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            style={{ height: Math.min(VIEWPORT_H, Math.max(rowH, totalHeight)), overflowY: "auto", position: "relative" }}
          >
            <div style={{ height: totalHeight, position: "relative" }}>
              {rows.slice(start, end).map((row, sliceIdx) => {
                const i = start + sliceIdx;
                const byId = cellByCondition(row);
                const expanded = narrow && expandedSlug === row.slug;
                return (
                  <div
                    key={row.slug}
                    data-testid={`matrix-row-${row.slug}`}
                    style={{ position: "absolute", top: rowTop(i), left: 0, right: 0, borderBottom: `1px solid ${C.borderRow}` }}
                  >
                    {narrow ? (
                      <div style={{ padding: "6px 12px", display: "grid", gap: 5 }}>
                        <button
                          type="button"
                          onClick={() => setExpandedSlug(expanded ? null : row.slug)}
                          aria-expanded={expanded}
                          style={{ display: "flex", alignItems: "center", gap: 8, background: "transparent", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
                        >
                          <span style={{ fontFamily: MONO, fontSize: 11, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "55%" }}>
                            {row.name}
                          </span>
                          {row.isSymmetric && <span title="symmetric airfoil — negative angles derived" style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>sym</span>}
                          {rowFailed(row) > 0 && <span style={{ fontFamily: MONO, fontSize: 9, color: C.redText }}>✕{rowFailed(row)}</span>}
                          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9, color: C.dimmest }}>{expanded ? "▾" : "▸"}</span>
                        </button>
                        {narrowBar(row)}
                        {expanded && (
                          <div style={{ display: "grid", gap: 2, paddingBottom: 4 }}>
                            {visibleConditions.map((c) => {
                              const cell = byId.get(c.id);
                              const released = c.status === "released";
                              return (
                                <button
                                  key={c.id}
                                  type="button"
                                  data-testid={`matrix-cell-${row.slug}-${c.ord}`}
                                  onClick={() => onCellClick(row, c, cell ?? null)}
                                  style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", height: EXPANDED_LINE_H - 4, background: "transparent", border: `1px solid ${C.borderRow}`, borderRadius: 6, padding: "0 8px", cursor: "pointer", fontFamily: MONO, fontSize: 10, opacity: released ? 0.6 : 1 }}
                                >
                                  <span style={{ color: C.dim }}>Re {formatRe(c.reynolds)} · #{c.ord}</span>
                                  {cellContent(cell, released)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", height: DESKTOP_ROW_H }}>
                        <div style={{ width: NAME_COL, flex: "0 0 auto", padding: "0 12px", display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                          <span style={{ fontFamily: MONO, fontSize: 11, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {row.name}
                          </span>
                          {row.isSymmetric && <span title="symmetric airfoil — negative angles derived" style={{ fontFamily: MONO, fontSize: 9, color: C.dim, flex: "0 0 auto" }}>sym</span>}
                        </div>
                        {visibleConditions.map((c) => {
                          const cell = byId.get(c.id);
                          const released = c.status === "released";
                          return (
                            <button
                              key={c.id}
                              type="button"
                              data-testid={`matrix-cell-${row.slug}-${c.ord}`}
                              onClick={() => onCellClick(row, c, cell ?? null)}
                              style={{ width: CELL_W, flex: "0 0 auto", height: "100%", background: "transparent", border: "none", borderLeft: `1px solid ${C.borderRow}`, cursor: "pointer", fontFamily: MONO, fontSize: 10.5, opacity: released ? 0.55 : 1 }}
                            >
                              {cellContent(cell, released)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "8px 12px", borderTop: `1px solid ${C.borderRow}` }}>
        {loading && <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>loading rows…</span>}
        {!loading && rows.length === 0 && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
            {loadedRows.length === 0 ? "no airfoils in this campaign" : "no loaded airfoil matches the search"}
          </span>
        )}
        {showLegend && (
          <span data-testid="matrix-legend" style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 9.5, color: C.dim, display: "flex", gap: 12, flexWrap: "wrap" }}>
            {anyKept && <span><span style={{ color: C.amber }}>⚑</span> kept — finishing solved angles</span>}
            {showReleased && releasedConditions.length > 0 && <span>dimmed — released (solved cells kept)</span>}
            {anyDerived && <span>◌ derived by symmetry</span>}
            {anySync && <span>⇄ sync-promised</span>}
          </span>
        )}
      </div>
    </div>
  );
}
