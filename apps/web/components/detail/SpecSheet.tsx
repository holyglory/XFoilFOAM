import { type AirfoilDetailPayload, profilePaths } from "@aerodb/core";
import type { CSSProperties } from "react";

import { browserUrl } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

const card: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  overflow: "hidden",
};
const cardHead: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "11px 14px",
  borderBottom: `1px solid ${C.borderSoft}`,
};
const cardLabel: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: "0.12em",
  color: C.dim,
};

export interface PolarMetricRow {
  k: string;
  v: string;
}

export function SpecSheet({
  detail,
  polarRows,
  solvedSeriesLabel,
  solvedPointCount,
  machStr,
  fitStatus,
}: {
  detail: AirfoilDetailPayload;
  polarRows: PolarMetricRow[];
  solvedSeriesLabel: string | null;
  solvedPointCount: number;
  machStr: string;
  fitStatus: string | null;
}) {
  const g = detail.geometry;
  const { profilePath, camberPath } = profilePaths(g);
  const geomRows = [
    { k: "max thickness", v: `${g.thicknessPct.toFixed(1)}% @ ${g.thicknessXPct.toFixed(0)}%c` },
    { k: "max camber", v: `${g.camberPct.toFixed(1)}% @ ${g.camberXPct.toFixed(0)}%c` },
    { k: "LE radius", v: `${g.leRadiusPct.toFixed(2)}%c` },
    { k: "area upper / chord", v: g.areaUpper.toFixed(4) },
    { k: "area lower / chord", v: g.areaLower.toFixed(4) },
    { k: "area camber / chord", v: g.areaCamber.toFixed(4) },
    { k: "TE thickness", v: `${g.teThicknessPct.toFixed(2)}%c` },
  ];
  const formats: { label: string; href: string | null }[] = [
    { label: "Selig .dat", href: detail.downloads.selig },
    { label: "Lednicer", href: detail.downloads.lednicer },
    { label: "XFOIL", href: detail.downloads.xfoil },
    { label: "CSV coords", href: detail.downloads.csv },
    { label: "DXF", href: detail.downloads.dxf },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* profile */}
      <div style={card}>
        <div style={cardHead}>
          <span style={cardLabel}>PROFILE</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{detail.name}</span>
        </div>
        <div style={{ padding: "8px 12px 4px" }}>
          <svg width="100%" viewBox="0 0 340 150" style={{ display: "block" }}>
            <line x1="14" y1="80" x2="326" y2="80" style={{ stroke: C.borderRule }} strokeWidth="1" strokeDasharray="3 4" />
            <path d={profilePath} fill="rgba(45,212,191,0.10)" style={{ stroke: C.teal }} strokeWidth="1.6" strokeLinejoin="round" />
            <path d={camberPath} fill="none" style={{ stroke: C.amber }} strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
          </svg>
        </div>
        <div
          style={{ display: "flex", gap: 18, padding: "4px 14px 12px", fontFamily: MONO, fontSize: 10, color: C.muted }}
        >
          <span>
            <span style={{ display: "inline-block", width: 10, borderTop: `2px solid ${C.teal}`, verticalAlign: "middle", marginRight: 5 }} />
            surface
          </span>
          <span>
            <span style={{ display: "inline-block", width: 10, borderTop: `2px dashed ${C.amber}`, verticalAlign: "middle", marginRight: 5 }} />
            camber line
          </span>
        </div>
      </div>

      {/* fitted polar */}
      <div style={card}>
        <div style={cardHead}>
          <span style={cardLabel}>BEST-FIT POLAR</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: solvedSeriesLabel ? C.teal : C.dim }}>
            {solvedSeriesLabel ? `${solvedSeriesLabel}${fitStatus ? ` · ${fitStatus}` : ""}` : "queued"}
          </span>
        </div>
        <div style={{ padding: "6px 14px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 9.5, padding: "7px 0 6px", borderBottom: `1px solid ${C.borderRule}` }}>
            <span style={{ color: C.dim }}>{solvedPointCount} solved point{solvedPointCount === 1 ? "" : "s"}</span>
            <span style={{ color: C.dim }}>M {machStr}</span>
          </div>
          {polarRows.length > 0 ? (
            polarRows.map((r) => (
              <div
                key={r.k}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  fontFamily: MONO,
                  fontSize: 11,
                  padding: "6px 0",
                  borderBottom: `1px solid ${C.borderRow}`,
                  alignItems: "baseline",
                  gap: 12,
                }}
              >
                <span style={{ color: C.muted }}>{r.k}</span>
                <span style={{ textAlign: "right", color: C.tealText }}>{r.v}</span>
              </div>
            ))
          ) : (
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, lineHeight: 1.55, padding: "12px 0 4px" }}>
              Best-fit metrics appear after at least three solved AoA points are stored for one operating condition.
            </div>
          )}
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.dimmest, marginTop: 8, lineHeight: 1.5 }}>
            fit is derived from stored OpenFOAM evidence only
          </div>
        </div>
      </div>

      {/* geometry / area */}
      <div style={card}>
        <div style={cardHead}>
          <span style={cardLabel}>GEOMETRY · AREA METRICS</span>
          <span style={{ color: C.dim, fontSize: 11 }}>▾</span>
        </div>
        <div style={{ padding: "4px 14px 12px" }}>
          {geomRows.map((row) => (
            <div
              key={row.k}
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: MONO,
                fontSize: 11,
                padding: "6px 0",
                borderBottom: `1px solid ${C.borderRow}`,
              }}
            >
              <span style={{ color: C.muted }}>{row.k}</span>
              <span style={{ color: C.text }}>{row.v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* downloads */}
      <div style={card}>
        <div style={{ ...cardHead, borderBottom: `1px solid ${C.borderSoft}` }}>
          <span style={cardLabel}>DOWNLOAD COORDINATES</span>
        </div>
        <div style={{ padding: "12px 14px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {formats.map((f) => {
            const style: CSSProperties = {
              fontFamily: MONO,
              fontSize: 11,
              color: f.href ? C.text2 : C.dim,
              background: C.panel3,
              border: `1px solid ${C.stroke}`,
              borderRadius: 8,
              padding: "9px 10px",
              cursor: f.href ? "pointer" : "not-allowed",
              textAlign: "left",
              opacity: f.href ? 1 : 0.5,
            };
            return f.href ? (
              <a key={f.label} href={browserUrl(f.href)} style={style}>
                {f.label}&nbsp;&nbsp;↓
              </a>
            ) : (
              <button key={f.label} type="button" disabled style={style}>
                {f.label}&nbsp;&nbsp;↓
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
