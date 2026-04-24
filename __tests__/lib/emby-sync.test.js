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
}));

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
        const report = await embySync.runSyncCycle({ logger, config, trigger: 'test' });
        expect(report.result).toBe('all-offline');
        expect(report.added).toEqual([]);
        expect(runner.spawnPosterPackJob).not.toHaveBeenCalled();
        expect(runner.spawnTrailerJob).not.toHaveBeenCalled();
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
