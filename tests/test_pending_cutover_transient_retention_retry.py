from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts/deploy/retry-pending-opencfd2606-transient-retention.sh"
PRIOR_WRAPPER = ROOT / "scripts/deploy/retry-pending-opencfd2606-retention.sh"
MANIFEST = ROOT / "scripts/deploy/deployment-source-manifest.py"
STATE_TOOL = ROOT / "scripts/deploy/opencfd2606_cutover_state.py"
BOUND_REVISION = "63385777be7323777906fde44bdb9fa9b5cc0d6d"
BASE_REVISION = "cd0967a1ba4ef82113d6b1eae9e38f0a7baec3a2"
NODE_SOURCE_REVISION = "1f815f89c523cbf667725c1cd681d729c06a10c9"
PRIOR_TREE = "7" * 64
TARGET_REVISION = "d" * 40
OLD_BUILD = "prod-20260717-cd0967a1ba4e-r3"
TARGET_BUILD = f"prod-20260717-{TARGET_REVISION[:12]}-r4"
NODE_IMAGE = "sha256:" + "8" * 64
NODE_ROLLBACK_IMAGE = "sha256:" + "6" * 64
OLD_API_IMAGE = "sha256:" + "a" * 64
OLD_WORKER_IMAGE = "sha256:" + "b" * 64
NEW_API_IMAGE = "sha256:" + "c" * 64
NEW_WORKER_IMAGE = "sha256:" + "d" * 64
NODE_ADMIN_SHA = "1" * 64
NODE_ATTEST_SHA = "2" * 64
NODE_CONTAINER = "2" * 64
API_CONTAINER = "3" * 64
WORKER_CONTAINER = "4" * 64
NODE_CONTAINER_AFTER = "5" * 64
API_CONTAINER_AFTER = "6" * 64
WORKER_CONTAINER_AFTER = "7" * 64
COOKIE = "aero_admin=fixture_payload.fixture_signature"


def _write(path: Path, value: str | bytes, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(0o755 if executable else 0o644)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _seal(root: Path, revision: str) -> tuple[str, int]:
    completed = subprocess.run(
        [
            "python3",
            str(root / "scripts/deploy/deployment-source-manifest.py"),
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
    _, tree, count = completed.stdout.strip().split("\t")
    return tree, int(count)


def _git_blob(value: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(value)).encode() + b"\0" + value).hexdigest()


def _inventory(root: Path) -> bytes:
    lines: list[str] = []
    for path in sorted(
        item
        for item in root.rglob("*")
        if item.is_file()
        and item.name != ".deployment-source.json"
        and ".codex-artifacts" not in item.relative_to(root).parts
        and ".github" not in item.relative_to(root).parts
    ):
        relative = path.relative_to(root).as_posix()
        mode = "100755" if path.stat().st_mode & 0o111 else "100644"
        lines.append(f"{mode} blob {_git_blob(path.read_bytes())}\t{relative}")
    return ("\n".join(lines) + "\n").encode()


def _replace_env(path: Path, updates: dict[str, str]) -> None:
    lines: list[str] = []
    seen = {key: 0 for key in updates}
    for line in path.read_text().splitlines():
        key = line.split("=", 1)[0]
        if key in updates:
            seen[key] += 1
            line = f"{key}={updates[key]}"
        lines.append(line)
    assert all(count == 1 for count in seen.values())
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o600)


FAKE_CHILD = r'''#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >>"$CHILD_CALLS"
[[ "$APP_DIR" == /dev/shm/* || "$APP_DIR" == "$RUNTIME_SOURCE" ]]
[[ "$DEPLOY_SOURCE_REVISION" == "$TARGET_REVISION_VALUE" ]]
[[ "$DEPLOY_SOURCE_TREE_SHA256" == "$TARGET_TREE_VALUE" ]]
[[ "$COMPOSE_FILE" == "$APP_DIR/docker-compose.deploy.yml" ]]
[[ "$DEPLOYMENT_MANIFEST_FILE" == "$APP_DIR/.deployment-source.json" ]]
[[ "$(readlink /proc/$$/fd/8)" == "$EXPECTED_CANONICAL_LOCK" ]]
[[ "$(stat -c '%a' "$LOCK_FILE")" == "600" ]]
if [[ "$1" == "--certify-opencfd-2606-continuation" ]]; then
  [[ "${FAKE_CERTIFY_TERMINAL:-0}" == "1" ]] || exit 15
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
path=Path(sys.argv[1])
updates={
 "OPENCFD2606_CUTOVER_PENDING":"0","OPENCFD2606_CUTOVER_COMPLETE":"1",
 "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING":"","OPENCFD2606_CANARY_ATTESTATION_ID":"",
 "OPENCFD2606_CANARY_RECEIPT_EXPECTED":"0","OPENCFD2606_CUTOVER_SOURCE_REVISION":"",
 "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256":"",
}
lines=[]
for line in path.read_text().splitlines():
 key=line.split("=",1)[0]; lines.append(f"{key}={updates[key]}" if key in updates else line)
path.write_text("\n".join(lines)+"\n")
PY
  printf '%s' "$TERMINAL_DB_JSON" >"$DB_FILE"
  exit 0
fi
[[ "$1" == "$TARGET_BUILD_VALUE" ]]
[[ "${FAKE_CHILD_FAIL_BEFORE:-0}" != "1" ]] || exit 55
python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import os,sys
path=Path(sys.argv[1])
updates={
 "AIRFOILFOAM_BUILD_ID":os.environ["TARGET_BUILD_VALUE"],
 "ENGINE_EXPECTED_BUILD_ID":os.environ["TARGET_BUILD_VALUE"],
 "OPENCFD2606_CANARY_ATTESTATION_ID":"11111111-1111-4111-8111-111111111111",
 "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256":"e"*64,
}
lines=[]
for line in path.read_text().splitlines():
 key=line.split("=",1)[0]; lines.append(f"{key}={updates[key]}" if key in updates else line)
path.write_text("\n".join(lines)+"\n")
PY
printf '%s' "$NEW_API_IMAGE" >"$API_IMAGE_FILE"
printf '%s' "$NEW_WORKER_IMAGE" >"$WORKER_IMAGE_FILE"
printf '%s' "$NEW_API_IMAGE" >"$API_TAG_FILE"
printf '%s' "$NEW_WORKER_IMAGE" >"$WORKER_TAG_FILE"
printf '%s' "$TARGET_APP_SOURCE_SHA" >"$API_SOURCE_FILE"
printf '%s' "$TARGET_APP_SOURCE_SHA" >"$WORKER_SOURCE_FILE"
printf '%s' "$TARGET_BUILD_VALUE" >"$ENGINE_BUILD_FILE"
printf '%s' "$TARGET_BUILD_VALUE" >"$NODE_BUILD_FILE"
printf '%s' "$NODE_CONTAINER_AFTER" >"$NODE_CONTAINER_FILE"
printf '%s' "$API_CONTAINER_AFTER" >"$API_CONTAINER_FILE"
printf '%s' "$WORKER_CONTAINER_AFTER" >"$WORKER_CONTAINER_FILE"
printf '%s' "$ATTESTED_DB_JSON" >"$DB_FILE"
[[ "${FAKE_CHILD_FAIL_AFTER:-0}" != "1" ]] || exit 56
'''


def _fixture_sources(tmp_path: Path) -> tuple[Path, Path, Path, str, int, str, str]:
    base = tmp_path / "base"
    target = tmp_path / "target"
    _write(base / "scripts/deploy/deployment-source-manifest.py", MANIFEST.read_bytes(), executable=True)
    _write(base / "scripts/deploy/opencfd2606_cutover_state.py", STATE_TOOL.read_bytes(), executable=True)
    _write(base / "scripts/deploy/deployment-env-preflight.py", "#!/usr/bin/env python3\nraise SystemExit(0)\n", executable=True)
    _write(base / "scripts/deploy/rebuild-engine.sh", FAKE_CHILD, executable=True)
    _write(base / "scripts/deploy/openfoam_2606_canary.py", "# canary fixture\n")
    _write(base / "scripts/deploy/retry-pending-opencfd2606-retention.sh", PRIOR_WRAPPER.read_bytes(), executable=True)
    _write(base / "src/airfoilfoam/__init__.py", "")
    _write(base / "src/airfoilfoam/provenance.py", (ROOT / "src/airfoilfoam/provenance.py").read_bytes())
    _write(base / "src/airfoilfoam/pipeline.py", subprocess.check_output(["git", "show", f"{BASE_REVISION}:src/airfoilfoam/pipeline.py"], cwd=ROOT))
    _write(base / "src/airfoilfoam/retention.py", subprocess.check_output(["git", "show", f"{BASE_REVISION}:src/airfoilfoam/retention.py"], cwd=ROOT))
    _write(base / "tests/test_retention.py", subprocess.check_output(["git", "show", f"{BASE_REVISION}:tests/test_retention.py"], cwd=ROOT))
    _write(base / "apps/api/src/admin-routes.ts", "admin fixture\n")
    _write(base / "apps/api/src/openfoam-2606-attestation.ts", "attestation fixture\n")
    _write(base / "docker-compose.deploy.yml", "services: {}\n")
    _write(base / "pyproject.toml", "[project]\nname='fixture'\nversion='0.0.0'\n")
    base_tree, base_count = _seal(base, BOUND_REVISION)
    inventory = _inventory(base)

    shutil.copytree(base, target, symlinks=True)
    (target / ".deployment-source.json").unlink()
    _write(target / "src/airfoilfoam/pipeline.py", (ROOT / "src/airfoilfoam/pipeline.py").read_bytes() + b"\n# transient retention pipeline fixture delta\n")
    _write(target / "src/airfoilfoam/retention.py", (ROOT / "src/airfoilfoam/retention.py").read_bytes() + b"\n# transient retention fixture delta\n")
    _write(target / "tests/test_retention.py", (ROOT / "tests/test_retention.py").read_bytes() + b"\n# transient retention test fixture delta\n")
    wrapper_text = WRAPPER.read_text()
    _write(target / "scripts/deploy/retry-pending-opencfd2606-transient-retention.sh", wrapper_text, executable=True)
    _write(target / "tests/test_pending_cutover_transient_retention_retry.py", "# transient retry fixture contract\n")
    inventory_path = target / ".codex-artifacts/opencfd2606-transient-retention-base-ls-tree.txt"
    _write(inventory_path, inventory)
    inventory_path.chmod(0o600)
    target_tree, target_count = _seal(target, TARGET_REVISION)

    replacements = {
        "EXPECTED_BOUND_SOURCE_TREE_SHA256=\"52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36\"": f'EXPECTED_BOUND_SOURCE_TREE_SHA256="{base_tree}"',
        "EXPECTED_BOUND_SOURCE_FILE_COUNT=\"2198\"": f'EXPECTED_BOUND_SOURCE_FILE_COUNT="{base_count}"',
        "EXPECTED_PRIOR_ENGINE_SOURCE_TREE_SHA256=\"1a7cadf8a0981c3894ced26458cdf373a428e28592070fc7f81cc873b2a9af1f\"": f'EXPECTED_PRIOR_ENGINE_SOURCE_TREE_SHA256="{PRIOR_TREE}"',
        "EXPECTED_BASE_GIT_TREE_INVENTORY_SHA256=\"cc5b8cb9a48f18729ce9cffa73783c64e5aa9fba244216b51c21eea28932a839\"": f'EXPECTED_BASE_GIT_TREE_INVENTORY_SHA256="{hashlib.sha256(inventory).hexdigest()}"',
        "EXPECTED_PIPELINE_SHA256=\"0ec006a1db421bc8cfce5c4f422966913b9d477f1ca347ddd2ad6eaa3505a176\"": f'EXPECTED_PIPELINE_SHA256="{_sha(target / "src/airfoilfoam/pipeline.py")}"',
        "EXPECTED_RETENTION_SHA256=\"71c64e20c5b6b7a15b94a104819b3cb5639c42348b2a11ec822e1588e8805523\"": f'EXPECTED_RETENTION_SHA256="{_sha(target / "src/airfoilfoam/retention.py")}"',
        "EXPECTED_RETENTION_TEST_SHA256=\"672a53783accaa66e806cbf3849bcdebf3377035e22400a7e3730f2318fcf84c\"": f'EXPECTED_RETENTION_TEST_SHA256="{_sha(target / "tests/test_retention.py")}"',
        "EXPECTED_REBUILD_SHA256=\"008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f\"": f'EXPECTED_REBUILD_SHA256="{_sha(target / "scripts/deploy/rebuild-engine.sh")}"',
        "EXPECTED_CANARY_SHA256=\"df6f7558e3d53e1f7fd6158c171d02a1d62fe74ce721eb6cdb0132e6efff8f48\"": f'EXPECTED_CANARY_SHA256="{_sha(target / "scripts/deploy/openfoam_2606_canary.py")}"',
        "EXPECTED_PRIOR_WRAPPER_SHA256=\"39fa83ec14dd38084c980b30118cbcc152a03fa2410ccca98fccc1cbd4f85f37\"": f'EXPECTED_PRIOR_WRAPPER_SHA256="{_sha(target / "scripts/deploy/retry-pending-opencfd2606-retention.sh")}"',
        "EXPECTED_NODE_ADMIN_ROUTES_SHA256=\"e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4\"": f'EXPECTED_NODE_ADMIN_ROUTES_SHA256="{_sha(target / "apps/api/src/admin-routes.ts")}"',
        "EXPECTED_NODE_ATTESTATION_SHA256=\"928986cd328e7af647cefe7c241ed1a5ce9a6446907061055a28f28392c0944e\"": f'EXPECTED_NODE_ATTESTATION_SHA256="{_sha(target / "apps/api/src/openfoam-2606-attestation.ts")}"',
        "EXPECTED_NODE_IMAGE=\"sha256:89069188e2e57cad231dcf3527eaba2e5151b0886921eac4f720d589d09e66af\"": f'EXPECTED_NODE_IMAGE="{NODE_IMAGE}"',
        "EXPECTED_NODE_ROLLBACK_IMAGE=\"sha256:64ee90e0045a36eace3c57aeb5b3467c1e1f46c5eafb2466b98f8b754cbade32\"": f'EXPECTED_NODE_ROLLBACK_IMAGE="{NODE_ROLLBACK_IMAGE}"',
        "EXPECTED_INITIAL_NODE_CONTAINER=\"23f5f7b9ed07eea74f7eca57247fd9cf03ebf9c179620f3fc3e628be806b2016\"": f'EXPECTED_INITIAL_NODE_CONTAINER="{NODE_CONTAINER}"',
        "EXPECTED_INITIAL_API_CONTAINER=\"8c09f2cf019c568b459fcdb7af595a5e13ad8c59f0ed55ff58f34bb506b848a5\"": f'EXPECTED_INITIAL_API_CONTAINER="{API_CONTAINER}"',
        "EXPECTED_INITIAL_WORKER_CONTAINER=\"41ae0007b8c19f0d29616d7304b86a38f23346b3940a5178f565dfe2b9ff931f\"": f'EXPECTED_INITIAL_WORKER_CONTAINER="{WORKER_CONTAINER}"',
        "EXPECTED_INITIAL_API_IMAGE=\"sha256:236cb522879087a412103b3dceb1ef83fa7964e5c628497dbeb251c60d5cca98\"": f'EXPECTED_INITIAL_API_IMAGE="{OLD_API_IMAGE}"',
        "EXPECTED_INITIAL_WORKER_IMAGE=\"sha256:2705edcca4d60c0fc81f7cab0635d582e14cdc08a8ce97e7d78a89857451dccc\"": f'EXPECTED_INITIAL_WORKER_IMAGE="{OLD_WORKER_IMAGE}"',
    }
    for old, new in replacements.items():
        assert old in wrapper_text, old
        wrapper_text = wrapper_text.replace(old, new)
    # Replacing the wrapper changes the target source tree; reseal once with
    # the exact executable bytes that the harness will run.
    _write(target / "scripts/deploy/retry-pending-opencfd2606-transient-retention.sh", wrapper_text, executable=True)
    target_tree, target_count = _seal(target, TARGET_REVISION)
    return base, target, target / "scripts/deploy/retry-pending-opencfd2606-transient-retention.sh", base_tree, base_count, target_tree, hashlib.sha256(inventory).hexdigest()


def _fake_runtime(tmp_path: Path) -> tuple[Path, dict[str, Path]]:
    fake_bin = tmp_path / "bin"
    files = {name: tmp_path / name for name in (
        "calls", "api-image", "worker-image", "api-tag", "worker-tag", "node-image", "node-tag",
        "replay-tag", "rollback-tag", "node-container", "api-container", "worker-container",
        "node-build", "engine-build", "api-source",
        "worker-source", "db", "child-calls",
    )}
    _write(fake_bin / "docker", r'''#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$CALL_LOG"
joined=" $* "
if [[ "$joined" == *" compose version "* ]]; then exit 0; fi
if [[ "$joined" == *" config --services "* ]]; then printf 'worker\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q sweeper "* ]]; then [[ "${FAKE_SWEEPER_RUNNING:-0}" == "1" ]] && printf 'sweeper-id\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q api "* ]]; then cat "$API_CONTAINER_FILE"; printf '\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q worker "* ]]; then cat "$WORKER_CONTAINER_FILE"; printf '\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q node-api "* ]]; then cat "$NODE_CONTAINER_FILE"; printf '\n'; exit 0; fi
if [[ "$joined" == *" exec -T postgres psql "* ]]; then cat "$DB_FILE"; printf '\n'; exit 0; fi
if [[ "$joined" == *" exec -T worker sh -lc "* ]]; then [[ "${FAKE_ACTIVE_SOLVER:-0}" == "1" ]] && printf '42 simpleFoam\n'; exit 0; fi
if [[ "${1:-}" == "ps" ]]; then exit 0; fi
if [[ "${1:-}" == "inspect" ]]; then
  id="${@: -1}"
  if [[ "$id" == "$(cat "$API_CONTAINER_FILE")" ]]; then cat "$API_IMAGE_FILE"
  elif [[ "$id" == "$(cat "$WORKER_CONTAINER_FILE")" ]]; then cat "$WORKER_IMAGE_FILE"
  elif [[ "$id" == "$(cat "$NODE_CONTAINER_FILE")" ]]; then cat "$NODE_IMAGE_FILE"
  else exit 2; fi
  printf '\n'; exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  ref="${@: -1}"
  case "$ref" in app-api) cat "$API_TAG_FILE";; app-worker) cat "$WORKER_TAG_FILE";; app-node-api) cat "$NODE_TAG_FILE";;
    airfoils-pro/node-api-cutover-replay:*) cat "$REPLAY_TAG_FILE";;
    airfoils-pro/node-api-cutover-replay-rollback:*) cat "$ROLLBACK_TAG_FILE";; *) exit 2;; esac
  printf '\n'; exit 0
fi
if [[ "${1:-}" == "exec" ]]; then
  id="${2:-}"
  if [[ "$joined" == *" sha256sum /app/apps/api/src/admin-routes.ts "* ]]; then printf '%s  file\n' "$NODE_ADMIN_SHA"; exit 0; fi
  if [[ "$joined" == *" sha256sum /app/apps/api/src/openfoam-2606-attestation.ts "* ]]; then printf '%s  file\n' "$NODE_ATTEST_SHA"; exit 0; fi
  if [[ "$joined" == *" printenv ENGINE_EXPECTED_BUILD_ID "* ]]; then cat "$NODE_BUILD_FILE"; printf '\n'; exit 0; fi
  if [[ "$joined" == *" pnpm exec tsx -e "* ]]; then printf '%s' "$FAKE_COOKIE"; exit 0; fi
  if [[ "$joined" == *" cat /etc/airfoilfoam-application-source-sha256 "* ]]; then
    if [[ "$id" == "$(cat "$API_CONTAINER_FILE")" ]]; then cat "$API_SOURCE_FILE"
    elif [[ "$id" == "$(cat "$WORKER_CONTAINER_FILE")" ]]; then cat "$WORKER_SOURCE_FILE"
    else exit 2; fi
    printf '\n'; exit 0
  fi
fi
echo "unsupported docker call: $*" >&2; exit 99
''', executable=True)
    _write(fake_bin / "curl", r'''#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$CALL_LOG"
[[ " $* " == *" --config - "* ]] && cat >/dev/null
url="${@: -1}"
case "$url" in
  *:8000/queue) printf '{"queue_depth":0,"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":[],"inspection_errors":{},"worker_queues_error":null,"worker_runtime_error":null,"worker_queues":[{"queues":["openfoam-opencfd-2606"],"execution_pool":"openfoam-opencfd-2606","engine":{"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}}]}\n';;
  *:8000/health) printf '{"build_id":"%s","default_engine":{"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1},"evidence_storage":{"backend":"gcs","bucket":"airfoils-pro-storage-bucket","object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":true}}\n' "$(cat "$ENGINE_BUILD_FILE")";;
  *:4000/health) printf '{"ok":true}\n';;
  */api/admin/me) printf '{"authed":true,"email":"cutover-transient-retention@airfoils.pro"}\n';;
  *) exit 2;;
esac
''', executable=True)
    _write(fake_bin / "mktemp", r'''#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" -d /dev/shm/airfoils-opencfd2606-transient-retention.XXXXXX "* ]]; then
  mkdir "$RUNTIME_DIR_PATH"; printf '%s\n' "$RUNTIME_DIR_PATH"; exit 0
fi
exec /usr/bin/mktemp "$@"
''', executable=True)
    return fake_bin, files


@pytest.fixture
def harness(tmp_path: Path) -> tuple[dict[str, str], Path, Path, dict[str, Path]]:
    base, target, wrapper, base_tree, base_count, target_tree, inventory_sha = _fixture_sources(tmp_path)
    state = tmp_path / "state"; state.mkdir()
    app = tmp_path / "app"; app.symlink_to(base, target_is_directory=True)
    initial_db = {"attestationCount": 0, "cutovers": [{"canaryAttestationId": None, "completedAt": None, "finalizedAt": None, "id": "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee", "status": "prepared", "targetPlanRevisionId": None}], "poolEnabled": False, "poolRows": 1}
    attested_db = {"attestationCount": 1, "cutovers": [{"canaryAttestationId": "11111111-1111-4111-8111-111111111111", "completedAt": None, "finalizedAt": "2026-07-17T00:00:00Z", "id": "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee", "status": "finalized", "targetPlanRevisionId": "target-plan"}], "poolEnabled": False, "poolRows": 1}
    terminal_db = {**attested_db, "cutovers": [{**attested_db["cutovers"][0], "completedAt": "2026-07-17T01:00:00Z", "status": "completed"}]}
    env_file = state / ".env.deploy"
    env_file.write_text("\n".join([
        f"AIRFOILFOAM_BUILD_ID={OLD_BUILD}", f"ENGINE_EXPECTED_BUILD_ID={OLD_BUILD}",
        "OPENCFD2606_CUTOVER_PENDING=1", "OPENCFD2606_CUTOVER_COMPLETE=0",
        "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=0", "OPENCFD2606_CANARY_ATTESTATION_ID=",
        "OPENCFD2606_CANARY_RECEIPT_EXPECTED=0", "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=",
        f"OPENCFD2606_CUTOVER_SOURCE_REVISION={BASE_REVISION}",
        f"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256={PRIOR_TREE}", "",
    ])); env_file.chmod(0o600)
    source_bound_env = tmp_path / "source-bound.env"
    source_bound_env.write_bytes(env_file.read_bytes())
    _replace_env(
        source_bound_env,
        {
            "AIRFOILFOAM_BUILD_ID": "prod-20260717-cd0967a1ba4e-r2",
            "ENGINE_EXPECTED_BUILD_ID": "prod-20260717-cd0967a1ba4e-r2",
        },
    )
    prior_app_source = subprocess.check_output(
        ["python3", "-c", "from pathlib import Path; from airfoilfoam.provenance import application_source_sha256; import sys; print(application_source_sha256(Path(sys.argv[1])))", str(base)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(base / "src")}, text=True,
    ).strip()
    db_sha = hashlib.sha256(json.dumps(initial_db, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    failed = state / "pending-opencfd2606-retention-retry.json"
    failed_payload = {
        "schemaVersion": 1, "purpose": "pending-opencfd2606-retention-retry", "status": "failed",
        "preparedAt": "2026-07-17T00:00:00+00:00", "updatedAt": "2026-07-17T00:05:00+00:00",
        "completedAt": None, "failureCount": 1, "lastExitCode": 14,
        "priorFailedReplayJournalSha256": "a" * 64,
        "boundReleaseSourceRevision": BOUND_REVISION, "boundReleaseSourceTreeSha256": base_tree,
        "priorReplaySourceRevision": NODE_SOURCE_REVISION,
        "engineSourceRevision": BASE_REVISION, "engineSourceTreeSha256": PRIOR_TREE,
        "engineSourceFileCount": base_count, "engineApplicationSourceSha256": prior_app_source,
        "nodeSourceRevision": NODE_SOURCE_REVISION, "nodeApiImage": NODE_IMAGE,
        "nodeApiAdminRoutesSha256": _sha(target / "apps/api/src/admin-routes.ts"),
        "nodeApiAttestationSha256": _sha(target / "apps/api/src/openfoam-2606-attestation.ts"),
        "nodeApiContainerBefore": "1" * 64, "nodeApiContainerAfter": NODE_CONTAINER,
        "buildId": OLD_BUILD, "action": "rebuild_and_canary",
        "deploymentEnvironmentBeforeSha256": "9" * 64,
        "sourceBoundDeploymentEnvironmentSha256": _sha(source_bound_env), "promotionEligible": False,
        "currentDeploymentEnvironmentSha256": _sha(env_file), "currentApiImage": OLD_API_IMAGE,
        "currentWorkerImage": OLD_WORKER_IMAGE, "currentDatabaseSnapshotSha256": db_sha,
        "currentCanaryReceiptSha256": "absent", "currentCutoverStateKind": "pending-pristine",
        "currentNodeApiImage": NODE_IMAGE, "currentNodeExpectedBuildId": OLD_BUILD,
    }
    assert (
        failed_payload["sourceBoundDeploymentEnvironmentSha256"]
        != failed_payload["currentDeploymentEnvironmentSha256"]
    )
    failed.write_text(json.dumps(failed_payload, sort_keys=True, separators=(",", ":")) + "\n"); failed.chmod(0o600)
    fake_bin, files = _fake_runtime(tmp_path)
    values = {files["api-image"]: OLD_API_IMAGE, files["worker-image"]: OLD_WORKER_IMAGE, files["api-tag"]: OLD_API_IMAGE, files["worker-tag"]: OLD_WORKER_IMAGE, files["node-image"]: NODE_IMAGE, files["node-tag"]: NODE_IMAGE, files["replay-tag"]: NODE_IMAGE, files["rollback-tag"]: NODE_ROLLBACK_IMAGE, files["node-container"]: NODE_CONTAINER, files["api-container"]: API_CONTAINER, files["worker-container"]: WORKER_CONTAINER, files["node-build"]: OLD_BUILD, files["engine-build"]: OLD_BUILD, files["api-source"]: prior_app_source, files["worker-source"]: prior_app_source, files["db"]: json.dumps(initial_db, sort_keys=True, separators=(",", ":")), files["calls"]: "", files["child-calls"]: ""}
    for path, value in values.items(): _write(path, value)
    runtime = tmp_path / "runtime"

    wrapper_text = wrapper.read_text()
    replacements = {
        f'EXPECTED_BOUND_APP_REAL="/opt/airfoils-pro/releases/{BOUND_REVISION}-52c8bd3aa6d5a05d"': f'EXPECTED_BOUND_APP_REAL="{base}"',
        'EXPECTED_APP_LINK="/opt/airfoils-pro/app"': f'EXPECTED_APP_LINK="{app}"',
        'EXPECTED_STATE_DIR="/opt/airfoils-pro/state"': f'EXPECTED_STATE_DIR="{state}"',
        'EXPECTED_ENV_FILE="/opt/airfoils-pro/state/.env.deploy"': f'EXPECTED_ENV_FILE="{env_file}"',
        'EXPECTED_CANONICAL_LOCK_FILE="/tmp/airfoils-pro-deploy.lock"': f'EXPECTED_CANONICAL_LOCK_FILE="{tmp_path / "deploy.lock"}"',
        'EXPECTED_INITIAL_ENV_SHA256="a34fa01374905d4f037fb36ac0ca2981b89443c80d9ae6896bdb9f788608481a"': f'EXPECTED_INITIAL_ENV_SHA256="{_sha(env_file)}"',
        'EXPECTED_PRIOR_SOURCE_BOUND_ENV_SHA256="818da3d18a1368c7a25a37c741aba2a1acfc0969c43ad1a6d9c518fcda44b07b"': f'EXPECTED_PRIOR_SOURCE_BOUND_ENV_SHA256="{_sha(source_bound_env)}"',
        'EXPECTED_INITIAL_DATABASE_SHA256="8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c"': f'EXPECTED_INITIAL_DATABASE_SHA256="{failed_payload["currentDatabaseSnapshotSha256"]}"',
        'EXPECTED_PRIOR_RETENTION_JOURNAL_SHA256="b99ca862100542593f7d8fc24dd47b9d62eb3e4d657dbc1c1590ce6c90050224"': f'EXPECTED_PRIOR_RETENTION_JOURNAL_SHA256="{_sha(failed)}"',
    }
    for old, new in replacements.items():
        assert old in wrapper_text
        wrapper_text = wrapper_text.replace(old, new)
    _write(wrapper, wrapper_text, executable=True)
    # Wrapper bytes changed again, so the target manifest must be resealed.
    target_tree, _ = _seal(target, TARGET_REVISION)
    target_inventory = _inventory(target)
    target_inventory_path = target / ".codex-artifacts/opencfd2606-transient-retention-target-ls-tree.txt"
    _write(target_inventory_path, target_inventory)
    target_inventory_path.chmod(0o600)
    target_app_source = subprocess.check_output(
        ["python3", "-c", "from pathlib import Path; from airfoilfoam.provenance import application_source_sha256; import sys; print(application_source_sha256(Path(sys.argv[1])))", str(target)],
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(target / "src")}, text=True,
    ).strip()
    env = {**os.environ, "PATH": f"{fake_bin}:{os.environ['PATH']}", "STAGING_DIR": str(target), "EXPECTED_TARGET_SOURCE_REVISION": TARGET_REVISION, "EXPECTED_TARGET_GIT_INVENTORY_SHA256": hashlib.sha256(target_inventory).hexdigest(), "CALL_LOG": str(files["calls"]), "DB_FILE": str(files["db"]), "API_IMAGE_FILE": str(files["api-image"]), "WORKER_IMAGE_FILE": str(files["worker-image"]), "API_TAG_FILE": str(files["api-tag"]), "WORKER_TAG_FILE": str(files["worker-tag"]), "NODE_IMAGE_FILE": str(files["node-image"]), "NODE_TAG_FILE": str(files["node-tag"]), "REPLAY_TAG_FILE": str(files["replay-tag"]), "ROLLBACK_TAG_FILE": str(files["rollback-tag"]), "NODE_CONTAINER_FILE": str(files["node-container"]), "API_CONTAINER_FILE": str(files["api-container"]), "WORKER_CONTAINER_FILE": str(files["worker-container"]), "NODE_BUILD_FILE": str(files["node-build"]), "ENGINE_BUILD_FILE": str(files["engine-build"]), "API_SOURCE_FILE": str(files["api-source"]), "WORKER_SOURCE_FILE": str(files["worker-source"]), "CHILD_CALLS": str(files["child-calls"]), "RUNTIME_DIR_PATH": str(runtime), "RUNTIME_SOURCE": str(runtime / "source"), "EXPECTED_CANONICAL_LOCK": str(tmp_path / "deploy.lock"), "TARGET_REVISION_VALUE": TARGET_REVISION, "TARGET_TREE_VALUE": target_tree, "TARGET_BUILD_VALUE": TARGET_BUILD, "TARGET_APP_SOURCE_SHA": target_app_source, "NEW_API_IMAGE": NEW_API_IMAGE, "NEW_WORKER_IMAGE": NEW_WORKER_IMAGE, "NODE_CONTAINER_AFTER": NODE_CONTAINER_AFTER, "API_CONTAINER_AFTER": API_CONTAINER_AFTER, "WORKER_CONTAINER_AFTER": WORKER_CONTAINER_AFTER, "NODE_ADMIN_SHA": _sha(target / "apps/api/src/admin-routes.ts"), "NODE_ATTEST_SHA": _sha(target / "apps/api/src/openfoam-2606-attestation.ts"), "FAKE_COOKIE": COOKIE, "ATTESTED_DB_JSON": json.dumps(attested_db, sort_keys=True, separators=(",", ":")), "TERMINAL_DB_JSON": json.dumps(terminal_db, sort_keys=True, separators=(",", ":"))}
    return env, wrapper, state, files


def _run(env: dict[str, str], wrapper: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run([wrapper], env=env, text=True, capture_output=True, check=False)


def _refresh_target_inventory(target: Path, env: dict[str, str]) -> None:
    payload = _inventory(target)
    path = target / ".codex-artifacts/opencfd2606-transient-retention-target-ls-tree.txt"
    _write(path, payload)
    path.chmod(0o600)
    env["EXPECTED_TARGET_GIT_INVENTORY_SHA256"] = hashlib.sha256(payload).hexdigest()


def test_retry_builds_from_target_snapshot_reuses_node_and_stops_at_attestation(harness) -> None:
    env, wrapper, state, files = harness
    prior_journal = state / "pending-opencfd2606-retention-retry.json"
    prior_journal_bytes = prior_journal.read_bytes()
    prior_wrapper = Path(env["STAGING_DIR"]) / "scripts/deploy/retry-pending-opencfd2606-retention.sh"
    prior_wrapper_bytes = prior_wrapper.read_bytes()
    completed = _run(env, wrapper)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "source promotion is NOT eligible" in completed.stdout
    payload = json.loads((state / "pending-opencfd2606-transient-retention-retry.json").read_text())
    assert payload["status"] == "attested_awaiting_continuation"
    assert payload["promotionEligible"] is False
    assert payload["nodeApiImage"] == NODE_IMAGE
    assert payload["nodeApiContainerBefore"] == NODE_CONTAINER
    assert payload["nodeApiContainerAfter"] == NODE_CONTAINER_AFTER
    assert payload["apiContainerBefore"] == API_CONTAINER
    assert payload["workerContainerBefore"] == WORKER_CONTAINER
    assert payload["engineSourceRevision"] == TARGET_REVISION
    assert payload["priorFailedRetentionJournalSha256"] == hashlib.sha256(prior_journal_bytes).hexdigest()
    assert prior_journal.read_bytes() == prior_journal_bytes
    assert prior_wrapper.read_bytes() == prior_wrapper_bytes
    assert files["node-tag"].read_text() == NODE_IMAGE
    calls = files["calls"].read_text()
    assert "docker build" not in calls
    assert "docker image tag" not in calls
    assert files["child-calls"].read_text().splitlines() == [TARGET_BUILD]


def test_retry_from_attested_state_uses_certification_only_and_marks_terminal(harness) -> None:
    env, wrapper, state, files = harness
    first = _run(env, wrapper)
    assert first.returncode == 0, first.stdout + first.stderr
    # The observed successor run may legitimately re-enable the target pool
    # between the canary and exact certification replays.  The wrapper admits
    # that DB drift only while the one attestation/one finalized cutover shape
    # remains exact and the scheduler/engine are quiescent again.
    progressed = json.loads(files["db"].read_text())
    progressed["poolEnabled"] = True
    files["db"].write_text(json.dumps(progressed, sort_keys=True, separators=(",", ":")))
    env["FAKE_CERTIFY_TERMINAL"] = "1"
    second = _run(env, wrapper)
    assert second.returncode == 0, second.stdout + second.stderr
    payload = json.loads((state / "pending-opencfd2606-transient-retention-retry.json").read_text())
    assert payload["status"] == "completed"
    assert payload["currentCutoverStateKind"] == "terminal"
    assert payload["promotionEligible"] is True
    assert files["child-calls"].read_text().splitlines() == [TARGET_BUILD, "--certify-opencfd-2606-continuation"]


def test_failed_child_is_journaled_and_exact_retry_resumes_without_node_build(harness) -> None:
    env, wrapper, state, files = harness
    env["FAKE_CHILD_FAIL_BEFORE"] = "1"
    failed = _run(env, wrapper)
    assert failed.returncode == 55
    payload = json.loads((state / "pending-opencfd2606-transient-retention-retry.json").read_text())
    assert payload["status"] == "failed"
    assert payload["failureCount"] == 1
    assert payload["lastExitCode"] == 55
    env.pop("FAKE_CHILD_FAIL_BEFORE")
    resumed = _run(env, wrapper)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    assert json.loads((state / "pending-opencfd2606-transient-retention-retry.json").read_text())["status"] == "attested_awaiting_continuation"
    assert files["node-tag"].read_text() == NODE_IMAGE
    assert "docker build" not in files["calls"].read_text()


@pytest.mark.parametrize(
    "mutation",
    ["journal", "base_inventory", "target_inventory", "unrelated", "missing_delta", "wrong_allowed_bytes", "critical", "env", "database", "api_image", "node_container"],
)
def test_retry_rejects_wrong_incident_or_source_before_runtime_mutation(harness, mutation: str) -> None:
    env, wrapper, state, files = harness
    target = Path(env["STAGING_DIR"])
    prior_journal = state / "pending-opencfd2606-retention-retry.json"
    prior_bytes = prior_journal.read_bytes()
    prior_wrapper = target / "scripts/deploy/retry-pending-opencfd2606-retention.sh"
    prior_wrapper_bytes = prior_wrapper.read_bytes()
    if mutation == "journal":
        prior_journal.write_text(prior_journal.read_text() + " ")
    elif mutation == "base_inventory":
        path = target / ".codex-artifacts/opencfd2606-transient-retention-base-ls-tree.txt"; path.write_text(path.read_text() + " ")
    elif mutation == "target_inventory":
        path = target / ".codex-artifacts/opencfd2606-transient-retention-target-ls-tree.txt"; path.write_text(path.read_text() + " ")
    elif mutation == "unrelated":
        _write(target / "src/unrelated.py", "unexpected\n")
        _seal(target, TARGET_REVISION)
        _refresh_target_inventory(target, env)
    elif mutation == "missing_delta":
        _write(target / "src/airfoilfoam/retention.py", subprocess.check_output(["git", "show", f"{BASE_REVISION}:src/airfoilfoam/retention.py"], cwd=ROOT))
        _seal(target, TARGET_REVISION)
        _refresh_target_inventory(target, env)
    elif mutation == "wrong_allowed_bytes":
        path = target / "src/airfoilfoam/pipeline.py"; path.write_text(path.read_text() + "\n# unreviewed allowed-path bytes\n")
        _seal(target, TARGET_REVISION)
        _refresh_target_inventory(target, env)
    elif mutation == "critical":
        prior_wrapper.write_text(prior_wrapper.read_text() + "\n# changed\n")
        _seal(target, TARGET_REVISION)
        _refresh_target_inventory(target, env)
    elif mutation == "env":
        path = state / ".env.deploy"; path.write_text(path.read_text() + "UNEXPECTED=1\n"); path.chmod(0o600)
    elif mutation == "database":
        payload = json.loads(files["db"].read_text()); payload["poolEnabled"] = True
        files["db"].write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    elif mutation == "api_image":
        files["api-image"].write_text("sha256:" + "f" * 64)
    else:
        files["node-container"].write_text("f" * 64)
    completed = _run(env, wrapper)
    assert completed.returncode != 0
    assert not (state / "pending-opencfd2606-transient-retention-retry.json").exists()
    assert files["api-image"].read_text() == ("sha256:" + "f" * 64 if mutation == "api_image" else OLD_API_IMAGE)
    assert files["node-tag"].read_text() == NODE_IMAGE
    if mutation != "journal":
        assert prior_journal.read_bytes() == prior_bytes
    if mutation != "critical":
        assert prior_wrapper.read_bytes() == prior_wrapper_bytes


def test_retry_refuses_active_solver_and_canonical_lock_contention(harness) -> None:
    env, wrapper, state, files = harness
    env["FAKE_ACTIVE_SOLVER"] = "1"
    active = _run(env, wrapper)
    assert active.returncode != 0
    assert "active OpenFOAM work" in active.stderr
    env.pop("FAKE_ACTIVE_SOLVER")
    env["FAKE_SWEEPER_RUNNING"] = "1"
    sweeper = _run(env, wrapper)
    assert sweeper.returncode != 0
    assert "scheduler to remain stopped" in sweeper.stderr
    env.pop("FAKE_SWEEPER_RUNNING")
    holder = subprocess.Popen(["flock", str(Path(env["EXPECTED_CANONICAL_LOCK"])), "sleep", "20"])
    try:
        locked = _run(env, wrapper)
    finally:
        holder.terminate(); holder.wait(timeout=5)
    assert locked.returncode == 9
    assert not (state / "pending-opencfd2606-transient-retention-retry.json").exists()


def test_production_wrapper_and_workflow_contract_are_narrow() -> None:
    wrapper = WRAPPER.read_text()
    workflow = (ROOT / ".github/workflows/deploy-airfoils-pro.yml").read_text()
    assert "pending-opencfd2606-transient-retention-retry.json" in wrapper
    assert "attested_awaiting_continuation" in wrapper
    assert "promotionEligible" in wrapper
    assert "docker build" not in wrapper
    assert "docker image tag" not in wrapper
    assert "src/airfoilfoam/pipeline.py" in wrapper
    assert "src/airfoilfoam/retention.py" in wrapper
    assert "tests/test_retention.py" in wrapper
    assert "0ec006a1db421bc8cfce5c4f422966913b9d477f1ca347ddd2ad6eaa3505a176" in wrapper
    assert "71c64e20c5b6b7a15b94a104819b3cb5639c42348b2a11ec822e1588e8805523" in wrapper
    assert "672a53783accaa66e806cbf3849bcdebf3377035e22400a7e3730f2318fcf84c" in wrapper
    assert "818da3d18a1368c7a25a37c741aba2a1acfc0969c43ad1a6d9c518fcda44b07b" in wrapper
    assert WRAPPER.stat().st_mode & 0o111
    assert "pending_cutover_transient_retention_retry:" in workflow
    assert "retry-pending-opencfd2606-transient-retention.sh" in workflow
    assert "opencfd2606-transient-retention-base-ls-tree.txt" in workflow
    assert "opencfd2606-transient-retention-target-ls-tree.txt" in workflow
    assert PRIOR_WRAPPER.read_bytes() == subprocess.check_output(
        ["git", "show", f"{BASE_REVISION}:scripts/deploy/retry-pending-opencfd2606-retention.sh"], cwd=ROOT
    )
