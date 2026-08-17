#!/usr/bin/env bash
set -euo pipefail

backup_root="${AIRFOILS_DB_BACKUP_STAGING_DIR:-/opt/airfoils-pro/state/db-backups/gcs-staging}"
backup_tool="${AIRFOILS_DB_BACKUP_TOOL:-/opt/airfoils-pro/state/tools/postgres_docker_backup.py}"
upload_tool="${AIRFOILS_DB_UPLOAD_TOOL:-/opt/airfoils-pro/state/tools/upload-stdin-to-gcs.py}"
prune_tool="${AIRFOILS_DB_PRUNE_TOOL:-/opt/airfoils-pro/state/tools/prune-gcs-db-backups.py}"
postgres_container="${AIRFOILS_DB_POSTGRES_CONTAINER:-app-postgres-1}"
api_container="${AIRFOILS_DB_API_CONTAINER:-app-api-1}"
database_name="${AIRFOILS_DB_NAME:-aerodb}"
database_user="${AIRFOILS_DB_USER:-aerodb}"
gcs_prefix="${AIRFOILS_DB_GCS_PREFIX:-database-backups/production}"

test -f "$backup_tool"
test -f "$upload_tool"
test -f "$prune_tool"
install -d -m 0700 "$backup_root"

postgres_id="$(docker inspect --format '{{.Id}}' "$postgres_container")"
api_id="$(docker inspect --format '{{.Id}}' "$api_container")"
if [[ ! "$postgres_id" =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid immutable PostgreSQL container id" >&2
  exit 1
fi
if [[ ! "$api_id" =~ ^[0-9a-f]{64}$ ]]; then
  echo "invalid immutable API container id" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifact="$backup_root/${postgres_container}-${database_name}-${timestamp}-$$.dump"
manifest="$artifact.manifest.json"

DEVCOORDINATOR_BROKER_INTERNAL=1 DEVCOORDINATOR_BACKUP_REGISTRY=off \
  python3 "$backup_tool" backup \
  --container "$postgres_container" \
  --expect-container-id "$postgres_id" \
  --database "$database_name" \
  --user "$database_user" \
  --output "$artifact"

DEVCOORDINATOR_BROKER_INTERNAL=1 DEVCOORDINATOR_BACKUP_REGISTRY=off \
  python3 "$backup_tool" verify \
  --container "$postgres_container" \
  --expect-container-id "$postgres_id" \
  --database "$database_name" \
  --user "$database_user" \
  --file "$artifact" \
  --test-restore \
  --verification-timeout 1800

read -r artifact_size artifact_sha < <(
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["size"], d["sha256"])' "$manifest"
)
manifest_size="$(stat -c %s "$manifest")"
manifest_sha="$(sha256sum "$manifest")"
manifest_sha="${manifest_sha%% *}"

docker cp "$upload_tool" "$api_id:/tmp/upload-stdin-to-gcs.py"
docker cp "$prune_tool" "$api_id:/tmp/prune-gcs-db-backups.py"

docker exec -i "$api_id" python /tmp/upload-stdin-to-gcs.py \
  --object-key "$gcs_prefix/$(basename "$artifact")" \
  --size "$artifact_size" \
  --sha256 "$artifact_sha" \
  --content-type application/vnd.postgresql.custom < "$artifact"

docker exec -i "$api_id" python /tmp/upload-stdin-to-gcs.py \
  --object-key "$gcs_prefix/$(basename "$manifest")" \
  --size "$manifest_size" \
  --sha256 "$manifest_sha" \
  --content-type application/json < "$manifest"

docker exec "$api_id" python /tmp/prune-gcs-db-backups.py \
  --prefix "$gcs_prefix/" \
  --keep 2 \
  --execute

rm -- "$artifact" "$manifest"
echo "Database backup strongly verified, retained in GCS, and removed from VPS staging."
