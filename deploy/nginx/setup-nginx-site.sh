#!/usr/bin/env bash
# ⚠️ DEPRECATED — Server 62.238.28.106 was deleted 2026-06-04.
# This script is kept for reference only. Current deployment is on mcp-80 (65.108.62.80).
# See CLAUDE.md for current deployment instructions.
#
# Legacy usage (62.238.28.106 — no longer available):
#   bash /opt/dbmanager/deploy/nginx/setup-nginx-site.sh

set -euo pipefail

SITE_NAME="DBManager.allin1site.com"
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_CONF="$REPO_DIR/deploy/nginx/${SITE_NAME}.conf"
DST_AVAIL="/etc/nginx/sites-available/${SITE_NAME}.conf"
# NOTE: `zzz-` prefix on the enabled symlink so this site loads LAST in
# `include /etc/nginx/sites-enabled/*` glob order. Prevents this site from
# being picked as the implicit default-server for HTTPS requests whose
# `server_name` doesn't match any block (which would shadow other domains
# like xiangqi.games-core.com that only have `listen 80`).
DST_ENABLED="/etc/nginx/sites-enabled/zzz-${SITE_NAME}.conf"
LEGACY_ENABLED="/etc/nginx/sites-enabled/${SITE_NAME}.conf"
CERT_PEM="/etc/ssl/certs/dbmanager.pem"
CERT_KEY="/etc/ssl/private/dbmanager.key"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ ! -f "$SRC_CONF" ]]; then
  echo "Missing $SRC_CONF" >&2
  exit 1
fi

# 1. Generate self-signed cert (CF Full SSL trusts any cert at origin; not Full-Strict).
if [[ ! -f "$CERT_PEM" || ! -f "$CERT_KEY" ]]; then
  echo "[..] Generating self-signed cert at $CERT_PEM"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$CERT_KEY" \
    -out "$CERT_PEM" \
    -subj "/CN=${SITE_NAME}/O=allin1site/C=VN" \
    -addext "subjectAltName=DNS:${SITE_NAME}"
  chmod 600 "$CERT_KEY"
  chmod 644 "$CERT_PEM"
else
  echo "[ok] Cert already exists, skipping generation."
fi

# 2. Install nginx config (copy, not symlink, so future repo updates are explicit).
echo "[..] Installing nginx config -> $DST_AVAIL"
cp "$SRC_CONF" "$DST_AVAIL"

# 3. Enable site (symlink). Remove any legacy non-prefixed symlink first.
if [[ -L "$LEGACY_ENABLED" ]]; then
  rm -f "$LEGACY_ENABLED"
  echo "[ok] Removed legacy symlink without zzz- prefix."
fi
if [[ ! -L "$DST_ENABLED" ]]; then
  ln -s "$DST_AVAIL" "$DST_ENABLED"
  echo "[ok] Enabled site as $(basename "$DST_ENABLED") (loads last)."
else
  echo "[ok] Site already enabled."
fi

# 4. Test + reload.
echo "[..] nginx -t"
nginx -t

echo "[..] reloading nginx"
systemctl reload nginx

echo
echo "[ok] $SITE_NAME ready."
echo "    Cert:    $CERT_PEM"
echo "    Conf:    $DST_AVAIL"
echo "    Upstream: 127.0.0.1:9230"
