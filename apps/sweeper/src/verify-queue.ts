import { createClient, results, simJobs } from "@aerodb/db";
import { and, count, eq, gt, gte, inArray, lt, or } from "drizzle-orm";

type Mode = "active" | "sample" | "complete";

interface Args {
  mode: Mode;
  minDoneJobs: number;
  since?: Date;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: "active", minDoneJobs: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--mode" && (next === "active" || next === "sample" || next === "complete")) {
      args.mode = next;
      i += 1;
    } else if (arg === "--min-done-jobs" && next) {
      args.minDoneJobs = Number(next);
      i += 1;
    } else if (arg === "--since" && next) {
      const date = new Date(next);
      if (Number.isNaN(date.getTime())) throw new Error(`Invalid --since value: ${next}`);
      args.since = date;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm --filter @aerodb/sweeper verify:queue -- --mode active|sample|complete [--since ISO] [--min-done-jobs N]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { db, sql } = createClient({ max: 1 });
  try {
    const [failedJobs] = await db.select({ n: count() }).from(simJobs).where(eq(simJobs.status, "failed"));
    const [failedResults] = await db.select({ n: count() }).from(results).where(eq(results.status, "failed"));
    const [highAoaRows] = await db.select({ n: count() }).from(results).where(or(gt(results.aoaDeg, 60), lt(results.aoaDeg, -60)));
    const [inFlight] = await db
      .select({ n: count() })
      .from(simJobs)
      .where(inArray(simJobs.status, ["submitted", "running", "ingesting"]));
    const [doneJobs] = await db
      .select({ n: count() })
      .from(simJobs)
      .where(args.since ? and(eq(simJobs.status, "done"), gte(simJobs.finishedAt, args.since)) : eq(simJobs.status, "done"));
    const doneSince = args.since
      ? await db
          .select({ id: simJobs.id, engineJobId: simJobs.engineJobId, finishedAt: simJobs.finishedAt })
          .from(simJobs)
          .where(and(eq(simJobs.status, "done"), gte(simJobs.finishedAt, args.since)))
      : [];

    const summary = {
      mode: args.mode,
      failedJobs: failedJobs.n,
      failedResults: failedResults.n,
      highAoaRows: highAoaRows.n,
      inFlight: inFlight.n,
      doneJobs: doneJobs.n,
      since: args.since?.toISOString() ?? null,
      doneSince,
    };

    const failures: string[] = [];
    if (failedJobs.n > 0) failures.push(`${failedJobs.n} failed sim job(s)`);
    if (failedResults.n > 0) failures.push(`${failedResults.n} failed result row(s)`);
    if (highAoaRows.n > 0) failures.push(`${highAoaRows.n} high-AoA test row(s)`);
    if (args.mode === "sample" && doneJobs.n < args.minDoneJobs) {
      failures.push(`only ${doneJobs.n} done job(s), expected at least ${args.minDoneJobs}`);
    }
    if (args.mode === "complete") {
      if (inFlight.n > 0) failures.push(`${inFlight.n} in-flight job(s) remain`);
      if (doneJobs.n < args.minDoneJobs) failures.push(`only ${doneJobs.n} done job(s), expected at least ${args.minDoneJobs}`);
    }

    console.log(JSON.stringify({ ok: failures.length === 0, failures, summary }, null, 2));
    if (failures.length) process.exit(1);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
