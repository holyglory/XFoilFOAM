"use client";

// Requeue-failed dialog (spec §11): failure groups by errorClass with real
// counts + checkboxes, optional condition/airfoil scoping, an amber warning
// when listed points already failed ≥3 attempts, a confirm button carrying
// the exact selected count (server re-verifies; 409 drift → refresh).

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type AdminCampaignConditionSummary,
  type AdminCampaignFailureGroup,
  type CampaignErrorClass,
  getCampaignFailures,
  requeueCampaignFailed,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { f, fCount, formatRe, ghostBtn, inputStyle, ModalOverlay, primaryBtn } from "./ui";

export function RequeueDialog({
  campaignId,
  conditions,
  initialConditionId,
  scopedAirfoil,
  onClose,
  onApplied,
}: {
  campaignId: string;
  conditions: AdminCampaignConditionSummary[];
  initialConditionId?: string | null;
  scopedAirfoil?: { airfoilId: string; slug: string; name: string } | null;
  onClose: () => void;
  onApplied: (requeued: number) => void;
}) {
  const [conditionId, setConditionId] = useState<string>(initialConditionId ?? "");
  const [failures, setFailures] = useState<{ total: number; groups: AdminCampaignFailureGroup[] } | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCampaignFailures(campaignId, {
        conditionId: conditionId || undefined,
        airfoilId: scopedAirfoil?.airfoilId,
      });
      setFailures(data);
      // default: every class selected
      setChecked(Object.fromEntries(data.groups.map((g) => [g.errorClass, true])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [campaignId, conditionId, scopedAirfoil?.airfoilId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedGroups = useMemo(() => (failures?.groups ?? []).filter((g) => checked[g.errorClass]), [failures, checked]);
  const selectedCount = selectedGroups.reduce((s, g) => s + g.count, 0);
  const allSelected = failures != null && selectedGroups.length === failures.groups.length;
  const hasRetryVeterans = selectedGroups.some((g) => g.samples.some((s) => s.attempts >= 3));

  const apply = async () => {
    if (!failures || selectedCount === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requeueCampaignFailed(campaignId, {
        errorClasses: allSelected ? undefined : (selectedGroups.map((g) => g.errorClass) as CampaignErrorClass[]),
        conditionId: conditionId || undefined,
        airfoilId: scopedAirfoil?.airfoilId,
        expectedCount: selectedCount,
      });
      onApplied(res.requeued);
      onClose();
    } catch (e) {
      // 409 drift → the server states the real count; reload the groups
      setError((e as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay title="REQUEUE FAILED POINTS" onClose={onClose} testId="requeue-dialog">
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "grid", gap: 4, fontFamily: MONO, fontSize: 10, color: C.dim, minWidth: 220 }}>
            condition scope
            <select
              data-testid="requeue-condition-scope"
              value={conditionId}
              onChange={(e) => setConditionId(e.target.value)}
              style={{ ...inputStyle, padding: "7px 9px", fontSize: 11 }}
            >
              <option value="">all conditions</option>
              {conditions
                .filter((c) => c.status !== "released")
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    Re {formatRe(c.reynolds)} · #{c.ord} · {f(c.speedMps, 2)} m/s
                  </option>
                ))}
            </select>
          </label>
          {scopedAirfoil && (
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "4px 9px" }}>
              airfoil: {scopedAirfoil.name}
            </span>
          )}
        </div>

        {error && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, lineHeight: 1.4 }}>{error}</div>}

        {loading ? (
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, padding: "14px 0" }}>counting failed points…</div>
        ) : failures && failures.groups.length === 0 ? (
          <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, padding: "14px 0" }}>no failed points in this scope</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {failures?.groups.map((g) => (
              <label
                key={g.errorClass}
                data-testid={`requeue-group-${g.errorClass}`}
                style={{ display: "grid", gridTemplateColumns: "18px minmax(0,1fr)", gap: 8, border: `1px solid ${checked[g.errorClass] ? C.tealBorder : C.borderSoft}`, borderRadius: 8, padding: "8px 10px", cursor: "pointer", background: checked[g.errorClass] ? C.tealFill : "transparent" }}
              >
                <input
                  type="checkbox"
                  checked={!!checked[g.errorClass]}
                  onChange={(e) => setChecked((prev) => ({ ...prev, [g.errorClass]: e.target.checked }))}
                  style={{ marginTop: 2 }}
                />
                <span style={{ display: "grid", gap: 3, minWidth: 0 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.text }}>
                    <span style={{ fontWeight: 700, color: C.redText }}>{g.errorClass}</span> · {fCount(g.count)} point{g.count === 1 ? "" : "s"}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, lineHeight: 1.5 }}>
                    {g.samples.slice(0, 3).map((s) => `${s.airfoilSlug} α ${f(s.aoaDeg, 1)}° (${s.attempts}×)`).join(" · ")}
                    {g.count > 3 ? " · …" : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {hasRetryVeterans && (
          <div data-testid="requeue-attempts-warning" style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber, border: "1px solid rgba(245,158,11,0.4)", borderRadius: 8, padding: "7px 10px", lineHeight: 1.45 }}>
            Some selected points have already failed 3 or more attempts — requeueing retries them with the same pinned setup.
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 2 }}>
          <button type="button" onClick={onClose} style={ghostBtn}>
            cancel
          </button>
          <button
            type="button"
            data-testid="requeue-confirm"
            disabled={busy || selectedCount === 0}
            onClick={() => void apply()}
            style={primaryBtn(busy || selectedCount === 0)}
          >
            {busy ? "requeueing…" : `Requeue ${fCount(selectedCount)} failed point${selectedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
