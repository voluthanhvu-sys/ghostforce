import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  YOUTUBE_FORMATS,
  YOUTUBE_MAX_FILE_BYTES,
  classifyYtDlpFailure,
  consumeProcessText,
  YOUTUBE_QUALITY_CAPS,
  formatSelector,
  formatSort,
  youtubeFormatArgs,
  isInsideDir,
  parseYoutubeUrl,
  parseYtDlpProgressLine,
  playlistSlip,
  redactLogLine,
  sanitizeImportFileName,
  ytDlpMaxFilesizeArg,
} from '../server/youtube-url.js';

const ID = 'dQw4w9WgXcQ';

test('parseYoutubeUrl accepts allowlisted hosts and rebuilds a canonical watch URL', () => {
  const samples = [
    `https://www.youtube.com/watch?v=${ID}`,
    `http://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}&t=12`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/v/${ID}`,
    `https://youtu.be/${ID}?si=SECRET`,
  ];
  for (const raw of samples) {
    const parsed = parseYoutubeUrl(raw);
    assert.equal(parsed.ok, true, raw);
    assert.equal(parsed.videoId, ID);
    assert.equal(parsed.canonicalUrl, `https://www.youtube.com/watch?v=${ID}`);
  }
});

test('parseYoutubeUrl rejects userinfo, other hosts, and non-video shapes', () => {
  assert.equal(parseYoutubeUrl(`https://user:pass@youtube.com/watch?v=${ID}`).code, 'bad_url');
  assert.equal(parseYoutubeUrl(`https://evil.example/watch?v=${ID}`).code, 'host');
  assert.equal(parseYoutubeUrl(`https://youtube.com.evil.example/watch?v=${ID}`).code, 'host');
  assert.equal(parseYoutubeUrl('file:///etc/passwd').code, 'bad_url');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/watch?v=short').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/playlist?list=PLxxxx').code, 'playlist');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/watch?list=PLxxxx').code, 'playlist');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/c/name').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/user/name').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/@name').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/feed/trending').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/results?search_query=cat').code, 'not_video');
  assert.equal(parseYoutubeUrl('https://www.youtube.com/hashtag/name').code, 'not_video');
  assert.equal(parseYoutubeUrl(`https://www.youtube.com/playlist?list=PLxxxx&v=${ID}`).code, 'playlist');
});

test('a watch URL with both v and list is one video and drops the list', () => {
  const parsed = parseYoutubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLxxxx&si=SECRET`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.canonicalUrl, `https://www.youtube.com/watch?v=${ID}`);
});

test('format selector caps the shorter side and keeps every YouTube size', () => {
  assert.deepEqual(YOUTUBE_QUALITY_CAPS, ['144', '240', '360', '480', '720', '1080', '1440', '2160', '4320']);
  for (const quality of [...YOUTUBE_QUALITY_CAPS, 'best']) {
    assert.equal(formatSelector(quality), YOUTUBE_FORMATS[quality]);
    assert.equal(String(YOUTUBE_FORMATS[quality]).includes('height<='), false);
    assert.ok(formatSort(quality));
    assert.deepEqual(youtubeFormatArgs(quality), ['-f', YOUTUBE_FORMATS[quality], '--format-sort', formatSort(quality)]);
  }
  assert.equal(formatSort('1080'), 'res:1080,+vcodec:avc,+acodec:m4a');
  assert.equal(formatSort('best'), 'res,+vcodec:avc,+acodec:m4a');
  assert.equal(formatSelector('4k'), null);
  assert.equal(formatSort('4k'), null);
  assert.equal(youtubeFormatArgs('4k'), null);
  assert.equal(ytDlpMaxFilesizeArg(YOUTUBE_MAX_FILE_BYTES), '8589934592');
});

test('progress lines keep ETA and ignore incomplete or junk lines', () => {
  const line = parseYtDlpProgressLine('[download]  45.2% of ~12.34MiB at 1.23MiB/s ETA 00:08');
  assert.deepEqual(line, { phase: 'download', value: 45.2, etaMs: 8000 });
  const longEta = parseYtDlpProgressLine('[download] 10% of 1MiB ETA 01:02:03');
  assert.equal(longEta.etaMs, ((1 * 60 + 2) * 60 + 3) * 1000);
  assert.equal(parseYtDlpProgressLine('[download] 10% ETA Unknown').etaMs, undefined);
  assert.deepEqual(parseYtDlpProgressLine('[Merger] Merging formats into "out.mp4"'), { phase: 'merge', value: 100 });
  assert.equal(parseYtDlpProgressLine('[download] Destination: file'), null);
});

test('consumeProcessText holds a split line until the newline arrives', () => {
  const first = consumeProcessText('', '[download]  45.2% of 1MiB ETA 00:');
  assert.deepEqual(first.lines, []);
  const second = consumeProcessText(first.pending, '08\n');
  assert.equal(second.pending, '');
  assert.equal(second.lines.length, 1);
  assert.equal(parseYtDlpProgressLine(second.lines[0]).etaMs, 8000);
});

test('playlistSlip matches item and video wording only when more than one item is listed', () => {
  assert.deepEqual(playlistSlip('Downloading item 1 of 3'), { n: 1, m: 3 });
  assert.deepEqual(playlistSlip('Downloading video 2 of 4'), { n: 2, m: 4 });
  assert.equal(playlistSlip('Downloading item 1 of 1'), null);
  assert.equal(playlistSlip('[download] 10%'), null);
});

test('classifyYtDlpFailure reads the whole stderr string', () => {
  assert.equal(classifyYtDlpFailure('ERROR: Private video').code, 'private');
  assert.equal(classifyYtDlpFailure('Sign in to confirm your age').code, 'age');
  assert.equal(classifyYtDlpFailure('Video unavailable. This video is not available in your country').code, 'region');
  assert.equal(classifyYtDlpFailure('HTTP Error 403: Forbidden').code, 'blocked');
  assert.equal(classifyYtDlpFailure('ERROR: [Errno 28] No space left on device').code, 'disk');
  assert.equal(classifyYtDlpFailure('ERROR: ffprobe not found').code, 'no_ffmpeg');
  assert.equal(classifyYtDlpFailure('ERROR: requested format is not available').code, 'no_format');
  const half = classifyYtDlpFailure('not available in your coun');
  assert.notEqual(half.code, 'region');
});

test('sanitizeImportFileName keeps Vietnamese and dots, and always ends with the video id', () => {
  const name = sanitizeImportFileName('Tiêu đề <bad> foo..bar', ID);
  assert.equal(name.endsWith(` [${ID}].mp4`), true);
  assert.equal(name.includes('Tiêu'), true);
  assert.equal(name.includes('foo..bar'), true);
  assert.equal(name.includes('<'), false);
  assert.equal(sanitizeImportFileName('   ', ID), `${ID} [${ID}].mp4`);
});

test('redactLogLine strips URLs and isInsideDir blocks paths outside the root', () => {
  const redacted = redactLogLine('see https://rr3---sn.googlevideo.com/videoplayback?sig=abc now');
  assert.equal(redacted.includes('https://'), false);
  assert.equal(redacted.includes('sig='), false);
  const root = path.join(os.tmpdir(), 'gf-yt-root');
  assert.equal(isInsideDir(root, path.join(root, 'clip.mp4')), true);
  assert.equal(isInsideDir(root, path.join(root, '..', 'other')), false);
  assert.equal(isInsideDir(root, path.resolve(root, '../outside.mp4')), false);
});
