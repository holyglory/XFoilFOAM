/** Operator entry point for the immutable archive clean-cycle backfill.
 *
 * Without `--execute` this is a strictly read-only planning command.  `--execute`
 * admits work to, then drains, the one global archive-publication queue. It
 * never creates an arbitrary standalone run, and it never submits CFD work.
 */
import { pathToFileURL } from "node:url";

import {
  discoverArchiveInterpretationBackfill,
  normaliseArchiveInterpretationBackfillScope,
  type ArchiveInterpretationBackfillScope,
} from "./result-interpretation-backfill";
import { makeContext } from "./config";
import { findResultInterpretationReducerVersion } from "./result-interpretations";
import {
  ARCHIVE_REDUCTION_QUEUE_DRAIN_LIMIT,
  ARCHIVE_REDUCTION_QUEUE_MAX_DRAIN_LIMIT,
  drainArchiveReductionQueue,
  enqueueVerifiedArchiveReductions,
} from "./archive-reduction-queue";

interface Args {
  execute: boolean;
  scope: ArchiveInterpretationBackfillScope;
  maxItems: number | undefined;
}

function positiveInteger(
  value: string | undefined,
  label: string,
  maximum = 100_000,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(
      `${label} must be a positive integer no greater than ${maximum}`,
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
    scope,
    maxItems: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      parsed.execute = true;
      continue;
    }
    if (argument === "--run-id") {
      throw new Error(
        "--run-id is not supported: archive publication must run through the global exact-source queue",
      );
    }
    const value = requiredValue(argv, index, argument ?? "argument");
    if (argument === "--result-id") scope.resultIds!.push(value);
    else if (argument === "--result-attempt-id")
      scope.resultAttemptIds!.push(value);
    else if (argument === "--limit")
      scope.limit = positiveInteger(value, "--limit");
    else if (argument === "--max-items") {
      parsed.maxItems = positiveInteger(
        value,
        "--max-items",
        ARCHIVE_REDUCTION_QUEUE_MAX_DRAIN_LIMIT,
      );
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
    index += 1;
  }
  normaliseArchiveInterpretationBackfillScope(scope);
  if (
    parsed.execute &&
    !scope.resultIds?.length &&
    !scope.resultAttemptIds?.length
  ) {
    throw new Error(
      "--execute requires at least one --result-id or --result-attempt-id; use plan mode to discover candidates first",
    );
  }
  const maxItems = parsed.maxItems ?? ARCHIVE_REDUCTION_QUEUE_DRAIN_LIMIT;
  if (parsed.execute && scope.limit != null && scope.limit > maxItems) {
    throw new Error(
      `--limit cannot exceed --max-items (${maxItems}) during --execute; run another exact batch instead`,
    );
  }
  return parsed;
}

export async function runArchiveInterpretationBackfillCli(
  argv: string[],
): Promise<void> {
  const args = parseArchiveInterpretationBackfillArgs(argv);
  const { db, sql, engine } = makeContext();
  try {
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
    const maxItems = args.maxItems ?? ARCHIVE_REDUCTION_QUEUE_DRAIN_LIMIT;
    const admission = await enqueueVerifiedArchiveReductions(db, {
      resultIds: args.scope.resultIds,
      resultAttemptIds: args.scope.resultAttemptIds,
      // An execution invocation must never leave a wider tail queued than it
      // is permitted to reduce.  Plan mode remains available for broad
      // discovery; execution is an exact, bounded maintenance batch.
      limit: Math.min(args.scope.limit ?? maxItems, maxItems),
    });
    const report = await drainArchiveReductionQueue(db, engine, {
      // Admission above is intentionally inside the global queue path. Do not
      // rediscover a broader scope between an operator's exact admission and
      // this bounded drain.
      enqueue: false,
      resultIds: args.scope.resultIds,
      resultAttemptIds: args.scope.resultAttemptIds,
      maxItems,
    });
    process.stdout.write(
      `${JSON.stringify({
        mode: "execute",
        queue: admission,
        ...report,
      })}\n`,
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
