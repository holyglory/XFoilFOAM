import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";

interface OriginalCycle {
  directory: string;
  scope?: string;
  hzHost: string;
  hzContainer: string;
  hubHost: string;
  hubContainer: string;
  bucket: string;
  accountFile: string;
}
/** A slice is a child of the *same* worker-custody watcher. A deployment stop
 * signals it and waits for its current bounded page / durable receipt. */
export async function runOriginalCycle(
  c: OriginalCycle,
  seconds: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const file = fileURLToPath(
    new URL("../../../scripts/deploy/hz-attempt-originals.py", import.meta.url),
  );
  const args = [
    file,
    "cycle",
    "--apply",
    "--directory",
    c.directory,
    "--until-complete",
    "--slice-seconds",
    String(seconds),
    "--refresh-seconds",
    "3600",
    "--hz-host",
    c.hzHost,
    "--hz-container",
    c.hzContainer,
    "--hub-host",
    c.hubHost,
    "--hub-container",
    c.hubContainer,
    "--bucket",
    c.bucket,
    "--hub-account-file",
    c.accountFile,
  ];
  if (c.scope) args.push("--scope", c.scope);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (error.length < 4096)
        error += chunk.toString("utf8").slice(0, 4096 - error.length);
    });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("error", () => {
      signal.removeEventListener("abort", stop);
      reject(new HistoryOperationError("original_cycle", "input"));
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (code === 0) return resolve();
      const denied = error.includes('"category":"denied"');
      reject(
        new HistoryOperationError(
          "original_cycle",
          denied ? "denied" : "integrity",
        ),
      );
    });
  });
}
