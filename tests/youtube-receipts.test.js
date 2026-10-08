import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelStore } from '../server/youtube-channel-store.js';
import { createYoutubeChannels } from '../server/youtube-channels.js';
import { createReceiptStore, createYoutubeReceipts } from '../server/youtube-receipts.js';

const CHANNEL = `UC${'a'.repeat(22)}`;
const KEY = `${CHANNEL}:videos`;
const VIDEO = 'dQw4w9WgXcQ';
const OTHER = 'abcdefghijk';
const JOB = 'a'.repeat(32);

function callJson(handler, { params = {}, body = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ params, body, query }, res);
  });
}

test('a saved download stays for 7 days and an unsaved file stays', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-rc-'));
  const store = createReceiptStore(path.join(root, 'youtube-receipts.json'));
  const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
  const recent = new Date().toISOString();
  store.note({ id: JOB, videoId: VIDEO, title: 'Cu', channelKey: KEY, savedPath: 'D:\\clips\\a.mp4', savedAt: old });
  store.note({ id: `${'b'.repeat(32)}`, videoId: OTHER, title: 'Giu', channelKey: KEY, holdPath: 'D:\\hold\\b.mp4' });
  store.note({ id: `${'c'.repeat(32)}`, videoId: 'ccccccccccc', title: 'Moi', channelKey: '', savedPath: 'D:\\clips\\c.mp4', savedAt: recent });
  const items = store.list();
  assert.equal(items.some((row) => row.videoId === VIDEO), false);
  assert.equal(items.find((row) => row.videoId === OTHER).saved, false);
  assert.equal(items.find((row) => row.videoId === 'ccccccccccc').saved, true);
  assert.equal(items.find((row) => row.videoId === 'ccccccccccc').folder, 'D:\\clips');
  assert.equal(items.find((row) => row.videoId === OTHER).folder, '');
  const again = createReceiptStore(path.join(root, 'youtube-receipts.json'));
  assert.equal(again.list().some((row) => row.videoId === OTHER), true);
  assert.equal(again.clear(KEY) >= 1, true);
  assert.equal(again.list().some((row) => row.channelKey === KEY), false);
  assert.equal(again.list().some((row) => row.videoId === 'ccccccccccc'), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a second save of the same video stays on one row and counts the repeat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-rc-again-'));
  const store = createReceiptStore(path.join(root, 'youtube-receipts.json'));
  store.note({ id: JOB, videoId: VIDEO, title: 'Cu', channelKey: KEY, savedPath: 'D:\\clips\\a.mp4' });
  store.note({ id: `${'b'.repeat(32)}`, videoId: VIDEO, title: 'Cu', channelKey: KEY, savedPath: 'D:\\clips\\a (1).mp4' });
  let items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].redownloads, 1);
  assert.equal(items[0].folder, 'D:\\clips');
  store.note({ id: items[0].id, videoId: VIDEO, title: 'Cu', channelKey: KEY, savedPath: 'D:\\clips\\a (1).mp4' });
  store.note({ id: `${'d'.repeat(32)}`, videoId: VIDEO, title: 'Cu', channelKey: KEY, holdPath: 'D:\\hold\\x.mp4' });
  items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].redownloads, 1);
  store.note({ id: `${'e'.repeat(32)}`, videoId: VIDEO, title: 'Cu', channelKey: `${CHANNEL}:shorts`, savedPath: 'D:\\shorts\\a.mp4' });
  items = store.list();
  assert.equal(items.length, 2);
  assert.equal(items.find((row) => row.channelKey === KEY).redownloads, 1);
  assert.equal(items.find((row) => row.channelKey === `${CHANNEL}:shorts`).redownloads, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a copy of a held file marks it saved, and a known video returns its date', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-copy-'));
  const importRoot = path.join(root, 'youtube-import');
  const dest = fs.mkdtempSync(path.join(root, 'dest-'));
  fs.mkdirSync(importRoot);
  const source = path.join(importRoot, 'Clip.mp4');
  fs.writeFileSync(source, Buffer.alloc(20));
  const store = createReceiptStore(path.join(root, 'youtube-receipts.json'));
  const api = createYoutubeReceipts({ store, importRoot });
  const noted = await callJson(api.noteHandler, {
    body: { id: JOB, videoId: VIDEO, title: 'Clip', channelKey: KEY, holdPath: source },
  });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.saved, false);
  const copied = await callJson(api.copyHandler, { params: { id: JOB }, body: { path: dest } });
  assert.equal(copied.status, 200);
  assert.equal(fs.existsSync(copied.body.dest), true);
  assert.equal(store.list()[0].saved, true);
  const outside = await callJson(api.noteHandler, {
    body: { id: `${'d'.repeat(32)}`, videoId: OTHER, holdPath: path.join(dest, 'nope.mp4') },
  });
  assert.equal(outside.status, 400);

  const ledger = createChannelStore(path.join(root, 'youtube-channels.json'));
  ledger.recordSaved({ id: VIDEO, title: 'Clip', channelKey: '' });
  const channels = createYoutubeChannels({
    store: ledger,
    importRoot,
    resolveTools: async () => ({ yt: { ok: true, command: 'yt-dlp', prefixArgs: [] } }),
    runProcess: async () => { throw new Error('known must not scan'); },
  });
  const known = await callJson(channels.knownHandler, { body: { ids: [VIDEO, OTHER] } });
  assert.equal(known.status, 200);
  assert.equal(known.body.videos.length, 1);
  assert.equal(known.body.videos[0].id, VIDEO);
  assert.ok(known.body.videos[0].at);
  fs.rmSync(root, { recursive: true, force: true });
});
