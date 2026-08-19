#!/usr/bin/env bash
# Snapshot the dbmanager_data docker volume (saved-connections.json + server-keypair.json)
# to a host directory with rotation. Run from server via cron.
#
# The data is ALREADY encrypted at rest (AES-256-GCM); this just guards against
# volume loss. To restore: extract the tar into the volume mount.
#
# Install (on server, one-time):
#   crontab -e
#   0 3 * * *  /opt/dbmanager/deploy/backup-data.sh >> /var/log/dbmanager-backup.log 2>&1
#
# Optional off-box: set BACKUP_RSYNC_DEST=user@host:/path to also rsync the latest tar.

set -euo pipefail

VOLUME="${DBM_VOLUME:-dbmanager_dbmanager_data}"   # compose-prefixed volume name
DEST="${DBM_BACKUP_DIR:-/opt/dbmanager-backups}"
KEEP="${DBM_BACKUP_KEEP:-14}"
TS="$(date +%Y%m%d-%H%M%S)"

if ! command -v docker >/dev/null 2>&1; then echo "docker not found"; exit 1; fi

# Verify the volume exists (fall back to un-prefixed name).
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  if docker volume inspect dbmanager_data >/dev/null 2>&1; then VOLUME=dbmanager_data; else
    echo "Volume not found ($VOLUME / dbmanager_data)"; exit 1; fi
fi

mkdir -p "$DEST"
OUT="$DEST/dbmanager-data-${TS}.tar.gz"

# Tar the volume contents via a throwaway alpine container (read-only mount).
docker run --rm -v "${VOLUME}:/data:ro" -v "${DEST}:/backup" alpine \
  sh -c "tar -czf /backup/$(basename "$OUT") -C /data . "

chmod 600 "$OUT"
echo "[$(date -Is)] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Rotation: keep newest $KEEP.
ls -1t "$DEST"/dbmanager-data-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old" && echo "[$(date -Is)] pruned $old"
done

# Optional off-box copy.
if [[ -n "${BACKUP_RSYNC_DEST:-}" ]]; then
  rsync -az "$OUT" "$BACKUP_RSYNC_DEST/" && echo "[$(date -Is)] rsynced to $BACKUP_RSYNC_DEST"
fi
