/**
 * Jellyfin Sessions Polling Service
 * Polls the /Sessions endpoint of every enabled Jellyfin server and caches
 * the merged results. Errors are isolated per server: an unreachable server
 * enters exponential backoff (and is retried automatically) without affecting
 * polling of the remaining servers — the poller itself never stops on errors.
 */

const logger = require('../utils/logger');
const EventEmitter = require('events');

class JellyfinSessionsPoller extends EventEmitter {
    constructor({ getJellyfinClient, config, pollInterval = 10000 }) {
        super();
        this.getJellyfinClient = getJellyfinClient;
        this.config = config;
        this.pollInterval = pollInterval;
        this.isRunning = false;
        this.pollTimer = null;
        this.lastSessions = [];
        this.lastUpdate = null;
        this.maxErrors = 5;
        // Per-server error/backoff state, keyed by server name (fallback host:port).
        // Shape: { errorCount, backoffMs, backoffUntil, sessions }
        this.serverStates = new Map();
        this.backoffBaseMs = 60000;
        this.backoffMaxMs = 300000;
    }

    /**
     * Start polling Jellyfin sessions
     */
    start() {
        if (this.isRunning) {
            logger.debug('Jellyfin sessions poller already running');
            return;
        }

        logger.info('🎬 Starting Jellyfin sessions poller', {
            interval: `${this.pollInterval}ms`,
        });

        this.isRunning = true;
        this.serverStates.clear();

        // Initial poll
        this.poll();
    }

    /**
     * Stop polling
     */
    stop() {
        if (!this.isRunning) return;

        logger.info('Stopping Jellyfin sessions poller');
        this.isRunning = false;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * Restart polling
     */
    restart() {
        logger.info('Restarting Jellyfin sessions poller');
        this.serverStates.clear();
        if (!this.isRunning) {
            this.start();
        }
    }

    /**
     * Poll all enabled Jellyfin servers for active sessions
     */
    async poll() {
        if (!this.isRunning) return;

        try {
            const servers = (this.config.mediaServers || []).filter(
                s => s.enabled && s.type === 'jellyfin'
            );

            if (servers.length === 0) {
                logger.debug('No Jellyfin server configured, skipping sessions poll');
                this.scheduleNextPoll();
                return;
            }

            const merged = [];
            for (const server of servers) {
                const sessions = await this.pollServer(server);
                merged.push(...sessions);
            }

            const hasChanges = this.detectChanges(merged);

            this.lastSessions = merged;
            this.lastUpdate = Date.now();

            if (hasChanges) {
                this.emit('sessions', merged);
            }

            logger.debug('Jellyfin sessions polled', {
                count: merged.length,
                hasChanges,
            });
        } catch (error) {
            // Unexpected failure outside the per-server handling — log and keep
            // the polling loop alive; it must never die on errors.
            logger.error('Jellyfin sessions poller: unexpected error', {
                error: error.message,
            });
        }

        this.scheduleNextPoll();
    }

    /**
     * Poll a single server with isolated error/backoff state.
     * Contributes fresh sessions on success, the last known sessions during a
     * short error grace period, and nothing while the server is in backoff.
     */
    async pollServer(server) {
        const key = server.name || `${server.hostname || server.host}:${server.port}`;
        let state = this.serverStates.get(key);
        if (!state) {
            state = { errorCount: 0, backoffMs: 0, backoffUntil: 0, sessions: [] };
            this.serverStates.set(key, state);
        }

        if (state.backoffUntil > Date.now()) {
            return [];
        }

        try {
            const jellyfin = await this.getJellyfinClient(server);

            // Fetch sessions - Jellyfin uses /Sessions endpoint
            const response = await jellyfin.http.get('/Sessions');
            const sessions = response?.data || [];

            // Filter to only sessions with NowPlayingItem (currently playing)
            const activeSessions = sessions.filter(session => session.NowPlayingItem);

            if (state.errorCount >= this.maxErrors) {
                logger.info('Jellyfin sessions poller: server recovered, resuming polling', {
                    server: key,
                });
            }
            state.errorCount = 0;
            state.backoffMs = 0;
            state.backoffUntil = 0;
            state.sessions = activeSessions.map(session => this.processSession(session, server));
            return state.sessions;
        } catch (error) {
            state.errorCount++;

            if (state.errorCount < this.maxErrors) {
                logger.warn('Failed to poll Jellyfin sessions', {
                    server: key,
                    error: error.message,
                    errorCount: state.errorCount,
                });
                // Grace period: keep the last known sessions on transient errors
                return state.sessions;
            }

            state.backoffMs = Math.min(
                state.backoffMs > 0 ? state.backoffMs * 2 : this.backoffBaseMs,
                this.backoffMaxMs
            );
            state.backoffUntil = Date.now() + state.backoffMs;
            state.sessions = [];
            logger.warn('Jellyfin sessions poller: server unreachable, backing off', {
                server: key,
                error: error.message,
                errorCount: state.errorCount,
                retryInSeconds: Math.round(state.backoffMs / 1000),
            });
            return [];
        }
    }

    /**
     * Process a Jellyfin session into our standardized format
     */
    processSession(session, serverConfig) {
        const item = session.NowPlayingItem;
        const playState = session.PlayState || {};

        const itemId = item.Id;

        // Jellyfin uses different image endpoints
        const thumb = itemId ? `/Items/${itemId}/Images/Primary` : null;
        const art = itemId ? `/Items/${itemId}/Images/Backdrop` : null;

        // Calculate viewOffset in milliseconds (Jellyfin uses ticks, 10000 ticks = 1ms)
        const positionTicks = playState.PositionTicks || 0;
        const viewOffset = Math.floor(positionTicks / 10000);

        // Duration in milliseconds
        const durationTicks = item.RunTimeTicks || 0;
        const duration = Math.floor(durationTicks / 10000);

        return {
            // Session identifiers
            sessionKey: session.Id,
            ratingKey: item.Id,
            key: `/Items/${item.Id}`,

            // Media info
            type: this.mapMediaType(item.Type),
            title: item.Name || 'Unknown',
            year: item.ProductionYear,
            thumb,
            art,

            // For TV shows
            grandparentTitle: item.SeriesName || null,
            parentIndex: item.ParentIndexNumber, // Season number
            index: item.IndexNumber, // Episode number

            // Progress info
            viewOffset,
            duration,

            // State - map Jellyfin state to Plex-like format
            state: playState.IsPaused ? 'paused' : 'playing',

            // User info
            username: session.UserName,
            User: {
                id: session.UserId,
                title: session.UserName,
                thumb: session.UserId ? `/Users/${session.UserId}/Images/Primary` : null,
            },

            // Player info
            Player: {
                state: playState.IsPaused ? 'paused' : 'playing',
                device: session.DeviceName || session.Client,
                platform: session.Client,
                product: session.Client,
                title: session.DeviceName || session.Client,
            },

            // Keep original Jellyfin fields for compatibility
            PlayState: playState,
            IsPaused: playState.IsPaused || false,

            // Source identifier
            _source: 'jellyfin',
            _serverName: serverConfig.name || 'Jellyfin',
        };
    }

    /**
     * Map Jellyfin media type to Plex-like type
     */
    mapMediaType(jellyfinType) {
        const typeMap = {
            Movie: 'movie',
            Episode: 'episode',
            Series: 'show',
            Audio: 'track',
            MusicVideo: 'clip',
            Video: 'movie',
        };
        return typeMap[jellyfinType] || 'movie';
    }

    /**
     * Detect if sessions have changed
     */
    detectChanges(newSessions) {
        if (newSessions.length !== this.lastSessions.length) return true;

        for (let i = 0; i < newSessions.length; i++) {
            const newSession = newSessions[i];
            const oldSession = this.lastSessions.find(s => s.sessionKey === newSession.sessionKey);

            if (!oldSession) return true;

            // Check for significant changes
            if (
                oldSession.ratingKey !== newSession.ratingKey ||
                oldSession.state !== newSession.state ||
                Math.abs((oldSession.viewOffset || 0) - (newSession.viewOffset || 0)) > 5000
            ) {
                return true;
            }
        }

        return false;
    }

    /**
     * Schedule next poll
     */
    scheduleNextPoll() {
        if (!this.isRunning) return;

        this.pollTimer = setTimeout(() => {
            this.poll();
        }, this.pollInterval);
    }

    /**
     * Get cached sessions
     */
    getSessions() {
        return {
            sessions: this.lastSessions,
            lastUpdate: this.lastUpdate,
            isActive: this.isRunning,
        };
    }

    /**
     * Force immediate poll
     */
    async forcePoll() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        await this.poll();
    }
}

module.exports = JellyfinSessionsPoller;
