import { createClient } from "@aerodb/db";
import { recheckDeferredProgressiveArchive } from "./progressive-archive-readback-retry";

const [jobId, pointSignature, uploadId, count, ...extra] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const attemptCount = Number(count);
if (!jobId || !uuid.test(jobId) || !uploadId || !uuid.test(uploadId) ||
    !pointSignature || !/^[a-f0-9]{64}$/.test(pointSignature) ||
    !Number.isSafeInteger(attemptCount) || attemptCount < 1 || extra.length) {
  throw Error("Expected the exact job ID, point signature, upload ID and observed attempt count");
}
const client = createClient({max: 1, connection: {application_name: "verified_point_readback_retry", statement_timeout: "3s", lock_timeout: "500ms"}});
try {
  const result = await recheckDeferredProgressiveArchive(client.db, {jobId,pointSignature,uploadId,attemptCount}, AbortSignal.timeout(20 * 60_000));
  console.log(JSON.stringify({jobId, pointSignature, ...result}));
} finally {
  await client.sql.end();
}
