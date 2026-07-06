/**
 * Tests for JellyfinSessionsPoller service
 * Focus: multi-server polling, per-server error isolation, backoff + auto-recovery
 */

const JellyfinSessionsPoller = require('../../services/jellyfinSessionsPoller');
const logger = require('../../utils/logger');

// Mock logger
jest.mock('../../utils/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const makeJellyfinSession = (id, name) => ({
    Id: `session-${id}`,
    UserName: 'TestUser',
    UserId: 'user1',
    Client: 'TV App',
    DeviceName: 'Living Room TV',
    PlayState: { IsPaused: false, PositionTicks: 600000000 }, // 60s
    NowPlayingItem: {
        Id: `item-${id}`,
        Name: name,
        Type: 'Movie',
        ProductionYear: 2024,
        RunTimeTicks: 72000000000, // 2h
    },
});

describe('JellyfinSessionsPoller', () => {
    let poller;
    let mockGetJellyfinClient;
    let mockConfig;
    let clientA;
    let clientB;

    const callsFor = serverName =>
        mockGetJellyfinClient.mock.calls.filter(c => c[0].name === serverName).length;

    const runCycles = async n => {
        for (let i = 0; i < n; i++) {
            await jest.advanceTimersByTimeAsync(10000);
        }
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();

        mockConfig = {
            mediaServers: [
                { enabled: true, type: 'jellyfin', name: 'ServerA' },
                { enabled: true, type: 'jellyfin', name: 'ServerB' },
                { enabled: false, type: 'jellyfin', name: 'DisabledServer' },
                { enabled: true, type: 'plex', name: 'PlexServer' },
            ],
        };

        clientA = { http: { get: jest.fn() } };
        clientB = { http: { get: jest.fn() } };

        mockGetJellyfinClient = jest.fn(server =>
            Promise.resolve(server.name === 'ServerA' ? clientA : clientB)
        );
    });

    afterEach(() => {
        if (poller) {
            poller.stop();
        }
        jest.useRealTimers();
    });

    const createPoller = () => {
        poller = new JellyfinSessionsPoller({
            getJellyfinClient: mockGetJellyfinClient,
            config: mockConfig,
        });
        return poller;
    };

    describe('Constructor', () => {
        test('should initialize with default values', () => {
            createPoller();

            expect(poller.isRunning).toBe(false);
            expect(poller.maxErrors).toBe(5);
            expect(poller.pollInterval).toBe(10000);
            expect(poller.lastSessions).toEqual([]);
            expect(poller.lastUpdate).toBeNull();
            expect(poller.serverStates.size).toBe(0);
        });
    });

    describe('poll()', () => {
        test('should poll ALL enabled Jellyfin servers and merge sessions', async () => {
            clientA.http.get.mockResolvedValue({ data: [makeJellyfinSession('a1', 'Movie A')] });
            clientB.http.get.mockResolvedValue({ data: [makeJellyfinSession('b1', 'Movie B')] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();

            expect(callsFor('ServerA')).toBeGreaterThanOrEqual(1);
            expect(callsFor('ServerB')).toBeGreaterThanOrEqual(1);
            expect(callsFor('DisabledServer')).toBe(0);
            expect(poller.lastSessions).toHaveLength(2);
            expect(poller.lastSessions.map(s => s._serverName).sort()).toEqual([
                'ServerA',
                'ServerB',
            ]);
        });

        test('should skip polling if no Jellyfin server configured', async () => {
            mockConfig = { mediaServers: [] };
            createPoller().start();
            await jest.runOnlyPendingTimersAsync();

            expect(mockGetJellyfinClient).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalledWith(
                'No Jellyfin server configured, skipping sessions poll'
            );
        });

        test('should only include sessions with NowPlayingItem', async () => {
            clientA.http.get.mockResolvedValue({
                data: [makeJellyfinSession('a1', 'Movie A'), { Id: 'idle', UserName: 'Idle' }],
            });
            clientB.http.get.mockResolvedValue({ data: [] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();

            expect(poller.lastSessions).toHaveLength(1);
            expect(poller.lastSessions[0].title).toBe('Movie A');
        });

        test('should emit sessions event when sessions change', async () => {
            clientA.http.get.mockResolvedValue({ data: [makeJellyfinSession('a1', 'Movie A')] });
            clientB.http.get.mockResolvedValue({ data: [] });

            createPoller();
            const handler = jest.fn();
            poller.on('sessions', handler);

            poller.start();
            await jest.runOnlyPendingTimersAsync();

            expect(handler).toHaveBeenCalledWith(
                expect.arrayContaining([expect.objectContaining({ title: 'Movie A' })])
            );
        });
    });

    describe('Per-server error isolation', () => {
        test('one failing server must not affect polling of the other', async () => {
            clientA.http.get.mockRejectedValue(new Error('ECONNREFUSED'));
            clientB.http.get.mockResolvedValue({ data: [makeJellyfinSession('b1', 'Movie B')] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();

            expect(poller.isRunning).toBe(true);
            expect(poller.lastSessions).toHaveLength(1);
            expect(poller.lastSessions[0]._serverName).toBe('ServerB');
            expect(logger.warn).toHaveBeenCalledWith(
                'Failed to poll Jellyfin sessions',
                expect.objectContaining({ server: 'ServerA' })
            );
        });

        test('should keep last known sessions during transient errors (grace period)', async () => {
            clientA.http.get.mockResolvedValue({ data: [makeJellyfinSession('a1', 'Movie A')] });
            clientB.http.get.mockResolvedValue({ data: [makeJellyfinSession('b1', 'Movie B')] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();
            expect(poller.lastSessions).toHaveLength(2);

            // ServerA starts failing transiently
            clientA.http.get.mockRejectedValue(new Error('timeout'));
            await runCycles(1);

            // Grace: ServerA's last known session is still part of the merged list
            expect(poller.lastSessions).toHaveLength(2);
        });

        test('should enter backoff after maxErrors and drop its sessions', async () => {
            clientA.http.get.mockRejectedValue(new Error('ECONNREFUSED'));
            clientB.http.get.mockResolvedValue({ data: [makeJellyfinSession('b1', 'Movie B')] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();
            // Drive cycles until ServerA hits maxErrors
            for (let i = 0; i < 10; i++) {
                const st = poller.serverStates.get('ServerA');
                if (st && st.errorCount >= poller.maxErrors) break;
                await runCycles(1);
            }

            const state = poller.serverStates.get('ServerA');
            expect(state.errorCount).toBe(5);
            expect(state.backoffMs).toBe(60000);
            expect(state.backoffUntil).toBeGreaterThan(Date.now());
            expect(poller.isRunning).toBe(true);
            expect(poller.lastSessions).toHaveLength(1);
            expect(poller.lastSessions[0]._serverName).toBe('ServerB');
            expect(logger.warn).toHaveBeenCalledWith(
                'Jellyfin sessions poller: server unreachable, backing off',
                expect.objectContaining({ server: 'ServerA', retryInSeconds: 60 })
            );
        });

        test('should skip a server while in backoff but keep polling the other', async () => {
            clientA.http.get.mockRejectedValue(new Error('ECONNREFUSED'));
            clientB.http.get.mockResolvedValue({ data: [] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();
            for (let i = 0; i < 10; i++) {
                const st = poller.serverStates.get('ServerA');
                if (st && st.errorCount >= poller.maxErrors) break;
                await runCycles(1);
            }

            const callsA = callsFor('ServerA');
            const callsB = callsFor('ServerB');

            // One normal cycle (10s) — well within ServerA's 60s backoff window
            await runCycles(1);

            expect(callsFor('ServerA')).toBe(callsA);
            expect(callsFor('ServerB')).toBe(callsB + 1);
        });

        test('should auto-recover a server after backoff expires', async () => {
            clientA.http.get.mockRejectedValue(new Error('ECONNREFUSED'));
            clientB.http.get.mockResolvedValue({ data: [] });

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();
            for (let i = 0; i < 10; i++) {
                const st = poller.serverStates.get('ServerA');
                if (st && st.errorCount >= poller.maxErrors) break;
                await runCycles(1);
            }
            const callsA = callsFor('ServerA');

            // Server comes back online
            clientA.http.get.mockResolvedValue({ data: [makeJellyfinSession('a1', 'Movie A')] });

            // Advance past the 60s backoff window (poll cadence continues at 10s)
            await jest.advanceTimersByTimeAsync(70000);

            expect(callsFor('ServerA')).toBeGreaterThan(callsA);
            const state = poller.serverStates.get('ServerA');
            expect(state.errorCount).toBe(0);
            expect(state.backoffMs).toBe(0);
            expect(poller.lastSessions).toHaveLength(1);
            expect(poller.lastSessions[0]._serverName).toBe('ServerA');
            expect(logger.info).toHaveBeenCalledWith(
                'Jellyfin sessions poller: server recovered, resuming polling',
                { server: 'ServerA' }
            );
        });

        test('poller must never stop on errors', async () => {
            clientA.http.get.mockRejectedValue(new Error('down'));
            clientB.http.get.mockRejectedValue(new Error('down'));

            createPoller().start();
            await jest.runOnlyPendingTimersAsync();
            await runCycles(8);

            expect(poller.isRunning).toBe(true);
            expect(poller.pollTimer).not.toBeNull();
            expect(logger.error).not.toHaveBeenCalledWith(
                'Jellyfin sessions poller: too many errors, stopping'
            );
        });
    });

    describe('restart()', () => {
        test('should clear per-server states', () => {
            createPoller();
            poller.serverStates.set('ServerA', {
                errorCount: 5,
                backoffMs: 60000,
                backoffUntil: Date.now() + 60000,
                sessions: [],
            });

            poller.restart();

            // Old backoff state is discarded; the immediate fresh poll may
            // already have re-created a clean entry (errorCount 0, no backoff).
            const state = poller.serverStates.get('ServerA');
            expect(state ? state.errorCount : 0).toBe(0);
            expect(state ? state.backoffMs : 0).toBe(0);
            expect(poller.isRunning).toBe(true);
        });
    });

    describe('processSession()', () => {
        test('should map Jellyfin session into standardized format', () => {
            createPoller();
            const raw = makeJellyfinSession('x1', 'Test Movie');
            raw.PlayState.IsPaused = true;

            const mapped = poller.processSession(raw, { name: 'ServerA' });

            expect(mapped).toMatchObject({
                sessionKey: 'session-x1',
                ratingKey: 'item-x1',
                type: 'movie',
                title: 'Test Movie',
                year: 2024,
                state: 'paused',
                username: 'TestUser',
                viewOffset: 60000,
                duration: 7200000,
                _source: 'jellyfin',
                _serverName: 'ServerA',
            });
        });
    });

    describe('getSessions()', () => {
        test('should return cached sessions with metadata', () => {
            createPoller();
            poller.lastSessions = [{ ratingKey: '123', title: 'Test' }];
            poller.lastUpdate = 1234567890;
            poller.isRunning = true;

            expect(poller.getSessions()).toEqual({
                sessions: [{ ratingKey: '123', title: 'Test' }],
                lastUpdate: 1234567890,
                isActive: true,
            });
        });
    });
});
