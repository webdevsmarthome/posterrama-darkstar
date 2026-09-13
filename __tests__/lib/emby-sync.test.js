/**
 * Unit tests for lib/emby-sync.js
 */

jest.mock('../../lib/jellyfin-helpers', () => ({
    getJellyfinClient: jest.fn(),
    getJellyfinLibraries: jest.fn(),
}));

jest.mock('../../lib/poster-updater-runner', () => ({
    isPosterRunning: jest.fn(() => false),
    isTrailerRunning: jest.fn(() => false),
    appendFilms: jest.fn(async () => ({ added: [], duplicates: [] })),
    spawnPosterPackJob: jest.fn(() => ({ started: true, pid: 123 })),
    spawnTrailerJob: jest.fn(() => ({ started: true, pid: 456 })),
    getAllExistingZips: jest.fn(async () => new Set()),
    getAllZipMtimes: jest.fn(async () => new Map()),
    readFilmList: jest.fn(async () => []),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const zipTmdbIndex = require('../../lib/zip-tmdb-index');

const { getJellyfinClient, getJellyfinLibraries } = require('../../lib/jellyfin-helpers');
const runner = require('../../lib/poster-updater-runner');
const darkstarFixture = require('../fixtures/emby-darkstar-movies.json');
const lightstarFixture = require('../fixtures/emby-lightstar-movies.json');

process.env.NODE_ENV = 'test';
const embySync = require('../../lib/emby-sync');

const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

beforeEach(() => {
    // Clear call history but NOT mock implementations
    getJellyfinClient.mockReset();
    getJellyfinLibraries.mockReset();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    logger.debug.mockClear();
    runner.isPosterRunning.mockReturnValue(false);
    runner.isTrailerRunning.mockReturnValue(false);
    runner.appendFilms.mockClear();
    runner.spawnPosterPackJob.mockClear();
    runner.spawnTrailerJob.mockClear();
    runner.getAllExistingZips.mockClear();
    runner.getAllExistingZips.mockResolvedValue(new Set());
    runner.getAllZipMtimes.mockReset();
    runner.getAllZipMtimes.mockResolvedValue(new Map());
    runner.readFilmList.mockReset();
    runner.readFilmList.mockResolvedValue([]);
    runner.appendFilms.mockResolvedValue({ added: [], duplicates: [] });
    zipTmdbIndex.__resetForTests();

    // Default clients
    getJellyfinClient.mockImplementation(async server => {
        if (server.name === 'DarkStar') {
            return { getItems: async () => darkstarFixture };
        }
        if (server.name === 'LightStar') {
            return { getItems: async () => lightstarFixture };
        }
        throw new Error('Unknown server ' + server.name);
    });
    getJellyfinLibraries.mockImplementation(async () => {
        const m = new Map();
        m.set('Movies', { id: 'lib-movies', name: 'Movies', type: 'movies' });
        return m;
    });

    embySync.__reset();
});

// Temp-Verzeichnis je Test: Report, Playlists und ZIP-Scan-Cache dürfen nie die
// echten Dateien unter cache/ und public/ treffen.
let tmp;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-sync-test-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

const depsFor = (overrides = {}) => ({
    ping: async () => true,
    reportPath: path.join(tmp, 'emby-sync-last-report.json'),
    playlistsPath: path.join(tmp, 'cinema-playlists.json'),
    livePlaylistPath: path.join(tmp, 'cinema-playlist.json'),
    zipIndexCachePath: path.join(tmp, 'zip-scan-cache.json'),
    ...overrides,
});

describe('canonicalKey', () => {
    test('baut "Titel (Jahr)" mit trim', () => {
        expect(embySync.canonicalKey('  Avatar ', 2009)).toBe('Avatar (2009)');
    });

    test('NFC-Normalisierung bei Umlauten', () => {
        // NFD "ä" (a + combining diaeresis) vs. NFC (precomposed)
        const decomposed = 'Bärenstark'; // NFD
        const composed = 'Bärenstark'; // NFC
        expect(embySync.canonicalKey(decomposed, 2024)).toBe(
            embySync.canonicalKey(composed, 2024)
        );
    });
});

describe('isIgnored', () => {
    const movie = {
        canonicalKey: 'Avatar (2009)',
        title: 'Avatar',
        year: 2009,
        imdbId: 'tt0499549',
        tmdbId: '19995',
    };

    test('matched via title+year', () => {
        expect(embySync.isIgnored(movie, [{ title: 'Avatar', year: 2009 }])).toBe(true);
    });

    test('matched via imdbId', () => {
        expect(embySync.isIgnored(movie, [{ imdbId: 'tt0499549' }])).toBe(true);
    });

    test('matched via tmdbId (string oder number)', () => {
        expect(embySync.isIgnored(movie, [{ tmdbId: '19995' }])).toBe(true);
        expect(embySync.isIgnored(movie, [{ tmdbId: 19995 }])).toBe(true);
    });

    test('matched NICHT, wenn keine Regel passt', () => {
        expect(embySync.isIgnored(movie, [{ imdbId: 'tt9999999' }])).toBe(false);
        expect(embySync.isIgnored(movie, [{ title: 'Matrix', year: 1999 }])).toBe(false);
    });

    test('leere oder ungültige Regelliste → nicht ignoriert', () => {
        expect(embySync.isIgnored(movie, [])).toBe(false);
        expect(embySync.isIgnored(movie, null)).toBe(false);
        expect(embySync.isIgnored(movie, undefined)).toBe(false);
    });

    test('reason-only Regel (ohne Identifier) matched nichts', () => {
        expect(embySync.isIgnored(movie, [{ reason: 'keine Ahnung' }])).toBe(false);
    });
});

describe('collectEmbyMovies (Multi-Server-Dedup)', () => {
    test('merged Avatar aus beiden Servern, frühestes DateCreated bleibt', async () => {
        const servers = [
            { name: 'DarkStar', type: 'jellyfin', enabled: true },
            { name: 'LightStar', type: 'jellyfin', enabled: true },
        ];
        const movies = await embySync.collectEmbyMovies(servers, {
            movieLimitPerRun: 500,
            logger,
        });
        const avatar = movies.find(m => m.canonicalKey === 'Avatar (2009)');
        expect(avatar).toBeDefined();
        expect(avatar.sourceServers.sort()).toEqual(['DarkStar', 'LightStar']);
        expect(avatar.dateCreated).toBe('2024-11-15T09:23:00.000Z');
        expect(avatar.imdbId).toBe('tt0499549');
        expect(avatar.tmdbId).toBe('19995');
    });

    test('sammelt alle Unique-Filme über beide Server', async () => {
        const servers = [
            { name: 'DarkStar', type: 'jellyfin', enabled: true },
            { name: 'LightStar', type: 'jellyfin', enabled: true },
        ];
        const movies = await embySync.collectEmbyMovies(servers, {
            movieLimitPerRun: 500,
            logger,
        });
        const keys = movies.map(m => m.canonicalKey).sort();
        expect(keys).toEqual([
            'Avatar (2009)',
            'Das Kanu des Manitu (2025)',
            'Dune (2021)',
            'Inception (2010)',
            'Matrix (1999)',
            'Oppenheimer (2023)',
        ]);
    });

    test('Film ohne ProductionYear wird verworfen', async () => {
        getJellyfinClient.mockImplementationOnce(async () => ({
            getItems: async () => ({
                Items: [
                    { Name: 'Unknown', ProductionYear: null, Id: 'x' },
                    { Name: 'Good', ProductionYear: 2024, Id: 'y' },
                ],
            }),
        }));
        const movies = await embySync.collectEmbyMovies(
            [{ name: 'DarkStar', type: 'jellyfin', enabled: true }],
            { movieLimitPerRun: 500, logger }
        );
        expect(movies.map(m => m.canonicalKey)).toEqual(['Good (2024)']);
    });
});

describe('Silent-Skip bei leerer Server-Liste / allen offline', () => {
    test('keine mediaServers → report.result === all-offline, keine Spawns', async () => {
        const config = {
            mediaServers: [],
            embySync: {
                enabled: true,
                autoPlaylist: { enabled: false },
                downloads: { posterPack: false, trailer: false },
            },
        };
        const report = await embySync.runSyncCycle({
            logger,
            config,
            trigger: 'test',
            deps: depsFor(),
        });
        // Report landet im Temp-Verzeichnis, nicht in cache/
        expect(fs.existsSync(path.join(tmp, 'emby-sync-last-report.json'))).toBe(true);
        expect(report.result).toBe('all-offline');
        expect(report.added).toEqual([]);
        expect(runner.spawnPosterPackJob).not.toHaveBeenCalled();
        expect(runner.spawnTrailerJob).not.toHaveBeenCalled();
    });
});

describe('TMDB-Abgleich (z-20)', () => {
    const movieItem = (Name, ProductionYear, Tmdb) => ({
        Name,
        ProductionYear,
        ProviderIds: Tmdb ? { Tmdb } : {},
        DateCreated: '2026-01-01T00:00:00.000Z',
        Type: 'Movie',
    });
    const serveItems = byServer => {
        getJellyfinClient.mockImplementation(async server => ({
            getItems: async () => ({ Items: byServer[server.name] || [] }),
        }));
    };
    const configFor = (names = ['ServerA']) => ({
        mediaServers: names.map(name => ({ name, type: 'jellyfin', enabled: true })),
        embySync: { autoPlaylist: { enabled: false }, downloads: { trailer: false } },
    });
    const run = config =>
        embySync.runSyncCycle({ logger, config, trigger: 'test', deps: depsFor() });

    test('anderer Emby-Name, TMDB-ID im ZIP-Scan-Cache → has-zip-tmdb, kein Download', async () => {
        fs.writeFileSync(
            path.join(tmp, 'zip-scan-cache.json'),
            JSON.stringify({
                '/media/complete/tmdb-export/Top Gun - Maverick (2022).zip': {
                    m: 1,
                    s: 1,
                    h: { poster: true },
                    z: { tmdbId: 361743 },
                },
            })
        );
        runner.getAllZipMtimes.mockResolvedValue(new Map([['Top Gun - Maverick (2022)', 1]]));
        serveItems({ ServerA: [movieItem('Top Gun: Maverick', 2022, '361743')] });

        const report = await run(configFor());

        expect(report.added).toEqual([]);
        expect(report.skipped).toEqual([
            {
                key: 'Top Gun: Maverick (2022)',
                reason: 'has-zip-tmdb',
                tmdbId: '361743',
                zip: 'Top Gun - Maverick (2022)',
                via: 'tmdb-cache',
            },
        ]);
        expect(runner.appendFilms).not.toHaveBeenCalled();
        expect(runner.spawnPosterPackJob).not.toHaveBeenCalled();
    });

    test('frisch geladenes ZIP (noch nicht im Cache) wird über den Filmlisten-Hint erkannt', async () => {
        runner.getAllZipMtimes.mockResolvedValue(new Map([['Neu geladen (2026)', 1]]));
        runner.readFilmList.mockResolvedValue(['Neu geladen (2026)[tmdb:555]']);
        serveItems({ ServerA: [movieItem('Neu Geladen', 2026, '555')] });

        const report = await run(configFor());

        expect(report.added).toEqual([]);
        expect(report.skipped[0]).toMatchObject({
            reason: 'has-zip-tmdb',
            zip: 'Neu geladen (2026)',
            via: 'tmdb-filmliste',
        });
    });

    test('Name-Treffer tragen die TMDB-ID im Report', async () => {
        runner.getAllZipMtimes.mockResolvedValue(new Map([['Avatar (2009)', 1]]));
        serveItems({ ServerA: [movieItem('Avatar', 2009, '19995')] });

        const report = await run(configFor());

        expect(report.skipped).toEqual([
            { key: 'Avatar (2009)', reason: 'has-zip', tmdbId: '19995' },
        ]);
    });

    test('Film ohne TMDB-ID und ohne ZIP wird weiterhin geladen', async () => {
        serveItems({ ServerA: [movieItem('Ohne ID', 2026, null)] });

        const report = await run(configFor());

        expect(report.added.map(a => a.key)).toEqual(['Ohne ID (2026)']);
        expect(runner.appendFilms).toHaveBeenCalledWith(['Ohne ID (2026)']);
        expect(runner.spawnPosterPackJob).toHaveBeenCalledTimes(1);
    });

    test('zwei Server, derselbe Film unter zwei Namen → nur ein Download', async () => {
        serveItems({
            ServerA: [movieItem('Wicked Teil 1', 2024, '402431')],
            ServerB: [movieItem('Wicked', 2024, '402431')],
        });

        const report = await run(configFor(['ServerA', 'ServerB']));

        expect(runner.appendFilms).toHaveBeenCalledWith(['Wicked Teil 1 (2024)[tmdb:402431]']);
        expect(report.skipped).toEqual([
            { key: 'Wicked (2024)', reason: 'duplicate-in-run-tmdb', tmdbId: '402431' },
        ]);
        expect(report.append).toMatchObject({ added: 0, duplicates: 0 });
    });
});

describe('updateAutoPlaylist (z-20)', () => {
    const cfg = { enabled: true, id: 'auto_recent_20', limit: 20 };

    test('Titel ist der ZIP-Name, zwei Emby-Namen desselben Films belegen einen Slot', async () => {
        const zipMtimes = new Map([
            ['Top Gun - Maverick (2022)', 1],
            ['Avatar (2009)', 1],
        ]);
        const resolver = zipTmdbIndex.createZipResolver({
            zipMtimes,
            tmdbIndex: new Map([['361743', ['Top Gun - Maverick (2022)']]]),
        });
        const movies = [
            { canonicalKey: 'Avatar (2009)', tmdbId: '19995', dateCreated: '2025-01-01' },
            {
                canonicalKey: 'Top Gun: Maverick (2022)',
                tmdbId: '361743',
                dateCreated: '2026-02-01',
            },
            {
                canonicalKey: 'Top Gun - Maverick (2022)',
                tmdbId: '361743',
                dateCreated: '2026-01-01',
            },
        ];
        const { playlistsPath, livePlaylistPath } = depsFor();

        const result = await embySync.updateAutoPlaylist(movies, zipMtimes, cfg, {
            logger,
            resolver,
            playlistsPath,
            livePlaylistPath,
        });

        expect(result).toMatchObject({ changed: true, titleCount: 2 });
        const saved = JSON.parse(fs.readFileSync(playlistsPath, 'utf8'));
        expect(saved.playlists.auto_recent_20.titles).toEqual([
            'Top Gun - Maverick (2022)',
            'Avatar (2009)',
        ]);
        expect(fs.readdirSync(tmp).filter(f => f.endsWith('.tmp'))).toEqual([]);
    });

    test('Leer-Schutz: eine befüllte Auto-Playlist wird nicht geleert', async () => {
        const { playlistsPath, livePlaylistPath } = depsFor();
        const before = {
            activePlaylistId: 'auto_recent_20',
            playlists: {
                auto_recent_20: { name: 'Auto', titles: ['Alt (2020)'], initiallyActivated: true },
            },
        };
        fs.writeFileSync(playlistsPath, JSON.stringify(before));

        const result = await embySync.updateAutoPlaylist([], new Map(), cfg, {
            logger,
            playlistsPath,
            livePlaylistPath,
        });

        expect(result).toMatchObject({ changed: false, skipped: 'empty-guard' });
        expect(JSON.parse(fs.readFileSync(playlistsPath, 'utf8'))).toEqual(before);
        expect(logger.warn).toHaveBeenCalled();
    });
});

describe('getStatus', () => {
    test('liefert lastRun/nextRun/running/enabled', () => {
        const status = embySync.getStatus({
            embySync: { enabled: true, intervalMinutes: 60 },
        });
        expect(status.enabled).toBe(true);
        expect(status.intervalMinutes).toBe(60);
        expect(status.running).toBe(false);
    });
});
