import { describe, expect, it } from "vitest";

import {
  databaseMemberAssociationsSha256,
  manifestMemberSetSha256,
  parseEvidenceManifest,
  type EvidenceManifestEntry,
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

const artifactIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const associations = entries.map((entry, index) => ({
  ...entry,
  artifactId: artifactIds[index]!,
}));

describe("evidence manifest member-set identity", () => {
  it("MUST-CATCH: matches the engine's UTF-8 byte ordering when uppercase VTK and lowercase paths coexist", () => {
    expect(manifestMemberSetSha256(entries)).toBe(
      "4f59a7539f23473dcd28028dc9bf7c9a1c20c51af216be671b38b62422a89523",
    );
    expect(databaseMemberAssociationsSha256(associations)).toBe(
      "ba5687080d87e01f8fb43762116b3519b592524e342b953d699449303fe33da8",
    );
  });

  it("is independent of the database query or manifest entry order", () => {
    expect(manifestMemberSetSha256([...entries].reverse())).toBe(
      manifestMemberSetSha256(entries),
    );
    expect(databaseMemberAssociationsSha256([...associations].reverse())).toBe(
      databaseMemberAssociationsSha256(associations),
    );
  });

  it("retains an exact engine role and rejects malformed role provenance", () => {
    const member = {
      path: "openfoam/mesh_evidence/logs/log.blockMesh",
      role: "mesh_evidence",
      sha256: "d".repeat(64),
      byteSize: 42,
    };
    expect(
      parseEvidenceManifest(Buffer.from(JSON.stringify({ files: [member] })))
        .bundled,
    ).toEqual([member]);
    for (const role of [null, "", " mesh_evidence", "MeshEvidence", "a/b"]) {
      expect(() =>
        parseEvidenceManifest(
          Buffer.from(JSON.stringify({ files: [{ ...member, role }] })),
        ),
      ).toThrow(/lower-snake-case evidence role/);
    }
  });
});
