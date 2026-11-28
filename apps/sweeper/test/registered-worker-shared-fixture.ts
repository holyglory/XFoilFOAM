import { CRC32C } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { DB } from "@aerodb/db";
import {
  canonicalReportJson,
  reportTextIdentity,
  splitProgressiveReportText,
} from "@aerodb/db/progressive-report-archive";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import { memoryReportObjects } from "./shared-report-object-fixture";
import { writeSharedReportPage } from "../src/shared-report-archive";
import { ExistingHubReportStore } from "../src/registered-worker-report-hub";
import { registeredReportRequest } from "../src/registered-worker-report-rpc";
import { releaseUpstreamReadableVolume } from "../src/worker-report-volume-cleanup";
import type { ReaderProof } from "../src/registered-worker-report-page";
import type { PinnedScientificResult } from "../src/registered-shared-report";
import type {
  HubReportLink,
  ReportOwner,
} from "../src/registered-worker-report-read";

export async function registeredSharedFixture(
  owner: ReportOwner,
  reports: { sequence: number; contentSignature: string; text: string }[],
) {
  const { files, store } = memoryReportObjects();
  const signed = reports.map((r) => {
    const cut = splitProgressiveReportText(r.text);
    const inv = retainedReportInventory(cut.report, r.contentSignature);
    const body = reportTextIdentity(r.text);
    return {
      sequence: r.sequence,
      signature: r.contentSignature,
      prefix: cut.prefix,
      suffix: cut.suffix,
      resultHash: reportTextIdentity(cut.result!).sha256,
      resultSize: Buffer.byteLength(cut.result!),
      loadResult: async () => cut.result!,
      inventorySignature: inv.signature,
      sourceCount: inv.sourceCount,
      sourceListSha256: reportTextIdentity(canonicalReportJson(inv.sources))
        .sha256,
      reportSha256: body.sha256,
      reportByteSize: body.byteSize,
    };
  });
  const { pin, manifest } = await writeSharedReportPage(
    store,
    {
      executionId: owner.executionId,
      promiseId: owner.promiseId,
      solverId: owner.solverId,
      assignmentSignature: owner.assignmentSignature,
    },
    signed,
  );
  return {
    pin,
    files,
    bucket: store.bucket,
    manifest: files.get(pin.key)!.bytes,
    results: manifest.results,
  };
}
type Fixture = Awaited<ReturnType<typeof registeredSharedFixture>>;
export async function readSharedFixtureHub(
  fixture: Fixture,
  account: string,
  links: HubReportLink[],
) {
  let downloads = 0;
  const fetchObject: typeof fetch = async (input) => {
    const u = new URL(String(input));
    if (u.hostname === "metadata.google.internal")
      return new Response(
        u.pathname.endsWith("/email")
          ? account
          : JSON.stringify({ access_token: "fixture", token_type: "Bearer" }),
        { headers: { "Metadata-Flavor": "Google" } },
      );
    const file = fixture.files.get(
      decodeURIComponent(u.pathname.split("/o/")[1]!),
    )!;
    expect(u.origin).toBe("https://storage.googleapis.com");
    expect(u.searchParams.get("generation")).toBe(file.pin.generation);
    if (u.searchParams.get("alt") === "media") {
      downloads++;
      return new Response(new Uint8Array(file.bytes));
    }
    return Response.json({
      bucket: fixture.bucket,
      name: file.pin.key,
      generation: file.pin.generation,
      size: String(file.pin.size),
      crc32c: file.pin.crc32c,
      contentType: "application/gzip",
      metadata: { sha256: file.pin.sha256 },
    });
  };
  const hub = new ExistingHubReportStore(fixture.bucket, account, fetchObject);
  const material = await hub.restoreForWorker(links, true);
  expect(material.packed).toBe(fixture.manifest.toString("base64"));
  if (!("dependencies" in material) || !material.dependencies)
    throw new Error("Missing verified scientific object");
  expect(material.dependencies).toHaveLength(1);
  expect(downloads).toBe(2);
  await expect(
    hub.restoreForWorker(
      links.map((l) => ({
        ...l,
        owner: { ...l.owner, assignmentSignature: "f".repeat(64) },
      })),
      true,
    ),
  ).rejects.toThrow();
  const result = Object.entries(fixture.results).find(
    ([, v]) =>
      fixture.files.get(v.pin.key)!.bytes.toString("base64") ===
      material.dependencies![0],
  );
  if (!result) throw new Error("Expected the submitted scientific generation");
  return {
    root: material.packed,
    dependencies: material.dependencies,
    at: material.at,
    scientific: { hash: result[0], ...result[1] },
  };
}

export async function exerciseRegisteredSharedWorkingCopy(
  db: DB,
  links: HubReportLink[],
  transfer: Awaited<ReturnType<typeof readSharedFixtureHub>>,
  volume: string,
) {
  const head = links[0]!.pin;
  const stage = (dependencies: string[]) =>
    registeredReportRequest(db, {
      operation: "stage_page",
      links,
      bytes: transfer.root,
      dependencies,
      cloudAt: transfer.at,
    });
  await expect(stage([])).rejects.toThrow();
  await expect(
    stage([Buffer.from("different scientific bytes").toString("base64")]),
  ).rejects.toThrow();
  await expect(
    stage([
      ...transfer.dependencies,
      Buffer.from("unreferenced").toString("base64"),
    ]),
  ).rejects.toThrow();
  expect(
    await db.execute(
      sql`SELECT FROM progressive_worker_hub_report_links WHERE sim_job_id=${head.executionId}::uuid`,
    ),
  ).toHaveLength(0);
  expect(await stage(transfer.dependencies)).toEqual(links.map(() => "staged"));
  const read = async (reader: string, committed: boolean) => {
    const values: unknown = await registeredReportRequest(db, {
      operation: "read_page",
      links,
      reader,
      committed,
    });
    function confirm(
      v: unknown,
    ): asserts v is (ReaderProof & { scientific: PinnedScientificResult })[] {
      if (!Array.isArray(v) || v.length !== links.length)
        throw new Error("Incomplete normal shared reader proofs");
      for (const [i, item] of v.entries())
        expect(item).toMatchObject({
          generation: head.generation,
          signature: links[i]!.pin.signature,
          sha256: links[i]!.pin.reportSha256,
          byteSize: links[i]!.pin.reportByteSize,
          scientific: transfer.scientific,
          at: expect.any(String),
        });
    }
    confirm(values);
    return values;
  };
  const api = await read("api", false),
    sweeper = await read("sweeper", false);
  const retire = (left = api) =>
    registeredReportRequest(db, {
      operation: "retire_page",
      links,
      api: left,
      sweeper,
      cloudAt: transfer.at,
    });
  if (!Array.isArray(api) || !Array.isArray(sweeper))
    throw new Error("Missing independent shared reader proofs");
  const dependency = api[0]!.scientific.pin;
  expect(dependency).toEqual(sweeper[0]!.scientific.pin);
  const bad = api.map((v) => ({
    ...v,
    scientific: { ...v.scientific, pin: { ...dependency, generation: "1" } },
  }));
  await expect(retire(bad)).rejects.toThrow("Scientific reader proof differs");
  const depPath = join(
    volume,
    dependency.sha256.slice(0, 2),
    dependency.sha256 + ".jsonl.gz",
  );
  const bytes = await readFile(depPath);
  await unlink(depPath);
  expect(
    await registeredReportRequest(db, { operation: "volume_present", links }),
  ).toBe(false);
  await expect(retire()).rejects.toThrow();
  expect(
    await db.execute(
      sql`SELECT FROM progressive_worker_reports WHERE sim_job_id=${head.executionId}::uuid AND archived_at IS NOT NULL`,
    ),
  ).toHaveLength(0);
  expect(await stage(transfer.dependencies)).toEqual(links.map(() => "staged"));
  expect(await retire()).toEqual(links.map(() => "retired"));
  expect(dependency.sha256).not.toBe(head.storedSha256);
  for (const pin of [head, { storedSha256: dependency.sha256, storedByteSize: dependency.size }]) {
    await expect(releaseUpstreamReadableVolume(db, pin, AbortSignal.timeout(5000))).resolves.toBe(false);
  }
  // Both product readers must still reopen the original bytes after cleanup.
  for (const reader of ["api", "sweeper"]) {
    const proofs = await read(reader, true);
    if (!Array.isArray(proofs)) throw new Error("Missing committed originals");
    expect(proofs.map((p) => p.sha256)).toEqual(
      links.map((l) => l.pin.reportSha256),
    );
    expect(proofs.map((p) => p.scientific.pin.generation)).toEqual(
      links.map(() => dependency.generation),
    );
  }
  expect(await retire()).toEqual(links.map(() => "already_retired"));
  const crc = new CRC32C();
  crc.update(bytes);
  expect(crc.toString()).toBe(dependency.crc32c);
  const changed = Buffer.from(bytes);
  changed[0] = changed[0]! ^ 1;
  await writeFile(depPath, changed);
  await expect(read("api", true)).rejects.toThrow();
  await expect(read("sweeper", true)).rejects.toThrow();
  await writeFile(depPath, bytes);
  const persisted =
    await db.execute(sql`SELECT l.hub_bundle_id,l.shared_result_object,b.id,b.archive_format
    FROM progressive_worker_hub_report_links l JOIN progressive_worker_reports r USING(sim_job_id,sequence)
    JOIN progressive_report_archive_bundles b ON b.id=r.archive_bundle_id AND b.source_kind='worker' WHERE l.sim_job_id=${head.executionId}::uuid`);
  expect(persisted).toHaveLength(links.length);
  for (const x of persisted) {
    expect(x.hub_bundle_id).not.toBe(x.id);
    expect(x.archive_format).toBe("shared-result-v1");
    expect(x.shared_result_object).toEqual(api[0]!.scientific);
  }
}
