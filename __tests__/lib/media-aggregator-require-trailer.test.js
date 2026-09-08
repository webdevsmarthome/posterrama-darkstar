/**
 * Tests for the localDirectory.requireTrailer filter in media-aggregator.js:
 * local movie items without a trailerUrl are excluded from the playlist,
 * while motion posters and standalone backgrounds stay untouched.
 */

const { getPlaylistMedia } = require('../../lib/media-aggregator');

jest.mock('../../sources/plex.js');
jest.mock('../../sources/jellyfin.js');
jest.mock('../../sources/tmdb.js');
jest.mock('../../sources/romm.js');
jest.mock('../../lib/plex-helpers.js');
jest.mock('../../lib/jellyfin-helpers.js');

describe('Media Aggregator - localDirectory.requireTrailer', () => {
    let mockLogger;

    const rawPosters = [
        {
            sourceId: 'film-with-local-trailer',
            title: 'Film A',
            year: 2020,
            poster: '/a.jpg',
            directory: 'posters',
            trailerUrl: '/trailers/Film%20A%20(2020)-trailer.mp4',
        },
        {
            sourceId: 'film-without-trailer',
            title: 'Film B',
            year: 1956,
            poster: '/b.jpg',
            directory: 'posters',
            trailerUrl: null,
        },
        {
            sourceId: 'film-with-zip-trailer',
            title: 'Film C',
            year: 2021,
            poster: '/c.jpg',
            directory: 'posters',
            trailerUrl: '/local-posterpack?zip=c.zip&entry=trailer',
        },
        {
            sourceId: 'film-with-youtube-trailer',
            title: 'Film D',
            year: 2022,
            poster: '/d.jpg',
            directory: 'posters',
            trailerUrl: 'https://www.youtube.com/watch?v=abc123',
        },
    ];

    const rawBackgrounds = [
        {
            sourceId: 'wallpaper-1',
            title: 'Wallpaper',
            poster: '/wall.jpg',
            directory: 'backgrounds',
            trailerUrl: null,
        },
        // Background entry of Film B (same sourceId -> dedup case)
        {
            sourceId: 'film-without-trailer',
            title: 'Film B',
            year: 1956,
            poster: '/b-bg.jpg',
            directory: 'backgrounds',
            trailerUrl: null,
        },
    ];

    const rawMotion = [
        {
            sourceId: 'motion-1',
            title: 'Motion Poster',
            type: 'motion',
            isMotionPoster: true,
            motionPosterUrl: '/motion/m.mp4',
            poster: '/m.jpg',
            directory: 'motion',
            trailerUrl: null,
        },
    ];

    function makeLocalSource() {
        return {
            fetchMedia: jest.fn(async (_libraries, type) => {
                if (type === 'poster') return rawPosters;
                if (type === 'background') return rawBackgrounds;
                if (type === 'motion') return rawMotion;
                return [];
            }),
            getMetrics: jest.fn(() => ({ lastFetch: new Date().toISOString() })),
        };
    }

    function makeConfig(requireTrailer) {
        const localDirectory = { enabled: true, rootPath: 'media' };
        if (requireTrailer !== undefined) localDirectory.requireTrailer = requireTrailer;
        return {
            mediaServers: [],
            tmdbSource: null,
            streamingSources: [],
            localDirectory,
        };
    }

    async function run(requireTrailer) {
        const result = await getPlaylistMedia({
            config: makeConfig(requireTrailer),
            processPlexItem: jest.fn(item => item),
            shuffleArray: jest.fn(arr => arr),
            localDirectorySource: makeLocalSource(),
            logger: mockLogger,
            isDebug: false,
        });
        return result.media.filter(m => m.source === 'local');
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
    });

    test('requireTrailer disabled: all local items stay', async () => {
        const media = await run(false);
        const ids = media.map(m => m.id);
        expect(ids).toContain('local-film-without-trailer');
        expect(ids).toContain('local-wallpaper-1');
        expect(ids).toContain('local-motion-1');
        expect(media).toHaveLength(6); // 4 posters + wallpaper + motion (Film B deduped)
    });

    test('requireTrailer missing from config: behaves like disabled', async () => {
        const media = await run(undefined);
        expect(media.map(m => m.id)).toContain('local-film-without-trailer');
        expect(media).toHaveLength(6);
    });

    test('requireTrailer enabled: only the film without any trailerUrl is dropped', async () => {
        const media = await run(true);
        const ids = media.map(m => m.id);
        expect(ids).not.toContain('local-film-without-trailer');
        expect(ids).toContain('local-film-with-local-trailer');
        expect(ids).toContain('local-film-with-zip-trailer');
        expect(ids).toContain('local-film-with-youtube-trailer');
        expect(media).toHaveLength(5);
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining('requireTrailer active: filtered 1 of 6')
        );
    });

    test('requireTrailer enabled: motion posters and standalone backgrounds are exempt', async () => {
        const media = await run(true);
        const ids = media.map(m => m.id);
        expect(ids).toContain('local-motion-1');
        expect(ids).toContain('local-wallpaper-1');
    });

    test('dedup: a film without trailer does not sneak back in via its background entry', async () => {
        const media = await run(true);
        expect(media.filter(m => m.id === 'local-film-without-trailer')).toHaveLength(0);
    });
});
