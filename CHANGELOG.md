# Changelog

Alle wichtigen Änderungen an diesem Darkstar-Fork von Posterrama werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), und dieses Projekt folgt grob [Semantic Versioning](https://semver.org/lang/de/). Fork-spezifische Patch-Versionen werden mit Buchstaben-Suffixen gekennzeichnet (`3.0.1a`, `3.0.1b`, ...).

---

## [3.0.1s] – 2026-04-24

Neues One-Shot-Maintenance-Script `scripts/dedup-posterpacks.js`, das Dubletten-PosterPacks mit gleicher TMDB-ID aber unterschiedlichem Jahr im Dateinamen bereinigt (TMDB als Single-Source-of-Truth für die Release-Jahreszahl).

### Neu
- **`scripts/dedup-posterpacks.js`** — scannt alle ZIPs in `media/complete/{manual,plex-export,jellyfin-emby-export,tmdb-export,romm-export}/`, gruppiert nach `tmdb_id` aus `metadata.json`, fragt TMDB nach dem authoritativen Release-Jahr und entfernt/benennt ZIPs mit abweichendem Jahr. Aktualisiert atomar Sidecars (`*.poster.json`), Playlists (`cinema-playlists.json` + `cinema-playlist.json`), `poster-updater/filmliste.txt`, Trailer-Dateien (`media/trailers/*.mp4`) und `trailer-info.json`. Dry-Run-Default, explizites `--execute` erforderlich.

### Ergebnis auf dieser Installation
- 1391 ZIPs gescannt, 203 TMDB-IDs mit ≥2 ZIPs, 21 korrigiert (18 Löschungen + 3 Umbenennungen), 387 bereits korrekt.
- Playlist-Einträge: 22 konsolidiert, Filmliste: 21 Einträge aktualisiert, Trailer-Info: 17 Keys angepasst.

### Hinweis
- 185 TMDB-IDs haben weiterhin Duplikate, allerdings rein wegen **Titel-Varianten** (Kommas, Doppelpunkte, Umlaute vs. Transliteration, Untertitel) bei gleichem Jahr. Das ist aktuell außer Scope; eine Title-Normalisierung wäre ein separater Patch.

---

## [3.0.1r] – 2026-04-24

Neues Emby-Sync-Feature: automatischer Abgleich der beiden Emby-Server (DarkStar, LightStar) mit den vorhandenen PosterPacks, automatischer Download fehlender PosterPacks + Trailer, Ignore-Liste und Auto-Playlist "Die letzten 20 hinzugefügten Filme".

### Neu
- **Emby-Sync Hintergrund-Service** (`lib/emby-sync.js`, `routes/emby-sync.js`) — pollt alle 6h beide Emby-Server in Reihenfolge (DarkStar → LightStar, 2s-Online-Check), sammelt neue Filme (sortiert nach DateCreated), merged Duplikate zwischen Servern und triggert fehlende PosterPack- und Trailer-Downloads über die bestehende Python-Pipeline. Wenn beide Server offline: stumm übersprungen, keine Fehlerflut. Manueller Trigger via `POST /api/emby-sync/run`, Status und Report via `GET /api/emby-sync/status` und `GET /api/emby-sync/last-report`.
- **Ignore-Liste** (`config.json:embySync.ignoredMovies`) — Filme, die vom Abgleich ausgeschlossen werden sollen. CRUD via `/api/emby-sync/ignored` (GET/POST/DELETE). Drei Matching-Modi: Titel+Jahr, IMDB-ID, TMDB-ID.
- **Auto-Playlist "Die letzten 20 hinzugefügten Filme"** — wird vom Sync-Service erzeugt und gepflegt (sortiert nach Emby-DateCreated, nur Filme mit vorhandenem PosterPack-ZIP). Beim ersten Sync wird sie als aktive Playlist gesetzt (idempotent via `initiallyActivated`-Flag — verdrängt keine vom User manuell gewählte Playlist bei späteren Läufen). Vor User-Löschung geschützt (`DELETE /playlists/auto_recent_20` liefert 403), `titles`-Updates werden ignoriert, nur `name` ist editierbar.
- **Admin-UI "Emby-Sync"** (`public/admin.html`, `admin.js`, `admin.css`) — eigener Sidebar-Menüpunkt mit Status-Anzeige, manuellem Trigger-Button, Report-Tabs (Hinzugefügt / Übersprungen / Ignoriert / Fehler) und Ignore-Liste-Editor (Add-Form für Titel+Jahr / IMDB / TMDB + Remove-Button pro Zeile).

### Geändert
- **Refactor `routes/poster-updater.js`** → Shared Singleton `lib/poster-updater-runner.js`. Vorher waren `runningProcess`, `writeLock` und SSE-Clients modul-scoped und daher von außerhalb nicht teilbar. Jetzt teilen sich poster-updater und emby-sync denselben Lock und dieselben SSE-Clients. Kein paralleler Spawn derselben Python-Jobs mehr möglich.
- `utils/jellyfin-http-client.js:getItems()` — neuer optionaler Parameter `sortOrder` (Ascending/Descending), damit Emby-Sync nach DateCreated-desc sortieren kann. Backwards-compatible.
- `routes/poster-selector.js` — Guards für Auto-Playlists: DELETE → 403, PUT strippt `titles`-Updates für `auto:true` Playlists.
- Neue `.env`-Variable: `JELLYFIN_API_KEY_LIGHTSTAR` für den zweiten Emby-Server.

## [3.0.1q] – 2026-04-24

Pi-Kiosk-Performance-Tuning + Erweiterung des Monitor Power Watchers um einen Next-Poster-Trigger. Keine Code-Änderungen an Posterrama selbst — alle Anpassungen sind System-Config auf dem lokalen Pi, dokumentiert im Repo.

### Neu
- **Kiosk Performance Tuning** (`docs/KIOSK-PERFORMANCE.md`) — 1920×1080@60Hz (statt 4K@60Hz) mit Hardware-Upscaling durch den Dell-Monitor; vier Chromium-Flags für GPU-Beschleunigung (`--ignore-gpu-blocklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`, `--canvas-oop-rasterization`); Chromium-Launcher als separates Script `posterrama-kiosk.sh`, damit Flag-Änderungen ohne Re-Login wirken. Ergebnis: Trailer und Fade-Transitions im Cinema-Modus ruckelfrei.
- **Next-Poster-Trigger im Monitor Power Watcher** (`docs/MONITOR-POWER-WATCHER.md`) — Nach `SIGCONT` (Monitor an) schickt der Watcher zusätzlich einen virtuellen ArrowRight-Tastendruck per `wtype` an Chromium. Der Cinema-Keyboard-Handler ruft `window.__posterramaPlayback.next()` auf, der beim Einfrieren sichtbare alte Frame wird nie gezeigt.

### Geändert
- `docs/INDEX.md` — Verweis auf neues Kiosk-Performance-Dokument.
- `docs/MONITOR-POWER-WATCHER.md` — neue Voraussetzung `wtype`, Beschreibung des Next-Poster-Schritts im Off→On-Zyklus.

---

## [3.0.1p] – 2026-04-23

Release des Darkstar-Forks. Fasst die Entwicklungen seit dem letzten getaggten Upstream-Release `v3.0.1` zusammen — insgesamt 31 Commits über die Sub-Versionen `3.0.1a` bis `3.0.1p`.

### Neu
- **Cinema Footer Überarbeitung** (3.0.1p) — Metadaten-Anreicherung (Genres, Regisseur, Studio, Auflösung, Audio-Codec, Aspect-Ratio, HDR) werden aus ZIP-`metadata.json` durchgereicht und im Footer angezeigt. Medien-Flag-Icon-Sets für aspectratio, audio, mpaa, music, resolution, rottentomatoes, source, studio, videocodec. HDR-/Dolby-Vision-Erkennung aus dem PosterPack-`hdr`-Feld.
- **Playlist Editor Sortierung** (3.0.2 → 3.0.1o) — Sortier-Buttons (A–Z, Z–A, Neueste) für verfügbare PosterPacks.
- **PosterPack Studio** (3.0.1f–3.0.1l) — Eigener Menüpunkt zum Erstellen UND Bearbeiten von PosterPacks. Felder für Regisseur, Studio, Auflösung, Audio-Codec, Aspect-Ratio, HDR. Cast-Editor. Dropdown-basierte Auswahl. Vorhandene PosterPacks können geladen und aktualisiert werden.
- **TMDB Metadata Fetcher** (3.0.1g, 3.0.1j) — Python-Scripts zum nachträglichen Laden von Clearlogos, Backdrops, Taglines (DE→EN), Certification (FSK), Regisseur und Studio von TMDB in bestehende ZIPs.
- **Screensaver Trailer** (3.0.1d) — Trailer-Wiedergabe im Screensaver-Modus (unten links, 21:9, 60% Breite). Aktive Playlist gilt auch im Screensaver. Globaler `showTrailer`-Toggle in Admin Visual Elements.
- **Multi-Playlist-System** (3.0.1b) — Benannte Playlisten erstellen, wechseln, aktivieren, duplizieren, löschen. Live-Sync zu allen Displays. BroadcastChannel-Fallback für Same-Browser.
- **Poster Updater** (3.0.1a) — Eigener Admin-Menüpunkt: Film-Verwaltung, PosterPack-Download, lokaler Trailer-Download via yt-dlp. Direkter YouTube-Fallback ohne TMDB. Drag-&-Drop-ZIP-Upload.
- **Playlist Editor** (3.0.1a) — Multi-Playlist-Verwaltung mit Drag & Drop, Trailer-Typ-Badges (DE-offiziell, DE, EN-offiziell, EN), Zufall-Sortierung (Fisher-Yates).
- **Lokale Trailer-Wiedergabe** (3.0.1a) — HTML5-`<video>` statt YouTube-iframe, wenn ein lokaler Trailer in `media/trailers/` existiert. Lokal hat Vorrang vor ZIP- und TMDB-Trailer.
- **Konfigurierbare Trailer-Timings** (3.0.1e) — `trailerDelaySeconds`, `trailerPauseAfterSeconds`, `noTrailerDisplaySeconds`.

### Geändert
- **TMDB-Suche auf Deutsch** (3.0.1m) — `language=de-DE` in `routes/media.js` für deutsche Filmtitel.
- **PosterPack-Branding** (3.0.2 → 3.0.1o) — Einheitliche Schreibweise `PosterPack` statt `Posterpack` in 26 Dateien.
- **Cinema Aspect-Ratio-Normalisierung** (3.0.1p) — 10 standardisierte Cinema-Formate statt freier Werte.
- **Screensaver UI Polish** (3.0.1n) — Uhr (oben links), ClearLogo (oben rechts), Trailer (unten links) mit einheitlichem 3vh-Abstand. Poster-Aspect-Ratio-Fix. Text-Layout-Rework.
- **YouTube Trailer Lazy-Fetch** (3.0.1m) — Trailer-URL wird erst bei Bedarf ermittelt.
- **Cinema Trailer Crop** (3.0.1h) — `scale(1.20)` statt `scale(1.25)`, Oversize-Video zum Entfernen schwarzer Ränder, Rahmen bleibt erhalten.
- **Playlist-Sync via Polling** (3.0.1h) — 5-Sekunden-Polling statt WebSocket/BroadcastChannel für robuste Cross-Device-Sync.

### Behoben
- **Unicode NFC-Normalisierung** (3.0.2 → 3.0.1o, 3.0.1b) — Alle Trailer-Schreibstellen normalisieren Dateinamen + JSON-Keys zu NFC. Verhindert NFD/NFC-Duplikate bei Umlauten (macOS-Kompatibilität).
- **Safari Video-Fix** (3.0.1i) — Video-Wiedergabe in Safari stabilisiert, Cinema-Trailer-Timing korrigiert.
- **Screensaver Trailer Autoplay** (Commit `f8dc3a2c`) — Triple-Fallback für Autoplay, Duplicate-Keyhandler entfernt, alle 4 Transition-Pfade spielen Trailer ab.
- **YouTube Autoplay Chromium** (Commit `44582741`) — `allow="autoplay; encrypted-media; picture-in-picture"` im iframe.
- **YouTube Autoplay Safari** (Commit `9d19d313`) — iframe wird manuell erstellt und `allow`-Attribut gesetzt, BEVOR `src` zugewiesen wird.
- **Cinema Trailer Loop-Fix** — 1-Loop-Autohide prüft VOR Video-Neustart, kein doppeltes Abspielen.
- **Poster-Link Fix** — `#poster-link display:block + 100%` für Chrome/Safari (poster-wrapper-Kind hatte 0x0).
- **Config-Public Fix** — `config.config` statt `config` für Raw-Werte (uiScaling, showRottenTomatoes wurden ignoriert).
- **Screensaver startCycler** — Timer-Management nur noch in `createTrailerOverlay`, keine Doppel-Trigger mehr.
- **Poster Updater Filter-Fix** (3.0.1f) — `withTrailer`-Zähler bleibt nach Filter-Klick korrekt.
- **Trailer sofort stoppen** — Trailer wird sofort gestoppt, wenn Poster manuell gewechselt wird.
- **Film-Löschung Playlist-Sync** — Beim Löschen eines Films wird dieser automatisch aus allen Playlisten entfernt.

### Performance
- **Fast Boot (ZIP-Posterpacks)** (Commits `b1c7e848`, `73309f87`, `f271436b`, `06f88ea1`, `3a5e6a5e`, `3235703b`) — Zwei-Phasen-Startup: Quick-Start-Phase liest ZIP-Scan-Cache aus dem Speicher, Background-Rescan 30 Sekunden nach `app.listen()`. Eliminiert ~2000 synchrone ZIP-Öffnungen während des Starts. Auf Raspberry Pi 4 mit SD-Karte: Startzeit von ~30s auf wenige Sekunden reduziert.
- **Chromium/RPi4 Optimierungen** (3.0.1k) — Diverse Performance-Optimierungen für Display-Hardware mit Chromium auf Raspberry Pi 4.
- **Service-Worker-Cache-Strategie** — `cinema-display.js` vom SW-Cache ausgeschlossen, `style.css` Cache-Buster + SW-Bypass für Screensaver-Route.

### Infrastruktur
- **Cinema-Playlists entfernt** (Commit `efc7af80`) — `public/cinema-playlist.json` und `cinema-playlists.json` aus Tracking genommen und in `.gitignore` aufgenommen (sind Laufzeit-State).
- **Python-Scripts `.env`-frei** (3.0.1h) — Alle Scripts lesen `config.json` statt `.env`.

### Sub-Versionen dieses Releases

| Version | Datum | Schwerpunkt |
|---|---|---|
| `3.0.1p` | 2026-04-23 | Cinema Footer Überarbeitung + Release-Dokumentation |
| `3.0.1o` | 2026-03-30 | Unicode NFC, PosterPack-Branding, Playlist Editor Sort |
| `3.0.1n` | 2026-03-30 | Screensaver UI Polish, Poster Aspect-Ratio Fix |
| `3.0.1m` | 2026-03-30 | YouTube Trailer Lazy-Fetch, TMDB Deutsch, Refresh Media |
| `3.0.1l` | 2026-03-29 | PosterPack Studio Dropdowns, Cast-Editor |
| `3.0.1k` | 2026-03-29 | Chromium/RPi4 Performance |
| `3.0.1j` | 2026-03-29 | Taglines, Metadata-Extras, PosterPack Studio |
| `3.0.1i` | 2026-03-28 | Safari-Video-Fix, UI-Scaling-Rework |
| `3.0.1h` | 2026-03-27 | Trailer-Fixes, Playlist-Polling, Video-Crop |
| `3.0.1g` | 2026-03-27 | TMDB Clearlogo + Backdrop Fetcher |
| `3.0.1f` | 2026-03-27 | PosterPack Studio Create + Edit |
| `3.0.1e` | 2026-03-27 | PosterPack Creator, Upload |
| `3.0.1d` | 2026-03-26 | Screensaver-Trailer, showTrailer Toggle |
| `3.0.1c` | 2026-03-26 | Zufall-Sort, Playlist-Sync, YouTube-Downloader |
| `3.0.1b` | 2026-03-26 | Multi-Playlist, Trailer-Badges, Unicode |
| `3.0.1a` | 2026-03-25 | Poster Updater, Playlist Editor, lokale Trailer |

### Voraussetzungen
- `yt-dlp`: `pip3 install --break-system-packages yt-dlp`
- Python-Pakete: `requests`, `python-dotenv`

---

## [3.0.1] – Upstream

Basis-Version vom Upstream [Posterrama](https://github.com/Posterrama/posterrama). Details siehe Upstream-Release-Notes.

[3.0.1p]: https://github.com/webdevsmarthome/posterrama-darkstar/releases/tag/v3.0.1p
[3.0.1]: https://github.com/Posterrama/posterrama/releases/tag/v3.0.1
