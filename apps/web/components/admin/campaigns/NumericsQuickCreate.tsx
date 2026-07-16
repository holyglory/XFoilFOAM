"use client";

// "+ new profile" for the wizard's Review numerics slots (spec §11): a
// save-as-new modal over the wizard for all four numerics registries
// (boundary / mesh / solver / output). Each form carries the COMPLETE field
// set the corresponding POST /api/admin/*-profiles endpoint accepts, with the
// same domain conventions as the Setup library editors: boundary keeps the
// νt/ν preset select with the raw value behind an advanced disclosure, mesh
// embeds the live C-grid infographic (the exported MeshSettingsGuide — never a
// duplicate), solver hides the URANS knobs behind an advanced disclosure, and
// output exposes the stored-image multi-select. Prefill comes from the slot's
// currently selected profile (starting point) or the Setup editors' exact
// new-record defaults — never invented values. Existing rows are never
// mutated; creation always POSTs a new record.

import { useState } from "react";
import { DEFAULT_TRANSIENT_MAX_COURANT } from "@aerodb/core";

import {
  type AdminBoundaryProfile,
  type AdminMeshProfile,
  type AdminOutputProfile,
  type AdminSimulationSetup,
  type AdminSolverImplementation,
  type AdminSolverProfile,
  type BoundaryProfileInput,
  createBoundaryProfile,
  createMeshProfile,
  createOutputProfile,
  createSolverProfile,
  type MeshProfileInput,
  type OutputProfileInput,
  type SolverProfileInput,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import {
  ALL_IMAGE_FIELDS,
  IMAGE_FIELD_LABELS,
  MeshSettingsGuide,
  TurbulentViscosityRatioField,
} from "../AdminConsole";
import { momentumSchemeSelect } from "../solver-schemes";
import {
  compactIssues,
  ErrorLine,
  focusValidationIssue,
  InfoLine,
  miniLabel,
  ModalOverlay,
  nonNegativeIssue,
  NumberField,
  positiveIntegerIssue,
  positiveIssue,
  primaryBtn,
  requiredChoiceIssue,
  requiredIssue,
  SelectField,
  TextField,
  issueFor,
  type ValidationIssue,
  ValidationSummary,
} from "./ui";

export type NumericsProfileKind = "boundary" | "mesh" | "solver" | "output";
export type NumericsProfileRow =
  | AdminBoundaryProfile
  | AdminMeshProfile
  | AdminSolverProfile
  | AdminOutputProfile;

// New-record defaults mirror the Setup library editors in AdminConsole.tsx
// (defaultBoundaryForm/defaultMeshForm/defaultSolverForm/defaultOutputForm)
// byte-for-byte — these are the library's real new-record values, not
// invented ones.
const defaultBoundaryForm = (): BoundaryProfileInput => ({
  name: "",
  turbulenceIntensity: 0.001,
  viscosityRatio: 10,
  sandGrainHeight: 0,
  roughnessConstant: 0.5,
});
const defaultMeshForm = (): MeshProfileInput => ({
  name: "",
  mesher: "blockmesh-cgrid",
  farfieldRadiusChords: 15,
  wakeLengthChords: 12,
  nSurface: 130,
  nRadial: 80,
  nWake: 60,
  targetYPlus: 1,
  spanChords: 0.1,
});
const defaultSolverForm = (
  solverImplementationId: string,
): SolverProfileInput => ({
  name: "",
  solverImplementationId,
  turbulenceModel: "kOmegaSST",
  nIterations: 3000,
  convergenceTolerance: 1e-5,
  momentumScheme: "linearUpwind",
  transientCycles: 10,
  transientDiscardFraction: 0.4,
  transientMaxCourant: DEFAULT_TRANSIENT_MAX_COURANT,
});
const defaultOutputForm = (): OutputProfileInput => ({
  name: "",
  writeImages: [...ALL_IMAGE_FIELDS],
  imageZoomChords: 2,
});

// Same enumerated engine choices the Setup editors expose (single supported
// option stays hidden per DecisionHistory 2026-07-01 single-option decision).
const MESH_MESHER_OPTIONS = [
  { value: "blockmesh-cgrid", label: "C-grid blockMesh" },
];
const TURBULENCE_MODEL_OPTIONS = [
  "kOmegaSST",
  "kOmegaSSTLM",
  "kOmega",
  "kEpsilon",
  "SpalartAllmaras",
];

function optionValues(options: { value: string }[], current: string) {
  const values = options.map((option) => option.value);
  return values.includes(current) ? values : [current, ...values];
}

function optionLabels(
  options: { value: string; label: string }[],
  current: string,
) {
  return Object.fromEntries(
    optionValues(options, current).map((value) => [
      value,
      options.find((option) => option.value === value)?.label ?? value,
    ]),
  );
}

function shouldShowOption(options: { value: string }[], current: string) {
  return (
    options.length > 1 || !options.some((option) => option.value === current)
  );
}

const twoCol = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
} as const;

function StartingPointLine({ name }: { name: string }) {
  return (
    <InfoLine
      text={`starting from “${name}” — saving creates a NEW profile; the existing one is never changed`}
    />
  );
}

function SaveRow({
  busy,
  label,
  onSave,
  issues,
}: {
  busy: boolean;
  label: string;
  onSave: () => void;
  issues: ValidationIssue[];
}) {
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <ValidationSummary issues={issues} />
      <button
        type="button"
        data-testid="wizard-numerics-modal-save"
        disabled={busy}
        onClick={onSave}
        style={{ ...primaryBtn(busy), width: "100%" }}
      >
        {busy ? "saving…" : label}
      </button>
    </div>
  );
}

function useQuickCreateSubmit<TInput extends { slug?: string }, TRow>(
  create: (body: TInput) => Promise<TRow>,
  onCreated: (row: TRow) => void,
) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const submit = (validate: () => ValidationIssue[], body: TInput) => {
    const next = validate();
    if (next.length) {
      setIssues(next);
      focusValidationIssue(next[0]);
      return;
    }
    setIssues([]);
    setBusy(true);
    setErr(null);
    create({ ...body, slug: body.slug?.trim() || undefined })
      .then(onCreated)
      .catch((e) => setErr((e as Error).message))
      .finally(() => setBusy(false));
  };
  return { busy, err, issues, submit };
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------
function BoundaryQuickCreateModal({
  startFrom,
  onCreated,
  onClose,
}: {
  startFrom: AdminBoundaryProfile | null;
  onCreated: (row: AdminBoundaryProfile) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<BoundaryProfileInput>(() =>
    startFrom
      ? {
          name: "",
          turbulenceIntensity: startFrom.turbulenceIntensity,
          viscosityRatio: startFrom.viscosityRatio,
          sandGrainHeight: startFrom.sandGrainHeight,
          roughnessConstant: startFrom.roughnessConstant,
        }
      : defaultBoundaryForm(),
  );
  const { busy, err, issues, submit } = useQuickCreateSubmit(
    createBoundaryProfile,
    onCreated,
  );
  const validate = () =>
    compactIssues([
      requiredIssue(form.name, "Name"),
      nonNegativeIssue(form.turbulenceIntensity, "Turbulence intensity"),
      positiveIssue(form.viscosityRatio, "Turbulent viscosity ratio νt/ν"),
      nonNegativeIssue(form.sandGrainHeight, "Roughness Ks"),
      positiveIssue(form.roughnessConstant, "Roughness constant"),
    ]);
  return (
    <ModalOverlay
      title="NEW BOUNDARY PROFILE"
      testId="wizard-numerics-modal"
      onClose={onClose}
    >
      {err && <ErrorLine text={err} />}
      {startFrom && <StartingPointLine name={startFrom.name} />}
      <TextField
        label="Name"
        value={form.name}
        error={issueFor(issues, "Name")}
        onChange={(name) => setForm((f) => ({ ...f, name }))}
      />
      <TextField
        label="Slug optional"
        value={form.slug ?? ""}
        onChange={(slug) => setForm((f) => ({ ...f, slug }))}
      />
      <div style={twoCol}>
        <NumberField
          label="Turbulence intensity"
          value={form.turbulenceIntensity}
          error={issueFor(issues, "Turbulence intensity")}
          onChange={(turbulenceIntensity) =>
            setForm((f) => ({ ...f, turbulenceIntensity }))
          }
        />
        <TurbulentViscosityRatioField
          value={form.viscosityRatio}
          error={issueFor(issues, "Turbulent viscosity ratio νt/ν")}
          onChange={(viscosityRatio) =>
            setForm((f) => ({ ...f, viscosityRatio }))
          }
        />
        <NumberField
          label="Roughness Ks"
          value={form.sandGrainHeight}
          error={issueFor(issues, "Roughness Ks")}
          onChange={(sandGrainHeight) =>
            setForm((f) => ({ ...f, sandGrainHeight }))
          }
        />
        <NumberField
          label="Roughness constant"
          value={form.roughnessConstant}
          error={issueFor(issues, "Roughness constant")}
          onChange={(roughnessConstant) =>
            setForm((f) => ({ ...f, roughnessConstant }))
          }
        />
      </div>
      <SaveRow
        busy={busy}
        label="create boundary profile"
        issues={issues}
        onSave={() => submit(validate, form)}
      />
    </ModalOverlay>
  );
}

// ---------------------------------------------------------------------------
// Mesh — embeds the ONE live C-grid infographic (exported from AdminConsole).
// Wide modal (min(96vw, 1000px)) with its own scroll keeps the bitmap
// readable; explanations render below the artifact inside the guide.
// ---------------------------------------------------------------------------
function MeshQuickCreateModal({
  startFrom,
  onCreated,
  onClose,
}: {
  startFrom: AdminMeshProfile | null;
  onCreated: (row: AdminMeshProfile) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<MeshProfileInput>(() =>
    startFrom
      ? {
          name: "",
          mesher: startFrom.mesher,
          farfieldRadiusChords: startFrom.farfieldRadiusChords,
          wakeLengthChords: startFrom.wakeLengthChords,
          nSurface: startFrom.nSurface,
          nRadial: startFrom.nRadial,
          nWake: startFrom.nWake,
          targetYPlus: startFrom.targetYPlus,
          spanChords: startFrom.spanChords,
        }
      : defaultMeshForm(),
  );
  const { busy, err, issues, submit } = useQuickCreateSubmit(
    createMeshProfile,
    onCreated,
  );
  const validate = () =>
    compactIssues([
      requiredIssue(form.name, "Name"),
      requiredChoiceIssue(form.mesher, "Mesher"),
      positiveIssue(form.farfieldRadiusChords, "Farfield"),
      positiveIssue(form.wakeLengthChords, "Wake length"),
      positiveIntegerIssue(form.nSurface, "Surface"),
      positiveIntegerIssue(form.nRadial, "Radial"),
      positiveIntegerIssue(form.nWake, "Wake cells"),
      positiveIssue(form.targetYPlus, "Target y+"),
      positiveIssue(form.spanChords, "Span"),
    ]);
  return (
    <ModalOverlay
      title="NEW MESH PROFILE"
      testId="wizard-numerics-modal"
      onClose={onClose}
      width="min(96vw, 1000px)"
    >
      {err && <ErrorLine text={err} />}
      {startFrom && <StartingPointLine name={startFrom.name} />}
      <div style={twoCol}>
        <TextField
          label="Name"
          value={form.name}
          error={issueFor(issues, "Name")}
          onChange={(name) => setForm((f) => ({ ...f, name }))}
        />
        <TextField
          label="Slug optional"
          value={form.slug ?? ""}
          onChange={(slug) => setForm((f) => ({ ...f, slug }))}
        />
      </div>
      {shouldShowOption(MESH_MESHER_OPTIONS, form.mesher) && (
        <SelectField
          label="Mesher"
          value={form.mesher}
          options={optionValues(MESH_MESHER_OPTIONS, form.mesher)}
          optionLabels={optionLabels(MESH_MESHER_OPTIONS, form.mesher)}
          error={issueFor(issues, "Mesher")}
          onChange={(mesher) => setForm((f) => ({ ...f, mesher }))}
        />
      )}
      <div style={{ marginTop: 10 }}>
        <MeshSettingsGuide
          form={form}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />
      </div>
      <SaveRow
        busy={busy}
        label="create mesh profile"
        issues={issues}
        onSave={() => submit(validate, form)}
      />
    </ModalOverlay>
  );
}

// ---------------------------------------------------------------------------
// Solver — primary knobs up front, URANS knobs behind an advanced disclosure
// (forced open while a URANS field has a validation issue so focus-on-error
// can reach it).
// ---------------------------------------------------------------------------
function SolverQuickCreateModal({
  startFrom,
  implementations,
  onCreated,
  onClose,
}: {
  startFrom: AdminSolverProfile | null;
  implementations: AdminSolverImplementation[];
  onCreated: (row: AdminSolverProfile) => void;
  onClose: () => void;
}) {
  const activeImplementations = implementations.filter(
    (implementation) => implementation.retiredAt == null,
  );
  const preferredImplementationId =
    activeImplementations.find(
      (implementation) =>
        implementation.family.toLowerCase() === "openfoam" &&
        implementation.distribution.toLowerCase() === "opencfd" &&
        implementation.releaseVersion === "2606",
    )?.id ??
    activeImplementations[0]?.id ??
    "";
  const startImplementationId =
    startFrom &&
    activeImplementations.some(
      (implementation) =>
        implementation.id === startFrom.solverImplementationId,
    )
      ? startFrom.solverImplementationId
      : preferredImplementationId;
  const implementationLabels = Object.fromEntries([
    ["", "choose engine implementation"],
    ...activeImplementations.map((implementation) => {
      const family =
        implementation.family.toLowerCase() === "openfoam"
          ? "OpenFOAM"
          : implementation.family;
      const distribution =
        implementation.distribution.toLowerCase() === "opencfd"
          ? "OpenCFD"
          : implementation.distribution.toLowerCase() === "foundation"
            ? "Foundation"
            : implementation.distribution;
      return [
        implementation.id,
        `${family} · ${distribution} ${implementation.releaseVersion}`,
      ];
    }),
  ]);
  const [form, setForm] = useState<SolverProfileInput>(() =>
    startFrom
      ? {
          name: "",
          solverImplementationId: startImplementationId,
          turbulenceModel: startFrom.turbulenceModel,
          nIterations: startFrom.nIterations,
          convergenceTolerance: startFrom.convergenceTolerance,
          momentumScheme: startFrom.momentumScheme,
          transientCycles: startFrom.transientCycles,
          transientDiscardFraction: startFrom.transientDiscardFraction,
          transientMaxCourant: startFrom.transientMaxCourant,
        }
      : defaultSolverForm(preferredImplementationId),
  );
  const { busy, err, issues, submit } = useQuickCreateSubmit(
    createSolverProfile,
    onCreated,
  );
  const validate = () =>
    compactIssues([
      requiredIssue(form.name, "Name"),
      requiredChoiceIssue(form.solverImplementationId, "Engine implementation"),
      requiredChoiceIssue(form.turbulenceModel, "Turbulence model"),
      positiveIntegerIssue(form.nIterations, "Iterations"),
      positiveIssue(form.convergenceTolerance, "Tolerance"),
      requiredIssue(form.momentumScheme, "Momentum scheme"),
      positiveIntegerIssue(form.transientCycles, "URANS cycles"),
      form.transientDiscardFraction >= 0 && form.transientDiscardFraction < 1
        ? null
        : {
            field: "URANS discard",
            message: "URANS discard must be from 0 to less than 1",
          },
      positiveIssue(form.transientMaxCourant, "URANS max Co"),
    ]);
  const uransIssue = ["URANS cycles", "URANS discard", "URANS max Co"].some(
    (field) => issueFor(issues, field),
  );
  const modelOptions = TURBULENCE_MODEL_OPTIONS.includes(form.turbulenceModel)
    ? TURBULENCE_MODEL_OPTIONS
    : [form.turbulenceModel, ...TURBULENCE_MODEL_OPTIONS];
  return (
    <ModalOverlay
      title="NEW SOLVER PROFILE"
      testId="wizard-numerics-modal"
      onClose={onClose}
    >
      {err && <ErrorLine text={err} />}
      {startFrom && <StartingPointLine name={startFrom.name} />}
      <TextField
        label="Name"
        value={form.name}
        error={issueFor(issues, "Name")}
        onChange={(name) => setForm((f) => ({ ...f, name }))}
      />
      <TextField
        label="Slug optional"
        value={form.slug ?? ""}
        onChange={(slug) => setForm((f) => ({ ...f, slug }))}
      />
      <div style={twoCol}>
        <SelectField
          label="Engine implementation"
          value={form.solverImplementationId}
          options={[
            "",
            ...activeImplementations.map((implementation) => implementation.id),
          ]}
          optionLabels={implementationLabels}
          error={issueFor(issues, "Engine implementation")}
          onChange={(solverImplementationId) =>
            setForm((form) => ({ ...form, solverImplementationId }))
          }
        />
        <SelectField
          label="Turbulence model"
          value={form.turbulenceModel}
          options={modelOptions}
          error={issueFor(issues, "Turbulence model")}
          onChange={(turbulenceModel) =>
            setForm((f) => ({ ...f, turbulenceModel }))
          }
        />
        <NumberField
          label="Iterations"
          value={form.nIterations}
          error={issueFor(issues, "Iterations")}
          onChange={(nIterations) => setForm((f) => ({ ...f, nIterations }))}
        />
        <NumberField
          label="Tolerance"
          value={form.convergenceTolerance}
          error={issueFor(issues, "Tolerance")}
          onChange={(convergenceTolerance) =>
            setForm((f) => ({ ...f, convergenceTolerance }))
          }
        />
        <SelectField
          label="Momentum scheme"
          value={form.momentumScheme}
          {...momentumSchemeSelect(form.momentumScheme)}
          error={issueFor(issues, "Momentum scheme")}
          onChange={(momentumScheme) =>
            setForm((f) => ({ ...f, momentumScheme }))
          }
        />
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 10,
          color: C.dim,
          lineHeight: 1.5,
          marginTop: 6,
        }}
      >
        If a 2nd-order solve fails to converge, the engine automatically retries
        at 1st order (recorded on the result as first-order fallback).
      </div>
      <details
        {...(uransIssue ? { open: true } : {})}
        style={{
          border: `1px solid ${C.stroke2}`,
          borderRadius: 8,
          padding: "7px 9px",
          marginTop: 8,
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            color: C.dim,
            fontFamily: MONO,
            fontSize: 10,
          }}
        >
          advanced URANS settings
        </summary>
        <div style={{ ...twoCol, marginTop: 8 }}>
          <NumberField
            label="URANS cycles"
            value={form.transientCycles}
            error={issueFor(issues, "URANS cycles")}
            onChange={(transientCycles) =>
              setForm((f) => ({ ...f, transientCycles }))
            }
          />
          <NumberField
            label="URANS discard"
            value={form.transientDiscardFraction}
            error={issueFor(issues, "URANS discard")}
            onChange={(transientDiscardFraction) =>
              setForm((f) => ({ ...f, transientDiscardFraction }))
            }
          />
          <NumberField
            label="URANS max Co"
            value={form.transientMaxCourant}
            error={issueFor(issues, "URANS max Co")}
            onChange={(transientMaxCourant) =>
              setForm((f) => ({ ...f, transientMaxCourant }))
            }
          />
        </div>
      </details>
      <SaveRow
        busy={busy}
        label="create solver profile"
        issues={issues}
        onSave={() => submit(validate, form)}
      />
    </ModalOverlay>
  );
}

// ---------------------------------------------------------------------------
// Output — the 8 known engine image fields as a real multi-select (the POST
// accepts any subset) + image zoom.
// ---------------------------------------------------------------------------
function OutputQuickCreateModal({
  startFrom,
  onCreated,
  onClose,
}: {
  startFrom: AdminOutputProfile | null;
  onCreated: (row: AdminOutputProfile) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<OutputProfileInput>(() =>
    startFrom
      ? {
          name: "",
          writeImages: [...startFrom.writeImages],
          imageZoomChords: startFrom.imageZoomChords,
        }
      : defaultOutputForm(),
  );
  const { busy, err, issues, submit } = useQuickCreateSubmit(
    createOutputProfile,
    onCreated,
  );
  const validate = () =>
    compactIssues([
      requiredIssue(form.name, "Name"),
      positiveIssue(form.imageZoomChords, "Image zoom chords"),
    ]);
  const toggleField = (field: string) =>
    setForm((f) => {
      const selected = new Set(f.writeImages);
      if (selected.has(field)) selected.delete(field);
      else selected.add(field);
      // canonical engine order, same as ALL_IMAGE_FIELDS
      return {
        ...f,
        writeImages: ALL_IMAGE_FIELDS.filter((known) => selected.has(known)),
      };
    });
  return (
    <ModalOverlay
      title="NEW OUTPUT PROFILE"
      testId="wizard-numerics-modal"
      onClose={onClose}
    >
      {err && <ErrorLine text={err} />}
      {startFrom && <StartingPointLine name={startFrom.name} />}
      <TextField
        label="Name"
        value={form.name}
        error={issueFor(issues, "Name")}
        onChange={(name) => setForm((f) => ({ ...f, name }))}
      />
      <TextField
        label="Slug optional"
        value={form.slug ?? ""}
        onChange={(slug) => setForm((f) => ({ ...f, slug }))}
      />
      <div data-admin-field="Stored image fields">
        <div style={miniLabel}>Stored image fields</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {ALL_IMAGE_FIELDS.map((field) => {
            const checked = form.writeImages.includes(field);
            return (
              <label
                key={field}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: MONO,
                  fontSize: 11,
                  color: checked ? C.text : C.dim,
                  background: C.panel3,
                  border: `1px solid ${checked ? C.tealBorder : C.borderSoft}`,
                  borderRadius: 6,
                  padding: "6px 8px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleField(field)}
                />
                {IMAGE_FIELD_LABELS[field] ?? field}
              </label>
            );
          })}
        </div>
        {form.writeImages.length === 0 && (
          <InfoLine
            tone="amber"
            text="no fields selected — this profile will store no field images"
          />
        )}
      </div>
      <NumberField
        label="Image zoom chords"
        value={form.imageZoomChords}
        error={issueFor(issues, "Image zoom chords")}
        onChange={(imageZoomChords) =>
          setForm((f) => ({ ...f, imageZoomChords }))
        }
      />
      <SaveRow
        busy={busy}
        label="create output profile"
        issues={issues}
        onSave={() => submit(validate, form)}
      />
    </ModalOverlay>
  );
}

// ---------------------------------------------------------------------------
// Dispatcher — one entry point for the four slot kinds.
// ---------------------------------------------------------------------------
export function NumericsQuickCreate({
  kind,
  setup,
  currentId,
  onCreated,
  onClose,
}: {
  kind: NumericsProfileKind;
  setup: AdminSimulationSetup;
  /** Currently selected profile id for this slot ("" = unresolved). */
  currentId: string;
  onCreated: (kind: NumericsProfileKind, row: NumericsProfileRow) => void;
  onClose: () => void;
}) {
  if (kind === "boundary") {
    return (
      <BoundaryQuickCreateModal
        startFrom={
          setup.boundaryProfiles.find((r) => r.id === currentId) ?? null
        }
        onCreated={(row) => onCreated("boundary", row)}
        onClose={onClose}
      />
    );
  }
  if (kind === "mesh") {
    return (
      <MeshQuickCreateModal
        startFrom={setup.meshProfiles.find((r) => r.id === currentId) ?? null}
        onCreated={(row) => onCreated("mesh", row)}
        onClose={onClose}
      />
    );
  }
  if (kind === "solver") {
    return (
      <SolverQuickCreateModal
        startFrom={setup.solverProfiles.find((r) => r.id === currentId) ?? null}
        implementations={setup.solverImplementations}
        onCreated={(row) => onCreated("solver", row)}
        onClose={onClose}
      />
    );
  }
  return (
    <OutputQuickCreateModal
      startFrom={setup.outputProfiles.find((r) => r.id === currentId) ?? null}
      onCreated={(row) => onCreated("output", row)}
      onClose={onClose}
    />
  );
}
