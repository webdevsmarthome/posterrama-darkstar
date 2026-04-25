# Backup-Strategie (Darkstar-Fork)

**Scope:** Pi-spezifische Installation
**Eingeführt:** 3.0.1w
**Ziel:** Alle user-seitigen Daten (Config, Playlists, PosterPacks, Trailer, Filmliste, Profile) gegen SD-Karten-Tod, Hardware-Defekt und Ransomware absichern.

---

## Überblick — Drei-Schichten-Strategie

```
Schicht 1: Lokaler Posterrama-Config-Backup
  └─ backups/config/{timestamp}/  (täglich 03:30, 30 Tage / 10 Stück)

Schicht 2: Off-System Mirror auf NAS
  └─ //NAS/backup/posterrama/     (täglich 04:00 via rsync-over-SMB)

Schicht 3: NAS-seitige Snapshots (z. B. Synology Snapshot Replication)
  └─ 6× täglich, 30 Tage, immutable 7 Tage (Ransomware-sicher)
```

**Warum drei Schichten?**
- **Schicht 1** schützt gegen Config-Korruption durch Posterrama selbst (bad save, failed migration).
- **Schicht 2** schützt gegen SD-Karten-Tod, Hardware-Defekt, Blitzschlag.
- **Schicht 3** schützt gegen versehentliches Löschen + Ransomware; liefert Point-in-Time-Recovery.

Jede Schicht ist unabhängig: fällt eine aus, puffern die anderen.

---

## Schicht 1: Lokaler Config-Backup

**Mechanismus:** Posterrama-built-in, `utils/configBackup.js`, Scheduler aus `routes/config-backups.js`.

**Was wird gesichert?** (FILE_WHITELIST)
| Datei | Zweck |
|---|---|
| `config.json` | Hauptkonfiguration |
| `.env` | Secrets, API-Keys |
| `devices.json` | Gerätezustand |
| `device-presets.json` | Gerätevorlagen |
| `profiles.json` | wallart/cinema-Profile |
| `public/cinema-playlists.json` | Alle kuratierten Playlists (+ Auto-Playlist) |
| `public/cinema-playlist.json` | Aktive Playlist (Live-Referenz für Clients) |
| `poster-updater/filmliste.txt` | Film-Queue mit TMDB-Hints |

**Zeitplan:** `config.json:backups.time = "03:30"` täglich.
**Retention:** 10 Stück oder 30 Tage (whichever-first-violated).
**Ablage:** `backups/config/YYYYMMDD-HHMMSS/` mit `meta.json`.
**Auto-Backup** zusätzlich **bei jedem Save** via Admin-UI.

**Restore:** via Admin-UI → Operations → Config-Backups, oder direkt per `POST /api/admin/config-backups/{id}/restore/{filename}`.

---

## Schicht 2: NAS-Mirror (rsync über SMB)

**Mechanismus:** Systemd-System-Service + Timer, `/usr/local/bin/posterrama-backup-to-nas.sh`.

**Template-Files im Repo:**
- `scripts/backup/backup-to-nas.sh`
- `scripts/backup/systemd/posterrama-nas-backup.service`
- `scripts/backup/systemd/posterrama-nas-backup.timer`

**Was wird gesichert?** Das komplette Posterrama-Verzeichnis `/home/helmut/posterrama/`, außer:
- `node_modules/` — via `npm install` regenerierbar
- `cache/` — Poster/ZIP-Scan-Caches, regenerierbar
- `logs/`, `*.log` — Ephemeres
- `coverage/`, `.nyc_output/`, `__tests__/` — Code-Test-Artefakte (in Git)
- `sessions/` — Ephemere User-Sessions
- `image_cache/` — Thumbnail-Cache
- `poster-updater/tmp_*/` — Python-Temp-Dirs
- `*.tmp`, `*.tmp.*` — Temp-Dateien
- `.git/` — Projekt-Repo (wird extra per Git zu GitHub gepusht)
- `device-updates/` — Ephemere Update-Artefakte

**Inkludiert (wichtig!):**
- `media/complete/*.zip` (~40 GB PosterPacks)
- `media/trailers/*-trailer.mp4` (Trailer)
- `backups/config/*` — die Schicht-1-Historie wird mitgesichert
- `public/cinema-playlists.json`
- `poster-updater/filmliste.txt`
- `config.json`, `.env`, `devices.json`, `profiles.json`
- `scripts/`, `docs/`, Quellcode

**Zeitplan:** Täglich 04:00 (30 min nach Schicht 1, damit die tagesaktuelle Config-Backup-History mitgeht). `RandomizedDelaySec=600` für Jitter.

**Verhalten bei NAS-offline:** Stumm überspringen — `logger.info`, `exit 0`. Kein Fehler-Banner, kein Admin-Alert. Log im `journalctl -u posterrama-nas-backup.service`.

**Transfer-Mechanik:** `rsync -aH --delete --partial` über SMBv3-Mount. `--delete` ist scharf, weil Schicht 3 alle gelöschten Dateien per Snapshot puffert.

**Exit-Codes:**
- `0` — OK oder stumm-skip (NAS offline).
- `23` — Warnung, möglicherweise unvollständig (wird geloggt).
- `24` — Vanished files (harmlos, z. B. Temp-Dateien während des Laufs verschwunden).

---

## Schicht 3: NAS-Snapshots (Synology-Beispiel)

**Mechanismus:** Synology Snapshot Replication auf dem Backup-Volume.

**Konfiguration auf dieser Installation (Synology DiskStation "DarkStar"):**
- **Intervall:** alle 4 h, beginnend 00:01 → 6 Snapshots pro Tag.
- **Retention:** 30 Tage = ca. 180 Snapshots Point-in-Time-Recovery.
- **Immutable Mode:** aktiv, 7 Tage Schutzdauer (Ransomware-sicher — weder User noch Malware können diese Snapshots löschen).
- **`#snapshot`-Ordner sichtbar:** Self-Service-Restore per SMB-Client / Finder / Explorer möglich, ohne DSM-Admin-Zugriff.

**Recovery-Fenster:** maximal 4 h Datenverlust bei SD-Karten-Tod + NAS-Restore. In der Praxis eher irrelevant, weil Schicht 2 eh nur 1× pro Tag läuft.

---

## Setup-Anleitung (NAS-Mirror)

```bash
# 1. Pakete installieren
sudo apt install cifs-utils rsync

# 2. Script kopieren
sudo install -m 0755 -o root -g root \
    scripts/backup/backup-to-nas.sh \
    /usr/local/bin/posterrama-backup-to-nas.sh

# 3. Credentials anlegen (WICHTIG: chmod 600, root-owned!)
sudo mkdir -p /etc/posterrama
sudo tee /etc/posterrama/nas-credentials >/dev/null <<EOF
username=bkpuser
password=DEIN_PASSWORT_HIER
EOF
sudo chmod 600 /etc/posterrama/nas-credentials
sudo chown root:root /etc/posterrama/nas-credentials

# 4. Systemd-Units
sudo install -m 0644 -o root -g root \
    scripts/backup/systemd/posterrama-nas-backup.service \
    /etc/systemd/system/posterrama-nas-backup.service
sudo install -m 0644 -o root -g root \
    scripts/backup/systemd/posterrama-nas-backup.timer \
    /etc/systemd/system/posterrama-nas-backup.timer

# 5. Aktivieren
sudo systemctl daemon-reload
sudo systemctl enable --now posterrama-nas-backup.timer

# 6. Einmalig manuell testen
sudo systemctl start posterrama-nas-backup.service
sudo journalctl -u posterrama-nas-backup.service -f

# 7. Timer-Status prüfen
systemctl list-timers posterrama-nas-backup.timer
```

**Script-Variablen im Script selbst anpassen:** `NAS_HOST`, `NAS_SHARE`, `NAS_REMOTE_SUBDIR`, `SRC`.

---

## Recovery-Szenarien

### Szenario A: Einzelne Config-Datei fehlerhaft
→ **Schicht 1** via Admin-UI restore. <1 Min.

### Szenario B: Mehrere Dateien verschwunden, letztes Backup von heute Nacht nicht betroffen
→ **Schicht 1** restore. <5 Min.

### Szenario C: Komplettes Desaster, SD-Karte tot
1. Neue SD-Karte flashen (Raspberry Pi OS)
2. `git clone git@github.com:webdevsmarthome/posterrama-darkstar.git`
3. `npm install`
4. Von **Schicht 2** (NAS-Mirror) die Nicht-Git-State zurückholen:
   - `media/complete/` → 40 GB PosterPacks
   - `media/trailers/`
   - `config.json`, `.env`, `devices.json`, `profiles.json`
   - `public/cinema-playlists.json`, `public/cinema-playlist.json`
   - `poster-updater/filmliste.txt`
5. `pm2 start ecosystem.config.js`

Dauer: ca. 1–2 h inkl. OS-Setup.

### Szenario D: Ransomware hat alles lokal + in Schicht 2 verschlüsselt
→ **Schicht 3** (immutable NAS-Snapshot): Snapshot älter als 24h wiederherstellen. Gleiche Recovery-Schritte wie Szenario C.

---

## Monitoring & Verifikation

**Regelmäßig prüfen:**

```bash
# Läuft der Timer?
systemctl list-timers posterrama-nas-backup.timer

# Letzter Lauf erfolgreich?
systemctl status posterrama-nas-backup.service
sudo journalctl -u posterrama-nas-backup.service --since "yesterday"

# Wie viel liegt auf dem NAS?
sudo mount -t cifs //192.168.227.171/backup /mnt/tmp \
    -o credentials=/etc/posterrama/nas-credentials,vers=3.0
du -sh /mnt/tmp/posterrama/
sudo umount /mnt/tmp

# Config-Backup-Historie
ls -t /home/helmut/posterrama/backups/config/ | head -5
```

**Alerts:** Derzeit keine automatische Alarmierung bei Backup-Fehlern konfiguriert. Bei Bedarf `OnFailure=`-Handler in Systemd-Unit.

---

## Was ist NICHT im Backup enthalten

- **OS-Partition** / System-Config — wird NICHT gesichert. Bei SD-Karten-Tod muss OS neu aufgesetzt werden. Wenn du das auch absichern willst, `dd`-Image der SD-Karte regelmäßig auf externe USB-Platte.
- **PM2-Config** (`ecosystem.config.js` ist in Git, aber `~/.pm2/` State nicht) — bei Bedarf separat sichern.
- **systemd-User-Units** für Monitor-Power-Watcher — in `~/.config/systemd/user/` liegen, git-ignored. Ein Hinweis in CUSTOM-PATCHES oder docs/MONITOR-POWER-WATCHER.md reicht zum Re-Setup.

---

## Änderungshistorie

| Release | Änderung |
|---|---|
| 3.0.1w | Schicht 2 (NAS-Mirror) + Schicht 3 (Snapshots) dokumentiert; `utils/configBackup.js` FILE_WHITELIST um `cinema-playlists.json`, `cinema-playlist.json`, `filmliste.txt`, `profiles.json` erweitert |
