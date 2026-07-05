"use client";

// Shared campaign-wizard/hub UI primitives. These mirror the ValidationIssue +
// focus-on-error system and the field components that live (un-exported)
// inside AdminConsole.tsx — same shapes, same data-admin-field targeting, so a
// later consolidation can swap these for AdminConsole exports without churn.

import { type CSSProperties, type ReactNode } from "react";

import { C, MONO } from "@/lib/tokens";

// ---------------------------------------------------------------------------
// Validation (identical contract to AdminConsole.tsx)
// ---------------------------------------------------------------------------
export type ValidationIssue = {
  field: string;
  message: string;
};

export function requiredIssue(value: string | null | undefined, field: string, message = `${field} is required`): ValidationIssue | null {
  return value?.trim() ? null : { field, message };
}

export function requiredChoiceIssue(value: string | null | undefined, field: string): ValidationIssue | null {
  return value ? null : { field, message: `Choose ${field.toLowerCase()}` };
}

export function positiveIssue(value: number | null | undefined, field: string): ValidationIssue | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? null : { field, message: `${field} must be greater than 0` };
}

export function nonNegativeIssue(value: number | null | undefined, field: string): ValidationIssue | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? null : { field, message: `${field} must be 0 or greater` };
}

export function positiveIntegerIssue(value: number | null | undefined, field: string): ValidationIssue | null {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? null : { field, message: `${field} must be a positive integer` };
}

export function compactIssues(issues: Array<ValidationIssue | null>): ValidationIssue[] {
  return issues.filter((issue): issue is ValidationIssue => !!issue);
}

function adminFieldSelector(field: string) {
  const escaped = field.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  return `[data-admin-field="${escaped}"] input, [data-admin-field="${escaped}"] select, [data-admin-field="${escaped}"] textarea, [data-admin-field="${escaped}"] button`;
}

export function focusValidationIssue(issue: ValidationIssue | undefined) {
  if (!issue) return;
  window.setTimeout(() => {
    const target = document.querySelector<HTMLElement>(adminFieldSelector(issue.field));
    target?.focus();
  }, 0);
}

export function issueFor(issues: ValidationIssue[], field: string) {
  return issues.find((issue) => issue.field === field)?.message;
}

export function ValidationSummary({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return (
    <div role="alert" style={{ border: `1px solid ${C.red}`, borderRadius: 8, padding: "8px 10px", color: C.red, background: "rgba(245, 101, 101, 0.08)", fontFamily: MONO, fontSize: 11, lineHeight: 1.35 }}>
      {issues[0].message}
      {issues.length > 1 && <span style={{ color: C.redText }}> · {issues.length - 1} more</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles (mirroring AdminConsole.tsx constants)
// ---------------------------------------------------------------------------
export const card: CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 };
export const label: CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim, marginBottom: 8 };
export const miniLabel: CSSProperties = { fontFamily: MONO, fontSize: 10, color: C.dim, margin: "8px 0 4px" };
export const validationText: CSSProperties = { marginTop: 4, fontFamily: MONO, fontSize: 10, color: C.red };
export const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontFamily: MONO,
  fontSize: 13,
  color: C.text,
  background: C.panel2,
  border: `1px solid ${C.stroke}`,
  borderRadius: 8,
  padding: "10px 12px",
  outline: "none",
};
export const ghostBtn: CSSProperties = { fontFamily: MONO, fontSize: 12, color: C.muted, background: C.panel3, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer" };
export function primaryBtn(disabled: boolean): CSSProperties {
  return { fontFamily: MONO, fontSize: 12, fontWeight: 600, color: C.tealInk, background: C.teal, border: `1px solid ${C.teal}`, borderRadius: 8, padding: "8px 16px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 };
}

// ---------------------------------------------------------------------------
// Formatting helpers (same conventions as AdminConsole.tsx)
// ---------------------------------------------------------------------------
export function f(v: number | null | undefined, digits = 3): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

export function formatRe(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

export function fTemp(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} K` : "—";
}

export function fPressure(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} kPa` : `${v.toFixed(0)} Pa`;
}

export function fSpeed(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(2)} m/s` : "—";
}

export function fCount(v: number): string {
  return v.toLocaleString("en-US");
}

export function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Field primitives (same markup contract as AdminConsole.tsx fields)
// ---------------------------------------------------------------------------
export function TextField({ label: l, value, onChange, error, placeholder }: { label: string; value: string; onChange: (v: string) => void; error?: string; placeholder?: string }) {
  const id = `admin-field-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label style={{ display: "block" }} data-admin-field={l}>
      <div style={miniLabel}>{l}</div>
      <input aria-label={l} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }} />
      {error && <div id={`${id}-error`} style={validationText}>{error}</div>}
    </label>
  );
}

export function NumberField({ label: l, value, onChange, error, step }: { label: string; value: number; onChange: (v: number) => void; error?: string; step?: number | string }) {
  const id = `admin-field-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label style={{ display: "block" }} data-admin-field={l}>
      <div style={miniLabel}>{l}</div>
      <input aria-label={l} type="number" step={step} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }} />
      {error && <div id={`${id}-error`} style={validationText}>{error}</div>}
    </label>
  );
}

export function SelectField({
  label: l,
  value,
  options,
  optionLabels,
  onChange,
  error,
}: {
  label: string;
  value: string;
  options: string[];
  optionLabels?: Record<string, string>;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = `admin-field-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label style={{ display: "block" }} data-admin-field={l}>
      <div style={miniLabel}>{l}</div>
      <select aria-label={l} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}>
        {options.map((o) => (
          <option key={o} value={o}>
            {optionLabels?.[o] ?? o}
          </option>
        ))}
      </select>
      {error && <div id={`${id}-error`} style={validationText}>{error}</div>}
    </label>
  );
}

export function MetricChip({ label: l, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "grid", gap: 2, background: C.panel3, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "6px 7px", minWidth: 0, fontFamily: MONO, fontSize: 10 }}>
      <span style={{ color: C.dimmest }}>{l}</span>
      <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </span>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 12 }}>{text}</div>;
}

export function InfoLine({ text, tone = "dim" }: { text: string; tone?: "dim" | "amber" | "red" | "teal" }) {
  const color = tone === "amber" ? C.amber : tone === "red" ? C.red : tone === "teal" ? C.teal : C.dim;
  return <div style={{ fontFamily: MONO, fontSize: 11, color, lineHeight: 1.4 }}>{text}</div>;
}

/** Searchable popover that only ADDS values (spec §11 prefill-from-library). */
export function LibraryPrefillPopover({
  label: buttonLabel,
  options,
  onPick,
  open,
  onOpenChange,
  query,
  onQuery,
  testId,
}: {
  label: string;
  options: Array<{ key: string; label: string }>;
  onPick: (key: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  testId: string;
}) {
  const q = query.trim().toLowerCase();
  const visible = options.filter((o) => !q || o.label.toLowerCase().includes(q)).slice(0, 40);
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !e.currentTarget.contains(next)) onOpenChange(false);
      }}
    >
      <button type="button" data-testid={testId} aria-expanded={open} onClick={() => onOpenChange(!open)} style={{ ...ghostBtn, padding: "5px 9px", fontSize: 10, color: C.teal }}>
        {buttonLabel}
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0, minWidth: 240, maxWidth: 320, background: C.popover, border: `1px solid ${C.stroke}`, borderRadius: 8, boxShadow: `0 12px 28px ${C.shadow}`, padding: 8, display: "grid", gap: 6 }}>
          <input
            aria-label={`${buttonLabel} search`}
            autoFocus
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="search library…"
            style={{ ...inputStyle, padding: "7px 9px", fontSize: 11 }}
          />
          <div style={{ maxHeight: 200, overflow: "auto", display: "grid", gap: 4 }}>
            {visible.length === 0 ? (
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim, padding: "4px 2px" }}>no library matches</span>
            ) : (
              visible.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  data-testid={`${testId}-option-${o.key}`}
                  onClick={() => onPick(o.key)}
                  style={{ textAlign: "left", fontFamily: MONO, fontSize: 11, color: C.text, background: "transparent", border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "6px 8px", cursor: "pointer" }}
                >
                  {o.label}
                </button>
              ))
            )}
          </div>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.dimmest }}>picking adds a value — nothing is removed</span>
        </div>
      )}
    </span>
  );
}

export function ModalOverlay({ title, onClose, children, testId, width = "min(560px, 96vw)" }: { title: string; onClose: () => void; children: ReactNode; testId: string; width?: string }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: C.overlay, display: "grid", placeItems: "center", padding: 20 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ ...card, background: C.modalBg, width, maxHeight: "88vh", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div style={label}>{title}</div>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose} style={{ ...ghostBtn, padding: "4px 9px" }}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
