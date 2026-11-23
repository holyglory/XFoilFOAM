import { expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  progressiveReportedPointSources,
  progressiveRemotePointProjection,
  readProgressiveRemoteAssignment,
  validateProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import { indexProgressiveRemoteReport } from "@aerodb/db/progressive-remote-inventory";
import { reconcileTerminalProgressiveMirror } from "../src/progressive-terminal-mirror";

// Work in a savepoint of the independent worker fixture. Render the actual
// registered endpoint data from a second savepoint containing the hub ledger.
export async function verifyDiagnosticMirror(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  attemptId: string,
  stagedText: string,
  terminalText: string,
  base: string,
  token: string,
) {
  const id = envelope.scope.executionId;
  const staged = validateProgressiveRemoteReport(
    JSON.parse(stagedText),
    envelope,
  );
  const last = validateProgressiveRemoteReport(
    JSON.parse(terminalText),
    envelope,
  );
  const source = progressiveReportedPointSources(staged.report.result!)[0]!;
  const point = source.contentSignature;
  const payload = progressiveRemotePointProjection({
    ...source,
    envelope,
    report: staged.report,
  }).evidencePayload;
  const diagnostic = {
    kind: "retained-progressive-diagnostic",
    version: 2,
    failureKind: "infrastructure",
    executionId: id,
    sequence: staged.report.sequence,
    pointContentSignature: point,
    reportContentSignature: staged.contentSignature,
    receivedAt: new Date().toISOString(),
  };
  await db.execute(
    sql`UPDATE result_attempts SET evidence_payload=${JSON.stringify(payload)}::jsonb WHERE id=${attemptId}::uuid`,
  );
  await db.execute(sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence,content_signature)
    VALUES(${id}::uuid,${last.report.sequence},${last.contentSignature})`);
  await db.execute(sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id,point_content_signature)
    VALUES(${id}::uuid,${last.report.sequence},${attemptId}::uuid,${point})`);
  await db.execute(sql`INSERT INTO progressive_worker_hub_receipts(sim_job_id,sequence,result_attempt_id,point_content_signature,receipt)
    VALUES(${id}::uuid,${staged.report.sequence},${attemptId}::uuid,${point},${JSON.stringify(diagnostic)}::jsonb)`);
  const rollback = new Error("independent host snapshot");
  const fork = async (op: (c: DB) => Promise<void>) => {
    try {
      await db.transaction(async (t) => {
        await op(t as unknown as DB);
        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }
  };
  let hub!: NonNullable<
    Awaited<ReturnType<typeof readProgressiveRemoteAssignment>>
  >;
  await fork(async (c) => {
    await c.execute(
      sql`UPDATE sync_sweep_promises SET status='cancelled' WHERE id=${envelope.promiseId}::uuid`,
    );
    await c.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
      VALUES(${id}::uuid,${envelope.promiseId}::uuid,${envelope.solverId}::uuid,1,${envelope.contentSignature},${JSON.stringify(envelope)}::jsonb)`);
    for (const sealed of [staged, last]) {
      await c.execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report)
        VALUES(${id}::uuid,${sealed.report.sequence},${sealed.contentSignature},${JSON.stringify(sealed.report)}::jsonb)`);
      await indexProgressiveRemoteReport(c, {
        report: sealed.report,
        reportContentSignature: sealed.contentSignature,
      });
    }
    await c.execute(sql`INSERT INTO progressive_remote_diagnostic_receipts(sim_job_id,sequence,point_content_signature,receipt)
      VALUES(${id}::uuid,${staged.report.sequence},${point},${JSON.stringify(diagnostic)}::jsonb)`);
    hub = (await readProgressiveRemoteAssignment(c, {
      solverId: envelope.solverId,
      executionId: id,
    }))!;
  });
  expect(hub.terminalReceipt?.diagnosticReceiptSetSignature).toMatch(
    /^[0-9a-f]{64}$/,
  );
  function run(c: DB, remote: unknown = hub, preview = false) {
    return reconcileTerminalProgressiveMirror(c, {
      promiseId: envelope.promiseId,
      preview,
      fetcher: async (input, init) => {
        expect(String(input)).toBe(base + "/progressive-executions/" + id);
        expect(new Headers(init?.headers).get("x-xfoilfoam-solver-token")).toBe(
          token,
        );
        return Response.json({ assignment: remote });
      },
    });
  }
  for (const signature of [null, "0".repeat(64)])
    expect(
      (
        await run(db, {
          ...hub,
          terminalReceipt: {
            ...hub.terminalReceipt,
            diagnosticReceiptSetSignature: signature,
          },
        })
      ).outcome,
    ).toBe("no-terminal-proof");
  await fork(async (c) => {
    await c.execute(
      sql`UPDATE result_attempts SET evidence_payload=evidence_payload||'{"evidence_artifacts":[{"kind":"manifest"}]}'::jsonb WHERE id=${attemptId}::uuid`,
    );
    expect((await run(c)).outcome).toBe("unsettled");
  });
  expect(await run(db, hub, true)).toMatchObject({
    outcome: "eligible",
    diagnosticReceipts: 1,
  });
  expect(await run(db)).toMatchObject({
    outcome: "reconciled",
    diagnosticReceiptSetSignature:
      hub.terminalReceipt!.diagnosticReceiptSetSignature,
  });
  const [kept] =
    await db.execute(sql`SELECT a.id,a.status,a.valid_for_polar,h.receipt,
    (SELECT count(*)::int FROM progressive_worker_archive_receipts raw WHERE raw.sim_job_id=${id}::uuid) raw_count
    FROM result_attempts a JOIN progressive_worker_hub_receipts h ON h.result_attempt_id=a.id WHERE a.id=${attemptId}::uuid`);
  expect(kept).toEqual({
    id: attemptId,
    status: "failed",
    valid_for_polar: false,
    receipt: diagnostic,
    raw_count: 0,
  });
}
