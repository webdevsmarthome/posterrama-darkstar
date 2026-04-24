# Posterrama Custom Patches & Erweiterungen

**Stand:** 2026-04-23 (basierend auf Version 3.0.1p)
**Zweck:** Diese Datei dokumentiert alle Custom-Patches und Erweiterungen, die nach einem offiziellen Posterrama-Update erneut eingespielt werden muessen.
**Release-Historie:** Siehe [CHANGELOG.md](./CHANGELOG.md) fuer die versionierte Uebersicht aller Aenderungen seit v3.0.1.

---

## Uebersicht der Aenderungen

| # | Bereich | Dateien | Beschreibung |
|---|---------|---------|--------------|
| 1 | Poster Updater | admin.html, admin.css, admin.js, server.js | Poster Updater als eigener Menuepunkt im Admin |
| 2 | Playlist Editor | admin.html, admin.css, admin.js, server.js, routes/poster-selector.js | Multi-Playlist-Verwaltung mit Drag & Drop |
| 3 | Trailer Download | poster-updater/download-trailers.py, routes/poster-updater.js, admin.html, admin.js | Lokale Trailer herunterladen (yt-dlp) |
| 4 | Lokale Trailer-Wiedergabe | cinema-display.js, cinema-display.css, sources/local.js, server.js | HTML5-Video statt YouTube-iframe |
| 5 | Playlist Live-Sync | cinema-display.js, device-mgmt.js, routes/poster-selector.js | Sofortige Playlist-Aktualisierung auf Monitoren |
| 6 | TMDB Suche deutsch | routes/media.js | Deutsche Filmtitel in der Suche |
| 7 | ZIP-Loeschung | routes/poster-updater.js | ZIP beim Film-Entfernen mitloeschen |
| 8 | Service Worker | public/sw.js | cinema-display.js vom SW-Cache ausschliessen |
| 9 | Playlist Matching | cinema-display.js | Tolerantes Title-Matching + fileTitle |
| 10 | fileTitle Feld | sources/local.js | ZIP-Dateiname als fileTitle am Media-Item |
| 11 | Trailer-Typ-Erkennung | poster-updater/scan-trailer-types.py, routes/poster-selector.js, admin.html, admin.js, admin.css | Trailer-Typ-Badges (DE-offiziell, DE, EN-offiziell, EN) + Filter im Playlist Editor |
| 12 | Multi-Playlist-System | routes/poster-selector.js, admin.html, admin.js, admin.css | Benannte Playlisten erstellen, wechseln, aktivieren, duplizieren, loeschen |
| 13 | Trailer sofort stoppen | cinema-display.js | Trailer wird sofort gestoppt wenn Poster manuell gewechselt wird |
| 14 | Lokaler Trailer Prioritaet | sources/local.js | Trailer in /media/trailers/ hat immer Vorrang vor ZIP- und metadata.json-Trailern |
| 15 | Unicode-Normalisierung | sources/local.js, routes/poster-selector.js | NFD/NFC-Fallback fuer Umlaute in Trailer-Dateinamen und Trailer-Info-Lookup (macOS-Kompatibilitaet) |
| 16 | Zufall-Sortierung | admin.html, admin.js | Zufall-Button (Fisher-Yates Shuffle) in der Playlist-Sortierung |
| 17 | Film-Loeschung Playlist-Sync | routes/poster-updater.js | Beim Loeschen eines Films wird dieser automatisch aus allen Playlisten entfernt |
| 18 | YouTube Trailer Downloader | poster-updater/download-trailers-youtube.py | Direkte YouTube-Suche fuer Trailer ohne TMDB (yt-dlp ytsearch) |
| 19 | Screensaver Trailer | screensaver.js, screensaver.css, screensaver-bootstrap.js | Trailer-Wiedergabe im Screensaver-Modus (unten links, 21:9, 60% Breite) |
| 20 | Screensaver Playlist | screensaver-bootstrap.js, screensaver.js | Aktive Playlist gilt auch fuer Screensaver-Modus |
| 21 | showTrailer Toggle | config.json, admin.html, admin.js, cinema-display.js, screensaver.js | Globaler Schalter Trailer EIN/AUS in Admin Visual Elements |
| 22 | Screensaver Layout | screensaver.css | Uhr (oben links), ClearLogo (oben rechts), Trailer (unten links) mit einheitlichem 3vh Abstand |
| 23 | Cinema Trailer Scale | cinema-display.css | scale(1.20) statt scale(1.25) fuer gleichmaessigen 16:9→21:9 Crop |
| 24 | RT-Badge Cleanup | screensaver.js | RT-Badge wird nicht ins DOM eingefuegt wenn Rotten Tomatoes deaktiviert |
| 25 | PosterPack Creator | routes/posterpack-creator.js, admin.html, admin.js, admin.css, server.js | Eigener Menuepunkt: Formular fuer Titel/Jahr/Poster/Background/Trailer → ZIP erstellen |
| 26 | Poster Updater Trailer-Status | routes/poster-updater.js, admin.js | Trailer-Badges + Filter im Poster Updater (wie Playlist Editor) |
| 27 | Eigene PosterPacks Upload | admin.html, admin.js, admin.css | Drag & Drop ZIP-Upload im Poster Updater |
| 28 | Konfig. Trailer-Timings | config.json, admin.html, admin.js, screensaver.js | trailerDelaySeconds, trailerPauseAfterSeconds, noTrailerDisplaySeconds konfigurierbar |
| 29 | Screensaver Playlist nahtlos | screensaver.js | Playlist-Wechsel ohne Page-Reload (inline Media-Queue Refresh) |
| 30 | dotenv-Bereinigung | download-trailers.py, scan-trailer-types.py, tmdb-get-posters-direct.py | Alle Python-Scripts lesen config.json statt .env |
| 31 | .gitignore Erweiterung | .gitignore | filmliste.txt, .env, Patch/Backup-Artifacts ignoriert |
| 32 | PosterPack Studio (Edit) | routes/posterpack-creator.js, admin.html, admin.js | Creator → Studio: Bestehende PosterPacks laden, bearbeiten, aktualisieren (Dropdown + Vorschauen) |
| 33 | Poster Updater Filter-Fix | admin.js | withTrailer-Zahl bleibt nach Filter-Klick korrekt |
| 34 | Filmliste Hoehe | admin.css | Filmliste max-height auf 562px angepasst |
| 35 | TMDB Clearlogo Fetcher | poster-updater/fetch-clearlogos.py | Laedt fehlende Clearlogos von TMDB und fuegt sie in bestehende ZIPs ein |
| 36 | TMDB Backdrop Fetcher | poster-updater/fetch-backdrops.py | Laedt fehlende Backgrounds von TMDB und fuegt sie in bestehende ZIPs ein |
| 37 | Cinema Trailer Loop-Fix | cinema-display.js | 1-Loop Autohide prueft VOR Video-Neustart, nicht danach (kein doppeltes Abspielen) |
| 38 | Cinema Trailer Crop | cinema-display.js, cinema-display.css | Video +16px/-8px Oversize um schwarze Raender abzuschneiden, Rahmen beibehalten |
| 39 | Cinema Trailer Layout | cinema-display.css | Breite 0.90, Abstand 20px, aspect-ratio 21/8.7 |
| 40 | Playlist Polling | cinema-display.js, screensaver.js | Playlist-Aenderung per 5s Polling statt WebSocket/BroadcastChannel (cross-device) |
| 41 | Playlist Activate Broadcast | admin.js | BroadcastChannel-Notify bei Playlist-Aktivierung (same-browser Fallback) |
| 42 | Playlist Count Update | admin.js | Dropdown-Zaehler aktualisiert bei Add/Remove Film |
| 43 | Screensaver Trailer Fixes | screensaver.js, screensaver.css | Autoplay triple-fallback, Video-Crop, Duplicate-Keyhandler entfernt, alle 4 Transition-Pfade mit Trailer |
| 44 | Screensaver startCycler Fix | screensaver.js | startCycler() aus next/prev/resume entfernt — createTrailerOverlay verwaltet Timer allein |
| 45 | Broadcast Debug Logging | routes/poster-selector.js | Logging fuer playlist.refresh Broadcast (Diagnose) |
| 46 | Tagline Fetcher | poster-updater/fetch-taglines.py, tmdb-get-posters-direct.py | Laedt fehlende Taglines von TMDB (DE bevorzugt, EN Fallback) und fuegt sie in ZIPs ein |
| 47 | Metadata-Extras Fetcher | poster-updater/fetch-metadata-extras.py, tmdb-get-posters-direct.py | Certification (FSK), Director, Studio von TMDB in alle ZIPs |
| 48 | PosterPack Studio erweitert | routes/posterpack-creator.js, admin.html, admin.js | Neue Felder: Regisseur, Studio, Aufloesung, Audio, Seitenverhaeltnis, HDR |
| 49 | Emby-Sync + Auto-Playlist + Ignore-Liste | lib/emby-sync.js, lib/poster-updater-runner.js, routes/emby-sync.js, routes/poster-updater.js (Refactor auf Runner), routes/poster-selector.js (Auto-Playlist-Schutz), utils/jellyfin-http-client.js (sortOrder), config.json/example/schema (embySync-Block + LightStar), admin.html/js/css, .env (JELLYFIN_API_KEY_LIGHTSTAR) | Regelmäßiger Abgleich beider Emby-Server, automatischer PosterPack-/Trailer-Download für neue Filme, Ignore-Liste im Admin-UI, Auto-Playlist "Die letzten 20 hinzugefügten Filme" |
| 50 | PosterPack-Dedup-Script (TMDB-authoritative Year + Title) | scripts/dedup-posterpacks.js | One-Shot-Maintenance: ZIPs mit gleicher tmdb_id aber abweichenden Filename-Parts (Jahr und/oder Titel-Schreibweise) werden zusammengeführt. TMDB-API liefert authoritative Release-Jahr und Titel (de-DE mit en-US-Fallback). `--normalize-title` aktiviert auch Titel-Kanonisierung. Aktualisiert Sidecars, Playlists, Filmliste, Trailer-Info. Dry-Run-Default. |
| 51 | TMDB-ID-Hint im Filmliste-Format (Prevention gegen Mehrdeutigkeits-Fehltreffer) | poster-updater/tmdb-get-posters-direct.py, lib/emby-sync.js, lib/poster-updater-runner.js (appendFilms-Upgrade-Semantik + stripTmdbHint-Helper), routes/poster-updater.js (GET zeigt Titel ohne Suffix, DELETE matcht per Title-Year) | Filmliste-Einträge können optional `[tmdb:NNNN]` tragen. Python-Downloader nutzt die ID direkt, überspringt die Title+Year-Suche. Emby-sync schreibt den Hint automatisch aus `ProviderIds.Tmdb`. |
| 52 | Backfill-Script für TMDB-Hints | scripts/backfill-tmdb-hints.js | One-Shot-Migration: ergänzt bestehende Filmliste-Einträge ohne `[tmdb:N]`-Hint um die TMDB-ID aus vorhandener ZIP-`metadata.json` (primär) oder Emby `ProviderIds.Tmdb` (Fallback). Dry-Run-Default. |
| 49 | Media-Aggregator erweitert | lib/media-aggregator.js | Director, Studio, Resolution, Audio, AspectRatio, HDR aus ZIP-Metadata durchreichen |
| 50 | Config-Public Fix | routes/config-public.js | config.config statt config fuer Raw-Werte (uiScaling, showRottenTomatoes etc. wurden ignoriert) |
| 51 | style.css background Fix | public/style.css | background-image statt background Shorthand (verhinderte background-size:contain) |
| 52 | Poster-Link Fix | public/style.css | #poster-link display:block+100% fuer Chrome/Safari (poster-wrapper Kind hatte 0x0) |
| 53 | Poster dynamische Hoehe | public/screensaver/screensaver.js | Wrapper-Hoehe passt sich per JS an Poster-Seitenverhaeltnis an |
| 54 | Screensaver style.css Cache | routes/frontend-pages.js, public/sw.js | style.css Cache-Buster + SW-Bypass fuer Screensaver-Route |
| 55 | Screensaver Inline-CSS Fix | public/screensaver.html | background-size:contain statt cover in Inline-CSS |
| 56 | Unicode NFC-Normalisierung | posterpack-creator.js, download-trailers.py, download-trailers-youtube.py, scan-trailer-types.py, poster-updater.js | Alle Trailer-Schreibstellen normalisieren Dateinamen + JSON-Keys zu NFC — verhindert NFC/NFD-Duplikate |
| 57 | Trailer-Info Cleanup bei Loeschung | routes/poster-updater.js | Beim Loeschen eines Films wird der Eintrag aus trailer-info.json entfernt |
| 58 | PosterPack Branding | 26 Dateien | Einheitliche Schreibweise "PosterPack" statt "Posterpack" |
| 59 | Playlist Editor Sortierung | routes/poster-selector.js, admin.html, admin.js, admin.css | Sortier-Buttons (A–Z, Z–A, Neueste) fuer verfuegbare PosterPacks im Playlist Editor |
| 60 | Cinema Footer Metadaten | lib/media-aggregator.js, public/cinema/cinema-display.js, public/cinema/cinema-display.css | Genre/Regisseur/Studio in Detail-Zeile, Aspect-Ratio-Normalisierung (10 Cinema-Formate), HDR/Dolby-Vision-Erkennung aus PosterPack-`hdr`-Feld |
| 61 | Cinema Footer Dual-Row | public/cinema/cinema-display.css | Vertikaler Separator vor zweiter Footer-Zeile im Dual-Row-Modus entfernt |
| 62 | Media Flag Icons | public/icons/aspectratio, audio, mpaa, music, resolution, rottentomatoes, source, studio, videocodec | Icon-Sets fuer Metadaten-Anzeige im Cinema Footer |
| 63 | ZIP-Metadata-Durchreichung | lib/media-aggregator.js | genres, director, studio, resolution, audioCodec, aspectRatio, hdr werden aus ZIP-`metadata.json` an das Media-Item durchgereicht |

---

## Neue Dateien (komplett uebernehmen)

Diese Dateien existieren im Original nicht und muessen 1:1 kopiert werden:

### `routes/poster-selector.js`
Playlist Editor Backend — Multi-Playlist-API (CRUD, Aktivierung), Trailer-Info, WebSocket-Broadcast.
**Endpoints:**
- GET/PUT /playlist, PUT /playlist/toggle (Live-Playlist fuer Displays)
- GET /films (mit Trailer-Info: hasTrailer, trailerType)
- GET/POST /playlists, PUT/DELETE /playlists/:id, PUT /playlists/:id/activate

### `routes/poster-updater.js`
Poster-Updater Backend — Film-Verwaltung, PosterPack-Download, **Trailer-Download** (neu).
**Achtung:** Diese Datei existiert moeglicherweise im Original, wurde aber erweitert:
- ZIP-Loeschung beim Film-Entfernen (DELETE /films/:name)
- Trailer-Download Endpoints (/trailers/run, /trailers/run/status, /trailers/run/stop)
- Playlist-Sync: Geloeschte Filme werden automatisch aus allen Playlisten entfernt (inkl. Live-Playlist)

### `poster-updater/download-trailers.py`
Python-Script fuer YouTube-Trailer-Download via yt-dlp.
Speichert Trailer-Typ-Info in `media/trailers/trailer-info.json`.
Liest TMDB API Key aus `.env` oder Fallback aus `config.json`.
Benoetigt: `pip3 install --break-system-packages yt-dlp`

### `poster-updater/scan-trailer-types.py`
Einmal-Script: Ermittelt Trailer-Typen (DE-offiziell, DE, EN-offiziell, EN) fuer alle vorhandenen Trailer per TMDB API.
Ergebnis: `media/trailers/trailer-info.json`
Ausfuehren: `cd poster-updater && python3 scan-trailer-types.py`

### `poster-updater/download-trailers-youtube.py`
YouTube Trailer Downloader — Sucht Trailer direkt auf YouTube (ohne TMDB) fuer Filme ohne Trailer.
Nutzt `yt-dlp ytsearch` mit Prioritaet: Deutsch > Englisch.
Speichert Trailer-Typ in `trailer-info.json`. Ausfuehren: `cd poster-updater && python3 download-trailers-youtube.py`

### `public/cinema-playlists.json`
Sammlung aller benannten Playlisten. Wird automatisch beim ersten Aufruf aus `cinema-playlist.json` migriert.

### `routes/posterpack-creator.js`
PosterPack Studio Backend — Create + Edit. Multipart-Upload (multer), ZIP-Erstellung (JSZip), Trailer-Handling.
Endpoints: `GET /api/posterpack-creator/read/:packName`, `POST /api/posterpack-creator/create`, `POST /api/posterpack-creator/update/:packName`

---

## Patch-Details pro Datei

### 1. `server.js`

**a) Poster Updater Route (nach den Local-Directory-Routes):**
```js
// === POSTER UPDATER ROUTES ===
const createPosterUpdaterRouter = require('./routes/poster-updater');
app.use('/api/poster-updater', isAuthenticated, createPosterUpdaterRouter({ logger }));
app.get('/poster-updater', isAuthenticated, (req, res) => {
    res.redirect('/admin#operations');
});
```

**b) Lokale Trailer-Dateien servieren:**
```js
// === LOCAL TRAILER FILES ===
app.use('/trailers', express.static(path.join(__dirname, 'media', 'trailers'), {
    maxAge: '7d',
    acceptRanges: true,
}));
```

**c) Poster Selector Route:**
```js
// === POSTER SELECTOR ROUTES ===
const createPosterSelectorRouter = require('./routes/poster-selector');
app.use('/api/poster-selector', isAuthenticated, createPosterSelectorRouter({ logger, wsHub }));
```

### 2. `public/admin.html`

**a) Sidebar — 2 Menuepunkte:**
```html
<a href="#" class="nav-item" data-nav="poster-updater"><i class="fas fa-film"></i><span>Poster Updater</span></a>
<a href="#" class="nav-item" data-nav="poster-selector"><i class="fas fa-th-list"></i><span>Playlist Editor</span></a>
```

**b) Section "Poster Updater":**
- Kompakter Header mit Film-Icon
- Zwei Spalten: Filmliste + TMDB-Suche (links), PosterPack-Download + Trailer-Download (rechts)
- Delete-Modal nach `</main>`

**c) Section "Playlist Editor":**
- Zwei Spalten Layout
- Links: Verfuegbare PosterPacks mit Trailer-Typ-Badges + Trailer-Filter-Buttons (Alle, DE-off., DE, EN-off., EN, Kein Trailer)
- Rechts: Playlist-Dropdown (Multi-Playlist), Aktiv-Indikator, Neu/Duplizieren/Umbenennen/Loeschen-Buttons, Toggle, Sort-Buttons, Drag & Drop

### 3. `public/admin.css`

Alle Styles mit Prefix `pu-` (Poster Updater) und `ps-` (Playlist Editor):
- Film-Listen, Filter-Buttons, Badges
- Terminal-Styles fuer Download-Output
- Drag & Drop Styles (Handle, Drop-Indicator)
- Toggle-Switch fuer Playlist aktiv/inaktiv
- Sort-Buttons, Trailer-Typ-Pills (farbkodiert)
- Playlist-Selector-Bar, Aktiv-Indikator, Aktions-Buttons

### 4. `public/admin.js`

**a) Nav-Registrierung in `ensureNavActive()` Map:**
```js
'section-poster-updater': 'poster-updater',
'section-poster-selector': 'poster-selector',
```

**b) `showSection()` — Page-Header ausblenden:**
```js
} else if (id === 'section-poster-updater') {
    pageHeader.style.display = 'none';
} else if (id === 'section-poster-selector') {
    pageHeader.style.display = 'none';
}
```

**c) Nav-Click-Handler:**
```js
} else if (nav === 'poster-updater') {
    showSection('section-poster-updater');
} else if (nav === 'poster-selector') {
    showSection('section-poster-selector');
}
```

**d) Poster Updater IIFE** (am Ende der Datei):
- Film-Liste laden/rendern, TMDB-Suche, PosterPack-Download-Runner
- Trailer-Download-Runner (SSE)
- Delete-Modal, Filter, Stats

**e) Playlist Editor IIFE** (am Ende der Datei):
- Multi-Playlist-System: psPlaylists, psActivePlaylistId, psCurrentPlaylistId
- Playlist-Selector-Dropdown mit Aktionsbuttons (Neu, Duplizieren, Umbenennen, Loeschen, Aktivieren)
- Verfuegbare PosterPacks mit Trailer-Typ-Badges + Trailer-Filter
- Drag & Drop Sortierung, Hoch/Runter-Buttons, Sort-Buttons (A-Z, Z-A, Jahr)
- Toggle fuer Playlist aktiv + BroadcastChannel Notification

### 5. `public/cinema/cinema-display.css`

**Trailer iframe Zoom:**
```css
transform: translateY(-50%) scale(1.25); /* 25% Zoom um schwarze Balken bei 21:9 abzuschneiden */
```

### 6. `public/cinema/cinema-display.js`

**a) `createTrailerOverlay()` — Sofortiges Stoppen bei Posterwechsel:**
- `removeTrailerOverlaySync()` wird immer aufgerufen wenn ein neues Poster erscheint
- Alter Trailer wird sofort gestoppt, nicht erst wenn neuer Trailer startet

**b) `startTrailerPlayback()` — Komplett umgebaut:**
- **Prioritaet 1:** Lokaler Trailer (`/trailers/*.mp4`, `/local-posterpack?`) -> HTML5 `<video>`
- **Prioritaet 2:** Poster normal anzeigen (kein Trailer)
- **Fallback:** YouTube-iframe (nur wenn explizite YouTube-URL)

**c) YouTube-iframe Parameter (Fallback):**
- `youtube-nocookie.com` statt `youtube.com`
- `showinfo=0&cc_load_policy=0` gegen Einblendungen
- Verzoegertes Unmute nach 2s

**d) `refreshPlaylist()` in `__posterramaPlayback`:**
```js
refreshPlaylist: async () => {
    mediaQueue = await fetchMediaQueue();
    if (mediaQueue.length > 0) {
        currentMediaIndex = 0;
        isFirstPoster = false;
        updateCinemaDisplay(mediaQueue[0]);
    }
}
```

**e) BroadcastChannel Listener fuer Playlist-Updates**

**f) `fetchMediaQueue()` — Tolerantes Playlist-Matching:**
- `normalize()` entfernt `(YYYY)` Jahreszahl, Apostrophe, Bindestriche
- Matching prueft `it.title` UND `it.fileTitle`

### 7. `public/device-mgmt.js`

**WebSocket-Command `playlist.refresh`:**
```js
if (t === 'playlist.refresh' && api.refreshPlaylist) {
    liveDbg('[Live] invoking playlist.refresh');
    api.refreshPlaylist();
    return void sendAck('ok');
}
```

### 8. `public/sw.js`

- Version von 2.2.9 auf 2.3.0 erhoehen
- `cinema-display.js` vom Cache ausschliessen

### 9. `sources/local.js`

**a) `fileTitle` Feld am Media-Item:**
```js
fileTitle: metadata.title || '',
```

**b) `_findLocalTrailer()` — Mit NFD/NFC-Fallback:**
- Prueft ob `media/trailers/Film (Jahr)-trailer.mp4` existiert
- Fallback: `readdirSync` + Unicode-Normalisierung (NFC/NFD) fuer macOS-Kompatibilitaet

**c) `trailerUrl` Prioritaet — Lokaler Trailer hat Vorrang:**
```js
trailerUrl: this._findLocalTrailer(metadata.title, year) || trailerUrl || enrichedMeta.trailer || null
```

### 10. `routes/media.js`

**TMDB-Suche auf Deutsch:**
```js
language=de-DE statt language=en-US
```

### 11. `package.json`

**Version:** `3.0.1h` (statt `3.0.1`)

---

## Verzeichnisse die erhalten bleiben muessen

- `media/trailers/` — Heruntergeladene Trailer (.mp4 Dateien)
- `media/trailers/trailer-info.json` — Trailer-Typ-Cache (DE-offiziell, DE, EN-offiziell, EN)
- `poster-updater/` — Scripts + Filmliste + .env
- `public/cinema-playlist.json` — Aktive Live-Playlist (fuer Displays)
- `public/cinema-playlists.json` — Alle gespeicherten Playlisten

---

## Voraussetzungen

- **yt-dlp:** `pip3 install --break-system-packages yt-dlp`
- **Python-Pakete:** `requests`, `python-dotenv` (fuer download-trailers.py / scan-trailer-types.py)

---

## Nach einem Update: Schritt-fuer-Schritt

1. Backup der Custom-Dateien erstellen (oder git stash)
2. Update durchfuehren
3. Neue Dateien kopieren: `routes/poster-selector.js`, `poster-updater/download-trailers.py`, `poster-updater/scan-trailer-types.py`
4. `routes/poster-updater.js` pruefen — ggf. Trailer-Endpoints und ZIP-Loeschung nachpatchen
5. `server.js` — Route-Mounts hinzufuegen (Poster Updater, Trailer, Poster Selector)
6. `public/admin.html` — Sidebar-Eintraege + Sections hinzufuegen
7. `public/admin.css` — pu-/ps-Styles am Ende einfuegen
8. `public/admin.js` — Nav-Map, showSection, Click-Handler + IIFEs am Ende
9. `public/cinema/cinema-display.js` — Trailer-Logik, Playlist-Matching, Playback-API
10. `public/cinema/cinema-display.css` — scale(1.25) auf Trailer-iframe
11. `public/device-mgmt.js` — playlist.refresh Command
12. `public/sw.js` — Version erhoehen + cinema-display.js ausschliessen
13. `sources/local.js` — fileTitle + _findLocalTrailer (mit NFD/NFC) + trailerUrl Prioritaet
14. `routes/media.js` — TMDB Suche de-DE
15. `public/cinema-playlists.json` aus Backup wiederherstellen (oder automatisch migrieren lassen)
16. Server neu starten: `pm2 restart posterrama`
17. Browser-Cache auf allen Monitoren leeren
