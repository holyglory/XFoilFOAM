import {
  EngineClient,
  EngineError,
  type ArchiveCleanCycleReductionRequest,
} from "@aerodb/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN = "control-plane-token-which-is-long-enough";

function request(
  fidelity: ArchiveCleanCycleReductionRequest["fidelity"] = "urans_precalc",
): ArchiveCleanCycleReductionRequest {
  return {
    remote: {
      schemaVersion: 1,
      format: "tar+zstd",
      bucket: "airfoils-pro-storage-bucket",
      objectKey: `solver-evidence/v1/sha256/aa/${"a".repeat(64)}.tar.zst`,
      generation: "18446744073709551615",
      storedSha256: "a".repeat(64),
      storedSize: 12_345,
      tarSha256: "b".repeat(64),
      tarSize: 54_321,
      crc32c: "AAAAAA==",
      zstdLevel: 10,
      createdAt: "2026-07-28T00:00:00.000Z",
    },
    fidelity,
  };
}

function response() {
  return {
    state: "continuation_required",
    inputEvidenceSignature: "c".repeat(64),
    point: {
      aoa_deg: 12,
      unsteady: true,
      converged: false,
      force_history: null,
      urans_cycle_certificate: { certified: false },
    },
    diagnostics: { source: "archive_backfill" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("archive clean-cycle reduction engine client", () => {
  it("MUST-CATCH: the 15-minute evidence budget is not cut off by Undici's five-minute header timeout", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const dispatcher = (
        init as RequestInit & {
          dispatcher?: { dispatch?: unknown };
        }
      )?.dispatcher;
      expect(dispatcher).toBeDefined();
      expect(typeof dispatcher?.dispatch).toBe("function");
      return new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.reduceRemoteEvidenceCleanCycles(request()),
    ).resolves.toEqual(response());
  });

  it("sends only the exact pointer/fidelity under the control-plane bearer", async () => {
    const expected = request();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      expect(JSON.parse(String(init?.body))).toEqual(expected);
      return new Response(JSON.stringify(response()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.reduceRemoteEvidenceCleanCycles(expected, { timeoutMs: 2_000 }),
    ).resolves.toEqual(response());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://engine.test/internal/evidence-archives/reduce-clean-cycles",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails closed on a missing bearer or malformed reduction response", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const untrusted = new EngineClient("http://engine.test");
    expect(() => untrusted.reduceRemoteEvidenceCleanCycles(request())).toThrow(
      expect.objectContaining({ code: "archive_reduction_auth_missing" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ...response(), inputEvidenceSignature: "bad" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.reduceRemoteEvidenceCleanCycles(request()),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "archive_reduction_contract_drift",
      }),
    );
  });

  it("preserves an explicit clean-cycle recovery cap instead of treating it as malformed", async () => {
    const exhausted = {
      ...response(),
      state: "recovery_exhausted" as const,
      diagnostics: {
        source: "archive_backfill",
        critical: true,
        recoveryState: "exhausted",
        auditedPeriods: 9,
        maximumPeriods: 9,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(exhausted), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.reduceRemoteEvidenceCleanCycles(request()),
    ).resolves.toEqual(exhausted);
  });

  it("accepts a typed continuation proof only when its remaining physical budget is exact", async () => {
    const typed = {
      ...response(),
      diagnostics: {
        source: "archive_backfill",
        recoveryProgress: {
          measuredPeriods: 8,
          maxPeriods: 9,
          recommendedAdditionalPeriods: 1,
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(typed), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.reduceRemoteEvidenceCleanCycles(request()),
    ).resolves.toEqual(typed);
  });

  it.each([
    [
      "uses the FINAL cap for a FAST continuation",
      request(),
      {
        ...response(),
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 8,
            maxPeriods: 12,
            recommendedAdditionalPeriods: 1,
          },
        },
      },
    ],
    [
      "asks for more periods than remain before the cap",
      request(),
      {
        ...response(),
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 8,
            maxPeriods: 9,
            recommendedAdditionalPeriods: 2,
          },
        },
      },
    ],
    [
      "adds a continuation recommendation after the cap",
      request(),
      {
        ...response(),
        state: "recovery_exhausted",
        diagnostics: {
          recoveryProgress: {
            measuredPeriods: 9,
            maxPeriods: 9,
            recommendedAdditionalPeriods: 1,
          },
        },
      },
    ],
  ])(
    "fails closed when typed recovery progress %s",
    async (_label, input, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      const client = new EngineClient("http://engine.test", {
        controlPlaneToken: TOKEN,
      });
      await expect(
        client.reduceRemoteEvidenceCleanCycles(input),
      ).rejects.toEqual(
        expect.objectContaining({ code: "archive_reduction_contract_drift" }),
      );
    },
  );

  it("preserves an answered archive rejection as an EngineError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"detail":"archive member checksum mismatch"}', {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.reduceRemoteEvidenceCleanCycles(request()),
    ).rejects.toBeInstanceOf(EngineError);
  });
});
