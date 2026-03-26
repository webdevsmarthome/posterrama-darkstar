# Posterrama Custom Patches & Erweiterungen

**Stand:** 2026-03-26 (basierend auf Version 3.0.1b)
**Zweck:** Diese Datei dokumentiert alle Custom-Patches und Erweiterungen, die nach einem offiziellen Posterrama-Update erneut eingespielt werden muessen.

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
| 15 | Unicode-Normalisierung | sources/local.js | NFD/NFC-Fallback fuer Umlaute in Trailer-Dateinamen (macOS-Kompatibilitaet) |

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
Poster-Updater Backend — Film-Verwaltung, Posterpack-Download, **Trailer-Download** (neu).
**Achtung:** Diese Datei existiert moeglicherweise im Original, wurde aber erweitert:
- ZIP-Loeschung beim Film-Entfernen (DELETE /films/:name)
- Trailer-Download Endpoints (/trailers/run, /trailers/run/status, /trailers/run/stop)

### `poster-updater/download-trailers.py`
Python-Script fuer YouTube-Trailer-Download via yt-dlp.
Speichert Trailer-Typ-Info in `media/trailers/trailer-info.json`.
Liest TMDB API Key aus `.env` oder Fallback aus `config.json`.
Benoetigt: `pip3 install --break-system-packages yt-dlp`

### `poster-updater/scan-trailer-types.py`
Einmal-Script: Ermittelt Trailer-Typen (DE-offiziell, DE, EN-offiziell, EN) fuer alle vorhandenen Trailer per TMDB API.
Ergebnis: `media/trailers/trailer-info.json`
Ausfuehren: `cd poster-updater && python3 scan-trailer-types.py`

### `public/cinema-playlists.json`
Sammlung aller benannten Playlisten. Wird automatisch beim ersten Aufruf aus `cinema-playlist.json` migriert.

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
- Zwei Spalten: Filmliste + TMDB-Suche (links), Posterpack-Download + Trailer-Download (rechts)
- Delete-Modal nach `</main>`

**c) Section "Playlist Editor":**
- Zwei Spalten Layout
- Links: Verfuegbare Posterpacks mit Trailer-Typ-Badges + Trailer-Filter-Buttons (Alle, DE-off., DE, EN-off., EN, Kein Trailer)
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
- Film-Liste laden/rendern, TMDB-Suche, Posterpack-Download-Runner
- Trailer-Download-Runner (SSE)
- Delete-Modal, Filter, Stats

**e) Playlist Editor IIFE** (am Ende der Datei):
- Multi-Playlist-System: psPlaylists, psActivePlaylistId, psCurrentPlaylistId
- Playlist-Selector-Dropdown mit Aktionsbuttons (Neu, Duplizieren, Umbenennen, Loeschen, Aktivieren)
- Verfuegbare Posterpacks mit Trailer-Typ-Badges + Trailer-Filter
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

**Version:** `3.0.1b` (statt `3.0.1`)

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
