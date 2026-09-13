import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, expect, it, vi } from "vitest";
import {
  RetainedReportReadError,
  retainedSolverReportDownload,
  retainedSolverReports,
} from "@aerodb/db";
import { COOKIE_NAME, signSession } from "../src/admin-auth";
import { registerRetainedReportRoutes } from "../src/retained-report-routes";

vi.mock("../src/db", () => ({ db: {} }));
vi.mock("@aerodb/db", async (original) => ({
  ...(await original<typeof import("@aerodb/db")>()),
  retainedSolverReports: vi.fn(),
  retainedSolverReportDownload: vi.fn(),
}));

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
});

async function server() {
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_SESSION_SECRET = "isolated-retained-report-test";
  const app = Fastify();
  await app.register(cookie);
  await registerRetainedReportRoutes(app);
  const headers = {
    cookie: `${COOKIE_NAME}=${signSession("operator@example.test")}`,
  };
  return { app, headers };
}

it("protects both list and exact download before reading stored data", async () => {
  const { app } = await server();
  try {
    for (const url of [
      "/api/admin/retained-reports",
      `/api/admin/retained-reports/${randomUUID()}/1?signature=${"a".repeat(64)}`,
    ])
      expect((await app.inject({ url })).statusCode).toBe(401);
    expect(retainedSolverReports).not.toHaveBeenCalled();
    expect(retainedSolverReportDownload).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("parses bounded filters without treating false as true", async () => {
  const { app, headers } = await server();
  vi.mocked(retainedSolverReports).mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  try {
    const response = await app.inject({
      url: "/api/admin/retained-reports?includeDelivered=false&limit=10&airfoil=ag24",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(retainedSolverReports).toHaveBeenCalledWith(
      {},
      { includeDelivered: false, limit: 10, airfoil: "ag24" },
    );
    for (const query of [
      "limit=51",
      "limit=0",
      "includeDelivered=invalid",
      "campaignId=invalid",
    ])
      expect(
        (
          await app.inject({
            url: `/api/admin/retained-reports?${query}`,
            headers,
          })
        ).statusCode,
      ).toBe(400);
    vi.mocked(retainedSolverReports).mockRejectedValue(
      new RetainedReportReadError(
        400,
        "Invalid retained-report cursor or changed filters",
      ),
    );
    expect(
      (
        await app.inject({
          url: "/api/admin/retained-reports?cursor=bad",
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});

it("downloads exact stored bytes and surfaces missing or corrupt evidence without synthesis", async () => {
  const { app, headers } = await server();
  const executionId = randomUUID();
  const content = JSON.stringify({
    executionId,
    sequence: 2,
    result: { state: "failed" },
  });
  const signature = createHash("sha256").update(content).digest("hex");
  vi.mocked(retainedSolverReportDownload).mockResolvedValue({
    content,
    signature,
    filename: "ag24-solver-report-2.json",
  });
  const url = `/api/admin/retained-reports/${executionId}/2?signature=${signature}`;
  try {
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(content);
    expect(response.headers["x-content-sha256"]).toBe(signature);
    expect(response.headers["access-control-expose-headers"]).toBe(
      "x-content-sha256",
    );
    expect(response.headers["content-disposition"]).toContain(
      'filename="ag24-solver-report-2.json"',
    );
    expect(retainedSolverReportDownload).toHaveBeenCalledWith(
      {},
      { executionId, sequence: 2, signature },
    );
    for (const status of [404, 409] as const) {
      vi.mocked(retainedSolverReportDownload).mockRejectedValue(
        new RetainedReportReadError(status, "Stored report unavailable"),
      );
      expect((await app.inject({ url, headers })).statusCode).toBe(status);
    }
    expect(
      (
        await app.inject({
          url: `/api/admin/retained-reports/${executionId}/0?signature=${signature}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
