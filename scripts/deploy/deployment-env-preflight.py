#!/usr/bin/env python3
"""Validate the authoritative production deployment environment file."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import sys


REMOTE_EVIDENCE_KEYS = {
    "AIRFOILFOAM_EVIDENCE_BUCKET",
    "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY",
    "AIRFOILFOAM_CONTROL_PLANE_TOKEN",
}


def _read_remote_evidence_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line or raw_line.lstrip().startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        if key not in REMOTE_EVIDENCE_KEYS:
            continue
        if key in values:
            raise ValueError(
                f"deployment env line {line_number} duplicates {key}"
            )
        if value != value.strip():
            raise ValueError(
                f"deployment env line {line_number} gives {key} surrounding whitespace"
            )
        values[key] = value
    return values


def _validate_remote_evidence_auth(path: Path) -> None:
    values = _read_remote_evidence_values(path)
    bucket = values.get("AIRFOILFOAM_EVIDENCE_BUCKET", "")
    remote_only = values.get("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "").lower()
    if not bucket or remote_only not in {"1", "true", "yes", "on"}:
        return
    token = values.get("AIRFOILFOAM_CONTROL_PLANE_TOKEN", "")
    if (
        len(token) < 32
        or token[:1] in {"'", '"'}
        or token[-1:] in {"'", '"'}
        or any(character.isspace() for character in token)
    ):
        raise ValueError(
            "remote-only GCS evidence requires an unquoted, whitespace-free "
            "AIRFOILFOAM_CONTROL_PLANE_TOKEN of at least 32 characters"
        )


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(
                "unsafe OpenCFD v2606 recovery path: "
                f"state path contains symbolic-link component: {current}"
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-dir", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()

    app = args.app_dir.absolute()
    state = args.state_dir.absolute()
    env = args.env_file.absolute()
    if not state.is_absolute() or not env.is_absolute():
        raise ValueError("deployment state and environment paths must be absolute")
    _reject_symlink_components(state)
    state_target = state / ".env.deploy"
    metadata = env.lstat()
    if stat.S_ISREG(metadata.st_mode):
        # One-time pre-versioned migration accepts the live regular env inside
        # a real APP_DIR. Once APP_DIR is a release symlink, only the external
        # shared state file (or an exact symlink to it) is authoritative.
        if app.is_symlink() and env != state_target:
            raise ValueError("versioned deployment uses a non-authoritative env file")
    else:
        raise ValueError("deployment env must be a non-symlink regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError("deployment env must have exact mode 0600")
    if metadata.st_uid != os.geteuid():
        raise ValueError("deployment env must be owned by the deploying user")
    _validate_remote_evidence_auth(env)
    print(env.resolve(strict=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"deployment environment error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
