/**
 * Read-only operator inventory for explicit FAST/FINAL URANS attempts. It
 * includes completed, failed, and active evidence with an execution state.
 * This command intentionally has no execution mode: use only the completed
 * solved plan labels to choose a separately reviewed archive reduction or
 * recovery path.
 */
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import {
  discoverHistoricalUransInventory,
  normaliseHistoricalUransInventoryScope,
  type HistoricalUransInventoryScope,
} from "./historical-urans-inventory";

interface Args {
  scope: HistoricalUransInventoryScope;
}

function requiredValue(argv: string[], index: number, label: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function positiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function parseHistoricalUransInventoryArgs(argv: string[]): Args {
  // `pnpm --filter <pkg> <script> -- --limit 64` forwards a literal leading
  // separator to this script. Accept only that conventional leading form so
  // documented read-only invocations do not turn into a misleading error.
  const argumentsWithoutRunnerSeparator =
    argv[0] === "--" ? argv.slice(1) : argv;
  const scope: HistoricalUransInventoryScope = {
    resultIds: [],
    resultAttemptIds: [],
  };
  for (
    let index = 0;
    index < argumentsWithoutRunnerSeparator.length;
    index += 1
  ) {
    const argument = argumentsWithoutRunnerSeparator[index];
    if (argument === "--execute") {
      throw new Error(
        "historical URANS inventory is read-only and does not support --execute",
      );
    }
    const value = requiredValue(
      argumentsWithoutRunnerSeparator,
      index,
      argument ?? "argument",
    );
    if (argument === "--result-id") scope.resultIds!.push(value);
    else if (argument === "--result-attempt-id") {
      scope.resultAttemptIds!.push(value);
    } else if (argument === "--limit") {
      scope.limit = positiveInteger(value, "--limit");
    } else if (argument === "--cursor") {
      scope.cursor = value;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
    index += 1;
  }
  normaliseHistoricalUransInventoryScope(scope);
  return { scope };
}

export async function runHistoricalUransInventoryCli(
  argv: string[],
): Promise<void> {
  const args = parseHistoricalUransInventoryArgs(argv);
  const { db, sql } = makeContext();
  try {
    const discovery = await discoverHistoricalUransInventory(db, {
      scope: args.scope,
    });
    process.stdout.write(
      `${JSON.stringify({
        mode: "plan",
        readOnly: true,
        ...discovery,
        scope: {
          ...discovery.scope,
          cursor: discovery.scope.cursor
            ? `${discovery.scope.cursor.createdAt}|${discovery.scope.cursor.resultAttemptId}`
            : null,
        },
      })}\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runHistoricalUransInventoryCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
