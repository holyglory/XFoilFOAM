"use client";

import {
  CHART_VIEW,
  type ChartDomain,
  type ChartPointVM,
  type ChartProjection,
  type ChartType,
  type ProjectChartInput,
  derivedBySymmetryInfo,
  f1,
  f2,
  f4,
  readoutAtX,
  zoomChartDomain,
} from "@aerodb/core";
import { Maximize2, Minimize2 } from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { C, MONO, VIZ } from "@/lib/tokens";
import { containedBadgePosition, POLAR_BADGE_EDGE } from "@/lib/polar-badge";
import {
  formatPolarAoa,
  polarLegendItems,
  storedResultsHeading,
} from "@/lib/polar-series";
import type { HoverState } from "./DetailIsland";
import { type ChartCursor, PolarChart } from "./PolarChart";

const TABS: [ChartType, string][] = [
  ["cla", "Cl–α"],
  ["clcd", "Cl–Cd"],
  ["lda", "L/D–α"],
  ["cma", "Cm–α"],
];

/** Snap radius (viewBox units) within which the cursor locks onto a point. */
const SNAP_RADIUS = 14;
/** Button zoom step (coarser than a wheel notch). */
const BUTTON_ZOOM = 1.35;

export function PolarViewer(props: {
  chartType: ChartType;
  onChartType: (t: ChartType) => void;
  projection: ChartProjection;
  /** raw chart series — the mouse-following readout interpolates these */
  polars: ProjectChartInput["polars"];
  visibleSeries: Record<string, boolean>;
  onToggleSeries: (seriesId: string) => void;
  solvedPointCount: number;
  machStr: string;
  hover: HoverState | null;
  onHover: (h: HoverState | null) => void;
  onPointClick: (vm: ChartPointVM) => void;
  /** zoom/pan window (null = zoom-to-fit) */
  domain: ChartDomain | null;
  onDomainChange: (d: ChartDomain | null) => void;
  /** Optional non-polar view that shares this viewer's tab strip. */
  profileView?: {
    active: boolean;
    onActivate: () => void;
    content: ReactNode;
  };
}) {
  const {
    chartType,
    onChartType,
    projection,
    polars,
    visibleSeries,
    onToggleSeries,
    solvedPointCount,
    machStr,
    hover,
    onHover,
    onPointClick,
    domain,
    onDomainChange,
    profileView,
  } = props;
  const [cursor, setCursor] = useState<ChartCursor | null>(null);
  const [resultChoice, setResultChoice] = useState<ChartPointVM | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [badgePosition, setBadgePosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const chartSurfaceRef = useRef<HTMLDivElement | null>(null);
  const badgeRef = useRef<HTMLDivElement | null>(null);
  const maximizeButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewerId = useId();
  const panelId = `${viewerId}-panel`;

  useEffect(
    () => setResultChoice(null),
    [chartType, polars, profileView?.active],
  );

  useEffect(() => {
    if (!maximized) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMaximized(false);
      requestAnimationFrame(() => maximizeButtonRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [maximized]);

  const activateTab = (id: ChartType | "profile") => {
    if (id === "profile") {
      setCursor(null);
      onHover(null);
      profileView?.onActivate();
    } else {
      onChartType(id);
    }
  };

  const handleTabKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    id: ChartType | "profile",
  ) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ) ?? [],
    );
    if (tabs.length === 0) return;
    event.preventDefault();
    const current = tabs.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  // Point snap: within SNAP_RADIUS the badge shows the measured point's full
  // data (and the point enlarges via hoverKey); otherwise the badge shows the
  // curves' interpolated values at the cursor α.
  const handleCursor = useCallback(
    (c: ChartCursor | null) => {
      setCursor(c);
      if (!c) {
        onHover(null);
        return;
      }
      let best: ChartPointVM | null = null;
      let bestDist = SNAP_RADIUS;
      for (const p of projection.points) {
        const d = Math.hypot(p.cx - c.px, p.cy - c.py);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      if (best) {
        onHover({
          key: best.key,
          px: c.px,
          py: c.py,
          head:
            best.label +
            (best.point.classificationState === "needs_urans"
              ? " · needs URANS confirmation"
              : best.stalled
                ? " · post-stall"
                : ""),
          a: f1(best.point.a),
          cl: f2(best.point.cl),
          cd: f4(best.point.cd),
          ld: f1(best.point.ld),
        });
      } else {
        onHover(null);
      }
    },
    [projection.points, onHover],
  );

  const readoutRows = useMemo(
    () =>
      cursor && !hover
        ? readoutAtX({ chartType, polars, visibleSeries, x: cursor.x })
        : [],
    [cursor, hover, chartType, polars, visibleSeries],
  );
  const legendItems = useMemo(
    () => polarLegendItems(polars, visibleSeries),
    [polars, visibleSeries],
  );
  const readoutValue = (y: number) =>
    chartType === "lda" ? f1(y) : chartType === "cma" ? f4(y) : f2(y);
  const badgeAnchor = hover
    ? { px: hover.px, py: hover.py }
    : cursor && readoutRows.length > 0
      ? { px: cursor.px, py: cursor.py }
      : null;

  useLayoutEffect(() => {
    const surface = chartSurfaceRef.current;
    const badge = badgeRef.current;
    if (!surface || !badge || !badgeAnchor) {
      setBadgePosition(null);
      return;
    }
    const place = () => {
      const containerWidth = surface.clientWidth;
      const containerHeight = surface.clientHeight;
      const anchorX = (badgeAnchor.px / CHART_VIEW.w) * containerWidth;
      const anchorY = (badgeAnchor.py / CHART_VIEW.h) * containerHeight;
      setBadgePosition(
        containedBadgePosition({
          anchorX,
          anchorY,
          badgeWidth: badge.offsetWidth,
          badgeHeight: badge.offsetHeight,
          containerWidth,
          containerHeight,
        }),
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(surface);
    observer.observe(badge);
    return () => observer.disconnect();
  }, [
    badgeAnchor?.px,
    badgeAnchor?.py,
    hover?.head,
    readoutRows.length,
    maximized,
  ]);

  const zoomBy = (factor: number) => {
    const dom = projection.domain;
    onDomainChange(
      zoomChartDomain(dom, factor, {
        x: (dom.xMin + dom.xMax) / 2,
        y: (dom.yMin + dom.yMax) / 2,
      }),
    );
  };
  const solvedPointLabel = `${solvedPointCount} solved point${solvedPointCount === 1 ? "" : "s"}`;
  const hasPostStallPoints = projection.points.some(
    (p) => p.stalled || p.point.unsteady,
  );
  const hasProvisionalPoints = projection.points.some(
    (p) => p.point.classificationState === "needs_urans",
  );
  const hasDerivedPoints = projection.points.some(
    (p) => derivedBySymmetryInfo(p.point).derived,
  );
  const hasFitCurve = projection.curves.some((c) => c.kind === "fit");
  const projectedEvidence = projection.points.flatMap(
    (point) => point.resultChoices ?? [point.point],
  );
  const hasConflictPoints = projectedEvidence.some(
    (point) => point.evidenceRole === "conflict",
  );
  const hasAlternatePoints = projectedEvidence.some(
    (point) => point.evidenceRole === "alternate",
  );

  const activatePoint = useCallback(
    (vm: ChartPointVM) => {
      if ((vm.resultChoices?.length ?? 0) > 1) {
        setResultChoice(vm);
        return;
      }
      setResultChoice(null);
      onPointClick(vm);
    },
    [onPointClick],
  );

  const badgeStyle = (accent: string): CSSProperties => ({
    position: "absolute",
    left: badgePosition?.left ?? POLAR_BADGE_EDGE,
    top: badgePosition?.top ?? POLAR_BADGE_EDGE,
    visibility: badgePosition ? "visible" : "hidden",
    width: "min(238px, calc(100% - 16px))",
    maxHeight: "calc(100% - 16px)",
    boxSizing: "border-box",
    overflowY: "auto",
    overflowWrap: "anywhere",
    background: C.popover,
    border: `1px solid ${accent}`,
    borderRadius: 9,
    padding: "9px 11px",
    pointerEvents: "none",
    zIndex: 8,
    boxShadow: `0 10px 26px ${C.shadow}`,
  });
  const hoverStyle: CSSProperties = hover
    ? badgeStyle(C.teal)
    : { display: "none" };

  return (
    <div
      ref={viewerRef}
      data-testid="polar-viewer"
      data-maximized={maximized ? "true" : "false"}
      data-ui-allow-overlap={
        maximized
          ? "fullscreen chart intentionally covers page context"
          : undefined
      }
      role={maximized ? "dialog" : undefined}
      aria-modal={maximized ? "true" : undefined}
      aria-label={maximized ? "Maximized polar chart" : undefined}
      style={{
        background: C.panel,
        border: maximized ? "none" : `1px solid ${C.border}`,
        borderRadius: maximized ? 0 : 12,
        overflow: maximized ? "auto" : "hidden",
        ...(maximized
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 2000,
              width: "100vw",
              height: "100dvh",
            }
          : null),
      }}
    >
      {/* toolbar */}
      <div
        data-ui-allow-overlap="fixed top navigation intentionally covers this toolbar only after it has scrolled underneath the persistent header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: `1px solid ${C.borderSoft}`,
        }}
      >
        <div
          role="tablist"
          aria-label="Airfoil and polar views"
          style={{
            display: "flex",
            background: C.panel2,
            border: `1px solid ${C.stroke2}`,
            borderRadius: 9,
            padding: 3,
            gap: 2,
            maxWidth: "100%",
            overflowX: "auto",
          }}
        >
          {profileView && (
            <button
              type="button"
              role="tab"
              id={`${viewerId}-tab-profile`}
              aria-selected={profileView.active}
              aria-controls={panelId}
              tabIndex={profileView.active ? 0 : -1}
              data-testid="polar-tab-profile"
              onKeyDown={(event) => handleTabKey(event, "profile")}
              onClick={() => activateTab("profile")}
              style={{
                fontFamily: MONO,
                fontSize: 11,
                border: "none",
                borderRadius: 6,
                padding: "6px 11px",
                cursor: "pointer",
                background: profileView.active ? C.tabActive : "transparent",
                color: profileView.active ? C.teal : C.muted,
                fontWeight: profileView.active ? 600 : 400,
                whiteSpace: "nowrap",
              }}
            >
              Airfoil
            </button>
          )}
          {TABS.map(([id, label]) => {
            const on = !profileView?.active && chartType === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                id={`${viewerId}-tab-${id}`}
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                onKeyDown={(event) => handleTabKey(event, id)}
                onClick={() => activateTab(id)}
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 11px",
                  cursor: "pointer",
                  background: on ? C.tabActive : "transparent",
                  color: on ? C.teal : C.muted,
                  fontWeight: on ? 600 : 400,
                  whiteSpace: "nowrap",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {!profileView?.active && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 10,
              position: "relative",
              flex: "1 1 300px",
              minWidth: 0,
              maxWidth: "100%",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: solvedPointCount ? C.teal : C.dim,
                border: `1px solid ${solvedPointCount ? C.tealBorder : C.stroke}`,
                background: solvedPointCount ? C.tealFill : C.panel3,
                borderRadius: 8,
                padding: "7px 12px",
                whiteSpace: "nowrap",
              }}
            >
              {solvedPointCount
                ? solvedPointLabel
                : "waiting for solved points"}
            </span>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: C.dim,
                border: `1px solid ${C.stroke}`,
                borderRadius: 8,
                padding: "7px 11px",
              }}
            >
              M {machStr}
            </span>
            {/* zoom controls — wheel zooms at the cursor, drag pans, double-click fits */}
            <div
              style={{
                display: "flex",
                background: C.panel2,
                border: `1px solid ${C.stroke2}`,
                borderRadius: 9,
                padding: 3,
                gap: 2,
              }}
              title="scroll = zoom at cursor · drag = pan · double-click = fit"
            >
              <button
                type="button"
                data-testid="polar-zoom-out"
                aria-label="Zoom out"
                onClick={() => zoomBy(BUTTON_ZOOM)}
                style={{
                  fontFamily: MONO,
                  fontSize: 13,
                  lineHeight: "13px",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 9px",
                  cursor: "pointer",
                  background: "transparent",
                  color: C.muted,
                }}
              >
                −
              </button>
              <button
                type="button"
                data-testid="polar-zoom-in"
                aria-label="Zoom in"
                onClick={() => zoomBy(1 / BUTTON_ZOOM)}
                style={{
                  fontFamily: MONO,
                  fontSize: 13,
                  lineHeight: "13px",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 9px",
                  cursor: "pointer",
                  background: "transparent",
                  color: C.muted,
                }}
              >
                +
              </button>
              <button
                type="button"
                data-testid="polar-zoom-fit"
                aria-label="Zoom to fit"
                onClick={() => onDomainChange(null)}
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  lineHeight: "13px",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 9px",
                  cursor: "pointer",
                  background: domain ? C.tabActive : "transparent",
                  color: domain ? C.teal : C.muted,
                  fontWeight: domain ? 600 : 400,
                }}
              >
                fit
              </button>
              <button
                ref={maximizeButtonRef}
                type="button"
                data-testid="polar-maximize"
                aria-label={
                  maximized ? "Exit fullscreen chart" : "Maximize chart"
                }
                aria-pressed={maximized}
                onClick={() => setMaximized((value) => !value)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  borderRadius: 6,
                  padding: "5px 8px",
                  cursor: "pointer",
                  background: maximized ? C.tabActive : "transparent",
                  color: maximized ? C.teal : C.muted,
                }}
              >
                {maximized ? (
                  <Minimize2 size={14} aria-hidden="true" />
                ) : (
                  <Maximize2 size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {profileView?.active ? (
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={`${viewerId}-tab-profile`}
          data-testid="polar-profile-panel"
          style={{
            padding: "22px 24px 14px",
            minHeight: 340,
            display: "flex",
            alignItems: "center",
          }}
        >
          {profileView.content}
        </div>
      ) : (
        <>
          {/* chart */}
          <div
            id={panelId}
            role="tabpanel"
            aria-labelledby={`${viewerId}-tab-${chartType}`}
            data-testid="polar-chart-panel"
            data-domain-active={domain ? "true" : "false"}
            style={{ padding: "16px 16px 6px", position: "relative" }}
          >
            <div
              ref={chartSurfaceRef}
              data-testid="polar-chart-surface"
              style={{
                position: "relative",
                width: maximized ? 1200 : 684,
                maxWidth: "100%",
                boxSizing: "border-box",
                margin: "0 auto",
                background: VIZ.bg,
                borderRadius: 10,
                padding: "8px 6px",
              }}
            >
              <PolarChart
                projection={projection}
                onPointClick={activatePoint}
                onDomainChange={onDomainChange}
                onCursor={handleCursor}
              />
              <div
                style={{
                  position: "absolute",
                  left: 8,
                  top: 4,
                  fontFamily: MONO,
                  fontSize: 11,
                  color: VIZ.text,
                }}
              >
                {projection.yTitle}
              </div>
              {projection.points.length === 0 && (
                <div
                  style={{
                    position: "absolute",
                    inset: "22% 10%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    pointerEvents: "none",
                    fontFamily: MONO,
                    color: C.muted,
                    background: "rgba(7, 12, 18, 0.52)",
                    border: `1px dashed ${C.stroke2}`,
                    borderRadius: 10,
                    padding: 16,
                  }}
                >
                  <span
                    style={{ color: C.text, fontSize: 12, fontWeight: 700 }}
                  >
                    {chartType === "cma" && solvedPointCount > 0
                      ? "Cm is unavailable for these solved points"
                      : "No solved OpenFOAM polar points yet"}
                  </span>
                  <span style={{ marginTop: 7, fontSize: 10, lineHeight: 1.5 }}>
                    {chartType === "cma" && solvedPointCount > 0
                      ? "No moment-coefficient evidence was stored. The other coefficient charts remain available."
                      : "Queued/running points will appear here only after a completed result row is stored."}
                  </span>
                </div>
              )}
              {hover && (
                <div
                  ref={badgeRef}
                  style={hoverStyle}
                  data-testid="polar-hover-badge"
                >
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      color: C.muted,
                      marginBottom: 4,
                    }}
                  >
                    {hover.head}
                  </div>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      lineHeight: 1.6,
                      color: C.text,
                    }}
                  >
                    α {hover.a}°&nbsp;&nbsp;·&nbsp;&nbsp;Cl {hover.cl}
                    <br />
                    Cd {hover.cd}&nbsp;&nbsp;·&nbsp;&nbsp;L/D {hover.ld}
                  </div>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 9.5,
                      color: C.teal,
                      marginTop: 5,
                    }}
                  >
                    click → simulation ▶
                  </div>
                </div>
              )}
              {!hover && cursor && readoutRows.length > 0 && (
                <div
                  ref={badgeRef}
                  style={badgeStyle(C.stroke2)}
                  data-testid="polar-readout-badge"
                >
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 10,
                      color: C.muted,
                      marginBottom: 4,
                    }}
                  >
                    α {f1(cursor.x)}°
                  </div>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      lineHeight: 1.7,
                      color: C.text,
                    }}
                  >
                    {readoutRows.map((r) => (
                      <div
                        key={`${r.kind}-${r.seriesId}`}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                        }}
                      >
                        <span
                          style={{
                            width: 13,
                            borderTop:
                              r.kind === "fit"
                                ? `2px dashed ${r.color}`
                                : `2px solid ${r.color}`,
                            display: "inline-block",
                          }}
                        />
                        <span style={{ color: C.muted, fontSize: 10 }}>
                          {r.label}
                        </span>
                        <span>
                          {projection.yTitle} {readoutValue(r.y)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {resultChoice && resultChoice.resultChoices && (
              <div
                data-testid="polar-result-chooser"
                role="dialog"
                aria-label={storedResultsHeading(resultChoice.resultChoices)}
                style={{
                  width: 684,
                  maxWidth: "100%",
                  margin: "10px auto 4px",
                  background: C.panel2,
                  border: `1px solid ${C.stroke2}`,
                  borderRadius: 10,
                  padding: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 9,
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      color: C.text,
                      fontWeight: 700,
                    }}
                  >
                    {storedResultsHeading(resultChoice.resultChoices)}
                  </span>
                  <button
                    type="button"
                    aria-label="Close stored result chooser"
                    onClick={() => setResultChoice(null)}
                    style={{
                      marginLeft: "auto",
                      border: "none",
                      background: "transparent",
                      color: C.muted,
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ display: "grid", gap: 7 }}>
                  {resultChoice.resultChoices.map((point, index) => {
                    const role =
                      point.evidenceRole === "primary"
                        ? "Primary measurement"
                        : point.evidenceRole === "conflict"
                          ? "Conflicting measurement"
                          : "Alternate stored result";
                    return (
                      <button
                        key={point.resultId ?? index}
                        type="button"
                        onClick={() => {
                          setResultChoice(null);
                          onPointClick({
                            ...resultChoice,
                            key: `${resultChoice.seriesId}:${point.resultId ?? index}`,
                            point,
                            resultChoices: undefined,
                          });
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          width: "100%",
                          border: `1px solid ${point.evidenceRole === "conflict" ? "#d946ef" : C.stroke}`,
                          background: C.panel3,
                          borderRadius: 8,
                          padding: "9px 10px",
                          color: C.text,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: MONO,
                            fontSize: 10,
                            color: C.muted,
                            minWidth: 150,
                          }}
                        >
                          {role}
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 10 }}>
                          α {formatPolarAoa(point.a)}° · Cl {f2(point.cl)} · Cd{" "}
                          {f4(point.cd)} ·{" "}
                          {point.cm == null
                            ? "Cm unavailable"
                            : `Cm ${f4(point.cm)}`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* legend */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              padding: "10px 16px 16px",
              borderTop: `1px solid ${C.borderRow}`,
              marginTop: 6,
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: "0.1em",
                color: C.dim,
                marginRight: 2,
              }}
            >
              POLARS
            </span>
            {legendItems.map((item) => {
              return (
                <button
                  key={item.seriesId}
                  type="button"
                  aria-pressed={item.visible}
                  onClick={() => onToggleSeries(item.seriesId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: MONO,
                    fontSize: 11,
                    borderRadius: 999,
                    padding: "5px 11px",
                    cursor: "pointer",
                    background: item.visible ? C.panel3 : "transparent",
                    border: `1px solid ${item.visible ? C.stroke2 : C.border}`,
                    color: item.pointCount
                      ? item.visible
                        ? C.text
                        : C.dim
                      : C.dimmest,
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      borderTop: `2px solid ${item.color}`,
                      display: "inline-block",
                    }}
                  />
                  {item.label} · {item.pointCount}
                </button>
              );
            })}
            {hasFitCurve && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.muted,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 16,
                    borderTop: `2px dashed ${C.teal}`,
                    display: "inline-block",
                  }}
                />
                best-fit
              </span>
            )}
            {hasAlternatePoints && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.muted,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: "2px solid #94a3b8",
                    display: "inline-block",
                  }}
                />
                alternate stored result · not in best-fit
              </span>
            )}
            {hasConflictPoints && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: "#d946ef",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: "2px solid #d946ef",
                    display: "inline-block",
                  }}
                />
                repeated measurements differ · not in best-fit
              </span>
            )}
            {hasDerivedPoints && (
              <span
                data-testid="polar-derived-legend"
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.muted,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: `1.6px solid ${C.teal}`,
                    background: "transparent",
                    display: "inline-block",
                  }}
                />
                derived by symmetry
              </span>
            )}
            {hasProvisionalPoints && (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.amber,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    border: `2px solid ${C.amber}`,
                    display: "inline-block",
                  }}
                />
                needs URANS confirmation
              </span>
            )}
            {hasPostStallPoints && (
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: MONO,
                  fontSize: 10,
                  color: C.redText,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: C.red,
                    display: "inline-block",
                  }}
                />
                post-stall → URANS
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
