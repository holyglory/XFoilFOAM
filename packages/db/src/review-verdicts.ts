import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { DB } from "./client";
import { resultReviewVerdicts } from "./schema";

export const REVIEW_VERDICTS = ["waive", "exclude", "defer"] as const;
export type ReviewVerdictValue = (typeof REVIEW_VERDICTS)[number];
export type ActiveReviewVerdictValue = Exclude<ReviewVerdictValue, "defer">;

export type ReviewVerdictRecord = {
  id: string;
  resultId: string;
  verdict: ReviewVerdictValue;
  note: string | null;
  reviewer: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
};

export type ActiveReviewVerdictRecord = ReviewVerdictRecord & {
  verdict: ActiveReviewVerdictValue;
  revokedAt: null;
  revokedBy: null;
};

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type DbTx = DB | Tx;
const asDb = (db: DbTx): DB => db as DB;

function normalizeReviewRow(
  row: typeof resultReviewVerdicts.$inferSelect,
): ReviewVerdictRecord {
  return {
    id: row.id,
    resultId: row.resultId,
    verdict: row.verdict as ReviewVerdictValue,
    note: row.note,
    reviewer: row.reviewer,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
  };
}

function normalizeActiveReviewRow(
  row: typeof resultReviewVerdicts.$inferSelect,
): ActiveReviewVerdictRecord {
  const normalized = normalizeReviewRow(row);
  return {
    ...normalized,
    verdict: normalized.verdict as ActiveReviewVerdictValue,
    revokedAt: null,
    revokedBy: null,
  };
}

export async function activeReviewVerdict(
  db: DbTx,
  resultId: string,
): Promise<ActiveReviewVerdictRecord | null> {
  const [row] = await asDb(db)
    .select()
    .from(resultReviewVerdicts)
    .where(
      and(
        eq(resultReviewVerdicts.resultId, resultId),
        isNull(resultReviewVerdicts.revokedAt),
        inArray(resultReviewVerdicts.verdict, ["waive", "exclude"]),
      ),
    )
    .orderBy(desc(resultReviewVerdicts.createdAt))
    .limit(1);
  return row ? normalizeActiveReviewRow(row) : null;
}

export async function activeReviewVerdicts(
  db: DbTx,
  resultIds: string[],
): Promise<Map<string, ActiveReviewVerdictRecord>> {
  const unique = [...new Set(resultIds.filter(Boolean))];
  const verdicts = new Map<string, ActiveReviewVerdictRecord>();
  if (unique.length === 0) return verdicts;
  const rows = await asDb(db)
    .select()
    .from(resultReviewVerdicts)
    .where(
      and(
        inArray(resultReviewVerdicts.resultId, unique),
        isNull(resultReviewVerdicts.revokedAt),
        inArray(resultReviewVerdicts.verdict, ["waive", "exclude"]),
      ),
    )
    .orderBy(desc(resultReviewVerdicts.createdAt));
  for (const row of rows) {
    if (!verdicts.has(row.resultId))
      verdicts.set(row.resultId, normalizeActiveReviewRow(row));
  }
  return verdicts;
}

export async function reviewVerdictHistory(
  db: DbTx,
  resultId: string,
): Promise<ReviewVerdictRecord[]> {
  const rows = await asDb(db)
    .select()
    .from(resultReviewVerdicts)
    .where(eq(resultReviewVerdicts.resultId, resultId))
    .orderBy(desc(resultReviewVerdicts.createdAt));
  return rows.map(normalizeReviewRow);
}

export async function recordReviewVerdict(
  db: DB,
  input: {
    resultId: string;
    verdict: ReviewVerdictValue;
    note?: string | null;
    reviewer: string;
  },
): Promise<ReviewVerdictRecord> {
  return db.transaction(async (rawTx) => {
    const tx = asDb(rawTx);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`result-review-verdict:${input.resultId}`}, 0))`,
    );

    if (input.verdict === "waive" || input.verdict === "exclude") {
      await tx
        .update(resultReviewVerdicts)
        .set({ revokedAt: new Date(), revokedBy: input.reviewer })
        .where(
          and(
            eq(resultReviewVerdicts.resultId, input.resultId),
            isNull(resultReviewVerdicts.revokedAt),
            inArray(resultReviewVerdicts.verdict, ["waive", "exclude"]),
          ),
        );
    }

    const [row] = await tx
      .insert(resultReviewVerdicts)
      .values({
        resultId: input.resultId,
        verdict: input.verdict,
        note: input.note?.trim() ? input.note.trim() : null,
        reviewer: input.reviewer,
      })
      .returning();
    return normalizeReviewRow(row);
  });
}

export async function revokeActiveReviewVerdict(
  db: DB,
  resultId: string,
  reviewer: string,
): Promise<ReviewVerdictRecord | null> {
  return db.transaction(async (rawTx) => {
    const tx = asDb(rawTx);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`result-review-verdict:${resultId}`}, 0))`,
    );
    const [row] = await tx
      .update(resultReviewVerdicts)
      .set({ revokedAt: new Date(), revokedBy: reviewer })
      .where(
        and(
          eq(resultReviewVerdicts.resultId, resultId),
          isNull(resultReviewVerdicts.revokedAt),
          inArray(resultReviewVerdicts.verdict, ["waive", "exclude"]),
        ),
      )
      .returning();
    return row ? normalizeReviewRow(row) : null;
  });
}
