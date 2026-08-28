/**
 * Regressionstest: Die CSP darf Inline-Event-Handler nicht blockieren.
 *
 * Helmet setzt script-src-attr standardmaessig auf 'none'. Damit blieben
 * screensaver.html und wallart.html unformatiert (Stylesheet-Aktivierung via
 * <link rel="preload" onload="this.rel='stylesheet'">), und in admin.html,
 * setup.html (2FA-Verify), cache-browser.html sowie poster-updater.html
 * fielen Buttons aus -- 14 Inline-Handler in 6 Dateien. Nur cinema.html hat
 * keine, deshalb fiel es am Kiosk nicht auf; Safari meldete es per CSP-Report.
 *
 * Solange die Inline-Handler im HTML stehen, muss script-src-attr sie erlauben.
 */

const request = require('supertest');

jest.mock('../../utils/logger');

describe('CSP: script-src-attr erlaubt Inline-Event-Handler', () => {
    let app;

    beforeAll(() => {
        process.env.NODE_ENV = 'test';
        process.env.API_ACCESS_TOKEN = 'test-token';
        jest.resetModules();
        app = require('../../server');
    });

    const cspOf = async path => {
        const res = await request(app).get(path);
        return { status: res.status, csp: res.headers['content-security-policy'] || '' };
    };

    test.each(['/screensaver', '/wallart', '/cinema.html'])(
        '%s liefert script-src-attr mit unsafe-inline statt none',
        async path => {
            const { status, csp } = await cspOf(path);
            expect(status).toBe(200);
            expect(csp).toMatch(/script-src-attr [^;]*'unsafe-inline'/);
            expect(csp).not.toMatch(/script-src-attr [^;]*'none'/);
        }
    );

    test('Seiten mit Inline-Handlern nutzen sie tatsaechlich noch (sonst Test anpassen)', () => {
        const fs = require('fs');
        const path = require('path');
        const html = fs.readFileSync(
            path.join(__dirname, '..', '..', 'public', 'screensaver.html'),
            'utf8'
        );
        // Wenn dieses Muster irgendwann verschwindet, kann script-src-attr
        // zurueck auf 'none' -- dann diesen Test entsprechend umdrehen.
        expect(html).toMatch(/<link[^>]+rel="preload"[^>]+onload=/);
    });
});
