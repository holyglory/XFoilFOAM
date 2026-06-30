"use client";

import { type AirfoilSummary } from "@aerodb/core";
import Link from "next/link";
import { useMemo, useState } from "react";

import { findSearchObjective, rankSearchItems, SEARCH_OBJECTIVES } from "@/components/search/ranking";
import { C, MONO } from "@/lib/tokens";

const MEDALS = ["#f5c518", "#c0c5cc", "#cd7f32"];

export function SearchView({ items }: { items: AirfoilSummary[] }) {
  const [objKey, setObjKey] = useState("maxLD");
  const [clmaxOn, setClmaxOn] = useState(false);
  const [clmaxMin, setClmaxMin] = useState(1.0);
  const [cdminOn, setCdminOn] = useState(false);
  const [cdminMax, setCdminMax] = useState(0.012);
  const [tcOn, setTcOn] = useState(false);
  const [tcMax, setTcMax] = useState(15);

  const objective = findSearchObjective(objKey);

  const ranked = useMemo(() => {
    return rankSearchItems(items, objKey, { clmaxOn, clmaxMin, cdminOn, cdminMax, tcOn, tcMax });
  }, [items, objKey, clmaxOn, clmaxMin, cdminOn, cdminMax, tcOn, tcMax]);

  const card: React.CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 16 };
  const label: React.CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim, marginBottom: 8 };

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <div style={card}>
        <div style={label}>OBJECTIVE</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {SEARCH_OBJECTIVES.map((o) => {
            const on = o.key === objKey;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => setObjKey(o.key)}
                style={{ fontFamily: MONO, fontSize: 12, borderRadius: 8, padding: "8px 13px", cursor: "pointer", border: `1px solid ${on ? C.tealBorder : C.stroke}`, background: on ? C.tealFill : C.panel3, color: on ? C.teal : C.muted, fontWeight: on ? 600 : 400 }}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <div style={label}>CONSTRAINTS</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <Constraint on={clmaxOn} toggle={() => setClmaxOn((v) => !v)} text={`Cl,max ≥ ${clmaxMin.toFixed(2)}`}>
            <input type="range" min={0.5} max={2.2} step={0.05} value={clmaxMin} onChange={(e) => setClmaxMin(+e.target.value)} disabled={!clmaxOn} />
          </Constraint>
          <Constraint on={cdminOn} toggle={() => setCdminOn((v) => !v)} text={`Cd,min ≤ ${cdminMax.toFixed(4)}`}>
            <input type="range" min={0.004} max={0.02} step={0.0005} value={cdminMax} onChange={(e) => setCdminMax(+e.target.value)} disabled={!cdminOn} />
          </Constraint>
          <Constraint on={tcOn} toggle={() => setTcOn((v) => !v)} text={`t/c ≤ ${tcMax.toFixed(1)}%`}>
            <input type="range" min={6} max={18} step={0.5} value={tcMax} onChange={(e) => setTcMax(+e.target.value)} disabled={!tcOn} />
          </Constraint>
        </div>
      </div>

      <div style={{ ...card, padding: 0 }}>
        <div style={{ ...label, padding: "14px 16px 0" }}>RANKED · {ranked.length} match{ranked.length === 1 ? "" : "es"}</div>
        {ranked.length === 0 ? (
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, padding: "20px 16px" }}>No calculated polar points satisfy these constraints yet.</div>
        ) : (
          ranked.map(({ airfoil: a, value }, i) => (
            <Link
              key={a.slug}
              href={`/airfoils/${a.slug}`}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderTop: `1px solid ${C.borderRow}` }}
            >
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, width: 26, textAlign: "center", color: i < 3 ? MEDALS[i] : C.dim }}>
                {i + 1}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{a.name}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>{a.family}</div>
              </div>
              <div style={{ display: "flex", gap: 16, fontFamily: MONO, fontSize: 11 }}>
                {objective.sec(a).map(([k, v]) => (
                  <span key={k} style={{ color: C.muted }}>
                    {k} <span style={{ color: C.text }}>{v}</span>
                  </span>
                ))}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 600, color: C.teal, minWidth: 64, textAlign: "right" }}>
                {objective.fmt(value)}
              </div>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

function Constraint({ on, toggle, text, children }: { on: boolean; toggle: () => void; text: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, opacity: on ? 1 : 0.5 }}>
      <button
        type="button"
        onClick={toggle}
        style={{ fontFamily: MONO, fontSize: 11, color: on ? C.teal : C.muted, background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}
      >
        {on ? "− " : "+ "}
        {text}
      </button>
      <div style={{ width: 160 }}>{children}</div>
    </div>
  );
}
