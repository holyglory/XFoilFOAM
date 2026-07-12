// Pure invariants of the Point History Explorer (Solver ▸ Points tab):
// filter ⇄ URL query-param round-trip, the one-line STORY digest builder,
// and the story-panel timeline assembly (order, tones, honest why-lines).
import { describe, expect, it } from "vitest";

import {
  assembleTimeline,
  bucketOfPoint,
  buildStoryDigest,
  campaignPointsSearch,
  DEFAULT_POINT_FILTERS,
  formatBulkContinueOutcome,
  parsePointFilters,
  type PointAttemptDigestEvent,
  type PointFilters,
  pointFiltersToSearch,
  type PointStoryAttempt,
  type PointStoryPayload,
  POINT_STATUS_CHIPS,
  statusChipDisplay,
} from "../lib/point-history";

// ---------------------------------------------------------------------------
// bucketOfPoint — client mirror of the server BUCKET_SQL expression (keeps
// the story-panel header chips truthful once the story payload loads).
// ---------------------------------------------------------------------------
describe("bucketOfPoint", () => {
  it("mirrors the server bucket expression for every status × classification", () => {
    expect(bucketOfPoint("failed", null)).toBe("failed");
    expect(bucketOfPoint("failed", "accepted")).toBe("failed"); // status wins
    expect(bucketOfPoint("pending", null)).toBe("solving");
    expect(bucketOfPoint("queued", null)).toBe("solving");
    expect(bucketOfPoint("running", null)).toBe("solving");
    expect(bucketOfPoint("done", "rejected")).toBe("rejected");
    expect(bucketOfPoint("done", "needs_urans")).toBe("needs_urans");
    expect(bucketOfPoint("done", "accepted")).toBe("accepted");
    expect(bucketOfPoint("done", null)).toBe("other"); // unclassified stays honest
    expect(bucketOfPoint("derived", null)).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// filter ⇄ URL round-trip
// ---------------------------------------------------------------------------
describe("point filter query-param round-trip", () => {
  it("defaults produce NO params and parse back to defaults", () => {
    expect(pointFiltersToSearch("", DEFAULT_POINT_FILTERS)).toBe("");
    expect(parsePointFilters("")).toEqual(DEFAULT_POINT_FILTERS);
  });

  it("round-trips every non-default filter and preserves foreign params", () => {
    const filters: PointFilters = {
      status: "failed",
      airfoil: "naca 00",
      campaignId: "0f097f76-c1b9-4794-a8e7-8ba9ae27d565",
      regime: "urans",
      errorClass: "timeout",
      reynolds: "400000",
      verify: "pending",
    };
    const search = pointFiltersToSearch("?section=queue&tab=points", filters);
    expect(search).toContain("section=queue");
    expect(search).toContain("tab=points");
    expect(parsePointFilters(search)).toEqual(filters);
  });

  it("clearing a filter removes its param instead of writing a default value", () => {
    const withStatus = pointFiltersToSearch("?section=queue&tab=points", {
      ...DEFAULT_POINT_FILTERS,
      status: "rejected",
    });
    expect(withStatus).toContain("pstatus=rejected");
    const cleared = pointFiltersToSearch(withStatus, DEFAULT_POINT_FILTERS);
    expect(cleared).not.toContain("pstatus");
    expect(cleared).toContain("section=queue");
  });

  it("campaignPointsSearch targets Solver ▸ Points filtered to campaign + bucket and parses back", () => {
    const id = "0f097f76-c1b9-4794-a8e7-8ba9ae27d565";
    // Includes the amendment-A split buckets the campaign gate badges /
    // needs-review chip now link to, plus the deprecated 'rejected' alias
    // old callers may still emit.
    for (const status of [
      "failed",
      "rejected",
      "awaiting_urans",
      "needs_review",
    ] as const) {
      const search = campaignPointsSearch(id, status);
      const params = new URLSearchParams(search.slice(1));
      expect(params.get("section")).toBe("queue");
      expect(params.get("tab")).toBe("points");
      // Param names come from the explorer's own round-trip — pin them so a
      // rename there cannot silently break the campaign-surface links.
      expect(parsePointFilters(search)).toEqual({
        ...DEFAULT_POINT_FILTERS,
        campaignId: id,
        status,
      });
      expect(params.get("pcampaign")).toBe(id);
      expect(params.get("pstatus")).toBe(status);
    }
  });

  it("chip row exposes machine-owned states but not inactive review workflows", () => {
    expect(POINT_STATUS_CHIPS).toContain("awaiting_urans");
    expect(POINT_STATUS_CHIPS as readonly string[]).not.toContain(
      "needs_review",
    );
    expect(POINT_STATUS_CHIPS as readonly string[]).not.toContain("rejected");
  });

  it("still parses deprecated ?pstatus=rejected links (server keeps the alias bucket)", () => {
    expect(parsePointFilters("?pstatus=rejected").status).toBe("rejected");
    for (const status of ["awaiting_urans", "needs_review"] as const) {
      expect(parsePointFilters(`?pstatus=${status}`).status).toBe(status);
    }
  });

  it("rejects malformed URL values (user-editable input) back to defaults", () => {
    const parsed = parsePointFilters(
      "?pstatus=nonsense&pregime=laminar&perr=exploded&pre=12abc",
    );
    expect(parsed).toEqual(DEFAULT_POINT_FILTERS);
  });
});

// ---------------------------------------------------------------------------
// statusChipDisplay — the ONE recolor rule for status chips (amendment A):
// violet strictly for the calm awaiting-URANS queue, red strictly for
// failed / needs-review, amber for a rejected row whose next solve is
// already scheduled (reviewBucket null).
// ---------------------------------------------------------------------------
describe("statusChipDisplay", () => {
  it("splits the rejected bucket by the server-derived reviewBucket", () => {
    expect(statusChipDisplay("rejected", "awaiting_urans")).toEqual({
      label: "awaiting URANS",
      tone: "violet",
    });
    expect(statusChipDisplay("rejected", "needs_review")).toEqual({
      label: "unavailable",
      tone: "red",
    });
    expect(statusChipDisplay("rejected", null)).toEqual({
      label: "rejected",
      tone: "amber",
    });
    expect(statusChipDisplay("rejected", null, "scheduled")).toEqual({
      label: "rejected · rescheduled",
      tone: "amber",
    });
    expect(statusChipDisplay("rejected", null, "blocked")).toEqual({
      label: "blocked · unavailable",
      tone: "amber",
    });
  });

  it("red is strictly failed / needs-review — never the violet queue", () => {
    expect(statusChipDisplay("failed", "needs_review").tone).toBe("red");
    expect(statusChipDisplay("failed", null).tone).toBe("red");
    expect(statusChipDisplay("rejected", "awaiting_urans").tone).not.toBe(
      "red",
    );
  });

  it("keeps the untouched buckets stable", () => {
    expect(statusChipDisplay("accepted", null)).toEqual({
      label: "accepted",
      tone: "teal",
    });
    expect(statusChipDisplay("needs_urans", null)).toEqual({
      label: "needs URANS",
      tone: "amber",
    });
    expect(statusChipDisplay("solving", null)).toEqual({
      label: "solving",
      tone: "amber",
    });
    expect(statusChipDisplay("other", null)).toEqual({
      label: "other",
      tone: "muted",
    });
  });
});

// ---------------------------------------------------------------------------
// STORY digest
// ---------------------------------------------------------------------------
const ev = (
  over: Partial<PointAttemptDigestEvent>,
): PointAttemptDigestEvent => ({
  regime: "rans",
  validForPolar: false,
  converged: false,
  stalled: false,
  unsteady: false,
  strouhal: null,
  error: null,
  ...over,
});

const item = (
  over: Partial<Parameters<typeof buildStoryDigest>[0]>,
): Parameters<typeof buildStoryDigest>[0] => ({
  kind: "result",
  status: "done",
  bucket: "accepted",
  attemptCount: 0,
  attemptDigest: [],
  sourceAoaDeg: null,
  ...over,
});

describe("buildStoryDigest", () => {
  it("renders the RANS reject → repeated URANS timeout chain with ×N grouping", () => {
    const digest = buildStoryDigest(
      item({
        status: "failed",
        bucket: "failed",
        attemptCount: 4,
        attemptDigest: [
          ev({ regime: "rans", stalled: true }),
          ev({
            regime: "urans",
            error: "OpenFOAMError: URANS timed out after 4h",
          }),
          ev({ regime: "urans", error: "URANS timed out again" }),
          ev({ regime: "urans", error: "solver timeout" }),
        ],
      }),
    );
    expect(digest).toBe("RANS ✗ → URANS ⏱ timeout ×3");
  });

  it("renders the escalation-to-steady-URANS success chain", () => {
    const digest = buildStoryDigest(
      item({
        attemptCount: 2,
        attemptDigest: [
          ev({ regime: "rans", stalled: true }),
          ev({
            regime: "urans",
            validForPolar: true,
            converged: true,
            unsteady: true,
            strouhal: null,
          }),
        ],
      }),
    );
    expect(digest).toBe("RANS ✗ → URANS ✓ steady (no shedding)");
  });

  it("labels a shedding URANS with a measured Strouhal as shedding", () => {
    const digest = buildStoryDigest(
      item({
        attemptCount: 1,
        attemptDigest: [
          ev({
            regime: "urans",
            validForPolar: true,
            converged: true,
            unsteady: true,
            strouhal: 0.21,
          }),
        ],
      }),
    );
    expect(digest).toBe("URANS ✓ shedding");
  });

  it("derived rows say so, with the mirror source angle", () => {
    expect(buildStoryDigest(item({ kind: "derived", sourceAoaDeg: 4 }))).toBe(
      "derived by symmetry — mirror of +4°",
    );
  });

  it("is honest about missing attempt records (no invented chain)", () => {
    expect(
      buildStoryDigest(item({ status: "queued", bucket: "solving" })),
    ).toBe("queued — not attempted yet");
    expect(buildStoryDigest(item({ status: "done", bucket: "accepted" }))).toBe(
      "solved (no attempt records)",
    );
    expect(buildStoryDigest(item({ status: "failed", bucket: "failed" }))).toBe(
      "failed (no attempt records)",
    );
  });

  it("notes truncation when more attempts exist than the digest carries", () => {
    const digest = buildStoryDigest(
      item({
        attemptCount: 14,
        attemptDigest: [
          ev({ regime: "rans", validForPolar: true, converged: true }),
        ],
      }),
    );
    expect(digest).toBe("RANS ✓ (+13 more)");
  });
});

// ---------------------------------------------------------------------------
// timeline assembly
// ---------------------------------------------------------------------------
const attempt = (over: Partial<PointStoryAttempt>): PointStoryAttempt => ({
  id: "a1",
  regime: "rans",
  status: "done",
  validForPolar: false,
  converged: false,
  stalled: false,
  unsteady: false,
  firstOrderFallback: false,
  cl: null,
  cd: null,
  clCd: null,
  strouhal: null,
  error: null,
  qualityWarnings: [],
  engineCaseSlug: null,
  simJob: null,
  classification: null,
  createdAt: "2026-07-06T10:00:00.000Z",
  solvedAt: null,
  ...over,
});

function storyPayload(over: Partial<PointStoryPayload>): PointStoryPayload {
  return {
    point: {
      resultId: "r1",
      airfoilId: "af1",
      airfoilSlug: "naca0012",
      airfoilName: "NACA 0012",
      aoaDeg: 4,
      reynolds: 400000,
      mach: null,
      speed: 5.84,
      regime: "urans",
      status: "done",
      error: null,
      qualityWarnings: [],
      classification: null,
      revisionId: "rev1",
      campaignId: null,
      campaignName: null,
      conditionId: null,
      solvedAt: "2026-07-06T12:00:00.000Z",
      updatedAt: "2026-07-06T12:00:00.000Z",
      fidelity: null,
      reviewBucket: null,
      workDisposition: null,
      continuable: false,
      verify: null,
      ...(over.point ?? {}),
    },
    attempts: over.attempts ?? [],
    interruptions: over.interruptions ?? [],
    closure: over.closure ?? null,
  };
}

describe("assembleTimeline", () => {
  it("orders attempts + interruptions chronologically, then classification, then NOW", () => {
    const story = storyPayload({
      point: {
        classification: {
          state: "rejected",
          reasons: ["cl_out_of_family"],
          confidence: 0.9,
          classifierVersion: "v3",
        },
      } as never,
      attempts: [
        attempt({
          id: "late",
          regime: "urans",
          createdAt: "2026-07-06T11:00:00.000Z",
          solvedAt: "2026-07-06T11:00:00.000Z",
          validForPolar: true,
          converged: true,
        }),
        attempt({
          id: "early",
          regime: "rans",
          createdAt: "2026-07-06T09:00:00.000Z",
          solvedAt: "2026-07-06T09:00:00.000Z",
          stalled: true,
        }),
      ],
      interruptions: [
        {
          simJobId: "j1",
          engineJobId: "e1",
          wave: 1,
          jobKind: "sweep",
          campaignId: null,
          error: "worker restarted mid-solve; points released for re-solve",
          createdAt: "2026-07-06T10:00:00.000Z",
          finishedAt: "2026-07-06T10:00:00.000Z",
        },
      ],
      closure: {
        campaignId: "c1",
        campaignName: "camp",
        conditionId: "cond1",
        openAirfoils: 3,
        totalAirfoils: 12,
      },
    });
    const events = assembleTimeline(story);
    expect(events.map((e) => e.kind)).toEqual([
      "attempt",
      "interruption",
      "attempt",
      "classification",
      "now",
    ]);
    expect(events[0].attempt?.id).toBe("early");
    expect(events[1].title).toBe(
      "interrupted — worker restarted mid-solve; point released",
    );
    expect(events[1].tone).toBe("amber");
    expect(events[3].title).toContain("classified rejected");
    expect(events[3].detail).toContain("cl_out_of_family");
    // NOW node carries evidence counts + campaign closure context.
    expect(events[4].title).toContain("NOW");
    expect(events[4].detail).toContain("2 attempts · 1 interruption");
    expect(events[4].detail).toContain("open for 3 of 12 airfoils");
  });

  it("escalation semantics: stalled RANS is amber (normal), errors are red, valid is teal", () => {
    const events = assembleTimeline(
      storyPayload({
        attempts: [
          attempt({
            id: "s",
            stalled: true,
            createdAt: "2026-07-06T09:00:00.000Z",
          }),
          attempt({
            id: "t",
            regime: "urans",
            error: "URANS timed out",
            createdAt: "2026-07-06T10:00:00.000Z",
          }),
          attempt({
            id: "v",
            regime: "urans",
            validForPolar: true,
            converged: true,
            createdAt: "2026-07-06T11:00:00.000Z",
          }),
        ],
      }),
    );
    expect(events[0].tone).toBe("amber");
    expect(events[0].title).toContain("escalation evidence");
    expect(events[1].tone).toBe("red");
    expect(events[1].title).toContain("timeout");
    expect(events[2].tone).toBe("teal");
  });

  it("surfaces persisted quality warnings as the attempt's why-lines", () => {
    const events = assembleTimeline(
      storyPayload({
        attempts: [
          attempt({
            id: "w",
            regime: "urans",
            validForPolar: true,
            converged: true,
            qualityWarnings: [
              "URANS shedding unmeasurable: no dominant frequency",
            ],
          }),
        ],
      }),
    );
    expect(events[0].whyLines).toEqual([
      "URANS shedding unmeasurable: no dominant frequency",
    ]);
  });

  it("a bare point (no attempts/classification) still gets an honest NOW node", () => {
    const events = assembleTimeline(
      storyPayload({ point: { status: "pending" } as never }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("now");
    expect(events[0].detail).toContain("0 attempts");
  });
});

// ---------------------------------------------------------------------------
// formatBulkContinueOutcome — the one honest line the needs-review toolbar
// shows after a bulk resume (counts come straight from the server response).
// ---------------------------------------------------------------------------
describe("formatBulkContinueOutcome", () => {
  it("empty scope says so instead of pretending zero-of-zero was queued", () => {
    expect(
      formatBulkContinueOutcome({
        continuable: 0,
        created: 0,
        reused: 0,
        conflicted: 0,
      }),
    ).toBe(
      "nothing to resume — no unavailable point in this scope has restartable saved state",
    );
  });

  it("reports queued + already-open counts and the exclusion rule", () => {
    expect(
      formatBulkContinueOutcome({
        continuable: 12,
        created: 12,
        reused: 0,
        conflicted: 0,
      }),
    ).toBe("queued 12 · already open 0 — non-resumable rows are excluded");
  });

  it("idempotent replay shows every row as already open", () => {
    expect(
      formatBulkContinueOutcome({
        continuable: 5,
        created: 0,
        reused: 5,
        conflicted: 0,
      }),
    ).toBe("queued 0 · already open 5 — non-resumable rows are excluded");
  });

  it("conflicting open requests are counted honestly, never folded into queued", () => {
    expect(
      formatBulkContinueOutcome({
        continuable: 7,
        created: 4,
        reused: 2,
        conflicted: 1,
      }),
    ).toBe(
      "queued 4 · already open 2 · conflicting open request 1 — non-resumable rows are excluded",
    );
  });
});
