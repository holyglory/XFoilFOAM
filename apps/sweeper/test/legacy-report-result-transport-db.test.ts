import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createClient } from "@aerodb/db/client";
import {
  legacyMemberSql,
  type LegacyReportMember,
  type LegacyReportScope,
} from "@aerodb/db/legacy-report-storage";
import { afterAll, beforeAll, expect, it } from "vitest";
import { LegacyResultTransport } from "../src/legacy-report-result-transport";
import {
  readLegacyPage,
  encodeLegacyPage,
  decodeLegacyPage,
  type LegacySqlReader,
  type LegacyBackupPage,
} from "../src/legacy-report-storage";

const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
let client: ReturnType<typeof createClient> | undefined;

// This test needs its own native empty-Postgres case, separate from the existing
// legacy-report-storage fixture. Never remove or replace an installed schema.
beforeAll(async () => {
  if (
    process.env.LEGACY_REPORT_STORAGE_DISPOSABLE_DB !== "1" ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Use a governed empty PostgreSQL case with LEGACY_REPORT_STORAGE_DISPOSABLE_DB=1",
    );
  client = createClient({ max: 1 });
  const [existing] =
    await client.sql`SELECT to_regclass('public.progressive_worker_reports') AS present`;
  if (existing.present)
    throw new Error("Result transport fixture refuses existing report tables");
  await client.sql
    .unsafe(
      `
    CREATE FUNCTION reject_progressive_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
    CREATE FUNCTION protect_progressive_worker_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TABLE progressive_worker_reports(sim_job_id uuid NOT NULL,sequence bigint NOT NULL,content_signature text NOT NULL,
      report jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),acknowledged_at timestamptz,
      archived_at timestamptz,archive_bundle_id uuid,opaque_metadata jsonb,PRIMARY KEY(sim_job_id,sequence));
    CREATE TRIGGER progressive_worker_report_immutable BEFORE UPDATE ON progressive_worker_reports
      FOR EACH ROW EXECUTE FUNCTION protect_progressive_worker_report();
    CREATE TABLE progressive_remote_reports(sim_job_id uuid NOT NULL,sequence bigint NOT NULL,content_signature text NOT NULL,
      report jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(sim_job_id,sequence));
    CREATE TRIGGER progressive_remote_reports_immutable BEFORE UPDATE ON progressive_remote_reports
      FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
    CREATE TABLE progressive_worker_report_conflicts(sim_job_id uuid NOT NULL,sequence bigint NOT NULL,content_signature text NOT NULL,
      report jsonb NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),archived_at timestamptz,
      archive_bundle_id uuid,body_source_sequence bigint,PRIMARY KEY(sim_job_id,sequence));
  `,
    )
    .simple();
  await client.sql
    .unsafe(
      await readFile(
        new URL(
          "../../../packages/db/migrations/0198_progressive_report_result_payloads.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .simple();
  const alias = await readFile(
    new URL(
      "../../../packages/db/migrations/0203_redundant_report_conflicts.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const viewStart = alias.search(
    /\bCREATE(?:\s+OR\s+REPLACE)?\s+VIEW\s+progressive_worker_conflict_storage\s+AS\b/,
  );
  if (viewStart < 0)
    throw new Error(
      "Result transport fixture cannot locate the versioned conflict view",
    );
  await client.sql.unsafe(alias.slice(viewStart)).simple();
  const [view] =
    await client.sql`SELECT to_regclass('public.progressive_worker_conflict_storage') IS NOT NULL AS present`;
  expect(view.present).toBe(true);
}, 30_000);
afterAll(async () => {
  await client?.sql.end();
});

function reader() {
  const packets: Record<string, unknown>[] = [];
  const statements: string[] = [];
  let wireBytes = 0;
  const source: LegacySqlReader = {
    async query(query, maxBytes) {
      expect(query).toMatch(
        /^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/,
      );
      expect(query).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE|GRANT)\b/i,
      );
      statements.push(query);
      try {
        const result = await client!.sql.unsafe(query).simple();
        const rows = (Array.from(result) as unknown[]).flatMap((item) =>
          Array.isArray(item) ? item : [item],
        );
        const texts = rows
          .map((row) => Object.values(row as Record<string, unknown>)[0])
          .filter((value): value is string => typeof value === "string");
        const bytes = Buffer.byteLength(texts.join("\n"));
        expect(bytes).toBeLessThanOrEqual(maxBytes);
        wireBytes += bytes;
        const values = texts.map(
          (text) => JSON.parse(text) as Record<string, unknown>,
        );
        packets.push(...values);
        return values;
      } catch (error) {
        await client!.sql.unsafe("ROLLBACK");
        throw error;
      }
    },
  };
  return { source, packets, statements, wireBytes: () => wireBytes };
}

async function cohort(
  options: {
    normalized?: boolean;
    sequences?: number[];
    padding?: number;
    collision?: string;
  } = {},
) {
  const executionId = randomUUID(),
    solverId = randomUUID();
  const sequences = options.sequences ?? [
    1, 3, 8, 10, 15, 21, 34, 55, 89, 144, 233, 377,
  ];
  const result =
    '{"state":"failed","large":9007199254740993123456789,"scale":1.0000,"nullable":null,"padding":' +
    JSON.stringify("x".repeat(options.padding ?? 2 * 1024 ** 2)) +
    "}";
  await client!
    .sql`UPDATE progressive_report_storage_policy SET normalization_enabled=${options.normalized ?? false}`;
  for (const sequence of sequences) {
    const report = `{"version":1,"executionId":"${executionId}","solverId":"${solverId}","sequence":${sequence},"result":${result},"status":{"message":"source 🌬️","nullable":null${options.collision ? ',"collision":' + JSON.stringify(options.collision) : ""}}}`;
    await client!
      .sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,opaque_metadata)
      VALUES (${executionId},${sequence},${hash(report)},${report}::jsonb,'{"big":900719925474099312345678901,"scale":1.0000,"null":null}'::jsonb)`;
  }
  const scope: LegacyReportScope = {
    version: 1,
    sourceInstance: "result-transport-test",
    solverId,
    measuredAt: "2026-11-19T00:00:00Z",
    executions: [
      {
        executionId,
        reports: sequences.length,
        reportHighWater: sequences.at(-1)!,
        conflicts: 0,
        conflictHighWater: 0,
      },
    ],
  };
  return { executionId, solverId, sequences, result, scope };
}

async function snapshot(executionId: string) {
  return client!
    .sql`SELECT sequence,encode(sha256(convert_to(to_jsonb(r.*)::text,'UTF8')),'hex') AS hash
    FROM progressive_worker_reports r WHERE sim_job_id=${executionId} ORDER BY sequence`;
}

function exactMembers(
  actual: LegacyBackupPage,
  expected: LegacyBackupPage,
  layout: "source" | "decoded" = "source",
) {
  const { members: actualMembers, ...actualHeader } = actual;
  const { members: expectedMembers, ...expectedHeader } = expected;
  expect(actualHeader).toEqual(expectedHeader);
  expect(actualMembers).toHaveLength(expectedMembers.length);
  for (let index = 0; index < expectedMembers.length; index++) {
    const current = actualMembers[index]!,
      original = expectedMembers[index]!;
    const label = `${original.kind}:${original.executionId}:${original.sequence}`;
    const {
      rowText: currentRow,
      reportText: currentReport,
      ...currentMeta
    } = current;
    const {
      rowText: originalRow,
      reportText: originalReport,
      ...originalMeta
    } = original;
    expect(currentMeta, label + " metadata").toEqual(originalMeta);
    // The unchanged chunk decoder restores text slots after the serialized
    // metadata. Source members must retain PostgreSQL's complete key order;
    // decoded members must retain its metadata order and that fixed suffix.
    const expectedKeys =
      layout === "decoded"
        ? [...Object.keys(originalMeta), "rowText", "reportText"]
        : Object.keys(original);
    expect(Object.keys(current), label + " member property order").toEqual(
      expectedKeys,
    );
    expect(
      { bytes: Buffer.byteLength(currentRow), sha256: hash(currentRow) },
      label + " row text",
    ).toEqual({
      bytes: Buffer.byteLength(originalRow),
      sha256: hash(originalRow),
    });
    expect(
      { bytes: Buffer.byteLength(currentReport), sha256: hash(currentReport) },
      label + " report text",
    ).toEqual({
      bytes: Buffer.byteLength(originalReport),
      sha256: hash(originalReport),
    });
    expect(currentRow === originalRow, label + " exact row bytes").toBe(true);
    expect(
      currentReport === originalReport,
      label + " exact report bytes",
    ).toBe(true);
  }
}

function exactArchive(actual: LegacyBackupPage, expected: LegacyBackupPage) {
  exactMembers(actual, expected);
  const current = encodeLegacyPage(actual).bytes,
    original = encodeLegacyPage(expected).bytes;
  const currentRaw = gunzipSync(current),
    originalRaw = gunzipSync(original);
  expect(
    { bytes: currentRaw.length, sha256: hash(currentRaw) },
    "archive JSON bytes",
  ).toEqual({ bytes: originalRaw.length, sha256: hash(originalRaw) });
  expect(
    { bytes: current.length, sha256: hash(current) },
    "compressed archive bytes",
  ).toEqual({ bytes: original.length, sha256: hash(original) });
  expect(current.equals(original), "exact compressed archive bytes").toBe(true);
}

function verifyArchive(page: LegacyBackupPage) {
  const packed = encodeLegacyPage(page);
  const receipt = {
    version: 1 as const,
    scopeSha256: page.scopeSha256,
    sourceInstance: page.sourceInstance,
    solverId: page.solverId,
    start: page.start,
    next: page.next,
    memberCount: page.members.length,
    rawByteSize: packed.rawByteSize,
    object: {
      bucket: "test-only",
      objectKey: "unchanged-archive.jsonl.gz",
      generation: "1",
      sha256: hash(packed.bytes),
      byteSize: packed.bytes.length,
      crc32c: "AAAAAA==",
      verifiedAt: "2026-11-19T00:00:00Z",
    },
  };
  exactMembers(decodeLegacyPage(packed.bytes, receipt), page, "decoded");
}

it.each([false, true])(
  "transfers a repeated multi-MB result once for twelve normalized=%s observations without changing archive bytes or sources",
  async (normalized) => {
    const f = await cohort({ normalized });
    const before = await snapshot(f.executionId);
    const full = reader(),
      fast = reader();
    const original = await readLegacyPage(
      full.source,
      f.scope,
      undefined,
      128,
      64 * 1024 ** 2,
    );
    const transport = new LegacyResultTransport(fast.source);
    const optimized = await readLegacyPage(
      { ...fast.source, readMember: transport.readMember.bind(transport) },
      f.scope,
      undefined,
      128,
      64 * 1024 ** 2,
    );
    exactMembers(optimized, original);
    expect(optimized.members.map((member) => member.sequence)).toEqual(
      f.sequences,
    );
    expect(transport.stats).toMatchObject({
      definitions: 1,
      reuses: 11,
      fullMembers: 0,
    });
    expect(
      fast.packets.filter((packet) => packet.mode === "reuse"),
    ).toHaveLength(11);
    for (const packet of fast.packets.filter(
      (packet) => packet.mode === "reuse",
    )) {
      expect(Object.hasOwn(packet.result as object, "text")).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(8192);
    }
    expect(fast.wireBytes()).toBeLessThan(full.wireBytes() / 10);
    exactArchive(optimized, original);
    verifyArchive(optimized);
    expect(await snapshot(f.executionId)).toEqual(before);
  },
  120_000,
);

it("keeps null versus absent results, normalized versus inline rows and both conflict representations exact", async () => {
  const f = await cohort({ sequences: [1, 3], padding: 4096 });
  const [original] = await client!
    .sql`SELECT report,content_signature FROM progressive_worker_reports WHERE sim_job_id=${f.executionId} AND sequence=3`;
  for (const [sequence, resultClause] of [
    [8, ',"result":null'],
    [10, ""],
  ] as const) {
    const text = `{"version":1,"solverId":"${f.solverId}","executionId":"${f.executionId}","sequence":${sequence}${resultClause}}`;
    await client!
      .sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report) VALUES (${f.executionId},${sequence},${hash(text)},${text}::jsonb)`;
  }
  await client!
    .sql`UPDATE progressive_report_storage_policy SET normalization_enabled=true`;
  const text = `{"version":1,"solverId":"${f.solverId}","executionId":"${f.executionId}","sequence":15,"result":${f.result}}`;
  await client!
    .sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report) VALUES (${f.executionId},15,${hash(text)},${text}::jsonb)`;
  await client!
    .sql`INSERT INTO progressive_worker_report_conflicts(sim_job_id,sequence,content_signature,report,reason,body_source_sequence)
    VALUES (${f.executionId},3,${original.content_signature},${JSON.stringify({ version: 1, solverId: f.solverId, result: { state: "failed" } })}::jsonb,'original alias reason',3)`;
  const conflict = `{"version":1,"solverId":"${f.solverId}","executionId":"${f.executionId}","sequence":17,"result":${f.result},"extra":null}`;
  await client!
    .sql`INSERT INTO progressive_worker_report_conflicts(sim_job_id,sequence,content_signature,report,reason)
    VALUES (${f.executionId},17,${hash(conflict)},${conflict}::jsonb,'original independent reason')`;
  const item = f.scope.executions[0]!;
  item.reports = 5;
  item.reportHighWater = 15;
  item.conflicts = 2;
  item.conflictHighWater = 17;
  const full = reader(),
    fast = reader(),
    transport = new LegacyResultTransport(fast.source);
  const originalPage = await readLegacyPage(
    full.source,
    f.scope,
    undefined,
    128,
  );
  const optimized = await readLegacyPage(
    { ...fast.source, readMember: transport.readMember.bind(transport) },
    f.scope,
    undefined,
    128,
  );
  exactArchive(optimized, originalPage);
  expect(fast.packets.filter((packet) => packet.mode === "full")).toHaveLength(
    2,
  );
  const nullRow = optimized.members.find((member) => member.sequence === 8)!;
  const absentRow = optimized.members.find((member) => member.sequence === 10)!;
  expect(nullRow.reportText).toContain('"result": null');
  expect(absentRow.reportText).not.toContain('"result"');
  expect(
    optimized.members
      .filter((member) => member.kind === "conflict")
      .map((member) => member.rowText),
  ).toEqual(
    originalPage.members
      .filter((member) => member.kind === "conflict")
      .map((member) => member.rowText),
  );
  verifyArchive(optimized);
});

it.each([false, true])(
  "does not reuse JSONB-equal results with different PostgreSQL numeric text (normalized=%s)",
  async (normalized) => {
    const f = await cohort({ normalized, sequences: [1], padding: 4096 });
    const text = `{"version":1,"solverId":"${f.solverId}","executionId":"${f.executionId}","sequence":3,"result":${f.result.replace("1.0000", "1.0")}}`;
    await client!
      .sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report) VALUES (${f.executionId},3,${hash(text)},${text}::jsonb)`;
    const [equal] = await client!
      .sql`SELECT ${f.result}::jsonb=(${f.result.replace("1.0000", "1.0")}::jsonb) AS json_equal,
    (${f.result}::jsonb)::text=(${f.result.replace("1.0000", "1.0")}::jsonb)::text AS text_equal`;
    expect(equal).toMatchObject({ json_equal: true, text_equal: false });
    const source = reader(),
      transport = new LegacyResultTransport(source.source);
    await transport.readMember(f.executionId, "report", 1, 1024 ** 2);
    const current = await transport.readMember(
      f.executionId,
      "report",
      3,
      1024 ** 2,
    );
    const expected = await source.source.query(
      legacyMemberSql(f.executionId, "report", 3, 1024 ** 2),
      8 * 1024 ** 2,
    );
    expect(current).toEqual(expected);
    expect(transport.stats).toMatchObject({ definitions: 2, reuses: 0 });
  },
);

it("verifies the predecessor again after inline normalization and defines a fresh result if it disappears", async () => {
  const f = await cohort({ sequences: [1, 3, 8], padding: 4096 });
  const source = reader(),
    transport = new LegacyResultTransport(source.source);
  const [first] = await transport.readMember(
    f.executionId,
    "report",
    1,
    1024 ** 2,
  );
  await client!
    .sql`UPDATE progressive_report_storage_policy SET normalization_enabled=true`;
  await client!
    .sql`UPDATE progressive_worker_reports SET result_payload_hash=store_progressive_report_result(report->'result'),
    report=jsonb_set(report,'{result}',progressive_report_result_header(report->'result'),false)
    WHERE sim_job_id=${f.executionId} AND sequence=1`;
  await transport.readMember(f.executionId, "report", 3, 1024 ** 2);
  expect(transport.stats).toMatchObject({ definitions: 1, reuses: 1 });
  await client!
    .sql`DELETE FROM progressive_worker_reports WHERE sim_job_id=${f.executionId} AND sequence=3`;
  await transport.readMember(f.executionId, "report", 8, 1024 ** 2);
  expect(transport.stats).toMatchObject({ definitions: 2, reuses: 1 });
  expect((first as unknown as LegacyReportMember).rowText).toContain(
    '"result_payload_hash": null',
  );
});

it("reuses a verified normalized predecessor through its checked hash without resolving the large predecessor body again", async () => {
  const f = await cohort({
    normalized: true,
    sequences: [1, 3],
    padding: 4096,
  });
  const source = reader(),
    transport = new LegacyResultTransport(source.source);
  await transport.readMember(f.executionId, "report", 1, 1024 ** 2);
  await client!.sql
    .unsafe(
      `
    ALTER FUNCTION public.resolve_progressive_report(jsonb,text) RENAME TO legacy_result_transport_original;
    CREATE FUNCTION public.resolve_progressive_report(envelope jsonb,payload_hash text) RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$ BEGIN
      IF envelope->>'executionId'='${f.executionId}' AND envelope->>'sequence'='1' THEN
        RAISE EXCEPTION 'The verified normalized predecessor must not be resolved again';
      END IF;
      RETURN public.legacy_result_transport_original(envelope,payload_hash);
    END $$;
  `,
    )
    .simple();
  try {
    // Prove the guard catches the expensive old path; it cannot produce an
    // accidental success merely because the fixture stopped checking calls.
    await expect(
      source.source.query(
        legacyMemberSql(f.executionId, "report", 1, 1024 ** 2),
        8 * 1024 ** 2,
      ),
    ).rejects.toThrow("predecessor must not be resolved again");
    const restored = await transport.readMember(
      f.executionId,
      "report",
      3,
      1024 ** 2,
    );
    const original = await source.source.query(
      legacyMemberSql(f.executionId, "report", 3, 1024 ** 2),
      8 * 1024 ** 2,
    );
    expect(restored).toEqual(original);
    expect(transport.stats).toMatchObject({ definitions: 1, reuses: 1 });
  } finally {
    await client!.sql
      .unsafe(
        `DROP FUNCTION public.resolve_progressive_report(jsonb,text);
      ALTER FUNCTION public.legacy_result_transport_original(jsonb,text) RENAME TO resolve_progressive_report;`,
      )
      .simple();
  }
});

it("uses the full path when an unrelated value collides with the template marker", async () => {
  const nonce = randomUUID(),
    f = await cohort({
      sequences: [1],
      padding: 4096,
      collision: `__legacy_result_${nonce}__`,
    });
  const source = reader(),
    transport = new LegacyResultTransport(source.source, () => nonce);
  const current = await transport.readMember(
    f.executionId,
    "report",
    1,
    1024 ** 2,
  );
  const expected = await source.source.query(
    legacyMemberSql(f.executionId, "report", 1, 1024 ** 2),
    8 * 1024 ** 2,
  );
  expect(current).toEqual(expected);
  expect(transport.stats).toMatchObject({
    fullMembers: 1,
    definitions: 0,
    reuses: 0,
  });
});

it("preserves sparse cursors and decoded page limits while reusing a verified result across pages", async () => {
  const f = await cohort({ sequences: [1, 3], padding: 4096 });
  const baseline = reader();
  const originals = await readLegacyPage(baseline.source, f.scope);
  const cost = (member: LegacyReportMember) =>
    Buffer.byteLength(member.rowText) + member.reportByteSize;
  const source = reader(),
    transport = new LegacyResultTransport(source.source),
    input = {
      ...source.source,
      readMember: transport.readMember.bind(transport),
    };
  const first = await readLegacyPage(
    input,
    f.scope,
    undefined,
    128,
    cost(originals.members[0]!) + cost(originals.members[1]!) - 1,
  );
  expect(first.members).toEqual([originals.members[0]]);
  expect(first.next).toMatchObject({
    execution: 0,
    kind: "report",
    after: 1,
    copied: 1,
  });
  const second = await readLegacyPage(
    input,
    f.scope,
    first.next,
    128,
    cost(originals.members[1]!),
  );
  expect(second.members).toEqual([originals.members[1]]);
  expect(second.next).toMatchObject({
    execution: 0,
    kind: "report",
    after: 3,
    copied: 2,
  });
  expect(transport.stats).toMatchObject({ definitions: 1, reuses: 1 });
  verifyArchive(first);
  verifyArchive(second);
});
