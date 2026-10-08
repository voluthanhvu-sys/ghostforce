import path from 'path';

export const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

export const YOUTUBE_MAX_DURATION_SEC = 7200;
export const YOUTUBE_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const YOUTUBE_DEFAULT_QUALITY = '1080';

// YouTube's player ladder. Each number is a ceiling on the shorter side.
export const YOUTUBE_QUALITY_CAPS = ['144', '240', '360', '480', '720', '1080', '1440', '2160', '4320'];

// One selector for every choice. The ceiling is formatSort(), not height<=.
// height<=1080 drops a 1080×1920 Short, because that frame is 1920 tall.
const YOUTUBE_FORMAT = 'bv*+ba/b';

export const YOUTUBE_FORMATS = {
  best: YOUTUBE_FORMAT,
  ...Object.fromEntries(YOUTUBE_QUALITY_CAPS.map((cap) => [cap, YOUTUBE_FORMAT])),
};

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

const FAIL_MESSAGE = {
  private: 'Video này ở chế độ riêng tư.',
  age: 'Video giới hạn tuổi hoặc cần đăng nhập. Bản này chưa đọc cookies.',
  members: 'Video chỉ dành cho thành viên kênh.',
  region: 'YouTube chặn video này theo khu vực.',
  deleted: 'Video không còn trên YouTube hoặc đã bị xóa.',
  live: 'Video đang phát trực tiếp hoặc chưa có bản xem lại.',
  too_long: 'Video dài hơn 2 giờ. Không tải.',
  too_big: 'File vượt quá 8 GiB. Không tải.',
  unknown_duration: 'Không đọc được thời lượng. Không tải.',
  id_mismatch: 'Thông tin YouTube không khớp video đã chọn. Đã dừng.',
  playlist_slip: 'Link này vẫn trỏ tới nhiều video. Đã dừng.',
  no_format: 'YouTube không có bản H.264/AAC trong tầm đã chọn.',
  no_ffmpeg: 'Máy không ghép được hình và tiếng vì thiếu ffmpeg.',
  blocked: 'YouTube từ chối lượt tải. Không thử vượt chặn.',
  disk: 'Hết dung lượng ổ đĩa.',
  cancelled: 'Đã hủy tải từ YouTube.',
  probe: 'File tải về không phải video xem được.',
  output: 'yt-dlp không tạo được file mp4.',
  failed: 'Tải thất bại.',
};

export function youtubeFail(code, extra) {
  const message = FAIL_MESSAGE[code] || FAIL_MESSAGE.failed;
  if (code === 'failed' && extra) {
    const bit = redactLogLine(extra);
    if (bit) return { code: 'failed', message: `${message} ${bit}`.slice(0, 240) };
  }
  return { code: FAIL_MESSAGE[code] ? code : 'failed', message };
}

export function parseYoutubeUrl(raw) {
  const text = String(raw ?? '').trim();
  let url;
  try { url = new URL(text); }
  catch { return { ok: false, code: 'bad_url' }; }
  if (url.username || url.password) return { ok: false, code: 'bad_url' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, code: 'bad_url' };
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!YOUTUBE_HOSTS.has(host)) return { ok: false, code: 'host' };

  const parts = url.pathname.split('/').filter(Boolean);
  const first = parts[0] || '';
  if (first === 'playlist') return { ok: false, code: 'playlist' };

  let videoId = '';
  if (host === 'youtu.be') {
    if (parts.length === 1 && VIDEO_ID.test(parts[0])) videoId = parts[0];
  } else if (first === 'watch' || first === '') {
    const v = url.searchParams.get('v') || '';
    if (VIDEO_ID.test(v)) videoId = v;
  } else if ((first === 'embed' || first === 'shorts' || first === 'live' || first === 'v') && VIDEO_ID.test(parts[1] || '')) {
    videoId = parts[1];
  }

  if (videoId) {
    return { ok: true, videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
  }

  if (url.searchParams.has('list')) return { ok: false, code: 'playlist' };
  if (
    first === 'channel'
    || first === 'c'
    || first === 'user'
    || first === 'feed'
    || first === 'results'
    || first === 'hashtag'
    || first.startsWith('@')
  ) {
    return { ok: false, code: 'not_video' };
  }
  return { ok: false, code: 'not_video' };
}

export function formatSelector(quality) {
  if (quality === 'best' || YOUTUBE_QUALITY_CAPS.includes(quality)) return YOUTUBE_FORMAT;
  return null;
}

// res:N keeps the largest picture whose shorter side is at most N, in either
// orientation. +vcodec:avc prefers H.264 when that size has it, and still
// takes VP9 or AV1 when YouTube has no H.264 at that size.
export function formatSort(quality) {
  if (quality === 'best') return 'res,+vcodec:avc,+acodec:m4a';
  if (YOUTUBE_QUALITY_CAPS.includes(quality)) return `res:${quality},+vcodec:avc,+acodec:m4a`;
  return null;
}

export function youtubeFormatArgs(quality) {
  const selector = formatSelector(quality);
  const sort = formatSort(quality);
  if (!selector || !sort) return null;
  return ['-f', selector, '--format-sort', sort];
}

export function parseYtDlpProgressLine(line) {
  const text = String(line || '');
  if (/\[Merger\]|\[VideoRemuxer\]/.test(text)) return { phase: 'merge', value: 100 };
  const match = text.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  if (!match) return null;
  const value = Number(match[1]);
  const out = { phase: 'download', value };
  if (!/ETA Unknown/i.test(text)) {
    const eta = text.match(/ETA\s+(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})\b/);
    if (eta) {
      const parts = eta[1].split(':').map((n) => Number(n));
      const seconds = parts.length === 3
        ? (parts[0] * 60 + parts[1]) * 60 + parts[2]
        : parts[0] * 60 + parts[1];
      out.etaMs = seconds * 1000;
    }
  }
  return out;
}

export function consumeProcessText(pending, chunk) {
  const combined = `${String(pending || '')}${String(chunk || '')}`.replace(ANSI, '');
  const bits = combined.split(/\r?\n/);
  const next = bits.pop() ?? '';
  return { lines: bits, pending: next };
}

export function playlistSlip(line) {
  const match = String(line || '').match(/Downloading (?:item|video) (\d+) of (\d+)/i);
  if (!match) return null;
  const n = Number(match[1]);
  const total = Number(match[2]);
  if (!(total > 1)) return null;
  return { n, m: total };
}

export function classifyYtDlpFailure(text) {
  const raw = String(text || '');
  const low = raw.toLowerCase();
  if (/confirm you.?re not a bot|http error 403|\b403\b/.test(low)) return youtubeFail('blocked');
  if (/no space left|enospc/.test(low)) return youtubeFail('disk');
  if (/ffmpeg.*not found|ffprobe.*not found|ffmpeg not found/.test(low)) return youtubeFail('no_ffmpeg');
  if (/not available in your country/.test(low)) return youtubeFail('region');
  if (/members-only|members only|join this channel|premium only|subscriber only/.test(low)) return youtubeFail('members');
  if (/private video|\bprivate\b/.test(low)) return youtubeFail('private');
  if (/confirm your age|\bsign in\b/.test(low)) return youtubeFail('age');
  if (/premieres in|is live|live event|not started|premiere/.test(low)) return youtubeFail('live');
  if (/requested format is not available/.test(low)) return youtubeFail('no_format');
  if (/max-filesize|file is larger than/.test(low)) return youtubeFail('too_big');
  if (/has been removed|video unavailable|has been deleted|this video is unavailable/.test(low)) return youtubeFail('deleted');
  return youtubeFail('failed', raw);
}

export function sanitizeImportFileName(title, videoId) {
  const id = String(videoId || '').trim() || 'video';
  let stem = String(title || '').normalize('NFKC');
  stem = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  if ([...stem].length > 80) stem = [...stem].slice(0, 80).join('').trim();
  if (!stem) stem = id;
  return `${stem} [${id}].mp4`;
}

export function ytDlpMaxFilesizeArg(bytes) {
  return String(bytes);
}

export function redactLogLine(line) {
  let text = String(line || '');
  text = text.replace(/https?:\/\/\S+/gi, '');
  text = text.replace(/\?[^\s]*/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 180) text = text.slice(0, 180);
  return text;
}

export function isInsideDir(root, candidate) {
  const base = path.resolve(String(root || ''));
  const target = path.resolve(String(candidate || ''));
  const rel = path.relative(base, target);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}
