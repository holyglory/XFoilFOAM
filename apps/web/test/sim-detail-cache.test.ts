import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function detailPayload(resultId?: string) {
  return {
    ...(resultId ? { resultId } : {}),
    status: "solved",
    regime: "attached",
    airfoilName: "fixture",
    alpha: 7,
    re: 102347,
    mach: 0.09,
    cl: 1.2583,
    cd: 0.03094,
    cm: -0.105,
    ld: 40.66,
    media: null,
    availableFields: [],
    history: null,
    steadyHistory: null,
    frameTrack: null,
    condition: null,
  };
}

describe("simulation-detail evidence cache", () => {
  it("deduplicates concurrent requests, fills the cache, and bridges a missing resultId", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);
    const { getCachedSim, getSim } = await import("../lib/api");

    const first = getSim("2032c", 102347, 7, "result-a7");
    const concurrent = getSim("2032c", 102347, 7, "result-a7");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(
      new Response(JSON.stringify(detailPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const [one, two] = await Promise.all([first, concurrent]);
    expect(one).toBe(two);
    expect(one.resultId).toBe("result-a7");
    expect(getCachedSim("2032c", 102347, 7, "result-a7")).toBe(one);

    const repeated = await getSim("2032c", 102347, 7, "result-a7");
    expect(repeated).toBe(one);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retain a failed request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(detailPayload("result-retry")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { getSim } = await import("../lib/api");

    await expect(getSim("2032c", 102347, 7, "result-retry")).rejects.toThrow(
      "GET sim → 503",
    );
    await expect(
      getSim("2032c", 102347, 7, "result-retry"),
    ).resolves.toMatchObject({ resultId: "result-retry" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
