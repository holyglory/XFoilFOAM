import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import {
  LegacyStorageOperationError,
  legacySshOperationError,
} from "./legacy-report-storage-gcs";

export interface PeerMemory {
  minAvailableMiB: number;
  peakWorkerRssMiB: number;
  peakControllerRssMiB: number;
  permitted: boolean;
  workerHostAvailableMiB?: number;
  workerHostFreeMiB?: number;
  workerCgroupMarginMiB?: number | null;
}
export type PeerCapacityReason =
  | "capacity_unavailable"
  | "memory_margin"
  | "worker_rss_budget"
  | "prior_capacity_hold";
export interface PeerBudget {
  reason?: PeerCapacityReason;
  admit: boolean;
  finish(): Promise<PeerMemory | null>;
}
const samplerPath = "./legacy-report-peer-memory-sampler.cjs";
const { availableMiB: controllerAvailable } = createRequire(import.meta.url)(
  samplerPath,
) as { availableMiB(): number };
export class LegacyPeerOccupied extends Error {
  readonly retryable = true;
  readonly code = "custody_worker_active";
  readonly exitCode = 75;
  constructor() {
    super("A physical custody worker is still active on the selected target");
  }
}
export async function openLegacyPeerBudget(
  host: string,
  container: string,
  minMiB: number,
  maxRssMiB: number,
  pairReserveMiB = 3072,
): Promise<PeerBudget> {
  if (
    !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(container)
  )
    throw Error("Invalid memory probe target");
  try {
    return await measurePeer(
      host,
      container,
      minMiB,
      maxRssMiB,
      pairReserveMiB,
    );
  } catch (error) {
    if (!capacitySamplingFailed(error)) throw error;
    return {
      admit: false,
      reason: "capacity_unavailable",
      finish: async () => null,
    };
  }
}
export function capacitySamplingFailed(error: unknown) {
  // Host identity and authentication failures retain their permanent category.
  return !(
    error instanceof LegacyStorageOperationError &&
    ["host_key_denied", "credentials_denied"].includes(error.details.category)
  );
}
async function measurePeer(
  host: string,
  container: string,
  minMiB: number,
  maxRssMiB: number,
  pairReserveMiB: number,
): Promise<PeerBudget> {
  const initialFree = controllerAvailable();
  const remoteSampler =
    readFileSync(new URL(samplerPath, import.meta.url), "utf8") +
    "\nwatchCustodyMemory();";
  const cmd =
    "docker exec -i " +
    container +
    " node -e 'eval(Buffer.from(\"" +
    Buffer.from(remoteSampler).toString("base64") +
    '","base64").toString())\'';
  const child = spawn(
    "ssh",
    [
      "-T",
      "-oBatchMode=yes",
      "-oStrictHostKeyChecking=yes",
      "-oForwardAgent=no",
      "-oClearAllForwardings=yes",
      "-oConnectTimeout=6",
      host,
      cmd,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "",
    free = initialFree,
    rss = 0,
    localFailed = false;
  child.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-4096);
  });
  child.stdin.on("error", () => {});
  const finished = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: null }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  function poll() {
    try {
      free = Math.min(free, controllerAvailable());
      rss = Math.max(rss, Math.ceil(process.memoryUsage.rss() / 1048576));
    } catch {
      localFailed = true;
    }
  }
  const expire = setTimeout(() => child.kill("SIGKILL"), 10000);
  expire.unref();
  async function sample(): Promise<PeerMemory> {
    const line = await lines.next();
    if (line.done || line.value.length > 1024) {
      const rc = await finished;
      throw legacySshOperationError("worker_custody", rc, stderr, true);
    }
    const v = JSON.parse(line.value);
    const nonnegative = (n: unknown): n is number =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (
      !Array.isArray(v) ||
      v.length !== 3 ||
      !nonnegative(v[0]) ||
      !nonnegative(v[1]) ||
      !v[2] ||
      !nonnegative(v[2].hostAvailableMiB) ||
      !nonnegative(v[2].hostFreeMiB) ||
      !(v[2].cgroupMarginMiB === null || nonnegative(v[2].cgroupMarginMiB)) ||
      v[0] > v[2].hostAvailableMiB
    )
      throw Error("Invalid aggregate worker capacity measurement");
    poll();
    const minAvailableMiB = Math.min(free, v[0]);
    return {
      minAvailableMiB,
      peakWorkerRssMiB: v[1],
      workerHostAvailableMiB: v[2].hostAvailableMiB,
      workerHostFreeMiB: v[2].hostFreeMiB,
      workerCgroupMarginMiB: v[2].cgroupMarginMiB,
      peakControllerRssMiB: rss,
      permitted:
        !localFailed &&
        minAvailableMiB >= minMiB &&
        Math.max(rss, v[1]) <= maxRssMiB,
    };
  }
  try {
    const first = await sample();
    const hasRoomForPair = first.peakWorkerRssMiB + pairReserveMiB <= maxRssMiB;
    clearTimeout(expire);
    const timer = setInterval(poll, 500);
    timer.unref();
    const lifetime = setTimeout(() => child.kill("SIGKILL"), 900000);
    lifetime.unref();
    return {
      admit: first.permitted && hasRoomForPair,
      reason: !first.permitted
        ? "memory_margin"
        : !hasRoomForPair
          ? "worker_rss_budget"
          : undefined,
      finish: async () => {
        child.stdin.end();
        const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
        timeout.unref();
        try {
          const last = await sample(),
            rc = await finished;
          if (rc.code !== 0)
            throw legacySshOperationError("worker_custody", rc, stderr, true);
          return last;
        } finally {
          clearTimeout(timeout);
          clearTimeout(lifetime);
          clearInterval(timer);
          child.kill();
        }
      },
    };
  } catch (e) {
    clearTimeout(expire);
    child.kill();
    throw e;
  }
}
