#!/usr/bin/env bash
set -Eeuo pipefail

ENV_FILE="/etc/pngcalls/pngcalls.env"
[[ "${EUID}" -eq 0 ]] || { echo "Run as root inside the PNGCalls LXC." >&2; exit 1; }
[[ -f "${ENV_FILE}" ]] || { echo "No native PNGCalls installation was found." >&2; exit 1; }

current_value() {
  sed -n "s/^$1=//p" "${ENV_FILE}" | head -n 1
}

current_public="$(current_value PUBLIC_URL)"
current_domain=""
if [[ "${current_public}" == https://* ]]; then
  current_domain="${current_public#https://}"
fi

read -r -p "Public domain [${current_domain:-local HTTP}]: " domain
domain="${domain:-$current_domain}"
if [[ -n "${domain}" ]] && [[ ! "${domain}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])$ ]]; then
  echo "The domain name is not valid." >&2
  exit 1
fi

client_id="$(current_value DISCORD_CLIENT_ID)"
client_secret="$(current_value DISCORD_CLIENT_SECRET)"

if [[ -n "${domain}" ]]; then
  public_url="https://${domain}"
  site_address="${domain}"
else
  container_ip="$(hostname -I | awk '{print $1}')"
  public_url="http://${container_ip}"
  site_address=":80"
fi

umask 027
cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
PUBLIC_URL=${public_url}
DATA_DIR=/var/lib/pngcalls/data
UPLOAD_DIR=/var/lib/pngcalls/uploads
DATABASE_URL=file:/var/lib/pngcalls/data/zephikyu.db
DISCORD_CLIENT_ID=${client_id}
DISCORD_CLIENT_SECRET=${client_secret}
DISCORD_REDIRECT_URI=${public_url}/auth/discord/callback
EOF
chown root:pngcalls "${ENV_FILE}"

cat > /etc/caddy/Caddyfile <<EOF
${site_address} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:4173
  header -Server
}
EOF

systemctl restart pngcalls
systemctl restart caddy
echo "PNGCalls configuration was updated."
echo "Address: ${public_url}"
echo "Configure Discord from the host Settings page."
