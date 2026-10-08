import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelStore } from '../server/youtube-channel-store.js';
import { createYoutubeChannels } from '../server/youtube-channels.js';
import { createYoutubeImport } from '../server/youtube-import.js';
import {
  concatCanvas,
  concatFileName,
  concatFilter,
  concatRequest,
  localVideos,
} from '../server/youtube-concat.js';
import { normalizeEditProfile } from '../src/lib/edit-profile.js';
import {
  editFor,
  findChain,
  presetFor,
  presetSource,
  saveChainEdit,
  saveChainPreset,
  saveChannelEdit,
  saveChannelPreset,
} from '../src/lib/youtube-concat-config.js';
import { youtubeWatchUrl } from '../src/lib/youtube-watch.js';

const CHANNEL = `UC${'a'.repeat(22)}`;
const KEY = `${CHANNEL}:videos`;
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';

test('local numbers follow the channel from newest and skip files that are not on disk', () => {
  const entries = [
    { id: A, title: 'Moi' },
    { id: B, title: 'Giua' },
    { id: C, title: 'Cu' },
  ];
  const files = [{ id: C, title: 'file cu' }, { id: A, title: 'file moi' }];
  assert.deepEqual(localVideos(entries, files), [
    { id: A, title: 'Moi' },
    { id: C, title: 'Cu' },
  ]);
  assert.equal(localVideos(entries, [{ id: 'not-an-id', title: 'x' }]).length, 0);
});

test('a concat name keeps the clicked order and the canvas stays even', () => {
  const asked = concatRequest([B, A], [2, 1]);
  assert.equal(asked.ok, true);
  assert.deepEqual(asked.ids, [B, A]);
  assert.equal(concatFileName(asked.label), 'Ghep 2-1.mp4');
  assert.equal(concatRequest([A]).code, 'few');
  assert.equal(concatRequest([A, A]).code, 'few');
  assert.deepEqual(concatCanvas([
    { width: 1081, height: 1919, fps: 30 },
    { width: 640, height: 360, fps: 24 },
  ]), { width: 1082, height: 1920, fps: 30 });
  const filter = concatFilter(2, 1082, 1920, 30);
  assert.equal(filter.includes('scale=1082:1920'), true);
  assert.equal(filter.includes('concat=n=2:v=1:a=1'), true);
});

test('concat copies when the files match and leaves the originals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-concat-'));
  const folder = path.join(root, 'save');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, `Moi [${A}].mp4`), Buffer.alloc(200));
  fs.writeFileSync(path.join(folder, `Cu [${B}].mp4`), Buffer.alloc(200));
  const store = createChannelStore(path.join(root, 'youtube-channels.json'));
  store.remember({ key: KEY, title: 'Kenh', url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  store.setFolder(KEY, folder);
  const calls = [];
  const api = createYoutubeChannels({
    store,
    importRoot: path.join(root, 'youtube-import'),
    resolveTools: async () => ({ ffmpeg: { ok: true, path: 'ffmpeg' } }),
    runProcess: async (_command, args) => {
      calls.push(args);
      if (args.includes('copy')) {
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(200));
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'should not encode' };
    },
  });
  const out = await api.concat(KEY, { ids: [B, A], marks: [2, 1], sharedFolder: folder });
  assert.equal(out.status, 200);
  assert.equal(out.body.name, 'Ghep 2-1.mp4');
  assert.equal(out.body.mode, 'copy');
  assert.equal(fs.existsSync(path.join(folder, 'Ghep 2-1.mp4')), true);
  assert.equal(fs.existsSync(path.join(folder, `Moi [${A}].mp4`)), true);
  assert.equal(fs.existsSync(path.join(folder, `Cu [${B}].mp4`)), true);
  assert.equal(calls.length, 1);
  assert.equal(store.downloadedIds().length, 0);

  calls.length = 0;
  const missing = await api.concat(KEY, { ids: [A, C], marks: [1, 2] });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'file');
  assert.equal(calls.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('concat re-encodes when a straight copy fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-concat-enc-'));
  const folder = path.join(root, 'save');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, `A [${A}].mp4`), Buffer.alloc(200));
  fs.writeFileSync(path.join(folder, `B [${B}].mp4`), Buffer.alloc(200));
  const store = createChannelStore(path.join(root, 'youtube-channels.json'));
  store.remember({ key: KEY, title: 'Kenh', url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  const probes = [];
  const api = createYoutubeChannels({
    store,
    importRoot: path.join(root, 'youtube-import'),
    resolveTools: async () => ({ ffmpeg: { ok: true, path: 'ffmpeg' } }),
    runProcess: async (_command, args) => {
      if (args.includes('copy')) return { status: 1, stdout: '', stderr: 'mismatch' };
      if (args.includes('-i') && !args.includes('-filter_complex')) {
        probes.push(args[args.length - 1]);
        return { status: 1, stdout: '', stderr: 'Stream #0:0: Video: h264, 1080x1920, 30 fps\nStream #0:1: Audio: aac\n' };
      }
      const filter = args[args.indexOf('-filter_complex') + 1];
      assert.equal(filter.includes('concat=n=2'), true);
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(200));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const out = await api.concat(KEY, { ids: [A, B], marks: [1, 2], sharedFolder: folder });
  assert.equal(out.status, 200);
  assert.equal(out.body.mode, 'encode');
  assert.equal(probes.length, 2);
  assert.equal(fs.existsSync(path.join(folder, `A [${A}].mp4`)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a held concat copy can be deleted without removing the saved file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-hold-'));
  const source = path.join(root, 'Ghep 1-2.mp4');
  fs.writeFileSync(source, Buffer.alloc(200));
  const api = createYoutubeImport({
    uploadsDir: root,
    jobs: new Map(),
    subscribeJob: () => {},
    runProcess: async () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const held = await callJson(api.holdHandler, { body: { path: source } });
  assert.equal(held.status, 200);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(held.body.file.path), true);
  assert.equal(held.body.file.path.includes(`${path.sep}youtube-import${path.sep}`), true);
  const inside = await callJson(api.holdHandler, { body: { path: held.body.file.path } });
  assert.equal(inside.status, 400);
  const removed = await callJson(api.deleteHandler, { params: { jobId: held.body.jobId } });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(held.body.file.path), false);
  assert.equal(fs.existsSync(source), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a channel preset wins over the shared chain, and a watch link is one video', () => {
  let config = saveChainPreset({}, KEY, 'Nhom', 'chainpreset');
  config = saveChannelPreset(config, KEY, 'ownpreset');
  assert.equal(presetFor(config, KEY), 'ownpreset');
  config = saveChannelPreset(config, KEY, '');
  assert.equal(presetFor(config, KEY), 'chainpreset');
  const edit = normalizeEditProfile({ mode: 'even', prompt: 'cat ngan', split: 4 });
  config = saveChainEdit(config, KEY, 'Nhom', { mode: 'ai', prompt: 'chuoi' });
  config = saveChannelEdit(config, KEY, edit);
  assert.equal(editFor(config, KEY).mode, 'even');
  assert.equal(editFor(config, KEY).prompt, 'cat ngan');
  assert.equal(editFor(config, KEY).split, 4);
  config = saveChannelEdit(config, KEY, null);
  assert.equal(editFor(config, KEY).prompt, 'chuoi');
  assert.equal(findChain(config, ' nhom ').presetId, 'chainpreset');
  const other = `UC${'b'.repeat(22)}:videos`;
  config = saveChainPreset(config, other, 'Nhom', 'rap');
  assert.equal(findChain(config, 'NHOM').presetId, 'rap');
  assert.equal(presetFor(config, KEY), 'rap');
  assert.equal(presetFor(config, other), 'rap');
  assert.deepEqual(presetSource(config, other), { kind: 'chain', presetId: 'rap', chainName: 'Nhom' });
  config = saveChannelPreset(config, other, 'ownpreset');
  assert.deepEqual(presetSource(config, other), { kind: 'channel', presetId: 'ownpreset', chainName: 'Nhom' });
  assert.deepEqual(presetSource(config, 'nope'), { kind: 'none', presetId: '', chainName: '' });
  assert.equal(youtubeWatchUrl(A), `https://www.youtube.com/watch?v=${A}`);
  assert.equal(youtubeWatchUrl(CHANNEL), '');
  assert.equal(youtubeWatchUrl(''), '');
});

function callJson(handler, { params = {}, body = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ params, body }, res);
  });
}
