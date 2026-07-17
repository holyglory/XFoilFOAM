#!/usr/bin/env bash
# Promote an already-uploaded immutable source payload while holding the same
# lock used by every control-plane and engine maintenance action.
set -Eeuo pipefail

STAGING_DIR="${STAGING_DIR:?STAGING_DIR is required}"
APP_DIR="${APP_DIR:-/opt/airfoils-pro/app}"
LOCK_FILE="${LOCK_FILE:-/tmp/airfoils-pro-deploy.lock}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://airfoils.pro}"
EXPECTED_SOURCE_REVISION="${EXPECTED_SOURCE_REVISION:-}"
DEPLOY_ROOT="${DEPLOY_ROOT:-$(dirname "$APP_DIR")}"
RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_ROOT/releases}"
AIRFOILS_PRO_STATE_DIR="${AIRFOILS_PRO_STATE_DIR:-$DEPLOY_ROOT/state}"
SHARED_ENV_FILE="${SHARED_ENV_FILE:-$AIRFOILS_PRO_STATE_DIR/.env.deploy}"

if [[ ! -d "$STAGING_DIR" || -L "$STAGING_DIR" ]]; then
  echo "Deployment staging directory is missing or is a symbolic link: $STAGING_DIR" >&2
  exit 2
fi

staging_real="$(realpath "$STAGING_DIR")"
app_real="$(realpath -m "$APP_DIR")"
if [[ "$staging_real" == "$app_real" || "$staging_real/" == "$app_real/"* || "$app_real/" == "$staging_real/"* ]]; then
  echo "Deployment staging and application directories must be separate siblings." >&2
  exit 2
fi

manifest_tool="$staging_real/scripts/deploy/deployment-source-manifest.py"
exclude_file="$staging_real/scripts/deploy/source-rsync-excludes.txt"
manifest_file="$staging_real/.deployment-source.json"
switch_tool="$staging_real/scripts/deploy/atomic-release-switch.py"
fsync_tool="$staging_real/scripts/deploy/fsync-release.py"
env_preflight_tool="$staging_real/scripts/deploy/deployment-env-preflight.py"
bootstrap_env_tool="$staging_real/scripts/deploy/bootstrap-opencfd-env.py"
cutover_state_tool="$staging_real/scripts/deploy/opencfd2606_cutover_state.py"
remote_cutover_state_tool="$staging_real/scripts/deploy/remote-solver2606-cutover-state.py"
compose_profile_tool="$staging_real/scripts/deploy/deployment-compose-profile.sh"
for required in "$manifest_tool" "$exclude_file" "$manifest_file" "$switch_tool" "$fsync_tool" "$env_preflight_tool" "$bootstrap_env_tool" "$cutover_state_tool" "$remote_cutover_state_tool" "$compose_profile_tool" "$staging_real/scripts/deploy/vps-redeploy.sh"; do
  if [[ ! -f "$required" || -L "$required" ]]; then
    echo "Deployment staging payload is missing a required regular file: $required" >&2
    exit 2
  fi
done

manifest_fields="$(python3 "$manifest_tool" \
  --verify --root "$staging_real" --manifest "$manifest_file")"
IFS=$'\t' read -r source_revision source_tree_sha256 source_file_count <<<"$manifest_fields"
if [[ -n "$EXPECTED_SOURCE_REVISION" && "$source_revision" != "$EXPECTED_SOURCE_REVISION" ]]; then
  echo "Staged source revision mismatch: expected $EXPECTED_SOURCE_REVISION, found $source_revision" >&2
  exit 2
fi

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Another Airfoils.Pro deploy is already running." >&2
  exit 9
}

validate_regular_private_env() {
  local path="$1"
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "Deployment environment must be a non-symlink regular file: $path" >&2
    return 2
  fi
  if [[ "$(stat -c '%a' "$path")" != "600" ]]; then
    echo "Deployment environment must have exact mode 600: $path" >&2
    return 2
  fi
  if [[ "$(stat -c '%u' "$path")" != "$(id -u)" ]]; then
    echo "Deployment environment must be owned by the deploying user: $path" >&2
    return 2
  fi
}

if [[ -L "$AIRFOILS_PRO_STATE_DIR" || -L "$RELEASES_DIR" ]]; then
  echo "Deployment state and releases directories must not be symbolic links." >&2
  exit 2
fi
if [[ "$(realpath -m "$SHARED_ENV_FILE")" != "$(realpath -m "$AIRFOILS_PRO_STATE_DIR/.env.deploy")" ]]; then
  echo "SHARED_ENV_FILE must be the authoritative .env.deploy inside AIRFOILS_PRO_STATE_DIR." >&2
  exit 2
fi
install -d -m 700 "$AIRFOILS_PRO_STATE_DIR"

# The shared state file is authoritative once it exists. Never resurrect a
# stale recovery tuple from a prior release. During the one-time migration from
# a regular APP_DIR, copy its live env into shared state before switching.
if [[ -e "$SHARED_ENV_FILE" || -L "$SHARED_ENV_FILE" ]]; then
  validate_regular_private_env "$SHARED_ENV_FILE" || exit $?
  # A crash from an older two-transaction bootstrap may have durably copied a
  # wholly markerless legacy env. Canonicalizing only that all-absent state is
  # safe and retryable; any partial tuple fails without being overwritten.
  # The helper owns the production hub's GCS/campaign tuple only. A dedicated
  # remote solver must never acquire that tuple merely by promoting source.
  existing_role="$(awk -F= '$1 == "AIRFOILFOAM_DEPLOYMENT_ROLE" { sub(/^[^=]*=/, ""); print; exit }' "$SHARED_ENV_FILE")"
  existing_role="${existing_role:-hub}"
  if [[ "$existing_role" != "remote-solver" ]]; then
    python3 "$bootstrap_env_tool" --env-file "$SHARED_ENV_FILE"
  fi
else
  legacy_env="$APP_DIR/.env.deploy"
  if [[ -L "$APP_DIR" ]]; then
    echo "Shared deployment environment is missing for a versioned application; refusing stale-release recovery." >&2
    exit 2
  fi
  validate_regular_private_env "$legacy_env" || exit $?
  env_temp="$(mktemp "$AIRFOILS_PRO_STATE_DIR/.env.deploy.new.XXXXXX")"
  trap 'rm -f "${env_temp:-}" "${release_temp:-}"' EXIT
  install -m 600 "$legacy_env" "$env_temp"
  # Validate/canonicalize in the unpublished temp file. SHARED_ENV_FILE
  # therefore appears for the first time with the role-appropriate state.
  initial_role="$(awk -F= '$1 == "AIRFOILFOAM_DEPLOYMENT_ROLE" { sub(/^[^=]*=/, ""); print; exit }' "$env_temp")"
  initial_role="${initial_role:-hub}"
  if [[ "$initial_role" == "remote-solver" ]]; then
    python3 "$remote_cutover_state_tool" \
      --env-file "$env_temp" \
      --receipt-file "$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-canary-receipt.json" \
      --attestation-file "$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-attestation.json" \
      --require-state non-pending \
      >/dev/null || exit $?
  else
    python3 "$bootstrap_env_tool" --env-file "$env_temp"
    python3 "$cutover_state_tool" \
      --env-file "$env_temp" \
      --receipt-file "$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json" \
      --require-state non-pending \
      >/dev/null || exit $?
  fi
  python3 - "$env_temp" "$AIRFOILS_PRO_STATE_DIR" <<'PY'
import os
import sys

with open(sys.argv[1], "rb") as stream:
    os.fsync(stream.fileno())
directory = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
  mv -T "$env_temp" "$SHARED_ENV_FILE"
  env_temp=""
  python3 - "$AIRFOILS_PRO_STATE_DIR" <<'PY'
import os
import sys

directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
fi
python3 "$env_preflight_tool" \
  --app-dir "$APP_DIR" \
  --state-dir "$AIRFOILS_PRO_STATE_DIR" \
  --env-file "$SHARED_ENV_FILE" \
  >/dev/null

deployment_role="$(awk -F= '$1 == "AIRFOILFOAM_DEPLOYMENT_ROLE" { sub(/^[^=]*=/, ""); print; exit }' "$SHARED_ENV_FILE")"
deployment_role="${deployment_role:-hub}"
if [[ "$deployment_role" == "remote-solver" ]]; then
  python3 "$remote_cutover_state_tool" \
    --env-file "$SHARED_ENV_FILE" \
    --receipt-file "$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-canary-receipt.json" \
    --attestation-file "$AIRFOILS_PRO_STATE_DIR/remote-solver-2606-attestation.json" \
    --require-state non-pending \
    >/dev/null || exit $?
else
  python3 "$cutover_state_tool" \
    --env-file "$SHARED_ENV_FILE" \
    --receipt-file "$AIRFOILS_PRO_STATE_DIR/openfoam-2606-canary-receipt.pending.json" \
    --require-state non-pending \
    >/dev/null || exit $?
fi

install -d -m 755 "$RELEASES_DIR"

release_id="${source_revision}-${source_tree_sha256:0:16}"
release_dir="$RELEASES_DIR/$release_id"
if [[ -e "$release_dir" || -L "$release_dir" ]]; then
  if [[ ! -d "$release_dir" || -L "$release_dir" ]]; then
    echo "Versioned release path has an unsafe type: $release_dir" >&2
    exit 2
  fi
  promoted_fields="$(python3 "$manifest_tool" \
    --verify --root "$release_dir" --manifest "$release_dir/.deployment-source.json")"
else
  release_temp="$(mktemp -d "$RELEASES_DIR/.materializing-${release_id}.XXXXXX")"
  trap 'rm -rf "${release_temp:-}"; rm -f "${env_temp:-}"' EXIT
  echo "Materializing source revision $source_revision ($source_tree_sha256; $source_file_count files)."
  rsync -a --delete-delay --exclude-from="$exclude_file" "$staging_real/" "$release_temp/"
  promoted_fields="$(python3 "$manifest_tool" \
    --verify --root "$release_temp" --manifest "$release_temp/.deployment-source.json")"
  if [[ "$promoted_fields" != "$manifest_fields" ]]; then
    echo "Materialized deployment source identity differs from the staged payload." >&2
    exit 2
  fi
  mv -T "$release_temp" "$release_dir"
  release_temp=""
fi
if [[ "$promoted_fields" != "$manifest_fields" ]]; then
  echo "Versioned deployment source identity differs from the staged payload." >&2
  exit 2
fi
release_env_link="$release_dir/.env.deploy"
if [[ -e "$release_env_link" || -L "$release_env_link" ]]; then
  if [[ ! -L "$release_env_link" || "$(readlink -f "$release_env_link")" != "$(readlink -f "$SHARED_ENV_FILE")" ]]; then
    echo "Versioned release has a non-authoritative deployment environment path: $release_env_link" >&2
    exit 2
  fi
else
  ln -s "$SHARED_ENV_FILE" "$release_env_link"
fi
python3 "$release_dir/scripts/deploy/fsync-release.py" \
  --release "$release_dir" \
  --parent "$RELEASES_DIR"

legacy_destination="$RELEASES_DIR/legacy-pre-versioned-$(date -u +%Y%m%dT%H%M%SZ)-$$"
python3 "$switch_tool" \
  --app "$APP_DIR" \
  --release "$release_dir" \
  --legacy-destination "$legacy_destination"
if [[ -d "$legacy_destination" && ! -L "$legacy_destination" ]]; then
  legacy_env_link="$legacy_destination/.env.deploy.authoritative.$$"
  ln -s "$SHARED_ENV_FILE" "$legacy_env_link"
  mv -Tf "$legacy_env_link" "$legacy_destination/.env.deploy"
  python3 - "$legacy_destination" <<'PY'
import os
import sys

directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
fi
trap - EXIT

chmod +x "$APP_DIR/scripts/deploy/vps-redeploy.sh"
DEPLOY_LOCK_HELD=1 \
DEPLOY_SOURCE_REVISION="$source_revision" \
DEPLOY_SOURCE_TREE_SHA256="$source_tree_sha256" \
APP_DIR="$APP_DIR" \
AIRFOILS_PRO_STATE_DIR="$AIRFOILS_PRO_STATE_DIR" \
ENV_FILE="$SHARED_ENV_FILE" \
PUBLIC_ORIGIN="$PUBLIC_ORIGIN" \
LOCK_FILE="$LOCK_FILE" \
  "$APP_DIR/scripts/deploy/vps-redeploy.sh"
