import { expect } from "vitest";
import type { Sql } from "@aerodb/db/client";
import {
  reportTextIdentity,
  canonicalReportJson,
  parseReportJson,
} from "@aerodb/db/progressive-report-archive";
import { createHash } from "node:crypto";

interface ExecutedPlan {
  "Execution Time": number;
  Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
  Triggers?: Array<{ "Trigger Name": string; Calls: number; Time: number }>;
}

type Phase = "inactive" | "tracking";

async function counters(session: Sql) {
  await session`SELECT pg_stat_force_next_flush()`;
  const [counts] =
    await session`SELECT coalesce(toast_blks_hit,0)::text AS toast_hits,
    coalesce(toast_blks_read,0)::text AS toast_reads FROM pg_statio_user_tables
    WHERE relid='public.progressive_worker_reports'::regclass`;
  return { hits: Number(counts.toast_hits), reads: Number(counts.toast_reads) };
}

export async function measureWorkerStagingWrites(
  pg: Sql,
  job: string,
  pendingSequence: number,
  originalText: string,
  statusText: string,
  phase: Phase,
  representation: "inline" | "normalized",
) {
  const session = await pg.reserve();
  // This is the same scientific input and stable owner for both layouts.
  // Each measured statement rolls back; the durable pending member is left to the normal ACK.
  const [template] =
    await session`SELECT jsonb_set(${originalText}::text::jsonb,'{sequence}',to_jsonb(9001))::text AS body`;
  const report = String(template.body);
  const sig = createHash("sha256")
    .update(canonicalReportJson(parseReportJson(report)))
    .digest("hex");
  const insert =
    "INSERT INTO public.progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at) " +
    "VALUES($1::uuid,9001,$2,$3::text::jsonb,";
  const [status] =
    await session`SELECT jsonb_set(${statusText}::text::jsonb,'{sequence}',to_jsonb(9001))::text AS body`;
  const statusSig = createHash("sha256")
    .update(canonicalReportJson(parseReportJson(status.body)))
    .digest("hex");
  const trials = [
    {
      name: "acknowledged-status-insert",
      stmt: insert + "clock_timestamp())",
      args: [job, statusSig, String(status.body)],
      calls: 1,
    },

    {
      name: "insert-pending",
      stmt: insert + "NULL)",
      args: [job, sig, report],
      calls: 0,
    },
    {
      name: "insert-acknowledged",
      stmt: insert + "clock_timestamp())",
      args: [job, sig, report],
      calls: 1,
    },
    {
      name: "first-ack",
      stmt: "UPDATE public.progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=$1 AND sequence=$2",
      args: [job, pendingSequence],
      calls: 1,
    },
    {
      name: "repeated-ack",
      stmt: "UPDATE public.progressive_worker_reports SET acknowledged_at=coalesce(acknowledged_at,clock_timestamp()) WHERE sim_job_id=$1 AND sequence=2",
      args: [job],
      calls: 0,
    },
    {
      name: "unchanged-created-at",
      stmt: "UPDATE public.progressive_worker_reports SET created_at=created_at WHERE sim_job_id=$1 AND sequence=2",
      args: [job],
      calls: 0,
    },
    {
      name: "unchanged-body",
      stmt: "UPDATE public.progressive_worker_reports SET report=report WHERE sim_job_id=$1 AND sequence=2",
      args: [job],
      calls: 0,
    },
    {
      name: "unchanged-payload-pointer",
      stmt: "UPDATE public.progressive_worker_reports SET result_payload_hash=result_payload_hash WHERE sim_job_id=$1 AND sequence=2",
      args: [job],
      calls: 0,
    },
    {
      name: "ordered-read",
      stmt: "SELECT sequence,created_at,stopped_engine_job_id FROM public.progressive_worker_staging_candidates WHERE sim_job_id=$1 ORDER BY sequence LIMIT 8",
      args: [job],
      calls: 0,
    },
  ];
  const out = [];
  try {
    for (const iteration of [0, 1, 2])
      for (const t of trials) {
        const before = await counters(session);
        await session`BEGIN`;
        let plan: ExecutedPlan;
        let keyWrites = 0;
        let cpuMs: number;
        try {
          const [start] =
            await session`SELECT split_part(pg_read_file('/proc/self/schedstat',0,256),' ',1) AS cpu`;
          const [measured] = await session.unsafe(
            "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) " + t.stmt,
            t.args,
          );
          const [finish] =
            await session`SELECT split_part(pg_read_file('/proc/self/schedstat',0,256),' ',1) AS cpu`;
          cpuMs = Number(BigInt(finish.cpu) - BigInt(start.cpu)) / 1e6;
          plan = measured["QUERY PLAN"][0];
          const [writing] =
            await session`SELECT (n_tup_ins+n_tup_upd+n_tup_del)::int AS writes
            FROM pg_stat_xact_user_tables WHERE relid='public.progressive_worker_staging_keys'::regclass`;
          keyWrites = writing.writes;
        } finally {
          await session`ROLLBACK`;
        }
        const after = await counters(session);
        const triggers = (plan.Triggers ?? []) as Array<{
          "Trigger Name": string;
          Calls: number;
          Time: number;
        }>;
        const tracking = triggers.filter((x) =>
          x["Trigger Name"].startsWith("progressive_worker_staging_key_"),
        );
        const calls = tracking.reduce((sum, t) => sum + t.Calls, 0);
        expect(calls, `${phase} ${representation} ${t.name}`).toBe(
          phase === "tracking" ? t.calls : 0,
        );
        expect(keyWrites).toBe(
          phase === "tracking" &&
            (t.name === "first-ack" || t.name === "insert-acknowledged")
            ? 1
            : 0,
        );
        out.push({
          phase,
          representation,
          iteration,
          operation: t.name,
          ms: plan["Execution Time"],
          cpuMs,
          trackingCalls: calls,
          keyWrites,
          trackingMs: tracking.reduce((sum, t) => sum + t.Time, 0),
          sourceToastHits: after.hits - before.hits,
          sourceToastReads: after.reads - before.reads,
          hit: plan.Plan["Shared Hit Blocks"],
          read: plan.Plan["Shared Read Blocks"],
        });
      }
    let firstAckLookup: Record<string, unknown> | undefined;
    if (phase === "tracking" && representation === "inline") {
      await session`BEGIN`;
      try {
        await session`SET LOCAL enable_seqscan=off`;
        await session`UPDATE public.progressive_worker_reports SET acknowledged_at=clock_timestamp()
          WHERE sim_job_id=${job} AND sequence=${pendingSequence}`;
        const [source] =
          await session`SELECT created_at::text AS time FROM public.progressive_worker_reports
          WHERE sim_job_id=${job} AND sequence=${pendingSequence}`;
        const [observed] =
          await session`EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON) SELECT 1 FROM public.progressive_worker_reports r
          WHERE (r.sim_job_id,r.sequence,r.created_at)=(${job}::uuid,${pendingSequence}::bigint,${source.time}::timestamptz)
            AND r.acknowledged_at IS NOT NULL AND jsonb_typeof(r.report->'result')='object'`;
        const plan = observed["QUERY PLAN"][0].Plan;
        firstAckLookup = {
          node: plan["Node Type"],
          index: plan["Index Name"],
          loops: plan["Actual Loops"],
          rows: plan["Actual Rows"],
          heapFetches: plan["Heap Fetches"],
          filter: plan.Filter ?? null,
        };
        expect(firstAckLookup.rows).toBe(1);
      } finally {
        await session`ROLLBACK`;
      }
    }
    return {
      phase,
      representation,
      source: reportTextIdentity(originalText),
      firstAckLookup,
      samples: out,
    };
  } finally {
    session.release();
  }
}

/** Fixed-row crossover. Unlike the mixed insert/ACK batch above, this interval
 * adds no TOAST values between layouts. The real ACK also executes its ordinary
 * owner check and notification. This database has exactly one worker SQL pool. */
export async function measureExistingWorkerReport(
  pg: Sql,
  job: string,
  seq: number,
  setTracking: (enabled: boolean) => Promise<void>,
  acknowledge: () => Promise<void>,
) {
  const result: Array<{
    step: number;
    tracked: boolean;
    operation: string;
    cpuMs: number;
    toastHits: number;
    toastReads: number;
    toastHeapBytes: string;
    toastIndexBytes: string;
    trackingCalls: number;
    keyWrites: number;
  }> = [];
  await pg`SET track_functions='pl'`;
  async function snapshot() {
    await pg`SELECT pg_stat_force_next_flush()`;
    const [r] =
      await pg`SELECT pg_backend_pid() AS pid,split_part(pg_read_file('/proc/self/schedstat',0,256),' ',1) AS cpu,
      r.toast_blks_hit::text AS hits,r.toast_blks_read::text AS reads,
      pg_relation_size(c.reltoastrelid)::text AS toast_heap,pg_indexes_size(c.reltoastrelid)::text AS toast_indexes,
      coalesce((SELECT calls FROM pg_stat_user_functions WHERE funcid='public.maintain_progressive_worker_staging_key()'::regprocedure),0)::text AS calls,
      (SELECT (n_tup_ins+n_tup_upd+n_tup_del)::text FROM pg_stat_user_tables WHERE relid='public.progressive_worker_staging_keys'::regclass) AS writes
      FROM pg_statio_user_tables r JOIN pg_class c ON c.oid=r.relid WHERE r.relid='public.progressive_worker_reports'::regclass`;
    return r;
  }
  try {
    // Counterbalance any slow drift in buffer residency and backend load.
    for (const [step, tracked] of [
      false,
      true,
      true,
      false,
      true,
      false,
      false,
      true,
    ].entries()) {
      await setTracking(tracked);
      const statements = [
        ["normal-ack-replay", acknowledge],
        [
          "update-ack-to-itself",
          async () => {
            await pg`UPDATE public.progressive_worker_reports SET acknowledged_at=acknowledged_at WHERE sim_job_id=${job} AND sequence=${seq}`;
          },
        ],
        [
          "unchanged-created-at",
          async () => {
            await pg`UPDATE public.progressive_worker_reports SET created_at=created_at WHERE sim_job_id=${job} AND sequence=${seq}`;
          },
        ],
        [
          "unchanged-body",
          async () => {
            await pg`UPDATE public.progressive_worker_reports SET report=report WHERE sim_job_id=${job} AND sequence=${seq}`;
          },
        ],
      ] as const;
      for (const [operation, execute] of statements) {
        const before = await snapshot();
        await execute();
        const after = await snapshot();
        expect(after.pid).toBe(before.pid);
        expect(after.calls).toBe(before.calls);
        expect(after.writes).toBe(before.writes);
        result.push({
          step,
          tracked,
          operation,
          cpuMs: Number(BigInt(after.cpu) - BigInt(before.cpu)) / 1e6,
          toastHits: Number(after.hits) - Number(before.hits),
          toastReads: Number(after.reads) - Number(before.reads),
          toastHeapBytes: after.toast_heap,
          toastIndexBytes: after.toast_indexes,
          trackingCalls: Number(after.calls) - Number(before.calls),
          keyWrites: Number(after.writes) - Number(before.writes),
        });
      }
    }
  } finally {
    await pg`RESET track_functions`;
    await setTracking(false);
  }
  expect(
    new Set(result.map((row) => row.toastHeapBytes + "/" + row.toastIndexBytes))
      .size,
  ).toBe(1);
  for (const operation of new Set(result.map((row) => row.operation))) {
    const accesses = (active: boolean) =>
      result
        .filter((row) => row.operation === operation && row.tracked === active)
        .map((row) => row.toastHits + row.toastReads)
        .sort((a, b) => a - b);
    const control = accesses(false),
      enabled = accesses(true);
    expect(control).toHaveLength(4);
    expect(enabled).toHaveLength(4);
    // A persistent extra report detoast cannot disappear among the four
    // interleaved samples. Hits + reads is independent of buffer residency.
    expect((enabled[1]! + enabled[2]!) / 2, operation).toBeLessThanOrEqual(
      Math.max(...control),
    );
  }
  return result;
}
