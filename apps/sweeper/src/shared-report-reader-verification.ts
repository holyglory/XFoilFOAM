import { readProgressiveReportArchive } from "../../api/src/progressive-report-archive-reader";
import { ProgressiveReportArchiveStore } from "./progressive-report-archive-store";
import {
  withSharedReportPageReads,
  SHARED_REPORT_FORMAT,
} from "./shared-report-archive";
import { sha256 } from "./shared-report-objects";
import type { StoppedCopyReceipt } from "./shared-stopped-report-custody";
import type { ProgressiveReportArchiveReadIdentity } from "@aerodb/db/progressive-report-archive";

type Reader = (
  id: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
) => Promise<string>;
export type SharedReportReaderPair = readonly [Reader, Reader];
export async function verifySharedReportReaders(
  receipt: StoppedCopyReceipt,
  supplied?: SharedReportReaderPair,
) {
  const sweep = new ProgressiveReportArchiveStore(receipt.bucket);
  for (const read of supplied ?? [
    readProgressiveReportArchive,
    sweep.read.bind(sweep),
  ]) {
    await withSharedReportPageReads(async () => {
      // Group by result for the bounded fresh verification. Each normal
      // adapter fetches each distinct generation once, independently.
      const members = [...receipt.members].sort((a, b) =>
        (a.resultHash ?? "").localeCompare(b.resultHash ?? ""),
      );
      for (const m of members) {
        const id: ProgressiveReportArchiveReadIdentity = {
          sourceKind: "remote",
          memberKind: "report",
          executionId: receipt.owner.executionId,
          sequence: m.sequence,
          signature: m.signature,
          reportSha256: m.reportSha256,
          reportByteSize: m.reportByteSize,
          bucket: receipt.bucket,
          objectKey: receipt.object.key,
          generation: receipt.object.generation,
          crc32c: receipt.object.crc32c,
          storedSha256: receipt.object.sha256,
          storedByteSize: receipt.object.size,
          archiveFormat: SHARED_REPORT_FORMAT,
          compression: "gzip",
          mimeType: "application/gzip",
          memberCount: receipt.members.length,
          firstSequence: receipt.members[0].sequence,
          lastSequence: receipt.members.at(-1)!.sequence,
        };
        const text = await read({ ...id, signal: AbortSignal.timeout(30_000) });
        if (
          Buffer.byteLength(text) !== m.reportByteSize ||
          sha256(text) !== m.reportSha256
        )
          throw new Error(
            "Normal hub reader returned different original bytes",
          );
      }
    });
  }
}
