"use client";

import { type ChartPointVM, type ChartProjection, type ChartType, colorForRe, derivedBySymmetryInfo, fRe } from "@aerodb/core";
import type { CSSProperties } from "react";

import { C, MONO, VIZ } from "@/lib/tokens";
import type { HoverState } from "./DetailIsland";
import { PolarChart } from "./PolarChart";

const TABS: [ChartType, string][] = [
  ["cla", "Cl–α"],
  ["clcd", "Cl–Cd"],
  ["lda", "L/D–α"],
  ["cma", "Cm–α"],
];

export function PolarViewer(props: {
  chartType: ChartType;
  onChartType: (t: ChartType) => void;
  projection: ChartProjection;
  visibleRe: Record<number, boolean>;
  onToggleRe: (re: number) => void;
  rePointCounts: Record<number, number>;
  reList: number[];
  solvedPointCount: number;
  machStr: string;
  hover: HoverState | null;
  onHover: (h: HoverState | null) => void;
  onPointClick: (vm: ChartPointVM) => void;
}) {
  const { chartType, onChartType, projection, visibleRe, onToggleRe, rePointCounts, reList, solvedPointCount, machStr, hover, onHover, onPointClick } = props;
  const solvedPointLabel = `${solvedPointCount} solved point${solvedPointCount === 1 ? "" : "s"}`;
  const hasPostStallPoints = projection.points.some((p) => p.stalled || p.point.unsteady);
  const hasProvisionalPoints = projection.points.some((p) => p.point.classificationState === "needs_urans");
  const hasDerivedPoints = projection.points.some((p) => derivedBySymmetryInfo(p.point).derived);
  const hasFitCurve = projection.curves.some((c) => c.kind === "fit");

  let hoverStyle: CSSProperties = { display: "none" };
  if (hover) {
    hoverStyle = {
      position: "absolute",
      left: Math.min(540, Math.max(0, hover.px + 14)),
      top: Math.max(0, hover.py - 60),
      background: C.popover,
      border: `1px solid ${C.teal}`,
      borderRadius: 9,
      padding: "9px 11px",
      pointerEvents: "none",
      zIndex: 8,
      boxShadow: `0 10px 26px ${C.shadow}`,
    };
  }

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
          <PolarChart projection={projection} onHover={onHover} onPointClick={onPointClick} />
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
            <div style={hoverStyle}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 4 }}>{hover.head}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: C.text }}>
                α {hover.a}°&nbsp;&nbsp;·&nbsp;&nbsp;Cl {hover.cl}
                <br />
                Cd {hover.cd}&nbsp;&nbsp;·&nbsp;&nbsp;L/D {hover.ld}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.teal, marginTop: 5 }}>click → simulation ▶</div>
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
