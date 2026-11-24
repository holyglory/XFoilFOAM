import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createClient, type DB } from "../src/client";
import { analysisContentHash, sealProgressiveRemoteExecution, simJobs, syncSweepPromises } from "../src/index";
import { installProgressiveReportArchiveReader, readProgressiveReport } from "../src/progressive-report-reader";
import { resolveProgressiveRemoteEvidence } from "../src/progressive-remote-evidence";
import { legacyNormalizeSql, type LegacyReportMember } from "../src/legacy-report-storage";
import { setProgressiveReportNormalization, backfillProgressiveReportPayloads } from "../src/progressive-report-payloads";
import {
  applyLegacyReportCustodyPage, legacyReportCustodySql, verifyLegacyReportCustodyPage, LegacyRegisteredRestoreUnavailable,
  type LegacyCustodyObject, type LegacyCustodyProductRead, type LegacyReportCustodyPage,
} from "../src/legacy-report-custody";
import { withArchiveFixture, type ArchiveFixture } from "../../../apps/sweeper/test/progressive-report-archive-fixture";
import { compactSettledStatusHeader } from "../../../apps/sweeper/src/settled-report-status-headers";
import { encodeLegacyPage } from "../src/legacy-report-storage-codec";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
afterEach(() => { installProgressiveReportArchiveReader(null); vi.restoreAllMocks(); });
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

async function setup(fixture: ArchiveFixture) {
  const db = fixture.db;
  const instanceId = randomUUID();
  const [owner] = await db.execute(sql`SELECT registered_solver_id AS solver_id FROM sync_sweep_promises WHERE id=${fixture.promiseId}::uuid`);
  const solverId = String(owner.solver_id);
  await db.execute(sql`UPDATE sync_api_settings SET instance_id=${instanceId}::uuid,
    remote_solver_registered_id=${solverId}::uuid,upstream_base_url='https://legacy-custody.invalid/api/sync/v1' WHERE id=1`);
  await db.execute(sql`UPDATE sync_sweep_promises SET source_base_url='https://legacy-custody.invalid/api/sync/v1'
    WHERE id=${fixture.promiseId}::uuid`);
  await db.execute(sql`UPDATE sim_jobs SET request_payload=request_payload||
    '{"upstreamBaseUrl":"https://legacy-custody.invalid/api/sync/v1"}'::jsonb WHERE id=${fixture.executionId}::uuid`);
  return { instanceId, solverId };
}

async function membersFor(db: DB, executionId: string): Promise<LegacyReportMember[]> {
  const rows = await db.execute(sql`
    SELECT 'report' AS kind,r.sim_job_id::text AS execution_id,r.sequence,r.content_signature,
      r.report->>'solverId' AS solver_id,to_jsonb(r.*)::text AS row_text,
      public.resolve_progressive_report(r.report,r.result_payload_hash)::text AS report_text
    FROM progressive_worker_reports r WHERE r.sim_job_id=${executionId}::uuid
    UNION ALL SELECT 'conflict',c.sim_job_id::text,c.sequence,c.content_signature,c.report->>'solverId',to_jsonb(c.*)::text,
      public.resolve_progressive_report(storage.report,storage.result_payload_hash)::text
    FROM progressive_worker_report_conflicts c JOIN progressive_worker_conflict_storage storage USING(sim_job_id,sequence,content_signature)
    WHERE c.sim_job_id=${executionId}::uuid ORDER BY sequence,kind DESC
  `);
  return rows.map((row) => {
    const reportText = String(row.report_text), rowText = String(row.row_text);
    return { kind: row.kind as "report" | "conflict", executionId: String(row.execution_id), sequence: Number(row.sequence),
      contentSignature: String(row.content_signature), solverId: String(row.solver_id), rowText, rowSha256: digest(rowText),
      reportText, reportSha256: digest(reportText), reportByteSize: Buffer.byteLength(reportText) };
  });
}

function pageFor(instanceId: string, solverId: string, members: LegacyReportMember[]) {
  const page: LegacyReportCustodyPage = { version: 1, sourceInstance: instanceId, solverId,
    scopeSha256: digest(JSON.stringify(members.map((m) => [m.kind, m.executionId, m.sequence, m.reportSha256]))), members };
  const packed = encodeLegacyPage({ ...page, start: { execution: 0, kind: "report", after: 0, copied: 0 },
    next: { execution: new Set(members.map((member) => member.executionId)).size, kind: "report", after: 0, copied: 0 } });
  const bytes = packed.bytes;
  const object: LegacyCustodyObject = { bucket: "legacy-custody-test", generation: "18446744073709551615",
    sha256: digest(bytes), byteSize: bytes.byteLength, crc32c: "AAAAAA==", verifiedAt: new Date().toISOString(), objectKey: "" };
  object.objectKey = `legacy-worker-reports/v1/${instanceId}/${solverId}/${page.scopeSha256}/${object.sha256}.jsonl.gz`;
  const source = (identity: { memberKind: string; executionId: string; sequence: number }) =>
    page.members.find((m) => m.kind === identity.memberKind && m.executionId === identity.executionId && m.sequence === identity.sequence)!.reportText;
  const storageKey = `legacy-reports/${object.sha256}.jsonl.gz`;
  const access = (mode: "registered-get" | "hub-local-reader"): LegacyCustodyProductRead => mode === "registered-get"
    ? { mode, reader: { read: async (identity) => source(identity) } }
    : { mode, readHubObject: async () => Buffer.from(bytes), reader: { read: async (identity) => ({
        reportText: source(identity), storageKey, storedBytes: Buffer.from(bytes), durableAt: new Date().toISOString(),
      }) } };
  return { page, object, bytes, access, storageKey, source };
}

async function protectedRows(db: DB, executionId: string) {
  const snapshot: Record<string, unknown> = {};
  for (const table of ["results", "result_attempts", "progressive_remote_dispatches", "progressive_remote_reports"]) {
    snapshot[table] = await db.execute(sql`SELECT to_jsonb(r.*)::text AS row FROM ${sql.identifier(table)} r
      WHERE r.sim_job_id=${executionId}::uuid ORDER BY to_jsonb(r.*)::text`);
  }
  return snapshot;
}

it.each(["registered-get", "hub-local-reader"] as const)("registers exact legacy custody via %s without dispatch or polar publication", async (mode) => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const input = pageFor(instanceId, solverId, await membersFor(fixture.db, fixture.executionId));
    const before = await protectedRows(fixture.db, fixture.executionId);
    expect(before.progressive_remote_dispatches).toEqual([]);
    const proof = await verifyLegacyReportCustodyPage({ ...input, access: input.access(mode) });
    expect(proof).toMatchObject({ readMode: mode, localStorageKey: mode === "hub-local-reader" ? input.storageKey : null });
    expect(legacyReportCustodySql(proof)).toMatch(/ROLLBACK;\n$/);
    await expect(applyLegacyReportCustodyPage(fixture.db, proof, { apply: true })).rejects.toThrow("installed legacy report readers");
    const applied = await applyLegacyReportCustodyPage(fixture.db, proof, { apply: true, readersReady: true });
    expect(applied).toMatchObject({ applied: true, receipt: { compactedReports: 3, compactedConflicts: 1,
      registeredBundles: 1, registeredMembers: 4, readMode: mode, skipped: [] } });
    const [bundle] = await fixture.db.execute(sql`SELECT archive_format,member_count,legacy_page_member_count,
      legacy_instance_id,legacy_solver_id,legacy_read_mode,legacy_local_storage_key FROM progressive_report_archive_bundles
      WHERE sim_job_id=${fixture.executionId}::uuid`);
    expect(bundle).toMatchObject({ archive_format: "legacy-jsonl", member_count: 4, legacy_page_member_count: 4,
      legacy_instance_id: instanceId, legacy_solver_id: solverId, legacy_read_mode: mode,
      legacy_local_storage_key: mode === "hub-local-reader" ? input.storageKey : null });
    expect(await protectedRows(fixture.db, fixture.executionId)).toEqual(before);
    const [state] = await fixture.db.execute(sql`SELECT count(*)::integer AS reports,
      count(archived_at)::integer AS cold FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid`);
    expect(state).toEqual({ reports: 3, cold: 3 });
    const read = vi.fn(async (identity) => input.source(identity));
    installProgressiveReportArchiveReader({ read });
    const first = input.page.members.find((m) => m.kind === "report")!;
    await expect(readProgressiveReport(fixture.db, { sourceKind: "worker", executionId: first.executionId,
      sequence: first.sequence, contentSignature: first.contentSignature })).resolves.toMatchObject({ sequence: first.sequence });
    expect(read.mock.calls[0][0]).toMatchObject({ archiveFormat: "legacy-jsonl", legacyReadMode: mode,
      generation: input.object.generation, reportSha256: first.reportSha256 });
    await expect(resolveProgressiveRemoteEvidence(fixture.db, { solverId, promiseId: fixture.promiseId,
      engineJobId: fixture.executionId, aoaDeg: 0, engineCaseSlug: null,
      progressiveEvidence: { sequence: first.sequence, reportContentSignature: first.contentSignature, pointContentSignature: "a".repeat(64) },
    })).rejects.toThrow("no exact stored dispatch");
    const [statusRow] = await fixture.db
      .execute(sql`SELECT archive_bundle_id AS bundle
      FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${first.sequence}`);
    expect(
      await compactSettledStatusHeader(fixture.db, "worker", {
        job: fixture.executionId,
        sequence: first.sequence,
        signature: first.contentSignature,
        bundle: String(statusRow.bundle),
      }),
    ).toBeGreaterThan(0);
    const repeatedProof = await verifyLegacyReportCustodyPage({
      ...input,
      access: input.access(mode),
    });
    expect(repeatedProof.memberProofs).toEqual(proof.memberProofs);
    expect(repeatedProof.object).toEqual(proof.object);
    expect(
      await applyLegacyReportCustodyPage(fixture.db, repeatedProof, {
        apply: true,
        readersReady: true,
      }),
    ).toMatchObject({
      receipt: {
        compactedReports: 0,
        compactedConflicts: 0,
        replayedMembers: 4,
      },
    });
    expect(await protectedRows(fixture.db, fixture.executionId)).toEqual(before);
  }, { legacyConflict: "distinct", quietStatusPrefix: 1 });
});

it("denied registered GET cannot mint custody and leaves verified 0198 normalization available", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const input = pageFor(instanceId, solverId, await membersFor(fixture.db, fixture.executionId));
    const permission = await fixture.db.execute(sql`SELECT data_type,can_fetch,can_push FROM sync_api_permissions ORDER BY data_type`);
    const access: LegacyCustodyProductRead = { mode: "registered-get", reader: { read: async () => { throw new Error("403 can_fetch is false"); } } };
    await expect(verifyLegacyReportCustodyPage({ ...input, access })).rejects.toBeInstanceOf(LegacyRegisteredRestoreUnavailable);
    expect(() => legacyReportCustodySql({ sourceInstance: instanceId, solverId, scopeSha256: input.page.scopeSha256,
      readbackAt: new Date().toISOString(), readMode: "registered-get", localStorageKey: null, memberCount: input.page.members.length, memberProofs: [] },
      { apply: true, readersReady: true })).toThrow("fresh successful product read");
    expect(legacyNormalizeSql(input.page.members, { apply: true, readersReady: true })).toContain(input.page.members[0].reportSha256);
    await setProgressiveReportNormalization(fixture.db, { enabled: true, readersReady: true });
    await backfillProgressiveReportPayloads(fixture.db, { table: "progressive_worker_reports", apply: true,
      after: { executionId: fixture.executionId, sequence: 1 }, rows: 2 });
    expect(await fixture.db.execute(sql`SELECT sequence::integer AS sequence,archived_at,archive_bundle_id FROM progressive_worker_reports
      WHERE sim_job_id=${fixture.executionId}::uuid ORDER BY sequence`)).toEqual([1,2,3].map((sequence) => ({ sequence, archived_at: null, archive_bundle_id: null })));
    const retained = await membersFor(fixture.db, fixture.executionId);
    expect(retained.map((member) => [member.kind,member.sequence,member.reportSha256,member.reportByteSize]))
      .toEqual(input.page.members.map((member) => [member.kind,member.sequence,member.reportSha256,member.reportByteSize]));
    expect(await fixture.db.execute(sql`SELECT data_type,can_fetch,can_push FROM sync_api_permissions ORDER BY data_type`)).toEqual(permission);
  }, { normalized: false });
});

it("hub bytes alone or a different local compressed copy cannot mint cold custody", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const input = pageFor(instanceId, solverId, await membersFor(fixture.db, fixture.executionId));
    const access: LegacyCustodyProductRead = { mode: "hub-local-reader", readHubObject: async () => Buffer.from(input.bytes),
      reader: { read: async (identity) => ({ reportText: input.source(identity), storedBytes: Buffer.from("different compressed bytes"),
        storageKey: input.storageKey, durableAt: new Date().toISOString() }) } };
    await expect(verifyLegacyReportCustodyPage({ ...input, access })).rejects.toThrow("Product restore did not verify");
    expect(await fixture.db.execute(sql`SELECT id FROM progressive_report_archive_bundles WHERE sim_job_id=${fixture.executionId}::uuid`)).toEqual([]);
    expect(await fixture.db.execute(sql`SELECT archived_at FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid`))
      .toEqual([{ archived_at: null }, { archived_at: null }, { archived_at: null }]);
  });
});

it.each(["running", "not-ingested", "open-promise", "retry", "changed-instance", "unacknowledged", "missing-stop"] as const)("retains inline rows for unresolved %s", async (reason) => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const input = pageFor(instanceId, solverId, await membersFor(fixture.db, fixture.executionId));
    const proof = await verifyLegacyReportCustodyPage({ ...input, access: input.access("registered-get") });
    if (reason === "running") await fixture.db.execute(sql`UPDATE sim_jobs SET status='running' WHERE id=${fixture.executionId}::uuid`);
    if (reason === "not-ingested") await fixture.db.execute(sql`UPDATE sim_jobs SET "ingestedAt"=NULL WHERE id=${fixture.executionId}::uuid`);
    if (reason === "open-promise") await fixture.db.execute(sql`UPDATE sync_sweep_promises SET status='active' WHERE id=${fixture.promiseId}::uuid`);
    if (reason === "retry") {
      await fixture.db.execute(sql`INSERT INTO progressive_worker_evidence_attempts
        (sim_job_id,sequence,result_attempt_id,point_content_signature)
        VALUES (${fixture.executionId}::uuid,1,${fixture.attemptId}::uuid,${"a".repeat(64)})`);
      await fixture.db.execute(sql`INSERT INTO progressive_worker_delivery_failures
        (sim_job_id,sequence,result_attempt_id,point_content_signature,state,attempt_count,retry_after,last_http_status,last_error)
        VALUES (${fixture.executionId}::uuid,1,${fixture.attemptId}::uuid,${"a".repeat(64)},'retry',1,clock_timestamp()+interval '1 minute',503,'outstanding delivery')`);
    }
    if (reason === "changed-instance") {
      await fixture.db.execute(sql`UPDATE sync_api_settings SET instance_id=${randomUUID()}::uuid WHERE id=1`);
      await expect(applyLegacyReportCustodyPage(fixture.db, proof, { apply: true, readersReady: true })).rejects.toThrow("current worker identity");
    } else expect(await applyLegacyReportCustodyPage(fixture.db, proof, { apply: true, readersReady: true }))
      .toMatchObject({ receipt: { compactedReports: 0, compactedConflicts: 0 } });
    expect(await fixture.db.execute(sql`SELECT id FROM progressive_report_archive_bundles WHERE sim_job_id=${fixture.executionId}::uuid`)).toEqual([]);
  }, { settled: reason !== "unacknowledged", stopped: reason !== "missing-stop" });
});

it("preserves conflict aliases while archiving their worker source", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    await fixture.db.execute(sql`UPDATE progressive_worker_report_conflicts SET body_source_sequence=sequence
      WHERE sim_job_id=${fixture.executionId}::uuid`);
    const before = await fixture.db.execute(sql`SELECT to_jsonb(c.*)::text AS row FROM progressive_worker_report_conflicts c
      WHERE sim_job_id=${fixture.executionId}::uuid`);
    const input = pageFor(instanceId, solverId, await membersFor(fixture.db, fixture.executionId));
    const proof = await verifyLegacyReportCustodyPage({ ...input, access: input.access("registered-get") });
    expect(await applyLegacyReportCustodyPage(fixture.db, proof, { apply: true, readersReady: true }))
      .toMatchObject({ receipt: { compactedReports: 3, compactedConflicts: 0, aliasesRetained: 1 } });
    expect(await fixture.db.execute(sql`SELECT to_jsonb(c.*)::text AS row FROM progressive_worker_report_conflicts c
      WHERE sim_job_id=${fixture.executionId}::uuid`)).toEqual(before);
  }, { legacyConflict: "identical" });
});

it("groups two executions of one legacy object into separate immutable bundle markers", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const db = fixture.db;
    const [original] = await db.execute(sql`SELECT airfoil_id,bc_ids,simulation_preset_revision_id,reference_chord_m,request_payload
      FROM sim_jobs WHERE id=${fixture.executionId}::uuid`);
    const executionId = randomUUID(), promiseId = randomUUID();
    const previous = (original.request_payload as { remoteProgressiveExecution: ReturnType<typeof sealProgressiveRemoteExecution> }).remoteProgressiveExecution;
    const envelope = sealProgressiveRemoteExecution({ solverId, promiseId,
      scope: { ...previous.scope, executionId }, request: { ...previous.request, execution_id: executionId } });
    await db.insert(syncSweepPromises).values({ id: promiseId, registeredSolverId: solverId,
      airfoilId: String(original.airfoil_id), simulationPresetRevisionId: String(original.simulation_preset_revision_id),
      aoaCount: 1, status: "cancelled", expiresAt: new Date("2026-01-01T00:00:00Z"),
      sourceBaseUrl: "https://legacy-custody.invalid/api/sync/v1", requestPayload: { ...envelope } });
    await db.insert(simJobs).values({ id: executionId, engineJobId: executionId,
      airfoilId: String(original.airfoil_id), bcIds: original.bc_ids as string[], referenceChordM: Number(original.reference_chord_m),
      simulationPresetRevisionId: String(original.simulation_preset_revision_id), status: "cancelled", engineState: "cancelled",
      totalCases: 1, completedCases: 0, ingestedAt: new Date(), requestPayload: { remoteSolver: true, syncPromiseId: promiseId,
        upstreamBaseUrl: "https://legacy-custody.invalid/api/sync/v1", remoteProgressiveExecution: envelope } });
    const report = { version: 1, solverId, promiseId, executionId, assignmentSignature: envelope.contentSignature, sequence: 1,
      status: { job_id: executionId, state: "cancelled", total_cases: 1, completed_cases: 0 }, result: null,
      stopProof: { version: 1, job_id: executionId, execution_stopped: true, producer_stopped: true, namespace_verified: true,
        remaining: [], observed_at: new Date().toISOString(), error: null, fence: "terminal_result", ownership_basis: "recorded_execution_namespace" } };
    await db.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at)
      VALUES (${executionId}::uuid,1,${analysisContentHash(report)},${JSON.stringify(report)}::jsonb,clock_timestamp())`);
    const all = [...await membersFor(db, fixture.executionId), ...await membersFor(db, executionId)]
      .sort((a,b) => a.executionId.localeCompare(b.executionId) || a.sequence-b.sequence || b.kind.localeCompare(a.kind));
    const input = pageFor(instanceId, solverId, all);
    const proof = await verifyLegacyReportCustodyPage({ ...input, access: input.access("registered-get") });
    expect(await applyLegacyReportCustodyPage(db, proof, { apply: true, readersReady: true }))
      .toMatchObject({ receipt: { registeredBundles: 2, registeredMembers: 4, compactedReports: 4, skipped: [] } });
    const markers = await db.execute(sql`SELECT sim_job_id,member_count,legacy_page_member_count,bucket,object_key,generation
      FROM progressive_report_archive_bundles WHERE sim_job_id IN (${fixture.executionId}::uuid,${executionId}::uuid)`);
    expect(markers).toHaveLength(2);
    expect(markers.map((row) => row.member_count).sort()).toEqual([1,3]);
    expect(markers.every((row) => row.legacy_page_member_count===4 && row.object_key===input.object.objectKey && row.generation===input.object.generation)).toBe(true);
    expect(await db.execute(sql`SELECT sim_job_id FROM progressive_remote_dispatches
      WHERE sim_job_id IN (${fixture.executionId}::uuid,${executionId}::uuid)`)).toEqual([]);
  });
});

it("rolls back the entire bounded page when a later source digest differs", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const members = await membersFor(fixture.db, fixture.executionId);
    const last = members[members.length - 1];
    // Same application value/signature, different exact PostgreSQL text. This
    // reaches the SQL byte guard after earlier page rows have been processed.
    last.reportText = last.reportText.replace('"sequence": 3', '"sequence": 3.0');
    last.reportSha256 = digest(last.reportText);
    last.reportByteSize = Buffer.byteLength(last.reportText);
    const input = pageFor(instanceId, solverId, members);
    const proof = await verifyLegacyReportCustodyPage({ ...input, access: input.access("registered-get") });
    await expect(applyLegacyReportCustodyPage(fixture.db, proof, { apply: true, readersReady: true }))
      .rejects.toThrow("Legacy source differs from registered restore");
    expect(await fixture.db.execute(sql`SELECT id FROM progressive_report_archive_bundles WHERE sim_job_id=${fixture.executionId}::uuid`)).toEqual([]);
    expect(await fixture.db.execute(sql`SELECT sequence::integer AS sequence,archived_at,archive_bundle_id
      FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid ORDER BY sequence`))
      .toEqual([1,2,3].map((sequence) => ({ sequence, archived_at: null, archive_bundle_id: null })));
  });
});

it("binds repeated inline scientific text to every original row, signature and committed member", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const all = await membersFor(fixture.db, fixture.executionId);
    const prior = all[0]!, second = all[1]!;
    const prefix = '{"report": ';
    expect(second.rowText.startsWith(prefix + second.reportText)).toBe(true);
    const tail = second.rowText.slice(prefix.length + second.reportText.length);
    const verify = async (members: LegacyReportMember[]) => {
      const input = pageFor(instanceId, solverId, members);
      return verifyLegacyReportCustodyPage({ ...input, access: input.access("hub-local-reader") });
    };
    const changed = (reportText: string, rowText: string): LegacyReportMember => ({
      ...second, reportText, reportSha256: digest(reportText), reportByteSize: Buffer.byteLength(reportText),
      rowText, rowSha256: digest(rowText),
    });
    // Each invalid example has correct archive byte digests. Neither a coincident
    // large result nor its placement in a row authenticates a changed envelope.
    for (const body of [
      second.reportText.replace('"sequence": 2', '"sequence": 3'),
      second.reportText.replace('"chord": 0.987654', '"chord": 0.987655'),
    ]) {
      expect(body).not.toBe(second.reportText);
      await expect(verify([prior, changed(body, prefix + body + tail)])).rejects.toThrow(/signature/);
    }
    await expect(verify([prior, changed(second.reportText, prefix + second.reportText + ',"report":null' + tail)]))
      .rejects.toThrow(/JSON/);
    const otherRow = tail.replace('"sequence": 2', '"sequence": 3');
    expect(otherRow).not.toBe(tail);
    await expect(verify([prior, changed(second.reportText, prefix + second.reportText + otherRow)]))
      .rejects.toThrow(/source row/);
    // Older JSON layouts still verify by the full parser, including unknown
    // fields, Unicode and the fixture's number outside JavaScript's safe range.
    const alternate = changed(second.reportText, '{ "report": ' + second.reportText + tail);
    expect((await verify([prior, alternate])).memberProofs[1]!.rowSha256).toBe(alternate.rowSha256);

    const proof = await verify(all);
    expect(proof.memberProofs.map(m => [m.sequence, m.contentSignature, m.reportSha256, m.rowSha256]))
      .toEqual(all.map(m => [m.sequence, m.contentSignature, m.reportSha256, m.rowSha256]));
    const applied = await applyLegacyReportCustodyPage(fixture.db, proof, { apply: true, readersReady: true });
    expect(applied.receipt).toMatchObject({ compactedReports: all.length, compactedConflicts: 0 });
    expect((await applyLegacyReportCustodyPage(fixture.db, await verify(all), { apply: true, readersReady: true })).receipt)
      .toMatchObject({ compactedReports: 0, replayedMembers: all.length });
  }, { normalized: false, reportCount: 5, nullPrefix: 0 });
});

it("requires a fresh product read again instead of replaying an old saved receipt as authority", async () => {
  await withArchiveFixture(client, "worker", async (fixture) => {
    const { instanceId, solverId } = await setup(fixture);
    const input = pageFor(instanceId, solverId, await membersFor(fixture.db, fixture.executionId));
    const proof = await verifyLegacyReportCustodyPage({ ...input, access: input.access("registered-get") });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300_001);
    try { expect(() => legacyReportCustodySql(proof, { apply: true, readersReady: true })).toThrow("fresh successful product read"); }
    finally { clock.mockRestore(); }
    expect(() => legacyReportCustodySql({ ...proof }, { apply: true, readersReady: true })).toThrow("fresh successful product read");
  });
});
