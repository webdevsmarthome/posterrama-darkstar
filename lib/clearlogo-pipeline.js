'use strict';

/**
 * Clearlogo-Pipeline
 *
 * Sequenziert die 4 Stages des Clearlogo-Nachladens:
 *   Stage 1: poster-updater/fetch-clearlogos.py        (TMDB)
 *   Stage 2: poster-updater/fetch-clearlogos-fanarttv.py
 *   Stage 3: poster-updater/fetch-clearlogos-local.py  (Plex/Jellyfin)
 *   Stage 4: Node.js Text-Render-Fallback (lib/text-clearlogo-renderer.js)
 *
 * Wird vom Emby-Sync-Hook ausgeloest, kann aber auch per Admin-Trigger
 * laufen. Singleton-Lock, in-memory Ringbuffer-Log, SSE-Subscribers
 * (analog zu lib/poster-updater-runner.js).
 *
 * Stage 4 wird in Node ausgefuehrt (Sharp ist bereits Dependency), damit
 * die Python-Skripte konzeptionell sauber "echte" Quellen bleiben.
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const COMPLETE_DIR = path.join(PROJECT_ROOT, 'media', 'complete');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'poster-updater');
const TMDB_SCRIPT = path.join(SCRIPT_DIR, 'fetch-clearlogos.py');
const FANARTTV_SCRIPT = path.join(SCRIPT_DIR, 'fetch-clearlogos-fanarttv.py');
const LOCAL_SCRIPT = path.join(SCRIPT_DIR, 'fetch-clearlogos-local.py');
const ZIP_SCAN_CACHE = path.join(PROJECT_ROOT, 'cache', 'zip-scan-cache.json');

// In-memory state
let running = false;
let log = '';
const MAX_LOG = 5 * 1024 * 1024; // 5 MB
const subscribers = new Set();
let logger = console;

function setLogger(l) {
    if (l && typeof l.info === 'function') logger = l;
}

function appendLog(text) {
    log += text;
    if (log.length > MAX_LOG) log = log.slice(log.length - MAX_LOG);
    // Broadcast to SSE subscribers
    for (const res of subscribers) {
        try {
            res.write(`data: ${JSON.stringify({ type: 'stdout', text })}\n\n`);
        } catch (_) {
            /* drop */
        }
    }
}

function isRunning() {
    return running;
}

function getLog() {
    return log;
}

function subscribe(res) {
    subscribers.add(res);
}

function unsubscribe(res) {
    subscribers.delete(res);
}

// ---------------------------------------------------------------------
// Stage 1-3: ein externes Python-Script starten und auf Exit warten
// ---------------------------------------------------------------------
function spawnScript(scriptPath, stageLabel) {
    return new Promise(resolve => {
        appendLog(`\n--- ${stageLabel}: starte ${path.basename(scriptPath)} ---\n`);
        let proc;
        try {
            /** @type {NodeJS.ProcessEnv} */
            const scriptEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
            // TMDB_API_KEY aus Node-Env darf das Script nicht aus seiner
            // eigenen Source lesen — wir folgen dem etablierten Pattern.
            delete scriptEnv['TMDB_API_KEY'];
            proc = spawn('python3', [scriptPath], {
                cwd: SCRIPT_DIR,
                env: scriptEnv,
            });
        } catch (err) {
            appendLog(`[${stageLabel}] spawn-error: ${err.message}\n`);
            return resolve({ code: -1, error: err.message });
        }
        proc.stdout.on('data', c => appendLog(c.toString('utf8')));
        proc.stderr.on('data', c => appendLog(c.toString('utf8')));
        proc.on('close', code => {
            appendLog(`--- ${stageLabel}: beendet (Exit ${code}) ---\n`);
            resolve({ code });
        });
        proc.on('error', err => {
            appendLog(`[${stageLabel}] error: ${err.message}\n`);
            resolve({ code: -1, error: err.message });
        });
    });
}

// ---------------------------------------------------------------------
// Stage 4: Text-Renderer Fallback (Node + Sharp)
// ---------------------------------------------------------------------

function findZipFiles() {
    const results = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (
                e.isFile() &&
                e.name.toLowerCase().endsWith('.zip') &&
                !e.name.startsWith('._')
            )
                results.push(full);
        }
    }
    walk(COMPLETE_DIR);
    return results;
}

// Liefert { hasClearlogo, source, title, tmdbId } durch Inspektion der
// metadata.json und des ZIP-Inhalts.
function inspectZip(zipPath) {
    try {
        const zip = new AdmZip(zipPath);
        const entries = zip.getEntries();
        const hasClearlogo = entries.some(e =>
            /(^|\/)clearlogo\.(png|jpg|jpeg|webp)$/i.test(e.entryName)
        );
        let meta = {};
        const metaEntry = entries.find(e => /(^|\/)metadata\.json$/i.test(e.entryName));
        if (metaEntry) {
            try {
                meta = JSON.parse(zip.readAsText(metaEntry));
            } catch (_) {
                meta = {};
            }
        }
        return {
            hasClearlogo,
            source: meta.clearlogoSource || null,
            title: meta.title || null,
            tmdbId: meta.tmdbId || meta.tmdb_id || (meta.ids && meta.ids.tmdb) || null,
        };
    } catch (_) {
        return { hasClearlogo: false, source: null, title: null, tmdbId: null };
    }
}

// Patcht ein ZIP mit dem generierten Clearlogo. Ersetzt vorhandene
// clearlogo.* und aktualisiert metadata.json.
function patchZipWithGenerated(zipPath, logoBuffer, title) {
    const zip = new AdmZip(zipPath);
    // Bestehende clearlogo-Eintraege entfernen
    const toRemove = zip
        .getEntries()
        .filter(e => /(^|\/)clearlogo\.(png|jpg|jpeg|webp)$/i.test(e.entryName))
        .map(e => e.entryName);
    for (const name of toRemove) zip.deleteFile(name);

    zip.addFile('clearlogo.png', logoBuffer);

    // Metadata aktualisieren / anlegen
    const metaEntry = zip.getEntry('metadata.json');
    /** @type {{ clearlogo?: string; clearlogoSource?: string; title?: string; [k: string]: any }} */
    let meta = {};
    if (metaEntry) {
        try {
            meta = JSON.parse(zip.readAsText(metaEntry));
        } catch (_) {
            meta = {};
        }
        zip.deleteFile('metadata.json');
    }
    meta.clearlogo = 'clearlogo.png';
    meta.clearlogoSource = 'generated';
    if (title && !meta.title) meta.title = title;
    zip.addFile('metadata.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
    zip.writeZip(zipPath);
}

async function runTextFallback() {
    const { renderTextClearlogo } = require('./text-clearlogo-renderer');
    const zips = findZipFiles();
    let generated = 0;
    let skipped = 0;
    let errors = 0;

    for (const zp of zips) {
        const info = inspectZip(zp);
        // Nur ZIPs ohne jegliches Logo bekommen ein generiertes —
        // bestehende 'generated' bleiben (wuerden in nachfolgenden
        // Pipeline-Runs durch echte Logos ersetzt, sobald welche
        // verfuegbar sind, siehe fanart.tv/local-Skripte).
        if (info.hasClearlogo) {
            skipped++;
            continue;
        }
        const title =
            info.title ||
            path
                .basename(zp)
                .replace(/\.zip$/i, '')
                .replace(/\s*\(\d{4}\)\s*$/, '');
        try {
            const buf = await renderTextClearlogo(title);
            patchZipWithGenerated(zp, buf, title);
            generated++;
            appendLog(`  [text] ${path.basename(zp)} — Text-Logo (${buf.length} B)\n`);
        } catch (err) {
            errors++;
            appendLog(`  [text] ${path.basename(zp)} — Fehler: ${err.message}\n`);
        }
    }

    appendLog(
        `\n--- Stage 4 (text-fallback): generiert ${generated}, uebersprungen ${skipped}, Fehler ${errors} ---\n`
    );
    return { generated, skipped, errors };
}

// ---------------------------------------------------------------------
// Cache-Invalidierung
// ---------------------------------------------------------------------
// Schreibt atomar: erst in eine temporaere Datei, dann rename(). Verhindert,
// dass ein parallel laufender Scan eine halb geschriebene Cache-Datei liest
// (4,2 MB brauchen ~150ms) — JSON.parse wuerfe dort, und der Scan fiele
// stillschweigend auf einen leeren Cache zurueck.
async function writeCacheAtomic(cacheFile, content) {
    const tmp = `${cacheFile}.tmp`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, cacheFile);
}

// cacheFile ist parametrisiert, damit Tests nicht den echten Cache anfassen.
async function invalidateZipScanCache(cacheFile = ZIP_SCAN_CACHE) {
    try {
        if (!fs.existsSync(cacheFile)) return;

        // Gezielt statt total: patchZipWithGenerated() ruft zip.writeZip() auf,
        // das mtime UND size jedes gepatchten ZIPs aendert — der Scan erkennt
        // diese Eintraege ohnehin an seinem mtime/size-Abgleich.
        //
        // Ein kompletter Reset auf '{}' zwang den naechsten Playlist-Refresh
        // dagegen, ALLE ~1300 ZIPs per AdmZip neu einzulesen. Das kostet
        // ~150ms pro ZIP (gemessen), also ~150s am Stueck — und weil AdmZip
        // synchron liest, blockierte das den kompletten Node-Event-Loop.
        // Folge: Requests brauchten 1,5-2,7s statt Millisekunden, laufende
        // Trailer-Streams stallten und die Cinema-Anzeige fror ein.
        // Der gezielte Abgleich kostet stattdessen ~30ms.
        let cache;
        try {
            cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
        } catch (err) {
            // Unlesbar oder korrupt — hier ist der Reset die richtige Antwort.
            await writeCacheAtomic(cacheFile, '{}');
            appendLog(`--- zip-scan-cache unlesbar (${err.message}) — zurueckgesetzt ---\n`);
            return;
        }

        let dropped = 0;
        for (const [zipPath, entry] of Object.entries(cache)) {
            let st = null;
            try {
                st = fs.statSync(zipPath);
            } catch (_) {
                /* Datei existiert nicht mehr */
            }
            if (!st || st.mtimeMs !== entry.m || st.size !== entry.s) {
                delete cache[zipPath];
                dropped++;
            }
        }
        await writeCacheAtomic(cacheFile, JSON.stringify(cache));
        appendLog(
            `--- zip-scan-cache: ${dropped} veraltete Eintraege entfernt, ${Object.keys(cache).length} behalten ---\n`
        );
    } catch (err) {
        appendLog(`--- zip-scan-cache-Bereinigung fehlgeschlagen: ${err.message} ---\n`);
    }
}

// ---------------------------------------------------------------------
// Public: vollstaendiger Pipeline-Lauf
// ---------------------------------------------------------------------
async function run({ skipTmdb = true } = {}) {
    if (running) {
        return { started: false, reason: 'already-running' };
    }
    running = true;
    log = `=== Clearlogo-Pipeline gestartet ${new Date().toISOString()} ===\n`;
    logger.info && logger.info('clearlogo-pipeline: started');

    const stats = {
        tmdb: { code: null, skipped: skipTmdb },
        fanarttv: { code: null },
        local: { code: null },
        text: { generated: 0, skipped: 0, errors: 0 },
    };

    try {
        // Stage 1: TMDB (optional — typischerweise bereits ausgeschoepft)
        if (!skipTmdb && fs.existsSync(TMDB_SCRIPT)) {
            stats.tmdb = await spawnScript(TMDB_SCRIPT, 'Stage 1: TMDB');
        }

        // Stage 2: fanart.tv
        if (fs.existsSync(FANARTTV_SCRIPT)) {
            stats.fanarttv = await spawnScript(FANARTTV_SCRIPT, 'Stage 2: fanart.tv');
        }

        // Stage 3: Plex/Jellyfin local
        if (fs.existsSync(LOCAL_SCRIPT)) {
            stats.local = await spawnScript(LOCAL_SCRIPT, 'Stage 3: Plex/Jellyfin local');
        }

        // Stage 4: Text-Render-Fallback
        appendLog('\n--- Stage 4: Text-Render-Fallback startet ---\n');
        stats.text = await runTextFallback();

        // Cache-Invalidierung — sonst sieht die App die neuen Logos nicht.
        await invalidateZipScanCache();

        appendLog(
            `\n=== Pipeline fertig ${new Date().toISOString()} — text:${stats.text.generated} ===\n`
        );
    } catch (err) {
        appendLog(`\n=== Pipeline-Fehler: ${err.message} ===\n`);
        logger.error && logger.error('clearlogo-pipeline: error', err);
    } finally {
        running = false;
        for (const res of subscribers) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'done', stats })}\n\n`);
            } catch (_) {
                /* drop */
            }
        }
    }

    return { started: true, stats };
}

function __reset() {
    running = false;
    log = '';
    subscribers.clear();
}

module.exports = {
    setLogger,
    isRunning,
    getLog,
    subscribe,
    unsubscribe,
    run,
    __reset,
    __invalidateZipScanCache: invalidateZipScanCache,
};
