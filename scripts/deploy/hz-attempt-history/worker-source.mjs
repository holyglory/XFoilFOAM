import { readStoredAttemptEvidenceText } from "/app/apps/api/src/attempt-evidence-reader.ts";
import { installApiReportArchiveReader } from "/app/apps/api/src/progressive-report-archive-reader.ts";
import { readProgressiveReport } from "/app/packages/db/src/progressive-report-reader.ts";

async function workerSource() {
  const { db, sql: pg } = client();
  try {
    const { payloadText, witness } = await readHzAttemptFromWorkerReport(
      db,
      request.attempt,
      AbortSignal.timeout(30000),
    );
    const inline = await readStoredAttemptEvidenceText(db, request.attempt);
    await installApiReportArchiveReader(db);
    const report = await readProgressiveReport(db, {
      sourceKind: "worker",
      executionId: witness.job,
      sequence: witness.report.sequence,
      contentSignature: witness.report.signature,
    });
    requireProof(
      inline === payloadText &&
        report.assignmentSignature === witness.assignment &&
        report.executionId === witness.job,
      "replay",
    );
    return { ...witness, exactReplay: true };
  } finally {
    await pg.end({ timeout: 1 });
  }
}
try {
  console.log(JSON.stringify(await workerSource()));
} catch (error) {
  fail(error);
}
