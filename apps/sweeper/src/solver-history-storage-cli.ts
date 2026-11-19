import { createClient } from "@aerodb/db/client";
import {
  loadSolverHistorySource,
  solverHistoryInventory,
  solverHistoryInventoryPage,
} from "@aerodb/db/solver-history-storage";
import {
  MAX_SOLVER_HISTORY_BYTES,
  SOLVER_HISTORY_KINDS,
  compareSolverHistoryRaw,
  type SolverHistoryKind,
} from "@aerodb/core/solver-history-storage";
import { open, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { archiveSolverHistory, restoreSolverHistory } from "./solver-history-archive";
import { SolverHistoryStore } from "./solver-history-store";
import { runForceHistoryOffloadPass } from "./solver-history-service";

async function readRawMember(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SOLVER_HISTORY_BYTES)
      throw new Error("Raw comparison requires a bounded regular archive member file");
    const buffer = Buffer.alloc(MAX_SOLVER_HISTORY_BYTES + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      size += bytesRead;
      if (size > MAX_SOLVER_HISTORY_BYTES) throw new Error("Raw comparison file grew beyond its bound");
      if (!bytesRead) return buffer.subarray(0, size);
    }
  } finally { await file.close(); }
}

export async function solverHistoryStorageCli(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    kind: { type: "string" }, id: { type: "string" }, after: { type: "string" }, limit: { type: "string" },
    bucket: { type: "string" }, "source-instance": { type: "string" },
    "raw-member": { type: "string" }, output: { type: "string" },
  } });
  const command = positionals[0] ?? "inventory";
  if (positionals.length > 1 || !["inventory", "page", "compare", "archive", "backfill", "restore"].includes(command))
    throw new Error("Use inventory | page --kind KIND | compare/archive --kind force_history --id UUID | backfill --bucket BUCKET --source-instance ID | restore --id ARCHIVE_UUID --output NEW_FILE");
  // No implicit development/production fallback: operator must select the DB.
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL explicitly for physical history operations");
  const kind = values.kind as SolverHistoryKind;
  if (["page", "compare", "archive"].includes(command) && !SOLVER_HISTORY_KINDS.includes(kind))
    throw new Error(`Specify --kind ${SOLVER_HISTORY_KINDS.join("|")}`);
  if (["compare", "archive", "restore"].includes(command) && !values.id) throw new Error("Specify a stable --id UUID");
  if (command === "compare" && !values["raw-member"]) throw new Error("Compare requires an authenticated extracted --raw-member file");
  if (["archive", "backfill"].includes(command) && (!values.bucket || !values["source-instance"]))
    throw new Error("Archive requires --bucket and the stable --source-instance identity");
  if (command === "restore" && !values.output) throw new Error("Restore requires a new --output file");
  const client = createClient({ url: process.env.DATABASE_URL, max: 1 });
  try {
    // All database reads/writes have a finite server-side statement bound.
    await client.sql`SET statement_timeout = '60s'`;
    let result: unknown;
    if (command === "inventory") result = await solverHistoryInventory(client.db);
    else if (command === "page") result = await solverHistoryInventoryPage(client.db, kind, {
      after: values.after, limit: values.limit === undefined ? undefined : Number(values.limit),
    });
    else if (command === "compare") result = compareSolverHistoryRaw(
      await loadSolverHistorySource(client.db, kind, values.id!), await readRawMember(values["raw-member"]!),
    );
    else if (command === "archive") result = await archiveSolverHistory(client.db, new SolverHistoryStore(), {
      bucket: values.bucket!, sourceInstance: values["source-instance"]!, sourceKind: kind, sourceId: values.id!,
      existingRawMember: values["raw-member"] ? await readRawMember(values["raw-member"]) : undefined,
    });
    else if (command === "backfill") result = await runForceHistoryOffloadPass(client.db, new SolverHistoryStore(), {
      bucket: values.bucket!, sourceInstance: values["source-instance"]!, after: values.after,
    });
    else {
      const restored = await restoreSolverHistory(client.db, new SolverHistoryStore(), values.id!);
      // Export exact text only after authentication. Never overwrite an existing
      // artifact and never apply SQL automatically during restore.
      await writeFile(values.output!, restored.payloadText, { flag: "wx", mode: 0o600 });
      result = { archiveId: values.id, sourceKind: restored.sourceKind, sourceId: restored.sourceId, output: values.output };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await client.sql.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  solverHistoryStorageCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
