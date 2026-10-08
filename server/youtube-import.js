import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { abortJob } from './jobs.js';
import {
  YOUTUBE_DEFAULT_QUALITY,
  YOUTUBE_MAX_DURATION_SEC,
  YOUTUBE_MAX_FILE_BYTES,
  consumeProcessText,
  youtubeFormatArgs,
  isInsideDir,
  parseYoutubeUrl,
  parseYtDlpProgressLine,
  playlistSlip,
  redactLogLine,
  sanitizeImportFileName,
  youtubeFail,
  ytDlpMaxFilesizeArg,
  classifyYtDlpFailure,
} from './youtube-url.js';
import { normalizeChannelKey } from './youtube-channel.js';
import { CONCAT_BYTES } from './youtube-concat.js';

const POST_ERROR = {
  bad_url: 'Link không hợp lệ.',
  host: 'Chỉ nhận link YouTube (youtube.com hoặc youtu.be).',
  playlist: 'Link playlist không được tải. Hãy dán link một video.',
  not_video: 'Link này không phải một video YouTube.',
  tab: 'Chọn Chỉ lưu file, Unique, Edit hoặc Reframe trước khi tải.',
  quality: 'Chất lượng không hợp lệ.',
  no_ytdlp: 'Không cài được yt-dlp tự động. Kiểm tra mạng rồi bấm kiểm tra lại.',
  no_ffmpeg: 'Không thấy ffmpeg, nên không ghép được hình và tiếng.',
  busy: 'Đang tải một video YouTube khác. Hủy hoặc đợi xong rồi thử lại.',
  cookies: 'Không nhận đường dẫn cookies.',
};

const TABS = new Set(['save', 'unique', 'edit', 'reframe']);
const TOOL_TTL_MS = 60_000;
const PENDING_REAP_MS = 120_000;

export function uniqueStreamBlock(job) {
  if (!job) return { status: 404 };
  if (job.kind === 'edit') return { status: 400, error: 'Use /api/edit/stream for edit jobs' };
  if (job.kind === 'reframe') return { status: 400, error: 'Use /api/reframe/stream for reframe jobs' };
  if (job.kind === 'youtube-import') {
    return { status: 400, error: 'Use /api/youtube-import/stream for YouTube import jobs' };
  }
  return null;
}

function postError(code, status = 400) {
  return { status, body: { error: POST_ERROR[code] || POST_ERROR.bad_url, code } };
}

function childOptions() {
  const options = { windowsHide: true };
  if (process.platform !== 'win32') options.detached = true;
  return options;
}

function dirBytes(dir) {
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(dir); }
  catch { return 0; }
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) total += st.size;
    } catch { /* a file can vanish while yt-dlp renames it */ }
  }
  return total;
}

function parseInfoJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { return null; }
}

function estimateBytes(info) {
  const formats = Array.isArray(info.requested_formats) ? info.requested_formats : [];
  if (formats.length) {
    let sum = 0;
    for (const format of formats) {
      const size = Number(format.filesize ?? format.filesize_approx);
      if (!Number.isFinite(size) || size <= 0) return null;
      sum += size;
    }
    return sum;
  }
  const size = Number(info.filesize ?? info.filesize_approx);
  if (!Number.isFinite(size) || size <= 0) return null;
  return size;
}

function readProbe(stderr) {
  const err = String(stderr || '');
  const durMatch = err.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
  let durationSec = 0;
  if (durMatch) {
    durationSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
  }
  const video = err.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/i);
  const width = video ? parseInt(video[1], 10) : 0;
  const height = video ? parseInt(video[2], 10) : 0;
  const hasVideo = /Stream #.*Video:/i.test(err);
  return { hasVideo, durationSec, width, height };
}

export function youtubeBinDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.youtube-bin');
}

function releaseAsset() {
  if (process.platform === 'win32') {
    return { name: 'yt-dlp.exe', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' };
  }
  if (process.platform === 'darwin') {
    return { name: 'yt-dlp_macos', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos' };
  }
  return { name: 'yt-dlp', url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp' };
}

export async function downloadYtDlpRelease(asset = releaseAsset(), destDir = youtubeBinDir()) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, asset.name);
  const tmp = `${dest}.part`;
  const response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = String(response.headers.get('content-type') || '');
  if (type.includes('text/html')) throw new Error('trang tải không phải file yt-dlp');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 400000) throw new Error('file yt-dlp tải về quá nhỏ');
  fs.writeFileSync(tmp, bytes);
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  return dest;
}

async function pipInstallYtDlp(runProcess) {
  const python = process.env.GHOSTFORGE_PYTHON || 'python';
  const result = await runProcess(
    python,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '--user', 'yt-dlp'],
    { windowsHide: true, timeout: 180000 },
  );
  return Boolean(result && result.status === 0);
}

async function defaultEnsureYtDlp(runProcess) {
  try {
    await downloadYtDlpRelease();
    console.info('youtube-import install bundled');
    return { ok: true, via: 'bundled' };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.info(`youtube-import install download-failed ${redactLogLine(text).slice(0, 120)}`);
  }
  try {
    if (await pipInstallYtDlp(runProcess)) {
      console.info('youtube-import install pip');
      return { ok: true, via: 'python' };
    }
  } catch { /* python or pip is missing */ }
  console.info('youtube-import install failed');
  return { ok: false, via: '' };
}

export function createYoutubeImport({ uploadsDir, jobs, subscribeJob, runProcess, ensureYtDlp, channels, receipts }) {
  const importRoot = path.join(uploadsDir, 'youtube-import');
  let activeYoutubeJobId = null;
  const youtubeFiles = new Map();
  let toolCache = null;
  let ensureOnce = null;

  function releaseSlot(jobId) {
    if (activeYoutubeJobId === jobId) activeYoutubeJobId = null;
  }

  function activeSnapshot() {
    if (!activeYoutubeJobId) return null;
    const job = jobs.get(activeYoutubeJobId);
    if (!job || job.kind !== 'youtube-import') {
      activeYoutubeJobId = null;
      return null;
    }
    return {
      jobId: activeYoutubeJobId,
      state: job.streamState ? 'running' : 'pending',
      videoId: job.videoId,
      targetTab: job.targetTab,
    };
  }

  async function versionOf(command, args) {
    const result = await runProcess(command, args, { windowsHide: true, timeout: 8000 });
    if (!result || result.status !== 0) return '';
    const line = String(result.stdout || '').split(/\r?\n/).map((row) => row.trim()).find(Boolean) || '';
    return redactLogLine(line).slice(0, 120);
  }

  async function probeYtDlp() {
    const candidates = [];
    if (process.env.GHOSTFORGE_YT_DLP) {
      candidates.push({ command: process.env.GHOSTFORGE_YT_DLP, prefixArgs: [], via: 'env' });
    }
    const bundled = path.join(youtubeBinDir(), releaseAsset().name);
    if (fs.existsSync(bundled)) candidates.push({ command: bundled, prefixArgs: [], via: 'bundled' });
    candidates.push({ command: 'yt-dlp', prefixArgs: [], via: 'path' });
    if (process.platform === 'win32') candidates.push({ command: 'yt-dlp.exe', prefixArgs: [], via: 'path' });
    candidates.push({
      command: process.env.GHOSTFORGE_PYTHON || 'python',
      prefixArgs: ['-m', 'yt_dlp'],
      via: 'python',
    });
    for (const candidate of candidates) {
      const version = await versionOf(candidate.command, [...candidate.prefixArgs, '--version']);
      if (version) return { ok: true, version, installedNow: false, ...candidate };
    }
    return { ok: false, via: '', command: '', version: '', prefixArgs: [], installedNow: false };
  }

  async function findYtDlp() {
    const found = await probeYtDlp();
    if (found.ok) return found;
    if (!ensureOnce) {
      const install = ensureYtDlp || (() => defaultEnsureYtDlp(runProcess));
      ensureOnce = Promise.resolve().then(install).finally(() => { ensureOnce = null; });
    }
    await ensureOnce;
    const again = await probeYtDlp();
    if (again.ok) return { ...again, installedNow: true };
    return again;
  }

  async function findFfmpeg() {
    const version = await versionOf('ffmpeg', ['-hide_banner', '-version']);
    if (!version) return { ok: false, path: '', location: '' };
    let location = 'ffmpeg';
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const found = await runProcess(locator, ['ffmpeg'], { windowsHide: true, timeout: 8000 });
    if (found && found.status === 0) {
      const line = String(found.stdout || '').split(/\r?\n/).map((row) => row.trim()).find(Boolean);
      if (line) location = line;
    }
    return { ok: true, path: location, location };
  }

  async function loadTools(fresh) {
    if (fresh) toolCache = null;
    if (toolCache && Date.now() - toolCache.at < TOOL_TTL_MS) {
      return { ...toolCache.value, installedNow: false };
    }
    const yt = await findYtDlp();
    const installedNow = Boolean(yt.installedNow);
    const ffmpeg = await findFfmpeg();
    let message = '';
    if (!yt.ok) message = POST_ERROR.no_ytdlp;
    else if (!ffmpeg.ok) message = POST_ERROR.no_ffmpeg;
    const value = {
      yt: { ...yt, installedNow: false },
      ffmpeg,
      ready: Boolean(yt.ok && ffmpeg.ok),
      message,
      installedNow: false,
    };
    toolCache = { at: Date.now(), value };
    return { ...value, installedNow };
  }

  function statusPayload(tools) {
    const active = activeSnapshot();
    return {
      ready: tools.ready,
      busy: Boolean(active),
      active,
      message: tools.message,
      ytDlp: tools.yt.ok
        ? { ok: true, via: tools.yt.via, command: tools.yt.command, version: tools.yt.version }
        : { ok: false, via: '', command: '', version: '' },
      ffmpeg: tools.ffmpeg.ok ? { ok: true, path: tools.ffmpeg.path } : { ok: false, path: '' },
      installedNow: Boolean(tools.installedNow),
      limits: {
        maxDurationSec: YOUTUBE_MAX_DURATION_SEC,
        maxFileBytes: YOUTUBE_MAX_FILE_BYTES,
        defaultQuality: YOUTUBE_DEFAULT_QUALITY,
      },
    };
  }

  function reapStalePending() {
    if (!activeYoutubeJobId) return;
    const current = jobs.get(activeYoutubeJobId);
    if (!current || current.kind !== 'youtube-import') {
      activeYoutubeJobId = null;
      return;
    }
    const stale = current.status === 'pending'
      && !current.streamState
      && Date.now() - Number(current.createdAt || 0) > PENDING_REAP_MS;
    if (!stale) return;
    const staleId = activeYoutubeJobId;
    activeYoutubeJobId = null;
    jobs.delete(staleId);
    const dir = path.join(importRoot, staleId);
    if (isInsideDir(importRoot, dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  }

  async function begin(body) {
    const input = body || {};
    if (Object.prototype.hasOwnProperty.call(input, 'cookiesPath')) return postError('cookies');
    const quality = input.quality == null || input.quality === '' ? YOUTUBE_DEFAULT_QUALITY : String(input.quality);
    if (!youtubeFormatArgs(quality)) return postError('quality');
    const tab = String(input.tab || '');
    if (!TABS.has(tab)) return postError('tab');
    const parsed = parseYoutubeUrl(input.url);
    if (!parsed.ok) return postError(parsed.code);

    reapStalePending();
    if (activeYoutubeJobId) return postError('busy', 409);

    const jobId = crypto.randomBytes(16).toString('hex');
    const job = {
      id: jobId,
      kind: 'youtube-import',
      status: 'pending',
      videoId: parsed.videoId,
      canonicalUrl: parsed.canonicalUrl,
      quality,
      targetTab: tab,
      channelKey: normalizeChannelKey(input.channelKey),
      createdAt: Date.now(),
      killTree: true,
      importDir: null,
    };
    activeYoutubeJobId = jobId;
    jobs.set(jobId, job);

    const tools = await loadTools(false);
    if (!tools.yt.ok || !tools.ffmpeg.ok) {
      jobs.delete(jobId);
      releaseSlot(jobId);
      return postError(tools.yt.ok ? 'no_ffmpeg' : 'no_ytdlp');
    }
    job.ytCommand = tools.yt.command;
    job.ytPrefix = tools.yt.prefixArgs.slice();
    job.ffmpegLocation = tools.ffmpeg.location;
    return {
      status: 201,
      body: {
        jobId,
        videoId: parsed.videoId,
        canonicalUrl: parsed.canonicalUrl,
        targetTab: tab,
      },
    };
  }

  async function runChild(job, command, args, send, jobDir, watchBytes) {
    let stdoutPending = '';
    let stderrPending = '';
    let stderrText = '';
    let mergeLogged = false;
    const noteComplete = (line) => {
      const slip = playlistSlip(line);
      if (slip) {
        job.failCode = 'playlist_slip';
        abortJob(job);
        return;
      }
      if (!watchBytes) return;
      const progress = parseYtDlpProgressLine(line);
      if (!progress) return;
      if (progress.phase === 'merge' && !mergeLogged) {
        mergeLogged = true;
        send('log', { message: '[YT] Đang ghép hình và tiếng.' });
      }
      const event = { value: progress.value, phase: progress.phase };
      if (progress.phase === 'download' && Number.isFinite(progress.etaMs)) event.etaMs = progress.etaMs;
      send('progress', event);
      if (progress.phase === 'download' && jobDir && dirBytes(jobDir) > YOUTUBE_MAX_FILE_BYTES) {
        job.failCode = 'too_big';
        abortJob(job);
      }
    };
    const take = (pending, chunk) => {
      const consumed = consumeProcessText(pending, chunk);
      for (const line of consumed.lines) noteComplete(line);
      return consumed.pending;
    };
    let result;
    try {
      result = await runProcess(command, args, childOptions(), {
        onSpawn(child) { job.ffmpeg = child; },
        onStdout(text) { stdoutPending = take(stdoutPending, text); },
        onStderr(text) {
          stderrText += text;
          stderrPending = take(stderrPending, text);
        },
      });
    } finally {
      job.ffmpeg = null;
    }
    if (playlistSlip(stdoutPending) || playlistSlip(stderrPending)) {
      job.failCode = 'playlist_slip';
      abortJob(job);
    }
    return {
      status: result ? result.status : -1,
      stdout: result ? result.stdout : '',
      stderr: stderrText || (result ? result.stderr : ''),
      error: result ? result.error : null,
    };
  }

  async function removeImportDir(dir) {
    if (!dir || !isInsideDir(importRoot, dir)) return;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  async function runImport(job, send) {
    const started = Date.now();
    let jobDir = null;
    const logResult = (code, bytes) => {
      console.info(`youtube-import ${job.videoId} ${code} ${Date.now() - started} ${bytes}`);
    };
    const fail = async (code, extra) => {
      const result = youtubeFail(code, extra);
      if (jobDir) await removeImportDir(jobDir);
      job.importDir = null;
      send('error', result);
      logResult(result.code, 0);
    };

    try {
      if (job.cancelled) return fail('cancelled');
      if (!/^[0-9a-f]{32}$/.test(job.id)) return fail('failed');
      jobDir = path.join(importRoot, job.id);
      if (!isInsideDir(importRoot, jobDir)) return fail('failed');
      fs.mkdirSync(jobDir, { recursive: true });
      job.importDir = jobDir;

      send('log', { message: '[YT] Đang đọc thông tin video.' });
      send('progress', { value: 0, phase: 'info' });
      const formatArgs = youtubeFormatArgs(job.quality);
      if (!formatArgs || !job.ytCommand) return fail(job.ytCommand ? 'quality' : 'no_ytdlp');

      const infoRun = await runChild(job, job.ytCommand, [
        ...job.ytPrefix,
        '--dump-single-json',
        '--skip-download',
        '--no-playlist',
        '--no-colors',
        ...formatArgs,
        job.canonicalUrl,
      ], send, jobDir, false);
      if (job.failCode) return fail(job.failCode);
      if (job.cancelled) return fail('cancelled');
      if (infoRun.status !== 0) return failFromRun(infoRun, fail);

      const info = parseInfoJson(infoRun.stdout);
      if (!info || Array.isArray(info) || info._type === 'playlist') return fail('playlist_slip');
      if (String(info.id || '') !== job.videoId) return fail('id_mismatch');
      const live = String(info.live_status || '');
      if (live === 'is_live' || live === 'is_upcoming' || live === 'post_live') return fail('live');
      const duration = Number(info.duration);
      if (!Number.isFinite(duration)) return fail('unknown_duration');
      if (duration > YOUTUBE_MAX_DURATION_SEC) return fail('too_long');
      const availability = String(info.availability || '');
      if (availability === 'private') return fail('private');
      if (availability === 'needs_auth') return fail('age');
      if (availability === 'premium_only' || availability === 'subscriber_only') return fail('members');
      const estimate = estimateBytes(info);
      if (estimate != null && estimate > YOUTUBE_MAX_FILE_BYTES) return fail('too_big');

      send('log', { message: '[YT] Đang tải.' });
      const download = await runChild(job, job.ytCommand, [
        ...job.ytPrefix,
        '--no-playlist',
        '--newline',
        '--no-colors',
        ...formatArgs,
        '--merge-output-format',
        'mp4',
        '--remux-video',
        'mp4',
        '--max-filesize',
        ytDlpMaxFilesizeArg(YOUTUBE_MAX_FILE_BYTES),
        '--retries',
        '2',
        '--fragment-retries',
        '2',
        '--socket-timeout',
        '20',
        '--no-mtime',
        '--no-write-subs',
        '--no-write-auto-subs',
        '--no-embed-subs',
        '-o',
        path.join(jobDir, '%(id)s.%(ext)s'),
        '--ffmpeg-location',
        job.ffmpegLocation || 'ffmpeg',
        job.canonicalUrl,
      ], send, jobDir, true);
      if (job.failCode) return fail(job.failCode);
      if (job.cancelled) return fail('cancelled');
      if (download.status !== 0) return failFromRun(download, fail);

      const mp4s = fs.readdirSync(jobDir)
        .filter((name) => name.toLowerCase().endsWith('.mp4'))
        .map((name) => path.join(jobDir, name))
        .filter((file) => {
          try { return fs.statSync(file).isFile(); }
          catch { return false; }
        });
      if (mp4s.length !== 1) return fail('output');
      let mp4 = mp4s[0];
      const size = fs.statSync(mp4).size;
      if (size < 100) return fail('output');
      if (size > YOUTUBE_MAX_FILE_BYTES) return fail('too_big');

      const probe = await runChild(job, 'ffmpeg', ['-hide_banner', '-i', mp4], send, jobDir, false);
      if (job.failCode) return fail(job.failCode);
      if (job.cancelled) return fail('cancelled');
      if (probe.error && probe.error.code === 'ENOENT') return fail('no_ffmpeg');
      const media = readProbe(probe.stderr);
      if (!media.hasVideo || media.durationSec < 0.5 || media.width < 64 || media.height < 64) return fail('probe');

      const renamed = path.join(jobDir, path.basename(sanitizeImportFileName(info.title, job.videoId)));
      if (!isInsideDir(jobDir, renamed)) return fail('output');
      if (path.resolve(mp4) !== path.resolve(renamed)) fs.renameSync(mp4, renamed);
      for (const name of fs.readdirSync(jobDir)) {
        const file = path.join(jobDir, name);
        if (path.resolve(file) === path.resolve(renamed)) continue;
        fs.rmSync(file, { recursive: true, force: true });
      }
      const finalSize = fs.statSync(renamed).size;
      if (finalSize > YOUTUBE_MAX_FILE_BYTES) return fail('too_big');

      youtubeFiles.set(job.id, {
        dir: jobDir,
        filePath: renamed,
        videoId: job.videoId,
        title: String(info.title || job.videoId),
        channelKey: job.channelKey || '',
      });
      jobDir = null;
      job.importDir = null;
      send('done', {
        file: {
          name: path.basename(renamed),
          path: renamed,
          folder: path.dirname(renamed),
          size: finalSize,
        },
        videoId: job.videoId,
        title: String(info.title || job.videoId),
        height: media.height,
        durationSec: media.durationSec,
        quality: job.quality,
        targetTab: job.targetTab,
      });
      logResult('ok', finalSize);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/enospc|no space left/i.test(text)) return fail('disk');
      return fail('failed', text);
    }
  }

  async function statusHandler(req, res) {
    try {
      const tools = await loadTools(String(req.query?.fresh || '') === '1');
      res.json(statusPayload(tools));
    } catch (err) {
      res.json({
        ready: false,
        busy: Boolean(activeSnapshot()),
        active: activeSnapshot(),
        message: err instanceof Error ? err.message : String(err),
        ytDlp: { ok: false, via: '', command: '', version: '' },
        ffmpeg: { ok: false, path: '' },
        installedNow: false,
        limits: {
          maxDurationSec: YOUTUBE_MAX_DURATION_SEC,
          maxFileBytes: YOUTUBE_MAX_FILE_BYTES,
          defaultQuality: YOUTUBE_DEFAULT_QUALITY,
        },
      });
    }
  }

  function postHandler(req, res) {
    begin(req.body || {}).then((out) => {
      res.status(out.status).json(out.body);
    }).catch((err) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    });
  }

  function streamHandler(req, res) {
    const jobId = String(req.params.jobId || '');
    if (!/^[0-9a-f]{32}$/.test(jobId)) return res.status(404).end();
    const job = jobs.get(jobId);
    if (!job || job.kind !== 'youtube-import') return res.status(404).end();
    const send = subscribeJob(job, res);
    if (!send) return;
    runImport(job, send).finally(() => {
      releaseSlot(jobId);
      jobs.delete(jobId);
    });
  }

  function deleteHandler(req, res) {
    const jobId = String(req.params.jobId || '');
    if (!/^[0-9a-f]{32}$/.test(jobId)) {
      return res.status(404).json({ error: 'Không còn file import này.' });
    }
    const live = jobs.get(jobId);
    if (live && live.kind === 'youtube-import' && activeYoutubeJobId === jobId) {
      return res.status(409).json({ error: 'Đang tải video này. Hủy trước đã.' });
    }
    const saved = youtubeFiles.get(jobId);
    if (!saved || !isInsideDir(importRoot, saved.dir)) {
      return res.status(404).json({ error: 'Không còn file import này.' });
    }
    try { fs.rmSync(saved.dir, { recursive: true, force: true }); }
    catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    youtubeFiles.delete(jobId);
    res.json({ ok: true });
  }

  function saveHandler(req, res) {
    const jobId = String(req.params.jobId || '');
    if (!/^[0-9a-f]{32}$/.test(jobId)) {
      return res.status(404).json({ error: 'Không còn file import này.' });
    }
    const saved = youtubeFiles.get(jobId);
    const fileReady = Boolean(
      saved
      && saved.filePath
      && isInsideDir(importRoot, saved.dir)
      && isInsideDir(saved.dir, saved.filePath)
      && fs.existsSync(saved.filePath),
    );
    if (!fileReady) {
      const live = jobs.get(jobId);
      const stillRunning = live
        && live.kind === 'youtube-import'
        && activeYoutubeJobId === jobId
        && live.status !== 'done';
      if (stillRunning) {
        return res.status(409).json({ error: 'Đang tải video này. Đợi xong đã.' });
      }
      return res.status(404).json({ error: 'Không còn file import này.' });
    }
    const requested = String(req.body?.path || '').trim();
    if (!requested || !fs.existsSync(requested)) {
      return res.status(400).json({ error: 'Chưa chọn thư mục lưu.' });
    }
    let destRoot = '';
    try {
      if (!fs.statSync(requested).isDirectory()) {
        return res.status(400).json({ error: 'Chưa chọn thư mục lưu.' });
      }
      destRoot = fs.realpathSync(requested);
    } catch {
      return res.status(400).json({ error: 'Chưa chọn thư mục lưu.' });
    }
    let importReal = importRoot;
    try { importReal = fs.realpathSync(importRoot); } catch { /* the import root may not exist yet */ }
    if (isInsideDir(importReal, destRoot) || isInsideDir(importRoot, destRoot)) {
      return res.status(400).json({ error: 'Không lưu vào thư mục import.' });
    }
    const filename = path.basename(saved.filePath);
    const parsed = path.parse(filename);
    let dest = '';
    let name = '';
    for (let n = 0; n < 10000; n++) {
      name = n ? `${parsed.name} (${n})${parsed.ext}` : filename;
      dest = path.join(destRoot, name);
      if (!isInsideDir(destRoot, dest)) {
        return res.status(400).json({ error: 'Không lưu vào thư mục import.' });
      }
      try {
        fs.copyFileSync(saved.filePath, dest, fs.constants.COPYFILE_EXCL);
        break;
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          dest = '';
          continue;
        }
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!dest) return res.status(409).json({ error: 'Too many files with this name' });
    const channelKey = normalizeChannelKey(req.body?.channelKey) || saved.channelKey || '';
    const removeSource = req.body?.removeSource === true;
    if (channels && typeof channels.recordSaved === 'function') {
      try {
        channels.recordSaved({
          id: saved.videoId,
          title: saved.title || saved.videoId,
          channelKey,
        });
      } catch { /* the copy already landed; a ledger miss must not hide it */ }
    }
    if (receipts && typeof receipts.note === 'function') {
      try {
        receipts.note({
          id: jobId,
          videoId: saved.videoId,
          title: saved.title || saved.videoId,
          channelKey,
          savedPath: dest,
          holdPath: removeSource ? '' : saved.filePath,
        });
      } catch { /* the copy already landed */ }
    }
    if (removeSource) {
      try { fs.rmSync(saved.dir, { recursive: true, force: true }); }
      catch (err) {
        return res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
          dest,
          folder: destRoot,
          name,
          removed: false,
        });
      }
      youtubeFiles.delete(jobId);
    }
    res.json({ ok: true, dest, folder: destRoot, name, removed: removeSource });
  }

  function hold(body) {
    const requested = String(body?.path || '').trim();
    if (!requested) return { status: 400, body: { error: 'Không thấy file ghép.', code: 'file' } };
    let source = '';
    let size = 0;
    try {
      const stat = fs.statSync(requested);
      if (!stat.isFile()) return { status: 400, body: { error: 'Không thấy file ghép.', code: 'file' } };
      size = stat.size;
      source = fs.realpathSync(requested);
    } catch {
      return { status: 400, body: { error: 'Không thấy file ghép.', code: 'file' } };
    }
    const base = path.basename(source);
    if (size < 100 || size > CONCAT_BYTES || !/^[^\\/:*?"<>|]+\.mp4$/i.test(base) || base.length > 180) {
      return { status: 400, body: { error: 'File ghép không dùng được.', code: 'file' } };
    }
    let root = importRoot;
    try { root = fs.realpathSync(importRoot); } catch { /* the import root may not exist yet */ }
    if (isInsideDir(root, source) || isInsideDir(importRoot, source)) {
      return { status: 400, body: { error: 'File này đã nằm trong thư mục import.', code: 'file' } };
    }
    const jobId = crypto.randomBytes(16).toString('hex');
    const dir = path.join(importRoot, jobId);
    const dest = path.join(dir, base);
    fs.mkdirSync(importRoot, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    if (!isInsideDir(dir, dest)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { status: 400, body: { error: 'File ghép không dùng được.', code: 'file' } };
    }
    try {
      fs.copyFileSync(source, dest);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err), code: 'failed' } };
    }
    youtubeFiles.set(jobId, { dir, filePath: dest, videoId: '', title: base, channelKey: '' });
    return { status: 200, body: { jobId, file: { name: base, path: dest, folder: dir, size } } };
  }

  function holdHandler(req, res) {
    try {
      const out = hold(req.body || {});
      res.status(out.status).json(out.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err), code: 'failed' });
    }
  }

  return {
    statusHandler,
    postHandler,
    streamHandler,
    deleteHandler,
    saveHandler,
    holdHandler,
    begin,
    runImport,
    resolveTools: () => loadTools(false),
  };
}

function failFromRun(run, fail) {
  if (run.error && run.error.code === 'ENOENT') return fail('no_ytdlp');
  const classified = classifyYtDlpFailure(run.stderr);
  if (classified.code === 'failed') return fail('failed', run.stderr);
  return fail(classified.code);
}
