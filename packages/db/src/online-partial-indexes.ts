import type postgres from "postgres";
import type { Sql } from "./client";

export interface NonNullIndex {
  table: string;
  column: string;
  name: string;
}
type IndexAction = { name: string; action: "existing" | "created" | "rebuilt" };

async function inspect(
  session: postgres.ReservedSql,
  name: string,
  definition: string,
) {
  const [index] =
    await session`SELECT CASE WHEN c.relkind='i' THEN pg_catalog.pg_get_indexdef(c.oid) END AS definition,
      i.indisvalid AND i.indisready AND i.indislive AS usable,
      i.indisreplident OR i.indisclustered OR i.indisexclusion OR EXISTS
        (SELECT FROM pg_catalog.pg_constraint k WHERE k.conindid=c.oid) AS protected
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND c.relname=${name}`;
  if (index && (index.definition !== definition || index.protected))
    throw new Error(
      `Existing public.${name} differs from required index definition`,
    );
  return index;
}

type PartialIndex = {
  table: string;
  name: string;
  columns: readonly string[];
  predicate: string;
};

export function prepareNonNullIndexes(
  sql: Sql,
  migration: number,
  specs: readonly NonNullIndex[],
) {
  const indexes = specs.map(({ table, name, column }) => ({
    table,
    name,
    columns: [column],
    predicate: `(${column} IS NOT NULL)`,
  }));
  return preparePartialIndexes(sql, migration, indexes);
}

export function preparePreciseCandidateIndex(sql: Sql) {
  return preparePartialIndexes(sql, 226, [
    {
      table: "result_attempts",
      name: "result_attempts_precise_candidate_idx",
      columns: ["id", "result_id", "sim_job_id"],
      predicate:
        "((status = 'done'::result_status) AND valid_for_polar AND " +
        "((regime = 'rans'::regime) OR ((evidence_payload ->> 'fidelity'::text) = 'urans_full'::text)))",
    },
  ]);
}

/** Use one autocommit backend, including the family lock. Only repair an
 * invalid index whose complete catalog definition belongs to this family. */
async function preparePartialIndexes(
  sql: Sql,
  migration: number,
  specs: readonly PartialIndex[],
) {
  const session = await sql.reserve();
  const indexes: IndexAction[] = [];
  let locked = false,
    tablePresent = false;
  try {
    await session`SELECT pg_advisory_lock(${migration}::int,1)`;
    locked = true;
    for (const { table, columns, name, predicate } of specs) {
      if (![table, ...columns, name].every((s) => /^[a-z][a-z0-9_]{0,62}$/.test(s)))
        throw new Error("Invalid migration index identifier");
      const target = "public." + table;
      const [catalog] =
        await session`SELECT to_regclass(${target}) IS NOT NULL AS present`;
      if (!catalog.present) continue;
      tablePresent = true;
      const suffix = ` ON ${target} USING btree (${columns.join(", ")}) WHERE ${predicate}`;
      const expected = "CREATE INDEX " + name + suffix;
      const index = await inspect(session, name, expected);
      if (index?.usable) {
        indexes.push({ name, action: "existing" });
        continue;
      }
      const [work] =
        await session`SELECT EXISTS(SELECT FROM pg_catalog.pg_stat_progress_create_index WHERE relid=to_regclass(${target})) AS active`;
      if (work.active)
        throw new Error(`Index maintenance is still active on ${target}`);
      if (index) await session.unsafe("DROP INDEX CONCURRENTLY public." + name);
      await session.unsafe("CREATE INDEX CONCURRENTLY " + name + suffix);
      if (!(await inspect(session, name, expected))?.usable)
        throw new Error(`Index public.${name} did not become usable`);
      indexes.push({ name, action: index ? "rebuilt" : "created" });
    }
    return { tablePresent, indexes };
  } finally {
    try {
      if (locked) await session`SELECT pg_advisory_unlock(${migration}::int,1)`;
    } finally {
      session.release();
    }
  }
}
