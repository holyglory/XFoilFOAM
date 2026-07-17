import { describe, expect, it } from "vitest";

import {
  manifestMemberSetSha256,
  parseEvidenceManifest,
} from "../src/evidence-manifest";

describe("cross-runtime evidence manifest identity", () => {
  it("uses Python-compatible code-point ordering for mixed-case paths", () => {
    const manifest = Buffer.from(
      '{"schemaVersion":2,"bundleExcludes":[],"files":[' +
        '{"path":"openfoam/a","sha256":"' +
        "b".repeat(64) +
        '","byteSize":20},' +
        '{"path":"VTK/Z.vtu","sha256":"' +
        "a".repeat(64) +
        '","byteSize":10},' +
        '{"path":"Alpha/x","sha256":"' +
        "c".repeat(64) +
        '","byteSize":30}]}',
      "utf8",
    );

    const parsed = parseEvidenceManifest(manifest);

    expect(parsed.memberSet.map((entry) => entry.path)).toEqual([
      "Alpha/x",
      "VTK/Z.vtu",
      "evidence_manifest.json",
      "openfoam/a",
    ]);
    expect(manifestMemberSetSha256(parsed.memberSet)).toBe(
      "651f22e3374d5e34361874add2aad3ba11bf6edc8d4f533812c64544acb82d98",
    );
  });
});
