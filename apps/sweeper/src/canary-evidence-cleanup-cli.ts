import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  acknowledgeCanaryEvidenceCleanup,
  planCanaryEvidenceCleanup,
  reserveCanaryEvidenceCleanup,
} from "./canary-evidence-cleanup";
import { makeContext } from "./config";

interface Args {
  attestationId: string | null;
  reserve: boolean;
  actor: string | null;
  acknowledgementFile: string | null;
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    attestationId: null,
    reserve: false,
    actor: null,
    acknowledgementFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reserve") {
      parsed.reserve = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--attestation-id") parsed.attestationId = value;
    else if (argument === "--actor") parsed.actor = value;
    else if (argument === "--acknowledgement-file") {
      parsed.acknowledgementFile = value;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
    index += 1;
  }
  if (parsed.acknowledgementFile) {
    if (parsed.reserve || parsed.attestationId || parsed.actor) {
      throw new Error(
        "--acknowledgement-file cannot be combined with reservation arguments",
      );
    }
  } else {
    if (!parsed.attestationId) throw new Error("--attestation-id is required");
    if (parsed.reserve && !parsed.actor) {
      throw new Error("--actor is required with --reserve");
    }
    if (!parsed.reserve && parsed.actor) {
      throw new Error("--actor is only valid with --reserve");
    }
  }
  return parsed;
}

function jsonLines(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `acknowledgement line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (rows.length === 0) throw new Error("acknowledgement file is empty");
  return rows;
}

export async function runCanaryEvidenceCleanupCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const { db, sql } = makeContext();
  try {
    if (args.acknowledgementFile) {
      const rows = jsonLines(
        await readFile(args.acknowledgementFile, "utf8"),
      );
      for (const row of rows) {
        process.stdout.write(
          `${JSON.stringify(await acknowledgeCanaryEvidenceCleanup(db, row))}\n`,
        );
      }
      return;
    }
    if (args.reserve) {
      const documents = await reserveCanaryEvidenceCleanup(
        db,
        args.attestationId!,
        args.actor!,
      );
      for (const document of documents) {
        process.stdout.write(`${JSON.stringify(document)}\n`);
      }
      return;
    }
    for (const row of await planCanaryEvidenceCleanup(db, args.attestationId!)) {
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCanaryEvidenceCleanupCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
