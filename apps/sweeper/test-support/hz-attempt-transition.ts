import { databaseUrl } from "@aerodb/db/env";
import { attemptEvidenceStorageMain } from "../src/attempt-evidence-storage-cli";
import { assertShortProof, measuredFixtureFloor } from "./short-attempt-proof";
import type { AttemptEvidenceFreshVerification } from "@aerodb/db/attempt-evidence-projection";
import { checkHzTransferFence, hzAttemptRpcFailure } from "../src/hz-attempt-transfer-fence";
import { analysisContentHash, type ProgressiveRemoteReport } from "@aerodb/db";
import { replayProgressiveWorkerOutbox, ProgressiveWorkerReplayNeedsFinalReport } from "../src/progressive-worker-outbox-replay";
import { verifyOriginalCopyJourney } from "./hz-attempt-originals-fixture";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import { readHzAttemptWorkingCopy } from "../src/hz-attempt-volume";
import {
  preparePublicationHistories,
  publicationHistoryJoin,
  publicationHistoryPayload,
} from "../src/attempt-publication-history";
import {
  loadAttemptSourcePins,
  prepareAttemptSources,
} from "@aerodb/db/attempt-receipt-source";
import { createClient, type DB } from "@aerodb/db/client";
import { sql, type SQL } from "drizzle-orm";
import { expect, vi } from "vitest";
import { createSettlementFixture } from "./attempt-settlement-fixture";
import { HzAttemptHubStore } from "../src/hz-attempt-hub";
import { attemptHubOperation, attemptWorkerOperation } from "../src/hz-attempt-custody-cli";
import { hzAttemptApiProbe } from "../../api/src/hz-attempt-custody-cli";
import { readStoredAttemptEvidenceText } from "../../api/src/attempt-evidence-reader";
import {
  migrateHzAttempt,
  type AttemptRelay,
} from "../src/hz-attempt-migration";
import {
  readOriginalAttemptForProjection,
  sweeperAttemptArchiveReader,
  readSweeperAttemptEvidence,
} from "../src/attempt-evidence-consumer-reader";
import { packedBytes } from "../src/hz-attempt-custody";
import { crc32c } from "@aerodb/core/result-history-storage";
import { type ProgressiveWorkerOutboxReplayInput } from "../src/progressive-worker-outbox-replay";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import { readWorkerReportVolume } from "../src/worker-report-volume";
import { readProgressiveReportArchiveText } from "@aerodb/db/progressive-report-archive";
import { hzAttemptStorage } from "../src/hz-attempt-storage-cli";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { HistoryOperationError, SETTLED_REPORT_SIZE_LIMIT } from "@aerodb/core/point-history-protocol";

function objectStore(originalCopy = false) {
  const objects = new Map<string, { bytes: Buffer; metadata: any }>();
  const account = "fixture@attempt-test.iam.gserviceaccount.com",
    bucket = "attempt-fixture";
  const generation = "18446744073709551612";
  const request: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal")
      return new Response(
        url.pathname.endsWith("/email")
          ? account
          : JSON.stringify({
              access_token: "only-in-fixture",
              token_type: "Bearer",
            }),
        { headers: { "Metadata-Flavor": "Google" } },
      );
    expect(url.hostname).toBe("storage.googleapis.com");
    expect(options?.redirect).toBe("error");
    if (options?.method === "POST") {
      expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      const data = Buffer.from(options.body as unknown as Uint8Array),
        boundary = data.subarray(0, data.indexOf("\r\n")).toString();
      const start = data.indexOf("\r\n\r\n") + 4,
        end = data.indexOf("\r\n" + boundary, start);
      const meta = JSON.parse(data.subarray(start, end).toString());
      if (objects.has(meta.name)) return new Response(null, { status: 412 });
      const bytes = data.subarray(
        data.indexOf("\r\n\r\n", end) + 4,
        data.lastIndexOf("\r\n" + boundary),
      );
      objects.set(meta.name, {
        bytes,
        metadata: {
          ...meta,
          bucket,
          generation,
          size: String(bytes.length),
          crc32c: crc32c(bytes),
        },
      });
      return new Response("{}");
    }
    const key = decodeURIComponent(url.pathname.split("/o/")[1]!);
    const entry = objects.get(key);
    if (
      !entry ||
      (url.searchParams.has("generation") &&
        url.searchParams.get("generation") !== generation)
    )
      return new Response(null, { status: 404 });
    if (url.searchParams.has("alt")) {
      expect(url.searchParams.get("generation")).toBe(generation);
      return new Response(
        entry.bytes as unknown as NonNullable<RequestInit["body"]>,
      );
    }
    return Response.json(entry.metadata);
  };
  return {
    objects,
    account,
    request,
    store: new HzAttemptHubStore(bucket, account, request, originalCopy),
  };
}

export async function verifyHzAttemptTransition(
  src: DB,
  id: string,
  input: ProgressiveWorkerOutboxReplayInput,
  original: string,
  root: string,
  fullReport: string,
  periodic = false,
  independentAttempt?: string,
  shortProofJourney = false,
  tinyDelivery?: "received" | "failed",
  canonicalSubtrees?: "steady_history" | "frame_track",
) {
  const fixture = await createSettlementFixture(true,true,!!canonicalSubtrees),
    db = fixture.db;
  const prior = process.env.MEDIA_DIR;
  process.env.MEDIA_DIR = root;
  try {
    // Reuse the signed worker outbox fixture, including the real migrated source
    // rows. The destination installs the real custody functions and constraints.
    async function copy(table: string, where: SQL = sql`true`) {
      const name = sql.identifier(table);
      const [r] = await src.execute(
        sql`SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]')::text AS data FROM ${name} t WHERE ${where}`,
      );
      await db.execute(
        sql`INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name},${String(r.data)}::text::jsonb)`,
      );
    }
    await copy(
      "airfoils",
      sql`t.id IN(SELECT airfoil_id FROM sim_jobs WHERE id=${input.executionId}::uuid)`,
    );
    await copy("sim_jobs", sql`t.id=${input.executionId}::uuid`);
    for (const table of [
      "sync_api_settings",
      "sync_sweep_promises",
      "registered_remote_solvers",
      "progressive_worker_submission_intents",
      "progressive_worker_reports",
      "progressive_worker_evidence_receipts",
      "progressive_worker_evidence_attempts",
      "progressive_worker_hub_receipts",
      "progressive_report_archive_bundles",
      "progressive_report_archive_members",
      "results",
      "result_attempts",
    ])
      await copy(table);
    if (tinyDelivery === "failed")
      await copy("progressive_worker_delivery_failures",sql`t.result_attempt_id=${id}::uuid`);
    const [r] = await db.execute(
      sql`SELECT instance_id::text AS instance FROM sync_api_settings`,
    );
    const instance = String(r.instance);
    const { store, objects, account, request } = objectStore();
    async function checkNativeReplay(request: Record<string, unknown>) {
      // The production report reader names its public catalog explicitly.
      // Use the exact fixture catalog there only inside this rollback.
      installProgressiveReportArchiveReader({
        async read(identity) {
          const file = await readWorkerReportVolume(identity);
          if (!file) throw Error("Missing test report volume");
          return readProgressiveReportArchiveText(file, identity);
        },
      });
      const rollback = new Error("rollback public report fixture");
      let result: unknown;
      try {
        await db.transaction(async (tx) => {
          for (const name of [
            "progressive_report_archive_bundles",
            "progressive_report_archive_members",
          ]) {
            const t = sql.identifier(name);
            await tx.execute(
              sql`INSERT INTO public.${t} SELECT * FROM ${sql.identifier(fixture.namespace)}.${t}`,
            );
          }
          result = await attemptWorkerOperation(tx as unknown as DB, request);
          throw rollback;
        });
      } catch (e) {
        if (e !== rollback) throw e;
      } finally {
        installProgressiveReportArchiveReader(null);
      }
      return result;
    }
    const relay: AttemptRelay = {
      worker: (request) =>
        request.operation === "replay"
          ? checkNativeReplay(request)
          : attemptWorkerOperation(db, request),
      hub: (request) =>
        request.operation === "put"
          ? store.put(
              String(request.instance),
              request.proof as any,
              packedBytes(request.packed),
            )
          : store.read({
              ...(request.identity as any),
              verifiedAt: new Date((request.identity as any).verifiedAt),
            }),
      api: async (request) => request.operation==="canonical-read"
        ? (await import("../../api/src/hz-attempt-custody-cli")).hzCanonicalFieldApiProbe(db,String(request.resultId),request.kind as "steady_history"|"frame_track",String(request.reference))
        : hzAttemptApiProbe(
          db,
          String(request.attemptId),
          String(request.archiveId),
          request.forceArchive === true,
        ),
    };
    const accountFile = join(root, "expected-account"),
      checkpoint = join(root, "operator");
    await writeFile(
      accountFile,
      "fixture@attempt-test.iam.gserviceaccount.com",
      { mode: 0o600 },
    );
    const config = [
      "--apply",
      "--bucket",
      "attempt-fixture",
      "--hub-account-file",
      accountFile,
    ];
    const reports: Record<string, any>[] = [];
    const io = {
      relay,
      report: (value: unknown) => reports.push(value as Record<string, any>),
    };
    if (canonicalSubtrees) {
      const {verifyCanonicalSubtreeJourney}=await import("./canonical-result-history-fixture");
      await verifyCanonicalSubtreeJourney(db,id,String(input.executionId),original,fixture.namespace,config,io,objects,root,canonicalSubtrees);
      return;
    }
    if (independentAttempt) {
      const siblingSource = await readStoredAttemptEvidenceText(db, independentAttempt);
      const interrupted: AttemptRelay = {...relay, async api(request) {
        const checked = await relay.api(request);
        if (request.forceArchive === false) throw new HistoryOperationError("deploy", "deployment_busy", true);
        return checked;
      }};
      await expect(hzAttemptStorage(["migrate", ...config, "--include-retained", "--id", id],
        { ...io, relay: interrupted })).rejects.toMatchObject({ category: "deployment_busy" });
      const [pending] = await relay.worker({operation:"pending",attemptId:id});
      expect(pending.id).toBe(id);
      const firstPage = await relay.worker({ operation:"page",retained:true,
        after:"00000000-0000-0000-0000-000000000000",high:"ffffffff-ffff-ffff-ffff-ffffffffffff",limit:64 });
      const readyIds: string[] = firstPage.filter((r: {archive:string|null;limiter:string|null}) =>
        r.archive === null && r.limiter === null).map((r:{id:string}) => r.id);
      expect(readyIds).toContain(independentAttempt);
      expect(readyIds).not.toContain(id);
      const otherClient = createClient({max:1});
      let takeLock!: () => void, locked!: () => void, release!: () => void;
      const requested = new Promise<void>(resolve => { takeLock = resolve; });
      const acquired = new Promise<void>(resolve => { locked = resolve; });
      const keepLock = new Promise<void>(resolve => { release = resolve; });
      const hold = requested.then(() => otherClient.db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM ${sql.identifier(fixture.namespace)}.result_attempts WHERE id=${id}::uuid FOR SHARE`);
        locked();
        await keepLock;
      }));
      const controller = new AbortController();
      const messages: Array<Record<string, any>> = [];
      let busy = 0;
      const contended: AttemptRelay = {...relay, async worker(request,write) {
        try {
          if (request.operation === "confirm" && request.attemptId === id) {
            takeLock();
            await Promise.race([acquired,hold]);
          }
          return await relay.worker(request,write);
        } catch(error) {
          const wire = hzAttemptRpcFailure("attempt_"+request.operation,error);
          if (request.operation === "confirm" && request.attemptId === id && wire.operation === "attempt_confirm_lock_timeout" && wire.retryable) {
            busy++;
            throw new HistoryOperationError(wire.operation,"database_busy",true);
          }
          if (wire.retryable) throw new Error("Unexpected contention in fixture at "+wire.operation, {cause:error});
          throw error;
        }
      }};
      try {
        await hzAttemptStorage(["watch",...config,"--include-retained","--directory",checkpoint,"--limit","2"], {
          relay:contended,signal:controller.signal,report(value) {
            const message = value as Record<string, any>;
            messages.push(message);
            if (message.complete && message.activeCustody) controller.abort();
          },
        });
        expect(busy).toBe(3);
        expect(messages.some(m=>m.pendingReadback===id && m.event===pending.event)).toBe(true);
        expect(messages.at(-1)).toMatchObject({complete:true,activeCustody:{pending:1,confirmed:readyIds.length}});
        const confirmed = await db.execute(sql`SELECT result_attempt_id FROM attempt_evidence_storage_events
          WHERE completed AND app_readback_at IS NOT NULL AND action='shorten' ORDER BY result_attempt_id`);
        expect(confirmed.map(r=>r.result_attempt_id)).toEqual([...readyIds].sort());
        const [sibling] = await db.execute(sql`SELECT e.app_readback_at FROM result_attempts a JOIN attempt_evidence_storage_events e
          ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id WHERE a.id=${independentAttempt}::uuid`);
        expect(sibling.app_readback_at).toBeTruthy();
        expect(await readStoredAttemptEvidenceText(db, independentAttempt)).toBe(siblingSource);
        expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
      } finally {
        takeLock();
        release();
        await hold;
        await otherClient.sql.end({timeout:1});
      }
      await hzAttemptStorage(["migrate",...config,"--include-retained","--directory",checkpoint,"--until-complete"],io);
      expect(reports.at(-1)?.activeCustody).toMatchObject({pending:0,confirmed:readyIds.length+1});
      const [same] = await db.execute(sql`SELECT evidence_storage_event_id event FROM result_attempts WHERE id=${id}::uuid`);
      expect(same.event).toBe(pending.event);
      return;
    }
    async function shortProofPolicy(enable: boolean, tiny = false, pin = id) {
      const uri = new URL(databaseUrl());
      uri.searchParams.set("options", `-c search_path=${fixture.namespace},public`);
      const previous = process.env.DATABASE_URL;
      const printed = vi.spyOn(process.stdout,"write").mockReturnValue(true);
      try {
        process.env.DATABASE_URL = uri.toString();
        const name = tiny ? "tiny-histories" : "short-proofs";
        await attemptEvidenceStorageMain(enable ? ["enable-"+name,"--id",pin] : ["disable-"+name]);
        expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toMatchObject(tiny ? {
          hzWorkerOnly:true,tinyHistoriesEnabled:enable,tinyHistoryCanaryAttemptId:enable ? pin : null,
        } : {hzWorkerOnly:true,shortProofsEnabled:enable,shortProofCanaryAttemptId:enable ? pin : null});
      } finally {
        printed.mockRestore();
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
      }
    }
    if (tinyDelivery) {
      // A complete signed terminal source with an independent 0207 original.
      // Its genuine delivery failure, where present, must survive storage.
      await db.execute(sql`UPDATE progressive_worker_reports SET report=${fullReport}::jsonb,
        archived_at=NULL,archive_bundle_id=NULL,result_payload_hash=NULL,stopped_engine_job_id=${input.executionId}
        WHERE sim_job_id=${input.executionId}::uuid AND sequence=${input.points[0]!.sequence}`);
      const {packHzAttemptSource} = await import("../src/hz-attempt-custody");
      const {loadSettledAttemptEvidenceCopy} = await import("@aerodb/db/attempt-evidence-storage");
      const packed = await packHzAttemptSource(await loadSettledAttemptEvidenceCopy(db,id));
      const binding = await relay.worker({operation:"bound"});
      const fresh = await relay.hub({operation:"put",instance,solver:binding.solver,...packed});
      const staged = await relay.worker({operation:"stage",...fresh,enable:true,retained:true,settled:true,
        requireTransfers:true,owner:{instance,solver:binding.solver}},true);
      const failure = async () => (await db.execute(sql`SELECT to_jsonb(f) AS row FROM progressive_worker_delivery_failures f WHERE f.result_attempt_id=${id}::uuid`))[0]?.row;
      const prior = await failure();
      const candidate = () => relay.worker({operation:"one",settled:true,retained:true,attemptId:id});
      expect((await candidate()).limiter).not.toBeNull();
      await shortProofPolicy(true,true,"00000001-0000-4000-8000-000000000001");
      expect((await candidate()).limiter).not.toBeNull();
      await shortProofPolicy(true,true);
      expect((await candidate()).limiter).toBeNull();
      if (tinyDelivery === "failed") {
        await db.execute(sql`UPDATE progressive_worker_delivery_failures SET state='retry' WHERE result_attempt_id=${id}::uuid`);
        expect((await candidate()).limiter).not.toBeNull();
        await db.execute(sql`UPDATE progressive_worker_delivery_failures SET state='conflict' WHERE result_attempt_id=${id}::uuid`);
      }
      await db.execute(sql`UPDATE sim_jobs SET ingest_lease_token=gen_random_uuid(),
        ingest_lease_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=${input.executionId}::uuid`);
      expect((await candidate()).limiter).not.toBeNull();
      await db.execute(sql`UPDATE sim_jobs SET ingest_lease_token=NULL,ingest_lease_expires_at=NULL WHERE id=${input.executionId}::uuid`);
      const page=await relay.worker({operation:"page",settled:true,retained:true,
        after:"00000000-0000-0000-0000-000000000000",high:"ffffffff-ffff-ffff-ffff-ffffffffffff",limit:64});
      expect(page.find((row: {id:string})=>row.id===id)).toMatchObject({limiter:null});
      if (tinyDelivery === "failed") {
        const interrupted: AttemptRelay = {...relay, async api(request) {
          const actual = await relay.api(request);
          if (request.forceArchive === false) throw Error("Failed tiny working readback");
          return actual;
        }};
        await expect(hzAttemptStorage(["migrate",...config,"--id",id,"--include-settled-receipts"],
          {...io,relay:interrupted})).rejects.toThrow("Failed tiny working readback");
        const [restored] = await db.execute(sql`SELECT evidence_archive_id pointer,
          evidence_payload::text source FROM result_attempts WHERE id=${id}::uuid`);
        expect(restored).toMatchObject({pointer:null,source:original});
        expect(await failure()).toEqual(prior);
      }
      let issued: AttemptEvidenceFreshVerification | undefined;
      const recorded: AttemptRelay = {...relay, worker(request,write) {
        if (request.operation==="commit") issued=request.proof as AttemptEvidenceFreshVerification;
        return relay.worker(request,write);
      }};
      await hzAttemptStorage(["migrate",...config,"--id",id,"--include-settled-receipts"],{...io,relay:recorded});
      expect(issued).toBeDefined();
      const proof=await assertShortProof(db,id,staged.id,issued,true);
      expect(proof.generation).toBe(fresh.identity.generation);
      expect(objects.size).toBe(1);
      expect(await readStoredAttemptEvidenceText(db,id)).toBe(original);
      expect(await readStoredAttemptEvidenceText(db,id,{source:"worker-report"})).toBe(original);
      expect(await failure()).toEqual(prior);
      let expectedDisposition = prior;
      if (tinyDelivery === "failed") {
        expect(prior).toMatchObject({state:"conflict",last_http_status:409});
        expect((await db.execute(sql`SELECT 1 FROM progressive_worker_hub_receipts WHERE result_attempt_id=${id}::uuid`))).toHaveLength(0);
        expect(await relay.worker({operation:"replay",attemptId:id})).toMatchObject({replayDisposition:"would_requeue"});
        // A legitimate subsequent replay may change the failure row. The sealed
        // source, normal read and scientific classification survive that action.
        const recovered = await replayProgressiveWorkerOutbox(db,input,{apply:true});
        expect(recovered.points.find(p=>p.resultAttemptId===id)?.outcome).toBe("requeued");
        expectedDisposition = await failure();
        expect(expectedDisposition).toMatchObject({state:"retry"});
        expect(await readStoredAttemptEvidenceText(db,id,{source:"worker-report"})).toBe(original);
        expect(await db.execute(sql`SELECT 1 FROM progressive_worker_hub_receipts WHERE result_attempt_id=${id}::uuid`)).toHaveLength(0);
      }
      await shortProofPolicy(false,true);
      expect(await readStoredAttemptEvidenceText(db,id)).toBe(original);
      await hzAttemptStorage(["restore",...config,"--id",id],io);
      expect(await readStoredAttemptEvidenceText(db,id)).toBe(original);
      expect(await failure()).toEqual(expectedDisposition);
      return;
    }
    async function verifySettledPoint() {
      // A normal running report delivered the point. Its assignment stopped at
      // a later sequence. Both signed reports are still inline on this worker.
      const stopped: ProgressiveRemoteReport = JSON.parse(fullReport);
      const earlier = {
        ...stopped, status: { ...stopped.status, state: "running" },
        result: { ...stopped.result!, state: "running" }, stopProof: null,
      };
      const final = { ...stopped, sequence: stopped.sequence + 1 };
      const firstSha = analysisContentHash(earlier);
      await db.execute(sql`INSERT INTO progressive_worker_reports
        (sim_job_id,sequence,report,content_signature,assignment_signature,stopped_engine_job_id,acknowledged_at)
        SELECT sim_job_id,${final.sequence},${JSON.stringify(final)}::jsonb,${analysisContentHash(final)},
          assignment_signature,stopped_engine_job_id,acknowledged_at FROM progressive_worker_reports
        WHERE sim_job_id=${input.executionId}::uuid AND sequence=${earlier.sequence}`);
      await db.execute(sql`UPDATE progressive_worker_reports SET report=${JSON.stringify(earlier)}::jsonb,
        content_signature=${firstSha},archived_at=NULL,archive_bundle_id=NULL,result_payload_hash=NULL,stopped_engine_job_id=NULL
        WHERE sim_job_id=${input.executionId}::uuid AND sequence=${earlier.sequence}`);
      await db.execute(sql`UPDATE progressive_worker_evidence_receipts SET content_signature=${firstSha}
        WHERE sim_job_id=${input.executionId}::uuid AND sequence=${earlier.sequence}`);
      if (!periodic) await db.execute(sql`UPDATE results SET current_result_attempt_id=${id}::uuid WHERE id=(SELECT result_id FROM result_attempts WHERE id=${id}::uuid)`);
      expect((await relay.worker({ operation: "one", retained: true, attemptId: id })).limiter).not.toBeNull();
      const candidate = () => relay.worker({ operation: "one", settled: true, retained: true, attemptId: id });
      if (periodic && !shortProofJourney) {
        const message = "x".repeat(32 * 1024 * 1024);
        const large = { ...final, result: { ...final.result!, message } };
        const largeSignature = analysisContentHash(large);
        await db.execute(sql`UPDATE progressive_worker_reports SET report=${JSON.stringify(large)}::jsonb,
          content_signature=${largeSignature} WHERE sim_job_id=${input.executionId}::uuid AND sequence=${final.sequence}`);
        const checkLimit = async () => {
          expect((await candidate()).limiter).toBe(SETTLED_REPORT_SIZE_LIMIT);
          const page = await relay.worker({ operation: "page", settled: true, retained: true,
            after: "00000000-0000-0000-0000-000000000000", high: "ffffffff-ffff-ffff-ffff-ffffffffffff", limit: 64 });
          expect(page.find((r: { id: string }) => r.id === id)?.limiter).toBe(SETTLED_REPORT_SIZE_LIMIT);
          await hzAttemptStorage(["migrate", ...config, "--id", id, "--include-settled-receipts"], io);
          expect(reports.at(-1)).toEqual({ limited: SETTLED_REPORT_SIZE_LIMIT });
          expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
        };
        await checkLimit();
        await db.execute(sql`CREATE TABLE ${sql.identifier(fixture.namespace)}.progressive_report_result_payloads
          AS SELECT * FROM public.progressive_report_result_payloads WITH NO DATA`);
        await db.execute(sql`WITH src AS MATERIALIZED (SELECT report->'result' AS body FROM progressive_worker_reports
          WHERE sim_job_id=${input.executionId}::uuid AND sequence=${final.sequence}), inserted AS (
            INSERT INTO progressive_report_result_payloads(content_hash,result,byte_size)
            SELECT encode(sha256(convert_to(body::text,'UTF8')),'hex'),body,octet_length(body::text) FROM src RETURNING content_hash)
          UPDATE progressive_worker_reports r SET report=r.report-'result',result_payload_hash=inserted.content_hash
          FROM inserted WHERE r.sim_job_id=${input.executionId}::uuid AND r.sequence=${final.sequence}`);
        await checkLimit();
        await hzAttemptStorage(["migrate", ...config, "--include-settled-receipts", "--until-complete",
          "--directory", join(root, "oversize-cursor")], io);
        const checkpoint = reports.at(-1)?.checkpoint;
        expect(reports.at(-1)).toMatchObject({ complete: true, checkpoint: { reportSizeHeld: 1, verified: 0 } });
        expect(String(checkpoint?.after) >= id).toBe(true);
        await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL WHERE sim_job_id=${input.executionId}::uuid AND sequence=${final.sequence}`);
        const unacknowledged = await candidate();
        expect(unacknowledged.limiter).not.toBeNull();
        expect(unacknowledged.limiter).not.toBe(SETTLED_REPORT_SIZE_LIMIT);
        await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp(),report=${JSON.stringify(final)}::jsonb,
          result_payload_hash=NULL,content_signature=${analysisContentHash(final)} WHERE sim_job_id=${input.executionId}::uuid AND sequence=${final.sequence}`);
      }
      await db.execute(sql`INSERT INTO result_media_repairs(id,result_id,result_attempt_id,state)
        SELECT gen_random_uuid(),result_id,id,'blocked' FROM result_attempts WHERE id=${id}::uuid`);
      expect((await candidate()).limiter).toBeNull();
      await db.execute(sql`UPDATE result_media_repairs SET state='running',claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE result_attempt_id=${id}::uuid`);
      expect((await candidate()).limiter).not.toBeNull();
      await db.execute(sql`UPDATE result_media_repairs SET state='blocked',claim_expires_at=NULL WHERE result_attempt_id=${id}::uuid`);
      await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL WHERE sim_job_id=${input.executionId}::uuid AND sequence=${final.sequence}`);
      expect((await candidate()).limiter).not.toBeNull();
      await db.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${input.executionId}::uuid AND sequence=${final.sequence}`);
      await db.execute(sql`UPDATE progressive_worker_hub_receipts SET receipt=jsonb_set(receipt,'{remoteResultAttemptId}',to_jsonb(gen_random_uuid())) WHERE result_attempt_id=${id}::uuid`);
      expect((await candidate()).limiter).not.toBeNull();
      await db.execute(sql`UPDATE progressive_worker_hub_receipts SET receipt=jsonb_set(receipt,'{remoteResultAttemptId}',to_jsonb(result_attempt_id)) WHERE result_attempt_id=${id}::uuid`);
      await expect(replayProgressiveWorkerOutbox(db, input)).rejects.toBeInstanceOf(ProgressiveWorkerReplayNeedsFinalReport);
      let exactProof: AttemptEvidenceFreshVerification | undefined;
      const measuredRelay: AttemptRelay = { ...relay, async worker(request, write) {
        if (request.operation === "commit" && !exactProof) {
          exactProof = request.proof as AttemptEvidenceFreshVerification;
          const archiveId = String(request.archiveId);
          const floor = await measuredFixtureFloor(db,id,archiveId,exactProof);
          await db.execute(sql`UPDATE attempt_evidence_storage_policy SET min_net_value_bytes=${floor} WHERE id=1`);
          expect(await relay.worker(request,write)).toMatchObject({limited:"insufficient-net-savings"});
          await shortProofPolicy(true);
        }
        return relay.worker(request,write);
      }};
      await hzAttemptStorage(["migrate", ...config, "--id", id, "--include-settled-receipts"],
        shortProofJourney ? { ...io,relay:measuredRelay } : io);
      if (shortProofJourney) {
        expect(exactProof).toBeDefined();
        await assertShortProof(db,id,exactProof!.direct.archiveId,exactProof);
        await shortProofPolicy(false);
        // Disabling future writes must leave a stable read and replay available.
        await hzAttemptStorage(["migrate", ...config, "--id", id, "--include-settled-receipts"],io);
        expect(reports.at(-1)).toMatchObject({alreadyShortened:true,netValueBytesReclaimed:0});
      }
      const [confirmed] = await db.execute(sql`SELECT r.current_result_attempt_id,a.status,a.source,
        e.app_readback_at,e.verification->'dependencies' AS deps FROM result_attempts a JOIN results r ON r.id=a.result_id
        JOIN ${shortProofJourney ? sql`attempt_evidence_read_events` : sql`attempt_evidence_storage_events`} e ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id WHERE a.id=${id}::uuid`);
      expect(confirmed).toMatchObject({ current_result_attempt_id: periodic ? null : id, status: periodic ? "failed" : "done", source: periodic ? "queued" : "solved",
        deps: { verifier: "server-consumers/hz-settled-receipt-v3",
          workerScope: { sequence: earlier.sequence, stopSequence: final.sequence, report: firstSha, stopReport: analysisContentHash(final) } } });
      expect(confirmed.app_readback_at).toBeTruthy();
      const [media] = await db.execute(sql`SELECT m.state,a.evidence_payload->>'fidelity' AS fidelity
        FROM result_media_repairs m JOIN result_attempts a ON a.id=m.result_attempt_id WHERE a.id=${id}::uuid`);
      expect(media).toMatchObject({state: "blocked", fidelity: JSON.parse(original).fidelity ?? null});
      expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
      expect(await readStoredAttemptEvidenceText(db, id, {source: "worker-report"})).toBe(original);
      await expect(replayProgressiveWorkerOutbox(db, input, {apply: true})).rejects.toBeInstanceOf(ProgressiveWorkerReplayNeedsFinalReport);
      await hzAttemptStorage(["restore", ...config, "--id", id], io);
      expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
    }
    if (periodic) {
      // A finished assigned job may contain rejected individual points. The
      // signed original and measured stop establish custody for a closed promise.
      await db.execute(
        sql`UPDATE sim_jobs SET status='done',engine_state='completed' WHERE id=${input.executionId}::uuid`,
      );
      await db.execute(
        sql`UPDATE sync_sweep_promises SET status='fulfilled' WHERE id::text=(SELECT request_payload->>'syncPromiseId' FROM sim_jobs WHERE id=${input.executionId}::uuid)`,
      );
      await db.execute(
        sql`UPDATE progressive_worker_hub_receipts SET receipt=receipt||'{"storageOnly":false}'::jsonb WHERE result_attempt_id=${id}::uuid`,
      );
      if (shortProofJourney) {
        // A later signed stop needs the actual worker original in the 0207
        // catalog. Stage it through the custody relay while the row is warm.
        const binding = await relay.worker({operation:"bound"});
        const owner = {instance:binding.instance,solver:binding.solver};
        const prepared = await relay.worker({operation:"prepare",attemptId:id,retained:true,requireTransfers:true,owner});
        const fresh = prepared.archive
          ? await relay.hub({operation:"read",identity:prepared.archive})
          : await relay.hub({operation:"put",instance:prepared.instance,solver:prepared.solver,proof:prepared.proof,packed:prepared.packed});
        await relay.worker({operation:"stage",...fresh,enable:true,retained:true,requireTransfers:true,owner},true);
        await verifySettledPoint();
        return;
      }
      expect(
        (await relay.worker({ operation: "one", attemptId: id })).limiter,
      ).not.toBeNull();
      expect(
        (
          await relay.worker({
            operation: "one",
            attemptId: id,
            retained: true,
          })
        ).limiter,
      ).toBeNull();
      await hzAttemptStorage(
        ["migrate", ...config, "--id", id, "--include-retained"],
        io,
      );
      const [point] =
        await db.execute(sql`SELECT a.regime,a.status,a.source,a.evidence_payload->'urans_cycle_certificate' AS cycles,
        a.evidence_payload#>'{force_history,t}' AS samples,a.evidence_payload#>'{frame_track,frames}' AS frames,
        a.evidence_archive_id AS archive,e.app_readback_at,e.verification->'dependencies' AS deps
        FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id WHERE a.id=${id}::uuid`);
      expect(point).toMatchObject({
        regime: "urans",
        status: "failed",
        source: "queued",
        cycles: JSON.parse(original).urans_cycle_certificate,
        samples: null,
        frames: null,
        deps: {
          verifier: "server-consumers/hz-retained-original-v2",
          scientificEquivalent: true,
          workerScope: { storageOnly: false },
        },
      });
      expect(point.app_readback_at).toBeTruthy();
      expect(
        await readOriginalAttemptForProjection(db, id, String(point.archive)),
      ).toBe(original);
      expect(
        await readStoredAttemptEvidenceText(db, id, {
          source: "worker-report",
        }),
      ).toBe(original);
      await hzAttemptStorage(
        ["migrate", ...config, "--id", id, "--include-retained"],
        io,
      );
      expect(reports.at(-1)).toMatchObject({
        alreadyShortened: true,
        payloadBytesReclaimed: 0,
        netValueBytesReclaimed: 0,
      });
      await hzAttemptStorage(["restore", ...config, "--id", id], io);
      expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
      await verifySettledPoint();
      return;
    }
    await hzAttemptStorage(["plan", "--until-complete", "--limit", "1"], io);
    expect(reports.at(-1)?.checkpoint.eligible).toBe(1);
    const wrongRelay: AttemptRelay = {
      ...relay,
      hub: async (r) => {
        const proof = await relay.hub(r);
        return {
          ...proof,
          identity: { ...proof.identity, attemptId: crypto.randomUUID() },
        };
      },
    };
    await expect(migrateHzAttempt(wrongRelay, id, instance)).rejects.toThrow(
      "Unexpected GCS attempt owner",
    );
    expect(
      await db.execute(sql`SELECT id FROM attempt_evidence_archives`),
    ).toHaveLength(0);
    const scope = await relay.worker({ operation: "one", attemptId: id });
    expect(scope.limiter).toBeNull();
    const [before] = await db.execute(
      sql`SELECT result_id::text AS result,sim_job_id::text AS job,evidence_payload::text AS payload FROM result_attempts WHERE id=${id}::uuid`,
    );
    expect(before.payload).toBe(original);
    await db.execute(sql`INSERT INTO result_interpretations(id,result_id,result_attempt_id,reducer_version_id,source,input_evidence_signature,state,regime,selected_window,statistics,diagnostics,cl,cd,cm)
      SELECT gen_random_uuid(),result_id,id,gen_random_uuid(),'engine_reported',encode(sha256(convert_to(evidence_payload::text,'UTF8')),'hex'),
        'legacy_uncertified','legacy_engine_reported','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,cl,cd,cm FROM result_attempts WHERE id=${id}::uuid`);
    const interpretations = () =>
      db.execute(
        sql`SELECT to_jsonb(i)::text AS row FROM result_interpretations i WHERE i.result_attempt_id=${id}::uuid`,
      );
    const initialInterpretation = await interpretations();

    const paused = {
      operation: "worker_transfer_paused",
      category: "transfer_paused",
      retryable: true,
    };
    const setPaused = (value: boolean) =>
      db.execute(
        sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=${value} WHERE id=1`,
      );
    await setPaused(true);
    try {
      await expect(
        relay.worker({ operation: "replay", attemptId: id }),
      ).rejects.toMatchObject(paused);
      const [row] = await db.execute(
        sql`SELECT evidence_archive_id,evidence_storage_event_id,evidence_payload::text AS original FROM result_attempts WHERE id=${id}::uuid`,
      );
      expect(row).toMatchObject({
        evidence_archive_id: null,
        evidence_storage_event_id: null,
        original,
      });
    } finally {
      await setPaused(false);
    }
    // A pre-fence worker reports the same sanitized replay error for two
    // different causes. Only a current flag on the pinned worker permits a wait.
    let fenceOnReplay = true;
    const oldWorker: AttemptRelay = {
      ...relay,
      worker: async (r, write) => {
        if (r.operation === "bound")
          return {
            ...(await relay.worker(r)),
            transfer_fence_protocol: undefined,
          };
        if (r.operation === "replay") {
          if (fenceOnReplay) await setPaused(true);
          throw new HistoryOperationError("attempt_replay", "integrity");
        }
        return relay.worker(r, write);
      },
    };
    const legacyIo = {
      ...io,
      relay: oldWorker,
      checkLegacyFence: (
        _host: string,
        _container: string,
        expected: { instance: string; solver: string },
      ) => checkHzTransferFence(db, expected),
    };
    try {
      await expect(
        hzAttemptStorage(["migrate", ...config, "--id", id], legacyIo),
      ).rejects.toMatchObject(paused);
    } finally {
      await setPaused(false);
    }
    fenceOnReplay = false;
    await expect(
      hzAttemptStorage(["migrate", ...config, "--id", id], legacyIo),
    ).rejects.toMatchObject({
      operation: "attempt_replay",
      category: "integrity",
      retryable: false,
    });
    expect(await relay.worker({ operation: "pending" })).toHaveLength(0);
    expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
    // A real transfer fence after SQL COMMIT must leave the same readback event pending.
    const interruptedRelay = {
      ...relay,
      api: async (r: Record<string, unknown>) => {
        const result = await relay.api(r);
        if (r.forceArchive === false) await setPaused(true);
        return result;
      },
    };
    try {
      await expect(
        migrateHzAttempt(interruptedRelay, id, instance),
      ).rejects.toMatchObject(paused);
    } finally {
      await setPaused(false);
    }
    const [cold] =
      await db.execute(sql`SELECT a.evidence_archive_id::text AS archive,a.evidence_payload#>'{steady_history,cl}' AS online,ar.source_instance,ar.object_key,e.net_value_bytes_saved AS net,e.app_readback_at FROM result_attempts a
    JOIN attempt_evidence_archives ar ON ar.id=a.evidence_archive_id AND ar.result_attempt_id=a.id JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id WHERE a.id=${id}::uuid`);
    expect(cold.online).toBeNull();
    expect(cold.app_readback_at).toBeNull();
    expect(Number(cold.net)).toBeGreaterThan(0);
    expect(cold.source_instance).toBe(instance);
    expect(cold.object_key).toContain("/" + id + "/");
    expect(objects.size).toBe(1);
    await hzAttemptStorage(
      [
        "migrate",
        ...config,
        "--directory",
        checkpoint,
        "--limit",
        "1",
        "--until-complete",
      ],
      io,
    );
    expect(reports.at(-1)?.activeCustody.confirmed).toBe(1);
    expect(Number(reports.at(-1)?.activeCustody.netValueBytesReclaimed)).toBe(
      Number(cold.net),
    );
    const again = await migrateHzAttempt(relay, id, instance);
    expect(again.alreadyShortened).toBe(true);
    expect(again.netValueBytesReclaimed).toBe(0);
    expect(again.archiveId).toBe(cold.archive);
    expect(objects.size).toBe(1);
    expect(await relay.worker({ operation: "pending" })).toHaveLength(0);
    expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
    expect(
      await readStoredAttemptEvidenceText(db, id, { source: "worker-report" }),
    ).toBe(original);
    expect(
      await readOriginalAttemptForProjection(db, id, String(cold.archive)),
    ).toBe(original);
    const catalog = await getAttemptEvidenceArchive(db, String(cold.archive));
    const hubRead = {operation:"read", identity:catalog, bucket:catalog.bucket, account};
    await expect(attemptHubOperation(hubRead)).rejects.toThrow("Unexpected hub role or bucket");
    const priorRole = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    const priorBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
    const previousFetch = globalThis.fetch;
    try {
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = catalog.bucket;
      globalThis.fetch = request;
      const restored = await attemptHubOperation(hubRead);
      const exact = await store.read(catalog);
      expect(restored.identity.generation).toBe(catalog.generation);
      expect(restored.packed).toBe(exact.packed);
      await expect(attemptHubOperation({...hubRead,identity:{...catalog,generation:"8"}})).rejects.toThrow();
    } finally {
      globalThis.fetch = previousFetch;
      if (priorRole === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
      else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = priorRole;
      if (priorBucket === undefined) delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
      else process.env.AIRFOILFOAM_EVIDENCE_BUCKET = priorBucket;
    }
    await expect(
      readHzAttemptWorkingCopy({ ...catalog, generation: "8" }),
    ).rejects.toThrow("unavailable");
    expect(await interpretations()).toEqual(initialInterpretation);
    const [pin] = [...(await loadAttemptSourcePins(db, [id])).values()];
    const prepared = await prepareAttemptSources(
      db,
      sweeperAttemptArchiveReader(),
      [pin!],
    );
    expect(prepared.get(id)?.payloadText).toBe(original);
    const documents = await preparePublicationHistories(
      db,
      sql`a.id=${id}::uuid`,
    );
    const [published] =
      await db.execute(sql`SELECT (${publicationHistoryPayload(sql`a`)})::text AS original FROM result_attempts a
       ${publicationHistoryJoin(sql`a`, documents)} WHERE a.id=${id}::uuid`);
    expect(published.original).toBe(original);
    expect(
      await db.execute(
        sql`SELECT sim_job_id FROM progressive_remote_dispatches`,
      ),
    ).toHaveLength(0);
    const hydrated = await readSweeperAttemptEvidence(db, {
      id,
      resultId: String(before.result),
      simJobId: String(before.job),
      evidenceArchiveId: String(cold.archive),
      evidencePayload: null,
    });
    expect(hydrated.evidencePayload).toEqual(JSON.parse(original));
    expect(
      (await relay.worker({ operation: "replay", attemptId: id }))
        .alreadyDelivered,
    ).toBe(true);
    await hzAttemptStorage(["restore", ...config, "--id", id], io);
    expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
    const [warm] = await db.execute(
      sql`SELECT evidence_archive_id FROM result_attempts WHERE id=${id}::uuid`,
    );
    expect(warm.evidence_archive_id).toBeNull();
    const stop = new AbortController();
    await hzAttemptStorage(
      ["watch", ...config, "--directory", join(root, "watch"), "--limit", "1"],
      {
        relay,
        signal: stop.signal,
        report: (value) => {
          if ((value as { activeCustody?: unknown }).activeCustody)
            stop.abort();
        },
      },
    );
    await hzAttemptStorage(["status"], io);
    expect(reports.at(-1)?.confirmed).toBe(1);
    const copySeen: number[] = [];
    const held = new AbortController();
    await hzAttemptStorage(
      [
        "watch",
        ...config,
        "--directory",
        join(root, "combined"),
        "--originals-directory",
        join(root, "originals"),
      ],
      {
        relay,
        signal: held.signal,
        report: (value) => {
          if ((value as { activeCustody?: unknown }).activeCustody)
            held.abort();
        },
        originalCycle: async (options, seconds) => {
          expect(options.hzHost).toBe("hz-solver2");
          expect(options.directory).toBe(join(root, "originals"));
          copySeen.push(seconds);
        },
      },
    );
    expect(copySeen[0]).toBe(15);
    // A permanent failed normal API probe after commit restores the exact SQL source.
    await migrateHzAttempt(relay, id, instance, true);
    const broken = {
      ...relay,
      api: async (r: Record<string, unknown>) => {
        if (r.forceArchive === false) throw Error("failed product probe");
        return relay.api(r);
      },
    };
    await expect(migrateHzAttempt(broken, id, instance)).rejects.toThrow(
      "failed product probe",
    );
    expect(
      (
        await db.execute(
          sql`SELECT evidence_archive_id,evidence_payload::text AS body FROM result_attempts WHERE id=${id}::uuid`,
        )
      )[0],
    ).toMatchObject({ evidence_archive_id: null, body: original });

    // Turn the same genuine point acknowledgment into the ordinary fixture
    // class. The existing 0212 route remains restricted until explicit opt-in.
    await db.execute(
      sql`UPDATE progressive_worker_hub_receipts SET receipt=receipt||'{"storageOnly":false}'::jsonb WHERE result_attempt_id=${id}::uuid`,
    );
    expect(
      (await relay.worker({ operation: "one", attemptId: id })).limiter,
    ).not.toBeNull();
    expect(
      (await relay.worker({ operation: "one", attemptId: id, retained: true }))
        .limiter,
    ).toBeNull();
    let interruptRetained = true;
    const releasePause = {
      ...relay,
      async api(r: Record<string, unknown>) {
        if (r.forceArchive === false && interruptRetained) {
          interruptRetained = false;
          throw new HistoryOperationError("deploy", "deployment_busy", true);
        }
        return relay.api(r);
      },
    };
    await expect(
      hzAttemptStorage(
        ["migrate", ...config, "--id", id, "--include-retained"],
        { ...io, relay: releasePause },
      ),
    ).rejects.toThrow("deployment_busy");
    await expect(
      db.execute(
        sql`UPDATE attempt_evidence_storage_events SET app_readback_at=clock_timestamp() WHERE id=(SELECT evidence_storage_event_id FROM result_attempts WHERE id=${id}::uuid)`,
      ),
    ).rejects.toThrow();
    await hzAttemptStorage(
      ["migrate", ...config, "--id", id, "--include-retained"],
      io,
    );
    const [extended] =
      await db.execute(sql`SELECT e.id,e.verification->'dependencies' AS deps,e.app_readback_at FROM result_attempts a
     JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id WHERE a.id=${id}::uuid AND a.evidence_archive_id=${String(cold.archive)}::uuid`);
    expect(extended.deps).toMatchObject({
      verifier: "server-consumers/hz-retained-original-v2",
      jobDecisionsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      workerScope: {
        storageOnly: false,
        attempt: id,
        selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(extended.app_readback_at).toBeTruthy();
    expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
    expect(await interpretations()).toEqual(initialInterpretation);
    await hzAttemptStorage(["restore", ...config, "--id", id], io);
    const changing = {
      ...relay,
      async worker(r: Record<string, unknown>, write?: boolean) {
        if (r.operation === "confirm")
          await db.execute(
            sql`UPDATE result_interpretations SET diagnostics='{"concurrent":true}'::jsonb WHERE result_attempt_id=${id}::uuid`,
          );
        return relay.worker(r, write);
      },
    };
    await expect(
      hzAttemptStorage(
        ["migrate", ...config, "--id", id, "--include-retained"],
        { relay: changing, report: io.report },
      ),
    ).rejects.toThrow(/selection|interpretation/);
    expect(
      (
        await db.execute(
          sql`SELECT evidence_archive_id,evidence_payload::text AS body FROM result_attempts WHERE id=${id}::uuid`,
        )
      )[0],
    ).toMatchObject({ evidence_archive_id: null, body: original });
    await verifyOriginalCopyJourney(db, id, objectStore(true).store);
    await verifySettledPoint();
  } finally {
    if (prior === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = prior;
    await fixture.close();
  }
}
