/**
 * Tests fuer lib/clearlogo-pipeline.js
 *
 * Wir testen NICHT das volle `run()` (spawnt Python-Skripte + scannt das
 * echte media/complete-Verzeichnis — zu schwer fuer Unit-Tests). Stattdessen:
 *   1. Modul-Exports + Default-State
 *   2. __reset() leert State korrekt
 *   3. Subscribe/Unsubscribe registriert SSE-Klienten
 *   4. Stage-4-Pattern (Text-Renderer + ZIP-Patch) gegen eine Test-ZIP
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const pipeline = require('../../lib/clearlogo-pipeline');
const { renderTextClearlogo } = require('../../lib/text-clearlogo-renderer');

describe('clearlogo-pipeline', () => {
    afterEach(() => {
        pipeline.__reset();
    });

    it('exportiert die erwartete API', () => {
        expect(typeof pipeline.run).toBe('function');
        expect(typeof pipeline.isRunning).toBe('function');
        expect(typeof pipeline.getLog).toBe('function');
        expect(typeof pipeline.subscribe).toBe('function');
        expect(typeof pipeline.unsubscribe).toBe('function');
        expect(typeof pipeline.setLogger).toBe('function');
        expect(typeof pipeline.__reset).toBe('function');
    });

    it('startet als nicht-laufend mit leerem Log', () => {
        pipeline.__reset();
        expect(pipeline.isRunning()).toBe(false);
        expect(pipeline.getLog()).toBe('');
    });

    it('registriert SSE-Subscribers in einem internen Set', () => {
        const fakeRes = { write: jest.fn() };
        pipeline.subscribe(fakeRes);
        // Subscribers werden bei appendLog informiert — wir koennen das aber
        // nicht direkt triggern, ohne run() zu starten. Wir verifizieren
        // stattdessen, dass unsubscribe nicht crasht.
        expect(() => pipeline.unsubscribe(fakeRes)).not.toThrow();
        expect(() => pipeline.unsubscribe(fakeRes)).not.toThrow();
    });

    describe('Stage-4-Pattern: Text-Renderer + ZIP-Patch', () => {
        let tmpDir;
        let zipPath;

        beforeAll(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearlogo-test-'));
            zipPath = path.join(tmpDir, 'TestMovie (2020).zip');
            const zip = new AdmZip();
            zip.addFile('poster.jpg', Buffer.from('fake-poster-data-12345'));
            zip.addFile(
                'metadata.json',
                Buffer.from(JSON.stringify({ title: 'Test Movie', year: 2020 }, null, 2), 'utf8')
            );
            zip.writeZip(zipPath);
        });

        afterAll(() => {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (_) {
                /* ignore */
            }
        });

        it('text-render + ZIP-Patch erhaelt vorhandene Files', async () => {
            const buf = await renderTextClearlogo('Test Movie');
            expect(buf.length).toBeGreaterThan(1000);

            // Patch wie die Pipeline es tun wuerde
            const zip = new AdmZip(zipPath);
            zip.addFile('clearlogo.png', buf);
            const metaEntry = zip.getEntry('metadata.json');
            const meta = JSON.parse(zip.readAsText(metaEntry));
            zip.deleteFile('metadata.json');
            meta.clearlogo = 'clearlogo.png';
            meta.clearlogoSource = 'generated';
            zip.addFile('metadata.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
            zip.writeZip(zipPath);

            // Verifikation
            const verifyZip = new AdmZip(zipPath);
            const entries = verifyZip.getEntries().map(e => e.entryName);
            expect(entries).toContain('clearlogo.png');
            expect(entries).toContain('poster.jpg'); // Originalfile bewahrt
            expect(entries).toContain('metadata.json');

            const verifyMeta = JSON.parse(verifyZip.readAsText('metadata.json'));
            expect(verifyMeta.clearlogo).toBe('clearlogo.png');
            expect(verifyMeta.clearlogoSource).toBe('generated');
            expect(verifyMeta.title).toBe('Test Movie');
            expect(verifyMeta.year).toBe(2020);
        });

        it('Pipeline kann mit Custom-Logger gesetzt werden', () => {
            const myLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            };
            pipeline.setLogger(myLogger);
            // Verifizieren wir indirekt — wenn die setLogger-Implementierung
            // bricht, knallt das hier. Sonst kein Throw.
            expect(() => pipeline.setLogger(myLogger)).not.toThrow();
        });
    });
});
