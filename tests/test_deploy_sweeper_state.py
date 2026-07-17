from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
REMOTE_EVIDENCE_ENV = (
    "AIRFOILFOAM_EVIDENCE_BUCKET=test-evidence-bucket\n"
    "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1\n"
    "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10\n"
    "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true\n"
    "AIRFOILFOAM_CONTROL_PLANE_TOKEN=test-control-plane-token-at-least-32-bytes\n"
)
CERTIFIED_EVIDENCE_CONTRACT_SHA256 = (
    "e5fd84accb9d085bb8c0ce11f6bf9d382d4b9f13090dfa0ed9ace898fa756f63"
)
CERTIFIED_EVIDENCE_CONTRACT_ENV = (
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256="
    f"{CERTIFIED_EVIDENCE_CONTRACT_SHA256}\n"
)
CUTOVER_STATE_FIELDS = (
    "OPENCFD2606_CUTOVER_PENDING",
    "OPENCFD2606_CUTOVER_COMPLETE",
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING",
    "OPENCFD2606_CANARY_ATTESTATION_ID",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED",
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256",
    "OPENCFD2606_CUTOVER_SOURCE_REVISION",
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256",
)


def _write_executable(path: Path, contents: str) -> None:
    path.write_text(contents)
    path.chmod(0o755)


def _receipt_path(env: dict[str, str]) -> Path:
    return Path(env["AIRFOILS_PRO_STATE_DIR"]) / "openfoam-2606-canary-receipt.pending.json"


def _write_valid_canary_receipt(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "status": "ok",
                "jobs": [
                    {"job_id": "canary-job-1"},
                    {"job_id": "canary-job-2"},
                    {"job_id": "canary-job-3"},
                ],
            }
        )
        + "\n"
    )


def _replace_env_values(path: Path, updates: dict[str, str]) -> None:
    retained = [
        line
        for line in path.read_text().splitlines()
        if line.split("=", 1)[0] not in updates
    ]
    retained.extend(f"{key}={value}" for key, value in updates.items())
    path.write_text("\n".join(retained) + "\n")


def _pending_source_binding(path: Path) -> dict[str, str]:
    manifest = json.loads((path.parent / ".deployment-source.json").read_text())
    return {
        "OPENCFD2606_CUTOVER_SOURCE_REVISION": manifest["sourceRevision"],
        "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": manifest[
            "sourceTreeSha256"
        ],
    }


def _set_pending_attestation(path: Path, *, sweeper_was_running: str) -> None:
    _replace_env_values(
        path,
        {
            "OPENCFD2606_CUTOVER_PENDING": "1",
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": sweeper_was_running,
            "OPENCFD2606_CANARY_ATTESTATION_ID": (
                "11111111-1111-4111-8111-111111111111"
            ),
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
            "OPENCFD2606_CUTOVER_COMPLETE": "0",
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                CERTIFIED_EVIDENCE_CONTRACT_SHA256
            ),
        }
        | _pending_source_binding(path),
    )


def _deploy_harness(
    tmp_path: Path,
    *,
    sweeper_state: str,
    probe_fails: bool = False,
    queue_active_after: int = 0,
    disabled_queue_depth: int = 0,
    queue_observability_mode: str = "complete",
    legacy_inspector_mode: str = "complete",
    force_legacy_queue_shape: bool = False,
    foundation_profile: bool = False,
    active_engine_service: str = "",
    idle_engine_service: str = "",
    engine_version: str = "2606",
    target_engine_version: str = "2606",
    cutover_ready: bool = True,
    enabled_engine_keys: str | None = None,
    pool_activation_failures: int = 0,
    cutover_api_available: bool = True,
    pool_activation_fatal_status: int = 0,
    pool_activation_transport_error: bool = False,
    pool_disable_fails: bool = False,
    canary_fails: bool = False,
    receipt_reproof_fails: bool = False,
    receipt_persist_fails: bool = False,
    receipt_post_replace_fails: bool = False,
    attestation_fails: bool = False,
    finalize_fails: bool = False,
    complete_fails: bool = False,
    atomic_marker_fail_mode: str = "",
    legacy_health_shape: bool = False,
    cutover_complete: bool = True,
    continuation_status: str = "evidence",
    continuation_error: str = "",
    media_repair_stop_fails: bool = False,
    media_repair_running: bool = True,
    sweeper_dies_after_restore: bool = False,
) -> dict[str, str]:
    app_dir = tmp_path / "app"
    fake_bin = tmp_path / "bin"
    app_dir.mkdir(parents=True)
    fake_bin.mkdir()
    env_text = (
        "AIRFOILFOAM_BUILD_ID=old-build\n"
        "ENGINE_EXPECTED_BUILD_ID=old-build\n"
        + REMOTE_EVIDENCE_ENV
        + "OPENCFD2606_CUTOVER_PENDING=0\n"
        + f"OPENCFD2606_CUTOVER_COMPLETE={1 if cutover_complete else 0}\n"
        + "OPENCFD2606_CANARY_ATTESTATION_ID=\n"
        + "OPENCFD2606_CANARY_RECEIPT_EXPECTED=0\n"
        + "OPENCFD2606_CUTOVER_SOURCE_REVISION=\n"
        + "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256=\n"
        + "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=\n"
    )
    if cutover_complete:
        env_text += CERTIFIED_EVIDENCE_CONTRACT_ENV
    else:
        env_text += "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=\n"
    if enabled_engine_keys is not None:
        env_text += f"AIRFOILFOAM_ENABLED_ENGINE_KEYS={enabled_engine_keys}\n"
    (app_dir / ".env.deploy").write_text(env_text)
    (app_dir / ".env.deploy").chmod(0o600)
    (app_dir / "docker-compose.deploy.yml").write_text("services: {}\n")
    deploy_scripts = app_dir / "scripts" / "deploy"
    deploy_scripts.mkdir(parents=True)
    shutil.copy2(
        ROOT / "scripts" / "deploy" / "deployment-source-manifest.py",
        deploy_scripts / "deployment-source-manifest.py",
    )
    subprocess.run(
        [
            sys.executable,
            str(deploy_scripts / "deployment-source-manifest.py"),
            "--create",
            "--root",
            str(app_dir),
            "--manifest",
            str(app_dir / ".deployment-source.json"),
            "--revision",
            "a" * 40,
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    _write_executable(
        fake_bin / "docker",
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALL_LOG"
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi
joined="$*"
if [[ "$joined" == *" up -d --no-deps --force-recreate api "* ]]; then
  : >"$ENGINE_RECREATED"
fi
if [[ "$joined" == *" up -d --no-deps sweeper"* && "$FAKE_SWEEPER_DIES_AFTER_RESTORE" == "1" ]]; then
  : >"$SWEEPER_RESTORED"
fi
if [[ "$joined" == *" ps --status running -q sweeper"* ]]; then
  if [[ "${FAKE_STATE_PROBE_FAIL:-0}" == "1" ]]; then
    exit 42
  fi
  if [[ "$FAKE_SWEEPER_STATE" == "running" && ! -f "$SWEEPER_RESTORED" ]]; then
    printf 'fake-sweeper-container\n'
  fi
  exit 0
fi
if [[ "$joined" == *" ps --status running -q media-repair"* ]]; then
  if [[ "$FAKE_MEDIA_REPAIR_RUNNING" == "1" ]]; then
    printf 'fake-media-repair-container\n'
  fi
  exit 0
fi
if [[ "$joined" == *" config --services"* ]]; then
  printf 'worker\n'
  printf 'media-repair\n'
  if [[ "$joined" == *"--profile *"* || "$FAKE_FOUNDATION_PROFILE" == "1" ]]; then
    printf 'worker-foundation14\n'
  fi
  exit 0
fi
if [[ "$joined" == *" stop media-repair"* && "$FAKE_MEDIA_REPAIR_STOP_FAILS" == "1" ]]; then
  printf 'simulated media-repair stop failure\n' >&2
  exit 41
fi
if [[ "$joined" == *" ps --status running -q worker" && "$FAKE_ENGINE_VERSION" == "2406" && ! -f "$ENGINE_RECREATED" ]]; then
  printf 'fake-legacy-worker-container\n'
  exit 0
fi
if [[ -n "$FAKE_ACTIVE_ENGINE_SERVICE" && "$joined" == *" ps --status running -q $FAKE_ACTIVE_ENGINE_SERVICE" ]]; then
  printf 'fake-engine-container\n'
  exit 0
fi
if [[ -n "$FAKE_IDLE_ENGINE_SERVICE" && "$joined" == *" ps --status running -q $FAKE_IDLE_ENGINE_SERVICE" ]]; then
  printf 'fake-idle-engine-container\n'
  exit 0
fi
if [[ -n "$FAKE_ACTIVE_ENGINE_SERVICE" && "$joined" == *" exec -T $FAKE_ACTIVE_ENGINE_SERVICE "* ]]; then
  printf '4242 foamRun -solver incompressibleFluid\n'
  exit 0
fi
if [[ "$joined" == *" exec -T worker "* && "$joined" == *"openfoam2406/etc/bashrc"* ]]; then
  if [[ "$FAKE_ENGINE_VERSION" == "2406" && ! -f "$ENGINE_RECREATED" ]]; then
    printf '2406'
    exit 0
  fi
  exit 1
fi
if [[ "$joined" == *" exec -T api "* && "$joined" == *"AIRFOILS_PRO_LEGACY_CELERY_IDLE_PROBE"* ]]; then
  case "$FAKE_LEGACY_INSPECTOR_MODE" in
    complete)
      printf '{"active":{"celery@legacy":[]},"reserved":{"celery@legacy":[]},"scheduled":{"celery@legacy":[]},"active_queues":{"celery@legacy":[{"name":"celery"}]}}\n'
      ;;
    active)
      printf '{"active":{"celery@legacy":[{"id":"active-task"}]},"reserved":{"celery@legacy":[]},"scheduled":{"celery@legacy":[]},"active_queues":{"celery@legacy":[{"name":"celery"}]}}\n'
      ;;
    missing)
      printf '{"active":{"celery@legacy":[]},"reserved":{"celery@legacy":[]},"active_queues":{"celery@legacy":[{"name":"celery"}]}}\n'
      ;;
    partial)
      printf '{"active":{"celery@legacy":[]},"reserved":{"celery@legacy":[]},"scheduled":{},"active_queues":{"celery@legacy":[{"name":"celery"}]}}\n'
      ;;
    *)
      printf 'unsupported fake legacy inspector mode\n' >&2
      exit 99
      ;;
  esac
  exit 0
fi
if [[ "$joined" == *" exec -T worker "* || "$joined" == *" exec -T worker-foundation14 "* ]]; then
  exit 0
fi
if [[ "$joined" == *" config"* ]]; then
  printf 'services: {}\n'
fi
exit 0
""",
    )
    _write_executable(
        fake_bin / "curl",
        """#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$CALL_LOG"
output_file=""
request_body=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[$i]}" == "-o" ]]; then
    output_file="${args[$((i + 1))]}"
  fi
  if [[ "${args[$i]}" == "-d" ]]; then
    request_body="${args[$((i + 1))]}"
  fi
done
url="${!#}"
case "$url" in
  *:8000/queue)
    count=0
    if [[ -f "$QUEUE_PROBE_COUNT" ]]; then
      read -r count <"$QUEUE_PROBE_COUNT"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" >"$QUEUE_PROBE_COUNT"
    disabled_depth="${FAKE_DISABLED_QUEUE_DEPTH:-0}"
    if { [[ "$FAKE_ENGINE_VERSION" == "2406" && ! -f "$ENGINE_RECREATED" ]] || [[ "$FAKE_FORCE_LEGACY_QUEUE_SHAPE" == "1" ]]; }; then
      if (( FAKE_QUEUE_ACTIVE_AFTER > 0 && count >= FAKE_QUEUE_ACTIVE_AFTER )); then
        printf '{"queue_depth":1,"active":[],"reserved":[],"scheduled":[],"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":["arrived-after-stop"],"duplicates":{},"redelivered":[]}\n'
      else
        printf '{"queue_depth":0,"active":[],"reserved":[],"scheduled":[],"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":[],"duplicates":{},"redelivered":[]}\n'
      fi
      exit 0
    fi
    if [[ "$FAKE_QUEUE_OBSERVABILITY_MODE" == "missing-task-snapshot" ]]; then
      printf '{"queue_depth":0,"queue_depths":{"celery":0,"openfoam-foundation-14":0},"queue_enabled":{"celery":true,"openfoam-foundation-14":false},"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":[],"worker_queues":[],"worker_queues_error":null,"worker_runtime_error":null,"inspection_errors":{},"inspection_workers":{"reserved":[],"scheduled":[]}}\n'
      exit 0
    fi
    if [[ "$FAKE_QUEUE_OBSERVABILITY_MODE" == "worker-error" ]]; then
      printf '{"queue_depth":0,"queue_depths":{"celery":0,"openfoam-foundation-14":0},"queue_enabled":{"celery":true,"openfoam-foundation-14":false},"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":[],"worker_queues":null,"worker_queues_error":"inspect timed out","worker_runtime_error":null,"inspection_errors":{},"inspection_workers":{"active":[],"reserved":[],"scheduled":[]}}\n'
      exit 0
    fi
    if (( FAKE_QUEUE_ACTIVE_AFTER > 0 && count >= FAKE_QUEUE_ACTIVE_AFTER )); then
      total_depth=$((disabled_depth + 1))
      printf '{"queue_depth":%s,"queue_depths":{"celery":1,"openfoam-foundation-14":%s},"queue_enabled":{"celery":true,"openfoam-foundation-14":false},"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":["arrived-after-stop"],"worker_queues":[],"worker_queues_error":null,"worker_runtime_error":null,"inspection_errors":{},"inspection_workers":{"active":[],"reserved":[],"scheduled":[]}}\n' "$total_depth" "$disabled_depth"
    else
      printf '{"queue_depth":%s,"queue_depths":{"celery":0,"openfoam-foundation-14":%s},"queue_enabled":{"celery":true,"openfoam-foundation-14":false},"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":[],"worker_queues":[],"worker_queues_error":null,"worker_runtime_error":null,"inspection_errors":{},"inspection_workers":{"active":[],"reserved":[],"scheduled":[]}}\n' "$disabled_depth" "$disabled_depth"
    fi
    ;;
  *:8000/health)
    engine_version="$FAKE_ENGINE_VERSION"
    if [[ -f "$ENGINE_RECREATED" ]]; then
      engine_version="$FAKE_TARGET_ENGINE_VERSION"
    fi
    if [[ "$FAKE_LEGACY_HEALTH_SHAPE" == "1" && ! -f "$ENGINE_RECREATED" ]]; then
      printf '{"status":"ok","build_id":"%s","mesh_recovery_version":1}\n' "$FAKE_BUILD_ID"
    else
      printf '{"status":"ok","build_id":"%s","default_engine":{"version":"%s"},"evidence_storage":{"backend":"gcs","bucket":"test-evidence-bucket","object_prefix":"solver-evidence/v1","archive_format":"tar+zstd","compression":"zstd","zstd_level":10,"remote_only":true}}\n' "$FAKE_BUILD_ID" "$engine_version"
    fi
    ;;
  *:8000/capabilities)
    if [[ "$FAKE_ENGINE_VERSION" == "2406" && ! -f "$ENGINE_RECREATED" ]]; then
      printf '{"openfoam_image":"opencfd/openfoam-default:2406","runner":"docker"}\n'
    else
      printf '{"engines":[]}\n'
    fi
    ;;
  */api/admin/solver-engine-cutovers/opencfd-2606/readiness)
    if [[ "$request_body" != "{}" ]]; then
      printf 'readiness request body is not exact JSON: <%s>\n' "$request_body" >&2
      exit 65
    fi
    if [[ "$FAKE_CUTOVER_API_AVAILABLE" != "true" ]]; then
      printf '{"error":"route unavailable"}\n'
      exit 22
    fi
    printf '{"ready":%s,"blockers":[]}\n' "$FAKE_CUTOVER_READY"
    ;;
  */api/admin/solver-engine-cutovers/opencfd-2606/attest)
    if [[ "$FAKE_ATTESTATION_FAIL" == "1" ]]; then
      printf '{"error":"receipt rejected"}\n'
      exit 22
    fi
    printf '{"status":"attested","canaryAttestationId":"11111111-1111-4111-8111-111111111111","replayed":false}\n'
    ;;
  */api/admin/solver-engine-cutovers/opencfd-2606/continuation)
    if [[ "$FAKE_CONTINUATION_STATUS" == "not_required" ]]; then
      printf '{"status":"not_required","canaryAttestationId":"11111111-1111-4111-8111-111111111111","simJobId":null,"evidenceResultId":null,"lastError":null,"requiredCampaigns":0,"campaigns":[]}\n'
    elif [[ -n "$FAKE_CONTINUATION_ERROR" ]]; then
      printf '{"status":"%s","canaryAttestationId":"11111111-1111-4111-8111-111111111111","simJobId":null,"evidenceResultId":null,"lastError":"%s","requiredCampaigns":1,"campaigns":[{"campaignId":"campaign-1","status":"pending"}]}\n' "$FAKE_CONTINUATION_STATUS" "$FAKE_CONTINUATION_ERROR"
    else
      printf '{"status":"%s","canaryAttestationId":"11111111-1111-4111-8111-111111111111","simJobId":"successor-job","evidenceResultId":"successor-result","lastError":null,"requiredCampaigns":1,"campaigns":[{"campaignId":"campaign-1","status":"%s"}]}\n' "$FAKE_CONTINUATION_STATUS" "$FAKE_CONTINUATION_STATUS"
    fi
    ;;
  */api/admin/solver-engine-cutovers/opencfd-2606/finalize)
    if [[ "$FAKE_FINALIZE_FAIL" == "1" ]]; then
      printf '{"error":"live attestation replay rejected"}\n'
      exit 22
    fi
    printf '{}\n'
    ;;
  */api/admin/solver-engine-cutovers/opencfd-2606/complete)
    if [[ "$FAKE_COMPLETE_FAIL" == "1" ]]; then
      printf '{"error":"live completion replay rejected"}\n'
      exit 22
    fi
    printf '{}\n'
    ;;
  */api/admin/solver-execution-pools/3f8bc764-09ae-4ff3-8fd2-260600000001)
    if [[ "$request_body" == *'"enabled":false'* ]]; then
      if [[ "$FAKE_POOL_DISABLE_FAIL" == "1" ]]; then
        exit 28
      fi
      printf 'disabled\n' >>"$POOL_DISABLE_LOG"
      printf '{}\n'
      exit 0
    fi
    count=0
    if [[ -f "$POOL_ACTIVATION_COUNT" ]]; then
      read -r count <"$POOL_ACTIVATION_COUNT"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" >"$POOL_ACTIVATION_COUNT"
    if [[ "$FAKE_POOL_ACTIVATION_TRANSPORT_ERROR" == "1" ]]; then
      exit 28
    fi
    if (( FAKE_POOL_ACTIVATION_FATAL_STATUS > 0 )); then
      printf '{"error":"fatal activation response"}\n' >"$output_file"
      printf '%s' "$FAKE_POOL_ACTIVATION_FATAL_STATUS"
      exit 0
    fi
    if (( count <= FAKE_POOL_ACTIVATION_FAILURES )); then
      printf '{"error":"worker not visible yet"}\n' >"$output_file"
      printf '409'
      exit 0
    fi
    printf '{}\n' >"$output_file"
    printf '200'
    ;;
  *)
    printf '{}\n'
    ;;
esac
""",
    )
    _write_executable(
        fake_bin / "python3",
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == */scripts/deploy/openfoam_2606_canary.py ]]; then
  if [[ "$*" == *"--verify-receipt"* ]]; then
    printf 'canary-verify %s\n' "$*" >>"$CALL_LOG"
    if [[ "$FAKE_RECEIPT_REPROOF_FAIL" == "1" ]]; then
      printf 'simulated retained receipt generation mismatch\n' >&2
      exit 46
    fi
    printf '{"schema_version":1,"status":"verified"}\n'
    exit 0
  fi
  printf 'canary %s\n' "$*" >>"$CALL_LOG"
  if [[ "$FAKE_CANARY_FAIL" == "1" ]]; then
    printf 'simulated OpenCFD 2606 canary failure\n' >&2
    exit 42
  fi
  printf '{"schema_version":1,"status":"ok","jobs":[{"job_id":"canary-job-1"},{"job_id":"canary-job-2"},{"job_id":"canary-job-3"}]}\n'
  exit 0
fi
if [[ "${1:-}" == */scripts/deploy/persist-json-receipt.py ]]; then
  if [[ "$*" == *"--verify-existing"* ]]; then
    printf 'receipt-verify %s\n' "$*" >>"$CALL_LOG"
    exec "$REAL_PYTHON" "$@"
  fi
  printf 'receipt-persist %s\n' "$*" >>"$CALL_LOG"
  if [[ "$FAKE_RECEIPT_PERSIST_FAIL" == "1" ]]; then
    printf 'simulated durable receipt persistence failure\n' >&2
    exit 44
  fi
  if [[ "$FAKE_RECEIPT_POST_REPLACE_FAIL" == "1" ]]; then
    "$REAL_PYTHON" "$@"
    printf 'simulated loss of the directory-fsync acknowledgement\n' >&2
    exit 45
  fi
  exec "$REAL_PYTHON" "$@"
fi
if [[ "$FAKE_ATOMIC_MARKER_FAIL_MODE" == "attestation" && "$*" == *"OPENCFD2606_CANARY_ATTESTATION_ID=11111111-1111-4111-8111-111111111111"* ]]; then
  exit 43
fi
if [[ "$FAKE_ATOMIC_MARKER_FAIL_MODE" == "initial" && "$*" == *"OPENCFD2606_CUTOVER_PENDING=1"* ]]; then
  exit 43
fi
if [[ "$FAKE_ATOMIC_MARKER_FAIL_MODE" == "terminal" && "$*" == *"OPENCFD2606_CUTOVER_PENDING=0"* ]]; then
  exit 43
fi
if [[ "$FAKE_ATOMIC_MARKER_FAIL_MODE" == "build_ids" && "$*" == *"AIRFOILFOAM_BUILD_ID=test-build"* && "$*" == *"ENGINE_EXPECTED_BUILD_ID=test-build"* ]]; then
  exit 43
fi
if [[ "$FAKE_ATOMIC_MARKER_FAIL_MODE" == "engine_identity" && "$*" == *"AIRFOILFOAM_BUILD_ID=test-build"* && "$*" == *"ENGINE_EXPECTED_BUILD_ID=test-build"* && "$*" == *"AIRFOILFOAM_ENABLED_ENGINE_KEYS=openfoam:opencfd:2606:numerics-1:adapter-1"* ]]; then
  exit 43
fi
exec "$REAL_PYTHON" "$@"
""",
    )
    _write_executable(fake_bin / "sleep", "#!/usr/bin/env bash\nexit 0\n")

    env = os.environ.copy()
    env.update(
        {
            "APP_DIR": str(app_dir),
            "ENV_FILE": str(app_dir / ".env.deploy"),
            "COMPOSE_FILE": str(app_dir / "docker-compose.deploy.yml"),
            "LOCK_FILE": str(tmp_path / "deploy.lock"),
            "AIRFOILS_PRO_STATE_DIR": str(tmp_path / "state"),
            "CALL_LOG": str(tmp_path / "calls.log"),
            "FAKE_BUILD_ID": "test-build",
            "FAKE_SWEEPER_STATE": sweeper_state,
            "FAKE_STATE_PROBE_FAIL": "1" if probe_fails else "0",
            "FAKE_QUEUE_ACTIVE_AFTER": str(queue_active_after),
            "FAKE_DISABLED_QUEUE_DEPTH": str(disabled_queue_depth),
            "FAKE_QUEUE_OBSERVABILITY_MODE": queue_observability_mode,
            "FAKE_LEGACY_INSPECTOR_MODE": legacy_inspector_mode,
            "FAKE_FORCE_LEGACY_QUEUE_SHAPE": (
                "1" if force_legacy_queue_shape else "0"
            ),
            "FAKE_FOUNDATION_PROFILE": "1" if foundation_profile else "0",
            "FAKE_ACTIVE_ENGINE_SERVICE": active_engine_service,
            "FAKE_IDLE_ENGINE_SERVICE": idle_engine_service,
            "FAKE_ENGINE_VERSION": engine_version,
            "FAKE_TARGET_ENGINE_VERSION": target_engine_version,
            "FAKE_CUTOVER_READY": "true" if cutover_ready else "false",
            "FAKE_POOL_ACTIVATION_FAILURES": str(pool_activation_failures),
            "FAKE_CUTOVER_API_AVAILABLE": "true" if cutover_api_available else "false",
            "FAKE_POOL_ACTIVATION_FATAL_STATUS": str(pool_activation_fatal_status),
            "FAKE_POOL_ACTIVATION_TRANSPORT_ERROR": (
                "1" if pool_activation_transport_error else "0"
            ),
            "FAKE_POOL_DISABLE_FAIL": "1" if pool_disable_fails else "0",
            "FAKE_CANARY_FAIL": "1" if canary_fails else "0",
            "FAKE_RECEIPT_REPROOF_FAIL": "1" if receipt_reproof_fails else "0",
            "FAKE_RECEIPT_PERSIST_FAIL": "1" if receipt_persist_fails else "0",
            "FAKE_RECEIPT_POST_REPLACE_FAIL": (
                "1" if receipt_post_replace_fails else "0"
            ),
            "FAKE_ATTESTATION_FAIL": "1" if attestation_fails else "0",
            "FAKE_FINALIZE_FAIL": "1" if finalize_fails else "0",
            "FAKE_COMPLETE_FAIL": "1" if complete_fails else "0",
            "FAKE_ATOMIC_MARKER_FAIL_MODE": atomic_marker_fail_mode,
            "FAKE_LEGACY_HEALTH_SHAPE": "1" if legacy_health_shape else "0",
            "FAKE_CONTINUATION_STATUS": continuation_status,
            "FAKE_CONTINUATION_ERROR": continuation_error,
            "FAKE_MEDIA_REPAIR_STOP_FAILS": (
                "1" if media_repair_stop_fails else "0"
            ),
            "FAKE_MEDIA_REPAIR_RUNNING": "1" if media_repair_running else "0",
            "FAKE_SWEEPER_DIES_AFTER_RESTORE": (
                "1" if sweeper_dies_after_restore else "0"
            ),
            "SWEEPER_RESTORED": str(tmp_path / "sweeper-restored"),
            "REAL_PYTHON": sys.executable,
            "ENGINE_RECREATED": str(tmp_path / "engine-recreated"),
            "POOL_ACTIVATION_COUNT": str(tmp_path / "pool-activation-count"),
            "POOL_DISABLE_LOG": str(tmp_path / "pool-disable.log"),
            "QUEUE_PROBE_COUNT": str(tmp_path / "queue-probe-count"),
            "PATH": f"{fake_bin}:{env['PATH']}",
        }
    )
    return env


@pytest.mark.parametrize(
    ("script", "running_restore"),
    [
        ("vps-redeploy.sh", " up -d --no-deps sweeper"),
        ("rebuild-engine.sh", " up -d --no-deps --force-recreate sweeper"),
    ],
)
@pytest.mark.parametrize("initial_state", ["stopped", "running"])
def test_deploy_scripts_preserve_sweeper_state(
    tmp_path: Path, script: str, running_restore: str, initial_state: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state=initial_state)
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("test-build")

    completed = subprocess.run(command, env=env, text=True, capture_output=True, check=False)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    stopped_restore = " up --no-start --no-deps --force-recreate sweeper"
    queue_probes = [call for call in calls if ":8000/queue" in call]
    if script == "rebuild-engine.sh":
        assert queue_probes
        assert all("--max-time 15" in call for call in queue_probes)
    else:
        assert not queue_probes
    if initial_state == "stopped":
        assert any(stopped_restore in call for call in calls)
        assert not any(running_restore in call for call in calls)
        assert "Preserving the intentionally stopped sweeper" in completed.stdout
    else:
        assert any(running_restore in call for call in calls)
        assert not any(stopped_restore in call for call in calls)
        assert "Restoring the previously running sweeper" in completed.stdout


@pytest.mark.parametrize("script", ["vps-redeploy.sh", "rebuild-engine.sh"])
def test_deploy_scripts_fail_closed_when_sweeper_state_is_unknown(tmp_path: Path, script: str) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped", probe_fails=True)
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("test-build")

    completed = subprocess.run(command, env=env, text=True, capture_output=True, check=False)

    assert completed.returncode == 12
    assert "Could not determine whether the sweeper is running" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build " in call for call in calls)


def test_control_plane_deploy_rejects_unproven_inherited_lock(tmp_path: Path) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    env["DEPLOY_LOCK_HELD"] = "1"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 9
    assert "requires inherited descriptor 9" in completed.stderr
    assert Path(env["CALL_LOG"]).read_text().splitlines() == ["compose version"]


@pytest.mark.parametrize("action", ["test-build", "--certify-opencfd-2606-continuation"])
def test_engine_maintenance_refuses_tampered_promoted_source_before_mutation(
    tmp_path: Path, action: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    Path(env["COMPOSE_FILE"]).write_text("services:\n  tampered: {}\n")

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), action],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 2
    assert "deployment source does not match its manifest" in completed.stderr
    assert Path(env["CALL_LOG"]).read_text().splitlines() == ["compose version"]


@pytest.mark.parametrize(
    "unsafe_path",
    ["state-in-app", "receipt-in-app", "state-symlink", "receipt-symlink"],
)
def test_engine_maintenance_rejects_replaceable_or_symlinked_recovery_paths(
    tmp_path: Path, unsafe_path: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")
    app_dir = Path(env["ENV_FILE"]).parent
    state_dir = Path(env["AIRFOILS_PRO_STATE_DIR"])
    if unsafe_path == "state-in-app":
        env["AIRFOILS_PRO_STATE_DIR"] = str(app_dir / "replaceable-state")
    elif unsafe_path == "receipt-in-app":
        env["OPENCFD2606_CANARY_RECEIPT_FILE"] = str(
            app_dir / "replaceable-receipt.json"
        )
    elif unsafe_path == "state-symlink":
        actual_state = tmp_path / "actual-state"
        actual_state.mkdir()
        state_link = tmp_path / "state-link"
        state_link.symlink_to(actual_state, target_is_directory=True)
        env["AIRFOILS_PRO_STATE_DIR"] = str(state_link)
    else:
        state_dir.mkdir()
        actual_receipt = tmp_path / "actual-receipt.json"
        actual_receipt.write_text("{}\n")
        receipt_link = state_dir / "openfoam-2606-canary-receipt.pending.json"
        receipt_link.symlink_to(actual_receipt)
        env["OPENCFD2606_CANARY_RECEIPT_FILE"] = str(receipt_link)

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode != 0
    assert "unsafe OpenCFD v2606 recovery path" in completed.stderr
    call_log = Path(env["CALL_LOG"])
    calls = call_log.read_text().splitlines() if call_log.exists() else []
    assert calls in ([], ["compose version"])


def test_pending_cutover_fails_closed_when_external_receipt_is_missing(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env_file = Path(env["ENV_FILE"])
    _replace_env_values(
        env_file,
        {
            "OPENCFD2606_CUTOVER_PENDING": "1",
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "1",
            "OPENCFD2606_CANARY_ATTESTATION_ID": "",
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "1",
            "OPENCFD2606_CUTOVER_COMPLETE": "0",
        }
        | _pending_source_binding(env_file),
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "different-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "expects an exact retained canary receipt" in completed.stderr
    assert str(_receipt_path(env)) in completed.stderr
    assert not any(
        " build api" in call
        for call in Path(env["CALL_LOG"]).read_text().splitlines()
    )


def test_engine_build_id_expectations_are_one_atomic_env_update(tmp_path: Path) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        atomic_marker_fail_mode="build_ids",
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 43
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "AIRFOILFOAM_BUILD_ID=old-build" in persisted
    assert "ENGINE_EXPECTED_BUILD_ID=old-build" in persisted


def test_opencfd_cutover_updates_build_ids_and_engine_allow_list_atomically(
    tmp_path: Path,
) -> None:
    legacy_key = "openfoam:opencfd:2406:numerics-1:adapter-1"
    foundation_key = "openfoam:foundation:14:numerics-1:adapter-1"
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2406",
        target_engine_version="2606",
        enabled_engine_keys=f"{legacy_key},{foundation_key}",
        atomic_marker_fail_mode="engine_identity",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    initial_env = Path(env["ENV_FILE"]).read_text()

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 43
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "AIRFOILFOAM_BUILD_ID=old-build" in persisted
    assert "ENGINE_EXPECTED_BUILD_ID=old-build" in persisted
    assert f"AIRFOILFOAM_ENABLED_ENGINE_KEYS={legacy_key},{foundation_key}" in persisted
    assert "openfoam:opencfd:2606:numerics-1:adapter-1" not in persisted


def test_canary_receipt_default_is_outside_replaceable_application_tree() -> None:
    script = (ROOT / "scripts" / "deploy" / "rebuild-engine.sh").read_text()
    assert (
        'AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"'
        in script
    )
    assert '$APP_DIR/.openfoam-2606-canary-receipt.pending.json' not in script


def test_control_plane_deploy_initializes_nested_sync_mountpoint_before_node_api(tmp_path: Path) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    storage_init_index = next(
        index for index, call in enumerate(calls) if " up --no-deps storage-init" in call
    )
    node_api_index = next(
        index for index, call in enumerate(calls) if " up -d --no-deps node-api" in call
    )
    assert storage_init_index < node_api_index
    assert "Initializing the nested sync-imports mountpoint" in completed.stdout


def test_control_plane_deploy_fails_before_migration_when_media_repair_cannot_stop(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        media_repair_stop_fails=True,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 41
    assert "simulated media-repair stop failure" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(" stop media-repair" in call for call in calls)
    assert not any(" up --no-deps storage-init" in call for call in calls)
    assert not any(" up -d --no-deps node-api" in call for call in calls)


@pytest.mark.parametrize("initial_state", ["stopped", "running"])
def test_engine_rebuild_refusal_restores_exact_prior_sweeper_state(
    tmp_path: Path, initial_state: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state=initial_state, queue_active_after=2)
    initial_env = Path(env["ENV_FILE"]).read_text()

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "queued/reserved/active engine work exists" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    running_restore = " up -d --no-deps sweeper"
    if initial_state == "stopped":
        assert not any(running_restore in call for call in calls)
    else:
        assert any(running_restore in call for call in calls)
    assert not any(" up -d --no-deps --force-recreate api worker node-api" in call for call in calls)
    assert Path(env["ENV_FILE"]).read_text() == initial_env


def test_engine_rebuild_treats_disabled_pool_queue_as_draining_work(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        disabled_queue_depth=2,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "queued/reserved/active engine work exists" in completed.stderr
    assert "openfoam-foundation-14" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)


@pytest.mark.parametrize(
    ("queue_observability_mode", "expected_error"),
    [
        ("missing-task-snapshot", "task worker coverage is incomplete"),
        ("worker-error", "engine worker inspection failed"),
    ],
)
def test_engine_rebuild_rejects_incomplete_queue_observability(
    tmp_path: Path,
    queue_observability_mode: str,
    expected_error: str,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        queue_observability_mode=queue_observability_mode,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert expected_error in completed.stderr
    assert "AIRFOILFOAM_BUILD_ID=old-build" in Path(env["ENV_FILE"]).read_text()


def test_strict_2606_queue_guard_rejects_the_legacy_queue_shape(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        force_legacy_queue_shape=True,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "engine worker inspection failed" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("AIRFOILS_PRO_LEGACY_CELERY_IDLE_PROBE" in call for call in calls)
    assert not any(" build api" in call for call in calls)


def test_legacy_2406_queue_guard_rejects_direct_inspector_activity(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2406",
        target_engine_version="2606",
        legacy_inspector_mode="active",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "legacy direct Celery inspection reports work" in completed.stderr
    assert "queued/reserved/active engine work exists" in completed.stderr
    assert not any(
        " build api" in call for call in Path(env["CALL_LOG"]).read_text().splitlines()
    )


def test_legacy_2406_queue_guard_rejects_gateway_reported_activity(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2406",
        target_engine_version="2606",
        queue_active_after=1,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "legacy queue_depth=1" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("AIRFOILS_PRO_LEGACY_CELERY_IDLE_PROBE" in call for call in calls)
    assert not any(" build api" in call for call in calls)


@pytest.mark.parametrize(
    ("legacy_inspector_mode", "expected_error"),
    [
        ("missing", "lacks a complete scheduled snapshot"),
        ("partial", "worker coverage is incomplete for scheduled"),
    ],
)
def test_legacy_2406_queue_guard_rejects_incomplete_direct_inspection(
    tmp_path: Path,
    legacy_inspector_mode: str,
    expected_error: str,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2406",
        target_engine_version="2606",
        legacy_inspector_mode=legacy_inspector_mode,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert expected_error in completed.stderr
    assert "engine queue probe failed" in completed.stderr
    assert not any(
        " build api" in call for call in Path(env["CALL_LOG"]).read_text().splitlines()
    )


def test_engine_rebuild_rejects_missing_live_worker_snapshot(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        idle_engine_service="worker",
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "does not cover running worker containers" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" up -d --no-deps --force-recreate api" in call for call in calls)


def test_engine_rebuild_includes_every_worker_in_active_profiles(tmp_path: Path) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        foundation_profile=True,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(
        " build api worker worker-foundation14" in call
        for call in calls
    )
    assert any(
        " up -d --no-deps --force-recreate api worker worker-foundation14 node-api"
        in call
        for call in calls
    )


def test_opencfd_2406_cutover_requires_admin_before_mutating_runtime(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "ADMIN_COOKIE is mandatory" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert not any(" stop sweeper" in call for call in calls)


def test_legacy_2406_health_shape_is_correlated_with_the_worker_before_cutover(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        legacy_health_shape=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(":8000/capabilities" in call for call in calls)
    assert any("openfoam2406/etc/bashrc" in call for call in calls)
    assert sum(
        "AIRFOILS_PRO_LEGACY_CELERY_IDLE_PROBE" in call for call in calls
    ) == 3
    assert any("/prepare" in call for call in calls)
    assert any(call.startswith("canary ") for call in calls)


def test_fresh_2606_stack_requires_authenticated_certification_and_activates(
    tmp_path: Path,
) -> None:
    without_admin = _deploy_harness(
        tmp_path / "without-admin",
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    refused = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=without_admin,
        text=True,
        capture_output=True,
        check=False,
    )
    assert refused.returncode == 14
    assert "ADMIN_COOKIE is mandatory" in refused.stderr
    assert not any(
        " build api" in call
        for call in Path(without_admin["CALL_LOG"]).read_text().splitlines()
    )

    certified = _deploy_harness(
        tmp_path / "with-admin",
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    certified["ADMIN_COOKIE"] = "aero_admin=test-token"
    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=certified,
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(certified["CALL_LOG"]).read_text().splitlines()
    assert any("/prepare" in call for call in calls)
    assert any(call.startswith("canary ") for call in calls)
    assert any("/finalize" in call for call in calls)
    assert any("/complete" in call for call in calls)
    assert "OPENCFD2606_CUTOVER_COMPLETE=0" in Path(
        certified["ENV_FILE"]
    ).read_text()
    assert CERTIFIED_EVIDENCE_CONTRACT_ENV.strip() in Path(
        certified["ENV_FILE"]
    ).read_text()


def test_opencfd_cutover_requires_new_control_plane_before_prepare(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        cutover_api_available=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    initial_env = Path(env["ENV_FILE"]).read_text()

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "Deploy the new control plane first" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("/prepare" in call for call in calls)
    assert not any(" build api" in call for call in calls)
    assert Path(env["ENV_FILE"]).read_text() == initial_env


def test_opencfd_2406_cutover_drains_migrates_activates_and_resumes(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        enabled_engine_keys=(
            "openfoam:opencfd:2406:numerics-1:adapter-1,"
            "openfoam:foundation:14:numerics-1:adapter-1"
        ),
        pool_activation_failures=2,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    prepare_index = next(i for i, call in enumerate(calls) if "/prepare" in call)
    build_index = next(i for i, call in enumerate(calls) if " build api worker" in call)
    finalize_index = next(i for i, call in enumerate(calls) if "/finalize" in call)
    activate_index = next(
        i
        for i, call in enumerate(calls)
        if "/api/admin/solver-execution-pools/3f8bc764-09ae-4ff3-8fd2-260600000001"
        in call
    )
    canary_index = next(i for i, call in enumerate(calls) if call.startswith("canary "))
    receipt_persist_index = next(
        i for i, call in enumerate(calls) if call.startswith("receipt-persist ")
    )
    receipt_verify_index = next(
        i for i, call in enumerate(calls) if call.startswith("receipt-verify ")
    )
    attest_index = next(i for i, call in enumerate(calls) if "/attest" in call)
    complete_index = next(i for i, call in enumerate(calls) if "/complete" in call)
    continuation_index = next(
        i for i, call in enumerate(calls) if "/continuation" in call
    )
    sweeper_restore_index = next(
        i
        for i, call in enumerate(calls)
        if " up -d --no-deps --force-recreate sweeper" in call
    )
    assert (
        prepare_index
        < build_index
        < activate_index
        < canary_index
        < receipt_persist_index
        < receipt_verify_index
        < attest_index
        < finalize_index
        < complete_index
        < sweeper_restore_index
        < continuation_index
    )
    env_text = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in env_text
    assert "openfoam:opencfd:2406:numerics-1:adapter-1" not in env_text
    assert (
        "AIRFOILFOAM_ENABLED_ENGINE_KEYS="
        "openfoam:opencfd:2606:numerics-1:adapter-1,"
        "openfoam:foundation:14:numerics-1:adapter-1"
    ) in env_text
    assert Path(env["POOL_ACTIVATION_COUNT"]).read_text().strip() == "3"
    assert "Engine reports OpenCFD v2606" in completed.stdout
    assert "production canaries passed" in completed.stdout
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in env_text


def test_opencfd_2406_cutover_keeps_marker_and_refuses_build_when_db_not_drained(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        cutover_ready=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env["CUTOVER_DRAIN_TIMEOUT_SECONDS"] = "0"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "Campaigns remain safely paused" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert "OPENCFD2606_CUTOVER_PENDING=1" in Path(env["ENV_FILE"]).read_text()


def test_opencfd_cutover_fails_fast_before_finalize_on_fatal_pool_response(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        pool_activation_fatal_status=401,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "non-retryable" in completed.stderr
    assert Path(env["POOL_ACTIVATION_COUNT"]).read_text().strip() == "1"
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("/finalize" in call for call in calls)
    assert not any("/complete" in call for call in calls)
    assert "OPENCFD2606_CUTOVER_PENDING=1" in Path(env["ENV_FILE"]).read_text()


def test_opencfd_cutover_disables_pool_after_ambiguous_activation_transport_loss(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        pool_activation_transport_error=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "database may have committed" in completed.stderr.lower()
    assert Path(env["POOL_ACTIVATION_COUNT"]).read_text().strip() == "60"
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("/finalize" in call for call in calls)
    assert any(" stop sweeper" in call for call in calls)


def test_opencfd_cutover_warns_when_fail_safe_pool_disable_is_unacknowledged(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        canary_fails=True,
        pool_disable_fails=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "WARNING: could not disable the OpenCFD v2606 pool" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    disable_calls = [
        call
        for call in calls
        if 'solver-execution-pools/3f8bc764-09ae-4ff3-8fd2-260600000001' in call
        and '{"enabled":false}' in call
    ]
    # The explicit branch warns, then the armed EXIT guard makes one final
    # best-effort retry without hiding the original failure.
    assert len(disable_calls) == 2
    assert any(" stop sweeper" in call for call in calls)


def test_opencfd_cutover_disables_target_pool_and_stays_paused_on_canary_failure(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        canary_fails=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "production canaries failed" in completed.stderr
    assert "campaigns remain paused" in completed.stderr
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(call.startswith("canary ") for call in calls)
    assert not any("/attest" in call for call in calls)
    assert not any("/finalize" in call for call in calls)
    assert not any("/complete" in call for call in calls)
    assert not any("force-recreate sweeper" in call for call in calls)
    assert "OPENCFD2606_CUTOVER_PENDING=1" in Path(env["ENV_FILE"]).read_text()


def test_opencfd_cutover_refuses_attestation_until_receipt_is_power_loss_durable(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        receipt_persist_fails=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "was not durably persisted" in completed.stderr
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(call.startswith("canary ") for call in calls)
    assert any(call.startswith("receipt-persist ") for call in calls)
    assert not any("/attest" in call for call in calls)
    assert not any("/finalize" in call for call in calls)
    assert not _receipt_path(env).exists()
    assert "OPENCFD2606_CUTOVER_PENDING=1" in Path(env["ENV_FILE"]).read_text()


def test_post_replace_fsync_ambiguity_is_reverified_before_retry_attestation(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        receipt_post_replace_fails=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    first = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert first.returncode == 14
    first_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(call.startswith("receipt-persist ") for call in first_calls)
    assert not any(call.startswith("receipt-verify ") for call in first_calls)
    assert not any("/attest" in call for call in first_calls)
    receipt = _receipt_path(env)
    assert receipt.is_file()
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]

    Path(env["CALL_LOG"]).write_text("")
    Path(env["POOL_DISABLE_LOG"]).write_text("")
    env["FAKE_RECEIPT_POST_REPLACE_FAIL"] = "0"
    env["FAKE_SWEEPER_STATE"] = "stopped"
    recovered = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert recovered.returncode == 0, recovered.stdout + recovered.stderr
    recovery_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    verify_index = next(
        i
        for i, call in enumerate(recovery_calls)
        if call.startswith("receipt-verify ")
    )
    storage_reproof_index = next(
        i
        for i, call in enumerate(recovery_calls)
        if call.startswith("canary-verify ")
    )
    attest_index = next(i for i, call in enumerate(recovery_calls) if "/attest" in call)
    assert verify_index < storage_reproof_index < attest_index
    assert not any(call.startswith("receipt-persist ") for call in recovery_calls)
    assert not any(call.startswith("canary ") for call in recovery_calls)
    assert not any(" build api" in call for call in recovery_calls)
    assert not receipt.exists()
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in persisted


def test_opencfd_cutover_disables_target_pool_when_attestation_is_rejected(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        attestation_fails=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "attestation request was not acknowledged" in completed.stderr
    assert "database may have committed" in completed.stderr.lower()
    assert _receipt_path(env).is_file()
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(call.startswith("canary ") for call in calls)
    assert any(call.startswith("receipt-verify ") for call in calls)
    assert any("/attest" in call for call in calls)
    assert not any("/finalize" in call for call in calls)
    assert not any("/complete" in call for call in calls)

    # The response could have been lost after the DB committed. Exact
    # certification replays the retained receipt against the unchanged live
    # runtime; it must not rebuild the engine or run a second canary suite.
    Path(env["CALL_LOG"]).write_text("")
    Path(env["POOL_DISABLE_LOG"]).write_text("")
    env["FAKE_ATTESTATION_FAIL"] = "0"
    env["FAKE_SWEEPER_STATE"] = "stopped"
    recovered = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert recovered.returncode == 0, recovered.stdout + recovered.stderr
    recovery_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    verify_index = next(
        i
        for i, call in enumerate(recovery_calls)
        if call.startswith("receipt-verify ")
    )
    storage_reproof_index = next(
        i
        for i, call in enumerate(recovery_calls)
        if call.startswith("canary-verify ")
    )
    attest_index = next(i for i, call in enumerate(recovery_calls) if "/attest" in call)
    assert verify_index < storage_reproof_index < attest_index
    assert any("/attest" in call for call in recovery_calls)
    assert any("/finalize" in call for call in recovery_calls)
    assert any("/complete" in call for call in recovery_calls)
    assert not any(call.startswith("canary ") for call in recovery_calls)
    assert not any(call.startswith("receipt-persist ") for call in recovery_calls)
    assert not any(" build api" in call for call in recovery_calls)
    assert not _receipt_path(env).exists()
    recovered_markers = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in recovered_markers
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in recovered_markers


def test_retained_receipt_recovery_fails_before_attestation_when_generation_reproof_fails(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        attestation_fails=True,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    first = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert first.returncode == 14
    receipt = _receipt_path(env)
    assert receipt.is_file()

    Path(env["CALL_LOG"]).write_text("")
    env["FAKE_ATTESTATION_FAIL"] = "0"
    env["FAKE_RECEIPT_REPROOF_FAIL"] = "1"
    env["FAKE_SWEEPER_STATE"] = "stopped"
    recovered = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert recovered.returncode == 14
    assert "exact current bucket/key/generation bindings" in recovered.stderr
    recovery_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(call.startswith("canary-verify ") for call in recovery_calls)
    assert not any(
        "solver-execution-pools" in call and '{"enabled":true}' in call
        for call in recovery_calls
    )
    assert not any("/attest" in call for call in recovery_calls)
    assert not any("/finalize" in call for call in recovery_calls)
    assert receipt.is_file()


def test_certification_only_recovery_rejects_storage_config_drift_before_mutation(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    env_file.write_text(
        env_file.read_text()
        .replace(
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v2",
        )
    )
    _replace_env_values(
        env_file,
        {
            "OPENCFD2606_CUTOVER_PENDING": "1",
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "1",
            "OPENCFD2606_CANARY_ATTESTATION_ID": (
                "11111111-1111-4111-8111-111111111111"
            ),
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
            "OPENCFD2606_CUTOVER_COMPLETE": "0",
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                CERTIFIED_EVIDENCE_CONTRACT_SHA256
            ),
        }
        | _pending_source_binding(env_file),
    )

    completed = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "differs from the OpenCFD v2606 certified contract" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" stop sweeper" in call for call in calls)
    assert not any("solver-execution-pools" in call for call in calls)
    assert not any("/finalize" in call for call in calls)


@pytest.mark.parametrize("failed_stage", ["finalize", "complete"])
def test_opencfd_cutover_fail_safe_handles_unacknowledged_commit_stage(
    tmp_path: Path, failed_stage: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        finalize_fails=failed_stage == "finalize",
        complete_fails=failed_stage == "complete",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "not acknowledged" in completed.stderr
    assert "database may have committed" in completed.stderr.lower()
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(f"/{failed_stage}" in call for call in calls)
    if failed_stage == "finalize":
        assert not any("/complete" in call for call in calls)
    assert not any(" up -d --no-deps --force-recreate sweeper" in call for call in calls)
    assert any(" stop sweeper" in call for call in calls)


@pytest.mark.parametrize("failure_mode", ["attestation", "terminal"])
def test_opencfd_cutover_exit_guard_handles_unexpected_atomic_marker_failure(
    tmp_path: Path, failure_mode: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        atomic_marker_fail_mode=failure_mode,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 43
    assert "exited before terminal continuation proof" in completed.stderr
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(" stop sweeper" in call for call in calls)
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=1" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=0" in persisted
    if failure_mode == "attestation":
        assert not any("/finalize" in call for call in calls)
    else:
        assert any("/continuation" in call for call in calls)


def test_initial_atomic_cutover_marker_failure_mutates_neither_db_nor_scheduler(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        atomic_marker_fail_mode="initial",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    initial_env = Path(env["ENV_FILE"]).read_text()

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 43
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("/prepare" in call for call in calls)
    assert not any(" stop sweeper" in call for call in calls)
    assert not any(
        'solver-execution-pools/3f8bc764-09ae-4ff3-8fd2-260600000001' in call
        for call in calls
    )
    assert Path(env["ENV_FILE"]).read_text() == initial_env


def test_opencfd_cutover_stops_restored_sweeper_when_successor_route_is_wrong(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        continuation_status="pending",
        continuation_error="successor job used the wrong pool",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 15
    assert "successor continuation failed closed" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    restore_index = next(
        i
        for i, call in enumerate(calls)
        if " up -d --no-deps --force-recreate sweeper" in call
    )
    continuation_index = next(i for i, call in enumerate(calls) if "/continuation" in call)
    stop_index = next(
        i for i, call in enumerate(calls) if i > continuation_index and " stop sweeper" in call
    )
    assert restore_index < continuation_index < stop_index
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=1" in persisted
    assert "OPENCFD2606_CANARY_ATTESTATION_ID=11111111-1111-4111-8111-111111111111" in persisted


def test_opencfd_cutover_timeout_stops_scheduler_and_disables_pool(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        continuation_status="pending",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env["CUTOVER_CONTINUATION_TIMEOUT_SECONDS"] = "0"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 15
    assert "Timed out" in completed.stderr
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == ["disabled"]
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    continuation_index = next(i for i, call in enumerate(calls) if "/continuation" in call)
    assert any(
        i > continuation_index and " stop sweeper" in call
        for i, call in enumerate(calls)
    )
    assert "OPENCFD2606_CUTOVER_PENDING=1" in Path(env["ENV_FILE"]).read_text()


def test_opencfd_cutover_preserves_intentionally_stopped_scheduler_as_pending(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2406",
        target_engine_version="2606",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "continuation awaiting a scheduler" in completed.stdout
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert sum("/continuation" in call for call in calls) == 1
    assert not any(" up -d --no-deps --force-recreate sweeper" in call for call in calls)
    pending_env = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=1" in pending_env
    assert "OPENCFD2606_CUTOVER_COMPLETE=0" in pending_env

    # Later operator intent is explicit: start the scheduler, then certify the
    # durable continuation without rebuilding or guessing the old state.
    Path(env["CALL_LOG"]).write_text("")
    env["FAKE_SWEEPER_STATE"] = "running"
    certified = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert certified.returncode == 0, certified.stdout + certified.stderr
    certification_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any("/continuation" in call for call in certification_calls)
    assert not any(" build " in call for call in certification_calls)
    assert any(" stop sweeper" in call for call in certification_calls)
    assert not any(" up -d --no-deps sweeper" in call for call in certification_calls)
    certified_env = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in certified_env
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in certified_env


def test_opencfd_cutover_accepts_truthful_zero_runnable_continuation(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        continuation_status="not_required",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "No previously runnable campaign" in completed.stdout
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in persisted


def test_pending_attestation_refuses_changed_build_and_replays_without_rebuild(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    _set_pending_attestation(env_file, sweeper_was_running="1")

    refused = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "different-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert refused.returncode == 14
    assert "durable OpenCFD v2606 attestation is already pending" in refused.stderr
    assert "--certify-opencfd-2606-continuation" in refused.stderr
    refused_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in refused_calls)

    Path(env["CALL_LOG"]).write_text("")
    resumed = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    replay_calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any("/finalize" in call for call in replay_calls)
    assert any("/complete" in call for call in replay_calls)
    assert any("/continuation" in call for call in replay_calls)
    assert not any(" build api" in call for call in replay_calls)
    stop_index = next(i for i, call in enumerate(replay_calls) if " stop sweeper" in call)
    activation_index = next(
        i
        for i, call in enumerate(replay_calls)
        if "solver-execution-pools/3f8bc764-09ae-4ff3-8fd2-260600000001" in call
        and '{"enabled":true}' in call
    )
    complete_index = next(i for i, call in enumerate(replay_calls) if "/complete" in call)
    restore_index = next(
        i for i, call in enumerate(replay_calls) if " up -d --no-deps sweeper" in call
    )
    assert stop_index < activation_index < complete_index < restore_index
    persisted = env_file.read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in persisted


@pytest.mark.parametrize(
    "marker_lines",
    [
        (
            "OPENCFD2606_CUTOVER_PENDING=0\n"
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=1\n"
            "OPENCFD2606_CANARY_ATTESTATION_ID=\n"
            "OPENCFD2606_CUTOVER_COMPLETE=1\n"
        ),
        (
            "OPENCFD2606_CUTOVER_PENDING=0\n"
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=\n"
            "OPENCFD2606_CANARY_ATTESTATION_ID=11111111-1111-4111-8111-111111111111\n"
            "OPENCFD2606_CUTOVER_COMPLETE=1\n"
        ),
        (
            "OPENCFD2606_CUTOVER_PENDING=1\n"
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=1\n"
            "OPENCFD2606_CANARY_ATTESTATION_ID=\n"
            "OPENCFD2606_CUTOVER_COMPLETE=1\n"
        ),
        (
            "OPENCFD2606_CUTOVER_PENDING=1\n"
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=\n"
            "OPENCFD2606_CANARY_ATTESTATION_ID=\n"
            "OPENCFD2606_CUTOVER_COMPLETE=0\n"
        ),
        (
            "OPENCFD2606_CUTOVER_PENDING=1\n"
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=1\n"
            "OPENCFD2606_CANARY_ATTESTATION_ID=partially-written\n"
            "OPENCFD2606_CUTOVER_COMPLETE=0\n"
        ),
    ],
)
def test_normal_rebuild_refuses_every_partial_or_malformed_cutover_marker_tuple(
    tmp_path: Path, marker_lines: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env_file = Path(env["ENV_FILE"])
    env_file.write_text(
        "AIRFOILFOAM_BUILD_ID=old-build\n"
        "ENGINE_EXPECTED_BUILD_ID=old-build\n"
        + REMOTE_EVIDENCE_ENV
        + marker_lines
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "different-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "refusing" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert not any("/prepare" in call for call in calls)


def test_documented_pristine_opencfd_2606_tuple_allows_first_activation(
    tmp_path: Path,
) -> None:
    documented = {}
    for line in (ROOT / ".env.example").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            documented[key] = value
    assert documented["OPENCFD2606_CUTOVER_PENDING"] == "0"
    assert documented["OPENCFD2606_CUTOVER_COMPLETE"] == "0"
    assert documented["OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING"] == ""
    assert documented["OPENCFD2606_CANARY_ATTESTATION_ID"] == ""
    assert documented["OPENCFD2606_CANARY_RECEIPT_EXPECTED"] == "0"
    assert documented["OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256"] == ""
    assert documented["OPENCFD2606_CUTOVER_SOURCE_REVISION"] == ""
    assert documented["OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256"] == ""

    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2606",
        target_engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    initial = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0\n" in initial
    assert "OPENCFD2606_CUTOVER_COMPLETE=0\n" in initial
    assert "OPENCFD2606_CANARY_ATTESTATION_ID=\n" in initial
    assert "OPENCFD2606_CANARY_RECEIPT_EXPECTED=0\n" in initial
    assert "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=\n" in initial
    assert "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=\n" in initial
    assert "OPENCFD2606_CUTOVER_SOURCE_REVISION=\n" in initial
    assert "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256=\n" in initial

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0\n" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=1\n" in persisted
    assert "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=" in persisted


def test_normal_rebuild_refuses_retained_unacknowledged_canary_receipt(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env_file = Path(env["ENV_FILE"])
    _replace_env_values(
        env_file,
        {
            "OPENCFD2606_CUTOVER_PENDING": "1",
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "1",
            "OPENCFD2606_CANARY_ATTESTATION_ID": "",
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
            "OPENCFD2606_CUTOVER_COMPLETE": "0",
        }
        | _pending_source_binding(env_file),
    )
    receipt = _receipt_path(env)
    _write_valid_canary_receipt(receipt)

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "different-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "receipt is retained" in completed.stderr
    assert "--certify-opencfd-2606-continuation" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert not any("/prepare" in call for call in calls)


@pytest.mark.parametrize("failed_stage", ["finalize", "complete"])
def test_continuation_certification_quiesces_before_unacknowledged_stage_replay(
    tmp_path: Path, failed_stage: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2606",
        cutover_complete=False,
        finalize_fails=failed_stage == "finalize",
        complete_fails=failed_stage == "complete",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    _set_pending_attestation(env_file, sweeper_was_running="1")

    completed = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "database may have committed" in completed.stderr.lower()
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    stop_index = next(i for i, call in enumerate(calls) if " stop sweeper" in call)
    stage_index = next(i for i, call in enumerate(calls) if f"/{failed_stage}" in call)
    assert stop_index < stage_index
    assert not any(" up -d --no-deps sweeper" in call for call in calls)
    # One disable closes admission on entry; another follows the ambiguous
    # commit-stage response before EXIT cleanup verifies the fail-safe flag.
    assert Path(env["POOL_DISABLE_LOG"]).read_text().splitlines() == [
        "disabled",
        "disabled",
    ]
    assert "OPENCFD2606_CUTOVER_PENDING=1" in env_file.read_text()


def test_continuation_replay_uses_durable_pre_cutover_scheduler_state(
    tmp_path: Path,
) -> None:
    interrupted_running = _deploy_harness(
        tmp_path / "was-running",
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    interrupted_running["ADMIN_COOKIE"] = "aero_admin=test-token"
    running_env_file = Path(interrupted_running["ENV_FILE"])
    _set_pending_attestation(running_env_file, sweeper_was_running="1")
    resumed = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=interrupted_running,
        text=True,
        capture_output=True,
        check=False,
    )
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    running_calls = Path(interrupted_running["CALL_LOG"]).read_text().splitlines()
    assert any(" up -d --no-deps sweeper" in call for call in running_calls)
    assert "OPENCFD2606_CUTOVER_PENDING=0" in running_env_file.read_text()

    interrupted_stopped = _deploy_harness(
        tmp_path / "was-stopped",
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
        continuation_status="not_required",
    )
    interrupted_stopped["ADMIN_COOKIE"] = "aero_admin=test-token"
    stopped_env_file = Path(interrupted_stopped["ENV_FILE"])
    _set_pending_attestation(stopped_env_file, sweeper_was_running="0")
    certified_without_start = subprocess.run(
        [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ],
        env=interrupted_stopped,
        text=True,
        capture_output=True,
        check=False,
    )
    assert certified_without_start.returncode == 0, (
        certified_without_start.stdout + certified_without_start.stderr
    )
    stopped_calls = Path(interrupted_stopped["CALL_LOG"]).read_text().splitlines()
    assert not any(" up -d --no-deps sweeper" in call for call in stopped_calls)
    assert "OPENCFD2606_CUTOVER_PENDING=0" in stopped_env_file.read_text()


def test_stopped_opencfd_cutover_clears_only_truthful_not_required_continuation(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2406",
        target_engine_version="2606",
        continuation_status="not_required",
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert sum("/continuation" in call for call in calls) == 1
    assert not any(" up -d --no-deps --force-recreate sweeper" in call for call in calls)
    persisted = Path(env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in persisted


def test_retried_opencfd_cutover_restores_the_original_running_sweeper(
    tmp_path: Path,
) -> None:
    first_env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        engine_version="2406",
        target_engine_version="2606",
        queue_active_after=3,
        cutover_complete=False,
    )
    first_env["ADMIN_COOKIE"] = "aero_admin=test-token"

    first = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=first_env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert first.returncode == 12
    persisted = Path(first_env["ENV_FILE"]).read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=1" in persisted
    assert "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING=1" in persisted

    # The failed run restored the old sweeper. Model a later process crash
    # after it is stopped again: the durable pre-cutover state, not this
    # instantaneous stopped state, must decide the successful retry outcome.
    retry_env = dict(first_env)
    retry_env["FAKE_SWEEPER_STATE"] = "stopped"
    retry_env["FAKE_ENGINE_VERSION"] = "2606"
    retry_env["FAKE_BUILD_ID"] = "retry-build"
    retry_env["FAKE_QUEUE_ACTIVE_AFTER"] = "0"
    Path(retry_env["QUEUE_PROBE_COUNT"]).unlink(missing_ok=True)
    Path(retry_env["ENGINE_RECREATED"]).unlink(missing_ok=True)
    Path(retry_env["CALL_LOG"]).write_text("")

    retry = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "retry-build"],
        env=retry_env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert retry.returncode == 0, retry.stdout + retry.stderr
    calls = Path(retry_env["CALL_LOG"]).read_text().splitlines()
    assert any(" up -d --no-deps --force-recreate sweeper" in call for call in calls)
    assert "OPENCFD2606_CUTOVER_PENDING=0" in Path(retry_env["ENV_FILE"]).read_text()


def test_engine_rebuild_does_not_start_inactive_optional_worker(tmp_path: Path) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    mutation_calls = [
        call
        for call in calls
        if " build api" in call or " up -d --no-deps --force-recreate api" in call
    ]
    assert mutation_calls
    assert all("worker-foundation14" not in call for call in mutation_calls)


def test_engine_rebuild_refuses_running_worker_outside_active_profiles(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        active_engine_service="worker-foundation14",
    )
    initial_env = Path(env["ENV_FILE"]).read_text()

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "running outside the active Compose profiles" in completed.stderr
    assert "worker-foundation14" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert Path(env["ENV_FILE"]).read_text() == initial_env


def test_engine_rebuild_refuses_active_foundation_solver_process(tmp_path: Path) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        foundation_profile=True,
        active_engine_service="worker-foundation14",
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "OpenFOAM processes are active" in completed.stderr
    assert "worker-foundation14: 4242 foamRun" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)


def test_control_plane_deploy_observes_but_never_restarts_optional_worker(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        active_engine_service="worker-foundation14",
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "worker-foundation14: 4242 foamRun" in completed.stdout
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(
        (" up " in call or " build " in call or " stop " in call)
        and "worker-foundation14" in call
        for call in calls
    )


@pytest.mark.parametrize(
    ("key", "drifted_value"),
    [
        ("AIRFOILFOAM_EVIDENCE_BUCKET", "another-valid-evidence-bucket"),
        ("AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX", "solver-evidence/v2"),
        ("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL", "19"),
        ("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "false"),
    ],
)
@pytest.mark.parametrize("script", ["rebuild-engine.sh", "vps-redeploy.sh"])
def test_certified_deploys_reject_evidence_contract_drift_before_mutation(
    tmp_path: Path,
    script: str,
    key: str,
    drifted_value: str,
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="running")
    _replace_env_values(Path(env["ENV_FILE"]), {key: drifted_value})
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("drifted-build")

    completed = subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert not any(" stop sweeper" in call for call in calls)
    assert not any(" up -d --no-deps node-api" in call for call in calls)


@pytest.mark.parametrize("marker", ["", "not-a-sha256"])
@pytest.mark.parametrize("script", ["rebuild-engine.sh", "vps-redeploy.sh"])
def test_completed_deploys_reject_missing_or_malformed_contract_marker(
    tmp_path: Path,
    script: str,
    marker: str,
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="running")
    _replace_env_values(
        Path(env["ENV_FILE"]),
        {"OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": marker},
    )
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("missing-marker-build")

    completed = subprocess.run(
        command,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build api" in call for call in calls)
    assert not any(" stop sweeper" in call for call in calls)
    assert not any(" up -d --no-deps node-api" in call for call in calls)


def test_pristine_control_plane_deploy_allows_blank_contract_marker(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "initial pre-cutover state" in completed.stdout


def _cutover_entry_command(entrypoint: str) -> list[str]:
    if entrypoint == "control-plane":
        return [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")]
    if entrypoint == "rebuild":
        return [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "validator-test-build",
        ]
    if entrypoint == "certification":
        return [
            str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"),
            "--certify-opencfd-2606-continuation",
        ]
    raise AssertionError(entrypoint)


def _assert_no_deploy_mutation(env: dict[str, str]) -> None:
    log = Path(env["CALL_LOG"])
    calls = log.read_text().splitlines() if log.exists() else []
    assert calls == ["compose version"]


@pytest.mark.parametrize(
    "entrypoint", ["control-plane", "rebuild", "certification"]
)
@pytest.mark.parametrize("duplicate_key", CUTOVER_STATE_FIELDS)
def test_every_duplicate_cutover_field_fails_before_any_service_mutation(
    tmp_path: Path, entrypoint: str, duplicate_key: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    existing = next(
        line.split("=", 1)[1]
        for line in env_file.read_text().splitlines()
        if line.split("=", 1)[0] == duplicate_key
    )
    with env_file.open("a") as stream:
        stream.write(f"{duplicate_key}={existing}\n")

    completed = subprocess.run(
        _cutover_entry_command(entrypoint),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "duplicate field" in completed.stderr
    _assert_no_deploy_mutation(env)


@pytest.mark.parametrize(
    "entrypoint", ["control-plane", "rebuild", "certification"]
)
@pytest.mark.parametrize("missing_key", CUTOVER_STATE_FIELDS)
def test_every_missing_cutover_field_fails_before_any_service_mutation(
    tmp_path: Path, entrypoint: str, missing_key: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    env_file.write_text(
        "\n".join(
            line
            for line in env_file.read_text().splitlines()
            if line.split("=", 1)[0] != missing_key
        )
        + "\n"
    )

    completed = subprocess.run(
        _cutover_entry_command(entrypoint),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14
    assert "missing required field" in completed.stderr
    _assert_no_deploy_mutation(env)


INVALID_CUTOVER_STATES = (
    "malformed-pending",
    "malformed-complete",
    "malformed-sweeper",
    "malformed-attestation",
    "malformed-receipt-flag",
    "malformed-contract",
    "malformed-source-revision",
    "malformed-source-tree",
    "pending-and-complete",
    "terminal-without-contract",
    "pristine-with-contract",
    "nonpending-with-sweeper",
    "nonpending-with-attestation",
    "nonpending-with-source-binding",
    "pending-without-sweeper",
    "pending-without-source-binding",
    "attested-without-contract",
    "attested-and-receipt-expected",
    "pending-pristine-with-contract",
    "pending-receipt-with-contract",
    "receipt-expected-but-missing",
    "pending-source-mismatch",
)


def _install_invalid_cutover_state(
    env: dict[str, str], scenario: str
) -> None:
    env_file = Path(env["ENV_FILE"])
    source = _pending_source_binding(env_file)
    pending = {
        "OPENCFD2606_CUTOVER_PENDING": "1",
        "OPENCFD2606_CUTOVER_COMPLETE": "0",
        "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "1",
        "OPENCFD2606_CANARY_ATTESTATION_ID": "",
        "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
        "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": "",
    } | source
    updates: dict[str, str]
    write_receipt = False

    if scenario == "malformed-pending":
        updates = {"OPENCFD2606_CUTOVER_PENDING": "yes"}
    elif scenario == "malformed-complete":
        updates = {"OPENCFD2606_CUTOVER_COMPLETE": "yes"}
    elif scenario == "malformed-sweeper":
        updates = pending | {"OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "running"}
    elif scenario == "malformed-attestation":
        updates = pending | {"OPENCFD2606_CANARY_ATTESTATION_ID": "partial"}
    elif scenario == "malformed-receipt-flag":
        updates = {"OPENCFD2606_CANARY_RECEIPT_EXPECTED": "yes"}
    elif scenario == "malformed-contract":
        updates = {
            "OPENCFD2606_CUTOVER_COMPLETE": "1",
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": "not-a-sha",
        }
    elif scenario == "malformed-source-revision":
        updates = pending | {"OPENCFD2606_CUTOVER_SOURCE_REVISION": "bad"}
    elif scenario == "malformed-source-tree":
        updates = pending | {"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": "bad"}
    elif scenario == "pending-and-complete":
        updates = pending | {"OPENCFD2606_CUTOVER_COMPLETE": "1"}
    elif scenario == "terminal-without-contract":
        updates = {"OPENCFD2606_CUTOVER_COMPLETE": "1"}
    elif scenario == "pristine-with-contract":
        updates = {
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                CERTIFIED_EVIDENCE_CONTRACT_SHA256
            )
        }
    elif scenario == "nonpending-with-sweeper":
        updates = {"OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "1"}
    elif scenario == "nonpending-with-attestation":
        updates = {
            "OPENCFD2606_CANARY_ATTESTATION_ID": (
                "11111111-1111-4111-8111-111111111111"
            )
        }
    elif scenario == "nonpending-with-source-binding":
        updates = source
    elif scenario == "pending-without-sweeper":
        updates = pending | {"OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": ""}
    elif scenario == "pending-without-source-binding":
        updates = pending | {
            "OPENCFD2606_CUTOVER_SOURCE_REVISION": "",
            "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": "",
        }
    elif scenario == "attested-without-contract":
        updates = pending | {
            "OPENCFD2606_CANARY_ATTESTATION_ID": (
                "11111111-1111-4111-8111-111111111111"
            )
        }
    elif scenario == "attested-and-receipt-expected":
        updates = pending | {
            "OPENCFD2606_CANARY_ATTESTATION_ID": (
                "11111111-1111-4111-8111-111111111111"
            ),
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "1",
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                CERTIFIED_EVIDENCE_CONTRACT_SHA256
            ),
        }
        write_receipt = True
    elif scenario == "pending-pristine-with-contract":
        updates = pending | {
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                CERTIFIED_EVIDENCE_CONTRACT_SHA256
            )
        }
    elif scenario == "pending-receipt-with-contract":
        updates = pending | {
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "1",
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                CERTIFIED_EVIDENCE_CONTRACT_SHA256
            ),
        }
        write_receipt = True
    elif scenario == "receipt-expected-but-missing":
        updates = pending | {"OPENCFD2606_CANARY_RECEIPT_EXPECTED": "1"}
    elif scenario == "pending-source-mismatch":
        updates = pending | {
            "OPENCFD2606_CUTOVER_SOURCE_REVISION": "c" * 40,
            "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": "d" * 64,
        }
    else:
        raise AssertionError(scenario)

    _replace_env_values(env_file, updates)
    if write_receipt:
        _write_valid_canary_receipt(_receipt_path(env))


@pytest.mark.parametrize(
    "entrypoint", ["control-plane", "rebuild", "certification"]
)
@pytest.mark.parametrize("scenario", INVALID_CUTOVER_STATES)
def test_impossible_cutover_states_fail_before_any_service_mutation(
    tmp_path: Path, entrypoint: str, scenario: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    _install_invalid_cutover_state(env, scenario)

    completed = subprocess.run(
        _cutover_entry_command(entrypoint),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 14, completed.stdout + completed.stderr
    assert "Unsafe OpenCFD v2606 recovery state" in completed.stderr
    _assert_no_deploy_mutation(env)


@pytest.mark.parametrize(
    ("state", "required_state", "expected_kind"),
    [
        ("pristine", "non-pending", "pristine"),
        ("terminal", "non-pending", "terminal"),
        ("pending-pristine", "any", "pending-pristine"),
        (
            "pending-unmarked-receipt",
            "pending-certifiable",
            "pending-unmarked-receipt",
        ),
        ("pending-receipt", "pending-certifiable", "pending-receipt"),
        ("pending-attested", "pending-certifiable", "pending-attested"),
        (
            "pending-attested-retained-receipt",
            "pending-certifiable",
            "pending-attested-retained-receipt",
        ),
    ],
)
def test_authoritative_validator_accepts_only_real_lifecycle_states(
    tmp_path: Path, state: str, required_state: str, expected_kind: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=state == "terminal",
    )
    env_file = Path(env["ENV_FILE"])
    if state.startswith("pending"):
        updates = {
            "OPENCFD2606_CUTOVER_PENDING": "1",
            "OPENCFD2606_CUTOVER_COMPLETE": "0",
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "1",
            "OPENCFD2606_CANARY_ATTESTATION_ID": "",
            "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": "",
        } | _pending_source_binding(env_file)
        if "attested" in state:
            updates |= {
                "OPENCFD2606_CANARY_ATTESTATION_ID": (
                    "11111111-1111-4111-8111-111111111111"
                ),
                "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": (
                    CERTIFIED_EVIDENCE_CONTRACT_SHA256
                ),
            }
        if state == "pending-receipt":
            updates["OPENCFD2606_CANARY_RECEIPT_EXPECTED"] = "1"
        _replace_env_values(env_file, updates)
        if "receipt" in state:
            _write_valid_canary_receipt(_receipt_path(env))

    manifest = json.loads((env_file.parent / ".deployment-source.json").read_text())
    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "deploy" / "opencfd2606_cutover_state.py"),
            "--env-file",
            str(env_file),
            "--receipt-file",
            str(_receipt_path(env)),
            "--require-state",
            required_state,
            "--current-source-revision",
            manifest["sourceRevision"],
            "--current-source-tree-sha256",
            manifest["sourceTreeSha256"],
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.strip() == expected_kind


def test_attestation_marker_write_before_receipt_unlink_recovers_idempotently(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="stopped",
        engine_version="2606",
        cutover_complete=False,
    )
    env["ADMIN_COOKIE"] = "aero_admin=test-token"
    env_file = Path(env["ENV_FILE"])
    _set_pending_attestation(env_file, sweeper_was_running="0")
    receipt = _receipt_path(env)
    _write_valid_canary_receipt(receipt)

    completed = subprocess.run(
        _cutover_entry_command("certification"),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "Re-proving the redundant post-attestation receipt" in completed.stdout
    assert "Removed the re-proven redundant post-attestation receipt" in completed.stdout
    assert not receipt.exists()
    persisted = env_file.read_text()
    assert "OPENCFD2606_CUTOVER_PENDING=0" in persisted
    assert "OPENCFD2606_CUTOVER_COMPLETE=1" in persisted
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any("run-openfoam-2606-canary.py" in call for call in calls)


@pytest.mark.parametrize("failed_service", ["sweeper", "media-repair"])
def test_control_plane_deploy_fails_if_required_background_service_exits_after_up(
    tmp_path: Path, failed_service: str
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        sweeper_dies_after_restore=failed_service == "sweeper",
        media_repair_running=failed_service != "media-repair",
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 1
    assert f"{failed_service} did not remain running" in completed.stderr
    assert "Airfoils.Pro deploy finished" not in completed.stdout
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert any(f" up -d --no-deps {failed_service}" in call for call in calls)
    assert sum(
        f" ps --status running -q {failed_service}" in call for call in calls
    ) >= 15


def test_control_plane_deploy_accepts_stably_running_background_services(
    tmp_path: Path,
) -> None:
    env = _deploy_harness(
        tmp_path,
        sweeper_state="running",
        media_repair_running=True,
    )

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "sweeper remained running after deployment" in completed.stdout
    assert "media-repair remained running after deployment" in completed.stdout
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert sum(" ps --status running -q sweeper" in call for call in calls) >= 4
    assert sum(" ps --status running -q media-repair" in call for call in calls) >= 3
