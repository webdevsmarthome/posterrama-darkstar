# Changelog

Alle wichtigen Änderungen an diesem Darkstar-Fork von Posterrama werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), und dieses Projekt folgt grob [Semantic Versioning](https://semver.org/lang/de/). Fork-spezifische Patch-Versionen nutzten bis `3.0.1z` Buchstaben-Suffixe; ab `3.0.1z-1` numerisch weiter — die „echten" Versionsnummern (`3.0.2`, `3.1.0`) bleiben dem Upstream-Entwickler vorbehalten.

---

## [3.0.1z-17] – 2026-08-30

YouTube-Suche als Fallback für Trailer, die TMDB nicht kennt oder deren TMDB-Video verschwunden ist.

### Hinzugefügt

- **`poster-updater/trailer_search.py`** — `download-trailers.py` sucht jetzt per yt-dlp (`ytsearch`) einen Trailer, wenn TMDB keinen Treffer oder keinen Trailer liefert oder das von TMDB referenzierte Video nicht ladbar ist (dessen ID wird ausgeschlossen). Anlass: *Toy Story 5 (2026)* blieb ohne Trailer, weil TMDBs YouTube-Key auf ein gelöschtes Video zeigte — die Suche fand den offiziellen deutschen Trailer sofort. Query-Kette: `<Titel> <Jahr> trailer deutsch` → `<Originaltitel> <Jahr> official trailer` → `<Titel> <Jahr> trailer`; es zählt die erste Query mit brauchbaren Treffern.
- **Strenge Filter gegen Fehlgriffe** — Präzision vor Trefferquote, denn ein fehlender Trailer fällt nicht auf, ein falscher sofort. Jeder Treffer muss alles bestehen: Dauer 20 s–6 min; „Trailer"/„Teaser" im Videotitel; Sperrliste (Reaction, Review, Breakdown, Fan-Made, Parodie, Clip, Making-of, Full Movie …); Titelwort-Abgleich (deutsch *oder* Original) mit Schwelle nach Titellänge — 1–2 Wörter: alle, 3–4: 75 %, ab 5: 60 % —, wobei generische Wörter (trailer, official, deutsch, hd …), Jahreszahlen und Einzelzeichen nicht zählen und Zahlwörter vereinheitlicht werden („Ocean's Thirteen" = „Ocean's 13"); eine Jahreszahl im Videotitel muss zum Film passen (±1). **Das Filmjahr muss im Videotitel stehen** bei Ein-Wort-Titeln, bei Filmen vor 1980 und bei Titel-Dubletten der Filmliste (Original + Remake: „Der Hauptmann von Köpenick" 1931/1956, Anaconda, Die Mumie, Godzilla, Nikita …) — die echten Trailer alter Filme tragen das Jahr auf YouTube praktisch immer, und ohne diese Regel bekam der 1931er den Trailer des Remakes. 10 Suchergebnisse je Query, weil YouTube-Ergebnisse zwischen Aufrufen schwanken.
- **`[tmdb:ID]`-Hint der Filmliste wird endlich genutzt** — der Film wird direkt per ID nachgeschlagen (1316 von 1323 Einträgen tragen den Hint) statt per unscharfer Titelsuche, die „Elvis & Priscilla" als „Elvis & Nixon" und den Nicht-Film „SOUND TRAILER V01" als „Scream VI" auflöste. Das verbessert auch den bisherigen TMDB-Trailer-Pfad. Ohne Hint bleibt die Suche, deren Originaltitel nur bei passendem Erscheinungsjahr übernommen wird.
- Die Regeln wurden an den echten Fehlgriffen zweier Testläufe geschärft — „Beach Party Animals" → „The Quest", „Elvis & Priscilla" → „Elvis & Nixon", „Was ist Was – Unsere Erde" → „PLANET 4K", „Der rote Schakal" → „Der Schakal", „SOUND TRAILER V01" → „Scream VI" — und gegen alle korrekten Treffer derselben Läufe gegengeprüft (Driver, Erkan & Stefan, Ich fühl mich Disco, Minions & Monster, Ob blond ob braun ↔ It Happened at the World's Fair, Ocean's 13, Werner, One Desire, zwei japanische Originaltitel). Die Fehldateien wurden entfernt.
- **Rangfolge wie bei TMDB**: Sprache vor Offizialität — deutscher Treffer (Hinweise deutsch/german/offiziell/Kino, Umlaute, oder das Video trägt den deutschen statt des Originaltitels) schlägt einen englischen „Official Trailer"; dann „official", „Trailer" vor „Teaser", typische Trailerlänge. Bis zu drei Kandidaten werden nacheinander probiert, falls der beste nicht (mehr) ladbar ist. Label `DE`/`EN` (nie „-offiziell") — kompatibel mit dem Playlist-Editor-Filter, der genau die vier bekannten Werte kennt. Jede Wahl steht als `🔎 … Suche: "<Videotitel>" (<s>, DE/EN)` im Trailer-Log des Admins, damit Fehlgriffe auffallen.
- `TRAILER-SUMMARY … searched=N`; das Server-Log meldet `N geladen (davon M per YouTube-Suche)`. Parser-Test um das optionale Feld erweitert (5/5 grün). Die Suchlogik ist ohne Netz testbar (`extract=` injizierbar).

---

## [3.0.1z-16] – 2026-08-30

Trailer-Läufe melden ihr Ergebnis im Server-Log — stilles Scheitern ist vorbei.

### Geändert

- **Ergebniszeile pro Trailer-Lauf** — `download-trailers.py` druckt am Ende `TRAILER-SUMMARY downloaded=… skipped=… no_trailer=… failed=… total=…`; der Runner (`lib/poster-updater-runner.js`, `parseTrailerSummary()`) parst sie beim Prozessende und loggt `Trailer-Lauf: N geladen, M fehlgeschlagen, K ohne TMDB-Trailer, S uebersprungen (T Filme)` — als **Warnung** mit bis zu drei verschiedenen Fehlergründen (Video-IDs entfernt, damit gleiche Ursachen zusammenfallen), sobald etwas fehlschlug oder der Exit-Code ≠ 0 ist; sonst als Info. Fehlt die Zeile, weil das Script vorzeitig abbrach (z. B. `filmliste.txt` nicht gefunden), gibt es ebenfalls eine Warnung mit den letzten Logzeilen. Die bisherige Zeile `Trailer download finished, code=…` bleibt erhalten.
- Hintergrund: Seit dem 02.08. scheiterte jeder Download an einem fünf Monate alten yt-dlp (`This video is not available`). Das Script fängt Fehler ab und endet mit 0, der Runner meldete wochenlang `finished, code=0`, der Fehlertext lag nur im In-Memory-Ringpuffer des Admins — der wegen der 2FA-Sperre nicht erreichbar war. Zehn neue Filme blieben ohne Trailer. yt-dlp-Pflege selbst (Update auf 2026.08.19, wöchentlicher `yt-dlp-update.timer`) liegt außerhalb des Repos.
- Unit-Test `__tests__/lib/poster-updater-runner.summary.test.js` mit der echten Ausgabe des Laufs vom 30.08. (Zähler, Gründe ohne Duplikate/IDs, Abbruch ohne Ergebniszeile, Obergrenze drei Gründe). 4/4 grün.

---

## [3.0.1z-15] – 2026-08-30

Admin-Live-Vorschau repariert: gleichoriginale Frames sind wieder erlaubt.

### Behoben

- **Admin-Live-Vorschau war leer** — `admin.html` bettet `/screensaver?preview=1` als iframe ein. Die CSP aus dem Audit-Commit vom 26.08. erlaubte in `frame-src` nur YouTube, kein `'self'`, und `X-Frame-Options: DENY` widersprach dem gleichzeitig gesetzten `frame-ancestors 'self'`. Der Frame wurde still blockiert; aufgefallen erst über den CSP-Report beim ersten Admin-Login nach der 2FA-Reparatur (Vorschau ist die einzige Frame-Einbettung im Frontend). Jetzt `frame-src 'self' …` und `frameguard: sameorigin`. Test `__tests__/middleware/csp-admin-preview.test.js`: Header-Paar (`frame-src 'self'`, `frame-ancestors 'self'`, kein `DENY`) plus Marker, dass die Vorschau als gleichoriginaler iframe existiert. 2/2 grün, live per Header verifiziert.

---

## [3.0.1z-14] – 2026-08-28

Härtung nachgeholt: keine Inline-Event-Handler mehr im Frontend, `script-src-attr` steht wieder auf `'none'`.

### Geändert

- **Alle 21 Inline-Event-Handler entfernt** (nicht 14, wie in z-13 gezählt — der erste Scan hatte JS-Templates und lange Attributwerte übersehen): `screensaver.html`/`wallart.html` aktivieren ihr Deferred-CSS jetzt über ein Inline-Script mit `load`-Listener direkt hinter den `<link rel="preload">`-Tags (läuft noch während des Parsens, das Event kann nicht verpasst werden); `admin.html` (Hilfe-Suchfeld-Autofill-Schutz, HA-Dashboard-Modal), `cache-browser.html` (Hinweis schließen, Analyse öffnen/schließen, Poster-Fallback), `poster-updater.html` (Poster ausblenden) und `setup.html` (**2FA-Verifizierung**, Zurück-Button) nutzen `addEventListener`; die JS-Templates in `admin.js` (Gerätekarten-Thumbnail, IP-Whitelist-Chip, HA-Dashboard-Radios, Poster-Suche) und `promo-box-overlay.js` (Copy-Befehl) laufen über Event-Delegation auf `document` (`wireCspSafeHandlers()` am Ende von `admin.js`), damit auch per `innerHTML` erzeugte Elemente abgedeckt sind. Bild-Ladefehler werden in der Capture-Phase behandelt, weil `error` nicht bubbelt; der Poster-Fallback im Cache-Browser bekommt einen Marker gegen Endlosschleifen, falls auch das Fallback fehlt. Der Chip-Hover liegt jetzt in `admin.css` statt in `onmouseover`.
- **`script-src-attr` explizit `'none'`** (`middleware/index.js`) — mit Kommentar, warum explizit: Helmet liefert den Wert sonst still als Default, genau so entstand die Regression.
- **Regressionstest erweitert** (`__tests__/middleware/csp-inline-handlers.test.js`): prüft den Header auf `'none'` und scannt `public/` (HTML + JS, ohne `vendor/`, `*.min.js`, `sw.js`) statisch auf `on<event>=`-Attribute mit einer Liste echter DOM-Events — schlägt an, sobald wieder ein Inline-Handler auftaucht. 5/5 grün.

### Verifikation

- Safari am MacBook mit scharfer CSP: Screensaver korrekt formatiert; seit dem Neustart keine CSP-Reports mehr. Syntax aller Inline-Scripts und von `admin.js` (als ES-Modul) geprüft.

### Dokumentation

- `docs/MONITOR-POWER-WATCHER.md`: neuer Abschnitt „Scanout-Freeze" — der Kiosk-Monitor zeigte mehrfach täglich ein stehendes Poster, obwohl der Pi nachweislich weiter Frames ausgab (wechselnde `grim`-Frames, flippende Primary-Plane, laufender Vblank-IRQ, DDC antwortet). Pi-seitig ist kein Freeze-Signal messbar; die zweite Plane am CRTC ist die Cursor-Plane, kein Overlay. Ursache nicht bewiesen — Verdacht HDMI-Link/Monitor, weil zugleich die Kernel-EDID dauerhaft leer ist und die DDC/CI-Firmware des Monitors stundenlang verstummt (alles dieselben Leitungen). Ein Moduswechsel holt das Bild zurück — kein Power-Cycle nötig. Beschreibt die Werkzeuge (manuelles `display-resync.sh`, `scanout-watchdog.service` als Beweissammler mit konservativer Heilregel und optionalem präventivem Resync, `WLR_DRM_NO_ATOMIC=1` prophylaktisch); die Werkzeuge selbst liegen außerhalb des Repos in `~/.local/bin`. Erste empfohlene Maßnahme: HDMI-Kabel tauschen.

---

## [3.0.1z-13] – 2026-08-28

CSP-Regression aus dem Audit-Commit behoben: Screensaver- und Wallart-Seite blieben unformatiert, Admin- und Setup-Buttons ohne Funktion.

### Behoben

- **`script-src-attr 'none'` blockierte Inline-Event-Handler** — Helmet liefert diese Direktive als Default mit, sobald `contentSecurityPolicy` aktiviert wird; der Audit-Commit vom 26.08. (APP-3) hat sie unbeabsichtigt geerbt und nur die Kiosk-Seite geprüft. Betroffen: `screensaver.html` und `wallart.html` (Stylesheet-Aktivierung via `<link rel="preload" onload="this.rel='stylesheet'">` — die Seite blieb beim ~1 KB Critical-CSS), `admin.html` (Modal schließen, YAML kopieren), `setup.html` (2FA-Verifizierung), `cache-browser.html`, `poster-updater.html` — 14 Handler in 6 Dateien. Nur `cinema.html` hat keine, deshalb blieb der Kiosk unauffällig. Aufgedeckt durch Safaris CSP-Reports an `/api/csp-report` („blockedUri: inline, directive: script-src-attr, /screensaver Zeile 61/62"). Fix: `scriptSrcAttr: ["'unsafe-inline'"]` — `script-src` erlaubt `'unsafe-inline'` ohnehin, ein Attribut-Verbot allein bringt keinen Schutz. Regressionstest `__tests__/middleware/csp-inline-handlers.test.js` (drei Seiten plus Marker, dass das Preload-Muster noch existiert).

### Offen (Härtung)

- Inline-Handler aus den sechs Dateien entfernen, danach `script-src-attr` wieder auf `'none'`.

---

## [3.0.1z-12] – 2026-08-28

Kleines Nachfolge-Release: Browserfehler der Anzeigeseiten werden serverseitig sichtbar, und die Watcher-Dokumentation beschreibt die gehärtete Monitor-Erkennung.

### Hinzugefügt

- **`POST /api/telemetry/error`** — `public/error-handler.js` meldet seit jeher uncaught errors und unhandled rejections der Anzeigeseiten an diesen Endpoint, der aber nie existierte (404). Browserfehler blieben damit unsichtbar — aufgefallen, als Safari auf einem MacBook die Cinema-Seite nur noch ohne Geräteeinstellungen darstellte und der einzige Server-Treffer ein 404 auf genau diesen Pfad war. Unauthentifiziert, weil die Anzeigeseiten nicht eingeloggt sind; deshalb 60 Meldungen/15 min je IP, 16 kB Body-Limit, alle Felder gekürzt. Log als `[Telemetry] Client-Fehler` (warn) mit Quelle `datei:zeile:spalte`, Stack, User-Agent und IP. 3 neue Tests.

### Dokumentation

- `docs/MONITOR-POWER-WATCHER.md`: Abschnitt „Fehlalarm-Falle" — die ursprüngliche Erkennung wertete *jeden* DDC-Fehler als „Monitor aus" und fror den Kiosk bei laufendem Monitor stundenlang per SIGSTOP ein (die wackelige DDC/CI-Firmware des U2720Q verstummte mehrfach für 8–13 Stunden). Beschreibt die dreistufige `probe_monitor`-Erkennung (HPD-Leitung, D6-Wert, I2C-ACK des Scalers) mit den gemessenen Signalen des Monitors in allen Zuständen sowie die Diagnose-Signatur (`ps` zeigt lauter `T`, `wchan = do_signal_stop`). Das Watcher-Script selbst liegt außerhalb des Repos in `~/.local/bin`.

---

## [3.0.1z-11] – 2026-08-27

Zwei Themen: die Sicherheits-Nacharbeit aus dem Audit vom 2026-08-16 (npm-Schwachstellen von 16 auf 0, SSRF-Guard endlich versioniert, Header-Reihenfolge, X-Forwarded-For-Spoofing) und die Behebung eines wiederkehrenden Anzeige-Hängers am Kiosk. Beides live am Produktivsystem verifiziert.

### Behoben: Cinema-Anzeige blieb periodisch auf einem Poster stehen

Der Monitor fror mehrmals täglich auf einem Bild ein — sichtbar als schwarzer Kasten über dem unteren Posterdrittel (das Trailer-`<video>` ohne Bild). Die Kette:

1. `invalidateZipScanCache()` setzte den ZIP-Scan-Cache nach **jedem** Clearlogo-Pipeline-Lauf auf `'{}'` zurück.
2. Der nächste Playlist-Refresh musste daraufhin alle ~1300 ZIPs neu einlesen. Gemessen: **126 ms pro ZIP allein fürs AdmZip-Öffnen** (92 % der Scan-Zeit — AdmZip liest jede ~1,3-MB-Datei komplett in den Speicher), macht ~150 s am Stück. Weil AdmZip synchron arbeitet, blockierte das den kompletten Node-Event-Loop: Requests brauchten 1,5–2,7 s statt Millisekunden.
3. 94 % der Items (2444 von 2586) haben lokale Trailer, die vom selben Server streamen. Stallt so ein Stream, feuert HTML5 nur `stalled`/`waiting` — **weder `ended` noch `error`**. Genau diese drei Events waren aber die einzigen Wege, über die der lokale Trailer-Pfad die zuvor gestoppte Rotation wieder anwarf. Ergebnis: Anzeige stand bis zum nächsten Reload.

Da die Pipeline alle 6 Stunden läuft, traf das vier Zeitfenster pro Tag.

- **Gezielte statt totaler Cache-Invalidierung** (`lib/clearlogo-pipeline.js`) — der Reset war überflüssig: `zip.writeZip()` ändert mtime *und* size jedes gepatchten ZIPs, der Scan erkennt sie ohnehin an seinem mtime/size-Abgleich. Jetzt werden nur noch tatsächlich veraltete Einträge entfernt: 1310 von 1310 bleiben erhalten, Laufzeit 557 ms.
- **Stall-Watchdog für lokale Trailer** (`public/cinema/cinema-display.js`) — Fortschritts-Überwachung alle 2 s; steht `currentTime` 20 s still, wird abgebrochen und weiterrotiert. Analog zum bereits vorhandenen YouTube-Watchdog, den der lokale Pfad nicht hatte. Deckt auch den Fall ab, dass ein Video nie zu spielen beginnt.
- **Event-Loop-Yield im ZIP-Scan** (`sources/local.js`) — `setImmediate` nach jedem AdmZip-Read, nur im Cache-Miss-Zweig. Die längste Blockade am Stück ist damit ein einzelner ZIP-Read statt drei Minuten.
- **Atomares Cache-Schreiben** (tmp + rename) — die 4,2-MB-Datei braucht 155 ms; ein parallel lesender Scan bekam bisher potenziell halben JSON-Text, `JSON.parse` warf, und der Scan fiel stillschweigend auf einen leeren Cache zurück.
- **Cache-Lesefehler wird geloggt statt verschluckt** — das leere `catch (e) {}` war der Grund, warum ein kalter Cache nie im Log auftauchte. `ENOENT` (Erstlauf) bleibt `debug`, alles andere ist jetzt `warn`.

Messwerte vorher/nachher: Refresh im Routinefall **150 s → 5,4 s**, Request-Latenz während des Refresh **1,5–2,7 s → 0,038 s** (Max 0,501 s). Im Ausnahmefall (Cache wirklich verloren) dauert der Scan jetzt ~7 min statt 150 s — bewusster Tausch: unterbrechbar statt schnell, die Latenz bleibt dabei bei 0,494 s im Mittel.

### Sicherheit (Audit 2026-08-16)

- **SSRF-Guard versioniert** (OPS-4/APP-1) — `assertSafeDirectImageUrl()` im Bild-Proxy lag 36 Tage ausschließlich als unversionierte Arbeitskopie vor; ein `git checkout` hätte ihn stillschweigend entfernt. Die Prüfung läuft vor dem Cache-Lookup, erlaubt nur global routbare Ziele plus konfigurierte Medienserver-Hosts und schließt Loopback, RFC1918, Link-Local, CGNAT und Reserved aus (fail closed).
- **X-Forwarded-For-Spoofing geschlossen** (APP-4) — die Bypass-Allowlist ließ sich per Header umgehen, auch hinter Cloudflare (der Proxy hängt die echte Client-IP hinten an, der Code las vorne). `middleware/deviceBypass.js` und `routes/devices.js` nutzen jetzt `req.ip` statt des rohen Headers, passend zur `trust proxy`-Einstellung.
- **Schutz-Header vor dem Frontend-Router** (APP-3) — `securityMiddleware()`/`permissionsPolicyMiddleware()` liefen hinter dem Frontend-Router; `/`, `/screensaver`, `/cinema`, `/wallart` und `/api/v1/config` gingen ohne Schutz-Header raus (0/4). Jetzt liefern alle Seiten CSP, HSTS, X-Frame-Options und nosniff, `X-Powered-By` ist weg. CSP-Direktiven an den realen Bedarf der Anzeigeseiten angepasst (youtube/s.ytimg/jsdelivr, `frame-src` für Trailer).
- **CORS-Allowlist** (APP-2) statt offener Origin-Spiegelung.
- **Ratelimit für `/api/qr`** (APP-6) — die Route ist bewusst unauthentifiziert (Pairing), ihr interner Auth-Guard war toter Code: eine unauthentifizierte Rechenlast-Primitive ohne Begrenzung. Jetzt 100 Anfragen/15 min je IP.
- **Log-Hygiene** (L-14) — die Warnung „Unauthorized admin API modification attempt" feuerte auf jedem CORS-Preflight und verrauschte genau die Sicherheits-Logkategorie.
- **npm-Schwachstellen von 16 auf 0** — `bcrypt` 5.1.1 → 6.0.0 entfernt die `@mapbox/node-pre-gyp` → `node-tar`-Kette samt der einzigen kritischen Schwachstelle (Pfad-Traversal, GHSA-r292-9mhp-454m); `puppeteer` → 25, `file-type` 16 → 22 (ab v22 reines ESM, beide Nutzungsstellen auf lazy `import()` umgestellt), `adm-zip` → 0.6.0, `sharp` → 0.35.3 (libvips 8.18.3). Möglich wurde das durch den vorangegangenen Wechsel auf **Node 22**.

### Verifikation

- **Testsuite**: 4 neue Tests in `__tests__/lib/clearlogo-pipeline.test.js` (unveränderte Einträge überleben, korrupter Cache wird zurückgesetzt, fehlende Datei bleibt unangetastet, keine `.tmp`-Reste) — 9/9 grün, der echte Cache wird nachweislich nicht angefasst. Regression über die local/ZIP-Suiten: 64/65, einziger Fail vorbestehend (`local.preview-romm`).
- **Live am Produktivsystem**: der alte Zustand exakt reproduziert (Cache auf `{}`, Neustart, Vollscan über 1310 ZIPs) — die Anzeige lief durch, der Stall-Watchdog musste nicht einmal auslösen. Genau diese Bedingung hatte den Monitor zuvor eingefroren.

### Bekannte Einschränkung

Bleibt der ZIP-Scan-Cache einmal wirklich verloren (Erstinstallation, gelöschte Datei), dauert der Wiederaufbau ~7 Minuten. Der einzige große Hebel dagegen wäre, `adm-zip` durch eine lazy lesende Bibliothek wie `yauzl` zu ersetzen, die nur das Central Directory liest statt der ganzen Datei — bewusst nicht gemacht, weil `adm-zip` projektweit genutzt wird und der Fall nach dieser Änderung selten ist.

---

## [3.0.1z-10] – 2026-07-06

Session-Poller-Härtung: Ein temporär nicht erreichbarer Media-Server schaltete die Now-Playing-Erkennung dauerhaft ab. Dazu npm-Security-Fixes (u. a. axios, express — 2× high). Live am Produktivsystem verifiziert.

### Hintergrund

Beide Session-Poller (`services/jellyfinSessionsPoller.js`, `services/plexSessionsPoller.js`) gaben nach 5 Fehlversuchen in Folge dauerhaft auf („too many errors, stopping") — ein vorübergehend offliner Media-Server (ausgeschaltet, Wartung, Netzproblem) beendete die Now-Playing-Erkennung bis zum nächsten Posterrama-Neustart, auch wenn der Server längst wieder lief. Der Jellyfin-Poller hatte zusätzlich einen versteckten Bug: `find()` statt `filter()` pollte nur den **ersten** enabled Server — bei zwei konfigurierten Jellyfin-Servern wurde der zweite nie abgefragt, und war der erste offline, fiel die Erkennung auch für den erreichbaren zweiten komplett aus. Genau so live beobachtet: primärer Server offline → Poller stoppte ~40 Minuten nach Boot dauerhaft.

### Behoben

- **Jellyfin pollt alle enabled Server** — Sessions werden gemerged (`_serverName` kennzeichnet die Quelle); ein zweiter Server wird nicht mehr ignoriert.
- **Fehler-Isolation pro Server** — Fehlerzähler und Backoff je Server; ein toter Server beeinflusst das Polling der übrigen nicht. Bei kurzen Ausfällen (unter 5 Fehler) bleiben die letzten bekannten Sessions des Servers erhalten (Grace-Period), damit ein einzelner Timeout kein Now-Playing-Flackern erzeugt.
- **Exponentieller Backoff statt Stopp** — nach 5 Fehlern in Folge wird der Server 60 s ausgesetzt, bei weiteren Fehlschlägen 120 s → 240 s → max. 300 s; beim ersten Erfolg automatische Wiederaufnahme („server recovered"-Log). Der Poller-Loop selbst stirbt nie mehr — auch unerwartete Fehler außerhalb der Server-Behandlung werden gefangen und geloggt.
- **Plex-Poller symmetrisch gehärtet** — gleiches Backoff-/Auto-Recovery-Muster statt permanentem Stopp; beim Eintritt in den Backoff werden veraltete Sessions geleert (kein Geister-Now-Playing).
- **Log-Hygiene** — statt einer Warnung alle 10 Sekunden für immer nur noch eine Warnung pro Backoff-Fenster (max. alle 5 Minuten), mit `server`- und `retryInSeconds`-Kontext.

### Sicherheit (Dependencies)

- `npm audit fix` (nur Lockfile): u. a. **axios 1.18.1** (high), **express 4.22.2** (high), fast-uri (high), body-parser, follow-redirects, dompurify, ajv, bn.js (moderate).
- Bewusst zurückgestellt, da Major-Bumps: `bcrypt` → 6 (zieht die node-pre-gyp/tar-Kette), `file-type` → 22, brace-expansion-Kette. Verbleibend 5 bekannte Advisories, alle nur über diese Majors lösbar.

### Verifikation

- **Testsuite**: neue `__tests__/services/jellyfinSessionsPoller.test.js` (Multi-Server-Merge, Fehler-Isolation, Grace-Period, Backoff-Eintritt, Skip im Backoff-Fenster, Auto-Recovery, Never-Stop); Plex-Tests auf das neue Verhalten umgestellt (Backoff-Verdopplung, genau ein Retry-Timer, Auto-Recovery ohne `restart()`). 42/42 grün, ESLint sauber.
- **Live am Produktivsystem** (ein Jellyfin-Server real offline): Fehler 1–4 als Warn mit Server-Kontext → 5. Fehler „backing off, retryIn=60s" → Retries mit exakter Verdopplung (11:45:53 → 60 s, 11:47:06 → 120 s, 11:49:20 → 240 s), 0 Stopp-Meldungen, Health durchgehend 200, der zweite (erreichbare) Server wird weiter gepollt.

---

## [3.0.1z-9] – 2026-07-02

Cinema-Freeze-Fix: Das Display blieb dauerhaft auf einem Filmplakat stehen („Ich fühl mich Disco"), wenn der YouTube-Trailer des Films im Embed nicht abspielbar war. Root Cause live bewiesen und Fix am echten Kiosk end-to-end verifiziert.

### Hintergrund
`startTrailerPlayback()` in `public/cinema/cinema-display.js` stoppt beim Trailer-Start die Poster-Rotation (`stopRotation()`). Im YouTube-Pfad wurde sie aber nur im Erfolgsfall (`onStateChange: ENDED`) wieder gestartet — der `onError`-Handler und der äußere `catch` räumten lediglich das Overlay weg. Der Trailer von „Ich fühl mich Disco" (tmdb:241066) ist altersbeschränkt; altersbeschränkte Videos verweigern die iframe-Einbettung grundsätzlich (YT-Fehlercode 150, live am Kiosk beobachtet: `Embedding disabled (age-restricted or blocked)`). Ergebnis: Rotation für immer gestoppt, Plakat eingefroren — reproduzierbar bei genau diesem Film, weil er als einziger in der Rotation eine nicht-einbettbare YouTube-URL ohne lokalen Trailer hat. Der Lokal-Trailer-Pfad hatte für exakt dieses Problem bereits einen Fix („vorher 120s — Anzeige stand fest"); dem YouTube-Pfad fehlte das Pendant. Der Screensaver-Modus ist nicht betroffen (eigener `trailerEndTimer`-Watchdog, onError → `scheduleNextPoster`).

### Behoben
- **`onError` startet die Rotation wieder** — nach `removeTrailerOverlay()` folgt jetzt wie im Lokal-Pfad `showNextPoster()` + `startRotation()` (2 s Pause).
- **`catch`-Pfad ebenso** — auch ein Fehler beim Player-Aufbau ließ die Rotation gestoppt zurück.
- **45s-Start-Watchdog** (`trailerStartWatchdog`) — Age-Gate-Embeds feuern je nach Player-Version weder `onError` noch einen StateChange (nur die „Sign in to confirm your age"-Wand). Der Watchdog schaltet weiter, wenn binnen 45 s kein `PLAYING` kommt; er wird bei `PLAYING` entschärft und in allen Trailer-Cleanup-Pfaden mit aufgeräumt (Muster vom Screensaver übernommen).

### Verifikation
Per CDP-Injection am echten Kiosk-Chromium (Disco als einziges Queue-Element erzwungen, Monitor war aus): reproduzierbarer Zyklus `Trailer overlay created` → `YouTube player error {code:150}` → 2 s → `Showing next poster` + `Starting poster rotation`, im 5-Sekunden-Takt über die gesamte Beobachtung. Vor dem Fix stand die Anzeige an dieser Stelle dauerhaft (Kiosk hing >25 min auf dem Disco-Plakat bei 10 s Rotationsintervall). Lokal-Trailer-Pfad im selben Test gegengeprüft (spielt und advanced korrekt).

### Hinweis
Der Disco-Trailer bleibt im Embed prinzipbedingt unspielbar (YouTube-Alterssperre) — das Display überspringt ihn jetzt sauber. Soll der Film wieder einen Trailer zeigen, braucht er einen lokalen Trailer (z. B. via yt-dlp mit Cookies) oder eine alternative, nicht altersgesperrte Trailer-URL in der `metadata.json`.

---

## [3.0.1z-8] – 2026-07-02

TMDB-Downloader-Generalüberholung (`poster-updater/tmdb-get-posters-direct.py`): Der Downloader lieferte konstruktionsbedingt fast keine Backdrops, EN-Poster, Clearlogos und Trailer — und hinterließ bei Abbrüchen verwaiste `tmp_`-Ordner. Beides behoben, end-to-end verifiziert.

### Hintergrund
`api_call()` hängte `language=de-DE` an **jeden** TMDB-Request — auch an `/movie/{id}/images` und `/videos`. TMDB filtert die Galerie dann serverseitig auf Deutsch: EN-Poster, textfreie Backdrops (`iso_639_1 = null`, die Mehrheit aller Backdrops) und fast alle Clearlogos waren unsichtbar. Die „DE/EN"-Filterlogik im Script war dadurch toter Code; Bestands-ZIPs enthalten `"backdrops": []`. Der 27,2-%-Clearlogo-Mangel, den die Pipeline aus 3.0.1z-6 kompensiert, hat hier seine Wurzel. Zusätzlich überschrieb `params['language'] = 'de-DE'` das `en-US` des Tagline-Fallbacks (holte zweimal Deutsch), und ohne `try/finally` blieben bei Crash/Kill `tmp_NNN_`-Ordner liegen (zwei Leichen vom 24.05. im Repo, beide mitten in der People-Download-Phase gestorben).

### Behoben
- **Bildergalerie vollständig** — `/images` mit `include_image_language=de,en,null`, `/videos` mit `include_video_language=de,en`. Messbar an „Speed 2: Cruise Control": vorher 1 Poster, 0 Backdrops, kein Clearlogo, kein Trailer → nachher 5 Poster, 3 Backdrops, Clearlogo, Trailer.
- **EN-Tagline-Fallback wirkt** — `api_call()` kopiert Params und setzt `language` nur noch als Default (`setdefault`); dabei auch den Mutable-Default-Bug (`params={}`) entfernt. Verifiziert mit tmdb:355024 (DE-Tagline leer → EN-Tagline landet im ZIP).
- **Crash-/Kill-sicherer Cleanup** — per-Film `try/except/finally` (ein Fehler bricht nicht mehr den ganzen Lauf ab), SIGTERM-Handler, Ctrl+C mit Zwischenstands-Summary, Startup-Sweep entfernt verwaiste `tmp_`-Ordner alter Läufe, halbfertige ZIPs werden gelöscht (sonst gälte der Film künftig fälschlich als „vorhanden").
- **Korrupte Bilder verhindert** — `download_image()` prüft jetzt den HTTP-Status (vorher landeten 404-HTML-Seiten als `.jpg` im ZIP) und fängt nicht mehr per nacktem `except:` sogar Ctrl+C.
- **Null-sichere TMDB-Felder** — `runtime: null` (`None * 60000`), `vote_average: null` (unsortierbar/`round(None)`), `iso_639_1: null` (`None[:2]`) crashten den Lauf.
- **DE-Priorität konsequent** — Poster DE vor EN (sonst verdrängen die zahlreichen EN-Poster den deutschen Treffer vom `primaryPoster`-Platz), Trailer DE vor EN, Clearlogo DE > EN > sprachneutral.
- **Status-Zeile korrekt** — „🌟 Clearlogo" wurde nach dem `rmtree` per Dateisystem geprüft und erschien daher nie.

### Neu
- `POSTERRAMA_TMDB_EXPORT_DIR` übersteuert das Output-Verzeichnis (ermöglichte die gefahrlose End-to-End-Verifikation gegen die echte TMDB-API).
- `.gitignore`: `poster-updater/__pycache__/` und `poster-updater/tmp_*/`.

### Hinweis
Bestehende Exporte behalten das alte Manko (kaum Backdrops, fehlende EN-Taglines), da vorhandene ZIPs übersprungen werden — nur neue Exporte profitieren automatisch. Ein Bestands-Refresh würde nachgepatchte fanart.tv-Clearlogos ersetzen und ist daher bewusst nicht Teil dieses Release.

---

## [3.0.1z-7] – 2026-06-10

Security-Fix: Authentifizierungs-Guard für alle `/api/local/*`-Endpunkte. Ein interner Sicherheits-Audit ergab, dass 17 von 26 Routen des Local-Directory-Routers unauthentifiziert erreichbar waren — darunter Datei-Upload, Datei-Löschung (`cleanup`), Verzeichnis-Browsing und das Starten ressourcenintensiver Jobs.

### Hintergrund
Der Local-Directory-Router (`routes/local-directory.js`) wird via `app.use('/', …)` ohne Router-Guard gemountet; die Authentifizierung lag pro Route und fehlte bei 17 von 26. Im LAN — wo der vorgelagerte Cloudflare-Access-Schutz nicht greift — konnte dadurch jeder Netzteilnehmer Dateien hochladen, löschen, den Medienbaum auslesen oder CPU-/ffmpeg-lastige Jobs als DoS auslösen.

### Behoben
- **Namespace-weiter Auth-Guard** (`routes/local-directory.js`): `router.use('/api/local', isAuthenticated)` direkt nach der Router-Erstellung schützt jetzt alle 26 `/api/local/*`-Routen. Der öffentliche Display-Client ruft diese Routen nie auf (0 Referenzen außerhalb `admin.js`) — Anzeige und Geräte bleiben unberührt. Verifiziert: zuvor offene Endpunkte (`/stats`, `/jobs`, `/browse`, `/metadata`, …) liefern jetzt `401`, öffentliche Pfade (`/get-config`, `/health`) unverändert.

### Sicherheit
Schließt Befund **A1** (kritisch im LAN-Kontext) aus dem internen Sicherheits-Audit vom 2026-06-10.

---

## [3.0.1z-6] – 2026-05-24

Clearlogo-Pipeline: vierstufiges Nachladen fehlender Logos (TMDB → fanart.tv → Plex/Jellyfin lokal → Text-Renderer-Fallback). Jeder Film hat ab jetzt garantiert ein Clearlogo.

### Hintergrund
Bisherige TMDB-Quelle ließ 344 von 1267 ZIPs (27,2 %) ohne Clearlogo. Diese werden jetzt von zusätzlichen Quellen ergänzt; was wirklich keine Quelle hat, bekommt einen automatisch gerenderten Schriftzug als Notlösung.

### Neu
- **Stage-1 fanart.tv-Fetcher** (`poster-updater/fetch-clearlogos-fanarttv.py`): Lädt Logos aus der Community-Datenbank fanart.tv. Priorität `hdmovielogo > movielogo`, Sprachen `de > en > 00` (sprachneutral), innerhalb jedes Pools nach Likes sortiert. Negativ-Cache verhindert wiederholte API-Calls (30-Tage-TTL). Benötigt `fanarttv.apiKey` in `config.json` (gratis via https://fanart.tv/get-an-api-key/).
- **Stage-2 Plex/Jellyfin-Lokal-Scrape** (`poster-updater/fetch-clearlogos-local.py`): Sucht Logos auf den aktiven lokalen Media-Servern via Provider-ID `Tmdb.{id}`. 7-Tage-Negativ-Cache.
- **Stage-3 manuelles Upload-UI** (`routes/posterpack-creator.js` + `public/admin.js`): Neuer Endpoint `POST /api/posterpack-creator/clearlogo/:packName` (multer-PNG-Upload, max 5 MB). In der Poster-Updater-Filmliste pro Zeile ein 📤-Button zum Hochladen, plus zwei neue Filter-Buttons "ohne echtes Clearlogo" und "mit Text-Fallback" (markiert die idealen Kandidaten zum manuellen Ersetzen).
- **Stage-4 Text-Renderer-Fallback** (`lib/text-clearlogo-renderer.js`): Server-seitiger Sharp/SVG-Renderer erzeugt aus dem Filmtitel ein weißes, kondensiert-fettes Schriftbild auf transparentem 1200×400-Background. Auto-Split bei langen Titeln (Trenn-Heuristik via `:`, `–`, `-`, `|` oder Mittel-Leerzeichen). Schriftgrößen empirisch kalibriert für `DejaVu Sans Bold` (Pi-Standardfont).
- **Pipeline-Orchestrator** (`lib/clearlogo-pipeline.js`): Sequenzieller 4-Stage-Lauf mit Singleton-Lock, 5-MB-Ringbuffer-Log, SSE-Subscriber-Pattern (analog zu `lib/poster-updater-runner.js`). Markiert die Quelle pro Film in `metadata.json.clearlogoSource` (`tmdb` | `fanarttv` | `plex` | `jellyfin` | `manual` | `generated`). Generierte Text-Fallbacks werden in Folgeläufen automatisch durch echte Logos ersetzt, sobald welche verfügbar sind.
- **Auto-Trigger nach Emby-Sync** (`lib/emby-sync.js`): Direkt nach dem bestehenden Post-Job-Auto-Playlist-Refresh läuft die Clearlogo-Pipeline im Hintergrund an. Kein Admin-Klick nötig.
- **API-Erweiterung `/api/poster-updater/films`** (`routes/poster-updater.js`): Liefert pro Film jetzt `hasClearlogo` und `clearlogoSource`, dazu Statistikfelder `withClearlogo` und `generatedClearlogo` für die UI-Filter.
- **Konfiguration** (`config.schema.json`, `config.example.json`): Neuer optionaler Top-Level-Key `fanarttv.apiKey`. Fehlt der Key, wird Stage 1 still übersprungen — Pipeline läuft trotzdem (Stages 2-4).

### Tests
- `__tests__/lib/text-clearlogo-renderer.test.js` (14 Tests): Font-Size-Heuristik, Title-Splitting, SVG-Build, XML-Escaping, PNG-Output mit Dimensionen + Alpha-Kanal, Edge-Cases (leerer Titel, sehr lange Titel).
- `__tests__/lib/clearlogo-pipeline.test.js` (5 Tests): API-Exports, Default-State, Subscribe/Unsubscribe, Stage-4-ZIP-Patch erhält vorhandene Files, Logger-Setter.

---

## [3.0.1z-5] – 2026-05-24

Hotfix für 3.0.1z-4: 📌-Pin-Badge verschwand nach 3 Sekunden wieder aus der Devices-Übersicht.

### Behoben
- **Pin-Badge persistiert jetzt** (`public/admin.js`): Der bestehende Live-Reconcile-Loop (`reconcileDeviceToolbarStatesOnce`, alle 3 s) schreibt die `.meta-pills`-Sektion komplett neu — und ignorierte beim Render-Template das in 3.0.1z-4 neu hinzugefügte 📌-Pinned-Playlist-Badge. Resultat: Badge erschien beim initialen Card-Render kurz, wurde aber beim nächsten Reconcile-Tick aus dem DOM gelöscht. **Fix:** Reconcile-Template um den Pin-Branch erweitert (analog zum Profil-Branch), inklusive `window.resolvePinnedPlaylistName`-Lookup. Beide Render-Pfade (`renderPage` für Voll-Render + `reconcileDeviceToolbarStatesOnce` für inkrementelles Live-Update) zeigen jetzt konsistent denselben Pin-Zustand.

---

## [3.0.1z-4] – 2026-05-24

Per-Device-Playlist-Pinning: jedes Device kann eine eigene Playlist gepinnt bekommen, die global aktivierte Playlist überschreibt sie nicht.

### Neu
- **Playlist-Pin pro Device** (`lib/device-operations.js`, `routes/devices.js`, `routes/poster-selector.js`, `public/admin.html`, `public/admin.js`, `public/admin.css`, `public/cinema/cinema-display.js`, `public/screensaver/screensaver.js`): Im Device-Record gibt es jetzt ein optionales Feld `pinnedPlaylistId`. Wird es gesetzt, zieht das Device seine Playlist über den neuen Endpoint `GET /api/devices/:id/playlist` und ignoriert globale Playlist-Wechsel. Wird das Feld auf `null` gesetzt, folgt das Device wieder der globalen aktiven Playlist.
  - **Admin-UI:** Im Devices-Bereich neuer Menüpunkt "Pin playlist…" (mit `fa-thumbtack`-Icon). Modal-Dialog mit Dropdown aller verfügbaren Playlists (inkl. Auto-Playlists, mit `(auto)`-Suffix gekennzeichnet) + "Pin"- und "Unpin"-Buttons. Gepinnte Devices zeigen ein gelbes 📌-Badge mit dem Playlist-Namen in der Übersicht.
  - **Backend-Validierung:** PATCH `/api/devices/:id` lehnt ungültige Playlist-IDs mit `400 invalid_pinned_playlist` ab; nur Keys aus `cinema-playlists.json` oder `null` werden akzeptiert.
  - **WebSocket-Sync:** Pin-Wechsel triggert sofortigen Device-Reload via bestehenden `requestDeviceReload`-Pfad. Titles-Updates einer gepinnten Playlist (`PUT /playlists/:id`) benachrichtigen alle Devices mit passendem Pin via `wsHub.sendToDevice`. Bei `DELETE /playlists/:id` werden Pins betroffener Devices automatisch geleert (Fallback auf Global) — kein Confirm-Dialog, kein Block.
  - **Robustheit:** Verweist ein Pin auf eine zwischenzeitlich gelöschte Playlist, fällt der Endpoint stillschweigend auf die globale Playlist zurück und loggt eine WARN.

### Performance
Keine zusätzliche Server-Last: Die teure Source-Aggregation (Plex/Jellyfin/ZIP-Scan, 100-200 MB Heap) bleibt 1× global. Per-Device-Resolution ist nur ein In-Memory-Title-Filter (Mikrosekunden). Poster/Trailer werden weiterhin via Express-sendfile aus `media/` ausgeliefert — der Code-Path ändert sich nicht.

### Tests
- `__tests__/devices/devices.playlist.test.js`: 7 neue Tests für `GET /api/devices/:id/playlist` (ungepinnt → global, gepinnt → korrekte Titles, Pin auf gelöschte Playlist → Fallback auf global, fehlendes Device → 404) + PATCH-Validierung (valid → 200, null → 200, invalid → 400 `invalid_pinned_playlist`).

---

## [3.0.1z-3] – 2026-05-14

NAS-Backup-Failover: Mehrere NAS-Ziele als Kandidatenliste — erstes erreichbares gewinnt.

### Neu
- **NAS-Failover im Backup-Script** (`scripts/backup/backup-to-nas.sh`): Statt einem einzelnen `NAS_HOST` jetzt ein `NAS_CANDIDATES`-Array mit `"Name|Host"`-Einträgen. Loop prüft pro Eintrag `ping` und SMB-Port 445 (jeweils 3 s Timeout), der erste erreichbare Host wird gemountet. Wenn alle Kandidaten offline sind, exit 0 mit Log-Hinweis (kein Service-Fail). Use-Case: Primär-NAS im Wartungsfenster oder dauerhaft offline → automatisches Ausweichen auf ein Backup-NAS auf anderem Subnetz, ohne dass der Timer-Lauf scheitert. Credentials sind für alle Kandidaten identisch (gleicher Backup-User auf jedem NAS). Produktion-verifiziert mit einem 2h-43min-Lauf auf das Fallback-NAS nach Primary-Ausfall.

### Geändert
- **Systemd-Unit-Description** (`scripts/backup/systemd/posterrama-nas-backup.service`): "Backup to Synology NAS — täglicher Mirror" → "Backup to NAS via SMB". Generischer, weil das Script jetzt nicht mehr an ein einzelnes NAS gebunden ist.
- **Log-Output** zeigt jetzt sowohl den NAS-Anzeigenamen als auch den Host: `[posterrama-backup] Backup-Ziel: Primary (nas-primary.local)` / `Backup nach Primary fertig in 9828s`.

### Hinweis zur lokalen Anpassung
Das Repo-Template enthält generische Beispiel-Werte (`Primary|nas-primary.local`, `Backup|nas-secondary.local`). Beim Deploy nach `/usr/local/bin/posterrama-backup-to-nas.sh` die `NAS_CANDIDATES`-Einträge auf die echten Hostnames/IPs der eigenen NAS-Infrastruktur anpassen. Share-Name `backup` muss auf allen Kandidaten identisch sein.

---

## [3.0.1z-2] – 2026-05-14

Safari-Trailer-Autoplay-Fix für lokale .mp4-Trailer + Codec-Härtung im Downloader.

### Behoben
- **Safari blockierte Autoplay lokaler Trailer** (`public/cinema/cinema-display.js`): Beim `<video>`-Element wurde `src` *vor* `muted`/`playsinline`/`autoplay` gesetzt. macOS Safari prüft beim Start des Loadings, ob das `muted`-Attribut präsent ist — wenn nicht, greift die Autoplay-Policy und das Video startet nie. Symptom: Poster fade-out, Trailer-Frame erscheint nicht, weil `onplay` nie feuert. **Fix:** Reihenfolge umgedreht (Attribute zuerst per `setAttribute`, dann Property, `src` zuletzt), expliziter `video.play()`-Call mit `.catch()` für saubere Recovery nach `NotAllowedError`, und Error-Recovery von 120 s → 2 s, damit eine kaputte Datei die Rotation nicht über Minuten anhält.

### Geändert
- **yt-dlp erzwingt H.264** (`poster-updater/download-trailers.py`): Vorher pickte yt-dlp `bestvideo[ext=mp4]` — für neuere YouTube-Videos liefert das AV1-im-mp4-Container. Safari auf Intel-Macs / vor 17.4 kann AV1 nicht decoden → schwarze Trailer ohne Error-Event. **Fix:** Format-Selector bevorzugt `vcodec^=avc1` (H.264), fällt auf `vcodec!*=av01` zurück, dann erst auf beliebiges mp4. Bestehende AV1-Trailer (266 von 1215) bleiben — sie funktionieren auf Apple Silicon + Safari 17.4+, Re-Download nur bei Bedarf.

---

## [3.0.1z-1] – 2026-05-14

Auto-Playlist „Die letzten N hinzugefügten Filme" sortiert wieder nach **Emby `DateCreated`** statt nach ZIP-mtime.

### Behoben
- **Auto-Playlist-Sortierung** (`lib/emby-sync.js`): In `3.0.1z` wurde die Sortierung auf ZIP-mtime umgestellt, damit frisch gezogene PosterPacks oben stehen. Nebenwirkung: Alte Filme (z. B. *Mein Freund Harvey (1950)*, *Spaceballs (1987)*) tauchten ganz oben in der „letzten 30 hinzugefügten Filme"-Liste auf, sobald deren PosterPack neu geschrieben wurde — der Playlist-Name wurde irreführend. **Fix:** Sortierung zurück auf `dateCreated` (Emby-Importdatum) descending. ZIP-Existenz-Filter bleibt — Filme ohne PosterPack landen weiterhin nicht in der Playlist, damit keine leeren Slots entstehen.

### Hinweis
- Schema-Wechsel der Fork-Versionierung: Nach `3.0.1z` wird mit numerischen Suffixen weitergezählt (`-1`, `-2`, ...), um die „echten" Versionssprünge dem Upstream-Entwickler zu überlassen.

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
