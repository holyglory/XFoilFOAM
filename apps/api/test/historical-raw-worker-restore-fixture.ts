import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { DB } from "@aerodb/db";
import { env } from "../src/env";
import { VolumeMediaStore } from "../src/media-store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closedProgressiveJob } from "../../sweeper/src/closed-progressive-retention";

export async function verifyHistoricalWorkerRestore(
  app: FastifyInstance,
  db: DB,
  job: string,
  slug: string,
  alpha: number,
  manifest: Buffer,
  bundle: Buffer,
  receipt: Record<string, any>,
) {
  const rollback = new Error("restore the isolated worker rows"),
    token = "isolated-physical-reader";
  const beforeProcessToken = process.env.ENGINE_CONTROL_PLANE_TOKEN;
  const beforeToken = env.engineControlPlaneToken,
    role = process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const directory = `cases/${slug}/a0/evidence`,
    base = "https://registered-history.invalid";
  const query = {
    report: String(receipt.report_signature),
    manifest: sha(manifest),
    stored: sha(bundle),
    directory,
  };
  const gateway = `/internal/historical-raw/${job}/1/${receipt.point_content_signature}/${receipt.generation}`;
  try {
    env.engineControlPlaneToken = token;
    process.env.ENGINE_CONTROL_PLANE_TOKEN = token;
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
    await db
      .transaction(async (tx) => {
        const cx = tx as unknown as DB;
        const [j] = await cx.execute(
          sql`SELECT airfoil_id,bc_ids,simulation_preset_revision_id FROM sim_jobs WHERE id=${job}::uuid`,
        );
        const localAttempt = randomUUID();
        await cx.execute(sql`INSERT INTO result_attempts(id,sim_job_id,airfoil_id,bc_id,simulation_preset_revision_id,engine_job_id,engine_case_slug,aoa_deg,status,evidence_payload)
        VALUES (${localAttempt}::uuid,${job}::uuid,${j.airfoil_id}::uuid,${(j.bc_ids as string[])[0]}::uuid,${j.simulation_preset_revision_id}::uuid,
          ${job},${slug},${alpha},'failed','{"failure_disposition":"hard_solver"}'::jsonb)`);
        await cx.execute(
          sql`UPDATE sim_jobs SET "ingestedAt"=clock_timestamp(),"finishedAt"=clock_timestamp()-interval '1 hour' WHERE id=${job}::uuid`,
        );
        await cx.execute(
          sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature) VALUES(${job}::uuid,1,${query.report})`,
        );
        await cx.execute(sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id,point_content_signature)
        VALUES(${job}::uuid,1,${localAttempt}::uuid,${receipt.point_content_signature})`);
        await cx.execute(sql`INSERT INTO progressive_worker_delivery_failures(sim_job_id,sequence,result_attempt_id,point_content_signature,state,attempt_count,last_http_status,last_error)
        VALUES(${job}::uuid,1,${localAttempt}::uuid,${receipt.point_content_signature},'conflict',1,409,'Progressive evidence delivery failed (409): progressive_scope_closed Obsolete or settled progressive CFD execution scope')`);
        const meta = {
          evidenceBase: "a0/evidence",
          uncompressedTarSha256: receipt.tar_sha256,
          uncompressedTarByteSize: receipt.tar_bytes,
          bundledFileCount: receipt.bundled_file_count,
          zstdLevel: receipt.zstd_level,
        };
        for (const [kind, name, data, mime] of [
          ["manifest", "evidence_manifest.json", manifest, "application/json"],
          [
            "engine_bundle",
            "engine_evidence.tar.zst",
            bundle,
            "application/zstd",
          ],
        ] as const)
          await cx.execute(sql`INSERT INTO solver_evidence_artifacts(sim_job_id,engine_job_id,engine_case_slug,result_attempt_id,airfoil_id,kind,storage_key,mime_type,sha256,byte_size,metadata)
          VALUES (${job}::uuid,${job},${slug},${localAttempt}::uuid,${j.airfoil_id}::uuid,${kind},
          ${"jobs/" + job + "/" + directory + "/" + name},${mime},${sha(data)},${data.length},${JSON.stringify(meta)}::jsonb)`);
        const local = (override: Partial<typeof query> = {}, bearer = token) =>
          app.inject({
            method: "GET",
            url: gateway,
            headers: { authorization: "Bearer " + bearer },
            query: { ...query, ...override },
          });
        let forced = false;
        let unforcedReads = 0;
        let generationReads = 0;
        let malformedAdmission: string | undefined;
        const proxy = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, init = {}) => {
            const u = new URL(String(input));
            const headers = new Headers(init.headers);
            if (u.pathname.startsWith("/jobs/")) {
              if (headers.has("x-historical-raw-preflight")) {
                expect(headers.get("authorization")).toBe("Bearer " + token);
                expect(
                  JSON.parse(
                    Buffer.from(
                      headers.get("x-historical-raw-preflight")!,
                      "base64",
                    ).toString(),
                  ).receipt.generation,
                ).toBe(receipt.generation);
                forced = true;
              } else {
                expect(headers.has("authorization")).toBe(false);
                unforcedReads++;
              }
              const result = await local();
              return new Response(new Uint8Array(result.rawPayload), {
                status: result.statusCode,
                headers: {
                  "content-length": String(result.rawPayload.length),
                  "content-type": "application/zstd",
                  "x-content-sha256": query.stored,
                  "x-gcs-generation": String(receipt.generation),
                  "x-historical-raw-source": "registered-hub",
                },
              });
            }
            expect(u.origin).toBe(base);
            expect(headers.get("x-xfoilfoam-solver-token")).toBe("owner");
            if (
              u.pathname.includes("/generations/") &&
              (++generationReads === 1 || malformedAdmission !== undefined)
            ) {
              const busy =
                malformedAdmission ??
                JSON.stringify({
                  code: "sync_capacity_busy",
                  retryAfterMs: 1000,
                });
              return new Response(busy, {
                status: 503,
                headers: {
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(busy)),
                  "retry-after": "1",
                },
              });
            }
            process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "hub";
            try {
              const response = await app.inject({
                method: "GET",
                url: u.pathname + u.search,
                headers: Object.fromEntries(headers.entries()),
              });
              return new Response(new Uint8Array(response.rawPayload), {
                status: response.statusCode,
                headers: Object.fromEntries(
                  Object.entries(response.headers).map(([k, v]) => [
                    k,
                    String(v),
                  ]),
                ),
              });
            } finally {
              process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = "remote-solver";
            }
          });
        try {
          expect((await local({}, "other")).statusCode).toBe(401);
          expect(
            (await local({ directory: "cases/other/a0/evidence" })).statusCode,
          ).toBe(409);
          expect((await local({ stored: "b".repeat(64) })).statusCode).toBe(
            409,
          );
          const started = Date.now();
          const res = await local();
          expect(res.statusCode, res.body).toBe(200);
          expect(generationReads).toBe(2);
          expect(Date.now() - started).toBeGreaterThanOrEqual(990);
          expect(res.headers["x-gcs-generation"]).toBe(receipt.generation);
          expect(sha(res.rawPayload)).toBe(query.stored);
          for (const malformed of [
            null,
            { code: "sync_capacity_busy" },
            { retryAfterMs: 1000 },
            { code: "sync_capacity_busy", retryAfterMs: "1000" },
            { code: "sync_capacity_busy", retryAfterMs: 2000 },
          ]) {
            malformedAdmission = JSON.stringify(malformed);
            const reads = generationReads;
            expect((await local()).statusCode).toBe(503);
            expect(generationReads).toBe(reads + 1);
          }
          malformedAdmission = undefined;
          const plan = {
            job_id: job,
            state: "planned" as const,
            historicalSamples: {
              [String(receipt.point_content_signature)]: null,
            },
            replayed: false,
            bytes: bundle.length,
            files: 1,
            plan: "a".repeat(64),
          };
          const run = () =>
            closedProgressiveJob(
              cx,
              {
                reclaimClosedProgressiveFiles: async (_job, proofs) => {
                  expect(proofs).toHaveLength(1);
                  expect(proofs[0].historicalRaw?.point_content_signature).toBe(
                    receipt.point_content_signature,
                  );
                  expect(proofs[0].brokeredUploadId).toBeUndefined();
                  return plan;
                },
              },
              job,
              {
                now: new Date(Date.now() + 5000),
                ageMs: 0,
                timeoutMs: 8000,
                inspect: true,
                historicalRaw: true,
              },
            );
          expect((await run()).readbacks[0]).toMatchObject({
            historicalPointSignature: receipt.point_content_signature,
            generation: receipt.generation,
          });
          expect(forced).toBe(true);
          // The normal media-store first checks the original volume and then reads through the engine.
          const media = new VolumeMediaStore(join(tmpdir(), randomUUID()));
          const stored = await media.stream(
            "jobs/" + job + "/" + directory + "/engine_evidence.tar.zst",
          );
          const chunks: Buffer[] = [];
          for await (const chunk of stored.stream)
            chunks.push(Buffer.from(chunk));
          expect(stored.size).toBe(bundle.length);
          expect(sha(Buffer.concat(chunks))).toBe(query.stored);
          expect(unforcedReads).toBe(1);
          await cx.execute(
            sql`UPDATE progressive_worker_delivery_failures SET state='retry',retry_after=clock_timestamp() WHERE sim_job_id=${job}::uuid`,
          );
          await expect(run()).rejects.toThrow();
        } finally {
          proxy.mockRestore();
        }
        throw rollback;
      })
      .catch((e) => {
        if (e !== rollback) throw e;
      });
  } finally {
    env.engineControlPlaneToken = beforeToken;
    if (beforeProcessToken === undefined)
      delete process.env.ENGINE_CONTROL_PLANE_TOKEN;
    else process.env.ENGINE_CONTROL_PLANE_TOKEN = beforeProcessToken;
    if (role === undefined) delete process.env.AIRFOILFOAM_DEPLOYMENT_ROLE;
    else process.env.AIRFOILFOAM_DEPLOYMENT_ROLE = role;
  }
}
