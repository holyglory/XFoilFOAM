import type { ProgressivePolarSeries } from "@aerodb/core";
import { C } from "@/lib/tokens";

export function PolarMiniChart({
  series,
  color = C.teal,
}: {
  series?: ProgressivePolarSeries;
  color?: string;
}) {
  const curve =
    series?.curves.find((item) => item.method === "composite") ??
    series?.curves.find((item) => item.method === "neuralfoil");
  if (!curve || curve.samples.length < 2)
    return (
      <div
        style={{
          minHeight: 168,
          display: "grid",
          placeItems: "center",
          color: C.muted,
          fontSize: 12,
        }}
      >
        No polar at this condition
      </div>
    );
  const samples = curve.samples;
  const minimum = Math.min(...samples.map((point) => point.cl));
  const maximum = Math.max(...samples.map((point) => point.cl));
  const start = samples[0].alpha;
  const end = samples.at(-1)!.alpha;
  const path = samples
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${42 + ((point.alpha - start) / Math.max(end - start, 1e-9)) * 254},${145 - ((point.cl - minimum) / Math.max(maximum - minimum, 1e-9)) * 120}`,
    )
    .join(" ");
  return (
    <svg
      role="img"
      aria-label="Lift polar for the selected condition"
      viewBox="0 0 320 184"
      style={{ width: "100%", display: "block", overflow: "hidden" }}
    >
      {[25, 65, 105, 145].map((height) => (
        <line
          key={height}
          x1="42"
          x2="296"
          y1={height}
          y2={height}
          stroke={C.border}
        />
      ))}
      <path
        data-testid="catalog-polar-curve"
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="2.4"
      />
      <g fill={C.muted} fontSize="11">
        <text x="4" y="29">
          {maximum.toFixed(1)}
        </text>
        <text x="4" y="149">
          {minimum.toFixed(1)}
        </text>
        <text x="39" y="165">
          {start}°
        </text>
        <text x="282" y="165">
          {end}°
        </text>
        <text x="154" y="180">
          Angle
        </text>
        <text x="8" y="89">
          Cl
        </text>
      </g>
    </svg>
  );
}
