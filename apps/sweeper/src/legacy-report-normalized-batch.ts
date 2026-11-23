import { randomUUID } from "node:crypto";
import {
  LEGACY_HASH,
  LEGACY_UUID,
  legacyBound,
  legacyReadOnlySql,
  type LegacyReportMember,
} from "@aerodb/db/legacy-report-storage";
import { legacySha256 } from "./legacy-report-storage-gcs";
import type { LegacySqlReader } from "./legacy-report-storage";

export interface NormalizedPrefix {
  members: LegacyReportMember[];
  nextCost: number | null;
  dictionaryBytes: number;
  decodedBytes: number;
}

/** Read a same-payload prefix of already-normalized worker rows from one
 * repeatable-read snapshot. All other representations use the original reader.
 * PostgreSQL independently hashes the actual resolver output for every member.
 * Only admitted rows expand that output; only one result crosses the wire. */
export async function readNormalizedPrefix(
  source: Pick<LegacySqlReader, "query">,
  executionId: string,
  keys: number[],
  budget: number,
): Promise<NormalizedPrefix | null> {
  if (!LEGACY_UUID.test(executionId))
    throw Error("Invalid normalized batch owner");
  legacyBound(budget, 256 * 1024 ** 2, "batch decoded byte bound");
  const seq = keys.slice(0, 32);
  if (seq.length < 2) return null;
  for (const [i, n] of seq.entries()) {
    legacyBound(n, Number.MAX_SAFE_INTEGER, "batch sequence");
    if (i && n <= seq[i - 1]!) throw Error("Unordered normalized batch keys");
  }
  const maxResultBytes = Math.floor(budget / 2);
  const token = JSON.stringify("__legacy_batch_" + randomUUID() + "__");
  const marker = token.slice(1, -1),
    job = `'${executionId}'::uuid`;
  const sql =
    legacyReadOnlySql(`WITH keys(ord,seq) AS (VALUES ${seq.map((n, i) => `(${i + 1},${n}::bigint)`).join(",")}),
  head AS MATERIALIZED (
    SELECT p.content_hash,p.byte_size,public.progressive_report_result_header(p.result) AS header
    FROM public.progressive_worker_reports r JOIN public.progressive_report_result_payloads p ON p.content_hash=r.result_payload_hash
    WHERE r.sim_job_id=${job} AND r.sequence=${seq[0]} AND r.archived_at IS NULL AND p.byte_size<=${maxResultBytes}
      AND EXISTS(SELECT FROM public.progressive_worker_reports s WHERE s.sim_job_id=r.sim_job_id AND s.sequence=${seq[1]}
        AND s.result_payload_hash=p.content_hash AND s.archived_at IS NULL)
  ), small AS MATERIALIZED (
    SELECT k.ord,r.sequence,r.content_signature,r.report AS envelope,r.result_payload_hash,
      to_jsonb(r.*)::text AS row_text,jsonb_set(r.report,'{result}',to_jsonb('${marker}'::text),false)::text AS template,h.byte_size
    FROM head h CROSS JOIN keys k JOIN public.progressive_worker_reports r ON r.sim_job_id=${job} AND r.sequence=k.seq
    WHERE r.archived_at IS NULL AND r.result_payload_hash=h.content_hash AND r.report->'result'=h.header
      AND octet_length(r.report::text)<=65536
  ), spans AS MATERIALIZED (
    SELECT *,left(template,strpos(template,'${token}')-1) AS prefix,
      substring(template FROM strpos(template,'${token}')+length('${token}')) AS suffix
    FROM small WHERE octet_length(row_text)<=131072 AND
      length(template)-length(replace(template,'${token}',''))=length('${token}')
  ), costs AS MATERIALIZED (
    SELECT *,byte_size+octet_length(prefix)+octet_length(suffix) AS report_cost FROM spans
  ), measured AS MATERIALIZED (
    SELECT *,row_number() OVER(ORDER BY ord) AS pos,
      sum(octet_length(row_text)::bigint+report_cost) OVER(ORDER BY ord) AS used FROM costs
  ), admitted AS MATERIALIZED (SELECT * FROM measured WHERE pos=ord AND used<=${budget}),
  dictionary AS MATERIALIZED (
    SELECT p.result::text AS text,p.content_hash,p.byte_size FROM head h JOIN public.progressive_report_result_payloads p
      ON p.content_hash=h.content_hash WHERE EXISTS(SELECT FROM admitted WHERE ord=2)
  ), records AS (
    SELECT 0 AS ord,jsonb_build_object('text',d.text,'sha256',d.content_hash,'bytes',d.byte_size,
      'nextCost',(SELECT octet_length(row_text)::bigint+report_cost FROM measured WHERE pos=ord AND ord=(SELECT max(ord)+1 FROM admitted) AND used>${budget})) AS packet
    FROM dictionary d
    UNION ALL
    SELECT a.ord,jsonb_build_object('prefix',a.prefix,'suffix',a.suffix,'member',jsonb_build_object(
      'executionId',${job}::text,'kind','report','sequence',a.sequence,'contentSignature',a.content_signature,
      'solverId',a.envelope->>'solverId','rowText',a.row_text,'reportText',null,
      'rowSha256',encode(sha256(convert_to(a.row_text,'UTF8')),'hex'),'reportByteSize',a.report_cost,
      'reportSha256',encode(sha256(convert_to(public.resolve_progressive_report(a.envelope,a.result_payload_hash)::text,'UTF8')),'hex')))
    FROM admitted a WHERE EXISTS(SELECT FROM dictionary)
  ) SELECT packet::text FROM records ORDER BY ord;`);
  // Each JSON string can expand to six wire bytes per input byte. Only the
  // dictionary and small stored rows/envelopes can appear in this response.
  const maxWire =
    6 *
      Math.min(budget, maxResultBytes + seq.length * (131072 + 65536 + 1024)) +
    65536;
  const packets = await source.query(sql, maxWire);
  if (!packets.length) return null;
  const [head, ...rows] = packets;
  if (
    !head ||
    rows.length < 2 ||
    rows.length > seq.length ||
    typeof head.text !== "string" ||
    typeof head.bytes !== "number" ||
    !Number.isSafeInteger(head.bytes) ||
    head.bytes < 1 ||
    head.bytes > maxResultBytes ||
    Buffer.byteLength(head.text) !== head.bytes ||
    !LEGACY_HASH.test(String(head.sha256)) ||
    legacySha256(head.text) !== head.sha256
  )
    throw Error("Invalid normalized batch dictionary");
  const result = head.text;
  const resultBytes = Buffer.byteLength(result);
  const members: LegacyReportMember[] = [];
  let used = 0;
  for (const [i, packet] of rows.entries()) {
    const member = packet.member as LegacyReportMember;
    if (
      !member ||
      member.kind !== "report" ||
      member.executionId !== executionId ||
      member.sequence !== seq[i] ||
      member.reportText !== null ||
      typeof member.rowText !== "string" ||
      typeof packet.prefix !== "string" ||
      typeof packet.suffix !== "string"
    )
      throw Error("Invalid normalized batch member");
    const cost =
      Buffer.byteLength(packet.prefix) +
      resultBytes +
      Buffer.byteLength(packet.suffix);
    used += cost + Buffer.byteLength(member.rowText);
    if (cost !== member.reportByteSize || used > budget)
      throw Error("Invalid normalized batch decoded byte budget");
    // Fill the original PG layout in place. readLegacyPage authenticates both
    // texts and the frozen solver/owner for every member before moving its cursor.
    member.reportText = packet.prefix + result + packet.suffix;
    members.push(member);
  }
  const nextCost = head.nextCost;
  if (
    nextCost !== null &&
    (typeof nextCost !== "number" ||
      !Number.isSafeInteger(nextCost) ||
      nextCost <= budget - used ||
      rows.length === seq.length)
  )
    throw Error("Invalid normalized batch continuation");
  return {
    members,
    nextCost,
    dictionaryBytes: resultBytes,
    decodedBytes: used,
  };
}
