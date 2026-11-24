import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ProgressiveReportArchiveEntry } from "./progressive-report-archive";
import { AsyncLocalStorage } from "node:async_hooks";
import { LegacyOriginSigner } from "./legacy-report-signature";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import {
  canonicalReportJson,
  parseReportJson,
  reportTextIdentity,
  reportValidationValue,
  reportValidationValueWithNumberRange,
  type ProgressiveReportArchiveReadIdentity,
} from "./progressive-report-archive";
import type { ProgressiveRemoteReport } from "./progressive-remote-report";

export const DEFAULT_PROGRESSIVE_REPORT_READ_TIMEOUT_MS = 15_000;

export type ProgressiveReportSourceKind = "remote" | "worker";

export interface ProgressiveReportReference {
  sourceKind: ProgressiveReportSourceKind;
  executionId: string;
  sequence: number;
  contentSignature: string;
}

export interface ProgressiveReportArchiveIdentity extends ProgressiveReportArchiveReadIdentity {
  sourceKind: ProgressiveReportSourceKind;
  memberKind: "report";
  legacyInstanceId?: string;
  legacySolverId?: string;
  legacyScopeSha256?: string;
  legacyPageMemberCount?: number;
  legacyReadMode?: "registered-get" | "hub-local-reader";
  legacyLocalStorageKey?: string;
  signal: AbortSignal;
}

// Minted only after the exact generation, member bytes and signed content
// have all verified. A parsed report supplied by a caller has no such pin.
interface VerifiedArchiveMember {
  identity: ProgressiveReportArchiveReadIdentity;
  bundleId: string;
}
const archivedMembers = new WeakMap<ProgressiveRemoteReport, VerifiedArchiveMember>();
export function verifiedProgressiveReportMember(report: ProgressiveRemoteReport) {
  return archivedMembers.get(report);
}

export async function recheckRemoteReportMember(db: DB, proof: VerifiedArchiveMember) {
  const i = proof.identity;
  const [row] = await db.execute(sql`SELECT 1 FROM progressive_remote_reports r
    JOIN public.progressive_report_archive_bundles b ON b.id=r.archive_bundle_id
      AND b.source_kind='remote' AND b.sim_job_id=r.sim_job_id AND b.verified_at IS NOT NULL
    JOIN public.progressive_report_archive_members m ON m.bundle_id=b.id AND m.source_kind=b.source_kind
      AND m.sim_job_id=r.sim_job_id AND m.member_kind='report' AND m.sequence=r.sequence AND m.content_signature=r.content_signature
    WHERE r.sim_job_id=${i.executionId}::uuid AND r.sequence=${i.sequence} AND r.content_signature=${i.signature}
      AND r.archived_at IS NOT NULL AND b.id=${proof.bundleId}::uuid AND b.bucket=${i.bucket}
      AND b.object_key=${i.objectKey} AND b.generation=${i.generation} AND b.crc32c=${i.crc32c}
      AND b.stored_sha256=${i.storedSha256} AND b.stored_byte_size=${i.storedByteSize}
      AND b.mime_type=${i.mimeType} AND b.archive_format=${i.archiveFormat} AND b.compression=${i.compression}
      AND b.member_count=${i.memberCount} AND b.first_sequence=${i.firstSequence} AND b.last_sequence=${i.lastSequence}
      AND m.report_sha256=${i.reportSha256} AND m.report_byte_size=${i.reportByteSize}`);
  return Boolean(row);
}

/** The normal API logger records these verified identifiers. Its HTTP error
 * response contains only the message. Do not attach report bodies or credentials. */
export class ProgressiveReportArchiveTimeout extends Error {
  readonly member;
  constructor(identity: ProgressiveReportArchiveIdentity) {
    super("Archived progressive full report read timed out");
    this.member = {
      sourceKind: identity.sourceKind,
      executionId: identity.executionId,
      sequence: identity.sequence,
      contentSignature: identity.signature,
      generation: identity.generation,
      reportSha256: identity.reportSha256,
      reportByteSize: identity.reportByteSize,
    };
  }
}

export interface ProgressiveReportArchiveReader {
  read(identity: ProgressiveReportArchiveIdentity, connection: DB): Promise<string>;
  visitRemoteJsonl?(
    root: ProgressiveReportArchiveReadIdentity,
    owner: { executionId: string; solverId: string; promiseId: string; assignmentSignature: string },
    visit: (entry: ProgressiveReportArchiveEntry) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

/** The callback is provisional until the entire pinned root has passed its EOF checks. */
export async function visitInstalledRemoteJsonl(
  root: ProgressiveReportArchiveReadIdentity,
  owner: { executionId: string; solverId: string; promiseId: string; assignmentSignature: string },
  visit: (entry: ProgressiveReportArchiveEntry) => void,
): Promise<boolean> {
  const adapter = installed?.reader;
  if (!adapter?.visitRemoteJsonl || root.archiveFormat !== "jsonl") return false;
  const timeout = AbortSignal.timeout(installed!.timeoutMs);
  await adapter.visitRemoteJsonl(root, owner, visit, timeout);
  timeout.throwIfAborted();
  return true;
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REPORT_BYTES = 512 * 1024 * 1024;
type ReportOwner = Pick<ProgressiveRemoteReport, "solverId" | "promiseId" | "assignmentSignature">;
let installed: {
  reader: ProgressiveReportArchiveReader;
  timeoutMs: number;
  pending: Map<string, Promise<ProgressiveRemoteReport>>;
} | null = null;

export function freezeProgressiveReport(report: ProgressiveRemoteReport): void {
  const freeze = (v: unknown): void => {
    if (!v || typeof v !== "object" || Object.isFrozen(v)) return;
    Object.freeze(v);
    for (const item of Object.values(v)) freeze(item);
  };
  freeze(report);
}


/** Hub installs its exact object reader; workers install the authenticated hub broker.
 * This package neither creates object-store clients nor obtains credentials. */
export function installProgressiveReportArchiveReader(
  reader: ProgressiveReportArchiveReader | null,
  options: { timeoutMs?: number } = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROGRESSIVE_REPORT_READ_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Progressive report reads require a 1..30000ms deadline");
  installed = reader ? { reader, timeoutMs, pending: new Map() } : null;
}

function verifyBody(value: unknown, reference: ProgressiveReportReference, signature = analysisContentHash(value)): ProgressiveRemoteReport {
  const report = value as (Partial<ProgressiveRemoteReport> & { archivedReport?: unknown }) | null;
  if (!report || typeof report !== "object" || report.archivedReport === true ||
    report.executionId !== reference.executionId || report.sequence !== reference.sequence ||
    signature !== reference.contentSignature)
    throw new Error("Progressive full report differs from its exact stored identity");
  return report as ProgressiveRemoteReport;
}

/** Independent of the transport cache. Only a signed, byte-identical root result
 * can reuse its canonical hash prefix. Each call still obtains a fresh product
 * value and reopens and verifies the physical generations through its reader. */
class WorkerResultReadPage {
  private signer?: LegacyOriginSigner;
  private scope?: string;
  private nativeJsonMatches = false;

  materialize(body: string, reference: ProgressiveReportReference, owner: ReportOwner, tokenSha256: string) {
    const scope = JSON.stringify([reference.executionId, owner.solverId, owner.promiseId, owner.assignmentSignature, tokenSha256]);
    if (!this.signer || scope !== this.scope) {
      this.signer = new LegacyOriginSigner();
      this.nativeJsonMatches = false;
      this.scope = scope;
    }
    let value: unknown;
    const signed = this.signer.matches(body, reference.executionId, owner.solverId, reference.sequence,
      reference.contentSignature, (envelope, token, repeated) => {
        if (typeof token !== "string" || envelope.promiseId !== owner.promiseId ||
            envelope.assignmentSignature !== owner.assignmentSignature)
          throw new Error("Worker report result belongs to another dispatch");
        if (repeated) {
          // The signer checked the complete original token before giving us the small envelope.
          const report = reportValidationValue(envelope) as Record<string, unknown>;
          report.result = this.nativeJsonMatches ? JSON.parse(token) : reportValidationValue(parseReportJson(token));
          value = report;
        } else {
          if (reportTextIdentity(token).sha256 !== tokenSha256)
            throw new Error("Worker report result differs from its registered token");
          const report = reportValidationValue({ ...envelope, result: null }) as Record<string, unknown>;
          const result = reportValidationValueWithNumberRange(envelope.result!);
          this.nativeJsonMatches = result.allNumbersFinite;
          report.result = result.decoded;
          value = report;
        }
      });
    if (!signed) throw new Error("Archived worker report differs from its exact stored signature");
    return verifyBody(value, reference, reference.contentSignature);
  }
}

const workerPage = new AsyncLocalStorage<WorkerResultReadPage>();

export function withWorkerReportPageReads<T>(read: () => Promise<T>): Promise<T> {
  return workerPage.run(new WorkerResultReadPage(), read);
}

/** Exactly one immutable sequence. Never substitutes a latest report or a compact header. */
export function readProgressiveReport(
  db: DB,
  reference: ProgressiveReportReference,
  preparedOwner?: ReportOwner,
): Promise<ProgressiveRemoteReport> {
  return materializeProgressiveReport(db, reference, preparedOwner);
}

interface ArchivedReportText {
  text: string;
  bundleId: string;
  generation: string;
  storedSha256: string;
}

/** The same catalog, generation, member and signature checks as the stable-ID
 * reader, with the original PostgreSQL text for a guarded storage transition. */
export async function readArchivedProgressiveReportText(
  db: DB,
  reference: ProgressiveReportReference,
  preparedOwner?: ReportOwner,
): Promise<ArchivedReportText | null> {
  let restored: ArchivedReportText | null = null;
  await materializeProgressiveReport(db, reference, preparedOwner, (member) => { restored = member; });
  return restored;
}

async function materializeProgressiveReport(
  db: DB,
  reference: ProgressiveReportReference,
  preparedOwner?: ReportOwner,
  capture?: (member: ArchivedReportText) => void,
): Promise<ProgressiveRemoteReport> {
  if (!["remote", "worker"].includes(reference.sourceKind) || !UUID.test(reference.executionId) ||
    !Number.isSafeInteger(reference.sequence) || reference.sequence < 1 || !SHA256.test(reference.contentSignature))
    throw new Error("Progressive full report requires an exact execution, sequence and signature");
  const table = sql.identifier(reference.sourceKind === "remote" ? "progressive_remote_reports" : "progressive_worker_reports");
  const [stored] = await db.execute(sql`
    SELECT CASE WHEN to_jsonb(report.*)->>'archived_at' IS NOT NULL
      OR to_jsonb(report.*)->>'archive_bundle_id' IS NOT NULL THEN report.report
      ELSE public.resolve_progressive_report(to_jsonb(report.*)) END AS report,
      to_jsonb(report.*)->>'archived_at' AS archived_at,
      to_jsonb(report.*)->>'archive_bundle_id' AS archive_bundle_id,
      member.report_sha256,member.report_byte_size,
      bundle.bucket,bundle.object_key,bundle.generation,bundle.mime_type,bundle.compression,bundle.archive_format,
      bundle.stored_sha256,bundle.stored_byte_size,bundle.crc32c,bundle.verified_at,
      bundle.member_count,bundle.first_sequence,bundle.last_sequence,
      to_jsonb(bundle.*)->>'worker_result_sha256' AS worker_result_sha256,
      to_jsonb(bundle.*)->>'legacy_instance_id' AS legacy_instance_id,
      to_jsonb(bundle.*)->>'legacy_solver_id' AS legacy_solver_id,
      to_jsonb(bundle.*)->>'legacy_scope_sha256' AS legacy_scope_sha256,
      to_jsonb(bundle.*)->>'legacy_page_member_count' AS legacy_page_member_count,
      to_jsonb(bundle.*)->>'legacy_read_mode' AS legacy_read_mode,
      to_jsonb(bundle.*)->>'legacy_local_storage_key' AS legacy_local_storage_key
    FROM ${table} report
    LEFT JOIN public.progressive_report_archive_members member
      ON member.bundle_id=(to_jsonb(report.*)->>'archive_bundle_id')::uuid
      AND member.source_kind=${reference.sourceKind} AND member.member_kind='report'
      AND member.sim_job_id=report.sim_job_id AND member.sequence=report.sequence
      AND member.content_signature=report.content_signature
    LEFT JOIN public.progressive_report_archive_bundles bundle
      ON bundle.id=member.bundle_id AND bundle.source_kind=member.source_kind
      AND bundle.sim_job_id=member.sim_job_id
      AND member.sequence BETWEEN bundle.first_sequence AND bundle.last_sequence
    WHERE report.sim_job_id=${reference.executionId}::uuid AND report.sequence=${reference.sequence}
      AND report.content_signature=${reference.contentSignature} LIMIT 1
  `);
  if (!stored) throw new Error("Exact progressive full report was not found");
  if (stored.archived_at == null && stored.archive_bundle_id == null)
    return verifyBody(stored.report, reference);
  const reportByteSize = Number(stored.report_byte_size);
  const storedByteSize = Number(stored.stored_byte_size);
  if (!stored.archived_at || !stored.archive_bundle_id || !stored.verified_at ||
    !SHA256.test(String(stored.report_sha256)) || !Number.isSafeInteger(reportByteSize) ||
    reportByteSize < 1 || reportByteSize > MAX_REPORT_BYTES ||
    typeof stored.bucket !== "string" || !stored.bucket || typeof stored.object_key !== "string" || !stored.object_key ||
    !/^[1-9][0-9]{0,19}$/.test(String(stored.generation)) || stored.mime_type !== "application/gzip" ||
    stored.compression !== "gzip" ||
    (stored.archive_format !== "jsonl" && !((stored.archive_format === "legacy-jsonl" || stored.archive_format === "worker-result-ref-v1") && reference.sourceKind === "worker")
      && !(stored.archive_format === "shared-result-v1" && reference.sourceKind === "remote")) ||
    !SHA256.test(String(stored.stored_sha256)) || !Number.isSafeInteger(storedByteSize) || storedByteSize < 1 ||
    !/^[A-Za-z0-9+/]{6}==$/.test(String(stored.crc32c)) ||
    !Number.isSafeInteger(Number(stored.member_count)) || Number(stored.member_count) < 1 ||
    !Number.isSafeInteger(Number(stored.first_sequence)) || Number(stored.first_sequence) < 1 ||
    !Number.isSafeInteger(Number(stored.last_sequence)) || Number(stored.last_sequence) < reference.sequence ||
    Number(stored.first_sequence) > reference.sequence)
    throw new Error("Archived progressive report lacks exact verified member custody");
  if (stored.archive_format === "worker-result-ref-v1" && !SHA256.test(String(stored.worker_result_sha256)))
    throw new Error("Archived worker report lacks its registered result identity");
  if (stored.archive_format === "legacy-jsonl" && (
    !UUID.test(String(stored.legacy_instance_id)) || !UUID.test(String(stored.legacy_solver_id)) ||
    !SHA256.test(String(stored.legacy_scope_sha256)) ||
    !Number.isSafeInteger(Number(stored.legacy_page_member_count)) ||
    Number(stored.legacy_page_member_count) < Number(stored.member_count) ||
    Number(stored.legacy_page_member_count) > 128 ||
    !["registered-get", "hub-local-reader"].includes(String(stored.legacy_read_mode)) ||
    (stored.legacy_read_mode === "hub-local-reader" && !stored.legacy_local_storage_key)
  )) throw new Error("Archived legacy report lacks its measured product-read identity");
  const active = installed;
  if (!active) throw new Error("Archived progressive full report reader is not installed");
  const storedIdentity = {
    sourceKind: reference.sourceKind, memberKind: "report" as const, executionId: reference.executionId,
    sequence: reference.sequence, signature: reference.contentSignature,
    reportSha256: String(stored.report_sha256), reportByteSize,
    bucket: String(stored.bucket), objectKey: String(stored.object_key), generation: String(stored.generation),
    mimeType: String(stored.mime_type), compression: String(stored.compression), archiveFormat: String(stored.archive_format),
    storedSha256: String(stored.stored_sha256), storedByteSize, crc32c: String(stored.crc32c),
    memberCount: Number(stored.member_count), firstSequence: Number(stored.first_sequence), lastSequence: Number(stored.last_sequence),
    ...(stored.archive_format === "worker-result-ref-v1" ? { workerResultSha256: String(stored.worker_result_sha256) } : {}),
    ...(stored.archive_format === "legacy-jsonl" ? {
      legacyInstanceId: String(stored.legacy_instance_id), legacySolverId: String(stored.legacy_solver_id),
      legacyScopeSha256: String(stored.legacy_scope_sha256), legacyPageMemberCount: Number(stored.legacy_page_member_count),
      legacyReadMode: stored.legacy_read_mode as "registered-get" | "hub-local-reader",
      ...(stored.legacy_local_storage_key ? { legacyLocalStorageKey: String(stored.legacy_local_storage_key) } : {}),
    } : {}),
  };
  const header = stored.report as Partial<ProgressiveRemoteReport> | null;
  if (preparedOwner && header && (
    (header.solverId !== undefined && header.solverId !== preparedOwner.solverId) ||
    (header.promiseId !== undefined && header.promiseId !== preparedOwner.promiseId) ||
    (header.assignmentSignature !== undefined && header.assignmentSignature !== preparedOwner.assignmentSignature)
  )) throw new Error("Archived report header belongs to another dispatch");
  const scoped = reference.sourceKind === "remote" && preparedOwner &&
    header?.executionId === reference.executionId && header.sequence === reference.sequence &&
    header.solverId === preparedOwner.solverId && header.promiseId === preparedOwner.promiseId &&
    header.assignmentSignature === preparedOwner.assignmentSignature;

  const restore = async () => {
    const controller = new AbortController();
    const identity = Object.freeze({ ...storedIdentity, signal: controller.signal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const body = await Promise.race([
        active.reader.read(identity, db),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new ProgressiveReportArchiveTimeout(identity));
            controller.abort();
          }, active.timeoutMs);
        }),
      ]);
      if (typeof body !== "string")
        throw new Error("Archived progressive full report reader must return exact JSON text");
      // PostgreSQL jsonb::text is the archive member identity. It is deliberately
      // independent of the application's canonical content signature.
      const raw = reportTextIdentity(body);
      if (raw.byteSize !== reportByteSize || raw.sha256 !== stored.report_sha256)
        throw new Error("Archived progressive full report member bytes changed");
      let report: ProgressiveRemoteReport;
      const page = storedIdentity.archiveFormat === "worker-result-ref-v1" && preparedOwner ? workerPage.getStore() : undefined;
      if (page && preparedOwner && storedIdentity.workerResultSha256) {
        report = page.materialize(body, reference, preparedOwner, storedIdentity.workerResultSha256);
      } else {
        const parsed = parseReportJson(body);
        const signature = createHash("sha256").update(canonicalReportJson(parsed), "utf8").digest("hex");
        report = verifyBody(reportValidationValue(parsed), reference, signature);
      }
      if (preparedOwner && (report.solverId !== preparedOwner.solverId || report.promiseId !== preparedOwner.promiseId ||
        report.assignmentSignature !== preparedOwner.assignmentSignature))
        throw new Error("Verified report belongs to another dispatch");
      if (identity.sourceKind === "remote")
        archivedMembers.set(report, Object.freeze({ bundleId: String(stored.archive_bundle_id), identity: Object.freeze(storedIdentity) }));
      if (scoped) freezeProgressiveReport(report);
      capture?.({ text: body, bundleId: String(stored.archive_bundle_id),
        generation: storedIdentity.generation, storedSha256: storedIdentity.storedSha256 });
      return report;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  if (!scoped || capture) return restore();
  // Each preparer has independently selected this signed owner and catalog
  // member. Share only concurrent work of this installed reader, with the
  // original deadline. Nothing is reusable after success, abort or failure.
  const key = JSON.stringify([preparedOwner.solverId, preparedOwner.promiseId, preparedOwner.assignmentSignature,
    stored.archive_bundle_id, storedIdentity]);
  const pending = active.pending.get(key);
  if (pending) return pending;
  const read = restore().finally(() => active.pending.delete(key));
  active.pending.set(key, read);
  return read;
}

interface PreparedRemoteReads {
  executionId: string;
  read: (db: DB, sequence: number, signature: string) => Promise<ProgressiveRemoteReport>;
}
const preparedRemoteReads = new AsyncLocalStorage<PreparedRemoteReads>();
export function withPreparedRemoteReportReads<T>(scope: PreparedRemoteReads, action: () => Promise<T>) {
  return preparedRemoteReads.run(scope, action);
}

/** Existing bounded selectors may already have reconstructed an inline body.
 * Existing consumer validation owns live bytes; compact bodies read through. */
export async function resolveStoredProgressiveReport(
  db: DB,
  sourceKind: ProgressiveReportSourceKind,
  stored: { report?: unknown; content_signature?: unknown },
  executionId: string,
  preparedOwner?: ReportOwner,
): Promise<ProgressiveRemoteReport> {
  const value = stored.report as (Partial<ProgressiveRemoteReport> & { archivedReport?: unknown }) | null;
  // New headers carry an explicit marker, including null-result snapshots.
  // Retain detection for older headers that stripped null fields and polars.
  // Full and legacy fixture values keep their existing validator without a
  // second hash, query, or body detoast on the routinely live path.
  const compact = value?.archivedReport === true ||
    (value?.version === 1 && typeof value.executionId === "string" &&
      (!Object.hasOwn(value, "result") || !Object.hasOwn(value, "stopProof") ||
        (value.result !== null && !Array.isArray(value.result?.polars))));
  if (!compact) return stored.report as ProgressiveRemoteReport;
  if (value?.executionId !== executionId)
    throw new Error("Stored progressive report has a foreign execution identity");
  const scoped = preparedRemoteReads.getStore();
  if (sourceKind === "remote" && scoped?.executionId === executionId) {
    const report = await scoped.read(db,Number(value.sequence),String(stored.content_signature));
    if (preparedOwner && (report.solverId!==preparedOwner.solverId || report.promiseId!==preparedOwner.promiseId ||
        report.assignmentSignature!==preparedOwner.assignmentSignature))
      throw new Error("Archived report header belongs to another dispatch");
    return report;
  }
  return readProgressiveReport(db, {
    sourceKind, executionId, sequence: Number(value.sequence), contentSignature: String(stored.content_signature),
  }, preparedOwner);
}
