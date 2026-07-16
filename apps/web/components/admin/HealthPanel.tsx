"use client";

import { Activity, Cpu, HardDrive, MemoryStick, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";

import {
  type AdminHealth,
  type AdminHealthSample,
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
        @media (max-width: 980px) {
          .health-grid {
            grid-template-columns: minmax(0, 1fr);
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
            surface="health"
            showClear
          />
        </div>
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
