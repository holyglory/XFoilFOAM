import { createHash, type Hash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { isUtf8 } from "node:buffer";
import { reportTextIdentity } from "./progressive-report-archive";
import {
  LEGACY_HASH,
  LEGACY_UUID,
  legacyBound,
  type LegacyReportMember,
  type LegacyReportKind,
  type LegacyReportScope,
} from "./legacy-report-storage";

const legacySha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
interface LegacyBackupObject {
  bucket: string;
  objectKey: string;
  generation: string;
  sha256: string;
  byteSize: number;
  crc32c: string;
  verifiedAt: string;
}
function assertLegacyObject(object: LegacyBackupObject): void {
  if (
    !LEGACY_HASH.test(object.sha256) ||
    !Number.isSafeInteger(object.byteSize) ||
    object.byteSize < 1 ||
    object.byteSize > 512 * 1024 ** 2 ||
    !/^[1-9][0-9]{0,19}$/.test(object.generation)
  )
    throw new Error("Invalid immutable legacy backup identity");
}
export interface LegacyCursor {
  execution: number;
  kind: LegacyReportKind;
  after: number;
  copied: number;
}
export interface LegacyBackupPage {
  version: 1;
  scopeSha256: string;
  sourceInstance: string;
  solverId: string;
  start: LegacyCursor;
  next: LegacyCursor;
  members: LegacyReportMember[];
}
export interface LegacyBackupReceipt {
  version: 1;
  scopeSha256: string;
  sourceInstance: string;
  solverId: string;
  start: LegacyCursor;
  next: LegacyCursor;
  object: LegacyBackupObject;
  memberCount: number;
  rawByteSize: number;
}
function checkLegacyMemberIdentity(member: LegacyReportMember): void {
  if (
    !LEGACY_UUID.test(member.executionId) ||
    !["report", "conflict"].includes(member.kind) ||
    !LEGACY_HASH.test(member.contentSignature) ||
    !LEGACY_HASH.test(member.reportSha256) ||
    !LEGACY_HASH.test(member.rowSha256) ||
    typeof member.rowText !== "string" ||
    typeof member.reportText !== "string"
  )
    throw new Error("Exact legacy member proof failed");
  legacyBound(member.sequence, Number.MAX_SAFE_INTEGER, "member sequence");
}

export function checkLegacyMember(member: LegacyReportMember): void {
  checkLegacyMemberIdentity(member);
  if (
    legacySha256(member.rowText) !== member.rowSha256 ||
    legacySha256(member.reportText) !== member.reportSha256 ||
    Buffer.byteLength(member.reportText) !== member.reportByteSize
  )
    throw new Error("Exact legacy member proof failed");
}

// Content-defined boundaries align again after changing sequence/status prefixes.
// Chunks are byte identities, not JSON values; numbers and unknown fields are opaque.
function splitLegacyBytes(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0,
    rolling = 0;
  // Align the large result even when outer timestamps/sequence lengths change.
  // This is only a byte boundary; no JSON parsing or value rewriting occurs.
  const result = bytes.indexOf('"result": ');
  const anchor = result < 0 ? -1 : result + 10;
  for (let i = 0; i < bytes.length; i++) {
    rolling = ((rolling << 1) + Math.imul(bytes[i] + 1, 0x9e3779b1)) >>> 0;
    const length = i + 1 - start;
    if (
      i + 1 === anchor ||
      length >= 65536 ||
      (length >= 8192 && (rolling & 32767) === 0)
    ) {
      parts.push(bytes.subarray(start, i + 1));
      start = i + 1;
      rolling = 0;
    }
  }
  if (start < bytes.length) parts.push(bytes.subarray(start));
  return parts;
}

export function encodeLegacyPage(page: LegacyBackupPage): {
  bytes: Buffer;
  rawByteSize: number;
} {
  const { members, ...header } = page;
  const chunks = new Map<string, Buffer>();
  const references = (text: string) =>
    splitLegacyBytes(Buffer.from(text)).map((bytes) => {
      const hash = legacySha256(bytes);
      const old = chunks.get(hash);
      if (old && !old.equals(bytes))
        throw new Error("Legacy chunk hash collision");
      chunks.set(hash, bytes);
      return hash;
    });
  const wireMembers = members.map(({ rowText, reportText, ...member }) => ({
    type: "member",
    ...member,
    rowChunks: references(rowText),
    reportChunks: references(reportText),
  }));
  const raw = Buffer.from(
    [
      JSON.stringify({
        type: "header",
        ...header,
        encoding: "sha256-chunks-v1",
      }),
      ...Array.from(chunks, ([sha256, bytes]) =>
        JSON.stringify({
          type: "chunk",
          sha256,
          base64: bytes.toString("base64"),
        }),
      ),
      ...wireMembers.map((member) => JSON.stringify(member)),
      JSON.stringify({ type: "end", memberCount: members.length }),
    ].join("\n") + "\n",
  );
  return { bytes: gzipSync(raw, { level: 9 }), rawByteSize: raw.length };
}

// Dictionary references identify exact bytes. Keep the UTF-8 text and SHA-256
// state of the shared leading chunks for this decode only. A chunk boundary
// inside a code point takes the ordinary whole-string decoding path.
function commonReportChunks(records: { type: string; reportChunks?: unknown }[]): number {
  let first: unknown[] | undefined;
  let count = 0;
  let members = 0;
  for (const record of records) {
    if (record.type !== "member") continue;
    const chunks = record.reportChunks;
    members++;
    if (members > 128) throw new Error("Legacy backup member/chunk count mismatch");
    if (!Array.isArray(chunks) || chunks.length > 40000)
      throw new Error("Invalid legacy chunk references");
    if (first === undefined) {
      first = chunks;
      count = chunks.length;
    } else {
      const limit = Math.min(count, chunks.length);
      count = 0;
      while (count < limit && chunks[count] === first[count]) count++;
    }
  }
  return members > 1 ? count : 0;
}

interface LegacyTextPrefix {
  chunkCount: number;
  byteSize: number;
  text: string;
  hash: Hash;
}

interface LegacyTextProof {
  readonly reportSha256: string;
  readonly reportByteSize: number;
  readonly rowSha256: string;
  readonly rowByteSize: number;
}

// Only the dictionary decoder can publish a proof. Keep it with the decoded
// member's lifetime. The public member and its metadata remain mutable.
const decodedTexts = new WeakMap<LegacyReportMember, {
  rowText: string;
  reportText: string;
  reportPrefix?: string;
  reportSuffix: string;
  proof: LegacyTextProof;
}>();

/** A caller can snapshot a mutable member before an asynchronous restore.
 * Reuse authenticated hashes only for the two exact strings in that snapshot. */
export function legacyMemberTextProof(
  member: LegacyReportMember,
  source = member,
): LegacyTextProof {
  const decoded = decodedTexts.get(source);
  if (decoded && decoded.reportText === member.reportText && decoded.rowText === member.rowText)
    return decoded.proof;
  // Legacy inline pages, caller-built pages and changed strings still take
  // the full UTF-8 round trip and exact byte hashes.
  const report = reportTextIdentity(member.reportText);
  const row = reportTextIdentity(member.rowText);
  return {
    reportSha256: report.sha256, reportByteSize: report.byteSize,
    rowSha256: row.sha256, rowByteSize: row.byteSize,
  };
}

/** Compare the actual decoded strings, including for a caller-supplied page.
 * Matching section boundaries allow literal equality without flattening two
 * full reports for every sibling. The independently decoded prefixes may differ. */
export function sameLegacyMemberText(
  actual: LegacyReportMember,
  expected: LegacyReportMember,
  source = expected,
): boolean {
  if (actual.rowText !== expected.rowText) return false;
  const left = decodedTexts.get(actual);
  const right = decodedTexts.get(source);
  if (
    left?.reportPrefix !== undefined && right?.reportPrefix !== undefined &&
    left.reportText === actual.reportText && right.reportText === expected.reportText &&
    left.reportPrefix.length === right.reportPrefix.length
  ) {
    return left.reportPrefix === right.reportPrefix && left.reportSuffix === right.reportSuffix;
  }
  return actual.reportText === expected.reportText;
}

function decodeChunkText(chunks: Buffer[], expectedSha: string, prefix?: LegacyTextPrefix) {
  const bytes = Buffer.concat(prefix ? chunks.slice(prefix.chunkCount) : chunks);
  if (!isUtf8(bytes)) throw new Error("Invalid legacy UTF-8 bytes");
  const hash = prefix ? prefix.hash.copy() : createHash("sha256");
  if (hash.update(bytes).digest("hex") !== expectedSha)
    throw new Error("Exact legacy member proof failed");
  const suffix = bytes.toString("utf8");
  return {
    text: (prefix?.text ?? "") + suffix,
    suffix,
    byteSize: (prefix?.byteSize ?? 0) + bytes.length,
  };
}

/** Also reads pre-dictionary canary bundles. No fake GCS receipt for local staging. */
export function inspectLegacyPage(
  bytes: Buffer,
  maxRawBytes = 512 * 1024 ** 2,
) {
  legacyBound(maxRawBytes, 512 * 1024 ** 2, "archive JSON bytes");
  const raw = gunzipSync(bytes, { maxOutputLength: maxRawBytes });
  if (raw[raw.length - 1] !== 10) throw new Error("Truncated legacy backup");
  const records = raw
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (records.length > 40130)
    throw new Error("Too many legacy chunk/member records");
  const header = records.shift();
  const end = records.pop();
  const { type: _type, encoding, ...identity } = header ?? {};
  if (
    header?.type !== "header" ||
    header.version !== 1 ||
    end?.type !== "end" ||
    (encoding !== undefined && encoding !== "sha256-chunks-v1")
  )
    throw new Error("Legacy backup manifest mismatch");
  const chunks = new Map<string, Buffer>();
  let uniqueBytes = 0;
  if (encoding) {
    for (const record of records.filter((r) => r.type === "chunk")) {
      if (
        !LEGACY_HASH.test(record.sha256) ||
        typeof record.base64 !== "string" ||
        record.base64.length > 87384
      )
        throw new Error("Invalid legacy byte chunk");
      const value = Buffer.from(record.base64, "base64");
      uniqueBytes += value.length;
      if (uniqueBytes > 256 * 1024 ** 2)
        throw new Error("Legacy unique chunks exceed decoded byte bound");
      if (
        value.length < 1 ||
        value.length > 65536 ||
        value.toString("base64") !== record.base64 ||
        legacySha256(value) !== record.sha256 ||
        chunks.has(record.sha256)
      )
        throw new Error("Legacy chunk hash/identity mismatch");
      chunks.set(record.sha256, value);
    }
  }
  let decodedBytes = 0;
  const used = new Set<string>();
  const resolve = (hashes: unknown) => {
    if (!Array.isArray(hashes) || hashes.length > 40000)
      throw new Error("Invalid legacy chunk references");
    return hashes.map((hash) => {
      const value = chunks.get(hash);
      if (!value) throw new Error("Missing legacy byte chunk");
      used.add(hash);
      decodedBytes += value.length;
      if (decodedBytes > 256 * 1024 ** 2)
        throw new Error("Legacy decoded page exceeds logical byte bound");
      return value;
    });
  };
  const prefixLength = encoding ? commonReportChunks(records) : 0;
  let prefix: LegacyTextPrefix | undefined;
  const members: LegacyReportMember[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (record.type === "chunk" && encoding) continue;
    if (record.type !== "member")
      throw new Error("Invalid legacy backup record");
    const { type: _memberType, rowChunks, reportChunks, ...member } = record;
    if (encoding) {
      const row = decodeChunkText(resolve(rowChunks), member.rowSha256);
      member.rowText = row.text;
      // Resolve and charge every reference even when its bytes are shared.
      const parts = resolve(reportChunks);
      if (!members.length && prefixLength) {
        const shared = Buffer.concat(parts.slice(0, prefixLength));
        if (isUtf8(shared)) {
          prefix = {
            chunkCount: prefixLength,
            byteSize: shared.length,
            text: shared.toString("utf8"),
            hash: createHash("sha256").update(shared),
          };
        }
      }
      const report = decodeChunkText(parts, member.reportSha256, prefix);
      member.reportText = report.text;
      checkLegacyMemberIdentity(member);
      if (report.byteSize !== member.reportByteSize) throw new Error("Exact legacy member proof failed");
      decodedTexts.set(member, {
        rowText: row.text,
        reportText: report.text,
        reportPrefix: prefix?.text,
        reportSuffix: report.suffix,
        proof: Object.freeze({
          reportSha256: member.reportSha256, reportByteSize: report.byteSize,
          rowSha256: member.rowSha256, rowByteSize: row.byteSize,
        }),
      });
    } else {
      decodedBytes +=
        Buffer.byteLength(member.rowText) +
        Buffer.byteLength(member.reportText);
      if (decodedBytes > 256 * 1024 ** 2)
        throw new Error("Legacy decoded page exceeds logical byte bound");
      checkLegacyMember(member);
    }
    const key = `${member.kind}:${member.executionId}:${member.sequence}`;
    if (seen.has(key)) throw new Error("Duplicate legacy backup member");
    seen.add(key);
    members.push(member);
  }
  if (
    members.length > 128 ||
    end.memberCount !== members.length ||
    used.size !== chunks.size
  )
    throw new Error("Legacy backup member/chunk count mismatch");
  return {
    page: { ...identity, members } as LegacyBackupPage,
    rawByteSize: raw.length,
    decodedBytes,
    uniqueChunkBytes: [...chunks.values()].reduce((n, b) => n + b.length, 0),
  };
}

export function decodeLegacyPage(
  bytes: Buffer,
  receipt: LegacyBackupReceipt,
): LegacyBackupPage {
  assertLegacyObject(receipt.object);
  if (
    bytes.length !== receipt.object.byteSize ||
    legacySha256(bytes) !== receipt.object.sha256 ||
    receipt.version !== 1
  )
    throw new Error("Legacy backup object proof failed");
  const inspected = inspectLegacyPage(bytes, receipt.rawByteSize);
  const actual = inspected.page;
  if (
    inspected.rawByteSize !== receipt.rawByteSize ||
    actual.members.length !== receipt.memberCount ||
    actual.scopeSha256 !== receipt.scopeSha256 ||
    actual.sourceInstance !== receipt.sourceInstance ||
    actual.solverId !== receipt.solverId ||
    !sameLegacyCursor(actual.start, receipt.start) ||
    !sameLegacyCursor(actual.next, receipt.next)
  )
    throw new Error("Legacy backup manifest mismatch");
  return actual;
}

export function sameLegacyCursor(a: LegacyCursor, b: LegacyCursor): boolean {
  return (
    a.execution === b.execution &&
    a.kind === b.kind &&
    a.after === b.after &&
    a.copied === b.copied
  );
}

export interface LegacyExactMemberIdentity {
  storedSha256: string;
  storedByteSize: number;
  sourceInstance: string;
  solverId: string;
  scopeSha256: string;
  executionId: string;
  sequence: number;
  kind: "report" | "conflict";
  contentSignature: string;
  reportSha256: string;
  reportByteSize: number;
}

export interface LegacyExactPageMemberIdentity {
  executionId: string;
  sequence: number;
  kind: "report" | "conflict";
  contentSignature: string;
  reportSha256: string;
  reportByteSize: number;
  rowSha256?: string;
  rowByteSize?: number;
}

export interface LegacyExactPageIdentity {
  storedSha256: string;
  storedByteSize: number;
  sourceInstance: string;
  solverId: string;
  scopeSha256: string;
  members: readonly LegacyExactPageMemberIdentity[];
}

/** Authenticate and reconstruct one complete immutable page once. Its expected
 * member set is exact, so no missing, duplicate, or unchecked sibling can hide
 * behind a successful selected-member lookup. Returns original text in the
 * expected key order; signatures remain independent of PostgreSQL byte hashes. */
export function readLegacyPageMembers(
  bytes: Buffer,
  identity: LegacyExactPageIdentity,
): LegacyReportMember[] {
  legacyBound(identity.members.length, 128, "exact page members");
  legacyBound(identity.storedByteSize, 512 * 1024 ** 2, "exact page stored bytes");
  if (!LEGACY_HASH.test(identity.scopeSha256) || !LEGACY_UUID.test(identity.solverId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(identity.sourceInstance))
    throw new Error("Legacy page source/scope identity mismatch");
  if (!Buffer.isBuffer(bytes) || !LEGACY_HASH.test(identity.storedSha256) || bytes.length !== identity.storedByteSize ||
    legacySha256(bytes) !== identity.storedSha256)
    throw new Error("Legacy page archive identity mismatch");
  const { page } = inspectLegacyPage(bytes);
  if (page.sourceInstance !== identity.sourceInstance || page.solverId !== identity.solverId ||
    page.scopeSha256 !== identity.scopeSha256 || page.members.length !== identity.members.length)
    throw new Error("Legacy page source/scope or complete member set differs");
  const key = (member: Pick<LegacyExactPageMemberIdentity, "kind" | "executionId" | "sequence">) =>
    `${member.kind}:${member.executionId}:${member.sequence}`;
  const actual = new Map(page.members.map((member) => [key(member), member]));
  const seen = new Set<string>();
  return identity.members.map((expected) => {
    const id = key(expected);
    const member = actual.get(id);
    if (seen.has(id)) throw new Error("Duplicate expected legacy page member");
    seen.add(id);
    if (!member || member.sequence !== expected.sequence || member.solverId !== identity.solverId ||
      member.contentSignature !== expected.contentSignature ||
      member.reportSha256 !== expected.reportSha256 || member.reportByteSize !== expected.reportByteSize ||
      (expected.rowSha256 !== undefined && member.rowSha256 !== expected.rowSha256) ||
      (expected.rowByteSize !== undefined && Buffer.byteLength(member.rowText) !== expected.rowByteSize))
      throw new Error("Exact legacy page member is missing or differs from catalog");
    return member;
  });
}

/** Caller authenticates the exact immutable object grant. Returns one original
 * member only; all sibling and chunk hashes are still checked before returning. */
export function readLegacyPageMember(
  bytes: Buffer,
  identity: LegacyExactMemberIdentity,
): LegacyReportMember {
  if (
    !LEGACY_HASH.test(identity.storedSha256) ||
    bytes.length !== identity.storedByteSize ||
    legacySha256(bytes) !== identity.storedSha256
  )
    throw new Error("Legacy member archive identity mismatch");
  const { page } = inspectLegacyPage(bytes);
  if (
    page.sourceInstance !== identity.sourceInstance ||
    page.solverId !== identity.solverId ||
    page.scopeSha256 !== identity.scopeSha256
  )
    throw new Error("Legacy member source/scope identity mismatch");
  const member = page.members.find(
    (member) =>
      member.executionId === identity.executionId &&
      member.sequence === identity.sequence &&
      member.kind === identity.kind,
  );
  if (
    !member ||
    member.contentSignature !== identity.contentSignature ||
    member.reportSha256 !== identity.reportSha256 ||
    member.reportByteSize !== identity.reportByteSize
  )
    throw new Error("Exact legacy member is missing or differs from catalog");
  return member;
}
