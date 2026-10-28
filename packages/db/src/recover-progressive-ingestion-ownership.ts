import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type DB } from "./client";
import {
  parseProgressiveIngestionRecoverySelection,
  recoverProgressiveIngestionOwnership,
  type ProgressiveIngestionRecoveryManifest,
} from "./progressive-ingestion-ownership-recovery";

export async function runProgressiveIngestionRecoveryCommand(db: DB, args: string[]) {
  const [inputPath, mode = "--dry-run", ...extra] = args;
  if (!inputPath || inputPath.startsWith("--") || extra.length || !["--dry-run", "--apply"].includes(mode))
    throw new Error("Usage: recover-progressive-ingestion-ownership SELECTION_OR_MANIFEST.json [--dry-run|--apply]; selection requires jobId, solverId, promiseId, unitIds, expectedUnitCount; apply requires dry-run output");
  const contents = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(contents) > 64 * 1024) throw new Error("Recovery input exceeds 64 KiB");
  const input = JSON.parse(contents);
  const manifest = (input?.manifest ?? (input?.version === 1 ? input : undefined)) as ProgressiveIngestionRecoveryManifest | undefined;
  const selection = parseProgressiveIngestionRecoverySelection(manifest?.selection ?? input);
  return recoverProgressiveIngestionOwnership(db, selection, { apply: mode === "--apply", manifest });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const client = createClient({ max: 1 });
  try {
    console.log(JSON.stringify(await runProgressiveIngestionRecoveryCommand(client.db, process.argv.slice(2))));
  } finally {
    await client.sql.end();
  }
}
