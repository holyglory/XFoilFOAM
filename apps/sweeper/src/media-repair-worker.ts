import { makeContext } from "./config";
import { resultMediaRepairBatch } from "./media-repair";
import {
  configuredMediaRepairConcurrency,
  nextMediaRepairDelayMs,
} from "./media-repair-worker-policy";

const { db, sql, engine } = makeContext();
const ac = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => ac.abort());

const concurrency = configuredMediaRepairConcurrency();

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
  `[media-repair] starting — engine=${engine.baseUrl}, concurrency=${concurrency}. Durable rendering is isolated from scheduler ticks.`,
);
try {
  while (!ac.signal.aborted) {
    let delayMs = 30_000;
    try {
      const outcome = await resultMediaRepairBatch(db, engine, {
        concurrency,
        discoveryLimit: 1_000,
      });
      delayMs = nextMediaRepairDelayMs(outcome);
      if (
        outcome.discovered ||
        outcome.finalized ||
        outcome.claimed ||
        outcome.blocked
      ) {
        console.log(
          `[media-repair] pass: discovered ${outcome.discovered}, ` +
            `claimed ${outcome.claimedCount}, finalized ${outcome.finalized}, ` +
            `rendered ${outcome.repairedMedia}, ` +
            `retrying ${outcome.retrying}, blocked ${outcome.blocked}`,
        );
      }
    } catch (error) {
      console.error("[media-repair] pass failed:", errorMessage(error));
    }
    await delay(delayMs, ac.signal);
  }
} finally {
  await sql.end();
}
console.log("[media-repair] stopped");
