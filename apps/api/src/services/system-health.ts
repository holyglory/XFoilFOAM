import { statfs } from "node:fs/promises";
import os from "node:os";

const SAMPLE_INTERVAL_MS = 60_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_SAMPLES = 6_000;

export interface SystemHealthSample {
  at: string;
  cpu: {
    load1: number;
    load5: number;
    load15: number;
    availableCpus: number;
    loadPct: number;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPct: number;
  };
  storage: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPct: number;
  } | null;
  storageError: string | null;
}

export interface SystemHealthSnapshot {
  asOf: string;
  sampleIntervalSeconds: number;
  windowHours: number;
  current: SystemHealthSample;
  averages24h: {
    sampleCount: number;
    coverageSeconds: number;
    firstSampleAt: string | null;
    cpuLoad1: number | null;
    cpuLoadPct: number | null;
    memoryUsedPct: number | null;
  };
  history: SystemHealthSample[];
}

let history: SystemHealthSample[] = [];
let sampleTimer: NodeJS.Timeout | null = null;
let samplerRefs = 0;
let samplingPromise: Promise<SystemHealthSample> | null = null;

function pct(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return (used / total) * 100;
}

function availableCpus(): number {
  const detected = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, detected || 1);
}

function storagePath(): string {
  return process.env.ADMIN_HEALTH_STORAGE_PATH || process.env.HEALTH_STORAGE_PATH || "/";
}

function trimHistory(nowMs = Date.now()): void {
  const cutoff = nowMs - WINDOW_MS;
  history = history.filter((sample) => new Date(sample.at).getTime() >= cutoff);
  if (history.length > MAX_HISTORY_SAMPLES) history = history.slice(history.length - MAX_HISTORY_SAMPLES);
}

function avg(values: Array<number | null | undefined>): number | null {
  const real = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (real.length === 0) return null;
  return real.reduce((sum, value) => sum + value, 0) / real.length;
}

async function collectSystemHealthSample(): Promise<SystemHealthSample> {
  const now = new Date();
  const cpus = availableCpus();
  const [load1, load5, load15] = os.loadavg();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const path = storagePath();
  let storage: SystemHealthSample["storage"] = null;
  let storageError: string | null = null;

  try {
    const stats = await statfs(path);
    const blockSize = Number(stats.bsize);
    const totalStorageBytes = Number(stats.blocks) * blockSize;
    const freeStorageBytes = Number(stats.bavail) * blockSize;
    const usedStorageBytes = Math.max(0, totalStorageBytes - freeStorageBytes);
    storage = {
      path,
      totalBytes: totalStorageBytes,
      freeBytes: freeStorageBytes,
      usedBytes: usedStorageBytes,
      usedPct: pct(usedStorageBytes, totalStorageBytes),
    };
  } catch (err) {
    storageError = (err as Error).message;
  }

  return {
    at: now.toISOString(),
    cpu: {
      load1,
      load5,
      load15,
      availableCpus: cpus,
      loadPct: pct(load1, cpus),
    },
    memory: {
      totalBytes,
      freeBytes,
      usedBytes,
      usedPct: pct(usedBytes, totalBytes),
    },
    storage,
    storageError,
  };
}

export async function recordSystemHealthSample(): Promise<SystemHealthSample> {
  if (samplingPromise) return samplingPromise;
  samplingPromise = collectSystemHealthSample()
    .then((sample) => {
      history.push(sample);
      trimHistory(new Date(sample.at).getTime());
      return sample;
    })
    .finally(() => {
      samplingPromise = null;
    });
  return samplingPromise;
}

export async function systemHealthSnapshot(): Promise<SystemHealthSnapshot> {
  const current = await recordSystemHealthSample();
  const nowMs = new Date(current.at).getTime();
  trimHistory(nowMs);
  const first = history[0] ?? null;
  const last = history[history.length - 1] ?? null;
  const coverageSeconds =
    first && last ? Math.max(0, (new Date(last.at).getTime() - new Date(first.at).getTime()) / 1000) : 0;

  return {
    asOf: current.at,
    sampleIntervalSeconds: SAMPLE_INTERVAL_MS / 1000,
    windowHours: WINDOW_MS / (60 * 60 * 1000),
    current,
    averages24h: {
      sampleCount: history.length,
      coverageSeconds,
      firstSampleAt: first?.at ?? null,
      cpuLoad1: avg(history.map((sample) => sample.cpu.load1)),
      cpuLoadPct: avg(history.map((sample) => sample.cpu.loadPct)),
      memoryUsedPct: avg(history.map((sample) => sample.memory.usedPct)),
    },
    history,
  };
}

export function startSystemHealthSampler(): () => void {
  samplerRefs += 1;
  if (!sampleTimer) {
    void recordSystemHealthSample();
    sampleTimer = setInterval(() => {
      void recordSystemHealthSample();
    }, SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();
  }
  return () => {
    samplerRefs = Math.max(0, samplerRefs - 1);
    if (samplerRefs === 0 && sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
  };
}
