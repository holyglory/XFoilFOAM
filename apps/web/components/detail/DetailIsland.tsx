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
  fRe,
  projectChart,
  type SimulationDetail,
} from "@aerodb/core";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getFieldTrack, getSim } from "@/lib/api";
import type { SimModalReviewContext } from "@/lib/result-review";
import { C, MONO } from "@/lib/tokens";
import { PolarViewer } from "./PolarViewer";
import { SolverWorkPanel } from "./SolverWorkPanel";
import { SimModal } from "./SimModal";
import { SpecSheet } from "./SpecSheet";

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

const DEFAULT_VISIBLE: Record<number, boolean> = {
  100000: true,
  200000: false,
  500000: true,
  1000000: false,
};

function visibleDefaults(detail: AirfoilDetailPayload, pinned: boolean): Record<number, boolean> {
  // Pinned-revision scope carries exactly one curve — it must start visible
  // (the catalog defaults would hide e.g. a pinned Re 200k curve entirely).
  if (pinned) return Object.fromEntries(detail.polars.map((polar) => [polar.re, true]));
  return Object.fromEntries(
    detail.polars.map((polar) => [
      polar.re,
      Object.prototype.hasOwnProperty.call(DEFAULT_VISIBLE, polar.re) ? DEFAULT_VISIBLE[polar.re] : polar.points.length > 0,
    ]),
  );
}

/** `pinnedRevisionId` (campaign spec §11 pinned-detail admin journey): the
 *  page was opened from an admin evidence link with ?revision=<uuid>, so the
 *  payload is scoped to that one setup revision (enabled or not). A compact
 *  context chip above the charts says so and links back to the public view. */
export function DetailIsland({ detail, pinnedRevisionId = null }: { detail: AirfoilDetailPayload; pinnedRevisionId?: string | null }) {
  const [chartType, setChartType] = useState<ChartType>("cla");
  const [visibleRe, setVisibleRe] = useState<Record<number, boolean>>(() => visibleDefaults(detail, !!pinnedRevisionId));
  const [hover, setHover] = useState<HoverState | null>(null);
  // zoom/pan window; null = zoom-to-fit. Axes change meaning per chart type,
  // so switching tabs resets the window.
  const [chartDomain, setChartDomain] = useState<ChartDomain | null>(null);
  const changeChartType = useCallback((t: ChartType) => {
    setChartType(t);
    setChartDomain(null);
  }, []);

  const [simOpen, setSimOpen] = useState(false);
  const [simCtx, setSimCtx] = useState<{ re: number; aoa: number; resultId?: string | null; mirrored?: boolean; mirroredFromAoaDeg?: number | null } | null>(null);
  const [simDetail, setSimDetail] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [simTrack, setSimTrack] = useState<FieldTrackPoint[]>([]);
  const [simReview, setSimReview] = useState<SimModalReviewContext | null>(null);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    window.localStorage.setItem("aerodb-last-detail-slug", detail.slug);
  }, [detail.slug]);

  useEffect(() => {
    setVisibleRe(visibleDefaults(detail, !!pinnedRevisionId));
  }, [detail, pinnedRevisionId]);

  // Real solver evidence only — derived-by-symmetry mirrors are display points,
  // never counted as solved runs (spec §9.3 "solver runs vs points").
  const solvedPointCount = useMemo(
    () => detail.polars.reduce((sum, p) => sum + p.points.filter((pt) => !derivedBySymmetryInfo(pt).derived).length, 0),
    [detail.polars],
  );
  const solvedPointKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const polar of detail.polars) {
      for (const point of polar.points) {
        if (point.source === "solved" && point.resultId) keys.add(`${polar.re}:${point.a}`);
      }
    }
    return keys;
  }, [detail.polars]);
  const metricPolar = useMemo(
    () =>
      detail.polars.find((p) => visibleRe[p.re] && p.fit?.metrics) ??
      detail.polars.find((p) => p.fit?.metrics) ??
      detail.polars.find((p) => visibleRe[p.re] && p.points.length >= 3) ??
      detail.polars.find((p) => p.points.length >= 3) ??
      null,
    [detail.polars, visibleRe],
  );
  const solvedM = metricPolar?.fit?.metrics ?? null;

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
    () => detail.polars.map((p) => ({ re: p.re, color: p.color, points: p.points, fit: p.fit })),
    [detail.polars],
  );
  const projection = useMemo(
    () =>
      projectChart({
        chartType,
        polars: chartPolars,
        visibleRe,
        hoverKey: hover?.key ?? null,
        domain: chartDomain,
      }),
    [chartType, chartPolars, visibleRe, hover?.key, chartDomain],
  );

  const onPointClick = useCallback((vm: ChartPointVM) => {
    if (vm.point.source !== "solved" || !vm.point.resultId) return;
    // Derived-by-symmetry points open the +α SOURCE evidence, mirrored and
    // labeled (spec §9.3) — never presented as an independent solver run.
    const derived = derivedBySymmetryInfo(vm.point);
    setSimCtx({
      re: vm.re,
      aoa: vm.point.a,
      resultId: derived.derived ? derived.derivedFromResultId ?? vm.point.resultId : vm.point.resultId,
      mirrored: derived.derived,
      mirroredFromAoaDeg: derived.derivedFromAoaDeg,
    });
    setSimDetail(null);
    setSimMessage(null);
    setSimReview(null);
    setPlaying(true);
    setSimOpen(true);
  }, []);

  const openSolverWorkResult = useCallback((ctx: { re: number; aoa: number; resultId: string }, review?: SimModalReviewContext | null) => {
    setSimCtx({ re: ctx.re, aoa: ctx.aoa, resultId: ctx.resultId });
    setSimDetail(null);
    setSimMessage(null);
    setSimReview(review ?? null);
    setPlaying(true);
    setSimOpen(true);
  }, []);

  // fetch the simulation detail whenever the modal opens for a new point
  useEffect(() => {
    if (!simOpen || !simCtx) return;
    if (!simCtx.resultId && !solvedPointKeys.has(`${simCtx.re}:${simCtx.aoa}`)) {
      setSimDetail(null);
      setSimMessage("No solved OpenFOAM result is stored for this point yet. Queue or rerun the sweep to inspect real CFD media here.");
      setPlaying(false);
      return;
    }
    let cancelled = false;
    setSimMessage(null);
    getSim(detail.slug, simCtx.re, simCtx.aoa, simCtx.resultId)
      .then((d) => {
        if (!cancelled) {
          setSimDetail(d);
          setSimMessage(null);
          setSimField((current) => {
            if (d.status !== "solved" || d.availableFields.length === 0 || d.availableFields.includes(current)) return current;
            return d.availableFields[0];
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSimDetail(null);
          setSimMessage("No solved OpenFOAM result is stored for this point yet. Queue or rerun the sweep to inspect real CFD media here.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [simOpen, simCtx, detail.slug, solvedPointKeys]);

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

  const selectTrackPoint = useCallback((point: FieldTrackPoint) => {
    setSimCtx({ re: point.re, aoa: point.aoa, resultId: point.resultId });
    setSimDetail(null);
    setSimMessage(null);
    setSimReview(null);
    setPlaying(true);
  }, []);

  return (
    <>
      {/* Stack the spec sheet above the charts on narrow viewports — the fixed
          344px column otherwise pushes the whole chart column off-canvas. */}
      <style jsx>{`
        .detail-two-col {
          display: grid;
          grid-template-columns: 344px minmax(0, 1fr);
          gap: 20px;
          align-items: start;
        }
        @media (max-width: 760px) {
          .detail-two-col {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
      <div className="detail-two-col">
        <SpecSheet
          detail={detail}
          polarRows={polarRows}
          solvedReStr={metricPolar ? fRe(metricPolar.re) : null}
          solvedPointCount={solvedPointCount}
          machStr={detail.mach.toFixed(2)}
          fitStatus={metricPolar?.fit?.status ?? null}
        />
        {/* minWidth 0 so the pinned chip's text cannot widen the 1fr track past the viewport */}
        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
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
              {detail.reList.length === 1 ? ` · Re ${fRe(detail.reList[0])}` : ""}
              <Link
                href={`/airfoils/${encodeURIComponent(detail.slug)}`}
                title="View public data (enabled setups only)"
                aria-label="Unpin — view public data"
                style={{ color: C.teal, textDecoration: "none", fontWeight: 700, padding: "0 4px", lineHeight: 1 }}
              >
                ×
              </Link>
            </span>
          )}
          <PolarViewer
            chartType={chartType}
            onChartType={changeChartType}
            projection={projection}
            polars={chartPolars}
            domain={chartDomain}
            onDomainChange={setChartDomain}
            visibleRe={visibleRe}
            onToggleRe={(re) => setVisibleRe((v) => ({ ...v, [re]: !v[re] }))}
            reList={detail.reList}
            rePointCounts={Object.fromEntries(detail.polars.map((p) => [p.re, p.points.length]))}
            solvedPointCount={solvedPointCount}
            machStr={detail.mach.toFixed(2)}
            hover={hover}
            onHover={setHover}
            onPointClick={onPointClick}
          />
          <SolverWorkPanel slug={detail.slug} airfoilId={detail.id} revisionId={pinnedRevisionId} onOpenResult={openSolverWorkResult} />
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
