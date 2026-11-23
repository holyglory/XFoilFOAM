import {
  manifestMemberSetSha256,
  parseEvidenceManifest,
  type DB,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  registeredWorkerArchiveOwner,
  readArchiveBrokerResponse,
} from "./report-archive-broker-client";

export interface HistoricalRawPick {
  executionId: string;
  sequence: number;
  pointSignature: string;
  reportSignature: string;
  storedSha256: string;
  manifestSha256: string;
}
const sha = /^[a-f0-9]{64}$/,
  uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const deadline = 30 * 60_000;
const positive = (v: unknown, limit: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= limit;
const generation = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[1-9][0-9]{0,19}$/.test(v) &&
  BigInt(v) <= 18_446_744_073_709_551_615n;

export async function transferHistoricalRawArchive(
  db: DB,
  ref: HistoricalRawPick,
  execute: boolean,
  fetcher = fetch,
) {
  if (
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" ||
    !uuid.test(ref.executionId) ||
    !positive(ref.sequence, Number.MAX_SAFE_INTEGER) ||
    ![
      ref.pointSignature,
      ref.reportSignature,
      ref.storedSha256,
      ref.manifestSha256,
    ].every((v) => typeof v === "string" && sha.test(v))
  )
    throw new Error(
      "A historical raw transfer requires the registered worker and an exact signed reference",
    );
  const { baseUrl, authToken, envelope } = await registeredWorkerArchiveOwner(
    db,
    ref.executionId,
  );
  const [local] =
    await db.execute(sql`SELECT cfg.instance_id FROM progressive_worker_reports r
    JOIN sim_jobs j ON j.id=r.sim_job_id AND j.engine_job_id=j.id::text AND j.status IN ('done','failed','cancelled')
    JOIN sync_sweep_promises p ON p.id=${envelope.promiseId}::uuid AND p.registered_solver_id=${envelope.solverId}::uuid
      AND p.status IN ('cancelled','expired') AND p.source_base_url=${baseUrl}
    JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.remote_solver_registered_id=p.registered_solver_id
      AND cfg.upstream_base_url=p.source_base_url AND NOT cfg.remote_solver_transfer_paused
    WHERE r.sim_job_id=${ref.executionId}::uuid AND r.sequence=${ref.sequence} AND r.content_signature=${ref.reportSignature}
      AND r.assignment_signature=${envelope.contentSignature} AND r.acknowledged_at IS NOT NULL
      AND NOT EXISTS (SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)`);
  if (!local)
    throw new Error(
      "The registered worker has no matching closed, acknowledged source or transfers are paused",
    );
  const route = `${baseUrl}/progressive-executions/${ref.executionId}/historical-raw-archives/${ref.sequence}/${ref.pointSignature}`;
  const query = new URLSearchParams({
    reportSignature: ref.reportSignature,
    storedSha256: ref.storedSha256,
    manifestSha256: ref.manifestSha256,
  });
  async function broker(suffix: string, init: RequestInit) {
    const response = await fetcher(route + suffix + "?" + query, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(deadline),
      headers: { ...init.headers, "x-xfoilfoam-solver-token": authToken },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Historical raw ${suffix || "/upload"} returned HTTP ${response.status}`,
      );
    }
    return (await readArchiveBrokerResponse(response)) as Record<
      string,
      unknown
    >;
  }
  const plan = await broker("/plan", { method: "POST" });
  const owner = plan.owner as Record<string, unknown> | undefined;
  if (
    Object.entries(ref).some(([k, v]) => plan[k] !== v) ||
    plan.solverId !== envelope.solverId ||
    plan.sourceInstanceId !== local.instance_id ||
    owner?.promiseId !== envelope.promiseId ||
    owner.assignmentSignature !== envelope.contentSignature ||
    typeof owner.stopSignature !== "string" ||
    !sha.test(owner.stopSignature) ||
    !positive(plan.storedBytes, 1024 ** 3) ||
    !positive(plan.manifestBytes, 8 * 1024 ** 2) ||
    !positive(plan.tarBytes, Number.MAX_SAFE_INTEGER) ||
    typeof plan.tarSha256 !== "string" ||
    !sha.test(plan.tarSha256) ||
    !positive(plan.bundledFileCount, Number.MAX_SAFE_INTEGER) ||
    !positive(plan.zstdLevel, 22) ||
    (plan.generation !== null && !generation(plan.generation))
  )
    throw new Error("Historical raw plan changed its registered identity");
  const slug = owner.slug;
  const archivePath = plan.archivePath,
    manifestPath = plan.manifestPath;
  if (
    typeof slug !== "string" ||
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(slug) ||
    typeof archivePath !== "string" ||
    !archivePath.endsWith("/engine_evidence.tar.zst") ||
    !archivePath
      .split("/")
      .every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment)) ||
    manifestPath !==
      archivePath.slice(0, archivePath.lastIndexOf("/") + 1) +
        "evidence_manifest.json"
  )
    throw new Error(
      "Historical source file is outside its exact engine job and evidence directory",
    );
  if (!execute) return { state: "planned", ...plan };
  async function engineFile(path: string, size: number) {
    const base = process.env.ENGINE_URL || "http://api:8000";
    const res = await fetcher(
      new URL(`/jobs/${ref.executionId}/files/cases/${slug}/${path}`, base),
      {
        redirect: "error",
        signal: AbortSignal.timeout(deadline),
        headers: { "accept-encoding": "identity" },
      },
    );
    if (
      !res.ok ||
      !res.body ||
      res.headers.get("content-length") !== String(size) ||
      res.headers.get("content-encoding")
    ) {
      await res.body?.cancel();
      throw new Error("Exact original engine file is unavailable");
    }
    return Readable.fromWeb(res.body);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await engineFile(
    String(manifestPath),
    plan.manifestBytes,
  )) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > plan.manifestBytes)
      throw new Error("Oversized historical manifest");
    chunks.push(bytes);
  }
  const manifest = Buffer.concat(chunks);
  if (
    size !== plan.manifestBytes ||
    createHash("sha256").update(manifest).digest("hex") !== ref.manifestSha256
  )
    throw new Error("Original manifest content changed");
  const parsed = parseEvidenceManifest(manifest);
  if (parsed.bundled.length !== plan.bundledFileCount)
    throw new Error("Original manifest inventory changed");
  let pin = plan.generation;
  if (pin === null) {
    const stream = await engineFile(archivePath, plan.storedBytes);
    try {
      const stored = await broker("", {
        method: "PUT",
        headers: {
          "content-type": "application/zstd",
          "content-length": String(plan.storedBytes),
        },
        body: stream as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit);
      if (
        stored.state !== "stored" ||
        !generation(stored.generation) ||
        stored.storedSha256 !== ref.storedSha256
      )
        throw new Error("Invalid raw storage generation");
      pin = stored.generation;
    } finally {
      stream.destroy();
    }
  }
  const receipt = await broker("/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      generation: pin,
      manifestBase64: manifest.toString("base64"),
    }),
  });
  const expected = {
    state: "registered",
    sim_job_id: ref.executionId,
    sequence: ref.sequence,
    point_content_signature: ref.pointSignature,
    report_signature: ref.reportSignature,
    promise_id: envelope.promiseId,
    assignment_signature: envelope.contentSignature,
    stop_signature: owner.stopSignature,
    solver_id: envelope.solverId,
    source_instance_id: local.instance_id,
    stored_sha256: ref.storedSha256,
    stored_bytes: plan.storedBytes,
    manifest_sha256: ref.manifestSha256,
    manifest_bytes: size,
    tar_sha256: plan.tarSha256,
    tar_bytes: plan.tarBytes,
    zstd_level: plan.zstdLevel,
    bundled_file_count: parsed.bundled.length,
    manifest_set_sha256: manifestMemberSetSha256(parsed.memberSet),
    generation: pin,
    object_key: `solver-evidence/v1/sha256/${ref.storedSha256.slice(0, 2)}/${ref.storedSha256}.tar.zst`,
  };
  if (
    Object.entries(expected).some(([k, v]) => receipt[k] !== v) ||
    typeof receipt.bucket !== "string" ||
    !receipt.bucket ||
    typeof receipt.crc32c !== "string" ||
    !/^[A-Za-z0-9+/]{6}==$/.test(receipt.crc32c) ||
    !Number.isFinite(Date.parse(String(receipt.verifiedAt)))
  )
    throw new Error(
      "Historical raw acknowledgment changed its owner, source or generation",
    );
  return {
    ...receipt,
    uploadedBytes: plan.generation === null ? plan.storedBytes : 0,
    wholeVerifiedBytes: plan.storedBytes,
  };
}
