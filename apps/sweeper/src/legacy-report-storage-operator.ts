import { legacyBound } from "@aerodb/db/legacy-report-storage";

export class LegacyOperatorPaused extends Error {
  readonly code = "deployment_lock_held";
  readonly exitCode = 75;
  readonly retryable = true;
  constructor() {
    super(
      "Deployment holds the HZ writer lock; pending bytes and completed progress are retained. Repeat the same bounded command after deployment.",
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

export function legacyOperatorWriteFailure(error: unknown): Error {
  if (Number((error as { code?: unknown })?.code) === 75)
    return new LegacyOperatorPaused();
  return new Error(
    "Guarded operator transaction failed or its acknowledgement was lost; retain receipt/pending page and retry",
  );
}
