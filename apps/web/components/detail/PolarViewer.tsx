"use client";

import {
  type ChartDomain,
  type ChartPointVM,
  type ChartProjection,
  type ChartType,
  type ProjectChartInput,
  colorForRe,
  derivedBySymmetryInfo,
  f1,
  f2,
  f4,
  fRe,
  readoutAtX,
  zoomChartDomain,
} from "@aerodb/core";
import type { CSSProperties } from "react";
import { useCallback, useMemo, useState } from "react";

import { C, MONO, VIZ } from "@/lib/tokens";
import type { HoverState } from "./DetailIsland";
import { type ChartCursor, PolarChart } from "./PolarChart";

const TABS: [ChartType, string][] = [
  ["cla", "Cl–α"],
  ["clcd", "Cl–Cd"],
  ["lda", "L/D–α"],
  ["cma", "Cm–α"],
];

/** Snap radius (viewBox units) within which the cursor locks onto a point. */
const SNAP_RADIUS = 14;
/** Button zoom step (coarser than a wheel notch). */
const BUTTON_ZOOM = 1.35;

export function PolarViewer(props: {
  chartType: ChartType;
  onChartType: (t: ChartType) => void;
  projection: ChartProjection;
  /** raw chart series — the mouse-following readout interpolates these */
  polars: ProjectChartInput["polars"];
  visibleRe: Record<number, boolean>;
  onToggleRe: (re: number) => void;
  rePointCounts: Record<number, number>;
  reList: number[];
  solvedPointCount: number;
  machStr: string;
  hover: HoverState | null;
  onHover: (h: HoverState | null) => void;
  onPointClick: (vm: ChartPointVM) => void;
  /** zoom/pan window (null = zoom-to-fit) */
  domain: ChartDomain | null;
  onDomainChange: (d: ChartDomain | null) => void;
}) {
  const {
    chartType,
    onChartType,
    projection,
    polars,
    visibleRe,
    onToggleRe,
    rePointCounts,
    reList,
    solvedPointCount,
    machStr,
    hover,
    onHover,
    onPointClick,
    domain,
    onDomainChange,
  } = props;
  const [cursor, setCursor] = useState<ChartCursor | null>(null);

  // Point snap: within SNAP_RADIUS the badge shows the measured point's full
  // data (and the point enlarges via hoverKey); otherwise the badge shows the
  // curves' interpolated values at the cursor α.
  const handleCursor = useCallback(
    (c: ChartCursor | null) => {
      setCursor(c);
      if (!c) {
        onHover(null);
        return;
      }
      let best: ChartPointVM | null = null;
      let bestDist = SNAP_RADIUS;
      for (const p of projection.points) {
        const d = Math.hypot(p.cx - c.px, p.cy - c.py);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      if (best) {
        onHover({
          key: best.key,
          px: c.px,
          py: c.py,
          head:
            best.label +
            (best.point.classificationState === "needs_urans"
              ? " · needs URANS confirmation"
              : best.stalled
                ? " · post-stall"
                : ""),
          a: f1(best.point.a),
          cl: f2(best.point.cl),
          cd: f4(best.point.cd),
          ld: f1(best.point.ld),
        });
      } else {
        onHover(null);
      }
    },
    [projection.points, onHover],
  );

  const readoutRows = useMemo(
    () => (cursor && !hover ? readoutAtX({ chartType, polars, visibleRe, x: cursor.x }) : []),
    [cursor, hover, chartType, polars, visibleRe],
  );
  const readoutValue = (y: number) => (chartType === "lda" ? f1(y) : chartType === "cma" ? f4(y) : f2(y));

  const zoomBy = (factor: number) => {
    const dom = projection.domain;
    onDomainChange(zoomChartDomain(dom, factor, { x: (dom.xMin + dom.xMax) / 2, y: (dom.yMin + dom.yMax) / 2 }));
  };
  const solvedPointLabel = `${solvedPointCount} solved point${solvedPointCount === 1 ? "" : "s"}`;
  const hasPostStallPoints = projection.points.some((p) => p.stalled || p.point.unsteady);
  const hasProvisionalPoints = projection.points.some((p) => p.point.classificationState === "needs_urans");
  const hasDerivedPoints = projection.points.some((p) => derivedBySymmetryInfo(p.point).derived);
  const hasFitCurve = projection.curves.some((c) => c.kind === "fit");

  const badgeStyle = (px: number, py: number, accent: string): CSSProperties => ({
    position: "absolute",
    left: Math.min(500, Math.max(0, px + 14)),
    top: Math.max(0, py - 60),
    background: C.popover,
    border: `1px solid ${accent}`,
    borderRadius: 9,
    padding: "9px 11px",
    pointerEvents: "none",
    zIndex: 8,
    boxShadow: `0 10px 26px ${C.shadow}`,
  });
  const hoverStyle: CSSProperties = hover ? badgeStyle(hover.px, hover.py, C.teal) : { display: "none" };

  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
      {/* toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: `1px solid ${C.borderSoft}`,
        }}
      >
        <div style={{ display: "flex", background: C.panel2, border: `1px solid ${C.stroke2}`, borderRadius: 9, padding: 3, gap: 2 }}>
          {TABS.map(([id, label]) => {
            const on = chartType === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onChartType(id)}
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 11px",
                  cursor: "pointer",
                  background: on ? C.tabActive : "transparent",
                  color: on ? C.teal : C.muted,
                  fontWeight: on ? 600 : 400,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              color: solvedPointCount ? C.teal : C.dim,
              border: `1px solid ${solvedPointCount ? C.tealBorder : C.stroke}`,
              background: solvedPointCount ? C.tealFill : C.panel3,
              borderRadius: 8,
              padding: "7px 12px",
              whiteSpace: "nowrap",
            }}
          >
            {solvedPointCount ? solvedPointLabel : "waiting for solved points"}
          </span>
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: "7px 11px" }}>
            M {machStr}
          </span>
          {/* zoom controls — wheel zooms at the cursor, drag pans, double-click fits */}
          <div
            style={{ display: "flex", background: C.panel2, border: `1px solid ${C.stroke2}`, borderRadius: 9, padding: 3, gap: 2 }}
            title="scroll = zoom at cursor · drag = pan · double-click = fit"
          >
            <button
              type="button"
              data-testid="polar-zoom-out"
              aria-label="Zoom out"
              onClick={() => zoomBy(BUTTON_ZOOM)}
              style={{ fontFamily: MONO, fontSize: 13, lineHeight: "13px", border: "none", borderRadius: 6, padding: "5px 9px", cursor: "pointer", background: "transparent", color: C.muted }}
            >
              −
            </button>
            <button
              type="button"
              data-testid="polar-zoom-in"
              aria-label="Zoom in"
              onClick={() => zoomBy(1 / BUTTON_ZOOM)}
              style={{ fontFamily: MONO, fontSize: 13, lineHeight: "13px", border: "none", borderRadius: 6, padding: "5px 9px", cursor: "pointer", background: "transparent", color: C.muted }}
            >
              +
            </button>
            <button
              type="button"
              data-testid="polar-zoom-fit"
              aria-label="Zoom to fit"
              onClick={() => onDomainChange(null)}
              style={{
                fontFamily: MONO,
                fontSize: 11,
                lineHeight: "13px",
                border: "none",
                borderRadius: 6,
                padding: "5px 9px",
                cursor: "pointer",
                background: domain ? C.tabActive : "transparent",
                color: domain ? C.teal : C.muted,
                fontWeight: domain ? 600 : 400,
              }}
            >
              fit
            </button>
          </div>
        </div>
      </div>

      {/* chart */}
      <div style={{ padding: "16px 16px 6px", position: "relative" }}>
        <div
          style={{
            position: "relative",
            width: 684,
            maxWidth: "100%",
            margin: "0 auto",
            background: VIZ.bg,
            borderRadius: 10,
            padding: "8px 6px",
          }}
        >
          <PolarChart projection={projection} onPointClick={onPointClick} onDomainChange={onDomainChange} onCursor={handleCursor} />
          <div style={{ position: "absolute", left: 8, top: 4, fontFamily: MONO, fontSize: 11, color: VIZ.text }}>
            {projection.yTitle}
          </div>
          {projection.points.length === 0 && (
            <div
              style={{
                position: "absolute",
                inset: "22% 10%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                pointerEvents: "none",
                fontFamily: MONO,
                color: C.muted,
                background: "rgba(7, 12, 18, 0.52)",
                border: `1px dashed ${C.stroke2}`,
                borderRadius: 10,
                padding: 16,
              }}
            >
              <span style={{ color: C.text, fontSize: 12, fontWeight: 700 }}>No solved OpenFOAM polar points yet</span>
              <span style={{ marginTop: 7, fontSize: 10, lineHeight: 1.5 }}>
                Queued/running points will appear here only after a completed result row is stored.
              </span>
            </div>
          )}
          {hover && (
            <div style={hoverStyle} data-testid="polar-hover-badge">
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 4 }}>{hover.head}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                α {hover.a}°&nbsp;&nbsp;·&nbsp;&nbsp;Cl {hover.cl}
                <br />
                Cd {hover.cd}&nbsp;&nbsp;·&nbsp;&nbsp;L/D {hover.ld}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.teal, marginTop: 5 }}>click → simulation ▶</div>
            </div>
          )}
          {!hover && cursor && readoutRows.length > 0 && (
            <div style={badgeStyle(cursor.px, cursor.py, C.stroke2)} data-testid="polar-readout-badge">
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 4 }}>α {f1(cursor.x)}°</div>
              <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.7, color: C.text }}>
                {readoutRows.map((r) => (
                  <div key={`${r.kind}-${r.re}`} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span
                      style={{
                        width: 13,
                        borderTop: r.kind === "fit" ? `2px dashed ${r.color}` : `2px solid ${r.color}`,
                        display: "inline-block",
                      }}
                    />
                    <span style={{ color: C.muted, fontSize: 10 }}>{r.label}</span>
                    <span>
                      {projection.yTitle} {readoutValue(r.y)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          padding: "10px 16px 16px",
          borderTop: `1px solid ${C.borderRow}`,
          marginTop: 6,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim, marginRight: 2 }}>POLARS</span>
        {reList.map((re) => {
          const on = !!visibleRe[re];
          const count = rePointCounts[re] ?? 0;
          return (
            <button
              key={re}
              type="button"
              onClick={() => onToggleRe(re)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontFamily: MONO,
                fontSize: 11,
                borderRadius: 999,
                padding: "5px 11px",
                cursor: "pointer",
                background: on ? C.panel3 : "transparent",
                border: `1px solid ${on ? C.stroke2 : C.border}`,
                color: count ? (on ? C.text : C.dim) : C.dimmest,
              }}
            >
              <span style={{ width: 14, borderTop: `2px solid ${colorForRe(re)}`, display: "inline-block" }} />
              Re {fRe(re)} · {count}
            </button>
          );
        })}
        {hasFitCurve && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 16, borderTop: `2px dashed ${C.teal}`, display: "inline-block" }} />
            best-fit
          </span>
        )}
        {hasDerivedPoints && (
          <span data-testid="polar-derived-legend" style={{ fontFamily: MONO, fontSize: 10, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", border: `1.6px solid ${C.teal}`, background: "transparent", display: "inline-block" }} />
            derived by symmetry
          </span>
        )}
        {hasProvisionalPoints && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.amber, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", border: `2px solid ${C.amber}`, display: "inline-block" }} />
            needs URANS confirmation
          </span>
        )}
        {hasPostStallPoints && (
          <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 10, color: C.redText, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.red, display: "inline-block" }} />
            post-stall → URANS
          </span>
        )}
      </div>
    </div>
  );
}
