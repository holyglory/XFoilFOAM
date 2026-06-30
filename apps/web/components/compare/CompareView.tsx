"use client";

import {
  type AirfoilDetailPayload,
  type AirfoilSummary,
  CHART_VIEW,
  f1,
  f2,
  f4,
  fRe,
  metrics,
  niceTicks,
  type PolarMetrics,
  type PolarPointData,
  xyOf,
} from "@aerodb/core";
import { useEffect, useMemo, useState } from "react";

import { AirfoilSelector } from "@/components/AirfoilSelector";
import { getAirfoilDetail } from "@/lib/api";
import { C, MONO, VIZ } from "@/lib/tokens";

const COLORS = ["#2dd4bf", "#a78bfa", "#f56565", "#38bdf8"];
const CHART_TABS: [("clcd" | "cla" | "lda"), string][] = [
  ["clcd", "Cl–Cd"],
  ["cla", "Cl–α"],
  ["lda", "L/D–α"],
];
const RE_PRESETS = [100000, 200000, 300000, 500000, 1000000];

interface Sel {
  a: AirfoilSummary;
  color: string;
  points: PolarPointData[];
  m: PolarMetrics | null;
  detail?: AirfoilDetailPayload;
}

export function CompareView({ items: initialItems }: { items: AirfoilSummary[] }) {
  const items = initialItems;
  const [slugs, setSlugs] = useState<string[]>(initialItems.slice(0, 2).map((a) => a.slug));
  const [chartType, setChartType] = useState<"clcd" | "cla" | "lda">("clcd");
  const [re, setRe] = useState(300000);
  const [details, setDetails] = useState<Record<string, AirfoilDetailPayload>>({});

  useEffect(() => {
    slugs.forEach((s) => {
      if (!details[s]) getAirfoilDetail(s).then((d) => d && setDetails((prev) => ({ ...prev, [s]: d })));
    });
  }, [slugs, details]);

  const selected: Sel[] = useMemo(() => {
    const out: Sel[] = [];
    slugs.forEach((s, i) => {
      const a = items.find((x) => x.slug === s);
      if (!a) return;
      const detail = details[s];
      const pts = detail?.polars.find((polar) => polar.re === re && polar.points.length > 0)?.points ?? [];
      out.push({ a, color: COLORS[i % COLORS.length], points: pts, m: pts.length > 0 ? metrics(pts) : null, detail });
    });
    return out;
  }, [slugs, items, re, details]);

  return (
    <div>
      {/* selection chips + controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
        {selected.map((s) => (
          <span key={s.a.slug} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 12, background: C.panel, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "6px 12px" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: s.color }} />
            {s.a.name}
            <button type="button" onClick={() => setSlugs((v) => v.filter((x) => x !== s.a.slug))} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13, padding: 0 }}>
              ✕
            </button>
          </span>
        ))}
        {slugs.length < 4 && (
          <AirfoilSelector
            items={items}
            exclude={slugs}
            onSelect={(a) => setSlugs((v) => (v.includes(a.slug) || v.length >= 4 ? v : [...v, a.slug]))}
          />
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", background: C.panel2, border: `1px solid ${C.stroke2}`, borderRadius: 9, padding: 3, gap: 2 }}>
            {CHART_TABS.map(([id, label]) => {
              const on = chartType === id;
              return (
                <button key={id} type="button" onClick={() => setChartType(id)} style={{ fontFamily: MONO, fontSize: 11, border: "none", borderRadius: 6, padding: "6px 11px", cursor: "pointer", background: on ? C.tabActive : "transparent", color: on ? C.teal : C.muted, fontWeight: on ? 600 : 400 }}>
                  {label}
                </button>
              );
            })}
          </div>
          <select value={re} onChange={(e) => setRe(parseInt(e.target.value, 10))} style={{ fontFamily: MONO, fontSize: 12, color: C.muted, background: C.panel3, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: "7px 11px", cursor: "pointer" }}>
            {RE_PRESETS.map((r) => (
              <option key={r} value={r} style={{ background: C.panel }}>
                Re {fRe(r)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20, alignItems: "start" }}>
        <div style={{ background: VIZ.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 16px 8px" }}>
          <CompareChart selected={selected} chartType={chartType} />
        </div>
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <DiffTable selected={selected} />
        </div>
      </div>
    </div>
  );
}

function CompareChart({ selected, chartType }: { selected: Sel[]; chartType: "clcd" | "cla" | "lda" }) {
  const { PX0, PX1, PY0, PY1, w, h } = CHART_VIEW;
  let xMin: number, xMax: number;
  if (chartType === "clcd") {
    let mx = 0;
    selected.forEach((s) => s.points.forEach((p) => { if (!p.stalled && p.cd > mx) mx = p.cd; }));
    xMin = 0;
    xMax = Math.max(0.02, Math.min(0.06, mx * 1.18));
  } else {
    xMin = -8;
    xMax = 20;
  }
  let yMin = 1e9, yMax = -1e9;
  selected.forEach((s) =>
    s.points.forEach((p) => {
      const [xx, yy] = xyOf(p, chartType);
      if (chartType === "clcd" && (xx > xMax || xx < xMin)) return;
      if (yy < yMin) yMin = yy;
      if (yy > yMax) yMax = yy;
    }),
  );
  if (yMin > yMax) { yMin = 0; yMax = 1; }
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad;
  yMax += pad;
  const mapX = (v: number) => PX0 + ((v - xMin) / (xMax - xMin)) * (PX1 - PX0);
  const mapY = (v: number) => PY1 - ((v - yMin) / (yMax - yMin)) * (PY1 - PY0);
  const xt = chartType === "clcd" ? niceTicks(xMin, xMax, 5).out : [-8, -4, 0, 4, 8, 12, 16, 20].filter((v) => v >= xMin && v <= xMax);
  const yt = niceTicks(yMin, yMax, 6).out;
  const xTitle = chartType === "clcd" ? "drag coefficient  Cd" : "angle of attack α  [deg]";
  const yTitle = chartType === "lda" ? "L/D" : "Cl";

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }}>
      {yt.map((v, i) => (
        <g key={`y${i}`}>
          <line x1={PX0} y1={mapY(v)} x2={PX1} y2={mapY(v)} stroke={VIZ.grid} strokeWidth="1" />
          <text x={PX0 - 8} y={mapY(v) + 3} textAnchor="end" fontFamily="IBM Plex Mono" fontSize="10" fill={VIZ.dim}>
            {chartType === "lda" ? v.toFixed(0) : v.toFixed(chartType === "clcd" ? 1 : 1)}
          </text>
        </g>
      ))}
      {xt.map((v, i) => (
        <g key={`x${i}`}>
          <line x1={mapX(v)} y1={PY0} x2={mapX(v)} y2={PY1} stroke={VIZ.gridX} strokeWidth="1" />
          <text x={mapX(v)} y={362} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="10" fill={VIZ.dim}>
            {chartType === "clcd" ? v.toFixed(3) : String(v)}
          </text>
        </g>
      ))}
      <line x1={PX0} y1={PY0} x2={PX0} y2={PY1} stroke={VIZ.axis} strokeWidth="1.4" />
      <line x1={PX0} y1={PY1} x2={PX1} y2={PY1} stroke={VIZ.axis} strokeWidth="1.4" />
      {selected.map((s) => {
        if (s.points.length === 0) return null;
        let pts = "";
        s.points.forEach((p) => {
          const [xx, yy] = xyOf(p, chartType);
          if (chartType === "clcd" && (xx > xMax || xx < xMin)) return;
          pts += `${mapX(xx).toFixed(1)},${mapY(yy).toFixed(1)} `;
        });
        return <polyline key={s.a.slug} points={pts.trim()} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" />;
      })}
      <text x={361} y={372} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="11" fill={VIZ.text}>
        {xTitle}
      </text>
      <text x={2} y={14} fontFamily="IBM Plex Mono" fontSize="11" fill={VIZ.text}>
        {yTitle}
      </text>
      {selected.every((s) => s.points.length === 0) && (
        <text x={(PX0 + PX1) / 2} y={(PY0 + PY1) / 2} textAnchor="middle" fontFamily="IBM Plex Mono" fontSize="12" fill={VIZ.dim}>
          no polar data at this Reynolds
        </text>
      )}
    </svg>
  );
}

function DiffTable({ selected }: { selected: Sel[] }) {
  const metricRows: { k: string; get: (m: PolarMetrics) => number; fmt: (v: number) => string; best: "max" | "min" | "none" }[] = [
    { k: "(L/D)max", get: (m) => m.ldmax, fmt: f1, best: "max" },
    { k: "α @ (L/D)max", get: (m) => m.aLd, fmt: (v) => f1(v) + "°", best: "none" },
    { k: "Cl,max", get: (m) => m.clmax, fmt: f2, best: "max" },
    { k: "Cd,min", get: (m) => m.cdmin, fmt: f4, best: "min" },
    { k: "Cl @ Cd,min", get: (m) => m.clCd, fmt: f2, best: "none" },
    { k: "Cd₀ (Cl=0)", get: (m) => m.cd0, fmt: f4, best: "min" },
    { k: "α stall", get: (m) => m.aStall, fmt: (v) => f1(v) + "°", best: "max" },
    { k: "Cm,0", get: (m) => m.cm0, fmt: f2, best: "none" },
  ];
  const geomRows: { k: string; get: (s: Sel) => number | null; fmt: (v: number) => string }[] = [
    { k: "t/c", get: (s) => s.a.thicknessPct, fmt: (v) => v.toFixed(1) + "%" },
    { k: "camber", get: (s) => s.a.camberPct, fmt: (v) => v.toFixed(1) + "%" },
    { k: "area upper/c", get: (s) => s.detail?.geometry.areaUpper ?? null, fmt: f4 },
    { k: "area camber/c", get: (s) => s.detail?.geometry.areaCamber ?? null, fmt: f4 },
  ];
  const cols = `1.3fr ${selected.map(() => "1fr").join(" ")}`;
  const headerCell: React.CSSProperties = { fontFamily: MONO, fontSize: 11, padding: "10px 12px", textAlign: "right" };

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: cols, borderBottom: `1px solid ${C.borderSoft}` }}>
        <span style={{ ...headerCell, textAlign: "left", color: C.dim }}>METRIC</span>
        {selected.map((s) => (
          <span key={s.a.slug} style={{ ...headerCell, color: s.color, fontWeight: 600 }}>
            {s.a.name}
          </span>
        ))}
      </div>
      {metricRows.map((row) => {
        const vals = selected.map((s) => (s.m ? row.get(s.m) : null));
        const finiteVals = vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        const best = finiteVals.length === 0 ? null : row.best === "max" ? Math.max(...finiteVals) : row.best === "min" ? Math.min(...finiteVals) : null;
        return (
          <div key={row.k} style={{ display: "grid", gridTemplateColumns: cols, borderBottom: `1px solid ${C.borderRow}` }}>
            <span style={{ ...headerCell, textAlign: "left", color: C.muted }}>{row.k}</span>
            {selected.map((s, i) => {
              const value = vals[i];
              const isBest = value !== null && best !== null && value === best;
              return (
                <span key={s.a.slug} style={{ ...headerCell, color: isBest ? C.teal : C.text, fontWeight: isBest ? 600 : 400 }}>
                  {value === null ? "-" : row.fmt(value)}
                </span>
              );
            })}
          </div>
        );
      })}
      <div style={{ ...headerCell, textAlign: "left", color: C.dim, paddingTop: 14 }}>GEOMETRY</div>
      {geomRows.map((row) => (
        <div key={row.k} style={{ display: "grid", gridTemplateColumns: cols, borderBottom: `1px solid ${C.borderRow}` }}>
          <span style={{ ...headerCell, textAlign: "left", color: C.muted }}>{row.k}</span>
          {selected.map((s) => {
            const v = row.get(s);
            return (
              <span key={s.a.slug} style={{ ...headerCell, color: C.text }}>
                {v === null ? "…" : row.fmt(v)}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
