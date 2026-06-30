"use client";

import type { MediumDTO } from "@aerodb/core";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, CheckCircle2, Clock3, ExternalLink, Pause, Play, RotateCcw, ShieldAlert, XCircle } from "lucide-react";

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
  type AdminReferenceGeometryProfile,
  type AdminSchedulingProfile,
  type AdminSyncPermission,
  type AdminSyncState,
  type AdminSimulationPreset,
  type AdminSimulationSetup,
  type AdminSolverProfile,
  type AdminSweepDefinition,
  type BoundaryProfileInput,
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
  getAdminMediums,
  getAdminQueue,
  getAdminSync,
  getAdminSimulationSetup,
  patchSweeper,
  patchAdminSync,
  promoteSyncConflict,
  recoverStaleJobs,
  requeueFailed,
  runUpstreamSync,
  updateAdminMedium,
  updateBoundaryProfile,
  updateFlowCondition,
  updateMeshProfile,
  updateOutputProfile,
  updateReferenceGeometryProfile,
  updateSchedulingProfile,
  updateSimulationPreset,
  updateSolverProfile,
  updateSweepDefinition,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { AddAirfoilsPanel } from "./AddAirfoilsPanel";
import { CategoriesAdminPanel, HashtagsAdminPanel } from "./CatalogAdminPanels";
import { UnitNumberField } from "./UnitNumberField";

type Section = "queue" | "mediums" | "boundaryConditions" | "sync" | "add" | "categories" | "hashtags";
const SECTIONS: { k: Section; label: string; icon: string }[] = [
  { k: "queue", label: "OpenFOAM queue", icon: "◷" },
  { k: "mediums", label: "Mediums", icon: "μ" },
  { k: "boundaryConditions", label: "Simulation setup", icon: "β" },
  { k: "sync", label: "Sync API", icon: "⇄" },
  { k: "add", label: "Add airfoils", icon: "＋" },
  { k: "categories", label: "Categories", icon: "▸" },
  { k: "hashtags", label: "Hashtags", icon: "#" },
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

const PENDING_COLUMNS = "minmax(90px, .85fr) 104px 104px 70px 70px 92px minmax(100px, .85fr) 62px";

const KIND_META: Record<AdminJob["kind"], { label: string; regime: string; tone: string; fill: string; border: string }> = {
  "sweep-rans": { label: "AoA sweep", regime: "RANS", tone: C.teal, fill: C.tealFill, border: C.tealBorder },
  "point-rans": { label: "Single point", regime: "RANS", tone: C.amber, fill: "rgba(245, 165, 36, 0.10)", border: "rgba(245, 165, 36, 0.38)" },
  "point-urans": { label: "Single point", regime: "URANS", tone: C.redText, fill: "rgba(245, 101, 101, 0.10)", border: "rgba(245, 101, 101, 0.34)" },
};

function formatRe(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

function f(v: number | null | undefined, digits = 3): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function fSci(v: number | null | undefined, digits = 3): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toExponential(digits) : "—";
}

function fTemp(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} K` : "—";
}

function fPressure(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)} kPa` : `${v.toFixed(0)} Pa`;
}

function fSpeed(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(2)} m/s` : "—";
}

function aoaSpan(min: number | null | undefined, max: number | null | undefined): string {
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
  const activeCases = item.caseConcurrency == null ? "auto" : item.caseConcurrency;
  const solvers = item.solverProcesses ?? 1;
  const mesh = item.meshBuildCount ?? 1;
  const aoas = item.aoaCaseCount ?? item.aoaCount ?? item.totalCases ?? 0;
  const cpu = item.cpuBudget ? `${item.cpuBudget} CPU` : "auto CPU";
  return `${policyLabel(item.schedulingPolicy)} · ${mesh} mesh · ${aoas} AoAs · ${activeCases} active x ${solvers}p · ${cpu}`;
}

const card: CSSProperties = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 };
const label: CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.dim, marginBottom: 8 };

export function AdminConsole() {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [section, setSection] = useState<Section>("queue");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);

  useEffect(() => {
    adminMe()
      .then(setMe)
      .catch((e) => setErr((e as Error).message));
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
    return <div style={{ fontFamily: MONO, fontSize: 13, color: C.muted, padding: 40 }}>checking access…</div>;
  }
  if (!me.authed) {
    const googleProvider = me.providers?.google || me.google?.enabled;
    const passwordProvider = me.providers?.password ?? true;
    const googleDomain = me.google?.allowedDomain || "vr.ae";
    return (
      <div style={{ maxWidth: 380, margin: "60px auto", ...card }}>
        <div style={label}>ADMIN SIGN IN</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, marginBottom: 14 }}>
          {googleProvider ? `Use a verified ${googleDomain} Google account.` : "This deployment requires admin credentials."}
        </div>
        {googleProvider && (
          <button
            type="button"
            onClick={() => {
              window.location.href = adminGoogleLoginUrl("/admin");
            }}
            style={{ ...primaryBtn(false), width: "100%", display: "flex", justifyContent: "center", alignItems: "center", gap: 8 }}
          >
            Continue with Google
            <ExternalLink size={14} />
          </button>
        )}
        {passwordProvider && (
          <div style={{ marginTop: googleProvider ? 14 : 0 }}>
            {googleProvider && <div style={{ ...label, marginTop: 2, marginBottom: 10 }}>PASSWORD FALLBACK</div>}
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" autoComplete="username" style={inputStyle} />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doLogin()}
              placeholder="password"
              type="password"
              autoComplete="current-password"
              style={{ ...inputStyle, marginTop: 10 }}
            />
            {loginErr && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginTop: 10 }}>{loginErr}</div>}
            <button type="button" disabled={busy} onClick={doLogin} style={{ ...primaryBtn(busy), width: "100%", marginTop: 14 }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        )}
        {!googleProvider && !passwordProvider && (
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.red, lineHeight: 1.5 }}>
            Admin authentication is not configured. Set Google OAuth credentials or a password on the API server.
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
        .queue-header-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 16px;
          align-items: start;
          margin-bottom: 16px;
        }
        .queue-main-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.75fr);
          gap: 14px;
          align-items: start;
          margin-bottom: 14px;
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
          .queue-header-grid,
          .queue-main-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
        @media (max-width: 620px) {
          .admin-form-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: "-0.01em" }}>Admin</h1>
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
          {me.mode === "prod" ? `PROD · ${me.provider === "google" ? "Google · " : ""}${me.email}` : "DEV · auth off"}
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

      {err && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 12 }}>{err}</div>}

      <div className="admin-shell-grid">
        <nav className="admin-section-nav">
          {SECTIONS.map((s) => {
            const on = section === s.k;
            return (
              <button
                key={s.k}
                type="button"
                onClick={() => setSection(s.k)}
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
                <span style={{ width: 14, textAlign: "center", opacity: on ? 1 : 0.7 }}>{s.icon}</span>
                {s.label}
              </button>
            );
          })}
        </nav>

        <div style={{ minWidth: 0 }}>
          {section === "queue" && <QueueDashboard />}
          {section === "mediums" && <MediumsPanel />}
          {section === "boundaryConditions" && <SimulationSetupPanel />}
          {section === "sync" && <SyncApiPanel />}
          {section === "add" && <AddAirfoilsPanel />}
          {section === "categories" && <CategoriesAdminPanel />}
          {section === "hashtags" && <HashtagsAdminPanel />}
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

function MediumsPanel() {
  const [items, setItems] = useState<MediumDTO[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<MediumInput>(defaultMediumForm);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const selected = items.find((m) => m.id === selectedId) ?? null;

  const refresh = async () => setItems((await getAdminMediums()).items);
  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, []);

  const select = (m: MediumDTO) => {
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

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        ...form,
        viscosityTable: (form.viscosityTable ?? []).map((row, i) => ({ ...row, sortOrder: i })),
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
    setForm({ ...defaultMediumForm, viscosityTable: [...(defaultMediumForm.viscosityTable ?? [])] });
  };

  const setTableRow = (index: number, patch: Partial<NonNullable<MediumInput["viscosityTable"]>[number]>) => {
    setForm((current) => {
      const rows = [...(current.viscosityTable ?? [])];
      rows[index] = { ...rows[index], ...patch, sortOrder: index };
      return { ...current, viscosityTable: rows };
    });
  };

  return (
    <div>
      <SectionHeader title="Mediums" subtitle="Material registry for OpenFOAM flow states." />
      {err && <ErrorLine text={err} />}
      <div className="admin-editor-grid">
        <div style={card}>
          <div style={label}>MATERIALS</div>
          <div className="admin-table-scroll">
          <TableHead columns="minmax(160px, 1.25fr) 62px 84px 84px 88px 88px" labels={["Name", "Phase", "ρ", "T ref", "μ", "ν"]} />
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => select(m)}
              style={{ minWidth: 610, width: "100%", display: "grid", gridTemplateColumns: "minmax(160px, 1.25fr) 62px 84px 84px 88px 88px", gap: 10, alignItems: "center", textAlign: "left", fontFamily: MONO, fontSize: 11, color: selectedId === m.id ? C.teal : C.muted, background: selectedId === m.id ? C.rowActive : "transparent", border: "none", borderBottom: `1px solid ${C.borderRow}`, padding: "9px 0", cursor: "pointer" }}
            >
              <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
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
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={label}>{selected ? "EDIT MEDIUM" : "ADD MEDIUM"}</div>
            <button type="button" onClick={reset} style={{ ...ghostBtn, padding: "5px 8px", fontSize: 10 }}>
              new
            </button>
          </div>
          <TextField label="Name" value={form.name} onChange={(name) => setForm((f) => ({ ...f, name }))} />
          {!selected && <TextField label="Slug optional" value={form.slug ?? ""} onChange={(slug) => setForm((f) => ({ ...f, slug }))} />}
          <div className="admin-form-grid">
            <SelectField label="Phase" value={form.phase} options={["gas", "liquid"]} onChange={(phase) => setForm((f) => ({ ...f, phase: phase as "gas" | "liquid" }))} />
            <NumberField label="Density kg/m³" value={form.density} onChange={(density) => setForm((f) => ({ ...f, density }))} />
            <UnitNumberField label="Ref temp" dimension="temperature" valueSi={form.refTemperatureK} min={0} onChangeSi={(refTemperatureK) => setForm((f) => ({ ...f, refTemperatureK }))} />
            <UnitNumberField label="Ref pressure" dimension="pressure" valueSi={form.refPressurePa} min={0} onChangeSi={(refPressurePa) => setForm((f) => ({ ...f, refPressurePa }))} />
            <SelectField label="Viscosity model" value={form.viscosityModel} options={["constant", "sutherland", "table"]} onChange={(viscosityModel) => setForm((f) => ({ ...f, viscosityModel: viscosityModel as MediumInput["viscosityModel"] }))} />
            <UnitNumberField label="Speed of sound" dimension="speed" valueSi={form.speedOfSound ?? 0} min={0} onChangeSi={(speedOfSound) => setForm((f) => ({ ...f, speedOfSound }))} />
          </div>
          {form.viscosityModel === "constant" && (
            <NumberField
              label="Dynamic viscosity μ [Pa·s]"
              value={form.constantDynamicViscosity ?? 0}
              onChange={(constantDynamicViscosity) => setForm((f) => ({ ...f, constantDynamicViscosity }))}
            />
          )}
          {form.viscosityModel === "sutherland" && (
            <div className="admin-form-grid">
              <NumberField label="μ ref [Pa·s]" value={form.sutherlandMuRef ?? 0} onChange={(sutherlandMuRef) => setForm((f) => ({ ...f, sutherlandMuRef }))} />
              <UnitNumberField label="T ref" dimension="temperature" valueSi={form.sutherlandTRef ?? 0} min={0} onChangeSi={(sutherlandTRef) => setForm((f) => ({ ...f, sutherlandTRef }))} />
              <UnitNumberField label="Sutherland S" dimension="temperature" valueSi={form.sutherlandS ?? 0} min={0} onChangeSi={(sutherlandS) => setForm((f) => ({ ...f, sutherlandS }))} />
            </div>
          )}
          {form.viscosityModel === "table" && (
            <div style={{ marginTop: 8 }}>
              <div style={miniLabel}>Viscosity table</div>
              {(form.viscosityTable ?? []).map((row, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 34px", gap: 8, alignItems: "end", marginBottom: 6 }}>
                  <UnitNumberField label="T" dimension="temperature" valueSi={row.temperatureK} min={0} onChangeSi={(temperatureK) => setTableRow(i, { temperatureK })} />
                  <NumberField label="μ [Pa·s]" value={row.dynamicViscosity} onChange={(dynamicViscosity) => setTableRow(i, { dynamicViscosity })} />
                  <button
                    type="button"
                    aria-label="Remove table point"
                    onClick={() => setForm((current) => ({ ...current, viscosityTable: (current.viscosityTable ?? []).filter((_, j) => j !== i).map((p, j) => ({ ...p, sortOrder: j })) }))}
                    style={{ ...ghostBtn, padding: 8 }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setForm((current) => ({ ...current, viscosityTable: [...(current.viscosityTable ?? []), { temperatureK: current.refTemperatureK, dynamicViscosity: current.constantDynamicViscosity ?? current.sutherlandMuRef ?? 1e-5, sortOrder: current.viscosityTable?.length ?? 0 }] }))}
                style={{ ...ghostBtn, width: "100%", marginTop: 4 }}
              >
                add table point
              </button>
            </div>
          )}
          <TextField label="Notes" value={form.notes ?? ""} onChange={(notes) => setForm((f) => ({ ...f, notes }))} />
          <button type="button" disabled={busy || !form.name.trim()} onClick={save} style={{ ...primaryBtn(busy), width: "100%", marginTop: 12 }}>
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
  solverProfiles: [],
  schedulingProfiles: [],
  outputProfiles: [],
  sweepDefinitions: [],
  airfoilOptions: [],
  simulationPresets: [],
};

type SetupTab = "presets" | "flow" | "referenceGeometry" | "boundary" | "mesh" | "solver" | "scheduling" | "output" | "sweeps";
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
];

const ALL_IMAGE_FIELDS = [
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity",
];
const IMAGE_FIELD_LABELS: Record<string, string> = {
  velocity_magnitude: "Velocity |U|",
  velocity_x: "Velocity Ux",
  velocity_y: "Velocity Uy",
  pressure: "Pressure p",
  pressure_coefficient: "Pressure Cp",
  vorticity: "Vorticity ωz",
  turbulent_kinetic_energy: "Turbulence k",
  turbulent_viscosity: "Turbulent viscosity νt",
};

const REFERENCE_GEOMETRY_TYPE_OPTIONS = [{ value: "airfoil_2d", label: "2D airfoil" }];
const REFERENCE_LENGTH_KIND_OPTIONS = [{ value: "chord", label: "Chord" }];
const MESH_MESHER_OPTIONS = [{ value: "blockmesh-cgrid", label: "C-grid blockMesh" }];

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
const defaultBoundaryForm = (): BoundaryProfileInput => ({ name: "", turbulenceIntensity: 0.001, viscosityRatio: 10, sandGrainHeight: 0, roughnessConstant: 0.5 });
const defaultMeshForm = (): MeshProfileInput => ({ name: "", mesher: "blockmesh-cgrid", farfieldRadiusChords: 15, wakeLengthChords: 12, nSurface: 130, nRadial: 80, nWake: 60, targetYPlus: 1, spanChords: 0.1 });
const defaultSolverForm = (): SolverProfileInput => ({ name: "", turbulenceModel: "kOmegaSST", nIterations: 3000, convergenceTolerance: 1e-5, momentumScheme: "linearUpwind", transientCycles: 10, transientDiscardFraction: 0.4, transientMaxCourant: 15 });
const defaultSchedulingForm = (): SchedulingProfileInput => ({ name: "", schedulingPolicy: "auto", cpuBudget: null, caseConcurrency: null, solverProcesses: null });
const defaultOutputForm = (): OutputProfileInput => ({ name: "", writeImages: [...ALL_IMAGE_FIELDS], imageZoomChords: 2 });
const defaultSweepForm = (): SweepDefinitionInput => ({ name: "", aoaStart: -8, aoaStop: 20, aoaStep: 1, aoaList: null });
const defaultPresetForm = (setup: AdminSimulationSetup): SimulationPresetInput => ({
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

function optionLabels<T extends { id: string; name: string }>(rows: T[], empty = "choose record") {
  return Object.fromEntries([["", empty], ...rows.map((row) => [row.id, row.name])]);
}

function optionValues<T extends { id: string }>(rows: T[]) {
  return ["", ...rows.map((row) => row.id)];
}

function setupOptionValues(options: { value: string }[], current: string) {
  const values = options.map((option) => option.value);
  return values.includes(current) ? values : [current, ...values];
}

function setupOptionLabels(options: { value: string; label: string }[], current: string) {
  return Object.fromEntries(setupOptionValues(options, current).map((value) => [value, options.find((option) => option.value === value)?.label ?? value]));
}

function shouldShowSetupOption(options: { value: string }[], current: string) {
  return options.length > 1 || !options.some((option) => option.value === current);
}

function SetupRecordList<T extends { id: string; name: string }>({
  items,
  selectedId,
  onSelect,
  describe,
  emptyText,
}: {
  items: T[];
  selectedId: string;
  onSelect: (item: T) => void;
  describe: (item: T) => string;
  emptyText: string;
}) {
  if (!items.length) return <div style={{ fontFamily: MONO, fontSize: 11, color: C.dim, padding: "10px 0" }}>{emptyText}</div>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item)}
          style={{
            width: "100%",
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 10,
            alignItems: "center",
            textAlign: "left",
            fontFamily: MONO,
            fontSize: 11,
            color: selectedId === item.id ? C.teal : C.muted,
            background: selectedId === item.id ? C.rowActive : "transparent",
            border: `1px solid ${selectedId === item.id ? C.tealBorder : C.stroke}`,
            borderRadius: 8,
            padding: "8px 10px",
            cursor: "pointer",
          }}
        >
          <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 }}>{describe(item)}</span>
        </button>
      ))}
    </div>
  );
}

function SimulationSetupPanel() {
  const [setup, setSetup] = useState<AdminSimulationSetup>(EMPTY_SETUP);
  const [mediumsList, setMediumsList] = useState<MediumDTO[]>([]);
  const [tab, setTab] = useState<SetupTab>("presets");
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

  const [flowForm, setFlowForm] = useState<FlowConditionInput>(defaultFlowForm());
  const [referenceGeometryForm, setReferenceGeometryForm] = useState<ReferenceGeometryProfileInput>(defaultReferenceGeometryForm());
  const [boundaryForm, setBoundaryForm] = useState<BoundaryProfileInput>(defaultBoundaryForm());
  const [meshForm, setMeshForm] = useState<MeshProfileInput>(defaultMeshForm());
  const [solverForm, setSolverForm] = useState<SolverProfileInput>(defaultSolverForm());
  const [schedulingForm, setSchedulingForm] = useState<SchedulingProfileInput>(defaultSchedulingForm());
  const [outputForm, setOutputForm] = useState<OutputProfileInput>(defaultOutputForm());
  const [sweepForm, setSweepForm] = useState<SweepDefinitionInput>(defaultSweepForm());
  const [presetForm, setPresetForm] = useState<SimulationPresetInput>(defaultPresetForm(EMPTY_SETUP));
  const [aoaListText, setAoaListText] = useState("");
  const [targetAirfoilQuery, setTargetAirfoilQuery] = useState("");

  const medium = mediumsList.find((m) => m.id === flowForm.mediumId) ?? mediumsList[0] ?? null;
  const selectedFlowForPreset = setup.flowConditions.find((row) => row.id === presetForm.flowConditionId);
  const selectedReferenceForPreset = setup.referenceGeometryProfiles.find((row) => row.id === presetForm.referenceGeometryProfileId);
  const presetPreview = selectedFlowForPreset && selectedReferenceForPreset
    ? {
        reynolds: (selectedFlowForPreset.speedMps * selectedReferenceForPreset.referenceLengthM) / selectedFlowForPreset.kinematicViscosity,
        mach: selectedFlowForPreset.mach,
      }
    : null;
  const flowPreview = medium ? previewFlow(medium, flowForm) : null;
  const selectedPreset = setup.simulationPresets.find((p) => p.id === presetId) ?? null;
  const presetReady =
    !!presetForm.name.trim() &&
    !!presetForm.flowConditionId &&
    !!presetForm.referenceGeometryProfileId &&
    !!presetForm.boundaryProfileId &&
    !!presetForm.meshProfileId &&
    !!presetForm.solverProfileId &&
    !!presetForm.schedulingProfileId &&
    !!presetForm.outputProfileId &&
    !!presetForm.sweepDefinitionId &&
    (presetForm.targetScope === "all" || presetForm.targetAirfoilIds.length > 0);

  const refresh = async () => {
    const [ms, data] = await Promise.all([getAdminMediums(), getAdminSimulationSetup()]);
    setMediumsList(ms.items);
    setSetup(data);
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
      flowConditionId: current.flowConditionId || data.flowConditions[0]?.id || "",
      referenceGeometryProfileId: current.referenceGeometryProfileId || data.referenceGeometryProfiles[0]?.id || "",
      boundaryProfileId: current.boundaryProfileId || data.boundaryProfiles[0]?.id || "",
      meshProfileId: current.meshProfileId || data.meshProfiles[0]?.id || "",
      solverProfileId: current.solverProfileId || data.solverProfiles[0]?.id || "",
      schedulingProfileId: current.schedulingProfileId || data.schedulingProfiles[0]?.id || "",
      outputProfileId: current.outputProfileId || data.outputProfiles[0]?.id || "",
      sweepDefinitionId: current.sweepDefinitionId || data.sweepDefinitions[0]?.id || "",
      targetScope: current.targetScope || "all",
      targetAirfoilIds: current.targetAirfoilIds ?? [],
    }));
    return data;
  };
  useEffect(() => {
    refresh().catch((e) => setErr((e as Error).message));
  }, []);

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
    setBoundaryForm({ name: row.name, turbulenceIntensity: row.turbulenceIntensity, viscosityRatio: row.viscosityRatio, sandGrainHeight: row.sandGrainHeight, roughnessConstant: row.roughnessConstant });
  };
  const selectMesh = (row: AdminMeshProfile) => {
    setMeshId(row.id);
    setMeshForm({ name: row.name, mesher: row.mesher, farfieldRadiusChords: row.farfieldRadiusChords, wakeLengthChords: row.wakeLengthChords, nSurface: row.nSurface, nRadial: row.nRadial, nWake: row.nWake, targetYPlus: row.targetYPlus, spanChords: row.spanChords });
  };
  const selectSolver = (row: AdminSolverProfile) => {
    setSolverId(row.id);
    setSolverForm({ name: row.name, turbulenceModel: row.turbulenceModel, nIterations: row.nIterations, convergenceTolerance: row.convergenceTolerance, momentumScheme: row.momentumScheme, transientCycles: row.transientCycles, transientDiscardFraction: row.transientDiscardFraction, transientMaxCourant: row.transientMaxCourant });
  };
  const selectScheduling = (row: AdminSchedulingProfile) => {
    setSchedulingId(row.id);
    setSchedulingForm({ name: row.name, schedulingPolicy: row.schedulingPolicy, cpuBudget: row.cpuBudget, caseConcurrency: row.caseConcurrency, solverProcesses: row.solverProcesses });
  };
  const selectOutput = (row: AdminOutputProfile) => {
    setOutputId(row.id);
    setOutputForm({ name: row.name, writeImages: row.writeImages, imageZoomChords: row.imageZoomChords });
  };
  const selectSweep = (row: AdminSweepDefinition) => {
    setSweepId(row.id);
    setSweepForm({ name: row.name, aoaStart: row.aoaStart, aoaStop: row.aoaStop, aoaStep: row.aoaStep, aoaList: row.aoaList });
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

  const saveFlow = () => runSave(async () => {
    const saved = flowId ? await updateFlowCondition(flowId, flowForm) : await createFlowCondition(flowForm);
    setFlowId(saved.id);
    selectFlow(saved);
    await refresh();
  });
  const saveReferenceGeometry = () => runSave(async () => {
    const saved = referenceGeometryId ? await updateReferenceGeometryProfile(referenceGeometryId, referenceGeometryForm) : await createReferenceGeometryProfile(referenceGeometryForm);
    setReferenceGeometryId(saved.id);
    selectReferenceGeometry(saved);
    await refresh();
  });
  const saveBoundary = () => runSave(async () => {
    const saved = boundaryId ? await updateBoundaryProfile(boundaryId, boundaryForm) : await createBoundaryProfile(boundaryForm);
    setBoundaryId(saved.id);
    selectBoundary(saved);
    await refresh();
  });
  const saveMesh = () => runSave(async () => {
    const saved = meshId ? await updateMeshProfile(meshId, meshForm) : await createMeshProfile(meshForm);
    setMeshId(saved.id);
    selectMesh(saved);
    await refresh();
  });
  const saveSolver = () => runSave(async () => {
    const saved = solverId ? await updateSolverProfile(solverId, solverForm) : await createSolverProfile(solverForm);
    setSolverId(saved.id);
    selectSolver(saved);
    await refresh();
  });
  const saveScheduling = () => runSave(async () => {
    const saved = schedulingId ? await updateSchedulingProfile(schedulingId, schedulingForm) : await createSchedulingProfile(schedulingForm);
    setSchedulingId(saved.id);
    selectScheduling(saved);
    await refresh();
  });
  const saveOutput = () => runSave(async () => {
    const body = { ...outputForm, writeImages: [...ALL_IMAGE_FIELDS] };
    const saved = outputId ? await updateOutputProfile(outputId, body) : await createOutputProfile(body);
    setOutputId(saved.id);
    selectOutput(saved);
    await refresh();
  });
  const saveSweep = () => runSave(async () => {
    const body = { ...sweepForm, aoaList: parseNumberList(aoaListText) };
    const saved = sweepId ? await updateSweepDefinition(sweepId, body) : await createSweepDefinition(body);
    setSweepId(saved.id);
    selectSweep(saved);
    await refresh();
  });
  const savePreset = () => runSave(async () => {
    const saved = presetId ? await updateSimulationPreset(presetId, presetForm) : await createSimulationPreset(presetForm);
    setPresetId(saved.id);
    selectPreset(saved);
    await refresh();
  });

  const tabButton = (item: { k: SetupTab; label: string }) => (
    <button
      key={item.k}
      type="button"
      onClick={() => setTab(item.k)}
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
      <SectionHeader title="Simulation Setup" subtitle="Reusable setup records compose named presets. Revisions are immutable snapshots used by queue jobs and results." />
      {err && <ErrorLine text={err} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>{SETUP_TABS.map(tabButton)}</div>
      {tab === "presets" && (
        <div className="admin-editor-grid">
          <div style={card}>
            <div style={label}>SIMULATION PRESETS</div>
            <SetupRecordList
              items={setup.simulationPresets}
              selectedId={presetId}
              onSelect={selectPreset}
              describe={(p) => {
                const flow = setup.flowConditions.find((row) => row.id === p.flowConditionId);
                const ref = setup.referenceGeometryProfiles.find((row) => row.id === p.referenceGeometryProfileId);
                const re = flow && ref ? formatRe((flow.speedMps * ref.referenceLengthM) / flow.kinematicViscosity) : "Re";
                const scope = p.targetScope === "airfoils" ? `${p.targetAirfoilIds.length} selected` : "all profiles";
                return `${flow?.mediumName ?? "medium"} · ${ref?.referenceLengthKind ?? "reference"} · ${re} · ${scope} · rev ${p.currentRevisionNumber ?? "—"} · ${p.enabled ? "on" : "off"}`;
              }}
              emptyText="No presets yet. Create the component records, then compose a preset here."
            />
          </div>
          <div style={card}>
            <EditorHeader text={selectedPreset ? "EDIT PRESET" : "ADD PRESET"} onNew={() => { setPresetId(""); setPresetForm(defaultPresetForm(setup)); setTargetAirfoilQuery(""); }} />
            <TextField label="Preset name" value={presetForm.name} onChange={(name) => setPresetForm((f) => ({ ...f, name }))} />
            {!selectedPreset && <TextField label="Slug optional" value={presetForm.slug ?? ""} onChange={(slug) => setPresetForm((f) => ({ ...f, slug }))} />}
            <SelectField label="Flow state" value={presetForm.flowConditionId} options={optionValues(setup.flowConditions)} optionLabels={optionLabels(setup.flowConditions)} onChange={(flowConditionId) => setPresetForm((f) => ({ ...f, flowConditionId }))} />
            <SelectField label="Reference geometry" value={presetForm.referenceGeometryProfileId} options={optionValues(setup.referenceGeometryProfiles)} optionLabels={optionLabels(setup.referenceGeometryProfiles)} onChange={(referenceGeometryProfileId) => setPresetForm((f) => ({ ...f, referenceGeometryProfileId }))} />
            <SelectField label="Boundary profile" value={presetForm.boundaryProfileId} options={optionValues(setup.boundaryProfiles)} optionLabels={optionLabels(setup.boundaryProfiles)} onChange={(boundaryProfileId) => setPresetForm((f) => ({ ...f, boundaryProfileId }))} />
            <SelectField label="Mesh profile" value={presetForm.meshProfileId} options={optionValues(setup.meshProfiles)} optionLabels={optionLabels(setup.meshProfiles)} onChange={(meshProfileId) => setPresetForm((f) => ({ ...f, meshProfileId }))} />
            <SelectField label="Solver profile" value={presetForm.solverProfileId} options={optionValues(setup.solverProfiles)} optionLabels={optionLabels(setup.solverProfiles)} onChange={(solverProfileId) => setPresetForm((f) => ({ ...f, solverProfileId }))} />
            <SelectField label="Scheduling profile" value={presetForm.schedulingProfileId} options={optionValues(setup.schedulingProfiles)} optionLabels={optionLabels(setup.schedulingProfiles)} onChange={(schedulingProfileId) => setPresetForm((f) => ({ ...f, schedulingProfileId }))} />
            <SelectField label="Output profile" value={presetForm.outputProfileId} options={optionValues(setup.outputProfiles)} optionLabels={optionLabels(setup.outputProfiles)} onChange={(outputProfileId) => setPresetForm((f) => ({ ...f, outputProfileId }))} />
            <SelectField label="Sweep definition" value={presetForm.sweepDefinitionId} options={optionValues(setup.sweepDefinitions)} optionLabels={optionLabels(setup.sweepDefinitions)} onChange={(sweepDefinitionId) => setPresetForm((f) => ({ ...f, sweepDefinitionId }))} />
            <SelectField
              label="Run scope"
              value={presetForm.targetScope}
              options={["all", "airfoils"]}
              optionLabels={{ all: "all profiles", airfoils: "selected profiles" }}
              onChange={(targetScope) => setPresetForm((f) => ({ ...f, targetScope: targetScope as SimulationPresetInput["targetScope"] }))}
            />
            {presetForm.targetScope === "airfoils" && (
              <PresetAirfoilPicker
                airfoils={setup.airfoilOptions}
                selectedIds={presetForm.targetAirfoilIds}
                query={targetAirfoilQuery}
                onQuery={setTargetAirfoilQuery}
                onChange={(targetAirfoilIds) => setPresetForm((f) => ({ ...f, targetAirfoilIds }))}
              />
            )}
            <SelectField label="Enabled" value={presetForm.enabled ? "yes" : "no"} options={["yes", "no"]} onChange={(v) => setPresetForm((f) => ({ ...f, enabled: v === "yes" }))} />
            <div className="admin-metric-grid" style={{ marginTop: 10 }}>
              <MetricChip label="Derived Re" value={presetPreview ? formatRe(presetPreview.reynolds) : "—"} />
              <MetricChip label="Derived Mach" value={presetPreview ? f(presetPreview.mach, 3) : "—"} />
            </div>
            <button type="button" disabled={busy || !presetReady} onClick={savePreset} style={{ ...primaryBtn(busy || !presetReady), width: "100%", marginTop: 12 }}>
              {busy ? "saving…" : selectedPreset ? "save simulation preset" : "add simulation preset"}
            </button>
          </div>
        </div>
      )}
      {tab === "flow" && (
        <div className="admin-editor-grid">
          <div style={card}>
            <div style={label}>FLOW STATES</div>
            <SetupRecordList items={setup.flowConditions} selectedId={flowId} onSelect={selectFlow} describe={(o) => `${o.mediumName} · ${fSpeed(o.speedMps)} · M ${f(o.mach, 3)}`} emptyText="No flow states yet." />
          </div>
          <div style={card}>
            <EditorHeader text={flowId ? "EDIT FLOW STATE" : "ADD FLOW STATE"} onNew={() => { setFlowId(""); setFlowForm(defaultFlowForm(mediumsList[0])); }} />
            <TextField label="Name" value={flowForm.name} onChange={(name) => setFlowForm((f) => ({ ...f, name }))} />
            {!flowId && <TextField label="Slug optional" value={flowForm.slug ?? ""} onChange={(slug) => setFlowForm((f) => ({ ...f, slug }))} />}
            <SelectField label="Medium" value={flowForm.mediumId} options={mediumsList.map((m) => m.id)} optionLabels={Object.fromEntries(mediumsList.map((m) => [m.id, m.name]))} onChange={(mediumId) => {
              const m = mediumsList.find((item) => item.id === mediumId);
              setFlowForm((f) => ({ ...f, mediumId, temperatureK: m?.refTemperatureK ?? f.temperatureK, pressurePa: m?.refPressurePa ?? f.pressurePa }));
            }} />
            <div className="admin-form-grid">
              <UnitNumberField label="Temperature" dimension="temperature" valueSi={flowForm.temperatureK} min={0} onChangeSi={(temperatureK) => setFlowForm((f) => ({ ...f, temperatureK }))} />
              <UnitNumberField label="Pressure" dimension="pressure" valueSi={flowForm.pressurePa} min={0} onChangeSi={(pressurePa) => setFlowForm((f) => ({ ...f, pressurePa }))} />
              <UnitNumberField label="Speed" dimension="speed" valueSi={flowForm.speedMps} min={0} onChangeSi={(speedMps) => setFlowForm((f) => ({ ...f, speedMps }))} />
            </div>
            <div className="admin-metric-grid" style={{ marginTop: 10 }}>
              <MetricChip label="Derived Mach" value={flowPreview ? f(flowPreview.mach, 3) : "—"} />
              <MetricChip label="ρ" value={flowPreview ? f(flowPreview.density, 4) : "—"} />
              <MetricChip label="ν" value={flowPreview ? fSci(flowPreview.kinematicViscosity, 2) : "—"} />
            </div>
            <button type="button" disabled={busy || !flowForm.name.trim() || !flowForm.mediumId} onClick={saveFlow} style={{ ...primaryBtn(busy || !flowForm.name.trim() || !flowForm.mediumId), width: "100%", marginTop: 12 }}>
              {busy ? "saving…" : flowId ? "save flow state" : "add flow state"}
            </button>
          </div>
        </div>
      )}
      {tab === "referenceGeometry" && (
        <div className="admin-editor-grid">
          <div style={card}>
            <div style={label}>REFERENCE GEOMETRY</div>
            <SetupRecordList items={setup.referenceGeometryProfiles} selectedId={referenceGeometryId} onSelect={selectReferenceGeometry} describe={(g) => `${g.geometryType} · ${g.referenceLengthKind} ${f(g.referenceLengthM, 3)} m`} emptyText="No reference geometry profiles yet." />
          </div>
          <div style={card}>
            <EditorHeader text={referenceGeometryId ? "EDIT REFERENCE GEOMETRY" : "ADD REFERENCE GEOMETRY"} onNew={() => { setReferenceGeometryId(""); setReferenceGeometryForm(defaultReferenceGeometryForm()); }} />
            <TextField label="Name" value={referenceGeometryForm.name} onChange={(name) => setReferenceGeometryForm((g) => ({ ...g, name }))} />
            {!referenceGeometryId && <TextField label="Slug optional" value={referenceGeometryForm.slug ?? ""} onChange={(slug) => setReferenceGeometryForm((g) => ({ ...g, slug }))} />}
            {shouldShowSetupOption(REFERENCE_GEOMETRY_TYPE_OPTIONS, referenceGeometryForm.geometryType) && (
              <SelectField
                label="Geometry type"
                value={referenceGeometryForm.geometryType}
                options={setupOptionValues(REFERENCE_GEOMETRY_TYPE_OPTIONS, referenceGeometryForm.geometryType)}
                optionLabels={setupOptionLabels(REFERENCE_GEOMETRY_TYPE_OPTIONS, referenceGeometryForm.geometryType)}
                onChange={(geometryType) => setReferenceGeometryForm((g) => ({ ...g, geometryType }))}
              />
            )}
            {shouldShowSetupOption(REFERENCE_LENGTH_KIND_OPTIONS, referenceGeometryForm.referenceLengthKind) && (
              <SelectField
                label="Reference length kind"
                value={referenceGeometryForm.referenceLengthKind}
                options={setupOptionValues(REFERENCE_LENGTH_KIND_OPTIONS, referenceGeometryForm.referenceLengthKind)}
                optionLabels={setupOptionLabels(REFERENCE_LENGTH_KIND_OPTIONS, referenceGeometryForm.referenceLengthKind)}
                onChange={(referenceLengthKind) => setReferenceGeometryForm((g) => ({ ...g, referenceLengthKind }))}
              />
            )}
            <div className="admin-form-grid">
              <UnitNumberField label="Reference length" dimension="length" valueSi={referenceGeometryForm.referenceLengthM} min={0} onChangeSi={(referenceLengthM) => setReferenceGeometryForm((g) => ({ ...g, referenceLengthM }))} />
              <UnitNumberField label="Span" dimension="length" valueSi={referenceGeometryForm.spanM ?? 0} min={0} onChangeSi={(spanM) => setReferenceGeometryForm((g) => ({ ...g, spanM: spanM > 0 ? spanM : null }))} />
              <NumberField label="Reference area m^2" value={referenceGeometryForm.referenceAreaM2 ?? 0} onChange={(referenceAreaM2) => setReferenceGeometryForm((g) => ({ ...g, referenceAreaM2: referenceAreaM2 > 0 ? referenceAreaM2 : null }))} />
            </div>
            <button type="button" disabled={busy || !referenceGeometryForm.name.trim()} onClick={saveReferenceGeometry} style={{ ...primaryBtn(busy || !referenceGeometryForm.name.trim()), width: "100%", marginTop: 12 }}>
              {busy ? "saving…" : referenceGeometryId ? "save reference geometry" : "add reference geometry"}
            </button>
          </div>
        </div>
      )}
      {tab === "boundary" && (
        <ProfileEditorShell title="BOUNDARY PROFILES" items={setup.boundaryProfiles} selectedId={boundaryId} onSelect={selectBoundary} describe={(b) => `Tu ${f(b.turbulenceIntensity, 4)} · νt/ν ${f(b.viscosityRatio, 1)}`} emptyText="No boundary profiles yet.">
          <EditorHeader text={boundaryId ? "EDIT BOUNDARY PROFILE" : "ADD BOUNDARY PROFILE"} onNew={() => { setBoundaryId(""); setBoundaryForm(defaultBoundaryForm()); }} />
          <TextField label="Name" value={boundaryForm.name} onChange={(name) => setBoundaryForm((f) => ({ ...f, name }))} />
          {!boundaryId && <TextField label="Slug optional" value={boundaryForm.slug ?? ""} onChange={(slug) => setBoundaryForm((f) => ({ ...f, slug }))} />}
          <div className="admin-form-grid">
            <NumberField label="Turbulence intensity" value={boundaryForm.turbulenceIntensity} onChange={(turbulenceIntensity) => setBoundaryForm((f) => ({ ...f, turbulenceIntensity }))} />
            <NumberField label="Viscosity ratio" value={boundaryForm.viscosityRatio} onChange={(viscosityRatio) => setBoundaryForm((f) => ({ ...f, viscosityRatio }))} />
            <NumberField label="Roughness Ks" value={boundaryForm.sandGrainHeight} onChange={(sandGrainHeight) => setBoundaryForm((f) => ({ ...f, sandGrainHeight }))} />
            <NumberField label="Roughness constant" value={boundaryForm.roughnessConstant} onChange={(roughnessConstant) => setBoundaryForm((f) => ({ ...f, roughnessConstant }))} />
          </div>
          <button type="button" disabled={busy || !boundaryForm.name.trim()} onClick={saveBoundary} style={{ ...primaryBtn(busy || !boundaryForm.name.trim()), width: "100%", marginTop: 12 }}>{busy ? "saving…" : boundaryId ? "save boundary profile" : "add boundary profile"}</button>
        </ProfileEditorShell>
      )}
      {tab === "mesh" && (
        <ProfileEditorShell title="MESH PROFILES" items={setup.meshProfiles} selectedId={meshId} onSelect={selectMesh} describe={(m) => `${m.mesher} · ${m.nSurface}/${m.nRadial}/${m.nWake}`} emptyText="No mesh profiles yet.">
          <EditorHeader text={meshId ? "EDIT MESH PROFILE" : "ADD MESH PROFILE"} onNew={() => { setMeshId(""); setMeshForm(defaultMeshForm()); }} />
          <TextField label="Name" value={meshForm.name} onChange={(name) => setMeshForm((f) => ({ ...f, name }))} />
          {!meshId && <TextField label="Slug optional" value={meshForm.slug ?? ""} onChange={(slug) => setMeshForm((f) => ({ ...f, slug }))} />}
          {shouldShowSetupOption(MESH_MESHER_OPTIONS, meshForm.mesher) && (
            <SelectField
              label="Mesher"
              value={meshForm.mesher}
              options={setupOptionValues(MESH_MESHER_OPTIONS, meshForm.mesher)}
              optionLabels={setupOptionLabels(MESH_MESHER_OPTIONS, meshForm.mesher)}
              onChange={(mesher) => setMeshForm((f) => ({ ...f, mesher }))}
            />
          )}
          <div className="admin-form-grid">
            <NumberField label="Farfield chords" value={meshForm.farfieldRadiusChords} onChange={(farfieldRadiusChords) => setMeshForm((f) => ({ ...f, farfieldRadiusChords }))} />
            <NumberField label="Wake chords" value={meshForm.wakeLengthChords} onChange={(wakeLengthChords) => setMeshForm((f) => ({ ...f, wakeLengthChords }))} />
            <NumberField label="Surface cells" value={meshForm.nSurface} onChange={(nSurface) => setMeshForm((f) => ({ ...f, nSurface }))} />
            <NumberField label="Radial cells" value={meshForm.nRadial} onChange={(nRadial) => setMeshForm((f) => ({ ...f, nRadial }))} />
            <NumberField label="Wake cells" value={meshForm.nWake} onChange={(nWake) => setMeshForm((f) => ({ ...f, nWake }))} />
            <NumberField label="Target y+" value={meshForm.targetYPlus} onChange={(targetYPlus) => setMeshForm((f) => ({ ...f, targetYPlus }))} />
            <NumberField label="Span chords" value={meshForm.spanChords} onChange={(spanChords) => setMeshForm((f) => ({ ...f, spanChords }))} />
          </div>
          <button type="button" disabled={busy || !meshForm.name.trim()} onClick={saveMesh} style={{ ...primaryBtn(busy || !meshForm.name.trim()), width: "100%", marginTop: 12 }}>{busy ? "saving…" : meshId ? "save mesh profile" : "add mesh profile"}</button>
        </ProfileEditorShell>
      )}
      {tab === "solver" && (
        <ProfileEditorShell title="SOLVER PROFILES" items={setup.solverProfiles} selectedId={solverId} onSelect={selectSolver} describe={(s) => `${s.turbulenceModel} · ${s.nIterations} iters · ${s.transientCycles} cycles`} emptyText="No solver profiles yet.">
          <EditorHeader text={solverId ? "EDIT SOLVER PROFILE" : "ADD SOLVER PROFILE"} onNew={() => { setSolverId(""); setSolverForm(defaultSolverForm()); }} />
          <TextField label="Name" value={solverForm.name} onChange={(name) => setSolverForm((f) => ({ ...f, name }))} />
          {!solverId && <TextField label="Slug optional" value={solverForm.slug ?? ""} onChange={(slug) => setSolverForm((f) => ({ ...f, slug }))} />}
          <div className="admin-form-grid">
            <SelectField label="Turbulence model" value={solverForm.turbulenceModel} options={["kOmegaSST", "kOmegaSSTLM", "kOmega", "kEpsilon", "SpalartAllmaras"]} onChange={(turbulenceModel) => setSolverForm((f) => ({ ...f, turbulenceModel }))} />
            <NumberField label="Iterations" value={solverForm.nIterations} onChange={(nIterations) => setSolverForm((f) => ({ ...f, nIterations }))} />
            <NumberField label="Tolerance" value={solverForm.convergenceTolerance} onChange={(convergenceTolerance) => setSolverForm((f) => ({ ...f, convergenceTolerance }))} />
            <TextField label="Momentum scheme" value={solverForm.momentumScheme} onChange={(momentumScheme) => setSolverForm((f) => ({ ...f, momentumScheme }))} />
            <NumberField label="URANS cycles" value={solverForm.transientCycles} onChange={(transientCycles) => setSolverForm((f) => ({ ...f, transientCycles }))} />
            <NumberField label="URANS discard" value={solverForm.transientDiscardFraction} onChange={(transientDiscardFraction) => setSolverForm((f) => ({ ...f, transientDiscardFraction }))} />
            <NumberField label="URANS max Co" value={solverForm.transientMaxCourant} onChange={(transientMaxCourant) => setSolverForm((f) => ({ ...f, transientMaxCourant }))} />
          </div>
          <button type="button" disabled={busy || !solverForm.name.trim()} onClick={saveSolver} style={{ ...primaryBtn(busy || !solverForm.name.trim()), width: "100%", marginTop: 12 }}>{busy ? "saving…" : solverId ? "save solver profile" : "add solver profile"}</button>
        </ProfileEditorShell>
      )}
      {tab === "scheduling" && (
        <ProfileEditorShell title="SCHEDULING PROFILES" items={setup.schedulingProfiles} selectedId={schedulingId} onSelect={selectScheduling} describe={(s) => schedulingSummary({ schedulingPolicy: s.schedulingPolicy, cpuBudget: s.cpuBudget, caseConcurrency: s.caseConcurrency, solverProcesses: s.solverProcesses })} emptyText="No scheduling profiles yet.">
          <EditorHeader text={schedulingId ? "EDIT SCHEDULING PROFILE" : "ADD SCHEDULING PROFILE"} onNew={() => { setSchedulingId(""); setSchedulingForm(defaultSchedulingForm()); }} />
          <TextField label="Name" value={schedulingForm.name} onChange={(name) => setSchedulingForm((f) => ({ ...f, name }))} />
          {!schedulingId && <TextField label="Slug optional" value={schedulingForm.slug ?? ""} onChange={(slug) => setSchedulingForm((f) => ({ ...f, slug }))} />}
          <div className="admin-form-grid">
            <SelectField label="CPU policy" value={schedulingForm.schedulingPolicy} options={["auto", "airfoil_parallel", "case_parallel", "exclusive"]} optionLabels={{ auto: "auto", airfoil_parallel: "airfoil parallel", case_parallel: "case parallel", exclusive: "exclusive" }} onChange={(schedulingPolicy) => setSchedulingForm((f) => ({ ...f, schedulingPolicy: schedulingPolicy as SchedulingProfileInput["schedulingPolicy"] }))} />
            <OptionalNumberField label="CPU budget" value={schedulingForm.cpuBudget} onChange={(cpuBudget) => setSchedulingForm((f) => ({ ...f, cpuBudget }))} />
            <OptionalNumberField label="AoA concurrency" value={schedulingForm.caseConcurrency} onChange={(caseConcurrency) => setSchedulingForm((f) => ({ ...f, caseConcurrency }))} />
            <OptionalNumberField label="Solver processes" value={schedulingForm.solverProcesses} onChange={(solverProcesses) => setSchedulingForm((f) => ({ ...f, solverProcesses }))} />
          </div>
          <button type="button" disabled={busy || !schedulingForm.name.trim()} onClick={saveScheduling} style={{ ...primaryBtn(busy || !schedulingForm.name.trim()), width: "100%", marginTop: 12 }}>{busy ? "saving…" : schedulingId ? "save scheduling profile" : "add scheduling profile"}</button>
        </ProfileEditorShell>
      )}
      {tab === "output" && (
        <ProfileEditorShell title="OUTPUT PROFILES" items={setup.outputProfiles} selectedId={outputId} onSelect={selectOutput} describe={(o) => `${ALL_IMAGE_FIELDS.length} default fields · zoom ${f(o.imageZoomChords, 1)}c`} emptyText="No output profiles yet.">
          <EditorHeader text={outputId ? "EDIT OUTPUT PROFILE" : "ADD OUTPUT PROFILE"} onNew={() => { setOutputId(""); setOutputForm(defaultOutputForm()); }} />
          <TextField label="Name" value={outputForm.name} onChange={(name) => setOutputForm((f) => ({ ...f, name }))} />
          {!outputId && <TextField label="Slug optional" value={outputForm.slug ?? ""} onChange={(slug) => setOutputForm((f) => ({ ...f, slug }))} />}
          <div className="admin-field-panel">
            <div className="label">Default stored fields</div>
            <div className="field-chip-grid">
              {ALL_IMAGE_FIELDS.map((field) => (
                <span key={field} className="field-chip">{IMAGE_FIELD_LABELS[field] ?? field}</span>
              ))}
            </div>
          </div>
          <NumberField label="Image zoom chords" value={outputForm.imageZoomChords} onChange={(imageZoomChords) => setOutputForm((f) => ({ ...f, imageZoomChords }))} />
          <button type="button" disabled={busy || !outputForm.name.trim()} onClick={saveOutput} style={{ ...primaryBtn(busy || !outputForm.name.trim()), width: "100%", marginTop: 12 }}>{busy ? "saving…" : outputId ? "save output profile" : "add output profile"}</button>
        </ProfileEditorShell>
      )}
      {tab === "sweeps" && (
        <ProfileEditorShell title="SWEEP DEFINITIONS" items={setup.sweepDefinitions} selectedId={sweepId} onSelect={selectSweep} describe={(s) => s.aoaList?.length ? `${s.aoaList.length} listed AoAs` : `${aoaSpan(s.aoaStart, s.aoaStop)} step ${s.aoaStep}`} emptyText="No sweep definitions yet.">
          <EditorHeader text={sweepId ? "EDIT SWEEP DEFINITION" : "ADD SWEEP DEFINITION"} onNew={() => { setSweepId(""); setSweepForm(defaultSweepForm()); setAoaListText(""); }} />
          <TextField label="Name" value={sweepForm.name} onChange={(name) => setSweepForm((f) => ({ ...f, name }))} />
          {!sweepId && <TextField label="Slug optional" value={sweepForm.slug ?? ""} onChange={(slug) => setSweepForm((f) => ({ ...f, slug }))} />}
          <div className="admin-form-grid">
            <NumberField label="AoA start" value={sweepForm.aoaStart} onChange={(aoaStart) => setSweepForm((f) => ({ ...f, aoaStart }))} />
            <NumberField label="AoA stop" value={sweepForm.aoaStop} onChange={(aoaStop) => setSweepForm((f) => ({ ...f, aoaStop }))} />
            <NumberField label="AoA step" value={sweepForm.aoaStep} onChange={(aoaStep) => setSweepForm((f) => ({ ...f, aoaStep }))} />
          </div>
          <TextField label="Explicit AoA list optional" value={aoaListText} onChange={setAoaListText} />
          <button type="button" disabled={busy || !sweepForm.name.trim()} onClick={saveSweep} style={{ ...primaryBtn(busy || !sweepForm.name.trim()), width: "100%", marginTop: 12 }}>{busy ? "saving…" : sweepId ? "save sweep definition" : "add sweep definition"}</button>
        </ProfileEditorShell>
      )}
    </div>
  );
}

function EditorHeader({ text, onNew }: { text: string; onNew: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <div style={label}>{text}</div>
      <button type="button" onClick={onNew} style={{ ...ghostBtn, padding: "5px 8px", fontSize: 10 }}>
        new
      </button>
    </div>
  );
}

function ProfileEditorShell<T extends { id: string; name: string }>({
  title,
  items,
  selectedId,
  onSelect,
  describe,
  emptyText,
  children,
}: {
  title: string;
  items: T[];
  selectedId: string;
  onSelect: (item: T) => void;
  describe: (item: T) => string;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <div className="admin-editor-grid">
      <div style={card}>
        <div style={label}>{title}</div>
        <SetupRecordList items={items} selectedId={selectedId} onSelect={onSelect} describe={describe} emptyText={emptyText} />
      </div>
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
    .filter((airfoil) => !q || airfoil.name.toLowerCase().includes(q) || airfoil.slug.toLowerCase().includes(q))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.name.localeCompare(b.name))
    .slice(0, 80);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
      <label style={{ display: "grid", gap: 5, fontFamily: MONO, fontSize: 11, color: C.dim }}>
        <span>Profiles <span data-testid="preset-airfoil-selected-count" style={{ color: C.teal }}>{selectedIds.length} selected</span></span>
        <input
          data-testid="preset-airfoil-search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="search profiles..."
          style={inputStyle}
        />
      </label>
      <div data-testid="preset-airfoil-picker" style={{ maxHeight: 210, overflow: "auto", display: "grid", gap: 5, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: 8 }}>
        {visible.length === 0 ? (
          <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>no profiles match</span>
        ) : visible.map((airfoil) => {
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
              <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, border: `1px solid ${checked ? C.teal : C.dim}`, background: checked ? C.teal : "transparent" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{airfoil.name}</span>
            </button>
          );
        })}
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
    remoteSolverHeartbeatIntervalSeconds: state.settings.remoteSolverHeartbeatIntervalSeconds,
    permissions: state.permissions.map((permission) => ({ ...permission })),
  };
}

function SyncApiPanel() {
  const [state, setState] = useState<AdminSyncState | null>(null);
  const [draft, setDraft] = useState<SyncDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        remoteSolverHeartbeatIntervalSeconds: Number(draft.remoteSolverHeartbeatIntervalSeconds),
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

  const runMirror = async (mode?: "full" | "db_only_remote_assets") => {
    setBusy(true);
    setErr(null);
    try {
      const next = await runUpstreamSync({ mode: mode ?? draft?.syncMode, limit: 200 });
      setState(next);
      setDraft(syncDraftFromState(next));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updatePermission = (dataType: AdminSyncPermission["dataType"], patch: Partial<Pick<AdminSyncPermission, "canFetch" | "canPush">>) => {
    setDraft((current) => current && {
      ...current,
      permissions: current.permissions.map((permission) => (
        permission.dataType === dataType ? { ...permission, ...patch } : permission
      )),
    });
  };

  const resolveConflict = async (id: string, action: "archive" | "promote") => {
    setBusy(true);
    setErr(null);
    try {
      const next = action === "archive" ? await archiveSyncConflict(id) : await promoteSyncConflict(id);
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
      <SectionHeader title="Sync API" subtitle="Cross-instance claims, imports, and evidence exchange." />
      {err && <ErrorLine text={err} />}
      {!draft || !state ? (
        <div style={card}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>Loading sync settings…</div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={card}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "start" }}>
              <div>
                <div style={label}>INBOUND API</div>
                <a href={`${endpoint}/status`} target="_blank" rel="noreferrer" style={{ color: C.teal, fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>
                  {endpoint}
                </a>
                <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 10, color: C.dim }}>
                  instance {state.settings.instanceId}
                </div>
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 12, color: draft.enabled ? C.teal : C.muted }}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft((current) => current && { ...current, enabled: e.target.checked })}
                />
                enabled
              </label>
            </div>
            <div className="admin-form-grid" style={{ marginTop: 12 }}>
              <TextField label="Instance name" value={draft.instanceName} onChange={(instanceName) => setDraft((current) => current && { ...current, instanceName })} />
              <TextField label="Secret" value={draft.secret} onChange={(secret) => setDraft((current) => current && { ...current, secret })} />
              <TextField
                label="Public endpoint override"
                value={draft.publicEndpointOverride}
                onChange={(publicEndpointOverride) => setDraft((current) => current && { ...current, publicEndpointOverride })}
              />
              <NumberField
                label="Promise TTL hours"
                value={draft.defaultPromiseTtlHours}
                onChange={(defaultPromiseTtlHours) => setDraft((current) => current && { ...current, defaultPromiseTtlHours })}
              />
            </div>
	            <button type="button" disabled={busy} onClick={save} style={{ ...primaryBtn(busy), marginTop: 12 }}>
	              {busy ? "saving…" : "save sync settings"}
	            </button>
	          </div>

	          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 0.85fr)", gap: 14 }}>
	            <div style={card}>
	              <div style={label}>UP-TIER CONNECTION</div>
	              <div className="admin-form-grid">
	                <TextField label="Up-tier endpoint" value={draft.upstreamBaseUrl} onChange={(upstreamBaseUrl) => setDraft((current) => current && { ...current, upstreamBaseUrl })} />
	                <TextField label="Up-tier secret" value={draft.upstreamSecret} onChange={(upstreamSecret) => setDraft((current) => current && { ...current, upstreamSecret })} />
	                <SelectField
	                  label="Sync mode"
	                  value={draft.syncMode}
	                  options={["full", "db_only_remote_assets"]}
	                  optionLabels={{ full: "full DB + media", db_only_remote_assets: "DB + remote media refs" }}
	                  onChange={(syncMode) => setDraft((current) => current && { ...current, syncMode: syncMode as SyncDraft["syncMode"] })}
	                />
	                <NumberField label="Remote solver CPUs" value={draft.remoteSolverCpuBudget} onChange={(remoteSolverCpuBudget) => setDraft((current) => current && { ...current, remoteSolverCpuBudget })} />
	                <NumberField label="Claim size" value={draft.remoteSolverClaimSize} onChange={(remoteSolverClaimSize) => setDraft((current) => current && { ...current, remoteSolverClaimSize })} />
	                <NumberField label="Heartbeat seconds" value={draft.remoteSolverHeartbeatIntervalSeconds} onChange={(remoteSolverHeartbeatIntervalSeconds) => setDraft((current) => current && { ...current, remoteSolverHeartbeatIntervalSeconds })} />
	              </div>
	              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
	                <button type="button" disabled={busy || !draft.upstreamBaseUrl.trim()} onClick={() => runMirror("db_only_remote_assets")} style={{ ...ghostBtn, padding: "8px 10px" }}>
	                  sync DB + remote refs
	                </button>
	                <button type="button" disabled={busy || !draft.upstreamBaseUrl.trim()} onClick={() => runMirror("full")} style={{ ...ghostBtn, padding: "8px 10px" }}>
	                  full sync
	                </button>
	                <button type="button" disabled={busy} onClick={save} style={{ ...primaryBtn(busy) }}>
	                  save connection
	                </button>
	              </div>
	            </div>
	            <div style={card}>
	              <div style={label}>REMOTE SOLVER</div>
	              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 12, color: draft.remoteSolverEnabled ? C.teal : C.muted }}>
	                <input
	                  type="checkbox"
	                  checked={draft.remoteSolverEnabled}
	                  onChange={(e) => setDraft((current) => current && { ...current, remoteSolverEnabled: e.target.checked })}
	                />
	                enabled
	              </label>
	              <div style={{ display: "grid", gap: 8, marginTop: 12, fontFamily: MONO, fontSize: 12 }}>
	                <MetricChip label="Status" value={state.settings.remoteSolverLastStatus} />
	                <MetricChip label="Registered id" value={state.settings.remoteSolverRegisteredId?.slice(0, 8) ?? "—"} />
	                <MetricChip label="Last sync" value={ago(state.settings.remoteSolverLastSyncAt)} />
	                <MetricChip label="Last claim" value={ago(state.settings.remoteSolverLastPromiseAt)} />
	                <MetricChip label="Last push" value={ago(state.settings.remoteSolverLastPushAt)} />
	              </div>
	              {state.settings.remoteSolverLastError && (
	                <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 11, color: C.redText }}>{state.settings.remoteSolverLastError}</div>
	              )}
	            </div>
	          </div>

	          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 0.7fr)", gap: 14 }}>
	            <div style={card}>
	              <div style={label}>PERMISSIONS</div>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(130px, 1fr) 72px 72px", gap: 8, fontFamily: MONO, fontSize: 10, color: C.dim }}>
                  <span>Data</span>
                  <span>Fetch</span>
                  <span>Push</span>
                </div>
                {draft.permissions.map((permission) => (
                  <div key={permission.dataType} style={{ display: "grid", gridTemplateColumns: "minmax(130px, 1fr) 72px 72px", gap: 8, alignItems: "center", borderTop: `1px solid ${C.borderSoft}`, paddingTop: 7 }}>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{SYNC_DATA_TYPE_LABELS[permission.dataType]}</span>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 11, color: C.dim }}>
                      <input type="checkbox" checked={permission.canFetch} onChange={(e) => updatePermission(permission.dataType, { canFetch: e.target.checked })} />
                      allow
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 11, color: C.dim }}>
                      <input type="checkbox" checked={permission.canPush} onChange={(e) => updatePermission(permission.dataType, { canPush: e.target.checked })} />
                      allow
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div style={card}>
              <div style={label}>PROMISES</div>
              <div style={{ display: "grid", gap: 8, fontFamily: MONO, fontSize: 12 }}>
                {["active", "fulfilled", "expired", "cancelled"].map((status) => (
                  <div key={status} style={{ display: "flex", justifyContent: "space-between", gap: 10, borderBottom: `1px solid ${C.borderSoft}`, paddingBottom: 7 }}>
                    <span style={{ color: C.dim }}>{status}</span>
                    <span style={{ color: status === "active" ? C.teal : C.text }}>
                      {state.promises.byStatus[status] ?? 0} · {state.promises.pointsByStatus[status] ?? 0} AoAs
                    </span>
                  </div>
                ))}
	              </div>
	            </div>
	          </div>

	          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 0.5fr)", gap: 14 }}>
	            <div style={card}>
	              <div style={label}>REGISTERED REMOTE SOLVERS</div>
	              {state.registeredSolvers.length === 0 ? (
	                <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>No remote solvers have registered.</div>
	              ) : (
	                <div style={{ display: "grid", gap: 8 }}>
	                  {state.registeredSolvers.map((solver) => (
	                    <div key={solver.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center", borderTop: `1px solid ${C.borderSoft}`, paddingTop: 8 }}>
	                      <div style={{ minWidth: 0 }}>
	                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontFamily: MONO }}>
	                          <strong style={{ color: C.text, fontSize: 12 }}>{solver.instanceName}</strong>
	                          <span style={{ color: solver.status === "error" ? C.redText : solver.status === "solving" || solver.status === "pushing" ? C.amber : C.teal, fontSize: 11 }}>{solver.status}</span>
	                          <span style={{ color: C.dim, fontSize: 10 }}>heartbeat {ago(solver.lastHeartbeatAt)}</span>
	                        </div>
	                        <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 10, color: C.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
	                          {solver.publicEndpoint ?? solver.localEndpoint ?? solver.instanceId}
	                        </div>
	                        {solver.recentError && <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 10, color: C.redText }}>{solver.recentError}</div>}
	                      </div>
	                      <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, textAlign: "right" }}>
	                        <div>{solver.cpuBudget}/{solver.cpuCapacity} CPU</div>
	                        <div>{solver.activePromiseCount} promises · {solver.activeAoaCount} AoAs</div>
	                        <div>{solver.solvedCount} solved · {solver.pushedCount} pushed</div>
	                      </div>
	                    </div>
	                  ))}
	                </div>
	              )}
	            </div>
	            <div style={card}>
	              <div style={label}>REMOTE ASSETS</div>
	              <div style={{ display: "grid", gap: 8, fontFamily: MONO, fontSize: 12 }}>
	                {["remote_only", "cached", "missing", "failed"].map((status) => (
	                  <div key={status} style={{ display: "flex", justifyContent: "space-between", gap: 10, borderBottom: `1px solid ${C.borderSoft}`, paddingBottom: 7 }}>
	                    <span style={{ color: C.dim }}>{status.replace(/_/g, " ")}</span>
	                    <span style={{ color: status === "failed" || status === "missing" ? C.redText : status === "cached" ? C.teal : C.text }}>
	                      {state.remoteAssets.byAvailability[status] ?? 0}
	                    </span>
	                  </div>
	                ))}
	              </div>
	            </div>
	          </div>

	          <div style={card}>
	            <div style={label}>IMPORT CONFLICTS</div>
            {state.conflicts.length === 0 ? (
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.dim }}>No pending remote-import conflicts.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {state.conflicts.map((conflict) => (
                  <div key={conflict.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "start", border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: 10 }}>
                    <div style={{ minWidth: 0, fontFamily: MONO }}>
                      <div style={{ color: C.text, fontSize: 12, fontWeight: 700 }}>{SYNC_DATA_TYPE_LABELS[conflict.dataType]} · {conflict.naturalKey}</div>
                      <div style={{ marginTop: 4, color: C.dim, fontSize: 10 }}>
                        {conflict.sourceInstanceName ?? conflict.sourceInstanceId ?? "remote instance"} · {ago(conflict.createdAt)}
                      </div>
                      <div style={{ marginTop: 7, color: C.dimmest, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        incoming {Object.keys(conflict.incomingPayload ?? {}).slice(0, 8).join(", ") || "payload"}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                      <button type="button" disabled={busy} onClick={() => resolveConflict(conflict.id, "promote")} style={{ ...ghostBtn, color: C.amber, padding: "6px 9px", fontSize: 10 }}>
                        promote
                      </button>
                      <button type="button" disabled={busy} onClick={() => resolveConflict(conflict.id, "archive")} style={{ ...ghostBtn, padding: "6px 9px", fontSize: 10 }}>
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

function QueueDashboard() {
  const [queue, setQueue] = useState<AdminQueue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      setQueue(await getAdminQueue());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      refreshingRef.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

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
  const failed = queue?.results.failed ?? 0;
  const staleCount = activeJobs.filter((job) => job.stale).length;
  const engineQueue = queue?.engineQueue;
  const duplicateCount = Object.keys(engineQueue?.duplicates ?? {}).length;
  const detachedCount = activeJobs.filter((job) => job.runtimeState === "detached_running" || (job.processCount > 0 && !job.engineQueueMatch)).length;
  return (
    <div data-testid="openfoam-queue-page">
      <div className="queue-header-grid">
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>OpenFOAM queue</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 6, fontFamily: MONO, fontSize: 11, color: C.dim }}>
            <span>engine {queue?.engineUrl ?? "…"}</span>
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
                engine build {queue.engineHealth.build_id ?? queue.engineHealth.version}
                {queue.engineBuildMismatch ? ` expected ${queue.engineExpectedBuildId}` : ""}
              </span>
            )}
            {queue?.engineHealthError && <span style={{ color: C.amber }}>engine health: {queue.engineHealthError.slice(0, 80)}</span>}
            {sw && (
              <span style={{ color: sw.enabled ? C.teal : C.amber, border: `1px solid ${sw.enabled ? C.tealBorder : C.stroke}`, borderRadius: 5, padding: "2px 7px" }}>
                {sw.enabled ? "sweeper running" : "sweeper paused"}
              </span>
            )}
          </div>
        </div>
        {sw && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => patchSweeper({ enabled: !sw.enabled }))}
              style={{ ...(sw.enabled ? ghostBtn : primaryBtn(busy)), display: "inline-flex", alignItems: "center", gap: 7 }}
            >
              {sw.enabled ? <Pause size={14} /> : <Play size={14} />}
              {sw.enabled ? "Pause" : "Resume"}
            </button>
            {failed > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(async () => void (await requeueFailed()))}
                style={{ ...ghostBtn, display: "inline-flex", alignItems: "center", gap: 7, color: C.amber }}
              >
                <RotateCcw size={14} />
                requeue failed
              </button>
            )}
            {staleCount > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => recoverStaleJobs())}
                style={{ ...ghostBtn, display: "inline-flex", alignItems: "center", gap: 7, color: C.redText }}
              >
                <ShieldAlert size={14} />
                recover stale
              </button>
            )}
          </div>
        )}
      </div>

      {err && <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 12 }}>{err}</div>}

      <div className="admin-metric-grid" style={{ marginBottom: 14 }}>
        <QueueMetric icon={<Clock3 size={15} />} label="Pending sweeps" value={queue ? (queue.pendingSweepsTotal ?? 0).toLocaleString() : "…"} sub={`${queue?.pendingPointsTotal ?? queue?.backlog ?? 0} AoA points`} accent={C.amber} />
        <QueueMetric icon={<Activity size={15} />} label="Active jobs" value={queue ? String(activeJobs.length) : "…"} sub={`${queue?.inFlight ?? 0} in engine`} accent={C.teal} />
        <QueueMetric icon={<Activity size={15} />} label="Celery queue" value={queue ? String(engineQueue?.queue_depth ?? "—") : "…"} sub={`${engineQueue?.active_count ?? 0} active · ${engineQueue?.reserved_count ?? 0} reserved`} accent={duplicateCount ? C.redText : C.dim} />
        <QueueMetric icon={<CheckCircle2 size={15} />} label="Solved points" value={queue ? String(queue.results.solved ?? 0) : "…"} sub="source solved" accent={C.teal} />
        <QueueMetric icon={<XCircle size={15} />} label="Failed points" value={queue ? String(failed) : "…"} sub="needs requeue" accent={failed > 0 ? C.red : C.dim} />
        <QueueMetric icon={<ShieldAlert size={15} />} label="Stale jobs" value={queue ? String(staleCount) : "…"} sub={detachedCount ? `${detachedCount} detached runner${detachedCount === 1 ? "" : "s"}` : duplicateCount ? `${duplicateCount} duplicate IDs` : "orphan detector"} accent={staleCount || duplicateCount ? C.redText : C.text} />
      </div>

      <div className="queue-main-grid">
        <QueuePanel title="Pending sweeps" count={queue ? `${pendingSweeps.length} of ${queue.pendingSweepsTotal ?? 0}` : undefined} testId="queue-pending-sweeps">
          {!queue ? (
            <EmptyQueueLine text="Loading pending CFD sweeps…" />
          ) : pendingSweeps.length === 0 ? (
            <EmptyQueueLine text="No pending sweeps. The enabled boundary-condition set is fully solved." />
          ) : (
            <div>
              <div style={{ minWidth: 0 }}>
                <TableHead columns={PENDING_COLUMNS} labels={["Airfoil", "Type", "CPU", "Speed", "Re", "AoA", "Condition", "State"]} />
                {pendingSweeps.map((p) => (
                  <PendingSweepRow key={`${p.airfoilId}-${p.bcId}-${p.kind}`} item={p} />
                ))}
              </div>
            </div>
          )}
        </QueuePanel>

        <div style={{ display: "grid", gap: 14 }}>
          <QueuePanel title="Externally promised" count={queue ? `${externalPromises.length}` : undefined} testId="queue-external-promises">
            {!queue ? (
              <EmptyQueueLine text="Loading external sync promises…" />
            ) : externalPromises.length === 0 ? (
              <EmptyQueueLine text="No active external promises. Local sweeper owns all currently pending work." />
            ) : (
              <div style={{ display: "grid", gap: 8, padding: "10px 16px 16px" }}>
                {externalPromises.map((promise) => (
                  <div key={promise.id} style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 8, padding: 10, fontFamily: MONO }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <Link href={`/airfoils/${promise.airfoilSlug}`} style={{ minWidth: 0, color: C.text, textDecoration: "none", fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {promise.airfoilName}
                      </Link>
                      <span style={{ color: C.amber, fontSize: 10 }}>{agoFromSeconds(Math.max(0, (new Date(promise.expiresAt ?? Date.now()).getTime() - Date.now()) / 1000))} left</span>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 7, fontSize: 10, color: C.dim }}>
                      <span>{promise.aoaCount} AoAs · {aoaSpan(promise.aoaMin, promise.aoaMax)}</span>
                      <span>Re {formatRe(promise.reynolds)}</span>
                      <span>{promise.sourceInstanceName ?? promise.sourceInstanceId ?? "remote instance"}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </QueuePanel>

          <QueuePanel title="Active jobs" count={queue ? `${activeJobs.length}` : undefined} testId="queue-active-jobs">
            {sw && (
              <div style={{ borderBottom: `1px solid ${C.borderSoft}`, padding: "0 16px 12px", marginBottom: 2 }}>
                <div style={{ display: "grid", gap: 6, marginBottom: 10, fontFamily: MONO, fontSize: 10, color: C.dim }}>
                  {queue?.engineQueueError ? (
                    <span style={{ color: C.redText }}>engine queue unavailable · {queue.engineQueueError.slice(0, 120)}</span>
                  ) : (
                    <span>
                      Celery {engineQueue?.queue_depth ?? "—"} queued · {engineQueue?.active_count ?? 0} active · {engineQueue?.reserved_count ?? 0} reserved
                    </span>
                  )}
                  {(duplicateCount > 0 || (engineQueue?.redelivered.length ?? 0) > 0) && (
                    <span style={{ color: C.redText }}>
                      {duplicateCount} duplicate job IDs · {engineQueue?.redelivered.length ?? 0} redelivered tasks
                    </span>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", fontFamily: MONO, fontSize: 12 }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: sw.enabled ? C.teal : C.muted, fontWeight: 600 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: sw.enabled ? C.teal : C.dim, animation: sw.enabled ? "recpulse 1.6s infinite" : "none" }} />
                    {sw.enabled ? "RUNNING" : "PAUSED"}
                  </span>
                  <span style={{ color: C.dim }}>heartbeat {ago(sw.heartbeatAt)}</span>
                </div>
                {!sw.enabled && (
                  <div style={{ marginTop: 7, fontFamily: MONO, fontSize: 10, color: C.amber }}>
                    submissions are paused; already-started OpenFOAM processes continue until they finish or are cancelled
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", marginTop: 10 }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>concurrency</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Stepper value={sw.maxConcurrentJobs} disabled={busy} onChange={(n) => act(() => patchSweeper({ maxConcurrentJobs: n }))} />
                    <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim }}>jobs</span>
                  </div>
                </div>
              </div>
            )}
            {!queue ? (
              <EmptyQueueLine text="Loading active OpenFOAM jobs…" />
            ) : activeJobs.length === 0 ? (
              <EmptyQueueLine text="No active jobs. Resume the sweeper to submit pending cases." />
            ) : (
              <div style={{ display: "grid", gap: 10, padding: "10px 16px 16px" }}>
                {activeJobs.map((job) => (
                  <ActiveJobCard key={job.id} job={job} busy={busy} onCancel={() => act(() => cancelJob(job.id))} />
                ))}
              </div>
            )}
          </QueuePanel>

          <QueuePanel title="Finished job log" count={queue ? `${finishedJobs.length} latest` : undefined} testId="queue-finished-jobs">
            {!queue ? (
              <EmptyQueueLine text="Loading finished jobs…" />
            ) : finishedJobs.length === 0 ? (
              <EmptyQueueLine text="No finished jobs yet. Completed, failed, and cancelled engine jobs will appear here." />
            ) : (
              <div style={{ display: "grid", gap: 10, padding: "10px 16px 16px" }}>
                {finishedJobs.slice(0, 8).map((job) => (
                  <FinishedJobCard key={job.id} job={job} />
                ))}
              </div>
            )}
          </QueuePanel>
        </div>
      </div>
    </div>
  );
}
function QueueMetric({ icon, label: l, value, sub, accent }: { icon: React.ReactNode; label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{ ...card, padding: 12, borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: MONO, fontSize: 10, color: C.dim, marginBottom: 6 }}>
        <span style={{ color: accent, display: "inline-flex" }}>{icon}</span>
        <span>{l}</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 650, color: accent, lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, marginTop: 4 }}>{sub}</div>
    </div>
  );
}

function QueuePanel({ title, count, testId, children }: { title: string; count?: string; testId: string; children: React.ReactNode }) {
  return (
    <section data-testid={testId} style={{ ...card, padding: 0, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.borderSoft}` }}>
        <h3 style={{ margin: 0, fontFamily: MONO, fontSize: 12, fontWeight: 700, color: C.text }}>{title}</h3>
        {count && <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>{count}</span>}
      </div>
      {children}
    </section>
  );
}

function TableHead({ columns, labels }: { columns: string; labels: string[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: columns, gap: 10, fontFamily: MONO, fontSize: 10, color: C.dim, padding: "8px 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
      {labels.map((text) => (
        <span
          key={text}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: ["AoA", "Cl max", "Cd min", "L/D max", "Finished"].includes(text) ? "right" : "left",
          }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

function EmptyQueueLine({ text }: { text: string }) {
  return <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, padding: "18px 16px", lineHeight: 1.5 }}>{text}</div>;
}

function KindBadge({ kind }: { kind: AdminJob["kind"] }) {
  const meta = KIND_META[kind];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, width: "fit-content", fontFamily: MONO, fontSize: 10, color: meta.tone, background: meta.fill, border: `1px solid ${meta.border}`, borderRadius: 5, padding: "3px 7px" }}>
      <span>{meta.label}</span>
      <span style={{ color: meta.tone, opacity: 0.75 }}>{meta.regime}</span>
    </span>
  );
}

function PendingSweepRow({ item }: { item: AdminPendingSweep }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: PENDING_COLUMNS, gap: 10, alignItems: "center", fontFamily: MONO, fontSize: 11, padding: "9px 16px", borderBottom: `1px solid ${C.borderRow}` }}>
      <Link href={`/airfoils/${item.airfoilSlug}`} style={{ minWidth: 0, color: C.text, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.airfoilName}
      </Link>
      <KindBadge kind={item.kind} />
      <span title={schedulingSummary(item)} style={{ minWidth: 0, color: C.amber, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {policyLabel(item.schedulingPolicy)} · {item.caseConcurrency == null ? "engine" : `${item.caseConcurrency}x`}
      </span>
      <span style={{ minWidth: 0, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fSpeed(item.speedMps)}</span>
      <span style={{ minWidth: 0, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Re {formatRe(item.reynolds)}</span>
      <span title={item.aoas.join(", ")} style={{ minWidth: 0, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.aoaCount} · {aoaSpan(item.aoaMin, item.aoaMax)}</span>
      <span title={`Flow ${item.mediumName} · ${fSpeed(item.speedMps)} · ${fTemp(item.temperatureK)} · ${fPressure(item.pressurePa)} · M ${f(item.mach, 3)} | Reference chord ${f(item.referenceChordM, 3)} m | Boundary ${item.bcName} | Solver ${item.turbulenceModel}`} style={{ minWidth: 0, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.bcName} · {item.mediumName}
      </span>
      <span style={{ minWidth: 0, color: item.priority > 0 ? C.amber : STATUS_COLOR[item.status] ?? C.dim, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.priority > 0 ? `P${item.priority}` : item.status}
      </span>
    </div>
  );
}

function runtimeLabel(job: AdminJob): string {
  if (job.resultReady) return "result ready";
  if (job.processCount > 0) return `${job.processCount} child process${job.processCount === 1 ? "" : "es"}`;
  if (job.runtimeState === "detached_running") return "worker heartbeat";
  if (job.runtimeState === "worker_visible") return "worker-visible";
  if (job.runtimeState === "orphaned") return "orphaned";
  if (job.runtimeState === "missing_grace") return "missing grace";
  if (job.runtimeState === "corrupt_status") return job.processCount > 0 ? "status unreadable · process alive" : "status unreadable";
  if (job.runtimeState === "corrupt_result") return "result unreadable";
  return job.engineJobId ? (job.engineQueueMatch ? "worker-visible" : "not in Celery") : "not submitted";
}

function phaseLabel(job: AdminJob): string {
  switch (job.phase) {
    case "pending":
      return job.engineState === "pending" || job.status === "submitted" ? "queued in engine" : "pending";
    case "waiting_cpu":
      return `waiting for CPU${job.cpuTokensWaiting ? ` · ${job.cpuTokensWaiting} token${job.cpuTokensWaiting === 1 ? "" : "s"}` : ""}`;
    case "meshing":
      return "meshing";
    case "solving_rans":
      return "RANS solving";
    case "solving_urans":
      return job.kind === "sweep-rans" ? "URANS fallback running" : "URANS solving";
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
  if (job.phase === "meshing" || job.phase === "solving_rans" || job.phase === "postprocessing") return C.teal;
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
  if (job.runtimeState === "orphaned" || job.runtimeState === "corrupt_result" || (job.runtimeState === "corrupt_status" && job.processCount === 0)) return C.redText;
  if (job.runtimeState === "detached_running" || job.runtimeState === "missing_grace" || (job.runtimeState === "corrupt_status" && job.processCount > 0)) return C.amber;
  if (job.runtimeState === "worker_visible" || job.resultReady) return C.teal;
  return C.dim;
}

function ActiveJobCard({ job, busy, onCancel }: { job: AdminJob; busy: boolean; onCancel: () => void }) {
  const inFlight = ["submitted", "running", "ingesting", "pending"].includes(job.status);
  const progress = job.totalCases > 0 ? Math.min(100, Math.round((job.completedCases / job.totalCases) * 100)) : 0;
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          {job.airfoilSlug ? (
            <Link href={`/airfoils/${job.airfoilSlug}`} style={{ display: "block", color: C.text, textDecoration: "none", fontFamily: MONO, fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {job.airfoilName ?? job.airfoilSlug}
            </Link>
          ) : (
            <span style={{ color: C.text, fontFamily: MONO, fontSize: 12, fontWeight: 700 }}>unknown airfoil</span>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
            <KindBadge kind={job.kind} />
            <span style={{ fontFamily: MONO, fontSize: 10, color: STATUS_COLOR[job.status] ?? C.muted }}>wave {job.wave} · {job.status}</span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: phaseTone(job), border: `1px solid ${C.stroke}`, borderRadius: 5, padding: "2px 5px" }}>
              {phaseLabel(job)}
            </span>
            <span title={schedulingSummary(job)} style={{ fontFamily: MONO, fontSize: 10, color: C.amber, border: `1px solid ${C.stroke}`, borderRadius: 5, padding: "2px 5px" }}>
              {schedulingSummary(job)}
            </span>
            {job.stale && (
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.redText, border: `1px solid ${C.stroke}`, borderRadius: 5, padding: "2px 5px" }}>
                stale
              </span>
            )}
            {job.engineJobId && (
              <span title={job.staleReason ?? undefined} style={{ fontFamily: MONO, fontSize: 10, color: runtimeTone(job) }}>
                {runtimeLabel(job)}
              </span>
            )}
            {activeSolverLabel(job) && (
              <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim }}>
                {activeSolverLabel(job)}
                {job.activeAoaDeg != null ? ` · AoA ${f(job.activeAoaDeg, 1)}°` : ""}
                {job.cpuTokensHeld != null && job.cpuTokensHeld > 0 ? ` · ${job.cpuTokensHeld} CPU` : ""}
              </span>
            )}
          </div>
        </div>
        {inFlight && (
          <button type="button" disabled={busy} onClick={onCancel} style={{ fontFamily: MONO, fontSize: 10, color: C.redText, background: "transparent", border: `1px solid ${C.stroke}`, borderRadius: 6, padding: "5px 8px", cursor: "pointer" }}>
            cancel
          </button>
        )}
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ height: 6, background: C.panel3, borderRadius: 999, overflow: "hidden", border: `1px solid ${C.borderSoft}` }}>
          <div style={{ width: `${progress}%`, minWidth: progress > 0 ? 6 : 0, height: "100%", background: C.teal }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 7, fontFamily: MONO, fontSize: 10, color: C.dim }}>
          <span>{job.completedCases}/{job.totalCases || "?"} cases</span>
          <span title={job.engineJobId ?? undefined}>
            {job.engineJobId ? `${job.engineJobId.slice(0, 12)} · job ${agoFromSeconds(job.pendingAgeSec)} · phase ${ago(job.phaseStartedAt)}` : "not submitted"}
          </span>
        </div>
      </div>
      <JobConditionChips job={job} />
      {job.staleReason && <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 10, color: job.stale ? C.redText : C.amber, lineHeight: 1.45 }}>{job.staleReason}</div>}
      {(job.statusReadError || job.resultReadError) && (
        <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 10, color: C.redText, lineHeight: 1.45 }}>
          {[job.statusReadError && `status: ${job.statusReadError}`, job.resultReadError && `result: ${job.resultReadError}`].filter(Boolean).join(" · ")}
        </div>
      )}
      {job.error && <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 10, color: C.redText, lineHeight: 1.45 }}>{job.error}</div>}
    </div>
  );
}

function FinishedJobCard({ job }: { job: AdminJob }) {
  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: STATUS_COLOR[job.status] ?? C.muted }}>{job.status}</span>
            <KindBadge kind={job.kind} />
          </div>
          {job.airfoilSlug ? (
            <Link href={`/airfoils/${job.airfoilSlug}`} style={{ display: "block", marginTop: 8, color: C.text, textDecoration: "none", fontFamily: MONO, fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {job.airfoilName ?? job.airfoilSlug}
            </Link>
          ) : (
            <span style={{ display: "block", marginTop: 8, color: C.text, fontFamily: MONO, fontSize: 12, fontWeight: 700 }}>unknown airfoil</span>
          )}
        </div>
        {job.airfoilSlug ? (
          <Link href={`/airfoils/${job.airfoilSlug}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: C.teal, textDecoration: "none", border: `1px solid ${C.tealBorder}`, borderRadius: 6, padding: "4px 7px", fontFamily: MONO, fontSize: 10 }}>
            Detail <ExternalLink size={12} />
          </Link>
        ) : (
          <span style={{ color: C.dimmest }}>—</span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 10, fontFamily: MONO, fontSize: 10, color: C.dim }}>
        <MetricChip label="AoA" value={aoaRange(job)} />
        <MetricChip label="Cl" value={f(job.clMax, 3)} />
        <MetricChip label="Cd" value={f(job.cdMin, 4)} />
        <MetricChip label="L/D" value={f(job.ldMax, 1)} />
      </div>
      <JobConditionChips job={job} />
      <div style={{ marginTop: 8, fontFamily: MONO, fontSize: 10, color: C.dimmest }}>finished {ago(job.finishedAt)}</div>
    </div>
  );
}

function JobConditionChips({ job }: { job: AdminJob }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 8, marginTop: 10, fontFamily: MONO, fontSize: 10, color: C.dim }}>
      <MetricChip label="Flow" value={`${job.mediumName ?? "—"} · ${f(job.speedMps, 2)} m/s`} />
      <MetricChip label="Thermo" value={`${fTemp(job.temperatureK)} · ${fPressure(job.pressurePa)} · M ${f(job.mach, 3)}`} />
      <MetricChip label="Reference" value={`chord ${f(job.referenceChordM, 3)} m · Re ${job.reynolds ? formatRe(job.reynolds) : "—"}`} />
      <MetricChip label="Boundary" value={job.bcName ?? "—"} />
      <MetricChip label="Solver" value={job.turbulenceModel ?? "—"} />
      <MetricChip label="Scheduling" value={`${policyLabel(job.schedulingPolicy)} · ${job.caseConcurrency == null ? "engine" : `${job.caseConcurrency}x${job.solverProcesses ?? 1}`}`} />
    </div>
  );
}

function MetricChip({ label: l, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "grid", gap: 2, background: C.panel3, border: `1px solid ${C.borderSoft}`, borderRadius: 6, padding: "6px 7px", minWidth: 0 }}>
      <span style={{ color: C.dimmest }}>{l}</span>
      <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </span>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{title}</h2>
      <div style={{ marginTop: 5, fontFamily: MONO, fontSize: 11, color: C.dim }}>{subtitle}</div>
    </div>
  );
}

function ProfileSectionTitle({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 12, marginBottom: 2, fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", color: C.teal }}>
      {text.toUpperCase()}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return <div style={{ fontFamily: MONO, fontSize: 11, color: C.red, marginBottom: 12 }}>{text}</div>;
}

const miniLabel: CSSProperties = { fontFamily: MONO, fontSize: 10, color: C.dim, margin: "8px 0 4px" };

function TextField({ label: l, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "block" }}>
      <div style={miniLabel}>{l}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
    </label>
  );
}

function NumberField({ label: l, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label style={{ display: "block" }}>
      <div style={miniLabel}>{l}</div>
      <input type="number" value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(Number(e.target.value))} style={inputStyle} />
    </label>
  );
}

function OptionalNumberField({ label: l, value, onChange }: { label: string; value: number | null | undefined; onChange: (v: number | null) => void }) {
  return (
    <label style={{ display: "block" }}>
      <div style={miniLabel}>{l}</div>
      <input
        type="number"
        value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        placeholder="auto"
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw ? Number(raw) : null);
        }}
        style={inputStyle}
      />
    </label>
  );
}

function SelectField({
  label: l,
  value,
  options,
  optionLabels,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  optionLabels?: Record<string, string>;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "block" }}>
      <div style={miniLabel}>{l}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        {options.map((o) => (
          <option key={o} value={o}>
            {optionLabels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

function dynamicViscosity(medium: MediumDTO, tempK: number): number {
  if (medium.viscosityModel === "constant") return medium.constantDynamicViscosity ?? medium.dynamicViscosity;
  if (medium.viscosityModel === "sutherland") {
    const muRef = medium.sutherlandMuRef ?? medium.dynamicViscosity;
    const tRef = medium.sutherlandTRef ?? medium.refTemperatureK;
    const s = medium.sutherlandS ?? 110.4;
    return muRef * Math.pow(tempK / tRef, 1.5) * ((tRef + s) / (tempK + s));
  }
  const rows = [...medium.viscosityTable].sort((a, b) => a.temperatureK - b.temperatureK);
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

function previewFlow(medium: MediumDTO, form: Pick<FlowConditionInput, "temperatureK" | "pressurePa" | "speedMps">) {
  const mu = dynamicViscosity(medium, form.temperatureK);
  const density = medium.phase === "gas"
    ? medium.density * (form.pressurePa / medium.refPressurePa) * (medium.refTemperatureK / form.temperatureK)
    : medium.density;
  const kinematicViscosity = mu / density;
  const mach = medium.speedOfSound ? form.speedMps / medium.speedOfSound : null;
  return { dynamicViscosity: mu, density, kinematicViscosity, mach };
}

function Stepper({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled: boolean }) {
  const btn: CSSProperties = { fontFamily: MONO, fontSize: 13, width: 24, height: 24, borderRadius: 6, background: C.panel3, border: `1px solid ${C.stroke}`, color: C.text, cursor: disabled ? "not-allowed" : "pointer" };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button type="button" disabled={disabled || value <= 1} onClick={() => onChange(value - 1)} style={btn}>−</button>
      <span style={{ fontFamily: MONO, fontSize: 13, color: C.text, minWidth: 16, textAlign: "center" }}>{value}</span>
      <button type="button" disabled={disabled || value >= 32} onClick={() => onChange(value + 1)} style={btn}>+</button>
    </span>
  );
}

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
const ghostBtn: CSSProperties = { fontFamily: MONO, fontSize: 12, color: C.muted, background: C.panel3, border: `1px solid ${C.stroke}`, borderRadius: 8, padding: "8px 14px", cursor: "pointer" };
function primaryBtn(disabled: boolean): CSSProperties {
  return { fontFamily: MONO, fontSize: 12, fontWeight: 600, color: C.tealInk, background: C.teal, border: `1px solid ${C.teal}`, borderRadius: 8, padding: "8px 16px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 };
}
