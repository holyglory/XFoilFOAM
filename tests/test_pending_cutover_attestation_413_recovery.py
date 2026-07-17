from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import fcntl

import pytest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts/deploy/recover-pending-opencfd2606-attestation-413.sh"
MANIFEST = ROOT / "scripts/deploy/deployment-source-manifest.py"
TARGET_REVISION = "d" * 40
BASE_REVISION = "7a13801aa5b39acba03ff256d1d3256655f6a275"
BOUND_REVISION = "63385777be7323777906fde44bdb9fa9b5cc0d6d"
BASE_TREE = "b" * 64
BUILD_ID = "prod-20260717-7a13801aa5b3-r5"
OLD_NODE_IMAGE = "sha256:" + "1" * 64
NEW_NODE_IMAGE = "sha256:" + "2" * 64
API_IMAGE = "sha256:" + "3" * 64
WORKER_IMAGE = "sha256:" + "4" * 64
OLD_NODE_CONTAINER = "5" * 64
NEW_NODE_CONTAINER = "6" * 64
ROLLBACK_NODE_CONTAINER = "7" * 64
API_CONTAINER = "8" * 64
WORKER_CONTAINER = "9" * 64
ATTESTATION_ID = "11111111-1111-4111-8111-111111111111"
COOKIE = "aero_admin=fixture_payload.fixture_signature"


def _write(path: Path, value: str | bytes, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(0o755 if executable else 0o644)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _seal(root: Path, revision: str) -> tuple[str, int]:
    result = subprocess.run(
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
    _, tree, count = result.stdout.strip().split("\t")
    return tree, int(count)


def _git_blob(payload: bytes) -> str:
    return hashlib.sha1(
        b"blob " + str(len(payload)).encode() + b"\0" + payload
    ).hexdigest()


def _inventory(root: Path) -> bytes:
    excluded_dirs = {
        ".git",
        ".github",
        ".codex-artifacts",
        "node_modules",
        ".next",
        "data",
        "VTK",
        "postProcessing",
    }
    lines: list[str] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root)
        if relative.name == ".deployment-source.json" or any(
            part in excluded_dirs for part in relative.parts
        ):
            continue
        mode = "100755" if path.stat().st_mode & 0o111 else "100644"
        lines.append(
            f"{mode} blob {_git_blob(path.read_bytes())}\t{relative.as_posix()}"
        )
    return ("\n".join(lines) + "\n").encode()


def _replace_env(path: Path, updates: dict[str, str]) -> None:
    seen = {key: 0 for key in updates}
    lines: list[str] = []
    for line in path.read_text().splitlines():
        key = line.split("=", 1)[0]
        if key in updates:
            seen[key] += 1
            line = f"{key}={updates[key]}"
        lines.append(line)
    assert all(value == 1 for value in seen.values())
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o600)


FAKE_STATE_TOOL = r"""#!/usr/bin/env python3
import argparse,json
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument("--env-file",required=True); p.add_argument("--receipt-file",required=True)
p.add_argument("--current-source-revision"); p.add_argument("--current-source-tree-sha256")
p.add_argument("--require-state"); p.add_argument("--print-json",action="store_true")
a=p.parse_args()
values={}
for line in Path(a.env_file).read_text().splitlines():
    if "=" in line:
        key,value=line.split("=",1); values[key]=value
if values.get("OPENCFD2606_CUTOVER_PENDING")=="0" and values.get("OPENCFD2606_CUTOVER_COMPLETE")=="1":
    kind="terminal"
elif values.get("OPENCFD2606_CANARY_ATTESTATION_ID"):
    kind="pending-attested-retained-receipt" if Path(a.receipt_file).exists() else "pending-attested"
elif Path(a.receipt_file).exists():
    kind="pending-receipt"
else:
    kind="pending-pristine"
print(json.dumps({"state_kind":kind}))
"""


FAKE_CHILD = r"""#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CHILD_CALLS"
[[ "$#" == "1" && "$1" == "--certify-opencfd-2606-continuation" ]]
[[ "$APP_DIR" == /dev/shm/* ]]
[[ "$DEPLOY_SOURCE_REVISION" == "$TARGET_REVISION_VALUE" ]]
[[ "$DEPLOY_SOURCE_TREE_SHA256" == "$TARGET_TREE_VALUE" ]]
[[ "$(cat "$API_CONTAINER_FILE")" == "$EXPECTED_API_CONTAINER_VALUE" ]]
[[ "$(cat "$WORKER_CONTAINER_FILE")" == "$EXPECTED_WORKER_CONTAINER_VALUE" ]]
mode="${FAKE_CHILD_MODE:-await}"
if [[ "$mode" == "reject" ]]; then exit 15; fi
python3 - "$ENV_FILE" "$mode" <<'PY'
from pathlib import Path
import os,sys
path=Path(sys.argv[1]); mode=sys.argv[2]
if mode=="terminal":
    updates={
      "OPENCFD2606_CUTOVER_PENDING":"0","OPENCFD2606_CUTOVER_COMPLETE":"1",
      "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING":"",
      "OPENCFD2606_CANARY_ATTESTATION_ID":"",
      "OPENCFD2606_CANARY_RECEIPT_EXPECTED":"0",
      "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256":"e"*64,
      "OPENCFD2606_CUTOVER_SOURCE_REVISION":"",
      "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256":"",
    }
else:
    updates={
      "OPENCFD2606_CANARY_ATTESTATION_ID":os.environ["ATTESTATION_ID_VALUE"],
      "OPENCFD2606_CANARY_RECEIPT_EXPECTED":"0",
      "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256":"e"*64,
    }
lines=[]
for line in path.read_text().splitlines():
    key=line.split("=",1)[0]
    lines.append(f"{key}={updates[key]}" if key in updates else line)
path.write_text("\n".join(lines)+"\n"); path.chmod(0o600)
PY
rm -f "$OPENCFD2606_CANARY_RECEIPT_FILE"
if [[ "$mode" == "terminal" ]]; then
  printf '%s' "$TERMINAL_DB_JSON" >"$DB_FILE"
  exit 0
fi
printf '%s' "$ATTESTED_DB_JSON" >"$DB_FILE"
exit 14
"""


def _fixture_sources(
    tmp_path: Path,
    env_before_sha: str,
    db_before_sha: str,
    receipt_sha: str,
    receipt_size: int,
    failed_journal_sha: str,
    application_sha: str,
) -> tuple[Path, Path, Path, str, int, str, int, str]:
    bound = tmp_path / "bound"
    base = tmp_path / "base"
    target = tmp_path / "target"

    for root in (bound, base):
        _write(
            root / "scripts/deploy/deployment-source-manifest.py",
            MANIFEST.read_bytes(),
            executable=True,
        )
        _write(
            root / "scripts/deploy/opencfd2606_cutover_state.py",
            FAKE_STATE_TOOL,
            executable=True,
        )
        _write(
            root / "scripts/deploy/deployment-env-preflight.py",
            "#!/usr/bin/env python3\nraise SystemExit(0)\n",
            executable=True,
        )
        _write(
            root / "scripts/deploy/rebuild-engine.sh",
            FAKE_CHILD,
            executable=True,
        )
        _write(root / "scripts/deploy/openfoam_2606_canary.py", "# sealed canary\n")
        _write(root / "src/airfoilfoam/__init__.py", "")
        _write(root / "src/airfoilfoam/provenance.py", (ROOT / "src/airfoilfoam/provenance.py").read_bytes())
        _write(root / "src/airfoilfoam/pipeline.py", "# unchanged pipeline\n")
        _write(root / "src/airfoilfoam/retention.py", "# unchanged retention\n")
        _write(root / "apps/api/src/openfoam-2606-attestation.ts", "sealed attestation\n")
        _write(root / "apps/api/src/engine-cutover-routes.ts", "old route\n")
        _write(root / "apps/api/test/engine-cutover-routes.test.ts", "old route test\n")
        _write(root / "docker/Dockerfile.node", "FROM scratch\n")
        _write(root / "docker-compose.deploy.yml", "services: {}\n")
        _write(root / "pyproject.toml", "[project]\nname='fixture'\nversion='0.0.0'\n")

    bound_tree, bound_count = _seal(bound, BOUND_REVISION)
    shutil.copytree(base, target)
    _write(target / "apps/api/src/engine-cutover-routes.ts", "new bounded route\n")
    _write(target / "apps/api/test/engine-cutover-routes.test.ts", "new bounded route test\n")
    _write(
        target / "tests/test_pending_cutover_attestation_413_recovery.py",
        "# additive recovery harness\n",
    )

    wrapper = WRAPPER.read_text()
    replacements = {
        "d7583f9a47c33eacee9a099a3721f2a7a5bb506f9ecfcb02201396c47d9e96ed": BASE_TREE,
        "52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36": bound_tree,
        'EXPECTED_BOUND_SOURCE_FILE_COUNT="2198"': f'EXPECTED_BOUND_SOURCE_FILE_COUNT="{bound_count}"',
        "/opt/airfoils-pro/releases/63385777be7323777906fde44bdb9fa9b5cc0d6d-52c8bd3aa6d5a05d": str(bound),
        "/opt/airfoils-pro/app": str(tmp_path / "app"),
        "/opt/airfoils-pro/state/.env.deploy": str(tmp_path / "state/.env.deploy"),
        "/opt/airfoils-pro/state": str(tmp_path / "state"),
        "/tmp/airfoils-pro-deploy.lock": str(tmp_path / "deploy.lock"),
        "e3a58d52ea4e8e04b305ef084bbf772d626c119978da65d820b7c51c1c8c23bf": env_before_sha,
        "8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c": db_before_sha,
        "075f5dc83dd01356fd6192375d595cf28ad5625fec30499215de4fa235b19236": failed_journal_sha,
        "505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8": receipt_sha,
        'EXPECTED_RECEIPT_BYTE_SIZE="2313736"': f'EXPECTED_RECEIPT_BYTE_SIZE="{receipt_size}"',
        '"retainedReceiptByteSize":2313736': f'"retainedReceiptByteSize":{receipt_size}',
        "661f7061ecd12932305c5a3c479e8d1680d1bcc3ab7e8cd020ab66f5a57075db": application_sha,
        "sha256:89069188e2e57cad231dcf3527eaba2e5151b0886921eac4f720d589d09e66af": OLD_NODE_IMAGE,
        "sha256:0671d20962896f3d1413b83d3f384a4ba06ca2bdaedcf187822f19994cc7a3c1": API_IMAGE,
        "sha256:9f9a957e3e51d78701eeebd9ead90d5d26c234b9e91ae80f6e81316d017f35a6": WORKER_IMAGE,
        "3bb29e702d06dbe1e6f657b3aa7c94e65164d5c12bd215e60bbfa5ac55a8a864": OLD_NODE_CONTAINER,
        "44dfc912a91e92ab42faa8c5078041cfbecf3452c37765aa838b0fc4872531ef": API_CONTAINER,
        "7f43b1b65edf4dc758f34a5fc2555e2fae401010ae6ea34ff39fae846b4081f8": WORKER_CONTAINER,
        "8510628cdc4e2e7e625776acbf63fa571c0b0e72d3a16f789ac94757b55e24db": _sha(base / "apps/api/src/engine-cutover-routes.ts"),
        "406ec040921097d49f1ac2ce52197e3e45eed86dd6277703af2043afe3d8b1b4": _sha(base / "apps/api/test/engine-cutover-routes.test.ts"),
        "806243c45225487036f98bf144f6bc362e0d54324f640ac59a440f5a5700d15d": _sha(target / "apps/api/src/engine-cutover-routes.ts"),
        "ea1d72664200d4c29f140b0ca543e34c2bdb5e35c58e61081aa7a5cfd8afd6bd": _sha(target / "apps/api/test/engine-cutover-routes.test.ts"),
        "008b8d8e92493b33eb7888b3dd6651696c512eddba377ee342b03dca6f51441f": _sha(target / "scripts/deploy/rebuild-engine.sh"),
        "df6f7558e3d53e1f7fd6158c171d02a1d62fe74ce721eb6cdb0132e6efff8f48": _sha(target / "scripts/deploy/openfoam_2606_canary.py"),
    }
    for old, new in replacements.items():
        assert old in wrapper, old
        wrapper = wrapper.replace(old, new)
    _write(
        target / "scripts/deploy/recover-pending-opencfd2606-attestation-413.sh",
        wrapper,
        executable=True,
    )

    base_inventory = _inventory(base)
    base_inventory_sha = hashlib.sha256(base_inventory).hexdigest()
    wrapper = (
        target / "scripts/deploy/recover-pending-opencfd2606-attestation-413.sh"
    ).read_text()
    assert (
        "08a0dd7c280654ac4567563e773a95420db79286a4ec1be3f4755f978863cb74"
        in wrapper
    )
    wrapper = wrapper.replace(
        "08a0dd7c280654ac4567563e773a95420db79286a4ec1be3f4755f978863cb74",
        base_inventory_sha,
    )
    _write(
        target / "scripts/deploy/recover-pending-opencfd2606-attestation-413.sh",
        wrapper,
        executable=True,
    )
    target_tree, target_count = _seal(target, TARGET_REVISION)
    target_inventory = _inventory(target)
    artifacts = target / ".codex-artifacts"
    _write(
        artifacts / "opencfd2606-attestation-413-base-ls-tree.txt",
        base_inventory,
    )
    _write(
        artifacts / "opencfd2606-attestation-413-target-ls-tree.txt",
        target_inventory,
    )
    for path in artifacts.iterdir():
        path.chmod(0o600)
    return (
        bound,
        target,
        target / "scripts/deploy/recover-pending-opencfd2606-attestation-413.sh",
        bound_tree,
        bound_count,
        target_tree,
        target_count,
        hashlib.sha256(target_inventory).hexdigest(),
    )


def _fake_runtime(tmp_path: Path) -> tuple[Path, dict[str, Path]]:
    fake_bin = tmp_path / "bin"
    names = (
        "calls",
        "child-calls",
        "db",
        "node-image",
        "node-container",
        "node-source",
        "app-tag",
        "repair-tag",
        "rollback-tag",
        "api-image",
        "worker-image",
        "api-container",
        "worker-container",
        "app-source",
    )
    files = {name: tmp_path / name for name in names}
    _write(
        fake_bin / "docker",
        r"""#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$CALL_LOG"
joined=" $* "
if [[ "$joined" == *" compose version "* ]]; then exit 0; fi
if [[ "$joined" == *" ps --status running -q sweeper "* ]]; then exit 0; fi
if [[ "$joined" == *" ps --status running -q node-api "* ]]; then
  [[ -s "$NODE_CONTAINER_FILE" ]] && { cat "$NODE_CONTAINER_FILE"; printf '\n'; }; exit 0
fi
if [[ "$joined" == *" ps --status running -q api "* ]]; then cat "$API_CONTAINER_FILE"; printf '\n'; exit 0; fi
if [[ "$joined" == *" ps --status running -q worker "* ]]; then cat "$WORKER_CONTAINER_FILE"; printf '\n'; exit 0; fi
if [[ "$joined" == *" exec -T postgres psql "* ]]; then
  if [[ "$joined" == *"liveCampaignJobs"* ]]; then
    printf '%s\n' '{"campaignStatus":"paused","liveCampaignJobs":0,"checks":[{"status":"pending","simJobId":null,"evidenceResultId":null}]}'
  elif [[ "$joined" == *"campaignStatus"* ]]; then
    printf '%s\n' '{"pools":[{"id":"3f8bc764-09ae-4ff3-8fd2-001400000001","enabled":false},{"id":"3f8bc764-09ae-4ff3-8fd2-240600000001","enabled":false},{"id":"3f8bc764-09ae-4ff3-8fd2-260600000001","enabled":false}],"campaignStatus":"paused"}'
  else
    cat "$DB_FILE"; printf '\n'
  fi
  exit 0
fi
if [[ "$joined" == *" exec -T worker sh -lc "* ]]; then
  [[ "${FAKE_ACTIVE_SOLVER:-0}" == "1" ]] && printf '42 pimpleFoam\n'
  exit 0
fi
if [[ "${1:-}" == "ps" ]]; then exit 0; fi
if [[ "${1:-}" == "inspect" ]]; then
  id="${@: -1}"
  case "$id" in
    "$(cat "$NODE_CONTAINER_FILE" 2>/dev/null || true)") cat "$NODE_IMAGE_FILE" ;;
    "$(cat "$API_CONTAINER_FILE")") cat "$API_IMAGE_FILE" ;;
    "$(cat "$WORKER_CONTAINER_FILE")") cat "$WORKER_IMAGE_FILE" ;;
    *) exit 1 ;;
  esac
  printf '\n'; exit 0
fi
if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  tag="${@: -1}"
  case "$tag" in
    app-node-api) cat "$APP_TAG_FILE" ;;
    app-api) cat "$API_IMAGE_FILE" ;;
    app-worker) cat "$WORKER_IMAGE_FILE" ;;
    *node-api-attestation-413-rollback*) cat "$ROLLBACK_TAG_FILE" ;;
    *node-api-attestation-413*) cat "$REPAIR_TAG_FILE" ;;
    sha256:*) printf '%s' "$tag" ;;
    *) exit 1 ;;
  esac
  printf '\n'; exit 0
fi
if [[ "${1:-}" == "exec" ]]; then
  id="${2:-}"
  if [[ "$id" == "$(cat "$API_CONTAINER_FILE")" || "$id" == "$(cat "$WORKER_CONTAINER_FILE")" ]]; then
    cat "$APP_SOURCE_FILE"; printf '\n'; exit 0
  fi
  if [[ "$joined" == *" sha256sum /app/apps/api/src/engine-cutover-routes.ts "* ]]; then
    if [[ "$(cat "$NODE_SOURCE_FILE")" == "new" ]]; then
      printf '%s  /app/apps/api/src/engine-cutover-routes.ts\n' "$NEW_ROUTE_SHA"
      printf '%s  /app/apps/api/test/engine-cutover-routes.test.ts\n' "$NEW_ROUTE_TEST_SHA"
    else
      printf '%s  /app/apps/api/src/engine-cutover-routes.ts\n' "$OLD_ROUTE_SHA"
      printf '%s  /app/apps/api/test/engine-cutover-routes.test.ts\n' "$OLD_ROUTE_TEST_SHA"
    fi
    exit 0
  fi
  if [[ "$joined" == *" sha256sum /app/apps/api/src/admin-routes.ts "* ]]; then
    printf '%s  /app/apps/api/src/admin-routes.ts\n' "$ADMIN_ROUTES_SHA"
    exit 0
  fi
  if [[ "$joined" == *" sha256sum /app/apps/api/src/openfoam-2606-attestation.ts "* ]]; then
    printf '%s  /app/apps/api/src/openfoam-2606-attestation.ts\n' "$ATTESTATION_SOURCE_SHA"
    exit 0
  fi
  if [[ "$joined" == *" printenv ENGINE_EXPECTED_BUILD_ID "* ]]; then
    printf '%s\n' "$EXPECTED_BUILD_ID_VALUE"
    exit 0
  fi
  if [[ "$joined" == *" pnpm exec tsx "* ]]; then printf '%s' "$COOKIE_VALUE"; exit 0; fi
fi
if [[ "${1:-}" == "tag" ]]; then
  source="$2"; target="$3"
  case "$source" in
    "$OLD_NODE_IMAGE") value="$OLD_NODE_IMAGE" ;;
    *node-api-attestation-413*) value="$(cat "$REPAIR_TAG_FILE")" ;;
    *) value="$source" ;;
  esac
  case "$target" in
    app-node-api) printf '%s' "$value" >"$APP_TAG_FILE" ;;
    *rollback*) printf '%s' "$value" >"$ROLLBACK_TAG_FILE" ;;
    *attestation-413*) printf '%s' "$value" >"$REPAIR_TAG_FILE" ;;
  esac
  exit 0
fi
if [[ "${1:-}" == "build" ]]; then
  [[ "${FAKE_BUILD_FAIL:-0}" != "1" ]] || exit 55
  printf '%s' "$NEW_NODE_IMAGE" >"$REPAIR_TAG_FILE"
  exit 0
fi
if [[ "$joined" == *" up -d --no-deps --force-recreate node-api "* ]]; then
  image="$(cat "$APP_TAG_FILE")"
  printf '%s' "$image" >"$NODE_IMAGE_FILE"
  if [[ "$image" == "$NEW_NODE_IMAGE" ]]; then
    printf '%s' "$NEW_NODE_CONTAINER" >"$NODE_CONTAINER_FILE"
    printf new >"$NODE_SOURCE_FILE"
  else
    printf '%s' "$ROLLBACK_NODE_CONTAINER" >"$NODE_CONTAINER_FILE"
    printf old >"$NODE_SOURCE_FILE"
  fi
  exit 0
fi
echo "unhandled docker invocation: $*" >&2
exit 97
""",
        executable=True,
    )
    _write(
        fake_bin / "curl",
        r"""#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$CALL_LOG"
joined=" $* "
if [[ "$joined" == *" --config - "* ]]; then
  cat >/dev/null
fi
if [[ "$joined" == *"127.0.0.1:8000/queue"* ]]; then
  printf '%s' '{"active_count":0,"reserved_count":0,"scheduled_count":0,"queue_depth":0,"job_ids":[],"inspection_errors":{},"worker_queues_error":null,"worker_runtime_error":null,"worker_queues":[{"worker":"fixture","queues":["openfoam-opencfd-2606"],"execution_pool":"openfoam-opencfd-2606","engine":{"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1}}]}'
  exit 0
fi
if [[ "$joined" == *"127.0.0.1:8000/health"* ]]; then
  printf '%s' '{"build_id":"prod-20260717-7a13801aa5b3-r5","default_engine":{"family":"openfoam","distribution":"opencfd","version":"2606","numerics_revision":"1","adapter_contract_version":1},"evidence_storage":{"backend":"gcs","bucket":"airfoils-pro-storage-bucket","object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":true}}'
  exit 0
fi
if [[ "$joined" == *"127.0.0.1:4000/api/admin/me"* ]]; then
  printf '%s' '{"authed":true,"email":"cutover-attestation-413@airfoils.pro"}'
  exit 0
fi
if [[ "$joined" == *"/api/admin/solver-engine-cutovers/opencfd-2606/attest"* ]]; then
  status="${FAKE_PARSER_STATUS:-422}"
  output=""
  args=("$@")
  for ((i=0;i<${#args[@]};i++)); do
    [[ "${args[$i]}" == "--output" ]] && output="${args[$((i+1))]}"
  done
  [[ -z "$output" ]] || printf '%s' '{"code":"validation","error":"invalid OpenCFD v2606 cutover request"}' >"$output"
  printf '%s' "$status"; exit 0
fi
if [[ "$joined" == *"127.0.0.1:4000/health"* ]]; then
  if [[ "${FAKE_FAIL_REPAIRED_NODE_HEALTH:-0}" == "1" && "$(cat "$NODE_SOURCE_FILE")" == "new" ]]; then exit 22; fi
  printf '%s' '{"ok":true,"service":"aerodb-api"}'; exit 0
fi
echo "unhandled curl invocation: $*" >&2
exit 96
""",
        executable=True,
    )
    _write(fake_bin / "sleep", "#!/usr/bin/env bash\nexit 0\n", executable=True)
    return fake_bin, files


@pytest.fixture()
def harness(tmp_path: Path) -> tuple[dict[str, str], Path, dict[str, Path], Path]:
    state = tmp_path / "state"
    state.mkdir()
    env_file = state / ".env.deploy"
    env_file.write_text(
        "\n".join(
            [
                f"AIRFOILFOAM_BUILD_ID={BUILD_ID}",
                f"ENGINE_EXPECTED_BUILD_ID={BUILD_ID}",
                "OPENCFD2606_CUTOVER_PENDING=1",
                "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=0",
                "OPENCFD2606_CANARY_ATTESTATION_ID=",
                "OPENCFD2606_CUTOVER_COMPLETE=0",
                "OPENCFD2606_CANARY_RECEIPT_EXPECTED=1",
                "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=",
                f"OPENCFD2606_CUTOVER_SOURCE_REVISION={BASE_REVISION}",
                f"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256={BASE_TREE}",
            ]
        )
        + "\n"
    )
    env_file.chmod(0o600)
    env_before_sha = _sha(env_file)

    initial_db = json.dumps(
        {
            "poolRows": 1,
            "poolEnabled": False,
            "cutovers": [
                {
                    "id": "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee",
                    "status": "prepared",
                    "canaryAttestationId": None,
                    "targetPlanRevisionId": None,
                    "finalizedAt": None,
                    "completedAt": None,
                }
            ],
            "attestationCount": 0,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    attested_db = json.dumps(
        {
            "poolRows": 1,
            "poolEnabled": False,
            "cutovers": [
                {
                    "id": "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee",
                    "status": "finalized",
                    "canaryAttestationId": ATTESTATION_ID,
                    "targetPlanRevisionId": "22222222-2222-4222-8222-222222222222",
                    "finalizedAt": "2026-07-17T00:00:00Z",
                    "completedAt": None,
                }
            ],
            "attestationCount": 1,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    terminal_db = json.dumps(
        {
            "poolRows": 1,
            "poolEnabled": True,
            "cutovers": [
                {
                    "id": "b1d018a0-e0cc-4ffa-af5c-dcfd1c0ff7ee",
                    "status": "completed",
                    "canaryAttestationId": ATTESTATION_ID,
                    "targetPlanRevisionId": "22222222-2222-4222-8222-222222222222",
                    "finalizedAt": "2026-07-17T00:00:00Z",
                    "completedAt": "2026-07-17T00:10:00Z",
                }
            ],
            "attestationCount": 1,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    db_before_sha = _sha_text(initial_db)
    receipt = state / "openfoam-2606-canary-receipt.pending.json"
    receipt.write_bytes(b'{"fixture":"retained-receipt"}\n')
    receipt.chmod(0o600)
    receipt_sha = _sha(receipt)
    failed = state / "pending-opencfd2606-early-stop-retention-retry.json"
    failed.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "purpose": "pending-opencfd2606-early-stop-retention-retry",
                "status": "failed",
                "failureCount": 1,
                "lastExitCode": 14,
                "currentCanaryReceiptSha256": receipt_sha,
                "currentCutoverStateKind": "pending-receipt",
                "promotionEligible": False,
                "action": "rebuild_and_canary",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    )
    failed.chmod(0o600)

    application_root = tmp_path / "application-source"
    _write(application_root / "src/airfoilfoam/__init__.py", "")
    _write(application_root / "src/airfoilfoam/provenance.py", (ROOT / "src/airfoilfoam/provenance.py").read_bytes())
    _write(application_root / "src/airfoilfoam/pipeline.py", "# unchanged pipeline\n")
    _write(application_root / "src/airfoilfoam/retention.py", "# unchanged retention\n")
    _write(application_root / "pyproject.toml", "[project]\nname='fixture'\nversion='0.0.0'\n")
    application_sha = subprocess.check_output(
        [
            "python3",
            "-c",
            "from pathlib import Path; import sys; sys.path.insert(0,sys.argv[1]+'/src'); from airfoilfoam.provenance import application_source_sha256; print(application_source_sha256(Path(sys.argv[1])))",
            str(application_root),
        ],
        text=True,
    ).strip()

    (
        bound,
        target,
        wrapper,
        _,
        _,
        target_tree,
        _,
        target_inventory_sha,
    ) = _fixture_sources(
        tmp_path,
        env_before_sha,
        db_before_sha,
        receipt_sha,
        receipt.stat().st_size,
        _sha(failed),
        application_sha,
    )
    app_link = tmp_path / "app"
    app_link.symlink_to(bound, target_is_directory=True)

    fake_bin, files = _fake_runtime(tmp_path)
    values = {
        "calls": "",
        "child-calls": "",
        "db": initial_db,
        "node-image": OLD_NODE_IMAGE,
        "node-container": OLD_NODE_CONTAINER,
        "node-source": "old",
        "app-tag": OLD_NODE_IMAGE,
        "repair-tag": NEW_NODE_IMAGE,
        "rollback-tag": OLD_NODE_IMAGE,
        "api-image": API_IMAGE,
        "worker-image": WORKER_IMAGE,
        "api-container": API_CONTAINER,
        "worker-container": WORKER_CONTAINER,
        "app-source": application_sha,
    }
    for key, value in values.items():
        _write(files[key], value)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "STAGING_DIR": str(target),
        "APP_DIR": str(app_link),
        "AIRFOILS_PRO_STATE_DIR": str(state),
        "ENV_FILE": str(env_file),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "COMPOSE_PROJECT_NAME": "app",
        "EXPECTED_TARGET_SOURCE_REVISION": TARGET_REVISION,
        "EXPECTED_TARGET_GIT_INVENTORY_SHA256": target_inventory_sha,
        "CALL_LOG": str(files["calls"]),
        "CHILD_CALLS": str(files["child-calls"]),
        "DB_FILE": str(files["db"]),
        "NODE_IMAGE_FILE": str(files["node-image"]),
        "NODE_CONTAINER_FILE": str(files["node-container"]),
        "NODE_SOURCE_FILE": str(files["node-source"]),
        "APP_TAG_FILE": str(files["app-tag"]),
        "REPAIR_TAG_FILE": str(files["repair-tag"]),
        "ROLLBACK_TAG_FILE": str(files["rollback-tag"]),
        "API_IMAGE_FILE": str(files["api-image"]),
        "WORKER_IMAGE_FILE": str(files["worker-image"]),
        "API_CONTAINER_FILE": str(files["api-container"]),
        "WORKER_CONTAINER_FILE": str(files["worker-container"]),
        "APP_SOURCE_FILE": str(files["app-source"]),
        "OLD_NODE_IMAGE": OLD_NODE_IMAGE,
        "NEW_NODE_IMAGE": NEW_NODE_IMAGE,
        "OLD_NODE_CONTAINER": OLD_NODE_CONTAINER,
        "NEW_NODE_CONTAINER": NEW_NODE_CONTAINER,
        "ROLLBACK_NODE_CONTAINER": ROLLBACK_NODE_CONTAINER,
        "EXPECTED_API_CONTAINER_VALUE": API_CONTAINER,
        "EXPECTED_WORKER_CONTAINER_VALUE": WORKER_CONTAINER,
        "OLD_ROUTE_SHA": _sha(target.parent / "base/apps/api/src/engine-cutover-routes.ts"),
        "OLD_ROUTE_TEST_SHA": _sha(target.parent / "base/apps/api/test/engine-cutover-routes.test.ts"),
        "NEW_ROUTE_SHA": _sha(target / "apps/api/src/engine-cutover-routes.ts"),
        "NEW_ROUTE_TEST_SHA": _sha(target / "apps/api/test/engine-cutover-routes.test.ts"),
        "COOKIE_VALUE": COOKIE,
        "ADMIN_ROUTES_SHA": "e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4",
        "ATTESTATION_SOURCE_SHA": "928986cd328e7af647cefe7c241ed1a5ce9a6446907061055a28f28392c0944e",
        "EXPECTED_BUILD_ID_VALUE": BUILD_ID,
        "TARGET_REVISION_VALUE": TARGET_REVISION,
        "TARGET_TREE_VALUE": target_tree,
        "ATTESTATION_ID_VALUE": ATTESTATION_ID,
        "ATTESTED_DB_JSON": attested_db,
        "TERMINAL_DB_JSON": terminal_db,
    }
    return env, wrapper, files, state


def _run(env: dict[str, str], wrapper: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(wrapper)],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_exact_retained_receipt_is_attested_without_engine_rebuild(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    result = _run(env, wrapper)

    assert result.returncode == 0, result.stderr
    journal = json.loads(
        (state / "pending-opencfd2606-attestation-413-recovery.json").read_text()
    )
    assert journal["status"] == "attested_awaiting_continuation"
    assert journal["promotionEligible"] is False
    assert journal["lastExitCode"] == 14
    assert files["child-calls"].read_text().splitlines() == [
        "--certify-opencfd-2606-continuation"
    ]
    assert not (state / "openfoam-2606-canary-receipt.pending.json").exists()
    assert files["node-source"].read_text() == "new"
    assert files["api-container"].read_text() == API_CONTAINER
    assert files["worker-container"].read_text() == WORKER_CONTAINER

    calls = files["calls"].read_text()
    assert "docker build --pull=false" in calls
    assert "force-recreate node-api" in calls
    assert "force-recreate api" not in calls
    assert "force-recreate worker" not in calls


def test_parser_probe_413_refuses_receipt_consumption(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    env["FAKE_PARSER_STATUS"] = "413"

    result = _run(env, wrapper)

    assert result.returncode == 14
    assert "parser probe returned HTTP 413" in result.stderr
    assert files["child-calls"].read_text() == ""
    assert (state / "openfoam-2606-canary-receipt.pending.json").exists()
    assert files["api-container"].read_text() == API_CONTAINER
    assert files["worker-container"].read_text() == WORKER_CONTAINER

    env["FAKE_PARSER_STATUS"] = "422"
    resumed = _run(env, wrapper)
    assert resumed.returncode == 0, resumed.stderr
    assert not (state / "openfoam-2606-canary-receipt.pending.json").exists()


def test_unhealthy_node_swap_rolls_back_before_certification(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    env["FAKE_FAIL_REPAIRED_NODE_HEALTH"] = "1"

    result = _run(env, wrapper)

    assert result.returncode == 12
    assert files["node-source"].read_text() == "old"
    assert files["node-image"].read_text() == OLD_NODE_IMAGE
    assert files["child-calls"].read_text() == ""
    assert (state / "openfoam-2606-canary-receipt.pending.json").exists()
    assert files["api-container"].read_text() == API_CONTAINER
    assert files["worker-container"].read_text() == WORKER_CONTAINER


def test_unexpected_certification_failure_retains_receipt_and_is_not_eligible(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    env["FAKE_CHILD_MODE"] = "reject"

    result = _run(env, wrapper)

    assert result.returncode == 14
    assert (state / "openfoam-2606-canary-receipt.pending.json").exists()
    journal = json.loads(
        (state / "pending-opencfd2606-attestation-413-recovery.json").read_text()
    )
    assert journal["status"] == "failed"
    assert journal["promotionEligible"] is False
    assert files["child-calls"].read_text().splitlines() == [
        "--certify-opencfd-2606-continuation"
    ]

    env["FAKE_CHILD_MODE"] = "await"
    resumed = _run(env, wrapper)
    assert resumed.returncode == 0, resumed.stderr
    assert not (state / "openfoam-2606-canary-receipt.pending.json").exists()


def test_attested_replay_is_idempotent_and_does_not_claim_terminal_promotion(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    first = _run(env, wrapper)
    assert first.returncode == 0, first.stderr

    env["FAKE_CHILD_MODE"] = "terminal"
    second = _run(env, wrapper)

    assert second.returncode == 0, second.stderr
    journal = json.loads(
        (state / "pending-opencfd2606-attestation-413-recovery.json").read_text()
    )
    assert journal["status"] == "attested_awaiting_continuation"
    assert journal["promotionEligible"] is False
    assert files["child-calls"].read_text().splitlines() == [
        "--certify-opencfd-2606-continuation",
    ]
    assert "no replay was performed" in second.stdout


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("api-container", "api/worker container identity changed"),
        ("active-solver", "active OpenFOAM work"),
    ],
)
def test_engine_runtime_drift_fails_before_node_or_receipt_mutation(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
    mutation: str,
    message: str,
) -> None:
    env, wrapper, files, state = harness
    if mutation == "api-container":
        files["api-container"].write_text("0" * 64)
    else:
        env["FAKE_ACTIVE_SOLVER"] = "1"

    result = _run(env, wrapper)

    assert result.returncode == 12
    assert message in result.stderr
    assert files["node-source"].read_text() == "old"
    assert (state / "openfoam-2606-canary-receipt.pending.json").exists()
    assert files["child-calls"].read_text() == ""


def test_source_tamper_is_rejected_before_runtime_mutation(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    target_route = Path(env["STAGING_DIR"]) / "apps/api/src/engine-cutover-routes.ts"
    target_route.write_text(target_route.read_text() + "tamper\n")

    result = _run(env, wrapper)

    assert result.returncode != 0
    assert files["node-source"].read_text() == "old"
    assert (state / "openfoam-2606-canary-receipt.pending.json").exists()
    assert files["child-calls"].read_text() == ""


def test_deploy_lock_contention_is_non_mutating(
    harness: tuple[dict[str, str], Path, dict[str, Path], Path],
) -> None:
    env, wrapper, files, state = harness
    lock_path = Path(env["LOCK_FILE"])
    with lock_path.open("w") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = _run(env, wrapper)

    assert result.returncode == 9
    assert files["node-source"].read_text() == "old"
    assert (state / "openfoam-2606-canary-receipt.pending.json").exists()
    assert files["child-calls"].read_text() == ""


def test_production_workflow_and_wrapper_contract_are_narrow() -> None:
    wrapper = WRAPPER.read_text()
    workflow = (ROOT / ".github/workflows/deploy-airfoils-pro.yml").read_text()

    assert WRAPPER.stat().st_mode & 0o111
    assert "pending_cutover_attestation_413_recovery:" in workflow
    assert "recover-pending-opencfd2606-attestation-413.sh" in workflow
    assert "opencfd2606-attestation-413-base-ls-tree.txt" in workflow
    assert "opencfd2606-attestation-413-target-ls-tree.txt" in workflow
    assert "inputs.pending_cutover_engine_rebuild_replay && 360 || 45" in workflow
    assert "--certify-opencfd-2606-continuation" in wrapper
    assert '"$snapshot/scripts/deploy/rebuild-engine.sh" --certify-opencfd-2606-continuation' in wrapper
    assert "openfoam_2606_canary.py" in wrapper
    assert "python3 \"$snapshot/scripts/deploy/openfoam_2606_canary.py\"" not in wrapper
    assert "compose_target up -d --no-deps --force-recreate node-api" in wrapper
    assert "force-recreate api worker" not in wrapper
    assert "EXPECTED_RECEIPT_BYTE_SIZE=\"2313736\"" in wrapper
    assert "505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8" in wrapper
    assert "promotionEligible" in wrapper
    assert "status IN ('pending','submitted','running','ingesting')" in wrapper
