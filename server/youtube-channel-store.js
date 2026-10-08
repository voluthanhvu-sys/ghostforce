import fs from 'fs';
import path from 'path';
import { normalizeChannelKey, videoIdFromFileName } from './youtube-channel.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function createChannelStore(file) {
  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        videos: normalizeVideos(data?.videos),
        channels: normalizeChannels(data?.channels),
      };
    } catch {
      return { videos: [], channels: [] };
    }
  }

  function save(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const next = {
      videos: data.videos,
      channels: data.channels,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      try { fs.rmSync(tmp, { force: true }); } catch { /* the copy is the ledger */ }
    }
  }

  function summaries() {
    return load().channels
      .map(summary)
      .sort(compareChannels);
  }

  function downloadedIds() {
    return load().videos.map((row) => row.id);
  }

  function savedVideo(id) {
    const videoId = String(id || '');
    if (!VIDEO_ID.test(videoId)) return null;
    const found = load().videos.find((item) => item.id === videoId) || null;
    if (!found) return null;
    return { id: found.id, title: found.title, at: found.at };
  }

  function lookup(ids) {
    const want = new Set();
    for (const id of (ids || []).slice(0, 40)) {
      const videoId = String(id || '');
      if (VIDEO_ID.test(videoId)) want.add(videoId);
    }
    if (!want.size) return [];
    return load().videos
      .filter((item) => want.has(item.id))
      .map((item) => ({ id: item.id, title: item.title, at: item.at }));
  }

  // Moves the marker only. It does not download the video and does not add
  // the id to the saved list.
  function setAnchor(key, input) {
    const id = normalizeChannelKey(key);
    const videoId = String(input?.id || '');
    if (!id || !VIDEO_ID.test(videoId)) return null;
    const data = load();
    const row = data.channels.find((item) => item.key === id);
    if (!row) return null;
    const name = clean(input?.title, videoId);
    if (row.anchorId === videoId && row.anchorTitle === name) return summary(row);
    row.anchorId = videoId;
    row.anchorTitle = name;
    row.updatedAt = new Date().toISOString();
    save(data);
    return summary(row);
  }

  function remember(input) {
    const key = normalizeChannelKey(input?.key) || '';
    if (!key) return null;
    const data = load();
    let row = data.channels.find((item) => item.key === key);
    const now = new Date().toISOString();
    if (!row) {
      row = {
        key,
        channelId: key.slice(0, key.indexOf(':')),
        tab: key.endsWith(':shorts') ? 'shorts' : 'videos',
        title: clean(input.title, key),
        url: String(input.url || ''),
        folder: '',
        anchorId: '',
        anchorTitle: '',
        downloaded: [],
        updatedAt: now,
      };
      data.channels.push(row);
    } else {
      if (input.title) row.title = clean(input.title, row.title);
      if (input.url) row.url = String(input.url);
      row.updatedAt = now;
    }
    save(data);
    return row;
  }

  function setFolder(key, folder) {
    const id = normalizeChannelKey(key);
    if (!id) return null;
    const data = load();
    const row = data.channels.find((item) => item.key === id);
    if (!row) return null;
    row.folder = String(folder || '');
    row.updatedAt = new Date().toISOString();
    save(data);
    return summary(row);
  }

  function remove(key) {
    const id = normalizeChannelKey(key);
    if (!id) return false;
    const data = load();
    const next = data.channels.filter((item) => item.key !== id);
    if (next.length === data.channels.length) return false;
    data.channels = next;
    save(data);
    return true;
  }

  function noteIds(ids) {
    const data = load();
    let changed = false;
    for (const id of ids || []) {
      if (addVideo(data, id, '')) changed = true;
    }
    if (changed) save(data);
    return data.videos.map((row) => row.id);
  }

  function noteFolder(dir) {
    return noteIds(idsInFolder(dir));
  }

  // A saved file is remembered by video id. The channel anchor moves only when
  // this save belongs to that channel tab.
  function recordSaved({ id, title, channelKey }) {
    const videoId = String(id || '');
    if (!VIDEO_ID.test(videoId)) return null;
    const data = load();
    addVideo(data, videoId, title);
    const key = normalizeChannelKey(channelKey);
    let row = null;
    if (key) {
      row = data.channels.find((item) => item.key === key) || null;
      if (row) {
        const name = clean(title, videoId);
        if (!row.downloaded.some((item) => item.id === videoId)) {
          row.downloaded.push({ id: videoId, title: name, at: new Date().toISOString() });
        }
        row.anchorId = videoId;
        row.anchorTitle = name;
        row.updatedAt = new Date().toISOString();
      }
    }
    save(data);
    return row ? summary(row) : { id: videoId };
  }

  return {
    summaries,
    downloadedIds,
    savedVideo,
    lookup,
    remember,
    setFolder,
    setAnchor,
    remove,
    noteIds,
    noteFolder,
    recordSaved,
    idsInFolder,
  };
}

export function idsInFolder(dir) {
  return filesInFolder(dir).map((file) => file.id);
}

export function filesInFolder(dir) {
  const folder = String(dir || '').trim();
  if (!folder) return [];
  let names = [];
  try {
    if (!fs.statSync(folder).isDirectory()) return [];
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const name of names) {
    const id = videoIdFromFileName(name);
    if (!id || seen.has(id)) continue;
    const full = path.join(folder, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(id);
    out.push({ id, title: titleFromName(name, id), path: full });
  }
  return out;
}

function titleFromName(name, id) {
  const base = String(name || '').replace(/\.mp4$/i, '');
  const stripped = base.replace(new RegExp(`\\s*\\[${id}\\]\\s*$`, 'i'), '').trim();
  return stripped || id;
}

function addVideo(data, id, title) {
  const videoId = String(id || '');
  if (!VIDEO_ID.test(videoId)) return false;
  const found = data.videos.find((item) => item.id === videoId);
  if (found) {
    if (title && !found.title) found.title = clean(title, videoId);
    return false;
  }
  data.videos.push({ id: videoId, title: clean(title, videoId), at: new Date().toISOString() });
  return true;
}

function summary(row) {
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
  };
}

function compareChannels(a, b) {
  const title = String(a.title || '').localeCompare(String(b.title || ''), 'vi', { sensitivity: 'base' });
  if (title) return title;
  if (a.tab !== b.tab) return a.tab === 'videos' ? -1 : 1;
  return String(a.key).localeCompare(String(b.key));
}

function normalizeVideos(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const id = String(item?.id || '');
    if (!VIDEO_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: clean(item?.title, id), at: String(item?.at || '') });
  }
  return out;
}

function normalizeChannels(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const key = normalizeChannelKey(item?.key);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const downloaded = [];
    const have = new Set();
    for (const video of Array.isArray(item?.downloaded) ? item.downloaded : []) {
      const id = String(video?.id || '');
      if (!VIDEO_ID.test(id) || have.has(id)) continue;
      have.add(id);
      downloaded.push({ id, title: clean(video?.title, id), at: String(video?.at || '') });
    }
    out.push({
      key,
      channelId: key.slice(0, key.indexOf(':')),
      tab: key.endsWith(':shorts') ? 'shorts' : 'videos',
      title: clean(item?.title, key),
      url: String(item?.url || ''),
      folder: String(item?.folder || ''),
      anchorId: VIDEO_ID.test(String(item?.anchorId || '')) ? String(item.anchorId) : '',
      anchorTitle: clean(item?.anchorTitle, ''),
      downloaded,
      updatedAt: String(item?.updatedAt || ''),
    });
  }
  return out;
}

function clean(value, fallback) {
  let text = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length > 140) text = [...text].slice(0, 140).join('').trim();
  return text || String(fallback || '');
}
