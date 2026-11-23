import { pathToFileURL } from "node:url";
import { createClient, type DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import {
  readApiAttemptEvidenceForApp,
  readStoredAttemptEvidenceText,
} from "./attempt-evidence-reader";
import { attemptRpc } from "../../sweeper/src/hz-attempt-custody-cli";
import { exactId } from "../../sweeper/src/hz-attempt-custody";

export async function hzAttemptApiProbe(
  db: DB,
  id: string,
  archiveId: string,
  forceArchive: boolean,
) {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw Error("Unexpected application role");
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  const { payloadText, ...proof } = await readApiAttemptEvidenceForApp(db, {
    attemptId: id,
    archiveId,
    sourceSha256: archive.sourceSha256,
    sourceByteSize: archive.sourceByteSize,
    forceArchive,
  });
  // Exercise both normal stable-ID representations before and after release.
  if (
    proof.source !== "worker-volume" ||
    (await readStoredAttemptEvidenceText(db, id)) !== payloadText ||
    (await readStoredAttemptEvidenceText(db, id, {
      source: "worker-report",
    })) !== payloadText
  )
    throw Error("Application attempt sources differ");
  return { ...proof, forceArchive, verifiedAt: new Date().toISOString() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await attemptRpc(async (r) => {
    if (r.operation !== "api" || typeof r.forceArchive !== "boolean")
      throw Error("Unknown application operation");
    const c = createClient({
      max: 1,
      connection: {
        default_transaction_read_only: "on",
        statement_timeout: "10s",
        lock_timeout: "500ms",
      },
    });
    try {
      const { installApiReportArchiveReader } = await import("./progressive-report-archive-reader");
      await installApiReportArchiveReader();
      return await hzAttemptApiProbe(
        c.db,
        exactId(r.attemptId),
        exactId(r.archiveId),
        r.forceArchive,
      );
    } finally {
      await c.sql.end({ timeout: 1 });
    }
  });
