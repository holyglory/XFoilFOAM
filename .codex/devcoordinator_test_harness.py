#!/usr/bin/env python3
"""Self-contained DevCoordinator test entrypoints for XFoilFOAM repositories."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
UV = Path(
    "/opt/devcoordinator/toolchains/uv/"
    "ac1d09115324ddc785f49a597106cfa83da4033a21d28d915414973ec55aea96/uv"
)
MAX_DIAGNOSTIC_BYTES = 512 * 1024


def _events_path() -> Path:
    raw = os.environ.get("DEVCOORDINATOR_TEST_EVENTS")
    if not raw:
        raise RuntimeError("DEVCOORDINATOR_TEST_EVENTS is unavailable")
    path = Path(raw)
    if not path.is_absolute():
        raise RuntimeError("DEVCOORDINATOR_TEST_EVENTS must be absolute")
    return path


def _bounded(value: bytes) -> str:
    return value[-MAX_DIAGNOSTIC_BYTES:].decode("utf-8", errors="replace")


def _run(case_id: str, name: str, argv: list[str]) -> int:
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        cwd=ROOT,
        env=dict(os.environ),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    duration = time.monotonic() - started
    output = _bounded(completed.stdout)
    if completed.returncode != 0:
        print(f"[{case_id}] failed with exit {completed.returncode}\n{output}")
    elif output:
        print(f"[{case_id}] passed\n{output[-8192:]}")
    event = {
        "case_id": case_id,
        "name": name,
        "status": "passed" if completed.returncode == 0 else "failed",
        "duration_seconds": duration,
        "location": ".codex/devcoordinator_test_harness.py",
    }
    if completed.returncode != 0:
        event["message"] = output[-8192:] or f"exit {completed.returncode}"
    with _events_path().open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, sort_keys=True) + "\n")
    return completed.returncode


def _python_suite() -> int:
    if not UV.is_file():
        event = {
            "case_id": "python-toolchain",
            "name": "pinned uv toolchain",
            "status": "failed",
            "duration_seconds": 0,
            "location": str(UV),
            "message": "the pinned server-wide uv toolchain is unavailable",
        }
        _events_path().write_text(json.dumps(event, sort_keys=True) + "\n", encoding="utf-8")
        return 1
    sync = _run(
        "python-dependencies",
        "locked Python dependencies",
        [str(UV), "sync", "--frozen", "--python", "/usr/bin/python3"],
    )
    if sync != 0:
        return sync
    return _run(
        "python-unit",
        "Python unit tests",
        [
            str(ROOT / ".venv/bin/python"),
            "-m",
            "pytest",
            "-m",
            "not integration",
            "tests",
        ],
    )


def _node_suite() -> int:
    install = _run(
        "node-dependencies",
        "locked Node dependencies",
        ["/usr/bin/corepack", "pnpm", "install", "--frozen-lockfile"],
    )
    if install != 0:
        return install
    commands = [
        (
            "core-unit",
            "Core unit tests",
            ["/usr/bin/corepack", "pnpm", "--filter", "@aerodb/core", "test"],
        ),
        (
            "web-unit",
            "Web unit tests",
            ["/usr/bin/corepack", "pnpm", "--filter", "@aerodb/web", "test"],
        ),
        (
            "workspace-typecheck",
            "Workspace type checking",
            ["/usr/bin/corepack", "pnpm", "run", "typecheck"],
        ),
        (
            "web-build",
            "Web production build",
            ["/usr/bin/corepack", "pnpm", "--filter", "@aerodb/web", "build"],
        ),
    ]
    if (ROOT / "packages/engine-client/package.json").is_file():
        commands.insert(
            1,
            (
                "engine-client-unit",
                "Engine client unit tests",
                [
                    "/usr/bin/corepack",
                    "pnpm",
                    "--filter",
                    "@aerodb/engine-client",
                    "test",
                ],
            ),
        )
    result = 0
    for case_id, name, argv in commands:
        result = max(result, _run(case_id, name, argv))
    return result


def main() -> int:
    _events_path().unlink(missing_ok=True)
    if len(sys.argv) != 2:
        raise SystemExit("usage: devcoordinator_test_harness.py python-suite|node-suite")
    if sys.argv[1] == "python-suite":
        return _python_suite()
    if sys.argv[1] == "node-suite":
        return _node_suite()
    raise SystemExit(f"unknown suite: {sys.argv[1]}")


if __name__ == "__main__":
    raise SystemExit(main())
