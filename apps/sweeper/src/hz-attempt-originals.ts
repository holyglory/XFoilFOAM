import { requireActiveHzTransfer } from "./hz-attempt-transfer-fence";
import { Readable } from "node:stream";
import { sql, type SQL } from "drizzle-orm";
import { verifyProgressiveRemoteExecution } from "@aerodb/db/progressive-remote-execution";
import type { DB } from "@aerodb/db/client";
import {
  MAX_ATTEMPT_EVIDENCE_BYTES,
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
} from "@aerodb/db/attempt-evidence-storage";
import {
  getAttemptEvidenceArchive,
  registerAttemptEvidenceArchive,
  type AttemptEvidenceArchiveIdentity,
  type AttemptEvidenceArchiveRecord,
} from "@aerodb/db/attempt-evidence-catalog";
import {
  readAttemptEvidenceCopy,
  type AttemptEvidenceCopyIdentity,
} from "./attempt-evidence-archive";
import {
  exactId,
  packHzAttemptSource,
  sameArchive,
  ZERO_ID,
} from "./hz-attempt-custody";
import { assertHzAttemptOwner, hzAttemptKey } from "./hz-attempt-volume";
import { HzAttemptHubStore } from "./hz-attempt-hub";

export const MAX_ORIGINAL_PAGE = 64;
export const MAX_ORIGINAL_TRANSFER = 2 * MAX_ATTEMPT_EVIDENCE_BYTES + 196608;
export interface OriginalPin {
  id: string;
  result: string | null;
  job: string | null;
  sha: string;
  bytes: number;
  history: number;
}
export interface PointAck {
  seq: number;
  point: string;
  hubAttempt: string;
  hubResult: string;
  storageOnly: boolean;
}
export interface OriginalRow extends OriginalPin {
  stored: number;
  settled: boolean;
  owned: boolean;
  archive: string | null;
  ack: PointAck | null;
}
export interface SourceBinding {
  instance: string;
  solver: string;
  high: string;
  transfer_fence_protocol?: number;
}
export interface PriorityMatch {
  id: string;
  hubInstance: string;
  hubAttempt: string;
  hubResult: string;
  hubArchive: string;
  generation: string;
}
export interface PreparedOriginal {
  pin: OriginalPin;
  identity?: AttemptEvidenceArchiveRecord;
  proof?: AttemptEvidenceCopyIdentity;
  packed?: string;
}
export interface VerifiedOriginal {
  pin: OriginalPin;
  identity: AttemptEvidenceArchiveIdentity;
  packed: string;
}
export function checkOriginalPage(n: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ORIGINAL_PAGE)
    throw Error("Invalid original page size");
}
export function checkOriginalBudget(n: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ATTEMPT_EVIDENCE_BYTES)
    throw Error("Invalid original source byte budget");
}
export function samePin(a: OriginalPin, b: OriginalPin) {
  return (
    a.id === b.id &&
    a.result === b.result &&
    a.job === b.job &&
    a.sha === b.sha &&
    a.bytes === b.bytes &&
    a.history === b.history
  );
}
export function checkPin(p: OriginalPin) {
  exactId(p.id);
  if (p.result !== null) exactId(p.result);
  if (p.job !== null) exactId(p.job);
  if (
    !/^[a-f0-9]{64}$/.test(p.sha) ||
    !Number.isSafeInteger(p.bytes) ||
    p.bytes < 1 ||
    p.bytes > MAX_ATTEMPT_EVIDENCE_BYTES ||
    !Number.isSafeInteger(p.history) ||
    p.history < 1 ||
    p.history > p.bytes
  )
    throw Error("Invalid frozen HZ source");
}
export function originalPacked(value: string) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 4 * Math.ceil(MAX_ORIGINAL_TRANSFER / 3)
  )
    throw Error("Invalid packed original size");
  const b = Buffer.from(value, "base64");
  if (b.toString("base64") !== value)
    throw Error("Invalid packed original encoding");
  return b;
}
export async function originalBinding(db: DB): Promise<SourceBinding> {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw Error("Expected worker role");
  const [r] =
    await db.execute(sql`SELECT cfg.instance_id::text AS instance,cfg.remote_solver_registered_id::text AS solver,
 (SELECT id::text FROM result_attempts ORDER BY id DESC LIMIT 1) AS high FROM sync_api_settings cfg JOIN registered_remote_solvers worker ON worker.id=cfg.remote_solver_registered_id AND worker.instance_id=cfg.instance_id::text AND worker.revoked_at IS NULL WHERE cfg.id=1 AND cfg.upstream_base_url IS NOT NULL`);
  if (!r) throw Error("Missing HZ registration");
  return {
    instance: exactId(r.instance),
    solver: exactId(r.solver),
    high: exactId(r.high ?? ZERO_ID),
    transfer_fence_protocol: 1,
  };
}
/** HZ proves the producing job, worker registration and immutable submission.
 * The upstream receipt and current selected result are deliberately independent. */
function workerOwners(
  keys: SQL,
  b: SourceBinding,
  full: boolean,
  lock = false,
) {
  return sql`WITH native AS MATERIALIZED (
   SELECT a.id,a.airfoil_id,a.simulation_preset_revision_id AS revision,j.id AS job,j.request_payload->>'syncPromiseId' AS promise,
     j.request_payload->'remoteProgressiveExecution' AS envelope,j.request_payload->>'upstreamBaseUrl' AS upstream,
     (j.request_payload->>'remoteSolver'='true' AND j.request_payload->'engineRequest'=j.request_payload#>'{remoteProgressiveExecution,request}') AS signed_request
   FROM ${keys} k JOIN LATERAL (
     SELECT a.id,a.result_id,a.sim_job_id,a.engine_job_id,a.airfoil_id,a.aoa_deg,a.bc_id,a.simulation_preset_revision_id
     FROM result_attempts a WHERE a.id=k.id OFFSET 0
   ) a ON true JOIN LATERAL (
     SELECT j.id,j.request_payload,j.engine_job_id,j.airfoil_id,j.simulation_preset_revision_id,j.bc_ids FROM sim_jobs j WHERE j.id=a.sim_job_id OFFSET 0
   ) j ON j.engine_job_id=j.id::text AND a.engine_job_id=j.engine_job_id AND j.airfoil_id=a.airfoil_id
     AND j.simulation_preset_revision_id=a.simulation_preset_revision_id AND j.bc_ids ? a.bc_id::text
   WHERE a.result_id IS NULL OR EXISTS(SELECT FROM results r WHERE r.id=a.result_id AND r.airfoil_id=a.airfoil_id
     AND r.aoa_deg=a.aoa_deg AND r.simulation_preset_revision_id=a.simulation_preset_revision_id))
 SELECT n.id,n.job,pr.id AS promise,intent.assignment_signature AS signature,cfg.remote_solver_transfer_paused AS paused
   ${full ? sql`,n.envelope` : sql``}
 FROM native n JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.instance_id::text=${b.instance}
   AND cfg.remote_solver_registered_id=${b.solver}::uuid AND n.upstream=cfg.upstream_base_url
 JOIN registered_remote_solvers worker ON worker.id=cfg.remote_solver_registered_id AND worker.instance_id=cfg.instance_id::text AND worker.revoked_at IS NULL
 JOIN LATERAL (SELECT pr.id,pr.registered_solver_id,pr.source_base_url,pr.airfoil_id,pr.simulation_preset_revision_id
   FROM sync_sweep_promises pr WHERE pr.id=CASE WHEN n.promise ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN n.promise::uuid END
   OFFSET 0 ${lock ? sql`FOR SHARE NOWAIT` : sql``}) pr ON pr.registered_solver_id=worker.id AND pr.source_base_url=cfg.upstream_base_url
   AND pr.airfoil_id=n.airfoil_id AND pr.simulation_preset_revision_id=n.revision
 JOIN progressive_worker_submission_intents intent ON intent.sim_job_id=n.job AND intent.authorization->>'kind'='authorized'
   AND intent.authorization->>'executionId'=n.job::text AND intent.authorization->>'contentSignature'=intent.assignment_signature
   AND intent.assignment_signature=n.envelope->>'contentSignature'
 WHERE n.signed_request AND n.envelope->>'solverId'=worker.id::text AND n.envelope->>'promiseId'=pr.id::text
   AND n.envelope#>>'{scope,executionId}'=n.job::text`;
}
async function checkWorkerOwner(
  db: DB,
  b: SourceBinding,
  p: OriginalPin,
  lock = false,
) {
  const query = workerOwners(sql`(SELECT ${p.id}::uuid AS id)`, b, true, lock);
  const [owner] = await db.execute(
    sql`${query} ${lock ? sql`FOR SHARE OF cfg,worker,intent NOWAIT` : sql``}`,
  );
  if (!owner || owner.job !== p.job)
    throw Error("Registered worker does not own the producing job");
  verifyProgressiveRemoteExecution(owner.envelope, {
    solverId: b.solver,
    promiseId: String(owner.promise),
    executionId: String(owner.job),
    contentSignature: String(owner.signature),
  });
  requireActiveHzTransfer(owner.paused);
}

export async function inspectOriginals(
  db: DB,
  binding: SourceBinding,
  input: { after: string; high: string; limit: number } | { ids: string[] },
): Promise<OriginalRow[]> {
  const count = "ids" in input ? input.ids.length : input.limit;
  checkOriginalPage(count);
  const keys =
    "ids" in input
      ? sql`SELECT a.id FROM result_attempts a JOIN jsonb_array_elements_text(${JSON.stringify(input.ids.map(exactId))}::text::jsonb) k ON a.id=k.value::uuid`
      : sql`SELECT id FROM result_attempts WHERE id>${exactId(input.after)}::uuid AND id<=${exactId(input.high)}::uuid ORDER BY id LIMIT ${input.limit}`;
  // The copy owner is this DB's exact native row. A signed acknowledgment
  // affects priority only. No selection, regime or upstream-result predicate.
  return (await db.execute(sql`WITH keys AS MATERIALIZED (${keys}), owners AS MATERIALIZED (${workerOwners(sql`keys`, binding, false)}), src AS MATERIALIZED (
 SELECT a.id,a.result_id,a.sim_job_id,a.evidence_archive_id,ow.id IS NOT NULL AS owned,pg_column_size(a.evidence_payload)::integer AS stored,
 a.status IN ('done','failed') AND (a.sim_job_id IS NULL OR (j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
 AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp()))) AS settled,
 CASE WHEN a.evidence_archive_id IS NULL AND pg_column_size(a.evidence_payload)<=${MAX_ATTEMPT_EVIDENCE_BYTES} THEN a.evidence_payload END AS payload
 FROM keys k JOIN result_attempts a ON a.id=k.id LEFT JOIN sim_jobs j ON j.id=a.sim_job_id LEFT JOIN owners ow ON ow.id=a.id
 ), facts AS MATERIALIZED (SELECT s.*,
 CASE WHEN s.evidence_archive_id IS NOT NULL THEN ar.source_byte_size ELSE octet_length(s.payload::text) END::int AS bytes,
 CASE WHEN s.evidence_archive_id IS NOT NULL THEN ar.source_sha256 WHEN octet_length(s.payload::text)<=${MAX_ATTEMPT_EVIDENCE_BYTES} THEN encode(sha256(convert_to(s.payload::text,'UTF8')),'hex') END AS sha,
 CASE WHEN s.evidence_archive_id IS NOT NULL THEN ar.history_byte_size WHEN octet_length(s.payload::text)<=${MAX_ATTEMPT_EVIDENCE_BYTES}
 THEN (SELECT coalesce(sum((i->>'byteSize')::int),0) FROM jsonb_array_elements(attempt_evidence_series_inventory(s.payload)) i) END::int AS history
 FROM src s LEFT JOIN attempt_evidence_archives ar ON ar.id=s.evidence_archive_id AND ar.result_attempt_id=s.id
 AND ar.source_instance=${binding.instance} AND ar.result_id IS NOT DISTINCT FROM s.result_id AND ar.sim_job_id IS NOT DISTINCT FROM s.sim_job_id)
 SELECT f.id::text AS id,f.result_id::text AS result,f.sim_job_id::text AS job,f.stored,f.settled,f.owned,f.bytes,f.sha,f.history,
 ar.id::text AS archive,ack.value AS ack FROM facts f LEFT JOIN LATERAL (
 SELECT ar.id FROM attempt_evidence_archives ar WHERE ar.source_instance=${binding.instance} AND ar.result_attempt_id=f.id
 AND ar.result_id IS NOT DISTINCT FROM f.result_id AND ar.sim_job_id IS NOT DISTINCT FROM f.sim_job_id AND ar.source_sha256=f.sha AND ar.source_byte_size=f.bytes
 AND (f.evidence_archive_id IS NULL OR ar.id=f.evidence_archive_id) ORDER BY ar.verified_at DESC,ar.id LIMIT 1) ar ON true
 LEFT JOIN LATERAL (SELECT jsonb_build_object('seq',h.sequence,'point',h.point_content_signature,'hubAttempt',h.receipt->>'resultAttemptId','hubResult',h.receipt->>'resultId','storageOnly',h.receipt->'storageOnly') AS value
 FROM progressive_worker_hub_receipts h WHERE h.result_attempt_id=f.id AND h.sim_job_id=f.sim_job_id AND h.receipt->>'remoteResultAttemptId'=f.id::text
 AND h.receipt->>'remoteResultId'=f.result_id::text AND h.receipt->>'executionId'=f.sim_job_id::text AND h.receipt->>'pointContentSignature'=h.point_content_signature
 AND h.receipt->>'sequence'=h.sequence::text AND h.receipt->>'kind'='retained-progressive-attempt' AND h.receipt->>'version'='1'
 ORDER BY h.sequence,h.point_content_signature LIMIT 1) ack ON true ORDER BY f.id`)) as unknown as OriginalRow[];
}
export async function mapOriginals(
  db: DB,
  b: SourceBinding,
  rows: OriginalRow[],
): Promise<PriorityMatch[]> {
  checkOriginalPage(rows.length);
  // Match remote and canonical owners independently, even when UUID strings coincide.
  return (await db.execute(sql`SELECT DISTINCT ON(k.id) k.id::text,settings.instance_id::text AS "hubInstance",
  e.result_attempt_id::text AS "hubAttempt",a.result_id::text AS "hubResult",ar.id::text AS "hubArchive",ar.generation
 FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) k(id uuid,result uuid,job uuid,sha text,bytes int,ack jsonb)
 JOIN progressive_remote_evidence_receipts e ON e.remote_result_attempt_id=k.id AND e.remote_result_id=k.result AND e.sim_job_id=k.job
 AND e.result_attempt_id::text=k.ack->>'hubAttempt' AND e.sequence::text=k.ack->>'seq' AND e.point_content_signature=k.ack->>'point'
 AND e.storage_only=(k.ack->>'storageOnly')::boolean
 JOIN progressive_remote_dispatches d ON d.sim_job_id=e.sim_job_id AND d.solver_id=${b.solver}::uuid
 JOIN registered_remote_solvers s ON s.id=d.solver_id AND s.instance_id=${b.instance} AND s.revoked_at IS NULL
 JOIN result_attempts a ON a.id=e.result_attempt_id AND a.result_id::text=k.ack->>'hubResult'
 JOIN attempt_evidence_archives ar ON ar.result_attempt_id=a.id AND ar.result_id=a.result_id AND ar.sim_job_id=k.job AND ar.source_sha256=k.sha AND ar.source_byte_size=k.bytes
 JOIN sync_api_settings settings ON settings.id=1 AND ar.source_instance=settings.instance_id::text AND settings.instance_id::text<>${b.instance}
 ORDER BY k.id,ar.verified_at DESC,ar.id`)) as unknown as PriorityMatch[];
}
export async function prepareOriginals(
  db: DB,
  b: SourceBinding,
  pins: OriginalPin[],
  budget: number,
) {
  checkOriginalPage(pins.length);
  checkOriginalBudget(budget);
  pins.forEach(checkPin);
  if (
    new Set(pins.map((p) => p.id)).size !== pins.length ||
    pins.reduce((n, p) => n + p.bytes, 0) > budget
  )
    throw Error("Original page exceeds budget");
  const rows = new Map(
    (await inspectOriginals(db, b, { ids: pins.map((p) => p.id) })).map((r) => [
      r.id,
      r,
    ]),
  );
  const items: PreparedOriginal[] = [],
    deferred: string[] = [];
  for (const pin of pins) {
    const row = rows.get(pin.id);
    if (!row || !samePin(row, pin)) throw Error("Frozen HZ original changed");
    if (!row.owned)
      throw Error("Original worker ownership cannot be established");
    await checkWorkerOwner(db, b, pin);
    if (row.archive) {
      const identity = await getAttemptEvidenceArchive(db, row.archive);
      await assertHzAttemptOwner(db, identity);
      items.push({ pin, identity });
      continue;
    }
    if (!row.settled) {
      deferred.push(pin.id);
      continue;
    }
    const src = await loadSettledAttemptEvidenceCopy(db, pin.id);
    const { proof, packed } = await packHzAttemptSource(src);
    if (
      proof.sourceSha256 !== pin.sha ||
      proof.sourceByteSize !== pin.bytes ||
      proof.resultId !== pin.result ||
      proof.simJobId !== pin.job
    )
      throw Error("HZ source changed during preparation");
    items.push({ pin, proof, packed });
  }
  return { items, deferred };
}
export async function originalHubObjects(
  store: HzAttemptHubStore,
  b: SourceBinding,
  items: PreparedOriginal[],
  budget: number,
) {
  checkOriginalPage(items.length);
  checkOriginalBudget(budget);
  if (items.reduce((n, x) => n + x.pin.bytes, 0) > budget)
    throw Error("Hub original page exceeds byte budget");
  const results: VerifiedOriginal[] = [];
  for (const x of items) {
    checkPin(x.pin);
    const p = x.identity ?? x.proof;
    if (
      !p ||
      p.attemptId !== x.pin.id ||
      p.resultId !== x.pin.result ||
      p.simJobId !== x.pin.job ||
      p.sourceSha256 !== x.pin.sha ||
      p.sourceByteSize !== x.pin.bytes
    )
      throw Error("Hub original source mismatch");
    if (
      x.identity &&
      (x.identity.sourceInstance !== b.instance ||
        x.identity.objectKey !== hzAttemptKey(b.instance, x.identity))
    )
      throw Error("Foreign archive");
    const proof = x.identity
      ? await store.read({
          ...x.identity,
          verifiedAt: new Date(x.identity.verifiedAt),
        })
      : await store.put(b.instance, x.proof!, originalPacked(x.packed!));
    results.push({ pin: x.pin, ...proof });
  }
  return results;
}
export async function registerOriginals(
  db: DB,
  b: SourceBinding,
  items: VerifiedOriginal[],
  budget: number,
) {
  checkOriginalPage(items.length);
  checkOriginalBudget(budget);
  if (items.reduce((n, x) => n + x.pin.bytes, 0) > budget)
    throw Error("Registration exceeds byte budget");
  const result = [];
  for (const x of items) {
    checkPin(x.pin);
    const i = { ...x.identity, verifiedAt: new Date(x.identity.verifiedAt) };
    if (
      i.sourceInstance !== b.instance ||
      i.attemptId !== x.pin.id ||
      i.resultId !== x.pin.result ||
      i.simJobId !== x.pin.job ||
      i.sourceSha256 !== x.pin.sha ||
      i.sourceByteSize !== x.pin.bytes
    )
      throw Error("Foreign HZ source");
    await assertHzAttemptOwner(db, i);
    const source = await readAttemptEvidenceCopy(
      Readable.from([originalPacked(x.packed)]),
      i,
    );
    const plan = prepareAttemptEvidenceCopy(source);
    if (
      plan.historySeries.reduce((n, y) => n + y.byteSize, 0) !== x.pin.history
    )
      throw Error("Restored original inventory mismatch");
    const registered = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
      await tx.execute(
        sql`SELECT attempt_evidence_lock_source(${i.attemptId}::uuid)`,
      );
      await checkWorkerOwner(tx, b, x.pin, true);
      const [current] =
        await tx.execute(sql`SELECT a.evidence_archive_id::text AS pointer,a.result_id::text AS result,a.sim_job_id::text AS job,
      CASE WHEN a.evidence_archive_id IS NULL THEN octet_length(a.evidence_payload::text)=${i.sourceByteSize} AND
      encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex')=${i.sourceSha256} END AS matches
      FROM result_attempts a WHERE a.id=${i.attemptId}::uuid`);
      if (
        !current ||
        current.result !== i.resultId ||
        current.job !== i.simJobId ||
        (!current.pointer && current.matches !== true)
      )
        throw Error("HZ original changed before registration");
      const [existing] = await tx.execute(
        sql`SELECT id FROM attempt_evidence_archives WHERE source_instance=${b.instance} AND result_attempt_id=${i.attemptId}::uuid AND source_sha256=${i.sourceSha256} AND envelope_sha256=${i.envelopeSha256}`,
      );
      if (current.pointer && current.pointer !== existing?.id)
        throw Error("Original is not the active HZ archive");
      const registered = existing
        ? {
            archive: await getAttemptEvidenceArchive(tx, String(existing.id)),
            created: false,
          }
        : await registerAttemptEvidenceArchive(tx, i, plan);
      sameArchive(registered.archive, i);
      return registered;
    });
    result.push({
      id: i.attemptId,
      archive: registered.archive.id,
      generation: i.generation,
      sha: i.sourceSha256,
      sourceBytes: i.sourceByteSize,
      historyBytes: x.pin.history,
      packedBytes: i.storedByteSize,
      created: registered.created,
    });
  }
  return result;
}
