import { beforeEach, expect, it, vi } from "vitest";
import { loadComparisonData } from "../lib/compare-loading";
import { getAirfoilCompareDetail, listAirfoils } from "../lib/api";
import type { AirfoilDetailPayload, AirfoilSummary } from "@aerodb/core";

vi.mock("../lib/api", () => ({
  getAirfoilCompareDetail: vi.fn(),
  listAirfoils: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

it("renders explicitly selected comparison profiles without fetching the full catalog", async () => {
  vi.mocked(listAirfoils).mockImplementation(() => new Promise(() => {}));
  vi.mocked(getAirfoilCompareDetail).mockImplementation(
    async (slug) => ({ slug, name: slug }) as AirfoilDetailPayload,
  );
  const loaded = await loadComparisonData(["ag24", "ag25"], "chosen-condition");
  expect(listAirfoils).not.toHaveBeenCalled();
  expect(getAirfoilCompareDetail).toHaveBeenCalledTimes(2);
  expect(loaded.selection).toEqual(["ag24", "ag25"]);
  expect(Object.keys(loaded.details)).toEqual(["ag24", "ag25"]);
  expect(loaded.items).toEqual([]);
});

it("preloads the default two profiles from the selected-condition ranking without full geometry", async () => {
  vi.mocked(listAirfoils).mockResolvedValue([
    { slug: "ag25" },
    { slug: "ag24" },
  ] as AirfoilSummary[]);
  vi.mocked(getAirfoilCompareDetail).mockResolvedValue(null);
  const loaded = await loadComparisonData(null, "chosen-condition");
  expect(listAirfoils).toHaveBeenCalledWith({
    sort: "ldmax",
    dir: "desc",
    metricConditionKey: "chosen-condition",
    includePoints: false,
    limit: 2,
  });
  expect(loaded.selection).toEqual(["ag25", "ag24"]);
  expect(loaded.unavailable).toEqual(["ag25", "ag24"]);
});

it("keeps a cleared comparison empty without fetching any profiles", async () => {
  expect(await loadComparisonData([], "")).toEqual({
    items: [],
    selection: [],
    details: {},
    unavailable: [],
  });
  expect(listAirfoils).not.toHaveBeenCalled();
  expect(getAirfoilCompareDetail).not.toHaveBeenCalled();
});

it("does not hide an API failure as unavailable polar data", async () => {
  vi.mocked(getAirfoilCompareDetail).mockRejectedValue(
    new Error("upstream failed"),
  );
  await expect(loadComparisonData(["ag24"], "")).rejects.toThrow(
    "upstream failed",
  );
});
