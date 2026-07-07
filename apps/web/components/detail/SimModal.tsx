"use client";

import { f1, f2, f4, type FieldId, type FieldTrackPoint, fRe, type Point, type SimulationDetail } from "@aerodb/core";
import { type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { browserUrl, renderResultField } from "@/lib/api";
import {
  advancePlayback,
  buildFramePlayerModel,
  chartXForTime,
  clampFrameIndex,
  defaultFrameField,
  frameForChartX,
  frameImageUrl,
  frameIndexForTime,
  historyFracForTime,
  PLAYER_CHART_GEOMETRY,
  periodOrdinal,
  type FramePlayerModel,
  type PlaybackSpeed,
  timeForFrameIndex,
  windowPeriodCount,
} from "@/lib/frame-player";
import { fidelityChipView } from "@/lib/point-history";
import { buildSteadyHistoryModel, type SteadyHistoryModel } from "@/lib/steady-history";
import { C, MONO, VIZ } from "@/lib/tokens";

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

  // ---- URANS frame player (task #25): ONE state drives every surface. ----
  const [frameIndex, setFrameIndex] = useState(0);
  const [playSpeed, setPlaySpeed] = useState<PlaybackSpeed>(1);
  const [frameField, setFrameField] = useState<string | null>(null);
  const [preload, setPreload] = useState<{ field: string; loaded: number; failed: number; total: number } | null>(null);
  const playerSimTimeRef = useRef(0);
  const playerChartRef = useRef<HTMLCanvasElement>(null);
  const chartDragRef = useRef(false);
  const preloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const stalled = sim?.regime === "stalled";
  // Engine-recorded frame track → player model; null = legacy evidence (steady,
  // no-shedding, pre-contract, or drifted payload) → the stored mp4 stays.
  const playerModel = useMemo(() => buildFramePlayerModel(sim?.frameTrack ?? null), [sim?.frameTrack]);
  // Oscillating-steady iteration history (fidelity ladder contract 2): null =
  // classic pointwise convergence — the section renders nothing new.
  const steadyModel = useMemo(() => buildSteadyHistoryModel(sim?.steadyHistory ?? null), [sim?.steadyHistory]);
  const steadyClRef = useRef<HTMLCanvasElement>(null);
  const steadyCdRef = useRef<HTMLCanvasElement>(null);
  const steadyCmRef = useRef<HTMLCanvasElement>(null);
  const framesMode = Boolean(playerModel && stalled);
  const frameIdx = playerModel ? clampFrameIndex(playerModel.frames.length, frameIndex) : -1;
  const currentFrame = playerModel && frameIdx >= 0 ? playerModel.frames[frameIdx] : null;
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
  // Frames mode: the monitors' "exact at cursor" readout follows the frame
  // clock (nearest full-history sample to frames[frameIndex].t).
  const historyCursor = useMemo(() => {
    if (!framesMode || !playerModel || !historySeries || historySeries.cl.length === 0) return null;
    const t = timeForFrameIndex(playerModel, frameIdx);
    const idx = Math.max(0, Math.min(historySeries.cl.length - 1, frameIndexForTime(historySeries.t, t)));
    return {
      idx,
      t: historySeries.t[idx] ?? t,
      cl: historySeries.cl[idx],
      cd: historySeries.cd[idx],
      ld: historySeries.ld[idx],
    };
  }, [framesMode, playerModel, historySeries, frameIdx]);

  // reset the animation clock when a new point is opened
  useEffect(() => {
    animTimeRef.current = 0;
    setScrubFrac(0);
    setCustomRender(null);
    setRenderError(null);
    setRenderToolsOpen(false);
    setExpandedRenderControl(null);
    setPlaySpeed(1);
  }, [ctx?.re, ctx?.aoa, ctx?.resultId]);

  // new frame track loaded → rewind the player and pick the default field
  useEffect(() => {
    setFrameIndex(0);
    playerSimTimeRef.current = playerModel?.tStart ?? 0;
    setFrameField(playerModel ? defaultFrameField(playerModel) : null);
  }, [playerModel]);

  // Lazily preload every frame PNG of the selected field so scrubbing and
  // playback don't flash. Absent URLs (unregistered evidence) are never
  // requested — the pane shows the honest gap instead.
  useEffect(() => {
    if (!open || !playerModel || !frameField) {
      setPreload(null);
      return;
    }
    const urls: string[] = [];
    for (let k = 0; k < playerModel.frames.length; k++) {
      const url = frameImageUrl(playerModel, k, frameField);
      if (url) urls.push(browserUrl(url));
    }
    const total = urls.length;
    let cancelled = false;
    let loaded = 0;
    let failed = 0;
    const publish = () => {
      if (!cancelled) setPreload({ field: frameField, loaded, failed, total });
    };
    for (const abs of urls) {
      let img = preloadImagesRef.current.get(abs);
      if (img && img.complete) {
        if (img.naturalWidth > 0) loaded += 1;
        else failed += 1;
        continue;
      }
      if (!img) {
        img = new Image();
        preloadImagesRef.current.set(abs, img);
        img.src = abs;
      }
      img.addEventListener("load", () => { loaded += 1; publish(); }, { once: true });
      img.addEventListener("error", () => { failed += 1; publish(); }, { once: true });
    }
    publish();
    return () => {
      cancelled = true;
    };
  }, [open, playerModel, frameField]);

  // Playback: rAF advances the sim clock at real-time-scaled speed (one
  // shedding period per wall second at 1×) and snaps to the nearest frame.
  useEffect(() => {
    if (!open || !framesMode || !playerModel || !playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      playerSimTimeRef.current = advancePlayback(playerSimTimeRef.current, dt, playSpeed, playerModel);
      const idx = frameIndexForTime(playerModel.times, playerSimTimeRef.current);
      if (idx >= 0) setFrameIndex((prev) => (prev === idx ? prev : idx));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, framesMode, playerModel, playing, playSpeed]);

  // Frames mode drawing: the window Cl(t) chart cursor sits at
  // frames[frameIndex].t and the secondary full-history monitors sync to the
  // same instant (nearest history sample).
  useEffect(() => {
    if (!open || !framesMode || !playerModel) return;
    const chart = playerChartRef.current;
    if (chart) {
      const g = chart.getContext("2d");
      if (g) drawWindowChart(g, { width: chart.width, height: chart.height, model: playerModel, frameIndex: frameIdx });
    }
    const frac = historySeries ? historyFracForTime(historySeries.t, timeForFrameIndex(playerModel, frameIdx)) : 0;
    const monitors: Array<[HTMLCanvasElement | null, number[] | undefined, string]> = [
      [clMonRef.current, historySeries?.cl, "#2dd4bf"],
      [cdMonRef.current, historySeries?.cd, "#f59e0b"],
      [ldMonRef.current, historySeries?.ld, "#e6edf3"],
    ];
    for (const [canvas, values, color] of monitors) {
      if (!canvas) continue;
      const g = canvas.getContext("2d");
      if (!g) continue;
      if (values && values.length) drawForceChart(g, { width: canvas.width, height: canvas.height, values, color, frac });
      else drawEmptyChart(g, { width: canvas.width, height: canvas.height });
    }
  }, [open, framesMode, playerModel, frameIdx, historySeries]);

  const seekFrame = useCallback(
    (idx: number) => {
      if (!playerModel) return;
      const k = clampFrameIndex(playerModel.frames.length, idx);
      if (k < 0) return;
      setFrameIndex(k);
      playerSimTimeRef.current = timeForFrameIndex(playerModel, k);
      if (playing) onTogglePlay();
    },
    [playerModel, playing, onTogglePlay],
  );

  const chartPointerToFrame = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = playerChartRef.current;
      if (!canvas || !playerModel) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
      seekFrame(frameForChartX(x, playerModel, { width: canvas.width, ...PLAYER_CHART_GEOMETRY }));
    },
    [playerModel, seekFrame],
  );

  useEffect(() => {
    if (!open || sim?.status !== "solved" || !sim.availableFields.length) return;
    if (!sim.availableFields.includes(field)) onField(sim.availableFields[0]);
  }, [open, sim?.status, sim?.availableFields, field, onField]);

  // Static oscillating-steady iteration charts (real recorded samples, shaded
  // averaging window). Drawn once per model — no animation clock.
  useEffect(() => {
    if (!open || !steadyModel) return;
    const charts: Array<[HTMLCanvasElement | null, number[], string]> = [
      [steadyClRef.current, steadyModel.cl, "#2dd4bf"],
      [steadyCdRef.current, steadyModel.cd, "#f59e0b"],
      [steadyCmRef.current, steadyModel.cm, "#e6edf3"],
    ];
    for (const [canvas, values, color] of charts) {
      if (!canvas) continue;
      const g = canvas.getContext("2d");
      if (!g) continue;
      drawSteadyHistoryChart(g, { width: canvas.width, height: canvas.height, values, color, model: steadyModel });
    }
  }, [open, steadyModel]);

  // Legacy loop (no frame track): keep the scrubber and real force-history
  // charts moving without inventing CFD fields. Frames mode drives the same
  // canvases from the frame index instead.
  useEffect(() => {
    if (!open || !sim || framesMode) return;
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
  }, [open, sim, playing, historySeries, framesMode]);

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
  const fieldTabsRow = () => (
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
  );

  // live + mean stored-media pair (URANS). Frames mode shows the same pair as
  // a secondary evidence surface below the player — unchanged, just demoted.
  const mediaPairGrid = () => (
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
  );

  const forceMonitorsGrid = () => {
    const cursor = framesMode ? historyCursor : currentHistory;
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 13 }}>
        <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
          <ChartHeader title="Cl(t)" color={C.teal} values={historySeries?.cl} current={cursor?.cl} />
          <canvas ref={clMonRef} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
        </div>
        <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
          <ChartHeader title="Cd(t)" color={C.amber} values={historySeries?.cd} current={cursor?.cd} digits={5} />
          <canvas ref={cdMonRef} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
        </div>
        <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
          <ChartHeader title="L/D(t)" color={C.text} values={historySeries?.ld} current={cursor?.ld} digits={3} />
          <canvas ref={ldMonRef} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
        </div>
      </div>
    );
  };

  // Oscillating-steady iteration history (fidelity ladder contract 2): the
  // REAL recorded Cl/Cd/Cm(iteration) samples with the averaging window
  // shaded, plus the honest "averaged over last N iterations" note. Absent
  // steady_history renders nothing.
  const steadyHistorySection = () => {
    if (!steadyModel) return null;
    return (
      <div data-testid="sim-steady-history" style={{ marginTop: 13, display: "grid", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: "0.12em", whiteSpace: "nowrap" }}>
            STEADY SOLVE · ITERATION HISTORY
          </span>
          <div style={{ flex: 1, height: 1, background: C.stroke2 }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {(
            [
              ["Cl(iter)", steadyClRef, steadyModel.cl, C.teal],
              ["Cd(iter)", steadyCdRef, steadyModel.cd, C.amber],
              ["Cm(iter)", steadyCmRef, steadyModel.cm, C.text],
            ] as const
          ).map(([title, ref, values, color]) => (
            <div key={title} style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2 }}>
              <ChartHeader title={title} color={color} values={[...values]} current={values[values.length - 1]} />
              <canvas ref={ref} width={380} height={104} style={{ display: "block", width: "100%", height: "auto", borderRadius: 5 }} />
            </div>
          ))}
        </div>
        <div data-testid="sim-steady-history-note" style={{ fontFamily: MONO, fontSize: 10, color: steadyModel.meanStable ? C.dimmest : C.amber, lineHeight: 1.5 }}>
          Oscillating steady solve — coefficients averaged over the last {steadyModel.windowIterCount.toLocaleString()} iterations
          (iter {steadyModel.windowStartIter.toLocaleString()}–{steadyModel.windowEndIter.toLocaleString()}, shaded window
          {steadyModel.meanStable ? ", mean stable" : ", MEAN NOT STABLE"}).
          {steadyModel.note ? ` Engine: ${steadyModel.note}` : ""}
        </div>
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
      data-ui-allow-overlap="modal overlay intentionally covers the page"
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
          {(() => {
            // Fidelity ladder chip (same truth table as every classification
            // surface): plain for RANS/pre-ladder rows.
            const view = sim ? fidelityChipView(sim.fidelity ?? null, sim.uransVerify ?? null) : null;
            if (!view) return null;
            const color = view.tone === "teal" ? C.teal : view.tone === "amber" ? C.amber : C.red;
            const border = view.tone === "teal" ? C.tealBorder : view.tone === "amber" ? "rgba(245,158,11,0.45)" : "rgba(245,101,101,0.5)";
            return (
              <span data-testid="sim-fidelity-chip" style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.05em", color, border: `1px solid ${border}`, borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap" }}>
                {view.label}
              </span>
            );
          })()}
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
          {framesMode ? null : fieldTabsRow()}
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
          ) : framesMode && playerModel && currentFrame ? (
            <>
              {/* header chips: regime / classification / periods / stationarity / St */}
              <div data-testid="sim-frame-chips" style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
                <HeaderChip color={C.teal} border={C.tealBorder} text={sim.strouhal != null ? "URANS · vortex shedding" : "URANS · post-stall"} />
                <HeaderChip color={C.muted} border={C.stroke} text={`${playerModel.periodsRetained} periods retained`} />
                <HeaderChip
                  testId="sim-chip-stationary"
                  color={playerModel.stationary ? C.teal : C.red}
                  border={playerModel.stationary ? C.tealBorder : C.stroke}
                  text={`${playerModel.stationary ? "stationary ✓" : "non-stationary ✗"} · drift ${fmt(playerModel.driftFrac * 100, 1)}%`}
                />
                {sim.strouhal != null && <HeaderChip color={C.muted} border={C.stroke} text={`St ${f2(sim.strouhal)}`} />}
                <HeaderChip color={C.dim} border={C.stroke} text={`${playerModel.frames.length} frames · ${windowPeriodCount(playerModel) ?? "?"} periods recorded`} />
              </div>

              {/* accent stats: time-weighted means over the integer-period window */}
              <div data-testid="sim-accent-stats" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 10, margin: "0 0 12px" }}>
                <AccentStat label="Cl mean" color={C.teal} value={fmt(playerModel.stats.cl.mean, 3)} sub={`± ${fmt(playerModel.stats.cl.std, 3)} std`} />
                <AccentStat label="Cd mean" color={C.amber} value={fmt(playerModel.stats.cd.mean, 4)} sub={`± ${fmt(playerModel.stats.cd.std, 4)} std`} />
                <AccentStat label="Cm mean" color={C.text} value={fmt(playerModel.stats.cm.mean, 3)} sub={`± ${fmt(playerModel.stats.cm.std, 3)} std`} />
                <AccentStat
                  label="L/D"
                  color={C.teal}
                  value={Math.abs(playerModel.stats.cd.mean) > 1e-9 ? fmt(playerModel.stats.cl.mean / playerModel.stats.cd.mean, 2) : "—"}
                  sub="time-weighted means"
                />
                <AccentStat
                  label="Period"
                  color={C.muted}
                  value={playerModel.periodS != null ? `${fmt(playerModel.periodS, 3)} s` : "—"}
                  sub={playerModel.periodS != null ? `f ${fmt(1 / playerModel.periodS, 2)} Hz` : "no measured period"}
                />
              </div>

              {/* frame player: image + window chart, both driven by frameIndex */}
              <div data-testid="sim-frame-player" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)", gap: 12, alignItems: "stretch" }}>
                <div style={{ position: "relative", border: `1px solid ${C.stroke2}`, borderRadius: 10, overflow: "hidden", background: VIZ.bg, minHeight: 240 }}>
                  {(() => {
                    const frameUrl = frameImageUrl(playerModel, frameIdx, frameField);
                    if (frameUrl) return <img data-testid="sim-frame-image" src={browserUrl(frameUrl)} alt={`${frameField ?? "frame"} f${String(currentFrame.i).padStart(4, "0")}`} style={mediaStyle} />;
                    const fieldHasImages = frameField ? (playerModel.frameImageCounts[frameField] ?? 0) > 0 : false;
                    return (
                      <MediaEmpty
                        text={
                          fieldHasImages
                            ? "This frame's image evidence is not registered — the gap is shown, never interpolated."
                            : "No frame images are registered for this field yet — engine evidence files pending."
                        }
                      />
                    );
                  })()}
                  <span style={{ position: "absolute", top: 9, left: 10, display: "flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, fontWeight: 600, color: C.teal }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.teal }} />
                    RECORDED FRAMES · URANS
                  </span>
                  {mirroredBadge}
                  {preload && preload.total > 0 && preload.loaded + preload.failed < preload.total && (
                    <span data-testid="sim-frame-loading" style={{ position: "absolute", top: 9, right: 10, fontFamily: MONO, fontSize: 9, color: C.amber, background: "rgba(7,11,16,0.78)", borderRadius: 5, padding: "2px 6px" }}>
                      loading frames {preload.loaded + preload.failed}/{preload.total}
                    </span>
                  )}
                  {preload && preload.failed > 0 && preload.loaded + preload.failed >= preload.total && (
                    <span style={{ position: "absolute", top: 9, right: 10, fontFamily: MONO, fontSize: 9, color: C.red, background: "rgba(7,11,16,0.78)", borderRadius: 5, padding: "2px 6px" }}>
                      {preload.failed}/{preload.total} frames failed to load
                    </span>
                  )}
                  <span
                    data-testid="sim-frame-readout"
                    style={{ position: "absolute", bottom: 9, right: 10, fontFamily: MONO, fontSize: 9, color: "#e6edf3", background: "rgba(7,11,16,0.78)", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 5, padding: "3px 7px" }}
                  >
                    Cl {fmt(currentFrame.cl, 3)} · Cd {fmt(currentFrame.cd, 4)} · Cm {fmt(currentFrame.cm, 3)} · t {fmt(currentFrame.t, 3)} s
                    {(() => {
                      const po = periodOrdinal(playerModel, frameIdx);
                      return po ? ` · period ${po.ordinal}/${po.total}` : "";
                    })()}
                  </span>
                </div>
                <div style={{ border: `1px solid ${C.stroke2}`, borderRadius: 10, padding: "8px 10px", background: C.panel2, display: "grid", gap: 5, alignContent: "start" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", fontFamily: MONO }}>
                    <span style={{ fontSize: 10, color: C.teal }}>Cl(t) · recorded window</span>
                    <span style={{ fontSize: 9, color: C.dim }}>click / drag to seek</span>
                  </div>
                  <canvas
                    data-testid="sim-frame-chart"
                    ref={playerChartRef}
                    width={520}
                    height={236}
                    onPointerDown={(e) => {
                      chartDragRef.current = true;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      chartPointerToFrame(e);
                    }}
                    onPointerMove={(e) => {
                      if (chartDragRef.current) chartPointerToFrame(e);
                    }}
                    onPointerUp={() => { chartDragRef.current = false; }}
                    onPointerCancel={() => { chartDragRef.current = false; }}
                    style={{ display: "block", width: "100%", height: "auto", borderRadius: 5, touchAction: "none", cursor: "crosshair" }}
                  />
                </div>
              </div>

              {/* single transport: scrub + play/pause + speed */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <button
                  data-testid="sim-frame-play"
                  type="button"
                  onClick={onTogglePlay}
                  style={{ width: 34, height: 34, borderRadius: 9, background: C.teal, border: "none", color: C.tealInk, cursor: "pointer", fontSize: 13, flex: "none" }}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
                <input
                  data-testid="sim-frame-scrub"
                  type="range"
                  min={0}
                  max={Math.max(0, playerModel.frames.length - 1)}
                  step={1}
                  value={frameIdx}
                  onChange={(e) => seekFrame(Number(e.currentTarget.value))}
                  style={{ flex: 1 }}
                />
                <button data-testid="sim-frame-speed" type="button" onClick={() => setPlaySpeed((s) => (s === 1 ? 0.5 : 1))} style={{ ...dlBtn, color: C.teal }}>
                  {playSpeed === 1 ? "1.0×" : "0.5×"}
                </button>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>
                  frame {frameIdx + 1}/{playerModel.frames.length}
                </span>
              </div>

              {/* frame field selector (contract fields; disabled = no evidence) */}
              <div data-testid="sim-frame-fields" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: "0.1em" }}>FRAME FIELD</span>
                {playerModel.fields.map((f) => {
                  const count = playerModel.frameImageCounts[f] ?? 0;
                  const on = frameField === f;
                  return (
                    <button
                      key={f}
                      data-testid={`sim-frame-field-${f}`}
                      type="button"
                      disabled={count === 0}
                      onClick={() => setFrameField(f)}
                      title={count === 0 ? "No frame images registered for this field." : `${count}/${playerModel.frames.length} frame images registered`}
                      style={{
                        fontFamily: MONO,
                        fontSize: 11,
                        borderRadius: 7,
                        padding: "6px 12px",
                        cursor: count === 0 ? "not-allowed" : "pointer",
                        border: `1px solid ${on ? C.tealBorder : C.stroke}`,
                        background: on ? C.tealFill : C.panel3,
                        color: on ? C.teal : C.muted,
                        fontWeight: on ? 600 : 400,
                        opacity: count === 0 ? 0.45 : 1,
                      }}
                    >
                      {FIELD_LABELS[f as FieldId] ?? f}
                    </button>
                  );
                })}
              </div>

              {/* secondary: stored field media + evidence, unchanged */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 10px" }}>
                <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: "0.12em", whiteSpace: "nowrap" }}>STORED FIELD MEDIA &amp; EVIDENCE</span>
                <div style={{ flex: 1, height: 1, background: C.stroke2 }} />
              </div>
              {fieldTabsRow()}
              {renderTools()}
              {activeScaleChip()}
              {mediaPairGrid()}
              {forceMonitorsGrid()}
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.dimmest, marginTop: 11, lineHeight: 1.5 }}>
                URANS, k-ω SST · player frames are the engine-recorded period-locked window; means are time-weighted over an integer number of periods. Full force histories above are synced to the same frame clock.
              </div>
              {setupDetails()}
            </>
          ) : stalled ? (
            <>
              {renderTools()}
              {activeScaleChip()}
              {/* legacy pre-contract URANS evidence: no frame track recorded */}
              <div data-testid="sim-legacy-note" style={{ fontFamily: MONO, fontSize: 10, color: C.amber, border: `1px solid ${C.stroke2}`, background: C.panel2, borderRadius: 8, padding: "7px 10px", margin: "0 0 10px", lineHeight: 1.5 }}>
                legacy evidence — no frame track. This result predates the URANS recording contract, so the stored mp4 loop is shown instead of frame-synced playback. Re-solving the point records frames.
              </div>
              {mediaPairGrid()}

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
              {forceMonitorsGrid()}
              {steadyHistorySection()}
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
              {/* accent stats block (steady: single converged values, no player) */}
              <div data-testid="sim-accent-stats" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 10, marginTop: 13 }}>
                <AccentStat label="Cl" color={C.teal} value={f2(sim.cl)} sub="converged steady value" />
                <AccentStat label="Cd" color={C.amber} value={f4(sim.cd)} sub="converged steady value" />
                <AccentStat label="Cm" color={C.text} value={f2(sim.cm)} sub="converged steady value" />
                <AccentStat label="L/D" color={C.teal} value={f1(sim.ld)} sub="Cl / Cd" />
              </div>
              {steadyModel ? (
                steadyHistorySection()
              ) : (
                <div style={{ fontFamily: MONO, fontSize: 10, color: C.dimmest, marginTop: 11, textAlign: "center" }}>
                  Attached flow — steady RANS converges to a single field, so no animation or force history.
                </div>
              )}
              {setupDetails()}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderChip({ text, color, border, testId }: { text: string; color: string; border: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.05em", color, border: `1px solid ${border}`, borderRadius: 999, padding: "4px 9px", background: C.panel2, whiteSpace: "nowrap" }}
    >
      {text}
    </span>
  );
}

function AccentStat({ label, color, value, sub }: { label: string; color: string; value: string; sub: string }) {
  return (
    <div style={{ border: `1px solid ${C.tealBorder}`, borderRadius: 9, background: C.tealFill, padding: "9px 12px", minWidth: 0 }}>
      <div style={{ fontFamily: MONO, fontSize: 9, color, letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 18, color: C.text, fontWeight: 600, lineHeight: 1.25 }}>{value}</div>
      <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{sub}</div>
    </div>
  );
}

/** Cl(t) over the recorded frame window: teal trace through every frame
 *  sample (time-positioned x), dashed time-weighted mean, dotted period
 *  boundaries, and a cursor line + marker at frames[frameIndex].t. Pointer
 *  mapping shares PLAYER_CHART_GEOMETRY with frameForChartX so a click lands
 *  exactly on the frame under the cursor. */
function drawWindowChart(
  g: CanvasRenderingContext2D,
  opts: { width: number; height: number; model: FramePlayerModel; frameIndex: number },
) {
  const { width: W, height: H, model, frameIndex } = opts;
  const geom = { width: W, ...PLAYER_CHART_GEOMETRY };
  const padT = 12;
  const padB = 24;
  const plotH = H - padT - padB;
  g.fillStyle = VIZ.panel;
  g.fillRect(0, 0, W, H);
  const values = model.frames.map((f) => f.cl).filter(Number.isFinite);
  if (values.length === 0) return;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-12) {
    lo -= 0.5;
    hi += 0.5;
  }
  const span = hi - lo;
  const yv = (v: number) => padT + (1 - (v - lo) / span) * plotH;
  const xv = (t: number) => chartXForTime(t, model, geom);

  // horizontal grid
  g.strokeStyle = "rgba(148,163,184,0.16)";
  g.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (i / 3) * plotH;
    g.beginPath();
    g.moveTo(geom.padLeft, y);
    g.lineTo(W - geom.padRight, y);
    g.stroke();
  }
  // period boundaries
  const total = windowPeriodCount(model);
  if (total != null && model.periodS != null) {
    g.strokeStyle = "rgba(148,163,184,0.22)";
    g.setLineDash([2, 4]);
    for (let k = 1; k < total; k++) {
      const x = xv(model.tStart + k * model.periodS);
      g.beginPath();
      g.moveTo(x, padT);
      g.lineTo(x, H - padB);
      g.stroke();
    }
    g.setLineDash([]);
  }
  // axes
  g.strokeStyle = "rgba(148,163,184,0.3)";
  g.beginPath();
  g.moveTo(geom.padLeft, padT);
  g.lineTo(geom.padLeft, H - padB);
  g.lineTo(W - geom.padRight, H - padB);
  g.stroke();
  // labels
  g.fillStyle = "rgba(148,163,184,0.75)";
  g.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
  g.textAlign = "right";
  g.fillText(fmt(hi, 3), geom.padLeft - 6, padT + 4);
  g.fillText(fmt(lo, 3), geom.padLeft - 6, H - padB + 3);
  g.textAlign = "left";
  g.fillText(`${fmt(model.tStart, 2)}s`, geom.padLeft, H - padB + 13);
  g.textAlign = "right";
  g.fillText(`${fmt(model.tEnd, 2)}s`, W - geom.padRight, H - padB + 13);
  // time-weighted mean (the pinned point-level Cl)
  const mean = model.stats.cl.mean;
  if (Number.isFinite(mean) && mean >= lo && mean <= hi) {
    g.strokeStyle = "rgba(230,237,243,0.25)";
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(geom.padLeft, yv(mean));
    g.lineTo(W - geom.padRight, yv(mean));
    g.stroke();
    g.setLineDash([]);
  }
  // trace through the frame samples
  g.strokeStyle = "#2dd4bf";
  g.lineWidth = 1.6;
  g.beginPath();
  model.frames.forEach((f, k) => {
    const x = xv(f.t);
    const y = yv(f.cl);
    if (k === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
  // cursor at the current frame
  const idx = Math.max(0, Math.min(model.frames.length - 1, frameIndex));
  const cur = model.frames[idx];
  const cx = xv(cur.t);
  g.strokeStyle = "rgba(230,237,243,0.5)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx, padT);
  g.lineTo(cx, H - padB);
  g.stroke();
  g.fillStyle = "#e6edf3";
  g.beginPath();
  g.arc(cx, yv(cur.cl), 3.4, 0, Math.PI * 2);
  g.fill();
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

/** Oscillating-steady iteration trace: same visual language as the force
 *  monitors (grid, axes, min/max labels, dashed mean) plus the shaded
 *  averaging window — a static chart, no cursor. */
function drawSteadyHistoryChart(
  ctx: CanvasRenderingContext2D,
  opts: { width: number; height: number; values: number[]; color: string; model: SteadyHistoryModel },
) {
  const { width: W, height: H, values, color, model } = opts;
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

  // averaging window shading (real window bounds from the engine payload)
  const wx0 = padL + model.windowStartFrac * plotW;
  const wx1 = padL + model.windowEndFrac * plotW;
  ctx.fillStyle = "rgba(45,212,191,0.08)";
  ctx.fillRect(wx0, padT, Math.max(1, wx1 - wx0), plotH);

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
  ctx.textAlign = "left";
  ctx.fillText(`iter ${model.iterations[0]}`, padL, H - padB + 13);
  ctx.textAlign = "right";
  ctx.fillText(`${model.iterations[model.iterations.length - 1]}`, W - padR, H - padB + 13);

  // dashed window mean (the value the point-level coefficient reports)
  const winValues = values.slice(
    Math.round(model.windowStartFrac * (values.length - 1)),
    Math.round(model.windowEndFrac * (values.length - 1)) + 1,
  ).filter(Number.isFinite);
  if (winValues.length) {
    const mean = winValues.reduce((s, v) => s + v, 0) / winValues.length;
    ctx.strokeStyle = "rgba(230,237,243,0.22)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yv(mean));
    ctx.lineTo(W - padR, yv(mean));
    ctx.stroke();
    ctx.setLineDash([]);
  }

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
