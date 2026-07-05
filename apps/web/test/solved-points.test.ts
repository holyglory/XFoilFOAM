// Pure invariants of the solved-points popover (Solver page redesign,
// screen 5): keyset page merging and prev/next stepping with load-more.
import { describe, expect, it } from "vitest";

import type { AdminSolvedPoint } from "../lib/admin";
import { mergeSolvedPointsPages, stepSolvedPoint } from "../lib/solved-points";

function row(id: string, aoa: number): AdminSolvedPoint {
  return {
    resultId: id,
    simJobId: "job-1",
    airfoilSlug: "naca0012",
    airfoilName: "NACA 0012",
    aoaDeg: aoa,
    speed: 5.84,
    reynolds: 400000,
    cl: 0.4,
    cd: 0.02,
    clCd: 20,
    classificationState: "accepted",
    solvedAt: "2026-07-04T10:00:00.000Z",
  };
}

describe("mergeSolvedPointsPages", () => {
  it("appends a fresh page after the loaded rows", () => {
    const prev = [row("a", 0), row("b", 1)];
    const next = [row("c", 2), row("d", 3)];
    expect(mergeSolvedPointsPages(prev, next).map((r) => r.resultId)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops duplicate resultIds so a shifting keyset window cannot double-list a row", () => {
    const prev = [row("a", 0), row("b", 1)];
    const next = [row("b", 1), row("c", 2)];
    expect(mergeSolvedPointsPages(prev, next).map((r) => r.resultId)).toEqual(["a", "b", "c"]);
  });

  it("keeps loaded order stable (only appends — the open row's index never moves)", () => {
    const prev = [row("b", 1), row("a", 0)];
    const merged = mergeSolvedPointsPages(prev, [row("c", 2)]);
    expect(merged.slice(0, 2)).toEqual(prev);
  });

  it("returns the previous array identity when nothing new arrived", () => {
    const prev = [row("a", 0)];
    expect(mergeSolvedPointsPages(prev, [row("a", 0)])).toBe(prev);
  });

  it("returns the next page as-is on an empty previous list", () => {
    const next = [row("a", 0)];
    expect(mergeSolvedPointsPages([], next)).toBe(next);
  });
});

describe("stepSolvedPoint", () => {
  it("moves within the loaded list in both directions", () => {
    expect(stepSolvedPoint(3, 1, 1, null)).toEqual({ kind: "move", index: 2 });
    expect(stepSolvedPoint(3, 1, -1, null)).toEqual({ kind: "move", index: 0 });
  });

  it("stays put at the first row (prev is a hard end)", () => {
    expect(stepSolvedPoint(3, 0, -1, "cursor")).toEqual({ kind: "none" });
  });

  it("stays put at the last row when the server has no more pages", () => {
    expect(stepSolvedPoint(3, 2, 1, null)).toEqual({ kind: "none" });
  });

  it("asks to load more at the last loaded row when a next cursor exists", () => {
    expect(stepSolvedPoint(3, 2, 1, "2026-07-04T10:00:00.000Z|abc")).toEqual({ kind: "load-more" });
  });

  it("does nothing for an empty list or an out-of-range index", () => {
    expect(stepSolvedPoint(0, 0, 1, "cursor")).toEqual({ kind: "none" });
    expect(stepSolvedPoint(3, -1, 1, "cursor")).toEqual({ kind: "none" });
    expect(stepSolvedPoint(3, 3, 1, "cursor")).toEqual({ kind: "none" });
  });
});
