import { originalHubRequest } from "../src/hz-attempt-original-rpc";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DB } from "@aerodb/db/client";
import { expect } from "vitest";
import {
  originalBinding,
  originalHubObjects,
  inspectOriginals,
  registerOriginals,
  prepareOriginals,
  mapOriginals,
  type OriginalPin,
} from "../src/hz-attempt-originals";
import {
  copyFrozenOriginalVersion,
  uploadOriginalPage,
  registerOriginalPage,
  inventoryOriginalPage,
  type OriginalEndpoints,
} from "../src/hz-attempt-original-relay";
import {
  getAttemptEvidenceArchive,
  registerAttemptEvidenceArchive,
} from "@aerodb/db/attempt-evidence-catalog";
import {
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
} from "@aerodb/db/attempt-evidence-storage";
import { packHzAttemptSource } from "../src/hz-attempt-custody";
import { type HzAttemptHubStore } from "../src/hz-attempt-hub";

export async function verifyOriginalCopyJourney(
  db: DB,
  model: string,
  store: HzAttemptHubStore,
) {
  const id = randomUUID(),
    hubInstance = randomUUID();
  // A selected, failed URANS history without a dispatch, staged report or hub result.
  // Retain PG precision and test above the 0212 shortening transport bound.
  await db.execute(sql`INSERT INTO result_attempts SELECT v.* FROM result_attempts a CROSS JOIN LATERAL jsonb_populate_record(NULL::result_attempts,to_jsonb(a)||
 jsonb_build_object('id',${id}::text,'evidence_archive_id',null,'evidence_storage_event_id',null,'regime','urans','unsteady',true,'status','failed','source','queued',
 'evidence_payload',jsonb_build_object('wide',90071992547409931234.1200::numeric,'preserved',repeat('physical metadata ',22000),
 'force_history',jsonb_build_object('t',jsonb_build_array(0.0100::numeric,0.0200::numeric),'cl','[0.3,0.2]'::jsonb,'cd','[0.02,0.03]'::jsonb,'cm','[-0.1,-0.2]'::jsonb),'frame_track','{"frames":[{"t":0.1}]}'::jsonb))) v WHERE a.id=${model}::uuid`);
  await db.execute(
    sql`UPDATE results SET current_result_attempt_id=${id}::uuid WHERE id=(SELECT result_id FROM result_attempts WHERE id=${id}::uuid)`,
  );
  const original = await loadSettledAttemptEvidenceCopy(db, id);
  const binding = await originalBinding(db);
  const relay: OriginalEndpoints = {
    async worker(r) {
      if (r.operation === "inventory")
        return inspectOriginals(db, binding, r.selection as { ids: string[] });
      if (r.operation === "prepare")
        return prepareOriginals(
          db,
          binding,
          r.pins as OriginalPin[],
          Number(r.budget),
        );
      if (r.operation === "register")
        return registerOriginals(
          db,
          binding,
          r.items as Parameters<typeof registerOriginals>[2],
          Number(r.budget),
        );
      throw Error("Unexpected worker request");
    },
    async hub(r) {
      if (r.operation === "mapping")
        return mapOriginals(
          db,
          binding,
          r.rows as Parameters<typeof mapOriginals>[2],
        );
      return originalHubObjects(
        store,
        binding,
        r.items as Parameters<typeof originalHubObjects>[2],
        Number(r.budget),
      );
    },
  };
  // Production misestimated upstream-base-url selectivity and expanded every
  // worker job. Preserve keyed lateral boundaries before evaluating ownership.
  let lookupSql = "";
  const planned = {
    execute: (query: SQL) => {
      lookupSql = new PgDialect().sqlToQuery(query).sql;
      return db.execute(query);
    },
  } as unknown as DB;
  await inspectOriginals(planned, binding, { ids: [id] });
  expect(lookupSql).toContain("WITH native AS MATERIALIZED");
  expect(lookupSql).toMatch(/FROM sim_jobs j WHERE j.id=a.sim_job_id OFFSET 0/);
  expect(lookupSql).toMatch(/FROM sync_sweep_promises pr WHERE pr.id=CASE/);
  const [row] = await inventoryOriginalPage(relay, binding, { ids: [id] });
  expect(row?.match).toBeNull();
  expect(row?.owned).toBe(true);
  expect(row?.bytes).toBeGreaterThan(262144);
  const pin = row!,
    budget = 1024 * 1024;
  const packed = await packHzAttemptSource(original);
  // Equal UUIDs and equal original bytes across instances still have independently
  // authenticated source metadata. Never adopt this other owner's envelope.
  const other = await store.put(
    hubInstance,
    packed.proof,
    Buffer.from(packed.packed, "base64"),
  );
  const { readOriginalVersion } = await import(
    new URL("../src/hz-attempt-original-version-worker.mjs", import.meta.url)
      .href
  );
  const [job] = await db.execute(
    sql`SELECT status,"ingestedAt"::text AS ingested FROM sim_jobs WHERE id=${pin.job}::uuid`,
  );
  await db.execute(
    sql`UPDATE sim_jobs SET status='running',"ingestedAt"=NULL WHERE id=${pin.job}::uuid`,
  );
  const snapshot = (only: boolean) =>
    readOriginalVersion(db, binding, pin, only);
  try {
    expect(
      (await prepareOriginals(db, binding, [pin], budget)).deferred,
    ).toEqual([pin.id]);
    const first = await copyFrozenOriginalVersion(
      relay,
      binding,
      pin,
      snapshot,
    );
    expect(first.identity).toMatchObject({
      sourceInstance: binding.instance,
      attemptId: id,
      resultId: pin.result,
      simJobId: pin.job,
      sourceSha256: pin.sha,
      sourceByteSize: pin.bytes,
    });
    const second = await copyFrozenOriginalVersion(
      relay,
      binding,
      pin,
      snapshot,
      first.identity,
    );
    expect(second).toMatchObject({
      current: true,
      identity: {
        generation: first.identity!.generation,
        objectKey: first.identity!.objectKey,
      },
    });
    await expect(
      registerOriginalPage(
        relay,
        binding,
        [{ pin, identity: first.identity! }],
        budget,
      ),
    ).rejects.toThrow();
    expect(
      await db.execute(
        sql`SELECT id FROM attempt_evidence_archives WHERE result_attempt_id=${id}::uuid`,
      ),
    ).toHaveLength(0);
    const [present] = await db.execute(
      sql`SELECT evidence_archive_id AS pointer,evidence_storage_event_id AS event,evidence_payload::text AS body FROM result_attempts WHERE id=${id}::uuid`,
    );
    expect(present).toMatchObject({
      pointer: null,
      event: null,
      body: original.payloadText,
    });
    await db.execute(
      sql`UPDATE result_attempts SET evidence_payload=evidence_payload||'{"laterRevision":true}'::jsonb WHERE id=${id}::uuid`,
    );
    const changed = (await inspectOriginals(db, binding, { ids: [id] }))[0]!;
    expect(
      await copyFrozenOriginalVersion(relay, binding, pin, snapshot),
    ).toEqual({ changed: { sha: changed.sha, bytes: changed.bytes } });
    const retained = await copyFrozenOriginalVersion(
      relay,
      binding,
      pin,
      snapshot,
      first.identity,
    );
    expect(retained).toMatchObject({
      current: false,
      changed: { sha: changed.sha },
      identity: { sourceSha256: pin.sha },
    });
    const later = await copyFrozenOriginalVersion(
      relay,
      binding,
      changed,
      (only) => readOriginalVersion(db, binding, changed, only),
    );
    expect(later.identity!.objectKey).not.toBe(first.identity!.objectKey);
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true WHERE id=1`,
    );
    await expect(snapshot(true)).rejects.toMatchObject({
      operation: "worker_transfer_paused",
      retryable: true,
    });
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=false WHERE id=1`,
    );
    await db.execute(
      sql`UPDATE result_attempts SET engine_job_id='foreign-owner' WHERE id=${id}::uuid`,
    );
    await expect(
      readOriginalVersion(db, binding, changed, false),
    ).rejects.toThrow("owner");
  } finally {
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=false WHERE id=1`,
    );
    await db.execute(
      sql`UPDATE result_attempts SET evidence_payload=${original.payloadText}::jsonb,engine_job_id=${pin.job} WHERE id=${id}::uuid`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET status=${job.status},"ingestedAt"=${job.ingested}::timestamptz WHERE id=${pin.job}::uuid`,
    );
  }
  const upload = await uploadOriginalPage(relay, binding, [pin], budget);
  expect(upload.deferred).toEqual([]);
  expect(upload.uploads[0]?.identity.objectKey).not.toBe(
    other.identity.objectKey,
  );
  expect(upload.uploads[0]?.identity.sourceInstance).toBe(binding.instance);
  expect(
    await db.execute(
      sql`SELECT id FROM attempt_evidence_archives WHERE result_attempt_id=${id}::uuid`,
    ),
  ).toHaveLength(0);
  await expect(
    registerOriginalPage(
      relay,
      binding,
      [{ pin, identity: other.identity }],
      budget,
    ),
  ).rejects.toThrow(/Foreign/);
  await db.execute(
    sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true WHERE id=1`,
  );
  try {
    await expect(
      registerOriginalPage(relay, binding, upload.uploads, budget),
    ).rejects.toMatchObject({
      category: "transfer_paused",
      operation: "worker_transfer_paused",
      retryable: true,
    });
    expect(
      await db.execute(
        sql`SELECT id FROM attempt_evidence_archives WHERE result_attempt_id=${id}::uuid`,
      ),
    ).toHaveLength(0);
    expect((await loadSettledAttemptEvidenceCopy(db, id)).payloadText).toBe(
      original.payloadText,
    );
  } finally {
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=false WHERE id=1`,
    );
  }
  const receipt = await registerOriginalPage(
    relay,
    binding,
    upload.uploads,
    budget,
  );
  expect(receipt[0]?.created).toBe(true);
  expect(receipt[0]?.generation).toBe(upload.uploads[0]?.identity.generation);
  const replay = await registerOriginalPage(
    relay,
    binding,
    upload.uploads,
    budget,
  );
  expect(replay[0]).toEqual({ ...receipt[0], created: false });
  const ar = await getAttemptEvidenceArchive(db, receipt[0]!.archive);
  expect(ar.historySeries.length).toBe(5);
  expect((await loadSettledAttemptEvidenceCopy(db, id)).payloadText).toBe(
    original.payloadText,
  );
  const [state] = await db.execute(
    sql`SELECT a.evidence_archive_id,a.evidence_storage_event_id,r.current_result_attempt_id, a.status,a.regime FROM result_attempts a JOIN results r ON r.id=a.result_id WHERE a.id=${id}::uuid`,
  );
  expect(state).toMatchObject({
    evidence_archive_id: null,
    evidence_storage_event_id: null,
    current_result_attempt_id: id,
    status: "failed",
    regime: "urans",
  });
  const [saved] = await inventoryOriginalPage(relay, binding, { ids: [id] });
  expect(saved?.archive).toBe(ar.id);
  await expect(
    uploadOriginalPage(
      relay,
      binding,
      [{ ...pin, sha: "0".repeat(64) }],
      budget,
    ),
  ).rejects.toThrow("changed");
  await expect(uploadOriginalPage(relay, binding, [pin], 4096)).rejects.toThrow(
    "budget",
  );
  // An HZ UUID, a row in the local DB and a same-cell result cannot confer
  // producer ownership when the job's native execution does not agree.
  await db.execute(
    sql`UPDATE result_attempts SET engine_job_id='foreign-job' WHERE id=${id}::uuid`,
  );
  const [foreign] = await inventoryOriginalPage(relay, binding, { ids: [id] });
  expect(foreign?.owned).toBe(false);
  await expect(
    uploadOriginalPage(relay, binding, [pin], budget),
  ).rejects.toThrow("ownership");
  await expect(
    registerOriginalPage(relay, binding, upload.uploads, budget),
  ).rejects.toThrow(/own/);
  // Model two actual namespaces in the disposable DB. Equal attempt AND
  // result UUIDs still rank as an independent verified upstream receipt.
  const [local] = await inspectOriginals(db, binding, { ids: [model] });
  expect(local?.ack).toBeTruthy();
  const src = await loadSettledAttemptEvidenceCopy(db, model),
    encoded = await packHzAttemptSource(src);
  const upstream = await store.put(
    hubInstance,
    encoded.proof,
    Buffer.from(encoded.packed, "base64"),
  );
  const counterpart = await registerAttemptEvidenceArchive(
    db,
    upstream.identity,
    prepareAttemptEvidenceCopy(src),
  );
  const rollback = new Error("rollback independent hub registration fixture");
  const role = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  try {
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
    await db.transaction(async (raw) => {
      const tx = raw as unknown as DB;
      await tx.execute(
        sql`UPDATE sync_api_settings SET instance_id=${hubInstance}::uuid,remote_solver_enabled=false WHERE id=1`,
      );
      await tx.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,content_signature,envelope)
       SELECT j.id,(j.request_payload->>'syncPromiseId')::uuid,${binding.solver}::uuid,i.assignment_signature,j.request_payload->'remoteProgressiveExecution'
       FROM sim_jobs j JOIN progressive_worker_submission_intents i ON i.sim_job_id=j.id WHERE j.id=${local.job}::uuid`);
      await tx.execute(sql`INSERT INTO progressive_remote_evidence_receipts(sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_attempt_id,remote_result_id,storage_only)
       VALUES(${local.job}::uuid,${local.ack!.seq},${local.ack!.point},${model}::uuid,${model}::uuid,${local.result}::uuid,${local.ack!.storageOnly})`);
      const row = {
        ...local,
        ack: { ...local.ack!, hubAttempt: model, hubResult: src.resultId! },
      };
      const request = { operation: "mapping", binding, rows: [row] };
      expect(await originalHubRequest(tx, request)).toEqual([
        {
          id: model,
          hubInstance,
          hubAttempt: model,
          hubResult: src.resultId,
          hubArchive: counterpart.archive.id,
          generation: upstream.identity.generation,
        },
      ]);
      expect(
        await originalHubRequest(tx, {
          ...request,
          rows: [{ ...row, ack: { ...row.ack, hubResult: randomUUID() } }],
        }),
      ).toEqual([]);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  } finally {
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = role;
  }
  await promisify(execFile)("python3", [
    "-B",
    fileURLToPath(new URL("./hz-original-controller.py", import.meta.url)),
  ]);
}
