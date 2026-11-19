import { createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { analysisContentHash } from "../src/analysis-target";
import { encodeLegacyPage, readLegacyPageMembers, type LegacyBackupPage, type LegacyExactPageIdentity } from "../src/legacy-report-storage-codec";
import type { LegacyReportMember } from "../src/legacy-report-storage";
import {
  legacyReportCustodySql, verifyLegacyReportCustodyPage,
  type LegacyCustodyObject, type LegacyCustodyProductRead, type LegacyReportPageReadIdentity,
} from "../src/legacy-report-custody";

// Keep transport-cost instrumentation separate from the real DB/trigger suite.
// Native crypto and decompression still run; only whole-object operations count.
const cost = vi.hoisted(() => ({ target: undefined as Buffer | undefined, fileHashes: 0, expansions: 0 }));
vi.mock("node:crypto", async (original) => {
  const native = await original<typeof import("node:crypto")>();
  return { ...native, createHash: (...args: Parameters<typeof native.createHash>) => {
    const hash = native.createHash(...args);
    const update = hash.update;
    hash.update = ((...input: unknown[]) => {
      const data = input[0];
      if (Buffer.isBuffer(data) && cost.target && data.equals(cost.target)) cost.fileHashes++;
      return Reflect.apply(update, hash, input);
    }) as typeof hash.update;
    return hash;
  } };
});
vi.mock("node:zlib", async (original) => {
  const native = await original<typeof import("node:zlib")>();
  return { ...native, gunzipSync: (...args: Parameters<typeof native.gunzipSync>) => {
    cost.expansions++;
    return native.gunzipSync(...args);
  } };
});
afterEach(() => { cost.target = undefined; cost.fileHashes = 0; cost.expansions = 0; });
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(count = 3, large = false) {
  const sourceInstance = randomUUID(), solverId = randomUUID(), executionId = randomUUID(), promiseId = randomUUID();
  const members: LegacyReportMember[] = Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const report = { version: 1, solverId, executionId, promiseId, sequence, assignmentSignature: "a".repeat(64),
      status: { job_id: executionId, state: "running", total_cases: 1, completed_cases: 0,
        history: large ? randomBytes(96 * 1024).toString("base64") : `stored history λ ${index}` },
      result: null, stopProof: null };
    const contentSignature = analysisContentHash(report), reportText = JSON.stringify(report);
    const rowText = JSON.stringify({ sim_job_id: executionId, sequence, content_signature: contentSignature,
      report, result_payload_hash: null, acknowledged_at: null, archive_bundle_id: null, archived_at: null });
    return { kind: "report", executionId, sequence, solverId, contentSignature, reportText, rowText,
      reportSha256: digest(reportText), reportByteSize: Buffer.byteLength(reportText), rowSha256: digest(rowText) };
  });
  const page: LegacyBackupPage = { version: 1, sourceInstance, solverId, scopeSha256: digest(`scope:${executionId}`), members,
    start: { execution: 0, kind: "report", after: 0, copied: 0 }, next: { execution: 1, kind: "report", after: count, copied: count } };
  const bytes = encodeLegacyPage(page).bytes;
  const object: LegacyCustodyObject = { bucket: "page-custody-test", generation: "18446744073709551615",
    sha256: digest(bytes), byteSize: bytes.length, objectKey: "", crc32c: "AAAAAA==", verifiedAt: new Date().toISOString() };
  object.objectKey = `legacy-worker-reports/v1/${sourceInstance}/${solverId}/${page.scopeSha256}/${object.sha256}.jsonl.gz`;
  const storageKey = `legacy-reports/${object.sha256}.jsonl.gz`;
  const shared: LegacyExactPageIdentity = { storedSha256: object.sha256, storedByteSize: object.byteSize,
    sourceInstance, solverId, scopeSha256: page.scopeSha256,
    members: members.map((member) => ({ ...member, rowByteSize: Buffer.byteLength(member.rowText) })) };
  return { page, bytes, object, storageKey, shared };
}

function observe(bytes: Buffer) { cost.target = bytes; cost.fileHashes = 0; cost.expansions = 0; }

it("authenticates a 128-member, >10MiB page with one hub read, one persistent reopen and one reconstruction", async () => {
  const input = fixture(128, true);
  expect(input.bytes.length).toBeGreaterThan(10 * 1024 ** 2);
  const hub = vi.fn(async () => Buffer.from(input.bytes));
  const read = vi.fn(async () => { throw new Error("individual reads must not run when page capability exists"); });
  const readPage = vi.fn(async (_identity: LegacyReportPageReadIdentity) => ({ storedBytes: Buffer.from(input.bytes),
    storageKey: input.storageKey, durableAt: new Date().toISOString() }));
  observe(input.bytes);
  const proof = await verifyLegacyReportCustodyPage({ ...input, access: { mode: "hub-local-reader", readHubObject: hub, reader: { readPage, read } } });
  expect(hub).toHaveBeenCalledOnce();
  expect(readPage).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(cost.fileHashes).toBe(2); // Each compressed object once, independent of member count.
  expect(cost.expansions).toBe(1);
  expect(proof.memberProofs).toHaveLength(128);
  expect(Object.isFrozen(proof.memberProofs)).toBe(true);
  expect(proof.memberProofs.every(Object.isFrozen)).toBe(true);
  for (const [index, member] of proof.memberProofs.entries())
    expect(member).toMatchObject({ kind: "report", executionId: input.page.members[index].executionId,
      sequence: index + 1, contentSignature: input.page.members[index].contentSignature,
      reportSha256: input.page.members[index].reportSha256, rowSha256: input.page.members[index].rowSha256 });
  const requested = readPage.mock.calls[0][0];
  expect(requested).toMatchObject({ generation: input.object.generation, storedSha256: input.object.sha256,
    legacyPageMemberCount: 128, legacyInstanceId: input.page.sourceInstance, legacyReadMode: "hub-local-reader" });
  expect(requested.members).toEqual(proof.memberProofs);
  const encoded = legacyReportCustodySql(proof, { apply: true, readersReady: true });
  expect(encoded).toContain(input.object.generation);
  expect(encoded).toContain(input.storageKey);
  expect(encoded).toContain(input.page.members[127].reportSha256);
}, 120_000);

it("supports a page-only registered GET adapter and hashes/decompresses it once", async () => {
  const input = fixture();
  const readPage = vi.fn(async (_identity: LegacyReportPageReadIdentity) => Buffer.from(input.bytes));
  observe(input.bytes);
  const proof = await verifyLegacyReportCustodyPage({ ...input, access: { mode: "registered-get", reader: { readPage } } });
  expect(readPage).toHaveBeenCalledOnce();
  expect(cost.fileHashes).toBe(1);
  expect(cost.expansions).toBe(1);
  expect(proof.memberProofs).toHaveLength(3);
  expect(proof.readMode).toBe("registered-get");
});

it.each(["registered-get", "hub-local-reader"] as const)("keeps the existing individual %s reader fallback", async (mode) => {
  const input = fixture();
  const read = vi.fn(async (identity: { sequence: number }) => input.page.members[identity.sequence - 1].reportText);
  const localRead = vi.fn(async (identity: { sequence: number }) => ({ reportText: await read(identity),
    storedBytes: Buffer.from(input.bytes), storageKey: input.storageKey, durableAt: new Date().toISOString() }));
  const access: LegacyCustodyProductRead = mode === "registered-get" ? { mode, reader: { read } }
    : { mode, readHubObject: async () => Buffer.from(input.bytes), reader: { read: localRead } };
  const proof = await verifyLegacyReportCustodyPage({ ...input, access });
  expect(read).toHaveBeenCalledTimes(3);
  expect(proof.memberProofs).toHaveLength(3);
});

it("preserves prototype-based operator hub readers when selecting page capability", async () => {
  const input = fixture();
  class OperatorAccess {
    readonly mode = "hub-local-reader" as const;
    hubReads = 0;
    readonly reader = { readPage: async () => ({ storedBytes: Buffer.from(input.bytes), storageKey: input.storageKey,
      durableAt: new Date().toISOString() }) };
    async readHubObject() { this.hubReads++; return Buffer.from(input.bytes); }
  }
  const access = new OperatorAccess();
  await expect(verifyLegacyReportCustodyPage({ ...input, access })).resolves.toMatchObject({ memberCount: 3 });
  expect(access.hubReads).toBe(1);
});

it.each(["signature", "digest", "missing-member", "scope"] as const)("rejects an authenticated page with a changed %s without individual-read downgrade", async (kind) => {
  const input = fixture();
  const altered = { ...input.page, members: input.page.members.map((member) => ({ ...member })) };
  if (kind === "signature") altered.members[2].contentSignature = "f".repeat(64);
  if (kind === "digest") altered.members[2].reportSha256 = "f".repeat(64);
  if (kind === "missing-member") altered.members.pop();
  if (kind === "scope") altered.scopeSha256 = "f".repeat(64);
  const bytes = encodeLegacyPage(altered).bytes;
  const object = { ...input.object, sha256: digest(bytes), byteSize: bytes.length };
  object.objectKey = `legacy-worker-reports/v1/${input.page.sourceInstance}/${input.page.solverId}/${input.page.scopeSha256}/${object.sha256}.jsonl.gz`;
  const read = vi.fn(async () => input.page.members[0].reportText);
  const readPage = vi.fn(async () => Buffer.from(bytes));
  await expect(verifyLegacyReportCustodyPage({ page: input.page, object, access: { mode: "registered-get", reader: { readPage, read } } }))
    .rejects.toThrow("Product restore did not verify");
  expect(readPage).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});

it("does not replace a denied page GET with individual or operator reads", async () => {
  const input = fixture();
  const read = vi.fn(async () => input.page.members[0].reportText);
  const readPage = vi.fn(async () => { throw new Error("403 can_fetch is false"); });
  await expect(verifyLegacyReportCustodyPage({ ...input, access: { mode: "registered-get", reader: { readPage, read } } }))
    .rejects.toMatchObject({ fallback: "verified-0198-normalization" });
  expect(readPage).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
});

it("rejects a different persistent compressed object before emitting any member proofs", async () => {
  const input = fixture();
  const readPage = vi.fn(async () => ({ storedBytes: Buffer.from("different object"), storageKey: input.storageKey,
    durableAt: new Date().toISOString() }));
  await expect(verifyLegacyReportCustodyPage({ ...input, access: { mode: "hub-local-reader", readHubObject: async () => Buffer.from(input.bytes), reader: { readPage } } }))
    .rejects.toThrow("Product restore did not verify");
  expect(readPage).toHaveBeenCalledOnce();
});

it("the shared consumer checks row proofs and duplicate keys as well as full-page membership", () => {
  const input = fixture();
  expect(() => readLegacyPageMembers(input.bytes, { ...input.shared,
    members: input.shared.members.map((m, index) => index === 2 ? { ...m, rowSha256: "f".repeat(64) } : m) }))
    .toThrow("differs from catalog");
  expect(() => readLegacyPageMembers(input.bytes, { ...input.shared,
    members: [input.shared.members[0], input.shared.members[0], input.shared.members[2]] }))
    .toThrow("Duplicate expected");
});

it("preserves the pre-dictionary legacy page format in the shared batch consumer", () => {
  const input = fixture();
  const { members, ...header } = input.page;
  const raw = [JSON.stringify({ type: "header", ...header }),
    ...members.map((member) => JSON.stringify({ type: "member", ...member })),
    JSON.stringify({ type: "end", memberCount: members.length })].join("\n") + "\n";
  const bytes = gzipSync(Buffer.from(raw));
  expect(readLegacyPageMembers(bytes, { ...input.shared, storedSha256: digest(bytes), storedByteSize: bytes.length })).toEqual(members);
});

it("keeps report and conflict identities separate at the same execution and sequence", () => {
  const input = fixture();
  const original = input.page.members[0];
  const { acknowledged_at: _ack, ...row } = JSON.parse(original.rowText);
  const rowText = JSON.stringify({ ...row, reason: "retained conflict", body_source_sequence: null });
  const conflict: LegacyReportMember = { ...original, kind: "conflict", rowText, rowSha256: digest(rowText) };
  const page = { ...input.page, members: [...input.page.members, conflict] };
  const bytes = encodeLegacyPage(page).bytes;
  const actual = readLegacyPageMembers(bytes, { ...input.shared, storedSha256: digest(bytes), storedByteSize: bytes.length,
    members: [...input.shared.members, { ...conflict, rowByteSize: Buffer.byteLength(conflict.rowText) }] });
  expect(actual).toHaveLength(4);
  expect(actual.filter((member) => member.sequence === 1).map((member) => member.kind)).toEqual(["report", "conflict"]);
  expect(actual.at(-1)?.rowText).toBe(rowText);
});

it("refuses an oversized page object before either transport reads it", async () => {
  const input = fixture();
  const readHubObject = vi.fn(async () => input.bytes);
  const readPage = vi.fn(async () => ({ storedBytes: input.bytes, storageKey: input.storageKey, durableAt: new Date().toISOString() }));
  await expect(verifyLegacyReportCustodyPage({ ...input, object: { ...input.object, byteSize: 512 * 1024 ** 2 + 1 },
    access: { mode: "hub-local-reader", readHubObject, reader: { readPage } } })).rejects.toThrow("Product restore did not verify");
  expect(readHubObject).not.toHaveBeenCalled();
  expect(readPage).not.toHaveBeenCalled();
});

it("authenticates trailing bytes and rejects truncation and bounded-page overflow", async () => {
  const input = fixture();
  const raw = gunzipSync(input.bytes);
  const broken = gzipSync(raw.subarray(0, raw.length - 1));
  expect(() => readLegacyPageMembers(broken, { ...input.shared, storedSha256: digest(broken), storedByteSize: broken.length }))
    .toThrow("Truncated legacy backup");
  const readPage = vi.fn(async () => input.bytes);
  await expect(verifyLegacyReportCustodyPage({ ...input, page: { ...input.page, members: Array.from({ length: 129 }, () => input.page.members[0]) },
    access: { mode: "registered-get", reader: { readPage } } })).rejects.toThrow("custody page members");
  expect(readPage).not.toHaveBeenCalled();
});
