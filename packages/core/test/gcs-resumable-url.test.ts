import { describe, expect, it } from "vitest";

import { isGcsResumableUploadUrl } from "../src/gcs-resumable-url";

describe("GCS resumable capability validation", () => {
  const expected = {
    bucket: "evidence-bucket",
    objectKey: "solver-evidence/v1/sha256/aa/abc.tar.zst",
  };
  const legacyNamedQuery =
    "uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=opaque&ifGenerationMatch=0";
  const createOnlyQuery =
    "uploadType=resumable&upload_id=opaque&ifGenerationMatch=0";
  it("accepts current create-only JSON API session shapes", () => {
    expect(
      isGcsResumableUploadUrl(
        `https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?${createOnlyQuery}`,
        expected,
      ),
    ).toBe(true);
    expect(
      isGcsResumableUploadUrl(
        `https://www.googleapis.com/upload/storage/v1/b/evidence-bucket/o?${legacyNamedQuery}`,
        expected,
      ),
    ).toBe(true);
  });

  it.each([
    "https://user:pass@storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x#fragment",
    "https://storage.googleapis.com:444/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x",
    "https://storage.googleapis.com/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x",
    "https://storage.cloud.google.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x",
    "https://evil.example/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x&upload_id=y",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=&extra=x",
    "https://storage.googleapis.com/upload/storage/v1/b/other/o?uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=x",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=other&upload_id=x",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&upload_id=x",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&upload_id=x&ifGenerationMatch=1",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&upload_id=x&ifGenerationMatch=0&unexpected=y",
    "https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?uploadType=resumable&name=other&upload_id=x&ifGenerationMatch=0",
  ])("rejects non-GCS or ambiguous capabilities: %s", (value) => {
    expect(isGcsResumableUploadUrl(value, expected)).toBe(false);
  });
});
