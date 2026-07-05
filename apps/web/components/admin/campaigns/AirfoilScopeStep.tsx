"use client";

// Wizard step 1 (spec §11): airfoil scope — all / category subtree /
// searchable multi-select — with a live resolved count. The scope is resolved
// to an explicit airfoil-id list before Review ("snapshot at launch").
// The multi-select mirrors the PresetAirfoilPicker UX from AdminConsole.tsx
// (un-exported there) with campaign-scoped testids.

import type { CategoryNode } from "@aerodb/core";

import type { AdminAirfoilOption } from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { fCount, ghostBtn, InfoLine, inputStyle, label as labelStyle, miniLabel, type ValidationIssue, ValidationSummary } from "./ui";

export type ScopeMode = "all" | "category" | "manual";

export interface ResolvedScope {
  /** Explicit list the launch/preview payloads use. */
  airfoils: AdminAirfoilOption[];
  /** Category resolution in flight (count not yet real). */
  loading: boolean;
  error: string | null;
}

export interface AirfoilScopeStepProps {
  airfoilOptions: AdminAirfoilOption[];
  categories: CategoryNode[];
  scopeMode: ScopeMode;
  categoryId: string | null;
  manualAirfoilIds: string[];
  query: string;
  onQuery: (q: string) => void;
  onScopeMode: (mode: ScopeMode) => void;
  onCategoryId: (id: string | null) => void;
  onManualIds: (ids: string[]) => void;
  resolved: ResolvedScope;
  issues: ValidationIssue[];
}

function flattenCategories(nodes: CategoryNode[], depth = 0): Array<{ node: CategoryNode; depth: number }> {
  const out: Array<{ node: CategoryNode; depth: number }> = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flattenCategories(node.children ?? [], depth + 1));
  }
  return out;
}

const SCOPE_OPTIONS: Array<{ k: ScopeMode; label: string; hint: string }> = [
  { k: "all", label: "All airfoils", hint: "every active catalog profile" },
  { k: "category", label: "Category subtree", hint: "a category and everything under it" },
  { k: "manual", label: "Select manually", hint: "searchable multi-select" },
];

export function AirfoilScopeStep({
  airfoilOptions,
  categories,
  scopeMode,
  categoryId,
  manualAirfoilIds,
  query,
  onQuery,
  onScopeMode,
  onCategoryId,
  onManualIds,
  resolved,
  issues,
}: AirfoilScopeStepProps) {
  const flat = flattenCategories(categories);
  const selected = new Set(manualAirfoilIds);
  const q = query.trim().toLowerCase();
  const visible = airfoilOptions
    .filter((airfoil) => !q || airfoil.name.toLowerCase().includes(q) || airfoil.slug.toLowerCase().includes(q))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.name.localeCompare(b.name))
    .slice(0, 80);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onManualIds(Array.from(next));
  };

  const symmetricCount = resolved.airfoils.filter((a) => a.isSymmetric).length;

  return (
    <div data-testid="wizard-airfoil-scope" style={{ display: "grid", gap: 12 }}>
      <div style={labelStyle}>1 · AIRFOILS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
        {SCOPE_OPTIONS.map((option) => {
          const on = scopeMode === option.k;
          return (
            <button
              key={option.k}
              type="button"
              data-testid={`scope-mode-${option.k}`}
              aria-pressed={on}
              onClick={() => onScopeMode(option.k)}
              style={{
                display: "grid",
                gap: 4,
                textAlign: "left",
                fontFamily: MONO,
                fontSize: 12,
                color: on ? C.teal : C.text,
                background: on ? C.tealFill : C.panel2,
                border: `1px solid ${on ? C.tealBorder : C.stroke}`,
                borderRadius: 8,
                padding: "10px 12px",
                cursor: "pointer",
              }}
            >
              <span style={{ fontWeight: on ? 600 : 400 }}>{option.label}</span>
              <span style={{ fontSize: 10, color: C.dim }}>{option.hint}</span>
            </button>
          );
        })}
      </div>

      {scopeMode === "category" && (
        <label style={{ display: "block" }} data-admin-field="Scope category">
          <div style={miniLabel}>Category subtree</div>
          <select
            aria-label="Scope category"
            data-testid="scope-category-select"
            value={categoryId ?? ""}
            onChange={(e) => onCategoryId(e.target.value || null)}
            style={inputStyle}
          >
            <option value="">choose category</option>
            {flat.map(({ node, depth }) => (
              <option key={node.id} value={node.id}>
                {`${" ".repeat(depth * 2)}${node.name} (${node.airfoilCount})`}
              </option>
            ))}
          </select>
        </label>
      )}

      {scopeMode === "manual" && (
        <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
          <label style={{ display: "grid", gap: 5, fontFamily: MONO, fontSize: 11, color: C.dim }} data-admin-field="Scope airfoils">
            <span>
              Profiles <span data-testid="campaign-airfoil-selected-count" style={{ color: C.teal }}>{manualAirfoilIds.length} selected</span>
            </span>
            <input data-testid="campaign-airfoil-search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="search profiles..." style={inputStyle} />
          </label>
          <div data-testid="campaign-airfoil-picker" style={{ maxHeight: 260, overflow: "auto", display: "grid", gap: 5, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: 8 }}>
            {visible.length === 0 ? (
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>no profiles match</span>
            ) : (
              visible.map((airfoil) => {
                const checked = selected.has(airfoil.id);
                return (
                  <button
                    key={airfoil.id}
                    type="button"
                    data-testid={`campaign-airfoil-option-${airfoil.slug}`}
                    onClick={() => toggle(airfoil.id)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "18px minmax(0, 1fr) auto",
                      gap: 8,
                      alignItems: "center",
                      textAlign: "left",
                      background: checked ? C.rowActive : "transparent",
                      color: checked ? C.teal : C.text,
                      border: `1px solid ${checked ? C.tealBorder : C.borderSoft}`,
                      borderRadius: 6,
                      padding: "6px 8px",
                      fontFamily: MONO,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, border: `1px solid ${checked ? C.teal : C.dim}`, background: checked ? C.teal : "transparent" }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{airfoil.name}</span>
                    {airfoil.isSymmetric && <span style={{ fontSize: 9, color: C.dim, border: `1px solid ${C.borderSoft}`, borderRadius: 999, padding: "1px 6px" }}>symmetric</span>}
                  </button>
                );
              })
            )}
          </div>
          {manualAirfoilIds.length > 0 && (
            <button type="button" onClick={() => onManualIds([])} style={{ ...ghostBtn, padding: "4px 9px", fontSize: 10, justifySelf: "start" }}>
              clear selection
            </button>
          )}
        </div>
      )}

      <div data-testid="scope-resolved-count" style={{ fontFamily: MONO, fontSize: 12, color: resolved.error ? C.red : C.text, borderTop: `1px solid ${C.borderRule}`, paddingTop: 10 }}>
        {resolved.error
          ? `couldn't resolve scope: ${resolved.error}`
          : resolved.loading
            ? "resolving scope…"
            : `${fCount(resolved.airfoils.length)} airfoils resolved${symmetricCount > 0 ? ` · ${fCount(symmetricCount)} symmetric` : ""}`}
      </div>
      <InfoLine text="Scope is snapshotted at launch — later catalog additions do not join automatically (use Add airfoils on the campaign)." />
      <ValidationSummary issues={issues} />
    </div>
  );
}
