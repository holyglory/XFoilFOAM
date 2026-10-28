import { createClient } from "@aerodb/db";
import { readFile } from "node:fs/promises";
import {
  parseProgressiveWorkerOutboxReplayInput,
  ProgressiveWorkerOutboxReplayRefused,
  replayProgressiveWorkerOutbox,
} from "./progressive-worker-outbox-replay";

const usage =
  "Usage: tsx src/progressive-worker-outbox-replay-cli.ts --manifest <json-file> [--apply|--dry-run]\nManifest: { executionId, points: [{ pointContentSignature, resultAttemptId, sequence }], expectedCount or manifestSignature }. Select 1..64 exact points. Default: dry-run. Apply only requeues delivery; it does not contact the hub.";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  let manifest: string | undefined;
  let mode: "--apply" | "--dry-run" | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument === "--manifest" &&
      manifest === undefined &&
      args[index + 1] &&
      !args[index + 1].startsWith("--")
    ) {
      manifest = args[index + 1];
      index += 1;
    } else if (
      (argument === "--apply" || argument === "--dry-run") &&
      mode === undefined
    ) {
      mode = argument;
    } else throw new Error(usage);
  }
  if (!manifest) throw new Error(usage);
  const input = parseProgressiveWorkerOutboxReplayInput(
    JSON.parse(await readFile(manifest, "utf8")),
  );
  const client = createClient({ max: 1 });
  try {
    console.log(
      JSON.stringify(
        await replayProgressiveWorkerOutbox(client.db, input, {
          apply: mode === "--apply",
        }),
        null,
        2,
      ),
    );
  } finally {
    await client.sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof ProgressiveWorkerOutboxReplayRefused ||
      (error instanceof Error && error.message === usage)
      ? error.message
      : "Worker outbox replay failed; no partial selection is applied. Check the manifest and local database.",
  );
  process.exitCode = 1;
});
