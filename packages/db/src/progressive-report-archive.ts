import { createHash } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { createGunzip } from "node:zlib";

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export interface ProgressiveReportArchiveStoredIdentity {
  bucket: string;
  objectKey: string;
  generation: string;
  mimeType: string;
  compression: string;
  archiveFormat: string;
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  workerResultSha256?: string;
  memberCount?: number;
  firstSequence?: number;
  lastSequence?: number;
}

export interface ProgressiveReportArchiveReadIdentity extends ProgressiveReportArchiveStoredIdentity {
  sourceKind: "remote" | "worker";
  memberKind: "report" | "conflict";
  executionId: string;
  sequence: number;
  signature: string;
  reportSha256: string;
  reportByteSize: number;
}

// A numeric token is never converted to a JS number for storage or serialization.
export class ReportJsonNumber {
  constructor(readonly text: string) {}
}

export type ReportJson =
  | null
  | boolean
  | string
  | ReportJsonNumber
  | ReportJson[]
  | { [key: string]: ReportJson };

/** Preserves numeric tokens and rejects duplicate JSON object keys. */
export function parseReportJson(
  text: string,
  rootFields?: Map<string, string>,
): ReportJson {
  return parseWithResultSpan(text, rootFields);
}

// Offsets use UTF-16 code units, as does the immutable on-disk delta format.
// Only readers that keep the parsed result private may reuse a validated span.
interface ResultSpan { start: number; end: number; value: ReportJson }
interface ResultTracking {
  envelope?: boolean;
  reportStart?: number;
  reused?: ResultSpan;
  found?: ResultSpan;
}

function parseWithResultSpan(text: string, rootFields?: Map<string, string>, tracking?: ResultTracking): ReportJson {
  let at = 0;
  const space = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "x")) at++;
  };
  const fail = (): never => {
    throw new Error("Invalid report JSON");
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return JSON.parse(text.slice(start, at)) as string;
      if (char === "\\") at++;
    }
    return fail();
  };
  const value = (root = false, reportRoot = false): ReportJson => {
    space();
    if (text[at] === '"') return string();
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{";
      const close = object ? "}" : "]";
      const entries: Record<string, ReportJson> = Object.create(null);
      const items: ReportJson[] = [];
      space();
      if (text[at] === close) {
        at++;
        return object ? entries : items;
      }
      while (true) {
        space();
        if (object) {
          if (text[at] !== '"') fail();
          const key = string();
          space();
          if (text[at++] !== ":" || Object.hasOwn(entries, key)) fail();
          space();
          const start = at;
          const result = reportRoot && key === "result" && tracking;
          const reused = result && result.reused;
          if (reused && reused.start === start) {
            // The delta copied this complete object/array token unchanged.
            entries[key] = reused.value;
            at = reused.end;
          } else {
            const report = root && tracking?.envelope === true && key === "report";
            if (report) tracking.reportStart = start;
            entries[key] = value(false, report);
          }
          const parsed = entries[key];
          if (result && parsed !== null && typeof parsed === "object" && !(parsed instanceof ReportJsonNumber))
            result.found = { start, end: at, value: parsed };
          if (root) rootFields?.set(key, text.slice(start, at));
        } else items.push(value());
        space();
        const char = text[at++];
        if (char === close) return object ? entries : items;
        if (char !== ",") fail();
      }
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(token, at)) {
        at += token.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(at),
    );
    if (!number) return fail();
    at += number[0].length;
    return new ReportJsonNumber(number[0]);
  };
  const result = value(true, tracking !== undefined && !tracking.envelope);
  space();
  if (at !== text.length) fail();
  return result;
}

/** Slice only the root result token. Strings, nested lookalikes, number
 * spellings, and whitespace on either side stay in the original PG text. */
export function splitProgressiveReportText(text: string) {
  const tracking: ResultTracking = {};
  const report = reportJsonObject(parseWithResultSpan(text, undefined, tracking));
  if (!tracking.found) return { report, prefix: text, suffix: "", result: null };
  const { start, end } = tracking.found;
  return { report, prefix: text.slice(0, start), suffix: text.slice(end), result: text.slice(start, end) };
}

export function reportJsonObject(value: ReportJson): {
  [key: string]: ReportJson;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof ReportJsonNumber
  )
    throw new Error("Report JSON must be an object");
  return value;
}

function decimalIdentity(text: string): string {
  const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
  const [integer, fraction = ""] = mantissa!.split(".");
  const negative = integer!.startsWith("-");
  let digits = `${integer!.replace("-", "")}${fraction}`.replace(/^0+/, "");
  if (!digits) return "0";
  const zeros = digits.length - digits.replace(/0+$/, "").length;
  digits = digits.slice(0, digits.length - zeros);
  return `${negative ? "-" : ""}${digits}e${BigInt(exponent) - BigInt(fraction.length) + BigInt(zeros)}`;
}

function canonicalEntries(value: Record<string, ReportJson>) {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en"));
}

/** Matches analysis identities for ordinary numbers, without rounding other tokens. */
export function canonicalReportJson(value: ReportJson): string {
  if (value instanceof ReportJsonNumber) {
    const number = Number(value.text);
    if (Number.isFinite(number)) {
      const candidate = JSON.stringify(number);
      if (candidate === value.text || decimalIdentity(candidate) === decimalIdentity(value.text))
        return candidate;
    }
    return value.text;
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalReportJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${canonicalEntries(value)
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalReportJson(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

// A view for the existing domain validator and archive metadata. Its converted
// numbers never determine returned text or integrity digests. Overflow tokens
// stay objects, so numeric domain checks fail.
export function reportValidationValue(value: ReportJson): unknown {
  return validationValue(value);
}

/** Native JSON.parse produces this same independent domain view when every
 * numeric token fits a finite JS number. Neither view determines byte identities. */
export function reportValidationValueWithNumberRange(value: ReportJson) {
  let allNumbersFinite = true;
  const decoded = validationValue(value, () => { allNumbersFinite = false; });
  return { decoded, allNumbersFinite };
}

function validationValue(value: ReportJson, onOverflow?: () => void): unknown {
  if (value instanceof ReportJsonNumber) {
    const number = Number(value.text);
    if (Number.isFinite(number)) return number;
    onOverflow?.();
    return value;
  }
  if (Array.isArray(value)) return value.map(item => validationValue(item, onOverflow));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        validationValue(item, onOverflow),
      ]),
    );
  return value;
}

export function reportTextIdentity(text: string): {
  sha256: string;
  byteSize: number;
} {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text)
    throw new Error("Report text contains an unpaired UTF-16 surrogate");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function exactInteger(value: ReportJson | undefined, minimum: number): number {
  if (!(value instanceof ReportJsonNumber))
    throw new Error("Archive metadata requires integer tokens");
  const number = Number(value.text);
  if (
    !Number.isSafeInteger(number) ||
    number < minimum ||
    decimalIdentity(value.text) !== decimalIdentity(String(number))
  )
    throw new Error("Archive metadata requires exact safe integer tokens");
  return number;
}

export function assertProgressiveReportArchiveIdentity(
  identity: ProgressiveReportArchiveStoredIdentity,
  format: "jsonl" | "shared-result-v1" | "worker-result-ref-v1" = "jsonl",
): void {
  if (
    !identity.bucket.trim() ||
    !identity.objectKey.trim() ||
    !GENERATION.test(identity.generation) ||
    !SHA256.test(identity.storedSha256) ||
    !CRC32C.test(identity.crc32c) ||
    !positiveInteger(identity.storedByteSize) ||
    identity.mimeType !== "application/gzip" ||
    identity.compression !== "gzip" ||
    identity.archiveFormat !== format ||
    [identity.memberCount, identity.firstSequence, identity.lastSequence].some(
      (value) => value !== undefined && !positiveInteger(value),
    ) ||
    (identity.firstSequence !== undefined &&
      identity.lastSequence !== undefined &&
      identity.lastSequence < identity.firstSequence)
  )
    throw new Error("Invalid progressive report archive identity");
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  return crc >>> 0;
});

export interface ProgressiveReportArchiveEntry {
  sourceKind: "remote" | "worker";
  kind: "report" | "conflict";
  executionId: string;
  sequence: number;
  contentSignature: string;
  reportText: string;
}

export interface ProgressiveReportArchiveLimits {
  maxMembers?: number;
  /** Total decompressed JSONL bytes, including metadata and delta encodings. */
  maxDecodedBytes?: number;
  /** UTF-8 bytes in each reconstructed report. */
  maxReportBytes?: number;
}

class BundleDecoder {
  constructor(
    private readonly requireProof = false,
    private readonly maxReportBytes = Number.MAX_SAFE_INTEGER,
    private readonly reuseResult = false,
  ) {}
  private previousText: string | null = null;
  private previousResult?: ResultSpan;
  private readonly keys = new Set<string>();
  private readonly signatures = new Set<string>();
  count = 0;
  firstSequence = Infinity;
  lastSequence = 0;

  line(line: string) {
    // Root value spans preserve the text, including legacy rows whose report
    // was not last. Nested fields and quoted delimiters cannot confuse them.
    const fields = new Map<string, string>();
    const outer: ResultTracking | undefined = this.reuseResult ? { envelope: true } : undefined;
    const object = reportJsonObject(parseWithResultSpan(line, fields, outer));
    if (
      this.requireProof &&
      Object.hasOwn(object, "report") &&
      [...fields.keys()].at(-1) !== "report"
    )
      throw new Error("New inline archive rows must put report last");
    const metadata = reportValidationValue(
      Object.fromEntries(
        Object.entries(object).filter(
          ([key]) => key !== "report" && key !== "reportDelta",
        ),
      ),
    ) as Record<string, unknown>;
    if (
      !["remote", "worker"].includes(String(metadata.sourceKind)) ||
      !["report", "conflict"].includes(String(metadata.kind)) ||
      typeof metadata.executionId !== "string" ||
      !UUID.test(metadata.executionId) ||
      !positiveInteger(metadata.sequence) ||
      typeof metadata.contentSignature !== "string" ||
      !SHA256.test(metadata.contentSignature) ||
      Object.hasOwn(object, "report") === Object.hasOwn(object, "reportDelta")
    )
      throw new Error("Invalid progressive report archive member");
    exactInteger(object.sequence, 1);

    let reportText: string;
    let reused: ResultSpan | undefined;
    if (Object.hasOwn(object, "reportDelta")) {
      const delta = reportJsonObject(object.reportDelta!);
      const prefix = exactInteger(delta.prefix, 0);
      const suffix = exactInteger(delta.suffix, 0);
      const middle = delta.middle;
      if (
        Object.keys(delta).length !== 3 ||
        this.previousText === null ||
        typeof middle !== "string" ||
        prefix > this.previousText.length ||
        suffix > this.previousText.length - prefix
      )
        throw new Error("Invalid progressive report archive delta bounds");
      reportText =
        this.previousText.slice(0, prefix) +
        middle +
        (suffix ? this.previousText.slice(-suffix) : "");
      const previous = this.previousResult;
      if (previous && previous.end <= prefix) reused = previous;
      else if (previous && previous.start >= this.previousText.length - suffix) {
        const shift = reportText.length - this.previousText.length;
        reused = { start: previous.start + shift, end: previous.end + shift, value: previous.value };
      }
    } else {
      reportText = fields.get("report")!;
    }
    if (Buffer.byteLength(reportText, "utf8") > this.maxReportBytes)
      throw new Error(
        "Progressive report archive member exceeds its decoded report limit",
      );
    const inner: ResultTracking | undefined = this.reuseResult ? { reused } : undefined;
    const report = reportJsonObject(
      Object.hasOwn(object, "report")
        ? object.report!
        : parseWithResultSpan(reportText, undefined, inner),
    );
    const proof = reportTextIdentity(reportText);
    const hasProof =
      Object.hasOwn(object, "reportSha256") ||
      Object.hasOwn(object, "reportByteSize");
    if (this.requireProof && !hasProof)
      throw new Error("New archive rows require exact member hashes and sizes");
    if (
      (hasProof || Object.hasOwn(object, "reportDelta")) &&
      (metadata.reportSha256 !== proof.sha256 ||
        metadata.reportByteSize !== proof.byteSize)
    )
      throw new Error(
        "Progressive report archive member failed exact text verification",
      );
    if (hasProof) exactInteger(object.reportByteSize, 1);
    const prefix = `${metadata.sourceKind}:${metadata.executionId.toLowerCase()}:${metadata.kind}:`;
    const key = `${prefix}${metadata.sequence}`;
    const signature = `${prefix}${metadata.contentSignature}`;
    if (this.keys.has(key) || this.signatures.has(signature))
      throw new Error("Duplicate progressive report archive member");
    this.keys.add(key);
    this.signatures.add(signature);
    this.previousText = reportText;
    if (outer?.found && outer.reportStart !== undefined) {
      const { start, end, value } = outer.found;
      this.previousResult = { start: start - outer.reportStart, end: end - outer.reportStart, value };
    } else this.previousResult = inner?.found;
    this.count++;
    this.firstSequence = Math.min(
      this.firstSequence,
      Number(metadata.sequence),
    );
    this.lastSequence = Math.max(this.lastSequence, Number(metadata.sequence));
    return {
      entry: { ...metadata, reportText } as unknown as ProgressiveReportArchiveEntry,
      report,
    };
  }
}

/** Shared by the credential-free writer and the authenticated readers. */
export async function* validatedProgressiveReportArchiveLines(
  lines: AsyncIterable<string>,
): AsyncGenerator<Buffer> {
  // Only the encoded bytes leave this validator. A delta that copied its
  // entire scientific result can reuse that result's private parsed value.
  const decoder = new BundleDecoder(true, undefined, true);
  for await (const line of lines) {
    if (/[\r\n]/.test(line))
      throw new Error("Archive member must occupy exactly one JSONL line");
    decoder.line(line);
    yield Buffer.from(`${line}\n`, "utf8");
  }
  if (!decoder.count) throw new Error("Progressive report archive is empty");
}

async function consumeBundle(
  source: Readable,
  identity: ProgressiveReportArchiveStoredIdentity,
  visit: (
    entry: ProgressiveReportArchiveEntry,
    line: string,
    report: ReturnType<typeof reportJsonObject>,
  ) => void | Promise<void>,
  limits: ProgressiveReportArchiveLimits = {},
  signal?: AbortSignal,
  reuseResult = false,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    assertProgressiveReportArchiveIdentity(identity);
    if (
      Object.values(limits).some(
        (value) => value !== undefined && !positiveInteger(value),
      )
    )
      throw new Error("Invalid progressive report archive limits");
  } catch (error) {
    source.destroy();
    throw error;
  }
  const hash = createHash("sha256");
  let size = 0;
  let crc = 0xffffffff;
  const decoder = new BundleDecoder(false, limits.maxReportBytes, reuseResult);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  // A physical result can occupy one multi-megabyte JSONL line. Inspect each
  // decoded chunk once and join its pieces only when the line is complete.
  const pieces: string[] = [];
  let decodedBytes = 0;
  const accept = async (text: string) => {
    let start = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", start)) {
      pieces.push(text.slice(start, newline));
      const line = pieces.join("").replace(/\r$/, "");
      pieces.length = 0;
      start = newline + 1;
      if (limits.maxMembers !== undefined && decoder.count >= limits.maxMembers)
        throw new Error("Progressive report archive exceeds its member limit");
      const { entry, report } = decoder.line(line);
      await visit(entry, line, report);
    }
    if (start < text.length) pieces.push(text.slice(start));
  };
  await pipeline(
    source,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > identity.storedByteSize) {
          callback(new Error("Report archive exceeded stored byte size"));
          return;
        }
        hash.update(chunk);
        for (const byte of chunk)
          crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
        callback(null, chunk);
      },
      flush(callback) {
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        if (
          size !== identity.storedByteSize ||
          hash.digest("hex") !== identity.storedSha256 ||
          checksum.toString("base64") !== identity.crc32c
        )
          callback(
            new Error(
              "Report archive failed full compressed SHA-256/CRC32C verification",
            ),
          );
        else callback();
      },
    }),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          decodedBytes += chunk.length;
          if (
            limits.maxDecodedBytes !== undefined &&
            decodedBytes > limits.maxDecodedBytes
          )
            throw new Error(
              "Progressive report archive exceeds its decoded byte limit",
            );
          accept(utf8.decode(chunk, { stream: true })).then(
            () => callback(),
            (error) => callback(error as Error),
          );
        } catch (error) {
          callback(error as Error);
        }
      },
      final(callback) {
        const finish = async () => {
          await accept(utf8.decode());
          if (pieces.length || !decoder.count)
            throw new Error(
              "Truncated or empty progressive report archive JSONL",
            );
          if (
            (identity.memberCount !== undefined &&
              decoder.count !== identity.memberCount) ||
            (identity.firstSequence !== undefined &&
              decoder.firstSequence !== identity.firstSequence) ||
            (identity.lastSequence !== undefined &&
              decoder.lastSequence !== identity.lastSequence)
          )
            throw new Error(
              "Progressive report archive differs from its member inventory",
            );
        };
        finish().then(
          () => callback(),
          (error) => callback(error as Error),
        );
      },
    }),
    { signal },
  );
}

/** Visits entries sequentially; callbacks are provisional until full EOF proof resolves. */
export async function visitProgressiveReportArchive(
  source: Readable,
  identity: ProgressiveReportArchiveStoredIdentity,
  visitor: (
    entry: ProgressiveReportArchiveEntry,
    line: string,
    report: ReturnType<typeof reportJsonObject>,
  ) => void | Promise<void>,
  limits: ProgressiveReportArchiveLimits = {},
): Promise<void> {
  await consumeBundle(source, identity, visitor, limits);
}

export class WorkerReportMemberMismatch extends Error {}

/** Scope and sign every reconstructed envelope. Only the immutable text is
 * exposed to callers. The decoder reuses a parsed result solely when the delta
 * copies its entire validated token; even then each hash receives all its bytes. */
export async function visitVerifiedWorkerReportArchive(
  source: Readable,
  identity: ProgressiveReportArchiveStoredIdentity,
  owner: {
    executionId: string;
    solverId: string;
    promiseId: string;
    assignmentSignature: string;
  },
  visit: (entry: ProgressiveReportArchiveEntry) => void | Promise<void>,
  limits: ProgressiveReportArchiveLimits,
  signal?: AbortSignal,
): Promise<void> {
  return visitVerifiedSignedReportArchive("worker", source, identity, owner, visit, limits, signal);
}

/** A registered origin link keeps the hub's physical source kind. Both
 * readers authenticate every signature and the complete generation at EOF. */
export async function visitVerifiedSignedReportArchive(
  sourceKind: "worker" | "remote",
  source: Readable,
  identity: ProgressiveReportArchiveStoredIdentity,
  owner: {
    executionId: string;
    solverId: string;
    promiseId: string;
    assignmentSignature: string;
  },
  visit: (entry: ProgressiveReportArchiveEntry) => void | Promise<void>,
  limits: ProgressiveReportArchiveLimits,
  signal?: AbortSignal,
): Promise<void> {
  let previous: { result: ReportJson; bytes: Buffer } | undefined;
  await consumeBundle(
    source,
    identity,
    (entry, _line, report) => {
      if (
        entry.sourceKind !== sourceKind ||
        entry.executionId !== owner.executionId ||
        report.executionId !== owner.executionId ||
        report.solverId !== owner.solverId ||
        report.promiseId !== owner.promiseId ||
        report.assignmentSignature !== owner.assignmentSignature ||
        canonicalReportJson(report.version!) !== "1" ||
        canonicalReportJson(report.sequence!) !== String(entry.sequence)
      )
        throw new WorkerReportMemberMismatch(
          "Worker report archive member changed its exact dispatch scope",
        );

      const digest = createHash("sha256").update("{");
      let separator = "";
      for (const [key, value] of canonicalEntries(report)) {
        digest.update(separator + JSON.stringify(key) + ":");
        separator = ",";
        if (key === "result" && value !== null && typeof value === "object") {
          if (!previous || previous.result !== value)
            previous = {
              result: value,
              bytes: Buffer.from(canonicalReportJson(value), "utf8"),
            };
          digest.update(previous.bytes);
        } else {
          digest.update(canonicalReportJson(value));
        }
      }
      if (digest.update("}").digest("hex") !== entry.contentSignature)
        throw new WorkerReportMemberMismatch(
          "Worker report archive member failed content verification",
        );
      return visit(entry);
    },
    limits,
    signal,
    true,
  );
}

export async function readProgressiveReportArchiveBundle(
  source: Readable,
  identity: ProgressiveReportArchiveStoredIdentity,
): Promise<string> {
  const lines: string[] = [];
  await consumeBundle(source, identity, (_entry, line) => {
    lines.push(`${line}\n`);
  });
  return lines.join("");
}

export async function verifyProgressiveReportArchive(
  source: Readable,
  identity: ProgressiveReportArchiveStoredIdentity,
): Promise<void> {
  await consumeBundle(source, identity, () => {}, {}, undefined, true);
}

/** Returns the exact PG ::text, only after the entire generation has verified. */
export async function readProgressiveReportArchiveText(
  source: Readable,
  identity: ProgressiveReportArchiveReadIdentity,
  signal?: AbortSignal,
): Promise<string> {
  if (
    !["remote", "worker"].includes(identity.sourceKind) ||
    !["report", "conflict"].includes(identity.memberKind) ||
    !UUID.test(identity.executionId) ||
    !positiveInteger(identity.sequence) ||
    !SHA256.test(identity.signature) ||
    !SHA256.test(identity.reportSha256) ||
    !positiveInteger(identity.reportByteSize)
  ) {
    source.destroy();
    throw new Error("Invalid exact progressive report archive reference");
  }
  let found: string | null = null;
  await consumeBundle(source, identity, (entry) => {
    if (
      entry.sourceKind === identity.sourceKind &&
      entry.executionId.toLowerCase() === identity.executionId.toLowerCase() &&
      entry.kind === identity.memberKind &&
      entry.sequence === identity.sequence &&
      entry.contentSignature === identity.signature
    ) {
      const proof = reportTextIdentity(entry.reportText);
      if (
        proof.sha256 !== identity.reportSha256 ||
        proof.byteSize !== identity.reportByteSize
      )
        throw new Error(
          "Progressive report archive differs from its retained member identity",
        );
      found = entry.reportText;
    }
  }, {}, signal, true);
  if (found === null)
    throw new Error("Progressive report archive member was not found");
  return found;
}
