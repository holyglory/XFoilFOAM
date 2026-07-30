#!/usr/bin/env bash
# Deliberately source-only: this helper validates and atomically persists the
# future ENGINE_URL route. It only performs a read-only Compose exec health
# proof; it never creates, restarts, or otherwise mutates services.
set -Eeuo pipefail

DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$DEPLOY_SCRIPT_DIR/switch-engine-route.py" "$@"
