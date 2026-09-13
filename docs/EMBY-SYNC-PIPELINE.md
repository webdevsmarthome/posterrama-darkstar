# Emby-Sync Pipeline (Darkstar-Fork)

**Scope:** Darkstar-Fork, nicht Teil des Upstream-Posterrama-Releases
**Eingeführt:** 3.0.1r (Kern-Feature); erweitert in 3.0.1s/t/u/v und 3.0.1z-20 (TMDB-basierter Abgleich)
**Zweck:** Voll-automatisches Poster-/Trailer-Lifecycle-Management: neue Filme auf den Emby-Servern werden erkannt, zugehörige PosterPacks und Trailer heruntergeladen, eine Auto-Playlist „Die letzten 20 hinzugefügten Filme" wird gepflegt. Eine Ignore-Liste schließt unerwünschte Titel aus. TMDB ist die Single-Source-of-Truth für Titel- und Jahresangaben.

---

## Architektur-Überblick

```
┌────────────────┐     ┌─────────────────────┐
│ Emby-Server    │────▶│ lib/emby-sync.js    │
│ (DarkStar +    │     │ scheduleEmbySync    │
│  LightStar)    │     │ runSyncCycle        │
└────────────────┘     └──────────┬──────────┘
                                  │
                                  ▼
                       ┌─────────────────────────┐
                       │ lib/                    │
                       │  poster-updater-runner  │
                       │  (Shared Singleton)     │
                       │  • writeLock            │
                       │  • runningProcess       │
                       │  • sseClients           │
                       └──────────┬──────────────┘
                                  ▼
              ┌─────────────────────────────────────┐
              │ poster-updater/filmliste.txt        │
              │                                     │
              │ Hamlet (1990)[tmdb:10264]           │
              │ Hamlet (1996)[tmdb:10549]           │
              │ Hamlet (2000)[tmdb:10688]           │
              │ ...                                 │
              └──────────┬──────────────────────────┘
                         ▼
              ┌─────────────────────────────────────┐
              │ python3 tmdb-get-posters-direct.py  │
              │ python3 download-trailers.py        │
              └──────────┬──────────────────────────┘
                         ▼
    ┌──────────────────────────────────────────────┐
    │ media/complete/tmdb-export/*.zip             │
    │ media/trailers/*-trailer.mp4                 │
    │ public/cinema-playlists.json                 │
    │  └─ auto_recent_20 (Auto-Playlist)           │
    └──────────────────────────────────────────────┘
```

---

## Komponenten

### 1. Emby-Sync Scheduler (`lib/emby-sync.js`, `routes/emby-sync.js`)

- Läuft alle 6 h (Default, `config.embySync.intervalMinutes`).
- Reihenfolge: **DarkStar zuerst**, dann LightStar. Beide offline → stumm überspringen.
- Scannt alle Movie-Libraries jedes Online-Servers, sortiert nach `DateCreated desc`, bis `movieLimitPerRun` (Default 500).
- Multi-Server-Dedup per canonicalKey `"Titel (Jahr)"` (NFC-normalisiert): frühestes DateCreated gewinnt, IDs werden konsolidiert, `sourceServers` akkumuliert.
- Diff gegen vorhandene PosterPack-ZIPs (alle Unterordner von `media/complete/*`) — **per Name oder TMDB-ID** — und gegen `config.embySync.ignoredMovies`. Seit 3.0.1z-20 kennt `lib/zip-tmdb-index.js` die TMDB-ID jedes ZIPs aus `cache/zip-scan-cache.json`, dazu kommen die `[tmdb:N]`-Hints der Filmliste für frisch geladene ZIPs. Vorher galt ein Film, den die zwei Server unterschiedlich benennen („Top Gun - Maverick" / „Top Gun: Maverick"), als neu und wurde doppelt geladen.
- Report-Gründe in `skipped` (jeder Eintrag trägt die `tmdbId`): `has-zip` (Name), `has-zip-tmdb` (anderer Name, gleiche ID — mit `zip` und `via`), `duplicate-in-run-tmdb` (derselbe Film von beiden Servern im selben Lauf, nur einmal geladen).
- Fehlende Filme landen in `filmliste.txt` — wenn TMDB-ID aus Emby bekannt, **mit** `[tmdb:NNNN]`-Suffix.

HTTP-Endpoints (alle unter `adminAuth`):
| Route | Wirkung |
|---|---|
| `POST /api/emby-sync/run` | Manueller Trigger (409 wenn bereits laufend) |
| `GET /api/emby-sync/status` | `{scheduled, enabled, intervalMinutes, lastRun, nextRun, running, autoPlaylistId}` |
| `GET /api/emby-sync/last-report` | Letzter Report (added/skipped/ignored/errors/servers) |
| `GET/POST /api/emby-sync/ignored` | Ignore-Liste lesen/anfügen |
| `DELETE /api/emby-sync/ignored/:index` | Ignore-Regel entfernen |

Admin-UI: Sidebar „Emby-Sync" → Status-Card, Trigger-Button, Report-Tabs, Ignore-Editor.

### 2. Shared Runner (`lib/poster-updater-runner.js`)

Singleton, wird sowohl von `routes/poster-updater.js` (Admin-UI-Downloads) als auch von `lib/emby-sync.js` genutzt. Teilt sich:
- `writeLock` — serialisiert Filmliste-Schreibzugriffe.
- `runningProcess` — verhindert doppelten Spawn desselben Python-Jobs.
- `sseClients` — Live-Log-Stream an Admin-UI für beide Trigger-Pfade.

Wichtige Helfer:
- `appendFilms(newFilms)` — Dedup auf Title-Year-Basis; ein Eintrag ohne Hint wird durch einen mit Hint "upgraded" (kein Duplikat). Seit 3.0.1z-20 gilt auch eine bereits vorhandene `[tmdb:N]`-ID unter anderem Titel als Duplikat (`duplicateIds`), ebenso innerhalb einer Charge und beim Upgrade.
- `writeFilmList(films)` — entfernt wortgleiche Doppelzeilen und schreibt atomar.
- `stripTmdbHint(entry)` / `hasTmdbHint(entry)` — Suffix-Handling.
- `spawnPosterPackJob()`, `spawnTrailerJob()` — idempotent, loggen `already-running` wenn Kollision.

### 3. Filmliste-Format

Datei: `poster-updater/filmliste.txt`, eine Zeile pro Film:

```
Corner Office (2023)[tmdb:800279]
Avatar: Fire and Ash (2025)[tmdb:1035259]
Einfacher-Eintrag-Ohne-ID (1999)
```

- Pflicht: `{Titel} (JJJJ)`.
- Optional: `[tmdb:NNNN]`-Suffix (TMDB-ID-Hint). Wenn vorhanden, **überspringt der Python-Downloader die TMDB-Suche komplett** und nutzt `GET /movie/{id}` direkt.
- Bei ungültigem Hint (z. B. ID entfernt) → Fallback auf Title+Year-Suche.
- Dedup: Title+Year ist Primärschlüssel; zusätzlich ist eine TMDB-ID nur einmal erlaubt (seit 3.0.1z-20).

### 4. Python-Downloader

`poster-updater/tmdb-get-posters-direct.py` — generiert PosterPack-ZIPs.
`poster-updater/download-trailers.py` — lädt Trailer-MP4s via yt-dlp.

Beide parsen den `[tmdb:N]`-Hint und nutzen die ID direkt. Seit 3.0.1z-20 überspringen beide eine TMDB-ID, die unter anderem Namen schon ein ZIP hat (`poster-updater/zip_index.py`, Quelle ZIP-Scan-Cache; im Lauf erzeugte IDs werden nachgetragen). Das deckt auch Emby-Filme ohne ProviderIds ab, deren ID erst die TMDB-Suche liefert.

### 5. Auto-Playlist „Die letzten 20 hinzugefügten Filme"

- Playlist-ID: `auto_recent_20` (in `public/cinema-playlists.json`).
- Wird bei jedem Sync mit den Top 20 nach `DateCreated` (von Emby) aktualisiert — nur Filme mit existierendem ZIP (per Name oder TMDB-ID). Der Titel ist der tatsächliche ZIP-Name, zwei Emby-Namen desselben Films belegen nur einen Slot.
- Geschrieben wird atomar; eine befüllte Auto-Playlist wird nie durch eine leere ersetzt (Leer-Schutz) — die meisten Geräte sind auf sie gepinnt.
- `autoActivate: true` (Default) → beim **ersten** Sync wird sie als `activePlaylistId` gesetzt. Danach idempotent via `initiallyActivated: true`.
- Geschützt: `DELETE /api/poster-selector/playlists/auto_recent_20` → 403. `PUT` akzeptiert nur `name`, nicht `titles`.

### 6. Ignore-Liste

`config.embySync.ignoredMovies` — Array mit Regeln. Match ist regel-OR:

```json
[
  { "title": "Nicht erwünscht", "year": 2023, "reason": "Qualität schlecht" },
  { "imdbId": "tt0133093" },
  { "tmdbId": 12345 }
]
```

Ein Match (per title+year, imdbId oder tmdbId) → kein Download, kein Playlist-Eintrag.

---

## Maintenance-Scripts

Alle in `scripts/`, Dry-Run-Default, `--execute` für Schreiben.

### `dedup-by-tmdb.js`

Einmalige Bereinigung von PosterPack-Dubletten (gleiche TMDB-ID, unterschiedliche Dateinamen) — offline, ohne TMDB-Abfragen und ohne ZIPs zu öffnen (Quelle: `cache/zip-scan-cache.json`). Ersetzt `dedup-posterpacks.js` (3.0.1s/t): Das korrigierte die Filmliste nie, verlor beim Umbenennen Trailer und folgte driftenden TMDB-Titeln.

- Pro TMDB-ID bleibt **ein vorhandener Name** — es wird nur gelöscht, nie umbenannt. Regeln in dieser Reihenfolge: `--keep`, Emby-Schutz (ein Name, den Emby ohne passende TMDB-ID liefert, wird nie gelöscht), Poster vorhanden, Jahr = TMDB-Erscheinungsjahr, Emby-Schreibweise, steht in der Filmliste, hat Trailer, größeres ZIP.
- Trailer: Eine identische Kopie (md5) wird entfernt. Hatte nur der gelöschte Name einen Trailer, zieht er auf den bleibenden Namen um; bei abweichenden Trailern gewinnt das bessere Label (DE-offiziell > DE > EN-offiziell > EN).
- Angepasst werden `filmliste.txt` (eine Zeile pro ID), `cinema-playlists.json` und `cinema-playlist.json` (Einträge umgelenkt), `trailer-info.json` und der ZIP-Scan-Cache.
- „Löschen" heißt Verschieben nach `../posterrama-quarantine/dedup-tmdb-<Zeitstempel>/` — außerhalb des Projekts, nicht im NAS-Mirror — mit Backups der geänderten Dateien und `manifest.json`.
- `--execute` verlangt den Plan-Hash des geprüften Dry-Runs, einen aktuellen Emby-Sync-Report ab 3.0.1z-20 (TMDB-IDs in `skipped`), einen **gestoppten Server** und keine laufenden Pipeline-Jobs.

```bash
node scripts/dedup-by-tmdb.js                                     # Dry-Run: Plan + Plan-Hash
node scripts/dedup-by-tmdb.js --keep "Top Gun: Maverick (2022)"   # bleibenden Namen erzwingen
pm2 stop posterrama
node scripts/dedup-by-tmdb.js --execute --expect-plan <hash>
pm2 start posterrama
node scripts/dedup-by-tmdb.js --rollback ../posterrama-quarantine/dedup-tmdb-<Zeitstempel>
```

### `backfill-tmdb-hints.js`

One-Shot-Migration: Trägt für bestehende Filmliste-Einträge ohne `[tmdb:N]`-Hint die TMDB-ID nach.

Zweistufiges Lookup:
1. ZIP-metadata-Scan (primär, lokal, kein API-Call)
2. Emby/Jellyfin `ProviderIds.Tmdb` (Fallback)

Automatisches Backup vor Schreiben.

```bash
node scripts/backfill-tmdb-hints.js             # Dry-Run
node scripts/backfill-tmdb-hints.js --execute   # Ausführen
```

---

## Konfiguration

`config.json`:

```jsonc
"mediaServers": [
  { "name": "DarkStar",  "type": "jellyfin", "enabled": true,
    "hostname": "192.168.227.171", "port": 8096,
    "tokenEnvVar": "JELLYFIN_API_KEY",
    "movieLibraryNames": [], ... },
  { "name": "LightStar", "type": "jellyfin", "enabled": true,
    "hostname": "192.168.217.89", "port": 8096,
    "tokenEnvVar": "JELLYFIN_API_KEY_LIGHTSTAR",
    "movieLibraryNames": [], ... }
],

"embySync": {
  "enabled": true,
  "intervalMinutes": 360,
  "initialDelaySeconds": 60,
  "movieLimitPerRun": 500,
  "autoPlaylist": {
    "enabled": true,
    "id": "auto_recent_20",
    "name": "Die letzten 20 hinzugefügten Filme",
    "limit": 20,
    "autoActivate": true
  },
  "downloads": { "posterPack": true, "trailer": true },
  "ignoredMovies": []
}
```

`.env`: `JELLYFIN_API_KEY` (DarkStar) + `JELLYFIN_API_KEY_LIGHTSTAR`.

`config.tmdbSource.apiKey` wird für Maintenance-Scripts als primäre TMDB-Key-Quelle genutzt (`.env` als Fallback).

---

## Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Keine Films werden herunter geladen nach Restart | Scheduler startet erst nach `initialDelaySeconds` (60s). `systemctl --user restart` / `pm2 restart posterrama` neu starten. Log prüfen: `pm2 logs posterrama \| grep EmbySync`. |
| "409 Conflict" bei manuellem Trigger | Ein Sync läuft bereits. `GET /api/emby-sync/status` zeigt `running: true`. Kurz warten. |
| Playlist `auto_recent_20` leer | Keine Filme mit TMDB-Match UND lokalem ZIP. Erst warten bis Python-Downloader ein paar ZIPs gemacht hat. |
| Neue PosterPack-Duplikate | Sollte nicht mehr vorkommen: Seit 3.0.1z-20 erkennt die Sync Filme per TMDB-ID, Poster- und Trailer-Script überspringen bekannte IDs. Im Report auf `has-zip-tmdb` achten; Emby-Filme ganz ohne TMDB-ID werden weiter nur per Name abgeglichen. Bereinigen: `node scripts/dedup-by-tmdb.js` (Dry-Run), dann `--execute` bei gestopptem Server. |
| Film in Ignore-Liste, wird trotzdem runtergeladen | Ignore-Liste wird nur beim NÄCHSTEN Sync wirksam. Vorhandene Einträge in `filmliste.txt` manuell per Admin-UI löschen. |
| Admin-UI zeigt Emby-Sync-Status nicht | Seite neu laden; im Sidebar auf "Emby-Sync" klicken → Status-Poll startet alle 10 s. |
| Beide Emby-Server offline → wo sieht man das | `cache/emby-sync-last-report.json` → `report.servers` und `report.result === "all-offline"`. Log ist `logger.info`, nicht error (bewusst stumm). |

---

## Release-Historie dieser Pipeline

| Release | Inhalt |
|---|---|
| **3.0.1r** | Kern: Emby-Sync, Auto-Playlist, Ignore-Liste, Admin-UI, LightStar als 2. Server, Shared Runner |
| **3.0.1s** | `dedup-posterpacks.js` (Year-Only) — ersetzt in 3.0.1z-20 |
| **3.0.1t** | `dedup-posterpacks.js --normalize-title` (auch Titel) — ersetzt in 3.0.1z-20 |
| **3.0.1u** | TMDB-ID-Hint-Format in filmliste.txt (Prevention) |
| **3.0.1v** | `backfill-tmdb-hints.js` (Migration bestehender Einträge) |
| **3.0.1z-20** | TMDB-basierter Abgleich (Sync, `appendFilms`, Python-Scripts), Auto-Playlist mit ZIP-Namen und Leer-Schutz, Scan-Cache räumt gelöschte ZIPs aus, `dedup-by-tmdb.js` ersetzt `dedup-posterpacks.js` |

---

## Design-Invarianten

1. **TMDB ist Source-of-Truth** für Titel und Jahr. Emby kann falsche Metadaten haben — TMDB gewinnt.
2. **`tmdb_id` ist Pivot** für Dedup, niemals fuzzy-title-matching.
3. **Silent-Skip bei allen Servern offline** — kein Fehler-Banner, nur `logger.info`.
4. **Posterrama-Server niemals pausieren** (siehe Memory `feedback_posterrama_server_nie_pausieren.md`) — andere Clients werden bedient.
5. **Dry-Run-Default für alle Scripts** — Schreiben nur mit explizitem `--execute`.
6. **Idempotenz** auf allen Ebenen: mehrfach-Ausführung ist ein No-Op bei bereits korrektem Zustand.

---

## Abhängigkeiten zu anderen Komponenten

- **Monitor Power Watcher** (`docs/MONITOR-POWER-WATCHER.md`) — unabhängig. Der Watcher friert Chromium ein, der Emby-Sync läuft weiter (er ist Server-seitig).
- **Kiosk Performance** (`docs/KIOSK-PERFORMANCE.md`) — unabhängig. Kiosk zeigt die Auto-Playlist; der Sync pflegt sie.
- **CUSTOM-PATCHES.md** — Patches 49–52 und 77–80 dokumentieren diese Pipeline.
