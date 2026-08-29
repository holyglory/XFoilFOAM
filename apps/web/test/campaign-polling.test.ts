import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("campaign polling", () => {
  it("never overlaps a slow request and resumes after the owner settles", () => {
    const source = readFileSync(
      resolve(process.cwd(), "components/admin/campaigns/usePoll.ts"),
      "utf8",
    );
    expect(source).toContain(
      "const inFlightRef = useRef<Promise<void> | null>(null)",
    );
    expect(source).toContain("if (inFlightRef.current) return");
    expect(source).toContain("inFlightRef.current = run");
    expect(source).toContain("if (inFlightRef.current === run)");
  });
});
