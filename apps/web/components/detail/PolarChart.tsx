"use client";

import {
  CHART_VIEW,
  type ChartDomain,
  type ChartPointVM,
  type ChartProjection,
  panChartDomain,
  zoomChartDomain,
} from "@aerodb/core";
import { useCallback, useEffect, useId, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { VIZ } from "@/lib/tokens";

/** Data-space cursor sample raised on every pointer move inside the axes. */
export interface ChartCursor {
  /** data coordinates (α or Cd on x; Cl / L\/D / Cm on y) */
  x: number;
  y: number;
  /** viewBox coordinates — the wrapper positions the mouse-following badge with these */
  px: number;
  py: number;
}

/** Wheel notch zoom step; the viewer's +/− buttons use a coarser step. */
const WHEEL_STEP = 1.2;
/** Pointer travel (viewBox units) before a press becomes a pan, not a click. */
const DRAG_THRESHOLD = 3;

export function PolarChart({
  projection,
  onPointClick,
  onDomainChange,
  onCursor,
}: {
  projection: ChartProjection;
  onPointClick: (vm: ChartPointVM) => void;
  /** zoom/pan window updates; null = back to zoom-to-fit */
  onDomainChange?: (d: ChartDomain | null) => void;
  /** cursor tracking for the mouse-following value badge; null when leaving the axes */
  onCursor?: (c: ChartCursor | null) => void;
}) {
  const { PX0, PX1, PY0, PY1, w, h } = CHART_VIEW;
  const clipId = "polar-clip-" + useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The native wheel listener registers once; refs keep it on fresh state.
  const projRef = useRef(projection);
  projRef.current = projection;
  const onDomainRef = useRef(onDomainChange);
  onDomainRef.current = onDomainChange;
  const drag = useRef<{ vx: number; vy: number; dom: ChartDomain; panning: boolean } | null>(null);
  const didPan = useRef(false);

  const toViewBox = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const svg = svgRef.current;
      if (!svg) return { vx: -1, vy: -1 };
      const rect = svg.getBoundingClientRect();
      return {
        vx: ((e.clientX - rect.left) * w) / rect.width,
        vy: ((e.clientY - rect.top) * h) / rect.height,
      };
    },
    [w, h],
  );
  const inPlot = useCallback(
    (vx: number, vy: number) => vx >= PX0 && vx <= PX1 && vy >= PY0 && vy <= PY1,
    [PX0, PX1, PY0, PY1],
  );
  const toData = useCallback(
    (vx: number, vy: number, dom: ChartDomain) => ({
      x: dom.xMin + ((vx - PX0) / (PX1 - PX0)) * (dom.xMax - dom.xMin),
      y: dom.yMin + ((PY1 - vy) / (PY1 - PY0)) * (dom.yMax - dom.yMin),
    }),
    [PX0, PX1, PY0, PY1],
  );

  // Wheel zoom about the cursor. Native non-passive listener: React registers
  // wheel as passive at the root, so preventDefault (needed to keep the page
  // from scrolling while zooming the chart) would be ignored there.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!onDomainRef.current) return;
      const { vx, vy } = toViewBox(e);
      if (!inPlot(vx, vy)) return;
      e.preventDefault();
      const dom = projRef.current.domain;
      const factor = e.deltaY > 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      onDomainRef.current(zoomChartDomain(dom, factor, toData(vx, vy, dom)));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toViewBox, inPlot, toData]);

  const handlePointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !onDomainChange) return;
    const { vx, vy } = toViewBox(e);
    if (!inPlot(vx, vy)) return;
    drag.current = { vx, vy, dom: projection.domain, panning: false };
    didPan.current = false;
    // NO pointer capture yet: capturing on pointer-down retargets the whole
    // click to the svg, so the point circles' onClick can never fire (prod
    // regression: clicking a solved point stopped opening its results).
    // Capture is taken only when a real pan starts (see handlePointerMove).
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const { vx, vy } = toViewBox(e);
    const d = drag.current;
    if (d && onDomainChange) {
      if (!d.panning && Math.hypot(vx - d.vx, vy - d.vy) > DRAG_THRESHOLD) {
        d.panning = true;
        didPan.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      if (d.panning) {
        // pan against the domain captured at pointer-down: no drift accumulation
        const dx = ((d.vx - vx) / (PX1 - PX0)) * (d.dom.xMax - d.dom.xMin);
        const dy = ((vy - d.vy) / (PY1 - PY0)) * (d.dom.yMax - d.dom.yMin);
        onDomainChange(panChartDomain(d.dom, dx, dy));
        onCursor?.(null);
        return;
      }
    }
    if (onCursor) {
      if (inPlot(vx, vy)) {
        onCursor({ ...toData(vx, vy, projection.domain), px: vx, py: vy });
      } else {
        onCursor(null);
      }
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // A drag must not fire the point click it happened to start on.
  const handleClickCapture = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (didPan.current) {
      e.stopPropagation();
      e.preventDefault();
      didPan.current = false;
    }
  };

  return (
    <svg
      ref={svgRef}
      width="100%"
      viewBox={`0 0 ${w} ${h}`}
      data-testid="polar-chart-svg"
      style={{
        display: "block",
        overflow: "hidden",
        cursor: drag.current?.panning ? "grabbing" : "crosshair",
        touchAction: "none",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => {
        onCursor?.(null);
        if (!drag.current?.panning) drag.current = null;
      }}
      onDoubleClick={() => onDomainChange?.(null)}
      onClickCapture={handleClickCapture}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={PX0} y={PY0} width={PX1 - PX0} height={PY1 - PY0} />
        </clipPath>
      </defs>
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
      {/* curves + points, hard-clipped to the plot rect (belt-and-braces with
          the core's data-space clipping: nothing ever draws over the axes) */}
      <g clipPath={`url(#${clipId})`}>
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
          />
        ))}
      </g>
      {/* x axis title */}
      <text x={361} y={366} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="11" fill={VIZ.text}>
        {projection.xTitle}
      </text>
    </svg>
  );
}
