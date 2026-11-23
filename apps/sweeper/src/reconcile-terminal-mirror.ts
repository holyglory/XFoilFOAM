import { createClient } from "@aerodb/db/client";
import { reconcileTerminalProgressiveMirror } from "./progressive-terminal-mirror";
const [promiseId, action, ...rest] = process.argv.slice(2);
if (
  !promiseId ||
  (action !== "--apply" && action !== "--preview") ||
  rest.length
) {
  throw new Error(
    "Usage: reconcile-terminal-mirror <promise-uuid> --preview|--apply",
  );
}
const { db, sql } = createClient({
  max: 1,
  connection: {
    application_name: "registered_terminal_mirror",
    lock_timeout: "1500",
    statement_timeout: "15000",
    ...(action === "--preview" ? { default_transaction_read_only: "on" } : {}),
  },
});
try {
  console.log(
    JSON.stringify(
      await reconcileTerminalProgressiveMirror(db, {
        promiseId,
        preview: action === "--preview",
      }),
    ),
  );
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  console.error(
    JSON.stringify({
      outcome: "error",
      code:
        typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
          ? code
          : "reconciliation_failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
