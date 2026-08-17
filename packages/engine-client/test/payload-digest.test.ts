import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENGINE_PAYLOAD_DIGEST_MISMATCH_CODE,
  EngineClient,
} from "../src/client";

const MATCHING_DIGEST = "a".repeat(64);

function answeredJson(
  body: unknown,
  sourceSha256: string | null = MATCHING_DIGEST,
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (sourceSha256 != null) {
    headers.set("x-airfoilfoam-source-sha256", sourceSha256);
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine payload source digest fence", () => {
  it("accepts status evidence only when the engine attests the expected raw file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answeredJson({ job_id: "receipt-job", state: "completed" }),
      ),
    );

    const status = await new EngineClient("http://engine.invalid").getJob(
      "receipt-job",
      { expectedPayloadSha256: MATCHING_DIGEST },
    );

    expect(status).toMatchObject({ job_id: "receipt-job", state: "completed" });
  });

  it.each([
    ["missing", null],
    ["different", "b".repeat(64)],
  ])(
    "rejects result evidence when the source digest is %s",
    async (_label, sourceSha256) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          answeredJson(
            { job_id: "receipt-job", state: "completed", polars: [] },
            sourceSha256,
          ),
        ),
      );

      const request = new EngineClient("http://engine.invalid").getResult(
        "receipt-job",
        { expectedPayloadSha256: MATCHING_DIGEST },
      );

      await expect(request).rejects.toMatchObject({
        name: "EngineError",
        code: ENGINE_PAYLOAD_DIGEST_MISMATCH_CODE,
      });
    },
  );

  it("fails before issuing a request for a malformed receipt digest", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = new EngineClient("http://engine.invalid").getJob(
      "receipt-job",
      { expectedPayloadSha256: "not-a-sha256" },
    );

    await expect(request).rejects.toMatchObject({
      name: "EngineError",
      code: ENGINE_PAYLOAD_DIGEST_MISMATCH_CODE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
