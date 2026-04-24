'use strict';

/**
 * emby-sync HTTP router
 *
 * Endpunkte für manuelle Trigger, Status, Report und Ignore-Liste-CRUD.
 * Hinter isAuthenticated (gemountet in server.js).
 */

const express = require('express');

const embySync = require('../lib/emby-sync');

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
            // Clone config, ignoredMovies-Array um die neue Regel erweitern
            const newConfig = JSON.parse(JSON.stringify(config));
            newConfig.embySync = newConfig.embySync || {};
            newConfig.embySync.ignoredMovies = Array.isArray(
                newConfig.embySync.ignoredMovies
            )
                ? newConfig.embySync.ignoredMovies
                : [];
            newConfig.embySync.ignoredMovies.push(rule);
            await writeConfig(newConfig, config);
            // In-Memory aktualisieren
            config.embySync = config.embySync || {};
            config.embySync.ignoredMovies = newConfig.embySync.ignoredMovies;
            res.json({ success: true, items: config.embySync.ignoredMovies });
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
            const newConfig = JSON.parse(JSON.stringify(config));
            newConfig.embySync.ignoredMovies.splice(idx, 1);
            await writeConfig(newConfig, config);
            config.embySync.ignoredMovies = newConfig.embySync.ignoredMovies;
            res.json({ success: true, items: config.embySync.ignoredMovies });
        } catch (err) {
            logger.error('[EmbySync] Failed to remove ignore rule:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
