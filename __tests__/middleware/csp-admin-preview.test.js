/**
 * CSP: Die Admin-Live-Vorschau framt die eigene Anzeigeseite
 * (<iframe src="/screensaver?preview=1"> in admin.html). Dafuer muss die CSP
 * gleichoriginale Frames in beide Richtungen erlauben: frame-src 'self' auf der
 * einbettenden Seite, frame-ancestors 'self' auf der eingebetteten -- und
 * X-Frame-Options darf nicht DENY sein.
 *
 * Vorgeschichte: Der Audit-Commit vom 26.08. setzte frame-src nur auf YouTube;
 * die Vorschau blieb still leer, bis ein CSP-Report es am 30.08. verriet.
 */

const request = require('supertest');

jest.mock('../../utils/logger');

describe('CSP: gleichoriginale Frames (Admin-Live-Vorschau)', () => {
    let app;

    beforeAll(() => {
        process.env.NODE_ENV = 'test';
        process.env.API_ACCESS_TOKEN = 'test-token';
        jest.resetModules();
        app = require('../../server');
    });

    test('/screensaver darf gleichoriginal eingebettet werden und selbst einbetten', async () => {
        const res = await request(app).get('/screensaver');
        expect(res.status).toBe(200);
        const csp = res.headers['content-security-policy'] || '';
        expect(csp).toMatch(/frame-src [^;]*'self'/);
        expect(csp).toMatch(/frame-ancestors [^;]*'self'/);
        expect((res.headers['x-frame-options'] || '').toUpperCase()).not.toBe('DENY');
    });

    test('admin.html enthaelt die Vorschau als gleichoriginalen iframe', () => {
        const fs = require('fs');
        const path = require('path');
        const html = fs.readFileSync(
            path.join(__dirname, '..', '..', 'public', 'admin.html'),
            'utf8'
        );
        // Wenn die Vorschau irgendwann anders geloest ist, kann frame-src 'self'
        // wieder entfallen -- dann diesen Test mit anpassen.
        expect(html).toMatch(/<iframe[^>]+src="\/screensaver\?preview=1"/);
    });
});
