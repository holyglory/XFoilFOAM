"use client";

// Plan-edit dialogs (spec §6/§11): "Edit conditions" and "Edit angle plan"
// REUSE the wizard step editors (ConditionsStep / AnglePlanStep) with exactly
// the spec's three deltas — medium read-only, a one-line semantics banner,
// and submit → the §6.1 preview → acknowledge protocol with outcome-named
// sections, verbatim closure copy, real totals on the Apply button, and
// stale-diff / conflict handling.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { MediumDTO } from "@aerodb/core";

import {
  type AdminAirfoilOption,
  type AdminCampaignSummary,
  type AdminSimulationSetup,
  type CampaignPlanApplyResult,
  type CampaignPlanDiff,
  type CampaignPlanInput,
  applyCampaignPlan,
  getAdminMediums,
  getAdminSimulationSetup,
  getCampaignAirfoils,
  previewCampaignPlan,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { AnglePlanStep } from "./AnglePlanStep";
import { ConditionsStep } from "./ConditionsStep";
import {
  CAMPAIGN_CONFIRM_THRESHOLD,
  buildPlanInput,
  sweepSetsOf,
  type WizardAnglePlan,
  type WizardEnvelope,
} from "./plan-model";
import {
  compactIssues,
  fCount,
  focusValidationIssue,
  ghostBtn,
  inputStyle,
  label as labelStyle,
  positiveIssue,
  primaryBtn,
  requiredChoiceIssue,
  type ValidationIssue,
} from "./ui";

export type PlanEditMode = "conditions" | "angle";

/** Exact §6.1 closure sentence — rendered verbatim as copy AND tooltip. */
const CLOSURE_SENTENCE =
  "Conditions that already have results for any airfoil will stay and finish for all airfoils — removing values only cancels conditions nothing has been solved at yet.";

/** Objective-delta chip labels in the acknowledge stage (all three lanes). */
const OBJECTIVE_DELTA_LABEL: Record<string, string> = {
  ld_max: "max L/D",
  cl_zero: "α₀",
  cl_max: "Cl_max",
};

const SEMANTICS_BANNER: Record<PlanEditMode, string> = {
  conditions: "Edits reshape future work only — conditions with results stay to finish for all airfoils; solved results are never deleted.",
  angle: "Angle edits reshape future work only — solved angles stay for all airfoils; removed unsolved angles are released.",
};

function envelopeFromPlan(plan: CampaignPlanInput): WizardEnvelope {
  return {
    mediumId: plan.mediumId,
    ambients: plan.ambients.map((a) => [a[0], a[1]]),
    speedsMps: [...plan.speedsMps],
    chordsM: [...plan.chordsM],
    spanM: plan.spanM,
    areaMode: plan.areaMode,
    areaM2: plan.areaM2,
    excludedConditions: plan.excludedConditions.map((x) => [x[0], x[1], x[2], x[3]]),
  };
}

function anglePlanFromPlan(plan: CampaignPlanInput): WizardAnglePlan {
  return {
    sweepMode: plan.baseSweep.listDeg != null ? "list" : "range",
    fromDeg: plan.baseSweep.fromDeg != null ? Number(plan.baseSweep.fromDeg) : -10,
    toDeg: plan.baseSweep.toDeg != null ? Number(plan.baseSweep.toDeg) : 20,
    stepDeg: plan.baseSweep.stepDeg != null ? Number(plan.baseSweep.stepDeg) : 1,
    listText: plan.baseSweep.listDeg?.map((a) => String(Number(a))).join(", ") ?? "",
    ldMax: { enabled: plan.objectives.ldMax.enabled, toleranceDeg: Number(plan.objectives.ldMax.toleranceDeg), maxRounds: plan.objectives.ldMax.maxRounds },
    clZero: { enabled: plan.objectives.clZero.enabled, toleranceDeg: Number(plan.objectives.clZero.toleranceDeg), maxRounds: plan.objectives.clZero.maxRounds },
    // Pre-clMax plan revisions carry no block — edit from disabled defaults.
    clMax: plan.objectives.clMax
      ? { enabled: plan.objectives.clMax.enabled, toleranceDeg: Number(plan.objectives.clMax.toleranceDeg), maxRounds: plan.objectives.clMax.maxRounds }
      : { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
  };
}

export function PlanEditDialogs({
  mode,
  campaignId,
  summary,
  onClose,
  onApplied,
  onRefreshSummary,
}: {
  mode: PlanEditMode;
  campaignId: string;
  summary: AdminCampaignSummary;
  onClose: () => void;
  onApplied: (result: CampaignPlanApplyResult) => void;
  onRefreshSummary: () => Promise<void>;
}) {
  const basePlan = summary.campaign.plan;
  const baseRevision = summary.campaign.planRevisionNumber;

  const [envelope, setEnvelope] = useState<WizardEnvelope>(() => envelopeFromPlan(basePlan));
  const [angle, setAngle] = useState<WizardAnglePlan>(() => anglePlanFromPlan(basePlan));
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const [mediums, setMediums] = useState<MediumDTO[]>([]);
  const [setup, setSetup] = useState<AdminSimulationSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Real campaign scope (isSymmetric flags drive the honest arithmetic lines).
  const [campaignAirfoils, setCampaignAirfoils] = useState<AdminAirfoilOption[] | null>(null);

  const [stage, setStage] = useState<"edit" | "ack">("edit");
  const [diff, setDiff] = useState<CampaignPlanDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // reload the draft whenever another edit landed and the summary refreshed
  useEffect(() => {
    setEnvelope(envelopeFromPlan(summary.campaign.plan));
    setAngle(anglePlanFromPlan(summary.campaign.plan));
    setStage("edit");
    setDiff(null);
    setConflict(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary.campaign.planRevisionNumber]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getAdminMediums(), getAdminSimulationSetup()])
      .then(([m, s]) => {
        if (cancelled) return;
        setMediums(m.items);
        setSetup(s);
      })
      .catch((e) => {
        if (!cancelled) setLoadError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const all: AdminAirfoilOption[] = [];
      let cursor: string | null = null;
      // full scope: campaigns cap at 5,000 airfoils (spec §5) → ≤50 pages
      do {
        const page: Awaited<ReturnType<typeof getCampaignAirfoils>> = await getCampaignAirfoils(campaignId, cursor, 100);
        for (const row of page.items) all.push({ id: row.airfoilId, slug: row.slug, name: row.name, isSymmetric: row.isSymmetric });
        cursor = page.nextCursor;
      } while (cursor != null && !cancelled);
      if (!cancelled) setCampaignAirfoils(all);
    })().catch(() => {
      if (!cancelled) setCampaignAirfoils([]);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const resolvedAirfoils = campaignAirfoils ?? [];
  const symmetricCount = resolvedAirfoils.filter((a) => a.isSymmetric).length;
  const expansion = sweepSetsOf(angle);
  const activeConditionCount = summary.conditions.filter((c) => c.status === "active").length;

  const validate = useCallback((): ValidationIssue[] => {
    if (mode === "angle") {
      const list: Array<ValidationIssue | null> = [];
      if (!expansion.sets) list.push({ field: angle.sweepMode === "list" ? "AoA list °" : "AoA step °", message: expansion.error ?? "invalid sweep" });
      if ((angle.ldMax.enabled || angle.clZero.enabled || angle.clMax.enabled) && expansion.sets && expansion.sets.angles.length < 3) {
        list.push({ field: angle.sweepMode === "list" ? "AoA list °" : "AoA from °", message: "Refinement objectives need a base sweep of at least 3 angles" });
      }
      if (angle.ldMax.enabled) list.push(positiveIssue(angle.ldMax.toleranceDeg, "Max L/D tolerance ±°"), positiveIssue(angle.ldMax.maxRounds, "Max L/D rounds"));
      if (angle.clZero.enabled) list.push(positiveIssue(angle.clZero.toleranceDeg, "Zero-lift tolerance ±°"), positiveIssue(angle.clZero.maxRounds, "Zero-lift rounds"));
      if (angle.clMax.enabled) list.push(positiveIssue(angle.clMax.toleranceDeg, "Cl_max tolerance ±°"), positiveIssue(angle.clMax.maxRounds, "Cl_max rounds"));
      return compactIssues(list);
    }
    return compactIssues([
      requiredChoiceIssue(envelope.mediumId, "Medium"),
      envelope.ambients.length === 0 ? { field: "Ambients", message: "Add at least one ambient (T, P) pair" } : null,
      envelope.speedsMps.length === 0 ? { field: "Speeds", message: "Add at least one speed" } : null,
      envelope.chordsM.length === 0 ? { field: "Chords", message: "Add at least one chord" } : null,
    ]);
  }, [mode, envelope, angle, expansion]);

  const planInput = useMemo(
    () => buildPlanInput(envelope, angle, basePlan.numerics),
    [envelope, angle, basePlan.numerics],
  );

  const runPreview = async () => {
    const next = validate();
    setIssues(next);
    if (next.length > 0) {
      focusValidationIssue(next[0]);
      return;
    }
    setBusy(true);
    setError(null);
    setStaleNotice(null);
    try {
      const result = await previewCampaignPlan(campaignId, { plan: planInput, basePlanRevisionNumber: baseRevision });
      setDiff(result);
      setConfirmText("");
      setStage("ack");
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      if (message.includes("changed while you were editing") || message.includes("reload")) setConflict(true);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!diff) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyCampaignPlan(campaignId, {
        plan: planInput,
        basePlanRevisionNumber: baseRevision,
        diffHash: diff.diffHash,
      });
      onApplied(result);
      onClose();
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("Results landed while you were reviewing")) {
        // 409 stale_diff — recompute the diff and show the exact server notice
        setStaleNotice(message);
        try {
          const refreshed = await previewCampaignPlan(campaignId, { plan: planInput, basePlanRevisionNumber: baseRevision });
          setDiff(refreshed);
          setConfirmText("");
        } catch (inner) {
          setError((inner as Error).message);
          setConflict(true);
        }
      } else {
        setError(message);
        if (message.includes("another plan edit landed first")) setConflict(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const needsConfirm = diff != null && diff.addedPoints > CAMPAIGN_CONFIRM_THRESHOLD;
  const confirmOk = !needsConfirm || confirmText.trim() === summary.campaign.name.trim();

  const title = mode === "conditions" ? "EDIT CONDITIONS" : "EDIT ANGLE PLAN";

  const angleFmt = (a: number) => `${Math.round(a * 100) / 100}°`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={`plan-edit-dialog-${mode}`}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: C.overlay, display: "grid", placeItems: "center", padding: 18 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ background: C.modalBg, border: `1px solid ${C.border}`, borderRadius: 12, width: stage === "edit" ? "min(880px, 96vw)" : "min(640px, 96vw)", maxHeight: "90vh", overflow: "auto", padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div style={labelStyle}>{title} · plan r{baseRevision}</div>
          <button type="button" aria-label={`Close ${title}`} onClick={onClose} style={{ ...ghostBtn, padding: "4px 9px" }}>
            ×
          </button>
        </div>

        {/* one-line semantics banner (spec §6) */}
        <div data-testid="plan-edit-banner" style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber, border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.06)", borderRadius: 8, padding: "7px 10px", marginBottom: 12, lineHeight: 1.45 }}>
          {SEMANTICS_BANNER[mode]}
        </div>

        {loadError && <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, marginBottom: 10 }}>{loadError}</div>}
        {error && (
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.red, marginBottom: 10, lineHeight: 1.45 }}>
            {error}
            {conflict && (
              <button
                type="button"
                data-testid="plan-edit-reload"
                onClick={() => {
                  setError(null);
                  setConflict(false);
                  void onRefreshSummary();
                }}
                style={{ ...ghostBtn, marginLeft: 10, padding: "3px 9px", fontSize: 10 }}
              >
                reload current plan
              </button>
            )}
          </div>
        )}

        {stage === "edit" ? (
          <div style={{ display: "grid", gap: 12 }}>
            {mode === "conditions" ? (
              setup ? (
                <ConditionsStep
                  mediums={mediums}
                  setup={setup}
                  envelope={envelope}
                  onEnvelope={(patch) => setEnvelope((prev) => ({ ...prev, ...patch }))}
                  onMediumCreated={() => undefined}
                  angleSets={expansion.sets}
                  airfoilCount={summary.airfoilCount}
                  symmetricCount={symmetricCount}
                  issues={issues}
                  mediumLocked
                />
              ) : (
                <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, padding: "18px 0" }}>loading setup library…</div>
              )
            ) : (
              <AnglePlanStep
                angle={angle}
                onAngle={(patch) => setAngle((prev) => ({ ...prev, ...patch }))}
                resolvedAirfoils={resolvedAirfoils}
                conditionCount={activeConditionCount}
                issues={issues}
              />
            )}
            {campaignAirfoils == null && (
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim }}>loading campaign airfoil scope for exact arithmetic…</div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={onClose} style={ghostBtn}>
                cancel
              </button>
              <button type="button" data-testid="plan-edit-preview" disabled={busy} onClick={() => void runPreview()} style={primaryBtn(busy)}>
                {busy ? "computing real diff…" : "Preview changes"}
              </button>
            </div>
          </div>
        ) : diff ? (
          <div data-testid="plan-ack-dialog" style={{ display: "grid", gap: 12 }}>
            {staleNotice && (
              <div data-testid="plan-ack-stale-notice" style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber, border: "1px solid rgba(245,158,11,0.4)", borderRadius: 8, padding: "7px 10px", lineHeight: 1.45 }}>
                {staleNotice}
              </div>
            )}

            {/* ---- Adding ---- */}
            <section data-testid="plan-ack-adding" style={{ border: `1px solid ${C.tealBorder}`, borderRadius: 10, padding: "10px 12px", display: "grid", gap: 5 }}>
              <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.teal }}>ADDING</span>
              {diff.addedConditions.length === 0 && diff.reactivatedConditions.length === 0 && diff.addedAngles.length === 0 && diff.addedPoints === 0 && diff.objectiveDeltas.length === 0 ? (
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.dim }}>nothing added</span>
              ) : (
                <>
                  {diff.addedConditions.length > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      {fCount(diff.addedConditions.length)} new condition{diff.addedConditions.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {diff.reactivatedConditions.length > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      {fCount(diff.reactivatedConditions.length)} previously released condition{diff.reactivatedConditions.length === 1 ? "" : "s"} re-activated (same pinned revision — evidence continuity)
                    </span>
                  )}
                  {diff.addedAngles.length > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      {fCount(diff.addedAngles.length)} new angle{diff.addedAngles.length === 1 ? "" : "s"}: {diff.addedAngles.slice(0, 8).map(angleFmt).join(", ")}
                      {diff.addedAngles.length > 8 ? " …" : ""}
                    </span>
                  )}
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>
                    {fCount(diff.addedPoints)} points · {fCount(diff.addedSolverRuns)} solver runs
                    {diff.reactivatedPoints > 0 ? ` · ${fCount(diff.reactivatedPoints)} reactivated` : ""}
                  </span>
                  {diff.objectiveDeltas.length > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>
                      objectives:{" "}
                      {diff.objectiveDeltas
                        .map((d) => `${OBJECTIVE_DELTA_LABEL[d.objective] ?? d.objective} ${d.changes.join(", ").replaceAll("_", " ")} (±${d.toleranceDeg}°)`)
                        .join(" · ")}
                    </span>
                  )}
                </>
              )}
            </section>

            {/* ---- Kept to finish (amber, closure sentence verbatim) ---- */}
            <section
              data-testid="plan-ack-kept"
              title={CLOSURE_SENTENCE}
              style={{ border: "1px solid rgba(245,158,11,0.45)", borderRadius: 10, padding: "10px 12px", display: "grid", gap: 5 }}
            >
              <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.amber }}>KEPT TO FINISH</span>
              {diff.keptConditions.length === 0 && diff.removedAngleKeptCells === 0 ? (
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.dim }}>nothing kept — no removed work has results yet</span>
              ) : (
                <>
                  {diff.keptConditions.map((k) => (
                    <span key={k.conditionId} style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      ⚑ {k.comboKey.split("|").join(" · ")} — {fCount(k.solvedAngles.length)} solved angle{k.solvedAngles.length === 1 ? "" : "s"} finish for all airfoils ({fCount(k.keptOpenPoints)} open points); {fCount(k.releasedPoints)} unsolved released
                    </span>
                  ))}
                  {diff.removedAngleKeptCells > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      {fCount(diff.removedAngleKeptCells)} removed-angle cell{diff.removedAngleKeptCells === 1 ? "" : "s"} with results finish for all airfoils
                    </span>
                  )}
                </>
              )}
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.amber, lineHeight: 1.5 }}>{CLOSURE_SENTENCE}</span>
            </section>

            {/* ---- Removing ---- */}
            <section data-testid="plan-ack-removing" style={{ border: "1px solid rgba(245,101,101,0.45)", borderRadius: 10, padding: "10px 12px", display: "grid", gap: 5 }}>
              <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.redText }}>REMOVING</span>
              {diff.releasedConditions.length === 0 && diff.removedAngles.length === 0 && diff.cancelledPoints === 0 ? (
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.dim }}>nothing removed</span>
              ) : (
                <>
                  {diff.releasedConditions.length > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      {fCount(diff.releasedConditions.length)} condition{diff.releasedConditions.length === 1 ? "" : "s"} released (no results anywhere)
                    </span>
                  )}
                  {diff.removedAngles.length > 0 && (
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.text }}>
                      {fCount(diff.removedAngles.length)} angle{diff.removedAngles.length === 1 ? "" : "s"} removed: {diff.removedAngles.slice(0, 8).map(angleFmt).join(", ")}
                      {diff.removedAngles.length > 8 ? " …" : ""}
                    </span>
                  )}
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted }}>
                    {fCount(diff.cancelledPoints)} pending point{diff.cancelledPoints === 1 ? "" : "s"} cancelled · {fCount(diff.pendingResultDeletes)} pending queue row{diff.pendingResultDeletes === 1 ? "" : "s"} deleted
                  </span>
                </>
              )}
              {diff.runningOnRemoved > 0 && (
                <span data-testid="plan-ack-running-line" style={{ fontFamily: MONO, fontSize: 10, color: C.amber }}>
                  {fCount(diff.runningOnRemoved)} running job{diff.runningOnRemoved === 1 ? "" : "s"} on removed work will finish; evidence kept
                </span>
              )}
            </section>

            {needsConfirm && (
              <label style={{ display: "grid", gap: 5, fontFamily: MONO, fontSize: 10.5, color: C.amber }} data-admin-field="Confirm plan edit">
                This edit adds {fCount(diff.addedPoints)} points (more than {fCount(CAMPAIGN_CONFIRM_THRESHOLD)}). Type the campaign name to confirm:
                <input
                  data-testid="plan-ack-confirm-input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={summary.campaign.name}
                  style={inputStyle}
                />
              </label>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>Solved results are never deleted.</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                <button type="button" onClick={() => setStage("edit")} style={ghostBtn}>
                  back to edit
                </button>
                <button
                  type="button"
                  data-testid="plan-ack-apply"
                  disabled={busy || !confirmOk}
                  onClick={() => void apply()}
                  style={primaryBtn(busy || !confirmOk)}
                >
                  {busy ? "applying…" : `Apply — add ${fCount(diff.addedPoints)} points, cancel ${fCount(diff.cancelledPoints)} pending`}
                </button>
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
