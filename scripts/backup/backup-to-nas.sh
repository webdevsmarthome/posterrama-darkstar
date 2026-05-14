#!/bin/bash
#
# backup-to-nas.sh  (Template — nach /usr/local/bin/posterrama-backup-to-nas.sh installieren)
#
# Täglicher Mirror des Posterrama-Verzeichnisses auf ein SMB-Share (Synology-
# oder anderes NAS). Läuft als Systemd-System-Service mit root-Rechten für den
# CIFS-Mount. Strategie: strikter rsync-Mirror (`--delete`), Versionierung
# übernimmt das NAS via Snapshots (z. B. Synology Snapshot Replication).
#
# Mehrere NAS-Kandidaten in NAS_CANDIDATES (Failover-Reihenfolge). Das erste
# erreichbare wird genutzt — sind alle offline, wird das Backup stumm
# übersprungen. Credentials sind für alle Kandidaten identisch (gleicher
# Backup-User auf jedem NAS).
#
# Voraussetzungen:
#  - cifs-utils + rsync installiert (Debian: `sudo apt install cifs-utils rsync`)
#  - Credentials-Datei /etc/posterrama/nas-credentials (chmod 600, root:root):
#        username=bkpuser
#        password=***
#  - Systemd-Unit + Timer aus scripts/backup/systemd/
#
# Verhalten bei NAS-Offline: stumm überspringen (journal-Log, exit 0).

set -u

# ----------------------------------------------------------------------
# NAS-Ziele (in Prioritäts-Reihenfolge). Erstes erreichbares wird genutzt.
# Format: "Name|Host" — Share-Name `backup` muss auf allen NAS identisch sein.
# Credentials liegen einmalig in /etc/posterrama/nas-credentials und gelten
# für alle gelisteten NAS-Hosts (gleicher Backup-User auf jedem Kandidaten).
#
# Lokale Anpassung: Werte vor dem Deploy nach /usr/local/bin/ anpassen.
# Beispiel-Setup mit zwei NAS auf verschiedenen Subnetzen — Hostnames oder
# IP-Adressen sind zulässig (mDNS `.local` setzt voraus, dass Avahi läuft).
# ----------------------------------------------------------------------
NAS_CANDIDATES=(
    "Primary|nas-primary.local"
    "Backup|nas-secondary.local"
)
NAS_REMOTE_SUBDIR="posterrama"
SRC="/home/helmut/posterrama"
CREDS_FILE="/etc/posterrama/nas-credentials"
MOUNT_POINT="/mnt/posterrama-nas-backup"

log() {
    logger -t posterrama-backup "$*"
    echo "[posterrama-backup] $*"
}

cleanup() {
    mountpoint -q "$MOUNT_POINT" && umount "$MOUNT_POINT" 2>/dev/null
    rmdir "$MOUNT_POINT" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------
# Online-Check über alle Kandidaten — erstes erreichbares NAS gewinnt.
# Wenn keines erreichbar: stumm überspringen.
# ----------------------------------------------------------------------
NAS_HOST=""
NAS_NAME=""
for entry in "${NAS_CANDIDATES[@]}"; do
    cand_name="${entry%%|*}"
    cand_host="${entry##*|}"
    if ! ping -c 1 -W 3 "$cand_host" >/dev/null 2>&1; then
        log "$cand_name ($cand_host) nicht erreichbar (ping) — probiere nächstes Ziel"
        continue
    fi
    if ! timeout 3 bash -c "</dev/tcp/$cand_host/445" 2>/dev/null; then
        log "$cand_name ($cand_host) SMB-Port 445 nicht erreichbar — probiere nächstes Ziel"
        continue
    fi
    NAS_HOST="$cand_host"
    NAS_NAME="$cand_name"
    log "Backup-Ziel: $NAS_NAME ($NAS_HOST)"
    break
done

if [ -z "$NAS_HOST" ]; then
    log "Kein NAS aus Kandidatenliste erreichbar — Backup übersprungen"
    exit 0
fi

NAS_SHARE="//$NAS_HOST/backup"

# ----------------------------------------------------------------------
# Credentials-Check
# ----------------------------------------------------------------------
if [ ! -f "$CREDS_FILE" ]; then
    log "Credentials-Datei $CREDS_FILE fehlt — Backup abgebrochen"
    exit 1
fi
if [ "$(stat -c '%a' "$CREDS_FILE")" != "600" ]; then
    log "Warnung: Credentials-Datei hat unsichere Permissions (sollte 600 sein)"
fi

# ----------------------------------------------------------------------
# Mount
# ----------------------------------------------------------------------
mkdir -p "$MOUNT_POINT"
# WICHTIG: `rw` explizit setzen; `ro=false` ist KEIN gültiger CIFS-Parameter
# und wird von manchen mount.cifs-Versionen als `ro` interpretiert.
if ! mount -t cifs "$NAS_SHARE" "$MOUNT_POINT" \
    -o "credentials=$CREDS_FILE,uid=root,gid=root,iocharset=utf8,vers=3.0,rw,hard,retrans=5,actimeo=30,echo_interval=30" \
    2>/dev/null; then
    log "CIFS-Mount fehlgeschlagen — Backup übersprungen"
    exit 0
fi

# Target-Subdir sicherstellen
mkdir -p "$MOUNT_POINT/$NAS_REMOTE_SUBDIR"

# ----------------------------------------------------------------------
# Rsync (strikter Mirror; Synology-Snapshots puffern Versionen)
#
# Zwei separate rsync-Calls:
#  1. Alles AUSSER media/ — mit `--modify-window=2` für CIFS-mtime-Toleranz.
#     SMB rundet mtimes auf 1–2 Sek; ohne Window würde rsync identische Files
#     als geändert sehen und neu übertragen.
#  2. media/ separat mit `--size-only` — die ZIPs (PosterPacks) und MP4s
#     (Trailer) sind immutable; ihre Bytes-Größe ist eindeutig. Das spart auf
#     einem 41-GB-Bestand mehrere zehn Minuten WLAN-Zeit pro Lauf.
#     Theoretisches Restrisiko: eine JSON in media/ ändert sich, ohne dass
#     ihre Bytegröße variiert — extrem unwahrscheinlich für unsere
#     trailer-info.json / *.poster.json Strukturen.
# ----------------------------------------------------------------------
START=$(date +%s)
log "Starte rsync zu $NAS_NAME:$NAS_SHARE/$NAS_REMOTE_SUBDIR/"

# Call 1: Alles außer media/
rsync -aH --delete --partial --timeout=600 --modify-window=2 \
    --exclude='media/' \
    --exclude='node_modules/' \
    --exclude='cache/' \
    --exclude='logs/' \
    --exclude='coverage/' \
    --exclude='sessions/' \
    --exclude='image_cache/' \
    --exclude='.nyc_output/' \
    --exclude='__tests__/' \
    --exclude='poster-updater/tmp_*/' \
    --exclude='*.tmp' \
    --exclude='*.tmp.*' \
    --exclude='.git/' \
    --exclude='device-updates/' \
    --exclude='*.log' \
    "$SRC/" "$MOUNT_POINT/$NAS_REMOTE_SUBDIR/" 2>&1 | tail -20 | \
    while IFS= read -r line; do log "rsync[code]: $line"; done
RC1=${PIPESTATUS[0]}

# Call 2: media/ — size-only-Vergleich für die unveränderlichen ZIP/MP4-Files
mkdir -p "$MOUNT_POINT/$NAS_REMOTE_SUBDIR/media"
rsync -aH --delete --partial --timeout=600 --modify-window=2 --size-only \
    "$SRC/media/" "$MOUNT_POINT/$NAS_REMOTE_SUBDIR/media/" 2>&1 | tail -20 | \
    while IFS= read -r line; do log "rsync[media]: $line"; done
RC2=${PIPESTATUS[0]}

END=$(date +%s)
DURATION=$((END - START))

# Worst-case RC ermitteln (24 = vanished files, harmlos)
if [ "$RC1" -ne 0 ] && [ "$RC1" -ne 24 ]; then
    log "rsync[code] exit-code $RC1 — möglicherweise unvollständig (Dauer ${DURATION}s)"
elif [ "$RC2" -ne 0 ] && [ "$RC2" -ne 24 ]; then
    log "rsync[media] exit-code $RC2 — möglicherweise unvollständig (Dauer ${DURATION}s)"
elif [ "$RC1" -eq 24 ] || [ "$RC2" -eq 24 ]; then
    log "Backup nach $NAS_NAME fertig in ${DURATION}s (mit vanished files, harmlos)"
else
    log "Backup nach $NAS_NAME fertig in ${DURATION}s"
fi

# Snapshot-Info
if [ -d "$MOUNT_POINT/@GlobalSnap" ] || [ -d "$MOUNT_POINT/#snapshot" ]; then
    log "INFO: NAS-Snapshots auf dem Share sind aktiv (tier-2 Versionierung)"
fi

exit 0
