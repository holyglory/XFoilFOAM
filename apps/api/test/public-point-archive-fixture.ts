import {
  analysisContentHash,
  syncApiPermissions,
  type DB,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, vi } from "vitest";
import { env } from "../src/env";
import { brokerArchiveStorage } from "../src/report-archive-broker";
import { ReportArchiveVerifier } from "../src/report-archive-verifier";
import { gatedArchiveVerifier } from "./gated-archive-verifier";

/** Exercise both real HTTP routes on the same listener. No storage write is
 * possible: the final member has a competing signature. */
export async function verifyPublicPointDuringArchive(
  db: DB,
  base: string,
  token: string,
  report: ProgressiveRemoteReport,
  slug: string,
  resultId: string,
) {
  const point =
    base +
    "/api/airfoils/" +
    encodeURIComponent(slug) +
    "/sim?resultId=" +
    resultId;
  const expected = await fetch(point, { signal: AbortSignal.timeout(6000) });
  expect(expected.status).toBe(200);
  const original = await expected.text();
  const pointBody = JSON.parse(original);
  expect(pointBody.resultId).toBe(resultId);
  expect(pointBody.history.t).toHaveLength(400);

  const hash = (s: string | Buffer) =>
    createHash("sha256").update(s).digest("hex");
  const lines = [report, { ...report, sequence: report.sequence + 1 }].map(
    (value, i) => {
      const text = JSON.stringify(value);
      return JSON.stringify({
        sourceKind: "worker",
        kind: "report",
        executionId: value.executionId,
        sequence: value.sequence,
        report: value,
        contentSignature: i === 0 ? analysisContentHash(value) : "0".repeat(64),
        reportSha256: hash(text),
        reportByteSize: Buffer.byteLength(text),
      });
    },
  );
  const bytes = gzipSync(lines.join("\n") + "\n");
  const url = `${base}/api/sync/v1/progressive-executions/${report.executionId}/report-archives/${hash(bytes)}?byteSize=${bytes.length}`;
  const kind = eq(syncApiPermissions.dataType, "evidence_artifacts");
  const [prior] = await db
    .select({ canPush: syncApiPermissions.canPush })
    .from(syncApiPermissions)
    .where(kind);
  const bucket = env.evidenceBucket;
  const noCloudWrite = vi
    .spyOn(brokerArchiveStorage(), "bucket")
    .mockImplementation(() => {
      throw new Error("Invalid archive reached GCS");
    });
  const gate = gatedArchiveVerifier();
  const verifier = vi
    .spyOn(ReportArchiveVerifier.prototype, "verify")
    .mockImplementationOnce((archive, signal) =>
      gate.verifier.verify(archive, signal),
    );
  try {
    env.evidenceBucket = "archive-point-fixture";
    await db.update(syncApiPermissions).set({ canPush: true }).where(kind);
    const staged = gate.staged();
    const uploading = fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/gzip",
        "x-xfoilfoam-solver-token": token,
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(8000),
    });
    await Promise.race([
      staged,
      uploading.then((response) => {
        throw Error(
          `Signed archive finished before staging (${response.status})`,
        );
      }),
    ]);
    expect(gate.workers).toHaveLength(1);
    const reading = await fetch(point, { signal: AbortSignal.timeout(6000) });
    expect(reading.status).toBe(200);
    expect(await reading.text()).toBe(original);
    gate.release();
    const invalid = await uploading;
    expect(invalid.status).toBe(409);
    expect(await invalid.text()).toContain("exact dispatch scope or content");
    expect(noCloudWrite).not.toHaveBeenCalled();
  } finally {
    gate.release();
    verifier.mockRestore();
    noCloudWrite.mockRestore();
    env.evidenceBucket = bucket;
    await gate.verifier.closeIdle();
    await db.update(syncApiPermissions).set(prior).where(kind);
  }
}
