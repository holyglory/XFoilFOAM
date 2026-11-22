import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { crc32c } from "/app/packages/core/src/result-history-storage.ts";
import { getAttemptEvidenceArchive } from "/app/packages/db/src/attempt-evidence-catalog.ts";
import { readAttemptEvidenceCopy } from "/app/apps/sweeper/src/attempt-evidence-archive.ts";

async function readBounded(response, limit) {
  requireProof(response.ok && response.body, "generation");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireProof(bytes <= limit, "generation");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function metadataToken(pin) {
  async function metadata(field) {
    const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/" +
        field,
      {
        headers: { "Metadata-Flavor": "Google" },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    return (await readBounded(response, 16384)).toString("utf8");
  }
  const email = (await metadata("email")).trim();
  requireProof(
    createHash("sha256").update(email).digest("hex") === pin,
    "identity",
  );
  const token = JSON.parse(await metadata("token")).access_token;
  requireProof(typeof token === "string" && token.length > 20, "identity");
  return token;
}

async function pinnedObject(identity, key, token) {
  requireProof(
    identity.bucket &&
      identity.bucket === process.env.AIRFOILFOAM_EVIDENCE_BUCKET &&
      identity.objectKey === key &&
      /^[1-9][0-9]{0,19}$/.test(identity.generation) &&
      /^[a-f0-9]{64}$/.test(identity.storedSha256) &&
      Number.isSafeInteger(identity.storedByteSize) &&
      identity.storedByteSize > 0 &&
      identity.storedByteSize <= 16 * 1024 * 1024,
    "archive",
  );
  const url = new URL(
    "https://storage.googleapis.com/storage/v1/b/" +
      encodeURIComponent(identity.bucket) +
      "/o/" +
      encodeURIComponent(key),
  );
  url.searchParams.set("generation", identity.generation);
  const get = () =>
    fetch(url, {
      headers: {
        Authorization: "Bearer " + token,
        "Accept-Encoding": "identity",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  const metadata = JSON.parse(
    (await readBounded(await get(), 65536)).toString("utf8"),
  );
  requireProof(
    metadata.bucket === identity.bucket &&
      metadata.name === key &&
      metadata.generation === identity.generation &&
      metadata.size === String(identity.storedByteSize) &&
      metadata.crc32c === identity.crc32c &&
      metadata.contentType === "application/gzip" &&
      !metadata.contentEncoding,
    "generation",
  );
  url.searchParams.set("alt", "media");
  const packed = await readBounded(await get(), identity.storedByteSize);
  requireProof(
    packed.length === identity.storedByteSize &&
      crc32c(packed) === identity.crc32c &&
      createHash("sha256").update(packed).digest("hex") ===
        identity.storedSha256,
    "generation",
  );
  return packed;
}

async function hubSource() {
  requireProof(
    (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE || "hub") === "hub",
    "scope",
  );
  const w = request.witness;
  requireProof(typeof w.storageOnly === "boolean", "scope");
  const { sql: pg, db } = client();
  try {
    const rows = await pg.unsafe(
      `
      SELECT ar.id::text AS archive,d.envelope FROM progressive_remote_evidence_receipts e
      JOIN progressive_remote_dispatches d ON d.sim_job_id=e.sim_job_id AND d.promise_id=$7::uuid AND d.content_signature=$10::text
      JOIN registered_remote_solvers solver ON solver.id=d.solver_id AND solver.id=$4::uuid AND solver.instance_id::text=$5::text AND solver.revoked_at IS NULL
      JOIN result_attempts a ON a.id=e.result_attempt_id AND a.result_id=$8::uuid AND a.sim_job_id=e.sim_job_id
      JOIN attempt_evidence_archives ar ON ar.result_attempt_id=a.id AND ar.result_id=a.result_id AND ar.sim_job_id=a.sim_job_id
      JOIN sync_api_settings settings ON settings.id=1 AND settings.instance_id::text=ar.source_instance
      JOIN progressive_remote_reports report ON report.sim_job_id=e.sim_job_id AND report.sequence=e.sequence AND report.content_signature=$11::text
      WHERE e.sim_job_id=$1::uuid AND e.result_attempt_id=$2::uuid AND e.remote_result_attempt_id=$3::uuid AND e.remote_result_id=$6::uuid
        AND e.point_content_signature=$9::text AND e.sequence=$12::bigint AND e.storage_only=$15::boolean
        AND ar.source_sha256=$13::text AND ar.source_byte_size=$14::bigint
      ORDER BY ar.verified_at DESC,ar.id LIMIT 1`,
      [
        w.job,
        w.hubAttempt,
        w.attempt,
        w.solver,
        w.instance,
        w.result,
        w.promise,
        w.hubResult,
        w.point,
        w.assignment,
        w.report.signature,
        w.report.sequence,
        w.sha256,
        w.byteSize,
        w.storageOnly,
      ],
    );
    requireProof(rows.length === 1, "scope");
    const archive = await getAttemptEvidenceArchive(db, rows[0].archive);
    const token = await metadataToken(request.pin);
    const packed = await pinnedObject(
      archive,
      `attempt-evidence/v1/${archive.sourceInstance}/${w.hubAttempt}/${w.sha256}/${archive.storedSha256}.json.gz`,
      token,
    );
    const source = await readAttemptEvidenceCopy(
      Readable.from([packed]),
      archive,
    );
    const full = reportTextIdentity(source.payloadText);
    requireProof(
      source.attemptId === w.hubAttempt &&
        source.resultId === w.hubResult &&
        source.simJobId === w.job &&
        full.sha256 === w.sha256 &&
        full.byteSize === w.byteSize,
      "source",
    );
    const bytes = await pinnedObject(
      w.report,
      `progressive-reports/v1/worker/${w.job}/${w.report.storedSha256}.jsonl.gz`,
      token,
    );
    const reportText = await readHzAttemptReportMember(
      Readable.from([bytes]),
      w.report,
    );
    const replay = await projectHzReportAttempt(
      db,
      JSON.parse(reportText),
      rows[0].envelope,
      w,
    );
    requireProof(replay === source.payloadText, "replay");
    return {
      attempt: w.attempt,
      hubAttempt: w.hubAttempt,
      execution: w.job,
      hubAttemptGeneration: archive.generation,
      hubArchive: archive.id,
      reportGeneration: w.report.generation,
      reportSequence: w.report.sequence,
      sourceTextBytes: full.byteSize,
      historyBytes: w.historyBytes,
      pgDatumBytes: w.pgBytes,
      exactHzInlineApiRead: true,
      exactHzVolumeRead: true,
      exactHubPayload: true,
      exactReportPayload: true,
    };
  } finally {
    await pg.end({ timeout: 1 });
  }
}

try {
  console.log(JSON.stringify(await hubSource()));
} catch (error) {
  fail(error);
}
