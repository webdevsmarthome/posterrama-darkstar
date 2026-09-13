/**
 * scripts/dedup-by-tmdb.js — einmalige Bereinigung doppelter PosterPacks (z-20)
 *
 * Pro TMDB-ID bleibt ein vorhandener Name; gelöschte Namen wandern in eine
 * Quarantäne, Filmliste/Playlists/trailer-info/Scan-Cache werden angepasst und
 * alles lässt sich per Rollback byte-identisch zurückspielen.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dedup = require('../../scripts/dedup-by-tmdb');

const sortDe = list => [...list].sort((a, b) => a.localeCompare(b, 'de'));

const member = (name, extra = {}) => ({
    name,
    zipPath: `/media/complete/tmdb-export/${name}.zip`,
    size: 100,
    mtimeMs: 1,
    cacheMatches: true,
    hasPoster: true,
    releaseYear: null,
    title: name,
    sidecarPath: null,
    trailer: null,
    ...extra,
});

describe('validateReport', () => {
    const now = Date.parse('2026-09-13T12:00:00Z');
    const good = {
        trigger: 'scheduled',
        finishedAt: '2026-09-13T10:00:00Z',
        skipped: [{ key: 'A (2020)', reason: 'has-zip', tmdbId: '1' }],
        added: [],
        ignored: [{ key: 'B (2021)', tmdbId: null }],
    };

    test('gültiger Report liefert die Emby-Namen mit TMDB-ID', () => {
        const result = dedup.validateReport(good, { now });
        expect(result.ok).toBe(true);
        expect([...result.embyNames]).toEqual([
            ['A (2020)', '1'],
            ['B (2021)', null],
        ]);
    });

    test.each([
        ['Testlauf', { ...good, trigger: 'test' }],
        ['alle Server offline', { ...good, result: 'all-offline' }],
        ['zu alt', { ...good, finishedAt: '2026-09-10T10:00:00Z' }],
        ['von vor z-20', { ...good, skipped: [{ key: 'A (2020)', reason: 'has-zip' }] }],
        ['fehlt', null],
    ])('%s → nicht verwendbar', (_label, report) => {
        expect(dedup.validateReport(report, { now }).ok).toBe(false);
    });
});

describe('pickSurvivor', () => {
    test('das Jahr laut TMDB-Erscheinungsdatum gewinnt', () => {
        const group = {
            tmdbId: '72008',
            members: [
                member('Der letzte Fußgänger (1969)', { releaseYear: '1960' }),
                member('Der letzte Fußgänger (1960)', { releaseYear: '1960' }),
            ],
        };
        expect(dedup.pickSurvivor(group)).toMatchObject({
            rule: 'jahr',
            survivor: { name: 'Der letzte Fußgänger (1960)' },
        });
    });

    test('bei gleichem Jahr die Schreibweise, die Emby mit dieser ID liefert', () => {
        const group = {
            tmdbId: '361743',
            members: [member('Top Gun - Maverick (2022)'), member('Top Gun: Maverick (2022)')],
        };
        const embyNames = new Map([['Top Gun: Maverick (2022)', '361743']]);
        expect(dedup.pickSurvivor(group, { embyNames })).toMatchObject({
            rule: 'emby',
            survivor: { name: 'Top Gun: Maverick (2022)' },
        });
    });

    test('Emby-Schutz: ein Emby-Name ohne passende TMDB-ID wird nie gelöscht', () => {
        const group = {
            tmdbId: '81275',
            members: [
                member('Der Mann (1938)', { releaseYear: '1937' }),
                member('Der Mann (1937)', { releaseYear: '1937' }),
            ],
        };
        const embyNames = new Map([['Der Mann (1938)', null]]);
        expect(dedup.pickSurvivor(group, { embyNames })).toMatchObject({
            rule: 'emby-schutz',
            survivor: { name: 'Der Mann (1938)' },
        });
    });

    test('zwei geschützte Emby-Namen → Gruppe wird übersprungen', () => {
        const group = { tmdbId: '5', members: [member('X (2020)'), member('X: (2020)')] };
        const embyNames = new Map([
            ['X (2020)', null],
            ['X: (2020)', null],
        ]);
        expect(dedup.pickSurvivor(group, { embyNames }).survivor).toBeNull();
    });

    test('--keep geht allen Regeln vor', () => {
        const group = {
            tmdbId: '1',
            members: [
                member('A (2019)', { releaseYear: '2020' }),
                member('A (2020)', { releaseYear: '2020' }),
            ],
        };
        expect(dedup.pickSurvivor(group, { keep: new Set(['A (2019)']) })).toMatchObject({
            rule: 'keep',
            survivor: { name: 'A (2019)' },
        });
    });

    test('ohne weitere Merkmale entscheidet die ZIP-Größe', () => {
        const group = {
            tmdbId: '1',
            members: [member('A (2020)', { size: 10 }), member('A: (2020)', { size: 20 })],
        };
        expect(dedup.pickSurvivor(group)).toMatchObject({
            rule: 'größe',
            survivor: { name: 'A: (2020)' },
        });
    });
});

describe('rewriteFilmList', () => {
    test('eine Zeile pro TMDB-ID, Doppelzeilen und gelöschte Namen weg, Rest bleibt', () => {
        const lines = [
            'Top Gun - Maverick (2022)[tmdb:361743]',
            'Top Gun: Maverick (2022)[tmdb:361743]',
            'Stirb langsam 4.0 (2007)[tmdb:1571]',
            'Stirb langsam 4.0 (2007)[tmdb:1571]',
            'Ohne Hint (2026)',
            'Total Recall - Die Totale Erinnerung (1990)',
        ];
        const result = dedup.rewriteFilmList(lines, {
            survivorById: new Map([
                ['361743', 'Top Gun - Maverick (2022)'],
                ['861', 'Total Recall - Die totale Erinnerung (1990)'],
            ]),
            nameMap: new Map([
                ['Top Gun: Maverick (2022)', 'Top Gun - Maverick (2022)'],
                [
                    'Total Recall - Die Totale Erinnerung (1990)',
                    'Total Recall - Die totale Erinnerung (1990)',
                ],
            ]),
        });
        expect(result).toEqual(
            sortDe([
                'Ohne Hint (2026)',
                'Stirb langsam 4.0 (2007)[tmdb:1571]',
                'Top Gun - Maverick (2022)[tmdb:361743]',
                'Total Recall - Die totale Erinnerung (1990)[tmdb:861]',
            ])
        );
    });
});

describe('rewritePlaylists', () => {
    test('lenkt auf den Überlebenden um, entfernt entstehende Doppel, lässt fremde Doppel', () => {
        const nameMap = new Map([['Top Gun: Maverick (2022)', 'Top Gun - Maverick (2022)']]);
        const collection = {
            activePlaylistId: 'a',
            playlists: {
                a: {
                    name: 'A',
                    titles: [
                        'Top Gun - Maverick (2022)',
                        'Top Gun: Maverick (2022)',
                        'Avatar (2009)',
                    ],
                },
                b: { name: 'B', titles: ['Top Gun: Maverick (2022)'] },
                c: { name: 'C', titles: ['Avatar (2009)', 'Avatar (2009)'] },
            },
        };
        const live = { enabled: true, titles: ['Top Gun: Maverick (2022)'] };

        const result = dedup.rewritePlaylists(collection, live, nameMap);

        expect(result.collection.playlists.a.titles).toEqual([
            'Top Gun - Maverick (2022)',
            'Avatar (2009)',
        ]);
        expect(result.collection.playlists.b.titles).toEqual(['Top Gun - Maverick (2022)']);
        expect(result.collection.playlists.c.titles).toEqual(['Avatar (2009)', 'Avatar (2009)']);
        expect(result.changedPlaylists).toEqual(['a', 'b']);
        expect(result.changedEntries).toBe(3);
        expect(result.live.titles).toEqual(['Top Gun - Maverick (2022)']);
        // Eingabe bleibt unverändert
        expect(collection.playlists.b.titles).toEqual(['Top Gun: Maverick (2022)']);
    });
});

describe('Bereinigung im Dateisystem: Plan → Ausführen → Rollback', () => {
    let root;
    let paths;

    const write = (rel, content) => {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return file;
    };

    const snapshot = (dir = root, out = {}) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== paths.quarantineRoot) snapshot(full, out);
            } else {
                out[path.relative(root, full)] = fs.readFileSync(full).toString('base64');
            }
        }
        return out;
    };

    const noChecks = { checkJobs: () => '', checkServer: async () => false };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-tmdb-'));
        paths = {
            root,
            cacheFile: path.join(root, 'cache', 'zip-scan-cache.json'),
            filmListFile: path.join(root, 'poster-updater', 'filmliste.txt'),
            reportFile: path.join(root, 'cache', 'emby-sync-last-report.json'),
            trailerDir: path.join(root, 'media', 'trailers'),
            trailerInfoFile: path.join(root, 'media', 'trailers', 'trailer-info.json'),
            playlistsFile: path.join(root, 'public', 'cinema-playlists.json'),
            livePlaylistFile: path.join(root, 'public', 'cinema-playlist.json'),
            quarantineRoot: path.join(root, 'quarantine'),
        };
        const pack = 'media/complete/tmdb-export';

        // Gruppe 1: Jahr entscheidet, identische Trailer-Kopie, Sidecar
        const jaeger55 = write(`${pack}/Der Jäger (1955).zip`, 'zip-1955');
        const jaeger56 = write(`${pack}/Der Jäger (1956).zip`, 'zip-1956');
        write(`${pack}/Der Jäger (1955).poster.json`, '{}');
        write('media/trailers/Der Jäger (1955)-trailer.mp4', 'gleicher-trailer');
        write('media/trailers/Der Jäger (1956)-trailer.mp4', 'gleicher-trailer');
        // Gruppe 2: Emby entscheidet, nur der gelöschte Name hat einen Trailer
        const verdunkelung = write(`${pack}/Verdunkelung (1976).zip`, 'zip-v');
        const eisenbahn = write(`${pack}/Der Eisenbahnmörder (1976).zip`, 'zip-e');
        write('media/trailers/Der Eisenbahnmörder (1976)-trailer.mp4', 'trailer-eisenbahn');
        // Gruppe 3: Filmliste entscheidet, der gelöschte Name hat das bessere Label
        const werner = write(`${pack}/Werner - Beinhart! (1990).zip`, 'zip-w1');
        const wernerOhne = write(`${pack}/Werner - Beinhart (1990).zip`, 'zip-w2');
        write('media/trailers/Werner - Beinhart! (1990)-trailer.mp4', 'trailer-en');
        write('media/trailers/Werner - Beinhart (1990)-trailer.mp4', 'trailer-de-offiziell');
        // Unbeteiligt
        const avatar = write(`${pack}/Avatar (2009).zip`, 'zip-avatar');

        const entry = (file, tmdbId, releaseDate) => {
            const st = fs.statSync(file);
            return { m: st.mtimeMs, s: st.size, h: { poster: true }, z: { tmdbId, releaseDate } };
        };
        write(
            'cache/zip-scan-cache.json',
            JSON.stringify({
                [jaeger55]: entry(jaeger55, 258860, '1956-03-01'),
                [jaeger56]: entry(jaeger56, 258860, '1956-03-01'),
                [verdunkelung]: entry(verdunkelung, 391565, '1976-01-01'),
                [eisenbahn]: entry(eisenbahn, 391565, '1976-01-01'),
                [werner]: entry(werner, 3000, '1990-01-01'),
                [wernerOhne]: entry(wernerOhne, 3000, '1990-01-01'),
                [avatar]: entry(avatar, 19995, '2009-12-10'),
            })
        );
        write(
            'poster-updater/filmliste.txt',
            [
                'Avatar (2009)[tmdb:19995]',
                'Der Eisenbahnmörder (1976)[tmdb:391565]',
                'Der Jäger (1955)[tmdb:258860]',
                'Der Jäger (1956)[tmdb:258860]',
                'Verdunkelung (1976)[tmdb:391565]',
                'Werner - Beinhart! (1990)[tmdb:3000]',
                'Werner - Beinhart! (1990)[tmdb:3000]',
            ].join('\n') + '\n'
        );
        write(
            'cache/emby-sync-last-report.json',
            JSON.stringify({
                trigger: 'scheduled',
                finishedAt: new Date().toISOString(),
                skipped: [
                    { key: 'Verdunkelung (1976)', reason: 'has-zip', tmdbId: '391565' },
                    { key: 'Avatar (2009)', reason: 'has-zip', tmdbId: '19995' },
                ],
                added: [],
                ignored: [],
            })
        );
        write(
            'media/trailers/trailer-info.json',
            JSON.stringify({
                'Der Eisenbahnmörder (1976)': 'DE',
                'Der Jäger (1955)': 'DE',
                'Der Jäger (1956)': 'DE',
                'Werner - Beinhart (1990)': 'DE-offiziell',
                'Werner - Beinhart! (1990)': 'EN',
            })
        );
        write(
            'public/cinema-playlists.json',
            JSON.stringify({
                activePlaylistId: 'x',
                playlists: {
                    x: {
                        name: 'X',
                        titles: [
                            'Der Eisenbahnmörder (1976)',
                            'Verdunkelung (1976)',
                            'Avatar (2009)',
                        ],
                    },
                },
            })
        );
        write(
            'public/cinema-playlist.json',
            JSON.stringify({ enabled: true, titles: ['Werner - Beinhart (1990)'] })
        );
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('Plan: bleibende Namen, Regeln und neue Filmliste', async () => {
        const inputs = await dedup.loadInputs(paths);
        const plan = dedup.buildDedupPlan(inputs, { paths });

        expect(plan.errors).toEqual([]);
        expect(plan.reportOk).toBe(true);
        const bySurvivor = Object.fromEntries(plan.groups.map(g => [g.survivor, g]));
        expect(bySurvivor['Der Jäger (1956)']).toMatchObject({
            rule: 'jahr',
            losers: ['Der Jäger (1955)'],
        });
        expect(bySurvivor['Verdunkelung (1976)']).toMatchObject({
            rule: 'emby',
            losers: ['Der Eisenbahnmörder (1976)'],
        });
        expect(bySurvivor['Werner - Beinhart! (1990)']).toMatchObject({
            rule: 'filmliste',
            losers: ['Werner - Beinhart (1990)'],
        });
        expect(plan.filmList.lines).toEqual(
            sortDe([
                'Avatar (2009)[tmdb:19995]',
                'Der Jäger (1956)[tmdb:258860]',
                'Verdunkelung (1976)[tmdb:391565]',
                'Werner - Beinhart! (1990)[tmdb:3000]',
            ])
        );
    });

    test('Ausführen bereinigt alles, Rollback stellt den Ausgangszustand byte-identisch her', async () => {
        const before = snapshot();
        const inputs = await dedup.loadInputs(paths);
        const plan = dedup.buildDedupPlan(inputs, { paths });

        const result = await dedup.executePlan(plan, inputs, paths, {
            expectPlan: plan.hash,
            ...noChecks,
        });

        const exists = rel => fs.existsSync(path.join(root, rel));
        const trailer = name => fs.readFileSync(path.join(paths.trailerDir, name), 'utf8');
        expect(exists('media/complete/tmdb-export/Der Jäger (1955).zip')).toBe(false);
        expect(exists('media/complete/tmdb-export/Der Jäger (1955).poster.json')).toBe(false);
        expect(exists('media/trailers/Der Jäger (1955)-trailer.mp4')).toBe(false);
        expect(trailer('Der Jäger (1956)-trailer.mp4')).toBe('gleicher-trailer');
        expect(trailer('Verdunkelung (1976)-trailer.mp4')).toBe('trailer-eisenbahn');
        expect(trailer('Werner - Beinhart! (1990)-trailer.mp4')).toBe('trailer-de-offiziell');
        expect(exists('media/trailers/Werner - Beinhart (1990)-trailer.mp4')).toBe(false);

        expect(JSON.parse(fs.readFileSync(paths.trailerInfoFile, 'utf8'))).toEqual({
            'Der Jäger (1956)': 'DE',
            'Verdunkelung (1976)': 'DE',
            'Werner - Beinhart! (1990)': 'DE-offiziell',
        });
        expect(JSON.parse(fs.readFileSync(paths.playlistsFile, 'utf8')).playlists.x.titles).toEqual(
            ['Verdunkelung (1976)', 'Avatar (2009)']
        );
        expect(JSON.parse(fs.readFileSync(paths.livePlaylistFile, 'utf8')).titles).toEqual([
            'Werner - Beinhart! (1990)',
        ]);
        const cacheNames = Object.keys(JSON.parse(fs.readFileSync(paths.cacheFile, 'utf8'))).map(
            key => path.basename(key)
        );
        expect(sortDe(cacheNames)).toEqual(
            sortDe([
                'Avatar (2009).zip',
                'Der Jäger (1956).zip',
                'Verdunkelung (1976).zip',
                'Werner - Beinhart! (1990).zip',
            ])
        );
        expect(fs.readFileSync(paths.filmListFile, 'utf8')).toBe(
            plan.filmList.lines.join('\n') + '\n'
        );
        expect(fs.existsSync(path.join(result.quarantineDir, 'manifest.json'))).toBe(true);

        const undo = await dedup.rollback(result.quarantineDir, { log: () => {} });
        expect(undo.problems).toEqual([]);
        expect(snapshot()).toEqual(before);
    });

    test('Preflight bricht ohne Änderung ab: falscher Hash, laufender Server, laufender Job', async () => {
        const before = snapshot();
        const inputs = await dedup.loadInputs(paths);
        const plan = dedup.buildDedupPlan(inputs, { paths });

        await expect(
            dedup.executePlan(plan, inputs, paths, { expectPlan: 'falsch', ...noChecks })
        ).rejects.toThrow(/Plan-Hash/);
        await expect(
            dedup.executePlan(plan, inputs, paths, {
                expectPlan: plan.hash,
                checkJobs: () => '',
                checkServer: async () => true,
            })
        ).rejects.toThrow(/Server läuft/);
        await expect(
            dedup.executePlan(plan, inputs, paths, {
                expectPlan: plan.hash,
                checkJobs: () => '4711 python3 poster-updater/download-trailers.py',
                checkServer: async () => false,
            })
        ).rejects.toThrow(/Pipeline-Job/);

        expect(snapshot()).toEqual(before);
        expect(fs.existsSync(paths.quarantineRoot)).toBe(false);
    });

    test('ohne gültigen Emby-Report ist --execute gesperrt', async () => {
        fs.writeFileSync(paths.reportFile, JSON.stringify({ trigger: 'test', skipped: [] }));
        const inputs = await dedup.loadInputs(paths);
        const plan = dedup.buildDedupPlan(inputs, { paths });

        expect(plan.reportOk).toBe(false);
        await expect(
            dedup.executePlan(plan, inputs, paths, { expectPlan: plan.hash, ...noChecks })
        ).rejects.toThrow(/Emby-Report/);
    });
});
