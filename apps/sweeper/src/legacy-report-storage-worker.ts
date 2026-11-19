import {
  legacyOperatorWriteCommand,
  legacyOperatorWriteFailure,
} from "./legacy-report-storage-operator";
import { execFile } from "node:child_process";
import {
  assertLegacyObject,
  legacySha256,
  type LegacyBackupObject,
} from "./legacy-report-storage-gcs";

export class LegacyWorkerVolumeUnavailable extends Error {
  readonly fallback = "verified-0198-normalization";
  constructor(message: string) {
    super(message);
    this.name = "LegacyWorkerVolumeUnavailable";
  }
}

/** Operator-only custody preparation. This neither compacts SQL nor proves the
 * product reader/replay path; the caller must complete those checks afterwards. */
export async function retainVerifiedLegacyWorkerVolume(input: {
  host: string;
  container: string;
  verifiedPackedBytes: Buffer;
  object: LegacyBackupObject;
}): Promise<{ storedSha256: string; storedByteSize: number; verified: true }> {
  assertLegacyObject(input.object);
  if (
    input.verifiedPackedBytes.length !== input.object.byteSize ||
    legacySha256(input.verifiedPackedBytes) !== input.object.sha256
  )
    throw new Error(
      "Worker working copy must use the exact verified GCS packed bytes",
    );
  if (
    !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input.host) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.container)
  )
    throw new Error("Invalid exact worker SSH/container target");
  const options = [
    "-T",
    "-C",
    "-oBatchMode=yes",
    "-oStrictHostKeyChecking=yes",
    "-oConnectTimeout=10",
    input.host,
  ];
  const script = "/app/apps/sweeper/src/worker-report-volume-cli.ts";
  const available = await new Promise<boolean>((resolve) => {
    execFile(
      "ssh",
      [...options, `docker exec ${input.container} test -r ${script}`],
      { timeout: 15000, maxBuffer: 65536 },
      (error) => resolve(!error),
    );
  });
  if (!available)
    throw new LegacyWorkerVolumeUnavailable(
      "Worker volume CLI is unavailable; keep the 0198 local-payload fallback",
    );
  const command = `docker exec -i ${input.container} node --import tsx ${script} store ${input.object.sha256} ${input.object.byteSize}`;
  const text = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "ssh",
      [...options, legacyOperatorWriteCommand(command)],
      {
        timeout: 120000,
        maxBuffer: 65536,
        encoding: "utf8",
        killSignal: "SIGTERM",
      },
      (error, stdout) =>
        error ? reject(legacyOperatorWriteFailure(error)) : resolve(stdout),
    );
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(input.verifiedPackedBytes);
  });
  const result = JSON.parse(text) as {
    storedSha256: string;
    storedByteSize: number;
    verified: true;
  };
  if (
    result.storedSha256 !== input.object.sha256 ||
    result.storedByteSize !== input.object.byteSize ||
    result.verified !== true
  )
    throw new Error(
      "Worker volume acknowledgement differs from the exact GCS identity",
    );
  return result;
}
