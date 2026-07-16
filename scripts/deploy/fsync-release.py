#!/usr/bin/env python3
"""Durably flush a verified release tree and its parent directory."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat


def _fsync(path: Path, *, directory: bool = False) -> None:
    flags = os.O_RDONLY | (os.O_DIRECTORY if directory else 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--parent", required=True, type=Path)
    args = parser.parse_args()

    release = args.release.resolve(strict=True)
    parent = args.parent.resolve(strict=True)
    if release.parent != parent or not release.is_dir() or release.is_symlink():
        raise ValueError("release must be a real direct child of its release parent")

    directories: list[Path] = []
    for current, directory_names, file_names in os.walk(
        release, topdown=True, followlinks=False
    ):
        current_path = Path(current)
        directories.append(current_path)
        for name in directory_names:
            path = current_path / name
            metadata = path.lstat()
            if not stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
                raise ValueError(f"unsupported release entry: {path}")
        for name in file_names:
            path = current_path / name
            metadata = path.lstat()
            if stat.S_ISREG(metadata.st_mode):
                _fsync(path)
            elif not stat.S_ISLNK(metadata.st_mode):
                raise ValueError(f"unsupported release entry: {path}")
    for directory in reversed(directories):
        _fsync(directory, directory=True)
    # The release rename is not durable until its parent directory entry is.
    _fsync(parent, directory=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
