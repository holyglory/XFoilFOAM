"use client";

import type { ProgressivePolarSeries } from "@aerodb/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { C, MONO, VIZ } from "@/lib/tokens";

const CHARTS = {
  cl: "Lift",
  cd: "Drag",
  cm: "Pitching moment",
  ld: "Lift / drag",
  polar: "Drag polar",
} as const;
type Chart = keyof typeof CHARTS;
const METHODS = {
  neuralfoil: "NeuralFoil",
  openfoam_fast: "OpenFOAM fast",
  openfoam_precise: "OpenFOAM precise",
  composite: "Combined estimate",
};
const COLORS = {
  neuralfoil: "#51d4cc",
  openfoam_fast: "#f5bb5f",
  openfoam_precise: "#ba9eff",
  composite: "#e6f0fa",
};
const number = (value: number) => Number(value.toPrecision(4)).toString();

export function ProgressivePolarViewer({
  series,
  onOpenResult,
}: {
  series: ProgressivePolarSeries[];
  onOpenResult?: (context: {
    re: number;
    aoa: number;
    resultId: string;
    resultAttemptId?: string;
  }) => void;
}) {
  const [selectedId, setSelectedId] = useState(series[0]?.targetId ?? "");
  const [chart, setChart] = useState<Chart>("cl");
  const [samplesVisible, setSamplesVisible] = useState(false);
  const [methodsVisible, setMethodsVisible] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [width, setWidth] = useState(320);
  const root = useRef<HTMLDivElement>(null);
  const clipId = `progressive-${useId().replaceAll(":", "")}`;
  const selected =
    series.find((item) => item.targetId === selectedId) ?? series[0];
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void document.fonts.ready.then(() => {
      if (disposed || !root.current) return;
      setWidth(Math.max(240, root.current.getBoundingClientRect().width));
      observer = new ResizeObserver(([entry]) =>
        setWidth(Math.max(240, entry.contentRect.width)),
      );
      observer.observe(root.current);
      setInteractive(true);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, []);
  const height = Math.max(280, Math.min(420, width * 0.6));
  const projected = useMemo(() => {
    if (!selected) return null;
    const primary =
      selected.curves.find((curve) => curve.method === "composite") ??
      selected.curves.at(-1)!;
    const curves = (methodsVisible ? selected.curves : [primary]).map(
      (curve) => ({
        ...curve,
        values: curve.samples.map((sample) => ({
          sample,
          x: chart === "polar" ? sample.cd : sample.alpha,
          y:
            chart === "ld"
              ? sample.cl / sample.cd
              : chart === "polar"
                ? sample.cl
                : sample[chart],
        })),
      }),
    );
    const values = curves.flatMap((curve) => curve.values);
    if (!values.length) return null;
    const xMin = Math.min(...values.map((value) => value.x));
    const xMax = Math.max(...values.map((value) => value.x));
    const lower = Math.min(...values.map((value) => value.y));
    const upper = Math.max(...values.map((value) => value.y));
    const padding = Math.max(
      (upper - lower) * 0.1,
      Math.abs(upper) * 0.02,
      0.001,
    );
    const yMin = lower - padding;
    const yMax = upper + padding;
    return {
      curves,
      xMin,
      xMax,
      yMin,
      yMax,
      x: (value: number) =>
        58 + ((value - xMin) / Math.max(xMax - xMin, 1e-9)) * (width - 82),
      y: (value: number) =>
        height - 42 - ((value - yMin) / (yMax - yMin)) * (height - 66),
    };
  }, [selected, chart, methodsVisible, width, height]);
  if (!selected || !projected) return null;
  const primaryCurve =
    selected.curves.find((curve) => curve.method === "composite") ??
    selected.curves.at(-1)!;
  const metrics = primaryCurve.metrics;
  const metricRows = metrics
    ? ([
        ["Maximum lift / drag", metrics.liftToDragMaximum],
        ["Angle at maximum lift / drag (°)", metrics.alphaAtLiftToDragMaximum],
        ["Minimum Cd", metrics.dragMinimum],
        ["Maximum Cl", metrics.liftMaximum],
        ["Angle at maximum Cl (°)", metrics.alphaAtLiftMaximum],
        ["Cd at zero lift", metrics.dragAtZeroLift],
        ["Cm at zero angle", metrics.momentAtZeroAlpha],
      ] as const)
    : [];
  const tickCount = width < 440 ? 4 : 6;
  const ticks = Array.from(
    { length: tickCount },
    (_, index) => index / (tickCount - 1),
  );
  const yTitle =
    chart === "ld"
      ? "Cl / Cd"
      : chart === "polar"
        ? "Cl"
        : chart === "cl"
          ? "Cl"
          : chart === "cd"
            ? "Cd"
            : "Cm";
  return (
    <section
      aria-label="Progressive polars"
      aria-busy={!interactive}
      data-testid="progressive-polar-viewer"
      style={{
        minWidth: 0,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.panel,
        padding: 16,
      }}
    >
      <header
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <h2 style={{ fontSize: 18, margin: 0 }}>Polars</h2>
        <span style={{ color: C.text2, fontSize: 12 }}>Preliminary</span>
        <label
          style={{
            marginLeft: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            alignItems: "center",
            maxWidth: "100%",
            fontSize: 13,
          }}
        >
          Condition
          <select
            aria-label="Polar condition"
            disabled={!interactive}
            value={selected.targetId}
            onChange={(event) => setSelectedId(event.target.value)}
            style={{
              maxWidth: "100%",
              minWidth: 0,
              padding: "6px 8px",
              color: C.text,
              background: C.panel2,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
            }}
          >
            {series.map((item, index) => (
              <option key={item.targetId} value={item.targetId}>
                Re {number(item.re)} · Mach {number(item.mach)} · {index + 1}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div
        aria-label="Polar quantities"
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}
      >
        {Object.entries(CHARTS).map(([key, label]) => (
          <button
            key={key}
            type="button"
            disabled={!interactive}
            aria-pressed={chart === key}
            onClick={() => setChart(key as Chart)}
            style={{
              border: `1px solid ${chart === key ? C.tealBorder : C.border}`,
              borderRadius: 6,
              padding: "6px 10px",
              color: chart === key ? C.text : C.text2,
              background: chart === key ? C.tealFill : C.panel2,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 14,
          marginBottom: 12,
          color: C.text2,
          fontSize: 13,
        }}
      >
        <label>
          <input
            type="checkbox"
            disabled={!interactive}
            checked={samplesVisible}
            onChange={(event) => setSamplesVisible(event.target.checked)}
          />{" "}
          {selected.kind === "estimate"
            ? "Show curve samples"
            : "Show prediction samples"}
        </label>
        {selected.curves.length > 1 && (
          <label>
            <input
              type="checkbox"
              disabled={!interactive}
              checked={methodsVisible}
              onChange={(event) => setMethodsVisible(event.target.checked)}
            />{" "}
            Compare methods
          </label>
        )}
        {projected.curves.map((curve) => (
          <span key={curve.method}>{METHODS[curve.method]}</span>
        ))}
      </div>
      <div
        ref={root}
        style={{ width: "100%", minWidth: 0, overflowAnchor: "none" }}
      >
        <svg
          data-ui-continuation-anchor
          role="img"
          aria-label={`${CHARTS[chart]} polar at Reynolds ${selected.re}, Mach ${selected.mach}`}
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{
            height: "clamp(280px, 60vw, 420px)",
            display: "block",
            background: VIZ.bg,
            borderRadius: 8,
            overflow: "hidden",
            fontFamily: MONO,
            fontSize: 12,
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={58}
                y={24}
                width={Math.max(1, width - 82)}
                height={height - 66}
              />
            </clipPath>
          </defs>
          {ticks.map((fraction) => {
            const xValue =
              projected.xMin + (projected.xMax - projected.xMin) * fraction;
            const yValue =
              projected.yMin + (projected.yMax - projected.yMin) * fraction;
            return (
              <g key={fraction}>
                <line
                  x1={58}
                  x2={width - 24}
                  y1={projected.y(yValue)}
                  y2={projected.y(yValue)}
                  stroke={VIZ.grid}
                />
                <line
                  x1={projected.x(xValue)}
                  x2={projected.x(xValue)}
                  y1={24}
                  y2={height - 42}
                  stroke={VIZ.grid}
                />
                <text
                  x={50}
                  y={projected.y(yValue) + 4}
                  textAnchor="end"
                  fill={VIZ.text}
                >
                  {number(yValue)}
                </text>
                <text
                  x={projected.x(xValue)}
                  y={height - 23}
                  textAnchor={
                    fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"
                  }
                  fill={VIZ.text}
                >
                  {number(xValue)}
                </text>
              </g>
            );
          })}
          <text x={14} y={17} fill={VIZ.text}>
            {yTitle}
          </text>
          <text x={width - 24} y={height - 5} textAnchor="end" fill={VIZ.text}>
            {chart === "polar" ? "Cd" : "Angle of attack (°)"}
          </text>
          <g clipPath={`url(#${clipId})`}>
            {projected.curves.map((curve) => (
              <g key={curve.method}>
                <path
                  data-testid="progressive-polar-curve"
                  d={curve.values
                    .map(
                      (value, index) =>
                        `${index ? "L" : "M"}${projected.x(value.x)},${projected.y(value.y)}`,
                    )
                    .join(" ")}
                  fill="none"
                  stroke={COLORS[curve.method]}
                  strokeWidth={2.2}
                />
                {samplesVisible &&
                  curve.values.map((value) => (
                    <circle
                      key={value.sample.alpha}
                      data-testid="prediction-sample"
                      cx={projected.x(value.x)}
                      cy={projected.y(value.y)}
                      r={3}
                      fill={COLORS[curve.method]}
                    >
                      <title>
                        {METHODS[curve.method]}: α {number(value.sample.alpha)}
                        °, Cl {number(value.sample.cl)}, Cd{" "}
                        {number(value.sample.cd)}, Cm {number(value.sample.cm)}
                      </title>
                    </circle>
                  ))}
              </g>
            ))}
          </g>
        </svg>
      </div>
      <details
        style={{ marginTop: 14, color: C.text2, fontSize: 13, lineHeight: 1.6 }}
      >
        <summary style={{ cursor: "pointer", color: C.text }}>
          Why this curve
        </summary>
        <p>
          {selected.kind === "estimate"
            ? `This curve combines the stored NeuralFoil prediction with ${selected.explanation.contributors?.length ?? 0} contributing CFD observations. History windows remain observations, not separate solver runs or automatically converged points.`
            : "This is a NeuralFoil prediction from the stored profile coordinates and the selected flow condition, with AeroSandbox compressibility corrections. It is not a completed OpenFOAM calculation."}
        </p>
        <p>
          {selected.explanation.calibration === "unvalidated"
            ? selected.kind === "estimate"
              ? "Model uncertainty is conditional on the stated assumptions and has not been calibrated for this condition. It is not a validated accuracy guarantee."
              : "Prediction error has not been calibrated for this condition. No accuracy interval is claimed."
            : "Prediction uncertainty is calibrated."}
        </p>
        {selected.mach >= 0.3 && selected.kind === "prediction" && (
          <p>
            The compressibility correction is a low-fidelity estimate, not a
            resolved shock or compressible CFD solution.
          </p>
        )}
        <p>
          Geometry fit: RMS error{" "}
          {number(selected.explanation.geometryRms * 100)}% of chord; maximum
          error {number(selected.explanation.geometryMaximumError * 100)}%.
        </p>
        <p>
          {Object.entries(selected.explanation.modelVersions)
            .map(([name, version]) => `${name} ${version}`)
            .join(" · ")}
        </p>
        {!!selected.explanation.contributors?.length && (
          <ul
            aria-label="Contributing calculations"
            style={{ paddingLeft: 20 }}
          >
            {[
              ...new Map(
                selected.explanation.contributors.map((entry) => [
                  entry.attemptId,
                  entry,
                ]),
              ).values(),
            ].map((entry) => (
              <li key={entry.attemptId}>
                {onOpenResult &&
                typeof entry.alpha === "number" &&
                Number.isFinite(entry.alpha) ? (
                  <button
                    type="button"
                    disabled={!interactive}
                    onClick={() =>
                      onOpenResult({
                        re: selected.re,
                        aoa: entry.alpha!,
                        resultId: entry.resultId,
                        resultAttemptId: entry.attemptId,
                      })
                    }
                    data-result-id={entry.resultId}
                    data-result-attempt-id={entry.attemptId}
                    style={{
                      color: C.teal,
                      background: "none",
                      border: 0,
                      padding: "6px 0",
                      textDecoration: "underline",
                      cursor: "pointer",
                    }}
                  >
                    {METHODS[entry.method]} · α {number(entry.alpha)}°
                  </button>
                ) : (
                  METHODS[entry.method]
                )}
                {" · "}
                {entry.numericalConvergence === "converged"
                  ? "Converged"
                  : "Provisional history"}
              </li>
            ))}
          </ul>
        )}
      </details>
      {metrics && (
        <section aria-label="Curve summary" style={{ marginTop: 16 }}>
          <h3 style={{ margin: "0 0 5px", fontSize: 14 }}>Curve summary</h3>
          <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
            {METHODS[primaryCurve.method]} · Within{" "}
            {number(metrics.alphaMinimum)}° to {number(metrics.alphaMaximum)}°
          </p>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 12,
              marginBottom: 0,
            }}
          >
            {metricRows.map(([label, value]) => (
              <div key={label}>
                <dt style={{ color: C.muted, fontSize: 12 }}>{label}</dt>
                <dd
                  style={{
                    margin: "4px 0 0",
                    color: C.text,
                    fontFamily: MONO,
                    fontSize: 13,
                  }}
                >
                  {value === null ? "—" : number(value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </section>
  );
}
