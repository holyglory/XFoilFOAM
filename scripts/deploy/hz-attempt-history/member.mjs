import { createClient } from "/app/packages/db/src/client.ts";
function requireProof(condition, reason) {
  if (!condition) throw new Error(reason);
}

function client() {
  return createClient({
    max: 1,
    connection: {
      application_name: "hz_attempt_history_proof",
      default_transaction_read_only: "on",
      statement_timeout: "10s",
      lock_timeout: "500ms",
      idle_in_transaction_session_timeout: "5s",
    },
  });
}

function fail(error) {
  const allowed = [
    "scope",
    "source",
    "archive",
    "identity",
    "generation",
    "replay",
  ];
  console.error(
    allowed.includes(error?.message) ? error.message : "unavailable",
  );
  process.exitCode = 1;
}
