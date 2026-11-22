#!/bin/bash
# Fixture transport. Only these exact docker exec commands reach local test processes.
set -eu
host="${@: -2:1}"
remote="${!#}"
hub='/app/apps/sweeper/src/hz-point-history-hub.ts'
worker='/app/apps/sweeper/src/hz-point-history-custody-cli.ts'
api='/app/apps/api/src/hz-point-history-verify-cli.ts'
cd "$HISTORY_TEST_REPO"
case "$host $remote" in
  "fixture-hub docker exec -i hub-worker node --import tsx $hub")
    export AIRFOILFOAM_DEPLOYMENT_ROLE=hub AIRFOILFOAM_EVIDENCE_BUCKET=fixture-bucket
    exec "$HISTORY_TEST_NODE" --import tsx apps/sweeper/test/fixtures/hz-history-hub.ts ;;
  "fixture-hz docker exec -i hz-worker node --import tsx $worker")
    export AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver
    exec "$HISTORY_TEST_NODE" --import tsx "${worker#/app/}" ;;
  "fixture-hz flock -s -w 15 -E 75 /tmp/airfoils-pro-deploy.lock docker exec -i hz-worker node --import tsx $worker")
    export AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver
    exec flock -s "$HISTORY_TEST_STATE/deploy.lock" "$HISTORY_TEST_NODE" --import tsx "${worker#/app/}" ;;
  "fixture-hz docker exec -i hz-api node --import tsx $api")
    export AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver
    if test -f "$HISTORY_TEST_STATE/hide-volume"; then export MEDIA_DIR="$HISTORY_TEST_STATE/unmounted"; fi
    exec "$HISTORY_TEST_NODE" --import tsx "${api#/app/}" ;;
  *) echo 'Invalid fixture SSH command' >&2; exit 2 ;;
esac
