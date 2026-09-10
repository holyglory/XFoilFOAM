import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EngineClient } from "../../engine-client/src/client";

export function localPredictionRepairEngines(root: string) {
  assert(
    process.env.DEVCOORDINATOR_CHECK_SCRATCH,
    "Use the governed isolated check",
  );
  const credential = readFileSync(
    resolve(root, ".codex-artifacts/progressive-engine.env"),
    "utf8",
  );
  const token = /^ENGINE_CONTROL_PLANE_TOKEN=([a-f0-9]{64})$/m.exec(
    credential,
  )?.[1];
  assert(
    token &&
      /^AIRFOILFOAM_CONTROL_PLANE_TOKEN=([a-f0-9]{64})$/m.exec(
        credential,
      )?.[1] === token,
  );
  const engines = ["progressive-engine", "progressive-test-engine"].map(
    (name) => {
      const status = JSON.parse(
        execFileSync(
          "devcoordinator2",
          ["deployment", "status", root, "--name", name],
          { encoding: "utf8", maxBuffer: 262144, timeout: 30000 },
        ),
      );
      assert(
        status.ok &&
          status.data.state === "running" &&
          status.data.public === false,
      );
      const components = status.data.components.filter(
        (component: { name: string }) => component.name === "engine",
      );
      assert(
        components.length === 1 &&
          components[0].owned &&
          components[0].state === "running" &&
          components[0].health === "healthy",
      );
      const port = components[0].port;
      assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
      return new EngineClient(`http://127.0.0.1:${port}`, {
        controlPlaneToken: token,
      });
    },
  );
  return { original: engines[0], repaired: engines[1] };
}

export function trustedRepairGeometry(root: string, profile: string) {
  assert(["b707b", "b707c", "cap21c", "e49"].includes(profile));
  const source = readFileSync(
    resolve(root, `packages/db/seed/selig-database/${profile}.dat`),
  );
  const points = source
    .toString("utf8")
    .split(/\r?\n/)
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const values = line.trim().split(/\s+/).map(Number);
      assert(values.length === 2 && values.every(Number.isFinite));
      return { x: values[0], y: values[1] };
    });
  return { points, sha256: createHash("sha256").update(source).digest("hex") };
}
