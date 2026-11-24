import { CRC32C } from "@google-cloud/storage";
import { createHash, type Hash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Readable, addAbortSignal } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  assertProgressiveReportArchiveIdentity,
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  splitProgressiveReportText,
  visitVerifiedWorkerReportArchive,
  type ProgressiveReportArchiveEntry,
  type ProgressiveReportArchiveLimits,
  type ProgressiveReportArchiveReadIdentity as Member,
  type ProgressiveReportArchiveStoredIdentity as ObjectPin,
} from "@aerodb/db/progressive-report-archive";
import { canonicalLegacyResultSlot } from "@aerodb/db/legacy-report-signature";
import {
  retainedReportInventory,
  retainedReportInventorySignature,
} from "@aerodb/db/retained-solver-reports";
import { hashPattern, sha256 } from "./shared-report-objects";

export const WORKER_RESULT_REF = "worker-result-ref-v1";
const maxPage = 32 * 1024 ** 2;
const maxManifest = 1024 ** 2;
const limits = {
  maxMembers: 8,
  maxDecodedBytes: 2 * maxPage,
  maxReportBytes: maxPage,
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
const positive = (n: number, max: number) =>
  Number.isSafeInteger(n) && n > 0 && n <= max;

type Owner = {
  executionId: string;
  solverId: string;
  promiseId: string;
  assignmentSignature: string;
  workerInstance: string;
};
type Token = { sha256: string; byteSize: number };
export interface WorkerResultAnchor extends Token {
  member: Member;
}
interface Envelope {
  sequence: number;
  signature: string;
  reportSha256: string;
  reportByteSize: number;
  inventory: string;
  prefix: string;
  suffix: string;
}
interface Manifest {
  format: typeof WORKER_RESULT_REF;
  owner: Owner;
  anchor: WorkerResultAnchor;
  members: Envelope[];
}

function manifestOwner(o: Owner): Owner {
  return {
    executionId: o.executionId,
    solverId: o.solverId,
    promiseId: o.promiseId,
    assignmentSignature: o.assignmentSignature,
    workerInstance: o.workerInstance,
  };
}

export function assertWorkerAnchor(
  a: WorkerResultAnchor,
  owner: Owner,
  outer: ObjectPin,
) {
  const m = a.member;
  assertProgressiveReportArchiveIdentity(m);
  const suffix = (sha: string) =>
    `/worker/${owner.executionId}/${sha}.jsonl.gz`;
  const outerSuffix = suffix(outer.storedSha256);
  requireProof(
    outer.objectKey.endsWith(outerSuffix) &&
      m.objectKey ===
        outer.objectKey.slice(0, -outerSuffix.length) +
          suffix(m.storedSha256) &&
      m.bucket === outer.bucket &&
      m.executionId === owner.executionId &&
      m.sourceKind === "worker" &&
      m.memberKind === "report" &&
      m.archiveFormat === "jsonl" &&
      positive(m.storedByteSize, maxPage) &&
      BigInt(m.generation) <= 18446744073709551615n &&
      positive(m.memberCount!, 8) &&
      positive(m.firstSequence!, m.sequence) &&
      positive(m.sequence, m.lastSequence!) &&
      Number.isSafeInteger(m.lastSequence) &&
      m.memberCount! <= m.lastSequence! - m.firstSequence! + 1 &&
      hashPattern.test(m.signature) &&
      hashPattern.test(m.reportSha256) &&
      positive(m.reportByteSize, maxPage) &&
      hashPattern.test(a.sha256) &&
      positive(a.byteSize, m.reportByteSize),
    "Invalid same-execution self-contained worker result anchor",
  );
}

/** Only small envelopes travel after a previously registered full JSONL member
 * supplies the exact PostgreSQL result token. A dictionary is always one hop. */
export function encodeWorkerResultPage(
  owner: Owner,
  anchor: WorkerResultAnchor,
  originals: {
    text: string;
    cut?: { prefix: string; suffix: string };
    sequence: number;
    signature: string;
    facts: Token & { inventory: string };
  }[],
) {
  const members = originals.map(({ text, cut, sequence, signature, facts }) => {
    const { prefix, suffix } = cut ?? splitProgressiveReportText(text);
    const result = text.slice(prefix.length, text.length - suffix.length);
    const slot = splitProgressiveReportText(prefix + "{}" + suffix);
    requireProof(
      text.startsWith(prefix) &&
        text.endsWith(suffix) &&
        slot.result === "{}" &&
        slot.prefix === prefix &&
        slot.suffix === suffix,
      "Original worker result slot changed",
    );
    requireProof(
      result !== null &&
        Buffer.byteLength(result) === anchor.byteSize &&
        sha256(result) === anchor.sha256,
      "Original worker result differs from its dictionary",
    );
    return {
      sequence,
      signature,
      reportSha256: facts.sha256,
      reportByteSize: facts.byteSize,
      inventory: facts.inventory,
      prefix,
      suffix,
    };
  });
  const manifest: Manifest = {
    format: WORKER_RESULT_REF,
    owner: manifestOwner(owner),
    anchor,
    members,
  };
  const raw = JSON.stringify(manifest);
  if (Buffer.byteLength(raw) > maxManifest) return null;
  return gzipSync(raw, { level: 9 });
}

interface Dictionary {
  text: string;
  sources: ReturnType<typeof retainedReportInventory>["sources"];
  prefix?: { text: string; hash: Hash };
}
// Only the exact token, point identities and a signature prefix survive a read.
// Every read reopens both physical identities,
// including complete compressed bytes. Dispatch authorization belongs to the caller.
export class WorkerResultReadCache {
  current?: { key: string; dictionary: Dictionary };
}

async function checkedBytes(
  stream: Readable,
  p: ObjectPin,
  max: number,
  signal?: AbortSignal,
) {
  try {
    requireProof(
      positive(p.storedByteSize, max),
      "Worker result generation exceeds its byte bound",
    );
    if (signal) addAbortSignal(signal, stream);
    const chunks: Buffer[] = [],
      hash = createHash("sha256"),
      crc = new CRC32C();
    let n = 0;
    for await (const chunk of stream) {
      n += chunk.length;
      requireProof(
        n <= p.storedByteSize,
        "Worker result generation exceeds its pin",
      );
      chunks.push(chunk);
      hash.update(chunk);
      crc.update(chunk);
    }
    requireProof(
      n === p.storedByteSize &&
        hash.digest("hex") === p.storedSha256 &&
        crc.toString() === p.crc32c,
      "Worker result generation failed its physical SHA, CRC or size",
    );
    return Buffer.concat(chunks, n);
  } finally {
    stream.destroy();
  }
}

async function dictionaryFor(
  owner: Owner,
  a: WorkerResultAnchor,
  open: (member: Member) => Promise<Readable>,
  cache: WorkerResultReadCache,
  signal?: AbortSignal,
) {
  const m = a.member;
  const bytes = await checkedBytes(await open(m), m, maxPage, signal);
  const key = JSON.stringify([
    manifestOwner(owner),
    m.bucket,
    m.objectKey,
    m.generation,
    m.storedSha256,
    m.storedByteSize,
    m.crc32c,
    m.firstSequence,
    m.lastSequence,
    m.memberCount,
    m.sequence,
    m.signature,
    m.reportSha256,
    m.reportByteSize,
    a.sha256,
    a.byteSize,
  ]);
  if (cache.current?.key === key) return cache.current.dictionary;
  cache.current = undefined;
  let dictionary: Dictionary | undefined;
  await visitVerifiedWorkerReportArchive(
    Readable.from([bytes]),
    m,
    owner,
    (entry) => {
      if (
        entry.kind !== "report" ||
        entry.sequence !== m.sequence ||
        entry.contentSignature !== m.signature
      )
        return;
      const exact = reportTextIdentity(entry.reportText);
      requireProof(
        exact.sha256 === m.reportSha256 && exact.byteSize === m.reportByteSize,
        "Worker anchor original changed",
      );
      const cut = splitProgressiveReportText(entry.reportText);
      requireProof(
        cut.result !== null &&
          Buffer.byteLength(cut.result) === a.byteSize &&
          sha256(cut.result) === a.sha256 &&
          reportJsonObject(cut.report.result!).job_id === owner.executionId,
        "Worker anchor scientific token changed",
      );
      const { sources } = retainedReportInventory(cut.report, m.signature);
      requireProof(
        sources.length > 0 && sources.length <= 512,
        "Worker anchor lost its point inventory",
      );
      const slot = canonicalLegacyResultSlot(cut.report);
      dictionary = { text: cut.result, sources };
      if (slot) {
        dictionary.prefix = {
          text: slot.prefix,
          hash: createHash("sha256")
            .update(slot.prefix)
            .update(canonicalReportJson(cut.report.result!)),
        };
      }
    },
    limits,
    signal,
  );
  requireProof(dictionary, "Signed worker dictionary member is missing");
  cache.current = { key, dictionary };
  return dictionary;
}

function restore(m: Envelope, owner: Owner, result: Dictionary) {
  const cut = splitProgressiveReportText(m.prefix + "{}" + m.suffix),
    report = cut.report;
  requireProof(
    cut.result === "{}" &&
      cut.prefix === m.prefix &&
      cut.suffix === m.suffix &&
      report.executionId === owner.executionId &&
      report.solverId === owner.solverId &&
      report.promiseId === owner.promiseId &&
      report.assignmentSignature === owner.assignmentSignature &&
      canonicalReportJson(report.version!) === "1" &&
      canonicalReportJson(report.sequence!) === String(m.sequence) &&
      reportJsonObject(report.status!).job_id === owner.executionId &&
      report.archivedReport !== true,
    "Worker dictionary envelope dispatch or result boundary changed",
  );
  const text = m.prefix + result.text + m.suffix,
    exact = reportTextIdentity(text);
  requireProof(
    exact.sha256 === m.reportSha256 && exact.byteSize === m.reportByteSize,
    "Worker dictionary original PG text changed",
  );
  const slot = canonicalLegacyResultSlot(report);
  let signature: string;
  if (slot) {
    if (result.prefix?.text !== slot.prefix)
      result.prefix = {
        text: slot.prefix,
        hash: createHash("sha256")
          .update(slot.prefix)
          .update(canonicalReportJson(parseReportJson(result.text))),
      };
    signature = result.prefix.hash.copy().update(slot.suffix).digest("hex");
  } else {
    const { report: full } = splitProgressiveReportText(text);
    signature = sha256(canonicalReportJson(full));
  }
  requireProof(
    signature === m.signature &&
      retainedReportInventorySignature(report, signature, result.sources) ===
        m.inventory,
    "Worker dictionary report signature or point inventory changed",
  );
  return text;
}

export async function visitWorkerReportGeneration(
  stream: Readable,
  pin: ObjectPin & { resultAnchor?: WorkerResultAnchor },
  owner: Owner,
  visit: (e: ProgressiveReportArchiveEntry) => void | Promise<void>,
  bounds: ProgressiveReportArchiveLimits,
  open: (member: Member) => Promise<Readable>,
  signal?: AbortSignal,
  cache = new WorkerResultReadCache(),
) {
  if (pin.archiveFormat !== WORKER_RESULT_REF)
    return visitVerifiedWorkerReportArchive(
      stream,
      pin,
      owner,
      visit,
      bounds,
      signal,
    );
  const bytes = await checkedBytes(stream, pin, maxManifest + 65536, signal);
  assertProgressiveReportArchiveIdentity(pin, WORKER_RESULT_REF);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    gunzipSync(bytes, { maxOutputLength: maxManifest }),
  );
  const page: Manifest = JSON.parse(raw);
  // The writer emits compact JSON. Enforcing its spelling also rejects duplicate
  // keys and rounded numeric metadata without parsing any scientific number.
  requireProof(
    JSON.stringify(page) === raw &&
      page.format === WORKER_RESULT_REF &&
      uuid.test(owner.executionId) &&
      uuid.test(owner.solverId) &&
      uuid.test(owner.promiseId) &&
      uuid.test(owner.workerInstance) &&
      hashPattern.test(owner.assignmentSignature) &&
      Object.entries(manifestOwner(owner)).every(
        ([k, v]) => page.owner?.[k as keyof Owner] === v,
      ) &&
      Array.isArray(page.members) &&
      positive(page.members.length, Math.min(8, bounds.maxMembers ?? 8)),
    "Worker dictionary manifest or owner changed",
  );
  assertWorkerAnchor(page.anchor, owner, pin);
  if (pin.workerResultSha256 !== undefined)
    requireProof(
      pin.workerResultSha256 === page.anchor.sha256,
      "Registered worker result token changed",
    );
  if (pin.resultAnchor)
    requireProof(
      isDeepStrictEqual(pin.resultAnchor, page.anchor),
      "Worker dictionary differs from its pending receipt",
    );
  let last = 0,
    total = 0;
  const signatures = new Set<string>();
  for (const m of page.members) {
    requireProof(
      positive(m.sequence, Number.MAX_SAFE_INTEGER) &&
        m.sequence > last &&
        hashPattern.test(m.signature) &&
        !signatures.has(m.signature) &&
        hashPattern.test(m.inventory) &&
        hashPattern.test(m.reportSha256) &&
        positive(
          m.reportByteSize,
          Math.min(maxPage, bounds.maxReportBytes ?? maxPage),
        ) &&
        typeof m.prefix === "string" &&
        typeof m.suffix === "string" &&
        m.reportByteSize ===
          Buffer.byteLength(m.prefix) +
            page.anchor.byteSize +
            Buffer.byteLength(m.suffix),
      "Invalid worker dictionary member",
    );
    last = m.sequence;
    signatures.add(m.signature);
    total += m.reportByteSize;
  }
  requireProof(
    total <= Math.min(maxPage, bounds.maxDecodedBytes ?? maxPage) &&
      (pin.memberCount === undefined ||
        pin.memberCount === page.members.length) &&
      (pin.firstSequence === undefined ||
        pin.firstSequence === page.members[0]!.sequence) &&
      (pin.lastSequence === undefined || pin.lastSequence === last),
    "Worker dictionary page inventory changed",
  );
  const result = await dictionaryFor(owner, page.anchor, open, cache, signal);
  for (const m of page.members) {
    signal?.throwIfAborted();
    await visit({
      kind: "report",
      sourceKind: "worker",
      executionId: owner.executionId,
      sequence: m.sequence,
      contentSignature: m.signature,
      reportText: restore(m, owner, result),
    });
  }
}
