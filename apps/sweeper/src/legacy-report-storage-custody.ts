import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import type {
  LegacyBackupPage,
  LegacyBackupReceipt,
} from "@aerodb/db/legacy-report-storage-codec";
import { decodeLegacyPage } from "@aerodb/db/legacy-report-storage-codec";
import {
  legacySha256,
  type LegacyBackupStore,
} from "./legacy-report-storage-gcs";
import {
  legacyOperatorWriteCommand,
  legacyOperatorWriteFailure,
} from "./legacy-report-storage-operator";
import type {
  LegacyPageNormalizer,
  LegacyNormalizationProof,
} from "./legacy-report-storage-migration";

const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";

/** Prefer exact local-volume custody; old releases and denied/unproven readers
 * retain full 0198 access. The logical source binding deliberately stays stable. */
export class LegacyWorkingVolumeNormalizer implements LegacyPageNormalizer {
  readonly binding: string;
  acceptVerifiedTransportHistory() {
    this.fallback.acceptVerifiedTransportHistory?.();
  }
  readonly receiptPhase = "custody" as const;
  readonly phaseBinding: string;
  readonly fallbackEligibility;
  constructor(
    private readonly fallback: LegacyPageNormalizer,
    private readonly store: LegacyBackupStore,
    private readonly host: string,
    private readonly container: string,
  ) {
    if (
      !/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(container)
    )
      throw new Error("Use the existing exact HZ sweeper SSH/container target");
    this.binding = fallback.binding;
    this.phaseBinding = legacySha256(
      JSON.stringify({
        operation: "legacy-working-volume-custody",
        binding: this.binding,
        host,
        container,
      }),
    );
    this.fallbackEligibility = fallback.fallbackEligibility;
  }
  async apply(
    page: LegacyBackupPage,
    receipt?: LegacyBackupReceipt,
  ): Promise<LegacyNormalizationProof> {
    if (!page.members.length)
      return {
        ...(await this.fallback.apply(page)),
        coldReleaseComplete: true,
      };
    if (!receipt)
      throw new Error("Custody requires the durable exact archive receipt");
    // Never use a saved operator buffer as fresh hub-read proof.
    const packed = await this.store.read(receipt.object);
    const restored = decodeLegacyPage(packed, receipt);
    const hubReadbackAt = new Date().toISOString();
    if (restored.scopeSha256 !== page.scopeSha256)
      throw new Error("Custody page differs from verified archive");
    const source = await readFile(
      new URL("./legacy-report-storage-custody-worker.ts", import.meta.url),
      "utf8",
    );
    const program =
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText +
      "\nlegacyCustodyWorkerStdin().catch(()=>{console.error('Legacy custody worker verification or transaction failed; pending bytes retained');process.exitCode=1;});\n";
    const launch = `docker exec -i ${this.container} node --import tsx --input-type=module -e ${quote(program)}`;
    const hostProgram = `if [ "$(docker inspect --format '{{.State.Running}}' ${this.container} 2>/dev/null)" != true ]; then cat >/dev/null; printf '%s\\n' '{"mode":"fallback","reason":"supporting_worker_service_unavailable"}'; else exec ${launch}; fi`;
    const command = legacyOperatorWriteCommand(`sh -c ${quote(hostProgram)}`);

    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const child = execFile(
          "ssh",
          [
            "-T",
            "-C",
            "-oBatchMode=yes",
            "-oStrictHostKeyChecking=yes",
            "-oConnectTimeout=10",
            this.host,
            command,
          ],
          {
            timeout: 300000,
            maxBuffer: 262144,
            encoding: "utf8",
            killSignal: "SIGTERM",
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                legacyOperatorWriteFailure(
                  error,
                  stderr,
                  "worker_custody",
                  true,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(
                new Error(
                  "Missing exact worker custody transaction acknowledgement",
                ),
              );
            }
          },
        );
        child.stdin!.on("error", () => undefined);
        child.stdin!.write(JSON.stringify({ receipt, hubReadbackAt }) + "\n");
        child.stdin!.end(packed);
      },
    );
    if (result.mode === "fallback")
      return {
        ...(await this.fallback.apply(restored, receipt)),
        fallbackReason: String(result.reason),
        coldReleaseComplete: false,
        retentionStrategy: "postgres-0198-local-payload-sharing",
      };
    const actual = result.verifiedMembers as
      | Array<Record<string, unknown>>
      | undefined;
    if (
      result.mode !== "custody" ||
      result.pageReads !== 1 ||
      result.transactionCommitted !== true ||
      !Array.isArray(actual) ||
      actual.length !== page.members.length ||
      result.replayMembersVerified !== page.members.length ||
      actual.some((member, index) => {
        const expected = page.members[index];
        return (
          member.executionId !== expected.executionId ||
          member.sequence !== expected.sequence ||
          member.kind !== expected.kind ||
          member.contentSignature !== expected.contentSignature ||
          member.reportSha256 !== expected.reportSha256 ||
          member.reportByteSize !== expected.reportByteSize
        );
      })
    )
      throw new Error(
        "Worker custody did not prove every exact member and replay",
      );
    const reports = page.members.filter(
      (member) => member.kind === "report",
    ).length;
    for (const key of [
      "newlyNormalizedReports",
      "archiveMembersReleased",
      "verifiedReports",
    ])
      if (
        !Number.isSafeInteger(result[key]) ||
        Number(result[key]) < 0 ||
        Number(result[key]) > page.members.length
      )
        throw new Error("Invalid actual worker custody count");
    if (
      result.verifiedReports !== reports ||
      !Number.isSafeInteger(result.remainingWarmReports) ||
      Number(result.remainingWarmReports) < 0 ||
      Number(result.remainingWarmReports) > reports ||
      typeof result.sourceDatabaseWrites !== "boolean"
    )
      throw new Error("Worker custody report readback differs");
    return {
      verifiedReports: reports,
      normalizedReports: Number(result.normalizedReports),
      newlyNormalizedReports: Number(result.newlyNormalizedReports),
      transactionCommitted: true,
      sourceDatabaseWrites: result.sourceDatabaseWrites,
      archiveMembersReleased: Number(result.archiveMembersReleased),
      remainingWarmReports: Number(result.remainingWarmReports),
      rowProofs: actual,
      coldReleaseComplete: result.coldReleaseComplete === true,
      retentionStrategy: "gcs-and-worker-working-volume",
      custody: result,
    };
  }
}
