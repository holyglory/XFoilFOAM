import { afterEach, describe, expect, it, vi } from "vitest";

import { COOKIE_NAME, GOOGLE_STATE_COOKIE_NAME } from "../src/admin-auth";
import { buildServer } from "../src/server";

const ORIGINAL_ENV = { ...process.env };

function configureGoogleAuth() {
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_GOOGLE_CLIENT_ID = "google-client-test";
  process.env.ADMIN_GOOGLE_CLIENT_SECRET = "google-secret-test";
  process.env.ADMIN_GOOGLE_ALLOWED_DOMAIN = "vr.ae";
  process.env.ADMIN_GOOGLE_REDIRECT_URI = "https://airfoils.pro/api/admin/oauth/google/callback";
  process.env.ADMIN_SESSION_SECRET = "admin-auth-test-secret";
  delete process.env.ADMIN_PASSWORD;
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string {
  const raw = Array.isArray(setCookie) ? setCookie.find((cookie) => cookie.startsWith(`${name}=`)) : setCookie;
  if (!raw) throw new Error(`missing ${name} cookie`);
  return raw.split(";")[0].slice(name.length + 1);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("Google admin OAuth", () => {
  it("advertises Google OAuth without exposing secrets", async () => {
    configureGoogleAuth();
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        authed: false,
        mode: "prod",
        providers: { google: true, password: false },
        google: { enabled: true, allowedDomain: "vr.ae", loginUrl: "/api/admin/oauth/google?returnTo=/admin" },
      });
      expect(res.body).not.toContain("google-secret-test");
    } finally {
      await app.close();
    }
  });

  it("starts the Google flow with a signed state cookie and hosted-domain hint", async () => {
    configureGoogleAuth();
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/oauth/google?returnTo=/admin" });
      expect(res.statusCode).toBe(303);
      const location = res.headers.location;
      expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
      expect(location).toContain("client_id=google-client-test");
      expect(location).toContain("hd=vr.ae");
      expect(location).toContain(encodeURIComponent("https://airfoils.pro/api/admin/oauth/google/callback"));
      expect(cookieValue(res.headers["set-cookie"], GOOGLE_STATE_COOKIE_NAME)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("creates an admin session for verified vr.ae Google accounts only", async () => {
    configureGoogleAuth();
    const app = await buildServer();
    try {
      const start = await app.inject({ method: "GET", url: "/api/admin/oauth/google?returnTo=/admin" });
      const state = cookieValue(start.headers["set-cookie"], GOOGLE_STATE_COOKIE_NAME);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const href = String(url);
          if (href.includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "access-token-test" });
          if (href.includes("openidconnect.googleapis.com/v1/userinfo")) {
            return jsonResponse({ email: "solver@vr.ae", email_verified: true, hd: "vr.ae" });
          }
          return jsonResponse({ error: "unexpected url" }, 404);
        }),
      );

      const res = await app.inject({
        method: "GET",
        url: `/api/admin/oauth/google/callback?code=oauth-code-test&state=${encodeURIComponent(state)}`,
        headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${state}` },
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe("/admin");
      expect(cookieValue(res.headers["set-cookie"], COOKIE_NAME)).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("rejects verified Google accounts outside the allowed domain", async () => {
    configureGoogleAuth();
    const app = await buildServer();
    try {
      const start = await app.inject({ method: "GET", url: "/api/admin/oauth/google?returnTo=/admin" });
      const state = cookieValue(start.headers["set-cookie"], GOOGLE_STATE_COOKIE_NAME);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
          const href = String(url);
          if (href.includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "access-token-test" });
          if (href.includes("openidconnect.googleapis.com/v1/userinfo")) {
            return jsonResponse({ email: "outsider@example.com", email_verified: true });
          }
          return jsonResponse({ error: "unexpected url" }, 404);
        }),
      );

      const res = await app.inject({
        method: "GET",
        url: `/api/admin/oauth/google/callback?code=oauth-code-test&state=${encodeURIComponent(state)}`,
        headers: { cookie: `${GOOGLE_STATE_COOKIE_NAME}=${state}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "Google account must belong to vr.ae" });
      expect(String(res.headers["set-cookie"] || "")).not.toContain(`${COOKIE_NAME}=`);
    } finally {
      await app.close();
    }
  });
});
