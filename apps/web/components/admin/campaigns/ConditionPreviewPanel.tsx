"use client";

// Condition preview (spec §11 step 2): the ambient-grouped combo grid with
// derived Re/Mach ONLY on combo cells (debounced ~200 ms), min–max footers,
// click-to-exclude persisted into plan.excludedConditions, and the early
// scale warning computed with real arithmetic. ≤3 combos render as lines,
// ≤200 as grids, beyond that as per-axis summaries (never a fake grid).

import { useEffect, useMemo, useState } from "react";

import type { MediumDTO } from "@aerodb/core";

import { C, MONO } from "@/lib/tokens";
import { deriveFlow } from "./flow-derivation";
import {
  type AmbientPair,
  type AngleSets,
  CAMPAIGN_CONFIRM_THRESHOLD,
  CAMPAIGN_MAX_CONDITIONS,
  type ExcludedCondition,
  comboKey,
  planCombos,
  pointArithmetic,
} from "./plan-model";
import { f, fCount, formatRe, fPressure, fSpeed, fTemp, InfoLine, label as labelStyle } from "./ui";

const GRID_LIMIT = 200;
const LINE_LIMIT = 3;

export interface ConditionPreviewPanelProps {
  medium: MediumDTO | null;
  ambients: AmbientPair[];
  speedsMps: string[];
  chordsM: string[];
  excludedConditions: ExcludedCondition[];
  onToggleExclude: (cell: ExcludedCondition) => void;
  /** Angle sets of the current base sweep (null while invalid). */
  angleSets: AngleSets | null;
  airfoilCount: number;
  symmetricCount: number;
}

interface DerivedCell {
  reynolds: number;
  mach: number | null;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function ConditionPreviewPanel({
  medium,
  ambients,
  speedsMps,
  chordsM,
  excludedConditions,
  onToggleExclude,
  angleSets,
  airfoilCount,
  symmetricCount,
}: ConditionPreviewPanelProps) {
  // Debounce the inputs (~200 ms) so typing in the envelope fields doesn't
  // recompute the grid on every keystroke.
  const snapshot = useDebounced(
    useMemo(
      () => ({ ambients, speedsMps, chordsM, excludedConditions }),
      [ambients, speedsMps, chordsM, excludedConditions],
    ),
    200,
  );

  const combos = useMemo(
    () => planCombos(snapshot.ambients, snapshot.speedsMps, snapshot.chordsM, snapshot.excludedConditions),
    [snapshot],
  );
  const included = combos.filter((c) => !c.excluded);

  const derived = useMemo(() => {
    if (!medium) return new Map<string, DerivedCell>();
    const map = new Map<string, DerivedCell>();
    for (const combo of combos) {
      const d = deriveFlow(medium, Number(combo.temperatureK), Number(combo.pressurePa), Number(combo.speedMps), Number(combo.chordM));
      map.set(combo.comboKey, { reynolds: d.reynolds, mach: d.mach });
    }
    return map;
  }, [medium, combos]);

  const footer = useMemo(() => {
    let reMin = Infinity;
    let reMax = -Infinity;
    let machMin = Infinity;
    let machMax = -Infinity;
    let machKnown = true;
    for (const combo of included) {
      const d = derived.get(combo.comboKey);
      if (!d) continue;
      reMin = Math.min(reMin, d.reynolds);
      reMax = Math.max(reMax, d.reynolds);
      if (d.mach == null) machKnown = false;
      else {
        machMin = Math.min(machMin, d.mach);
        machMax = Math.max(machMax, d.mach);
      }
    }
    return { reMin, reMax, machMin, machMax, machKnown, any: included.length > 0 && derived.size > 0 };
  }, [included, derived]);

  const arithmetic = angleSets ? pointArithmetic(angleSets, airfoilCount - symmetricCount, symmetricCount) : null;
  const totalPoints = arithmetic ? arithmetic.points * included.length : null;
  const totalSolverRuns = arithmetic ? arithmetic.solverRuns * included.length : null;

  const cellText = (key: string) => {
    const d = derived.get(key);
    if (!d) return "—";
    return `Re ${formatRe(d.reynolds)}${d.mach != null ? ` · M ${f(d.mach, 3)}` : ""}`;
  };

  const groups = snapshot.ambients.map(([t, p]) => ({
    t,
    p,
    cells: combos.filter((c) => c.temperatureK === t && c.pressurePa === p),
  }));

  return (
    <div data-testid="condition-preview" style={{ display: "grid", gap: 10, marginTop: 12 }}>
      <div style={labelStyle}>CONDITION PREVIEW · {fCount(included.length)} conditions{combos.length !== included.length ? ` (${combos.length - included.length} excluded)` : ""}</div>

      {combos.length === 0 && <InfoLine text="Add at least one ambient, one speed and one chord to preview conditions." />}

      {combos.length > 0 && combos.length <= LINE_LIMIT && (
        <div style={{ display: "grid", gap: 6 }}>
          {combos.map((combo) => (
            <button
              key={combo.comboKey}
              type="button"
              data-testid={`condition-line-${combo.ord}`}
              onClick={() => onToggleExclude([combo.temperatureK, combo.pressurePa, combo.speedMps, combo.chordM])}
              title={combo.excluded ? "click to include" : "click to exclude"}
              style={{
                textAlign: "left",
                fontFamily: MONO,
                fontSize: 11,
                color: combo.excluded ? C.dimmest : C.text,
                textDecoration: combo.excluded ? "line-through" : "none",
                background: C.panel2,
                border: `1px solid ${combo.excluded ? C.borderSoft : C.stroke}`,
                borderRadius: 6,
                padding: "7px 9px",
                cursor: "pointer",
              }}
            >
              {fTemp(Number(combo.temperatureK))} · {fPressure(Number(combo.pressurePa))} · {fSpeed(Number(combo.speedMps))} · chord {f(Number(combo.chordM), 4)} m → {cellText(combo.comboKey)}
            </button>
          ))}
        </div>
      )}

      {combos.length > LINE_LIMIT && combos.length <= GRID_LIMIT && (
        <div style={{ display: "grid", gap: 12 }}>
          {groups.map((group, gi) => (
            <div key={`${group.t}|${group.p}`} style={{ display: "grid", gap: 6 }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                {fTemp(Number(group.t))} · {fPressure(Number(group.p))}
              </div>
              <div style={{ maxWidth: "100%", overflowX: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: `88px repeat(${snapshot.speedsMps.length}, minmax(96px, 1fr))`, gap: 4, minWidth: 88 + snapshot.speedsMps.length * 100 }}>
                  <span />
                  {snapshot.speedsMps.map((speed) => (
                    <span key={speed} style={{ fontFamily: MONO, fontSize: 10, color: C.dim, textAlign: "center" }}>
                      {fSpeed(Number(speed))}
                    </span>
                  ))}
                  {snapshot.chordsM.map((chord, ci) => (
                    <FragmentRow
                      key={chord}
                      chord={chord}
                      speeds={snapshot.speedsMps}
                      ambient={[group.t, group.p]}
                      excludedSet={new Set(snapshot.excludedConditions.map((x) => x.join("|")))}
                      cellText={cellText}
                      onToggleExclude={onToggleExclude}
                      groupIndex={gi}
                      chordIndex={ci}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
          <InfoLine text="Click a cell to exclude/include that condition — exclusions are saved in the plan." />
        </div>
      )}

      {combos.length > GRID_LIMIT && (
        <div style={{ display: "grid", gap: 6 }}>
          <InfoLine text={`${fCount(combos.length)} combinations — too many to draw; per-axis summary:`} />
          <div style={{ display: "grid", gap: 4, fontFamily: MONO, fontSize: 11, color: C.text }}>
            <span>{snapshot.ambients.length} ambients · {fTemp(Number(snapshot.ambients[0]?.[0]))} … {fTemp(Number(snapshot.ambients[snapshot.ambients.length - 1]?.[0]))}</span>
            <span>{snapshot.speedsMps.length} speeds · {fSpeed(Number(snapshot.speedsMps[0]))} … {fSpeed(Number(snapshot.speedsMps[snapshot.speedsMps.length - 1]))}</span>
            <span>{snapshot.chordsM.length} chords · {f(Number(snapshot.chordsM[0]), 4)} … {f(Number(snapshot.chordsM[snapshot.chordsM.length - 1]), 4)} m</span>
            {snapshot.excludedConditions.length > 0 && <span>{snapshot.excludedConditions.length} excluded cells kept in the plan</span>}
          </div>
        </div>
      )}

      {footer.any && (
        <div data-testid="condition-preview-footer" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: C.dim, borderTop: `1px solid ${C.borderRule}`, paddingTop: 8 }}>
          <span>Re {formatRe(footer.reMin)} – {formatRe(footer.reMax)}</span>
          {footer.machKnown ? (
            <span>M {f(footer.machMin, 3)} – {f(footer.machMax, 3)}</span>
          ) : (
            <span>M — (medium has no speed of sound)</span>
          )}
        </div>
      )}

      {included.length > CAMPAIGN_MAX_CONDITIONS && (
        <InfoLine tone="red" text={`${fCount(included.length)} conditions exceeds the launch limit of ${fCount(CAMPAIGN_MAX_CONDITIONS)} — remove values or exclude cells.`} />
      )}
      {arithmetic && totalPoints != null && totalSolverRuns != null && included.length > 0 && (
        <div data-testid="condition-scale-line" style={{ fontFamily: MONO, fontSize: 11, color: totalPoints > CAMPAIGN_CONFIRM_THRESHOLD ? C.amber : C.dim, lineHeight: 1.4 }}>
          {fCount(included.length)} {included.length === 1 ? "condition" : "conditions"} × {fCount(angleSets!.angles.length)} angles × {fCount(airfoilCount)} airfoils = {fCount(totalPoints)} points · {fCount(totalSolverRuns)} solver runs
          {totalPoints > CAMPAIGN_CONFIRM_THRESHOLD ? ` — large campaign; launch will ask you to confirm by name` : ""}
        </div>
      )}
      {!angleSets && included.length > 0 && (
        <div data-testid="condition-scale-line" style={{ fontFamily: MONO, fontSize: 11, color: C.dim, lineHeight: 1.4 }}>
          {fCount(included.length)} {included.length === 1 ? "condition" : "conditions"} × {fCount(airfoilCount)} airfoils — solver points are set by the angle plan (next step)
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  chord,
  speeds,
  ambient,
  excludedSet,
  cellText,
  onToggleExclude,
  groupIndex,
  chordIndex,
}: {
  chord: string;
  speeds: string[];
  ambient: AmbientPair;
  excludedSet: Set<string>;
  cellText: (key: string) => string;
  onToggleExclude: (cell: ExcludedCondition) => void;
  groupIndex: number;
  chordIndex: number;
}) {
  const [t, p] = ambient;
  return (
    <>
      <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, alignSelf: "center" }}>{f(Number(chord), 4)} m</span>
      {speeds.map((speed, si) => {
        const key = comboKey(t, p, speed, chord);
        const excluded = excludedSet.has(key);
        return (
          <button
            key={key}
            type="button"
            data-testid={`condition-cell-${groupIndex}-${si}-${chordIndex}`}
            aria-pressed={excluded}
            title={excluded ? "excluded — click to include" : "click to exclude"}
            onClick={() => onToggleExclude([t, p, speed, chord])}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: excluded ? C.dimmest : C.text,
              textDecoration: excluded ? "line-through" : "none",
              background: excluded ? "transparent" : C.panel2,
              border: `1px solid ${excluded ? C.borderSoft : C.stroke}`,
              borderRadius: 6,
              padding: "6px 6px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {cellText(key)}
          </button>
        );
      })}
    </>
  );
}
