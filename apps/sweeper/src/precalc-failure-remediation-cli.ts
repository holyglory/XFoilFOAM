import {
  createClient,
  databaseUrl,
  remediatePrecalcEvidenceContract,
  requeueRestartablePrecalcContinuations,
  type PrecalcContractEvaluation,
} from "@aerodb/db";
import { readFile } from "node:fs/promises";

interface EvaluationRow {
  obligation_id: unknown;
  result_attempt_id: unknown;
  recommended_action: unknown;
  statistical_mean_score: unknown;
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const path = option("--evaluation");
const sourceRevision = option("--source-revision");
const execute = process.argv.includes("--execute");
if (!path || !sourceRevision) {
  throw new Error(
    "usage: --evaluation <jsonl> --source-revision <40-char-sha> [--execute]",
  );
}
const rows = (await readFile(path, "utf8"))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as EvaluationRow);
const continuationIds: string[] = [];
const physical: PrecalcContractEvaluation[] = [];
for (const row of rows) {
  if (typeof row.obligation_id !== "string") {
    throw new Error("every evaluation row must carry obligation_id");
  }
  const resultAttemptId =
    typeof row.result_attempt_id === "string" ? row.result_attempt_id : null;
  const score =
    typeof row.statistical_mean_score === "number"
      ? row.statistical_mean_score
      : 0;
  if (row.recommended_action === "continue_exact_case") {
    continuationIds.push(row.obligation_id);
    continue;
  }
  if (
    row.recommended_action !== "rerun_statistical_mean_contract" &&
    row.recommended_action !== "rerun_conservative_numerics"
  ) {
    throw new Error(
      `unsupported evaluator action ${String(row.recommended_action)}`,
    );
  }
  physical.push({
    obligationId: row.obligation_id,
    resultAttemptId,
    action: row.recommended_action,
    statisticalMeanScore: score,
  });
}

const { db, sql: client } = createClient({ url: databaseUrl(), max: 2 });
try {
  let continued: string[] = [];
  const fallback: PrecalcContractEvaluation[] = [];
  if (execute && continuationIds.length) {
    const recovery = await requeueRestartablePrecalcContinuations(db, {
      obligationIds: continuationIds,
    });
    continued = recovery.obligationIds;
    const continuedSet = new Set(continued);
    for (const row of rows) {
      if (
        row.recommended_action === "continue_exact_case" &&
        typeof row.obligation_id === "string" &&
        !continuedSet.has(row.obligation_id)
      ) {
        fallback.push({
          obligationId: row.obligation_id,
          resultAttemptId:
            typeof row.result_attempt_id === "string"
              ? row.result_attempt_id
              : null,
          action: "rerun_fresh",
          statisticalMeanScore: 0,
        });
      }
    }
  }
  const remediation = await remediatePrecalcEvidenceContract(db, {
    evaluations: [...physical, ...fallback],
    sourceRevision,
    execute,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: execute ? "execute" : "dry_run",
        evaluated: rows.length,
        continuationCandidates: continuationIds.length,
        continuationsReopened: continued,
        continuationFallbacks: fallback.map((row) => row.obligationId),
        remediation,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.end();
}
