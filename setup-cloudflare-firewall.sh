#!/usr/bin/env bash
# Restrict inbound 80/443 to Cloudflare IP ranges only.
# Run as root on the server (or via sudo).
#
# !!!! SHARED-SERVER WARNING !!!!
#   This affects ALL apps on the box, not just DatabaseManager. If you host
#   other services on the same server that need direct (non-CF) access
#   (e.g. cron-curl, monitoring probes, partner integrations), running this
#   will break them. Confirm before executing.
#
# CAUTION:
#   - Verify you have SSH access via a non-80/443 port BEFORE running.
#   - This script enables UFW; existing rules may change.
#
# Usage:  sudo bash setup-cloudflare-firewall.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (e.g. sudo bash $0)" >&2
  exit 1
fi

# 1. Ensure ufw is installed.
if ! command -v ufw >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y ufw
  else
    echo "Install ufw manually for your distro." >&2
    exit 1
  fi
fi

# 2. Keep SSH accessible. Adjust port if you use a non-standard one.
ufw allow OpenSSH || ufw allow 22/tcp

# 3. Default deny + reset any previous CF rules to avoid duplicates.
ufw default deny incoming
ufw default allow outgoing

# Wipe previous CF allow rules (best-effort).
ufw status numbered | awk -F'[][]' '/ALLOW IN/ && /Cloudflare/ {print $2}' \
  | sort -rn | while read -r n; do yes | ufw delete "$n" || true; done

# 4. Allow current Cloudflare IPv4 + IPv6 ranges.
fetch() { curl -fsSL --max-time 15 "$1"; }

CF_V4=$(fetch https://www.cloudflare.com/ips-v4)
CF_V6=$(fetch https://www.cloudflare.com/ips-v6 || true)

if [[ -z "$CF_V4" ]]; then
  echo "Failed to fetch Cloudflare IPv4 list" >&2
  exit 1
fi

while IFS= read -r ip; do
  [[ -z "$ip" ]] && continue
  ufw allow proto tcp from "$ip" to any port 80  comment "Cloudflare"
  ufw allow proto tcp from "$ip" to any port 443 comment "Cloudflare"
done <<< "$CF_V4"

if [[ -n "$CF_V6" ]]; then
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    ufw allow proto tcp from "$ip" to any port 80  comment "Cloudflare"
    ufw allow proto tcp from "$ip" to any port 443 comment "Cloudflare"
  done <<< "$CF_V6"
fi

# 5. Enable & report.
ufw --force enable
ufw status verbose
echo
echo "Done. Cloudflare-only ingress is active on 80/443."
echo "Re-run this script periodically (or via cron) to track CF IP changes."
