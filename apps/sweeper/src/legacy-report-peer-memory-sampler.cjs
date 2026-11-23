// Runs on Linux in the controller and inside the selected worker container.
// The SSH helper emits only aggregate MiB, once at entry and once at EOF.
const fs = require("node:fs");
const path = require("node:path");
const MiB = 1024 ** 2;
const root = "/sys/fs/cgroup";
function memoryHeadroom() {
  const host = fs.readFileSync("/proc/meminfo", "utf8");
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(host);
  const free = /^MemFree:\s+(\d+) kB$/m.exec(host);
  const group = /^0::(\/[^\n]*)$/m.exec(
    fs.readFileSync("/proc/self/cgroup", "utf8"),
  );
  if (
    !available ||
    !free ||
    !group ||
    !fs.existsSync(path.join(root, "cgroup.controllers"))
  )
    throw Error("Linux memory accounting unavailable");
  // In a private Docker cgroup namespace / is the mount itself. Resolve
  // before comparing and never walk above that mount, even on malformed input.
  let dir = path.resolve(root, "." + group[1]);
  if (dir !== root && !dir.startsWith(root + "/"))
    throw Error("Invalid cgroup membership");
  if (!fs.existsSync(dir)) {
    if (!fs.existsSync(path.join(root, "memory.max")))
      throw Error("Cgroup memory accounting unavailable");
    dir = root;
  }
  let margin = Infinity;
  for (;;) {
    for (const file of ["memory.max", "memory.high"]) {
      const limit = path.join(dir, file);
      if (!fs.existsSync(limit)) continue;
      const text = fs.readFileSync(limit, "utf8").trim();
      if (text === "max") continue;
      const current = Number(
        fs.readFileSync(path.join(dir, "memory.current"), "utf8"),
      );
      const ceiling = Number(text);
      if (
        !Number.isSafeInteger(current) ||
        current < 0 ||
        !Number.isSafeInteger(ceiling) ||
        ceiling < 0
      )
        throw Error("Invalid cgroup memory counter");
      margin = Math.min(
        margin,
        Math.max(0, Math.floor((ceiling - current) / MiB)),
      );
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir || (parent !== root && !parent.startsWith(root + "/")))
      throw Error("Invalid cgroup ancestor");
    dir = parent;
  }
  const hostAvailableMiB = Math.floor(Number(available[1]) / 1024);
  const hostFreeMiB = Math.floor(Number(free[1]) / 1024);
  return {
    availableMiB: Math.min(hostAvailableMiB, margin),
    hostAvailableMiB,
    hostFreeMiB,
    cgroupMarginMiB: Number.isFinite(margin) ? margin : null,
  };
}
function availableMiB() {
  return memoryHeadroom().availableMiB;
}
function watchCustodyMemory() {
  const group = fs.readFileSync("/proc/self/cgroup", "utf8");
  let low = Infinity,
    peak = 0;
  let last;
  function sample() {
    last = memoryHeadroom();
    low = Math.min(low, last.availableMiB);
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
    process.stdout.write(JSON.stringify([low, peak, last]) + "\n");
  }
  emit();
  const timer = setInterval(sample, 500);
  const lifetime = setTimeout(() => process.exit(1), 900000);
  lifetime.unref();
  process.stdin.resume();
  process.stdin.once("end", () => {
    clearInterval(timer);
    clearTimeout(lifetime);
    emit();
  });
}
module.exports = { availableMiB, memoryHeadroom, watchCustodyMemory };
