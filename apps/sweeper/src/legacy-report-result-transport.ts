import { createHash, randomUUID } from "node:crypto";
import {
  LEGACY_HASH,
  LEGACY_UUID,
  legacyBound,
  legacyReadOnlySql,
  type LegacyReportKind,
  type LegacyReportMember,
} from "@aerodb/db/legacy-report-storage";
import { checkLegacyMember } from "@aerodb/db/legacy-report-storage-codec";

const FORMAT = "legacy-result-transport-v1";
const MAX_BYTES = 256 * 1024 ** 2;
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

interface Source {
  query(sql: string, maxBytes: number): Promise<Record<string, unknown>[]>;
}
interface Key {
  executionId: string;
  kind: LegacyReportKind;
  sequence: number;
}
export interface LegacyResultReference extends Key {
  contentSignature: string;
  sha256: string;
  byteSize: number;
}
interface VerifiedResult {
  reference: LegacyResultReference;
  text: string;
}

function key(input: Key): void {
  if (
    !LEGACY_UUID.test(input.executionId) ||
    !["report", "conflict"].includes(input.kind)
  )
    throw new Error("Invalid legacy result transport source");
  legacyBound(input.sequence, Number.MAX_SAFE_INTEGER, "source sequence");
}

/** One indexed row, including conflict aliases. No source body is edited. */
function sourceRow(input: Key, signature?: string): string {
  key(input);
  if (signature !== undefined && !LEGACY_HASH.test(signature))
    throw new Error("Invalid legacy result source signature");
  const conflict = input.kind === "conflict";
  const body = conflict
    ? "public.resolve_progressive_report(storage.report,storage.result_payload_hash)"
    : "public.resolve_progressive_report(r.report,r.result_payload_hash)";
  return `SELECT r.sim_job_id,r.sequence,r.content_signature,r.report->>'solverId' AS solver_id,
    to_jsonb(r.*) AS row_json,${body} AS full_report,
    ${conflict ? "storage.result_payload_hash" : "r.result_payload_hash"} AS payload_hash,
    (r.archived_at IS NOT NULL ${conflict ? "OR storage.report IS NULL OR storage.archive_bundle_id IS NOT NULL" : ""}) AS unavailable
    FROM public.${conflict ? "progressive_worker_report_conflicts" : "progressive_worker_reports"} r
    ${
      conflict
        ? `LEFT JOIN public.progressive_worker_conflict_storage storage
      ON storage.sim_job_id=r.sim_job_id AND storage.sequence=r.sequence AND storage.content_signature=r.content_signature`
        : ""
    }
    WHERE r.sim_job_id='${input.executionId}'::uuid AND r.sequence=${input.sequence}
    ${signature === undefined ? "" : `AND r.content_signature='${signature}'`}`;
}

function referenceSql(reference: LegacyResultReference): string {
  return `jsonb_build_object('executionId','${reference.executionId}','kind','${reference.kind}',
    'sequence',${reference.sequence},'contentSignature','${reference.contentSignature}',
    'sha256','${reference.sha256}','byteSize',${reference.byteSize})`;
}

/** PostgreSQL cuts its own canonical JSON text at a unique scalar placeholder.
 * Numeric tokens and metadata never pass through a JS JSON serializer. A
 * colliding placeholder or a non-object result uses the original full path. */
export function legacyResultMemberSql(
  input: Key,
  maxBytes: number,
  previous?: LegacyResultReference,
  nonce = randomUUID(),
): string {
  key(input);
  legacyBound(maxBytes, MAX_BYTES, "page bytes");
  if (!LEGACY_UUID.test(nonce))
    throw new Error("Invalid legacy result template nonce");
  if (previous) {
    key(previous);
    if (
      previous.executionId !== input.executionId ||
      !LEGACY_HASH.test(previous.contentSignature) ||
      !LEGACY_HASH.test(previous.sha256)
    )
      throw new Error(
        "A reused legacy result must belong to this exact execution",
      );
    legacyBound(previous.byteSize, MAX_BYTES, "verified result bytes");
  }
  const marker = `__legacy_result_${nonce}__`;
  const token = JSON.stringify(marker);
  const predecessor = previous
    ? `SELECT p.full_report->'result' AS result,
      (p.full_report->'result')::text AS result_text,p.payload_hash
    FROM (${sourceRow(previous, previous.contentSignature)}) p WHERE NOT p.unavailable`
    : "SELECT NULL::jsonb AS result,NULL::text AS result_text,NULL::text AS payload_hash WHERE false";
  const reusable = previous
    ? `EXISTS (SELECT 1 FROM predecessor p
    WHERE jsonb_typeof(p.result)='object'
      AND octet_length(p.result_text)=${previous.byteSize}
      AND encode(sha256(convert_to(p.result_text,'UTF8')),'hex')='${previous.sha256}'
      AND ((m.payload_hash IS NOT NULL AND m.payload_hash=p.payload_hash)
        OR m.result_text COLLATE "C"=p.result_text COLLATE "C"))`
    : "false";
  const currentReference = `jsonb_build_object('executionId',sim_job_id::text,'kind','${input.kind}',
    'sequence',sequence,'contentSignature',content_signature,'sha256',result_sha256,'byteSize',result_bytes)`;
  return legacyReadOnlySql(`WITH selected AS MATERIALIZED (${sourceRow(input)}),
  predecessor AS MATERIALIZED (${predecessor}),
  measured AS MATERIALIZED (
    SELECT *,row_json::text AS row_text,full_report::text AS report_text,
      (full_report->'result')::text AS result_text,
      octet_length(row_json::text)::bigint AS row_bytes,octet_length(full_report::text)::bigint AS report_bytes,
      octet_length((full_report->'result')::text)::bigint AS result_bytes,
      encode(sha256(convert_to(row_json::text,'UTF8')),'hex') AS row_sha256,
      encode(sha256(convert_to(full_report::text,'UTF8')),'hex') AS report_sha256,
      encode(sha256(convert_to((full_report->'result')::text,'UTF8')),'hex') AS result_sha256
    FROM selected
  ), templates AS MATERIALIZED (
    SELECT m.*,${reusable} AS reuse,
      CASE WHEN NOT unavailable AND row_bytes+report_bytes<=${maxBytes} AND jsonb_typeof(full_report->'result')='object'
        THEN jsonb_set(full_report,'{result}',to_jsonb('${marker}'::text),false)::text END AS report_template,
      CASE WHEN NOT unavailable AND row_bytes+report_bytes<=${maxBytes} AND jsonb_typeof(full_report->'result')='object'
        AND (row_json#>'{report,result}')::text COLLATE "C"=result_text COLLATE "C"
        THEN jsonb_set(row_json,'{report,result}',to_jsonb('${marker}'::text),false)::text END AS row_template
    FROM measured m
  ), packet AS MATERIALIZED (
    SELECT *,jsonb_build_object('kind','${input.kind}','executionId',sim_job_id::text,'sequence',sequence,
      'contentSignature',content_signature,'solverId',solver_id,'rowSha256',row_sha256,
      'reportSha256',report_sha256,'reportByteSize',report_bytes) AS metadata,
      (report_template IS NOT NULL
        AND length(report_template)-length(replace(report_template,'${token}',''))=length('${token}')
        AND (row_template IS NULL OR length(row_template)-length(replace(row_template,'${token}',''))=length('${token}'))) AS unambiguous
    FROM templates
  ) SELECT CASE
    WHEN unavailable OR report_text IS NULL THEN jsonb_build_object('blocked','cold or missing source body requires its existing reader')
    WHEN row_bytes+report_bytes>${maxBytes} THEN jsonb_build_object('blocked','row exceeds remaining byte budget','inputBytes',row_bytes+report_bytes)
    WHEN NOT coalesce(unambiguous,false) THEN jsonb_build_object('transport','${FORMAT}','mode','full','rowByteSize',row_bytes,
      'member',metadata||jsonb_build_object('rowText',row_text,'reportText',report_text))
    ELSE metadata||jsonb_build_object('transport','${FORMAT}','mode',CASE WHEN reuse THEN 'reuse' ELSE 'define' END,
      'member',metadata||jsonb_build_object('rowText',NULL,'reportText',NULL),
      'rowByteSize',row_bytes,
      'row',CASE WHEN row_template IS NULL THEN jsonb_build_object('text',row_text)
        ELSE jsonb_build_object('prefix',left(row_template,strpos(row_template,'${token}')-1),
          'suffix',substring(row_template FROM strpos(row_template,'${token}')+length('${token}'))) END,
      'report',jsonb_build_object('prefix',left(report_template,strpos(report_template,'${token}')-1),
        'suffix',substring(report_template FROM strpos(report_template,'${token}')+length('${token}'))),
      'result',CASE WHEN reuse THEN ${previous ? referenceSql(previous) : "NULL::jsonb"}
        ELSE ${currentReference}||jsonb_build_object('text',result_text) END)
    END::text FROM packet;`);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid legacy result transport packet");
  return value as Record<string, unknown>;
}

function size(value: unknown, limit: number): number {
  if (typeof value !== "number")
    throw new Error("Invalid legacy result byte proof");
  return legacyBound(value, limit, "decoded bytes");
}

function reference(value: unknown): LegacyResultReference {
  const entry = object(value);
  const result = {
    executionId: entry.executionId,
    kind: entry.kind,
    sequence: entry.sequence,
    contentSignature: entry.contentSignature,
    sha256: entry.sha256,
    byteSize: entry.byteSize,
  } as LegacyResultReference;
  key(result);
  if (
    !LEGACY_HASH.test(result.contentSignature) ||
    !LEGACY_HASH.test(result.sha256)
  )
    throw new Error("Invalid legacy result reference proof");
  size(result.byteSize, MAX_BYTES);
  return result;
}

function sameReference(
  left: LegacyResultReference,
  right: LegacyResultReference,
): boolean {
  return (
    left.executionId === right.executionId &&
    left.kind === right.kind &&
    left.sequence === right.sequence &&
    left.contentSignature === right.contentSignature &&
    left.sha256 === right.sha256 &&
    left.byteSize === right.byteSize
  );
}

function restore(
  value: unknown,
  result: VerifiedResult,
  expectedBytes: number,
): string {
  const template = object(value);
  if (Object.hasOwn(template, "text")) {
    if (
      Object.keys(template).length !== 1 ||
      typeof template.text !== "string" ||
      Buffer.byteLength(template.text) !== expectedBytes
    )
      throw new Error("Legacy literal row differs from its SQL byte proof");
    return template.text;
  }
  if (
    Object.keys(template).length !== 2 ||
    typeof template.prefix !== "string" ||
    typeof template.suffix !== "string" ||
    Buffer.byteLength(template.prefix) +
      result.reference.byteSize +
      Buffer.byteLength(template.suffix) !==
      expectedBytes
  )
    throw new Error("Legacy result template differs from its SQL byte proof");
  return template.prefix + result.text + template.suffix;
}

/** One verified result for one execution, retained across pages of this reader.
 * A reference never substitutes for checking this observation's full row/report
 * SQL SHA-256 and size. No archive/receipt/cursor representation changes. */
export class LegacyResultTransport {
  private previous: VerifiedResult | undefined;
  private active = false;
  readonly stats = {
    definitions: 0,
    reuses: 0,
    fullMembers: 0,
    resultBytesReceived: 0,
    decodedBytes: 0,
  };
  constructor(
    private readonly source: Source,
    private readonly nonce = () => randomUUID(),
  ) {}

  clear(): void {
    this.previous = undefined;
  }

  async readMember(
    executionId: string,
    kind: LegacyReportKind,
    sequence: number,
    maxBytes: number,
  ): Promise<Record<string, unknown>[]> {
    const input = { executionId, kind, sequence };
    key(input);
    legacyBound(maxBytes, MAX_BYTES, "page bytes");
    if (this.active)
      throw new Error("Concurrent legacy result reads are unsupported");
    this.active = true;
    if (this.previous?.reference.executionId !== executionId) this.clear();
    const previous = this.previous;
    try {
      const rows = await this.source.query(
        legacyResultMemberSql(
          input,
          maxBytes,
          previous?.reference,
          this.nonce(),
        ),
        maxBytes * 6 + 1024 ** 2,
      );
      if (rows.length !== 1)
        throw new Error("Frozen legacy result source member missing");
      const packet = rows[0]!;
      if (packet.blocked) return rows;
      if (packet.transport !== FORMAT)
        throw new Error("Unrecognized legacy result transport");
      const rowBytes = size(packet.rowByteSize, maxBytes);
      const meta = packet.mode === "full" ? object(packet.member) : packet;
      const reportBytes = size(meta.reportByteSize, maxBytes);
      if (rowBytes + reportBytes > maxBytes)
        throw new Error(
          "Legacy result transport exceeded decoded page byte budget",
        );
      let result: VerifiedResult | undefined;
      let member: LegacyReportMember;
      if (packet.mode === "full")
        member = { ...meta } as unknown as LegacyReportMember;
      else {
        const ref = reference(packet.result);
        if (ref.executionId !== executionId || ref.byteSize > reportBytes)
          throw new Error(
            "Legacy result reference crossed its execution or byte budget",
          );
        if (packet.mode === "define") {
          const body = object(packet.result).text;
          if (
            typeof body !== "string" ||
            Buffer.byteLength(body) !== ref.byteSize ||
            sha256(body) !== ref.sha256 ||
            ref.kind !== kind ||
            ref.sequence !== sequence ||
            ref.contentSignature !== packet.contentSignature
          )
            throw new Error(
              "Legacy result definition differs from its SQL proof",
            );
          result = { reference: ref, text: body };
        } else if (
          packet.mode === "reuse" &&
          previous &&
          sameReference(ref, previous.reference) &&
          !Object.hasOwn(object(packet.result), "text")
        )
          result = previous;
        else
          throw new Error(
            "Legacy result reference has no identical verified predecessor",
          );
        // The existing archive encoder preserves member property order. Let
        // PostgreSQL supply exactly the original jsonb member layout, then fill
        // its two text slots without moving or reserializing any source field.
        const layout = object(packet.member);
        const fields = [
          "kind",
          "executionId",
          "sequence",
          "contentSignature",
          "solverId",
          "rowSha256",
          "reportSha256",
          "reportByteSize",
        ];
        if (
          Object.keys(layout).length !== fields.length + 2 ||
          layout.rowText !== null ||
          layout.reportText !== null ||
          fields.some((field) => layout[field] !== packet[field])
        )
          throw new Error(
            "Legacy result member layout differs from its SQL metadata",
          );
        member = { ...layout } as unknown as LegacyReportMember;
        member.rowText = restore(packet.row, result, rowBytes);
        member.reportText = restore(packet.report, result, reportBytes);
      }
      if (
        member.executionId !== executionId ||
        member.kind !== kind ||
        member.sequence !== sequence ||
        typeof member.rowText !== "string" ||
        Buffer.byteLength(member.rowText) !== rowBytes
      )
        throw new Error(
          "Legacy result transport changed the original row identity or size",
        );
      checkLegacyMember(member);
      if (result)
        this.previous = {
          text: result.text,
          reference: {
            ...result.reference,
            ...input,
            contentSignature: member.contentSignature,
          },
        };
      if (packet.mode === "define") {
        this.stats.definitions++;
        this.stats.resultBytesReceived += result!.reference.byteSize;
      } else if (packet.mode === "reuse") this.stats.reuses++;
      else this.stats.fullMembers++;
      this.stats.decodedBytes += rowBytes + reportBytes;
      return [member as unknown as Record<string, unknown>];
    } finally {
      this.active = false;
    }
  }
}
