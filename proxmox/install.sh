#!/usr/bin/env bash
set -Eeuo pipefail

REPO="yarnobachmann/Zephikyu-PNGCalls"
APP_DIR="/opt/pngcalls"
STATE_DIR="/var/lib/pngcalls"
CONFIG_DIR="/etc/pngcalls"
DOMAIN="${PNGCALLS_DOMAIN:-}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl jq xz-utils tar caddy

case "$(dpkg --print-architecture)" in
  amd64) node_arch="x64" ;;
  arm64) node_arch="arm64" ;;
  *) echo "Unsupported CPU architecture." >&2; exit 1 ;;
esac

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
node_version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v22."))][0].version')"
[[ -n "${node_version}" ]] || { echo "Could not determine the current Node.js 22 release." >&2; exit 1; }
node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
curl -fsSL "https://nodejs.org/dist/${node_version}/${node_archive}" -o "${temp_dir}/${node_archive}"
curl -fsSL "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o "${temp_dir}/SHASUMS256.txt"
(cd "${temp_dir}" && grep " ${node_archive}$" SHASUMS256.txt | sha256sum -c -)
rm -rf /usr/local/lib/nodejs
install -d /usr/local/lib/nodejs
tar -xJf "${temp_dir}/${node_archive}" -C /usr/local/lib/nodejs --strip-components=1
ln -sfn /usr/local/lib/nodejs/bin/node /usr/local/bin/node
ln -sfn /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
ln -sfn /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
NODE_BIN="/usr/local/lib/nodejs/bin/node"
NPM_CLI="/usr/local/lib/nodejs/lib/node_modules/npm/bin/npm-cli.js"
NPX_CLI="/usr/local/lib/nodejs/lib/node_modules/npm/bin/npx-cli.js"
export PATH="/usr/local/lib/nodejs/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ -x "${NODE_BIN}" && -f "${NPM_CLI}" && -f "${NPX_CLI}" ]] || {
  echo "The Node.js installation is incomplete." >&2
  exit 1
}

id pngcalls >/dev/null 2>&1 || useradd --system --home "${STATE_DIR}" --shell /usr/sbin/nologin pngcalls
install -d -m 0750 -o pngcalls -g pngcalls "${STATE_DIR}/data" "${STATE_DIR}/uploads"
install -d -m 0750 -o root -g pngcalls "${CONFIG_DIR}"

curl -fsSL "https://github.com/${REPO}/archive/refs/heads/main.tar.gz" -o "${temp_dir}/source.tar.gz"
rm -rf "${APP_DIR}"
install -d -m 0755 "${APP_DIR}"
tar -xzf "${temp_dir}/source.tar.gz" -C "${APP_DIR}" --strip-components=1
cd "${APP_DIR}"
"${NODE_BIN}" "${NPM_CLI}" ci
"${NODE_BIN}" "${NPX_CLI}" prisma generate
"${NODE_BIN}" "${NPM_CLI}" prune --omit=dev
chown -R root:root "${APP_DIR}"

if [[ -n "${DOMAIN}" ]]; then
  public_url="https://${DOMAIN}"
  site_address="${DOMAIN}"
else
  container_ip="$(hostname -I | awk '{print $1}')"
  public_url="http://${container_ip}"
  site_address=":80"
fi

cat > "${CONFIG_DIR}/pngcalls.env" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
PUBLIC_URL=${public_url}
DATA_DIR=${STATE_DIR}/data
UPLOAD_DIR=${STATE_DIR}/uploads
DATABASE_URL=file:${STATE_DIR}/data/zephikyu.db
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=${public_url}/auth/discord/callback
EOF
chmod 0640 "${CONFIG_DIR}/pngcalls.env"
chown root:pngcalls "${CONFIG_DIR}/pngcalls.env"

cat > /etc/systemd/system/pngcalls.service <<EOF
[Unit]
Description=Zephikyu PNGCalls
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pngcalls
Group=pngcalls
WorkingDirectory=${APP_DIR}
EnvironmentFile=${CONFIG_DIR}/pngcalls.env
Environment=PATH=/usr/local/lib/nodejs/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NODE_BIN} ${NPM_CLI} start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
${site_address} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:4173
  header -Server
}
EOF

systemctl daemon-reload
systemctl enable --now pngcalls
systemctl enable --now caddy
systemctl restart caddy

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4173/api/health >/dev/null; then
    exit 0
  fi
  sleep 1
done

journalctl -u pngcalls --no-pager -n 80
echo "PNGCalls did not become healthy." >&2
exit 1
