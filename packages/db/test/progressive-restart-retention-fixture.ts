import { sql } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { EngineClient } from "../../engine-client/src";
import type { ProgressiveEvidenceCustodyReceipt } from "../src/progressive-evidence-custody";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { reclaimProgressiveRestartState } from "../../../apps/sweeper/src/progressive-restart-retention";

export function brokeredRetentionMetadata(
  signed: { receipt: ProgressiveEvidenceCustodyReceipt; receiptHmac: string },
  evidenceBase: string,
): Record<string, string> {
  // Match evidence_runtime.py's actual writer and checksum serialization,
  // including Python float spelling and escaped Unicode, rather than a JS copy.
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import hashlib, json, sys
data = json.load(sys.stdin)
signed = data['signed']
source = signed['receipt']['source']
auth = dict(schemaVersion=1, jobId=source['engineJobId'], caseSlug=source['engineCaseSlug'], evidenceBase=data['base'], **signed)
ack = dict(schemaVersion=1, state='hub_progressive_custody', authorization=auth, registeredAt='2026-11-17T00:00:00Z')
intent = dict(schemaVersion=1, kind='brokered-local-evidence-reclaim-intent', authorization=auth,
  paths=[dict(name='engine_evidence.tar.zst', kind='file', byteSize=500, entryCount=1, treeSha256='c'*64)], plannedPathCount=1, plannedBytes=500)
completed = dict(schemaVersion=1, state='complete', authorization=auth,
  intentSha256=hashlib.sha256(json.dumps(intent, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
  deletedPaths=['engine_evidence.tar.zst'], bytesDeleted=500)
print(json.dumps({name:json.dumps(value, sort_keys=True, indent=2)+'\\n' for name,value in [
  ('brokered_hub_binding.database.json',ack), ('brokered_local_reclaim.intent.json',intent), ('brokered_local_reclaim.json',completed)]}))
`,
      ],
      {
        input: JSON.stringify({ signed, base: evidenceBase }),
        encoding: "utf8",
      },
    ),
  );
}

export async function verifyProgressiveRestartRetention(
  db: DB,
  executionId: string,
) {
  const rollback = new Error("Restore isolated restart retention fixture");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const stripJob = vi.fn(async () => ({
        job_id: executionId,
        unknown_entries: [],
        bytes_freed: 8192,
        files_removed: 3,
        kept_case_state: false,
      }));
      const before = await connection.execute(
        sql`SELECT sequence,content_signature FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`,
      );
      await connection.execute(
        sql`UPDATE sweeper_state SET disk_admission_blocked=false WHERE id=1`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      expect(stripJob).not.toHaveBeenCalled();
      await connection.execute(
        sql`UPDATE sweeper_state SET disk_admission_blocked=true WHERE id=1`,
      );
      const [original] = await connection.execute(
        sql`SELECT status,engine_job_id FROM sim_jobs WHERE id=${executionId}::uuid`,
      );
      for (const state of ["pending", "submitted", "running", "ingesting"]) {
        await connection.execute(
          sql`UPDATE sim_jobs SET status=${state}::sim_job_status WHERE id=${executionId}::uuid`,
        );
        expect(
          await reclaimProgressiveRestartState(
            connection,
            { stripJob },
            executionId,
          ),
        ).toEqual({ stripped: 0, bytesFreed: 0 });
      }
      await connection.execute(
        sql`UPDATE sim_jobs SET status=${original.status}::sim_job_status,engine_job_id='foreign' WHERE id=${executionId}::uuid`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      await connection.execute(
        sql`UPDATE sim_jobs SET engine_job_id=${original.engine_job_id},ingest_lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${executionId}::uuid`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      expect(stripJob).not.toHaveBeenCalled();
      await connection.execute(
        sql`UPDATE sim_jobs SET ingest_lease_expires_at=NULL WHERE id=${executionId}::uuid`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 1, bytesFreed: 8192 });
      expect(stripJob).toHaveBeenCalledOnce();
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      expect(stripJob).toHaveBeenCalledOnce();
      // Exercise the real selector, ownership checks, engine HTTP client and
      // database acknowledgement with the custody established by this fixture.
      await connection.execute(
        sql`UPDATE sim_jobs SET stripped_at=NULL WHERE id=${executionId}::uuid`,
      );
      const [custody] =
        await connection.execute(sql`SELECT receipt,point_content_signature FROM progressive_worker_archive_receipts
        WHERE sim_job_id=${executionId}::uuid`);
      const signed = custody.receipt as {
        receipt: ProgressiveEvidenceCustodyReceipt;
        receiptHmac: string;
      };
      const [latest] =
        await connection.execute(sql`SELECT public.resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report FROM progressive_worker_reports
        WHERE sim_job_id=${executionId}::uuid ORDER BY sequence DESC LIMIT 1`);
      const report = latest.report as unknown as ProgressiveRemoteReport;
      const point = report
        .result!.polars.flatMap((polar) => [
          ...polar.points,
          ...(polar.attempts ?? []),
        ])
        .find(
          (point) => point.case_slug === signed.receipt.source.engineCaseSlug,
        )!;
      const manifest = point.evidence_artifacts!.find(
        (artifact) => artifact.kind === "manifest",
      )!;
      const base = manifest.path.slice(0, -"/evidence_manifest.json".length);
      const directory = `cases/${point.case_slug}/${base}`;
      const files = brokeredRetentionMetadata(signed, base);
      const originalFiles = { ...files };
      const retainedReport = {
        job_id: executionId,
        kept_case_state: false,
        bytes_freed: 0,
        files_removed: 0,
        unknown_entries: Object.keys(files).map(
          (name) => `${directory}/${name}`,
        ),
      };
      const requests: string[] = [];
      const server = createServer(async (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader("content-type", "application/json");
        if (
          request.method === "POST" &&
          request.url === `/jobs/${executionId}/strip`
        ) {
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          if (
            Buffer.concat(chunks).toString() !==
            JSON.stringify({ keep_case_state: false })
          ) {
            response.statusCode = 400;
            response.end("{}");
          } else response.end(JSON.stringify(retainedReport));
          return;
        }
        const prefix = `/jobs/${executionId}/files/${directory}/`;
        const body =
          request.method === "GET" && request.url?.startsWith(prefix)
            ? files[request.url.slice(prefix.length)]
            : undefined;
        response.statusCode = body === undefined ? 404 : 200;
        response.end(body ?? "{}");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as { port: number };
      const engine = new EngineClient(`http://127.0.0.1:${address.port}`);
      const evidence = () =>
        connection.execute(sql`
        WITH retained AS (
        SELECT 'result' AS kind,to_jsonb(row) AS value FROM results row WHERE sim_job_id=${executionId}::uuid
        UNION ALL SELECT 'attempt',to_jsonb(row) FROM result_attempts row WHERE sim_job_id=${executionId}::uuid
        UNION ALL SELECT 'artifact',to_jsonb(row) FROM solver_evidence_artifacts row WHERE sim_job_id=${executionId}::uuid
        UNION ALL SELECT 'media',to_jsonb(row) FROM result_media row WHERE result_attempt_id IN
          (SELECT id FROM result_attempts WHERE sim_job_id=${executionId}::uuid))
        SELECT * FROM retained ORDER BY kind,value::text
      `);
      try {
        const retainedBefore = await evidence();
        expect(retainedBefore.length).toBeGreaterThan(0);
        await connection.execute(
          sql`DELETE FROM progressive_worker_archive_reclaims WHERE sim_job_id=${executionId}::uuid`,
        );
        expect(
          await reclaimProgressiveRestartState(connection, engine, executionId),
        ).toEqual({ stripped: 0, bytesFreed: 0 });
        await connection.execute(sql`INSERT INTO progressive_worker_archive_reclaims
          (sim_job_id,point_content_signature,completed_at,reclaimed_bytes)
          VALUES (${executionId}::uuid,${custody.point_content_signature},clock_timestamp(),500)`);
        files["brokered_local_reclaim.json"] = originalFiles[
          "brokered_local_reclaim.json"
        ].replace(/"intentSha256": "[a-f0-9]+"/, '"intentSha256": "corrupt"');
        expect(
          await reclaimProgressiveRestartState(connection, engine, executionId),
        ).toEqual({ stripped: 0, bytesFreed: 0 });
        files["brokered_local_reclaim.json"] =
          originalFiles["brokered_local_reclaim.json"];
        expect(
          await reclaimProgressiveRestartState(connection, engine, executionId),
        ).toEqual({ stripped: 1, bytesFreed: 0 });
        const [saved] = await connection.execute(
          sql`SELECT stripped_at,strip_report FROM sim_jobs WHERE id=${executionId}::uuid`,
        );
        expect(saved.stripped_at).not.toBeNull();
        expect(saved.strip_report).toEqual(retainedReport);
        const calls = requests.length;
        expect(
          await reclaimProgressiveRestartState(connection, engine, executionId),
        ).toEqual({ stripped: 0, bytesFreed: 0 });
        expect(requests).toHaveLength(calls);
        expect(
          requests.filter((request) => request.startsWith("POST")),
        ).toEqual(Array(3).fill(`POST /jobs/${executionId}/strip`));
        expect(files).toEqual(originalFiles);
        expect(await evidence()).toEqual(retainedBefore);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      expect(
        await connection.execute(
          sql`SELECT sequence,content_signature FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`,
        ),
      ).toEqual(before);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
