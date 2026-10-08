import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createYoutubeImport } from '../server/youtube-import.js';
import { YOUTUBE_FORMATS } from '../server/youtube-url.js';
import { app } from '../ghostforge-server.js';
import { jobs as sharedJobs } from '../server/jobs.js';

const PASTED = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx&si=SECRET';
const CANONICAL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function fakeTools(calls) {
  return async (command, args, options, hooks) => {
    calls.push({ command, args, options, hooks: hooks || null });
    if (hooks?.onSpawn) hooks.onSpawn({ pid: 4242, kill() {} });
    if (args.includes('--version') || args.includes('-version')) {
      return { status: 0, stdout: 'tool 1\n', stderr: '' };
    }
    if (command === 'which' || command === 'where') return { status: 1, stdout: '', stderr: '' };
    if (args.includes('--dump-single-json')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          id: 'dQw4w9WgXcQ',
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
      return {
        status: 1,
        stdout: '',
        stderr: 'Duration: 00:03:32.00\nStream #0:0 Video: h264, 1920x1080\n',
      };
    }
    if (args.includes('--merge-output-format')) {
      const template = args[args.indexOf('-o') + 1];
      fs.writeFileSync(path.join(path.dirname(template), 'dQw4w9WgXcQ.mp4'), Buffer.alloc(200));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected ${command}` };
  };
}

test('youtube import spawns only the canonical URL and records onSpawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-'));
  const calls = [];
  const bucket = new Map();
  const api = createYoutubeImport({
    uploadsDir: root,
    jobs: bucket,
    subscribeJob() { throw new Error('stream handler is not used in this test'); },
    runProcess: fakeTools(calls),
  });
  const started = await api.begin({ url: PASTED, quality: '1080', tab: 'edit' });
  assert.equal(started.status, 201);
  assert.equal(started.body.canonicalUrl, CANONICAL);
  const events = [];
  await api.runImport(bucket.get(started.body.jobId), (type, data) => events.push({ type, ...data }));
  const download = calls.find((call) => call.args.includes('--merge-output-format'));
  const probe = calls.find((call) => call.args.includes('--dump-single-json'));
  const fileProbe = calls.find((call) => call.command === 'ffmpeg' && call.args.includes('-i'));
  assert.ok(download);
  assert.ok(probe);
  assert.ok(fileProbe);
  for (const call of [download, probe, fileProbe]) {
    assert.notEqual(call.options.shell, true);
    assert.equal(call.options.timeout, undefined);
    assert.equal(typeof call.hooks.onSpawn, 'function');
  }
  assert.ok(download.args.includes('--no-playlist'));
  assert.ok(download.args.includes(YOUTUBE_FORMATS['1080']));
  assert.ok(download.args.includes('--format-sort'));
  assert.ok(download.args.includes('res:1080,+vcodec:avc,+acodec:m4a'));
  assert.ok(probe.args.includes('res:1080,+vcodec:avc,+acodec:m4a'));
  assert.equal(download.args[download.args.length - 1], CANONICAL);
  const flat = calls.flatMap((call) => [call.command, ...call.args]).join('\n');
  assert.equal(flat.includes(PASTED), false);
  assert.equal(flat.includes('si=SECRET'), false);
  assert.equal(flat.includes('list=PLxxxx'), false);
  const done = events.find((event) => event.type === 'done');
  assert.ok(done);
  assert.equal(done.targetTab, 'edit');
  assert.equal(done.file.name.includes('[dQw4w9WgXcQ].mp4'), true);
  assert.equal(fs.existsSync(done.file.path), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a numbered YouTube size is accepted and an unknown size is rejected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-'));
  const jobs = new Map();
  const api = createYoutubeImport({
    uploadsDir: root,
    jobs,
    subscribeJob() { return null; },
    runProcess: fakeTools([]),
  });
  const bad = await api.begin({ url: CANONICAL, quality: '4k', tab: 'save' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'quality');
  const ok = await api.begin({ url: CANONICAL, quality: '2160', tab: 'save' });
  assert.equal(ok.status, 201);
  assert.equal(jobs.get(ok.body.jobId).quality, '2160');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a second import is busy until a stale pending job is reaped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-'));
  const bucket = new Map();
  const api = createYoutubeImport({
    uploadsDir: root,
    jobs: bucket,
    subscribeJob() { return null; },
    runProcess: fakeTools([]),
  });
  const first = await api.begin({ url: `https://youtu.be/dQw4w9WgXcQ`, tab: 'unique' });
  assert.equal(first.status, 201);
  const blocked = await api.begin({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', tab: 'edit' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'busy');
  bucket.get(first.body.jobId).createdAt = Date.now() - 130_000;
  const again = await api.begin({ url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', tab: 'reframe' });
  assert.equal(again.status, 201);
  assert.equal(bucket.has(first.body.jobId), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing yt-dlp is installed once and the next status reuses it', async () => {
  let installed = false;
  let installs = 0;
  const api = createYoutubeImport({
    uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-')),
    jobs: new Map(),
    subscribeJob() { return null; },
    runProcess: async (command, args) => {
      if (command === 'which' || command === 'where') return { status: 1, stdout: '', stderr: '' };
      if (args.includes('--version') || args.includes('-version')) {
        if (command === 'ffmpeg') return { status: 0, stdout: 'ffmpeg 1\n', stderr: '' };
        if (installed) return { status: 0, stdout: '2026.09.30\n', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
    ensureYtDlp: async () => {
      installs += 1;
      installed = true;
      return { ok: true };
    },
  });
  const ask = (fresh) => new Promise((resolve) => {
    api.statusHandler({ query: fresh ? { fresh: '1' } : {} }, { json: resolve });
  });
  const first = await ask(false);
  assert.equal(installs, 1);
  assert.equal(first.ytDlp.ok, true);
  assert.equal(first.installedNow, true);
  assert.equal(first.ready, true);
  const second = await ask(false);
  assert.equal(installs, 1);
  assert.equal(second.installedNow, false);
  const fresh = await ask(true);
  assert.equal(installs, 1);
  assert.equal(fresh.ytDlp.ok, true);
  assert.equal(fresh.installedNow, false);
});

test('a client cookies path is rejected before any process starts', async () => {
  const calls = [];
  const api = createYoutubeImport({
    uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-')),
    jobs: new Map(),
    subscribeJob() { return null; },
    runProcess: fakeTools(calls),
  });
  const rejected = await api.begin({
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    tab: 'edit',
    cookiesPath: '/tmp/secrets.txt',
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, 'cookies');
  assert.equal(calls.length, 0);
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

test('save copies the original mp4 and save-only removes the import directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-yt-save-'));
  const bucket = new Map();
  const api = createYoutubeImport({
    uploadsDir: root,
    jobs: bucket,
    subscribeJob() { throw new Error('stream handler is not used in this test'); },
    runProcess: fakeTools([]),
  });
  const pending = await api.begin({ url: CANONICAL, quality: '1080', tab: 'save' });
  assert.equal(pending.status, 201);
  assert.equal(pending.body.targetTab, 'save');
  const early = await callJson(api.saveHandler, { params: { jobId: pending.body.jobId }, body: { path: dest } });
  assert.equal(early.status, 409);

  const events = [];
  await api.runImport(bucket.get(pending.body.jobId), (type, data) => {
    events.push({ type, ...data });
    if (type === 'done' || type === 'error') {
      bucket.get(pending.body.jobId).status = type;
    }
  });
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.targetTab, 'save');
  const importDir = path.dirname(done.file.path);
  const inside = await callJson(api.saveHandler, {
    params: { jobId: pending.body.jobId },
    body: { path: importDir, name: '../evil.mp4', removeSource: true },
  });
  assert.equal(inside.status, 400);
  assert.equal(fs.existsSync(done.file.path), true);

  const kept = await callJson(api.saveHandler, {
    params: { jobId: pending.body.jobId },
    body: { path: dest, name: '../evil.mp4', removeSource: false },
  });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.removed, false);
  assert.equal(path.basename(kept.body.dest), done.file.name);
  assert.equal(kept.body.dest.includes('evil'), false);
  assert.equal(fs.existsSync(kept.body.dest), true);
  assert.equal(fs.existsSync(done.file.path), true);

  const again = await callJson(api.saveHandler, {
    params: { jobId: pending.body.jobId },
    body: { path: dest, removeSource: true },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, true);
  assert.match(again.body.name, / \(1\)\.mp4$/);
  assert.equal(fs.existsSync(again.body.dest), true);
  assert.equal(fs.existsSync(importDir), false);
  const gone = await callJson(api.saveHandler, { params: { jobId: pending.body.jobId }, body: { path: dest } });
  assert.equal(gone.status, 404);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});

test('GET /api/stream rejects a youtube-import job before Unique encode', async () => {
  const jobId = '0123456789abcdef0123456789abcdef';
  sharedJobs.set(jobId, { kind: 'youtube-import', status: 'pending' });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: `/api/stream/${jobId}` }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
    });
    assert.equal(result.status, 400);
    assert.match(JSON.parse(result.data).error, /\/api\/youtube-import\/stream/);
    const job = sharedJobs.get(jobId);
    assert.equal(job.outputPath, undefined);
    assert.equal(job.ffmpeg, undefined);
  } finally {
    sharedJobs.delete(jobId);
    await new Promise((resolve) => server.close(resolve));
  }
});
