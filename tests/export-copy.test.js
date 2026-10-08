import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportDirForGroup, heldOutputPath, planExportCopy, videoGroupFolder } from '../server/export-copy.js';

const fileExists = (p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); }
    catch { return false; }
};

test('a saved file that is still in the folder is not copied again', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ex-'));
    const file = path.join(root, '1-4.mp4');
    fs.writeFileSync(file, 'already');
    const plan = planExportCopy({
        destRoot: root,
        filename: '1-4.mp4',
        existingDest: file,
        exists: fileExists,
    });
    assert.equal(plan.skip, true);
    assert.equal(plan.name, '1-4.mp4');
    assert.equal(path.resolve(plan.dest), path.resolve(file));
    fs.rmSync(root, { recursive: true, force: true });
});

test('a deleted save is written again under the same name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ex-'));
    const plan = planExportCopy({
        destRoot: root,
        filename: '1-4.mp4',
        existingDest: path.join(root, '1-4.mp4'),
        exists: fileExists,
    });
    assert.equal(plan.skip, false);
    assert.equal(plan.name, '1-4.mp4');
    assert.equal(path.resolve(plan.dest), path.resolve(root, '1-4.mp4'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('a different video with the same name still gets a numbered copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ex-'));
    fs.writeFileSync(path.join(root, '1-4.mp4'), 'other');
    const plan = planExportCopy({
        destRoot: root,
        filename: '1-4.mp4',
        existingDest: '',
        exists: fileExists,
    });
    assert.equal(plan.skip, false);
    assert.equal(plan.name, '1-4 (1).mp4');
    fs.rmSync(root, { recursive: true, force: true });
});

test('a save in another folder does not count as already stored here', () => {
    const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ex-'));
    const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ex-'));
    const previous = path.join(oldRoot, '1-4.mp4');
    fs.writeFileSync(previous, 'old');
    fs.writeFileSync(path.join(newRoot, '1-4.mp4'), 'name taken');
    const plan = planExportCopy({
        destRoot: newRoot,
        filename: '1-4.mp4',
        existingDest: previous,
        exists: fileExists,
    });
    assert.equal(plan.skip, false);
    assert.equal(plan.name, '1-4 (1).mp4');
    fs.rmSync(oldRoot, { recursive: true, force: true });
    fs.rmSync(newRoot, { recursive: true, force: true });
});

test('a source video becomes one folder name under the chosen path', () => {
    assert.equal(
        videoGroupFolder('Nurse Gets Caught Fondling Sedated Patient On Camera [y2lZpust15M].mp4'),
        'Nurse Gets Caught Fondling Sedated Patient On Camera [y2lZpust15M]',
    );
    assert.equal(videoGroupFolder('bad:name?.mp4'), 'bad name');
    assert.equal(videoGroupFolder('..\\..\\Windows'), 'Windows');
    assert.equal(videoGroupFolder('..'), '');
    assert.equal(videoGroupFolder('con.mp4'), 'video con');
    const plan = exportDirForGroup('D:\\Tiktok\\out', 'Nurse Gets Caught.mp4');
    assert.equal(plan.group, 'Nurse Gets Caught');
    assert.equal(plan.dir, path.resolve('D:\\Tiktok\\out', 'Nurse Gets Caught'));
    assert.equal(exportDirForGroup('D:\\Tiktok\\out', '..').error, 'Video name is not a folder name');
});

test('a finished edit file is found only by its own job id', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-ex-'));
    const id = '293ec81eeb8ebd26';
    const file = path.join(root, `${id}_output.mp4`);
    fs.writeFileSync(file, 'part');
    assert.equal(heldOutputPath(root, id), path.resolve(file));
    const id32 = 'a'.repeat(32);
    fs.writeFileSync(path.join(root, `${id32}_output.mp4`), 'part');
    assert.equal(heldOutputPath(root, id32), path.resolve(root, `${id32}_output.mp4`));
    assert.equal(heldOutputPath(root, `${id}.mp4`), '');
    assert.equal(heldOutputPath(root, `..\\${id}`), '');
    assert.equal(heldOutputPath(root, 'b'.repeat(16)), path.resolve(root, `${'b'.repeat(16)}_output.mp4`));
    fs.rmSync(root, { recursive: true, force: true });
});
