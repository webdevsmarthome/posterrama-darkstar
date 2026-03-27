'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const multer = require('multer');
const JSZip = require('jszip');

const MANUAL_DIR = path.join(__dirname, '..', 'media', 'complete', 'manual');
const TRAILER_DIR = path.join(__dirname, '..', 'media', 'trailers');
const TRAILER_INFO_PATH = path.join(TRAILER_DIR, 'trailer-info.json');

module.exports = function createPosterpackCreatorRouter({ logger, refreshPlaylistCache }) {
    const router = express.Router();

    // Multer: store uploads in memory (they go into the ZIP)
    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max per file
    });

    const uploadFields = upload.fields([
        { name: 'poster', maxCount: 1 },
        { name: 'background', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 },
        { name: 'clearlogo', maxCount: 1 },
        { name: 'trailer', maxCount: 1 },
    ]);

    // ============================================================
    // POST /create — create a new posterpack ZIP
    // ============================================================
    router.post('/create', uploadFields, async (req, res) => {
        try {
            const { title, year, genres, overview, tagline, rating, runtime, contentRating } = req.body || {};

            // Validate required fields
            if (!title || !String(title).trim()) {
                return res.status(400).json({ success: false, error: 'Titel ist erforderlich' });
            }
            if (!year || !/^\d{4}$/.test(String(year).trim())) {
                return res.status(400).json({ success: false, error: 'Jahr muss 4-stellig sein' });
            }
            if (!req.files?.poster?.[0]) {
                return res.status(400).json({ success: false, error: 'Poster-Bild ist erforderlich' });
            }

            const cleanTitle = String(title).trim();
            const cleanYear = String(year).trim();
            const packName = `${cleanTitle} (${cleanYear})`;
            const zipFilename = `${packName}.zip`;
            const zipPath = path.join(MANUAL_DIR, zipFilename);

            // Check if already exists
            if (fs.existsSync(zipPath)) {
                return res.status(409).json({ success: false, error: `Posterpack "${packName}" existiert bereits` });
            }

            // Build metadata.json
            const metadata = {
                itemType: 'movie',
                title: cleanTitle,
                originalTitle: cleanTitle,
                year: parseInt(cleanYear, 10),
                genres: genres ? String(genres).split(',').map(g => g.trim()).filter(Boolean) : [],
                overview: overview ? String(overview).trim() : null,
                tagline: tagline ? String(tagline).trim() : null,
                rating: rating ? parseFloat(rating) : null,
                runtimeMs: runtime ? parseInt(runtime, 10) * 60000 : null,
                contentRating: contentRating ? String(contentRating).trim() : null,
                source: 'private',
                images: {
                    primaryPoster: 'poster.jpg',
                },
            };

            // Determine file extensions from uploads
            const getExt = (file) => {
                const orig = (file.originalname || '').toLowerCase();
                if (orig.endsWith('.png')) return 'png';
                if (orig.endsWith('.webp')) return 'webp';
                return 'jpg';
            };

            // Build ZIP
            const zip = new JSZip();

            // metadata.json
            zip.file('metadata.json', JSON.stringify(metadata, null, 2));

            // Poster (required)
            const posterFile = req.files.poster[0];
            const posterExt = getExt(posterFile);
            const posterName = `poster.${posterExt}`;
            zip.file(posterName, posterFile.buffer);
            metadata.images.primaryPoster = posterName;

            // Background (optional)
            if (req.files.background?.[0]) {
                const bgFile = req.files.background[0];
                const bgName = `background.${getExt(bgFile)}`;
                zip.file(bgName, bgFile.buffer);
                metadata.images.primaryBackdrop = bgName;
            }

            // Thumbnail (optional)
            if (req.files.thumbnail?.[0]) {
                const thumbFile = req.files.thumbnail[0];
                zip.file(`thumbnail.${getExt(thumbFile)}`, thumbFile.buffer);
            }

            // ClearLogo (optional)
            if (req.files.clearlogo?.[0]) {
                const logoFile = req.files.clearlogo[0];
                zip.file('clearlogo.png', logoFile.buffer);
                metadata.clearlogo = 'clearlogo.png';
            }

            // Re-write metadata with updated image refs
            zip.file('metadata.json', JSON.stringify(metadata, null, 2));

            // Generate ZIP buffer and write
            await fsp.mkdir(MANUAL_DIR, { recursive: true });
            const zipBuffer = await zip.generateAsync({
                type: 'nodebuffer',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });
            await fsp.writeFile(zipPath, zipBuffer);
            logger.info(`posterpack-creator: Created ${zipFilename} (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

            // Handle trailer separately (goes to media/trailers/, not into ZIP)
            if (req.files.trailer?.[0]) {
                try {
                    await fsp.mkdir(TRAILER_DIR, { recursive: true });
                    const trailerPath = path.join(TRAILER_DIR, `${packName}-trailer.mp4`);
                    await fsp.writeFile(trailerPath, req.files.trailer[0].buffer);
                    logger.info(`posterpack-creator: Saved trailer for ${packName}`);

                    // Update trailer-info.json
                    try {
                        let trailerInfo = {};
                        try {
                            trailerInfo = JSON.parse(await fsp.readFile(TRAILER_INFO_PATH, 'utf8'));
                        } catch { /* empty or missing */ }
                        trailerInfo[packName] = 'DE';
                        await fsp.writeFile(TRAILER_INFO_PATH, JSON.stringify(trailerInfo, null, 2) + '\n', 'utf8');
                    } catch (err) {
                        logger.warn('posterpack-creator: Failed to update trailer-info.json:', err.message);
                    }
                } catch (err) {
                    logger.warn('posterpack-creator: Failed to save trailer:', err.message);
                }
            }

            // Invalidate ZIP scan cache so the new pack is picked up
            try {
                const cachePath = path.join(__dirname, '..', 'cache', 'zip-scan-cache.json');
                if (fs.existsSync(cachePath)) {
                    const cache = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
                    // Don't delete the whole cache — just ensure the new ZIP isn't cached as "missing"
                    delete cache[zipPath];
                    await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');
                }
            } catch { /* best effort */ }

            // Refresh media cache so the new posterpack appears immediately
            if (typeof refreshPlaylistCache === 'function') {
                try {
                    await refreshPlaylistCache();
                    logger.info('posterpack-creator: Playlist cache refreshed');
                } catch (err) {
                    logger.warn('posterpack-creator: Cache refresh failed:', err.message);
                }
            }

            res.json({
                success: true,
                name: packName,
                zipPath: zipFilename,
                size: zipBuffer.length,
            });
        } catch (err) {
            logger.error('posterpack-creator: Failed to create posterpack:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
