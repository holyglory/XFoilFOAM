import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { LEGACY_HASH, LEGACY_UUID, legacyBound, type LegacyReportMember } from "./legacy-report-storage";
import { parseReportJson, reportTextIdentity, reportValidationValue, type ProgressiveReportArchiveReadIdentity } from "./progressive-report-archive";

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

/** Must issue a fresh, authenticated registered HZ GET, with no operator/GCS
 * fallback. It returns exact member text only after authenticating the entire
 * pinned object's bytes, including its legacy header and member dictionary. */
export interface LegacyRegisteredReportReader {
  read(identity: LegacyRegisteredReportReadIdentity): Promise<string>;
}

export interface LegacyLocalProductReadback {
  reportText: string;
  /** Relative key returned by the normal shared persistent results-volume store.
   * This immutable copy must remain pinned while the DB catalog references it. */
  storageKey: string;
  storedBytes: Buffer;
  durableAt: string;
}

export type LegacyCustodyProductRead =
  | { mode: "registered-get"; reader: LegacyRegisteredReportReader }
  | { mode: "hub-local-reader";
      readHubObject(identity: LegacyCustodyObject, signal: AbortSignal): Promise<Buffer>;
      /** Reopen the durable shared-volume object through the product reader;
       * an operator transfer buffer or a stale decoded cache is insufficient. */
      reader: { read(identity: LegacyRegisteredReportReadIdentity): Promise<LegacyLocalProductReadback> } };

export interface VerifiedLegacyReportCustodyPage {
  readonly sourceInstance: string;
  readonly solverId: string;
  readonly scopeSha256: string;
  readonly readbackAt: string;
  readonly readMode: "registered-get" | "hub-local-reader";
  readonly localStorageKey: string | null;
  readonly memberCount: number;
}

export class LegacyRegisteredRestoreUnavailable extends Error {
  readonly fallback = "verified-0198-normalization";
  constructor(cause: unknown) {
    super("Product restore did not verify the exact legacy bytes; retain inline data or use verified 0198 normalization", { cause });
    this.name = "LegacyRegisteredRestoreUnavailable";
  }
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
  members: Array<{
    kind: "report" | "conflict";
    executionId: string;
    sequence: number;
    contentSignature: string;
    reportSha256: string;
    reportByteSize: number;
    rowSha256: string;
    rowByteSize: number;
  }>;
}

const verified = new WeakMap<VerifiedLegacyReportCustodyPage, { page: BoundPage; startedAt: number }>();
const MAX_PAGE_BYTES = 256 * 1024 * 1024;
const READ_DEADLINE_MS = 120_000;
const PROOF_LIFETIME_MS = 300_000;

/** An operator receipt alone is insufficient. Recheck either the registered GET,
 * or both fresh pinned hub bytes and their durable normal-worker-reader copy. */
export async function verifyLegacyReportCustodyPage(
  input: { page: LegacyReportCustodyPage; object: LegacyCustodyObject; access: LegacyCustodyProductRead },
): Promise<VerifiedLegacyReportCustodyPage> {
  // Copy scalar identities before any asynchronous operation. A caller cannot
  // retarget a verified read by mutating its receipt while the GET is pending.
  if (!input.page || !Array.isArray(input.page.members)) throw new Error("Invalid legacy custody page");
  const page = { ...input.page, members: input.page.members.map((member) => ({ ...member })) };
  const object = Object.freeze({ ...input.object });
  const access = Object.freeze({ ...input.access });
  if (!access || !["registered-get", "hub-local-reader"].includes(access.mode))
    throw new Error("Legacy custody requires an explicit verified product read mode");
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
  const members: BoundPage["members"] = [];
  const keys = new Set<string>();
  let bytes = 0;
  for (const member of page.members) {
    if (!["report", "conflict"].includes(member.kind) || !LEGACY_UUID.test(member.executionId) ||
      !LEGACY_HASH.test(member.contentSignature) || !LEGACY_HASH.test(member.reportSha256) ||
      !LEGACY_HASH.test(member.rowSha256) || member.solverId !== page.solverId)
      throw new Error("Legacy custody member has an invalid or foreign immutable identity");
    legacyBound(member.sequence, Number.MAX_SAFE_INTEGER, "legacy member sequence");
    const body = reportTextIdentity(member.reportText);
    const row = reportTextIdentity(member.rowText);
    if (body.sha256 !== member.reportSha256 || body.byteSize !== member.reportByteSize || row.sha256 !== member.rowSha256)
      throw new Error("Legacy member differs from its exact exported PostgreSQL text");
    const source = reportValidationValue(parseReportJson(member.rowText)) as Record<string, unknown>;
    if (!source || source.sim_job_id !== member.executionId || source.sequence !== member.sequence ||
      source.content_signature !== member.contentSignature)
      throw new Error("Legacy member source row differs from its bound report key");
    const key = `${member.kind}:${member.executionId}:${member.sequence}`;
    if (keys.has(key)) throw new Error("Duplicate legacy custody member");
    keys.add(key);
    bytes += body.byteSize + row.byteSize;
    legacyBound(bytes, MAX_PAGE_BYTES, "legacy custody page bytes");
    members.push({ kind: member.kind, executionId: member.executionId, sequence: member.sequence,
      contentSignature: member.contentSignature, reportSha256: body.sha256, reportByteSize: body.byteSize,
      rowSha256: row.sha256, rowByteSize: row.byteSize });
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let localStorageKey: string | null = null;
  let localVerifiedAt: string | null = null;
  const readbackAt = await Promise.race([
    (async () => {
      const hubBytes = access.mode === "hub-local-reader" ? await access.readHubObject(object, controller.signal) : null;
      if (hubBytes && (!Buffer.isBuffer(hubBytes) || hubBytes.byteLength !== object.byteSize ||
          createHash("sha256").update(hubBytes).digest("hex") !== object.sha256))
        throw new Error("Fresh hub readback differs from the exact compressed object");
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
        if (access.mode === "registered-get") text = await access.reader.read(identity);
        else {
          const local = await access.reader.read(identity);
          if (!hubBytes || !Buffer.isBuffer(local.storedBytes) || local.storedBytes.byteLength !== object.byteSize ||
            createHash("sha256").update(local.storedBytes).digest("hex") !== object.sha256 || !local.storedBytes.equals(hubBytes) ||
            !Number.isFinite(Date.parse(local.durableAt)) ||
            !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(local.storageKey) ||
            local.storageKey.split("/").some((part) => part === "." || part === "..") ||
            !local.storageKey.endsWith(`${object.sha256}.jsonl.gz`) ||
            (localStorageKey !== null && localStorageKey !== local.storageKey))
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
    scopeSha256: page.scopeSha256, readbackAt, readMode: access.mode, localStorageKey, memberCount: members.length });
  verified.set(proof, { startedAt, page: {
    version: 1, sourceInstance: page.sourceInstance, solverId: page.solverId, scopeSha256: page.scopeSha256, readbackAt, readbackStartedAt: new Date(startedAt).toISOString(),
    readMode: access.mode, localStorageKey, localVerifiedAt,
    object: { sourceKind: "worker", archiveFormat: "legacy-jsonl", mimeType: "application/gzip", compression: "gzip",
      bucket: object.bucket, objectKey: object.objectKey, generation: object.generation,
      storedSha256: object.sha256, storedByteSize: object.byteSize, crc32c: object.crc32c },
    members,
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

/** Bound metadata only: no solver JSON is parsed/re-emitted in this SQL. A page
 * is one transaction; default output rolls back and never changes permissions. */
export function legacyReportCustodySql(proof: VerifiedLegacyReportCustodyPage, options: LegacyReportCustodyOptions = {}): string {
  if (options.apply && !options.readersReady) throw new Error("Legacy cold custody requires installed legacy report readers");
  const json = JSON.stringify(payload(proof)).replaceAll("'", "''");
  return `BEGIN;
SET LOCAL search_path=pg_catalog,public;
SET LOCAL timezone='UTC';
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SET LOCAL idle_in_transaction_session_timeout='35s';
SELECT public.register_legacy_report_archive_custody('${json}'::jsonb)::text;
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
