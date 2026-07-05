"use client";

// Campaign wizard (spec §11, mockups rev 4): 4 steps — Airfoils · Conditions ·
// Angle plan · Review & launch. The parent owns the step (URL is the source of
// truth); drafts persist to sessionStorage keyed by draft id and restore on
// re-entry; duplicate prefills arrive via the `prefill` prop or the
// sessionStorage stash written by the hub's Duplicate action.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CategoryNode, MediumDTO } from "@aerodb/core";

import {
  type AdminAirfoilOption,
  type AdminSimulationSetup,
  type CampaignDuplicatePrefill,
  getAdminCategoryTree,
  getAdminMediums,
  getAdminSimulationSetup,
} from "@/lib/admin";
import { listAirfoils } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";
import { AirfoilScopeStep, type ResolvedScope } from "./AirfoilScopeStep";
import { AnglePlanStep } from "./AnglePlanStep";
import { ConditionsStep } from "./ConditionsStep";
import type { NumericsProfileKind, NumericsProfileRow } from "./NumericsQuickCreate";
import {
  buildPlanInput,
  CAMPAIGN_MAX_CONDITIONS,
  CAMPAIGN_MAX_VALUES_PER_AXIS,
  parseAngleListText,
  planCombos,
  pointArithmetic,
  sweepSetsOf,
  type WizardAnglePlan,
  type WizardEnvelope,
} from "./plan-model";
import { ReviewStep } from "./ReviewStep";
import {
  type CampaignWizardDraft,
  clearDraft,
  draftFromPrefill,
  emptyDraft,
  isDirty,
  loadLatestDraft,
  saveDraft,
  takeDuplicatePrefill,
} from "./wizard-draft";
import {
  card,
  compactIssues,
  ErrorLine,
  focusValidationIssue,
  ghostBtn,
  positiveIssue,
  positiveIntegerIssue,
  primaryBtn,
  requiredChoiceIssue,
  requiredIssue,
  type ValidationIssue,
} from "./ui";

const STEP_LABELS = ["Airfoils", "Conditions", "Angle plan", "Review & launch"];

export interface CampaignWizardProps {
  initialKind: "polar_sweep" | "ld_refine";
  prefill?: CampaignDuplicatePrefill | null;
  step: number;
  onStepChange: (n: number) => void;
  onLaunched: (id: string) => void;
  onExit: () => void;
  /** Reports the live dirty state so the shell can run its dirty-exit guard
   *  on nav-away / section clicks (spec §11). Reset to false on unmount. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function CampaignWizard({ initialKind, prefill, step, onStepChange, onLaunched, onExit, onDirtyChange }: CampaignWizardProps) {
  const [draft, setDraft] = useState<CampaignWizardDraft>(() => {
    const fromProp = prefill ? draftFromPrefill(prefill) : null;
    const fromStash = fromProp ? null : (() => {
      const stashed = takeDuplicatePrefill();
      return stashed ? draftFromPrefill(stashed) : null;
    })();
    // Re-entry restore: only pick the stored draft back up when it belongs to
    // the same wizard kind — "New max-L/D refinement" must not resurface an
    // abandoned polar-sweep draft (it stays stored under its own draft id).
    const latest = loadLatestDraft();
    const restored = latest && latest.kind === initialKind ? latest : null;
    return fromProp ?? fromStash ?? restored ?? emptyDraft(initialKind);
  });
  const baselineRef = useRef<CampaignWizardDraft>(draft);

  const [setup, setSetup] = useState<AdminSimulationSetup | null>(null);
  const [mediums, setMediums] = useState<MediumDTO[]>([]);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [airfoilQuery, setAirfoilQuery] = useState("");
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  // Category-subtree resolution (explicit id list; spec §11 step 1).
  const [categoryAirfoils, setCategoryAirfoils] = useState<{ categoryId: string; airfoils: AdminAirfoilOption[] } | null>(null);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const clampedStep = Math.min(4, Math.max(1, step));

  useEffect(() => {
    Promise.all([getAdminSimulationSetup(), getAdminMediums(), getAdminCategoryTree()])
      .then(([setupData, mediumsData, tree]) => {
        setSetup(setupData);
        setMediums(mediumsData.items);
        setCategories(tree);
        // Default the medium to the seeded air row (spec §11: an empty library
        // never blocks and defaults come from seeded records, never invented).
        setDraft((d) => {
          if (d.mediumId) return d;
          const seeded = mediumsData.items.filter((m) => m.isSeeded);
          const fallback = seeded.find((m) => m.slug === "air") ?? (seeded.length === 1 ? seeded[0] : null);
          return fallback ? { ...d, mediumId: fallback.id } : d;
        });
      })
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  // Persist the draft (sessionStorage, keyed by draft id) on every change.
  useEffect(() => {
    saveDraft({ ...draft, step: clampedStep });
  }, [draft, clampedStep]);

  const patchDraft = useCallback((patch: Partial<CampaignWizardDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  // Quick-created numerics profiles (Review step, spec §11) land in the shared
  // setup state so every slot select sees them immediately — same name-sorted
  // upsert convention as onMediumCreated below.
  const handleProfileCreated = useCallback((kind: NumericsProfileKind, row: NumericsProfileRow) => {
    const upsert = <T extends { id: string; name: string }>(rows: T[], created: T): T[] =>
      [...rows.filter((r) => r.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name));
    setSetup((s) => {
      if (!s) return s;
      if (kind === "boundary") return { ...s, boundaryProfiles: upsert(s.boundaryProfiles, row as (typeof s.boundaryProfiles)[number]) };
      if (kind === "mesh") return { ...s, meshProfiles: upsert(s.meshProfiles, row as (typeof s.meshProfiles)[number]) };
      if (kind === "solver") return { ...s, solverProfiles: upsert(s.solverProfiles, row as (typeof s.solverProfiles)[number]) };
      return { ...s, outputProfiles: upsert(s.outputProfiles, row as (typeof s.outputProfiles)[number]) };
    });
  }, []);

  // The sweep fields hold unconfirmed defaults until the user actually reaches
  // step 3 — only then may step 2 present point counts derived from them.
  useEffect(() => {
    if (clampedStep >= 3 && !draft.anglePlanTouched) patchDraft({ anglePlanTouched: true });
  }, [clampedStep, draft.anglePlanTouched, patchDraft]);

  // ---- scope resolution ----
  const optionsById = useMemo(() => new Map((setup?.airfoilOptions ?? []).map((o) => [o.id, o])), [setup]);

  useEffect(() => {
    if (draft.scopeMode !== "category" || !draft.categoryId || !setup) {
      setCategoryError(null);
      return;
    }
    const findNode = (nodes: CategoryNode[]): CategoryNode | null => {
      for (const node of nodes) {
        if (node.id === draft.categoryId) return node;
        const child = findNode(node.children ?? []);
        if (child) return child;
      }
      return null;
    };
    const node = findNode(categories);
    if (!node) return;
    let cancelled = false;
    setCategoryLoading(true);
    setCategoryError(null);
    listAirfoils({ category: node.slug, includeSubcategories: true })
      .then((rows) => {
        if (cancelled) return;
        // Symmetry flags come from the admin options payload (real geometric
        // property, spec §9.1); rows outside it (archived etc.) are dropped.
        const airfoils = rows
          .map((row) => optionsById.get(row.id))
          .filter((o): o is AdminAirfoilOption => !!o);
        setCategoryAirfoils({ categoryId: draft.categoryId!, airfoils });
      })
      .catch((e) => {
        if (!cancelled) setCategoryError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setCategoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.scopeMode, draft.categoryId, categories, setup, optionsById]);

  const resolvedScope: ResolvedScope = useMemo(() => {
    if (!setup) return { airfoils: [], loading: true, error: null };
    if (draft.scopeMode === "all") return { airfoils: setup.airfoilOptions, loading: false, error: null };
    if (draft.scopeMode === "manual") {
      return {
        airfoils: draft.manualAirfoilIds.map((id) => optionsById.get(id)).filter((o): o is AdminAirfoilOption => !!o),
        loading: false,
        error: null,
      };
    }
    if (!draft.categoryId) return { airfoils: [], loading: false, error: null };
    if (categoryError) return { airfoils: [], loading: false, error: categoryError };
    if (categoryAirfoils?.categoryId === draft.categoryId) return { airfoils: categoryAirfoils.airfoils, loading: categoryLoading, error: null };
    return { airfoils: [], loading: true, error: null };
  }, [setup, draft.scopeMode, draft.manualAirfoilIds, draft.categoryId, categoryAirfoils, categoryLoading, categoryError, optionsById]);

  const symmetricCount = resolvedScope.airfoils.filter((a) => a.isSymmetric).length;

  // ---- derived plan pieces ----
  const envelope: WizardEnvelope = useMemo(
    () => ({
      mediumId: draft.mediumId,
      ambients: draft.ambients,
      speedsMps: draft.speedsMps,
      chordsM: draft.chordsM,
      spanM: draft.spanM,
      areaMode: draft.areaMode,
      areaM2: draft.areaM2,
      excludedConditions: draft.excludedConditions,
    }),
    [draft.mediumId, draft.ambients, draft.speedsMps, draft.chordsM, draft.spanM, draft.areaMode, draft.areaM2, draft.excludedConditions],
  );

  const anglePlan: WizardAnglePlan = useMemo(
    () => ({
      sweepMode: draft.sweepMode,
      fromDeg: draft.sweepFromDeg,
      toDeg: draft.sweepToDeg,
      stepDeg: draft.sweepStepDeg,
      listText: draft.sweepListText,
      ldMax: draft.ldMax,
      clZero: draft.clZero,
    }),
    [draft.sweepMode, draft.sweepFromDeg, draft.sweepToDeg, draft.sweepStepDeg, draft.sweepListText, draft.ldMax, draft.clZero],
  );

  const sweep = useMemo(() => sweepSetsOf(anglePlan), [anglePlan]);
  const includedConditionCount = useMemo(
    () => planCombos(draft.ambients, draft.speedsMps, draft.chordsM, draft.excludedConditions).filter((c) => !c.excluded).length,
    [draft.ambients, draft.speedsMps, draft.chordsM, draft.excludedConditions],
  );

  const plan = useMemo(() => buildPlanInput(envelope, anglePlan, draft.numerics), [envelope, anglePlan, draft.numerics]);
  const medium = mediums.find((m) => m.id === draft.mediumId) ?? null;

  // ---- per-step validation ----
  const validateStep = useCallback(
    (n: number): ValidationIssue[] => {
      if (n === 1) {
        return compactIssues([
          resolvedScope.error ? { field: "Scope category", message: `scope failed to resolve: ${resolvedScope.error}` } : null,
          draft.scopeMode === "category" ? requiredChoiceIssue(draft.categoryId ?? "", "Scope category") : null,
          !resolvedScope.loading && resolvedScope.airfoils.length === 0
            ? { field: draft.scopeMode === "manual" ? "Scope airfoils" : "Scope category", message: "Resolve at least one airfoil" }
            : null,
          resolvedScope.airfoils.length > 5000 ? { field: "Scope airfoils", message: "At most 5,000 airfoils per campaign" } : null,
        ]);
      }
      if (n === 2) {
        return compactIssues([
          requiredChoiceIssue(draft.mediumId, "Medium"),
          draft.ambients.length === 0 ? { field: "Ambients", message: "Add at least one ambient (T, P)" } : null,
          draft.ambients.length > CAMPAIGN_MAX_VALUES_PER_AXIS ? { field: "Ambients", message: `At most ${CAMPAIGN_MAX_VALUES_PER_AXIS} ambients` } : null,
          draft.speedsMps.length === 0 ? { field: "Speeds", message: "Add at least one speed" } : null,
          draft.speedsMps.length > CAMPAIGN_MAX_VALUES_PER_AXIS ? { field: "Speeds", message: `At most ${CAMPAIGN_MAX_VALUES_PER_AXIS} speeds` } : null,
          draft.chordsM.length === 0 ? { field: "Chords", message: "Add at least one chord" } : null,
          draft.chordsM.length > CAMPAIGN_MAX_VALUES_PER_AXIS ? { field: "Chords", message: `At most ${CAMPAIGN_MAX_VALUES_PER_AXIS} chords` } : null,
          positiveIssue(Number(draft.spanM), "Span"),
          draft.areaMode === "explicit" && draft.chordsM.length > 1
            ? { field: "Reference area", message: "Explicit area is only allowed with a single chord" }
            : null,
          draft.areaMode === "explicit" && (draft.areaM2 == null || !(Number(draft.areaM2) > 0))
            ? { field: "Reference area m²", message: "Explicit area mode needs an area greater than 0" }
            : null,
          includedConditionCount === 0 && draft.ambients.length > 0 && draft.speedsMps.length > 0 && draft.chordsM.length > 0
            ? { field: "Ambients", message: "Every condition combination is excluded — nothing to run" }
            : null,
          includedConditionCount > CAMPAIGN_MAX_CONDITIONS
            ? { field: "Ambients", message: `Plan expands to ${includedConditionCount} conditions (max ${CAMPAIGN_MAX_CONDITIONS})` }
            : null,
        ]);
      }
      if (n === 3) {
        const listInvalid = draft.sweepMode === "list" && parseAngleListText(draft.sweepListText).invalidTokens.length > 0;
        return compactIssues([
          sweep.sets
            ? null
            : {
                field: draft.sweepMode === "list" ? "AoA list °" : "AoA step °",
                message: sweep.error ?? "base sweep is invalid",
              },
          listInvalid ? { field: "AoA list °", message: "Angle list contains non-numeric values" } : null,
          draft.ldMax.enabled ? positiveIssue(draft.ldMax.toleranceDeg, "Max L/D tolerance ±°") : null,
          draft.ldMax.enabled ? positiveIntegerIssue(draft.ldMax.maxRounds, "Max L/D rounds") : null,
          draft.ldMax.enabled && draft.ldMax.maxRounds > 50 ? { field: "Max L/D rounds", message: "Max L/D rounds must be 1..50" } : null,
          draft.clZero.enabled ? positiveIssue(draft.clZero.toleranceDeg, "Zero-lift tolerance ±°") : null,
          draft.clZero.enabled ? positiveIntegerIssue(draft.clZero.maxRounds, "Zero-lift rounds") : null,
          draft.clZero.enabled && draft.clZero.maxRounds > 50 ? { field: "Zero-lift rounds", message: "Zero-lift rounds must be 1..50" } : null,
          (draft.ldMax.enabled || draft.clZero.enabled) && sweep.sets && sweep.sets.angles.length < 3
            ? { field: draft.sweepMode === "list" ? "AoA list °" : "AoA step °", message: "Refinement objectives require a base sweep of at least 3 angles" }
            : null,
        ]);
      }
      // step 4
      const arithmetic = sweep.sets ? pointArithmetic(sweep.sets, resolvedScope.airfoils.length - symmetricCount, symmetricCount) : null;
      const totalPoints = arithmetic ? arithmetic.points * includedConditionCount : 0;
      return compactIssues([
        requiredIssue(draft.name, "Campaign name"),
        requiredChoiceIssue(draft.numerics.boundaryProfileId, "Boundary profile"),
        requiredChoiceIssue(draft.numerics.meshProfileId, "Mesh profile"),
        requiredChoiceIssue(draft.numerics.solverProfileId, "Solver profile"),
        requiredChoiceIssue(draft.numerics.outputProfileId, "Output profile"),
      ]);
    },
    [draft, resolvedScope, sweep, includedConditionCount, symmetricCount],
  );

  // Re-validate live once issues are showing (same UX as the setup panels).
  useEffect(() => {
    if (issues.length) setIssues(validateStep(clampedStep));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, resolvedScope.airfoils.length, clampedStep]);

  const goToStep = (n: number) => {
    if (n > clampedStep) {
      // validate every step between here and the target
      for (let s = clampedStep; s < n; s++) {
        const stepIssues = validateStep(s);
        if (stepIssues.length > 0) {
          if (s !== clampedStep) onStepChange(s);
          setIssues(stepIssues);
          focusValidationIssue(stepIssues[0]);
          return;
        }
      }
    }
    setIssues([]);
    onStepChange(n);
  };

  const validateForLaunch = useCallback((): ValidationIssue[] => {
    const all = [1, 2, 3, 4].flatMap((s) => validateStep(s));
    setIssues(all);
    if (all.length) focusValidationIssue(all[0]);
    return all;
  }, [validateStep]);

  const handleLaunched = (id: string) => {
    clearDraft(draft.draftId);
    onLaunched(id);
  };

  const dirty = isDirty(draft, baselineRef.current);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  if (loadError) {
    return (
      <div style={card}>
        <ErrorLine text={loadError} />
        <button type="button" onClick={onExit} style={ghostBtn}>
          back to campaigns
        </button>
      </div>
    );
  }

  if (!setup) {
    return <div style={{ fontFamily: MONO, fontSize: 13, color: C.muted, padding: 40 }}>loading wizard…</div>;
  }

  return (
    <div data-testid="campaign-wizard" style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          {draft.kind === "ld_refine" ? "New max-L/D refinement" : "New polar sweep"}
        </h2>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>{dirty ? "draft saved in this tab" : "draft"}</span>
        <button type="button" data-testid="wizard-exit" onClick={onExit} style={{ ...ghostBtn, marginLeft: "auto", padding: "6px 12px" }}>
          exit
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {STEP_LABELS.map((stepLabel, i) => {
          const n = i + 1;
          const on = n === clampedStep;
          const done = n < clampedStep;
          return (
            <button
              key={stepLabel}
              type="button"
              data-testid={`wizard-step-${n}`}
              aria-current={on ? "step" : undefined}
              onClick={() => goToStep(n)}
              style={{
                ...ghostBtn,
                padding: "7px 11px",
                fontSize: 11,
                color: on ? C.teal : done ? C.text : C.muted,
                borderColor: on ? C.tealBorder : C.stroke,
                background: on ? C.tealFill : C.panel3,
              }}
            >
              {n} · {stepLabel}
            </button>
          );
        })}
      </div>

      <div style={card}>
        {clampedStep === 1 && (
          <AirfoilScopeStep
            airfoilOptions={setup.airfoilOptions}
            categories={categories}
            scopeMode={draft.scopeMode}
            categoryId={draft.categoryId}
            manualAirfoilIds={draft.manualAirfoilIds}
            query={airfoilQuery}
            onQuery={setAirfoilQuery}
            onScopeMode={(scopeMode) => patchDraft({ scopeMode })}
            onCategoryId={(categoryId) => patchDraft({ categoryId })}
            onManualIds={(manualAirfoilIds) => patchDraft({ manualAirfoilIds })}
            resolved={resolvedScope}
            issues={issues}
          />
        )}
        {clampedStep === 2 && (
          <ConditionsStep
            mediums={mediums}
            setup={setup}
            envelope={envelope}
            onEnvelope={(patch) => patchDraft(patch)}
            onMediumCreated={(created) => setMediums((list) => [...list.filter((m) => m.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)))}
            angleSets={draft.anglePlanTouched ? sweep.sets : null}
            airfoilCount={resolvedScope.airfoils.length}
            symmetricCount={symmetricCount}
            issues={issues}
          />
        )}
        {clampedStep === 3 && (
          <AnglePlanStep
            angle={anglePlan}
            onAngle={(patch) => {
              const translated: Partial<CampaignWizardDraft> = {};
              if (patch.sweepMode !== undefined) translated.sweepMode = patch.sweepMode;
              if (patch.fromDeg !== undefined) translated.sweepFromDeg = patch.fromDeg;
              if (patch.toDeg !== undefined) translated.sweepToDeg = patch.toDeg;
              if (patch.stepDeg !== undefined) translated.sweepStepDeg = patch.stepDeg;
              if (patch.listText !== undefined) translated.sweepListText = patch.listText;
              if (patch.ldMax !== undefined) translated.ldMax = patch.ldMax;
              if (patch.clZero !== undefined) translated.clZero = patch.clZero;
              patchDraft(translated);
            }}
            resolvedAirfoils={resolvedScope.airfoils}
            conditionCount={includedConditionCount}
            issues={issues}
          />
        )}
        {clampedStep === 4 && (
          <ReviewStep
            name={draft.name}
            notes={draft.notes}
            priority={draft.priority}
            markStaleAndResolve={draft.markStaleAndResolve}
            onMeta={(patch) => patchDraft(patch)}
            numerics={draft.numerics}
            onNumerics={(patch) => patchDraft({ numerics: { ...draft.numerics, ...patch } })}
            plan={plan}
            resolvedAirfoils={resolvedScope.airfoils}
            medium={medium}
            conditionCount={includedConditionCount}
            angleSets={sweep.sets}
            setup={setup}
            onProfileCreated={handleProfileCreated}
            issues={issues}
            onValidate={validateForLaunch}
            onLaunched={handleLaunched}
          />
        )}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {clampedStep > 1 && (
          <button type="button" data-testid="wizard-back" onClick={() => goToStep(clampedStep - 1)} style={ghostBtn}>
            back
          </button>
        )}
        {clampedStep < 4 && (
          <button type="button" data-testid="wizard-continue" onClick={() => goToStep(clampedStep + 1)} style={{ ...primaryBtn(false), marginLeft: "auto" }}>
            continue · {STEP_LABELS[clampedStep]}
          </button>
        )}
      </div>
    </div>
  );
}
