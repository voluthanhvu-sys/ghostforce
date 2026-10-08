import { YOUTUBE_HOSTS } from './youtube-url.js';

export const CHANNEL_LIST_LIMIT = 1000;
export const CHANNEL_COUNT_MAX = 30;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const FILE_ID = /\[([A-Za-z0-9_-]{11})\]\.mp4$/i;
const SKIP_AVAILABILITY = new Set(['subscriber_only', 'private', 'needs_auth', 'premium_only']);

export function channelKey(channelId, tab) {
  const id = String(channelId || '');
  const name = tab === 'shorts' ? 'shorts' : (tab === 'videos' ? 'videos' : '');
  if (!CHANNEL_ID.test(id) || !name) return '';
  return `${id}:${name}`;
}

export function normalizeChannelKey(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^(UC[A-Za-z0-9_-]{22}):(videos|shorts)$/);
  return match ? `${match[1]}:${match[2]}` : '';
}

export function parseChannelUrl(raw) {
  const text = String(raw ?? '').trim();
  let url;
  try { url = new URL(text); }
  catch { return { ok: false, code: 'bad_url' }; }
  if (url.username || url.password) return { ok: false, code: 'bad_url' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, code: 'bad_url' };
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!YOUTUBE_HOSTS.has(host)) return { ok: false, code: 'host' };
  if (url.searchParams.has('list')) return { ok: false, code: 'playlist' };

  const parts = url.pathname.split('/').filter(Boolean).map(decodeSegment);
  const first = parts[0] || '';
  if (first === 'playlist') return { ok: false, code: 'playlist' };
  if (host === 'youtu.be') return { ok: false, code: 'not_channel' };
  if (first === 'watch' || first === 'embed' || first === 'live' || first === 'v' || first === 'clip') {
    return { ok: false, code: 'not_channel' };
  }
  if (first === 'shorts' && VIDEO_ID.test(parts[1] || '')) return { ok: false, code: 'not_channel' };
  if (first === 'results' || first === 'feed' || first === 'hashtag') return { ok: false, code: 'not_channel' };

  let base = '';
  let tab = 'videos';
  if (first.startsWith('@')) {
    if (!isHandle(first) || parts.length > 2) return { ok: false, code: 'not_channel' };
    base = first;
    if (parts[1]) {
      const picked = tabOf(parts[1]);
      if (!picked) return { ok: false, code: 'not_channel' };
      tab = picked;
    }
  } else if (first === 'channel' && CHANNEL_ID.test(parts[1] || '')) {
    if (parts.length > 3) return { ok: false, code: 'not_channel' };
    base = `channel/${parts[1]}`;
    if (parts[2]) {
      const picked = tabOf(parts[2]);
      if (!picked) return { ok: false, code: 'not_channel' };
      tab = picked;
    }
  } else if ((first === 'c' || first === 'user') && isName(parts[1])) {
    if (parts.length > 3) return { ok: false, code: 'not_channel' };
    base = `${first}/${parts[1]}`;
    if (parts[2]) {
      const picked = tabOf(parts[2]);
      if (!picked) return { ok: false, code: 'not_channel' };
      tab = picked;
    }
  } else {
    return { ok: false, code: 'not_channel' };
  }

  return { ok: true, tab, listUrl: `https://www.youtube.com/${base}/${tab}` };
}

// Newest entry is first. "above" walks toward newer videos, closest first.
// "below" walks toward older videos, closest first. No anchor means the
// newest videos that are not already downloaded. A missing anchor is reported
// and does not invent a side.
export function planChannelBatch({ entries, downloadedIds, anchorId }) {
  const list = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const id = String(entry?.id || '');
    if (!VIDEO_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, title: cleanTitle(entry?.title, id) });
  }
  const downloaded = new Set();
  for (const id of downloadedIds || []) {
    const text = String(id || '');
    if (VIDEO_ID.test(text)) downloaded.add(text);
  }
  const fresh = (row) => !downloaded.has(row.id);
  const anchor = String(anchorId || '');
  if (!anchor) {
    const first = list.filter(fresh);
    return {
      ok: true,
      anchor: null,
      anchorMissing: false,
      newVideos: [],
      above: [],
      below: [],
      first,
      newCount: 0,
      aboveCount: 0,
      belowCount: 0,
    };
  }
  const index = list.findIndex((row) => row.id === anchor);
  if (index < 0) {
    return {
      ok: false,
      code: 'anchor_missing',
      anchor: null,
      anchorMissing: true,
      newVideos: [],
      above: [],
      below: [],
      first: [],
      newCount: 0,
      aboveCount: 0,
      belowCount: 0,
    };
  }
  const above = [];
  for (let i = index - 1; i >= 0; i -= 1) {
    if (fresh(list[i])) above.push(list[i]);
  }
  const below = [];
  for (let i = index + 1; i < list.length; i += 1) {
    if (fresh(list[i])) below.push(list[i]);
  }
  return {
    ok: true,
    anchor: list[index],
    anchorMissing: false,
    newVideos: above,
    above,
    below,
    first: [],
    newCount: above.length,
    aboveCount: above.length,
    belowCount: below.length,
  };
}

export function readFlatPlaylist(raw, limit = CHANNEL_LIST_LIMIT) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(extractJson(raw)) : raw; }
  catch { return { ok: false, code: 'list_failed' }; }
  if (!data || typeof data !== 'object') return { ok: false, code: 'list_failed' };
  const channelId = String(data.channel_id || (CHANNEL_ID.test(String(data.uploader_id || '')) ? data.uploader_id : ''));
  if (!CHANNEL_ID.test(channelId)) return { ok: false, code: 'no_channel' };
  const source = Array.isArray(data.entries) ? data.entries : [];
  const entries = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || entry._type === 'playlist') continue;
    if (SKIP_AVAILABILITY.has(String(entry.availability || ''))) continue;
    const id = String(entry.id || '');
    if (!VIDEO_ID.test(id)) continue;
    entries.push({ id, title: cleanTitle(entry.title, id) });
    if (entries.length >= limit) break;
  }
  const playlistCount = Number(data.playlist_count || 0);
  const truncated = source.length >= limit || (playlistCount > source.length && source.length > 0);
  return {
    ok: true,
    channelId,
    title: cleanTitle(data.channel || data.uploader || data.title, channelId),
    entries,
    truncated,
  };
}

export function videoIdFromFileName(name) {
  const match = String(name || '').match(FILE_ID);
  return match ? match[1] : '';
}

function tabOf(segment) {
  const name = String(segment || '').toLowerCase();
  if (name === 'videos' || name === 'featured') return 'videos';
  if (name === 'shorts') return 'shorts';
  return '';
}

function isHandle(segment) {
  return segment.startsWith('@') && segment.length >= 2 && segment.length <= 80 && !/[\s/?#]/.test(segment);
}

function isName(segment) {
  const text = String(segment || '');
  if (!text || text.length > 80 || /[\s/?#]/.test(text)) return false;
  const lower = text.toLowerCase();
  return lower !== 'videos' && lower !== 'shorts' && lower !== 'featured';
}

function decodeSegment(segment) {
  try { return decodeURIComponent(segment); }
  catch { return segment; }
}

function cleanTitle(value, fallback) {
  let text = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length > 140) text = [...text].slice(0, 140).join('').trim();
  return text || String(fallback || '');
}

function extractJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no json');
  return raw.slice(start, end + 1);
}
