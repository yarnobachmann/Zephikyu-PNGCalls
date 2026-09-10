#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root inside the Debian LXC."
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DOMAIN="${PNGCALLS_DOMAIN:-}"

if [[ -z "${DOMAIN}" ]]; then
  echo "Set PNGCALLS_DOMAIN before running this installer."
  echo "Example: PNGCALLS_DOMAIN=pngcalls.example.com bash scripts/install-proxmox-lxc.sh"
  exit 1
fi

if [[ ! -f "${APP_DIR}/compose.proxmox.yaml" ]]; then
  echo "Run this script from the PNGCalls project copied into the container."
  exit 1
fi

. /etc/os-release
if [[ "${ID:-}" != "debian" ]]; then
  echo "This installer supports Debian 12 and 13 containers."
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

install -d -m 0750 -o 1000 -g 1000 "${APP_DIR}/data" "${APP_DIR}/uploads"
umask 077
cat > "${APP_DIR}/.env.proxmox" <<EOF
PNGCALLS_DOMAIN=${DOMAIN}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID:-}
DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET:-}
DISCORD_REDIRECT_URI=${DISCORD_REDIRECT_URI:-https://${DOMAIN}/auth/discord/callback}
EOF

cd "${APP_DIR}"
docker compose --env-file .env.proxmox -f compose.proxmox.yaml up -d --build
docker compose --env-file .env.proxmox -f compose.proxmox.yaml ps

echo "PNGCalls is installed at https://${DOMAIN}"
echo "Keep ports 80 and 443 forwarded to this container and back up data plus uploads together."
