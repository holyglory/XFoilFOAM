import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Parsing a single historical report can occupy a JS thread for seconds.
// Keep the controller's event loop free for solver leases and heartbeats.
export async function runReportStorageProcess(
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const child = fork(
      new URL("./report-storage-worker.ts", import.meta.url),
      [],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      grace = setTimeout(() => child.kill("SIGKILL"), 5000);
      grace.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [code, reason] = await once(child, "exit");
      if (!signal.aborted)
        console.error("[sweeper] report storage process exited", code, reason);
    } catch (error) {
      if (!signal.aborted)
        console.error(
          "[sweeper] report storage process failed",
          error instanceof Error ? error.message : String(error),
        );
    } finally {
      clearTimeout(grace);
      signal.removeEventListener("abort", stop);
    }
    if (!signal.aborted)
      await delay(10000, undefined, { signal }).catch(() => {});
  }
}
