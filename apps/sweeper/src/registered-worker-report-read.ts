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
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
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
export const maxRegisteredPageMembers = 8;
export const maxRegisteredPageBytes = 32 * 1024 ** 2;
function objectIdentity(p: ReportPin) {
  const { sequence, signature, reportSha256, reportByteSize, ...object } = p;
  return object;
}
export function assertRegisteredPage(links: readonly HubReportLink[]) {
  requireReportProof(
    Array.isArray(links) &&
      links.length > 0 &&
      links.length <= maxRegisteredPageMembers,
    "Invalid registered report page",
  );
  const first = links[0]!;
  let total = 0;
  for (const [index, l] of links.entries()) {
    assertReportPin(l.pin);
    total += l.pin.reportByteSize;
    requireReportProof(
      l.owner.executionId === l.pin.executionId &&
        isDeepStrictEqual(l.owner, first.owner) &&
        l.hubBundle === first.hubBundle &&
        l.hubInstance === first.hubInstance &&
        isDeepStrictEqual(objectIdentity(l.pin), objectIdentity(first.pin)) &&
        (!index || links[index - 1]!.pin.sequence < l.pin.sequence) &&
        total <= maxRegisteredPageBytes,
      "Registered report page crossed owner, object, order or byte limit",
    );
  }
}
type PageMember = { pin: ReportPin; text: string };
async function exactHubMembers(
  source: Readable,
  pins: readonly ReportPin[],
  owner: ReportOwner,
  signal?: AbortSignal,
) {
  const wanted = new Map(pins.map((p) => [p.sequence, p]));
  const rows = new Map<number, PageMember>();
  let expanded = 0;
  await visitVerifiedSignedReportArchive(
    "remote",
    source,
    pins[0]!,
    owner,
    (entry) => {
      expanded += Buffer.byteLength(entry.reportText);
      requireReportProof(
        entry.kind === "report" && expanded <= 256 * 1024 ** 2,
        "Invalid registered report record set",
      );
      const pin = wanted.get(entry.sequence);
      if (!pin) return;
      const original = reportTextIdentity(entry.reportText);
      requireReportProof(
        entry.contentSignature === pin.signature &&
          original.sha256 === pin.reportSha256 &&
          original.byteSize === pin.reportByteSize,
        "Signed native report bytes differ",
      );
      rows.set(pin.sequence, {
        pin: Object.freeze({ ...pin }),
        text: entry.reportText,
      });
    },
    limits,
    signal,
  );
  requireReportProof(
    rows.size === pins.length,
    "Native report missing from original hub generation",
  );
  return rows;
}
function verifyInventory(link: HubReportLink, text: string) {
  const p = link.pin;
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
export async function inspectHubReportPage(
  source: Readable,
  links: readonly HubReportLink[],
) {
  assertRegisteredPage(links);
  const members = await exactHubMembers(
    source,
    links.map((l) => l.pin),
    links[0]!.owner,
  );
  for (const l of links) verifyInventory(l, members.get(l.pin.sequence)!.text);
}
export async function inspectHubReport(bytes: Buffer, link: HubReportLink) {
  return inspectHubReportPage(Readable.from([bytes]), [link]);
}
// Only the product adapter can consume a verified page. Each normal call still
// rechecks its own live binding. There is no cross-request or process cache.
const localPage = new AsyncLocalStorage<{
  db: DB;
  owner: ReportOwner;
  members: Map<number, PageMember>;
}>();
export async function withRegisteredWorkingPage<T>(
  db: DB,
  links: readonly HubReportLink[],
  work: () => Promise<T>,
) {
  assertRegisteredPage(links);
  const p = links[0]!.pin;
  const owner = await nativeReportOwner(db, p.executionId);
  requireReportProof(
    isDeepStrictEqual(owner, links[0]!.owner),
    "Registered working page owner differs",
  );
  const file = await readWorkerReportVolume(p);
  requireReportProof(file, "Registered hub report working copy unavailable");
  const members = await exactHubMembers(
    file,
    links.map((l) => l.pin),
    owner,
    AbortSignal.timeout(15000),
  );
  try {
    return await localPage.run({ db, owner, members }, work);
  } finally {
    members.clear();
  }
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
  const page = localPage.getStore();
  if (page) {
    const row = page.members.get(pin.sequence);
    requireReportProof(
      page.db === db &&
        isDeepStrictEqual(owner, page.owner) &&
        row &&
        isDeepStrictEqual(row.pin, pin),
      "Product reader differs from registered working page",
    );
    signal?.throwIfAborted();
    return row.text;
  }
  const file = await readWorkerReportVolume(pin);
  requireReportProof(file, "Registered hub report working copy unavailable");
  return (await exactHubMembers(file, [pin], owner, signal)).get(pin.sequence)!
    .text;
}
