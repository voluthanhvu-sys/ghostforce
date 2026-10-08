import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createYoutubeImport } from '../server/youtube-import.js';
import { parseYoutubeUrl } from '../server/youtube-url.js';
import {
  parseChannelUrl,
  planChannelBatch,
  readFlatPlaylist,
} from '../server/youtube-channel.js';
import { createChannelStore } from '../server/youtube-channel-store.js';
import { createYoutubeChannels } from '../server/youtube-channels.js';

const CHANNEL = `UC${'a'.repeat(22)}`;
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';
const D = 'ddddddddddd';
const VIDEO = 'dQw4w9WgXcQ';

function row(id, title) {
  return { id, title };
}

test('a channel URL picks the tab and a video or playlist URL does not', () => {
  const home = parseChannelUrl('https://www.youtube.com/@GhostForge?si=abc');
  assert.equal(home.ok, true);
  assert.equal(home.tab, 'videos');
  assert.equal(home.listUrl, 'https://www.youtube.com/@GhostForge/videos');

  const shorts = parseChannelUrl('https://m.youtube.com/@GhostForge/shorts/');
  assert.equal(shorts.tab, 'shorts');
  assert.equal(shorts.listUrl, 'https://www.youtube.com/@GhostForge/shorts');

  const featured = parseChannelUrl(`https://www.youtube.com/channel/${CHANNEL}/featured`);
  assert.equal(featured.tab, 'videos');
  assert.equal(featured.listUrl, `https://www.youtube.com/channel/${CHANNEL}/videos`);

  const custom = parseChannelUrl('https://www.youtube.com/c/Name');
  assert.equal(custom.listUrl, 'https://www.youtube.com/c/Name/videos');
  const user = parseChannelUrl('https://www.youtube.com/user/Name/videos');
  assert.equal(user.tab, 'videos');

  assert.equal(parseChannelUrl('https://www.youtube.com/playlist?list=PLxxxx').code, 'playlist');
  assert.equal(parseChannelUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').code, 'not_channel');
  assert.equal(parseChannelUrl(`https://www.youtube.com/shorts/${VIDEO}`).code, 'not_channel');
  assert.equal(parseChannelUrl('https://youtu.be/dQw4w9WgXcQ').code, 'not_channel');
  assert.equal(parseChannelUrl('https://www.youtube.com/results?search_query=cat').code, 'not_channel');
  assert.equal(parseYoutubeUrl(`https://www.youtube.com/channel/${CHANNEL}`).code, 'not_video');
});

test('direction walks away from the anchor and skips videos already saved', () => {
  const entries = [row(A, 'A'), row(B, 'B'), row(C, 'test 1'), row(D, 'D')];
  const around = planChannelBatch({ entries, downloadedIds: [], anchorId: C });
  assert.deepEqual(around.above.map((item) => item.id), [B, A]);
  assert.deepEqual(around.below.map((item) => item.id), [D]);
  assert.deepEqual(around.newVideos.map((item) => item.id), [B, A]);
  assert.equal(around.newCount, 2);

  const skipped = planChannelBatch({ entries, downloadedIds: [B], anchorId: C });
  assert.deepEqual(skipped.above.map((item) => item.id), [A]);
  assert.deepEqual(skipped.newVideos.map((item) => item.id), [A]);

  const first = planChannelBatch({ entries, downloadedIds: [A], anchorId: '' });
  assert.equal(first.anchorMissing, false);
  assert.deepEqual(first.first.map((item) => item.id), [B, C, D]);
  assert.equal(first.newCount, 0);

  const missing = planChannelBatch({ entries, downloadedIds: [], anchorId: 'zzzzzzzzzzz' });
  assert.equal(missing.anchorMissing, true);
  assert.deepEqual(missing.above, []);
  assert.deepEqual(missing.below, []);
});

test('a flat channel list keeps public ids and skips members-only rows', () => {
  const read = readFlatPlaylist(JSON.stringify({
    channel_id: CHANNEL,
    channel: 'Kenh',
    playlist_count: 10,
    entries: [
      { id: A, title: 'A' },
      { id: B, title: 'B', availability: 'subscriber_only' },
      null,
      { id: 'short', title: 'nope' },
      { id: C, title: 'C', availability: 'private' },
    ],
  }));
  assert.equal(read.ok, true);
  assert.equal(read.channelId, CHANNEL);
  assert.deepEqual(read.entries.map((item) => item.id), [A]);
  assert.equal(read.truncated, true);

  const whole = readFlatPlaylist({
    uploader_id: CHANNEL,
    uploader: 'Kenh',
    playlist_count: 1,
    entries: [{ id: A, title: 'A' }],
  });
  assert.equal(whole.truncated, false);
  assert.equal(whole.entries.length, 1);
});

test('the ledger keeps downloaded ids and the per-channel folder across a reload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-ch-'));
  const file = path.join(root, 'youtube-channels.json');
  const store = createChannelStore(file);
  const key = `${CHANNEL}:videos`;
  store.remember({ key, title: 'Kenh', url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  store.setFolder(key, 'D:\\clips');
  store.recordSaved({ id: C, title: 'test 1', channelKey: key });
  store.recordSaved({ id: VIDEO, title: 'le', channelKey: '' });
  const again = createChannelStore(file);
  again.remember({ key, title: 'Kenh moi', url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  const [row] = again.summaries();
  assert.equal(row.title, 'Kenh moi');
  assert.equal(row.folder, 'D:\\clips');
  assert.equal(row.anchorId, C);
  assert.equal(row.anchorTitle, 'test 1');
  assert.equal(row.downloadedCount, 1);
  assert.equal(row.downloaded, undefined);
  assert.deepEqual(again.downloadedIds().sort(), [C, VIDEO].sort());
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.channels[0].downloaded.length, 1);
  assert.equal(again.remove(key), true);
  assert.deepEqual(again.summaries(), []);
  assert.deepEqual(again.downloadedIds().sort(), [C, VIDEO].sort());
  fs.rmSync(root, { recursive: true, force: true });
});

test('a pasted video link sets the anchor, and an already saved video asks first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-anchor-'));
  const store = createChannelStore(path.join(root, 'youtube-channels.json'));
  const key = `${CHANNEL}:videos`;
  const other = `${CHANNEL}:shorts`;
  store.remember({ key, title: 'Kenh', url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  store.remember({ key: other, title: 'Kenh', url: `https://www.youtube.com/channel/${CHANNEL}/shorts` });
  store.recordSaved({ id: C, title: 'test 1', channelKey: key });
  store.recordSaved({ id: D, title: 'cu', channelKey: '' });
  const saved = store.savedVideo(D);
  assert.equal(saved.title, 'cu');
  assert.ok(saved.at);
  let scans = 0;
  const api = createYoutubeChannels({
    store,
    importRoot: path.join(root, 'youtube-import'),
    resolveTools: async () => ({ yt: { ok: true, command: 'yt-dlp', prefixArgs: [] } }),
    runProcess: async () => {
      scans += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          channel_id: CHANNEL,
          channel: 'Kenh',
          playlist_count: 4,
          entries: [row(A, 'A'), row(B, 'Ten that'), row(C, 'test 1'), row(D, 'D')],
        }),
        stderr: '',
      };
    },
  });

  const current = await api.anchor(key, { url: `https://www.youtube.com/watch?v=${C}` });
  assert.equal(current.status, 200);
  assert.equal(current.body.already, true);
  assert.equal(current.body.needsConfirm, false);
  assert.equal(store.summaries().find((item) => item.key === key).anchorId, C);

  const ask = await api.anchor(key, { url: `https://www.youtube.com/watch?v=${D}` });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.needsConfirm, true);
  assert.equal(ask.body.videoId, D);
  assert.equal(ask.body.title, 'cu');
  assert.equal(ask.body.savedAt, saved.at);
  assert.equal(store.summaries().find((item) => item.key === key).anchorId, C);

  const word = await api.anchor(key, { url: `https://youtu.be/${D}`, confirm: 'true' });
  assert.equal(word.body.needsConfirm, true);
  assert.equal(store.summaries().find((item) => item.key === key).anchorId, C);

  const moved = await callJson(api.anchorHandler, {
    params: { key },
    body: { url: `https://www.youtube.com/watch?v=${D}`, confirm: true },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.needsConfirm, false);
  assert.equal(moved.body.anchorId, D);
  assert.equal(moved.body.anchorTitle, 'cu');
  const videos = store.summaries().find((item) => item.key === key);
  assert.equal(videos.downloadedCount, 1);
  assert.deepEqual(store.downloadedIds().sort(), [C, D].sort());
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'youtube-channels.json'), 'utf8'));
  assert.equal(raw.channels.find((item) => item.key === key).downloaded.length, 1);
  assert.equal(store.summaries().find((item) => item.key === other).anchorId, '');

  const fresh = await api.anchor(key, { url: `https://www.youtube.com/shorts/${B}` });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.needsConfirm, false);
  assert.equal(fresh.body.anchorId, B);
  assert.equal(fresh.body.anchorTitle, B);
  assert.equal(store.downloadedIds().includes(B), false);
  assert.equal(store.summaries().find((item) => item.key === key).downloadedCount, 1);

  const again = await api.anchor(key, { url: `https://www.youtube.com/watch?v=${B}&t=12` });
  assert.equal(again.body.already, true);
  assert.equal(again.body.needsConfirm, false);

  const playlist = await api.anchor(key, { url: 'https://www.youtube.com/playlist?list=PLxxxx' });
  assert.equal(playlist.status, 400);
  assert.equal(playlist.body.code, 'playlist');
  const channelUrl = await api.anchor(key, { url: 'https://www.youtube.com/@GhostForge' });
  assert.equal(channelUrl.status, 400);
  assert.equal(channelUrl.body.code, 'not_video');
  const missing = await api.anchor(`UC${'b'.repeat(22)}:videos`, { url: `https://youtu.be/${A}` });
  assert.equal(missing.status, 404);
  assert.equal(scans, 0);

  const listed = await api.scan({ url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.anchorId, B);
  assert.equal(listed.body.anchorTitle, 'Ten that');
  assert.equal(store.summaries().find((item) => item.key === key).anchorTitle, 'Ten that');
  assert.equal(store.downloadedIds().includes(B), false);
  const second = await api.scan({ url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  assert.equal(second.body.anchorTitle, 'Ten that');
  assert.equal(scans, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a channel scan does not take the import slot and plans around the anchor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-scan-'));
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-shared-'));
  fs.writeFileSync(path.join(shared, `Old [${A}].mp4`), Buffer.alloc(10));
  const store = createChannelStore(path.join(root, 'youtube-channels.json'));
  const calls = [];
  const entries = [row(A, 'A'), row(B, 'B'), row(C, 'test 1'), row(D, 'D')];
  const api = createYoutubeChannels({
    store,
    importRoot: path.join(root, 'youtube-import'),
    resolveTools: async () => ({ yt: { ok: true, command: 'yt-dlp', prefixArgs: ['--mark'] } }),
    runProcess: async (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: JSON.stringify({
          channel_id: CHANNEL,
          channel: 'Kenh',
          playlist_count: 4,
          entries,
        }),
        stderr: '',
      };
    },
  });
  const first = await api.scan({ url: `https://www.youtube.com/channel/${CHANNEL}`, sharedFolder: shared });
  assert.equal(first.status, 200);
  assert.equal(first.body.tab, 'videos');
  assert.equal(first.body.anchorId, '');
  assert.deepEqual(first.body.first.map((item) => item.id), [B, C, D]);
  assert.deepEqual(first.body.local, [{ id: A, title: 'A' }]);
  assert.equal(first.body.videos, undefined);
  const listed = calls[0].args;
  assert.equal(listed.includes('--flat-playlist'), true);
  assert.equal(listed.includes('--no-playlist'), false);
  assert.equal(listed.includes('--playlist-end'), true);
  assert.equal(listed[listed.length - 1], `https://www.youtube.com/channel/${CHANNEL}/videos`);
  assert.equal(store.downloadedIds().includes(A), true);

  store.recordSaved({ id: C, title: 'test 1', channelKey: first.body.key });
  const second = await api.scan({ url: `https://www.youtube.com/channel/${CHANNEL}/shorts` });
  assert.equal(second.body.tab, 'shorts');
  assert.equal(second.body.key.endsWith(':shorts'), true);
  const videos = await api.scan({ url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  assert.equal(videos.body.anchorId, C);
  assert.deepEqual(videos.body.above.map((item) => item.id), [B]);
  assert.deepEqual(videos.body.below.map((item) => item.id), [D]);
  assert.deepEqual(videos.body.newVideos.map((item) => item.id), [B]);
  assert.equal(store.summaries().length, 2);

  const playlist = await api.scan({ url: 'https://www.youtube.com/playlist?list=PLxxxx' });
  assert.equal(playlist.status, 400);
  assert.equal(playlist.body.code, 'playlist');
  const inside = await api.scan({ url: `https://www.youtube.com/channel/${CHANNEL}` });
  assert.equal(inside.status, 200);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
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

function fakeTools() {
  return async (command, args) => {
    if (args.includes('--version') || args.includes('-version')) return { status: 0, stdout: 'tool 1\n', stderr: '' };
    if (command === 'which' || command === 'where') return { status: 1, stdout: '', stderr: '' };
    if (args.includes('--dump-single-json')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: VIDEO,
          title: 'Tieu de',
          duration: 212,
          live_status: 'not_live',
          availability: 'public',
          _type: 'video',
        }),
        stderr: '',
      };
    }
    if (command === 'ffmpeg' && args.includes('-i')) {
      return { status: 1, stdout: '', stderr: 'Duration: 00:03:32.00\nStream #0:0 Video: h264, 1920x1080\n' };
    }
    if (args.includes('--merge-output-format')) {
      const template = args[args.indexOf('-o') + 1];
      fs.writeFileSync(path.join(path.dirname(template), `${VIDEO}.mp4`), Buffer.alloc(200));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${command}` };
  };
}

test('a video is remembered only after the copy lands, and the anchor moves for that channel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-save-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-dest-'));
  const store = createChannelStore(path.join(root, 'youtube-channels.json'));
  const key = `${CHANNEL}:videos`;
  store.remember({ key, title: 'Kenh', url: `https://www.youtube.com/channel/${CHANNEL}/videos` });
  const bucket = new Map();
  const api = createYoutubeImport({
    uploadsDir: root,
    jobs: bucket,
    subscribeJob() { throw new Error('unused'); },
    runProcess: fakeTools(),
    channels: store,
  });
  const started = await api.begin({
    url: `https://www.youtube.com/watch?v=${VIDEO}`,
    quality: '1080',
    tab: 'save',
    channelKey: key,
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.channelKey, undefined);
  assert.equal(bucket.get(started.body.jobId).channelKey, key);
  await api.runImport(bucket.get(started.body.jobId), () => {});
  const missing = await callJson(api.saveHandler, {
    params: { jobId: started.body.jobId },
    body: { path: path.join(dest, 'missing'), channelKey: key },
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(store.downloadedIds(), []);
  assert.equal(store.summaries()[0].anchorId, '');
  const saved = await callJson(api.saveHandler, {
    params: { jobId: started.body.jobId },
    body: { path: dest, channelKey: key, removeSource: true },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(store.downloadedIds(), [VIDEO]);
  assert.equal(store.summaries()[0].anchorId, VIDEO);
  assert.equal(store.summaries()[0].anchorTitle, 'Tieu de');
  const held = new Map();
  const probe = createYoutubeImport({
    uploadsDir: root,
    jobs: held,
    subscribeJob() { return null; },
    runProcess: fakeTools(),
    channels: store,
  });
  const ignored = await probe.begin({
    url: `https://www.youtube.com/watch?v=${VIDEO}`,
    quality: '1080',
    tab: 'save',
    channelKey: 'nope',
  });
  assert.equal(ignored.status, 201);
  assert.equal(ignored.body.channelKey, undefined);
  assert.equal(held.get(ignored.body.jobId).channelKey, '');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});
