from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts/deploy/replay-pending-opencfd2606-rebuild.sh"
MANIFEST = ROOT / "scripts/deploy/deployment-source-manifest.py"
BOUND_REVISION = "63385777be7323777906fde44bdb9fa9b5cc0d6d"
TARGET_REVISION = "c" * 40
SEALED_TARGET_REVISION = "1357897ad7baa77add52738fe5afa022c28bd726"
BUILD_ID = "prod-20260717-63385777be73-r2"
API_IMAGE = "sha256:bc8e23648e9e76424ea36a584f8a825d65fe82a23aa4e4ad89b019197dcc735c"
WORKER_IMAGE = "sha256:42120ef817af19510830d18f99be2b0f8d8739a4b9b235d2ee294e558f64229a"
NODE_IMAGE = "sha256:64ee90e0045a36eace3c57aeb5b3467c1e1f46c5eafb2466b98f8b754cbade32"
NEW_NODE_IMAGE = "sha256:" + "7" * 64
NODE_API_SHA = "e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
NODE_ATTESTATION_SHA = "6f10619510378451e47e8aaa6579e663b879e47ce0af98097680c2b4462ddc62"
FIRST_REPAIR_ENV_SHA = "6891290db1f293b1e4bfca62eacf588b1ad8c110d238ffdcfcd6a952d35eda8c"
COOKIE = "aero_admin=fixture_payload.fixture_signature"
FAILED_RESUME_JOURNAL = (
    '{"boundSourceRevision":"63385777be7323777906fde44bdb9fa9b5cc0d6d",'
    '"buildId":"prod-20260717-63385777be73-r2","exitCode":14,'
    '"purpose":"pending-opencfd2606-queue-probe-resume",'
    '"rebuildScriptSha256":"515e81d52d59d2e4e798daf1bdaf2ff5e51e45cc5c3708d41af20130c2364021",'
    '"runnerSourceRevision":"dfecaca2d35ac655aa647367b4a8b06744a63284",'
    '"runnerSourceTreeSha256":"080fecf211c1e8e623860647bca2cc19e3daaeb8a869f958fc7b7132ca6f7a03",'
    '"schemaVersion":1,"status":"failed",'
    '"updatedAt":"2026-07-17T02:05:29.605145+00:00"}\n'
)

DB_SNAPSHOT = {
    "attestationCount": 0,
    "cutovers": [
        {
            "canaryAttestationId": None,
            "completedAt": None,
            "finalizedAt": None,
            "id": "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee",
            "status": "prepared",
            "targetPlanRevisionId": None,
        }
    ],
    "poolEnabled": False,
    "poolRows": 1,
}


def _write(path: Path, value: str | bytes, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, bytes):
        path.write_bytes(value)
    else:
        path.write_text(value)
    if executable:
        path.chmod(0o755)


def _git_file(revision: str, path: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=ROOT)


def _seal(root: Path, revision: str, *, verifier: Path) -> tuple[str, int]:
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


def _sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _fixture_sources(tmp_path: Path) -> tuple[Path, Path, Path, str, str]:
    bound = tmp_path / "bound"
    target = tmp_path / "target"
    helper_names = (
        "deployment-source-manifest.py",
        "deployment-env-preflight.py",
        "opencfd2606_cutover_state.py",
        "evidence-contract.py",
        "persist-json-receipt.py",
    )
    for helper in helper_names:
        _write(
            bound / "scripts/deploy" / helper,
            _git_file(BOUND_REVISION, f"scripts/deploy/{helper}"),
            executable=True,
        )
    _write(
        bound / "scripts/deploy/rebuild-engine.sh",
        _git_file(BOUND_REVISION, "scripts/deploy/rebuild-engine.sh"),
        executable=True,
    )
    for relative in (
        "apps/api/src/admin-routes.ts",
        "apps/api/src/openfoam-2606-attestation.ts",
        "apps/api/test/openfoam-2606-attestation.test.ts",
        "apps/api/test/solver-execution-pool-admission.test.ts",
        "scripts/deploy/openfoam_2606_canary.py",
        "tests/test_deploy_sweeper_state.py",
        "tests/test_openfoam_2606_canary.py",
    ):
        _write(bound / relative, _git_file(BOUND_REVISION, relative))
    _write(bound / "docker-compose.deploy.yml", "services: {}\n")
    _write(bound / "examples/naca0012.dat", _git_file(BOUND_REVISION, "examples/naca0012.dat"))
    bound_tree, bound_count = _seal(
        bound, BOUND_REVISION, verifier=bound / "scripts/deploy/deployment-source-manifest.py"
    )

    shutil.copytree(bound, target, symlinks=True)
    (target / ".deployment-source.json").unlink()
    for relative in (
        "apps/api/src/admin-routes.ts",
        "apps/api/src/openfoam-2606-attestation.ts",
        "apps/api/test/openfoam-2606-attestation.test.ts",
        "apps/api/test/solver-execution-pool-admission.test.ts",
        "scripts/deploy/openfoam_2606_canary.py",
        "scripts/deploy/repair-pending-node-api.sh",
        "tests/test_deploy_sweeper_state.py",
        "tests/test_openfoam_2606_canary.py",
        "tests/test_pending_cutover_node_api_repair.py",
    ):
        source = ROOT / relative
        # This is a replay of one sealed historical incident, not a synthetic
        # checkout of today's tree. Every target member whose exact digest is
        # pinned by the replay wrapper must come from the same sealed revision;
        # otherwise an unrelated later hardening change makes the fixture fail
        # before it reaches the safety behavior under test.
        source_bytes = _git_file(SEALED_TARGET_REVISION, relative)
        _write(
            target / relative,
            source_bytes,
            executable=os.access(source, os.X_OK),
        )

    fake_rebuild = rb"""#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == "prod-20260717-63385777be73-r2" ]]
[[ "$APP_DIR" == "$EXPECTED_BOUND_DIR" ]]
[[ "$COMPOSE_FILE" == "$EXPECTED_BOUND_DIR/docker-compose.deploy.yml" ]]
[[ "$DEPLOYMENT_MANIFEST_FILE" == "$EXPECTED_BOUND_DIR/.deployment-source.json" ]]
[[ -f "$(dirname "$0")/../../examples/naca0012.dat" ]]
[[ "$(stat -c '%a' "$LOCK_FILE")" == "600" ]]
[[ "$ADMIN_COOKIE" =~ ^aero_admin=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]
fd8="$(readlink /proc/$$/fd/8)"
[[ "$fd8" == "$EXPECTED_CANONICAL_LOCK" ]]
if [[ "${FAKE_CHILD_CREATE_RECEIPT_AND_FAIL:-0}" == "1" ]]; then
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
lines = []
for line in path.read_text().splitlines():
    key = line.split("=", 1)[0]
    lines.append("OPENCFD2606_CANARY_RECEIPT_EXPECTED=1" if key == "OPENCFD2606_CANARY_RECEIPT_EXPECTED" else line)
path.write_text("\n".join(lines) + "\n")
PY
  if [[ "${FAKE_CHILD_CORRUPT_RECEIPT:-0}" == "1" ]]; then
    printf '{"invalid":true}\n' >"$OPENCFD2606_CANARY_RECEIPT_FILE"
  else
    printf '{"schema_version":1,"status":"ok","jobs":[{"job_id":"canary-1"},{"job_id":"canary-2"},{"job_id":"canary-3"}]}\n' >"$OPENCFD2606_CANARY_RECEIPT_FILE"
  fi
  chmod 600 "$OPENCFD2606_CANARY_RECEIPT_FILE"
  exit 56
fi
[[ "${FAKE_CHILD_FAIL:-0}" != "1" ]] || exit 55
if [[ -f "$OPENCFD2606_CANARY_RECEIPT_FILE" ]]; then
  printf 'retained-receipt\n' >"$CHILD_MODE_MARKER"
else
  printf 'pristine\n' >"$CHILD_MODE_MARKER"
fi
python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
updates = {
    "OPENCFD2606_CANARY_ATTESTATION_ID": "11111111-1111-4111-8111-111111111111",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": "a" * 64,
}
lines = []
for line in path.read_text().splitlines():
    key = line.split("=", 1)[0]
    lines.append(f"{key}={updates[key]}" if key in updates else line)
path.write_text("\n".join(lines) + "\n")
PY
printf '{"buildId":"%s","appDir":"%s","compose":"%s","manifest":"%s","fd8":"%s","privateLockMode":"%s","cookieValid":true}\n' \
  "$1" "$APP_DIR" "$COMPOSE_FILE" "$DEPLOYMENT_MANIFEST_FILE" "$fd8" "$(stat -c '%a' "$LOCK_FILE")" >"$CHILD_MARKER"
"""
    _write(target / "scripts/deploy/rebuild-engine.sh", fake_rebuild, executable=True)
    fake_replay_test = b"# wrapper contract fixture\n"
    _write(target / "tests/test_pending_cutover_engine_rebuild_replay.py", fake_replay_test)

    env_text = "\n".join(
        [
            f"AIRFOILFOAM_BUILD_ID={BUILD_ID}",
            f"ENGINE_EXPECTED_BUILD_ID={BUILD_ID}",
            "AIRFOILFOAM_EVIDENCE_BUCKET=airfoils-pro-storage-bucket",
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
    receipt = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-node-api-timeout-repair",
        "status": "applied",
        "boundSourceRevision": BOUND_REVISION,
        "boundSourceTreeSha256": bound_tree,
        "repairSourceRevision": "26b19c9a6f229d76359095958a3a6d8edac0801f",
        "repairSourceTreeSha256": (
            "3f1631f275119fa1d316ecae8d9fe340b91b6f64f27b907780ea7ea1445632dd"
        ),
        "sourceChangeSha256": (
            "1d0f14d1f7d6795ebf108b6c61ebb9e6bde814a0bc37c6850693853b5d4400d3"
        ),
        "deploymentEnvironmentSha256": FIRST_REPAIR_ENV_SHA,
        "nodeApiImageAfter": NODE_IMAGE,
        "sourceChangePaths": [
            "apps/api/src/admin-routes.ts",
            "apps/api/test/solver-execution-pool-admission.test.ts",
            "scripts/deploy/repair-pending-node-api.sh",
            "tests/test_pending_cutover_node_api_repair.py",
        ],
    }
    receipt_text = json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n"

    wrapper = WRAPPER.read_text()
    replacements = {
        'EXPECTED_BOUND_SOURCE_TREE_SHA256="52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"': f'EXPECTED_BOUND_SOURCE_TREE_SHA256="{bound_tree}"',
        'EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"': f'EXPECTED_BOUND_SOURCE_FILE_COUNT="{bound_count}"',
        'EXPECTED_APP_LINK="/opt/airfoils-pro/app"': f'EXPECTED_APP_LINK="{tmp_path / "app"}"',
        'EXPECTED_BOUND_APP_REAL="/opt/airfoils-pro/releases/63385777be7323777906fde44bdb9fa9b5cc0d6d-52c8bd3aa6d5a05d"': f'EXPECTED_BOUND_APP_REAL="{bound}"',
        'EXPECTED_STATE_DIR="/opt/airfoils-pro/state"': f'EXPECTED_STATE_DIR="{tmp_path / "state"}"',
        'EXPECTED_ENV_FILE="/opt/airfoils-pro/state/.env.deploy"': f'EXPECTED_ENV_FILE="{tmp_path / "state" / ".env.deploy"}"',
        'EXPECTED_CANONICAL_LOCK_FILE="/tmp/airfoils-pro-deploy.lock"': f'EXPECTED_CANONICAL_LOCK_FILE="{tmp_path / "canonical.lock"}"',
        'EXPECTED_NODE_REPAIR_RECEIPT_SHA256="1f57f0e664682c22812de55de3be2ff58e205dd11a9eb6a1bd2c1a08545e0c92"': f'EXPECTED_NODE_REPAIR_RECEIPT_SHA256="{_sha(receipt_text.encode())}"',
        'EXPECTED_DEPLOY_ENV_SHA256="c4ff073a4ee698a02cdc70f535f930c93898b69e5f382bf6ac05f965b840acad"': f'EXPECTED_DEPLOY_ENV_SHA256="{_sha(env_text.encode())}"',
        'EXPECTED_REPLAY_REBUILD_SHA256="008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f"': f'EXPECTED_REPLAY_REBUILD_SHA256="{_sha(fake_rebuild)}"',
    }
    for old, new in replacements.items():
        assert old in wrapper
        wrapper = wrapper.replace(old, new)
    wrapper, replacements_count = re.subn(
        r'EXPECTED_REPLAY_TEST_SHA256="[0-9a-f]{64}"',
        f'EXPECTED_REPLAY_TEST_SHA256="{_sha(fake_replay_test)}"',
        wrapper,
        count=1,
    )
    assert replacements_count == 1
    wrapper_path = target / "scripts/deploy/replay-pending-opencfd2606-rebuild.sh"
    _write(wrapper_path, wrapper, executable=True)
    _seal(
        target,
        TARGET_REVISION,
        verifier=bound / "scripts/deploy/deployment-source-manifest.py",
    )
    return bound, target, wrapper_path, env_text, receipt_text


def _fake_runtime(tmp_path: Path) -> tuple[Path, Path, dict[str, Path]]:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    calls = tmp_path / "calls.log"
    runtime = {
        "NODE_TAG_FILE": tmp_path / "node-tag.image",
        "NODE_CONTAINER_IMAGE_FILE": tmp_path / "node-container.image",
        "REPLAY_TAG_FILE": tmp_path / "replay-tag.image",
        "ROLLBACK_TAG_FILE": tmp_path / "rollback-tag.image",
        "RUNTIME_DIR_PATH": Path("/dev/shm")
        / f"airfoils-opencfd2606-replay.test-{hashlib.sha256(str(tmp_path).encode()).hexdigest()[:16]}",
    }
    runtime["NODE_TAG_FILE"].write_text(NODE_IMAGE)
    runtime["NODE_CONTAINER_IMAGE_FILE"].write_text(NODE_IMAGE)
    _write(
        fake_bin / "docker",
        r'''#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$CALL_LOG"
joined=" $* "
resolve_image() {
  case "$1" in
    app-node-api) [[ -f "$NODE_TAG_FILE" ]] && cat "$NODE_TAG_FILE" ;;
    airfoils-pro/node-api-cutover-replay:*) [[ -f "$REPLAY_TAG_FILE" ]] && cat "$REPLAY_TAG_FILE" ;;
    airfoils-pro/node-api-cutover-replay-rollback:*) [[ -f "$ROLLBACK_TAG_FILE" ]] && cat "$ROLLBACK_TAG_FILE" ;;
    sha256:*) printf '%s' "$1" ;;
    app-api) printf '%s' "${FAKE_API_IMAGE:-$API_IMAGE}" ;;
    app-worker) printf '%s' "$WORKER_IMAGE" ;;
    *) return 2 ;;
  esac
}
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then exit 0; fi
if [[ "${1:-}" == "ps" ]]; then exit 0; fi
if [[ "$joined" == *" config --services "* ]]; then printf 'api\nworker\nnode-api\npostgres\nsweeper\n'; exit 0; fi
if [[ "$joined" == *" config "* ]]; then exit 0; fi
if [[ "$joined" == *" ps --status running -q sweeper "* ]]; then [[ "${FAKE_SWEEPER_RUNNING:-0}" == "1" ]] && printf 'sweeper-id\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q api "* ]]; then printf 'api-id\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q worker "* ]]; then printf 'worker-id\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q node-api "* ]]; then printf 'node-id\n'; exit 0; fi
if [[ "$joined" == *" up -d --no-deps --force-recreate node-api "* ]]; then
  if [[ "${FAKE_NODE_RECREATE_FAIL:-0}" == "1" && ! -e "$RECREATE_FAIL_MARKER" ]]; then
    : >"$RECREATE_FAIL_MARKER"
    exit 88
  fi
  cp "$NODE_TAG_FILE" "$NODE_CONTAINER_IMAGE_FILE"
  exit 0
fi
if [[ "$joined" == *" exec -T postgres psql "* ]]; then
  if [[ "${FAKE_POOL_ENABLED:-0}" == "1" ]]; then
    printf '{"poolRows":1,"poolEnabled":true,"cutovers":[],"attestationCount":0}\n'
  else
    printf '%s\n' "$FAKE_DB_SNAPSHOT"
  fi
  exit 0
fi
if [[ "$joined" == *" exec -T worker sh -lc "* ]]; then [[ "${FAKE_ACTIVE_SOLVER:-0}" == "1" ]] && printf '42 simpleFoam -case live\n'; exit 0; fi
if [[ "${1:-}" == "inspect" ]]; then
  id="${@: -1}"
  case "$id" in
    api-id) printf '%s\n' "${FAKE_API_IMAGE:-$API_IMAGE}" ;;
    worker-id) printf '%s\n' "$WORKER_IMAGE" ;;
    node-id) printf '%s\n' "${FAKE_NODE_IMAGE:-$(cat "$NODE_CONTAINER_IMAGE_FILE")}" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "build" ]]; then
  [[ "${FAKE_NODE_BUILD_FAIL:-0}" != "1" ]] || exit 86
  printf '%s' "$NEW_NODE_IMAGE" >"$REPLAY_TAG_FILE"
  exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  ref="${@: -1}"
  value="$(resolve_image "$ref")" || exit 1
  printf '%s\n' "$value"
  exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "tag" ]]; then
  source="${3:?}"
  target="${4:?}"
  value="$(resolve_image "$source")" || exit 1
  case "$target" in
    app-node-api)
      if [[ "$value" == "$NEW_NODE_IMAGE" ]]; then
        python3 - "$REPLAY_JOURNAL" <<'PY'
import json,sys
p=json.load(open(sys.argv[1], encoding="utf-8"))
assert p["status"] in {"prepared", "rolled_back"}
assert p["nodeApiImageAfter"] == "sha256:" + "7" * 64
PY
      fi
      printf '%s' "$value" >"$NODE_TAG_FILE"
      ;;
    airfoils-pro/node-api-cutover-replay:*) printf '%s' "$value" >"$REPLAY_TAG_FILE" ;;
    airfoils-pro/node-api-cutover-replay-rollback:*) printf '%s' "$value" >"$ROLLBACK_TAG_FILE" ;;
    *) exit 2 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "exec" && "$joined" == *" sha256sum /app/apps/api/src/admin-routes.ts "* ]]; then printf '%s  /app/apps/api/src/admin-routes.ts\n' "$NODE_API_SHA"; exit 0; fi
if [[ "${1:-}" == "exec" && "$joined" == *" sha256sum /app/apps/api/src/openfoam-2606-attestation.ts "* ]]; then printf '%s  /app/apps/api/src/openfoam-2606-attestation.ts\n' "${FAKE_NODE_ATTESTATION_SHA:-$NODE_ATTESTATION_SHA}"; exit 0; fi
if [[ "${1:-}" == "exec" && "$joined" == *" pnpm exec tsx -e "* ]]; then
  [[ "${FAKE_COOKIE_GENERATION_FAIL:-0}" != "1" ]] || exit 77
  printf '%s' "$FAKE_COOKIE"
  exit 0
fi
printf 'unsupported docker call: %s\n' "$*" >&2
exit 99
''',
        executable=True,
    )
    _write(
        fake_bin / "curl",
        r'''#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$CALL_LOG"
if [[ " $* " == *" --config - "* ]]; then cat >/dev/null; fi
url="${@: -1}"
case "$url" in
  *:8000/health)
    printf '{"build_id":"%s","default_engine":{"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1},"evidence_storage":{"backend":"gcs","bucket":"airfoils-pro-storage-bucket","object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":true}}\n' "$FAKE_BUILD_ID"
    ;;
  *:8000/queue)
    active="${FAKE_QUEUE_ACTIVE:-0}"
    printf '{"queue_depth":%s,"active_count":%s,"reserved_count":0,"scheduled_count":0,"job_ids":[],"inspection_errors":{},"worker_queues_error":null,"worker_runtime_error":null,"worker_queues":[{"worker":"celery@fixture","queues":["openfoam-opencfd-2606"],"execution_pool":"openfoam-opencfd-2606","engine":{"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}}]}\n' "$active" "$active"
    ;;
  *:4000/health)
    if [[ "${FAKE_NODE_HEALTH_FAIL:-0}" == "1" && "$(cat "$NODE_CONTAINER_IMAGE_FILE")" == "$NEW_NODE_IMAGE" ]]; then exit 22; fi
    printf '{"ok":true}\n'
    ;;
  */api/admin/me)
    [[ "${FAKE_COOKIE_REJECTED:-0}" != "1" ]] || exit 22
    printf '{"authed":true,"email":"cutover-replay@airfoils.pro"}\n'
    ;;
  *) exit 2 ;;
esac
''',
        executable=True,
    )
    _write(
        fake_bin / "mktemp",
        r'''#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" -d /dev/shm/airfoils-opencfd2606-replay.XXXXXX "* ]]; then
  mkdir "$RUNTIME_DIR_PATH"
  printf '%s\n' "$RUNTIME_DIR_PATH"
  exit 0
fi
exec /usr/bin/mktemp "$@"
''',
        executable=True,
    )
    _write(fake_bin / "sleep", "#!/usr/bin/env bash\nexit 0\n", executable=True)
    return fake_bin, calls, runtime


@pytest.fixture
def harness(tmp_path: Path) -> tuple[dict[str, str], Path, Path, Path, Path]:
    bound, target, wrapper, env_text, receipt_text = _fixture_sources(tmp_path)
    state = tmp_path / "state"
    state.mkdir()
    env_file = state / ".env.deploy"
    env_file.write_text(env_text)
    env_file.chmod(0o600)
    receipt = state / "pending-cutover-node-api-repair.json"
    receipt.write_text(receipt_text)
    receipt.chmod(0o600)
    failed_resume = state / "pending-cutover-queue-probe-resume.json"
    failed_resume.write_text(FAILED_RESUME_JOURNAL)
    failed_resume.chmod(0o600)
    app_link = tmp_path / "app"
    app_link.symlink_to(bound, target_is_directory=True)
    fake_bin, calls, runtime = _fake_runtime(tmp_path)
    marker = tmp_path / "child.json"
    child_mode_marker = tmp_path / "child-mode.txt"
    canonical_lock = tmp_path / "canonical.lock"
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "STAGING_DIR": str(target),
        "APP_DIR": str(app_link),
        "AIRFOILS_PRO_STATE_DIR": str(state),
        "ENV_FILE": str(env_file),
        "LOCK_FILE": str(canonical_lock),
        "EXPECTED_TARGET_SOURCE_REVISION": TARGET_REVISION,
        "CALL_LOG": str(calls),
        "CHILD_MARKER": str(marker),
        "CHILD_MODE_MARKER": str(child_mode_marker),
        "EXPECTED_BOUND_DIR": str(bound),
        "EXPECTED_CANONICAL_LOCK": str(canonical_lock),
        "FAKE_DB_SNAPSHOT": json.dumps(DB_SNAPSHOT, separators=(",", ":")),
        "FAKE_BUILD_ID": BUILD_ID,
        "API_IMAGE": API_IMAGE,
        "WORKER_IMAGE": WORKER_IMAGE,
        "NODE_IMAGE": NODE_IMAGE,
        "NEW_NODE_IMAGE": NEW_NODE_IMAGE,
        "NODE_API_SHA": NODE_API_SHA,
        "NODE_ATTESTATION_SHA": NODE_ATTESTATION_SHA,
        "FAKE_COOKIE": COOKIE,
        "REPLAY_JOURNAL": str(state / "pending-opencfd2606-rebuild-replay.json"),
        "RECREATE_FAIL_MARKER": str(tmp_path / "recreate-failed-once"),
        **{key: str(path) for key, path in runtime.items()},
    }
    return env, wrapper, marker, calls, receipt


def _run(env: dict[str, str], wrapper: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([wrapper], env=env, text=True, capture_output=True, check=False)


def test_replay_uses_bound_build_inputs_private_cookie_and_canonical_lock(
    harness: tuple[dict[str, str], Path, Path, Path, Path],
) -> None:
    env, wrapper, marker, calls, _ = harness
    runtime_dir = Path(env["RUNTIME_DIR_PATH"])
    assert not runtime_dir.exists()

    completed = _run(env, wrapper)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    child = json.loads(marker.read_text())
    assert child == {
        "buildId": BUILD_ID,
        "appDir": env["EXPECTED_BOUND_DIR"],
        "compose": f'{env["EXPECTED_BOUND_DIR"]}/docker-compose.deploy.yml',
        "manifest": f'{env["EXPECTED_BOUND_DIR"]}/.deployment-source.json',
        "fd8": env["EXPECTED_CANONICAL_LOCK"],
        "privateLockMode": "600",
        "cookieValid": True,
    }
    combined = completed.stdout + completed.stderr + calls.read_text()
    assert COOKIE not in combined
    assert "fixture_payload.fixture_signature" not in combined
    assert not runtime_dir.exists()
    journal = Path(env["AIRFOILS_PRO_STATE_DIR"]) / "pending-opencfd2606-rebuild-replay.json"
    payload = json.loads(journal.read_text())
    assert payload["status"] == "completed"
    assert payload["nodeApiImageBefore"] == NODE_IMAGE
    assert payload["nodeApiImageAfter"] == NEW_NODE_IMAGE
    assert payload["nodeApiAdminRoutesSha256"] == NODE_API_SHA
    assert payload["nodeApiAttestationSha256"] == NODE_ATTESTATION_SHA
    assert Path(env["NODE_CONTAINER_IMAGE_FILE"]).read_text() == NEW_NODE_IMAGE
    call_lines = calls.read_text().splitlines()
    build_index = next(i for i, line in enumerate(call_lines) if line.startswith("docker build "))
    retag_index = next(
        i
        for i, line in enumerate(call_lines)
        if line == f"docker image tag {NEW_NODE_IMAGE} app-node-api"
    )
    recreate_index = next(
        i for i, line in enumerate(call_lines) if "up -d --no-deps --force-recreate node-api" in line
    )
    assert build_index < retag_index < recreate_index
    assert not any("force-recreate api" in line or "force-recreate worker" in line for line in call_lines)


@pytest.mark.parametrize(
    ("flag", "message"),
    [
        ("FAKE_SWEEPER_RUNNING", "scheduler to remain stopped"),
        ("FAKE_POOL_ENABLED", "database snapshot differs"),
        ("FAKE_ACTIVE_SOLVER", "active OpenFOAM work"),
        ("FAKE_QUEUE_ACTIVE", "engine queue is not idle"),
        ("FAKE_API_IMAGE", "unexpected api image"),
        ("FAKE_NODE_IMAGE", "exact applied timeout repair"),
    ],
)
def test_replay_rejects_runtime_drift_before_child(
    harness: tuple[dict[str, str], Path, Path, Path, Path], flag: str, message: str
) -> None:
    env, wrapper, marker, _, _ = harness
    env[flag] = "sha256:" + "9" * 64 if flag.endswith("IMAGE") else "1"

    completed = _run(env, wrapper)

    assert completed.returncode != 0
    assert message in completed.stderr
    assert not marker.exists()


@pytest.mark.parametrize("mutation", ["content", "mode", "symlink"])
def test_replay_requires_exact_safe_applied_node_receipt(
    harness: tuple[dict[str, str], Path, Path, Path, Path], mutation: str, tmp_path: Path
) -> None:
    env, wrapper, marker, _, receipt = harness
    if mutation == "content":
        receipt.write_text(receipt.read_text() + " ")
    elif mutation == "mode":
        receipt.chmod(0o644)
    else:
        replacement = tmp_path / "replacement-receipt"
        replacement.write_bytes(receipt.read_bytes())
        receipt.unlink()
        receipt.symlink_to(replacement)

    completed = _run(env, wrapper)

    assert completed.returncode != 0
    assert "receipt" in completed.stderr.lower()
    assert not marker.exists()


@pytest.mark.parametrize("mutation", ["content", "mode", "symlink"])
def test_replay_requires_exact_safe_prior_failed_resume_journal(
    harness: tuple[dict[str, str], Path, Path, Path, Path], mutation: str, tmp_path: Path
) -> None:
    env, wrapper, marker, _, _ = harness
    journal = Path(env["AIRFOILS_PRO_STATE_DIR"]) / "pending-cutover-queue-probe-resume.json"
    if mutation == "content":
        journal.write_text(journal.read_text() + " ")
    elif mutation == "mode":
        journal.chmod(0o644)
    else:
        replacement = tmp_path / "replacement-failed-resume"
        replacement.write_bytes(journal.read_bytes())
        journal.unlink()
        journal.symlink_to(replacement)

    completed = _run(env, wrapper)

    assert completed.returncode != 0
    assert "queue-probe replay journal" in completed.stderr
    assert not marker.exists()


def test_replay_rejects_staged_helper_or_unrelated_source_change(
    harness: tuple[dict[str, str], Path, Path, Path, Path],
) -> None:
    env, wrapper, marker, _, _ = harness
    target = Path(env["STAGING_DIR"])
    helper = target / "scripts/deploy/evidence-contract.py"
    helper.write_text(helper.read_text() + "# tampered\n")
    verifier = Path(env["EXPECTED_BOUND_DIR"]) / "scripts/deploy/deployment-source-manifest.py"
    _seal(target, TARGET_REVISION, verifier=verifier)

    completed = _run(env, wrapper)

    assert completed.returncode == 14
    assert "exact reviewed incident scope" in completed.stderr
    assert not marker.exists()


@pytest.mark.parametrize("flag", ["FAKE_COOKIE_GENERATION_FAIL", "FAKE_COOKIE_REJECTED"])
def test_replay_refuses_unavailable_ephemeral_admin_session_without_leaking_it(
    harness: tuple[dict[str, str], Path, Path, Path, Path], flag: str
) -> None:
    env, wrapper, marker, calls, _ = harness
    env[flag] = "1"

    completed = _run(env, wrapper)

    assert completed.returncode != 0
    assert not marker.exists()
    combined = completed.stdout + completed.stderr + calls.read_text()
    assert COOKIE not in combined
    assert "fixture_payload.fixture_signature" not in combined
    assert Path(env["NODE_CONTAINER_IMAGE_FILE"]).read_text() == NODE_IMAGE
    assert Path(env["NODE_TAG_FILE"]).read_text() == NODE_IMAGE
    journal = Path(env["REPLAY_JOURNAL"])
    assert json.loads(journal.read_text())["status"] == "rolled_back"


@pytest.mark.parametrize(
    "flag",
    ["FAKE_NODE_RECREATE_FAIL", "FAKE_NODE_HEALTH_FAIL", "FAKE_NODE_ATTESTATION_SHA"],
)
def test_uncertified_replacement_node_failure_restores_exact_prior_image(
    harness: tuple[dict[str, str], Path, Path, Path, Path], flag: str
) -> None:
    env, wrapper, marker, _, _ = harness
    env[flag] = "sha256:" + "9" * 64 if flag.endswith("SHA") else "1"

    completed = _run(env, wrapper)

    assert completed.returncode != 0
    assert not marker.exists()
    assert Path(env["NODE_TAG_FILE"]).read_text() == NODE_IMAGE
    assert Path(env["NODE_CONTAINER_IMAGE_FILE"]).read_text() == NODE_IMAGE
    journal = Path(env["REPLAY_JOURNAL"])
    assert json.loads(journal.read_text())["status"] == "rolled_back"


def test_node_build_failure_never_mutates_live_tag_or_creates_replay_journal(
    harness: tuple[dict[str, str], Path, Path, Path, Path]
) -> None:
    env, wrapper, marker, _, _ = harness
    env["FAKE_NODE_BUILD_FAIL"] = "1"

    completed = _run(env, wrapper)

    assert completed.returncode == 86
    assert not marker.exists()
    assert Path(env["NODE_TAG_FILE"]).read_text() == NODE_IMAGE
    assert Path(env["NODE_CONTAINER_IMAGE_FILE"]).read_text() == NODE_IMAGE
    assert not Path(env["REPLAY_JOURNAL"]).exists()


def test_replay_refuses_when_canonical_deploy_lock_is_held(
    harness: tuple[dict[str, str], Path, Path, Path, Path]
) -> None:
    env, wrapper, marker, _, _ = harness
    holder = subprocess.Popen(
        ["flock", env["LOCK_FILE"], "sleep", "30"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        completed = _run(env, wrapper)
    finally:
        holder.terminate()
        holder.wait(timeout=5)

    assert completed.returncode == 9
    assert not marker.exists()


def test_failed_child_keeps_applied_node_repair_and_retries_without_rebuild(
    harness: tuple[dict[str, str], Path, Path, Path, Path]
) -> None:
    env, wrapper, marker, _, _ = harness
    env["FAKE_CHILD_FAIL"] = "1"

    completed = _run(env, wrapper)

    assert completed.returncode == 55
    assert not marker.exists()
    journal = Path(env["AIRFOILS_PRO_STATE_DIR"]) / "pending-opencfd2606-rebuild-replay.json"
    payload = json.loads(journal.read_text())
    assert payload["status"] == "failed"
    assert payload["failureCount"] == 1
    assert payload["lastExitCode"] == 55
    assert payload["nodeApiImageAfter"] == NEW_NODE_IMAGE
    assert payload["deploymentEnvironmentAfterSha256"] is None
    assert Path(env["NODE_CONTAINER_IMAGE_FILE"]).read_text() == NEW_NODE_IMAGE

    env.pop("FAKE_CHILD_FAIL")
    replay = _run(env, wrapper)
    assert replay.returncode == 0, replay.stdout + replay.stderr
    assert json.loads(journal.read_text())["status"] == "completed"
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert sum(line.startswith("docker build ") for line in calls) == 1


def test_failed_receipt_stage_retries_through_retained_receipt_recovery_without_rebuild(
    harness: tuple[dict[str, str], Path, Path, Path, Path]
) -> None:
    env, wrapper, marker, _, _ = harness
    env["FAKE_CHILD_CREATE_RECEIPT_AND_FAIL"] = "1"

    failed = _run(env, wrapper)

    assert failed.returncode == 56
    assert not marker.exists()
    journal = Path(env["REPLAY_JOURNAL"])
    payload = json.loads(journal.read_text())
    assert payload["status"] == "failed"
    assert payload["currentCutoverStateKind"] == "pending-receipt"
    assert payload["currentCanaryReceiptSha256"] != "absent"
    assert Path(env["NODE_CONTAINER_IMAGE_FILE"]).read_text() == NEW_NODE_IMAGE

    env.pop("FAKE_CHILD_CREATE_RECEIPT_AND_FAIL")
    recovered = _run(env, wrapper)

    assert recovered.returncode == 0, recovered.stdout + recovered.stderr
    assert Path(env["CHILD_MODE_MARKER"]).read_text().strip() == "retained-receipt"
    assert json.loads(journal.read_text())["status"] == "completed"
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert sum(line.startswith("docker build ") for line in calls) == 1


def test_failure_journaling_never_overwrites_last_good_binding_with_unknown_state(
    harness: tuple[dict[str, str], Path, Path, Path, Path]
) -> None:
    env, wrapper, marker, _, _ = harness
    env["FAKE_CHILD_CREATE_RECEIPT_AND_FAIL"] = "1"
    env["FAKE_CHILD_CORRUPT_RECEIPT"] = "1"

    failed = _run(env, wrapper)

    assert failed.returncode == 56
    assert not marker.exists()
    assert "could not record the child failure" in failed.stderr
    payload = json.loads(Path(env["REPLAY_JOURNAL"]).read_text())
    assert payload["status"] == "node_applied"
    assert payload["currentCutoverStateKind"] == "pending-pristine"
    assert payload["currentCanaryReceiptSha256"] == "absent"


@pytest.mark.parametrize("key", ["APP_DIR", "AIRFOILS_PRO_STATE_DIR", "ENV_FILE", "LOCK_FILE", "COMPOSE_PROJECT_NAME"])
def test_replay_rejects_caller_bound_path_overrides_before_validation(
    harness: tuple[dict[str, str], Path, Path, Path, Path], key: str, tmp_path: Path
) -> None:
    env, wrapper, marker, _, _ = harness
    env[key] = str(tmp_path / "override")

    completed = _run(env, wrapper)

    assert completed.returncode == 2
    assert "refuses caller overrides" in completed.stderr
    assert not marker.exists()


def test_production_timeout_and_workflow_contract_are_exact() -> None:
    rebuild = (ROOT / "scripts/deploy/rebuild-engine.sh").read_text()
    wrapper = WRAPPER.read_text()
    workflow = (ROOT / ".github/workflows/deploy-airfoils-pro.yml").read_text()
    assert "ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS=15" in rebuild
    assert 'curl -fsS --max-time "$ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS" http://127.0.0.1:8000/queue' in rebuild
    assert rebuild.count("ENGINE_QUEUE_PROBE_TIMEOUT_SECONDS") == 2
    assert "1f57f0e664682c22812de55de3be2ff58e205dd11a9eb6a1bd2c1a08545e0c92" in wrapper
    assert "008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f" in wrapper
    assert "pending_cutover_engine_rebuild_replay:" in workflow
    assert "inputs.pending_cutover_engine_rebuild_replay && 360 || 45" in workflow
    assert "ServerAliveInterval=30" in workflow
    assert "ServerAliveCountMax=20" in workflow
    assert "Select only one pending-cutover recovery action" in workflow
    assert "replay-pending-opencfd2606-rebuild.sh" in workflow
    assert NODE_API_SHA == _sha(
        _git_file(SEALED_TARGET_REVISION, "apps/api/src/admin-routes.ts")
    )
    assert "6f10619510378451e47e8aaa6579e663b879e47ce0af98097680c2b4462ddc62" in wrapper
    assert "6046af2febe268060afcf7eff386a99ab5c6d0930e5eea2d70f10a715805b65b" in wrapper
    assert "df6f7558e3d53e1f7fd6158c171d02a1d62fe74ce721eb6cdb0132e6efff8f48" in wrapper
    assert "9324e40c112e662fa78cbcd7b1bb782b23f439150f59618f1119faf26d50034a" in wrapper
    assert '".github"' in MANIFEST.read_text()
