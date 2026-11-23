import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { createClient, type Sql } from "./client";

type Connection = postgres.ReservedSql;
type Phase = "present" | "retiring" | "retired" | "restoring";
interface State {
  tracking_instance_id: string | null;
  complete: boolean;
  reads_enabled: boolean;
  index_phase: Phase;
  parity_checked_at: Date | null;
  parity_count: string | null;
  retirement_revision: string | null;
  tracking_signature: string | null;
}
const objectPredicate =
  "((acknowledged_at IS NOT NULL) AND (jsonb_typeof((report -> 'result'::text)) = 'object'::text)";
const ownedIndexes = [
  {
    suffix: "staging_order_idx",
    columns: ["created_at", "sim_job_id", "sequence"],
  },
  {
    suffix: "terminal_staging_order_idx",
    columns: ["created_at", "sim_job_id", "sequence"],
    terminal: true,
  },
  {
    suffix: "staging_job_order_idx",
    columns: ["sim_job_id", "created_at", "sequence"],
  },
  // Keep the covering bootstrap and verification index until the last step.
  {
    suffix: "staging_candidate_idx",
    columns: ["sim_job_id", "sequence", "created_at"],
  },
] as const;
type OldIndex = (typeof ownedIndexes)[number];
const nameOf = (index: OldIndex) =>
  "progressive_worker_reports_" + index.suffix;
const predicateOf = (index: OldIndex) =>
  objectPredicate +
  ("terminal" in index ? " AND (stopped_engine_job_id IS NOT NULL))" : ")");

async function readState(session: Connection): Promise<State> {
  const [state] = await session<State[]>`SELECT s.tracking_instance_id::text,
    coalesce(s.complete,false) complete,coalesce(s.reads_enabled,false) reads_enabled,
    coalesce(s.index_phase,'present') index_phase,s.parity_checked_at,s.parity_count::text,
    s.retirement_revision,s.tracking_signature FROM (VALUES(true)) seed(singleton)
    LEFT JOIN public.progressive_worker_staging_key_backfill s USING(singleton)`;
  return state;
}

async function transaction<T>(
  session: Connection,
  readOnly: boolean,
  action: () => Promise<T>,
): Promise<T> {
  await session.unsafe(
    "BEGIN ISOLATION LEVEL REPEATABLE READ" + (readOnly ? " READ ONLY" : ""),
  );
  try {
    const result = await action();
    await session`COMMIT`;
    return result;
  } catch (error) {
    await session`ROLLBACK`;
    throw error;
  }
}

export async function backfillWorkerStagingKeyPage(
  client: Sql,
  limit = 128,
  instance?: string,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
    throw new RangeError("Staging key page size must be between 1 and 512");
  try {
    if (instance)
      await client`SELECT public.start_progressive_worker_staging_key_tracking(${instance}::uuid)`;
    const [r] = await client.begin(
      "isolation level repeatable read",
      async (tx) =>
        tx<{ visited: number; changed: number; complete: boolean }[]>`
        SELECT * FROM public.backfill_progressive_worker_staging_keys(${limit})`,
    );
    return { busy: false, ...r };
  } catch (error) {
    // NOWAIT or a changed tuple. PostgreSQL rolled back the page and cursor.
    if (
      ["55P03", "40001"].includes(String((error as { code?: unknown })?.code))
    ) {
      return { busy: true, visited: 0, changed: 0, complete: false };
    }
    throw error;
  }
}

async function verifyRows(session: Connection): Promise<number> {
  if (!(await readState(session)).complete)
    throw new Error("Staging key bootstrap is incomplete");
  let job = "00000000-0000-0000-0000-000000000000";
  let sequence = "0";
  let total = 0;
  for (;;) {
    // Compare exact timestamps and the *actual* stop ID in PostgreSQL, including
    // foreign stop IDs. Read both ordered pages from one snapshot. No report
    // body and no JavaScript timestamp rounding enter this comparison.
    const [r] = await session<
      { bad: boolean; n: number; job: string | null; seq: string | null }[]
    >`
      WITH original AS MATERIALIZED (
        SELECT c.sim_job_id,c.sequence,c.created_at,r.stopped_engine_job_id
        FROM public.progressive_worker_staging_key_page(${job}::uuid,${sequence}::bigint,512) c
        CROSS JOIN LATERAL (SELECT p.stopped_engine_job_id FROM public.progressive_worker_reports p
          WHERE p.sim_job_id=c.sim_job_id AND p.sequence=c.sequence LIMIT 1) r),
      projected AS MATERIALIZED (SELECT sim_job_id,sequence,created_at,stopped_engine_job_id
        FROM public.progressive_worker_staging_keys WHERE (sim_job_id,sequence)>(${job}::uuid,${sequence}::bigint)
        ORDER BY sim_job_id,sequence LIMIT 512),
      missing AS (TABLE original EXCEPT ALL TABLE projected),
      extra AS (TABLE projected EXCEPT ALL TABLE original)
      SELECT EXISTS(TABLE missing) OR EXISTS(TABLE extra) bad,(SELECT count(*)::int FROM original) n,
        t.sim_job_id::text job,t.sequence::text seq FROM (VALUES(1)) seed(n)
        LEFT JOIN LATERAL (SELECT sim_job_id,sequence FROM original ORDER BY sim_job_id DESC,sequence DESC LIMIT 1)t ON true`;
    if (r.bad)
      throw new Error(
        "Staging key membership, creation time or stop identity differs",
      );
    if (!r.n) return total;
    if (!r.job || !r.seq)
      throw new Error("Staging key verification lost its cursor");
    job = r.job;
    sequence = r.seq;
    total += r.n;
  }
}

async function indexShape(session: Connection, name: string) {
  const [row] = await session`SELECT tbl.relname AS owner,am.amname,
    i.indisunique,i.indisprimary,i.indisreplident,i.indisclustered,
    i.indisvalid AND i.indisready AND i.indislive AS usable,
    pg_get_expr(i.indpred,i.indrelid) AS predicate,
    (i.indexprs IS NULL AND i.indnatts=i.indnkeyatts AND idx.reloptions IS NULL AND idx.reltablespace=0) AS ordinary,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,p,true) FROM generate_series(1,i.indnatts) p ORDER BY p) AS columns
    FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid JOIN pg_class tbl ON tbl.oid=i.indrelid
    JOIN pg_am am ON am.oid=idx.relam
    WHERE idx.relnamespace='public'::regnamespace AND tbl.relnamespace='public'::regnamespace AND idx.relname=${name}`;
  return row;
}

async function replacementFingerprint(session: Connection) {
  const [proof] =
    await session`SELECT pg_get_functiondef('public.maintain_progressive_worker_staging_key()'::regprocedure) AS fn,
    pg_get_viewdef('public.progressive_worker_staging_candidates'::regclass) AS view,
    (SELECT array_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t
      WHERE t.tgrelid='public.progressive_worker_reports'::regclass AND t.tgenabled IN ('O','A')
      AND t.tgname IN ('progressive_worker_staging_key_ack','progressive_worker_staging_key_insert')
      AND t.tgfoid='public.maintain_progressive_worker_staging_key()'::regprocedure) AS triggers`;
  if (proof.triggers?.length !== 2)
    throw new Error("Staging key triggers are missing or disabled");
  return createHash("sha256")
    .update(JSON.stringify([proof.fn, proof.triggers, proof.view]))
    .digest("hex");
}

async function oldUsable(
  session: Connection,
  index: OldIndex,
): Promise<boolean | undefined> {
  const name = nameOf(index);
  const r = await indexShape(session, name);
  if (!r) {
    const [occupied] =
      await session`SELECT to_regclass(${"public." + name}) IS NOT NULL AS present`;
    if (occupied.present) throw new Error("Unexpected object occupies " + name);
    return undefined;
  }
  if (
    !r.ordinary ||
    r.owner !== "progressive_worker_reports" ||
    r.amname !== "btree" ||
    r.indisprimary ||
    r.indisunique ||
    r.indisreplident ||
    r.indisclustered ||
    JSON.stringify(r.columns) !== JSON.stringify(index.columns) ||
    r.predicate !== predicateOf(index)
  )
    throw new Error("Source staging index definition differs: " + name);
  return r.usable === true;
}

async function verifyKeyCatalog(session: Connection) {
  const [source] = await session`SELECT
    public.progressive_worker_staging_key_tracking_enabled() AS tracking,
    EXISTS(SELECT FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
      WHERE r.ev_class='public.progressive_worker_staging_candidates'::regclass AND d.refclassid='pg_class'::regclass
      AND d.refobjid='public.progressive_worker_staging_keys'::regclass) AS key_view`;
  if (!source.tracking || !source.key_view)
    throw new Error(
      "Active staging view and tracking trigger are required for retirement",
    );
  const indexes = [
    ["pkey", ["sim_job_id", "sequence"], null],
    ["order_idx", ["created_at", "sim_job_id", "sequence"], null],
    ["job_order_idx", ["sim_job_id", "created_at", "sequence"], null],
    [
      "terminal_order_idx",
      ["created_at", "sim_job_id", "sequence"],
      "(stopped_engine_job_id IS NOT NULL)",
    ],
  ] as const;
  for (const [suffix, columns, predicate] of indexes) {
    const name = "progressive_worker_staging_keys_" + suffix;
    const r = await indexShape(session, name);
    if (
      !r?.usable ||
      !r.ordinary ||
      r.owner !== "progressive_worker_staging_keys" ||
      r.amname !== "btree" ||
      r.indisprimary !== (suffix === "pkey") ||
      JSON.stringify(r.columns) !== JSON.stringify(columns) ||
      r.predicate !== predicate
    ) {
      throw new Error(
        "Replacement staging index is missing, invalid or different: " + name,
      );
    }
  }
}

export type StagingKeyOperation =
  | "status"
  | "start"
  | "stop"
  | "verify"
  | "enable"
  | "disable"
  | "retire"
  | "restore";

async function switchReads(session: Connection, enabled: boolean) {
  // CREATE OR REPLACE VIEW needs an exclusive lock. Bound how long new polls
  // can queue behind it when a previous read is still running. Keep a tighter
  // operator setting, and let the enclosing transaction restore it on exit.
  await session`SELECT set_config('lock_timeout','250ms',true) FROM pg_settings
    WHERE name='lock_timeout' AND (setting::integer=0 OR setting::integer>250)`;
  await session`SELECT public.set_progressive_worker_staging_key_reads(${enabled})`;
}

export async function maintainWorkerStagingKeys(
  client: Sql,
  operation: StagingKeyOperation,
  options: { instance?: string; readersRevision?: string } = {},
) {
  const session = await client.reserve();
  let locked = false;
  try {
    await session`SET search_path=pg_catalog,public`;
    if (operation === "status") return await readState(session);
    if (operation === "verify")
      return {
        matched: await transaction(session, true, () => verifyRows(session)),
      };
    const [target] = await session`SELECT instance_id::text AS id,
      remote_solver_enabled AND remote_solver_registered_id IS NOT NULL AS registered_worker
      FROM public.sync_api_settings WHERE id=1`;
    if (!options.instance || options.instance !== target?.id)
      throw new Error("Expected the exact registered worker instance");
    const [lock] = await session`SELECT pg_try_advisory_lock(218,1) AS held`;
    if (!lock.held)
      throw new Error("Another staging key maintenance is active");
    locked = true;
    let state = await readState(session);
    if (
      state.tracking_instance_id &&
      options.instance !== state.tracking_instance_id
    )
      throw new Error("Staging key tracking belongs to another instance");
    const rollingBack =
      operation === "restore" ||
      operation === "disable" ||
      operation === "stop";
    if (
      !target.registered_worker &&
      !(rollingBack && state.tracking_instance_id === options.instance)
    )
      throw new Error("Expected the exact registered worker instance");
    if (operation === "start") {
      await session`SELECT public.start_progressive_worker_staging_key_tracking(${options.instance}::uuid)`;
    } else if (operation === "stop") {
      await session`SELECT public.stop_progressive_worker_staging_key_tracking(${options.instance}::uuid)`;
    } else if (operation === "disable") {
      for (const i of ownedIndexes)
        if (!(await oldUsable(session, i)))
          throw new Error(
            "Restore source staging indexes before disabling key reads",
          );
      await transaction(session, false, () => switchReads(session, false));
    } else if (operation === "enable") {
      if (!state.reads_enabled)
        await transaction(session, false, async () => {
          const count = await verifyRows(session);
          await session`UPDATE public.progressive_worker_staging_key_backfill SET parity_count=${count},parity_checked_at=clock_timestamp() WHERE singleton`;
          await switchReads(session, true);
        });
    } else {
      if (!state.reads_enabled || !state.complete)
        throw new Error(
          "Enable verified key reads before changing source indexes",
        );
      if (operation === "retire") await verifyKeyCatalog(session);
      const tracking =
        operation === "retire" ? await replacementFingerprint(session) : null;
      if (
        operation === "retire" &&
        state.index_phase !== "present" &&
        tracking !== state.tracking_signature
      )
        throw new Error(
          "The staging trigger or active read view changed since retirement verification",
        );
      // Inspect every name before the first concurrent DDL. An interrupted
      // concurrent operation can leave an invalid but otherwise exact index.
      for (const i of ownedIndexes) {
        const usable = await oldUsable(session, i);
        if (state.index_phase === "present" && !usable)
          throw new Error(
            "Unexpected source index gap before retirement: " + nameOf(i),
          );
      }
      if (operation === "retire") {
        if (
          !options.readersRevision ||
          !/^[0-9a-f]{40}$/.test(options.readersRevision)
        )
          throw new Error("Pin the deployed reader revision for retirement");
        if (state.index_phase === "restoring")
          throw new Error("Finish restoring the source indexes first");
        if (state.index_phase === "present") {
          await transaction(session, false, async () => {
            const matched = await verifyRows(session);
            await session`UPDATE public.progressive_worker_staging_key_backfill SET index_phase='retiring',
              retirement_revision=${options.readersRevision!},tracking_signature=${tracking},parity_count=${matched},parity_checked_at=clock_timestamp() WHERE singleton`;
          });
        } else if (
          state.retirement_revision !== options.readersRevision ||
          state.parity_count === null
        ) {
          throw new Error(
            "The interrupted retirement belongs to a different reader revision or lacks its parity proof",
          );
        }
        for (const i of ownedIndexes)
          if ((await oldUsable(session, i)) !== undefined) {
            await session.unsafe("DROP INDEX CONCURRENTLY public." + nameOf(i));
          }
        await session`UPDATE public.progressive_worker_staging_key_backfill SET index_phase='retired' WHERE singleton`;
      } else if (state.index_phase !== "present") {
        await session`UPDATE public.progressive_worker_staging_key_backfill SET index_phase='restoring' WHERE singleton`;
        for (const i of [...ownedIndexes].reverse()) {
          const exists = await oldUsable(session, i);
          if (exists === true) continue;
          if (exists === false)
            await session.unsafe("DROP INDEX CONCURRENTLY public." + nameOf(i));
          await session.unsafe(
            "CREATE INDEX CONCURRENTLY " +
              nameOf(i) +
              " ON public.progressive_worker_reports (" +
              i.columns.join(",") +
              ") WHERE " +
              predicateOf(i),
          );
          if (!(await oldUsable(session, i)))
            throw new Error(
              "Source staging index restoration failed: " + nameOf(i),
            );
        }
        await transaction(session, false, async () => {
          const matched = await verifyRows(session);
          await session`UPDATE public.progressive_worker_staging_key_backfill SET index_phase='present',
            parity_count=${matched},parity_checked_at=clock_timestamp() WHERE singleton`;
        });
      }
    }
    state = await readState(session);
    return state;
  } finally {
    try {
      if (locked) await session`SELECT pg_advisory_unlock(218,1)`;
    } finally {
      try {
        await session`RESET search_path`;
      } finally {
        session.release();
      }
    }
  }
}

async function runCli() {
  const [operation = "status", instance, parameter] = process.argv.slice(2);
  const { sql } = createClient({ max: 1 });
  try {
    if (operation === "backfill") {
      const limit = parameter === undefined ? 128 : Number(parameter);
      const [host] =
        await sql`SELECT instance_id::text AS id FROM public.sync_api_settings
        WHERE id=1 AND remote_solver_enabled AND remote_solver_registered_id IS NOT NULL`;
      if (!instance || instance !== host?.id)
        throw new Error("Expected the exact registered worker instance");
      console.log(
        JSON.stringify(
          await backfillWorkerStagingKeyPage(sql, limit, instance),
        ),
      );
    } else {
      if (
        ![
          "status",
          "start",
          "stop",
          "verify",
          "enable",
          "disable",
          "retire",
          "restore",
        ].includes(operation)
      )
        throw new Error("Unknown staging key operation");
      console.log(
        JSON.stringify(
          await maintainWorkerStagingKeys(
            sql,
            operation as StagingKeyOperation,
            { instance, readersRevision: parameter },
          ),
        ),
      );
    }
  } finally {
    await sql.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runCli().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
