"""Run the pinned recovery graph on GitHub's disposable CI runner.

This produces GitHub Actions evidence, never a Coordinator receipt. The
DEVCOORDINATOR_DIAGNOSTICS_DIR variable only adapts existing report output.
No Coordinator identity, admission, qualification or production access is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
import tomllib
import traceback
import xml.etree.ElementTree as ET


REVISION = "9dd61bd3f9ac00e1e9217adc6bc09249493916b8"
MODES = {
    "reports": "progressive-report-payloads",
    "catalog": "public-metrics",
}
SCALE_CASE = "keeps full campaign catalog reads within their time budget"
APPROVED_ACTIONS = {
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1",
    "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
}


def validate_harness_files() -> None:
    workflow = Path(__file__).resolve().parents[2] / ".github/workflows/ingestion-ci.yml"
    text = workflow.read_text()
    actions = re.findall(r"(?m)^\s+(?:-\s+)?uses: (\S+)", text)
    if not actions or set(actions) != APPROVED_ACTIONS:
        raise ValueError("Workflow action pins differ from the approved CI template")
    if f"  FUNCTIONAL_REF: {REVISION}\n" not in text:
        raise ValueError("Workflow functional revision differs from the harness")


def junit_summary(directory: Path) -> dict:
    cases = []
    files = sorted(directory.glob("*.xml"))
    for path in files:
        cases.extend(ET.parse(path).getroot().iter("testcase"))
    skipped = sum(case.find("skipped") is not None for case in cases)
    failures = sum(case.find("failure") is not None for case in cases)
    errors = sum(case.find("error") is not None for case in cases)
    return {"files": [path.name for path in files], "tests": len(cases),
            "executed": len(cases) - skipped, "skipped": skipped,
            "failures": failures, "errors": errors,
            "catalog_scale_passed": any(SCALE_CASE in case.get("name", "")
                and all(case.find(tag) is None for tag in ("skipped", "failure", "error"))
                for case in cases)}


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


def locked_pytest_requirements(source: Path, destination: Path) -> None:
    packages = tomllib.loads((source / "uv.lock").read_text())["package"]
    pending, selected = ["pytest"], {}
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        matches = [package for package in packages if package["name"] == name]
        if len(matches) != 1:
            raise ValueError(f"Pytest dependency has no unique locked version: {name}")
        package = selected[name] = matches[0]
        # Include the small platform/older-Python compatibility dependencies too;
        # every installed distribution still has its exact lockfile hashes.
        pending.extend(dependency["name"] for dependency in package.get("dependencies", []))
    lines = []
    for name, package in sorted(selected.items()):
        artifacts = package.get("wheels", []) + ([package["sdist"]] if "sdist" in package else [])
        hashes = sorted({artifact["hash"] for artifact in artifacts})
        if not hashes or any(not digest.startswith("sha256:") for digest in hashes):
            raise ValueError(f"Missing locked test dependency hashes: {name}")
        lines.append(f"{name}=={package['version']} " + " ".join(f"--hash={digest}" for digest in hashes))
    destination.write_text("\n".join(lines) + "\n")


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
    declared_command = list(command)
    command = [part.replace("/home/holyglory/XFoilFOAM/.venv/bin/python", sys.executable)
               for part in command]
    if "vitest" in command and not any("--reporter" in part for part in command):
        command += ["--reporter=default", "--reporter=junit", f"--outputFile.junit={directory / 'report.xml'}"]
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
              "declared_command": declared_command, "command": command,
              "log": str(log.relative_to(output)),
              "log_sha256": sha256(log.read_bytes())}
    if any(part in ("vitest", "pytest") or " exec vitest run " in part or " -m pytest " in part
           for part in command):
        try:
            junit = junit_summary(directory)
            record["junit"] = junit
            if status == "passed" and (junit["executed"] == 0 or junit["failures"] or junit["errors"]
                                       or (name == "catalog" and not junit["catalog_scale_passed"])):
                record.update(status="failed", error="Required executed passing JUnit coverage is missing")
        except (OSError, ET.ParseError) as error:
            record.update(status="failed", error=f"Invalid JUnit evidence: {error}")
    write_json(directory / "result.json", record)
    if record["status"] != "passed":
        print("\n".join(log.read_bytes()[-32768:].decode(errors="replace").splitlines()[-80:]), flush=True)
    print(json.dumps(record), flush=True)
    return record


def run(mode: str, source: Path, output: Path) -> int:
    validate_harness_files()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("This harness runs only on GitHub's ephemeral Actions runner")
    if os.environ.get("FUNCTIONAL_REF") != REVISION:
        raise ValueError("Workflow and harness functional pins differ")
    output.mkdir(parents=True, exist_ok=False)
    report = {"provider": "github-actions", "coordinator_qualification": False,
              "mode": mode, "target": MODES[mode], "functional_revision": REVISION,
              "ci_revision": os.environ["GITHUB_SHA"], "github_run_id": os.environ["GITHUB_RUN_ID"],
              "github_run_attempt": os.environ["GITHUB_RUN_ATTEMPT"], "checks": [], "status": "failed"}
    try:
        before = identity(source)
        write_json(output / "source-identity-before.json", before)
        graph = tomllib.loads((source / ".devcoordinator.toml").read_text())["test"][MODES[mode]]
        declared = {row["name"]: row for row in graph["check"]}
        if len(declared) != len(graph["check"]):
            raise ValueError("Duplicate declared check names")
        report["declared_checks"] = list(declared)
        report["required_checks"] = list(declared) + (["restore-inline", "restore-inline-proof"] if mode == "reports" else [])
        report["declared_graph"] = graph
        environment = dict(os.environ)
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        normalize_corepack()
        if not subprocess.check_output(["node", "--version"], text=True).startswith("v22."):
            raise ValueError("Functional verification requires Node 22")
        version = subprocess.check_output(["/usr/bin/corepack", "pnpm", "--version"], cwd=source, text=True).strip()
        if version != "9.15.4":
            raise ValueError(f"Expected locked pnpm 9.15.4, got {version}")
        if mode == "reports":
            requirements = output / "pytest-requirements.lock"
            locked_pytest_requirements(source, requirements)
            for name, path in (("python-runtime-dependencies", source / "docker/requirements.lock"),
                               ("python-test-dependencies", requirements)):
                installed = execute(source, output, name,
                    [sys.executable, "-m", "pip", "install", "--require-hashes", "-r", str(path)], 600, environment)
                report["checks"].append(installed)
                if installed["status"] != "passed":
                    return 1
        # Populate the disposable runner store before the declared offline
        # workspace command. The locked install itself is not weakened.
        if any("--offline" in row["command"] for row in declared.values()):
            prefetch = execute(source, output, "dependency-prefetch",
                               ["/usr/bin/corepack", "pnpm", "fetch", "--frozen-lockfile"],
                               600, environment)
            report["checks"].append(prefetch)
            if prefetch["status"] != "passed":
                return 1
        checks = dict(declared)
        if mode == "reports":
            # This database belongs only to this GitHub job. Restore and prove
            # inline compatibility after both normalized integration journeys.
            base = ["/usr/bin/corepack", "pnpm", "--filter", "@aerodb/db", "backfill:progressive-report-payloads"]
            checks["restore-inline"] = {"command": base + ["--apply", "--disable-writes", "--restore-inline", "--rows=128", "--batches=1000"],
                "timeout_seconds": 120, "requires": ["schema"], "after": ["normalized-worker-hub", "normalized-api"]}
            checks["restore-inline-proof"] = {"command": base + ["--prove-inline"],
                "timeout_seconds": 120, "requires": ["restore-inline"]}
            checks["scalar-report-probes"] = {**checks["scalar-report-probes"], "after": ["restore-inline-proof"]}
        for row in checks.values():
            missing = (set(row.get("requires", [])) | set(row.get("after", []))) - checks.keys()
            if missing:
                raise ValueError(f"Missing declared dependencies: {sorted(missing)}")
        succeeded = set()
        completed = set()
        remaining = dict(checks)
        deadline = time.monotonic() + graph["timeout_seconds"]
        while remaining:
            ready = next((name for name, row in remaining.items()
                          if (set(row.get("requires", [])) | set(row.get("after", []))) <= completed), None)
            if ready is None:
                raise ValueError("Declared graph has a dependency cycle")
            name, row = ready, remaining.pop(ready)
            prerequisites = set(row.get("requires", []))
            budget = int(deadline - time.monotonic())
            if not prerequisites <= succeeded or budget <= 0:
                record = {"name": name, "status": "blocked", "missing_prerequisites": sorted(prerequisites - succeeded),
                          "target_deadline_exceeded": budget <= 0}
            else:
                record = execute(source, output, name, list(row["command"]),
                                 min(row.get("timeout_seconds", graph["timeout_seconds"]), budget),
                                 {**environment, **row.get("env", {})})
                if record["status"] == "passed":
                    succeeded.add(name)
            report["checks"].append(record)
            completed.add(name)
        after = identity(source)
        write_json(output / "source-identity-after.json", after)
        if before != after:
            raise ValueError("Functional source identity changed during CI")
        report["status"] = "passed" if set(declared) <= succeeded and all(row["status"] == "passed" for row in report["checks"]) else "failed"
        return 0 if report["status"] == "passed" else 1
    except Exception as error:
        report["error"] = str(error)
        traceback.print_exc()
        return 1
    finally:
        recorded = {row["name"] for row in report["checks"]}
        report["checks"].extend({"name": name, "status": "blocked", "reason": "Harness or prerequisite did not complete"}
                                for name in report.get("required_checks", []) if name not in recorded)
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
