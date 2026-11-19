import { readFile, stat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertLegacyScope,
  legacyBound,
  legacyInventorySql,
  legacyNormalizeSql,
  LEGACY_UUID,
  type LegacyReportScope,
  type LegacyReportTarget,
} from "@aerodb/db/legacy-report-storage";
import { legacySha256 } from "./legacy-report-storage-gcs";
import { LegacyHubSshStore } from "./legacy-report-storage-hub";
import {
  LegacySshNormalizer,
  applyVerifiedLegacyPage,
  migrateLegacyReceipts,
  legacyNormalizationTelemetry,
} from "./legacy-report-storage-migration";
import {
  LegacySshReader,
  decodeLegacyPage,
  exportLegacyReports,
  legacyScopeHash,
  type LegacyBackupReceipt,
} from "./legacy-report-storage";

const usage = `legacy-report-storage-cli COMMAND [--name=value] [--apply] [--readers-ready]
  migrate (copy options) --readers-ready [--adopt-copy] [--registered-get=denied|unproven]
  migrate-receipts --scope=scope.json --directory=RECEIPTS --ssh-host=HZ --container=POSTGRES
                   (hub options) [--pages=32] [--apply --readers-ready]
  inventory-sql --side=worker|hub [--after=UUID] [--rows=256]
  make-scope --worker=worker.jsonl --hub=hub.jsonl --source-instance=hz-solver2 --solver-id=UUID
             --measured-at=ISO8601 [--expected-executions=N] [--expected-reports=N]
  plan|copy --scope=scope.json --directory=ABSOLUTE_PATH --ssh-host=EXISTING_ALIAS
            --container=EXACT_POSTGRES_CONTAINER --bucket=BUCKET --hub-service-account=CANONICAL_EMAIL
            --hub-ssh-host=airfoils.pro --hub-container=app-sweeper-1
            [--pg-user=aerodb] [--pg-database=aerodb] [--rows=16] [--max-bytes=67108864] [--pages=1] [--apply] [--keep-local]
  verify --scope=scope.json --receipt=FILE --bucket=BUCKET --hub-service-account=CANONICAL_EMAIL
         --hub-ssh-host=airfoils.pro --hub-container=app-sweeper-1
  recover (verify options) --output=NEW_ABSOLUTE_PATH.jsonl.gz
  extract --scope=scope.json --receipt=FILE [--archive=FILE.jsonl.gz | hub options]
          --kind=report|conflict --execution=UUID --sequence=N [--row]
  normalize-sql|restore-inline-sql --scope=scope.json --receipt=FILE [--archive=FILE.jsonl.gz | hub options] [--apply --readers-ready]
Default copy prints a plan without SSH, GCS, database or checkpoint changes.
SQL defaults to ROLLBACK. --apply only prints COMMIT SQL; the operator runs it locally on HZ.
Copy drops its single pending transfer page only after receipt and progress are durable.
No command modifies a dispatch, claim, result, polar, acknowledgement or storage-policy switch.`;

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const details = await stat(path);
  if (!details.isFile() || details.size > maxBytes)
    throw new Error("Operator input is missing or exceeds its byte limit");
  const bytes = await readFile(path);
  if (bytes.length > maxBytes)
    throw new Error("Operator input changed beyond its byte limit");
  return bytes;
}

export async function legacyReportStorageCli(args: string[]): Promise<void> {
  if (!args.length || args[0] === "--help") {
    console.log(usage);
    return;
  }
  const [command, ...raw] = args;
  const options = new Map<string, string>();
  const allowed: Record<string, string[]> = {
    "inventory-sql": ["side", "after", "rows"],
    "make-scope": [
      "worker",
      "hub",
      "source-instance",
      "solver-id",
      "measured-at",
      "expected-executions",
      "expected-reports",
    ],
    plan: [
      "scope",
      "directory",
      "ssh-host",
      "container",
      "bucket",
      "hub-service-account",
      "hub-ssh-host",
      "hub-container",
      "pg-user",
      "pg-database",
      "rows",
      "pages",
      "max-bytes",
    ],
    copy: [
      "scope",
      "directory",
      "ssh-host",
      "container",
      "bucket",
      "hub-service-account",
      "hub-ssh-host",
      "hub-container",
      "pg-user",
      "pg-database",
      "rows",
      "pages",
      "max-bytes",
      "apply",
      "keep-local",
    ],
    verify: [
      "scope",
      "receipt",
      "bucket",
      "hub-service-account",
      "hub-ssh-host",
      "hub-container",
    ],
    "normalize-sql": ["scope", "receipt", "archive", "apply", "readers-ready"],
    "restore-inline-sql": [
      "scope",
      "receipt",
      "archive",
      "apply",
      "readers-ready",
    ],
  };
  const hubOptions = [
    "hub-ssh-host",
    "hub-container",
    "bucket",
    "hub-service-account",
  ];
  allowed.recover = [...allowed.verify, "output"];
  allowed.migrate = [
    ...allowed.copy,
    "readers-ready",
    "adopt-copy",
    "registered-get",
  ];
  allowed["migrate-receipts"] = [
    "scope",
    "directory",
    "ssh-host",
    "container",
    "pg-user",
    "pg-database",
    "pages",
    "apply",
    "readers-ready",
    "registered-get",
    ...hubOptions,
  ];
  allowed.extract = [
    "scope",
    "receipt",
    "archive",
    "kind",
    "execution",
    "sequence",
    "row",
    ...hubOptions,
  ];
  allowed["normalize-sql"].push(...hubOptions);
  allowed["restore-inline-sql"].push(...hubOptions);
  const booleans = [
    "apply",
    "readers-ready",
    "keep-local",
    "row",
    "adopt-copy",
  ];
  if (!allowed[command]) throw new Error(usage);
  for (const arg of raw) {
    const match = /^--([a-z-]+)(?:=(.+))?$/.exec(arg);
    if (
      !match ||
      !allowed[command].includes(match[1]) ||
      options.has(match[1]) ||
      (!match[2] && !booleans.includes(match[1])) ||
      (match[2] && booleans.includes(match[1]))
    )
      throw new Error(usage);
    options.set(match[1], match[2] ?? "true");
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  const number = (key: string, fallback: number, max: number) =>
    legacyBound(Number(options.get(key) ?? fallback), max, key);
  const registeredGet = options.get("registered-get") ?? "unproven";
  if (registeredGet !== "denied" && registeredGet !== "unproven")
    throw new Error(
      "Registered GET status may only record denied or unproven; it never grants cold deletion",
    );
  if (command === "inventory-sql") {
    const side = required("side");
    if (side !== "worker" && side !== "hub")
      throw new Error("Invalid inventory side");
    console.log(
      legacyInventorySql(side, options.get("after"), number("rows", 256, 1000)),
    );
    return;
  }
  if (command === "make-scope") {
    const inventory = async (key: string) =>
      (await readBounded(required(key), 16 * 1024 ** 2))
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const workers = await inventory("worker");
    const hub = await inventory("hub");
    for (const rows of [workers, hub]) {
      let previous = "";
      for (const row of rows) {
        if (!LEGACY_UUID.test(row.executionId) || row.executionId <= previous)
          throw new Error(
            "Inventory pages must be complete, sorted and unique",
          );
        previous = row.executionId;
      }
    }
    if (
      hub.some(
        (r) =>
          typeof r.hasReports !== "boolean" ||
          typeof r.hasDispatch !== "boolean",
      )
    )
      throw new Error("Hub inventory must distinguish reports and dispatches");
    const hasHubReports = new Set(
      hub
        .filter((r) => r.hasReports || r.hasDispatch)
        .map((r) => r.executionId),
    );
    const scope: LegacyReportScope = {
      version: 1,
      sourceInstance: required("source-instance"),
      solverId: required("solver-id"),
      measuredAt: required("measured-at"),
      executions: workers.filter(
        (r) => !hasHubReports.has(r.executionId),
      ) as LegacyReportTarget[],
    };
    assertLegacyScope(scope);
    if (
      options.has("expected-executions") &&
      scope.executions.length !== number("expected-executions", 1, 10000)
    )
      throw new Error(
        "Orphan cohort count differs; reconcile inventories instead of changing ownership",
      );
    if (
      options.has("expected-reports") &&
      scope.executions.reduce((n, item) => n + item.reports, 0) !==
        number("expected-reports", 1, Number.MAX_SAFE_INTEGER)
    )
      throw new Error(
        "Orphan report count differs; reconcile the complete metadata inventories",
      );
    console.log(JSON.stringify(scope, null, 2));
    return;
  }
  const scope = JSON.parse(
    (await readBounded(required("scope"), 4 * 1024 ** 2)).toString("utf8"),
  ) as LegacyReportScope;
  assertLegacyScope(scope);
  if (command === "migrate-receipts") {
    if (options.has("apply") && !options.has("readers-ready"))
      throw new Error("migrate-receipts --apply requires --readers-ready");
    const result = await migrateLegacyReceipts({
      scope,
      directory: required("directory"),
      pages: number("pages", 32, 32),
      apply: options.has("apply"),
      store: new LegacyHubSshStore(
        required("hub-ssh-host"),
        required("hub-container"),
        required("bucket"),
        required("hub-service-account"),
      ),
      normalizer: new LegacySshNormalizer(
        required("ssh-host"),
        required("container"),
        options.has("readers-ready"),
        options.get("pg-user"),
        options.get("pg-database"),
        registeredGet,
      ),
    });
    console.log(
      JSON.stringify({
        ...result,
        ...result.telemetry,
        operation: command,
        countsArePerInvocation: true,
      }),
    );
    return;
  }
  if (command === "plan" || command === "copy" || command === "migrate") {
    const rows = number("rows", 16, 128);
    const maxBytes = number("max-bytes", 64 * 1024 ** 2, 256 * 1024 ** 2);
    const pages = number("pages", 1, 32);
    const directory = required("directory");
    if (!directory.startsWith("/"))
      throw new Error("Backup directory must be absolute");
    const source = new LegacySshReader(
      required("ssh-host"),
      required("container"),
      options.get("pg-user"),
      options.get("pg-database"),
    );
    const bucket = required("bucket");
    const serviceAccount = required("hub-service-account");
    const hubHost = required("hub-ssh-host");
    const hubContainer = required("hub-container");
    const store = new LegacyHubSshStore(
      hubHost,
      hubContainer,
      bucket,
      serviceAccount,
    );
    if (command === "plan" || !options.has("apply")) {
      console.log(
        JSON.stringify(
          {
            mode: "plan",
            operation: command === "migrate" ? "migrate" : "copy",
            fallbackEligibility:
              command === "migrate"
                ? {
                    registeredGet,
                    terminalEvidenceSafety: "unproven",
                    strategy: "postgres-0198-local-payload-sharing",
                    coldBodyDeletion: false,
                  }
                : null,
            executions: scope.executions.length,
            scopeSha256: legacyScopeHash(scope),
            rows,
            maxBytes,
            pages,
            transferRetention: options.has("keep-local")
              ? "retain each verified gzip by explicit request"
              : "one pending page; drop after durable receipt and progress",
            directory,
            source: {
              host: source.host,
              command: source.command,
              readOnly: true,
            },
            destination: {
              bucket,
              hubHost,
              hubContainer,
              canonicalHubServiceAccount: serviceAccount,
              prefix: "legacy-worker-reports/v1",
              createOnly: true,
              generationPinnedReadback: true,
            },
            normalization:
              command === "migrate"
                ? "execute exact guarded 0198 SQL after durable GCS readback; requires --readers-ready and existing enabled policy"
                : "copy only; migrate-receipts can normalize verified pages later",
            writes:
              "none in plan; copy writes only hub backup objects and local backup progress",
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === "migrate" && !options.has("readers-ready"))
      throw new Error("migrate --apply requires --readers-ready");
    const copyBinding = JSON.stringify({
      host: source.host,
      command: source.command,
      bucket,
      serviceAccount,
      hubHost,
      hubContainer,
    });
    const normalizer =
      command === "migrate"
        ? new LegacySshNormalizer(
            source.host,
            required("container"),
            true,
            options.get("pg-user"),
            options.get("pg-database"),
            registeredGet,
          )
        : null;
    try {
      const result = await exportLegacyReports({
        scope,
        source,
        store,
        directory,
        rows,
        maxBytes,
        pages,
        keepLocal: options.has("keep-local"),
        sourceBinding: normalizer
          ? JSON.stringify({
              operation: "migrate",
              copyBinding,
              normalizerBinding: normalizer.binding,
            })
          : copyBinding,
        applyVerifiedPage: normalizer
          ? async (page, receipt, receiptFile) => {
              const proof = await applyVerifiedLegacyPage({
                page,
                receipt,
                receiptFile,
                directory,
                normalizer,
              });
              return legacyNormalizationTelemetry(proof, page.members.length);
            }
          : undefined,
        adoptCopy:
          normalizer && options.has("adopt-copy")
            ? {
                sourceBinding: copyBinding,
                applyReceipts: async (through) => {
                  const result = await migrateLegacyReceipts({
                    scope,
                    directory,
                    store,
                    normalizer,
                    pages: 32,
                    apply: true,
                    through,
                  });
                  if (!result.complete)
                    throw new Error(
                      "Copy receipt adoption made bounded progress; run migrate-receipts again, then repeat migrate --adopt-copy",
                    );
                  return result.telemetry;
                },
              }
            : undefined,
      });
      console.log(
        JSON.stringify({
          ...result,
          sourceSshConnections: source.connectionCount,
          sourceQueries: source.queryCount,
          operation: command,
        }),
      );
    } finally {
      await source.close();
    }
    return;
  }
  const receipt = JSON.parse(
    (await readBounded(required("receipt"), 65536)).toString("utf8"),
  ) as LegacyBackupReceipt;
  if (
    receipt.scopeSha256 !== legacyScopeHash(scope) ||
    receipt.sourceInstance !== scope.sourceInstance ||
    receipt.solverId !== scope.solverId ||
    !receipt.object.objectKey.startsWith(
      `legacy-worker-reports/v1/${scope.sourceInstance}/${scope.solverId}/${receipt.scopeSha256}/`,
    )
  )
    throw new Error("Backup receipt belongs to another source/scope");
  if (command === "verify" || command === "recover") {
    const bytes = await new LegacyHubSshStore(
      required("hub-ssh-host"),
      required("hub-container"),
      required("bucket"),
      required("hub-service-account"),
    ).read(receipt.object);
    const page = decodeLegacyPage(bytes, receipt);
    if (command === "recover") {
      const output = required("output");
      if (!output.startsWith("/"))
        throw new Error("Recovery output must be an absolute new file");
      const file = await open(output, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const directory = await open(dirname(output), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    console.log(
      JSON.stringify({
        generation: receipt.object.generation,
        sha256: legacySha256(bytes),
        members: page.members.length,
        verified: true,
        restoreAuthorityGranted: false,
        localRemovalAllowed: false,
        recoveredTo: options.get("output") ?? null,
      }),
    );
    return;
  }
  const bytes = options.has("archive")
    ? await readBounded(required("archive"), receipt.object.byteSize)
    : await new LegacyHubSshStore(
        required("hub-ssh-host"),
        required("hub-container"),
        required("bucket"),
        required("hub-service-account"),
      ).read(receipt.object);
  const page = decodeLegacyPage(bytes, receipt);
  for (const member of page.members) {
    const item = scope.executions.find(
      (e) => e.executionId === member.executionId,
    );
    if (
      !item ||
      (member.kind === "report" &&
        member.sequence <= (item.reportAfter ?? 0)) ||
      member.sequence >
        (member.kind === "report"
          ? item.reportHighWater
          : item.conflictHighWater) ||
      (member.kind === "report" && member.solverId !== scope.solverId)
    )
      throw new Error("Normalization member is outside frozen scope");
  }
  if (command === "extract") {
    const kind = required("kind"),
      execution = required("execution");
    const sequence = number("sequence", 0, Number.MAX_SAFE_INTEGER);
    const member = page.members.find(
      (m) =>
        m.kind === kind &&
        m.executionId === execution &&
        m.sequence === sequence,
    );
    if (!member)
      throw new Error(
        "Exact requested report/conflict is absent from this immutable page",
      );
    process.stdout.write(
      options.has("row") ? member.rowText : member.reportText,
    );
    return;
  }
  if (!page.members.length) {
    console.log("-- Metadata-only completion page; no representation changes.");
    return;
  }
  console.log(
    legacyNormalizeSql(page.members, {
      apply: options.has("apply"),
      readersReady: options.has("readers-ready"),
      restoreInline: command === "restore-inline-sql",
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  legacyReportStorageCli(process.argv.slice(2)).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
