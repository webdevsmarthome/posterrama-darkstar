'use strict';

/**
 * emby-sync HTTP router
 *
 * Endpunkte für manuelle Trigger, Status, Report und Ignore-Liste-CRUD.
 * Hinter isAuthenticated (gemountet in server.js).
 */

const express = require('express');

const embySync = require('../lib/emby-sync');

// Class-internal Properties + Backing-Fields, die niemals in config.json gehören.
// Werden beim Save abgestrippt — räumt korrupte config.json sukzessive selbst auf.
const CLASS_INTERNAL_KEYS = new Set(['env', 'defaults', 'timeouts', 'config']);

/**
 * Liefert ein sauberes raw-Config-Object aus der Config-Class-Instance:
 * - Nimmt config.config (das raw-Object aus loadConfig) als Quelle, statt JSON.stringify(config)
 *   was die Class-Instance mit allen Backing-Fields serialisieren würde.
 * - Strippt _xxx-Keys (Class-Backing-Fields wie _embySync, _mediaServers).
 * - Strippt env/defaults/timeouts/config (Class-Properties, die in alten korrupten Saves
 *   versehentlich Top-Level gelandet sind).
 */
function buildCleanRawConfig(config) {
    const source = config.config || config;
    const raw = JSON.parse(JSON.stringify(source));
    for (const k of Object.keys(raw)) {
        if (k.startsWith('_') || CLASS_INTERNAL_KEYS.has(k)) {
            delete raw[k];
        }
    }
    return raw;
}

module.exports = function createEmbySyncRouter({ logger, config, wsHub, writeConfig }) {
    const router = express.Router();

    // ============================================================
    // POST /run — manueller Trigger
    // ============================================================
    router.post('/run', (req, res) => {
        const status = embySync.getStatus(config);
        if (status.running) {
            return res.status(409).json({
                success: false,
                error: 'Sync läuft bereits',
                status: '/api/emby-sync/status',
            });
        }
        // feuer-und-vergiss; der Client kann /status oder /last-report pollen
        embySync
            .runSyncCycle({ logger, config, wsHub, trigger: 'manual' })
            .then(report => {
                logger.info(
                    `[EmbySync] Manueller Lauf abgeschlossen — added=${report.added.length}, skipped=${report.skipped.length}, ignored=${report.ignored.length}`
                );
            })
            .catch(err => {
                if (err && err.code === 'ALREADY_RUNNING') return;
                logger.error(`[EmbySync] Manueller Lauf fehlgeschlagen: ${err.message}`);
            });
        res.status(202).json({ success: true, queued: true });
    });

    // ============================================================
    // GET /status
    // ============================================================
    router.get('/status', (req, res) => {
        res.json(embySync.getStatus(config));
    });

    // ============================================================
    // GET /last-report
    // ============================================================
    router.get('/last-report', async (req, res) => {
        try {
            const report = await embySync.readLastReport();
            if (!report) {
                return res
                    .status(404)
                    .json({ success: false, error: 'Noch kein Sync gelaufen' });
            }
            res.json(report);
        } catch (err) {
            logger.error('[EmbySync] Failed to read last report:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // GET /last-report/download — wie /last-report, aber als Download mit Filename
    router.get('/last-report/download', async (req, res) => {
        try {
            const report = await embySync.readLastReport();
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="emby-sync-report-${ts}.json"`
            );
            res.send(JSON.stringify(report || { error: 'no-report-yet' }, null, 2));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /ignored — Liste der Ignore-Regeln
    // ============================================================
    router.get('/ignored', (req, res) => {
        const items = (config.embySync && config.embySync.ignoredMovies) || [];
        res.json({ items });
    });

    // ============================================================
    // POST /ignored — Regel hinzufügen
    //   Body: {title?, year?, imdbId?, tmdbId?, reason?}
    //   Mindestens eines von {title+year} | {imdbId} | {tmdbId} muss gegeben sein.
    // ============================================================
    router.post('/ignored', express.json(), async (req, res) => {
        const { title, year, imdbId, tmdbId, reason } = req.body || {};
        const rule = {};
        if (title && year) {
            const yearNum = Number(year);
            if (!Number.isInteger(yearNum) || yearNum < 1800 || yearNum > 2100) {
                return res
                    .status(400)
                    .json({ success: false, error: 'year muss eine Jahreszahl sein' });
            }
            rule.title = String(title).trim();
            rule.year = yearNum;
        }
        if (imdbId) rule.imdbId = String(imdbId).trim();
        if (tmdbId) rule.tmdbId = String(tmdbId).trim();
        if (reason) rule.reason = String(reason).trim();

        const hasIdentifier = rule.imdbId || rule.tmdbId || (rule.title && rule.year);
        if (!hasIdentifier) {
            return res.status(400).json({
                success: false,
                error: 'Regel braucht title+year ODER imdbId ODER tmdbId',
            });
        }

        try {
            const rawConfig = buildCleanRawConfig(config);
            rawConfig.embySync = rawConfig.embySync || {};
            rawConfig.embySync.ignoredMovies = Array.isArray(rawConfig.embySync.ignoredMovies)
                ? rawConfig.embySync.ignoredMovies
                : [];
            rawConfig.embySync.ignoredMovies.push(rule);
            await writeConfig(rawConfig, config);
            config.embySync = rawConfig.embySync;
            res.json({ success: true, items: rawConfig.embySync.ignoredMovies });
        } catch (err) {
            logger.error('[EmbySync] Failed to add ignore rule:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // DELETE /ignored/:index — Regel entfernen (by Array-Index)
    // ============================================================
    router.delete('/ignored/:index', async (req, res) => {
        const idx = parseInt(req.params.index, 10);
        const items = (config.embySync && config.embySync.ignoredMovies) || [];
        if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
            return res.status(404).json({ success: false, error: 'Index nicht gefunden' });
        }
        try {
            const rawConfig = buildCleanRawConfig(config);
            rawConfig.embySync = rawConfig.embySync || {};
            rawConfig.embySync.ignoredMovies = Array.isArray(rawConfig.embySync.ignoredMovies)
                ? rawConfig.embySync.ignoredMovies
                : [];
            rawConfig.embySync.ignoredMovies.splice(idx, 1);
            await writeConfig(rawConfig, config);
            config.embySync = rawConfig.embySync;
            res.json({ success: true, items: rawConfig.embySync.ignoredMovies });
        } catch (err) {
            logger.error('[EmbySync] Failed to remove ignore rule:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
