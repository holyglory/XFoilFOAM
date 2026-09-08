import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const config = JSON.parse(
  readFileSync(new URL("./progressive-ui.json", import.meta.url), "utf8"),
);
for (const target of config.targets) {
  const route = new URL(target.url, origin);
  target.url = new URL(
    `${route.pathname}${route.search}${route.hash}`,
    origin,
  ).href;
}
const directory = mkdtempSync(join(tmpdir(), "progressive-layout-"));
const reports = mkdtempSync(join("/tmp", "progressive-layout-reports-"));
try {
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify(config));
  const result = spawnSync(
    "/usr/local/bin/devcoordinator2-tooling",
    [
      "formal-ui",
      "verify",
      "--config",
      path,
      "--json-out",
      join(reports, "report.json"),
      "--markdown-out",
      join(reports, "report.md"),
      "--fail-on",
      "critical",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
