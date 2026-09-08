import { readFileSync } from "node:fs";
import { createClient, type DB } from "./client";
import {
  prepareProgressiveReset,
  type ProgressiveResetInput,
} from "./prepare-progressive-reset";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--rehearse", "--apply"].includes(mode))
  throw new Error(
    "Specify --rehearse or --apply; exact reset input is read from stdin",
  );
const input = JSON.parse(readFileSync(0, "utf8")) as ProgressiveResetInput;
const { db, sql } = createClient({ max: 1 });
class RehearsalComplete extends Error {}
let receipt: Awaited<ReturnType<typeof prepareProgressiveReset>> | undefined;
try {
  try {
    await db.transaction(async (transaction) => {
      receipt = await prepareProgressiveReset(
        transaction as unknown as DB,
        input,
      );
      if (mode === "--rehearse") throw new RehearsalComplete();
    });
  } catch (error) {
    if (!(error instanceof RehearsalComplete)) throw error;
  }
  console.log(JSON.stringify({ applied: mode === "--apply", ...receipt }));
} finally {
  await sql.end({ timeout: 5 });
}
