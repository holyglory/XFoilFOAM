// This fixture runs only inside its Coordinator-owned Node container. The
// enclosing script supplies the exact packaged sampler's source via fixture.
(async function checkNamespace() {
  const assert = require("node:assert/strict");
  const { spawn } = require("node:child_process");
  const { createHash, randomBytes } = require("node:crypto");
  const { createInterface } = require("node:readline");
  const namespace = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
  assert.equal(namespace, "0::/");
  assert.ok(fs.existsSync("/sys/fs/cgroup/cgroup.controllers"));

  const payload = randomBytes(8 * 1024 ** 2);
  const expected = createHash("sha256").update(payload).digest("hex");
  const workerProgram = `
    const fs = require("node:fs");
    const {createHash} = require("node:crypto");
    const chunks = [];
    process.stdin.on("data", chunk => chunks.push(chunk));
    process.stdin.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const name = "/tmp/custody-" + process.pid;
      const fd = fs.openSync(name, "wx");
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      const restored = fs.readFileSync(name);
      fs.unlinkSync(name);
      console.log(createHash("sha256").update(restored).digest("hex"));
      setTimeout(() => {}, 10000);
    });
  `;

  async function measuredCopy(count) {
    const workers = [];
    const clock = Date.now();
    try {
      await Promise.all(
        Array.from({ length: count }, async () => {
          const child = spawn(
            process.execPath,
            ["-e", workerProgram, "legacyCustodyWorkerStdin"],
            {
              stdio: ["pipe", "pipe", "inherit"],
            },
          );
          workers.push(child);
          const lines = createInterface({ input: child.stdout })[
            Symbol.asyncIterator
          ]();
          child.stdin.end(payload);
          assert.equal((await lines.next()).value, expected);
        }),
      );
      const probe = spawn(
        process.execPath,
        ["-e", fixture.sampler + "\nwatchCustodyMemory()"],
        {
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
      const completed = new Promise((resolve) => probe.once("exit", resolve));
      try {
        const lines = createInterface({ input: probe.stdout })[
          Symbol.asyncIterator
        ]();
        const first = JSON.parse((await lines.next()).value);
        probe.stdin.end();
        const last = JSON.parse((await lines.next()).value);
        assert.equal(await completed, 0);
        assert.ok(first[0] > 0 && last[0] > 0 && last[1] > 0);
        assert.ok(last[2].hostAvailableMiB >= last[0]);
        assert.ok(
          last[2].cgroupMarginMiB === null ||
            last[2].cgroupMarginMiB >= last[0],
        );
        return {
          rssMiB: last[1],
          elapsedMs: Date.now() - clock,
          sourceBytes: payload.length * count,
          capacity: last[2],
        };
      } finally {
        if (probe.exitCode === null) probe.kill();
      }
    } finally {
      await Promise.all(
        workers.map(
          (child) =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null)
                return resolve();
              child.once("exit", resolve);
              child.kill();
            }),
        ),
      );
    }
  }

  const normal = await measuredCopy(1);
  const paired = await measuredCopy(2);
  assert.ok(paired.rssMiB > normal.rssMiB);
  console.log(
    JSON.stringify({
      namespace: "/",
      normal,
      paired,
      matchedCopyBytes: payload.length,
      sameDigest: true,
    }),
  );
})().catch((error) => {
  console.error(error.name);
  process.exitCode = 1;
});
