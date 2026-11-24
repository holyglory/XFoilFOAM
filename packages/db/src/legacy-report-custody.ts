import { canonicalLegacyResultSlot as resultSlot } from "./legacy-report-signature";
import { createHash, type Hash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { LEGACY_HASH, LEGACY_UUID, legacyBound, type LegacyReportMember } from "./legacy-report-storage";
import { canonicalReportJson, reportJsonObject, parseReportJson, reportTextIdentity, reportValidationValue, type ProgressiveReportArchiveReadIdentity } from "./progressive-report-archive";
import type { JobResult } from "../../engine-client/src/types";
import { progressiveReportedPointSources } from "./progressive-remote-report";
import { legacyMemberTextProof, readLegacyPageMembers, sameLegacyMemberText } from "./legacy-report-storage-codec";

export interface LegacyCustodyObject {
  bucket: string;
  objectKey: string;
  generation: string;
  sha256: string;
  byteSize: number;
  crc32c: string;
  verifiedAt: string;
}

/** Structurally accepts the existing decoded LegacyBackupPage and receipt.object. */
export interface LegacyReportCustodyPage {
  version: 1;
  sourceInstance: string;
  solverId: string;
  scopeSha256: string;
  members: LegacyReportMember[];
}

export interface LegacyRegisteredReportReadIdentity extends ProgressiveReportArchiveReadIdentity {
  sourceKind: "worker";
  archiveFormat: "legacy-jsonl";
  legacyInstanceId: string;
  legacySolverId: string;
  legacyScopeSha256: string;
  legacyPageMemberCount: number;
  legacyReadMode: "registered-get" | "hub-local-reader";
  signal: AbortSignal;
}

export interface LegacyReportCustodyMemberProof {
  readonly kind: "report" | "conflict";
  readonly executionId: string;
  readonly sequence: number;
  readonly contentSignature: string;
  readonly reportSha256: string;
  readonly reportByteSize: number;
  readonly rowSha256: string;
  readonly rowByteSize: number;
}

/** One immutable object may contain several executions. The member vector is
 * the complete page, not a selected subset or one execution's local marker. */
export interface LegacyReportPageReadIdentity {
  sourceKind: "worker";
  archiveFormat: "legacy-jsonl";
  mimeType: "application/gzip";
  compression: "gzip";
  bucket: string;
  objectKey: string;
  generation: string;
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  legacyInstanceId: string;
  legacySolverId: string;
  legacyScopeSha256: string;
  legacyPageMemberCount: number;
  legacyReadMode: "registered-get" | "hub-local-reader";
  members: readonly LegacyReportCustodyMemberProof[];
  signal: AbortSignal;
}

/** Must issue a fresh, authenticated registered HZ GET, with no operator/GCS
 * fallback. It returns exact member text only after authenticating the entire
 * pinned object's bytes, including its legacy header and member dictionary. */
export interface LegacyRegisteredReportReader {
  read(identity: LegacyRegisteredReportReadIdentity): Promise<string>;
  /** Fresh registered GET of the entire pinned compressed object, once. */
  readPage?(identity: LegacyReportPageReadIdentity): Promise<Buffer>;
}

export interface LegacyRegisteredPageReader {
  readPage(identity: LegacyReportPageReadIdentity): Promise<Buffer>;
  read?(identity: LegacyRegisteredReportReadIdentity): Promise<string>;
}

export interface LegacyLocalProductReadback {
  reportText: string;
  /** Relative key returned by the normal shared persistent results-volume store.
   * This immutable copy must remain pinned while the DB catalog references it. */
  storageKey: string;
  storedBytes: Buffer;
  durableAt: string;
}

export type LegacyLocalPageProductReadback = Omit<LegacyLocalProductReadback, "reportText">;

export interface LegacyLocalProductReader {
  read(identity: LegacyRegisteredReportReadIdentity): Promise<LegacyLocalProductReadback>;
  /** Reopen the durable object through the normal worker reader once. The
   * shared consumer reconstructs and authenticates all members from these bytes. */
  readPage?(identity: LegacyReportPageReadIdentity): Promise<LegacyLocalPageProductReadback>;
}

export interface LegacyLocalPageProductReader {
  readPage(identity: LegacyReportPageReadIdentity): Promise<LegacyLocalPageProductReadback>;
  read?(identity: LegacyRegisteredReportReadIdentity): Promise<LegacyLocalProductReadback>;
}

export type LegacyCustodyProductRead =
  | { mode: "registered-get"; reader: LegacyRegisteredReportReader | LegacyRegisteredPageReader }
  | { mode: "hub-local-reader";
      readHubObject(identity: LegacyCustodyObject, signal: AbortSignal): Promise<Buffer>;
      /** Reopen the durable shared-volume object through the product reader;
       * an operator transfer buffer or a stale decoded cache is insufficient. */
      reader: LegacyLocalProductReader | LegacyLocalPageProductReader };

export interface VerifiedLegacyReportCustodyPage {
  readonly sourceInstance: string;
  readonly solverId: string;
  readonly scopeSha256: string;
  readonly readbackAt: string;
  readonly readMode: "registered-get" | "hub-local-reader";
  readonly localStorageKey: string | null;
  readonly memberCount: number;
  readonly memberProofs: readonly LegacyReportCustodyMemberProof[];
}

export class LegacyRegisteredRestoreUnavailable extends Error {
  readonly fallback = "verified-0198-normalization";
  constructor(cause: unknown) {
    super("Product restore did not verify the exact legacy bytes; retain inline data or use verified 0198 normalization", { cause });
    this.name = "LegacyRegisteredRestoreUnavailable";
  }
}

interface ScientificResultGroup {
  executionId: string;
  resultSha256: string;
  resultByteSize: number;
  resultText: string;
  pointSignatures: string[];
  reports: { sequence: number; contentSignature: string; envelopeText: string }[];
}

interface VerifiedScientificResult {
  group: ScientificResultGroup;
  signedPrefix?: { text: string; hash: Hash };
  inlineResultPrefix?: string;
}

function postgresEnvelope(fields: Map<string, string>, result: string): string {
  return `{${[...fields].map(([key, value]) =>
    `${JSON.stringify(key)}: ${key === "result" ? result : value}`).join(", ")}}`;
}

function appendScientificReport(group: ScientificResultGroup, member: LegacyReportMember, fields: Map<string, string>) {
  group.reports.push({ sequence: member.sequence, contentSignature: member.contentSignature,
    envelopeText: postgresEnvelope(fields, "null") });
}

function originalResultOffset(fields: ReadonlyMap<string, string>, result: string, text: string): number | undefined {
  if (!text.startsWith("{") || !fields.has("result")) return;
  let offset = 1;
  let resultStart: number | undefined;
  for (const [key, value] of fields) {
    const name = (offset === 1 ? "" : ", ") + JSON.stringify(key) + ": ";
    const original = key === "result" ? result : value;
    if (!text.startsWith(name, offset) || !text.startsWith(original, offset + name.length)) return;
    if (key === "result") resultStart = offset + name.length;
    offset += name.length + original.length;
  }
  if (offset === text.length - 1 && text[offset] === "}") return resultStart;
}

/** A 0198 hash is only a lookup hint. First match the entire original PG
 * report using the verified result text. Then copy the SHA-256 state only
 * if the bytes through the canonical result are identical to the prior row. */
function reuseScientificResult(member: LegacyReportMember, storedReport: string, prior: VerifiedScientificResult): boolean {
  if (!prior.signedPrefix) return false;
  const fields = new Map<string, string>();
  const envelope = reportJsonObject(parseReportJson(storedReport, fields));
  if (originalResultOffset(fields, prior.group.resultText, member.reportText) === undefined) return false;
  const slot = resultSlot(envelope);
  if (!slot || slot.prefix !== prior.signedPrefix.text) return false;
  if (prior.signedPrefix.hash.copy().update(slot.suffix).digest("hex") !== member.contentSignature)
    throw new Error("Legacy report canonical signature differs from its stored identity");
  appendScientificReport(prior.group, member, fields);
  return true;
}

// Preserve the PostgreSQL text used for whole-report reconstruction. Only the
// normal staging point identity uses the application's numerical representation.
function collectScientificSource(member: LegacyReportMember, groups: Map<string, ScientificResultGroup>,
  previous: VerifiedScientificResult | undefined, payloadHash: unknown, storedReport: string | undefined,
  inline: boolean): VerifiedScientificResult | undefined {
  if (member.kind !== "report") return;
  if (previous?.signedPrefix && previous.group.executionId === member.executionId) {
    if (previous.group.resultSha256 === payloadHash && storedReport?.startsWith("{") &&
      reuseScientificResult(member, storedReport, previous)) return previous;
    // The offsets came from parsing the actual root result on the first
    // member. Authenticate its complete token before omitting it from the
    // temporary parser input. The joined PG spelling and this member's
    // canonical transport signature are independently checked by reuseScientificResult.
    const prefix = previous.inlineResultPrefix;
    if (inline && prefix !== undefined && member.reportText.startsWith(prefix) &&
        member.reportText.startsWith(previous.group.resultText, prefix.length)) {
      const suffix = member.reportText.slice(prefix.length + previous.group.resultText.length);
      if (reuseScientificResult(member, prefix + "null" + suffix, previous)) return previous;
    }
  }

  const fields = new Map<string, string>();
  const report = parseReportJson(member.reportText, fields);
  const resultText = fields.get("result");
  const slot = resultText?.startsWith("{") ? resultSlot(reportJsonObject(report)) : undefined;
  let signedPrefix: VerifiedScientificResult["signedPrefix"];
  let signature: string;
  if (slot) {
    const hash = createHash("sha256").update(slot.prefix).update(canonicalReportJson(reportJsonObject(report).result!));
    signature = hash.copy().update(slot.suffix).digest("hex");
    signedPrefix = { text: slot.prefix, hash };
  } else {
    signature = createHash("sha256").update(canonicalReportJson(report)).digest("hex");
  }
  if (signature !== member.contentSignature)
    throw new Error("Legacy report canonical signature differs from its stored identity");
  if (!resultText?.startsWith("{")) return;
  const { sha256, byteSize } = reportTextIdentity(resultText);
  const key = `${member.executionId}:${sha256}:${byteSize}`;
  let group = groups.get(key);
  if (!group) {
    const result = reportValidationValue(reportJsonObject(report).result!) as JobResult;
    if (result.job_id !== member.executionId || !Array.isArray(result.polars) ||
      !result.polars.every(polar => polar && Array.isArray(polar.points) &&
        (polar.attempts == null || Array.isArray(polar.attempts)) &&
        [...polar.points, ...(polar.attempts ?? [])].every(point => point && Number.isFinite(point.aoa_deg)))) return;
    const pointSignatures = progressiveReportedPointSources(result).map(point => point.contentSignature).sort();
    if (pointSignatures.length === 0 || pointSignatures.length > 2048) return;
    group = { executionId: member.executionId, resultSha256: sha256, resultByteSize: byteSize, resultText, pointSignatures, reports: [] };
    groups.set(key, group);
  } else if (group.resultText !== resultText) {
    throw new Error("Scientific result digest collision");
  }
  appendScientificReport(group, member, fields);
  const offset = inline ? originalResultOffset(fields, resultText, member.reportText) : undefined;
  return { group, signedPrefix, inlineResultPrefix: offset === undefined ? undefined : member.reportText.slice(0, offset) };
}

// PostgreSQL places "report" first in a native worker row. The full text is
// already authenticated by its separate report and row digests. For this
// spelling only, parse its owner columns without parsing the identical nested
// report a second time. The original report still goes through the full
// scientific/signature check. All other row layouts use the original parser.
const inlineRowPrefix = '{"report": ';
function inlineRowMetadata(member: LegacyReportMember): string | undefined {
  if (member.kind !== "report" || !member.reportText.startsWith("{") ||
      !member.rowText.startsWith(inlineRowPrefix) ||
      !member.rowText.startsWith(member.reportText, inlineRowPrefix.length)) return;
  return inlineRowPrefix + "null" + member.rowText.slice(inlineRowPrefix.length + member.reportText.length);
}

interface BoundPage {
  version: 1;
  sourceInstance: string;
  solverId: string;
  scopeSha256: string;
  readbackAt: string;
  readbackStartedAt: string;
  readMode: "registered-get" | "hub-local-reader";
  localStorageKey: string | null;
  localVerifiedAt: string | null;
  object: Omit<ProgressiveReportArchiveReadIdentity, "executionId" | "sequence" | "memberKind" | "signature" | "reportSha256" | "reportByteSize">;
  members: readonly LegacyReportCustodyMemberProof[];
  scientificResults: ScientificResultGroup[];
}

const verified = new WeakMap<VerifiedLegacyReportCustodyPage, { page: BoundPage; startedAt: number }>();
const MAX_PAGE_BYTES = 256 * 1024 * 1024;
const READ_DEADLINE_MS = 120_000;
const PROOF_LIFETIME_MS = 300_000;

function verifyLocalProductObject(
  local: LegacyLocalPageProductReadback,
  hubBytes: Buffer | null,
  object: LegacyCustodyObject,
  priorKey: string | null,
): void {
  if (!hubBytes || !Buffer.isBuffer(local.storedBytes) || local.storedBytes.byteLength !== object.byteSize ||
    !local.storedBytes.equals(hubBytes) || !Number.isFinite(Date.parse(local.durableAt)) ||
    !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(local.storageKey) ||
    local.storageKey.split("/").some((part) => part === "." || part === "..") ||
    !local.storageKey.endsWith(`${object.sha256}.jsonl.gz`) ||
    (priorKey !== null && priorKey !== local.storageKey))
    throw new Error("Normal worker reader did not reopen the durable identical compressed legacy copy");
}

/** An operator receipt alone is insufficient. Recheck either the registered GET,
 * or both fresh pinned hub bytes and their durable normal-worker-reader copy. */
export async function verifyLegacyReportCustodyPage(
  input: { page: LegacyReportCustodyPage; object: LegacyCustodyObject; access: LegacyCustodyProductRead },
): Promise<VerifiedLegacyReportCustodyPage> {
  // Copy scalar identities before any asynchronous operation. A caller cannot
  // retarget a verified read by mutating its receipt while the GET is pending.
  if (!input.page || !Array.isArray(input.page.members)) throw new Error("Invalid legacy custody page");
  const sourceMembers = [...input.page.members];
  const page = { ...input.page, members: sourceMembers.map((member) => ({ ...member })) };
  const object = Object.freeze({ ...input.object });
  const sourceAccess = input.access;
  if (!sourceAccess || !["registered-get", "hub-local-reader"].includes(sourceAccess.mode))
    throw new Error("Legacy custody requires an explicit verified product read mode");
  const access = sourceAccess.mode === "hub-local-reader"
    ? Object.freeze({ mode: sourceAccess.mode, reader: sourceAccess.reader, readHubObject: sourceAccess.readHubObject.bind(sourceAccess) })
    : Object.freeze({ mode: sourceAccess.mode, reader: sourceAccess.reader });
  if (page.version !== 1 || !LEGACY_UUID.test(page.sourceInstance) || !LEGACY_UUID.test(page.solverId) ||
    !LEGACY_HASH.test(page.scopeSha256) || !Array.isArray(page.members))
    throw new Error("Legacy custody requires the registered worker instance UUID, solver UUID and exact scope digest");
  legacyBound(page.members.length, 128, "custody page members");
  if (!/^[a-z0-9][a-z0-9_.-]{1,220}[a-z0-9]$/.test(object.bucket) ||
    !LEGACY_HASH.test(object.sha256) || !/^[1-9][0-9]{0,19}$/.test(object.generation) ||
    !/^[A-Za-z0-9+/]{6}==$/.test(object.crc32c) || !Number.isFinite(Date.parse(object.verifiedAt)) ||
    object.objectKey !== `legacy-worker-reports/v1/${page.sourceInstance}/${page.solverId}/${page.scopeSha256}/${object.sha256}.jsonl.gz`)
    throw new Error("Legacy custody object differs from the exact registered worker namespace");
  legacyBound(object.byteSize, 2 * 1024 ** 3, "legacy object bytes");
  const members: LegacyReportCustodyMemberProof[] = [];
  const scientificResults = new Map<string, ScientificResultGroup>();
  let previousScientific: VerifiedScientificResult | undefined;
  const keys = new Set<string>();
  let bytes = 0;
  for (const [index, member] of page.members.entries()) {
    if (!["report", "conflict"].includes(member.kind) || !LEGACY_UUID.test(member.executionId) ||
      !LEGACY_HASH.test(member.contentSignature) || !LEGACY_HASH.test(member.reportSha256) ||
      !LEGACY_HASH.test(member.rowSha256) || member.solverId !== page.solverId)
      throw new Error("Legacy custody member has an invalid or foreign immutable identity");
    legacyBound(member.sequence, Number.MAX_SAFE_INTEGER, "legacy member sequence");
    const text = legacyMemberTextProof(member, sourceMembers[index]);
    if (text.reportSha256 !== member.reportSha256 || text.reportByteSize !== member.reportByteSize || text.rowSha256 !== member.rowSha256)
      throw new Error("Legacy member differs from its exact exported PostgreSQL text");
    const rowFields = previousScientific && member.kind === "report" && member.rowText.length < member.reportText.length
      ? new Map<string, string>() : undefined;
    const metadata = inlineRowMetadata(member);
    const source = reportValidationValue(parseReportJson(metadata ?? member.rowText, rowFields)) as Record<string, unknown>;
    if (!source || source.sim_job_id !== member.executionId || source.sequence !== member.sequence ||
      source.content_signature !== member.contentSignature)
      throw new Error("Legacy member source row differs from its bound report key");
    const key = `${member.kind}:${member.executionId}:${member.sequence}`;
    if (keys.has(key)) throw new Error("Duplicate legacy custody member");
    keys.add(key);
    bytes += text.reportByteSize + text.rowByteSize;
    legacyBound(bytes, MAX_PAGE_BYTES, "legacy custody page bytes");
    members.push({ kind: member.kind, executionId: member.executionId, sequence: member.sequence,
      contentSignature: member.contentSignature, ...text });
    previousScientific = collectScientificSource(member, scientificResults, previousScientific,
      source.result_payload_hash, rowFields?.get("report"), metadata !== undefined && source.result_payload_hash == null);
  }
  const memberProofs = Object.freeze(members.map((member) => Object.freeze(member)));
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let localStorageKey: string | null = null;
  let localVerifiedAt: string | null = null;
  const readbackAt = await Promise.race([
    (async () => {
      if (access.reader.readPage) legacyBound(object.byteSize, 512 * 1024 ** 2, "custody page stored bytes");
      const checkActive = () => {
        if (controller.signal.aborted || Date.now() - startedAt > READ_DEADLINE_MS)
          throw new Error("Legacy registered restore page deadline reached");
      };
      const hubBytes = access.mode === "hub-local-reader" ? await access.readHubObject(object, controller.signal) : null;
      checkActive();
      if (hubBytes && (!Buffer.isBuffer(hubBytes) || hubBytes.byteLength !== object.byteSize ||
          createHash("sha256").update(hubBytes).digest("hex") !== object.sha256))
        throw new Error("Fresh hub readback differs from the exact compressed object");
      const pageIdentity: LegacyReportPageReadIdentity = Object.freeze({
        sourceKind: "worker", archiveFormat: "legacy-jsonl", mimeType: "application/gzip", compression: "gzip",
        bucket: object.bucket, objectKey: object.objectKey, generation: object.generation,
        storedSha256: object.sha256, storedByteSize: object.byteSize, crc32c: object.crc32c,
        legacyInstanceId: page.sourceInstance, legacySolverId: page.solverId, legacyScopeSha256: page.scopeSha256,
        legacyPageMemberCount: memberProofs.length, legacyReadMode: access.mode, members: memberProofs, signal: controller.signal,
      });
      const verifyPage = (storedBytes: Buffer) => {
        checkActive();
        const reconstructed = readLegacyPageMembers(storedBytes, {
          storedSha256: object.sha256, storedByteSize: object.byteSize,
          sourceInstance: page.sourceInstance, solverId: page.solverId, scopeSha256: page.scopeSha256, members: memberProofs,
        });
        for (let index = 0; index < reconstructed.length; index++)
          if (!sameLegacyMemberText(reconstructed[index], page.members[index], sourceMembers[index]))
            throw new Error("Product page reader returned different exact legacy member bytes");
        checkActive();
      };
      if (access.mode === "registered-get" && access.reader.readPage) {
        verifyPage(await access.reader.readPage(pageIdentity));
        return new Date().toISOString();
      }
      if (access.mode === "hub-local-reader" && access.reader.readPage) {
        const local = await access.reader.readPage(pageIdentity);
        verifyLocalProductObject(local, hubBytes, object, null);
        // One compressed-object hash and one complete reconstruction on this
        // side. The independently authenticated hub bytes were checked above.
        verifyPage(local.storedBytes);
        localStorageKey = local.storageKey;
        localVerifiedAt = new Date().toISOString();
        return localVerifiedAt;
      }
      for (let index = 0; index < members.length; index++) {
        if (controller.signal.aborted) throw new Error("Legacy registered restore page deadline reached");
        const member = members[index];
        const identity: LegacyRegisteredReportReadIdentity = {
          sourceKind: "worker", memberKind: member.kind, archiveFormat: "legacy-jsonl", mimeType: "application/gzip", compression: "gzip",
          bucket: object.bucket, objectKey: object.objectKey, generation: object.generation,
          storedSha256: object.sha256, storedByteSize: object.byteSize, crc32c: object.crc32c,
          executionId: member.executionId, sequence: member.sequence, signature: member.contentSignature,
          reportSha256: member.reportSha256, reportByteSize: member.reportByteSize,
          legacyInstanceId: page.sourceInstance, legacySolverId: page.solverId, legacyScopeSha256: page.scopeSha256,
          legacyPageMemberCount: members.length, legacyReadMode: access.mode, signal: controller.signal,
        };
        let text: string;
        if (access.mode === "registered-get") {
          if (!access.reader.read) throw new Error("Registered reader has no page or individual read capability");
          text = await access.reader.read(identity);
        }
        else {
          if (!access.reader.read) throw new Error("Worker reader has no page or individual read capability");
          const local = await access.reader.read(identity);
          verifyLocalProductObject(local, hubBytes, object, localStorageKey);
          if (createHash("sha256").update(local.storedBytes).digest("hex") !== object.sha256)
            throw new Error("Normal worker reader did not reopen the durable identical compressed legacy copy");
          localStorageKey = local.storageKey;
          localVerifiedAt = new Date().toISOString();
          text = local.reportText;
        }
        if (typeof text !== "string" || text !== page.members[index].reportText)
          throw new Error("Product reader returned different legacy member bytes");
      }
      return new Date().toISOString();
    })(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Legacy registered restore page deadline reached"));
      }, READ_DEADLINE_MS);
    }),
  ]).catch((cause: unknown) => { throw new LegacyRegisteredRestoreUnavailable(cause); })
    .finally(() => { clearTimeout(timer); controller.abort(); });
  const proof = Object.freeze({ sourceInstance: page.sourceInstance, solverId: page.solverId,
    scopeSha256: page.scopeSha256, readbackAt, readMode: access.mode, localStorageKey, memberCount: members.length, memberProofs });
  verified.set(proof, { startedAt, page: {
    version: 1, sourceInstance: page.sourceInstance, solverId: page.solverId, scopeSha256: page.scopeSha256, readbackAt, readbackStartedAt: new Date(startedAt).toISOString(),
    readMode: access.mode, localStorageKey, localVerifiedAt,
    object: { sourceKind: "worker", archiveFormat: "legacy-jsonl", mimeType: "application/gzip", compression: "gzip",
      bucket: object.bucket, objectKey: object.objectKey, generation: object.generation,
      storedSha256: object.sha256, storedByteSize: object.byteSize, crc32c: object.crc32c },
    members: memberProofs, scientificResults: [...scientificResults.values()],
  } });
  return proof;
}

function payload(proof: VerifiedLegacyReportCustodyPage): BoundPage {
  const bound = verified.get(proof);
  if (!bound || Date.now() - bound.startedAt > PROOF_LIFETIME_MS)
    throw new Error("Legacy custody requires a fresh successful product read in this process");
  return bound.page;
}

export interface LegacyReportCustodyOptions { apply?: boolean; readersReady?: boolean }

/** Each verified scientific result travels once in its original PostgreSQL form.
 * An explicit PostgreSQL escape string keeps receipt identities readable and
 * round-trips quotes and backslashes independently of session settings. */
export function legacyReportCustodySql(proof: VerifiedLegacyReportCustodyPage, options: LegacyReportCustodyOptions = {}): string {
  if (options.apply && !options.readersReady) throw new Error("Legacy cold custody requires installed legacy report readers");
  const json = JSON.stringify(payload(proof)).replaceAll("\\", "\\\\").replaceAll("'", "''");
  return `BEGIN;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='35s';
SELECT public.register_legacy_report_archive_custody(E'${json}'::jsonb)::text;
${options.apply ? "COMMIT" : "ROLLBACK"};\n`;
}

/** Local DB counterpart for fixtures and authorized worker operator execution. */
export async function applyLegacyReportCustodyPage(db: DB, proof: VerifiedLegacyReportCustodyPage, options: LegacyReportCustodyOptions = {}) {
  if (!options.apply) return { applied: false as const, sql: legacyReportCustodySql(proof, options) };
  if (!options.readersReady) throw new Error("Legacy cold custody requires installed legacy report readers");
  const page = payload(proof);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='30s'`);
    await tx.execute(sql`SET LOCAL timezone='UTC'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='35s'`);
    const [result] = await tx.execute(sql`SELECT public.register_legacy_report_archive_custody(${JSON.stringify(page)}::jsonb) AS receipt`);
    return { applied: true as const, receipt: result.receipt as Record<string, unknown> };
  });
}
