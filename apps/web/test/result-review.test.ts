import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewResult } from "../lib/admin";
import {
  buildResultReviewPayload,
  buildReviewQueue,
  canSubmitResultReview,
  formatResultReviewLine,
  gateChecklistView,
  reviewStepperView,
  shouldShowReviewLayer,
} from "../lib/result-review";
import {
  buildSolverWorkPopoverView,
  type SolverWorkCondition,
  type SolverWorkPoint,
} from "../lib/solver-work";

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
    reviewed: false,
    review: null,
    ...overrides,
  };
}

function condition(
  overrides: Partial<SolverWorkCondition>,
): SolverWorkCondition {
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
      {
        key: "periods:0",
        text: "✓ periods — 2 repeatable periods saved",
        pass: true,
      },
      { key: "drift:1", text: "✗ drift — Cl drift 9.2%", pass: false },
    ]);
  });

  it("requires an exclusion note and pins the conservative POST payload", async () => {
    expect(canSubmitResultReview("exclude", "   ")).toBe(false);
    expect(
      canSubmitResultReview("exclude", "bad retained-period evidence"),
    ).toBe(true);
    expect(canSubmitResultReview("defer", "")).toBe(true);
    expect(
      buildResultReviewPayload("exclude", " bad retained-period evidence "),
    ).toEqual({
      verdict: "exclude",
      note: "bad retained-period evidence",
    });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            review: {
              id: "review-1",
              verdict: "exclude",
              note: "bad retained-period evidence",
              reviewer: "ja@vr.ae",
              createdAt: "2026-07-10T08:15:00.000Z",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await reviewResult("result-1", "exclude", " bad retained-period evidence ");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:4000/api/admin/results/result-1/review");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(String(init.body))).toEqual({
      verdict: "exclude",
      note: "bad retained-period evidence",
    });
  });

  it("keeps retired waiver rows readable as immutable history", () => {
    expect(
      formatResultReviewLine({
        verdict: "waive",
        note: "accepted after visual check",
        reviewer: "ja@vr.ae",
        createdAt: "2026-07-10T08:15:00.000Z",
        revokedAt: "2026-07-11T00:00:00.000Z",
      }),
    ).toBe(
      "waived by ja@vr.ae · 2026-07-10 · revoked: accepted after visual check",
    );
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

    expect(queue.map((item) => item.resultId)).toEqual([
      "a-neg2",
      "a-6",
      "b-1",
      "b-3",
    ]);
    const stepper = reviewStepperView(queue, "a-6");
    expect(stepper?.label).toBe("2 of 4 in queue");
    expect(stepper?.nextLabel).toBe("review next ▸");
    expect(stepper?.next.resultId).toBe("b-1");
    expect(reviewStepperView(queue.slice(0, 1), "a-neg2")).toBeNull();
  });

  it("a revoked legacy waiver cannot expose an accept/review path or alter blocked state", () => {
    const waived = point({
      state: "blocked",
      resultId: "res-waived",
      reviewed: false,
      review: null,
    });
    const view = buildSolverWorkPopoverView(
      condition({ points: [waived] }),
      waived,
      false,
    );

    expect(shouldShowReviewLayer(false, waived)).toBe(false);
    expect(shouldShowReviewLayer(true, waived)).toBe(false);
    expect(view.visualState).toBe("blocked");
    expect(view.actions.filter((action) => action.adminOnly)).toEqual([]);
    expect(view.reviewedDisclosure).toBeNull();
  });
});
