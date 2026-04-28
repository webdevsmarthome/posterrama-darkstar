'use strict';

/**
 * poster-updater-runner
 *
 * Singleton-Modul für alle Poster-Updater-Operationen auf Prozess-/Filmliste-Ebene.
 *
 * Zweck: Der Poster-Updater-Code (routes/poster-updater.js) UND der Emby-Sync
 * (lib/emby-sync.js) müssen sich denselben laufenden Python-Prozess, denselben
 * File-Lock und dieselben SSE-Clients teilen. Zuvor waren diese als modul-scoped
 * `let` in poster-updater.js deklariert und damit von außen nicht zugänglich.
 *
 * Dieses Modul hält den Shared-State (singleton via Node's require-Cache).
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');

// --- Paths ---
const PROJECT_ROOT = path.join(__dirname, '..');
const FILMLISTE_PATH = path.join(PROJECT_ROOT, 'poster-updater', 'filmliste.txt');
const POSTER_SCRIPT = path.join(PROJECT_ROOT, 'poster-updater', 'tmdb-get-posters-direct.py');
const TRAILER_SCRIPT = path.join(PROJECT_ROOT, 'poster-updater', 'download-trailers.py');
const SCRIPT_DIR = path.dirname(POSTER_SCRIPT);
const TMDB_EXPORT_DIR = path.join(PROJECT_ROOT, 'media', 'complete', 'tmdb-export');
const ALL_EXPORT_DIRS = [
    path.join(PROJECT_ROOT, 'media', 'complete', 'manual'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'plex-export'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'jellyfin-emby-export'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'tmdb-export'),
    path.join(PROJECT_ROOT, 'media', 'complete', 'romm-export'),
];

// --- Singleton state ---
let logger = { info: () => {}, warn: () => {}, error: () => {} };
let posterProcess = null;
let trailerProcess = null;
let posterSseClients = [];
let trailerSseClients = [];
let writeLock = Promise.resolve();

// In-Memory-Log-Buffer für Download-Endpoint. Speichert Output (stdout+stderr)
// des laufenden bzw. zuletzt gelaufenen Jobs. Ringbuffer-artig auf MAX_LOG_BYTES
// gekürzt — verhindert unbegrenztes Wachsen bei sehr langen Läufen.
const MAX_LOG_BYTES = 5 * 1024 * 1024;
let posterLog = '';
let trailerLog = '';
function appendPosterLog(text) {
    posterLog += text;
    if (posterLog.length > MAX_LOG_BYTES) {
        posterLog = '... [truncated] ...\n' + posterLog.slice(-MAX_LOG_BYTES);
    }
}
function appendTrailerLog(text) {
    trailerLog += text;
    if (trailerLog.length > MAX_LOG_BYTES) {
        trailerLog = '... [truncated] ...\n' + trailerLog.slice(-MAX_LOG_BYTES);
    }
}

function setLogger(l) {
    if (l && typeof l.info === 'function') logger = l;
}

function withFileLock(fn) {
    writeLock = writeLock.then(fn, fn);
    return writeLock;
}

// --- SSE Broadcasting ---
function broadcastPoster(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    posterSseClients = posterSseClients.filter(res => {
        try {
            res.write(msg);
            return true;
        } catch {
            return false;
        }
    });
}

function broadcastTrailer(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    trailerSseClients = trailerSseClients.filter(res => {
        try {
            res.write(msg);
            return true;
        } catch {
            return false;
        }
    });
}

function subscribePoster(res) {
    posterSseClients.push(res);
}
function unsubscribePoster(res) {
    posterSseClients = posterSseClients.filter(c => c !== res);
}
function subscribeTrailer(res) {
    trailerSseClients.push(res);
}
function unsubscribeTrailer(res) {
    trailerSseClients = trailerSseClients.filter(c => c !== res);
}

// --- Filmliste CRUD ---
async function readFilmList() {
    try {
        const content = await fsp.readFile(FILMLISTE_PATH, 'utf8');
        return content
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'de'));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

async function writeFilmList(films) {
    const sorted = [...films].sort((a, b) => a.localeCompare(b, 'de'));
    await fsp.writeFile(FILMLISTE_PATH, sorted.join('\n') + '\n', 'utf8');
    return sorted;
}

/**
 * Entfernt einen optionalen "[tmdb:NNNN]"-Hint-Suffix aus einem Filmliste-
 * Eintrag. Der Suffix ist ein Extension (Patch 51), um dem Python-Downloader
 * die korrekte TMDB-ID direkt mitzugeben. Für Dedup/Match arbeiten wir auf der
 * Title-Year-Basis; der Suffix ist nur Zusatz-Information.
 */
function stripTmdbHint(entry) {
    if (!entry) return '';
    const m = String(entry).match(/^(.+?)\s*\[tmdb:\d+\]\s*$/);
    return (m ? m[1] : entry).trim();
}

function hasTmdbHint(entry) {
    return /\[tmdb:\d+\]\s*$/.test(String(entry || ''));
}

/**
 * Hängt neue Film-Einträge an die Liste an (NFC-normalisiert).
 *
 * Dedup-Logik:
 *  - Der Title-Year-Teil (ohne "[tmdb:N]"-Suffix) ist der Primärschlüssel.
 *  - Existiert der Schlüssel bereits OHNE Hint und der neue Eintrag HAT einen
 *    Hint → bestehender Eintrag wird "upgraded" (ersetzt durch gehinteten).
 *  - Existiert der Schlüssel MIT Hint und der neue OHNE → keep (mehr Info
 *    ist wertvoller).
 *  - Beide ohne oder gleicher Hint → duplicate.
 *  - Hints unterscheiden sich → Warn und behalte den bestehenden (extrem
 *    seltener Edge-Case).
 *
 * Atomar hinter writeLock.
 */
async function appendFilms(newFilms) {
    return withFileLock(async () => {
        const existing = await readFilmList();
        // Map von Title-Year-Key (lowercase NFC) → Index in existing
        const keyToIndex = new Map();
        existing.forEach((e, idx) => {
            keyToIndex.set(stripTmdbHint(e).normalize('NFC').toLowerCase(), idx);
        });

        const added = [];
        const upgraded = [];
        const duplicates = [];
        const resultList = [...existing];

        for (const raw of newFilms) {
            const nfc = String(raw).normalize('NFC').trim();
            if (!nfc) continue;
            const baseKey = stripTmdbHint(nfc).toLowerCase();

            const existingIdx = keyToIndex.get(baseKey);
            if (existingIdx === undefined) {
                resultList.push(nfc);
                keyToIndex.set(baseKey, resultList.length - 1);
                added.push(nfc);
                continue;
            }

            const existingEntry = resultList[existingIdx];
            const existingHasHint = hasTmdbHint(existingEntry);
            const newHasHint = hasTmdbHint(nfc);

            if (!existingHasHint && newHasHint) {
                // Upgrade
                resultList[existingIdx] = nfc;
                upgraded.push(nfc);
            } else {
                duplicates.push(nfc);
            }
        }

        if (added.length > 0 || upgraded.length > 0) {
            await writeFilmList(resultList);
        }
        return { added, upgraded, duplicates };
    });
}

// --- ZIP Existence Checks ---
/**
 * Basenames der ZIPs im tmdb-export Unterordner (Backwards-Compat zum
 * ursprünglichen poster-updater-Verhalten). Nicht NFC-normalisiert.
 */
async function getExistingZips() {
    try {
        const entries = await fsp.readdir(TMDB_EXPORT_DIR);
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

/**
 * Basenames ALLER ZIPs über alle 5 Export-Unterordner, NFC-normalisiert.
 * Wird vom Emby-Sync genutzt, um vorhandene PosterPacks egal welcher Quelle
 * (manual, plex, jellyfin, tmdb, romm) zu erkennen.
 */
async function getAllExistingZips() {
    const zips = new Set();
    for (const dir of ALL_EXPORT_DIRS) {
        try {
            const entries = await fsp.readdir(dir);
            for (const e of entries) {
                if (e.toLowerCase().endsWith('.zip')) {
                    zips.add(e.replace(/\.zip$/i, '').normalize('NFC'));
                }
            }
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }
    return zips;
}

// --- State Accessors ---
function isPosterRunning() {
    return posterProcess !== null;
}
function isTrailerRunning() {
    return trailerProcess !== null;
}

// --- Job Spawning ---
function spawnPosterPackJob() {
    if (posterProcess) {
        return { started: false, reason: 'already-running', pid: posterProcess.pid };
    }
    try {
        // Python-Script lädt TMDB_API_KEY aus poster-updater/.env via load_dotenv();
        // process.env-Variable aus dem Node-Prozess darf nicht überschreiben.
        const scriptEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
        delete scriptEnv.TMDB_API_KEY;

        const proc = spawn('python3', [POSTER_SCRIPT, '--yes'], {
            cwd: SCRIPT_DIR,
            env: scriptEnv,
        });
        posterProcess = proc;
        // Reset log-buffer für neuen Run
        posterLog = `=== PosterPack-Job gestartet ${new Date().toISOString()} (PID ${proc.pid}) ===\n`;
        logger.info('poster-updater: Script started, pid=' + proc.pid);
        broadcastPoster({ type: 'started', pid: proc.pid });

        proc.stdout.on('data', chunk => {
            const text = chunk.toString('utf8');
            appendPosterLog(text);
            broadcastPoster({ type: 'stdout', text });
        });
        proc.stderr.on('data', chunk => {
            const text = chunk.toString('utf8');
            appendPosterLog(text);
            broadcastPoster({ type: 'stderr', text });
        });
        proc.on('close', code => {
            appendPosterLog(`\n=== Job beendet ${new Date().toISOString()} (Exit-Code ${code}) ===\n`);
            logger.info('poster-updater: Script finished, code=' + code);
            broadcastPoster({ type: 'done', code });
            posterProcess = null;
        });
        proc.on('error', err => {
            appendPosterLog(`\n=== ERROR ${new Date().toISOString()}: ${err.message} ===\n`);
            logger.error('poster-updater: Script spawn error:', err.message);
            broadcastPoster({ type: 'error', message: err.message });
            posterProcess = null;
        });
        return { started: true, pid: proc.pid };
    } catch (err) {
        logger.error('poster-updater: Failed to start script:', err.message);
        return { started: false, reason: 'spawn-error', error: err.message };
    }
}

function spawnTrailerJob() {
    if (trailerProcess) {
        return { started: false, reason: 'already-running', pid: trailerProcess.pid };
    }
    try {
        const scriptEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
        delete scriptEnv.TMDB_API_KEY;
        const proc = spawn('python3', [TRAILER_SCRIPT], {
            cwd: SCRIPT_DIR,
            env: scriptEnv,
        });
        trailerProcess = proc;
        // Reset log-buffer für neuen Run
        trailerLog = `=== Trailer-Job gestartet ${new Date().toISOString()} (PID ${proc.pid}) ===\n`;
        logger.info('poster-updater: Trailer download started, pid=' + proc.pid);
        broadcastTrailer({ type: 'started', pid: proc.pid });

        proc.stdout.on('data', chunk => {
            const text = chunk.toString('utf8');
            appendTrailerLog(text);
            broadcastTrailer({ type: 'stdout', text });
        });
        proc.stderr.on('data', chunk => {
            const text = chunk.toString('utf8');
            appendTrailerLog(text);
            broadcastTrailer({ type: 'stderr', text });
        });
        proc.on('close', code => {
            appendTrailerLog(`\n=== Job beendet ${new Date().toISOString()} (Exit-Code ${code}) ===\n`);
            logger.info('poster-updater: Trailer download finished, code=' + code);
            broadcastTrailer({ type: 'done', code });
            trailerProcess = null;
        });
        proc.on('error', err => {
            appendTrailerLog(`\n=== ERROR ${new Date().toISOString()}: ${err.message} ===\n`);
            logger.error('poster-updater: Trailer download error:', err.message);
            broadcastTrailer({ type: 'error', message: err.message });
            trailerProcess = null;
        });
        return { started: true, pid: proc.pid };
    } catch (err) {
        logger.error('poster-updater: Failed to start trailer script:', err.message);
        return { started: false, reason: 'spawn-error', error: err.message };
    }
}

function stopPosterPackJob() {
    if (!posterProcess) return { stopped: false, reason: 'not-running' };
    try {
        posterProcess.kill('SIGTERM');
        const pid = posterProcess.pid;
        setTimeout(() => {
            if (posterProcess && posterProcess.pid === pid) {
                try {
                    posterProcess.kill('SIGKILL');
                } catch {
                    /* already dead */
                }
            }
        }, 5000);
        return { stopped: true };
    } catch (err) {
        return { stopped: false, reason: 'kill-error', error: err.message };
    }
}

function stopTrailerJob() {
    if (!trailerProcess) return { stopped: false, reason: 'not-running' };
    try {
        trailerProcess.kill('SIGTERM');
        const pid = trailerProcess.pid;
        setTimeout(() => {
            if (trailerProcess && trailerProcess.pid === pid) {
                try {
                    trailerProcess.kill('SIGKILL');
                } catch {
                    /* already dead */
                }
            }
        }, 5000);
        return { stopped: true };
    } catch (err) {
        return { stopped: false, reason: 'kill-error', error: err.message };
    }
}

// --- Test helper (nur unter NODE_ENV=test) ---
function __reset() {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error('__reset only available in NODE_ENV=test');
    }
    posterProcess = null;
    trailerProcess = null;
    posterSseClients = [];
    trailerSseClients = [];
    writeLock = Promise.resolve();
}

module.exports = {
    // State
    setLogger,
    isPosterRunning,
    isTrailerRunning,
    get posterProcess() {
        return posterProcess;
    },
    get trailerProcess() {
        return trailerProcess;
    },

    // File lock
    withFileLock,

    // Logs (in-memory, max 5 MB ringbuffer pro Job)
    getPosterLog: () => posterLog,
    getTrailerLog: () => trailerLog,

    // Filmliste
    readFilmList,
    writeFilmList,
    appendFilms,
    stripTmdbHint,
    hasTmdbHint,

    // ZIPs
    getExistingZips,
    getAllExistingZips,

    // SSE
    subscribePoster,
    unsubscribePoster,
    subscribeTrailer,
    unsubscribeTrailer,
    broadcastPoster,
    broadcastTrailer,

    // Job lifecycle
    spawnPosterPackJob,
    spawnTrailerJob,
    stopPosterPackJob,
    stopTrailerJob,

    // Paths (für Tests + Refactor)
    FILMLISTE_PATH,
    TMDB_EXPORT_DIR,
    ALL_EXPORT_DIRS,

    // Testing
    __reset,
};
