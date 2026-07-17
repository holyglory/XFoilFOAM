#!/usr/bin/env bash
# Create and strongly verify the exact production aerodb snapshot required by
# the pending OpenCFD 2606 canary recovery, then publish and independently
# download-verify generation-locked dump and manifest objects in private GCS.
# Every final local/GCS artifact is replayable after an interrupted invocation;
# existing content is reused only after exact verification and never replaced.
set -Eeuo pipefail
umask 077

POSTGRES_BACKUP_TOOL="${POSTGRES_BACKUP_TOOL:?POSTGRES_BACKUP_TOOL is required}"
EXPECTED_POSTGRES_BACKUP_TOOL_SHA256="${EXPECTED_POSTGRES_BACKUP_TOOL_SHA256:?EXPECTED_POSTGRES_BACKUP_TOOL_SHA256 is required}"
EXPECTED_POSTGRES_CONTAINER_ID="${EXPECTED_POSTGRES_CONTAINER_ID:?EXPECTED_POSTGRES_CONTAINER_ID is required}"
EXPECTED_POSTGRES_IMAGE_ID="${EXPECTED_POSTGRES_IMAGE_ID:?EXPECTED_POSTGRES_IMAGE_ID is required}"
DATABASE_BACKUP_FILE="${DATABASE_BACKUP_FILE:?DATABASE_BACKUP_FILE is required}"
DATABASE_BACKUP_MANIFEST="${DATABASE_BACKUP_MANIFEST:?DATABASE_BACKUP_MANIFEST is required}"
DATABASE_BACKUP_OFF_VPS_RECEIPT="${DATABASE_BACKUP_OFF_VPS_RECEIPT:?DATABASE_BACKUP_OFF_VPS_RECEIPT is required}"
MEDIA_QUIESCE_JOURNAL="${MEDIA_QUIESCE_JOURNAL:?MEDIA_QUIESCE_JOURNAL is required}"
POSTGRES_CONTAINER_NAME="${POSTGRES_CONTAINER_NAME:-app-postgres-1}"
GCS_BACKUP_BUCKET="${GCS_BACKUP_BUCKET:-airfoils-pro-storage-bucket}"
GCS_BACKUP_PREFIX="${GCS_BACKUP_PREFIX:-operational-backups/postgres/opencfd2606-canary-db-ack}"
DEPLOY_LOCK_HELD="${DEPLOY_LOCK_HELD:-0}"

fail() {
  echo "$1" >&2
  exit "${2:-14}"
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

require_private_directory() {
  local path="$1" label="$2"
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a real directory." 2
  [[ "$(stat -c '%a' "$path")" == "700" && "$(stat -c '%u' "$path")" == "$(id -u)" ]] \
    || fail "$label must be owner-controlled mode 0700." 2
}

require_private_regular() {
  local path="$1" label="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label must be a regular non-symlink file."
  [[ "$(stat -c '%a' "$path")" == "600" && "$(stat -c '%u' "$path")" == "$(id -u)" ]] \
    || fail "$label must be owner-controlled mode 0600."
}

[[ "$DEPLOY_LOCK_HELD" == "1" ]] || fail "Backup hook requires the inherited deployment lock." 9
[[ -e /proc/$$/fd/9 ]] || fail "Backup hook requires inherited descriptor 9." 9
flock -n 9 || fail "Inherited descriptor 9 is not held by this backup transaction." 9
[[ "$POSTGRES_BACKUP_TOOL" == /* ]] || fail "Postgres backup tool path must be absolute." 2
[[ "$EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "Backup tool SHA-256 must be exact lowercase hexadecimal." 2
[[ "$EXPECTED_POSTGRES_CONTAINER_ID" =~ ^[0-9a-f]{64}$ ]] || fail "Postgres container ID must be exact." 2
[[ "$EXPECTED_POSTGRES_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Postgres image ID must be exact." 2
[[ "$GCS_BACKUP_BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || fail "Unsafe GCS backup bucket." 2
[[ "$GCS_BACKUP_PREFIX" =~ ^[A-Za-z0-9._/-]+$ && "$GCS_BACKUP_PREFIX" != /* && "$GCS_BACKUP_PREFIX" != *..* ]] || fail "Unsafe GCS backup prefix." 2

[[ -f "$POSTGRES_BACKUP_TOOL" && ! -L "$POSTGRES_BACKUP_TOOL" ]] || fail "Reviewed Postgres backup tool is missing or unsafe." 2
[[ "$(sha256_file "$POSTGRES_BACKUP_TOOL")" == "$EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" ]] || fail "Postgres backup tool differs from its reviewed digest." 2

for path in "$DATABASE_BACKUP_FILE" "$DATABASE_BACKUP_MANIFEST" "$DATABASE_BACKUP_OFF_VPS_RECEIPT" "$MEDIA_QUIESCE_JOURNAL"; do
  [[ "$path" == /* ]] || fail "Backup and journal paths must be absolute." 2
done
[[ "$DATABASE_BACKUP_MANIFEST" == "$DATABASE_BACKUP_FILE.manifest.json" ]] || fail "Backup manifest path must be the backup tool's exact companion path." 2
[[ "$DATABASE_BACKUP_FILE" != "$DATABASE_BACKUP_OFF_VPS_RECEIPT" && "$DATABASE_BACKUP_MANIFEST" != "$DATABASE_BACKUP_OFF_VPS_RECEIPT" ]] || fail "Backup outputs must be distinct." 2

backup_dir="$(dirname "$DATABASE_BACKUP_FILE")"
receipt_dir="$(dirname "$DATABASE_BACKUP_OFF_VPS_RECEIPT")"
require_private_directory "$backup_dir" "Backup directory"
require_private_directory "$receipt_dir" "Receipt directory"
require_private_regular "$MEDIA_QUIESCE_JOURNAL" "Media-quiesce journal"
python3 - "$MEDIA_QUIESCE_JOURNAL" <<'PY'
import json
from pathlib import Path
import sys

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if (
    payload.get("schemaVersion") != 1
    or payload.get("purpose")
    != "pending-opencfd2606-canary-db-ack-r4-media-quiesce"
    or payload.get("status") != "stopped-for-backup"
    or not payload.get("stoppedAt")
):
    raise SystemExit("backup hook requires the exact stopped-for-backup media journal")
PY

actual_container_id="$(docker inspect --format '{{.Id}}' "$POSTGRES_CONTAINER_NAME")"
actual_image_id="$(docker inspect --format '{{.Image}}' "$POSTGRES_CONTAINER_NAME")"
[[ "$actual_container_id" == "$EXPECTED_POSTGRES_CONTAINER_ID" ]] || fail "Postgres container identity changed before backup."
[[ "$actual_image_id" == "$EXPECTED_POSTGRES_IMAGE_ID" ]] || fail "Postgres image identity changed before backup."

# Print absent, partial, unmatched, candidate, collision, or unsafe. An
# incomplete singleton and a pair whose manifest hash/size no longer matches
# are restart debris and are quarantined without deleting bytes. A complete
# pair with a different provenance is a real content collision and fails.
local_pair_state() {
  python3 - "$DATABASE_BACKUP_FILE" "$DATABASE_BACKUP_MANIFEST" \
    "$EXPECTED_POSTGRES_CONTAINER_ID" "$EXPECTED_POSTGRES_IMAGE_ID" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

dump, manifest = map(Path, sys.argv[1:3])
expected_container, expected_image = sys.argv[3:5]
present = [os.path.lexists(path) for path in (dump, manifest)]
if not any(present):
    print("absent")
    raise SystemExit
for path, exists in zip((dump, manifest), present):
    if not exists:
        continue
    metadata = path.lstat()
    if (
        path.is_symlink()
        or not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid()
    ):
        print("unsafe")
        raise SystemExit
if present != [True, True]:
    print("partial")
    raise SystemExit
try:
    payload = json.loads(manifest.read_text(encoding="utf-8"))
except (OSError, UnicodeError, json.JSONDecodeError):
    print("collision")
    raise SystemExit
digest = hashlib.sha256(dump.read_bytes()).hexdigest()
size = dump.stat().st_size
if payload.get("sha256") != digest or payload.get("size") != size:
    print("unmatched")
    raise SystemExit
source = payload.get("source")
container = source.get("container") if isinstance(source, dict) else None
postgres = source.get("postgres") if isinstance(source, dict) else None
publication = payload.get("publication")
expected_publication = {
    "atomic_artifact": True,
    "exclusive": True,
    "directory_mode": "0700",
    "file_mode": "0600",
}
if (
    payload.get("schema_version") != 2
    or payload.get("type") != "postgres-docker-backup"
    or payload.get("scope") != "database"
    or payload.get("format") != "custom"
    or not isinstance(container, dict)
    or container.get("id") != expected_container
    or container.get("image_id") != expected_image
    or not isinstance(postgres, dict)
    or postgres.get("user") != "aerodb"
    or postgres.get("database") != "aerodb"
    or postgres.get("scope") != "database"
    or publication != expected_publication
):
    print("collision")
    raise SystemExit
print("candidate")
PY
}

quarantine_local_pair() {
  local reason="$1"
  python3 - "$backup_dir" "$DATABASE_BACKUP_FILE" "$DATABASE_BACKUP_MANIFEST" "$reason" <<'PY'
from datetime import datetime, timezone
import os
from pathlib import Path
import stat
import sys
import uuid

backup_dir = Path(sys.argv[1])
paths = [Path(sys.argv[2]), Path(sys.argv[3])]
reason = sys.argv[4]
quarantine = backup_dir / "canary-db-ack-backup-quarantine"
try:
    quarantine.mkdir(mode=0o700)
except FileExistsError:
    pass
metadata = quarantine.lstat()
if (
    quarantine.is_symlink()
    or not stat.S_ISDIR(metadata.st_mode)
    or stat.S_IMODE(metadata.st_mode) != 0o700
    or metadata.st_uid != os.getuid()
):
    raise SystemExit("backup quarantine directory is unsafe")
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
for path in paths:
    if not os.path.lexists(path):
        continue
    source = path.lstat()
    if (
        path.is_symlink()
        or not stat.S_ISREG(source.st_mode)
        or stat.S_IMODE(source.st_mode) != 0o600
        or source.st_uid != os.getuid()
    ):
        raise SystemExit(f"refusing to quarantine unsafe local artifact: {path}")
    destination = quarantine / (
        f"{path.name}.{reason}.{stamp}.{os.getpid()}.{uuid.uuid4().hex}"
    )
    os.link(path, destination, follow_symlinks=False)
    os.unlink(path)
    with destination.open("rb") as stream:
        os.fsync(stream.fileno())
for directory in (quarantine, backup_dir):
    fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
PY
}

pair_state="$(local_pair_state)"
case "$pair_state" in
  absent) ;;
  partial|unmatched)
    echo "Quarantining $pair_state local backup publication without deleting evidence..."
    quarantine_local_pair "$pair_state"
    ;;
  candidate) ;;
  unsafe) fail "Existing local backup publication is unsafe; refusing quarantine or overwrite." ;;
  collision) fail "Existing local backup publication is a content/provenance collision; refusing overwrite." ;;
  *) fail "Local backup publication returned an unknown state." ;;
esac

if [[ ! -e "$DATABASE_BACKUP_FILE" && ! -e "$DATABASE_BACKUP_MANIFEST" ]]; then
  python3 "$POSTGRES_BACKUP_TOOL" backup \
    --container "$POSTGRES_CONTAINER_NAME" \
    --expect-container-id "$EXPECTED_POSTGRES_CONTAINER_ID" \
    --database aerodb --user aerodb --format custom --scope database \
    --out-dir "$backup_dir" --output "$DATABASE_BACKUP_FILE"
fi

[[ "$(local_pair_state)" == "candidate" ]] || fail "Backup tool did not publish the exact expected local pair."

# A crash after backup but before strong verification leaves a valid candidate
# without the required test_restore proof. Verify only that state. Re-running
# verification after remote publication would legitimately change the manifest
# bytes and create a false GCS collision, so an exact persisted strong proof is
# reused byte-for-byte.
strong_state="$(python3 - "$DATABASE_BACKUP_FILE" "$DATABASE_BACKUP_MANIFEST" \
  "$EXPECTED_POSTGRES_CONTAINER_ID" "$EXPECTED_POSTGRES_IMAGE_ID" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

dump, manifest = map(Path, sys.argv[1:3])
expected_container, expected_image = sys.argv[3:5]
payload = json.loads(manifest.read_text(encoding="utf-8"))
source = payload.get("source", {})
postgres = source.get("postgres", {}) if isinstance(source, dict) else {}
verification = payload.get("verification")
catalog = postgres.get("catalog")
identity = verification.get("container_identity_preflight") if isinstance(verification, dict) else None
strong = (
    isinstance(catalog, dict)
    and bool(catalog)
    and isinstance(verification, dict)
    and verification.get("mode") == "test_restore"
    and verification.get("scope") == "database"
    and verification.get("sha256") == hashlib.sha256(dump.read_bytes()).hexdigest()
    and verification.get("ok") is True
    and verification.get("verification_target") == "scratch_database"
    and verification.get("catalog_signature") == catalog
    and isinstance(verification.get("verified_at"), str)
    and isinstance(identity, dict)
    and identity.get("expected_id") == expected_container
    and identity.get("actual_id") == expected_container
    and identity.get("match") == "exact_full"
    and identity.get("execution_target") == "immutable_full_id"
    and source.get("container", {}).get("image_id") == expected_image
)
print("strong" if strong else "needs-verification")
PY
)"
if [[ "$strong_state" == "needs-verification" ]]; then
  python3 "$POSTGRES_BACKUP_TOOL" verify \
    --container "$POSTGRES_CONTAINER_NAME" \
    --expect-container-id "$EXPECTED_POSTGRES_CONTAINER_ID" \
    --database aerodb --user aerodb --file "$DATABASE_BACKUP_FILE" \
    --format custom --scope database --test-restore
elif [[ "$strong_state" != "strong" ]]; then
  fail "Local strong-verification state is invalid."
fi

backup_sha="$(sha256_file "$DATABASE_BACKUP_FILE")"
manifest_sha="$(sha256_file "$DATABASE_BACKUP_MANIFEST")"
backup_size="$(stat -c '%s' "$DATABASE_BACKUP_FILE")"
manifest_size="$(stat -c '%s' "$DATABASE_BACKUP_MANIFEST")"
[[ "$backup_sha" =~ ^[0-9a-f]{64}$ && "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || fail "Local verified backup digests are invalid."
[[ "$backup_size" =~ ^[1-9][0-9]*$ && "$manifest_size" =~ ^[1-9][0-9]*$ ]] || fail "Local verified backup sizes are invalid."

# Re-read the final manifest after any strong verification and require the
# complete exact proof. This is independent of the backup tool's exit status.
python3 - "$DATABASE_BACKUP_FILE" "$DATABASE_BACKUP_MANIFEST" \
  "$EXPECTED_POSTGRES_CONTAINER_ID" "$EXPECTED_POSTGRES_IMAGE_ID" <<'PY'
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys

dump, manifest = map(Path, sys.argv[1:3])
expected_container, expected_image = sys.argv[3:5]
payload = json.loads(manifest.read_text(encoding="utf-8"))
source = payload.get("source")
container = source.get("container") if isinstance(source, dict) else None
postgres = source.get("postgres") if isinstance(source, dict) else None
verification = payload.get("verification")
identity = verification.get("container_identity_preflight") if isinstance(verification, dict) else None
digest = hashlib.sha256(dump.read_bytes()).hexdigest()
catalog = postgres.get("catalog") if isinstance(postgres, dict) else None
required = (
    payload.get("schema_version") == 2
    and payload.get("type") == "postgres-docker-backup"
    and payload.get("scope") == "database"
    and payload.get("format") == "custom"
    and payload.get("sha256") == digest
    and payload.get("size") == dump.stat().st_size
    and isinstance(container, dict)
    and container.get("id") == expected_container
    and container.get("image_id") == expected_image
    and isinstance(postgres, dict)
    and postgres.get("user") == "aerodb"
    and postgres.get("database") == "aerodb"
    and postgres.get("scope") == "database"
    and isinstance(catalog, dict)
    and bool(catalog)
    and isinstance(verification, dict)
    and verification.get("mode") == "test_restore"
    and verification.get("scope") == "database"
    and verification.get("sha256") == digest
    and verification.get("ok") is True
    and verification.get("verification_target") == "scratch_database"
    and verification.get("catalog_signature") == catalog
    and isinstance(identity, dict)
    and identity.get("expected_id") == expected_container
    and identity.get("actual_id") == expected_container
    and identity.get("match") == "exact_full"
    and identity.get("execution_target") == "immutable_full_id"
)
if not required:
    raise SystemExit("local backup lacks its exact strong verification proof")
for key in ("created_at",):
    value = payload.get(key)
    if not isinstance(value, str):
        raise SystemExit(f"local backup lacks {key}")
for value in (payload["created_at"], verification.get("verified_at")):
    if not isinstance(value, str):
        raise SystemExit("local backup timestamp is missing")
    datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
PY

object_name="${GCS_BACKUP_PREFIX}/$(basename "$DATABASE_BACKUP_FILE")-${backup_sha}.dump"
object_locator="gs://${GCS_BACKUP_BUCKET}/${object_name}"
# Verification legitimately adds proof fields to a manifest without changing
# dump bytes. Bind the manifest object name to its own digest so a prior
# same-dump/different-manifest generation cannot become a false collision.
manifest_locator="${object_locator}.${manifest_sha}.manifest.json"
work_dir="$(mktemp -d "$backup_dir/.canary-db-ack-gcs.XXXXXX")"
chmod 700 "$work_dir"
cleanup() {
  python3 - "$work_dir" "$backup_dir" <<'PY'
from pathlib import Path
import shutil
import sys

path = Path(sys.argv[1])
parent = Path(sys.argv[2]).resolve(strict=True)
if path.is_symlink() or path.parent.resolve(strict=True) != parent:
    raise SystemExit("refusing unsafe backup-hook temporary cleanup")
shutil.rmtree(path)
PY
}
trap cleanup EXIT

# Publish with generation-match=0 only when absent. Whether the object existed
# or an upload response was lost, accept it only after describe plus a
# generation-locked download whose exact SHA-256 and size match local bytes.
publish_or_reuse_gcs_object() {
  local local_file="$1" locator="$2" expected_sha="$3" expected_size="$4" label="$5"
  local metadata="$work_dir/${label}-metadata.json"
  local download="$work_dir/${label}-download"
  local described=false
  : >"$metadata"
  chmod 600 "$metadata"
  if gcloud storage objects describe "$locator" --format=json >"$metadata" 2>/dev/null; then
    described=true
  else
    : >"$metadata"
    if ! gcloud storage cp --quiet --if-generation-match=0 "$local_file" "$locator"; then
      echo "Exclusive GCS $label publication did not return success; checking for an exact committed generation..." >&2
    fi
    if gcloud storage objects describe "$locator" --format=json >"$metadata" 2>/dev/null; then
      described=true
    fi
  fi
  [[ "$described" == "true" ]] || fail "GCS $label publication is incomplete; retry will resume without replacing local evidence."

  readarray -t values < <(python3 - "$metadata" <<'PY'
import json
from pathlib import Path
import sys

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
generation = str(payload.get("generation", ""))
size = str(payload.get("size", ""))
if not generation.isdigit() or not size.isdigit():
    raise SystemExit("GCS metadata lacks exact generation/size")
print(generation)
print(size)
PY
)
  [[ "${#values[@]}" == "2" ]] || fail "Incomplete GCS $label generation metadata."
  local generation="${values[0]}" remote_size="${values[1]}"
  [[ "$remote_size" == "$expected_size" ]] || fail "GCS $label content collision: remote size differs from local verified bytes."
  : >"$download"
  chmod 600 "$download"
  gcloud storage cp --quiet --if-generation-match="$generation" "$locator" "$download" \
    || fail "Generation-locked GCS $label download failed."
  local downloaded_sha downloaded_size
  downloaded_sha="$(sha256_file "$download")"
  downloaded_size="$(stat -c '%s' "$download")"
  [[ "$downloaded_sha" == "$expected_sha" && "$downloaded_size" == "$expected_size" ]] \
    || fail "GCS $label content collision: generation-locked bytes differ from local verified bytes."
  printf '%s\n' "$generation"
}

backup_generation="$(publish_or_reuse_gcs_object "$DATABASE_BACKUP_FILE" "$object_locator" "$backup_sha" "$backup_size" backup)"
manifest_generation="$(publish_or_reuse_gcs_object "$DATABASE_BACKUP_MANIFEST" "$manifest_locator" "$manifest_sha" "$manifest_size" manifest)"

validate_receipt() {
  python3 - "$DATABASE_BACKUP_OFF_VPS_RECEIPT" "$backup_sha" "$backup_size" \
    "$manifest_sha" "$manifest_size" "$EXPECTED_POSTGRES_CONTAINER_ID" \
    "$EXPECTED_POSTGRES_IMAGE_ID" "$object_locator" "$backup_generation" \
    "$manifest_locator" "$manifest_generation" <<'PY'
from datetime import datetime
import json
import os
from pathlib import Path
import stat
import sys

path = Path(sys.argv[1])
metadata = path.lstat()
if (
    path.is_symlink()
    or not stat.S_ISREG(metadata.st_mode)
    or stat.S_IMODE(metadata.st_mode) != 0o600
    or metadata.st_uid != os.getuid()
):
    raise SystemExit("off-VPS receipt is unsafe")
payload = json.loads(path.read_text(encoding="utf-8"))
expected_top = {
    "schemaVersion",
    "purpose",
    "backupSha256",
    "backupSize",
    "backupManifestSha256",
    "backupManifestSize",
    "sourceContainerId",
    "sourceImageId",
    "destination",
    "verification",
}
if set(payload) != expected_top:
    raise SystemExit("off-VPS receipt schema is not exact")
expected = {
    "schemaVersion": 1,
    "purpose": "airfoils-pro-postgres-off-vps-copy",
    "backupSha256": sys.argv[2],
    "backupSize": int(sys.argv[3]),
    "backupManifestSha256": sys.argv[4],
    "backupManifestSize": int(sys.argv[5]),
    "sourceContainerId": sys.argv[6],
    "sourceImageId": sys.argv[7],
    "destination": {
        "scheme": "gs",
        "locator": sys.argv[8],
        "immutableVersion": sys.argv[9],
        "manifestLocator": sys.argv[10],
        "manifestImmutableVersion": sys.argv[11],
    },
}
for key, value in expected.items():
    if payload.get(key) != value:
        raise SystemExit(f"off-VPS receipt collision: {key}")
verification = payload.get("verification")
if not isinstance(verification, dict) or set(verification) != {
    "ok",
    "method",
    "sha256",
    "size",
    "manifestSha256",
    "manifestSize",
    "verifiedAt",
}:
    raise SystemExit("off-VPS receipt verification schema is not exact")
if verification != {
    "ok": True,
    "method": "remote-download-sha256",
    "sha256": sys.argv[2],
    "size": int(sys.argv[3]),
    "manifestSha256": sys.argv[4],
    "manifestSize": int(sys.argv[5]),
    "verifiedAt": verification.get("verifiedAt"),
}:
    raise SystemExit("off-VPS receipt verification collides with exact remote bytes")
value = verification.get("verifiedAt")
if not isinstance(value, str) or not value:
    raise SystemExit("off-VPS receipt verification timestamp is missing")
datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
PY
}

if [[ -e "$DATABASE_BACKUP_OFF_VPS_RECEIPT" || -L "$DATABASE_BACKUP_OFF_VPS_RECEIPT" ]]; then
  validate_receipt || fail "Existing off-VPS receipt is a content collision; refusing overwrite."
else
  # The temporary inode is created in the receipt's own parent. Hard-link
  # publication is atomic and exclusive on that filesystem; fsync covers the
  # file before publication and the parent after link/unlink. A post-link crash
  # therefore leaves either no final name or the complete exact receipt.
  python3 - "$DATABASE_BACKUP_OFF_VPS_RECEIPT" "$backup_sha" "$backup_size" \
    "$manifest_sha" "$manifest_size" "$EXPECTED_POSTGRES_CONTAINER_ID" \
    "$EXPECTED_POSTGRES_IMAGE_ID" "$object_locator" "$backup_generation" \
    "$manifest_locator" "$manifest_generation" <<'PY'
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

path = Path(sys.argv[1])
payload = {
    "schemaVersion": 1,
    "purpose": "airfoils-pro-postgres-off-vps-copy",
    "backupSha256": sys.argv[2],
    "backupSize": int(sys.argv[3]),
    "backupManifestSha256": sys.argv[4],
    "backupManifestSize": int(sys.argv[5]),
    "sourceContainerId": sys.argv[6],
    "sourceImageId": sys.argv[7],
    "destination": {
        "scheme": "gs",
        "locator": sys.argv[8],
        "immutableVersion": sys.argv[9],
        "manifestLocator": sys.argv[10],
        "manifestImmutableVersion": sys.argv[11],
    },
    "verification": {
        "ok": True,
        "method": "remote-download-sha256",
        "sha256": sys.argv[2],
        "size": int(sys.argv[3]),
        "manifestSha256": sys.argv[4],
        "manifestSize": int(sys.argv[5]),
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
    },
}
encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
temporary = Path(temporary_name)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.link(temporary, path, follow_symlinks=False)
    except FileExistsError as exc:
        raise SystemExit("off-VPS receipt collision during exclusive publication") from exc
    os.unlink(temporary)
    directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    metadata = path.lstat()
    if (
        path.is_symlink()
        or not stat.S_ISREG(metadata.st_mode)
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_uid != os.getuid()
        or path.read_bytes() != encoded
        or hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(encoded).digest()
    ):
        raise SystemExit("published off-VPS receipt bytes failed exact validation")
except BaseException:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
  validate_receipt
fi

echo "Production database backup, manifest, and immutable GCS generations ${backup_generation}/${manifest_generation} are strongly verified."
