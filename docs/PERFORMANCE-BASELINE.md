# Performance Baseline

**Version:** 3.0.0
**Last Updated:** 2026-03-25

This document defines how to capture and track performance baselines for Posterrama.

Posterrama serves frontend assets directly from `public/` (no `dist/` build pipeline).

---

## What We Measure

### 1) Endpoint latency (server)

Posterrama includes a performance monitor that measures common endpoints and compares them against thresholds and (optionally) a baseline file.

Run (requires a running server):

```bash
TEST_URL=http://localhost:4000 npm run test:performance
```

Create/update a baseline:

```bash
TEST_URL=http://localhost:4000 npm run test:performance:baseline
```

Notes:

- Baseline file path: `__tests__/regression/performance-baseline.json`
- The baseline file is auto-generated if missing.
- It may be gitignored (see `.gitignore`). Commit it only if you explicitly want baselines versioned.
- Thresholds and measured endpoints are defined in `scripts/validation/performance-monitor.js`.

### 2) Frontend memory profile (browser)

Posterrama includes a Puppeteer-based profiling script that loads key pages and reports heap/DOM/listener/layout/script-time metrics.

Run (requires a running server):

```bash
npm run perf:memory
```

When you capture new results, update this document with:

- The measured values
- The environment (host hardware + browser)
- Any notable deltas compared to the previous run

### 3) Static asset size snapshot

Because there is no bundling/minification step in v3.0.0, tracking the largest raw assets is useful.

```bash
npm run perf:largest-files
du -sh public/
```

---

## Server Startup Performance

### ZIP PosterPack Quick-Start (2026-03)

Posterrama includes ~1100 ZIP posterpacks on SD card. Two bottlenecks were identified and fixed:

| Bottleneck | Location | Before | After |
| --- | --- | --- | --- |
| `scanZipPosterPacks()` full scan (stat + AdmZip for each ZIP) | `sources/local.js` | ~60s | <1s (in-memory cache) |
| `normalizeLocalItem()` opening every ZIP with `new AdmZip()` | `lib/media-aggregator.js` | ~198s | <1s (zipHas/zipMetadata passthrough) |

**Total initial playlist fetch**: 198s → ~1.5s (Raspberry Pi 4, SD card)

**How it works**: Constructor pre-loads `cache/zip-scan-cache.json` into memory. During startup phase (`_zipScanQuickStartPhase = true`), all ZIP scans, metadata lookups, and media normalization use cached data with zero disk I/O. A background rescan runs 30s after the server starts listening.

**Key files**: `sources/local.js` (quick-start phase flag, boot cache), `lib/media-aggregator.js` (normalizeLocalItem fast path), `server.js` (background rescan timer)

---

## When To Update Baselines

- After changing caching behavior
- After changing source adapters (Plex/Jellyfin / Emby/TMDB/local)
- After adding metrics, middleware, or request validation
- After large frontend changes (admin / display modes)
- After modifying startup quick-start logic or ZIP scan cache format

---

## Related Docs

- `FRONTEND-ANALYSIS.md`
- `DEPLOYMENT-GUIDE.md`
- `SCRIPTS-OVERVIEW.md`
