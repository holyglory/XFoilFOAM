import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function signedFacts(text, key, owner) {
  assert.ok(
    Buffer.byteLength(text) <= byteLimit,
    "Report exceeds the bounded reader",
  );
  const value = reportJsonObject(parseReportJson(text));
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

async function workerSource(db, key, scope, lock = false, coldPin = null) {
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
  if (row.archived_at) {
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
  const facts = signedFacts(text, key, owner);
  const anchors =
    await db.execute(sql`SELECT h.point_content_signature AS signature,h.sequence::int AS sequence,
    a.id::text AS "workerAttempt",a.result_id::text AS "workerResult",h.receipt->>'resultAttemptId' AS "hubAttempt",h.receipt->>'resultId' AS "hubResult",
    a.aoa_deg AS aoa,a.engine_case_slug AS "caseSlug",a.status AS "workerStatus",a.valid_for_polar AS "workerValidForPolar",a.cl::text AS "workerCl",a.cd::text AS "workerCd",a.cm::text AS "workerCm",
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM result_classifications c WHERE c.result_attempt_id=a.id) AS "workerClassification"
    FROM jsonb_to_recordset(${JSON.stringify(facts.points)}::jsonb) pt(signature text,aoa double precision,"caseSlug" text)
    JOIN progressive_worker_hub_receipts h ON h.sim_job_id=${id}::uuid AND h.point_content_signature=pt.signature AND h.sequence<${seq}
    JOIN progressive_worker_evidence_attempts e USING(sim_job_id,sequence,point_content_signature,result_attempt_id)
    JOIN progressive_worker_evidence_receipts st ON st.sim_job_id=e.sim_job_id AND st.sequence=e.sequence
    JOIN progressive_worker_reports origin ON origin.sim_job_id=st.sim_job_id AND origin.sequence=st.sequence AND origin.content_signature=st.content_signature
      AND origin.acknowledged_at IS NOT NULL AND origin.assignment_signature=${owner.assignmentSignature}
    JOIN result_attempts a ON a.id=h.result_attempt_id AND a.sim_job_id=h.sim_job_id AND a.engine_job_id=h.sim_job_id::text
      AND a.aoa_deg=pt.aoa AND a.engine_case_slug IS NOT DISTINCT FROM pt."caseSlug" AND a.result_id IS NOT NULL
    JOIN sim_jobs j ON j.id=a.sim_job_id AND j.airfoil_id=a.airfoil_id AND j.simulation_preset_revision_id=a.simulation_preset_revision_id AND j.bc_ids ? a.bc_id::text
    ORDER BY h.point_content_signature COLLATE "C" ${lock ? sql`FOR SHARE OF h,e,st,origin,a NOWAIT` : sql``}`);
  matchingScience(
    Array.from(anchors, (a) => ({
      signature: a.signature,
      aoa: a.aoa,
      caseSlug: a.caseSlug,
    })),
    facts.points,
    "Missing or ambiguous earlier native science",
  );
  eligible(
    anchors.every((a) => a.hubAttempt && a.hubResult),
    "Incomplete hub receipt",
  );
  return {
    owner,
    facts,
    anchors: [...anchors],
    stage,
    stored: Number(row.stored),
    fk: row.fk,
    archivedBundle: row.archive_bundle_id,
    text,
  };
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
      AND e.sequence=pt.sequence AND e.sequence<${seq} AND e.remote_result_attempt_id=pt."workerAttempt" AND e.remote_result_id=pt."workerResult"
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
    "Hub does not retain every earlier scientific source",
  );
  return { instance: r.instance, earlier: [...prior] };
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
  assert.equal(pin.memberCount, 1);
  assert.equal(pin.firstSequence, key.sequence);
  assert.equal(pin.lastSequence, key.sequence);
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
      AND b.first_sequence=m.sequence AND b.last_sequence=m.sequence AND b.member_count=1 AND b.verified_at IS NOT NULL`);
  assert.equal(
    rows.length,
    1,
    "Native SQL pointer differs from the saved verified generation",
  );
}
async function productRead(db, key, source, pin, reader, committed) {
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
  const text = await readStoredWorkerArchiveText(db, {
    ...pin,
    signal: AbortSignal.timeout(30000),
  });
  eq(
    signedFacts(text, key, source.owner),
    source.facts,
    "Restored HZ member differs from the native original",
  );
  if (committed) {
    const full = await readProgressiveReport(db, {
      sourceKind: "worker",
      executionId: key.executionId,
      sequence: key.sequence,
      contentSignature: key.signature,
    });
    eq(
      full,
      reportValidationValue(parseReportJson(text)),
      "Ordinary report read differs from authenticated PostgreSQL text",
    );
  }
  return { pin, reader, committed, at: new Date().toISOString() };
}
async function uploadOriginal(db, key, source) {
  const dir = await mkdtemp(join(tmpdir(), "closed-worker-report-"));
  try {
    const path = join(dir, "report.jsonl.gz");
    const metadata = {
      kind: "report",
      sourceKind: "worker",
      executionId: key.executionId,
      sequence: key.sequence,
      contentSignature: key.signature,
      reportSha256: source.facts.sha256,
      reportByteSize: source.facts.byteSize,
    };
    const line =
      JSON.stringify(metadata).slice(0, -1) + ',"report":' + source.text + "}";
    const local = await writeProgressiveReportBundle(
      path,
      (async function* () {
        yield line;
      })(),
    );
    const receipt = await putWorkerReportBundle(
      db,
      path,
      local,
      key.executionId,
    );
    const { verifiedAt, ...remote } = receipt;
    const pin = {
      ...remote,
      sourceKind: "worker",
      memberKind: "report",
      executionId: key.executionId,
      sequence: key.sequence,
      signature: key.signature,
      firstSequence: key.sequence,
      lastSequence: key.sequence,
      memberCount: 1,
      reportSha256: source.facts.sha256,
      reportByteSize: source.facts.byteSize,
    };
    validatePin(pin, key, source);
    // The same volume is mounted by both native product readers under their current permissions.
    await retainWorkerReportVolume(path, pin);
    return pin;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function settle(db, m) {
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
      await productRead(tx, key, source, pin, "sweeper", true);
      return {
        outcome: "already_retired",
        bundle: before.archivedBundle,
        stored: before.stored,
      };
    }
    // Timestamp checks run again after the locked source and every point have been read.
    for (const proof of [m.cloud, m.api, m.sweeper]) fresh(proof);
    const [bundle] =
      await tx.execute(sql`INSERT INTO progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,
      archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
      VALUES('worker',${key.executionId}::uuid,${pin.bucket},${pin.objectKey},${pin.generation},'application/gzip','gzip','jsonl',
        ${pin.storedSha256},${pin.storedByteSize},${pin.crc32c},1,${key.sequence},${key.sequence},${m.cloud.at}::timestamptz) RETURNING id`);
    await tx.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
      VALUES(${bundle.id}::uuid,'worker',${key.executionId}::uuid,${key.sequence},'report',${key.signature},${pin.reportSha256},${pin.reportByteSize})`);
    // The 0202 trigger authenticates OLD resolved ::text, SHA-256, byte size and compact header in this transaction.
    const [changed] =
      await tx.execute(sql`UPDATE progressive_worker_reports SET report=progressive_report_compact_header(report),result_payload_hash=NULL,
      archived_at=clock_timestamp(),archive_bundle_id=${bundle.id}::uuid WHERE sim_job_id=${key.executionId}::uuid AND sequence=${key.sequence}
      AND content_signature=${key.signature} AND archived_at IS NULL AND archive_bundle_id IS NULL RETURNING sequence`);
    assert.ok(changed, "Native report changed before retirement");
    const after = await workerSource(tx, key, scope, false, pin);
    eq(
      identity(after),
      source,
      "Retirement changed native scientific eligibility",
    );
    await productRead(tx, key, source, pin, "sweeper", true);
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
async function runClosedReportPeer(db, m) {
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
    const actual = await workerSource(db, key, scope, false, m.pin);
    eq(identity(actual), m.source, "Native scientific evidence changed");
    if (m.committed) assert.ok(actual.archivedBundle);
    const proof = await productRead(
      db,
      key,
      m.source,
      m.pin,
      m.reader,
      !!m.committed,
    );
    return { ...proof, storedFieldBytes: actual.stored };
  }
  const native = await workerSource(db, key, scope, false, m.pin);
  if (op === "source")
    return {
      source: identity(native),
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
async function invokeClosedReport(m) {
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
  const writer = m.op === "settle";
  const client = createClient({
    max: 1,
    connection: {
      application_name: "closed_worker_report_custody",
      statement_timeout: "25s",
      lock_timeout: "700ms",
      ...(writer ? {} : { default_transaction_read_only: "on" }),
    },
  });
  try {
    return await runClosedReportPeer(client.db, m);
  } finally {
    await client.sql.end({ timeout: 2 });
  }
}

export { runClosedReportPeer, invokeClosedReport };
