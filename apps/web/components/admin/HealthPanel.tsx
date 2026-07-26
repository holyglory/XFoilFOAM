"use client";

import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
} from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";

import {
  type AdminHealth,
  type AdminHealthSample,
  type AdminSolverFleetNode,
  type AdminSolverPerformanceCounts,
  type AdminSolverPerformanceSource,
  getAdminHealth,
} from "@/lib/admin";
import { C, MONO } from "@/lib/tokens";
import { SolverIncidentPanel } from "./SolverIncidentPanel";
import { usePoll } from "./campaigns/usePoll";

const EMPTY = "--";

function isReal(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatPct(value: number | null | undefined, digits = 0): string {
  return isReal(value) ? `${value.toFixed(digits)}%` : EMPTY;
}

function formatLoad(value: number | null | undefined): string {
  return isReal(value) ? value.toFixed(2) : EMPTY;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!isReal(bytes)) return EMPTY;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatAge(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function formatCount(value: number | null | undefined): string {
  return isReal(value) ? Math.round(value).toLocaleString() : EMPTY;
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

function slotPct(node: AdminSolverFleetNode): number {
  if (node.capacityCpuSlots <= 0) return 0;
  return Math.min(100, (node.reservedCpuSlots / node.capacityCpuSlots) * 100);
}

function reportedAge(iso: string | null): string {
  if (!iso) return "no report";
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  return Number.isFinite(seconds) ? `${formatAge(seconds)} ago` : "no report";
}

function NodeCard({
  node,
  local = false,
}: {
  node: AdminSolverFleetNode;
  local?: boolean;
}) {
  const storage = node.health?.storage ?? null;
  const awaitingHealth = !local && !node.health;
  const tone =
    node.connectivity === "offline"
      ? C.redText
      : awaitingHealth
        ? C.dim
        : storage?.admissionBlocked
          ? C.amber
          : C.teal;
  const stateLabel =
    node.connectivity === "offline"
      ? "offline"
      : awaitingHealth
        ? "awaiting health"
        : storage?.admissionBlocked
          ? "capacity safeguard"
          : node.connectivity === "stale"
            ? "report delayed"
            : node.status;

  return (
    <article
      className="fleet-node"
      data-testid={`health-fleet-node-${node.id}`}
    >
      <div className="fleet-node-head">
        <div className="fleet-node-name">
          <span className="fleet-node-icon">
            {local ? <Server size={15} /> : <Cpu size={15} />}
          </span>
          <div>
            <strong>{node.instanceName}</strong>
            <span>
              {local
                ? "local solver"
                : `remote solver · ${reportedAge(node.lastHeartbeatAt)}`}
            </span>
          </div>
        </div>
        <span className="fleet-state" style={{ color: tone }}>
          <i style={{ background: tone }} />
          {stateLabel}
        </span>
      </div>

      <div className="slot-reading">
        <div>
          <strong>
            {formatCount(node.reservedCpuSlots)}
            <small> / {formatCount(node.capacityCpuSlots)}</small>
          </strong>
          <span>slots reserved</span>
        </div>
        <span>{formatPct(slotPct(node), 0)}</span>
      </div>
      <div className="slot-track" aria-hidden="true">
        <i
          style={{
            width: `${slotPct(node)}%`,
            background: tone,
          }}
        />
      </div>

      <div className="fleet-stat-grid">
        <div>
          <strong>{formatCount(node.activeJobs)}</strong>
          <span>CFD jobs</span>
        </div>
        <div>
          <strong>{formatPct(node.health?.cpu.loadPct, 0)}</strong>
          <span>host load</span>
        </div>
        <div>
          <strong>{formatPct(node.health?.memory.usedPct, 0)}</strong>
          <span>memory</span>
        </div>
      </div>

      <div className="fleet-storage">
        <span>storage</span>
        <strong style={{ color: storage?.admissionBlocked ? C.amber : C.text }}>
          {formatPct(storage?.usedPct, 0)}
        </strong>
        <span>{formatBytes(storage?.freeBytes)} free</span>
      </div>
      {storage?.admissionBlocked && (
        <div className="fleet-capacity-note">
          <HardDrive size={13} />
          <span>
            New jobs paused · {formatCount(node.activeJobs)} running continue
          </span>
        </div>
      )}
      {!node.health && !local && (
        <div className="fleet-awaiting">Awaiting node health report</div>
      )}
    </article>
  );
}

function ThroughputBars({ daily }: { daily: AdminSolverPerformanceCounts[] }) {
  const max = Math.max(1, ...daily.map((item) => item.total));
  return (
    <div
      className="throughput-bars"
      role="img"
      aria-label="Daily solver points"
    >
      {daily.map((item) => {
        const totalHeight = (item.total / max) * 100;
        const ransShare = item.total ? (item.rans / item.total) * 100 : 0;
        const preliminaryShare = item.total
          ? (item.preliminary / item.total) * 100
          : 0;
        const finalShare = item.total ? (item.final / item.total) * 100 : 0;
        return (
          <div className="throughput-day" key={item.day}>
            <span className="throughput-value">{formatCount(item.total)}</span>
            <div className="throughput-column">
              <div style={{ height: `${totalHeight}%` }}>
                <i
                  className="throughput-rans"
                  style={{ height: `${ransShare}%` }}
                />
                <i
                  className="throughput-preliminary"
                  style={{ height: `${preliminaryShare}%` }}
                />
                <i
                  className="throughput-final"
                  style={{ height: `${finalShare}%` }}
                />
              </div>
            </div>
            <span className="throughput-day-label">{dayLabel(item.day)}</span>
          </div>
        );
      })}
    </div>
  );
}

function SourcePerformance({
  source,
}: {
  source: AdminSolverPerformanceSource;
}) {
  const max = Math.max(1, ...source.daily.map((item) => item.total));
  return (
    <article className="performance-source">
      <div className="performance-source-head">
        <div>
          <strong>{source.name}</strong>
          <span>{source.kind === "local" ? "local" : "remote"}</span>
        </div>
        <div>
          <strong>{formatCount(source.totals24h.total)}</strong>
          <span>last 24h</span>
        </div>
      </div>
      <div className="source-spark" aria-hidden="true">
        {source.daily.map((item) => (
          <i
            key={item.day}
            style={{ height: `${Math.max(3, (item.total / max) * 100)}%` }}
            title={`${dayLabel(item.day)}: ${item.total}`}
          />
        ))}
      </div>
      <div className="performance-source-foot">
        <span>{source.averagePerDay.toFixed(1)} pts/day avg</span>
        <span>
          {source.totals24h.rans} R · {source.totals24h.preliminary} P ·{" "}
          {source.totals24h.final} F
        </span>
      </div>
    </article>
  );
}

function chartSeries(
  samples: AdminHealthSample[],
  pick: (sample: AdminHealthSample) => number | null | undefined,
): Array<number | null> {
  return samples.map((sample) => {
    const value = pick(sample);
    return isReal(value) ? value : null;
  });
}

function lastRealPoint(
  values: Array<number | null>,
): { index: number; value: number } | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (isReal(value)) return { index, value };
  }
  return null;
}

function MetricChart({
  label,
  values,
  color,
  domainMax = 100,
}: {
  label: string;
  values: Array<number | null>;
  color: string;
  domainMax?: number;
}) {
  const width = 360;
  const height = 150;
  const pad = { top: 16, right: 14, bottom: 24, left: 38 };
  const realValues = values.filter(isReal);
  const maxValue = Math.max(domainMax, ...realValues, 1);
  const minValue = 0;
  const span = Math.max(1, maxValue - minValue);
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  const xFor = (index: number) =>
    pad.left +
    (values.length <= 1
      ? plotWidth
      : (index / (values.length - 1)) * plotWidth);
  const yFor = (value: number) =>
    pad.top + ((maxValue - value) / span) * plotHeight;

  const segments: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (!isReal(value)) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    const point = `${xFor(index).toFixed(2)},${yFor(value).toFixed(2)}`;
    current = current ? `${current} ${point}` : point;
  });
  if (current) segments.push(current);
  const latest = lastRealPoint(values);

  return (
    <div
      className="health-chart"
      data-testid={`health-chart-${label.toLowerCase()}`}
    >
      <svg
        role="img"
        aria-label={`${label} recent stats`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        <title>{label} recent stats</title>
        <rect
          x="0"
          y="0"
          width={width}
          height={height}
          rx="8"
          fill={C.panel2}
        />
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top}
          y2={pad.top}
          stroke={C.grid}
          strokeWidth="1"
        />
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotHeight / 2}
          y2={pad.top + plotHeight / 2}
          stroke={C.grid}
          strokeWidth="1"
        />
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={height - pad.bottom}
          y2={height - pad.bottom}
          stroke={C.axis}
          strokeWidth="1"
        />
        <text
          x="10"
          y={pad.top + 4}
          fill={C.dim}
          fontFamily={MONO}
          fontSize="10"
        >
          {formatPct(maxValue, maxValue >= 100 ? 0 : 1)}
        </text>
        <text
          x="10"
          y={height - pad.bottom + 4}
          fill={C.dim}
          fontFamily={MONO}
          fontSize="10"
        >
          0%
        </text>
        {segments.length > 0 ? (
          segments.map((points, index) => (
            <polyline
              key={index}
              points={points}
              fill="none"
              stroke={color}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))
        ) : (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            fill={C.dim}
            fontFamily={MONO}
            fontSize="11"
          >
            No samples yet
          </text>
        )}
        {latest && (
          <circle
            cx={xFor(latest.index)}
            cy={yFor(latest.value)}
            r="3.5"
            fill={color}
            stroke={C.panel2}
            strokeWidth="2"
          />
        )}
        <text
          x={pad.left}
          y={height - 8}
          fill={C.dim}
          fontFamily={MONO}
          fontSize="10"
        >
          recent
        </text>
        <text
          x={width - pad.right}
          y={height - 8}
          textAnchor="end"
          fill={C.dim}
          fontFamily={MONO}
          fontSize="10"
        >
          now
        </text>
      </svg>
    </div>
  );
}

function MetricCard({
  testId,
  icon,
  title,
  value,
  detail,
  average,
  children,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
  average: string;
  children: ReactNode;
}) {
  return (
    <section className="health-card" data-testid={testId}>
      <div className="health-card-head">
        <span className="health-icon">{icon}</span>
        <span className="health-title">{title}</span>
      </div>
      <div className="health-value">{value}</div>
      <div className="health-detail">{detail}</div>
      <div className="health-average">{average}</div>
      {children}
    </section>
  );
}

export function HealthPanel() {
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setBusy(true);
    try {
      setHealth(await getAdminHealth());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      refreshingRef.current = false;
      setBusy(false);
    }
  }, []);

  usePoll(refresh, 30_000);

  const samples = health?.history ?? [];
  const current = health?.current ?? null;
  const averages = health?.averages24h ?? null;
  const coverage = averages ? formatAge(averages.coverageSeconds) : EMPTY;
  const sampleCount = averages?.sampleCount ?? 0;
  const cpuValues = chartSeries(samples, (sample) => sample.cpu.loadPct);
  const memoryValues = chartSeries(samples, (sample) => sample.memory.usedPct);
  const storageValues = chartSeries(
    samples,
    (sample) => sample.storage?.usedPct ?? null,
  );
  const cpuDomainMax = Math.max(100, ...cpuValues.filter(isReal));

  return (
    <div data-testid="admin-health-page">
      <style jsx>{`
        .health-header {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          margin-bottom: 14px;
        }
        .health-title-block {
          display: grid;
          gap: 3px;
        }
        .health-refresh {
          width: 34px;
          height: 34px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid ${C.stroke};
          background: ${C.panel3};
          color: ${C.muted};
          border-radius: 8px;
          cursor: pointer;
        }
        .health-refresh:disabled {
          cursor: wait;
          opacity: 0.6;
        }
        .health-summary {
          font-family: ${MONO};
          font-size: 10.5px;
          color: ${C.dim};
        }
        .health-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .health-card {
          min-width: 0;
          background: ${C.panel};
          border: 1px solid ${C.border};
          border-radius: 8px;
          padding: 14px;
          display: grid;
          gap: 9px;
        }
        .health-card-head {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 26px;
        }
        .health-icon {
          width: 26px;
          height: 26px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid ${C.stroke};
          border-radius: 8px;
          color: ${C.teal};
          background: ${C.panel2};
          flex: 0 0 auto;
        }
        .health-title {
          font-family: ${MONO};
          font-size: 11px;
          color: ${C.dim};
          text-transform: uppercase;
        }
        .health-value {
          font-family: ${MONO};
          font-size: clamp(24px, 4vw, 38px);
          line-height: 1;
          color: ${C.text};
        }
        .health-detail,
        .health-average {
          font-family: ${MONO};
          font-size: 11px;
          line-height: 1.45;
          color: ${C.muted};
          overflow-wrap: anywhere;
        }
        .health-average {
          color: ${C.teal};
        }
        .health-chart {
          width: 100%;
          height: 150px;
          overflow: hidden;
        }
        .health-chart svg {
          width: 100%;
          height: 100%;
          display: block;
          overflow: hidden;
        }
        .health-error {
          margin-bottom: 12px;
          font-family: ${MONO};
          font-size: 11px;
          color: ${C.red};
        }
        .health-incidents {
          margin-bottom: 12px;
        }
        .health-section {
          margin-bottom: 12px;
          padding: 14px;
          border: 1px solid ${C.border};
          border-radius: 9px;
          background: ${C.panel};
        }
        .health-section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .health-section-title {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          color: ${C.text};
          font-family: ${MONO};
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .health-section-meta {
          color: ${C.dim};
          font-family: ${MONO};
          font-size: 10px;
        }
        .fleet-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 10px;
        }
        .fleet-node {
          min-width: 0;
          padding: 12px;
          border: 1px solid ${C.borderSoft};
          border-radius: 8px;
          background: ${C.panel2};
          font-family: ${MONO};
        }
        .fleet-node-head,
        .fleet-node-name,
        .slot-reading,
        .fleet-storage,
        .performance-source-head,
        .performance-source-head > div,
        .performance-source-foot {
          display: flex;
          align-items: center;
        }
        .fleet-node-head,
        .slot-reading,
        .performance-source-head,
        .performance-source-foot {
          justify-content: space-between;
          gap: 10px;
        }
        .fleet-node-name {
          min-width: 0;
          gap: 8px;
        }
        .fleet-node-name > div,
        .performance-source-head > div {
          min-width: 0;
          display: grid;
          gap: 2px;
        }
        .fleet-node-name strong,
        .performance-source-head strong {
          overflow: hidden;
          color: ${C.text};
          font-size: 11px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fleet-node-name span,
        .performance-source-head span,
        .slot-reading span,
        .fleet-stat-grid span,
        .fleet-storage,
        .performance-source-foot {
          color: ${C.dim};
          font-size: 9px;
        }
        .fleet-node-icon {
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
          border: 1px solid ${C.tealBorder};
          border-radius: 7px;
          color: ${C.teal};
          background: ${C.tealFill};
        }
        .fleet-state {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          flex: 0 0 auto;
          font-family: ${MONO};
          font-size: 9px;
          text-transform: uppercase;
        }
        .fleet-state i {
          width: 6px;
          height: 6px;
          border-radius: 50%;
        }
        .slot-reading {
          margin-top: 13px;
        }
        .slot-reading > div {
          display: grid;
          gap: 2px;
        }
        .slot-reading strong {
          color: ${C.text};
          font-size: 22px;
          line-height: 1;
        }
        .slot-reading small {
          color: ${C.dim};
          font-size: 13px;
        }
        .slot-reading > span {
          color: ${C.muted};
          font-size: 11px;
        }
        .slot-track {
          height: 5px;
          margin-top: 8px;
          overflow: hidden;
          border-radius: 999px;
          background: ${C.grid};
        }
        .slot-track i {
          height: 100%;
          display: block;
          border-radius: inherit;
          transition: width 220ms ease;
        }
        .fleet-stat-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px;
          margin-top: 11px;
        }
        .fleet-stat-grid > div {
          min-width: 0;
          display: grid;
          gap: 2px;
          padding: 7px;
          border-radius: 6px;
          background: ${C.panel3};
        }
        .fleet-stat-grid strong {
          color: ${C.text};
          font-size: 11px;
        }
        .fleet-storage {
          gap: 7px;
          margin-top: 10px;
        }
        .fleet-storage strong {
          font-size: 10px;
        }
        .fleet-storage span:last-child {
          margin-left: auto;
        }
        .fleet-capacity-note,
        .fleet-awaiting {
          min-height: 30px;
          box-sizing: border-box;
          margin-top: 9px;
          padding: 7px 8px;
          border-radius: 6px;
          font-family: ${MONO};
          font-size: 9px;
          line-height: 1.35;
        }
        .fleet-capacity-note {
          display: flex;
          align-items: center;
          gap: 7px;
          color: ${C.amber};
          background: rgba(245, 165, 36, 0.08);
        }
        .fleet-awaiting {
          color: ${C.dim};
          background: ${C.panel3};
        }
        .performance-summary {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 7px;
          margin-bottom: 12px;
        }
        .performance-summary > div {
          min-width: 0;
          display: grid;
          gap: 3px;
          padding: 9px 10px;
          border-radius: 7px;
          background: ${C.panel2};
          font-family: ${MONO};
        }
        .performance-summary strong {
          color: ${C.text};
          font-size: 18px;
        }
        .performance-summary span {
          color: ${C.dim};
          font-size: 9px;
          text-transform: uppercase;
        }
        .throughput-legend {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 10px;
          margin-bottom: 7px;
          color: ${C.dim};
          font-family: ${MONO};
          font-size: 9px;
        }
        .throughput-legend span {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .throughput-legend i {
          width: 8px;
          height: 8px;
          border-radius: 2px;
        }
        .throughput-bars {
          height: 185px;
          display: grid;
          grid-template-columns: repeat(7, minmax(0, 1fr));
          align-items: stretch;
          gap: 8px;
          padding: 10px 10px 0;
          border-radius: 8px;
          background: ${C.panel2};
        }
        .throughput-day {
          min-width: 0;
          display: grid;
          grid-template-rows: 18px minmax(0, 1fr) 24px;
          gap: 4px;
          text-align: center;
        }
        .throughput-value,
        .throughput-day-label {
          overflow: hidden;
          color: ${C.dim};
          font-family: ${MONO};
          font-size: 9px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .throughput-column {
          min-height: 0;
          display: flex;
          align-items: end;
          justify-content: center;
          border-bottom: 1px solid ${C.axis};
          background-image: linear-gradient(
            to bottom,
            transparent 49%,
            ${C.grid} 50%,
            transparent 51%
          );
        }
        .throughput-column > div {
          width: min(34px, 70%);
          min-height: 2px;
          display: flex;
          flex-direction: column-reverse;
          overflow: hidden;
          border-radius: 4px 4px 0 0;
          transition: height 220ms ease;
        }
        .throughput-column i {
          width: 100%;
          display: block;
        }
        .throughput-rans {
          background: ${C.teal};
        }
        .throughput-preliminary {
          background: ${C.violet};
        }
        .throughput-final {
          background: ${C.amber};
        }
        .performance-source-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
          gap: 8px;
          margin-top: 10px;
        }
        .performance-source {
          min-width: 0;
          padding: 10px;
          border: 1px solid ${C.borderSoft};
          border-radius: 7px;
          background: ${C.panel2};
          font-family: ${MONO};
        }
        .performance-source-head > div:last-child {
          justify-items: end;
        }
        .source-spark {
          height: 42px;
          display: grid;
          grid-template-columns: repeat(7, minmax(0, 1fr));
          align-items: end;
          gap: 4px;
          margin: 9px 0 6px;
          border-bottom: 1px solid ${C.axis};
        }
        .source-spark i {
          min-height: 2px;
          border-radius: 2px 2px 0 0;
          background: ${C.teal};
        }
        @media (max-width: 980px) {
          .health-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
        @media (max-width: 760px) {
          .fleet-grid,
          .performance-source-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .performance-summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 460px) {
          .health-section {
            padding: 11px;
          }
          .health-section-head {
            align-items: flex-start;
            flex-direction: column;
            gap: 4px;
          }
          .throughput-bars {
            gap: 4px;
            padding-inline: 5px;
          }
          .throughput-day-label {
            font-size: 8px;
          }
        }
      `}</style>

      <div className="health-header">
        <div className="health-title-block">
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Health</h2>
          <div className="health-summary">
            {health
              ? `Updated ${formatTime(health.asOf)} | ${sampleCount.toLocaleString()} sample${sampleCount === 1 ? "" : "s"} | coverage ${coverage}`
              : "Loading host stats"}
          </div>
        </div>
        <button
          type="button"
          className="health-refresh"
          aria-label="Refresh health"
          title="Refresh health"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {err && <div className="health-error">{err}</div>}

      {health && (
        <div className="health-incidents">
          <SolverIncidentPanel
            summary={health.solverIncidents}
            events={health.solverIncidentEvents}
            surface="health"
            showClear
          />
        </div>
      )}

      {health && (
        <section className="health-section" data-testid="health-compute-fleet">
          <div className="health-section-head">
            <div className="health-section-title">
              <Server size={15} />
              Compute fleet
            </div>
            <div className="health-section-meta">
              {health.fleet.remotes
                .filter((node) => node.connectivity === "online")
                .length.toLocaleString()}{" "}
              remote online
            </div>
          </div>
          <div className="fleet-grid">
            <NodeCard node={health.fleet.local} local />
            {health.fleet.remotes.map((node) => (
              <NodeCard key={node.id} node={node} />
            ))}
          </div>
        </section>
      )}

      {health && (
        <section className="health-section" data-testid="health-performance">
          <div className="health-section-head">
            <div className="health-section-title">
              <Gauge size={15} />
              Solver output
            </div>
            <div className="health-section-meta">
              accepted points · UTC · {health.performance.windowDays} days
            </div>
          </div>
          <div className="performance-summary">
            <div>
              <strong>{formatCount(health.performance.totals24h.total)}</strong>
              <span>all · last 24h</span>
            </div>
            <div>
              <strong>{formatCount(health.performance.totals24h.rans)}</strong>
              <span>RANS</span>
            </div>
            <div>
              <strong>
                {formatCount(health.performance.totals24h.preliminary)}
              </strong>
              <span>Fast URANS</span>
            </div>
            <div>
              <strong>{formatCount(health.performance.totals24h.final)}</strong>
              <span>Final URANS</span>
            </div>
          </div>
          <div className="throughput-legend" aria-hidden="true">
            <span>
              <i style={{ background: C.teal }} /> RANS
            </span>
            <span>
              <i style={{ background: C.violet }} /> Fast URANS
            </span>
            <span>
              <i style={{ background: C.amber }} /> Final URANS
            </span>
          </div>
          <ThroughputBars daily={health.performance.daily} />
          <div className="performance-source-grid">
            {health.performance.sources.map((source) => (
              <SourcePerformance key={source.id} source={source} />
            ))}
          </div>
        </section>
      )}

      <div className="health-grid">
        <MetricCard
          testId="health-cpu-card"
          icon={<Cpu size={15} />}
          title="CPU load"
          value={formatPct(current?.cpu.loadPct, 0)}
          detail={
            current
              ? `${formatLoad(current.cpu.load1)} load / ${current.cpu.availableCpus.toLocaleString()} available CPU`
              : "Waiting for host sample"
          }
          average={
            averages
              ? `24h avg ${formatPct(averages.cpuLoadPct, 0)} (${formatLoad(averages.cpuLoad1)} load)`
              : "24h avg waiting"
          }
        >
          <MetricChart
            label="CPU"
            values={cpuValues}
            color={C.teal}
            domainMax={cpuDomainMax}
          />
        </MetricCard>

        <MetricCard
          testId="health-memory-card"
          icon={<MemoryStick size={15} />}
          title="Memory"
          value={formatPct(current?.memory.usedPct, 0)}
          detail={
            current
              ? `${formatBytes(current.memory.usedBytes)} used / ${formatBytes(current.memory.totalBytes)} total`
              : "Waiting for host sample"
          }
          average={
            averages
              ? `24h avg ${formatPct(averages.memoryUsedPct, 0)}`
              : "24h avg waiting"
          }
        >
          <MetricChart label="Memory" values={memoryValues} color={C.amber} />
        </MetricCard>

        <MetricCard
          testId="health-storage-card"
          icon={<HardDrive size={15} />}
          title="Storage"
          value={formatPct(current?.storage?.usedPct, 0)}
          detail={
            current?.storage
              ? `${formatBytes(current.storage.usedBytes)} used / ${formatBytes(current.storage.totalBytes)} total`
              : current?.storageError
                ? current.storageError
                : "Waiting for host sample"
          }
          average={
            current?.storage
              ? `Path ${current.storage.path}`
              : "Path unavailable"
          }
        >
          <MetricChart
            label="Storage"
            values={storageValues}
            color={C.redText}
          />
        </MetricCard>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: MONO,
          fontSize: 10.5,
          color: C.dim,
        }}
      >
        <Activity size={13} />
        CPU percentage is the 1-minute load average divided by available CPU
        count.
      </div>
    </div>
  );
}
