"use client";

import { useState } from "react";

import {
  type PointCorrectionKind,
  type PointCorrectionSettings,
  pointCorrectionSettingsForKind,
  pointCorrectionSettingsValid,
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
    label: "Edit pinned values",
    detail:
      "Reload the current mesh and solver values, then adjust them below.",
  },
};

const within = (value: number, min: number, max: number) =>
  Number.isFinite(value) && value >= min && value <= max;

function NumericField({
  label,
  value,
  sourceValue,
  min,
  max,
  step,
  integer = false,
  onChange,
}: {
  label: string;
  value: number;
  sourceValue: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  const invalid = !Number.isFinite(value) || value < min || value > max;
  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 5,
          color: C.dim,
          fontSize: 9,
        }}
      >
        <span>{label}</span>
        <span style={{ color: value === sourceValue ? C.dim : C.amber }}>
          {value === sourceValue ? "pinned" : `was ${sourceValue}`}
        </span>
      </span>
      <input
        type="number"
        aria-invalid={invalid || undefined}
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

function TextField({
  label,
  value,
  sourceValue,
  onChange,
}: {
  label: string;
  value: string;
  sourceValue: string;
  onChange: (value: string) => void;
}) {
  const invalid = value.trim().length === 0;
  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 5,
          color: C.dim,
          fontSize: 9,
        }}
      >
        <span>{label}</span>
        <span style={{ color: value === sourceValue ? C.dim : C.amber }}>
          {value === sourceValue ? "pinned" : `was ${sourceValue}`}
        </span>
      </span>
      <input
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        style={inputStyle}
      />
    </label>
  );
}

export interface PointRecalculationIdentity {
  airfoilName: string;
  aoaDeg: number;
  reynolds: number | null;
  mach: number | null;
  speed: number | null;
}

export function PointCorrectionForm({
  identity,
  source,
  recommended,
  busy,
  onSubmit,
}: {
  identity: PointRecalculationIdentity;
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
    pointCorrectionSettingsForKind(source, initialKind),
  );
  const [fidelity, setFidelity] = useState<"precalc" | "full">("precalc");

  const chooseKind = (nextKind: PointCorrectionKind) => {
    setKind(nextKind);
    setSettings(pointCorrectionSettingsForKind(source, nextKind));
  };
  const setMesh = <K extends keyof PointCorrectionSettings["mesh"]>(
    key: K,
    value: PointCorrectionSettings["mesh"][K],
  ) =>
    setSettings((current) => ({
      ...current,
      mesh: { ...current.mesh, [key]: value },
    }));

  const changedCount =
    Object.entries(settings.mesh).filter(
      ([key, value]) =>
        value !== source.mesh[key as keyof PointCorrectionSettings["mesh"]],
    ).length +
    Object.entries(settings.solver).filter(
      ([key, value]) =>
        value !== source.solver[key as keyof PointCorrectionSettings["solver"]],
    ).length;
  const identityParts = [
    identity.airfoilName,
    `α ${identity.aoaDeg}°`,
    identity.reynolds == null
      ? null
      : `Re ${Math.round(identity.reynolds).toLocaleString("en-US")}`,
    identity.mach == null ? null : `M ${identity.mach}`,
    identity.speed == null ? null : `${identity.speed} m/s`,
  ].filter((value): value is string => value != null);
  const settingsValid = pointCorrectionSettingsValid(settings);
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
        gap: 12,
        padding: 11,
        border: `1px solid ${C.tealBorder}`,
        borderRadius: 8,
        background: C.panel2,
        fontFamily: MONO,
        fontSize: 10,
      }}
    >
      <div style={{ display: "grid", gap: 5 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <strong style={{ color: C.text, fontSize: 11.5 }}>
            Recalculate from scratch
          </strong>
          <span
            style={{
              color: C.teal,
              border: `1px solid ${C.tealBorder}`,
              background: C.tealFill,
              borderRadius: 999,
              padding: "2px 7px",
              fontSize: 9,
            }}
          >
            fresh case · starts at t = 0
          </span>
        </div>
        <span style={{ color: C.muted, lineHeight: 1.45 }}>
          Creates a new immutable, single-angle setup and leaves the original
          campaign and evidence unchanged. It does not need a restart
          checkpoint.
        </span>
      </div>

      <div
        data-testid="point-recalculation-identity"
        style={{
          display: "grid",
          gap: 5,
          padding: 8,
          background: C.panel3,
          border: `1px solid ${C.stroke}`,
          borderRadius: 7,
        }}
      >
        <strong style={{ color: C.muted, fontSize: 9.5 }}>
          POINT STAYS FIXED
        </strong>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {identityParts.map((part) => (
            <span
              key={part}
              style={{
                color: C.text,
                border: `1px solid ${C.borderSoft}`,
                borderRadius: 999,
                padding: "2px 6px",
                fontSize: 9,
              }}
            >
              {part}
            </span>
          ))}
        </div>
        <span style={{ color: C.dim, fontSize: 9, lineHeight: 1.45 }}>
          Airfoil, AoA, flow, geometry, and boundary profiles stay pinned. Only
          the mesh, numerical settings, and URANS tier below can change.
        </span>
      </div>

      <div style={{ display: "grid", gap: 5 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <strong style={{ color: C.muted, fontSize: 9.5 }}>
            STARTING PARAMETERS
          </strong>
          <span style={{ color: C.dim, fontSize: 8.5 }}>
            presets pre-fill the editor
          </span>
        </div>
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
              <strong>
                {copy.label}
                {candidate === recommended[0] && candidate !== "manual"
                  ? " · recommended"
                  : ""}
              </strong>
              <span style={{ color: C.dim }}>{copy.detail}</span>
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span
          data-testid="point-recalculation-change-count"
          style={{ color: changedCount > 0 ? C.amber : C.dim, fontSize: 9 }}
        >
          {changedCount === 0
            ? "using all pinned values"
            : `${changedCount} parameter${changedCount === 1 ? "" : "s"} changed from pinned`}
        </span>
        <button
          type="button"
          data-testid="point-correction-reset"
          onClick={() => chooseKind("manual")}
          style={{
            ...inputStyle,
            width: "auto",
            color: C.muted,
            cursor: "pointer",
            padding: "4px 7px",
          }}
        >
          Reset to pinned
        </button>
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
          <TextField
            label="mesher"
            value={settings.mesh.mesher}
            sourceValue={source.mesh.mesher}
            onChange={(value) => setMesh("mesher", value)}
          />
          <NumericField
            label="surface cells"
            value={settings.mesh.nSurface}
            sourceValue={source.mesh.nSurface}
            min={20}
            max={10000}
            step={10}
            integer
            onChange={(value) => setMesh("nSurface", value)}
          />
          <NumericField
            label="radial cells"
            value={settings.mesh.nRadial}
            sourceValue={source.mesh.nRadial}
            min={10}
            max={5000}
            step={5}
            integer
            onChange={(value) => setMesh("nRadial", value)}
          />
          <NumericField
            label="wake cells"
            value={settings.mesh.nWake}
            sourceValue={source.mesh.nWake}
            min={10}
            max={5000}
            step={5}
            integer
            onChange={(value) => setMesh("nWake", value)}
          />
          <NumericField
            label="farfield [chords]"
            value={settings.mesh.farfieldRadiusChords}
            sourceValue={source.mesh.farfieldRadiusChords}
            min={1}
            max={500}
            step={1}
            onChange={(value) => setMesh("farfieldRadiusChords", value)}
          />
          <NumericField
            label="wake [chords]"
            value={settings.mesh.wakeLengthChords}
            sourceValue={source.mesh.wakeLengthChords}
            min={1}
            max={500}
            step={1}
            onChange={(value) => setMesh("wakeLengthChords", value)}
          />
          <NumericField
            label="target y+"
            value={settings.mesh.targetYPlus}
            sourceValue={source.mesh.targetYPlus}
            min={0.01}
            max={1000}
            step={0.1}
            onChange={(value) => setMesh("targetYPlus", value)}
          />
          <NumericField
            label="span [chords]"
            value={settings.mesh.spanChords}
            sourceValue={source.mesh.spanChords}
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
          <TextField
            label="turbulence model"
            value={settings.solver.turbulenceModel}
            sourceValue={source.solver.turbulenceModel}
            onChange={(value) => setSolver("turbulenceModel", value)}
          />
          <TextField
            label="momentum scheme"
            value={settings.solver.momentumScheme}
            sourceValue={source.solver.momentumScheme}
            onChange={(value) => setSolver("momentumScheme", value)}
          />
          <NumericField
            label="iterations"
            value={settings.solver.nIterations}
            sourceValue={source.solver.nIterations}
            min={100}
            max={1000000}
            step={100}
            integer
            onChange={(value) => setSolver("nIterations", value)}
          />
          <NumericField
            label="convergence tolerance"
            value={settings.solver.convergenceTolerance}
            sourceValue={source.solver.convergenceTolerance}
            min={1e-12}
            max={1}
            step={1e-6}
            onChange={(value) => setSolver("convergenceTolerance", value)}
          />
          <NumericField
            label="transient cycles"
            value={settings.solver.transientCycles}
            sourceValue={source.solver.transientCycles}
            min={0.1}
            max={10000}
            step={1}
            onChange={(value) => setSolver("transientCycles", value)}
          />
          <NumericField
            label="discard fraction"
            value={settings.solver.transientDiscardFraction}
            sourceValue={source.solver.transientDiscardFraction}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(value) => setSolver("transientDiscardFraction", value)}
          />
          <NumericField
            label="max Courant"
            value={settings.solver.transientMaxCourant}
            sourceValue={source.solver.transientMaxCourant}
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
      <div
        data-testid="point-recalculation-summary"
        style={{
          color: C.muted,
          background: C.panel3,
          border: `1px solid ${C.stroke}`,
          borderRadius: 7,
          padding: 8,
          lineHeight: 1.5,
          fontSize: 9.5,
        }}
      >
        A fresh {fidelity === "full" ? "FULL" : "FAST"} URANS case will start at
        time zero on a new immutable revision. Previous attempts remain
        available as evidence.
      </div>
      {!settingsValid ? (
        <div
          role="alert"
          data-testid="point-recalculation-validation"
          style={{ color: C.amber, fontSize: 9.5 }}
        >
          Fix the highlighted parameter before queuing this recalculation.
        </div>
      ) : null}
      <button
        type="button"
        data-testid="point-correction-submit"
        disabled={busy || !settingsValid}
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
          cursor: busy || !settingsValid ? "default" : "pointer",
          opacity: busy || !settingsValid ? 0.65 : 1,
        }}
      >
        {busy
          ? "queuing fresh recalculation…"
          : `Queue fresh ${fidelity === "full" ? "FULL" : "FAST"} URANS recalculation`}
      </button>
    </section>
  );
}
