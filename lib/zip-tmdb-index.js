'use strict';

/**
 * zip-tmdb-index
 *
 * TMDB-ID → Name(n) vorhandener PosterPack-ZIPs, gelesen aus dem ZIP-Scan-Cache
 * (cache/zip-scan-cache.json). Grundlage des TMDB-basierten Abgleichs (z-20):
 * Die zwei Emby-Server benennen denselben Film teils unterschiedlich ("Top Gun -
 * Maverick" / "Top Gun: Maverick"). Der reine Namensvergleich der Emby-Sync hielt
 * den zweiten Namen für neu — PosterPack und Trailer wurden doppelt geladen.
 *
 * Der Cache wird von sources/local.js bei jedem Playlist-Refresh gepflegt und
 * enthält pro ZIP die metadata.json (z.tmdbId). Es wird kein ZIP geöffnet.
 */

const path = require('path');
const fsp = require('fs').promises;

const DEFAULT_CACHE_PATH = path.join(__dirname, '..', 'cache', 'zip-scan-cache.json');
const TMDB_HINT_RE = /^(.+?)\s*\[tmdb:(\d+)\]\s*$/;

/**
 * Zerlegt einen Filmlisten-Eintrag "Titel (Jahr)[tmdb:N]".
 * @returns {{ name: string, tmdbId: string|null }} name NFC-normalisiert
 */
function parseTmdbHint(entry) {
    const s = String(entry == null ? '' : entry);
    const m = TMDB_HINT_RE.exec(s);
    return {
        name: (m ? m[1] : s).trim().normalize('NFC'),
        tmdbId: m ? m[2] : null,
    };
}

function normalizeTmdbId(value) {
    if (value === null || value === undefined) return null;
    const id = String(value).trim();
    return /^\d+$/.test(id) ? id : null;
}

/**
 * Baut aus dem geparsten Cache-Objekt eine Map TMDB-ID → ZIP-Namen (ohne .zip,
 * NFC, sortiert). IDs sind im Cache Zahlen, bei Emby Strings — hier immer String.
 */
function buildZipTmdbIndex(cacheObj) {
    const index = new Map();
    if (!cacheObj || typeof cacheObj !== 'object') return index;
    for (const [zipPath, entry] of Object.entries(cacheObj)) {
        const id = normalizeTmdbId(entry && entry.z && entry.z.tmdbId);
        if (!id) continue;
        const name = path
            .basename(zipPath)
            .replace(/\.zip$/i, '')
            .normalize('NFC');
        const names = index.get(id);
        if (!names) index.set(id, [name]);
        else if (!names.includes(name)) names.push(name);
    }
    for (const names of index.values()) names.sort((a, b) => a.localeCompare(b, 'de'));
    return index;
}

let memo = { cachePath: null, mtimeMs: null, size: null, index: new Map() };

/**
 * Index aus dem ZIP-Scan-Cache, gemerkt über mtime+Größe (die Datei ist ~4 MB).
 * Fehlt die Datei: leere Map. Ist sie unlesbar (z. B. gerade halb geschrieben):
 * letzter gültiger Stand — sonst liefe die Sync einen Lauf lang wieder nur nach
 * Namen.
 */
async function getZipTmdbIndex({ cachePath = DEFAULT_CACHE_PATH, logger } = {}) {
    const last = memo.cachePath === cachePath ? memo.index : new Map();
    let st;
    try {
        st = await fsp.stat(cachePath);
    } catch (err) {
        if (err.code === 'ENOENT') return new Map();
        if (logger && typeof logger.warn === 'function') {
            logger.warn(`[ZipTmdbIndex] zip-scan-cache nicht lesbar: ${err.message}`);
        }
        return last;
    }
    if (memo.cachePath === cachePath && memo.mtimeMs === st.mtimeMs && memo.size === st.size) {
        return memo.index;
    }
    try {
        const index = buildZipTmdbIndex(JSON.parse(await fsp.readFile(cachePath, 'utf8')));
        memo = { cachePath, mtimeMs: st.mtimeMs, size: st.size, index };
        return index;
    } catch (err) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn(
                `[ZipTmdbIndex] zip-scan-cache nicht auswertbar (${err.message}) — letzter gültiger Stand bleibt`
            );
        }
        return last;
    }
}

/**
 * Löst einen Emby-Film auf ein vorhandenes ZIP auf.
 * Reihenfolge: exakter Name → TMDB-ID laut Cache → TMDB-ID laut Filmlisten-Hint.
 * Es zählen nur ZIPs, die auf der Platte liegen (zipMtimes) — damit sind veraltete
 * Cache-Einträge ebenso abgedeckt wie frisch geladene ZIPs, die noch kein
 * Playlist-Refresh gescannt hat (die kennt nur die Filmliste).
 *
 * @param {{ zipMtimes: Map<string, number>|Set<string>, tmdbIndex?: Map<string, string[]>, filmListLines?: string[] }} opts
 */
function createZipResolver({ zipMtimes, tmdbIndex, filmListLines = [] } = {}) {
    const onDisk = zipMtimes && typeof zipMtimes.has === 'function' ? zipMtimes : new Set();
    const index = tmdbIndex instanceof Map ? tmdbIndex : new Map();
    const listed = new Map();
    for (const line of filmListLines || []) {
        const { name, tmdbId } = parseTmdbHint(line);
        if (!tmdbId || !onDisk.has(name)) continue;
        const names = listed.get(tmdbId);
        if (!names) listed.set(tmdbId, [name]);
        else if (!names.includes(name)) names.push(name);
    }
    for (const names of listed.values()) names.sort((a, b) => a.localeCompare(b, 'de'));

    return {
        /**
         * @param {{ canonicalKey?: string, tmdbId?: string|number|null }} movie
         * @returns {{ zipName: string, via: 'name'|'tmdb-cache'|'tmdb-filmliste' }|null}
         */
        resolve(movie) {
            if (!movie) return null;
            if (movie.canonicalKey && onDisk.has(movie.canonicalKey)) {
                return { zipName: movie.canonicalKey, via: 'name' };
            }
            const id = normalizeTmdbId(movie.tmdbId);
            if (!id) return null;
            const cached = (index.get(id) || []).find(name => onDisk.has(name));
            if (cached) return { zipName: cached, via: 'tmdb-cache' };
            const fromList = listed.get(id);
            return fromList && fromList.length > 0
                ? { zipName: fromList[0], via: 'tmdb-filmliste' }
                : null;
        },
    };
}

function __resetForTests() {
    memo = { cachePath: null, mtimeMs: null, size: null, index: new Map() };
}

module.exports = {
    DEFAULT_CACHE_PATH,
    TMDB_HINT_RE,
    parseTmdbHint,
    buildZipTmdbIndex,
    getZipTmdbIndex,
    createZipResolver,
    __resetForTests,
};
