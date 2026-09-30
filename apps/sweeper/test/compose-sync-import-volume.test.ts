import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("production numerical revision handoff", () => {
  it.each([undefined, "2"])(
    "resolves numerical identity %s consistently",
    (revision) => {
      const selected = revision ?? "1";
      const queue =
        selected === "2"
          ? "openfoam-opencfd-2606-numerics-2"
          : "openfoam-opencfd-2606";
      const key = `openfoam:opencfd:2606:numerics-${selected}:adapter-1`;
      const compose = JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            "docker-compose.deploy.yml",
            "config",
            "--format",
            "json",
          ],
          {
            cwd: repoRoot,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              ...(revision
                ? {
                    OPENCFD2606_NUMERICS_REVISION: revision,
                    OPENCFD2606_EXECUTION_POOL: queue,
                    AIRFOILFOAM_ENABLED_ENGINE_KEYS: key,
                  }
                : {}),
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      for (const name of ["api", "worker"]) {
        expect(
          compose.services[name].environment
            .AIRFOILFOAM_ENGINE_NUMERICS_REVISION,
        ).toBe(selected);
        expect(
          compose.services[name].environment.AIRFOILFOAM_CELERY_QUEUE,
        ).toBe(queue);
      }
      expect(
        compose.services.api.environment.AIRFOILFOAM_ENABLED_ENGINE_KEYS,
      ).toBe(key);
      for (const name of ["node-api", "sweeper", "media-repair"])
        expect(
          compose.services[name].environment.ENGINE_NUMERICS_REVISION,
        ).toBe(selected);
    },
  );
});

describe("production archive concurrency wiring", () => {
  it.each([undefined, "16"])(
    "resolves the upload limit %s into both control-plane containers",
    (configured) => {
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(configured
          ? { REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER: configured }
          : {}),
      };
      const compose = JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            "docker-compose.deploy.yml",
            "config",
            "--format",
            "json",
          ],
          {
            cwd: repoRoot,
            env: environment,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      for (const name of ["node-api", "sweeper"])
        expect(
          compose.services[name].environment
            .REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER,
        ).toBe(configured ?? "8");
      for (const name of ["api", "worker", "web", "media-repair"])
        expect(compose.services[name].environment).not.toHaveProperty(
          "REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER",
        );
    },
  );
});

describe("production disk admission wiring", () => {
  it.each([undefined, "20"])(
    "passes the idle-slot reserve %s only to the sweeper",
    (configured) => {
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(configured
          ? { SWEEPER_DISK_IDLE_SLOT_RESERVE_GIB: configured }
          : {}),
      };
      const compose = JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            "docker-compose.deploy.yml",
            "config",
            "--format",
            "json",
          ],
          {
            cwd: repoRoot,
            env: environment,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      expect(
        compose.services.sweeper.environment.SWEEPER_DISK_IDLE_SLOT_RESERVE_GIB,
      ).toBe(configured ?? "30");
      for (const name of ["node-api", "api", "worker", "web", "media-repair"])
        expect(compose.services[name].environment).not.toHaveProperty(
          "SWEEPER_DISK_IDLE_SLOT_RESERVE_GIB",
        );
    },
  );
});

describe("production archive lane wiring", () => {
  it.each([undefined, "10"])(
    "passes the archive lane count %s only to the sweeper",
    (configured) => {
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...(configured ? { REMOTE_EVIDENCE_ARCHIVE_LANES: configured } : {}),
      };
      const compose = JSON.parse(
        execFileSync(
          "docker",
          [
            "compose",
            "--env-file",
            "/dev/null",
            "-f",
            "docker-compose.deploy.yml",
            "config",
            "--format",
            "json",
          ],
          {
            cwd: repoRoot,
            env: environment,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      expect(
        compose.services.sweeper.environment.REMOTE_EVIDENCE_ARCHIVE_LANES,
      ).toBe(configured ?? "8");
      for (const name of ["node-api", "api", "worker", "web", "media-repair"])
        expect(compose.services[name].environment).not.toHaveProperty(
          "REMOTE_EVIDENCE_ARCHIVE_LANES",
        );
    },
  );
});

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

  it("does not expose the evidence-cleanup secret to unrelated services", () => {
    for (const service of ["node-api", "web"]) {
      const block = serviceBlock(production, service);
      expect(block).not.toContain("CONTROL_PLANE_TOKEN");
    }
  });
});

describe("production worker capacity wiring", () => {
  const production = readFileSync(
    resolve(repoRoot, "docker-compose.deploy.yml"),
    "utf8",
  );

  it.each(["worker", "worker-foundation14"])(
    "uses one authoritative CPU budget for %s admission and Docker enforcement",
    (service) => {
      const block = serviceBlock(production, service);
      expect(block).toContain(
        "AIRFOILFOAM_WORKER_CPU_BUDGET: ${AIRFOILFOAM_WORKER_CPU_BUDGET:-8}",
      );
      expect(block).toContain('cpus: "${AIRFOILFOAM_WORKER_CPU_BUDGET:-8}"');
      expect(block).not.toContain('cpus: "8"');
    },
  );
});

describe.each(["docker-compose.yml", "docker-compose.deploy.yml"])(
  "%s solver engine isolation",
  (filename) => {
    it("keeps OpenCFD 2606 as the only default gateway route", () => {
      const source = readFileSync(resolve(repoRoot, filename), "utf8");
      const api = serviceBlock(source, "api");

      expect(api).toContain(
        `openfoam:opencfd:2606:numerics-${filename === "docker-compose.yml" ? "2" : "1"}:adapter-1`,
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
        filename === "docker-compose.yml"
          ? "AIRFOILFOAM_CELERY_QUEUE: openfoam-opencfd-2606-numerics-2"
          : "AIRFOILFOAM_CELERY_QUEUE: ${OPENCFD2606_EXECUTION_POOL:-openfoam-opencfd-2606}",
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
        expect(worker).toContain("engine_runtime:/data/airfoilfoam-runtime");
        expect(worker).toContain(
          "AIRFOILFOAM_CPU_TOKEN_STATE_PATH: /data/airfoilfoam-runtime/cpu-tokens.json",
        );
      }
      expect(source).toMatch(/^  engine_runtime:\s*(?:#.*)?$/m);
    });
  },
);
