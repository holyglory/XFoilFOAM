from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
REPAIR = ROOT / "scripts" / "deploy" / "repair-pending-node-api.sh"
MANIFEST = ROOT / "scripts" / "deploy" / "deployment-source-manifest.py"
STATE_TOOL = ROOT / "scripts" / "deploy" / "opencfd2606_cutover_state.py"
PREFLIGHT = ROOT / "scripts" / "deploy" / "deployment-env-preflight.py"
BOUND_REVISION = "63385777be7323777906fde44bdb9fa9b5cc0d6d"
TARGET_REVISION = "b" * 40
OLD_IMAGE = "sha256:" + "1" * 64
NEW_IMAGE = "sha256:" + "2" * 64
TARGET_API_SHA = "e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"

DB_SNAPSHOT = {
    "poolRows": 1,
    "poolEnabled": False,
    "cutovers": [
        {
            "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "status": "prepared",
            "canaryAttestationId": None,
            "targetPlanRevisionId": None,
            "finalizedAt": None,
            "completedAt": None,
        }
    ],
    "attestationCount": 0,
}


def _write(path: Path, value: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    if executable:
        path.chmod(0o755)


def _git_file(revision: str, path: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=ROOT)


def _seal(root: Path, revision: str, *, tool: Path | None = None) -> tuple[str, int]:
    verifier = tool or root / "scripts/deploy/deployment-source-manifest.py"
    result = subprocess.run(
        [
            "python3",
            str(verifier),
            "--create",
            "--root",
            str(root),
            "--manifest",
            str(root / ".deployment-source.json"),
            "--revision",
            revision,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    _, tree, count = result.stdout.strip().split("\t")
    return tree, int(count)


def _source_pair(tmp_path: Path) -> tuple[Path, Path, Path, str]:
    bound = tmp_path / "bound"
    target = tmp_path / "target"
    for root in (bound, target):
        deploy = root / "scripts/deploy"
        deploy.mkdir(parents=True)
        shutil.copy2(MANIFEST, deploy / MANIFEST.name)
        shutil.copy2(STATE_TOOL, deploy / STATE_TOOL.name)
        shutil.copy2(PREFLIGHT, deploy / PREFLIGHT.name)
        _write(root / "docker-compose.deploy.yml", "services: {}\n")

    bound_api = bound / "apps/api/src/admin-routes.ts"
    bound_api.parent.mkdir(parents=True)
    bound_api.write_bytes(_git_file(BOUND_REVISION, "apps/api/src/admin-routes.ts"))
    target_api = target / "apps/api/src/admin-routes.ts"
    target_api.parent.mkdir(parents=True)
    target_api.write_bytes(_git_file("3c67259", "apps/api/src/admin-routes.ts"))

    bound_test = bound / "apps/api/test/solver-execution-pool-admission.test.ts"
    bound_test.parent.mkdir(parents=True)
    bound_test.write_bytes(
        _git_file(BOUND_REVISION, "apps/api/test/solver-execution-pool-admission.test.ts")
    )
    target_test = target / "apps/api/test/solver-execution-pool-admission.test.ts"
    target_test.parent.mkdir(parents=True)
    target_test.write_bytes(
        _git_file("3c67259", "apps/api/test/solver-execution-pool-admission.test.ts")
    )

    bound_tree, bound_count = _seal(bound, BOUND_REVISION)
    repair_text = REPAIR.read_text().replace(
        'EXPECTED_BOUND_SOURCE_TREE_SHA256="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"',
        f'EXPECTED_BOUND_SOURCE_TREE_SHA256="{bound_tree}"',
    ).replace(
        'EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"',
        f'EXPECTED_BOUND_SOURCE_FILE_COUNT="{bound_count}"',
    )
    repair_exec = target / "scripts/deploy/repair-pending-node-api.sh"
    _write(repair_exec, repair_text, executable=True)
    _write(target / "tests/test_pending_cutover_node_api_repair.py", "# contract fixture\n")
    _seal(target, TARGET_REVISION, tool=bound / "scripts/deploy/deployment-source-manifest.py")
    return bound, target, repair_exec, bound_tree


def _fake_runtime(tmp_path: Path) -> tuple[Path, Path]:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    call_log = tmp_path / "docker-calls.log"
    _write(
        fake_bin / "docker",
        r'''#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALL_LOG"
joined=" $* "
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then exit 0; fi
if [[ "${1:-}" == "ps" ]]; then
  if [[ "${FAKE_HIDDEN_WORKER:-0}" == "1" ]]; then printf 'worker-hidden\n'; fi
  exit 0
fi
if [[ "${1:-}" == "build" ]]; then
  touch "$BUILD_MARKER"
  if [[ "${FAKE_ENV_MUTATES_AFTER_BUILD:-0}" == "1" ]]; then printf '# drift\n' >>"$ENV_FILE"; fi
  exit 0
fi
if [[ "$joined" == *" config --services "* ]]; then
  printf 'api\nworker\nworker-foundation14\n'
  exit 0
fi
if [[ "$joined" == *" ps --status running -q sweeper "* ]]; then
  [[ "${FAKE_SWEEPER_RUNNING:-0}" == "1" ]] && printf 'sweeper-id\n'
  exit 0
fi
if [[ "$joined" == *" ps --status running -q worker-foundation14 "* ]]; then
  [[ "${FAKE_OPTIONAL_WORKER_RUNNING:-0}" == "1" ]] && printf 'foundation-id\n'
  exit 0
fi
if [[ "$joined" == *" exec -T postgres psql "* ]]; then
  if [[ "${FAKE_DB_MUTATES_AFTER_BUILD:-0}" == "1" && -f "$BUILD_MARKER" ]]; then
    printf '{"poolRows":1,"poolEnabled":true,"cutovers":[],"attestationCount":0}\n'
  else
    printf '%s\n' "$FAKE_DB_SNAPSHOT"
  fi
  exit 0
fi
if [[ "$joined" == *" exec -T worker sh -lc "* ]]; then
  if [[ "${FAKE_ACTIVE_AFTER_BUILD:-0}" == "1" && -f "$BUILD_MARKER" ]]; then
    printf '123 simpleFoam -case live\n'
  fi
  exit 0
fi
if [[ "$joined" == *" ps --status running -q api "* ]]; then printf 'api-id\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q worker "* ]]; then printf 'worker-id\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q node-api "* ]]; then
  [[ -s "$NODE_ID_FILE" ]] && cat "$NODE_ID_FILE"
  exit 0
fi
if [[ "$joined" == *" up -d --no-deps --force-recreate node-api "* ]]; then
  if [[ "${FAKE_RECREATE_FAIL_ONCE:-0}" == "1" && ! -e "$RECREATE_FAILURE_MARKER" ]]; then
    touch "$RECREATE_FAILURE_MARKER"
    exit 55
  fi
  image="$(cat "$TAG_IMAGE_FILE")"
  printf '%s\n' "$image" >"$NODE_IMAGE_FILE"
  if [[ "$image" == "$NEW_IMAGE" ]]; then printf 'node-new\n' >"$NODE_ID_FILE"; else printf 'node-old-restored\n' >"$NODE_ID_FILE"; fi
  exit 0
fi
if [[ "$joined" == *" config "* ]]; then exit 0; fi
if [[ "${1:-}" == "inspect" ]]; then
  id="${@: -1}"
  if [[ "$id" == "api-id" ]]; then
    printf 'api-id|sha256:%064d|2026-07-17T00:00:00Z|0\n' 3
  elif [[ "$id" == "worker-id" ]]; then
    if [[ "${FAKE_ENGINE_MUTATES_AFTER_BUILD:-0}" == "1" && -f "$BUILD_MARKER" ]]; then
      printf 'worker-id|sha256:%064d|2026-07-17T00:00:01Z|1\n' 9
    else
      printf 'worker-id|sha256:%064d|2026-07-17T00:00:00Z|0\n' 4
    fi
  elif [[ "$id" == node-* ]]; then
    cat "$NODE_IMAGE_FILE"
  else
    exit 2
  fi
  exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  ref="${@: -1}"
  case "$ref" in
    app-node-api|app-node-api:latest) cat "$TAG_IMAGE_FILE" ;;
    airfoils-pro/node-api-cutover-repair:*) printf '%s\n' "$NEW_IMAGE" ;;
    airfoils-pro/node-api-cutover-repair-rollback:*) printf '%s\n' "$OLD_IMAGE" ;;
    "$OLD_IMAGE"|"$NEW_IMAGE")
      if [[ "$joined" == *" --format "* ]]; then printf '%s\n' "$ref"; fi
      ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "tag" ]]; then
  source="${3:-}"; target="${4:-}"
  if [[ "$target" == "app-node-api" || "$target" == "app-node-api:latest" ]]; then printf '%s\n' "$source" >"$TAG_IMAGE_FILE"; fi
  exit 0
fi
if [[ "${1:-}" == "exec" ]]; then
  printf '%s  /app/apps/api/src/admin-routes.ts\n' "$TARGET_API_SHA"
  exit 0
fi
printf 'unsupported fake docker call: %s\n' "$*" >&2
exit 99
''',
        executable=True,
    )
    _write(
        fake_bin / "curl",
        r'''#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"
if [[ "$url" == *":8000/health" ]]; then
  printf '%s\n' "$FAKE_ENGINE_HEALTH"
elif [[ "$url" == *":8000/queue" ]]; then
  printf '%s\n' "$FAKE_ENGINE_QUEUE"
elif [[ "$url" == *":4000/health" ]]; then
  [[ "${FAKE_NODE_HEALTH_FAIL:-0}" != "1" ]]
else
  exit 2
fi
''',
        executable=True,
    )
    _write(fake_bin / "sleep", "#!/usr/bin/env bash\nexit 0\n", executable=True)
    return fake_bin, call_log


def _env(
    tmp_path: Path,
    bound: Path,
    target: Path,
    repair_exec: Path,
    bound_tree: str,
) -> tuple[dict[str, str], Path, Path]:
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    env_file = state_dir / ".env.deploy"
    env_file.write_text(
        "\n".join(
            [
                "ENGINE_EXPECTED_BUILD_ID=prod-test",
                "AIRFOILFOAM_EVIDENCE_BUCKET=test-bucket",
                "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
                "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
                "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true",
                f"AIRFOILFOAM_CONTROL_PLANE_TOKEN={'x' * 64}",
                "OPENCFD2606_CUTOVER_PENDING=1",
                "OPENCFD2606_CUTOVER_COMPLETE=0",
                "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=0",
                "OPENCFD2606_CANARY_ATTESTATION_ID=",
                "OPENCFD2606_CANARY_RECEIPT_EXPECTED=0",
                "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=",
                f"OPENCFD2606_CUTOVER_SOURCE_REVISION={BOUND_REVISION}",
                f"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256={bound_tree}",
                "",
            ]
        )
    )
    env_file.chmod(0o600)
    app_link = tmp_path / "app"
    app_link.symlink_to(bound, target_is_directory=True)
    fake_bin, call_log = _fake_runtime(tmp_path)
    node_id_file = tmp_path / "node-id"
    node_image_file = tmp_path / "node-image"
    tag_image_file = tmp_path / "tag-image"
    node_id_file.write_text("node-old\n")
    node_image_file.write_text(f"{OLD_IMAGE}\n")
    tag_image_file.write_text(f"{OLD_IMAGE}\n")
    engine_health = {
        "build_id": "prod-test",
        "default_engine": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
            "numerics_revision": "1",
            "adapter_contract_version": 1,
        },
        "evidence_storage": {
            "backend": "gcs",
            "bucket": "test-bucket",
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": 10,
            "remote_only": True,
        },
    }
    engine_queue = {
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "job_ids": [],
        "inspection_errors": {},
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "worker_queues": [
            {
                "worker": "worker@test",
                "queues": ["openfoam-opencfd-2606"],
                "execution_pool": "openfoam-opencfd-2606",
                "engine": {
                    "family": "openfoam",
                    "distribution": "opencfd",
                    "version": "2606",
                    "numerics_revision": "1",
                    "adapter_contract_version": 1,
                },
            }
        ],
    }
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "STAGING_DIR": str(target),
        "APP_DIR": str(app_link),
        "AIRFOILS_PRO_STATE_DIR": str(state_dir),
        "ENV_FILE": str(env_file),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "REPAIR_RECEIPT_FILE": str(state_dir / "repair.json"),
        "OPENCFD2606_CANARY_RECEIPT_FILE": str(state_dir / "canary.json"),
        "EXPECTED_TARGET_SOURCE_REVISION": TARGET_REVISION,
        "CALL_LOG": str(call_log),
        "BUILD_MARKER": str(tmp_path / "built"),
        "NODE_ID_FILE": str(node_id_file),
        "NODE_IMAGE_FILE": str(node_image_file),
        "TAG_IMAGE_FILE": str(tag_image_file),
        "RECREATE_FAILURE_MARKER": str(tmp_path / "recreate-failed"),
        "OLD_IMAGE": OLD_IMAGE,
        "NEW_IMAGE": NEW_IMAGE,
        "TARGET_API_SHA": TARGET_API_SHA,
        "FAKE_DB_SNAPSHOT": json.dumps(DB_SNAPSHOT, separators=(",", ":")),
        "FAKE_ENGINE_HEALTH": json.dumps(engine_health, separators=(",", ":")),
        "FAKE_ENGINE_QUEUE": json.dumps(engine_queue, separators=(",", ":")),
        "REPAIR_EXEC": str(repair_exec),
    }
    return env, env_file, call_log


@pytest.fixture
def harness(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    bound, target, repair_exec, bound_tree = _source_pair(tmp_path)
    return _env(tmp_path, bound, target, repair_exec, bound_tree)


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [env["REPAIR_EXEC"]],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _calls(path: Path) -> str:
    return path.read_text() if path.exists() else ""


def test_repair_changes_only_node_api_and_persists_exact_applied_journal(
    harness: tuple[dict[str, str], Path, Path],
) -> None:
    env, env_file, call_log = harness
    original_env = env_file.read_bytes()

    completed = _run(env)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert env_file.read_bytes() == original_env
    receipt = json.loads(Path(env["REPAIR_RECEIPT_FILE"]).read_text())
    assert receipt["status"] == "applied"
    assert receipt["boundSourceRevision"] == BOUND_REVISION
    assert receipt["repairSourceRevision"] == TARGET_REVISION
    assert receipt["nodeApiImageBefore"] == OLD_IMAGE
    assert receipt["nodeApiImageAfter"] == NEW_IMAGE
    assert receipt["sourceChangePaths"] == [
        "apps/api/src/admin-routes.ts",
        "apps/api/test/solver-execution-pool-admission.test.ts",
        "scripts/deploy/repair-pending-node-api.sh",
        "tests/test_pending_cutover_node_api_repair.py",
    ]
    calls = _calls(call_log)
    assert "build --file" in calls
    assert "force-recreate node-api" in calls
    assert "force-recreate api" not in calls
    assert "force-recreate worker" not in calls


def test_applied_replay_is_observe_only_and_idempotent(
    harness: tuple[dict[str, str], Path, Path],
) -> None:
    env, _, call_log = harness
    assert _run(env).returncode == 0
    before = _calls(call_log)

    replay = _run(env)

    assert replay.returncode == 0, replay.stdout + replay.stderr
    after = _calls(call_log)[len(before) :]
    assert "build --file" not in after
    assert "force-recreate node-api" not in after
    assert "already applied" in replay.stdout


def test_failed_recreate_rolls_back_and_prepared_journal_replays(
    harness: tuple[dict[str, str], Path, Path],
) -> None:
    env, _, _ = harness
    env["FAKE_RECREATE_FAIL_ONCE"] = "1"

    failed = _run(env)

    assert failed.returncode != 0
    journal = json.loads(Path(env["REPAIR_RECEIPT_FILE"]).read_text())
    assert journal["status"] == "prepared"
    assert Path(env["TAG_IMAGE_FILE"]).read_text().strip() == OLD_IMAGE
    assert Path(env["NODE_IMAGE_FILE"]).read_text().strip() == OLD_IMAGE

    replay = _run(env)
    assert replay.returncode == 0, replay.stdout + replay.stderr
    assert json.loads(Path(env["REPAIR_RECEIPT_FILE"]).read_text())["status"] == "applied"
    assert Path(env["NODE_IMAGE_FILE"]).read_text().strip() == NEW_IMAGE


@pytest.mark.parametrize(
    ("flag", "message"),
    [
        ("FAKE_SWEEPER_RUNNING", "sweeper to remain stopped"),
        ("FAKE_OPTIONAL_WORKER_RUNNING", "optional engine worker"),
        ("FAKE_HIDDEN_WORKER", "hidden running engine workers"),
    ],
)
def test_repair_rejects_scheduler_and_hidden_worker_activity_before_build(
    harness: tuple[dict[str, str], Path, Path], flag: str, message: str
) -> None:
    env, _, call_log = harness
    env[flag] = "1"

    completed = _run(env)

    assert completed.returncode != 0
    assert message in completed.stderr
    assert "build --file" not in _calls(call_log)


@pytest.mark.parametrize(
    ("flag", "message"),
    [
        ("FAKE_ENGINE_MUTATES_AFTER_BUILD", "Engine container/image identity changed"),
        ("FAKE_ACTIVE_AFTER_BUILD", "active OpenFOAM work"),
        ("FAKE_DB_MUTATES_AFTER_BUILD", "execution pool is not uniquely disabled"),
        ("FAKE_ENV_MUTATES_AFTER_BUILD", "deployment environment changed"),
    ],
)
def test_repair_rechecks_every_safety_boundary_after_build(
    harness: tuple[dict[str, str], Path, Path], flag: str, message: str
) -> None:
    env, _, call_log = harness
    env[flag] = "1"

    completed = _run(env)

    assert completed.returncode != 0
    assert message in completed.stderr
    assert "build --file" in _calls(call_log)
    assert "force-recreate node-api" not in _calls(call_log)
    assert Path(env["TAG_IMAGE_FILE"]).read_text().strip() == OLD_IMAGE


def test_repair_rejects_unrelated_source_change_before_build(tmp_path: Path) -> None:
    bound, target, repair_exec, bound_tree = _source_pair(tmp_path)
    _write(target / "src/airfoilfoam/tasks.py", "# unrelated engine change\n")
    _seal(target, TARGET_REVISION, tool=bound / "scripts/deploy/deployment-source-manifest.py")
    env, _, call_log = _env(tmp_path, bound, target, repair_exec, bound_tree)

    completed = _run(env)

    assert completed.returncode == 14
    assert "exact reviewed incident scope" in completed.stderr
    assert "build --file" not in _calls(call_log)


def test_repair_uses_bound_verifier_and_rejects_target_verifier_tampering(
    tmp_path: Path,
) -> None:
    bound, target, repair_exec, bound_tree = _source_pair(tmp_path)
    _write(
        target / "scripts/deploy/deployment-source-manifest.py",
        "#!/usr/bin/env python3\nraise SystemExit(0)\n",
        executable=True,
    )
    _seal(target, TARGET_REVISION, tool=bound / "scripts/deploy/deployment-source-manifest.py")
    env, _, call_log = _env(tmp_path, bound, target, repair_exec, bound_tree)

    completed = _run(env)

    assert completed.returncode == 14
    assert "exact reviewed incident scope" in completed.stderr
    assert "build --file" not in _calls(call_log)


def test_conflicting_existing_journal_fails_without_mutation(
    harness: tuple[dict[str, str], Path, Path],
) -> None:
    env, _, call_log = harness
    receipt = Path(env["REPAIR_RECEIPT_FILE"])
    receipt.write_text('{"schemaVersion":1,"status":"applied"}\n')
    receipt.chmod(0o600)

    completed = _run(env)

    assert completed.returncode != 0
    assert "journal mismatch" in completed.stderr
    assert "build --file" not in _calls(call_log)


def test_production_contract_is_pinned_and_workflow_requires_explicit_dispatch() -> None:
    script = REPAIR.read_text()
    workflow = (ROOT / ".github/workflows/deploy-airfoils-pro.yml").read_text()
    manifest = MANIFEST.read_text()
    assert BOUND_REVISION in script
    assert "52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36" in script
    assert TARGET_API_SHA in script
    assert '".github"' in manifest  # workflow plumbing is intentionally not runtime source.
    assert "pending_cutover_node_api_repair:" in workflow
    assert 'if [[ "$PENDING_CUTOVER_NODE_API_REPAIR" == "true" ]]' in workflow
    assert "repair-pending-node-api.sh" in workflow
    assert "EXPECTED_TARGET_SOURCE_REVISION=$REVISION_Q" in workflow
