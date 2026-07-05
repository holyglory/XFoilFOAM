"use client";

// Add-airfoils dialog (spec §6.2/§11): scope picker minus already-included
// airfoils, server-computed preview itemizing the inherited active + kept
// cells (no opt-out), then apply with the preview's diffHash (stale_diff →
// refreshed preview + notice).

import { useEffect, useMemo, useState } from "react";

import {
  type AdminAirfoilOption,
  type AdminCampaignConditionSummary,
  type CampaignAddAirfoilsPreview,
  addCampaignAirfoils,
  getAdminSimulationSetup,
  previewCampaignAirfoils,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { fCount, formatRe, ghostBtn, inputStyle, ModalOverlay, primaryBtn } from "./ui";

export function AddAirfoilsDialog({
  campaignId,
  conditions,
  knownIncludedIds,
  onClose,
  onApplied,
}: {
  campaignId: string;
  conditions: AdminCampaignConditionSummary[];
  /** Airfoil ids already known to be in the campaign (loaded matrix pages) —
   *  pre-filters the picker; the server preview is authoritative for the rest. */
  knownIncludedIds: string[];
  onClose: () => void;
  onApplied: (addedAirfoils: number, addedPoints: number) => void;
}) {
  const [options, setOptions] = useState<AdminAirfoilOption[] | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<CampaignAddAirfoilsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAdminSimulationSetup()
      .then((setup) => {
        if (!cancelled) setOptions(setup.airfoilOptions);
      })
      .catch((e) => {
        if (!cancelled) setOptionsError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const included = useMemo(() => new Set(knownIncludedIds), [knownIncludedIds]);
  const conditionById = useMemo(() => new Map(conditions.map((c) => [c.id, c])), [conditions]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (options ?? [])
      .filter((a) => !included.has(a.id))
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q))
      .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.name.localeCompare(b.name))
      .slice(0, 100);
  }, [options, included, query, selected]);

  const toggle = (id: string) => {
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runPreview = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPreview(await previewCampaignAirfoils(campaignId, [...selected]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await addCampaignAirfoils(campaignId, { airfoilIds: [...selected], diffHash: preview.diffHash });
      onApplied(res.addedAirfoils, res.addedPoints);
      onClose();
    } catch (e) {
      // stale_diff 409 → recompute the itemized preview and ask again
      setNotice((e as Error).message);
      setPreview(null);
      await runPreview();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay title="ADD AIRFOILS" onClose={onClose} testId="add-airfoils-dialog">
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.dim, lineHeight: 1.5 }}>
          New airfoils inherit every active condition&apos;s requested cells and each kept condition&apos;s remaining solved-angle
          cells — itemized below before anything is queued. No opt-out per condition.
        </div>
        {optionsError && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red }}>{optionsError}</div>}
        <label style={{ display: "grid", gap: 5, fontFamily: MONO, fontSize: 11, color: C.dim }}>
          <span>
            Airfoils <span data-testid="add-airfoils-selected-count" style={{ color: C.teal }}>{selected.size} selected</span>
          </span>
          <input
            data-testid="add-airfoils-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search airfoils…"
            style={inputStyle}
          />
        </label>
        <div data-testid="add-airfoils-picker" style={{ maxHeight: 220, overflow: "auto", display: "grid", gap: 5, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: 8 }}>
          {options == null && !optionsError ? (
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>loading airfoil catalog…</span>
          ) : visible.length === 0 ? (
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>no airfoils match (already-included airfoils are hidden)</span>
          ) : (
            visible.map((a) => {
              const on = selected.has(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  data-testid={`add-airfoils-option-${a.slug}`}
                  onClick={() => toggle(a.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "18px minmax(0, 1fr)",
                    gap: 8,
                    alignItems: "center",
                    textAlign: "left",
                    background: on ? C.tealFill : "transparent",
                    border: `1px solid ${on ? C.tealBorder : C.borderSoft}`,
                    borderRadius: 6,
                    padding: "6px 8px",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 11, color: on ? C.teal : C.dimmest }}>{on ? "☑" : "☐"}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {a.name} <span style={{ color: C.dimmest }}>({a.slug})</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {notice && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber, lineHeight: 1.45 }}>{notice}</div>}
        {error && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, lineHeight: 1.45 }}>{error}</div>}

        {preview && (
          <div data-testid="add-airfoils-preview" style={{ display: "grid", gap: 7, border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: "10px 12px" }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>
              {fCount(preview.newAirfoilIds.length)} new airfoil{preview.newAirfoilIds.length === 1 ? "" : "s"} ·{" "}
              {fCount(preview.addedPoints)} points · {fCount(preview.addedSolverRuns)} solver runs
            </span>
            {preview.alreadyIncluded.length > 0 && (
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                {fCount(preview.alreadyIncluded.length)} selected airfoil{preview.alreadyIncluded.length === 1 ? " is" : "s are"} already in the campaign — skipped
              </span>
            )}
            <div style={{ display: "grid", gap: 3 }}>
              {preview.perCondition.map((pc) => {
                const c = conditionById.get(pc.conditionId);
                return (
                  <div key={pc.conditionId} style={{ display: "flex", gap: 8, alignItems: "baseline", fontFamily: MONO, fontSize: 10, color: C.muted }}>
                    <span style={{ color: pc.status === "kept" ? C.amber : C.text }}>
                      {pc.status === "kept" ? "⚑ " : ""}
                      {c ? `Re ${formatRe(c.reynolds)} · #${c.ord}` : pc.conditionId.slice(0, 8)}
                    </span>
                    <span>
                      {fCount(pc.cellCount)} angle cell{pc.cellCount === 1 ? "" : "s"} per airfoil
                      {pc.status === "kept" ? " (kept — remaining solved-angle set only)" : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={ghostBtn}>
            cancel
          </button>
          {!preview ? (
            <button
              type="button"
              data-testid="add-airfoils-preview-btn"
              disabled={busy || selected.size === 0}
              onClick={() => void runPreview()}
              style={primaryBtn(busy || selected.size === 0)}
            >
              {busy ? "computing preview…" : `Preview ${fCount(selected.size)} airfoil${selected.size === 1 ? "" : "s"}`}
            </button>
          ) : (
            <button
              type="button"
              data-testid="add-airfoils-apply"
              disabled={busy || preview.newAirfoilIds.length === 0}
              onClick={() => void apply()}
              style={primaryBtn(busy || preview.newAirfoilIds.length === 0)}
            >
              {busy
                ? "adding…"
                : `Add ${fCount(preview.newAirfoilIds.length)} airfoil${preview.newAirfoilIds.length === 1 ? "" : "s"} — ${fCount(preview.addedPoints)} points`}
            </button>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
