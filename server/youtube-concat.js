// Pure helpers for joining videos that are already on disk for one channel tab.
// Number 1 is the newest channel entry that has a file. The join order is the
// order the operator clicked, which can reverse that list.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export const CONCAT_MAX = 20;
export const CONCAT_LOCAL_MAX = 40;
export const CONCAT_BYTES = 16 * 1024 * 1024 * 1024;

export function localVideos(entries, files, limit = CONCAT_LOCAL_MAX) {
  const byId = new Map();
  for (const file of files || []) {
    const id = String(file?.id || '');
    if (!VIDEO_ID.test(id) || byId.has(id)) continue;
    byId.set(id, clean(file?.title, id));
  }
  const cap = Math.max(1, Math.min(CONCAT_LOCAL_MAX, Number(limit) || CONCAT_LOCAL_MAX));
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const id = String(entry?.id || '');
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: clean(entry?.title, byId.get(id)) });
    if (out.length >= cap) break;
  }
  return out;
}

export function concatRequest(ids, marks) {
  if (!Array.isArray(ids) || ids.length < 2) return { ok: false, code: 'few' };
  if (ids.length > CONCAT_MAX) return { ok: false, code: 'many' };
  const list = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw || '');
    if (!VIDEO_ID.test(id) || seen.has(id)) return { ok: false, code: 'few' };
    seen.add(id);
    list.push(id);
  }
  return { ok: true, ids: list, label: markLabel(marks, list.length) };
}

export function concatFileName(label) {
  const text = String(label || '');
  return text ? `Ghep ${text}.mp4` : 'Ghep.mp4';
}

export function concatListBody(paths) {
  return paths.map((file) => {
    const text = String(file || '').replace(/\\/g, '/').replace(/'/g, "'\\''");
    return `file '${text}'`;
  }).join('\n') + '\n';
}

export function concatCopyArgs(listPath, dest) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', dest,
  ];
}

export function readConcatProbe(stderr) {
  const err = String(stderr || '');
  const video = err.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/i);
  const rate = err.match(/(\d+(?:\.\d+)?)\s*fps/i);
  const fps = rate ? Number(rate[1]) : 0;
  return {
    hasVideo: /Stream #.*Video:/i.test(err),
    hasAudio: /Stream #.*Audio:/i.test(err),
    width: video ? parseInt(video[1], 10) : 0,
    height: video ? parseInt(video[2], 10) : 0,
    fps: Number.isFinite(fps) && fps >= 1 && fps <= 120 ? fps : 0,
  };
}

export function concatCanvas(probes) {
  const width = even(Math.max(...probes.map((row) => Number(row.width) || 0)));
  const height = even(Math.max(...probes.map((row) => Number(row.height) || 0)));
  const fps = Number(probes[0]?.fps) || 30;
  return { width, height, fps };
}

export function concatFilter(count, width, height, fps) {
  const n = Math.max(2, Math.min(CONCAT_MAX, Number(count) || 0));
  const rate = Number(fps) || 30;
  const parts = [];
  const tags = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate}[v${i}]`);
    parts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
    tags.push(`[v${i}][a${i}]`);
  }
  parts.push(`${tags.join('')}concat=n=${n}:v=1:a=1[v][a]`);
  return parts.join(';');
}

export function concatEncodeArgs(paths, filter, dest) {
  const inputs = [];
  for (const file of paths) inputs.push('-i', file);
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', dest,
  ];
}

function markLabel(marks, count) {
  if (!Array.isArray(marks) || marks.length !== count) return '';
  const nums = [];
  for (const raw of marks) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > CONCAT_LOCAL_MAX) return '';
    nums.push(String(n));
  }
  return nums.join('-');
}

function even(value) {
  const n = Math.max(2, Math.round(Number(value) || 0));
  return n % 2 === 0 ? n : n + 1;
}

function clean(value, fallback) {
  let text = String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...text].length > 140) text = [...text].slice(0, 140).join('').trim();
  return text || String(fallback || '');
}
