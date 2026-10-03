import { createClient } from "./client";
import type { ProgressiveStorageEvidenceRecoveryScope } from "./progressive-cfd-evidence";
import { recoverProgressiveStorageOnlyEvidence } from "./progressive-storage-evidence-recovery";

const [campaignId, epochId, generationId, planRevisionId, ...args] =
  process.argv.slice(2);
const mode =
  args.find((value) => value === "--dry-run" || value === "--apply") ??
  "--dry-run";
const limitArg = args.find((value) => value.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 32;

if (
  process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver" ||
  !campaignId ||
  !epochId ||
  !generationId ||
  !planRevisionId ||
  !["--dry-run", "--apply"].includes(mode) ||
  !Number.isSafeInteger(limit) ||
  limit < 1 ||
  limit > 128 ||
  args.some(
    (value) =>
      !["--dry-run", "--apply"].includes(value) &&
      !value.startsWith("--limit="),
  )
)
  throw new Error(
    "Usage: recover:progressive-storage-evidence CAMPAIGN_UUID EPOCH_UUID GENERATION_UUID PLAN_REVISION_UUID [--dry-run|--apply] [--limit=1..128] (hub role only)",
  );

const scope: ProgressiveStorageEvidenceRecoveryScope = {
  campaignId,
  epochId,
  generationId,
  planRevisionId,
  stage: 2,
};
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("Progressive storage evidence dry-run rollback");
let result: Awaited<ReturnType<typeof recoverProgressiveStorageOnlyEvidence>>;
try {
  await db
    .transaction(async (transaction) => {
      result = await recoverProgressiveStorageOnlyEvidence(
        transaction as unknown as typeof db,
        scope,
        { limit },
      );
      if (mode === "--dry-run") throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  console.log(JSON.stringify({ mode, scope, limit, result: result! }));
} finally {
  await sql.end();
}
