"use client";

// Multi-value envelope field (spec §11 step 2): renders like a plain
// UnitNumberField while single-valued with a quiet "add value" affordance;
// grows into sorted/deduped canonical chips, a range expander, and a collapsed
// summary row past 8 values. All storage is canonical SI strings.

import { type CSSProperties, useId, useMemo, useState } from "react";

import { canonicalSiString } from "@aerodb/core";

import { formatUnitNumber, parseUnitNumber, UNIT_DEFINITIONS, type UnitDimension, unitFor } from "@/lib/unit-conversions";
import { C, MONO } from "@/lib/tokens";
import { CAMPAIGN_MAX_VALUES_PER_AXIS, canonicalAxisValues } from "./plan-model";
import { ghostBtn, inputStyle, LibraryPrefillPopover, miniLabel, primaryBtn, validationText } from "./ui";

export interface MultiValueFieldProps {
  label: string;
  dimension: UnitDimension;
  siKind: "speedMps" | "chordM";
  /** Canonical SI strings, sorted ascending. */
  values: string[];
  onChange: (values: string[]) => void;
  /** ValidationIssue field name for the whole axis (chips target `${chipFieldPrefix} N`). */
  fieldName: string;
  chipFieldPrefix: string;
  error?: string;
  chipErrors?: Record<string, string>;
  /** Library prefill options (SI values + labels) — picking only ADDS. */
  libraryOptions?: Array<{ valueSi: number; label: string }>;
  testId: string;
}

const chipStyle = (hasError: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontFamily: MONO,
  fontSize: 11,
  color: hasError ? C.red : C.text,
  background: C.panel2,
  border: `1px solid ${hasError ? C.red : C.stroke}`,
  borderRadius: 6,
  padding: "4px 7px",
});

export function MultiValueField({
  label,
  dimension,
  siKind,
  values,
  onChange,
  fieldName,
  chipFieldPrefix,
  error,
  chipErrors,
  libraryOptions,
  testId,
}: MultiValueFieldProps) {
  const id = useId();
  const [unitKey, setUnitKey] = useState(() => unitFor(dimension).key);
  const unit = unitFor(dimension, unitKey);
  const [unitOpen, setUnitOpen] = useState(false);
  const [singleText, setSingleText] = useState(() => (values.length === 1 ? formatUnitNumber(unit.fromSi(Number(values[0]))) : ""));
  const [singleFocused, setSingleFocused] = useState(false);
  const [addText, setAddText] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [multiMode, setMultiMode] = useState(values.length > 1);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [rangeStep, setRangeStep] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");

  const isMulti = multiMode || values.length > 1;
  const collapsed = values.length > 8 && !summaryOpen;

  const setCanonical = (nextSi: Array<number | string>) => {
    onChange(canonicalAxisValues(siKind, nextSi));
  };

  const commitSingleText = (raw: string) => {
    setSingleText(raw);
    const parsed = parseUnitNumber(raw);
    if (parsed == null) return;
    const si = unit.toSi(parsed);
    if (!(Number.isFinite(si) && si > 0)) return;
    setCanonical([si]);
  };

  const addValueFromText = (raw: string): boolean => {
    const parsed = parseUnitNumber(raw);
    if (parsed == null) {
      setAddError("enter a number");
      return false;
    }
    const si = unit.toSi(parsed);
    if (!(Number.isFinite(si) && si > 0)) {
      setAddError("value must be greater than 0");
      return false;
    }
    const merged = canonicalAxisValues(siKind, [...values, si]);
    if (merged.length > CAMPAIGN_MAX_VALUES_PER_AXIS) {
      setAddError(`max ${CAMPAIGN_MAX_VALUES_PER_AXIS} values per axis`);
      return false;
    }
    setAddError(null);
    onChange(merged);
    return true;
  };

  const removeChip = (value: string) => {
    onChange(values.filter((v) => v !== value));
  };

  // Range expansion in the current unit — canonicalized/deduped on merge, so
  // overlapping grids collapse exactly like server-side expansion (spec §4).
  const rangePreview = useMemo(() => {
    const from = parseUnitNumber(rangeFrom);
    const to = parseUnitNumber(rangeTo);
    const step = parseUnitNumber(rangeStep);
    if (from == null || to == null || step == null) return { state: "incomplete" as const };
    if (step <= 0) return { state: "error" as const, message: "step must be greater than 0" };
    if (to < from) return { state: "error" as const, message: "to must be ≥ from" };
    const rawCount = Math.floor((to - from) / step + 1e-9) + 1;
    if (rawCount > 1000) return { state: "error" as const, message: `range expands to ${rawCount} raw values — tighten the step` };
    const si: number[] = [];
    for (let i = 0; i < rawCount; i++) {
      const v = unit.toSi(from + i * step);
      if (Number.isFinite(v) && v > 0) si.push(v);
    }
    const merged = canonicalAxisValues(siKind, [...values, ...si]);
    const added = merged.length - values.length;
    if (merged.length > CAMPAIGN_MAX_VALUES_PER_AXIS) {
      return { state: "error" as const, message: `would make ${merged.length} values — max ${CAMPAIGN_MAX_VALUES_PER_AXIS} per axis` };
    }
    return { state: "ok" as const, merged, rawCount, added };
  }, [rangeFrom, rangeTo, rangeStep, unit, siKind, values]);

  const chipLabel = (v: string) => formatUnitNumber(unit.fromSi(Number(v)));
  const min = values.length ? chipLabel(values[0]) : "—";
  const max = values.length ? chipLabel(values[values.length - 1]) : "—";

  const unitButton = (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !e.currentTarget.contains(next)) setUnitOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={`${label} unit`}
        aria-expanded={unitOpen}
        onClick={() => setUnitOpen((v) => !v)}
        style={{ fontFamily: MONO, fontSize: 10, color: C.teal, background: "transparent", border: "none", borderBottom: `1px dotted ${C.teal}`, padding: 0, cursor: "pointer", lineHeight: 1.1 }}
      >
        {unit.label}
      </button>
      {unitOpen && (
        <div role="menu" aria-label={`${label} units`} onMouseDown={(e) => e.preventDefault()} style={{ position: "absolute", zIndex: 20, top: 16, left: 0, minWidth: 88, display: "grid", gap: 2, padding: 5, background: C.popover, border: `1px solid ${C.stroke}`, borderRadius: 8, boxShadow: `0 12px 28px ${C.shadow}` }}>
          {UNIT_DEFINITIONS[dimension].map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              role="menuitemradio"
              aria-checked={candidate.key === unit.key}
              onClick={() => {
                setUnitKey(candidate.key);
                setUnitOpen(false);
                const next = unitFor(dimension, candidate.key);
                if (values.length === 1) setSingleText(formatUnitNumber(next.fromSi(Number(values[0]))));
              }}
              style={{ fontFamily: MONO, fontSize: 11, color: candidate.key === unit.key ? C.teal : C.text, background: candidate.key === unit.key ? C.tealFill : "transparent", border: "none", borderRadius: 6, padding: "6px 8px", textAlign: "left", cursor: "pointer" }}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );

  const rangeExpander = (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !e.currentTarget.contains(next)) setRangeOpen(false);
      }}
    >
      <button type="button" data-testid={`${testId}-range-toggle`} aria-expanded={rangeOpen} onClick={() => setRangeOpen((v) => !v)} style={{ ...ghostBtn, padding: "5px 9px", fontSize: 10 }}>
        range…
      </button>
      {rangeOpen && (
        <div data-testid={`${testId}-range-popover`} style={{ position: "absolute", zIndex: 30, top: "calc(100% + 4px)", right: 0, width: 250, background: C.popover, border: `1px solid ${C.stroke}`, borderRadius: 8, boxShadow: `0 12px 28px ${C.shadow}`, padding: 10, display: "grid", gap: 6 }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>expand a range ({unit.label})</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            <input aria-label={`${label} range from`} placeholder="from" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} style={{ ...inputStyle, padding: "7px 8px", fontSize: 11 }} />
            <input aria-label={`${label} range to`} placeholder="to" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} style={{ ...inputStyle, padding: "7px 8px", fontSize: 11 }} />
            <input aria-label={`${label} range step`} placeholder="step" value={rangeStep} onChange={(e) => setRangeStep(e.target.value)} style={{ ...inputStyle, padding: "7px 8px", fontSize: 11 }} />
          </div>
          {rangePreview.state === "ok" && (
            <div data-testid={`${testId}-range-count`} style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
              {rangePreview.rawCount} values → adds {rangePreview.added} new ({rangePreview.merged.length} total)
            </div>
          )}
          {rangePreview.state === "error" && <div style={{ ...validationText, marginTop: 0 }}>{rangePreview.message}</div>}
          <button
            type="button"
            data-testid={`${testId}-range-add`}
            disabled={rangePreview.state !== "ok"}
            onClick={() => {
              if (rangePreview.state !== "ok") return;
              onChange(rangePreview.merged);
              setMultiMode(true);
              setRangeOpen(false);
              setRangeFrom("");
              setRangeTo("");
              setRangeStep("");
            }}
            style={{ ...primaryBtn(rangePreview.state !== "ok"), padding: "6px 10px", fontSize: 11 }}
          >
            add range
          </button>
        </div>
      )}
    </span>
  );

  const libraryButton = libraryOptions && libraryOptions.length > 0 && (
    <LibraryPrefillPopover
      label="prefill from library"
      testId={`${testId}-library`}
      open={libraryOpen}
      onOpenChange={setLibraryOpen}
      query={libraryQuery}
      onQuery={setLibraryQuery}
      options={libraryOptions.map((o) => ({ key: canonicalSiString(siKind, o.valueSi), label: o.label }))}
      onPick={(key) => {
        const merged = canonicalAxisValues(siKind, [...values, key]);
        if (merged.length > CAMPAIGN_MAX_VALUES_PER_AXIS) {
          setAddError(`max ${CAMPAIGN_MAX_VALUES_PER_AXIS} values per axis`);
          return;
        }
        onChange(merged);
        if (merged.length > 1) setMultiMode(true);
      }}
    />
  );

  return (
    <div data-testid={testId} data-admin-field={fieldName} style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 4px", flexWrap: "wrap" }}>
        <label htmlFor={id} style={{ ...miniLabel, margin: 0 }}>
          {label}
        </label>
        {unitButton}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, alignItems: "center" }}>
          {libraryButton}
          {isMulti && rangeExpander}
        </span>
      </div>

      {!isMulti ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center" }}>
          <input
            id={id}
            aria-label={label}
            inputMode="decimal"
            value={singleFocused ? singleText : values.length === 1 ? chipLabel(values[0]) : singleText}
            onFocus={() => {
              setSingleFocused(true);
              setSingleText(values.length === 1 ? formatUnitNumber(unit.fromSi(Number(values[0]))) : "");
            }}
            onBlur={() => setSingleFocused(false)}
            onChange={(e) => commitSingleText(e.target.value)}
            aria-invalid={!!error}
            style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}
          />
          <button
            type="button"
            data-testid={`${testId}-add-value`}
            onClick={() => setMultiMode(true)}
            style={{ fontFamily: MONO, fontSize: 10, color: C.teal, background: "transparent", border: "none", borderBottom: `1px dotted ${C.teal}`, padding: 0, cursor: "pointer", whiteSpace: "nowrap" }}
          >
            add value
          </button>
        </div>
      ) : collapsed ? (
        <div data-testid={`${testId}-summary`} style={{ display: "flex", alignItems: "center", gap: 8, border: `1px solid ${error ? C.red : C.stroke}`, borderRadius: 8, background: C.panel2, padding: "8px 10px" }}>
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>
            {values.length} values · {min} – {max} {unit.label}
          </span>
          <button type="button" data-testid={`${testId}-summary-edit`} onClick={() => setSummaryOpen(true)} style={{ ...ghostBtn, marginLeft: "auto", padding: "4px 9px", fontSize: 10, color: C.teal }}>
            edit
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, border: `1px solid ${error ? C.red : C.stroke}`, borderRadius: 8, background: C.panel2, padding: 8, minHeight: 20 }}>
            {values.length === 0 && <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>no values yet</span>}
            {values.map((v, i) => {
              const chipError = chipErrors?.[v];
              return (
                <span key={v} data-admin-field={`${chipFieldPrefix} ${i + 1}`} data-testid={`${testId}-chip-${v}`} title={chipError} style={chipStyle(!!chipError)}>
                  <button
                    type="button"
                    aria-label={`${label} value ${chipLabel(v)} ${unit.label}`}
                    style={{ all: "unset", cursor: "default" }}
                  >
                    {chipLabel(v)}
                  </button>
                  <button type="button" aria-label={`Remove ${label.toLowerCase()} ${chipLabel(v)}`} onClick={() => removeChip(v)} style={{ background: "transparent", border: "none", color: C.dim, cursor: "pointer", padding: 0, fontFamily: MONO, fontSize: 11 }}>
                    ×
                  </button>
                </span>
              );
            })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8 }}>
            <input
              aria-label={`Add ${label.toLowerCase()} value`}
              inputMode="decimal"
              placeholder={`add value (${unit.label})`}
              value={addText}
              data-testid={`${testId}-add-input`}
              onChange={(e) => {
                setAddText(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && addValueFromText(addText)) setAddText("");
              }}
              style={{ ...inputStyle, padding: "8px 10px", fontSize: 12 }}
            />
            <button
              type="button"
              data-testid={`${testId}-add-confirm`}
              onClick={() => {
                if (addValueFromText(addText)) setAddText("");
              }}
              style={{ ...ghostBtn, padding: "6px 12px", color: C.teal }}
            >
              add
            </button>
          </div>
          {values.length > 8 && (
            <button type="button" onClick={() => setSummaryOpen(false)} style={{ ...ghostBtn, padding: "4px 9px", fontSize: 10, justifySelf: "start" }}>
              collapse to summary
            </button>
          )}
        </div>
      )}
      {addError && <div style={validationText}>{addError}</div>}
      {error && <div style={validationText}>{error}</div>}
    </div>
  );
}
