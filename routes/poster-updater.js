'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

const FILMLISTE_PATH = path.join(__dirname, '..', 'poster-updater', 'filmliste.txt');
const SCRIPT_PATH = path.join(__dirname, '..', 'poster-updater', 'tmdb-get-posters-direct.py');
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const OUTPUT_DIR = path.join(__dirname, '..', 'media', 'complete', 'tmdb-export');

module.exports = function createPosterUpdaterRouter({ logger }) {
    const router = express.Router();

    // --- Module-level state ---
    let runningProcess = null;
    let sseClients = [];
    let writeLock = Promise.resolve();

    function withFileLock(fn) {
        writeLock = writeLock.then(fn, fn);
        return writeLock;
    }

    function broadcast(data) {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        sseClients = sseClients.filter(res => {
            try { res.write(msg); return true; }
            catch { return false; }
        });
    }

    // --- Helper: read filmliste ---
    async function readFilmList() {
        try {
            const content = await fsp.readFile(FILMLISTE_PATH, 'utf8');
            return content.split('\n').map(l => l.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
        } catch (err) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }
    }

    // --- Helper: write filmliste ---
    async function writeFilmList(films) {
        const sorted = [...films].sort((a, b) => a.localeCompare(b, 'de'));
        await fsp.writeFile(FILMLISTE_PATH, sorted.join('\n') + '\n', 'utf8');
        return sorted;
    }

    // --- Helper: get set of existing ZIP names (without .zip extension) ---
    async function getExistingZips() {
        try {
            const entries = await fsp.readdir(OUTPUT_DIR);
            const zips = new Set();
            for (const e of entries) {
                if (e.toLowerCase().endsWith('.zip')) {
                    zips.add(e.replace(/\.zip$/i, ''));
                }
            }
            return zips;
        } catch (err) {
            if (err.code === 'ENOENT') return new Set();
            throw err;
        }
    }

    // ============================================================
    // GET /films — list all films with ZIP status
    // ============================================================
    router.get('/films', async (req, res) => {
        try {
            const [films, zips] = await Promise.all([readFilmList(), getExistingZips()]);
            const result = films.map(name => ({ name, hasZip: zips.has(name) }));
            const withZip = result.filter(f => f.hasZip).length;
            res.json({
                films: result,
                total: result.length,
                withZip,
                pending: result.length - withZip,
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
            const result = await withFileLock(async () => {
                const films = await readFilmList();
                const exists = films.some(f => f.toLowerCase() === entry.toLowerCase());
                if (exists) {
                    return { success: false, error: 'Already exists', entry };
                }
                films.push(entry);
                await writeFilmList(films);
                return { success: true, entry };
            });
            if (!result.success) {
                return res.status(409).json(result);
            }
            res.json(result);
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
            const result = await withFileLock(async () => {
                const films = await readFilmList();
                const idx = films.findIndex(f => f === name);
                if (idx === -1) return { success: false };
                films.splice(idx, 1);
                await writeFilmList(films);
                return { success: true };
            });
            if (!result.success) {
                return res.status(404).json({ success: false, error: 'Entry not found' });
            }
            // Also delete the corresponding ZIP file if it exists
            try {
                const zipPath = path.join(OUTPUT_DIR, name + '.zip');
                await fsp.unlink(zipPath);
                logger.info(`poster-updater: Deleted ZIP file: ${name}.zip`);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    logger.warn(`poster-updater: Failed to delete ZIP file: ${err.message}`);
                }
            }
            // Also delete the corresponding trailer if it exists
            try {
                const trailerPath = path.join(__dirname, '..', 'media', 'trailers', name + '-trailer.mp4');
                await fsp.unlink(trailerPath);
                logger.info(`poster-updater: Deleted trailer: ${name}-trailer.mp4`);
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    logger.warn(`poster-updater: Failed to delete trailer: ${err.message}`);
                }
            }
            res.json({ success: true });
        } catch (err) {
            logger.error('poster-updater: Failed to delete film:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // POST /run — start the Python script
    // ============================================================
    router.post('/run', (req, res) => {
        if (runningProcess) {
            return res.status(409).json({ success: false, error: 'Script is already running' });
        }

        try {
            // Build a clean env: remove TMDB_API_KEY from posterrama's process.env
            // so that the Python script's load_dotenv() picks up the correct key
            // from poster-updater/.env (load_dotenv does NOT override existing vars).
            const scriptEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
            delete scriptEnv.TMDB_API_KEY;

            const proc = spawn('python3', [SCRIPT_PATH, '--yes'], {
                cwd: SCRIPT_DIR,
                env: scriptEnv,
            });
            runningProcess = proc;
            logger.info('poster-updater: Script started, pid=' + proc.pid);
            broadcast({ type: 'started', pid: proc.pid });

            proc.stdout.on('data', chunk => {
                const text = chunk.toString('utf8');
                broadcast({ type: 'stdout', text });
            });

            proc.stderr.on('data', chunk => {
                const text = chunk.toString('utf8');
                broadcast({ type: 'stderr', text });
            });

            proc.on('close', code => {
                logger.info('poster-updater: Script finished, code=' + code);
                broadcast({ type: 'done', code });
                runningProcess = null;
            });

            proc.on('error', err => {
                logger.error('poster-updater: Script spawn error:', err.message);
                broadcast({ type: 'error', message: err.message });
                runningProcess = null;
            });

            res.json({ success: true, message: 'Script started', pid: proc.pid });
        } catch (err) {
            logger.error('poster-updater: Failed to start script:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // GET /run/status — SSE stream for live script output
    // ============================================================
    router.get('/run/status', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // Send initial state
        res.write(`data: ${JSON.stringify({ type: 'connected', running: !!runningProcess })}\n\n`);
        sseClients.push(res);

        // Heartbeat every 30s
        const hb = setInterval(() => {
            try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
        }, 30000);

        req.on('close', () => {
            clearInterval(hb);
            sseClients = sseClients.filter(c => c !== res);
        });
    });

    // ============================================================
    // POST /run/stop — kill running script
    // ============================================================
    router.post('/run/stop', (req, res) => {
        if (!runningProcess) {
            return res.status(409).json({ success: false, error: 'No script is running' });
        }
        try {
            runningProcess.kill('SIGTERM');
            // Force kill after 5s if still alive
            const pid = runningProcess.pid;
            setTimeout(() => {
                if (runningProcess && runningProcess.pid === pid) {
                    try { runningProcess.kill('SIGKILL'); } catch { /* already dead */ }
                }
            }, 5000);
            res.json({ success: true, message: 'Stop signal sent' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // TRAILER DOWNLOAD — separate process + SSE
    // ============================================================
    const TRAILER_SCRIPT_PATH = path.join(__dirname, '..', 'poster-updater', 'download-trailers.py');
    let trailerProcess = null;
    let trailerSseClients = [];

    function trailerBroadcast(data) {
        const msg = `data: ${JSON.stringify(data)}\n\n`;
        trailerSseClients = trailerSseClients.filter(res => {
            try { res.write(msg); return true; }
            catch { return false; }
        });
    }

    router.post('/trailers/run', (req, res) => {
        if (trailerProcess) {
            return res.status(409).json({ success: false, error: 'Trailer-Download läuft bereits' });
        }
        try {
            const scriptEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
            delete scriptEnv.TMDB_API_KEY;
            const proc = spawn('python3', [TRAILER_SCRIPT_PATH], {
                cwd: SCRIPT_DIR,
                env: scriptEnv,
            });
            trailerProcess = proc;
            logger.info('poster-updater: Trailer download started, pid=' + proc.pid);
            trailerBroadcast({ type: 'started', pid: proc.pid });
            proc.stdout.on('data', chunk => trailerBroadcast({ type: 'stdout', text: chunk.toString('utf8') }));
            proc.stderr.on('data', chunk => trailerBroadcast({ type: 'stderr', text: chunk.toString('utf8') }));
            proc.on('close', code => {
                logger.info('poster-updater: Trailer download finished, code=' + code);
                trailerBroadcast({ type: 'done', code });
                trailerProcess = null;
            });
            proc.on('error', err => {
                logger.error('poster-updater: Trailer download error:', err.message);
                trailerBroadcast({ type: 'error', message: err.message });
                trailerProcess = null;
            });
            res.json({ success: true, message: 'Trailer download started', pid: proc.pid });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/trailers/run/status', (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', running: !!trailerProcess })}\n\n`);
        trailerSseClients.push(res);
        const hb = setInterval(() => {
            try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
        }, 30000);
        req.on('close', () => {
            clearInterval(hb);
            trailerSseClients = trailerSseClients.filter(c => c !== res);
        });
    });

    router.post('/trailers/run/stop', (req, res) => {
        if (!trailerProcess) {
            return res.status(409).json({ success: false, error: 'Kein Trailer-Download läuft' });
        }
        try {
            trailerProcess.kill('SIGTERM');
            const pid = trailerProcess.pid;
            setTimeout(() => {
                if (trailerProcess && trailerProcess.pid === pid) {
                    try { trailerProcess.kill('SIGKILL'); } catch { /* already dead */ }
                }
            }, 5000);
            res.json({ success: true, message: 'Stop signal sent' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
