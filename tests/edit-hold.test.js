import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createEditHoldStore } from '../server/edit-hold.js';

function tempHold(maxItems) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-edit-hold-'));
    const uploads = path.join(dir, 'uploads');
    fs.mkdirSync(uploads);
    const store = createEditHoldStore(path.join(uploads, 'edit-hold.json'), { uploadsDir: uploads, maxItems });
    return { dir, uploads, store };
}

function touch(uploads, jobId) {
    fs.writeFileSync(path.join(uploads, `${jobId}_output.mp4`), 'mp4');
}

test('edit hold keeps a finished unsaved part and drops a missing file', () => {
    const { dir, uploads, store } = tempHold();
    const jobId = 'a'.repeat(16);
    assert.equal(store.remember({ jobId, sourceName: 'Show.mp4', name: '1.Part.mp4' }), false);
    touch(uploads, jobId);
    assert.equal(store.remember({
        jobId,
        sourceName: 'Show.mp4',
        sourcePath: 'D:\\clips\\Show.mp4',
        partIndex: 1,
        name: '1.Part.mp4',
        title: 'Part one',
        titleVi: 'Tập một',
        script: '0-70',
        start: 0,
        end: 70,
        dur: 70,
        ranges: [[0, 70], ['nope', 1]],
        qa: { score: 74.2, grade: 'kha', warnings: ['crop đứng yên'] },
    }), true);
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sourceName, 'Show.mp4');
    assert.equal(listed[0].name, '1.Part.mp4');
    assert.equal(listed[0].qa.score, 74);
    assert.deepEqual(listed[0].ranges, [[0, 70]]);
    const finishedAt = listed[0].finishedAt;
    assert.equal(store.remember({ jobId, sourceName: 'Show.mp4', name: '1.Renamed.mp4', qa: { score: 80, grade: 'kha', warnings: [] } }), true);
    assert.equal(store.list()[0].name, '1.Renamed.mp4');
    assert.equal(store.list()[0].finishedAt, finishedAt);

    fs.rmSync(path.join(uploads, `${jobId}_output.mp4`));
    assert.deepEqual(store.list(), []);
    const raw = JSON.parse(fs.readFileSync(path.join(uploads, 'edit-hold.json'), 'utf8'));
    assert.deepEqual(raw.items, []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('edit hold rejects a path-like id and restores the part once', () => {
    const { dir, uploads, store } = tempHold();
    assert.equal(store.remember({ jobId: '../etc/passwd', name: 'no.mp4' }), false);
    assert.equal(store.forget('../etc/passwd'), false);

    const jobId = 'b'.repeat(32);
    touch(uploads, jobId);
    const source = path.join(dir, 'source.mp4');
    fs.writeFileSync(source, 'src');
    store.remember({ jobId, sourceName: 'Source.mp4', sourcePath: source, name: '2.Part.mp4', partIndex: 2 });

    const jobs = new Map();
    jobs.set(jobId, { outputPath: 'live', status: 'running' });
    assert.equal(store.rehydrate(jobs), 0);
    assert.equal(jobs.get(jobId).outputPath, 'live');
    jobs.delete(jobId);
    assert.equal(store.rehydrate(jobs), 1);
    const job = jobs.get(jobId);
    assert.equal(job.kind, 'edit-part');
    assert.equal(job.keepInput, true);
    assert.equal(job.held, true);
    assert.equal(job.status, 'done');
    assert.equal(job.streamState.finished, true);
    assert.equal(job.outputPath, path.resolve(uploads, `${jobId}_output.mp4`));
    assert.equal(job.inputPath, source);
    assert.equal(job.originalName, '2.Part.mp4');
    assert.equal(store.rehydrate(jobs), 0);

    assert.equal(store.forget(jobId), true);
    assert.equal(store.forget(jobId), false);
    assert.equal(store.list().length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('edit hold keeps the newest parts when the list is past the cap', () => {
    const { dir, uploads, store } = tempHold(2);
    const stamps = ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'];
    for (const [index, id] of ['c', 'd', 'e'].entries()) {
        const jobId = id.repeat(16);
        touch(uploads, jobId);
        store.remember({
            jobId,
            sourceName: 'Show.mp4',
            name: `${id}.mp4`,
            partIndex: id.charCodeAt(0),
            finishedAt: stamps[index],
        });
    }
    const names = store.list().map((item) => item.name);
    assert.deepEqual(names, ['d.mp4', 'e.mp4']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('edit hold ignores a corrupt file', () => {
    const { dir, uploads, store } = tempHold();
    fs.writeFileSync(path.join(uploads, 'edit-hold.json'), '{');
    assert.deepEqual(store.list(), []);
    fs.rmSync(dir, { recursive: true, force: true });
});
