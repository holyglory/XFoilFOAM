"use client";

import { useState } from "react";

import {
  type PointCorrectionKind,
  type PointCorrectionSettings,
} from "@/lib/point-history";
import { C, MONO } from "@/lib/tokens";

const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  fontFamily: MONO,
  fontSize: 10,
  color: C.text,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 6,
  padding: "5px 6px",
};

const presetCopy: Record<
  PointCorrectionKind,
  { label: string; detail: string }
> = {
  mesh_refinement: {
    label: "Refine mesh",
    detail: "More surface, radial, and wake cells with a larger domain.",
  },
  numerical_stability: {
    label: "Stabilize numerics",
    detail: "Lower Courant limit, longer solve, and modest mesh refinement.",
  },
  longer_sampling: {
    label: "Sample longer",
    detail: "More transient cycles and a longer post-discard averaging window.",
  },
  manual: {
    label: "Manual",
    detail: "Start from the pinned source values and edit every field below.",
  },
};

const roundedScale = (value: number, factor: number) =>
  Math.max(1, Math.ceil(value * factor));

function settingsForKind(
  source: PointCorrectionSettings,
  kind: PointCorrectionKind,
): PointCorrectionSettings {
  const next = structuredClone(source);
  if (kind === "mesh_refinement") {
    next.mesh.nSurface = roundedScale(source.mesh.nSurface, 1.5);
    next.mesh.nRadial = roundedScale(source.mesh.nRadial, 1.35);
    next.mesh.nWake = roundedScale(source.mesh.nWake, 1.35);
    next.mesh.farfieldRadiusChords = Math.max(
      source.mesh.farfieldRadiusChords,
      20,
    );
    next.mesh.wakeLengthChords = Math.max(source.mesh.wakeLengthChords, 16);
  } else if (kind === "numerical_stability") {
    next.mesh.nSurface = roundedScale(source.mesh.nSurface, 1.15);
    next.mesh.nRadial = roundedScale(source.mesh.nRadial, 1.15);
    next.solver.nIterations = roundedScale(source.solver.nIterations, 1.5);
    next.solver.transientCycles = Math.max(
      source.solver.transientCycles * 1.5,
      12,
    );
    next.solver.transientMaxCourant = Math.min(
      source.solver.transientMaxCourant,
      0.5,
    );
  } else if (kind === "longer_sampling") {
    next.solver.transientCycles = Math.max(
      source.solver.transientCycles * 2,
      20,
    );
    next.solver.transientDiscardFraction = Math.min(
      0.7,
      Math.max(source.solver.transientDiscardFraction, 0.5),
    );
    next.solver.transientMaxCourant = Math.min(
      source.solver.transientMaxCourant,
      1,
    );
  }
  return next;
}

function NumericField({
  label,
  value,
  min,
  max,
  step,
  integer = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ color: C.dim, fontSize: 9 }}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed))
            onChange(integer ? Math.round(parsed) : parsed);
        }}
        style={inputStyle}
      />
    </label>
  );
}

export function PointCorrectionForm({
  source,
  recommended,
  busy,
  onSubmit,
}: {
  source: PointCorrectionSettings;
  recommended: PointCorrectionKind[];
  busy: boolean;
  onSubmit: (
    settings: PointCorrectionSettings,
    fidelity: "precalc" | "full",
  ) => void;
}) {
  const initialKind = recommended[0] ?? "manual";
  const [kind, setKind] = useState<PointCorrectionKind>(initialKind);
  const [settings, setSettings] = useState<PointCorrectionSettings>(() =>
    settingsForKind(source, initialKind),
  );
  const [fidelity, setFidelity] = useState<"precalc" | "full">("precalc");

  const chooseKind = (nextKind: PointCorrectionKind) => {
    setKind(nextKind);
    setSettings(settingsForKind(source, nextKind));
  };
  const setMesh = <K extends keyof PointCorrectionSettings["mesh"]>(
    key: K,
    value: PointCorrectionSettings["mesh"][K],
  ) =>
    setSettings((current) => ({
      ...current,
      mesh: { ...current.mesh, [key]: value },
    }));
  const setSolver = <K extends keyof PointCorrectionSettings["solver"]>(
    key: K,
    value: PointCorrectionSettings["solver"][K],
  ) =>
    setSettings((current) => ({
      ...current,
      solver: { ...current.solver, [key]: value },
    }));

  return (
    <section
      data-testid="point-correction-form"
      style={{
        display: "grid",
        gap: 9,
        padding: 9,
        border: `1px solid ${C.borderSoft}`,
        borderRadius: 8,
        background: C.panel2,
        fontFamily: MONO,
        fontSize: 10,
      }}
    >
      <div style={{ display: "grid", gap: 3 }}>
        <strong style={{ color: C.text }}>Run a corrected setup</strong>
        <span style={{ color: C.muted, lineHeight: 1.45 }}>
          Creates a new immutable, single-angle setup. The original campaign and
          its evidence are unchanged. Presets are starting points, not an
          acceptance guarantee.
        </span>
      </div>

      <div style={{ display: "grid", gap: 5 }}>
        {recommended.map((candidate) => {
          const copy = presetCopy[candidate];
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={kind === candidate}
              data-testid={`point-correction-${candidate}`}
              onClick={() => chooseKind(candidate)}
              style={{
                display: "grid",
                gap: 2,
                textAlign: "left",
                fontFamily: MONO,
                fontSize: 9.5,
                color: kind === candidate ? C.teal : C.muted,
                background: kind === candidate ? C.tealFill : C.panel3,
                border: `1px solid ${kind === candidate ? C.tealBorder : C.stroke}`,
                borderRadius: 7,
                padding: "6px 8px",
                cursor: "pointer",
              }}
            >
              <strong>{copy.label}</strong>
              <span style={{ color: C.dim }}>{copy.detail}</span>
            </button>
          );
        })}
      </div>

      <details open>
        <summary style={{ color: C.muted, cursor: "pointer" }}>
          Mesh settings
        </summary>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 7,
            marginTop: 7,
          }}
        >
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ color: C.dim, fontSize: 9 }}>mesher</span>
            <input
              value={settings.mesh.mesher}
              onChange={(event) => setMesh("mesher", event.target.value)}
              style={inputStyle}
            />
          </label>
          <NumericField
            label="surface cells"
            value={settings.mesh.nSurface}
            min={20}
            max={10000}
            step={10}
            integer
            onChange={(value) => setMesh("nSurface", value)}
          />
          <NumericField
            label="radial cells"
            value={settings.mesh.nRadial}
            min={10}
            max={5000}
            step={5}
            integer
            onChange={(value) => setMesh("nRadial", value)}
          />
          <NumericField
            label="wake cells"
            value={settings.mesh.nWake}
            min={10}
            max={5000}
            step={5}
            integer
            onChange={(value) => setMesh("nWake", value)}
          />
          <NumericField
            label="farfield [chords]"
            value={settings.mesh.farfieldRadiusChords}
            min={1}
            max={500}
            step={1}
            onChange={(value) => setMesh("farfieldRadiusChords", value)}
          />
          <NumericField
            label="wake [chords]"
            value={settings.mesh.wakeLengthChords}
            min={1}
            max={500}
            step={1}
            onChange={(value) => setMesh("wakeLengthChords", value)}
          />
          <NumericField
            label="target y+"
            value={settings.mesh.targetYPlus}
            min={0.01}
            max={1000}
            step={0.1}
            onChange={(value) => setMesh("targetYPlus", value)}
          />
          <NumericField
            label="span [chords]"
            value={settings.mesh.spanChords}
            min={0.001}
            max={100}
            step={0.01}
            onChange={(value) => setMesh("spanChords", value)}
          />
        </div>
      </details>

      <details open>
        <summary style={{ color: C.muted, cursor: "pointer" }}>
          Solver settings
        </summary>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: 7,
            marginTop: 7,
          }}
        >
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ color: C.dim, fontSize: 9 }}>turbulence model</span>
            <input
              value={settings.solver.turbulenceModel}
              onChange={(event) =>
                setSolver("turbulenceModel", event.target.value)
              }
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ color: C.dim, fontSize: 9 }}>momentum scheme</span>
            <input
              value={settings.solver.momentumScheme}
              onChange={(event) =>
                setSolver("momentumScheme", event.target.value)
              }
              style={inputStyle}
            />
          </label>
          <NumericField
            label="iterations"
            value={settings.solver.nIterations}
            min={100}
            max={1000000}
            step={100}
            integer
            onChange={(value) => setSolver("nIterations", value)}
          />
          <NumericField
            label="convergence tolerance"
            value={settings.solver.convergenceTolerance}
            min={1e-12}
            max={1}
            step={1e-6}
            onChange={(value) => setSolver("convergenceTolerance", value)}
          />
          <NumericField
            label="transient cycles"
            value={settings.solver.transientCycles}
            min={0.1}
            max={10000}
            step={1}
            onChange={(value) => setSolver("transientCycles", value)}
          />
          <NumericField
            label="discard fraction"
            value={settings.solver.transientDiscardFraction}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(value) => setSolver("transientDiscardFraction", value)}
          />
          <NumericField
            label="max Courant"
            value={settings.solver.transientMaxCourant}
            min={0.01}
            max={100}
            step={0.1}
            onChange={(value) => setSolver("transientMaxCourant", value)}
          />
        </div>
      </details>

      <label style={{ display: "grid", gap: 3 }}>
        <span style={{ color: C.dim, fontSize: 9 }}>URANS tier</span>
        <select
          value={fidelity}
          onChange={(event) =>
            setFidelity(event.target.value as "precalc" | "full")
          }
          style={inputStyle}
        >
          <option value="precalc">FAST URANS — screen the correction</option>
          <option value="full">FULL URANS — final-fidelity correction</option>
        </select>
      </label>
      <button
        type="button"
        data-testid="point-correction-submit"
        disabled={busy}
        onClick={() => onSubmit(settings, fidelity)}
        style={{
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 700,
          color: C.bg,
          background: C.teal,
          border: "none",
          borderRadius: 7,
          padding: "7px 10px",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.65 : 1,
        }}
      >
        {busy ? "creating corrected run…" : "Create corrected run"}
      </button>
    </section>
  );
}
