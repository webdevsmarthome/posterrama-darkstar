#!/usr/bin/env node
'use strict';

/**
 * dedup-by-tmdb — einmalige Bereinigung doppelter PosterPacks per TMDB-ID (z-20)
 *
 * Hintergrund: Die zwei Emby-Server benennen denselben Film teils unterschiedlich
 * ("Top Gun - Maverick" / "Top Gun: Maverick"). Bis z-19 hielt die Emby-Sync den
 * zweiten Namen für neu — so entstanden doppelte PosterPacks, doppelte Trailer und
 * doppelte Filmlisten-Zeilen, die Filme liefen am Display doppelt so oft. z-20
 * verhindert neue Dubletten (TMDB-Abgleich in lib/emby-sync.js), dieses Script
 * räumt die vorhandenen auf. Es ersetzt scripts/dedup-posterpacks.js: Das änderte
 * die Filmliste nie (Vergleich inkl. [tmdb:N]-Suffix), verlor Trailer beim
 * Umbenennen und folgte driftenden TMDB-Titeln.
 *
 * Prinzipien:
 *  - offline: liest den ZIP-Scan-Cache (metadata.json jedes ZIPs), öffnet kein ZIP
 *    und fragt TMDB nicht
 *  - pro TMDB-ID bleibt ein vorhandener Name; es wird nur gelöscht, nie umbenannt —
 *    einzige Ausnahme: ein Trailer zieht auf den bleibenden Namen um
 *  - "Löschen" heißt Verschieben in eine Quarantäne außerhalb des Projekts, mit
 *    Sicherung aller geänderten Dateien und Manifest für --rollback
 *  - Dry-Run ist Standard; --execute verlangt den Plan-Hash des geprüften Dry-Runs
 */

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const net = require('net');
const { spawnSync } = require('child_process');

const { parseTmdbHint } = require('../lib/zip-tmdb-index');

const ROOT = path.join(__dirname, '..');

const DEFAULT_PATHS = {
    root: ROOT,
    cacheFile: path.join(ROOT, 'cache', 'zip-scan-cache.json'),
    filmListFile: path.join(ROOT, 'poster-updater', 'filmliste.txt'),
    reportFile: path.join(ROOT, 'cache', 'emby-sync-last-report.json'),
    trailerDir: path.join(ROOT, 'media', 'trailers'),
    trailerInfoFile: path.join(ROOT, 'media', 'trailers', 'trailer-info.json'),
    playlistsFile: path.join(ROOT, 'public', 'cinema-playlists.json'),
    livePlaylistFile: path.join(ROOT, 'public', 'cinema-playlist.json'),
    // Außerhalb des Projekts: nicht im Git, nicht im NAS-Mirror, gleiches Dateisystem
    quarantineRoot: path.join(ROOT, '..', 'posterrama-quarantine'),
};

const USAGE = `Aufruf (vom Projekt-Root):
  node scripts/dedup-by-tmdb.js                          Plan anzeigen (Dry-Run)
  node scripts/dedup-by-tmdb.js --json                   Plan als JSON
  node scripts/dedup-by-tmdb.js --keep "Name (Jahr)"     bleibenden Namen erzwingen (mehrfach)
  node scripts/dedup-by-tmdb.js --execute --expect-plan <hash>
                                                         ausführen — Server vorher stoppen
  node scripts/dedup-by-tmdb.js --rollback <quarantäne-verzeichnis>
Weitere Optionen: --max-report-age-hours <n> (Standard 24), --allow-running-server`;

const LABEL_RANK = { 'DE-offiziell': 4, DE: 3, 'EN-offiziell': 2, EN: 1 };

const nfc = value => String(value).normalize('NFC');
const sortDe = list => [...list].sort((a, b) => a.localeCompare(b, 'de'));
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
const zipBaseName = file => nfc(path.basename(file).replace(/\.zip$/i, ''));
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function nameYear(name) {
    const m = /\((\d{4})\)\s*$/.exec(name);
    return m ? m[1] : null;
}

function formatBytes(bytes) {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function readJsonIfExists(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return fallback;
        throw new Error(`${file}: ${err.message}`);
    }
}

function md5File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

async function moveFile(from, to) {
    try {
        await fsp.rename(from, to);
    } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(from, to);
        await fsp.unlink(from);
    }
}

/**
 * Prüft den letzten Emby-Sync-Report und liefert die Emby-Namen mit TMDB-ID.
 * Nur ein Report ab z-20 taugt (tmdbId in jedem skipped-Eintrag): Ältere kennen
 * keine IDs, ein Test-Report ist leer, ein Offline-Report kennt keine Namen.
 */
function validateReport(report, { now = Date.now(), maxAgeHours = 24 } = {}) {
    const fail = reason => ({ ok: false, reason, embyNames: new Map() });
    if (!report || typeof report !== 'object') return fail('kein Emby-Sync-Report vorhanden');
    if (report.trigger === 'test') return fail('Report stammt aus einem Testlauf');
    if (report.result === 'all-offline') return fail('beim letzten Sync waren alle Server offline');
    const finished = Date.parse(report.finishedAt || '');
    if (!Number.isFinite(finished)) return fail('Report ist unvollständig (kein finishedAt)');
    const ageHours = (now - finished) / 3600000;
    if (ageHours > maxAgeHours) {
        return fail(`Report ist ${Math.round(ageHours)} h alt (erlaubt: ${maxAgeHours} h)`);
    }
    const skipped = Array.isArray(report.skipped) ? report.skipped : [];
    if (skipped.length === 0 || !skipped.every(entry => entry && hasOwn(entry, 'tmdbId'))) {
        return fail('Report stammt von vor z-20 (skipped ohne tmdbId) — erst einen Sync abwarten');
    }
    const embyNames = new Map();
    for (const entry of [...skipped, ...(report.added || []), ...(report.ignored || [])]) {
        if (!entry || !entry.key) continue;
        embyNames.set(nfc(entry.key), entry.tmdbId ? String(entry.tmdbId) : null);
    }
    return { ok: true, reason: null, embyNames };
}

/**
 * Liest alle Eingaben. Gruppen = TMDB-IDs mit mindestens zwei vorhandenen ZIPs.
 * md5 wird nur für gleich große Trailer innerhalb einer Gruppe berechnet.
 */
async function loadInputs(paths = DEFAULT_PATHS, { withHashes = true } = {}) {
    const cache = await readJsonIfExists(paths.cacheFile, null);
    if (!cache || typeof cache !== 'object') {
        throw new Error(`ZIP-Scan-Cache fehlt oder ist leer: ${paths.cacheFile}`);
    }
    const filmListLines = (await fsp.readFile(paths.filmListFile, 'utf8'))
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const report = await readJsonIfExists(paths.reportFile, null);
    const trailerInfo = await readJsonIfExists(paths.trailerInfoFile, {});
    const playlists = await readJsonIfExists(paths.playlistsFile, null);
    const livePlaylist = await readJsonIfExists(paths.livePlaylistFile, null);

    // Trailer NFC-tolerant auffinden (vom Mac kopierte Dateien liegen teils in NFD)
    const trailerFiles = new Map();
    try {
        for (const file of await fsp.readdir(paths.trailerDir)) {
            if (/-trailer\.mp4$/i.test(file)) trailerFiles.set(nfc(file), file);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }

    const byId = new Map();
    for (const [zipPath, entry] of Object.entries(cache)) {
        const raw = entry && entry.z ? entry.z.tmdbId : null;
        const tmdbId = raw === null || raw === undefined ? '' : String(raw).trim();
        if (!/^\d+$/.test(tmdbId)) continue;
        if (!byId.has(tmdbId)) byId.set(tmdbId, []);
        byId.get(tmdbId).push({ zipPath, entry });
    }

    const groups = [];
    for (const [tmdbId, list] of byId) {
        if (list.length < 2) continue;
        const members = [];
        for (const { zipPath, entry } of list) {
            let st;
            try {
                st = await fsp.stat(zipPath);
            } catch {
                continue; // veralteter Cache-Eintrag, ZIP existiert nicht mehr
            }
            const name = zipBaseName(zipPath);
            const trailerFile = trailerFiles.get(nfc(`${name}-trailer.mp4`));
            let trailer = null;
            if (trailerFile) {
                const trailerPath = path.join(paths.trailerDir, trailerFile);
                trailer = { path: trailerPath, size: (await fsp.stat(trailerPath)).size };
            }
            const sidecarPath = zipPath.replace(/\.zip$/i, '.poster.json');
            const release = /^(\d{4})/.exec(String((entry.z && entry.z.releaseDate) || ''));
            members.push({
                name,
                zipPath,
                size: st.size,
                mtimeMs: st.mtimeMs,
                cacheMatches: entry.m === st.mtimeMs && entry.s === st.size,
                hasPoster: Boolean(entry.h && entry.h.poster),
                releaseYear: release ? release[1] : null,
                title: (entry.z && entry.z.title) || name,
                sidecarPath: fs.existsSync(sidecarPath) ? sidecarPath : null,
                trailer,
            });
        }
        if (members.length >= 2) groups.push({ tmdbId, members });
    }
    groups.sort((a, b) => String(a.members[0].title).localeCompare(b.members[0].title, 'de'));

    const hashes = new Map();
    if (withHashes) {
        for (const group of groups) {
            const withTrailer = group.members.filter(m => m.trailer);
            for (const m of withTrailer) {
                const sameSize = withTrailer.some(
                    o => o !== m && o.trailer.size === m.trailer.size
                );
                if (sameSize && !hashes.has(m.trailer.path)) {
                    hashes.set(m.trailer.path, await md5File(m.trailer.path));
                }
            }
        }
    }

    return { cache, groups, filmListLines, report, trailerInfo, playlists, livePlaylist, hashes };
}

/**
 * Wählt den bleibenden Namen einer Gruppe. Jede Stufe engt die Kandidaten ein;
 * bleibt genau einer übrig, entscheidet sie.
 */
function pickSurvivor(
    group,
    { keep = new Set(), embyNames = new Map(), filmListNames = new Set() } = {}
) {
    const stages = [
        ['keep', m => keep.has(m.name)],
        // Emby liefert diesen Namen ohne passende TMDB-ID: Die Sync fände ihn nur per
        // Name wieder — gelöscht, würde er beim nächsten Lauf neu geladen.
        ['emby-schutz', m => embyNames.has(m.name) && embyNames.get(m.name) !== group.tmdbId],
        ['poster', m => m.hasPoster],
        ['jahr', m => m.releaseYear !== null && nameYear(m.name) === m.releaseYear],
        ['emby', m => embyNames.get(m.name) === group.tmdbId],
        ['filmliste', m => filmListNames.has(m.name)],
        ['trailer', m => Boolean(m.trailer)],
    ];
    let candidates = group.members;
    for (const [rule, test] of stages) {
        const hits = candidates.filter(test);
        if (hits.length === 1) return { survivor: hits[0], rule };
        if (hits.length > 1) {
            if (rule === 'emby-schutz') {
                return { survivor: null, rule, reason: 'mehrere Emby-Namen ohne passende TMDB-ID' };
            }
            candidates = hits;
        }
    }
    const maxSize = Math.max(...candidates.map(m => m.size));
    const largest = candidates.filter(m => m.size === maxSize);
    if (largest.length === 1) return { survivor: largest[0], rule: 'größe' };
    const [first] = [...largest].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return { survivor: first, rule: 'alphabetisch' };
}

/** Trailer-Entscheidungen einer Gruppe: identische Kopie weg, Umzug, besseres Label. */
function planTrailerActions(
    survivor,
    losers,
    { trailerInfo = {}, hashes = new Map(), trailerDir }
) {
    const actions = [];
    const remove = [];
    const set = {};
    const summary = [];
    const targetPath = path.join(trailerDir, `${survivor.name}-trailer.mp4`);
    let current = survivor.trailer
        ? { ...survivor.trailer, md5: hashes.get(survivor.trailer.path) || null }
        : null;
    let currentLabel = trailerInfo[survivor.name] || null;

    for (const loser of losers) {
        const loserLabel = trailerInfo[loser.name] || null;
        if (hasOwn(trailerInfo, loser.name)) remove.push(loser.name);
        if (!loser.trailer) continue;
        const loserMd5 = hashes.get(loser.trailer.path) || null;

        if (!current) {
            actions.push({
                type: 'rename',
                kind: 'trailer',
                from: loser.trailer.path,
                to: targetPath,
            });
            current = { path: targetPath, size: loser.trailer.size, md5: loserMd5 };
            if (loserLabel && !currentLabel) {
                currentLabel = loserLabel;
                set[survivor.name] = loserLabel;
            }
            summary.push('Trailer vom gelöschten Namen übernommen');
            continue;
        }
        if (current.size === loser.trailer.size && current.md5 && current.md5 === loserMd5) {
            actions.push({
                type: 'quarantine',
                kind: 'trailer',
                from: loser.trailer.path,
                size: loser.trailer.size,
            });
            if (loserLabel && !currentLabel) {
                currentLabel = loserLabel;
                set[survivor.name] = loserLabel;
            }
            summary.push('identische Trailer-Kopie entfernt');
            continue;
        }
        if ((LABEL_RANK[loserLabel] || 0) > (LABEL_RANK[currentLabel] || 0)) {
            actions.push({
                type: 'quarantine',
                kind: 'trailer',
                from: current.path,
                size: current.size,
            });
            actions.push({
                type: 'rename',
                kind: 'trailer',
                from: loser.trailer.path,
                to: targetPath,
            });
            summary.push(`${loserLabel}-Trailer ersetzt ${currentLabel || 'Trailer ohne Label'}`);
            current = { path: targetPath, size: loser.trailer.size, md5: loserMd5 };
            currentLabel = loserLabel;
            set[survivor.name] = loserLabel;
        } else {
            actions.push({
                type: 'quarantine',
                kind: 'trailer',
                from: loser.trailer.path,
                size: loser.trailer.size,
            });
            summary.push(`abweichender Trailer entfernt (${currentLabel || 'ohne Label'} bleibt)`);
        }
    }
    return { actions, remove, set, summary };
}

/**
 * Neue Filmliste: pro Gruppe genau eine Zeile "Überlebender[tmdb:N]", gelöschte
 * Namen raus, wortgleiche Doppelzeilen raus; alle übrigen Zeilen bleiben bytegleich.
 */
function rewriteFilmList(
    lines,
    { survivorById = new Map(), nameMap = new Map(), zipNames = new Set() } = {}
) {
    const survivors = new Set(survivorById.values());
    const byId = new Map();
    for (const [tmdbId, name] of survivorById) byId.set(tmdbId, `${name}[tmdb:${tmdbId}]`);
    const plain = new Set();
    for (const line of lines) {
        const { name, tmdbId } = parseTmdbHint(line);
        if (nameMap.has(name)) continue; // gelöschter Name, mit oder ohne Hint
        if (!tmdbId) {
            if (!survivors.has(name)) plain.add(line);
            continue;
        }
        if (survivorById.has(tmdbId)) continue; // Überlebenden-Zeile steht schon
        const current = byId.get(tmdbId);
        if (!current) byId.set(tmdbId, line);
        // Zweite Zeile derselben ID ohne ZIP-Gruppe: die mit vorhandenem ZIP gewinnt
        else if (!zipNames.has(parseTmdbHint(current).name) && zipNames.has(name)) {
            byId.set(tmdbId, line);
        }
    }
    const hintedNames = new Set([...byId.values()].map(line => parseTmdbHint(line).name));
    const keptPlain = [...plain].filter(line => !hintedNames.has(parseTmdbHint(line).name));
    return sortDe([...byId.values(), ...keptPlain]);
}

/**
 * Playlist-Einträge gelöschter Namen auf den Überlebenden umlenken. Dabei entstehende
 * Doppel werden entfernt, bereits vorhandene fremde Doppel bleiben unangetastet.
 */
function rewritePlaylists(collection, live, nameMap) {
    const survivors = new Set([...nameMap.values()].map(nfc));
    const mapTitles = titles => {
        const out = [];
        const seen = new Set();
        let changes = 0;
        for (const title of Array.isArray(titles) ? titles : []) {
            const mapped = nameMap.get(nfc(title));
            const value = mapped || title;
            if (mapped) changes++;
            const key = nfc(value);
            if (seen.has(key) && survivors.has(key)) {
                changes++;
                continue;
            }
            seen.add(key);
            out.push(value);
        }
        return { titles: out, changes };
    };

    const result = { collection: null, live: null, changedEntries: 0, changedPlaylists: [] };
    if (collection && collection.playlists && typeof collection.playlists === 'object') {
        const next = JSON.parse(JSON.stringify(collection));
        for (const [id, playlist] of Object.entries(next.playlists)) {
            if (!playlist || !Array.isArray(playlist.titles)) continue;
            const { titles, changes } = mapTitles(playlist.titles);
            if (changes === 0) continue;
            playlist.titles = titles;
            result.changedEntries += changes;
            result.changedPlaylists.push(id);
        }
        if (result.changedPlaylists.length > 0) result.collection = next;
    }
    if (live && Array.isArray(live.titles)) {
        const { titles, changes } = mapTitles(live.titles);
        if (changes > 0) result.live = { ...live, titles };
    }
    return result;
}

/** trailer-info.json neu, Schlüssel sortiert wie beim Python-Script (sort_keys). */
function rewriteTrailerInfo(info, { remove = [], set = {} } = {}) {
    const next = { ...(info || {}) };
    let removed = 0;
    let changed = false;
    for (const key of remove) {
        if (hasOwn(next, key)) {
            delete next[key];
            removed++;
            changed = true;
        }
    }
    for (const [key, label] of Object.entries(set)) {
        if (next[key] !== label) {
            next[key] = label;
            changed = true;
        }
    }
    if (!changed) return { info: null, removed: 0 };
    const sorted = {};
    for (const key of Object.keys(next).sort()) sorted[key] = next[key];
    return { info: sorted, removed };
}

function buildDedupPlan(inputs, { keep = [], paths = DEFAULT_PATHS, reportCheck } = {}) {
    const check = reportCheck || validateReport(inputs.report);
    const keepSet = new Set(keep.map(nfc));
    const filmListNames = new Set(inputs.filmListLines.map(line => parseTmdbHint(line).name));
    const warnings = check.ok
        ? []
        : [
              `Emby-Report nicht verwendbar (${check.reason}) — Emby-Regeln entfallen, --execute gesperrt`,
          ];
    const groups = [];
    const actions = [];
    const nameMap = new Map();
    const survivorById = new Map();
    const cacheKeysRemoved = [];
    const trailerInfoRemove = [];
    const trailerInfoSet = {};

    for (const group of inputs.groups) {
        const pick = pickSurvivor(group, {
            keep: keepSet,
            embyNames: check.embyNames,
            filmListNames,
        });
        if (!pick.survivor) {
            const names = group.members.map(m => m.name).join(' / ');
            warnings.push(`TMDB ${group.tmdbId} übersprungen (${pick.reason}): ${names}`);
            continue;
        }
        const survivor = pick.survivor;
        const losers = group.members.filter(m => m !== survivor);
        survivorById.set(group.tmdbId, survivor.name);

        const groupActions = [];
        for (const loser of losers) {
            nameMap.set(loser.name, survivor.name);
            groupActions.push({
                type: 'quarantine',
                kind: 'zip',
                from: loser.zipPath,
                size: loser.size,
            });
            if (loser.sidecarPath) {
                groupActions.push({
                    type: 'quarantine',
                    kind: 'sidecar',
                    from: loser.sidecarPath,
                    size: 0,
                });
            }
            cacheKeysRemoved.push(loser.zipPath);
        }
        const trailers = planTrailerActions(survivor, losers, {
            trailerInfo: inputs.trailerInfo,
            hashes: inputs.hashes,
            trailerDir: paths.trailerDir,
        });
        groupActions.push(...trailers.actions);
        trailerInfoRemove.push(...trailers.remove);
        Object.assign(trailerInfoSet, trailers.set);
        actions.push(...groupActions);

        groups.push({
            tmdbId: group.tmdbId,
            title: survivor.title,
            survivor: survivor.name,
            losers: losers.map(l => l.name),
            rule: pick.rule,
            trailer:
                trailers.summary.join('; ') ||
                (survivor.trailer ? 'Trailer bleibt' : 'kein Trailer'),
            bytes: groupActions
                .filter(a => a.type === 'quarantine')
                .reduce((sum, a) => sum + (a.size || 0), 0),
            cacheStale: group.members.some(m => !m.cacheMatches),
        });
    }

    const zipNames = new Set(
        Object.keys(inputs.cache || {})
            .map(zipBaseName)
            .filter(name => !nameMap.has(name))
    );
    const filmListLines = rewriteFilmList(inputs.filmListLines, {
        survivorById,
        nameMap,
        zipNames,
    });
    const playlists = rewritePlaylists(inputs.playlists, inputs.livePlaylist, nameMap);
    const trailerInfo = rewriteTrailerInfo(inputs.trailerInfo, {
        remove: trailerInfoRemove,
        set: trailerInfoSet,
    });

    // Nachbedingungen — verletzt, sperren sie --execute
    const errors = [];
    const parsed = filmListLines.map(parseTmdbHint);
    const idCounts = new Map();
    for (const { tmdbId } of parsed) {
        if (tmdbId) idCounts.set(tmdbId, (idCounts.get(tmdbId) || 0) + 1);
    }
    const duplicateIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => id);
    if (duplicateIds.length > 0) {
        errors.push(`Filmliste enthielte weiter doppelte TMDB-IDs: ${duplicateIds.join(', ')}`);
    }
    const leftovers = parsed.filter(p => nameMap.has(p.name)).map(p => p.name);
    if (leftovers.length > 0) {
        errors.push(`Filmliste enthielte gelöschte Namen: ${leftovers.join(', ')}`);
    }
    const stale = groups.filter(g => g.cacheStale).map(g => g.survivor);
    if (stale.length > 0) {
        errors.push(`ZIP-Scan-Cache veraltet für: ${stale.join(', ')} — Playlist-Refresh abwarten`);
    }

    const hash = sha256(
        JSON.stringify({
            groups: groups.map(g => [g.tmdbId, g.survivor, g.losers, g.rule]),
            actions,
            filmListLines,
            trailerInfoRemove,
            trailerInfoSet,
            playlists: playlists.changedPlaylists,
            live: Boolean(playlists.live),
            cacheKeysRemoved,
        })
    ).slice(0, 12);

    return {
        hash,
        reportOk: check.ok,
        reportReason: check.reason,
        warnings,
        errors,
        groups,
        actions,
        cacheKeysRemoved,
        filmList: {
            before: inputs.filmListLines.length,
            after: filmListLines.length,
            lines: filmListLines,
        },
        trailerInfo: { removed: trailerInfo.removed, set: trailerInfoSet, next: trailerInfo.info },
        playlists,
        bytesToQuarantine: actions
            .filter(a => a.type === 'quarantine')
            .reduce((sum, a) => sum + (a.size || 0), 0),
    };
}

/** Plan ohne Dateiinhalte — für --json und plan.json in der Quarantäne. */
function summarizePlan(plan) {
    return {
        hash: plan.hash,
        reportOk: plan.reportOk,
        reportReason: plan.reportReason,
        warnings: plan.warnings,
        errors: plan.errors,
        groups: plan.groups,
        actions: plan.actions,
        cacheKeysRemoved: plan.cacheKeysRemoved.length,
        filmList: { before: plan.filmList.before, after: plan.filmList.after },
        trailerInfo: { removed: plan.trailerInfo.removed, set: plan.trailerInfo.set },
        playlists: {
            changedEntries: plan.playlists.changedEntries,
            changedPlaylists: plan.playlists.changedPlaylists,
            liveChanged: Boolean(plan.playlists.live),
        },
        bytesToQuarantine: plan.bytesToQuarantine,
    };
}

function printPlan(plan, log = console.log) {
    const zipCount = plan.actions.filter(a => a.kind === 'zip').length;
    log(
        `TMDB-Dubletten: ${plan.groups.length} Filme · ${zipCount} PosterPacks in Quarantäne · ` +
            `${formatBytes(plan.bytesToQuarantine)}`
    );
    plan.groups.forEach((g, i) => {
        log(`\n${String(i + 1).padStart(3)}. ${g.title}  (TMDB ${g.tmdbId})`);
        log(`     bleibt:  ${g.survivor}   [Regel: ${g.rule}]`);
        for (const loser of g.losers) log(`     weg:     ${loser}`);
        log(`     Trailer: ${g.trailer}`);
    });
    const rules = {};
    for (const g of plan.groups) rules[g.rule] = (rules[g.rule] || 0) + 1;
    log('');
    log(`Filmliste:    ${plan.filmList.before} → ${plan.filmList.after} Zeilen`);
    log(
        `Playlists:    ${plan.playlists.changedEntries} Einträge in ` +
            `${plan.playlists.changedPlaylists.length} Listen` +
            (plan.playlists.live ? ' (dazu die Live-Playlist)' : '')
    );
    log(
        `trailer-info: ${plan.trailerInfo.removed} Einträge entfernt, ` +
            `${Object.keys(plan.trailerInfo.set).length} übernommen`
    );
    log(`Scan-Cache:   ${plan.cacheKeysRemoved.length} Einträge entfernt`);
    log(
        `Regeln:       ${Object.entries(rules)
            .map(([rule, n]) => `${rule} ${n}`)
            .join(' · ')}`
    );
    for (const warning of plan.warnings) log(`⚠️  ${warning}`);
    for (const error of plan.errors) log(`❌ ${error}`);
    log(`Plan-Hash:    ${plan.hash}`);
}

function runningPipelineJobs() {
    const result = spawnSync(
        'pgrep',
        ['-af', 'poster-updater/(tmdb-get-posters-direct|download-trailers|fetch-)'],
        { encoding: 'utf8' }
    );
    return result.status === 0 ? result.stdout.trim() : '';
}

function readServerPort(root) {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
        return Number(cfg.serverPort) || 4000;
    } catch {
        return 4000;
    }
}

function serverReachable(port, host = '127.0.0.1', timeoutMs = 1000) {
    return new Promise(resolve => {
        const socket = net.createConnection({ port, host });
        const done = reachable => {
            socket.destroy();
            resolve(reachable);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

async function executePlan(plan, inputs, paths = DEFAULT_PATHS, options = {}) {
    const {
        expectPlan,
        allowRunningServer = false,
        checkJobs = runningPipelineJobs,
        checkServer = () => serverReachable(readServerPort(paths.root)),
        now = new Date(),
    } = options;

    if (!expectPlan || expectPlan !== plan.hash) {
        throw new Error(
            `Plan-Hash passt nicht (--expect-plan ${expectPlan || 'fehlt'}, aktuell ${plan.hash}) — ` +
                'Dry-Run erneut prüfen'
        );
    }
    if (!plan.reportOk) throw new Error(`Emby-Report nicht verwendbar: ${plan.reportReason}`);
    if (plan.errors.length > 0) throw new Error(`Plan nicht ausführbar: ${plan.errors.join('; ')}`);
    const jobs = checkJobs();
    if (jobs) throw new Error(`Pipeline-Job läuft noch:\n${jobs}`);
    if (!allowRunningServer && (await checkServer())) {
        throw new Error(
            'Posterrama-Server läuft — erst "pm2 stop posterrama", danach wieder starten'
        );
    }

    const nothingToDo =
        plan.actions.length === 0 &&
        !plan.playlists.collection &&
        !plan.playlists.live &&
        !plan.trailerInfo.next &&
        plan.filmList.before === plan.filmList.after;
    if (nothingToDo) return { quarantineDir: null, moved: 0 };

    for (const action of plan.actions) {
        if (!fs.existsSync(action.from)) throw new Error(`Datei fehlt inzwischen: ${action.from}`);
        if (
            action.type === 'quarantine' &&
            path.relative(paths.root, action.from).startsWith('..')
        ) {
            throw new Error(`Datei liegt außerhalb des Projekts: ${action.from}`);
        }
    }

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const quarantineDir = path.join(paths.quarantineRoot, `dedup-tmdb-${stamp}`);
    await fsp.mkdir(path.join(quarantineDir, 'backup'), { recursive: true });
    const manifest = {
        createdAt: now.toISOString(),
        planHash: plan.hash,
        root: paths.root,
        moves: [],
        files: [],
    };
    const saveManifest = () =>
        fsp.writeFile(
            path.join(quarantineDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2) + '\n',
            'utf8'
        );

    const targets = [
        ['filmliste', paths.filmListFile],
        ['trailer-info', paths.trailerInfoFile],
        ['cinema-playlists', paths.playlistsFile],
        ['cinema-playlist', paths.livePlaylistFile],
        ['zip-scan-cache', paths.cacheFile],
    ];
    for (const [key, file] of targets) {
        if (!fs.existsSync(file)) continue;
        const backup = path.join(quarantineDir, 'backup', `${key}${path.extname(file)}`);
        await fsp.copyFile(file, backup);
        manifest.files.push({ key, file, backup, writtenSha256: null });
    }
    await fsp.writeFile(
        path.join(quarantineDir, 'plan.json'),
        JSON.stringify(summarizePlan(plan), null, 2) + '\n',
        'utf8'
    );
    await saveManifest();

    const writeAtomic = async (file, content) => {
        const tmp = `${file}.dedup-${process.pid}.tmp`;
        await fsp.writeFile(tmp, content, 'utf8');
        await fsp.rename(tmp, file);
        const entry = manifest.files.find(f => f.file === file);
        if (entry) entry.writtenSha256 = sha256(content);
    };

    try {
        for (const action of plan.actions) {
            const to =
                action.type === 'quarantine'
                    ? path.join(quarantineDir, 'files', path.relative(paths.root, action.from))
                    : action.to;
            if (fs.existsSync(to)) throw new Error(`Ziel existiert bereits: ${to}`);
            await fsp.mkdir(path.dirname(to), { recursive: true });
            await moveFile(action.from, to);
            manifest.moves.push({ kind: action.kind, from: action.from, to });
            await saveManifest();
        }

        await writeAtomic(paths.filmListFile, plan.filmList.lines.join('\n') + '\n');
        if (plan.trailerInfo.next) {
            // wie download-trailers.py: indent 2, ohne abschließenden Zeilenumbruch
            await writeAtomic(
                paths.trailerInfoFile,
                JSON.stringify(plan.trailerInfo.next, null, 2)
            );
        }
        if (plan.playlists.collection) {
            await writeAtomic(
                paths.playlistsFile,
                JSON.stringify(plan.playlists.collection, null, 2) + '\n'
            );
        }
        if (plan.playlists.live) {
            await writeAtomic(
                paths.livePlaylistFile,
                JSON.stringify(plan.playlists.live, null, 2) + '\n'
            );
        }
        const cache = JSON.parse(await fsp.readFile(paths.cacheFile, 'utf8'));
        for (const key of plan.cacheKeysRemoved) delete cache[key];
        await writeAtomic(paths.cacheFile, JSON.stringify(cache));
        await saveManifest();
    } catch (err) {
        err.message +=
            `\n   Teilweise ausgeführt — rückgängig: ` +
            `node scripts/dedup-by-tmdb.js --rollback "${quarantineDir}"`;
        throw err;
    }

    return { quarantineDir, moved: manifest.moves.length };
}

async function rollback(quarantineDir, { log = console.log } = {}) {
    const manifest = JSON.parse(
        await fsp.readFile(path.join(quarantineDir, 'manifest.json'), 'utf8')
    );
    const problems = [];
    let restored = 0;
    for (const move of [...manifest.moves].reverse()) {
        if (!fs.existsSync(move.to)) {
            problems.push(`fehlt: ${move.to}`);
            continue;
        }
        if (fs.existsSync(move.from)) {
            problems.push(`Ursprungsort belegt: ${move.from}`);
            continue;
        }
        await fsp.mkdir(path.dirname(move.from), { recursive: true });
        await moveFile(move.to, move.from);
        restored++;
    }
    for (const file of manifest.files) {
        if (file.writtenSha256 && fs.existsSync(file.file)) {
            const current = sha256(await fsp.readFile(file.file));
            if (current !== file.writtenSha256) {
                log(
                    `⚠️  ${path.basename(file.file)} wurde nach der Bereinigung geändert — wird zurückgesetzt`
                );
            }
        }
        await fsp.copyFile(file.backup, file.file);
    }
    return { restored, filesRestored: manifest.files.length, problems };
}

function parseArgs(argv) {
    const args = {
        execute: false,
        json: false,
        keep: [],
        expectPlan: null,
        rollback: null,
        allowRunningServer: false,
        maxReportAgeHours: 24,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} braucht einen Wert`);
            return argv[++i];
        };
        if (arg === '--execute') args.execute = true;
        else if (arg === '--json') args.json = true;
        else if (arg === '--allow-running-server') args.allowRunningServer = true;
        else if (arg === '--keep') args.keep.push(value());
        else if (arg === '--expect-plan') args.expectPlan = value();
        else if (arg === '--rollback') args.rollback = value();
        else if (arg === '--max-report-age-hours') args.maxReportAgeHours = Number(value());
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`Unbekannte Option: ${arg}`);
    }
    return args;
}

async function main(argv, { paths = DEFAULT_PATHS, log = console.log } = {}) {
    const args = parseArgs(argv);
    if (args.help) {
        log(USAGE);
        return 0;
    }
    if (args.rollback) {
        const result = await rollback(path.resolve(args.rollback), { log });
        log(
            `Rollback: ${result.restored} Dateien zurückverschoben, ` +
                `${result.filesRestored} Dateien wiederhergestellt`
        );
        for (const problem of result.problems) log(`⚠️  ${problem}`);
        return result.problems.length > 0 ? 1 : 0;
    }

    const inputs = await loadInputs(paths);
    const reportCheck = validateReport(inputs.report, { maxAgeHours: args.maxReportAgeHours });
    const plan = buildDedupPlan(inputs, { keep: args.keep, paths, reportCheck });
    if (args.json) log(JSON.stringify(summarizePlan(plan), null, 2));
    else printPlan(plan, log);

    if (!args.execute) {
        if (!args.json) {
            log(
                '\nDRY-RUN — nichts geändert. Ausführen (Server gestoppt):\n' +
                    `  node scripts/dedup-by-tmdb.js --execute --expect-plan ${plan.hash}`
            );
        }
        return 0;
    }
    const result = await executePlan(plan, inputs, paths, {
        expectPlan: args.expectPlan,
        allowRunningServer: args.allowRunningServer,
    });
    if (!result.quarantineDir) {
        log('Nichts zu tun.');
        return 0;
    }
    log(`\n✅ Bereinigt: ${result.moved} Dateien in die Quarantäne bzw. umbenannt`);
    log(`   Quarantäne: ${result.quarantineDir}`);
    log(`   Rückgängig: node scripts/dedup-by-tmdb.js --rollback "${result.quarantineDir}"`);
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(
        code => {
            process.exitCode = code;
        },
        err => {
            console.error(`❌ ${err.message}`);
            process.exitCode = 1;
        }
    );
}

module.exports = {
    DEFAULT_PATHS,
    validateReport,
    loadInputs,
    pickSurvivor,
    planTrailerActions,
    rewriteFilmList,
    rewritePlaylists,
    rewriteTrailerInfo,
    buildDedupPlan,
    summarizePlan,
    executePlan,
    rollback,
    parseArgs,
    main,
};
