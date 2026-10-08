import fs from 'fs';
import path from 'path';
import { isInsideDir } from './youtube-url.js';
import { normalizeChannelKey } from './youtube-channel.js';
import { usableFolder } from './youtube-channels.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ROW_ID = /^[A-Za-z0-9_-]{8,40}$/;
const SAVED_MS = 7 * 24 * 60 * 60 * 1000;

export function createReceiptStore(file) {
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { items: normalize(data?.items) };
    } catch {
      return { items: [] };
    }
  }

  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: data.items }));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      try { fs.rmSync(tmp, { force: true }); } catch { /* the copy is the list */ }
    }
  }

  function list() {
    const data = load();
    const next = collapse(prune(data.items));
    if (listSignature(next) !== listSignature(data.items)) save({ items: next });
    return next.map(publicRow);
  }

  function note(input) {
    const id = String(input?.id || '');
    const videoId = String(input?.videoId || '');
    if (!ROW_ID.test(id) || !VIDEO_ID.test(videoId)) return null;
    const data = load();
    let row = data.items.find((item) => item.id === id);
    const now = new Date().toISOString();
    if (!row) {
      row = {
        id,
        videoId,
        title: clean(input.title, videoId),
        channelKey: normalizeChannelKey(input.channelKey) || '',
        holdPath: String(input.holdPath || ''),
        savedPath: String(input.savedPath || ''),
        savedAt: input.savedPath ? String(input.savedAt || now) : '',
        at: now,
        redownloads: 0,
      };
      data.items.push(row);
    } else {
      if (input.title) row.title = clean(input.title, row.title);
      const key = normalizeChannelKey(input.channelKey);
      if (key) row.channelKey = key;
      if (input.holdPath) row.holdPath = String(input.holdPath);
      if (input.savedPath) {
        row.savedPath = String(input.savedPath);
        if (!row.savedAt) row.savedAt = String(input.savedAt || now);
      }
    }
    data.items = collapse(prune(data.items));
    save(data);
    const shown = data.items.find((item) => item.videoId === videoId && item.channelKey === (normalizeChannelKey(input.channelKey) || row.channelKey)) || row;
    return publicRow(shown);
  }

  function remove(id) {
    const key = String(id || '');
    if (!ROW_ID.test(key)) return false;
    const data = load();
    const next = data.items.filter((item) => item.id !== key);
    if (next.length === data.items.length) return false;
    save({ items: next });
    return true;
  }

  function clear(channelKey) {
    const key = channelKey ? (normalizeChannelKey(channelKey) || '') : '';
    if (channelKey && !key) return 0;
    const data = load();
    const next = key ? data.items.filter((item) => item.channelKey !== key) : [];
    const removed = data.items.length - next.length;
    if (removed) save({ items: next });
    return removed;
  }

  function get(id) {
    const key = String(id || '');
    if (!ROW_ID.test(key)) return null;
    return load().items.find((item) => item.id === key) || null;
  }

  return { list, note, remove, clear, get };
}

export function createYoutubeReceipts({ store, importRoot }) {
  function listHandler(_req, res) {
    try {
      res.json({ items: store.list(), keepDays: 7 });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function noteHandler(req, res) {
    try {
      const holdPath = String(req.body?.holdPath || '').trim();
      if (!holdPath || !insideImport(holdPath, importRoot) || !fs.existsSync(holdPath)) {
        return res.status(400).json({ error: 'Không còn file để lưu.', code: 'missing' });
      }
      const row = store.note({
        id: req.body?.id,
        videoId: req.body?.videoId,
        title: req.body?.title,
        channelKey: req.body?.channelKey,
        holdPath,
      });
      if (!row) return res.status(400).json({ error: 'Không ghi được danh sách tải.', code: 'bad' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function copyHandler(req, res) {
    try {
      const row = store.get(req.params?.id);
      if (!row) return res.status(404).json({ error: 'Không còn video này trong danh sách.', code: 'missing' });
      const folder = usableFolder(req.body?.path, importRoot);
      if (!folder) return res.status(400).json({ error: 'Chưa chọn thư mục lưu.', code: 'folder' });
      const source = existing(row.savedPath) || existing(row.holdPath);
      if (!source) return res.status(404).json({ error: 'Không còn file để lưu bản sao.', code: 'missing' });
      const dest = copyUnique(source, folder);
      if (!dest) return res.status(409).json({ error: 'Thư mục đã có quá nhiều file cùng tên.', code: 'name' });
      const saved = store.note({
        id: row.id,
        videoId: row.videoId,
        title: row.title,
        channelKey: row.channelKey,
        savedPath: existing(row.savedPath) || dest.dest,
      });
      res.json({ ok: true, dest: dest.dest, name: dest.name, item: saved });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function removeHandler(req, res) {
    try {
      if (!store.remove(req.params?.id)) {
        return res.status(404).json({ error: 'Không còn video này trong danh sách.', code: 'missing' });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  function clearHandler(req, res) {
    try {
      const removed = store.clear(req.query?.channelKey || '');
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  return { listHandler, noteHandler, copyHandler, removeHandler, clearHandler };
}

function prune(items) {
  const now = Date.now();
  return items.filter((item) => {
    if (!item.savedAt) return true;
    const at = Date.parse(item.savedAt);
    if (!Number.isFinite(at)) return true;
    return now - at < SAVED_MS;
  });
}

function countOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(9999, Math.floor(n));
}

function listSignature(items) {
  return items.map((item) => `${item.id}:${item.videoId}:${item.channelKey}:${item.redownloads}:${item.savedPath}`).join('|');
}

function collapse(items) {
  const out = [];
  const index = new Map();
  for (const item of items) {
    const key = `${item.channelKey}\n${item.videoId}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push({ ...item, redownloads: countOf(item.redownloads) });
      continue;
    }
    const prev = out[at];
    const savedAgain = Boolean(item.savedPath || item.savedAt);
    prev.redownloads += countOf(item.redownloads) + (savedAgain ? 1 : 0);
    const prevStamp = Date.parse(prev.savedAt || prev.at) || 0;
    const nextStamp = Date.parse(item.savedAt || item.at) || 0;
    if (nextStamp >= prevStamp) {
      if (item.title) prev.title = item.title;
      if (item.holdPath) prev.holdPath = item.holdPath;
      if (item.savedPath) {
        prev.savedPath = item.savedPath;
        prev.savedAt = item.savedAt || prev.savedAt || item.at;
      }
    }
  }
  return out;
}

function savedFolder(file) {
  const full = String(file || '').trim();
  if (!full) return '';
  return full.includes('\\') ? path.win32.dirname(full) : path.dirname(full);
}

function publicRow(row) {
  return {
    id: row.id,
    videoId: row.videoId,
    title: row.title,
    channelKey: row.channelKey,
    saved: Boolean(row.savedAt),
    folder: row.savedAt ? savedFolder(row.savedPath) : '',
    redownloads: countOf(row.redownloads),
    at: row.at,
    savedAt: row.savedAt,
  };
}

function normalize(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = String(item?.id || '');
    const videoId = String(item?.videoId || '');
    if (!ROW_ID.test(id) || !VIDEO_ID.test(videoId) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      videoId,
      title: clean(item?.title, videoId),
      channelKey: normalizeChannelKey(item?.channelKey) || '',
      holdPath: String(item?.holdPath || ''),
      savedPath: String(item?.savedPath || ''),
      savedAt: String(item?.savedAt || ''),
      at: String(item?.at || ''),
      redownloads: countOf(item?.redownloads),
    });
  }
  return out;
}

function insideImport(file, importRoot) {
  const root = String(importRoot || '');
  if (!root || !file) return false;
  let real = root;
  let target = file;
  try { real = fs.realpathSync(root); } catch { /* the import root may not exist yet */ }
  try { target = fs.realpathSync(file); } catch { /* a missing file is not inside */ }
  return isInsideDir(real, target) || isInsideDir(root, target);
}

function existing(file) {
  const text = String(file || '');
  if (!text) return '';
  try {
    if (fs.statSync(text).isFile()) return text;
  } catch { /* gone */ }
  return '';
}

function copyUnique(source, folder) {
  const parsed = path.parse(path.basename(source));
  for (let n = 0; n < 10000; n += 1) {
    const name = n ? `${parsed.name} (${n})${parsed.ext}` : `${parsed.name}${parsed.ext}`;
    const dest = path.join(folder, name);
    if (!isInsideDir(folder, dest)) return null;
    try {
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      return { dest, name };
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw err;
    }
  }
  return null;
}

function clean(value, fallback) {
  let text = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length > 140) text = [...text].slice(0, 140).join('').trim();
  return text || String(fallback || '');
}
