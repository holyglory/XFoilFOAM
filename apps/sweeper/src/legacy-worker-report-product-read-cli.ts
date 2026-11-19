import { createClient } from "@aerodb/db/client";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  LegacyWorkerProductReadError, MAX_LEGACY_PRODUCT_REQUEST_BYTES,
  parseLegacyWorkerProductReadRequest, readLegacyWorkerProductPage,
} from "./legacy-worker-report-product-read";

export interface LegacyWorkerProductReadIo { input: Readable; write(text: string): void }

/** Installed invocation in node-api OR sweeper:
 * node --import tsx apps/sweeper/src/legacy-worker-report-product-read-cli.ts < request.json
 * One JSON page request in; one bounded proof manifest out. Never emit bodies. */
export async function legacyWorkerReportProductReadCli(
  args = process.argv.slice(2),
  io: LegacyWorkerProductReadIo = { input: process.stdin, write: (text) => { process.stdout.write(text); } },
): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    io.write("Read one retained legacy page: stdin {version:1,object:LegacyBackupObject,sourceInstance,solverId,scopeSha256,members:LegacyExactPageMemberIdentity[]}; stdout exact per-member proof manifest. Local source worker only; no network or writes.\n");
    return;
  }
  // node-api may omit the deployment role while sharing the source worker's
  // DB/volume. The product reader always verifies current instance+solver;
  // an explicitly configured non-worker deployment is still refused here.
  const role = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE?.trim();
  if (args.length || (role && role !== "remote-solver") || !process.env.DATABASE_URL)
    throw new LegacyWorkerProductReadError("input_invalid", "Run without arguments against the source worker DB and shared volume");
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const timer = setTimeout(abort, 120_000);
  const stopInput = () => io.input.destroy(new LegacyWorkerProductReadError("aborted", "Page request input aborted"));
  controller.signal.addEventListener("abort", stopInput, { once: true });
  let client: ReturnType<typeof createClient> | undefined;
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const raw of io.input) {
      controller.signal.throwIfAborted();
      const bytes = Buffer.from(raw); size += bytes.length;
      if (size > MAX_LEGACY_PRODUCT_REQUEST_BYTES)
        throw new LegacyWorkerProductReadError("input_invalid", "Page request exceeds its byte bound");
      chunks.push(bytes);
    }
    controller.signal.removeEventListener("abort", stopInput);
    const bytes = Buffer.concat(chunks), text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes))
      throw new LegacyWorkerProductReadError("input_invalid", "Page request is not valid UTF-8");
    const request = parseLegacyWorkerProductReadRequest(text);
    controller.signal.throwIfAborted();
    client = createClient({ url: process.env.DATABASE_URL, max: 1 });
    // Keep this CLI's own connection read-only using session-only settings;
    // they do not change persistent policy, credentials or other connections.
    await client.sql`SET default_transaction_read_only = on`;
    await client.sql`SET statement_timeout = '10s'`;
    const proof = await readLegacyWorkerProductPage(client.db, request, controller.signal);
    const output = JSON.stringify({ ...proof, requestSha256: createHash("sha256").update(bytes).digest("hex") });
    if (Buffer.byteLength(output) > 256 * 1024)
      throw new LegacyWorkerProductReadError("proof_invalid", "Page proof exceeds its output bound");
    io.write(output + "\n");
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", stopInput);
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    await client?.sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  legacyWorkerReportProductReadCli().catch((error) => {
    const typed = error instanceof LegacyWorkerProductReadError;
    process.stderr.write(JSON.stringify({ version: 1, verified: false,
      code: typed ? error.code : "read_failed", error: typed ? error.message : "Installed legacy page read failed" }) + "\n");
    process.exitCode = 1;
  });
}
