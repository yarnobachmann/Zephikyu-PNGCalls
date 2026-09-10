#!/usr/bin/env bash
set -Eeuo pipefail

REPO="yarnobachmann/Zephikyu-PNGCalls"
APP_DIR="/opt/pngcalls"
NEXT_DIR="/opt/pngcalls.next"
OLD_DIR="/opt/pngcalls.previous"
NODE_BIN="/usr/local/lib/nodejs/bin/node"
NPM_CLI="/usr/local/lib/nodejs/lib/node_modules/npm/bin/npm-cli.js"
NPX_CLI="/usr/local/lib/nodejs/lib/node_modules/npm/bin/npx-cli.js"
export PATH="/usr/local/lib/nodejs/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

[[ "${EUID}" -eq 0 ]] || { echo "Run as root inside the PNGCalls LXC." >&2; exit 1; }
[[ -f /etc/systemd/system/pngcalls.service ]] || { echo "No native PNGCalls installation was found." >&2; exit 1; }
[[ -x "${NODE_BIN}" && -f "${NPM_CLI}" && -f "${NPX_CLI}" ]] || { echo "The Node.js installation is incomplete." >&2; exit 1; }

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" -o "${temp_dir}/source.tar.gz"
rm -rf "${NEXT_DIR}"
install -d -m 0755 "${NEXT_DIR}"
tar -xzf "${temp_dir}/source.tar.gz" -C "${NEXT_DIR}" --strip-components=1
cd "${NEXT_DIR}"
"${NODE_BIN}" "${NPM_CLI}" ci
"${NODE_BIN}" "${NPX_CLI}" prisma generate
"${NODE_BIN}" "${NPM_CLI}" prune --omit=dev
chown -R root:root "${NEXT_DIR}"

systemctl stop pngcalls
rm -rf "${OLD_DIR}"
mv "${APP_DIR}" "${OLD_DIR}"
mv "${NEXT_DIR}" "${APP_DIR}"

if systemctl start pngcalls; then
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:4173/api/health >/dev/null; then
      rm -rf "${OLD_DIR}"
      echo "Zephikyu PNGCalls was updated successfully."
      exit 0
    fi
    sleep 1
  done
fi

systemctl stop pngcalls || true
rm -rf "${APP_DIR}"
mv "${OLD_DIR}" "${APP_DIR}"
systemctl start pngcalls
echo "The update failed and the previous version was restored." >&2
exit 1
