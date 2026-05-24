/**
 * Tests for per-device pinned playlist:
 *   - GET /api/devices/:id/playlist (global fallback, pinned, deleted-pin fallback)
 *   - PATCH /api/devices/:id with pinnedPlaylistId (valid, invalid, null)
 *
 * We don't mock `fs` at the module level (auto-hoisting is fragile in this
 * repo's babel setup). Instead we spy on `fs.promises.readFile` per-test and
 * route the two playlist file paths to controlled fixtures.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const request = require('supertest');

const createDevicesRouter = require('../../routes/devices');

const PLAYLISTS_FILE = path.join(__dirname, '..', '..', 'public', 'cinema-playlists.json');
const LIVE_PLAYLIST_FILE = path.join(__dirname, '..', '..', 'public', 'cinema-playlist.json');

let readFileSpy;
let fixtureCollection;
let fixtureLive;
const realReadFile = fs.promises.readFile.bind(fs.promises);

beforeEach(() => {
    fixtureCollection = null;
    fixtureLive = null;
    readFileSpy = jest.spyOn(fs.promises, 'readFile').mockImplementation(async (p, enc) => {
        if (p === PLAYLISTS_FILE) {
            if (fixtureCollection === null) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
            return JSON.stringify(fixtureCollection);
        }
        if (p === LIVE_PLAYLIST_FILE) {
            if (fixtureLive === null) {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            }
            return JSON.stringify(fixtureLive);
        }
        return realReadFile(p, enc);
    });
});

afterEach(() => {
    if (readFileSpy) readFileSpy.mockRestore();
});

function makeApp(deviceStore) {
    const app = express();
    app.use(
        '/api/devices',
        createDevicesRouter({
            deviceStore,
            wsHub: { isConnected: () => false, sendToDevice: () => {} },
            adminAuth: (req, res, next) => next(),
            adminAuthDevices: (req, res, next) => next(),
            testSessionShim: (req, res, next) => next(),
            deviceRegisterLimiter: (req, res, next) => next(),
            devicePairClaimLimiter: (req, res, next) => next(),
            asyncHandler: fn => fn,
            ApiError: Error,
            logger: {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn(),
            },
            isDebug: false,
            config: {},
        })
    );
    return app;
}

describe('GET /api/devices/:id/playlist', () => {
    beforeEach(() => {
        fixtureCollection = {
            activePlaylistId: 'standard',
            playlists: {
                standard: { name: 'Standard', titles: ['Movie A (2020)'] },
                bond: { name: 'James Bond', titles: ['Skyfall (2012)', 'Casino Royale (2006)'] },
            },
        };
        fixtureLive = { enabled: true, titles: ['Movie A (2020)'] };
    });

    test('returns global live playlist when device has no pin', async () => {
        const deviceStore = {
            getById: jest.fn().mockResolvedValue({ id: 'dev-1', pinnedPlaylistId: null }),
        };
        const app = makeApp(deviceStore);

        const res = await request(app).get('/api/devices/dev-1/playlist');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            enabled: true,
            titles: ['Movie A (2020)'],
            source: 'global',
        });
    });

    test('returns pinned playlist titles when device has a valid pin', async () => {
        const deviceStore = {
            getById: jest.fn().mockResolvedValue({ id: 'dev-2', pinnedPlaylistId: 'bond' }),
        };
        const app = makeApp(deviceStore);

        const res = await request(app).get('/api/devices/dev-2/playlist');
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('pinned');
        expect(res.body.playlistId).toBe('bond');
        expect(res.body.playlistName).toBe('James Bond');
        expect(res.body.titles).toEqual(['Skyfall (2012)', 'Casino Royale (2006)']);
        expect(res.body.enabled).toBe(true);
    });

    test('falls back to global when pinned playlist no longer exists', async () => {
        const deviceStore = {
            getById: jest.fn().mockResolvedValue({ id: 'dev-3', pinnedPlaylistId: 'deleted-id' }),
        };
        const app = makeApp(deviceStore);

        const res = await request(app).get('/api/devices/dev-3/playlist');
        expect(res.status).toBe(200);
        expect(res.body.source).toBe('global');
        expect(res.body.titles).toEqual(['Movie A (2020)']);
    });

    test('returns 404 when device does not exist', async () => {
        const deviceStore = { getById: jest.fn().mockResolvedValue(null) };
        const app = makeApp(deviceStore);

        const res = await request(app).get('/api/devices/missing/playlist');
        expect(res.status).toBe(404);
    });
});

describe('PATCH /api/devices/:id with pinnedPlaylistId', () => {
    beforeEach(() => {
        fixtureCollection = {
            activePlaylistId: 'standard',
            playlists: {
                standard: { name: 'Standard', titles: [] },
                bond: { name: 'James Bond', titles: [] },
            },
        };
    });

    test('accepts a valid pinnedPlaylistId and stores it', async () => {
        const deviceStore = {
            getById: jest
                .fn()
                .mockResolvedValueOnce({ id: 'dev-1', pinnedPlaylistId: null })
                .mockResolvedValueOnce({ id: 'dev-1', pinnedPlaylistId: 'bond' }),
            patchDevice: jest.fn().mockResolvedValue(true),
        };
        const app = makeApp(deviceStore);

        const res = await request(app)
            .patch('/api/devices/dev-1')
            .send({ pinnedPlaylistId: 'bond' });

        expect(res.status).toBe(200);
        expect(deviceStore.patchDevice).toHaveBeenCalledWith('dev-1', {
            pinnedPlaylistId: 'bond',
        });
    });

    test('accepts null to clear the pin', async () => {
        const deviceStore = {
            getById: jest
                .fn()
                .mockResolvedValueOnce({ id: 'dev-1', pinnedPlaylistId: 'bond' })
                .mockResolvedValueOnce({ id: 'dev-1', pinnedPlaylistId: null }),
            patchDevice: jest.fn().mockResolvedValue(true),
        };
        const app = makeApp(deviceStore);

        const res = await request(app).patch('/api/devices/dev-1').send({ pinnedPlaylistId: null });

        expect(res.status).toBe(200);
        expect(deviceStore.patchDevice).toHaveBeenCalledWith('dev-1', {
            pinnedPlaylistId: null,
        });
    });

    test('rejects an unknown pinnedPlaylistId with 400', async () => {
        const deviceStore = {
            getById: jest.fn().mockResolvedValue({ id: 'dev-1', pinnedPlaylistId: null }),
            patchDevice: jest.fn(),
        };
        const app = makeApp(deviceStore);

        const res = await request(app)
            .patch('/api/devices/dev-1')
            .send({ pinnedPlaylistId: 'does-not-exist' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'invalid_pinned_playlist' });
        expect(deviceStore.patchDevice).not.toHaveBeenCalled();
    });
});
