import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("same-origin preview API routing", () => {
  it("uses relative browser URLs while retaining the internal server endpoint", async () => {
    vi.stubEnv("API_URL", "http://127.0.0.1:20026");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const api = await import("../lib/api");
    expect(api.apiBase()).toBe("http://127.0.0.1:20026");
    vi.stubGlobal("window", {});
    expect(api.apiBase()).toBe("");
    expect(api.browserUrl("/api/results/stored/media")).toBe(
      "/api/results/stored/media",
    );
    expect(api.browserUrl("https://trusted.example/media")).toBe(
      "https://trusted.example/media",
    );
  });

  it("keeps material writes on the browser origin with credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [] }),
      });
    vi.stubGlobal("fetch", fetch);
    const admin = await import("../lib/admin");
    await admin.getAdminMediums();
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/mediums",
      expect.objectContaining({ credentials: "include" }),
    );
    await admin.updateAdminMedium("owned-medium", { name: "Updated" });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/admin/mediums/owned-medium",
      expect.objectContaining({ method: "PATCH", credentials: "include" }),
    );
  });

  it("preserves an explicitly configured external client origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example");
    vi.stubGlobal("window", {});
    const api = await import("../lib/api");
    expect(api.apiBase()).toBe("https://api.example");
    expect(api.browserUrl("/api/airfoils")).toBe(
      "https://api.example/api/airfoils",
    );
  });

  it("forwards all API paths, including sync, to the server-only endpoint", async () => {
    vi.stubEnv("API_URL", "http://127.0.0.1:20026/");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://preview.example");
    const config = (await import("../next.config")).default;
    expect(await config.rewrites!()).toEqual([
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:20026/api/:path*",
      },
    ]);
  });

  it("does not create a self-rewrite when the public origin is relative", async () => {
    vi.stubEnv("API_URL", "");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    const config = (await import("../next.config")).default;
    expect(await config.rewrites!()).toEqual([
      {
        source: "/api/:path*",
        destination: "http://localhost:4000/api/:path*",
      },
    ]);
  });
});
