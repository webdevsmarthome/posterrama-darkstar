'use strict';

/**
 * emby-sync
 *
 * Regelmäßiger Abgleich mit Emby/Jellyfin-Servern (DarkStar, LightStar):
 *  - Online-Check in Reihenfolge (DarkStar zuerst, dann LightStar)
 *  - Wenn beide offline: stumm überspringen
 *  - Für online-Server alle Movie-Libraries durchgehen, nach DateCreated descend
 *  - Multi-Server-Dedup per canonicalKey ("Titel (Jahr)", NFC)
 *  - Diff gegen vorhandene PosterPacks (alle 5 Unterordner von media/complete)
 *  - Diff gegen Ignore-Liste
 *  - PosterPack + Trailer-Download via shared runner anstoßen
 *  - Auto-Playlist "Die letzten 20 hinzugefügten Filme" aktualisieren
 *  - Report in cache/emby-sync-last-report.json
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fsp = require('fs').promises;

const { getJellyfinClient, getJellyfinLibraries } = require('./jellyfin-helpers');
const runner = require('./poster-updater-runner');

const PROJECT_ROOT = path.join(__dirname, '..');
const PLAYLISTS_PATH = path.join(PROJECT_ROOT, 'public', 'cinema-playlists.json');
const LIVE_PLAYLIST_PATH = path.join(PROJECT_ROOT, 'public', 'cinema-playlist.json');
const REPORT_PATH = path.join(PROJECT_ROOT, 'cache', 'emby-sync-last-report.json');

// --- Module-level state (singleton) ---
let state = {
    inProgress: false,
    lastRun: null,
    nextRun: null,
    scheduledTimer: null,
    scheduledInitialTimeout: null,
};

// --- Utilities ---
function canonicalKey(title, year) {
    return `${String(title).trim()} (${year})`.normalize('NFC');
}

/**
 * Leichtgewichtiger Online-Check via /System/Info/Public.
 * Direkter HTTP-Call mit hartem Timeout — bewusst ohne den axios-basierten
 * jellyfin-http-client, der Retries einbaut und damit den Ping auf mehrere
 * Sekunden strecken würde.
 */
function pingJellyfin(server, { timeoutMs = 2000 } = {}) {
    return new Promise(resolve => {
        let settled = false;
        const done = ok => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        try {
            const mod = server.ssl ? https : http;
            const req = mod.request(
                {
                    host: server.hostname,
                    port: server.port,
                    path: '/System/Info/Public',
                    method: 'GET',
                    timeout: timeoutMs,
                    headers: { Accept: 'application/json' },
                },
                res => {
                    res.resume();
                    res.on('end', () => done(res.statusCode >= 200 && res.statusCode < 400));
                    res.on('error', () => done(false));
                }
            );
            req.on('error', () => done(false));
            req.on('timeout', () => {
                try {
                    req.destroy();
                } catch {
                    /* ignore */
                }
                done(false);
            });
            req.end();
        } catch {
            done(false);
        }
    });
}

/**
 * Sammelt Movies von allen online-Servern. Dedup per canonicalKey,
 * Multi-Server-Merge (frühestes DateCreated, sourceServers akkumulieren,
 * IDs konsolidieren).
 */
async function collectEmbyMovies(onlineServers, { movieLimitPerRun = 500, logger }) {
    const byKey = new Map();
    for (const server of onlineServers) {
        try {
            const client = await getJellyfinClient(server);
            const libs = await getJellyfinLibraries(server);

            // Optional: User-konfigurierte movieLibraryNames priorisieren, sonst
            // alle Libraries mit CollectionType 'movies'.
            const configured = Array.isArray(server.movieLibraryNames)
                ? server.movieLibraryNames.filter(Boolean)
                : [];
            const targetLibs = [];
            if (configured.length > 0) {
                for (const name of configured) {
                    const lib = libs.get(name);
                    if (lib) targetLibs.push(lib);
                }
            } else {
                for (const [, libData] of libs) {
                    if (libData.type === 'movies') targetLibs.push(libData);
                }
            }
            if (targetLibs.length === 0) {
                logger.info(`[EmbySync] ${server.name}: keine Movie-Libraries gefunden`);
                continue;
            }

            for (const lib of targetLibs) {
                let items;
                try {
                    items = await client.getItems({
                        parentId: lib.id,
                        includeItemTypes: ['Movie'],
                        recursive: true,
                        fields: ['ProviderIds', 'ProductionYear', 'DateCreated'],
                        sortBy: ['DateCreated'],
                        sortOrder: 'Descending',
                        limit: movieLimitPerRun,
                    });
                } catch (err) {
                    logger.warn(
                        `[EmbySync] ${server.name}/${lib.name}: getItems fehlgeschlagen: ${err.message}`
                    );
                    continue;
                }
                const list = (items && items.Items) || [];
                for (const item of list) {
                    if (!item.Name || !item.ProductionYear) continue;
                    const key = canonicalKey(item.Name, item.ProductionYear);
                    const record = {
                        canonicalKey: key,
                        title: item.Name,
                        year: item.ProductionYear,
                        imdbId: item.ProviderIds?.Imdb || null,
                        tmdbId: item.ProviderIds?.Tmdb
                            ? String(item.ProviderIds.Tmdb)
                            : null,
                        dateCreated: item.DateCreated || null,
                        sourceServers: [server.name],
                    };
                    const existing = byKey.get(key);
                    if (!existing) {
                        byKey.set(key, record);
                        continue;
                    }
                    // Merge
                    existing.sourceServers = [
                        ...new Set([...existing.sourceServers, server.name]),
                    ];
                    existing.imdbId = existing.imdbId || record.imdbId;
                    existing.tmdbId = existing.tmdbId || record.tmdbId;
                    if (
                        record.dateCreated &&
                        (!existing.dateCreated || record.dateCreated < existing.dateCreated)
                    ) {
                        existing.dateCreated = record.dateCreated;
                    }
                }
            }
        } catch (err) {
            logger.error(
                `[EmbySync] Fehler beim Abrufen von ${server.name}: ${err.message}`
            );
        }
    }
    return Array.from(byKey.values());
}

/**
 * Prüft, ob ein Movie durch eine der Ignore-Regeln abgedeckt ist.
 * Regel-OR-Match: jede passende Regel triggert Ignore.
 */
function isIgnored(movie, rules) {
    if (!Array.isArray(rules) || rules.length === 0) return false;
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        if (rule.imdbId && movie.imdbId && rule.imdbId === movie.imdbId) return true;
        if (
            rule.tmdbId &&
            movie.tmdbId &&
            String(rule.tmdbId) === String(movie.tmdbId)
        )
            return true;
        if (rule.title && rule.year) {
            const ruleKey = canonicalKey(rule.title, rule.year);
            if (ruleKey === movie.canonicalKey) return true;
        }
    }
    return false;
}

/**
 * Aktualisiert die Auto-Playlist in cinema-playlists.json. Setzt sie beim
 * ersten Aktivieren als activePlaylistId (idempotent durch initiallyActivated).
 */
async function updateAutoPlaylist(
    allMovies,
    zipMtimes,
    autoPlaylistConfig,
    { logger, wsHub }
) {
    if (!autoPlaylistConfig || autoPlaylistConfig.enabled === false) {
        return { changed: false, skipped: 'disabled' };
    }
    const id = autoPlaylistConfig.id || 'auto_recent_20';
    const limit = Math.max(1, autoPlaylistConfig.limit || 20);
    const name = autoPlaylistConfig.name || 'Die letzten 20 hinzugefügten Filme';

    // Kandidaten: Filme mit vorhandenem ZIP, nach ZIP-mtime desc
    // (= Datum des PosterPack-Downloads, nicht Emby-DateCreated). Damit
    // ein Film, der lokal frisch erstellt wurde, oben erscheint — selbst
    // wenn er auf dem Emby-Server schon vor Jahren hinzugefügt wurde.
    const candidates = allMovies
        .filter(m => zipMtimes.has(m.canonicalKey))
        .sort((a, b) => (zipMtimes.get(b.canonicalKey) || 0) - (zipMtimes.get(a.canonicalKey) || 0))
        .slice(0, limit)
        .map(m => m.canonicalKey);

    // Playlist-Collection lesen
    let collection;
    try {
        const raw = await fsp.readFile(PLAYLISTS_PATH, 'utf8');
        collection = JSON.parse(raw);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        collection = { activePlaylistId: 'standard', playlists: {} };
    }
    collection.playlists = collection.playlists || {};
    const existing = collection.playlists[id] || null;
    const now = new Date().toISOString();

    const titlesChanged =
        !existing || JSON.stringify(existing.titles || []) !== JSON.stringify(candidates);

    let activationChanged = false;

    // AutoActivate beim ersten Mal (idempotent via initiallyActivated)
    if (
        autoPlaylistConfig.autoActivate === true &&
        existing?.initiallyActivated !== true
    ) {
        collection.activePlaylistId = id;
        activationChanged = true;
    }

    if (!titlesChanged && !activationChanged) {
        return { changed: false, titleCount: candidates.length };
    }

    collection.playlists[id] = {
        name,
        titles: candidates,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        auto: true,
        autoType: 'recent',
        autoConfig: { limit, source: 'emby-dateCreated' },
        initiallyActivated: activationChanged || existing?.initiallyActivated === true,
    };

    await fsp.writeFile(
        PLAYLISTS_PATH,
        JSON.stringify(collection, null, 2) + '\n',
        'utf8'
    );

    // Live-Playlist syncen wenn diese Playlist aktiv ist
    if (collection.activePlaylistId === id) {
        try {
            let live;
            try {
                live = JSON.parse(await fsp.readFile(LIVE_PLAYLIST_PATH, 'utf8'));
            } catch {
                live = { enabled: true, titles: [] };
            }
            live.titles = candidates;
            await fsp.writeFile(
                LIVE_PLAYLIST_PATH,
                JSON.stringify(live, null, 2) + '\n',
                'utf8'
            );
        } catch (err) {
            logger.warn(
                `[EmbySync] Live-Playlist konnte nicht aktualisiert werden: ${err.message}`
            );
        }
    }

    // Broadcast
    try {
        if (wsHub && typeof wsHub.broadcast === 'function') {
            wsHub.broadcast({ kind: 'command', type: 'playlist.refresh' });
        }
    } catch (err) {
        logger.warn(`[EmbySync] Broadcast fehlgeschlagen: ${err.message}`);
    }

    logger.info(
        `[EmbySync] Auto-Playlist "${id}" aktualisiert (${candidates.length} Filme, activated=${activationChanged})`
    );
    return { changed: true, titleCount: candidates.length, activated: activationChanged };
}

async function persistReport(report) {
    try {
        await fsp.mkdir(path.dirname(REPORT_PATH), { recursive: true });
        const tmp = REPORT_PATH + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(report, null, 2) + '\n', 'utf8');
        await fsp.rename(tmp, REPORT_PATH);
    } catch {
        /* best effort */
    }
}

async function readLastReport() {
    try {
        const raw = await fsp.readFile(REPORT_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * Haupt-Sync-Zyklus. Gibt einen Report zurück. Wirft { code: 'ALREADY_RUNNING' }
 * wenn bereits ein Sync läuft.
 */
async function runSyncCycle({ logger, config, wsHub, trigger = 'manual' } = {}) {
    if (state.inProgress) {
        const err = new Error('ALREADY_RUNNING');
        err.code = 'ALREADY_RUNNING';
        throw err;
    }
    state.inProgress = true;
    const startedAt = new Date().toISOString();
    const report = {
        startedAt,
        trigger,
        servers: {},
        added: [],
        skipped: [],
        ignored: [],
        errors: [],
        downloads: { posterPackSpawned: false, trailerSpawned: false },
    };

    try {
        const embySyncCfg = (config && config.embySync) || {};
        const movieLimitPerRun = embySyncCfg.movieLimitPerRun || 500;

        // Jellyfin-Server identifizieren, DarkStar zuerst
        const jellyfinServers = (config.mediaServers || []).filter(
            s => s.type === 'jellyfin' && s.enabled
        );
        const orderedServers = [...jellyfinServers].sort((a, b) => {
            const aIsDark = /darkstar/i.test(a.name);
            const bIsDark = /darkstar/i.test(b.name);
            if (aIsDark && !bIsDark) return -1;
            if (!aIsDark && bIsDark) return 1;
            return 0;
        });

        // Online-Check
        const onlineServers = [];
        for (const s of orderedServers) {
            const online = await pingJellyfin(s, { timeoutMs: 2000 });
            report.servers[s.name] = online ? 'online' : 'offline';
            if (online) onlineServers.push(s);
        }

        if (onlineServers.length === 0) {
            logger.info('[EmbySync] Keiner der Emby-Server online — Sync übersprungen');
            report.finishedAt = new Date().toISOString();
            report.result = 'all-offline';
            state.lastRun = report.finishedAt;
            await persistReport(report);
            return report;
        }

        // Movies sammeln + dedup
        const allMovies = await collectEmbyMovies(onlineServers, {
            movieLimitPerRun,
            logger,
        });
        report.totalMovies = allMovies.length;

        // Existierende ZIPs aufbauen (alle 5 Unterordner) — Map<key, mtimeMs>.
        // Das Set für Diff-Lookup haben wir gratis (Map.has() funktioniert wie Set.has()).
        const zipMtimes = await runner.getAllZipMtimes();
        const existingZipKeys = zipMtimes; // Alias — Map.has() ist API-kompatibel
        report.existingZips = zipMtimes.size;

        // Ignore-Regeln
        const ignoreRules = Array.isArray(embySyncCfg.ignoredMovies)
            ? embySyncCfg.ignoredMovies
            : [];

        // Diff
        const toDownload = [];
        for (const m of allMovies) {
            if (existingZipKeys.has(m.canonicalKey)) {
                report.skipped.push({ key: m.canonicalKey, reason: 'has-zip' });
                continue;
            }
            if (isIgnored(m, ignoreRules)) {
                report.ignored.push({
                    key: m.canonicalKey,
                    imdbId: m.imdbId,
                    tmdbId: m.tmdbId,
                });
                continue;
            }
            toDownload.push(m);
            report.added.push({
                key: m.canonicalKey,
                imdbId: m.imdbId,
                tmdbId: m.tmdbId,
                dateCreated: m.dateCreated,
                servers: m.sourceServers,
            });
        }

        // Downloads anstoßen
        if (toDownload.length > 0) {
            if (embySyncCfg.downloads?.posterPack !== false) {
                try {
                    // TMDB-ID-Hint anhängen wenn bekannt, damit der Python-
                    // Downloader die (fehleranfällige) Title+Year-Suche überspringen
                    // und direkt die korrekte ID nutzen kann.
                    const filmEntries = toDownload.map(m =>
                        m.tmdbId ? `${m.canonicalKey}[tmdb:${m.tmdbId}]` : m.canonicalKey
                    );
                    await runner.appendFilms(filmEntries);
                    if (!runner.isPosterRunning()) {
                        const spawn = runner.spawnPosterPackJob();
                        report.downloads.posterPackSpawned = !!spawn.started;
                        if (!spawn.started) {
                            report.errors.push({
                                where: 'spawnPosterPackJob',
                                ...spawn,
                            });
                        }
                    } else {
                        logger.info(
                            '[EmbySync] PosterPack-Job läuft bereits — Filme angehängt, kein 2. Spawn'
                        );
                    }
                } catch (err) {
                    report.errors.push({ where: 'appendFilms', message: err.message });
                }
            }
            if (embySyncCfg.downloads?.trailer !== false) {
                if (!runner.isTrailerRunning()) {
                    const spawn = runner.spawnTrailerJob();
                    report.downloads.trailerSpawned = !!spawn.started;
                    if (!spawn.started) {
                        report.errors.push({ where: 'spawnTrailerJob', ...spawn });
                    }
                } else {
                    logger.info(
                        '[EmbySync] Trailer-Job läuft bereits — wird im nächsten Zyklus erneut geprüft'
                    );
                }
            }
        }

        // Auto-Playlist
        if (embySyncCfg.autoPlaylist?.enabled !== false) {
            try {
                const apResult = await updateAutoPlaylist(
                    allMovies,
                    zipMtimes,
                    embySyncCfg.autoPlaylist || {},
                    { logger, wsHub }
                );
                report.autoPlaylist = apResult;
            } catch (err) {
                report.errors.push({
                    where: 'updateAutoPlaylist',
                    message: err.message,
                });
            }
        }

        // Race-Condition-Fix: Wenn Python-Jobs gespawnt wurden, sind die neu
        // heruntergeladenen ZIPs zum Sync-Zeitpunkt noch nicht da → Auto-Playlist
        // hat sie ausgefiltert (z.B. neuer Film aus Emby, ZIP wird gerade gezogen).
        // Wir warten bis die Jobs fertig sind und aktualisieren die Auto-Playlist
        // dann mit dem frischen ZIP-Set.
        if (
            (report.downloads.posterPackSpawned || report.downloads.trailerSpawned) &&
            embySyncCfg.autoPlaylist?.enabled !== false
        ) {
            schedulePostJobAutoPlaylistRefresh({
                runner,
                allMovies,
                autoPlaylistConfig: embySyncCfg.autoPlaylist || {},
                logger,
                wsHub,
            });
        }

        report.finishedAt = new Date().toISOString();
        state.lastRun = report.finishedAt;
        await persistReport(report);
        return report;
    } finally {
        state.inProgress = false;
    }
}

/**
 * Pollt die runner-States bis die Python-Jobs fertig sind und ruft dann
 * updateAutoPlaylist mit dem frischen ZIP-Set erneut auf. Schützt vor der
 * Race-Condition, dass beim Sync-Cycle das ZIP für ein neu hinzugefügtes
 * Movie noch nicht heruntergeladen war.
 */
function schedulePostJobAutoPlaylistRefresh({
    runner,
    allMovies,
    autoPlaylistConfig,
    logger,
    wsHub,
}) {
    const POLL_MS = 30_000;
    const MAX_WAIT_MS = 30 * 60_000;
    let elapsed = 0;
    const poll = async () => {
        try {
            if (!runner.isPosterRunning() && !runner.isTrailerRunning()) {
                // 5 s Buffer damit FS-Writes konsistent sind
                setTimeout(async () => {
                    try {
                        const freshZipMtimes = await runner.getAllZipMtimes();
                        await updateAutoPlaylist(
                            allMovies,
                            freshZipMtimes,
                            autoPlaylistConfig,
                            { logger, wsHub }
                        );
                        logger.info(
                            '[EmbySync] Auto-Playlist nach Job-Ende erneut aktualisiert (post-download)'
                        );
                    } catch (err) {
                        logger.warn(
                            '[EmbySync] Post-Job Auto-Playlist refresh failed: ' + err.message
                        );
                    }
                }, 5_000);
                return;
            }
            elapsed += POLL_MS;
            if (elapsed >= MAX_WAIT_MS) {
                logger.warn(
                    '[EmbySync] Post-Job Auto-Playlist refresh abgebrochen (Jobs > 30 min aktiv)'
                );
                return;
            }
            setTimeout(poll, POLL_MS);
        } catch (err) {
            logger.warn('[EmbySync] Post-Job Auto-Playlist poll error: ' + err.message);
        }
    };
    setTimeout(poll, POLL_MS);
}

function scheduleEmbySync({ logger, config, wsHub }) {
    const cfg = (config && config.embySync) || {};
    if (cfg.enabled === false) {
        logger.info('[EmbySync] Scheduler deaktiviert (config.embySync.enabled === false)');
        return;
    }
    // clear vorherige Timer (z. B. bei Re-Init)
    if (state.scheduledTimer) {
        clearInterval(state.scheduledTimer);
        state.scheduledTimer = null;
    }
    if (state.scheduledInitialTimeout) {
        clearTimeout(state.scheduledInitialTimeout);
        state.scheduledInitialTimeout = null;
    }

    const initialDelayMs = (cfg.initialDelaySeconds ?? 60) * 1000;
    const intervalMinutes = Math.max(1, cfg.intervalMinutes ?? 360);
    const intervalMs = intervalMinutes * 60 * 1000;

    const tick = trigger => {
        if (state.inProgress) {
            logger.info('[EmbySync] Tick übersprungen — Sync läuft bereits');
            return;
        }
        state.nextRun = new Date(Date.now() + intervalMs).toISOString();
        runSyncCycle({ logger, config, wsHub, trigger }).catch(err => {
            if (err && err.code !== 'ALREADY_RUNNING') {
                logger.error(`[EmbySync] Tick fehlgeschlagen: ${err.message}`);
            }
        });
    };

    state.scheduledInitialTimeout = setTimeout(
        () => tick('scheduled-initial'),
        initialDelayMs
    );
    state.scheduledTimer = setInterval(() => tick('scheduled'), intervalMs);
    state.nextRun = new Date(Date.now() + initialDelayMs).toISOString();

    logger.info(
        `[EmbySync] Scheduler aktiv (interval: ${intervalMinutes}min, initial: ${cfg.initialDelaySeconds ?? 60}s)`
    );
}

function getStatus(config) {
    const cfg = (config && config.embySync) || {};
    return {
        scheduled: !!state.scheduledTimer,
        enabled: cfg.enabled !== false,
        intervalMinutes: cfg.intervalMinutes ?? 360,
        lastRun: state.lastRun,
        nextRun: state.nextRun,
        running: state.inProgress,
        autoPlaylistId: cfg.autoPlaylist?.id || 'auto_recent_20',
    };
}

function __reset() {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('__reset only available in NODE_ENV=test');
    }
    if (state.scheduledTimer) clearInterval(state.scheduledTimer);
    if (state.scheduledInitialTimeout) clearTimeout(state.scheduledInitialTimeout);
    state = {
        inProgress: false,
        lastRun: null,
        nextRun: null,
        scheduledTimer: null,
        scheduledInitialTimeout: null,
    };
}

module.exports = {
    runSyncCycle,
    scheduleEmbySync,
    collectEmbyMovies,
    updateAutoPlaylist,
    pingJellyfin,
    canonicalKey,
    isIgnored,
    getStatus,
    readLastReport,
    __reset,
};
