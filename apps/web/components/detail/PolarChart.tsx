"use client";

import { type ChartPointVM, type ChartProjection, CHART_VIEW, f1, f2, f4 } from "@aerodb/core";

import { VIZ } from "@/lib/tokens";
import type { HoverState } from "./DetailIsland";

export function PolarChart({
  projection,
  onHover,
  onPointClick,
}: {
  projection: ChartProjection;
  onHover: (h: HoverState | null) => void;
  onPointClick: (vm: ChartPointVM) => void;
}) {
  const { PX0, PX1, PY0, PY1, w, h } = CHART_VIEW;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "hidden" }}>
      {/* y grid + labels */}
      {projection.yTicks.map((t, i) => (
        <g key={`y${i}`}>
          <line x1={PX0} y1={t.pos} x2={PX1} y2={t.pos} stroke={VIZ.grid} strokeWidth="1" />
          <text x={PX0 - 8} y={t.labelPos} textAnchor="end" fontFamily="IBM Plex Mono" fontSize="10" fill={VIZ.dim}>
            {t.label}
          </text>
        </g>
      ))}
      {/* x grid + labels */}
      {projection.xTicks.map((t, i) => (
        <g key={`x${i}`}>
          <line x1={t.pos} y1={PY0} x2={t.pos} y2={PY1} stroke={VIZ.gridX} strokeWidth="1" />
          <text x={t.pos} y={354} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="10" fill={VIZ.dim}>
            {t.label}
          </text>
        </g>
      ))}
      {/* axes */}
      <line x1={PX0} y1={PY0} x2={PX0} y2={PY1} stroke={VIZ.axis} strokeWidth="1.4" />
      <line x1={PX0} y1={PY1} x2={PX1} y2={PY1} stroke={VIZ.axis} strokeWidth="1.4" />
      {/* curves */}
      {projection.curves.map((c, i) => (
        <polyline
          key={`c${i}`}
          points={c.points}
          fill="none"
          stroke={c.color}
          strokeWidth={c.width}
          strokeDasharray={c.dash}
          opacity={c.opacity}
          strokeLinejoin="round"
        />
      ))}
      {/* points */}
      {projection.points.map((p) => (
        <circle
          key={p.key}
          cx={p.cx}
          cy={p.cy}
          r={p.r}
          fill={p.fill}
          stroke={p.stroke}
          strokeWidth={p.sw}
          style={{ cursor: "pointer" }}
          onClick={() => onPointClick(p)}
          onMouseEnter={() =>
            onHover({
              key: p.key,
              px: p.cx,
              py: p.cy,
              head:
                p.label +
                (p.point.classificationState === "needs_urans"
                  ? " · needs URANS confirmation"
                  : p.stalled
                    ? " · post-stall"
                    : ""),
              a: f1(p.point.a),
              cl: f2(p.point.cl),
              cd: f4(p.point.cd),
              ld: f1(p.point.ld),
            })
          }
          onMouseLeave={() => onHover(null)}
        />
      ))}
      {/* x axis title */}
      <text x={361} y={366} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="11" fill={VIZ.text}>
        {projection.xTitle}
      </text>
    </svg>
  );
}
