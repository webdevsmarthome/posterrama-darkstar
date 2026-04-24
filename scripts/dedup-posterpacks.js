#!/usr/bin/env node
'use strict';

/**
 * dedup-posterpacks.js
 *
 * Bereinigt ZIP-PosterPacks, die aufgrund falscher Jahreszahlen und/oder
 * unterschiedlicher Titel-Schreibweisen als Duplikate im Dateisystem
 * existieren. TMDB wird als Single-Source-of-Truth für den kanonischen
 * Namen verwendet.
 *
 * Vorgehen:
 *  1. Alle ZIPs in media/complete/{manual,plex-export,jellyfin-emby-export,
 *     tmdb-export,romm-export}/ scannen und per metadata.json die tmdb_id
 *     extrahieren.
 *  2. Gruppieren nach tmdb_id.
 *  3. Für jede Gruppe einmal TMDB API (/movie/{id}, de-DE mit en-US-Fallback)
 *     abfragen → {title, release_year}.
 *  4. Für jeden ZIP:
 *       - Year-Modus (Default): target = "{aktueller Title-Präfix} ({TMDB-Jahr})"
 *       - Title-Modus (--normalize-title): target = "{TMDB-Title} ({TMDB-Jahr})"
 *     Dann:
 *       - Wenn basename == target → ZIP bleibt (Kanonischer Winner).
 *       - Sonst wenn target.zip schon in gleichem Dir existiert → DELETE.
 *       - Sonst → RENAME zu target (größtes ZIP bevorzugt).
 *  5. Sidecars, Playlists, Filmliste, Trailer werden mit umgestellt.
 *  6. Report am Ende.
 *
 * Nutzung:
 *   node scripts/dedup-posterpacks.js                         # Dry-Run Year-Only
 *   node scripts/dedup-posterpacks.js --execute               # Execute Year-Only
 *   node scripts/dedup-posterpacks.js --normalize-title       # Dry-Run Year+Title
 *   node scripts/dedup-posterpacks.js --normalize-title --execute
 *   Zusätzlich: --verbose
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_DIRS = [
    'media/complete/manual',
    'media/complete/plex-export',
    'media/complete/jellyfin-emby-export',
    'media/complete/tmdb-export',
    'media/complete/romm-export',
].map(p => path.join(ROOT, p));

const PLAYLISTS_PATH = path.join(ROOT, 'public', 'cinema-playlists.json');
const LIVE_PLAYLIST_PATH = path.join(ROOT, 'public', 'cinema-playlist.json');
const FILMLISTE_PATH = path.join(ROOT, 'poster-updater', 'filmliste.txt');
const TRAILER_DIR = path.join(ROOT, 'media', 'trailers');
const TRAILER_INFO_PATH = path.join(TRAILER_DIR, 'trailer-info.json');

const DRY_RUN = !process.argv.includes('--execute');
const VERBOSE = process.argv.includes('--verbose');
const NORMALIZE_TITLE = process.argv.includes('--normalize-title');

function log(...args) {
    console.log(...args);
}
function vlog(...args) {
    if (VERBOSE) console.log(...args);
}

// ------------------------------------------------------------------
// TMDB API
// ------------------------------------------------------------------
let TMDB_KEY = null;

async function loadTmdbKey() {
    // 1. Preferred: config.json:tmdbSource.apiKey (authoritative, used by Python scripts)
    try {
        const cfg = JSON.parse(await fsp.readFile(path.join(ROOT, 'config.json'), 'utf8'));
        const k = cfg && cfg.tmdbSource && cfg.tmdbSource.apiKey;
        if (k && k !== 'your-api-key-here' && k.length >= 20) {
            TMDB_KEY = String(k).trim();
            return;
        }
    } catch (_) {
        /* fall through */
    }
    // 2. Fallback: .env
    try {
        const envText = await fsp.readFile(path.join(ROOT, '.env'), 'utf8');
        const m = envText.match(/^TMDB_API_KEY\s*=\s*"?([^"\n]*)"?/m);
        if (m) {
            const k = m[1].trim();
            if (k && k !== 'false' && k.length >= 20) {
                TMDB_KEY = k;
                return;
            }
        }
    } catch (_) {
        /* fall through */
    }
    throw new Error('No valid TMDB_API_KEY found (neither config.json:tmdbSource.apiKey nor .env)');
}

function tmdbFetchMovie(tmdbId, language = 'de-DE') {
    return new Promise((resolve, reject) => {
        const url = `https://api.themoviedb.org/3/movie/${encodeURIComponent(tmdbId)}?api_key=${TMDB_KEY}&language=${language}`;
        https
            .get(url, res => {
                let data = '';
                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode === 404) return resolve(null);
                    if (res.statusCode >= 400) {
                        return reject(
                            new Error(
                                `TMDB HTTP ${res.statusCode} for ${tmdbId}: ${data.slice(0, 200)}`
                            )
                        );
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`TMDB JSON parse error: ${e.message}`));
                    }
                });
            })
            .on('error', reject);
    });
}

/**
 * Sanitize string for safe filesystem use. On Linux only `/` and NUL are
 * actually forbidden; we keep colons, commas, Unicode etc. (already present
 * in existing filenames). NFC-normalisieren für stabile String-Vergleiche.
 */
function sanitizeFilename(s) {
    if (!s) return '';
    return String(s)
        .normalize('NFC')
        .replace(/[\x00/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Rate-limited TMDB query: 20 req/s should be safe (free tier is 40/s)
async function rateLimited(fns, concurrency = 8) {
    const results = [];
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
        while (i < fns.length) {
            const idx = i++;
            try {
                results[idx] = { ok: true, value: await fns[idx]() };
            } catch (e) {
                results[idx] = { ok: false, error: e };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

// ------------------------------------------------------------------
// Scan ZIPs
// ------------------------------------------------------------------
async function scanAllZips() {
    const items = [];
    for (const dir of EXPORT_DIRS) {
        let entries;
        try {
            entries = await fsp.readdir(dir);
        } catch (err) {
            if (err.code === 'ENOENT') continue;
            throw err;
        }
        for (const name of entries) {
            if (!name.toLowerCase().endsWith('.zip')) continue;
            const full = path.join(dir, name);
            const basename = name.replace(/\.zip$/i, '');
            // Extract "{title} ({year})" pattern
            const m = basename.match(/^(.*) \((\d{4})\)$/);
            if (!m) {
                vlog(`[skip-no-year] ${full}`);
                continue;
            }
            const titlePrefix = m[1];
            const yearInName = parseInt(m[2], 10);

            let tmdbId = null;
            try {
                const zip = new AdmZip(full);
                const meta = zip.getEntry('metadata.json');
                if (meta) {
                    const data = JSON.parse(meta.getData().toString('utf8'));
                    tmdbId =
                        data.tmdb_id ||
                        data.tmdbId ||
                        (data.providers && (data.providers.tmdb_id || data.providers.tmdb)) ||
                        null;
                    if (tmdbId) tmdbId = String(tmdbId);
                }
            } catch (e) {
                vlog(`[zip-err] ${full}: ${e.message}`);
            }

            let size = 0;
            try {
                const st = await fsp.stat(full);
                size = st.size;
            } catch (_) {
                /* ignore */
            }

            items.push({
                dir,
                basename,
                fullPath: full,
                titlePrefix,
                yearInName,
                tmdbId,
                size,
            });
        }
    }
    return items;
}

// ------------------------------------------------------------------
// Dedup plan
// ------------------------------------------------------------------
function buildPlan(items, tmdbYearById, tmdbTitleById = {}) {
    // Für Kollisions-Erkennung bei Renames: existing ZIPs pro (Verzeichnis, basename)
    const existingByDirBase = new Map();
    for (const it of items) {
        existingByDirBase.set(`${it.dir}|${it.basename}`, it);
    }

    const actions = [];

    // Im --normalize-title-Modus: pro Gruppe (dir, tmdb_id) die größte ZIP als
    // "rename-target-candidate" wählen, damit beim Rename die reichste ZIP
    // erhalten bleibt. Ohne den Modus: Reihenfolge wie gescannt.
    const groupOrder = items.slice();
    if (NORMALIZE_TITLE) {
        // Items in jeder (dir, tmdbId)-Gruppe absteigend nach size sortieren,
        // innerhalb der Gesamt-items-Liste. Stable-Sort-Äquivalent.
        groupOrder.sort((a, b) => {
            if (a.dir !== b.dir) return a.dir.localeCompare(b.dir);
            const at = String(a.tmdbId || '');
            const bt = String(b.tmdbId || '');
            if (at !== bt) return at.localeCompare(bt);
            return b.size - a.size; // größte zuerst
        });
    }

    for (const it of groupOrder) {
        if (!it.tmdbId) {
            actions.push({ type: 'keep', item: it, reason: 'no-tmdb-id' });
            continue;
        }
        const tmdbYear = tmdbYearById[it.tmdbId];
        if (!tmdbYear) {
            actions.push({ type: 'keep', item: it, reason: 'no-tmdb-year' });
            continue;
        }

        // Title-Teil des Ziel-Namens bestimmen
        let titlePart = it.titlePrefix;
        let reasonTag = `year-mismatch-tmdb-says-${tmdbYear}`;
        if (NORMALIZE_TITLE) {
            const tmdbTitle = tmdbTitleById[it.tmdbId];
            if (tmdbTitle) {
                const sanitized = sanitizeFilename(tmdbTitle);
                if (sanitized && sanitized.length > 0) {
                    titlePart = sanitized;
                    reasonTag = `canonical-tmdb-name`;
                }
            } else {
                // Kein TMDB-Titel verfügbar → keep Title-Präfix aus Filename
                actions.push({ type: 'keep', item: it, reason: 'no-tmdb-title' });
                continue;
            }
        }

        const target = `${titlePart} (${tmdbYear})`;
        if (target === it.basename) {
            actions.push({
                type: 'keep',
                item: it,
                reason: NORMALIZE_TITLE ? 'already-canonical' : 'year-already-matches-tmdb',
            });
            continue;
        }

        const targetKey = `${it.dir}|${target}`;
        if (existingByDirBase.has(targetKey)) {
            // Target existiert bereits — diesen ZIP löschen
            actions.push({
                type: 'delete',
                item: it,
                reason: `duplicate-of-existing-${target}`,
                keepInstead: target,
            });
        } else {
            actions.push({
                type: 'rename',
                item: it,
                targetBasename: target,
                reason: reasonTag,
            });
            existingByDirBase.set(targetKey, { ...it, basename: target });
        }
    }

    return actions;
}

// ------------------------------------------------------------------
// Execute plan
// ------------------------------------------------------------------
async function loadPlaylistsCollection() {
    try {
        const raw = await fsp.readFile(PLAYLISTS_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}
async function savePlaylistsCollection(c) {
    await fsp.writeFile(PLAYLISTS_PATH, JSON.stringify(c, null, 2) + '\n', 'utf8');
}
async function loadFilmliste() {
    try {
        return (await fsp.readFile(FILMLISTE_PATH, 'utf8'))
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}
async function saveFilmliste(lines) {
    const sorted = [...new Set(lines)].sort((a, b) => a.localeCompare(b, 'de'));
    await fsp.writeFile(FILMLISTE_PATH, sorted.join('\n') + '\n', 'utf8');
}
async function loadTrailerInfo() {
    try {
        return JSON.parse(await fsp.readFile(TRAILER_INFO_PATH, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
}
async function saveTrailerInfo(info) {
    await fsp.writeFile(TRAILER_INFO_PATH, JSON.stringify(info, null, 2) + '\n', 'utf8');
}

async function applyPlan(actions) {
    const playlists = (await loadPlaylistsCollection()) || { activePlaylistId: null, playlists: {} };
    const filmliste = await loadFilmliste();
    const trailerInfo = await loadTrailerInfo();

    const stats = {
        deleted: 0,
        renamed: 0,
        keep: 0,
        sidecarDeleted: 0,
        sidecarRenamed: 0,
        trailerRenamed: 0,
        trailerDeleted: 0,
        playlistEntriesFixed: 0,
        filmlisteEntriesFixed: 0,
        trailerInfoEntriesFixed: 0,
    };

    // Wir sammeln Rename- und Delete-Mappings für Text-Ersetzungen
    // in Playlists/Filmliste/Trailer-Info
    const basenameRenames = new Map(); // oldBasename → newBasename
    const basenameDeletes = new Set(); // oldBasename (ersatzlos wenn kein keepInstead)
    const basenameDeletesToKeep = new Map(); // oldBasename → basename to redirect to

    for (const a of actions) {
        if (a.type === 'keep') {
            stats.keep++;
            continue;
        }
        if (a.type === 'delete') {
            const { item, keepInstead } = a;
            log(`[delete] ${path.relative(ROOT, item.fullPath)}  (duplicate of ${keepInstead})`);
            if (!DRY_RUN) {
                // ZIP löschen
                await fsp.unlink(item.fullPath).catch(() => {});
                // Sidecar .poster.json
                const sidecar = path.join(item.dir, `${item.basename}.poster.json`);
                try {
                    await fsp.unlink(sidecar);
                    stats.sidecarDeleted++;
                } catch (_) {
                    /* sidecar fehlt */
                }
                // Trailer-Datei
                const trailer = path.join(TRAILER_DIR, `${item.basename}-trailer.mp4`);
                try {
                    // Nur löschen, wenn KEIN Ziel-Trailer existiert (sonst lieber behalten)
                    const targetTrailer = path.join(
                        TRAILER_DIR,
                        `${keepInstead}-trailer.mp4`
                    );
                    if (!fs.existsSync(targetTrailer) && fs.existsSync(trailer)) {
                        // Umbenennen zum Ziel
                        await fsp.rename(trailer, targetTrailer);
                        stats.trailerRenamed++;
                    } else if (fs.existsSync(trailer)) {
                        await fsp.unlink(trailer);
                        stats.trailerDeleted++;
                    }
                } catch (_) {
                    /* trailer fehlt */
                }
            }
            basenameDeletesToKeep.set(item.basename, keepInstead);
            stats.deleted++;
            continue;
        }
        if (a.type === 'rename') {
            const { item, targetBasename } = a;
            const targetZip = path.join(item.dir, `${targetBasename}.zip`);
            const targetSidecar = path.join(item.dir, `${targetBasename}.poster.json`);
            const sourceSidecar = path.join(item.dir, `${item.basename}.poster.json`);
            log(
                `[rename] ${path.relative(ROOT, item.fullPath)}  →  ${path.basename(targetZip)}  (${a.reason})`
            );
            if (!DRY_RUN) {
                await fsp.rename(item.fullPath, targetZip);
                try {
                    await fsp.rename(sourceSidecar, targetSidecar);
                    stats.sidecarRenamed++;
                } catch (_) {
                    /* sidecar fehlt */
                }
                // Trailer umbenennen, falls vorhanden
                const sourceTrailer = path.join(
                    TRAILER_DIR,
                    `${item.basename}-trailer.mp4`
                );
                const targetTrailer = path.join(
                    TRAILER_DIR,
                    `${targetBasename}-trailer.mp4`
                );
                if (fs.existsSync(sourceTrailer) && !fs.existsSync(targetTrailer)) {
                    await fsp.rename(sourceTrailer, targetTrailer);
                    stats.trailerRenamed++;
                } else if (fs.existsSync(sourceTrailer)) {
                    // Ziel existiert, Source ist redundant
                    await fsp.unlink(sourceTrailer);
                    stats.trailerDeleted++;
                }
            }
            basenameRenames.set(item.basename, targetBasename);
            stats.renamed++;
        }
    }

    // ----- Cinema-Playlists -----
    if (playlists && playlists.playlists) {
        for (const [, pl] of Object.entries(playlists.playlists)) {
            if (!Array.isArray(pl.titles)) continue;
            const newTitles = [];
            const seen = new Set();
            for (const t of pl.titles) {
                let canonical = t;
                if (basenameRenames.has(t)) {
                    canonical = basenameRenames.get(t);
                    stats.playlistEntriesFixed++;
                } else if (basenameDeletesToKeep.has(t)) {
                    canonical = basenameDeletesToKeep.get(t);
                    stats.playlistEntriesFixed++;
                }
                // Dedupe innerhalb der Playlist (z. B. "X (2022)" + "X (2023)" → beide werden "X (2023)")
                if (seen.has(canonical)) continue;
                seen.add(canonical);
                newTitles.push(canonical);
            }
            pl.titles = newTitles;
        }
        if (!DRY_RUN) {
            await savePlaylistsCollection(playlists);
            // Live-Playlist syncen, falls aktive Playlist betroffen ist
            const activeId = playlists.activePlaylistId;
            if (activeId && playlists.playlists[activeId]) {
                try {
                    let live;
                    try {
                        live = JSON.parse(await fsp.readFile(LIVE_PLAYLIST_PATH, 'utf8'));
                    } catch {
                        live = { enabled: true, titles: [] };
                    }
                    live.titles = playlists.playlists[activeId].titles;
                    await fsp.writeFile(
                        LIVE_PLAYLIST_PATH,
                        JSON.stringify(live, null, 2) + '\n',
                        'utf8'
                    );
                } catch (_) {
                    /* best effort */
                }
            }
        }
    }

    // ----- Filmliste.txt -----
    if (filmliste.length > 0) {
        const updated = new Set();
        for (const entry of filmliste) {
            let canonical = entry;
            if (basenameRenames.has(entry)) {
                canonical = basenameRenames.get(entry);
                stats.filmlisteEntriesFixed++;
            } else if (basenameDeletesToKeep.has(entry)) {
                canonical = basenameDeletesToKeep.get(entry);
                stats.filmlisteEntriesFixed++;
            }
            updated.add(canonical);
        }
        if (!DRY_RUN) {
            await saveFilmliste([...updated]);
        }
    }

    // ----- trailer-info.json -----
    if (trailerInfo && Object.keys(trailerInfo).length > 0) {
        const newInfo = {};
        for (const [k, v] of Object.entries(trailerInfo)) {
            let canonical = k;
            if (basenameRenames.has(k)) {
                canonical = basenameRenames.get(k);
                stats.trailerInfoEntriesFixed++;
            } else if (basenameDeletesToKeep.has(k)) {
                canonical = basenameDeletesToKeep.get(k);
                stats.trailerInfoEntriesFixed++;
            }
            // Falls zwei Einträge auf denselben canonical zeigen, Vorrang: erster gewinnt
            if (!newInfo[canonical]) newInfo[canonical] = v;
        }
        if (!DRY_RUN) {
            await saveTrailerInfo(newInfo);
        }
    }

    return stats;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main() {
    log(`[dedup-posterpacks] Mode: ${DRY_RUN ? 'DRY-RUN (kein Schreiben)' : 'EXECUTE'}`);
    log('[dedup-posterpacks] TMDB-Key laden...');
    await loadTmdbKey();

    log('[dedup-posterpacks] ZIPs scannen...');
    const items = await scanAllZips();
    log(`  → ${items.length} ZIPs gefunden (mit Year-Pattern)`);

    // Gruppieren nach tmdb_id
    const byTmdb = new Map();
    let withoutId = 0;
    for (const it of items) {
        if (!it.tmdbId) {
            withoutId++;
            continue;
        }
        if (!byTmdb.has(it.tmdbId)) byTmdb.set(it.tmdbId, []);
        byTmdb.get(it.tmdbId).push(it);
    }
    log(
        `  → ${byTmdb.size} distinct tmdb_ids (${withoutId} ZIPs ohne tmdb_id werden nicht angefasst)`
    );

    // Welche tmdb_ids müssen wir abfragen?
    //   Year-Only-Modus: nur Gruppen mit ≥2 ZIPs (wo sich Duplikate bilden können)
    //   Title-Normalize:  alle IDs mit ≥2 ZIPs (gleichen Scope — einzelne ZIPs
    //                     mit "nicht-kanonischem" Titel sind außer Scope)
    const candidateIds = [...byTmdb.entries()]
        .filter(([, list]) => list.length >= 2)
        .map(([id]) => id);
    log(`  → ${candidateIds.length} tmdb_ids haben ≥2 ZIPs (Dedup-Kandidaten)`);
    log(
        `[dedup-posterpacks] TMDB-API abfragen (${candidateIds.length} IDs, parallel=8, mode=${NORMALIZE_TITLE ? 'year+title' : 'year-only'})...`
    );

    const tmdbYearById = {};
    const tmdbTitleById = {};
    const fns = candidateIds.map(id => async () => {
        // Primary fetch: de-DE
        const dataDe = await tmdbFetchMovie(id, 'de-DE');
        if (dataDe && dataDe.release_date && /^\d{4}/.test(dataDe.release_date)) {
            tmdbYearById[id] = parseInt(dataDe.release_date.slice(0, 4), 10);
        } else {
            tmdbYearById[id] = null;
        }
        // Title preference: de-DE title, fallback original/en-US
        if (dataDe && dataDe.title && dataDe.title.trim()) {
            tmdbTitleById[id] = dataDe.title.trim();
        } else {
            const dataEn = await tmdbFetchMovie(id, 'en-US');
            if (dataEn && dataEn.title && dataEn.title.trim()) {
                tmdbTitleById[id] = dataEn.title.trim();
            } else if (dataDe && dataDe.original_title) {
                tmdbTitleById[id] = dataDe.original_title.trim();
            } else {
                tmdbTitleById[id] = null;
            }
        }
    });
    const results = await rateLimited(fns, 8);
    const errs = results.filter(r => !r.ok);
    if (errs.length > 0) {
        log(`  ⚠ ${errs.length} TMDB-Fetches fehlgeschlagen`);
        if (VERBOSE) errs.slice(0, 10).forEach(e => log(`    - ${e.error.message}`));
    }
    const withYear = Object.values(tmdbYearById).filter(Boolean).length;
    const withTitle = Object.values(tmdbTitleById).filter(Boolean).length;
    log(`  → ${withYear}/${candidateIds.length} IDs mit Release-Year`);
    log(`  → ${withTitle}/${candidateIds.length} IDs mit Title`);

    const candidateItems = items.filter(it => candidateIds.includes(it.tmdbId));
    log(
        `[dedup-posterpacks] Plan bauen für ${candidateItems.length} ZIPs in Duplikats-Gruppen...`
    );
    const plan = buildPlan(candidateItems, tmdbYearById, tmdbTitleById);
    const counts = plan.reduce(
        (acc, a) => ({ ...acc, [a.type]: (acc[a.type] || 0) + 1 }),
        {}
    );
    log(`  → Plan: keep=${counts.keep || 0}  rename=${counts.rename || 0}  delete=${counts.delete || 0}`);

    log('[dedup-posterpacks] Ausführung:');
    const stats = await applyPlan(plan);
    log('[dedup-posterpacks] Ergebnis:');
    for (const [k, v] of Object.entries(stats)) log(`  ${k}: ${v}`);
    if (DRY_RUN) {
        log('');
        log('(DRY-RUN — es wurde nichts geschrieben. Mit --execute ausführen.)');
    }
}

main().catch(err => {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
