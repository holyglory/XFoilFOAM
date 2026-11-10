"""Prove the two campaign-lock regressions against the frozen pre-fix source."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import uuid
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[3]
BASELINE = "c5abb7587eba4c04e431056e1d3cddeeb76211b4"
SUITE = "packages/db/test/campaign-profile-enrollment.test.ts"
EXPECTED = {
    "locks the campaign before the job while applying remote progress":
        "campaign-lock-order: progress must not hold the job while waiting for campaign",
    "locks the campaign before dependent rows across claim and compose":
        "campaign-lock-order: composition must not upgrade campaign after locking generation",
}
scratch = Path(os.environ["DEVCOORDINATOR_CHECK_SCRATCH"])
evidence = ROOT / ".codex-artifacts/progressive-lock-order-baseline" / uuid.uuid4().hex
evidence.mkdir(parents=True, exist_ok=False)
suite_hash = hashlib.sha256((ROOT / SUITE).read_bytes()).hexdigest()

with tempfile.TemporaryDirectory(prefix="campaign-lock-order-", dir=scratch) as temporary:
    directory = Path(temporary)
    archive = directory / "source.tar"
    with archive.open("wb") as output:
        subprocess.run(["git", "archive", BASELINE], cwd=ROOT, stdout=output, check=True)
    baseline = directory / "baseline"
    baseline.mkdir()
    with tarfile.open(archive) as source:
        source.extractall(baseline, filter="data")
    source_hashes = {
        path: hashlib.sha256((baseline / path).read_bytes()).hexdigest()
        for path in (
            "apps/sweeper/src/progressive-remote-progress.ts",
            "packages/db/src/progressive-cfd.ts",
        )
    }
    shutil.copyfile(ROOT / SUITE, baseline / SUITE)
    assert hashlib.sha256((baseline / SUITE).read_bytes()).hexdigest() == suite_hash
    subprocess.run(
        ["/usr/bin/corepack", "pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--offline"],
        cwd=baseline, check=True,
    )
    report = evidence / "junit.xml"
    result = subprocess.run(
        ["/usr/bin/corepack", "pnpm", "--filter", "@aerodb/db", "exec", "vitest", "run",
         "test/campaign-profile-enrollment.test.ts", "-t", "|".join(EXPECTED),
         "--reporter=junit", f"--outputFile={report}"],
        cwd=baseline,
    )
    assert result.returncode == 1, f"Expected failing baseline, got {result.returncode}"
    document = ET.parse(report)
    failures = {}
    for case in document.iter("testcase"):
        failed = case.findall("failure")
        if failed:
            failures[case.attrib["name"]] = " ".join(
                failure.attrib.get("message", "") + " " + (failure.text or "")
                for failure in failed
            )
    assert len(failures) == len(EXPECTED), failures
    assert not list(document.iter("error")), "Baseline setup failed"
    for name, marker in EXPECTED.items():
        matches = [message for case, message in failures.items() if case.endswith(name)]
        assert len(matches) == 1 and marker in matches[0], (name, failures)
    proof = {
        "baseline_commit": BASELINE,
        "baseline_source_sha256": source_hashes,
        "test_sha256": suite_hash,
        "expected_assertion_failures": sorted(EXPECTED),
    }
    (evidence / "baseline.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof))
