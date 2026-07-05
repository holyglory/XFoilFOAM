// Solved-points viewer API (Solver page redesign, screen 5): the newest REAL
// solved results across all jobs (or scoped to one sim job), keyset-paged on
// (solvedAt DESC, id DESC). Only rows the solver actually produced are listed
// (status='done', source='solved', solvedAt set) — derived/mirrored display
// points never appear here, and solvedToday is a real indexed count for the
// current server day, always computed over the same scope as the rows it
// accompanies.
import { airfoils, resultClassifications, results } from "@aerodb/db";
import { and, count, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import { db } from "./db";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cursor format: `${solvedAtISO}|${resultId}` (the sort key of the last row
 *  of the previous page). Returns null for any malformed value. */
export function parseSolvedPointsCursor(raw: string): { solvedAt: Date; id: string } | null {
  const sep = raw.lastIndexOf("|");
  if (sep <= 0) return null;
  const ts = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const solvedAt = new Date(ts);
  if (Number.isNaN(solvedAt.getTime()) || !UUID_RE.test(id)) return null;
  return { solvedAt, id };
}

const querySchema = z.object({
  jobId: z.string().uuid().optional(),
  cursor: z.string().min(3).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function registerSolvedPointsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/solved-points", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query — expected { jobId? uuid, cursor?, limit 1..50 }" });
    }
    const { jobId, cursor: rawCursor, limit } = parsed.data;
    const cursor = rawCursor == null ? null : parseSolvedPointsCursor(rawCursor);
    if (rawCursor != null && cursor == null) {
      return reply.code(400).send({ error: "invalid cursor — expected `<solvedAt ISO>|<result uuid>` from a previous page" });
    }

    // Real solved rows only; jobId scopes both the page and solvedToday so the
    // count always describes exactly the rows the popover lists.
    const scopeConditions: SQL[] = [
      eq(results.status, "done"),
      eq(results.source, "solved"),
      isNotNull(results.solvedAt),
    ];
    if (jobId) scopeConditions.push(eq(results.simJobId, jobId));

    const pageConditions = [...scopeConditions];
    if (cursor) {
      pageConditions.push(
        sql`(${results.solvedAt}, ${results.id}) < (${cursor.solvedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const [rows, [today]] = await Promise.all([
      db
        .select({
          resultId: results.id,
          simJobId: results.simJobId,
          airfoilSlug: airfoils.slug,
          airfoilName: airfoils.name,
          aoaDeg: results.aoaDeg,
          speed: results.speed,
          reynolds: results.reynolds,
          cl: results.cl,
          cd: results.cd,
          clCd: results.clCd,
          classificationState: resultClassifications.state,
          solvedAt: results.solvedAt,
        })
        .from(results)
        .innerJoin(airfoils, eq(airfoils.id, results.airfoilId))
        .leftJoin(resultClassifications, eq(resultClassifications.resultId, results.id))
        .where(and(...pageConditions))
        .orderBy(desc(results.solvedAt), desc(results.id))
        // one extra row detects whether another page exists
        .limit(limit + 1),
      db
        .select({ n: count() })
        .from(results)
        .where(and(...scopeConditions, sql`${results.solvedAt} >= date_trunc('day', now())`)),
    ]);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = rows.length > limit;
    return {
      items: page.map((row) => ({
        resultId: row.resultId,
        simJobId: row.simJobId,
        airfoilSlug: row.airfoilSlug,
        airfoilName: row.airfoilName,
        aoaDeg: row.aoaDeg,
        speed: row.speed == null ? null : Number(row.speed),
        reynolds: row.reynolds == null ? null : Number(row.reynolds),
        cl: row.cl == null ? null : Number(row.cl),
        cd: row.cd == null ? null : Number(row.cd),
        clCd: row.clCd == null ? null : Number(row.clCd),
        classificationState: row.classificationState ?? null,
        // solvedAt is non-null by the WHERE clause; keep the runtime guard honest.
        solvedAt: row.solvedAt instanceof Date ? row.solvedAt.toISOString() : String(row.solvedAt),
      })),
      nextCursor:
        hasMore && last?.solvedAt != null
          ? `${last.solvedAt instanceof Date ? last.solvedAt.toISOString() : new Date(String(last.solvedAt)).toISOString()}|${last.resultId}`
          : null,
      solvedToday: today?.n ?? 0,
    };
  });
}
