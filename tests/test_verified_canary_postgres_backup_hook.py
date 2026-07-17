from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "scripts" / "deploy" / "create-verified-canary-postgres-backup.sh"
CONTAINER_ID = "a" * 64
IMAGE_ID = "sha256:" + "b" * 64
DUMP_BYTES = b"exact-production-aerodb-custom-dump\n"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


def _fake_backup_tool(path: Path) -> None:
    _write_executable(
        path,
        """#!/usr/bin/env python3
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
command = args[0]
state = Path(os.environ["FAKE_STATE"])
with (state / "backup-tool.log").open("a", encoding="utf-8") as stream:
    stream.write(command + "\\n")

def value(flag):
    return args[args.index(flag) + 1]

if command == "backup":
    output = Path(value("--output"))
    output.write_bytes(b"exact-production-aerodb-custom-dump\\n")
    output.chmod(0o600)
    marker = state / "backup-failed-after-dump"
    if os.environ.get("FAKE_BACKUP_FAIL_AFTER_DUMP_ONCE") == "1" and not marker.exists():
        marker.write_text("failed\\n", encoding="utf-8")
        raise SystemExit(73)
    manifest = {
        "schema_version": 2,
        "type": "postgres-docker-backup",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": "database",
        "format": "custom",
        "size": output.stat().st_size,
        "sha256": __import__("hashlib").sha256(output.read_bytes()).hexdigest(),
        "source": {
            "container": {
                "id": os.environ["EXPECTED_POSTGRES_CONTAINER_ID"],
                "image_id": os.environ["EXPECTED_POSTGRES_IMAGE_ID"],
            },
            "postgres": {
                "user": "aerodb",
                "database": "aerodb",
                "scope": "database",
                "catalog": {"tables": 12, "sequences": 3, "views": 2, "functions": 5},
            },
        },
        "publication": {
            "atomic_artifact": True,
            "exclusive": True,
            "directory_mode": "0700",
            "file_mode": "0600",
        },
    }
    manifest_path = Path(str(output) + ".manifest.json")
    manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\\n", encoding="utf-8")
    manifest_path.chmod(0o600)
elif command == "verify":
    output = Path(value("--file"))
    manifest_path = Path(str(output) + ".manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    catalog = manifest["source"]["postgres"]["catalog"]
    digest = __import__("hashlib").sha256(output.read_bytes()).hexdigest()
    manifest["verification"] = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "mode": "test_restore",
        "scope": "database",
        "sha256": digest,
        "ok": True,
        "verification_target": "scratch_database",
        "catalog_signature": catalog,
        "container_identity_preflight": {
            "expected_id": os.environ["EXPECTED_POSTGRES_CONTAINER_ID"],
            "actual_id": os.environ["EXPECTED_POSTGRES_CONTAINER_ID"],
            "match": "exact_full",
            "execution_target": "immutable_full_id",
        },
    }
    temporary = manifest_path.with_name("." + manifest_path.name + ".verified")
    temporary.write_text(json.dumps(manifest, sort_keys=True) + "\\n", encoding="utf-8")
    temporary.chmod(0o600)
    os.replace(temporary, manifest_path)
else:
    raise SystemExit(2)
""",
    )


def _fake_docker(path: Path) -> None:
    _write_executable(
        path,
        """#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == "inspect" && "${2:-}" == "--format" ]] || exit 91
case "$3" in
  '{{.Id}}') printf '%s\\n' "$EXPECTED_POSTGRES_CONTAINER_ID" ;;
  '{{.Image}}') printf '%s\\n' "$EXPECTED_POSTGRES_IMAGE_ID" ;;
  *) exit 92 ;;
esac
""",
    )


def _fake_python(path: Path) -> None:
    _write_executable(
        path,
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != "-" ]]; then
  exec "$REAL_PYTHON" "$@"
fi
source_file="$(mktemp "$FAKE_STATE/python-stdin.XXXXXX")"
trap 'rm -f "$source_file"' EXIT
cat >"$source_file"
set +e
"$REAL_PYTHON" "$@" <"$source_file"
rc=$?
set -e
if ((rc == 0)) && [[ "${FAKE_PYTHON_FAIL_AFTER_RECEIPT_ONCE:-0}" == "1" ]] \
  && grep -q 'off-VPS receipt collision during exclusive publication' "$source_file" \
  && [[ ! -e "$FAKE_STATE/python-failed-after-receipt" ]]; then
  printf 'failed\\n' >"$FAKE_STATE/python-failed-after-receipt"
  exit 74
fi
exit "$rc"
""",
    )


def _fake_gcloud(path: Path) -> None:
    _write_executable(
        path,
        """#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

args = sys.argv[1:]
state = Path(os.environ["FAKE_STATE"])
remote = state / "gcs"
remote.mkdir(exist_ok=True)
index_path = state / "gcs-index.json"
index = json.loads(index_path.read_text()) if index_path.exists() else {}
with (state / "gcloud.log").open("a", encoding="utf-8") as stream:
    stream.write(" ".join(args) + "\\n")

def save():
    temporary = index_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(index, sort_keys=True), encoding="utf-8")
    os.replace(temporary, index_path)

def object_path(locator):
    return remote / hashlib.sha256(locator.encode()).hexdigest()

def blocked(locator):
    label = "manifest" if locator.endswith(".manifest.json") else "dump"
    return (
        os.environ.get("FAKE_GCLOUD_FAIL_AFTER_UPLOAD") == label
        and (state / f"block-{label}-describe").exists()
    )

if args[:3] == ["storage", "objects", "describe"]:
    locator = args[3]
    if blocked(locator):
        raise SystemExit(75)
    entry = index.get(locator)
    if entry is None:
        raise SystemExit(1)
    print(json.dumps({"generation": entry["generation"], "size": entry["size"]}))
    raise SystemExit

if args[:2] != ["storage", "cp"]:
    raise SystemExit(2)
condition = next((item.split("=", 1)[1] for item in args if item.startswith("--if-generation-match=")), None)
operands = [item for item in args[2:] if not item.startswith("--")]
if len(operands) != 2:
    raise SystemExit(3)
source, destination = operands
if destination.startswith("gs://"):
    if condition != "0":
        raise SystemExit(4)
    if destination in index:
        raise SystemExit(5)
    payload = Path(source).read_bytes()
    generation = str(1000 + len(index) + 1)
    object_path(destination).write_bytes(payload)
    index[destination] = {"generation": generation, "size": len(payload)}
    save()
    label = "manifest" if destination.endswith(".manifest.json") else "dump"
    if os.environ.get("FAKE_GCLOUD_FAIL_AFTER_UPLOAD") == label:
        (state / f"block-{label}-describe").write_text("blocked\\n", encoding="utf-8")
        raise SystemExit(76)
    raise SystemExit
if not source.startswith("gs://"):
    raise SystemExit(6)
entry = index.get(source)
if entry is None or condition != entry["generation"]:
    raise SystemExit(7)
shutil.copyfile(object_path(source), destination)
""",
    )


@pytest.fixture
def hook_env(tmp_path: Path) -> dict[str, str]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir(mode=0o700)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    backup_dir = tmp_path / "backup"
    backup_dir.mkdir(mode=0o700)
    receipt_dir = tmp_path / "receipt"
    receipt_dir.mkdir(mode=0o700)
    backup_tool = tmp_path / "postgres_docker_backup.py"
    _fake_backup_tool(backup_tool)
    _fake_docker(fake_bin / "docker")
    _fake_gcloud(fake_bin / "gcloud")
    _fake_python(fake_bin / "python3")
    media = state / "media.json"
    media.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "purpose": "pending-opencfd2606-canary-db-ack-media-quiesce",
                "status": "stopped-for-backup",
                "stoppedAt": datetime.now(timezone.utc).isoformat(),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    media.chmod(0o600)
    backup = backup_dir / "production.dump"
    receipt = receipt_dir / "off-vps.json"
    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "REAL_PYTHON": sys.executable,
            "FAKE_STATE": str(state),
            "POSTGRES_BACKUP_TOOL": str(backup_tool),
            "EXPECTED_POSTGRES_BACKUP_TOOL_SHA256": _sha(backup_tool),
            "EXPECTED_POSTGRES_CONTAINER_ID": CONTAINER_ID,
            "EXPECTED_POSTGRES_IMAGE_ID": IMAGE_ID,
            "DATABASE_BACKUP_FILE": str(backup),
            "DATABASE_BACKUP_MANIFEST": str(backup) + ".manifest.json",
            "DATABASE_BACKUP_OFF_VPS_RECEIPT": str(receipt),
            "MEDIA_QUIESCE_JOURNAL": str(media),
            "DEPLOY_LOCK_HELD": "1",
            "GCS_BACKUP_BUCKET": "private-test-bucket",
            "GCS_BACKUP_PREFIX": "incident/canary-db-ack",
            "LOCK_PATH": str(tmp_path / "deploy.lock"),
        }
    )
    return env


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            "-c",
            'exec 9>"$LOCK_PATH"; flock -n 9; exec "$HOOK_PATH"',
        ],
        env={**env, "HOOK_PATH": str(HOOK)},
        text=True,
        capture_output=True,
        check=False,
    )


def _remote_entries(env: dict[str, str]) -> dict[str, dict[str, object]]:
    return json.loads(
        (Path(env["FAKE_STATE"]) / "gcs-index.json").read_text(encoding="utf-8")
    )


def _remote_bytes(env: dict[str, str], locator: str) -> bytes:
    remote = Path(env["FAKE_STATE"]) / "gcs"
    return (remote / hashlib.sha256(locator.encode()).hexdigest()).read_bytes()


def test_fresh_backup_verifies_dump_and_manifest_and_reuses_exact_receipt(
    hook_env: dict[str, str],
) -> None:
    first = _run(hook_env)
    assert first.returncode == 0, first.stderr
    backup = Path(hook_env["DATABASE_BACKUP_FILE"])
    manifest = Path(hook_env["DATABASE_BACKUP_MANIFEST"])
    receipt_path = Path(hook_env["DATABASE_BACKUP_OFF_VPS_RECEIPT"])
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    entries = _remote_entries(hook_env)
    assert _remote_bytes(hook_env, receipt["destination"]["locator"]) == backup.read_bytes()
    assert (
        _remote_bytes(hook_env, receipt["destination"]["manifestLocator"])
        == manifest.read_bytes()
    )
    assert receipt["verification"]["manifestSha256"] == _sha(manifest)
    assert receipt["verification"]["manifestSize"] == manifest.stat().st_size
    assert receipt["sourceImageId"] == IMAGE_ID
    assert oct(receipt_path.stat().st_mode & 0o777) == "0o600"
    first_receipt = receipt_path.read_bytes()
    first_receipt_inode = receipt_path.stat().st_ino
    first_generations = {
        locator: value["generation"] for locator, value in entries.items()
    }

    second = _run(hook_env)

    assert second.returncode == 0, second.stderr
    assert receipt_path.read_bytes() == first_receipt
    assert receipt_path.stat().st_ino == first_receipt_inode
    assert {
        locator: value["generation"]
        for locator, value in _remote_entries(hook_env).items()
    } == first_generations
    assert (Path(hook_env["FAKE_STATE"]) / "backup-tool.log").read_text().splitlines() == [
        "backup",
        "verify",
    ]


@pytest.mark.parametrize("boundary", ["local", "dump", "manifest", "receipt"])
def test_transient_publication_failure_resumes_without_replacing_exact_bytes(
    hook_env: dict[str, str], boundary: str
) -> None:
    if boundary == "local":
        hook_env["FAKE_BACKUP_FAIL_AFTER_DUMP_ONCE"] = "1"
    elif boundary in {"dump", "manifest"}:
        hook_env["FAKE_GCLOUD_FAIL_AFTER_UPLOAD"] = boundary
    else:
        hook_env["FAKE_PYTHON_FAIL_AFTER_RECEIPT_ONCE"] = "1"

    failed = _run(hook_env)

    assert failed.returncode != 0
    backup = Path(hook_env["DATABASE_BACKUP_FILE"])
    manifest = Path(hook_env["DATABASE_BACKUP_MANIFEST"])
    receipt = Path(hook_env["DATABASE_BACKUP_OFF_VPS_RECEIPT"])
    if boundary == "local":
        assert backup.read_bytes() == DUMP_BYTES
        assert not manifest.exists()
        preserved_dump = backup.read_bytes()
        first_generations: dict[str, str] = {}
    else:
        assert backup.exists() and manifest.exists()
        local_before = (backup.read_bytes(), manifest.read_bytes())
        first_generations = {
            locator: str(value["generation"])
            for locator, value in _remote_entries(hook_env).items()
        }
    if boundary == "receipt":
        assert receipt.exists()
        receipt_before = receipt.read_bytes()
        receipt_inode_before = receipt.stat().st_ino

    hook_env.pop("FAKE_GCLOUD_FAIL_AFTER_UPLOAD", None)
    resumed = _run(hook_env)

    assert resumed.returncode == 0, resumed.stderr
    if boundary == "local":
        quarantine = backup.parent / "canary-db-ack-backup-quarantine"
        assert any(path.read_bytes() == preserved_dump for path in quarantine.iterdir())
    else:
        assert (backup.read_bytes(), manifest.read_bytes()) == local_before
        final_generations = {
            locator: str(value["generation"])
            for locator, value in _remote_entries(hook_env).items()
        }
        for locator, generation in first_generations.items():
            assert final_generations[locator] == generation
    if boundary == "receipt":
        assert receipt.read_bytes() == receipt_before
        assert receipt.stat().st_ino == receipt_inode_before


def test_unmatched_local_pair_is_quarantined_without_data_loss(
    hook_env: dict[str, str],
) -> None:
    backup = Path(hook_env["DATABASE_BACKUP_FILE"])
    manifest = Path(hook_env["DATABASE_BACKUP_MANIFEST"])
    old_dump = b"interrupted-old-dump\n"
    old_manifest = b'{"sha256":"not-the-dump","size":999}\n'
    backup.write_bytes(old_dump)
    backup.chmod(0o600)
    manifest.write_bytes(old_manifest)
    manifest.chmod(0o600)

    completed = _run(hook_env)

    assert completed.returncode == 0, completed.stderr
    quarantine = backup.parent / "canary-db-ack-backup-quarantine"
    preserved = [path.read_bytes() for path in quarantine.iterdir()]
    assert old_dump in preserved
    assert old_manifest in preserved
    assert backup.read_bytes() == DUMP_BYTES


def test_remote_manifest_mismatch_is_a_generation_locked_collision(
    hook_env: dict[str, str],
) -> None:
    assert _run(hook_env).returncode == 0
    receipt = Path(hook_env["DATABASE_BACKUP_OFF_VPS_RECEIPT"])
    receipt_before = receipt.read_bytes()
    payload = json.loads(receipt.read_text())
    locator = payload["destination"]["manifestLocator"]
    remote = Path(hook_env["FAKE_STATE"]) / "gcs" / hashlib.sha256(
        locator.encode()
    ).hexdigest()
    corrupted = bytearray(remote.read_bytes())
    corrupted[0] ^= 1
    remote.write_bytes(corrupted)
    backup_before = Path(hook_env["DATABASE_BACKUP_FILE"]).read_bytes()
    manifest_before = Path(hook_env["DATABASE_BACKUP_MANIFEST"]).read_bytes()

    rejected = _run(hook_env)

    assert rejected.returncode != 0
    assert "GCS manifest content collision" in rejected.stderr
    assert receipt.read_bytes() == receipt_before
    assert Path(hook_env["DATABASE_BACKUP_FILE"]).read_bytes() == backup_before
    assert Path(hook_env["DATABASE_BACKUP_MANIFEST"]).read_bytes() == manifest_before


def test_receipt_collision_is_refused_without_overwrite_or_backup_loss(
    hook_env: dict[str, str],
) -> None:
    receipt = Path(hook_env["DATABASE_BACKUP_OFF_VPS_RECEIPT"])
    collision = b'{"collision":true}\n'
    receipt.write_bytes(collision)
    receipt.chmod(0o600)

    rejected = _run(hook_env)

    assert rejected.returncode != 0
    assert "receipt is a content collision" in rejected.stderr
    assert receipt.read_bytes() == collision
    assert Path(hook_env["DATABASE_BACKUP_FILE"]).read_bytes() == DUMP_BYTES
    assert Path(hook_env["DATABASE_BACKUP_MANIFEST"]).exists()


def test_complete_local_provenance_collision_is_not_quarantined_or_replaced(
    hook_env: dict[str, str],
) -> None:
    backup = Path(hook_env["DATABASE_BACKUP_FILE"])
    manifest = Path(hook_env["DATABASE_BACKUP_MANIFEST"])
    backup.write_bytes(DUMP_BYTES)
    backup.chmod(0o600)
    payload = {
        "schema_version": 2,
        "type": "postgres-docker-backup",
        "scope": "database",
        "format": "custom",
        "size": backup.stat().st_size,
        "sha256": _sha(backup),
        "source": {
            "container": {"id": "c" * 64, "image_id": IMAGE_ID},
            "postgres": {"user": "aerodb", "database": "aerodb", "scope": "database"},
        },
        "publication": {
            "atomic_artifact": True,
            "exclusive": True,
            "directory_mode": "0700",
            "file_mode": "0600",
        },
    }
    manifest.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    manifest.chmod(0o600)
    before = (backup.read_bytes(), manifest.read_bytes())

    rejected = _run(hook_env)

    assert rejected.returncode != 0
    assert "content/provenance collision" in rejected.stderr
    assert (backup.read_bytes(), manifest.read_bytes()) == before
    assert not (backup.parent / "canary-db-ack-backup-quarantine").exists()
