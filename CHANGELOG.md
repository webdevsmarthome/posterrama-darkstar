# Changelog

Alle wichtigen Änderungen an diesem Darkstar-Fork von Posterrama werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), und dieses Projekt folgt grob [Semantic Versioning](https://semver.org/lang/de/). Fork-spezifische Patch-Versionen werden mit Buchstaben-Suffixen gekennzeichnet (`3.0.1a`, `3.0.1b`, ...).

---

## [3.0.1z] – 2026-04-28

NAS-Backup ~10× schneller, DELETE-Filmliste räumt sauber auf, Auto-Playlist sortiert nach ZIP-Erstellungsdatum.

### Behoben / Verbessert
- **NAS-Backup-Performance** (`scripts/backup/backup-to-nas.sh`): Vorher dauerte ein vermeintlich inkrementeller rsync auf dem 41-GB-Bestand bis zu **2 Stunden**, weil rsync wegen CIFS/SMB-mtime-Rundungsfehlern die Mehrzahl der mp4/zip-Files für „geändert" hielt und neu übertrug. **Fix:** Zwei separate rsync-Calls — Call 1 für alles außer `media/` mit `--modify-window=2` (toleriert SMB-mtime-Auflösung von 1–2 Sek), Call 2 für `media/` mit zusätzlich `--size-only` (immutable mp4/zip — Bytes-Größe ist eindeutig). **Gemessene Wirkung:** 2h 5min → 12:35 min beim Folge-Lauf, weiter sinkend auf <5 min für 0-Diff-Inkremente.
- **DELETE-Filmliste räumt jetzt in ALLEN 5 Export-Quellen auf** (`routes/poster-updater.js`): Vorher löschte `DELETE /api/poster-updater/films/:name` die ZIP nur in `tmdb-export/`. Filme aus `manual/`, `plex-export/`, `jellyfin-emby-export/` oder `romm-export/` ließen ihre ZIP als Karteileiche zurück. **Fix:** Iteration über alle 5 Quellen, plus zusätzliche Sidecar-Suffixe (`.poster.json`).

### Neu
- **Auto-Playlist sortiert nach ZIP-Erstellungsdatum** statt Emby-DateCreated (`lib/emby-sync.js`, `lib/poster-updater-runner.js`): Bisher sortierte die „Letzte 20/30 hinzugefügten Filme"-Auto-Playlist nach Emby's `dateCreated` — d. h. wann der Film auf den Emby-Server kam (oft Jahre her). Wenn ein User ein PosterPack frisch erstellte (z. B. nach Filmliste-Delete + Re-Add), erschien der Film NICHT als „neu" in der Playlist, weil sein Emby-DateCreated alt war. **Fix:** Sortierung nach ZIP-mtime — d. h. dem Datum des aktuellsten lokalen PosterPack-Downloads. Neue runner-Funktion `getAllZipMtimes()` liefert eine Map<canonicalKey, mtimeMs>; bei mehreren Quellen gewinnt die jüngste mtime.

### Bekannte Gotchas
- Filme mit Title-Mismatch zwischen Emby und TMDB (z. B. „Maechte" vs. „Mächte", „von" vs. „vom") oder filesystem-incompatiblen Filenamen (`/`, `?`) erscheinen bei jedem Sync wieder im „Hinzugefügt"-Tab, weil ihr ZIP-Download dauerhaft fehlschlägt. **Lösung:** Auf der Emby-Sync-Seite in die Ignor-Liste aufnehmen (per `tmdbId` falls bekannt, sonst per `title`+`year`).

---

## [3.0.1y] – 2026-04-28

Emby-Sync UI/Backend-Bugfixes + Log-Download-Buttons im Admin-UI.

### Behoben
- **Emby-Sync Save-Bug** (`routes/emby-sync.js`): POST `/api/emby-sync/ignored` ersetzte die Liste statt anzuhängen — jeder neue Eintrag überschrieb den vorigen. Plus: `_xxx`-Backing-Fields, `env`/`defaults`/`timeouts`/`config` der Config-Class-Instance landeten in der `config.json` (Class-Instance-Serialization-Bug). **Ursache:** `JSON.stringify(config)` auf der Config-Class-Instance serialisiert die eigenen Backing-Fields (`_embySync`, `_mediaServers`, …), aber NICHT die Getter-Properties (`embySync`, `mediaServers`, …) — Resultat: `newConfig.embySync` war `undefined`, wurde zu `{}` neu erzeugt, push() ergab REPLACE statt APPEND. **Fix:** `config.config` (das raw-Object aus loadConfig) statt der Class-Instance serialisieren, plus Self-Heal-Block der `_xxx`/`env`/`defaults`/`timeouts`/`config`-Top-Level-Keys beim Save abstrippt — alte korrupte config.json räumt sich beim ersten Save sukzessive selbst auf.
- **Emby-Sync UI startet nicht** (`public/admin.js`): `initEmbySync()` ist in einer IIFE deklariert, der Aufrufer (Sidebar-Nav-Handler) in einer ANDEREN IIFE — `typeof initEmbySync === 'function'` war immer `false`, kein Status-Load, kein Trigger-Button-Listener, kein Add-Form-Listener. **Fix:** `window.initEmbySync = initEmbySync;` exportieren und Aufrufer auf `window.initEmbySync()` ändern.
- **Auto-Playlist-Race-Condition** (`lib/emby-sync.js`): Neu hinzugefügte Filme erschienen nicht in der Auto-Playlist „Die letzten 20 hinzugefügten Filme", obwohl ihr ZIP wenige Sekunden nach dem Sync heruntergeladen war. **Ursache:** `updateAutoPlaylist()` lief synchron im Sync-Cycle, der ZIP-Index war zu diesem Zeitpunkt noch ohne die gerade angestoßenen Downloads. **Fix:** Zusätzlicher Post-Job-Refresh: pollt `runner.isPosterRunning()`/`isTrailerRunning()` alle 30 s, ruft nach Job-Ende + 5 s Buffer `updateAutoPlaylist` mit frischem ZIP-Set erneut auf. Max-Wait 30 min.
- **Trailer-Downloader unverträglich mit TMDB-Hint-Format** (`poster-updater/download-trailers.py`, `poster-updater/download-trailers-youtube.py`): Patch 51 (TMDB-ID-Hint im Filmliste-Format `Titel (Jahr)[tmdb:NNN]`) wurde nur im PosterPack-Downloader (`tmdb-get-posters-direct.py`) eingebaut — die Trailer-Scripts erwarteten weiterhin reines `Titel (Jahr)` und lehnten alle Einträge mit Hint als „Format ungueltig" ab (1265/1265 Fehler bei einer 1265-Filme-Liste). **Fix:** Optionalen `[tmdb:NNN]`-Suffix vor dem Format-Match abstrippen.

### Neu
- **4 Download-Buttons im Admin-UI** für Diagnostics + Reports:
  - **PosterPack Download → Log**: Output (stdout+stderr) des letzten/laufenden PosterPack-Jobs als `posterpack-log-YYYY-MM-DDTHH-MM-SS.txt`. In-Memory-Ringbuffer (max 5 MB pro Job) im `lib/poster-updater-runner.js`.
  - **PosterPack Download → Liste**: Alle vorhandenen PosterPacks (sortiert über alle 5 Quellen `manual`/`plex-export`/`jellyfin-emby-export`/`tmdb-export`/`romm-export`) als `posterpacks-...txt`.
  - **Trailer Download → Log**: Output des letzten/laufenden Trailer-Jobs als `trailer-log-...txt`.
  - **Letzter Sync-Report → JSON**: Cache-Datei `cache/emby-sync-last-report.json` als `emby-sync-report-...json` mit korrekter Content-Disposition.
- Endpoints (alle hinter `isAuthenticated`): `GET /api/poster-updater/run/log`, `GET /api/poster-updater/trailers/run/log`, `GET /api/poster-updater/posterpacks/list`, `GET /api/emby-sync/last-report/download`.

### Bekannte Gotchas
- Beim Wechsel auf neue Posterrama-Version sollten alte korrupte `config.json` (mit `_xxx`/`env`/`defaults`-Top-Level-Keys aus dem ehemaligen Class-Instance-Serialization-Bug) **nicht manuell gefixt werden** — der erste Save aus dem Admin-UI räumt sie automatisch via Self-Heal-Block in `routes/emby-sync.js` auf.

---

## [3.0.1x] – 2026-04-25

Pi-Setup-Resilienz: Cloudflare-Tunnel als sicherer Außenzugang, Watcher-Self-Heal-Bugfix, Bluetooth-Auto-Reconnect, Power-Cycle-Direktive in der Doku verankert.

### Neu
- **`docs/CLOUDFLARE-TUNNEL.md`** — Setup-Doku für `cloudflared` als Public-Endpoint von Posterrama. Tunnel `pr-go27` reicht `https://posterrama.example.com/` an `localhost:4000` durch, **Cloudflare Access** mit E-Mail-OTP-Login ist vorgeschaltet (Cinema/Wallart sind nicht mehr "wer-die-URL-kennt-kommt-rein"). Kein Port-Forwarding, kein Cert-Management, TLS terminiert bei Cloudflare.
- **`docs/BLUETOOTH-AUDIO.md`** — Setup-Doku für robusten Bluetooth-Audio-Anschluss (hier: Anker Soundcore 3). Drei Schichten: bluez Trust + main.conf-Tuning (`AutoEnable`, `FastConnectable`, `ReconnectAttempts`), User-systemd-Watcher (Polling 30 s), PipeWire-Stack. Reconnect garantiert nach Lautsprecher-Standby, Power-Cycle, Reichweiten-Verlust — ohne Login.

### Geändert
- **`docs/MONITOR-POWER-WATCHER.md`** — Self-Heal-Block dokumentiert: Wenn Monitor=off und Chromium-PIDs nicht im `T`-Status, wird `SIGSTOP` jeden Tick nachgeschickt. Behebt Boot-Race, bei dem der Watcher vor Chromium startet, beim Init-Block keine Prozesse findet, und dann nie wieder reagiert (Übergang `prev=off → curr=off` triggert klassisch nichts). Zusätzlich `loginctl enable-linger`-Hinweis im Setup, weil ohne Linger der User-systemd-Manager bei reinem Power-Cycle ohne Login nicht startet.

### Bekannte Gotchas
- `Trusted=yes` allein reicht nicht für robusten Bluetooth-Reconnect — bluez triggert nur, wenn das Gerät beim Adapter-Power-On gerade advertised. BR/EDR-Geräte advertisen nur kurz nach Einschalten. Polling-Watcher als Backstop notwendig.
- `cloudflared tunnel info` schlägt mit `sudo` fehl ("Cannot determine default origin certificate"), weil das Account-Cert in `~/.cloudflared/cert.pem` (User-Home) liegt, nicht in `/root/`. Ohne sudo aufrufen.

---

## [3.0.1w] – 2026-04-24

3-Schichten-Backup-Strategie: Config-Backup-Scope erweitert, NAS-Mirror-Script ergänzt, Strategie dokumentiert.

### Neu
- **NAS-Mirror-Script** (`scripts/backup/backup-to-nas.sh` + Systemd-Units unter `scripts/backup/systemd/`) — Template für täglichen rsync-Mirror über SMB zu einem NAS. Stumm-Skip bei Offline, strikter `--delete`-Mirror (Point-in-Time-Recovery via NAS-Snapshots).
- **`docs/BACKUP-STRATEGY.md`** — dokumentiert die 3-Schichten-Strategie (lokaler Config-Backup + NAS-Mirror + Snapshots), Recovery-Szenarien, Monitoring.

### Geändert
- **`utils/configBackup.js` FILE_WHITELIST erweitert** um `profiles.json`, `public/cinema-playlists.json`, `public/cinema-playlist.json`, `poster-updater/filmliste.txt`. Der eingebaute Config-Backup-Scheduler (täglich 03:30, Retention 10 Stück / 30 Tage) sichert jetzt auch den User-kuratierten Playlist-State und die Filmliste mit TMDB-Hints.

### Bekannte Gotchas
- `mount.cifs`-Option `ro=false` ist kein gültiger Parameter und wird von manchen Kernels als `ro` interpretiert → Mount wird read-only. Korrekt: `rw` explizit oder weglassen (rw ist Default).

---

## [3.0.1v] – 2026-04-24

Migration: bestehende Filmliste-Einträge bekommen ihre TMDB-IDs nachträglich als `[tmdb:NNNN]`-Hint eingetragen.

### Neu
- **`scripts/backfill-tmdb-hints.js`** — One-Shot-Migration: liest `poster-updater/filmliste.txt`, scannt für Einträge ohne Hint die ZIP-`metadata.json`-Dateien (lokal, kein API-Call) und ergänzt die gefundene `tmdb_id` als Suffix. Für Einträge ohne ZIP fragt es `ProviderIds.Tmdb` aus den konfigurierten Emby/Jellyfin-Servern ab (2-stufiger Fallback). Dry-Run-Default, automatisches Backup, `--execute` für Schreiben.

### Ergebnis auf dieser Installation
- 1184 Einträge per ZIP-metadata-Scan ergänzt (keine API-Calls nötig).
- 0 aus Emby ergänzt (alle ZIPs hatten bereits vollständige metadata.json).
- 5 Einträge ohne Hint verbleiben — alle sind Test-/Non-Movies (`TRAILER DISK V00 (2022)`, `SOUND TRAILER V01 (2023) (2023)`, `TRAILER DISK V01 (2023)`) oder haben einen Tippfehler im Titel (`Erkan und Stefan gegen die Maechte der Finsternis (2002)` — "Maechte" statt "Mächte" + kein lokales ZIP + kein Emby-Match).
- Resultat: **1258 von 1263 Einträgen (99.6%) haben jetzt TMDB-Hints**. Zukünftige Re-Downloads dieser Filme nutzen die authoritative TMDB-ID ohne Suche.

---

## [3.0.1u] – 2026-04-24

Prevention: TMDB-ID-Hint im Filmliste-Format. Verhindert künftige Entstehung von PosterPack-Duplikaten aufgrund falscher TMDB-Treffer.

### Neu
- **Filmliste-Format-Erweiterung** — Einträge können optional den Suffix `[tmdb:NNNN]` tragen: z. B. `Hamlet (2000)[tmdb:10688]`. Wird der Suffix gefunden, überspringt der Python-Downloader (`tmdb-get-posters-direct.py`) die Title+Year-Suche und nutzt die TMDB-ID direkt. Verhindert Fehltreffer bei Titel-Mehrdeutigkeiten (z. B. drei verschiedene "Hamlet"-Filme).
- **`lib/emby-sync.js`** schreibt den TMDB-ID-Hint automatisch, wenn Emby/Jellyfin ihn als `ProviderIds.Tmdb` liefert. Für manuell per Admin-UI hinzugefügte Filme ohne bekannte ID bleibt das alte Suchverhalten.
- **`lib/poster-updater-runner.js::appendFilms`** versteht das neue Format. Dedup basiert weiterhin auf dem Titel-Year-Teil; wenn ein bestehender Eintrag ohne Hint durch einen mit Hint ersetzt wird, ist das ein "Upgrade" (kein Duplikat).
- **`routes/poster-updater.js`** — GET `/films` liefert weiterhin die Titel ohne Suffix (UI-freundlich); DELETE `/films/:name` matcht per Title-Year-Basis.

### Geändert
- **`poster-updater/tmdb-get-posters-direct.py`** — Parst `[tmdb:N]`-Hint, verifiziert via `GET /movie/{id}`, fällt auf Title+Year-Suche zurück falls Hint ungültig.

### Betroffener Prevention-Case
- Emby (LightStar) hatte `Hamlet (2000)` mit korrekter TMDB-ID 10688. Der Python-Downloader suchte bisher nach "Hamlet 2000" in TMDB, traf dabei aber TMDB-ID 10264 (der 1990er Zeffirelli-Hamlet), was zu einem falsch benannten ZIP führte. Mit dem Hint wird 10688 jetzt direkt verwendet.

---

## [3.0.1t] – 2026-04-24

Erweiterung des Dedup-Scripts um einen `--normalize-title`-Modus: TMDB-Title wird zusätzlich zur Jahreszahl als Single-Source-of-Truth für den kanonischen Dateinamen verwendet.

### Neu
- **`scripts/dedup-posterpacks.js --normalize-title`** — TMDB liefert den kanonischen Titel (`de-DE` mit `en-US`-Fallback); ZIPs mit abweichenden Titel-Schreibweisen bei gleicher `tmdb_id` werden zum TMDB-Titel umbenannt oder als Duplikat gelöscht. Sanitizing für Dateisystem (NFC, `/`, NUL). Innerhalb jeder Gruppe wird die größte ZIP (reichste Metadaten/Assets) für Rename bevorzugt.

### Ergebnis auf dieser Installation
- 214 ZIPs gelöscht (Titel-Varianten wie `Banlieue 13` → `Ghettogangz`, `Ant Man` → `Ant-Man`, `Æon Flux` vs `Aeon Flux`, Komma-/Doppelpunkt-Varianten).
- 6 ZIPs umbenannt (z. B. `Ocean's 13` statt `Ocean’s 13` mit Typo-Apostroph, `E.T. - Der Außerirdische` statt `Ausserirdische`).
- 300 Playlist-Einträge, 220 Filmliste-Einträge, 211 Trailer-Info-Keys konsolidiert; 181 redundante Trailer gelöscht, 31 umbenannt.
- **0 verbliebene TMDB-ID-Duplikate** (1188 distinct IDs = 1188 ZIPs, 1:1 mapping).

### Hinweis für zukünftige Läufe
- Der Python-Downloader `tmdb-get-posters-direct.py` sucht TMDB per Titel+Jahr und kann bei Mehrdeutigkeiten die falsche ID treffen (z. B. `Hamlet (2000)` → wählt TMDB 10264 = 1990er Zeffirelli statt 10688 = 2000er Almereyda). Empfohlener Prevention-Schritt (künftig): TMDB-ID-Hint aus Emby-sync direkt an den Downloader weiterreichen. Aktuell: bei wiederkehrenden Duplikaten einfach `node scripts/dedup-posterpacks.js --normalize-title --execute` erneut laufen lassen.

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
