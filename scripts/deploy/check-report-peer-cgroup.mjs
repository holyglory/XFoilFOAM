import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// This check runs the shipped CommonJS code in a real private Docker cgroup
// namespace. The parent timeout still fires if a regression spins synchronously.
const root = fileURLToPath(new URL("../../", import.meta.url));
const check = process.env.DEVCOORDINATOR_CHECK_NAME;
const run_id = process.env.DEVCOORDINATOR_RUN_ID;
assert.ok(check && run_id);
function call(name, params) {
  const message = JSON.parse(
    execFileSync(
      "devcoordinator2",
      ["call", "test.container." + name, "--params-file", "-"],
      {
        input: JSON.stringify({ path: root, run_id, check, ...params }),
        encoding: "utf8",
        timeout: 45000,
        maxBuffer: 512 * 1024,
      },
    ),
  );
  assert.equal(message.ok, true);
  return message.data;
}
const sampler = readFileSync(
  new URL(
    "../../apps/sweeper/src/legacy-report-peer-memory-sampler.cjs",
    import.meta.url,
  ),
  "utf8",
);
const exercise = readFileSync(
  new URL(
    "../../apps/sweeper/test-support/legacy-report-peer-memory-case.cjs",
    import.meta.url,
  ),
  "utf8",
);
// The Coordinator accepts at most 64 argv entries of 1024 bytes each.
// Send the small, versioned text fixture over this bounded interface.
const fixtureText = JSON.stringify({ sampler, exercise });
const parts = fixtureText.match(/.{1,900}/g) ?? [];
assert.ok(
  parts.length + 3 <= 64 && parts.every((p) => Buffer.byteLength(p) <= 1024),
);
const entry =
  "const fixture=JSON.parse(process.argv.slice(1).join(''));eval(fixture.sampler+'\\n'+fixture.exercise)";
const created = call("create", {
  image: "node:22-bookworm-slim",
  command: ["node", "-e", entry, ...parts],
});
const id = created.record.container_id;
try {
  const started = call("start", { container_id: id });
  assert.equal(started.record.native_execution_began, true);
  const deadline = Date.now() + 25000;
  let inspected;
  do {
    await sleep(180);
    inspected = call("inspect", { container_id: id }).inspection;
    if (inspected.state === "exited" || inspected.state === "dead") break;
  } while (Date.now() < deadline);
  assert.ok(
    inspected.state === "exited" &&
      Date.parse(inspected.finished_at) > Date.parse(inspected.started_at) &&
      inspected.exit_code === 0 &&
      !inspected.oom_killed,
    "Private-cgroup normal/paired execution failed or timed out",
  );
  // Coordinator retains diagnostic text for failed containers. Successful
  // execution is attested by the owned container's terminal exit receipt.

  console.log(
    JSON.stringify({
      namespace: "/",
      matchedBytesPerWorker: 8 * 1024 ** 2,
      singleAndPairedReadback: true,
      containerExit: inspected.exit_code,
    }),
  );
} finally {
  call("remove", { container_id: id });
}
