"""Run the pinned recovery graph on GitHub's disposable CI runner.

This produces GitHub Actions evidence, never a Coordinator receipt. The two
DEVCOORDINATOR_* path variables below only adapt existing reporters/scratch use.
No Coordinator identity, admission, qualification or production access is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import tomllib
import traceback


REVISION = "74a9991fde7a2bba656d391df3e69fa4f12a45b2"
BASELINE = "c5abb7587eba4c04e431056e1d3cddeeb76211b4"
REGRESSION = REVISION
BASELINE_REF = "refs/heads/codex/ingestion-lock-regression-source-20261110"
MODES = {
    "types": ["workspace-types", "retention-test-types"],
    "database": [
        "schema", "seed", "report-contracts", "retention-contract",
        "report-progress-poll-services", "progress-selection-regressions", "settlement-campaign-regressions",
        "campaign-lock-order-and-guards", "old-source-lock-regressions",
    ],
    "maintenance": ["maintenance-contracts"],
}


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def git(source: Path, *arguments: str) -> str:
    return subprocess.check_output(["git", *arguments], cwd=source, text=True).strip()


def identity(source: Path) -> dict:
    head = git(source, "rev-parse", "HEAD")
    if head != REVISION:
        raise ValueError(f"Functional checkout is {head}, expected {REVISION}")
    subprocess.run(["git", "diff", "--exit-code", "--quiet", "HEAD"], cwd=source, check=True)
    listing = subprocess.check_output(["git", "ls-tree", "-r", "-l", "-z", "HEAD"], cwd=source)
    records = []
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        header, name = entry.split(b"\t", 1)
        mode, kind, blob, size = header.decode().split()
        if kind != "blob":
            raise ValueError("Functional source must contain only tracked blobs")
        path = source / os.fsdecode(name)
        payload = os.fsencode(os.readlink(path)) if mode == "120000" else path.read_bytes()
        actual = hashlib.sha1(f"blob {len(payload)}\0".encode() + payload).hexdigest()
        if actual != blob or len(payload) != int(size):
            raise ValueError(f"Functional blob changed: {os.fsdecode(name)}")
        if mode != "120000" and bool(path.stat().st_mode & 0o111) != (mode == "100755"):
            raise ValueError(f"Functional executable mode changed: {os.fsdecode(name)}")
        records.append({"path": os.fsdecode(name), "git_blob": blob, "mode": mode,
                        "bytes": len(payload), "sha256": sha256(payload)})
    return {"revision": head, "git_tree": git(source, "rev-parse", "HEAD^{tree}"),
            "tracked_inventory_sha256": sha256(listing), "tracked_files": len(records),
            "lockfile_sha256": sha256((source / "pnpm-lock.yaml").read_bytes()), "files": records}


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def normalize_corepack() -> None:
    # The pinned negative helper uses /usr/bin/corepack. Install no replacement
    # binary and never overwrite an existing target on the ephemeral runner.
    located = shutil.which("corepack")
    if not located:
        raise ValueError("Node 22 Corepack is required")
    executable = Path(located).resolve(strict=True)
    target = Path("/usr/bin/corepack")
    if not target.exists() and not target.is_symlink():
        subprocess.run(["sudo", "ln", "-s", "--", str(executable), str(target)], check=True)
    if target.resolve(strict=True) != executable:
        raise ValueError("Existing /usr/bin/corepack is not the selected Node Corepack")


def execute(source: Path, output: Path, name: str, command: list[str], timeout: int,
            environment: dict[str, str]) -> dict:
    directory = output / name
    directory.mkdir()
    env = {**environment, "DEVCOORDINATOR_DIAGNOSTICS_DIR": str(directory)}
    started = time.monotonic()
    log = directory / "command.log"
    print(json.dumps({"check": name, "state": "started", "timeout_seconds": timeout}), flush=True)
    try:
        with log.open("w") as stream:
            process = subprocess.Popen(command, cwd=source, env=env, stdout=stream,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
                raise
        code = process.returncode
        status = "passed" if code == 0 else "failed"
    except subprocess.TimeoutExpired:
        code, status = None, "timed_out"
    record = {"name": name, "status": status, "exit_code": code,
              "elapsed_seconds": round(time.monotonic() - started, 3),
              "command": command, "log": str(log.relative_to(output)),
              "log_sha256": sha256(log.read_bytes())}
    write_json(directory / "result.json", record)
    if status != "passed":
        print("\n".join(log.read_text(errors="replace").splitlines()[-80:]), flush=True)
    print(json.dumps(record), flush=True)
    return record


def run(mode: str, source: Path, output: Path) -> int:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("This harness runs only on GitHub's ephemeral Actions runner")
    output.mkdir(parents=True, exist_ok=False)
    report = {"provider": "github-actions", "coordinator_qualification": False,
              "mode": mode, "functional_revision": REVISION,
              "ci_revision": os.environ["GITHUB_SHA"], "github_run_id": os.environ["GITHUB_RUN_ID"],
              "github_run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "checks": [], "status": "failed"}
    try:
        before = identity(source)
        write_json(output / "source-identity-before.json", before)
        graph = tomllib.loads((source / ".devcoordinator.toml").read_text())["test"]["ingestion-recovery-final"]
        declared = {row["name"]: row for row in graph["check"]}
        selected = MODES[mode]
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        if mode != "maintenance":
            normalize_corepack()
            if not subprocess.check_output(["node", "--version"], text=True).startswith("v22."):
                raise ValueError("Functional verification requires Node 22")
            version = subprocess.check_output(["/usr/bin/corepack", "pnpm", "--version"], cwd=source, text=True).strip()
            if version != "9.15.4":
                raise ValueError(f"Expected locked pnpm 9.15.4, got {version}")
            install = execute(source, output, "workspace", declared["workspace"]["command"],
                              declared["workspace"]["timeout_seconds"], environment)
            report["checks"].append(install)
            if install["status"] != "passed":
                return 1
        if mode == "database":
            # Fetch only the public regression-source ref; never move functional HEAD.
            subprocess.run(["git", "fetch", "--no-tags", "--unshallow",
                            "https://github.com/holyglory/XFoilFOAM.git", BASELINE_REF], cwd=source, check=True)
            for commit in (BASELINE, REGRESSION):
                subprocess.run(["git", "cat-file", "-e", commit + "^{commit}"], cwd=source, check=True)
            subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, "FETCH_HEAD"], cwd=source, check=True)
            report["baseline_source_ref"] = BASELINE_REF
            report["baseline_ref_commit"] = git(source, "rev-parse", "FETCH_HEAD")
            scratch = Path(os.environ["RUNNER_TEMP"]) / "ingestion-baseline-scratch"
            scratch.mkdir(exist_ok=False)
            environment["DEVCOORDINATOR_CHECK_SCRATCH"] = str(scratch)
        succeeded = set()
        for name in selected:
            row = declared[name]
            prerequisites = set(row.get("requires", [])) & set(selected)
            if not prerequisites <= succeeded:
                record = {"name": name, "status": "blocked", "missing_prerequisites": sorted(prerequisites - succeeded)}
            else:
                command = list(row["command"])
                if mode == "maintenance":
                    # Only interpreter selection changes; the pinned pytest file list
                    # and full suite stay exactly as declared in the final graph.
                    command = [part.replace("/home/holyglory/XFoilFOAM/.venv/bin/python", sys.executable) for part in command]
                check_environment = {**environment, **row.get("env", {})}
                if check_environment.get("XFOILFOAM_PYTHON") == "/home/holyglory/XFoilFOAM/.venv/bin/python":
                    check_environment["XFOILFOAM_PYTHON"] = sys.executable
                record = execute(source, output, name, command, row["timeout_seconds"], check_environment)
                if record["status"] == "passed":
                    succeeded.add(name)
            report["checks"].append(record)
        baseline = source / ".codex-artifacts/progressive-lock-order-baseline"
        if mode == "database" and baseline.exists():
            shutil.copytree(baseline, output / "negative-baseline-evidence")
        after = identity(source)
        write_json(output / "source-identity-after.json", after)
        if before != after:
            raise ValueError("Functional source identity changed during CI")
        report["status"] = "passed" if all(row["status"] == "passed" for row in report["checks"]) else "failed"
        return 0 if report["status"] == "passed" else 1
    except Exception as error:
        report["error"] = str(error)
        traceback.print_exc()
        return 1
    finally:
        report["finished_at_unix_ms"] = int(time.time() * 1000)
        report["helper_sha256"] = sha256(Path(__file__).read_bytes())
        write_json(output / "summary.json", report)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=MODES)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    return run(args.mode, args.source.resolve(strict=True), args.output.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
