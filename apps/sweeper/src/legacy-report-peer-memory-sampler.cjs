// Runs on Linux in the controller and inside the selected worker container.
// The SSH helper emits only aggregate MiB, once at entry and once at EOF.
const fs = require("node:fs");
const path = require("node:path");
const MiB = 1024 ** 2;
const root = "/sys/fs/cgroup";
function availableMiB() {
  const mem = /^MemAvailable:\s+(\d+) kB$/m.exec(
    fs.readFileSync("/proc/meminfo", "utf8"),
  );
  const group = /^0::(\/[^\n]*)$/m.exec(
    fs.readFileSync("/proc/self/cgroup", "utf8"),
  );
  if (!mem || !group || !fs.existsSync(path.join(root, "cgroup.controllers")))
    throw Error("Linux memory accounting unavailable");
  let available = Number(mem[1]) / 1024;
  let dir = path.join(root, group[1]);
  // A namespaced cgroup mount can expose the container itself as the root.
  if (!fs.existsSync(dir)) {
    if (!fs.existsSync(path.join(root, "memory.max")))
      throw Error("Cgroup memory accounting unavailable");
    dir = root;
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, "memory.max"))) {
      const max = fs.readFileSync(path.join(dir, "memory.max"), "utf8").trim();
      if (max !== "max")
        available = Math.min(
          available,
          (Number(max) -
            Number(fs.readFileSync(path.join(dir, "memory.current"), "utf8"))) /
            MiB,
        );
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  if (!Number.isFinite(available)) throw Error("Invalid headroom");
  return Math.max(0, Math.floor(available));
}
function watchCustodyMemory() {
  const group = fs.readFileSync("/proc/self/cgroup", "utf8");
  let low = Infinity,
    peak = 0;
  function sample() {
    low = Math.min(low, availableMiB());
    let rss = 0;
    for (const id of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(id) || Number(id) === process.pid) continue;
      const p = "/proc/" + id;
      try {
        if (
          fs.readFileSync(p + "/comm", "utf8").trim() !== "node" ||
          fs.readFileSync(p + "/cgroup", "utf8") !== group
        )
          continue;
        if (
          !fs.readFileSync(p + "/cmdline").includes("legacyCustodyWorkerStdin")
        )
          continue;
        const value = /^VmRSS:\s+(\d+) kB$/m.exec(
          fs.readFileSync(p + "/status", "utf8"),
        );
        if (value) rss += Number(value[1]) / 1024;
      } catch (e) {
        if (e.code !== "ENOENT" && e.code !== "ESRCH") throw e;
      }
    }
    peak = Math.max(peak, Math.ceil(rss));
  }
  function emit() {
    sample();
    process.stdout.write(JSON.stringify([low, peak]) + "\n");
  }
  emit();
  const timer = setInterval(sample, 500);
  process.stdin.resume();
  process.stdin.once("end", () => {
    clearInterval(timer);
    emit();
  });
}
module.exports = { availableMiB, watchCustodyMemory };
