import { makeContext } from "./config";
import {
  prepareResultMediaRepairPass,
  repairNextResultMediaClaim,
} from "./media-repair";
import {
  configuredMediaRepairConcurrency,
  MEDIA_REPAIR_ACTIVE_DELAY_MS,
  MEDIA_REPAIR_IDLE_DELAY_MS,
  MEDIA_REPAIR_MAINTENANCE_DELAY_MS,
  runUntilAborted,
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
  const maintenance = runUntilAborted(ac.signal, async () => {
    try {
      const outcome = await prepareResultMediaRepairPass(db, {
        discoveryLimit: 1_000,
      });
      if (
        outcome.discovered ||
        outcome.finalized ||
        outcome.retrying ||
        outcome.blocked
      ) {
        console.log(
          `[media-repair] maintenance: discovered ${outcome.discovered}, ` +
            `finalized ${outcome.finalized}, ` +
            `retrying ${outcome.retrying}, blocked ${outcome.blocked}`,
        );
      }
    } catch (error) {
      console.error("[media-repair] maintenance failed:", errorMessage(error));
    }
    await delay(MEDIA_REPAIR_MAINTENANCE_DELAY_MS, ac.signal);
  });
  const lanes = Array.from({ length: concurrency }, (_, index) =>
    runUntilAborted(ac.signal, async () => {
      let claimed = false;
      try {
        const outcome = await repairNextResultMediaClaim(db, engine, {
          preferNewestLive: index === 0,
        });
        claimed = outcome.claimed;
        if (
          outcome.claimed ||
          outcome.finalized ||
          outcome.retrying ||
          outcome.blocked
        ) {
          console.log(
            `[media-repair] lane ${index + 1}: claimed ${Number(outcome.claimed)}, ` +
              `finalized ${outcome.finalized}, rendered ${outcome.repairedMedia}, ` +
              `retrying ${outcome.retrying}, blocked ${outcome.blocked}`,
          );
        }
      } catch (error) {
        console.error(
          `[media-repair] lane ${index + 1} failed:`,
          errorMessage(error),
        );
      }
      await delay(
        claimed ? MEDIA_REPAIR_ACTIVE_DELAY_MS : MEDIA_REPAIR_IDLE_DELAY_MS,
        ac.signal,
      );
    }),
  );
  await Promise.all([maintenance, ...lanes]);
} finally {
  await sql.end();
}
console.log("[media-repair] stopped");
