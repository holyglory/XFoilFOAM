import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { makeContext } from "./config";
import {
  acknowledgeOperationalCanaryRetention,
  planOperationalCanaryEvidenceRegistration,
  registerOperationalCanaryEvidence,
} from "./canary-evidence-ownership";

interface Args {
  mode: "plan" | "register" | "acknowledge";
  input: string;
}

function parseArgs(argv: string[]): Args {
  let mode: Args["mode"] = "plan";
  let input = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--register") mode = "register";
    else if (arg === "--acknowledge") mode = "acknowledge";
    else if (arg === "--plan") mode = "plan";
    else if (arg === "--input") input = argv[++index] ?? "";
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!input) throw new Error("--input JSONL path is required");
  return { mode, input };
}

async function jsonLines(path: string): Promise<unknown[]> {
  const lines = (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("input JSONL contains no documents");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `invalid JSON on input line ${index + 1}: ${String(error)}`,
      );
    }
  });
}

export async function runOperationalCanaryEvidenceCli(
  argv: string[],
): Promise<number> {
  const args = parseArgs(argv);
  const documents = await jsonLines(args.input);
  const { db, sql } = makeContext();
  try {
    for (const document of documents) {
      const result =
        args.mode === "plan"
          ? await planOperationalCanaryEvidenceRegistration(db, document)
          : args.mode === "register"
            ? await registerOperationalCanaryEvidence(db, document)
            : await acknowledgeOperationalCanaryRetention(db, document);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    process.stderr.write(
      `${JSON.stringify({ mode: args.mode, processed: documents.length })}\n`,
    );
    return 0;
  } finally {
    await sql.end();
  }
}

const direct = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (direct) {
  runOperationalCanaryEvidenceCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
