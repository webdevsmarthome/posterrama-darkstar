'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const runner = require('../lib/poster-updater-runner');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'media', 'complete', 'tmdb-export');
// Alle möglichen ZIP-Quellen (für DELETE: ZIP wird in JEDER Quelle gesucht)
const ZIP_SOURCES = [
    path.join(PROJECT_ROOT, 'media', 'complete', 'manual'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'plex-export'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'jellyfin-emby-export'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'tmdb-export'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'romm-export'),
];
const TRAILER_DIR = path.join(PROJECT_ROOT, 'media', 'trailers');
const TRAILER_INFO_PATH = path.join(TRAILER_DIR, 'trailer-info.json');

module.exports = function createPosterUpdaterRouter({ logger }) {
    const router = express.Router();

    // Logger an den shared Runner durchreichen, damit emby-sync dieselben Logs bekommt
    runner.setLogger(logger);

    // --- Trailer-Info-Helfer (nur hier benötigt, bleiben lokal) ---
    function trailerFileExists(name) {
        const trailerPath = path.join(TRAILER_DIR, `${name}-trailer.mp4`);
        if (fs.existsSync(trailerPath)) return true;
        // NFD/NFC fallback
        try {
            const nameNFC = `${name}-trailer.mp4`.normalize('NFC');
            return fs.readdirSync(TRAILER_DIR).some(e => e.normalize('NFC') === nameNFC);
        } catch {
            return false;
        }
    }

    function readTrailerInfo() {
        try {
            return JSON.parse(fs.readFileSync(TRAILER_INFO_PATH, 'utf8'));
        } catch {
            return {};
        }
    }

    function trailerInfoLookup(info, name) {
        if (info[name]) return info[name];
        const nameNFC = name.normalize('NFC');
        for (const [k, v] of Object.entries(info)) {
            if (k.normalize('NFC') === nameNFC) return v;
        }
        return null;
    }

    // ============================================================
    // GET /films — list all films with ZIP and trailer status
    // ============================================================
    router.get('/films', async (req, res) => {
        try {
            const [films, zips] = await Promise.all([
                runner.readFilmList(),
                runner.getExistingZips(),
            ]);
            const trailerInfo = readTrailerInfo();
            const result = films.map(raw => {
                // Strip optional "[tmdb:N]"-Hint für UI-Anzeige und Datei-Vergleiche
                const name = runner.stripTmdbHint(raw);
                const hasTrailer = trailerFileExists(name);
                return {
                    name,
                    hasZip: zips.has(name),
                    hasTrailer,
                    trailerType: hasTrailer
                        ? trailerInfoLookup(trailerInfo, name) || 'unbekannt'
                        : null,
                };
            });
            const withZip = result.filter(f => f.hasZip).length;
            const withTrailer = result.filter(f => f.hasTrailer).length;
            res.json({
                films: result,
                total: result.length,
                withZip,
                pending: result.length - withZip,
                withTrailer,
            });
        } catch (err) {
            logger.error('poster-updater: Failed to read film list:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // POST /films — add a film entry
    // ============================================================
    router.post('/films', express.json(), async (req, res) => {
        const { title, year } = req.body || {};
        if (!title || !year) {
            return res.status(400).json({ success: false, error: 'title and year required' });
        }
        const yearStr = String(year).trim();
        if (!/^\d{4}$/.test(yearStr)) {
            return res.status(400).json({ success: false, error: 'year must be 4 digits' });
        }
        const entry = `${title.trim()} (${yearStr})`;

        try {
            const result = await runner.appendFilms([entry]);
            if (result.added.length === 0) {
                return res.status(409).json({ success: false, error: 'Already exists', entry });
            }
            res.json({ success: true, entry: result.added[0] });
        } catch (err) {
            logger.error('poster-updater: Failed to add film:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // DELETE /films/:name — remove a film entry
    // ============================================================
    router.delete('/films/:name', async (req, res) => {
        const name = decodeURIComponent(req.params.name);
        try {
            const result = await runner.withFileLock(async () => {
                const films = await runner.readFilmList();
                // Matching auf Title-Year-Basis (Hint wird ignoriert), damit auch
                // "Film (Jahr)[tmdb:N]"-Einträge per DELETE /films/:name gefunden werden.
                const normalizedTarget = runner.stripTmdbHint(name).normalize('NFC');
                const idx = films.findIndex(
                    f => runner.stripTmdbHint(f).normalize('NFC') === normalizedTarget
                );
                if (idx === -1) return { success: false };
                films.splice(idx, 1);
                await runner.writeFilmList(films);
                return { success: true };
            });
            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Entry not found' });
            }
            // Also delete the corresponding ZIP file in ALL 5 source-dirs
            // (manual, plex-export, jellyfin-emby-export, tmdb-export, romm-export)
            // — Filme können in mehreren Quellen liegen oder ihre Quelle wechseln.
            // Sidecars (z.B. ${name}.poster.json) werden mitgelöscht.
            const sidecarSuffixes = ['.zip', '.poster.json'];
            for (const sourceDir of ZIP_SOURCES) {
                for (const suffix of sidecarSuffixes) {
                    const filePath = path.join(sourceDir, name + suffix);
                    try {
                        await fsp.unlink(filePath);
                        const sourceName = path.basename(sourceDir);
                        logger.info(`poster-updater: Deleted ${name}${suffix} from ${sourceName}/`);
                    } catch (err) {
                        if (err.code !== 'ENOENT') {
                            logger.warn(
                                `poster-updater: Failed to delete ${filePath}: ${err.message}`
                            );
                        }
                    }
                }
            }
            // Also delete the corresponding trailer if it exists
            try {
                const nameNormalized = name.normalize('NFC');
                const trailerPath = path.join(TRAILER_DIR, nameNormalized + '-trailer.mp4');
                await fsp.unlink(trailerPath);
                logger.info(
                    `poster-updater: Deleted trailer: ${nameNormalized}-trailer.mp4`
                );
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    logger.warn(
                        `poster-updater: Failed to delete trailer: ${err.message}`
                    );
                }
            }
            // Remove trailer-info.json entry
            try {
                const infoRaw = await fsp.readFile(TRAILER_INFO_PATH, 'utf8');
                const info = JSON.parse(infoRaw);
                const nameNormalized = name.normalize('NFC');
                if (info[nameNormalized]) {
                    delete info[nameNormalized];
                    await fsp.writeFile(
                        TRAILER_INFO_PATH,
                        JSON.stringify(info, null, 2) + '\n',
                        'utf8'
                    );
                    logger.info(
                        `poster-updater: Removed trailer-info entry: ${nameNormalized}`
                    );
                }
            } catch (err) {
                logger.warn(`poster-updater: Failed to update trailer-info.json: ${err.message}`);
            }
            // Remove from all playlists (cinema-playlists.json + live cinema-playlist.json)
            try {
                const playlistsPath = path.join(PROJECT_ROOT, 'public', 'cinema-playlists.json');
                const livePath = path.join(PROJECT_ROOT, 'public', 'cinema-playlist.json');
                const raw = await fsp.readFile(playlistsPath, 'utf8');
                const collection = JSON.parse(raw);
                const nameNFC = name.normalize('NFC');
                let changed = false;
                for (const pl of Object.values(collection.playlists || {})) {
                    const before = pl.titles.length;
                    pl.titles = pl.titles.filter(t => t.normalize('NFC') !== nameNFC);
                    if (pl.titles.length < before) changed = true;
                }
                if (changed) {
                    await fsp.writeFile(
                        playlistsPath,
                        JSON.stringify(collection, null, 2) + '\n',
                        'utf8'
                    );
                    // Also update live playlist if active playlist was affected
                    const activeId = collection.activePlaylistId;
                    if (activeId && collection.playlists[activeId]) {
                        try {
                            const liveRaw = await fsp.readFile(livePath, 'utf8');
                            const live = JSON.parse(liveRaw);
                            live.titles = collection.playlists[activeId].titles;
                            await fsp.writeFile(
                                livePath,
                                JSON.stringify(live, null, 2) + '\n',
                                'utf8'
                            );
                        } catch (_) {
                            /* best effort */
                        }
                    }
                    logger.info(`poster-updater: Removed "${name}" from playlists`);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    logger.warn(`poster-updater: Failed to clean playlists: ${err.message}`);
                }
            }
            res.json({ success: true });
        } catch (err) {
            logger.error('poster-updater: Failed to delete film:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // POST /run — start the Python script (PosterPack download)
    // ============================================================
    router.post('/run', (req, res) => {
        const result = runner.spawnPosterPackJob();
        if (!result.started) {
            if (result.reason === 'already-running') {
                return res
                    .status(409)
                    .json({ success: false, error: 'Script is already running' });
            }
            return res
                .status(500)
                .json({ success: false, error: result.error || 'spawn failed' });
        }
        res.json({ success: true, message: 'Script started', pid: result.pid });
    });

    // ============================================================
    // GET /run/status — SSE stream for live script output
    // ============================================================
    router.get('/run/status', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(
            `data: ${JSON.stringify({ type: 'connected', running: runner.isPosterRunning() })}\n\n`
        );
        runner.subscribePoster(res);
        const hb = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            } catch {
                clearInterval(hb);
            }
        }, 30000);
        req.on('close', () => {
            clearInterval(hb);
            runner.unsubscribePoster(res);
        });
    });

    // ============================================================
    // POST /run/stop — kill running script
    // ============================================================
    router.post('/run/stop', (req, res) => {
        const result = runner.stopPosterPackJob();
        if (!result.stopped) {
            return res.status(409).json({ success: false, error: 'No script is running' });
        }
        res.json({ success: true, message: 'Stop signal sent' });
    });

    // ============================================================
    // TRAILER DOWNLOAD
    // ============================================================
    router.post('/trailers/run', (req, res) => {
        const result = runner.spawnTrailerJob();
        if (!result.started) {
            if (result.reason === 'already-running') {
                return res
                    .status(409)
                    .json({ success: false, error: 'Trailer-Download läuft bereits' });
            }
            return res
                .status(500)
                .json({ success: false, error: result.error || 'spawn failed' });
        }
        res.json({ success: true, message: 'Trailer download started', pid: result.pid });
    });

    router.get('/trailers/run/status', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(
            `data: ${JSON.stringify({ type: 'connected', running: runner.isTrailerRunning() })}\n\n`
        );
        runner.subscribeTrailer(res);
        const hb = setInterval(() => {
            try {
                res.write(': heartbeat\n\n');
            } catch {
                clearInterval(hb);
            }
        }, 30000);
        req.on('close', () => {
            clearInterval(hb);
            runner.unsubscribeTrailer(res);
        });
    });

    router.post('/trailers/run/stop', (req, res) => {
        const result = runner.stopTrailerJob();
        if (!result.stopped) {
            return res
                .status(409)
                .json({ success: false, error: 'Kein Trailer-Download läuft' });
        }
        res.json({ success: true, message: 'Stop signal sent' });
    });

    // --- Log-Downloads (für Buttons im Admin-UI) ---
    router.get('/run/log', (req, res) => {
        const log = runner.getPosterLog();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="posterpack-log-${ts}.txt"`);
        res.send(log || '(noch kein PosterPack-Job gelaufen)\n');
    });

    router.get('/trailers/run/log', (req, res) => {
        const log = runner.getTrailerLog();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="trailer-log-${ts}.txt"`);
        res.send(log || '(noch kein Trailer-Job gelaufen)\n');
    });

    // Liste aller verfügbaren PosterPacks (alle 5 Quellen) als TXT
    router.get('/posterpacks/list', async (req, res) => {
        try {
            const zipKeys = await runner.getAllExistingZips();
            const sorted = Array.from(zipKeys).sort((a, b) => a.localeCompare(b, 'de'));
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const body =
                `# Verfügbare PosterPacks (${sorted.length} Stück)\n` +
                `# Stand: ${new Date().toISOString()}\n\n` +
                sorted.join('\n') +
                '\n';
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="posterpacks-${ts}.txt"`);
            res.send(body);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
