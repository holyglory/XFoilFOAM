"use client";

// Ambient (T, P) chip editor (spec §11 step 2): inline two-field editor, ISA
// "standard atmosphere at altitude…" helper, library prefill (add-only),
// canonical sorted/deduped chips with per-chip validation targeting.

import { useMemo, useState } from "react";

import { canonicalSiString } from "@aerodb/core";

import type { AdminFlowCondition } from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { UnitNumberField } from "../UnitNumberField";
import { isaAtmosphere, ISA_MAX_ALTITUDE_M, ISA_MIN_ALTITUDE_M } from "./isa";
import { type AmbientPair, CAMPAIGN_MAX_VALUES_PER_AXIS, canonicalAmbients } from "./plan-model";
import { fPressure, fTemp, ghostBtn, LibraryPrefillPopover, miniLabel, primaryBtn, validationText } from "./ui";

export interface AmbientFieldProps {
  ambients: AmbientPair[];
  onChange: (ambients: AmbientPair[]) => void;
  fieldName: string;
  error?: string;
  libraryFlowConditions: AdminFlowCondition[];
  testId: string;
}

export function AmbientField({ ambients, onChange, fieldName, error, libraryFlowConditions, testId }: AmbientFieldProps) {
  const [editorOpen, setEditorOpen] = useState(ambients.length === 0);
  const [draftT, setDraftT] = useState(288.15);
  const [draftP, setDraftP] = useState(101325);
  const [addError, setAddError] = useState<string | null>(null);
  const [isaOpen, setIsaOpen] = useState(false);
  const [altitudeM, setAltitudeM] = useState(0);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");

  const addAmbient = (t: number, p: number) => {
    const merged = canonicalAmbients([...ambients, [t, p]]);
    if (merged.length > CAMPAIGN_MAX_VALUES_PER_AXIS) {
      setAddError(`max ${CAMPAIGN_MAX_VALUES_PER_AXIS} ambients`);
      return;
    }
    setAddError(null);
    onChange(merged);
  };

  const isaState = useMemo(() => {
    try {
      return { value: isaAtmosphere(altitudeM), error: null as string | null };
    } catch (e) {
      return { value: null, error: (e as Error).message };
    }
  }, [altitudeM]);

  const libraryOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ key: string; label: string }> = [];
    for (const flow of libraryFlowConditions) {
      const t = canonicalSiString("temperatureK", flow.temperatureK);
      const p = canonicalSiString("pressurePa", flow.pressurePa);
      const key = `${t}|${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ key, label: `${flow.name} · ${fTemp(flow.temperatureK)} · ${fPressure(flow.pressurePa)}` });
    }
    return options;
  }, [libraryFlowConditions]);

  return (
    <div data-testid={testId} data-admin-field={fieldName} style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 4px", flexWrap: "wrap" }}>
        <span style={{ ...miniLabel, margin: 0 }}>Ambient (T, P)</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
          {libraryOptions.length > 0 && (
            <LibraryPrefillPopover
              label="prefill from library"
              testId={`${testId}-library`}
              open={libraryOpen}
              onOpenChange={setLibraryOpen}
              query={libraryQuery}
              onQuery={setLibraryQuery}
              options={libraryOptions}
              onPick={(key) => {
                const [t, p] = key.split("|");
                addAmbient(Number(t), Number(p));
              }}
            />
          )}
          <button type="button" data-testid={`${testId}-editor-toggle`} aria-expanded={editorOpen} onClick={() => setEditorOpen((v) => !v)} style={{ ...ghostBtn, padding: "5px 9px", fontSize: 10, color: C.teal }}>
            {editorOpen ? "close editor" : "+ ambient"}
          </button>
        </span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, border: `1px solid ${error ? C.red : C.stroke}`, borderRadius: 8, background: C.panel2, padding: 8 }}>
        {ambients.length === 0 && <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>no ambients yet — add (T, P) below or use the ISA helper</span>}
        {ambients.map(([t, p], i) => (
          <span
            key={`${t}|${p}`}
            data-admin-field={`Ambient ${i + 1}`}
            data-testid={`${testId}-chip-${t}-${p}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 11, color: C.text, background: C.panel3, border: `1px solid ${C.stroke}`, borderRadius: 6, padding: "4px 7px" }}
          >
            <button type="button" style={{ all: "unset", cursor: "default" }} aria-label={`Ambient ${fTemp(Number(t))} ${fPressure(Number(p))}`}>
              {fTemp(Number(t))} · {fPressure(Number(p))}
            </button>
            <button
              type="button"
              aria-label={`Remove ambient ${fTemp(Number(t))} ${fPressure(Number(p))}`}
              onClick={() => onChange(ambients.filter((a) => !(a[0] === t && a[1] === p)))}
              style={{ background: "transparent", border: "none", color: C.dim, cursor: "pointer", padding: 0, fontFamily: MONO, fontSize: 11 }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {editorOpen && (
        <div style={{ marginTop: 8, border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: "6px 10px 10px" }}>
          <div className="admin-form-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
            <UnitNumberField label="Ambient temperature" dimension="temperature" valueSi={draftT} min={0} onChangeSi={setDraftT} />
            <UnitNumberField label="Ambient pressure" dimension="pressure" valueSi={draftP} min={0} onChangeSi={setDraftP} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              data-testid={`${testId}-add`}
              onClick={() => {
                if (!(draftT > 0 && draftP > 0)) {
                  setAddError("temperature and pressure must be greater than 0");
                  return;
                }
                addAmbient(draftT, draftP);
              }}
              style={{ ...primaryBtn(false), padding: "6px 12px", fontSize: 11 }}
            >
              add ambient
            </button>
            <button type="button" data-testid={`${testId}-isa-toggle`} aria-expanded={isaOpen} onClick={() => setIsaOpen((v) => !v)} style={{ ...ghostBtn, padding: "6px 10px", fontSize: 10 }}>
              standard atmosphere at altitude…
            </button>
          </div>
          {isaOpen && (
            <div data-testid={`${testId}-isa`} style={{ marginTop: 8, border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: "2px 10px 10px" }}>
              <UnitNumberField label="Altitude" dimension="length" valueSi={altitudeM} onChangeSi={setAltitudeM} />
              {isaState.value ? (
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                  <span data-testid={`${testId}-isa-preview`} style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                    ISA → {fTemp(isaState.value.temperatureK)} · {fPressure(isaState.value.pressurePa)}
                  </span>
                  <button
                    type="button"
                    data-testid={`${testId}-isa-add`}
                    onClick={() => {
                      setDraftT(isaState.value!.temperatureK);
                      setDraftP(isaState.value!.pressurePa);
                      addAmbient(isaState.value!.temperatureK, isaState.value!.pressurePa);
                    }}
                    style={{ ...ghostBtn, padding: "5px 10px", fontSize: 10, color: C.teal }}
                  >
                    add ISA ambient
                  </button>
                </div>
              ) : (
                <div style={validationText}>
                  {isaState.error} (supported: {ISA_MIN_ALTITUDE_M}…{ISA_MAX_ALTITUDE_M} m)
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {addError && <div style={validationText}>{addError}</div>}
      {error && <div style={validationText}>{error}</div>}
    </div>
  );
}
