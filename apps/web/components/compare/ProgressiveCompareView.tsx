"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fRe } from "@aerodb/core";
import {
  progressiveComparisonConditions,
  progressiveComparisonCurve,
  type ProgressiveComparisonProfile,
} from "@/lib/progressive-comparison";
import { C, MONO, VIZ } from "@/lib/tokens";
import { polarAxisLayout } from "@/lib/polar-axis";
import {
  POLAR_QUANTITY_LABELS as QUANTITIES,
  PolarQuantitySelector,
  type PolarQuantity as Quantity,
} from "@/components/PolarQuantitySelector";
import controls from "@/components/PolarControls.module.css";

const METHODS = {
  neuralfoil: "NeuralFoil",
  openfoam_fast: "OpenFOAM fast estimate",
  openfoam_precise: "OpenFOAM precise estimate",
  composite: "Combined estimate",
} as const;
const display = (value: number | null) =>
  value === null ? "—" : Number(value.toPrecision(4)).toString();

export function ProgressiveCompareView({
  profiles,
}: {
  profiles: ProgressiveComparisonProfile[];
}) {
  const [requestedCondition, setRequestedCondition] = useState<string | null>(
    null,
  );
  const [quantity, setQuantity] = useState<Quantity>("cl");
  const [samplesVisible, setSamplesVisible] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [width, setWidth] = useState(320);
  const chart = useRef<HTMLDivElement>(null);
  const clipId = `comparison-${useId().replaceAll(":", "")}`;
  const conditions = useMemo(
    () => progressiveComparisonConditions(profiles),
    [profiles],
  );
  const condition =
    conditions.find((candidate) => candidate.key === requestedCondition) ??
    conditions[0];
  const selected = useMemo(
    () =>
      profiles.map((profile) => ({
        ...profile,
        selected: condition
          ? progressiveComparisonCurve(profile, condition.key)
          : null,
      })),
    [profiles, condition?.key],
  );
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void document.fonts.ready.then(() => {
      if (disposed || !chart.current) return;
      setWidth(Math.max(240, chart.current.getBoundingClientRect().width));
      observer = new ResizeObserver(([entry]) =>
        setWidth(Math.max(240, entry.contentRect.width)),
      );
      observer.observe(chart.current);
      setInteractive(true);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
    };
  }, []);
  const height = Math.max(280, Math.min(420, width * 0.6));
  const curves = selected.flatMap((profile) =>
    profile.selected
      ? [
          {
            ...profile,
            selected: profile.selected,
            values: profile.selected.curve.samples.map((sample) => ({
              sample,
              x: quantity === "polar" ? sample.cd : sample.alpha,
              y:
                quantity === "ld"
                  ? sample.cl / sample.cd
                  : quantity === "polar"
                    ? sample.cl
                    : sample[quantity],
            })),
          },
        ]
      : [],
  );
  const values = curves.flatMap((curve) => curve.values);
  const xMinimum = values.length
    ? Math.min(...values.map((value) => value.x))
    : 0;
  const xMaximum = values.length
    ? Math.max(...values.map((value) => value.x))
    : 0;
  const minimum = values.length
    ? Math.min(...values.map((value) => value.y))
    : 0;
  const maximum = values.length
    ? Math.max(...values.map((value) => value.y))
    : 0;
  const padding = Math.max(
    (maximum - minimum) * 0.1,
    Math.abs(maximum) * 0.02,
    0.001,
  );
  const yMinimum = minimum - padding;
  const yMaximum = maximum + padding;
  const axis = polarAxisLayout(yMinimum, yMaximum, width);
  const projectX = (value: number) =>
    axis.left +
    ((value - xMinimum) / Math.max(xMaximum - xMinimum, 1e-9)) * axis.plotWidth;
  const projectY = (value: number) =>
    height - 42 - ((value - yMinimum) / (yMaximum - yMinimum)) * (height - 66);
  return (
    <section
      data-testid="progressive-comparison"
      aria-label="Polar comparison"
      aria-busy={!interactive}
      style={{ minWidth: 0 }}
    >
      <div
        className={controls.card}
        style={{
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          minWidth: 0,
        }}
      >
        <header className={controls.header}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Polars</h2>
          <span style={{ color: C.muted, fontSize: 12 }}>Preliminary</span>
          <label
            className={controls.condition}
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 8,
              alignItems: "center",
              fontSize: 13,
            }}
          >
            <span className={controls.conditionText}>Condition</span>
            <select
              aria-label="Comparison condition"
              disabled={!interactive || !conditions.length}
              value={condition?.key ?? ""}
              onChange={(event) => setRequestedCondition(event.target.value)}
              style={{
                color: C.text,
                background: C.panel2,
                maxWidth: "100%",
                minWidth: 0,
                width: "100%",
                padding: 6,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
              }}
            >
              {!conditions.length && (
                <option value="">No matching curve</option>
              )}
              {conditions.map((option, index) => (
                <option key={option.key} value={option.key}>
                  Re {fRe(option.re)} · M{display(option.mach)} ·{" "}
                  {option.branch} · {index + 1}
                </option>
              ))}
            </select>
          </label>
        </header>
        <PolarQuantitySelector
          label="Comparison quantities"
          value={quantity}
          onChange={setQuantity}
          disabled={!interactive}
        />
        <label
          style={{
            display: "block",
            color: C.text2,
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          <input
            type="checkbox"
            checked={samplesVisible}
            disabled={!interactive || !curves.length}
            onChange={(event) => setSamplesVisible(event.target.checked)}
          />{" "}
          Show curve samples
        </label>
        <div
          ref={chart}
          style={{ width: "100%", minWidth: 0, overflowAnchor: "none" }}
        >
          {curves.length ? (
            <svg
              role="img"
              data-ui-continuation-anchor
              aria-label={`${QUANTITIES[quantity]} comparison`}
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
                    x={axis.left}
                    y={24}
                    width={axis.plotWidth}
                    height={height - 66}
                  />
                </clipPath>
              </defs>
              {axis.ticks.map(({ fraction, label }) => {
                const horizontal = xMinimum + (xMaximum - xMinimum) * fraction;
                const vertical = yMinimum + (yMaximum - yMinimum) * fraction;
                return (
                  <g key={fraction}>
                    <line
                      x1={axis.left}
                      x2={width - 24}
                      y1={projectY(vertical)}
                      y2={projectY(vertical)}
                      stroke={VIZ.grid}
                    />
                    <line
                      x1={projectX(horizontal)}
                      x2={projectX(horizontal)}
                      y1={24}
                      y2={height - 42}
                      stroke={VIZ.grid}
                    />
                    <text
                      data-polar-axis-tick="y"
                      x={axis.left - 8}
                      y={projectY(vertical) + 4}
                      textAnchor="end"
                      fill={VIZ.text}
                    >
                      {label}
                    </text>
                    <text
                      data-polar-axis-tick="x"
                      x={projectX(horizontal)}
                      y={height - 23}
                      textAnchor={
                        fraction === 0
                          ? "start"
                          : fraction === 1
                            ? "end"
                            : "middle"
                      }
                      fill={VIZ.text}
                    >
                      {display(horizontal)}
                    </text>
                  </g>
                );
              })}
              <text x={14} y={17} fill={VIZ.text}>
                {quantity === "ld"
                  ? "Cl / Cd"
                  : quantity === "cd"
                    ? "Cd"
                    : quantity === "cm"
                      ? "Cm"
                      : "Cl"}
              </text>
              <text
                x={width - 24}
                y={height - 5}
                textAnchor="end"
                fill={VIZ.text}
              >
                {quantity === "polar" ? "Cd" : "Angle of attack (°)"}
              </text>
              <g clipPath={`url(#${clipId})`}>
                {curves.map((profile) => (
                  <g key={profile.slug}>
                    <path
                      data-testid="comparison-curve"
                      data-profile={profile.slug}
                      d={profile.values
                        .map(
                          (value, index) =>
                            `${index ? "L" : "M"}${projectX(value.x)},${projectY(value.y)}`,
                        )
                        .join(" ")}
                      fill="none"
                      stroke={profile.color}
                      strokeWidth={2.2}
                    />
                    {samplesVisible &&
                      profile.values.map((value) => (
                        <circle
                          key={value.sample.alpha}
                          data-testid="comparison-sample"
                          cx={projectX(value.x)}
                          cy={projectY(value.y)}
                          r={3}
                          fill={profile.color}
                        >
                          <title>
                            {profile.name} ·{" "}
                            {METHODS[profile.selected.curve.method]} · α{" "}
                            {display(value.sample.alpha)}° · Cl{" "}
                            {display(value.sample.cl)} · Cd{" "}
                            {display(value.sample.cd)}
                          </title>
                        </circle>
                      ))}
                  </g>
                ))}
              </g>
            </svg>
          ) : (
            <p role="status">
              No curve is available for the selected condition.
            </p>
          )}
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 14,
            marginTop: 12,
            fontSize: 13,
          }}
        >
          {curves.map((profile) => (
            <span key={profile.slug} style={{ color: C.text }}>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 16,
                  borderTop: `2px solid ${profile.color}`,
                  marginRight: 6,
                }}
              />
              {profile.name} · {METHODS[profile.selected.curve.method]}
            </span>
          ))}
        </div>
        <details
          style={{
            marginTop: 14,
            color: C.text2,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <summary style={{ cursor: "pointer", color: C.text }}>
            Why these curves
          </summary>
          <p>
            Profiles are matched by their physical conditions, including flow
            state, reference dimensions, boundary inputs and transition
            assumptions—not rounded Reynolds or Mach labels. Each line uses that
            profile’s available cached curve. Samples are curve values, not
            additional solver runs.
          </p>
          {curves.some(
            (profile) =>
              profile.selected.series.explanation.calibration === "unvalidated",
          ) && (
            <p>
              Some displayed estimates have uncalibrated prediction error; no
              validated accuracy guarantee is claimed for them.
            </p>
          )}
          <p>
            The summaries use each displayed curve’s angle range; a maximum at
            the edge of that range is not a certified stall point.
          </p>
        </details>
      </div>
      <div
        aria-label="Comparison summaries"
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
          gap: 14,
          marginTop: 14,
        }}
      >
        {selected.map((profile) => {
          const metrics = profile.selected?.curve.metrics;
          const rows = metrics
            ? ([
                ["Maximum lift / drag", metrics.liftToDragMaximum],
                [
                  "Angle at maximum lift / drag (°)",
                  metrics.alphaAtLiftToDragMaximum,
                ],
                ["Minimum Cd", metrics.dragMinimum],
                ["Maximum Cl", metrics.liftMaximum],
                ["Angle at maximum Cl (°)", metrics.alphaAtLiftMaximum],
                ["Cd at zero lift", metrics.dragAtZeroLift],
                ["Cm at zero angle", metrics.momentAtZeroAlpha],
              ] as const)
            : [];
          return (
            <section
              key={profile.slug}
              aria-label={`${profile.name} curve summary`}
              style={{
                padding: 14,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                background: C.panel,
                minWidth: 0,
              }}
            >
              <h3 style={{ fontSize: 15, margin: "0 0 6px" }}>
                {profile.name}
              </h3>
              {profile.selected ? (
                <p style={{ margin: 0, color: C.muted, fontSize: 12 }}>
                  {METHODS[profile.selected.curve.method]}
                  {metrics
                    ? ` · ${display(metrics.alphaMinimum)}° to ${display(metrics.alphaMaximum)}°`
                    : ""}
                </p>
              ) : (
                <p style={{ color: C.muted, fontSize: 13 }}>
                  No unambiguous cached curve for this condition.
                </p>
              )}
              {metrics && (
                <dl style={{ display: "grid", gap: 10, marginBottom: 0 }}>
                  {rows.map(([label, value]) => (
                    <div
                      key={label}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) auto",
                        gap: 10,
                        fontSize: 12,
                      }}
                    >
                      <dt style={{ color: C.muted }}>{label}</dt>
                      <dd
                        style={{ margin: 0, fontFamily: MONO, color: C.text }}
                      >
                        {display(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
