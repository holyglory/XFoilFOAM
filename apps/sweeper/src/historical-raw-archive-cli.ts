import { createClient } from "@aerodb/db/client";
import { transferHistoricalRawArchive } from "./historical-raw-archive";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--execute"))
  throw new Error(
    "Pass one signed raw reference on stdin, optionally with --execute",
  );
const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 8192)
    throw new Error("Expected one bounded historical raw reference");
  chunks.push(Buffer.from(chunk));
}
const client = createClient({
  max: 1,
  connection: {
    default_transaction_read_only: "on",
    statement_timeout: "15000",
    application_name: "historical_raw_archive_transfer",
  },
});
try {
  console.log(
    JSON.stringify(
      await transferHistoricalRawArchive(
        client.db,
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        args[0] === "--execute",
      ),
    ),
  );
} finally {
  await client.sql.end();
}
