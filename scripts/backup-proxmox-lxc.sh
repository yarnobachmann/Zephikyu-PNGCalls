#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${1:-/var/backups/pngcalls}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/pngcalls-${STAMP}.tar.gz"
COMPOSE=(docker compose --env-file .env.proxmox -f compose.proxmox.yaml)

cd "${APP_DIR}"
install -d -m 0750 "${BACKUP_DIR}"

restart_app() {
  "${COMPOSE[@]}" start pngcalls >/dev/null 2>&1 || true
}
trap restart_app EXIT

"${COMPOSE[@]}" stop pngcalls
tar -czf "${ARCHIVE}" data uploads .env.proxmox
sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"
restart_app
trap - EXIT

echo "Backup created: ${ARCHIVE}"
