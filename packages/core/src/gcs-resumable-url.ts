const GCS_RESUMABLE_HOSTS = new Set([
  "storage.googleapis.com",
  "www.googleapis.com",
]);

/** Validate the opaque JSON-API resumable capability before any outbound
 * request. This intentionally accepts only current Google Cloud Storage
 * upload-session URLs, not arbitrary HTTPS destinations. */
export function isGcsResumableUploadUrl(
  value: string,
  expected: { bucket: string; objectKey: string },
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !GCS_RESUMABLE_HOSTS.has(url.hostname)
  )
    return false;
  const path = url.pathname.match(/^\/upload\/storage\/v1\/b\/([^/]+)\/o$/);
  if (!path) return false;
  let bucket: string;
  try {
    bucket = decodeURIComponent(path[1]!);
  } catch {
    return false;
  }
  const allowed = new Set(["uploadType", "name", "upload_id"]);
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !allowed.has(key))) return false;
  const uploadTypes = url.searchParams.getAll("uploadType");
  const names = url.searchParams.getAll("name");
  const uploadIds = url.searchParams.getAll("upload_id");
  return (
    bucket === expected.bucket &&
    uploadTypes.length === 1 &&
    uploadTypes[0] === "resumable" &&
    names.length === 1 &&
    names[0] === expected.objectKey &&
    uploadIds.length === 1 &&
    uploadIds[0]!.length > 0
  );
}
