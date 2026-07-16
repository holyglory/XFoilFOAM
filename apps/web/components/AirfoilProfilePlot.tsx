import { type AirfoilGeometry, profilePaths } from "@aerodb/core";

import { C, MONO } from "@/lib/tokens";

export function AirfoilProfilePlot({
  geometry,
  name,
  showMetrics = false,
}: {
  geometry: AirfoilGeometry;
  name: string;
  showMetrics?: boolean;
}) {
  const { profilePath, camberPath } = profilePaths(geometry);
  const metrics = [
    {
      label: "max thickness",
      value: `${geometry.thicknessPct.toFixed(1)}% @ ${geometry.thicknessXPct.toFixed(0)}%c`,
    },
    {
      label: "max camber",
      value: `${geometry.camberPct.toFixed(1)}% @ ${geometry.camberXPct.toFixed(0)}%c`,
    },
    {
      label: "trailing edge",
      value: `${geometry.teThicknessPct.toFixed(2)}%c`,
    },
    {
      label: "profile area",
      value: geometry.areaProfile.toFixed(4),
    },
  ];

  return (
    <div data-testid="airfoil-profile-plot" style={{ width: "100%" }}>
      <svg
        width="100%"
        viewBox="0 0 340 150"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${name} airfoil profile`}
        style={{ display: "block" }}
      >
        <title>{name} airfoil profile</title>
        <line
          x1="14"
          y1="80"
          x2="326"
          y2="80"
          style={{ stroke: C.borderRule }}
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <path
          data-testid="airfoil-profile-surface"
          d={profilePath}
          fill="rgba(45,212,191,0.10)"
          style={{ stroke: C.teal }}
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          data-testid="airfoil-profile-camber"
          d={camberPath}
          fill="none"
          style={{ stroke: C.amber }}
          strokeWidth="1"
          strokeDasharray="4 3"
          opacity="0.8"
        />
      </svg>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          flexWrap: "wrap",
          padding: "0 2px 10px",
          fontFamily: MONO,
          fontSize: 10,
          color: C.muted,
        }}
      >
        <span>
          <span
            style={{
              display: "inline-block",
              width: 10,
              borderTop: `2px solid ${C.teal}`,
              verticalAlign: "middle",
              marginRight: 5,
            }}
          />
          surface
        </span>
        <span>
          <span
            style={{
              display: "inline-block",
              width: 10,
              borderTop: `2px dashed ${C.amber}`,
              verticalAlign: "middle",
              marginRight: 5,
            }}
          />
          camber line
        </span>
        <span style={{ color: C.dim }}>dashed datum = chord line</span>
      </div>
      {showMetrics && (
        <div
          data-testid="airfoil-profile-metrics"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
            borderTop: `1px solid ${C.borderRow}`,
          }}
        >
          {metrics.map((metric) => (
            <div
              key={metric.label}
              style={{
                display: "grid",
                gap: 4,
                padding: "10px 12px",
                borderRight: `1px solid ${C.borderRow}`,
              }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  letterSpacing: "0.08em",
                  color: C.dim,
                  textTransform: "uppercase",
                }}
              >
                {metric.label}
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  color: C.text,
                }}
              >
                {metric.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
