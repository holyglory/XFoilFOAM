/**
 * Operator entry point for legacy FAST-URANS attempts missing a current
 * verified GCS archive.
 *
 * Planning is read-only.  Execution only materializes durable recovery
 * receipts; it cannot submit CFD.  The normal sweeper later routes each
 * receipt through its bounded PRECALC obligation and request ladder.
 */
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import {
  discoverLegacyUransArchiveGapRecovery,
  materializeLegacyUransArchiveGapRecoveryActions,
  normaliseLegacyUransArchiveGapRecoveryScope,
  type LegacyUransArchiveGapRecoveryScope,
} from "./legacy-urans-archive-gap-recovery";

interface Args {
  execute: boolean;
  scope: LegacyUransArchiveGapRecoveryScope;
  createdBy: string | undefined;
}

function requiredValue(argv: string[], index: number, label: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 1_000) {
    throw new Error(`${label} must be a positive integer no greater than 1000`);
  }
  return parsed;
}

export function parseLegacyUransArchiveGapRecoveryArgs(argv: string[]): Args {
  const scope: LegacyUransArchiveGapRecoveryScope = {
    resultIds: [],
    resultAttemptIds: [],
  };
  const parsed: Args = { execute: false, scope, createdBy: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      parsed.execute = true;
      continue;
    }
    const value = requiredValue(argv, index, argument ?? "argument");
    if (argument === "--result-id") scope.resultIds!.push(value);
    else if (argument === "--result-attempt-id") {
      scope.resultAttemptIds!.push(value);
    } else if (argument === "--limit") {
      scope.limit = positiveInteger(value, "--limit");
    } else if (argument === "--created-by") {
      parsed.createdBy = value;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
    index += 1;
  }
  normaliseLegacyUransArchiveGapRecoveryScope(scope);
  if (parsed.execute && !scope.resultAttemptIds?.length) {
    throw new Error(
      "--execute requires one or more exact --result-attempt-id values from a read-only plan",
    );
  }
  return parsed;
}

export async function runLegacyUransArchiveGapRecoveryCli(
  argv: string[],
): Promise<void> {
  const args = parseLegacyUransArchiveGapRecoveryArgs(argv);
  const { db, sql } = makeContext();
  try {
    if (!args.execute) {
      const discovery = await discoverLegacyUransArchiveGapRecovery(db, {
        scope: args.scope,
      });
      process.stdout.write(
        `${JSON.stringify({
          mode: "plan",
          ...discovery,
          candidates: discovery.candidates.map((candidate) => ({
            resultId: candidate.resultId,
            resultAttemptId: candidate.resultAttemptId,
            airfoilId: candidate.airfoilId,
            revisionId: candidate.revisionId,
            bcId: candidate.bcId,
            aoaDeg: candidate.aoaDeg,
            archiveState: candidate.archiveState,
            route:
              candidate.archiveState === "absent"
                ? "one bounded fresh FAST request after execute"
                : "wait for current archive migration; no fresh request",
          })),
        })}\n`,
      );
      return;
    }
    const report = await materializeLegacyUransArchiveGapRecoveryActions({
      db,
      scope: args.scope,
      createdBy: args.createdBy,
    });
    process.stdout.write(
      `${JSON.stringify({
        mode: "execute",
        created: report.created,
        alreadyTracked: report.alreadyTracked,
        noLongerEligible: report.noLongerEligible,
        planned: report.discovery.candidates.length,
        next:
          "the sweeper will route only archive-absent actions into ordinary bounded FAST URANS; no action continues the legacy case",
      })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runLegacyUransArchiveGapRecoveryCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
