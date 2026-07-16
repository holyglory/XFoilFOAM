#!/usr/bin/env python3
"""Atomically point APP_DIR at a fully verified same-filesystem release."""

from __future__ import annotations

import argparse
import ctypes
import os
from pathlib import Path
import stat


AT_FDCWD = -100
RENAME_EXCHANGE = 2


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _exchange(left: Path, right: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        AT_FDCWD,
        os.fsencode(left),
        AT_FDCWD,
        os.fsencode(right),
        RENAME_EXCHANGE,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), f"{left} <-> {right}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--release", required=True, type=Path)
    parser.add_argument("--legacy-destination", required=True, type=Path)
    args = parser.parse_args()

    app = args.app.absolute()
    release = args.release.resolve(strict=True)
    legacy = args.legacy_destination.absolute()
    if not release.is_dir() or release.is_symlink():
        raise ValueError("release must be a real directory")
    if legacy.exists() or legacy.is_symlink():
        raise ValueError("legacy destination already exists")
    if app.parent.resolve(strict=True).stat().st_dev != release.stat().st_dev:
        raise ValueError("application link and release must be on the same filesystem")

    if app.is_symlink() or not app.exists():
        if app.exists() and not app.is_symlink():
            raise ValueError("application path has an unsupported type")
        temporary = app.parent / f".app-link.{os.getpid()}"
        if temporary.exists() or temporary.is_symlink():
            raise ValueError("temporary application link path already exists")
        temporary.symlink_to(release, target_is_directory=True)
        try:
            os.replace(temporary, app)
        finally:
            if temporary.is_symlink():
                temporary.unlink()
    else:
        metadata = app.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise ValueError("application path must be a directory or symbolic link")
        legacy.parent.mkdir(parents=True, exist_ok=True)
        if legacy.parent.stat().st_dev != release.stat().st_dev:
            raise ValueError("legacy release destination must be on the same filesystem")
        # Place the successor symlink directly at its final legacy path. One
        # exchange then leaves APP_DIR pointing at the new release and the old
        # application directory at its final retained location; no fallible
        # post-exchange rename can strand it at a random recovery pathname.
        legacy.symlink_to(release, target_is_directory=True)
        try:
            _exchange(legacy, app)
        except BaseException:
            if legacy.is_symlink():
                legacy.unlink()
            raise
    for directory in {app.parent.resolve(strict=True), legacy.parent.resolve(strict=True)}:
        _fsync_directory(directory)
    if app.resolve(strict=True) != release:
        raise RuntimeError("application link does not resolve to the verified release")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
