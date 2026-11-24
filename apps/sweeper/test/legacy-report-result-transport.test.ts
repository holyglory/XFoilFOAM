import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  LegacyResultTransport,
  legacyResultMemberSql,
  type LegacyResultReference,
} from "../src/legacy-report-result-transport";
import { LegacySshReader } from "../src/legacy-report-storage";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const executionId = randomUUID(),
  solverId = randomUUID();
const result =
  '{"large": 9007199254740993123456789, "scale": 1.0000, "nullable": null, "text": "' +
  "stored result 🌬️\\n".repeat(16384) +
  '"}';

function packet(
  sequence: number,
  options: {
    previous?: LegacyResultReference;
    normalized?: boolean;
    execution?: string;
  } = {},
) {
  const execution = options.execution ?? executionId;
  const reportPrefix = `{"version": 1, "executionId": "${execution}", "sequence": ${sequence}, "result": `;
  const reportSuffix = ', "status": {"unchanged": null}}';
  const reportText = reportPrefix + result + reportSuffix;
  const rowPrefix = `{"sim_job_id": "${execution}", "report": ` + reportPrefix;
  const rowSuffix =
    reportSuffix + ', "metadata": {"reason": null, "scale": 1.0000}}';
  const rowText = options.normalized
    ? `{"report": {"result": {"state": "failed"}}, "result_payload_hash": "${hash(result)}", "sequence": ${sequence}}`
    : rowPrefix + result + rowSuffix;
  const member = {
    kind: "report" as const,
    executionId: execution,
    sequence,
    contentSignature: hash(reportText),
    solverId,
    rowText,
    rowSha256: hash(rowText),
    reportText,
    reportSha256: hash(reportText),
    reportByteSize: Buffer.byteLength(reportText),
  };
  const ref: LegacyResultReference = {
    kind: member.kind,
    executionId: execution,
    sequence,
    contentSignature: member.contentSignature,
    sha256: hash(result),
    byteSize: Buffer.byteLength(result),
  };
  const { rowText: _row, reportText: _report, ...metadata } = member;
  return {
    member,
    ref,
    wire: {
      ...metadata,
      transport: "legacy-result-transport-v1",
      mode: options.previous ? "reuse" : "define",
      rowByteSize: Buffer.byteLength(rowText),
      row: options.normalized
        ? { text: rowText }
        : { prefix: rowPrefix, suffix: rowSuffix },
      report: { prefix: reportPrefix, suffix: reportSuffix },
      member: { ...member, rowText: null, reportText: null },
      result: options.previous ?? { ...ref, text: result },
    } as Record<string, unknown>,
  };
}

it("sends one result definition for twelve sparse observations and independently verifies every reconstructed row and report", async () => {
  const sequences = [1, 3, 8, 10, 15, 21, 34, 55, 89, 144, 233, 377];
  let previous: LegacyResultReference | undefined;
  const fixtures = sequences.map((sequence, index) => {
    const item = packet(sequence, { previous, normalized: index % 2 === 1 });
    previous = item.ref;
    return item;
  });
  let at = 0;
  const query = vi.fn(async () => [fixtures[at++]!.wire]);
  const transport = new LegacyResultTransport({ query });
  for (const item of fixtures) {
    const [restored] = await transport.readMember(
      executionId,
      "report",
      item.member.sequence,
      4 * 1024 ** 2,
    );
    expect(restored).toEqual(item.member);
    expect(Object.keys(restored!)).toEqual(Object.keys(item.member));
    expect(hash(JSON.stringify(restored))).toBe(
      hash(JSON.stringify(item.member)),
    );
  }
  expect(transport.stats).toMatchObject({
    definitions: 1,
    reuses: 11,
    resultBytesReceived: Buffer.byteLength(result),
  });
  expect(
    fixtures
      .slice(1)
      .every((item) => Buffer.byteLength(JSON.stringify(item.wire)) < 4096),
  ).toBe(true);
  expect(query).toHaveBeenCalledTimes(12);
});

it.each([
  "row-hash",
  "row-size",
  "report-hash",
  "report-size",
  "result-hash",
  "template",
])(
  "rejects a changed %s proof without accepting or caching the damaged member",
  async (changed) => {
    const first = packet(1),
      second = packet(3, { previous: first.ref });
    const wire = structuredClone(second.wire);
    if (changed === "row-hash") {
      wire.rowSha256 = "0".repeat(64);
      (wire.member as Record<string, unknown>).rowSha256 = wire.rowSha256;
    }
    if (changed === "row-size") wire.rowByteSize = Number(wire.rowByteSize) + 1;
    if (changed === "report-hash") {
      wire.reportSha256 = "0".repeat(64);
      (wire.member as Record<string, unknown>).reportSha256 = wire.reportSha256;
    }
    if (changed === "report-size") {
      wire.reportByteSize = Number(wire.reportByteSize) + 1;
      (wire.member as Record<string, unknown>).reportByteSize =
        wire.reportByteSize;
    }
    if (changed === "result-hash")
      (wire.result as Record<string, unknown>).sha256 = "0".repeat(64);
    if (changed === "template")
      (wire.row as Record<string, unknown>).suffix = " altered";
    const query = vi
      .fn()
      .mockResolvedValueOnce([first.wire])
      .mockResolvedValueOnce([wire])
      .mockResolvedValueOnce([second.wire]);
    const transport = new LegacyResultTransport({ query });
    expect(
      await transport.readMember(executionId, "report", 1, 4 * 1024 ** 2),
    ).toEqual([first.member]);
    await expect(
      transport.readMember(executionId, "report", 3, 4 * 1024 ** 2),
    ).rejects.toThrow();
    expect(transport.stats.reuses).toBe(0);
    expect(
      await transport.readMember(executionId, "report", 3, 4 * 1024 ** 2),
    ).toEqual([second.member]);
  },
);

it.each([
  "unknown-reference",
  "cross-execution",
  "wrong-sequence",
  "wrong-signature",
  "repeated-definition",
])("refuses %s result references", async (changed) => {
  const first = packet(1),
    second = packet(3, { previous: first.ref });
  const wire = structuredClone(second.wire);
  const ref = wire.result as Record<string, unknown>;
  if (changed === "cross-execution") ref.executionId = randomUUID();
  if (changed === "wrong-sequence") ref.sequence = 2;
  if (changed === "wrong-signature") ref.contentSignature = "0".repeat(64);
  if (changed === "repeated-definition") ref.text = result;
  const query = vi
    .fn()
    .mockResolvedValueOnce(
      changed === "unknown-reference" ? [wire] : [first.wire],
    )
    .mockResolvedValueOnce([wire]);
  const transport = new LegacyResultTransport({ query });
  if (changed !== "unknown-reference")
    await transport.readMember(executionId, "report", 1, 4 * 1024 ** 2);
  await expect(
    transport.readMember(executionId, "report", 3, 4 * 1024 ** 2),
  ).rejects.toThrow();
});

it("bounds reconstructed bytes even when the reused result costs almost no wire bytes", async () => {
  const first = packet(1),
    second = packet(3, { previous: first.ref });
  const query = vi
    .fn()
    .mockResolvedValueOnce([first.wire])
    .mockResolvedValueOnce([second.wire]);
  const transport = new LegacyResultTransport({ query });
  await transport.readMember(executionId, "report", 1, 4 * 1024 ** 2);
  const decoded =
    Number(second.wire.rowByteSize) + second.member.reportByteSize;
  await expect(
    transport.readMember(executionId, "report", 3, decoded - 1),
  ).rejects.toThrow(/decoded.*byte budget/);
  expect(transport.stats.reuses).toBe(0);
});

it("retains the original full member path without parsing or rewriting null/absent JSON", async () => {
  for (const reportText of [
    '{"result": null, "n": 9007199254740993123456789}',
    '{"n": 1.0000}',
  ]) {
    const full = packet(1).member;
    const rowText = '{"report": ' + reportText + "}";
    const member = {
      ...full,
      contentSignature: hash(reportText),
      rowText,
      rowSha256: hash(rowText),
      reportText,
      reportSha256: hash(reportText),
      reportByteSize: Buffer.byteLength(reportText),
    };
    const query = vi.fn().mockResolvedValue([
      {
        transport: "legacy-result-transport-v1",
        mode: "full",
        member,
        rowByteSize: Buffer.byteLength(member.rowText),
      },
    ]);
    const transport = new LegacyResultTransport({ query });
    expect(
      await transport.readMember(executionId, "report", 1, 4 * 1024 ** 2),
    ).toEqual([member]);
    expect(transport.stats).toMatchObject({
      definitions: 0,
      reuses: 0,
      fullMembers: 1,
    });
  }
});

it("uses bounded indexed read-only SQL with C text comparison and no server-installed functions or character loops", () => {
  const first = packet(1);
  const sql = legacyResultMemberSql(
    { executionId, kind: "report", sequence: 3 },
    4 * 1024 ** 2,
    first.ref,
  );
  expect(sql).toMatch(
    /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/,
  );
  expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
  expect(sql).toContain('COLLATE "C"');
  expect(sql).toContain("m.payload_hash=p.payload_hash");
  expect(sql).toContain("octet_length");
  expect(sql).toContain("sha256(convert_to");
  expect(sql).toContain("r.sequence=3");
  expect(sql).toContain("r.sequence=1");
  expect(sql).not.toMatch(
    /\b(?:CREATE|INSERT|UPDATE|DELETE|ALTER|DO|LOOP|generate_series)\b/i,
  );
  expect(() =>
    legacyResultMemberSql({ executionId, kind: "report", sequence: 3 }, 1024, {
      ...first.ref,
      executionId: randomUUID(),
    }),
  ).toThrow(/exact execution/);
});

it("keeps the existing SSH command and refuses unsafe host/container inputs without making a connection", async () => {
  const reader = new LegacySshReader("existing-worker-alias", "postgres");
  expect(reader.command).toBe(
    "docker exec -i postgres psql -X -w -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb",
  );
  expect(reader.connectionCount).toBe(0);
  expect(reader.responseBytes).toBe(0);
  expect(reader.resultTransportStats).toMatchObject({
    definitions: 0,
    reuses: 0,
  });
  await reader.close();
  expect(() => new LegacySshReader("-oProxyCommand=bad", "postgres")).toThrow();
  expect(
    () => new LegacySshReader("existing-worker-alias", "postgres;bad"),
  ).toThrow();
});

it("only shares a signed result after matching its complete PG bytes and canonical envelope prefix", async () => {
  const { LegacyOriginSigner } = await import("@aerodb/db/legacy-report-signature");
  const { parseReportJson, canonicalReportJson, reportTextIdentity } = await import("@aerodb/db/progressive-report-archive");
  const signer = new LegacyOriginSigner();
  const solver = "owner", job = "job";
  const body = (seq: number, result: string, extra = "") =>
    `{"result": ${result}, "solverId": "owner", "executionId": "job", "sequence": ${seq}${extra}}`;
  const signed = (text: string) => reportTextIdentity(canonicalReportJson(parseReportJson(text))).sha256;
  const result = '{"wide": 90071992547409931234567891}';
  const repeats: boolean[] = [];
  for (const [index, text] of [
    body(1, result), body(2, result), body(3, result, ', "before": null'),
    body(4, result.replace("7891", "7892")), body(5, result, ', "nested": {"result":null}'), body(6, "null"),
    body(7, '{"decimal":1.0}'), body(8, '{"decimal":1.00}'), body(9, '{"decimal":1.00}'),
  ].entries()) {
    expect(signer.matches(text, job, solver, index + 1, signed(text), (report, token, repeated) => {
      repeats.push(repeated);
      expect(report.executionId).toBe(job);
      if (repeated) {
        expect(report.result).toBeNull();
        expect(token).toBe(index === 1 ? result : '{"decimal":1.00}');
      }
    })).toBe(true);
    const refused = () => { throw new Error("Unverified result reached the consumer"); };
    expect(signer.matches(text, job, solver, index + 1, "0".repeat(64), refused)).toBe(false);
    expect(signer.matches(text, job, "different", index + 1, signed(text), refused)).toBe(false);
  }
  expect(repeats).toEqual([false, true, false, false, false, false, false, false, true]);
  const once = new LegacyOriginSigner(false);
  for (const n of [1,2]) {
    const text = body(n, result);
    expect(once.matches(text, job, solver, n, signed(text), (report, token, repeated) => {
      expect(repeated).toBe(false);
      expect(report.result).not.toBeNull();
      expect(token).toBe(result);
    })).toBe(true);
  }
});
