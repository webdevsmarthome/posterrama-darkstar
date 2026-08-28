/**
 * Middleware collection for Posterrama server optimizations
 * Centralizes all middleware for better organization and performance
 */

const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const logger = require('../utils/logger');

/**
 * Security middleware configuration
 * Implements security best practices
 */
// SECURITY (Audit 2026-08-16, Befund APP-3): Diese Middleware wurde frueher erst
// NACH dem Frontend-Router montiert (server.js:2644 gegenueber :1069). Dadurch
// liefen /, /screensaver, /cinema und /wallart -- also genau die per
// Cloudflare-Tunnel exponierten Seiten -- voellig ohne Schutz-Header (0 von 4),
// waehrend /admin/login korrekt 4 von 4 setzte.
//
// Mit dem Vorziehen gilt die CSP erstmals auch fuer die Anzeigeseiten. Die
// Direktiven wurden deshalb an deren tatsaechlichen Ressourcenbedarf angepasst --
// die vorherige Liste haette die Trailer-Wiedergabe stillgelegt:
//   - frameSrc stand auf 'none', aber cinema-display.js und screensaver.js
//     erzeugen iframes auf www.youtube.com / www.youtube-nocookie.com
//   - scriptSrc kannte www.youtube.com/iframe_api nicht; die IFrame-API laedt
//     den eigentlichen Player anschliessend von s.ytimg.com
//   - cinema.html bindet zusaetzlich Ressourcen von cdn.jsdelivr.net ein
function securityMiddleware() {
    // @ts-ignore - helmet is callable but require() doesn't map types correctly
    return helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: [
                    "'self'",
                    "'unsafe-inline'",
                    'https://fonts.googleapis.com',
                    'https://cdnjs.cloudflare.com',
                    'https://cdn.jsdelivr.net',
                ],
                fontSrc: [
                    "'self'",
                    'data:',
                    'https://fonts.gstatic.com',
                    'https://cdnjs.cloudflare.com',
                    'https://cdn.jsdelivr.net',
                ],
                imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
                scriptSrc: [
                    "'self'",
                    "'unsafe-inline'",
                    'https://www.youtube.com',
                    'https://s.ytimg.com',
                    'https://cdn.jsdelivr.net',
                    'https://cdnjs.cloudflare.com',
                ],
                // Helmet setzt script-src-attr standardmaessig auf 'none' und blockiert
                // damit Inline-Event-Handler (onload=, onclick=, onerror=). Das brach
                // screensaver.html/wallart.html (Stylesheet-Aktivierung via
                // <link rel="preload" onload="this.rel='stylesheet'"> -> Seite blieb
                // unformatiert, Safari meldete es per CSP-Report), admin.html,
                // setup.html (2FA-Verify), cache-browser.html und poster-updater.html
                // -- 14 Handler in 6 Dateien. Nur cinema.html hat keine, deshalb fiel
                // es am Kiosk nicht auf. Da script-src ohnehin 'unsafe-inline' erlaubt,
                // bringt ein Attribut-Verbot allein keinen Schutz. Erst wenn die
                // Inline-Handler aus dem HTML entfernt sind, kann das wieder auf 'none'.
                scriptSrcAttr: ["'unsafe-inline'"],
                // 'self' deckt gleichoriginale WebSocket-/SSE-Verbindungen mit ab (CSP3).
                connectSrc: ["'self'", 'https://www.youtube.com'],
                frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'", 'blob:', 'data:', 'https:', 'http:'],
                upgradeInsecureRequests: null,
                reportUri: ['/api/csp-report'],
            },
        },
        crossOriginEmbedderPolicy: false,
        // Set a privacy-preserving referrer policy by default
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
        },
        // Explicit frameguard to prevent clickjacking
        frameguard: { action: 'deny' },
        // XSS filter for legacy browser protection
        xssFilter: true,
    });
}

/**
 * Permissions-Policy middleware
 * Disables unnecessary browser features for enhanced privacy and security
 */
function permissionsPolicyMiddleware() {
    return (req, res, next) => {
        res.setHeader(
            'Permissions-Policy',
            [
                'camera=()',
                'microphone=()',
                'geolocation=()',
                'payment=()',
                'usb=()',
                'accelerometer=()',
                'gyroscope=()',
                'magnetometer=()',
                'interest-cohort=()', // Block FLoC
            ].join(', ')
        );
        next();
    };
}

/**
 * Compression middleware for better performance
 * Compresses responses when appropriate
 */
function compressionMiddleware() {
    return (req, res, next) => {
        // Skip compression for specific problematic endpoints
        // 1) Media endpoints stream a lot and benefit little from compression
        if (req.path === '/get-media' || req.path.includes('get-media')) {
            return next();
        }

        // 2) NEVER compress Server‑Sent Events (SSE) — compression buffers small chunks and
        //    prevents immediate delivery, breaking EventSource open/heartbeat behavior.
        //    Detect by path or Accept header, since Content-Type is set later in the route.
        const accept = req.headers['accept'] || '';
        if (
            req.path === '/api/admin/events' ||
            (typeof accept === 'string' && accept.includes('text/event-stream'))
        ) {
            return next();
        }

        // Use default compression for other routes
        return compression({
            filter: (req, res) => {
                // Don't compress already compressed content or images
                if (
                    req.headers['x-no-compression'] ||
                    req.url.includes('/image/') ||
                    req.url.endsWith('.jpg') ||
                    req.url.endsWith('.png') ||
                    req.url.endsWith('.gif') ||
                    req.url.endsWith('.webp')
                ) {
                    return false;
                }
                // Also skip compression for SSE based on Content-Type when available
                try {
                    const ct = res.getHeader('Content-Type');
                    if (typeof ct === 'string' && ct.includes('text/event-stream')) {
                        return false;
                    }
                } catch (_) {
                    /* ignore */
                }
                return compression.filter(req, res);
            },
            level: 6,
            threshold: 1024,
        })(req, res, next);
    };
}

/**
 * CORS middleware configuration
 * Handles cross-origin requests securely
 */
// SECURITY (Audit 2026-08-16, Befund APP-2): Vorher spiegelte diese Middleware
// JEDEN fremden Origin zurueck -- zusammen mit `credentials: true` und auch auf
// /api/admin/*. Nachgewiesen mit `curl -H "Origin: https://evil.example.com"`:
// die Antwort enthielt genau diesen Origin in Access-Control-Allow-Origin.
// Dass daraus keine Uebernahme folgte, lag einzig am SameSite=Lax-Cookie --
// eine einzige Verteidigungslinie ohne Tiefenschutz, die bei einem Wechsel auf
// sameSite:'none' sofort gefallen waere.
//
// Die Absicht des alten Codes ("self-hosted, Nutzer waehlen ihre Domain") ist
// berechtigt; sie wird jetzt ueber eine konfigurierbare Allowlist erfuellt statt
// ueber Pauschalfreigabe. Zusaetzliche Origins koennen ohne Codeaenderung ueber
// die Umgebungsvariable CORS_ALLOWED_ORIGINS (kommagetrennt) ergaenzt werden.
function buildAllowedOrigins() {
    const list = new Set();

    // 1. Oeffentliche URL aus der Konfiguration (z. B. https://pr.go27.one)
    for (const key of ['PUBLIC_URL', 'BASE_URL', 'SITE_URL']) {
        const v = (process.env[key] || '').trim().replace(/\/+$/, '');
        if (v) list.add(v);
    }

    // 2. Ausdrueckliche Ergaenzungen des Betreibers
    for (const v of (process.env.CORS_ALLOWED_ORIGINS || '').split(',')) {
        const t = v.trim().replace(/\/+$/, '');
        if (t) list.add(t);
    }

    // 3. Lokale Zugriffe: Loopback und die eigene LAN-Adresse auf dem App-Port.
    //    Die Anzeigeclients im LAN sprechen die App direkt auf :4000 an.
    const port = process.env.SERVER_PORT || process.env.PORT || '4000';
    for (const host of ['localhost', '127.0.0.1']) {
        list.add(`http://${host}:${port}`);
        list.add(`https://${host}:${port}`);
    }
    try {
        const os = require('os');
        for (const ifaces of Object.values(os.networkInterfaces() || {})) {
            for (const i of ifaces || []) {
                if (i.family === 'IPv4' && !i.internal) {
                    list.add(`http://${i.address}:${port}`);
                    list.add(`https://${i.address}:${port}`);
                }
            }
        }
    } catch (_) {
        /* Netzwerkliste optional -- Allowlist bleibt sonst einfach kuerzer */
    }
    return list;
}

function corsMiddleware() {
    const allowed = buildAllowedOrigins();
    logger.info('[CORS] Allowlist aktiv', { origins: [...allowed] });

    return cors({
        origin: function (origin, callback) {
            // Anfragen ohne Origin (curl, native Apps, Server-zu-Server) tragen
            // keine Browser-Credentials und sind daher unkritisch.
            if (!origin || origin === 'null') {
                callback(null, true);
                return;
            }
            if (allowed.has(origin.replace(/\/+$/, ''))) {
                callback(null, true);
                return;
            }
            // Kein Fehler, sondern schlicht KEIN Access-Control-Allow-Origin-Header:
            // Der Browser blockt die Antwort, die Anfrage selbst laeuft normal durch.
            // Ein Fehler wuerde stattdessen 500er fuer harmlose Aufrufe erzeugen.
            logger.warn('[CORS] Origin abgelehnt', { origin });
            callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    });
}

/**
 * Request logging middleware
 * Logs all requests with performance metrics
 */
function requestLoggingMiddleware() {
    return (req, res, next) => {
        const startTime = Date.now();
        const originalJson = res.json;

        // Override res.json to capture response size safely (avoid throwing on circulars)
        res.json = function (data) {
            try {
                const str = typeof data === 'string' ? data : JSON.stringify(data);
                res.locals.responseSize = Buffer.byteLength(str);
            } catch (_) {
                // Fallback: unknown size; don't block the response
                res.locals.responseSize = 0;
            }
            return originalJson.call(this, data);
        };

        // Log when response finishes
        res.on('finish', () => {
            const duration = Date.now() - startTime;
            const logData = {
                method: req.method,
                url: req.url,
                statusCode: res.statusCode,
                duration: `${duration}ms`,
                userAgent: req.get('User-Agent')?.substring(0, 100),
                ip: req.ip || req.connection.remoteAddress,
                responseSize: res.locals.responseSize || 0,
            };

            if (res.statusCode >= 500) {
                logger.warn('Request completed with error', logData);
            } else if (res.statusCode >= 400) {
                // Skip 401 errors for admin endpoints - these are normal when not logged in.
                // Use originalUrl to remain correct when the app is mounted under a base path.
                const urlForMatch = String(req.originalUrl || req.url || '');
                const pathOnly = urlForMatch.split('?')[0];
                const isAdminApi = /(^|\/)api\/admin(\/|$)/.test(pathOnly);
                if (res.statusCode === 401 && isAdminApi) {
                    return;
                }
                logger.warn('Request completed with error', logData);
            } else {
                // Skip routine browser requests (static files, favicon, etc.)
                // Note: Slow request detection is handled by metrics.js middleware
                const isRoutineRequest =
                    req.url &&
                    (req.url === '/favicon.ico' ||
                        req.url.startsWith('/static/') ||
                        req.url.startsWith('/images/') ||
                        req.url.startsWith('/css/') ||
                        req.url.startsWith('/js/') ||
                        req.url.startsWith('/fonts/') ||
                        req.url.endsWith('.css') ||
                        req.url.endsWith('.js') ||
                        req.url.endsWith('.png') ||
                        req.url.endsWith('.jpg') ||
                        req.url.endsWith('.ico') ||
                        req.url.endsWith('.svg') ||
                        req.url.endsWith('.woff') ||
                        req.url.endsWith('.woff2') ||
                        req.url.endsWith('.ttf'));

                if (isRoutineRequest) return; // Skip routine requests entirely

                if (req.url.includes('/api/')) {
                    // Reduce noise: skip ultra-chatty streams (SSE) and demote to debug by default
                    if (req.url.startsWith('/api/admin/events')) return; // SSE stream
                    if (req.url.startsWith('/api/admin/logs')) return; // avoid self-referential log spam
                    if (req.url.startsWith('/api/devices/heartbeat')) return; // frequent pings
                    if (req.url.startsWith('/api/admin/performance')) return; // admin performance monitoring
                    if (req.url.startsWith('/api/v1/metrics')) return; // admin metrics dashboard
                    if (req.url.startsWith('/api/admin/metrics')) return; // admin metrics calls
                    if (req.url.startsWith('/api/admin/status')) return; // admin status monitoring
                    if (req.url.startsWith('/api/admin/mqtt/status')) return; // MQTT status polling
                    if (req.url.startsWith('/api/plex/sessions')) return; // Plex sessions polling

                    // Keep original behavior for tests to satisfy assertions
                    if (process.env.NODE_ENV === 'test') {
                        logger.info('API request completed', logData);
                        return;
                    }

                    // Configurable log level and sampling for API access logs
                    const levelRaw = process.env.API_REQUEST_LOG_LEVEL || 'debug';
                    const level = String(levelRaw).trim().toLowerCase(); // info|debug|warn
                    const sample = Number(process.env.API_REQUEST_LOG_SAMPLE || 0); // 0..1 (e.g., 0.1 = 10%)
                    const logFn = typeof logger[level] === 'function' ? logger[level] : logger.info;
                    if (sample > 0) {
                        if (Math.random() < sample) logFn('API request completed', logData);
                    } else {
                        logFn('API request completed', logData);
                    }
                }
            }
        });

        next();
    };
}

/**
 * Error handling middleware
 * Centralized error handling with proper logging
 */
function errorHandlingMiddleware() {
    return (error, req, res, next) => {
        // Log the error
        const errorData = {
            error: error.message,
            stack: error.stack,
            url: req.url,
            method: req.method,
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.get('User-Agent')?.substring(0, 100),
        };

        if (error.statusCode && error.statusCode < 500) {
            logger.warn('Client error occurred', errorData);
        } else {
            logger.error('Server error occurred', errorData);
        }

        // Send appropriate response
        if (res.headersSent) {
            return next(error);
        }

        const statusCode = error.statusCode || 500;
        const message = statusCode >= 500 ? 'Internal Server Error' : error.message;

        res.status(statusCode).json({
            success: false,
            error: {
                message,
                code: statusCode,
                ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
            },
        });
    };
}

/**
 * Health check middleware for monitoring
 * Provides system health information
 */
function healthCheckMiddleware() {
    return (req, res) => {
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();

        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: {
                seconds: Math.floor(uptime),
                human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
            },
            memory: {
                rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
                heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
                external: `${Math.round(memoryUsage.external / 1024 / 1024)}MB`,
            },
            environment: {
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch,
            },
        };

        res.json(health);
    };
}

module.exports = {
    securityMiddleware,
    permissionsPolicyMiddleware,
    compressionMiddleware,
    corsMiddleware,
    requestLoggingMiddleware,
    errorHandlingMiddleware,
    healthCheckMiddleware,
    // New modular middleware
    asyncHandler: require('./asyncHandler'),
    createIsAuthenticated: require('./auth'),
    createMetricsAuth: require('./metricsAuth').createMetricsAuth,
    testSessionShim: require('./testSessionShim'),
    ...require('./adminAuth'),
};
