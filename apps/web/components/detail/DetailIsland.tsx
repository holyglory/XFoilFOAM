"use client";

import {
  type AirfoilDetailPayload,
  type ChartDomain,
  type ChartPointVM,
  type ChartType,
  type FieldId,
  type FieldTrackPoint,
  derivedBySymmetryInfo,
  f1,
  f2,
  f4,
  projectChart,
  type SimulationDetail,
} from "@aerodb/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getCachedSim,
  getAirfoilDetail,
  getFieldTrack,
  getSim,
  prefetchSimDetails,
} from "@/lib/api";
import {
  hasAcceptedCfdFit,
  initialSeriesVisibility,
  publicSolvedPointCount,
  toggleSeriesVisibility,
  visibleMachDisplay,
} from "@/lib/polar-series";
import type { SimModalReviewContext } from "@/lib/result-review";
import { C, MONO } from "@/lib/tokens";
import { PolarViewer } from "./PolarViewer";
import { ProgressivePolarViewer } from "./ProgressivePolarViewer";
import { SolverWorkPanel } from "./SolverWorkPanel";
import { SimModal } from "./SimModal";
import { SpecSheet } from "./SpecSheet";
import styles from "./DetailIsland.module.css";

export interface HoverState {
  key: string;
  px: number;
  py: number;
  head: string;
  a: string;
  cl: string;
  cd: string;
  ld: string;
}

/** `pinnedRevisionId` (campaign spec §11 pinned-detail admin journey): the
 *  page was opened from an admin evidence link with ?revision=<uuid>, so the
 *  payload is scoped to that one setup revision (enabled or not). A compact
 *  context chip above the charts says so and links back to the public view. */
export function DetailIsland({
  detail: initialDetail,
  pinnedRevisionId = null,
  openCfdInitially = false,
}: {
  detail: AirfoilDetailPayload;
  pinnedRevisionId?: string | null;
  openCfdInitially?: boolean;
}) {
  const [loadedDetail, setLoadedDetail] = useState<AirfoilDetailPayload | null>(
    null,
  );
  const detail = loadedDetail ?? initialDetail;
  const [pointsOpen, setPointsOpen] = useState(openCfdInitially);
  const [pointsLoading, setPointsLoading] = useState(false);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [pointsInteractive, setPointsInteractive] = useState(false);
  const pointsRequest = useRef<AbortController | null>(null);
  const loadCfdPoints = useCallback(async () => {
    if (
      !initialDetail.cfdPointsDeferred ||
      loadedDetail ||
      pointsRequest.current
    )
      return;
    const request = new AbortController();
    pointsRequest.current = request;
    setPointsLoading(true);
    setPointsError(null);
    try {
      const full = await getAirfoilDetail(
        initialDetail.slug,
        pinnedRevisionId,
        request.signal,
      );
      if (!full || full.id !== initialDetail.id || full.cfdPointsDeferred)
        throw new Error("Full point data is unavailable");
      if (!request.signal.aborted) setLoadedDetail(full);
    } catch {
      if (!request.signal.aborted) setPointsError("Unable to load CFD points.");
    } finally {
      if (pointsRequest.current === request) {
        pointsRequest.current = null;
        setPointsLoading(false);
      }
    }
  }, [initialDetail, loadedDetail, pinnedRevisionId]);
  useEffect(() => {
    setLoadedDetail(null);
    setPointsLoading(false);
    setPointsError(null);
    setPointsOpen(openCfdInitially);
    setPointsInteractive(true);
    return () => {
      pointsRequest.current?.abort();
      pointsRequest.current = null;
    };
  }, [initialDetail, pinnedRevisionId, openCfdInitially]);
  const [chartType, setChartType] = useState<ChartType>("cla");
  const [visibleSeries, setVisibleSeries] = useState<Record<string, boolean>>(
    () => initialSeriesVisibility(detail.polars),
  );
  const [hover, setHover] = useState<HoverState | null>(null);
  // zoom/pan window; null = zoom-to-fit. Axes change meaning per chart type,
  // so switching tabs resets the window.
  const [chartDomain, setChartDomain] = useState<ChartDomain | null>(null);
  const changeChartType = useCallback((t: ChartType) => {
    setChartType(t);
    setChartDomain(null);
  }, []);

  const [simOpen, setSimOpen] = useState(false);
  const [simCtx, setSimCtx] = useState<{
    re: number;
    aoa: number;
    resultId?: string | null;
    resultAttemptId?: string | null;
    mirrored?: boolean;
    mirroredFromAoaDeg?: number | null;
  } | null>(null);
  const [simDetail, setSimDetail] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [simTrack, setSimTrack] = useState<FieldTrackPoint[]>([]);
  const [simReview, setSimReview] = useState<SimModalReviewContext | null>(
    null,
  );
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    window.localStorage.setItem("aerodb-last-detail-slug", detail.slug);
  }, [detail.slug]);

  useEffect(() => {
    setVisibleSeries(initialSeriesVisibility(detail.polars));
  }, [detail, pinnedRevisionId]);

  // Real solver evidence only — derived-by-symmetry mirrors are display points,
  // never counted as solved runs (spec §9.3 "solver runs vs points").
  const solvedPointCount = useMemo(
    () =>
      detail.polars.reduce(
        (sum, polar) => sum + publicSolvedPointCount(polar.points),
        0,
      ),
    [detail.polars],
  );
  const metricPolar = useMemo(() => {
    const candidates = detail.polars.filter(
      (polar) => hasAcceptedCfdFit(polar) && polar.fit?.metrics,
    );
    return (
      candidates.find((polar) => visibleSeries[polar.seriesId]) ??
      candidates[0] ??
      null
    );
  }, [detail.polars, visibleSeries]);
  const solvedM = metricPolar?.fit?.metrics ?? null;
  const chartMachStr = visibleMachDisplay(detail.polars, visibleSeries);

  const polarRows = useMemo(() => {
    if (!solvedM) return [];
    return [
      { k: "(L/D)max", v: f1(solvedM.ldmax) },
      { k: "α @ (L/D)max", v: f1(solvedM.aLd) + "°" },
      { k: "Cd,min", v: f4(solvedM.cdmin) },
      { k: "Cl @ Cd,min", v: f2(solvedM.clCd) },
      { k: "Cd₀ (Cl=0)", v: f4(solvedM.cd0) },
      { k: "Cl,max", v: f2(solvedM.clmax) },
      { k: "α @ Cl,max", v: f1(solvedM.aStall) + "°" },
      { k: "Cm,0", v: f2(solvedM.cm0) },
    ];
  }, [solvedM]);

  const chartPolars = useMemo(
    () =>
      detail.polars.map((p) => ({
        seriesId: p.seriesId,
        label: p.label,
        re: p.re,
        color: p.color,
        points: p.points,
        fit: p.fit,
      })),
    [detail.polars],
  );
  const projection = useMemo(
    () =>
      projectChart({
        chartType,
        polars: chartPolars,
        visibleSeries,
        hoverKey: hover?.key ?? null,
        domain: chartDomain,
      }),
    [chartType, chartPolars, visibleSeries, hover?.key, chartDomain],
  );

  const onPointClick = useCallback((vm: ChartPointVM) => {
    if (vm.point.source !== "solved" || !vm.point.resultId) return;
    // Derived-by-symmetry points open the +α SOURCE evidence, mirrored and
    // labeled (spec §9.3) — never presented as an independent solver run.
    const derived = derivedBySymmetryInfo(vm.point);
    setSimCtx({
      re: vm.re,
      aoa: vm.point.a,
      resultId: derived.derived
        ? (derived.derivedFromResultId ?? vm.point.resultId)
        : vm.point.resultId,
      mirrored: derived.derived,
      mirroredFromAoaDeg: derived.derivedFromAoaDeg,
    });
    setSimDetail(null);
    setSimMessage(null);
    setSimReview(null);
    setPlaying(true);
    setSimOpen(true);
  }, []);

  const openSolverWorkResult = useCallback(
    (
      ctx: {
        re: number;
        aoa: number;
        resultId: string;
        resultAttemptId?: string;
      },
      review?: SimModalReviewContext | null,
    ) => {
      setSimCtx({
        re: ctx.re,
        aoa: ctx.aoa,
        resultId: ctx.resultId,
        resultAttemptId: ctx.resultAttemptId,
      });
      setSimDetail(null);
      setSimMessage(null);
      setSimReview(review ?? null);
      setPlaying(true);
      setSimOpen(true);
    },
    [],
  );

  // fetch the simulation detail whenever the modal opens for a new point
  useEffect(() => {
    if (!simOpen || !simCtx) return;
    if (!simCtx.resultId) {
      setSimDetail(null);
      setSimMessage(
        "No solved OpenFOAM result is stored for this point yet. Queue or rerun the sweep to inspect real CFD media here.",
      );
      setPlaying(false);
      return;
    }
    let cancelled = false;
    setSimMessage(null);
    getSim(
      detail.slug,
      simCtx.re,
      simCtx.aoa,
      simCtx.resultId,
      simCtx.resultAttemptId,
    )
      .then((d) => {
        if (!cancelled) {
          setSimDetail(d);
          setSimMessage(null);
          setSimField((current) => {
            if (
              (d.status !== "solved" && d.status !== "evidence") ||
              d.availableFields.length === 0 ||
              d.availableFields.includes(current)
            )
              return current;
            return d.availableFields[0];
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSimMessage(
            "No solved OpenFOAM result is stored for this point yet. Queue or rerun the sweep to inspect real CFD media here.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [simOpen, simCtx, detail.slug]);

  useEffect(() => {
    if (!simOpen) return;
    let cancelled = false;
    getFieldTrack(detail.slug, pinnedRevisionId)
      .then((items) => {
        if (!cancelled) setSimTrack(items);
      })
      .catch(() => {
        if (!cancelled) setSimTrack([]);
      });
    return () => {
      cancelled = true;
    };
  }, [simOpen, detail.slug, pinnedRevisionId]);

  useEffect(() => {
    if (!simOpen || simTrack.length === 0) return;
    prefetchSimDetails(
      simTrack.map((point) => ({ slug: detail.slug, ...point })),
      simField,
    );
  }, [simOpen, simTrack, detail.slug, simField]);

  const selectTrackPoint = useCallback(
    (point: FieldTrackPoint) => {
      setSimCtx({ re: point.re, aoa: point.aoa, resultId: point.resultId });
      const cached = getCachedSim(
        detail.slug,
        point.re,
        point.aoa,
        point.resultId,
      );
      if (cached) setSimDetail(cached);
      setSimMessage(null);
      setSimReview(null);
      setPlaying(true);
    },
    [detail.slug],
  );

  return (
    <>
      <div className={styles.columns}>
        <SpecSheet
          detail={detail}
          polarRows={polarRows}
          solvedSeriesLabel={metricPolar?.label ?? null}
          solvedPointCount={solvedPointCount}
          machStr={(metricPolar?.mach ?? detail.mach).toFixed(2)}
          fitStatus={metricPolar?.fit?.status ?? null}
        />
        {/* minWidth 0 so the pinned chip's text cannot widen the 1fr track past the viewport */}
        <div
          className={styles.chartColumn}
          style={{ display: "grid", gap: 14, minWidth: 0 }}
        >
          {pinnedRevisionId && (
            <span
              data-testid="pinned-revision-chip"
              style={{
                display: "inline-flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                width: "fit-content",
                maxWidth: "100%",
                minWidth: 0,
                // Clip like the sibling chart cards so the chip can never widen
                // the document horizontally on narrow viewports.
                overflow: "hidden",
                fontFamily: MONO,
                fontSize: 10,
                color: C.teal,
                background: C.tealFill,
                border: `1px solid ${C.tealBorder}`,
                borderRadius: 999,
                padding: "3px 6px 3px 10px",
              }}
            >
              Pinned to setup revision {pinnedRevisionId.slice(0, 8)}
              {detail.polars.length === 1 ? ` · ${detail.polars[0].label}` : ""}
              <Link
                href={`/airfoils/${encodeURIComponent(detail.slug)}`}
                title="View public data (enabled setups only)"
                aria-label="Unpin — view public data"
                style={{
                  color: C.teal,
                  textDecoration: "none",
                  fontWeight: 700,
                  padding: "0 4px",
                  lineHeight: 1,
                }}
              >
                ×
              </Link>
            </span>
          )}
          {!!detail.progressivePolars?.length && (
            <ProgressivePolarViewer
              series={detail.progressivePolars}
              onOpenResult={openSolverWorkResult}
            />
          )}
          {!detail.progressivePolars?.length && (
            <PolarViewer
              chartType={chartType}
              onChartType={changeChartType}
              projection={projection}
              polars={chartPolars}
              domain={chartDomain}
              onDomainChange={setChartDomain}
              visibleSeries={visibleSeries}
              onToggleSeries={(seriesId) =>
                setVisibleSeries((visibility) =>
                  toggleSeriesVisibility(visibility, seriesId),
                )
              }
              solvedPointCount={solvedPointCount}
              machStr={chartMachStr}
              hover={hover}
              onHover={setHover}
              onPointClick={onPointClick}
              pointsControl={{
                visible: pointsOpen,
                onToggle: () => setPointsOpen((visible) => !visible),
              }}
            />
          )}
          {!!detail.progressivePolars?.length &&
            (solvedPointCount > 0 ||
              initialDetail.cfdPointsDeferred ||
              openCfdInitially) && (
              <details
                id="cfd-points"
                open={pointsOpen}
                inert={initialDetail.cfdPointsDeferred && !pointsInteractive}
                onToggle={(event) => {
                  const opened = event.currentTarget.open;
                  setPointsOpen(opened);
                  if (opened) void loadCfdPoints();
                  else {
                    pointsRequest.current?.abort();
                    pointsRequest.current = null;
                    setPointsLoading(false);
                  }
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    padding: "10px 0",
                    color: C.text,
                  }}
                >
                  CFD points
                </summary>
                {initialDetail.cfdPointsDeferred && !loadedDetail ? (
                  <div aria-live="polite" style={{ color: C.text2 }}>
                    {pointsLoading && <p role="status">Loading CFD points…</p>}
                    {pointsError && (
                      <p role="alert">
                        {pointsError}{" "}
                        <button
                          type="button"
                          onClick={() => void loadCfdPoints()}
                          style={{
                            color: C.text,
                            background: C.panel2,
                            border: `1px solid ${C.border}`,
                            borderRadius: 6,
                            padding: "8px 12px",
                            minHeight: 44,
                            cursor: "pointer",
                          }}
                        >
                          Retry
                        </button>
                      </p>
                    )}
                  </div>
                ) : detail.progressivePolars?.length &&
                  solvedPointCount === 0 ? (
                  <p style={{ color: C.text2 }}>No CFD points yet.</p>
                ) : (
                  <PolarViewer
                    chartType={chartType}
                    onChartType={changeChartType}
                    projection={projection}
                    polars={chartPolars}
                    domain={chartDomain}
                    onDomainChange={setChartDomain}
                    visibleSeries={visibleSeries}
                    onToggleSeries={(seriesId) =>
                      setVisibleSeries((visibility) =>
                        toggleSeriesVisibility(visibility, seriesId),
                      )
                    }
                    solvedPointCount={solvedPointCount}
                    machStr={chartMachStr}
                    hover={hover}
                    onHover={setHover}
                    onPointClick={onPointClick}
                  />
                )}
              </details>
            )}
          {!detail.progressivePolars?.length && !pointsOpen && (
            <noscript>
              <a
                href={`/airfoils/${encodeURIComponent(detail.slug)}?${pinnedRevisionId ? `revision=${encodeURIComponent(pinnedRevisionId)}&` : ""}points=1`}
                style={{ color: C.teal }}
              >
                Show CFD points
              </a>
            </noscript>
          )}
          {initialDetail.cfdPointsDeferred && (
            <noscript>
              <a
                href={`/airfoils/${encodeURIComponent(detail.slug)}?points=1#cfd-points`}
                style={{ color: C.teal }}
              >
                Load CFD points
              </a>
            </noscript>
          )}
          <SolverWorkPanel
            slug={detail.slug}
            airfoilId={detail.id}
            revisionId={pinnedRevisionId}
            onOpenResult={openSolverWorkResult}
          />
        </div>
      </div>

      <SimModal
        open={simOpen}
        ctx={simCtx}
        sim={simDetail}
        name={detail.name}
        machStr={detail.mach.toFixed(2)}
        contour={detail.geometry.contour}
        field={simField}
        onField={setSimField}
        track={simTrack}
        onTrackPoint={selectTrackPoint}
        playing={playing}
        onTogglePlay={() => setPlaying((p) => !p)}
        onClose={() => setSimOpen(false)}
        unavailableMessage={simMessage}
        review={simReview}
      />
    </>
  );
}
