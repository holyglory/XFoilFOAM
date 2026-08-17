from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "scripts" / "deploy"
REVISION = "a" * 40
TREE = "b" * 64
BACKUP_SHA = "c" * 64
ROLLBACK_SHA = "d" * 64
BUILD_ID = "hz-solver2-opencfd2606-test"


def _fresh_remote_queue() -> dict[str, object]:
    return {
        "queue_observation_state": "fresh",
        "queue_observed_at": "2026-08-04T18:00:00+00:00",
        "queue_refresh_in_progress": False,
        "queue_observation_error": None,
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "inspection_errors": {},
        "queue_depth": 0,
        "default_queue_depth": 0,
        "queue_depths": {"openfoam-opencfd-2606": 0},
        "queue_enabled": {"openfoam-opencfd-2606": True},
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "active": [],
        "reserved": [],
        "scheduled": [],
        "job_ids": [],
        "worker_queues": [
            {"worker": "celery@worker", "queues": ["openfoam-opencfd-2606"]}
        ],
        "inspection_workers": {
            "active": ["celery@worker"],
            "reserved": ["celery@worker"],
            "scheduled": ["celery@worker"],
        },
    }


def _run_remote_queue_gate(
    tmp_path: Path,
    responses: list[tuple[int, dict[str, object]]],
    *,
    curl_advance_milliseconds: int = 0,
) -> subprocess.CompletedProcess[str]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(encoding="utf-8")
    start = source.index("queue_activity() (")
    end = source.index("\n\ndatabase_activity()", start)
    queue_activity = source[start:end]
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    response_dir = tmp_path / "responses"
    response_dir.mkdir()
    for index, (status, payload) in enumerate(responses):
        (response_dir / f"{index}.status").write_text(str(status), encoding="utf-8")
        (response_dir / f"{index}.json").write_text(
            json.dumps(payload), encoding="utf-8"
        )
    index_path = tmp_path / "response-index"
    index_path.write_text("0", encoding="utf-8")
    monotonic_path = tmp_path / "monotonic-state"
    monotonic_path.write_text("100000", encoding="utf-8")

    def write_executable(path: Path, text: str) -> None:
        path.write_text(text, encoding="utf-8")
        path.chmod(0o755)

    write_executable(
        fake_bin / "curl",
        """#!/usr/bin/env bash
set -Eeuo pipefail
output=""
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
index="$(cat "$FAKE_QUEUE_INDEX")"
cp "$FAKE_QUEUE_RESPONSES/$index.json" "$output"
cat "$FAKE_QUEUE_RESPONSES/$index.status"
printf '%s' "$((index + 1))" >"$FAKE_QUEUE_INDEX"
if (( FAKE_CURL_ADVANCE_MILLISECONDS > 0 )); then
  value="$(cat "$FAKE_MONOTONIC_STATE")"
  printf '%s' "$((value + FAKE_CURL_ADVANCE_MILLISECONDS))" >"$FAKE_MONOTONIC_STATE"
fi
""",
    )
    write_executable(
        fake_bin / "sleep",
        """#!/usr/bin/env bash
set -Eeuo pipefail
value="$(cat "$FAKE_MONOTONIC_STATE")"
printf '%s' "$((value + $1 * 1000))" >"$FAKE_MONOTONIC_STATE"
""",
    )
    driver = tmp_path / "queue-gate.sh"
    write_executable(
        driver,
        "#!/usr/bin/env bash\n"
        "set -Eeuo pipefail\n"
        "QUEUE_STALE_REFRESH_WARMUP_MILLISECONDS=45000\n"
        "QUEUE_STALE_REFRESH_HTTP_TIMEOUT_SECONDS=20\n"
        "QUEUE_STALE_REFRESH_REPROBE_SECONDS=1\n"
        "QUEUE_STALE_REFRESH_MAX_REPROBES=45\n\n"
        f"{queue_activity}\n\n"
        "monotonic_milliseconds() {\n"
        "  local value\n"
        "  value=\"$(cat \"$FAKE_MONOTONIC_STATE\")\"\n"
        "  printf '%s\\n' \"$value\"\n"
        "}\n\n"
        "queue_activity\n",
    )
    environment = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_QUEUE_RESPONSES": str(response_dir),
        "FAKE_QUEUE_INDEX": str(index_path),
        "FAKE_MONOTONIC_STATE": str(monotonic_path),
        "FAKE_CURL_ADVANCE_MILLISECONDS": str(curl_advance_milliseconds),
    }
    return subprocess.run(
        [str(driver)], text=True, capture_output=True, check=False, env=environment
    )


def _module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_pinned_watcher_revalidates_active_release_after_shared_lock_before_mutation() -> None:
    production = (DEPLOY / "rebuild-engine.sh").read_text(encoding="utf-8")
    remote = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(encoding="utf-8")

    for source in (production, remote):
        verifier_start = source.index("verify_pinned_watcher_bootstrap()")
        verifier_end = source.index("\n}\n", verifier_start)
        verifier = source[verifier_start:verifier_end]
        assert 'active_release="$(cd "$ACTIVE_APP_LINK" && pwd -P)"' in verifier
        assert '[[ "$active_release" != "$pinned_release" ]]' in verifier
        assert 'verify_pinned_watcher_bootstrap "pre-lock"' in source

    production_main_start = production.rindex("\nmain() {") + 1
    production_main_end = production.index(
        '\n}\n\nif [[ "$CERTIFY_CONTINUATION_ONLY"', production_main_start
    )
    production_main = production[production_main_start:production_main_end]
    production_lock = production_main.index("flock -n 9")
    production_post_lock = production_main.index(
        'verify_pinned_watcher_bootstrap "post-lock"'
    )
    production_source = production_main.index("verify_deployment_source")
    production_first_mutation = production_main.index("capture_sweeper_state")
    assert (
        production_lock
        < production_post_lock
        < production_source
        < production_first_mutation
    )

    remote_main_start = remote.rindex("\nmain() {") + 1
    remote_main_end = remote.rindex("\n}\n\nmain")
    remote_main = remote[remote_main_start:remote_main_end]
    remote_lock = remote_main.index("flock -n 9")
    remote_post_lock = remote_main.index(
        'verify_pinned_watcher_bootstrap "post-lock"'
    )
    remote_source = remote_main.index("verify_deployment_source")
    remote_validate = remote_main.index("validate_compose_profile")
    remote_first_mutation = remote_main.index("install_remote_capacity_monitor")
    assert (
        remote_lock
        < remote_post_lock
        < remote_source
        < remote_validate
        < remote_first_mutation
    )


@pytest.mark.parametrize(
    "script_name", ["rebuild-engine.sh", "rebuild-remote-solver-engine.sh"]
)
def test_pinned_bootstrap_refuses_active_link_switch_between_pre_and_post_lock_checks(
    tmp_path: Path, script_name: str
) -> None:
    source = (DEPLOY / script_name).read_text(encoding="utf-8")
    verifier_start = source.index("verify_pinned_watcher_bootstrap()")
    verifier_end = source.index("\n}\n", verifier_start) + 2
    verifier_function = source[verifier_start:verifier_end]
    release = tmp_path / "release"
    alternate = tmp_path / "alternate"
    release.mkdir()
    alternate.mkdir()
    compose = release / "docker-compose.deploy.yml"
    compose.write_text("services: {}\n", encoding="utf-8")
    manifest = release / ".deployment-source.json"
    revision = "4" * 40
    created = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "deployment-source-manifest.py"),
            "--create",
            "--root",
            str(release),
            "--manifest",
            str(manifest),
            "--revision",
            revision,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    created_revision, tree_sha, _file_count = created.stdout.strip().split("\t")
    assert created_revision == revision
    active = tmp_path / "app"
    active.symlink_to(release, target_is_directory=True)
    marker = tmp_path / "mutation-marker"
    verifier = DEPLOY / "deployment-source-manifest.py"
    verifier_sha = hashlib.sha256(verifier.read_bytes()).hexdigest()
    harness = f"""set -Eeuo pipefail
cd \"$APP_DIR\"
{verifier_function}
verify_pinned_watcher_bootstrap \"pre-lock\"
ln -sfn \"$ALTERNATE_RELEASE\" \"$ACTIVE_APP_LINK\"
verify_pinned_watcher_bootstrap \"post-lock\"
touch \"$MUTATION_MARKER\"
"""
    completed = subprocess.run(
        ["bash", "-c", harness],
        check=False,
        capture_output=True,
        text=True,
        env={
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "APP_DIR": str(release),
            "PINNED_WATCHER_INVOCATION": "true",
            "ACTIVE_APP_LINK": str(active),
            "ALTERNATE_RELEASE": str(alternate),
            "COMPOSE_FILE": str(compose),
            "DEPLOYMENT_MANIFEST_FILE": str(manifest),
            "DEPLOY_SOURCE_REVISION": revision,
            "DEPLOY_SOURCE_TREE_SHA256": tree_sha,
            "DEPLOY_SOURCE_VERIFIER": str(verifier),
            "DEPLOY_SOURCE_VERIFIER_SHA256": verifier_sha,
            "MUTATION_MARKER": str(marker),
        },
    )

    assert completed.returncode == 2
    assert "Active application release changed" in completed.stderr
    assert not marker.exists()


def _compose_config() -> dict[str, object]:
    evidence = {
        "AIRFOILFOAM_EVIDENCE_BUCKET": "",
        "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX": "solver-evidence/v1",
        "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL": "10",
        "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY": "false",
    }
    services: dict[str, object] = {
        name: {} for name in ("node-api", "sweeper", "media-repair", "redis")
    }
    services.update(
        {
            "api": {
                "environment": {
                    **evidence,
                },
                "volumes": [
                    {"type": "volume", "source": "results", "target": "/data"},
                ],
            },
            "worker": {
                "environment": {
                    **evidence,
                    "AIRFOILFOAM_WORKER_CPU_BUDGET": "40",
                    "AIRFOILFOAM_CASE_CONCURRENCY": "40",
                    "AIRFOILFOAM_CELERY_CONCURRENCY": "40",
                },
                "deploy": {"resources": {"limits": {"cpus": "40"}}},
                "ulimits": {"nofile": {"soft": 65_536, "hard": 524_288}},
                "volumes": [
                    {"type": "volume", "source": "results", "target": "/data"},
                    {
                        "type": "volume",
                        "source": "engine_runtime",
                        "target": "/runtime",
                    },
                ],
            },
            "postgres": {
                "volumes": [
                    {"type": "volume", "source": "pgdata", "target": "/pg"}
                ]
            },
        }
    )
    return {
        "services": services,
        "volumes": {"results": {}, "pgdata": {}, "engine_runtime": {}},
    }


def _remote_env(
    state: Path,
    *,
    remote_only: str = "false",
    control_plane_token: str = "remote-solver-control-plane-token-at-least-32-bytes",
) -> str:
    return "\n".join(
        (
            "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver",
            "COMPOSE_PROJECT_NAME=hz-solver2",
            f"COMPOSE_OVERRIDE_FILE={state / 'docker-compose.remote-solver.yml'}",
            "AIRFOILFOAM_EVIDENCE_BUCKET=",
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
            "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
            f"AIRFOILFOAM_EVIDENCE_REMOTE_ONLY={remote_only}",
            f"AIRFOILFOAM_CONTROL_PLANE_TOKEN={control_plane_token}",
            "AIRFOILFOAM_WORKER_CPU_BUDGET=40",
            "AIRFOILFOAM_CASE_CONCURRENCY=40",
            "AIRFOILFOAM_CELERY_CONCURRENCY=40",
        )
    ) + "\n"


def _pending_env(*, receipt_sha: str = "", attestation_sha: str = "") -> str:
    values = {
        "AIRFOILFOAM_DEPLOYMENT_ROLE": "remote-solver",
        "REMOTE_SOLVER2606_CUTOVER_PENDING": "1",
        "REMOTE_SOLVER2606_CUTOVER_COMPLETE": "0",
        "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING": "1",
        "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING": "1",
        "REMOTE_SOLVER2606_CUTOVER_PHASE": "runtime-installed",
        "REMOTE_SOLVER2606_TARGET_BUILD_ID": BUILD_ID,
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION": REVISION,
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256": TREE,
        "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID": "old-2406-build",
        "REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256": BACKUP_SHA,
        "REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256": ROLLBACK_SHA,
        "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256": receipt_sha,
        "REMOTE_SOLVER2606_ATTESTATION_SHA256": attestation_sha,
    }
    return "".join(f"{key}={value}\n" for key, value in values.items())


def _attestation(receipt_sha: str) -> dict[str, object]:
    runtime = {
        "family": "openfoam",
        "distribution": "opencfd",
        "version": "2606",
        "source_revision": "481094fdf34f11ed6d0d603ee59a858a0124236d",
        "build_id": BUILD_ID,
    }
    return {
        "schemaVersion": 1,
        "profile": "hz-solver2-volume-v1",
        "status": "attested",
        "receiptSha256": receipt_sha,
        "sourceRevision": REVISION,
        "sourceTreeSha256": TREE,
        "backupManifestSha256": BACKUP_SHA,
        "rollbackReceiptSha256": ROLLBACK_SHA,
        "buildId": BUILD_ID,
        "runtime": runtime,
        "evidenceStorage": {
            "backend": "volume",
            "bucket": None,
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": 10,
            "local_disposition": "volume",
        },
        "jobIds": ["serial-rans-job", "mpi-rans-job", "urans-job"],
    }


def _volume_receipt() -> dict[str, object]:
    binding = {
        "backend": "volume",
        "stored_sha256": "1" * 64,
        "stored_byte_size": 2048,
        "archive_format": "tar+zstd",
        "compression": "zstd",
        "uncompressed_tar_sha256": "2" * 64,
        "uncompressed_tar_byte_size": 8192,
        "zstd_level": 10,
        "local_disposition": "volume",
    }
    jobs = [
        {
            "scenario": scenario,
            "job_id": job_id,
            "volume_restore_proof": {"strip_bytes_freed": 1024},
            "points": [{"artifacts": [{"storage": dict(binding)}]}],
        }
        for scenario, job_id in (
            ("serial-rans", "serial-rans-job"),
            ("mpi-2-rans", "mpi-rans-job"),
            ("forced-urans-precalc-no-shedding", "urans-job"),
        )
    ]
    return {
        "schema_version": 1,
        "status": "ok",
        "attestation_profile": "hz-solver2-volume-v1",
        "engine": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
            "numerics_revision": "1",
            # Match the real canary/API EngineIdentity JSON contract.  The
            # adapter revision is numeric even though numerics_revision is a
            # string.
            "adapter_contract_version": 1,
        },
        "engine_handshake_key": "openfoam:opencfd:2606:numerics-1:adapter-1",
        "execution_pool": "openfoam-opencfd-2606",
        "runtime": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
            "source_revision": "481094fdf34f11ed6d0d603ee59a858a0124236d",
            "build_id": BUILD_ID,
        },
        "evidence_storage": {
            "backend": "volume",
            "bucket": None,
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": 10,
            "local_disposition": "volume",
        },
        "jobs": jobs,
    }


def test_merged_remote_compose_requires_all_40_cpu_and_volume_contracts() -> None:
    module = _module("remote_compose_validator", "validate-remote-solver-compose.py")
    value = _compose_config()
    module.validate(value)

    bad_cpu = json.loads(json.dumps(value))
    bad_cpu["services"]["worker"]["deploy"]["resources"]["limits"]["cpus"] = "8"
    with pytest.raises(ValueError, match="expected 40"):
        module.validate(bad_cpu)

    bad_nofile = json.loads(json.dumps(value))
    bad_nofile["services"]["worker"]["ulimits"]["nofile"]["soft"] = 1024
    with pytest.raises(ValueError, match="nofile limit"):
        module.validate(bad_nofile)

    gcs = json.loads(json.dumps(value))
    gcs["services"]["api"]["environment"]["AIRFOILFOAM_EVIDENCE_BUCKET"] = "hub-bucket"
    with pytest.raises(ValueError, match="must not receive a GCS bucket"):
        module.validate(gcs)

    detached = json.loads(json.dumps(value))
    detached["services"]["worker"]["volumes"] = []
    with pytest.raises(ValueError, match="does not mount persistent volume"):
        module.validate(detached)


def test_remote_environment_preflight_requires_external_override_and_explicit_volume_retention(
    tmp_path: Path,
) -> None:
    app = tmp_path / "app"
    state = tmp_path / "state"
    app.mkdir()
    state.mkdir()
    override = state / "docker-compose.remote-solver.yml"
    override.write_text("services: {}\n", encoding="utf-8")
    override.chmod(0o644)
    env_file = state / ".env.deploy"
    env_file.write_text(_remote_env(state), encoding="utf-8")
    env_file.chmod(0o600)
    command = [
        sys.executable,
        str(DEPLOY / "deployment-env-preflight.py"),
        "--app-dir",
        str(app),
        "--state-dir",
        str(state),
        "--env-file",
        str(env_file),
    ]

    accepted = subprocess.run(
        command, text=True, capture_output=True, check=False
    )
    assert accepted.returncode == 0, accepted.stderr

    env_file.write_text(_remote_env(state, remote_only=""), encoding="utf-8")
    rejected = subprocess.run(
        command, text=True, capture_output=True, check=False
    )
    assert rejected.returncode == 2
    assert "explicit remote-only=false" in rejected.stderr


@pytest.mark.parametrize(
    "token",
    (
        "",
        "too-short",
        '"quoted-remote-solver-control-plane-token-at-least-32-bytes"',
        "remote-solver-control-plane-token-with whitespace-at-least-32-bytes",
    ),
)
def test_remote_environment_preflight_rejects_unsafe_control_plane_token(
    tmp_path: Path, token: str
) -> None:
    app = tmp_path / "app"
    state = tmp_path / "state"
    app.mkdir()
    state.mkdir()
    override = state / "docker-compose.remote-solver.yml"
    override.write_text("services: {}\n", encoding="utf-8")
    override.chmod(0o644)
    env_file = state / ".env.deploy"
    env_file.write_text(
        _remote_env(state, control_plane_token=token), encoding="utf-8"
    )
    env_file.chmod(0o600)

    completed = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "deployment-env-preflight.py"),
            "--app-dir",
            str(app),
            "--state-dir",
            str(state),
            "--env-file",
            str(env_file),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "remote-solver deployment requires" in completed.stderr


def test_remote_rollback_preserves_an_empty_previous_engine_key_list() -> None:
    source = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(encoding="utf-8")

    assert "mapfile -t receipt_values" in source
    assert 'old_keys="${receipt_values[6]}"' in source
    assert (
        "IFS=$'\\t' read -r api_image worker_image api_ref worker_ref "
        "old_build old_expected old_keys"
    ) not in source


def test_remote_engine_maintenance_rejects_stale_or_incomplete_queue_observation() -> None:
    source = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(encoding="utf-8")
    queue_guard_start = source.index("queue_activity()")
    queue_guard_end = source.index("\ndatabase_activity()", queue_guard_start)
    queue_guard = source[queue_guard_start:queue_guard_end]

    assert 'observation_state != "fresh"' in queue_guard
    assert 'not isinstance(observed_at, str)' in queue_guard
    assert 'observation_error is not None' in queue_guard
    assert "engine queue observation is not fresh and complete" in queue_guard
    assert "QUEUE_STALE_REFRESH_WARMUP_MILLISECONDS=45000" in source
    assert "QUEUE_STALE_REFRESH_HTTP_TIMEOUT_SECONDS=20" in source
    assert "curl -sS --max-time" in queue_guard
    assert "curl -fsS" not in queue_guard
    assert '"$http_status" != "200" && "$http_status" != "503"' in queue_guard
    assert 'queue.get("queue_refresh_in_progress") is True' in queue_guard
    assert 'queue.get("queue_refresh_in_progress") is not False' in queue_guard
    assert 'elif http_status != "200"' in queue_guard
    assert source.count('queue_activity 2>&1') >= 3
    assert "time.monotonic_ns()" in source
    assert "trap clear_queue_response EXIT" in queue_guard


def test_remote_queue_gate_retries_only_a_503_stale_refresh_until_a_fresh_200(
    tmp_path: Path,
) -> None:
    stale = _fresh_remote_queue()
    stale["queue_observation_state"] = "stale"
    stale["queue_refresh_in_progress"] = True

    completed = _run_remote_queue_gate(
        tmp_path, [(503, stale), (200, _fresh_remote_queue())]
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""
    assert (tmp_path / "response-index").read_text(encoding="utf-8") == "2"


def test_remote_queue_gate_accepts_a_fresh_successor_after_35_stale_seconds(
    tmp_path: Path,
) -> None:
    stale = _fresh_remote_queue()
    stale["queue_observation_state"] = "stale"
    stale["queue_refresh_in_progress"] = True

    completed = _run_remote_queue_gate(
        tmp_path,
        [(200, stale)] * 35 + [(200, _fresh_remote_queue())],
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == ""
    assert (tmp_path / "response-index").read_text(encoding="utf-8") == "36"


def test_remote_queue_gate_rejects_503_false_positives_without_retry(
    tmp_path: Path,
) -> None:
    fresh_503 = _fresh_remote_queue()
    stale_with_error = _fresh_remote_queue()
    stale_with_error["queue_observation_state"] = "stale"
    stale_with_error["queue_refresh_in_progress"] = True
    stale_with_error["queue_observation_error"] = "refresh failed"
    stale_incomplete = _fresh_remote_queue()
    stale_incomplete["queue_observation_state"] = "stale"
    stale_incomplete["queue_refresh_in_progress"] = True
    stale_incomplete.pop("inspection_workers")
    legacy_empty_503 = {
        "queue_depth": 0,
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "active": [],
        "reserved": [],
        "scheduled": [],
        "worker_queues_error": None,
        "worker_runtime_error": None,
    }

    for name, payload in (
        ("fresh", fresh_503),
        ("errored", stale_with_error),
        ("incomplete", stale_incomplete),
        ("legacy", legacy_empty_503),
    ):
        completed = _run_remote_queue_gate(tmp_path / name, [(503, payload)])
        assert completed.returncode == 12
        assert (tmp_path / name / "response-index").read_text(encoding="utf-8") == "1"


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("worker_queues_error", "worker discovery failed"),
        ("worker_runtime_error", "worker runtime failed"),
        ("inspection_errors", {"active": "inspect failed"}),
    ),
)
def test_remote_queue_gate_keeps_legacy_worker_errors_fail_closed(
    tmp_path: Path, field: str, value: object
) -> None:
    legacy = {
        "queue_depth": 0,
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "active": [],
        "reserved": [],
        "scheduled": [],
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "inspection_errors": {},
    }
    legacy[field] = value

    completed = _run_remote_queue_gate(tmp_path, [(200, legacy)])

    assert completed.returncode == 12
    assert (tmp_path / "response-index").read_text(encoding="utf-8") == "1"


@pytest.mark.parametrize("refresh_flag", (True, 0, "false"))
def test_remote_queue_gate_rejects_a_refreshing_or_mistyped_legacy_null_state(
    tmp_path: Path, refresh_flag: object
) -> None:
    legacy_refreshing = {
        "queue_observation_state": None,
        "queue_observed_at": None,
        "queue_refresh_in_progress": refresh_flag,
        "queue_observation_error": None,
        "queue_depth": 0,
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "active": [],
        "reserved": [],
        "scheduled": [],
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "inspection_errors": {},
    }

    completed = _run_remote_queue_gate(tmp_path, [(200, legacy_refreshing)])

    assert completed.returncode == 12
    assert (tmp_path / "response-index").read_text(encoding="utf-8") == "1"


def test_remote_queue_gate_exhausts_its_stale_refresh_window_fail_closed(
    tmp_path: Path,
) -> None:
    stale = _fresh_remote_queue()
    stale["queue_observation_state"] = "stale"
    stale["queue_refresh_in_progress"] = True
    responses = [(200, stale)] * 50

    completed = _run_remote_queue_gate(tmp_path, responses)

    assert completed.returncode == 12
    assert "did not publish a fresh exact-zero snapshot" in completed.stderr
    consumed = int((tmp_path / "response-index").read_text(encoding="utf-8"))
    assert 0 < consumed < len(responses)


def test_remote_queue_gate_rejects_a_fresh_response_completed_after_deadline(
    tmp_path: Path,
) -> None:
    completed = _run_remote_queue_gate(
        tmp_path,
        [(200, _fresh_remote_queue())],
        curl_advance_milliseconds=45001,
    )

    assert completed.returncode == 12
    assert "did not publish a fresh exact-zero snapshot within 45s" in completed.stderr
    assert (tmp_path / "response-index").read_text(encoding="utf-8") == "1"


def test_remote_rollback_returns_containers_to_normal_compose_references() -> None:
    source = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(encoding="utf-8")

    bootstrap = source.index("rollback_compose up -d --no-build")
    normalization = source.index(
        'require_recreate_safe "before normalized 2406 rollback reference recreate"'
    )
    normal_recreate = source.index(
        "compose up -d --no-build --no-deps --force-recreate api worker node-api",
        normalization,
    )
    restored_pools = source.index("UPDATE solver_execution_pools", normal_recreate)

    assert bootstrap < normalization < normal_recreate < restored_pools


def test_remote_cutover_state_is_source_bound_restartable_and_tamper_evident(
    tmp_path: Path,
) -> None:
    module = _module("remote_cutover_state", "remote-solver2606-cutover-state.py")
    env_file = tmp_path / ".env.deploy"
    receipt_file = tmp_path / "receipt.json"
    attestation_file = tmp_path / "attestation.json"
    env_file.write_text(_pending_env(), encoding="utf-8")
    env_file.chmod(0o600)

    assert (
        module.validate(
            env_file,
            receipt_file,
            attestation_file,
            current_source_revision=REVISION,
            current_source_tree_sha256=TREE,
        )
        == "pending-pre-canary"
    )
    with pytest.raises(ValueError, match="different source revision"):
        module.validate(
            env_file,
            receipt_file,
            attestation_file,
            current_source_revision="f" * 40,
            current_source_tree_sha256=TREE,
        )

    receipt_file.write_text(json.dumps(_volume_receipt()) + "\n", encoding="utf-8")
    receipt_file.chmod(0o600)
    receipt_sha = hashlib.sha256(receipt_file.read_bytes()).hexdigest()
    attestation_file.write_text(
        json.dumps(_attestation(receipt_sha), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    attestation_file.chmod(0o600)
    attestation_sha = hashlib.sha256(attestation_file.read_bytes()).hexdigest()
    env_file.write_text(
        _pending_env(receipt_sha=receipt_sha, attestation_sha=attestation_sha),
        encoding="utf-8",
    )
    assert module.validate(env_file, receipt_file, attestation_file) == "pending-attested"

    complete = _pending_env(
        receipt_sha=receipt_sha, attestation_sha=attestation_sha
    ).replace("REMOTE_SOLVER2606_CUTOVER_PENDING=1", "REMOTE_SOLVER2606_CUTOVER_PENDING=0").replace(
        "REMOTE_SOLVER2606_CUTOVER_COMPLETE=0",
        "REMOTE_SOLVER2606_CUTOVER_COMPLETE=1",
    )
    for key in (
        "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING",
        "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING",
        "REMOTE_SOLVER2606_CUTOVER_PHASE",
        "REMOTE_SOLVER2606_TARGET_BUILD_ID",
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION",
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256",
        "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID",
    ):
        complete = complete.replace(
            next(line for line in complete.splitlines() if line.startswith(f"{key}=")) + "\n",
            f"{key}=\n",
        )
    env_file.write_text(complete, encoding="utf-8")
    assert module.validate(env_file, receipt_file, attestation_file) == "complete"

    changed = _attestation(receipt_sha)
    changed["backupManifestSha256"] = "e" * 64
    attestation_file.write_text(json.dumps(changed, sort_keys=True) + "\n")
    changed_sha = hashlib.sha256(attestation_file.read_bytes()).hexdigest()
    env_file.write_text(complete.replace(attestation_sha, changed_sha))
    with pytest.raises(ValueError, match="source/recovery binding differs"):
        module.validate(env_file, receipt_file, attestation_file)


def test_volume_receipt_is_no_clobber_persisted_and_recovery_bound(
    tmp_path: Path,
) -> None:
    source = tmp_path / ".volume-receipt.tmp"
    receipt = tmp_path / "volume-receipt.json"
    attestation = tmp_path / "volume-attestation.json"
    source.write_text(json.dumps(_volume_receipt()) + "\n", encoding="utf-8")
    source.chmod(0o600)

    persisted = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "persist-json-receipt.py"),
            "--profile",
            "opencfd2606-volume-canary",
            "--source",
            str(source),
            "--destination",
            str(receipt),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert persisted.returncode == 0, persisted.stderr
    assert not source.exists()
    assert stat.S_IMODE(receipt.stat().st_mode) == 0o600

    attested = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "attest-remote-solver2606-volume.py"),
            "--receipt",
            str(receipt),
            "--destination",
            str(attestation),
            "--source-revision",
            REVISION,
            "--source-tree-sha256",
            TREE,
            "--backup-manifest-sha256",
            BACKUP_SHA,
            "--rollback-receipt-sha256",
            ROLLBACK_SHA,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert attested.returncode == 0, attested.stderr
    assert attested.stdout.strip() == hashlib.sha256(attestation.read_bytes()).hexdigest()
    assert stat.S_IMODE(attestation.stat().st_mode) == 0o600
    payload = json.loads(attestation.read_text())
    assert payload["receiptSha256"] == hashlib.sha256(receipt.read_bytes()).hexdigest()
    assert payload["sourceRevision"] == REVISION
    assert payload["backupManifestSha256"] == BACKUP_SHA

    repeated = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "attest-remote-solver2606-volume.py"),
            "--receipt",
            str(receipt),
            "--destination",
            str(attestation),
            "--source-revision",
            REVISION,
            "--source-tree-sha256",
            TREE,
            "--backup-manifest-sha256",
            BACKUP_SHA,
            "--rollback-receipt-sha256",
            ROLLBACK_SHA,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert repeated.returncode == 14
    assert "already exists" in repeated.stderr


def test_remote_deployment_scripts_keep_hub_and_volume_cutovers_disjoint() -> None:
    canonical = (DEPLOY / "rebuild-engine.sh").read_text(encoding="utf-8")
    remote = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(
        encoding="utf-8"
    )
    redeploy = (DEPLOY / "vps-redeploy.sh").read_text(encoding="utf-8")

    assert "cannot run for AIRFOILFOAM_DEPLOYMENT_ROLE" in canonical
    assert "rebuild-remote-solver-engine.sh" in canonical
    assert "COMPOSE_FILE_ARGS" in canonical
    assert "openfoam_2606_volume_canary.py" in remote
    assert "openfoam_2606_canary.py" not in remote.replace(
        "openfoam_2606_volume_canary.py", ""
    )
    assert "campaign-successor" in remote
    assert "ADMIN_COOKIE" not in remote
    assert "AIRFOILFOAM_EVIDENCE_BUCKET=" not in remote
    assert "COMPOSE_FILE_ARGS" in remote and "require_recreate_safe" in remote
    assert "remote-solver2606-cutover-state.py" in redeploy


def test_completed_remote_cutover_uses_guarded_engine_maintenance_path() -> None:
    source = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(
        encoding="utf-8"
    )
    maintenance_start = source.index("perform_complete_runtime_maintenance()")
    maintenance_end = source.index("\nmain() {", maintenance_start)
    maintenance = source[maintenance_start:maintenance_end]

    pause_transfers = maintenance.index('set_remote_transfer_paused "true"')
    drain_transfers = maintenance.index(
        'wait_remote_transfer_quiescence "before writer stop"', pause_transfers
    )
    stop = maintenance.index("stop_writers", drain_transfers)
    disable = maintenance.index("disable_all_opencfd_pools", stop)
    first_idle = maintenance.index(
        'require_maintenance_safe "before image build"', disable
    )
    build = maintenance.index(
        'compose build api worker node-api sweeper media-repair', first_idle
    )
    second_idle = maintenance.index(
        'require_maintenance_safe "after image build"', build
    )
    stable_idle = maintenance.index(
        'require_maintenance_safe "stabilized before service recreate"', second_idle
    )
    env_update = maintenance.index("set_env_vars_atomic", stable_idle)
    recreate = maintenance.index(
        "compose up -d --no-build --no-deps --force-recreate api worker node-api",
        env_update,
    )
    live_proof = maintenance.index(
        'validate_live_2606_volume_runtime "$ACTION"', recreate
    )
    nofile_proof = maintenance.index('limits.get("nofile")', live_proof)
    pool_restore = maintenance.index("UPDATE solver_execution_pools", nofile_proof)
    writer_restore = maintenance.index("restore_writers", pool_restore)

    assert (
        pause_transfers
        < drain_transfers
        < stop
        < disable
        < first_idle
        < build
        < second_idle
        < stable_idle
        < env_update
        < recreate
        < live_proof
        < nofile_proof
        < pool_restore
        < writer_restore
    )
    maintenance_db_start = source.index("maintenance_database_activity()")
    maintenance_db_end = source.index("\nrequire_idle()", maintenance_db_start)
    maintenance_db = source[maintenance_db_start:maintenance_db_end]
    assert "active_promises" not in maintenance_db
    assert "live_jobs" in maintenance_db
    assert "unsettled_deliveries" in maintenance_db
    assert (
        "state NOT IN ('delivered','superseded','blocked')"
        in maintenance_db
    )
    assert "unsettled_cancellations" in maintenance_db
    assert "running_media_repairs" in maintenance_db
    assert "terminal_completed_ingests" in maintenance_db
    assert "engine_state IS DISTINCT FROM 'completed'" in maintenance_db
    assert "OR engine_job_id IS NULL" in maintenance_db
    assert "OR btrim(engine_job_id) = ''" in maintenance_db
    assert "engine_state = 'completed'" in maintenance_db
    assert "engine_job_id IS NOT NULL" in maintenance_db
    assert "btrim(engine_job_id) <> ''" in maintenance_db
    assert (
        'key != "terminal_completed_ingests"'
        in maintenance_db
    )

    strict_db_start = source.index("database_activity()")
    strict_db_end = source.index(
        "\nmaintenance_database_activity()", strict_db_start
    )
    strict_db = source[strict_db_start:strict_db_end]
    assert "status IN ('pending','submitted','running','ingesting')" in strict_db
    assert "terminal_completed_ingests" not in strict_db

    gate_start = source.index("require_maintenance_safe()")
    gate_end = source.index("\nwait_http()", gate_start)
    gate = source[gate_start:gate_end]
    writer_check = gate.index('writer_state sweeper')
    writer_stopped = gate.index('control-plane writers are not stopped', writer_check)
    maintenance_probe = gate.index('maintenance_database_activity', writer_stopped)
    assert writer_check < writer_stopped < maintenance_probe
    assert 'if [[ "$state" == "complete" ]]; then\n    perform_complete_runtime_maintenance' in source


def test_remote_maintenance_pause_is_a_real_transfer_admission_gate() -> None:
    deploy = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(
        encoding="utf-8"
    )
    schema = (ROOT / "packages/db/src/schema.ts").read_text(encoding="utf-8")
    transfer = (ROOT / "apps/sweeper/src/remote-solver.ts").read_text(
        encoding="utf-8"
    )
    migration = (
        ROOT
        / "packages/db/migrations/0088_remote_transfer_maintenance_fence.sql"
    ).read_text(encoding="utf-8")

    assert (
        'remoteSolverTransferPaused: boolean("remote_solver_transfer_paused")'
        in schema
    )
    assert (
        'ADD COLUMN IF NOT EXISTS "remote_solver_transfer_paused"' in migration
    )
    assert "settings?.remoteSolverTransferPaused" in transfer
    assert "set_remote_transfer_paused()" in deploy
    assert "wait_remote_transfer_quiescence()" in deploy
