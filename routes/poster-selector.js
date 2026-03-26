'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const PLAYLIST_PATH = path.join(__dirname, '..', 'public', 'cinema-playlist.json');
const PLAYLISTS_PATH = path.join(__dirname, '..', 'public', 'cinema-playlists.json');
const COMPLETE_DIR = path.join(__dirname, '..', 'media', 'complete');
const TRAILER_DIR = path.join(__dirname, '..', 'media', 'trailers');
const TRAILER_INFO_PATH = path.join(TRAILER_DIR, 'trailer-info.json');

module.exports = function createPosterSelectorRouter({ logger, wsHub }) {
    const router = express.Router();

    // --- Helper: read live playlist JSON (used by displays) ---
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

    // --- Helper: write live playlist JSON ---
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

    // ============================================================
    // Playlists collection helpers
    // ============================================================

    function generateId(name, existingIds) {
        let base = String(name).toLowerCase()
            .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/[ß]/g, 'ss')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'playlist';
        let id = base;
        let n = 2;
        while (existingIds.includes(id)) {
            id = base + '-' + n;
            n++;
        }
        return id;
    }

    async function readPlaylists() {
        try {
            const raw = await fsp.readFile(PLAYLISTS_PATH, 'utf8');
            const data = JSON.parse(raw);
            if (data && typeof data.playlists === 'object') return data;
        } catch (err) {
            if (err.code !== 'ENOENT') {
                logger.warn('poster-selector: Failed to read playlists collection, migrating:', err.message);
            }
        }
        // Migration: create collection from existing single playlist
        const live = await readPlaylist();
        const now = new Date().toISOString();
        const collection = {
            activePlaylistId: 'standard',
            playlists: {
                standard: {
                    name: 'Standard',
                    titles: live.titles || [],
                    createdAt: now,
                    updatedAt: now,
                },
            },
        };
        await writePlaylists(collection);
        logger.info('poster-selector: Migrated single playlist to collection (Standard)');
        return collection;
    }

    async function writePlaylists(data) {
        const json = JSON.stringify(data, null, 2) + '\n';
        await fsp.writeFile(PLAYLISTS_PATH, json, 'utf8');
    }

    // Sync active playlist titles to the live cinema-playlist.json
    async function syncActiveToLive(collection) {
        const activeId = collection.activePlaylistId;
        const live = await readPlaylist();
        if (activeId && collection.playlists[activeId]) {
            live.titles = collection.playlists[activeId].titles;
        } else {
            live.titles = [];
        }
        await writePlaylist(live);
        broadcastPlaylistRefresh();
    }

    // ============================================================
    // ZIP / trailer helpers
    // ============================================================

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

    async function readTrailerInfo() {
        try {
            const raw = await fsp.readFile(TRAILER_INFO_PATH, 'utf8');
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    function trailerFileExists(name) {
        const trailerPath = path.join(TRAILER_DIR, `${name}-trailer.mp4`);
        return fs.existsSync(trailerPath);
    }

    // ============================================================
    // GET /films — list all available ZIP films
    // ============================================================
    router.get('/films', async (req, res) => {
        try {
            const films = await findZips(COMPLETE_DIR, COMPLETE_DIR);
            const trailerInfo = await readTrailerInfo();

            for (const film of films) {
                const hasTrailer = trailerFileExists(film.name);
                film.hasTrailer = hasTrailer;
                film.trailerType = hasTrailer ? (trailerInfo[film.name] || 'unbekannt') : null;
            }

            films.sort((a, b) => a.name.localeCompare(b.name, 'de'));
            res.json({ films, total: films.length });
        } catch (err) {
            logger.error('poster-selector: Failed to list films:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // GET /playlist — read current live playlist
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
    // PUT /playlist — save complete live playlist (legacy, kept for toggle sync)
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

            // Sync back to collection if an active playlist exists
            try {
                const collection = await readPlaylists();
                if (collection.activePlaylistId && collection.playlists[collection.activePlaylistId]) {
                    collection.playlists[collection.activePlaylistId].titles = titles;
                    collection.playlists[collection.activePlaylistId].updatedAt = new Date().toISOString();
                    await writePlaylists(collection);
                }
            } catch (_) { /* best effort */ }

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

    // ============================================================
    // GET /playlists — read all named playlists
    // ============================================================
    router.get('/playlists', async (req, res) => {
        try {
            const collection = await readPlaylists();
            res.json({
                activePlaylistId: collection.activePlaylistId,
                playlists: collection.playlists,
            });
        } catch (err) {
            logger.error('poster-selector: Failed to read playlists:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // POST /playlists — create a new named playlist
    // ============================================================
    router.post('/playlists', express.json(), async (req, res) => {
        const { name, titles } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, error: 'Name darf nicht leer sein' });
        }
        const trimmed = String(name).trim().substring(0, 50);
        try {
            const collection = await readPlaylists();

            // Check duplicate name (case-insensitive)
            const nameLower = trimmed.toLowerCase();
            for (const pl of Object.values(collection.playlists)) {
                if (pl.name.toLowerCase() === nameLower) {
                    return res.status(400).json({ success: false, error: 'Name bereits vergeben' });
                }
            }

            const id = generateId(trimmed, Object.keys(collection.playlists));
            const now = new Date().toISOString();
            collection.playlists[id] = {
                name: trimmed,
                titles: Array.isArray(titles) ? titles : [],
                createdAt: now,
                updatedAt: now,
            };
            await writePlaylists(collection);

            res.json({ success: true, id, playlist: collection.playlists[id] });
        } catch (err) {
            logger.error('poster-selector: Failed to create playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // PUT /playlists/:id — update a playlist's titles and/or name
    // ============================================================
    router.put('/playlists/:id', express.json(), async (req, res) => {
        const { id } = req.params;
        const { name, titles } = req.body || {};
        try {
            const collection = await readPlaylists();
            if (!collection.playlists[id]) {
                return res.status(404).json({ success: false, error: 'Playlist nicht gefunden' });
            }

            // Update name if provided
            if (name !== undefined) {
                const trimmed = String(name).trim().substring(0, 50);
                if (!trimmed) {
                    return res.status(400).json({ success: false, error: 'Name darf nicht leer sein' });
                }
                const nameLower = trimmed.toLowerCase();
                for (const [pid, pl] of Object.entries(collection.playlists)) {
                    if (pid !== id && pl.name.toLowerCase() === nameLower) {
                        return res.status(400).json({ success: false, error: 'Name bereits vergeben' });
                    }
                }
                collection.playlists[id].name = trimmed;
            }

            // Update titles if provided
            if (Array.isArray(titles)) {
                collection.playlists[id].titles = titles;
            }

            collection.playlists[id].updatedAt = new Date().toISOString();
            await writePlaylists(collection);

            // If this is the active playlist, sync to live file
            if (id === collection.activePlaylistId && Array.isArray(titles)) {
                await syncActiveToLive(collection);
            }

            res.json({ success: true, playlist: collection.playlists[id] });
        } catch (err) {
            logger.error('poster-selector: Failed to update playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // DELETE /playlists/:id — delete a playlist
    // ============================================================
    router.delete('/playlists/:id', async (req, res) => {
        const { id } = req.params;
        try {
            const collection = await readPlaylists();
            if (!collection.playlists[id]) {
                return res.status(404).json({ success: false, error: 'Playlist nicht gefunden' });
            }

            delete collection.playlists[id];

            // If deleting the active playlist, clear active reference
            if (id === collection.activePlaylistId) {
                collection.activePlaylistId = null;
                await writePlaylists(collection);
                // Write empty titles to live file, keep enabled flag
                await syncActiveToLive(collection);
            } else {
                await writePlaylists(collection);
            }

            res.json({ success: true });
        } catch (err) {
            logger.error('poster-selector: Failed to delete playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // PUT /playlists/:id/activate — set a playlist as active
    // ============================================================
    router.put('/playlists/:id/activate', async (req, res) => {
        const { id } = req.params;
        try {
            const collection = await readPlaylists();
            if (!collection.playlists[id]) {
                return res.status(404).json({ success: false, error: 'Playlist nicht gefunden' });
            }

            collection.activePlaylistId = id;
            await writePlaylists(collection);
            await syncActiveToLive(collection);

            res.json({ success: true, activePlaylistId: id });
        } catch (err) {
            logger.error('poster-selector: Failed to activate playlist:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
