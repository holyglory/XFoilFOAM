"use client";

// Solved-points viewer (Solver page redesign, screen 5). A popover anchored to
// the "N solved today" badge (global scope) or a job card's solved-count chip
// (job scope) listing the most recent REAL solved rows, keyset-paged. A row
// click opens the EXISTING SimModal in place (fetching by resultId); α
// prev/next steps through this popover's row list via the modal's own
// track/onTrackPoint contract plus lightweight overlay prev/next controls.
// Escape closes the modal back to the popover; outside-click closes the
// popover. No page navigation anywhere.
//
// Poll interplay: this component owns its data (fetch-on-open + manual
// refresh); the parent's 10 s Activity poll never re-fetches or resets it.

import type { FieldId, FieldTrackPoint } from "@aerodb/core";
import type { Point, SimulationDetail } from "@aerodb/core";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import { type AdminSolvedPoint, getSolvedPoints } from "@/lib/admin";
import { getSim } from "@/lib/api";
import { mergeSolvedPointsPages, stepSolvedPoint } from "@/lib/solved-points";
import { C, MONO } from "@/lib/tokens";
import { SimModal } from "../detail/SimModal";
import { ago, f, formatRe, fSpeed } from "./campaigns/ui";

const PAGE_LIMIT = 20;
const PANEL_WIDTH = 560;
const EMPTY_CONTOUR: Point[] = [];

export interface SolvedPopoverAnchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const chipStyle = (tone: "teal" | "amber" | "muted"): CSSProperties => ({
  fontFamily: MONO,
  fontSize: 9,
  color: tone === "teal" ? C.teal : tone === "amber" ? C.amber : C.dim,
  background: tone === "teal" ? C.tealFill : "transparent",
  border: `1px solid ${tone === "teal" ? C.tealBorder : tone === "amber" ? "rgba(245, 165, 36, 0.38)" : C.stroke}`,
  borderRadius: 999,
  padding: "2px 7px",
  whiteSpace: "nowrap",
  justifySelf: "end",
});

function classificationChip(state: string | null) {
  // Same language as everywhere else in the portal (spec §9): accepted teal,
  // needs-URANS amber; anything else (superseded/rejected/unclassified) muted.
  if (state === "accepted") return <span style={chipStyle("teal")}>accepted</span>;
  if (state === "needs_urans") return <span style={chipStyle("amber")}>needs URANS</span>;
  return <span style={chipStyle("muted")}>{state ? state.replaceAll("_", " ") : "unclassified"}</span>;
}

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

const ROW_COLUMNS = "minmax(0, 1fr) 44px minmax(0, 118px) 48px 52px 46px 92px";

export function SolvedPointsPopover({
  jobId,
  scopeLabel,
  anchor,
  onClose,
}: {
  /** null = global scope (all jobs); a sim-job id = that job's solved points. */
  jobId: string | null;
  /** Human scope line under the title, e.g. an airfoil/job name; null = all jobs. */
  scopeLabel: string | null;
  anchor: SolvedPopoverAnchor;
  onClose: () => void;
}) {
  const [items, setItems] = useState<AdminSolvedPoint[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [solvedToday, setSolvedToday] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<AdminSolvedPoint | null>(null);
  const [sim, setSim] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [playing, setPlaying] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const openRowRef = useRef<AdminSolvedPoint | null>(null);
  openRowRef.current = openRow;

  const fetchFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await getSolvedPoints({ jobId, limit: PAGE_LIMIT });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setSolvedToday(page.solvedToday);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  const loadMore = useCallback(async (): Promise<AdminSolvedPoint[] | null> => {
    if (!nextCursor || loadingMore) return null;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getSolvedPoints({ jobId, cursor: nextCursor, limit: PAGE_LIMIT });
      let merged: AdminSolvedPoint[] = [];
      setItems((prev) => {
        merged = mergeSolvedPointsPages(prev, page.items);
        return merged;
      });
      setNextCursor(page.nextCursor);
      setSolvedToday(page.solvedToday);
      return merged;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoadingMore(false);
    }
  }, [jobId, nextCursor, loadingMore]);

  // Outside-click closes the popover — suspended while the SimModal overlay is
  // open (the modal's own backdrop/Escape close the modal back to us).
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (openRowRef.current) return;
      const panel = panelRef.current;
      if (panel && e.target instanceof Node && !panel.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  // Escape: modal open → back to popover; otherwise close the popover.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (openRowRef.current) {
        setOpenRow(null);
        setSim(null);
        setSimMessage(null);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Fetch the stored result for the open row via the existing sim endpoint
  // (resultId wins server-side). Degrades honestly when the fetch fails.
  useEffect(() => {
    if (!openRow) return;
    let cancelled = false;
    setSim(null);
    setSimMessage(null);
    getSim(openRow.airfoilSlug, openRow.reynolds ?? 0, openRow.aoaDeg, openRow.resultId)
      .then((d) => {
        if (cancelled) return;
        setSim(d);
        setSimField((current) => {
          if (d.status !== "solved" || d.availableFields.length === 0 || d.availableFields.includes(current)) return current;
          return d.availableFields[0];
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setSim(null);
        setSimMessage(`Could not load the stored OpenFOAM result (${(e as Error).message}). The API or its media backend may be unreachable.`);
      });
    return () => {
      cancelled = true;
    };
  }, [openRow]);

  const openIndex = openRow ? items.findIndex((row) => row.resultId === openRow.resultId) : -1;

  const openRowAt = useCallback((row: AdminSolvedPoint) => {
    setOpenRow(row);
    setPlaying(true);
  }, []);

  const step = useCallback(
    async (direction: -1 | 1) => {
      const idx = openRowRef.current ? items.findIndex((row) => row.resultId === openRowRef.current!.resultId) : -1;
      const decision = stepSolvedPoint(items.length, idx, direction, nextCursor);
      if (decision.kind === "move") {
        openRowAt(items[decision.index]);
      } else if (decision.kind === "load-more") {
        const merged = await loadMore();
        if (merged && merged.length > idx + 1) openRowAt(merged[idx + 1]);
      }
    },
    [items, nextCursor, loadMore, openRowAt],
  );

  // The modal's own AoA slider steps through THIS popover's row list — the
  // exact track/onTrackPoint contract SimModal already supports.
  const trackPoints: FieldTrackPoint[] = items.map((row) => ({
    resultId: row.resultId,
    aoa: row.aoaDeg,
    re: row.reynolds ?? 0,
    mach: null,
    regime: null,
    fields: [],
  }));
  const onTrackPoint = useCallback(
    (point: FieldTrackPoint) => {
      const row = items.find((r) => r.resultId === point.resultId);
      if (row) openRowAt(row);
    },
    [items, openRowAt],
  );

  // Fixed positioning from the anchor rect, clamped to the viewport.
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  // Narrow viewports: the 7-column grid would crush the airfoil name to a few
  // pixels — switch to a two-line row (name + chip / metrics line).
  const compact = vw < 640;
  const left = Math.max(12, Math.min(anchor.left, vw - PANEL_WIDTH - 12));
  const top = Math.min(anchor.bottom + 8, vh - 160);
  const maxHeight = Math.max(220, Math.min(540, vh - top - 16));

  const prevDisabled = openIndex <= 0;
  const nextDisabled = openIndex < 0 || (openIndex >= items.length - 1 && !nextCursor) || loadingMore;

  return (
    <>
      <div
        ref={panelRef}
        data-testid="solved-points-popover"
        role="dialog"
        aria-label="Recently solved points"
        style={{
          position: "fixed",
          left,
          top,
          zIndex: 40,
          width: `min(${PANEL_WIDTH}px, calc(100vw - 24px))`,
          maxHeight,
          display: "grid",
          gridTemplateRows: "auto auto 1fr",
          background: C.popover,
          border: `1px solid ${C.stroke}`,
          borderRadius: 10,
          boxShadow: `0 22px 60px ${C.shadow}`,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: `1px solid ${C.borderSoft}` }}>
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: C.text }}>SOLVED POINTS</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {scopeLabel ?? "all jobs"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 7 }}>
            {solvedToday != null && (
              <span data-testid="solved-popover-today" style={{ fontFamily: MONO, fontSize: 10, color: solvedToday > 0 ? C.teal : C.dim }}>
                {solvedToday} solved today
              </span>
            )}
            <button type="button" data-testid="solved-popover-refresh" disabled={loading} onClick={() => void fetchFirstPage()} style={{ ...smallBtn, opacity: loading ? 0.6 : 1 }}>
              {loading ? "loading…" : "refresh"}
            </button>
            <button type="button" aria-label="Close solved points" onClick={onClose} style={smallBtn}>
              ×
            </button>
          </div>
        </div>

        {compact ? (
          <div style={{ padding: "6px 12px", borderBottom: `1px solid ${C.borderSoft}`, fontFamily: MONO, fontSize: 9, color: C.dim }}>
            newest first · α · speed · Re · Cl · Cd · L/D
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: ROW_COLUMNS, gap: 8, padding: "7px 12px", borderBottom: `1px solid ${C.borderSoft}`, fontFamily: MONO, fontSize: 9, color: C.dim }}>
            <span>Airfoil</span>
            <span style={{ textAlign: "right" }}>α</span>
            <span>Speed · Re</span>
            <span style={{ textAlign: "right" }}>Cl</span>
            <span style={{ textAlign: "right" }}>Cd</span>
            <span style={{ textAlign: "right" }}>L/D</span>
            <span style={{ textAlign: "right" }}>State</span>
          </div>
        )}

        <div style={{ overflowY: "auto", minHeight: 0 }}>
          {error && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.redText, padding: "12px", lineHeight: 1.5 }}>
              {error}
              <button type="button" onClick={() => void fetchFirstPage()} style={{ ...smallBtn, marginLeft: 8 }}>
                retry
              </button>
            </div>
          )}
          {!error && loading && items.length === 0 && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, padding: "14px 12px" }}>Loading solved points…</div>
          )}
          {!error && !loading && items.length === 0 && (
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, padding: "14px 12px", lineHeight: 1.5 }}>
              {jobId ? "No solved points recorded for this job yet." : "No solved points recorded yet."}
            </div>
          )}
          {items.map((row) => {
            const rowBase: CSSProperties = {
              width: "100%",
              textAlign: "left",
              fontFamily: MONO,
              fontSize: 10.5,
              padding: "8px 12px",
              background: openRow?.resultId === row.resultId ? C.rowActive : "transparent",
              border: "none",
              borderBottom: `1px solid ${C.borderRow}`,
              cursor: "pointer",
              color: C.text,
            };
            return compact ? (
              <button
                key={row.resultId}
                type="button"
                data-testid="solved-point-row"
                title={`solved ${ago(row.solvedAt)} — open the stored OpenFOAM result`}
                onClick={() => openRowAt(row)}
                style={{ ...rowBase, display: "grid", gap: 4 }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, flex: 1 }}>{row.airfoilName}</span>
                  {classificationChip(row.classificationState)}
                </span>
                <span style={{ color: C.muted, fontSize: 10 }}>
                  α {f(row.aoaDeg, 1)}° · {fSpeed(row.speed)} · {row.reynolds != null ? `Re ${formatRe(row.reynolds)}` : "Re —"} · Cl {f(row.cl, 2)} · Cd {f(row.cd, 4)} · L/D {f(row.clCd, 1)}
                </span>
              </button>
            ) : (
              <button
                key={row.resultId}
                type="button"
                data-testid="solved-point-row"
                title={`solved ${ago(row.solvedAt)} — open the stored OpenFOAM result`}
                onClick={() => openRowAt(row)}
                style={{ ...rowBase, display: "grid", gridTemplateColumns: ROW_COLUMNS, gap: 8, alignItems: "center" }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{row.airfoilName}</span>
                <span style={{ textAlign: "right", color: C.text }}>{f(row.aoaDeg, 1)}°</span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.muted }}>
                  {fSpeed(row.speed)} · {row.reynolds != null ? `Re ${formatRe(row.reynolds)}` : "Re —"}
                </span>
                <span style={{ textAlign: "right", color: C.muted }}>{f(row.cl, 2)}</span>
                <span style={{ textAlign: "right", color: C.muted }}>{f(row.cd, 4)}</span>
                <span style={{ textAlign: "right", color: C.muted }}>{f(row.clCd, 1)}</span>
                {classificationChip(row.classificationState)}
              </button>
            );
          })}
          {nextCursor && !error && (
            <div style={{ padding: "9px 12px" }}>
              <button type="button" data-testid="solved-load-more" disabled={loadingMore} onClick={() => void loadMore()} style={{ ...smallBtn, width: "100%", opacity: loadingMore ? 0.6 : 1 }}>
                {loadingMore ? "loading…" : "load more"}
              </button>
            </div>
          )}
        </div>
      </div>

      {openRow && (
        <>
          <SimModal
            open
            ctx={{ re: openRow.reynolds ?? 0, aoa: openRow.aoaDeg, resultId: openRow.resultId, mirrored: false }}
            sim={sim}
            name={openRow.airfoilName}
            machStr="—"
            contour={EMPTY_CONTOUR}
            field={simField}
            onField={setSimField}
            track={trackPoints}
            onTrackPoint={onTrackPoint}
            playing={playing}
            onTogglePlay={() => setPlaying((p) => !p)}
            onClose={() => {
              setOpenRow(null);
              setSim(null);
              setSimMessage(null);
            }}
            unavailableMessage={simMessage}
          />
          {/* Lightweight α prev/next stepping over the popover's row list —
              wraps the modal (zIndex above its overlay) without forking it. */}
          <button
            type="button"
            data-testid="solved-step-prev"
            disabled={prevDisabled}
            onClick={() => void step(-1)}
            style={{
              position: "fixed",
              left: 14,
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 51,
              fontFamily: MONO,
              fontSize: 11,
              color: prevDisabled ? C.dimmest : C.teal,
              background: C.panel2,
              border: `1px solid ${prevDisabled ? C.stroke : C.tealBorder}`,
              borderRadius: 9,
              padding: "10px 11px",
              cursor: prevDisabled ? "not-allowed" : "pointer",
              opacity: prevDisabled ? 0.55 : 1,
            }}
          >
            ‹ α prev
          </button>
          <button
            type="button"
            data-testid="solved-step-next"
            disabled={nextDisabled}
            onClick={() => void step(1)}
            style={{
              position: "fixed",
              right: 14,
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 51,
              fontFamily: MONO,
              fontSize: 11,
              color: nextDisabled ? C.dimmest : C.teal,
              background: C.panel2,
              border: `1px solid ${nextDisabled ? C.stroke : C.tealBorder}`,
              borderRadius: 9,
              padding: "10px 11px",
              cursor: nextDisabled ? "not-allowed" : "pointer",
              opacity: nextDisabled ? 0.55 : 1,
            }}
          >
            {loadingMore ? "loading…" : "α next ›"}
          </button>
        </>
      )}
    </>
  );
}
