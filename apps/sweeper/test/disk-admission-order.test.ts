import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("disk admission tick ordering", () => {
  it("publishes the disk snapshot before slow engine reconciliation", () => {
    const loopSource = readFileSync(
      fileURLToPath(new URL("../src/loop.ts", import.meta.url)),
      "utf8",
    );
    const tickStart = loopSource.indexOf("export async function tick(");
    const diskRefresh = loopSource.indexOf(
      "refreshDiskAdmission(db, engine)",
      tickStart,
    );
    const reconciliation = loopSource.indexOf(
      "await reconcile(db, engine, reconcileOptions)",
      tickStart,
    );

    expect(tickStart).toBeGreaterThanOrEqual(0);
    expect(diskRefresh).toBeGreaterThan(tickStart);
    expect(reconciliation).toBeGreaterThan(diskRefresh);
  });
});
