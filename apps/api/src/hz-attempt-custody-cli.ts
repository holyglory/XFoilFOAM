import { pathToFileURL } from "node:url";
import { createClient, type DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import {
  readApiAttemptEvidenceForApp,
  readStoredAttemptEvidenceText,
} from "./attempt-evidence-reader";
import { attemptRpc, exactId } from "../../sweeper/src/hz-attempt-wire";

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
export async function hzCanonicalFieldApiProbe(db: DB, resultId: string, kind: "steady_history" | "frame_track", reference: string) {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver") throw Error("Unexpected canonical history reader role");
  const {readCanonicalSubtree}=await import("@aerodb/db/result-history-subtrees");
  const {apiAttemptEvidenceReader}=await import("./attempt-evidence-reader");
  return readCanonicalSubtree(db,apiAttemptEvidenceReader,exactId(resultId),kind,exactId(reference));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await attemptRpc(async (r) => {
    if (r.operation !== "canonical-read" && (r.operation !== "api" || typeof r.forceArchive !== "boolean"))
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
      if (r.operation === "canonical-read") {
        return await hzCanonicalFieldApiProbe(c.db,r.resultId,r.kind,r.reference);
      }
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
