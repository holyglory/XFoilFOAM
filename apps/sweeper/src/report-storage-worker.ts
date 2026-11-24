import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import { ProgressiveReportArchiveStore } from "./progressive-report-archive-store";
import { readStoredWorkerArchiveText } from "./report-archive-broker-client";
import { createClient } from "@aerodb/db/client";
import { configuredDeploymentRole, makeReportStorageDatabase } from "./config";
import {
  runProgressiveReportArchiveService,
  runDuplicateReportCleanup,
  runNativeWorkerReportSharing,
} from "./progressive-report-archive-service";
import { runSolverHistoryStorageService } from "./solver-history-service";
import { runResultHistoryStorageService } from "./result-history-service";
import { runWorkerVolumeCleanup } from "./worker-report-volume-cleanup";
import { runSharedStoppedReportStorage } from "./shared-stopped-report-service";
import { CancelledReportCopyPriority } from "./cancelled-report-copies";
import { runAttemptEvidenceStorageService } from "./attempt-evidence-service";
import { runConfiguredAttemptEvidenceSettlementService } from "./attempt-evidence-settlement";

const client = makeReportStorageDatabase("report-storage-backfill");
const stop = new AbortController();
const role = configuredDeploymentRole();
const hubBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
if (role === "hub" && hubBucket) {
  installProgressiveReportArchiveReader(new ProgressiveReportArchiveStore(hubBucket));
} else if (role === "remote-solver") {
  installProgressiveReportArchiveReader({
    read: (identity, db) => readStoredWorkerArchiveText(db, identity),
  });
}
const attemptEvidence = createClient({
  max: 1,
  connection: {
    application_name: "attempt-evidence-storage",
    statement_timeout: "5s",
    lock_timeout: "500ms",
  },
});
const attemptSettlement = createClient({
  max: 1,
  connection: {
    application_name: "attempt-history-shortening",
    statement_timeout: "5s",
    lock_timeout: "500ms",
  },
});
for (const event of ["SIGTERM", "SIGINT", "disconnect"] as const)
  process.once(event, () => stop.abort());
try {
  const priority = role === "hub" ? new CancelledReportCopyPriority() : undefined;
  const work = [runProgressiveReportArchiveService(client.db, stop.signal, priority)];
  if (role === "remote-solver") {
    work.push(runDuplicateReportCleanup(client.db, stop.signal));
    work.push(runNativeWorkerReportSharing(client.db, stop.signal));
    work.push(runWorkerVolumeCleanup(client.db, stop.signal));
  } else {
    work.push(runSharedStoppedReportStorage(client.db, stop.signal, priority));
    work.push(runSolverHistoryStorageService(client.db, stop.signal));
    work.push(runResultHistoryStorageService(client.db, stop.signal));
    work.push(
      runAttemptEvidenceStorageService(attemptEvidence.db, stop.signal),
    );
    work.push(
      runConfiguredAttemptEvidenceSettlementService(
        attemptSettlement.db,
        stop.signal,
      ),
    );
  }
  await Promise.all(work);
} finally {
  stop.abort();
  await client.sql.end({ timeout: 2 });
  await attemptEvidence.sql.end({ timeout: 2 });
  await attemptSettlement.sql.end({ timeout: 2 });
  if (process.connected) process.disconnect();
}
