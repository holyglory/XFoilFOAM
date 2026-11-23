// Private stdin peer. The SSH supervisor forwards signed native calls while the job transaction is open.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { compileFunction } from "node:vm";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
function mac(key, kind, nonce, body) {
  return createHmac("sha256", key)
    .update(
      "XFoilFOAM closed-job exec v1\0" + kind + "\0" + nonce + "\0" + body,
    )
    .digest("hex");
}

const brokerDownload =
  /^\/api\/sync\/v1\/evidence-uploads\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/download$/i;

async function admissionDelay(response) {
  if (
    response.status !== 503 ||
    response.headers.get("content-type")?.split(";")[0] !== "application/json"
  )
    return 0;
  const bytes = Number(response.headers.get("content-length"));
  const seconds = Number(response.headers.get("retry-after"));
  if (
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    bytes > 1024 ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds * 1000 > 2 ** 31 - 1
  )
    return 0;
  const busy = await response
    .clone()
    .json()
    .catch(() => null);
  return busy?.code === "sync_capacity_busy" &&
    busy.retryAfterMs === seconds * 1000
    ? busy.retryAfterMs
    : 0;
}

/** The dispatcher and Fetch override live only in the one-shot operator peer. */
export async function withReadbackTransport(undici, verify, onBusy = () => {}) {
  const previous = undici.getGlobalDispatcher();
  const previousFetch = globalThis.fetch;
  const agent = new undici.Agent({ headersTimeout: 0, bodyTimeout: 0 });
  undici.setGlobalDispatcher(agent);
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? URL.parse(input)
        : null;
    if (
      !url ||
      !brokerDownload.test(url.pathname) ||
      url.search ||
      (init?.method ?? "GET") !== "GET" ||
      init?.redirect !== "error" ||
      !init.signal ||
      !new Headers(init.headers).has("x-xfoilfoam-solver-token")
    ) {
      return previousFetch(input, init);
    }
    let backoff = 1000;
    for (;;) {
      const response = await previousFetch(input, init);
      const wait = await admissionDelay(response);
      if (!wait) return response;
      await response.body?.cancel();
      onBusy();
      try {
        await delay(Math.max(wait, backoff), undefined, {
          signal: init.signal,
        });
      } catch (error) {
        if (init.signal.aborted)
          throw new Error("fetch failed: archive admission deadline expired", {
            cause: error,
          });
        throw error;
      }
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  try {
    return await verify();
  } finally {
    globalThis.fetch = previousFetch;
    undici.setGlobalDispatcher(previous);
    await agent.destroy();
  }
}

async function run(next) {
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
  const engineRequire = createRequire(
    resolve("packages/engine-client/package.json"),
  );
  const entries = [
    ["typescript", require],
    ["tsx", rootRequire],
    ["drizzle-orm", require],
    ["drizzle-orm/postgres-js", dbRequire],
    ["postgres", dbRequire],
    ["undici", engineRequire],
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
        if (
          prior.receipt.planSha256 !== scope.plan ||
          Boolean(prior.receipt.mediaSha256) !== Boolean(scope.keepMedia) ||
          (scope.expectedMedia &&
            scope.expectedMedia !== prior.receipt.mediaSha256)
        )
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
          ...(scope.keepMedia ? { keepMedia: true } : {}),
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
    let admissionRetries = 0;
    const result = await withReadbackTransport(
      engineRequire("undici"),
      () =>
        exports.closedProgressiveJob(client.db, backend, scope.id, {
          now: new Date(),
          ageMs: retentionConfigFromEnv().stripMinAgeMs,
          timeoutMs: DEFAULT_RETENTION_QUERY_TIMEOUT_MS,
          inspect,
          expectedPlan: scope.plan ?? undefined,
          verifyCompleted: scope.mode === "verify",
          expectedScientificSha256: scope.expectedScience ?? undefined,
          keepMedia: scope.keepMedia === true,
          expectedMediaSha256: scope.expectedMedia ?? undefined,
          signal: AbortSignal.timeout(20 * 60_000),
        }),
      () => {
        admissionRetries++;
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
      admissionRetries,
      ...result,
    };
  } finally {
    await client.sql.end({ timeout: 2 });
  }
}
// Node 22.18+ reports import.meta.main for both a file and the SSH peer's -e entry.
const main =
  import.meta.main ??
  fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "[eval1]");
if (main) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const frames = lines[Symbol.asyncIterator]();
  const next = async () => {
    const frame = await frames.next();
    if (frame.done || Buffer.byteLength(frame.value) > 2 * 1024 ** 2)
      throw Error("Maintenance transport ended or exceeded its bound");
    return JSON.parse(frame.value);
  };
  try {
    emit({ type: "result", value: await run(next) });
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
}
