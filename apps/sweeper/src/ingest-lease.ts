import { simJobs, type DB } from "@aerodb/db";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/** Longer than any one bounded engine HTTP call. Long multi-point/media
 * ingestion renews this lease through ingestResult's existing heartbeat hook.
 */
export const DEFAULT_INGEST_LEASE_MS = 10 * 60_000;

export interface IngestLease {
  jobId: string;
  token: string;
  claimedAt: Date;
  expiresAt: Date;
}

export class IngestLeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`ingest lease lost for sim_job ${jobId}`);
    this.name = "IngestLeaseLostError";
  }
}

export function ingestLeaseOwnedWhere(jobId: string, token: string) {
  return and(
    eq(simJobs.id, jobId),
    eq(simJobs.status, "ingesting"),
    eq(simJobs.ingestLeaseToken, token),
  );
}

/** Atomically claim evidence ingestion without holding a transaction across
 * engine/network/media work. PostgreSQL rechecks the conditional update after
 * a competing writer commits, so exactly one concurrent claimant wins.
 * Existing ingesting work is recoverable only after its durable lease expires;
 * pre-lease rows use updatedAt as a one-duration compatibility grace.
 */
export async function claimJobForIngest(
  db: DB,
  jobId: string,
  opts: {
    token?: string;
    now?: Date;
    leaseMs?: number;
  } = {},
): Promise<IngestLease | null> {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? DEFAULT_INGEST_LEASE_MS;
  const token = opts.token ?? randomUUID();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const legacyCutoff = new Date(now.getTime() - leaseMs);
  const [claimed] = await db
    .update(simJobs)
    .set({
      status: "ingesting",
      finishedAt: null,
      ingestLeaseToken: token,
      ingestLeaseClaimedAt: now,
      ingestLeaseExpiresAt: expiresAt,
    })
    .where(
      and(
        eq(simJobs.id, jobId),
        or(
          inArray(simJobs.status, ["submitted", "running", "failed"]),
          and(
            eq(simJobs.status, "ingesting"),
            or(
              lte(simJobs.ingestLeaseExpiresAt, now),
              and(
                isNull(simJobs.ingestLeaseExpiresAt),
                lte(simJobs.updatedAt, legacyCutoff),
              ),
            ),
          ),
        ),
      ),
    )
    .returning({ id: simJobs.id });
  return claimed
    ? { jobId: claimed.id, token, claimedAt: now, expiresAt }
    : null;
}

/** Extend only the caller's live ownership. False means another process
 * recovered the expired lease (or the job already terminalized); callers must
 * stop writing and let the winner finish the idempotent ingest.
 */
export async function renewIngestLease(
  db: DB,
  lease: Pick<IngestLease, "jobId" | "token">,
  opts: { now?: Date; leaseMs?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(
    now.getTime() + (opts.leaseMs ?? DEFAULT_INGEST_LEASE_MS),
  );
  const [renewed] = await db
    .update(simJobs)
    .set({ ingestLeaseExpiresAt: expiresAt })
    .where(
      and(
        ingestLeaseOwnedWhere(lease.jobId, lease.token),
        gt(simJobs.ingestLeaseExpiresAt, now),
      ),
    )
    .returning({ id: simJobs.id });
  return Boolean(renewed);
}

export async function renewIngestLeaseOrThrow(
  db: DB,
  lease: Pick<IngestLease, "jobId" | "token">,
): Promise<void> {
  if (!(await renewIngestLease(db, lease))) {
    throw new IngestLeaseLostError(lease.jobId);
  }
}

/** Running partial ingestion releases ownership back to engine polling. */
export async function releaseIngestLeaseToRunning(
  db: DB,
  lease: Pick<IngestLease, "jobId" | "token">,
): Promise<boolean> {
  const [released] = await db
    .update(simJobs)
    .set({
      status: "running",
      finishedAt: null,
      ingestLeaseToken: null,
      ingestLeaseClaimedAt: null,
      ingestLeaseExpiresAt: null,
    })
    .where(ingestLeaseOwnedWhere(lease.jobId, lease.token))
    .returning({ id: simJobs.id });
  return Boolean(released);
}
