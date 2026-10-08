import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createUniqueHoldStore, uniqueHoldJobId } from '../server/unique-hold.js';

function tempHold() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-hold-'));
    const uploads = path.join(dir, 'uploads');
    fs.mkdirSync(uploads);
    const store = createUniqueHoldStore(path.join(uploads, 'unique-hold.json'), { uploadsDir: uploads });
    return { dir, uploads, store };
}

function touch(uploads, jobId) {
    fs.writeFileSync(path.join(uploads, `${jobId}_output.mp4`), 'mp4');
}

test('unique hold keeps a finished unsaved render and drops a missing file', () => {
    const { dir, uploads, store } = tempHold();
    const jobId = 'a'.repeat(32);
    assert.equal(store.remember({ jobId, name: 'Clip one.mp4', originalName: 'source.mp4', stats: { newSize: 12 } }), false);
    touch(uploads, jobId);
    assert.equal(store.remember({
        jobId,
        name: 'Clip one.mp4',
        originalName: 'source.mov',
        stats: { newSize: 12, originalSize: 20 },
    }), true);
    const listed = store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Clip one.mp4');
    assert.equal(listed[0].originalName, 'source.mp4');
    assert.equal(listed[0].stats.newSize, 12);
    const finishedAt = listed[0].finishedAt;
    assert.equal(store.remember({ jobId, name: 'Renamed.mp4', stats: { newSize: 15 } }), true);
    assert.equal(store.list()[0].name, 'Renamed.mp4');
    assert.equal(store.list()[0].finishedAt, finishedAt);
    assert.equal(store.list()[0].stats.newSize, 15);

    fs.rmSync(path.join(uploads, `${jobId}_output.mp4`));
    assert.deepEqual(store.list(), []);
    const raw = JSON.parse(fs.readFileSync(path.join(uploads, 'unique-hold.json'), 'utf8'));
    assert.deepEqual(raw.items, []);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('unique hold rejects a path-like id and restores download state once', () => {
    const { dir, uploads, store } = tempHold();
    assert.equal(uniqueHoldJobId('../etc/passwd'), '');
    assert.equal(store.remember({ jobId: '../etc/passwd', name: 'no.mp4' }), false);
    assert.equal(store.forget('../etc/passwd'), false);

    const jobId = 'b'.repeat(32);
    touch(uploads, jobId);
    fs.writeFileSync(path.join(uploads, `${jobId}_cmp_proc.jpg`), 'jpg');
    store.remember({ jobId, name: 'kept.mp4', originalName: 'orig.mp4', stats: { originalSize: 9 } });
    assert.equal(store.rename(jobId, 'kept again.mp4'), true);
    assert.equal(store.rename('c'.repeat(32), 'other.mp4'), false);

    const jobs = new Map();
    jobs.set(jobId, { outputPath: 'live', status: 'running' });
    assert.equal(store.rehydrate(jobs), 0);
    assert.equal(jobs.get(jobId).outputPath, 'live');
    jobs.delete(jobId);
    assert.equal(store.rehydrate(jobs), 1);
    const job = jobs.get(jobId);
    assert.equal(job.held, true);
    assert.equal(job.status, 'done');
    assert.equal(job.streamState.finished, true);
    assert.equal(job.outputPath, path.resolve(uploads, `${jobId}_output.mp4`));
    assert.equal(job.compare.proc, path.resolve(uploads, `${jobId}_cmp_proc.jpg`));
    assert.equal(job.compare.orig, undefined);
    assert.equal(store.rehydrate(jobs), 0);

    assert.equal(store.forget(jobId), true);
    assert.equal(store.forget(jobId), false);
    assert.equal(store.list().length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('unique hold ignores a corrupt file', () => {
    const { dir, uploads, store } = tempHold();
    fs.writeFileSync(path.join(uploads, 'unique-hold.json'), '{');
    assert.deepEqual(store.list(), []);
    fs.rmSync(dir, { recursive: true, force: true });
});
