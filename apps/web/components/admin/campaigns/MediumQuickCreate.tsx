"use client";

// "+ new medium" for the wizard's define-in-place conditions step (spec §11):
// an inline constant-viscosity mini-form (name, dynamic viscosity, density),
// and a full medium editor in a modal overlay for Sutherland/table models —
// the full field set, same semantics as the Mediums panel (no dead ends).
// Both POST /api/admin/mediums and hand the created medium back.

import { useState } from "react";

import type { MediumDTO, ViscosityTablePointDTO } from "@aerodb/core";

import { createAdminMedium, type MediumInput } from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { UnitNumberField } from "../UnitNumberField";
import {
  compactIssues,
  ErrorLine,
  focusValidationIssue,
  ghostBtn,
  issueFor,
  ModalOverlay,
  NumberField,
  positiveIssue,
  primaryBtn,
  requiredIssue,
  SelectField,
  TextField,
  type ValidationIssue,
  ValidationSummary,
} from "./ui";

const defaultFullForm = (): MediumInput => ({
  name: "",
  phase: "gas",
  density: 1.225,
  refTemperatureK: 288.15,
  refPressurePa: 101325,
  viscosityModel: "sutherland",
  constantDynamicViscosity: null,
  sutherlandMuRef: 1.716e-5,
  sutherlandTRef: 273.15,
  sutherlandS: 110.4,
  viscosityTable: [{ temperatureK: 288.15, dynamicViscosity: 1.789e-5, sortOrder: 0 }],
  speedOfSound: 340.3,
  notes: "",
});

export function MediumQuickCreate({ onCreated, onClose }: { onCreated: (medium: MediumDTO) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"mini" | "full">("mini");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  // mini form (constant viscosity)
  const [miniName, setMiniName] = useState("");
  const [miniViscosity, setMiniViscosity] = useState(1.8e-5);
  const [miniDensity, setMiniDensity] = useState(1.225);

  // full form (modal)
  const [form, setForm] = useState<MediumInput>(defaultFullForm());

  const submit = async (body: MediumInput) => {
    setBusy(true);
    setErr(null);
    try {
      const created = await createAdminMedium(body);
      onCreated(created);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitMini = () => {
    const next = compactIssues([
      requiredIssue(miniName, "New medium name"),
      positiveIssue(miniViscosity, "Dynamic viscosity μ [Pa·s]"),
      positiveIssue(miniDensity, "Density kg/m³"),
    ]);
    if (next.length) {
      setIssues(next);
      focusValidationIssue(next[0]);
      return;
    }
    setIssues([]);
    void submit({
      name: miniName,
      phase: "gas",
      density: miniDensity,
      refTemperatureK: 288.15,
      refPressurePa: 101325,
      viscosityModel: "constant",
      constantDynamicViscosity: miniViscosity,
      speedOfSound: null,
      notes: "created in campaign wizard",
    });
  };

  const validateFull = () =>
    compactIssues([
      requiredIssue(form.name, "Name"),
      positiveIssue(form.density, "Density kg/m³"),
      positiveIssue(form.refTemperatureK, "Ref temp"),
      positiveIssue(form.refPressurePa, "Ref pressure"),
      form.speedOfSound == null || form.speedOfSound === 0 ? null : positiveIssue(form.speedOfSound, "Speed of sound"),
      form.viscosityModel === "constant" ? positiveIssue(form.constantDynamicViscosity ?? 0, "Dynamic viscosity μ [Pa·s]") : null,
      form.viscosityModel === "sutherland" ? positiveIssue(form.sutherlandMuRef ?? 0, "μ ref [Pa·s]") : null,
      form.viscosityModel === "sutherland" ? positiveIssue(form.sutherlandTRef ?? 0, "T ref") : null,
      form.viscosityModel === "sutherland" ? positiveIssue(form.sutherlandS ?? 0, "Sutherland S") : null,
      ...(form.viscosityModel === "table"
        ? (form.viscosityTable ?? []).flatMap((row, i) => [
            positiveIssue(row.temperatureK, `T ${i + 1}`),
            positiveIssue(row.dynamicViscosity, `μ [Pa·s] ${i + 1}`),
          ])
        : []),
    ]);

  const submitFull = () => {
    const next = validateFull();
    if (next.length) {
      setIssues(next);
      focusValidationIssue(next[0]);
      return;
    }
    setIssues([]);
    void submit({
      ...form,
      viscosityTable: (form.viscosityTable ?? []).map((row, i) => ({ ...row, sortOrder: i })),
      speedOfSound: form.speedOfSound || null,
    });
  };

  const setTableRow = (index: number, patch: Partial<ViscosityTablePointDTO>) => {
    setForm((current) => {
      const rows = [...(current.viscosityTable ?? [])];
      rows[index] = { ...rows[index], ...patch, sortOrder: index };
      return { ...current, viscosityTable: rows };
    });
  };

  if (mode === "full") {
    return (
      <ModalOverlay title="NEW MEDIUM" testId="wizard-medium-modal" onClose={onClose}>
        {err && <ErrorLine text={err} />}
        <TextField label="Name" value={form.name} error={issueFor(issues, "Name")} onChange={(name) => setForm((f) => ({ ...f, name }))} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          <SelectField label="Phase" value={form.phase} options={["gas", "liquid"]} onChange={(phase) => setForm((f) => ({ ...f, phase: phase as "gas" | "liquid" }))} />
          <NumberField label="Density kg/m³" value={form.density} error={issueFor(issues, "Density kg/m³")} onChange={(density) => setForm((f) => ({ ...f, density }))} />
          <UnitNumberField label="Ref temp" dimension="temperature" valueSi={form.refTemperatureK} min={0} error={issueFor(issues, "Ref temp")} onChangeSi={(refTemperatureK) => setForm((f) => ({ ...f, refTemperatureK }))} />
          <UnitNumberField label="Ref pressure" dimension="pressure" valueSi={form.refPressurePa} min={0} error={issueFor(issues, "Ref pressure")} onChangeSi={(refPressurePa) => setForm((f) => ({ ...f, refPressurePa }))} />
          <SelectField label="Viscosity model" value={form.viscosityModel} options={["constant", "sutherland", "table"]} onChange={(viscosityModel) => setForm((f) => ({ ...f, viscosityModel: viscosityModel as MediumInput["viscosityModel"] }))} />
          <UnitNumberField label="Speed of sound" dimension="speed" valueSi={form.speedOfSound ?? 0} min={0} error={issueFor(issues, "Speed of sound")} onChangeSi={(speedOfSound) => setForm((f) => ({ ...f, speedOfSound }))} />
        </div>
        {form.viscosityModel === "constant" && (
          <NumberField label="Dynamic viscosity μ [Pa·s]" value={form.constantDynamicViscosity ?? 0} error={issueFor(issues, "Dynamic viscosity μ [Pa·s]")} onChange={(constantDynamicViscosity) => setForm((f) => ({ ...f, constantDynamicViscosity }))} />
        )}
        {form.viscosityModel === "sutherland" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <NumberField label="μ ref [Pa·s]" value={form.sutherlandMuRef ?? 0} error={issueFor(issues, "μ ref [Pa·s]")} onChange={(sutherlandMuRef) => setForm((f) => ({ ...f, sutherlandMuRef }))} />
            <UnitNumberField label="T ref" dimension="temperature" valueSi={form.sutherlandTRef ?? 0} min={0} error={issueFor(issues, "T ref")} onChangeSi={(sutherlandTRef) => setForm((f) => ({ ...f, sutherlandTRef }))} />
            <UnitNumberField label="Sutherland S" dimension="temperature" valueSi={form.sutherlandS ?? 0} min={0} error={issueFor(issues, "Sutherland S")} onChangeSi={(sutherlandS) => setForm((f) => ({ ...f, sutherlandS }))} />
          </div>
        )}
        {form.viscosityModel === "table" && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, margin: "8px 0 4px" }}>Viscosity table</div>
            {(form.viscosityTable ?? []).map((row, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 34px", gap: 8, alignItems: "end", marginBottom: 6 }}>
                <UnitNumberField label={`T ${i + 1}`} dimension="temperature" valueSi={row.temperatureK} min={0} error={issueFor(issues, `T ${i + 1}`)} onChangeSi={(temperatureK) => setTableRow(i, { temperatureK })} />
                <NumberField label={`μ [Pa·s] ${i + 1}`} value={row.dynamicViscosity} error={issueFor(issues, `μ [Pa·s] ${i + 1}`)} onChange={(dynamicViscosity) => setTableRow(i, { dynamicViscosity })} />
                <button
                  type="button"
                  aria-label="Remove table point"
                  onClick={() => setForm((current) => ({ ...current, viscosityTable: (current.viscosityTable ?? []).filter((_, j) => j !== i).map((p, j) => ({ ...p, sortOrder: j })) }))}
                  style={{ ...ghostBtn, padding: 8 }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setForm((current) => ({ ...current, viscosityTable: [...(current.viscosityTable ?? []), { temperatureK: current.refTemperatureK, dynamicViscosity: current.constantDynamicViscosity ?? current.sutherlandMuRef ?? 1e-5, sortOrder: current.viscosityTable?.length ?? 0 }] }))}
              style={{ ...ghostBtn, width: "100%", marginTop: 4 }}
            >
              add table point
            </button>
          </div>
        )}
        <TextField label="Notes" value={form.notes ?? ""} onChange={(notes) => setForm((f) => ({ ...f, notes }))} />
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <ValidationSummary issues={issues} />
          <button type="button" data-testid="wizard-medium-modal-save" disabled={busy} onClick={submitFull} style={{ ...primaryBtn(busy), width: "100%" }}>
            {busy ? "saving…" : "create medium"}
          </button>
          <button type="button" onClick={() => setMode("mini")} style={{ ...ghostBtn, width: "100%" }}>
            back to quick form
          </button>
        </div>
      </ModalOverlay>
    );
  }

  return (
    <div data-testid="wizard-medium-quick-create" style={{ border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: "4px 10px 10px", marginTop: 8 }}>
      {err && <ErrorLine text={err} />}
      <TextField label="New medium name" value={miniName} error={issueFor(issues, "New medium name")} onChange={setMiniName} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <NumberField label="Dynamic viscosity μ [Pa·s]" value={miniViscosity} error={issueFor(issues, "Dynamic viscosity μ [Pa·s]")} onChange={setMiniViscosity} />
        <NumberField label="Density kg/m³" value={miniDensity} error={issueFor(issues, "Density kg/m³")} onChange={setMiniDensity} />
      </div>
      <ValidationSummary issues={issues.filter((i) => ["New medium name", "Dynamic viscosity μ [Pa·s]", "Density kg/m³"].includes(i.field))} />
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" data-testid="wizard-medium-quick-save" disabled={busy} onClick={submitMini} style={{ ...primaryBtn(busy), padding: "6px 12px", fontSize: 11 }}>
          {busy ? "saving…" : "create constant-viscosity medium"}
        </button>
        <button type="button" data-testid="wizard-medium-full-editor" onClick={() => setMode("full")} style={{ ...ghostBtn, padding: "6px 10px", fontSize: 10 }}>
          Sutherland / table model…
        </button>
        <button type="button" onClick={onClose} style={{ ...ghostBtn, padding: "6px 10px", fontSize: 10, marginLeft: "auto" }}>
          cancel
        </button>
      </div>
    </div>
  );
}
