// Wizard draft persistence (spec §11 routing contract): drafts live in
// sessionStorage keyed by draft id, restore on re-entry, and expose
// isDirty/serialize/restore so the integration layer can wire the actual
// dirty-exit navigation guard.

import type { CampaignDuplicatePrefill } from "@/lib/admin";

export type CampaignKind = "polar_sweep" | "ld_refine";

export interface WizardObjectiveDraft {
  enabled: boolean;
  toleranceDeg: number;
  maxRounds: number;
}

export interface CampaignWizardDraft {
  version: 1;
  draftId: string;
  savedAt: string;
  kind: CampaignKind;
  step: number;
  // review
  name: string;
  notes: string;
  priority: number;
  markStaleAndResolve: boolean;
  // step 1 — airfoil scope
  scopeMode: "all" | "category" | "manual";
  categoryId: string | null;
  manualAirfoilIds: string[];
  // step 2 — conditions envelope (canonical strings)
  mediumId: string;
  ambients: Array<[string, string]>;
  speedsMps: string[];
  chordsM: string[];
  spanM: string;
  areaMode: "derived" | "explicit";
  areaM2: string | null;
  excludedConditions: Array<[string, string, string, string]>;
  // step 3 — angle plan. anglePlanTouched flips once the user has actually
  // reached step 3 (or arrived via a duplicate prefill): before that the sweep
  // fields are unconfirmed defaults, and step 2 must not present point counts
  // derived from an angle plan the user never saw.
  anglePlanTouched: boolean;
  sweepMode: "range" | "list";
  sweepFromDeg: number;
  sweepToDeg: number;
  sweepStepDeg: number;
  sweepListText: string;
  ldMax: WizardObjectiveDraft;
  clZero: WizardObjectiveDraft;
  // step 4 — numerics ("" = unresolved, surfaces as a validation issue)
  numerics: { boundaryProfileId: string; meshProfileId: string; solverProfileId: string; outputProfileId: string };
}

const DRAFT_KEY_PREFIX = "aerodb.campaign-wizard.draft.";
const LATEST_KEY = "aerodb.campaign-wizard.latest-draft-id";
const PREFILL_KEY = "aerodb.campaign-wizard.duplicate-prefill";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function newDraftId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function emptyDraft(kind: CampaignKind): CampaignWizardDraft {
  return {
    version: 1,
    draftId: newDraftId(),
    savedAt: new Date().toISOString(),
    kind,
    step: 1,
    name: "",
    notes: "",
    priority: 5,
    markStaleAndResolve: false,
    scopeMode: "all",
    categoryId: null,
    manualAirfoilIds: [],
    mediumId: "",
    ambients: [],
    speedsMps: [],
    chordsM: [],
    spanM: "1.0000",
    areaMode: "derived",
    areaM2: null,
    excludedConditions: [],
    anglePlanTouched: false,
    sweepMode: "range",
    sweepFromDeg: -10,
    sweepToDeg: 20,
    sweepStepDeg: 1,
    sweepListText: "",
    // "ld_refine" is the same wizard with the max-L/D objective pre-enabled
    // (spec §11 hub CTAs); tolerance/rounds defaults follow spec §3.1.
    ldMax: { enabled: kind === "ld_refine", toleranceDeg: 0.1, maxRounds: 8 },
    clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 6 },
    numerics: { boundaryProfileId: "", meshProfileId: "", solverProfileId: "", outputProfileId: "" },
  };
}

export function draftFromPrefill(prefill: CampaignDuplicatePrefill): CampaignWizardDraft {
  const plan = prefill.plan;
  const kind: CampaignKind = plan.objectives.ldMax.enabled ? "ld_refine" : "polar_sweep";
  const base = emptyDraft(kind);
  return {
    ...base,
    name: prefill.name,
    notes: prefill.notes ?? "",
    priority: prefill.priority,
    scopeMode: "manual",
    manualAirfoilIds: prefill.airfoilIds,
    mediumId: plan.mediumId,
    ambients: plan.ambients,
    speedsMps: plan.speedsMps,
    chordsM: plan.chordsM,
    spanM: plan.spanM,
    areaMode: plan.areaMode,
    areaM2: plan.areaM2,
    excludedConditions: plan.excludedConditions,
    anglePlanTouched: true,
    sweepMode: plan.baseSweep.listDeg != null ? "list" : "range",
    sweepFromDeg: plan.baseSweep.fromDeg != null ? Number(plan.baseSweep.fromDeg) : base.sweepFromDeg,
    sweepToDeg: plan.baseSweep.toDeg != null ? Number(plan.baseSweep.toDeg) : base.sweepToDeg,
    sweepStepDeg: plan.baseSweep.stepDeg != null ? Number(plan.baseSweep.stepDeg) : base.sweepStepDeg,
    sweepListText: plan.baseSweep.listDeg?.map((a) => String(Number(a))).join(", ") ?? "",
    ldMax: { enabled: plan.objectives.ldMax.enabled, toleranceDeg: Number(plan.objectives.ldMax.toleranceDeg), maxRounds: plan.objectives.ldMax.maxRounds },
    clZero: { enabled: plan.objectives.clZero.enabled, toleranceDeg: Number(plan.objectives.clZero.toleranceDeg), maxRounds: plan.objectives.clZero.maxRounds },
    numerics: { ...plan.numerics },
  };
}

export function serializeDraft(draft: CampaignWizardDraft): string {
  return JSON.stringify(draft);
}

export function restoreDraft(serialized: string): CampaignWizardDraft | null {
  try {
    const parsed = JSON.parse(serialized) as CampaignWizardDraft;
    if (parsed?.version !== 1 || typeof parsed.draftId !== "string") return null;
    return { ...parsed, anglePlanTouched: Boolean(parsed.anglePlanTouched) };
  } catch {
    return null;
  }
}

export function saveDraft(draft: CampaignWizardDraft): void {
  const s = storage();
  if (!s) return;
  const stamped = { ...draft, savedAt: new Date().toISOString() };
  try {
    s.setItem(DRAFT_KEY_PREFIX + draft.draftId, serializeDraft(stamped));
    s.setItem(LATEST_KEY, draft.draftId);
  } catch {
    // storage full/unavailable — the wizard keeps working from memory
  }
}

export function loadDraft(draftId: string): CampaignWizardDraft | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(DRAFT_KEY_PREFIX + draftId);
  return raw ? restoreDraft(raw) : null;
}

export function loadLatestDraft(): CampaignWizardDraft | null {
  const s = storage();
  if (!s) return null;
  const latest = s.getItem(LATEST_KEY);
  return latest ? loadDraft(latest) : null;
}

export function clearDraft(draftId: string): void {
  const s = storage();
  if (!s) return;
  s.removeItem(DRAFT_KEY_PREFIX + draftId);
  if (s.getItem(LATEST_KEY) === draftId) s.removeItem(LATEST_KEY);
}

/** Dirty = any user-visible field differs from the baseline snapshot
 *  (savedAt/step excluded — navigation alone is not dirty). */
export function isDirty(draft: CampaignWizardDraft, baseline: CampaignWizardDraft): boolean {
  const strip = ({ savedAt: _s, step: _st, ...rest }: CampaignWizardDraft) => rest;
  return JSON.stringify(strip(draft)) !== JSON.stringify(strip(baseline));
}

// ---------------------------------------------------------------------------
// Duplicate → wizard hand-off. The hub only has onNewCampaign(kind); the
// prefill payload travels through sessionStorage and is consumed exactly once
// by the next wizard mount (the wizard's `prefill` prop wins when provided).
// ---------------------------------------------------------------------------
export function stashDuplicatePrefill(prefill: CampaignDuplicatePrefill): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PREFILL_KEY, JSON.stringify(prefill));
  } catch {
    // ignore — duplicate falls back to a blank wizard
  }
}

export function takeDuplicatePrefill(): CampaignDuplicatePrefill | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(PREFILL_KEY);
  if (!raw) return null;
  s.removeItem(PREFILL_KEY);
  try {
    return JSON.parse(raw) as CampaignDuplicatePrefill;
  } catch {
    return null;
  }
}
