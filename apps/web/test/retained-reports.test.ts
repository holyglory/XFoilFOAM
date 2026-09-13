import { afterEach, expect, it, vi } from "vitest";
import {
  retainedReportDownloadPath,
  retainedReportFilters,
  retainedReportSearch,
} from "../lib/retained-reports";
import { downloadRetainedReport, getRetainedReports } from "../lib/admin";
import type { RetainedSolverReport } from "@aerodb/core";
import { createHash } from "node:crypto";

afterEach(() => vi.unstubAllGlobals());
const executionId = "11111111-1111-4111-8111-111111111111";
const bytes = '{"fixture":true}';
const signature = createHash("sha256").update(bytes).digest("hex");
const report = { executionId, sequence: 7, signature } as RetainedSolverReport;

it("preserves job-log routing while filters and pagination round trip", () => {
  const filters = {
    airfoil: "AG 24",
    campaignId: executionId,
    includeDelivered: true,
    cursor: "opaque+/=",
  };
  const search = retainedReportSearch(
    "?section=queue&flog=1&tab=campaign",
    filters,
  );
  expect(retainedReportFilters(search)).toEqual(filters);
  expect(new URLSearchParams(search).get("flog")).toBe("1");
  expect(new URLSearchParams(search).get("section")).toBe("queue");
  expect(
    retainedReportSearch(search, {
      airfoil: "",
      campaignId: "",
      includeDelivered: false,
      cursor: "",
    }),
  ).toBe("?section=queue&flog=1&tab=campaign");
});

it("requests bounded pages and binds downloads to exact evidence rather than rounded conditions", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  await getRetainedReports(
    {
      airfoil: "AG & 24",
      campaignId: executionId,
      includeDelivered: false,
      cursor: "cursor",
    },
    controller.signal,
  );
  const [url, init] = fetcher.mock.calls[0];
  expect(new URL(url).searchParams.get("airfoil")).toBe("AG & 24");
  expect(new URL(url).searchParams.get("limit")).toBe("25");
  expect(init.credentials).toBe("include");
  expect(init.signal).toBe(controller.signal);
  expect(retainedReportDownloadPath(report)).toBe(
    `/api/admin/retained-reports/${executionId}/7?signature=${signature}`,
  );
  for (const patch of [
    { sequence: NaN },
    { sequence: 0 },
    { executionId: "../other" },
    { signature: "unknown" },
  ]) {
    expect(() => retainedReportDownloadPath({ ...report, ...patch })).toThrow();
  }
});

it("preserves exact downloaded bytes and refuses mismatched headers or bodies", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(bytes, { headers: { "x-content-sha256": signature } }),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await (
      await downloadRetainedReport(report, new AbortController().signal)
    ).text(),
  ).toBe(bytes);
  fetcher.mockResolvedValueOnce(
    new Response(bytes, { headers: { "x-content-sha256": "0".repeat(64) } }),
  );
  await expect(
    downloadRetainedReport(report, new AbortController().signal),
  ).rejects.toThrow("integrity");
  fetcher.mockResolvedValueOnce(
    new Response("changed", { headers: { "x-content-sha256": signature } }),
  );
  await expect(
    downloadRetainedReport(report, new AbortController().signal),
  ).rejects.toThrow("integrity");
});

it("surfaces authentication and integrity failures without saving an error response", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(new Response('{"error":"Sign in"}', { status: 401 })),
  );
  await expect(
    downloadRetainedReport(report, new AbortController().signal),
  ).rejects.toMatchObject({ status: 401, message: "Sign in" });
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(bytes, { headers: { "x-content-sha256": signature } }),
      ),
  );
  await expect(
    downloadRetainedReport(report, controller.signal),
  ).rejects.toThrow();
});
