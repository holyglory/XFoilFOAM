import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  splitProgressiveReportText,
  type ProgressiveReportArchiveReadIdentity,
  type ReportJson,
} from "@aerodb/db/progressive-report-archive";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import {
  checkReportObjectPin,
  hashPattern,
  sha256,
  type ReportObjects,
  type ReportObjectPin,
} from "./shared-report-objects";

export const SHARED_REPORT_FORMAT = "shared-result-v1";
const limit = 64 * 1024 ** 2;
const manifestLimit = 8 * 1024 ** 2;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const goodSize = (n: number, max: number) =>
  Number.isSafeInteger(n) && n > 0 && n <= max;

export interface SharedReportMember {
  sequence: number;
  signature: string;
  reportSha256: string;
  reportByteSize: number;
  inventorySignature: string;
  sourceListSha256: string;
  sourceCount: number;
  prefix: string;
  suffix: string;
  resultHash: string | null;
}
export interface SharedReportOwner {
  executionId: string;
  solverId: string;
  promiseId: string;
  assignmentSignature: string;
}
interface SharedResult {
  pin: ReportObjectPin;
  rawSize: number;
}
export interface SharedReportManifest extends SharedReportOwner {
  format: typeof SHARED_REPORT_FORMAT;
  members: SharedReportMember[];
  results: Record<string, SharedResult>;
}
export interface SharedReportInput extends SharedReportMember {
  resultSize?: number;
  loadResult?: () => Promise<string>;
}

interface RestoredResult {
  text: string;
  parsed: ReportJson;
  canonical: string;
  sources?: ReturnType<typeof retainedReportInventory>["sources"];
}
const resultKey = (s: ReportObjects, hash: string) =>
  `${s.prefix}/shared-result-v1/results/${hash.slice(0, 2)}/${hash}.json.gz`;
const manifestKey = (s: ReportObjects, id: string, hash: string) =>
  `${s.prefix}/shared-result-v1/remote/${id}/${hash}.json.gz`;
const gunzip = (bytes: Buffer, max: number) =>
  utf8.decode(gunzipSync(bytes, { maxOutputLength: max }));

function verifyManifest(s: ReportObjects, value: SharedReportManifest) {
  if (
    value.format !== SHARED_REPORT_FORMAT ||
    !uuid.test(value.executionId) ||
    !uuid.test(value.solverId) ||
    !uuid.test(value.promiseId) ||
    !hashPattern.test(value.assignmentSignature) ||
    !Array.isArray(value.members) ||
    !goodSize(value.members.length, 128) ||
    !value.results ||
    Array.isArray(value.results) ||
    typeof value.results !== "object"
  )
    throw new Error("Invalid shared report manifest");
  const used = new Set<string>(),
    signatures = new Set<string>();
  let last = 0,
    logical = 0;
  for (const m of value.members) {
    if (
      !Number.isSafeInteger(m.sequence) ||
      m.sequence <= last ||
      !hashPattern.test(m.signature) ||
      signatures.has(m.signature) ||
      !hashPattern.test(m.reportSha256) ||
      !hashPattern.test(m.inventorySignature) ||
      !hashPattern.test(m.sourceListSha256) ||
      !goodSize(m.reportByteSize, limit) ||
      !Number.isInteger(m.sourceCount) ||
      m.sourceCount < 0 ||
      typeof m.prefix !== "string" ||
      typeof m.suffix !== "string"
    )
      throw new Error("Invalid shared report member");
    last = m.sequence;
    signatures.add(m.signature);
    logical += m.reportByteSize;
    if (m.resultHash === null) {
      if (m.suffix !== "") throw new Error("Unsplit report has a suffix");
    } else {
      if (
        !hashPattern.test(m.resultHash) ||
        !Object.hasOwn(value.results, m.resultHash)
      )
        throw new Error("Missing shared result reference");
      used.add(m.resultHash);
    }
  }
  if (
    logical > 128 * 1024 ** 2 ||
    Object.keys(value.results).length !== used.size
  )
    throw new Error("Invalid shared report page bounds");
  for (const h of used) {
    const r = value.results[h];
    if (!r || !goodSize(r.rawSize, limit))
      throw new Error("Invalid shared scientific result size");
    checkReportObjectPin(r.pin, resultKey(s, h), limit + 65536);
  }
}

async function resultText(
  s: ReportObjects,
  hash: string,
  r: SharedResult,
  signal?: AbortSignal,
): Promise<RestoredResult> {
  checkReportObjectPin(r.pin, resultKey(s, hash), limit + 65536);
  const text = gunzip(await s.read(r.pin, limit + 65536, signal), r.rawSize);
  if (Buffer.byteLength(text) !== r.rawSize || sha256(text) !== hash)
    throw new Error("Shared scientific result failed raw-byte verification");
  const parsed = reportJsonObject(parseReportJson(text));
  return { text, parsed, canonical: canonicalReportJson(parsed) };
}

function restore(
  owner: SharedReportOwner,
  m: SharedReportMember,
  res?: RestoredResult,
) {
  const text = res ? m.prefix + res.text + m.suffix : m.prefix;
  const proof = reportTextIdentity(text);
  if (proof.byteSize !== m.reportByteSize || proof.sha256 !== m.reportSha256)
    throw new Error("Reconstructed report differs from original PG bytes");
  // Prove the cut is exactly the root token without parsing the large result again.
  const cut = splitProgressiveReportText(
    res ? m.prefix + "{}" + m.suffix : text,
  );
  if (
    res &&
    (cut.result !== "{}" || cut.prefix !== m.prefix || cut.suffix !== m.suffix)
  )
    throw new Error("Shared result root boundary changed");
  const v = cut.report;
  if (v.archivedReport === true) throw new Error("A compact header cannot be archived as an original");
  if (
    (!res && v.result !== null) ||
    v.executionId !== owner.executionId ||
    v.solverId !== owner.solverId ||
    v.promiseId !== owner.promiseId ||
    v.assignmentSignature !== owner.assignmentSignature ||
    canonicalReportJson(v.sequence) !== String(m.sequence)
  )
    throw new Error("Shared report dispatch or sequence changed");
  const keys = Object.keys(v).sort((a, b) => a.localeCompare(b, "en"));
  const app = createHash("sha256").update("{");
  for (const [i, k] of keys.entries()) {
    app.update((i ? "," : "") + JSON.stringify(k) + ":");
    app.update(
      res && k === "result" ? res.canonical : canonicalReportJson(v[k]),
    );
  }
  if (app.update("}").digest("hex") !== m.signature)
    throw new Error("Shared report application signature changed");
  const sources = res
    ? (res.sources ??= retainedReportInventory(
        { ...v, result: res.parsed },
        m.signature,
      ).sources)
    : [];
  const inventory = sha256(
    canonicalReportJson({
      kind: "progressive-remote-report-inventory-v1",
      executionId: v.executionId,
      sequence: v.sequence,
      reportContentSignature: m.signature,
      sources,
    }),
  );
  if (inventory !== m.inventorySignature || sources.length !== m.sourceCount ||
    sha256(canonicalReportJson(sources)) !== m.sourceListSha256)
    throw new Error("Shared report source inventory changed");
  return text;
}

async function readManifest(
  store: ReportObjects,
  pin: ReportObjectPin,
  job: string,
  signal?: AbortSignal,
) {
  checkReportObjectPin(
    pin,
    manifestKey(store, job, pin.sha256),
    manifestLimit + 65536,
  );
  const manifest = JSON.parse(
    gunzip(await store.read(pin, manifestLimit + 65536, signal), manifestLimit),
  ) as SharedReportManifest;
  verifyManifest(store, manifest);
  if (manifest.executionId !== job)
    throw new Error("Shared report manifest belongs to another job");
  return manifest;
}

export async function readSharedReport(
  store: ReportObjects,
  id: ProgressiveReportArchiveReadIdentity,
  signal?: AbortSignal,
) {
  if (
    id.archiveFormat !== SHARED_REPORT_FORMAT ||
    id.sourceKind !== "remote" ||
    id.memberKind !== "report" ||
    id.bucket !== store.bucket ||
    id.mimeType !== "application/gzip" ||
    id.compression !== "gzip" ||
    !uuid.test(id.executionId)
  )
    throw new Error("Shared report requires its canonical hub generation");
  const manifest = await readManifest(
    store,
    {
      key: id.objectKey,
      generation: id.generation,
      sha256: id.storedSha256,
      size: id.storedByteSize,
      crc32c: id.crc32c,
    },
    id.executionId,
    signal,
  );
  if (
    (id.memberCount !== undefined &&
      manifest.members.length !== id.memberCount) ||
    (id.firstSequence !== undefined &&
      manifest.members[0].sequence !== id.firstSequence) ||
    (id.lastSequence !== undefined &&
      manifest.members.at(-1)!.sequence !== id.lastSequence)
  )
    throw new Error("Shared report page range changed");
  const m = manifest.members.find((x) => x.sequence === id.sequence);
  if (
    !m ||
    m.signature !== id.signature ||
    m.reportSha256 !== id.reportSha256 ||
    m.reportByteSize !== id.reportByteSize
  )
    throw new Error("Shared report does not match the registered member");
  const value = m.resultHash
    ? await resultText(
        store,
        m.resultHash,
        manifest.results[m.resultHash],
        signal,
      )
    : undefined;
  return restore(manifest, m, value);
}

/** Copy before publication. Every immutable result is stored once across pages;
 * each page freshly reopens its distinct generations once, including on replay. */
export async function writeSharedReportPage(
  store: ReportObjects,
  owner: SharedReportOwner,
  inputs: SharedReportInput[],
) {
  const results: SharedReportManifest["results"] = Object.create(null);
  const members: SharedReportMember[] = [];
  if (!goodSize(inputs.length, 128) || inputs.reduce((sum, m) => sum + m.reportByteSize, 0) > 128 * 1024 ** 2)
    throw new Error("Shared report inputs exceed page bounds");
  let resultBytesSubmitted = 0;
  for (const input of inputs) {
    const { resultSize, loadResult, ...m } = input;
    if (m.resultHash && !Object.hasOwn(results, m.resultHash)) {
      if (
        !hashPattern.test(m.resultHash) ||
        !resultSize ||
        !goodSize(resultSize, limit)
      )
        throw new Error("Invalid SQL scientific payload pin");
      const key = resultKey(store, m.resultHash);
      let pin = await store.find(key);
      if (!pin) {
        const value = await loadResult?.();
        if (
          !value ||
          Buffer.byteLength(value) !== resultSize ||
          sha256(value) !== m.resultHash
        )
          throw new Error("Source result differs from its SQL identity");
        const packed = gzipSync(value, { level: 9 });
        pin = await store.create(key, packed);
        resultBytesSubmitted += packed.length;
      }
      checkReportObjectPin(pin, key, limit + 65536);
      results[m.resultHash] = { pin, rawSize: resultSize };
    }
    if (m.resultHash && resultSize !== results[m.resultHash].rawSize)
      throw new Error("Inconsistent shared result size");
    members.push(m);
  }
  const manifest: SharedReportManifest = {
    format: SHARED_REPORT_FORMAT,
    ...owner,
    members,
    results,
  };
  verifyManifest(store, manifest);
  const plain = JSON.stringify(manifest);
  if (!goodSize(Buffer.byteLength(plain), manifestLimit))
    throw new Error("Shared report envelopes exceed their page budget");
  const bytes = gzipSync(plain, { level: 9 }),
    sum = sha256(bytes),
    key = manifestKey(store, owner.executionId, sum);
  const pin = await store.create(key, bytes);
  if (pin.sha256 !== sum || pin.size !== bytes.length)
    throw new Error("Stored manifest differs from the submitted page");
  const verified = await readManifest(store, pin, owner.executionId);
  const cache = new Map<string, RestoredResult>();
  for (const m of verified.members) {
    const h = m.resultHash;
    if (h && !cache.has(h))
      cache.set(h, await resultText(store, h, verified.results[h]));
    restore(verified, m, h ? cache.get(h) : undefined);
  }
  return { pin, manifest: verified, resultBytesSubmitted };
}
