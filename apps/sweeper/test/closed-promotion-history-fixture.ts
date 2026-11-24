import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { CRC32C } from "@google-cloud/storage";
import { expect } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db/client";
import { verifyProgressiveRemoteExecution } from "@aerodb/db";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import {
  readProgressiveReportArchiveText,
  visitVerifiedSignedReportArchive,
} from "@aerodb/db/progressive-report-archive";
import { archiveProgressiveReportBatch } from "../src/progressive-report-archive-service";
import {
  preparePromotionHistory,
  promotionForSettlement,
  withUnlockedPromotionHistory,
} from "../src/progressive-promotion-history";
import { withArchiveFixture } from "./progressive-report-archive-fixture";

type Options = NonNullable<Parameters<typeof withArchiveFixture>[3]>;
type Put = Parameters<typeof archiveProgressiveReportBatch>[3];

export async function verifyColdPromotionHistory() {
  const client = createClient({ max: 4 }),
    parallel = createClient({ max: 2 });
  const bytes = new Map<string, Buffer>();
  const roots: string[] = [];
  let gated = false,
    corrupt = false;
  let began!: () => void, proceed!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const put: Put = async (path, local, _kind, execution) => {
    const body = await readFile(path);
    expect(createHash("sha256").update(body).digest("hex")).toBe(local.sha256);
    const crc = new CRC32C();
    crc.update(body);
    const key = `remote/${execution}/${local.sha256}.jsonl.gz`;
    bytes.set(key, body);
    return {
      objectKey: key,
      bucket: "shared-fixture",
      generation: "9007199254740993123",
      mimeType: "application/gzip",
      compression: "gzip",
      archiveFormat: "jsonl",
      storedSha256: local.sha256,
      storedByteSize: body.byteLength,
      crc32c: crc.toString(),
      verifiedAt: new Date(),
    };
  };
  const fixture = async (options: Options) => {
    let id = "";
    await withArchiveFixture(
      client,
      "remote",
      async (f) => {
        id = f.executionId;
      },
      {
        serviceAcceptance: "ordinary",
        normalized: true,
        historyRepeats: 2,
        ...options,
      },
    );
    const [d] =
      await client.sql`SELECT envelope,content_signature,solver_id,promise_id FROM progressive_remote_dispatches WHERE sim_job_id=${id}`;
    return verifyProgressiveRemoteExecution(d.envelope, {
      executionId: id,
      solverId: d.solver_id,
      promiseId: d.promise_id,
      contentSignature: d.content_signature,
    });
  };
  const archive = (job: string) =>
    archiveProgressiveReportBatch(client.db, "remote", job, put);
  installProgressiveReportArchiveReader({
    read: async (identity) =>
      readProgressiveReportArchiveText(
        Readable.from([bytes.get(identity.objectKey)!]),
        identity,
        identity.signal,
      ),
    visitRemoteJsonl: async (root, owner, visit, signal) => {
      roots.push(root.objectKey);
      if (gated) {
        gated = false;
        began();
        await resume;
      }
      const b = bytes.get(root.objectKey)!;
      if (corrupt) {
        corrupt = false;
        throw new Error("Simulated changed pinned generation");
      }
      await visitVerifiedSignedReportArchive(
        "remote",
        Readable.from([b]),
        root,
        owner,
        visit,
        { maxMembers: root.memberCount, maxReportBytes: 512 * 1024 * 1024 },
        signal,
      );
    },
  });
  try {
    const env = await fixture({ reportCount: 260, nullPrefix: 249 });
    const id = env.scope.executionId;
    const campaign = randomUUID();
    await client.sql`INSERT INTO sim_campaigns(id,name,slug,idempotency_key) VALUES(${campaign},'cold promotion lock',${campaign},${campaign})`;
    await client.sql`UPDATE sim_jobs SET campaign_id=${campaign} WHERE id=${id}`;
    expect(await archive(id)).toBe(128); // entire first root has signed null results
    expect(await archive(id)).toBe(128);
    const firstTwo =
      await client.sql`SELECT object_key,first_sequence FROM progressive_report_archive_bundles WHERE sim_job_id=${id} ORDER BY first_sequence`;
    gated = true;
    const run = withUnlockedPromotionHistory(client.db, (prepared) =>
      client.db.transaction(async (raw) => {
        const conn = raw as unknown as DB;
        const [owner] =
          await conn.execute(sql`SELECT c.id FROM sim_campaigns c JOIN sim_jobs j ON j.campaign_id=c.id
        WHERE j.id=${id}::uuid FOR UPDATE OF c`);
        expect(owner.id).toBe(campaign);
        return promotionForSettlement(conn, env, prepared);
      }),
    );
    try {
      await started;
      // A second session acquires the exact campaign while the root read is paused.
      await parallel.db.transaction(async (tx) => {
        const [held] = await tx.execute(
          sql`SELECT id FROM sim_campaigns WHERE id=${campaign}::uuid FOR UPDATE NOWAIT`,
        );
        expect(held.id).toBe(campaign);
      });
      // This legal transition preserves the report signatures. Only the newly
      // registered root should require another physical read after revalidation.
      expect(await archive(id)).toBe(4);
    } finally {
      proceed();
    }
    expect(await run).toBeNull();
    expect(roots).not.toContain(firstTwo[0].object_key);
    expect(roots.filter((k) => k === firstTwo[1].object_key)).toHaveLength(1);
    expect(new Set(roots).size).toBe(2);
    expect(roots).toHaveLength(2);
    const before = roots.length;
    const again = await preparePromotionHistory(client.db, env);
    expect(await promotionForSettlement(client.db, env, again)).toBeNull();
    expect(roots.length).toBe(before);
    await expect(
      preparePromotionHistory(client.db, { ...env, promiseId: randomUUID() }),
    ).rejects.toThrow("owner");

    for (const [trigger, family, policy] of [
      [0, "simpleFoam", "abort_for_precalc"],
      [5, "simpleFoam", "abort_for_precalc"],
      [0, "pimpleFoam", "continue"],
    ] as const) {
      const signal = {
        trigger_aoa_deg: trigger,
        failure_disposition: "hard_solver" as const,
        attempted_aoas: [trigger],
        intentionally_omitted_aoas: [7],
      };
      const owner = await fixture({
        reportCount: 4,
        nullPrefix: 2,
        angles: [trigger, 7],
        promotionRun: {
          trigger,
          family,
          policy,
          signals: { 3: signal, 4: signal },
        },
      });
      expect(await archive(owner.scope.executionId)).toBe(4);
      if (trigger === 5) {
        corrupt = true;
        await expect(preparePromotionHistory(client.db, owner)).rejects.toThrow(
          "changed pinned",
        );
      }
      const history = await preparePromotionHistory(client.db, owner);
      if (policy === "continue") {
        await expect(
          promotionForSettlement(client.db, owner, history),
        ).rejects.toThrow("signed request is not promotable");
      } else {
        expect(
          await promotionForSettlement(client.db, owner, history),
        ).toMatchObject({
          triggerAoaDeg: trigger,
          attemptedAoas: [trigger],
          intentionallyOmittedAoas: [7],
          sequence: 4,
        });
      }
    }
  } finally {
    proceed();
    installProgressiveReportArchiveReader(null);
    await Promise.all([
      parallel.sql.end({ timeout: 5 }),
      client.sql.end({ timeout: 5 }),
    ]);
  }
}
