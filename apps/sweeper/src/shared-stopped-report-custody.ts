import { prepareStoppedAnchorHead } from "./stopped-report-anchor-head";
import {
  verifySharedReportReaders,
  type SharedReportReaderPair,
} from "./shared-report-reader-verification";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  canonicalReportJson,
  parseReportJson,
  splitProgressiveReportText,
} from "@aerodb/db/progressive-report-archive";
import {
  cancelledReportOwner,
  repeatedStoppedSource,
  scientificallyReceiptedReportCopy,
} from "./cancelled-report-copies";
import {
  SHARED_REPORT_FORMAT,
  writeSharedReportPage,
  type SharedReportInput,
  type SharedReportMember,
  type SharedReportOwner,
  type SharedReportManifest,
} from "./shared-report-archive";
import { sha256, type ReportObjects } from "./shared-report-objects";
import { matchingReportResultSuffix } from "./report-archive-source-proof";

const limit = 64 * 1024 ** 2;
export function stoppedReportPageText() {
  let prior:
    | { prefix: string; result: string; hash: string; size: number }
    | undefined;
  return (env: string, storedHash: string | null, protectedBytes: number) => {
    const suffix =
      storedHash === null ? matchingReportResultSuffix(env, prior) : undefined;
    if (prior && suffix !== undefined) return { ...prior, suffix };
    prior = undefined;
    const cut = splitProgressiveReportText(env);
    if (storedHash && !cut.result)
      throw new Error("Protected SQL result has no root result header");
    if (!storedHash && cut.result !== null) {
      prior = {
        prefix: cut.prefix,
        result: cut.result,
        hash: sha256(cut.result),
        size: Buffer.byteLength(cut.result),
      };
      return { ...prior, suffix: cut.suffix };
    }
    return {
      prefix: cut.prefix,
      suffix: cut.suffix,
      result: null,
      hash: storedHash,
      size: storedHash ? protectedBytes : undefined,
    };
  };
}
const pointList = sql`coalesce((SELECT jsonb_agg(jsonb_build_object('point_content_signature',s.point_content_signature,
  'aoa_deg',s.aoa_deg,'case_slug',s.case_slug) ORDER BY s.point_content_signature COLLATE "C")
  FROM progressive_remote_report_sources s WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence),'[]'::jsonb)`;
const nullCopy = sql`i.source_count=0 AND r.result_payload_hash IS NULL AND r.report->'result'='null'::jsonb
  AND NOT EXISTS (SELECT FROM progressive_remote_evidence_receipts e WHERE e.sim_job_id=r.sim_job_id AND e.sequence=r.sequence)
  AND NOT EXISTS (SELECT FROM progressive_remote_diagnostic_receipts d WHERE d.sim_job_id=r.sim_job_id AND d.sequence=r.sequence)
  AND EXISTS (SELECT FROM progressive_remote_reports later WHERE later.sim_job_id=r.sim_job_id AND later.sequence>r.sequence)`;
const release = sql`((${repeatedStoppedSource}) OR (${nullCopy}))`;
const base = sql`FROM progressive_remote_reports r JOIN progressive_remote_report_inventories i USING(sim_job_id,sequence)
  JOIN progressive_remote_progress_receipts applied USING(sim_job_id,sequence)`;
const signed = sql`r.archived_at IS NULL AND r.archive_bundle_id IS NULL AND i.report_content_signature=r.content_signature
  AND applied.content_signature=r.content_signature`;
async function ownership(db: DB, executionId: string, lock = false) {
  const [r] =
    await db.execute(sql`SELECT job.id::text AS "executionId", d.solver_id::text AS "solverId",
    d.promise_id::text AS "promiseId",d.content_signature AS "assignmentSignature",st.proof_signature AS stop
    FROM sim_jobs job JOIN progressive_remote_dispatches d ON d.sim_job_id=job.id JOIN sync_sweep_promises promise ON promise.id=d.promise_id
    JOIN progressive_cfd_execution_stops st ON st.sim_job_id=job.id AND st.engine_job_id=job.engine_job_id
    WHERE job.id=${executionId}::uuid AND ${cancelledReportOwner} ${lock ? sql`FOR SHARE OF job,promise,d,st` : sql``}`);
  if (!r) throw new Error("Stopped report owner or lease changed");
  return {
    owner: {
      executionId: String(r.executionId),
      solverId: String(r.solverId),
      promiseId: String(r.promiseId),
      assignmentSignature: String(r.assignmentSignature),
    },
    stop: String(r.stop),
  };
}
export interface StoppedReportKey {
  sequence: number;
  signature: string;
}
export interface StoppedCopyReceipt {
  mode: "release" | "preserve" | "anchor";
  owner: SharedReportOwner;
  stop: string;
  object: Awaited<ReturnType<typeof writeSharedReportPage>>["pin"];
  members: Pick<
    SharedReportMember,
    | "sequence"
    | "signature"
    | "reportSha256"
    | "reportByteSize"
    | "inventorySignature"
    | "sourceListSha256"
    | "resultHash"
  >[];
  bucket: string;
  results: SharedReportManifest["results"];
  storedReportFieldsBefore: number;
  storedReportFieldsAfter: number;
  released: number;
  releasedReferenceBytes: number;
  releasedProtectedResults: { hash: string; storedBytes: number }[];
  resultBytesSubmitted: number;
}
export async function stoppedReportCopyKeys(
  db: DB,
  job: string,
  after: number,
  rows = 32,
  scientific = false,
) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 128
  )
    throw new Error("Invalid stopped report key page");
  await ownership(db, job);
  // Use fixed, ordered identity windows. Existing archived rows advance the cursor.
  const keys = scientific
    ? sql`SELECT DISTINCT s.sim_job_id,s.sequence FROM progressive_remote_report_sources s
    WHERE s.sim_job_id=${job}::uuid AND s.sequence>${after} AND EXISTS (SELECT FROM progressive_remote_reports warm
      WHERE (warm.sim_job_id,warm.sequence)=(s.sim_job_id,s.sequence) AND warm.archived_at IS NULL)
    ORDER BY s.sim_job_id,s.sequence LIMIT ${rows}`
    : sql`SELECT sim_job_id,sequence FROM progressive_remote_reports WHERE sim_job_id=${job}::uuid AND sequence>${after} ORDER BY sequence LIMIT ${rows}`;
  const page = await db.execute(sql`WITH keys AS MATERIALIZED (${keys})
    SELECT r.sequence::int seq,r.content_signature sig,${scientific ? sql`pg_column_size(r.report)` : sql`0`} AS stored,CASE WHEN r.archived_at IS NOT NULL THEN 'cold'
    WHEN i.report_content_signature IS DISTINCT FROM r.content_signature OR applied.content_signature IS DISTINCT FROM r.content_signature THEN 'missing'
    WHEN ${scientificallyReceiptedReportCopy} THEN 'ordinary' WHEN ${release} THEN 'release' ELSE 'preserve' END AS mode
    FROM keys JOIN progressive_remote_reports r USING(sim_job_id,sequence)
    LEFT JOIN progressive_remote_report_inventories i USING(sim_job_id,sequence) LEFT JOIN progressive_remote_progress_receipts applied USING(sim_job_id,sequence)
    ORDER BY r.sequence`);
  return Array.from(page, (r) => ({
    sequence: Number(r.seq),
    signature: String(r.sig),
    mode: String(r.mode),
    storedBytes: Number(r.stored),
  }));
}

export async function copyStoppedReportBatch(
  db: DB,
  objects: ReportObjects,
  job: string,
  keys: readonly StoppedReportKey[],
  mode: "release" | "preserve" | "anchor",
  options: {
    beforePublish?: (receipt: StoppedCopyReceipt) => Promise<void>;
    preserved?: StoppedCopyReceipt;
    beforeCommit?: (receipt: StoppedCopyReceipt) => Promise<void>;
    readers?: SharedReportReaderPair;
  } = {},
): Promise<StoppedCopyReceipt> {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver")
    throw new Error("Stopped report cloud custody belongs to the hub");
  if (
    !keys.length ||
    keys.length > 128 ||
    keys.some(
      (k, i) =>
        !Number.isSafeInteger(k.sequence) ||
        k.sequence <= 0 ||
        (i > 0 && keys[i - 1].sequence >= k.sequence) ||
        !/^[a-f0-9]{64}$/.test(k.signature),
    )
  )
    throw new Error("Invalid exact stopped report page");
  const selected = await ownership(db, job);
  const saved = options.preserved;
  let head: { sequence: number; signature: string } | undefined;
  if (mode === "anchor") {
    if (
      !saved ||
      saved.mode !== "preserve" ||
      saved.owner.executionId !== job ||
      saved.owner.solverId !== selected.owner.solverId ||
      saved.owner.promiseId !== selected.owner.promiseId ||
      saved.owner.assignmentSignature !== selected.owner.assignmentSignature ||
      saved.stop !== selected.stop ||
      saved.bucket !== objects.bucket
    )
      throw new Error(
        "Anchor release requires its verified preserved cloud original",
      );
    head = await prepareStoppedAnchorHead(db, selected.owner, selected.stop);
    // Reopen the previously verified exact generation, even if a new object
    // now has the same key. No newer or latest generation can stand in for it.
    await verifySharedReportReaders(saved, options.readers);
  }
  const inputs: SharedReportInput[] = [];
  const frozen: {
    seq: number;
    sig: string;
    inventory: string;
    sourcesText: string;
    received: string;
    hash: string | null;
    stored: number;
    refBytes: number;
  }[] = [];
  let logical = 0,
    envelope = 0;
  const pageText = stoppedReportPageText();
  for (const key of keys) {
    const [r] = await db.execute(sql`WITH original AS MATERIALIZED (
      SELECT r.sequence,r.content_signature,r.received_at::text received,r.result_payload_hash h,pg_column_size(r.report)::int stored,coalesce(pg_column_size(r.result_payload_hash),0)::int ref_bytes,
        r.report::text AS env,CASE WHEN r.result_payload_hash IS NOT NULL THEN
          public.resolve_progressive_report(r.report,r.result_payload_hash)::text END AS resolved,
        i.inventory_signature AS inventory,i.source_count AS n,${pointList}::text AS points,
        (SELECT byte_size FROM progressive_report_result_payloads p WHERE p.content_hash=r.result_payload_hash) AS payload_bytes
      ${base} WHERE r.sim_job_id=${job}::uuid AND r.sequence=${key.sequence} AND r.content_signature=${key.signature} AND ${signed}
        AND NOT (${scientificallyReceiptedReportCopy}) AND (${release})=${mode === "release"})
     SELECT h,stored,ref_bytes,received,inventory,n,points,payload_bytes,octet_length(coalesce(resolved,env))::int AS bytes,
       encode(sha256(convert_to(coalesce(resolved,env),'UTF8')),'hex') AS sha,CASE WHEN octet_length(env)<=${limit} THEN env END AS env FROM original`);
    if (!r || typeof r.env !== "string" || Number(r.bytes) > limit)
      throw new Error(
        "Stopped report source changed or exceeds its size bound",
      );
    if (inputs.length && logical + Number(r.bytes) > 128 * 1024 ** 2) break;
    const storedHash = r.h == null ? null : String(r.h);
    const cut = pageText(r.env, storedHash, Number(r.payload_bytes));
    const h = cut.hash,
      resultSize = cut.size,
      inline = cut.result;
    const member = {
      sequence: key.sequence,
      signature: key.signature,
      reportSha256: String(r.sha),
      reportByteSize: Number(r.bytes),
      inventorySignature: String(r.inventory),
      sourceCount: Number(r.n),
      sourceListSha256: sha256(
        canonicalReportJson(parseReportJson(String(r.points))),
      ),
      prefix: cut.prefix,
      suffix: cut.suffix,
      resultHash: h,
    };
    if (mode === "anchor") {
      const old = saved!.members.find((v) => v.sequence === member.sequence);
      if (
        !old ||
        old.signature !== member.signature ||
        old.reportSha256 !== member.reportSha256 ||
        old.reportByteSize !== member.reportByteSize ||
        old.inventorySignature !== member.inventorySignature ||
        old.sourceListSha256 !== member.sourceListSha256 ||
        old.resultHash !== member.resultHash
      )
        throw new Error(
          "Warm anchor differs from its original verified cloud member",
        );
    }
    const extra = Buffer.byteLength(JSON.stringify(member));
    if (inputs.length && envelope + extra > 6 * 1024 ** 2) break;
    envelope += extra;
    logical += member.reportByteSize;
    inputs.push({
      ...member,
      resultSize,
      loadResult: h
        ? async () => {
            if (inline !== null) return inline;
            const [v] = await db.execute(
              sql`SELECT result::text AS value FROM progressive_report_result_payloads WHERE content_hash=${h} AND byte_size=${resultSize}`,
            );
            if (typeof v?.value !== "string")
              throw new Error("Protected SQL result is unavailable");
            return v.value;
          }
        : undefined,
    });
    frozen.push({
      seq: key.sequence,
      sig: key.signature,
      inventory: String(r.inventory),
      sourcesText: String(r.points),
      received: String(r.received),
      hash: storedHash,
      stored: Number(r.stored),
      refBytes: Number(r.ref_bytes),
    });
  }
  const copied = await writeSharedReportPage(
    objects,
    selected.owner,
    inputs,
    mode === "anchor" && saved
      ? { results: saved.results, manifest: saved.object }
      : undefined,
  );
  const receipt: StoppedCopyReceipt = {
    mode,
    ...selected,
    bucket: objects.bucket,
    object: copied.pin,
    results: copied.manifest.results,
    members: copied.manifest.members.map(
      ({
        sequence,
        signature,
        reportSha256,
        reportByteSize,
        inventorySignature,
        sourceListSha256,
        resultHash,
      }) => ({
        sequence,
        signature,
        reportSha256,
        reportByteSize,
        inventorySignature,
        sourceListSha256,
        resultHash,
      }),
    ),
    storedReportFieldsBefore: frozen.reduce((n, r) => n + r.stored, 0),
    storedReportFieldsAfter: frozen.reduce((n, r) => n + r.stored, 0),
    released: 0,
    releasedReferenceBytes: 0,
    releasedProtectedResults: [],
    resultBytesSubmitted: copied.resultBytesSubmitted,
  };
  const sameVerifiedPage =
    mode === "anchor" &&
    saved &&
    saved.object.key === receipt.object.key &&
    saved.object.generation === receipt.object.generation &&
    saved.object.sha256 === receipt.object.sha256 &&
    saved.members.length === receipt.members.length;
  if (!sameVerifiedPage)
    await verifySharedReportReaders(receipt, options.readers);
  if (options.beforePublish) await options.beforePublish(receipt);
  // A failed/crashed copy can leave a content-addressed object. Only this
  // transaction attaches its pinned, authenticated manifest to the live rows.
  return db.transaction(async (tx) => {
    const conn = tx as unknown as DB;
    const live = await ownership(conn, job, true);
    if (
      live.stop !== selected.stop ||
      live.owner.assignmentSignature !== selected.owner.assignmentSignature ||
      live.owner.promiseId !== selected.owner.promiseId ||
      live.owner.solverId !== selected.owner.solverId
    )
      throw new Error(
        "Stopped report dispatch changed during cloud verification",
      );
    if (head) {
      const [latest] = await conn.execute(
        sql`SELECT sequence::int seq,content_signature sig FROM progressive_remote_reports WHERE sim_job_id=${job}::uuid ORDER BY sequence DESC LIMIT 1`,
      );
      if (latest?.seq !== head.sequence || latest.sig !== head.signature)
        throw new Error("Terminal report changed during anchor verification");
    }
    const entries = JSON.stringify(frozen);
    const locks = await conn.execute(sql`SELECT r.sequence::int AS seq ${base}
      JOIN jsonb_to_recordset(${entries}::jsonb) f(seq bigint,sig text,inventory text,"sourcesText" text,received text,hash text)
        ON f.seq=r.sequence AND f.sig=r.content_signature AND f.inventory=i.inventory_signature AND f."sourcesText"::jsonb=${pointList}
      WHERE r.sim_job_id=${job}::uuid AND r.received_at=f.received::timestamptz AND ${signed} AND r.result_payload_hash IS NOT DISTINCT FROM f.hash
       AND NOT (${scientificallyReceiptedReportCopy}) AND (${release})=${mode === "release"} ORDER BY r.sequence FOR UPDATE OF r`);
    if (locks.length !== frozen.length)
      throw new Error(
        "Stopped report identity or eligibility changed during cloud verification",
      );
    const before = frozen.reduce((n, r) => n + r.stored, 0);
    if (mode === "preserve") return receipt;
    const { pin, manifest } = copied;
    const [b] =
      await conn.execute(sql`INSERT INTO progressive_report_archive_bundles
      (source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
      VALUES('remote',${job}::uuid,${objects.bucket},${pin.key},${pin.generation},'application/gzip','gzip',${SHARED_REPORT_FORMAT},${pin.sha256},${pin.size},${pin.crc32c},${inputs.length},${inputs[0].sequence},${inputs.at(-1)!.sequence},clock_timestamp()) RETURNING id`);
    const members = manifest.members.map((m) => ({
      seq: m.sequence,
      sig: m.signature,
      sha: m.reportSha256,
      bytes: m.reportByteSize,
    }));
    await conn.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
      SELECT ${b.id}::uuid,'remote',${job}::uuid,seq,'report',sig,sha,bytes FROM jsonb_to_recordset(${JSON.stringify(members)}::jsonb) m(seq bigint,sig text,sha text,bytes bigint)`);
    const changed =
      await conn.execute(sql`UPDATE progressive_remote_reports r SET archive_bundle_id=${b.id}::uuid,archived_at=clock_timestamp(),
      report=progressive_report_compact_header(r.report),result_payload_hash=NULL
      FROM progressive_report_archive_members m WHERE m.bundle_id=${b.id}::uuid AND (r.sim_job_id,r.sequence,r.content_signature)=(m.sim_job_id,m.sequence,m.content_signature)
      AND r.archive_bundle_id IS NULL AND r.archived_at IS NULL RETURNING r.sequence`);
    if (changed.length !== frozen.length)
      throw new Error("Incomplete shared report publication");
    const hashes = [
      ...new Set(frozen.flatMap((r) => (r.hash ? [r.hash] : []))),
    ];
    const removed = hashes.length
      ? await conn.execute(sql`DELETE FROM progressive_report_result_payloads p WHERE p.content_hash IN (${sql.join(
          hashes.map((h) => sql`${h}`),
          sql`,`,
        )})
      AND NOT EXISTS (SELECT FROM progressive_remote_reports r WHERE r.result_payload_hash=p.content_hash)
      AND NOT EXISTS (SELECT FROM progressive_worker_reports w WHERE w.result_payload_hash=p.content_hash) RETURNING p.content_hash AS hash,pg_column_size(p.result)::int AS size`)
      : [];
    const [size] =
      await conn.execute(sql`SELECT sum(pg_column_size(r.report))::text AS stored FROM progressive_report_archive_members m
      JOIN progressive_remote_reports r ON (r.sim_job_id,r.sequence,r.archive_bundle_id)=(m.sim_job_id,m.sequence,m.bundle_id)
      WHERE m.bundle_id=${b.id}::uuid AND m.source_kind='remote' AND m.member_kind='report'`);
    const committed: StoppedCopyReceipt = {
      ...receipt,
      storedReportFieldsBefore: before,
      storedReportFieldsAfter: Number(size.stored),
      released: inputs.length,
      releasedReferenceBytes: frozen.reduce((n, r) => n + r.refBytes, 0),
      releasedProtectedResults: removed.map((r) => ({
        hash: String(r.hash),
        storedBytes: Number(r.size),
      })),
    };
    // A durable local measurement is accepted only alongside the subsequently
    // committed matching SQL bundle. An abandoned transaction cannot inflate it.
    await options.beforeCommit?.(committed);
    return committed;
  });
}
