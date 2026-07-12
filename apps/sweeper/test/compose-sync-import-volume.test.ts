import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function serviceBlock(source: string, service: string): string {
  const match = new RegExp(
    `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^volumes:|\\Z)`,
    "m",
  ).exec(source);
  if (!match) throw new Error(`missing compose service ${service}`);
  return match[1];
}

describe.each(["docker-compose.yml", "docker-compose.deploy.yml"])(
  "%s sync-import volume visibility",
  (filename) => {
    it("mounts the same writable nested volume only into node-api and sweeper", () => {
      const source = readFileSync(resolve(repoRoot, filename), "utf8");
      const mount = "sync_imports:/data/airfoilfoam/sync-imports";
      expect(serviceBlock(source, "node-api")).toContain(mount);
      expect(serviceBlock(source, "sweeper")).toContain(mount);
      expect(serviceBlock(source, "node-api")).not.toContain(`${mount}:ro`);
      expect(serviceBlock(source, "sweeper")).not.toContain(`${mount}:ro`);
      expect(serviceBlock(source, "api")).not.toContain(mount);
      expect(serviceBlock(source, "worker")).not.toContain(mount);
      expect(source).toMatch(/^  sync_imports:\s*$/m);
    });

    it("initializes the nested mountpoint before a read-only results mount can hide it", () => {
      const source = readFileSync(resolve(repoRoot, filename), "utf8");

      expect(serviceBlock(source, "storage-init")).toContain(
        "results:/data/airfoilfoam",
      );
      expect(serviceBlock(source, "storage-init")).toContain(
        "install -d -m 0755 /data/airfoilfoam/sync-imports",
      );
      expect(serviceBlock(source, "node-api")).toMatch(
        /storage-init:\n\s+condition: service_completed_successfully/,
      );
      expect(serviceBlock(source, "sweeper")).toMatch(
        /storage-init:\n\s+condition: service_completed_successfully/,
      );
    });
  },
);
