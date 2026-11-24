import { configuredDeploymentRole } from "./config";
import { enableVerifiedAttemptPolicy, hasConfiguredAttemptHubRole, requireVerifiedAttemptHub, VERIFIED_HUB_ATTEMPT_COHORTS } from "@aerodb/db/attempt-evidence-verified-policy";
import {
  attemptEvidenceAuditSql,
  auditAttemptEvidencePage,
  loadSettledAttemptEvidenceCopy,
  type AttemptEvidenceFieldMeasurement,
} from "@aerodb/db/attempt-evidence-storage";
import { PgDialect } from "drizzle-orm/pg-core";
import { pathToFileURL } from "node:url";
import { writeAttemptEvidenceCopy } from "./attempt-evidence-archive";
import {
  attemptEvidenceCatalogReady,
  attemptEvidenceUseAuditSql,
  auditAttemptEvidenceUsePage,
  getAttemptEvidenceArchive,
} from "@aerodb/db/attempt-evidence-catalog";
import {
  archiveAttemptEvidence,
  attemptEvidenceSourceInstance,
  runAttemptEvidenceArchivePass,
} from "./attempt-evidence-service";
import { AttemptEvidenceStore } from "./attempt-evidence-store";
import { writeFile } from "node:fs/promises";
import {
  type AttemptEvidenceStoragePolicy,
  attemptEvidenceShorteningCandidates,
  attemptEvidenceSettlementTotals,
  getAttemptEvidenceStoragePolicy,
  setAttemptEvidenceStoragePolicy,
  setShortAttemptProofPolicy,
  restoreAttemptEvidence,
} from "@aerodb/db/attempt-evidence-projection";
import {
  configuredAttemptEvidenceSettlementDependencies,
  runAttemptEvidenceSettlementPass,
  settleAttemptEvidenceHistory,
} from "./attempt-evidence-settlement";

function integer(text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new Error("Audit bounds require positive safe integers");
  return Number(text);
}

function activeCohorts(
  policy: AttemptEvidenceStoragePolicy,
  role: ReturnType<typeof configuredDeploymentRole>,
) {
  if (!policy.shorteningEnabled) return [];
  if (role === "remote-solver" || policy.hzWorkerOnly)
    return role === "remote-solver" && policy.hzWorkerOnly ? ["hz-worker"] : [];
  if (policy.progressiveSourceScope === "verified")
    return VERIFIED_HUB_ATTEMPT_COHORTS;
  if (
    policy.progressiveSourceScope === "legacy" &&
    policy.stoppedProgressiveEnabled
  )
    return ["legacy", "stopped-only"];
  return [policy.progressiveSourceScope];
}

export async function attemptEvidenceStorageMain(
  argv: string[],
): Promise<void> {
  const [command, ...args] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (
      ![
        "--after",
        "--limit",
        "--pages",
        "--max-stored-bytes",
        "--id",
        "--output",
        "--bucket",
        "--source-instance",
        "--rows",
        "--bytes",
        "--catalog",
        "--consumer-contract",
        "--stopped-progressive",
        "--receipt-bearing",
        "--receipt-urans",
        "--urans-max-source-bytes",
        "--archive-id",
      ].includes(flag) ||
      !args[index + 1] ||
      flags.has(flag)
    )
      throw new Error("Invalid attempt evidence command options");
    flags.set(flag, args[index + 1]!);
  }
  const shortPolicy = command === "enable-short-proofs" || command === "disable-short-proofs";
  if (shortPolicy && [...flags.keys()].some(flag => command !== "enable-short-proofs" || flag !== "--id"))
    throw new Error("enable-short-proofs accepts an optional canary --id; disable-short-proofs takes no options");
  const verified =
    command === "enable-verified" || command === "preview-verified";
  if (verified) {
    const allowed =
      command === "enable-verified"
        ? ["--consumer-contract"]
        : ["--after", "--pages"];
    if ([...flags.keys()].some((flag) => !allowed.includes(flag)))
      throw new Error(
        "The verified policy uses all qualified hub cohorts. Use a scoped command for a canary.",
      );
    if (configuredDeploymentRole() !== "hub")
      throw new Error("Worker attempts require the HZ custody relay");
  }
  const options = {
    after: flags.get("--after"),
    limit: integer(flags.get("--limit"), 32),
    maxStoredPayloadBytes: integer(
      flags.get("--max-stored-bytes"),
      8 * 1024 ** 2,
    ),
  };
  const stoppedMode = flags.get("--stopped-progressive");
  const stoppedProgressive = stoppedMode === "true" || stoppedMode === "only";
  const receiptBearing = flags.get("--receipt-bearing") === "true";
  const receiptUrans = flags.get("--receipt-urans") === "true";
  if (
    flags.has("--urans-max-source-bytes") &&
    (!receiptUrans || command !== "enable-shortening")
  )
    throw new Error(
      "--urans-max-source-bytes applies to an explicit URANS policy",
    );
  if (
    flags.has("--receipt-urans") &&
    (!receiptUrans ||
      flags.has("--receipt-bearing") ||
      flags.has("--stopped-progressive") ||
      (command !== "enable-shortening" && command !== "shortening-candidates"))
  )
    throw new Error(
      "--receipt-urans true selects only the verified URANS reader scope",
    );
  if (
    flags.has("--receipt-bearing") &&
    (!receiptBearing ||
      flags.has("--stopped-progressive") ||
      (command !== "enable-shortening" && command !== "shortening-candidates"))
  )
    throw new Error(
      "--receipt-bearing true selects one scoped preview or writer policy",
    );
  if (
    flags.has("--stopped-progressive") &&
    (!stoppedProgressive ||
      (command !== "enable-shortening" && command !== "shortening-candidates"))
  )
    throw new Error(
      "--stopped-progressive true applies to shortening-candidates and enable-shortening",
    );
  if (command === "sql") {
    process.stdout.write(
      `${JSON.stringify(new PgDialect().sqlToQuery(attemptEvidenceAuditSql(options)))}\n`,
    );
    return;
  }
  if (command === "use-sql") {
    if (
      flags.has("--catalog") &&
      !["true", "false"].includes(flags.get("--catalog")!)
    )
      throw new Error("--catalog must be true or false");
    process.stdout.write(
      `${JSON.stringify(
        new PgDialect().sqlToQuery(
          attemptEvidenceUseAuditSql({
            ...options,
            catalogReady: flags.get("--catalog") === "true",
            sourceInstance: flags.get("--source-instance"),
          }),
        ),
      )}\n`,
    );
    return;
  }
  if (
    ![
      "audit",
      "use-audit",
      "copy",
      "archive",
      "backfill",
      "restore",
      "preview-verified",
      "enable-verified",
      "shortening-status",
      "shortening-candidates",
      "enable-shortening",
      "disable-shortening",
      "enable-short-proofs",
      "disable-short-proofs",
      "shorten",
      "shorten-pass",
      "restore-inline",
    ].includes(command ?? "")
  )
    throw new Error(
      "Usage: attempt-evidence-storage-cli.ts sql|use-sql|audit|use-audit|copy|archive|backfill|restore|shortening-status|preview-verified|enable-verified|shortening-candidates|enable-shortening|disable-shortening|enable-short-proofs|disable-short-proofs|shorten|shorten-pass|restore-inline [--consumer-contract 1] [--stopped-progressive true|only] [--receipt-bearing true | --receipt-urans true [--urans-max-source-bytes N]] [--id ATTEMPT_UUID --archive-id ARCHIVE_UUID] [--after UUID] [--rows N] [--pages N] [--output NEW_FILE] [--bucket BUCKET] [--source-instance INSTANCE]",
    );
  if (!process.env.DATABASE_URL)
    throw new Error("An explicit DATABASE_URL is required");
  const pages = integer(flags.get("--pages"), 1);
  if (pages > 2048)
    throw new Error("An attempt evidence audit is limited to 2048 pages");
  const { createClient } = await import("@aerodb/db/client");
  const client = createClient({ max: 1 });
  try {
    if (
      [
        "preview-verified",
        "enable-verified",
        "shortening-status",
        "shortening-candidates",
        "enable-shortening",
        "disable-shortening",
        "enable-short-proofs",
        "disable-short-proofs",
        "shorten",
        "shorten-pass",
        "restore-inline",
      ].includes(command!)
    ) {
      const policy = await getAttemptEvidenceStoragePolicy(client.db);
      if (!policy)
        throw new Error(
          "Attempt history shortening requires forward migration 0208",
        );
      if (shortPolicy) {
        const enabled = command === "enable-short-proofs";
        const update = (db: typeof client.db) => setShortAttemptProofPolicy(db, enabled, flags.get("--id"));
        let updated;
        if (enabled && configuredDeploymentRole() === "remote-solver") {
          if (!policy.hzWorkerOnly) throw new Error("Short worker proofs require the native HZ-only policy");
          const { withActiveHzTransfer } = await import("./hz-attempt-transfer-fence");
          updated = await withActiveHzTransfer(client.db, undefined, update);
        } else {
          if (enabled) await requireVerifiedAttemptHub(client.db);
          updated = await update(client.db);
        }
        process.stdout.write(`${JSON.stringify(updated)}\n`);
        return;
      }
      if (command === "shortening-status") {
        const role = configuredDeploymentRole();
        const cohorts = activeCohorts(policy, role);
        process.stdout.write(
          `${JSON.stringify({ role, policy, cohorts, current: await attemptEvidenceSettlementTotals(client.db), automaticWorker: role === "remote-solver" ? "hz-attempt-storage-cli.ts watch" : "report-storage-worker", emergencyDisabled: process.env.AIRFOILFOAM_ATTEMPT_HISTORY_SHORTENING === "false" })}\n`,
        );
        return;
      }
      if (
        command === "shortening-candidates" ||
        command === "preview-verified"
      ) {
        let scoped:
          | AttemptEvidenceStoragePolicy["progressiveSourceScope"]
          | undefined;
        if (stoppedProgressive) scoped = "stopped-only";
        if (receiptBearing) scoped = "receipt-bearing";
        if (receiptUrans) scoped = "receipt-urans";
        const previewVerified =
          verified || (!scoped && policy.progressiveSourceScope === "verified");
        if (previewVerified) {
          if (configuredDeploymentRole() !== "hub")
            throw new Error("Worker attempts require the HZ custody relay");
          await requireVerifiedAttemptHub(client.db);
        }
        let after = options.after ?? null,
          scanned = 0,
          complete = false;
        const eligible: Array<{
          attemptId: string;
          archiveId: string;
          cohort?: string | null;
        }> = [];
        const limits = new Map<string, number>();
        for (let page = 0; page < pages; page++) {
          const rows = await attemptEvidenceShorteningCandidates(
            client.db,
            after,
            previewVerified ? "verified" : (scoped ?? false),
          );
          for (const row of rows) {
            const reason =
              row.limiter ?? (row.archive_id ? null : "missing-exact-archive");
            if (reason) limits.set(reason, (limits.get(reason) ?? 0) + 1);
            else
              eligible.push({
                attemptId: row.id,
                archiveId: row.archive_id!,
                ...(previewVerified ? { cohort: row.cohort } : {}),
              });
          }
          scanned += rows.length;
          after = rows.at(-1)?.id ?? null;
          if (rows.length < 32) {
            complete = true;
            after = null;
            break;
          }
        }
        process.stdout.write(
          `${JSON.stringify({ scanned, eligible, limited: Object.fromEntries(limits), next: after, complete })}\n`,
        );
        return;
      }
      if (command === "disable-shortening") {
        process.stdout.write(
          `${JSON.stringify(await setAttemptEvidenceStoragePolicy(client.db, { enabled: false }))}\n`,
        );
        return;
      }
      const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
      if (
        !bucket ||
        policy.hzWorkerOnly ||
        !hasConfiguredAttemptHubRole()
      )
        throw new Error(
          "Attempt shortening requires the canonical hub bucket and existing server credentials",
        );
      if (command === "enable-verified") {
        if (flags.get("--consumer-contract") !== "1")
          throw new Error("Verified shortening requires --consumer-contract 1");
        await requireVerifiedAttemptHub(client.db);
        await configuredAttemptEvidenceSettlementDependencies(client.db);
        await enableVerifiedAttemptPolicy(client.db);
        process.stdout.write(
          `${JSON.stringify(await getAttemptEvidenceStoragePolicy(client.db))}\n`,
        );
        return;
      }
      if (command === "enable-shortening") {
        if (flags.get("--consumer-contract") !== "1")
          throw new Error(
            "Enablement requires deployed v1 readers: --consumer-contract 1",
          );
        // Resolve the actual installed consumer/app contracts before changing
        // SQL policy. No cloud request or permission change is made here.
        await configuredAttemptEvidenceSettlementDependencies(client.db);
        const enabled = await setAttemptEvidenceStoragePolicy(client.db, {
          enabled: true,
          consumerContractVersion: 1,
          canaryAttemptId: flags.get("--id"),
          stoppedProgressive:
            stoppedMode === "only" ? "only" : stoppedProgressive,
          receiptBearing,
          receiptUrans,
          uransMaxSourceBytes: flags.has("--urans-max-source-bytes")
            ? integer(flags.get("--urans-max-source-bytes"), 262144)
            : undefined,
        });
        process.stdout.write(`${JSON.stringify(enabled)}\n`);
        return;
      }
      if (command === "restore-inline") {
        const id = flags.get("--id"),
          archiveId = flags.get("--archive-id");
        if (!id || !archiveId)
          throw new Error(
            "restore-inline requires stable --id and --archive-id",
          );
        const archive = await getAttemptEvidenceArchive(client.db, archiveId);
        if (archive.attemptId !== id.toLowerCase())
          throw new Error("Restore archive belongs to another attempt");
        const source = await new AttemptEvidenceStore().read(archive);
        const result = await restoreAttemptEvidence(
          client.db,
          id,
          archiveId,
          source.payloadText,
          "explicit exact-source operator restore",
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      if (!policy.shorteningEnabled || policy.consumerContractVersion !== 1)
        throw new Error("Attempt history shortening is not enabled");
      const deps = await configuredAttemptEvidenceSettlementDependencies(
        client.db,
      );
      if (command === "shorten") {
        const id = flags.get("--id"),
          archiveId = flags.get("--archive-id");
        if (!id || !archiveId)
          throw new Error("shorten requires stable --id and --archive-id");
        process.stdout.write(
          `${JSON.stringify(await settleAttemptEvidenceHistory(client.db, deps, { attemptId: id, archiveId }))}\n`,
        );
        return;
      }
      if (policy.canaryAttemptId)
        throw new Error("Use shorten with the configured canary attempt ID");
      let afterReadback: string | null = null;
      let after = options.after ?? null,
        processed = 0,
        shortened = 0,
        payloadBytesReclaimed = 0,
        netValueBytesReclaimed = 0,
        scanComplete = false;
      const failures: Array<{ attemptId: string; error: string }> = [];
      for (let page = 0; page < pages; page++) {
        const result = await runAttemptEvidenceSettlementPass(client.db, deps, {
          after,
          afterReadback,
          maxRows: integer(flags.get("--rows"), 4),
        });
        processed += result.processed;
        shortened += result.shortened;
        payloadBytesReclaimed += result.payloadBytesReclaimed;
        netValueBytesReclaimed += result.netValueBytesReclaimed;
        failures.push(...result.failures);
        after = result.next;
        afterReadback = result.nextReadback;
        if (after === null && afterReadback === null) {
          scanComplete = true;
          break;
        }
      }
      process.stdout.write(
        `${JSON.stringify({ processed, shortened, payloadBytesReclaimed, netValueBytesReclaimed, next: after, scanComplete, failures })}\n`,
      );
      return;
    }
    if (command === "use-audit") {
      const catalogReady = await attemptEvidenceCatalogReady(client.db);
      let after = options.after,
        complete = false,
        measuredPages = 0;
      const groups = new Map<string, Record<string, boolean | string>>();
      const dimensions = [
        "canonical",
        "fit_receipt",
        "fit_model",
        "campaign",
        "continuation",
        "settled",
      ];
      const metrics = [
        "rows",
        "onlineStoredPayloadBytes",
        "sourceTextBytes",
        "historyBytes",
        "copyEligibleRows",
        "cataloguedRows",
        "remainingGcsSourceBytes",
        "remainingGcsHistoryBytes",
        "uninspectedRows",
      ];
      const startedAt = new Date().toISOString();
      for (; measuredPages < pages; measuredPages++) {
        const page = await auditAttemptEvidenceUsePage(client.db, {
          ...options,
          after,
          catalogReady,
          sourceInstance: flags.get("--source-instance"),
        });
        for (const group of page.groups) {
          const key = JSON.stringify(dimensions.map((name) => group[name]));
          const previous = groups.get(key);
          groups.set(
            key,
            previous
              ? {
                  ...group,
                  ...Object.fromEntries(
                    metrics.map((name) => [
                      name,
                      String(
                        BigInt(previous[name] as string) +
                          BigInt(group[name] as string),
                      ),
                    ]),
                  ),
                }
              : { ...group },
          );
        }
        after = page.next ?? undefined;
        if (page.complete) {
          complete = true;
          measuredPages++;
          break;
        }
      }
      process.stdout.write(
        `${JSON.stringify({
          startedAt,
          finishedAt: new Date().toISOString(),
          readOnly: true,
          snapshot: "per-page-read-committed",
          pages: measuredPages,
          complete,
          next: after ?? null,
          catalogReady,
          groups: [...groups.values()],
          onlineBytesRemoved: 0,
        })}\n`,
      );
      return;
    }
    if (
      ["restore", "archive", "backfill"].includes(command!) &&
      !hasConfiguredAttemptHubRole()
    )
      throw new Error(
        "Worker attempt custody uses its registered volume and relay",
      );
    if (command === "restore") {
      if (!flags.get("--id") || !flags.get("--output"))
        throw new Error("restore requires a catalog --id and new --output");
      const archive = await getAttemptEvidenceArchive(
        client.db,
        flags.get("--id")!,
      );
      const source = await new AttemptEvidenceStore().read(archive);
      await writeFile(flags.get("--output")!, source.payloadText, {
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(
        `${JSON.stringify({ archive, output: flags.get("--output"), verified: true })}\n`,
      );
      return;
    }
    if (command === "archive" || command === "backfill") {
      const bucket =
        flags.get("--bucket") ??
        process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
      if (!bucket)
        throw new Error(
          "GCS archival requires --bucket or AIRFOILFOAM_EVIDENCE_BUCKET",
        );
      if (!(await attemptEvidenceCatalogReady(client.db)))
        throw new Error("Attempt evidence archive migration 0207 is required");
      const sourceInstance =
        flags.get("--source-instance") ??
        (await attemptEvidenceSourceInstance(client.db));
      const store = new AttemptEvidenceStore();
      if (command === "archive") {
        if (!flags.get("--id")) throw new Error("archive requires --id");
        const result = await archiveAttemptEvidence(client.db, store, {
          bucket,
          sourceInstance,
          attemptId: flags.get("--id")!,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
      }
      let after = options.after ?? null,
        scanComplete = false,
        processed = 0,
        copied = 0,
        sourceBytes = 0,
        historyBytes = 0,
        measuredPages = 0;
      const failures: Array<{ attemptId: string; error: string }> = [];
      for (; measuredPages < pages; measuredPages++) {
        const result = await runAttemptEvidenceArchivePass(client.db, store, {
          bucket,
          sourceInstance,
          after,
          maxRows: integer(flags.get("--rows"), 8),
          maxBytes: integer(flags.get("--bytes"), 8 * 1024 ** 2),
        });
        processed += result.processed;
        copied += result.copied;
        sourceBytes += result.sourceBytes;
        historyBytes += result.historyBytes;
        failures.push(...result.failures);
        after = result.next;
        if (after === null) {
          scanComplete = true;
          measuredPages++;
          break;
        }
      }
      process.stdout.write(
        `${JSON.stringify({ processed, copied, sourceBytes, historyBytes, pages: measuredPages, scanComplete, next: after, failures, onlineBytesRemoved: 0 })}\n`,
      );
      return;
    }
    if (command === "copy") {
      if (!flags.get("--id") || !flags.get("--output"))
        throw new Error("copy requires --id and --output");
      const source = await loadSettledAttemptEvidenceCopy(
        client.db,
        flags.get("--id")!,
      );
      const identity = await writeAttemptEvidenceCopy(
        flags.get("--output")!,
        source,
      );
      process.stdout.write(
        `${JSON.stringify({ identity, onlinePayloadChanged: false, copyOnly: true })}\n`,
      );
      return;
    }
    let after = options.after;
    let complete = false;
    let measuredPages = 0;
    const counts = {
      rows: 0n,
      settledRows: 0n,
      inspectedRows: 0n,
      skippedRows: 0n,
      storedPayloadBytes: 0n,
      inspectedPayloadTextBytes: 0n,
    };
    const fields = new Map<string, AttemptEvidenceFieldMeasurement>();
    const startedAt = new Date().toISOString();
    for (; measuredPages < pages; measuredPages++) {
      const page = await auditAttemptEvidencePage(client.db, {
        ...options,
        after,
      });
      for (const key of Object.keys(counts) as Array<keyof typeof counts>)
        counts[key] += BigInt(page[key]);
      for (const field of page.fields) {
        const key = JSON.stringify([field.path, field.type, field.category]);
        const previous = fields.get(key);
        fields.set(
          key,
          previous
            ? {
                ...field,
                occurrences: String(
                  BigInt(previous.occurrences) + BigInt(field.occurrences),
                ),
                jsonTextBytes: String(
                  BigInt(previous.jsonTextBytes) + BigInt(field.jsonTextBytes),
                ),
                largeValues: String(
                  BigInt(previous.largeValues) + BigInt(field.largeValues),
                ),
                largestValueBytes: String(
                  BigInt(previous.largestValueBytes) >
                    BigInt(field.largestValueBytes)
                    ? previous.largestValueBytes
                    : field.largestValueBytes,
                ),
              }
            : { ...field },
        );
      }
      after = page.next ?? undefined;
      if (page.complete) {
        complete = true;
        measuredPages++;
        break;
      }
    }
    process.stdout.write(
      `${JSON.stringify({
        startedAt,
        finishedAt: new Date().toISOString(),
        readOnly: true,
        snapshot: "per-page-read-committed",
        pages: measuredPages,
        complete,
        next: after ?? null,
        ...Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, String(value)]),
        ),
        fields: [...fields.values()],
        onlinePayloadChanged: false,
      })}\n`,
    );
  } finally {
    await client.sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  attemptEvidenceStorageMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
