const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

// A production URANS attempt can contain thousands of immutable field and
// media artifacts. Limits therefore bound disk exposure and malformed input
// without imposing the multipart plugin's much smaller convenience defaults.
export const SYNC_POLAR_MULTIPART_MAX_FILES = positiveIntegerEnv(
  "SYNC_POLAR_MULTIPART_MAX_FILES",
  8_192,
);
export const SYNC_POLAR_MULTIPART_MAX_FILE_BYTES = positiveIntegerEnv(
  "SYNC_POLAR_MULTIPART_MAX_FILE_BYTES",
  GIB,
);
export const SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES = positiveIntegerEnv(
  "SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES",
  16 * GIB,
);
export const SYNC_POLAR_MULTIPART_MIN_FREE_BYTES = positiveIntegerEnv(
  "SYNC_POLAR_MULTIPART_MIN_FREE_BYTES",
  2 * GIB,
);
export const SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES = positiveIntegerEnv(
  "SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES",
  32 * MIB,
);
// Busboy must yield a slightly oversized field so the route can report the
// logical manifest quota as 413 instead of its generic invalid-JSON 406.
export const SYNC_POLAR_MULTIPART_MANIFEST_PARSER_BYTES =
  SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES + 64 * 1024;
export const SYNC_POLAR_MULTIPART_MAX_FIELDS = 4;
export const SYNC_POLAR_MULTIPART_MAX_PARTS =
  SYNC_POLAR_MULTIPART_MAX_FILES + SYNC_POLAR_MULTIPART_MAX_FIELDS;
