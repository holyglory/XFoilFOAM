"use client";

// Wizard step 4 (spec §11): review & launch. Real dry-run reuse preview with
// visible computing/degrade states (§5.4 copy verbatim), numerics
// current-value chips expanding to the four profile selects with an inline
// "+ new profile" quick-create per slot (save-as-new modal — no dead ends;
// defaults resolve from REAL rows only via resolveNumericsDefault: a single
// existing row of any origin, else exactly one seeded row; an unresolved slot
// is a validation issue, never an invented default), honest priority copy,
// live queue context, >10k type-to-confirm, and an idempotent Launch.

import { useEffect, useMemo, useRef, useState } from "react";

import type { MediumDTO } from "@aerodb/core";

import {
  type AdminAirfoilOption,
  type AdminQueue,
  type AdminSimulationSetup,
  type AdminSolverProfile,
  type CampaignPlanInput,
  type CampaignReusePreview,
  getAdminQueue,
  launchCampaign,
  patchSweeper,
  previewCampaign,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { PROCESS_NOT_RUNNING_DETAIL, isProcessDead } from "@/lib/solver-state";
import {
  NumericsQuickCreate,
  type NumericsProfileKind,
  type NumericsProfileRow,
} from "./NumericsQuickCreate";
import { resolveNumericsDefault } from "./numerics-resolution";
import { reviewQueueOperationalState } from "./campaign-status";
import {
  formatUransMeshDisclosureValue,
  formatUransMeshReviewSummary,
} from "./urans-mesh-selection";
import { usePoll } from "./usePoll";
import {
  type AngleSets,
  CAMPAIGN_CONFIRM_THRESHOLD,
  pointArithmetic,
} from "./plan-model";
import {
  ErrorLine,
  fCount,
  ghostBtn,
  InfoLine,
  inputStyle,
  issueFor,
  label as labelStyle,
  MetricChip,
  primaryBtn,
  SelectField,
  TextField,
  type ValidationIssue,
  ValidationSummary,
} from "./ui";

const PRIORITY_OPTIONS = [
  {
    value: "0",
    label:
      "Background (0) — interleaves with continuous gap-fill in Re/airfoil/angle order",
  },
  { value: "5", label: "Standard (5) — runs before continuous gap-fill" },
  {
    value: "8",
    label: "High (8) — runs before Standard campaigns and can starve them",
  },
];

type NumericsSlot =
  | "boundaryProfileId"
  | "meshProfileId"
  | "solverProfileId"
  | "outputProfileId";

const NUMERICS_SLOTS: Array<{
  slot: NumericsSlot;
  label: string;
  field: string;
  kind: NumericsProfileKind;
  rows: keyof Pick<
    AdminSimulationSetup,
    "boundaryProfiles" | "meshProfiles" | "solverProfiles" | "outputProfiles"
  >;
}> = [
  {
    slot: "boundaryProfileId",
    label: "Boundary",
    field: "Boundary profile",
    kind: "boundary",
    rows: "boundaryProfiles",
  },
  {
    slot: "meshProfileId",
    label: "Mesh",
    field: "Mesh profile",
    kind: "mesh",
    rows: "meshProfiles",
  },
  {
    slot: "solverProfileId",
    label: "Solver",
    field: "Solver profile",
    kind: "solver",
    rows: "solverProfiles",
  },
  {
    slot: "outputProfileId",
    label: "Output",
    field: "Output profile",
    kind: "output",
    rows: "outputProfiles",
  },
];

function numericsProfileLabel(
  kind: NumericsProfileKind,
  row: NumericsProfileRow,
) {
  const seeded = row.isSeeded ? " · seeded" : "";
  if (kind !== "solver") return `${row.name}${seeded}`;
  const solver = row as AdminSolverProfile;
  const implementation = solver.implementation;
  if (!implementation) return `${row.name} · engine unavailable${seeded}`;
  const family =
    implementation.family.toLowerCase() === "openfoam"
      ? "OpenFOAM"
      : implementation.family;
  const distribution =
    implementation.distribution.toLowerCase() === "opencfd"
      ? "OpenCFD"
      : implementation.distribution.toLowerCase() === "foundation"
        ? "Foundation"
        : implementation.distribution;
  return `${row.name} · ${family} ${distribution} ${implementation.releaseVersion}${seeded}`;
}

export interface ReviewStepProps {
  name: string;
  notes: string;
  priority: number;
  markStaleAndResolve: boolean;
  onMeta: (
    patch: Partial<{
      name: string;
      notes: string;
      priority: number;
      markStaleAndResolve: boolean;
    }>,
  ) => void;
  numerics: CampaignPlanInput["numerics"];
  onNumerics: (patch: Partial<CampaignPlanInput["numerics"]>) => void;
  plan: CampaignPlanInput;
  resolvedAirfoils: AdminAirfoilOption[];
  medium: MediumDTO | null;
  conditionCount: number;
  angleSets: AngleSets | null;
  setup: AdminSimulationSetup;
  /** Quick-created profile rows bubble up so the wizard's setup state (and
   *  therefore every slot select) includes them immediately. */
  onProfileCreated: (
    kind: NumericsProfileKind,
    row: NumericsProfileRow,
  ) => void;
  issues: ValidationIssue[];
  onValidate: () => ValidationIssue[];
  onLaunched: (id: string) => void;
}

export function ReviewStep({
  name,
  notes,
  priority,
  markStaleAndResolve,
  onMeta,
  numerics,
  onNumerics,
  plan,
  resolvedAirfoils,
  medium,
  conditionCount,
  angleSets,
  setup,
  onProfileCreated,
  issues,
  onValidate,
  onLaunched,
}: ReviewStepProps) {
  // Idempotency key minted once per Review mount (spec §5.2).
  const [idempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [preview, setPreview] = useState<CampaignReusePreview | null>(null);
  const [previewState, setPreviewState] = useState<
    "idle" | "computing" | "done" | "failed"
  >("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [queue, setQueue] = useState<AdminQueue | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [expandedSlot, setExpandedSlot] = useState<NumericsSlot | null>(null);
  const [uransMeshesExpanded, setUransMeshesExpanded] = useState(false);
  const [creatingSlot, setCreatingSlot] = useState<NumericsSlot | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [enablingSweeper, setEnablingSweeper] = useState(false);
  const [sweeperError, setSweeperError] = useState<string | null>(null);
  const launchedRef = useRef(false);

  // Corrective control lives with the warning (never a trip to the Queue page
  // mid-journey): enable the sweeper in place, then refetch the real state.
  const enableSweeper = async () => {
    setEnablingSweeper(true);
    setSweeperError(null);
    try {
      await patchSweeper({ enabled: true });
      setQueue(await getAdminQueue("activity"));
    } catch (e) {
      setSweeperError((e as Error).message);
    } finally {
      setEnablingSweeper(false);
    }
  };

  const symmetricCount = resolvedAirfoils.filter((a) => a.isSymmetric).length;
  const arithmetic = angleSets
    ? pointArithmetic(
        angleSets,
        resolvedAirfoils.length - symmetricCount,
        symmetricCount,
      )
    : null;
  const totalPoints = arithmetic ? arithmetic.points * conditionCount : 0;
  const totalSolverRuns = arithmetic
    ? arithmetic.solverRuns * conditionCount
    : 0;
  const totalDerived = arithmetic
    ? arithmetic.derivedPoints * conditionCount
    : 0;

  const planReady =
    resolvedAirfoils.length > 0 &&
    plan.mediumId !== "" &&
    plan.ambients.length > 0 &&
    plan.speedsMps.length > 0 &&
    plan.chordsM.length > 0 &&
    angleSets != null;

  // Numerics defaults from REAL rows only (spec §11/§12, DecisionHistory
  // 2026-07-05): a slot resolves automatically when exactly one profile row
  // exists (any origin — the only possible choice) or, with multiple rows,
  // when exactly one seeded row exists. Anything else stays unresolved,
  // surfaces as a validation issue, and offers the inline quick-create.
  useEffect(() => {
    const patch: Partial<CampaignPlanInput["numerics"]> = {};
    for (const def of NUMERICS_SLOTS) {
      if (numerics[def.slot]) continue;
      const resolved = resolveNumericsDefault(setup[def.rows]);
      if (resolved) patch[def.slot] = resolved;
    }
    if (Object.keys(patch).length > 0) onNumerics(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup]);

  // Reuse preview (spec §5.4): read-only dry run keyed on the actual payload.
  const previewPayloadKey = useMemo(
    () =>
      JSON.stringify({
        plan,
        airfoilIds: resolvedAirfoils.map((a) => a.id).sort(),
      }),
    [plan, resolvedAirfoils],
  );
  useEffect(() => {
    if (
      !planReady ||
      !numerics.boundaryProfileId ||
      !numerics.meshProfileId ||
      !numerics.solverProfileId ||
      !numerics.outputProfileId
    ) {
      setPreview(null);
      setPreviewState("idle");
      return;
    }
    let cancelled = false;
    setPreviewState("computing");
    setPreviewError(null);
    previewCampaign({ plan, airfoilIds: resolvedAirfoils.map((a) => a.id) })
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setPreviewState("done");
      })
      .catch((e) => {
        if (cancelled) return;
        setPreview(null);
        setPreviewState("failed");
        setPreviewError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewPayloadKey, planReady]);

  // Queue context poll (10 s, hidden-tab aware). The review context needs
  // backlog counters + sweeper + engine reachability only — the cheap
  // activity scope, never the full gap-scan payload (spec §10/§12).
  usePoll(async () => {
    try {
      setQueue(await getAdminQueue("activity"));
      setQueueError(null);
    } catch (e) {
      setQueueError((e as Error).message);
    }
  }, 10_000);

  const needsConfirm = totalPoints > CAMPAIGN_CONFIRM_THRESHOLD;
  const confirmOk =
    !needsConfirm ||
    (name.trim().length > 0 && confirmText.trim() === name.trim());
  const allSolved = preview?.status === "ok" && preview.allSolved;
  const queueOperationalState = queue
    ? reviewQueueOperationalState({
        processDead: isProcessDead(queue.sweeper.heartbeatAt),
        admissionFenceActive: queue.sweeper.admissionFenceActive ?? false,
        sweeperEnabled: queue.sweeper.enabled,
        engineUnreachableSince: queue.engineUnreachableSince,
      })
    : null;

  const launch = async () => {
    if (launchedRef.current) return;
    const nextIssues = onValidate();
    if (nextIssues.length > 0) return;
    if (!confirmOk) return;
    launchedRef.current = true; // launch button disables on first click (§5.2)
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await launchCampaign({
        name: name.trim(),
        notes: notes.trim() || null,
        priority,
        idempotencyKey,
        airfoilIds: resolvedAirfoils.map((a) => a.id),
        plan,
        markStaleAndResolve: allSolved ? markStaleAndResolve : false,
      });
      onLaunched(result.campaign.id);
    } catch (e) {
      launchedRef.current = false;
      setLaunching(false);
      setLaunchError((e as Error).message);
    }
  };

  const envelopeSummary = `${plan.ambients.length} ambient${plan.ambients.length === 1 ? "" : "s"} × ${plan.speedsMps.length} speed${plan.speedsMps.length === 1 ? "" : "s"} × ${plan.chordsM.length} chord${plan.chordsM.length === 1 ? "" : "s"}${plan.excludedConditions.length ? ` − ${plan.excludedConditions.length} excluded` : ""}`;

  const objectiveSummary =
    [
      plan.objectives.ldMax.enabled
        ? `max L/D ±${plan.objectives.ldMax.toleranceDeg}° · ≤${plan.objectives.ldMax.maxRounds} rounds`
        : null,
      plan.objectives.clZero.enabled
        ? `zero lift ±${plan.objectives.clZero.toleranceDeg}° · ≤${plan.objectives.clZero.maxRounds} rounds`
        : null,
      plan.objectives.clMax?.enabled
        ? `Cl_max ±${plan.objectives.clMax.toleranceDeg}° · ≤${plan.objectives.clMax.maxRounds} rounds`
        : null,
    ]
      .filter(Boolean)
      .join(" · ") || "none";

  const summaryRows: Array<[string, string]> = [
    [
      "Airfoils",
      `${fCount(resolvedAirfoils.length)}${symmetricCount ? ` (${fCount(symmetricCount)} symmetric)` : ""}`,
    ],
    ["Medium", medium?.name ?? "—"],
    ["Conditions", `${fCount(conditionCount)} · ${envelopeSummary}`],
    [
      "Angles",
      angleSets
        ? `${fCount(angleSets.angles.length)} · ${angleSets.angles[0]}° … ${angleSets.angles[angleSets.angles.length - 1]}°`
        : "—",
    ],
    ["Objectives", objectiveSummary],
    ["Points", fCount(totalPoints)],
    [
      "Solver runs",
      `${fCount(totalSolverRuns)}${totalDerived ? ` — ${fCount(symmetricCount)} symmetric airfoils solve positive angles only; ${fCount(totalDerived)} points derived by symmetry` : ""}`,
    ],
    [
      "Span / area",
      `${Number(plan.spanM)} m span · ${plan.areaMode === "explicit" && plan.areaM2 ? `${Number(plan.areaM2)} m² explicit` : "area derived per condition"}`,
    ],
    [
      "URANS meshes",
      formatUransMeshReviewSummary(plan.numerics, setup.meshProfiles),
    ],
    [
      "Priority",
      PRIORITY_OPTIONS.find((o) => o.value === String(priority))?.label ??
        String(priority),
    ],
  ];

  return (
    <div data-testid="wizard-review" style={{ display: "grid", gap: 12 }}>
      <div style={labelStyle}>4 · REVIEW &amp; LAUNCH</div>

      <TextField
        label="Campaign name"
        value={name}
        error={issueFor(issues, "Campaign name")}
        onChange={(v) => onMeta({ name: v })}
      />
      <TextField
        label="Notes optional"
        value={notes}
        onChange={(v) => onMeta({ notes: v })}
      />

      <div
        data-testid="review-summary-table"
        style={{
          border: `1px solid ${C.stroke}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {summaryRows.map(([k, v]) => (
          <div
            key={k}
            style={{
              display: "grid",
              gridTemplateColumns: "128px minmax(0, 1fr)",
              gap: 10,
              padding: "7px 10px",
              borderBottom: `1px solid ${C.borderRow}`,
              fontFamily: MONO,
              fontSize: 11,
            }}
          >
            <span style={{ color: C.dim }}>{k}</span>
            <span style={{ color: C.text, overflowWrap: "anywhere" }}>{v}</span>
          </div>
        ))}
      </div>

      <div
        data-testid="review-reuse-preview"
        style={{
          border: `1px solid ${C.stroke2}`,
          borderRadius: 8,
          padding: "9px 11px",
          display: "grid",
          gap: 6,
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            color: C.dim,
          }}
        >
          REUSE PREVIEW
        </div>
        {!planReady || previewState === "idle" ? (
          <InfoLine text="Complete the earlier steps (and pick the numerics profiles below) to compute the reuse preview." />
        ) : previewState === "computing" ? (
          <InfoLine text="computing reuse preview…" />
        ) : previewState === "failed" ? (
          <InfoLine
            tone="amber"
            text={`Reuse preview failed: ${previewError} — launching is still safe: already-solved points are never re-run.`}
          />
        ) : preview?.status === "timeout" ? (
          <InfoLine
            tone="amber"
            text="Couldn't compute the reuse preview in time — launching is still safe: already-solved points are never re-run."
          />
        ) : preview?.status === "ok" ? (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>
              {fCount(preview.reusedPoints)} of {fCount(preview.totalPoints)}{" "}
              points already solved — they will not re-run ·{" "}
              {fCount(preview.totalSolverRuns)} solver runs planned
            </span>
            {allSolved && (
              <div style={{ display: "grid", gap: 6 }}>
                <InfoLine
                  tone="teal"
                  text={`all ${fCount(preview.totalPoints)} points already solved — nothing will run`}
                />
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    fontFamily: MONO,
                    fontSize: 11,
                    color: C.text,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    data-testid="review-mark-stale"
                    checked={markStaleAndResolve}
                    onChange={(e) =>
                      onMeta({ markStaleAndResolve: e.target.checked })
                    }
                  />
                  mark reused points stale &amp; re-solve
                </label>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            color: C.dim,
          }}
        >
          NUMERICS
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 8,
          }}
        >
          {NUMERICS_SLOTS.map((def) => {
            const rows = setup[def.rows];
            const current = rows.find((row) => row.id === numerics[def.slot]);
            const unresolved = !numerics[def.slot];
            return (
              <button
                key={def.slot}
                type="button"
                data-testid={`numerics-chip-${def.slot}`}
                data-admin-field={def.field}
                aria-expanded={expandedSlot === def.slot}
                onClick={() =>
                  setExpandedSlot((s) => (s === def.slot ? null : def.slot))
                }
                style={{
                  display: "grid",
                  gap: 2,
                  textAlign: "left",
                  fontFamily: MONO,
                  fontSize: 10,
                  background: C.panel3,
                  border: `1px solid ${unresolved ? C.red : expandedSlot === def.slot ? C.tealBorder : C.borderSoft}`,
                  borderRadius: 6,
                  padding: "6px 7px",
                  cursor: "pointer",
                }}
              >
                <span style={{ color: C.dimmest }}>{def.label}</span>
                <span
                  style={{
                    color: unresolved ? C.red : C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {current
                    ? numericsProfileLabel(
                        def.kind,
                        current as NumericsProfileRow,
                      )
                    : "unresolved — choose"}
                </span>
              </button>
            );
          })}
        </div>
        {expandedSlot &&
          (() => {
            const def = NUMERICS_SLOTS.find((d) => d.slot === expandedSlot)!;
            const rows = setup[def.rows];
            const error = issueFor(issues, def.field);
            // Zero rows: the select would only hold one dead option — the
            // quick-create is the ONLY path and renders prominently instead.
            if (rows.length === 0) {
              return (
                <div style={{ display: "grid", gap: 6 }}>
                  <InfoLine
                    tone="amber"
                    text={`No ${def.label.toLowerCase()} profiles exist yet — create the first one to resolve this slot.`}
                  />
                  {error && <InfoLine tone="red" text={error} />}
                  <button
                    type="button"
                    data-testid={`numerics-new-${def.slot}`}
                    onClick={() => setCreatingSlot(def.slot)}
                    style={{ ...primaryBtn(false), width: "100%" }}
                  >
                    + new {def.label.toLowerCase()} profile
                  </button>
                </div>
              );
            }
            return (
              <div style={{ display: "flex", alignItems: "end", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <SelectField
                    label={def.field}
                    value={numerics[def.slot]}
                    options={["", ...rows.map((row) => row.id)]}
                    optionLabels={Object.fromEntries([
                      ["", "choose profile"],
                      ...rows.map((row) => [
                        row.id,
                        numericsProfileLabel(
                          def.kind,
                          row as NumericsProfileRow,
                        ),
                      ]),
                    ])}
                    error={error}
                    onChange={(id) => onNumerics({ [def.slot]: id })}
                  />
                </div>
                <button
                  type="button"
                  data-testid={`numerics-new-${def.slot}`}
                  onClick={() => setCreatingSlot(def.slot)}
                  style={{
                    ...ghostBtn,
                    padding: "9px 11px",
                    fontSize: 11,
                    color: C.teal,
                    whiteSpace: "nowrap",
                  }}
                >
                  + new profile
                </button>
              </div>
            );
          })()}
        {creatingSlot &&
          (() => {
            const def = NUMERICS_SLOTS.find((d) => d.slot === creatingSlot)!;
            return (
              <NumericsQuickCreate
                kind={def.kind}
                setup={setup}
                currentId={numerics[def.slot]}
                onClose={() => setCreatingSlot(null)}
                onCreated={(kind, row) => {
                  onProfileCreated(kind, row);
                  onNumerics({ [def.slot]: row.id });
                  setCreatingSlot(null);
                }}
              />
            );
          })()}
        <div
          style={{
            border: `1px solid ${C.borderSoft}`,
            borderRadius: 6,
            padding: "7px 8px",
            display: "grid",
            gap: 7,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.dimmest }}>
              URANS meshes
            </span>
            <span
              data-testid="urans-meshes-summary"
              style={{
                flex: "1 1 180px",
                minWidth: 0,
                fontFamily: MONO,
                fontSize: 10,
                color: C.text,
                background: C.panel3,
                border: `1px solid ${C.borderSoft}`,
                borderRadius: 6,
                padding: "5px 7px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {formatUransMeshDisclosureValue(numerics, setup.meshProfiles)}
            </span>
            <button
              type="button"
              data-testid="urans-meshes-customize"
              aria-expanded={uransMeshesExpanded}
              onClick={() => setUransMeshesExpanded((open) => !open)}
              style={{
                ...ghostBtn,
                padding: "5px 9px",
                fontSize: 10,
                color: C.teal,
                whiteSpace: "nowrap",
              }}
            >
              {uransMeshesExpanded ? "hide" : "Customize"}
            </button>
          </div>
          {uransMeshesExpanded && (
            <div
              data-testid="urans-meshes-editor"
              style={{ display: "grid", gap: 7 }}
            >
              <InfoLine text="Derived: full URANS uses full-resolution wall-function y+~40; precalc uses half-resolution wall-function." />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                  gap: 8,
                }}
              >
                <SelectField
                  label="Full URANS mesh"
                  value={numerics.uransMeshProfileId ?? ""}
                  options={["", ...setup.meshProfiles.map((row) => row.id)]}
                  optionLabels={Object.fromEntries([
                    ["", "Derived — wall-function from RANS mesh (default)"],
                    ...setup.meshProfiles.map((row) => [
                      row.id,
                      `${row.name}${row.isSeeded ? " · seeded" : ""}`,
                    ]),
                  ])}
                  onChange={(id) =>
                    onNumerics({ uransMeshProfileId: id || null })
                  }
                />
                <SelectField
                  label="Precalc URANS mesh"
                  value={numerics.uransPrecalcMeshProfileId ?? ""}
                  options={["", ...setup.meshProfiles.map((row) => row.id)]}
                  optionLabels={Object.fromEntries([
                    ["", "Derived — half-resolution wall-function (default)"],
                    ...setup.meshProfiles.map((row) => [
                      row.id,
                      `${row.name}${row.isSeeded ? " · seeded" : ""}`,
                    ]),
                  ])}
                  onChange={(id) =>
                    onNumerics({ uransPrecalcMeshProfileId: id || null })
                  }
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <SelectField
        label="Priority"
        value={String(priority)}
        options={PRIORITY_OPTIONS.map((o) => o.value)}
        optionLabels={Object.fromEntries(
          PRIORITY_OPTIONS.map((o) => [o.value, o.label]),
        )}
        onChange={(v) => onMeta({ priority: Number(v) })}
      />
      <div
        style={{
          fontFamily: MONO,
          fontSize: 10.5,
          color: C.dim,
          lineHeight: 1.5,
        }}
      >
        Campaigns above Background pause continuous preset gap-fill until their
        points are exhausted. On-demand public simulation requests (priority 10)
        always run first.
      </div>

      <div
        data-testid="review-queue-context"
        style={{ display: "grid", gap: 6 }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            color: C.dim,
          }}
        >
          QUEUE CONTEXT
        </div>
        {queueError ? (
          <InfoLine tone="amber" text={`queue unavailable: ${queueError}`} />
        ) : !queue ? (
          <InfoLine text="loading queue…" />
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                gap: 8,
              }}
            >
              {/* backlog counters may be null before the first gap scan completes — shown as "—", never invented */}
              <MetricChip
                label="Pending points"
                value={queue.backlog == null ? "—" : fCount(queue.backlog)}
              />
              <MetricChip
                label="Jobs in flight"
                value={queue.inFlight == null ? "—" : fCount(queue.inFlight)}
              />
              <MetricChip
                label="Campaign backlog"
                value={
                  queue.backlogStrip == null
                    ? "—"
                    : fCount(
                        queue.backlogStrip.campaigns.reduce(
                          (n, c) => n + c.remainingPoints,
                          0,
                        ),
                      )
                }
              />
              <MetricChip
                label="Sweeper"
                value={
                  queueOperationalState === "process_not_running"
                    ? "process not running"
                    : queueOperationalState === "safety_stop"
                      ? "safety stop"
                      : queueOperationalState === "engine_unreachable"
                        ? "engine unreachable"
                        : queueOperationalState === "sweeper_disabled"
                          ? "disabled"
                          : "enabled"
                }
              />
            </div>
            {/* No measured solve rate in the queue payload — the rate line is omitted rather than invented (spec §12). */}
            {queueOperationalState === "process_not_running" ? (
              // "enable sweeper now" would be a fake control while the solver
              // process is down — guidance text renders instead (same copy as
              // the Solver banner, via lib/solver-state).
              <div
                data-testid="review-solver-guidance"
                style={{ display: "grid", gap: 4 }}
              >
                <InfoLine
                  tone="red"
                  text="Solver process is not running — nothing will be scheduled until it is started."
                />
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                  {PROCESS_NOT_RUNNING_DETAIL}
                </span>
              </div>
            ) : queueOperationalState === "safety_stop" ? (
              <InfoLine
                tone="red"
                text="Solver safety stop — critical outcome; new submissions are fenced while running jobs continue."
              />
            ) : queueOperationalState === "engine_unreachable" ? (
              <InfoLine
                tone="red"
                text={
                  queue.engineUnreachableSince
                    ? `Engine unreachable since ${new Date(queue.engineUnreachableSince).toLocaleTimeString()} — no jobs are being submitted.`
                    : "Engine unreachable — no jobs are being submitted."
                }
              />
            ) : queueOperationalState === "sweeper_disabled" ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <InfoLine
                  tone="amber"
                  text="Sweeper is disabled — nothing will be scheduled until it is enabled."
                />
                <button
                  type="button"
                  data-testid="review-enable-sweeper"
                  disabled={enablingSweeper}
                  onClick={enableSweeper}
                  style={{
                    ...ghostBtn,
                    color: C.amber,
                    borderColor: "rgba(245,165,36,.45)",
                    padding: "4px 10px",
                    fontSize: 10.5,
                  }}
                >
                  {enablingSweeper ? "enabling…" : "enable sweeper now"}
                </button>
              </div>
            ) : null}
            {sweeperError && <ErrorLine text={sweeperError} />}
          </div>
        )}
      </div>

      {needsConfirm && (
        <label
          style={{ display: "block" }}
          data-admin-field="Launch confirmation"
        >
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: C.amber,
              margin: "8px 0 4px",
            }}
          >
            {fCount(totalPoints)} points — type the campaign name to confirm the
            launch
          </div>
          <input
            aria-label="Launch confirmation"
            data-testid="review-confirm-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={name.trim() || "campaign name"}
            style={{
              ...inputStyle,
              borderColor: confirmOk ? C.stroke : C.amber,
            }}
          />
        </label>
      )}

      {launchError && <ErrorLine text={launchError} />}
      <ValidationSummary issues={issues} />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          data-testid="review-launch"
          disabled={launching || !confirmOk}
          onClick={launch}
          style={{
            ...primaryBtn(launching || !confirmOk),
            padding: "10px 18px",
          }}
        >
          {launching
            ? "launching…"
            : allSolved && !markStaleAndResolve
              ? "Launch — nothing will run"
              : `Launch — ${fCount(totalSolverRuns)} solver runs`}
        </button>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.dimmest }}>
          idempotency {idempotencyKey.slice(0, 8)}…
        </span>
      </div>
    </div>
  );
}
