import { CRC32C } from "@google-cloud/storage";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import { addAbortSignal, Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import {
  readOwnedSharedReport,
  SHARED_REPORT_FORMAT,
  withSharedReportPageReads,
} from "./shared-report-archive";
import {
  sha256,
  type ReportObjectPin,
  type ReportObjectReader,
} from "./shared-report-objects";
import {
  readWorkerReportVolume,
  storeWorkerReportVolume,
} from "./worker-report-volume";
import type { ReportOwner, ReportPin } from "./registered-worker-report-read";

export type PinnedScientificResult = {
  hash: string;
  rawSize: number;
  pin: ReportObjectPin;
};
type Fetched = { pin: ReportObjectPin; bytes: Buffer };
export type SharedMember = {
  pin: ReportPin;
  text: string;
  scientific: PinnedScientificResult;
};
type ReadObject = ReportObjectReader["read"];
const maxTransfer = 40 * 1024 ** 2 + 8 * 65536;
function requireExact(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
export function registeredSharedKey(p: ReportPin) {
  return `/shared-result-v1/remote/${p.executionId}/${p.storedSha256}.json.gz`;
}
export class MissingRegisteredSharedObject extends HistoryOperationError {
  constructor() {
    super("registered_volume_missing", "transport", true);
  }
}
export const volumeSharedObject: ReadObject = async (p, limit, signal) => {
  requireExact(
    p.size <= limit,
    "Registered shared object exceeds its read limit",
  );
  const stream = await readWorkerReportVolume({
    storedSha256: p.sha256,
    storedByteSize: p.size,
  });
  if (!stream) throw new MissingRegisteredSharedObject();
  if (signal) addAbortSignal(signal, stream);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      requireExact(size <= p.size, "Registered shared working object grew");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    stream.destroy();
  }
};

// The manifest determines which immutable scientific object each requested signed
// member can access. Every invocation reopens and authenticates both generations.
export async function openRegisteredSharedPage(
  pins: readonly ReportPin[],
  owner: ReportOwner,
  read: ReadObject,
  signal = AbortSignal.timeout(30000),
) {
  const head = pins[0];
  requireExact(
    head &&
      pins.length <= 8 &&
      pins.reduce((n, p) => n + p.reportByteSize, 0) <= 32 * 1024 ** 2,
    "Invalid registered shared page bound",
  );
  const prefix =
    process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ?? "progressive-reports/v1";
  const objects = new Map<string, Fetched>();
  let total = 0;
  const store: ReportObjectReader = {
    bucket: head.bucket,
    prefix,
    async read(p, limit, abort) {
      abort?.throwIfAborted();
      const cached = objects.get(p.sha256);
      if (cached) {
        requireExact(
          isDeepStrictEqual(cached.pin, p),
          "Registered shared generation changed within one page",
        );
        return cached.bytes;
      }
      total += p.size;
      requireExact(
        objects.size < 1 + pins.length &&
          total <= maxTransfer &&
          p.size <= limit,
        "Registered shared transfer exceeds its bound",
      );
      const bytes = await read(p, limit, abort);
      const crc = new CRC32C();
      crc.update(bytes);
      requireExact(
        bytes.length === p.size &&
          sha256(bytes) === p.sha256 &&
          crc.toString() === p.crc32c,
        "Registered shared compressed generation differs",
      );
      objects.set(p.sha256, { pin: p, bytes });
      return bytes;
    },
  };
  const members = new Map<number, SharedMember>();
  await withSharedReportPageReads(async () => {
    for (const p of pins) {
      requireExact(
        p.sourceKind === "worker" &&
          p.memberKind === "report" &&
          p.archiveFormat === SHARED_REPORT_FORMAT &&
          p.executionId === owner.executionId &&
          p.bucket === head.bucket &&
          p.objectKey === prefix + registeredSharedKey(p) &&
          p.objectKey === head.objectKey &&
          p.generation === head.generation &&
          !members.has(p.sequence),
        "Shared native member has a different owner or generation",
      );
      const member = await readOwnedSharedReport(
        store,
        { ...p, sourceKind: "remote" },
        owner,
        signal,
      );
      requireExact(
        member.scientific && member.scientific.rawSize <= p.reportByteSize,
        "Registered shared member lacks its scientific generation",
      );
      members.set(p.sequence, {
        pin: p,
        text: member.text,
        scientific: member.scientific,
      });
    }
  });
  return { objects, members };
}
export async function stageSharedObjects(
  pins: readonly ReportPin[],
  owner: ReportOwner,
  manifest: Buffer | null,
  dependencies: readonly Buffer[],
  verify: (members: ReadonlyMap<number, SharedMember>) => void,
) {
  requireExact(
    manifest !== null || !dependencies.length,
    "Dependencies require their submitted manifest",
  );
  const received = new Map<string, Buffer>();
  for (const bytes of manifest ? [manifest, ...dependencies] : dependencies) {
    const hash = sha256(bytes);
    requireExact(
      !received.has(hash),
      "Duplicate registered shared transfer object",
    );
    received.set(hash, bytes);
  }
  requireExact(
    !manifest || sha256(manifest) === pins[0]!.storedSha256,
    "Registered shared manifest transfer differs",
  );
  const checked = await openRegisteredSharedPage(
    pins,
    owner,
    async (p, limit, signal) => {
      if (!manifest) return volumeSharedObject(p, limit, signal);
      const bytes = received.get(p.sha256);
      requireExact(
        bytes,
        "Submitted manifest lacks a selected scientific generation",
      );
      return bytes;
    },
  );
  verify(checked.members);
  // Validate the selected complete records before publishing any transfer object on HZ.
  for (const key of received.keys())
    requireExact(
      checked.objects.has(key),
      "Unreferenced registered shared transfer object",
    );
  for (const [hash, bytes] of received) {
    await storeWorkerReportVolume(Readable.from([bytes]), {
      storedSha256: hash,
      storedByteSize: bytes.length,
    });
  }
  return checked.members;
}
