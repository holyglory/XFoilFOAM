// Private stdin peer. The SSH supervisor forwards signed native calls while the job transaction is open.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { compileFunction } from "node:vm";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const frames = lines[Symbol.asyncIterator]();
const next = async () => {
  const frame = await frames.next();
  if (frame.done || Buffer.byteLength(frame.value) > 2 * 1024 ** 2)
    throw Error("Maintenance transport ended or exceeded its bound");
  return JSON.parse(frame.value);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
function mac(key, kind, nonce, body) {
  return createHmac("sha256", key)
    .update(
      "XFoilFOAM closed-job exec v1\0" + kind + "\0" + nonce + "\0" + body,
    )
    .digest("hex");
}

async function run() {
  const boot = await next(),
    scope = boot.scope;
  if (
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" ||
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim()
  )
    throw Error(
      "Maintenance requires the credentialless remote-solver profile",
    );
  const actualSources = {};
  for (const [path, reviewed] of Object.entries(boot.nodeHashes)) {
    const actual = digest(readFileSync(path));
    actualSources[path] = actual;
    if (!reviewed.includes(actual))
      throw Error("Installed Node source differs: " + path);
  }
  if (digest(boot.sql) !== boot.sqlSha)
    throw Error("SQL helper digest differs");
  const filename = resolve("apps/sweeper/src/closed-progressive-retention.ts");
  const require = createRequire(filename),
    ts = require("typescript");
  const dbRequire = createRequire(resolve("packages/db/src/client.ts"));
  const rootRequire = createRequire(resolve("package.json"));
  const entries = [
    ["typescript", require],
    ["tsx", rootRequire],
    ["drizzle-orm", require],
    ["drizzle-orm/postgres-js", dbRequire],
    ["postgres", dbRequire],
    ["@aerodb/db", require],
    ["@aerodb/core", require],
    ["@aerodb/engine-client", require],
  ];
  const runtimeDependencies = {
    node: process.version,
    modules: process.versions.modules,
    openssl: process.versions.openssl,
    sources: actualSources,
    entries: Object.fromEntries(
      entries.map(([name, resolver]) => [
        name,
        digest(readFileSync(resolver.resolve(name))),
      ]),
    ),
  };
  const dependenciesSha256 = digest(JSON.stringify(runtimeDependencies));
  const nodePackagesSha256 = digest(
    JSON.stringify({
      version: process.version,
      abi: process.versions.modules,
      openssl: process.versions.openssl,
      lock: actualSources["pnpm-lock.yaml"],
      entries: Object.fromEntries(
        Object.entries(runtimeDependencies.entries).filter(
          ([name]) => !name.startsWith("@aerodb/"),
        ),
      ),
    }),
  );
  if (scope.nodePackages && scope.nodePackages !== nodePackagesSha256)
    throw Error("Installed Node package fingerprint changed");

  if (scope.dependencies && dependenciesSha256 !== scope.dependencies)
    throw Error("Installed Node dependency fingerprint changed");
  const { outputText } = ts.transpileModule(boot.sql, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports = {};
  compileFunction(outputText, ["require", "exports"], { filename })(
    require,
    exports,
  );
  const { createClient } = require("@aerodb/db/client");
  const { configuredControlPlaneToken } = require("./config.ts");
  const {
    retentionConfigFromEnv,
    DEFAULT_RETENTION_QUERY_TIMEOUT_MS,
  } = require("./retention.ts");
  const token = configuredControlPlaneToken();
  if (!token)
    throw Error("Engine control-plane authentication is not configured");
  const inspect = scope.mode === "proof" || scope.mode === "verify";
  if (
    !inspect &&
    !(scope.mode === "reclaim" && /^[0-9a-f]{64}$/.test(scope.plan))
  )
    throw Error("An exact plan is required");
  const client = createClient({
    max: 1,
    connection: {
      default_transaction_read_only: inspect ? "on" : "off",
      statement_timeout: "30s",
      lock_timeout: "500ms",
      application_name: "closed-progressive-operator",
    },
  });
  let step = 0;
  try {
    const [mode] = await client.sql.unsafe("SHOW transaction_read_only");
    if ((mode.transaction_read_only === "on") !== inspect)
      throw Error("Unexpected database transaction mode");
    if (!inspect) {
      // A lost operator response after commit is an observation of the recorded outcome.
      // It neither authorizes a second unlink nor fabricates a new cloud readback.
      const [prior] = await client.sql.unsafe(
        "SELECT strip_report->'closedProgressiveFiles' AS receipt FROM sim_jobs WHERE id=$1::uuid",
        [scope.id],
      );
      if (prior?.receipt?.complete === true) {
        if (prior.receipt.planSha256 !== scope.plan)
          throw Error("A different plan is already complete");
        return {
          status: "already-settled",
          record: prior.receipt,
          dependenciesSha256,
          nodePackagesSha256,
          databaseReadOnly: false,
          bytesFreedThisRun: 0,
        };
      }
    }
    const backend = {
      async reclaimClosedProgressiveFiles(
        id,
        manifests,
        expectedPlan,
        readbacks = [],
      ) {
        ++step;
        if (
          id !== scope.id ||
          !(
            (step === 1 && expectedPlan === undefined) ||
            (step === 2 && !inspect && expectedPlan === scope.plan)
          )
        )
          throw Error("Unexpected maintenance step");
        const body = JSON.stringify({
          id,
          step,
          helper: scope.helper,
          mode: scope.mode,
          manifests,
          expectedPlan,
          readbacks,
        });
        emit({
          type: "engine",
          step,
          packet: { body, mac: mac(token, "request", scope.nonce, body) },
        });
        const reply = await next();
        if (reply.refused)
          throw Error("Engine refused: " + String(reply.refused).slice(0, 400));
        const signed = mac(token, "response", scope.nonce, reply.body);
        if (
          !/^[0-9a-f]{64}$/.test(reply.mac) ||
          !timingSafeEqual(
            Buffer.from(signed, "hex"),
            Buffer.from(reply.mac, "hex"),
          )
        )
          throw Error("Maintenance response authentication failed");
        const response = JSON.parse(reply.body);
        if (response.id !== id || response.step !== step)
          throw Error("Maintenance response belongs to another request");
        if (scope.plan && (!response.result.files || !response.result.bytes))
          throw Error("Pinned plan has no positive exact duplicates");
        return response.result;
      },
    };
    const result = await exports.closedProgressiveJob(
      client.db,
      backend,
      scope.id,
      {
        now: new Date(),
        ageMs: retentionConfigFromEnv().stripMinAgeMs,
        timeoutMs: DEFAULT_RETENTION_QUERY_TIMEOUT_MS,
        inspect,
        expectedPlan: scope.plan ?? undefined,
        verifyCompleted: scope.mode === "verify",
        expectedScientificSha256: scope.expectedScience ?? undefined,
        signal: AbortSignal.timeout(20 * 60_000),
      },
    );
    if (!inspect && !result.settled)
      throw Error("Final locked ownership or eligibility check refused");
    return {
      status:
        scope.mode === "verify" ? "verified" : inspect ? "proved" : "settled",
      databaseReadOnly: inspect,
      dependenciesSha256,
      nodePackagesSha256,
      ...result,
    };
  } finally {
    await client.sql.end({ timeout: 2 });
  }
}
try {
  emit({ type: "result", value: await run() });
} catch (error) {
  // SQL errors may include query parameters. Only safe, bounded diagnostics leave this process.
  const message = String(error?.message ?? "Maintenance failed");
  emit({
    type: /^(Installed Node|SQL helper|Maintenance transport|Unexpected maintenance|Unexpected database|Engine control-plane authentication|Maintenance response|Failed query:|fetch failed|.*ENOTFOUND|.*ECONNRESET)/.test(
      message,
    )
      ? "fault"
      : "refusal",
    reason: message.startsWith("Failed query:")
      ? "Database custody query refused"
      : message.replace(/[\r\n].*/s, "").slice(0, 400),
  });
  process.exitCode = 1;
} finally {
  lines.close();
  process.stdin.destroy();
}
