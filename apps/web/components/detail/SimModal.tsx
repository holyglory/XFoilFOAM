"use client";

import { f1, f2, f4, type FieldId, type FieldTrackPoint, fRe, type Point, type SimulationDetail } from "@aerodb/core";
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { browserUrl, renderResultField } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";

const PERIOD = 4;
const FIELDS: FieldId[] = [
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity",
];
const FIELD_LABELS: Record<FieldId, string> = {
  velocity_magnitude: "velocity |U|",
  velocity_x: "velocity Ux",
  velocity_y: "velocity Uy",
  pressure: "pressure p",
  pressure_coefficient: "pressure Cp",
  vorticity: "vorticity ωz",
  turbulent_kinetic_energy: "turbulence k",
  turbulent_viscosity: "turbulent viscosity νt",
};
const COLORMAPS = ["viridis", "coolwarm", "magma", "plasma", "cividis", "turbo"];

const statCard: CSSProperties = {
  flex: 1,
  minWidth: 104,
  border: `1px solid ${C.stroke2}`,
  borderRadius: 9,
  background: C.panel2,
  padding: "8px 11px",
};
const dlBtn: CSSProperties = {
  fontFamily: MONO,
  fontSize: 11,
  color: C.muted,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "6px 11px",
  cursor: "pointer",
};
const miniLabel: CSSProperties = {
  display: "grid",
  gap: 4,
  fontFamily: MONO,
  fontSize: 9,
  color: C.dim,
};
const miniInput: CSSProperties = {
  width: "100%",
  minWidth: 0,
  fontFamily: MONO,
  fontSize: 11,
  color: C.text,
  background: C.panel3,
  border: `1px solid ${C.stroke}`,
  borderRadius: 7,
  padding: "7px 8px",
};

export function SimModal(props: {
  open: boolean;
  /** mirrored: derived-by-symmetry evidence view (spec §9.3) — the stored +α
   *  artifacts are flipped client-side and labeled; aoa stays the mirrored −α. */
  ctx: { re: number; aoa: number; resultId?: string | null; mirrored?: boolean; mirroredFromAoaDeg?: number | null } | null;
  sim: SimulationDetail | null;
  name: string;
  machStr: string;
  contour: Point[];
  field: FieldId;
  onField: (f: FieldId) => void;
  track: FieldTrackPoint[];
  onTrackPoint: (p: FieldTrackPoint) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onClose: () => void;
  unavailableMessage?: string | null;
}) {
  const { open, ctx, sim, name, machStr, field, onField, track, onTrackPoint, playing, onTogglePlay, onClose, unavailableMessage } = props;

  const clMonRef = useRef<HTMLCanvasElement>(null);
  const cdMonRef = useRef<HTMLCanvasElement>(null);
  const ldMonRef = useRef<HTMLCanvasElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const animTimeRef = useRef(0);
  const lastUiRef = useRef(0);
  const [scrubFrac, setScrubFrac] = useState(0);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [customRender, setCustomRender] = useState<{ field: FieldId; role: "instantaneous" | "mean"; url: string; cached: boolean } | null>(null);
  const [customRole, setCustomRole] = useState<"instantaneous" | "mean">("instantaneous");
  const [zoomChords, setZoomChords] = useState(2);
  const [colormap, setColormap] = useState("viridis");
  const [levels, setLevels] = useState(40);
  const [scaleMode, setScaleMode] = useState<"track" | "auto" | "manual">("track");
  const [vmin, setVmin] = useState("");
  const [vmax, setVmax] = useState("");
  const [widthPx, setWidthPx] = useState(990);
  const [heightPx, setHeightPx] = useState(660);
  const [renderToolsOpen, setRenderToolsOpen] = useState(false);
  const [expandedRenderControl, setExpandedRenderControl] = useState<"role" | "zoom" | "map" | "levels" | "scale" | "resolution" | null>(null);
  const [lockAspect, setLockAspect] = useState(true);
  const [setupDetailsOpen, setSetupDetailsOpen] = useState(false);

  const stalled = sim?.regime === "stalled";
  const realField = (f: FieldId) => (sim?.status === "solved" ? sim.media?.[f] : undefined);
  const selectedTrackIndex = useMemo(() => {
    if (!track.length) return -1;
    const byId = ctx?.resultId ? track.findIndex((p) => p.resultId === ctx.resultId) : -1;
    if (byId >= 0) return byId;
    return track.findIndex((p) => Math.abs(p.aoa - (sim?.alpha ?? ctx?.aoa ?? 0)) < 1e-6);
  }, [ctx?.aoa, ctx?.resultId, sim?.alpha, track]);
  const evidenceBundle = sim?.evidenceArtifacts?.find((artifact) => artifact.kind === "openfoam_bundle") ?? null;
  const fieldDataArtifact = sim?.evidenceArtifacts?.find((artifact) => artifact.kind === "vtk_window" || artifact.kind === "field_data") ?? null;
  const historySeries = useMemo(() => {
    if (!sim?.history) return null;
    const len = Math.min(sim.history.cl.length, sim.history.cd.length);
    const cl = sim.history.cl.slice(0, len);
    const cd = sim.history.cd.slice(0, len);
    const ld = cl.map((v, i) => (Math.abs(cd[i]) > 1e-9 ? v / cd[i] : 0));
    const t = sim.history.t.slice(0, len);
    return { t, cl, cd, ld };
  }, [sim?.history]);
  const currentHistory = useMemo(() => {
    if (!historySeries || historySeries.cl.length === 0) return null;
    const idx = Math.max(0, Math.min(historySeries.cl.length - 1, Math.round(scrubFrac * (historySeries.cl.length - 1))));
    return {
      idx,
      t: historySeries.t[idx] ?? idx,
      cl: historySeries.cl[idx],
      cd: historySeries.cd[idx],
      ld: historySeries.ld[idx],
    };
  }, [historySeries, scrubFrac]);

  // reset the animation clock when a new point is opened
  useEffect(() => {
    animTimeRef.current = 0;
    setScrubFrac(0);
    setCustomRender(null);
    setRenderError(null);
    setRenderToolsOpen(false);
    setExpandedRenderControl(null);
  }, [ctx?.re, ctx?.aoa, ctx?.resultId]);

  useEffect(() => {
    if (!open || sim?.status !== "solved" || !sim.availableFields.length) return;
    if (!sim.availableFields.includes(field)) onField(sim.availableFields[0]);
  }, [open, sim?.status, sim?.availableFields, field, onField]);

  // Keep the scrubber and real force-history charts moving without inventing CFD fields.
  useEffect(() => {
    if (!open || !sim) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (playing) animTimeRef.current += dt;
      const frac = (((animTimeRef.current % PERIOD) + PERIOD) % PERIOD) / PERIOD;
      const clc = clMonRef.current;
      if (clc) {
        const c2 = clc.getContext("2d");
        if (c2) {
          if (historySeries) drawForceChart(c2, { width: clc.width, height: clc.height, values: historySeries.cl, color: C.teal, frac });
          else drawEmptyChart(c2, { width: clc.width, height: clc.height });
        }
      }
      const cdc = cdMonRef.current;
      if (cdc) {
        const c2 = cdc.getContext("2d");
        if (c2) {
          if (historySeries) drawForceChart(c2, { width: cdc.width, height: cdc.height, values: historySeries.cd, color: C.amber, frac });
          else drawEmptyChart(c2, { width: cdc.width, height: cdc.height });
        }
      }
      const ldc = ldMonRef.current;
      if (ldc) {
        const c2 = ldc.getContext("2d");
        if (c2) {
          if (historySeries) drawForceChart(c2, { width: ldc.width, height: ldc.height, values: historySeries.ld, color: C.text, frac });
          else drawEmptyChart(c2, { width: ldc.width, height: ldc.height });
        }
      }
      if (fillRef.current) fillRef.current.style.width = `${frac * 100}%`;
      if (knobRef.current) knobRef.current.style.left = `${frac * 100}%`;
      if (now - lastUiRef.current > 100) {
        lastUiRef.current = now;
        setScrubFrac(frac);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, sim, playing, historySeries]);

  if (!open) return null;

  const reStr = fRe(sim?.re ?? ctx?.re ?? 0);
  // Mirrored view: the header keeps the derived −α the user opened; the badge
  // on the media states the +α source (spec §9.3).
  const alphaStr = ctx?.mirrored ? f1(ctx.aoa) : f1(sim?.alpha ?? ctx?.aoa ?? 0);
  const modeTag = sim ? (stalled ? "URANS · POST-STALL" : "RANS · STEADY") : unavailableMessage ? "OPENFOAM RESULT" : "LOADING";
  const shownMach = sim ? f2(sim.mach) : machStr;
  const fieldLabel = FIELD_LABELS[field];
  const onScrub = (e: MouseEvent<HTMLDivElement>) => {
    const t = trackRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    animTimeRef.current = frac * PERIOD;
    setScrubFrac(frac);
    if (playing) onTogglePlay();
  };

  const currentStoredMediaUrl = () => {
    const media = realField(field);
    if (!media) return null;
    if (customRender?.field === field && customRender.role === "instantaneous") return customRender.url;
    return media.imageUrl ?? (media.kind === "image" ? media.url : null);
  };
  const currentDownloadUrl = () => (customRender?.field === field ? customRender.url : currentStoredMediaUrl());
  const customRenderFor = (which: "live" | "mean") =>
    customRender?.field === field && customRender.role === (which === "mean" ? "mean" : "instantaneous") ? customRender.url : null;

  const requestCustomRender = async () => {
    if (!ctx?.resultId) return;
    setRenderBusy(true);
    setRenderError(null);
    try {
      const rendered = await renderResultField(ctx.resultId, {
        field,
        role: customRole,
        scaleMode,
        zoomChords,
        colormap,
        levels,
        vmin: scaleMode === "manual" && vmin.trim() ? Number(vmin) : null,
        vmax: scaleMode === "manual" && vmax.trim() ? Number(vmax) : null,
        frameIndex: customRole === "instantaneous" && historySeries ? Math.round(scrubFrac * Math.max(0, historySeries.t.length - 1)) : null,
        widthPx,
        heightPx,
      });
      setCustomRender({ field: rendered.field, role: rendered.role as "instantaneous" | "mean", url: rendered.url, cached: rendered.cached });
    } catch (e) {
      setRenderError((e as Error).message);
    } finally {
      setRenderBusy(false);
    }
  };

  const setRenderWidth = (value: number) => {
    const next = Math.max(320, Math.min(2400, Math.round(value)));
    const ratio = widthPx / Math.max(1, heightPx) || 1.5;
    setWidthPx(next);
    if (lockAspect) setHeightPx(Math.max(240, Math.min(1800, Math.round(next / ratio))));
  };
  const setRenderHeight = (value: number) => {
    const next = Math.max(240, Math.min(1800, Math.round(value)));
    const ratio = widthPx / Math.max(1, heightPx) || 1.5;
    setHeightPx(next);
    if (lockAspect) setWidthPx(Math.max(320, Math.min(2400, Math.round(next * ratio))));
  };
  const selectedScale = realField(field)?.scale ?? null;
  const scaleLabel = scaleMode === "track"
    ? selectedScale ? `track ${fmtCompact(selectedScale.vmin)}…${fmtCompact(selectedScale.vmax)}` : "track unavailable"
    : scaleMode === "auto"
      ? "auto current"
      : vmin.trim() || vmax.trim()
        ? `${vmin.trim() || "auto"}…${vmax.trim() || "auto"}`
        : "manual";
  const renderControlButton = (key: typeof expandedRenderControl, label: string, value: string) => (
    <button
      type="button"
      onClick={() => setExpandedRenderControl(expandedRenderControl === key ? null : key)}
      style={{
        fontFamily: MONO,
        fontSize: 10,
        color: expandedRenderControl === key ? C.teal : C.muted,
        background: expandedRenderControl === key ? C.tealFill : "transparent",
        border: `1px solid ${expandedRenderControl === key ? C.tealBorder : C.stroke}`,
        borderRadius: 999,
        padding: "5px 8px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: C.dim }}>{label}</span> {value}
    </button>
  );
  const renderControlBody = () => {
    if (!expandedRenderControl) return null;
    const panelStyle: CSSProperties = {
      gridColumn: "1 / -1",
      display: "grid",
      gap: 8,
      paddingTop: 2,
    };
    if (expandedRenderControl === "role") {
      return (
        <div style={{ ...panelStyle, gridTemplateColumns: "repeat(2, minmax(0, 120px))" }}>
          {(["instantaneous", "mean"] as const).map((role) => (
            <button key={role} type="button" onClick={() => setCustomRole(role)} style={{ ...dlBtn, color: customRole === role ? C.teal : C.muted }}>
              {role === "instantaneous" ? "instant" : "mean"}
            </button>
          ))}
        </div>
      );
    }
    if (expandedRenderControl === "zoom") {
      return (
        <div style={panelStyle}>
          <input type="range" min={0.25} max={5} step={0.05} value={zoomChords} onChange={(e) => setZoomChords(Number(e.currentTarget.value))} />
        </div>
      );
    }
    if (expandedRenderControl === "map") {
      return (
        <div style={{ ...panelStyle, gridTemplateColumns: "repeat(auto-fit, minmax(86px, 1fr))" }}>
          {COLORMAPS.map((map) => (
            <button key={map} type="button" onClick={() => setColormap(map)} style={{ ...dlBtn, color: colormap === map ? C.teal : C.muted }}>
              {map}
            </button>
          ))}
        </div>
      );
    }
    if (expandedRenderControl === "levels") {
      return (
        <div style={panelStyle}>
          <input type="range" min={3} max={200} step={1} value={levels} onChange={(e) => setLevels(Number(e.currentTarget.value))} />
        </div>
      );
    }
    if (expandedRenderControl === "scale") {
      return (
        <div style={panelStyle}>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {(["track", "auto", "manual"] as const).map((mode) => (
              <button key={mode} type="button" onClick={() => setScaleMode(mode)} style={{ ...dlBtn, color: scaleMode === mode ? C.teal : C.muted }}>
                {mode === "track" ? "track scale" : mode === "auto" ? "auto current" : "manual range"}
              </button>
            ))}
          </div>
          {scaleMode === "manual" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(110px, 1fr))", gap: 8 }}>
              <label style={miniLabel}>Min
                <input value={vmin} onChange={(e) => setVmin(e.currentTarget.value)} placeholder="auto" style={miniInput} />
              </label>
              <label style={miniLabel}>Max
                <input value={vmax} onChange={(e) => setVmax(e.currentTarget.value)} placeholder="auto" style={miniInput} />
              </label>
            </div>
          )}
        </div>
      );
    }
    return (
      <div style={{ ...panelStyle, gridTemplateColumns: "1fr 1fr auto", alignItems: "end" }}>
        <label style={miniLabel}>Width {widthPx}px
          <input type="range" min={320} max={2400} step={10} value={widthPx} onChange={(e) => setRenderWidth(Number(e.currentTarget.value))} />
        </label>
        <label style={miniLabel}>Height {heightPx}px
          <input type="range" min={240} max={1800} step={10} value={heightPx} onChange={(e) => setRenderHeight(Number(e.currentTarget.value))} />
        </label>
        <button type="button" onClick={() => setLockAspect((v) => !v)} style={{ ...dlBtn, color: lockAspect ? C.teal : C.muted }}>
          {lockAspect ? "ratio locked" : "ratio free"}
        </button>
      </div>
    );
  };
  const activeScaleChip = () => {
    const scale = realField(field)?.scale;
    if (!scale) return null;
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "-2px 0 8px" }}>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.dim, border: `1px solid ${C.stroke}`, borderRadius: 999, padding: "4px 8px", background: C.panel2 }}>
          track scale {fmtCompact(scale.vmin)}…{fmtCompact(scale.vmax)}{scale.status && scale.status !== "active" ? ` · ${scale.status}` : ""}
        </span>
      </div>
    );
  };
  const renderTools = () => {
    if (sim?.status !== "solved") return null;
    return (
      <div style={{ display: "grid", gap: 8, margin: "0 0 10px" }}>
        {!renderToolsOpen ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setRenderToolsOpen(true)} style={{ ...dlBtn, color: C.teal }}>
              custom render
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8, border: `1px solid ${C.stroke2}`, borderRadius: 9, background: C.panel2, padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              {renderControlButton("role", "role", customRole === "instantaneous" ? "instant" : "mean")}
              {renderControlButton("zoom", "zoom", `${fmt(zoomChords, 2)}c`)}
              {renderControlButton("map", "map", colormap)}
              {renderControlButton("levels", "levels", String(levels))}
              {renderControlButton("scale", "scale", scaleLabel)}
              {renderControlButton("resolution", "size", `${widthPx}x${heightPx}`)}
              <button type="button" disabled={renderBusy || !ctx?.resultId} title={!ctx?.resultId ? "No solved result is selected for custom rendering" : undefined} onClick={requestCustomRender} style={{ ...dlBtn, color: C.teal, marginLeft: "auto" }}>
                {renderBusy ? "rendering..." : "re-render"}
              </button>
              <button type="button" onClick={() => { setRenderToolsOpen(false); setExpandedRenderControl(null); }} style={dlBtn}>
                hide
              </button>
            </div>
            {renderControlBody()}
            {(renderError || customRender) && (
              <div style={{ fontFamily: MONO, fontSize: 10, color: renderError ? C.red : C.dim }}>
                {renderError ?? `custom render ${customRender?.cached ? "loaded from cache" : "stored"}`}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };
  const setupDetails = () => {
    if (!sim?.condition) return null;
    return (
      <div style={{ marginTop: 13 }}>
        <button type="button" onClick={() => setSetupDetailsOpen((v) => !v)} style={{ ...dlBtn, color: setupDetailsOpen ? C.teal : C.muted }}>
          {setupDetailsOpen ? "hide setup details" : "setup details"}
        </button>
        {setupDetailsOpen && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginTop: 9 }}>
            <ConditionGroup
              title="Boundary Condition"
              rows={[
                ["Preset", sim.condition.boundaryConditionName],
                ["Medium", sim.condition.mediumName],
              ]}
            />
            <ConditionGroup
              title="Flow State"
              rows={[
                ["U∞", `${fmt(sim.condition.speedMps, 3)} m/s`],
                ["Re", fRe(sim.re)],
                ["Mach", fmt(sim.mach, 4)],
              ]}
            />
            <ConditionGroup
              title="Thermodynamic State"
              rows={[
                ["T", `${fmt(sim.condition.temperatureK, 2)} K`],
                ["p", `${fmt(sim.condition.pressurePa / 1000, 2)} kPa`],
                ["ρ", sim.condition.density ? `${fmt(sim.condition.density, 4)} kg/m³` : "—"],
                ["ν", sim.condition.kinematicViscosity ? fmtSci(sim.condition.kinematicViscosity) : "—"],
              ]}
            />
            <ConditionGroup
              title="Reference Geometry"
              rows={[
                ["Chord", `${fmt(sim.condition.referenceChordM, 3)} m`],
              ]}
            />
            {sim.condition.mesh && (
              <ConditionGroup
                title="Mesh"
                rows={[
                  ["Cells", sim.condition.mesh.nCells == null ? "—" : sim.condition.mesh.nCells.toLocaleString()],
                  ["Mesher", mesherLabel(sim.condition.mesh.mesher)],
                  ["Surface", `${sim.condition.mesh.nSurface.toLocaleString()} cells`],
                  ["Radial", `${sim.condition.mesh.nRadial.toLocaleString()} cells`],
                  ["Wake", `${sim.condition.mesh.nWake.toLocaleString()} cells`],
                  ["Domain", `${fmt(sim.condition.mesh.farfieldRadiusChords, 1)}c far · ${fmt(sim.condition.mesh.wakeLengthChords, 1)}c wake`],
                  ["y+ target", fmt(sim.condition.mesh.targetYPlus, 2)],
                  ["y+ avg/max", sim.condition.mesh.yPlusAvg == null && sim.condition.mesh.yPlusMax == null ? "—" : `${fmtOptional(sim.condition.mesh.yPlusAvg, 2)} / ${fmtOptional(sim.condition.mesh.yPlusMax, 2)}`],
                  ["Iterations", sim.condition.mesh.iterations == null ? "—" : sim.condition.mesh.iterations.toLocaleString()],
                  ["Residual", sim.condition.mesh.finalResidual == null ? "—" : fmtCompact(sim.condition.mesh.finalResidual)],
                ]}
              />
            )}
            <ConditionGroup
              title="Boundary Model"
              rows={[
                ["Turb.", sim.condition.turbulenceModel],
                ["Tu", fmt(sim.condition.turbulenceIntensity, 4)],
                ["νt/ν", fmt(sim.condition.viscosityRatio, 1)],
              ]}
            />
          </div>
        )}
      </div>
    );
  };

  // Derived-by-symmetry view (spec §9.3): the media element itself is flipped
  // vertically — overlays, labels and charts are never mirrored.
  const mirrored = Boolean(ctx?.mirrored);
  const mirroredSourceAoa = ctx?.mirroredFromAoaDeg ?? (ctx ? Math.abs(ctx.aoa) : null);
  const mediaStyle: CSSProperties = mirrored
    ? { display: "block", width: "100%", height: "auto", transform: "scaleY(-1)" }
    : { display: "block", width: "100%", height: "auto" };
  const mirroredBadge = mirrored ? (
    <span
      data-testid="sim-mirrored-badge"
      style={{
        position: "absolute",
        bottom: 9,
        left: 10,
        fontFamily: MONO,
        fontSize: 9,
        fontWeight: 600,
        color: C.teal,
        background: "rgba(7,11,16,0.78)",
        border: `1px solid ${C.tealBorder}`,
        borderRadius: 5,
        padding: "2px 6px",
      }}
    >
      mirrored — derived from α = +{mirroredSourceAoa == null ? "?" : f1(mirroredSourceAoa)}° (symmetric airfoil)
    </span>
  ) : null;

  const fieldViewport = (which: "live" | "mean") => {
    const media = realField(field);
    const customUrl = customRenderFor(which);
    if (customUrl) {
      return (
        <>
          <img src={browserUrl(customUrl)} alt={`${fieldLabel} custom`} style={mediaStyle} />
          {mirroredBadge}
        </>
      );
    }
    if (media && which === "live") {
      return (
        <>
          {media.kind === "video" ? (
            <video src={browserUrl(media.url)} autoPlay loop muted playsInline style={mediaStyle} />
          ) : (
            <img src={browserUrl(media.url)} alt={fieldLabel} style={mediaStyle} />
          )}
          {mirroredBadge}
        </>
      );
    }
    if (media?.meanUrl && which === "mean") {
      return (
        <>
          <img src={browserUrl(media.meanUrl)} alt={`${fieldLabel} mean`} style={mediaStyle} />
          {mirroredBadge}
        </>
      );
    }
    if (sim?.status === "solved") {
      return <MediaEmpty text={which === "mean" ? "No time-averaged field stored for this solver output." : "No stored OpenFOAM media for this field."} />;
    }
    return <MediaEmpty text="No solved OpenFOAM media is available for this point." />;
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: C.overlay,
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(900px,94vw)",
          maxHeight: "92vh",
          overflow: "auto",
          background: C.modalBg,
          border: `1px solid ${C.stroke}`,
          borderRadius: 14,
          boxShadow: `0 30px 80px ${C.shadow}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 18px",
            borderBottom: `1px solid ${C.border}`,
            position: "sticky",
            top: 0,
            background: C.modalBg,
            zIndex: 2,
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: C.teal, border: `1px solid ${C.tealBorder}`, borderRadius: 5, padding: "3px 8px" }}>
            {modeTag}
          </span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{name}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>
            α {alphaStr}°&nbsp;&nbsp;·&nbsp;&nbsp;Re {reStr}&nbsp;&nbsp;·&nbsp;&nbsp;M {shownMach}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ marginLeft: "auto", width: 30, height: 30, borderRadius: 8, background: C.panel3, border: `1px solid ${C.stroke}`, color: C.muted, cursor: "pointer", fontSize: 15, lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "16px 18px 20px" }}>
          {/* field tabs */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 13 }}>
            {FIELDS.map((fid) => {
              const on = field === fid;
              const available = !sim || sim.availableFields.length === 0 || sim.availableFields.includes(fid);
              const storedFields = sim?.availableFields.map((stored) => FIELD_LABELS[stored]).join(", ") || "none";
              return (
                <button
                  key={fid}
                  type="button"
                  disabled={!available}
                  onClick={() => onField(fid)}
                  title={available ? FIELD_LABELS[fid] : `No stored ${FIELD_LABELS[fid]} media for this result. Stored fields: ${storedFields}.`}
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    borderRadius: 7,
                    padding: "6px 12px",
                    cursor: available ? "pointer" : "not-allowed",
                    border: `1px solid ${on ? C.tealBorder : C.stroke}`,
                    background: on ? C.tealFill : C.panel3,
                    color: on ? C.teal : C.muted,
                    fontWeight: on ? 600 : 400,
                    opacity: available ? 1 : 0.45,
                  }}
                >
                  {FIELD_LABELS[fid]}
                </button>
              );
            })}
            <div style={{ marginLeft: "auto", display: "flex", gap: 7 }}>
              {currentDownloadUrl() ? (
                <a href={browserUrl(currentDownloadUrl()!)} download style={{ ...dlBtn, textDecoration: "none" }}>↓ render .png</a>
              ) : (
                <button type="button" disabled style={{ ...dlBtn, cursor: "not-allowed", opacity: 0.45 }}>↓ render .png</button>
              )}
              {evidenceBundle ? (
                <a href={browserUrl(evidenceBundle.downloadUrl)} download style={{ ...dlBtn, textDecoration: "none" }}>↓ evidence</a>
              ) : (
                <button type="button" disabled style={{ ...dlBtn, cursor: "not-allowed", opacity: 0.45 }}>↓ evidence</button>
              )}
              {fieldDataArtifact ? (
                <a href={browserUrl(fieldDataArtifact.downloadUrl)} download style={{ ...dlBtn, textDecoration: "none" }}>↓ field data</a>
              ) : (
                <button type="button" disabled style={{ ...dlBtn, cursor: "not-allowed", opacity: 0.45 }}>↓ field data</button>
              )}
            </div>
          </div>
          {track.length > 1 && selectedTrackIndex >= 0 && (
            <div style={{ display: "grid", gap: 6, margin: "0 0 13px", padding: "8px 10px", border: `1px solid ${C.stroke2}`, borderRadius: 9, background: C.panel2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontFamily: MONO, fontSize: 10, color: C.dim }}>
                <span>AoA evidence</span>
                <span>α {f1(track[selectedTrackIndex]?.aoa ?? 0)}° · {selectedTrackIndex + 1}/{track.length}</span>
              </div>
              <input
                type="range"
                min={0}
                max={track.length - 1}
                step={1}
                value={selectedTrackIndex}
                onChange={(e) => onTrackPoint(track[Number(e.currentTarget.value)])}
                style={{ width: "100%" }}
              />
            </div>
          )}

          {!sim ? (
            <div style={{ fontFamily: MONO, fontSize: 12, color: unavailableMessage ? C.amber : C.muted, padding: "60px 0", textAlign: "center", lineHeight: 1.6 }}>
              {unavailableMessage ?? "loading OpenFOAM result..."}
            </div>
          ) : stalled ? (
            <>
              {renderTools()}
              {activeScaleChip()}
              {/* live + mean pair */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ position: "relative", border: `1px solid ${C.stroke2}`, borderRadius: 10, overflow: "hidden", background: "#070b10" }}>
                  {fieldViewport("live")}
                  <span style={{ position: "absolute", top: 9, left: 10, display: "flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, fontWeight: 600, color: C.red }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.red, animation: "recpulse 1.2s infinite" }} />
                    LIVE · UNSTEADY
                  </span>
                  <span style={{ position: "absolute", bottom: 9, right: 10, fontFamily: MONO, fontSize: 9, color: C.muted, background: "rgba(7,11,16,0.7)", borderRadius: 5, padding: "2px 6px" }}>
                    {fieldLabel}
                  </span>
                </div>
                <div style={{ position: "relative", border: `1px solid ${C.stroke2}`, borderRadius: 10, overflow: "hidden", background: "#070b10" }}>
                  {fieldViewport("mean")}
                  <span style={{ position: "absolute", top: 9, left: 10, fontFamily: MONO, fontSize: 9, fontWeight: 600, color: C.muted }}>TIME-AVERAGED  x̄</span>
                  <span style={{ position: "absolute", bottom: 9, right: 10, fontFamily: MONO, fontSize: 9, color: C.muted, background: "rgba(7,11,16,0.7)", borderRadius: 5, padding: "2px 6px" }}>
                    {fieldLabel}
                  </span>
                </div>
              </div>

              {/* mean force readout */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginTop: 12 }}>
                <Stat label="Cl exact" color={C.teal} value={currentHistory ? fmt(currentHistory.cl, 4) : fmt(sim.cl, 4)} sub={`at cursor · mean ${fmt(sim.cl, 4)} · rms ${fmt(sim.clStd ?? 0, 4)}`} />
                <Stat label="Cd exact" color={C.amber} value={currentHistory ? fmt(currentHistory.cd, 5) : fmt(sim.cd, 5)} sub={`at cursor · mean ${fmt(sim.cd, 5)} · rms ${fmt(sim.cdStd ?? 0, 5)}`} />
                <Stat label="L/D exact" color={C.text} value={currentHistory ? fmt(currentHistory.ld, 3) : fmt(sim.ld, 3)} sub={`at cursor · mean ${fmt(sim.ld, 3)}`} />
                <Stat label="St" color={C.muted} value={f2(sim.strouhal ?? 0)} sub={currentHistory ? `t ${fmt(currentHistory.t, 3)} s` : "shedding"} />
              </div>

              {/* transport */}
              <div style={{ display: "flex", alignItems: "center", gap: 13, marginTop: 13 }}>
                <button
                  type="button"
                  onClick={onTogglePlay}
                  style={{ width: 34, height: 34, borderRadius: 9, background: C.teal, border: "none", color: C.tealInk, cursor: "pointer", fontSize: 13, flex: "none" }}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
                <div ref={trackRef} onClick={onScrub} style={{ flex: 1, height: 8, background: C.stroke, borderRadius: 6, position: "relative", cursor: "pointer" }}>
                  <div ref={fillRef} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "0%", background: "rgba(45,212,191,0.35)", borderRadius: 6 }} />
                  <div ref={knobRef} style={{ position: "absolute", left: "0%", top: "50%", transform: "translate(-50%,-50%)", width: 14, height: 14, borderRadius: "50%", background: C.teal, border: `2px solid ${C.tealInk}` }} />
                </div>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>St {f2(sim.strouhal ?? 0)} · 1.0×</span>
              </div>

              {/* force monitors */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 13 }}>
                <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
                  <ChartHeader title="Cl(t)" color={C.teal} values={historySeries?.cl} current={currentHistory?.cl} />
                  <canvas ref={clMonRef} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
                </div>
                <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
                  <ChartHeader title="Cd(t)" color={C.amber} values={historySeries?.cd} current={currentHistory?.cd} digits={5} />
                  <canvas ref={cdMonRef} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
                </div>
                <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
                  <ChartHeader title="L/D(t)" color={C.text} values={historySeries?.ld} current={currentHistory?.ld} digits={3} />
                  <canvas ref={ldMonRef} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
                </div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.dimmest, marginTop: 11, lineHeight: 1.5 }}>
                URANS, k-ω SST · vortex shedding past stall. Scrubber cursor is synced to the force histories. Mean field is the time-average over the sampling window.
              </div>
              {setupDetails()}
            </>
          ) : (
            <>
              {renderTools()}
              {activeScaleChip()}
              {/* attached: single steady RANS */}
              <div style={{ position: "relative", border: `1px solid ${C.stroke2}`, borderRadius: 10, overflow: "hidden", background: "#070b10", maxWidth: 640, margin: "0 auto" }}>
                {fieldViewport("live")}
                <span style={{ position: "absolute", top: 9, left: 10, fontFamily: MONO, fontSize: 9, fontWeight: 600, color: C.teal }}>STEADY · RANS</span>
                <span style={{ position: "absolute", bottom: 9, right: 10, fontFamily: MONO, fontSize: 9, color: C.muted, background: "rgba(7,11,16,0.7)", borderRadius: 5, padding: "2px 6px" }}>
                  {fieldLabel}
                </span>
              </div>
              <div style={{ display: "flex", gap: 22, justifyContent: "center", marginTop: 13, fontFamily: MONO, fontSize: 12 }}>
                <span style={{ color: C.muted }}>Cl <span style={{ color: C.text }}>{f2(sim.cl)}</span></span>
                <span style={{ color: C.muted }}>Cd <span style={{ color: C.text }}>{f4(sim.cd)}</span></span>
                <span style={{ color: C.muted }}>L/D <span style={{ color: C.text }}>{f1(sim.ld)}</span></span>
                <span style={{ color: C.muted }}>Cm <span style={{ color: C.text }}>{f2(sim.cm)}</span></span>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.dimmest, marginTop: 11, textAlign: "center" }}>
                Attached flow — steady RANS converges to a single field, so no animation or force history.
              </div>
              {setupDetails()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, color, value, sub }: { label: string; color: string; value: string; sub: string }) {
  return (
    <div style={statCard}>
      <div style={{ fontFamily: MONO, fontSize: 9, color }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 17, color: C.text, fontWeight: 500, lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{sub}</div>
    </div>
  );
}

function ConditionGroup({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div style={{ display: "grid", gap: 5, background: C.panel2, border: `1px solid ${C.stroke2}`, borderRadius: 8, padding: "8px 10px", minWidth: 0 }}>
      <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: "0.04em", textTransform: "uppercase" }}>{title}</div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "74px minmax(0, 1fr)", gap: 8, alignItems: "baseline", fontFamily: MONO, fontSize: 10, minWidth: 0 }}>
          <span style={{ color: C.dimmest }}>{label}</span>
          <span style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function MediaEmpty({ text }: { text: string }) {
  return (
    <div style={{ minHeight: 260, display: "grid", placeItems: "center", background: "#070b10", color: C.dim, fontFamily: MONO, fontSize: 11, textAlign: "center", padding: 20 }}>
      {text}
    </div>
  );
}

function ChartHeader({ title, color, values, current, digits = 4 }: { title: string; color: string; values?: number[]; current?: number; digits?: number }) {
  const stats = values?.length ? summarize(values) : null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", fontFamily: MONO, marginBottom: 5 }}>
      <span style={{ fontSize: 10, color }}>{title}</span>
      <span style={{ fontSize: 9, color: C.dim, whiteSpace: "nowrap" }}>
        {current == null ? "no history" : `exact ${fmt(current, digits)} · min ${fmt(stats?.min ?? current, digits)} · max ${fmt(stats?.max ?? current, digits)}`}
      </span>
    </div>
  );
}

function fmt(n: number, digits: number) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtSci(n: number) {
  return Number.isFinite(n) ? n.toExponential(3).replace("e", "e") + " m²/s" : "—";
}

function fmtOptional(n: number | null | undefined, digits: number) {
  return n == null ? "—" : fmt(n, digits);
}

function mesherLabel(value: string) {
  return value === "blockmesh-cgrid" ? "C-grid blockMesh" : value;
}

function fmtCompact(n: number) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs > 0 && (abs < 0.01 || abs >= 10000)) return n.toExponential(2);
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function summarize(values: number[]) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  return { min, max, mean: sum / values.length };
}

function drawForceChart(
  ctx: CanvasRenderingContext2D,
  opts: { width: number; height: number; values: number[]; color: string; frac: number },
) {
  const { width: W, height: H, values, color, frac } = opts;
  ctx.fillStyle = "#0a0f15";
  ctx.fillRect(0, 0, W, H);
  if (values.length < 2) return;

  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const span = hi - lo || 1;
  const padL = 44;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const yv = (v: number) => padT + (1 - (v - lo) / span) * plotH;
  const xv = (i: number) => padL + (i / (values.length - 1)) * plotW;

  ctx.strokeStyle = "rgba(148,163,184,0.16)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (i / 3) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(148,163,184,0.3)";
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, H - padB);
  ctx.lineTo(W - padR, H - padB);
  ctx.stroke();

  ctx.fillStyle = "rgba(148,163,184,0.75)";
  ctx.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  ctx.fillText(fmt(hi, 3), padL - 6, padT + 4);
  ctx.fillText(fmt(lo, 3), padL - 6, H - padB + 3);

  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  ctx.strokeStyle = "rgba(230,237,243,0.22)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, yv(mean));
  ctx.lineTo(W - padR, yv(mean));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = xv(i);
    const y = yv(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const idx = Math.max(0, Math.min(values.length - 1, Math.round(Math.max(0, Math.min(1, frac)) * (values.length - 1))));
  const cx = xv(idx);
  const cy = yv(values[idx]);
  ctx.strokeStyle = "rgba(230,237,243,0.48)";
  ctx.beginPath();
  ctx.moveTo(cx, padT);
  ctx.lineTo(cx, H - padB);
  ctx.stroke();
  ctx.fillStyle = "#e6edf3";
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawEmptyChart(ctx: CanvasRenderingContext2D, opts: { width: number; height: number }) {
  const { width: W, height: H } = opts;
  ctx.fillStyle = "#0a0f15";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(148,163,184,0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(36, 12);
  ctx.lineTo(36, H - 22);
  ctx.lineTo(W - 10, H - 22);
  ctx.stroke();
  ctx.fillStyle = "rgba(148,163,184,0.45)";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText("no force history stored", W / 2, H / 2);
}
