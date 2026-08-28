/**
 * Tests fuer POST /api/telemetry/error
 *
 * public/error-handler.js meldet uncaught errors und unhandled rejections der
 * Anzeigeseiten an diesen Endpoint. Er ist unauthentifiziert (Anzeigeseiten
 * sind nicht eingeloggt) und darf deshalb nie mehr tun als: kuerzen, loggen, 204.
 */

const request = require('supertest');

jest.mock('../../utils/logger');

describe('POST /api/telemetry/error', () => {
    let app;
    let logger;

    beforeAll(() => {
        process.env.NODE_ENV = 'test';
        process.env.API_ACCESS_TOKEN = 'test-token';
        jest.resetModules();
        app = require('../../server');
        logger = require('../../utils/logger');
    });

    const telemetryCalls = () =>
        logger.warn.mock.calls.filter(call => call[0] === '[Telemetry] Client-Fehler');

    test('nimmt einen Fehlerbericht an und loggt ihn mit Quelle als Warnung', async () => {
        const res = await request(app).post('/api/telemetry/error').send({
            message: 'TypeError: x is not a function',
            type: 'TypeError',
            url: 'http://example.test/cinema.html',
            filename: 'http://example.test/device-mgmt.js',
            lineno: 42,
            colno: 7,
            userAgent: 'TestAgent/1.0',
        });
        expect(res.status).toBe(204);

        const call = telemetryCalls().pop();
        expect(call).toBeTruthy();
        // Meta darf keinen "message"-Schluessel tragen — Winston wuerde damit die
        // Log-Nachricht ("[Telemetry] Client-Fehler") ueberschreiben.
        expect(call[1]).not.toHaveProperty('message');
        expect(call[1]).toMatchObject({
            error: 'TypeError: x is not a function',
            type: 'TypeError',
            url: 'http://example.test/cinema.html',
            source: 'http://example.test/device-mgmt.js:42:7',
            userAgent: 'TestAgent/1.0',
        });
    });

    test('kuerzt ueberlange Felder statt zu scheitern', async () => {
        const res = await request(app)
            .post('/api/telemetry/error')
            .send({ message: 'x'.repeat(5000), stack: 'y'.repeat(5000) });
        expect(res.status).toBe(204);

        const call = telemetryCalls().pop();
        expect(call[1].error).toHaveLength(1000);
        expect(call[1].stack).toHaveLength(1000);
    });

    test('antwortet auf kaputtes JSON nicht mit einem Serverfehler', async () => {
        const res = await request(app)
            .post('/api/telemetry/error')
            .set('Content-Type', 'application/json')
            .send('{not json');
        expect(res.status).toBeLessThan(500);
    });
});
