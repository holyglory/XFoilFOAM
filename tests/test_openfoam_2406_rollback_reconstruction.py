"""Static safety contract for the emergency-only OpenCFD 2406 image builder."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
SOURCE_REVISION = "313ad394d8364ae67c62b0929238e23355073f15"
BASE = (
    "opencfd/openfoam-default:2406@"
    "sha256:dd5aa20630a55722663bf83ba0cb74870cba130081303e32e3865007fa2aa35a"
)


def _receipt_module():
    path = ROOT / "scripts" / "deploy" / "persist-json-receipt.py"
    spec = importlib.util.spec_from_file_location("persist_json_receipt", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _canary_receipt() -> dict[str, object]:
    return {
        "schema_version": 1,
        "status": "ok",
        "jobs": [
            {"job_id": "serial-rans"},
            {"job_id": "mpi-2-rans"},
            {"job_id": "forced-urans"},
        ],
    }


def _rollback_receipt() -> dict[str, object]:
    return {
        "schema_version": 1,
        "purpose": "emergency-opencfd-2406-image-reconstruction",
        "source_revision": SOURCE_REVISION,
        "source_tree": "f" * 40,
        "context_tree_sha256": "a" * 64,
        "base_image": BASE,
        "dockerfile_sha256": "b" * 64,
        "dependency_lock_sha256": "c" * 64,
        "ubuntu_snapshot": "20260715T000000Z",
        "platform": "linux/amd64",
        "image_tag": "xfoilfoam/opencfd-2406-rollback:test",
        "image_id": f"sha256:{'d' * 64}",
        "openfoam_package_version": "2406.0-1",
        "simple_foam_sha256": "e" * 64,
        "created_at": "2026-07-15T00:00:00+00:00",
        "deployed": False,
    }


def test_rollback_image_is_pinned_isolated_and_exports_exact_old_sources():
    dockerfile = (
        ROOT / "docker" / "Dockerfile.worker-opencfd2406-rollback"
    ).read_text()
    lockfile = (
        ROOT / "docker" / "requirements-opencfd2406-rollback.lock"
    ).read_text()
    script = (
        ROOT / "scripts" / "deploy" / "reconstruct-opencfd-2406-image.sh"
    ).read_text()
    compose = (ROOT / "docker-compose.yml").read_text()
    deploy_compose = (ROOT / "docker-compose.deploy.yml").read_text()

    assert f"FROM {BASE}" in dockerfile
    assert f'org.opencontainers.image.revision="{SOURCE_REVISION}"' in dockerfile
    assert f'SOURCE_REVISION="{SOURCE_REVISION}"' in script
    assert 'git -C "$ROOT" archive --format=tar "$SOURCE_REVISION"' in script
    assert "snapshot.ubuntu.com/ubuntu/20260715T000000Z" in dockerfile
    assert "python3=3.12.3-0ubuntu2.1" in dockerfile
    assert "--require-hashes" in dockerfile
    assert "--only-binary=:all:" in lockfile
    assert 'LOCK_SHA256="64751f247e46d13584126d8312d5317e47feba077dfcd1c675cac0c93d2d6685"' in script
    assert 'DOCKERFILE_SHA256="a37a9fcb3ce023722a55b00e51b4fd49ca9bee396d8e12b928f6bc4cc2ae747b"' in script
    assert hashlib.sha256(dockerfile.encode()).hexdigest() == (
        "a37a9fcb3ce023722a55b00e51b4fd49ca9bee396d8e12b928f6bc4cc2ae747b"
    )
    assert hashlib.sha256(lockfile.encode()).hexdigest() == (
        "64751f247e46d13584126d8312d5317e47feba077dfcd1c675cac0c93d2d6685"
    )
    assert '--platform "$PLATFORM"' in script
    assert '--iidfile "$iid_file"' in script
    assert '--entrypoint bash "$image_id"' in script
    assert "from airfoilfoam.api.main import app" in script
    assert "from airfoilfoam.celery_app import celery_app" in script
    assert "--receipt is required" in script
    assert "docker compose" not in script
    assert "psql" not in script
    assert "worker-opencfd2406-rollback" not in compose
    assert "worker-opencfd2406-rollback" not in deploy_compose


def test_recorded_pre_cutover_source_commit_and_tree_are_exact():
    revision = subprocess.run(
        ["git", "rev-parse", f"{SOURCE_REVISION}^{{commit}}"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    tree = subprocess.run(
        ["git", "rev-parse", f"{SOURCE_REVISION}^{{tree}}"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()

    assert revision == SOURCE_REVISION
    assert tree == "f4ee8cc78a21d512b6b1aaf2a568d0dbd3b3da9f"


def test_reconstruction_help_is_non_mutating():
    completed = subprocess.run(
        [
            str(
                ROOT
                / "scripts"
                / "deploy"
                / "reconstruct-opencfd-2406-image.sh"
            ),
            "--help",
        ],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    )

    assert "does not alter Compose" in completed.stdout
    assert completed.stderr == ""


def test_reconstruction_requires_a_preexisting_audit_receipt_directory(
    tmp_path: Path,
):
    missing_receipt = tmp_path / "missing-audit-dir" / "receipt.json"
    completed = subprocess.run(
        [
            str(
                ROOT
                / "scripts"
                / "deploy"
                / "reconstruct-opencfd-2406-image.sh"
            ),
            "--receipt",
            str(missing_receipt),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "pre-existing non-symlink audit directory" in completed.stderr
    assert not missing_receipt.parent.exists()


def test_vendor_bashrc_is_sourced_before_strict_runtime_measurement():
    """OpenFOAM 2406 probes unset variables and nonzero optional commands.

    Enabling nounset or errexit before sourcing its vendor bashrc makes an
    otherwise valid reconstructed image fail verification before simpleFoam is
    measured.
    """

    script = (
        ROOT / "scripts" / "deploy" / "reconstruct-opencfd-2406-image.sh"
    ).read_text()
    measurement = script.split('runtime_measurement="$(docker run', 1)[1]
    source_index = measurement.index(
        "source /usr/lib/openfoam/openfoam2406/etc/bashrc"
    )
    strict_index = measurement.index("  set -e\n", source_index)

    assert source_index < strict_index
    assert "source_status=$?" in measurement[source_index:strict_index]
    assert 'test "$source_status" -eq 0' in measurement[strict_index:]


def test_receipt_persistence_fsyncs_file_then_no_clobber_publishes_then_fsyncs_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    module = _receipt_module()
    source = tmp_path / ".receipt.tmp"
    destination = tmp_path / "receipt.json"
    source.write_text(json.dumps(_canary_receipt()) + "\n")
    source.chmod(0o644)

    events: list[str] = []
    real_fsync = module.os.fsync
    real_link = module.os.link
    real_unlink = module.os.unlink

    def tracked_fsync(fd: int) -> None:
        mode = os.fstat(fd).st_mode
        events.append("fsync-file" if stat.S_ISREG(mode) else "fsync-directory")
        real_fsync(fd)

    def tracked_link(old: Path, new: Path, *, follow_symlinks: bool) -> None:
        events.append("link")
        real_link(old, new, follow_symlinks=follow_symlinks)

    def tracked_unlink(path: Path) -> None:
        events.append("unlink-temp")
        real_unlink(path)

    monkeypatch.setattr(module.os, "fsync", tracked_fsync)
    monkeypatch.setattr(module.os, "link", tracked_link)
    monkeypatch.setattr(module.os, "unlink", tracked_unlink)

    module.persist_receipt(source, destination, "opencfd2606-canary")

    assert events == ["fsync-file", "link", "unlink-temp", "fsync-directory"]
    assert not source.exists()
    assert json.loads(destination.read_text()) == _canary_receipt()
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


@pytest.mark.parametrize(
    "invalid_contents",
    [
        '{"schema_version":1,"status":"ok","status":"failed","jobs":[]}',
        json.dumps(
            {
                "schema_version": 1,
                "status": "ok",
                "jobs": [
                    {"job_id": "same"},
                    {"job_id": "same"},
                    {"job_id": "same"},
                ],
            }
        ),
    ],
)
def test_invalid_or_duplicate_key_receipt_never_mutates_destination(
    tmp_path: Path, invalid_contents: str
):
    module = _receipt_module()
    source = tmp_path / ".receipt.tmp"
    destination = tmp_path / "receipt.json"
    source.write_text(invalid_contents + "\n")

    with pytest.raises(ValueError):
        module.persist_receipt(source, destination, "opencfd2606-canary")

    assert source.exists()
    assert not destination.exists()


def test_receipt_persistence_refuses_to_overwrite_existing_evidence(
    tmp_path: Path,
):
    module = _receipt_module()
    source = tmp_path / ".receipt.tmp"
    destination = tmp_path / "receipt.json"
    source.write_text(json.dumps(_canary_receipt()) + "\n")
    destination.write_text('{"existing":"immutable"}\n')

    with pytest.raises(ValueError, match="already exists"):
        module.persist_receipt(source, destination, "opencfd2606-canary")

    assert source.exists()
    assert destination.read_text() == '{"existing":"immutable"}\n'


def test_atomic_publication_loses_forced_eexist_race_without_clobbering(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    module = _receipt_module()
    source = tmp_path / ".receipt.tmp"
    destination = tmp_path / "receipt.json"
    source.write_text(json.dumps(_canary_receipt()) + "\n")
    competitor = '{"winner":"other reconstruction"}\n'

    def racing_link(
        _source: Path, target: Path, *, follow_symlinks: bool
    ) -> None:
        assert follow_symlinks is False
        target.write_text(competitor)
        raise FileExistsError(17, "File exists", target)

    monkeypatch.setattr(module.os, "link", racing_link)

    with pytest.raises(ValueError, match="appeared during publication"):
        module.persist_receipt(source, destination, "opencfd2606-canary")

    assert source.exists()
    assert destination.read_text() == competitor


def test_directory_fsync_failure_is_recoverable_by_verify_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    module = _receipt_module()
    source = tmp_path / ".receipt.tmp"
    destination = tmp_path / "receipt.json"
    source.write_text(json.dumps(_canary_receipt()) + "\n")
    real_sync_parent = module._sync_parent

    def fail_parent_sync(_path: Path) -> None:
        raise OSError("injected directory fsync failure")

    monkeypatch.setattr(module, "_sync_parent", fail_parent_sync)
    with pytest.raises(OSError, match="directory fsync failure"):
        module.persist_receipt(source, destination, "opencfd2606-canary")

    assert not source.exists()
    assert destination.is_file()

    monkeypatch.setattr(module, "_sync_parent", real_sync_parent)
    module.verify_existing_receipt(destination, "opencfd2606-canary")
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_rollback_receipt_profile_accepts_the_reconstruction_evidence_shape(
    tmp_path: Path,
):
    module = _receipt_module()
    source = tmp_path / ".rollback-receipt.tmp"
    destination = tmp_path / "rollback-receipt.json"
    source.write_text(json.dumps(_rollback_receipt()) + "\n")

    module.persist_receipt(source, destination, "opencfd2406-rollback")

    assert json.loads(destination.read_text()) == _rollback_receipt()
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_rollback_reconstruction_routes_receipt_through_durable_helper():
    script = (
        ROOT / "scripts" / "deploy" / "reconstruct-opencfd-2406-image.sh"
    ).read_text()
    persistence = script.split("python3 - \"$receipt_tmp\"", 1)[1]

    assert 'python3 "$ROOT/scripts/deploy/persist-json-receipt.py"' in persistence
    assert "--profile opencfd2406-rollback" in persistence
    assert '--source "$receipt_tmp"' in persistence
    assert '--destination "$RECEIPT_FILE"' in persistence
    assert 'mv -f "$receipt_tmp" "$RECEIPT_FILE"' not in script
    assert 'mkdir -p "$receipt_dir"' not in script
