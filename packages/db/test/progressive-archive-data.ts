import { createHash } from "node:crypto";
import { parseEvidenceManifest } from "../src/evidence-archive-manifest";

const forceCoefficients = Buffer.from("0 0.4 0.03 0\n");
export const progressiveArchiveManifestBytes = Buffer.from(
  JSON.stringify({
    files: [
      {
        path: "forceCoeffs.dat",
        role: "force_coefficients",
        byteSize: forceCoefficients.byteLength,
        sha256: createHash("sha256").update(forceCoefficients).digest("hex"),
      },
    ],
  }),
);
export const progressiveArchiveManifestSha256 = createHash("sha256")
  .update(progressiveArchiveManifestBytes)
  .digest("hex");
export const progressiveArchiveMembers = parseEvidenceManifest(
  progressiveArchiveManifestBytes,
).memberSet;
