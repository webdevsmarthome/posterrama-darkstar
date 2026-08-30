/**
 * CSP: script-src-attr 'none' -- und kein Inline-Event-Handler im Frontend.
 *
 * Vorgeschichte: Helmet liefert script-src-attr 'none' als Default. Damit blieben
 * screensaver.html und wallart.html unformatiert (Stylesheet-Aktivierung via
 * <link rel="preload" onload="this.rel='stylesheet'">), in admin.html, setup.html
 * (2FA-Verify), cache-browser.html und poster-updater.html fielen Buttons aus,
 * und JS-Templates in admin.js/promo-box-overlay.js erzeugten tote Handler --
 * 20 Vorkommen. Nur cinema.html hatte keine, deshalb fiel es am Kiosk nicht auf.
 *
 * Seit v3.0.1z-14 sind alle Vorkommen durch addEventListener bzw. Event-
 * Delegation ersetzt und die Direktive steht explizit auf 'none'. Dieser Test
 * haelt beides fest: den Header UND einen statischen Scan von public/, der
 * anschlaegt, sobald wieder ein on*="..."-Attribut auftaucht.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');

jest.mock('../../utils/logger');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// on<event>=" / on<event>=' / on<event>=\" (escaped in JS-Strings). Bewusst eine
// Liste echter DOM-Events statt on[a-z]+ -- sonst matchen JS-Parameter wie
// `onText = 'Enabled'`.
const EVENT_NAMES =
    'load|error|abort|click|dblclick|contextmenu|change|input|submit|reset|focus|blur|' +
    'focusin|focusout|keydown|keyup|keypress|mousedown|mouseup|mouseover|mouseout|mouseenter|' +
    'mouseleave|mousemove|wheel|scroll|resize|touchstart|touchend|touchmove|touchcancel|' +
    'pointerdown|pointerup|pointermove|pointerenter|pointerleave|pointercancel|drag|dragstart|' +
    'dragend|dragenter|dragleave|dragover|drop|select|toggle|play|pause|ended|timeupdate|' +
    'volumechange|canplay|canplaythrough|loadeddata|loadedmetadata|animationend|' +
    'animationstart|transitionend|message|hashchange|popstate|beforeunload|unload';
const INLINE_HANDLER = new RegExp(`\\son(?:${EVENT_NAMES})\\s*=\\s*["'\\\\]`, 'i');
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'lib', 'libs']);

function collectFrontendFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collectFrontendFiles(full, out);
            continue;
        }
        if (!/\.(html|js)$/.test(entry.name)) continue;
        if (entry.name.endsWith('.min.js') || entry.name === 'sw.js') continue;
        out.push(full);
    }
    return out;
}

describe('CSP: script-src-attr', () => {
    let app;

    beforeAll(() => {
        process.env.NODE_ENV = 'test';
        process.env.API_ACCESS_TOKEN = 'test-token';
        jest.resetModules();
        app = require('../../server');
    });

    test.each(['/screensaver', '/wallart', '/cinema.html'])(
        "%s liefert script-src-attr 'none'",
        async route => {
            const res = await request(app).get(route);
            expect(res.status).toBe(200);
            const csp = res.headers['content-security-policy'] || '';
            expect(csp).toMatch(/script-src-attr 'none'/);
            expect(csp).not.toMatch(/script-src-attr [^;]*'unsafe-inline'/);
        }
    );

    test('kein Inline-Event-Handler-Attribut in public/ (HTML + JS-Templates)', () => {
        const offenders = [];
        for (const file of collectFrontendFiles(PUBLIC_DIR)) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (INLINE_HANDLER.test(line)) {
                    offenders.push(
                        `${path.relative(PUBLIC_DIR, file)}:${i + 1}: ${line.trim().slice(0, 100)}`
                    );
                }
            });
        }
        // Bei Treffern: Handler per addEventListener/Delegation ersetzen -- NICHT
        // die CSP lockern. Siehe wireCspSafeHandlers() am Ende von admin.js.
        expect(offenders).toEqual([]);
    });

    test('deferred CSS in screensaver/wallart wird ohne onload-Attribut aktiviert', () => {
        for (const page of ['screensaver.html', 'wallart.html']) {
            const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
            expect(html).toMatch(/<link[^>]+rel="preload"[^>]+data-deferred-css/);
            expect(html).toMatch(/link\[data-deferred-css\]/);
            expect(html).not.toMatch(/rel="preload"[^>]+onload=/);
        }
    });
});
