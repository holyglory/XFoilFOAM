import { describe, expect, it } from "vitest";

import { progressiveBiasApplicability } from "../src/progressive-fitting";

const engine = {
  adapter_contract_version: 1,
  application_source_sha256:
    "000c67ccc21bc286cd189ff82c063c0ca497fee3bb2d99790d4d848e71708f6e",
  binary_sha256:
    "36b5e8b213ab5b968cd94bbbf464ea9681619192fe71550cfbd4bdb678108f6e",
  build_id: "progressive-7f2af74-20260919",
  distribution: "opencfd",
  family: "openfoam",
  numerics_revision: "1",
  package_sha256:
    "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d",
  source_revision:
    "481094fdf34f11ed6d0d603ee59a858a0124236d",
  version: "2606",
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    physical: {
      branch: "increasing",
      derived: { mach: 0.48774443656347544, reynolds: 1_131_898 },
      flow: {},
      reference: {},
      boundary: {},
      transition: {},
      material: {},
      version: "physical-analysis-target-v1",
      airfoilId: "profile",
      geometry: [],
    },
    prediction: { alpha: [-5, 0, 20] },
    evidence: [
      {
        stage: 2,
        payload: { engine, method_key: "openfoam.rans", fidelity: "trans" },
      },
    ],
    ...overrides,
  } as never;
}

describe("progressive source-bound uncertainty scope", () => {
  it("qualifies only the frozen compressible recipe scope", () => {
    const applicability = progressiveBiasApplicability(source());
    expect(applicability).toMatchObject({ angleScope: [-5, 20] });
    expect(applicability?.physicalIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(applicability?.numericalIdentity).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed for a newer engine and mixed numerical recipes", () => {
    expect(
      progressiveBiasApplicability(
        source({
          evidence: [
            {
              stage: 2,
              payload: {
                engine: { ...engine, build_id: "progressive-current" },
                method_key: "openfoam.rans",
                fidelity: "trans",
              },
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      progressiveBiasApplicability(
        source({
          evidence: [
            source().evidence[0],
            {
              stage: 2,
              payload: { engine, method_key: "openfoam.urans", fidelity: "urans_precalc" },
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});
