import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { legacySshOperationError } from "./legacy-report-storage-gcs";

export interface PeerMemory {
  minAvailableMiB: number;
  peakWorkerRssMiB: number;
  peakControllerRssMiB: number;
  permitted: boolean;
}
export interface PeerBudget {
  admit: boolean;
  finish(): Promise<PeerMemory>;
}
const samplerPath = "./legacy-report-peer-memory-sampler.cjs";
const { availableMiB: controllerAvailable } = createRequire(import.meta.url)(
  samplerPath,
) as { availableMiB(): number };
export class LegacyPeerOccupied extends Error {
  readonly retryable = true;
  readonly code = "custody_worker_active";
  constructor() {
    super("A physical custody worker is still active on the selected target");
  }
}
export async function openLegacyPeerBudget(
  host: string,
  container: string,
  minMiB: number,
  maxRssMiB: number,
): Promise<PeerBudget> {
  if (
    !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(container)
  )
    throw Error("Invalid memory probe target");
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
    if (line.done || line.value.length > 128) {
      const rc = await finished;
      throw legacySshOperationError("worker_custody", rc, stderr, true);
    }
    const v = JSON.parse(line.value);
    if (
      !Array.isArray(v) ||
      v.length !== 2 ||
      !v.every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      throw Error("Invalid aggregate worker memory measurement");
    poll();
    const minAvailableMiB = Math.min(free, v[0]);
    return {
      minAvailableMiB,
      peakWorkerRssMiB: v[1],
      peakControllerRssMiB: rss,
      permitted:
        !localFailed &&
        minAvailableMiB >= minMiB &&
        Math.max(rss, v[1]) <= maxRssMiB,
    };
  }
  try {
    const first = await sample();
    if (first.peakWorkerRssMiB > 0) throw new LegacyPeerOccupied();
    clearTimeout(expire);
    const timer = setInterval(poll, 500);
    timer.unref();
    const lifetime = setTimeout(() => child.kill("SIGKILL"), 900000);
    lifetime.unref();
    return {
      admit: first.permitted,
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
