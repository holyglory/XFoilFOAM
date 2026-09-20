import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineClient } from "../src/client";
import { OPENCFD_2606_ENGINE } from "../src/engine-identity";
import type { PolarRequest } from "../src/types";

const request: PolarRequest = {
  airfoil: {
    name: "isolated transport fixture",
    points: [
      [1, 0],
      [0, 0],
      [1, 0],
    ],
  },
  aoa: { angles: [0] },
  expected_local_time_step_version: 1,
  solver: {
    flow_solver_family: "rhoCentralFoam",
    force_transient: false,
    local_time_step_smoothing: 0.2,
  },
};

afterEach(() => vi.unstubAllGlobals());

function transport(version: unknown) {
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url.endsWith("/health")
        ? {
            status: "ok",
            ...(version === undefined
              ? {}
              : { local_time_step_version: version }),
          }
        : {
            job_id: "isolated-transport",
            state: "pending",
            requested_engine: OPENCFD_2606_ENGINE,
          },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("explicit local time-step submission", () => {
  it.each([undefined, null, 0, 2, "1", true])(
    "never sends modified numerics to engine capability %s",
    async (version) => {
      const fetch = transport(version);
      await expect(
        new EngineClient("http://isolated.invalid").submitPolar(request),
      ).rejects.toMatchObject({ code: "local_time_step_version_mismatch" });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toBe("http://isolated.invalid/health");
    },
  );

  it("preserves explicit numerics and version through the real client", async () => {
    const fetch = transport(1);
    await new EngineClient("http://isolated.invalid").submitPolar(request);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://isolated.invalid/health",
      "http://isolated.invalid/polars",
    ]);
    const options = (
      fetch.mock.calls as unknown as [string, RequestInit][]
    )[1][1];
    expect(JSON.parse(String(options.body))).toMatchObject(request);
  });

  it("does not add a network preflight or new fields to old requests", async () => {
    const fetch = transport(undefined);
    const legacy = {
      ...request,
      expected_local_time_step_version: undefined,
      solver: { ...request.solver, local_time_step_smoothing: undefined },
    };
    await new EngineClient("http://isolated.invalid").submitPolar(legacy);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("http://isolated.invalid/polars");
  });

  it.each([true, "0.2", NaN, Infinity, -1, 1.01])(
    "rejects invalid smoothing %s without any request",
    async (smoothing) => {
      const fetch = transport(1);
      await expect(
        new EngineClient("http://isolated.invalid").submitPolar({
          ...request,
          solver: {
            ...request.solver,
            local_time_step_smoothing: smoothing as number,
          },
        }),
      ).rejects.toThrow("Invalid explicit");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
