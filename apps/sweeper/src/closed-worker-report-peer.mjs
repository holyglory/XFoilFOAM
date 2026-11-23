import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { HubWorkloadGcs, boundedHubBody } from "./hub-workload-gcs.ts";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { createClient } from "@aerodb/db/client";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  reportValidationValue,
  visitVerifiedWorkerReportArchive,
} from "@aerodb/db/progressive-report-archive";
import {
  installProgressiveReportArchiveReader,
  readProgressiveReport,
} from "@aerodb/db/progressive-report-reader";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import { verifyProgressiveRemoteExecution } from "@aerodb/db";
import { configuredDeploymentRole } from "./config.ts";
import {
  checkHzTransferFence,
  withActiveHzTransfer,
} from "./hz-attempt-transfer-fence.ts";
import { assertSourceKey } from "./registered-worker-report-hub.ts";
import { nativeReportOwner } from "./registered-worker-report-read.ts";
import {
  putWorkerReportBundle,
  readStoredWorkerArchiveText,
} from "./report-archive-broker-client.ts";
import {
  ProgressiveReportArchiveStore,
  writeProgressiveReportBundle,
} from "./progressive-report-archive-store.ts";
import { retainWorkerReportVolume } from "./worker-report-volume.ts";

const byteLimit = 32 * 1024 ** 2;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const eq = (a, b, message) => assert.ok(isDeepStrictEqual(a, b), message);

function eligible(value, reason) {
  if (!value) {
    const error = new Error(reason);
    error.name = "ClosedReportHeld";
    throw error;
  }
}
function matchingScience(actual, expected, reason) {
  eligible(isDeepStrictEqual(actual, expected), reason);
}

function signedFacts(text, key, owner, resultMeta) {
  assert.ok(
    Buffer.byteLength(text) <= byteLimit,
    "Report exceeds the bounded reader",
  );
  const fields = resultMeta ? new Map() : undefined;
  const value = reportJsonObject(parseReportJson(text, fields));
  if (resultMeta) {
    const raw = fields.get("result");
    resultMeta.sha256 = hash(raw);
    resultMeta.byteSize = Buffer.byteLength(raw);
  }
  assert.equal(
    hash(canonicalReportJson(value)),
    key.signature,
    "Signed report differs",
  );
  assert.equal(value.executionId, key.executionId);
  assert.equal(canonicalReportJson(value.sequence), String(key.sequence));
  assert.equal(value.solverId, owner.solverId);
  assert.equal(value.promiseId, owner.promiseId);
  assert.equal(value.assignmentSignature, owner.assignmentSignature);
  assert.equal(value.status?.job_id, key.executionId);
  assert.equal(value.result?.job_id, key.executionId);
  const inventory = retainedReportInventory(value, key.signature);
  eligible(
    inventory.sourceCount > 0 && inventory.sourceCount <= 512,
    "Expected a bounded signed point inventory",
  );
  const points = inventory.sources.map((p) => ({
    signature: p.point_content_signature,
    aoa: reportValidationValue(p.aoa_deg),
    caseSlug: p.case_slug,
  }));
  return {
    ...reportTextIdentity(text),
    inventory: inventory.signature,
    points,
  };
}

// A source may be reused only inside this process. Each subsequent committed product
// read still goes through the real installed reader and authenticates the physical generation.
const authenticatedSources = new WeakSet();
async function workerSource(
  db,
  key,
  scope,
  lock = false,
  coldPin = null,
  previous = null,
) {
  const id = key.executionId,
    seq = key.sequence;
  const owner = await nativeReportOwner(db, id);
  assert.equal(owner.workerInstance, scope.sourceInstance);
  assert.equal(owner.solverId, scope.solverId);
  await checkHzTransferFence(db, {
    instance: owner.workerInstance,
    solver: owner.solverId,
  });
  // Recheck the database's normal release and staging predicates at the actual key.
  const [row] =
    await db.execute(sql`SELECT r.result_payload_hash AS fk,pg_column_size(r.report) AS stored,
    r.archive_bundle_id,r.archived_at,r.stopped_engine_job_id,
    EXISTS(SELECT FROM progressive_worker_staging_candidates k WHERE k.sim_job_id=r.sim_job_id AND k.sequence=r.sequence) AS selectable,
    EXISTS(SELECT FROM progressive_worker_closed_staging_copies k WHERE k.sim_job_id=r.sim_job_id AND k.sequence=r.sequence) AS covered
    FROM progressive_worker_reports r JOIN sim_jobs j ON j.id=r.sim_job_id
    JOIN sync_sweep_promises p ON p.id=${owner.promiseId}::uuid AND p.id::text=j.request_payload->>'syncPromiseId'
    WHERE r.sim_job_id=${id}::uuid AND r.sequence=${seq} AND r.content_signature=${key.signature}
    AND r.assignment_signature=${owner.assignmentSignature} AND r.acknowledged_at IS NOT NULL AND r.stopped_engine_job_id IS NULL
    AND j.engine_job_id=j.id::text AND j.status IN('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
    AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
    AND p.registered_solver_id=${owner.solverId}::uuid AND p.status IN('expired','fulfilled','cancelled')
    AND p.source_base_url=${owner.upstream} AND j.request_payload->>'remoteSolver'='true'
    AND public.progressive_worker_report_evidence_settled(j.id,r.sequence)
    AND EXISTS(SELECT FROM progressive_worker_reports stop WHERE stop.sim_job_id=j.id AND stop.sequence>r.sequence
      AND stop.stopped_engine_job_id=j.engine_job_id AND stop.assignment_signature=r.assignment_signature AND stop.acknowledged_at IS NOT NULL)
    AND NOT EXISTS(SELECT FROM progressive_worker_evidence_receipts st WHERE st.sim_job_id=j.id AND st.sequence=r.sequence)
    AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=j.id AND c.sequence=r.sequence)
    AND NOT EXISTS(SELECT FROM progressive_worker_hub_report_links l WHERE l.sim_job_id=j.id AND l.sequence=r.sequence)
    AND NOT EXISTS(SELECT FROM result_attempts a WHERE a.sim_job_id=j.id AND a.status='running')
    AND NOT EXISTS(SELECT FROM progressive_worker_delivery_failures f WHERE f.sim_job_id=j.id AND f.state<>'conflict')
    ${lock ? sql`FOR UPDATE OF r NOWAIT FOR SHARE OF j,p NOWAIT` : sql``}`);
  eligible(
    row,
    "Worker report has an open owner, delivery or another custody path",
  );
  const stage = { selectable: row.selectable, covered: row.covered };
  if (row.archive_bundle_id || row.archived_at) {
    assert.ok(
      row.archive_bundle_id && row.archived_at && !row.fk,
      "Partial native archive",
    );
    eligible(coldPin, "Native report already belongs to another storage path");
    await verifyRegistration(db, key, row.archive_bundle_id, coldPin);
  }
  let text;
  const reuse =
    row.archived_at && previous && authenticatedSources.has(previous);
  if (reuse) {
    validatePin(coldPin, key, previous);
    eq(
      previous.owner,
      owner,
      "Authenticated original belongs to another owner",
    );
    text = previous.text;
  } else if (row.archived_at) {
    text = await readStoredWorkerArchiveText(db, coldPin);
  } else {
    const prior =
      await db.execute(sql`SELECT 1 FROM progressive_report_archive_members WHERE sim_job_id=${id}::uuid
      AND sequence=${seq} AND member_kind='report' LIMIT 1`);
    eligible(prior.length === 0, "Use the existing archive registration");
    const [source] =
      await db.execute(sql`WITH body AS MATERIALIZED (SELECT public.resolve_progressive_report(report,result_payload_hash)::text AS raw
      FROM progressive_worker_reports WHERE sim_job_id=${id}::uuid AND sequence=${seq} AND content_signature=${key.signature} AND archived_at IS NULL)
      SELECT CASE WHEN octet_length(raw)<=${byteLimit} THEN raw END AS text FROM body`);
    eligible(
      typeof source?.text === "string",
      "Worker original changed or exceeds the reader bound",
    );
    text = source.text;
  }
  const resultMeta = reuse ? previous.resultMeta : {};
  const facts = reuse
    ? previous.facts
    : signedFacts(text, key, owner, resultMeta);
  const anchors =
    await db.execute(sql`SELECT h.point_content_signature AS signature,h.sequence::int AS sequence,
    a.id::text AS "workerAttempt",a.result_id::text AS "workerResult",h.receipt->>'resultAttemptId' AS "hubAttempt",h.receipt->>'resultId' AS "hubResult",
    a.aoa_deg AS aoa,a.engine_case_slug AS "caseSlug",a.status AS "workerStatus",a.valid_for_polar AS "workerValidForPolar",a.cl::text AS "workerCl",a.cd::text AS "workerCd",a.cm::text AS "workerCm",
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM result_classifications c WHERE c.result_attempt_id=a.id) AS "workerClassification"
    FROM jsonb_to_recordset(${JSON.stringify(facts.points)}::jsonb) pt(signature text,aoa double precision,"caseSlug" text)
    JOIN progressive_worker_hub_receipts h ON h.sim_job_id=${id}::uuid AND h.point_content_signature=pt.signature AND h.sequence<>${seq}
    JOIN progressive_worker_evidence_attempts e USING(sim_job_id,sequence,point_content_signature,result_attempt_id)
    JOIN progressive_worker_evidence_receipts st ON st.sim_job_id=e.sim_job_id AND st.sequence=e.sequence
    JOIN progressive_worker_reports origin ON origin.sim_job_id=st.sim_job_id AND origin.sequence=st.sequence AND origin.content_signature=st.content_signature
      AND origin.acknowledged_at IS NOT NULL AND origin.assignment_signature=${owner.assignmentSignature}
    JOIN result_attempts a ON a.id=h.result_attempt_id AND a.sim_job_id=h.sim_job_id AND a.engine_job_id=h.sim_job_id::text
      AND a.aoa_deg=pt.aoa AND a.engine_case_slug IS NOT DISTINCT FROM pt."caseSlug" AND a.result_id IS NOT NULL
    JOIN sim_jobs j ON j.id=a.sim_job_id AND j.airfoil_id=a.airfoil_id AND j.simulation_preset_revision_id=a.simulation_preset_revision_id AND j.bc_ids ? a.bc_id::text
    WHERE EXISTS(SELECT FROM progressive_worker_reports stop WHERE stop.sim_job_id=j.id AND stop.stopped_engine_job_id=j.engine_job_id
      AND stop.assignment_signature=origin.assignment_signature AND stop.acknowledged_at IS NOT NULL AND stop.sequence>=h.sequence)
    ORDER BY h.point_content_signature COLLATE "C" ${lock ? sql`FOR SHARE OF h,e,st,origin,a NOWAIT` : sql``}`);
  matchingScience(
    Array.from(anchors, (a) => ({
      signature: a.signature,
      aoa: a.aoa,
      caseSlug: a.caseSlug,
    })),
    facts.points,
    "Missing or ambiguous settled native science",
  );
  eligible(
    anchors.every((a) => a.hubAttempt && a.hubResult),
    "Incomplete hub receipt",
  );
  const measured = {
    owner,
    facts,
    anchors: [...anchors],
    resultMeta,
    stage,
    stored: Number(row.stored),
    fk: row.fk,
    archivedBundle: row.archive_bundle_id,
    text,
  };
  authenticatedSources.add(measured);
  return measured;
}

async function hubScience(db, key, source) {
  const o = source.owner,
    id = key.executionId,
    seq = key.sequence;
  assert.equal(configuredDeploymentRole(), "hub");
  const [r] =
    await db.execute(sql`SELECT cfg.instance_id::text AS instance, d.envelope
    FROM progressive_remote_dispatches d JOIN sim_jobs j ON j.id=d.sim_job_id
    JOIN registered_remote_solvers reg ON reg.id=d.solver_id AND reg.revoked_at IS NULL AND reg.instance_id=${o.workerInstance}
    JOIN sync_sweep_promises p ON p.id=d.promise_id AND p.registered_solver_id=d.solver_id CROSS JOIN sync_api_settings cfg
    WHERE cfg.id=1 AND cfg.instance_id::text<>reg.instance_id AND d.sim_job_id=${id}::uuid AND d.solver_id=${o.solverId}::uuid
      AND d.promise_id=${o.promiseId}::uuid AND d.content_signature=${o.assignmentSignature}
      AND j.engine_job_id=j.id::text AND j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
      AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp()) AND p.status IN('expired','fulfilled','cancelled')
      AND EXISTS(SELECT FROM progressive_cfd_execution_stops s WHERE s.sim_job_id=j.id AND s.engine_job_id=j.engine_job_id)
      AND NOT EXISTS(SELECT FROM progressive_remote_reports t WHERE t.sim_job_id=j.id AND t.sequence=${seq})
      AND NOT EXISTS(SELECT FROM progressive_report_archive_members m WHERE m.sim_job_id=j.id AND m.sequence=${seq} AND m.member_kind='report')
      AND NOT EXISTS(SELECT FROM progressive_remote_report_inventories i WHERE i.sim_job_id=j.id AND i.sequence=${seq})`);
  eligible(
    r,
    "Hub already owns this sequence, or its dispatch is open or mismatched",
  );
  verifyProgressiveRemoteExecution(r.envelope, {
    executionId: id,
    solverId: o.solverId,
    promiseId: o.promiseId,
    contentSignature: o.assignmentSignature,
  });
  const prior =
    await db.execute(sql`SELECT e.point_content_signature AS signature,e.sequence::int AS sequence,
    e.remote_result_attempt_id::text AS "workerAttempt",e.remote_result_id::text AS "workerResult",a.id::text AS "hubAttempt",
    a.result_id::text AS "hubResult",a.status AS "hubStatus",a.valid_for_polar AS "hubValidForPolar",a.cl::text AS "hubCl",a.cd::text AS "hubCd",a.cm::text AS "hubCm",
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM result_classifications c WHERE c.result_attempt_id=a.id) AS "hubClassification"
    FROM jsonb_to_recordset(${JSON.stringify(source.anchors)}::jsonb) pt(signature text,sequence int,aoa double precision,"caseSlug" text,
      "workerAttempt" uuid,"workerResult" uuid,"hubAttempt" uuid,"hubResult" uuid)
    JOIN progressive_remote_evidence_receipts e ON e.sim_job_id=${id}::uuid AND e.point_content_signature=pt.signature
      AND e.sequence=pt.sequence AND e.sequence<>${seq} AND e.remote_result_attempt_id=pt."workerAttempt" AND e.remote_result_id=pt."workerResult"
    JOIN progressive_remote_report_sources s ON s.sim_job_id=e.sim_job_id AND s.sequence=e.sequence AND s.point_content_signature=e.point_content_signature
    JOIN progressive_remote_reports origin ON origin.sim_job_id=s.sim_job_id AND origin.sequence=s.sequence
    JOIN progressive_remote_report_inventories i ON i.sim_job_id=s.sim_job_id AND i.sequence=s.sequence AND i.report_content_signature=origin.content_signature
    JOIN progressive_remote_progress_receipts applied ON applied.sim_job_id=s.sim_job_id AND applied.sequence=s.sequence AND applied.content_signature=origin.content_signature
    JOIN result_attempts a ON a.id=e.result_attempt_id AND a.id=pt."hubAttempt" AND a.result_id=pt."hubResult"
      AND a.sim_job_id=s.sim_job_id AND a.engine_job_id=s.sim_job_id::text AND a.aoa_deg=s.aoa_deg AND s.aoa_deg=pt.aoa
      AND a.engine_case_slug IS NOT DISTINCT FROM s.case_slug AND s.case_slug IS NOT DISTINCT FROM pt."caseSlug"
    JOIN sim_jobs j ON j.id=a.sim_job_id AND j.airfoil_id=a.airfoil_id AND j.simulation_preset_revision_id=a.simulation_preset_revision_id AND j.bc_ids ? a.bc_id::text
    ORDER BY e.point_content_signature COLLATE "C"`);
  matchingScience(
    Array.from(prior, (a) => a.signature),
    source.facts.points.map((p) => p.signature),
    "Hub does not retain every settled scientific source",
  );
  return { instance: r.instance, witnesses: [...prior] };
}

function identity(source) {
  return {
    owner: source.owner,
    facts: source.facts,
    anchors: source.anchors,
    stage: source.stage,
  };
}
function validatePin(pin, key, source) {
  const prefix = (
    process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ?? "progressive-reports/v1"
  ).replace(/^\/+|\/+$/g, "");
  assert.ok(pin && /^[a-f0-9]{64}$/.test(pin.storedSha256));
  assert.equal(
    pin.objectKey,
    `${prefix}/worker/${key.executionId}/${pin.storedSha256}.jsonl.gz`,
  );
  assert.equal(pin.sourceKind, "worker");
  assert.equal(pin.memberKind, "report");
  assert.equal(pin.executionId, key.executionId);
  assert.equal(pin.sequence, key.sequence);
  assert.equal(pin.signature, key.signature);
  assert.equal(pin.reportSha256, source.facts.sha256);
  assert.equal(pin.reportByteSize, source.facts.byteSize);
  assert.equal(pin.archiveFormat, "jsonl");
  assert.ok(
    Number.isSafeInteger(pin.memberCount) &&
      pin.memberCount > 0 &&
      pin.memberCount <= 8,
  );
  assert.ok(
    Number.isSafeInteger(pin.firstSequence) &&
      Number.isSafeInteger(pin.lastSequence) &&
      pin.firstSequence > 0 &&
      pin.memberCount <= pin.lastSequence - pin.firstSequence + 1,
  );
  assert.ok(
    pin.firstSequence <= key.sequence && key.sequence <= pin.lastSequence,
  );
  assert.ok(
    pin.storedByteSize > 0 &&
      pin.storedByteSize <= byteLimit &&
      /^[1-9][0-9]{0,19}$/.test(pin.generation),
  );
}
function fresh(proof) {
  const age = Date.now() - Date.parse(proof?.at);
  assert.ok(
    Number.isFinite(age) && age >= -5000 && age <= 120000,
    "Fresh independent read required",
  );
}
async function verifyRegistration(db, key, bundle, p) {
  const rows =
    await db.execute(sql`SELECT FROM progressive_report_archive_members m JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id
    WHERE b.id=${bundle}::uuid AND m.sim_job_id=${key.executionId}::uuid AND m.sequence=${key.sequence}
      AND m.source_kind='worker' AND m.member_kind='report' AND m.content_signature=${key.signature}
      AND m.report_sha256=${p.reportSha256} AND m.report_byte_size=${p.reportByteSize}
      AND b.source_kind=m.source_kind AND b.sim_job_id=m.sim_job_id AND b.bucket=${p.bucket} AND b.object_key=${p.objectKey}
      AND b.generation=${p.generation} AND b.stored_sha256=${p.storedSha256} AND b.stored_byte_size=${p.storedByteSize}
      AND b.crc32c=${p.crc32c} AND b.mime_type='application/gzip' AND b.compression='gzip' AND b.archive_format='jsonl'
      AND b.first_sequence=${p.firstSequence} AND b.last_sequence=${p.lastSequence} AND b.member_count=${p.memberCount} AND b.verified_at IS NOT NULL`);
  assert.equal(
    rows.length,
    1,
    "Native SQL pointer differs from the saved verified generation",
  );
}
async function productRead(db, key, native, pin, reader, committed) {
  assert.ok(
    authenticatedSources.has(native),
    "Independent PostgreSQL source required",
  );
  validatePin(pin, key, native);
  if (reader === "api") {
    const { installApiReportArchiveReader } =
      await import("../../api/src/progressive-report-archive-reader.ts");
    await installApiReportArchiveReader();
  } else {
    assert.equal(reader, "sweeper");
    installProgressiveReportArchiveReader({
      read: (i, conn) => readStoredWorkerArchiveText(conn, i),
    });
  }
  if (!committed) {
    const text = await readStoredWorkerArchiveText(db, {
      ...pin,
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(
      text === native.text,
      "Restored HZ member differs from the authenticated original",
    );
  } else {
    assert.ok(native.archivedBundle, "Native archive pointer missing");
    const full = await readProgressiveReport(
      db,
      {
        sourceKind: "worker",
        executionId: key.executionId,
        sequence: key.sequence,
        contentSignature: key.signature,
      },
      native.owner,
    );
    eq(
      full,
      reportValidationValue(parseReportJson(native.text)),
      "Ordinary report read differs from authenticated PostgreSQL text",
    );
  }
  return { pin, reader, committed, at: new Date().toISOString() };
}
function lineForReport(metadata, text, previous) {
  const inline = () =>
    JSON.stringify(metadata).slice(0, -1) + ',"report":' + text + "}";
  if (previous === undefined) return inline();
  const end = Math.min(previous.length, text.length);
  let prefix = 0,
    suffix = 0;
  while (
    prefix < end &&
    previous.charCodeAt(prefix) === text.charCodeAt(prefix)
  )
    prefix++;
  while (
    suffix < end - prefix &&
    previous.charCodeAt(previous.length - suffix - 1) ===
      text.charCodeAt(text.length - suffix - 1)
  )
    suffix++;
  if (prefix + suffix < 128) return inline();
  const delta = JSON.stringify({
    ...metadata,
    reportDelta: {
      prefix,
      suffix,
      middle: text.slice(prefix, text.length - suffix),
    },
  });
  return Buffer.byteLength(delta) < Buffer.byteLength(text) ? delta : inline();
}
async function uploadPage(db, keys, sources) {
  const dir = await mkdtemp(join(tmpdir(), "closed-worker-report-"));
  try {
    const path = join(dir, "report.jsonl.gz");
    let encodedBytes = 0,
      deltaMembers = 0,
      previous;
    async function* lines() {
      for (const [i, key] of keys.entries()) {
        const s = sources[i],
          meta = {
            kind: "report",
            sourceKind: "worker",
            executionId: key.executionId,
            sequence: key.sequence,
            contentSignature: key.signature,
            reportSha256: s.facts.sha256,
            reportByteSize: s.facts.byteSize,
          };
        const line = lineForReport(meta, s.text, previous);
        if (!line.startsWith(JSON.stringify(meta).slice(0, -1) + ',"report":'))
          deltaMembers++;
        encodedBytes += Buffer.byteLength(line) + 1;
        previous = s.text;
        yield line;
      }
    }
    const local = await writeProgressiveReportBundle(path, lines());
    assert.ok(local.byteSize <= byteLimit);
    const remote = await putWorkerReportBundle(
      db,
      path,
      local,
      keys[0].executionId,
    );
    const { verifiedAt, ...object } = remote;
    const pins = keys.map((key, i) => {
      const p = {
        ...object,
        sourceKind: "worker",
        memberKind: "report",
        executionId: key.executionId,
        sequence: key.sequence,
        signature: key.signature,
        firstSequence: keys[0].sequence,
        lastSequence: keys.at(-1).sequence,
        memberCount: keys.length,
        reportSha256: sources[i].facts.sha256,
        reportByteSize: sources[i].facts.byteSize,
      };
      validatePin(p, key, sources[i]);
      return p;
    });
    await retainWorkerReportVolume(path, pins[0]);
    const distinct = new Map(
      sources.map((s) => [s.resultMeta.sha256, s.resultMeta.byteSize]),
    );
    const resultBytes = sources.reduce(
      (sum, s) => sum + s.resultMeta.byteSize,
      0,
    );
    const distinctResultBytes = [...distinct.values()].reduce(
      (sum, n) => sum + n,
      0,
    );
    return {
      pins,
      encodedBytes,
      deltaMembers,
      resultBytes,
      distinctResultBytes,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function uploadOriginal(db, key, source) {
  return (await uploadPage(db, [key], [source])).pins[0];
}
const completePage = Symbol("verified complete page");
async function settle(db, m, admitted) {
  assert.ok(
    m.pin.memberCount === 1 || admitted === completePage,
    "Complete signed page required",
  );
  const { key, scope, source, pin } = m;
  validatePin(pin, key, source);
  for (const [role, proof] of Object.entries({
    cloud: m.cloud,
    api: m.api,
    sweeper: m.sweeper,
  })) {
    fresh(proof);
    assert.equal(proof.reader, role);
    eq(proof.pin, pin, "Readback belongs to a different member or generation");
  }
  eq(
    m.cloud.science,
    m.hub.science,
    "Hub science changed during archive preparation",
  );
  const expected = {
    instance: source.owner.workerInstance,
    solver: source.owner.solverId,
  };
  return withActiveHzTransfer(db, expected, async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='700ms'`);
    const before = await workerSource(tx, key, scope, true, pin);
    eq(
      identity(before),
      source,
      "Worker evidence or scheduling eligibility changed",
    );
    if (before.archivedBundle) {
      await productRead(tx, key, before, pin, "sweeper", true);
      return {
        outcome: "already_retired",
        bundle: before.archivedBundle,
        stored: before.stored,
      };
    }
    // Timestamp checks run again after the locked source and every point have been read.
    for (const proof of [m.cloud, m.api, m.sweeper]) fresh(proof);
    let [bundle] =
      await tx.execute(sql`INSERT INTO progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,
      archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
      VALUES('worker',${key.executionId}::uuid,${pin.bucket},${pin.objectKey},${pin.generation},'application/gzip','gzip','jsonl',
        ${pin.storedSha256},${pin.storedByteSize},${pin.crc32c},${pin.memberCount},${pin.firstSequence},${pin.lastSequence},${m.cloud.at}::timestamptz)
       ON CONFLICT(bucket,object_key,generation,sim_job_id) DO NOTHING RETURNING id`);
    if (!bundle) {
      [bundle] =
        await tx.execute(sql`SELECT id FROM progressive_report_archive_bundles WHERE bucket=${pin.bucket} AND object_key=${pin.objectKey}
        AND generation=${pin.generation} AND sim_job_id=${key.executionId}::uuid AND source_kind='worker' AND stored_sha256=${pin.storedSha256}
        AND stored_byte_size=${pin.storedByteSize} AND crc32c=${pin.crc32c} AND archive_format='jsonl' AND mime_type='application/gzip'
        AND compression='gzip' AND member_count=${pin.memberCount} AND first_sequence=${pin.firstSequence} AND last_sequence=${pin.lastSequence}`);
      assert.ok(bundle, "Page registration differs");
    }
    await tx.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
      VALUES(${bundle.id}::uuid,'worker',${key.executionId}::uuid,${key.sequence},'report',${key.signature},${pin.reportSha256},${pin.reportByteSize})`);
    // The 0202 trigger authenticates OLD resolved ::text, SHA-256, byte size and compact header in this transaction.
    const [changed] =
      await tx.execute(sql`UPDATE progressive_worker_reports SET report=progressive_report_compact_header(report),result_payload_hash=NULL,
      archived_at=clock_timestamp(),archive_bundle_id=${bundle.id}::uuid WHERE sim_job_id=${key.executionId}::uuid AND sequence=${key.sequence}
      AND content_signature=${key.signature} AND archived_at IS NULL AND archive_bundle_id IS NULL RETURNING sequence`);
    assert.ok(changed, "Native report changed before retirement");
    const after = await workerSource(tx, key, scope, false, pin, before);
    eq(
      identity(after),
      source,
      "Retirement changed native scientific eligibility",
    );
    await productRead(tx, key, after, pin, "sweeper", true);
    let dictionaryBytes = 0;
    if (before.fk) {
      const retired =
        await tx.execute(sql`DELETE FROM progressive_report_result_payloads p WHERE p.content_hash=${before.fk}
        AND NOT EXISTS(SELECT FROM progressive_worker_reports r WHERE r.result_payload_hash=p.content_hash)
        AND NOT EXISTS(SELECT FROM progressive_remote_reports r WHERE r.result_payload_hash=p.content_hash)
        RETURNING pg_column_size(p.result) AS stored`);
      dictionaryBytes = Number(retired[0]?.stored ?? 0);
    }
    return {
      outcome: "retired",
      bundle: bundle.id,
      originalStored: before.stored,
      stored: after.stored,
      dictionaryBytes,
    };
  });
}
async function runClosedReportPeer(db, m, readBasis) {
  if (m.op === "discover-worker" || m.op === "discover-hub")
    return discoverOriginals(db, m);
  if (m.items) return runClosedPage(db, m, readBasis);
  const { op, key, scope } = m;
  assertSourceKey(key);
  assert.ok(
    scope.sourceInstance &&
      scope.solverId &&
      scope.sha256 &&
      /^[a-f0-9]{64}$/.test(scope.sha256),
  );
  assert.ok(
    !scope.range ||
      (scope.range.executionId === key.executionId &&
        (key.sequence <= (scope.range.reportAfter ?? 0) ||
          key.sequence > scope.range.reportHighWater)),
    "Frozen sequence belongs to its original operator",
  );
  if (op === "hub" || op === "cloud") {
    assert.equal(scope.sourceInstance, m.source.owner.workerInstance);
    assert.equal(scope.solverId, m.source.owner.solverId);
    const science = await hubScience(db, key, m.source);
    if (op === "hub") return { key, science, at: new Date().toISOString() };
    validatePin(m.pin, key, m.source);
    assert.equal(m.pin.bucket, process.env.AIRFOILFOAM_EVIDENCE_BUCKET);
    const text = await new ProgressiveReportArchiveStore(m.pin.bucket).read(
      m.pin,
    );
    eq(
      signedFacts(text, key, m.source.owner),
      m.source.facts,
      "Full GCS generation differs from signed native source",
    );
    return {
      reader: "cloud",
      pin: m.pin,
      science,
      at: new Date().toISOString(),
    };
  }
  assert.equal(configuredDeploymentRole(), "remote-solver");
  if (op === "settle") return settle(db, m);
  if (op === "read") {
    validatePin(m.pin, key, m.source);
    const saved = m.committed ? readBasis?.get(key.sequence) : undefined;
    const prior =
      saved && isDeepStrictEqual(saved.pin, m.pin) ? saved.original : null;
    const actual = await workerSource(db, key, scope, false, m.pin, prior);
    eq(identity(actual), m.source, "Native scientific evidence changed");
    if (m.committed) assert.ok(actual.archivedBundle);
    const proof = await productRead(
      db,
      key,
      actual,
      m.pin,
      m.reader,
      !!m.committed,
    );
    if (!m.committed && readBasis)
      readBasis.set(key.sequence, { pin: m.pin, original: actual });
    return { ...proof, storedFieldBytes: actual.stored };
  }
  const native = await workerSource(db, key, scope, false, m.pin);
  if (op === "source")
    return {
      source: identity(native),
      resultMeta: native.resultMeta,
      stored: native.stored,
      fk: native.fk,
      archivedBundle: native.archivedBundle,
    };
  assert.equal(op, "publish");
  fresh(m.hub);
  eq(m.hub.key, key, "Hub proof belongs to a different source");
  eq(
    identity(native),
    m.source,
    "Native signed original changed before upload",
  );
  assert.ok(!native.archivedBundle, "Existing archive must be resumed");
  return uploadOriginal(db, key, native);
}
async function verifyInstalledReportFiles(m) {
  // The controller pins the installed product dependencies on each role, including the actual API reader.
  for (const [filename, sha] of Object.entries(m.runtime)) {
    assert.ok(
      /^(?:apps|packages|pnpm-lock\.yaml$)/.test(filename) &&
        !filename.includes(".."),
    );
    assert.equal(
      hash(await readFile(join("/app", filename))),
      sha,
      `Installed report dependency differs: ${filename}`,
    );
  }
}

function closedReportClient(writer) {
  return createClient({
    max: 1,
    connection: {
      application_name: "closed_worker_report_custody",
      statement_timeout: "25s",
      lock_timeout: "700ms",
      ...(writer ? {} : { default_transaction_read_only: "on" }),
    },
  });
}

async function invokeClosedReport(m) {
  await verifyInstalledReportFiles(m);
  const client = closedReportClient(m.op === "settle");
  try {
    return await runClosedReportPeer(client.db, m);
  } finally {
    await client.sql.end({ timeout: 2 });
  }
}

export { runClosedReportPeer, invokeClosedReport };
class ClosedWorkerCloud extends HubWorkloadGcs {
  async verify(items) {
    const { pin: p, source } = items[0];
    assert.equal(p.bucket, process.env.AIRFOILFOAM_EVIDENCE_BUCKET);
    const url = this.url(p.objectKey, p.generation);
    const meta = JSON.parse(
      (await boundedHubBody(await this.call(url.toString()), 65536)).toString(
        "utf8",
      ),
    );
    assert.ok(
      meta.bucket === p.bucket &&
        meta.name === p.objectKey &&
        meta.generation === p.generation &&
        meta.size === String(p.storedByteSize) &&
        meta.crc32c === p.crc32c &&
        meta.contentType === "application/gzip" &&
        !meta.contentEncoding,
      "Pinned native cloud metadata differs",
    );
    const stored = meta.metadata;
    assert.ok(
      stored?.sha256 === p.storedSha256 &&
        stored.byteSize === String(p.storedByteSize) &&
        stored.sourceKind === "worker" &&
        stored.executionId === p.executionId &&
        stored.solverId === source.owner.solverId &&
        stored.sourceInstanceId === source.owner.workerInstance &&
        stored.archiveFormat === "jsonl",
      "Cloud registered worker owner differs",
    );
    url.searchParams.set("alt", "media");
    const bytes = await boundedHubBody(
      await this.call(url.toString()),
      p.storedByteSize,
    );
    let seen = 0;
    await visitVerifiedWorkerReportArchive(
      Readable.from([bytes]),
      p,
      source.owner,
      (entry) => {
        const expected = items[seen++];
        assert.ok(
          expected &&
            entry.kind === "report" &&
            entry.sequence === expected.key.sequence &&
            entry.contentSignature === expected.key.signature,
          "Unexpected signed worker member",
        );
        eq(
          reportTextIdentity(entry.reportText),
          {
            sha256: expected.source.facts.sha256,
            byteSize: expected.source.facts.byteSize,
          },
          "Cloud member differs from native source",
        );
      },
      {
        maxMembers: 8,
        maxDecodedBytes: byteLimit * 2,
        maxReportBytes: byteLimit,
      },
      AbortSignal.timeout(30000),
    );
    assert.equal(seen, items.length, "Incomplete pinned worker page");
  }
}
async function runClosedPage(db, m, readBasis) {
  const { op, items, scope } = m,
    keys = items.map((i) => i.key);
  assert.ok(keys.length >= 2 && keys.length <= 8);
  for (const [i, k] of keys.entries()) {
    assertSourceKey(k);
    assert.ok(
      k.executionId === m.key.executionId &&
        (i === 0
          ? k.sequence === m.key.sequence
          : k.sequence > keys[i - 1].sequence),
      "Expected strictly ordered signed keys from one execution",
    );
    assert.ok(
      !scope.range ||
        (scope.range.executionId === k.executionId &&
          (k.sequence <= (scope.range.reportAfter ?? 0) ||
            k.sequence > scope.range.reportHighWater)),
      "Frozen sequence belongs to its original operator",
    );
  }
  if (op === "source" || op === "hub") {
    const rows = [];
    let bytes = 0;
    for (const item of items) {
      try {
        const next = await runClosedReportPeer(db, { op, scope, ...item });
        if (
          op === "source" &&
          (bytes += next.source.facts.byteSize) > byteLimit
        )
          break;
        rows.push(next);
      } catch (e) {
        if (e.name !== "ClosedReportHeld") throw e;
        return { rows, held: e.message };
      }
    }
    return { rows };
  }
  assert.ok(
    items.reduce((sum, i) => sum + i.source.facts.byteSize, 0) <= byteLimit,
  );
  for (const item of items)
    eq(item.source.owner, items[0].source.owner, "Mixed worker ownership");
  if (op === "publish") {
    assert.equal(configuredDeploymentRole(), "remote-solver");
    const sources = [];
    for (const item of items) {
      fresh(item.hub);
      eq(item.key, item.hub.key, "Mismatched hub sequence");
      const original = await workerSource(db, item.key, scope);
      assert.ok(!original.archivedBundle);
      eq(
        identity(original),
        item.source,
        "Worker source changed before grouped upload",
      );
      sources.push(original);
    }
    return uploadPage(db, keys, sources);
  }
  // All independent proof requests must cover this exact object and every member, including the last sibling.
  const head = items[0].pin;
  for (const { key, pin, source } of items) {
    validatePin(pin, key, source);
    for (const field of [
      "bucket",
      "objectKey",
      "generation",
      "crc32c",
      "storedSha256",
      "storedByteSize",
      "firstSequence",
      "lastSequence",
      "memberCount",
    ]) {
      assert.equal(pin[field], head[field], "Mixed cloud generations");
    }
  }
  assert.equal(head.firstSequence, keys[0].sequence);
  assert.equal(head.lastSequence, keys.at(-1).sequence);
  assert.equal(head.memberCount, keys.length);
  if (op === "cloud") {
    assert.equal(configuredDeploymentRole(), "hub");
    const science = [];
    for (const item of items) {
      assert.equal(item.source.owner.solverId, scope.solverId);
      assert.equal(item.source.owner.workerInstance, scope.sourceInstance);
      science.push(await hubScience(db, item.key, item.source));
    }
    await new ClosedWorkerCloud(head.bucket, m.hubAccount).verify(items);
    const at = new Date().toISOString();
    return {
      rows: items.map((v, i) => ({
        pin: v.pin,
        science: science[i],
        reader: "cloud",
        at,
      })),
      generationDownloads: 1,
    };
  }
  assert.equal(configuredDeploymentRole(), "remote-solver");
  if (op === "read") {
    const rows = [];
    for (const item of items)
      rows.push(
        await runClosedReportPeer(
          db,
          {
            op,
            scope,
            ...item,
            reader: m.reader,
            committed: m.committed,
          },
          readBasis,
        ),
      );
    return { rows };
  }
  assert.equal(op, "settle");
  return db.transaction(async (tx) => {
    const rows = [];
    for (const item of items)
      rows.push(await settle(tx, { ...item, scope }, completePage));
    return { rows };
  });
}

const zeroCursor = {
  executionId: "00000000-0000-0000-0000-000000000000",
  sequence: 0,
};
async function discoverOriginals(db, m) {
  const { scope } = m;
  if (m.op === "discover-worker") {
    assert.equal(configuredDeploymentRole(), "remote-solver");
    await checkHzTransferFence(db, {
      instance: scope.sourceInstance,
      solver: scope.solverId,
    });
    const after = m.after ?? zeroCursor,
      limit = m.limit;
    assert.ok(
      Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 1024 &&
        Number.isSafeInteger(after.sequence) &&
        after.sequence >= 0,
    );
    // Cursor advances across all scanned warm PKs even when none qualifies. Only narrow identifiers leave this role.
    const [row] = await db.execute(sql`WITH k AS MATERIALIZED (
      SELECT r.sim_job_id AS j,r.sequence AS s,r.content_signature AS sig,r.assignment_signature AS assignment,
        r.acknowledged_at,r.stopped_engine_job_id FROM progressive_worker_reports r WHERE r.archived_at IS NULL AND r.archive_bundle_id IS NULL
        AND (r.sim_job_id,r.sequence)>(${after.executionId}::uuid,${after.sequence}::bigint)
        ORDER BY r.sim_job_id,r.sequence LIMIT ${limit}
    ), matched AS (SELECT k.j,k.s,k.sig FROM k JOIN sim_jobs j ON j.id=k.j
      JOIN sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
      WHERE k.acknowledged_at IS NOT NULL AND k.stopped_engine_job_id IS NULL AND j.engine_job_id=j.id::text
        AND j.status IN('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
        AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
        AND p.status IN('expired','fulfilled','cancelled') AND p.registered_solver_id=${scope.solverId}::uuid
        AND j.request_payload->>'remoteSolver'='true' AND j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'=k.assignment
        AND EXISTS(SELECT FROM progressive_worker_staging_candidates s WHERE s.sim_job_id=k.j AND s.sequence=k.s)
        AND EXISTS(SELECT FROM progressive_worker_reports s WHERE s.sim_job_id=k.j AND s.sequence>k.s AND s.assignment_signature=k.assignment
          AND s.stopped_engine_job_id=j.engine_job_id AND s.acknowledged_at IS NOT NULL)
        AND NOT EXISTS(SELECT FROM progressive_worker_reports w WHERE w.sim_job_id=k.j AND w.acknowledged_at IS NULL)
        AND NOT EXISTS(SELECT FROM progressive_worker_evidence_receipts e WHERE e.sim_job_id=k.j AND e.sequence=k.s)
        AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=k.j AND c.sequence=k.s)
        AND NOT EXISTS(SELECT FROM progressive_report_archive_members m WHERE m.sim_job_id=k.j AND m.sequence=k.s AND m.member_kind='report')
        AND NOT EXISTS(SELECT FROM progressive_worker_hub_report_links l WHERE l.sim_job_id=k.j AND l.sequence=k.s)
        AND NOT EXISTS(SELECT FROM result_attempts a WHERE a.sim_job_id=k.j AND a.status='running')
        AND NOT EXISTS(SELECT FROM progressive_worker_delivery_failures f WHERE f.sim_job_id=k.j AND f.state<>'conflict'))
    SELECT (SELECT count(*)::int FROM k) AS scanned,(SELECT jsonb_build_object('executionId',j,'sequence',s) FROM k ORDER BY j DESC,s DESC LIMIT 1) AS last,
      coalesce((SELECT jsonb_agg(jsonb_build_object('executionId',j,'sequence',s,'signature',sig) ORDER BY j,s) FROM matched),'[]') AS keys`);
    return row;
  }
  assert.equal(m.op, "discover-hub");
  assert.equal(configuredDeploymentRole(), "hub");
  assert.ok(Array.isArray(m.keys) && m.keys.length <= 1024);
  m.keys.forEach(assertSourceKey);
  const matches =
    await db.execute(sql`SELECT k."executionId",k.sequence::int,k.signature FROM
    jsonb_to_recordset(${JSON.stringify(m.keys)}::jsonb) k("executionId" uuid,sequence bigint,signature text)
    JOIN progressive_remote_dispatches d ON d.sim_job_id=k."executionId" AND d.solver_id=${scope.solverId}::uuid
    JOIN registered_remote_solvers reg ON reg.id=d.solver_id AND reg.instance_id=${scope.sourceInstance} AND reg.revoked_at IS NULL
    JOIN sync_sweep_promises p ON p.id=d.promise_id AND p.registered_solver_id=d.solver_id
    JOIN sim_jobs j ON j.id=d.sim_job_id CROSS JOIN sync_api_settings cfg
    WHERE cfg.id=1 AND cfg.instance_id::text<>reg.instance_id AND j.engine_job_id=j.id::text AND j.status IN('done','failed','cancelled')
      AND j."ingestedAt" IS NOT NULL AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
      AND p.status IN('expired','fulfilled','cancelled') AND EXISTS(SELECT FROM progressive_cfd_execution_stops s WHERE s.sim_job_id=j.id AND s.engine_job_id=j.engine_job_id)
      AND NOT EXISTS(SELECT FROM progressive_remote_reports r WHERE r.sim_job_id=j.id AND r.sequence=k.sequence)
      AND NOT EXISTS(SELECT FROM progressive_report_archive_members m WHERE m.sim_job_id=j.id AND m.sequence=k.sequence AND m.member_kind='report')
      AND NOT EXISTS(SELECT FROM progressive_remote_report_inventories i WHERE i.sim_job_id=j.id AND i.sequence=k.sequence)
    ORDER BY k."executionId",k.sequence`);
  return { keys: [...matches] };
}
async function serveClosedReportReads(role) {
  // A read peer cannot publish or settle. The native writer retains a separate short-lived
  // process and takes the existing deployment lock for every transaction and upload.
  const operations = {
    hub: ["hub", "cloud", "discover-hub"],
    api: ["read"],
    worker: ["source", "read", "discover-worker"],
  };
  assert.ok(Object.hasOwn(operations, role));
  const client = closedReportClient(false);
  const basis = new Map();
  const { createInterface } = await import("node:readline");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const emit = (value) =>
    new Promise((resolve, reject) => {
      const line = JSON.stringify(value);
      if (Buffer.byteLength(line) > 2 * 1024 ** 2 - 1) {
        reject(new Error("Oversized native read response"));
        return;
      }
      process.stdout.write(line + "\n", (e) => (e ? reject(e) : resolve()));
    });
  let n = 0;
  try {
    await emit({ ready: role, bootMs: performance.now() });
    for await (const line of input) {
      assert.ok(Buffer.byteLength(line) <= 1024 ** 2);
      const message = JSON.parse(line),
        m = message.request;
      assert.ok(
        ++n <= 128 && message.n === n && operations[role].includes(m.op),
        "Invalid read session request",
      );
      if (m.op === "read")
        assert.equal(m.reader, role === "api" ? "api" : "sweeper");
      const start = performance.now(),
        cpu = process.cpuUsage();
      try {
        // Keep at most one pre-commit snapshot page per native role. Neither a
        // generation proof nor a parsed ordinary read result survives in this map.
        if (m.op !== "read" || !m.committed) basis.clear();
        await verifyInstalledReportFiles(m);
        let value;
        try {
          value = await runClosedReportPeer(client.db, m, basis);
        } catch (e) {
          if (
            !["source", "hub"].includes(m.op) ||
            e.name !== "ClosedReportHeld"
          )
            throw e;
          value = { held: e.message };
        } finally {
          if (m.committed) basis.clear();
        }
        const used = process.cpuUsage(cpu);
        await emit({
          n,
          value,
          workMs: performance.now() - start,
          cpuMs: (used.user + used.system) / 1000,
          peakRssKiB: process.resourceUsage().maxRSS,
        });
      } catch (e) {
        // Driver errors can carry statements or credentials. Preserve only an established failure class.
        const state = e.cause?.code ?? e.code;
        await emit({
          n,
          error: /^[A-Z0-9_]{1,32}$/.test(String(state))
            ? String(state)
            : "read_verification_failed",
        });
        break;
      }
    }
  } finally {
    basis.clear();
    input.close();
    await client.sql.end({ timeout: 2 });
  }
}
