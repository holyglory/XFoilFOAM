import {
  legacyOperatorWriteCommand,
  legacyOperatorWriteFailure,
} from "./legacy-report-storage-operator";
import { execFile } from "node:child_process";
import {
  open,
  readFile,
  readdir,
  link,
  unlink,
  rename,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  legacyNormalizeSql,
  legacyBound,
  type LegacyReportScope,
} from "@aerodb/db/legacy-report-storage";
import {
  decodeLegacyPage,
  LegacySshReader,
  legacyScopeHash,
  type LegacyBackupPage,
  type LegacyBackupReceipt,
  type LegacyCursor,
  type LegacyPageApplyStats,
} from "./legacy-report-storage";
import {
  legacySha256,
  type LegacyBackupStore,
} from "./legacy-report-storage-gcs";

export interface LegacyNormalizationProof {
  verifiedReports: number;
  normalizedReports: number;
  rowProofs: unknown[];
  newlyNormalizedReports?: number;
  transactionCommitted?: boolean;
  sourceDatabaseWrites?: boolean;
  archiveMembersReleased?: number;
  remainingWarmReports?: number;
  retentionStrategy?: string;
  fallbackReason?: string;
  coldReleaseComplete?: boolean;
  custody?: Record<string, unknown>;
}
export function legacyNormalizationTelemetry(
  proof: LegacyNormalizationProof,
  archiveMembers = 0,
): LegacyPageApplyStats {
  const newly = proof.newlyNormalizedReports ?? null;
  return {
    sourceDatabaseWrites:
      proof.sourceDatabaseWrites ?? (newly === null ? null : newly > 0),
    sourceReportRowsVerified: proof.verifiedReports,
    sourceReportBodiesRetained:
      proof.remainingWarmReports ?? proof.verifiedReports,
    rowsNewlyNormalized: newly,
    archiveMembersReleased: proof.archiveMembersReleased ?? 0,
    migrationTransactionsCommitted:
      proof.transactionCommitted === undefined
        ? null
        : Number(proof.transactionCommitted),
    reportRowsVerified: proof.verifiedReports,
    archiveMembersVerified: archiveMembers,
  };
}
export interface LegacyPageNormalizer {
  readonly binding: string;
  acceptVerifiedTransportHistory?(): void;
  readonly receiptPhase?: "custody";
  readonly phaseBinding?: string;
  readonly fallbackEligibility?: {
    registeredGet: "denied" | "unproven";
    terminalEvidenceSafety: "unproven";
  };
  apply(
    page: LegacyBackupPage,
    receipt?: LegacyBackupReceipt,
  ): Promise<LegacyNormalizationProof>;
}

/** An explicitly authorized operator channel. The export reader stays read-only. */
export class LegacySshNormalizer implements LegacyPageNormalizer {
  private provenTarget = false;
  acceptVerifiedTransportHistory() {
    this.provenTarget = true;
  }
  readonly binding: string;
  readonly fallbackEligibility: {
    registeredGet: "denied" | "unproven";
    terminalEvidenceSafety: "unproven";
  };
  private readonly command: string;
  constructor(
    private readonly host: string,
    container: string,
    private readonly readersReady: boolean,
    user = "aerodb",
    database = "aerodb",
    registeredGet: "denied" | "unproven" = "unproven",
  ) {
    this.command = new LegacySshReader(host, container, user, database).command;
    this.fallbackEligibility = {
      registeredGet,
      terminalEvidenceSafety: "unproven",
    };
    this.binding = legacySha256(
      JSON.stringify({
        host,
        command: this.command,
        operation: "0198-normalize",
      }),
    );
  }
  async apply(page: LegacyBackupPage): Promise<LegacyNormalizationProof> {
    if (!this.readersReady)
      throw new Error(
        "migrate requires --readers-ready and the existing enabled 0198 policy",
      );
    const reports = page.members.filter((member) => member.kind === "report");
    if (!page.members.length)
      return {
        verifiedReports: 0,
        normalizedReports: 0,
        rowProofs: [],
        newlyNormalizedReports: 0,
        transactionCommitted: false,
      };
    const values = reports
      .map(
        (r) =>
          `('${r.executionId}'::uuid,${r.sequence}::bigint,'${r.reportSha256}','${r.contentSignature}')`,
      )
      .join(",");
    const proof = reports.length
      ? `WITH expected(id,seq,digest,signature) AS (VALUES ${values}), checked AS (
      SELECT e.id::text AS execution_id,r.sequence,r.result_payload_hash,r.content_signature,e.digest FROM expected e
      JOIN public.progressive_worker_reports r ON r.sim_job_id=e.id AND r.sequence=e.seq
      WHERE r.archived_at IS NULL AND r.content_signature=e.signature
        AND encode(sha256(convert_to(public.resolve_progressive_report(to_jsonb(r.*))::text,'UTF8')),'hex')=e.digest
        AND (jsonb_typeof(public.resolve_progressive_report(to_jsonb(r.*))->'result') IS DISTINCT FROM 'object' OR r.result_payload_hash IS NOT NULL)
    ) SELECT jsonb_build_object('verifiedReports',count(*),'normalizedReports',count(result_payload_hash),
      'newlyNormalizedReports',(SELECT coalesce(sum(newly_normalized),0) FROM pg_temp.legacy_report_storage_changes),'transactionCommitted',true,
      'rowProofs',coalesce(jsonb_agg(jsonb_build_object('executionId',execution_id,'sequence',sequence,'resultPayloadHash',result_payload_hash,'contentSignature',content_signature,'reportSha256',digest)),'[]'::jsonb))::text FROM checked;`
      : `SELECT jsonb_build_object('verifiedReports',0,'normalizedReports',0,'newlyNormalizedReports',0,'transactionCommitted',true,'rowProofs','[]'::jsonb)::text;`;
    const sql =
      legacyNormalizeSql(page.members, {
        apply: true,
        readersReady: true,
        trackChanges: true,
      }) +
      "\nSET statement_timeout='30s';\n" +
      proof +
      "\n";
    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "ssh",
        [
          "-T",
          "-C",
          "-oBatchMode=yes",
          "-oStrictHostKeyChecking=yes",
          "-oConnectTimeout=10",
          this.host,
          legacyOperatorWriteCommand(this.command),
        ],
        {
          timeout: 120000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
          killSignal: "SIGTERM",
        },
        (error, stdout, stderr) =>
          error
            ? reject(
                legacyOperatorWriteFailure(
                  error,
                  stderr,
                  "worker_sql",
                  this.provenTarget,
                ),
              )
            : resolve(stdout),
      );
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(sql);
    });
    const lines = text.split("\n").filter(Boolean);
    if (lines.length !== 1)
      throw new Error(
        "Missing exact 0198 commit readback; retry from the same receipt",
      );
    const result = JSON.parse(lines[0]) as LegacyNormalizationProof;
    if (
      result.verifiedReports !== reports.length ||
      !Array.isArray(result.rowProofs) ||
      result.rowProofs.length !== reports.length ||
      !Number.isSafeInteger(result.newlyNormalizedReports) ||
      result.newlyNormalizedReports! < 0 ||
      result.newlyNormalizedReports! > reports.length
    )
      throw new Error(
        "0198 post-commit readback differs from the verified archive; retain pending page",
      );
    this.provenTarget = true;
    return result;
  }
}

async function saveProof(path: string, proof: unknown): Promise<void> {
  const temporary = join(dirname(path), `.proof-${randomUUID()}.tmp`);
  const bytes = Buffer.from(JSON.stringify(proof) + "\n");
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = JSON.parse(await readFile(path, "utf8")),
      current = proof as {
        archiveReceiptSha256: string;
        normalizerBinding: string;
        scopeSha256: string;
      };
    if (
      old.archiveReceiptSha256 !== current.archiveReceiptSha256 ||
      old.normalizerBinding !== current.normalizerBinding ||
      old.scopeSha256 !== current.scopeSha256
    )
      throw new Error(
        "Existing normalization proof belongs to another archive or target",
      );
  } finally {
    await unlink(temporary);
  }
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function custodyKey(normalizer: LegacyPageNormalizer) {
  return legacySha256(normalizer.phaseBinding ?? normalizer.binding);
}
function phaseMarker(
  name: string,
  normalizer: LegacyPageNormalizer,
  application = false,
) {
  return normalizer.receiptPhase === "custody"
    ? `${name}.${custodyKey(normalizer)}.${application ? "custody-applied" : "custody"}.json`
    : `${name}.normalized.json`;
}
async function saveCursor(path: string, value: unknown) {
  const temporary = join(dirname(path), `.cursor-${randomUUID()}.tmp`),
    file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function applyVerifiedLegacyPage(input: {
  page: LegacyBackupPage;
  receipt: LegacyBackupReceipt;
  receiptFile: string;
  directory: string;
  normalizer: LegacyPageNormalizer;
}) {
  const proof = await input.normalizer.apply(input.page, input.receipt);
  const record = {
    version: 1,
    archiveReceiptSha256: input.receiptFile.split(".")[0],
    scopeSha256: input.receipt.scopeSha256,
    object: input.receipt.object,
    normalizerBinding: input.normalizer.binding,
    phaseBinding: input.normalizer.phaseBinding ?? null,
    eligibility: input.normalizer.fallbackEligibility ?? {
      registeredGet: "unproven",
      terminalEvidenceSafety: "unproven",
    },
    retention: {
      strategy:
        proof.retentionStrategy ?? "postgres-0198-local-payload-sharing",
      coldBodyDeleted: (proof.archiveMembersReleased ?? 0) > 0,
      coldReleaseComplete: proof.coldReleaseComplete ?? false,
      fallbackReason: proof.fallbackReason ?? null,
    },
    proof,
    checkedAt: new Date().toISOString(),
  };
  if (input.normalizer.receiptPhase === "custody") {
    // The proof contains both the original receipt and its reader binding.
    // Use their combined digest rather than appending three 64-byte hashes.
    const attempt = `custody-attempt-${legacySha256(JSON.stringify(record))}.json`;
    await saveProof(join(input.directory, attempt), record);
    await saveProof(
      join(
        input.directory,
        phaseMarker(input.receiptFile, input.normalizer, true),
      ),
      record,
    );
    if (proof.coldReleaseComplete)
      await saveProof(
        join(input.directory, phaseMarker(input.receiptFile, input.normalizer)),
        record,
      );
  } else
    await saveProof(
      join(input.directory, phaseMarker(input.receiptFile, input.normalizer)),
      record,
    );
  return proof;
}

const receiptPattern = /^[a-f0-9]{64}\.[a-f0-9]{64}\.[0-9]+\.receipt\.json$/;
const cursorKey = (cursor: LegacyCursor) =>
  JSON.stringify([cursor.execution, cursor.kind, cursor.after, cursor.copied]);

/** Bounded receipt-only adoption; no report refetch and no retained gzip copies. */
export async function migrateLegacyReceipts(input: {
  scope: LegacyReportScope;
  directory: string;
  store: LegacyBackupStore;
  normalizer: LegacyPageNormalizer;
  pages?: number;
  apply?: boolean;
  through?: LegacyCursor;
}) {
  const limit = legacyBound(input.pages ?? 32, 32, "receipt pages");
  const scopeSha256 = legacyScopeHash(input.scope);
  const names = (await readdir(input.directory))
    .filter((name) => receiptPattern.test(name))
    .sort();
  if (names.length > 200000)
    throw new Error("Receipt directory exceeds bounded inventory limit");
  const edges = new Map<string, string[]>();
  const pending: {
    name: string;
    receipt: LegacyBackupReceipt;
    unapplied: boolean;
  }[] = [];
  for (const name of names) {
    const bytes = await readFile(join(input.directory, name));
    if (bytes.length > 65536 || legacySha256(bytes) !== name.split(".")[0])
      throw new Error("Saved archive receipt hash changed");
    const receipt = JSON.parse(bytes.toString("utf8")) as LegacyBackupReceipt;
    if (
      receipt.scopeSha256 !== scopeSha256 ||
      receipt.sourceInstance !== input.scope.sourceInstance ||
      receipt.solverId !== input.scope.solverId
    )
      throw new Error("Receipt belongs to another scope/source");
    const key = cursorKey(receipt.start);
    edges.set(key, [...(edges.get(key) ?? []), cursorKey(receipt.next)]);
    let complete = false,
      unapplied = true;
    try {
      const saved = JSON.parse(
        await readFile(
          join(input.directory, phaseMarker(name, input.normalizer)),
          "utf8",
        ),
      );
      if (
        saved.archiveReceiptSha256 !== name.split(".")[0] ||
        saved.normalizerBinding !== input.normalizer.binding
      )
        throw new Error("Receipt proof belongs to another operator target");
      complete = true;
      unapplied = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!complete && input.normalizer.receiptPhase === "custody")
      try {
        const saved = JSON.parse(
          await readFile(
            join(input.directory, phaseMarker(name, input.normalizer, true)),
            "utf8",
          ),
        );
        if (
          saved.archiveReceiptSha256 !== name.split(".")[0] ||
          saved.normalizerBinding !== input.normalizer.binding
        )
          throw new Error("Custody application proof differs");
        unapplied = false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    if (!complete) pending.push({ name, receipt, unapplied });
  }
  if (input.through) {
    const initial = cursorKey({
      execution: 0,
      kind: "report",
      after: input.scope.executions[0].reportAfter ?? 0,
      copied: 0,
    });
    const target = cursorKey(input.through),
      queue = [initial],
      seen = new Set<string>([initial]);
    for (let index = 0; index < queue.length; index++) {
      const key = queue[index];
      for (const next of edges.get(key) ?? [])
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    }
    if (!seen.has(target))
      throw new Error(
        "Copy receipts do not cover the saved cursor; adoption refused",
      );
  }
  let applied = 0,
    completed = 0,
    unappliedRemaining = pending.filter((item) => item.unapplied).length;
  const cursorPath = join(
    input.directory,
    `custody-scan.${custodyKey(input.normalizer)}.json`,
  );
  let after = "";
  if (input.normalizer.receiptPhase === "custody")
    try {
      after = JSON.parse(await readFile(cursorPath, "utf8")).after ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  const fresh = pending.filter((item) => item.unapplied),
    retry = pending.filter((item) => !item.unapplied);
  const ordered =
    input.normalizer.receiptPhase === "custody"
      ? [
          ...fresh,
          ...retry.filter((item) => item.name > after),
          ...retry.filter((item) => item.name <= after),
        ]
      : pending;
  const telemetry = legacyNormalizationTelemetry({
    verifiedReports: 0,
    normalizedReports: 0,
    rowProofs: [],
    newlyNormalizedReports: 0,
    transactionCommitted: false,
  });
  if (input.apply)
    for (const item of ordered.slice(0, limit)) {
      const bytes = await input.store.read(item.receipt.object);
      const page = decodeLegacyPage(bytes, item.receipt);
      const proof = await applyVerifiedLegacyPage({
        page,
        receipt: item.receipt,
        receiptFile: item.name,
        directory: input.directory,
        normalizer: input.normalizer,
      });
      const next = legacyNormalizationTelemetry(proof, page.members.length);
      if (next.sourceDatabaseWrites === true)
        telemetry.sourceDatabaseWrites = true;
      else if (
        next.sourceDatabaseWrites === null &&
        telemetry.sourceDatabaseWrites !== true
      )
        telemetry.sourceDatabaseWrites = null;
      for (const key of [
        "sourceReportRowsVerified",
        "sourceReportBodiesRetained",
        "rowsNewlyNormalized",
        "archiveMembersReleased",
        "migrationTransactionsCommitted",
        "reportRowsVerified",
        "archiveMembersVerified",
      ] as const) {
        telemetry[key] =
          telemetry[key] === null ||
          next[key] === null ||
          next[key] === undefined
            ? null
            : (telemetry[key] ?? 0) + next[key]!;
      }
      applied++;
      if (item.unapplied) unappliedRemaining--;
      if (
        input.normalizer.receiptPhase !== "custody" ||
        proof.coldReleaseComplete
      )
        completed++;
      if (input.normalizer.receiptPhase === "custody")
        await saveCursor(cursorPath, { version: 1, after: item.name });
    }
  return {
    complete: pending.length === completed,
    applicationsComplete: unappliedRemaining === 0,
    unappliedRemaining,
    coldReleaseComplete:
      input.normalizer.receiptPhase === "custody"
        ? pending.length === completed
        : null,
    receipts: names.length,
    applied,
    remaining: pending.length - completed,
    telemetry,
  };
}
