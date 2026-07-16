#!/usr/bin/env bash
set -euo pipefail

# Reconstructs, but does not deploy or retain a running container for, the
# former OpenCFD 2406 worker. The build context comes from the exact
# pre-cutover commit; dirty/current 2606 sources are never copied into it.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_REVISION="313ad394d8364ae67c62b0929238e23355073f15"
SOURCE_TREE="f4ee8cc78a21d512b6b1aaf2a568d0dbd3b3da9f"
BASE_IMAGE="opencfd/openfoam-default:2406@sha256:dd5aa20630a55722663bf83ba0cb74870cba130081303e32e3865007fa2aa35a"
DOCKERFILE="$ROOT/docker/Dockerfile.worker-opencfd2406-rollback"
LOCK_FILE="$ROOT/docker/requirements-opencfd2406-rollback.lock"
LOCK_SHA256="64751f247e46d13584126d8312d5317e47feba077dfcd1c675cac0c93d2d6685"
DOCKERFILE_SHA256="a37a9fcb3ce023722a55b00e51b4fd49ca9bee396d8e12b928f6bc4cc2ae747b"
UBUNTU_SNAPSHOT="20260715T000000Z"
PLATFORM="linux/amd64"

usage() {
  cat <<'EOF'
Usage: reconstruct-opencfd-2406-image.sh --receipt PATH [--tag IMAGE_TAG]

Builds an isolated emergency OpenCFD 2406 image from the exact pre-cutover
source commit and writes an atomic JSON receipt containing the resulting image
ID and measured solver/package provenance. It does not alter Compose, the
database, execution pools, campaigns, or running services.
EOF
}

RECEIPT_FILE=""
IMAGE_TAG="xfoilfoam/opencfd-2406-rollback:${SOURCE_REVISION:0:12}"
while (($#)); do
  case "$1" in
    --receipt)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      RECEIPT_FILE="$2"
      shift 2
      ;;
    --tag)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      IMAGE_TAG="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$RECEIPT_FILE" ]]; then
  echo "--receipt is required so the reconstructed image identity is durably recorded." >&2
  usage >&2
  exit 2
fi
if [[ -z "$IMAGE_TAG" || "$IMAGE_TAG" =~ [[:space:]] ]]; then
  echo "--tag must be a non-empty Docker image reference without whitespace." >&2
  exit 2
fi
if [[ -e "$RECEIPT_FILE" ]]; then
  echo "Receipt already exists; refusing to overwrite audit evidence: $RECEIPT_FILE" >&2
  exit 2
fi
receipt_dir="$(dirname "$RECEIPT_FILE")"
if [[ ! -d "$receipt_dir" || -L "$receipt_dir" ]]; then
  echo "Receipt parent must be a pre-existing non-symlink audit directory: $receipt_dir" >&2
  exit 2
fi

for command in git docker tar python3 sha256sum; do
  command -v "$command" >/dev/null || {
    echo "Required command is unavailable: $command" >&2
    exit 3
  }
done

git -C "$ROOT" cat-file -e "${SOURCE_REVISION}^{commit}" 2>/dev/null || {
  echo "The exact pre-cutover source commit is unavailable locally: $SOURCE_REVISION" >&2
  echo "Fetch that immutable commit from the canonical repository before retrying." >&2
  exit 4
}
actual_revision="$(git -C "$ROOT" rev-parse "${SOURCE_REVISION}^{commit}")"
actual_tree="$(git -C "$ROOT" rev-parse "${SOURCE_REVISION}^{tree}")"
if [[ "$actual_revision" != "$SOURCE_REVISION" || "$actual_tree" != "$SOURCE_TREE" ]]; then
  echo "Pre-cutover source identity mismatch; refusing rollback reconstruction." >&2
  exit 4
fi
lock_sha256="$(sha256sum "$LOCK_FILE" | cut -c1-64)"
dockerfile_sha256="$(sha256sum "$DOCKERFILE" | cut -c1-64)"
if [[ "$lock_sha256" != "$LOCK_SHA256" || "$dockerfile_sha256" != "$DOCKERFILE_SHA256" ]]; then
  echo "Rollback dependency lock or Dockerfile checksum mismatch; refusing reconstruction." >&2
  exit 4
fi

workspace="$(mktemp -d)"
receipt_tmp=""
cleanup() {
  rm -rf "$workspace"
  if [[ -n "$receipt_tmp" ]]; then
    rm -f "$receipt_tmp"
  fi
}
trap cleanup EXIT

mkdir -p "$workspace/context"
git -C "$ROOT" archive --format=tar "$SOURCE_REVISION" \
  | tar -x -C "$workspace/context"
cp "$LOCK_FILE" "$workspace/context/rollback-requirements.lock"

context_tree="$({
  cd "$workspace/context"
  find pyproject.toml README.md src -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
} | sha256sum | awk '{print $1}')"

# Pulling by digest proves the exact archived upstream base is available. The
# build never resolves the mutable :2406 tag independently.
docker pull "$BASE_IMAGE" >/dev/null
iid_file="$workspace/image-id"
docker build \
  --platform "$PLATFORM" \
  --file "$DOCKERFILE" \
  --iidfile "$iid_file" \
  --build-arg "AIRFOILFOAM_BUILD_ID=opencfd2406-rollback-${SOURCE_REVISION:0:12}" \
  --tag "$IMAGE_TAG" \
  "$workspace/context"

image_id="$(tr -d '\r\n' < "$iid_file")"
if [[ ! "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Docker returned an invalid reconstructed image ID: $image_id" >&2
  exit 5
fi
label_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")"
label_base="$(docker image inspect --format '{{index .Config.Labels "io.xfoilfoam.engine.base-image"}}' "$image_id")"
image_architecture="$(docker image inspect --format '{{.Architecture}}' "$image_id")"
if [[ "$label_revision" != "$SOURCE_REVISION" || "$label_base" != "$BASE_IMAGE" || "$image_architecture" != "amd64" ]]; then
  echo "Reconstructed image labels do not match the locked source/base identity." >&2
  exit 5
fi

# The verification container is ephemeral (--rm), starts no Celery worker,
# touches no shared volume, and exists only to measure the packaged runtime.
runtime_measurement="$(docker run --rm --platform "$PLATFORM" --entrypoint bash "$image_id" -lc '
  # The OpenFOAM 2406 bashrc probes optional variables before defining them, so
  # neither nounset nor errexit can be enabled while sourcing the vendor
  # environment. Re-enable errexit immediately afterwards and validate both
  # the source status and every measured value below.
  source /usr/lib/openfoam/openfoam2406/etc/bashrc >/dev/null 2>&1
  source_status=$?
  set -e
  test -r /usr/lib/openfoam/openfoam2406/etc/bashrc
  test ! -r /usr/lib/openfoam/openfoam2606/etc/bashrc
  test "$source_status" -eq 0
  python3 -c "from airfoilfoam.api.main import app; from airfoilfoam.celery_app import celery_app; assert app.title and celery_app.main"
  binary="$(command -v simpleFoam)"
  test -x "$binary"
  package_version="$(dpkg-query -W openfoam2406 | cut -f2)"
  binary_sha="$(sha256sum "$binary" | cut -c1-64)"
  printf "%s\n%s\n" "$package_version" "$binary_sha"
')"
package_version="$(sed -n '1p' <<<"$runtime_measurement")"
binary_sha256="$(sed -n '2p' <<<"$runtime_measurement")"
if [[ -z "$package_version" || ! "$binary_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Reconstructed OpenCFD 2406 runtime measurement is incomplete." >&2
  exit 5
fi

receipt_tmp="$(mktemp "$receipt_dir/.opencfd2406-receipt.XXXXXX")"
SOURCE_REVISION="$SOURCE_REVISION" \
SOURCE_TREE="$SOURCE_TREE" \
CONTEXT_TREE_SHA256="$context_tree" \
BASE_IMAGE="$BASE_IMAGE" \
DOCKERFILE_SHA256="$dockerfile_sha256" \
LOCK_SHA256="$lock_sha256" \
UBUNTU_SNAPSHOT="$UBUNTU_SNAPSHOT" \
PLATFORM="$PLATFORM" \
IMAGE_TAG="$IMAGE_TAG" \
IMAGE_ID="$image_id" \
PACKAGE_VERSION="$package_version" \
BINARY_SHA256="$binary_sha256" \
python3 - "$receipt_tmp" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

payload = {
    "schema_version": 1,
    "purpose": "emergency-opencfd-2406-image-reconstruction",
    "source_revision": os.environ["SOURCE_REVISION"],
    "source_tree": os.environ["SOURCE_TREE"],
    "context_tree_sha256": os.environ["CONTEXT_TREE_SHA256"],
    "base_image": os.environ["BASE_IMAGE"],
    "dockerfile_sha256": os.environ["DOCKERFILE_SHA256"],
    "dependency_lock_sha256": os.environ["LOCK_SHA256"],
    "ubuntu_snapshot": os.environ["UBUNTU_SNAPSHOT"],
    "platform": os.environ["PLATFORM"],
    "image_tag": os.environ["IMAGE_TAG"],
    "image_id": os.environ["IMAGE_ID"],
    "openfoam_package_version": os.environ["PACKAGE_VERSION"],
    "simple_foam_sha256": os.environ["BINARY_SHA256"],
    "created_at": datetime.now(timezone.utc).isoformat(),
    "deployed": False,
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
PY
python3 "$ROOT/scripts/deploy/persist-json-receipt.py" \
  --profile opencfd2406-rollback \
  --source "$receipt_tmp" \
  --destination "$RECEIPT_FILE"
receipt_tmp=""

echo "Reconstructed emergency OpenCFD 2406 image: $image_id"
echo "Receipt: $RECEIPT_FILE"
echo "No service, execution pool, campaign, or database state was changed."
