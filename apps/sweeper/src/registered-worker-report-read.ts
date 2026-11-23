import type { DB } from "@aerodb/db/client";
import {
  assertProgressiveReportArchiveIdentity,
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  visitVerifiedSignedReportArchive,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import { sql } from "drizzle-orm";
import { Readable } from "node:stream";
import { configuredDeploymentRole } from "./config";
import { registeredWorkerArchiveOwner } from "./report-archive-broker-client";
import { readWorkerReportVolume } from "./worker-report-volume";

export const reportUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const reportHash = /^[a-f0-9]{64}$/;
export const maxPacked = 32 * 1024 ** 2;
const limits = {
  maxMembers: 128,
  maxDecodedBytes: 128 * 1024 ** 2,
  maxReportBytes: 32 * 1024 ** 2,
};
export type ReportPin = ProgressiveReportArchiveReadIdentity;
export interface ReportOwner {
  executionId: string;
  solverId: string;
  promiseId: string;
  assignmentSignature: string;
  workerInstance: string;
  upstream: string;
}
export interface PointAnchor {
  signature: string;
  sequence: number;
  aoa: number;
  caseSlug: string | null;
  workerAttempt: string;
  workerResult: string;
  hubAttempt: string;
  hubResult: string;
}
export interface HubReportLink {
  owner: ReportOwner;
  pin: ReportPin;
  hubInstance: string;
  hubBundle: string;
  inventory: string;
  anchors: PointAnchor[];
}
export function requireReportProof(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
export function assertReportPin(p: ReportPin) {
  assertProgressiveReportArchiveIdentity(p);
  requireReportProof(
    p.sourceKind === "worker" &&
      p.memberKind === "report" &&
      reportUuid.test(p.executionId) &&
      reportHash.test(p.signature) &&
      reportHash.test(p.reportSha256) &&
      Number.isSafeInteger(p.sequence) &&
      p.sequence > 0 &&
      Number.isSafeInteger(p.reportByteSize) &&
      p.reportByteSize > 0 &&
      p.reportByteSize <= limits.maxReportBytes &&
      p.storedByteSize <= maxPacked &&
      p.firstSequence &&
      p.lastSequence &&
      p.memberCount &&
      p.memberCount <= limits.maxMembers &&
      p.firstSequence <= p.sequence &&
      p.sequence <= p.lastSequence &&
      p.memberCount <= p.lastSequence - p.firstSequence + 1 &&
      /^[a-z0-9][a-z0-9_.-]{1,220}[a-z0-9]$/.test(p.bucket) &&
      /^[A-Za-z0-9_./-]+$/.test(p.objectKey) &&
      p.objectKey.split("/").every((k) => k && k !== "." && k !== "..") &&
      p.objectKey.endsWith(
        `/remote/${p.executionId}/${p.storedSha256}.jsonl.gz`,
      ) &&
      BigInt(p.generation) <= 18446744073709551615n,
    "Invalid registered hub report pin",
  );
}
export async function nativeReportOwner(
  db: DB,
  executionId: string,
): Promise<ReportOwner> {
  requireReportProof(
    configuredDeploymentRole() === "remote-solver" &&
      reportUuid.test(executionId),
    "Expected native worker report owner",
  );
  const { envelope, baseUrl } = await registeredWorkerArchiveOwner(
    db,
    executionId,
  );
  const [row] =
    await db.execute(sql`SELECT s.instance_id::text AS instance FROM sync_api_settings s
    JOIN registered_remote_solvers r ON r.id=s.remote_solver_registered_id AND r.instance_id=s.instance_id::text AND r.revoked_at IS NULL
    WHERE s.id=1 AND r.id=${envelope.solverId}::uuid AND s.upstream_base_url=${baseUrl}`);
  requireReportProof(
    row && reportUuid.test(String(row.instance)),
    "Native registered worker identity differs",
  );
  return {
    executionId,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    assignmentSignature: envelope.contentSignature,
    workerInstance: String(row.instance),
    upstream: baseUrl,
  };
}
async function exactHubMember(
  source: Readable,
  p: ReportPin,
  owner: ReportOwner,
  signal?: AbortSignal,
) {
  let found: string | undefined,
    expanded = 0;
  await visitVerifiedSignedReportArchive(
    "remote",
    source,
    p,
    owner,
    (entry) => {
      expanded += Buffer.byteLength(entry.reportText);
      requireReportProof(
        entry.kind === "report" && expanded <= 256 * 1024 ** 2,
        "Invalid registered report record set",
      );
      if (entry.sequence !== p.sequence) return;
      const original = reportTextIdentity(entry.reportText);
      requireReportProof(
        entry.contentSignature === p.signature &&
          original.sha256 === p.reportSha256 &&
          original.byteSize === p.reportByteSize,
        "Signed native report bytes differ",
      );
      found = entry.reportText;
    },
    limits,
    signal,
  );
  requireReportProof(
    found !== undefined,
    "Native report missing from original hub generation",
  );
  return found;
}
export async function inspectHubReport(bytes: Buffer, link: HubReportLink) {
  const { pin: p, owner } = link;
  assertReportPin(p);
  const text = await exactHubMember(Readable.from([bytes]), p, owner);
  const inv = retainedReportInventory(
    reportJsonObject(parseReportJson(text)),
    p.signature,
  );
  requireReportProof(
    inv.signature === link.inventory &&
      inv.sourceCount === link.anchors.length &&
      inv.sourceCount > 0 &&
      inv.sourceCount <= 512 &&
      inv.sources.every((source, index) => {
        const a = link.anchors[index];
        return (
          a?.signature === source.point_content_signature &&
          source.case_slug === a.caseSlug &&
          Number(canonicalReportJson(source.aoa_deg!)) === a.aoa
        );
      }),
    "Archived scientific source inventory differs",
  );
}
export async function readRegisteredWorkerReportArchiveText(
  db: DB,
  identity: ReportPin & { signal?: AbortSignal },
  options: { upstreamOnly?: boolean } = {},
) {
  const { signal, ...pin } = identity;
  assertReportPin(pin);
  requireReportProof(
    !options.upstreamOnly,
    "Registered hub report requires its retained worker volume",
  );
  signal?.throwIfAborted();
  const owner = await nativeReportOwner(db, pin.executionId);
  const [binding] =
    await db.execute(sql`SELECT l.hub_bundle_id FROM progressive_worker_hub_report_links l
    JOIN progressive_worker_reports r ON r.sim_job_id=l.sim_job_id AND r.sequence=l.sequence
    WHERE l.hub_source_kind='remote' AND l.sim_job_id=${pin.executionId}::uuid AND l.sequence=${pin.sequence} AND l.read_identity=${JSON.stringify(pin)}::jsonb
    AND l.worker_instance=${owner.workerInstance}::uuid AND l.registered_solver_id=${owner.solverId}::uuid
    AND l.promise_id=${owner.promiseId}::uuid AND l.assignment_signature=${owner.assignmentSignature} AND l.upstream_base_url=${owner.upstream}
    AND r.assignment_signature=l.assignment_signature AND r.content_signature=${pin.signature} AND r.acknowledged_at IS NOT NULL`);
  requireReportProof(binding, "No exact registered local report binding");
  const file = await readWorkerReportVolume(pin);
  requireReportProof(file, "Registered hub report working copy unavailable");
  return exactHubMember(file, pin, owner, signal);
}
