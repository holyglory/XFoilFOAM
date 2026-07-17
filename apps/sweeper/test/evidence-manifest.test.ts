import { describe, expect, it } from "vitest";

import {
  type EvidenceManifestEntry,
  manifestMemberSetSha256,
} from "../src/evidence-manifest";

const entries: EvidenceManifestEntry[] = [
  {
    path: "evidence_manifest.json",
    sha256: "a".repeat(64),
    byteSize: 101,
  },
  {
    path: "openfoam/constant/polyMesh/points",
    sha256: "b".repeat(64),
    byteSize: 202,
  },
  {
    path: "VTK/case_9000/internal.vtu",
    sha256: "c".repeat(64),
    byteSize: 303,
  },
];

describe("evidence manifest member-set identity", () => {
  it("MUST-CATCH: matches the engine's UTF-8 byte ordering when uppercase VTK and lowercase paths coexist", () => {
    expect(manifestMemberSetSha256(entries)).toBe(
      "4f59a7539f23473dcd28028dc9bf7c9a1c20c51af216be671b38b62422a89523",
    );
  });

  it("is independent of the database query or manifest entry order", () => {
    expect(manifestMemberSetSha256([...entries].reverse())).toBe(
      manifestMemberSetSha256(entries),
    );
  });
});
