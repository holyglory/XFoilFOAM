import { createHash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;

export interface EvidenceManifestEntry {
  path: string;
  sha256: string;
  byteSize: number;
}

export interface ParsedEvidenceManifest {
  bundled: EvidenceManifestEntry[];
  excluded: EvidenceManifestEntry[];
  bundleExcludes: string[];
  memberSet: EvidenceManifestEntry[];
}

function exactSafeRelative(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a safe exact relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe exact relative path`);
  }
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseEvidenceManifest(
  manifestBytes: Buffer,
): ParsedEvidenceManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`evidence manifest is invalid JSON: ${String(error)}`);
  }
  const manifest = object(decoded, "evidence manifest");
  if (!Array.isArray(manifest.files)) {
    throw new Error("evidence manifest files must be an array");
  }
  const rawExcludes = manifest.bundleExcludes ?? [];
  if (!Array.isArray(rawExcludes)) {
    throw new Error("evidence manifest bundleExcludes must be an array");
  }
  const excludedRoots = new Set<string>();
  for (const [index, raw] of rawExcludes.entries()) {
    const root = exactSafeRelative(
      raw,
      `evidence manifest bundleExcludes ${index}`,
    );
    if (root.includes("/")) {
      throw new Error("bundleExcludes entries must be top-level names");
    }
    if (excludedRoots.has(root)) {
      throw new Error(`duplicate evidence bundle exclusion ${root}`);
    }
    excludedRoots.add(root);
  }

  const entries = new Map<string, EvidenceManifestEntry>();
  for (const [index, raw] of manifest.files.entries()) {
    const entry = object(raw, `evidence manifest file ${index}`);
    const path = exactSafeRelative(
      entry.path,
      `evidence manifest file ${index} path`,
    );
    if (entries.has(path)) {
      throw new Error(`evidence manifest contains duplicate member path ${path}`);
    }
    if (
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    ) {
      throw new Error(`evidence manifest file ${index} sha256 is malformed`);
    }
    if (
      typeof entry.byteSize !== "number" ||
      !Number.isSafeInteger(entry.byteSize) ||
      entry.byteSize < 0
    ) {
      throw new Error(
        `evidence manifest file ${index} byteSize must be a non-negative safe integer`,
      );
    }
    entries.set(path, {
      path,
      sha256: entry.sha256,
      byteSize: entry.byteSize,
    });
  }
  const ordered = [...entries.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const bundled = ordered.filter(
    (entry) => !excludedRoots.has(entry.path.split("/", 1)[0]!),
  );
  const excluded = ordered.filter((entry) =>
    excludedRoots.has(entry.path.split("/", 1)[0]!),
  );
  const manifestEntry: EvidenceManifestEntry = {
    path: "evidence_manifest.json",
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    byteSize: manifestBytes.byteLength,
  };
  return {
    bundled,
    excluded,
    bundleExcludes: [...excludedRoots].sort(),
    memberSet: [manifestEntry, ...bundled].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  };
}

export function manifestMemberSetSha256(
  entries: ReadonlyArray<EvidenceManifestEntry>,
): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
    hash.update(String(entry.byteSize));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function databaseMemberAssociationsSha256(
  entries: ReadonlyArray<EvidenceManifestEntry & { artifactId: string }>,
): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.artifactId);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
    hash.update(String(entry.byteSize));
    hash.update("\n");
  }
  return hash.digest("hex");
}
