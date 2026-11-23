import {
  LegacyStorageOperationError,
  legacySshOperationError,
  type LegacyStorageOperation,
} from "./legacy-report-storage-gcs";
import { legacyBound } from "@aerodb/db/legacy-report-storage";
import { parseLegacyCustodyWorkerFailure } from "./legacy-report-storage-custody-worker";

export class LegacyOperatorPaused extends Error {
  readonly code = "deployment_lock_held";
  readonly exitCode = 75;
  readonly retryable = true;
  constructor() {
    super(
      "Deployment holds the host lock. The migration can resume from its saved page after deployment.",
    );
    this.name = "LegacyOperatorPaused";
  }
}

/** Wrap the HOST docker/psql command, not a command inside the container.
 * Keep this wrapper out of source/normalizer binding hashes for compatibility. */
export function legacyOperatorWriteCommand(
  command: string,
  waitSeconds = 15,
): string {
  legacyBound(waitSeconds, 60, "shared deployment lock wait");
  return `flock -s -w ${waitSeconds} -E 75 /tmp/airfoils-pro-deploy.lock ${command}`;
}

export function legacyOperatorWriteFailure(
  error: unknown,
  stderr: string | Buffer = "",
  operation: LegacyStorageOperation = "worker_sql",
  provenTarget = false,
): Error {
  if (Number((error as { code?: unknown })?.code) === 75)
    return new LegacyOperatorPaused();
  if (
    operation === "worker_custody" &&
    Number((error as { code?: unknown })?.code) === 1
  ) {
    const failure = parseLegacyCustodyWorkerFailure(stderr);
    if (failure)
      return new LegacyStorageOperationError({
        operation,
        category: failure.category,
        sqlState: failure.sqlState,
        workerPhase: failure.workerPhase,
        transactionRolledBack: failure.transactionRolledBack,
        registrationElapsedMs: failure.registrationElapsedMs,
        exitCode: 1,
        signal: (error as { signal?: unknown }).signal,
      });
  }
  return legacySshOperationError(operation, error, stderr, provenTarget);
}
