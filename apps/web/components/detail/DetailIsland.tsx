"use client";

import {
  type AirfoilDetailPayload,
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
import { useCallback, useEffect, useMemo, useState } from "react";

import { getFieldTrack, getSim } from "@/lib/api";
import { C, MONO } from "@/lib/tokens";
import { PolarViewer } from "./PolarViewer";
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

function visibleDefaults(detail: AirfoilDetailPayload): Record<number, boolean> {
  return Object.fromEntries(
    detail.polars.map((polar) => [
      polar.re,
      Object.prototype.hasOwnProperty.call(DEFAULT_VISIBLE, polar.re) ? DEFAULT_VISIBLE[polar.re] : polar.points.length > 0,
    ]),
  );
}

export function DetailIsland({ detail }: { detail: AirfoilDetailPayload }) {
  const [chartType, setChartType] = useState<ChartType>("cla");
  const [visibleRe, setVisibleRe] = useState<Record<number, boolean>>(() => visibleDefaults(detail));
  const [hover, setHover] = useState<HoverState | null>(null);

  const [simOpen, setSimOpen] = useState(false);
  const [simCtx, setSimCtx] = useState<{ re: number; aoa: number; resultId?: string | null; mirrored?: boolean; mirroredFromAoaDeg?: number | null } | null>(null);
  const [simDetail, setSimDetail] = useState<SimulationDetail | null>(null);
  const [simMessage, setSimMessage] = useState<string | null>(null);
  const [simField, setSimField] = useState<FieldId>("vorticity");
  const [simTrack, setSimTrack] = useState<FieldTrackPoint[]>([]);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    window.localStorage.setItem("aerodb-last-detail-slug", detail.slug);
  }, [detail.slug]);

  useEffect(() => {
    setVisibleRe(visibleDefaults(detail));
  }, [detail]);

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

  const projection = useMemo(
    () =>
      projectChart({
        chartType,
        polars: detail.polars.map((p) => ({ re: p.re, color: p.color, points: p.points, fit: p.fit })),
        visibleRe,
        hoverKey: hover?.key ?? null,
      }),
    [chartType, detail.polars, visibleRe, hover?.key],
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
    getFieldTrack(detail.slug)
      .then((items) => {
        if (!cancelled) setSimTrack(items);
      })
      .catch(() => {
        if (!cancelled) setSimTrack([]);
      });
    return () => {
      cancelled = true;
    };
  }, [simOpen, detail.slug]);

  const selectTrackPoint = useCallback((point: FieldTrackPoint) => {
    setSimCtx({ re: point.re, aoa: point.aoa, resultId: point.resultId });
    setSimDetail(null);
    setSimMessage(null);
    setPlaying(true);
  }, []);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "344px 1fr", gap: 20, alignItems: "start" }}>
        <SpecSheet
          detail={detail}
          polarRows={polarRows}
          solvedReStr={metricPolar ? fRe(metricPolar.re) : null}
          solvedPointCount={solvedPointCount}
          machStr={detail.mach.toFixed(2)}
          fitStatus={metricPolar?.fit?.status ?? null}
        />
        <div style={{ display: "grid", gap: 14 }}>
          <PolarViewer
            chartType={chartType}
            onChartType={setChartType}
            projection={projection}
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
          <SolverWorkPanel works={detail.simulationWorks} />
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
      />
    </>
  );
}

function SolverWorkPanel({ works }: { works: AirfoilDetailPayload["simulationWorks"] }) {
  if (!works.length) return null;
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          padding: "12px 16px",
          borderBottom: `1px solid ${C.borderSoft}`,
          alignItems: "baseline",
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 11, color: C.dim, letterSpacing: "0.12em" }}>SOLVER WORK</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>{works.length} job{works.length === 1 ? "" : "s"}</span>
      </div>
      <div style={{ display: "grid" }}>
        {works.map((work) => (
          <div
            key={work.id}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              gap: 12,
              padding: "12px 16px",
              borderBottom: `1px solid ${C.borderRow}`,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 10, color: statusColor(work.status), border: `1px solid ${statusBorder(work.status)}`, borderRadius: 999, padding: "3px 8px" }}>
                  {work.status}
                </span>
                <span style={{ fontWeight: 650, color: C.text }}>{work.kind === "urans-retry" ? "URANS retry" : "RANS sweep"}</span>
                {work.retryMode && <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>{work.retryMode.replaceAll("-", " ")}</span>}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, lineHeight: 1.55 }}>
                α {formatAoas(work)} · {work.completedCases}/{work.totalCases} cases
                {work.reynolds ? ` · Re ${fRe(work.reynolds)}` : ""}
                {work.mach != null ? ` · M ${work.mach.toFixed(3)}` : ""}
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, lineHeight: 1.55 }}>
                solved {work.solvedCount} · pending {work.pendingCount} · failed {work.failedCount}
                {work.acceptedRansCount || work.rejectedRansCount
                  ? ` · RANS accepted ${work.acceptedRansCount}, rejected ${work.rejectedRansCount}`
                  : ""}
                {work.uransAttemptCount ? ` · URANS attempts ${work.uransAttemptCount}` : ""}
              </div>
              {work.error && <div style={{ fontFamily: MONO, fontSize: 10, color: C.redText, marginTop: 5 }}>{work.error}</div>}
            </div>
            <div style={{ textAlign: "right", fontFamily: MONO, fontSize: 10, color: C.dimmest, whiteSpace: "nowrap" }}>
              wave {work.wave}
              <br />
              {work.engineState ?? "not submitted"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatAoas(work: AirfoilDetailPayload["simulationWorks"][number]) {
  if (work.aoas.length) return compactRanges(work.aoas);
  if (work.aoaMin != null && work.aoaMax != null) {
    return work.aoaMin === work.aoaMax ? `${work.aoaMin}°` : `${work.aoaMin}°…${work.aoaMax}°`;
  }
  return "—";
}

function compactRanges(values: number[]) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && Math.abs(sorted[i + 1] - end - 1) < 1e-9) {
      end = sorted[++i];
    }
    ranges.push(start === end ? `${start}°` : `${start}°…${end}°`);
  }
  return ranges.join(", ");
}

function statusColor(status: string) {
  if (status === "failed" || status === "cancelled") return C.redText;
  if (status === "running" || status === "submitted" || status === "ingesting") return C.teal;
  if (status === "done") return C.muted;
  return C.amber;
}

function statusBorder(status: string) {
  if (status === "failed" || status === "cancelled") return "rgba(239,68,68,0.45)";
  if (status === "running" || status === "submitted" || status === "ingesting") return C.tealBorder;
  if (status === "done") return C.stroke;
  return "rgba(245,158,11,0.45)";
}
