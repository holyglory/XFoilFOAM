"use client";

// Wizard step 2 (spec §11): define-in-place conditions envelope — medium
// select with quick-create, ambient chips + ISA helper, speed/chord
// multi-value fields with library prefill, span/area advanced disclosure
// (area locked to derived while >1 chord), and the live condition preview.

import { useMemo, useState } from "react";

import type { MediumDTO } from "@aerodb/core";
import { canonicalSiString } from "@aerodb/core";

import type { AdminSimulationSetup } from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { UnitNumberField } from "../UnitNumberField";
import { AmbientField } from "./AmbientField";
import { ConditionPreviewPanel } from "./ConditionPreviewPanel";
import { MediumQuickCreate } from "./MediumQuickCreate";
import { MultiValueField } from "./MultiValueField";
import type { AngleSets, ExcludedCondition, WizardEnvelope } from "./plan-model";
import { f, fSpeed, ghostBtn, InfoLine, issueFor, label as labelStyle, SelectField, type ValidationIssue, ValidationSummary } from "./ui";

export interface ConditionsStepProps {
  mediums: MediumDTO[];
  setup: AdminSimulationSetup;
  envelope: WizardEnvelope;
  onEnvelope: (patch: Partial<WizardEnvelope>) => void;
  onMediumCreated: (medium: MediumDTO) => void;
  angleSets: AngleSets | null;
  airfoilCount: number;
  symmetricCount: number;
  issues: ValidationIssue[];
  /** Plan-edit reuse (spec §6): medium locked once launched. */
  mediumLocked?: boolean;
}

export function ConditionsStep({
  mediums,
  setup,
  envelope,
  onEnvelope,
  onMediumCreated,
  angleSets,
  airfoilCount,
  symmetricCount,
  issues,
  mediumLocked = false,
}: ConditionsStepProps) {
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const medium = mediums.find((m) => m.id === envelope.mediumId) ?? null;
  const multiChord = envelope.chordsM.length > 1;

  const speedLibraryOptions = useMemo(() => {
    const seen = new Set<string>();
    return setup.flowConditions
      .filter((flow) => {
        const key = canonicalSiString("speedMps", flow.speedMps);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((flow) => ({ valueSi: flow.speedMps, label: `${flow.name} · ${fSpeed(flow.speedMps)}` }));
  }, [setup.flowConditions]);

  const chordLibraryOptions = useMemo(() => {
    const seen = new Set<string>();
    return setup.referenceGeometryProfiles
      .filter((geo) => {
        const key = canonicalSiString("chordM", geo.referenceLengthM);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((geo) => ({ valueSi: geo.referenceLengthM, label: `${geo.name} · ${f(geo.referenceLengthM, 4)} m` }));
  }, [setup.referenceGeometryProfiles]);

  const toggleExclude = (cell: ExcludedCondition) => {
    const key = cell.join("|");
    const existing = envelope.excludedConditions.some((x) => x.join("|") === key);
    onEnvelope({
      excludedConditions: existing
        ? envelope.excludedConditions.filter((x) => x.join("|") !== key)
        : [...envelope.excludedConditions, cell].sort((a, b) => a.join("|").localeCompare(b.join("|"))),
    });
  };

  return (
    <div data-testid="wizard-conditions" style={{ display: "grid", gap: 4 }}>
      <div style={labelStyle}>2 · CONDITIONS</div>

      {mediumLocked ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: "8px 10px" }}>
          Medium: <span style={{ color: C.text }}>{medium?.name ?? envelope.mediumId}</span> — fixed once launched; duplicate this campaign to change it.
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SelectField
                label="Medium"
                value={envelope.mediumId}
                options={["", ...mediums.map((m) => m.id)]}
                optionLabels={Object.fromEntries([["", "choose medium"], ...mediums.map((m) => [m.id, m.name])])}
                error={issueFor(issues, "Medium")}
                onChange={(mediumId) => onEnvelope({ mediumId })}
              />
            </div>
            <button
              type="button"
              data-testid="wizard-new-medium"
              aria-expanded={quickCreateOpen}
              onClick={() => setQuickCreateOpen((v) => !v)}
              style={{ ...ghostBtn, padding: "9px 11px", fontSize: 11, color: C.teal, whiteSpace: "nowrap" }}
            >
              + new medium
            </button>
          </div>
          {quickCreateOpen && (
            <MediumQuickCreate
              onClose={() => setQuickCreateOpen(false)}
              onCreated={(created) => {
                setQuickCreateOpen(false);
                onMediumCreated(created);
                onEnvelope({ mediumId: created.id });
              }}
            />
          )}
        </div>
      )}

      <AmbientField
        ambients={envelope.ambients}
        onChange={(ambients) => onEnvelope({ ambients })}
        fieldName="Ambients"
        error={issueFor(issues, "Ambients")}
        libraryFlowConditions={setup.flowConditions}
        testId="wizard-ambients"
      />

      <MultiValueField
        label="Speed"
        dimension="speed"
        siKind="speedMps"
        values={envelope.speedsMps}
        onChange={(speedsMps) => onEnvelope({ speedsMps })}
        fieldName="Speeds"
        chipFieldPrefix="Speed value"
        error={issueFor(issues, "Speeds")}
        libraryOptions={speedLibraryOptions}
        testId="wizard-speeds"
      />

      <MultiValueField
        label="Chord"
        dimension="length"
        siKind="chordM"
        values={envelope.chordsM}
        onChange={(chordsM) => {
          // Area snaps back to derived as soon as a second chord appears (§11).
          onEnvelope(chordsM.length > 1 ? { chordsM, areaMode: "derived", areaM2: null } : { chordsM });
        }}
        fieldName="Chords"
        chipFieldPrefix="Chord value"
        error={issueFor(issues, "Chords")}
        libraryOptions={chordLibraryOptions}
        testId="wizard-chords"
      />

      <details
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
        style={{ border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: "7px 10px", marginTop: 10 }}
      >
        <summary data-testid="wizard-span-area-toggle" style={{ cursor: "pointer", color: C.dim, fontFamily: MONO, fontSize: 10 }}>
          span &amp; reference area (advanced)
        </summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 4 }}>
          <UnitNumberField
            label="Span"
            dimension="length"
            valueSi={Number(envelope.spanM)}
            min={0}
            error={issueFor(issues, "Span")}
            onChangeSi={(spanM) => onEnvelope({ spanM: spanM > 0 ? canonicalSiString("spanM", spanM) : envelope.spanM })}
          />
          <div>
            <SelectField
              label="Reference area"
              value={multiChord ? "derived" : envelope.areaMode}
              options={multiChord ? ["derived"] : ["derived", "explicit"]}
              optionLabels={{ derived: multiChord ? "derived (locked: multiple chords)" : "derived from chord × span", explicit: "explicit value" }}
              onChange={(areaMode) => onEnvelope({ areaMode: areaMode as "derived" | "explicit", areaM2: areaMode === "explicit" ? envelope.areaM2 : null })}
            />
            {!multiChord && envelope.areaMode === "explicit" && (
              <label style={{ display: "block" }} data-admin-field="Reference area m²">
                <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, margin: "8px 0 4px" }}>Reference area m²</div>
                <input
                  aria-label="Reference area m²"
                  type="number"
                  step="0.0001"
                  value={envelope.areaM2 == null ? "" : Number(envelope.areaM2)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    onEnvelope({ areaM2: Number.isFinite(n) && n > 0 ? canonicalSiString("areaM2", n) : null });
                  }}
                  aria-invalid={!!issueFor(issues, "Reference area m²")}
                  style={{ width: "100%", boxSizing: "border-box", fontFamily: MONO, fontSize: 13, color: C.text, background: C.panel2, border: `1px solid ${issueFor(issues, "Reference area m²") ? C.red : C.stroke}`, borderRadius: 8, padding: "10px 12px", outline: "none" }}
                />
                {issueFor(issues, "Reference area m²") && <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 10, color: C.red }}>{issueFor(issues, "Reference area m²")}</div>}
              </label>
            )}
          </div>
        </div>
        {multiChord && <InfoLine text="With multiple chords the reference area is always derived per condition (chord × span)." />}
      </details>

      <ConditionPreviewPanel
        medium={medium}
        ambients={envelope.ambients}
        speedsMps={envelope.speedsMps}
        chordsM={envelope.chordsM}
        excludedConditions={envelope.excludedConditions}
        onToggleExclude={toggleExclude}
        angleSets={angleSets}
        airfoilCount={airfoilCount}
        symmetricCount={symmetricCount}
      />

      <div style={{ marginTop: 8 }}>
        <ValidationSummary issues={issues} />
      </div>
    </div>
  );
}
