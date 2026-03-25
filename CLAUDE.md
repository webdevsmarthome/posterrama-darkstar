# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Posterrama is a self-hosted Node.js display server that turns screens into media art galleries. It pulls artwork from Plex, Jellyfin/Emby, TMDB, and RomM, presenting it in three display modes: Cinema (single poster), Wallart (poster grid), and Screensaver (slideshow). It includes an admin dashboard, device management, MQTT/Home Assistant integration, and WebSocket-based real-time control.

## Common Commands

```bash
# Run the server
npm start                    # Starts server.js (default port 4000)
pm2 start ecosystem.config.js  # Production via PM2 (8GB heap limit)

# Tests
npm test                     # Full test suite with coverage
npx jest path/to/file.test.js  # Run a single test file
npm run test:watch           # Watch mode
npm run test:coverage        # Coverage report
npm run test:regression      # Regression suite only

# Linting & formatting
npm run lint                 # ESLint (flat config, eslint.config.js)
npm run lint:fix
npm run format               # Prettier
npm run format:check

# Type checking
npm run type-check           # TypeScript noEmit check (tsconfig.json)

# Full quality gate (CI equivalent)
npm run quality:all          # type-check + lint + format + tests + openapi + deps

# OpenAPI
npm run openapi:export       # Regenerate openapi spec
npm run openapi:validate     # Validate spec

# Config validation
npm run config:validate
```

## Architecture

**Single-file server**: `server.js` (~296KB) is the main Express application. It's large — contains all route handlers, initialization, and application logic inline. Modularized helpers are extracted into `lib/`.

**Key directories:**
- `lib/` — Server-side helpers extracted from server.js: playlist cache, plex/jellyfin helpers, config helpers, realtime server (WebSocket/SSE), device operations, media aggregation
- `sources/` — Media source integrations: `plex.js`, `jellyfin.js`, `tmdb.js`, `romm.js`, `local.js` (local uploads/posterpacks)
- `routes/` — Express route modules (admin, auth, devices, media, profiles, health, etc.)
- `middleware/` — Express middleware: auth, rate limiting, validation, caching, error handling, file upload
- `utils/` — Standalone utilities: logging (winston), metrics (prom-client), MQTT bridge, WebSocket hub, device/profile stores, cache, error classes
- `config/` — Environment config loading and validation (Joi-based)
- `public/` — Frontend: admin dashboard, cinema/wallart/screensaver HTML/JS/CSS, service worker
- `services/` — Session pollers for Plex and Jellyfin (now-playing detection)

**Configuration**: Three layers — `.env` (environment variables), `config.json` (runtime settings validated against `config.schema.json`), and `config.example.json`/`config.example.env` as templates.

**State files at project root**: `devices.json`, `profiles.json`, `config.json` — all with `.backup` copies. These are live state, not source-controlled.

**Real-time**: WebSocket hub (`utils/wsHub.js`) + SSE for device-to-server communication. MQTT bridge (`utils/mqttBridge.js`) for Home Assistant integration.

**Startup optimization (fast boot)**: ZIP posterpacks (~1100 files on SD card) use a two-phase startup:
1. **Quick-start phase** (`_zipScanQuickStartPhase = true`): Constructor in `sources/local.js` pre-loads `cache/zip-scan-cache.json` into memory. During startup, `scanZipPosterpacks()` and `loadOrCreateMetadata()` return data from the in-memory cache with zero disk I/O. In `lib/media-aggregator.js`, `normalizeLocalItem()` uses the item's `zipHas`/`zipMetadata` properties (passed through from `createMediaItem()`) instead of opening each ZIP with AdmZip.
2. **Background rescan** (30s after `app.listen()`): `server.js` sets `_zipScanQuickStartPhase = false` and calls `refreshPlaylistCache()` to do a full stat-based scan with real AdmZip reads for cache misses.

**YouTube trailer autoplay** (`public/cinema/cinema-display.js`): Trailers create the `<iframe>` element manually with `allow="autoplay; encrypted-media; picture-in-picture"` set **before** assigning `src`. This is required for both Chromium and Safari autoplay policy compliance. The YT.Player instance receives the pre-built iframe element directly.

## Testing

- Jest with Node environment, tests in `__tests__/` organized by domain (api, middleware, sources, utils, lib, routes, devices, etc.)
- `modulePaths: ['<rootDir>']` — tests can use root-relative requires like `require('sources/tmdb')`
- Coverage thresholds enforced globally (50% branches, 60% functions/lines/statements) with file-specific thresholds for key modules
- Babel transform enabled for coverage instrumentation
- `jest.setup.js` handles timer cleanup; `jest.teardown.js` handles global cleanup
- `--runInBand` used for e2e tests to prevent race conditions
- Focused single-file runs relax coverage thresholds automatically

## Tech Stack

- **Runtime**: Node.js 18+ (Express 4, CommonJS modules throughout)
- **Process manager**: PM2 (ecosystem.config.js)
- **Image processing**: Sharp
- **Logging**: Winston with daily rotate
- **Metrics**: prom-client (Prometheus)
- **API docs**: Swagger (swagger-jsdoc) served at `/api-docs`
- **Frontend**: Vanilla JS/CSS (no build step, served as static files)
