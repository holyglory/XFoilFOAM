import { makeContext } from "./config";
import { resultMediaRepairTick } from "./media-repair";

const { db, sql, engine } = makeContext();
const ac = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => ac.abort());

const POLL_INTERVAL_MS = 30_000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

console.log(
  `[media-repair] starting — engine=${engine.baseUrl}. Durable rendering is isolated from scheduler ticks.`,
);
try {
  while (!ac.signal.aborted) {
    try {
      const outcome = await resultMediaRepairTick(db, engine);
      if (
        outcome.discovered ||
        outcome.finalized ||
        outcome.claimed ||
        outcome.blocked
      ) {
        console.log(
          `[media-repair] pass: discovered ${outcome.discovered}, ` +
            `finalized ${outcome.finalized}, rendered ${outcome.repairedMedia}, ` +
            `retrying ${outcome.retrying}, blocked ${outcome.blocked}`,
        );
      }
    } catch (error) {
      console.error("[media-repair] pass failed:", errorMessage(error));
    }
    await delay(POLL_INTERVAL_MS, ac.signal);
  }
} finally {
  await sql.end();
}
console.log("[media-repair] stopped");
