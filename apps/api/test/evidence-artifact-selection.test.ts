import { describe, expect, it } from "vitest";

import { selectVisibleEvidenceArtifacts } from "../src/evidence-artifacts";

describe("current evidence archive selection", () => {
  it("hides superseded bundle encodings while preserving every logical member", () => {
    const rows = [
      { id: "legacy-engine", kind: "engine_bundle" },
      { id: "legacy-alias", kind: "openfoam_bundle" },
      { id: "canonical-zstd", kind: "engine_bundle" },
      { id: "manifest", kind: "manifest" },
      { id: "vtk", kind: "vtk_window" },
    ];
    expect(selectVisibleEvidenceArtifacts(rows, "canonical-zstd")).toEqual([
      { id: "canonical-zstd", kind: "engine_bundle" },
      { id: "manifest", kind: "manifest" },
      { id: "vtk", kind: "vtk_window" },
    ]);
  });

  it("preserves legacy reads before an archive generation is registered", () => {
    const rows = [{ id: "legacy", kind: "openfoam_bundle" }];
    expect(selectVisibleEvidenceArtifacts(rows, null)).toEqual(rows);
  });
});
