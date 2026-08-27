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

    describe('zip-scan-cache-Invalidierung', () => {
        let tmpDir;
        let cacheFile;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearlogo-cache-'));
            cacheFile = path.join(tmpDir, 'zip-scan-cache.json');
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        // Legt eine echte Datei an und liefert den passenden Cache-Eintrag.
        function makeZip(name, content = 'zip-inhalt') {
            const p = path.join(tmpDir, name);
            fs.writeFileSync(p, content);
            const st = fs.statSync(p);
            return { path: p, entry: { m: st.mtimeMs, s: st.size, h: { poster: true }, z: {} } };
        }

        it('behaelt unveraenderte Eintraege und entfernt nur veraltete', async () => {
            const unchanged = makeZip('unchanged.zip');
            const touched = makeZip('touched.zip');
            const removed = makeZip('removed.zip');

            const cache = {
                [unchanged.path]: unchanged.entry,
                [touched.path]: touched.entry,
                [removed.path]: removed.entry,
                [path.join(tmpDir, 'never-existed.zip')]: { m: 1, s: 1, h: {}, z: {} },
            };
            fs.writeFileSync(cacheFile, JSON.stringify(cache));

            // touched.zip bekommt neuen Inhalt -> mtime UND size aendern sich,
            // genau wie bei zip.writeZip() in patchZipWithGenerated().
            fs.writeFileSync(touched.path, 'anderer inhalt mit anderer laenge');
            // removed.zip verschwindet komplett.
            fs.rmSync(removed.path);

            await pipeline.__invalidateZipScanCache(cacheFile);

            const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            // Der entscheidende Punkt: der unveraenderte Eintrag ueberlebt.
            // Frueher wurde der Cache komplett auf '{}' gesetzt, was den
            // naechsten Refresh zwang, alle ~1300 ZIPs neu zu lesen.
            expect(Object.keys(after)).toEqual([unchanged.path]);
            expect(after[unchanged.path]).toEqual(unchanged.entry);
        });

        it('setzt einen korrupten Cache zurueck statt zu werfen', async () => {
            fs.writeFileSync(cacheFile, '{ das ist kein gueltiges JSON');
            await expect(pipeline.__invalidateZipScanCache(cacheFile)).resolves.toBeUndefined();
            expect(fs.readFileSync(cacheFile, 'utf8')).toBe('{}');
        });

        it('laesst eine fehlende Cache-Datei unangetastet', async () => {
            await expect(pipeline.__invalidateZipScanCache(cacheFile)).resolves.toBeUndefined();
            expect(fs.existsSync(cacheFile)).toBe(false);
        });

        it('hinterlaesst keine .tmp-Datei (atomares Schreiben)', async () => {
            const z = makeZip('a.zip');
            fs.writeFileSync(cacheFile, JSON.stringify({ [z.path]: z.entry }));
            await pipeline.__invalidateZipScanCache(cacheFile);
            expect(fs.existsSync(`${cacheFile}.tmp`)).toBe(false);
            expect(fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))).toEqual([]);
        });
    });
});
