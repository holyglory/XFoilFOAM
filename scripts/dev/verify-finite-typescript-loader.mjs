import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const directory = mkdtempSync(
  join(process.env.DEVCOORDINATOR_CHECK_SCRATCH, "finite-typescript-"),
);
const blocked = join(directory, "block-cli-ipc.mjs");
const entry = join(directory, "entry.ts");
const scratch = join(directory, "long-scratch-".repeat(12));
mkdirSync(scratch);
writeFileSync(
  blocked,
  "import net from 'node:net'; const listen = net.Server.prototype.listen; net.Server.prototype.listen = function (...args) { if (typeof args[0] === 'string' && args[0].includes('tsx-')) throw Error('UNEXPECTED_TSX_CLI_IPC'); return listen.apply(this, args); };\n",
);
writeFileSync(
  entry,
  "const value: number = 42; process.stdout.write(JSON.stringify({value, argument: process.argv[2]}));\n",
);
const require = createRequire(import.meta.url);
const options = {
  cwd: root,
  encoding: "utf8",
  timeout: 20000,
  env: { ...process.env, TMPDIR: scratch },
};
try {
  const old = spawnSync(
    process.execPath,
    ["--import", blocked, require.resolve("tsx/cli"), entry, "preserved"],
    options,
  );
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /UNEXPECTED_TSX_CLI_IPC/);
  const current = spawnSync(
    process.execPath,
    ["--import", blocked, "--import", "tsx", entry, "preserved"],
    options,
  );
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(JSON.parse(current.stdout), {
    value: 42,
    argument: "preserved",
  });
  const failed = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", "process.exit(7)"],
    options,
  );
  assert.equal(failed.status, 7);
  const config = readFileSync(join(root, ".devcoordinator.toml"), "utf8");
  assert(!config.includes('"exec", "tsx"'));
  const scripts = JSON.parse(
    readFileSync(join(root, "packages/db/package.json"), "utf8"),
  ).scripts;
  assert.equal(scripts.migrate, "node --import tsx src/migrate.ts");
  assert.equal(scripts.seed, "node --import tsx seed/index.ts");
  for (const workspace of ["api", "sweeper"])
    assert.equal(
      JSON.parse(
        readFileSync(join(root, `apps/${workspace}/package.json`), "utf8"),
      ).scripts.dev,
      "tsx watch src/index.ts",
    );
  console.log(
    JSON.stringify({
      operation: "finite-typescript-no-launcher-ipc",
      oldLauncherCaught: true,
      typedEntryAndArgumentsPreserved: true,
      failureExitPreserved: true,
      watchModeUnchanged: true,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
