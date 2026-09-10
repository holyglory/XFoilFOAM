import { afterEach, expect, it, vi } from "vitest";
import type { DB, PredictionRepairLease } from "@aerodb/db";
import {
  claimMissingPredictionRepair,
  failPredictionRepair,
  storeRepairedPrediction,
} from "@aerodb/db";
import { EngineError, type EngineClient } from "@aerodb/engine-client";
import { repairMissingPredictions } from "../src/repair-missing-predictions";
import { progressivePredictionFixture } from "../../../packages/db/test-support/progressive-prediction";

vi.mock("@aerodb/db", () => ({
  claimMissingPredictionRepair: vi.fn(),
  failPredictionRepair: vi.fn(),
  storeRepairedPrediction: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const lease = {
  workId: "work",
  token: "token",
  owner: "owner",
  campaignId: "campaign",
  epochId: "epoch",
  targetId: "target",
  angles: [-2, 2],
  recipes: { neuralfoil: { model_size: "large" }, fast: {}, precise: {} },
  physical: {
    airfoilId: "airfoil",
    geometry: [
      [1, 0],
      [0, 0],
      [1, 0],
    ],
    derived: { reynolds: 500000, mach: 0.1 },
    transition: { nCrit: 9, upper: 0, lower: 0 },
    boundary: { sandGrainHeight: 0 },
  },
} as unknown as PredictionRepairLease;

it.each([undefined, 1, 3])(
  "does not claim missing predictions on unsupported engine version %s",
  async (version) => {
    const engine = {
      healthDetails: vi.fn(async () => ({
        status: "ok",
        neuralfoil_geometry_fit_version: version,
      })),
    } as unknown as EngineClient;
    await expect(
      repairMissingPredictions({} as DB, engine, "campaign", 2),
    ).rejects.toThrow("Deploy the verified");
    expect(claimMissingPredictionRepair).not.toHaveBeenCalled();
  },
);

it("publishes the exact repair prediction and stays within its requested limit", async () => {
  vi.mocked(claimMissingPredictionRepair).mockResolvedValue(lease);
  const payload = progressivePredictionFixture(lease);
  const predictNeuralFoil = vi.fn(async () => ({
    epoch_id: lease.epochId,
    lease_token: lease.token,
    predictions: [payload],
  }));
  const engine = {
    healthDetails: vi.fn(async () => ({
      status: "ok",
      neuralfoil_geometry_fit_version: 2,
    })),
    predictNeuralFoil,
  } as unknown as EngineClient;
  expect(
    await repairMissingPredictions({} as DB, engine, "campaign", 1),
  ).toMatchObject({ claimed: 1, stored: 1, gaps: 0 });
  expect(claimMissingPredictionRepair).toHaveBeenCalledOnce();
  expect(predictNeuralFoil).toHaveBeenCalledWith(
    expect.objectContaining({
      coordinates: lease.physical.geometry,
      lease_token: lease.token,
      geometry_provenance: expect.objectContaining({
        supplemental_repair_work_id: lease.workId,
      }),
    }),
  );
  expect(storeRepairedPrediction).toHaveBeenCalledWith(
    expect.anything(),
    lease,
    payload,
  );
});

it.each([422, 503])(
  "keeps solver failure %s separate from published predictions",
  async (status) => {
    vi.mocked(claimMissingPredictionRepair).mockResolvedValue(lease);
    const engine = {
      healthDetails: vi.fn(async () => ({
        status: "ok",
        neuralfoil_geometry_fit_version: 2,
      })),
      predictNeuralFoil: vi.fn(async () => {
        throw new EngineError("real failure", status);
      }),
    } as unknown as EngineClient;
    expect(
      await repairMissingPredictions({} as DB, engine, "campaign", 1),
    ).toMatchObject({ claimed: 1, stored: 0, gaps: 1 });
    expect(failPredictionRepair).toHaveBeenCalledWith(
      expect.anything(),
      lease,
      "real failure",
      status === 503,
    );
    expect(storeRepairedPrediction).not.toHaveBeenCalled();
  },
);

it("rejects a foreign reply instead of publishing it", async () => {
  vi.mocked(claimMissingPredictionRepair).mockResolvedValue(lease);
  const engine = {
    healthDetails: vi.fn(async () => ({
      status: "ok",
      neuralfoil_geometry_fit_version: 2,
    })),
    predictNeuralFoil: vi.fn(async () => ({
      epoch_id: "other",
      lease_token: lease.token,
      predictions: [progressivePredictionFixture(lease)],
    })),
  } as unknown as EngineClient;
  expect(
    await repairMissingPredictions({} as DB, engine, "campaign", 1),
  ).toMatchObject({ stored: 0, gaps: 1 });
  expect(storeRepairedPrediction).not.toHaveBeenCalled();
});
