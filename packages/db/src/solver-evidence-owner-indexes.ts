import type postgres from "postgres";
import type { Sql } from "./client";

const table = "public.solver_evidence_artifacts";
const owners = [
  ["solver_evidence_artifacts_sim_job_idx", "sim_job_id"],
  ["solver_evidence_artifacts_engine_job_idx", "engine_job_id"],
] as const;

async function inspect(session: postgres.ReservedSql, name: string, definition: string) {
  const [index] = await session<{
    definition: string | null;
    usable: boolean;
    protected: boolean;
  }[]>`SELECT CASE WHEN c.relkind = 'i' THEN pg_catalog.pg_get_indexdef(c.oid) END AS definition,
           i.indisvalid AND i.indisready AND i.indislive AS usable,
           i.indisreplident OR i.indisclustered OR i.indisexclusion AS protected
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ${name}`;
  if (index && (index.definition !== definition || index.protected))
    throw new Error(`Existing public.${name} differs from the 0222 ownership index`);
  return index;
}

/** PostgreSQL requires a top-level session for concurrent index creation. The
 * migration adopts the verified indexes in its normal journal transaction. */
export async function prepareSolverEvidenceOwnerIndexes(sql: Sql) {
  const session = await sql.reserve();
  let locked = false;
  const indexes: { name: string; action: "existing" | "created" | "rebuilt" }[] = [];
  try {
    const [catalog] = await session`SELECT to_regclass('public.solver_evidence_artifacts') IS NOT NULL AS present`;
    if (!catalog.present) return { tablePresent: false, indexes };
    await session`SELECT pg_advisory_lock(222, 1)`;
    locked = true;
    for (const [name, column] of owners) {
      const target = ` ON ${table} USING btree (${column}) WHERE (${column} IS NOT NULL)`;
      const expected = "CREATE INDEX " + name + target;
      const index = await inspect(session, name, expected);
      if (index?.usable) {
        indexes.push({ name, action: "existing" });
        continue;
      }
      if (index) {
        const [work] = await session`SELECT EXISTS (SELECT FROM pg_catalog.pg_stat_progress_create_index
          WHERE relid = 'public.solver_evidence_artifacts'::regclass) AS active`;
        if (work.active) throw new Error(`Index maintenance is still active on ${table}`);
        await session.unsafe("DROP INDEX CONCURRENTLY public." + name);
      }
      await session.unsafe("CREATE INDEX CONCURRENTLY " + name + target);
      if (!(await inspect(session, name, expected))?.usable)
        throw new Error(`Ownership index public.${name} did not become usable`);
      indexes.push({ name, action: index ? "rebuilt" : "created" });
    }
    return { tablePresent: true, indexes };
  } finally {
    try {
      if (locked) await session`SELECT pg_advisory_unlock(222, 1)`;
    } finally {
      session.release();
    }
  }
}
