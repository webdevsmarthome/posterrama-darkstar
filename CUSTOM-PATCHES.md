# Posterrama Custom Patches & Erweiterungen

**Stand:** 2026-03-25 (basierend auf Version 3.0.1)
**Zweck:** Diese Datei dokumentiert alle Custom-Patches und Erweiterungen, die nach einem offiziellen Posterrama-Update erneut eingespielt werden müssen.

---

## Übersicht der Änderungen

| # | Bereich | Dateien | Beschreibung |
|---|---------|---------|--------------|
| 1 | Poster Updater | admin.html, admin.css, admin.js, server.js | Poster Updater als eigener Menüpunkt im Admin |
| 2 | Poster Selector | admin.html, admin.css, admin.js, server.js, routes/poster-selector.js | Playlist-Verwaltung mit Drag & Drop |
| 3 | Trailer Download | poster-updater/download-trailers.py, routes/poster-updater.js, admin.html, admin.js | Lokale Trailer herunterladen (yt-dlp) |
| 4 | Lokale Trailer-Wiedergabe | cinema-display.js, cinema-display.css, sources/local.js, server.js | HTML5-Video statt YouTube-iframe |
| 5 | Playlist Live-Sync | cinema-display.js, device-mgmt.js, routes/poster-selector.js | Sofortige Playlist-Aktualisierung auf Monitoren |
| 6 | TMDB Suche deutsch | routes/media.js | Deutsche Filmtitel in der Suche |
| 7 | ZIP-Löschung | routes/poster-updater.js | ZIP beim Film-Entfernen mitlöschen |
| 8 | Service Worker | public/sw.js | cinema-display.js vom SW-Cache ausschließen |
| 9 | Playlist Matching | cinema-display.js | Tolerantes Title-Matching + fileTitle |
| 10 | fileTitle Feld | sources/local.js | ZIP-Dateiname als fileTitle am Media-Item |

---

## Neue Dateien (komplett übernehmen)

Diese Dateien existieren im Original nicht und müssen 1:1 kopiert werden:

### `routes/poster-selector.js`
Poster-Selector Backend — API für Playlist-Verwaltung, WebSocket-Broadcast an Displays.

### `routes/poster-updater.js`
Poster-Updater Backend — Film-Verwaltung, Posterpack-Download, **Trailer-Download** (neu).
**Achtung:** Diese Datei existiert möglicherweise im Original, wurde aber erweitert:
- ZIP-Löschung beim Film-Entfernen (DELETE /films/:name)
- Trailer-Download Endpoints (/trailers/run, /trailers/run/status, /trailers/run/stop)

### `poster-updater/download-trailers.py`
Python-Script für YouTube-Trailer-Download via yt-dlp.
Benötigt: `pip3 install --break-system-packages yt-dlp`

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

**a) Sidebar — 2 neue Menüpunkte nach "Operations":**
```html
<a href="#" class="nav-item" data-nav="poster-updater"><i class="fas fa-film"></i><span>Poster Updater</span></a>
<a href="#" class="nav-item" data-nav="poster-selector"><i class="fas fa-th-list"></i><span>Poster Selector</span></a>
```

**b) Section "Poster Updater"** (vor dem Logs-Viewer):
- Kompakter Header mit Film-Icon
- Zwei Spalten: Filmliste + TMDB-Suche (links), Posterpack-Download + Trailer-Download (rechts)
- Delete-Modal nach `</main>` (neben anderen Modals)

**c) Section "Poster Selector"** (vor dem Logs-Viewer):
- Kompakter Header mit Listenicon
- Zwei Spalten: Verfügbare Filme (links), Playlist mit Toggle + Sort + Drag & Drop (rechts)

### 3. `public/admin.css`

Alle Styles mit Prefix `pu-` (Poster Updater) und `ps-` (Poster Selector):
- Film-Listen, Filter-Buttons, Badges
- Terminal-Styles für Download-Output
- Drag & Drop Styles (Handle, Drop-Indicator)
- Toggle-Switch für Playlist aktiv/inaktiv
- Sort-Buttons
- Lösch-Button

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

**e) Poster Selector IIFE** (am Ende der Datei):
- Verfügbare Filme laden, Playlist laden/speichern
- Drag & Drop Sortierung
- Hoch/Runter-Buttons, Sortier-Buttons (A-Z, Z-A, Jahr↑, Jahr↓)
- Toggle für Playlist aktiv + BroadcastChannel Notification
- Jahr-Lookup aus verfügbaren Filmen

### 5. `public/cinema/cinema-display.css`

**Zeile ~2879 — Trailer iframe Zoom:**
```css
transform: translateY(-50%) scale(1.25); /* 25% Zoom um schwarze Balken bei 21:9 abzuschneiden */
```
(Original hat nur `translateY(-50%)`)

### 6. `public/cinema/cinema-display.js`

**a) `loadYouTubeAPI()` — Timeout + Error-Handling:**
- Promise bekommt `reject` statt nur `resolve`
- 10s Timeout falls YouTube API nicht lädt
- `tag.onerror` Handler für Script-Ladefehler

**b) `startTrailerPlayback()` — Komplett umgebaut:**
- **Priorität 1:** Lokaler Trailer (`/trailers/*.mp4`, `/local-posterpack?`) → HTML5 `<video>`
  - Stumm starten, nach 2s Ton einschalten (PATCH-AUTOPLAY)
  - Loop-Support, Autohide-Timer
  - Im `.cinema-trailer-overlay` Container (nicht Fullscreen)
- **Priorität 2:** Poster normal anzeigen (kein Trailer)
- **Fallback:** YouTube-iframe (nur wenn explizite YouTube-URL)

**c) YouTube-iframe Parameter (Fallback):**
- `youtube-nocookie.com` statt `youtube.com`
- `showinfo=0&cc_load_policy=0` gegen Einblendungen
- `pointer-events: none` auf iframe
- Verzögertes Unmute nach 2s statt sofort

**d) `refreshPlaylist()` — Neue Methode in `__posterramaPlayback`:**
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

**e) BroadcastChannel Listener für Playlist-Updates:**
- Hört auf `posterrama-config` Channel
- Bei `playlist-updated` Message: Playlist neu laden + erstes Poster anzeigen

**f) `fetchMediaQueue()` — Tolerantes Playlist-Matching:**
- `normalize()` entfernt jetzt auch `(YYYY)` Jahreszahl am Ende
- Matching prüft `it.title` UND `it.fileTitle`

### 7. `public/device-mgmt.js`

**Neuer WebSocket-Command `playlist.refresh`:**
```js
if (t === 'playlist.refresh' && api.refreshPlaylist) {
    liveDbg('[Live] invoking playlist.refresh');
    api.refreshPlaylist();
    return void sendAck('ok');
}
```
(Eingefügt nach dem `power.toggle` Block)

### 8. `public/sw.js`

**a) Version von 2.2.9 auf 2.3.0 erhöht**

**b) `cinema-display.js` vom Cache ausschließen:**
```js
if (url.pathname === '/error-handler.js' || url.pathname === '/ui/auto-loader.js' || url.pathname === '/cinema/cinema-display.js') {
```

### 9. `sources/local.js`

**a) `fileTitle` Feld am Media-Item (in `createMediaItem`):**
```js
fileTitle: metadata.title || '', // title parsed from ZIP filename (without year)
```

**b) `_findLocalTrailer()` — Neue Methode:**
Prüft ob `media/trailers/Film (Jahr)-trailer.mp4` existiert und gibt lokalen URL-Pfad zurück.

**c) `trailerUrl` Priorität erweitert:**
```js
trailerUrl: trailerUrl || this._findLocalTrailer(metadata.title, enrichedMeta.year || metadata.year) || (typeof enrichedMeta.trailer === 'string' ? enrichedMeta.trailer : enrichedMeta.trailer?.thumb) || null,
```

### 10. `routes/media.js`

**TMDB-Suche auf Deutsch:**
```js
// Zeile ~598: language=de-DE statt language=en-US
)}&query=${encodeURIComponent(q)}&include_adult=false&language=de-DE&page=1`;
```

### 11. `package.json`

**Version:** `3.0.1a` (statt `3.0.1`)

---

## Verzeichnisse die erhalten bleiben müssen

- `media/trailers/` — Heruntergeladene Trailer (.mp4 Dateien)
- `poster-updater/` — Scripts + Filmliste + .env
- `public/cinema-playlist.json` — Aktuelle Playlist

---

## Voraussetzungen

- **yt-dlp:** `pip3 install --break-system-packages yt-dlp`
- **Python-Pakete:** `requests`, `python-dotenv` (für download-trailers.py)

---

## Nach einem Update: Schritt-für-Schritt

1. Backup der Custom-Dateien erstellen (oder git stash)
2. Update durchführen
3. Neue Dateien kopieren: `routes/poster-selector.js`, `poster-updater/download-trailers.py`
4. `routes/poster-updater.js` prüfen — ggf. Trailer-Endpoints und ZIP-Löschung nachpatchen
5. `server.js` — Route-Mounts hinzufügen (Poster Updater, Trailer, Poster Selector)
6. `public/admin.html` — Sidebar-Einträge + Sections hinzufügen
7. `public/admin.css` — pu-/ps-Styles am Ende einfügen
8. `public/admin.js` — Nav-Map, showSection, Click-Handler + IIFEs am Ende
9. `public/cinema/cinema-display.js` — Trailer-Logik, Playlist-Matching, Playback-API
10. `public/cinema/cinema-display.css` — scale(1.25) auf Trailer-iframe
11. `public/device-mgmt.js` — playlist.refresh Command
12. `public/sw.js` — Version erhöhen + cinema-display.js ausschließen
13. `sources/local.js` — fileTitle + _findLocalTrailer + trailerUrl Priorität
14. `routes/media.js` — TMDB Suche de-DE
15. Server neu starten: `pm2 restart posterrama`
16. Browser-Cache auf allen Monitoren leeren
