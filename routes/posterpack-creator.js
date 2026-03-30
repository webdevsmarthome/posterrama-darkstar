'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const multer = require('multer');
const JSZip = require('jszip');
const AdmZip = require('adm-zip');

const COMPLETE_DIR = path.join(__dirname, '..', 'media', 'complete');
const MANUAL_DIR = path.join(COMPLETE_DIR, 'manual');
const TRAILER_DIR = path.join(__dirname, '..', 'media', 'trailers');
const TRAILER_INFO_PATH = path.join(TRAILER_DIR, 'trailer-info.json');

module.exports = function createPosterPackCreatorRouter({ logger, refreshPlaylistCache }) {
    const router = express.Router();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 200 * 1024 * 1024 },
    });

    const uploadFields = upload.fields([
        { name: 'poster', maxCount: 1 },
        { name: 'background', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 },
        { name: 'clearlogo', maxCount: 1 },
        { name: 'trailer', maxCount: 1 },
    ]);

    // --- Helpers ---

    const getExt = (file) => {
        const orig = (file.originalname || '').toLowerCase();
        if (orig.endsWith('.png')) return 'png';
        if (orig.endsWith('.webp')) return 'webp';
        return 'jpg';
    };

    // Find a ZIP by packName across all complete/ subdirectories
    function findZipPath(packName) {
        const filename = `${packName}.zip`;
        const subdirs = ['manual', 'tmdb-export', 'plex-export', 'jellyfin-emby-export', 'jellyfin-export', 'romm-export'];
        for (const sub of subdirs) {
            const p = path.join(COMPLETE_DIR, sub, filename);
            if (fs.existsSync(p)) return p;
        }
        // Also check NFC/NFD variants
        const filenameNFC = filename.normalize('NFC');
        for (const sub of subdirs) {
            const dir = path.join(COMPLETE_DIR, sub);
            try {
                const entries = fs.readdirSync(dir);
                const match = entries.find(e => e.normalize('NFC') === filenameNFC);
                if (match) return path.join(dir, match);
            } catch { /* dir may not exist */ }
        }
        return null;
    }

    function trailerExists(packName) {
        const trailerPath = path.join(TRAILER_DIR, `${packName}-trailer.mp4`);
        if (fs.existsSync(trailerPath)) return true;
        try {
            const nameNFC = `${packName}-trailer.mp4`.normalize('NFC');
            return fs.readdirSync(TRAILER_DIR).some(e => e.normalize('NFC') === nameNFC);
        } catch { return false; }
    }

    function buildMetadata(body, oldMetadata) {
        const { title, year, genres, overview, tagline, rating, runtime, contentRating,
                director, studio, resolution, audioCodec, aspectRatio, hdr, trailer,
                releaseDate, cast: castRaw } = body;
        const base = oldMetadata || {};
        return {
            itemType: base.itemType || 'movie',
            title: title ? String(title).trim() : base.title,
            originalTitle: base.originalTitle || (title ? String(title).trim() : undefined),
            year: year ? parseInt(String(year).trim(), 10) : base.year,
            genres: genres ? String(genres).split(',').map(g => g.trim()).filter(Boolean) : (base.genres || []),
            overview: overview !== undefined ? (String(overview).trim() || null) : (base.overview || null),
            tagline: tagline !== undefined ? (String(tagline).trim() || null) : (base.tagline || null),
            rating: rating ? parseFloat(rating) : (base.rating || null),
            runtimeMs: runtime ? parseInt(runtime, 10) * 60000 : (base.runtimeMs || null),
            contentRating: contentRating !== undefined ? (String(contentRating).trim() || null) : (base.contentRating || null),
            director: director !== undefined ? (String(director).trim() || null) : (base.director || null),
            directors: director !== undefined ? String(director).split(',').map(s => s.trim()).filter(Boolean) : (base.directors || []),
            studio: studio !== undefined ? (String(studio).trim() || null) : (base.studio || null),
            studios: studio !== undefined ? String(studio).split(',').map(s => s.trim()).filter(Boolean) : (base.studios || []),
            resolution: resolution !== undefined ? (String(resolution).trim() || null) : (base.resolution || null),
            audioCodec: audioCodec !== undefined ? (String(audioCodec).trim() || null) : (base.audioCodec || null),
            aspectRatio: aspectRatio !== undefined ? (String(aspectRatio).trim() || null) : (base.aspectRatio || null),
            hdr: hdr !== undefined ? (String(hdr).trim() || null) : (base.hdr || null),
            trailer: trailer !== undefined ? (String(trailer).trim() || null) : (base.trailer || null),
            releaseDate: releaseDate !== undefined ? (String(releaseDate).trim() || null) : (base.releaseDate || null),
            source: base.source || 'private',
            images: base.images || { primaryPoster: 'poster.jpg' },
            // Preserve other fields from original metadata
            ...(base.tmdbId ? { tmdbId: base.tmdbId } : {}),
            ...(base.imdbId ? { imdbId: base.imdbId } : {}),
            ...(castRaw ? { cast: (function () { try { return JSON.parse(castRaw); } catch (_) { return base.cast || []; } })() } : (base.cast ? { cast: base.cast } : {})),
            ...(base.peopleImages ? { peopleImages: base.peopleImages } : {}),
            ...(base.clearlogo ? { clearlogo: base.clearlogo } : {}),
            ...(base.rottenTomatoes ? { rottenTomatoes: base.rottenTomatoes } : {}),
            ...(base.imdbUrl ? { imdbUrl: base.imdbUrl } : {}),
            ...(base.releaseDate ? { releaseDate: base.releaseDate } : {}),
            ...(base.budget ? { budget: base.budget } : {}),
            ...(base.revenue ? { revenue: base.revenue } : {}),
        };
    }

    async function handleTrailer(packName, trailerFile) {
        if (!trailerFile) return;
        await fsp.mkdir(TRAILER_DIR, { recursive: true });
        const normalizedName = packName.normalize('NFC');
        const trailerPath = path.join(TRAILER_DIR, `${normalizedName}-trailer.mp4`);
        await fsp.writeFile(trailerPath, trailerFile.buffer);
        logger.info(`posterpack-creator: Saved trailer for ${packName}`);
        try {
            let trailerInfo = {};
            try { trailerInfo = JSON.parse(await fsp.readFile(TRAILER_INFO_PATH, 'utf8')); } catch { }
            trailerInfo[normalizedName] = 'DE';
            await fsp.writeFile(TRAILER_INFO_PATH, JSON.stringify(trailerInfo, null, 2) + '\n', 'utf8');
        } catch (err) {
            logger.warn('posterpack-creator: Failed to update trailer-info.json:', err.message);
        }
    }

    async function invalidateCacheAndRefresh(zipPath) {
        try {
            const cachePath = path.join(__dirname, '..', 'cache', 'zip-scan-cache.json');
            if (fs.existsSync(cachePath)) {
                const cache = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
                delete cache[zipPath];
                await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');
            }
        } catch { }
        if (typeof refreshPlaylistCache === 'function') {
            try { await refreshPlaylistCache(); } catch { }
        }
    }

    // ============================================================
    // GET /read/:packName — read existing posterpack metadata
    // ============================================================
    router.get('/read/:packName', async (req, res) => {
        try {
            const packName = decodeURIComponent(req.params.packName);
            const zipPath = findZipPath(packName);
            if (!zipPath) {
                return res.status(404).json({ success: false, error: 'PosterPack nicht gefunden' });
            }

            const zip = new AdmZip(zipPath);
            const entries = zip.getEntries();

            // Read metadata.json
            let metadata = {};
            const metaEntry = entries.find(e => /(^|\/)metadata\.json$/i.test(e.entryName));
            if (metaEntry) {
                try { metadata = JSON.parse(zip.readAsText(metaEntry)); } catch { }
            }

            // List files in ZIP
            const files = entries.map(e => e.entryName).filter(n => !n.endsWith('/'));

            // Determine source subdirectory
            const source = path.basename(path.dirname(zipPath));

            // Build relative zip path for /local-posterpack endpoint
            const relZip = path.relative(path.join(__dirname, '..', 'media'), zipPath).replace(/\\/g, '/');

            res.json({
                success: true,
                metadata,
                files,
                source,
                hasTrailer: trailerExists(packName),
                zipRelPath: relZip,
            });
        } catch (err) {
            logger.error('posterpack-creator: Failed to read posterpack:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // POST /create — create a new posterpack ZIP
    // ============================================================
    router.post('/create', uploadFields, async (req, res) => {
        try {
            const { title, year } = req.body || {};
            if (!title || !String(title).trim()) {
                return res.status(400).json({ success: false, error: 'Titel ist erforderlich' });
            }
            if (!year || !/^\d{4}$/.test(String(year).trim())) {
                return res.status(400).json({ success: false, error: 'Jahr muss 4-stellig sein' });
            }
            if (!req.files?.poster?.[0]) {
                return res.status(400).json({ success: false, error: 'Poster-Bild ist erforderlich' });
            }

            const packName = `${String(title).trim()} (${String(year).trim()})`;
            const zipPath = path.join(MANUAL_DIR, `${packName}.zip`);

            if (fs.existsSync(zipPath)) {
                return res.status(409).json({ success: false, error: `PosterPack "${packName}" existiert bereits` });
            }

            const metadata = buildMetadata(req.body, null);
            const zip = new JSZip();

            // Poster (required)
            const posterName = `poster.${getExt(req.files.poster[0])}`;
            zip.file(posterName, req.files.poster[0].buffer);
            metadata.images.primaryPoster = posterName;

            if (req.files.background?.[0]) {
                const bgName = `background.${getExt(req.files.background[0])}`;
                zip.file(bgName, req.files.background[0].buffer);
                metadata.images.primaryBackdrop = bgName;
            }
            if (req.files.thumbnail?.[0]) {
                zip.file(`thumbnail.${getExt(req.files.thumbnail[0])}`, req.files.thumbnail[0].buffer);
            }
            if (req.files.clearlogo?.[0]) {
                zip.file('clearlogo.png', req.files.clearlogo[0].buffer);
                metadata.clearlogo = 'clearlogo.png';
            }

            zip.file('metadata.json', JSON.stringify(metadata, null, 2));
            await fsp.mkdir(MANUAL_DIR, { recursive: true });
            const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
            await fsp.writeFile(zipPath, zipBuffer);
            logger.info(`posterpack-creator: Created ${packName}.zip (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

            await handleTrailer(packName, req.files.trailer?.[0]);
            await invalidateCacheAndRefresh(zipPath);

            res.json({ success: true, name: packName, zipPath: `${packName}.zip`, size: zipBuffer.length });
        } catch (err) {
            logger.error('posterpack-creator: Failed to create posterpack:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ============================================================
    // POST /update/:packName — update an existing posterpack
    // ============================================================
    router.post('/update/:packName', uploadFields, async (req, res) => {
        try {
            const packName = decodeURIComponent(req.params.packName);
            const existingZipPath = findZipPath(packName);
            if (!existingZipPath) {
                return res.status(404).json({ success: false, error: 'PosterPack nicht gefunden' });
            }

            // Read existing ZIP
            const oldZip = new AdmZip(existingZipPath);
            const oldEntries = oldZip.getEntries();

            // Read old metadata
            let oldMetadata = {};
            const metaEntry = oldEntries.find(e => /(^|\/)metadata\.json$/i.test(e.entryName));
            if (metaEntry) {
                try { oldMetadata = JSON.parse(oldZip.readAsText(metaEntry)); } catch { }
            }

            // Build updated metadata
            const metadata = buildMetadata(req.body, oldMetadata);

            // Create new ZIP, preserving old files where no new upload provided
            const newZip = new JSZip();

            // Copy all old entries first
            for (const entry of oldEntries) {
                if (entry.isDirectory) continue;
                const name = entry.entryName;
                // Skip metadata.json (will be rewritten)
                if (/(^|\/)metadata\.json$/i.test(name)) continue;
                // Skip files that will be replaced by new uploads
                const baseName = path.basename(name).toLowerCase();
                if (baseName.startsWith('poster.') && req.files.poster?.[0]) continue;
                if (baseName.startsWith('background.') && req.files.background?.[0]) continue;
                if (baseName.startsWith('thumbnail.') && req.files.thumbnail?.[0]) continue;
                if (baseName.startsWith('clearlogo.') && req.files.clearlogo?.[0]) continue;
                // Keep everything else (people/, extra images, etc.)
                newZip.file(name, entry.getData());
            }

            // Add new/replacement files
            if (req.files.poster?.[0]) {
                const posterName = `poster.${getExt(req.files.poster[0])}`;
                newZip.file(posterName, req.files.poster[0].buffer);
                metadata.images.primaryPoster = posterName;
            }
            if (req.files.background?.[0]) {
                const bgName = `background.${getExt(req.files.background[0])}`;
                newZip.file(bgName, req.files.background[0].buffer);
                metadata.images.primaryBackdrop = bgName;
            }
            if (req.files.thumbnail?.[0]) {
                newZip.file(`thumbnail.${getExt(req.files.thumbnail[0])}`, req.files.thumbnail[0].buffer);
            }
            if (req.files.clearlogo?.[0]) {
                newZip.file('clearlogo.png', req.files.clearlogo[0].buffer);
                metadata.clearlogo = 'clearlogo.png';
            }

            // Write metadata
            newZip.file('metadata.json', JSON.stringify(metadata, null, 2));

            // Generate and overwrite
            const zipBuffer = await newZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
            await fsp.writeFile(existingZipPath, zipBuffer);
            logger.info(`posterpack-creator: Updated ${packName}.zip (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

            // Handle trailer
            await handleTrailer(packName, req.files.trailer?.[0]);
            await invalidateCacheAndRefresh(existingZipPath);

            res.json({ success: true, name: packName, size: zipBuffer.length });
        } catch (err) {
            logger.error('posterpack-creator: Failed to update posterpack:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
