import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function serviceBlock(source: string, service: string): string {
  const match = new RegExp(
    `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:|^volumes:|(?![\\s\\S]))`,
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

describe("remote-only evidence cleanup deployment wiring", () => {
  const production = readFileSync(
    resolve(repoRoot, "docker-compose.deploy.yml"),
    "utf8",
  );

  it.each(["api", "worker", "worker-foundation14"])(
    "passes the shared cleanup secret to Python service %s",
    (service) => {
      const block = serviceBlock(production, service);
      expect(block).toContain(
        "AIRFOILFOAM_CONTROL_PLANE_TOKEN: ${AIRFOILFOAM_CONTROL_PLANE_TOKEN:-}",
      );
      expect(block).toContain(
        "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY: ${AIRFOILFOAM_EVIDENCE_REMOTE_ONLY:-false}",
      );
    },
  );

  it.each(["sweeper", "media-repair"])(
    "passes authenticated remote-cleanup context to Node service %s",
    (service) => {
      const block = serviceBlock(production, service);
      expect(block).toContain(
        "ENGINE_CONTROL_PLANE_TOKEN: ${AIRFOILFOAM_CONTROL_PLANE_TOKEN:-}",
      );
      expect(block).toContain(
        "AIRFOILFOAM_EVIDENCE_BUCKET: ${AIRFOILFOAM_EVIDENCE_BUCKET:-}",
      );
      expect(block).toContain(
        "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY: ${AIRFOILFOAM_EVIDENCE_REMOTE_ONLY:-false}",
      );
    },
  );

  it("passes the bounded authenticated canary-cleanup client context to node-api", () => {
    const block = serviceBlock(production, "node-api");
    expect(block).toContain(
      "ENGINE_CONTROL_PLANE_TOKEN: ${AIRFOILFOAM_CONTROL_PLANE_TOKEN:-}",
    );
    expect(block).toContain(
      "ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS: ${ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS:-960000}",
    );
  });

  it("does not expose the evidence-cleanup secret to unrelated services", () => {
    for (const service of ["redis", "postgres", "storage-init", "web"]) {
      const block = serviceBlock(production, service);
      expect(block).not.toContain("CONTROL_PLANE_TOKEN");
    }
  });
});

describe.each(["docker-compose.yml", "docker-compose.deploy.yml"])(
  "%s solver engine isolation",
  (filename) => {
    it("keeps OpenCFD 2606 as the only default gateway route", () => {
      const source = readFileSync(resolve(repoRoot, filename), "utf8");
      const api = serviceBlock(source, "api");

      expect(api).toContain(
        "openfoam:opencfd:2606:numerics-1:adapter-1",
      );
      expect(api).not.toMatch(
        /AIRFOILFOAM_ENABLED_ENGINE_KEYS:[^\n]*foundation/,
      );
    });

    it("isolates Foundation 14 behind a profile and distinct queue", () => {
      const source = readFileSync(resolve(repoRoot, filename), "utf8");
      const openCfd = serviceBlock(source, "worker");
      const foundation = serviceBlock(source, "worker-foundation14");

      expect(openCfd).toContain("AIRFOILFOAM_ENGINE_DISTRIBUTION: opencfd");
      expect(openCfd).toContain('AIRFOILFOAM_ENGINE_VERSION: "2606"');
      expect(openCfd).not.toContain('AIRFOILFOAM_ENGINE_VERSION: "2406"');
      expect(openCfd).toContain(
        "AIRFOILFOAM_CELERY_QUEUE: openfoam-opencfd-2606",
      );
      expect(openCfd).not.toContain("AIRFOILFOAM_CELERY_QUEUE: celery");
      expect(foundation).toContain('profiles: ["foundation14"]');
      expect(foundation).toContain(
        "dockerfile: docker/Dockerfile.worker-foundation14",
      );
      expect(foundation).toContain(
        "AIRFOILFOAM_ENGINE_DISTRIBUTION: foundation",
      );
      expect(foundation).toContain('AIRFOILFOAM_ENGINE_VERSION: "14"');
      expect(foundation).toContain(
        "AIRFOILFOAM_CELERY_QUEUE: openfoam-foundation-14",
      );
    });

    it("shares results and one CPU-token ledger across engine workers", () => {
      const source = readFileSync(resolve(repoRoot, filename), "utf8");
      const openCfd = serviceBlock(source, "worker");
      const foundation = serviceBlock(source, "worker-foundation14");

      for (const worker of [openCfd, foundation]) {
        expect(worker).toContain("results:/data/airfoilfoam");
        expect(worker).toContain(
          "engine_runtime:/data/airfoilfoam-runtime",
        );
        expect(worker).toContain(
          "AIRFOILFOAM_CPU_TOKEN_STATE_PATH: /data/airfoilfoam-runtime/cpu-tokens.json",
        );
      }
      expect(source).toMatch(/^  engine_runtime:\s*(?:#.*)?$/m);
    });
  },
);
