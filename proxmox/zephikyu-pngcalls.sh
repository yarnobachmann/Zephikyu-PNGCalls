#!/usr/bin/env bash
set -Eeuo pipefail

REPO_RAW="https://raw.githubusercontent.com/yarnobachmann/Zephikyu-PNGCalls/main"
APP="Zephikyu PNGCalls"

red='\033[0;31m'
green='\033[0;32m'
cyan='\033[0;36m'
reset='\033[0m'

die() {
  echo -e "${red}Error: $*${reset}" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]] || ! command -v pct >/dev/null 2>&1; then
  die "Run this command as root in the Proxmox VE host shell."
fi
command -v curl >/dev/null 2>&1 || die "curl is required on the Proxmox host."

if [[ "${1:-}" == "update" ]]; then
  ctid="${2:-}"
  if [[ -z "${ctid}" ]]; then
    read -r -p "Container ID to update: " ctid
  fi
  pct status "${ctid}" >/dev/null 2>&1 || die "Container ${ctid} was not found."
  pct start "${ctid}" >/dev/null 2>&1 || true
  update_file="$(mktemp)"
  trap 'rm -f "${update_file:-}"' EXIT
  curl -fsSL "${REPO_RAW}/proxmox/update.sh" -o "${update_file}"
  pct push "${ctid}" "${update_file}" /root/pngcalls-update.sh --perms 0750
  pct exec "${ctid}" -- bash /root/pngcalls-update.sh
  exit 0
fi

if [[ "${1:-}" == "configure" ]]; then
  ctid="${2:-}"
  if [[ -z "${ctid}" ]]; then
    read -r -p "Container ID to configure: " ctid
  fi
  pct status "${ctid}" >/dev/null 2>&1 || die "Container ${ctid} was not found."
  pct start "${ctid}" >/dev/null 2>&1 || true
  config_file="$(mktemp)"
  trap 'rm -f "${config_file:-}"' EXIT
  curl -fsSL "${REPO_RAW}/proxmox/configure.sh" -o "${config_file}"
  pct push "${ctid}" "${config_file}" /root/pngcalls-configure.sh --perms 0750
  pct exec "${ctid}" -- bash /root/pngcalls-configure.sh
  exit 0
fi

echo -e "${cyan}${APP} Proxmox LXC installer${reset}"
echo "1) Default setup"
echo "2) Advanced setup"
read -r -p "Choose [1]: " setup_mode
setup_mode="${setup_mode:-1}"

ctid="$(pvesh get /cluster/nextid)"
hostname="pngcalls"
cores="1"
ram="1024"
swap="512"
disk="8"
bridge="$(ip -o link show | awk -F': ' '$2 ~ /^vmbr/ {print $2; exit}')"
root_storage="$(pvesm status -content rootdir 2>/dev/null | awk 'NR > 1 && $3 == "active" {print $1; exit}')"
template_storage="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR > 1 && $3 == "active" {print $1; exit}')"
ip_config="dhcp"
gateway=""

[[ -n "${bridge}" ]] || die "No vmbr network bridge was found."
[[ -n "${root_storage}" ]] || die "No active container storage was found."
[[ -n "${template_storage}" ]] || die "No active template storage was found."

if [[ "${setup_mode}" == "2" ]]; then
  read -r -p "Container ID [${ctid}]: " value; ctid="${value:-$ctid}"
  read -r -p "Hostname [${hostname}]: " value; hostname="${value:-$hostname}"
  read -r -p "CPU cores [${cores}]: " value; cores="${value:-$cores}"
  read -r -p "RAM in MB [${ram}]: " value; ram="${value:-$ram}"
  read -r -p "Swap in MB [${swap}]: " value; swap="${value:-$swap}"
  read -r -p "Disk in GB [${disk}]: " value; disk="${value:-$disk}"
  read -r -p "Network bridge [${bridge}]: " value; bridge="${value:-$bridge}"
  read -r -p "Root storage [${root_storage}]: " value; root_storage="${value:-$root_storage}"
  read -r -p "IPv4 address with CIDR, or dhcp [dhcp]: " value; ip_config="${value:-dhcp}"
  if [[ "${ip_config}" != "dhcp" ]]; then
    read -r -p "IPv4 gateway: " gateway
    [[ -n "${gateway}" ]] || die "A gateway is required for a static address."
  fi
elif [[ "${setup_mode}" != "1" ]]; then
  die "Choose 1 or 2."
fi

read -r -p "Public domain for automatic HTTPS, or leave blank for local HTTP: " domain
if [[ -n "${domain}" ]] && [[ ! "${domain}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])$ ]]; then
  die "The domain name is not valid."
fi

pct status "${ctid}" >/dev/null 2>&1 && die "Container ID ${ctid} is already in use."

echo -e "${cyan}Downloading the Debian container template${reset}"
pveam update >/dev/null
template="$(pveam available --section system | awk '$2 ~ /debian-13-standard/ {print $2}' | tail -n 1)"
if [[ -z "${template}" ]]; then
  template="$(pveam available --section system | awk '$2 ~ /debian-12-standard/ {print $2}' | tail -n 1)"
fi
[[ -n "${template}" ]] || die "No Debian 12 or 13 template is available."
template_path="$(pvesm path "${template_storage}:vztmpl/${template}" 2>/dev/null || true)"
if [[ -z "${template_path}" || ! -f "${template_path}" ]]; then
  pveam download "${template_storage}" "${template}" >/dev/null
fi

net0="name=eth0,bridge=${bridge},ip=${ip_config}"
if [[ -n "${gateway}" ]]; then
  net0="${net0},gw=${gateway}"
fi

echo -e "${cyan}Creating container ${ctid}${reset}"
pct create "${ctid}" "${template_storage}:vztmpl/${template}" \
  --hostname "${hostname}" \
  --cores "${cores}" \
  --memory "${ram}" \
  --swap "${swap}" \
  --rootfs "${root_storage}:${disk}" \
  --net0 "${net0}" \
  --unprivileged 1 \
  --onboot 1
pct start "${ctid}"

echo -e "${cyan}Installing ${APP} inside the container${reset}"
network_ready="false"
for _ in $(seq 1 60); do
  if pct exec "${ctid}" -- getent hosts github.com >/dev/null 2>&1; then
    network_ready="true"
    break
  fi
  sleep 2
done
[[ "${network_ready}" == "true" ]] || die "The new container could not reach the internet."
install_file="$(mktemp)"
trap 'rm -f "${install_file:-}"' EXIT
curl -fsSL "${REPO_RAW}/proxmox/install.sh" -o "${install_file}"
pct push "${ctid}" "${install_file}" /root/pngcalls-install.sh --perms 0750
pct exec "${ctid}" -- env PNGCALLS_DOMAIN="${domain}" bash /root/pngcalls-install.sh

container_ip="$(pct exec "${ctid}" -- hostname -I | awk '{print $1}')"
if [[ -n "${domain}" ]]; then
  access_url="https://${domain}"
else
  access_url="http://${container_ip}"
fi

trap - EXIT
rm -f "${install_file}"
echo -e "${green}${APP} was installed successfully.${reset}"
echo "Container ID: ${ctid}"
echo "Address: ${access_url}"
echo "Update later with: bash -c \"\$(curl -fsSL ${REPO_RAW}/proxmox/zephikyu-pngcalls.sh)\" -- update ${ctid}"
echo "Configure later with: bash -c \"\$(curl -fsSL ${REPO_RAW}/proxmox/zephikyu-pngcalls.sh)\" -- configure ${ctid}"
if [[ -z "${domain}" ]]; then
  echo "Camera and microphone access need HTTPS. Add a domain with the configure command before inviting remote players."
fi
