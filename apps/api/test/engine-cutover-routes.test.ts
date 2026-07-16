import { afterEach, describe, expect, it } from "vitest";

import { COOKIE_NAME, signSession } from "../src/admin-auth";
import { buildServer } from "../src/server";

const ORIGINAL_ENV = { ...process.env };
const CUTOVER_READINESS =
  "/api/admin/solver-engine-cutovers/opencfd-2606/readiness";
const CUTOVER_BASE =
  "/api/admin/solver-engine-cutovers/opencfd-2606";

function configureProductionAuth(): string {
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_SESSION_SECRET = "engine-cutover-route-test-secret";
  process.env.ADMIN_PUBLIC_ORIGIN = "https://airfoils.pro";
  return `${COOKIE_NAME}=${signSession("operator@airfoils.pro")}`;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("OpenCFD 2606 cutover maintenance boundary", () => {
  it("requires an authenticated production admin", async () => {
    configureProductionAuth();
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: CUTOVER_READINESS,
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: "admin authentication required",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects a signed session presented by a sibling or foreign origin", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: CUTOVER_READINESS,
        headers: {
          cookie,
          origin: "https://compromised.airfoils.pro",
          "sec-fetch-site": "same-site",
        },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "solver maintenance requires an exact-origin admin request",
      });
    } finally {
      await app.close();
    }
  });

  it("accepts exact-origin authentication up to strict body validation", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: CUTOVER_READINESS,
        headers: {
          cookie,
          origin: "https://airfoils.pro",
          "sec-fetch-site": "same-origin",
        },
        // The production operation is deliberately global; accepting a
        // campaign subset could strand other legacy/2406 work.
        payload: { campaignIds: [] },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "validation",
        error: "invalid OpenCFD v2606 cutover request",
      });
    } finally {
      await app.close();
    }
  });

  it("allows headerless localhost maintenance clients but keeps strict validation", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: CUTOVER_READINESS,
        headers: { cookie },
        payload: { campaignIds: ["not-authorized"] },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "validation" });
    } finally {
      await app.close();
    }
  });

  it("rejects direct finalize and complete bypasses without an attestation id", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      for (const stage of ["finalize", "complete"]) {
        const response = await app.inject({
          method: "POST",
          url: `${CUTOVER_BASE}/${stage}`,
          headers: { cookie },
          payload: {},
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: "validation" });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects a forged success label before contacting the live engine", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: `${CUTOVER_BASE}/attest`,
        headers: { cookie },
        payload: { receipt: { status: "ok" } },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "validation",
        error: "invalid OpenCFD v2606 cutover request",
      });
    } finally {
      await app.close();
    }
  });
});
