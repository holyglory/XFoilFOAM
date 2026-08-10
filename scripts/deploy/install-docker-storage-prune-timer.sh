#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SBIN_DIR="${SBIN_DIR:-/usr/local/sbin}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 2
fi

install -D -m 0755 \
  "$SCRIPT_DIR/airfoils-docker-storage-prune" \
  "$SBIN_DIR/airfoils-docker-storage-prune"
install -D -m 0644 \
  "$SCRIPT_DIR/airfoils-docker-storage-prune.service" \
  "$SYSTEMD_DIR/airfoils-docker-storage-prune.service"
install -D -m 0644 \
  "$SCRIPT_DIR/airfoils-docker-storage-prune.timer" \
  "$SYSTEMD_DIR/airfoils-docker-storage-prune.timer"

systemd-analyze verify \
  "$SYSTEMD_DIR/airfoils-docker-storage-prune.service" \
  "$SYSTEMD_DIR/airfoils-docker-storage-prune.timer"
systemctl daemon-reload
systemctl enable --now airfoils-docker-storage-prune.timer
systemctl --no-pager status airfoils-docker-storage-prune.timer
