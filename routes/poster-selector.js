'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const PLAYLIST_PATH = path.join(__dirname, '..', 'public', 'cinema-playlist.json');
const COMPLETE_DIR = path.join(__dirname, '..', 'media', 'complete');

module.exports = function createPosterSelectorRouter({ logger, wsHub }) {
    const router = express.Router();

    // --- Helper: read playlist JSON ---
    async function readPlaylist() {
        try {
            const raw = await fsp.readFile(PLAYLIST_PATH, 'utf8');
            const data = JSON.parse(raw);
            return {
                enabled: !!data.enabled,
                titles: Array.isArray(data.titles) ? data.titles : [],
            };
        } catch (err) {
            if (err.code === 'ENOENT') return { enabled: false, titles: [] };
            throw err;
        }
    }

    // --- Helper: write playlist JSON ---
    async function writePlaylist(data) {
        const json = JSON.stringify({ enabled: !!data.enabled, titles: data.titles }, null, 2) + '\n';
        await fsp.writeFile(PLAYLIST_PATH, json, 'utf8');
    }

    // --- Helper: broadcast playlist refresh to all connected displays ---
    function broadcastPlaylistRefresh() {
        try {
            if (wsHub && typeof wsHub.broadcast === 'function') {
                wsHub.broadcast({ kind: 'command', type: 'playlist.refresh' });
            }
        } catch (err) {
            logger.warn('poster-selector: Failed to broadcast playlist refresh:', err.message);
        }
    }

    // --- Helper: recursively find all .zip files under a directory ---
    async function findZips(dir, baseDir) {
        const results = [];
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (err.code === 'ENOENT') return results;
            throw err;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const sub = await findZips(fullPath, baseDir);
                results.push(...sub);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip') && !entry.name.startsWith('._')) {
                const name = entry.name.replace(/\.zip$/i, '');
                const relative = path.relative(baseDir, dir);
                results.push({ name, source: relative || '.' });
            }
        }
        return results;
    }

    // ============================================================
    // GET /films — list all available ZIP films
    // ============================================================
    router.get('/films', async (req, res) => {
        try {
            const films = await findZips(COMPLETE_DIR, COMPLETE_DIR);
            films.sort((a, b) => a.name.localeCompare(b.name, 'de'));
            res.json({ films, total: films.length });
        } catch (err) {
            logger.error('poster-selector: Failed to list films:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // GET /playlist — read current playlist
    // ============================================================
    router.get('/playlist', async (req, res) => {
        try {
            const playlist = await readPlaylist();
            res.json(playlist);
        } catch (err) {
            logger.error('poster-selector: Failed to read playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // PUT /playlist — save complete playlist
    // ============================================================
    router.put('/playlist', express.json(), async (req, res) => {
        const { enabled, titles } = req.body || {};
        if (!Array.isArray(titles)) {
            return res.status(400).json({ success: false, error: 'titles must be an array' });
        }
        try {
            const data = { enabled: !!enabled, titles };
            await writePlaylist(data);
            broadcastPlaylistRefresh();
            res.json({ success: true, ...data });
        } catch (err) {
            logger.error('poster-selector: Failed to save playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // PUT /playlist/toggle — toggle enabled status
    // ============================================================
    router.put('/playlist/toggle', express.json(), async (req, res) => {
        const { enabled } = req.body || {};
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
        }
        try {
            const playlist = await readPlaylist();
            playlist.enabled = enabled;
            await writePlaylist(playlist);
            broadcastPlaylistRefresh();
            res.json({ success: true, enabled: playlist.enabled });
        } catch (err) {
            logger.error('poster-selector: Failed to toggle playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
