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
import type { DB } from "@aerodb/db/client";
import { sql, type SQL } from "drizzle-orm";
import { expect } from "vitest";
import { createSettlementFixture } from "./attempt-settlement-fixture";
import { HzAttemptHubStore } from "../src/hz-attempt-hub";
import { attemptWorkerOperation } from "../src/hz-attempt-custody-cli";
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
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";

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
    store: new HzAttemptHubStore(bucket, account, request, originalCopy),
  };
}

export async function verifyHzAttemptTransition(
  src: DB,
  id: string,
  input: ProgressiveWorkerOutboxReplayInput,
  original: string,
  root: string,
  periodic = false,
) {
  const fixture = await createSettlementFixture(true),
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
    const [r] = await db.execute(
      sql`SELECT instance_id::text AS instance FROM sync_api_settings`,
    );
    const instance = String(r.instance);
    const { store, objects } = objectStore();
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
      api: (request) =>
        hzAttemptApiProbe(
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
    if (periodic) {
      await db.execute(
        sql`UPDATE progressive_worker_hub_receipts SET receipt=receipt||'{"storageOnly":false}'::jsonb WHERE result_attempt_id=${id}::uuid`,
      );
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

    let interrupted = true;
    const interruptedRelay = {
      ...relay,
      api: async (r: Record<string, unknown>) => {
        if (r.forceArchive === false && interrupted) {
          interrupted = false;
          throw new HistoryOperationError("deploy", "deployment_busy", true);
        }
        return relay.api(r);
      },
    };
    await expect(
      migrateHzAttempt(interruptedRelay, id, instance),
    ).rejects.toThrow("deployment_busy");
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
    expect(await relay.worker({ operation: "pending" })).toHaveLength(0);
    expect(await readStoredAttemptEvidenceText(db, id)).toBe(original);
    expect(
      await readStoredAttemptEvidenceText(db, id, { source: "worker-report" }),
    ).toBe(original);
    expect(
      await readOriginalAttemptForProjection(db, id, String(cold.archive)),
    ).toBe(original);
    const catalog = await getAttemptEvidenceArchive(db, String(cold.archive));
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
  } finally {
    if (prior === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = prior;
    await fixture.close();
  }
}
