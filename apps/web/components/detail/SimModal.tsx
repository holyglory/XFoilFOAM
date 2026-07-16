"use client";

import {
  f1,
  f2,
  type FieldId,
  type FieldTrackPoint,
  fRe,
  type Point,
  type SimulationDetail,
} from "@aerodb/core";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getResultReviews, isAdminApiError } from "@/lib/admin";
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
  PLAYER_CHART_GEOMETRY,
  periodOrdinal,
  periodTickFractions,
  type FramePlayerModel,
  type PlaybackSpeed,
  timeForFrameIndex,
  windowPeriodCount,
} from "@/lib/frame-player";
import { fidelityChipView } from "@/lib/point-history";
import {
  gateChecklistView,
  latestResultReviewLine,
  resultReviewGates,
  reviewStepperView,
  shouldShowReviewLayer,
  type ResultReviewRecord,
  type SimModalReviewContext,
} from "@/lib/result-review";
import {
  buildSteadyHistoryModel,
  oscillatingSnapshotCaption,
  summarizeSteadyWindow,
  type SteadyHistoryModel,
} from "@/lib/steady-history";
import { buildSolverWorkPopoverView } from "@/lib/solver-work";
import { C, MONO, VIZ } from "@/lib/tokens";

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
const FIELD_ID_SET = new Set<string>(FIELDS);
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
const COLORMAPS = [
  "viridis",
  "coolwarm",
  "magma",
  "plasma",
  "cividis",
  "turbo",
];

function asFieldId(value: string | null | undefined): FieldId | null {
  return value && FIELD_ID_SET.has(value) ? (value as FieldId) : null;
}

function labelForField(value: string | null | undefined): string {
  if (!value) return "field";
  const fid = asFieldId(value);
  return fid ? FIELD_LABELS[fid] : value.replace(/_/g, " ");
}

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
  ctx: {
    re: number;
    aoa: number;
    resultId?: string | null;
    mirrored?: boolean;
    mirroredFromAoaDeg?: number | null;
  } | null;
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
  review?: SimModalReviewContext | null;
}) {
  const {
    open,
    ctx,
    sim,
    name,
    machStr,
    field,
    onField,
    track,
    onTrackPoint,
    playing,
    onTogglePlay,
    onClose,
    unavailableMessage,
    review,
  } = props;

  const clMonRef = useRef<HTMLCanvasElement>(null);
  const cdMonRef = useRef<HTMLCanvasElement>(null);
  const ldMonRef = useRef<HTMLCanvasElement>(null);
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [customRender, setCustomRender] = useState<{
    field: FieldId;
    role: "instantaneous" | "mean";
    url: string;
    cached: boolean;
  } | null>(null);
  const [customRole, setCustomRole] = useState<"instantaneous" | "mean">(
    "instantaneous",
  );
  const [zoomChords, setZoomChords] = useState(2);
  const [colormap, setColormap] = useState("viridis");
  const [levels, setLevels] = useState(40);
  const [scaleMode, setScaleMode] = useState<"track" | "auto" | "manual">(
    "track",
  );
  const [vmin, setVmin] = useState("");
  const [vmax, setVmax] = useState("");
  const [widthPx, setWidthPx] = useState(990);
  const [heightPx, setHeightPx] = useState(660);
  const [renderToolsOpen, setRenderToolsOpen] = useState(false);
  const [expandedRenderControl, setExpandedRenderControl] = useState<
    "role" | "zoom" | "map" | "levels" | "scale" | "resolution" | null
  >(null);
  const [lockAspect, setLockAspect] = useState(true);
  const [setupDetailsOpen, setSetupDetailsOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<
    "continue-6h" | "request-full-tier" | null
  >(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewHistory, setReviewHistory] = useState<ResultReviewRecord[]>([]);
  const [reviewDismissed, setReviewDismissed] = useState(false);

  // ---- URANS frame player (task #25): ONE state drives every surface. ----
  const [frameIndex, setFrameIndex] = useState(0);
  const [playSpeed, setPlaySpeed] = useState<PlaybackSpeed>(1);
  const [frameField, setFrameField] = useState<string | null>(null);
  const [preload, setPreload] = useState<{
    field: string;
    loaded: number;
    failed: number;
    total: number;
  } | null>(null);
  const playerSimTimeRef = useRef(0);
  const chartDragRef = useRef(false);
  const preloadImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());

  const stalled = sim?.regime === "stalled";
  // Engine-recorded frame track → player model; null = steady, no-shedding,
  // pre-contract, or drifted payload, which stays in the static media layout.
  const playerModel = useMemo(
    () => buildFramePlayerModel(sim?.frameTrack ?? null),
    [sim?.frameTrack],
  );
  // Oscillating-steady iteration history (fidelity ladder contract 2): null =
  // classic pointwise convergence — the section renders nothing new.
  const steadyModel = useMemo(
    () => buildSteadyHistoryModel(sim?.steadyHistory ?? null),
    [sim?.steadyHistory],
  );
  const framesMode = Boolean(playerModel && stalled);
  const frameIdx = playerModel
    ? clampFrameIndex(playerModel.frames.length, frameIndex)
    : -1;
  const currentFrame =
    playerModel && frameIdx >= 0 ? playerModel.frames[frameIdx] : null;
  const activeField = frameField ?? field;
  const activeFieldId = asFieldId(activeField);
  const fieldLabel = labelForField(activeField);
  const realField = (f: FieldId | null) =>
    f && sim?.status === "solved" ? sim.media?.[f] : undefined;
  const activeStoredMedia = realField(activeFieldId);
  const fieldChoices = useMemo(() => {
    const out: string[] = [];
    const add = (value: string | null | undefined) => {
      if (!value || out.includes(value)) return;
      out.push(value);
    };
    playerModel?.fields.forEach(add);
    sim?.availableFields.forEach(add);
    add(field);
    return out;
  }, [field, playerModel, sim?.availableFields]);
  const isAnimatedField = Boolean(
    playerModel &&
    activeField &&
    (playerModel.frameImageCounts[activeField] ?? 0) > 0,
  );
  const transportActive = Boolean(
    framesMode && playerModel && currentFrame && isAnimatedField,
  );
  const sortedTrack = useMemo(
    () => track.slice().sort((a, b) => a.aoa - b.aoa),
    [track],
  );
  const selectedTrackIndex = useMemo(() => {
    if (!sortedTrack.length) return -1;
    const byId = ctx?.resultId
      ? sortedTrack.findIndex((p) => p.resultId === ctx.resultId)
      : -1;
    if (byId >= 0) return byId;
    return sortedTrack.findIndex(
      (p) => Math.abs(p.aoa - (sim?.alpha ?? ctx?.aoa ?? 0)) < 1e-6,
    );
  }, [ctx?.aoa, ctx?.resultId, sim?.alpha, sortedTrack]);
  const evidenceBundle =
    sim?.evidenceArtifacts?.find(
      (artifact) => artifact.kind === "engine_bundle",
    ) ??
    sim?.evidenceArtifacts?.find(
      (artifact) => artifact.kind === "openfoam_bundle",
    ) ?? null;
  const fieldDataArtifact =
    sim?.evidenceArtifacts?.find(
      (artifact) =>
        artifact.kind === "vtk_window" || artifact.kind === "field_data",
    ) ?? null;
  const steadySummary = useMemo(
    () => summarizeSteadyWindow(steadyModel),
    [steadyModel],
  );
  const reviewLayerEligible = Boolean(
    ctx?.resultId && shouldShowReviewLayer(!!review?.admin, review?.point),
  );
  const reviewLayerVisible = reviewLayerEligible && !reviewDismissed;
  const reviewGates = useMemo(() => resultReviewGates(sim), [sim]);
  const reviewChecklist = useMemo(
    () => gateChecklistView(reviewGates),
    [reviewGates],
  );
  const reviewStepper = useMemo(
    () => reviewStepperView(review?.queue ?? [], ctx?.resultId),
    [ctx?.resultId, review?.queue],
  );
  const reviewActions = useMemo(
    () =>
      review
        ? buildSolverWorkPopoverView(review.condition, review.point, true)
            .actions
        : [],
    [review],
  );
  const canContinue6h = Boolean(
    review?.point.continuable && ctx?.resultId && review?.onContinue6h,
  );
  const canRequestFullTier = Boolean(
    review?.onRequestFull &&
    reviewActions.some((action) => action.kind === "request-full-tier"),
  );
  const latestHistory = useMemo(
    () => latestResultReviewLine(reviewHistory),
    [reviewHistory],
  );

  // reset the animation clock when a new point is opened
  useEffect(() => {
    setCustomRender(null);
    setRenderError(null);
    setRenderToolsOpen(false);
    setExpandedRenderControl(null);
    setPlaySpeed(1);
    setReviewError(null);
    setReviewHistory([]);
    setReviewDismissed(false);
  }, [ctx?.re, ctx?.aoa, ctx?.resultId]);

  useEffect(() => {
    if (!open || !reviewLayerEligible || !ctx?.resultId) return;
    let cancelled = false;
    getResultReviews(ctx.resultId)
      .then((payload) => {
        if (!cancelled) setReviewHistory(payload.items);
      })
      .catch((e) => {
        if (!cancelled)
          setReviewError(isAdminApiError(e) ? e.message : (e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx?.resultId, open, reviewLayerEligible]);

  // new frame track loaded → rewind the player and pick the default field
  useEffect(() => {
    setFrameIndex(0);
    playerSimTimeRef.current = playerModel?.tStart ?? 0;
    setFrameField(
      (current) =>
        current ?? (playerModel ? defaultFrameField(playerModel) : field),
    );
  }, [field, playerModel]);

  useEffect(() => {
    if (!open || !fieldChoices.length) return;
    setFrameField((current) =>
      current && fieldChoices.includes(current) ? current : fieldChoices[0],
    );
  }, [fieldChoices, open]);

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
      img.addEventListener(
        "load",
        () => {
          loaded += 1;
          publish();
        },
        { once: true },
      );
      img.addEventListener(
        "error",
        () => {
          failed += 1;
          publish();
        },
        { once: true },
      );
    }
    publish();
    return () => {
      cancelled = true;
    };
  }, [open, playerModel, frameField]);

  // Playback: rAF advances the sim clock at real-time-scaled speed (one
  // shedding period per wall second at 1×) and snaps to the nearest frame.
  useEffect(() => {
    if (!open || !transportActive || !playerModel || !playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      playerSimTimeRef.current = advancePlayback(
        playerSimTimeRef.current,
        dt,
        playSpeed,
        playerModel,
      );
      const idx = frameIndexForTime(
        playerModel.times,
        playerSimTimeRef.current,
      );
      if (idx >= 0) setFrameIndex((prev) => (prev === idx ? prev : idx));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open, transportActive, playerModel, playing, playSpeed]);

  // Hero chart column: one geometry for URANS frame windows and RANS steady
  // convergence. Empty states stay in the same slots instead of reshuffling.
  useEffect(() => {
    if (!open) return;
    if (framesMode && playerModel) {
      const charts: Array<
        [HTMLCanvasElement | null, "cl" | "cd" | "ld", string]
      > = [
        [clMonRef.current, "cl", "#2dd4bf"],
        [cdMonRef.current, "cd", "#f59e0b"],
        [ldMonRef.current, "ld", "#e6edf3"],
      ];
      for (const [canvas, series, color] of charts) {
        if (!canvas) continue;
        const g = canvas.getContext("2d");
        if (!g) continue;
        drawFrameWindowChart(g, {
          width: canvas.width,
          height: canvas.height,
          model: playerModel,
          frameIndex: frameIdx,
          series,
          color,
        });
      }
      return;
    }
    if (steadyModel) {
      const charts: Array<[HTMLCanvasElement | null, number[], string]> = [
        [clMonRef.current, steadyModel.cl, "#2dd4bf"],
        [cdMonRef.current, steadyModel.cd, "#f59e0b"],
        [ldMonRef.current, steadyModel.cm, "#e6edf3"],
      ];
      for (const [canvas, values, color] of charts) {
        if (!canvas) continue;
        const g = canvas.getContext("2d");
        if (!g) continue;
        drawSteadyHistoryChart(g, {
          width: canvas.width,
          height: canvas.height,
          values,
          color,
          model: steadyModel,
        });
      }
      return;
    }
    for (const canvas of [
      clMonRef.current,
      cdMonRef.current,
      ldMonRef.current,
    ]) {
      if (!canvas) continue;
      const g = canvas.getContext("2d");
      if (!g) continue;
      drawEmptyChart(g, { width: canvas.width, height: canvas.height });
    }
  }, [open, framesMode, playerModel, frameIdx, steadyModel]);

  const seekFrame = useCallback(
    (idx: number) => {
      if (!transportActive || !playerModel) return;
      const k = clampFrameIndex(playerModel.frames.length, idx);
      if (k < 0) return;
      setFrameIndex(k);
      playerSimTimeRef.current = timeForFrameIndex(playerModel, k);
      if (playing) onTogglePlay();
    },
    [transportActive, playerModel, playing, onTogglePlay],
  );

  const chartPointerToFrame = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!transportActive || !playerModel) return;
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const x =
        ((e.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
      seekFrame(
        frameForChartX(x, playerModel, {
          width: canvas.width,
          ...PLAYER_CHART_GEOMETRY,
        }),
      );
    },
    [transportActive, playerModel, seekFrame],
  );

  useEffect(() => {
    if (!open || sim?.status !== "solved" || !sim.availableFields.length)
      return;
    if (!sim.availableFields.includes(field)) onField(sim.availableFields[0]);
  }, [open, sim?.status, sim?.availableFields, field, onField]);

  if (!open) return null;

  const reStr = fRe(sim?.re ?? ctx?.re ?? 0);
  // Mirrored view: the header keeps the derived −α the user opened; the badge
  // on the media states the +α source (spec §9.3).
  const alphaStr = ctx?.mirrored
    ? f1(ctx.aoa)
    : f1(sim?.alpha ?? ctx?.aoa ?? 0);
  const shownMach = sim ? f2(sim.mach) : machStr;

  const currentStoredMediaUrl = () => {
    const media = activeStoredMedia;
    if (!media) return null;
    if (
      activeFieldId &&
      customRender?.field === activeFieldId &&
      customRender.role === "instantaneous"
    )
      return customRender.url;
    return media.imageUrl ?? (media.kind === "image" ? media.url : null);
  };
  const currentDownloadUrl = () =>
    activeFieldId && customRender?.field === activeFieldId
      ? customRender.url
      : currentStoredMediaUrl();
  const customRenderFor = (which: "live" | "mean") =>
    activeFieldId &&
    customRender?.field === activeFieldId &&
    customRender.role === (which === "mean" ? "mean" : "instantaneous")
      ? customRender.url
      : null;

  const requestCustomRender = async () => {
    if (!ctx?.resultId || !activeFieldId) return;
    setRenderBusy(true);
    setRenderError(null);
    try {
      const rendered = await renderResultField(ctx.resultId, {
        field: activeFieldId,
        role: customRole,
        scaleMode,
        zoomChords,
        colormap,
        levels,
        vmin: scaleMode === "manual" && vmin.trim() ? Number(vmin) : null,
        vmax: scaleMode === "manual" && vmax.trim() ? Number(vmax) : null,
        frameIndex:
          customRole === "instantaneous" && playerModel ? frameIdx : null,
        widthPx,
        heightPx,
      });
      setCustomRender({
        field: rendered.field,
        role: rendered.role as "instantaneous" | "mean",
        url: rendered.url,
        cached: rendered.cached,
      });
    } catch (e) {
      setRenderError((e as Error).message);
    } finally {
      setRenderBusy(false);
    }
  };

  const runReviewRemediation = async (
    kind: "continue-6h" | "request-full-tier",
  ) => {
    if (!review || reviewBusy) return;
    const run =
      kind === "continue-6h" ? review.onContinue6h : review.onRequestFull;
    if (!run) return;
    setReviewBusy(kind);
    setReviewError(null);
    try {
      const ok = await run();
      if (ok !== false) {
        await review.onRefresh();
        setReviewDismissed(true);
      }
    } catch (e) {
      setReviewError(isAdminApiError(e) ? e.message : (e as Error).message);
    } finally {
      setReviewBusy(null);
    }
  };

  const setRenderWidth = (value: number) => {
    const next = Math.max(320, Math.min(2400, Math.round(value)));
    const ratio = widthPx / Math.max(1, heightPx) || 1.5;
    setWidthPx(next);
    if (lockAspect)
      setHeightPx(Math.max(240, Math.min(1800, Math.round(next / ratio))));
  };
  const setRenderHeight = (value: number) => {
    const next = Math.max(240, Math.min(1800, Math.round(value)));
    const ratio = widthPx / Math.max(1, heightPx) || 1.5;
    setHeightPx(next);
    if (lockAspect)
      setWidthPx(Math.max(320, Math.min(2400, Math.round(next * ratio))));
  };
  const selectedScale = activeStoredMedia?.scale ?? null;
  const scaleLabel =
    scaleMode === "track"
      ? selectedScale
        ? `track ${fmtCompact(selectedScale.vmin)}…${fmtCompact(selectedScale.vmax)}`
        : "track unavailable"
      : scaleMode === "auto"
        ? "auto current"
        : vmin.trim() || vmax.trim()
          ? `${vmin.trim() || "auto"}…${vmax.trim() || "auto"}`
          : "manual";
  const renderControlButton = (
    key: typeof expandedRenderControl,
    label: string,
    value: string,
  ) => (
    <button
      type="button"
      onClick={() =>
        setExpandedRenderControl(expandedRenderControl === key ? null : key)
      }
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
        <div
          style={{
            ...panelStyle,
            gridTemplateColumns: "repeat(2, minmax(0, 120px))",
          }}
        >
          {(["instantaneous", "mean"] as const).map((role) => (
            <button
              key={role}
              type="button"
              onClick={() => setCustomRole(role)}
              style={{
                ...dlBtn,
                color: customRole === role ? C.teal : C.muted,
              }}
            >
              {role === "instantaneous" ? "instant" : "mean"}
            </button>
          ))}
        </div>
      );
    }
    if (expandedRenderControl === "zoom") {
      return (
        <div style={panelStyle}>
          <input
            type="range"
            min={0.25}
            max={5}
            step={0.05}
            value={zoomChords}
            onChange={(e) => setZoomChords(Number(e.currentTarget.value))}
          />
        </div>
      );
    }
    if (expandedRenderControl === "map") {
      return (
        <div
          style={{
            ...panelStyle,
            gridTemplateColumns: "repeat(auto-fit, minmax(86px, 1fr))",
          }}
        >
          {COLORMAPS.map((map) => (
            <button
              key={map}
              type="button"
              onClick={() => setColormap(map)}
              style={{ ...dlBtn, color: colormap === map ? C.teal : C.muted }}
            >
              {map}
            </button>
          ))}
        </div>
      );
    }
    if (expandedRenderControl === "levels") {
      return (
        <div style={panelStyle}>
          <input
            type="range"
            min={3}
            max={200}
            step={1}
            value={levels}
            onChange={(e) => setLevels(Number(e.currentTarget.value))}
          />
        </div>
      );
    }
    if (expandedRenderControl === "scale") {
      return (
        <div style={panelStyle}>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {(["track", "auto", "manual"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setScaleMode(mode)}
                style={{
                  ...dlBtn,
                  color: scaleMode === mode ? C.teal : C.muted,
                }}
              >
                {mode === "track"
                  ? "track scale"
                  : mode === "auto"
                    ? "auto current"
                    : "manual range"}
              </button>
            ))}
          </div>
          {scaleMode === "manual" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(110px, 1fr))",
                gap: 8,
              }}
            >
              <label style={miniLabel}>
                Min
                <input
                  value={vmin}
                  onChange={(e) => setVmin(e.currentTarget.value)}
                  placeholder="auto"
                  style={miniInput}
                />
              </label>
              <label style={miniLabel}>
                Max
                <input
                  value={vmax}
                  onChange={(e) => setVmax(e.currentTarget.value)}
                  placeholder="auto"
                  style={miniInput}
                />
              </label>
            </div>
          )}
        </div>
      );
    }
    return (
      <div
        style={{
          ...panelStyle,
          gridTemplateColumns: "1fr 1fr auto",
          alignItems: "end",
        }}
      >
        <label style={miniLabel}>
          Width {widthPx}px
          <input
            type="range"
            min={320}
            max={2400}
            step={10}
            value={widthPx}
            onChange={(e) => setRenderWidth(Number(e.currentTarget.value))}
          />
        </label>
        <label style={miniLabel}>
          Height {heightPx}px
          <input
            type="range"
            min={240}
            max={1800}
            step={10}
            value={heightPx}
            onChange={(e) => setRenderHeight(Number(e.currentTarget.value))}
          />
        </label>
        <button
          type="button"
          onClick={() => setLockAspect((v) => !v)}
          style={{ ...dlBtn, color: lockAspect ? C.teal : C.muted }}
        >
          {lockAspect ? "ratio locked" : "ratio free"}
        </button>
      </div>
    );
  };
  const activeScaleChip = () => {
    const scale = activeStoredMedia?.scale;
    if (!scale) return null;
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          margin: "-2px 0 8px",
        }}
      >
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: C.dim,
            border: `1px solid ${C.stroke}`,
            borderRadius: 999,
            padding: "4px 8px",
            background: C.panel2,
          }}
        >
          track scale {fmtCompact(scale.vmin)}…{fmtCompact(scale.vmax)}
          {scale.status && scale.status !== "active"
            ? ` · ${scale.status}`
            : ""}
        </span>
      </div>
    );
  };
  const renderTools = () => {
    if (sim?.status !== "solved") return null;
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {!renderToolsOpen ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setRenderToolsOpen(true)}
              style={{ ...dlBtn, color: C.teal }}
            >
              custom render
            </button>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 8,
              border: `1px solid ${C.stroke2}`,
              borderRadius: 9,
              background: C.panel2,
              padding: "8px 10px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                flexWrap: "wrap",
              }}
            >
              {renderControlButton(
                "role",
                "role",
                customRole === "instantaneous" ? "instant" : "mean",
              )}
              {renderControlButton("zoom", "zoom", `${fmt(zoomChords, 2)}c`)}
              {renderControlButton("map", "map", colormap)}
              {renderControlButton("levels", "levels", String(levels))}
              {renderControlButton("scale", "scale", scaleLabel)}
              {renderControlButton(
                "resolution",
                "size",
                `${widthPx}x${heightPx}`,
              )}
              <button
                type="button"
                disabled={renderBusy || !ctx?.resultId || !activeFieldId}
                title={
                  !ctx?.resultId
                    ? "No solved result is selected for custom rendering"
                    : !activeFieldId
                      ? "Custom rendering is available only for stored OpenFOAM fields."
                      : undefined
                }
                onClick={requestCustomRender}
                style={{ ...dlBtn, color: C.teal, marginLeft: "auto" }}
              >
                {renderBusy ? "rendering..." : "re-render"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenderToolsOpen(false);
                  setExpandedRenderControl(null);
                }}
                style={dlBtn}
              >
                hide
              </button>
            </div>
            {renderControlBody()}
            {(renderError || customRender) && (
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: renderError ? C.red : C.dim,
                }}
              >
                {renderError ??
                  `custom render ${customRender?.cached ? "loaded from cache" : "stored"}`}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };
  const fieldTabsRow = () => (
    <div
      data-testid="sim-frame-fields"
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      {fieldChoices.map((fid) => {
        const on = activeField === fid;
        const frameCount = playerModel?.frameImageCounts[fid] ?? 0;
        const stored = asFieldId(fid) ? realField(asFieldId(fid)) : undefined;
        const available = frameCount > 0 || Boolean(stored);
        const mode =
          frameCount > 0
            ? `${frameCount} frame images`
            : stored?.meanUrl || stored?.imageUrl || stored?.url
              ? "stored static media"
              : "no media registered";
        return (
          <button
            key={fid}
            data-testid={`sim-frame-field-${fid}`}
            type="button"
            disabled={!available}
            onClick={() => {
              setFrameField(fid);
              const typed = asFieldId(fid);
              if (typed) onField(typed);
            }}
            title={mode}
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
            {labelForField(fid)}
          </button>
        );
      })}
    </div>
  );

  const downloadChips = () => (
    <div
      style={{
        display: "flex",
        gap: 7,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      {currentDownloadUrl() ? (
        <a
          href={browserUrl(currentDownloadUrl()!)}
          download
          style={{ ...dlBtn, textDecoration: "none" }}
        >
          ↓ render .png
        </a>
      ) : (
        <button
          type="button"
          disabled
          style={{ ...dlBtn, cursor: "not-allowed", opacity: 0.45 }}
        >
          ↓ render .png
        </button>
      )}
      {evidenceBundle ? (
        <a
          href={browserUrl(evidenceBundle.downloadUrl)}
          download
          style={{ ...dlBtn, textDecoration: "none" }}
        >
          ↓ evidence
        </a>
      ) : (
        <button
          type="button"
          disabled
          style={{ ...dlBtn, cursor: "not-allowed", opacity: 0.45 }}
        >
          ↓ evidence
        </button>
      )}
      {fieldDataArtifact ? (
        <a
          href={browserUrl(fieldDataArtifact.downloadUrl)}
          download
          style={{ ...dlBtn, textDecoration: "none" }}
        >
          ↓ field data
        </a>
      ) : (
        <button
          type="button"
          disabled
          style={{ ...dlBtn, cursor: "not-allowed", opacity: 0.45 }}
        >
          ↓ field data
        </button>
      )}
    </div>
  );

  const setupDetails = () => {
    if (!sim?.condition) return null;
    return (
      <div>
        <button
          type="button"
          onClick={() => setSetupDetailsOpen((v) => !v)}
          style={{ ...dlBtn, color: setupDetailsOpen ? C.teal : C.muted }}
        >
          {setupDetailsOpen ? "▾ setup details" : "▸ setup details"}
        </button>
        {setupDetailsOpen && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: 8,
              marginTop: 9,
            }}
          >
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
                [
                  "ρ",
                  sim.condition.density
                    ? `${fmt(sim.condition.density, 4)} kg/m³`
                    : "—",
                ],
                [
                  "ν",
                  sim.condition.kinematicViscosity
                    ? fmtSci(sim.condition.kinematicViscosity)
                    : "—",
                ],
              ]}
            />
            <ConditionGroup
              title="Reference Geometry"
              rows={[["Chord", `${fmt(sim.condition.referenceChordM, 3)} m`]]}
            />
            {sim.condition.mesh && (
              <ConditionGroup
                title="Mesh"
                rows={[
                  [
                    "Cells",
                    sim.condition.mesh.nCells == null
                      ? "—"
                      : sim.condition.mesh.nCells.toLocaleString(),
                  ],
                  ["Mesher", mesherLabel(sim.condition.mesh.mesher)],
                  [
                    "Surface",
                    `${sim.condition.mesh.nSurface.toLocaleString()} cells`,
                  ],
                  [
                    "Radial",
                    `${sim.condition.mesh.nRadial.toLocaleString()} cells`,
                  ],
                  [
                    "Wake",
                    `${sim.condition.mesh.nWake.toLocaleString()} cells`,
                  ],
                  [
                    "Domain",
                    `${fmt(sim.condition.mesh.farfieldRadiusChords, 1)}c far · ${fmt(sim.condition.mesh.wakeLengthChords, 1)}c wake`,
                  ],
                  ["y+ target", fmt(sim.condition.mesh.targetYPlus, 2)],
                  [
                    "y+ avg/max",
                    sim.condition.mesh.yPlusAvg == null &&
                    sim.condition.mesh.yPlusMax == null
                      ? "—"
                      : `${fmtOptional(sim.condition.mesh.yPlusAvg, 2)} / ${fmtOptional(sim.condition.mesh.yPlusMax, 2)}`,
                  ],
                  [
                    "Iterations",
                    sim.condition.mesh.iterations == null
                      ? "—"
                      : sim.condition.mesh.iterations.toLocaleString(),
                  ],
                  [
                    "Residual",
                    sim.condition.mesh.finalResidual == null
                      ? "—"
                      : fmtCompact(sim.condition.mesh.finalResidual),
                  ],
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

  const reviewButtonStyle = (
    tone: "teal" | "amber" | "red" | "ghost",
    disabled = false,
  ): CSSProperties => {
    const color =
      tone === "teal"
        ? C.teal
        : tone === "amber"
          ? C.amber
          : tone === "red"
            ? C.redText
            : C.muted;
    const border =
      tone === "teal"
        ? C.tealBorder
        : tone === "amber"
          ? "rgba(245,158,11,0.55)"
          : tone === "red"
            ? "rgba(245,101,101,0.58)"
            : C.stroke;
    const background =
      tone === "teal"
        ? C.tealFill
        : tone === "amber"
          ? "rgba(245,158,11,0.08)"
          : tone === "red"
            ? "transparent"
            : "transparent";
    return {
      fontFamily: MONO,
      fontSize: 10,
      color,
      background,
      border: `1px solid ${border}`,
      borderRadius: 7,
      padding: "7px 10px",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.48 : 1,
      textAlign: "center",
    };
  };

  const reviewLayer = () => {
    if (!reviewLayerVisible || !review || !ctx?.resultId) return null;
    const continueDisabled = reviewBusy != null || !canContinue6h;
    const requestFullDisabled = reviewBusy != null || !canRequestFullTier;
    return (
      <aside
        data-testid="sim-review-layer"
        style={{
          display: "grid",
          gap: 12,
          alignSelf: "start",
          border: `1px solid ${C.stroke2}`,
          borderRadius: 10,
          background: C.panel2,
          padding: 12,
          minWidth: 0,
        }}
      >
        <div style={{ display: "grid", gap: 3 }}>
          <div
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: C.dim,
              letterSpacing: "0.08em",
            }}
          >
            EVIDENCE STATUS
          </div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>
            α {f1(review.point.aoaDeg)}° · Re {fRe(review.condition.reynolds)}
          </div>
        </div>
        {reviewChecklist.length > 0 && (
          <div
            data-testid="sim-review-gates"
            style={{ display: "grid", gap: 6 }}
          >
            {reviewChecklist.map((line) => (
              <div
                key={line.key}
                data-testid="sim-review-gate-line"
                data-pass={line.pass ? "true" : "false"}
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  lineHeight: 1.45,
                  color: line.pass ? C.teal : C.redText,
                  border: `1px solid ${line.pass ? C.tealBorder : "rgba(245,101,101,0.5)"}`,
                  background: C.panel3,
                  borderRadius: 7,
                  padding: "6px 8px",
                  overflowWrap: "anywhere",
                }}
              >
                {line.text}
              </div>
            ))}
          </div>
        )}
        {latestHistory && (
          <div
            data-testid="sim-review-audit-line"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: C.muted,
              lineHeight: 1.45,
              border: `1px solid ${C.stroke}`,
              borderRadius: 7,
              background: C.panel3,
              padding: "6px 8px",
              overflowWrap: "anywhere",
            }}
          >
            {latestHistory}
          </div>
        )}
        {(canContinue6h || canRequestFullTier) && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 7,
            }}
          >
            {canContinue6h && (
              <button
                type="button"
                data-testid="sim-review-continue-6h"
                disabled={continueDisabled}
                onClick={() => void runReviewRemediation("continue-6h")}
                style={reviewButtonStyle("amber", continueDisabled)}
              >
                {reviewBusy === "continue-6h" ? "queueing…" : "Continue +6h"}
              </button>
            )}
            {canRequestFullTier && (
              <button
                type="button"
                data-testid="sim-review-request-full"
                disabled={requestFullDisabled}
                onClick={() => void runReviewRemediation("request-full-tier")}
                style={reviewButtonStyle("amber", requestFullDisabled)}
              >
                {reviewBusy === "request-full-tier"
                  ? "queueing…"
                  : "Request full tier"}
              </button>
            )}
          </div>
        )}
        {reviewError && (
          <div
            data-testid="sim-review-inline-message"
            style={{
              fontFamily: MONO,
              fontSize: 10,
              color: reviewError ? C.redText : C.teal,
              lineHeight: 1.45,
              overflowWrap: "anywhere",
            }}
          >
            {reviewError}
          </div>
        )}
        {reviewStepper && (
          <div
            data-testid="sim-review-stepper"
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: `1px solid ${C.stroke2}`,
              paddingTop: 9,
              minWidth: 0,
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: C.dim,
                minWidth: 0,
              }}
            >
              {reviewStepper.label}
            </span>
            <button
              type="button"
              data-testid="sim-review-next"
              onClick={() => review.onOpenQueueItem(reviewStepper.next)}
              style={{
                ...reviewButtonStyle("ghost"),
                whiteSpace: "nowrap",
                padding: "5px 8px",
              }}
            >
              {reviewStepper.nextLabel}
            </button>
          </div>
        )}
      </aside>
    );
  };

  const resultContent = () => (
    <>
      {meansRow()}
      {activeScaleChip()}
      {heroSection()}
      <div
        data-testid="sim-footer"
        style={{
          display: "grid",
          gap: 10,
          marginTop: 14,
          paddingTop: 12,
          borderTop: `1px solid ${C.stroke2}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {setupDetails()}
          <div style={{ marginLeft: "auto" }}>{downloadChips()}</div>
          {renderTools()}
        </div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 10,
            color: C.dimmest,
            lineHeight: 1.5,
          }}
        >
          {provenanceText()}
        </div>
      </div>
    </>
  );

  // Derived-by-symmetry view (spec §9.3): the media element itself is flipped
  // vertically — overlays, labels and charts are never mirrored.
  const mirrored = Boolean(ctx?.mirrored);
  const mirroredSourceAoa =
    ctx?.mirroredFromAoaDeg ?? (ctx ? Math.abs(ctx.aoa) : null);
  const mediaStyle: CSSProperties = mirrored
    ? {
        display: "block",
        width: "100%",
        height: "auto",
        transform: "scaleY(-1)",
      }
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
      mirrored — derived from α = +
      {mirroredSourceAoa == null ? "?" : f1(mirroredSourceAoa)}° (symmetric
      airfoil)
    </span>
  ) : null;

  const qualityChips = () => {
    if (!sim) return null;
    if (stalled) {
      const frequency = playerModel?.periodS ? 1 / playerModel.periodS : null;
      return (
        <>
          <HeaderChip
            testId="sim-chip-stationary"
            color={
              playerModel?.stationary ? C.teal : playerModel ? C.red : C.amber
            }
            border={playerModel?.stationary ? C.tealBorder : C.stroke}
            text={
              playerModel
                ? `${playerModel.stationary ? "stationary ✓" : "stationary ✗"} · drift ${fmt(playerModel.driftFrac * 100, 1)}%`
                : "frame track unavailable"
            }
          />
          <HeaderChip
            color={C.muted}
            border={C.stroke}
            text={`${playerModel ? `${playerModel.periodsRetained} periods` : "periods unavailable"} · St ${sim.strouhal == null ? "—" : f2(sim.strouhal)} · f ${frequency == null ? "—" : `${fmt(frequency, 2)} Hz`}`}
          />
        </>
      );
    }
    const iterText =
      sim.condition?.mesh?.iterations == null
        ? ""
        : ` · ${sim.condition.mesh.iterations.toLocaleString()} iters`;
    if (steadyModel && steadySummary) {
      return (
        <HeaderChip
          color={steadyModel.meanStable ? C.teal : C.amber}
          border={
            steadyModel.meanStable ? C.tealBorder : "rgba(245,158,11,0.45)"
          }
          text={`oscillating steady · ±${fmt(steadySummary.clHalfAmplitude, 3)} Cl over ${steadySummary.iterCount.toLocaleString()} iters`}
        />
      );
    }
    return (
      <HeaderChip
        color={C.teal}
        border={C.tealBorder}
        text={`converged${iterText}`}
      />
    );
  };

  const alphaTrackBar = () => {
    const hasSiblings = sortedTrack.length > 0 && selectedTrackIndex >= 0;
    const value = hasSiblings ? selectedTrackIndex : 0;
    const total = hasSiblings ? sortedTrack.length : 1;
    const shown = hasSiblings
      ? sortedTrack[value]?.aoa
      : (sim?.alpha ?? ctx?.aoa ?? 0);
    return (
      <div
        data-testid="sim-alpha-track"
        style={{
          display: "grid",
          gap: 6,
          margin: "0 0 13px",
          padding: "8px 10px",
          border: `1px solid ${C.stroke2}`,
          borderRadius: 9,
          background: C.panel2,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 10,
            fontFamily: MONO,
            fontSize: 10,
            color: C.dim,
          }}
        >
          <span>AoA evidence</span>
          <span data-testid="sim-alpha-label">
            α {f1(shown ?? 0)}° · {value + 1}/{total}
          </span>
        </div>
        <input
          data-testid="sim-alpha-slider"
          aria-label="AoA evidence"
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          step={1}
          value={value}
          disabled={!hasSiblings || total < 2}
          onChange={(e) => {
            const next = sortedTrack[Number(e.currentTarget.value)];
            if (next) onTrackPoint(next);
          }}
          style={{
            width: "100%",
            opacity: hasSiblings && total > 1 ? 1 : 0.55,
          }}
        />
      </div>
    );
  };

  const meansRow = () => {
    if (!sim) return null;
    if (stalled && playerModel) {
      return (
        <div
          data-testid="sim-accent-stats"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(142px, 1fr))",
            gap: 10,
            margin: "0 0 12px",
          }}
        >
          <AccentStat
            label="Cl"
            color={C.teal}
            value={fmt(playerModel.stats.cl.mean, 3)}
            sub={`± ${fmt(playerModel.stats.cl.std, 3)} · time-weighted, ${playerModel.periodsRetained} whole periods`}
          />
          <AccentStat
            label="Cd"
            color={C.amber}
            value={fmt(playerModel.stats.cd.mean, 4)}
            sub={`± ${fmt(playerModel.stats.cd.std, 4)} · time-weighted, ${playerModel.periodsRetained} whole periods`}
          />
          <AccentStat
            label="Cm"
            color={C.text}
            value={fmt(playerModel.stats.cm.mean, 3)}
            sub={`± ${fmt(playerModel.stats.cm.std, 3)} · time-weighted, ${playerModel.periodsRetained} whole periods`}
          />
          <AccentStat
            label="L/D"
            color={C.teal}
            value={
              Math.abs(playerModel.stats.cd.mean) > 1e-9
                ? fmt(playerModel.stats.cl.mean / playerModel.stats.cd.mean, 2)
                : "—"
            }
            sub={`time-weighted, ${playerModel.periodsRetained} whole periods`}
          />
          <AccentStat
            label="Period"
            color={C.muted}
            value={
              playerModel.periodS != null
                ? `${fmt(playerModel.periodS, 3)} s`
                : "—"
            }
            sub={`${playerModel.periodS != null ? `f ${fmt(1 / playerModel.periodS, 2)} Hz` : "f —"} · window ${fmt(playerModel.tStart, 2)}–${fmt(playerModel.tEnd, 2)} s · ${playerModel.frames.length} frames`}
          />
        </div>
      );
    }
    const convergence =
      steadyModel && steadySummary
        ? {
            value: steadyModel.meanStable
              ? "oscillating steady"
              : "oscillating",
            sub: `±${fmt(steadySummary.clHalfAmplitude, 3)} Cl over ${steadySummary.iterCount.toLocaleString()} iters`,
          }
        : {
            value: "✓ steady",
            sub:
              [
                sim.condition?.mesh?.finalResidual == null
                  ? null
                  : `residuals ${fmtCompact(sim.condition.mesh.finalResidual)}`,
                sim.condition?.mesh?.iterations == null
                  ? null
                  : `${sim.condition.mesh.iterations.toLocaleString()} iters`,
              ]
                .filter(Boolean)
                .join(" · ") || "convergence history unavailable",
          };
    return (
      <div
        data-testid="sim-accent-stats"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(142px, 1fr))",
          gap: 10,
          margin: "0 0 12px",
        }}
      >
        <AccentStat
          label="Cl"
          color={C.teal}
          value={fmt(sim.cl, 4)}
          sub="converged coefficient"
        />
        <AccentStat
          label="Cd"
          color={C.amber}
          value={fmt(sim.cd, 5)}
          sub="converged coefficient"
        />
        <AccentStat
          label="Cm"
          color={C.text}
          value={fmtOptional(sim.cm, 4)}
          sub={
            sim.cm == null ? "coefficient unavailable" : "converged coefficient"
          }
        />
        <AccentStat
          label="L/D"
          color={C.teal}
          value={fmt(sim.ld, 2)}
          sub="Cl / Cd"
        />
        <AccentStat
          label="Convergence"
          color={steadyModel ? C.amber : C.teal}
          value={convergence.value}
          sub={convergence.sub}
        />
      </div>
    );
  };

  const selectedStaticUrl = () => {
    if (customRender?.field === activeFieldId) return customRender.url;
    if (!activeStoredMedia) return null;
    if (stalled)
      return (
        activeStoredMedia.meanUrl ??
        activeStoredMedia.imageUrl ??
        (activeStoredMedia.kind === "image" ? activeStoredMedia.url : null)
      );
    return (
      activeStoredMedia.imageUrl ??
      (activeStoredMedia.kind === "image" ? activeStoredMedia.url : null) ??
      activeStoredMedia.meanUrl ??
      null
    );
  };

  const heroImage = () => {
    if (transportActive && playerModel && currentFrame) {
      const frameUrl = frameImageUrl(playerModel, frameIdx, activeField);
      if (frameUrl) {
        return (
          <img
            data-testid="sim-frame-image"
            src={browserUrl(frameUrl)}
            alt={`${activeField ?? "frame"} f${String(currentFrame.i).padStart(4, "0")}`}
            style={mediaStyle}
          />
        );
      }
    }
    const staticUrl = selectedStaticUrl();
    if (staticUrl)
      return (
        <img
          data-testid="sim-frame-image"
          src={browserUrl(staticUrl)}
          alt={`${fieldLabel} static`}
          style={mediaStyle}
        />
      );
    if (sim?.status === "solved") {
      return (
        <MediaEmpty
          text={
            transportActive
              ? "This frame's image evidence is not registered — the gap is shown, never interpolated."
              : "No stored media is available for this field on this result."
          }
        />
      );
    }
    return (
      <MediaEmpty text="No solved OpenFOAM media is available for this point." />
    );
  };

  const imageTag = () => {
    if (transportActive) return "RECORDED FRAMES · URANS";
    if (stalled) return "x̄ static";
    return "RANS · steady static";
  };

  const overlayReadout = () => {
    if (transportActive && playerModel && currentFrame) {
      const po = periodOrdinal(playerModel, frameIdx);
      return `Cl ${fmt(currentFrame.cl, 3)} · Cd ${fmt(currentFrame.cd, 4)} · Cm ${fmt(currentFrame.cm, 3)} · t ${fmt(currentFrame.t, 3)} s${po ? ` · period ${po.ordinal}/${po.total}` : ""}`;
    }
    if (!sim) return "loading";
    return `Cl ${fmt(sim.cl, 3)} · Cd ${fmt(sim.cd, 4)} · Cm ${fmtOptional(sim.cm, 3)} · α ${alphaStr}°`;
  };

  const transportBar = () => {
    const max = Math.max(0, (playerModel?.frames.length ?? 1) - 1);
    const ticks = playerModel ? periodTickFractions(playerModel) : [];
    return (
      <div
        data-testid="sim-transport"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          opacity: transportActive ? 1 : 0.45,
        }}
      >
        <button
          data-testid="sim-frame-play"
          type="button"
          disabled={!transportActive}
          onClick={transportActive ? onTogglePlay : undefined}
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: transportActive ? C.teal : C.panel3,
            border: transportActive ? "none" : `1px solid ${C.stroke}`,
            color: transportActive ? C.tealInk : C.dim,
            cursor: transportActive ? "pointer" : "not-allowed",
            fontSize: 13,
            flex: "none",
          }}
        >
          {playing && transportActive ? "❚❚" : "▶"}
        </button>
        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            height: 24,
            display: "grid",
            alignItems: "center",
          }}
        >
          <input
            data-testid="sim-frame-scrub"
            aria-label="Frame scrubber"
            type="range"
            min={0}
            max={max}
            step={1}
            value={transportActive ? frameIdx : 0}
            disabled={!transportActive}
            onChange={(e) => seekFrame(Number(e.currentTarget.value))}
            style={{ width: "100%", margin: 0 }}
          />
          {ticks.map((tick) => (
            <span
              key={tick}
              aria-hidden="true"
              style={{
                position: "absolute",
                left: `${tick * 100}%`,
                top: 4,
                bottom: 4,
                width: 1,
                background: "rgba(230,237,243,0.32)",
                pointerEvents: "none",
              }}
            />
          ))}
        </div>
        <button
          data-testid="sim-frame-speed"
          type="button"
          disabled={!transportActive}
          onClick={() => setPlaySpeed((s) => (s === 1 ? 0.5 : 1))}
          style={{
            ...dlBtn,
            color: transportActive ? C.teal : C.dim,
            cursor: transportActive ? "pointer" : "not-allowed",
          }}
        >
          {playSpeed === 1 ? "1.0×" : "0.5×"}
        </button>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 11,
            color: C.muted,
            whiteSpace: "nowrap",
          }}
        >
          {transportActive && playerModel
            ? `frame ${frameIdx + 1}/${playerModel.frames.length}`
            : "static"}
        </span>
      </div>
    );
  };

  const chartCanvas = (
    ref: RefObject<HTMLCanvasElement | null>,
    testId: string,
    height: number,
  ) => (
    <canvas
      data-testid={testId}
      ref={ref}
      width={520}
      height={height}
      onPointerDown={(e) => {
        if (!transportActive) return;
        chartDragRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        chartPointerToFrame(e);
      }}
      onPointerMove={(e) => {
        if (chartDragRef.current) chartPointerToFrame(e);
      }}
      onPointerUp={() => {
        chartDragRef.current = false;
      }}
      onPointerCancel={() => {
        chartDragRef.current = false;
      }}
      style={{
        display: "block",
        width: "100%",
        height: "auto",
        borderRadius: 5,
        touchAction: "none",
        cursor: transportActive ? "crosshair" : "default",
      }}
    />
  );

  const chartsColumn = () => {
    const labels = framesMode
      ? ([
          ["Cl(t)", C.teal, clMonRef, "sim-frame-chart", 136],
          ["Cd(t)", C.amber, cdMonRef, "sim-frame-chart-cd", 116],
          ["L/D(t)", C.text, ldMonRef, "sim-frame-chart-ld", 116],
        ] as const)
      : ([
          ["Cl history", C.teal, clMonRef, "sim-frame-chart", 136],
          ["Cd history", C.amber, cdMonRef, "sim-frame-chart-cd", 116],
          ["Cm history", C.text, ldMonRef, "sim-frame-chart-ld", 116],
        ] as const);
    return (
      <div data-testid="sim-chart-column" style={{ display: "grid", gap: 8 }}>
        {labels.map(([title, color, ref, testId, height]) => (
          <div
            key={title}
            style={{
              border: `1px solid ${C.stroke2}`,
              borderRadius: 10,
              padding: "8px 10px",
              background: C.panel2,
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "baseline",
                fontFamily: MONO,
                marginBottom: 5,
              }}
            >
              <span style={{ fontSize: 10, color }}>{title}</span>
              <span style={{ fontSize: 9, color: C.dim, whiteSpace: "nowrap" }}>
                {transportActive
                  ? "click / drag to seek"
                  : steadyModel
                    ? "recorded iterations"
                    : "no history"}
              </span>
            </div>
            {chartCanvas(ref, testId, height)}
          </div>
        ))}
      </div>
    );
  };

  const heroSection = () => (
    <div data-testid="sim-frame-player" className="sim-hero-grid">
      <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
        {fieldTabsRow()}
        <div
          style={{
            position: "relative",
            border: `1px solid ${C.stroke2}`,
            borderRadius: 10,
            overflow: "hidden",
            background: VIZ.bg,
            minHeight: 300,
          }}
        >
          {heroImage()}
          <span
            style={{
              position: "absolute",
              top: 9,
              left: 10,
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontFamily: MONO,
              fontSize: 9,
              fontWeight: 600,
              color: transportActive ? C.teal : C.muted,
              background: "rgba(7,11,16,0.62)",
              borderRadius: 5,
              padding: "2px 6px",
            }}
          >
            {transportActive && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: C.teal,
                }}
              />
            )}
            {imageTag()}
          </span>
          {mirroredBadge}
          {preload &&
            transportActive &&
            preload.total > 0 &&
            preload.loaded + preload.failed < preload.total && (
              <span
                data-testid="sim-frame-loading"
                style={{
                  position: "absolute",
                  top: 9,
                  right: 10,
                  fontFamily: MONO,
                  fontSize: 9,
                  color: C.amber,
                  background: "rgba(7,11,16,0.78)",
                  borderRadius: 5,
                  padding: "2px 6px",
                }}
              >
                loading frames {preload.loaded + preload.failed}/{preload.total}
              </span>
            )}
          <span
            data-testid="sim-frame-readout"
            style={{
              position: "absolute",
              bottom: 9,
              right: 10,
              fontFamily: MONO,
              fontSize: 9,
              color: "#e6edf3",
              background: "rgba(7,11,16,0.78)",
              border: "1px solid rgba(148,163,184,0.25)",
              borderRadius: 5,
              padding: "3px 7px",
              maxWidth: "calc(100% - 18px)",
              whiteSpace: "normal",
              textAlign: "right",
            }}
          >
            {overlayReadout()}
          </span>
        </div>
        {(() => {
          const caption = oscillatingSnapshotCaption(
            steadySummary,
            transportActive,
          );
          return caption ? (
            <div
              data-testid="sim-snapshot-caption"
              style={{
                fontFamily: MONO,
                fontSize: 10,
                color: C.amber,
                opacity: 0.85,
                lineHeight: 1.5,
              }}
            >
              {caption}
            </div>
          ) : null;
        })()}
        {transportBar()}
      </div>
      {chartsColumn()}
    </div>
  );

  const provenanceText = () => {
    if (!sim) return "";
    if (stalled) {
      return `URANS k-ω SST · frames = ${playerModel ? "engine-recorded period-locked window" : "unavailable"} · stored media/evidence only`;
    }
    return `RANS ${sim.condition?.turbulenceModel ?? "solver"} · steady result evidence · stored media/evidence only`;
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
      <style jsx>{`
        .sim-hero-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.5fr) minmax(300px, 1fr);
          gap: 12px;
          align-items: start;
        }
        @media (max-width: 760px) {
          .sim-hero-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
        .sim-review-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(280px, 320px);
          gap: 14px;
          align-items: start;
        }
        @media (max-width: 900px) {
          .sim-review-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
      <div
        style={{
          width: reviewLayerVisible ? "min(1160px,94vw)" : "min(900px,94vw)",
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
          data-testid="sim-frame-chips"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            padding: "14px 18px",
            borderBottom: `1px solid ${C.border}`,
            position: "sticky",
            top: 0,
            background: C.modalBg,
            zIndex: 2,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 7,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <HeaderChip
              color={sim?.regime === "stalled" ? C.violet : C.teal}
              border={sim?.regime === "stalled" ? C.violetBorder : C.tealBorder}
              text={
                sim
                  ? stalled
                    ? "URANS · vortex shedding"
                    : "RANS · steady"
                  : unavailableMessage
                    ? "OpenFOAM result"
                    : "loading"
              }
            />
          </div>
          {(() => {
            // Fidelity ladder chip (same truth table as every classification
            // surface): plain for RANS/pre-ladder rows.
            const view = sim
              ? fidelityChipView(sim.fidelity ?? null, sim.uransVerify ?? null)
              : null;
            if (!view) return null;
            const color =
              view.tone === "teal"
                ? C.teal
                : view.tone === "amber"
                  ? C.amber
                  : C.red;
            const border =
              view.tone === "teal"
                ? C.tealBorder
                : view.tone === "amber"
                  ? "rgba(245,158,11,0.45)"
                  : "rgba(245,101,101,0.5)";
            return (
              <span
                data-testid="sim-fidelity-chip"
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: "0.05em",
                  color,
                  border: `1px solid ${border}`,
                  borderRadius: 999,
                  padding: "3px 9px",
                  whiteSpace: "nowrap",
                }}
              >
                {view.label}
              </span>
            );
          })()}
          <span style={{ fontWeight: 600, fontSize: 15 }}>{name}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>
            Re {reStr}&nbsp;&nbsp;·&nbsp;&nbsp;M {shownMach}
          </span>
          <div
            style={{
              display: "flex",
              gap: 7,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {qualityChips()}
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              marginLeft: "auto",
              width: 30,
              height: 30,
              borderRadius: 8,
              background: C.panel3,
              border: `1px solid ${C.stroke}`,
              color: C.muted,
              cursor: "pointer",
              fontSize: 15,
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "16px 18px 20px" }}>
          {alphaTrackBar()}

          {!sim ? (
            <div
              style={{
                fontFamily: MONO,
                fontSize: 12,
                color: unavailableMessage ? C.amber : C.muted,
                padding: "60px 0",
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              {unavailableMessage ?? "loading OpenFOAM result..."}
            </div>
          ) : reviewLayerVisible ? (
            <div className="sim-review-grid">
              <div style={{ minWidth: 0 }}>{resultContent()}</div>
              {reviewLayer()}
            </div>
          ) : (
            resultContent()
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderChip({
  text,
  color,
  border,
  testId,
}: {
  text: string;
  color: string;
  border: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      style={{
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: "0.05em",
        color,
        border: `1px solid ${border}`,
        borderRadius: 999,
        padding: "4px 9px",
        background: C.panel2,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function AccentStat({
  label,
  color,
  value,
  sub,
}: {
  label: string;
  color: string;
  value: string;
  sub: string;
}) {
  return (
    <div
      style={{
        border: `1px solid ${C.tealBorder}`,
        borderRadius: 9,
        background: C.tealFill,
        padding: "9px 12px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          color,
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 18,
          color: C.text,
          fontWeight: 600,
          lineHeight: 1.25,
        }}
      >
        {value}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{sub}</div>
    </div>
  );
}

/** Cl(t) over the recorded frame window: teal trace through every frame
 *  sample (time-positioned x), dashed time-weighted mean, dotted period
 *  boundaries, and a cursor line + marker at frames[frameIndex].t. Pointer
 *  mapping shares PLAYER_CHART_GEOMETRY with frameForChartX so a click lands
 *  exactly on the frame under the cursor. */
function drawFrameWindowChart(
  g: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    model: FramePlayerModel;
    frameIndex: number;
    series: "cl" | "cd" | "ld";
    color: string;
  },
) {
  const { width: W, height: H, model, frameIndex, series, color } = opts;
  const geom = { width: W, ...PLAYER_CHART_GEOMETRY };
  const padT = 12;
  const padB = 24;
  const plotH = H - padT - padB;
  g.fillStyle = VIZ.panel;
  g.fillRect(0, 0, W, H);
  const valueOf = (f: FramePlayerModel["frames"][number]) => {
    if (series === "cl") return f.cl;
    if (series === "cd") return f.cd;
    return Math.abs(f.cd) > 1e-9 ? f.cl / f.cd : Number.NaN;
  };
  const values = model.frames.map(valueOf).filter(Number.isFinite);
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
  const digits = series === "cd" ? 4 : 3;
  g.fillText(fmt(hi, digits), geom.padLeft - 6, padT + 4);
  g.fillText(fmt(lo, digits), geom.padLeft - 6, H - padB + 3);
  g.textAlign = "left";
  g.fillText(`${fmt(model.tStart, 2)}s`, geom.padLeft, H - padB + 13);
  g.textAlign = "right";
  g.fillText(`${fmt(model.tEnd, 2)}s`, W - geom.padRight, H - padB + 13);
  // time-weighted mean (the pinned point-level coefficient)
  const mean =
    series === "cl"
      ? model.stats.cl.mean
      : series === "cd"
        ? model.stats.cd.mean
        : Math.abs(model.stats.cd.mean) > 1e-9
          ? model.stats.cl.mean / model.stats.cd.mean
          : Number.NaN;
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
  g.strokeStyle = color;
  g.lineWidth = 1.6;
  g.beginPath();
  model.frames.forEach((f, k) => {
    const x = xv(f.t);
    const y = yv(valueOf(f));
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
  g.arc(cx, yv(valueOf(cur)), 3.4, 0, Math.PI * 2);
  g.fill();
}

function ConditionGroup({
  title,
  rows,
}: {
  title: string;
  rows: [string, string][];
}) {
  return (
    <div
      style={{
        display: "grid",
        gap: 5,
        background: C.panel2,
        border: `1px solid ${C.stroke2}`,
        borderRadius: 8,
        padding: "8px 10px",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          color: C.dim,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: "grid",
            gridTemplateColumns: "74px minmax(0, 1fr)",
            gap: 8,
            alignItems: "baseline",
            fontFamily: MONO,
            fontSize: 10,
            minWidth: 0,
          }}
        >
          <span style={{ color: C.dimmest }}>{label}</span>
          <span
            style={{
              color: C.muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function MediaEmpty({ text }: { text: string }) {
  return (
    <div
      style={{
        minHeight: 260,
        display: "grid",
        placeItems: "center",
        background: "#070b10",
        color: C.dim,
        fontFamily: MONO,
        fontSize: 11,
        textAlign: "center",
        padding: 20,
      }}
    >
      {text}
    </div>
  );
}

function fmt(n: number, digits: number) {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtSci(n: number) {
  return Number.isFinite(n)
    ? n.toExponential(3).replace("e", "e") + " m²/s"
    : "—";
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

/** Oscillating-steady iteration trace: same visual language as the force
 *  monitors (grid, axes, min/max labels, dashed mean) plus the shaded
 *  averaging window — a static chart, no cursor. */
function drawSteadyHistoryChart(
  ctx: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    values: number[];
    color: string;
    model: SteadyHistoryModel;
  },
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
  ctx.fillText(
    `${model.iterations[model.iterations.length - 1]}`,
    W - padR,
    H - padB + 13,
  );

  // dashed window mean (the value the point-level coefficient reports)
  const winValues = values
    .slice(
      Math.round(model.windowStartFrac * (values.length - 1)),
      Math.round(model.windowEndFrac * (values.length - 1)) + 1,
    )
    .filter(Number.isFinite);
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

function drawEmptyChart(
  ctx: CanvasRenderingContext2D,
  opts: { width: number; height: number },
) {
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
