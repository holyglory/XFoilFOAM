import {
  EngineClient,
  EngineError,
  type VerifyRemoteEvidenceManifestRequest,
  type VerifyRemoteEvidenceManifestResponse,
} from "@aerodb/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN = "control-plane-token-which-is-long-enough";

function request(): VerifyRemoteEvidenceManifestRequest {
  return {
    remote: {
      schemaVersion: 1,
      format: "tar+zstd",
      bucket: "airfoils-pro-storage-bucket",
      objectKey: `solver-evidence/v1/sha256/${"a".repeat(2)}/${"a".repeat(64)}.tar.zst`,
      generation: "18446744073709551615",
      storedSha256: "a".repeat(64),
      storedSize: 54_321,
      tarSha256: "b".repeat(64),
      tarSize: 98_765,
      crc32c: "AAAAAA==",
      zstdLevel: 10,
      createdAt: "2026-07-18T22:00:00.000Z",
    },
    manifestBase64: Buffer.from('{"schemaVersion":2,"files":[]}').toString(
      "base64",
    ),
    manifestSha256: "c".repeat(64),
    manifestByteSize: 30,
    manifestMemberSetSha256: "d".repeat(64),
    manifestMemberCount: 1,
  };
}

function exactResponse(
  value: VerifyRemoteEvidenceManifestRequest,
): VerifyRemoteEvidenceManifestResponse {
  return {
    state: "verified",
    remote: { ...value.remote },
    manifestSha256: value.manifestSha256,
    manifestByteSize: value.manifestByteSize,
    manifestMemberSetSha256: value.manifestMemberSetSha256,
    manifestMemberCount: value.manifestMemberCount,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine client canonical evidence verification", () => {
  it("MUST-CATCH: sends the control-plane bearer and accepts only an exact pointer/manifest proof", async () => {
    const expected = request();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
      });
      expect(JSON.parse(String(init?.body))).toEqual(expected);
      return new Response(JSON.stringify(exactResponse(expected)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.verifyRemoteEvidenceManifest(expected, { timeoutMs: 2_000 }),
    ).resolves.toEqual(exactResponse(expected));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://engine.test/internal/evidence-archives/verify-manifest",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fails before network I/O when the control-plane bearer is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new EngineClient("http://engine.test");
    let caught: unknown;
    try {
      client.verifyRemoteEvidenceManifest(request());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "evidence_verification_auth_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["state", (response: Record<string, unknown>) => (response.state = "ok")],
    [
      "generation",
      (response: Record<string, unknown>) => {
        (response.remote as Record<string, unknown>).generation = "7";
      },
    ],
    [
      "stored hash",
      (response: Record<string, unknown>) => {
        (response.remote as Record<string, unknown>).storedSha256 = "e".repeat(
          64,
        );
      },
    ],
    [
      "manifest hash",
      (response: Record<string, unknown>) =>
        (response.manifestSha256 = "e".repeat(64)),
    ],
    [
      "manifest size",
      (response: Record<string, unknown>) => (response.manifestByteSize = 31),
    ],
    [
      "member-set hash",
      (response: Record<string, unknown>) =>
        (response.manifestMemberSetSha256 = "e".repeat(64)),
    ],
    [
      "member count",
      (response: Record<string, unknown>) => (response.manifestMemberCount = 2),
    ],
  ])("rejects a response with a mismatched %s", async (_label, mutate) => {
    const expected = request();
    const response = exactResponse(expected) as unknown as Record<
      string,
      unknown
    >;
    mutate(response);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    await expect(
      client.verifyRemoteEvidenceManifest(expected, { timeoutMs: 2_000 }),
    ).rejects.toMatchObject({
      code: "evidence_verification_identity_mismatch",
    });
  });

  it("keeps an answered engine rejection as an EngineError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"detail":"generation mismatch"}', {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = new EngineClient("http://engine.test", {
      controlPlaneToken: TOKEN,
    });
    let caught: unknown;
    try {
      await client.verifyRemoteEvidenceManifest(request(), {
        timeoutMs: 2_000,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).toMatchObject({ status: 409 });
  });
});
