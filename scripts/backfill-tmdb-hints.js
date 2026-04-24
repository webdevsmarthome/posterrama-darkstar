#!/usr/bin/env node
'use strict';

/**
 * backfill-tmdb-hints.js
 *
 * One-Shot-Migration: bestehende Filmliste-Einträge ohne [tmdb:N]-Hint
 * bekommen die TMDB-ID nachträglich eingetragen. Einträge mit bereits
 * vorhandenem Hint werden unverändert gelassen.
 *
 * Quellen für die TMDB-ID (in dieser Priorität):
 *   1. Bestehendes PosterPack-ZIP (metadata.json.tmdb_id)   → kein API-Call
 *   2. Emby/Jellyfin-Server (ProviderIds.Tmdb via /Items)   → ein API-Call
 *
 * Wenn beides fehlt, bleibt der Eintrag ohne Hint (nicht auffindbar,
 * Python-Fallback auf Title+Year-Suche greift).
 *
 * Nutzung:
 *   node scripts/backfill-tmdb-hints.js            # Dry-Run
 *   node scripts/backfill-tmdb-hints.js --execute  # Ausführen
 *   + optional: --verbose
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const FILMLISTE_PATH = path.join(ROOT, 'poster-updater', 'filmliste.txt');
const EXPORT_DIRS = [
    'media/complete/manual',
    'media/complete/plex-export',
    'media/complete/jellyfin-emby-export',
    'media/complete/tmdb-export',
    'media/complete/romm-export',
].map(p => path.join(ROOT, p));

const DRY_RUN = !process.argv.includes('--execute');
const VERBOSE = process.argv.includes('--verbose');

function log(...a) {
    console.log(...a);
}
function vlog(...a) {
    if (VERBOSE) console.log(...a);
}

const TMDB_HINT_RE = /^(.+?)\s*\[tmdb:(\d+)\]\s*$/;
function hasHint(line) {
    return TMDB_HINT_RE.test(line);
}
function canonicalOf(line) {
    const m = line.match(TMDB_HINT_RE);
    return (m ? m[1] : line).trim();
}

// ------------------------------------------------------------------
// Quelle 1: ZIP-Scan → Map canonicalKey → tmdb_id
// ------------------------------------------------------------------
async function buildZipTmdbMap() {
    const map = new Map();
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
            const basename = name.replace(/\.zip$/i, '');
            const key = basename.normalize('NFC');
            if (map.has(key)) continue; // erste gewinnt
            try {
                const zp = new AdmZip(path.join(dir, name));
                const meta = zp.getEntry('metadata.json');
                if (!meta) continue;
                const data = JSON.parse(meta.getData().toString('utf8'));
                const tid =
                    data.tmdb_id ||
                    data.tmdbId ||
                    (data.providers &&
                        (data.providers.tmdb_id || data.providers.tmdb)) ||
                    null;
                if (tid) map.set(key, String(tid));
            } catch (e) {
                vlog(`[zip-err] ${dir}/${name}: ${e.message}`);
            }
        }
    }
    return map;
}

// ------------------------------------------------------------------
// Quelle 2: Emby-Server fragen
// ------------------------------------------------------------------
async function buildEmbyTmdbMap({ logger }) {
    // Lade posterrama-eigenen Jellyfin-Helper
    const configModule = require(path.join(ROOT, 'config'));
    const { getJellyfinClient, getJellyfinLibraries } = require(
        path.join(ROOT, 'lib', 'jellyfin-helpers')
    );

    const map = new Map();
    const servers = (configModule.mediaServers || []).filter(
        s => s.type === 'jellyfin' && s.enabled
    );
    if (servers.length === 0) {
        log('  (keine Jellyfin-Server in config aktiviert)');
        return map;
    }

    for (const server of servers) {
        log(`  Server "${server.name}" abfragen...`);
        try {
            const client = await getJellyfinClient(server);
            const libs = await getJellyfinLibraries(server);
            const movieLibs = [];
            const configured = Array.isArray(server.movieLibraryNames)
                ? server.movieLibraryNames.filter(Boolean)
                : [];
            if (configured.length > 0) {
                for (const n of configured) {
                    const lib = libs.get(n);
                    if (lib) movieLibs.push(lib);
                }
            } else {
                for (const [, d] of libs) if (d.type === 'movies') movieLibs.push(d);
            }

            for (const lib of movieLibs) {
                // Alle Movies — wir brauchen nicht nur Limit:500, sondern MEHR
                // Weil wir matchen wollen, pullen wir alles in einem Rutsch.
                const batchSize = 2000;
                let startIndex = 0;
                for (;;) {
                    const resp = await client.getItems({
                        parentId: lib.id,
                        includeItemTypes: ['Movie'],
                        recursive: true,
                        fields: ['ProviderIds', 'ProductionYear'],
                        limit: batchSize,
                        startIndex,
                    });
                    const items = (resp && resp.Items) || [];
                    for (const it of items) {
                        if (!it.Name || !it.ProductionYear) continue;
                        const key =
                            `${String(it.Name).trim()} (${it.ProductionYear})`.normalize(
                                'NFC'
                            );
                        const tid = it.ProviderIds && it.ProviderIds.Tmdb;
                        if (tid && !map.has(key)) {
                            map.set(key, String(tid));
                        }
                    }
                    if (items.length < batchSize) break;
                    startIndex += batchSize;
                }
            }
        } catch (e) {
            log(`    ⚠ ${server.name}: ${e.message}`);
        }
    }
    return map;
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
async function main() {
    log(`[backfill-tmdb-hints] Mode: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

    const raw = await fsp.readFile(FILMLISTE_PATH, 'utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    log(`  Filmliste: ${lines.length} Einträge`);

    const withHint = lines.filter(hasHint);
    const needHint = lines.filter(l => !hasHint(l));
    log(`  Bereits mit Hint: ${withHint.length}`);
    log(`  Ohne Hint (Backfill-Kandidaten): ${needHint.length}`);

    if (needHint.length === 0) {
        log('  Nichts zu tun.');
        return;
    }

    // Schritt 1: ZIPs scannen
    log('[backfill-tmdb-hints] ZIPs scannen für TMDB-IDs...');
    const zipMap = await buildZipTmdbMap();
    log(`  → ${zipMap.size} ZIPs mit tmdb_id gefunden`);

    // Schritt 2: noch ungelöste Einträge → Emby fragen
    const unresolvedAfterZip = needHint.filter(line => {
        const key = canonicalOf(line).normalize('NFC');
        return !zipMap.has(key);
    });
    log(`  Noch ungelöst nach ZIP-Scan: ${unresolvedAfterZip.length}`);

    let embyMap = new Map();
    if (unresolvedAfterZip.length > 0) {
        log('[backfill-tmdb-hints] Emby-Server fragen...');
        embyMap = await buildEmbyTmdbMap({ logger: console });
        log(`  → ${embyMap.size} Filme mit Emby-TMDB-ID gefunden`);
    }

    // Merge: für jede needHint-Zeile die ID bestimmen
    const updated = [];
    const notFound = [];
    const stats = { fromZip: 0, fromEmby: 0, notFound: 0 };

    for (const line of needHint) {
        const key = canonicalOf(line).normalize('NFC');
        let tid = zipMap.get(key);
        let src = null;
        if (tid) {
            src = 'zip';
        } else {
            tid = embyMap.get(key);
            if (tid) src = 'emby';
        }
        if (tid) {
            const newLine = `${canonicalOf(line)}[tmdb:${tid}]`;
            updated.push({ old: line, new: newLine, src });
            if (src === 'zip') stats.fromZip++;
            else stats.fromEmby++;
        } else {
            notFound.push(line);
            stats.notFound++;
        }
    }

    log('');
    log(`[backfill-tmdb-hints] Ergebnis:`);
    log(`  from-zip : ${stats.fromZip}`);
    log(`  from-emby: ${stats.fromEmby}`);
    log(`  not-found: ${stats.notFound}`);

    if (VERBOSE || DRY_RUN) {
        log('');
        log('--- Beispiele Updates (erste 10) ---');
        for (const u of updated.slice(0, 10)) {
            log(`  [${u.src}] ${u.old}  →  ${u.new}`);
        }
        if (notFound.length > 0) {
            log('');
            log('--- Nicht auflösbar (erste 10) ---');
            for (const l of notFound.slice(0, 10)) log(`  ${l}`);
        }
    }

    if (DRY_RUN) {
        log('');
        log('(DRY-RUN — keine Schreiboperation. Mit --execute ausführen.)');
        return;
    }

    // Execute: Backup + Write
    const backupPath = FILMLISTE_PATH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(FILMLISTE_PATH, backupPath);
    log(`  Backup: ${path.relative(ROOT, backupPath)}`);

    const updateMap = new Map(updated.map(u => [u.old, u.new]));
    const newLines = lines.map(l => updateMap.get(l) || l);
    // Alphabetisch sortieren (so wie poster-updater-runner.writeFilmList)
    newLines.sort((a, b) => a.localeCompare(b, 'de'));
    await fsp.writeFile(FILMLISTE_PATH, newLines.join('\n') + '\n', 'utf8');
    log(`  Filmliste geschrieben (${newLines.length} Einträge, ${updated.length} Upgrades)`);
}

main().catch(err => {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
