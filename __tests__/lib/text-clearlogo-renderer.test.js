/**
 * Tests fuer lib/text-clearlogo-renderer.js
 */

const sharp = require('sharp');
const {
    renderTextClearlogo,
    buildSvg,
    pickFontSize,
    splitTitleIntoLines,
    CANVAS_W,
    CANVAS_H,
} = require('../../lib/text-clearlogo-renderer');

describe('text-clearlogo-renderer', () => {
    describe('pickFontSize', () => {
        it('liefert grosse Schrift fuer kurze Titel', () => {
            expect(pickFontSize('A')).toBeGreaterThanOrEqual(200);
            expect(pickFontSize('Alien')).toBeGreaterThanOrEqual(150);
        });

        it('schrumpft fuer lange Titel', () => {
            const shortSize = pickFontSize('Alien');
            const longSize = pickFontSize('A really long movie title that needs shrinking');
            expect(longSize).toBeLessThan(shortSize);
        });

        it('handhabt null/undefined ohne Crash', () => {
            expect(pickFontSize(null)).toBeGreaterThan(0);
            expect(pickFontSize(undefined)).toBeGreaterThan(0);
        });
    });

    describe('splitTitleIntoLines', () => {
        it('belaesst kurze Titel auf einer Zeile', () => {
            expect(splitTitleIntoLines('Alien: Romulus')).toEqual(['Alien: Romulus']);
            expect(splitTitleIntoLines('Anaconda')).toEqual(['Anaconda']);
        });

        it('splittet am " - "-Separator', () => {
            const lines = splitTitleIntoLines('James Bond 007 - Goldfinger');
            expect(lines).toHaveLength(2);
            expect(lines[0]).toBe('James Bond 007');
            expect(lines[1]).toBe('Goldfinger');
        });

        it('splittet am ":"-Separator', () => {
            const lines = splitTitleIntoLines('28 Years Later: The Bone Temple');
            expect(lines).toHaveLength(2);
            expect(lines[0]).toBe('28 Years Later');
            expect(lines[1]).toBe('The Bone Temple');
        });

        it('splittet am naechstgelegenen Leerzeichen zur Mitte (Fallback)', () => {
            const lines = splitTitleIntoLines('An der Donau wenn der Wein blueht heute');
            expect(lines.length).toBe(2);
            // Beide Zeilen muessen non-empty sein und zusammen alle Worte enthalten
            expect(lines[0].length).toBeGreaterThan(0);
            expect(lines[1].length).toBeGreaterThan(0);
            const joined = lines[0] + ' ' + lines[1];
            expect(joined.trim()).toBe('An der Donau wenn der Wein blueht heute');
        });

        it('handhabt leeren Titel ohne Crash', () => {
            expect(splitTitleIntoLines('')).toEqual(['']);
            expect(splitTitleIntoLines(null)).toEqual(['']);
        });
    });

    describe('buildSvg', () => {
        it('produziert gueltiges SVG mit erwarteten Attributen', () => {
            const svg = buildSvg('Alien');
            expect(svg).toContain('<svg');
            expect(svg).toContain('viewBox="0 0 1200 400"');
            expect(svg).toContain('font-weight="900"');
            expect(svg).toContain('Alien');
        });

        it('escaped XML-spezifische Zeichen', () => {
            const svg = buildSvg('Movie & <foo>');
            expect(svg).toContain('Movie &amp; &lt;foo&gt;');
            expect(svg).not.toContain('Movie & <foo>');
        });

        it('rendert mehrzeilige Titel mit tspan-Elementen', () => {
            const svg = buildSvg('James Bond 007 - Goldfinger');
            const tspans = svg.match(/<tspan/g) || [];
            expect(tspans.length).toBe(2);
        });
    });

    describe('renderTextClearlogo', () => {
        it('liefert ein gueltiges PNG mit 1200x400 und Alpha-Kanal', async () => {
            const buf = await renderTextClearlogo('Alien: Romulus');
            expect(Buffer.isBuffer(buf)).toBe(true);
            expect(buf.length).toBeGreaterThan(1000);

            const meta = await sharp(buf).metadata();
            expect(meta.format).toBe('png');
            expect(meta.width).toBe(CANVAS_W);
            expect(meta.height).toBe(CANVAS_H);
            expect(meta.hasAlpha).toBe(true);
        });

        it('rendert leere Titel ohne zu crashen', async () => {
            const buf = await renderTextClearlogo('');
            expect(Buffer.isBuffer(buf)).toBe(true);
            const meta = await sharp(buf).metadata();
            expect(meta.format).toBe('png');
        });

        it('rendert sehr lange Titel ohne zu crashen', async () => {
            const longTitle = 'A'.repeat(80);
            const buf = await renderTextClearlogo(longTitle);
            expect(Buffer.isBuffer(buf)).toBe(true);
            const meta = await sharp(buf).metadata();
            expect(meta.width).toBe(CANVAS_W);
            expect(meta.height).toBe(CANVAS_H);
        });
    });
});
