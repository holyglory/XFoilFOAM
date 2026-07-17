#!/usr/bin/env bash
# Run exactly one three-stage URANS canary admission/observation while every
# ordinary Node scheduler path is quiesced. This wrapper deliberately does not
# stop, start, recreate, or otherwise mutate the OpenFOAM api/worker services.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-/opt/airfoils-pro/state}"
ENV_FILE="${ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.deploy.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-app}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"

RESTORE_ARMED=false
ENGINE_IDENTITY_CAPTURED=false
TEMP_DIR=""
API_ID=""
WORKER_ID=""
NODE_API_ID=""
NODE_API_INITIAL_STATE=""
SWEEPER_ID=""
SWEEPER_INITIAL_STATE=""
CAPTURED_ID=""
CAPTURED_STATE=""

die() {
  local code="$1"
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

require_safe_absolute_file() {
  local label="$1" path="$2"
  [[ "$path" == /* && -f "$path" && -r "$path" && ! -L "$path" ]] ||
    die 2 "$label must be an absolute, readable, regular non-symlink file: $path"
}

if [[ "$APP_DIR" != /* || ! -d "$APP_DIR" ]]; then
  die 2 "APP_DIR must be an absolute path resolving to an existing directory: $APP_DIR"
fi
require_safe_absolute_file ENV_FILE "$ENV_FILE"
require_safe_absolute_file COMPOSE_FILE "$COMPOSE_FILE"
ENV_PREFLIGHT="$APP_DIR/scripts/deploy/deployment-env-preflight.py"
require_safe_absolute_file ENV_PREFLIGHT "$ENV_PREFLIGHT"
[[ "$COMPOSE_PROJECT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
  die 2 "COMPOSE_PROJECT_NAME contains unsafe characters."
[[ "$LOCK_FILE" == /* && "$LOCK_FILE" != *$'\n'* && "$LOCK_FILE" != *$'\r'* ]] ||
  die 2 "LOCK_FILE must be a safe absolute path."
[[ ! -L "$LOCK_FILE" ]] || die 2 "LOCK_FILE must not be a symlink."
[[ -d "$(dirname -- "$LOCK_FILE")" ]] ||
  die 2 "LOCK_FILE parent directory does not exist."

# This is the same lock used by ordinary production deploy and engine
# maintenance scripts. Acquire it before the first Docker/Compose probe so a
# refusal cannot race a deploy preflight.
umask 077
exec 9>"$LOCK_FILE"
flock -n 9 || die 9 "Another Airfoils.Pro deploy or maintenance action is running."

cd -P -- "$APP_DIR"
python3 "$ENV_PREFLIGHT" \
  --app-dir "$APP_DIR" \
  --state-dir "$AIRFOILS_PRO_STATE_DIR" \
  --env-file "$ENV_FILE" \
  >/dev/null || die 2 "The authoritative deployment environment failed preflight."
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die 2 "Docker Compose is unavailable."
fi

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT_NAME" \
    -f "$COMPOSE_FILE" "$@"
}

# Capture one service container and its running/stopped state without allowing
# ambiguous scale, missing containers, or malformed IDs. Results are returned
# through CAPTURED_ID/CAPTURED_STATE to avoid leaking probe output to stdout.
capture_service_state() {
  local service="$1" require_running="${2:-false}" all_output running_output
  local -a all_ids=() running_ids=()
  if ! all_output="$(compose ps --all -q "$service")"; then
    printf 'Could not inspect the %s service container.\n' "$service" >&2
    return 1
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] || all_ids+=("$line")
  done <<<"$all_output"
  if ((${#all_ids[@]} != 1)) ||
    [[ ! "${all_ids[0]}" =~ ^[0-9a-fA-F]{12,64}$ ]]; then
    printf '%s must have exactly one unambiguous Compose container.\n' "$service" >&2
    return 1
  fi
  if ! running_output="$(compose ps --status running -q "$service")"; then
    printf 'Could not inspect the running state of %s.\n' "$service" >&2
    return 1
  fi
  while IFS= read -r line; do
    [[ -z "$line" ]] || running_ids+=("$line")
  done <<<"$running_output"
  if ((${#running_ids[@]} == 0)); then
    CAPTURED_STATE="stopped"
  elif ((${#running_ids[@]} == 1)) &&
    [[ "${running_ids[0]}" == "${all_ids[0]}" ]]; then
    CAPTURED_STATE="running"
  else
    printf '%s has an ambiguous Compose running state.\n' "$service" >&2
    return 1
  fi
  if [[ "$require_running" == "true" && "$CAPTURED_STATE" != "running" ]]; then
    printf '%s must be running before and after the canary window.\n' "$service" >&2
    return 1
  fi
  CAPTURED_ID="${all_ids[0]}"
}

assert_engine_identity_unchanged() {
  local current
  capture_service_state api true || return 1
  current="$CAPTURED_ID"
  [[ "$current" == "$API_ID" ]] || {
    printf 'CRITICAL: the OpenFOAM api container identity changed during the canary window.\n' >&2
    return 1
  }
  capture_service_state worker true || return 1
  current="$CAPTURED_ID"
  [[ "$current" == "$WORKER_ID" ]] || {
    printf 'CRITICAL: the OpenFOAM worker container identity changed during the canary window.\n' >&2
    return 1
  }
}

assert_service_state() {
  local service="$1" expected_id="$2" expected_state="$3"
  capture_service_state "$service" false || return 1
  [[ "$CAPTURED_ID" == "$expected_id" && "$CAPTURED_STATE" == "$expected_state" ]] || {
    printf '%s was not restored to its exact pre-canary container/state.\n' "$service" >&2
    return 1
  }
}

restore_one_service() {
  local service="$1" expected_id="$2" expected_state="$3" command_failed=false
  if [[ "$expected_state" == "running" ]]; then
    compose start "$service" >/dev/null || command_failed=true
  else
    compose stop "$service" >/dev/null || command_failed=true
  fi
  if [[ "$command_failed" == "true" ]]; then
    printf 'Failed to restore the prior %s state for %s.\n' "$expected_state" "$service" >&2
    return 1
  fi
  assert_service_state "$service" "$expected_id" "$expected_state"
}

restore_node_services() {
  local failed=false
  # Restore the API before the scheduler when both were initially running.
  restore_one_service node-api "$NODE_API_ID" "$NODE_API_INITIAL_STATE" || failed=true
  restore_one_service sweeper "$SWEEPER_ID" "$SWEEPER_INITIAL_STATE" || failed=true
  [[ "$failed" == "false" ]]
}

cleanup_on_exit() {
  local original_rc=$? cleanup_failed=false
  trap - EXIT HUP INT TERM
  set +e
  if [[ "$RESTORE_ARMED" == "true" ]]; then
    restore_node_services || cleanup_failed=true
  fi
  if [[ "$ENGINE_IDENTITY_CAPTURED" == "true" ]]; then
    assert_engine_identity_unchanged || cleanup_failed=true
  fi
  [[ -z "$TEMP_DIR" ]] || rm -rf -- "$TEMP_DIR"
  if [[ "$cleanup_failed" == "true" ]]; then
    printf 'CRITICAL: the canary failed and exact service restoration or engine identity could not be confirmed.\n' >&2
    exit 18
  fi
  exit "$original_rc"
}

trap cleanup_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Validate the resolved Compose model before reading or mutating service state.
compose config --quiet >/dev/null || die 2 "The deployment Compose configuration is invalid."
configured_services="$(compose config --services)" ||
  die 2 "The deployment Compose service list is unavailable."
for required_service in api worker node-api sweeper; do
  grep -Fxq "$required_service" <<<"$configured_services" ||
    die 2 "The deployment Compose model lacks required service: $required_service"
done

capture_service_state api true || die 14 "Could not establish the exact OpenFOAM api identity."
API_ID="$CAPTURED_ID"
capture_service_state worker true || die 14 "Could not establish the exact OpenFOAM worker identity."
WORKER_ID="$CAPTURED_ID"
ENGINE_IDENTITY_CAPTURED=true

capture_service_state node-api false || die 14 "Could not establish the initial node-api state."
NODE_API_ID="$CAPTURED_ID"
NODE_API_INITIAL_STATE="$CAPTURED_STATE"
capture_service_state sweeper false || die 14 "Could not establish the initial sweeper state."
SWEEPER_ID="$CAPTURED_ID"
SWEEPER_INITIAL_STATE="$CAPTURED_STATE"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/airfoils-pro-urans-canary.XXXXXXXX")" ||
  die 2 "Could not create private canary receipt storage."
receipt_raw="$TEMP_DIR/receipt.raw"
receipt_validated="$TEMP_DIR/receipt.json"

# Arm restoration before the first stop: a partial stop or verification error
# must restore both services to their independently captured prior states.
RESTORE_ARMED=true
compose stop node-api >/dev/null ||
  die 14 "node-api did not stop cleanly for the exclusive canary window."
compose stop sweeper >/dev/null ||
  die 14 "sweeper did not stop cleanly for the exclusive canary window."
assert_service_state node-api "$NODE_API_ID" stopped ||
  die 14 "node-api is not proven stopped; the canary CLI was not invoked."
assert_service_state sweeper "$SWEEPER_ID" stopped ||
  die 14 "sweeper is not proven stopped; the canary CLI was not invoked."
assert_engine_identity_unchanged ||
  die 18 "The OpenFOAM engine identity changed before canary admission."

# This is the sole mutation path inside the exclusive window. Its stdout is
# quarantined until it has been validated and every service is restored.
if ! compose run --rm --no-deps -T sweeper \
  pnpm --silent --filter @aerodb/sweeper urans-canary:admit-once "$@" \
  >"$receipt_raw"; then
  die 14 "The exact three-stage URANS canary invocation failed."
fi
assert_engine_identity_unchanged ||
  die 18 "The OpenFOAM engine identity changed during canary admission."

# Require one newline-terminated JSON object, reject duplicate JSON keys and
# non-finite numbers, validate the full receipt/target binding, then emit a
# canonical single line into another private file. Nothing reaches wrapper
# stdout during this validation.
if ! python3 - "$receipt_raw" "$@" >"$receipt_validated" <<'PY'
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import sys


def fail(message: str) -> None:
    raise SystemExit(message)


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            fail(f"duplicate JSON key: {key}")
        result[key] = value
    return result


raw = Path(sys.argv[1]).read_bytes()
if raw.count(b"\n") != 1 or not raw.endswith(b"\n") or b"\r" in raw:
    fail("receipt must be exactly one LF-terminated line")
try:
    receipt = json.loads(
        raw[:-1].decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=lambda value: fail(f"non-finite JSON number: {value}"),
    )
except (UnicodeDecodeError, json.JSONDecodeError) as error:
    fail(f"invalid receipt JSON: {error}")
if not isinstance(receipt, dict):
    fail("receipt must be a JSON object")

option_names = {
    "campaign-id",
    "condition-id",
    "expected-campaign-generation",
    "parent-job-id",
    "airfoil-id",
    "revision-id",
    "aoa-deg",
    "source-result-id",
    "source-result-attempt-id",
    "precalc-obligation-id",
    "expected-engine-build-id",
    "expected-mesh-recovery-version",
    "expected-urans-recovery-version",
}
arguments = sys.argv[2:]
options: dict[str, str] = {}
index = 0
while index < len(arguments):
    token = arguments[index]
    if not token.startswith("--") or token == "--":
        fail(f"unexpected canary argument: {token}")
    text = token[2:]
    if "=" in text:
        name, value = text.split("=", 1)
        index += 1
    else:
        name = text
        if index + 1 >= len(arguments):
            fail(f"missing value for --{name}")
        value = arguments[index + 1]
        index += 2
    if name not in option_names or name in options or value == "":
        fail(f"invalid or repeated option: --{name}")
    options[name] = value
if set(options) != option_names:
    fail("the exact canary target option set is incomplete")

uuid = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
uuid_bindings = {
    "campaignId": "campaign-id",
    "conditionId": "condition-id",
    "parentJobId": "parent-job-id",
    "airfoilId": "airfoil-id",
    "revisionId": "revision-id",
    "sourceResultId": "source-result-id",
    "sourceResultAttemptId": "source-result-attempt-id",
    "precalcObligationId": "precalc-obligation-id",
}
for field, option in uuid_bindings.items():
    expected = options[option]
    if not uuid.fullmatch(expected) or receipt.get(field) != expected.lower():
        fail(f"receipt does not match exact target field {field}")

integer_bindings = {
    "expectedCampaignGeneration": "expected-campaign-generation",
    "expectedMeshRecoveryVersion": "expected-mesh-recovery-version",
    "expectedUransRecoveryVersion": "expected-urans-recovery-version",
}
for field, option in integer_bindings.items():
    try:
        expected = int(options[option], 10)
    except ValueError:
        fail(f"invalid integer target option: --{option}")
    actual = receipt.get(field)
    if isinstance(actual, bool) or actual != expected:
        fail(f"receipt does not match exact target field {field}")

try:
    expected_aoa = float(options["aoa-deg"])
except ValueError:
    fail("invalid --aoa-deg")
actual_aoa = receipt.get("aoaDeg")
if (
    isinstance(actual_aoa, bool)
    or not isinstance(actual_aoa, (int, float))
    or not math.isfinite(expected_aoa)
    or not math.isfinite(actual_aoa)
    or actual_aoa != expected_aoa
):
    fail("receipt does not match exact target field aoaDeg")
if receipt.get("expectedEngineBuildId") != options["expected-engine-build-id"]:
    fail("receipt does not match exact target field expectedEngineBuildId")

if receipt.get("action") not in {"submitted", "observed", "no-op", "completed", "critical"}:
    fail("receipt action is invalid")
if receipt.get("stage") not in {"preliminary", "final", "transition", "complete", "critical"}:
    fail("receipt stage is invalid")
for field in ("requestId", "verifyQueueId", "simJobId", "criticalIncidentId"):
    value = receipt.get(field)
    if value is not None and (not isinstance(value, str) or not uuid.fullmatch(value)):
        fail(f"receipt field {field} must be null or an exact UUID")
for field in ("engineJobId", "requestState", "obligationState", "verifyState"):
    value = receipt.get(field)
    if field == "obligationState":
        if not isinstance(value, str) or not value:
            fail("receipt obligationState must be nonempty")
    elif value is not None and (not isinstance(value, str) or not value):
        fail(f"receipt field {field} must be null or nonempty text")
for field in (
    "criticalIncidentStage",
    "criticalIncidentReason",
    "criticalRemediationVersion",
):
    value = receipt.get(field)
    if value is not None and (not isinstance(value, str) or not value):
        fail(f"receipt field {field} must be null or nonempty text")
if receipt.get("action") == "critical":
    for field in (
        "criticalIncidentId",
        "criticalIncidentStage",
        "criticalIncidentReason",
        "criticalRemediationVersion",
    ):
        if receipt.get(field) is None:
            fail(f"critical receipt lacks {field}")

sys.stdout.write(json.dumps(receipt, separators=(",", ":"), sort_keys=True) + "\n")
PY
then
  die 14 "The canary CLI did not return one exact validated JSON receipt."
fi

restore_node_services ||
  die 18 "The Node services could not be restored after canary admission."
assert_engine_identity_unchanged ||
  die 18 "The OpenFOAM engine identity changed before the canary window closed."
RESTORE_ARMED=false

# The final state/identity checks have passed. Disarm every exit trap before
# releasing the sole validated receipt to stdout, so no later cleanup failure
# can turn an emitted receipt into a failed wrapper invocation.
trap - EXIT HUP INT TERM
receipt_line="$(<"$receipt_validated")"
rm -rf -- "$TEMP_DIR"
TEMP_DIR=""
printf '%s\n' "$receipt_line"
