"use client";

import { type CSSProperties, useEffect, useId, useState } from "react";

import { formatUnitNumber, parseUnitNumber, UNIT_DEFINITIONS, type UnitDimension, unitFor } from "@/lib/unit-conversions";
import { C, MONO } from "@/lib/tokens";

interface UnitNumberFieldProps {
  label: string;
  valueSi: number;
  onChangeSi: (value: number) => void;
  dimension: UnitDimension;
  preferredUnitKey?: string;
  min?: number;
  step?: string | number;
  error?: string;
}

const fieldLabel: CSSProperties = { fontFamily: MONO, fontSize: 10, color: C.dim };
const inputStyle: CSSProperties = {
  width: "100%",
  fontFamily: MONO,
  fontSize: 13,
  color: C.text,
  background: C.panel2,
  border: `1px solid ${C.stroke}`,
  borderRadius: 8,
  padding: "10px 12px",
  outline: "none",
};
const errorStyle: CSSProperties = { marginTop: 4, fontFamily: MONO, fontSize: 10, color: C.red };

function fieldSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function UnitNumberField({
  label,
  valueSi,
  onChangeSi,
  dimension,
  preferredUnitKey,
  min,
  step,
  error,
}: UnitNumberFieldProps) {
  const id = useId();
  const [unitKey, setUnitKey] = useState(() => unitFor(dimension, preferredUnitKey).key);
  const unit = unitFor(dimension, unitKey);
  const [text, setText] = useState(() => formatUnitNumber(unit.fromSi(valueSi)));
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!focused) setText(formatUnitNumber(unit.fromSi(valueSi)));
  }, [focused, unit, valueSi]);

  const chooseUnit = (nextUnitKey: string) => {
    const next = unitFor(dimension, nextUnitKey);
    setUnitKey(next.key);
    setText(formatUnitNumber(next.fromSi(valueSi)));
    setOpen(false);
  };

  const changeText = (raw: string) => {
    setText(raw);
    const parsed = parseUnitNumber(raw);
    if (parsed == null) return;
    const nextSi = unit.toSi(parsed);
    if (min != null && nextSi < min) return;
    if (Number.isFinite(nextSi)) onChangeSi(nextSi);
  };

  return (
    <div
      style={{ display: "block", position: "relative" }}
      data-testid={`unit-field-${fieldSlug(label)}`}
      data-admin-field={label}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !e.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 4px" }}>
        <label htmlFor={id} style={fieldLabel}>
          {label}
        </label>
        <button
          type="button"
          aria-label={`${label} unit`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: C.teal,
            background: "transparent",
            border: "none",
            borderBottom: `1px dotted ${C.teal}`,
            padding: 0,
            cursor: "pointer",
            lineHeight: 1.1,
          }}
        >
          {unit.label}
        </button>
      </div>
      <input
        id={id}
        aria-label={label}
        inputMode="decimal"
        value={text}
        data-step={step}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
        }}
        onChange={(e) => changeText(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}
      />
      {error && <div id={`${id}-error`} style={errorStyle}>{error}</div>}
      {open && (
        <div
          role="menu"
          aria-label={`${label} units`}
          onMouseDown={(e) => e.preventDefault()}
          style={{
            position: "absolute",
            zIndex: 20,
            top: 26,
            left: 0,
            minWidth: 88,
            display: "grid",
            gap: 2,
            padding: 5,
            background: C.popover,
            border: `1px solid ${C.stroke}`,
            borderRadius: 8,
            boxShadow: `0 12px 28px ${C.shadow}`,
          }}
        >
          {UNIT_DEFINITIONS[dimension].map((candidate) => (
            <button
              key={candidate.key}
              type="button"
              role="menuitemradio"
              aria-checked={candidate.key === unit.key}
              onClick={() => chooseUnit(candidate.key)}
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: candidate.key === unit.key ? C.teal : C.text,
                background: candidate.key === unit.key ? C.tealFill : "transparent",
                border: "none",
                borderRadius: 6,
                padding: "6px 8px",
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
