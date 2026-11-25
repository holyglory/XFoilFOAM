import type { DB } from "@aerodb/db/client";
import type { ProgressiveReportArchiveReadIdentity } from "@aerodb/db/progressive-report-archive";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import { sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { readLegacyWorkerReportFromHub } from "./legacy-worker-report-read";
import { readWorkerReportArchiveText } from "./report-archive-broker-client";
import { releaseVerifiedWorkerVolume, workerReportVolumeFiles, type WorkerVolumeIdentity } from "./worker-report-volume";

export async function releaseUpstreamReadableVolume(db:DB, file:WorkerVolumeIdentity,signal:AbortSignal) {
  return releaseVerifiedWorkerVolume(file,async()=>{
    const rows=await db.execute(sql`SELECT b.bucket,b.object_key,b.generation,b.mime_type,b.compression,b.archive_format,
        b.stored_sha256,b.stored_byte_size,b.crc32c,b.sim_job_id,m.sequence,m.member_kind,m.content_signature,m.report_sha256,m.report_byte_size
      FROM progressive_report_archive_bundles b LEFT JOIN LATERAL (
        SELECT * FROM progressive_report_archive_members item WHERE item.bundle_id=b.id
        ORDER BY item.sequence LIMIT 1
      ) m ON true WHERE b.source_kind='worker' AND b.stored_sha256=${file.storedSha256}
      AND b.stored_byte_size=${file.storedByteSize}
      AND NOT EXISTS (SELECT FROM progressive_worker_hub_report_links
        WHERE shared_result_object IS NOT NULL AND ARRAY[read_identity->>'storedSha256',shared_result_object#>>'{pin,sha256}']
          @> ARRAY[${file.storedSha256}::text]) ORDER BY b.id`);
    if (!rows.length) return false;
    for (const row of rows) {
      if (signal.aborted || !row.sequence || !["conflict","report"].includes(String(row.member_kind))) return false;
      const ref:ProgressiveReportArchiveReadIdentity & {signal:AbortSignal}={
        ...file,sourceKind:"worker",memberKind:row.member_kind as "report"|"conflict",
        executionId:String(row.sim_job_id),sequence:Number(row.sequence),signature:String(row.content_signature),
        bucket:String(row.bucket),objectKey:String(row.object_key),generation:String(row.generation),
        compression:String(row.compression),archiveFormat:String(row.archive_format),mimeType:String(row.mime_type),
        crc32c:String(row.crc32c), reportSha256:String(row.report_sha256),reportByteSize:Number(row.report_byte_size),signal
      };
      // Hub-origin JSONL is only readable through this worker volume.
      if(ref.archiveFormat==="jsonl" && ref.objectKey.endsWith(`/remote/${ref.executionId}/${ref.storedSha256}.jsonl.gz`)) return false;
      const raw=ref.archiveFormat==="legacy-jsonl" ? await readLegacyWorkerReportFromHub(db,ref)
        : await readWorkerReportArchiveText(db,ref,{upstreamOnly:true});
      const proof=reportTextIdentity(raw);
      if(proof.sha256!==ref.reportSha256 || proof.byteSize!==ref.reportByteSize) return false;
    }
    return !signal.aborted;
  });
}

export async function runWorkerVolumeCleanup(db:DB,signal:AbortSignal) {
  while(!signal.aborted) {
    try {
      for await (const file of workerReportVolumeFiles()) {
        if (signal.aborted) return;
        if(await releaseUpstreamReadableVolume(db,file,signal)) {
          console.info(JSON.stringify({component:"worker-report-volume-cleanup",releasedBytes:file.storedByteSize}));
          await delay(1000,undefined,{signal});
        }
      }
    } catch(error) {
      if (!signal.aborted) console.info("Worker report working copies retained:",error instanceof Error ? error.message : String(error));
    }
    try { await delay(60*60_000,undefined,{signal}); } catch(error) { if(!signal.aborted)throw error; }
  }
}
