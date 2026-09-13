/**
 * appendFilms() in lib/poster-updater-runner.js — TMDB-ID-Abgleich (z-20)
 *
 * Die zwei Emby-Server benennen denselben Film teils unterschiedlich. appendFilms
 * verglich nur Titel+Jahr; so entstanden 43 Doppel-Paare mit gleicher [tmdb:N]-ID
 * und 10 wortgleiche Doppelzeilen.
 */

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../../lib/poster-updater-runner');

let dir;
let filePath;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filmliste-'));
    filePath = path.join(dir, 'filmliste.txt');
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const writeList = lines => fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
const readList = () => fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);

test('gleiche TMDB-ID unter anderem Titel wird nicht angehängt', async () => {
    writeList(['Top Gun - Maverick (2022)[tmdb:361743]']);

    const result = await runner.appendFilms(['Top Gun: Maverick (2022)[tmdb:361743]'], {
        filePath,
    });

    expect(result.added).toEqual([]);
    expect(result.duplicateIds).toEqual([
        {
            entry: 'Top Gun: Maverick (2022)[tmdb:361743]',
            existing: 'Top Gun - Maverick (2022)[tmdb:361743]',
        },
    ]);
    expect(readList()).toEqual(['Top Gun - Maverick (2022)[tmdb:361743]']);
});

test('doppelte ID innerhalb derselben Charge: nur der erste Eintrag kommt dazu', async () => {
    writeList(['Andere (2020)[tmdb:1]']);

    const result = await runner.appendFilms(
        ['Wicked (2024)[tmdb:402431]', 'Wicked Teil 1 (2024)[tmdb:402431]'],
        { filePath }
    );

    expect(result.added).toEqual(['Wicked (2024)[tmdb:402431]']);
    expect(result.duplicateIds).toHaveLength(1);
    expect(readList()).toEqual(['Andere (2020)[tmdb:1]', 'Wicked (2024)[tmdb:402431]']);
});

test('Upgrade einer Zeile ohne Hint wird blockiert, wenn die ID schon woanders hängt', async () => {
    writeList(['E.T. - Der Außerirdische (1982)[tmdb:601]', 'E.T. - Der Ausserirdische (1982)']);

    const result = await runner.appendFilms(['E.T. - Der Ausserirdische (1982)[tmdb:601]'], {
        filePath,
    });

    expect(result.upgraded).toEqual([]);
    expect(result.duplicateIds).toHaveLength(1);
    expect(readList()).toContain('E.T. - Der Ausserirdische (1982)');
});

test('Upgrade ohne ID-Konflikt funktioniert weiterhin', async () => {
    writeList(['Dune (2021)']);

    const result = await runner.appendFilms(['Dune (2021)[tmdb:438631]'], { filePath });

    expect(result.upgraded).toEqual(['Dune (2021)[tmdb:438631]']);
    expect(readList()).toEqual(['Dune (2021)[tmdb:438631]']);
});

test('wortgleiche Doppelzeilen werden beim Schreiben entfernt', async () => {
    writeList(['Stirb langsam 4.0 (2007)[tmdb:1571]', 'Stirb langsam 4.0 (2007)[tmdb:1571]']);

    const result = await runner.appendFilms(['Neu (2026)[tmdb:9]'], { filePath });

    expect(result.removedExactDuplicates).toBe(1);
    expect(readList()).toEqual(['Neu (2026)[tmdb:9]', 'Stirb langsam 4.0 (2007)[tmdb:1571]']);
});

test('ohne Änderung wird nicht geschrieben', async () => {
    writeList(['Avatar (2009)[tmdb:19995]']);
    const spy = jest.spyOn(fs.promises, 'writeFile');
    try {
        const result = await runner.appendFilms(['Avatar (2009)[tmdb:19995]'], { filePath });
        expect(result.duplicates).toHaveLength(1);
        expect(spy).not.toHaveBeenCalled();
    } finally {
        spy.mockRestore();
    }
});

test('schreibt atomar, ohne tmp-Reste', async () => {
    writeList(['A (2020)[tmdb:1]']);

    await runner.appendFilms(['B (2021)[tmdb:2]'], { filePath });

    expect(fs.readdirSync(dir)).toEqual(['filmliste.txt']);
    expect(readList()).toEqual(['A (2020)[tmdb:1]', 'B (2021)[tmdb:2]']);
});
