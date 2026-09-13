/**
 * lib/zip-tmdb-index.js — TMDB-ID → ZIP-Namen aus dem ZIP-Scan-Cache (z-20)
 *
 * Grundlage des TMDB-basierten Abgleichs der Emby-Sync: Derselbe Film unter
 * zwei Schreibweisen ("Top Gun - Maverick" / "Top Gun: Maverick") darf nicht
 * als neu gelten.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    parseTmdbHint,
    buildZipTmdbIndex,
    getZipTmdbIndex,
    createZipResolver,
    __resetForTests,
} = require('../../lib/zip-tmdb-index');

const cacheEntry = tmdbId => ({ m: 1, s: 1, h: { poster: true }, z: { tmdbId } });
const sortDe = names => [...names].sort((a, b) => a.localeCompare(b, 'de'));

describe('parseTmdbHint', () => {
    test('trennt Name und TMDB-ID', () => {
        expect(parseTmdbHint('Top Gun: Maverick (2022)[tmdb:361743]')).toEqual({
            name: 'Top Gun: Maverick (2022)',
            tmdbId: '361743',
        });
    });

    test('Eintrag ohne Hint', () => {
        expect(parseTmdbHint('  Ohne Hint (2026) ')).toEqual({
            name: 'Ohne Hint (2026)',
            tmdbId: null,
        });
    });

    test('normalisiert den Namen auf NFC', () => {
        const decomposed = 'Bärenstark (2024)[tmdb:1]'.normalize('NFD');
        expect(parseTmdbHint(decomposed).name).toBe('Bärenstark (2024)'.normalize('NFC'));
    });
});

describe('buildZipTmdbIndex', () => {
    test('Zahl-IDs werden Strings, Namen ohne .zip, mehrere Namen je ID', () => {
        const index = buildZipTmdbIndex({
            '/media/complete/tmdb-export/Top Gun: Maverick (2022).zip': cacheEntry(361743),
            '/media/complete/tmdb-export/Top Gun - Maverick (2022).zip': cacheEntry(361743),
            '/media/complete/manual/Privat (2026).zip': { m: 1, s: 1, h: {}, z: { title: 'x' } },
            '/media/complete/tmdb-export/Kaputt (2020).zip': null,
        });
        expect([...index.keys()]).toEqual(['361743']);
        expect(index.get('361743')).toEqual(
            sortDe(['Top Gun: Maverick (2022)', 'Top Gun - Maverick (2022)'])
        );
    });

    test('ungültige Eingaben ergeben eine leere Map', () => {
        expect(buildZipTmdbIndex(null).size).toBe(0);
        expect(buildZipTmdbIndex({ '/a.zip': { z: { tmdbId: 'abc' } } }).size).toBe(0);
    });
});

describe('getZipTmdbIndex', () => {
    let dir;
    let cachePath;

    beforeEach(() => {
        __resetForTests();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-tmdb-index-'));
        cachePath = path.join(dir, 'zip-scan-cache.json');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('fehlende Datei ergibt eine leere Map', async () => {
        const index = await getZipTmdbIndex({ cachePath });
        expect(index.size).toBe(0);
    });

    test('merkt sich den Index, solange sich die Datei nicht ändert', async () => {
        fs.writeFileSync(cachePath, JSON.stringify({ '/m/A (2020).zip': cacheEntry(1) }));
        const spy = jest.spyOn(fs.promises, 'readFile');
        try {
            const first = await getZipTmdbIndex({ cachePath });
            const second = await getZipTmdbIndex({ cachePath });
            expect(second).toBe(first);
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
    });

    test('liest eine geänderte Datei neu', async () => {
        fs.writeFileSync(cachePath, JSON.stringify({ '/m/A (2020).zip': cacheEntry(1) }));
        expect((await getZipTmdbIndex({ cachePath })).has('1')).toBe(true);

        fs.writeFileSync(
            cachePath,
            JSON.stringify({
                '/m/B (2021).zip': cacheEntry(22),
                '/m/C (2022).zip': cacheEntry(333),
            })
        );
        const index = await getZipTmdbIndex({ cachePath });
        expect([...index.keys()].sort()).toEqual(['22', '333']);
    });

    test('unlesbare Datei: letzter gültiger Stand bleibt, mit Warnung', async () => {
        const logger = { warn: jest.fn() };
        fs.writeFileSync(cachePath, JSON.stringify({ '/m/A (2020).zip': cacheEntry(7) }));
        await getZipTmdbIndex({ cachePath, logger });

        fs.writeFileSync(cachePath, '{"halb geschrieben');
        const index = await getZipTmdbIndex({ cachePath, logger });
        expect(index.get('7')).toEqual(['A (2020)']);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});

describe('createZipResolver', () => {
    const zipMtimes = new Map([
        ['Top Gun - Maverick (2022)', 1],
        ['Neu geladen (2026)', 2],
    ]);
    const tmdbIndex = new Map([
        ['361743', ['Top Gun - Maverick (2022)']],
        // Veralteter Cache-Eintrag: die Datei existiert nicht mehr
        ['999', ['Geloescht (2019)']],
    ]);
    const filmListLines = [
        'Neu geladen (2026)[tmdb:555]',
        'Nur gelistet (2025)[tmdb:777]',
        'Ohne Hint (2024)',
    ];
    const resolver = createZipResolver({ zipMtimes, tmdbIndex, filmListLines });

    test('exakter Name gewinnt', () => {
        expect(
            resolver.resolve({ canonicalKey: 'Top Gun - Maverick (2022)', tmdbId: '361743' })
        ).toEqual({ zipName: 'Top Gun - Maverick (2022)', via: 'name' });
    });

    test('anderer Name, gleiche TMDB-ID laut Cache (auch als Zahl)', () => {
        expect(
            resolver.resolve({ canonicalKey: 'Top Gun: Maverick (2022)', tmdbId: 361743 })
        ).toEqual({ zipName: 'Top Gun - Maverick (2022)', via: 'tmdb-cache' });
    });

    test('frisch geladenes ZIP ohne Cache-Eintrag über den Filmlisten-Hint', () => {
        expect(resolver.resolve({ canonicalKey: 'Neu Geladen (2026)', tmdbId: '555' })).toEqual({
            zipName: 'Neu geladen (2026)',
            via: 'tmdb-filmliste',
        });
    });

    test('veraltete Cache-Einträge und Filmlisten-Namen ohne Datei zählen nicht', () => {
        expect(resolver.resolve({ canonicalKey: 'Anders (2019)', tmdbId: '999' })).toBeNull();
        expect(resolver.resolve({ canonicalKey: 'Anders (2025)', tmdbId: '777' })).toBeNull();
    });

    test('ohne TMDB-ID bleibt es beim Namensvergleich', () => {
        expect(
            resolver.resolve({ canonicalKey: 'Top Gun: Maverick (2022)', tmdbId: null })
        ).toBeNull();
    });
});
