#!/usr/bin/env python3
"""Create or verify the exact source payload promoted to the production VPS."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


SCHEMA_VERSION = 1
REVISION_RE = re.compile(r"[0-9a-f]{40}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
MANIFEST_NAME = ".deployment-source.json"
EXCLUDED_FILE_NAMES = {".env", ".env.deploy", ".env.local", MANIFEST_NAME}
EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".github",
    ".ssh",
    "node_modules",
    ".next",
    ".next-build",
    ".pnpm-store",
    "coverage",
    "data",
    "VTK",
    "postProcessing",
    ".codex-artifacts",
    ".codex-db-backups",
    "test-results",
}


def _directory_excluded(relative: Path) -> bool:
    return any(
        part in EXCLUDED_DIRECTORY_NAMES or part.startswith("processor")
        for part in relative.parts
    )


def _excluded(relative: Path) -> bool:
    if relative.name in EXCLUDED_FILE_NAMES:
        return True
    return _directory_excluded(relative.parent)


def _source_entries(root: Path) -> list[Path]:
    entries: list[Path] = []
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        retained_directories: list[str] = []
        for name in sorted(directory_names):
            path = current_path / name
            relative = path.relative_to(root)
            if _directory_excluded(relative):
                continue
            if path.is_symlink():
                entries.append(path)
                continue
            retained_directories.append(name)
        directory_names[:] = retained_directories
        for name in sorted(file_names):
            path = current_path / name
            if not _excluded(path.relative_to(root)):
                entries.append(path)
    return sorted(entries, key=lambda item: item.relative_to(root).as_posix())


def _source_tree(root: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    count = 0
    for path in _source_entries(root):
        relative = path.relative_to(root)
        metadata = path.lstat()
        relative_bytes = relative.as_posix().encode("utf-8")
        executable = b"1" if metadata.st_mode & 0o111 else b"0"
        if stat.S_ISREG(metadata.st_mode):
            kind = b"file"
            payload = path.read_bytes()
        elif stat.S_ISLNK(metadata.st_mode):
            kind = b"symlink"
            payload = os.readlink(path).encode("utf-8")
        else:
            raise ValueError(f"unsupported source entry: {relative.as_posix()}")
        for field in (kind, relative_bytes, executable, str(len(payload)).encode("ascii"), payload):
            digest.update(str(len(field)).encode("ascii"))
            digest.update(b":")
            digest.update(field)
        count += 1
    return digest.hexdigest(), count


def _load_manifest(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or set(payload) != {
        "schemaVersion",
        "sourceRevision",
        "sourceTreeSha256",
        "fileCount",
    }:
        raise ValueError("deployment manifest has an unexpected schema")
    if payload["schemaVersion"] != SCHEMA_VERSION:
        raise ValueError("deployment manifest schema version is unsupported")
    revision = payload["sourceRevision"]
    tree_sha = payload["sourceTreeSha256"]
    file_count = payload["fileCount"]
    if not isinstance(revision, str) or REVISION_RE.fullmatch(revision) is None:
        raise ValueError("deployment manifest source revision is invalid")
    if not isinstance(tree_sha, str) or SHA256_RE.fullmatch(tree_sha) is None:
        raise ValueError("deployment manifest source tree hash is invalid")
    if type(file_count) is not int or file_count < 1:
        raise ValueError("deployment manifest file count is invalid")
    return payload


def _write_manifest(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as temporary:
            json.dump(payload, temporary, sort_keys=True, separators=(",", ":"))
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--create", action="store_true")
    operation.add_argument("--verify", action="store_true")
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--revision")
    args = parser.parse_args()

    root = args.root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("deployment source root is not a directory")
    manifest = args.manifest.resolve()
    try:
        manifest.relative_to(root)
    except ValueError as exc:
        raise ValueError("deployment manifest must be inside the source root") from exc

    tree_sha, file_count = _source_tree(root)
    if args.create:
        revision = (args.revision or "").lower()
        if REVISION_RE.fullmatch(revision) is None:
            raise ValueError("--revision must be an exact 40-character Git commit SHA")
        payload: dict[str, object] = {
            "schemaVersion": SCHEMA_VERSION,
            "sourceRevision": revision,
            "sourceTreeSha256": tree_sha,
            "fileCount": file_count,
        }
        _write_manifest(manifest, payload)
    else:
        if args.revision is not None:
            raise ValueError("--revision is valid only with --create")
        payload = _load_manifest(manifest)
        if payload["sourceTreeSha256"] != tree_sha or payload["fileCount"] != file_count:
            raise ValueError(
                "deployment source does not match its manifest: "
                f"expected {payload['sourceTreeSha256']}/{payload['fileCount']}, "
                f"found {tree_sha}/{file_count}"
            )

    print(
        f"{payload['sourceRevision']}\t{payload['sourceTreeSha256']}\t{payload['fileCount']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"deployment source manifest error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
