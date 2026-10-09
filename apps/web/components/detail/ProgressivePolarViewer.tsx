"use client";

import { fRe, type ProgressivePolarSeries } from "@aerodb/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { C, MONO, VIZ } from "@/lib/tokens";
import { polarAxisLayout } from "@/lib/polar-axis";
import {
  POLAR_QUANTITY_LABELS as CHARTS,
  PolarQuantitySelector,
  type PolarQuantity as Chart,
} from "@/components/PolarQuantitySelector";
import controls from "@/components/PolarControls.module.css";
import { withMetricCondition } from "@/lib/metric-condition";

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
type ProgressiveCurveMethod = keyof typeof METHODS;
type ProgressiveSample =
  ProgressivePolarSeries["curves"][number]["samples"][number];
type ProgressiveContributor = NonNullable<
  ProgressivePolarSeries["explanation"]["contributors"]
>[number];
type ProgressiveSampleFocus = {
  method: ProgressiveCurveMethod;
  sample: ProgressiveSample;
  contributors: ProgressiveContributor[];
};

export function ProgressivePolarViewer({
  series,
  onOpenResult,
  initialConditionKey = "",
}: {
  series: ProgressivePolarSeries[];
  initialConditionKey?: string;
  onOpenResult?: (context: {
    re: number;
    aoa: number;
    resultId: string;
    resultAttemptId?: string;
  }) => void;
}) {
  const [selectedId, setSelectedId] = useState(
    initialConditionKey
      ? (series.find((item) => item.conditionKey === initialConditionKey)
          ?.targetId ?? "")
      : (series[0]?.targetId ?? ""),
  );
  const [chart, setChart] = useState<Chart>("cl");
  const [samplesVisible, setSamplesVisible] = useState(false);
  const [methodsVisible, setMethodsVisible] = useState(false);
  const [sampleFocus, setSampleFocus] = useState<ProgressiveSampleFocus | null>(
    null,
  );
  const [interactive, setInteractive] = useState(false);
  const [width, setWidth] = useState(320);
  const root = useRef<HTMLDivElement>(null);
  const clipId = `progressive-${useId().replaceAll(":", "")}`;
  const selected = series.find((item) => item.targetId === selectedId);
  const contributorsFor = (method: ProgressiveCurveMethod, alpha: number) =>
    selected?.explanation.contributors?.filter(
      (entry) => entry.method === method && entry.alpha === alpha,
    ) ?? [];
  const activateSample = (
    method: ProgressiveCurveMethod,
    sample: ProgressiveSample,
  ) => {
    const contributors = contributorsFor(method, sample.alpha);
    setSampleFocus({ method, sample, contributors });
    const contributor = contributors[0];
    if (contributor && onOpenResult && selected)
      onOpenResult({
        re: selected.re,
        aoa: sample.alpha,
        resultId: contributor.resultId,
        resultAttemptId: contributor.attemptId,
      });
  };
  const selectionFingerprint = series
    .map((item) => item.conditionKey + ":" + item.targetId)
    .join("|");
  useEffect(() => {
    const nextId = initialConditionKey
      ? (series.find((item) => item.conditionKey === initialConditionKey)
          ?.targetId ?? "")
      : (series[0]?.targetId ?? "");
    setSelectedId(nextId);
    setSampleFocus(null);
  }, [initialConditionKey, selectionFingerprint]);
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
      selected.curves.find(
        (curve) => curve.method === selected.primaryMethod,
      ) ??
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
    const axis = polarAxisLayout(yMin, yMax, width);
    return {
      axis,
      curves,
      xMin,
      xMax,
      yMin,
      yMax,
      x: (value: number) =>
        axis.left +
        ((value - xMin) / Math.max(xMax - xMin, 1e-9)) * axis.plotWidth,
      y: (value: number) =>
        height - 42 - ((value - yMin) / (yMax - yMin)) * (height - 66),
    };
  }, [selected, chart, methodsVisible, width, height]);
  if (!selected || !projected)
    return (
      <section
        data-testid="progressive-polar-viewer"
        style={{
          padding: 18,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
        }}
      >
        <p>No polar is available for this profile at the selected condition.</p>
        <select
          aria-label="Polar condition"
          value=""
          onChange={(event) => setSelectedId(event.target.value)}
          style={{
            maxWidth: "100%",
            background: C.panel,
            color: C.text,
            padding: 10,
          }}
        >
          <option value="">Choose an available condition</option>
          {series.map((item) => (
            <option key={item.targetId} value={item.targetId}>
              Re {fRe(item.re)} · M {number(item.mach)}
            </option>
          ))}
        </select>
      </section>
    );
  const primaryCurve =
    selected.curves.find((curve) => curve.method === selected.primaryMethod) ??
    selected.curves.find((curve) => curve.method === "composite") ??
    selected.curves.at(-1)!;
  const metrics = primaryCurve.metrics;
  const contributorCountFor = (method: ProgressiveCurveMethod) =>
    selected.explanation.contributors?.filter(
      (entry) => entry.method === method,
    ).length ?? 0;
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
      className={controls.card}
      style={{
        minWidth: 0,
        border: `1px solid ${C.border}`,
        borderRadius: 12,
        background: C.panel,
      }}
    >
      <header className={controls.header}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Polars</h2>
        <span style={{ color: C.text2, fontSize: 12 }}>Preliminary</span>
        <label
          className={controls.condition}
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 6,
            alignItems: "center",
            fontSize: 13,
          }}
        >
          <span className={controls.conditionText}>Condition</span>
          <select
            aria-label="Polar condition"
            data-ui-allow-truncation="Long condition options ellipsize on narrow controls"
            disabled={!interactive}
            value={selected.targetId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              const condition = series.find(
                (item) => item.targetId === event.target.value,
              )?.conditionKey;
              window.history.replaceState(
                null,
                "",
                withMetricCondition(window.location.href, condition),
              );
            }}
            style={{
              maxWidth: "100%",
              minWidth: 0,
              width: "100%",
              padding: "6px 8px",
              color: C.text,
              background: C.panel2,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
            }}
          >
            {series.map((item, index) => (
              <option key={item.targetId} value={item.targetId}>
                Re {fRe(item.re)} · M{number(item.mach)} · {index + 1}
              </option>
            ))}
          </select>
        </label>
      </header>
      <PolarQuantitySelector
        label="Polar quantities"
        value={chart}
        onChange={setChart}
        disabled={!interactive}
      />
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
            aria-label={
              selected.kind === "estimate"
                ? "Show curve samples"
                : "Show prediction samples"
            }
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
          <span
            key={curve.method}
            data-polar-method={curve.method}
            aria-label={[
              METHODS[curve.method],
              contributorCountFor(curve.method) > 0
                ? contributorCountFor(curve.method) +
                  " CFD anchors and " +
                  curve.samples.length +
                  " estimated samples"
                : null,
            ]
              .filter(Boolean)
              .join(", ")}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 22,
                height: 12,
                flexShrink: 0,
                background: VIZ.bg,
                borderRadius: 2,
              }}
            >
              <span
                data-polar-line-key
                style={{
                  width: 16,
                  borderTop: `2px solid ${COLORS[curve.method]}`,
                }}
              />
            </span>
            <span>{METHODS[curve.method]}</span>
            {contributorCountFor(curve.method) > 0 && (
              <span style={{ color: C.muted, fontSize: 10 }}>
                {contributorCountFor(curve.method)} anchors ·{" "}
                {curve.samples.length} samples
              </span>
            )}
          </span>
        ))}
      </div>
      {methodsVisible &&
      selected.kind === "estimate" &&
      selected.explanation.contributors?.length ? (
        <p
          style={{
            margin: "-2px 0 10px",
            color: C.text2,
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          CFD anchors are stored solver evidence. The remaining samples on a
          method curve are fitted estimates between and beyond those anchors.
        </p>
      ) : null}
      <div
        ref={root}
        style={{ width: "100%", minWidth: 0, overflowAnchor: "none" }}
      >
        <svg
          data-ui-continuation-anchor
          role="group"
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
                x={projected.axis.left}
                y={24}
                width={projected.axis.plotWidth}
                height={height - 66}
              />
            </clipPath>
          </defs>
          {projected.axis.ticks.map(({ fraction, label }) => {
            const xValue =
              projected.xMin + (projected.xMax - projected.xMin) * fraction;
            const yValue =
              projected.yMin + (projected.yMax - projected.yMin) * fraction;
            return (
              <g key={fraction}>
                <line
                  x1={projected.axis.left}
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
                  data-polar-axis-tick="y"
                  x={projected.axis.left - 8}
                  y={projected.y(yValue) + 4}
                  textAnchor="end"
                  fill={VIZ.text}
                >
                  {label}
                </text>
                <text
                  data-polar-axis-tick="x"
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
                  curve.values.map((value) => {
                    const contributors = contributorsFor(
                      curve.method,
                      value.sample.alpha,
                    );
                    return (
                      <circle
                        key={value.sample.alpha}
                        data-testid="prediction-sample"
                        data-cfd-anchor={contributors.length ? "true" : "false"}
                        cx={projected.x(value.x)}
                        cy={projected.y(value.y)}
                        r={contributors.length ? 4.5 : 2.75}
                        fill={COLORS[curve.method]}
                        fillOpacity={contributors.length ? 1 : 0.62}
                        stroke={contributors.length ? C.text : "none"}
                        strokeWidth={contributors.length ? 1 : 0}
                        tabIndex={0}
                        role="button"
                        aria-label={`${METHODS[curve.method]} sample at alpha ${number(value.sample.alpha)} degrees`}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={() =>
                          setSampleFocus({
                            method: curve.method,
                            sample: value.sample,
                            contributors,
                          })
                        }
                        onMouseLeave={() => setSampleFocus(null)}
                        onFocus={() =>
                          setSampleFocus({
                            method: curve.method,
                            sample: value.sample,
                            contributors,
                          })
                        }
                        onBlur={() => setSampleFocus(null)}
                        onClick={() => {
                          activateSample(curve.method, value.sample);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ")
                            return;
                          event.preventDefault();
                          activateSample(curve.method, value.sample);
                        }}
                      >
                        <title>
                          {METHODS[curve.method]}: α{" "}
                          {number(value.sample.alpha)}
                          °, Cl {number(value.sample.cl)}, Cd{" "}
                          {number(value.sample.cd)}, Cm{" "}
                          {number(value.sample.cm)}
                        </title>
                      </circle>
                    );
                  })}
              </g>
            ))}
          </g>
        </svg>
      </div>
      {sampleFocus && (
        <div
          data-testid="progressive-sample-inspector"
          role="group"
          aria-label="Selected polar sample details"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
            padding: "8px 10px",
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            fontFamily: MONO,
            fontSize: 11,
            color: C.text2,
          }}
        >
          <strong style={{ color: COLORS[sampleFocus.method] }}>
            {METHODS[sampleFocus.method]} · α {number(sampleFocus.sample.alpha)}
            °
          </strong>
          <span>
            Cl {number(sampleFocus.sample.cl)} · Cd{" "}
            {number(sampleFocus.sample.cd)} · Cm {number(sampleFocus.sample.cm)}{" "}
            · L/D {number(sampleFocus.sample.cl / sampleFocus.sample.cd)}
          </span>
          <span
            style={{
              color: sampleFocus.contributors.length ? C.amber : C.muted,
            }}
          >
            {sampleFocus.contributors.length
              ? "fitted curve estimate at a CFD-anchored angle"
              : "fitted curve sample · no stored CFD result at this angle"}
          </span>
          {sampleFocus.contributors.length > 0 &&
            onOpenResult &&
            sampleFocus.contributors.map((contributor, index) => (
              <button
                key={contributor.attemptId}
                type="button"
                onClick={() =>
                  onOpenResult({
                    re: selected.re,
                    aoa: sampleFocus.sample.alpha,
                    resultId: contributor.resultId,
                    resultAttemptId: contributor.attemptId,
                  })
                }
                style={{
                  marginLeft: index === 0 ? "auto" : undefined,
                  border: "1px solid " + C.tealBorder,
                  borderRadius: 6,
                  padding: "4px 8px",
                  background: C.tealFill,
                  color: C.teal,
                  fontFamily: MONO,
                  fontSize: 10,
                  cursor: "pointer",
                }}
              >
                {"Open CFD evidence" +
                  (sampleFocus.contributors.length > 1
                    ? " #" + (index + 1)
                    : "")}
              </button>
            ))}
        </div>
      )}
      <details
        style={{ marginTop: 14, color: C.text2, fontSize: 13, lineHeight: 1.6 }}
      >
        <summary style={{ cursor: "pointer", color: C.text }}>
          Why this curve
        </summary>
        <p>
          {selected.kind === "estimate" &&
          selected.primaryMethod === "neuralfoil"
            ? "The displayed curve remains the stored NeuralFoil prediction because the available sparse fast-CFD anchors conflict with its low-angle lift trend. " +
              "It is not a completed OpenFOAM calculation. The CFD evidence remains available for comparison, " +
              "but it is not used as the public primary curve until a matched full-polar reference is supplied."
            : selected.kind === "estimate"
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
