import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import {
  copyStoppedReportBatch,
  type StoppedCopyReceipt,
} from "./shared-stopped-report-custody";
import type { ReportObjects } from "./shared-report-objects";

type Hooks = {
  beforePublish: (r: StoppedCopyReceipt) => Promise<void>;
  beforeCommit: (r: StoppedCopyReceipt) => Promise<void>;
};
export interface AnchorWalk {
  after: string;
  finishedAt: number;
}
const safeFile = /^[a-f0-9]{64}\.json$/;

/** Revisit proven preserve manifests, including those written by 0219 before
 * this reader version. At most eight small local receipts and one cloud page
 * per turn; a failed read leaves the full source and its checkpoint intact. */
export async function retireNextPreservedAnchor(
  db: DB,
  objects: ReportObjects,
  root: string,
  job: string,
  walk: AnchorWalk,
  hooks: Hooks,
) {
  const dir = join(root, "verified");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((s) => safeFile.test(s)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    files = [];
  }
  const next = files.filter((f) => f > walk.after).slice(0, 8);
  let last = walk.after;
  for (const f of next) {
    const saved = JSON.parse(
      await readFile(join(dir, f), "utf8"),
    ) as StoppedCopyReceipt;
    if (saved.owner.executionId !== job || saved.object.sha256 + ".json" !== f)
      throw new Error("Preserved report receipt does not match its owner");
    last = f;
    if (saved.mode !== "preserve") continue;
    const frozen = saved.members.map((m) => ({
      s: m.sequence,
      sig: m.signature,
    }));
    const rows =
      await db.execute(sql`WITH k AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(frozen)}::jsonb) k(s bigint,sig text))
      SELECT k.s::int s,k.sig,r.content_signature actual,r.archive_bundle_id bundle,r.archived_at at FROM k
      LEFT JOIN progressive_remote_reports r ON r.sim_job_id=${job}::uuid AND r.sequence=k.s ORDER BY k.s`);
    if (rows.length !== frozen.length || rows.some((r) => r.actual !== r.sig))
      throw new Error("Preserved report roster changed");
    const keys = rows
      .filter((r) => !r.bundle && !r.at)
      .map((r) => ({ sequence: Number(r.s), signature: String(r.sig) }));
    if (!keys.length) continue;
    const receipt = await copyStoppedReportBatch(
      db,
      objects,
      job,
      keys,
      "anchor",
      { ...hooks, preserved: saved },
    );
    return {
      walk: {
        after: receipt.members.length < keys.length ? walk.after : last,
        finishedAt: 0,
      },
      receipt,
      more: true,
    };
  }
  const more = next.length === 8;
  return {
    walk: { after: more ? last : "", finishedAt: more ? 0 : Date.now() },
    receipt: null,
    more,
  };
}
