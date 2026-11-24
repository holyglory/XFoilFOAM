import { afterEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DB, ProgressiveEvidenceCustodyReceipt } from "@aerodb/db";
import { canonicalAnalysisJson } from "@aerodb/db";
import { brokeredRetentionMetadata } from "../../../packages/db/test/progressive-restart-retention-fixture";
import type { EngineStripJobResponse } from "@aerodb/engine-client";
import * as ownership from "../src/progressive-remote-jobs";
import { reclaimProgressiveRestartState } from "../src/progressive-restart-retention";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const executionId = "cf591f48-7ddf-4a80-b039-0aa0b4380556";
const receipt = {
  job_id: executionId,
  unknown_entries: [],
  bytes_freed: 4096,
  files_removed: 2,
  kept_case_state: false,
};

function fixture(
  blocked = true,
  candidates = true,
  evidenceBase = "a0/evidence",
) {
  const signed = {
    receipt: {
      schemaVersion: 1,
      kind: "hub-progressive-evidence-custody",
      source: {
        solverId: executionId,
        promiseId: executionId,
        engineJobId: executionId,
        engineCaseSlug: "c1_u25",
        aoaDeg: 1e-6,
        remoteResultId: executionId,
        remoteResultAttemptId: executionId,
        progressiveEvidence: {
          sequence: 3,
          reportContentSignature: "a".repeat(64),
          pointContentSignature: "b".repeat(64),
        },
      },
      brokeredUploadId: executionId,
      remote: {
        bucket: "fixture",
        objectKey: "evidence/fixture",
        generation: "123",
        crc32c: "AAAAAA==",
        manifestSha256: "d".repeat(64),
        manifestByteSize: 128,
        storedSha256: "e".repeat(64),
        storedByteSize: 500,
        tarSha256: "f".repeat(64),
        tarByteSize: 1500,
        zstdLevel: 3,
        bundledFileCount: 1,
      },
      canonical: {
        resultId: executionId,
        resultAttemptId: executionId,
        artifactId: executionId,
        archiveId: executionId,
      },
      boundAt: "2026-11-17T00:00:00Z",
    } satisfies ProgressiveEvidenceCustodyReceipt,
    receiptHmac: "c".repeat(64),
  };
  const files = brokeredRetentionMetadata(signed, evidenceBase);
  const stored = { signed, completed: true };
  const report = {
    result: {
      job_id: executionId,
      state: "completed",
      polars: [
        {
          points: [
            {
              case_slug: "c1_u25",
              evidence_artifacts: [
                {
                  kind: "manifest",
                  path: `${evidenceBase}/evidence_manifest.json`,
                  sha256: signed.receipt.remote.manifestSha256,
                  byte_size: signed.receipt.remote.manifestByteSize,
                },
              ],
            },
          ],
        },
      ],
    },
    status: { state: "completed" },
    stopProof: { execution_stopped: true },
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce([{ disk_admission_blocked: blocked }])
    .mockResolvedValueOnce(
      candidates ? [{ id: executionId, sequence: 3, report }] : [],
    )
    .mockImplementation(async (query) => {
      const compiled = new PgDialect().sqlToQuery(query);
      if (compiled.sql.includes("AS retained")) {
        expect(compiled.sql).toContain("reclaim.completed_at IS NOT NULL");
        return [
          {
            retained:
              stored.completed &&
              compiled.params.includes(executionId) &&
              compiled.params.includes(
                signed.receipt.source.progressiveEvidence.pointContentSignature,
              ) &&
              compiled.params.some(
                (value) =>
                  typeof value === "string" &&
                  value.startsWith('{"receipt":') &&
                  canonicalAnalysisJson(JSON.parse(value)) ===
                    canonicalAnalysisJson(stored.signed),
              ),
          },
        ];
      }
      return [];
    });
  const db = {
    execute,
    transaction: (run: (connection: DB) => Promise<unknown>) =>
      run(db as unknown as DB),
  } as unknown as DB;
  const stripJob = vi.fn(async (): Promise<EngineStripJobResponse> => receipt);
  const fileUrl = vi.fn(
    (id: string, path: string) =>
      `http://engine.invalid/jobs/${id}/files/${path}`,
  );
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    const prefix = `http://engine.invalid/jobs/${executionId}/files/cases/c1_u25/${evidenceBase}/`;
    const text = url.startsWith(prefix)
      ? files[url.slice(prefix.length)]
      : undefined;
    return new Response(text, { status: text === undefined ? 404 : 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  const owned = vi
    .spyOn(ownership, "assertProgressiveWorkerEvidenceJob")
    .mockResolvedValue(true);
  return {
    db,
    execute,
    owned,
    files,
    signed,
    stored,
    report,
    fetcher,
    engine: { stripJob, fileUrl },
  };
}

it("does not strip without pressure or a terminal candidate", async () => {
  for (const [blocked, candidates] of [
    [false, true],
    [true, false],
  ]) {
    const state = fixture(blocked, candidates);
    expect(
      await reclaimProgressiveRestartState(state.db, state.engine),
    ).toEqual({ stripped: 0, bytesFreed: 0 });
    expect(state.engine.stripJob).not.toHaveBeenCalled();
  }
});

it("authenticates exact worker ownership and requests only checkpoint stripping", async () => {
  const state = fixture();
  expect(await reclaimProgressiveRestartState(state.db, state.engine)).toEqual({
    stripped: 1,
    bytesFreed: 4096,
  });
  expect(state.owned).toHaveBeenCalledWith(
    state.db,
    expect.objectContaining({
      simJobId: executionId,
      engineJobId: executionId,
      reportSequence: 3,
    }),
  );
  expect(state.engine.stripJob).toHaveBeenCalledWith(
    executionId,
    { keep_case_state: false },
    { timeoutMs: 30000 },
  );
  const dialect = new PgDialect();
  expect(dialect.sqlToQuery(state.execute.mock.calls[0][0]).sql).not.toContain(
    "FOR UPDATE",
  );
  const selected = dialect.sqlToQuery(state.execute.mock.calls[1][0]).sql;
  for (const guard of [
    "FOR UPDATE",
    "SKIP LOCKED",
    "stopped_engine_job_id",
    "live_jobs AS MATERIALIZED",
    "selected AS MATERIALIZED",
    "continue_from,engine_job_id",
    "ingest_lease_expires_at",
    "sim_urans_requests",
    "sim_precalc_obligations",
    "sim_urans_verify_queue",
  ])
    expect(selected).toContain(guard);
  const sourcePlanGuard = selected.indexOf("'closedProgressiveFiles'");
  expect(sourcePlanGuard).toBeGreaterThan(0);
  expect(sourcePlanGuard).toBeLessThan(selected.indexOf('ORDER BY job."updatedAt"'));
  const saved = dialect.sqlToQuery(state.execute.mock.calls[2][0]);
  expect(saved.sql).toContain("strip_report=");
  expect(saved.sql).not.toContain("ingestedAt");
});

it.each([false, "foreign report"])(
  "refuses missing or changed evidence ownership %s",
  async (result) => {
    const state = fixture();
    if (result === false) state.owned.mockResolvedValue(false);
    else state.owned.mockRejectedValue(new Error(String(result)));
    await expect(
      reclaimProgressiveRestartState(state.db, state.engine),
    ).rejects.toThrow();
    expect(state.engine.stripJob).not.toHaveBeenCalled();
  },
);

it.each([
  { ...receipt, job_id: "foreign" },
  { ...receipt, unknown_entries: undefined },
  { ...receipt, bytes_freed: -1 },
  { ...receipt, kept_case_state: true },
])("does not certify malformed engine receipts", async (bad) => {
  const state = fixture();
  state.engine.stripJob.mockResolvedValue(bad);
  expect(
    await reclaimProgressiveRestartState(state.db, state.engine),
  ).toMatchObject({ stripped: 0, bytesFreed: 0, error: expect.any(String) });
  const saved = new PgDialect().sqlToQuery(state.execute.mock.calls[2][0]).sql;
  expect(saved).not.toContain("strip_report");
});

it("preserves a refused archive and does not certify unknown retained entries", async () => {
  const state = fixture();
  state.engine.stripJob.mockRejectedValueOnce(
    new Error("409 archive authentication refused"),
  );
  expect(
    await reclaimProgressiveRestartState(state.db, state.engine),
  ).toMatchObject({ stripped: 0, bytesFreed: 0 });
  const partial = fixture();
  partial.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: ["forensic-source"],
  });
  expect(
    await reclaimProgressiveRestartState(partial.db, partial.engine),
  ).toEqual({ stripped: 0, bytesFreed: 4096 });
  expect(
    new PgDialect().sqlToQuery(partial.execute.mock.calls[2][0]).sql,
  ).toContain("stripped_at=NULL");
});

it.each(["evidence", "a0/evidence", "transient_a0/evidence"])(
  "completes checkpoint reclamation with retained brokered receipts in the reported %s directory",
  async (base) => {
    const state = fixture(true, true, base);
    const retained = [
      "brokered_hub_binding.database.json",
      "brokered_local_reclaim.intent.json",
      "brokered_local_reclaim.json",
    ].map((name) => `cases/c1_u25/${base}/${name}`);
    const original = { ...receipt, bytes_freed: 0, unknown_entries: retained };
    expect(state.files["brokered_local_reclaim.intent.json"]).toContain(
      "1e-06",
    );
    state.engine.stripJob.mockResolvedValue(original);
    expect(
      await reclaimProgressiveRestartState(state.db, state.engine),
    ).toEqual({
      stripped: 1,
      bytesFreed: 0,
    });
    const saved = new PgDialect().sqlToQuery(
      state.execute.mock.calls.at(-1)![0],
    );
    expect(saved.sql).toContain("stripped_at=clock_timestamp()");
    expect(saved.params).toContain(JSON.stringify(original));
    expect(state.engine.stripJob).toHaveBeenCalledWith(
      executionId,
      { keep_case_state: false },
      { timeoutMs: 30000 },
    );
  },
);

it.each([
  "brokered_local_reclaim.json",
  "/cases/c1_u25/a0/evidence/brokered_local_reclaim.json",
  "cases/foreign/a0/evidence/brokered_local_reclaim.json",
  "cases/c1_u25/a1/evidence/brokered_local_reclaim.json",
  "cases/c1_u25/a0/evidence/engine_evidence.tar.zst",
  "cases/c1_u25/a0/evidence/brokered_local_reclaim.json/child",
  "cases/c1_u25/a0/evidence/../evidence/brokered_local_reclaim.json",
  "cases/c1_u25/a0/evidence\\brokered_local_reclaim.json",
])(
  "keeps foreign or unrecognized retained paths incomplete: %s",
  async (path) => {
    const state = fixture();
    state.engine.stripJob.mockResolvedValue({
      ...receipt,
      unknown_entries: [
        "cases/c1_u25/a0/evidence/brokered_hub_binding.database.json",
        path,
      ],
    });
    expect(
      await reclaimProgressiveRestartState(state.db, state.engine),
    ).toEqual({
      stripped: 0,
      bytesFreed: 4096,
    });
    expect(
      new PgDialect().sqlToQuery(state.execute.mock.calls[2][0]).sql,
    ).toContain("stripped_at=NULL");
  },
);

const metadataEntries = [
  "brokered_hub_binding.database.json",
  "brokered_local_reclaim.intent.json",
  "brokered_local_reclaim.json",
].map((name) => `cases/c1_u25/a0/evidence/${name}`);

it.each([
  [
    "foreign authorization",
    (state: ReturnType<typeof fixture>) => {
      const ack = JSON.parse(state.files["brokered_hub_binding.database.json"]);
      ack.authorization.jobId = "foreign";
      state.files["brokered_hub_binding.database.json"] = JSON.stringify(ack);
    },
  ],
  [
    "corrupt intent",
    (state: ReturnType<typeof fixture>) => {
      const intent = JSON.parse(
        state.files["brokered_local_reclaim.intent.json"],
      );
      intent.paths[0].treeSha256 = "a".repeat(64);
      state.files["brokered_local_reclaim.intent.json"] =
        JSON.stringify(intent);
    },
  ],
  [
    "corrupt checksum",
    (state: ReturnType<typeof fixture>) => {
      const completed = JSON.parse(state.files["brokered_local_reclaim.json"]);
      completed.intentSha256 = "a".repeat(64);
      state.files["brokered_local_reclaim.json"] = JSON.stringify(completed);
    },
  ],
  [
    "incomplete database reclaim",
    (state: ReturnType<typeof fixture>) => {
      state.stored.completed = false;
    },
  ],
  [
    "changed database custody",
    (state: ReturnType<typeof fixture>) => {
      state.stored.signed = structuredClone(state.signed);
      state.stored.signed.receiptHmac = "f".repeat(64);
    },
  ],
  [
    "partial metadata",
    (state: ReturnType<typeof fixture>) => {
      delete state.files["brokered_local_reclaim.json"];
    },
  ],
  [
    "invalid JSON",
    (state: ReturnType<typeof fixture>) => {
      state.files["brokered_local_reclaim.intent.json"] = "{";
    },
  ],
  [
    "oversized metadata",
    (state: ReturnType<typeof fixture>) => {
      state.files["brokered_local_reclaim.intent.json"] = " ".repeat(65537);
    },
  ],
] as const)(
  "leaves %s retryable and preserves the engine report",
  async (_name, change) => {
    const state = fixture();
    change(state);
    const original = { ...receipt, unknown_entries: metadataEntries };
    state.engine.stripJob.mockResolvedValue(original);
    expect(
      await reclaimProgressiveRestartState(state.db, state.engine),
    ).toMatchObject({ stripped: 0, bytesFreed: 4096 });
    const saved = new PgDialect().sqlToQuery(
      state.execute.mock.calls.at(-1)![0],
    );
    expect(saved.sql).toContain("stripped_at=NULL");
    expect(saved.params).toContain(JSON.stringify(original));
  },
);

it("requires a file reader and uses one deadline for every metadata request", async () => {
  const unavailable = fixture();
  unavailable.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: metadataEntries,
  });
  expect(
    await reclaimProgressiveRestartState(unavailable.db, {
      stripJob: unavailable.engine.stripJob,
    }),
  ).toEqual({ stripped: 0, bytesFreed: 4096 });
  expect(unavailable.fetcher).not.toHaveBeenCalled();
  const state = fixture();
  state.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: metadataEntries,
  });
  const deadline = vi.spyOn(AbortSignal, "timeout");
  expect(
    await reclaimProgressiveRestartState(state.db, state.engine),
  ).toMatchObject({ stripped: 1 });
  expect(deadline).toHaveBeenCalledOnce();
  expect(deadline).toHaveBeenCalledWith(10000);
  const signal = deadline.mock.results[0].value;
  expect(state.fetcher).toHaveBeenCalledTimes(3);
  for (const call of state.fetcher.mock.calls)
    expect(call[1]).toEqual({ signal, redirect: "error" });
});

it("bounds directory fan-out before reading any retained metadata", async () => {
  const state = fixture();
  const point = state.report.result.polars[0].points[0];
  const manifest = point.evidence_artifacts[0];
  point.evidence_artifacts = Array.from({ length: 129 }, (_, index) => ({
    ...manifest,
    path: `a${index}/evidence/evidence_manifest.json`,
  }));
  state.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: Array.from(
      { length: 129 },
      (_, index) =>
        `cases/c1_u25/a${index}/evidence/brokered_local_reclaim.json`,
    ),
  });
  expect(await reclaimProgressiveRestartState(state.db, state.engine)).toEqual({
    stripped: 0,
    bytesFreed: 4096,
  });
  expect(state.fetcher).not.toHaveBeenCalled();
});

it("does not certify metadata when the shared read deadline expires", async () => {
  const state = fixture();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let reads = 0;
  state.fetcher.mockImplementation(async (_url, options) => {
    const signal = options!.signal!;
    if (++reads === 3) deadline.abort();
    if (signal.aborted) throw new Error("deadline");
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("deadline")), {
        once: true,
      }),
    );
  });
  state.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: metadataEntries,
  });
  expect(
    await reclaimProgressiveRestartState(state.db, state.engine),
  ).toMatchObject({ stripped: 0, bytesFreed: 4096, error: expect.any(String) });
  expect(
    new PgDialect().sqlToQuery(state.execute.mock.calls.at(-1)![0]).sql,
  ).toContain("stripped_at=NULL");
});

it("requires the complete validated set even when only one receipt is reported unknown", async () => {
  const state = fixture();
  state.engine.stripJob.mockResolvedValue({
    ...receipt,
    unknown_entries: [metadataEntries[0]],
  });
  expect(await reclaimProgressiveRestartState(state.db, state.engine)).toEqual({
    stripped: 1,
    bytesFreed: 4096,
  });
  expect(state.fetcher).toHaveBeenCalledTimes(3);
});
