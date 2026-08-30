/**
 * parseTrailerSummary() in lib/poster-updater-runner.js
 *
 * Der Runner baut aus der Ergebniszeile von download-trailers.py eine Zeile im
 * Server-Log -- als Warnung mit Fehlergruenden, sobald ein Download scheiterte.
 * Die Beispielausgabe unten stammt aus einem echten Lauf (2026-08-30), bei dem
 * ein veraltetes yt-dlp wochenlang still gescheitert war.
 */

jest.mock('../../utils/logger');

const { parseTrailerSummary } = require('../../lib/poster-updater-runner');

const REAL_RUN = `
   ⏭️  [416/1323] Drei Mädels vom Rhein (1955) — bereits vorhanden
   ⬇️  [418/1323] Driver (1978) (DE) ... ✅ 31.2 MB
   ⬇️  [702/1323] Leyla (2023) (EN-offiziell) ...
      yt-dlp Fehler: ERROR: [youtube] GlHL_3smXSE: This video is not available
 ❌ Download fehlgeschlagen
   ⚠️  [409/1323] Dr. med. Fabian - Lachen ist die beste Medizin (1969) — kein Trailer bei TMDB
   ⬇️  [1211/1323] Universal Soldier (1992) (DE-offiziell) ... ✅ 36.1 MB
      yt-dlp Fehler: ERROR: [youtube] xe5wRjjX3gQ: This video is unavailable
      yt-dlp Fehler: ERROR: [youtube] Q0tKJmhtXX0: This video is not available
  💾 trailer-info.json gespeichert (1263 Eintraege)

==============================
  Ergebnis:
  ✅ Heruntergeladen: 9
  ⏭️  Uebersprungen:  1263
  ⚠️  Kein Trailer:   42
  ❌ Fehler:          9
  Gesamt:             1323
==============================

TRAILER-SUMMARY downloaded=9 skipped=1263 no_trailer=42 failed=9 total=1323

=== Job beendet 2026-08-30T10:05:00.000Z (Exit-Code 0) ===
`;

describe('parseTrailerSummary', () => {
    test('liest die Zaehler aus der TRAILER-SUMMARY-Zeile', () => {
        expect(parseTrailerSummary(REAL_RUN)).toMatchObject({
            downloaded: 9,
            skipped: 1263,
            noTrailer: 42,
            failed: 9,
            total: 1323,
            searched: 0, // Zeile ohne searched= (vor z-17) -> 0
        });
    });

    test('liest das optionale searched= (per YouTube-Suche geladen)', () => {
        const log =
            'TRAILER-SUMMARY downloaded=11 skipped=1260 no_trailer=40 failed=2 total=1323 searched=3\n';
        expect(parseTrailerSummary(log)).toMatchObject({ downloaded: 11, failed: 2, searched: 3 });
    });

    test('fasst Fehlergruende ohne Video-ID zusammen, hoechstens drei, ohne Duplikate', () => {
        const { reasons } = parseTrailerSummary(REAL_RUN);
        expect(reasons).toEqual([
            'ERROR: This video is not available',
            'ERROR: This video is unavailable',
        ]);
    });

    test('liefert null, wenn das Script vor der Ergebniszeile abbricht', () => {
        const aborted =
            '❌ Filmliste nicht gefunden: filmliste.txt\n=== Job beendet (Exit-Code 1) ===\n';
        expect(parseTrailerSummary(aborted)).toBeNull();
        expect(parseTrailerSummary('')).toBeNull();
        expect(parseTrailerSummary(undefined)).toBeNull();
    });

    test('begrenzt die Gruende auf drei verschiedene', () => {
        const many = Array.from(
            { length: 6 },
            (_, i) => `      yt-dlp Fehler: ERROR: [youtube] id${i}: Grund ${i}`
        ).join('\n');
        const log = `${many}\nTRAILER-SUMMARY downloaded=0 skipped=0 no_trailer=0 failed=6 total=6\n`;
        expect(parseTrailerSummary(log).reasons).toHaveLength(3);
    });
});
