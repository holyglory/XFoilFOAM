from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts" / "deploy" / "evidence-contract.py"


def _run(tmp_path: Path, lines: list[str]) -> subprocess.CompletedProcess[str]:
    env_file = tmp_path / "contract.env"
    env_file.write_text("\n".join(lines) + "\n")
    return subprocess.run(
        [sys.executable, str(TOOL), "--env-file", str(env_file)],
        text=True,
        capture_output=True,
        check=False,
    )


def test_evidence_contract_hash_is_canonical_and_matches_receipt_shape(
    tmp_path: Path,
) -> None:
    first = _run(
        tmp_path,
        [
            "AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket",
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
            "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
            "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true",
        ],
    )
    assert first.returncode == 0, first.stderr
    contract = {
        "backend": "gcs",
        "bucket": "airfoils-pro-storage-bucket",
        "object_prefix": "solver-evidence/v1",
        "archive_format": "tar+zstd",
        "compression": "zstd",
        "zstd_level": 10,
        "local_disposition": "remote-only",
    }
    expected = hashlib.sha256(
        json.dumps(contract, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    assert first.stdout.strip() == expected

    reordered = _run(
        tmp_path,
        [
            "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=TRUE",
            "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
            "IGNORED_SECRET=does-not-affect-contract",
            "AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket",
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
        ],
    )
    assert reordered.returncode == 0, reordered.stderr
    assert reordered.stdout == first.stdout


def test_evidence_contract_hash_changes_for_every_certified_dimension(
    tmp_path: Path,
) -> None:
    base = [
        "AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket",
        "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
        "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
        "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true",
    ]
    baseline = _run(tmp_path, base)
    assert baseline.returncode == 0
    for replacement in [
        "AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket-v2",
        "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v2",
        "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=19",
    ]:
        key = replacement.split("=", 1)[0]
        changed = _run(
            tmp_path,
            [replacement if line.startswith(f"{key}=") else line for line in base],
        )
        assert changed.returncode == 0, changed.stderr
        assert changed.stdout != baseline.stdout


def test_evidence_contract_rejects_ambiguous_duplicate_keys(tmp_path: Path) -> None:
    result = _run(
        tmp_path,
        [
            "AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket",
            "AIRFOILFOAM_EVIDENCE_BUCKET=another-valid-bucket",
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
            "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
            "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true",
        ],
    )
    assert result.returncode == 2
    assert "duplicate AIRFOILFOAM_EVIDENCE_BUCKET" in result.stderr
