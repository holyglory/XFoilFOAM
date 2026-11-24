import { createClient } from "@aerodb/db";
import { RetentionFiles } from "./retention-files";
import { registerClosedWorkingFileRead } from "./closed-progressive-retention";

const args = process.argv.slice(2);
const preview = args[0] === "--preview";
const [job, plan, ...extra] = preview ? args.slice(1) : args;
if (
  !job ||
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job) ||
  !plan ||
  !/^[a-f0-9]{64}$/.test(plan) ||
  extra.length
)
  throw Error("Expected one job UUID and its completed file-plan SHA-256");
if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
  throw Error("Registered worker required");
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());
process.once("SIGINT", () => abort.abort());
const signal = AbortSignal.any([
  abort.signal,
  AbortSignal.timeout(20 * 60_000),
]);
const client = createClient({
  max: 1,
  connection: preview ? { default_transaction_read_only: "on" } : {},
});
try {
  const peer = new RetentionFiles(
    process.env.AIRFOILFOAM_DATA_DIR || "/data/airfoilfoam",
    signal,
  );
  if (!peer.available())
    throw Error("Verified working-file reader preparation is unavailable");
  const proof = await registerClosedWorkingFileRead(
    client.db,
    peer,
    job,
    plan,
    signal,
    preview,
  );
  console.log(
    JSON.stringify({
      registered: !preview,
      job,
      plan: proof.plan,
      files: proof.files,
      filesSha256: proof.filesSha256,
      sources: proof.sources.length,
    }),
  );
} finally {
  await client.sql.end();
}
