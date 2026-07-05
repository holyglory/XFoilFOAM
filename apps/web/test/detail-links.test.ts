// Pinned-detail evidence links (campaign spec §11): admin job cards and the
// campaign cell panel must deep-link /airfoils/<slug>?revision=<uuid> when a
// job carries a single setup revision, and stay unpinned when it does not.
// MUST-CATCH: fails when airfoilDetailHref stops appending the pin — the
// production-reported broken journey (finished campaign job → detail page →
// zero polar groups, because campaign presets are disabled by design).
// Also covers the ?flog=1 finished-log URL round-trip (state-loss defect).

import { describe, expect, it } from "vitest";

import { airfoilDetailHref, parsePinnedRevisionParam } from "../lib/detail-links";
import { isFinishedLogOpen, withFinishedLogParam } from "../lib/finished-log-param";

const REV = "01234567-89ab-4cde-8f01-23456789abcd";

describe("airfoilDetailHref (admin evidence links pin the setup revision)", () => {
  it("pins ?revision=<uuid> when the job carries a single revision", () => {
    expect(airfoilDetailHref("clarky", REV)).toBe(`/airfoils/clarky?revision=${REV}`);
  });

  it("stays unpinned for null/undefined (multi-revision batched jobs)", () => {
    expect(airfoilDetailHref("clarky", null)).toBe("/airfoils/clarky");
    expect(airfoilDetailHref("clarky")).toBe("/airfoils/clarky");
  });

  it("refuses to pin non-UUID values and encodes the slug", () => {
    expect(airfoilDetailHref("clarky", "not-a-uuid")).toBe("/airfoils/clarky");
    expect(airfoilDetailHref("a b", REV)).toBe(`/airfoils/a%20b?revision=${REV}`);
  });
});

describe("parsePinnedRevisionParam (public page ?revision= validation)", () => {
  it("accepts a UUID-shaped string (normalized lowercase)", () => {
    expect(parsePinnedRevisionParam(REV.toUpperCase())).toBe(REV);
  });

  it("ignores arrays, garbage, empty, and injection-shaped values", () => {
    expect(parsePinnedRevisionParam([REV, REV])).toBeNull();
    expect(parsePinnedRevisionParam("'; DROP TABLE results; --")).toBeNull();
    expect(parsePinnedRevisionParam("")).toBeNull();
    expect(parsePinnedRevisionParam(undefined)).toBeNull();
    expect(parsePinnedRevisionParam(null)).toBeNull();
  });
});

describe("finished-log URL param round-trip (?flog=1)", () => {
  it("open sets flog=1 preserving other params; close removes only flog", () => {
    expect(withFinishedLogParam("?section=queue", true)).toBe("?section=queue&flog=1");
    expect(withFinishedLogParam("?section=queue&flog=1", false)).toBe("?section=queue");
    expect(withFinishedLogParam("", true)).toBe("?flog=1");
    expect(withFinishedLogParam("?flog=1", false)).toBe("");
  });

  it("isFinishedLogOpen reads both raw and ?-prefixed search strings", () => {
    expect(isFinishedLogOpen("?section=queue&flog=1")).toBe(true);
    expect(isFinishedLogOpen("section=queue&flog=1")).toBe(true);
    expect(isFinishedLogOpen("?section=queue")).toBe(false);
    expect(isFinishedLogOpen("?flog=0")).toBe(false);
  });

  it("round-trips: open → parse → close → parse", () => {
    const opened = withFinishedLogParam("?section=queue&tab=background", true);
    expect(isFinishedLogOpen(opened)).toBe(true);
    const closed = withFinishedLogParam(opened, false);
    expect(isFinishedLogOpen(closed)).toBe(false);
    expect(closed).toBe("?section=queue&tab=background");
  });
});
