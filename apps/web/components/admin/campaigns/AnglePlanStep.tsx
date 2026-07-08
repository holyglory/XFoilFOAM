"use client";

// Wizard step 3 (spec §11): base sweep (range or explicit list), objective
// toggle cards in decision language, and the symmetric-savings line computed
// from the REAL selected airfoils' isSymmetric flags — shown only when it is
// genuinely non-zero (spec §9.3/§12).

import type { AdminAirfoilOption } from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { parseAngleListText, pointArithmetic, sweepSetsOf, type WizardAnglePlan } from "./plan-model";
import { fCount, ghostBtn, InfoLine, inputStyle, issueFor, label as labelStyle, miniLabel, NumberField, type ValidationIssue, ValidationSummary, validationText } from "./ui";

export interface AnglePlanStepProps {
  angle: WizardAnglePlan;
  onAngle: (patch: Partial<WizardAnglePlan>) => void;
  resolvedAirfoils: AdminAirfoilOption[];
  conditionCount: number;
  issues: ValidationIssue[];
}

const OBJECTIVE_CARDS: Array<{
  key: "ldMax" | "clZero" | "clMax";
  title: string;
  decision: string;
  detail: string;
  toleranceField: string;
  roundsField: string;
}> = [
  {
    key: "ldMax",
    title: "Find the max-L/D angle",
    decision: "Keep solving single extra angles until the best glide angle is pinned down.",
    detail: "Each round fits the polar, predicts α(L/D max), solves that one angle, and stops when the prediction is confirmed within tolerance.",
    toleranceField: "Max L/D tolerance ±°",
    roundsField: "Max L/D rounds",
  },
  {
    key: "clZero",
    title: "Find the zero-lift angle",
    decision: "Keep solving single extra angles until α(Cl = 0) is pinned down.",
    detail: "Same loop against the Cl = 0 crossing. Symmetric airfoils skip this — their zero-lift angle is 0° by definition.",
    toleranceField: "Zero-lift tolerance ±°",
    roundsField: "Zero-lift rounds",
  },
  {
    key: "clMax",
    title: "Find the Cl_max angle",
    decision: "Keep solving single extra angles until the maximum-lift angle is pinned down.",
    detail: "Same loop against the Cl peak: each round fits the polar, predicts α(Cl max), solves that one angle, and stops when the prediction is confirmed within tolerance.",
    toleranceField: "Cl_max tolerance ±°",
    roundsField: "Cl_max rounds",
  },
];

export function AnglePlanStep({ angle, onAngle, resolvedAirfoils, conditionCount, issues }: AnglePlanStepProps) {
  const expansion = sweepSetsOf(angle);
  const listParse = parseAngleListText(angle.listText);
  const symmetricCount = resolvedAirfoils.filter((a) => a.isSymmetric).length;
  const asymmetricCount = resolvedAirfoils.length - symmetricCount;

  let savingsLine: string | null = null;
  if (expansion.sets && symmetricCount > 0 && conditionCount > 0) {
    const withSymmetry = pointArithmetic(expansion.sets, asymmetricCount, symmetricCount);
    const withoutSymmetry = pointArithmetic(expansion.sets, asymmetricCount + symmetricCount, 0);
    const savedRuns = (withoutSymmetry.solverRuns - withSymmetry.solverRuns) * conditionCount;
    const derivedPoints = withSymmetry.derivedPoints * conditionCount;
    if (savedRuns > 0) {
      savingsLine = `${fCount(symmetricCount)} symmetric airfoil${symmetricCount === 1 ? "" : "s"} solve positive angles only — ${fCount(savedRuns)} solver runs saved; ${fCount(derivedPoints)} points derived by symmetry.`;
    }
  }

  return (
    <div data-testid="wizard-angle-plan" style={{ display: "grid", gap: 12 }}>
      <div style={labelStyle}>3 · ANGLE PLAN</div>

      <div style={{ display: "flex", gap: 8 }}>
        {(["range", "list"] as const).map((mode) => {
          const on = angle.sweepMode === mode;
          return (
            <button
              key={mode}
              type="button"
              data-testid={`sweep-mode-${mode}`}
              aria-pressed={on}
              onClick={() => onAngle({ sweepMode: mode })}
              style={{ ...ghostBtn, padding: "7px 12px", color: on ? C.teal : C.muted, borderColor: on ? C.tealBorder : C.stroke, background: on ? C.tealFill : C.panel3 }}
            >
              {mode === "range" ? "from / to / step" : "explicit list"}
            </button>
          );
        })}
      </div>

      {angle.sweepMode === "range" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <NumberField label="AoA from °" step={0.5} value={angle.fromDeg} error={issueFor(issues, "AoA from °")} onChange={(fromDeg) => onAngle({ fromDeg })} />
          <NumberField label="AoA to °" step={0.5} value={angle.toDeg} error={issueFor(issues, "AoA to °")} onChange={(toDeg) => onAngle({ toDeg })} />
          <NumberField label="AoA step °" step={0.1} value={angle.stepDeg} error={issueFor(issues, "AoA step °")} onChange={(stepDeg) => onAngle({ stepDeg })} />
        </div>
      ) : (
        <label style={{ display: "block" }} data-admin-field="AoA list °">
          <div style={miniLabel}>AoA list ° (comma or space separated)</div>
          <textarea
            aria-label="AoA list °"
            data-testid="sweep-list-input"
            rows={3}
            value={angle.listText}
            onChange={(e) => onAngle({ listText: e.target.value })}
            aria-invalid={!!issueFor(issues, "AoA list °")}
            style={{ ...inputStyle, resize: "vertical", borderColor: issueFor(issues, "AoA list °") ? C.red : C.stroke }}
          />
          {listParse.invalidTokens.length > 0 && <div style={validationText}>not numbers: {listParse.invalidTokens.slice(0, 5).join(", ")}</div>}
          {issueFor(issues, "AoA list °") && <div style={validationText}>{issueFor(issues, "AoA list °")}</div>}
        </label>
      )}

      <div data-testid="sweep-angle-count" style={{ fontFamily: MONO, fontSize: 11, color: expansion.sets ? C.dim : C.red }}>
        {expansion.sets
          ? `${fCount(expansion.sets.angles.length)} angles · ${expansion.sets.angles[0]}° … ${expansion.sets.angles[expansion.sets.angles.length - 1]}°`
          : expansion.error}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        {OBJECTIVE_CARDS.map((cardDef) => {
          const state = angle[cardDef.key];
          const on = state.enabled;
          return (
            <div
              key={cardDef.key}
              data-testid={`objective-card-${cardDef.key}`}
              style={{ border: `1px solid ${on ? C.tealBorder : C.stroke}`, background: on ? C.tealFill : C.panel2, borderRadius: 10, padding: "10px 12px", display: "grid", gap: 6 }}
            >
              <button
                type="button"
                data-testid={`objective-toggle-${cardDef.key}`}
                aria-pressed={on}
                onClick={() => onAngle({ [cardDef.key]: { ...state, enabled: !on } } as Partial<WizardAnglePlan>)}
                style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", gap: 10, alignItems: "start", textAlign: "left", background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
              >
                <span aria-hidden style={{ width: 13, height: 13, marginTop: 2, borderRadius: 3, border: `1px solid ${on ? C.teal : C.dim}`, background: on ? C.teal : "transparent" }} />
                <span style={{ display: "grid", gap: 3 }}>
                  <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: on ? C.teal : C.text }}>{cardDef.title}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.text2 }}>{cardDef.decision}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, lineHeight: 1.4 }}>{cardDef.detail}</span>
                </span>
              </button>
              {on && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginLeft: 28 }}>
                  <NumberField
                    label={cardDef.toleranceField}
                    step={0.01}
                    value={state.toleranceDeg}
                    error={issueFor(issues, cardDef.toleranceField)}
                    onChange={(toleranceDeg) => onAngle({ [cardDef.key]: { ...state, toleranceDeg } } as Partial<WizardAnglePlan>)}
                  />
                  <NumberField
                    label={cardDef.roundsField}
                    step={1}
                    value={state.maxRounds}
                    error={issueFor(issues, cardDef.roundsField)}
                    onChange={(maxRounds) => onAngle({ [cardDef.key]: { ...state, maxRounds } } as Partial<WizardAnglePlan>)}
                  />
                </div>
              )}
            </div>
          );
        })}
        {(angle.ldMax.enabled || angle.clZero.enabled || angle.clMax.enabled) && expansion.sets && expansion.sets.angles.length < 3 && (
          <InfoLine tone="red" text="Refinement objectives need a base sweep of at least 3 angles to seed the first fit." />
        )}
      </div>

      {savingsLine && <InfoLine tone="teal" text={savingsLine} />}
      {symmetricCount > 0 && angle.clZero.enabled && (
        <InfoLine text={`${fCount(symmetricCount)} symmetric airfoil${symmetricCount === 1 ? "" : "s"}: zero-lift is 0° by definition — no lanes will solve for them.`} />
      )}

      <ValidationSummary issues={issues} />
    </div>
  );
}
