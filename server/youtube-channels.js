import fs from 'fs';
import os from 'os';
import path from 'path';
import { killProcessTree } from './process.js';
import { isInsideDir, parseYoutubeUrl } from './youtube-url.js';
import {
  CHANNEL_COUNT_MAX,
  CHANNEL_LIST_LIMIT,
  channelKey,
  normalizeChannelKey,
  parseChannelUrl,
  planChannelBatch,
  readFlatPlaylist,
  videoIdFromFileName,
} from './youtube-channel.js';
import { filesInFolder, idsInFolder } from './youtube-channel-store.js';
import {
  CONCAT_BYTES,
  concatCopyArgs,
  concatEncodeArgs,
  concatFileName,
  concatFilter,
  concatCanvas,
  concatListBody,
  concatRequest,
  localVideos,
  readConcatProbe,
} from './youtube-concat.js';

const SCAN_MS = 180_000;

const ERRORS = {
  bad_url: 'Link không hợp lệ.',
  host: 'Chỉ nhận link YouTube (youtube.com hoặc youtu.be).',
  playlist: 'Link playlist không được tải. Hãy dán link một kênh.',
  not_channel: 'Link này không phải một kênh YouTube.',
  no_ytdlp: 'Không cài được yt-dlp tự động. Kiểm tra mạng rồi bấm kiểm tra lại.',
  no_channel: 'Không đọc được mã kênh.',
  list_failed: 'Không đọc được danh sách video của kênh.',
  folder: 'Thư mục riêng không dùng được.',
  missing: 'Không còn kênh này trong danh sách.',
  few: 'Chọn ít nhất 2 video đã có file.',
  many: 'Một lần ghép tối đa 20 video.',
  file: 'Không thấy file của video này trong thư mục kênh.',
  big: 'Các file gốc cộng lại lớn hơn 16 GB.',
  no_ffmpeg: 'Không thấy ffmpeg, nên không ghép được.',
  audio: 'Một file không có cả hình và tiếng, nên không ghép được.',
  failed: 'Không ghép được các file này.',
  name: 'Không đặt được tên file ghép.',
};

const ANCHOR_ERRORS = {
  bad_url: 'Link không hợp lệ.',
  host: 'Chỉ nhận link YouTube (youtube.com hoặc youtu.be).',
  playlist: 'Link playlist không dùng làm mốc. Hãy dán link một video.',
  not_video: 'Link này không phải một video YouTube.',
};

export function createYoutubeChannels({ store, runProcess, resolveTools, importRoot }) {
  function fail(code, status = 400) {
    return { status, body: { error: ERRORS[code] || ERRORS.list_failed, code } };
  }

  async function scan(body) {
    const parsed = parseChannelUrl(body?.url);
    if (!parsed.ok) return fail(parsed.code);
    const tools = resolveTools ? await resolveTools() : null;
    if (!tools?.yt?.ok || !tools.yt.command) return fail('no_ytdlp', 503);
    const args = [
      ...(tools.yt.prefixArgs || []),
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end', String(CHANNEL_LIST_LIMIT),
      '--no-warnings',
      '--ignore-errors',
      '--no-download',
      parsed.listUrl,
    ];
    const run = await runBounded(runProcess, tools.yt.command, args, SCAN_MS);
    const flat = run?.stdout ? readFlatPlaylist(run.stdout) : { ok: false, code: 'list_failed' };
    if (!flat.ok) return fail(flat.code || 'list_failed');
    const key = channelKey(flat.channelId, parsed.tab);
    if (!key) return fail('no_channel');
    const row = store.remember({ key, title: flat.title, url: parsed.listUrl });
    if (!row) return fail('no_channel');
    const ids = new Set(store.downloadedIds());
    for (const id of idsInFolder(row.folder)) ids.add(id);
    for (const id of idsInFolder(usableFolder(body?.sharedFolder, importRoot))) ids.add(id);
    store.noteIds(ids);
    const plan = planChannelBatch({
      entries: flat.entries,
      downloadedIds: ids,
      anchorId: row.anchorId,
    });
    const local = localVideos(flat.entries, filesForRow(row, body?.sharedFolder, importRoot));
    let shown = row;
    if (
      plan.anchor
      && plan.anchor.id === row.anchorId
      && plan.anchor.title
      && plan.anchor.title !== row.anchorTitle
    ) {
      const next = store.setAnchor(key, { id: plan.anchor.id, title: plan.anchor.title });
      if (next) {
        shown = { ...row, anchorId: next.anchorId, anchorTitle: next.anchorTitle, updatedAt: next.updatedAt };
      }
    }
    return { status: 200, body: publicPlan(shown, plan, flat.truncated, local) };
  }

  async function concat(key, body) {
    const id = normalizeChannelKey(key);
    if (!id) return { status: 404, body: { error: ERRORS.missing, code: 'missing' } };
    const row = store.summaries().find((item) => item.key === id);
    if (!row) return { status: 404, body: { error: ERRORS.missing, code: 'missing' } };
    const asked = concatRequest(body?.ids, body?.marks);
    if (!asked.ok) return { status: 400, body: { error: ERRORS[asked.code] || ERRORS.few, code: asked.code } };
    const own = usableFolder(row.folder, importRoot);
    const shared = usableFolder(body?.sharedFolder, importRoot);
    const destFolder = own || shared;
    if (!destFolder) return { status: 400, body: { error: 'Chọn thư mục lưu trước khi ghép.', code: 'folder' } };
    const look = [];
    if (own) look.push(own);
    if (shared && shared !== own) look.push(shared);
    const paths = [];
    let bytes = 0;
    for (const videoId of asked.ids) {
      const found = findVideoFile(look, videoId);
      if (!found) return { status: 400, body: { error: ERRORS.file, code: 'file', videoId } };
      bytes += found.size;
      paths.push(found.path);
    }
    if (bytes > CONCAT_BYTES) return { status: 400, body: { error: ERRORS.big, code: 'big' } };
    const named = freeName(destFolder, concatFileName(asked.label));
    if (!named) return { status: 400, body: { error: ERRORS.name, code: 'name' } };
    const tools = resolveTools ? await resolveTools() : null;
    if (!tools?.ffmpeg?.ok) return { status: 400, body: { error: ERRORS.no_ffmpeg, code: 'no_ffmpeg' } };
    const command = tools.ffmpeg.path || 'ffmpeg';
    const listPath = path.join(os.tmpdir(), `gf-ghep-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(listPath, concatListBody(paths));
    try {
      const copied = await runProcess(command, concatCopyArgs(listPath, named.dest), { windowsHide: true });
      if (copied?.error?.code === 'ENOENT') return { status: 400, body: { error: ERRORS.no_ffmpeg, code: 'no_ffmpeg' } };
      if (copied?.status === 0 && fileReady(named.dest)) {
        return { status: 200, body: doneBody(named, destFolder, 'copy') };
      }
      dropFile(named.dest);
      const probes = [];
      for (const file of paths) {
        const probe = await runProcess(command, ['-hide_banner', '-i', file], { windowsHide: true });
        if (probe?.error?.code === 'ENOENT') return { status: 400, body: { error: ERRORS.no_ffmpeg, code: 'no_ffmpeg' } };
        const media = readConcatProbe(probe?.stderr);
        if (!media.hasVideo || !media.hasAudio || media.width < 2 || media.height < 2) {
          return { status: 400, body: { error: ERRORS.audio, code: 'audio' } };
        }
        probes.push(media);
      }
      const canvas = concatCanvas(probes);
      const filter = concatFilter(paths.length, canvas.width, canvas.height, canvas.fps);
      const encoded = await runProcess(command, concatEncodeArgs(paths, filter, named.dest), { windowsHide: true });
      if (encoded?.error?.code === 'ENOENT') return { status: 400, body: { error: ERRORS.no_ffmpeg, code: 'no_ffmpeg' } };
      if (encoded?.status !== 0 || !fileReady(named.dest)) {
        dropFile(named.dest);
        return { status: 400, body: { error: ERRORS.failed, code: 'failed' } };
      }
      return { status: 200, body: doneBody(named, destFolder, 'encode') };
    } finally {
      dropFile(listPath);
    }
  }

  function anchor(key, body) {
    const id = normalizeChannelKey(key);
    if (!id) return { status: 404, body: { error: ERRORS.missing, code: 'missing' } };
    const parsed = parseYoutubeUrl(body?.url);
    if (!parsed.ok) {
      const code = ANCHOR_ERRORS[parsed.code] ? parsed.code : 'not_video';
      return { status: 400, body: { error: ANCHOR_ERRORS[code], code } };
    }
    const row = store.summaries().find((item) => item.key === id);
    if (!row) return { status: 404, body: { error: ERRORS.missing, code: 'missing' } };
    if (row.anchorId === parsed.videoId) {
      return { status: 200, body: { ...row, already: true, needsConfirm: false } };
    }
    const saved = store.savedVideo(parsed.videoId);
    if (saved && body?.confirm !== true) {
      return {
        status: 200,
        body: {
          needsConfirm: true,
          videoId: saved.id,
          title: saved.title || saved.id,
          savedAt: saved.at || '',
        },
      };
    }
    const next = store.setAnchor(id, { id: parsed.videoId, title: saved?.title || parsed.videoId });
    if (!next) return { status: 404, body: { error: ERRORS.missing, code: 'missing' } };
    return { status: 200, body: { ...next, needsConfirm: false, already: false } };
  }

  function known(body) {
    const videos = typeof store.lookup === 'function' ? store.lookup(body?.ids) : [];
    return { status: 200, body: { videos } };
  }

  function scanHandler(req, res) {
    scan(req.body || {}).then((out) => {
      res.status(out.status).json(out.body);
    }).catch((err) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    });
  }

  function listHandler(_req, res) {
    try {
      res.json({ channels: store.summaries() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function folderHandler(req, res) {
    try {
      const key = normalizeChannelKey(req.params?.key);
      if (!key) return res.status(404).json({ error: ERRORS.missing, code: 'missing' });
      const requested = String(req.body?.path || '').trim();
      let folder = '';
      if (requested) {
        folder = usableFolder(requested, importRoot);
        if (!folder) return res.status(400).json({ error: ERRORS.folder, code: 'folder' });
      }
      const row = store.setFolder(key, folder);
      if (!row) return res.status(404).json({ error: ERRORS.missing, code: 'missing' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function removeHandler(req, res) {
    try {
      const key = normalizeChannelKey(req.params?.key);
      if (!key || !store.remove(key)) return res.status(404).json({ error: ERRORS.missing, code: 'missing' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function anchorHandler(req, res) {
    try {
      const out = anchor(req.params?.key, req.body || {});
      res.status(out.status).json(out.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function knownHandler(req, res) {
    try {
      const out = known(req.body || {});
      res.status(out.status).json(out.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function concatHandler(req, res) {
    concat(req.params?.key, req.body || {}).then((out) => {
      res.status(out.status).json(out.body);
    }).catch((err) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    });
  }

  return {
    scanHandler,
    listHandler,
    folderHandler,
    removeHandler,
    anchorHandler,
    knownHandler,
    concatHandler,
    scan,
    anchor,
    known,
    concat,
  };
}

function publicPlan(row, plan, truncated, local) {
  return {
    key: row.key,
    channelId: row.channelId,
    title: row.title,
    tab: row.tab,
    url: row.url,
    folder: row.folder,
    anchorId: row.anchorId,
    anchorTitle: row.anchorTitle,
    downloadedCount: row.downloaded.length,
    updatedAt: row.updatedAt,
    anchorMissing: plan.anchorMissing,
    truncated: Boolean(truncated),
    newCount: plan.newCount,
    aboveCount: plan.aboveCount,
    belowCount: plan.belowCount,
    newVideos: take(plan.newVideos),
    above: take(plan.above),
    below: take(plan.below),
    first: take(plan.first),
    local: Array.isArray(local) ? local : [],
  };
}

function filesForRow(row, sharedFolder, importRoot) {
  const own = usableFolder(row?.folder, importRoot);
  const shared = usableFolder(sharedFolder, importRoot);
  const out = [];
  const seen = new Set();
  for (const folder of [own, shared]) {
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    out.push(...filesInFolder(folder));
  }
  return out;
}

function findVideoFile(folders, videoId) {
  for (const folder of folders) {
    let realFolder = folder;
    try { realFolder = fs.realpathSync(folder); } catch { continue; }
    let names = [];
    try { names = fs.readdirSync(realFolder); } catch { continue; }
    for (const name of names) {
      if (videoIdFromFileName(name) !== videoId) continue;
      const full = path.join(realFolder, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile() || stat.size <= 0) continue;
        const real = fs.realpathSync(full);
        if (!isInsideDir(realFolder, real)) continue;
        return { path: real, size: stat.size };
      } catch { /* try the next name */ }
    }
  }
  return null;
}

function freeName(folder, filename) {
  const parsed = path.parse(filename);
  for (let n = 0; n < 100; n += 1) {
    const name = n ? `${parsed.name} (${n})${parsed.ext}` : filename;
    const dest = path.join(folder, name);
    if (!isInsideDir(folder, dest)) return null;
    if (!fs.existsSync(dest)) return { name, dest };
  }
  return null;
}

function fileReady(file) {
  try { return fs.statSync(file).isFile() && fs.statSync(file).size >= 100; }
  catch { return false; }
}

function dropFile(file) {
  try { if (file && fs.existsSync(file)) fs.rmSync(file, { force: true }); }
  catch { /* a partial file can stay; the next name is a new one */ }
}

function doneBody(named, folder, mode) {
  const size = fs.statSync(named.dest).size;
  return { ok: true, path: named.dest, name: named.name, folder, size, mode };
}

function take(list) {
  return (list || []).slice(0, CHANNEL_COUNT_MAX).map((row) => ({ id: row.id, title: row.title }));
}

export function usableFolder(requested, importRoot) {
  const text = String(requested || '').trim();
  if (!text || !fs.existsSync(text)) return '';
  let dest = '';
  try {
    if (!fs.statSync(text).isDirectory()) return '';
    dest = fs.realpathSync(text);
  } catch {
    return '';
  }
  if (!importRoot) return dest;
  let root = importRoot;
  try { root = fs.realpathSync(importRoot); } catch { /* the import root may not exist yet */ }
  if (isInsideDir(root, dest) || isInsideDir(importRoot, dest)) return '';
  if (path.resolve(dest) === path.resolve(root)) return '';
  return dest;
}

function runBounded(runProcess, command, args, ms) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      const pid = child?.pid;
      try { if (pid) killProcessTree(pid); } catch { /* the scan already ended */ }
      try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
      finish({ status: -1, stdout: '', stderr: 'timeout' });
    }, ms);
    Promise.resolve(runProcess(command, args, { windowsHide: true }, {
      onSpawn(proc) { child = proc; },
    })).then(finish, (err) => finish({ status: -1, stdout: '', stderr: String(err) }));
  });
}
