import { LegacyOriginSigner } from "@aerodb/db/legacy-report-signature";
import {
  inspectLegacyPage,
  legacyMemberTextProof,
} from "@aerodb/db/legacy-report-storage-codec";
import {
  LEGACY_HASH,
  LEGACY_UUID,
  legacyBound,
  legacyReadOnlySql,
  type LegacyReportMember,
  type LegacyReportScope,
} from "@aerodb/db/legacy-report-storage";
import {
  assertLegacyObject,
  legacySha256,
  LegacyStorageOperationError,
  type LegacyBackupObject,
  type LegacyBackupStore,
} from "./legacy-report-storage-gcs";

interface Source {
  query(q: string, maxBytes: number): Promise<Record<string, unknown>[]>;
}
interface AliasKey {
  job: string;
  sequence: number;
}
interface Origin {
  snapshot: string;
  sequence: number;
  contentSignature: string;
  solverId: string;
  rowText: string;
  rowSha256: string;
  rowByteSize: number;
  reportSha256: string;
  reportByteSize: number;
  sourceRowSha256: string;
  sourceRowByteSize: number;
  pageMemberCount: number;
  object: LegacyBackupObject;
}
export const coldLegacySource =
  "cold or missing source body requires its existing reader";
export const overLegacyBudget = "row exceeds remaining byte budget";

// Read the actual conflict tuple and its distinct, immutable 0203 source under
// one snapshot. Never use the compact header as the original document.
function originSql(
  keys: AliasKey[],
  scope: LegacyReportScope,
  scopeSha: string,
  limit?: number,
) {
  if (
    keys.some((k) => !LEGACY_UUID.test(k.job)) ||
    !LEGACY_HASH.test(scopeSha) ||
    !LEGACY_UUID.test(scope.solverId) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(scope.sourceInstance)
  )
    throw new Error("Invalid frozen alias source identity");
  legacyBound(keys.length, 128, "alias lookup count");
  if (limit !== undefined)
    legacyBound(limit, 256 * 1024 ** 2, "remaining page bytes");
  const values = keys
    .map(
      (k) =>
        `('${k.job}'::uuid,${legacyBound(k.sequence, Number.MAX_SAFE_INTEGER, "source sequence")}::bigint)`,
    )
    .join(",");
  const snapshot =
    "encode(sha256(convert_to(to_jsonb(origin)::text,'UTF8')),'hex')";
  const lookup = `WITH requested(job,seq) AS (VALUES ${values}),origin AS MATERIALIZED (
    SELECT c.sim_job_id AS job,c.sequence,b.id AS bundle,c.content_signature,c.report->>'solverId' AS solver,to_jsonb(c)::text AS row_text,
      m.report_sha256,m.report_byte_size,m.legacy_row_sha256,m.legacy_row_byte_size,
      b.bucket,b.object_key,b.generation,b.stored_sha256,b.stored_byte_size,b.crc32c,b.verified_at,b.legacy_page_member_count
    FROM public.progressive_worker_report_conflicts c
    JOIN public.progressive_worker_conflict_storage v USING(sim_job_id,sequence,content_signature)
    JOIN public.progressive_worker_reports w ON w.sim_job_id=c.sim_job_id AND w.sequence=c.body_source_sequence AND w.content_signature=c.content_signature
    JOIN public.progressive_report_archive_members m ON m.bundle_id=w.archive_bundle_id AND m.source_kind='worker' AND m.member_kind='report'
      AND m.sim_job_id=w.sim_job_id AND m.sequence=w.sequence AND m.content_signature=w.content_signature
    JOIN public.progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.source_kind=m.source_kind AND b.sim_job_id=m.sim_job_id
    JOIN requested ON requested.job=c.sim_job_id AND requested.seq=c.sequence
    WHERE c.body_source_sequence=c.sequence
      AND c.archived_at IS NULL AND c.archive_bundle_id IS NULL AND w.archived_at IS NOT NULL
      AND v.member_kind='report' AND v.archive_bundle_id=w.archive_bundle_id
      AND w.report->>'solverId'='${scope.solverId}' AND c.report->>'solverId'=w.report->>'solverId'
      AND b.archive_format='legacy-jsonl' AND b.mime_type='application/gzip' AND b.compression='gzip' AND b.verified_at IS NOT NULL
      AND b.legacy_scope_sha256='${scopeSha}' AND b.legacy_solver_id='${scope.solverId}'::uuid AND b.legacy_instance_id::text='${scope.sourceInstance}'
      AND m.sequence BETWEEN b.first_sequence AND b.last_sequence)`;
  if (limit === undefined)
    return legacyReadOnlySql(
      lookup +
        ` SELECT jsonb_build_object('job',job,'sequence',sequence,'snapshot',${snapshot})::text FROM origin;`,
    );
  return legacyReadOnlySql(
    lookup +
      ` SELECT CASE WHEN octet_length(row_text)+report_byte_size>${limit}
      THEN jsonb_build_object('blocked','${overLegacyBudget}','inputBytes',octet_length(row_text)+report_byte_size)
      ELSE jsonb_build_object('sequence',sequence,'contentSignature',content_signature,'solverId',solver,
        'snapshot',${snapshot},'rowText',row_text,'rowSha256',encode(sha256(convert_to(row_text,'UTF8')),'hex'),'rowByteSize',octet_length(row_text),
        'reportSha256',report_sha256,'reportByteSize',report_byte_size,'sourceRowSha256',legacy_row_sha256,'sourceRowByteSize',legacy_row_byte_size,
        'pageMemberCount',legacy_page_member_count,'object',jsonb_build_object('bucket',bucket,'objectKey',object_key,'generation',generation,
        'sha256',stored_sha256,'byteSize',stored_byte_size,'crc32c',crc32c,'verifiedAt',verified_at)) END::text FROM origin;`,
  );
}

/** At most one authenticated source generation per cache. The cache belongs
 * to one bounded output page. Each conflict still proves its own keyed tuple. */
export class LegacyConflictOrigin {
  private cached?: {
    key: string;
    count: number;
    index: Map<
      string,
      Omit<LegacyReportMember, "rowText"> & { rowBytes: number }
    >;
  };
  private readonly signer = new LegacyOriginSigner();
  private readonly snapshots = new Map<
    string,
    AliasKey & { snapshot: string }
  >();
  async recheck() {
    const keys = [...this.snapshots.values()];
    if (!keys.length) return;
    const rows = await this.source.query(
      originSql(keys, this.scope, this.scopeSha),
      65536,
    );
    const actual = new Map(
      rows.map((r) => [`${r.job}/${r.sequence}`, r.snapshot]),
    );
    for (const k of keys)
      if (actual.get(`${k.job}/${k.sequence}`) !== k.snapshot)
        throw new LegacyStorageOperationError({
          operation: "conflict_origin",
          category: "origin_mismatch",
          member: {
            kind: "conflict",
            executionId: k.job,
            sequence: k.sequence,
          },
        });
  }
  constructor(
    private source: Source,
    private store: Pick<LegacyBackupStore, "read">,
    private scope: LegacyReportScope,
    private scopeSha: string,
  ) {}
  async read(
    job: string,
    seq: number,
    limit: number,
  ): Promise<Record<string, unknown>> {
    const fail = (category: "origin_unavailable" | "origin_mismatch") =>
      new LegacyStorageOperationError({
        operation: "conflict_origin",
        category,
        member: { executionId: job, kind: "conflict", sequence: seq },
      });
    const rows = await this.source.query(
      originSql([{ job, sequence: seq }], this.scope, this.scopeSha, limit),
      limit * 6 + 65536,
    );
    if (rows.length !== 1) throw fail("origin_unavailable");
    const r = rows[0]!;
    if (
      r.blocked === overLegacyBudget &&
      Number.isSafeInteger(r.inputBytes) &&
      Number(r.inputBytes) > limit
    )
      return r;
    try {
      const v = r as unknown as Origin,
        o = v.object;
      assertLegacyObject(o);
      if (
        !LEGACY_HASH.test(v.snapshot) ||
        v.sequence !== seq ||
        v.solverId !== this.scope.solverId ||
        !LEGACY_HASH.test(v.contentSignature) ||
        !LEGACY_HASH.test(v.reportSha256) ||
        !LEGACY_HASH.test(v.sourceRowSha256) ||
        typeof v.rowText !== "string" ||
        legacySha256(v.rowText) !== v.rowSha256 ||
        Buffer.byteLength(v.rowText) !== v.rowByteSize ||
        !Number.isSafeInteger(v.reportByteSize) ||
        v.reportByteSize < 1 ||
        v.rowByteSize + v.reportByteSize > limit ||
        o.objectKey !==
          `legacy-worker-reports/v1/${this.scope.sourceInstance}/${this.scope.solverId}/${this.scopeSha}/${o.sha256}.jsonl.gz`
      )
        throw fail("origin_mismatch");
      const key = JSON.stringify([
        o.bucket,
        o.objectKey,
        o.generation,
        o.sha256,
        o.byteSize,
        o.crc32c,
      ]);
      if (this.cached?.key !== key) {
        this.cached = undefined;
        const bytes = await this.store.read(o);
        if (bytes.length !== o.byteSize || legacySha256(bytes) !== o.sha256)
          throw fail("origin_mismatch");
        const { page } = inspectLegacyPage(bytes);
        if (
          page.scopeSha256 !== this.scopeSha ||
          page.sourceInstance !== this.scope.sourceInstance ||
          page.solverId !== this.scope.solverId
        )
          throw fail("origin_mismatch");
        const index = new Map<
          string,
          Omit<LegacyReportMember, "rowText"> & { rowBytes: number }
        >();
        for (const m of page.members)
          if (m.kind === "report") {
            const { rowText, ...retained } = m;
            index.set(`${m.executionId}/${m.sequence}`, {
              ...retained,
              rowBytes: legacyMemberTextProof(m).rowByteSize,
            });
          }
        this.cached = { key, count: page.members.length, index };
      }
      if (this.cached.count !== v.pageMemberCount)
        throw fail("origin_mismatch");
      const src = this.cached.index.get(`${job}/${seq}`);
      if (
        !src ||
        src.solverId !== v.solverId ||
        src.contentSignature !== v.contentSignature ||
        src.reportSha256 !== v.reportSha256 ||
        src.reportByteSize !== v.reportByteSize ||
        src.rowSha256 !== v.sourceRowSha256 ||
        src.rowBytes !== v.sourceRowByteSize
      )
        throw fail("origin_mismatch");
      if (
        !this.signer.matches(
          src.reportText,
          job,
          v.solverId,
          seq,
          v.contentSignature,
        )
      )
        throw fail("origin_mismatch");
      const member: LegacyReportMember = {
        kind: "conflict",
        executionId: job,
        sequence: seq,
        contentSignature: v.contentSignature,
        solverId: v.solverId,
        rowText: v.rowText,
        rowSha256: v.rowSha256,
        reportText: src.reportText,
        reportSha256: src.reportSha256,
        reportByteSize: src.reportByteSize,
      };
      this.snapshots.set(`${job}/${seq}`, {
        job,
        sequence: seq,
        snapshot: v.snapshot,
      });
      return { ...member };
    } catch (e) {
      if (e instanceof LegacyStorageOperationError) throw e;
      throw fail("origin_mismatch");
    }
  }
}
