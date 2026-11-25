#!/usr/bin/env bash
# Restore one exact registered ordinary member on the HZ volume. Run on the HZ host.
set -euo pipefail
if [[ $# -ne 9 || ! $1 =~ ^[0-9a-f]{40}$ || ! $2 =~ ^[0-9a-f]{64}$ ]]; then
  echo "Usage: $0 <serving-revision> <sweeper-container-id> <verify|restore> <job> <relative-path> <plan-sha> <member-sha> <bytes> <generation>" >&2
  exit 2
fi
serving=$1
sweeper=$2
shift 2
exec 9</tmp/airfoils-pro-deploy.lock
flock --shared --nonblock 9 || exit 12
python3 - "$serving" <<'PY'
import json,sys
from pathlib import Path
if json.loads(Path("/opt/airfoils-pro/app/.deployment-source.json").read_bytes()).get("sourceRevision") != sys.argv[1]:
    raise SystemExit("Serving HZ source changed")
PY
actual=$(docker inspect --format '{{.Id}} {{.State.Running}} {{index .Config.Labels "com.docker.compose.service"}}' hz-solver2-sweeper-1)
[[ "$actual" == "$sweeper true sweeper" ]] || { echo "Installed HZ sweeper changed" >&2; exit 12; }
docker exec -e PYTHONPATH=/app/src "$sweeper" /opt/airfoilfoam-retention/bin/python -B -m airfoilfoam.working_file_recovery "$@"
