import { afterEach, expect, it, vi } from "vitest";
import { fetchProgressiveRemote } from "../src/progressive-remote-http";

afterEach(() => vi.useRealTimers());

it("waits for hub report processing before retrying pending evidence", async () => {
  vi.useFakeTimers();
  let pendingResponse: Response | undefined;
  let calls = 0;
  const fetcher = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      pendingResponse = new Response(
        JSON.stringify({
          code: "progressive_cfd_evidence_scope_pending",
          error:
            "Progressive CFD execution ownership is awaiting report processing",
        }),
        { status: 503, headers: { "retry-after": "2" } },
      );
      return pendingResponse;
    }
    return new Response("accepted", { status: 200 });
  });

  const response = fetchProgressiveRemote(
    fetcher,
    "https://hub.invalid/polars",
    {
      method: "POST",
      body: "immutable request",
    },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(1);
  expect(pendingResponse?.bodyUsed).toBe(true);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(response).resolves.toMatchObject({ status: 200 });
  expect(calls).toBe(2);
});

it("keeps permanent 503 responses bounded and leaves the final body available", async () => {
  vi.useFakeTimers();
  const responses: Response[] = [];
  const fetcher = vi.fn(async () => {
    const response = new Response("hub remains unavailable", {
      status: 503,
      headers: { "retry-after": "0" },
    });
    responses.push(response);
    return response;
  });

  const pending = fetchProgressiveRemote(fetcher, "https://hub.invalid/polars");
  await vi.runAllTimersAsync();
  const response = await pending;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(responses.slice(0, 2).every((item) => item.bodyUsed)).toBe(true);
  expect(response.bodyUsed).toBe(false);
  await expect(response.text()).resolves.toBe("hub remains unavailable");
});
