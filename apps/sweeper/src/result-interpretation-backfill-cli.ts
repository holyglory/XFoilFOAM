/** Operator entry point for the immutable archive clean-cycle backfill.
 *
 * Without `--execute` this is a strictly read-only planning command.  `--execute`
 * creates a durable run (or resumes one) and processes a bounded number of
 * receipts. It may append a canonical-selection event only for an accepted,
 * current, generation-pinned archive interpretation; it never submits CFD
 * work itself.
 */
import { pathToFileURL } from "node:url";

import {
  cancelArchiveInterpretationBackfillRun,
  createArchiveInterpretationBackfillRun,
  discoverArchiveInterpretationBackfill,
  normaliseArchiveInterpretationBackfillScope,
  routeCampaignPrecalcToFreshAfterArchiveAbandonment,
  runArchiveInterpretationBackfill,
  type ArchiveInterpretationBackfillScope,
} from "./result-interpretation-backfill";
import { makeContext } from "./config";
import { findResultInterpretationReducerVersion } from "./result-interpretations";

interface Args {
  execute: boolean;
  runId: string | null;
  scope: ArchiveInterpretationBackfillScope;
  maxItems: number | undefined;
  requestedBy: string | undefined;
  cancelRunId: string | null;
  cancellationReason: string | undefined;
  freshRerunCampaignId: string | null;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100_000) {
    throw new Error(
      `${label} must be a positive integer no greater than 100000`,
    );
  }
  return parsed;
}

function requiredValue(argv: string[], index: number, label: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${label} requires a value`);
  return value;
}

export function parseArchiveInterpretationBackfillArgs(argv: string[]): Args {
  const scope: ArchiveInterpretationBackfillScope = {
    resultIds: [],
    resultAttemptIds: [],
  };
  const parsed: Args = {
    execute: false,
    runId: null,
    scope,
    maxItems: undefined,
    requestedBy: undefined,
    cancelRunId: null,
    cancellationReason: undefined,
    freshRerunCampaignId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      parsed.execute = true;
      continue;
    }
    const value = requiredValue(argv, index, argument ?? "argument");
    if (argument === "--run-id") parsed.runId = value;
    else if (argument === "--cancel-run") parsed.cancelRunId = value;
    else if (argument === "--reason") parsed.cancellationReason = value;
    else if (argument === "--fresh-rerun-campaign")
      parsed.freshRerunCampaignId = value;
    else if (argument === "--result-id") scope.resultIds!.push(value);
    else if (argument === "--result-attempt-id")
      scope.resultAttemptIds!.push(value);
    else if (argument === "--limit")
      scope.limit = positiveInteger(value, "--limit");
    else if (argument === "--max-items") {
      parsed.maxItems = positiveInteger(value, "--max-items");
    } else if (argument === "--requested-by") {
      parsed.requestedBy = value;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
    index += 1;
  }
  normaliseArchiveInterpretationBackfillScope(scope);
  if (parsed.cancelRunId) {
    if (
      parsed.execute ||
      parsed.runId ||
      scope.resultIds!.length ||
      scope.resultAttemptIds!.length ||
      scope.limit != null ||
      parsed.maxItems != null ||
      parsed.requestedBy != null
    ) {
      throw new Error(
        "--cancel-run can be combined only with one non-empty --reason and optional --fresh-rerun-campaign",
      );
    }
    if (!parsed.cancellationReason?.trim()) {
      throw new Error("--cancel-run requires a non-empty --reason");
    }
  } else if (parsed.freshRerunCampaignId) {
    throw new Error("--fresh-rerun-campaign requires --cancel-run");
  } else if (parsed.cancellationReason != null) {
    throw new Error("--reason requires --cancel-run");
  }
  if (parsed.runId && !parsed.execute) {
    throw new Error(
      "--run-id requires --execute; planning is always read-only",
    );
  }
  if (
    parsed.runId &&
    (scope.resultIds!.length || scope.resultAttemptIds!.length)
  ) {
    throw new Error("--run-id cannot be combined with a new result scope");
  }
  return parsed;
}

export async function runArchiveInterpretationBackfillCli(
  argv: string[],
): Promise<void> {
  const args = parseArchiveInterpretationBackfillArgs(argv);
  const { db, sql, engine } = makeContext();
  try {
    if (args.cancelRunId) {
      const cancellation = await cancelArchiveInterpretationBackfillRun({
        db,
        runId: args.cancelRunId,
        reason: args.cancellationReason!,
      });
      const freshRerun = args.freshRerunCampaignId
        ? await routeCampaignPrecalcToFreshAfterArchiveAbandonment({
            db,
            runId: args.cancelRunId,
            campaignId: args.freshRerunCampaignId,
            reason: args.cancellationReason!,
          })
        : null;
      process.stdout.write(
        `${JSON.stringify({ mode: "cancel", cancellation, freshRerun })}\n`,
      );
      return;
    }
    if (!args.execute) {
      const reducerVersionId = await findResultInterpretationReducerVersion(db);
      const discovery = await discoverArchiveInterpretationBackfill(db, {
        reducerVersionId,
        scope: args.scope,
      });
      process.stdout.write(
        `${JSON.stringify({
          mode: "plan",
          reducerVersionId,
          ...discovery,
          candidates: discovery.candidates.map((candidate) => ({
            resultId: candidate.resultId,
            resultAttemptId: candidate.resultAttemptId,
            fidelity: candidate.fidelity,
            sourceArchiveId: candidate.sourceArchiveId,
            rawArchiveReady: candidate.archivePointer != null,
            unavailableReason: candidate.unavailableReason,
          })),
        })}\n`,
      );
      return;
    }
    const created = args.runId
      ? null
      : await createArchiveInterpretationBackfillRun({
          db,
          scope: args.scope,
          requestedBy: args.requestedBy,
        });
    const runId = args.runId ?? created!.runId;
    const report = await runArchiveInterpretationBackfill({
      db,
      engine,
      runId,
      maxItems: args.maxItems,
    });
    process.stdout.write(
      `${JSON.stringify({ mode: "execute", created, ...report })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runArchiveInterpretationBackfillCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
