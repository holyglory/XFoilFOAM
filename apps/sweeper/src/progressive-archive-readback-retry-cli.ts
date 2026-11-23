import { createClient } from "@aerodb/db";
import { z } from "zod";
import { recheckDeferredProgressiveArchive } from "./progressive-archive-readback-retry";

const args = z.tuple([
  z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/), z.string().uuid(), z.coerce.number().int().positive(),
]).safeParse(process.argv.slice(2));
if (!args.success) {
  throw Error("Expected the exact job ID, point signature, upload ID and observed attempt count");
}
const [jobId, pointSignature, uploadId, attemptCount] = args.data;
const client = createClient({max: 1, connection: {application_name: "verified_point_readback_retry", statement_timeout: "3s", lock_timeout: "500ms"}});
try {
  const result = await recheckDeferredProgressiveArchive(client.db, {jobId,pointSignature,uploadId,attemptCount}, AbortSignal.timeout(20 * 60_000));
  console.log(JSON.stringify({jobId, pointSignature, ...result}));
} finally {
  await client.sql.end();
}
