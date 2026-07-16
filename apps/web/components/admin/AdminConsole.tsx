"use client";

import { DEFAULT_TRANSIENT_MAX_COURANT, type MediumDTO } from "@aerodb/core";
import {
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ExternalLink,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import {
  type AdminBoundaryProfile,
  type AdminFlowCondition,
  type AdminJob,
  type AdminMeshProfile,
  type AdminMe,
  type AdminOutputProfile,
  type AdminAirfoilOption,
  type AdminPendingSweep,
  type AdminQueue,
  type AdminQueueBacklogStrip,
  type AdminQueueScope,
  mergeAdminQueue,
  type AdminReferenceGeometryProfile,
  type AdminSchedulingProfile,
  type AdminSolverExecutionPool,
  type AdminSolverImplementation,
  type AdminSyncPermission,
  type AdminSyncState,
  type AdminSimulationPreset,
  type AdminSimulationSetup,
  type AdminSolverProfile,
  type AdminSweepDefinition,
  type BoundaryProfileInput,
  type CampaignDuplicatePrefill,
  type FlowConditionInput,
  type MeshProfileInput,
  type MediumInput,
  type OutputProfileInput,
  type ReferenceGeometryProfileInput,
  type SchedulingProfileInput,
  type SimulationPresetInput,
  type SolverProfileInput,
  type SweepDefinitionInput,
  adminGoogleLoginUrl,
  adminLogin,
  adminLogout,
  adminMe,
  archiveSyncConflict,
  cancelJob,
  createAdminMedium,
  createBoundaryProfile,
  createFlowCondition,
  createMeshProfile,
  createOutputProfile,
  createReferenceGeometryProfile,
  createSchedulingProfile,
  createSimulationPreset,
  createSolverProfile,
  createSweepDefinition,
  deleteBoundaryProfile,
  deleteFlowCondition,
  deleteMeshProfile,
  deleteOutputProfile,
  deleteReferenceGeometryProfile,
  deleteSchedulingProfile,
  deleteSolverProfile,
  deleteSweepDefinition,
  getAdminMediums,
  getAdminQueue,
  getAdminSync,
  getAdminSimulationSetup,
  patchSweeper,
  patchAdminSync,
  promoteSyncConflict,
  purgeTestArtifacts,
  recoverStaleJobs,
  runUpstreamSync,
  updateAdminMedium,
  updateBoundaryProfile,
  updateFlowCondition,
  updateMeshProfile,
  updateOutputProfile,
  updateReferenceGeometryProfile,
  updateSchedulingProfile,
  updateSimulationPreset,
  updateSolverExecutionPool,
  updateSolverProfile,
  updateSweepDefinition,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { airfoilDetailHref } from "@/lib/detail-links";
import {
  isFinishedLogOpen,
  withFinishedLogParam,
} from "@/lib/finished-log-param";
import {
  campaignPointsSearch,
  type CampaignPointsBucket,
} from "@/lib/point-history";
import { deriveSolverState, solverStateLabel } from "@/lib/solver-state";
import { AddAirfoilsPanel } from "./AddAirfoilsPanel";
import { momentumSchemeSelect } from "./solver-schemes";
import { CategoriesAdminPanel, HashtagsAdminPanel } from "./CatalogAdminPanels";
import { UnitNumberField } from "./UnitNumberField";
import { PointHistoryPanel } from "./PointHistoryPanel";
import {
  SolvedPointsPopover,
  type SolvedPopoverAnchor,
} from "./SolvedPointsPopover";
import { HealthPanel } from "./HealthPanel";
import { CampaignDetail } from "./campaigns/CampaignDetail";
import {
  gateFromSolverState,
  type CampaignGate,
} from "./campaigns/campaign-status";
import { CampaignsHub } from "./campaigns/CampaignsHub";
import { CampaignWizard } from "./campaigns/CampaignWizard";
import { usePoll } from "./campaigns/usePoll";
import { stashDuplicatePrefill } from "./campaigns/wizard-draft";

type Section =
  | "simulations"
  | "queue"
  | "health"
  | "setup"
  | "catalog"
  | "sync";
const SECTIONS: { k: Section; label: string; icon: string }[] = [
  { k: "simulations", label: "Simulations", icon: "∿" },
  // Label "Solver" (approved redesign); the URL key stays ?section=queue so
  // links, tests, and bookmarks keep working (§11 routing contract).
  { k: "queue", label: "Solver", icon: "◷" },
  { k: "health", label: "Health", icon: "▥" },
  { k: "setup", label: "Setup library", icon: "β" },
  { k: "catalog", label: "Catalog", icon: "▸" },
  { k: "sync", label: "Sync API", icon: "⇄" },
];
const SECTION_KEYS = new Set<string>(SECTIONS.map((s) => s.k));

type CatalogTab = "add" | "categories" | "hashtags";
const CATALOG_TABS: { k: CatalogTab; label: string }[] = [
  { k: "add", label: "Add airfoils" },
  { k: "categories", label: "Categories" },
  { k: "hashtags", label: "Hashtags" },
];

function ago(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function agoFromSeconds(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const STATUS_COLOR: Record<string, string> = {
  done: C.teal,
  submitted: C.amber,
  running: C.amber,
  ingesting: C.amber,
  pending: C.dim,
  failed: C.red,
  cancelled: C.muted,
};

const PENDING_COLUMNS =
  "minmax(90px, .85fr) 104px 104px 70px 70px 92px minmax(100px, .85fr) 62px";
// Sum of the PENDING_COLUMNS minimums (692) + 7 column gaps (70) + row padding
// (32): below this width the pending table scrolls inside .admin-table-scroll
// instead of letting the panel's overflow clip the trailing columns.
const PENDING_TABLE_MIN_WIDTH = 794;

const KIND_META: Record<
  AdminJob["kind"],
  { label: string; regime: string; tone: string; fill: string; border: string }
> = {
  "sweep-rans": {
    label: "AoA sweep",
    regime: "RANS",
    tone: C.teal,
    fill: C.tealFill,
    border: C.tealBorder,
  },
  "point-rans": {
    label: "Single point",
    regime: "RANS",
    tone: C.amber,
    fill: "rgba(245, 165, 36, 0.10)",
    border: "rgba(245, 165, 36, 0.38)",
  },
  "point-urans": {
    label: "Single point",
    regime: "URANS",
    tone: C.redText,
    fill: "rgba(245, 101, 101, 0.10)",
    border: "rgba(245, 101, 101, 0.34)",
  },
};

function formatRe(v: number): string {
  if (v >= 1_000_000)
    return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

function f(v: number | null | undefined, digits = 3): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function fSci(v: number | null | undefined, digits = 3): string {
  return typeof v === "number" && Number.isFinite(v)
    ? v.toExponential(digits)
    : "—";
}

function fTemp(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v)
    ? `${v.toFixed(1)} K`
    : "—";
}

function fPressure(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} kPa` : `${v.toFixed(0)} Pa`;
}

function fSpeed(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v)
    ? `${v.toFixed(2)} m/s`
    : "—";
}

function aoaSpan(
  min: number | null | undefined,
  max: number | null | undefined,
): string {
  if (min == null || max == null) return "—";
  if (min === max) return `${min.toFixed(0)}°`;
  return `${min.toFixed(0)}°…${max.toFixed(0)}°`;
}

function aoaRange(job: AdminJob): string {
  if (job.aoaMin == null || job.aoaMax == null) return "—";
  if (job.aoaMin === job.aoaMax) return `${job.aoaMin.toFixed(0)}°`;
  return `${job.aoaMin.toFixed(0)}°…${job.aoaMax.toFixed(0)}°`;
}

function policyLabel(policy: string | null | undefined): string {
  return (policy ?? "auto").replace(/_/g, " ");
}

function schedulingSummary(item: {
  schedulingPolicy: string;
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  meshBuildCount?: number | null;
  aoaCaseCount?: number | null;
  aoaCount?: number;
  totalCases?: number;
}): string {
  const activeCases =
    item.caseConcurrency == null ? "auto" : item.caseConcurrency;
  const solvers = item.solverProcesses ?? 1;
  const mesh = item.meshBuildCount ?? 1;
  const aoas = item.aoaCaseCount ?? item.aoaCount ?? item.totalCases ?? 0;
  const cpu = item.cpuBudget ? `${item.cpuBudget} CPU` : "auto CPU";
  return `${policyLabel(item.schedulingPolicy)} · ${mesh} mesh · ${aoas} AoAs · ${activeCases} active x ${solvers}p · ${cpu}`;
}

const card: CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 12,
  padding: 16,
};
const label: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  letterSpacing: "0.1em",
  color: C.dim,
  marginBottom: 8,
};

export function AdminConsole() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);

  // ---- routing (spec §11): URL search params are the single source of truth
  // for section / campaign / wizard / step / tab — no mirrored useState.
  // push = section change, campaign open, wizard enter; replace = step/tab.
  // popstate is handled by Next's router re-rendering from the new params.
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const rawSection = searchParams.get("section") ?? "";
  const section: Section = SECTION_KEYS.has(rawSection)
    ? (rawSection as Section)
    : "simulations";
  const campaignParam =
    section === "simulations" ? searchParams.get("campaign") : null;
  const wizardParam =
    section === "simulations" ? searchParams.get("wizard") : null;
  const wizardKind =
    wizardParam === "polar_sweep" || wizardParam === "ld_refine"
      ? wizardParam
      : null;
  const stepRaw = Number(searchParams.get("step") ?? "1");
  const wizardStep = Number.isInteger(stepRaw)
    ? Math.min(4, Math.max(1, stepRaw))
    : 1;
  const tabParam = searchParams.get("tab");

  // Dirty flag reported by the wizard (drafts persist to sessionStorage; the
  // guard is about accidental navigation, not data loss — copy stays honest).
  const wizardDirtyRef = useRef(false);

  const navigate = useCallback(
    (params: Record<string, string>, mode: "push" | "replace") => {
      const qs = new URLSearchParams(params).toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      // Shallow client-side URL updates (Next ≥14.1 keeps useSearchParams in
      // sync with the native history API). The admin page is force-dynamic,
      // so router.push/replace would refetch the RSC payload and REMOUNT the
      // console a beat after every section/tab/step change — wiping form
      // state the user already typed into the freshly opened panel. All admin
      // routing state is client-derived from searchParams; no server
      // round-trip is needed.
      if (mode === "push") {
        window.history.pushState(null, "", url);
        window.scrollTo(0, 0); // preserve router.push's scroll-to-top behavior
      } else {
        window.history.replaceState(null, "", url);
      }
    },
    [pathname],
  );

  const confirmLeaveWizard = useCallback(() => {
    if (
      !(
        section === "simulations" &&
        !campaignParam &&
        wizardKind &&
        wizardDirtyRef.current
      )
    )
      return true;
    return window.confirm(
      "Leave the campaign wizard? Your draft is saved in this tab and will be restored the next time you open this wizard type.",
    );
  }, [section, campaignParam, wizardKind]);

  const openCampaign = useCallback(
    (id: string) => navigate({ campaign: id }, "push"),
    [navigate],
  );
  // Explorer links (mockup fec7b453 screen 3): rejected/failed counts on the
  // campaign surfaces open Solver ▸ Points pre-filtered to that campaign +
  // bucket. The search string comes from campaignPointsSearch (the explorer's
  // own filter round-trip) — never hand-built param names.
  const openCampaignPoints = useCallback(
    (campaignId: string, status: CampaignPointsBucket) => {
      const qs = campaignPointsSearch(campaignId, status);
      navigate(Object.fromEntries(new URLSearchParams(qs.slice(1))), "push");
    },
    [navigate],
  );
  const openWizard = useCallback(
    (kind: "polar_sweep" | "ld_refine") =>
      navigate({ wizard: kind, step: "1" }, "push"),
    [navigate],
  );
  const backToHub = useCallback(() => navigate({}, "push"), [navigate]);
  const duplicateCampaign = useCallback(
    (prefill: CampaignDuplicatePrefill) => {
      // The prefill travels via the sessionStorage stash (consumed once by the
      // next wizard mount) so the URL stays the routing source of truth.
      stashDuplicatePrefill(prefill);
      openWizard(
        prefill.plan.objectives.ldMax.enabled ? "ld_refine" : "polar_sweep",
      );
    },
    [openWizard],
  );
  const handleWizardDirty = useCallback((dirty: boolean) => {
    wizardDirtyRef.current = dirty;
  }, []);

  useEffect(() => {
    // Parallelize the first paint: the Solver page's scoped queue fetch starts
    // alongside adminMe instead of waiting for the auth gate to resolve.
    if (section === "queue") {
      const prefetchScope = solverScopeForTab(parseSolverTab(tabParam));
      if (prefetchScope) prefetchQueueScope(prefetchScope);
    }
    adminMe()
      .then(setMe)
      .catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doLogin = async () => {
    setBusy(true);
    setLoginErr(null);
    try {
      await adminLogin(email, password);
      setMe(await adminMe());
    } catch (e) {
      setLoginErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ---- auth gate ----
  if (!me) {
    return (
      <div
        style={{ fontFamily: MONO, fontSize: 13, color: C.muted, padding: 40 }}
      >
        checking access…
      </div>
    );
  }
  if (!me.authed) {
    const googleProvider = me.providers?.google || me.google?.enabled;
    const passwordProvider = me.providers?.password ?? true;
    const googleDomain = me.google?.allowedDomain || "vr.ae";
    return (
      <div style={{ maxWidth: 380, margin: "60px auto", ...card }}>
        <div style={label}>ADMIN SIGN IN</div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.dim,
            marginBottom: 14,
          }}
        >
          {googleProvider
            ? `Use a verified ${googleDomain} Google account.`
            : "This deployment requires admin credentials."}
        </div>
        {googleProvider && (
          <button
            type="button"
            onClick={() => {
              window.location.href = adminGoogleLoginUrl("/admin");
            }}
            style={{
              ...primaryBtn(false),
              width: "100%",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: 8,
            }}
          >
            Continue with Google
            <ExternalLink size={14} />
          </button>
        )}
        {passwordProvider && (
          <div style={{ marginTop: googleProvider ? 14 : 0 }}>
            {googleProvider && (
              <div style={{ ...label, marginTop: 2, marginBottom: 10 }}>
                PASSWORD FALLBACK
              </div>
            )}
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              autoComplete="username"
              style={inputStyle}
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
              placeholder="password"
              type="password"
              autoComplete="current-password"
              style={{ ...inputStyle, marginTop: 10 }}
            />
            {loginErr && (
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  color: C.red,
                  marginTop: 10,
                }}
              >
                {loginErr}
              </div>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={doLogin}
              style={{ ...primaryBtn(busy), width: "100%", marginTop: 14 }}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        )}
        {!googleProvider && !passwordProvider && (
          <div
            style={{
              fontFamily: MONO,
              fontSize: 12,
              color: C.red,
              lineHeight: 1.5,
            }}
          >
            Admin authentication is not configured. Set Google OAuth credentials
            or a password on the API server.
          </div>
        )}
      </div>
    );
  }

  // ---- authed shell: header + sidebar menu + section ----
  return (
    <div>
      <style jsx global>{`
        .admin-shell-grid {
          display: grid;
          grid-template-columns: minmax(150px, 180px) minmax(0, 1fr);
          gap: 22px;
          align-items: start;
        }
        .admin-section-nav {
          display: flex;
          flex-direction: column;
          gap: 4px;
          position: sticky;
          top: 70px;
        }
        .admin-editor-grid {
          display: grid;
          grid-template-columns: minmax(320px, 1fr) minmax(320px, 390px);
          gap: 16px;
          align-items: start;
        }
        .admin-form-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .admin-field-panel {
          display: grid;
          gap: 8px;
          margin-top: 10px;
        }
        .admin-field-panel .label {
          font-family: ${MONO};
          font-size: 10px;
          color: ${C.dim};
        }
        .field-chip-grid {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .field-chip {
          border: 1px solid ${C.stroke};
          border-radius: 6px;
          color: ${C.text};
          background: ${C.panel2};
          font-family: ${MONO};
          font-size: 11px;
          padding: 5px 8px;
        }
        .admin-table-scroll {
          max-width: 100%;
          overflow-x: auto;
          overflow-y: hidden;
        }
        .admin-table-scroll > div:first-child {
          min-width: 600px;
        }
        .admin-metric-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
          gap: 10px;
        }
        .admin-mesh-guide-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
          gap: 8px;
        }
        .admin-tab-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 12px;
        }
        @media (max-width: 940px) {
          .admin-shell-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .admin-section-nav {
            position: static !important;
            flex-direction: row !important;
            overflow-x: auto;
            padding-bottom: 4px;
          }
          .admin-section-nav button {
            flex: 0 0 auto;
          }
          .admin-editor-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .admin-tab-row {
            flex-wrap: nowrap;
            overflow-x: auto;
            padding-bottom: 4px;
            -webkit-mask-image: linear-gradient(
              to right,
              #000 0,
              #000 calc(100% - 28px),
              transparent 100%
            );
            mask-image: linear-gradient(
              to right,
              #000 0,
              #000 calc(100% - 28px),
              transparent 100%
            );
          }
          .admin-tab-row button {
            flex: 0 0 auto;
          }
        }
        @media (max-width: 620px) {
          .admin-form-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          Admin
        </h1>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            letterSpacing: "0.08em",
            color: me.mode === "prod" ? C.teal : C.amber,
            border: `1px solid ${me.mode === "prod" ? C.tealBorder : C.stroke}`,
            background: me.mode === "prod" ? C.tealFill : "transparent",
            borderRadius: 5,
            padding: "3px 8px",
          }}
        >
          {me.mode === "prod"
            ? `PROD · ${me.provider === "google" ? "Google · " : ""}${me.email}`
            : "DEV · auth off"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {me.mode === "prod" && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await adminLogout();
                  setMe(await adminMe());
                } finally {
                  setBusy(false);
                }
              }}
              style={ghostBtn}
            >
              Sign out
            </button>
          )}
        </div>
      </div>

      {err && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.red,
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}

      <div className="admin-shell-grid">
        <nav className="admin-section-nav">
          {SECTIONS.map((s) => {
            const on = section === s.k;
            return (
              <button
                key={s.k}
                type="button"
                data-testid={`admin-nav-${s.k}`}
                onClick={() => {
                  // Clicking the active section with no sub-state is a no-op
                  // (no duplicate history entries).
                  if (on && !campaignParam && !wizardKind && !tabParam) return;
                  if (!confirmLeaveWizard()) return;
                  wizardDirtyRef.current = false;
                  navigate(
                    s.k === "simulations" ? {} : { section: s.k },
                    "push",
                  );
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  textAlign: "left",
                  fontFamily: MONO,
                  fontSize: 12,
                  color: on ? C.teal : C.muted,
                  background: on ? C.navActive : "transparent",
                  border: `1px solid ${on ? C.tealBorder : "transparent"}`,
                  borderRadius: 8,
                  padding: "9px 11px",
                  cursor: "pointer",
                  fontWeight: on ? 600 : 400,
                }}
              >
                <span
                  style={{
                    width: 14,
                    textAlign: "center",
                    opacity: on ? 1 : 0.7,
                  }}
                >
                  {s.icon}
                </span>
                {s.label}
              </button>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          {section === "simulations" && campaignParam && (
            <CampaignDetail
              campaignId={campaignParam}
              onBack={backToHub}
              onDuplicate={duplicateCampaign}
              onOpenPoints={(status) =>
                openCampaignPoints(campaignParam, status)
              }
            />
          )}
          {section === "simulations" && !campaignParam && wizardKind && (
            <CampaignWizard
              key={wizardKind}
              initialKind={wizardKind}
              step={wizardStep}
              onStepChange={(n) =>
                navigate({ wizard: wizardKind, step: String(n) }, "replace")
              }
              onLaunched={(id) => {
                wizardDirtyRef.current = false;
                openCampaign(id);
              }}
              onExit={() => {
                if (!confirmLeaveWizard()) return;
                wizardDirtyRef.current = false;
                backToHub();
              }}
              onDirtyChange={handleWizardDirty}
            />
          )}
          {section === "simulations" && !campaignParam && !wizardKind && (
            <CampaignsHub
              onOpenCampaign={openCampaign}
              onNewCampaign={openWizard}
              onOpenSolver={() => navigate({ section: "queue" }, "push")}
              onOpenPoints={openCampaignPoints}
            />
          )}
          {section === "queue" && (
            <QueueDashboard
              tab={parseSolverTab(tabParam)}
              onTabChange={(t) =>
                navigate(
                  t === "activity"
                    ? { section: "queue" }
                    : { section: "queue", tab: t },
                  "replace",
                )
              }
              onOpenCampaign={openCampaign}
              onOpenSimulations={() => navigate({}, "push")}
              onOpenPoints={openCampaignPoints}
            />
          )}
          {section === "health" && <HealthPanel />}
          {section === "setup" && (
            <SimulationSetupPanel
              tab={parseSetupTab(tabParam)}
              onTabChange={(t) =>
                navigate(
                  t === "presets"
                    ? { section: "setup" }
                    : { section: "setup", tab: t },
                  "replace",
                )
              }
            />
          )}
          {section === "catalog" && (
            <CatalogPanel
              tab={parseCatalogTab(tabParam)}
              onTabChange={(t) =>
                navigate(
                  t === "add"
                    ? { section: "catalog" }
                    : { section: "catalog", tab: t },
                  "replace",
                )
              }
            />
          )}
          {section === "sync" && <SyncApiPanel />}
        </div>
      </div>
    </div>
  );
}

const defaultMediumForm: MediumInput = {
  name: "",
  phase: "gas",
  density: 1.225,
  refTemperatureK: 288.15,
  refPressurePa: 101325,
  viscosityModel: "sutherland",
  constantDynamicViscosity: null,
  sutherlandMuRef: 1.716e-5,
  sutherlandTRef: 273.15,
  sutherlandS: 110.4,
  viscosityTable: [
    { temperatureK: 288.15, dynamicViscosity: 1.789e-5, sortOrder: 0 },
  ],
  speedOfSound: 340.3,
  notes: "",
};

type ValidationIssue = {
  field: string;
  message: string;
};

function requiredIssue(
  value: string | null | undefined,
  field: string,
  message = `${field} is required`,
): ValidationIssue | null {
  return value?.trim() ? null : { field, message };
}

function requiredChoiceIssue(
  value: string | null | undefined,
  field: string,
): ValidationIssue | null {
  return value ? null : { field, message: `Choose ${field.toLowerCase()}` };
}

function positiveIssue(
  value: number | null | undefined,
  field: string,
): ValidationIssue | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? null
    : { field, message: `${field} must be greater than 0` };
}

function nonNegativeIssue(
  value: number | null | undefined,
  field: string,
): ValidationIssue | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? null
    : { field, message: `${field} must be 0 or greater` };
}

function optionalPositiveIntegerIssue(
  value: number | null | undefined,
  field: string,
): ValidationIssue | null {
  if (value == null) return null;
  return Number.isInteger(value) && value > 0
    ? null
    : { field, message: `${field} must be a positive integer or blank` };
}

function positiveIntegerIssue(
  value: number | null | undefined,
  field: string,
): ValidationIssue | null {
  return Number.isInteger(value) && typeof value === "number" && value > 0
    ? null
    : { field, message: `${field} must be a positive integer` };
}

function compactIssues(
  issues: Array<ValidationIssue | null>,
): ValidationIssue[] {
  return issues.filter((issue): issue is ValidationIssue => !!issue);
}

function adminFieldSelector(field: string) {
  const escaped = field.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-admin-field="${escaped}"] input, [data-admin-field="${escaped}"] select, [data-admin-field="${escaped}"] textarea, [data-admin-field="${escaped}"] button`;
}

function focusValidationIssue(issue: ValidationIssue | undefined) {
  if (!issue) return;
  window.setTimeout(() => {
    const target = document.querySelector<HTMLElement>(
      adminFieldSelector(issue.field),
    );
    target?.focus();
  }, 0);
}

function issueFor(issues: ValidationIssue[], field: string) {
  return issues.find((issue) => issue.field === field)?.message;
}

function MediumsPanel() {
  const [items, setItems] = useState<MediumDTO[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<MediumInput>(defaultMediumForm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>(
    [],
  );
  const selected = items.find((m) => m.id === selectedId) ?? null;

  const refresh = async () => setItems((await getAdminMediums()).items);
  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, []);

  const select = (m: MediumDTO) => {
    setValidationIssues([]);
    setSelectedId(m.id);
    const next: MediumInput = {
      name: m.name,
      phase: m.phase,
      density: m.density,
      refTemperatureK: m.refTemperatureK,
      refPressurePa: m.refPressurePa,
      viscosityModel: m.viscosityModel,
      constantDynamicViscosity: m.constantDynamicViscosity,
      sutherlandMuRef: m.sutherlandMuRef,
      sutherlandTRef: m.sutherlandTRef,
      sutherlandS: m.sutherlandS,
      viscosityTable: m.viscosityTable,
      speedOfSound: m.speedOfSound,
      notes: m.notes,
    };
    setForm(next);
  };

  const validateMedium = () =>
    compactIssues([
      requiredIssue(form.name, "Name"),
      positiveIssue(form.density, "Density kg/m³"),
      positiveIssue(form.refTemperatureK, "Ref temp"),
      positiveIssue(form.refPressurePa, "Ref pressure"),
      form.speedOfSound == null || form.speedOfSound === 0
        ? null
        : positiveIssue(form.speedOfSound, "Speed of sound"),
      form.viscosityModel === "constant"
        ? positiveIssue(
            form.constantDynamicViscosity ?? 0,
            "Dynamic viscosity μ [Pa·s]",
          )
        : null,
      form.viscosityModel === "sutherland"
        ? positiveIssue(form.sutherlandMuRef ?? 0, "μ ref [Pa·s]")
        : null,
      form.viscosityModel === "sutherland"
        ? positiveIssue(form.sutherlandTRef ?? 0, "T ref")
        : null,
      form.viscosityModel === "sutherland"
        ? positiveIssue(form.sutherlandS ?? 0, "Sutherland S")
        : null,
      ...(form.viscosityModel === "table"
        ? (form.viscosityTable ?? []).flatMap((row, i) => [
            positiveIssue(row.temperatureK, `T ${i + 1}`),
            positiveIssue(row.dynamicViscosity, `μ [Pa·s] ${i + 1}`),
          ])
        : []),
    ]);

  useEffect(() => {
    if (validationIssues.length) setValidationIssues(validateMedium());
  }, [form, validationIssues.length]);

  const save = async () => {
    const issues = validateMedium();
    if (issues.length) {
      setValidationIssues(issues);
      focusValidationIssue(issues[0]);
      return;
    }
    setValidationIssues([]);
    setBusy(true);
    setErr(null);
    try {
      const body = {
        ...form,
        viscosityTable: (form.viscosityTable ?? []).map((row, i) => ({
          ...row,
          sortOrder: i,
        })),
        speedOfSound: form.speedOfSound || null,
      };
      if (selected) await updateAdminMedium(selected.id, body);
      else await createAdminMedium(body);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSelectedId("");
    setValidationIssues([]);
    setForm({
      ...defaultMediumForm,
      viscosityTable: [...(defaultMediumForm.viscosityTable ?? [])],
    });
  };

  const setTableRow = (
    index: number,
    patch: Partial<NonNullable<MediumInput["viscosityTable"]>[number]>,
  ) => {
    setForm((current) => {
      const rows = [...(current.viscosityTable ?? [])];
      rows[index] = { ...rows[index], ...patch, sortOrder: index };
      return { ...current, viscosityTable: rows };
    });
  };

  return (
    <div>
      {err && <ErrorLine text={err} />}
      <div className="admin-editor-grid">
        <div style={card}>
          <div style={label}>MATERIALS</div>
          <div className="admin-table-scroll">
            <TableHead
              columns="minmax(160px, 1.25fr) 62px 84px 84px 88px 88px"
              labels={["Name", "Phase", "ρ", "T ref", "μ", "ν"]}
            />
            {items.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => select(m)}
                style={{
                  minWidth: 610,
                  width: "100%",
                  display: "grid",
                  gridTemplateColumns:
                    "minmax(160px, 1.25fr) 62px 84px 84px 88px 88px",
                  gap: 10,
                  alignItems: "center",
                  textAlign: "left",
                  fontFamily: MONO,
                  fontSize: 11,
                  color: selectedId === m.id ? C.teal : C.muted,
                  background: selectedId === m.id ? C.rowActive : "transparent",
                  border: "none",
                  borderBottom: `1px solid ${C.borderRow}`,
                  padding: "9px 0",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.name}
                </span>
                <span>{m.phase}</span>
                <span>{f(m.density, 3)}</span>
                <span>{f(m.refTemperatureK, 1)}</span>
                <span>{fSci(m.dynamicViscosity, 2)}</span>
                <span>{fSci(m.kinematicViscosity, 2)}</span>
              </button>
            ))}
          </div>
        </div>
        <div style={card}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}
          >
            <div style={label}>{selected ? "EDIT MEDIUM" : "ADD MEDIUM"}</div>
            <button
              type="button"
              onClick={reset}
              style={{ ...ghostBtn, padding: "5px 8px", fontSize: 10 }}
            >
              new
            </button>
          </div>
          <TextField
            label="Name"
            value={form.name}
            error={issueFor(validationIssues, "Name")}
            onChange={(name) => setForm((f) => ({ ...f, name }))}
          />
          {!selected && (
            <TextField
              label="Slug optional"
              value={form.slug ?? ""}
              onChange={(slug) => setForm((f) => ({ ...f, slug }))}
            />
          )}
          <div className="admin-form-grid">
            <SelectField
              label="Phase"
              value={form.phase}
              options={["gas", "liquid"]}
              onChange={(phase) =>
                setForm((f) => ({ ...f, phase: phase as "gas" | "liquid" }))
              }
            />
            <NumberField
              label="Density kg/m³"
              value={form.density}
              error={issueFor(validationIssues, "Density kg/m³")}
              onChange={(density) => setForm((f) => ({ ...f, density }))}
            />
            <UnitNumberField
              label="Ref temp"
              dimension="temperature"
              valueSi={form.refTemperatureK}
              min={0}
              error={issueFor(validationIssues, "Ref temp")}
              onChangeSi={(refTemperatureK) =>
                setForm((f) => ({ ...f, refTemperatureK }))
              }
            />
            <UnitNumberField
              label="Ref pressure"
              dimension="pressure"
              valueSi={form.refPressurePa}
              min={0}
              error={issueFor(validationIssues, "Ref pressure")}
              onChangeSi={(refPressurePa) =>
                setForm((f) => ({ ...f, refPressurePa }))
              }
            />
            <SelectField
              label="Viscosity model"
              value={form.viscosityModel}
              options={["constant", "sutherland", "table"]}
              onChange={(viscosityModel) =>
                setForm((f) => ({
                  ...f,
                  viscosityModel:
                    viscosityModel as MediumInput["viscosityModel"],
                }))
              }
            />
            <UnitNumberField
              label="Speed of sound"
              dimension="speed"
              valueSi={form.speedOfSound ?? 0}
              min={0}
              error={issueFor(validationIssues, "Speed of sound")}
              onChangeSi={(speedOfSound) =>
                setForm((f) => ({ ...f, speedOfSound }))
              }
            />
          </div>
          {form.viscosityModel === "constant" && (
            <NumberField
              label="Dynamic viscosity μ [Pa·s]"
              value={form.constantDynamicViscosity ?? 0}
              error={issueFor(validationIssues, "Dynamic viscosity μ [Pa·s]")}
              onChange={(constantDynamicViscosity) =>
                setForm((f) => ({ ...f, constantDynamicViscosity }))
              }
            />
          )}
          {form.viscosityModel === "sutherland" && (
            <div className="admin-form-grid">
              <NumberField
                label="μ ref [Pa·s]"
                value={form.sutherlandMuRef ?? 0}
                error={issueFor(validationIssues, "μ ref [Pa·s]")}
                onChange={(sutherlandMuRef) =>
                  setForm((f) => ({ ...f, sutherlandMuRef }))
                }
              />
              <UnitNumberField
                label="T ref"
                dimension="temperature"
                valueSi={form.sutherlandTRef ?? 0}
                min={0}
                error={issueFor(validationIssues, "T ref")}
                onChangeSi={(sutherlandTRef) =>
                  setForm((f) => ({ ...f, sutherlandTRef }))
                }
              />
              <UnitNumberField
                label="Sutherland S"
                dimension="temperature"
                valueSi={form.sutherlandS ?? 0}
                min={0}
                error={issueFor(validationIssues, "Sutherland S")}
                onChangeSi={(sutherlandS) =>
                  setForm((f) => ({ ...f, sutherlandS }))
                }
              />
            </div>
          )}
          {form.viscosityModel === "table" && (
            <div style={{ marginTop: 8 }}>
              <div style={miniLabel}>Viscosity table</div>
              {(form.viscosityTable ?? []).map((row, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 34px",
                    gap: 8,
                    alignItems: "end",
                    marginBottom: 6,
                  }}
                >
                  <UnitNumberField
                    label={`T ${i + 1}`}
                    dimension="temperature"
                    valueSi={row.temperatureK}
                    min={0}
                    error={issueFor(validationIssues, `T ${i + 1}`)}
                    onChangeSi={(temperatureK) =>
                      setTableRow(i, { temperatureK })
                    }
                  />
                  <NumberField
                    label={`μ [Pa·s] ${i + 1}`}
                    value={row.dynamicViscosity}
                    error={issueFor(validationIssues, `μ [Pa·s] ${i + 1}`)}
                    onChange={(dynamicViscosity) =>
                      setTableRow(i, { dynamicViscosity })
                    }
                  />
                  <button
                    type="button"
                    aria-label="Remove table point"
                    onClick={() =>
                      setForm((current) => ({
                        ...current,
                        viscosityTable: (current.viscosityTable ?? [])
                          .filter((_, j) => j !== i)
                          .map((p, j) => ({ ...p, sortOrder: j })),
                      }))
                    }
                    style={{ ...ghostBtn, padding: 8 }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    viscosityTable: [
                      ...(current.viscosityTable ?? []),
                      {
                        temperatureK: current.refTemperatureK,
                        dynamicViscosity:
                          current.constantDynamicViscosity ??
                          current.sutherlandMuRef ??
                          1e-5,
                        sortOrder: current.viscosityTable?.length ?? 0,
                      },
                    ],
                  }))
                }
                style={{ ...ghostBtn, width: "100%", marginTop: 4 }}
              >
                add table point
              </button>
            </div>
          )}
          <TextField
            label="Notes"
            value={form.notes ?? ""}
            onChange={(notes) => setForm((f) => ({ ...f, notes }))}
          />
          <ValidationSummary issues={validationIssues} />
          <button
            type="button"
            disabled={busy}
            onClick={save}
            style={{ ...primaryBtn(busy), width: "100%", marginTop: 12 }}
          >
            {busy ? "saving…" : selected ? "save medium" : "add medium"}
          </button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_SETUP: AdminSimulationSetup = {
  flowConditions: [],
  referenceGeometryProfiles: [],
  boundaryProfiles: [],
  meshProfiles: [],
  solverImplementations: [],
  solverExecutionPools: [],
  solverProfiles: [],
  schedulingProfiles: [],
  outputProfiles: [],
  sweepDefinitions: [],
  airfoilOptions: [],
  simulationPresets: [],
};

type SetupTab =
  | "presets"
  | "flow"
  | "referenceGeometry"
  | "boundary"
  | "mesh"
  | "solver"
  | "scheduling"
  | "output"
  | "sweeps"
  | "mediums";
const SETUP_TABS: { k: SetupTab; label: string }[] = [
  { k: "presets", label: "Presets" },
  { k: "flow", label: "Flow state" },
  { k: "referenceGeometry", label: "Reference geometry" },
  { k: "boundary", label: "Boundary" },
  { k: "mesh", label: "Mesh" },
  { k: "solver", label: "Solver" },
  { k: "scheduling", label: "Scheduling" },
  { k: "output", label: "Output" },
  { k: "sweeps", label: "Sweeps" },
  { k: "mediums", label: "Mediums" },
];

function parseSetupTab(raw: string | null): SetupTab {
  return SETUP_TABS.some((t) => t.k === raw) ? (raw as SetupTab) : "presets";
}

function parseCatalogTab(raw: string | null): CatalogTab {
  return CATALOG_TABS.some((t) => t.k === raw) ? (raw as CatalogTab) : "add";
}

// Solver page tabs (approved redesign): Activity is the default (no ?tab
// param), Background / Engine / Points are replace-semantics tabs per §11.
// Points = the Point History Explorer (approved 2026-07-06) — it owns its own
// data fetches, so the queue poll skips it entirely.
type SolverTab = "activity" | "background" | "engine" | "points";
const SOLVER_TABS: { k: SolverTab; label: string }[] = [
  { k: "activity", label: "Activity" },
  { k: "background", label: "Background" },
  { k: "engine", label: "Engine" },
  { k: "points", label: "Points" },
];

function parseSolverTab(raw: string | null): SolverTab {
  return SOLVER_TABS.some((t) => t.k === raw) ? (raw as SolverTab) : "activity";
}

/** Each Solver tab polls only its own scope (spec §10/§12) — the expensive
 *  background gap scan runs only while the Background tab is actually open.
 *  The Points tab returns null: the explorer fetches its own bounded pages
 *  and the queue payload is never needed there. */
function solverScopeForTab(tab: SolverTab): AdminQueueScope | null {
  if (tab === "points") return null;
  return tab === "background"
    ? "background"
    : tab === "engine"
      ? "engine"
      : "activity";
}

// First-load waterfall fix: AdminConsole mounts QueueDashboard only after
// adminMe() resolves, so without this the queue fetch would start a full
// auth round-trip late. The console kicks the scoped queue fetch off in
// parallel with adminMe; the dashboard consumes it once if it is still fresh.
const QUEUE_PREFETCH_MAX_AGE_MS = 30_000;
let queuePrefetch: {
  scope: AdminQueueScope;
  startedAt: number;
  promise: Promise<AdminQueue>;
} | null = null;
function prefetchQueueScope(scope: AdminQueueScope): void {
  const promise = getAdminQueue(scope);
  // Swallow here so an unauthenticated 401 never surfaces as an unhandled
  // rejection; the consumer awaits the original promise and handles errors.
  promise.catch(() => undefined);
  queuePrefetch = { scope, startedAt: Date.now(), promise };
}
function consumeQueuePrefetch(
  scope: AdminQueueScope,
): Promise<AdminQueue> | null {
  const entry = queuePrefetch;
  queuePrefetch = null;
  if (!entry || entry.scope !== scope) return null;
  if (Date.now() - entry.startedAt > QUEUE_PREFETCH_MAX_AGE_MS) return null;
  return entry.promise;
}

function CatalogPanel({
  tab,
  onTabChange,
}: {
  tab: CatalogTab;
  onTabChange: (t: CatalogTab) => void;
}) {
  return (
    <div>
      <div className="admin-tab-row">
        {CATALOG_TABS.map((item) => (
          <button
            key={item.k}
            type="button"
            data-testid={`catalog-tab-${item.k}`}
            onClick={() => onTabChange(item.k)}
            style={{
              ...ghostBtn,
              padding: "7px 10px",
              color: tab === item.k ? C.teal : C.muted,
              borderColor: tab === item.k ? C.tealBorder : C.stroke,
              background: tab === item.k ? C.tealFill : C.panel3,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "add" && <AddAirfoilsPanel />}
      {tab === "categories" && <CategoriesAdminPanel />}
      {tab === "hashtags" && <HashtagsAdminPanel />}
    </div>
  );
}

// Exported for the campaign wizard's numerics quick-create (spec §11): the
// same 8 engine image fields and labels the Setup output editor shows.
export const ALL_IMAGE_FIELDS = [
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity",
];
export const IMAGE_FIELD_LABELS: Record<string, string> = {
  velocity_magnitude: "Velocity |U|",
  velocity_x: "Velocity Ux",
  velocity_y: "Velocity Uy",
  pressure: "Pressure p",
  pressure_coefficient: "Pressure Cp",
  vorticity: "Vorticity ωz",
  turbulent_kinetic_energy: "Turbulence k",
  turbulent_viscosity: "Turbulent viscosity νt",
};

const REFERENCE_GEOMETRY_TYPE_OPTIONS = [
  { value: "airfoil_2d", label: "2D airfoil" },
];
const REFERENCE_LENGTH_KIND_OPTIONS = [{ value: "chord", label: "Chord" }];
const MESH_MESHER_OPTIONS = [
  { value: "blockmesh-cgrid", label: "C-grid blockMesh" },
];
const TURBULENT_VISCOSITY_RATIO_PRESETS = [
  { value: "3", label: "Low · νt/ν 3" },
  { value: "10", label: "Standard airfoil · νt/ν 10" },
  { value: "30", label: "High freestream turbulence · νt/ν 30" },
];

const defaultFlowForm = (medium?: MediumDTO): FlowConditionInput => ({
  name: "",
  mediumId: medium?.id ?? "",
  temperatureK: medium?.refTemperatureK ?? 288.15,
  pressurePa: medium?.refPressurePa ?? 101325,
  speedMps: 50,
});
const defaultReferenceGeometryForm = (): ReferenceGeometryProfileInput => ({
  name: "",
  geometryType: "airfoil_2d",
  referenceLengthKind: "chord",
  referenceLengthM: 1,
  spanM: null,
  referenceAreaM2: null,
});
const defaultBoundaryForm = (): BoundaryProfileInput => ({
  name: "",
  turbulenceIntensity: 0.001,
  viscosityRatio: 10,
  sandGrainHeight: 0,
  roughnessConstant: 0.5,
});
const defaultMeshForm = (): MeshProfileInput => ({
  name: "",
  mesher: "blockmesh-cgrid",
  farfieldRadiusChords: 15,
  wakeLengthChords: 12,
  nSurface: 130,
  nRadial: 80,
  nWake: 60,
  targetYPlus: 1,
  spanChords: 0.1,
});
function solverFamilyLabel(family: string) {
  return family.toLowerCase() === "openfoam" ? "OpenFOAM" : family;
}

function solverDistributionLabel(distribution: string) {
  if (distribution.toLowerCase() === "opencfd") return "OpenCFD";
  if (distribution.toLowerCase() === "foundation") return "Foundation";
  return distribution;
}

function solverImplementationLabel(
  implementation: Pick<
    AdminSolverImplementation,
    "family" | "distribution" | "releaseVersion"
  >,
) {
  return `${solverFamilyLabel(implementation.family)} · ${solverDistributionLabel(implementation.distribution)} ${implementation.releaseVersion}`;
}

function selectableSolverImplementations(setup: AdminSimulationSetup) {
  return setup.solverImplementations.filter(
    (implementation) => implementation.retiredAt == null,
  );
}

function preferredSolverImplementationId(setup: AdminSimulationSetup) {
  const active = selectableSolverImplementations(setup);
  return (
    active.find(
      (implementation) =>
        implementation.family.toLowerCase() === "openfoam" &&
        implementation.distribution.toLowerCase() === "opencfd" &&
        implementation.releaseVersion === "2606",
    )?.id ??
    active[0]?.id ??
    ""
  );
}

const defaultSolverForm = (
  solverImplementationId = "",
): SolverProfileInput => ({
  name: "",
  solverImplementationId,
  turbulenceModel: "kOmegaSST",
  nIterations: 3000,
  convergenceTolerance: 1e-5,
  momentumScheme: "linearUpwind",
  transientCycles: 10,
  transientDiscardFraction: 0.4,
  transientMaxCourant: DEFAULT_TRANSIENT_MAX_COURANT,
});
const defaultSchedulingForm = (): SchedulingProfileInput => ({
  name: "",
  schedulingPolicy: "auto",
  cpuBudget: null,
  caseConcurrency: null,
  solverProcesses: null,
});
const defaultOutputForm = (): OutputProfileInput => ({
  name: "",
  writeImages: [...ALL_IMAGE_FIELDS],
  imageZoomChords: 2,
});
const defaultSweepForm = (): SweepDefinitionInput => ({
  name: "",
  aoaStart: -8,
  aoaStop: 20,
  aoaStep: 1,
  aoaList: null,
});
const defaultPresetForm = (
  setup: AdminSimulationSetup,
): SimulationPresetInput => ({
  name: "",
  flowConditionId: setup.flowConditions[0]?.id ?? "",
  referenceGeometryProfileId: setup.referenceGeometryProfiles[0]?.id ?? "",
  boundaryProfileId: setup.boundaryProfiles[0]?.id ?? "",
  meshProfileId: setup.meshProfiles[0]?.id ?? "",
  solverProfileId: setup.solverProfiles[0]?.id ?? "",
  schedulingProfileId: setup.schedulingProfiles[0]?.id ?? "",
  outputProfileId: setup.outputProfiles[0]?.id ?? "",
  sweepDefinitionId: setup.sweepDefinitions[0]?.id ?? "",
  targetScope: "all",
  targetAirfoilIds: [],
  enabled: true,
});

function parseNumberList(text: string): number[] | null {
  const values = text
    .split(",")
    .map((v) => Number(v.trim()))
    .filter(Number.isFinite);
  return values.length ? values : null;
}

function optionLabels<T extends { id: string; name: string }>(
  rows: T[],
  empty = "choose record",
) {
  return Object.fromEntries([
    ["", empty],
    ...rows.map((row) => [row.id, row.name]),
  ]);
}

function optionValues<T extends { id: string }>(rows: T[]) {
  return ["", ...rows.map((row) => row.id)];
}

function setupOptionValues(options: { value: string }[], current: string) {
  const values = options.map((option) => option.value);
  return values.includes(current) ? values : [current, ...values];
}

function setupOptionLabels(
  options: { value: string; label: string }[],
  current: string,
) {
  return Object.fromEntries(
    setupOptionValues(options, current).map((value) => [
      value,
      options.find((option) => option.value === value)?.label ?? value,
    ]),
  );
}

function shouldShowSetupOption(options: { value: string }[], current: string) {
  return (
    options.length > 1 || !options.some((option) => option.value === current)
  );
}

function SetupRecordList<T extends { id: string; name: string }>({
  items,
  selectedId,
  onSelect,
  onRemove,
  describe,
  emptyText,
  busy = false,
}: {
  items: T[];
  selectedId: string;
  onSelect: (item: T) => void;
  onRemove?: (item: T) => void;
  describe: (item: T) => string;
  emptyText: string;
  busy?: boolean;
}) {
  if (!items.length)
    return (
      <div
        style={{
          fontFamily: MONO,
          fontSize: 11,
          color: C.dim,
          padding: "10px 0",
        }}
      >
        {emptyText}
      </div>
    );
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {items.map((item) => {
        const loaded = selectedId === item.id;
        return (
          <div
            key={item.id}
            style={{
              display: "grid",
              gridTemplateColumns: onRemove
                ? "minmax(0, 1fr) 32px"
                : "minmax(0, 1fr)",
              gap: 6,
              alignItems: "stretch",
            }}
          >
            <button
              type="button"
              aria-pressed={loaded}
              onClick={() => onSelect(item)}
              style={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto auto",
                gap: 10,
                alignItems: "center",
                textAlign: "left",
                fontFamily: MONO,
                fontSize: 11,
                color: loaded ? C.teal : C.muted,
                background: loaded ? C.rowActive : "transparent",
                border: `1px solid ${loaded ? C.tealBorder : C.stroke}`,
                borderRadius: 8,
                padding: "8px 10px",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  color: C.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.name}
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 240,
                }}
              >
                {describe(item)}
              </span>
              {loaded && (
                <span
                  style={{
                    color: C.teal,
                    border: `1px solid ${C.tealBorder}`,
                    background: "rgba(45, 212, 191, 0.08)",
                    borderRadius: 999,
                    padding: "2px 6px",
                    fontSize: 9,
                  }}
                >
                  loaded
                </span>
              )}
            </button>
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                title={`Remove ${item.name}`}
                disabled={busy}
                onClick={() => onRemove(item)}
                style={{
                  ...ghostBtn,
                  display: "grid",
                  placeItems: "center",
                  minWidth: 0,
                  padding: 0,
                  color: C.redText,
                  opacity: busy ? 0.55 : 1,
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SetupRecordListPanel<T extends { id: string; name: string }>({
  title,
  items,
  selectedId,
  onSelect,
  onNew,
  onRemove,
  describe,
  emptyText,
  busy = false,
}: {
  title: string;
  items: T[];
  selectedId: string;
  onSelect: (item: T) => void;
  onNew: () => void;
  onRemove?: (item: T) => void;
  describe: (item: T) => string;
  emptyText: string;
  busy?: boolean;
}) {
  return (
    <div style={card}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={label}>{title}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            disabled={busy}
            onClick={onNew}
            style={{
              ...ghostBtn,
              padding: "5px 9px",
              fontSize: 10,
              color: C.teal,
            }}
          >
            New
          </button>
        </div>
      </div>
      <SetupRecordList
        items={items}
        selectedId={selectedId}
        onSelect={onSelect}
        onRemove={onRemove}
        describe={describe}
        emptyText={emptyText}
        busy={busy}
      />
    </div>
  );
}

function SimulationSetupPanel({
  tab,
  onTabChange,
}: {
  tab: SetupTab;
  onTabChange: (t: SetupTab) => void;
}) {
  const [setup, setSetup] = useState<AdminSimulationSetup>(EMPTY_SETUP);
  const [mediumsList, setMediumsList] = useState<MediumDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [flowId, setFlowId] = useState("");
  const [referenceGeometryId, setReferenceGeometryId] = useState("");
  const [boundaryId, setBoundaryId] = useState("");
  const [meshId, setMeshId] = useState("");
  const [solverId, setSolverId] = useState("");
  const [schedulingId, setSchedulingId] = useState("");
  const [outputId, setOutputId] = useState("");
  const [sweepId, setSweepId] = useState("");
  const [presetId, setPresetId] = useState("");

  const [flowForm, setFlowForm] =
    useState<FlowConditionInput>(defaultFlowForm());
  const [referenceGeometryForm, setReferenceGeometryForm] =
    useState<ReferenceGeometryProfileInput>(defaultReferenceGeometryForm());
  const [boundaryForm, setBoundaryForm] = useState<BoundaryProfileInput>(
    defaultBoundaryForm(),
  );
  const [meshForm, setMeshForm] = useState<MeshProfileInput>(defaultMeshForm());
  const [solverForm, setSolverForm] =
    useState<SolverProfileInput>(defaultSolverForm());
  const [schedulingForm, setSchedulingForm] = useState<SchedulingProfileInput>(
    defaultSchedulingForm(),
  );
  const [outputForm, setOutputForm] =
    useState<OutputProfileInput>(defaultOutputForm());
  const [sweepForm, setSweepForm] =
    useState<SweepDefinitionInput>(defaultSweepForm());
  const [presetForm, setPresetForm] = useState<SimulationPresetInput>(
    defaultPresetForm(EMPTY_SETUP),
  );
  const [aoaListText, setAoaListText] = useState("");
  const [targetAirfoilQuery, setTargetAirfoilQuery] = useState("");
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>(
    [],
  );

  const medium =
    mediumsList.find((m) => m.id === flowForm.mediumId) ??
    mediumsList[0] ??
    null;
  const selectedFlowForPreset = setup.flowConditions.find(
    (row) => row.id === presetForm.flowConditionId,
  );
  const selectedReferenceForPreset = setup.referenceGeometryProfiles.find(
    (row) => row.id === presetForm.referenceGeometryProfileId,
  );
  const presetPreview =
    selectedFlowForPreset && selectedReferenceForPreset
      ? {
          reynolds:
            (selectedFlowForPreset.speedMps *
              selectedReferenceForPreset.referenceLengthM) /
            selectedFlowForPreset.kinematicViscosity,
          mach: selectedFlowForPreset.mach,
        }
      : null;
  const flowPreview = medium ? previewFlow(medium, flowForm) : null;
  const selectedPreset =
    setup.simulationPresets.find((p) => p.id === presetId) ?? null;
  const solverImplementationOptions = (() => {
    const active = selectableSolverImplementations(setup);
    const current = setup.solverImplementations.find(
      (implementation) =>
        implementation.id === solverForm.solverImplementationId,
    );
    return current &&
      !active.some((implementation) => implementation.id === current.id)
      ? [...active, current]
      : active;
  })();
  const solverImplementationOptionLabels = Object.fromEntries([
    ["", "choose engine implementation"],
    ...solverImplementationOptions.map((implementation) => [
      implementation.id,
      `${solverImplementationLabel(implementation)}${implementation.retiredAt ? " · retired" : ""}`,
    ]),
  ]);

  const refresh = async () => {
    const [ms, data] = await Promise.all([
      getAdminMediums(),
      getAdminSimulationSetup(),
    ]);
    setMediumsList(ms.items);
    setSetup(data);
    setSolverForm((current) => ({
      ...current,
      solverImplementationId:
        current.solverImplementationId || preferredSolverImplementationId(data),
    }));
    setFlowForm((current) => {
      if (current.mediumId || !ms.items[0]) return current;
      const defaults = defaultFlowForm(ms.items[0]);
      return {
        ...current,
        mediumId: defaults.mediumId,
        temperatureK: current.temperatureK || defaults.temperatureK,
        pressurePa: current.pressurePa || defaults.pressurePa,
        speedMps: current.speedMps || defaults.speedMps,
      };
    });
    setPresetForm((current) => ({
      ...current,
      flowConditionId:
        current.flowConditionId || data.flowConditions[0]?.id || "",
      referenceGeometryProfileId:
        current.referenceGeometryProfileId ||
        data.referenceGeometryProfiles[0]?.id ||
        "",
      boundaryProfileId:
        current.boundaryProfileId || data.boundaryProfiles[0]?.id || "",
      meshProfileId: current.meshProfileId || data.meshProfiles[0]?.id || "",
      solverProfileId:
        current.solverProfileId || data.solverProfiles[0]?.id || "",
      schedulingProfileId:
        current.schedulingProfileId || data.schedulingProfiles[0]?.id || "",
      outputProfileId:
        current.outputProfileId || data.outputProfiles[0]?.id || "",
      sweepDefinitionId:
        current.sweepDefinitionId || data.sweepDefinitions[0]?.id || "",
      targetScope: current.targetScope || "all",
      targetAirfoilIds: current.targetAirfoilIds ?? [],
    }));
    return data;
  };
  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    setValidationIssues([]);
  }, [tab]);

  const runSave = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitSetupForm = (issues: ValidationIssue[], fn: () => void) => {
    if (issues.length) {
      setValidationIssues(issues);
      focusValidationIssue(issues[0]);
      return;
    }
    setValidationIssues([]);
    fn();
  };

  const validateFlow = () =>
    compactIssues([
      requiredIssue(flowForm.name, "Name"),
      requiredChoiceIssue(flowForm.mediumId, "Medium"),
      positiveIssue(flowForm.temperatureK, "Temperature"),
      positiveIssue(flowForm.pressurePa, "Pressure"),
      positiveIssue(flowForm.speedMps, "Speed"),
    ]);

  const validateReferenceGeometry = () =>
    compactIssues([
      requiredIssue(referenceGeometryForm.name, "Name"),
      requiredChoiceIssue(referenceGeometryForm.geometryType, "Geometry type"),
      requiredChoiceIssue(
        referenceGeometryForm.referenceLengthKind,
        "Reference length kind",
      ),
      positiveIssue(referenceGeometryForm.referenceLengthM, "Reference length"),
      referenceGeometryForm.spanM == null
        ? null
        : nonNegativeIssue(referenceGeometryForm.spanM, "Span"),
      referenceGeometryForm.referenceAreaM2 == null
        ? null
        : nonNegativeIssue(
            referenceGeometryForm.referenceAreaM2,
            "Reference area m^2",
          ),
    ]);

  const validateBoundary = () =>
    compactIssues([
      requiredIssue(boundaryForm.name, "Name"),
      nonNegativeIssue(
        boundaryForm.turbulenceIntensity,
        "Turbulence intensity",
      ),
      positiveIssue(
        boundaryForm.viscosityRatio,
        "Turbulent viscosity ratio νt/ν",
      ),
      nonNegativeIssue(boundaryForm.sandGrainHeight, "Roughness Ks"),
      positiveIssue(boundaryForm.roughnessConstant, "Roughness constant"),
    ]);

  const validateMesh = () =>
    compactIssues([
      requiredIssue(meshForm.name, "Name"),
      requiredChoiceIssue(meshForm.mesher, "Mesher"),
      positiveIssue(meshForm.farfieldRadiusChords, "Farfield"),
      positiveIssue(meshForm.wakeLengthChords, "Wake length"),
      positiveIntegerIssue(meshForm.nSurface, "Surface"),
      positiveIntegerIssue(meshForm.nRadial, "Radial"),
      positiveIntegerIssue(meshForm.nWake, "Wake cells"),
      positiveIssue(meshForm.targetYPlus, "Target y+"),
      positiveIssue(meshForm.spanChords, "Span"),
    ]);

  const validateSolver = () =>
    compactIssues([
      requiredIssue(solverForm.name, "Name"),
      requiredChoiceIssue(
        solverForm.solverImplementationId,
        "Engine implementation",
      ),
      requiredChoiceIssue(solverForm.turbulenceModel, "Turbulence model"),
      positiveIntegerIssue(solverForm.nIterations, "Iterations"),
      positiveIssue(solverForm.convergenceTolerance, "Tolerance"),
      requiredIssue(solverForm.momentumScheme, "Momentum scheme"),
      positiveIntegerIssue(solverForm.transientCycles, "URANS cycles"),
      solverForm.transientDiscardFraction >= 0 &&
      solverForm.transientDiscardFraction < 1
        ? null
        : {
            field: "URANS discard",
            message: "URANS discard must be from 0 to less than 1",
          },
      positiveIssue(solverForm.transientMaxCourant, "URANS max Co"),
    ]);

  const validateScheduling = () =>
    compactIssues([
      requiredIssue(schedulingForm.name, "Name"),
      requiredChoiceIssue(schedulingForm.schedulingPolicy, "CPU policy"),
      optionalPositiveIntegerIssue(schedulingForm.cpuBudget, "CPU budget"),
      optionalPositiveIntegerIssue(
        schedulingForm.caseConcurrency,
        "AoA concurrency",
      ),
      optionalPositiveIntegerIssue(
        schedulingForm.solverProcesses,
        "Solver processes",
      ),
    ]);

  const validateOutput = () =>
    compactIssues([
      requiredIssue(outputForm.name, "Name"),
      positiveIssue(outputForm.imageZoomChords, "Image zoom chords"),
    ]);

  const validateSweep = () => {
    const listText = aoaListText.trim();
    const badList = listText
      ? listText
          .split(",")
          .some((value) => !Number.isFinite(Number(value.trim())))
      : false;
    return compactIssues([
      requiredIssue(sweepForm.name, "Name"),
      sweepForm.aoaStep === 0
        ? { field: "AoA step", message: "AoA step must not be 0" }
        : null,
      badList
        ? {
            field: "Explicit AoA list optional",
            message: "Use comma-separated numeric AoA values",
          }
        : null,
    ]);
  };

  const validatePreset = () =>
    compactIssues([
      requiredIssue(presetForm.name, "Preset name", "Preset name is required"),
      requiredChoiceIssue(presetForm.flowConditionId, "Flow state"),
      requiredChoiceIssue(
        presetForm.referenceGeometryProfileId,
        "Reference geometry",
      ),
      requiredChoiceIssue(presetForm.boundaryProfileId, "Boundary profile"),
      requiredChoiceIssue(presetForm.meshProfileId, "Mesh profile"),
      requiredChoiceIssue(presetForm.solverProfileId, "Solver profile"),
      requiredChoiceIssue(presetForm.schedulingProfileId, "Scheduling profile"),
      requiredChoiceIssue(presetForm.outputProfileId, "Output profile"),
      requiredChoiceIssue(presetForm.sweepDefinitionId, "Sweep definition"),
      presetForm.targetScope === "airfoils" &&
      presetForm.targetAirfoilIds.length === 0
        ? {
            field: "Run scope",
            message: "Select at least one airfoil for selected-profile scope",
          }
        : null,
    ]);

  useEffect(() => {
    if (!validationIssues.length) return;
    const next = (() => {
      if (tab === "presets") return validatePreset();
      if (tab === "flow") return validateFlow();
      if (tab === "referenceGeometry") return validateReferenceGeometry();
      if (tab === "boundary") return validateBoundary();
      if (tab === "mesh") return validateMesh();
      if (tab === "solver") return validateSolver();
      if (tab === "scheduling") return validateScheduling();
      if (tab === "output") return validateOutput();
      return validateSweep();
    })();
    setValidationIssues(next);
  }, [
    tab,
    validationIssues.length,
    flowForm,
    referenceGeometryForm,
    boundaryForm,
    meshForm,
    solverForm,
    schedulingForm,
    outputForm,
    sweepForm,
    presetForm,
    aoaListText,
  ]);

  const selectFlow = (row: AdminFlowCondition) => {
    setFlowId(row.id);
    setFlowForm({
      name: row.name,
      mediumId: row.mediumId,
      temperatureK: row.temperatureK,
      pressurePa: row.pressurePa,
      speedMps: row.speedMps,
    });
  };
  const selectReferenceGeometry = (row: AdminReferenceGeometryProfile) => {
    setReferenceGeometryId(row.id);
    setReferenceGeometryForm({
      name: row.name,
      geometryType: row.geometryType,
      referenceLengthKind: row.referenceLengthKind,
      referenceLengthM: row.referenceLengthM,
      spanM: row.spanM,
      referenceAreaM2: row.referenceAreaM2,
    });
  };
  const selectBoundary = (row: AdminBoundaryProfile) => {
    setBoundaryId(row.id);
    setBoundaryForm({
      name: row.name,
      turbulenceIntensity: row.turbulenceIntensity,
      viscosityRatio: row.viscosityRatio,
      sandGrainHeight: row.sandGrainHeight,
      roughnessConstant: row.roughnessConstant,
    });
  };
  const selectMesh = (row: AdminMeshProfile) => {
    setMeshId(row.id);
    setMeshForm({
      name: row.name,
      mesher: row.mesher,
      farfieldRadiusChords: row.farfieldRadiusChords,
      wakeLengthChords: row.wakeLengthChords,
      nSurface: row.nSurface,
      nRadial: row.nRadial,
      nWake: row.nWake,
      targetYPlus: row.targetYPlus,
      spanChords: row.spanChords,
    });
  };
  const selectSolver = (row: AdminSolverProfile) => {
    setSolverId(row.id);
    setSolverForm({
      name: row.name,
      solverImplementationId: row.solverImplementationId,
      turbulenceModel: row.turbulenceModel,
      nIterations: row.nIterations,
      convergenceTolerance: row.convergenceTolerance,
      momentumScheme: row.momentumScheme,
      transientCycles: row.transientCycles,
      transientDiscardFraction: row.transientDiscardFraction,
      transientMaxCourant: row.transientMaxCourant,
    });
  };
  const selectScheduling = (row: AdminSchedulingProfile) => {
    setSchedulingId(row.id);
    setSchedulingForm({
      name: row.name,
      schedulingPolicy: row.schedulingPolicy,
      cpuBudget: row.cpuBudget,
      caseConcurrency: row.caseConcurrency,
      solverProcesses: row.solverProcesses,
    });
  };
  const selectOutput = (row: AdminOutputProfile) => {
    setOutputId(row.id);
    setOutputForm({
      name: row.name,
      writeImages: row.writeImages,
      imageZoomChords: row.imageZoomChords,
    });
  };
  const selectSweep = (row: AdminSweepDefinition) => {
    setSweepId(row.id);
    setSweepForm({
      name: row.name,
      aoaStart: row.aoaStart,
      aoaStop: row.aoaStop,
      aoaStep: row.aoaStep,
      aoaList: row.aoaList,
    });
    setAoaListText(row.aoaList?.join(", ") ?? "");
  };
  const selectPreset = (row: AdminSimulationPreset) => {
    setPresetId(row.id);
    setPresetForm({
      name: row.name,
      flowConditionId: row.flowConditionId,
      referenceGeometryProfileId: row.referenceGeometryProfileId,
      boundaryProfileId: row.boundaryProfileId,
      meshProfileId: row.meshProfileId,
      solverProfileId: row.solverProfileId,
      schedulingProfileId: row.schedulingProfileId,
      outputProfileId: row.outputProfileId,
      sweepDefinitionId: row.sweepDefinitionId,
      targetScope: row.targetScope,
      targetAirfoilIds: row.targetAirfoilIds,
      enabled: row.enabled,
    });
  };

  const saveFlow = () =>
    runSave(async () => {
      const saved = await createFlowCondition(flowForm);
      setFlowId(saved.id);
      selectFlow(saved);
      await refresh();
    });
  const updateSelectedFlow = () =>
    flowId &&
    runSave(async () => {
      const saved = await updateFlowCondition(flowId, flowForm);
      selectFlow(saved);
      await refresh();
    });
  const removeFlow = (id: string) =>
    runSave(async () => {
      await deleteFlowCondition(id);
      if (flowId === id) {
        setFlowId("");
        setFlowForm(defaultFlowForm(mediumsList[0]));
      }
      await refresh();
    });
  const saveReferenceGeometry = () =>
    runSave(async () => {
      const saved = await createReferenceGeometryProfile(referenceGeometryForm);
      setReferenceGeometryId(saved.id);
      selectReferenceGeometry(saved);
      await refresh();
    });
  const updateSelectedReferenceGeometry = () =>
    referenceGeometryId &&
    runSave(async () => {
      const saved = await updateReferenceGeometryProfile(
        referenceGeometryId,
        referenceGeometryForm,
      );
      selectReferenceGeometry(saved);
      await refresh();
    });
  const removeReferenceGeometry = (id: string) =>
    runSave(async () => {
      await deleteReferenceGeometryProfile(id);
      if (referenceGeometryId === id) {
        setReferenceGeometryId("");
        setReferenceGeometryForm(defaultReferenceGeometryForm());
      }
      await refresh();
    });
  const saveBoundary = () =>
    runSave(async () => {
      const saved = await createBoundaryProfile(boundaryForm);
      setBoundaryId(saved.id);
      selectBoundary(saved);
      await refresh();
    });
  const updateSelectedBoundary = () =>
    boundaryId &&
    runSave(async () => {
      const saved = await updateBoundaryProfile(boundaryId, boundaryForm);
      selectBoundary(saved);
      await refresh();
    });
  const removeBoundary = (id: string) =>
    runSave(async () => {
      await deleteBoundaryProfile(id);
      if (boundaryId === id) {
        setBoundaryId("");
        setBoundaryForm(defaultBoundaryForm());
      }
      await refresh();
    });
  const saveMesh = () =>
    runSave(async () => {
      const saved = await createMeshProfile(meshForm);
      setMeshId(saved.id);
      selectMesh(saved);
      await refresh();
    });
  const updateSelectedMesh = () =>
    meshId &&
    runSave(async () => {
      const saved = await updateMeshProfile(meshId, meshForm);
      selectMesh(saved);
      await refresh();
    });
  const removeMesh = (id: string) =>
    runSave(async () => {
      await deleteMeshProfile(id);
      if (meshId === id) {
        setMeshId("");
        setMeshForm(defaultMeshForm());
      }
      await refresh();
    });
  const saveSolver = () =>
    runSave(async () => {
      const saved = await createSolverProfile(solverForm);
      setSolverId(saved.id);
      selectSolver(saved);
      await refresh();
    });
  const updateSelectedSolver = () =>
    solverId &&
    runSave(async () => {
      const saved = await updateSolverProfile(solverId, solverForm);
      selectSolver(saved);
      await refresh();
    });
  const removeSolver = (id: string) =>
    runSave(async () => {
      await deleteSolverProfile(id);
      if (solverId === id) {
        setSolverId("");
        setSolverForm(
          defaultSolverForm(preferredSolverImplementationId(setup)),
        );
      }
      await refresh();
    });
  const saveScheduling = () =>
    runSave(async () => {
      const saved = await createSchedulingProfile(schedulingForm);
      setSchedulingId(saved.id);
      selectScheduling(saved);
      await refresh();
    });
  const updateSelectedScheduling = () =>
    schedulingId &&
    runSave(async () => {
      const saved = await updateSchedulingProfile(schedulingId, schedulingForm);
      selectScheduling(saved);
      await refresh();
    });
  const removeScheduling = (id: string) =>
    runSave(async () => {
      await deleteSchedulingProfile(id);
      if (schedulingId === id) {
        setSchedulingId("");
        setSchedulingForm(defaultSchedulingForm());
      }
      await refresh();
    });
  const saveOutput = () =>
    runSave(async () => {
      const body = { ...outputForm, writeImages: [...ALL_IMAGE_FIELDS] };
      const saved = await createOutputProfile(body);
      setOutputId(saved.id);
      selectOutput(saved);
      await refresh();
    });
  const updateSelectedOutput = () =>
    outputId &&
    runSave(async () => {
      const body = { ...outputForm, writeImages: [...ALL_IMAGE_FIELDS] };
      const saved = await updateOutputProfile(outputId, body);
      selectOutput(saved);
      await refresh();
    });
  const removeOutput = (id: string) =>
    runSave(async () => {
      await deleteOutputProfile(id);
      if (outputId === id) {
        setOutputId("");
        setOutputForm(defaultOutputForm());
      }
      await refresh();
    });
  const saveSweep = () =>
    runSave(async () => {
      const body = { ...sweepForm, aoaList: parseNumberList(aoaListText) };
      const saved = await createSweepDefinition(body);
      setSweepId(saved.id);
      selectSweep(saved);
      await refresh();
    });
  const updateSelectedSweep = () =>
    sweepId &&
    runSave(async () => {
      const body = { ...sweepForm, aoaList: parseNumberList(aoaListText) };
      const saved = await updateSweepDefinition(sweepId, body);
      selectSweep(saved);
      await refresh();
    });
  const removeSweep = (id: string) =>
    runSave(async () => {
      await deleteSweepDefinition(id);
      if (sweepId === id) {
        setSweepId("");
        setSweepForm(defaultSweepForm());
        setAoaListText("");
      }
      await refresh();
    });
  const savePreset = () =>
    runSave(async () => {
      const saved = await createSimulationPreset(presetForm);
      setPresetId(saved.id);
      selectPreset(saved);
      await refresh();
    });
  const updateSelectedPreset = () =>
    presetId &&
    runSave(async () => {
      const saved = await updateSimulationPreset(presetId, presetForm);
      selectPreset(saved);
      await refresh();
    });

  const tabButton = (item: { k: SetupTab; label: string }) => (
    <button
      key={item.k}
      type="button"
      data-testid={`setup-tab-${item.k}`}
      onClick={() => onTabChange(item.k)}
      style={{
        ...ghostBtn,
        padding: "7px 10px",
        color: tab === item.k ? C.teal : C.muted,
        borderColor: tab === item.k ? C.tealBorder : C.stroke,
        background: tab === item.k ? C.tealFill : C.panel3,
      }}
    >
      {item.label}
    </button>
  );

  return (
    <div>
      <SectionHeader
        title="Setup library"
        subtitle="Reusable setup records compose named presets. Revisions are immutable snapshots used by queue jobs and results."
      />
      {err && <ErrorLine text={err} />}
      <div className="admin-tab-row">{SETUP_TABS.map(tabButton)}</div>
      {tab === "presets" && (
        <div className="admin-editor-grid">
          <SetupRecordListPanel
            title="SIMULATION PRESETS"
            items={setup.simulationPresets}
            selectedId={presetId}
            onSelect={selectPreset}
            onNew={() => {
              setPresetId("");
              setPresetForm(defaultPresetForm(setup));
              setTargetAirfoilQuery("");
            }}
            describe={(p) => {
              const flow = setup.flowConditions.find(
                (row) => row.id === p.flowConditionId,
              );
              const ref = setup.referenceGeometryProfiles.find(
                (row) => row.id === p.referenceGeometryProfileId,
              );
              const re =
                flow && ref
                  ? formatRe(
                      (flow.speedMps * ref.referenceLengthM) /
                        flow.kinematicViscosity,
                    )
                  : "Re";
              const scope =
                p.targetScope === "airfoils"
                  ? `${p.targetAirfoilIds.length} selected`
                  : "all profiles";
              return `${flow?.mediumName ?? "medium"} · ${ref?.referenceLengthKind ?? "reference"} · ${re} · ${scope} · rev ${p.currentRevisionNumber ?? "—"} · ${p.enabled ? "on" : "off"}`;
            }}
            emptyText="No presets yet. Create the component records, then compose a preset here."
            busy={busy}
          />
          <div style={card}>
            <EditorHeader
              text={selectedPreset ? "EDIT PRESET" : "ADD PRESET"}
              onNew={() => {
                setPresetId("");
                setPresetForm(defaultPresetForm(setup));
                setTargetAirfoilQuery("");
              }}
            />
            <TextField
              label="Preset name"
              value={presetForm.name}
              error={issueFor(validationIssues, "Preset name")}
              onChange={(name) => setPresetForm((f) => ({ ...f, name }))}
            />
            <div
              role="status"
              style={{
                border: `1px solid ${C.stroke2}`,
                borderRadius: 8,
                padding: "8px 10px",
                color: C.dim,
                background: C.panel2,
                fontFamily: MONO,
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              {selectedPreset
                ? "Draft changes are not saved automatically. Use update selected preset to persist them."
                : "Draft changes are not saved automatically. Use save new preset to create a preset."}
            </div>
            {!selectedPreset && (
              <TextField
                label="Slug optional"
                value={presetForm.slug ?? ""}
                onChange={(slug) => setPresetForm((f) => ({ ...f, slug }))}
              />
            )}
            <SelectField
              label="Flow state"
              value={presetForm.flowConditionId}
              options={optionValues(setup.flowConditions)}
              optionLabels={optionLabels(setup.flowConditions)}
              error={issueFor(validationIssues, "Flow state")}
              onChange={(flowConditionId) =>
                setPresetForm((f) => ({ ...f, flowConditionId }))
              }
            />
            <SelectField
              label="Reference geometry"
              value={presetForm.referenceGeometryProfileId}
              options={optionValues(setup.referenceGeometryProfiles)}
              optionLabels={optionLabels(setup.referenceGeometryProfiles)}
              error={issueFor(validationIssues, "Reference geometry")}
              onChange={(referenceGeometryProfileId) =>
                setPresetForm((f) => ({ ...f, referenceGeometryProfileId }))
              }
            />
            <SelectField
              label="Boundary profile"
              value={presetForm.boundaryProfileId}
              options={optionValues(setup.boundaryProfiles)}
              optionLabels={optionLabels(setup.boundaryProfiles)}
              error={issueFor(validationIssues, "Boundary profile")}
              onChange={(boundaryProfileId) =>
                setPresetForm((f) => ({ ...f, boundaryProfileId }))
              }
            />
            <SelectField
              label="Mesh profile"
              value={presetForm.meshProfileId}
              options={optionValues(setup.meshProfiles)}
              optionLabels={optionLabels(setup.meshProfiles)}
              error={issueFor(validationIssues, "Mesh profile")}
              onChange={(meshProfileId) =>
                setPresetForm((f) => ({ ...f, meshProfileId }))
              }
            />
            <SelectField
              label="Solver profile"
              value={presetForm.solverProfileId}
              options={optionValues(setup.solverProfiles)}
              optionLabels={optionLabels(setup.solverProfiles)}
              error={issueFor(validationIssues, "Solver profile")}
              onChange={(solverProfileId) =>
                setPresetForm((f) => ({ ...f, solverProfileId }))
              }
            />
            <SelectField
              label="Scheduling profile"
              value={presetForm.schedulingProfileId}
              options={optionValues(setup.schedulingProfiles)}
              optionLabels={optionLabels(setup.schedulingProfiles)}
              error={issueFor(validationIssues, "Scheduling profile")}
              onChange={(schedulingProfileId) =>
                setPresetForm((f) => ({ ...f, schedulingProfileId }))
              }
            />
            <SelectField
              label="Output profile"
              value={presetForm.outputProfileId}
              options={optionValues(setup.outputProfiles)}
              optionLabels={optionLabels(setup.outputProfiles)}
              error={issueFor(validationIssues, "Output profile")}
              onChange={(outputProfileId) =>
                setPresetForm((f) => ({ ...f, outputProfileId }))
              }
            />
            <SelectField
              label="Sweep definition"
              value={presetForm.sweepDefinitionId}
              options={optionValues(setup.sweepDefinitions)}
              optionLabels={optionLabels(setup.sweepDefinitions)}
              error={issueFor(validationIssues, "Sweep definition")}
              onChange={(sweepDefinitionId) =>
                setPresetForm((f) => ({ ...f, sweepDefinitionId }))
              }
            />
            <SelectField
              label="Run scope"
              value={presetForm.targetScope}
              options={["all", "airfoils"]}
              optionLabels={{
                all: "all profiles",
                airfoils: "selected profiles",
              }}
              error={issueFor(validationIssues, "Run scope")}
              onChange={(targetScope) =>
                setPresetForm((f) => ({
                  ...f,
                  targetScope:
                    targetScope as SimulationPresetInput["targetScope"],
                }))
              }
            />
            {presetForm.targetScope === "airfoils" && (
              <PresetAirfoilPicker
                airfoils={setup.airfoilOptions}
                selectedIds={presetForm.targetAirfoilIds}
                query={targetAirfoilQuery}
                onQuery={setTargetAirfoilQuery}
                onChange={(targetAirfoilIds) =>
                  setPresetForm((f) => ({ ...f, targetAirfoilIds }))
                }
              />
            )}
            <SelectField
              label="Enabled"
              value={presetForm.enabled ? "yes" : "no"}
              options={["yes", "no"]}
              onChange={(v) =>
                setPresetForm((f) => ({ ...f, enabled: v === "yes" }))
              }
            />
            <div className="admin-metric-grid" style={{ marginTop: 10 }}>
              <MetricChip
                label="Derived Re"
                value={presetPreview ? formatRe(presetPreview.reynolds) : "—"}
              />
              <MetricChip
                label="Derived Mach"
                value={presetPreview ? f(presetPreview.mach, 3) : "—"}
              />
            </div>
            <ProfileSaveActions
              busy={busy}
              selected={!!selectedPreset}
              noun="simulation preset"
              createLabel="save new simulation preset"
              cloneLabel="save as new simulation preset"
              updateLabel="update selected preset"
              issues={validationIssues}
              onCreate={() => submitSetupForm(validatePreset(), savePreset)}
              onUpdateSelected={() =>
                submitSetupForm(validatePreset(), updateSelectedPreset)
              }
            />
          </div>
        </div>
      )}
      {tab === "flow" && (
        <div className="admin-editor-grid">
          <SetupRecordListPanel
            title="FLOW STATES"
            items={setup.flowConditions}
            selectedId={flowId}
            onSelect={selectFlow}
            onNew={() => {
              setFlowId("");
              setFlowForm(defaultFlowForm(mediumsList[0]));
            }}
            onRemove={(row) => removeFlow(row.id)}
            describe={(o) =>
              `${o.mediumName} · ${fSpeed(o.speedMps)} · M ${f(o.mach, 3)}`
            }
            emptyText="No flow states yet."
            busy={busy}
          />
          <div style={card}>
            <EditorHeader
              text={flowId ? "EDIT FLOW STATE" : "ADD FLOW STATE"}
              onNew={() => {
                setFlowId("");
                setFlowForm(defaultFlowForm(mediumsList[0]));
              }}
            />
            <TextField
              label="Name"
              value={flowForm.name}
              error={issueFor(validationIssues, "Name")}
              onChange={(name) => setFlowForm((f) => ({ ...f, name }))}
            />
            {!flowId && (
              <TextField
                label="Slug optional"
                value={flowForm.slug ?? ""}
                onChange={(slug) => setFlowForm((f) => ({ ...f, slug }))}
              />
            )}
            <SelectField
              label="Medium"
              value={flowForm.mediumId}
              options={mediumsList.map((m) => m.id)}
              optionLabels={Object.fromEntries(
                mediumsList.map((m) => [m.id, m.name]),
              )}
              error={issueFor(validationIssues, "Medium")}
              onChange={(mediumId) => {
                const m = mediumsList.find((item) => item.id === mediumId);
                setFlowForm((f) => ({
                  ...f,
                  mediumId,
                  temperatureK: m?.refTemperatureK ?? f.temperatureK,
                  pressurePa: m?.refPressurePa ?? f.pressurePa,
                }));
              }}
            />
            <div className="admin-form-grid">
              <UnitNumberField
                label="Temperature"
                dimension="temperature"
                valueSi={flowForm.temperatureK}
                min={0}
                error={issueFor(validationIssues, "Temperature")}
                onChangeSi={(temperatureK) =>
                  setFlowForm((f) => ({ ...f, temperatureK }))
                }
              />
              <UnitNumberField
                label="Pressure"
                dimension="pressure"
                valueSi={flowForm.pressurePa}
                min={0}
                error={issueFor(validationIssues, "Pressure")}
                onChangeSi={(pressurePa) =>
                  setFlowForm((f) => ({ ...f, pressurePa }))
                }
              />
              <UnitNumberField
                label="Speed"
                dimension="speed"
                valueSi={flowForm.speedMps}
                min={0}
                error={issueFor(validationIssues, "Speed")}
                onChangeSi={(speedMps) =>
                  setFlowForm((f) => ({ ...f, speedMps }))
                }
              />
            </div>
            <div className="admin-metric-grid" style={{ marginTop: 10 }}>
              <MetricChip
                label="Derived Mach"
                value={flowPreview ? f(flowPreview.mach, 3) : "—"}
              />
              <MetricChip
                label="ρ"
                value={flowPreview ? f(flowPreview.density, 4) : "—"}
              />
              <MetricChip
                label="ν"
                value={
                  flowPreview ? fSci(flowPreview.kinematicViscosity, 2) : "—"
                }
              />
            </div>
            <ProfileSaveActions
              busy={busy}
              selected={!!flowId}
              noun="flow state"
              issues={validationIssues}
              onCreate={() => submitSetupForm(validateFlow(), saveFlow)}
              onUpdateSelected={() =>
                submitSetupForm(validateFlow(), updateSelectedFlow)
              }
            />
          </div>
        </div>
      )}
      {tab === "referenceGeometry" && (
        <div className="admin-editor-grid">
          <SetupRecordListPanel
            title="REFERENCE GEOMETRY"
            items={setup.referenceGeometryProfiles}
            selectedId={referenceGeometryId}
            onSelect={selectReferenceGeometry}
            onNew={() => {
              setReferenceGeometryId("");
              setReferenceGeometryForm(defaultReferenceGeometryForm());
            }}
            onRemove={(row) => removeReferenceGeometry(row.id)}
            describe={(g) =>
              `${g.geometryType} · ${g.referenceLengthKind} ${f(g.referenceLengthM, 3)} m`
            }
            emptyText="No reference geometry profiles yet."
            busy={busy}
          />
          <div style={card}>
            <EditorHeader
              text={
                referenceGeometryId
                  ? "EDIT REFERENCE GEOMETRY"
                  : "ADD REFERENCE GEOMETRY"
              }
              onNew={() => {
                setReferenceGeometryId("");
                setReferenceGeometryForm(defaultReferenceGeometryForm());
              }}
            />
            <TextField
              label="Name"
              value={referenceGeometryForm.name}
              error={issueFor(validationIssues, "Name")}
              onChange={(name) =>
                setReferenceGeometryForm((g) => ({ ...g, name }))
              }
            />
            {!referenceGeometryId && (
              <TextField
                label="Slug optional"
                value={referenceGeometryForm.slug ?? ""}
                onChange={(slug) =>
                  setReferenceGeometryForm((g) => ({ ...g, slug }))
                }
              />
            )}
            {shouldShowSetupOption(
              REFERENCE_GEOMETRY_TYPE_OPTIONS,
              referenceGeometryForm.geometryType,
            ) && (
              <SelectField
                label="Geometry type"
                value={referenceGeometryForm.geometryType}
                options={setupOptionValues(
                  REFERENCE_GEOMETRY_TYPE_OPTIONS,
                  referenceGeometryForm.geometryType,
                )}
                optionLabels={setupOptionLabels(
                  REFERENCE_GEOMETRY_TYPE_OPTIONS,
                  referenceGeometryForm.geometryType,
                )}
                error={issueFor(validationIssues, "Geometry type")}
                onChange={(geometryType) =>
                  setReferenceGeometryForm((g) => ({ ...g, geometryType }))
                }
              />
            )}
            {shouldShowSetupOption(
              REFERENCE_LENGTH_KIND_OPTIONS,
              referenceGeometryForm.referenceLengthKind,
            ) && (
              <SelectField
                label="Reference length kind"
                value={referenceGeometryForm.referenceLengthKind}
                options={setupOptionValues(
                  REFERENCE_LENGTH_KIND_OPTIONS,
                  referenceGeometryForm.referenceLengthKind,
                )}
                optionLabels={setupOptionLabels(
                  REFERENCE_LENGTH_KIND_OPTIONS,
                  referenceGeometryForm.referenceLengthKind,
                )}
                error={issueFor(validationIssues, "Reference length kind")}
                onChange={(referenceLengthKind) =>
                  setReferenceGeometryForm((g) => ({
                    ...g,
                    referenceLengthKind,
                  }))
                }
              />
            )}
            <div className="admin-form-grid">
              <UnitNumberField
                label="Reference length"
                dimension="length"
                valueSi={referenceGeometryForm.referenceLengthM}
                min={0}
                error={issueFor(validationIssues, "Reference length")}
                onChangeSi={(referenceLengthM) =>
                  setReferenceGeometryForm((g) => ({ ...g, referenceLengthM }))
                }
              />
              <UnitNumberField
                label="Span"
                dimension="length"
                valueSi={referenceGeometryForm.spanM ?? 0}
                min={0}
                error={issueFor(validationIssues, "Span")}
                onChangeSi={(spanM) =>
                  setReferenceGeometryForm((g) => ({
                    ...g,
                    spanM: spanM > 0 ? spanM : null,
                  }))
                }
              />
              <NumberField
                label="Reference area m^2"
                value={referenceGeometryForm.referenceAreaM2 ?? 0}
                error={issueFor(validationIssues, "Reference area m^2")}
                onChange={(referenceAreaM2) =>
                  setReferenceGeometryForm((g) => ({
                    ...g,
                    referenceAreaM2:
                      referenceAreaM2 > 0 ? referenceAreaM2 : null,
                  }))
                }
              />
            </div>
            <ProfileSaveActions
              busy={busy}
              selected={!!referenceGeometryId}
              noun="reference geometry"
              issues={validationIssues}
              onCreate={() =>
                submitSetupForm(
                  validateReferenceGeometry(),
                  saveReferenceGeometry,
                )
              }
              onUpdateSelected={() =>
                submitSetupForm(
                  validateReferenceGeometry(),
                  updateSelectedReferenceGeometry,
                )
              }
            />
          </div>
        </div>
      )}
      {tab === "boundary" && (
        <ProfileEditorShell
          title="BOUNDARY PROFILES"
          items={setup.boundaryProfiles}
          selectedId={boundaryId}
          onSelect={selectBoundary}
          onNew={() => {
            setBoundaryId("");
            setBoundaryForm(defaultBoundaryForm());
          }}
          onRemove={(row) => removeBoundary(row.id)}
          describe={(b) =>
            `Tu ${f(b.turbulenceIntensity, 4)} · νt/ν ${f(b.viscosityRatio, 1)}`
          }
          emptyText="No boundary profiles yet."
          busy={busy}
        >
          <EditorHeader
            text={boundaryId ? "EDIT BOUNDARY PROFILE" : "ADD BOUNDARY PROFILE"}
            onNew={() => {
              setBoundaryId("");
              setBoundaryForm(defaultBoundaryForm());
            }}
          />
          <TextField
            label="Name"
            value={boundaryForm.name}
            error={issueFor(validationIssues, "Name")}
            onChange={(name) => setBoundaryForm((f) => ({ ...f, name }))}
          />
          {!boundaryId && (
            <TextField
              label="Slug optional"
              value={boundaryForm.slug ?? ""}
              onChange={(slug) => setBoundaryForm((f) => ({ ...f, slug }))}
            />
          )}
          <div className="admin-form-grid">
            <NumberField
              label="Turbulence intensity"
              value={boundaryForm.turbulenceIntensity}
              error={issueFor(validationIssues, "Turbulence intensity")}
              onChange={(turbulenceIntensity) =>
                setBoundaryForm((f) => ({ ...f, turbulenceIntensity }))
              }
            />
            <TurbulentViscosityRatioField
              value={boundaryForm.viscosityRatio}
              error={issueFor(
                validationIssues,
                "Turbulent viscosity ratio νt/ν",
              )}
              onChange={(viscosityRatio) =>
                setBoundaryForm((f) => ({ ...f, viscosityRatio }))
              }
            />
            <NumberField
              label="Roughness Ks"
              value={boundaryForm.sandGrainHeight}
              error={issueFor(validationIssues, "Roughness Ks")}
              onChange={(sandGrainHeight) =>
                setBoundaryForm((f) => ({ ...f, sandGrainHeight }))
              }
            />
            <NumberField
              label="Roughness constant"
              value={boundaryForm.roughnessConstant}
              error={issueFor(validationIssues, "Roughness constant")}
              onChange={(roughnessConstant) =>
                setBoundaryForm((f) => ({ ...f, roughnessConstant }))
              }
            />
          </div>
          <ProfileSaveActions
            busy={busy}
            selected={!!boundaryId}
            noun="boundary profile"
            issues={validationIssues}
            onCreate={() => submitSetupForm(validateBoundary(), saveBoundary)}
            onUpdateSelected={() =>
              submitSetupForm(validateBoundary(), updateSelectedBoundary)
            }
          />
        </ProfileEditorShell>
      )}
      {tab === "mesh" && (
        <div style={{ display: "grid", gap: 16 }}>
          <MeshSettingsGuide
            form={meshForm}
            onChange={(patch) => setMeshForm((f) => ({ ...f, ...patch }))}
          />
          <div className="admin-editor-grid">
            <SetupRecordListPanel
              title="MESH PROFILES"
              items={setup.meshProfiles}
              selectedId={meshId}
              onSelect={selectMesh}
              onNew={() => {
                setMeshId("");
                setMeshForm(defaultMeshForm());
              }}
              onRemove={(row) => removeMesh(row.id)}
              describe={(m) =>
                `${m.mesher} · ${m.nSurface}/${m.nRadial}/${m.nWake}`
              }
              emptyText="No mesh profiles yet."
              busy={busy}
            />
            <div style={card}>
              <EditorHeader
                text={meshId ? "EDIT MESH PROFILE" : "ADD MESH PROFILE"}
                onNew={() => {
                  setMeshId("");
                  setMeshForm(defaultMeshForm());
                }}
              />
              <TextField
                label="Name"
                value={meshForm.name}
                error={issueFor(validationIssues, "Name")}
                onChange={(name) => setMeshForm((f) => ({ ...f, name }))}
              />
              {!meshId && (
                <TextField
                  label="Slug optional"
                  value={meshForm.slug ?? ""}
                  onChange={(slug) => setMeshForm((f) => ({ ...f, slug }))}
                />
              )}
              {shouldShowSetupOption(MESH_MESHER_OPTIONS, meshForm.mesher) && (
                <SelectField
                  label="Mesher"
                  value={meshForm.mesher}
                  options={setupOptionValues(
                    MESH_MESHER_OPTIONS,
                    meshForm.mesher,
                  )}
                  optionLabels={setupOptionLabels(
                    MESH_MESHER_OPTIONS,
                    meshForm.mesher,
                  )}
                  error={issueFor(validationIssues, "Mesher")}
                  onChange={(mesher) => setMeshForm((f) => ({ ...f, mesher }))}
                />
              )}
              <ProfileSaveActions
                busy={busy}
                selected={!!meshId}
                noun="mesh profile"
                issues={validationIssues}
                onCreate={() => submitSetupForm(validateMesh(), saveMesh)}
                onUpdateSelected={() =>
                  submitSetupForm(validateMesh(), updateSelectedMesh)
                }
              />
            </div>
          </div>
        </div>
      )}
      {tab === "solver" && (
        <ProfileEditorShell
          title="SOLVER PROFILES"
          items={setup.solverProfiles}
          selectedId={solverId}
          onSelect={selectSolver}
          onNew={() => {
            setSolverId("");
            setSolverForm(
              defaultSolverForm(preferredSolverImplementationId(setup)),
            );
          }}
          onRemove={(row) => removeSolver(row.id)}
          describe={(s) =>
            `${s.implementation ? solverImplementationLabel(s.implementation) : "engine unavailable"} · ${s.turbulenceModel} · ${s.nIterations} iters · ${s.transientCycles} cycles`
          }
          emptyText="No solver profiles yet."
          busy={busy}
        >
          <EditorHeader
            text={solverId ? "EDIT SOLVER PROFILE" : "ADD SOLVER PROFILE"}
            onNew={() => {
              setSolverId("");
              setSolverForm(
                defaultSolverForm(preferredSolverImplementationId(setup)),
              );
            }}
          />
          <TextField
            label="Name"
            value={solverForm.name}
            error={issueFor(validationIssues, "Name")}
            onChange={(name) => setSolverForm((f) => ({ ...f, name }))}
          />
          {!solverId && (
            <TextField
              label="Slug optional"
              value={solverForm.slug ?? ""}
              onChange={(slug) => setSolverForm((f) => ({ ...f, slug }))}
            />
          )}
          <div className="admin-form-grid">
            <SelectField
              label="Engine implementation"
              value={solverForm.solverImplementationId}
              options={[
                "",
                ...solverImplementationOptions.map(
                  (implementation) => implementation.id,
                ),
              ]}
              optionLabels={solverImplementationOptionLabels}
              error={issueFor(validationIssues, "Engine implementation")}
              onChange={(solverImplementationId) =>
                setSolverForm((form) => ({
                  ...form,
                  solverImplementationId,
                }))
              }
            />
            <SelectField
              label="Turbulence model"
              value={solverForm.turbulenceModel}
              options={[
                "kOmegaSST",
                "kOmegaSSTLM",
                "kOmega",
                "kEpsilon",
                "SpalartAllmaras",
              ]}
              error={issueFor(validationIssues, "Turbulence model")}
              onChange={(turbulenceModel) =>
                setSolverForm((f) => ({ ...f, turbulenceModel }))
              }
            />
            <NumberField
              label="Iterations"
              value={solverForm.nIterations}
              error={issueFor(validationIssues, "Iterations")}
              onChange={(nIterations) =>
                setSolverForm((f) => ({ ...f, nIterations }))
              }
            />
            <NumberField
              label="Tolerance"
              value={solverForm.convergenceTolerance}
              error={issueFor(validationIssues, "Tolerance")}
              onChange={(convergenceTolerance) =>
                setSolverForm((f) => ({ ...f, convergenceTolerance }))
              }
            />
            <SelectField
              label="Momentum scheme"
              value={solverForm.momentumScheme}
              {...momentumSchemeSelect(solverForm.momentumScheme)}
              error={issueFor(validationIssues, "Momentum scheme")}
              onChange={(momentumScheme) =>
                setSolverForm((f) => ({ ...f, momentumScheme }))
              }
            />
            <NumberField
              label="URANS cycles"
              value={solverForm.transientCycles}
              error={issueFor(validationIssues, "URANS cycles")}
              onChange={(transientCycles) =>
                setSolverForm((f) => ({ ...f, transientCycles }))
              }
            />
            <NumberField
              label="URANS discard"
              value={solverForm.transientDiscardFraction}
              error={issueFor(validationIssues, "URANS discard")}
              onChange={(transientDiscardFraction) =>
                setSolverForm((f) => ({ ...f, transientDiscardFraction }))
              }
            />
            <NumberField
              label="URANS max Co"
              value={solverForm.transientMaxCourant}
              error={issueFor(validationIssues, "URANS max Co")}
              onChange={(transientMaxCourant) =>
                setSolverForm((f) => ({ ...f, transientMaxCourant }))
              }
            />
          </div>
          <ProfileSaveActions
            busy={busy}
            selected={!!solverId}
            noun="solver profile"
            issues={validationIssues}
            onCreate={() => submitSetupForm(validateSolver(), saveSolver)}
            onUpdateSelected={() =>
              submitSetupForm(validateSolver(), updateSelectedSolver)
            }
          />
        </ProfileEditorShell>
      )}
      {tab === "scheduling" && (
        <ProfileEditorShell
          title="SCHEDULING PROFILES"
          items={setup.schedulingProfiles}
          selectedId={schedulingId}
          onSelect={selectScheduling}
          onNew={() => {
            setSchedulingId("");
            setSchedulingForm(defaultSchedulingForm());
          }}
          onRemove={(row) => removeScheduling(row.id)}
          describe={(s) =>
            schedulingSummary({
              schedulingPolicy: s.schedulingPolicy,
              cpuBudget: s.cpuBudget,
              caseConcurrency: s.caseConcurrency,
              solverProcesses: s.solverProcesses,
            })
          }
          emptyText="No scheduling profiles yet."
          busy={busy}
        >
          <EditorHeader
            text={
              schedulingId
                ? "EDIT SCHEDULING PROFILE"
                : "ADD SCHEDULING PROFILE"
            }
            onNew={() => {
              setSchedulingId("");
              setSchedulingForm(defaultSchedulingForm());
            }}
          />
          <TextField
            label="Name"
            value={schedulingForm.name}
            error={issueFor(validationIssues, "Name")}
            onChange={(name) => setSchedulingForm((f) => ({ ...f, name }))}
          />
          {!schedulingId && (
            <TextField
              label="Slug optional"
              value={schedulingForm.slug ?? ""}
              onChange={(slug) => setSchedulingForm((f) => ({ ...f, slug }))}
            />
          )}
          <div className="admin-form-grid">
            <SelectField
              label="CPU policy"
              value={schedulingForm.schedulingPolicy}
              options={[
                "auto",
                "airfoil_parallel",
                "case_parallel",
                "exclusive",
              ]}
              optionLabels={{
                auto: "auto",
                airfoil_parallel: "airfoil parallel",
                case_parallel: "case parallel",
                exclusive: "exclusive",
              }}
              error={issueFor(validationIssues, "CPU policy")}
              onChange={(schedulingPolicy) =>
                setSchedulingForm((f) => ({
                  ...f,
                  schedulingPolicy:
                    schedulingPolicy as SchedulingProfileInput["schedulingPolicy"],
                }))
              }
            />
            <OptionalNumberField
              label="CPU budget"
              value={schedulingForm.cpuBudget}
              error={issueFor(validationIssues, "CPU budget")}
              onChange={(cpuBudget) =>
                setSchedulingForm((f) => ({ ...f, cpuBudget }))
              }
            />
            <OptionalNumberField
              label="AoA concurrency"
              value={schedulingForm.caseConcurrency}
              error={issueFor(validationIssues, "AoA concurrency")}
              onChange={(caseConcurrency) =>
                setSchedulingForm((f) => ({ ...f, caseConcurrency }))
              }
            />
            <OptionalNumberField
              label="Solver processes"
              value={schedulingForm.solverProcesses}
              error={issueFor(validationIssues, "Solver processes")}
              onChange={(solverProcesses) =>
                setSchedulingForm((f) => ({ ...f, solverProcesses }))
              }
            />
          </div>
          <ProfileSaveActions
            busy={busy}
            selected={!!schedulingId}
            noun="scheduling profile"
            issues={validationIssues}
            onCreate={() =>
              submitSetupForm(validateScheduling(), saveScheduling)
            }
            onUpdateSelected={() =>
              submitSetupForm(validateScheduling(), updateSelectedScheduling)
            }
          />
        </ProfileEditorShell>
      )}
      {tab === "output" && (
        <ProfileEditorShell
          title="OUTPUT PROFILES"
          items={setup.outputProfiles}
          selectedId={outputId}
          onSelect={selectOutput}
          onNew={() => {
            setOutputId("");
            setOutputForm(defaultOutputForm());
          }}
          onRemove={(row) => removeOutput(row.id)}
          describe={(o) =>
            `${ALL_IMAGE_FIELDS.length} default fields · zoom ${f(o.imageZoomChords, 1)}c`
          }
          emptyText="No output profiles yet."
          busy={busy}
        >
          <EditorHeader
            text={outputId ? "EDIT OUTPUT PROFILE" : "ADD OUTPUT PROFILE"}
            onNew={() => {
              setOutputId("");
              setOutputForm(defaultOutputForm());
            }}
          />
          <TextField
            label="Name"
            value={outputForm.name}
            error={issueFor(validationIssues, "Name")}
            onChange={(name) => setOutputForm((f) => ({ ...f, name }))}
          />
          {!outputId && (
            <TextField
              label="Slug optional"
              value={outputForm.slug ?? ""}
              onChange={(slug) => setOutputForm((f) => ({ ...f, slug }))}
            />
          )}
          <div className="admin-field-panel">
            <div className="label">Default stored fields</div>
            <div className="field-chip-grid">
              {ALL_IMAGE_FIELDS.map((field) => (
                <span key={field} className="field-chip">
                  {IMAGE_FIELD_LABELS[field] ?? field}
                </span>
              ))}
            </div>
          </div>
          <NumberField
            label="Image zoom chords"
            value={outputForm.imageZoomChords}
            error={issueFor(validationIssues, "Image zoom chords")}
            onChange={(imageZoomChords) =>
              setOutputForm((f) => ({ ...f, imageZoomChords }))
            }
          />
          <ProfileSaveActions
            busy={busy}
            selected={!!outputId}
            noun="output profile"
            issues={validationIssues}
            onCreate={() => submitSetupForm(validateOutput(), saveOutput)}
            onUpdateSelected={() =>
              submitSetupForm(validateOutput(), updateSelectedOutput)
            }
          />
        </ProfileEditorShell>
      )}
      {tab === "sweeps" && (
        <ProfileEditorShell
          title="SWEEP DEFINITIONS"
          items={setup.sweepDefinitions}
          selectedId={sweepId}
          onSelect={selectSweep}
          onNew={() => {
            setSweepId("");
            setSweepForm(defaultSweepForm());
            setAoaListText("");
          }}
          onRemove={(row) => removeSweep(row.id)}
          describe={(s) =>
            s.aoaList?.length
              ? `${s.aoaList.length} listed AoAs`
              : `${aoaSpan(s.aoaStart, s.aoaStop)} step ${s.aoaStep}`
          }
          emptyText="No sweep definitions yet."
          busy={busy}
        >
          <EditorHeader
            text={sweepId ? "EDIT SWEEP DEFINITION" : "ADD SWEEP DEFINITION"}
            onNew={() => {
              setSweepId("");
              setSweepForm(defaultSweepForm());
              setAoaListText("");
            }}
          />
          <TextField
            label="Name"
            value={sweepForm.name}
            error={issueFor(validationIssues, "Name")}
            onChange={(name) => setSweepForm((f) => ({ ...f, name }))}
          />
          {!sweepId && (
            <TextField
              label="Slug optional"
              value={sweepForm.slug ?? ""}
              onChange={(slug) => setSweepForm((f) => ({ ...f, slug }))}
            />
          )}
          <div className="admin-form-grid">
            <NumberField
              label="AoA start"
              value={sweepForm.aoaStart}
              error={issueFor(validationIssues, "AoA start")}
              onChange={(aoaStart) => setSweepForm((f) => ({ ...f, aoaStart }))}
            />
            <NumberField
              label="AoA stop"
              value={sweepForm.aoaStop}
              error={issueFor(validationIssues, "AoA stop")}
              onChange={(aoaStop) => setSweepForm((f) => ({ ...f, aoaStop }))}
            />
            <NumberField
              label="AoA step"
              value={sweepForm.aoaStep}
              error={issueFor(validationIssues, "AoA step")}
              onChange={(aoaStep) => setSweepForm((f) => ({ ...f, aoaStep }))}
            />
          </div>
          <TextField
            label="Explicit AoA list optional"
            value={aoaListText}
            error={issueFor(validationIssues, "Explicit AoA list optional")}
            onChange={setAoaListText}
          />
          <ProfileSaveActions
            busy={busy}
            selected={!!sweepId}
            noun="sweep definition"
            issues={validationIssues}
            onCreate={() => submitSetupForm(validateSweep(), saveSweep)}
            onUpdateSelected={() =>
              submitSetupForm(validateSweep(), updateSelectedSweep)
            }
          />
        </ProfileEditorShell>
      )}
      {tab === "mediums" && <MediumsPanel />}
    </div>
  );
}

function EditorHeader({ text, onNew }: { text: string; onNew: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <div style={label}>{text}</div>
      <button
        type="button"
        onClick={onNew}
        style={{ ...ghostBtn, padding: "5px 8px", fontSize: 10 }}
      >
        new
      </button>
    </div>
  );
}

function ProfileSaveActions({
  busy,
  selected,
  noun,
  createLabel,
  cloneLabel,
  updateLabel,
  issues,
  onCreate,
  onUpdateSelected,
}: {
  busy: boolean;
  selected: boolean;
  noun: string;
  createLabel?: string;
  cloneLabel?: string;
  updateLabel?: string;
  issues?: ValidationIssue[];
  onCreate: () => void;
  onUpdateSelected?: () => void;
}) {
  const primaryLabel = selected
    ? (cloneLabel ?? `save as new ${noun}`)
    : (createLabel ?? `add ${noun}`);
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <ValidationSummary issues={issues ?? []} />
      <button
        type="button"
        disabled={busy}
        onClick={onCreate}
        style={{ ...primaryBtn(busy), width: "100%" }}
      >
        {busy ? "saving…" : primaryLabel}
      </button>
      {selected && onUpdateSelected && (
        <button
          type="button"
          disabled={busy}
          onClick={onUpdateSelected}
          style={{
            ...ghostBtn,
            width: "100%",
            color: C.amber,
            opacity: busy ? 0.6 : 1,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {updateLabel ?? `update selected ${noun}`}
        </button>
      )}
    </div>
  );
}

function ProfileEditorShell<T extends { id: string; name: string }>({
  title,
  items,
  selectedId,
  onSelect,
  onNew,
  onRemove,
  describe,
  emptyText,
  busy,
  children,
}: {
  title: string;
  items: T[];
  selectedId: string;
  onSelect: (item: T) => void;
  onNew: () => void;
  onRemove?: (item: T) => void;
  describe: (item: T) => string;
  emptyText: string;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <div className="admin-editor-grid">
      <SetupRecordListPanel
        title={title}
        items={items}
        selectedId={selectedId}
        onSelect={onSelect}
        onNew={onNew}
        onRemove={onRemove}
        describe={describe}
        emptyText={emptyText}
        busy={busy}
      />
      <div style={card}>{children}</div>
    </div>
  );
}

function PresetAirfoilPicker({
  airfoils,
  selectedIds,
  query,
  onQuery,
  onChange,
}: {
  airfoils: AdminAirfoilOption[];
  selectedIds: string[];
  query: string;
  onQuery: (value: string) => void;
  onChange: (ids: string[]) => void;
}) {
  const selected = new Set(selectedIds);
  const q = query.trim().toLowerCase();
  const visible = (airfoils ?? [])
    .filter(
      (airfoil) =>
        !q ||
        airfoil.name.toLowerCase().includes(q) ||
        airfoil.slug.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        Number(selected.has(b.id)) - Number(selected.has(a.id)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 80);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
      <label
        style={{
          display: "grid",
          gap: 5,
          fontFamily: MONO,
          fontSize: 11,
          color: C.dim,
        }}
      >
        <span>
          Profiles{" "}
          <span
            data-testid="preset-airfoil-selected-count"
            style={{ color: C.teal }}
          >
            {selectedIds.length} selected
          </span>
        </span>
        <input
          data-testid="preset-airfoil-search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="search profiles..."
          style={inputStyle}
        />
      </label>
      <div
        data-testid="preset-airfoil-picker"
        style={{
          maxHeight: 210,
          overflow: "auto",
          display: "grid",
          gap: 5,
          border: `1px solid ${C.stroke}`,
          borderRadius: 8,
          padding: 8,
        }}
      >
        {visible.length === 0 ? (
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
            no profiles match
          </span>
        ) : (
          visible.map((airfoil) => {
            const checked = selected.has(airfoil.id);
            return (
              <button
                key={airfoil.id}
                type="button"
                data-testid={`preset-airfoil-option-${airfoil.slug}`}
                onClick={() => toggle(airfoil.id)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "18px minmax(0, 1fr)",
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
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    border: `1px solid ${checked ? C.teal : C.dim}`,
                    background: checked ? C.teal : "transparent",
                  }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {airfoil.name}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

const SYNC_DATA_TYPE_LABELS: Record<AdminSyncPermission["dataType"], string> = {
  sweeps: "Sweeps",
  airfoils: "Airfoils",
  catalog_metadata: "Catalog metadata",
  mediums: "Mediums",
  simulation_setup: "Simulation setup",
  polars: "Polars",
  evidence_artifacts: "Evidence artifacts",
  result_media: "Result media",
};

type SyncDraft = {
  enabled: boolean;
  instanceName: string;
  publicEndpointOverride: string;
  secret: string;
  defaultPromiseTtlHours: number;
  upstreamBaseUrl: string;
  upstreamSecret: string;
  syncMode: "full" | "db_only_remote_assets";
  remoteSolverEnabled: boolean;
  remoteSolverCpuBudget: number;
  remoteSolverClaimSize: number;
  remoteSolverHeartbeatIntervalSeconds: number;
  permissions: AdminSyncPermission[];
};

function syncDraftFromState(state: AdminSyncState): SyncDraft {
  return {
    enabled: state.settings.enabled,
    instanceName: state.settings.instanceName,
    publicEndpointOverride: state.settings.publicEndpointOverride ?? "",
    secret: state.settings.secret,
    defaultPromiseTtlHours: state.settings.defaultPromiseTtlHours,
    upstreamBaseUrl: state.settings.upstreamBaseUrl ?? "",
    upstreamSecret: state.settings.upstreamSecret ?? "",
    syncMode: state.settings.syncMode,
    remoteSolverEnabled: state.settings.remoteSolverEnabled,
    remoteSolverCpuBudget: state.settings.remoteSolverCpuBudget,
    remoteSolverClaimSize: state.settings.remoteSolverClaimSize,
    remoteSolverHeartbeatIntervalSeconds:
      state.settings.remoteSolverHeartbeatIntervalSeconds,
    permissions: state.permissions.map((permission) => ({ ...permission })),
  };
}

function SyncApiPanel() {
  const [state, setState] = useState<AdminSyncState | null>(null);
  const [draft, setDraft] = useState<SyncDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>(
    [],
  );

  const refresh = useCallback(async () => {
    const next = await getAdminSync();
    setState(next);
    setDraft(syncDraftFromState(next));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, [refresh]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const next = await patchAdminSync({
        enabled: draft.enabled,
        instanceName: draft.instanceName.trim() || "XFoilFOAM instance",
        publicEndpointOverride: draft.publicEndpointOverride.trim() || null,
        secret: draft.secret,
        defaultPromiseTtlHours: Number(draft.defaultPromiseTtlHours),
        upstreamBaseUrl: draft.upstreamBaseUrl.trim() || null,
        upstreamSecret: draft.upstreamSecret,
        syncMode: draft.syncMode,
        remoteSolverEnabled: draft.remoteSolverEnabled,
        remoteSolverCpuBudget: Number(draft.remoteSolverCpuBudget),
        remoteSolverClaimSize: Number(draft.remoteSolverClaimSize),
        remoteSolverHeartbeatIntervalSeconds: Number(
          draft.remoteSolverHeartbeatIntervalSeconds,
        ),
        permissions: draft.permissions,
      });
      setState(next);
      setDraft(syncDraftFromState(next));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const validateUpstream = () =>
    compactIssues([
      requiredIssue(
        draft?.upstreamBaseUrl,
        "Up-tier endpoint",
        "Up-tier endpoint is required",
      ),
    ]);

  useEffect(() => {
    if (validationIssues.length) setValidationIssues(validateUpstream());
  }, [draft?.upstreamBaseUrl, validationIssues.length]);

  const runMirror = async (mode?: "full" | "db_only_remote_assets") => {
    const issues = validateUpstream();
    if (issues.length) {
      setValidationIssues(issues);
      focusValidationIssue(issues[0]);
      return;
    }
    setValidationIssues([]);
    setBusy(true);
    setErr(null);
    try {
      const next = await runUpstreamSync({
        mode: mode ?? draft?.syncMode,
        limit: 200,
      });
      setState(next);
      setDraft(syncDraftFromState(next));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updatePermission = (
    dataType: AdminSyncPermission["dataType"],
    patch: Partial<Pick<AdminSyncPermission, "canFetch" | "canPush">>,
  ) => {
    setDraft(
      (current) =>
        current && {
          ...current,
          permissions: current.permissions.map((permission) =>
            permission.dataType === dataType
              ? { ...permission, ...patch }
              : permission,
          ),
        },
    );
  };

  const resolveConflict = async (id: string, action: "archive" | "promote") => {
    setBusy(true);
    setErr(null);
    try {
      const next =
        action === "archive"
          ? await archiveSyncConflict(id)
          : await promoteSyncConflict(id);
      setState(next);
      setDraft(syncDraftFromState(next));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const endpoint = state?.settings.publicEndpoint ?? "";
  return (
    <div>
      <SectionHeader
        title="Sync API"
        subtitle="Cross-instance claims, imports, and evidence exchange."
      />
      {err && <ErrorLine text={err} />}
      {!draft || !state ? (
        <div style={card}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>
            Loading sync settings…
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={card}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: 12,
                alignItems: "start",
              }}
            >
              <div>
                <div style={label}>INBOUND API</div>
                <a
                  href={`${endpoint}/status`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    color: C.teal,
                    fontFamily: MONO,
                    fontSize: 12,
                    wordBreak: "break-all",
                  }}
                >
                  {endpoint}
                </a>
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.dim,
                  }}
                >
                  instance {state.settings.instanceId}
                </div>
              </div>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: MONO,
                  fontSize: 12,
                  color: draft.enabled ? C.teal : C.muted,
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) =>
                    setDraft(
                      (current) =>
                        current && { ...current, enabled: e.target.checked },
                    )
                  }
                />
                enabled
              </label>
            </div>
            <div className="admin-form-grid" style={{ marginTop: 12 }}>
              <TextField
                label="Instance name"
                value={draft.instanceName}
                onChange={(instanceName) =>
                  setDraft((current) => current && { ...current, instanceName })
                }
              />
              <TextField
                label="Secret"
                value={draft.secret}
                onChange={(secret) =>
                  setDraft((current) => current && { ...current, secret })
                }
              />
              <TextField
                label="Public endpoint override"
                value={draft.publicEndpointOverride}
                onChange={(publicEndpointOverride) =>
                  setDraft(
                    (current) =>
                      current && { ...current, publicEndpointOverride },
                  )
                }
              />
              <NumberField
                label="Promise TTL hours"
                value={draft.defaultPromiseTtlHours}
                onChange={(defaultPromiseTtlHours) =>
                  setDraft(
                    (current) =>
                      current && { ...current, defaultPromiseTtlHours },
                  )
                }
              />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={save}
              style={{ ...primaryBtn(busy), marginTop: 12 }}
            >
              {busy ? "saving…" : "save sync settings"}
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 0.85fr)",
              gap: 14,
            }}
          >
            <div style={card}>
              <div style={label}>UP-TIER CONNECTION</div>
              <div className="admin-form-grid">
                <TextField
                  label="Up-tier endpoint"
                  value={draft.upstreamBaseUrl}
                  error={issueFor(validationIssues, "Up-tier endpoint")}
                  onChange={(upstreamBaseUrl) =>
                    setDraft(
                      (current) => current && { ...current, upstreamBaseUrl },
                    )
                  }
                />
                <TextField
                  label="Up-tier secret"
                  value={draft.upstreamSecret}
                  onChange={(upstreamSecret) =>
                    setDraft(
                      (current) => current && { ...current, upstreamSecret },
                    )
                  }
                />
                <SelectField
                  label="Sync mode"
                  value={draft.syncMode}
                  options={["full", "db_only_remote_assets"]}
                  optionLabels={{
                    full: "full DB + media",
                    db_only_remote_assets: "DB + remote media refs",
                  }}
                  onChange={(syncMode) =>
                    setDraft(
                      (current) =>
                        current && {
                          ...current,
                          syncMode: syncMode as SyncDraft["syncMode"],
                        },
                    )
                  }
                />
                <NumberField
                  label="Remote solver CPUs"
                  value={draft.remoteSolverCpuBudget}
                  onChange={(remoteSolverCpuBudget) =>
                    setDraft(
                      (current) =>
                        current && { ...current, remoteSolverCpuBudget },
                    )
                  }
                />
                <NumberField
                  label="Claim size"
                  value={draft.remoteSolverClaimSize}
                  onChange={(remoteSolverClaimSize) =>
                    setDraft(
                      (current) =>
                        current && { ...current, remoteSolverClaimSize },
                    )
                  }
                />
                <NumberField
                  label="Heartbeat seconds"
                  value={draft.remoteSolverHeartbeatIntervalSeconds}
                  onChange={(remoteSolverHeartbeatIntervalSeconds) =>
                    setDraft(
                      (current) =>
                        current && {
                          ...current,
                          remoteSolverHeartbeatIntervalSeconds,
                        },
                    )
                  }
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <ValidationSummary issues={validationIssues} />
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 12,
                }}
              >
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => runMirror("db_only_remote_assets")}
                  style={{
                    ...ghostBtn,
                    padding: "8px 10px",
                    opacity: busy ? 0.6 : 1,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  sync DB + remote refs
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => runMirror("full")}
                  style={{
                    ...ghostBtn,
                    padding: "8px 10px",
                    opacity: busy ? 0.6 : 1,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                >
                  full sync
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={save}
                  style={{ ...primaryBtn(busy) }}
                >
                  save connection
                </button>
              </div>
            </div>
            <div style={card}>
              <div style={label}>REMOTE SOLVER</div>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: MONO,
                  fontSize: 12,
                  color: draft.remoteSolverEnabled ? C.teal : C.muted,
                }}
              >
                <input
                  type="checkbox"
                  checked={draft.remoteSolverEnabled}
                  onChange={(e) =>
                    setDraft(
                      (current) =>
                        current && {
                          ...current,
                          remoteSolverEnabled: e.target.checked,
                        },
                    )
                  }
                />
                enabled
              </label>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  marginTop: 12,
                  fontFamily: MONO,
                  fontSize: 12,
                }}
              >
                <MetricChip
                  label="Status"
                  value={state.settings.remoteSolverLastStatus}
                />
                <MetricChip
                  label="Registered id"
                  value={
                    state.settings.remoteSolverRegisteredId?.slice(0, 8) ?? "—"
                  }
                />
                <MetricChip
                  label="Last sync"
                  value={ago(state.settings.remoteSolverLastSyncAt)}
                />
                <MetricChip
                  label="Last claim"
                  value={ago(state.settings.remoteSolverLastPromiseAt)}
                />
                <MetricChip
                  label="Last push"
                  value={ago(state.settings.remoteSolverLastPushAt)}
                />
              </div>
              {state.settings.remoteSolverLastError && (
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: MONO,
                    fontSize: 11,
                    color: C.redText,
                  }}
                >
                  {state.settings.remoteSolverLastError}
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.7fr)",
              gap: 14,
            }}
          >
            <div style={card}>
              <div style={label}>PERMISSIONS</div>
              <div style={{ display: "grid", gap: 6 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(130px, 1fr) 72px 72px",
                    gap: 8,
                    fontFamily: MONO,
                    fontSize: 10,
                    color: C.dim,
                  }}
                >
                  <span>Data</span>
                  <span>Fetch</span>
                  <span>Push</span>
                </div>
                {draft.permissions.map((permission) => (
                  <div
                    key={permission.dataType}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(130px, 1fr) 72px 72px",
                      gap: 8,
                      alignItems: "center",
                      borderTop: `1px solid ${C.borderSoft}`,
                      paddingTop: 7,
                    }}
                  >
                    <span
                      style={{ fontFamily: MONO, fontSize: 12, color: C.text }}
                    >
                      {SYNC_DATA_TYPE_LABELS[permission.dataType]}
                    </span>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontFamily: MONO,
                        fontSize: 11,
                        color: C.dim,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={permission.canFetch}
                        onChange={(e) =>
                          updatePermission(permission.dataType, {
                            canFetch: e.target.checked,
                          })
                        }
                      />
                      allow
                    </label>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontFamily: MONO,
                        fontSize: 11,
                        color: C.dim,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={permission.canPush}
                        onChange={(e) =>
                          updatePermission(permission.dataType, {
                            canPush: e.target.checked,
                          })
                        }
                      />
                      allow
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div style={card}>
              <div style={label}>PROMISES</div>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  fontFamily: MONO,
                  fontSize: 12,
                }}
              >
                {["active", "fulfilled", "expired", "cancelled"].map(
                  (status) => (
                    <div
                      key={status}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        borderBottom: `1px solid ${C.borderSoft}`,
                        paddingBottom: 7,
                      }}
                    >
                      <span style={{ color: C.dim }}>{status}</span>
                      <span
                        style={{ color: status === "active" ? C.teal : C.text }}
                      >
                        {state.promises.byStatus[status] ?? 0} ·{" "}
                        {state.promises.pointsByStatus[status] ?? 0} AoAs
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 0.5fr)",
              gap: 14,
            }}
          >
            <div style={card}>
              <div style={label}>REGISTERED REMOTE SOLVERS</div>
              {state.registeredSolvers.length === 0 ? (
                <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>
                  No remote solvers have registered.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {state.registeredSolvers.map((solver) => (
                    <div
                      key={solver.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) auto",
                        gap: 10,
                        alignItems: "center",
                        borderTop: `1px solid ${C.borderSoft}`,
                        paddingTop: 8,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            flexWrap: "wrap",
                            fontFamily: MONO,
                          }}
                        >
                          <strong style={{ color: C.text, fontSize: 12 }}>
                            {solver.instanceName}
                          </strong>
                          <span
                            style={{
                              color:
                                solver.status === "error"
                                  ? C.redText
                                  : solver.status === "solving" ||
                                      solver.status === "pushing"
                                    ? C.amber
                                    : C.teal,
                              fontSize: 11,
                            }}
                          >
                            {solver.status}
                          </span>
                          <span style={{ color: C.dim, fontSize: 10 }}>
                            heartbeat {ago(solver.lastHeartbeatAt)}
                          </span>
                        </div>
                        <div
                          style={{
                            marginTop: 4,
                            fontFamily: MONO,
                            fontSize: 10,
                            color: C.dim,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {solver.publicEndpoint ??
                            solver.localEndpoint ??
                            solver.instanceId}
                        </div>
                        {solver.recentError && (
                          <div
                            style={{
                              marginTop: 4,
                              fontFamily: MONO,
                              fontSize: 10,
                              color: C.redText,
                            }}
                          >
                            {solver.recentError}
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 11,
                          color: C.muted,
                          textAlign: "right",
                        }}
                      >
                        <div>
                          {solver.cpuBudget}/{solver.cpuCapacity} CPU
                        </div>
                        <div>
                          {solver.activePromiseCount} promises ·{" "}
                          {solver.activeAoaCount} AoAs
                        </div>
                        <div>
                          {solver.solvedCount} solved · {solver.pushedCount}{" "}
                          pushed
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={card}>
              <div style={label}>REMOTE ASSETS</div>
              <div
                style={{
                  display: "grid",
                  gap: 8,
                  fontFamily: MONO,
                  fontSize: 12,
                }}
              >
                {["remote_only", "cached", "missing", "failed"].map(
                  (status) => (
                    <div
                      key={status}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        borderBottom: `1px solid ${C.borderSoft}`,
                        paddingBottom: 7,
                      }}
                    >
                      <span style={{ color: C.dim }}>
                        {status.replace(/_/g, " ")}
                      </span>
                      <span
                        style={{
                          color:
                            status === "failed" || status === "missing"
                              ? C.redText
                              : status === "cached"
                                ? C.teal
                                : C.text,
                        }}
                      >
                        {state.remoteAssets.byAvailability[status] ?? 0}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          </div>

          <div style={card}>
            <div style={label}>IMPORT CONFLICTS</div>
            {state.conflicts.length === 0 ? (
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>
                No pending remote-import conflicts.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {state.conflicts.map((conflict) => (
                  <div
                    key={conflict.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      gap: 10,
                      alignItems: "start",
                      border: `1px solid ${C.borderSoft}`,
                      borderRadius: 8,
                      padding: 10,
                    }}
                  >
                    <div style={{ minWidth: 0, fontFamily: MONO }}>
                      <div
                        style={{ color: C.text, fontSize: 12, fontWeight: 700 }}
                      >
                        {SYNC_DATA_TYPE_LABELS[conflict.dataType]} ·{" "}
                        {conflict.naturalKey}
                      </div>
                      <div style={{ marginTop: 4, color: C.dim, fontSize: 10 }}>
                        {conflict.sourceInstanceName ??
                          conflict.sourceInstanceId ??
                          "remote instance"}{" "}
                        · {ago(conflict.createdAt)}
                      </div>
                      <div
                        style={{
                          marginTop: 7,
                          color: C.dimmest,
                          fontSize: 10,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        incoming{" "}
                        {Object.keys(conflict.incomingPayload ?? {})
                          .slice(0, 8)
                          .join(", ") || "payload"}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        justifyContent: "flex-end",
                      }}
                    >
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => resolveConflict(conflict.id, "promote")}
                        style={{
                          ...ghostBtn,
                          color: C.amber,
                          padding: "6px 9px",
                          fontSize: 10,
                        }}
                      >
                        promote
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => resolveConflict(conflict.id, "archive")}
                        style={{
                          ...ghostBtn,
                          padding: "6px 9px",
                          fontSize: 10,
                        }}
                      >
                        archive
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QueueDashboard({
  tab,
  onTabChange,
  onOpenCampaign,
  onOpenSimulations,
  onOpenPoints,
}: {
  tab: SolverTab;
  onTabChange: (t: SolverTab) => void;
  onOpenCampaign: (id: string) => void;
  onOpenSimulations: () => void;
  onOpenPoints: (campaignId: string, status: CampaignPointsBucket) => void;
}) {
  const [queue, setQueue] = useState<AdminQueue | null>(null);
  const [engineSetup, setEngineSetup] = useState<AdminSimulationSetup | null>(
    null,
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [maintenanceNotice, setMaintenanceNotice] = useState<string | null>(
    null,
  );
  const [purgePrefix, setPurgePrefix] = useState("pw-");
  // Finished-job-log open state is URL-owned (?flog=1, spec §11 "search
  // params are the single source of truth"): a native <details> keeps its
  // state only in the DOM, so browser-back from an evidence link used to
  // land on a re-collapsed log. replaceState (same shallow mechanism as the
  // console's navigate()) keeps history clean — no entry per toggle.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const finishedLogOpen = isFinishedLogOpen(searchParams.toString());
  const onFinishedLogToggle = useCallback(
    (e: SyntheticEvent<HTMLDetailsElement>) => {
      const next = withFinishedLogParam(
        window.location.search,
        e.currentTarget.open,
      );
      if (next === (window.location.search || "")) return;
      window.history.replaceState(null, "", `${pathname}${next}`);
    },
    [pathname],
  );
  // Solved-points viewer (screen 5). Its state lives HERE — outside the queue
  // payload — so the 10 s poll can update badge counts and job cards without
  // yanking an open popover shut; the popover fetches its own rows on open.
  const [solvedPopover, setSolvedPopover] = useState<{
    jobId: string | null;
    label: string | null;
    anchor: SolvedPopoverAnchor;
  } | null>(null);
  const openSolvedPopover = useCallback(
    (jobId: string | null, label: string | null, rect: DOMRect) => {
      setSolvedPopover({
        jobId,
        label,
        anchor: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        },
      });
    },
    [],
  );
  const refreshingRef = useRef(false);
  // The poll always fetches the ACTIVE tab's scope (spec §10/§12); the ref
  // keeps the callback stable so usePoll's interval is not reset by tab moves.
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      let scope = solverScopeForTab(tabRef.current);
      // Loop guard: if the user switches tabs while a fetch is in flight, the
      // just-fetched scope may no longer match the active tab — fetch again
      // instead of leaving the new tab stale for a full poll interval.
      // scope=null (Points tab): the explorer owns its own fetches — no queue
      // traffic at all while it is open.
      while (scope) {
        const next = await (consumeQueuePrefetch(scope) ??
          getAdminQueue(scope));
        setQueue((prev) => mergeAdminQueue(prev, next));
        setErr(null);
        const active = solverScopeForTab(tabRef.current);
        if (active === scope) break;
        scope = active;
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  // Shared admin poll: paused while document.hidden, immediate refetch on
  // visibility resume (spec §11). Poll covers only the active tab's scope.
  usePoll(refresh, 10000);

  // Immediate fetch when the user switches tabs, so the newly opened tab's
  // sections are not up to a poll interval stale.
  useEffect(() => {
    void refresh();
  }, [tab, refresh]);

  useEffect(() => {
    if (tab !== "engine") return;
    getAdminSimulationSetup()
      .then(setEngineSetup)
      .catch((e) => setErr((e as Error).message));
  }, [tab]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sw = queue?.sweeper;
  const pendingSweeps = queue?.pendingSweeps ?? [];
  const externalPromises = queue?.externalPromises ?? [];
  const activeJobs = queue?.activeJobs ?? [];
  const finishedJobs = queue?.finishedJobs ?? [];
  const failed = queue?.results?.failed ?? 0;
  const staleCount = activeJobs.filter((job) => job.stale).length;
  const engineQueue = queue?.engineQueue;
  const duplicateCount = Object.keys(engineQueue?.duplicates ?? {}).length;
  const detachedCount = activeJobs.filter(
    (job) =>
      job.runtimeState === "detached_running" ||
      (job.processCount > 0 && !job.engineQueueMatch),
  ).length;
  const pendingSweepsTotal = queue?.pendingSweepsTotal ?? 0;

  // ONE derivation feeds the banner, the empty states, and the control
  // gating — the same module the hub / campaign surfaces use (lib/solver-state).
  const engineHealthy =
    !!queue?.engineHealth &&
    queue.engineHealth.status === "ok" &&
    !queue.engineHealthError;
  // Gap-fill counters may be null before the first scan (served from cache
  // with computedAt); unknown must not read as "backlog closed".
  const pendingPointsKnown =
    queue?.pendingPointsTotal ?? queue?.backlog ?? null;
  const backlogOpen = queue
    ? (pendingPointsKnown != null && pendingPointsKnown > 0) ||
      (queue.backlogStrip?.campaigns.some((c) => c.remainingPoints > 0) ??
        false)
    : undefined;
  // Campaign points currently solving (sum of the backlog strip's per-campaign
  // runningPoints) — already in the activity payload, no extra fetch. null
  // until the strip arrives: the banner then labels the job count "engine
  // jobs" instead of inventing a points number (unit-label truth, 2026-07-06).
  const campaignPointsSolving = queue?.backlogStrip
    ? queue.backlogStrip.campaigns.reduce((sum, c) => sum + c.runningPoints, 0)
    : null;
  const solver = deriveSolverState({
    fetchOk: queue != null,
    heartbeatAt: sw?.heartbeatAt ?? null,
    enabled: sw?.enabled ?? false,
    engineUnreachableSince: queue?.engineUnreachableSince ?? null,
    engineHealthy,
    engineBuildMismatch: queue?.engineBuildMismatch ?? false,
    engineQueueError: !!queue?.engineQueueError,
    activeJobCount: queue ? activeJobs.length : undefined,
    campaignPointsSolving,
    backlogOpen,
    // Tick-progress pair (liveness/progress split): a fresh heartbeat with a
    // >5 min unfinished tick derives the amber TICK STALLED banner instead of
    // a false red PROCESS NOT RUNNING (2026-07-06 prod incident).
    lastTickStartedAt: sw?.lastTickStartedAt ?? null,
    lastTickCompletedAt: sw?.lastTickCompletedAt ?? null,
    diskAdmissionBlocked: sw?.diskAdmissionBlocked ?? false,
    diskAdmissionReason: sw?.diskAdmissionReason ?? null,
    diskUsedPct: sw?.diskUsedPct ?? null,
    diskFreeBytes: sw?.diskFreeBytes ?? null,
    diskRequiredFreeBytes: sw?.diskRequiredFreeBytes ?? null,
    diskCheckedAt: sw?.diskCheckedAt ?? null,
  });
  const processDead = solver.state === "process_not_running";
  const toneColor =
    solver.tone === "red"
      ? C.redText
      : solver.tone === "amber"
        ? C.amber
        : C.teal;
  const toneDot =
    solver.tone === "red" ? C.red : solver.tone === "amber" ? C.amber : C.teal;
  const toneBorder =
    solver.tone === "red"
      ? "rgba(245, 101, 101, 0.34)"
      : solver.tone === "amber"
        ? "rgba(245, 165, 36, 0.38)"
        : C.tealBorder;
  const toneFill =
    solver.tone === "red"
      ? "rgba(245, 101, 101, 0.08)"
      : solver.tone === "amber"
        ? "rgba(245, 165, 36, 0.07)"
        : C.tealFill;

  const toggleEnginePool = (pool: AdminSolverExecutionPool) =>
    void act(async () => {
      await updateSolverExecutionPool(pool.id, { enabled: !pool.enabled });
      setEngineSetup(await getAdminSimulationSetup());
    });

  const purgeArtifacts = () => {
    const prefix = purgePrefix.trim();
    if (!prefix) return;
    if (
      !window.confirm(
        `Purge all test artifacts with prefix "${prefix}"? Matching rows are deleted permanently.`,
      )
    )
      return;
    void act(async () => {
      const res = await purgeTestArtifacts(prefix);
      const entries = Object.entries(res.purged).filter(([, n]) => n > 0);
      const total = entries.reduce((sum, [, n]) => sum + n, 0);
      setMaintenanceNotice(
        total > 0
          ? `purged ${total.toLocaleString()} row${total === 1 ? "" : "s"} — ${entries.map(([k, n]) => `${k} ${n}`).join(", ")}`
          : `nothing matched prefix "${prefix}"`,
      );
    });
  };

  return (
    <div data-testid="openfoam-queue-page">
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Solver</h2>
      </div>

      <div className="admin-tab-row">
        {SOLVER_TABS.map((item) => (
          <button
            key={item.k}
            type="button"
            data-testid={`solver-tab-${item.k}`}
            aria-pressed={tab === item.k}
            onClick={() => onTabChange(item.k)}
            style={{
              ...ghostBtn,
              padding: "7px 10px",
              color: tab === item.k ? C.teal : C.muted,
              borderColor: tab === item.k ? C.tealBorder : C.stroke,
              background: tab === item.k ? C.tealFill : C.panel3,
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {err && (
        <div
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.red,
            marginBottom: 12,
          }}
        >
          {err}
        </div>
      )}

      {tab === "activity" && (
        <div style={{ display: "grid", gap: 14 }}>
          {/* ---- solver banner: THE single truth line (deriveSolverState) ---- */}
          <section
            data-testid="solver-banner"
            style={{
              background: toneFill,
              border: `1px solid ${toneBorder}`,
              borderRadius: 10,
              padding: "12px 14px",
              display: "grid",
              gap: 7,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <span
                data-testid="sweeper-process-state"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  fontFamily: MONO,
                  fontSize: 12,
                  color: toneColor,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: toneDot,
                    animation:
                      solver.state === "running"
                        ? "recpulse 1.6s infinite"
                        : "none",
                  }}
                />
                {solverStateLabel(solver.state)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.text }}>
                {solver.headline}
              </span>
              {/* Solved-points badge (screen 5): real count of results solved
                  since the start of the server day; hidden at 0. */}
              {(queue?.solvedToday ?? 0) > 0 && (
                <button
                  type="button"
                  data-testid="solved-today-badge"
                  title="View the most recent solved points across all jobs"
                  onClick={(e) =>
                    openSolvedPopover(
                      null,
                      null,
                      e.currentTarget.getBoundingClientRect(),
                    )
                  }
                  style={{
                    marginLeft: "auto",
                    fontFamily: MONO,
                    fontSize: 10.5,
                    color: C.teal,
                    background: C.tealFill,
                    border: `1px solid ${C.tealBorder}`,
                    borderRadius: 999,
                    padding: "4px 10px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {queue!.solvedToday!.toLocaleString()} solved today ▾
                </button>
              )}
            </div>
            {solver.detail && (
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10.5,
                  color: toneColor,
                  lineHeight: 1.5,
                }}
              >
                {solver.detail}
              </div>
            )}
            {solver.secondary.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {solver.secondary.map((s) => (
                  <span
                    key={s}
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      color: C.amber,
                      border: `1px solid ${C.stroke}`,
                      borderRadius: 999,
                      padding: "2px 8px",
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* ---- controls: Pause/Resume + CPU slots. When the process is not
                running, Pause/Resume would be fake controls (and a Start
                button would be a lie — the web app cannot start an OS
                process), so guidance text renders instead. ---- */}
          {sw && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              {processDead ? (
                <span
                  data-testid="solver-controls-guidance"
                  style={{ fontFamily: MONO, fontSize: 10.5, color: C.redText }}
                >
                  Pause/Resume is unavailable while the solver process is down.
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(() => patchSweeper({ enabled: !sw.enabled }))
                  }
                  style={{
                    ...(sw.enabled ? ghostBtn : primaryBtn(busy)),
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                  }}
                >
                  {sw.enabled ? <Pause size={14} /> : <Play size={14} />}
                  {sw.enabled ? "Pause" : "Resume"}
                </button>
              )}
              <div
                data-admin-field="Solver CPU slots"
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                  Solver CPU slots
                </span>
                <CpuSlotsStepper
                  value={sw.cpuSlots}
                  disabled={busy}
                  onChange={(n) => act(() => patchSweeper({ cpuSlots: n }))}
                />
              </div>
            </div>
          )}

          {/* ---- at most two attention chips ---- */}
          {(failed > 0 || pendingSweepsTotal > 0) && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {failed > 0 && (
                <button
                  type="button"
                  data-testid="attention-inspect-failed"
                  onClick={() => onTabChange("points")}
                  style={{
                    ...ghostBtn,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    color: C.amber,
                    borderColor: "rgba(245, 165, 36, 0.45)",
                    padding: "6px 11px",
                    fontSize: 11,
                  }}
                >
                  {failed.toLocaleString()} failed result
                  {failed === 1 ? "" : "s"} · inspect evidence
                </button>
              )}
              {pendingSweepsTotal > 0 && (
                <button
                  type="button"
                  data-testid="attention-background-pending"
                  onClick={() => onTabChange("background")}
                  style={{ ...ghostBtn, padding: "6px 11px", fontSize: 11 }}
                >
                  {pendingSweepsTotal.toLocaleString()} background sweep
                  {pendingSweepsTotal === 1 ? "" : "s"} pending · view
                  Background
                </button>
              )}
            </div>
          )}

          {queue?.backlogStrip && (
            <CampaignBacklogStrip
              strip={queue.backlogStrip}
              gate={gateFromSolverState(solver.state)}
              onOpenCampaign={onOpenCampaign}
              onOpenSimulations={onOpenSimulations}
              onOpenPoints={onOpenPoints}
            />
          )}

          <QueuePanel
            title="Active jobs"
            count={queue ? `${activeJobs.length}` : undefined}
            testId="queue-active-jobs"
          >
            {!queue ? (
              <EmptyQueueLine text="Loading active solver jobs…" />
            ) : activeJobs.length === 0 ? (
              <EmptyQueueLine
                text={
                  processDead
                    ? `No active jobs — the solver process is not running (${queue.sweeper.heartbeatAt ? `last heartbeat ${ago(queue.sweeper.heartbeatAt)}` : "no heartbeat ever recorded"}), so nothing can be submitted.`
                    : queue.sweeper.enabled
                      ? "No active jobs. The sweeper is running and will submit the next pending case on its coming tick."
                      : "No active jobs. Resume the sweeper to submit pending cases."
                }
              />
            ) : (
              <div
                style={{ display: "grid", gap: 10, padding: "10px 16px 16px" }}
              >
                {activeJobs.map((job) => (
                  <ActiveJobCard
                    key={job.id}
                    job={job}
                    busy={busy}
                    onCancel={() => act(() => cancelJob(job.id))}
                    onOpenCampaign={onOpenCampaign}
                    onOpenSolved={openSolvedPopover}
                  />
                ))}
              </div>
            )}
          </QueuePanel>

          <details
            data-testid="queue-finished-jobs"
            open={finishedLogOpen}
            onToggle={onFinishedLogToggle}
            style={{ ...card, padding: 0, borderRadius: 8, overflow: "hidden" }}
          >
            <summary
              style={{
                cursor: "pointer",
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  color: C.text,
                }}
              >
                Finished job log
              </span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                {queue ? `${finishedJobs.length} latest` : "…"}
              </span>
            </summary>
            <div style={{ borderTop: `1px solid ${C.borderSoft}` }}>
              {!queue ? (
                <EmptyQueueLine text="Loading finished jobs…" />
              ) : finishedJobs.length === 0 ? (
                <EmptyQueueLine text="No finished jobs yet. Completed, failed, and cancelled engine jobs will appear here." />
              ) : (
                <div
                  style={{
                    display: "grid",
                    gap: 10,
                    padding: "10px 16px 16px",
                  }}
                >
                  {finishedJobs.slice(0, 8).map((job) => (
                    <FinishedJobCard
                      key={job.id}
                      job={job}
                      onOpenCampaign={onOpenCampaign}
                      onOpenSolved={openSolvedPopover}
                    />
                  ))}
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {tab === "background" && (
        <div style={{ display: "grid", gap: 14 }}>
          <QueuePanel
            title="Pending sweeps"
            count={
              queue
                ? `${pendingSweeps.length} of ${pendingSweepsTotal}`
                : undefined
            }
            testId="queue-pending-sweeps"
          >
            {!queue ? (
              <EmptyQueueLine text="Loading pending CFD sweeps…" />
            ) : pendingSweeps.length === 0 ? (
              <EmptyQueueLine text="No pending sweeps. The enabled boundary-condition set is fully solved." />
            ) : (
              <div className="admin-table-scroll">
                <div style={{ minWidth: PENDING_TABLE_MIN_WIDTH }}>
                  <TableHead
                    columns={PENDING_COLUMNS}
                    labels={[
                      "Airfoil",
                      "Type",
                      "CPU",
                      "Speed",
                      "Re",
                      "AoA",
                      "Condition",
                      "State",
                    ]}
                  />
                  {pendingSweeps.map((p) => (
                    <PendingSweepRow
                      key={`${p.airfoilId}-${p.bcId}-${p.kind}`}
                      item={p}
                    />
                  ))}
                </div>
              </div>
            )}
          </QueuePanel>

          <QueuePanel
            title="Externally promised"
            count={queue ? `${externalPromises.length}` : undefined}
            testId="queue-external-promises"
          >
            {!queue ? (
              <EmptyQueueLine text="Loading external sync promises…" />
            ) : externalPromises.length === 0 ? (
              <EmptyQueueLine text="No active external promises. Local sweeper owns all currently pending work." />
            ) : (
              <div
                style={{ display: "grid", gap: 8, padding: "10px 16px 16px" }}
              >
                {externalPromises.map((promise) => (
                  <div
                    key={promise.id}
                    style={{
                      border: `1px solid ${C.borderSoft}`,
                      borderRadius: 8,
                      padding: 10,
                      fontFamily: MONO,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Link
                        href={`/airfoils/${promise.airfoilSlug}`}
                        style={{
                          minWidth: 0,
                          color: C.text,
                          textDecoration: "none",
                          fontSize: 12,
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {promise.airfoilName}
                      </Link>
                      <span style={{ color: C.amber, fontSize: 10 }}>
                        {agoFromSeconds(
                          Math.max(
                            0,
                            (new Date(
                              promise.expiresAt ?? Date.now(),
                            ).getTime() -
                              Date.now()) /
                              1000,
                          ),
                        )}{" "}
                        left
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                        marginTop: 7,
                        fontSize: 10,
                        color: C.dim,
                      }}
                    >
                      <span>
                        {promise.aoaCount} AoAs ·{" "}
                        {aoaSpan(promise.aoaMin, promise.aoaMax)}
                      </span>
                      <span>Re {formatRe(promise.reynolds)}</span>
                      <span>
                        {promise.sourceInstanceName ??
                          promise.sourceInstanceId ??
                          "remote instance"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </QueuePanel>
        </div>
      )}

      {tab === "engine" && (
        <div style={{ display: "grid", gap: 14 }}>
          <section
            data-testid="solver-engine-inventory"
            style={{ ...card, padding: 14, borderRadius: 8 }}
          >
            <div style={label}>SOLVER IMPLEMENTATIONS</div>
            {!engineSetup ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                loading registered engines…
              </div>
            ) : selectableSolverImplementations(engineSetup).length === 0 ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                No active solver implementations are registered.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 9 }}>
                {selectableSolverImplementations(engineSetup).map(
                  (implementation) => {
                    const pools = engineSetup.solverExecutionPools.filter(
                      (pool) =>
                        pool.solverImplementationId === implementation.id,
                    );
                    const profileCount = engineSetup.solverProfiles.filter(
                      (profile) =>
                        profile.solverImplementationId === implementation.id,
                    ).length;
                    return (
                      <div
                        key={implementation.id}
                        data-testid={`solver-implementation-${implementation.distribution}-${implementation.releaseVersion}`}
                        style={{
                          borderTop: `1px solid ${C.borderSoft}`,
                          paddingTop: 9,
                          display: "grid",
                          gap: 7,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            flexWrap: "wrap",
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontFamily: MONO,
                                fontSize: 12,
                                color: C.text,
                                fontWeight: 700,
                              }}
                            >
                              {solverImplementationLabel(implementation)}
                            </div>
                            <div
                              style={{
                                marginTop: 3,
                                fontFamily: MONO,
                                fontSize: 10,
                                color: C.dim,
                              }}
                            >
                              {implementation.methodFamily.replace(/_/g, " ")} ·
                              numerics {implementation.numericsRevision} ·{" "}
                              {profileCount} profile
                              {profileCount === 1 ? "" : "s"}
                              {implementation.licenseSpdx
                                ? ` · ${implementation.licenseSpdx}`
                                : ""}
                            </div>
                          </div>
                        </div>
                        {pools.length === 0 ? (
                          <div
                            style={{
                              fontFamily: MONO,
                              fontSize: 10.5,
                              color: C.amber,
                            }}
                          >
                            No execution pool is registered for this engine.
                          </div>
                        ) : (
                          pools.map((pool) => (
                            <div
                              key={pool.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 10,
                                flexWrap: "wrap",
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: MONO,
                                  fontSize: 10.5,
                                  color: pool.enabled ? C.teal : C.dim,
                                }}
                              >
                                {pool.name} · route {pool.routingKey} ·{" "}
                                {pool.enabled ? "enabled" : "disabled"}
                              </span>
                              <button
                                type="button"
                                aria-label={`${pool.enabled ? "Disable" : "Enable"} ${solverImplementationLabel(implementation)} execution pool`}
                                disabled={busy}
                                onClick={() => toggleEnginePool(pool)}
                                style={{
                                  ...ghostBtn,
                                  padding: "5px 9px",
                                  fontSize: 10,
                                  color: pool.enabled ? C.amber : C.teal,
                                  opacity: busy ? 0.6 : 1,
                                }}
                              >
                                {pool.enabled ? "disable pool" : "enable pool"}
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    );
                  },
                )}
                <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                  Enabling a pool performs a live capability check. Start its
                  worker image and enable its gateway adapter before activation.
                </div>
              </div>
            )}
          </section>

          <section
            data-testid="engine-identity"
            style={{ ...card, padding: 14, borderRadius: 8 }}
          >
            <div style={label}>SOLVER GATEWAY</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                fontFamily: MONO,
                fontSize: 11,
                color: C.dim,
              }}
            >
              <span>url {queue?.engineUrl ?? "…"}</span>
              {queue?.engineHealth && (
                <span
                  title={queue.engineHealth.package_file ?? undefined}
                  style={{
                    color: queue.engineBuildMismatch ? C.redText : C.dim,
                    border: `1px solid ${queue.engineBuildMismatch ? C.redText : C.stroke}`,
                    borderRadius: 5,
                    padding: "2px 7px",
                  }}
                >
                  build{" "}
                  {queue.engineHealth.build_id ?? queue.engineHealth.version}
                  {queue.engineBuildMismatch
                    ? ` expected ${queue.engineExpectedBuildId}`
                    : ""}
                </span>
              )}
              {queue && (
                <span
                  style={{
                    color: engineHealthy ? C.teal : C.amber,
                    border: `1px solid ${engineHealthy ? C.tealBorder : C.stroke}`,
                    borderRadius: 5,
                    padding: "2px 7px",
                  }}
                >
                  {engineHealthy
                    ? "health ok"
                    : queue.engineUnreachableSince
                      ? `unreachable since ${new Date(queue.engineUnreachableSince).toLocaleTimeString()}`
                      : "health degraded"}
                </span>
              )}
              {queue?.engineHealthError && (
                <span style={{ color: C.amber }}>
                  health probe: {queue.engineHealthError.slice(0, 100)}
                </span>
              )}
            </div>
          </section>

          <section
            data-testid="engine-celery"
            style={{ ...card, padding: 14, borderRadius: 8 }}
          >
            <div style={label}>CELERY INTROSPECTION</div>
            {!queue ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                loading…
              </div>
            ) : queue.engineQueueError ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.redText }}>
                unavailable · {queue.engineQueueError.slice(0, 160)}
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gap: 6,
                  fontFamily: MONO,
                  fontSize: 11,
                  color: C.text,
                }}
              >
                <span>
                  {engineQueue?.queue_depth ?? "—"} queued ·{" "}
                  {engineQueue?.active_count ?? 0} active ·{" "}
                  {engineQueue?.reserved_count ?? 0} reserved ·{" "}
                  {engineQueue?.scheduled_count ?? 0} scheduled
                </span>
                {(duplicateCount > 0 ||
                  (engineQueue?.redelivered.length ?? 0) > 0) && (
                  <span style={{ color: C.redText }}>
                    {duplicateCount} duplicate job IDs ·{" "}
                    {engineQueue?.redelivered.length ?? 0} redelivered tasks
                  </span>
                )}
                <span style={{ color: C.dim, fontSize: 10 }}>
                  {queue.inFlight ?? "—"} db jobs in flight · {detachedCount}{" "}
                  detached runner{detachedCount === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </section>

          <section
            data-testid="engine-cache-card"
            style={{ ...card, padding: 14, borderRadius: 8 }}
          >
            <div style={label}>MESH / SEED CACHE</div>
            {!queue ? (
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                loading…
              </div>
            ) : queue.engineCache != null ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                  gap: 8,
                }}
              >
                <MetricChip
                  label="Mesh entries"
                  value={queue.engineCache.meshEntries.toLocaleString()}
                />
                <MetricChip
                  label="Seed entries"
                  value={queue.engineCache.seedEntries.toLocaleString()}
                />
                <MetricChip
                  label="Size"
                  value={`${formatBytes(queue.engineCache.totalBytes)} of ${formatBytes(queue.engineCache.capBytes)}`}
                />
                <MetricChip
                  label="Oldest last-used"
                  value={
                    queue.engineCache.oldestLastUsedAt
                      ? ago(queue.engineCache.oldestLastUsedAt)
                      : "—"
                  }
                />
              </div>
            ) : (
              // Never invented numbers: the card says why the data is missing.
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
                cache stats unavailable — engine endpoint unreachable or not
                deployed
              </div>
            )}
          </section>

          <section
            data-testid="engine-maintenance"
            style={{
              ...card,
              padding: 14,
              borderRadius: 8,
              display: "grid",
              gap: 10,
            }}
          >
            <div style={label}>MAINTENANCE</div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                data-testid="engine-recover-stale"
                disabled={busy || staleCount === 0}
                onClick={() => act(() => recoverStaleJobs())}
                style={{
                  ...ghostBtn,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  color: staleCount > 0 ? C.redText : C.dim,
                  opacity: busy || staleCount === 0 ? 0.6 : 1,
                }}
              >
                <ShieldAlert size={14} />
                recover stale ({staleCount})
              </button>
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                re-queues jobs whose engine runtime disappeared · enabled only
                while stale jobs exist
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "end",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <label
                style={{ display: "block", width: 140 }}
                data-admin-field="Purge prefix"
              >
                <div style={miniLabel}>Purge prefix</div>
                <input
                  aria-label="Purge prefix"
                  value={purgePrefix}
                  onChange={(e) => setPurgePrefix(e.target.value)}
                  style={inputStyle}
                />
              </label>
              <button
                type="button"
                data-testid="engine-purge-artifacts"
                disabled={busy || !purgePrefix.trim()}
                onClick={purgeArtifacts}
                style={{
                  ...ghostBtn,
                  color: C.redText,
                  borderColor: "rgba(245, 101, 101, 0.45)",
                  opacity: busy || !purgePrefix.trim() ? 0.6 : 1,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                  }}
                >
                  <Trash2 size={14} />
                  purge test artifacts
                </span>
              </button>
            </div>
            {maintenanceNotice && (
              <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.amber }}>
                {maintenanceNotice}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Point History Explorer (fourth tab): owns its data — the queue poll
          is fully suspended while it is open (solverScopeForTab → null). */}
      {tab === "points" && <PointHistoryPanel />}

      {/* Solved-points viewer (screen 5): keyed by scope so switching between
          the page badge and a job chip remounts with a fresh first page. */}
      {solvedPopover && (
        <SolvedPointsPopover
          key={solvedPopover.jobId ?? "all"}
          jobId={solvedPopover.jobId}
          scopeLabel={solvedPopover.label}
          anchor={solvedPopover.anchor}
          onClose={() => setSolvedPopover(null)}
        />
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n >= 2 ** 30) return `${(n / 2 ** 30).toFixed(1)} GiB`;
  if (n >= 2 ** 20) return `${(n / 2 ** 20).toFixed(1)} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${Math.round(n)} B`;
}
/** Priority band names shown in the wizard/hub (spec §7): Background (0) /
 *  Standard (5) / High (8); any other value renders as its raw level. */
function campaignPriorityName(priority: number): string {
  if (priority === 0) return "Background";
  if (priority === 5) return "Standard";
  if (priority === 8) return "High";
  return `P${priority}`;
}

function CampaignBacklogStrip({
  strip,
  gate,
  onOpenCampaign,
  onOpenSimulations,
  onOpenPoints,
}: {
  strip: AdminQueueBacklogStrip;
  /** Scheduler gate from the SAME deriveSolverState the banner uses — the
   *  strip's active rows must never read as quietly working while blocked. */
  gate: CampaignGate | null;
  onOpenCampaign: (id: string) => void;
  onOpenSimulations: () => void;
  onOpenPoints: (campaignId: string, status: CampaignPointsBucket) => void;
}) {
  const gap = strip.backgroundGapFill;
  return (
    <section
      data-testid="queue-backlog-strip"
      style={{ ...card, padding: 12, borderRadius: 8 }}
    >
      <div style={label}>CAMPAIGN BACKLOG</div>
      {strip.campaigns.length === 0 ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>
          No campaign backlog — all queued work is background gap-fill.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          {/* Capped at 3 rows (approved design); the full list lives on Simulations. */}
          {strip.campaigns.slice(0, 3).map((c) => (
            <div
              key={c.id}
              data-testid={`backlog-campaign-${c.slug}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                fontFamily: MONO,
                fontSize: 11,
              }}
            >
              <button
                type="button"
                onClick={() => onOpenCampaign(c.id)}
                title={`Open campaign ${c.name}`}
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  fontWeight: 600,
                  color: C.teal,
                  background: C.tealFill,
                  border: `1px solid ${C.tealBorder}`,
                  borderRadius: 5,
                  padding: "3px 8px",
                  cursor: "pointer",
                  maxWidth: 240,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.name}
              </button>
              {/* Gate badge is PRIMARY for blocked active rows (mockup
                  fec7b453 screen 3); the lifecycle demotes to a dim chip. */}
              {gate && c.status === "active" && (
                <span
                  data-testid={`backlog-gate-${c.slug}`}
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    color: gate.tone === "red" ? C.redText : C.amber,
                    background:
                      gate.tone === "red"
                        ? "rgba(245,101,101,0.08)"
                        : "rgba(245,158,11,0.08)",
                    border: `1px solid ${gate.tone === "red" ? "rgba(245,101,101,0.5)" : "rgba(245,158,11,0.45)"}`,
                    borderRadius: 999,
                    padding: "2px 9px",
                  }}
                >
                  {gate.text}
                </span>
              )}
              {gate && c.status === "active" && (
                <span
                  style={{
                    fontSize: 9,
                    letterSpacing: "0.06em",
                    color: C.dim,
                    border: `1px solid ${C.borderSoft}`,
                    borderRadius: 999,
                    padding: "2px 8px",
                    textTransform: "uppercase",
                  }}
                >
                  active
                </span>
              )}
              <span style={{ color: C.dim }}>
                {campaignPriorityName(c.priority)}
              </span>
              <span style={{ color: C.text }}>
                {c.remainingPoints.toLocaleString()} points remaining
              </span>
              {/* Same POINTS unit as "points remaining" — labelled so it can
                  never be misread as the banner's engine-job count. */}
              {c.runningPoints > 0 && (
                <span style={{ color: C.amber }}>
                  {c.runningPoints.toLocaleString()} points solving
                </span>
              )}
              {/* Non-zero failed counts link to the Points explorer filtered
                  to this campaign; zero counts never render. */}
              {c.failedPoints > 0 && (
                <button
                  type="button"
                  data-testid={`backlog-failed-link-${c.slug}`}
                  title="Open these solver failures in the Points explorer"
                  onClick={() => onOpenPoints(c.id, "failed")}
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    color: C.redText,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  {c.failedPoints.toLocaleString()} failed
                </button>
              )}
              {(c.blockedPoints ?? 0) > 0 && (
                <span
                  data-testid={`backlog-blocked-${c.slug}`}
                  title="Automatic URANS recovery exhausted; this is a critical system incident requiring investigation"
                  style={{ color: C.redText }}
                >
                  {(c.blockedPoints ?? 0).toLocaleString()} critical
                </span>
              )}
              {c.status !== "active" && (
                <span style={{ color: C.amber }}>{c.status}</span>
              )}
            </div>
          ))}
          <button
            type="button"
            data-testid="backlog-all-campaigns"
            onClick={onOpenSimulations}
            style={{
              justifySelf: "start",
              fontFamily: MONO,
              fontSize: 10,
              color: C.teal,
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            all campaigns ({strip.campaigns.length})
          </button>
        </div>
      )}
      <div
        style={{ marginTop: 8, fontFamily: MONO, fontSize: 10, color: C.dim }}
      >
        {gap ? (
          <>
            Background gap-fill: {gap.pendingPoints.toLocaleString()} points in{" "}
            {gap.pendingSweeps.toLocaleString()} sweeps
            {strip.campaigns.length > 0
              ? " waiting behind campaign work"
              : ""}{" "}
            · computed {ago(gap.computedAt)}
          </>
        ) : (
          // Honest empty state: the scan has not completed yet (it refreshes in
          // the background) — the strip never invents counters.
          <>
            Background gap-fill backlog not computed yet — refreshing in the
            background.
          </>
        )}
      </div>
    </section>
  );
}

function QueuePanel({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count?: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      style={{ ...card, padding: 0, borderRadius: 8, overflow: "hidden" }}
    >
      <div
        style={{
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${C.borderSoft}`,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontFamily: MONO,
            fontSize: 12,
            fontWeight: 700,
            color: C.text,
          }}
        >
          {title}
        </h3>
        {count && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function TableHead({ columns, labels }: { columns: string; labels: string[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: columns,
        gap: 10,
        fontFamily: MONO,
        fontSize: 10,
        color: C.dim,
        padding: "8px 16px",
        borderBottom: `1px solid ${C.borderSoft}`,
      }}
    >
      {labels.map((text) => (
        <span
          key={text}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: [
              "AoA",
              "Cl max",
              "Cd min",
              "L/D max",
              "Finished",
            ].includes(text)
              ? "right"
              : "left",
          }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

function EmptyQueueLine({ text }: { text: string }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 12,
        color: C.muted,
        padding: "18px 16px",
        lineHeight: 1.5,
      }}
    >
      {text}
    </div>
  );
}

function KindBadge({ kind }: { kind: AdminJob["kind"] }) {
  const meta = KIND_META[kind];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        width: "fit-content",
        fontFamily: MONO,
        fontSize: 10,
        color: meta.tone,
        background: meta.fill,
        border: `1px solid ${meta.border}`,
        borderRadius: 5,
        padding: "3px 7px",
      }}
    >
      <span>{meta.label}</span>
      <span style={{ color: meta.tone, opacity: 0.75 }}>{meta.regime}</span>
    </span>
  );
}

function PendingSweepRow({ item }: { item: AdminPendingSweep }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: PENDING_COLUMNS,
        gap: 10,
        alignItems: "center",
        fontFamily: MONO,
        fontSize: 11,
        padding: "9px 16px",
        borderBottom: `1px solid ${C.borderRow}`,
      }}
    >
      <Link
        href={`/airfoils/${item.airfoilSlug}`}
        title={item.airfoilName}
        style={{
          minWidth: 0,
          color: C.text,
          textDecoration: "none",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.airfoilName}
      </Link>
      <KindBadge kind={item.kind} />
      <span
        title={schedulingSummary(item)}
        style={{
          minWidth: 0,
          color: C.amber,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {policyLabel(item.schedulingPolicy)} ·{" "}
        {item.caseConcurrency == null ? "engine" : `${item.caseConcurrency}x`}
      </span>
      <span
        style={{
          minWidth: 0,
          color: C.muted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {fSpeed(item.speedMps)}
      </span>
      <span
        style={{
          minWidth: 0,
          color: C.muted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Re {formatRe(item.reynolds)}
      </span>
      <span
        title={item.aoas.join(", ")}
        style={{
          minWidth: 0,
          color: C.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.aoaCount} · {aoaSpan(item.aoaMin, item.aoaMax)}
      </span>
      <span
        title={`Flow ${item.mediumName} · ${fSpeed(item.speedMps)} · ${fTemp(item.temperatureK)} · ${fPressure(item.pressurePa)} · M ${f(item.mach, 3)} | Reference chord ${f(item.referenceChordM, 3)} m | Boundary ${item.bcName} | Solver ${item.turbulenceModel}`}
        style={{
          minWidth: 0,
          color: C.muted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.bcName} · {item.mediumName}
      </span>
      <span
        style={{
          minWidth: 0,
          color:
            item.priority > 0 ? C.amber : (STATUS_COLOR[item.status] ?? C.dim),
          textAlign: "right",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {item.priority > 0 ? `P${item.priority}` : item.status}
      </span>
    </div>
  );
}

function runtimeLabel(job: AdminJob): string {
  if (job.resultReady) return "result ready";
  if (job.processCount > 0)
    return `${job.processCount} child process${job.processCount === 1 ? "" : "es"}`;
  if (job.runtimeState === "detached_running") return "worker heartbeat";
  if (job.runtimeState === "worker_visible") return "worker-visible";
  if (job.runtimeState === "orphaned") return "orphaned";
  if (job.runtimeState === "missing_grace") return "missing grace";
  if (job.runtimeState === "corrupt_status")
    return job.processCount > 0
      ? "status unreadable · process alive"
      : "status unreadable";
  if (job.runtimeState === "corrupt_result") return "result unreadable";
  return job.engineJobId
    ? job.engineQueueMatch
      ? "worker-visible"
      : "not in Celery"
    : "not submitted";
}

function phaseLabel(job: AdminJob): string {
  switch (job.phase) {
    case "pending":
      return job.engineState === "pending" || job.status === "submitted"
        ? "queued in engine"
        : "pending";
    case "waiting_cpu":
      return `waiting for CPU${job.cpuTokensWaiting ? ` · ${job.cpuTokensWaiting} token${job.cpuTokensWaiting === 1 ? "" : "s"}` : ""}`;
    case "meshing":
      return "meshing";
    case "solving_rans":
      return "RANS solving";
    case "solving_urans":
      return job.kind === "sweep-rans"
        ? "URANS fallback running"
        : "URANS solving";
    case "postprocessing":
      return "postprocessing";
    case "ingesting":
      return "ingesting results";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return job.status;
  }
}

function phaseTone(job: AdminJob): string {
  if (job.phase === "pending" || job.phase === "waiting_cpu") return C.amber;
  if (job.phase === "solving_urans") return C.red;
  if (
    job.phase === "meshing" ||
    job.phase === "solving_rans" ||
    job.phase === "postprocessing"
  )
    return C.teal;
  if (job.phase === "failed" || job.phase === "cancelled") return C.redText;
  return C.muted;
}

function activeSolverLabel(job: AdminJob): string | null {
  const solver = job.activeSolver;
  const process = job.processes.find((p) => p.command || p.solver_mode);
  const command = solver || process?.command || null;
  if (!command) return null;
  if (command.includes("pimpleFoam")) return "pimpleFoam";
  if (command.includes("simpleFoam")) return "simpleFoam";
  if (command.includes("blockMesh")) return "blockMesh";
  return command.split(/\s+/)[0]?.slice(-36) || null;
}

function runtimeTone(job: AdminJob): string {
  if (
    job.runtimeState === "orphaned" ||
    job.runtimeState === "corrupt_result" ||
    (job.runtimeState === "corrupt_status" && job.processCount === 0)
  )
    return C.redText;
  if (
    job.runtimeState === "detached_running" ||
    job.runtimeState === "missing_grace" ||
    (job.runtimeState === "corrupt_status" && job.processCount > 0)
  )
    return C.amber;
  if (job.runtimeState === "worker_visible" || job.resultReady) return C.teal;
  return C.dim;
}

/** Solved-count chip on a queue job card (screen 5): opens the solved-points
 *  popover scoped to that job. Rendered only when real solved rows exist. */
function SolvedCountChip({
  job,
  onOpenSolved,
}: {
  job: AdminJob;
  onOpenSolved: (jobId: string, label: string | null, rect: DOMRect) => void;
}) {
  if (job.solvedCount <= 0) return null;
  return (
    <button
      type="button"
      data-testid={`solved-chip-${job.id}`}
      title={`View the ${job.solvedCount} solved point${job.solvedCount === 1 ? "" : "s"} of this job`}
      onClick={(e) =>
        onOpenSolved(
          job.id,
          job.airfoilName ?? job.airfoilSlug,
          e.currentTarget.getBoundingClientRect(),
        )
      }
      style={{
        fontFamily: MONO,
        fontSize: 10,
        color: C.teal,
        background: C.tealFill,
        border: `1px solid ${C.tealBorder}`,
        borderRadius: 5,
        padding: "2px 6px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {job.solvedCount} solved ▾
    </button>
  );
}

function ActiveJobCard({
  job,
  busy,
  onCancel,
  onOpenCampaign,
  onOpenSolved,
}: {
  job: AdminJob;
  busy: boolean;
  onCancel: () => void;
  onOpenCampaign: (id: string) => void;
  onOpenSolved: (jobId: string, label: string | null, rect: DOMRect) => void;
}) {
  const inFlight = ["submitted", "running", "ingesting", "pending"].includes(
    job.status,
  );
  const progress =
    job.totalCases > 0
      ? Math.min(100, Math.round((job.completedCases / job.totalCases) * 100))
      : 0;
  return (
    <div
      style={{
        background: C.panel2,
        border: `1px solid ${C.stroke}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: 10,
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          {job.airfoilSlug ? (
            // Same affordance + pinned-revision rules as FinishedJobCard.
            <Link
              href={airfoilDetailHref(job.airfoilSlug, job.revisionId)}
              style={{
                display: "block",
                width: "fit-content",
                maxWidth: "100%",
                color: C.teal,
                textDecoration: "underline dotted",
                textUnderlineOffset: 3,
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {job.airfoilName ?? job.airfoilSlug}
            </Link>
          ) : (
            <span
              style={{
                color: C.text,
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              unknown airfoil
            </span>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              flexWrap: "wrap",
              marginTop: 8,
            }}
          >
            <KindBadge kind={job.kind} />
            <CampaignJobChip job={job} onOpenCampaign={onOpenCampaign} />
            <SolvedCountChip job={job} onOpenSolved={onOpenSolved} />
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: STATUS_COLOR[job.status] ?? C.muted,
              }}
            >
              wave {job.wave} · {job.status}
            </span>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: phaseTone(job),
                border: `1px solid ${C.stroke}`,
                borderRadius: 5,
                padding: "2px 5px",
              }}
            >
              {phaseLabel(job)}
            </span>
            <span
              title={schedulingSummary(job)}
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: C.amber,
                border: `1px solid ${C.stroke}`,
                borderRadius: 5,
                padding: "2px 5px",
              }}
            >
              {schedulingSummary(job)}
            </span>
            {job.stale && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.redText,
                  border: `1px solid ${C.stroke}`,
                  borderRadius: 5,
                  padding: "2px 5px",
                }}
              >
                stale
              </span>
            )}
            {job.engineJobId && (
              <span
                title={job.staleReason ?? undefined}
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: runtimeTone(job),
                }}
              >
                {runtimeLabel(job)}
              </span>
            )}
            {activeSolverLabel(job) && (
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                {activeSolverLabel(job)}
                {job.activeAoaDeg != null
                  ? ` · AoA ${f(job.activeAoaDeg, 1)}°`
                  : ""}
                {job.cpuTokensHeld != null && job.cpuTokensHeld > 0
                  ? ` · ${job.cpuTokensHeld} CPU`
                  : ""}
              </span>
            )}
          </div>
        </div>
        {inFlight && (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: C.redText,
              background: "transparent",
              border: `1px solid ${C.stroke}`,
              borderRadius: 6,
              padding: "5px 8px",
              cursor: "pointer",
            }}
          >
            cancel
          </button>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <div
          style={{
            height: 6,
            background: C.panel3,
            borderRadius: 999,
            overflow: "hidden",
            border: `1px solid ${C.borderSoft}`,
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              minWidth: progress > 0 ? 6 : 0,
              height: "100%",
              background: C.teal,
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
            marginTop: 7,
            fontFamily: MONO,
            fontSize: 10,
            color: C.dim,
          }}
        >
          <span>
            {job.completedCases}/{job.totalCases || "?"} cases
          </span>
          <span title={job.engineJobId ?? undefined}>
            {job.engineJobId
              ? `${job.engineJobId.slice(0, 12)} · job ${agoFromSeconds(job.pendingAgeSec)} · phase ${ago(job.phaseStartedAt)}`
              : "not submitted"}
          </span>
        </div>
      </div>
      <JobConditionChips job={job} />
      {job.staleReason && (
        <div
          style={{
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 10,
            color: job.stale ? C.redText : C.amber,
            lineHeight: 1.45,
          }}
        >
          {job.staleReason}
        </div>
      )}
      {(job.statusReadError || job.resultReadError) && (
        <div
          style={{
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 10,
            color: C.redText,
            lineHeight: 1.45,
          }}
        >
          {[
            job.statusReadError && `status: ${job.statusReadError}`,
            job.resultReadError && `result: ${job.resultReadError}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {job.error && (
        <div
          style={{
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 10,
            color: C.redText,
            lineHeight: 1.45,
          }}
        >
          {job.error}
        </div>
      )}
    </div>
  );
}

function FinishedJobCard({
  job,
  onOpenCampaign,
  onOpenSolved,
}: {
  job: AdminJob;
  onOpenCampaign: (id: string) => void;
  onOpenSolved: (jobId: string, label: string | null, rect: DOMRect) => void;
}) {
  return (
    <div
      style={{
        background: C.panel2,
        border: `1px solid ${C.stroke}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: 10,
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: STATUS_COLOR[job.status] ?? C.muted,
              }}
            >
              {job.status}
            </span>
            <KindBadge kind={job.kind} />
            <CampaignJobChip job={job} onOpenCampaign={onOpenCampaign} />
            <SolvedCountChip job={job} onOpenSolved={onOpenSolved} />
          </div>
          {job.airfoilSlug ? (
            // A real-looking link, not a caption: teal + dotted underline,
            // fit-content so only the name itself is the click target. The
            // href pins the job's setup revision (campaign spec §11) so the
            // detail page shows THIS job's evidence even when its campaign
            // preset is disabled by design.
            <Link
              href={airfoilDetailHref(job.airfoilSlug, job.revisionId)}
              style={{
                display: "block",
                width: "fit-content",
                maxWidth: "100%",
                marginTop: 8,
                color: C.teal,
                textDecoration: "underline dotted",
                textUnderlineOffset: 3,
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {job.airfoilName ?? job.airfoilSlug}
            </Link>
          ) : (
            <span
              style={{
                display: "block",
                marginTop: 8,
                color: C.text,
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              unknown airfoil
            </span>
          )}
        </div>
        {job.airfoilSlug ? (
          <Link
            href={airfoilDetailHref(job.airfoilSlug, job.revisionId)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: C.teal,
              textDecoration: "none",
              border: `1px solid ${C.tealBorder}`,
              borderRadius: 6,
              padding: "4px 7px",
              fontFamily: MONO,
              fontSize: 10,
            }}
          >
            Detail <ExternalLink size={12} />
          </Link>
        ) : (
          <span style={{ color: C.dimmest }}>—</span>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 8,
          marginTop: 10,
          fontFamily: MONO,
          fontSize: 10,
          color: C.dim,
        }}
      >
        <MetricChip label="AoA" value={aoaRange(job)} />
        <MetricChip label="Cl" value={f(job.clMax, 3)} />
        <MetricChip label="Cd" value={f(job.cdMin, 4)} />
        <MetricChip label="L/D" value={f(job.ldMax, 1)} />
      </div>
      <JobConditionChips job={job} />
      <div
        style={{
          marginTop: 8,
          fontFamily: MONO,
          fontSize: 10,
          color: C.dimmest,
        }}
      >
        finished {ago(job.finishedAt)}
      </div>
    </div>
  );
}

/** Campaign chip on a queue job card (spec §10/§11): links to the campaign
 *  page; rendered only when the admin payload attributes the job to one. */
function CampaignJobChip({
  job,
  onOpenCampaign,
}: {
  job: AdminJob;
  onOpenCampaign: (id: string) => void;
}) {
  const campaignId = job.campaignId;
  if (!campaignId) return null;
  const name = job.campaignName ?? job.campaignSlug ?? "campaign";
  return (
    <button
      type="button"
      data-testid={`job-campaign-chip-${job.campaignSlug ?? campaignId}`}
      title={`Open campaign ${name}`}
      onClick={() => onOpenCampaign(campaignId)}
      style={{
        fontFamily: MONO,
        fontSize: 10,
        color: C.teal,
        background: C.tealFill,
        border: `1px solid ${C.tealBorder}`,
        borderRadius: 5,
        padding: "2px 6px",
        cursor: "pointer",
        maxWidth: 200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {name}
      {job.jobKind === "targeted" ? " · targeted" : ""}
    </button>
  );
}

function JobConditionChips({ job }: { job: AdminJob }) {
  // Batched campaign jobs bundle several speeds: show the honest Re range +
  // speed count instead of a single misleading value.
  const reLabel =
    job.speedCount != null &&
    job.speedCount > 1 &&
    job.reynoldsMin != null &&
    job.reynoldsMax != null &&
    job.reynoldsMin !== job.reynoldsMax
      ? `Re ${formatRe(job.reynoldsMin)}–${formatRe(job.reynoldsMax)} · ${job.speedCount} speeds`
      : `Re ${job.reynolds ? formatRe(job.reynolds) : "—"}`;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))",
        gap: 8,
        marginTop: 10,
        fontFamily: MONO,
        fontSize: 10,
        color: C.dim,
      }}
    >
      <MetricChip
        label="Flow"
        value={`${job.mediumName ?? "—"} · ${f(job.speedMps, 2)} m/s`}
      />
      <MetricChip
        label="Thermo"
        value={`${fTemp(job.temperatureK)} · ${fPressure(job.pressurePa)} · M ${f(job.mach, 3)}`}
      />
      <MetricChip
        label="Reference"
        value={`chord ${f(job.referenceChordM, 3)} m · ${reLabel}`}
      />
      <MetricChip label="Boundary" value={job.bcName ?? "—"} />
      <MetricChip
        label="Engine"
        value={
          job.solverImplementation
            ? `${solverImplementationLabel(job.solverImplementation)}${job.solverRuntimeBuild?.buildId ? ` · build ${job.solverRuntimeBuild.buildId}` : ""}${job.solverExecutionPool?.name ? ` · ${job.solverExecutionPool.name}` : ""}`
            : "legacy / unknown"
        }
      />
      <MetricChip label="Solver" value={job.turbulenceModel ?? "—"} />
      <MetricChip
        label="Scheduling"
        value={`${policyLabel(job.schedulingPolicy)} · ${job.caseConcurrency == null ? "engine" : `${job.caseConcurrency}x${job.solverProcesses ?? 1}`}`}
      />
    </div>
  );
}

function MetricChip({ label: l, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "grid",
        gap: 2,
        background: C.panel3,
        border: `1px solid ${C.borderSoft}`,
        borderRadius: 6,
        padding: "6px 7px",
        minWidth: 0,
      }}
    >
      <span style={{ color: C.dimmest }}>{l}</span>
      <span
        style={{
          color: C.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </span>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{title}</h2>
      <div
        style={{ marginTop: 5, fontFamily: MONO, fontSize: 11, color: C.dim }}
      >
        {subtitle}
      </div>
    </div>
  );
}

function ProfileSectionTitle({ text }: { text: string }) {
  return (
    <div
      style={{
        marginTop: 12,
        marginBottom: 2,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.08em",
        color: C.teal,
      }}
    >
      {text.toUpperCase()}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div
      style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 12 }}
    >
      {text}
    </div>
  );
}

const miniLabel: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  color: C.dim,
  margin: "8px 0 4px",
};
const validationText: CSSProperties = {
  marginTop: 4,
  fontFamily: MONO,
  fontSize: 10,
  color: C.red,
};

function ValidationSummary({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${C.red}`,
        borderRadius: 8,
        padding: "8px 10px",
        color: C.red,
        background: "rgba(245, 101, 101, 0.08)",
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 1.35,
      }}
    >
      {issues[0].message}
      {issues.length > 1 && (
        <span style={{ color: C.redText }}> · {issues.length - 1} more</span>
      )}
    </div>
  );
}

function TextField({
  label: l,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const id = `admin-field-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label style={{ display: "block" }} data-admin-field={l}>
      <div style={miniLabel}>{l}</div>
      <input
        aria-label={l}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}
      />
      {error && (
        <div id={`${id}-error`} style={validationText}>
          {error}
        </div>
      )}
    </label>
  );
}

function NumberField({
  label: l,
  value,
  onChange,
  error,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  error?: string;
}) {
  const id = `admin-field-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label style={{ display: "block" }} data-admin-field={l}>
      <div style={miniLabel}>{l}</div>
      <input
        aria-label={l}
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}
      />
      {error && (
        <div id={`${id}-error`} style={validationText}>
          {error}
        </div>
      )}
    </label>
  );
}

function OptionalNumberField({
  label: l,
  value,
  onChange,
  error,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  error?: string;
}) {
  const id = `admin-field-${l.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <label style={{ display: "block" }} data-admin-field={l}>
      <div style={miniLabel}>{l}</div>
      <input
        type="number"
        aria-label={l}
        value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        placeholder="auto"
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw ? Number(raw) : null);
        }}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}
      />
      {error && (
        <div id={`${id}-error`} style={validationText}>
          {error}
        </div>
      )}
    </label>
  );
}

// Exported for the campaign wizard's boundary quick-create (DecisionHistory
// 2026-07-01 boundary presets decision): preset select first, raw νt/ν value
// behind the advanced disclosure.
export function TurbulentViscosityRatioField({
  value,
  onChange,
  error,
}: {
  value: number;
  onChange: (v: number) => void;
  error?: string;
}) {
  const rounded = Number.isFinite(value) ? String(value) : "10";
  const presetValue = TURBULENT_VISCOSITY_RATIO_PRESETS.some(
    (preset) => preset.value === rounded,
  )
    ? rounded
    : "custom";
  const options =
    presetValue === "custom"
      ? [
          "custom",
          ...TURBULENT_VISCOSITY_RATIO_PRESETS.map((preset) => preset.value),
        ]
      : TURBULENT_VISCOSITY_RATIO_PRESETS.map((preset) => preset.value);
  const optionLabels = {
    ...Object.fromEntries(
      TURBULENT_VISCOSITY_RATIO_PRESETS.map((preset) => [
        preset.value,
        preset.label,
      ]),
    ),
    custom: `Custom · νt/ν ${f(value, 2)}`,
  };
  return (
    <div style={{ display: "grid", gap: 6, gridColumn: "1 / -1" }}>
      <SelectField
        label="Turbulent viscosity ratio νt/ν"
        value={presetValue}
        options={options}
        optionLabels={optionLabels}
        error={error}
        onChange={(next) => {
          if (next !== "custom") onChange(Number(next));
        }}
      />
      <details
        {...(presetValue === "custom" ? { open: true } : {})}
        style={{
          border: `1px solid ${C.stroke2}`,
          borderRadius: 8,
          padding: "7px 9px",
        }}
      >
        <summary
          style={{
            cursor: "pointer",
            color: C.dim,
            fontFamily: MONO,
            fontSize: 10,
          }}
        >
          advanced raw value
        </summary>
        <div style={{ marginTop: 8 }}>
          <NumberField label="νt/ν raw" value={value} onChange={onChange} />
        </div>
      </details>
    </div>
  );
}

// Exported for the campaign wizard's mesh quick-create (DecisionHistory
// 2026-07-01 mesh-infographic decisions are binding): the ONE live C-grid
// infographic with overlay controls — reused, never duplicated.
export function MeshSettingsGuide({
  form,
  onChange,
}: {
  form: MeshProfileInput;
  onChange: (patch: Partial<MeshProfileInput>) => void;
}) {
  const setField = (key: keyof MeshProfileInput) => (value: number) =>
    onChange({ [key]: value } as Partial<MeshProfileInput>);
  const notes = [
    {
      title: "Surface cells",
      body: "Chordwise wall cells along the airfoil surface. More cells resolve nose curvature and pressure peaks.",
      color: "#f59e0b",
    },
    {
      title: "Radial / farfield",
      body: "Wall-normal layers grow from the airfoil toward the outer boundary. Larger farfield distance reduces boundary influence.",
      color: C.teal,
    },
    {
      title: "Wake block",
      body: "Cells downstream of the trailing edge. The mesh stays chord-aligned while AoA sweeps rotate the freestream velocity.",
      color: "#f59e0b",
    },
    {
      title: "Target y+",
      body: "First wall-cell height target. Lower y+ gives a finer near-wall mesh for turbulence models.",
      color: "#a855f7",
    },
    {
      title: "Span",
      body: "Numerical slab thickness for the 2D OpenFOAM case. It is not the physical wing span.",
      color: "#60a5fa",
    },
  ];

  return (
    <section
      aria-label="Mesh parameter guide"
      style={{ display: "grid", gap: 12 }}
    >
      <div
        data-testid="mesh-infographic-artifact"
        style={{
          position: "relative",
          border: `1px solid ${C.stroke2}`,
          borderRadius: 12,
          overflow: "hidden",
          background: "#071016",
          boxShadow: "0 18px 40px rgba(0,0,0,0.24)",
        }}
      >
        <img
          src="/infographics/mesh-settings-cgrid-editable.png"
          alt="C-grid airfoil mesh infographic with seven blank anchor pads for editable farfield, radial, surface, wake, target y+ and span controls."
          style={{ display: "block", width: "100%", height: "auto" }}
        />
        <MeshPictureNumberField
          label="Farfield"
          unit="c"
          value={form.farfieldRadiusChords}
          min={5}
          max={50}
          step={1}
          color={C.teal}
          style={{ left: "0.9%", top: "27.0%", width: "7.8%" }}
          onChange={setField("farfieldRadiusChords")}
        />
        <MeshPictureNumberField
          label="Radial"
          value={form.nRadial}
          min={20}
          max={220}
          step={1}
          color={C.teal}
          style={{ left: "37.2%", top: "16.0%", width: "13.6%" }}
          onChange={setField("nRadial")}
        />
        <MeshPictureNumberField
          label="Surface"
          value={form.nSurface}
          min={40}
          max={420}
          step={1}
          color="#f59e0b"
          style={{ left: "25.2%", top: "61.3%", width: "13.5%" }}
          onChange={setField("nSurface")}
        />
        <MeshPictureNumberField
          label="Wake cells"
          value={form.nWake}
          min={20}
          max={220}
          step={1}
          color="#f59e0b"
          style={{ left: "64.8%", top: "24.0%", width: "14.2%" }}
          onChange={setField("nWake")}
        />
        <MeshPictureNumberField
          label="Wake length"
          unit="c"
          value={form.wakeLengthChords}
          min={4}
          max={40}
          step={1}
          color="#f59e0b"
          style={{ left: "89.2%", top: "21.4%", width: "9.4%" }}
          onChange={setField("wakeLengthChords")}
        />
        <MeshPictureNumberField
          label="Target y+"
          value={form.targetYPlus}
          min={0.1}
          max={5}
          step={0.1}
          color="#a855f7"
          style={{ left: "44.5%", top: "61.0%", width: "11.4%" }}
          onChange={setField("targetYPlus")}
        />
        <MeshPictureNumberField
          label="Span"
          unit="c"
          value={form.spanChords}
          min={0.01}
          max={1}
          step={0.01}
          color="#60a5fa"
          style={{ left: "85.5%", top: "76.2%", width: "9.3%" }}
          onChange={setField("spanChords")}
        />
      </div>
      <div
        data-testid="mesh-explanation-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 8,
        }}
      >
        {notes.map((note) => (
          <div
            key={note.title}
            style={{
              display: "grid",
              gap: 5,
              alignContent: "start",
              borderTop: `2px solid ${note.color}`,
              background: "rgba(15,23,42,0.44)",
              borderRadius: 8,
              padding: "8px 9px",
            }}
          >
            <div
              style={{
                color: note.color,
                fontFamily: MONO,
                fontSize: 10,
                fontWeight: 800,
                textTransform: "uppercase",
              }}
            >
              {note.title}
            </div>
            <p
              style={{
                margin: 0,
                color: C.dim,
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              {note.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function MeshPictureNumberField({
  label: l,
  value,
  min,
  max,
  step,
  unit,
  color,
  style,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  color: string;
  style: CSSProperties;
  onChange: (value: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const current = Number.isFinite(value) ? value : 0;
  const normalized = Math.min(max, Math.max(min, current));
  const apply = (raw: string) => {
    const next = Number(raw);
    if (Number.isFinite(next)) onChange(next);
  };

  return (
    <label
      data-admin-field={l}
      style={{
        position: "absolute",
        display: "grid",
        gridTemplateRows: "auto auto",
        gap: 2,
        padding: "4px 6px",
        border: `1px solid ${focused ? color : "rgba(148, 163, 184, 0.42)"}`,
        borderRadius: 9,
        background: "rgba(7,16,22,0.84)",
        boxShadow: focused
          ? `0 0 0 2px ${color}33, 0 10px 26px rgba(0,0,0,0.42)`
          : "0 8px 20px rgba(0,0,0,0.26)",
        color: C.text,
        ...style,
      }}
      onMouseDown={() => setFocused(true)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setFocused(false);
      }}
    >
      <span
        style={{
          color,
          fontFamily: MONO,
          fontSize: 9,
          lineHeight: 1,
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {l}
      </span>
      <span
        style={{
          display: "grid",
          gridTemplateColumns: unit ? "minmax(0, 1fr) auto" : "minmax(0, 1fr)",
          gap: 4,
          alignItems: "center",
        }}
      >
        <input
          aria-label={l}
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => apply(e.currentTarget.value)}
          style={{
            width: "100%",
            minWidth: 0,
            border: "none",
            background: "transparent",
            color: C.text,
            fontFamily: MONO,
            fontSize: 14,
            fontWeight: 800,
            padding: 0,
            outline: "none",
          }}
        />
        {unit && (
          <span style={{ color: C.muted, fontFamily: MONO, fontSize: 10 }}>
            {unit}
          </span>
        )}
      </span>
      {focused && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "calc(100% + 5px)",
            zIndex: 8,
            border: `1px solid ${C.stroke2}`,
            borderRadius: 9,
            background: "rgba(7,16,22,0.98)",
            padding: "8px 9px",
            boxShadow: "0 14px 32px rgba(0,0,0,0.4)",
          }}
        >
          <input
            aria-label={`${l} slider`}
            type="range"
            min={min}
            max={max}
            step={step}
            value={normalized}
            onChange={(e) => apply(e.currentTarget.value)}
            style={{ width: "100%", display: "block" }}
          />
        </div>
      )}
    </label>
  );
}

function SelectField({
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
      <select
        aria-label={l}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        style={{ ...inputStyle, borderColor: error ? C.red : C.stroke }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {optionLabels?.[o] ?? o}
          </option>
        ))}
      </select>
      {error && (
        <div id={`${id}-error`} style={validationText}>
          {error}
        </div>
      )}
    </label>
  );
}

function dynamicViscosity(medium: MediumDTO, tempK: number): number {
  if (medium.viscosityModel === "constant")
    return medium.constantDynamicViscosity ?? medium.dynamicViscosity;
  if (medium.viscosityModel === "sutherland") {
    const muRef = medium.sutherlandMuRef ?? medium.dynamicViscosity;
    const tRef = medium.sutherlandTRef ?? medium.refTemperatureK;
    const s = medium.sutherlandS ?? 110.4;
    return muRef * Math.pow(tempK / tRef, 1.5) * ((tRef + s) / (tempK + s));
  }
  const rows = [...medium.viscosityTable].sort(
    (a, b) => a.temperatureK - b.temperatureK,
  );
  const temps = rows.map((p) => p.temperatureK);
  const mus = rows.map((p) => p.dynamicViscosity);
  if (!temps.length) return medium.dynamicViscosity;
  if (tempK <= temps[0]) return mus[0];
  if (tempK >= temps[temps.length - 1]) return mus[mus.length - 1];
  for (let i = 0; i < temps.length - 1; i++) {
    if (tempK >= temps[i] && tempK <= temps[i + 1]) {
      const t = (tempK - temps[i]) / (temps[i + 1] - temps[i]);
      return mus[i] + (mus[i + 1] - mus[i]) * t;
    }
  }
  return mus[mus.length - 1];
}

function previewFlow(
  medium: MediumDTO,
  form: Pick<FlowConditionInput, "temperatureK" | "pressurePa" | "speedMps">,
) {
  const mu = dynamicViscosity(medium, form.temperatureK);
  const density =
    medium.phase === "gas"
      ? medium.density *
        (form.pressurePa / medium.refPressurePa) *
        (medium.refTemperatureK / form.temperatureK)
      : medium.density;
  const kinematicViscosity = mu / density;
  const mach = medium.speedOfSound ? form.speedMps / medium.speedOfSound : null;
  return { dynamicViscosity: mu, density, kinematicViscosity, mach };
}

/** THE single global solver-capacity control (sweeper_state.cpuSlots, spec
 *  §3.2/§7): 0 renders as "auto" (no cpu cap sent to the engine); the API
 *  accepts 0..512. Replaces the old per-job concurrency stepper. */
function CpuSlotsStepper({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  const btn: CSSProperties = {
    fontFamily: MONO,
    fontSize: 13,
    width: 24,
    height: 24,
    borderRadius: 6,
    background: C.panel3,
    border: `1px solid ${C.stroke}`,
    color: C.text,
    cursor: disabled ? "not-allowed" : "pointer",
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        aria-label="Decrease CPU slots"
        disabled={disabled || value <= 0}
        onClick={() => onChange(value - 1)}
        style={btn}
      >
        −
      </button>
      <span
        data-testid="queue-cpu-slots-value"
        style={{
          fontFamily: MONO,
          fontSize: 13,
          color: value === 0 ? C.dim : C.text,
          minWidth: 34,
          textAlign: "center",
        }}
      >
        {value === 0 ? "auto" : value}
      </span>
      <button
        type="button"
        aria-label="Increase CPU slots"
        disabled={disabled || value >= 512}
        onClick={() => onChange(value + 1)}
        style={btn}
      >
        +
      </button>
    </span>
  );
}

const inputStyle: CSSProperties = {
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
const ghostBtn: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
};
function primaryBtn(disabled: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 600,
    color: C.tealInk,
    background: C.teal,
    border: `1px solid ${C.teal}`,
    borderRadius: 8,
    padding: "8px 16px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
