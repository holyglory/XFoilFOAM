import { makeContext } from "./config";
import { runLoop } from "./loop";

const { db, sql, engine } = makeContext();
const ac = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => ac.abort());

console.log(`[sweeper] starting — engine=${engine.baseUrl}. Gated by sweeper_state.enabled.`);
await runLoop(db, engine, ac.signal);
await sql.end();
console.log("[sweeper] stopped");
