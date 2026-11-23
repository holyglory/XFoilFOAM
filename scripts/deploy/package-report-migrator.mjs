import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const entry = "legacy-cli.mjs";
const check = "package-report-migrator";
const artifact = "report-migrator";
const target = "report-storage-operator";
const governed = process.env.DEVCOORDINATOR_CHECK_NAME === check;
if (!governed && !process.argv[2]) throw new Error("Supply a new output directory for the report migrator");
const out = governed ? join(root, ".codex-artifacts", artifact) : resolve(process.argv[2]);
const run = process.env.DEVCOORDINATOR_RUN_ID;
const compiler = dirname(require.resolve("typescript/package.json"));
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

await mkdir(dirname(out), { recursive: true });
const temp = await mkdtemp(join(dirname(out), ".report-migrator-"));
try {
  execFileSync("python3", ["-B", join(root, "tests/test_legacy_bulk_qualification.py")], { cwd: root, stdio: "inherit" });
  const compile = await build({
    absWorkingDir: root, entryPoints: ["apps/sweeper/src/legacy-report-storage-cli.ts"],
    bundle: true, format: "esm", platform: "node", target: "node22",
    external: ["typescript"], banner: { js: "#!/usr/bin/env node" },
    outfile: join(temp, entry), metafile: true, logLevel: "silent",
  });
  for (const output of Object.values(compile.metafile.outputs)) {
    assert(output.imports.every((item) => !item.external || item.path.startsWith("node:") || item.path === "typescript"));
  }
  await chmod(join(temp, entry), 0o755);
  for (const helper of ["legacy-report-storage-gcs.ts", "legacy-report-storage-custody-worker.ts"]) {
    await copyFile(join(root, "apps/sweeper/src", helper), join(temp, helper));
  }
  const sampler = "legacy-report-peer-memory-sampler.cjs";
  await copyFile(join(root, "apps/sweeper/src", sampler), join(temp, sampler));
  await copyFile(join(root, "scripts/deploy/legacy_report_host_capacity.py"), join(temp, "legacy_report_host_capacity.py"));
  const installed = join(temp, "node_modules/typescript");
  await mkdir(join(installed, "lib"), { recursive: true });
  for (const name of ["package.json", "lib/typescript.js", "LICENSE.txt", "ThirdPartyNoticeText.txt"]) {
    await copyFile(join(compiler, name), join(installed, name));
  }
  // Exercise the shipped compiler and both remote helpers from the bundle.
  const cli = join(temp, entry);
  const loader = createRequire(cli);
  assert.equal(loader.resolve("typescript"), join(installed, "lib/typescript.js"));
  assert.equal(typeof loader("./" + sampler).watchCustodyMemory, "function");
  const ts = loader("typescript");
  for (const helper of ["legacy-report-storage-gcs.ts", "legacy-report-storage-custody-worker.ts"]) {
    const { outputText } = ts.transpileModule(await readFile(join(temp, helper), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    execFileSync(process.execPath, ["--check", "--input-type=module"], { input: outputText });
  }
  const inventory = execFileSync(cli, ["inventory-sql", "--side=worker", "--rows=2"], { cwd: temp, encoding: "utf8" });
  assert.match(inventory, /READ ONLY/i);
  assert.match(inventory, /progressive_worker_reports/);
  assert.match(inventory, /LIMIT 2\b/);
  const help = execFileSync(cli, ["--help"], { cwd: temp, encoding: "utf8" });
  for (const name of ["migrate-receipts", "--until-complete", "--worker-sweeper-container", "--execution-slots"]) assert(help.includes(name));

  if (governed) {
    execFileSync("python3", ["-B", join(root, "tests/test_legacy_report_host_capacity.py")], { cwd: root, stdio: "inherit" });
    execFileSync(process.execPath, [join(root, "scripts/deploy/check-report-peer-cgroup.mjs")], { cwd: root, stdio: "inherit", timeout: 155000 });
    assert.match(run ?? "", /^t[0-9]{8}T[0-9]{6}Z-[a-f0-9]+$/);
    const executor = process.env.DEVCOORDINATOR_EXECUTOR ??
      join(dirname(await realpath("/usr/local/bin/devcoordinator2")), "devcoordinator2-executor");
    const source = JSON.parse(execFileSync(executor, ["source-digest", "--worktree", root], { encoding: "utf8" })).sha256;
    const repo = JSON.parse(execFileSync("devcoordinator2", ["call", "repository.status", "--params-file", "-"], {
      input: JSON.stringify({ path: root }), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    }));
    assert.match(source, /^[0-9a-f]{64}$/);
    assert.match(repo.data?.worktree_id ?? "", /^w[0-9a-f]+$/);
    const access = `artifact://${repo.data.worktree_id}/${run}/${check}/${artifact}/${entry}`;
    await writeFile(join(temp, "worker-inventory.sql"), inventory);
    await writeFile(join(temp, "delivery.json"), json({
      version: 1, kind: "local-executable", target, source_sha256: source,
      file: entry, observed_sha256: digest(await readFile(cli)), checked_at_ms: Date.now(),
      access, observation: "executable_smoke_passed",
    }));
    await writeFile(join(temp, "completion.json"), json({
      schema_version: 1, claim: "preliminary", source_sha256: source,
      capabilities: [
        { id: "run-report-migrator", scope: "product", state: "real_e2e",
          expected_result: "Run the packaged operator and generate the bounded read-only inventory for historical worker reports.",
          evidence_refs: ["worker-inventory.sql", "delivery.json", `run/${run}/${check}/${artifact}`] },
        { id: "historical-report-migration", scope: "product", state: "deferred", task_id: "p38fbca38f08790ac",
          expected_result: "Complete the historical transfer with every report and its eligibility to release verified." },
        { id: "cold-attempt-histories", scope: "product", state: "deferred", task_id: "p8e76960d348e554c",
          expected_result: "Read settled attempt histories from cloud storage while preserving classifications and polar calculations." },
      ],
    }));
    // Only the declared per-worktree output is reused by the verification graph.
    await rm(out, { recursive: true, force: true });
  }
  await rename(temp, out);
} finally {
  await rm(temp, { recursive: true, force: true });
}
