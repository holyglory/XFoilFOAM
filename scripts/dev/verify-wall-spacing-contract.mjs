import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  airfoilConcaveCurvature,
  fastWallSpacing,
  parseCoordinates,
} from "../../packages/core/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outcomes = [];
for (const slug of ["ag24", "s1223", "sd8020", "clarky", "n0012"]) {
  const points = parseCoordinates(
    readFileSync(`${root}/packages/db/seed/selig-database/${slug}.dat`, "utf8"),
  ).points;
  const native = Number(
    execFileSync(
      `${root}/.venv/bin/python`,
      [
        "-c",
        "import json,sys; import numpy as np; from airfoilfoam.airfoil import Airfoil,max_concave_curvature; contour=Airfoil.from_contour('real-guard-fixture',np.asarray(json.load(sys.stdin),dtype=float)).contour; print(max_concave_curvature(contour))",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        input: JSON.stringify(points.map((point) => [point.x, point.y])),
      },
    ),
  );
  const shared = airfoilConcaveCurvature(points);
  assert(Number.isFinite(native) && shared !== null);
  assert(
    Math.abs(native - shared) < 1e-8,
    `${slug}: native and shared curvature differ`,
  );
  assert.equal(fastWallSpacing(1, shared).targetYPlus, native <= 2.5 ? 40 : 1);
  outcomes.push({
    slug,
    native,
    shared,
    targetYPlus: fastWallSpacing(1, shared).targetYPlus,
  });
}
console.log(
  JSON.stringify({
    operation: "native-shared-wall-geometry-contract",
    outcomes,
  }),
);
