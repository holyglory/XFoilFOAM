import { createClient } from "./client";
import { prepareSourcePreservingDefaults } from "./progressive-numerics-transition";

const [mode = "--dry-run"] = process.argv.slice(2);
if (!["--dry-run", "--apply"].includes(mode) || process.argv.length > 3)
  throw new Error("Usage: prepare-numerics-defaults [--dry-run|--apply]");
const { db, sql } = createClient({ max: 1 });
const rollback = new Error("reviewed numerical defaults dry-run rollback");
let result:
  | Awaited<ReturnType<typeof prepareSourcePreservingDefaults>>
  | undefined;
try {
  await db
    .transaction(async (transaction) => {
      result = await prepareSourcePreservingDefaults(
        transaction as unknown as typeof db,
      );
      if (mode === "--dry-run") throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
  console.log(JSON.stringify({ mode, result }));
} finally {
  await sql.end();
}
