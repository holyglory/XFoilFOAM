import { describe, expect, it } from "vitest";

import { isGcsResumableUploadUrl } from "../src/gcs-resumable-url";

describe("GCS resumable capability validation", () => {
  const expected = {
    bucket: "evidence-bucket",
    objectKey: "solver-evidence/v1/sha256/aa/abc.tar.zst",
  };
  const query =
    "uploadType=resumable&name=solver-evidence%2Fv1%2Fsha256%2Faa%2Fabc.tar.zst&upload_id=opaque";
  it("accepts current JSON API session hosts and exact upload_id shape", () => {
    expect(
      isGcsResumableUploadUrl(
        `https://storage.googleapis.com/upload/storage/v1/b/evidence-bucket/o?${query}`,
        expected,
      ),
    ).toBe(true);
    expect(
      isGcsResumableUploadUrl(
        `https://www.googleapis.com/upload/storage/v1/b/evidence-bucket/o?${query}`,
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
  ])("rejects non-GCS or ambiguous capabilities: %s", (value) => {
    expect(isGcsResumableUploadUrl(value, expected)).toBe(false);
  });
});
