import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [mode, checkout, revision, fixture, installation, scopeFile] =
  process.argv.slice(2);
const root = resolve(checkout),
  source = (path) =>
    execFileSync("git", ["-C", root, "show", `${revision}:${path}`], {
      encoding: "utf8",
      maxBuffer: 12 * 1024 ** 2,
    });
const load = createRequire(join(root, "package.json")),
  sha = (value) => createHash("sha256").update(value).digest("hex");
const files = execFileSync(
  "git",
  [
    "-C",
    root,
    "ls-tree",
    "-r",
    "--name-only",
    revision,
    "apps/sweeper/src",
    "packages/db/src",
  ],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((f) => /\/legacy-[^/]+\.(?:ts|cjs)$/.test(f));
if (mode === "fingerprint") {
  // Track the declarations actually imported by legacy readers from the shared archive module.
  const ts = load("typescript"),
    { build } = createRequire(load.resolve("tsx/package.json"))("esbuild");
  const names = new Set(),
    fingerprint = createHash("sha256");
  let wholeSharedModule = false;
  for (const path of [
    ...files,
    "apps/sweeper/src/worker-report-volume.ts",
    "apps/sweeper/src/config.ts",
    "packages/db/src/client.ts",
    "pnpm-lock.yaml",
  ]) {
    const body = source(path);
    fingerprint.update(path).update("\0").update(body).update("\0");
    if (!path.endsWith(".ts")) continue;
    const tree = ts.createSourceFile(path, body, ts.ScriptTarget.Latest);
    for (const node of tree.statements) {
      if (!node.moduleSpecifier?.text?.endsWith("progressive-report-archive"))
        continue;
      if (
        !ts.isImportDeclaration(node) ||
        !node.importClause ||
        node.importClause.name
      ) {
        wholeSharedModule = true;
        continue;
      }
      if (node.importClause.isTypeOnly) continue;
      const imports = node.importClause.namedBindings;
      if (!imports || !ts.isNamedImports(imports)) {
        wholeSharedModule = true;
        continue;
      }
      for (const n of imports.elements)
        if (!n.isTypeOnly) names.add((n.propertyName ?? n.name).text);
    }
  }
  const shared = source("packages/db/src/progressive-report-archive.ts");
  const compiled = await build({
    stdin: {
      contents: wholeSharedModule
        ? 'export * from "archive-body"'
        : `export {${[...names].sort().join(",")}} from "archive-body";`,
      loader: "ts",
    },
    treeShaking: true,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "shared-source",
        setup(api) {
          api.onResolve({ filter: /^archive-body$/ }, () => ({
            path: "shared-archive.ts",
            namespace: "source",
          }));
          api.onLoad({ filter: /.*/, namespace: "source" }, () => ({
            contents: shared,
            loader: "ts",
          }));
        },
      },
    ],
  });
  fingerprint.update(compiled.outputFiles[0].contents);
  console.log(JSON.stringify({ sha256: fingerprint.digest("hex") }));
} else {
  assert.equal(mode, "replay");
  const local = (p) => import(pathToFileURL(resolve(root, p)));
  const read = (name) => readFileSync(join(fixture, name));
  const receipt = JSON.parse(read("receipt.json")),
    applied = JSON.parse(read("applied.json")),
    packed = read("frozen-page.jsonl.gz");
  assert.equal(sha(read("receipt.json")), applied.archiveReceiptSha256);
  assert.equal(sha(packed), receipt.object.sha256);
  assert.equal(applied.proof.transactionCommitted, true);
  assert.equal(applied.proof.coldReleaseComplete, true);
  assert.equal(
    receipt.scopeSha256,
    sha(JSON.stringify(JSON.parse(readFileSync(scopeFile)))),
  );
  process.env.AIRFOILFOAM_REPORT_VOLUME_DIR = resolve(fixture, "volume");
  const codec = await local("packages/db/src/legacy-report-storage-codec.ts"),
    custody = await local("packages/db/src/legacy-report-custody.ts");
  const worker = await local(
      "apps/sweeper/src/legacy-report-storage-custody-worker.ts",
    ),
    product = await local(
      "apps/sweeper/src/legacy-worker-report-product-read.ts",
    );
  const gold = applied.proof.rowProofs,
    total = gold.reduce((n, m) => n + m.rowByteSize + m.reportByteSize, 0);
  assert.ok(
    total >= 0.9 * 256 * 1024 ** 2 &&
      total <= 256 * 1024 ** 2 &&
      gold.length === receipt.memberCount,
  );
  const target = gold.reduce((a, b) =>
    a.reportByteSize > b.reportByteSize ? a : b,
  );
  for (const row of [false, true]) {
    const bytes = execFileSync(
      process.execPath,
      [
        join(installation, "legacy-cli.mjs"),
        "extract",
        `--scope=${scopeFile}`,
        `--receipt=${join(fixture, "receipt.json")}`,
        `--archive=${join(fixture, "frozen-page.jsonl.gz")}`,
        `--execution=${target.executionId}`,
        `--kind=${target.kind}`,
        `--sequence=${target.sequence}`,
        ...(row ? ["--row"] : []),
      ],
      {
        maxBuffer: Math.max(target.rowByteSize, target.reportByteSize) + 65536,
        timeout: 120000,
      },
    );
    assert.equal(sha(bytes), row ? target.rowSha256 : target.reportSha256);
  }
  const began = performance.now(),
    cpu = process.cpuUsage(),
    page = codec.decodeLegacyPage(packed, receipt);
  let readback;
  const proof = await custody.verifyLegacyReportCustodyPage({
    page,
    object: receipt.object,
    access: {
      mode: "hub-local-reader",
      readHubObject: async () => packed,
      reader: {
        readPage: async (i) => {
          const owner = {
            execute: async () => [
              {
                source_instance: receipt.sourceInstance,
                solver_id: receipt.solverId,
              },
            ],
          };
          readback = await product.readLegacyWorkerReportArchivePage(owner, i);
          return readback;
        },
      },
    },
  });
  assert.deepEqual(proof.memberProofs, gold);
  assert.deepEqual(readback.proof.members, gold);
  assert.equal(
    readback.proof.memberProofSha256,
    applied.proof.custody.productReadback.proof.memberProofSha256,
  );
  custody.legacyReportCustodySql(proof, { apply: false, readersReady: true });
  let boundary = 0;
  const offline = {
    unsafe(query) {
      assert.ok(query.startsWith("SET LOCAL statement_timeout"));
      boundary++;
      return {
        simple() {
          throw Error("offline SQL boundary");
        },
      };
    },
  };
  await assert.rejects(
    () =>
      worker.applyLegacyCustodyWorkerTransaction(offline, {
        page,
        object: receipt.object,
        proof,
        custody,
        normalization: {},
        codec,
        productBytes: readback.storedBytes,
        verifiedMembers: readback.proof.members,
      }),
    (e) => e.workerPhase === "transaction_setup",
  );
  assert.equal(boundary, 1);
  const elapsedMs = performance.now() - began,
    used = process.cpuUsage(cpu);
  assert.ok(elapsedMs < 120000);
  console.log(
    JSON.stringify({
      scope: receipt.scopeSha256,
      receiptSha256: applied.archiveReceiptSha256,
      generation: receipt.object.generation,
      memberProofSha256: readback.proof.memberProofSha256,
      logicalBytes: total,
      members: gold.length,
      peakRssKiB: process.resourceUsage().maxRSS,
      cpuMs: (used.user + used.system) / 1000,
      elapsedMs,
    }),
  );
}
