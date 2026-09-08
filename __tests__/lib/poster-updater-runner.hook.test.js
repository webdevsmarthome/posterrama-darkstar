/**
 * setOnTrailerJobDone() in lib/poster-updater-runner.js
 *
 * Nach einem Trailer-Lauf soll server.js die Playlist neu bauen koennen,
 * damit frische Trailer (und der requireTrailer-Filter) sofort greifen.
 * Der Hook feuert im close-Handler mit der geparsten TRAILER-SUMMARY.
 */

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const runner = require('../../lib/poster-updater-runner');

function makeProc(pid = 4242) {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = pid;
    return proc;
}

describe('setOnTrailerJobDone', () => {
    let proc;

    beforeEach(() => {
        runner.__reset();
        jest.clearAllMocks();
        proc = makeProc();
        spawn.mockReturnValue(proc);
    });

    test('Hook feuert nach close mit Code und geparster Summary', () => {
        const hook = jest.fn();
        runner.setOnTrailerJobDone(hook);

        expect(runner.spawnTrailerJob().started).toBe(true);
        proc.stdout.emit(
            'data',
            Buffer.from(
                'TRAILER-SUMMARY downloaded=2 skipped=1280 no_trailer=40 failed=1 total=1323 searched=1\n'
            )
        );
        proc.emit('close', 0);

        expect(hook).toHaveBeenCalledTimes(1);
        const arg = hook.mock.calls[0][0];
        expect(arg.code).toBe(0);
        expect(arg.summary).toMatchObject({ downloaded: 2, failed: 1, searched: 1 });
        expect(runner.isTrailerRunning()).toBe(false);
    });

    test('Hook bekommt summary=null, wenn das Script ohne Ergebniszeile abbricht', () => {
        const hook = jest.fn();
        runner.setOnTrailerJobDone(hook);

        runner.spawnTrailerJob();
        proc.emit('close', 1);

        expect(hook).toHaveBeenCalledWith({ code: 1, summary: null });
    });

    test('werfender Hook bricht den Job-Teardown nicht ab', () => {
        runner.setOnTrailerJobDone(() => {
            throw new Error('boom');
        });

        runner.spawnTrailerJob();
        expect(() => proc.emit('close', 0)).not.toThrow();
        expect(runner.isTrailerRunning()).toBe(false);

        // Neuer Lauf ist danach moeglich
        const proc2 = makeProc(4343);
        spawn.mockReturnValue(proc2);
        expect(runner.spawnTrailerJob().started).toBe(true);
    });

    test('__reset entfernt den Hook; Nicht-Funktionen deregistrieren ihn', () => {
        const hook = jest.fn();
        runner.setOnTrailerJobDone(hook);
        runner.__reset();

        spawn.mockReturnValue(proc);
        runner.spawnTrailerJob();
        proc.emit('close', 0);
        expect(hook).not.toHaveBeenCalled();

        runner.setOnTrailerJobDone(hook);
        runner.setOnTrailerJobDone(null);
        const proc2 = makeProc(4343);
        spawn.mockReturnValue(proc2);
        runner.spawnTrailerJob();
        proc2.emit('close', 0);
        expect(hook).not.toHaveBeenCalled();
    });
});
