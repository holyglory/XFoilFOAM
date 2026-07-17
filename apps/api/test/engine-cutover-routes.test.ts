import { afterEach, describe, expect, it } from "vitest";

import { COOKIE_NAME, signSession } from "../src/admin-auth";
import { OPENCFD_2606_ATTESTATION_BODY_LIMIT_BYTES } from "../src/engine-cutover-routes";
import { buildServer } from "../src/server";

const ORIGINAL_ENV = { ...process.env };
const CUTOVER_READINESS =
  "/api/admin/solver-engine-cutovers/opencfd-2606/readiness";
const CUTOVER_BASE = "/api/admin/solver-engine-cutovers/opencfd-2606";
const PRODUCTION_CANARY_RECEIPT_BYTES = 2_313_736;

function invalidAttestationJson(byteLength: number): string {
  const prefix = '{"receipt":{"padding":"';
  const suffix = '"}}';
  const paddingLength =
    byteLength - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (paddingLength < 0) throw new Error("requested JSON body is too small");
  const body = `${prefix}${"x".repeat(paddingLength)}${suffix}`;
  expect(Buffer.byteLength(body)).toBe(byteLength);
  return body;
}

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

  it("MUST-CATCH: accepts the 2.31 MB production receipt through route parsing before authoritative validation", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "POST",
        url: `${CUTOVER_BASE}/attest`,
        headers: {
          cookie,
          origin: "https://airfoils.pro",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        payload: invalidAttestationJson(PRODUCTION_CANARY_RECEIPT_BYTES),
      });
      // The deliberately malformed receipt reached the strict receipt schema;
      // a body-parser 413 would reproduce the production incident.
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "validation",
        error: "invalid OpenCFD v2606 cutover request",
      });
    } finally {
      await app.close();
    }
  });

  it("FALSE-POSITIVE GUARD: caps attestation and leaves sibling maintenance plus public routes on the default limit", async () => {
    const cookie = configureProductionAuth();
    const app = await buildServer();
    try {
      const overAttestationLimit = await app.inject({
        method: "POST",
        url: `${CUTOVER_BASE}/attest`,
        headers: {
          cookie,
          origin: "https://airfoils.pro",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        payload: invalidAttestationJson(
          OPENCFD_2606_ATTESTATION_BODY_LIMIT_BYTES + 1,
        ),
      });
      expect(overAttestationLimit.statusCode).toBe(413);

      const siblingMaintenance = await app.inject({
        method: "POST",
        url: `${CUTOVER_BASE}/readiness`,
        headers: {
          cookie,
          origin: "https://airfoils.pro",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        payload: invalidAttestationJson(PRODUCTION_CANARY_RECEIPT_BYTES),
      });
      expect(siblingMaintenance.statusCode).toBe(413);

      const publicRoute = await app.inject({
        method: "POST",
        url: "/api/airfoils",
        headers: { "content-type": "application/json" },
        payload: invalidAttestationJson(PRODUCTION_CANARY_RECEIPT_BYTES),
      });
      expect(publicRoute.statusCode).toBe(413);
    } finally {
      await app.close();
    }
  });
});
