import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewResult } from "../lib/admin";
import {
  buildResultReviewPayload,
  buildReviewQueue,
  canSubmitResultReview,
  gateChecklistView,
  reviewStepperView,
  shouldShowReviewLayer,
} from "../lib/result-review";
import { buildSolverWorkPopoverView, type SolverWorkCondition, type SolverWorkPoint } from "../lib/solver-work";

function point(overrides: Partial<SolverWorkPoint>): SolverWorkPoint {
  return {
    aoaDeg: 0,
    state: "queued",
    resultId: null,
    fidelity: null,
    cl: null,
    cd: null,
    cm: null,
    plain: "queued for solver work",
    gate: null,
    chain: [],
    continuable: false,
    actions: [],
    supersededBy: null,
    ...overrides,
  };
}

function condition(overrides: Partial<SolverWorkCondition>): SolverWorkCondition {
  return {
    presetRevisionId: "rev-1",
    reynolds: 400000,
    mach: 0.06,
    chordM: 0.4,
    speedMps: 22,
    updatedAt: "2026-07-10T08:00:00.000Z",
    attentionCount: 0,
    points: [],
    jobs: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("result review gates and verdict payloads", () => {
  it("renders pass/fail gate checklist lines and hides absent gates", () => {
    expect(gateChecklistView(undefined)).toEqual([]);
    expect(
      gateChecklistView([
        { name: "periods", detail: "2 repeatable periods saved", pass: true },
        { name: "drift", detail: "Cl drift 9.2%", pass: false },
      ]),
    ).toEqual([
      { key: "periods:0", text: "✓ periods — 2 repeatable periods saved", pass: true },
      { key: "drift:1", text: "✗ drift — Cl drift 9.2%", pass: false },
    ]);
  });

  it("disables waiver/exclude without a note and pins the POST payload", async () => {
    expect(canSubmitResultReview("waive", "")).toBe(false);
    expect(canSubmitResultReview("exclude", "   ")).toBe(false);
    expect(canSubmitResultReview("waive", "accepted after visual check")).toBe(true);
    expect(canSubmitResultReview("defer", "")).toBe(true);
    expect(buildResultReviewPayload("waive", " accepted after visual check ")).toEqual({
      verdict: "waive",
      note: "accepted after visual check",
    });

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          review: {
            id: "review-1",
            verdict: "waive",
            note: "accepted after visual check",
            reviewer: "ja@vr.ae",
            createdAt: "2026-07-10T08:15:00.000Z",
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await reviewResult("result-1", "waive", " accepted after visual check ");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/api/admin/results/result-1/review");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({
      verdict: "waive",
      note: "accepted after visual check",
    });
  });
});

describe("result review queue and anonymous guard", () => {
  it("orders needs-review queue by condition order then alpha and pins the next item", () => {
    const first = condition({
      presetRevisionId: "rev-a",
      points: [
        point({ aoaDeg: 6, state: "needs_review", resultId: "a-6" }),
        point({ aoaDeg: -2, state: "needs_review", resultId: "a-neg2" }),
        point({ aoaDeg: 1, state: "verified", resultId: "a-1" }),
      ],
    });
    const second = condition({
      presetRevisionId: "rev-b",
      points: [
        point({ aoaDeg: 3, state: "needs_review", resultId: "b-3" }),
        point({ aoaDeg: 1, state: "needs_review", resultId: "b-1" }),
      ],
    });
    const queue = buildReviewQueue([first, second]);

    expect(queue.map((item) => item.resultId)).toEqual(["a-neg2", "a-6", "b-1", "b-3"]);
    const stepper = reviewStepperView(queue, "a-6");
    expect(stepper?.label).toBe("2 of 4 in queue");
    expect(stepper?.nextLabel).toBe("review next ▸");
    expect(stepper?.next.resultId).toBe("b-1");
    expect(reviewStepperView(queue.slice(0, 1), "a-neg2")).toBeNull();
  });

  it("anonymous users get reviewed disclosure but no review layer or admin actions", () => {
    const waived = point({
      state: "verified",
      resultId: "res-waived",
      reviewed: {
        verdict: "waive",
        note: "accepted after visual check",
        reviewer: "ja@vr.ae",
        at: "2026-07-10T08:15:00.000Z",
      },
    });
    const view = buildSolverWorkPopoverView(condition({ points: [waived] }), waived, false);

    expect(shouldShowReviewLayer(false, waived)).toBe(false);
    expect(view.actions.filter((action) => action.adminOnly)).toEqual([]);
    expect(view.reviewedDisclosure).toBe("waived by ja@vr.ae 2026-07-10: accepted after visual check");
  });
});
