import { afterEach, describe, expect, it, vi } from "vitest";

import { getCampaign, listCampaigns } from "../lib/admin";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin live scheduler fetches", () => {
  it("MUST-CATCH: bypasses the browser cache for both scheduler-bearing campaign reads", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ items: [], total: 0, scheduler: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await listCampaigns({ limit: 1 });
    await getCampaign("11111111-1111-4111-8111-111111111111");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      cache: "no-store",
    });
  });
});
