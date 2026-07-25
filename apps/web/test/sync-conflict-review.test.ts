import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "components/admin/AdminConsole.tsx"),
  "utf8",
);

const reviewSection = source.slice(
  source.indexOf("REMOTE REVIEW"),
  source.indexOf("function QueueDashboard"),
);

describe("remote import review", () => {
  it("leads with an airfoil and operating-point summary instead of raw identity keys", () => {
    expect(reviewSection).toContain("conflict.review.title");
    expect(reviewSection).toContain("conflict.review.context");
    expect(reviewSection).not.toMatch(
      /SYNC_DATA_TYPE_LABELS\[conflict\.dataType\][\s\S]{0,80}conflict\.naturalKey/,
    );
  });

  it("does not offer the impossible polar promotion action", () => {
    expect(reviewSection).toContain("conflict.canPromote");
    expect(reviewSection).toContain("Use incoming");
    expect(reviewSection).toContain("Keep current");
    expect(reviewSection).not.toMatch(/>\s*promote\s*</);
    expect(reviewSection).not.toMatch(/>\s*archive\s*</);
  });

  it("keeps technical identity and coefficient comparison behind disclosure", () => {
    expect(reviewSection).toContain("<details");
    expect(reviewSection).toContain("Compare evidence");
    expect(reviewSection).toContain("conflict.review.incoming");
    expect(reviewSection).toContain("conflict.review.current");
    expect(reviewSection).toContain("conflict.naturalKey");
  });
});
