import type { DB } from "./client";

export const PROGRESSIVE_REPORT_RETENTION_DISABLED =
  "Progressive report history reclamation is disabled: immutable report identities, inventories and progress receipts must be preserved for replay.";

export type ProgressiveReportRetentionResult = {
  selected: number;
  deleted: number;
  bytes: number;
};

/**
 * Keep direct callers fail-closed until reclamation has a verified replay and
 * acknowledgement protocol. Terminal ingestion alone does not make historical
 * report identities disposable. A deleted sequence cannot be replayed through
 * storeProgressiveRemoteReport after a later report exists.
 */
export async function reclaimProgressiveReportHistory(
  _db: DB,
  _input: { campaignId: string; batchSize?: number },
): Promise<ProgressiveReportRetentionResult> {
  throw new Error(PROGRESSIVE_REPORT_RETENTION_DISABLED);
}
