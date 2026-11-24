import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import {
  reportTextIdentity,
  type ProgressiveReportArchiveEntry,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import type { WorkerResultAnchor } from "./worker-result-archive";

type Pin = ProgressiveReportArchiveReadIdentity & { resultAnchor?: WorkerResultAnchor };
type Visit = (pin: Pin, accept: (entry: ProgressiveReportArchiveEntry) => void) => Promise<void>;
const maxBytes = 32 * 1024 ** 2;
const physical = [
  "executionId", "sourceKind", "memberKind", "bucket", "objectKey", "generation", "crc32c",
  "archiveFormat", "mimeType", "compression", "storedSha256", "storedByteSize", "memberCount",
  "firstSequence", "lastSequence",
] as const;
function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error("Closed worker page differs from its exact registered members");
}

class ClosedWorkerPageRead {
  private authenticated?: { owner: string; texts: Promise<Map<number, string>> };

  constructor(private readonly pins: readonly Pin[]) {
    const first = pins[0];
    requireProof(pins.length >= 2 && pins.length <= 8 && first.memberCount === pins.length &&
      first.firstSequence === first.sequence && first.lastSequence === pins.at(-1)?.sequence &&
      first.sourceKind === "worker" && first.memberKind === "report" &&
      (first.archiveFormat === "jsonl" || first.archiveFormat === "worker-result-ref-v1") &&
      first.objectKey.endsWith(`/worker/${first.executionId}/${first.storedSha256}.jsonl.gz`));
    let total = 0;
    for (const [i, p] of pins.entries()) {
      requireProof(physical.every(k => p[k] === first[k]) &&
        isDeepStrictEqual(p.resultAnchor, first.resultAnchor) &&
        Number.isSafeInteger(p.reportByteSize) && p.reportByteSize > 0 &&
        (!i || p.sequence > pins[i - 1].sequence));
      total += p.reportByteSize;
    }
    requireProof(total <= maxBytes);
  }

  private async collect(visit: Visit) {
    const texts = new Map<number, string>();
    await visit(this.pins[0], (entry) => {
      const pin = this.pins[texts.size];
      requireProof(pin && entry.kind === pin.memberKind && entry.sourceKind === pin.sourceKind &&
        entry.executionId === pin.executionId && entry.sequence === pin.sequence &&
        entry.contentSignature === pin.signature);
      const proof = reportTextIdentity(entry.reportText);
      requireProof(proof.sha256 === pin.reportSha256 && proof.byteSize === pin.reportByteSize);
      texts.set(pin.sequence, entry.reportText);
    });
    requireProof(texts.size === this.pins.length);
    return texts;
  }

  async read(identity: Pin, owner: string, visit: Visit) {
    const p = this.pins.find(pin => pin.sequence === identity.sequence);
    requireProof(p && physical.every(k => identity[k] === p[k]) &&
      p.signature === identity.signature && p.reportSha256 === identity.reportSha256 &&
      p.reportByteSize === identity.reportByteSize &&
      (identity.resultAnchor === undefined || isDeepStrictEqual(identity.resultAnchor, p.resultAnchor)) &&
      (identity.workerResultSha256 === undefined || identity.workerResultSha256 === p.resultAnchor?.sha256));
    this.authenticated ??= { owner, texts: this.collect(visit) };
    requireProof(this.authenticated.owner === owner);
    const texts = await this.authenticated.texts;
    const text = texts.get(identity.sequence);
    requireProof(text !== undefined);
    return text;
  }
}

// One role and one bounded read or transaction. Only the visitor that authenticated
// the complete physical generation to EOF can populate this invocation's texts.
const active = new AsyncLocalStorage<ClosedWorkerPageRead>();
export const currentClosedWorkerPageRead = () => active.getStore();
export function withClosedWorkerPageRead<T>(pins: readonly Pin[], operation: () => Promise<T>) {
  return active.run(new ClosedWorkerPageRead(pins), operation);
}
