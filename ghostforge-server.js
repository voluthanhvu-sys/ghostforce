import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { planUniquePause, releaseSuspendedPid, runProcess, setProcessSuspended } from './server/process.js';
import { jobs, subscribeJob, jobSignal, abortJob, ensureAbort } from './server/jobs.js';
import { createSaveDirStore } from './server/save-dir.js';
import { createGeminiSecretStore } from './server/gemini-secrets.js';
import { orderDetailModels, createOverloadCache } from './server/detail-models.js';
import { buildEditQaReport, pickQaFocusPoints, applyAimOverrides } from './server/edit-qa.js';
import { splitCameraBox, splitHalvesOverlap, frameRegionSimilarity, frameRegionPeak } from './server/ffmpeg-expressions.js';
import { applyFocusLayout, keepsLookAlikeSplit } from './server/focus-layout.js';
import { suggestDetailConfig, summarizeQaHistory, summarizeQaByTopic, replayCatalog } from './server/qa-tune.js';
import { resolveTopic, topicClassifierPrompt } from './server/topic-profiles.js';
import { evenSplitPlan, round1, parseOnePiece, piecesFromSeg, scriptLabel, isSpeakerIdentity, resolveSpeakerWho, validSpeakerTrackPoints, shouldUsePerPartDetailPlan, mergeSegmentDetail, compactSceneCutHints, detailSceneCutGuidance, detailSemanticFramingGuidance, parseSpeechLines, speechLinesFromDiarizedTurns, speechLinesForUnresolvedTurns, speechFramingContainReason, balanceDetailWindows, trackFillCuts, generalEditorPrompt, generalGlancePrompt, focusEditorPrompt, focusDetailPrompt, FRAME_MODES, sourceTimeForTrackPoint, normalizeFrameMode, stitchFrames, clamp01, parseFraming, parseSpeakerTrack, snapSpeakerTrack, clampPlan, parseGeminiPlan, framesCoverage } from './server/editor-plan.js';
import { mapDiarizationEvidence, fallbackSpeechForAmbiguousTurns } from './server/local-listen-map.js';
import { runGoogleSttChunkWithRetry } from './server/google-stt-retry.js';
import { firstMeaningfulFfmpegError } from './server/ffmpeg-diagnostics.js';
import { balancedSum, commandLineLength, focusFrameGraph, WINDOWS_COMMAND_BUDGET } from './server/ffmpeg-expressions.js';
import { buildDetailMultimodalRequest, mapWordsToPartTimeline, mapDiarizationToPartTimeline, buildDetailEvidenceTimes } from './server/detail-evidence.js';
import { globalCoverageGuidance, applyGlobalCoveragePolicy } from './server/edit-content-coverage.js';
import { createEditRunReport } from './server/edit-run-report.js';
import { usageFromMetadata, usageCostUsd, usdToVnd, summarizeCost, formatVnd } from './server/gemini-cost.js';
import { chooseLocalTestRange, coalesceLocalFrames, generateLocalDetail, localDetailPlanFromModel, localDetailPrompt, validateLocalFraming } from './server/local-detail.js';
import { activeDailyExhausted, dailyQuotaKey, detailStopReason, GeminiKeysExhaustedError, geminiErrorText, isDailyGeminiRequestQuota, nextGeminiDailyReset, usableDetailKeys, vietnamClockLabel } from './server/gemini-detail-quota.js';
import { fallbackPartsFromLog } from './server/edit-log-replay.js';
import { DHASH_W, DHASH_H, DHASH_BITS, PHASH_BITS, ANALYSIS_SIZE, GRID_COLS, GRID_ROWS, ROWSTEP_W, ROWSTEP_H, dHashFromGray, distanceRatio, meanAbsDifference, pHashFromGray, pHashDistanceRatio, gridDHashRatios, rowStepProfile, samplePairTimes, summarizeDistances } from './server/perceptual-hash.js';
import { analyzeAudioPair, AUDIO_MAX_SECONDS, AUDIO_SAMPLE_RATE } from './server/audio-profile.js';
import { createTrendService, TREND_MAX_VIEWS, TREND_MIN_DURATIONS, TREND_MIN_VIEWS, TREND_PERIODS, TREND_REGIONS, TREND_VIDEO_LIMITS, TREND_VIDEO_REGIONS, regionLabel } from './server/tiktok-trends.js';
import { normalizeHashtag, searchHashtag } from './server/tiktok-hashtag-search.js';
import { createTiktokSession } from './server/tiktok-session.js';
import { createYoutubeImport, uniqueStreamBlock } from './server/youtube-import.js';
import { createChannelStore } from './server/youtube-channel-store.js';
import { createYoutubeChannels } from './server/youtube-channels.js';
import { createReceiptStore, createYoutubeReceipts } from './server/youtube-receipts.js';
import { exportDirForGroup, heldOutputPath, planExportCopy } from './server/export-copy.js';
import { createEditHoldStore } from './server/edit-hold.js';
import { createUniqueHoldStore, uniqueHoldJobId } from './server/unique-hold.js';
import { HARSH_CRF, harshVideoFilter } from './server/harsh-scale.js';
import { chunkTempoBranches, tempoAudioChain, tempoCurve } from './server/tempo-curve.js';
import { alignCaptionWords, buildWordAss, captionAnchor, cleanCaptionClock, ffmpegSubtitlesArg, googleLanguageCode, smoothFilterGraph, smoothFrameProgress, smoothPlan, SMOOTH_CHUNK_FRAMES, youtubeHandoffNote } from './server/unique-extra.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Local UI only: reject cross-origin requests before filesystem APIs.
app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return res.status(403).json({ error: 'Local access only' });
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + host && origin !== 'https://' + host) return res.status(403).json({ error: 'Cross-origin access denied' });
    next();
});
app.use(express.json({ limit: '12mb' }));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const upload = multer({ dest: uploadsDir, limits: { fileSize: UPLOAD_MAX_BYTES } });

function rejectMulter(err, req, res, next) {
    if (req.aborted || /aborted/i.test(String(err?.message || ''))) {
        if (!res.headersSent) res.status(499).json({ error: 'Upload cancelled' });
        return;
    }
    if (err instanceof multer.MulterError) {
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'Video vượt giới hạn 2 GB.'
            : `Upload failed: ${err.message}`;
        res.status(400).json({ error: message, code: err.code });
        return;
    }
    next(err);
}
const youtubeChannelStore = createChannelStore(path.join(uploadsDir, 'youtube-channels.json'));
const youtubeReceiptStore = createReceiptStore(path.join(uploadsDir, 'youtube-receipts.json'));
const youtubeImport = createYoutubeImport({
    uploadsDir,
    jobs,
    subscribeJob,
    runProcess,
    channels: youtubeChannelStore,
    receipts: youtubeReceiptStore,
});
const youtubeChannels = createYoutubeChannels({
    store: youtubeChannelStore,
    runProcess,
    resolveTools: () => youtubeImport.resolveTools(),
    importRoot: path.join(uploadsDir, 'youtube-import'),
});
const youtubeReceipts = createYoutubeReceipts({
    store: youtubeReceiptStore,
    importRoot: path.join(uploadsDir, 'youtube-import'),
});

const saveDirFile = path.join(uploadsDir, 'save-dir.json');
const uniqueHold = createUniqueHoldStore(path.join(uploadsDir, 'unique-hold.json'), { uploadsDir });
const restoredUniqueHolds = uniqueHold.rehydrate(jobs);
if (restoredUniqueHolds) {
    console.log(`[SYS] Unique giữ ${restoredUniqueHolds} video đã xử lý nhưng chưa lưu.`);
}
const editHold = createEditHoldStore(path.join(uploadsDir, 'edit-hold.json'), { uploadsDir });
const restoredEditHolds = editHold.rehydrate(jobs);
if (restoredEditHolds) {
    console.log(`[SYS] Edit giữ ${restoredEditHolds} part đã cắt nhưng chưa lưu.`);
}

function rememberEditHold(part) {
    try { editHold.remember(part); } catch { /* a missed hold must not fail a finished cut */ }
}

function rememberUniqueHold(jobId, job, stats) {
    try {
        uniqueHold.remember({
            jobId,
            name: job?.settings?.outputName || job?.originalName,
            originalName: job?.originalName,
            stats,
        });
    } catch { /* a missed hold must not fail a finished encode */ }
}
const geminiSecretStore = createGeminiSecretStore(
    process.env.GHOSTFORGE_SECRETS_FILE || path.join(uploadsDir, 'gemini-keys.json'),
);
const saveDirStore = createSaveDirStore(saveDirFile);
const readSaveDir = () => saveDirStore.read();
const writeSaveDir = (dir) => saveDirStore.write(dir);
const editPartHistoryFile = path.join(uploadsDir, 'edit-part-test-history.json');
const localDetailRangeFile = path.join(uploadsDir, 'local-detail-test-range.json');

function readLocalDetailRange() {
    try { return JSON.parse(fs.readFileSync(localDetailRangeFile, 'utf8')); } catch { return null; }
}

function writeLocalDetailRange(value) {
    const tempFile = `${localDetailRangeFile}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempFile, localDetailRangeFile);
}

function readEditPartHistory() {
    try {
        const parsed = JSON.parse(fs.readFileSync(editPartHistoryFile, 'utf8'));
        return parsed && Array.isArray(parsed.parts) ? parsed : null;
    } catch {
        return null;
    }
}

function writeEditPartHistory(manifest) {
    const tempFile = `${editPartHistoryFile}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(tempFile, editPartHistoryFile);
}

// Quality history: one entry per rendered part, kept across runs so the app can
// show whether a change actually helped (and which model/mode tends to score
// better on this operator's footage). Bounded so the file cannot grow forever.
const editQaHistoryFile = path.join(uploadsDir, 'edit-qa-history.json');

const EDIT_QA_HISTORY_MAX = 500;

function readEditQaHistory() {
    try {
        const parsed = JSON.parse(fs.readFileSync(editQaHistoryFile, 'utf8'));
        return Array.isArray(parsed?.entries) ? parsed : { version: 1, entries: [] };
    } catch {
        return { version: 1, entries: [] };
    }
}

function appendEditQaHistory(entry) {
    try {
        const store = readEditQaHistory();
        store.entries.push(entry);
        if (store.entries.length > EDIT_QA_HISTORY_MAX) {
            store.entries = store.entries.slice(-EDIT_QA_HISTORY_MAX);
        }
        const tempFile = `${editQaHistoryFile}.tmp`;
        fs.writeFileSync(tempFile, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
        fs.renameSync(tempFile, editQaHistoryFile);
    } catch {
        // A read-only uploads folder must not fail a render.
    }
}

// Average score per framing style + detail mode over the stored history.
const editQaHistorySummary = (entries) => {
    const groups = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const key = `${entry?.framingStyle || 'focus'}/${entry?.detailModelMode || 'safe'}`;
        const group = groups.get(key) || { key, runs: 0, parts: 0, sum: 0, warned: 0 };
        group.runs += 1;
        group.parts += 1;
        group.sum += Number(entry?.score) || 0;
        if (Array.isArray(entry?.warnings) && entry.warnings.length) group.warned += 1;
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((g) => ({ ...g, avgScore: g.parts ? Math.round((g.sum / g.parts) * 10) / 10 : 0 }))
        .sort((a, b) => b.parts - a.parts);
};

const shortPromptHash = (value) => crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex')
    .slice(0, 8);

const logParsedDetailWindows = (frames, prefix, onLog) => {
    const ordered = [...(Array.isArray(frames) ? frames : [])]
        .sort((a, b) => Number(a?.a) - Number(b?.a));
    ordered.forEach((frame, index) => {
        const clean = (value, max = 160) => String(value || '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, max);
        const who = clean(frame?.who, 80);
        const why = clean(frame?.why || frame?.reason);
        const whoText = who ? ` · who=${who}` : '';
        onLog(`[EDIT] ${prefix} window ${index + 1}/${ordered.length}: ${Number(frame?.a).toFixed(1)}-${Number(frame?.b).toFixed(1)} ${frame?.mode || ''}${whoText} · why=${JSON.stringify(why)}`);
    });
};

let encoderCaps = null;

const ffmpegEnv = { ...process.env, CUDA_VISIBLE_DEVICES: '0' };

const canOpenEncoder = (codec, extra = []) => {
    const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
        '-frames:v', '2',
        '-c:v', codec,
        ...extra,
        '-an', '-f', 'null', '-',
    ];
    const opts = { encoding: 'utf8', timeout: 15000, env: ffmpegEnv, windowsHide: true };
    let r = spawnSync('ffmpeg', args, opts);
    if (r.status !== 0 && process.platform === 'win32') {
        r = spawnSync('ffmpeg', args, { ...opts, shell: true });
    }
    const err = `${r.stderr || ''}${r.error ? r.error.message : ''}`.trim();
    return { ok: r.status === 0, err };
};

const probeEncoderCaps = () => {
    if (encoderCaps) return encoderCaps;
    const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 8000, env: ffmpegEnv });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const listedNvidia = /h264_nvenc/.test(text);
    const listedIntel = /h264_qsv/.test(text);
    let nvidiaErr = '';
    let nvidia = false;
    if (listedNvidia) {
        const tries = [
            canOpenEncoder('h264_nvenc', ['-preset', 'fast']),
            canOpenEncoder('h264_nvenc', ['-preset', 'p4', '-rc', 'constqp', '-qp', '23']),
            canOpenEncoder('h264_nvenc', ['-pix_fmt', 'nv12']),
            canOpenEncoder('h264_nvenc'),
        ];
        nvidia = tries.some((t) => t.ok);
        nvidiaErr = tries.find((t) => !t.ok && t.err)?.err || tries[tries.length - 1].err || '';
        nvidiaErr = nvidiaErr.replace(/\s+/g, ' ').slice(0, 240);
    }
    const intelTry = listedIntel
        ? (canOpenEncoder('h264_qsv', ['-preset', 'veryfast', '-pix_fmt', 'nv12']).ok
            || canOpenEncoder('h264_qsv').ok)
        : false;
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
    encoderCaps = {
        cpu: /libx264/.test(text),
        nvidia,
        intel: intelTry,
        nvidiaListed: listedNvidia,
        intelListed: listedIntel,
        nvidiaError: nvidia ? '' : nvidiaErr,
        ffmpegPath: (which.stdout || '').trim().split(/\r?\n/)[0] || 'ffmpeg',
    };
    return encoderCaps;
};

const resolveEncoder = (requested) => {
    const caps = probeEncoderCaps();
    const want = String(requested || 'auto');
    if (want === 'nvidia') {
        if (caps.nvidia) return 'nvidia';
        if (caps.intel) return 'intel';
        return 'cpu';
    }
    if (want === 'intel') return caps.intel ? 'intel' : 'cpu';
    if (want === 'cpu') return 'cpu';
    if (caps.nvidia) return 'nvidia';
    if (caps.intel) return 'intel';
    return 'cpu';
};

const cpuVideoArgs = (gop) => {
    const crf = String(Math.floor(Math.random() * 6) + 20);
    const qcomp = (0.45 + Math.random() * 0.25).toFixed(2);
    const ipratio = (1.20 + Math.random() * 0.30).toFixed(2);
    const aqStrength = (0.60 + Math.random() * 0.55).toFixed(2);
    const keyintMin = Math.floor(gop / 2);
    const scThreshold = Math.floor(Math.random() * 20) + 30;
    const bframes = Math.floor(Math.random() * 3) + 2;
    const aqMode = Math.floor(Math.random() * 3);
    const psyRd = (Math.random() * 1.0 + 0.5).toFixed(2);
    const deblock = `${Math.floor(Math.random() * 3) - 1}:${Math.floor(Math.random() * 3) - 1}`;
    return {
        label: `CPU libx264 veryfast crf ${crf} (all threads)`,
        args: [
            '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-crf', crf,
            '-pix_fmt', 'yuv420p', '-threads', '0', '-g', String(gop),
            '-keyint_min', String(keyintMin), '-sc_threshold', String(scThreshold),
            '-aq-mode', String(aqMode), '-psy-rd', psyRd, '-deblock', deblock,
            '-bf', String(bframes),
            '-x264-params', `qcomp=${qcomp}:ipratio=${ipratio}:aq-strength=${aqStrength}`,
        ],
    };
};

const encoderAttempts = (wanted) => {
    const gop = Math.floor(Math.random() * 30) + 30;
    const nvenc = [
        { nvenc: true, label: 'NVIDIA NVENC p6 constqp nv12', args: ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'constqp', '-qp', '23', '-pix_fmt', 'nv12', '-g', String(gop)] },
        { nvenc: true, label: 'NVIDIA NVENC p4 constqp nv12', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'constqp', '-qp', '23', '-pix_fmt', 'nv12', '-g', String(gop)] },
        { nvenc: true, label: 'NVIDIA NVENC fast nv12', args: ['-c:v', 'h264_nvenc', '-preset', 'fast', '-pix_fmt', 'nv12', '-g', String(gop)] },
        { nvenc: true, label: 'NVIDIA NVENC bare nv12', args: ['-c:v', 'h264_nvenc', '-pix_fmt', 'nv12', '-g', String(gop)] },
    ];
    const intel = {
        label: 'Intel QSV',
        args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-profile:v', 'high', '-pix_fmt', 'nv12', '-g', String(gop)],
    };
    const cpu = cpuVideoArgs(gop);
    const caps = probeEncoderCaps();
    const nv = caps.nvidia ? nvenc : [];
    if (wanted === 'cpu') return [cpu];
    if (wanted === 'intel') return caps.intel ? [intel, cpu] : [cpu];
    if (wanted === 'nvidia') return nv.length ? [...nv, cpu] : (caps.intel ? [intel, cpu] : [cpu]);
    return [...nv, ...(caps.intel ? [intel] : []), cpu];
};

const calculateSHA256 = (filePath) => {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
};

const probeMedia = (filePath) => {
    return new Promise((resolve) => {
        const probe = spawn('ffmpeg', ['-hide_banner', '-i', filePath]);
        let err = '';
        probe.stderr.on('data', (d) => { err += d.toString(); });
        const finish = () => {
            const hasAudio = /^\s*Stream #.*Audio:/mi.test(err) || /Audio:\s/i.test(err);
            const fpsMatch = err.match(/(\d+(?:\.\d+)?)\s*fps/i);
            let fps = fpsMatch ? parseFloat(fpsMatch[1]) : 30;
            if (!Number.isFinite(fps) || fps < 1 || fps > 120) fps = 30;
            const durMatch = err.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
            let durationSec = 0;
            if (durMatch) {
                durationSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
            }
            const vMatch = err.match(/Stream #.*Video:\s*([a-z0-9]+)/i);
            const codec = vMatch ? vMatch[1].toLowerCase() : 'unknown';
            const resMatch = err.match(/Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/);
            const width = resMatch ? parseInt(resMatch[1], 10) : 0;
            const height = resMatch ? parseInt(resMatch[2], 10) : 0;
            const aMatch = err.match(/Stream #.*Audio:\s*([a-z0-9]+)/i);
            const audioLine = (err.match(/Stream #.*Audio:.*$/mi) || [''])[0];
            let audioChannels = 0;
            if (hasAudio) {
                if (/\bmono\b/i.test(audioLine)) audioChannels = 1;
                else if (/\b(stereo|2\.0)\b/i.test(audioLine)) audioChannels = 2;
                else {
                    const n = audioLine.match(/(\d+)\s*channels/i);
                    audioChannels = n ? parseInt(n[1], 10) : 2;
                }
            }
            resolve({
                hasAudio,
                fps: Math.round(fps * 1000) / 1000,
                durationSec,
                codec,
                width,
                height,
                audioCodec: aMatch ? aMatch[1].toLowerCase() : null,
                audioChannels,
                raw: err,
            });
        };
        probe.on('close', finish);
        probe.on('error', () => resolve({
            hasAudio: false, fps: 30, durationSec: 0, codec: 'unknown', width: 0, height: 0, audioCodec: null, audioChannels: 0, raw: '',
        }));
    });
};

const evenDim = (n) => {
    const v = Math.round(Number(n) || 0);
    return Math.max(2, v - (v % 2));
};

const isTikTokAspect = (w, h) => {
    if (!w || !h) return false;
    return Math.abs(w / h - 9 / 16) < 0.05 && h >= 960;
};





// Per-frame subject tracker: gradient energy centroid inside the content box.
// Crop then follows cx(t), cy(t) so zoom eats empty wall, not the puppets.


const generateRealisticMetadata = (hasAudio) => {
    // A wider device pool matters when a batch is posted from one machine: six profiles
    // meant consecutive videos could share make/model/software, which is an easy cluster
    // signal. Keep each entry plausible (a real model with a software build that shipped).
    const APPLE_HANDLERS = { handlerVideo: 'Core Media Video', handlerAudio: 'Core Media Audio' };
    const ANDROID_HANDLERS = { handlerVideo: 'VideoHandle', handlerAudio: 'SoundHandle' };
    const apple = (model, software) => ({ make: 'Apple', model, software, ...APPLE_HANDLERS });
    const android = (make, model, software) => ({ make, model, software, ...ANDROID_HANDLERS });
    const profiles = [
        apple('iPhone 16 Pro Max', '18.1'), apple('iPhone 16 Pro', '18.0.1'), apple('iPhone 16', '18.0'),
        apple('iPhone 15 Pro Max', '17.4.1'), apple('iPhone 15 Pro', '17.2.1'), apple('iPhone 15', '17.1'),
        apple('iPhone 14 Pro Max', '16.6.1'), apple('iPhone 14 Pro', '16.5'), apple('iPhone 14', '16.3.1'),
        apple('iPhone 13 Pro', '15.7.1'), apple('iPhone 13', '15.1'), apple('iPhone 12', '14.8'),
        apple('iPhone SE (3rd generation)', '15.4'), apple('iPhone 11', '13.7'),
        android('Samsung', 'SM-S928B', 'Android 14'), android('Samsung', 'SM-S921B', 'Android 14'),
        android('Samsung', 'SM-S918B', 'Android 14'), android('Samsung', 'SM-S911B', 'Android 13'),
        android('Samsung', 'SM-G998U', 'Android 12'), android('Samsung', 'SM-A546B', 'Android 13'),
        android('Google', 'Pixel 9 Pro', 'Android 15'), android('Google', 'Pixel 8 Pro', 'Android 14'),
        android('Google', 'Pixel 8', 'Android 14'), android('Google', 'Pixel 7a', 'Android 13'),
        android('Xiaomi', '22101316G', 'Android 13'), android('Xiaomi', '2311DRK48G', 'Android 14'),
        android('OnePlus', 'CPH2581', 'Android 14'), android('OPPO', 'CPH2525', 'Android 13'),
        android('vivo', 'V2312', 'Android 14'), android('Huawei', 'ELS-NX9', 'Android 12'),
    ];
    const profile = profiles[Math.floor(Math.random() * profiles.length)];

    const now = new Date();
    const past = new Date(now.getTime() - Math.random() * 15768000000);
    const creationTime = past.toISOString().replace(/\.\d{3}Z$/, '.000000Z');

    // Base coordinates plus a small jitter, so two videos captured "in the same city" do
    // not carry a byte-identical GPS string. ISO6709 with 4 decimals, sign prefix included.
    const locations = [
        [34.0522, -118.2437], [40.7128, -74.0060], [41.8781, -87.6298], [29.7604, -95.3698],
        [37.7749, -122.4194], [47.6062, -122.3321], [43.6532, -79.3832], [19.4326, -99.1332],
        [51.5074, -0.1278], [48.8566, 2.3522], [52.5200, 13.4050], [41.9028, 12.4964],
        [40.4168, -3.7038], [52.3676, 4.9041], [35.6762, 139.6503], [37.5665, 126.9780],
        [1.3521, 103.8198], [13.7563, 100.5018], [28.6139, 77.2090], [-6.2088, 106.8456],
        [-33.8688, 151.2093], [-36.8485, 174.7633], [-23.5505, -46.6333], [19.0760, 72.8777],
    ];
    const [baseLat, baseLon] = locations[Math.floor(Math.random() * locations.length)];
    const jitter = () => (Math.random() - 0.5) * 0.09; // ~ +/- 5 km
    // iOS writes latitude as sign + 7 chars and longitude as sign + 8 chars, zero-padding
    // the digits either way: +51.5074-000.1278/ , -06.2088+106.8456/ .
    const fmtCoord = (value, width) => `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(4).padStart(width, '0')}`;
    const location = `${fmtCoord(baseLat + jitter(), 7)}${fmtCoord(baseLon + jitter(), 8)}/`;

    const stamp = past.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const title = profile.make === 'Apple'
        ? `IMG_${String(Math.floor(Math.random() * 9000) + 1000)}`
        : `VID_${stamp}`;

    // Values MUST NOT be extra-quoted. spawn() already passes each arg intact;
    // extra quotes were why make/model/location were dropped from the MP4.
    const args = [
        '-metadata', `creation_time=${creationTime}`,
        '-metadata', `make=${profile.make}`,
        '-metadata', `model=${profile.model}`,
        '-metadata', `software=${profile.software}`,
        '-metadata', `comment=Captured on ${profile.make} ${profile.model}`,
        '-metadata', `title=${title}`,
        '-metadata', `date=${creationTime.slice(0, 10)}`,
        '-metadata', `location=${location}`,
        '-metadata', `location-eng=${location}`,
        '-metadata:s:v:0', `handler_name=${profile.handlerVideo}`,
    ];
    if (hasAudio) {
        args.push('-metadata:s:a:0', `handler_name=${profile.handlerAudio}`);
    }

    if (profile.make === 'Apple') {
        args.push('-metadata', `com.apple.quicktime.make=${profile.make}`);
        args.push('-metadata', `com.apple.quicktime.model=${profile.model}`);
        args.push('-metadata', `com.apple.quicktime.software=${profile.software}`);
        args.push('-metadata', `com.apple.quicktime.creationdate=${creationTime}`);
        args.push('-metadata', `com.apple.quicktime.location.ISO6709=${location}`);
    }

    return {
        args,
        profileName: `${profile.make} ${profile.model}`,
        make: profile.make,
        model: profile.model,
        software: profile.software,
        location,
        title,
        creationTime,
    };
};

function noteUniqueChild(job, child) {
    if (!job || !child) return;
    job.ffmpeg = child;
    const pid = child.pid;
    if (pid && !child.gfSuspendHook) {
        child.gfSuspendHook = true;
        child.once('close', () => releaseSuspendedPid(pid));
    }
    if (job.uniqueRun && job.uniquePaused && pid) {
        setProcessSuspended(pid, true).catch(() => {});
    }
}

function clearAspill(jobId) {
    const id = String(jobId || '');
    if (!/^[a-f0-9]{16,64}$/i.test(id)) return;
    let names = [];
    try { names = fs.readdirSync(uploadsDir); } catch { return; }
    for (const name of names) {
        if (!name.startsWith(`${id}_aspill_`)) continue;
        const sidecar = path.join(uploadsDir, name);
        try {
            if (String(sidecar).startsWith(uploadsDir) && fs.existsSync(sidecar) && fs.statSync(sidecar).isFile()) fs.unlinkSync(sidecar);
        } catch { /* ignore */ }
    }
}

const remuxWithMetadata = (srcPath, destPath, metadataArgs, job = null) => {
    return new Promise((resolve, reject) => {
        const args = [
            '-y', '-i', srcPath,
            '-map', '0',
            '-c', 'copy',
            '-map_metadata', '-1',
            ...metadataArgs,
            '-movflags', 'use_metadata_tags+faststart',
            destPath,
        ];
        const child = spawn('ffmpeg', args);
        // Copy-only remux can still run for a while on a long clip, so it must stay
        // reachable by /api/cancel -> abortJob, which kills job.ffmpeg.
        noteUniqueChild(job, child);
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', (code) => {
            if (job) job.ffmpeg = null;
            if (job?.cancelled) return reject(new Error('cancelled'));
            if (code === 0) resolve();
            else reject(new Error(`Metadata remux failed (code ${code})`));
        });
        child.on('error', (error) => { if (job) job.ffmpeg = null; reject(error); });
    });
};

const readStuckMetadata = (filePath) => {
    return new Promise((resolve) => {
        const probe = spawn('ffmpeg', ['-hide_banner', '-i', filePath]);
        let err = '';
        probe.stderr.on('data', (d) => { err += d.toString(); });
        probe.on('close', () => {
            const grab = (key) => {
                const m = err.match(new RegExp(`${key}\\s*:\\s*(.+)`, 'i'));
                return m ? m[1].trim() : '';
            };
            resolve({
                make: grab('make') || grab('com.apple.quicktime.make'),
                model: grab('model') || grab('com.apple.quicktime.model'),
                location: grab('location') || grab('com.apple.quicktime.location.ISO6709'),
                title: grab('title'),
                creationTime: grab('creation_time'),
            });
        });
        probe.on('error', () => resolve({ make: '', model: '', location: '', title: '', creationTime: '' }));
    });
};

// Cheap perceptual estimate for the Unique output: dHash the same content moment on
// both sides and report the mean bit distance. The Unique encode retimes by `speed`,
// so output time and source time differ. This is an estimate for the operator, not a
// platform dedup verdict and not CLIP similarity; a canvas/pad change inflates it.
//
// Three numbers, because one is not enough:
// - dHash 256-bit (`mean`/`worst`) is the documented historical measure. It saturates
//   near 40% (measured: `strong` 38.3% vs `extreme` 39.5%), so it cannot rank two
//   strong passes - it is kept unchanged so older readings stay comparable.
// - pHash 63-bit DCT is the classic low-frequency signature: it moves for a real
//   layout/grade change and ignores grain (the dHash band above is the opposite).
// - the worst 4x4 block is the local reading: a zoom/reframe moves most cells, a seam
//   or a caption only one side has moves a few, and unlike the global mean it does not
//   saturate.
const measurePerceptualDistance = async (srcPath, outPath, outputDurationSec, speed, frames = 3) => {
    const pairs = samplePairTimes(outputDurationSec, speed, frames);
    if (!pairs.length) return null;
    const ratios = [];
    const lumas = [];
    const pHashes = [];
    const blockMeans = [];
    const blockWorsts = [];
    const sourceHashes = [];
    const outputHashes = [];
    for (const pair of pairs) {
        // Two grabs per side per moment: 17x16 keeps the documented dHash exactly as it
        // was, 64x64 feeds the pHash and the grid. They run in parallel, so the extra
        // pair costs one more process spawn rather than a second serial decode.
        const [srcGray, outGray, srcBig, outBig] = await Promise.all([
            grabGrayFrame(srcPath, pair.sourceT, DHASH_W, DHASH_H),
            grabGrayFrame(outPath, pair.outputT, DHASH_W, DHASH_H),
            grabGrayFrame(srcPath, pair.sourceT, ANALYSIS_SIZE, ANALYSIS_SIZE),
            grabGrayFrame(outPath, pair.outputT, ANALYSIS_SIZE, ANALYSIS_SIZE),
        ]);
        if (srcGray && outGray) {
            const srcHash = dHashFromGray(srcGray, DHASH_W, DHASH_H);
            const outHash = dHashFromGray(outGray, DHASH_W, DHASH_H);
            const ratio = distanceRatio(srcHash, outHash);
            if (ratio !== null) {
                ratios.push(ratio);
                sourceHashes.push(srcHash);
                outputHashes.push(outHash);
            }
            const luma = meanAbsDifference(srcGray, outGray, DHASH_W, DHASH_H);
            if (luma !== null) lumas.push(luma);
        }
        if (srcBig && outBig) {
            const pHash = pHashDistanceRatio(
                pHashFromGray(srcBig, ANALYSIS_SIZE, ANALYSIS_SIZE),
                pHashFromGray(outBig, ANALYSIS_SIZE, ANALYSIS_SIZE),
            );
            if (pHash !== null) pHashes.push(pHash);
            const cells = summarizeDistances(gridDHashRatios(srcBig, outBig, ANALYSIS_SIZE, ANALYSIS_SIZE, GRID_COLS, GRID_ROWS));
            if (cells) {
                blockMeans.push(cells.mean);
                blockWorsts.push(cells.worst);
            }
        }
    }
    const summary = summarizeDistances(ratios);
    return summary
        ? {
            ...summary,
            luma: summarizeDistances(lumas),
            pHash: summarizeDistances(pHashes),
            block: summarizeDistances(blockMeans),
            blockWorst: summarizeDistances(blockWorsts),
            sourceHashes,
            outputHashes,
        }
        : null;
};

// Unique strength scales how far the output is pushed away from the source. `standard`
// is gain 1, i.e. the pre-2026-09-24 ranges. `strong` is the default in the UI because
// the live measurement showed a standard pass stayed close to the source.
const UNIQUE_STRENGTH = {
    light: { zoom: 0.55, stretch: 0.55, shake: 0.6, geo: 0.55, lens: 0.6, tempo: 0.55, color: 0.55, grain: 0.6, audio: 0.6 },
    standard: { zoom: 1, stretch: 1, shake: 1, geo: 1, lens: 1, tempo: 1, color: 1, grain: 1, audio: 1 },
    strong: { zoom: 1.7, stretch: 1.7, shake: 1.6, geo: 1.7, lens: 1.6, tempo: 2, color: 1.8, grain: 1.7, audio: 1.5 },
    extreme: { zoom: 2.3, stretch: 2.1, shake: 2, geo: 2.3, lens: 2.1, tempo: 2.8, color: 2.4, grain: 2.3, audio: 1.9 },
};

// Per-process memory of the last Unique job's tempo/grade signature. Two videos processed
// back to back should not come out looking like the same pass, and the per-job random draw
// alone does not prevent that. Restarting the server resets it (documented, not a bug).
let lastUniqueSignature = null;
// Same idea for the audio side: the EQ-drift depth and periods are drawn per job, so two
// clips processed back to back can come out with the same slow drift rhythm. Per process -
// a restart resets it. Geometry, tempo, EQ bands and the hiss are not part of it.
let lastAudioSignature = null;

// Quality guard for the Unique output. The perceptual hashes average the frame, so
// they can read higher while the picture gets worse - a real regression in this
// project reported dHash 39.7 / pHash 28.0 on a render that had a hard seam across
// the whole frame, versus 40.0 / 27.5 on the clean render of the same clip. This
// pass looks at the frame itself instead: the largest single-row brightness jump
// in the output, beside the same number for the input to THIS job, so a seam the
// source already had is never blamed on the pipeline.
const SEAM_FRAMES = 5;
const measureSeamProfile = async (inputPath, outputPath, outputDurationSec, speed, frames = SEAM_FRAMES) => {
    const pairs = samplePairTimes(outputDurationSec, speed, frames);
    if (!pairs.length) return null;
    const acc = {
        in: { seam: null, rowPct: null, frames: 0 },
        out: { seam: null, rowPct: null, frames: 0 },
    };
    let sampled = 0;
    for (const pair of pairs) {
        const [inGray, outGray] = await Promise.all([
            grabGrayFrame(inputPath, pair.sourceT, ROWSTEP_W, ROWSTEP_H),
            grabGrayFrame(outputPath, pair.outputT, ROWSTEP_W, ROWSTEP_H),
        ]);
        sampled++;
        for (const [side, gray] of [['in', inGray], ['out', outGray]]) {
            if (!gray) continue;
            const profile = rowStepProfile(gray, ROWSTEP_W, ROWSTEP_H);
            if (!profile || !profile.visible) continue;
            const slot = acc[side];
            slot.frames++;
            if (slot.seam === null || Math.abs(profile.spikeStep) > Math.abs(slot.seam)) {
                slot.seam = profile.spikeStep;
                slot.rowPct = profile.spikeRowPct;
            }
        }
    }
    if (!sampled) return null;
    return { ...acc, frames: sampled };
};

// Audio side of the same "what did this pass actually do" question. The picture has
// dHash/pHash/seam; the audio had no number at all (the 2026-09-27 handoff says the level
// envelope was unmeasured). This pipes mono 16 kHz PCM out of both files and lets
// server/audio-profile.js compare them window by window: loudness per second, and the
// energy of three frequency bands per second, aligned back through the retime factor.
//
// It is an operator estimate, not a platform audio-fingerprint verdict: it measures the
// same content moments on both sides, so content changes cancel and what is left is what
// the pass added. A static EQ/level change shows up in the mean, a time-varying one in
// the std (drift). Capped at AUDIO_MAX_SECONDS because every drift period in the render
// is a few seconds.
const AUDIO_ANALYSIS_CAP_BYTES = (AUDIO_MAX_SECONDS + 4) * AUDIO_SAMPLE_RATE * 4;
const grabAudioPcm = (inputPath, seconds) => new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-t', String(Math.max(1, seconds)), '-i', inputPath,
        '-vn', '-ac', '1', '-ar', String(AUDIO_SAMPLE_RATE),
        '-f', 'f32le', 'pipe:1',
    ], { env: ffmpegEnv, windowsHide: true });
    const chunks = [];
    let size = 0;
    ff.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > AUDIO_ANALYSIS_CAP_BYTES) return;
        chunks.push(chunk);
    });
    ff.on('close', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < AUDIO_SAMPLE_RATE * 4) return resolve(null);
        const count = Math.floor(buf.length / 4);
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i++) samples[i] = buf.readFloatLE(i * 4);
        resolve(samples);
    });
    ff.on('error', () => resolve(null));
});

const measureAudioProfile = async (srcPath, outPath, outputDurationSec, speed) => {
    const outputSeconds = Math.min(AUDIO_MAX_SECONDS, Math.max(4, Number(outputDurationSec) || AUDIO_MAX_SECONDS));
    // Same content window on the source: output time * speed = source time.
    const sourceSeconds = Math.min(AUDIO_MAX_SECONDS, outputSeconds * (Number.isFinite(speed) && speed > 0 ? speed : 1));
    const [sourceSamples, outputSamples] = await Promise.all([
        grabAudioPcm(srcPath, sourceSeconds),
        grabAudioPcm(outPath, outputSeconds),
    ]);
    if (!sourceSamples || !outputSamples) return null;
    return analyzeAudioPair({ sourceSamples, outputSamples, speed });
};

const audioBandDb = (audio, key) => {
    const band = audio?.bands?.find((entry) => entry.key === key);
    return band && Number.isFinite(band.deltaDb) ? Number(band.deltaDb.toFixed(2)) : null;
};

// Semantic measurement: how far the render moved from the source in CLIP embedding space,
// using the same ViT-B-32 as pgd_clip.py (no AI quota, no API). Before this the panel only
// had dHash/pHash - picture difference - and the CLIP number appeared only when PGD ran.
// Best effort: a missing Python/torch/open_clip, a timeout or a bad line returns null and
// the job continues.
const CLIP_SIM_TIMEOUT_MS = 240000;
const measureClipSimOneShot = (inputPath, outputPath) => new Promise((resolve) => {
    const script = path.join(__dirname, 'clip_sim.py');
    if (!fs.existsSync(script)) return resolve(null);
    const py = spawn(pgdPython(), [
        '-u', script, '--a', inputPath, '--b', outputPath, '--frames', '12', '--ffmpeg', 'ffmpeg',
    ], { env: { ...ffmpegEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, windowsHide: true });
    let out = '';
    let done = false;
    const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
    };
    const timer = setTimeout(() => {
        try { py.kill(); } catch { /* ignore */ }
        finish(null);
    }, CLIP_SIM_TIMEOUT_MS);
    py.stdout.on('data', (d) => { out += d.toString(); });
    py.stderr.on('data', (d) => { out += d.toString(); });
    py.on('error', () => finish(null));
    py.on('close', () => {
        const line = out.split(/\r?\n/).find((entry) => entry.startsWith('CLIPSIM '));
        if (!line) return finish(null);
        try {
            const parsed = JSON.parse(line.slice('CLIPSIM '.length));
            finish(Number.isFinite(parsed?.meanClipSim) ? parsed : null);
        } catch {
            finish(null);
        }
    });
});

// Warm CLIP helper: the one-shot path above pays `python` + torch/open_clip import + model
// load (~4.7 s) on EVERY clip. One long-lived process loads ViT-B-32 once and answers
// requests over stdin/stdout, which drops the measurement stage from ~6 s to ~1.3 s per
// clip. If it cannot start, dies or times out, the caller falls back to the one-shot path
// and the next call tries to start it again - a broken helper never fails a job.
const CLIP_WORKER_READY_TIMEOUT_MS = 90000;
const CLIP_WORKER_REQUEST_TIMEOUT_MS = 120000;
const clipWorker = { child: null, ready: false, waiters: [], buffer: '', pending: new Map() };
let clipWorkerSeq = 0;

const failClipWorker = (reason, expectedChild = null) => {
    const child = clipWorker.child;
    if (expectedChild && child !== expectedChild) return;
    clipWorker.child = null;
    clipWorker.ready = false;
    clipWorker.buffer = '';
    if (child) {
        try { child.kill(); } catch { /* ignore */ }
    }
    for (const [, entry] of clipWorker.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
    }
    clipWorker.pending.clear();
    while (clipWorker.waiters.length) clipWorker.waiters.shift()(false);
};

// Frees the helper's VRAM while PGD runs its own CLIP model: on a 4 GB card two copies at
// once is the difference between working and OOM. The helper is restarted lazily when the
// measurement stage runs again.
const stopClipWorker = (reason) => {
    if (!clipWorker.child) return false;
    failClipWorker(reason || 'worker stopped');
    return true;
};

const ensureClipWorker = () => new Promise((resolve) => {
    const script = path.join(__dirname, 'clip_sim_server.py');
    if (!fs.existsSync(script)) return resolve(false);
    if (clipWorker.child && clipWorker.ready) return resolve(true);
    clipWorker.waiters.push(resolve);
    if (clipWorker.child) return; // already starting
    let child;
    try {
        child = spawn(pgdPython(), ['-u', script], {
            env: { ...ffmpegEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        clipWorker.waiters.shift()(false);
        return;
    }
    clipWorker.child = child;
    clipWorker.ready = false;
    clipWorker.buffer = '';
    const readyTimer = setTimeout(() => failClipWorker('clip worker ready timeout', child), CLIP_WORKER_READY_TIMEOUT_MS);
    const settleReady = (value) => {
        clearTimeout(readyTimer);
        while (clipWorker.waiters.length) clipWorker.waiters.shift()(value);
    };
    child.stdout.on('data', (data) => {
        clipWorker.buffer += data.toString();
        let index;
        while ((index = clipWorker.buffer.indexOf('\n')) >= 0) {
            const line = clipWorker.buffer.slice(0, index).trim();
            clipWorker.buffer = clipWorker.buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                continue;
            }
            if (message.ready) {
                clipWorker.ready = true;
                settleReady(true);
                continue;
            }
            const entry = message.id === undefined ? null : clipWorker.pending.get(message.id);
            if (!entry) continue;
            clearTimeout(entry.timer);
            clipWorker.pending.delete(message.id);
            if (message.ok) entry.resolve(message);
            else entry.reject(new Error(message.error || 'clip worker error'));
        }
    });
    child.stderr.on('data', () => { /* surfaced through failures/fallback, not per line */ });
    child.on('error', () => {
        settleReady(false);
        failClipWorker('clip worker failed to start', child);
    });
    child.on('close', () => failClipWorker('clip worker exited', child));
});

const measureClipSimWarm = async (inputPath, outputPath, frames = 12) => {
    const ready = await ensureClipWorker();
    if (!ready) return null;
    const child = clipWorker.child;
    if (!child || !child.stdin || !child.stdin.writable) return null;
    const id = `r${++clipWorkerSeq}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            clipWorker.pending.delete(id);
            failClipWorker('clip worker request timeout');
            reject(new Error('clip worker request timeout'));
        }, CLIP_WORKER_REQUEST_TIMEOUT_MS);
        clipWorker.pending.set(id, { resolve, reject, timer });
        try {
            child.stdin.write(`${JSON.stringify({ id, a: inputPath, b: outputPath, frames })}\n`);
        } catch (err) {
            clearTimeout(timer);
            clipWorker.pending.delete(id);
            reject(err);
        }
    });
};

// One CUDA CLIP user at a time. Two PGD passes on the 4 GB card each load ViT-B-32
// and the pair crawls (a morning run wrote frames for ~90 min and never finished).
// Unique encode does not take this lock. The measurement CLIP call does, so it
// cannot reload a second model while a PGD pass is on the GPU. The attack itself
// is unchanged.
let gpuExclusive = Promise.resolve();
let gpuDepth = 0;
const withGpuExclusive = (job, fn) => {
    const behind = gpuDepth > 0;
    gpuDepth += 1;
    let release = () => {};
    const done = new Promise((resolve) => { release = resolve; });
    const wait = gpuExclusive;
    gpuExclusive = done;
    return wait.then(async () => {
        try {
            if (job && job.cancelled) throw new Error('cancelled');
            return await fn(behind);
        } finally {
            gpuDepth -= 1;
            release();
        }
    });
};

// Warm first, one-shot as the safety net. A resident PGD process already holds
// ViT-B-32; asking it avoids loading a second copy on the 4 GB card.
const measureClipSim = (inputPath, outputPath) => withGpuExclusive(null, async () => {
    try {
        const viaPgd = await measureClipSimViaPgd(inputPath, outputPath);
        if (viaPgd) return viaPgd;
    } catch {
        /* the measurement helper and the one-shot path are still there */
    }
    try {
        const warm = await measureClipSimWarm(inputPath, outputPath, 12);
        if (warm) return warm;
    } catch {
        /* fall through to the one-shot path */
    }
    return measureClipSimOneShot(inputPath, outputPath);
});

// Windows does not kill grandchildren automatically; release the worker with the server.
process.on('exit', () => {
    try { clipWorker.child?.kill(); } catch { /* ignore */ }
    try { pgdWorker.child?.kill(); } catch { /* ignore */ }
});

// Control request to the warm helper (vram / unload). Same pending map as a measure call.
const clipWorkerCommand = (cmd, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const child = clipWorker.child;
    if (!child || !child.stdin || !child.stdin.writable) return reject(new Error('no clip worker'));
    const id = `c${++clipWorkerSeq}`;
    const timer = setTimeout(() => {
        clipWorker.pending.delete(id);
        reject(new Error(`clip worker ${cmd} timeout`));
    }, timeoutMs);
    clipWorker.pending.set(id, { resolve, reject, timer });
    try {
        child.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
    } catch (err) {
        clearTimeout(timer);
        clipWorker.pending.delete(id);
        reject(err);
    }
});

// What to do with the warm helper before PGD loads its own CLIP: keeping it resident saves
// the ~4.5 s restart at the measurement stage (measured 6.3 s -> 2.2 s on an 8 s clip), and
// on this 4 GB card both copies fit. Ask the helper how much VRAM is free first and unload
// its weights when the headroom is thin, so a smaller GPU degrades to "reload later"
// instead of failing PGD.
const CLIP_PGD_VRAM_HEADROOM_MB = 2000;
const prepareClipWorkerForPgd = async (sendEvent) => {
    if (!clipWorker.child) return;
    try {
        const info = await clipWorkerCommand('vram');
        const freeMb = Number.isFinite(info?.freeBytes) ? Math.round(info.freeBytes / 1048576) : null;
        const totalMb = Number.isFinite(info?.totalBytes) ? Math.round(info.totalBytes / 1048576) : null;
        if (freeMb !== null && freeMb < CLIP_PGD_VRAM_HEADROOM_MB) {
            await clipWorkerCommand('unload');
            sendEvent('log', { message: `[SYS] CLIP helper nhả model cho PGD (chỉ còn ${freeMb}/${totalMb ?? '?'} MB VRAM trống) - sẽ nạp lại khi đo.` });
        } else {
            sendEvent('log', { message: `[SYS] CLIP helper giữ nguyên trong lúc PGD (còn ${freeMb ?? '?'}/${totalMb ?? '?'} MB VRAM trống).` });
        }
    } catch {
        stopClipWorker('freed before PGD');
    }
};

// The three post-render measurements (picture hashes, seam check, audio), shared by the
// normal Unique path and the PGD-only path so both report the same numbers. The PGD-only
// path used to skip all three - its result panel came out with no numbers at all.
// Each measurement is best-effort: a failure logs and leaves its fields null instead of
// failing the job. `speed` maps output time back to source time (1 when nothing retimes).
// Quiet second encode of the file the operator will actually upload somewhere
// that recompresses. Same content clock as the render (the proxy is a re-encode
// of the output, so `speed` still maps its timeline back to the source). The
// proxy is deleted before this returns. A failure leaves the harsh fields null
// and the job still succeeds.
const measureHarshProxy = async ({ inputPath, outputPath, outputDurationSec, speed, sendEvent, job }) => {
    const harshPath = /_output\.mp4$/i.test(outputPath)
        ? outputPath.replace(/_output\.mp4$/i, '_harsh.mp4')
        : `${outputPath}.harsh.mp4`;
    try {
        await runFf([
            '-y', '-i', outputPath,
            '-vf', harshVideoFilter(),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', HARSH_CRF,
            '-an',
            harshPath,
        ], job);
        const [perceptual, clipSim] = await Promise.all([
            measurePerceptualDistance(inputPath, harshPath, outputDurationSec, speed, 3).catch(() => null),
            measureClipSim(inputPath, harshPath).catch(() => null),
        ]);
        const distance = perceptual ? Number(perceptual.mean.toFixed(4)) : null;
        const pHash = perceptual?.pHash ? Number(perceptual.pHash.mean.toFixed(4)) : null;
        const clip = clipSim && Number.isFinite(clipSim.meanClipSim) ? Number(clipSim.meanClipSim.toFixed(4)) : null;
        const clipWorst = clipSim && Number.isFinite(clipSim.min) ? Number(clipSim.min.toFixed(4)) : null;
        sendEvent('log', { message: `[SYS] Sau nén (crf ${HARSH_CRF}, cạnh dài ≤720): dHash ${distance === null ? 'bỏ qua' : `${(distance * 100).toFixed(1)}%`} · pHash ${pHash === null ? 'bỏ qua' : `${(pHash * 100).toFixed(1)}%`} · CLIP ${clip === null ? 'bỏ qua' : clip.toFixed(4)}` });
        return {
            distance,
            pHash,
            clipSim: clip,
            clipWorst,
            frames: perceptual ? perceptual.frames : 0,
        };
    } catch (err) {
        if (job?.cancelled) throw err;
        sendEvent('log', { message: `[SYS] Sau nén: bỏ qua (${err instanceof Error ? err.message : String(err)})`.slice(0, 220) });
        return null;
    } finally {
        try { if (fs.existsSync(harshPath)) fs.unlinkSync(harshPath); } catch { /* ignore */ }
    }
};

const measureUniqueOutput = async ({ inputPath, outputPath, outputDurationSec, speed, sendEvent, job }) => {
    // The CLIP embedding pass needs the GPU, so it queues behind another video's PGD, and the
    // harsh proxy re-encodes the whole clip. Both exist only to add two numbers to the result
    // panel, and a finished job could sit minutes waiting for them. They now run only when the
    // operator asks for the full readout; the cheap rows (dHash/pHash, the seam quality guard,
    // audio, stage timings) always run and cost a few seconds.
    const fullMeasure = job?.settings?.enableFullMeasure === 'true';
    // The four measurements are independent (they only READ the two files), so they run at
    // the same time. Sequentially they cost ~8 s per clip - nearly as much as the encode -
    // and the CLIP embedding pass dominates, so overlapping the ffmpeg grabs with it is what
    // saves time. Log lines therefore arrive in completion order, not in the order below.
    const perceptualTask = (async () => {
        let perceptual = null;
        try {
            perceptual = await measurePerceptualDistance(inputPath, outputPath, outputDurationSec, speed, 3);
            let perceptualLog = perceptual
                ? `[SYS] Perceptual dHash ${DHASH_BITS}-bit: ${perceptual.frames} matched frame(s) - mean bit distance ${(perceptual.mean * 100).toFixed(1)}% - worst ${(perceptual.worst * 100).toFixed(1)}% - mean luma delta ${(perceptual.luma ? perceptual.luma.mean * 100 : 0).toFixed(1)}%`
                : '[SYS] Perceptual dHash: no frame pair could be sampled';
            if (perceptual?.pHash) {
                perceptualLog += ` - pHash ${PHASH_BITS}-bit ${(perceptual.pHash.mean * 100).toFixed(1)}% (worst ${(perceptual.pHash.worst * 100).toFixed(1)}%)`;
            }
            if (perceptual?.blockWorst) {
                perceptualLog += ` - worst ${GRID_COLS}x${GRID_ROWS} block ${(perceptual.blockWorst.worst * 100).toFixed(1)}% (mean block ${(perceptual.block ? perceptual.block.mean * 100 : 0).toFixed(1)}%)`;
            }
            sendEvent('log', { message: perceptualLog });
        } catch (perceptualErr) {
            sendEvent('log', { message: `[SYS] Perceptual dHash skipped: ${perceptualErr instanceof Error ? perceptualErr.message : String(perceptualErr)}`.slice(0, 220) });
        }
        return perceptual;
    })();

    // Quality guard, separate from the hashes for the reason above: a higher similarity
    // score is not evidence that the picture is usable.
    const seamTask = (async () => {
        let seam = null;
        try {
            seam = await measureSeamProfile(inputPath, outputPath, outputDurationSec, speed, SEAM_FRAMES);
            if (seam) {
                const describe = (side) => (side.seam === null
                    ? 'no seam'
                    : `seam ${side.seam} luma/row at y=${side.rowPct}% (${side.frames}/${seam.frames} frames)`);
                const added = seam.out.seam !== null && seam.in.seam === null;
                sendEvent('log', { message: added
                    ? `[SYS] QUALITY WARNING: the render has a hard horizontal seam the input did not - output ${describe(seam.out)}, input ${describe(seam.in)}. Check the render before using it.`
                    : `[SYS] Edge check: output ${describe(seam.out)} · input ${describe(seam.in)}${seam.out.seam !== null && seam.in.seam !== null ? ' - seam was already in the source' : ''}` });
            } else {
                sendEvent('log', { message: '[SYS] Edge check: no frame pair could be sampled' });
            }
        } catch (seamErr) {
            sendEvent('log', { message: `[SYS] Edge check skipped: ${seamErr instanceof Error ? seamErr.message : String(seamErr)}`.slice(0, 220) });
        }
        return seam;
    })();

    // Audio measurement: the picture rows answer "what changed in the frame"; this answers
    // the same for the sound, which had no number at all before.
    const audioTask = (async () => {
        let audio = null;
        try {
            audio = await measureAudioProfile(inputPath, outputPath, outputDurationSec, speed);
            if (audio) {
                const num1 = (value) => (Number.isFinite(value) ? value.toFixed(1) : '?');
                const signed = (value) => (Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}` : '?');
                const bandText = audio.bands
                    .map((band) => `${band.label.split(' ')[0]} ${signed(band.deltaDb)}/±${num1(band.driftDb)}`)
                    .join(' · ');
                sendEvent('log', { message: `[SYS] Audio đo được (${audio.windows}/${audio.windows}s đầu): vào RMS ${num1(audio.level.sourceDb)} dB → ra ${num1(audio.level.outputDb)} dB (${signed(audio.level.deltaDb)} dB) · mức trôi ±${num1(audio.level.driftDb)} dB/giây · phổ dB (lệch/trôi): ${bandText} · đỉnh nhảy ×${audio.click.ratio === null ? '?' : audio.click.ratio.toFixed(2)}` });
                if (Number.isFinite(audio.click.ratio) && audio.click.ratio > 1.8) {
                    sendEvent('log', { message: `[SYS] CẢNH BÁO âm thanh: có mẫu nhảy gấp ${audio.click.ratio.toFixed(2)}× file gốc - nghe lại đoạn đó trước khi dùng.` });
                }
            } else {
                sendEvent('log', { message: '[SYS] Audio đo được: file vào không có tiếng, hoặc quá ngắn để đo.' });
            }
        } catch (audioErr) {
            sendEvent('log', { message: `[SYS] Audio đo được: bỏ qua (${audioErr instanceof Error ? audioErr.message : String(audioErr)})`.slice(0, 220) });
        }
        return audio;
    })();

    // Semantic row, so a run without PGD still says how far the CONTENT moved.
    const clipTask = fullMeasure ? (async () => {
        let clipSimOut = null;
        try {
            clipSimOut = await measureClipSim(inputPath, outputPath);
            sendEvent('log', { message: clipSimOut
                ? `[SYS] CLIP sim nội dung (file ra vs gốc): ${clipSimOut.meanClipSim.toFixed(4)} (${clipSimOut.frames} khung · ${clipSimOut.min.toFixed(4)}-${clipSimOut.max.toFixed(4)} · ${clipSimOut.device}) - càng thấp càng lệch nội dung`
                : '[SYS] CLIP sim nội dung: bỏ qua (không chạy được python + torch + open_clip)' });
        } catch (clipErr) {
            sendEvent('log', { message: `[SYS] CLIP sim nội dung: bỏ qua (${clipErr instanceof Error ? clipErr.message : String(clipErr)})`.slice(0, 220) });
        }
        return clipSimOut;
    })() : Promise.resolve(null);

    const harshTask = fullMeasure ? (async () => {
        try {
            return await measureHarshProxy({ inputPath, outputPath, outputDurationSec, speed, sendEvent, job });
        } catch (err) {
            if (job?.cancelled) throw err;
            sendEvent('log', { message: `[SYS] Sau nén: bỏ qua (${err instanceof Error ? err.message : String(err)})`.slice(0, 220) });
            return null;
        }
    })() : Promise.resolve(null);

    const [perceptual, seam, audio, clipSimOut, harsh] = await Promise.all([perceptualTask, seamTask, audioTask, clipTask, harshTask]);
    return { perceptual, seam, audio, clipSimOut, harsh };
};

// The measurement half of the `done` stats, built from the three results above. One
// definition, so the normal path and the PGD-only path cannot drift apart.
const uniqueMeasurementStats = (perceptual, seam, audio, clipSimOut, harsh) => ({
    perceptualDistance: perceptual ? Number(perceptual.mean.toFixed(4)) : null,
    perceptualWorst: perceptual ? Number(perceptual.worst.toFixed(4)) : null,
    perceptualBest: perceptual ? Number(perceptual.best.toFixed(4)) : null,
    perceptualFrames: perceptual ? perceptual.frames : 0,
    perceptualLumaDelta: perceptual?.luma ? Number(perceptual.luma.mean.toFixed(4)) : null,
    perceptualLumaWorst: perceptual?.luma ? Number(perceptual.luma.worst.toFixed(4)) : null,
    perceptualPHash: perceptual?.pHash ? Number(perceptual.pHash.mean.toFixed(4)) : null,
    perceptualPHashWorst: perceptual?.pHash ? Number(perceptual.pHash.worst.toFixed(4)) : null,
    perceptualBlockMean: perceptual?.block ? Number(perceptual.block.mean.toFixed(4)) : null,
    perceptualBlockWorst: perceptual?.blockWorst ? Number(perceptual.blockWorst.worst.toFixed(4)) : null,
    seamIn: seam && seam.in.seam !== null ? Number(seam.in.seam.toFixed(1)) : null,
    seamInRowPct: seam && seam.in.rowPct !== null ? Number(seam.in.rowPct.toFixed(1)) : null,
    seamInFrames: seam ? seam.in.frames : 0,
    seamOut: seam && seam.out.seam !== null ? Number(seam.out.seam.toFixed(1)) : null,
    seamOutRowPct: seam && seam.out.rowPct !== null ? Number(seam.out.rowPct.toFixed(1)) : null,
    seamOutFrames: seam ? seam.out.frames : 0,
    seamFrames: seam ? seam.frames : 0,
    audioMeasuredSec: audio ? Number((audio.windows * audio.windowSec).toFixed(1)) : null,
    audioSrcRmsDb: audio && Number.isFinite(audio.level.sourceDb) ? Number(audio.level.sourceDb.toFixed(2)) : null,
    audioOutRmsDb: audio && Number.isFinite(audio.level.outputDb) ? Number(audio.level.outputDb.toFixed(2)) : null,
    audioLevelDeltaDb: audio && Number.isFinite(audio.level.deltaDb) ? Number(audio.level.deltaDb.toFixed(2)) : null,
    audioLevelDriftDb: audio && Number.isFinite(audio.level.driftDb) ? Number(audio.level.driftDb.toFixed(2)) : null,
    audioBandLowDb: audioBandDb(audio, 'low'),
    audioBandMidDb: audioBandDb(audio, 'mid'),
    audioBandHighDb: audioBandDb(audio, 'high'),
    audioBandDriftDb: audio && Number.isFinite(audio.bandDriftDb) ? Number(audio.bandDriftDb.toFixed(2)) : null,
    audioClickRatio: audio && Number.isFinite(audio.click.ratio) ? Number(audio.click.ratio.toFixed(3)) : null,
    clipSimOut: clipSimOut && Number.isFinite(clipSimOut.meanClipSim) ? Number(clipSimOut.meanClipSim.toFixed(4)) : null,
    clipSimOutWorst: clipSimOut && Number.isFinite(clipSimOut.min) ? Number(clipSimOut.min.toFixed(4)) : null,
    clipSimOutFrames: clipSimOut && Number.isFinite(clipSimOut.frames) ? clipSimOut.frames : 0,
    clipSimOutDevice: clipSimOut && clipSimOut.device ? String(clipSimOut.device) : null,
    harshDistance: harsh && Number.isFinite(harsh.distance) ? harsh.distance : null,
    harshPHash: harsh && Number.isFinite(harsh.pHash) ? harsh.pHash : null,
    harshClipSim: harsh && Number.isFinite(harsh.clipSim) ? harsh.clipSim : null,
    harshClipWorst: harsh && Number.isFinite(harsh.clipWorst) ? harsh.clipWorst : null,
    harshFrames: harsh && Number.isFinite(harsh.frames) ? harsh.frames : 0,
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

const pgdPython = () => process.env.GHOSTFORGE_PYTHON || (fs.existsSync(path.join(__dirname, '.venv', 'Scripts', 'python.exe')) ? path.join(__dirname, '.venv', 'Scripts', 'python.exe') : 'python');
const diarPython = () => process.env.GHOSTFORGE_DIAR_PYTHON || path.join(__dirname, '.venv-diar', 'Scripts', 'python.exe');
let pgdStatusCache = null;
app.get('/api/pgd-status', async (req, res) => {
    // This spawns Python and imports torch + open_clip (~3 s), and the UI asks for it when the
    // PGD switch is turned on. Cache an answer for a minute so repeated toggles cost nothing;
    // `?fresh=1` forces a re-check (for example right after installing the environment).
    if (req.query.fresh === '1') pgdStatusCache = null;
    if (pgdStatusCache && Date.now() - pgdStatusCache.at < 60000) return res.json(pgdStatusCache.value);
    const r = await runProcess(pgdPython(), ['-c', 'import numpy, torch, open_clip; print("CUDA_READY" if torch.cuda.is_available() else "CUDA_MISSING")'], { windowsHide: true, timeout: 30000 });
    const ready = r.status === 0 && r.stdout.includes('CUDA_READY');
    const value = { ready, message: ready ? 'PGD ready' : 'PGD cần Python, numpy, torch, open_clip_torch và CUDA. Xem README-FIXED.md để thiết lập.' };
    pgdStatusCache = { at: Date.now(), value };
    res.json(value);
});

app.get('/api/encoders', (req, res) => {
    if (req.query.fresh === '1') encoderCaps = null;
    res.json(probeEncoderCaps());
});

// TikTok trend finder (Creative Center, free/no-login source). Read-only and
// cached; it never touches a job, FFmpeg, or the local filesystem.
const trendSession = createTiktokSession({ root: __dirname });
const trendService = createTrendService({
    getCookieHeader: () => trendSession.getCookieHeader(),
    durationCachePath: path.join(__dirname, 'cache', 'trend-durations.json'),
});
app.get('/api/trends/config', (_req, res) => {
    res.json({
        periods: TREND_PERIODS,
        minViews: TREND_MIN_VIEWS,
        maxViews: TREND_MAX_VIEWS,
        minDurations: TREND_MIN_DURATIONS,
        videoLimits: TREND_VIDEO_LIMITS,
        sessionProfile: trendSession.available(),
        regions: TREND_REGIONS.map((code) => ({
            code,
            label: regionLabel(code),
            video: TREND_VIDEO_REGIONS.includes(code),
        })),
    });
});
app.get('/api/trends', async (req, res) => {
    try {
        const result = await trendService.get({
            region: req.query.region,
            period: req.query.period,
            minViews: req.query.minViews,
            maxViews: req.query.maxViews,
            minDurationSec: req.query.minDuration,
            limit: req.query.limit,
        });
        res.json(result);
    } catch (err) {
        res.status(502).json({ error: `Không lấy được dữ liệu xu hướng: ${err.message}` });
    }
});
app.get('/api/videos/hashtag', async (req, res) => {
    const hashtag = normalizeHashtag(req.query.tag);
    if (!hashtag) return res.status(400).json({ error: 'Nhập một hashtag hợp lệ (tối đa 80 ký tự).' });
    try {
        res.json({ hashtag, videos: await searchHashtag(hashtag) });
    } catch (err) {
        res.status(502).json({ error: `Không tìm được video hashtag: ${err.message}` });
    }
});

app.post('/api/upload', (req, res, next) => {
    upload.single('video')(req, res, (err) => {
        if (err) return rejectMulter(err, req, res, next);
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const jobId = req.file.filename;
        jobs.set(jobId, {
            uniqueRun: true,
            inputPath: req.file.path,
            originalName: req.file.originalname,
            originalSize: req.file.size,
            settings: req.body,
            status: 'pending'
        });
        res.json({ jobId });
    });
});

app.get('/api/stream/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    const block = uniqueStreamBlock(job);
    if (block) {
        if (block.status === 404) return res.status(404).end();
        return res.status(block.status).json({ error: block.error });
    }
    // A render restored after a restart must not encode again when something
    // opens its old stream. The finished flag makes subscribeJob replay and end.
    if (job.held) {
        job.status = 'done';
        if (!job.streamState) job.streamState = { clients: new Set(), history: [], finished: true };
        else job.streamState.finished = true;
    }

    const sendEvent = subscribeJob(job, res);
    if (!sendEvent) return;
    job.uniqueRun = true;
    let smoothPath = '';

    try {
        const startTime = Date.now();
        // Stage boundaries for the timing breakdown the operator asked for: one total
        // number (processingTimeMs) could not tell where a 153 s job went. `tProbe` closes
        // the prep stage (hash + probe), the rest are set as each stage finishes.
        let tProbe = startTime;
        let tSmooth = startTime;
        let tEncode = startTime;
        let tPgd = startTime;
        let tCaption = startTime;
        let tMeta = startTime;
        let tMeasure = startTime;
        sendEvent('log', { message: '[SYS] Initiating GhostForge Semantic Pipeline on Native Backend...' });
        const presetName = String(job.settings.presetName || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
        sendEvent('log', { message: presetName
            ? `[SYS] Preset “${presetName}”.`
            : '[SYS] Preset: không chọn. Dùng công tắc đang mở trên bảng Unique.' });
        const handoffNote = youtubeHandoffNote(job.settings);
        if (handoffNote) sendEvent('log', { message: `[SYS] ${handoffNote}` });
        
        const origHash = await calculateSHA256(job.inputPath);
        sendEvent('log', { message: `[SYS] Original SHA-256: ${origHash.substring(0, 16)}...` });

        const outputPath = path.join(uploadsDir, `${jobId}_output.mp4`);
        const encPath = path.join(uploadsDir, `${jobId}_enc.mp4`);
        job.outputPath = outputPath;

        const { platformMode, enableAdversarial, enableAudioAttack, encoderMode, enableTikTokCanvas, enablePgd, pgdLevel, enablePgdOnly, uniqueStrength, featherTop, featherBottom, featherEnabled, uniqueRotate, uniqueWobble } = job.settings;
        const strengthName = UNIQUE_STRENGTH[uniqueStrength] ? uniqueStrength : 'standard';
        const gstr = UNIQUE_STRENGTH[strengthName];
        const pgdOnly = enablePgdOnly === 'true';
        const enableSmooth = job.settings.enableSmooth === 'true';
        const enableCaptions = job.settings.enableCaptions === 'true';
        sendEvent('log', { message: `[SYS] Unique strength: ${strengthName} (zoom x${gstr.zoom} - color x${gstr.color} - tempo x${gstr.tempo} - grain x${gstr.grain})` });
        sendEvent('log', { message: `[SYS] Thứ tự: làm mịn ${enableSmooth ? 'BẬT' : 'tắt'} → Unique ${pgdOnly ? 'bỏ qua' : 'chạy'} → PGD ${enablePgd === 'true' ? 'BẬT' : 'tắt'} → phụ đề ${enableCaptions ? 'BẬT' : 'tắt'}` });
        const isAdv = enableAdversarial === 'true';
        const isAudioAttack = enableAudioAttack === 'true';
        const wantTik = enableTikTokCanvas === 'true';
        const probeInfo = await probeMedia(job.inputPath);
        tProbe = Date.now();
        tSmooth = tProbe;
        const { hasAudio, fps: srcFps } = probeInfo;
        const srcW = probeInfo.width || 0;
        const srcH = probeInfo.height || 0;
        sendEvent('log', { message: hasAudio
            ? `[SYS] Source ${probeInfo.codec} ${srcW}x${srcH} · ${srcFps} fps · audio ${probeInfo.audioCodec} (${probeInfo.audioChannels}ch)`
            : `[SYS] Source ${probeInfo.codec} ${srcW}x${srcH} · ${srcFps} fps · no audio` });
        sendEvent('log', { message: `[SYS] Auto uniqueness: any aspect (${srcW}x${srcH}) · fps locked · A/V tempo locked` });

        // Default: keep source size. Optional Rehash-style canvas: fit inside
        // 1080×1920, black bars on the leftover edges (3:4 → letterbox).
        const srcEvenW = srcW > 1 ? evenDim(srcW) : 0;
        const srcEvenH = srcH > 1 ? evenDim(srcH) : 0;
        const alreadyTarget = srcEvenW === 1080 && srcEvenH === 1920;
        const convertCanvas = wantTik && !alreadyTarget && srcEvenW > 0;
        const outW = wantTik ? 1080 : srcEvenW;
        const outH = wantTik ? 1920 : srcEvenH;
        if (convertCanvas) {
            sendEvent('log', { message: `[SYS] Canvas Rehash-style: ${srcW}x${srcH} → 1080x1920 · scale-fit + BLACK pad (keep all content)` });
        } else if (wantTik && alreadyTarget) {
            sendEvent('log', { message: `[SYS] Canvas already 1080x1920 — unique in place, no pad` });
        } else {
            sendEvent('log', { message: srcEvenW !== srcW || srcEvenH !== srcH
                ? `[SYS] Canvas LOCKED ${srcW}x${srcH} → ${outW}x${outH} (even yuv420 only)`
                : `[SYS] Canvas LOCKED ${outW}x${outH} (same as source, full frame)` });
        }

        let pipelineInput = job.inputPath;
        if (enableSmooth) {
            smoothPath = path.join(uploadsDir, `${jobId}_smooth.mp4`);
            sendEvent('progress', { value: 0, phase: 'smooth' });
            await runUniqueSmooth(job.inputPath, smoothPath, job, sendEvent, jobId);
            pipelineInput = smoothPath;
            tSmooth = Date.now();
            sendEvent('progress', { value: 100, phase: 'smooth' });
        }

        const meta = generateRealisticMetadata(hasAudio);
        sendEvent('log', { message: `[SYS] Device profile queued: ${meta.profileName} · ${meta.title}` });

        if (pgdOnly) {
            sendEvent('log', { message: enableSmooth
                ? '[SYS] PGD-ONLY: skip Unique. PGD runs on the smoothed file.'
                : '[SYS] PGD-ONLY: skip Unique entirely (no Ken Burns, grain, geq, color, audio FX, canvas). File used as-is.' });
            sendEvent('progress', { value: 100, phase: 'unique' });
            sendEvent('progress', { value: 0, phase: 'pgd' });
            try {
                fs.copyFileSync(pipelineInput, encPath);
                const pgdPath = path.join(uploadsDir, `${jobId}_pgd.mp4`);
                const clipJson = path.join(uploadsDir, `${jobId}_clip.json`);
                await runPgdClip(encPath, pgdPath, job, sendEvent, clipJson, pgdLevel || 'medium');
                tPgd = Date.now();
                try { fs.unlinkSync(encPath); } catch { /* ignore */ }
                fs.renameSync(pgdPath, encPath);
                sendEvent('progress', { value: 100, phase: 'pgd' });
                sendEvent('log', { message: '[SYS] PGD CLIP done (Unique skipped)' });

                tCaption = tPgd;
                if (enableCaptions) {
                    await burnUniqueCaptions(encPath, job, sendEvent, jobId);
                    tCaption = Date.now();
                }

                sendEvent('log', { message: `[SYS] Stamping device metadata (${meta.profileName})...` });
                await remuxWithMetadata(encPath, outputPath, meta.args, job);
                tMeta = Date.now();
                try { fs.unlinkSync(encPath); } catch { /* ignore */ }

                let clipSim = null;
                try {
                    if (fs.existsSync(clipJson)) clipSim = Number(JSON.parse(fs.readFileSync(clipJson, 'utf8')).meanClipSim);
                } catch { /* ignore */ }

                // Same three measurements as the normal Unique path, so a PGD-only job
                // reports numbers too instead of an empty result panel. PGD-only does not
                // retime (speed 1) and it has to run before the source file is unlinked.
                const measured = await measureUniqueOutput({
                    inputPath: job.inputPath,
                    outputPath,
                    outputDurationSec: Number(probeInfo.durationSec) || 0,
                    speed: 1,
                    sendEvent,
                    job,
                });
                tMeasure = Date.now();

                try {
                    if (job.inputPath && fs.existsSync(job.inputPath) && fs.existsSync(outputPath)) {
                        sendEvent('log', { message: '[SYS] Building machine-view: layers ON this frame (not vs original zoom)...' });
                        const origJpg = path.join(uploadsDir, `${jobId}_cmp_orig.jpg`);
                        const procJpg = path.join(uploadsDir, `${jobId}_cmp_proc.jpg`);
                        const diffJpg = path.join(uploadsDir, `${jobId}_cmp_diff.jpg`);
                        const stillT = Math.max(0.25, (Number(probeInfo.durationSec) || 2) * 0.42);
                        await runFf(['-y', '-ss', String(stillT), '-i', job.inputPath, '-frames:v', '1', '-q:v', '3', origJpg], job);
                        await runFf(['-y', '-ss', String(stillT), '-i', outputPath, '-frames:v', '1', '-q:v', '3', procJpg], job);
                        await runFf([
                            '-y', '-i', procJpg,
                            '-filter_complex', '[0:v]split[s][b];[b]gblur=sigma=3[bb];[s][bb]blend=all_mode=difference,format=gray,normalize,eq=contrast=1.6:brightness=0.06,format=yuv420p',
                            '-frames:v', '1', '-q:v', '3', diffJpg,
                        ], job);
                        job.compare = { orig: origJpg, proc: procJpg, diff: diffJpg };
                    }
                } catch (cmpErr) {
                    sendEvent('log', { message: `[SYS] Compare frames skipped: ${cmpErr instanceof Error ? cmpErr.message : String(cmpErr)}`.slice(0, 220) });
                }
                try { if (job.inputPath && fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath); } catch { /* ignore */ }

                const newHash = await calculateSHA256(outputPath);
                const newStats = fs.statSync(outputPath);
                const outProbe = await probeMedia(outputPath);
                const stuck = await readStuckMetadata(outputPath);
                sendEvent('log', { message: '[SYS] SUCCESS: PGD-only pipeline complete (Unique was skipped).' });
                sendEvent('log', { message: `[SYS] Thời gian: chuẩn bị ${((tProbe - startTime) / 1000).toFixed(1)}s · làm mịn ${((tSmooth - tProbe) / 1000).toFixed(1)}s · PGD ${((tPgd - tSmooth) / 1000).toFixed(1)}s · phụ đề ${((tCaption - tPgd) / 1000).toFixed(1)}s · metadata ${((tMeta - tCaption) / 1000).toFixed(1)}s · đo đạc ${((tMeasure - tMeta) / 1000).toFixed(1)}s · tổng ${((tMeasure - startTime) / 1000).toFixed(1)}s` });
                const pgdDoneStats = {
                        originalHash: origHash,
                        newHash,
                        platform: platformMode,
                        processingTimeMs: Date.now() - startTime,
                        originalSize: job.originalSize,
                        newSize: newStats.size,
                        originalCodec: probeInfo.codec,
                        newCodec: outProbe.codec,
                        originalWidth: probeInfo.width,
                        originalHeight: probeInfo.height,
                        newWidth: outProbe.width,
                        newHeight: outProbe.height,
                        originalFps: probeInfo.fps,
                        newFps: outProbe.fps,
                        originalDuration: probeInfo.durationSec,
                        newDuration: outProbe.durationSec,
                        temporalMode: 'PGD-only (Unique skipped)',
                        fpsJitter: `${srcFps} held`,
                        geometricMode: 'none',
                        colorMode: 'none',
                        adversarialMode: 'PGD-only',
                        metadataProfile: meta.profileName,
                        metadataMake: stuck.make || meta.make,
                        metadataModel: stuck.model || meta.model,
                        metadataLocation: stuck.location || meta.location,
                        metadataTitle: stuck.title || meta.title,
                        metadataConfirmed: Boolean(stuck.make && stuck.model),
                        clipSim: Number.isFinite(clipSim) ? clipSim : null,
                        pgdOn: true,
                        pgdLevel: String(pgdLevel || 'medium'),
                        smoothOn: enableSmooth,
                        captionsOn: enableCaptions,
                        handoffNote: handoffNote || undefined,
                        stagePrepMs: tProbe - startTime,
                        stageSmoothMs: Math.max(0, tSmooth - tProbe),
                        stageEncodeMs: 0,
                        stagePgdMs: Math.max(0, tPgd - tSmooth),
                        stageCaptionMs: Math.max(0, tCaption - tPgd),
                        stageMetadataMs: Math.max(0, tMeta - tCaption),
                        stageMeasureMs: Math.max(0, tMeasure - tMeta),
                        ...uniqueMeasurementStats(measured.perceptual, measured.seam, measured.audio, measured.clipSimOut, measured.harsh),
                        compareJobId: job.compare ? jobId : null,
                };
                rememberUniqueHold(jobId, job, pgdDoneStats);
                sendEvent('done', { stats: pgdDoneStats });
            } catch (pgdOnlyErr) {
                sendEvent('error', { message: pgdOnlyErr instanceof Error ? pgdOnlyErr.message : String(pgdOnlyErr) });
            }
            res.end();
            return;
        }

        const args = ['-y', '-fflags', '+genpts', '-threads', '0', '-filter_threads', '0', '-i', pipelineInput, '-map_metadata', '-1'];

        const rnd = (a, b) => a + Math.random() * (b - a);
        // pHash / Hamming is a grayscale DCT of a tiny thumbnail.
        // Hue, sat and grain barely move it. Geometry does: zoom, pan-crop, stretch.
        // Rotate interpolates burned-in captions into streaks — do not use it.
        const geo = isAdv ? 1 : 0;
        const zLoBase = convertCanvas
            ? rnd(1.028 + geo * 0.004, 1.048 + geo * 0.008)
            : rnd(1.038 + geo * 0.006, 1.068 + geo * 0.010);
        const zLo = Number((1 + (zLoBase - 1) * gstr.zoom).toFixed(4));
        const zHi = Number((zLo + rnd(0.016, 0.032) * gstr.zoom).toFixed(4));
        const zoomIn = Math.random() < 0.55;
        const z0 = zoomIn ? zLo : zHi;
        const z1 = zoomIn ? zHi : zLo;
        const stretchX = Number((1 + (rnd(1.012, 1.028) - 1) * gstr.stretch).toFixed(4));
        const stretchY = Number((1 + (rnd(1.006, 1.018) - 1) * gstr.stretch).toFixed(4));
        // Keep the frame centre. Moving the crop toward the island shifts the whole
        // picture (measured ~9% of the frame height on a 1080x1920 file) and the operator
        // reads that as "the image moved". A uniform zoom about the centre keeps the
        // framing the source had; the island only picks the gentler zoom tier.
        const x0 = 0.5;
        const x1 = 0.5;
        const y0 = 0.5;
        const y1 = 0.5;
        let shakeAmp = Number((rnd(0.80, 1.60) * gstr.shake).toFixed(2));
        const shakeF1 = Number(rnd(0.24, 0.40).toFixed(3));
        const shakeF2 = Number(rnd(0.11, 0.19).toFixed(3));
        const dur = Math.max(Number(probeInfo.durationSec) || 8, 0.75);
        const durStr = dur.toFixed(3);
        const rf = Number((1 + (rnd(1.014 + geo * 0.004, 1.028 + geo * 0.006) - 1) * gstr.geo).toFixed(4));
        const rfX = 0.5;
        const rfY = 0.5;
        const k1 = Number((rnd(-0.024, 0.024) * gstr.lens).toFixed(4));
        const k2 = Number((rnd(-0.010, 0.010) * gstr.lens).toFixed(4));

        // Base speed is still one direction for the whole clip. The curve repeats an
        // 8 s shape: video setpts and audio atempo use the same slice speeds.
        // Strong uses the measured shape. On an 8 s excerpt the two streams ended
        // about one frame apart. The measurement mapper uses the harmonic mean,
        // which does not undo the curve inside one cycle.
        const speedSpan = (isAdv ? 0.012 : 0.010) * gstr.tempo;
        let speed = rnd(1 - speedSpan, 1 + speedSpan);
        if (Math.abs(speed - 1) < 0.004) speed = speed >= 1 ? 1.006 : 0.994;
        speed = Number(speed.toFixed(4));
        const curve = tempoCurve(speed, gstr.tempo, dur);

        sendEvent('log', { message: `[SYS] Tempo base ${speed}× · curve ${curve.speeds.map((value) => value.toFixed(3)).join('/')} · A/V locked · fps ${srcFps} held` });

        // Watchable unique: richer + sharper, not dark/cyan.
        // Hue stays tiny (geometry already unique). Sat/contrast punch the grade.
        let hueShift = (rnd(-2.2, 2.6) * gstr.color).toFixed(2);
        let satMul = (1 + (rnd(1.10, 1.18) - 1) * gstr.color).toFixed(3);
        let contrast = (1 + (rnd(1.06, 1.13) - 1) * gstr.color).toFixed(3);
        let brightness = (rnd(0.030, 0.055) * gstr.color).toFixed(3);
        let gamma = (1 + (rnd(1.00, 1.06) - 1) * gstr.color).toFixed(3);
        // Two videos in one batch should not come out with the same visible grade. The draw
        // is independent per job, so without this a batch can repeat the same warmth /
        // contrast / grain signature; re-draw while the two jobs are within noise of each
        // other. Six attempts is plenty. Memory is per process - a restart resets it.
        const SIGNATURE_TOLERANCE = [0.15, 0.6, 0.012, 0.012, 0.006, 0.010];
        const gradeSignature = () => [shakeAmp, Number(hueShift), Number(satMul), Number(contrast), Number(brightness), Number(gamma)];
        const withinNoise = (a, b) => Array.isArray(b) && a.length === b.length
            && a.every((value, i) => Math.abs(value - b[i]) <= SIGNATURE_TOLERANCE[i]);
        let uniqueRedraws = 0;
        while (uniqueRedraws < 6 && withinNoise(gradeSignature(), lastUniqueSignature)) {
            shakeAmp = Number((rnd(0.80, 1.60) * gstr.shake).toFixed(2));
            hueShift = (rnd(-2.2, 2.6) * gstr.color).toFixed(2);
            satMul = (1 + (rnd(1.10, 1.18) - 1) * gstr.color).toFixed(3);
            contrast = (1 + (rnd(1.06, 1.13) - 1) * gstr.color).toFixed(3);
            brightness = (rnd(0.030, 0.055) * gstr.color).toFixed(3);
            gamma = (1 + (rnd(1.00, 1.06) - 1) * gstr.color).toFixed(3);
            uniqueRedraws += 1;
        }
        lastUniqueSignature = gradeSignature();
        if (uniqueRedraws) {
            sendEvent('log', { message: `[SYS] Anti-repeat: re-drew grade/shake ${uniqueRedraws}x - the previous job was within noise of this one` });
        }

        let platSat = 1;
        let platBright = 0;
        let platContrast = 1;
        if (platformMode === 'ig_reels') { platSat = 1.02; platBright = 0.006; }
        else if (platformMode === 'yt_shorts') { platContrast = 1.02; }
        else if (platformMode === 'tiktok') { platSat = 1.03; platBright = 0.008; }

        // Neutral-to-warm. Old cool path (rs always negative + extra blue) looked green.
        const rs = (rnd(-0.010, 0.028) * gstr.color).toFixed(3);
        const gs = (rnd(-0.018, 0.010) * gstr.color).toFixed(3);
        const bs = (rnd(-0.018, 0.016) * gstr.color).toFixed(3);
        const rm = (rnd(-0.008, 0.024) * gstr.color).toFixed(3);
        const gm = (rnd(-0.012, 0.010) * gstr.color).toFixed(3);
        const bm = (rnd(-0.016, 0.014) * gstr.color).toFixed(3);
        const eqContrast = (parseFloat(contrast) * platContrast).toFixed(3);
        const eqBright = (parseFloat(brightness) + platBright).toFixed(3);
        const eqSat = platSat.toFixed(3);

        // Always the full frame: one uniform transform is what keeps the picture free of
        // a hard seam where a magnified content island used to meet un-magnified bars.
        const contentW = srcEvenW;
        const contentH = srcEvenH;
        const chainW = contentW;
        const chainH = contentH;
        const advBump = isAdv ? 3 : 1;
        const lumaN = Math.max(1, Math.round((3 + rnd(0, 2)) * gstr.grain) + advBump);
        // Chroma grain is capped at 2 whatever the strength: on "Cực mạnh" it used to reach 3
        // and the coloured speckle was the ugliest part of the render (the operator saw it as
        // "hạt màu lấm tấm"), while luma grain is what keeps the texture unique. Only the
        // extreme level changes (3 -> 2); light/strong are already at or below the cap.
        const chromaN = Math.min(2, Math.max(1, Math.round(gstr.grain + advBump * 0.25)));
        const sensorGrain = `noise=c0s=${lumaN}:c0f=a+t:c1s=${chromaN}:c1f=a+t:c2s=${chromaN}:c2f=a+t`;
        const sensorName = `light grain L${lumaN}/C${chromaN}`;

        // crop w/h are init-only (cannot use t). Zoom animates via scale eval=frame.
        // Always crop from the frame center so the subject does not drift.
        // Time-varying geometry, in the core path on purpose: measured on a 12s clip, a
        // breathing zoom (+/-0.8% every 1.4s) plus a slow pan (+/-2% of the frame over 9s)
        // lifted the same-timestamp dHash from 11.6% to 14.3% - the layer a platform
        // actually compares - while costing no extra crop and staying under the visible
        // threshold. Amplitude follows the strength setting, so there is no extra control.
        const breathAmp = Number((0.006 * gstr.zoom).toFixed(4));
        const panAmp = Number((0.012 * gstr.zoom).toFixed(4));
        const zExpr = `(${z0}+(${z1}-${z0})*t/${durStr}+${breathAmp}*sin(2*PI*t/1.4))`;
        const cxExpr = `(${x0}+${panAmp}*sin(2*PI*t/9)+(${x1}-${x0})*t/${durStr})`;
        const cyExpr = `(${y0}+${(panAmp * 0.6).toFixed(4)}*sin(2*PI*t/11)+(${y1}-${y0})*t/${durStr})`;
        const cropX = `max(0\\,min(iw-ow\\,iw*(${cxExpr})-ow/2+${shakeAmp}*sin(n*${shakeF1})+${shakeAmp}*0.55*cos(n*${shakeF2})))`;
        const cropY = `max(0\\,min(ih-oh\\,ih*(${cyExpr})-oh/2+${shakeAmp}*0.85*cos(n*${shakeF1})+${shakeAmp}*0.45*sin(n*${shakeF2})))`;

        const uniqueChainParts = [
            `scale=w=trunc(iw*${zExpr}*${stretchX}/2)*2:h=trunc(ih*${zExpr}*${stretchY}/2)*2:eval=frame:flags=bilinear`,
            `crop=${chainW}:${chainH}:${cropX}:${cropY}`,
            `hue=h=${hueShift}:s=${satMul}`,
            `eq=contrast=${eqContrast}:brightness=${eqBright}:saturation=${eqSat}:gamma=${gamma}`,
            `colorbalance=rs=${rs}:gs=${gs}:bs=${bs}:rm=${rm}:gm=${gm}:bm=${bm}`,
            sensorGrain,
            `unsharp=3:3:0.90:3:3:0.20`,
        ];

        let advNote = 'off';
        if (isAdv) {
            const nz = () => (Math.random() < 0.5 ? 1 : -1);
            const cbh = nz();
            const cbv = nz();
            const crh = nz();
            const crv = nz();
            const hWob = rnd(0.7, 1.6).toFixed(2);
            const hPer = rnd(6.0, 12.0).toFixed(2);
            uniqueChainParts[2] = `hue=h='${hueShift}+${hWob}*sin(2*3.1416*t/${hPer})':s=${satMul}`;
            uniqueChainParts.push(`chromashift=cbh=${cbh}:cbv=${cbv}:crh=${crh}:crv=${crv}`);
            // No geq layer any more. It used to be pushed with amp 6-10.5 luma (28-40 px
            // sine stripes) whenever PGD was ALSO on, which painted visible vertical bands
            // over the whole picture - caught on a real 4 s clip on 2026-09-28 - and cost
            // 3-5x the render time because geq is single-threaded. PGD already does its own
            // embedding work, so the layer only added damage and time.
            advNote = `fast unique (no geq) · chroma ±1 · hue ±${hWob}°`;
            sendEvent('log', { message: `[SYS] Pseudo-adversarial ON: ${advNote}` });
        } else {
            sendEvent('log', { message: '[SYS] Pseudo-adversarial OFF (Lớp nhiễu nhẹ đang tắt)' });
        }

        const uniqueChain = uniqueChainParts.join(',');
        const reframe = `lenscorrection=k1=${k1}:k2=${k2},scale=w=trunc(iw*${rf}/2)*2:h=trunc(ih*${rf}/2)*2:flags=bilinear,crop=${outW}:${outH}:x=max(0\\,min(iw-ow\\,(iw-ow)*${rfX})):y=max(0\\,min(ih-oh\\,(ih-oh)*${rfY}))`;
        const padToTik = convertCanvas
            ? `scale=${outW}:${outH}:force_original_aspect_ratio=decrease:flags=bilinear,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black,`
            : '';
        // Optional tilt. It runs before the canvas fit so a TikTok pad stays level, and it
        // is followed by exactly the zoom a tilt of that size needs, so no empty corner is
        // ever exposed. The zoom cost is the physical price of rotating a rectangle.
        const rotateDeg = Math.max(0, Math.min(5, Number(uniqueRotate) || 0));
        // Wobble = the same tilt, but the angle swings as sin(2*pi*t/period) instead of
        // sitting still. A static tilt only shows as slanted edges (the eye adapts); a
        // swinging tilt is motion the eye sees immediately.
        const wobbleDeg = Math.max(0, Math.min(5, Number(uniqueWobble) || 0));
        const WOBBLE_PERIOD = 1.5;
        // A tilt inside a 9:16 canvas cannot tilt the canvas itself - it tilts the picture
        // and, on a clip that has blur/letterbox bars, the bar edge too. Nothing is blocked
        // automatically any more: what the operator picks is what runs. On a clip with bars
        // a tilt makes the bar edge slanted, so leave the mode off for those clips.
        const useWobble = wobbleDeg > 0;
        const appliedRotateDeg = useWobble ? 0 : rotateDeg;
        const maxTiltDeg = useWobble ? wobbleDeg : appliedRotateDeg;
        const maxTiltRad = (maxTiltDeg * Math.PI) / 180;
        const rotateScale = maxTiltDeg > 0
            // +0.012 margin: the exact fit leaves the window corners tangent to the rotated
            // edges, and a tangent pixel samples half outside and comes back dark.
            ? Math.cos(maxTiltRad) + (srcEvenH / Math.max(1, srcEvenW)) * Math.sin(maxTiltRad) + 0.012
            : 1;
        const rotateExpr = useWobble
            ? `${maxTiltRad.toFixed(6)}*sin(2*PI*t/${WOBBLE_PERIOD})`
            : maxTiltRad.toFixed(5);
        const rotatePart = maxTiltDeg > 0
            ? `rotate='${rotateExpr}',scale=w=trunc(iw*${rotateScale.toFixed(4)}/2)*2:h=trunc(ih*${rotateScale.toFixed(4)}/2)*2:flags=bilinear,crop=${srcEvenW}:${srcEvenH},`
            : '';
        if (useWobble) {
            sendEvent('log', { message: `[SYS] Wobble: ±${wobbleDeg}° period ${WOBBLE_PERIOD}s · corner-fill zoom ${rotateScale.toFixed(3)}× (hình đung đưa, caption chạy rõ)` });
        } else if (appliedRotateDeg > 0) {
            sendEvent('log', { message: `[SYS] Rotate: ${appliedRotateDeg}° · corner-fill zoom ${rotateScale.toFixed(3)}× (caption nghiêng và viền chữ hơi mềm)` });
        }
        // One filter graph for every case. The old content-island overlay magnified only
        // the middle band, which cut the picture at the island edges (visible seam and a
        // subject that was bigger inside the band than outside it).
        const vf = `${uniqueChain},${rotatePart}${padToTik}${reframe},setsar=1,setpts=${curve.videoSetpts}`;

        // Option A: the blurred/letterbox bar meets the content band with a hard step.
        // Soften that step by cross-fading the frame into a vertically blurred copy in a
        // narrow band around each boundary. Runs before the uniform transform, so the
        // softened edge stays softened and never becomes a seam again.
        const featherPx = 56;
        const featherBlur = Math.round(featherPx * 0.6);
        let barTop = 0;
        let barBottom = 0;
        let softSeam = false;
        // Manual bar heights win: the operator can read the bar off the frame, and the
        // auto detector is unreliable when a bar shares the picture's tone.
        const barTopPct = Math.max(0, Math.min(45, Number(featherTop) || 0));
        const barBottomPct = Math.max(0, Math.min(45, Number(featherBottom) || 0));
        const featherOn = featherEnabled === 'true';
        if (featherOn && barTopPct > 0 && barBottomPct > 0) {
            barTop = evenDim(Math.round((barTopPct / 100) * srcEvenH));
            barBottom = evenDim(Math.round((1 - barBottomPct / 100) * srcEvenH));
            softSeam = true;
            sendEvent('log', { message: `[SYS] Blur-bar seam: entered bars top ${barTopPct}% / bottom ${barBottomPct}% -> rows y=${barTop} and y=${barBottom}` });
        } else if (featherOn) {
            sendEvent('log', { message: '[SYS] Blur-bar seam ON but no percents entered - nothing done. Enter both bar heights.' });
        }
        // The mask must be generated from the video stream, not from a `color` source:
        // a lavfi source inside the graph has no duration and the graph then never ends.
        const softGraph = softSeam
            ? `[0:v]split=3[base][softsrc][masksrc];`
                + `[softsrc]gblur=sigma=1:sigmaV=${featherBlur}:steps=2[softblur];`
                + `[masksrc]scale=2:${srcEvenH}:flags=neighbor,format=gray,`
                + `geq=lum='min(255\\,clip(255*(1-abs(Y-${barTop})/${featherPx})\\,0\\,255)+clip(255*(1-abs(Y-${barBottom})/${featherPx})\\,0\\,255))'[maskthin];`
                + `[maskthin]scale=${srcEvenW}:${srcEvenH}:flags=bilinear[mask];`
                + `[base][softblur][mask]maskedmerge[merged]`
            : '';
        if (softSeam) {
            sendEvent('log', { message: `[SYS] Bar edges found: content band y=${barTop}..${barBottom} (${(barTop / srcEvenH * 100).toFixed(1)}%-${(barBottom / srcEvenH * 100).toFixed(1)}%) - softening both seams ${featherPx}px (vertical blur ${featherBlur})` });
        }
        let fitNote = convertCanvas ? `fit+black-pad ${srcEvenW}x${srcEvenH} → ${outW}x${outH}` : `${outW}x${outH}`;

        sendEvent('log', { message: `[SYS] Unique FULL FRAME ${srcEvenW}x${srcEvenH}: Ken Burns ${z0}→${z1}x · stretch ${stretchX}×${stretchY} · one uniform transform · CENTER lock` });
        const keep0 = 100 / (z0 * stretchX * rf);
        const keep1 = 100 / (z1 * stretchX * rf);
        sendEvent('log', { message: `[SYS] Visible ${Math.min(keep0, keep1).toFixed(0)}–${Math.max(keep0, keep1).toFixed(0)}% of source (was ~70–75% with stacked 1.18× + 1.07× crop)` });
        sendEvent('log', { message: `[SYS] Micro-shake ${shakeAmp}px · ${zoomIn ? 'zoom-in' : 'zoom-out'} · lens k1=${k1} k2=${k2} · canvas reframe ${rf}× center crop` });
        sendEvent('log', { message: convertCanvas
            ? `[SYS] Then place on 1080x1920 with BLACK bars (Rehash) · ${fitNote}`
            : `[SYS] Geometry-first pHash break · CENTER · size locked` });
        sendEvent('log', { message: `[SYS] Color richer/sharper: hue ${hueShift}° · sat ${satMul} · contrast ${eqContrast} · bright ${eqBright} · γ ${gamma}` });
        sendEvent('log', { message: `[SYS] Grain: ${sensorName}` });
        sendEvent('log', { message: '[SYS] Fast unique: bilinear Ken Burns · no extra scale · no geq stripe layer (PGD runs its own pass)' });
        sendEvent('log', { message: '[SYS] No vignette · warm-neutral grade (not cyan)' });

        const geometricMode = (convertCanvas
            ? `Rehash canvas 1080x1920 black-pad from ${srcEvenW}x${srcEvenH} · KB ${z0}→${z1}x stretch ${stretchX}×${stretchY} · CENTER`
            : `Full frame ${outW}x${outH} locked · KB ${z0}→${z1}x stretch ${stretchX}×${stretchY} · CENTER · shake ${shakeAmp}px · reframe ${rf}×`);
        const colorMode = `Hue ${hueShift}° · sat ${satMul} · contrast ${eqContrast} · bright ${eqBright} · γ ${gamma} (rich/sharp)`;
        const advModeStr = isAdv ? `pseudo-adv ${advNote} · ${sensorName} · ${speed}× base · curve` : `off · ${sensorName} · ${speed}× base · curve`;

        const mapArgs = ['-map', '0:v:0'];
        if (hasAudio) mapArgs.push('-map', '0:a:0?');
        const audioFilterArgs = [];
        let afHead = '';

        if (hasAudio) {
            const span = (isAudioAttack ? 5.5 : 3.5) * gstr.audio;
            const g80 = rnd(-span, span).toFixed(2);
            const g160 = rnd(-span * 0.7, span * 0.7).toFixed(2);
            const g250 = rnd(-span, span).toFixed(2);
            const g1k = rnd(-Math.min(span, 4), Math.min(span, 4)).toFixed(2);
            const g4k = rnd(-span, span).toFixed(2);
            const g8k = rnd(-span, span).toFixed(2);
            const ap1 = Math.round(rnd(420, 980));
            const ap2 = Math.round(rnd(1200, 2800));
            const ap3 = Math.round(rnd(3600, 7800));
            const ap4 = Math.round(rnd(8500, 12000));
            const mlev = rnd(0.90, 1.12).toFixed(3);
            const slev = rnd(0.82, 1.14).toFixed(3);
            const stereoM = (1 + (rnd(0.62, 1.38) - 1) * gstr.audio).toFixed(2);
            const hissVol = (isAudioAttack ? 0.14 : 0.08) * gstr.audio;
            const afParts = [
                `equalizer=f=80:t=q:w=0.9:g=${g80}`,
                `equalizer=f=160:t=q:w=0.9:g=${g160}`,
                `equalizer=f=250:t=q:w=1.0:g=${g250}`,
                `equalizer=f=1000:t=q:w=1.1:g=${g1k}`,
                `equalizer=f=4000:t=q:w=1.0:g=${g4k}`,
                `equalizer=f=8000:t=q:w=0.9:g=${g8k}`,
                `allpass=f=${ap1}:width_type=h:width=180`,
                `allpass=f=${ap2}:width_type=h:width=280`,
                `allpass=f=${ap3}:width_type=h:width=400`,
                `allpass=f=${ap4}:width_type=h:width=500`,
                `acompressor=threshold=0.12:ratio=2.4:attack=12:release=80`,
            ];
            if ((probeInfo.audioChannels || 2) >= 2) {
                afParts.push(`stereotools=mlev=${mlev}:slev=${slev}`);
                afParts.push(`extrastereo=m=${stereoM}`);
            }
            // Light time-varying level on top of the static EQ: ffmpeg's equalizer cannot
            // drift its gain, so the spectral drift comes from a Linkwitz-Riley crossover
            // (`acrossover`) into three bands, each with its own slow gain cycle, summed
            // back flat. Measured on the 15s smoke clip: the crossover alone (every band at
            // gain 1) changes the level by -0.14 dB with a 0.11 dB/s residual, so it is
            // neutral; adding the cycles lifts the low band's per-second movement from
            // +/-1.6 to +/-2.6 dB and the loudest sample jump stays below the source's
            // (x0.93), i.e. no click. Periods are drawn per job so two videos do not share
            // one audio signature, and the depth follows `gstr.audio`.
            // Per band: +/-0.16-0.26 / 0.10-0.16 / 0.14-0.24 linear gain (about 2-3 dB peak).
            const driftScale = Math.min(1.2, gstr.audio);
            let driftLow;
            let driftMid;
            let driftHigh;
            let periodLow;
            let periodMid;
            let periodHigh;
            const drawAudioDrift = () => {
                driftLow = Number((rnd(0.16, 0.26) * driftScale).toFixed(3));
                driftMid = Number((rnd(0.10, 0.16) * driftScale).toFixed(3));
                driftHigh = Number((rnd(0.14, 0.24) * driftScale).toFixed(3));
                periodLow = Number(rnd(5.1, 7.9).toFixed(2));
                periodMid = Number(rnd(7.3, 9.7).toFixed(2));
                periodHigh = Number(rnd(3.7, 5.3).toFixed(2));
            };
            drawAudioDrift();
            // Anti-repeat, as for the visible grade: two videos in one batch should not share
            // the same drift rhythm. Tolerance is about 0.02 of gain (0.17 dB) and 0.8 s of
            // period; six attempts is plenty because the ranges are wide.
            const AUDIO_SIGNATURE_TOLERANCE = [0.02, 0.02, 0.02, 0.8, 0.8, 0.8];
            const audioSignature = () => [driftLow, driftMid, driftHigh, periodLow, periodMid, periodHigh];
            const audioWithinNoise = (a, b) => Array.isArray(b) && a.length === b.length
                && a.every((value, i) => Math.abs(value - b[i]) <= AUDIO_SIGNATURE_TOLERANCE[i]);
            let audioRedraws = 0;
            while (audioRedraws < 6 && audioWithinNoise(audioSignature(), lastAudioSignature)) {
                drawAudioDrift();
                audioRedraws += 1;
            }
            lastAudioSignature = audioSignature();
            if (audioRedraws) {
                sendEvent('log', { message: `[SYS] Anti-repeat: re-drew audio drift ${audioRedraws}x - the previous job was within noise of this one` });
            }
            const phaseHigh = Number(rnd(0, 6.28).toFixed(2));
            const driftGraph = 'acrossover=split=400|3500:order=4[bl][bm][bh];'
                + `[bl]volume='1+${driftLow}*sin(2*PI*t/${periodLow})':eval=frame[bl2];`
                + `[bm]volume='1+${driftMid}*sin(2*PI*t/${periodMid}+1.3)':eval=frame[bm2];`
                + `[bh]volume='1+${driftHigh}*sin(2*PI*t/${periodHigh}+${phaseHigh})':eval=frame[bh2];`
                + '[bl2][bm2][bh2]amix=inputs=3:normalize=0[drifted]';
            const levelDrift = Number((0.014 * gstr.audio).toFixed(4));
            afHead = afParts.join(',')
                + `,${driftGraph},[drifted]asplit[dry][wet];[wet]highpass=f=9000,lowpass=f=15500,volume=${hissVol}[hiss];[dry][hiss]amix=inputs=2:normalize=0:duration=first,volume='1+${levelDrift}*sin(2*PI*t/7)':eval=frame`;
            const af = `${afHead},${curve.audioChain},aresample=44100`;
            audioFilterArgs.push('-af', af);
            sendEvent('log', { message: `[SYS] Audio unique (no pitch): EQ±${span}dB allpass ${ap1}/${ap2}/${ap3}/${ap4} Hz · EQ trôi 3 dải ±${(driftLow * 100).toFixed(0)}/${(driftMid * 100).toFixed(0)}/${(driftHigh * 100).toFixed(0)}% chu kỳ ${periodLow}/${periodMid}/${periodHigh}s · curve locked to video` });
        } else {
            sendEvent('log', { message: '[SYS] No audio track — skipping audio filters' });
        }

        // Metadata is stamped in a second copy-remux so tags actually stick.
        const encoderWanted = resolveEncoder(encoderMode);
        const postArgs = [];
        if (hasAudio) postArgs.push('-c:a', 'aac', '-b:a', '128k');
        else postArgs.push('-an');
        postArgs.push('-movflags', '+faststart', encPath);

        const buildArgs = (attempt) => {
            const rate = ['-r', String(srcFps)];
            const fmt = attempt.nvenc ? 'format=nv12' : 'format=yuv420p';
            if (attempt.nvenc) {
                sendEvent('log', { message: `[SYS] NVENC keep ${outW}x${outH} · pix nv12 (no extra scale)` });
            } else {
                rate.push('-fps_mode', 'cfr');
            }
            if (softSeam) {
                const aMap = hasAudio ? ['-map', '0:a:0?'] : [];
                return [...args, '-filter_complex', `${softGraph};[merged]${vf},${fmt}[vout]`, '-map', '[vout]', ...aMap, ...rate, ...audioFilterArgs, ...attempt.args, ...postArgs];
            }
            return [...args, '-vf', `${vf},${fmt}`, ...mapArgs, ...rate, ...audioFilterArgs, ...attempt.args, ...postArgs];
        };

        const runEncode = (fullArgs, opts = {}) => new Promise((resolve) => {
            let ffmpeg;
            try { ffmpeg = spawn('ffmpeg', fullArgs, { env: ffmpegEnv }); }
            catch (err) {
                resolve({ code: 1, signal: null, stderrTail: err instanceof Error ? err.message : String(err) });
                return;
            }
            noteUniqueChild(job, ffmpeg);
            let totalDuration = 0;
            let stderrTail = '';
            let ffmpegSpeed = 0;
            const encodeStart = Date.now();
            ffmpeg.stderr.on('data', (data) => {
                const str = data.toString();
                stderrTail = (stderrTail + str).slice(-1500);
                if (opts.silent) {
                    if (/Error/i.test(str) && !/Error while opening encoder|Function not implemented/i.test(str)) {
                        sendEvent('log', { message: `[FFMPEG] ${str.trim()}` });
                    }
                } else if (str.includes('Duration:') || str.includes('time=') || str.includes('Error')) {
                    if (/Error while opening encoder|Function not implemented/i.test(str)) {
                        sendEvent('log', { message: '[SYS] This NVENC recipe cannot open on this driver — skipping' });
                    } else {
                        sendEvent('log', { message: `[FFMPEG] ${str.trim()}` });
                    }
                }
                const durationMatch = str.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                if (durationMatch) {
                    totalDuration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseFloat(durationMatch[3]);
                }
                const speedMatch = str.match(/speed=\s*([\d.]+)x/);
                if (speedMatch) ffmpegSpeed = parseFloat(speedMatch[1]);
                const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                if (!opts.silent && timeMatch && totalDuration > 0) {
                    const currentTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
                    // FFmpeg prints its own processing rate ("speed=1.66x"), which is the
                    // honest basis for "còn lại bao lâu". Without it (first chunks), fall
                    // back to the wall clock since this encode started.
                    const rate = ffmpegSpeed > 0.01
                        ? ffmpegSpeed
                        : currentTime / Math.max(0.5, (Date.now() - encodeStart) / 1000);
                    // FFmpeg's first "speed=" reading is taken while the filter graph is
                    // still starting, so it reads far too slow (measured: 133 s remaining at
                    // 0.4% on a 30 s clip whose encode took 15 s). Only publish an estimate
                    // once the encode is past 3% and the rate has settled.
                    const settled = currentTime > 1 && rate > 0.1 && (currentTime / totalDuration) > 0.03;
                    const etaMs = settled ? Math.max(0, ((totalDuration - currentTime) / rate) * 1000) : null;
                    sendEvent('progress', {
                        value: Math.min(99, (currentTime / totalDuration) * 100),
                        phase: 'unique',
                        ...(etaMs === null ? {} : { etaMs: Math.round(etaMs) }),
                    });
                }
            });
            ffmpeg.on('error', (err) => resolve({ code: 1, signal: null, stderrTail: err.message }));
            ffmpeg.on('close', (code, signal) => {
                job.ffmpeg = null;
                resolve({ code, signal, stderrTail });
            });
        });

        // FFmpeg 9 on this machine has no -filter_script / -filter_complex_script.
        // A long clip's audio chain is one atempo slice per second, so the argv
        // crosses the Windows command limit. The video filter stays inline. The
        // audio head is unchanged, then the same atempo branches run in chunks.
        const runEncodeSpilled = async (attempt) => {
            const videoPath = path.join(uploadsDir, `${jobId}_aspill_v.mp4`);
            const headPath = path.join(uploadsDir, `${jobId}_aspill_head.wav`);
            const listPath = path.join(uploadsDir, `${jobId}_aspill_list.txt`);
            const rate = ['-r', String(srcFps)];
            const fmt = attempt.nvenc ? 'format=nv12' : 'format=yuv420p';
            if (!attempt.nvenc) rate.push('-fps_mode', 'cfr');
            const videoArgs = softSeam
                ? [...args, '-filter_complex', `${softGraph};[merged]${vf},${fmt}[vout]`, '-map', '[vout]', ...rate, ...attempt.args, '-an', '-movflags', '+faststart', videoPath]
                : [...args, '-vf', `${vf},${fmt}`, '-map', '0:v:0', ...rate, ...attempt.args, '-an', '-movflags', '+faststart', videoPath];
            sendEvent('log', { message: '[SYS] Lệnh FFmpeg dài quá giới hạn Windows. Video vẫn encode như cũ. Audio tempo chia khúc, cùng atempo từng giây, rồi ghép.' });
            const videoResult = await runEncode(videoArgs);
            if (videoResult.code !== 0 || job.cancelled) return videoResult;
            const headResult = await runEncode([
                '-y', '-i', pipelineInput, '-vn', '-map', '0:a:0?',
                '-af', afHead,
                '-c:a', 'pcm_f32le', headPath,
            ], { silent: true });
            if (headResult.code !== 0 || job.cancelled) return headResult;
            const maxChain = Math.max(1000, WINDOWS_COMMAND_BUDGET - 2500);
            const groups = chunkTempoBranches(curve.branches, maxChain);
            const chunkPaths = [];
            for (let ci = 0; ci < groups.length; ci++) {
                if (job.cancelled) return { code: 1, signal: 'SIGKILL', stderrTail: 'cancelled' };
                const chunkPath = path.join(uploadsDir, `${jobId}_aspill_a${ci}.wav`);
                chunkPaths.push(chunkPath);
                sendEvent('log', { message: `[SYS] Audio tempo khúc ${ci + 1}/${groups.length}` });
                const chunkResult = await runEncode([
                    '-y', '-i', headPath,
                    '-af', tempoAudioChain(groups[ci]),
                    '-c:a', 'pcm_f32le', chunkPath,
                ], { silent: true });
                if (chunkResult.code !== 0) return chunkResult;
                if (job.cancelled) return { code: 1, signal: 'SIGKILL', stderrTail: 'cancelled' };
            }
            fs.writeFileSync(listPath, `${chunkPaths.map((file) => `file '${String(file).replace(/\\/g, '/')}'`).join('\n')}\n`);
            try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch { /* ignore */ }
            return runEncode([
                '-y', '-i', videoPath, '-f', 'concat', '-safe', '0', '-i', listPath,
                '-map', '0:v:0', '-map', '1:a:0',
                '-af', 'aresample=44100',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', encPath,
            ], { silent: true });
        };

        const attempts = encoderAttempts(encoderWanted);
        sendEvent('log', { message: '[SYS] Executing native FFmpeg...' });
        let result = { code: 1, signal: null, stderrTail: '' };
        for (let ai = 0; ai < attempts.length; ai++) {
            if (job.cancelled) {
                result = { code: 1, signal: 'SIGKILL', stderrTail: 'cancelled' };
                break;
            }
            const attempt = attempts[ai];
            sendEvent('log', { message: `[SYS] Encoder: ${attempt.label}` });
            try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch { /* ignore */ }
            clearAspill(jobId);
            const fullArgs = buildArgs(attempt);
            result = hasAudio && afHead && commandLineLength(fullArgs) > WINDOWS_COMMAND_BUDGET
                ? await runEncodeSpilled(attempt)
                : await runEncode(fullArgs);
            if (job.cancelled) {
                result = { code: 1, signal: 'SIGKILL', stderrTail: 'cancelled' };
                break;
            }
            if (result.code === 0) break;
            if (ai < attempts.length - 1) {
                sendEvent('log', { message: `[SYS] ${attempt.label} failed — trying next encoder` });
            }
        }
        clearAspill(jobId);

        const { code, signal, stderrTail } = result;
        if (job.cancelled) {
            sendEvent('error', { message: 'Cancelled by user' });
            res.end();
            return;
        }
        if (code === 0) {
            try {
                const encProbe = await probeMedia(encPath);
                if (encProbe.width && encProbe.height && (encProbe.width !== outW || encProbe.height !== outH)) {
                    sendEvent('log', { message: `[SYS] Size drift ${encProbe.width}x${encProbe.height} → locking ${outW}x${outH}` });
                    const lockedPath = path.join(uploadsDir, `${jobId}_sized.mp4`);
                    await runFf([
                        '-y', '-i', encPath,
                        '-vf', `scale=${outW}:${outH}:flags=lanczos,setsar=1`,
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                        '-c:a', 'copy',
                        '-movflags', '+faststart',
                        lockedPath,
                    ], job);
                    try { fs.unlinkSync(encPath); } catch { /* ignore */ }
                    fs.renameSync(lockedPath, encPath);
                } else {
                    sendEvent('log', { message: `[SYS] Output size ${encProbe.width || outW}x${encProbe.height || outH} matches source lock` });
                }

                tEncode = Date.now();
                if (enablePgd === 'true') {
                    sendEvent('progress', { value: 100, phase: 'unique' });
                    sendEvent('progress', { value: 0, phase: 'pgd' });
                    sendEvent('log', { message: `[SYS] Unique 100% — starting PGD CLIP (${String(pgdLevel || 'medium')}). Watch the PGD bar.` });
                    const pgdPath = path.join(uploadsDir, `${jobId}_pgd.mp4`);
                    const clipJson = path.join(uploadsDir, `${jobId}_clip.json`);
                    try {
                        await runPgdClip(encPath, pgdPath, job, sendEvent, clipJson, pgdLevel);
                        try { fs.unlinkSync(encPath); } catch { /* ignore */ }
                        fs.renameSync(pgdPath, encPath);
                        sendEvent('progress', { value: 100, phase: 'pgd' });
                        sendEvent('log', { message: '[SYS] PGD CLIP done' });
                    } catch (pgdErr) {
                        sendEvent('log', { message: `[SYS] PGD failed, keep Unique only: ${pgdErr instanceof Error ? pgdErr.message : String(pgdErr)}`.slice(0, 280) });
                        try { if (fs.existsSync(pgdPath)) fs.unlinkSync(pgdPath); } catch { /* ignore */ }
                    }
                }

                tPgd = Date.now();
                tCaption = tPgd;
                if (enableCaptions) {
                    await burnUniqueCaptions(encPath, job, sendEvent, jobId);
                    tCaption = Date.now();
                }

                sendEvent('log', { message: `[SYS] Stamping device metadata (${meta.profileName})...` });
                await remuxWithMetadata(encPath, outputPath, meta.args, job);
                tMeta = Date.now();
                try { fs.unlinkSync(encPath); } catch { /* ignore */ }

                const measured = await measureUniqueOutput({
                    inputPath: job.inputPath,
                    outputPath,
                    outputDurationSec: (Number(probeInfo.durationSec) || 0) / curve.mapSpeed,
                    speed: curve.mapSpeed,
                    sendEvent,
                    job,
                });

                let clipSim = null;
                try {
                    const clipJson = path.join(uploadsDir, `${jobId}_clip.json`);
                    if (fs.existsSync(clipJson)) {
                        clipSim = Number(JSON.parse(fs.readFileSync(clipJson, 'utf8')).meanClipSim);
                    }
                } catch { /* ignore */ }

                try {
                    if (job.inputPath && fs.existsSync(job.inputPath) && fs.existsSync(outputPath)) {
                        sendEvent('log', { message: '[SYS] Building machine-view: layers ON this frame (not vs original zoom)...' });
                        const origJpg = path.join(uploadsDir, `${jobId}_cmp_orig.jpg`);
                        const procJpg = path.join(uploadsDir, `${jobId}_cmp_proc.jpg`);
                        const diffJpg = path.join(uploadsDir, `${jobId}_cmp_diff.jpg`);
                        const durForStill = Number(probeInfo.durationSec) || 2;
                        const stillT = Math.max(0.25, durForStill * 0.42);
                        await runFf(['-y', '-ss', String(stillT), '-i', job.inputPath, '-frames:v', '1', '-q:v', '3', origJpg], job);
                        await runFf(['-y', '-ss', String(stillT), '-i', outputPath, '-frames:v', '1', '-q:v', '3', procJpg], job);
                        await runFf([
                            '-y', '-i', procJpg,
                            '-filter_complex', '[0:v]split[s][b];[b]gblur=sigma=3[bb];[s][bb]blend=all_mode=difference,format=gray,normalize,eq=contrast=1.6:brightness=0.06,format=yuv420p',
                            '-frames:v', '1', '-q:v', '3', diffJpg,
                        ], job);
                        job.compare = { orig: origJpg, proc: procJpg, diff: diffJpg };
                    }
                } catch (cmpErr) {
                    sendEvent('log', { message: `[SYS] Compare frames skipped: ${cmpErr instanceof Error ? cmpErr.message : String(cmpErr)}`.slice(0, 220) });
                }

                try { if (job.inputPath && fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath); } catch { /* ignore */ }

                tMeasure = Date.now();
                sendEvent('log', { message: '[SYS] Calculating new cryptographic hash...' });
                const newHash = await calculateSHA256(outputPath);
                const newStats = fs.statSync(outputPath);
                const outProbe = await probeMedia(outputPath);
                const stuck = await readStuckMetadata(outputPath);
                const metaOk = Boolean(stuck.make && stuck.model);
                sendEvent('log', {
                    message: metaOk
                        ? `[SYS] Metadata confirmed: ${stuck.make} ${stuck.model} · ${stuck.location || 'no GPS'}`
                        : '[SYS] WARNING: Device metadata did not stick on this file'
                });

                sendEvent('log', { message: `[SYS] Thời gian: chuẩn bị ${((tProbe - startTime) / 1000).toFixed(1)}s · làm mịn ${((tSmooth - tProbe) / 1000).toFixed(1)}s · encode ${((tEncode - tSmooth) / 1000).toFixed(1)}s · PGD ${((tPgd - tEncode) / 1000).toFixed(1)}s · phụ đề ${((tCaption - tPgd) / 1000).toFixed(1)}s · metadata ${((tMeta - tCaption) / 1000).toFixed(1)}s · đo đạc ${((tMeasure - tMeta) / 1000).toFixed(1)}s · tổng ${((tMeasure - startTime) / 1000).toFixed(1)}s` });
                sendEvent('log', { message: '[SYS] SUCCESS: Semantic Spoofer pipeline complete.' });

                const doneStats = {
                        originalHash: origHash,
                        newHash: newHash,
                        platform: platformMode,
                        processingTimeMs: Date.now() - startTime,
                        originalSize: job.originalSize,
                        newSize: newStats.size,
                        originalCodec: probeInfo.codec,
                        newCodec: outProbe.codec,
                        originalWidth: probeInfo.width,
                        originalHeight: probeInfo.height,
                        newWidth: outProbe.width,
                        newHeight: outProbe.height,
                        originalFps: probeInfo.fps,
                        newFps: outProbe.fps,
                        originalDuration: probeInfo.durationSec,
                        newDuration: outProbe.durationSec,
                        temporalMode: `${speed}× base · curve A/V locked · Ken Burns ${z0}→${z1} · shake ${shakeAmp}px`,
                        fpsJitter: `${srcFps} held`,
                        geometricMode,
                        colorMode,
                        adversarialMode: advModeStr,
                        metadataProfile: meta.profileName,
                        metadataMake: stuck.make || meta.make,
                        metadataModel: stuck.model || meta.model,
                        metadataLocation: stuck.location || meta.location,
                        metadataTitle: stuck.title || meta.title,
                        metadataConfirmed: metaOk,
                        clipSim: Number.isFinite(clipSim) ? clipSim : null,
                        pgdOn: enablePgd === 'true',
                        pgdLevel: enablePgd === 'true' ? String(pgdLevel || 'medium') : null,
                        smoothOn: enableSmooth,
                        captionsOn: enableCaptions,
                        handoffNote: handoffNote || undefined,
                        uniqueStrength: strengthName,
                        uniqueRotate: rotateDeg,
                        uniqueWobble: useWobble ? wobbleDeg : 0,
                        stagePrepMs: tProbe - startTime,
                        stageSmoothMs: Math.max(0, tSmooth - tProbe),
                        stageEncodeMs: Math.max(0, tEncode - tSmooth),
                        stagePgdMs: Math.max(0, tPgd - tEncode),
                        stageCaptionMs: Math.max(0, tCaption - tPgd),
                        stageMetadataMs: Math.max(0, tMeta - tCaption),
                        stageMeasureMs: Math.max(0, tMeasure - tMeta),
                        ...uniqueMeasurementStats(measured.perceptual, measured.seam, measured.audio, measured.clipSimOut, measured.harsh),
                        compareJobId: job.compare ? jobId : null,
                };
                rememberUniqueHold(jobId, job, doneStats);
                sendEvent('done', { stats: doneStats });
            } catch (stampErr) {
                sendEvent('error', { message: stampErr instanceof Error ? stampErr.message : String(stampErr) });
            }
        } else {
            const last = (stderrTail || '').replace(/\s+/g, ' ').trim().slice(-400);
            const why = signal
                ? `FFmpeg killed (${signal}). ${last}`
                : `FFmpeg exit ${code}. ${last || 'No ffmpeg log captured.'}`;
            sendEvent('error', { message: why });
        }
        res.end();
        return;
    } catch (err) {
        sendEvent('error', { message: err.message });
        res.end();
    } finally {
        if (smoothPath) {
            try { fs.rmSync(smoothPath, { force: true }); } catch { /* ignore */ }
        }
        try { fs.rmSync(path.join(uploadsDir, `${jobId}_smooth_work`), { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

app.get('/api/compare/:jobId/:kind', (req, res) => {
    const job = jobs.get(req.params.jobId);
    const kind = String(req.params.kind || '').replace(/[^a-z]/g, '');
    const file = job?.compare?.[kind];
    if (!file || !fs.existsSync(file)) return res.status(404).send('Compare frame not found');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.resolve(file));
});

app.get('/api/download/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || !job.outputPath || !fs.existsSync(job.outputPath)) {
        return res.status(404).send('File not found');
    }
    const requested = typeof req.query.name === 'string' && req.query.name.trim()
        ? req.query.name
        : (job.originalName || 'video.mp4');
    const filename = safeDownloadName(requested);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.resolve(job.outputPath));
});

app.get('/api/unique/held', (_req, res) => {
    res.json({
        items: uniqueHold.list().map((item) => ({
            jobId: item.jobId,
            name: item.name,
            originalName: item.originalName,
            stats: item.stats,
            downloadUrl: `/api/download/${item.jobId}`,
        })),
    });
});

app.post('/api/unique/held/:jobId', (req, res) => {
    const jobId = uniqueHoldJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ error: 'Bad job id' });
    if (!uniqueHold.rename(jobId, req.body?.name)) return res.status(404).json({ error: 'Not held' });
    res.json({ ok: true, name: uniqueHold.list().find((item) => item.jobId === jobId)?.name || '' });
});

app.delete('/api/unique/held/:jobId', (req, res) => {
    const jobId = uniqueHoldJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ error: 'Bad job id' });
    uniqueHold.forget(jobId);
    res.json({ ok: true });
});

app.get('/api/edit/held', (_req, res) => {
    res.json({
        items: editHold.list().map((item) => ({
            ...item,
            downloadUrl: `/api/download/${item.jobId}`,
        })),
    });
});

app.delete('/api/edit/held/:jobId', (req, res) => {
    const jobId = uniqueHoldJobId(req.params.jobId);
    if (!jobId) return res.status(400).json({ error: 'Bad job id' });
    editHold.forget(jobId);
    res.json({ ok: true });
});

app.delete('/api/job/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    uniqueHold.forget(req.params.jobId);
    editHold.forget(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Not found' });
    abortJob(job);
    try { if (job.outputPath && fs.existsSync(job.outputPath) && String(job.outputPath).startsWith(uploadsDir)) fs.unlinkSync(job.outputPath); } catch { /* ignore */ }
    try { if (job.encPath && fs.existsSync(job.encPath)) fs.unlinkSync(job.encPath); } catch { /* ignore */ }
    try {
        if (job.inputPath && fs.existsSync(job.inputPath) && !job.keepInput && String(job.inputPath).startsWith(uploadsDir)) {
            fs.unlinkSync(job.inputPath);
        }
    } catch { /* ignore */ }
    // Per-job sidecars are named after the jobId, so they can be swept without
    // knowing which pipeline wrote them. Without this they accumulate in uploads/.
    clearAspill(req.params.jobId);
    try { fs.rmSync(path.join(uploadsDir, `${req.params.jobId}_smooth_work`), { recursive: true, force: true }); } catch { /* ignore */ }
    for (const suffix of ['_enc.mp4', '_pgd.mp4', '_harsh.mp4', '_sized.mp4', '_smooth.mp4', '_cap.wav', '_cap.ass', '_capburn.mp4', '_cmp_orig.jpg', '_cmp_proc.jpg', '_cmp_diff.jpg', '_clip.json']) {
        const sidecar = path.join(uploadsDir, `${req.params.jobId}${suffix}`);
        try {
            if (String(sidecar).startsWith(uploadsDir) && fs.existsSync(sidecar) && fs.statSync(sidecar).isFile()) fs.unlinkSync(sidecar);
        } catch { /* ignore */ }
    }
    jobs.delete(req.params.jobId);
    res.json({ ok: true });
});

app.post('/api/cancel/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.json({ ok: true, missing: true });
    job.uniquePaused = false;
    abortJob(job);
    job.geminiKeyWaiter?.reject(new Error('cancelled'));
    job.geminiKeyWaiter = null;
    res.json({ ok: true, aborted: true });
});

app.post('/api/unique/pause/:jobId', async (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job?.uniqueRun) return res.json({ ok: true, missing: true });
    if (typeof req.body?.paused !== 'boolean') return res.status(400).json({ error: 'paused must be boolean' });
    const want = req.body.paused;
    job.uniquePaused = want;
    const plan = planUniquePause(job, want);
    if (plan.action === 'suspend' || plan.action === 'resume') {
        const held = await setProcessSuspended(plan.pid, plan.action === 'suspend');
        return res.json({ ok: held.ok !== false, paused: want, pid: plan.pid, already: Boolean(held.already) });
    }
    return res.json({ ok: true, paused: want, waiting: plan.action === 'mark' });
});

app.post('/api/edit/gemini-keys/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job?.geminiKeyWaiter) return res.status(409).json({ error: 'Job không đang chờ key' });
    const incoming = parseGeminiApiKeys({ apiKey: req.body?.apiKey, apiKeys: req.body?.apiKeys });
    const known = new Set(job.geminiKeys || []);
    const fresh = incoming.filter((key) => !known.has(key));
    if (!fresh.length) return res.status(400).json({ error: 'Cần một key chưa dùng trong job này' });
    const waiter = job.geminiKeyWaiter;
    job.geminiKeyWaiter = null;
    job.waitingForKeys = false;
    waiter.resolve(fresh);
    res.json({ ok: true, added: fresh.length });
});

function openExplorerWindows(dir, filePath) {
    const file = filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? path.resolve(filePath)
        : '';
    const folder = dir && fs.existsSync(dir)
        ? path.resolve(fs.statSync(dir).isDirectory() ? dir : path.dirname(dir))
        : (file ? path.dirname(file) : '');
    if (!folder) throw new Error('Folder not found');

    if (process.platform === 'win32') {
        // Do NOT use `cmd /c start "title" "folder"` — with spaces (SML Death)
        // Windows beeps and does not open. Do NOT windowsHide explorer.
        spawn('explorer.exe', [folder], { stdio: 'ignore' });
        return { dir: folder, file: file || undefined, note: 'opened' };
    }

    spawn('xdg-open', [folder], { stdio: 'ignore' });
    return { dir: folder, file: file || undefined };
}

app.post('/api/open-folder', (req, res) => {
    const wantDownloads = Boolean(req.body?.downloads);
    const fileName = path.basename(String(req.body?.file || '').replace(/[<>:"|?*\u0000-\u001f]/g, ''));
    const directFile = String(req.body?.filePath || '').trim();
    let raw = String(req.body?.path || '').trim() || readSaveDir();
    if (!raw && wantDownloads) raw = path.join(os.homedir(), 'Downloads');

    try {
        if (directFile && fs.existsSync(directFile)) {
            const opened = openExplorerWindows(path.dirname(directFile), directFile);
            return res.json({ ok: true, ...opened });
        }
        if (!raw) return res.status(400).json({ error: 'No folder path' });
        const abs = path.resolve(raw);
        if (!abs || !fs.existsSync(abs)) {
            return res.status(404).json({ error: `Folder not found: ${abs}` });
        }
        const st = fs.statSync(abs);
        const dir = st.isDirectory() ? abs : path.dirname(abs);
        const highlight = fileName ? path.join(dir, fileName) : '';
        const opened = openExplorerWindows(dir, highlight);
        return res.json({ ok: true, ...opened });
    } catch (err) {
        return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

app.get('/api/save-dir', (_req, res) => {
    const p = readSaveDir();
    res.json({ path: p, name: p ? path.basename(p) : '' });
});

// Persistent Gemini key/model store (see server/gemini-secrets.js). Never log
// the values: the response only carries counts.
app.get('/api/gemini-keys', (_req, res) => {
    const stored = geminiSecretStore.read();
    res.json({ accounts: stored.accounts, model: stored.model, file: path.basename(geminiSecretStore.filePath) });
});

app.post('/api/gemini-keys', (req, res) => {
    try {
        const saved = geminiSecretStore.write({ accounts: req.body?.accounts, model: req.body?.model });
        res.json({ ok: true, accounts: saved.accounts.length, model: saved.model });
    } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

app.post('/api/pick-videos', async (_req, res) => {
    if (process.platform !== 'win32') {
        return res.status(400).json({ error: 'File dialog is Windows-only' });
    }
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        "$d.Filter = 'Video (*.mp4;*.mov;*.webm;*.mkv;*.m4v)|*.mp4;*.mov;*.webm;*.mkv;*.avi;*.m4v;*.MP4|All|*.*'",
        '$d.Multiselect = $true',
        "$d.Title = 'GhostForge Edit — pick source videos'",
        '$f = New-Object System.Windows.Forms.Form',
        '$f.TopMost = $true',
        '$f.Opacity = 0',
        '$f.ShowInTaskbar = $false',
        '$f.Show()',
        'Start-Sleep -Milliseconds 200',
        'if ($d.ShowDialog($f) -ne [System.Windows.Forms.DialogResult]::OK) { $f.Close(); exit 1 }',
        '$f.Close()',
        '$d.FileNames | ForEach-Object { [Console]::Out.WriteLine($_) }',
    ].join('; ');
    const r = await runProcess('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        encoding: 'utf8',
        timeout: 180000,
        windowsHide: false,
    });
    const lines = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (r.status !== 0 || !lines.length) {
        return res.status(400).json({ error: 'File pick cancelled' });
    }
    const files = lines.filter((p) => fs.existsSync(p)).map((p) => ({
        name: path.basename(p),
        path: p,
        folder: path.dirname(p),
        size: fs.statSync(p).size,
    }));
    if (!files.length) return res.status(404).json({ error: 'Picked files missing' });
    res.json({ files });
});

app.post('/api/edit/job-local', (req, res) => {
    const localPath = String(req.body?.path || '').trim();
    if (!localPath || !fs.existsSync(localPath)) {
        return res.status(400).json({ error: 'Local video path missing' });
    }
    const st = fs.statSync(localPath);
    if (!st.isFile() || st.size < 100) {
        return res.status(400).json({ error: 'Not a usable video file' });
    }
    const jobId = crypto.randomBytes(16).toString('hex');
    const settings = { ...(req.body || {}) };
    delete settings.path;
    jobs.set(jobId, {
        kind: 'edit',
        inputPath: localPath,
        originalName: path.basename(localPath),
        originalSize: st.size,
        keepInput: true,
        settings,
        status: 'pending',
    });
    res.json({ jobId });
});

app.post('/api/unique/job-local', (req, res) => {
    const localPath = String(req.body?.path || '').trim();
    if (!localPath || !fs.existsSync(localPath)) {
        return res.status(400).json({ error: 'Local video path missing' });
    }
    const st = fs.statSync(localPath);
    if (!st.isFile() || st.size < 100) {
        return res.status(400).json({ error: 'Not a usable video file' });
    }
    const jobId = crypto.randomBytes(16).toString('hex');
    const settings = { ...(req.body || {}) };
    delete settings.path;
    jobs.set(jobId, {
        uniqueRun: true,
        inputPath: localPath,
        originalName: path.basename(localPath),
        originalSize: st.size,
        keepInput: true,
        settings,
        status: 'pending',
    });
    res.json({ jobId });
});

app.get('/api/youtube-import/status', youtubeImport.statusHandler);
app.post('/api/youtube-import', youtubeImport.postHandler);
app.get('/api/youtube-import/stream/:jobId', youtubeImport.streamHandler);
app.post('/api/youtube-import/hold', youtubeImport.holdHandler);
app.post('/api/youtube-import/:jobId/save', youtubeImport.saveHandler);
app.delete('/api/youtube-import/:jobId', youtubeImport.deleteHandler);
app.get('/api/youtube-channels', youtubeChannels.listHandler);
app.post('/api/youtube-channels/scan', youtubeChannels.scanHandler);
app.post('/api/youtube-channels/known', youtubeChannels.knownHandler);
app.post('/api/youtube-channels/:key/folder', youtubeChannels.folderHandler);
app.post('/api/youtube-channels/:key/anchor', youtubeChannels.anchorHandler);
app.post('/api/youtube-channels/:key/concat', youtubeChannels.concatHandler);
app.delete('/api/youtube-channels/:key', youtubeChannels.removeHandler);
app.get('/api/youtube-receipts', youtubeReceipts.listHandler);
app.post('/api/youtube-receipts', youtubeReceipts.noteHandler);
app.post('/api/youtube-receipts/:id/copy', youtubeReceipts.copyHandler);
app.delete('/api/youtube-receipts', youtubeReceipts.clearHandler);
app.delete('/api/youtube-receipts/:id', youtubeReceipts.removeHandler);

app.post('/api/pick-folder', async (req, res) => {
    if (process.platform !== 'win32') {
        return res.status(400).json({ error: 'Folder dialog is Windows-only. Paste a path.' });
    }
    const startAt = String(req.query.start || req.body?.start || readSaveDir() || '').trim();
    const startLine = startAt && fs.existsSync(startAt)
        ? `$d.SelectedPath = '${startAt.replaceAll("'", "''")}'`
        : `$d.RootFolder = [Environment+SpecialFolder]::Desktop`;
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'GhostForge save folder'",
        '$d.ShowNewFolderButton = $true',
        startLine,
        '$f = New-Object System.Windows.Forms.Form',
        '$f.TopMost = $true',
        '$f.Opacity = 0',
        '$f.ShowInTaskbar = $false',
        '$f.Show()',
        'Start-Sleep -Milliseconds 200',
        'if ($d.ShowDialog($f) -ne [System.Windows.Forms.DialogResult]::OK) { $f.Close(); exit 1 }',
        '$f.Close()',
        '[Console]::Out.Write($d.SelectedPath)',
    ].join('; ');
    const r = await runProcess('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        encoding: 'utf8',
        timeout: 180000,
        windowsHide: false,
    });
    const picked = (r.stdout || '').trim();
    if (r.status !== 0 || !picked) {
        return res.status(400).json({ error: 'Folder pick cancelled' });
    }
    if (!fs.existsSync(picked)) return res.status(404).json({ error: 'Picked folder missing' });
    const sticky = String(req.query.sticky || '1') !== '0';
    if (sticky) writeSaveDir(picked);
    res.json({ path: picked, name: path.basename(picked) });
});

app.post('/api/export-copy', (req, res) => {
    const jobId = String(req.body?.jobId || '');
    const job = jobs.get(jobId);
    let outputPath = '';
    let originalName = '';
    if (job?.outputPath && fs.existsSync(job.outputPath)) {
        outputPath = job.outputPath;
        originalName = job.originalName || '';
    } else {
        const held = heldOutputPath(uploadsDir, jobId);
        if (held && fs.existsSync(held)) outputPath = held;
    }
    let destRoot = String(req.body?.path || '').trim() || readSaveDir();
    if (!destRoot || !fs.existsSync(destRoot)) {
        return res.status(400).json({ error: 'Save folder not set' });
    }
    const filename = safeDownloadName(req.body?.name || originalName || 'video.mp4');
    if (!fs.statSync(destRoot).isDirectory()) return res.status(400).json({ error: 'Save path must be a folder' });
    const groupRaw = String(req.body?.groupFolder || '').trim();
    let plannedFolder = '';
    if (groupRaw) {
        const grouped = exportDirForGroup(destRoot, groupRaw);
        if (grouped.error || !grouped.dir) return res.status(400).json({ error: grouped.error || 'Video name is not a folder name' });
        plannedFolder = grouped.dir;
    }
    if (!outputPath) {
        return res.status(404).json({ error: 'Output not found', folder: plannedFolder });
    }
    if (plannedFolder) {
        fs.mkdirSync(plannedFolder, { recursive: true });
        destRoot = plannedFolder;
    }
    const existingDest = String(req.body?.existingDest || '');
    const fileExists = (candidate) => {
        try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); }
        catch { return false; }
    };
    const copyNewFile = (dest) => {
        try {
            fs.copyFileSync(outputPath, dest, fs.constants.COPYFILE_EXCL);
        } catch (err) {
            if (err?.code === 'EEXIST') throw err;
            const locked = err?.code === 'EPERM' || err?.code === 'EACCES' || err?.code === 'EBUSY' || err?.code === 'UNKNOWN';
            if (!locked || fs.existsSync(dest)) throw err;
            fs.copyFileSync(outputPath, dest);
        }
    };
    for (let attempt = 0; attempt < 5; attempt++) {
        const plan = planExportCopy({ destRoot, filename, existingDest, exists: fileExists });
        if (plan.error) return res.status(409).json({ error: plan.error, folder: destRoot });
        if (plan.skip) {
            uniqueHold.forget(jobId);
            editHold.forget(jobId);
            return res.json({ ok: true, skipped: true, dest: plan.dest, folder: destRoot, name: plan.name });
        }
        try {
            copyNewFile(plan.dest);
            uniqueHold.forget(jobId);
            editHold.forget(jobId);
            return res.json({ ok: true, dest: plan.dest, folder: destRoot, name: plan.name });
        } catch (err) {
            if (err && err.code === 'EEXIST') continue;
            const message = err instanceof Error ? err.message : String(err);
            const code = err?.code ? ` (${err.code})` : '';
            return res.status(500).json({ error: `${message}${code}`, folder: destRoot });
        }
    }
    res.status(409).json({ error: 'Too many files with this name', folder: destRoot });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sleepJob = async (ms, job) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (job && job.cancelled) throw new Error('cancelled');
        await sleep(Math.min(400, ms - (Date.now() - t0)));
    }
};

const isQuotaErr = (msg, status) => status === 429 || /resource exhausted|quota|rate.?limit|too many requests/i.test(String(msg || ''));
const isTemporaryGeminiErr = (msg) => /high demand|try again later|unavailable|overloaded|resource exhausted|429|503|500/i.test(String(msg || ''));
// 2026-09-23 batch: fewest overload calls first.
// 3.5-flash-lite had 0. 3.1-flash-lite was never reached, so it is tried next.
// Then 3.5-flash (10), 3.8 (11, 2 plans), 3.6 (11, 2 plans), 3.7 (11, no plan).
const GEMINI_OVERLOAD_TTL_MS = 10 * 60 * 1000;
const geminiOverloads = createOverloadCache({ ttlMs: GEMINI_OVERLOAD_TTL_MS });
const modelKnownOverloaded = (model) => geminiOverloads.isOverloaded(model);
const markModelOverloaded = (model) => geminiOverloads.markOverloaded(model);
const geminiDailyExhaustedModels = new Map();
const geminiKeyId = (apiKey) => crypto.createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 10);
const parseGeminiApiKeys = (settings) => {
    const raw = [];
    const extra = settings?.apiKeys;
    if (Array.isArray(extra)) raw.push(...extra);
    else if (typeof extra === 'string' && extra.trim()) {
        try {
            const parsed = JSON.parse(extra);
            if (Array.isArray(parsed)) raw.push(...parsed);
            else raw.push(...extra.split(/\r?\n/));
        } catch {
            raw.push(...extra.split(/\r?\n/));
        }
    }
    if (settings?.apiKey) raw.push(settings.apiKey);
    const keys = [];
    for (const item of raw) {
        const key = String(item || '').trim();
        if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
};
const forgetGeminiSecrets = (settings) => {
    if (!settings) return;
    settings.apiKey = '';
    settings.apiKeys = '';
};
const videoOverloadModels = (job) => {
    if (!job) return new Set();
    if (!(job.geminiOverloadModels instanceof Set)) job.geminiOverloadModels = new Set();
    return job.geminiOverloadModels;
};
const keyHasDailyRoom = (apiKey, model) => usableDetailKeys(model, [geminiKeyId(apiKey)], geminiDailyExhaustedModels).length > 0;
async function geminiDetailAcrossModels(apiKeys, filePath, userPrompt, duration, minSec, sceneCuts, job, onLog, label, promptOverride = null, preferredModel = null, modelMode = 'safe') {
    const keys = (Array.isArray(apiKeys) ? apiKeys : [apiKeys]).map((key) => String(key || '').trim()).filter(Boolean);
    const detailModels = orderDetailModels(preferredModel, modelMode);
    const cachedBusy = detailModels.filter((model) => modelKnownOverloaded(model));
    if (cachedBusy.length) {
        onLog(`[EDIT] ${label}: bỏ qua model vừa quá tải trong ${Math.round(GEMINI_OVERLOAD_TTL_MS / 60000)} phút qua (${cachedBusy.join(', ')})`);
    }
    const stillExhausted = activeDailyExhausted(geminiDailyExhaustedModels);
    for (const id of [...geminiDailyExhaustedModels.keys()]) {
        if (!stillExhausted.has(id)) geminiDailyExhaustedModels.delete(id);
    }
    const overloaded = videoOverloadModels(job);
    job.geminiKeys = keys;
    while (!job?.cancelled) {
    const uploads = new Map();
    const uploadFor = async (apiKey) => {
        if (uploads.has(apiKey)) return uploads.get(apiKey);
        try {
            const uploaded = await geminiUploadVideo(apiKey, filePath, 'detail-part');
            uploads.set(apiKey, uploaded);
            return uploaded;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (isDailyGeminiRequestQuota(message)) {
                const resetAt = nextGeminiDailyReset();
                const id = geminiKeyId(apiKey);
                for (const model of detailModels) {
                    geminiDailyExhaustedModels.set(dailyQuotaKey(id, model), resetAt);
                }
                job.notify?.('gemini-key-quota', { keyId: id, models: [...detailModels], resetAt });
            }
            throw err;
        }
    };
    let lastErr = null;
    try {
        for (let modelIndex = 0; modelIndex < detailModels.length; modelIndex += 1) {
            const detailModel = detailModels[modelIndex];
            if (overloaded.has(detailModel)) continue;
            if (modelKnownOverloaded(detailModel)) continue;
            for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
                const apiKey = keys[keyIndex];
                if (!keyHasDailyRoom(apiKey, detailModel)) continue;
                const slot = keyIndex + 1;
                onLog(`[EDIT] ${label}: Gemini API (${detailModel}) key ${slot}/${keys.length}`);
                job.notify?.('gemini-key-used', { keyId: geminiKeyId(apiKey) });
                try {
                    const uploaded = await uploadFor(apiKey);
                    const plan = await geminiGeneratePlan(
                        apiKey, detailModel, uploaded.uri, userPrompt, duration, 1, minSec, false, true, true, sceneCuts, 0, promptOverride,
                    );
                    const detailSeg = plan?.segments?.[0];
                    if (!detailSeg?.frames?.length || !detailSeg?.track?.length) {
                        throw new Error('detail PLAN missing framing or speaker track');
                    }
                    plan._modelUsed = detailModel;
                    const billed = recordGeminiUsage(job, detailModel, plan._usage, label);
                    if (billed) {
                        const cost = geminiCallCostVnd(detailModel, billed);
                        onLog(`[EDIT] ${label}: model thật ${detailModel} · ${billed.inputTokens + billed.cachedInputTokens} in (cache ${billed.cachedInputTokens}) · ${billed.outputTokens} out`
                            + (cost == null ? '' : ` · ${formatVnd(cost)}`));
                    }
                    return plan;
                } catch (err) {
                    lastErr = err;
                    const message = err instanceof Error ? err.message : String(err);
                    if (err?.usage) recordGeminiUsage(job, err.modelId || detailModel, err.usage, `${label} (bản lỗi)`);
                    if (job?.cancelled || /cancell/i.test(message)) throw err;
                    // The UI model may exist on Vertex but not on this API key:
                    // step down the ladder instead of failing the whole part.
                    if (/not found|not supported|unsupported|invalid model|does not exist|404/i.test(message)) {
                        const nextModel = detailModels.slice(modelIndex + 1).find((model) => !overloaded.has(model) && !modelKnownOverloaded(model));
                        onLog(nextModel
                            ? `[EDIT] ${label} ${detailModel} không dùng được với key này — hạ xuống ${nextModel}`
                            : `[EDIT] ${label} ${detailModel} không dùng được với key này`);
                        break;
                    }
                    if (/JSON parse failed|did not return JSON|missing framing or speaker track|JSON cut off|MAX_TOKENS/i.test(message)) {
                        const nextModel = detailModels.slice(modelIndex + 1).find((model) => !overloaded.has(model) && !modelKnownOverloaded(model));
                        onLog(nextModel
                            ? `[EDIT] ${label} ${detailModel} tờ JSON không dùng được — hạ xuống ${nextModel}`
                            : `[EDIT] ${label} ${detailModel} tờ JSON không dùng được`);
                        onLog(`[EDIT] ${label} ${message}`.slice(0, 500));
                        break;
                    }
                    if (isDailyGeminiRequestQuota(message)) {
                        const resetAt = nextGeminiDailyReset();
                        geminiDailyExhaustedModels.set(dailyQuotaKey(geminiKeyId(apiKey), detailModel), resetAt);
                        job.notify?.('gemini-key-quota', { keyId: geminiKeyId(apiKey), models: [detailModel], resetAt });
                        const nextKey = keys.slice(keyIndex + 1).find((key) => keyHasDailyRoom(key, detailModel));
                        onLog(nextKey
                            ? `[EDIT] ${label} ${detailModel} key ${slot} hết request ngày — chuyển key ${keys.indexOf(nextKey) + 1}`
                            : `[EDIT] ${label} ${detailModel} key ${slot} hết request ngày — gọi lại sau ${vietnamClockLabel(resetAt)} giờ Việt Nam`);
                        continue;
                    }
                    if (!isTemporaryGeminiErr(message)) throw err;
                    overloaded.add(detailModel);
                    markModelOverloaded(detailModel);
                    const nextModel = detailModels.slice(modelIndex + 1).find((model) => !overloaded.has(model) && !modelKnownOverloaded(model));
                    onLog(nextModel
                        ? `[EDIT] ${label} ${detailModel} quá tải — bỏ qua model này ${Math.round(GEMINI_OVERLOAD_TTL_MS / 60000)} phút, hạ xuống ${nextModel}`
                        : `[EDIT] ${label} ${detailModel} quá tải — bỏ qua model này ${Math.round(GEMINI_OVERLOAD_TTL_MS / 60000)} phút`);
                    break;
                }
            }
        }
        const reason = detailStopReason(
            detailModels,
            keys.map(geminiKeyId),
            geminiDailyExhaustedModels,
            overloaded,
        );
        if (reason === 'daily') {
            onLog(`[EDIT] ${label}: mọi key đã hết request ngày — tạm dừng để dán key mới`);
            throw new GeminiKeysExhaustedError();
        }
        if (reason === 'overload') {
            onLog(`[EDIT] ${label}: model còn lại đều quá tải ở video này — bỏ Detail`);
            throw lastErr || new Error('all remaining Gemini detail models overloaded for this video');
        }
        throw lastErr || new Error('detail models unavailable');
    } catch (err) {
        if (err?.name !== 'GeminiKeysExhaustedError') throw err;
        const added = await waitForMoreGeminiKeys(job, onLog);
        for (const key of added) if (!keys.includes(key)) keys.push(key);
    } finally {
        for (const [apiKey, uploaded] of uploads) {
            await geminiDeleteFile(apiKey, uploaded?.name);
        }
    }
    }
    throw new Error('cancelled');
}

async function waitForMoreGeminiKeys(job, onLog) {
    if (typeof job?.notify !== 'function') throw new GeminiKeysExhaustedError();
    onLog('[EDIT] Tạm dừng: mọi key đã hết request ngày. Dán key mới rồi bấm Tiếp tục.');
    job.waitingForKeys = true;
    job.notify('gemini-keys', { message: 'Mọi key đã hết request ngày' });
    const added = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cancelled')), 12 * 60 * 60 * 1000);
        job.geminiKeyWaiter = {
            resolve: (keys) => { clearTimeout(timer); resolve(keys); },
            reject: (err) => { clearTimeout(timer); reject(err); },
        };
    });
    job.waitingForKeys = false;
    onLog(`[EDIT] Đã nhận ${added.length} key mới — tiếp tục Detail`);
    job.notify('gemini-keys-clear', {});
    return added;
}

let vertexQuotaCooldownUntil = 0;
let vertexPostActive = false;
let vertexCooldownTimer = null;
const vertexPostWaiters = [];

const vertexQuotaWaitMs = (attempt) => Math.min(90, 8 + attempt * attempt * 10) * 1000;

const pumpVertexPostWaiters = () => {
    if (vertexPostActive) return;
    if (vertexQuotaCooldownUntil > Date.now()) {
        const waitSec = Math.ceil((vertexQuotaCooldownUntil - Date.now()) / 1000);
        for (const waiter of vertexPostWaiters) {
            if (waiter.cooldownLogged) continue;
            waiter.cooldownLogged = true;
            waiter.onLog?.(`[EDIT] Shared Vertex cooldown — wait ${waitSec}s…`);
        }
        if (vertexCooldownTimer) clearTimeout(vertexCooldownTimer);
        vertexCooldownTimer = setTimeout(() => {
            vertexCooldownTimer = null;
            pumpVertexPostWaiters();
        }, Math.max(1, vertexQuotaCooldownUntil - Date.now()));
        return;
    }
    while (vertexPostWaiters.length) {
        const waiter = vertexPostWaiters.shift();
        if (waiter.job?.cancelled) {
            waiter.cleanup();
            waiter.reject(new Error('cancelled'));
            continue;
        }
        if (waiter.deadlineAt > 0 && Date.now() >= waiter.deadlineAt) {
            waiter.cleanup();
            waiter.reject(waiter.deadlineError());
            continue;
        }
        vertexPostActive = true;
        waiter.cleanup();
        if (waiter.cooldownLogged) waiter.onLog?.('[EDIT] Shared Vertex cooldown finished — resuming…');
        let released = false;
        waiter.resolve(() => {
            if (released) return;
            released = true;
            vertexPostActive = false;
            pumpVertexPostWaiters();
        });
        return;
    }
};

const acquireVertexPostSlot = (job, onLog, opts = {}) => new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(new Error('cancelled'));
    const deadlineAt = Number(opts.deadlineAt) || 0;
    const deadlineError = typeof opts.deadlineError === 'function'
        ? opts.deadlineError
        : () => new Error('Vertex request deadline reached');
    if (deadlineAt > 0 && Date.now() >= deadlineAt) return reject(deadlineError());
    if (vertexPostActive || vertexPostWaiters.length) onLog?.('[EDIT] Waiting for shared Vertex request slot…');
    let deadlineTimer = null;
    let abortSignal = null;
    const waiter = {
        job,
        deadlineAt,
        deadlineError,
        onLog,
        cooldownLogged: false,
        resolve,
        reject,
        cleanup: () => {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
        },
    };
    const removeWaiter = () => {
        const i = vertexPostWaiters.indexOf(waiter);
        if (i >= 0) vertexPostWaiters.splice(i, 1);
    };
    const onAbort = () => {
        removeWaiter();
        waiter.cleanup();
        reject(new Error('cancelled'));
        pumpVertexPostWaiters();
    };
    if (job) {
        abortSignal = ensureAbort(job).signal;
        abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (deadlineAt > 0) {
        deadlineTimer = setTimeout(() => {
            removeWaiter();
            waiter.cleanup();
            reject(job?.cancelled ? new Error('cancelled') : deadlineError());
            pumpVertexPostWaiters();
        }, Math.max(1, deadlineAt - Date.now()));
    }
    vertexPostWaiters.push(waiter);
    pumpVertexPostWaiters();
});

const waitForVertexCooldown = async (job, onLog, opts = {}) => {
    let logged = false;
    while (vertexQuotaCooldownUntil > Date.now()) {
        if (job?.cancelled) throw new Error('cancelled');
        const deadlineAt = Number(opts.deadlineAt) || 0;
        const deadlineError = typeof opts.deadlineError === 'function'
            ? opts.deadlineError
            : () => new Error('Vertex request deadline reached');
        const cooldownMs = vertexQuotaCooldownUntil - Date.now();
        const deadlineMs = deadlineAt > 0 ? deadlineAt - Date.now() : Infinity;
        if (deadlineMs <= 0) throw deadlineError();
        if (!logged) {
            onLog?.(`[EDIT] Shared Vertex cooldown — wait ${Math.ceil(cooldownMs / 1000)}s…`);
            logged = true;
        }
        await sleepJob(Math.min(cooldownMs, deadlineMs), job);
    }
    if (logged) onLog?.('[EDIT] Shared Vertex cooldown finished — resuming…');
};

const runSerializedVertexPost = async (job, onLog, post, opts = {}) => {
    while (true) {
        await waitForVertexCooldown(job, onLog, opts);
        const release = await acquireVertexPostSlot(job, onLog, opts);
        if (vertexQuotaCooldownUntil > Date.now()) {
            release();
            continue;
        }
        try {
            if (job?.cancelled) throw new Error('cancelled');
            const result = await post();
            if (result?.res?.status === 429) {
                const waitMs = Math.max(0, Number(opts.quotaWaitMs) || 0);
                vertexQuotaCooldownUntil = Math.max(vertexQuotaCooldownUntil, Date.now() + waitMs);
                onLog?.(`[EDIT] Shared Vertex cooldown set ${Math.ceil(waitMs / 1000)}s after HTTP 429`);
            }
            return result;
        } finally {
            release();
        }
    }
};

const waitQuota = async (job, onLog, attempt) => {
    const sec = vertexQuotaWaitMs(attempt) / 1000;
    if (onLog) onLog(`[EDIT] Quota 429 — đợi ${sec}s rồi gọi lại (${attempt}/5). Không bỏ STT.`);
    await sleepJob(sec * 1000, job);
};

const runFf = (args, job, opts = {}) => new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { env: ffmpegEnv, windowsHide: true, cwd: opts.cwd || undefined });
    if (job) noteUniqueChild(job, ff);
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('close', (code) => {
        if (job) job.ffmpeg = null;
        if (job?.cancelled) return reject(new Error('cancelled'));
        if (code === 0) resolve();
        else {
            const error = new Error((err || `ffmpeg exit ${code}`).slice(-500));
            error.ffmpegFirstError = firstMeaningfulFfmpegError(err);
            reject(error);
        }
    });
    ff.on('error', (e) => reject(e));
});

function realesrganHome() {
    const candidates = [
        process.env.GHOSTFORGE_REALESRGAN,
        path.join(__dirname, 'tools', 'realesrgan'),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'realesrgan') : '',
    ].filter(Boolean);
    for (const dir of candidates) {
        const exe = path.join(dir, process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan');
        if (fs.existsSync(exe) && fs.existsSync(path.join(dir, 'models'))) {
            return { exe, models: path.join(dir, 'models'), dir };
        }
    }
    return null;
}

function spawnJobChild(command, args, job, options = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawn(command, args, { windowsHide: true, ...options }); }
        catch (err) { reject(err); return; }
        if (job) noteUniqueChild(job, child);
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (buf) => { if (stdout.length < 8000000) stdout += buf.toString(); });
        child.stderr?.on('data', (buf) => { stderr = (stderr + buf.toString()).slice(-2000); });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (job && job.ffmpeg === child) job.ffmpeg = null;
            if (job?.cancelled) reject(new Error('cancelled'));
            else resolve({ code, stdout, stderr });
        });
    });
}

function runFfTimed(args, job, onSec) {
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args, { env: ffmpegEnv, windowsHide: true });
        if (job) noteUniqueChild(job, ff);
        let err = '';
        ff.stderr.on('data', (d) => {
            const text = d.toString();
            err = (err + text).slice(-2000);
            const mark = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
            if (mark && onSec) onSec(Number(mark[1]) * 3600 + Number(mark[2]) * 60 + Number(mark[3]));
        });
        ff.on('close', (code) => {
            if (job) job.ffmpeg = null;
            if (job?.cancelled) return reject(new Error('cancelled'));
            if (code === 0) resolve();
            else reject(new Error((err || `ffmpeg exit ${code}`).slice(-500)));
        });
        ff.on('error', (e) => reject(e));
    });
}

// A frame that is already full HD stays that size. hqdn3d and cas run in one
// pass. The slow model is only for a smaller frame, or when AI was chosen.
async function runFastSmooth(inputPath, outputPath, job, sendEvent, plan, probe) {
    const vf = smoothFilterGraph(plan.outW, plan.outH);
    const dur = Number(probe.durationSec) || 0;
    sendEvent('log', { message: `[SYS] Làm mịn nhanh: giữ ${plan.outW}x${plan.outH}, không phóng lên 4K. Bộ lọc nhẹ. Unique vẫn thêm hạt nhiễu sau đó.` });
    const nvidia = canOpenEncoder('h264_nvenc', ['-preset', 'p4', '-rc', 'constqp', '-qp', '18', '-pix_fmt', 'nv12']).ok;
    const encoders = [
        ...(nvidia ? [{ args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'constqp', '-qp', '18', '-pix_fmt', 'nv12'] }] : []),
        { args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p'] },
    ];
    const once = async (videoArgs, audioCopy) => {
        const args = ['-y', '-i', inputPath, '-vf', vf, ...videoArgs];
        if (probe.hasAudio) args.push('-c:a', ...(audioCopy ? ['copy'] : ['aac', '-b:a', '128k']));
        else args.push('-an');
        args.push('-movflags', '+faststart', outputPath);
        await runFfTimed(args, job, (sec) => {
            if (dur > 0) sendEvent('progress', { value: Math.min(99, (sec / dur) * 100), phase: 'smooth' });
        });
    };
    let lastErr = null;
    for (let i = 0; i < encoders.length; i++) {
        if (job?.cancelled) throw new Error('cancelled');
        const enc = encoders[i];
        const run = async () => {
            try {
                await once(enc.args, true);
            } catch (err) {
                if (!probe.hasAudio || job?.cancelled) throw err;
                sendEvent('log', { message: '[SYS] Làm mịn: giữ tiếng bằng AAC vì copy không được.' });
                fs.rmSync(outputPath, { force: true });
                await once(enc.args, false);
            }
        };
        try {
            if (i === 0 && nvidia) {
                await withGpuExclusive(job, async (behind) => {
                    if (behind) sendEvent('log', { message: '[SYS] Làm mịn chờ GPU — clip khác đang dùng.' });
                    await run();
                });
            } else {
                await run();
            }
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            if (job?.cancelled || i === encoders.length - 1) throw err;
            sendEvent('log', { message: '[SYS] Làm mịn nhanh: NVENC không chạy, chuyển CPU.' });
            fs.rmSync(outputPath, { force: true });
        }
    }
    if (lastErr) throw lastErr;
    sendEvent('log', { message: `[SYS] Làm mịn xong ${plan.outW}x${plan.outH}.` });
}

// Smooth is a pre-pass. It does not change the Unique filter. The model
// enlarges, then the picture is fitted back to the source size so Unique and
// PGD stay on the same frame they already use. Chunks keep the PNG folders
// bounded. The ncnn process takes the GPU lock; the PNG extract does not.
async function runUniqueSmooth(inputPath, outputPath, job, sendEvent, jobId) {
    const probe = await probeMedia(inputPath);
    if (!probe.width || !probe.height) throw new Error('Không đọc được kích thước video để làm mịn.');
    const mode = job?.settings?.smoothMode === 'ai' ? 'ai' : 'fast';
    const plan = smoothPlan(probe.width, probe.height, mode);
    if (plan.engine === 'filter') {
        await runFastSmooth(inputPath, outputPath, job, sendEvent, plan, probe);
        return;
    }
    const home = realesrganHome();
    if (!home) throw new Error('Không thấy realesrgan-ncnn-vulkan. Cần tools/realesrgan (exe và models).');
    const fps = probe.fps || 30;
    const totalFrames = Math.max(1, Math.round((probe.durationSec || 0) * fps));
    const why = mode === 'ai' ? 'đã chọn AI' : 'khung nhỏ hơn 1080';
    sendEvent('log', { message: `[SYS] Làm mịn AI (${why}): realesr-animevideov3 ×${plan.scale}, rồi trả về ${plan.outW}x${plan.outH}. Mặt người có thể bị vẽ lại. Unique vẫn thêm hạt nhiễu sau đó.` });
    const work = path.join(uploadsDir, `${jobId}_smooth_work`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const pieces = [];
    let produced = 0;
    try {
        for (let chunk = 0; produced < totalFrames; chunk++) {
            if (job?.cancelled) throw new Error('cancelled');
            const startFrame = chunk * SMOOTH_CHUNK_FRAMES;
            if (startFrame >= totalFrames) break;
            const inDir = path.join(work, 'in');
            const outDir = path.join(work, 'out');
            fs.rmSync(inDir, { recursive: true, force: true });
            fs.rmSync(outDir, { recursive: true, force: true });
            fs.mkdirSync(inDir, { recursive: true });
            fs.mkdirSync(outDir, { recursive: true });
            await runFf([
                '-y', '-ss', (startFrame / fps).toFixed(6), '-i', inputPath, '-an',
                '-frames:v', String(Math.min(SMOOTH_CHUNK_FRAMES, totalFrames - startFrame)),
                '-start_number', '0', path.join(inDir, '%08d.png'),
            ], job);
            const names = fs.readdirSync(inDir).filter((name) => name.toLowerCase().endsWith('.png'));
            if (!names.length) break;
            await withGpuExclusive(job, async (behind) => {
                if (behind) sendEvent('log', { message: '[SYS] Làm mịn chờ GPU — clip khác đang dùng.' });
                let lastWritten = -1;
                const timer = setInterval(() => {
                    let written = 0;
                    try {
                        written = fs.readdirSync(outDir).filter((name) => name.toLowerCase().endsWith('.png')).length;
                    } catch { return; }
                    if (written === lastWritten) return;
                    lastWritten = written;
                    sendEvent('progress', { value: smoothFrameProgress(produced + written, totalFrames), phase: 'smooth' });
                }, 400);
                try {
                    const ran = await spawnJobChild(home.exe, [
                        '-i', inDir, '-o', outDir, '-n', 'realesr-animevideov3', '-s', String(plan.scale),
                        '-g', '0', '-m', home.models, '-j', '2:2:2',
                    ], job, { cwd: home.dir });
                    if (ran.code !== 0) throw new Error((ran.stderr || `realesrgan exit ${ran.code}`).trim().slice(-400));
                } finally {
                    clearInterval(timer);
                }
            });
            const piece = path.join(work, `piece_${chunk}.mp4`);
            await runFf([
                '-y', '-framerate', String(fps), '-start_number', '0', '-i', path.join(outDir, '%08d.png'),
                '-vf', `scale=${plan.outW}:${plan.outH}:flags=lanczos,setsar=1`,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-an', piece,
            ], job);
            pieces.push(piece);
            produced += names.length;
            sendEvent('progress', { value: Math.min(99, (produced / totalFrames) * 100), phase: 'smooth' });
            sendEvent('log', { message: `[SYS] Làm mịn ${produced}/${totalFrames} khung` });
            if (names.length < Math.min(SMOOTH_CHUNK_FRAMES, totalFrames - startFrame)) break;
        }
        if (!pieces.length) throw new Error('Làm mịn không ra khung nào.');
        const listFile = path.join(work, 'list.txt');
        fs.writeFileSync(listFile, `${pieces.map((file) => `file '${file.replace(/\\/g, '/')}'`).join('\n')}\n`, 'utf8');
        const videoOnly = path.join(work, 'video.mp4');
        await runFf(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoOnly], job);
        const muxArgs = (copyAudio) => [
            '-y', '-i', videoOnly, '-i', inputPath, '-map', '0:v:0',
            ...(probe.hasAudio ? ['-map', '1:a:0', ...(copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'])] : ['-an']),
            '-c:v', 'copy', '-shortest', '-movflags', '+faststart', outputPath,
        ];
        try {
            await runFf(muxArgs(true), job);
        } catch (err) {
            if (!probe.hasAudio || job?.cancelled) throw err;
            sendEvent('log', { message: '[SYS] Làm mịn: giữ tiếng bằng AAC vì copy không được.' });
            await runFf(muxArgs(false), job);
        }
        sendEvent('log', { message: `[SYS] Làm mịn xong ${plan.outW}x${plan.outH}, ${produced} khung.` });
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

async function runCaptionListen(wavPath, job) {
    const py = process.env.GHOSTFORGE_CAPTION_PYTHON || diarPython();
    const script = path.join(__dirname, 'caption_words.py');
    const ran = await spawnJobChild(py, ['-u', script, wavPath], job, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    if (ran.code !== 0) throw new Error((ran.stderr || ran.stdout || `whisper exit ${ran.code}`).trim().slice(-400));
    const start = ran.stdout.indexOf('{');
    const end = ran.stdout.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('whisper không trả JSON');
    const parsed = JSON.parse(ran.stdout.slice(start, end + 1));
    const words = (Array.isArray(parsed.words) ? parsed.words : []).map((w) => ({
        word: String(w.word || ''),
        start: Number(w.start),
        end: Number(w.end),
    }));
    return {
        language: String(parsed.language || ''),
        probability: Number(parsed.languageProbability) || 0,
        words,
    };
}

// Captions are last. Unique has already changed the speech speed, and PGD has
// already rewritten the picture. The local listen owns the clock. Google only
// replaces a word when the two spellings are the same beat.
async function burnUniqueCaptions(videoPath, job, sendEvent, jobId) {
    if (job?.cancelled) throw new Error('cancelled');
    const probe = await probeMedia(videoPath);
    if (!probe.hasAudio || !(probe.durationSec > 0.3)) {
        sendEvent('log', { message: '[SYS] Phụ đề bỏ qua: file không có tiếng.' });
        return;
    }
    sendEvent('progress', { value: 5, phase: 'caption' });
    sendEvent('log', { message: '[SYS] Phụ đề: nghe local (faster-whisper small, CPU) để lấy ngôn ngữ và nhịp.' });
    const wav = path.join(uploadsDir, `${jobId}_cap.wav`);
    const assPath = path.join(uploadsDir, `${jobId}_cap.ass`);
    const burned = path.join(uploadsDir, `${jobId}_capburn.mp4`);
    try {
        await runFf(['-y', '-i', videoPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], job);
        const heard = await runCaptionListen(wav, job);
        const clock = cleanCaptionClock(heard.words);
        if (!clock.length) {
            sendEvent('log', { message: '[SYS] Phụ đề: không nghe được từ nào. Giữ video không chữ.' });
            return;
        }
        sendEvent('progress', { value: 40, phase: 'caption' });
        sendEvent('log', { message: `[SYS] Phụ đề: nghe ra ${heard.language || '?'} (${(heard.probability || 0).toFixed(2)}), ${clock.length} từ.` });
        let cues = alignCaptionWords(clock, []);
        const lang = googleLanguageCode(heard.language);
        if (lang) {
            try {
                const auth = await getAdcAuth();
                const googleWords = await googleSttWords(
                    auth, videoPath, probe.durationSec, job,
                    (message) => sendEvent('log', { message }),
                    { languageCode: lang, logTag: '[SYS]' },
                );
                const spell = googleWords.map((w) => ({ word: w.word, start: w.t, end: w.end }));
                cues = alignCaptionWords(clock, spell);
                const replaced = cues.filter((cue) => cue.replaced).length;
                sendEvent('log', { message: `[SYS] Phụ đề: Google ${lang} sửa ${replaced} từ. Nhịp vẫn là lần nghe local.` });
            } catch (err) {
                if (job?.cancelled || /cancelled/i.test(err instanceof Error ? err.message : String(err))) throw err;
                sendEvent('log', { message: `[SYS] Phụ đề: Google lỗi, giữ chính tả lần nghe local. ${err instanceof Error ? err.message : String(err)}`.slice(0, 280) });
                cues = alignCaptionWords(clock, []);
            }
        }
        if (!cues.length) {
            sendEvent('log', { message: '[SYS] Phụ đề: không có từ để ghi. Giữ video không chữ.' });
            return;
        }
        sendEvent('progress', { value: 70, phase: 'caption' });
        const anchor = captionAnchor(job?.settings?.captionPlace, probe.height);
        fs.writeFileSync(assPath, buildWordAss({ width: probe.width, height: probe.height, cues, place: job?.settings?.captionPlace }), 'utf8');
        const fonts = process.platform === 'win32' ? 'C:\\Windows\\Fonts' : '';
        await runFf([
            '-y', '-i', videoPath,
            '-vf', ffmpegSubtitlesArg(assPath, fonts),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
            '-c:a', 'copy', '-movflags', '+faststart', burned,
        ], job);
        fs.copyFileSync(burned, videoPath);
        try { fs.unlinkSync(burned); } catch { /* ignore */ }
        sendEvent('progress', { value: 100, phase: 'caption' });
        sendEvent('log', { message: `[SYS] Phụ đề xong: ${cues.length} từ, một từ một lần, ${anchor.label}.` });
    } catch (err) {
        try { if (fs.existsSync(burned)) fs.unlinkSync(burned); } catch { /* ignore */ }
        if (job?.cancelled || /cancelled/i.test(err instanceof Error ? err.message : String(err))) throw err;
        sendEvent('log', { message: `[SYS] Phụ đề không ghi được, giữ video không chữ. ${err instanceof Error ? err.message : String(err)}`.slice(0, 280) });
    } finally {
        try { fs.unlinkSync(wav); } catch { /* ignore */ }
        try { fs.unlinkSync(assPath); } catch { /* ignore */ }
        try { fs.unlinkSync(burned); } catch { /* ignore */ }
    }
}

const editEncoderArgs = (encoder, quality = 20, fast = false) => {
    const q = String(Math.max(0, Math.min(51, Math.round(Number(quality) || 20))));
    if (encoder === 'nvidia') {
        const nvQp = String(Math.min(51, Number(q) + 3));
        return ['-c:v', 'h264_nvenc', '-preset', fast ? 'p3' : 'p4', '-rc', 'constqp', '-qp', nvQp, '-pix_fmt', 'nv12'];
    }
    if (encoder === 'intel') {
        return ['-c:v', 'h264_qsv', '-preset', fast ? 'veryfast' : 'medium', '-global_quality', q, '-pix_fmt', 'nv12'];
    }
    return ['-c:v', 'libx264', '-preset', fast ? 'ultrafast' : 'veryfast', '-crf', q, '-pix_fmt', 'yuv420p', '-threads', '0'];
};

const editEncoderLabel = (encoder) => encoder === 'nvidia'
    ? 'NVIDIA NVENC'
    : encoder === 'intel' ? 'Intel Quick Sync' : 'CPU libx264';

const runEditEncode = async (prefix, suffix, job, quality = 20, fast = false, diagnostics = null, encodeOpts = null) => {
    const selected = job?.editEncoder || 'cpu';
    const attempts = selected === 'cpu' ? ['cpu'] : [selected, 'cpu'];
    let lastError;
    for (const encoder of attempts) {
        const args = [...prefix, ...editEncoderArgs(encoder, quality, fast), ...suffix];
        if (diagnostics) {
            const argsLength = args.map((arg) => String(arg)).join(' ').length;
            job?.editOnLog?.(`[EDIT] FFmpeg graph stats (${editEncoderLabel(encoder)}): hold=${diagnostics.hold} · xExpr=${diagnostics.xExpr} · yExpr=${diagnostics.yExpr} · filter=${diagnostics.filter} · args≈${argsLength}`);
        }
        try {
            await runFf(args, job, encodeOpts || undefined);
            if (job) job.editEncoder = encoder;
            return encoder;
        } catch (error) {
            lastError = error;
            if (diagnostics && error?.ffmpegFirstError) {
                job?.editOnLog?.(`[EDIT] FFmpeg first error (${editEncoderLabel(encoder)}): ${error.ffmpegFirstError}`);
            }
            if (job?.cancelled || encoder === 'cpu') throw error;
            job?.editOnLog?.(`[EDIT] ${editEncoderLabel(encoder)} failed — retry CPU libx264: ${error instanceof Error ? error.message : String(error)}`.slice(0, 280));
        }
    }
    throw lastError || new Error('Edit encode failed');
};

const PGD_LEVELS = {
    light: { eps: 3.5, steps: 3, alpha: 1.2, label: 'nhe', gain: 1, target: 0.965 },
    medium: { eps: 6, steps: 4, alpha: 1.5, label: 'vua', gain: 1, target: 0.95 },
    strong: { eps: 10, steps: 8, alpha: 2.2, label: 'manh', gain: 1, target: 0.93 },
    extreme: { eps: 16, steps: 14, alpha: 2.8, label: 'rat manh', gain: 1, target: 0.88 },
    visible: { eps: 16, steps: 8, alpha: 2.8, label: 'test thay', gain: 12, target: 0.85 },
};

// Which encoder the PGD re-encode should use. PGD itself always runs on the GPU (CUDA);
// this is only the FFmpeg pass that writes the attacked frames back to a file, which used
// to be hardcoded to libx264 crf16 and so ignored the operator's Encoder choice - a 4 s
// 1080x1920 clip came out 1.7 MB -> 6.3 MB. Quality stays high (qp 18) on purpose: the
// PGD perturbation is only a few luma levels and a coarse encode would erase it. The
// chosen encoder is smoke-tested with canOpenEncoder before it is handed to the script and
// anything unexpected falls back to the old x264 crf16 recipe.
const pgdEncoderArgs = (requested) => {
    const wanted = resolveEncoder(requested);
    if (wanted === 'nvidia' && canOpenEncoder('h264_nvenc', ['-preset', 'p5', '-rc', 'constqp', '-qp', '18']).ok) {
        return {
            label: 'NVIDIA NVENC p5 constqp 18 (GPU)',
            args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'constqp', '-qp', '18', '-pix_fmt', 'nv12', '-g', '60'],
        };
    }
    if (wanted === 'intel' && canOpenEncoder('h264_qsv', ['-preset', 'veryfast', '-global_quality', '18']).ok) {
        return {
            label: 'Intel QSV veryfast global_quality 18 (GPU)',
            args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '18', '-pix_fmt', 'nv12', '-g', '60'],
        };
    }
    return {
        label: 'CPU libx264 veryfast crf 16',
        args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p'],
    };
};

// One Python process, one ViT-B-32, many clips. stdout mixes `[PGD]` progress
// lines with JSON replies. Cancel kills this process (the in-flight ffmpeg
// children die with it); the next job starts a fresh one and pays the load again.
const PGD_WORKER_READY_TIMEOUT_MS = 120000;
const pgdWorker = { child: null, ready: false, waiters: [], buffer: '', pending: new Map(), jobsFinished: 0, active: null };
let pgdWorkerSeq = 0;

const failPgdWorker = (reason, expectedChild = null) => {
    const child = pgdWorker.child;
    if (expectedChild && child !== expectedChild) return;
    pgdWorker.child = null;
    pgdWorker.ready = false;
    pgdWorker.jobsFinished = 0;
    pgdWorker.active = null;
    pgdWorker.buffer = '';
    if (child) {
        try { child.kill(); } catch { /* ignore */ }
    }
    for (const [, entry] of pgdWorker.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(reason));
    }
    pgdWorker.pending.clear();
    while (pgdWorker.waiters.length) pgdWorker.waiters.shift()(false);
};

const ensurePgdWorker = () => new Promise((resolve) => {
    const script = path.join(__dirname, 'pgd_server.py');
    if (!fs.existsSync(script)) return resolve(false);
    if (pgdWorker.child && pgdWorker.ready) return resolve(true);
    pgdWorker.waiters.push(resolve);
    if (pgdWorker.child) return;
    let child;
    try {
        child = spawn(pgdPython(), ['-u', script], {
            env: { ...ffmpegEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch {
        pgdWorker.waiters.shift()(false);
        return;
    }
    pgdWorker.child = child;
    pgdWorker.ready = false;
    pgdWorker.buffer = '';
    const readyTimer = setTimeout(() => failPgdWorker('pgd worker ready timeout', child), PGD_WORKER_READY_TIMEOUT_MS);
    const settleReady = (value) => {
        clearTimeout(readyTimer);
        while (pgdWorker.waiters.length) pgdWorker.waiters.shift()(value);
    };
    const takeLine = (line) => {
        if (!line) return;
        let message = null;
        if (line.startsWith('{')) {
            try { message = JSON.parse(line); } catch { message = null; }
        }
        if (message && message.ready) {
            pgdWorker.ready = true;
            settleReady(true);
            return;
        }
        if (message && message.id !== undefined && pgdWorker.pending.has(message.id)) {
            const entry = pgdWorker.pending.get(message.id);
            clearTimeout(entry.timer);
            pgdWorker.pending.delete(message.id);
            if (message.ok) entry.resolve(message);
            else entry.reject(new Error(message.error || 'pgd worker error'));
            return;
        }
        const active = pgdWorker.active;
        if (!active) return;
        active.sendEvent('log', { message: line.slice(0, 300) });
        const pct = line.match(/(\d+)\s*%/);
        if (!pct) return;
        let etaMs = null;
        const frameMatch = line.match(/frame\s+(\d+)\/(\d+)/);
        if (frameMatch) {
            const doneFrames = Number(frameMatch[1]);
            const totalFrames = Number(frameMatch[2]);
            const elapsedSec = Math.max(0.5, (Date.now() - active.started) / 1000);
            const rate = doneFrames / elapsedSec;
            if (rate > 0.001 && totalFrames > doneFrames) etaMs = Math.round(((totalFrames - doneFrames) / rate) * 1000);
        }
        active.sendEvent('progress', {
            value: Math.min(99, Number(pct[1])),
            phase: 'pgd',
            ...(Number.isFinite(etaMs) ? { etaMs } : {}),
        });
    };
    child.stdout.on('data', (data) => {
        pgdWorker.buffer += data.toString();
        let index;
        while ((index = pgdWorker.buffer.indexOf('\n')) >= 0) {
            const line = pgdWorker.buffer.slice(0, index).trim();
            pgdWorker.buffer = pgdWorker.buffer.slice(index + 1);
            takeLine(line);
        }
    });
    child.stderr.on('data', (data) => {
        data.toString().split(/\r?\n/).forEach((line) => takeLine(line.trim()));
    });
    child.on('error', () => {
        settleReady(false);
        failPgdWorker('pgd worker failed to start', child);
    });
    child.on('close', () => failPgdWorker('pgd worker exited', child));
});

const pgdWorkerRequest = (payload, timeoutMs = 0) => new Promise((resolve, reject) => {
    const child = pgdWorker.child;
    if (!child || !child.stdin || !child.stdin.writable) return reject(new Error('no pgd worker'));
    const id = payload.id || `p${++pgdWorkerSeq}`;
    const timer = timeoutMs > 0 ? setTimeout(() => {
        pgdWorker.pending.delete(id);
        reject(new Error('pgd worker request timeout'));
    }, timeoutMs) : null;
    pgdWorker.pending.set(id, { resolve, reject, timer });
    try {
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    } catch (err) {
        if (timer) clearTimeout(timer);
        pgdWorker.pending.delete(id);
        reject(err);
    }
});

const measureClipSimViaPgd = async (inputPath, outputPath) => {
    if (!pgdWorker.child || !pgdWorker.ready) return null;
    const message = await pgdWorkerRequest({ cmd: 'sim', a: inputPath, b: outputPath, frames: 12, ffmpeg: 'ffmpeg' }, 120000);
    return message && Number.isFinite(message.meanClipSim) ? message : null;
};

const runPgdClip = (src, dest, job, sendEvent, jsonOut, level = 'medium') => {
    if (gpuDepth > 0) {
        sendEvent('log', { message: '[PGD] Chờ GPU — một video khác đang chạy PGD. Xếp hàng, không chia card 4 GB.' });
    }
    return withGpuExclusive(job, async () => {
        const lv = PGD_LEVELS[level] || PGD_LEVELS.medium;
        sendEvent('log', { message: `[PGD] level ${lv.label} · eps=${lv.eps}/255 · steps=${lv.steps} · EOT jpeg-hard + sóng dài pool-4 · gain x${lv.gain} · target ${lv.target}${lv.gain >= 8 ? ' · TEST unwatchable' : ''}` });
        await prepareClipWorkerForPgd(sendEvent).catch(() => {});
        const pgdEnc = pgdEncoderArgs(job?.settings?.encoderMode);
        sendEvent('log', { message: `[SYS] PGD encode: ${pgdEnc.label}` });
        const payload = {
            input: src,
            output: dest,
            ffmpeg: 'ffmpeg',
            jsonOut: jsonOut || '',
            eps: lv.eps,
            steps: lv.steps,
            alpha: lv.alpha,
            visibleGain: lv.gain || 1,
            targetSim: lv.target || 0,
            eotViews: 3,
            // Wired 2026-10-01 after measuring them. `bf16` is a straight 1.4-1.5x on the
            // attack loop with the same result, and `frameStep: 2` copies the leader's
            // perturbation to the next frame (-16% wall time for ~0.002 of post-re-encode
            // CLIP). Before this the app kept calling the old float32, every-frame attack
            // even though pgd_clip.py had supported both for hours.
            amp: 'bf16',
            frameStep: 2,
            encArgs: pgdEnc.args,
            encLabel: pgdEnc.label,
        };
        try {
            const ready = await ensurePgdWorker();
            if (!ready) throw new Error('pgd worker unavailable');
            if (job?.cancelled) throw new Error('cancelled');
            sendEvent('log', { message: pgdWorker.jobsFinished > 0
                ? '[PGD] nóng: dùng model đã nạp'
                : '[PGD] nóng: model vừa nạp, job này không nạp lại' });
            pgdWorker.active = { sendEvent, started: Date.now() };
            if (job) noteUniqueChild(job, pgdWorker.child);
            const message = await pgdWorkerRequest(payload);
            if (job && job.ffmpeg === pgdWorker.child) job.ffmpeg = null;
            pgdWorker.active = null;
            pgdWorker.jobsFinished += 1;
            if (job?.cancelled) throw new Error('cancelled');
            const okFile = fs.existsSync(dest) && fs.statSync(dest).size > 1000;
            if (!okFile) throw new Error(message?.error || 'PGD wrote no file');
            return;
        } catch (err) {
            if (job && job.ffmpeg === pgdWorker.child) job.ffmpeg = null;
            pgdWorker.active = null;
            if (job?.cancelled || (err instanceof Error && err.message === 'cancelled')) throw err;
            sendEvent('log', { message: `[PGD] nóng lỗi, chạy một lần rồi thoát: ${err instanceof Error ? err.message : String(err)}`.slice(0, 220) });
            failPgdWorker('replaced by one-shot');
            await runPgdOneShot(src, dest, job, sendEvent, jsonOut, lv, pgdEnc);
        }
    });
};

const runPgdOneShot = (src, dest, job, sendEvent, jsonOut, lv, pgdEnc) => new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'pgd_clip.py');
    if (!fs.existsSync(script)) {
        return reject(new Error('pgd_clip.py missing next to ghostforge-server.js'));
    }
    const py = spawn(pgdPython(), [
        '-u', script,
        '--input', src, '--output', dest, '--ffmpeg', 'ffmpeg',
        '--json-out', jsonOut || '',
        '--eps', String(lv.eps), '--steps', String(lv.steps), '--alpha', String(lv.alpha),
        '--visible-gain', String(lv.gain || 1),
        '--target-sim', String(lv.target || 0),
        // 3 EOT views instead of 4: measured on an 8 s clip with this same pipeline, the
        // decoded output vs source is 0.9196 (3 views) against 0.9228 (4 views) - i.e. not
        // worse - and after a harsh crf 30 re-encode 0.9381 against 0.9408, so robustness is
        // unchanged while the attack stage is ~6% quicker.
        '--eot-views', '3',
        '--enc-args', JSON.stringify(pgdEnc.args),
        '--enc-label', pgdEnc.label,
    ], {
        env: { ...ffmpegEnv, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
    });
    noteUniqueChild(job, py);
    let err = '';
    const pgdStart = Date.now();
    const onChunk = (buf) => {
        const s = buf.toString();
        err = (err + s).slice(-2000);
        s.split(/\r?\n/).forEach((line) => {
            const t = line.trim();
            if (!t) return;
            sendEvent('log', { message: t.slice(0, 300) });
            const pct = t.match(/(\d+)\s*%/);
            if (pct) {
                // pgd_clip.py prints "42% · frame 51/120 · ..." - use the frame counter and
                // the wall clock to estimate the remainder (the attack rate is steady).
                let etaMs = null;
                const frameMatch = t.match(/frame\s+(\d+)\/(\d+)/);
                if (frameMatch) {
                    const doneFrames = Number(frameMatch[1]);
                    const totalFrames = Number(frameMatch[2]);
                    const elapsedSec = Math.max(0.5, (Date.now() - pgdStart) / 1000);
                    const rate = doneFrames / elapsedSec;
                    if (rate > 0.001 && totalFrames > doneFrames) etaMs = Math.round(((totalFrames - doneFrames) / rate) * 1000);
                }
                sendEvent('progress', {
                    value: Math.min(99, Number(pct[1])),
                    phase: 'pgd',
                    ...(Number.isFinite(etaMs) ? { etaMs } : {}),
                });
            }
        });
    };
    py.stdout.on('data', onChunk);
    py.stderr.on('data', onChunk);
    py.on('close', (code) => {
        job.ffmpeg = null;
        if (job.cancelled) return reject(new Error('cancelled'));
        const okFile = fs.existsSync(dest) && fs.statSync(dest).size > 1000;
        if (okFile) resolve();
        else reject(new Error((err || `PGD exit ${code}`).slice(-500)));
    });
    py.on('error', (e) => {
        job.ffmpeg = null;
        reject(e);
    });
});

const padTikTokClip = async (srcPath, destPath, job) => {
    const seamFeather = 48;
    await runEditEncode([
        '-y', '-i', srcPath,
        '-filter_complex',
        `[0:v]split=2[fg][bg];[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,scale=1080:1920[b];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[f];[f]split=2[fa][fm];[fm]scale=2:ih:flags=neighbor,format=gray,geq=lum='255*min(1\\,min(Y\\,H-1-Y)/${seamFeather})'[ft];[ft]scale=1080:ih:flags=bilinear[fk];[fa]format=yuva420p[fA];[fA][fk]alphamerge[fF];[b][fF]overlay=(W-w)/2:(H-h)/2[v]`,
        '-map', '[v]',
        '-map', '0:a?',
    ], [
        '-c:a', 'aac', '-b:a', '160k',
        '-movflags', '+faststart',
        destPath,
    ], job, 20, false);
};

const detectSceneTimes = (inputPath, duration, job) => new Promise((resolve) => {
    const times = [0];
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-i', inputPath,
        '-vf', "select='gt(scene,0.28)',showinfo",
        '-an', '-f', 'null', '-',
    ], { env: ffmpegEnv, windowsHide: true });
    if (job) job.ffmpeg = ff;
    let buf = '';
    ff.stderr.on('data', (d) => {
        buf += d.toString();
        const re = /pts_time:\s*(\d+(?:\.\d+)?)/g;
        let m;
        while ((m = re.exec(buf))) {
            const t = Number(m[1]);
            if (Number.isFinite(t) && t > 0.35) times.push(t);
        }
        if (buf.length > 24000) buf = buf.slice(-5000);
    });
    const finish = () => {
        if (job) job.ffmpeg = null;
        const dur = Number(duration) || 0;
        const uniq = [];
        const sorted = [...new Set(times.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
        for (const t of sorted) {
            if (!uniq.length || t - uniq[uniq.length - 1] >= 1.8) uniq.push(t);
        }
        if (dur && (uniq.length === 0 || uniq[uniq.length - 1] < dur - 0.35)) uniq.push(Math.round(dur * 10) / 10);
        resolve(uniq);
    };
    ff.on('close', finish);
    ff.on('error', () => resolve([0, Number(duration) || 0]));
});

const buildMixWindows = (sceneTimes, duration) => {
    const dur = Math.max(0, Number(duration) || 0);
    const pts = (Array.isArray(sceneTimes) ? sceneTimes : []).filter((t) => Number.isFinite(t) && t >= 0);
    let cuts = [...new Set(pts.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
    if (!cuts.length || cuts[0] > 0.05) cuts.unshift(0);
    if (dur && cuts[cuts.length - 1] < dur - 0.2) cuts.push(Math.round(dur * 10) / 10);
    const raw = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i];
        const b = cuts[i + 1];
        if (b - a < 0.8) continue;
        raw.push({ a, b });
    }
    const merged = [];
    for (const w of raw) {
        const last = merged[merged.length - 1];
        if (last && w.a - last.a < 2.2) last.b = w.b;
        else merged.push({ ...w });
    }
    if (merged.length < 3 && dur >= 8) {
        const step = dur >= 90 ? 5.2 : 4.2;
        const timed = [];
        for (let t = 0, i = 0; t < dur - 0.3; i++, t += step) {
            timed.push({ a: Math.round(t * 10) / 10, b: Math.round(Math.min(dur, t + step) * 10) / 10 });
        }
        if (timed.length) return timed.map((w, i) => ({ ...w, mode: i % 2 === 0 ? 'contain' : 'fill' }));
    }
    return merged.map((w, i) => ({ ...w, mode: i % 2 === 0 ? 'contain' : 'fill' }));
};


const smoothArr = (col, r = 2) => col.map((_, i) => {
    let a = 0;
    let n = 0;
    for (let k = i - r; k <= i + r; k++) {
        if (k >= 0 && k < col.length) { a += col[k]; n += 1; }
    }
    return a / Math.max(1, n);
});

const peaksFromCol = (col) => {
    const gw = col.length;
    if (gw < 8) return [];
    const sm = smoothArr(col, 2);
    const mean = sm.reduce((a, b) => a + b, 0) / gw;
    const raw = [];
    for (let x = 3; x < gw - 3; x++) {
        if (sm[x] >= sm[x - 1] && sm[x] >= sm[x + 1] && sm[x] > mean * 1.12) {
            raw.push({ x: x / (gw - 1), e: sm[x] });
        }
    }
    raw.sort((a, b) => a.x - b.x);
    const merged = [];
    for (const p of raw) {
        const last = merged[merged.length - 1];
        if (last && p.x - last.x < 0.08) {
            if (p.e > last.e) merged[merged.length - 1] = p;
        } else merged.push(p);
    }
    return merged;
};

const grabRgbFrame = (inputPath, t, gw, gh) => new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, t)), '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=' + gw + ':' + gh,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { env: ffmpegEnv, windowsHide: true });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length >= gw * gh * 3 ? buf.subarray(0, gw * gh * 3) : null);
    });
    ff.on('error', () => resolve(null));
});

// One JPEG of a normalised rectangle of a frame, used to ask a vision model
// whether a corner window shows something the main crop does not.
const grabCroppedJpeg = (mediaPath, t, rect, job, width = 320) => new Promise((resolve) => {
    const w = Math.max(32, Math.round(width / 2) * 2);
    const vf = `crop='trunc(iw*${(rect.x1 - rect.x0).toFixed(4)}/2)*2':'trunc(ih*${(rect.y1 - rect.y0).toFixed(4)}/2)*2':`
        + `'trunc(iw*${rect.x0.toFixed(4)})':'trunc(ih*${rect.y0.toFixed(4)})',scale=${w}:-2:flags=fast_bilinear`;
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, Number(t) || 0)), '-i', mediaPath,
        '-map', '0:v:0', '-frames:v', '1', '-an',
        '-vf', vf,
        '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1',
    ], { env: ffmpegEnv, windowsHide: true });
    if (job) job.ffmpeg = ff;
    const chunks = [];
    let settled = false;
    const done = (value) => {
        if (settled) return;
        settled = true;
        if (job) job.ffmpeg = null;
        resolve(value);
    };
    ff.stdout.on('data', (chunk) => chunks.push(chunk));
    ff.on('close', () => {
        const buffer = Buffer.concat(chunks);
        done(buffer.length > 512 ? buffer : null);
    });
    ff.on('error', () => done(null));
});

const extractDetailJpegFrame = (mediaPath, t, job) => new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(new Error('cancelled'));
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, Number(t) || 0)), '-i', mediaPath,
        '-map', '0:v:0', '-frames:v', '1', '-an',
        '-vf', "scale='min(640,iw)':-2:flags=fast_bilinear",
        '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1',
    ], { env: ffmpegEnv, windowsHide: true });
    if (job) job.ffmpeg = ff;
    const chunks = [];
    let stderr = '';
    let settled = false;
    const signal = job ? ensureAbort(job).signal : null;
    const onAbort = () => ff.kill();
    const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        if (job?.ffmpeg === ff) job.ffmpeg = null;
        if (err) reject(err); else resolve(value);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    ff.stdout.on('data', (chunk) => chunks.push(chunk));
    ff.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    ff.on('error', (err) => finish(err));
    ff.on('close', (code) => {
        if (job?.cancelled || signal?.aborted) return finish(new Error('cancelled'));
        const jpeg = Buffer.concat(chunks);
        if (code !== 0 || !jpeg.length) return finish(new Error((stderr || `ffmpeg exit ${code}`).slice(-500)));
        finish(null, jpeg);
    });
});

async function extractDetailEvidenceJpegs(mediaPath, evidenceEvents, job, onLog, minUsable = 12) {
    const frames = [];
    const requested = Array.isArray(evidenceEvents) ? evidenceEvents : [];
    for (const event of requested) {
        if (job?.cancelled) throw new Error('cancelled');
        const t = Number(event?.t);
        if (!Number.isFinite(t) || t < 0) continue;
        try {
            const jpeg = await extractDetailJpegFrame(mediaPath, t, job);
            frames.push({ t, reasons: Array.isArray(event.reasons) ? [...event.reasons] : [], jpeg });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job?.cancelled || /cancell/i.test(message)) throw err;
            onLog?.(`[EDIT] Hybrid evidence JPEG skip @ ${t.toFixed(3)}s: ${message}`.slice(0, 220));
        }
    }
    onLog?.(`[EDIT] Hybrid evidence JPEGs: ${frames.length} usable / ${requested.length} requested`);
    if (frames.length < minUsable) throw new Error(`Hybrid evidence has only ${frames.length}/${requested.length} usable JPEGs (minimum ${minUsable})`);
    return frames;
}

const rgbColScore = (rgb, gw, gh, other, opts = {}) => {
    const col = new Array(gw).fill(0);
    for (let x = 0; x < gw; x++) {
        let ySum = 0;
        let s2 = 0;
        let edge = 0;
        let motion = 0;
        let prevY = 0;
        let screenVotes = 0;
        let puppetVotes = 0;
        let propVotes = 0;
        let faceUpper = 0;
        let weightSum = 0;
        // faceBias: a talking head lives in the top half, so weight those rows
        // higher. Without it the body/suit dominates the column score and the
        // crop settles on a torso with the head clipped.
        const rowWeight = (y) => (opts.faceBias ? (y < gh * 0.55 ? 1.7 : 0.7) : 1);
        for (let y = 0; y < gh; y++) {
            const i = (y * gw + x) * 3;
            const r = rgb[i];
            const g = rgb[i + 1];
            const b = rgb[i + 2];
            const Y = 0.299 * r + 0.587 * g + 0.114 * b;
            const rw = rowWeight(y);
            weightSum += rw;
            ySum += Y * rw;
            s2 += Y * Y * rw;
            if (y) edge += Math.abs(Y - prevY) * rw;
            prevY = Y;
            if (other) {
                const Y2 = 0.299 * other[i] + 0.587 * other[i + 1] + 0.114 * other[i + 2];
                motion += Math.abs(Y - Y2);
            }
            if ((Y > 168 && b > r + 10) || Y > 205) screenVotes += 1;
            const flesh = Y > 40 && Y < 185 && r > 88 && r >= g - 8 && r > b && (r - b) > 12;
            const puppetBlue = Y > 32 && Y < 160 && b > 70 && b > r + 12 && b > g;
            if (flesh || puppetBlue) {
                puppetVotes += 1;
                if (y < gh * 0.62) faceUpper += 1;
            }
            const felt = g > r + 18 && g > b + 12 && Y > 35 && Y < 145;
            const cup = b > r + 22 && b > g + 8 && Y > 35 && Y < 165 && !puppetBlue;
            if (felt || cup) propVotes += 1;
        }
        const weight = weightSum || gh;
        const mean = ySum / weight;
        const appear = Math.max(0, s2 / weight - mean * mean) + edge * 0.35;
        const gate = (mean < 18 || mean > 190) ? 0.06 : (screenVotes > gh * 0.42 ? 0.1 : 1);
        // The puppet/prop weighting was tuned for SML clips. The general-content
        // path asks for `neutral`, which keeps the plain appearance+motion score
        // so a blue shirt, sky or water does not pull the crop.
        const propGate = opts.neutral ? 1 : ((propVotes > gh * 0.38 && puppetVotes < gh * 0.14) ? 0.08 : 1);
        const puppetBoost = opts.neutral ? 1 : (1 + Math.min(1.8, (puppetVotes / gh) * 1.2 + (faceUpper / gh) * 0.8));
        if (opts.motionOut) opts.motionOut[x] = motion / gh;
        col[x] = (appear * 1.05 + motion * 0.18) * gate * propGate * puppetBoost;
    }
    return col;
};

const energySpan = (col) => {
    if (!col.length) return 0;
    const sm = smoothArr(col, 2);
    const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
    const thr = mean * 1.15;
    let a = 0;
    let b = sm.length - 1;
    while (a < b && sm[a] < thr) a += 1;
    while (b > a && sm[b] < thr) b -= 1;
    return (b - a) / Math.max(1, sm.length - 1);
};

const sampleTalkerX = async (inputPath, t, srcW, srcH, opts = {}) => {
    const gw = 96;
    const gh = evenPx(Math.max(36, Math.round(srcH * gw / srcW)));
    const t0 = Math.max(0.05, t);
    const a = await grabRgbFrame(inputPath, t0, gw, gh);
    const b = await grabRgbFrame(inputPath, t0 + 0.2, gw, gh);
    if (!a) return { peaks: [], span: 0, closeup: false, empty: true, crowded: false, meanY: 0, puppetRatio: 0, faceH: 0 };
    const motionCol = [];
    const col = rgbColScore(a, gw, gh, b, { ...opts, motionOut: motionCol });
    const peaks = peaksFromCol(col);
    const span = energySpan(col);
    let ySum = 0;
    let puppetPx = 0;
    const nPx = Math.max(1, a.length / 3);
    for (let i = 0; i < a.length; i += 3) {
        const r = a[i];
        const g = a[i + 1];
        const bb = a[i + 2];
        const Y = 0.299 * r + 0.587 * g + 0.114 * bb;
        ySum += Y;
        const flesh = Y > 40 && Y < 185 && r > 88 && r >= g - 8 && r > bb && (r - bb) > 12;
        const puppetBlue = Y > 32 && Y < 160 && bb > 70 && bb > r + 12 && bb > g;
        const orangeHair = r > 145 && g > 55 && g < 150 && bb < 100 && r > g + 28;
        if (flesh || puppetBlue || orangeHair) puppetPx += 1;
    }
    const meanY = ySum / nPx;
    const puppetRatio = puppetPx / nPx;
    let faceRows = 0;
    for (let y = 0; y < gh; y++) {
        let hit = false;
        for (let x = 0; x < gw; x++) {
            const i = (y * gw + x) * 3;
            const r = a[i];
            const g = a[i + 1];
            const bb = a[i + 2];
            const Y = 0.299 * r + 0.587 * g + 0.114 * bb;
            if (Y > 40 && Y < 185 && r > 88 && r >= g - 8 && r > bb && (r - bb) > 12) { hit = true; break; }
        }
        if (hit) faceRows += 1;
    }
    const faceH = faceRows / Math.max(1, gh);
    const empty = meanY < 22 || (peaks.length === 0 && puppetRatio < 0.03);
    const crowded = peaks.length >= 4;
    const peakGap = peaks.length >= 2 ? Math.abs(peaks[0].x - peaks[1].x) : 0;
    const twoShot = peaks.length >= 2 && peakGap > 0.16;
    const closeup = !twoShot && peaks.length <= 1 && span < 0.34 && faceH > 0.55;
    const motion = opts.withMotion && motionCol.length
        ? motionCol.reduce((sum, value) => sum + value, 0) / motionCol.length
        : undefined;
    return { peaks, span, closeup, empty, crowded, meanY, puppetRatio, faceH, twoShot, motion };
};


const hintCxForWindow = (w, track) => {
    if (Number.isFinite(w.cx)) return w.cx;
    if (!Array.isArray(track) || !track.length) return 0.5;
    const mid = (w.a + w.b) / 2;
    let best = track[0];
    let bd = 99;
    for (const p of track) {
        if (p.t < w.a - 0.4 || p.t > w.b + 0.4) continue;
        const d = Math.abs(p.t - mid);
        if (d < bd) { bd = d; best = p; }
    }
    return Number.isFinite(best?.cx) ? best.cx : 0.5;
};


const hintCxAt = (t, w, track) => {
    if (Number.isFinite(w.cx)) return w.cx;
    if (!Array.isArray(track) || !track.length) return 0.5;
    let best = null;
    let bd = 99;
    for (const p of track) {
        if (p.t < w.a - 0.25 || p.t > w.b + 0.25) continue;
        const d = Math.abs(p.t - t);
        if (d < bd) { bd = d; best = p; }
    }
    if (best && Number.isFinite(best.cx)) return best.cx;
    return hintCxForWindow(w, track);
};

const splitFillOnSpeaker = (windows, track) => {
    if (!Array.isArray(track) || !track.length) return windows;
    const sameSpeaker = (a, b) => {
        const x = String(a || '').toLowerCase().trim();
        const y = String(b || '').toLowerCase().trim();
        return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
    };
    const out = [];
    for (const w of windows) {
        if (w.mode !== 'fill') {
            out.push(w);
            continue;
        }
        const inside = track
            .filter((p) => p.t >= w.a - 0.08 && p.t <= w.b + 0.08)
            .sort((a, b) => a.t - b.t);
        if (inside.length < 2) {
            out.push({ ...w, who: resolveSpeakerWho({ windowWho: w.who }) });
            continue;
        }
        let a0 = w.a;
        const speechWho = resolveSpeakerWho({ windowWho: w.who }) || '';
        let trackWho = resolveSpeakerWho({ trackWho: inside[0].who }) || '';
        let trackCx = inside[0].cx;
        let trackCy = inside[0].cy;
        const pushPiece = (a, b) => out.push({
            a, b, mode: 'fill',
            planMode: w.planMode,
            who: speechWho || trackWho || undefined,
            why: speechWho || trackWho || w.why,
            cx: Number.isFinite(w.cx)
                ? w.cx
                : (!speechWho || sameSpeaker(speechWho, trackWho) ? trackCx : undefined),
            cy: Number.isFinite(w.cy)
                ? w.cy
                : (!speechWho || sameSpeaker(speechWho, trackWho) ? trackCy : undefined),
        });
        for (let i = 1; i < inside.length; i++) {
            const p = inside[i];
            const pWho = resolveSpeakerWho({ trackWho: p.who }) || '';
            const jump = (trackWho && pWho && trackWho.toLowerCase() !== pWho.toLowerCase())
                || (Number.isFinite(trackCx) && Number.isFinite(p.cx) && Math.abs(p.cx - trackCx) > 0.13);
            if (jump && p.t - a0 >= 0.85 && w.b - p.t >= 0.85) {
                pushPiece(a0, p.t);
                a0 = p.t;
                trackWho = pWho || trackWho;
                trackCx = p.cx;
                trackCy = p.cy;
            }
        }
        if (w.b - a0 >= 0.8) pushPiece(a0, w.b);
    }
    return out;
};

const cxForWhoAt = (who, t, track, fallback, window) => {
    const name = String(who || '').toLowerCase().trim();
    if (!name || !Array.isArray(track) || !track.length) return fallback;
    const windowStart = Number(window?.a);
    const windowEnd = Number(window?.b);
    const pts = track.filter((p) => {
        if (!isSpeakerIdentity(p.who)) return false;
        if (!Number.isFinite(p.t)) return false;
        if (Number.isFinite(windowStart) && Number.isFinite(windowEnd)
            && (p.t < windowStart - 0.25 || p.t > windowEnd + 0.25)) return false;
        const w = String(p.who || '').toLowerCase();
        return w && (w === name || w.includes(name) || name.includes(w));
    });
    if (!pts.length) return fallback;
    let best = pts[0];
    let bd = 99;
    for (const p of pts) {
        const d = Math.abs((Number(p.t) || 0) - t);
        if (d < bd) { bd = d; best = p; }
    }
    return bd <= 1.5 && Number.isFinite(best.cx) ? best.cx : fallback;
};

const buildSeatLock = (speech, track) => {
    const samples = {};
    const add = (who, cx) => {
        if (!isSpeakerIdentity(who)) return;
        const k = String(who || '').toLowerCase().trim();
        if (!k) return;
        if (!Number.isFinite(cx)) return;
        if (!samples[k]) samples[k] = [];
        samples[k].push(cx);
    };
    for (const l of speech || []) add(l.who, l.cx);
    for (const p of track || []) add(p.who, p.cx);
    const names = Object.keys(samples);
    const seats = {};
    for (const k of names) {
        const arr = samples[k].slice().sort((a, b) => a - b);
        seats[k] = arr[Math.floor(arr.length / 2)];
    }
    const vals = Object.values(seats);
    if (names.length === 2 && Math.abs(vals[0] - vals[1]) < 0.12) {
        if (seats[names[0]] <= seats[names[1]]) {
            seats[names[0]] = 0.24;
            seats[names[1]] = 0.76;
        } else {
            seats[names[0]] = 0.76;
            seats[names[1]] = 0.24;
        }
    }
    return seats;
};

const seatCx = (who, seats, fallback) => {
    const k = String(who || '').toLowerCase().trim();
    if (k && Number.isFinite(seats[k])) return seats[k];
    return fallback;
};

const snapToPeak = (cx, peaks, maxDist = 0.28) => {
    if (!Number.isFinite(cx) || !peaks || !peaks.length) return cx;
    let best = peaks[0];
    let bd = 99;
    for (const p of peaks) {
        const d = Math.abs(p.x - cx);
        if (d < bd) { bd = d; best = p; }
    }
    return (best && bd <= maxDist) ? best.x : cx;
};

const applySpeechToWindows = (windows, speech, allowPlanContainOverride = false) => {
    if (!Array.isArray(speech) || !speech.length || !windows.length) return windows;
    const forcedWhy = (w) => /cctv|laptop|poster|calendar|already|close-?up|prop|chip|bottle|roulette|empty|black|4\+|crowd/.test(String(w.why || '').toLowerCase());
    const raw = speech
        .filter((l) => l && l.who && (l.end - l.t) >= 0.65)
        .map((l) => ({ a: l.t, b: l.end, who: l.who, cx: l.cx, cy: l.cy }))
        .sort((a, b) => a.a - b.a);
    if (!raw.length) return windows;
    const fills = [];
    for (const f of raw) {
        const last = fills[fills.length - 1];
        if (last && f.a <= last.b + 0.28 && String(last.who).toLowerCase() === String(f.who).toLowerCase()) {
            last.b = Math.max(last.b, f.b);
            if (!Number.isFinite(last.cx) && Number.isFinite(f.cx)) last.cx = f.cx;
        } else fills.push({ ...f });
    }
    const out = [];
    for (const w of windows) {
        if (w.planMode === 'contain' && !allowPlanContainOverride) {
            out.push(w);
            continue;
        }
        if (forcedWhy(w)) {
            out.push(w);
            continue;
        }
        const hits = fills.filter((f) => f.b > w.a + 0.18 && f.a < w.b - 0.18);
        if (!hits.length) {
            out.push(w);
            continue;
        }
        let cursor = w.a;
        for (const f of hits) {
            const a = Math.max(w.a, f.a);
            const b = Math.min(w.b, f.b);
            if (a - cursor >= 0.5) out.push(w.planMode === 'fill'
                ? { ...w, a: cursor, b: a }
                : { a: cursor, b: a, mode: 'contain', why: 'STT gap', planMode: w.planMode });
            if (b - a >= 0.65) {
                out.push({
                    a, b, mode: 'fill', why: f.who, who: f.who,
                    planMode: w.planMode,
                    cx: Number.isFinite(f.cx) ? f.cx : undefined,
                    cy: Number.isFinite(f.cy) ? f.cy : undefined,
                });
            }
            cursor = Math.max(cursor, b);
        }
        if (w.b - cursor >= 0.5) out.push(w.planMode === 'fill'
            ? { ...w, a: cursor, b: w.b }
            : { a: cursor, b: w.b, mode: 'contain', why: 'STT tail', planMode: w.planMode });
    }
    return out.length ? out : windows;
};

const mixFrameClip = async (srcPath, destPath, job, onLog, planned, speakerTrack, speechLines, detailPlan = false, speechFraming = false) => {
    const probe = await probeMedia(srcPath).catch(() => null);
    const dur = Number(probe?.durationSec) || 0;
    const srcW = evenPx(probe?.width || 1920);
    const srcH = evenPx(probe?.height || 1080);
    let windows = Array.isArray(planned) ? planned.filter((w) => w && (w.mode === 'fill' || w.mode === 'contain') && w.b - w.a >= 0.8) : [];
    let how = 'Gemini';
    if (windows.length < 2) {
        const scenes = await detectSceneTimes(srcPath, dur, job);
        windows = buildMixWindows(scenes, dur);
        how = windows.length < 3 ? 'timer fallback' : 'scene fallback';
    } else if (speechFraming) {
        onLog?.('[EDIT] Speech framing: khung Global không khóa contain, STT đổi fill theo người đang nói');
    } else {
        windows = windows.map((w) => ({ ...w, planMode: w.mode }));
    }
    const countWindowModes = (items) => ({
        contain: items.filter((w) => w?.mode === 'contain').length,
        fill: items.filter((w) => w?.mode === 'fill').length,
    });
    const initialModeCounts = countWindowModes(windows);
    const track = Array.isArray(speakerTrack) ? speakerTrack.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.cx)) : [];
    const speech = Array.isArray(speechLines) ? speechLines.filter((l) => l && Number.isFinite(l.t) && l.who) : [];
    const usableSpeechCount = speech.filter((l) => Number.isFinite(l.end) && (l.end - l.t) >= 0.65).length;
    const degenerateDetailRescue = detailPlan
        && initialModeCounts.fill === 0
        && initialModeCounts.contain >= 3
        && usableSpeechCount >= 8
        && windows.every((w) => w.planMode === 'contain');
    const seats = buildSeatLock(speech, track);
    const seatLog = Object.entries(seats).map(([k, v]) => `${k}@${v.toFixed(2)}`).join(' · ');
    if (seatLog) onLog?.(`[EDIT] Speaker map (fallback, đổi theo cảnh): ${seatLog}`);
    for (const l of speech) {
        if (Number.isFinite(l.cx)) continue;
        const s = seatCx(l.who, seats, NaN);
        if (Number.isFinite(s)) l.cx = s;
    }
    if (speech.length && !(detailPlan && !degenerateDetailRescue)) {
        if (degenerateDetailRescue) {
            onLog?.('[EDIT] Degenerate Detail rescue: all-CONTAIN + speech, STT may override non-hard CONTAIN');
        }
        windows = applySpeechToWindows(windows, speech, degenerateDetailRescue);
        how = `${how}+STT`;
        onLog?.(`[EDIT] STT ${speech.length} lines — fill theo vị trí TRONG CẢNH (không khóa ghế)`);
    } else if (detailPlan && (speech.length || track.length)) {
        const before = windows.length;
        windows = balanceDetailWindows(windows, speech, track);
        onLog?.(`[EDIT] Detail balance: ${before} windows → ${windows.length}. Long fill or contain is split.`);
    }
    const postSttModeCounts = countWindowModes(windows);
    windows = (detailPlan && !degenerateDetailRescue) ? windows : splitFillOnSpeaker(windows, track);
    const postSplitModeCounts = countWindowModes(windows);
    const box = { w: evenPx(Math.min(srcW, srcH)), h: evenPx(Math.min(srcW, srcH)) };
    const pts = [];
    let rgbRefineMs = 0;
    let rgbSampleCount = 0;
    const sampleTalkerTimed = async (t) => {
        const startedAt = Date.now();
        try {
            return await sampleTalkerX(srcPath, t, srcW, srcH);
        } finally {
            rgbRefineMs += Date.now() - startedAt;
            rgbSampleCount += 1;
        }
    };
    let demoted = 0;
    const identityDiagnostics = job || {};
    if (!Number.isFinite(identityDiagnostics.editIdentityDiagnosticCount)) identityDiagnostics.editIdentityDiagnosticCount = 0;
    for (const w of windows) {
        if (w.mode !== 'fill') continue;
        if (job?.cancelled) throw new Error('cancelled');
        const tLock = Math.max(0.04, w.a + 0.04);
        const cuts = detailPlan ? trackFillCuts(w, track) : [];
        const aimAt = (t) => {
            let best = null;
            for (const cut of cuts) {
                if (cut.t <= t + 0.2) best = cut;
                else break;
            }
            return best;
        };
        const opening = aimAt(tLock);
        const followTrack = cuts.length > 0;
        const speakerWho = resolveSpeakerWho({ windowWho: w.who, trackWho: opening?.who }) || '';
        const displayLabel = speakerWho || w.why || '';
        const trackCx = Number.isFinite(opening?.cx) ? opening.cx : NaN;
        const nowCx = cxForWhoAt(speakerWho, tLock, track, NaN, w);
        const lineCx = Number.isFinite(w.cx) ? w.cx : NaN;
        const locked = seatCx(speakerWho, seats, NaN);
        const wantCx = [trackCx, nowCx, lineCx, locked].find((v) => Number.isFinite(v));
        const hint = Number.isFinite(wantCx) ? wantCx : hintCxAt(tLock, w, track);
        const snapDist = Number.isFinite(trackCx) ? 0.1 : 0.28;
        const cy = Number.isFinite(w.cy) ? w.cy : 0.40;
        let cx = hint;
        let activeWho = speakerWho;
        let sampled0 = { closeup: false, empty: false, crowded: false, peaks: [], puppetRatio: 1, faceH: 0, twoShot: false };
        try {
            sampled0 = await sampleTalkerTimed(tLock);
            cx = snapToPeak(hint, sampled0.peaks, snapDist);
        } catch { /* keep hint */ }
        const trueEmpty = sampled0.empty && sampled0.puppetRatio < 0.03;
        if (trueEmpty) {
            w.mode = 'contain';
            demoted += 1;
            onLog?.(`[EDIT]   fill→wide ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  (no puppet)`);
            continue;
        }
        const speechContain = speechFraming ? speechFramingContainReason(sampled0) : '';
        if (speechContain) {
            w.mode = 'contain';
            w.why = speechContain;
            w.planMode = 'contain';
            demoted += 1;
            onLog?.(`[EDIT]   fill→wide ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  (${speechContain})`);
            continue;
        }
        if (!speakerWho && !followTrack && sampled0.closeup && !sampled0.twoShot) {
            w.mode = 'contain';
            demoted += 1;
            onLog?.(`[EDIT]   fill→wide ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  (already CU, no STT who)`);
            continue;
        }
        const rawWho = String(w.who || '').trim();
        const rawWhy = String(w.why || '').trim();
        const windowRange = `${Number(w.a).toFixed(1)}-${Number(w.b).toFixed(1)}`;
        if (identityDiagnostics.editIdentityDiagnosticCount < 12 && (rawWho || rawWhy) && rawWho !== rawWhy) {
            onLog?.(`[EDIT] Window identity ${windowRange}: who=${JSON.stringify(rawWho)} why=${JSON.stringify(rawWhy)}`);
            identityDiagnostics.editIdentityDiagnosticCount += 1;
        }
        const whoWordCount = rawWho ? rawWho.split(/\s+/).length : 0;
        if (identityDiagnostics.editIdentityDiagnosticCount < 12 && whoWordCount >= 3 && whoWordCount <= 4 && isSpeakerIdentity(rawWho)) {
            onLog?.(`[EDIT] Speaker identity inspect: who=${JSON.stringify(rawWho)} ${windowRange}`);
            identityDiagnostics.editIdentityDiagnosticCount += 1;
        }
        if (Number.isFinite(wantCx)) cx = snapToPeak(wantCx, sampled0.peaks || [], snapDist);
        w.cx = cx;
        w.cy = cy;
        const origB = w.b;
        const side = cx < 0.5 ? 'LEFT' : 'RIGHT';
        onLog?.(`[EDIT]   FILL ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  ${displayLabel || 'talk'}  ${side} cx ${cx.toFixed(2)}${sampled0.twoShot ? ' two-shot' : ''}`);
        pts.push({ t: Math.max(0, w.a), cx, cy, who: activeWho });
        const sampleTimes = [];
        for (let t = w.a + 0.9; t < origB - 0.55; t += 0.9) sampleTimes.push(t);
        if (followTrack) {
            for (const cut of cuts) {
                if (cut.t > w.a + 0.12 && cut.t < origB - 0.15) sampleTimes.push(cut.t);
            }
        }
        sampleTimes.sort((a, b) => a - b);
        const samples = [];
        for (const t of sampleTimes) {
            const prev = samples[samples.length - 1];
            if (prev != null && Math.abs(prev - t) < 0.08) continue;
            samples.push(t);
        }
        for (const t of samples) {
            try {
                const mid = await sampleTalkerTimed(t);
                if (mid.empty && mid.puppetRatio < 0.03) {
                    w.b = t;
                    if (origB - t >= 0.85) windows.push({ a: t, b: origB, mode: 'contain', why: w.why });
                    onLog?.(`[EDIT]   fill ends ${t.toFixed(1)}s → wide (no puppet)`);
                    break;
                }
                const aimed = followTrack ? aimAt(t) : null;
                const aimedCx = Number.isFinite(aimed?.cx) ? aimed.cx : NaN;
                const now2 = cxForWhoAt(aimed?.who || activeWho, t, track, NaN, w);
                const holdCx = [aimedCx, now2].find((v) => Number.isFinite(v));
                const hold = Number.isFinite(holdCx) ? holdCx : seatCx(activeWho, seats, cx);
                const cx2 = snapToPeak(hold, mid.peaks, Number.isFinite(aimedCx) ? 0.1 : 0.28);
                const nextWho = aimed?.who || activeWho;
                const whoChanged = nextWho && activeWho && nextWho.toLowerCase() !== activeWho.toLowerCase();
                const moved = Math.abs(cx2 - cx) > (Number.isFinite(aimedCx) ? 0.1 : 0.18);
                if (whoChanged || moved) {
                    pts.push({ t: Math.max(w.a + 0.03, t - 0.03), cx, cy, who: activeWho });
                    cx = cx2;
                    activeWho = nextWho || activeWho;
                    w.cx = cx2;
                    pts.push({ t, cx: cx2, cy, who: activeWho });
                    const whoNote = activeWho ? ` · ${activeWho}` : '';
                    onLog?.(`[EDIT]   CUT ${t.toFixed(1)}s → ${cx2 < 0.5 ? 'LEFT' : 'RIGHT'} ${cx2.toFixed(2)}${whoNote}`);
                }
            } catch { /* keep */ }
        }
        pts.push({ t: Math.max(w.a + 0.03, w.b), cx, cy, who: activeWho });
    }
    let forceProtected = 0;
    let forceEligible = 0;
    let forceFilled = 0;
    {
        const fillSec = windows.filter((w) => w.mode === 'fill').reduce((s, w) => s + (w.b - w.a), 0);
        if (speech.length && fillSec < dur * 0.28) {
            onLog?.(`[EDIT] Fill only ${fillSec.toFixed(0)}s — force STT talk windows back to fill`);
            for (const w of windows) {
                if (w.mode === 'fill') continue;
                if (w.planMode === 'contain') {
                    forceProtected += 1;
                    continue;
                }
                forceEligible += 1;
                const hit = speech.some((l) => l.end > w.a + 0.3 && l.t < w.b - 0.3);
                if (!hit || w.b - w.a < 0.8) continue;
                try {
                    const s = await sampleTalkerTimed((w.a + w.b) / 2);
                    if (s.empty && s.puppetRatio < 0.03) continue;
                    if (s.closeup && !s.twoShot) continue;
                    if (speechFraming && speechFramingContainReason(s)) {
                        forceProtected += 1;
                        continue;
                    }
                } catch { continue; }
                const line = speech.find((l) => l.end > w.a + 0.2 && l.t < w.b - 0.2);
                w.mode = 'fill';
                forceFilled += 1;
                w.who = resolveSpeakerWho({ windowWho: line?.who });
                w.why = w.who || w.why;
                w.cx = Number.isFinite(line?.cx) ? line.cx : w.cx;
                onLog?.(`[EDIT]   FORCE FILL ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  ${w.who || ''}`);
                const cx = Number.isFinite(w.cx) ? w.cx : 0.5;
                const cy = Number.isFinite(w.cy) ? w.cy : 0.40;
                pts.push({ t: w.a, cx, cy, who: w.who || '' });
                pts.push({ t: w.b, cx, cy, who: w.who || '' });
            }
        }
    }
    onLog?.(`[EDIT] Mix framing stages: initial contain=${initialModeCounts.contain} fill=${initialModeCounts.fill} · post-STT contain=${postSttModeCounts.contain} fill=${postSttModeCounts.fill} · post-split contain=${postSplitModeCounts.contain} fill=${postSplitModeCounts.fill} · RGB-demoted=${demoted} · force protected=${forceProtected} eligible=${forceEligible} forced=${forceFilled}`);
    if (rgbSampleCount) onLog?.(`[EDIT TIMING] RGB/frame refinement: ${(rgbRefineMs / 1000).toFixed(2)}s`);
    onLog?.(`[EDIT] Mix rules: STT talk = FILL on speaker (two-shot punch-in)`);
    const containWins = windows.filter((w) => w.mode === 'contain');
    const fillWins = windows.filter((w) => w.mode === 'fill');
    const aimed = windows.filter((w) => Number.isFinite(w.cx)).length;
    onLog?.(`[EDIT] Mixed 9:16 ${how}: ${containWins.length} wide · ${fillWins.length} close · speaker ${aimed} · already-CU demoted ${demoted} · SNAP on talk (no lerp)`);
    windows.slice(0, 16).forEach((w) => {
        const aim = Number.isFinite(w.cx) ? ` @${Number(w.cx).toFixed(2)}` : '';
        onLog?.(`[EDIT]   ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  ${w.mode}${aim}${w.why ? ` · ${w.why}` : ''}`);
    });
    const esc = (n) => Number(n).toFixed(2);
    // Cross-fade between the contain and fill layers instead of switching them on/off in
    // one frame. The window math is unchanged; only the opacity ramps over CROSSFADE.
    const CROSSFADE = 0.25;
    // geq has no lowercase `t`; the timestamp variable is `T`.
    const rampTerm = (w) => `clip((T-(${esc(w.a)}-${CROSSFADE}))/${CROSSFADE}\\,0\\,1)*clip((${esc(w.b)}+${CROSSFADE}-T)/${CROSSFADE}\\,0\\,1)`;
    const crossFade = containWins.length > 0 && fillWins.length > 0;
    const containWeight = crossFade
        ? containWins.map(rampTerm).reduce((acc, term) => (acc ? `max(${acc}\\,${term})` : term), '')
        : '';
    let enableContain = '0';
    if (containWins.length && fillWins.length) {
        enableContain = containWins.map((w) => `between(t\\,${esc(w.a)}\\,${esc(w.b)})`).join('+');
    } else if (containWins.length) {
        enableContain = '1';
    }
    const locked = snapSpeakerTrack(pts.length ? pts : [{ t: 0, cx: 0.5, cy: 0.42 }]);
    if (locked[0].t > 0.04) locked.unshift({ t: 0, cx: locked[0].cx, cy: locked[0].cy, who: locked[0].who });
    onLog?.(`[EDIT] Fill SNAP ${locked.length} hold-pts (cut to speaker, no pan)`);
    const xExpr = ffmpegHoldSnapExpr(locked, 'x', srcW, srcH, box.w, box.h);
    const yExpr = ffmpegHoldSnapExpr(locked, 'y', srcW, srcH, box.w, box.h);
    const fillCrop = `crop=${box.w}:${box.h}:x=${xExpr}:y=${yExpr},scale=1080:1080:flags=lanczos,setsar=1`;
    onLog?.(`[EDIT] Fill 1:1 ${box.w}x${box.h} on ${srcW}x${srcH} → 1080×1080 in 9:16 (medium, not face-fill)`);
    // Soften the top/bottom edge of the picture layer so the bar behind it does not read
    // as a hard cut. This touches ONLY how the layer edge is drawn: which layer is shown
    // and when is still the untouched `enable=` switch below, and the crop/size/position
    // of both layers are unchanged. The mask is built on a 2px-wide canvas and scaled up,
    // which keeps geq cheap.
    const seamFeather = 48;
    const featherEdges = (input, name) => `${input}split=2[${name}a][${name}m];`
        + `[${name}m]scale=2:ih:flags=neighbor,format=gray,geq=lum='255*min(1\\,min(Y\\,H-1-Y)/${seamFeather})'[${name}t];`
        + `[${name}t]scale=1080:ih:flags=bilinear[${name}k];`
        + `[${name}a]format=yuva420p[${name}A];`
        + `[${name}A][${name}k]alphamerge[${name}F];`;
    const fc = [
        crossFade ? '[0:v]split=4[bg][fg][fs][ms]' : '[0:v]split=3[bg][fg][fs]',
        '[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=14,scale=1080:1920,split=2[b1][b2]',
        '[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fit]',
        featherEdges('[fit]', 'fit').replace(/;$/, ''),
        '[b1][fitF]overlay=(W-w)/2:(H-h)/2[contain]',
        `[fs]${fillCrop}[sq]`,
        featherEdges('[sq]', 'sq').replace(/;$/, ''),
        '[b2][sqF]overlay=(W-w)/2:(H-h)/2[fill]',
        crossFade
            ? `[ms]scale=2:2:flags=neighbor,format=gray,geq=lum='255*min(1\\,${containWeight})'[mt];`
                + `[mt]scale=1080:1920:flags=bilinear[cmask];`
                + `[contain]format=yuva420p[cA];[cA][cmask]alphamerge[cF];`
                + `[fill][cF]overlay=0:0[v]`
            : (containWins.length ? '[contain]copy[v]' : '[fill]copy[v]'),
    ].join(';');
    onLog?.(`[EDIT] Seam soft: ${seamFeather}px feather on the contain and fill layer edges (contain/fill timing unchanged)`
        + (crossFade ? ` · contain<->fill cross-fade ${CROSSFADE}s` : ''));
    const finalRenderStartedAt = Date.now();
    try {
        await runEditEncode([
            '-y', '-i', srcPath,
            '-filter_complex', fc,
            '-map', '[v]',
            '-map', '0:a?',
        ], [
            '-c:a', 'aac', '-b:a', '160k',
            '-movflags', '+faststart',
            destPath,
        ], job, 20, false, {
            hold: locked.length,
            xExpr: xExpr.length,
            yExpr: yExpr.length,
            filter: fc.length,
        });
    } finally {
        onLog?.(`[EDIT TIMING] final FFmpeg render: ${((Date.now() - finalRenderStartedAt) / 1000).toFixed(2)}s`);
    }
};

// Focus composition for the general-content Edit path (framingStyle=focus).
// The canvas stays 1080×1920. A focus window is a 3:4 crop on a blurred copy of
// the frame. A window may additionally ask for a corner window (pip) or a
// top/bottom split; those layers still cover the whole canvas. Window modes
// come from the plan; speech/STT only supplies who/where.
// Faces, people and portrait panels for one already-cut focus part. Empty when
// the diar Python or the scan script is missing: the plan is rendered as-is.
const scanLocalLayout = async (srcPath, dur, job, onLog) => {
    const python = diarPython();
    const helper = path.join(__dirname, 'local_layout_scan.py');
    if (!fs.existsSync(python) || !fs.existsSync(helper)) return [];
    const started = Date.now();
    const timeoutMs = Math.min(300000, Math.max(90000, Math.round(Number(dur) * 1500)));
    const stdout = await new Promise((resolve, reject) => {
        const child = spawn(python, [helper, srcPath, '0', String(dur), '2'], {
            windowsHide: true,
            cwd: __dirname,
            env: process.env,
        });
        if (job) job.ffmpeg = child;
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            reject(new Error('local layout timeout'));
        }, timeoutMs);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (job) job.ffmpeg = null;
            if (job?.cancelled) return reject(new Error('cancelled'));
            if (code !== 0) return reject(new Error((err || `layout scan exit ${code}`).trim().slice(-400)));
            resolve(out);
        });
    });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    onLog?.(`[EDIT] Quét khung local ${((Date.now() - started) / 1000).toFixed(1)}s · ${parsed.length} mẫu`);
    return parsed;
};

const composeFocusClip = async (srcPath, destPath, job, onLog, planned, speakerTrack, speechLines, criticOptions = null) => {
    const criticApiKey = String(criticOptions?.apiKey || '').trim();
    const criticAuth = criticOptions?.auth || null;
    const criticModel = String(criticOptions?.model || 'gemini-3.8-flash');
    const probe = await probeMedia(srcPath).catch(() => null);
    const dur = Number(probe?.durationSec) || 0;
    const srcW = evenPx(probe?.width || 1920);
    const srcH = evenPx(probe?.height || 1080);
    const plannedWindows = (Array.isArray(planned) ? planned : [])
        .filter((w) => w && Number(w.b) > Number(w.a))
        .map((w) => ({
            a: Math.max(0, Number(w.a)),
            b: dur > 0 ? Math.min(dur, Number(w.b)) : Number(w.b),
            // The corner window is retired: anything the plan calls pip is
            // rendered as the top/bottom split.
            mode: (w.mode === 'pip' ? 'split' : (FRAME_MODES.has(w.mode) ? w.mode : '')),
            cx: Number.isFinite(Number(w.cx)) ? Number(w.cx) : undefined,
            cy: Number.isFinite(Number(w.cy)) ? Number(w.cy) : undefined,
            cx2: Number.isFinite(Number(w.cx2)) ? Number(w.cx2) : undefined,
            cy2: Number.isFinite(Number(w.cy2)) ? Number(w.cy2) : undefined,
            who: w.who ? String(w.who) : '',
            why: w.why ? String(w.why) : '',
        }))
        .sort((a, b) => a.a - b.a);
    const focusPlanned = plannedWindows.filter((w) => w.mode === 'focus' || w.mode === 'pip' || w.mode === 'split');
    // An SML plan (contain/fill, e.g. the short TEST watch) is still rendered
    // here: keep its cx/cy aiming but drop the mode, because this renderer never
    // draws a letterbox.
    const source = focusPlanned.length ? focusPlanned : plannedWindows.map((w) => ({ ...w, mode: 'focus' }));
    let layoutSource = source;
    let layoutAims = [];
    if (process.env.GHOSTFORGE_LOCAL_LAYOUT !== '0' && dur >= 3 && srcPath) {
        try {
            const samples = await scanLocalLayout(srcPath, dur, job, onLog);
            if (samples.length) {
                const laid = applyFocusLayout(source, samples);
                if (laid.windows.length) layoutSource = laid.windows;
                layoutAims = laid.aims;
                const splits = layoutSource.filter((w) => w.mode === 'split').length;
                onLog?.(`[EDIT] Khung local: ${samples.length} mẫu · ${splits} chia đôi · ${layoutAims.length} điểm căn`);
            }
        } catch (layoutErr) {
            if (job?.cancelled || /cancell/i.test(String(layoutErr instanceof Error ? layoutErr.message : layoutErr))) throw layoutErr;
            const message = layoutErr instanceof Error ? layoutErr.message : String(layoutErr);
            onLog?.(`[EDIT] Khung local bỏ qua: ${message}`);
        }
    }
    const how = focusPlanned.length
        ? 'PLAN focus'
        : (plannedWindows.length ? 'PLAN contain/fill → focus' : 'no framing plan');
    let windows = [];
    let cursor = 0;
    for (const w of layoutSource) {
        const a = Math.max(0, Math.min(dur || w.b, w.a));
        const b = Math.max(a, Math.min(dur || w.b, w.b));
        if (b - a < 0.8) continue;
        if (a > cursor + 0.05) {
            // A hole keeps the previous aim. Copying the NEXT window's cx
            // pulled the crop onto the following subject too early.
            windows.push({ a: cursor, b: a, mode: 'focus', why: 'gap → focus' });
        }
        windows.push({ ...w, a, b });
        cursor = Math.max(cursor, b);
    }
    if (dur > 0 && cursor < dur - 0.05) {
        windows.push({ a: cursor, b: dur, mode: 'focus', why: 'tail → focus' });
    }
    if (!windows.length) windows = [{ a: 0, b: Math.max(0.1, dur), mode: 'focus', why: 'no framing plan' }];
    for (const w of windows) {
        if ((w.mode === 'pip' || w.mode === 'split') && !Number.isFinite(w.cx2)) {
            w.mode = 'focus';
            w.why = `${w.why} (thiếu toạ độ sự kiện phụ → focus)`.trim();
        }
    }

    // Gate 1 - geometry: a second camera that sits INSIDE the main crop repeats
    // the same picture. Measured on a talking-head clip: camera 2 sat 0.2 away and
    // 40 % of the inset was still the main subject, so the popup added nothing.
    const gateSplitBox = splitCameraBox(srcW, srcH);
    const splitHalfX = (gateSplitBox.w / 2) / srcW;
    const splitHalfY = (gateSplitBox.h / 2) / srcH;
    let gateDropped = 0;
    for (const w of windows) {
        if (w.mode !== 'pip' && w.mode !== 'split') continue;
        if (!Number.isFinite(w.cx) || !Number.isFinite(w.cx2)) continue;
        const share = splitHalvesOverlap(srcW, srcH, w.cx, w.cx2);
        if (share > 0.35) {
            w.mode = 'focus';
            w.why = `${w.why} (chia đôi trùng khung chính ${Math.round(share * 100)}% → focus)`.trim();
            gateDropped += 1;
        }
    }
    if (gateDropped) {
        onLog?.(`[EDIT] Bỏ ${gateDropped} cửa sổ phụ vì nằm trong khung chính (không thêm thông tin)`);
    }

    // Gate 2 - look-alike: even when the boxes only partly overlap, a corner
    // window that LOOKS like the main crop is useless. Compare the two regions on
    // one frame per surviving popup (one ffmpeg grab each).
    // Only top/bottom splits remain; the corner window is gone.
    const popupWindows = windows.filter((w) => w.mode === 'split');
    for (const w of popupWindows) {
        if (job?.cancelled) break;
        try {
            const gw = 96;
            const gh = evenPx(Math.max(36, Math.round(gw * srcH / srcW)));
            const rgb = await grabRgbFrame(srcPath, (w.a + w.b) / 2, gw, gh);
            if (!rgb) continue;
            const cy2 = Number.isFinite(w.cy2) ? w.cy2 : 0.5;
            const mainCy = Number.isFinite(w.cy) ? w.cy : 0.42;
            const similarity = frameRegionSimilarity(rgb, gw, gh,
                { x0: w.cx - splitHalfX, x1: w.cx + splitHalfX, y0: mainCy - splitHalfY, y1: mainCy + splitHalfY },
                { x0: w.cx2 - splitHalfX, x1: w.cx2 + splitHalfX, y0: cy2 - splitHalfY, y1: cy2 + splitHalfY });
            // Two bowls of the same food score about 0.91. Two people on one
            // orange wall scored 0.86, and two arms on one wooden table look
            // alike the same way. Each half is still a different subject, so
            // those three classes skip this drop. Phones, side pairs and ink
            // drawings stay on the 0.85 gate. The overlap gate above still applies.
            if (similarity > 0.85 && !keepsLookAlikeSplit(w.why)) {
                w.mode = 'focus';
                w.why = `${w.why} (chia đôi giống khung chính ${Math.round(similarity * 100)}% → focus)`.trim();
                onLog?.(`[EDIT] Bỏ chia đôi ${w.a.toFixed(1)}–${w.b.toFixed(1)}s: giống khung chính ${Math.round(similarity * 100)}%`);
                continue;
            }
            // The plan often gives x2 but no y2, so the inset aimed at the middle
            // of the frame (measured: it landed on the ad's price tag). Aim it at
            // the most detailed spot inside the region instead; if the region has
            // nothing to look at, drop the popup.
            if (!Number.isFinite(w.cy2)) {
                const peak = frameRegionPeak(rgb, gw, gh, { x0: w.cx2 - splitHalfX, x1: w.cx2 + splitHalfX, y0: cy2 - splitHalfY, y1: cy2 + splitHalfY });
                if (peak.score < 12) {
                    w.mode = 'focus';
                    w.why = `${w.why} (nửa dưới ít chi tiết → focus)`.trim();
                    onLog?.(`[EDIT] Bỏ chia đôi ${w.a.toFixed(1)}–${w.b.toFixed(1)}s: nửa dưới ít chi tiết`);
                    continue;
                }
                w.cx2 = Math.max(0.05, Math.min(0.95, peak.x));
                w.cy2 = Math.max(0.05, Math.min(0.95, peak.y));
                onLog?.(`[EDIT] Chia đôi ${w.a.toFixed(1)}–${w.b.toFixed(1)}s: tự nhắm vào điểm chi tiết mạnh nhất (${w.cx2.toFixed(2)}, ${w.cy2.toFixed(2)})`);
            }
            // A detector split already names two different subjects from local
            // boxes. The vision review is a paid call and has dropped real ads
            // before, so it does not get another vote on these windows. The
            // overlap gate and the look-alike check above still apply.
            if (String(w.why || '').startsWith('detector:')) {
                onLog?.(`[EDIT] Giữ chia đôi ${w.a.toFixed(1)}–${w.b.toFixed(1)}s theo detector local`);
                continue;
            }
            // The last check is the one the local maths cannot do: a popup can be
            // a different-looking region that still shows the SAME person (the ad
            // clip features the same host). Ask a vision model; drop when it adds
            // nothing.
            const secCy = Number.isFinite(w.cy2) ? w.cy2 : 0.5;
            const keepPopup = await reviewFocusPopup({
                srcPath,
                t: (Number(w.a) + Number(w.b)) / 2,
                mainRect: { x0: w.cx - splitHalfX, x1: w.cx + splitHalfX, y0: mainCy - splitHalfY, y1: mainCy + splitHalfY },
                secRect: { x0: w.cx2 - splitHalfX, x1: w.cx2 + splitHalfX, y0: secCy - splitHalfY, y1: secCy + splitHalfY },
                job,
                onLog,
                apiKey: criticApiKey,
                auth: criticAuth,
                model: criticModel,
            });
            if (!keepPopup) {
                w.mode = 'focus';
                w.why = `${w.why} (chia đôi không thêm thông tin → focus)`.trim();
            }
        } catch { /* keep the window if the frame cannot be read */ }
    }

    // A detector aim is the person actually in the frame. A model point within
    // 1.6 s of one (the plan often repeats cx 0.5) would yank the crop off them.
    const aimed = layoutAims.filter((p) => Number.isFinite(Number(p?.t)));
    const track = [
        ...(Array.isArray(speakerTrack) ? speakerTrack : []).filter((p) => {
            const t = Number(p?.t);
            return !aimed.some((aim) => Math.abs(Number(aim.t) - t) < 1.6);
        }),
        ...layoutAims,
    ].filter((p) => p && Number.isFinite(Number(p.t)) && Number.isFinite(Number(p.cx)));
    const speech = (Array.isArray(speechLines) ? speechLines : [])
        .filter((l) => l && Number.isFinite(Number(l.t)) && Number.isFinite(Number(l.cx)));
    const pts = [];
    for (const p of track) {
        pts.push({
            t: Math.max(0, Math.min(dur || Number(p.t), Number(p.t))),
            cx: Number(p.cx),
            cy: Number.isFinite(Number(p.cy)) ? Number(p.cy) : 0.42,
            who: String(p.who || ''),
            from: 'track',
        });
    }
    for (const l of speech) {
        pts.push({
            t: Math.max(0, Math.min(dur || Number(l.t), Number(l.t))),
            cx: Number(l.cx),
            cy: Number.isFinite(Number(l.cy)) ? Number(l.cy) : 0.42,
            who: String(l.who || ''),
            from: 'speech',
        });
    }
    pts.sort((a, b) => a.t - b.t);
    const mainPts = [];
    for (const p of pts) {
        const last = mainPts[mainPts.length - 1];
        if (last && Math.abs(last.t - p.t) < 0.15) {
            // A speech line names the speaker. It must not replace the visual
            // aim sitting on the same moment: that swap is what jerked the crop
            // off the face onto a guessed column.
            mainPts[mainPts.length - 1] = (last.from === 'track' && p.from !== 'track') ? last : p;
            continue;
        }
        mainPts.push(p);
    }
    // The frame's own cx is the layout decision. A sparse or empty track used
    // to ignore it, so the crop sat at the centre ("không focus") while the
    // plan had already named the subject.
    for (const w of windows) {
        if (w.mode !== 'focus' || !Number.isFinite(w.cx)) continue;
        const opened = mainPts.some((p) => p.t >= w.a - 0.2 && p.t <= w.a + 0.5 && Math.abs(p.cx - w.cx) <= 0.15);
        if (opened) continue;
        mainPts.push({
            t: w.a,
            cx: w.cx,
            cy: Number.isFinite(w.cy) ? w.cy : 0.42,
            who: String(w.who || ''),
            from: 'frame',
        });
    }
    mainPts.sort((a, b) => a.t - b.t);
    if (!mainPts.length) mainPts.push({ t: 0, cx: 0.5, cy: 0.42, who: '' });
    if (mainPts[0].t > 0.04) mainPts.unshift({ ...mainPts[0], t: 0 });

    // A top/bottom split drives TWO fixed cameras, one per subject. The plan only
    // anchors the opening moment of such a window, so interpolating from that
    // anchor to the next one slid camera 1 back to the other subject: on the
    // 4-10 s "phone ad" window the aim moved 0.15 -> 0.5 and BOTH halves ended up
    // framing the host (reported from a finished clip, 2026-10-03). Inside a
    // split/pip window the main camera therefore holds the window's own cx, and
    // any sparse anchor strictly inside it is dropped instead of interpolated.
    const twoCamWindows = windows.filter((w) => (w.mode === 'split' || w.mode === 'pip') && Number(w.b) > Number(w.a));
    if (twoCamWindows.length) {
        const inTwoCam = (t) => twoCamWindows.some((w) => t >= w.a && t <= w.b);
        const held = mainPts.filter((p) => !inTwoCam(p.t));
        for (const w of twoCamWindows) {
            const cx = Number.isFinite(w.cx) ? w.cx : 0.5;
            const cy = Number.isFinite(w.cy) ? w.cy : 0.42;
            const who = String(w.who || '');
            held.push({ t: w.a, cx, cy, who });
            held.push({ t: Math.max(w.a + 0.03, w.b - 0.02), cx, cy, who });
        }
        mainPts.length = 0;
        mainPts.push(...held.sort((a, b) => a.t - b.t));
    }

    // Coverage repair: a Detail plan can cover only part of a long part (measured:
    // 3 windows over the first 31 s of a 128 s part), which used to leave the crop
    // frozen on whatever the last window aimed at. Sample the frame locally (no
    // API) wherever no aim point is near, so the crop keeps following the action.
    // A window that holds ONE aim point for several seconds drifts off the
    // subject (measured: a 6 s pip window clipped the speaker's head). 3.5 s is
    // the same rhythm the plan is asked for, so a lazy plan gets filled in.
    const AIM_GAP = 3.5;
    const BLIND_STEP = 3;
    const MAX_SAMPLES = 60;
    // A split window is a deliberate fixed camera, so it counts as covered even
    // when no anchor sits in its middle - otherwise the RGB repair would push
    // sampled points into it and fight the hold.
    const inTwoCamWindow = (t) => twoCamWindows.some((w) => t >= w.a && t <= w.b);
    const coveredAt = (t) => inTwoCamWindow(t) || mainPts.some((p) => Math.abs(p.t - t) <= AIM_GAP);
    const blindFrom = [];
    let blindStart = null;
    for (let t = 0; t <= dur + 0.001; t += 1) {
        if (!coveredAt(t)) {
            if (blindStart == null) blindStart = Math.max(0, t - 1);
            continue;
        }
        if (blindStart != null && t - 1 - blindStart >= 3) blindFrom.push({ a: blindStart, b: t - 1 });
        blindStart = null;
    }
    if (blindStart != null && dur - blindStart >= 3) blindFrom.push({ a: blindStart, b: dur });
    let repairSec = blindFrom.reduce((sum, range) => sum + (range.b - range.a), 0);
    let repaired = 0;
    if (repairSec >= 3 && !job?.cancelled) {
        const budget = Math.min(MAX_SAMPLES, Math.ceil(repairSec / BLIND_STEP));
        const step = Math.max(BLIND_STEP, repairSec / Math.max(1, budget));
        let seed = [...mainPts].filter((p) => p.t <= blindFrom[0].a).pop() || mainPts[0];
        let lastCx = Number.isFinite(seed?.cx) ? seed.cx : 0.5;
        let lastCy = Number.isFinite(seed?.cy) ? seed.cy : 0.42;
        const seedWho = String(seed?.who || '');
        for (const range of blindFrom) {
            for (let t = range.a + 0.4; t < range.b - 0.2; t += step) {
                if (job?.cancelled) throw new Error('cancelled');
                try {
                    const sample = await sampleTalkerX(srcPath, t, srcW, srcH, { neutral: true, faceBias: true });
                    const peaks = Array.isArray(sample?.peaks) ? sample.peaks : [];
                    if (peaks.length) {
                        const near = peaks.filter((p) => Math.abs(p.x - lastCx) <= 0.35);
                        const pool = near.length ? near : peaks;
                        const best = pool.reduce((a, b) => (b.e > a.e ? b : a), pool[0]);
                        const jump = Math.max(-0.25, Math.min(0.25, best.x - lastCx));
                        lastCx = Math.max(0.08, Math.min(0.92, lastCx + jump));
                    }
                    mainPts.push({ t: Math.round(t * 10) / 10, cx: lastCx, cy: lastCy, who: seedWho });
                    repaired += 1;
                } catch {
                    mainPts.push({ t: Math.round(t * 10) / 10, cx: lastCx, cy: lastCy, who: seedWho });
                }
            }
        }
        mainPts.sort((a, b) => a.t - b.t);
        onLog?.(`[EDIT] Focus 9:16: AI phủ thiếu ${repairSec.toFixed(0)}s toạ độ — bù ${repaired} điểm bám bằng mẫu RGB local (không tốn API)`);
    }
    onLog?.(`[EDIT] Focus 9:16: phủ toạ độ ${Math.max(0, dur - repairSec).toFixed(0)}/${dur.toFixed(0)}s${repairSec >= 3 ? ` (đã bù ${repairSec.toFixed(0)}s)` : ''}`);

    const secPts = [];
    let secSeq = 0;
    for (const w of windows) {
        if (w.mode !== 'pip' && w.mode !== 'split') continue;
        secSeq += 1;
        const who = `second ${secSeq}`;
        const cy = Number.isFinite(w.cy2) ? w.cy2 : 0.5;
        secPts.push({ t: w.a, cx: w.cx2, cy, who });
        // Camera 2 follows the second event when the plan gives its position over
        // time; without these the inset would freeze on the window-opening point
        // (measured: it framed empty grass while the animal walked away).
        let lastCx2 = w.cx2;
        let lastCy2 = cy;
        for (const p of track) {
            if (!Number.isFinite(Number(p.cx2))) continue;
            const t = Number(p.t);
            if (t <= w.a + 0.05 || t >= w.b - 0.05) continue;
            lastCx2 = Number(p.cx2);
            lastCy2 = Number.isFinite(Number(p.cy2)) ? Number(p.cy2) : cy;
            secPts.push({ t, cx: lastCx2, cy: lastCy2, who });
        }
        secPts.push({ t: Math.max(w.a + 0.03, w.b - 0.02), cx: lastCx2, cy: lastCy2, who });
    }

    const coveragePct = dur > 0 ? Math.max(0, ((dur - repairSec) / dur) * 100) : 100;
    // One render pass with a given aim track. Kept as a function so the critic
    // below can re-render the same part with corrected aim without redoing the
    // plan, the render being the only thing that changes.
    const renderPass = async (pts, outPath) => {
        let graph = focusFrameGraph({ srcW, srcH, windows, mainPts: pts, secPts });
        const prefixOf = (filter) => [
            '-y', '-i', srcPath,
            '-filter_complex', filter,
            '-map', '[v]',
            '-map', '0:a?',
        ];
        let encodeOpts = null;
        let scriptFile = null;
        // A dense aim list inlines one term per point. Past the Windows command
        // budget the same points go into a sendcmd file and the filter stays short.
        if (commandLineLength(prefixOf(graph.filter)) > WINDOWS_COMMAND_BUDGET) {
            const dir = path.join(__dirname, 'tmp');
            fs.mkdirSync(dir, { recursive: true });
            const name = `gf-sc-${process.pid}-${Date.now().toString(36)}.cmd`;
            scriptFile = path.join(dir, name);
            graph = focusFrameGraph({ srcW, srcH, windows, mainPts: pts, secPts, sendcmdFile: name });
            fs.writeFileSync(scriptFile, graph.script || '');
            encodeOpts = { cwd: dir };
            onLog?.(`[EDIT] Đồ thị crop ${pts.length} điểm — ghi vị trí ra file để khỏi vượt lệnh Windows`);
        }
        try {
            await runEditEncode(prefixOf(graph.filter), [
                '-c:a', 'aac', '-b:a', '160k',
                '-movflags', '+faststart',
                outPath,
            ], job, 20, false, {
                hold: pts.length,
                xExpr: pts.length,
                yExpr: secPts.length,
                filter: graph.filter.length,
            }, encodeOpts);
        } finally {
            if (scriptFile) {
                try { fs.unlinkSync(scriptFile); } catch { /* encode already finished */ }
            }
        }
        return graph;
    };
    // Post-render quality check (local, no API): was there a subject inside the
    // crop, did the crop move, was it pinned to an edge? Heuristic - a smoke
    // detector, not truth. It also feeds the critic below.
    const qaPass = async (pts) => {
        if (dur < 5 || job?.cancelled) return null;
        const samples = [];
        const step = Math.max(1.5, dur / 30);
        const halfNorm = (plan.mainBox.w / 2) / srcW;
        const aimAt = (t) => {
            let best = pts[0];
            for (const point of pts) {
                if (point.t <= t + 0.001) best = point;
                else break;
            }
            return best;
        };
        for (let t = 0.5; t < dur; t += step) {
            if (job?.cancelled) break;
            try {
                const sample = await sampleTalkerX(srcPath, t, srcW, srcH, { neutral: true, faceBias: true, withMotion: true });
                const peaks = Array.isArray(sample?.peaks) ? sample.peaks : [];
                const aim = aimAt(t);
                const cx = Number.isFinite(aim?.cx) ? aim.cx : 0.5;
                const half = halfNorm * 0.95;
                const strongest = peaks.length ? peaks.reduce((a, b) => (b.e > a.e ? b : a), peaks[0]) : null;
                samples.push({
                    t,
                    cx,
                    inCrop: peaks.some((point) => Math.abs(point.x - cx) <= half),
                    // The strongest subject sits just outside the window: the crop
                    // is cutting it, which the "subject inside" test cannot see.
                    edgeCut: Boolean(strongest)
                        && Math.abs(strongest.x - cx) > half
                        && Math.abs(strongest.x - cx) <= half + 0.05,
                    empty: Boolean(sample?.empty),
                    motion: sample?.motion,
                    peakX: strongest ? strongest.x : undefined,
                });
            } catch { /* skip an unreadable sample */ }
        }
        return { report: buildEditQaReport({ duration: dur, samples, coveragePct, windows, repairedSec: repairSec }), samples };
    };
    const logQa = (report, label) => {
        onLog?.(`[QA]${label ? ` ${label}` : ''} Chất lượng part: ${report.score}/100 (${report.grade})`
            + (report.warnings.length ? ` · ${report.warnings.join(' · ')}` : ' · không thấy vấn đề')
            + ` · ${report.metrics.samples} mẫu/ ${report.metrics.sampledSec.toFixed(0)}s`);
    };

    const startedAt = Date.now();
    let graph;
    try {
        graph = await renderPass(mainPts, destPath);
    } finally {
        onLog?.(`[EDIT TIMING] focus render: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`);
    }
    const plan = graph.plan;
    onLog?.(`[EDIT] Focus 9:16 (${how}): ${windows.length} khung · tiêu điểm ${plan.focusWindows} · chia đôi ${plan.splitWindows} · crop ${plan.mainBox.w}x${plan.mainBox.h} trên ${srcW}x${srcH} · ${mainPts.length} điểm bám · ${secPts.length} điểm camera 2`);
    windows.slice(0, 16).forEach((w) => {
        const aim = Number.isFinite(w.cx) ? ` @${Number(w.cx).toFixed(2)}` : '';
        const aim2 = (w.mode === 'pip' || w.mode === 'split') && Number.isFinite(w.cx2)
            ? ` +camera2 @${Number(w.cx2).toFixed(2)}`
            : '';
        onLog?.(`[EDIT]   ${Number(w.a).toFixed(1)}–${Number(w.b).toFixed(1)}s  ${w.mode}${aim}${aim2}${w.why ? ` · ${w.why}` : ''}`);
    });
    onLog?.(`[EDIT] Focus 3:4 trên nền mờ, khung vẫn 9:16, crop ${plan.mainBox.w}x${plan.mainBox.h}${plan.splitWindows ? '. Chia đôi phủ kín trên dưới' : ''}`);
    const first = await qaPass(mainPts);
    let qa = first?.report || null;
    if (qa) logQa(qa, '');

    // Automatic second opinion: only when the free local check is unhappy, and
    // only on a handful of stills (no video upload), so a good part costs nothing
    // extra. The critic returns a corrected aim in SOURCE coordinates; the part
    // is re-rendered and the LOCAL score decides which file is kept - the model
    // never gets the last word.
    if (qa && qa.score <= QA_CRITIC_MIN_SCORE && (criticApiKey || criticAuth) && !job?.cancelled) {
        try {
            // The local check can only see the failures it knows about, so the
            // critic also gets a few evenly spread moments and not only the
            // flagged ones (a head clipped at the edge passes the local test).
            const flaggedPoints = pickQaFocusPoints(first?.samples || [], { max: 3 });
            const spreadPoints = [0.25, 0.5, 0.75]
                .map((fraction) => Math.round(dur * fraction * 10) / 10)
                .filter((t) => t > 0.5 && t < dur - 0.5 && !flaggedPoints.some((p) => Math.abs(p - t) < 3));
            const points = [...flaggedPoints, ...spreadPoints].sort((a, b) => a - b).slice(0, 5);
            if (points.length) {
                const overrides = await criticFocusAim({
                    srcPath, destPath, srcW, srcH, points, job, onLog,
                    apiKey: criticApiKey, auth: criticAuth, model: criticModel,
                });
                if (overrides.length) {
                    const fixedPts = applyAimOverrides(mainPts, overrides, dur);
                    const fixedPath = `${destPath}.critic.mp4`;
                    await renderPass(fixedPts, fixedPath);
                    const second = await qaPass(fixedPts);
                    if (second?.report && second.report.score > qa.score) {
                        try { fs.renameSync(fixedPath, destPath); } catch { /* keep the original */ }
                        onLog?.(`[QA] Sửa lại khung bằng AI: ${qa.score} → ${second.report.score}/100 (giữ bản tốt hơn)`);
                        logQa(second.report, 'sau khi sửa:');
                        qa = second.report;
                    } else {
                        try { fs.unlinkSync(fixedPath); } catch { /* ignore */ }
                        onLog?.(`[QA] Bản sửa của AI không tốt hơn (${qa.score} vs ${second?.report?.score ?? '-'}) — giữ bản gốc`);
                    }
                }
            }
        } catch (criticErr) {
            const message = criticErr instanceof Error ? criticErr.message : String(criticErr);
            if (/cancell/i.test(message) || job?.cancelled) throw criticErr;
            onLog?.(`[QA] Bỏ qua vòng sửa khung: ${message}`.slice(0, 200));
        }
    }
    return qa;
};

// Below this local score the part gets a second opinion from a vision model.
const QA_CRITIC_MIN_SCORE = 80;

// A surviving corner window is checked for what the local gates cannot see: it
// may look different (other background, another angle) yet show the SAME person
// as the main crop - measured on the Law By Mike clip, the popup showed the
// ad that features the same host, so it added nothing. One small call per popup,
// only for parts that actually keep one.
const reviewFocusPopup = async ({ srcPath, t, mainRect, secRect, job, onLog, apiKey, auth, model }) => {
    if (!apiKey && !auth) return true;
    const mainJpeg = await grabCroppedJpeg(srcPath, t, mainRect, job, 320);
    const secJpeg = await grabCroppedJpeg(srcPath, t, secRect, job, 320);
    if (!mainJpeg || !secJpeg) return true;
    const parts = [
        { text: 'This is the crop we use for the TOP half of the frame. Image 1:' },
        { inlineData: { mimeType: 'image/jpeg', data: mainJpeg.toString('base64') } },
        { text: 'This is the crop we plan to use for the BOTTOM half of the frame. Image 2:' },
        { inlineData: { mimeType: 'image/jpeg', data: secJpeg.toString('base64') } },
        { text: `Would the bottom half add information the top half does not already show at this moment (a different event, a second person, a different camera), or is it the same person / the same scene seen again?
Return JSON only: {"keep":true,"why":"one short reason"}
Set keep=false when image 2 shows the same person or the same scene as image 1, or when it adds nothing worth half the frame.` },
    ];
    // The critic is the checker: give it the strongest model available first (the
    // UI model, default 3.8-flash) and only step down on a real failure. The
    // 10-minute overload memory keeps a busy model from costing more than one
    // fast failed call.
    const candidates = orderDetailModels(model, 'quality').slice(0, 3);
    for (const candidate of candidates) {
        if (modelKnownOverloaded(candidate)) continue;
        try {
            let text = '';
            if (apiKey) {
                const modelId = candidate.replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.5-flash-lite';
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
                    signal: jobSignal(job, 60000),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(geminiErrorText(json, res.status));
                recordGeminiUsage(job, modelId, json.usageMetadata, 'Soi chia đôi');
                text = (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
            } else {
                const modelId = vertexModelId(candidate);
                const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${auth.project}/locations/global/publishers/google/models/${modelId}:generateContent`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', 'x-goog-user-project': auth.project },
                    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
                    signal: jobSignal(job, 60000),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(json?.error?.message || `Vertex popup HTTP ${res.status}`);
                text = (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
            }
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start < 0 || end <= start) throw new Error('popup review returned no JSON');
            const parsed = JSON.parse(text.slice(start, end + 1));
            onLog?.(`[QA] Soi chia đôi @ ${Number(t).toFixed(1)}s: ${parsed.keep === false ? 'BỎ' : 'giữ'} — ${String(parsed.why || '').slice(0, 90)}`);
            return parsed.keep !== false;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job?.cancelled || /cancell/i.test(message)) throw err;
            if (!isTemporaryGeminiErr(message)) {
                // A slow answer must not cancel the check: treat a timeout like a
                // busy model and step down the ladder.
                if (!/timeout|timed out|aborted|fetch failed|ECONNRESET|UNAVAILABLE/i.test(message)) {
                    onLog?.(`[QA] Không soi được chia đôi: ${message}`.slice(0, 160));
                    return true;
                }
            }
            markModelOverloaded(candidate);
            onLog?.(`[QA] Soi chia đôi: ${candidate} không trả lời kịp — thử model kế tiếp`.slice(0, 160));
        }
    }
    return true;
};

// Recognise the kind of video BEFORE planning, so the workflow of that topic can
// be applied to the global plan and to Detail (the operator's "square goes to the
// square template" rule). Three stills, one small call on the safe model ladder;
// any failure just leaves the topic generic - it never fails the run.
const classifyVideoTopic = async ({ srcPath, duration, job, onLog, apiKey, auth, model }) => {
    const stamps = [0.2, 0.5, 0.8].map((fraction) => Math.max(1, duration * fraction));
    const parts = [];
    for (const t of stamps) {
        if (job?.cancelled) throw new Error('cancelled');
        try {
            const jpeg = await extractDetailJpegFrame(srcPath, t, job);
            if (jpeg?.length) {
                parts.push({ text: `still at ${t.toFixed(1)}s` });
                parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } });
            }
        } catch { /* skip an unreadable still */ }
    }
    if (!parts.length) return null;
    parts.push({ text: topicClassifierPrompt() });
    if (!apiKey && !auth) return null;
    // Same rule as the aim critic: strongest model first, ladder as the fall-back.
    const candidates = orderDetailModels(model, 'quality').slice(0, 3);
    for (const candidate of candidates) {
        if (modelKnownOverloaded(candidate)) continue;
        try {
            let text = '';
            if (apiKey) {
                const modelId = candidate.replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.5-flash-lite';
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
                    signal: jobSignal(job, 60000),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(geminiErrorText(json, res.status));
                recordGeminiUsage(job, modelId, json.usageMetadata, 'Nhận diện chủ đề');
                text = (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
            } else {
                const modelId = vertexModelId(candidate);
                const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${auth.project}/locations/global/publishers/google/models/${modelId}:generateContent`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', 'x-goog-user-project': auth.project },
                    body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
                    signal: jobSignal(job, 60000),
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(json?.error?.message || `Vertex topic HTTP ${res.status}`);
                text = (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
            }
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start < 0 || end <= start) throw new Error('topic classifier returned no JSON');
            const parsed = JSON.parse(text.slice(start, end + 1));
            return { topic: String(parsed.topic || '').slice(0, 40), confidence: Number(parsed.confidence) };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job?.cancelled || /cancell/i.test(message)) throw err;
            if (!isTemporaryGeminiErr(message)) {
                onLog?.(`[TOPIC] Bỏ qua nhận dạng chủ đề: ${message}`.slice(0, 180));
                return null;
            }
            markModelOverloaded(candidate);
        }
    }
    return null;
};

// Second opinion on the rendered crop. The local check says WHICH moments look
// wrong; this asks a vision model, on a handful of stills (no video upload, one
// small call), where the crop should have been. The corrected aim is applied by
// the caller and the LOCAL score decides whether the new render is kept - the
// model never gets the last word.
const criticFocusAim = async ({ srcPath, destPath, srcW, srcH, points, job, onLog, apiKey, auth, model }) => {
    const pairs = [];
    for (const t of points) {
        if (job?.cancelled) throw new Error('cancelled');
        try {
            const srcJpeg = await extractDetailJpegFrame(srcPath, t, job);
            const outJpeg = await extractDetailJpegFrame(destPath, t, job);
            if (srcJpeg?.length && outJpeg?.length) pairs.push({ t, srcJpeg, outJpeg });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (job?.cancelled || /cancell/i.test(message)) throw err;
            onLog?.(`[QA] Bỏ mẫu soi lại @ ${Number(t).toFixed(1)}s: ${message}`.slice(0, 180));
        }
    }
    if (!pairs.length) return [];
    const instruction = `You check a vertical 9:16 crop of a video. For each timestamp you get two images: the SOURCE frame (full picture) and the RENDER (the 9:16 crop we cut from that same source frame).
Decide whether the main subject of that moment - the person, animal or action the shot is about - is fully inside the render and reasonably framed.
Return JSON only:
{"items":[{"t":12.4,"ok":false,"cx":0.31,"cy":0.45,"why":"officer is cut off on the right"}]}
Set ok=true when the render is already fine (you may omit cx,cy). When ok=false, cx,cy is the centre of that subject in the SOURCE frame (0=left/top, 1=right/bottom). Judge only what is visible in the source frame; never invent a subject that is not there.`;
    const parts = [];
    for (const pair of pairs) {
        parts.push({ text: `timestamp ${pair.t.toFixed(2)}s - SOURCE frame:` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: pair.srcJpeg.toString('base64') } });
        parts.push({ text: `timestamp ${pair.t.toFixed(2)}s - OUR 9:16 RENDER:` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: pair.outJpeg.toString('base64') } });
    }
    parts.push({ text: instruction });

    // The critic task is simple (is the subject inside this crop?), so it uses the
    // measured-safe ladder - a lite model answers it in seconds and is almost
    // never overloaded, unlike a 3.8-class model (which returned HTTP 503 on the
    // first live attempt). The shared overload memory skips a model that just
    // refused, across jobs.
    const criticModels = orderDetailModels(null, 'safe').slice(0, 3);
    const callCritic = async (candidate) => {
        if (apiKey) {
            const modelId = candidate.replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.5-flash-lite';
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts }],
                    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
                }),
                signal: jobSignal(job, 90000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(geminiErrorText(json, res.status));
            recordGeminiUsage(job, modelId, json.usageMetadata, 'QA soi lại khung');
            return (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
        }
        const modelId = vertexModelId(candidate);
        const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${auth.project}/locations/global/publishers/google/models/${modelId}:generateContent`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${auth.token}`,
                'Content-Type': 'application/json',
                'x-goog-user-project': auth.project,
            },
            body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            }),
            signal: jobSignal(job, 90000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error?.message || `Vertex critic HTTP ${res.status}`);
        return (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
    };
    if (!apiKey && !auth) return [];
    let text = '';
    let lastCriticErr = null;
    for (const candidate of criticModels) {
        if (modelKnownOverloaded(candidate)) continue;
        try {
            text = await callCritic(candidate);
            onLog?.(`[QA] AI soi lại khung bằng ${candidate}`);
            break;
        } catch (err) {
            lastCriticErr = err;
            const message = err instanceof Error ? err.message : String(err);
            if (job?.cancelled || /cancell/i.test(message)) throw err;
            // A slow or busy model must not kill the review: step down the ladder.
            const transient = isTemporaryGeminiErr(message) || /timeout|timed out|aborted|fetch failed|ECONNRESET|UNAVAILABLE/i.test(message);
            if (!transient) throw err;
            markModelOverloaded(candidate);
            onLog?.(`[QA] ${candidate} không trả lời kịp — thử model kế tiếp`.slice(0, 160));
        }
    }
    if (!text) throw lastCriticErr || new Error('Critic: không model nào trả lời');

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Critic did not return JSON');
    const parsed = JSON.parse(text.slice(start, end + 1));
    const overrides = [];
    for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
        if (!item || item.ok) continue;
        const t = Number(item.t);
        const cx = Number(item.cx);
        if (!Number.isFinite(t) || !Number.isFinite(cx)) continue;
        const cy = Number.isFinite(Number(item.cy)) ? Number(item.cy) : 0.42;
        overrides.push({
            t,
            cx: Math.max(0.05, Math.min(0.95, cx)),
            cy: Math.max(0.05, Math.min(0.95, cy)),
            why: String(item.why || '').slice(0, 80),
        });
    }
    onLog?.(`[QA] AI soi lại ${pairs.length} mẫu: ${overrides.length} chỗ cần chỉnh khung`
        + (overrides.length ? ` · ${overrides.map((o) => `${o.t.toFixed(0)}s→${o.cx.toFixed(2)}`).join(', ')}` : ''));
    return overrides;
};


// Every successful Gemini API-key answer carries usageMetadata; failed calls are
// not billed. Recording them is what turns the per-video cost from an estimate
// into the provider's own token count, and it also names the model that really
// answered - the UI model is only a preference, the ladder may have stepped down.
const recordGeminiUsage = (job, model, usage, label) => {
    if (!job || !usage) return null;
    if (!Array.isArray(job.geminiUsage)) job.geminiUsage = [];
    const entry = {
        model: String(model || '').trim(),
        label: String(label || '').slice(0, 80),
        ...usageFromMetadata(usage),
    };
    job.geminiUsage.push(entry);
    return entry;
};

const geminiCallCostVnd = (model, usage) => {
    const usd = usageCostUsd(model, usage);
    return usd == null ? null : usdToVnd(usd);
};

async function geminiUploadVideo(apiKey, filePath, displayName) {
    const size = fs.statSync(filePath).size;
    const startRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'X-Goog-Upload-Header-Content-Length': String(size),
            'X-Goog-Upload-Header-Content-Type': 'video/mp4',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: displayName || 'clip.mp4' } }),
    });
    if (!startRes.ok) {
        const t = await startRes.text();
        throw new Error(`Gemini upload start ${startRes.status}: ${t.slice(0, 280)}`);
    }
    const uploadUrl = startRes.headers.get('x-goog-upload-url') || startRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('Gemini did not return an upload URL');
    const buf = await fs.promises.readFile(filePath);
    const putRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Length': String(size),
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: buf,
    });
    if (!putRes.ok) throw new Error(`Gemini upload ${putRes.status}: ${(await putRes.text()).slice(0, 280)}`);
    const meta = await putRes.json();
    const file = meta.file || meta;
    const name = file.name;
    if (!name) throw new Error('Gemini file name missing');
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
        const st = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(apiKey)}`);
        const j = await st.json();
        const rec = j.file || j;
        if (rec.state === 'ACTIVE') return rec;
        if (rec.state === 'FAILED') throw new Error('Gemini failed to process the video');
        await sleep(2000);
    }
    throw new Error('Gemini still processing the video — try a shorter clip');
}

async function geminiGeneratePlan(apiKey, model, fileUri, userPrompt, duration, maxParts, minSec, autoParts = false, tiktokMix = false, testClip = false, sceneCuts = null, temperature = 0.2, promptOverride = null, partCap = null) {
    const modelId = String(model || 'gemini-3.8-flash').replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.8-flash';
    const sys = promptOverride || editorSysPrompt(userPrompt, duration, maxParts, minSec, autoParts, tiktokMix, testClip, sceneCuts);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const thinkingLevel = /flash-lite|3\.[56]-flash$/.test(modelId) ? 'minimal' : 'low';
    const requestPlan = async (withThinking) => {
        const generationConfig = {
            responseMimeType: 'application/json',
            temperature,
            maxOutputTokens: 65536,
        };
        if (withThinking) generationConfig.thinkingConfig = { thinkingLevel };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    role: 'user',
                    parts: [
                        { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
                        { text: sys },
                    ],
                }],
                generationConfig,
            }),
        });
        const body = await res.json().catch(() => ({}));
        return { res, body };
    };
    let { res, body: j } = await requestPlan(true);
    if (!res.ok && /thinking/i.test(geminiErrorText(j, res.status))) {
        ({ res, body: j } = await requestPlan(false));
    }
    if (!res.ok) {
        throw new Error(geminiErrorText(j, res.status));
    }
    const candidate = j.candidates?.[0] || {};
    const usage = j.usageMetadata || {};
    const finish = String(candidate.finishReason || '');
    const text = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
    // A cut-off or empty answer is still billed by the provider, so the token
    // counts ride on the error and the caller records them.
    if (/MAX_TOKENS/i.test(finish)) {
        const err = new Error(`Gemini JSON cut off: finishReason=${finish} candidates=${usage.candidatesTokenCount || 0} thoughts=${usage.thoughtsTokenCount || 0}`);
        err.usage = usage;
        err.modelId = modelId;
        throw err;
    }
    if (!text.trim()) {
        const err = new Error(`Gemini returned empty text finishReason=${finish || 'none'}`);
        err.usage = usage;
        err.modelId = modelId;
        throw err;
    }
    const plan = parseGeminiPlan(text, duration, maxParts, minSec, partCap ? true : autoParts, sceneCuts, partCap);
    // The caller records this against its job; keeping it on the plan is what
    // lets the run report name the model that really answered.
    plan._usage = usage;
    plan._modelUsed = modelId;
    return plan;
}

async function geminiDeleteFile(apiKey, fileName) {
    if (!fileName) return;
    try {
        await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`, { method: 'DELETE' });
    } catch { /* ignore */ }
}

const runGcloud = async (args) => {
    const opts = { encoding: 'utf8', timeout: 25000, windowsHide: true, env: process.env };
    let r = await runProcess('gcloud', args, opts);
    if ((r.error || r.status !== 0) && process.platform === 'win32') {
        r = await runProcess('gcloud', args, { ...opts, shell: true });
    }
    return r;
};

const readAdcProject = () => {
    const candidates = [
        process.env.GOOGLE_CLOUD_PROJECT,
        process.env.GCLOUD_PROJECT,
        process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
    ].filter(Boolean);
    const files = [
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
        path.join(process.env.CLOUDSDK_CONFIG || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud'), 'application_default_credentials.json'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'gcloud', 'application-default-credentials.json'),
        path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'),
        path.join(os.homedir(), '.config', 'gcloud', 'application-default-credentials.json'),
    ].filter(Boolean);
    for (const f of files) {
        try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (j.quota_project_id) candidates.push(j.quota_project_id);
            if (j.project_id) candidates.push(j.project_id);
        } catch { /* ignore */ }
    }
    return candidates.find((p) => p && p !== '(unset)') || '';
};

const getAdcAuth = async () => {
    const tokenRes = await runGcloud(['auth', 'application-default', 'print-access-token']);
    let token = (tokenRes.stdout || '').trim().split(/\s+/)[0];
    if (tokenRes.status !== 0 || !token) {
        const t2 = await runGcloud(['auth', 'print-access-token']);
        token = (t2.stdout || '').trim().split(/\s+/)[0];
        if (t2.status !== 0 || !token) {
            const err = `${tokenRes.stderr || tokenRes.error?.message || t2.stderr || ''}`.trim().slice(0, 280);
            throw new Error(err || 'ADC not ready. Run: gcloud auth application-default login');
        }
    }
    let project = readAdcProject();
    if (!project) {
        const p = await runGcloud(['config', 'get-value', 'project']);
        const v = (p.stdout || '').trim();
        if (v && v !== '(unset)') project = v;
    }
    const location = process.env.VERTEX_LOCATION || 'us-central1';
    if (!project) throw new Error('ADC OK but no GCP project. Run: gcloud config set project YOUR_PROJECT_ID');
    return { token, project, location };
};

const vertexModelId = (model) => {
    const m = String(model || 'gemini-3.8-flash');
    if (m === 'gemini-2.0-flash') return 'gemini-2.0-flash-001';
    return m.replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.8-flash';
};

const editorSysPrompt = (userPrompt, duration, maxParts, minSec, autoParts = false, tiktokMix = false, testClip = false, sceneCuts = null) => `You are a professional video editor. Watch AND listen to ${testClip ? 'THIS SHORT EXCERPT ONLY (do not imagine a longer movie)' : 'the entire video'}.
${testClip ? `TEST: the file is ~${duration.toFixed(0)} seconds. Return EXACTLY 1 episode covering 0.0 → ${duration.toFixed(1)}. Also return spoken "lines" in the SAME JSON so there is no second watch.
` : ''}User request:
${String(userPrompt || '').slice(0, 4000)}

Video duration is ${duration.toFixed(2)} seconds.
Return JSON only:
{"summary":"one line","segments":[{"name":"English Title","nameVi":"Tiêu đề Việt","reason":"why this cut","start":0.0,"end":${testClip ? duration.toFixed(1) : '128.4'}${tiktokMix ? `,"frames":[{"start":0.0,"end":5.0,"mode":"contain"},{"start":5.0,"end":12.0,"mode":"fill","why":"Jeffy"},{"start":12.0,"end":16.0,"mode":"contain"},{"start":16.0,"end":23.0,"mode":"fill","why":"Brooklyn"}],"track":[{"t":5.0,"cx":0.72,"cy":0.42,"who":"Jeffy"},{"t":8.0,"cx":0.74,"cy":0.41,"who":"Jeffy"},{"t":16.0,"cx":0.22,"cy":0.44,"who":"Brooklyn"},{"t":20.0,"cx":0.24,"cy":0.43,"who":"Brooklyn"}]` : ''}}]${testClip ? `,"lines":[{"t":0.12,"end":1.85,"who":"Brooklyn","cx":0.18,"cy":0.42,"text":"spoken words"}]` : ''}}

${autoParts
    ? 'EPISODES: decide count from the content. Cover the story from start to end. Skip only mid-roll ads, outro, subscribe cards.'
    : `EPISODES: Return EXACTLY ${maxParts} episodes — not ${Math.max(1, maxParts - 1)}, not ${maxParts + 1}. Cover the WHOLE video from start to end in timeline order. Episode 1 starts near 0, episode ${maxParts} ends just before outro/credits. Do not skip real story. Do not dump leftover into fewer longer episodes.`}

Each episode is ONE contiguous range (start → end) on the original timeline. Do NOT shuffle pieces. Do NOT put a later punch as a hook at the start. Do NOT jump timestamps (forbidden: hook from minute 8 then body from minute 1). One cut per episode.

Skip mid-roll ads unrelated to the main story and the outro/end-card only. Do not skip jokes, scenes, or story beats. Do not split by the clock (equal slices). Cut on natural dialogue/action frames.

Keep episode lengths similar: a few tens of seconds difference is OK. 1 minute vs 3 minutes is NOT OK.
HARD: each episode duration >= ${Math.max(8, Number(minSec) || 60)} seconds${Number(minSec) >= 60 ? '. Never return 60s or less' : ' (TEST clip — 1 short part is OK)'}.
Last episode must not include credits/end-card.

name: short English title, 3–8 words, independent per episode, no "Part 1". Match THIS episode's content. Follow the user request for tone (SML dark-humor / shocking if they asked). Never the same title twice.
nameVi: accurate Vietnamese translation. Filename uses the English name.
${tiktokMix ? (Array.isArray(sceneCuts) ? detailSemanticFramingGuidance() : `
FRAMING — required. 9:16 mix of WIDE vs CLOSE. Target 50–65% of the episode as fill (1:1). Alternate often — do NOT leave the whole scene wide.
1) frames[] covers the WHOLE episode, no gaps. Same source timestamps as start/end.
   contain = WIDE (full 16:9 small in 9:16 + blur bars): 4+ puppets packed, first 2s of a new location, CCTV/laptop/poster/calendar insert, prop-only (chips, bottle, empty black), OR the source shot is ALREADY a tight close-up of one face.
   fill = MEDIUM 1:1 crop on the puppet who is SPEAKING RIGHT NOW (head + shoulders + chest). LISTEN first. 1 speaker or 2-shot → FILL the speaker. Kitchen Chef alone = FILL. Marvin vs cops at the door = FILL whoever is talking. 3 puppets on a couch = FILL the speaker (not wide).
   TARGET: 50–65% fill. Rhythm: wide 2–4s then fill on the speaker for the whole line, repeat. Do NOT leave 8s+ of only contain unless CCTV / 4+ crowd / prop insert.
   HARD: 1–2 puppets + talking → FILL. Missing this is a fail.
   HARD: 4+ puppets filling the frame → CONTAIN. Three puppets still FILL the speaker.
   HARD: speaker is NOT in this camera shot → CONTAIN.
   HARD: chips / cups / bottles / roulette / signage / black empty / calendar paper insert → CONTAIN.
   HARD: source already close-up / laptop / poster / CCTV → CONTAIN. Do not fill again.
   HARD: Never aim fill at a glowing laptop/monitor/flashlight/calendar. Fill the TALKING puppet's FACE.
   HARD: one fill window = ONE speaker. New puppet starts talking = NEW fill window on that SAME frame (first phoneme). Min fill 1.2s. Instant cut, no pan.
   HARD: contain windows stay wide. Only FILL hunts the speaker.
2) track[] required: one point about every 0.4 seconds during FILL, and another point at the instant the heard speaker or the face position changes. During contain, one point about every 2 seconds is enough.
   {"t":12.4,"cx":0.22,"cy":0.44,"who":"Brooklyn"}
   cx,cy = center of the TALKING puppet's FACE in the SOURCE frame (0=left/top, 1=right/bottom).
   who = name of the voice you HEAR at t, not the largest puppet.
   NEVER default cx=0.5 unless that face is actually in the middle.
   NEVER set cx to a cup, bottle, chips, poster, laptop, or the brightest blob.
   Left speaker ≈ 0.18–0.32, center ≈ 0.42–0.58, right ≈ 0.68–0.85.
   Different speaker = new point at that INSTANT with the NEW face. Same speaker = hold the same cx. Camera must CUT, never slide.
`) : ''}${detailSceneCutGuidance(sceneCuts, duration)}${!testClip && !Array.isArray(sceneCuts) ? globalCoverageGuidance() : ''}`;

async function shrinkProxyForVertex(srcPath, job, onLog) {
    const limit = 16 * 1024 * 1024;
    let current = srcPath;
    const extras = [];
    const steps = [
        { vf: "scale='min(640,iw)':-2", r: '6', crf: '36', ba: '48k', tag: '640p/6fps' },
        { vf: "scale='min(480,iw)':-2", r: '4', crf: '38', ba: '32k', tag: '480p/4fps' },
        { vf: "scale='min(360,iw)':-2", r: '3', crf: '40', ba: '24k', tag: '360p/3fps' },
        { vf: "scale='min(320,iw)':-2", r: '2', crf: '42', ba: '16k', tag: '320p/2fps' },
        { vf: "scale='min(256,iw)':-2", r: '1', crf: '45', ba: null, tag: '256p/1fps' },
    ];
    let n = 0;
    while (fs.statSync(current).size > limit) {
        if (n >= steps.length) {
            const mb = (fs.statSync(current).size / 1024 / 1024).toFixed(0);
            throw new Error(`Proxy still ${mb}MB after max shrink — clip too long for Vertex inline.`);
        }
        const s = steps[n++];
        const out = srcPath.replace(/\.mp4$/i, `_s${n}.mp4`);
        if (onLog) onLog(`[EDIT] Proxy too big — shrink to ${s.tag}…`);
        const prefix = ['-y', '-i', current, '-vf', s.vf, '-r', s.r];
        const suffix = s.ba ? ['-c:a', 'aac', '-b:a', s.ba, '-ac', '1'] : ['-an'];
        suffix.push('-movflags', '+faststart', out);
        await runEditEncode(prefix, suffix, job, Number(s.crf), true);
        extras.push(out);
        current = out;
    }
    return { filePath: current, extras, mb: fs.statSync(current).size / 1024 / 1024 };
}

async function vertexGeneratePlan(auth, model, videoPath, userPrompt, duration, maxParts, minSec, job, onLog, autoParts = false, tiktokMix = false, testClip = false, timingLabel = 'plan AI', sceneCuts = null, temperature = 0.2, promptOverride = null, partCap = null) {
    const shrunk = await shrinkProxyForVertex(videoPath, job, onLog);
    const filePath = shrunk.filePath;
    if (onLog) onLog(`[EDIT] Vertex proxy ${shrunk.mb.toFixed(1)}MB`);
    const b64 = (await fs.promises.readFile(filePath)).toString('base64');
    const modelId = vertexModelId(model);
    const locations = [...new Set([auth.location || 'us-central1', 'global'])];
    const body = JSON.stringify({
        contents: [{
            role: 'user',
            parts: [
                { inlineData: { mimeType: 'video/mp4', data: b64 } },
                { text: promptOverride || editorSysPrompt(userPrompt, duration, maxParts, minSec, autoParts, tiktokMix, testClip, sceneCuts) },
            ],
        }],
        generationConfig: { temperature, responseMimeType: 'application/json' },
    });
    let lastErr = '';
    const aiStartedAt = Date.now();
    try {
    for (const loc of locations) {
        const url = `https://${loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`}/v1/projects/${auth.project}/locations/${loc}/publishers/google/models/${modelId}:generateContent`;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (job && job.cancelled) throw new Error('cancelled');
            try {
                if (attempt > 1) {
                    if (onLog) onLog(`[EDIT] Vertex retry ${attempt}/3 @ ${loc}…`);
                    try { auth = await getAdcAuth(); } catch { /* keep token */ }
                    await sleepJob(2000 * attempt, job);
                }
                const { res, j } = await runSerializedVertexPost(job, onLog, async () => {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${auth.token}`,
                            'Content-Type': 'application/json',
                            'x-goog-user-project': auth.project,
                        },
                        body,
                        signal: jobSignal(job, 15 * 60 * 1000),
                    });
                    const j = await res.json().catch(() => ({}));
                    return { res, j };
                }, { quotaWaitMs: vertexQuotaWaitMs(attempt) });
                if (!res.ok) {
                    lastErr = j.error?.message || `Vertex ${res.status} @ ${loc}`;
                    if (isQuotaErr(lastErr, res.status)) {
                        await waitQuota(job, onLog, attempt);
                        continue;
                    }
                    if (res.status >= 500) continue;
                    break;
                }
                const text = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
                if (!text.trim()) {
                    lastErr = `Vertex empty @ ${loc}`;
                    continue;
                }
                return parseGeminiPlan(text, duration, maxParts, minSec, partCap ? true : autoParts, sceneCuts, partCap);
            } catch (err) {
                const m = err instanceof Error ? err.message : String(err);
                if (job && job.cancelled) throw new Error('cancelled');
                const cause = err && typeof err === 'object' && err.cause instanceof Error ? err.cause.message : '';
                if (/abort|timeout/i.test(`${m} ${cause}`)) {
                    lastErr = 'Vertex timeout — Gemini xem quá lâu / mạng chậm. Bấm GEMINI lại.';
                } else if (/fetch failed|ECONNRESET|UND_ERR|socket|EAI_AGAIN|network/i.test(`${m} ${cause}`)) {
                    lastErr = 'Vertex fetch failed — mất kết nối lúc Gemini đang xem. Bấm GEMINI lại.';
                } else {
                    lastErr = m;
                }
                if (onLog) onLog(`[EDIT] ${lastErr}`);
            }
        }
    }
    throw new Error(lastErr || 'Vertex generate failed');
    } finally {
        if (onLog) onLog(`[EDIT TIMING] ${timingLabel}: ${((Date.now() - aiStartedAt) / 1000).toFixed(2)}s`);
    }
}

async function vertexGlanceQuietPart(auth, model, frames, start, end, job, onLog) {
    const modelId = vertexModelId(model);
    const url = `https://aiplatform.googleapis.com/v1/projects/${auth.project}/locations/global/publishers/google/models/${modelId}:generateContent`;
    const parts = [{ text: generalGlancePrompt(start, end) }];
    for (const frame of frames) {
        parts.push({ text: `still at ${Number(frame.t).toFixed(1)}s` });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: frame.jpeg.toString('base64') } });
    }
    const { res, j } = await runSerializedVertexPost(job, onLog, async () => {
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: { temperature: 0, responseMimeType: 'application/json' },
            }),
            signal: AbortSignal.timeout(120000),
        });
        const body = await res.json().catch(() => ({}));
        return { res, j: body };
    });
    if (!res.ok) throw new Error(j?.error?.message || `Vertex glance HTTP ${res.status}`);
    const text = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) throw new Error('Vertex glance returned no JSON');
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return parseFraming({ frames: parsed.frames, start, end }, start, end);
}

async function vertexGenerateDetailMultimodal(auth, model, frames, evidenceText, userPrompt, duration, minSec, job, onLog, sceneCuts = null, promptOverride = null) {
    const modelId = vertexModelId(model);
    const locations = [...new Set(['global', auth.location || 'us-central1'])];
    const prompt = promptOverride || editorSysPrompt(userPrompt, duration, 1, minSec, false, true, true, sceneCuts);
    const body = JSON.stringify(buildDetailMultimodalRequest({ prompt, evidenceText, frames }));
    let lastErr = '';
    for (const loc of locations) {
        const url = `https://${loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`}/v1/projects/${auth.project}/locations/${loc}/publishers/google/models/${modelId}:generateContent`;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (job?.cancelled) throw new Error('cancelled');
            try {
                if (attempt > 1) {
                    onLog?.(`[EDIT] Vertex retry ${attempt}/3 @ ${loc}…`);
                    try { auth = await getAdcAuth(); } catch { /* keep token */ }
                    await sleepJob(2000 * attempt, job);
                }
                const { res, j } = await runSerializedVertexPost(job, onLog, async () => {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${auth.token}`,
                            'Content-Type': 'application/json',
                            'x-goog-user-project': auth.project,
                        },
                        body,
                        signal: jobSignal(job, 15 * 60 * 1000),
                    });
                    const j = await res.json().catch(() => ({}));
                    return { res, j };
                }, { quotaWaitMs: vertexQuotaWaitMs(attempt) });
                if (!res.ok) {
                    lastErr = j.error?.message || `Vertex ${res.status} @ ${loc}`;
                    if (isQuotaErr(lastErr, res.status)) {
                        await waitQuota(job, onLog, attempt);
                        continue;
                    }
                    if (res.status >= 500) continue;
                    break;
                }
                const text = (j.candidates || []).map((candidate) => (
                    candidate.content?.parts || []
                ).map((part) => part.text || '').join('')).join('\n');
                if (!text.trim()) {
                    lastErr = `Vertex empty @ ${loc}`;
                    continue;
                }
                return parseGeminiPlan(text, duration, 1, minSec, false, sceneCuts);
            } catch (err) {
                if (job?.cancelled) throw new Error('cancelled');
                const message = err instanceof Error ? err.message : String(err);
                const cause = err && typeof err === 'object' && err.cause instanceof Error ? err.cause.message : '';
                if (/abort|timeout/i.test(`${message} ${cause}`)) lastErr = 'Vertex timeout — Gemini xem quá lâu / mạng chậm. Bấm GEMINI lại.';
                else if (/fetch failed|ECONNRESET|UND_ERR|socket|EAI_AGAIN|network/i.test(`${message} ${cause}`)) lastErr = 'Vertex fetch failed — mất kết nối lúc Gemini đang xem. Bấm GEMINI lại.';
                else lastErr = message;
                onLog?.(`[EDIT] ${lastErr}`);
            }
        }
    }
    throw new Error(lastErr || 'Vertex Detail multimodal failed');
}

const parseJsonObject = (text) => {
    const raw = String(text || '');
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = (fence ? fence[1] : raw).trim();
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('JSON missing');
    return JSON.parse(jsonText.slice(start, end + 1));
};

const sttListenPrompt = (duration) => `LISTEN to this entire video. You are a stenographer.
Return JSON only:
{"lines":[{"t":0.12,"end":1.85,"who":"Speaker","cx":0.18,"cy":0.42,"text":"spoken words"}]}

Video duration is ${duration.toFixed(2)} seconds.
RULES:
- Cover the WHOLE video. Every spoken line.
- t = the EXACT moment that mouth STARTS the first phoneme (0.05s). Watch the jaw AND listen. Not 0.5s late.
- end = when that utterance finishes.
- Split at EVERY speaker change. Split on pauses > 0.3s. One line = one speaker, max 3.5 seconds.
- Include 1-word lines: Yes, What, No, Waitress.
- who = a short label for the voice you HEAR (a name if it is said, otherwise Speaker 1 / Speaker 2). Do not pick whoever is biggest on screen.
- cx,cy = that speaker's FACE in the source frame at t (0=left/top, 1=right/bottom).
- Empty/music/SFX → skip (do not invent who).`;

async function vertexJsonVideo(auth, model, videoPath, prompt, job, onLog, opts = {}) {
    const t0 = Date.now();
    const overallTimeoutMs = Math.max(0, Number(opts.overallTimeoutMs) || 0);
    const deadlineAt = overallTimeoutMs > 0 ? t0 + overallTimeoutMs : 0;
    const deadlineError = () => {
        const err = new Error(`Speaker AI overall deadline reached (${Math.round(overallTimeoutMs / 1000)}s)`);
        err.code = 'SPEAKER_AI_DEADLINE';
        return err;
    };
    const remainingMs = () => deadlineAt > 0 ? deadlineAt - Date.now() : Infinity;
    const requireRemaining = () => {
        if (job && job.cancelled) throw new Error('cancelled');
        const remaining = remainingMs();
        if (remaining <= 0) throw deadlineError();
        return remaining;
    };
    const shrunk = await shrinkProxyForVertex(videoPath, job, onLog);
    requireRemaining();
    const b64 = (await fs.promises.readFile(shrunk.filePath)).toString('base64');
    requireRemaining();
    const modelId = vertexModelId(model);
    const locations = [...new Set([auth.location || 'us-central1', 'global'])];
    const body = JSON.stringify({
        contents: [{
            role: 'user',
            parts: [
                { inlineData: { mimeType: 'video/mp4', data: b64 } },
                { text: prompt },
            ],
        }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    });
    let lastErr = '';
    let invalidJsonResponses = 0;
    const timeoutMs = Math.max(60_000, Number(opts.timeoutMs) || 12 * 60 * 1000);
    const displayTimeoutMs = overallTimeoutMs > 0 ? overallTimeoutMs : timeoutMs;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (onLog) onLog(`[EDIT] Vertex listen — chờ tối đa ${Math.round(displayTimeoutMs / 1000)}s (thanh % vẫn chạy)`);
    const pulse = setInterval(() => {
        if (job && job.cancelled) return;
        const cap = Math.round(displayTimeoutMs / 1000);
        const s = Math.min(cap, Math.round((Date.now() - t0) / 1000));
        const pct = Math.min(56, 43 + s * (13 / Math.max(60, cap)));
        try { onProgress?.(pct); } catch { /* ignore */ }
        if (onLog) onLog(`[EDIT] Vertex listen still working… ${s}s / ${cap}s`);
    }, 8000);
    try {
    for (const loc of locations) {
        requireRemaining();
        const url = `https://${loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`}/v1/projects/${auth.project}/locations/${loc}/publishers/google/models/${modelId}:generateContent`;
        for (let attempt = 1; attempt <= 5; attempt++) {
            requireRemaining();
            try {
                if (attempt > 1) {
                    requireRemaining();
                    try { auth = await getAdcAuth(); } catch { /* keep */ }
                    const retryDelayMs = 1500 * attempt;
                    if (remainingMs() <= retryDelayMs) throw deadlineError();
                    await sleepJob(retryDelayMs, job);
                }
                const { res, j } = await runSerializedVertexPost(job, onLog, async () => {
                    const fetchTimeoutMs = Math.max(1, Math.floor(Math.min(timeoutMs, requireRemaining())));
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${auth.token}`,
                            'Content-Type': 'application/json',
                            'x-goog-user-project': auth.project,
                        },
                        body,
                        signal: jobSignal(job, fetchTimeoutMs),
                    });
                    const j = await res.json().catch(() => ({}));
                    return { res, j };
                }, {
                    deadlineAt,
                    deadlineError,
                    quotaWaitMs: vertexQuotaWaitMs(attempt),
                });
                requireRemaining();
                if (!res.ok) {
                    lastErr = j.error?.message || `Vertex ${res.status} @ ${loc}`;
                    if (isQuotaErr(lastErr, res.status)) {
                        const quotaWaitMs = Math.min(90, 8 + attempt * attempt * 10) * 1000;
                        if (remainingMs() <= quotaWaitMs) throw deadlineError();
                        await waitQuota(job, onLog, attempt);
                        continue;
                    }
                    if (res.status >= 500) continue;
                    break;
                }
                const text = (j.candidates || [])
                    .map((c) => (c.content?.parts || []).map((p) => p.text || '').join(''))
                    .join('\n');
                if (!text.trim()) {
                    lastErr = `Vertex STT empty @ ${loc}`;
                    continue;
                }
                let parsed;
                try {
                    parsed = parseJsonObject(text);
                } catch (parseErr) {
                    invalidJsonResponses += 1;
                    lastErr = `Vertex STT JSON invalid @ ${loc}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`;
                    if (onLog) onLog(`[EDIT] ${lastErr}`);
                    // A successful, non-empty response is not a transport failure. Allow one
                    // model correction, then use the existing local/plan fallback instead of
                    // repeatedly billing the same full-video request across locations.
                    if (invalidJsonResponses >= 2) throw new Error(lastErr);
                    continue;
                }
                requireRemaining();
                const lineCount = Array.isArray(parsed?.lines)
                    ? parsed.lines.length
                    : Array.isArray(parsed?.speech)
                        ? parsed.speech.length
                        : Array.isArray(parsed?.utterances)
                            ? parsed.utterances.length
                            : 0;
                if (onLog) onLog(`[EDIT] Vertex listen ready: ${lineCount} spoken lines @ ${loc}`);
                return parsed;
            } catch (err) {
                if (job && job.cancelled) throw new Error('cancelled');
                if (err?.code === 'SPEAKER_AI_DEADLINE' || (deadlineAt > 0 && remainingMs() <= 0)) throw deadlineError();
                lastErr = err instanceof Error ? err.message : String(err);
                if (invalidJsonResponses >= 2 && lastErr.startsWith('Vertex STT JSON invalid')) throw err;
            }
        }
    }
    throw new Error(lastErr || 'Vertex STT failed');
    } finally {
        clearInterval(pulse);
        if (onLog) onLog(`[EDIT TIMING] speaker AI: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    }
}

async function geminiJsonVideo(apiKey, model, fileUri, prompt, job = null) {
    const modelId = String(model || 'gemini-3.8-flash').replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.8-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ file_data: { mime_type: 'video/mp4', file_uri: fileUri } }, { text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
        signal: jobSignal(null, 12 * 60 * 1000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || `Gemini STT ${res.status}`);
    recordGeminiUsage(job, modelId, j.usageMetadata, 'Nghe thoại (STT)');
    const text = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
    if (!text.trim()) throw new Error('Gemini STT empty');
    return parseJsonObject(text);
}

const sttWordSec = (v) => {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v);
    const n = parseFloat(s.replace('s', ''));
    return Number.isFinite(n) ? n : NaN;
};

async function googleSttWords(auth, inputPath, duration, job, onLog, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const languageCode = String(opts.languageCode || 'en-US');
    const logTag = String(opts.logTag || '[EDIT]');
    const wav = `${inputPath}.stt.wav`;
    await runFf(['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], job);
    const chunkSec = 40;
    const words = [];
    let skippedChunks = 0;
    try {
        for (let t = 0; t < duration + 0.01; t += chunkSec) {
            if (job && job.cancelled) throw new Error('cancelled');
            const part = `${wav}.${Math.round(t)}.wav`;
            await runFf(['-y', '-ss', String(t), '-t', String(chunkSec + 0.35), '-i', wav, '-c', 'copy', part], job);
            let b64 = '';
            try {
                b64 = (await fs.promises.readFile(part)).toString('base64');
            } finally {
                try { fs.unlinkSync(part); } catch { /* ignore */ }
            }
            const chunkEnd = Math.min(duration, t + chunkSec);
            const result = await runGoogleSttChunkWithRetry({
                request: async () => {
                    const res = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${auth.token}`,
                            'Content-Type': 'application/json',
                            'x-goog-user-project': auth.project,
                        },
                        body: JSON.stringify({
                            config: {
                                encoding: 'LINEAR16',
                                sampleRateHertz: 16000,
                                languageCode,
                                enableWordTimeOffsets: true,
                                model: 'latest_long',
                            },
                            audio: { content: b64 },
                        }),
                        signal: jobSignal(job, 120000),
                    });
                    const j = await res.json().catch(() => ({}));
                    return { ok: res.ok, status: res.status, j };
                },
                wait: (ms) => sleepJob(ms, job),
                isCancelled: () => Boolean(job?.cancelled),
                onRetry: ({ attempt, maxAttempts, reason, delayMs }) => onLog?.(
                    `${logTag} Google STT chunk ${t.toFixed(0)}-${chunkEnd.toFixed(0)}s attempt ${attempt}/${maxAttempts} failed: ${reason} — retry in ${Math.round(delayMs / 1000)}s`,
                ),
            });
            if (!result.ok) {
                skippedChunks += 1;
                if (result.permanent) {
                    const msg = result.response?.j?.error?.message || result.reason;
                    onLog?.(`${logTag} STT chunk ${t.toFixed(0)}-${chunkEnd.toFixed(0)}s skipped: ${msg}`.slice(0, 220));
                } else {
                    onLog?.(`${logTag} Google STT chunk ${t.toFixed(0)}-${chunkEnd.toFixed(0)}s skipped after ${result.attempts} attempts`);
                }
                continue;
            }
            const j = result.response.j;
            for (const r of j.results || []) {
                for (const alt of r.alternatives || []) {
                    for (const w of alt.words || []) {
                        const wt = sttWordSec(w.startTime);
                        const we = sttWordSec(w.endTime);
                        if (!Number.isFinite(wt)) continue;
                        words.push({ t: t + wt, end: t + (Number.isFinite(we) ? we : wt), word: String(w.word || '') });
                    }
                }
            }
            onLog?.(`${logTag} STT words ${words.length} through ${Math.min(duration, t + chunkSec).toFixed(0)}s`);
        }
        if (skippedChunks && words.length) {
            onLog?.(`${logTag} Google STT partial: ${words.length} words kept · ${skippedChunks} chunk${skippedChunks === 1 ? '' : 's'} skipped`);
        }
    } finally {
        try { fs.unlinkSync(wav); } catch { /* ignore */ }
    }
    return words;
}

const snapLinesToWords = (lines, words) => {
    if (!lines.length || !words.length) return lines;
    return lines.map((l) => {
        let best = null;
        let bd = 0.55;
        for (const w of words) {
            const d = Math.abs(w.t - l.t);
            if (d < bd && w.t <= l.t + 0.35) { bd = d; best = w; }
        }
        if (!best) return l;
        return { ...l, t: best.t };
    });
};

const planSpeakerIntervals = (plan) => {
    const intervals = [];
    for (const seg of plan?.segments || []) {
        const base = Number(seg.start) || 0;
        const end = Number(seg.end) || base;
        const pieces = Array.isArray(seg.pieces) && seg.pieces.length
            ? seg.pieces
            : [{ start: base, end }];
        const pts = validSpeakerTrackPoints(seg.track)
            .map((p) => {
                const sourceT = sourceTimeForTrackPoint(pieces, p.t, base);
                const piece = pieces.find((x) => sourceT >= Number(x.start) && sourceT <= Number(x.end));
                return {
                    ...p,
                    sourceT,
                    pieceStart: Number(piece?.start ?? base),
                    pieceEnd: Number(piece?.end ?? end),
                };
            })
            .sort((a, b) => a.sourceT - b.sourceT);
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const previous = pts[i - 1];
            const next = pts[i + 1];
            const left = previous?.pieceStart === p.pieceStart
                ? (previous.sourceT + p.sourceT) / 2
                : p.pieceStart;
            const right = next?.pieceStart === p.pieceStart
                ? (p.sourceT + next.sourceT) / 2
                : p.pieceEnd;
            intervals.push({
                start: Math.max(p.pieceStart, left, p.sourceT - 1.5),
                end: Math.min(p.pieceEnd, right, p.sourceT + 1.5),
                t: p.sourceT,
                who: String(p.who).trim(),
                cx: p.cx,
                cy: p.cy,
            });
        }
    }
    return intervals.filter((x) => x.end > x.start);
};

const mapDiarizationToPlan = (turns, plan, onDiagnostic) => {
    const intervals = planSpeakerIntervals(plan);
    if (!intervals.length) return { ok: false, reason: 'PLAN speaker track unavailable' };
    const ranges = (plan?.segments || []).flatMap((seg) => {
        const pieces = Array.isArray(seg.pieces) && seg.pieces.length
            ? seg.pieces
            : [{ start: seg.start, end: seg.end }];
        return pieces.map((p) => ({ start: Number(p.start), end: Number(p.end) }))
            .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);
    });
    return { ...mapDiarizationEvidence(turns, intervals, ranges, onDiagnostic), intervals };
};

const mergeDiarizationWords = (words, mapped) => mapped.mappedTurns.map((turn) => {
    const who = turn.who;
    const mid = (turn.start + turn.end) / 2;
    const text = words
        .filter((w) => {
            const wordMid = (w.t + w.end) / 2;
            return wordMid >= turn.start - 0.12 && wordMid <= turn.end + 0.12;
        })
        .map((w) => w.word)
        .join(' ')
        .trim();
    let position = null;
    let distance = Infinity;
    for (const hint of mapped.intervals) {
        if (String(hint.who).toLowerCase() !== String(who).toLowerCase()) continue;
        const d = Math.abs(hint.t - mid);
        if (d < distance && d <= Math.max(1.5, (turn.end - turn.start) / 2 + 0.5)) {
            distance = d;
            position = hint;
        }
    }
    return {
        t: turn.start,
        end: turn.end,
        who,
        text,
        cx: Number.isFinite(position?.cx) ? position.cx : undefined,
        cy: Number.isFinite(position?.cy) ? position.cy : undefined,
    };
});

const runLocalDiarization = async (inputPath, job) => {
    const wav = `${inputPath}.diar.wav`;
    const helper = path.join(__dirname, 'local_listen_diarize.py');
    try {
        await runFf(['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], job);
        if (!fs.existsSync(diarPython())) throw new Error(`Python not found: ${diarPython()}`);
        if (!fs.existsSync(helper)) throw new Error('Local Listen helper missing');
        const result = await new Promise((resolve, reject) => {
            const child = spawn(diarPython(), [helper, wav], { windowsHide: true, env: process.env });
            if (job) job.ffmpeg = child;
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });
            child.on('error', reject);
            child.on('close', (code) => {
                if (job) job.ffmpeg = null;
                if (job?.cancelled) return reject(new Error('cancelled'));
                if (code !== 0) return reject(new Error((stderr || `diarizer exit ${code}`).trim().slice(-500)));
                resolve(stdout);
            });
        });
        const parsed = JSON.parse(result);
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('diarization empty');
        const turns = parsed.map((x) => ({
            start: Number(x.start),
            end: Number(x.end),
            speakerId: String(x.speakerId || ''),
        })).filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start && x.speakerId);
        if (!turns.length) throw new Error('diarization JSON has no valid turns');
        return turns;
    } finally {
        try { fs.unlinkSync(wav); } catch { /* ignore */ }
    }
};

const speechForSegment = (lines, seg, cutDur) => {
    if (!Array.isArray(lines) || !lines.length) return [];
    const pieces = Array.isArray(seg.pieces) && seg.pieces.length
        ? seg.pieces
        : [{ start: Number(seg.start) || 0, end: Number(seg.end) || 0 }];
    const out = [];
    let acc = 0;
    for (const p of pieces) {
        const p0 = Number(p.start);
        const p1 = Number(p.end);
        if (!Number.isFinite(p0) || !Number.isFinite(p1) || p1 <= p0) continue;
        for (const l of lines) {
            const a = Math.max(l.t, p0);
            const b = Math.min(l.end, p1);
            if (b - a < 0.28) continue;
            out.push({
                ...l,
                t: Math.max(0, acc + (a - p0)),
                end: Math.max(0, acc + (b - p0)),
            });
        }
        acc += (p1 - p0);
    }
    const cap = Number(cutDur) > 1 ? cutDur : acc;
    return out.filter((l) => l.t < cap + 0.2);
};

app.get('/api/edit/adc', async (_req, res) => {
    try {
        const auth = await getAdcAuth();
        res.json({ ok: true, project: auth.project, location: auth.location });
    } catch (err) {
        res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
});


app.post('/api/edit/job', (req, res, next) => {
    upload.single('video')(req, res, (err) => {
        if (err) return rejectMulter(err, req, res, next);
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const jobId = req.file.filename;
        jobs.set(jobId, {
            kind: 'edit',
            inputPath: req.file.path,
            originalName: req.file.originalname,
            originalSize: req.file.size,
            settings: req.body || {},
            status: 'pending',
        });
        res.json({ jobId });
    });
});

app.get('/api/edit/stream/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    if (!job || job.kind !== 'edit') return res.status(404).end();

    const streamSend = subscribeJob(job, res);
    if (!streamSend) return;
    const report = createEditRunReport(jobId, job.originalName, (message) => streamSend('log', { message }));
    const send = (type, data = {}) => {
        report.observe(type, data);
        if (type === 'done' || type === 'error') report.finish(type === 'done' ? 'SUCCESS' : job.cancelled ? 'CANCELLED' : 'ERROR');
        streamSend(type, data);
    };
    job.notify = send;

    const settings = job.settings || {};
    const mode = String(settings.mode || 'ai') === 'even' ? 'even' : 'ai';
    let autoParts = String(settings.autoParts ?? 'false') === 'true';
    let maxParts = autoParts ? 24 : Math.max(2, Math.min(12, Number(settings.maxParts) || 6));
    let minSec = Math.max(60.1, Math.min(300, Number(settings.minSec) || 60));
    const autoCut = String(settings.autoCut ?? 'true') !== 'false';
    const tiktokPad = String(settings.tiktokPad ?? 'false') === 'true';
    // Operator decision 2026-10-01: the general-content path is the default Edit
    // behaviour; SML (letterbox contain / 1:1 fill) stays selectable as a fallback.
    const framingStyle = String(settings.framingStyle ?? 'focus').trim().toLowerCase() === 'sml' ? 'sml' : 'focus';
    const focusStyle = framingStyle === 'focus';
    const tiktokMix = focusStyle || String(settings.tiktokMix ?? 'false') === 'true';
    const speechFraming = settings.speechFraming == null
        ? true
        : String(settings.speechFraming) === 'true';
    const generalVideo = focusStyle || String(settings.generalVideo ?? 'false') === 'true';
    const framingMode = speechFraming || generalVideo;
    // Detail model order for the API-key path: 'safe' (measured ladder, starts at
    // 3.5-flash-lite), 'quality' (try the UI model first) or 'only' (UI model
    // alone). Safe is the default because that is what the 11-video log measured.
    const detailModelMode = (() => {
        const value = String(settings.detailModelMode || '').trim().toLowerCase();
        return value === 'quality' || value === 'only' ? value : 'safe';
    })();
    // Let the app pick the detail mode from its own measured history when the
    // operator leaves the choice on auto (default). Needs enough parts per mode
    // and a real gap, so it stays quiet on a fresh install.
    const detailModelAuto = String(settings.detailModelAuto ?? 'false') === 'true';
    // Resolved later, once the topic is known, so each topic tunes its own mode.
    let runningDetailMode = detailModelMode;
    const fadeFx = String(settings.fadeFx ?? 'false') === 'true';
    const testSec = Math.max(0, Math.min(180, Number(settings.testSec) || 0));
    const localDetailTest = String(settings.localDetailTest ?? 'false') === 'true' && testSec > 0;
    const localDetailNewRange = String(settings.localDetailNewRange ?? 'false') === 'true';
    const localDetailModel = 'qwen3-vl:2b';
    let partFrom = Math.max(1, Math.min(24, Math.round(Number(settings.partFrom) || 1)));
    let partTo = Math.max(0, Math.min(24, Math.round(Number(settings.partTo) || 0)));
    const apiKeys = parseGeminiApiKeys(settings);
    const apiKey = apiKeys[0] || '';
    const model = String(settings.model || 'gemini-3.8-flash');
    const userPrompt = String(settings.prompt || '').trim();
    const requestedEncoder = String(settings.encoderMode || 'auto');
    job.editEncoder = resolveEncoder(requestedEncoder);
    job.editOnLog = (message) => send('log', { message });
    const logEditTiming = (phase, startedAt) => send('log', {
        message: `[EDIT TIMING] ${phase}: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
    });
    const editRunStartedAt = Date.now();
    forgetGeminiSecrets(job.settings);

    try {
        send('log', { message: `[EDIT] RUN job=${jobId} source=${JSON.stringify(job.originalName)} started=${new Date().toISOString()} mode=${mode} model=${localDetailTest ? localDetailModel : model} detailModelMode=${runningDetailMode}${runningDetailMode !== detailModelMode ? ` (auto từ ${detailModelMode})` : ''} geminiKeys=${apiKeys.length} promptHash=${shortPromptHash(userPrompt)} hybrid=${process.env.GHOSTFORGE_HYBRID_DETAIL === '1'} framingStyle=${framingStyle} speechFraming=${speechFraming} generalVideo=${generalVideo} localDetailTest=${localDetailTest} testSec=${testSec} parts=${autoParts ? 'auto' : maxParts} selected=${partFrom}-${partTo || 'all'} minSec=${minSec} encoder=${job.editEncoder}` });
        send('log', { message: '[EDIT] Probe source…' });
        send('progress', { value: 2 });
        let probe = await probeMedia(job.inputPath);
        let duration = probe.durationSec || 0;
        send('log', { message: `[EDIT] Source ${probe.width}x${probe.height} · ${duration.toFixed(1)}s` });
        send('log', { message: `[EDIT] Encoder: ${editEncoderLabel(job.editEncoder)}${job.editEncoder !== requestedEncoder && requestedEncoder !== 'auto' ? ` (fallback from ${requestedEncoder})` : ''}` });
        // (C) Recognise the topic before planning, then apply that topic's workflow
        // to BOTH the global plan and Detail. A pinned topic skips the call.
        const topicPin = String(settings.topicPin || '').trim().toLowerCase();
        let topicProfileResolved = resolveTopic({}, topicPin);
        if (mode === 'ai' && focusStyle && !testSec) {
            if (topicPin) {
                send('log', { message: `[TOPIC] ${topicProfileResolved.key} · ghim tay · hồ sơ: ${topicProfileResolved.label}` });
            } else {
                const topicStartedAt = Date.now();
                let classified = null;
                try {
                    const auth = apiKey ? null : await getAdcAuth();
                    classified = await classifyVideoTopic({
                        srcPath: job.inputPath,
                        duration,
                        job,
                        onLog: (message) => send('log', { message }),
                        apiKey,
                        auth,
                        model,
                    });
                } catch (topicErr) {
                    const message = topicErr instanceof Error ? topicErr.message : String(topicErr);
                    if (/cancell/i.test(message) || job.cancelled) throw topicErr;
                    send('log', { message: `[TOPIC] Không nhận dạng được: ${message}`.slice(0, 200) });
                } finally {
                    logEditTiming('topic classify', topicStartedAt);
                }
                topicProfileResolved = resolveTopic(classified || {}, topicPin);
                send('log', { message: `[TOPIC] ${topicProfileResolved.key}${topicProfileResolved.confidence != null ? ` (${(topicProfileResolved.confidence * 100).toFixed(0)}%)` : ''} · hồ sơ: ${topicProfileResolved.label}${topicProfileResolved.key === 'generic' ? ' (không đủ chắc → dùng luật chung)' : ''}` });
            }
            // Detail mode: prefer the evidence of THIS topic, fall back to the
            // whole history. Two topics never borrow each other's numbers.
            if (detailModelAuto) {
                try {
                    const entries = readEditQaHistory().entries;
                    const topicSuggestion = suggestDetailConfig(entries, { topic: topicProfileResolved.key });
                    const globalSuggestion = suggestDetailConfig(entries);
                    const suggestion = topicSuggestion || globalSuggestion;
                    if (suggestion) {
                        runningDetailMode = suggestion.detailModelMode;
                        send('log', { message: `[QA] Tự chọn chế độ Detail${topicSuggestion ? ` theo chủ đề ${topicProfileResolved.key}` : ' (toàn bộ lịch sử)'}: ${suggestion.detailModelMode} — ${suggestion.reason}` });
                    } else {
                        send('log', { message: `[QA] Tự chọn chế độ Detail: chưa đủ dữ liệu cho chủ đề ${topicProfileResolved.key} (cần ≥12 part mỗi chế độ, lệch ≥5 điểm) — giữ ${runningDetailMode}.` });
                    }
                } catch { /* history unreadable: keep the requested mode */ }
            }
        }
        const topicAddon = topicProfileResolved?.addon ? `\n\n${topicProfileResolved.addon}` : '';
        if (duration < 3) throw new Error('Video too short to cut');
        if (testSec > 0) {
            partFrom = 1;
            partTo = 0;
            const take = Math.min(testSec, Math.max(8, duration));
            const sourceKey = job.keepInput
                ? `${path.resolve(job.inputPath)}|${job.originalSize}`
                : `${job.originalName}|${job.originalSize}`;
            const savedRange = localDetailTest ? readLocalDetailRange() : null;
            const selectedRange = localDetailTest
                ? chooseLocalTestRange({ duration, take, stored: savedRange?.sourceKey === sourceKey ? savedRange : null, newRandom: localDetailNewRange })
                : chooseLocalTestRange({ duration, take, stored: null, newRandom: true });
            const ss = selectedRange.start;
            if (localDetailTest) writeLocalDetailRange({ sourceKey, sourceName: job.originalName, duration, start: ss, take });
            const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
            const trimPath = path.join(uploadsDir, `${jobId}_test.mp4`);
            send('log', { message: localDetailTest
                ? `[EDIT] TEST LOCAL ${selectedRange.reused ? 'repeat saved range' : 'new random range'} ${take.toFixed(0)}s @ ${fmt(ss)}–${fmt(ss + take)} / ${fmt(duration)} — ${localDetailModel}; no Vertex/STT API`
                : `[EDIT] TEST random ${take.toFixed(0)}s @ ${fmt(ss)}–${fmt(ss + take)} / ${fmt(duration)} — Gemini CHỈ xem đoạn này (1 API, không xem full)` });
            try {
                await runEditEncode([
                    '-y', '-ss', String(ss), '-t', String(take), '-i', job.inputPath,
                ], [
                    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', trimPath,
                ], job, 22, true);
            } catch {
                await runFf(['-y', '-ss', String(ss), '-t', String(take), '-i', job.inputPath, '-c', 'copy', '-movflags', '+faststart', trimPath], job);
            }
            job.inputPath = trimPath;
            job.testTrimPath = trimPath;
            job.testStart = ss;
            probe = await probeMedia(trimPath);
            duration = probe.durationSec || take;
            autoParts = false;
            maxParts = 1;
            minSec = Math.max(12, Math.min(25, take * 0.35));
            send('log', { message: `[EDIT] TEST ready ${probe.width}x${probe.height} · ${duration.toFixed(1)}s · 1 part` });
        }
        if (!autoParts && duration < maxParts * minSec) {
            send('log', { message: `[EDIT] WARN: ${maxParts} parts × >${minSec.toFixed(0)}s needs ~${(maxParts * minSec).toFixed(0)}s of keepable footage. Source is ${duration.toFixed(0)}s — Gemini will still aim for ${maxParts}; some parts may drop if the video is too short.` });
        }

        let plan;
        let speechAll = [];
        if (mode === 'even') {
            plan = { summary: `Even split into ${maxParts} (min ${minSec}s)`, segments: evenSplitPlan(duration, maxParts, minSec, autoParts) };
            send('log', { message: `[EDIT] Even plan: ${plan.segments.length} parts${autoParts ? ' (auto-N)' : ''}` });
        } else {
            if (!userPrompt) throw new Error('Write a cut prompt so Gemini knows what you want');
            if (localDetailTest) {
                send('log', { message: `[EDIT] Local Detail TEST: ${localDetailModel} · visual JPEG evidence only · no Vertex/Gemini/Google STT` });
                send('progress', { value: 8, phase: 'local-evidence' });
                const sceneCuts = await detectSceneTimes(job.inputPath, duration, job);
                // Qwen3-VL consumes about 1K visual tokens per JPEG. Keep this
                // experimental 4GB-VRAM request below its 8K context window so all layers stay on GPU.
                const evidence = buildDetailEvidenceTimes({ duration, sceneCuts, maxObservationGap: Math.max(4, duration / 6), maxSamples: 6 });
                const frames = await extractDetailEvidenceJpegs(job.inputPath, evidence, job, (m) => send('log', { message: m }), 6);
                send('log', { message: `[EDIT] Local Detail evidence: ${frames.length} JPEGs · sceneCuts=${sceneCuts.length}` });
                send('progress', { value: 18, phase: 'local-detail' });
                const localResult = await generateLocalDetail({
                    rootDir: __dirname,
                    model: localDetailModel,
                    prompt: localDetailPrompt({ duration, userPrompt, sceneCuts }),
                    frames,
                    signal: ensureAbort(job).signal,
                    onLog: (m) => send('log', { message: m }),
                });
                send('log', { message: `[EDIT] Local Detail raw: ${localResult.content.length} chars · head=${JSON.stringify(String(localResult.content).slice(0, 180))}` });
                plan = localDetailPlanFromModel(localResult.content, duration);
                const rawSeg = plan._raw?.segments?.[0] || plan._raw?.clips?.[0];
                if (rawSeg) rawSeg.frames = coalesceLocalFrames(rawSeg.frames, duration);
                const localFrames = parseFraming(rawSeg, 0, duration, sceneCuts);
                const localTrack = parseSpeakerTrack(rawSeg, 0, duration);
                send('log', { message: `[EDIT] Local Detail structure: raw frames=${rawSeg?.frames?.length ?? 0} track=${rawSeg?.track?.length ?? 0} · parsed frames=${localFrames.length} track=${localTrack.length}` });
                if (!localFrames.length) {
                    send('log', { message: `[EDIT] Local Detail frame dump: ${JSON.stringify(rawSeg?.frames || []).slice(0, 1800)}` });
                }
                validateLocalFraming(localFrames, localTrack, (message) => send('log', { message }));
                plan.segments[0] = {
                    ...plan.segments[0], start: 0, end: duration, dur: round1(duration),
                    pieces: [{ start: 0, end: duration, role: 'body' }], ranges: [[0, duration]],
                    script: `body 0–${round1(duration)}`, frames: localFrames, track: localTrack,
                };
                send('log', { message: `[EDIT] Local Detail metrics: total=${localResult.metrics.totalSec.toFixed(2)}s load=${localResult.metrics.loadSec.toFixed(2)}s promptTokens=${localResult.metrics.promptTokens} outputTokens=${localResult.metrics.outputTokens}` });
                logParsedDetailWindows(localFrames, 'LOCAL Detail', (message) => send('log', { message }));
            } else {
            send('log', { message: '[EDIT] Making a small proxy for Gemini (watch + listen)…' });
            send('progress', { value: 8 });
            const proxyPath = path.join(uploadsDir, `${jobId}_gemini.mp4`);
            job.proxyPath = proxyPath;
            const planProxyStartedAt = Date.now();
            await runEditEncode([
                '-y', '-i', job.inputPath,
                '-vf', "scale='min(854,iw)':-2",
                '-r', '12',
            ], [
                '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
                '-movflags', '+faststart',
                proxyPath,
            ], job, 32, true);
            logEditTiming('plan proxy generation', planProxyStartedAt);
            const proxyMb = (fs.statSync(proxyPath).size / 1024 / 1024).toFixed(1);
            send('log', { message: `[EDIT] Proxy ready ${proxyMb}MB` });
            send('progress', { value: 15 });

            const waitPulse = (label) => {
                const estMs = Math.min(8 * 60 * 1000, Math.max(50 * 1000, duration * 500));
                const t0 = Date.now();
                send('log', { message: `[EDIT] ${label} — clip ${duration.toFixed(0)}s, ước tính ~${Math.round(estMs / 1000)}s` });
                send('progress', { value: 16, watch: 1, phase: 'watching' });
                let lastLogged = 0;
                return setInterval(() => {
                    if (job.cancelled) return;
                    const elapsed = Date.now() - t0;
                    const watch = Math.min(99, Math.max(1, Math.round((elapsed / estMs) * 100)));
                    const overall = 16 + Math.round(watch * 0.24);
                    send('progress', { value: overall, watch, phase: 'watching' });
                    if (watch >= lastLogged + 5) {
                        lastLogged = watch;
                        send('log', { message: `[EDIT] Gemini watching ${watch}% (${Math.round(elapsed / 1000)}s)` });
                    }
                }, 1000);
            };

            const generalMin = Math.max(60, minSec);
            const generalCap = Math.max(1, Math.floor(duration / generalMin));
            const isTestWatch = testSec > 0;
            // Focus style plans with the general-content 9:16 prompt; SML keeps
            // whatever the operator wrote plus the SML framing contract. TEST is
            // always ONE part covering the trimmed excerpt, so it never uses the
            // >1 minute production rule.
            const planPromptOverride = focusStyle
                ? (isTestWatch
                    ? focusDetailPrompt(duration, Math.max(8, minSec), null, userPrompt) + topicAddon
                    : focusEditorPrompt(duration, generalMin, userPrompt) + topicAddon)
                : (generalVideo && !isTestWatch ? generalEditorPrompt(duration, generalMin) : null);
            const planParts = isTestWatch ? 1 : (generalVideo ? generalCap : maxParts);
            const planMinSec = isTestWatch ? Math.max(8, minSec) : (generalVideo ? generalMin : minSec);
            const planAutoParts = isTestWatch ? false : (generalVideo ? true : autoParts);
            const planPartCap = isTestWatch ? null : (generalVideo ? generalCap : null);
            const useGeminiTest = testSec > 0 && Boolean(apiKey);
            if (useGeminiTest) {
                const testModel = 'gemini-3.1-flash-lite';
                send('log', { message: `[EDIT] TEST uses Gemini API (${testModel})` });
                const uploaded = await geminiUploadVideo(apiKey, proxyPath, job.originalName);
                const hb = waitPulse('Gemini 3.1 Flash-Lite is watching the test clip');
                try {
                    let lastTestErr = null;
                    for (let attempt = 1; attempt <= 3; attempt += 1) {
                        try {
                            plan = await geminiGeneratePlan(
                                apiKey, testModel, uploaded.uri, userPrompt, duration,
                                planParts,
                                planMinSec,
                                planAutoParts,
                                tiktokMix,
                                true,
                                null,
                                0.2,
                                planPromptOverride,
                                planPartCap,
                            );
                            lastTestErr = null;
                            break;
                        } catch (testErr) {
                            lastTestErr = testErr;
                            const testMessage = testErr instanceof Error ? testErr.message : String(testErr);
                            if (attempt === 3 || job.cancelled || !isTemporaryGeminiErr(testMessage)) break;
                            const waitMs = attempt * 20000;
                            send('log', { message: `[EDIT] TEST Gemini tạm quá tải — đợi ${Math.round(waitMs / 1000)}s rồi gọi lại (${attempt}/3)` });
                            await sleepJob(waitMs, job);
                        }
                    }
                    if (lastTestErr) throw lastTestErr;
                } finally {
                    clearInterval(hb);
                    await geminiDeleteFile(apiKey, uploaded.name);
                    try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
                }
            } else {
            send('log', { message: generalVideo
                ? (focusStyle
                    ? '[EDIT] Focus 9:16: Vertex ADC plans the highlight parts (auto count, > 1 phút). Focus vẽ 3:4 trên nền mờ, split phủ kín.'
                    : '[EDIT] General video: Vertex ADC plans highlights. SML framing rules stay off.')
                : (apiKey
                    ? '[EDIT] Global plan uses Vertex ADC. Gemini API key is kept for Detail.'
                    : '[EDIT] Using Google Cloud ADC (gcloud login)…') });
            const auth = await getAdcAuth();
            send('log', { message: `[EDIT] ADC project ${auth.project} · ${auth.location} · ${model}` });
            const hb = waitPulse('Vertex Gemini is watching the video');
            try {
                plan = await vertexGeneratePlan(
                    auth, model, proxyPath, userPrompt, duration,
                    planParts,
                    planMinSec,
                    job,
                    (m) => send('log', { message: m }),
                    planAutoParts,
                    tiktokMix,
                    testSec > 0,
                    'plan AI',
                    null,
                    0.2,
                    planPromptOverride,
                    planPartCap,
                );
            } finally {
                clearInterval(hb);
                try { fs.unlinkSync(proxyPath); } catch { /* ignore */ }
                try { fs.unlinkSync(proxyPath.replace(/\.mp4$/i, '_small.mp4')); } catch { /* ignore */ }
                for (let i = 1; i <= 6; i++) {
                    try { fs.unlinkSync(proxyPath.replace(/\.mp4$/i, `_s${i}.mp4`)); } catch { /* ignore */ }
                }
            }
            }
            }
            send('progress', { value: 42, watch: 100, phase: 'plan' });
            if (!testSec) {
                const rawSegments = plan._raw?.segments || plan._raw?.clips || [];
                const compact = (value) => String(JSON.stringify(value) ?? 'missing').replace(/[\r\n\t]/g, ' ').slice(0, 400);
                send('log', { message: `[EDIT] Global PLAN segments: raw=${rawSegments.length} parsed=${plan.segments.length}` });
                for (const entry of plan._segmentDiagnostics || []) {
                    const raw = rawSegments[entry.index - 1];
                    send('log', { message: `[EDIT] Global raw segment ${entry.index}: start=${compact(raw?.start)} end=${compact(raw?.end)} pieces=${compact(raw?.pieces || raw?.script || raw?.keep || raw?.ranges)} -> ${entry.status} ranges=${compact(entry.ranges)}` });
                }
            }
            send('log', { message: `[EDIT] ${localDetailTest ? 'Local Detail' : 'Gemini'}: ${plan.summary || 'plan ready'} · ${plan.segments.length} parts${autoParts ? ' (auto from content)' : ` (fixed ${maxParts})`}` });
            if (plan.segments.length) {
                const last = plan.segments[plan.segments.length - 1];
                const tail = Math.max(0, duration - last.end);
                if (tail >= 0.4) {
                    send('log', { message: `[EDIT] Last clip ends ${tail.toFixed(1)}s before EOF (unverified tail; not confirmed outro)` });
                }
            }
            send('log', { message: '[EDIT] # | TITLE | VI | START–END | DUR' });
            plan.segments.forEach((seg, i) => {
                send('log', {
                    message: `[EDIT] ${i + 1} | ${seg.title || seg.name} | ${seg.titleVi || '—'} | ${seg.script || `${seg.start}–${seg.end}`} | ${seg.dur}s · ${(seg.ranges || []).length} piece(s)`,
                });
                if (tiktokMix && Array.isArray(seg.frames) && seg.frames.length) {
                    const brief = seg.frames.map((w) => {
                        const aim = Number.isFinite(w.cx) ? `@${Number(w.cx).toFixed(2)}` : '';
                        return `${w.mode === 'fill' ? 'CLOSE' : 'WIDE'} ${Number(w.a).toFixed(0)}–${Number(w.b).toFixed(0)}${aim}`;
                    }).join(' · ');
                    send('log', { message: `[EDIT]    framing: ${brief}` });
                    if (Array.isArray(seg.track) && seg.track.length) {
                        send('log', { message: `[EDIT]    speaker track: ${seg.track.length} pts` });
                    }
                }
            });
        }

        if (mode === 'ai' && !testSec && !generalVideo) applyGlobalCoveragePolicy(plan, duration, minSec, (message) => send('log', { message }));

        const detailPlanSegmentIndexes = new Set();
        if (localDetailTest && plan?.segments?.[0]?.frames?.length) detailPlanSegmentIndexes.add(0);
        // Focus path: Detail per part ALWAYS runs (operator decision 2026-10-01).
        // It is the second AI pass that re-watches each cut part and replaces its
        // framing windows; without it a part the global plan described with one
        // window sits on a single static crop for its whole length.
        const usePerPartDetail = focusStyle
            ? (mode === 'ai' && testSec <= 0 && Number(plan?.segments?.length) >= 1)
            : shouldUsePerPartDetailPlan({ mode, tiktokMix, testSec, segmentCount: plan?.segments?.length, speechFraming: framingMode });
        if (speechFraming && tiktokMix && !testSec) {
            send('log', { message: apiKey
                ? '[EDIT] Speech framing: bỏ Detail Gemini. Tắt Khung thoại để lần 2 dùng API key.'
                : '[EDIT] Speech framing: một lần Vertex chia tập. Bỏ Detail từng part. Contain/fill theo STT và RGB.' });
        }
        const hybridDetailEnabled = process.env.GHOSTFORGE_HYBRID_DETAIL === '1' && usePerPartDetail;
        let hybridRawTurns = null;
        let hybridRawWords = null;
        if (hybridDetailEnabled) {
            send('log', { message: '[EDIT] Hybrid Detail V1 enabled' });
            const hybridDiarStartedAt = Date.now();
            try {
                hybridRawTurns = await runLocalDiarization(job.inputPath, job);
            } catch (hybridDiarErr) {
                const message = hybridDiarErr instanceof Error ? hybridDiarErr.message : String(hybridDiarErr);
                if (/cancell/i.test(message) || job.cancelled) throw hybridDiarErr;
                send('log', { message: `[EDIT] Hybrid raw diarization unavailable: ${message}`.slice(0, 240) });
            } finally {
                logEditTiming('local speaker diarization', hybridDiarStartedAt);
            }
            const hybridSttStartedAt = Date.now();
            try {
                const auth = await getAdcAuth();
                hybridRawWords = await googleSttWords(
                    auth, job.inputPath, duration, job,
                    (message) => send('log', { message }),
                );
            } catch (hybridSttErr) {
                const message = hybridSttErr instanceof Error ? hybridSttErr.message : String(hybridSttErr);
                if (/cancell/i.test(message) || job.cancelled) throw hybridSttErr;
                send('log', { message: `[EDIT] Hybrid raw STT unavailable: ${message}`.slice(0, 240) });
            } finally {
                logEditTiming('Google STT', hybridSttStartedAt);
            }
        }
        if (usePerPartDetail) {
            const lastDetail = partTo > 0 ? partTo : plan.segments.length;
            const detailTargets = plan.segments
                .map((seg, index) => ({ seg, index }))
                .filter(({ index }) => index + 1 >= partFrom && index + 1 <= lastDetail);
            let detailEnriched = 0;
            let detailFallback = 0;
            for (let detailIndex = 0; detailIndex < detailTargets.length; detailIndex++) {
                const { seg, index } = detailTargets[detailIndex];
                const ordinal = `${index + 1}/${plan.segments.length}`;
                const detailMedia = path.join(uploadsDir, `${jobId}_detail_${index + 1}.mp4`);
                const detailProxy = path.join(uploadsDir, `${jobId}_detail_${index + 1}_gemini.mp4`);
                try {
                    await cutEditClip(job.inputPath, detailMedia, seg, job, false);
                    const detailProbe = await probeMedia(detailMedia);
                    const detailDuration = Number(detailProbe.durationSec) || Number(seg.dur) || 0;
                    const pieceCount = Array.isArray(seg.pieces) && seg.pieces.length ? seg.pieces.length : 1;
                    const detailSceneCuts = compactSceneCutHints(
                        await detectSceneTimes(detailMedia, detailDuration, job),
                        detailDuration,
                    );
                    send('log', { message: `[EDIT] Detail PLAN ${ordinal}: ${pieceCount} piece${pieceCount === 1 ? '' : 's'} · local ${detailDuration.toFixed(1)}s` });
                    send('log', { message: `[EDIT] Detail PLAN ${ordinal}: ${detailSceneCuts.length} candidate scene cuts` });
                    send('log', { message: `[EDIT] Detail settings ${ordinal}: model UI=${model} (thang ${runningDetailMode}) promptHash=${shortPromptHash(userPrompt)} sceneCuts=${detailSceneCuts.length} temperature=0` });

                    const detailMinSec = Math.max(12, Math.min(25, detailDuration * 0.35));
                    const detailPromptOverride = focusStyle
                        ? focusDetailPrompt(detailDuration, detailMinSec, detailSceneCuts, userPrompt) + topicAddon
                        : null;
                    let detailPlan = null;
                    if (hybridDetailEnabled) {
                        try {
                            if (!Array.isArray(hybridRawTurns) || !Array.isArray(hybridRawWords)) {
                                throw new Error('raw diarization/STT evidence unavailable');
                            }
                            const partWords = mapWordsToPartTimeline(seg, hybridRawWords);
                            const partTurns = mapDiarizationToPartTimeline(seg, hybridRawTurns);
                            const evidenceEvents = buildDetailEvidenceTimes({
                                duration: detailDuration,
                                sceneCuts: detailSceneCuts,
                                words: partWords,
                                diarTurns: partTurns,
                            });
                            const evidenceFrames = await extractDetailEvidenceJpegs(
                                detailMedia,
                                evidenceEvents,
                                job,
                                (message) => send('log', { message }),
                            );
                            send('log', { message: `[EDIT] Hybrid Detail ${ordinal} evidence: ${evidenceFrames.length} frames` });
                            const evidenceText = JSON.stringify({
                                part: {
                                    title: seg.title || seg.name || '',
                                    duration: detailDuration,
                                    globalFrames: seg.frames || [],
                                    globalTrack: seg.track || [],
                                },
                                sceneCuts: detailSceneCuts,
                                words: partWords,
                                diarization: partTurns,
                            });
                            const auth = await getAdcAuth();
                            detailPlan = await vertexGenerateDetailMultimodal(
                                auth, model, evidenceFrames, evidenceText, userPrompt,
                                detailDuration, detailMinSec, job,
                                (message) => send('log', { message }),
                                detailSceneCuts,
                                detailPromptOverride,
                            );
                            const hybridDetailSeg = detailPlan?.segments?.[0];
                            if (!hybridDetailSeg?.frames?.length || !hybridDetailSeg?.track?.length) {
                                throw new Error('hybrid detail PLAN missing framing or speaker track');
                            }
                            send('log', { message: `[EDIT] Hybrid Detail ${ordinal} success` });
                        } catch (hybridDetailErr) {
                            const message = hybridDetailErr instanceof Error ? hybridDetailErr.message : String(hybridDetailErr);
                            if (/cancell/i.test(message) || job.cancelled) throw hybridDetailErr;
                            detailPlan = null;
                            send('log', { message: `[EDIT] Hybrid Detail ${ordinal} failed → video Detail fallback (${message})`.slice(0, 260) });
                        }
                    }
                    if (!detailPlan) {
                        const detailProxyStartedAt = Date.now();
                        try {
                            await runEditEncode([
                                '-y', '-i', detailMedia,
                                '-vf', "scale='min(854,iw)':-2",
                                '-r', '12',
                            ], [
                                '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
                                '-movflags', '+faststart',
                                detailProxy,
                            ], job, 32, true);
                        } finally {
                            logEditTiming(`detail proxy ${ordinal}`, detailProxyStartedAt);
                        }
                        if (apiKeys.length) {
                            const detailAiStartedAt = Date.now();
                            try {
                                detailPlan = await geminiDetailAcrossModels(
                                    apiKeys, detailProxy, userPrompt, detailDuration, detailMinSec, detailSceneCuts, job,
                                    (message) => send('log', { message }),
                                    `Detail ${ordinal}`,
                                    detailPromptOverride,
                                    model,
                                    runningDetailMode,
                                );
                            } finally {
                                logEditTiming(`detail AI ${ordinal}`, detailAiStartedAt);
                            }
                        } else {
                            const auth = await getAdcAuth();
                            detailPlan = await vertexGeneratePlan(
                                auth, model, detailProxy, userPrompt,
                                detailDuration, 1, detailMinSec, job,
                                (m) => send('log', { message: m }),
                                false, true, true, `detail AI ${ordinal}`, detailSceneCuts, 0,
                                detailPromptOverride,
                            );
                        }
                    }
                    let detailSeg = detailPlan?.segments?.[0];
                    if (!detailSeg?.frames?.length || !detailSeg?.track?.length) {
                        throw new Error('detail PLAN missing framing or speaker track');
                    }
                    const detailModelUsed = String(detailPlan?._modelUsed || '');
                    // (A) A Detail plan that describes only part of the part leaves the
                    // rest of the crop unaimed (measured: 19 % of a 134 s part). Ask
                    // once more with the gap spelled out, keep the better answer.
                    let detailCoverage = framesCoverage(detailSeg.frames, detailDuration);
                    if (detailCoverage < 0.8 && !job?.cancelled) {
                        const repairInstruction = `\n\nREPAIR: your previous answer described only ${(detailCoverage * 100).toFixed(0)}% of this ${detailDuration.toFixed(1)} second part. Return frames[] that cover the WHOLE part from 0.0 to ${detailDuration.toFixed(1)} with no gaps, and a track[] point about every 1.5 seconds.`;
                        try {
                            const repaired = apiKeys.length
                                ? await geminiDetailAcrossModels(
                                    apiKeys, detailProxy, userPrompt, detailDuration, detailMinSec, detailSceneCuts, job,
                                    (message) => send('log', { message }),
                                    `Detail ${ordinal} bù phủ`,
                                    `${detailPromptOverride || ''}${repairInstruction}`,
                                    model,
                                    runningDetailMode,
                                )
                                : await vertexGeneratePlan(
                                    await getAdcAuth(), model, detailProxy, userPrompt, detailDuration, 1, detailMinSec, job,
                                    (m) => send('log', { message: m }),
                                    false, true, true, `detail AI ${ordinal} bù phủ`, detailSceneCuts, 0,
                                    `${detailPromptOverride || ''}${repairInstruction}`,
                                );
                            const repairedSeg = repaired?.segments?.[0];
                            const repairedCoverage = repairedSeg ? framesCoverage(repairedSeg.frames, detailDuration) : 0;
                            if (repairedSeg?.frames?.length && repairedSeg?.track?.length && repairedCoverage > detailCoverage) {
                                send('log', { message: `[EDIT] Detail ${ordinal} bù phủ: ${(detailCoverage * 100).toFixed(0)}% → ${(repairedCoverage * 100).toFixed(0)}%` });
                                detailPlan = repaired;
                                detailSeg = repairedSeg;
                                detailCoverage = repairedCoverage;
                            } else {
                                send('log', { message: `[EDIT] Detail ${ordinal} bù phủ không tốt hơn (giữ ${(detailCoverage * 100).toFixed(0)}%)` });
                            }
                        } catch (repairErr) {
                            const message = repairErr instanceof Error ? repairErr.message : String(repairErr);
                            if (/cancell/i.test(message) || job.cancelled) throw repairErr;
                            send('log', { message: `[EDIT] Detail ${ordinal} bù phủ bỏ qua: ${message}`.slice(0, 200) });
                        }
                    } else if (detailCoverage < 0.8) {
                        send('log', { message: `[EDIT] Detail ${ordinal} chỉ phủ ${(detailCoverage * 100).toFixed(0)}% — phần còn lại do bù RGB local lo` });
                    }
                    const rawDetailSegments = detailPlan?._raw?.segments || detailPlan?._raw?.clips || [];
                    const rawDetailSeg = Array.isArray(rawDetailSegments) ? rawDetailSegments[0] : null;
                    const rawDetailFrames = rawDetailSeg
                        ? (rawDetailSeg.frames || rawDetailSeg.framing || rawDetailSeg.shots || rawDetailSeg.layout || [])
                        : [];
                    const rawModeCounts = { contain: 0, fill: 0, other: 0 };
                    for (const frame of Array.isArray(rawDetailFrames) ? rawDetailFrames : []) {
                        const rawMode = Array.isArray(frame)
                            ? frame[2]
                            : frame?.mode || frame?.kind || frame?.framing || frame?.type;
                        const normalizedMode = normalizeFrameMode(rawMode);
                        if (normalizedMode === 'contain') rawModeCounts.contain += 1;
                        else if (normalizedMode === 'fill') rawModeCounts.fill += 1;
                        else rawModeCounts.other += 1;
                    }
                    const parsedContain = detailSeg.frames.filter((frame) => frame?.mode === 'contain').length;
                    const parsedFill = detailSeg.frames.filter((frame) => frame?.mode === 'fill').length;
                    send('log', { message: `[EDIT] Detail PLAN ${ordinal} modes: raw contain=${rawModeCounts.contain} fill=${rawModeCounts.fill} other=${rawModeCounts.other} · parsed contain=${parsedContain} fill=${parsedFill}` });
                    logParsedDetailWindows(detailSeg.frames, 'Detail', (message) => send('log', { message }));
                    plan.segments[index] = mergeSegmentDetail(seg, detailSeg);
                    if (detailModelUsed) plan.segments[index]._detailModelUsed = detailModelUsed;
                    detailPlanSegmentIndexes.add(index);
                    detailEnriched += 1;
                    send('log', { message: `[EDIT] Detail PLAN ${ordinal}: ${detailSeg.frames.length} framing windows · ${detailSeg.track.length} speaker pts${detailModelUsed ? ` · model thật ${detailModelUsed}` : ''}` });
                } catch (detailErr) {
                    const message = detailErr instanceof Error ? detailErr.message : String(detailErr);
                    if (/cancell/i.test(message) || job.cancelled) throw detailErr;
                    detailFallback += 1;
                    send('log', { message: `[EDIT] Detail PLAN ${ordinal} failed — using global PLAN fallback (${message})`.slice(0, 240) });
                } finally {
                    try { fs.unlinkSync(detailMedia); } catch { /* ignore */ }
                    try { fs.unlinkSync(detailProxy); } catch { /* ignore */ }
                    try { fs.unlinkSync(detailProxy.replace(/\.mp4$/i, '_small.mp4')); } catch { /* ignore */ }
                    for (let shrinkIndex = 1; shrinkIndex <= 6; shrinkIndex++) {
                        try { fs.unlinkSync(detailProxy.replace(/\.mp4$/i, `_s${shrinkIndex}.mp4`)); } catch { /* ignore */ }
                    }
                }
            }
            send('log', { message: `[EDIT] Detail PLAN complete: ${detailEnriched}/${detailTargets.length} enriched · ${detailFallback} fallback` });
        }

        // STT/diarization run only on the parts that will actually be rendered.
        // Measured on the 21-minute test: the whole-file listen cost 410 s while
        // only 312 s of video was kept. A concatenated "keep" file is built, the
        // plan is re-timed onto that timeline so the speaker mapping still works,
        // and speech lines are split back per part by `speechForKeptPart`.
        const keepIndexes = [];
        for (let index = 0; index < (plan?.segments?.length || 0); index += 1) {
            const lastKeep = partTo > 0 ? partTo : plan.segments.length;
            if (testSec > 0 || (index + 1 >= partFrom && index + 1 <= lastKeep)) keepIndexes.push(index);
        }
        let keepPlan = plan;
        let keepSpeechPlan = null;
        let keepPath = null;
        if (mode === 'ai' && tiktokMix && !testSec && keepIndexes.length && duration > 0) {
            const ranges = [];
            const offsets = [];
            let acc = 0;
            for (const index of keepIndexes) {
                const seg = plan.segments[index];
                const pieces = Array.isArray(seg.ranges) && seg.ranges.length
                    ? seg.ranges
                    : [[Number(seg.start) || 0, Number(seg.end) || 0]];
                const startAt = acc;
                for (const [a, b] of pieces) {
                    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
                    ranges.push([a, b]);
                    acc += b - a;
                }
                offsets.push({ index, start: startAt, dur: Math.max(0, acc - startAt) });
            }
            const keptSec = acc;
            if (keptSec > 0 && keptSec < duration * 0.9) {
                const candidate = path.join(uploadsDir, `${jobId}_keep.mp4`);
                try {
                    await cutEditClip(job.inputPath, candidate, { ranges }, job, false);
                    const keepProbe = await probeMedia(candidate).catch(() => null);
                    const keepDur = Number(keepProbe?.durationSec) || keptSec;
                    const segments = plan.segments.map((seg, index) => {
                        const found = offsets.find((entry) => entry.index === index);
                        if (!found) return { ...seg, pieces: [], ranges: [] };
                        return {
                            ...seg,
                            start: found.start,
                            end: found.start + found.dur,
                            pieces: [{ start: found.start, end: found.start + found.dur }],
                            ranges: [[found.start, found.start + found.dur]],
                        };
                    });
                    keepPlan = { ...plan, segments };
                    keepSpeechPlan = { offsets, keepDur };
                    keepPath = candidate;
                    send('log', { message: `[EDIT] STT gọn: chỉ nghe ${keptSec.toFixed(0)}s trong ${duration.toFixed(0)}s (bỏ ${(duration - keptSec).toFixed(0)}s không dùng)` });
                } catch (keepErr) {
                    const message = keepErr instanceof Error ? keepErr.message : String(keepErr);
                    if (/cancell/i.test(message) || job.cancelled) throw keepErr;
                    keepPath = null;
                    keepPlan = plan;
                    keepSpeechPlan = null;
                    send('log', { message: `[EDIT] STT gọn không dựng được file ghép — nghe toàn video như cũ: ${message}`.slice(0, 200) });
                }
            }
        }
        const listenPath = keepPath || job.inputPath;
        const listenDuration = keepSpeechPlan ? keepSpeechPlan.keepDur : duration;

        if (tiktokMix && mode === 'ai') {
            if (localDetailTest) {
                send('log', { message: '[EDIT] Local Detail TEST: skip Local Listen and Google/Vertex STT; visual framing evaluation only' });
            } else if (process.env.GHOSTFORGE_VERTEX_LISTEN !== '1') {
                send('log', { message: '[EDIT] Local Listen: pyannote diarization' });
                send('progress', { value: 43, watch: 100, phase: 'stt' });
                const fallbackSpeech = plan?._raw ? parseSpeechLines(plan._raw, duration) : [];
                let localTurns = hybridRawTurns;
                let localMapping = null;
                try {
                    if (!Array.isArray(localTurns)) {
                        const localDiarStartedAt = Date.now();
                        try {
                            localTurns = await runLocalDiarization(listenPath, job);
                        } finally {
                            logEditTiming('local speaker diarization', localDiarStartedAt);
                        }
                    }
                    localMapping = mapDiarizationToPlan(
                        localTurns,
                        keepPlan,
                        (message) => send('log', { message }),
                    );
                    if (!localMapping.ok) throw new Error(localMapping.reason);
                    send('log', {
                        message: `[EDIT] Local Listen: ${localMapping.globalMappedClusters} global clusters · `
                            + `${localMapping.locallyValidatedTurns} locally validated turns · `
                            + `${localMapping.localOverrides} overrides · ${localMapping.ambiguousTurns.length} unresolved turns`,
                    });
                } catch (localErr) {
                    const message = localErr instanceof Error ? localErr.message : String(localErr);
                    if (/cancell/i.test(message) || job.cancelled) throw localErr;
                    const keepAnonymousTurns = framingMode && Array.isArray(localTurns) && localTurns.length
                        && /PLAN speaker track unavailable/.test(message);
                    if (!keepAnonymousTurns) localTurns = null;
                    localMapping = null;
                    send('log', { message: `[EDIT] Local Listen fallback: ${message}`.slice(0, 240) });
                }

                speechAll = fallbackSpeech;
                const googleSttStartedAt = Date.now();
                try {
                    let words = hybridRawWords;
                    if (!Array.isArray(words)) {
                        const auth = await getAdcAuth();
                        words = await googleSttWords(
                            auth, listenPath, listenDuration, job,
                            (m) => send('log', { message: m }),
                        );
                    }
                    if (localTurns && localMapping && words.length) {
                        const localSpeech = mergeDiarizationWords(words, localMapping);
                        const unresolvedFallback = fallbackSpeechForAmbiguousTurns(
                            fallbackSpeech,
                            localMapping.ambiguousTurns,
                            localMapping.mappedTurns,
                        );
                        speechAll = [
                            ...localSpeech,
                            ...snapLinesToWords(unresolvedFallback, words),
                        ].sort((a, b) => a.t - b.t);
                        if (framingMode && localMapping.ambiguousTurns?.length) {
                            const unresolvedSpeech = speechLinesForUnresolvedTurns(
                                localMapping.ambiguousTurns,
                                localMapping.mappedTurns,
                                words,
                            );
                            if (unresolvedSpeech.length) {
                                speechAll = [...speechAll, ...unresolvedSpeech].sort((a, b) => a.t - b.t);
                                send('log', { message: `[EDIT] Speech framing: ${unresolvedSpeech.length} lines kept from ${localMapping.ambiguousTurns.length} unresolved turns` });
                            }
                        }
                    } else if (words.length && speechAll.length) {
                        speechAll = snapLinesToWords(speechAll, words);
                    } else if (framingMode && Array.isArray(localTurns) && localTurns.length) {
                        speechAll = speechLinesFromDiarizedTurns(localTurns, words);
                        send('log', { message: `[EDIT] Speech framing: ${speechAll.length} lines from diarization, no named PLAN track` });
                    } else if (localTurns && localMapping && !words.length) {
                        send('log', { message: '[EDIT] Local Listen fallback: Google STT returned no words' });
                    }
                    if (words.length) {
                        send('log', { message: `[EDIT] Google STT ${words.length} words${speechAll.length ? ` — snap ${speechAll.length} lines` : ''}` });
                    }
                } catch (sttErr) {
                    const message = sttErr instanceof Error ? sttErr.message : String(sttErr);
                    if (/cancell/i.test(message) || job.cancelled) throw sttErr;
                    speechAll = fallbackSpeech;
                    if (framingMode && Array.isArray(localTurns) && localTurns.length && !speechAll.length) {
                        speechAll = speechLinesFromDiarizedTurns(localTurns, []);
                    }
                    send('log', { message: `[EDIT] Google STT skip: ${message}`.slice(0, 220) });
                } finally {
                    logEditTiming('Google STT', googleSttStartedAt);
                }
                send('log', { message: `[EDIT] STT ${speechAll.length} spoken lines` });
                speechAll.slice(0, 8).forEach((l) => {
                    send('log', { message: `[EDIT]   ${l.t.toFixed(2)}–${l.end.toFixed(2)}s  ${l.who}  “${(l.text || '').slice(0, 48)}”` });
                });
            } else {
            send('log', { message: testSec > 0
                ? '[EDIT] TEST STT: listen + Google STT trên đúng 1 phút đã cắt (không xem full)'
                : '[EDIT] STT: nghe từng câu + mốc phoneme (thêm 1 API, chậm hơn)…' });
            send('progress', { value: 43, watch: 100, phase: 'stt' });
            send('log', { message: '[EDIT] Đợi 8s trước listen — tránh 429 sát lần xem' });
            await sleepJob(8000, job);
            const listenProxy = path.join(uploadsDir, `${jobId}_stt.mp4`);
            try {
                const speakerProxyStartedAt = Date.now();
                await runEditEncode([
                    '-y', '-i', listenPath,
                    '-vf', "scale='min(640,iw)':-2",
                    '-r', '6',
                ], [
                    '-c:a', 'aac', '-b:a', '96k', '-ac', '1',
                    '-movflags', '+faststart',
                    listenProxy,
                ], job, 34, true);
                logEditTiming('speaker proxy generation', speakerProxyStartedAt);
                if (apiKey) {
                    const up = await geminiUploadVideo(apiKey, listenProxy, 'stt-listen');
                    try {
                        const speakerAiStartedAt = Date.now();
                        try {
                            const parsed = await geminiJsonVideo(apiKey, model, up.uri, sttListenPrompt(duration), job);
                            speechAll = parseSpeechLines(parsed, duration);
                        } finally {
                            logEditTiming('speaker AI', speakerAiStartedAt);
                        }
                    } finally {
                        await geminiDeleteFile(apiKey, up.name);
                    }
                } else {
                    const auth = await getAdcAuth();
                    try {
                        const parsed = await vertexJsonVideo(
                            auth, model, listenProxy, sttListenPrompt(duration), job,
                            (m) => send('log', { message: m }),
                            {
                                timeoutMs: testSec > 0 ? 4 * 60 * 1000 : 12 * 60 * 1000,
                                overallTimeoutMs: testSec > 0 ? 3 * 60 * 1000 : 0,
                                onProgress: (v) => send('progress', { value: v, phase: 'stt' }),
                            },
                        );
                        speechAll = parseSpeechLines(parsed, duration);
                    } catch (listenErr) {
                        const lm = listenErr instanceof Error ? listenErr.message : String(listenErr);
                        if (/cancell/i.test(lm) || job.cancelled) throw listenErr;
                        send('log', { message: `[EDIT] Vertex listen lỗi: ${lm}`.slice(0, 240) });
                        if (plan && plan._raw) {
                            speechAll = parseSpeechLines(plan._raw, duration);
                            if (speechAll.length) send('log', { message: `[EDIT] Dùng ${speechAll.length} câu từ lần xem (fallback, vẫn còn STT)` });
                        }
                    }
                    const googleSttStartedAt = Date.now();
                    try {
                        const words = await googleSttWords(
                            auth, listenPath, listenDuration, job,
                            (m) => send('log', { message: m }),
                        );
                        if (words.length) {
                            speechAll = speechAll.length ? snapLinesToWords(speechAll, words) : speechAll;
                            if (!speechAll.length) {
                                // still have words even without Gemini lines — skip
                            }
                            send('log', { message: `[EDIT] Google STT ${words.length} words${speechAll.length ? ` — snap ${speechAll.length} lines` : ''}` });
                        }
                    } catch (sttErr) {
                        send('log', { message: `[EDIT] Google STT skip: ${sttErr instanceof Error ? sttErr.message : String(sttErr)}`.slice(0, 220) });
                    } finally {
                        logEditTiming('Google STT', googleSttStartedAt);
                    }
                }
                send('log', { message: `[EDIT] STT ${speechAll.length} spoken lines` });
                speechAll.slice(0, 8).forEach((l) => {
                    send('log', { message: `[EDIT]   ${l.t.toFixed(2)}–${l.end.toFixed(2)}s  ${l.who}  “${(l.text || '').slice(0, 48)}”` });
                });
            } catch (e) {
                send('log', { message: `[EDIT] STT failed, mix without phoneme snap: ${e instanceof Error ? e.message : String(e)}`.slice(0, 240) });
            } finally {
                try { fs.unlinkSync(listenProxy); } catch { /* ignore */ }
                for (let i = 1; i <= 6; i++) {
                    try { fs.unlinkSync(listenProxy.replace(/\.mp4$/i, `_s${i}.mp4`)); } catch { /* ignore */ }
                }
            }
            }
        }

        send('plan', { summary: plan.summary, segments: plan.segments, duration });

        if (!autoCut) {
            send('done', { segments: plan.segments, cut: false });
            return res.end();
        }

        // mode=ai only: Even split is the "no API" path and must never reach Vertex.
        if (mode === 'ai' && generalVideo && tiktokMix && !testSec && plan?.segments?.length) {
            let glanceAuth = null;
            let glanceUsed = 0;
            let glanceKept = 0;
            for (const seg of plan.segments) {
                if (job.cancelled) throw new Error('cancelled');
                // The global PLAN watched the whole video WITH audio and already
                // owns the framing. Only fill in when it produced nothing usable
                // for this part; never overwrite it with a 4-still estimate.
                if (Array.isArray(seg.frames) && seg.frames.length >= 2) {
                    glanceKept += 1;
                    continue;
                }
                const lines = speechForSegment(speechAll, seg);
                const speechSec = lines.reduce((sum, line) => sum + Math.max(0, Number(line.end) - Number(line.t)), 0);
                if ((seg.dur || 0) > 0 && lines.length >= 2 && speechSec / seg.dur >= 0.2) continue;
                try {
                    if (!glanceAuth) glanceAuth = await getAdcAuth();
                    const stamps = [0.15, 0.4, 0.65, 0.9].map((p) => ({
                        t: seg.start + Math.max(0.2, (seg.end - seg.start) * p),
                        reasons: ['general-glance'],
                    }));
                    const frames = await extractDetailEvidenceJpegs(job.inputPath, stamps, job, (m) => send('log', { message: m }), 3);
                    const glanced = await vertexGlanceQuietPart(glanceAuth, model, frames, seg.start, seg.end, job, (m) => send('log', { message: m }));
                    if (glanced.length >= 2) {
                        seg.frames = glanced;
                        glanceUsed += 1;
                        send('log', { message: `[EDIT] General glance ${seg.name || 'part'}: ${glanced.length} framing windows` });
                    }
                } catch (glanceErr) {
                    const message = glanceErr instanceof Error ? glanceErr.message : String(glanceErr);
                    if (/cancell/i.test(message) || job.cancelled) throw glanceErr;
                    send('log', { message: `[EDIT] General glance skipped: ${message}`.slice(0, 220) });
                }
            }
            send('log', { message: `[EDIT] General glance: ${glanceKept} part giữ framing Global PLAN · ${glanceUsed} part phải xem stills (PLAN thiếu khung)` });
        }

        const cutSegs = [];
        // Speech lines come back in the concatenated "keep" timeline when the
        // compact listen ran; split them per part (part-local times) for the
        // renderer. Without the compact listen this is the old source-time path.
        const speechForPartIndex = (index, seg, cutDur) => {
            if (!keepSpeechPlan) return speechForSegment(speechAll, seg, cutDur);
            const entry = keepSpeechPlan.offsets.find((item) => item.index === index);
            if (!entry) return [];
            return speechAll
                .filter((line) => Number(line.end) > entry.start + 0.05 && Number(line.t) < entry.start + entry.dur - 0.05)
                .map((line) => ({
                    ...line,
                    t: Math.max(0, Number(line.t) - entry.start),
                    end: Math.max(0, Number(line.end) - entry.start),
                }))
                .filter((line) => line.t < (cutDur || entry.dur) + 0.2);
        };
        const alreadyTik = isTikTokAspect(probe.width || 0, probe.height || 0);
        const doPad = (tiktokPad || tiktokMix) && !alreadyTik;
        send('log', { message: alreadyTik
            ? `[EDIT] After Gemini: keep ${probe.width}x${probe.height} (already 9:16)`
            : focusStyle
                ? '[EDIT] After Gemini: cut, then FOCUS 9:16 (focus 3:4 trên nền mờ, split phủ kín)'
                : tiktokMix
                    ? '[EDIT] After Gemini: cut, then MIXED 9:16 (fill xen contain)'
                    : doPad
                        ? '[EDIT] After Gemini: cut YouTube size, then pad each part to TikTok 1080x1920'
                        : `[EDIT] After Gemini: keep source ${probe.width}x${probe.height}` });
        if (partFrom > 1 || partTo > 0) {
            const lastKeep = partTo > 0 ? partTo : plan.segments.length;
            send('log', { message: `[EDIT] Chỉ xuất tập ${partFrom}–${Math.min(lastKeep, plan.segments.length)} / ${plan.segments.length} (bỏ tập trước)` });
        }
        for (let i = 0; i < plan.segments.length; i++) {
            if (job.cancelled) throw new Error('cancelled');
            const epNum = i + 1;
            const lastKeep = partTo > 0 ? partTo : plan.segments.length;
            if (epNum < partFrom || epNum > lastKeep) {
                if (testSec > 0) {
                    send('log', { message: `[EDIT] TEST: không bỏ tập ${epNum} (test luôn cắt tập 1)` });
                } else {
                    send('log', { message: `[EDIT] Bỏ tập ${epNum}/${plan.segments.length}: ${plan.segments[i].name} (chỉ xuất ${partFrom}–${lastKeep})` });
                    continue;
                }
            }
            const seg = plan.segments[i];
            send('log', { message: `[EDIT] Cutting ${epNum}/${plan.segments.length}: ${seg.name}` });
            send('progress', { value: 45 + Math.round((i / Math.max(1, plan.segments.length)) * 50), part: epNum, phase: 'cut' });
            const childId = crypto.randomBytes(8).toString('hex');
            const outName = numberedEpisodeName(epNum, seg.title || seg.name);
            const outPath = path.join(uploadsDir, `${childId}_output.mp4`);
            const cutPath = doPad ? path.join(uploadsDir, `${childId}_cut.mp4`) : outPath;
            const nPieces = Array.isArray(seg.ranges) ? seg.ranges.length : 1;
            send('log', { message: `[EDIT] Kịch bản ${nPieces} mảnh: ${seg.script || `${seg.start}s–${seg.end}s`}` });
            await cutEditClip(job.inputPath, cutPath, seg, job, fadeFx);
            const cutProbe = await probeMedia(doPad ? cutPath : outPath).catch(() => null);
            const cutDur = cutProbe?.durationSec || 0;
            if (!testSec && cutDur <= 60) {
                send('log', { message: `[EDIT] SKIP ${seg.name}: ${cutDur.toFixed(1)}s ≤ 60s (must be > 1 min)` });
                try { fs.unlinkSync(cutPath); } catch { /* ignore */ }
                continue;
            }
            if (doPad) {
                send('log', { message: tiktokMix
                    ? (focusStyle
                        ? `[EDIT] Focus 9:16 ${i + 1}/${plan.segments.length}…`
                        : `[EDIT] Mixed 9:16 ${i + 1}/${plan.segments.length}…`)
                    : `[EDIT] TikTok pad ${i + 1}/${plan.segments.length}…` });
                try {
                    if (focusStyle) {
                        const localSpeech = speechForPartIndex(i, seg, cutDur);
                        if (localSpeech.length) send('log', { message: `[EDIT] STT this part: ${localSpeech.length} lines` });
                        seg._qa = await composeFocusClip(cutPath, outPath, job, (m) => send('log', { message: m }), seg.frames, seg.track, localSpeech, { apiKey, model });
                    }
                    else if (tiktokMix) {
                        const localSpeech = speechForPartIndex(i, seg, cutDur);
                        if (localSpeech.length) send('log', { message: `[EDIT] STT this part: ${localSpeech.length} lines` });
                        await mixFrameClip(cutPath, outPath, job, (m) => send('log', { message: m }), seg.frames, seg.track, localSpeech, detailPlanSegmentIndexes.has(i), framingMode && !detailPlanSegmentIndexes.has(i));
                    }
                    else await padTikTokClip(cutPath, outPath, job);
                    try { fs.unlinkSync(cutPath); } catch { /* ignore */ }
                } catch (padErr) {
                    send('log', { message: `[EDIT] 9:16 pass failed, keep YouTube size: ${padErr instanceof Error ? padErr.message : String(padErr)}`.slice(0, 280) });
                    try { fs.renameSync(cutPath, outPath); } catch {
                        try { fs.copyFileSync(cutPath, outPath); } catch { /* ignore */ }
                    }
                }
            }
            jobs.set(childId, {
                kind: 'edit-part',
                inputPath: job.inputPath,
                outputPath: outPath,
                originalName: outName,
                keepInput: true,
                status: 'done',
            });
            const item = {
                ...seg,
                name: outName,
                title: seg.title || seg.name,
                partIndex: i + 1,
                jobId: childId,
                downloadUrl: `/api/download/${childId}`,
                qa: seg._qa || null,
                finishedAt: new Date().toISOString(),
                elapsedMs: Date.now() - editRunStartedAt,
            };
            if (seg._qa) {
                appendEditQaHistory({
                    at: new Date().toISOString(),
                    sourceName: String(job.originalName || ''),
                    sourcePath: String(job.inputPath || ''),
                    partIndex: i + 1,
                    ranges: Array.isArray(seg.ranges) ? seg.ranges : [[Number(seg.start) || 0, Number(seg.end) || 0]],
                    partName: outName,
                    durationSec: Number(cutDur.toFixed(1)),
                    score: seg._qa.score,
                    grade: seg._qa.grade,
                    warnings: seg._qa.warnings,
                    metrics: seg._qa.metrics,
                    model,
                    detailModelUsed: String(seg._detailModelUsed || ''),
                    detailModelMode: runningDetailMode,
                    topic: topicProfileResolved?.key || 'generic',
                    topicLabel: topicProfileResolved?.label || '',
                    framingStyle,
                    encoder: job.editEncoder,
                });
            }
            cutSegs.push(item);
            rememberEditHold({
                jobId: childId,
                sourceName: String(job.originalName || ''),
                sourcePath: String(job.inputPath || ''),
                partIndex: item.partIndex,
                name: outName,
                title: item.title || '',
                titleVi: seg.titleVi || '',
                script: seg.script || '',
                reason: seg.reason || '',
                start: seg.start,
                end: seg.end,
                dur: cutDur || seg.dur,
                ranges: seg.ranges,
                qa: seg._qa || null,
            });
            send('part-done', item);
        }
        if (!cutSegs.length) {
            throw new Error(testSec > 0
                ? 'TEST: không xuất được tập (đã tắt lọc 4–6). Copy file server mới rồi chạy lại Test 1 phút, ô 4–6 để trống.'
                : (partFrom > 1
                    ? `Không còn tập trong khoảng ${partFrom}–${partTo || 'hết'}. Tắt “Xuất tập từ 4–6” hoặc hạ số xuống 1.`
                    : 'No clips longer than 1 minute — Gemini plan was too short'));
        }
        const qaParts = cutSegs.map((item) => item.qa).filter(Boolean);
        if (keepPath) {
            try { fs.unlinkSync(keepPath); } catch { /* ignore */ }
        }
        // (B) Everything the operator wants to see after a run, in one object: the
        // source, the parts that were kept (with their own timecodes and the clock
        // time they finished), and every stretch that was dropped.
        const keptRanges = cutSegs
            .flatMap((item) => (Array.isArray(item.ranges) && item.ranges.length
                ? item.ranges
                : [[Number(item.start) || 0, Number(item.end) || 0]]))
            .map(([a, b]) => [Math.max(0, Math.min(duration, Number(a) || 0)), Math.max(0, Math.min(duration, Number(b) || 0))])
            .filter(([a, b]) => b - a > 0.05)
            .sort((x, y) => x[0] - y[0]);
        const dropped = [];
        let droppedCursor = 0;
        for (const [a, b] of keptRanges) {
            if (a > droppedCursor + 0.05) {
                dropped.push({ start: Math.round(droppedCursor * 10) / 10, end: Math.round(a * 10) / 10, sec: Math.round((a - droppedCursor) * 10) / 10 });
            }
            droppedCursor = Math.max(droppedCursor, b);
        }
        if (duration > droppedCursor + 0.05) {
            dropped.push({ start: Math.round(droppedCursor * 10) / 10, end: Math.round(duration * 10) / 10, sec: Math.round((duration - droppedCursor) * 10) / 10 });
        }
        // The provider's own token counts for every successful Gemini API-key
        // call in this job. This is the difference between "ước tính" and a real
        // number: nothing here is guessed, only multiplied by the published price.
        const geminiUsageEntries = Array.isArray(job.geminiUsage) ? job.geminiUsage : [];
        const geminiCostSummary = summarizeCost(geminiUsageEntries);
        const geminiByLabel = new Map();
        for (const entry of geminiUsageEntries) {
            const usd = usageCostUsd(entry.model, entry) || 0;
            const acc = geminiByLabel.get(entry.label) || { label: entry.label || '', calls: 0, usd: 0, tokens: 0 };
            acc.calls += 1;
            acc.usd += usd;
            acc.tokens += (Number(entry.inputTokens) || 0) + (Number(entry.cachedInputTokens) || 0) + (Number(entry.outputTokens) || 0);
            geminiByLabel.set(entry.label, acc);
        }
        const round = (value, digits = 2) => Math.round((Number(value) || 0) * (10 ** digits)) / (10 ** digits);
        const editRunReport = {
            sourceName: String(job.originalName || ''),
            totalSec: Math.round(duration * 10) / 10,
            keptSec: Math.round(keptRanges.reduce((sum, [a, b]) => sum + (b - a), 0) * 10) / 10,
            dropped,
            droppedSec: Math.round(dropped.reduce((sum, part) => sum + part.sec, 0) * 10) / 10,
            parts: cutSegs.map((item, index) => ({
                partIndex: item.partIndex || index + 1,
                name: item.name,
                title: item.title || item.name,
                titleVi: item.titleVi || '',
                start: item.start,
                end: item.end,
                dur: item.dur,
                ranges: item.ranges,
                qa: item.qa ? { score: item.qa.score, grade: item.qa.grade, warnings: item.qa.warnings } : null,
                detailModelUsed: String(item._detailModelUsed || ''),
                finishedAt: item.finishedAt || null,
                elapsedMs: item.elapsedMs || null,
            })),
            totalElapsedMs: Date.now() - editRunStartedAt,
            model,
            detailModelsUsed: [...new Set(cutSegs.map((item) => String(item._detailModelUsed || '')).filter(Boolean))],
            geminiCost: {
                calls: geminiCostSummary.calls,
                pricedCalls: geminiCostSummary.pricedCalls,
                totalUsd: round(geminiCostSummary.totalUsd, 6),
                totalVnd: round(geminiCostSummary.totalVnd, 1),
                totalTokens: geminiCostSummary.totalTokens,
                byModel: geminiCostSummary.byModel.map((m) => ({
                    model: m.model,
                    calls: m.calls,
                    inputTokens: m.inputTokens,
                    cachedInputTokens: m.cachedInputTokens,
                    outputTokens: m.outputTokens,
                    usd: round(m.usd || 0, 6),
                    vnd: round(usdToVnd(m.usd || 0), 1),
                })),
                byLabel: [...geminiByLabel.values()].map((g) => ({ label: g.label, calls: g.calls, tokens: g.tokens, usd: round(g.usd, 6), vnd: round(usdToVnd(g.usd), 1) })),
                calls_detail: geminiUsageEntries.map((entry) => ({
                    label: entry.label,
                    model: entry.model,
                    inputTokens: entry.inputTokens,
                    cachedInputTokens: entry.cachedInputTokens,
                    outputTokens: entry.outputTokens,
                })),
                unknownModels: geminiCostSummary.unknownModels,
                priceNote: 'USD/1M token theo bảng giá Gemini API (giá ưu đãi đến 31/12/2026). Key free tier: không bị trừ tiền, token vẫn tiêu quota.',
            },
            detailModelMode: runningDetailMode,
            topic: topicProfileResolved?.key || 'generic',
            topicLabel: topicProfileResolved?.label || '',
            framingStyle,
            sttCompact: Boolean(keepSpeechPlan),
        };
        send('log', { message: `[EDIT] Tổng kết: ${editRunReport.sourceName} · chủ đề ${editRunReport.topic} (${editRunReport.topicLabel}) · nguồn ${editRunReport.totalSec.toFixed(0)}s · giữ ${editRunReport.keptSec.toFixed(0)}s (${cutSegs.length} part) · bỏ ${editRunReport.droppedSec.toFixed(0)}s ở ${dropped.length} đoạn · tổng thời gian ${(editRunReport.totalElapsedMs / 1000).toFixed(0)}s` });
        if (geminiCostSummary.calls) {
            const perModel = geminiCostSummary.byModel
                .map((m) => `${m.model} ×${m.calls} · ${m.inputTokens + m.cachedInputTokens} in (cache ${m.cachedInputTokens}) / ${m.outputTokens} out · ${formatVnd(usdToVnd(m.usd || 0))}`)
                .join(' · ');
            send('log', { message: `[EDIT] Tiền Gemini API (token thật): ${formatVnd(geminiCostSummary.totalVnd)} cho ${editRunReport.keptSec.toFixed(0)}s giữ lại · ${geminiCostSummary.calls} call · ${geminiCostSummary.totalTokens} token · ${perModel}` });
            if (geminiCostSummary.unknownModels.length) {
                send('log', { message: `[EDIT] Chưa có giá cho model: ${geminiCostSummary.unknownModels.join(', ')} — token vẫn được ghi lại nhưng không cộng vào tiền` });
            }
            send('log', { message: `[EDIT] Model Detail thật đã dùng: ${editRunReport.detailModelsUsed.join(', ') || 'không có (part nào cũng fallback Global)'}` });
        }
        if (dropped.length) {
            send('log', { message: `[EDIT] Đoạn bị bỏ: ${dropped.map((d) => `${d.start.toFixed(0)}-${d.end.toFixed(0)}s`).join(', ')}` });
        }
        if (qaParts.length) {
            const avg = Math.round(qaParts.reduce((sum, q) => sum + Number(q.score || 0), 0) / qaParts.length);
            const warned = qaParts.filter((q) => Array.isArray(q.warnings) && q.warnings.length).length;
            send('log', { message: `[QA] ${qaParts.length} part · điểm trung bình ${avg}/100 · ${warned} part có cảnh báo · lưu vào uploads/edit-qa-history.json` });
            const groups = editQaHistorySummary(readEditQaHistory().entries);
            if (groups.length) {
                send('log', { message: `[QA] Lịch sử: ${groups.map((g) => `${g.key} ${g.avgScore}đ/${g.parts} part`).join(' · ')}` });
            }
        }
        const completedWholeRun = testSec <= 0
            && partFrom === 1
            && (partTo === 0 || partTo >= plan.segments.length);
        if (completedWholeRun) {
            writeEditPartHistory({
                version: 2,
                id: crypto.randomBytes(12).toString('hex'),
                completedAt: new Date().toISOString(),
                sourcePath: path.resolve(job.inputPath),
                sourceName: String(job.originalName || path.basename(job.inputPath)),
                sourceWidth: Number(probe.width) || 0,
                sourceHeight: Number(probe.height) || 0,
                model,
                userPrompt,
                encoderMode: requestedEncoder,
                framingStyle,
                parts: cutSegs.map((part) => ({
                    partIndex: part.partIndex,
                    name: part.name,
                    title: part.title,
                    start: part.start,
                    end: part.end,
                    pieces: part.pieces,
                    ranges: part.ranges,
                })),
            });
            send('log', { message: `[EDIT] Saved targeted replay history: ${cutSegs.length} part(s)` });
        }
        send('progress', { value: 100 });
        send('log', { message: `[EDIT] SUCCESS: ${cutSegs.length} clip(s) cut.` });
        send('done', { segments: cutSegs, cut: true, report: editRunReport });
        res.end();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/cancell/i.test(message) || job.cancelled) {
            send('log', { message: '[EDIT] STOPPED.' });
            send('error', { message: 'cancelled' });
        } else {
            send('log', { message: `[EDIT] ERROR: ${message}` });
            send('error', { message });
        }
        if (!res.writableEnded) res.end();
    }
});

function targetedPartRanges(segment) {
    const source = Array.isArray(segment?.pieces) && segment.pieces.length
        ? segment.pieces
        : (Array.isArray(segment?.ranges) && segment.ranges.length ? segment.ranges : null);
    const ranges = source
        ? source.map((piece) => Array.isArray(piece)
            ? [Number(piece[0]), Number(piece[1])]
            : [Number(piece?.start), Number(piece?.end)])
        : [[Number(segment?.start), Number(segment?.end)]];
    if (!ranges.length || ranges.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end) || end <= start)) {
        throw new Error('Selected part has no valid source pieces/ranges');
    }
    return ranges;
}

app.post('/api/edit/log-fallback-parts', (req, res) => {
    const logText = String(req.body?.logText || '');
    if (!logText.trim()) return res.status(400).json({ error: 'Thiếu nội dung log' });
    if (logText.length > 8_000_000) return res.status(400).json({ error: 'Log quá lớn' });
    const names = Array.isArray(req.body?.sourceNames) ? req.body.sourceNames : [req.body?.sourceName];
    const matches = {};
    for (const name of names) {
        const sourceName = String(name || '').trim();
        if (!sourceName) continue;
        matches[sourceName] = fallbackPartsFromLog(logText, sourceName);
    }
    res.json({ matches });
});

// Quality trend for the Edit parts: what the render actually did, kept across
// runs so the operator can see whether a change helped.
app.get('/api/edit/qa-history', (_req, res) => {
    const store = readEditQaHistory();
    res.json({
        entries: store.entries.slice(-100),
        groups: editQaHistorySummary(store.entries),
        topics: summarizeQaByTopic(store.entries),
        total: store.entries.length,
        catalog: replayCatalog(store.entries).map((video) => {
            let sourceAvailable = false;
            try { sourceAvailable = fs.statSync(video.sourcePath).isFile(); } catch { /* gone */ }
            return { ...video, sourceAvailable };
        }),
    });
});

app.get('/api/edit/part-test/history', (_req, res) => {
    const manifest = readEditPartHistory();
    if (!manifest) return res.json({ run: null });
    let sourceAvailable = false;
    try { sourceAvailable = fs.statSync(manifest.sourcePath).isFile(); } catch { /* unavailable */ }
    res.json({
        run: {
            id: manifest.id,
            completedAt: manifest.completedAt,
            sourceName: manifest.sourceName,
            sourcePath: manifest.sourcePath,
            sourceWidth: manifest.sourceWidth,
            sourceHeight: manifest.sourceHeight,
            sourceAvailable,
            parts: manifest.parts,
        },
    });
});

app.post('/api/edit/part-test', (req, res) => {
    try {
        const requestedHistoryId = String(req.body?.historyId || '');
        const requestedPartIndex = Math.max(1, Number(req.body?.partIndex) || Number(req.body?.segment?.partIndex) || 1);
        const history = requestedHistoryId ? readEditPartHistory() : null;
        let inputPath;
        let originalName;
        let segment;
        let replaySettingsSource = 'current UI fallback';
        let replayModel = String(req.body?.model || 'gemini-3.8-flash');
        let replayPrompt = String(req.body?.prompt || '');
        let replayEncoderMode = String(req.body?.encoderMode || 'auto');
        let replayFramingStyle = String(req.body?.framingStyle ?? 'focus') === 'sml' ? 'sml' : 'focus';
        if (history && history.id === requestedHistoryId) {
            const persistedPart = history.parts.find((part) => Number(part.partIndex) === requestedPartIndex);
            if (!persistedPart) return res.status(404).json({ error: 'Persisted part was not found' });
            inputPath = history.sourcePath;
            originalName = history.sourceName;
            segment = persistedPart;
            const hasPersistedAiSettings = typeof history.model === 'string'
                && typeof history.userPrompt === 'string';
            if (hasPersistedAiSettings) {
                replayModel = history.model;
                replayPrompt = history.userPrompt;
                replayEncoderMode = typeof history.encoderMode === 'string'
                    ? history.encoderMode
                    : replayEncoderMode;
                if (typeof history.framingStyle === 'string') {
                    replayFramingStyle = history.framingStyle === 'sml' ? 'sml' : 'focus';
                }
                replaySettingsSource = 'persisted full-run settings';
            }
        } else if (String(req.body?.sourcePath || '').trim()) {
            inputPath = String(req.body.sourcePath).trim();
            originalName = path.basename(inputPath);
            segment = req.body?.segment || {};
            replaySettingsSource = 'log timestamp replay';
        } else {
            const parentPart = jobs.get(String(req.body?.partJobId || ''));
            if (!parentPart || parentPart.kind !== 'edit-part') {
                return res.status(404).json({ error: 'Original source metadata for this part is unavailable' });
            }
            inputPath = parentPart.inputPath;
            originalName = parentPart.originalName;
            segment = req.body?.segment || {};
        }
        let sourceIsFile = false;
        try { sourceIsFile = fs.statSync(inputPath).isFile(); } catch { /* unavailable */ }
        if (!sourceIsFile) {
            return res.status(404).json({ error: 'Original landscape source no longer exists' });
        }
        const ranges = targetedPartRanges(segment);
        const jobId = crypto.randomBytes(16).toString('hex');
        jobs.set(jobId, {
            kind: 'edit-part-test',
            inputPath,
            keepInput: true,
            originalName,
            segment: { ...segment, ranges },
            partIndex: Math.max(1, Number(segment.partIndex) || 1),
            replaySettingsSource,
            settings: {
                apiKey: String(req.body?.apiKey || ''),
                apiKeys: req.body?.apiKeys || '',
                model: replayModel,
                prompt: replayPrompt,
                encoderMode: replayEncoderMode,
                tiktokPad: String(req.body?.tiktokPad ?? 'false') === 'true',
                tiktokMix: String(req.body?.tiktokMix ?? 'false') === 'true',
                speechFraming: String(req.body?.speechFraming ?? 'false') === 'true',
                framingStyle: replayFramingStyle,
            },
            status: 'pending',
        });
        res.json({ jobId });
    } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
});

app.get('/api/edit/part-test/stream/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    if (!job || job.kind !== 'edit-part-test') return res.status(404).end();
    const send = subscribeJob(job, res);
    if (!send) return;
    job.notify = send;

    const settings = job.settings || {};
    const targetedTikTokPad = settings.tiktokPad === true;
    const targetedTikTokMix = settings.tiktokMix === true;
    const targetedSpeechFraming = targetedTikTokMix && settings.speechFraming === true;
    const targetedFocusStyle = String(settings.framingStyle ?? 'focus').trim().toLowerCase() !== 'sml';
    const targetedMix = targetedTikTokMix || targetedFocusStyle;
    const apiKeys = parseGeminiApiKeys(settings);
    const apiKey = apiKeys[0] || '';
    const model = String(settings.model || 'gemini-3.8-flash');
    const userPrompt = String(settings.prompt || '').trim();
    const segment = job.segment || {};
    const partIndex = job.partIndex || 1;
    const heldSourceName = String(job.originalName || '');
    const heldSourcePath = String(job.inputPath || '');
    const ranges = targetedPartRanges(segment);
    const rangeText = ranges.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}s`).join(', ');
    const excerptPath = path.join(uploadsDir, `${jobId}_source.mp4`);
    const proxyPath = path.join(uploadsDir, `${jobId}_detail.mp4`);
    const outputPath = path.join(uploadsDir, `${jobId}_output.mp4`);
    job.editEncoder = resolveEncoder(settings.encoderMode);
    job.editOnLog = (message) => send('log', { message });
    job.outputPath = outputPath;
    forgetGeminiSecrets(job.settings);
    const logTiming = (phase, startedAt) => send('log', {
        message: `[EDIT TIMING] ${phase}: ${((Date.now() - startedAt) / 1000).toFixed(2)}s`,
    });

    try {
        send('log', { message: `[EDIT] TARGETED PART TEST: Part ${partIndex} · original source · ${rangeText}` });
        send('log', { message: `[EDIT] TARGETED replay settings source: ${job.replaySettingsSource || 'current UI fallback'}` });
        send('log', { message: `[EDIT] TARGETED output options: framing=${targetedFocusStyle ? 'focus 9:16' : 'SML'} · TikTok pad=${targetedTikTokPad} · Mixed 9:16=${targetedTikTokMix} · speech framing=${targetedSpeechFraming}` });
        const sourceProbe = await probeMedia(job.inputPath);
        send('log', { message: `[EDIT] Target source ${sourceProbe.width}x${sourceProbe.height} · pieces ${rangeText}` });
        if (!(sourceProbe.width > sourceProbe.height)) {
            throw new Error(`Targeted Part requires original landscape source; got ${sourceProbe.width}x${sourceProbe.height}`);
        }
        send('progress', { value: 5, phase: 'extract' });
        await cutEditClip(job.inputPath, excerptPath, { ...segment, ranges }, job, false);
        const excerptProbe = await probeMedia(excerptPath);
        const duration = Number(excerptProbe.durationSec) || ranges.reduce((sum, [a, b]) => sum + b - a, 0);
        const title = String(segment.title || segment.name || `Part ${partIndex}`).replace(/\.(mp4|mov|webm|m4v)$/i, '');
        const outputName = safeDownloadName(`TEST Part ${partIndex} - ${title}.mp4`);
        if (!targetedMix) {
            send('progress', { value: 70, phase: 'render' });
            if (targetedTikTokPad && !isTikTokAspect(excerptProbe.width || 0, excerptProbe.height || 0)) {
                try {
                    await padTikTokClip(excerptPath, outputPath, job);
                    send('log', { message: `[EDIT] TARGETED TikTok pad applied: ${excerptProbe.width}x${excerptProbe.height} → 1080x1920` });
                } catch (padErr) {
                    if (job.cancelled) throw padErr;
                    send('log', { message: `[EDIT] TARGETED TikTok pad failed; keeping source ratio: ${padErr instanceof Error ? padErr.message : String(padErr)}`.slice(0, 260) });
                    try { fs.unlinkSync(outputPath); } catch { /* remove partial pad output */ }
                    fs.renameSync(excerptPath, outputPath);
                }
            } else {
                fs.renameSync(excerptPath, outputPath);
                send('log', { message: `[EDIT] TARGETED output: original ${excerptProbe.width}x${excerptProbe.height}; no Detail/STT/Local Listen/mix${targetedTikTokPad ? ' (already TikTok aspect)' : ''}` });
            }
            job.originalName = outputName;
            job.status = 'done';
            rememberEditHold({
                jobId,
                sourceName: heldSourceName,
                sourcePath: heldSourcePath,
                partIndex,
                name: outputName,
                title: `TEST Part ${partIndex} - ${title}`,
                start: ranges[0]?.[0],
                end: ranges[ranges.length - 1]?.[1],
                dur: duration,
                ranges,
            });
            send('progress', { value: 100, phase: 'done' });
            send('log', { message: `[EDIT] TARGETED PART TEST SUCCESS: ${outputName}` });
            send('done', {
                ...segment,
                ranges,
                sourcePath: job.inputPath,
                name: outputName,
                title: `TEST Part ${partIndex} - ${title}`,
                partIndex,
                jobId,
                downloadUrl: `/api/download/${jobId}`,
            });
            res.end();
            return;
        }
        const sceneCuts = compactSceneCutHints(await detectSceneTimes(excerptPath, duration, job), duration);
        send('log', { message: `[EDIT] TARGETED Detail settings Part ${partIndex}: model=${model} promptHash=${shortPromptHash(userPrompt)} sceneCuts=${sceneCuts.length} temperature=0` });

        const targetedHybridEnabled = process.env.GHOSTFORGE_HYBRID_DETAIL === '1';
        let localTurns = null;
        let words = null;
        if (targetedHybridEnabled) {
            const diarStartedAt = Date.now();
            try {
                localTurns = await runLocalDiarization(excerptPath, job);
            } catch (err) {
                if (job.cancelled) throw err;
                send('log', { message: `[EDIT] Local Listen fallback: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240) });
            } finally {
                logTiming('local speaker diarization', diarStartedAt);
            }
            const sttStartedAt = Date.now();
            try {
                const auth = await getAdcAuth();
                words = await googleSttWords(auth, excerptPath, duration, job, (message) => send('log', { message }));
            } catch (err) {
                if (job.cancelled) throw err;
                send('log', { message: `[EDIT] Google STT skip: ${err instanceof Error ? err.message : String(err)}`.slice(0, 220) });
            } finally {
                logTiming('Google STT', sttStartedAt);
            }
        }

        const detailMinSec = Math.max(12, Math.min(25, duration * 0.35));
        let plan = null;
        if (targetedHybridEnabled) {
            try {
                if (!Array.isArray(localTurns) || !Array.isArray(words)) throw new Error('raw diarization/STT evidence unavailable');
                const evidenceEvents = buildDetailEvidenceTimes({
                    duration,
                    sceneCuts,
                    words,
                    diarTurns: localTurns,
                });
                const evidenceFrames = await extractDetailEvidenceJpegs(
                    excerptPath,
                    evidenceEvents,
                    job,
                    (message) => send('log', { message }),
                );
                send('log', { message: `[EDIT] Targeted Hybrid Detail Part ${partIndex}: ${evidenceFrames.length} evidence frames` });
                const evidenceText = JSON.stringify({
                    part: {
                        title: segment.title || segment.name || '',
                        duration,
                        globalFrames: segment.frames || [],
                        globalTrack: segment.track || [],
                    },
                    sceneCuts,
                    words,
                    diarization: localTurns,
                });
                const auth = await getAdcAuth();
                plan = await vertexGenerateDetailMultimodal(
                    auth, model, evidenceFrames, evidenceText, userPrompt,
                    duration, detailMinSec, job,
                    (message) => send('log', { message }),
                    sceneCuts,
                );
                const hybridDetailSeg = plan?.segments?.[0];
                if (!hybridDetailSeg?.frames?.length || !hybridDetailSeg?.track?.length) {
                    throw new Error('hybrid detail PLAN missing framing or speaker track');
                }
                send('log', { message: `[EDIT] Targeted Hybrid Detail Part ${partIndex} success` });
            } catch (err) {
                if (job.cancelled) throw err;
                plan = null;
                send('log', { message: `[EDIT] Targeted Hybrid Detail Part ${partIndex} failed -> video Detail fallback` });
            }
        }
        if (!plan) {
            const proxyStartedAt = Date.now();
            await runEditEncode([
                '-y', '-i', excerptPath, '-vf', "scale='min(854,iw)':-2", '-r', '12',
            ], [
                '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', proxyPath,
            ], job, 32, true);
            logTiming(`detail proxy Part ${partIndex}`, proxyStartedAt);
            if (apiKeys.length) {
                const startedAt = Date.now();
                plan = await geminiDetailAcrossModels(
                    apiKeys, proxyPath, userPrompt, duration, detailMinSec, sceneCuts, job,
                    (message) => send('log', { message }),
                    `Detail Part ${partIndex}`,
                    targetedFocusStyle ? focusDetailPrompt(duration, detailMinSec, sceneCuts, userPrompt) : null,
                    model,
                    'safe',
                );
                logTiming(`detail AI Part ${partIndex}`, startedAt);
            } else {
                const auth = await getAdcAuth();
                plan = await vertexGeneratePlan(
                    auth, model, proxyPath, userPrompt, duration, 1, detailMinSec, job,
                    (message) => send('log', { message }), false, true, true,
                    `detail AI Part ${partIndex}`, sceneCuts, 0,
                    targetedFocusStyle ? focusDetailPrompt(duration, detailMinSec, sceneCuts, userPrompt) : null,
                );
            }
        }
        let detailSeg = plan?.segments?.[0];
        if (!detailSeg?.frames?.length || !detailSeg?.track?.length) throw new Error('detail PLAN missing framing or speaker track');
        // (A) Same coverage repair as the production loop: a targeted replay whose
        // plan describes only part of the excerpt gets one more, explicit ask.
        let targetedCoverage = framesCoverage(detailSeg.frames, duration);
        if (targetedCoverage < 0.8 && !job?.cancelled) {
            const repairInstruction = `\n\nREPAIR: your previous answer described only ${(targetedCoverage * 100).toFixed(0)}% of this ${duration.toFixed(1)} second excerpt. Return frames[] that cover the WHOLE excerpt from 0.0 to ${duration.toFixed(1)} with no gaps, and a track[] point about every 1.5 seconds.`;
            try {
                const repaired = apiKeys.length
                    ? await geminiDetailAcrossModels(
                        apiKeys, proxyPath, userPrompt, duration, detailMinSec, sceneCuts, job,
                        (message) => send('log', { message }),
                        `Detail Part ${partIndex} bù phủ`,
                        `${targetedFocusStyle ? focusDetailPrompt(duration, detailMinSec, sceneCuts, userPrompt) : ''}${repairInstruction}`,
                        model,
                        'safe',
                    )
                    : await vertexGeneratePlan(
                        await getAdcAuth(), model, proxyPath, userPrompt, duration, 1, detailMinSec, job,
                        (m) => send('log', { message: m }),
                        false, true, true, `detail AI Part ${partIndex} bù phủ`, sceneCuts, 0,
                        `${targetedFocusStyle ? focusDetailPrompt(duration, detailMinSec, sceneCuts, userPrompt) : ''}${repairInstruction}`,
                    );
                const repairedSeg = repaired?.segments?.[0];
                const repairedCoverage = repairedSeg ? framesCoverage(repairedSeg.frames, duration) : 0;
                if (repairedSeg?.frames?.length && repairedSeg?.track?.length && repairedCoverage > targetedCoverage) {
                    send('log', { message: `[EDIT] Detail Part ${partIndex} bù phủ: ${(targetedCoverage * 100).toFixed(0)}% → ${(repairedCoverage * 100).toFixed(0)}%` });
                    plan = repaired;
                    detailSeg = repairedSeg;
                } else {
                    send('log', { message: `[EDIT] Detail Part ${partIndex} bù phủ không tốt hơn (giữ ${(targetedCoverage * 100).toFixed(0)}%)` });
                }
            } catch (repairErr) {
                const message = repairErr instanceof Error ? repairErr.message : String(repairErr);
                if (/cancell/i.test(message) || job.cancelled) throw repairErr;
                send('log', { message: `[EDIT] Detail Part ${partIndex} bù phủ bỏ qua: ${message}`.slice(0, 200) });
            }
        }
        const rawSegments = plan?._raw?.segments || plan?._raw?.clips || [];
        const rawSegment = Array.isArray(rawSegments) ? rawSegments[0] : null;
        const rawFrames = rawSegment ? (rawSegment.frames || rawSegment.framing || rawSegment.shots || rawSegment.layout || []) : [];
        const rawCounts = { contain: 0, fill: 0, other: 0 };
        for (const frame of Array.isArray(rawFrames) ? rawFrames : []) {
            const mode = normalizeFrameMode(Array.isArray(frame) ? frame[2] : frame?.mode || frame?.kind || frame?.framing || frame?.type);
            if (mode === 'contain') rawCounts.contain += 1;
            else if (mode === 'fill') rawCounts.fill += 1;
            else rawCounts.other += 1;
        }
        const parsedContain = detailSeg.frames.filter((frame) => frame?.mode === 'contain').length;
        const parsedFill = detailSeg.frames.filter((frame) => frame?.mode === 'fill').length;
        send('log', { message: `[EDIT] Detail PLAN Part ${partIndex} modes: raw contain=${rawCounts.contain} fill=${rawCounts.fill} other=${rawCounts.other} · parsed contain=${parsedContain} fill=${parsedFill}` });
        logParsedDetailWindows(detailSeg.frames, 'TARGETED Detail', (message) => send('log', { message }));

        const fallbackSpeech = plan?._raw ? parseSpeechLines(plan._raw, duration) : [];
        let localMapping = null;
        try {
            const startedAt = targetedHybridEnabled ? 0 : Date.now();
            if (!targetedHybridEnabled) localTurns = await runLocalDiarization(excerptPath, job);
            if (!Array.isArray(localTurns)) throw new Error('local diarization unavailable');
            localMapping = mapDiarizationToPlan(localTurns, plan, (message) => send('log', { message }));
            if (!localMapping.ok) throw new Error(localMapping.reason);
            if (startedAt) logTiming('local speaker diarization', startedAt);
        } catch (err) {
            if (job.cancelled) throw err;
            localTurns = null;
            localMapping = null;
            send('log', { message: `[EDIT] Local Listen fallback: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240) });
        }
        let speech = fallbackSpeech;
        const sttStartedAt = targetedHybridEnabled ? 0 : Date.now();
        try {
            if (!targetedHybridEnabled) {
                const auth = await getAdcAuth();
                words = await googleSttWords(auth, excerptPath, duration, job, (message) => send('log', { message }));
            }
            if (!Array.isArray(words)) words = [];
            if (localTurns && localMapping && words.length) {
                speech = [
                    ...mergeDiarizationWords(words, localMapping),
                    ...snapLinesToWords(fallbackSpeechForAmbiguousTurns(fallbackSpeech, localMapping.ambiguousTurns, localMapping.mappedTurns), words),
                ].sort((a, b) => a.t - b.t);
            } else if (words.length && speech.length) {
                speech = snapLinesToWords(speech, words);
            }
        } catch (err) {
            if (job.cancelled) throw err;
            send('log', { message: `[EDIT] Google STT skip: ${err instanceof Error ? err.message : String(err)}`.slice(0, 220) });
        } finally {
            if (sttStartedAt) logTiming('Google STT', sttStartedAt);
        }

        send('progress', { value: 70, phase: 'render' });
        if (targetedFocusStyle) {
            const qa = await composeFocusClip(excerptPath, outputPath, job, (message) => send('log', { message }), detailSeg.frames, detailSeg.track, speech, { apiKey, model });
            job.lastQa = qa || null;
            if (qa) {
                appendEditQaHistory({
                    at: new Date().toISOString(),
                    sourceName: String(job.originalName || ''),
                    sourcePath: String(job.inputPath || ''),
                    partIndex,
                    ranges,
                    partName: outputName,
                    durationSec: Number(duration.toFixed(1)),
                    score: qa.score,
                    grade: qa.grade,
                    warnings: qa.warnings,
                    metrics: qa.metrics,
                    model,
                    detailModelUsed: String(plan?._modelUsed || ''),
                    detailModelMode: 'safe',
                    framingStyle: 'focus',
                    encoder: job.editEncoder,
                    via: 'part-test',
                });
            }
        } else {
            await mixFrameClip(excerptPath, outputPath, job, (message) => send('log', { message }), detailSeg.frames, detailSeg.track, speech, true, targetedSpeechFraming);
        }
        job.originalName = outputName;
        job.status = 'done';
        rememberEditHold({
            jobId,
            sourceName: heldSourceName,
            sourcePath: heldSourcePath,
            partIndex,
            name: outputName,
            title: `TEST Part ${partIndex} - ${title}`,
            start: ranges[0]?.[0],
            end: ranges[ranges.length - 1]?.[1],
            dur: duration,
            ranges,
            qa: job.lastQa || null,
        });
        send('progress', { value: 100, phase: 'done' });
        send('log', { message: `[EDIT] TARGETED PART TEST SUCCESS: ${outputName}` });
        send('done', {
            ...segment,
            ranges,
            sourcePath: job.inputPath,
            name: outputName,
            title: `TEST Part ${partIndex} - ${title}`,
            partIndex,
            jobId,
            downloadUrl: `/api/download/${jobId}`,
            qa: job.lastQa || null,
        });
        res.end();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send('log', { message: `[EDIT] TARGETED PART TEST ERROR: ${message}` });
        send('error', { message });
        if (!res.writableEnded) res.end();
    } finally {
        for (const file of [excerptPath, proxyPath, proxyPath.replace(/\.mp4$/i, '_small.mp4')]) {
            try { fs.unlinkSync(file); } catch { /* ignore */ }
        }
        for (let index = 1; index <= 6; index++) {
            try { fs.unlinkSync(proxyPath.replace(/\.mp4$/i, `_s${index}.mp4`)); } catch { /* ignore */ }
        }
    }
});


async function cutEditClip(src, dest, seg, job, fadeFx) {
    const ranges = Array.isArray(seg.ranges) && seg.ranges.length
        ? seg.ranges
        : [[Number(seg.start) || 0, Number(seg.end) || 0]];
    const pieces = [];
    const extras = [];
    try {
        for (let i = 0; i < ranges.length; i++) {
            const [a, b] = ranges[i];
            const d = Math.max(0.2, b - a);
            const pre = Math.max(0, a - 2);
            const fine = Math.max(0, a - pre);
            const piece = ranges.length === 1 ? dest : dest.replace(/\.mp4$/i, `_r${i}.mp4`);
            const vf = fadeFx && ranges.length === 1
                ? `fade=t=in:st=0:d=0.18,fade=t=out:st=${Math.max(0.2, d - 0.32).toFixed(2)}:d=0.3`
                : null;
            const af = fadeFx && ranges.length === 1
                ? `afade=t=in:st=0:d=0.12,afade=t=out:st=${Math.max(0.2, d - 0.28).toFixed(2)}:d=0.26`
                : null;
            const prefix = [
                '-y', '-ss', String(pre), '-i', src, '-ss', String(fine), '-t', String(d),
            ];
            if (vf) prefix.push('-vf', vf);
            const suffix = ['-c:a', 'aac', '-b:a', '160k'];
            if (af) suffix.push('-af', af);
            suffix.push('-movflags', '+faststart', piece);
            await runEditEncode(prefix, suffix, job, 20, false);
            pieces.push(piece);
            if (piece !== dest) extras.push(piece);
        }
        if (pieces.length > 1) {
            const list = dest.replace(/\.mp4$/i, '_concat.txt');
            extras.push(list);
            const lines = pieces.map((p) => `file '${String(p).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
            fs.writeFileSync(list, lines, 'utf8');
            const total = ranges.reduce((acc, r) => acc + Math.max(0.2, r[1] - r[0]), 0);
            const vf = fadeFx
                ? `fade=t=in:st=0:d=0.18,fade=t=out:st=${Math.max(0.2, total - 0.32).toFixed(2)}:d=0.3`
                : null;
            const af = fadeFx
                ? `afade=t=in:st=0:d=0.12,afade=t=out:st=${Math.max(0.2, total - 0.28).toFixed(2)}:d=0.26`
                : null;
            const prefix = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
            if (vf) prefix.push('-vf', vf);
            const suffix = ['-c:a', 'aac', '-b:a', '160k'];
            if (af) suffix.push('-af', af);
            suffix.push('-movflags', '+faststart', dest);
            await runEditEncode(prefix, suffix, job, 20, false);
        }
    } finally {
        for (const f of extras) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    }
}

function numberedEpisodeName(index1, title) {
    let t = String(title || `Part ${index1}`).split(/[/\\]/).pop() || `Part ${index1}`;
    t = t.replace(/\.(mp4|mov|webm|m4v)$/i, '');
    t = t.replace(/^\s*\d+\s*[.\-–—:)]\s*/, '');
    t = t.replace(/[<>:"|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim() || `Part ${index1}`;
    return safeDownloadName(`${index1}.${t}.mp4`);
}

function safeDownloadName(raw) {
    const base = String(raw).split(/[/\\]/).pop() || 'video.mp4';
    let cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, ' ').replace(/^\.+/, '');
    cleaned = cleaned.replace(/[-_]{2,}/g, ' ').replace(/\s+/g, ' ').trim() || 'video.mp4';
    if (/\.(mp4|mov|webm|m4v)$/i.test(cleaned)) {
        return cleaned.replace(/\.(mov|webm|m4v)$/i, '.mp4');
    }
    return `${cleaned}.mp4`;
}

const evenPx = (n) => {
    const v = Math.round(Number(n) || 0);
    return Math.max(2, v - (v % 2));
};

const detectLetterbox = (inputPath, srcW, srcH, job) => new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-i', inputPath,
        '-vf', 'cropdetect=32:2:0',
        '-t', '8', '-an', '-f', 'null', '-',
    ], { env: ffmpegEnv, windowsHide: true });
    if (job) job.ffmpeg = ff;
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('close', () => {
        if (job) job.ffmpeg = null;
        const matches = [...err.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
        if (!matches.length) return resolve(null);
        const tail = matches.slice(-10);
        const mid = (i) => {
            const vals = tail.map((m) => Number(m[i])).sort((a, b) => a - b);
            return evenPx(vals[Math.floor(vals.length / 2)]);
        };
        let w = mid(1);
        let h = mid(2);
        let x = mid(3);
        let y = mid(4);
        if (w < 80 || h < 80) return resolve(null);
        if (x + w > srcW) w = evenPx(srcW - x);
        if (y + h > srcH) h = evenPx(srcH - y);
        if (w >= srcW * 0.92 && h >= srcH * 0.92) return resolve(null);
        // Reject "face strip" false positives (e.g. 800x220 from 1920x1080).
        if (w < srcW * 0.55 && h < srcH * 0.55) return resolve(null);
        if (w < 480 || h < 360) return resolve(null);
        if (w * h < srcW * srcH * 0.28) return resolve(null);
        resolve({ w, h, x, y });
    });
    ff.on('error', () => resolve(null));
});

const grabGrayFrame = (inputPath, t, gw, gh) => new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.max(0, t)), '-i', inputPath,
        '-frames:v', '1',
        '-vf', 'scale=' + gw + ':' + gh,
        '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { env: ffmpegEnv, windowsHide: true });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('close', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length >= gw * gh ? buf.subarray(0, gw * gh) : null);
    });
    ff.on('error', () => resolve(null));
});

const bestEnergyWindow = (scores, minLen, maxLen) => {
    const n = scores.length;
    const lo = Math.max(3, Math.min(n - 1, minLen));
    const hi = Math.max(lo, Math.min(n, maxLen));
    const prefix = [0];
    for (const s of scores) prefix.push(prefix[prefix.length - 1] + s);
    let bestA = 0;
    let bestB = n;
    let best = -1;
    for (let len = lo; len <= hi; len++) {
        for (let a = 0; a + len <= n; a++) {
            const mean = (prefix[a + len] - prefix[a]) / len;
            if (mean > best) {
                best = mean;
                bestA = a;
                bestB = a + len;
            }
        }
    }
    return { a: bestA, b: bestB, mean: best };
};

const detectSharpIsland = async (inputPath, srcW, srcH, duration) => {
    // CapCut-style: 16:9 sharp band in a 9:16 canvas with blur/black bars.
    // Landscape 16:9 (YouTube) must NEVER be treated as an island — that was
    // cropping a 800x220 "face strip" then zooming it into 1080x1920.
    const portrait = srcH / Math.max(1, srcW) >= 1.2;
    if (!portrait) return null;

    const gw = 96;
    const gh = evenPx(Math.max(32, Math.round(srcH * gw / srcW)));
    const times = [0.08, 0.20, 0.35, 0.50, 0.65, 0.80, 0.92]
        .map((p) => Math.min(Math.max(0.1, duration * p), Math.max(0.1, duration - 0.15)));
    const rowAcc = new Array(gh).fill(0);
    let frames = 0;
    let barVotes = 0;
    let fillVotes = 0;
    const bandH = Math.round(gh * ((srcW * 9 / 16) / srcH));
    if (bandH < 8) return null;

    const frameHasBars = (rows) => {
        const capcut = bestEnergyWindow(rows, Math.max(6, bandH - 3), bandH + 3);
        const topN = Math.max(3, Math.floor(gh * 0.14));
        const topMean = rows.slice(0, topN).reduce((a, b) => a + b, 0) / topN;
        const botMean = rows.slice(gh - topN).reduce((a, b) => a + b, 0) / topN;
        const midMean = capcut.mean;
        if (!(midMean > topMean * 1.7 && midMean > botMean * 1.7)) return false;
        if (capcut.a < 2 || capcut.b > gh - 2) return false;
        const hFrac = (capcut.b - capcut.a) / gh;
        return hFrac >= 0.22 && hFrac <= 0.62;
    };

    for (const t of times) {
        const buf = await grabGrayFrame(inputPath, t, gw, gh);
        if (!buf) continue;
        frames += 1;
        const rows = new Array(gh).fill(0);
        for (let y = 0; y < gh; y++) {
            let s = 0;
            let s2 = 0;
            let edge = 0;
            let prev = buf[y * gw];
            for (let x = 0; x < gw; x++) {
                const v = buf[y * gw + x];
                s += v;
                s2 += v * v;
                edge += Math.abs(v - prev);
                prev = v;
            }
            const mean = s / gw;
            rows[y] = Math.max(0, s2 / gw - mean * mean) + edge * 2;
            rowAcc[y] += rows[y];
        }
        if (frameHasBars(rows)) barVotes += 1;
        else fillVotes += 1;
    }
    if (!frames) return null;
    // Mixed 9:16 (contain + fill close-ups): overlaying a 16:9 island onto fill
    // shots cuts a horizontal band through the face. Unique the full frame.
    if (barVotes >= 1 && fillVotes >= 1) {
        return { mixed: true, kind: 'mixed', barVotes, fillVotes, frames };
    }
    if (!barVotes) return null;

    const rows = rowAcc.map((v) => v / frames);
    const capcut = bestEnergyWindow(rows, Math.max(6, bandH - 3), bandH + 3);
    const topN = Math.max(3, Math.floor(gh * 0.14));
    const botN = topN;
    const topMean = rows.slice(0, topN).reduce((a, b) => a + b, 0) / topN;
    const botMean = rows.slice(gh - botN).reduce((a, b) => a + b, 0) / botN;
    const midMean = capcut.mean;
    // Real blur/letterbox: both top AND bottom are dull compared to the 16:9 band.
    if (!(midMean > topMean * 1.7 && midMean > botMean * 1.7)) return null;
    if (capcut.a < 2 || capcut.b > gh - 2) return null;

    const padY = Math.max(1, Math.round((capcut.b - capcut.a) * 0.03));
    const y0 = Math.max(0, capcut.a - padY);
    const y1 = Math.min(gh, capcut.b + padY);
    const y = evenPx(Math.round(y0 * srcH / gh));
    let h = evenPx(Math.round((y1 - y0) * srcH / gh));
    if (y + h > srcH) h = evenPx(srcH - y);
    const x = 0;
    const w = evenPx(srcW);
    if (h < 360 || w < 480) return null;
    if (h < srcH * 0.22 || h > srcH * 0.62) return null;
    if (w * h < srcW * srcH * 0.18) return null;
    if (h >= srcH * 0.88) return null;
    return { w, h, x, y, kind: 'sharp' };
};

const detectContentIsland = async (inputPath, srcW, srcH, duration, job) => {
    try {
        const sharp = await detectSharpIsland(inputPath, srcW, srcH, duration);
        if (sharp) return sharp;
    } catch { /* fall through */ }
    return detectLetterbox(inputPath, srcW, srcH, job);
};

// Locate the visible bar edges, i.e. where a blur/letterbox fill meets the picture.
// A sharpness profile cannot do this: flat dark picture content scores as low as a
// blurred bar, so the "content island" heuristic happily picks a sub-band in the middle
// of the subject. What is reliable is the luminance step at the boundary, measured as a
// per-row mean across several frames (content moves, the bar edge does not).

const REFRAME_ASPECTS = {
    '9:16': { w: 1080, h: 1920 },
    '3:4': { w: 1080, h: 1440 },
    '4:5': { w: 1080, h: 1350 },
    '1:1': { w: 1080, h: 1080 },
    '4:3': { w: 1440, h: 1080 },
    '3:2': { w: 1620, h: 1080 },
    '16:9': { w: 1920, h: 1080 },
};

const reframeSysPrompt = (duration, srcW, srcH, aspect) => `You are a professional auto-reframe editor (Premiere Auto Reframe / CapCut smart crop class).
Watch AND listen to the entire video (${srcW}x${srcH}, ${duration.toFixed(1)} seconds).
Target output aspect: ${aspect} (phone vertical unless 1:1).

Return JSON only:
{"summary":"who you follow","track":[{"t":0.0,"cx":0.52,"cy":0.42,"who":"Jeffy talking"}]}

HARD RULES:
- cx, cy = center of the ACTION in the SOURCE frame, range 0..1. (0,0) top-left, (1,1) bottom-right.
- Follow in this priority: (1) whoever is speaking (2) puppet/person moving or interacting (3) the visual punch.
- Puppets count as faces. NEVER aim at empty letterbox, blurred bars, or dead sky.
- Place the subject in the upper-middle of the future ${aspect} window (cy slightly above 0.5 so heads are not cut).
- New point on every shot change, speaker change, or big motion. Also at least every 2.5 seconds.
- First point t=0. Last point t <= ${duration.toFixed(2)}.
- Adjacent points should usually move < 0.25 in cx (smooth pan, not a snap).
- 12 to 40 points. Field "who" = short English label of who/what is framed.`;

const parseReframeTrack = (text, duration) => {
    const raw = String(text || '');
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = (fence ? fence[1] : raw).trim();
    const a0 = jsonText.indexOf('{');
    const a1 = jsonText.lastIndexOf('}');
    if (a0 < 0 || a1 <= a0) throw new Error('Gemini did not return reframe JSON');
    let parsed;
    try {
        parsed = JSON.parse(jsonText.slice(a0, a1 + 1));
    } catch {
        throw new Error('Gemini reframe JSON parse failed');
    }
    const dur = Math.max(0.2, Number(duration) || 0);
    const list = Array.isArray(parsed.track) ? parsed.track : (Array.isArray(parsed.points) ? parsed.points : []);
    const pts = [];
    for (const p of list) {
        const t = Number(p.t ?? p.time ?? p.start);
        const cx = Number(p.cx ?? p.x ?? p.fx);
        const cy = Number(p.cy ?? p.y ?? p.fy);
        if (!Number.isFinite(t) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        pts.push({
            t: Math.max(0, Math.min(dur, t)),
            cx: Math.max(0.08, Math.min(0.92, cx)),
            cy: Math.max(0.12, Math.min(0.88, cy)),
            who: String(p.who || p.label || '').slice(0, 48),
        });
    }
    pts.sort((a, b) => a.t - b.t);
    if (pts.length < 2) throw new Error('Gemini reframe track too short — need at least 2 points');
    if (pts[0].t > 0.05) pts.unshift({ ...pts[0], t: 0 });
    if (pts[pts.length - 1].t < dur - 0.15) pts.push({ ...pts[pts.length - 1], t: dur });
    return { summary: String(parsed.summary || '').slice(0, 240), track: pts };
};

const lerpRf = (a, b, u) => a + (b - a) * u;

const smoothReframeTrack = (pts, duration) => {
    const dur = Math.max(0.2, Number(duration) || 0);
    const src = pts.slice().sort((a, b) => a.t - b.t);
    const step = 0.2;
    const out = [];
    let i = 0;
    for (let t = 0; t <= dur + 0.001; t += step) {
        const tt = Math.min(dur, t);
        while (i + 1 < src.length && src[i + 1].t < tt) i += 1;
        const a = src[i];
        const b = src[Math.min(src.length - 1, i + 1)];
        const span = Math.max(0.001, b.t - a.t);
        const u = b === a ? 0 : Math.max(0, Math.min(1, (tt - a.t) / span));
        const s = u * u * (3 - 2 * u);
        out.push({
            t: Math.round(tt * 1000) / 1000,
            cx: lerpRf(a.cx, b.cx, s),
            cy: lerpRf(a.cy, b.cy, s),
            who: s < 0.5 ? a.who : b.who,
        });
    }
    const maxV = 0.22;
    for (let k = 1; k < out.length; k++) {
        const dt = Math.max(0.05, out[k].t - out[k - 1].t);
        const lim = maxV * dt;
        const dx = out[k].cx - out[k - 1].cx;
        const dy = out[k].cy - out[k - 1].cy;
        if (Math.abs(dx) > lim) out[k].cx = out[k - 1].cx + Math.sign(dx) * lim;
        if (Math.abs(dy) > lim) out[k].cy = out[k - 1].cy + Math.sign(dy) * lim;
    }
    return out;
};

const cropWindowSize = (srcW, srcH, outW, outH, tightness) => {
    const target = outW / outH;
    // Largest target-aspect rectangle that still fits in the source.
    let maxH = srcH;
    let maxW = maxH * target;
    if (maxW > srcW) {
        maxW = srcW;
        maxH = maxW / target;
    }
    // Tightness zooms in a little. Never more than ~1.25x from the max window,
    // and never so small that 1080p output would be a 5–9× upscale of mush.
    const z = Math.max(1, Math.min(1.25, Number(tightness) || 1.08));
    let w = maxW / z;
    let h = maxH / z;
    const minW = Math.max(360, Math.min(maxW, outW / 2.6));
    const minH = Math.max(360, Math.min(maxH, outH / 2.6));
    if (w < minW || h < minH) {
        w = maxW;
        h = maxH;
    }
    w = evenPx(Math.floor(w));
    h = evenPx(Math.floor(h));
    if (w > srcW) w = evenPx(srcW);
    if (h > srcH) h = evenPx(srcH);
    if (w < 64) w = evenPx(Math.min(srcW, 64));
    if (h < 64) h = evenPx(Math.min(srcH, 64));
    return { w, h };
};

const islandFitsReframe = (island, outW, outH) => {
    if (!island || island.mixed) return false;
    if (island.w < 480 || island.h < 360) return false;
    const target = outW / outH;
    let h = island.h;
    let w = h * target;
    if (w > island.w) {
        w = island.w;
        h = w / target;
    }
    return w >= 320 && h >= 320 && (outW / Math.max(1, w)) <= 3.4;
};


const pixelOf = (p, axis, srcW, srcH, cropW, cropH) => {
    const maxX = Math.max(0, srcW - cropW);
    const maxY = Math.max(0, srcH - cropH);
    if (axis === 'x') {
        return Math.max(0, Math.min(maxX, p.cx * srcW - cropW / 2));
    }
    return Math.max(0, Math.min(maxY, p.cy * srcH - cropH / 2));
};

const ffmpegLerpExpr = (pts, axis, srcW, srcH, cropW, cropH) => {
    if (!pts.length) return '0';
    if (pts.length === 1) return String(evenPx(Math.round(pixelOf(pts[0], axis, srcW, srcH, cropW, cropH))));
    const parts = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const va = pixelOf(a, axis, srcW, srcH, cropW, cropH);
        const vb = pixelOf(b, axis, srcW, srcH, cropW, cropH);
        const dt = Math.max(0.001, b.t - a.t);
        parts.push(
            'gte(t\\,' + a.t.toFixed(3) + ')*lt(t\\,' + b.t.toFixed(3) + ')*(' +
            va.toFixed(2) + '+(' + (vb - va).toFixed(2) + ')*(t-' + a.t.toFixed(3) + ')/' + dt.toFixed(3) + ')'
        );
    }
    const last = pts[pts.length - 1];
    parts.push('gte(t\\,' + last.t.toFixed(3) + ')*' + pixelOf(last, axis, srcW, srcH, cropW, cropH).toFixed(2));
    return 'trunc((' + parts.join('+') + ')/2)*2';
};

const ffmpegHoldSnapExpr = (pts, axis, srcW, srcH, cropW, cropH) => {
    if (!pts.length) return '0';
    if (pts.length === 1) return String(evenPx(Math.round(pixelOf(pts[0], axis, srcW, srcH, cropW, cropH))));
    const parts = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const va = pixelOf(a, axis, srcW, srcH, cropW, cropH);
        const vb = pixelOf(b, axis, srcW, srcH, cropW, cropH);
        const jump = (a.who && b.who && a.who !== b.who)
            || Math.abs((a.cx || 0.5) - (b.cx || 0.5)) > 0.10;
        if (jump) {
            parts.push('gte(t\\,' + a.t.toFixed(3) + ')*lt(t\\,' + b.t.toFixed(3) + ')*' + va.toFixed(2));
        } else {
            const dt = Math.max(0.001, b.t - a.t);
            parts.push(
                'gte(t\\,' + a.t.toFixed(3) + ')*lt(t\\,' + b.t.toFixed(3) + ')*(' +
                va.toFixed(2) + '+(' + (vb - va).toFixed(2) + ')*(t-' + a.t.toFixed(3) + ')/' + dt.toFixed(3) + ')'
            );
        }
    }
    const last = pts[pts.length - 1];
    parts.push('gte(t\\,' + last.t.toFixed(3) + ')*' + pixelOf(last, axis, srcW, srcH, cropW, cropH).toFixed(2));
    return 'trunc((' + balancedSum(parts) + ')/2)*2';
};

const thinTrack = (pts, maxN) => {
    if (!pts.length) return pts;
    if (pts.length <= maxN) return pts;
    const out = [pts[0]];
    const step = (pts.length - 1) / (maxN - 1);
    for (let i = 1; i < maxN - 1; i++) out.push(pts[Math.round(i * step)]);
    out.push(pts[pts.length - 1]);
    return out;
};

const followCropVf = (pts, srcW, srcH, cropW, cropH, outW, outH) => {
    const xExpr = ffmpegLerpExpr(pts, 'x', srcW, srcH, cropW, cropH);
    const yExpr = ffmpegLerpExpr(pts, 'y', srcW, srcH, cropW, cropH);
    return 'crop=' + cropW + ':' + cropH + ':x=' + xExpr + ':y=' + yExpr +
        ',scale=' + outW + ':' + outH + ':flags=lanczos,setsar=1';
};

async function geminiGenerateReframe(apiKey, model, fileUri, duration, srcW, srcH, aspect) {
    const modelId = String(model || 'gemini-3.8-flash').replace(/[^a-zA-Z0-9._-]/g, '') || 'gemini-3.8-flash';
    const sys = reframeSysPrompt(duration, srcW, srcH, aspect);
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelId + ':generateContent?key=' + encodeURIComponent(apiKey);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{
                role: 'user',
                parts: [
                    { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
                    { text: sys },
                ],
            }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error?.message || ('Gemini generate ' + res.status));
    const text = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
    if (!text.trim()) throw new Error('Gemini returned empty reframe');
    return parseReframeTrack(text, duration);
}

async function vertexGenerateReframe(auth, model, videoPath, duration, srcW, srcH, aspect, job, onLog) {
    const shrunk = await shrinkProxyForVertex(videoPath, job, onLog);
    const filePath = shrunk.filePath;
    if (onLog) onLog('[REFRAME] Vertex proxy ' + shrunk.mb.toFixed(1) + 'MB');
    const b64 = (await fs.promises.readFile(filePath)).toString('base64');
    const modelId = vertexModelId(model);
    const locations = [auth.location || 'us-central1', 'global'];
    const body = JSON.stringify({
        contents: [{
            role: 'user',
            parts: [
                { inlineData: { mimeType: 'video/mp4', data: b64 } },
                { text: reframeSysPrompt(duration, srcW, srcH, aspect) },
            ],
        }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    });
    let lastErr = '';
    for (const loc of locations) {
        const host = loc === 'global' ? 'aiplatform.googleapis.com' : (loc + '-aiplatform.googleapis.com');
        const url = 'https://' + host + '/v1/projects/' + auth.project + '/locations/' + loc + '/publishers/google/models/' + modelId + ':generateContent';
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (job && job.cancelled) throw new Error('cancelled');
            try {
                if (attempt > 1) {
                    if (onLog) onLog('[REFRAME] Vertex retry ' + attempt + '/3 @ ' + loc + '…');
                    try { auth = await getAdcAuth(); } catch { /* keep */ }
                    await new Promise((r) => setTimeout(r, 2000 * attempt));
                }
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer ' + auth.token,
                        'Content-Type': 'application/json',
                        'x-goog-user-project': auth.project,
                    },
                    body,
                    signal: jobSignal(job, 15 * 60 * 1000),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) {
                    lastErr = j.error?.message || ('Vertex ' + res.status + ' @ ' + loc);
                    if (res.status >= 500 || res.status === 429) continue;
                    break;
                }
                const text = (j.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('\n');
                if (!text.trim()) {
                    lastErr = 'Vertex empty @ ' + loc;
                    continue;
                }
                return parseReframeTrack(text, duration);
            } catch (err) {
                if (job && job.cancelled) throw new Error('cancelled');
                const m = err instanceof Error ? err.message : String(err);
                lastErr = m;
                if (onLog) onLog('[REFRAME] ' + m);
            }
        }
    }
    throw new Error(lastErr || 'Vertex reframe failed');
}

app.post('/api/reframe/job-local', (req, res) => {
    const localPath = String(req.body?.path || '').trim();
    if (!localPath || !fs.existsSync(localPath)) {
        return res.status(400).json({ error: 'Local video path missing' });
    }
    const st = fs.statSync(localPath);
    if (!st.isFile() || st.size < 100) {
        return res.status(400).json({ error: 'Not a usable video file' });
    }
    const jobId = crypto.randomBytes(16).toString('hex');
    const settings = { ...(req.body || {}) };
    delete settings.path;
    jobs.set(jobId, {
        kind: 'reframe',
        inputPath: localPath,
        originalName: path.basename(localPath),
        originalSize: st.size,
        keepInput: true,
        settings,
        status: 'pending',
    });
    res.json({ jobId });
});

app.post('/api/reframe/job', (req, res, next) => {
    upload.single('video')(req, res, (err) => {
        if (err) return rejectMulter(err, req, res, next);
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const jobId = req.file.filename;
        jobs.set(jobId, {
            kind: 'reframe',
            inputPath: req.file.path,
            originalName: req.file.originalname,
            originalSize: req.file.size,
            settings: req.body || {},
            status: 'pending',
        });
        res.json({ jobId });
    });
});

app.get('/api/reframe/stream/:jobId', async (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    if (!job || job.kind !== 'reframe') return res.status(404).end();

    const send = subscribeJob(job, res);
    if (!send) return;

    const settings = job.settings || {};
    const aspectKey = REFRAME_ASPECTS[settings.aspect] ? String(settings.aspect) : '9:16';
    const outBox = REFRAME_ASPECTS[aspectKey];
    const tightness = Math.max(1, Math.min(1.55, Number(settings.tightness) || 1.08));
    const apiKey = String(settings.apiKey || '').trim();
    const model = String(settings.model || 'gemini-3.8-flash');
    job.settings.apiKey = '';

    const extras = [];
    try {
        send('log', { message: '[REFRAME] Probe source…' });
        send('progress', { value: 3 });
        const probe = await probeMedia(job.inputPath);
        const duration = probe.durationSec || 0;
        let srcW = evenPx(probe.width || 0);
        let srcH = evenPx(probe.height || 0);
        send('log', { message: '[REFRAME] Source ' + probe.width + 'x' + probe.height + ' · ' + duration.toFixed(1) + 's → ' + aspectKey + ' ' + outBox.w + 'x' + outBox.h });
        send('log', { message: '[REFRAME] crop engine v2 — follow by time (not sendcmd)' });
        if (duration < 1 || srcW < 64 || srcH < 64) throw new Error('Video too small to reframe');

        let workPath = job.inputPath;
        send('log', { message: '[REFRAME] Scanning for content island (CapCut blur bars / letterbox)…' });
        let island = await detectContentIsland(workPath, srcW, srcH, duration, job);
        if (island && !islandFitsReframe(island, outBox.w, outBox.h)) {
            send('log', { message: '[REFRAME] Island ' + island.w + 'x' + island.h + ' too small to reframe (would zoom to mush) — using full ' + srcW + 'x' + srcH });
            island = null;
        }
        if (island) {
            send('log', { message: '[REFRAME] Picture island ' + island.w + 'x' + island.h + ' at x=' + island.x + ' y=' + island.y + (island.kind === 'sharp' ? ' (sharp band — blur bars ignored)' : ' (cropdetect)') });
            const islandPath = path.join(uploadsDir, jobId + '_island.mp4');
            extras.push(islandPath);
            await runFf([
                '-y', '-i', workPath,
                '-vf', 'crop=' + island.w + ':' + island.h + ':' + island.x + ':' + island.y,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                '-c:a', 'aac', '-b:a', '160k',
                islandPath,
            ], job);
            workPath = islandPath;
            const p2 = await probeMedia(workPath);
            srcW = evenPx(p2.width || island.w);
            srcH = evenPx(p2.height || island.h);
            send('log', { message: '[REFRAME] Working source now ' + srcW + 'x' + srcH + ' (content only)' });
        } else {
            send('log', { message: '[REFRAME] No island — reframe the full ' + srcW + 'x' + srcH + ' frame' });
        }

        send('log', { message: '[REFRAME] Making a small proxy for Gemini (watch + listen)…' });
        send('progress', { value: 8 });
        const proxyPath = path.join(uploadsDir, jobId + '_gemini.mp4');
        extras.push(proxyPath);
        job.proxyPath = proxyPath;
        await runFf([
            '-y', '-i', workPath,
            '-vf', "scale='min(854,iw)':-2",
            '-r', '12',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
            '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
            '-movflags', '+faststart',
            proxyPath,
        ], job);
        send('log', { message: '[REFRAME] Proxy ready ' + (fs.statSync(proxyPath).size / 1024 / 1024).toFixed(1) + 'MB' });

        const waitPulse = (label) => {
            const estMs = Math.min(480000, Math.max(25000, duration * 500));
            const t0 = Date.now();
            send('log', { message: '[REFRAME] ' + label + ' — clip ' + duration.toFixed(0) + 's, ước tính ~' + Math.round(estMs / 1000) + 's' });
            send('progress', { value: 16, watch: 1, phase: 'watching' });
            let lastLogged = 0;
            return setInterval(() => {
                const elapsed = Date.now() - t0;
                const watch = Math.min(99, Math.max(1, Math.round((elapsed / estMs) * 100)));
                send('progress', { value: 16 + Math.round(watch * 0.24), watch, phase: 'watching' });
                if (watch >= lastLogged + 5) {
                    lastLogged = watch;
                    send('log', { message: '[REFRAME] Gemini watching ' + watch + '% (' + Math.round(elapsed / 1000) + 's)' });
                }
            }, 1000);
        };

        let plan;
        if (apiKey) {
            send('log', { message: '[REFRAME] Uploading proxy to Gemini API (' + model + ')…' });
            const uploaded = await geminiUploadVideo(apiKey, proxyPath, job.originalName);
            const hb = waitPulse('Gemini is watching for action / speaker');
            try {
                plan = await geminiGenerateReframe(apiKey, model, uploaded.uri, duration, srcW, srcH, aspectKey);
            } finally {
                clearInterval(hb);
                await geminiDeleteFile(apiKey, uploaded.name);
            }
        } else {
            send('log', { message: '[REFRAME] Using Google Cloud ADC (gcloud login)…' });
            const auth = await getAdcAuth();
            send('log', { message: '[REFRAME] ADC project ' + auth.project + ' · ' + auth.location + ' · ' + model });
            const hb = waitPulse('Vertex Gemini is watching for action / speaker');
            try {
                plan = await vertexGenerateReframe(
                    auth, model, proxyPath, duration, srcW, srcH, aspectKey, job,
                    (m) => send('log', { message: m }),
                );
            } finally {
                clearInterval(hb);
            }
        }

        send('progress', { value: 48, watch: 100, phase: 'crop' });
        send('log', { message: '[REFRAME] Track: ' + plan.track.length + ' AI points · ' + (plan.summary || 'follow action') });
        const sample = plan.track.filter((_, i) => i % Math.max(1, Math.floor(plan.track.length / 8)) === 0).slice(0, 8);
        sample.forEach((p) => send('log', { message: '[REFRAME] t=' + p.t.toFixed(1) + 's  cx=' + p.cx.toFixed(2) + ' cy=' + p.cy.toFixed(2) + '  ' + (p.who || '') }));

        const win = cropWindowSize(srcW, srcH, outBox.w, outBox.h, tightness);
        const smooth = thinTrack(smoothReframeTrack(plan.track, duration), 48);
        const x0 = evenPx(Math.round(pixelOf(smooth[0], 'x', srcW, srcH, win.w, win.h)));
        const x1 = evenPx(Math.round(pixelOf(smooth[smooth.length - 1], 'x', srcW, srcH, win.w, win.h)));
        const y0 = evenPx(Math.round(pixelOf(smooth[0], 'y', srcW, srcH, win.w, win.h)));
        const y1 = evenPx(Math.round(pixelOf(smooth[smooth.length - 1], 'y', srcW, srcH, win.w, win.h)));
        send('log', { message: '[REFRAME] Crop window ' + win.w + 'x' + win.h + ' in ' + srcW + 'x' + srcH + ' · tightness ' + tightness.toFixed(2) + ' · ' + smooth.length + ' pans  x ' + x0 + '→' + x1 + '  y ' + y0 + '→' + y1 });

        const outPath = path.join(uploadsDir, jobId + '_output.mp4');
        job.outputPath = outPath;
        send('log', { message: '[REFRAME] FFmpeg smart crop (follow speaker / action)…' });
        send('progress', { value: 55, phase: 'encode' });
        const vfFollow = followCropVf(smooth, srcW, srcH, win.w, win.h, outBox.w, outBox.h);
        try {
            await runFf([
                '-y', '-i', path.resolve(workPath),
                '-vf', vfFollow,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                '-c:a', 'aac', '-b:a', '160k',
                '-movflags', '+faststart',
                path.resolve(outPath),
            ], job);
        } catch (ffErr) {
            send('log', { message: '[REFRAME] Expression crop failed — ' + String(ffErr instanceof Error ? ffErr.message : ffErr).slice(0, 180) });
            send('log', { message: '[REFRAME] Falling back to keyed cuts (still follows speaker, a bit jumpy)' });
            const parts = [];
            for (let i = 0; i < smooth.length; i++) {
                const a = smooth[i];
                const b = smooth[i + 1];
                const t0 = a.t;
                const t1 = b ? b.t : duration;
                if (t1 - t0 < 0.04) continue;
                const sx = evenPx(Math.round(pixelOf(a, 'x', srcW, srcH, win.w, win.h)));
                const sy = evenPx(Math.round(pixelOf(a, 'y', srcW, srcH, win.w, win.h)));
                const seg = path.join(uploadsDir, jobId + '_k' + i + '.mp4');
                extras.push(seg);
                await runFf([
                    '-y', '-ss', t0.toFixed(3), '-to', t1.toFixed(3), '-i', path.resolve(workPath),
                    '-vf', 'crop=' + win.w + ':' + win.h + ':' + sx + ':' + sy + ',scale=' + outBox.w + ':' + outBox.h + ':flags=lanczos,setsar=1',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                    '-c:a', 'aac', '-b:a', '160k',
                    seg,
                ], job);
                parts.push(seg);
            }
            if (!parts.length) throw new Error('No reframe segments');
            const listFile = path.join(uploadsDir, jobId + '_reframe_concat.txt');
            extras.push(listFile);
            fs.writeFileSync(listFile, parts.map((p) => "file '" + p.replace(/\\/g, '/') + "'").join('\n'));
            await runFf([
                '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
                '-c', 'copy',
                '-movflags', '+faststart',
                path.resolve(outPath),
            ], job);
        }

        const stem = String(job.originalName || 'reframe.mp4').replace(/\.[^.]+$/, '');
        const outName = safeDownloadName(stem + '-' + aspectKey.replace(':', 'x') + '.mp4');
        job.originalName = outName;
        job.status = 'done';
        send('progress', { value: 100, phase: 'done' });
        send('log', { message: '[REFRAME] SUCCESS: ' + outName + ' · ' + outBox.w + 'x' + outBox.h + ' · followed ' + (plan.summary || 'action') });
        send('done', {
            downloadUrl: '/api/download/' + jobId,
            name: outName,
            width: outBox.w,
            height: outBox.h,
            summary: plan.summary,
            points: plan.track.length,
        });
        res.end();
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send('error', { message });
        send('log', { message: '[REFRAME] ERROR: ' + message });
        if (!res.writableEnded) res.end();
    } finally {
        for (const f of extras) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    }
});

app.use((err, req, res, next) => {
    const aborted = req.aborted || err?.code === 'ECONNABORTED' || /aborted/i.test(String(err?.message || ''));
    if (aborted) {
        if (!res.headersSent) res.status(499).end();
        return;
    }
    if (!res.headersSent) {
        res.status(500).json({ error: err?.message || String(err) });
        return;
    }
    next(err);
});

export {
    app,
    probeMedia,
    runEditEncode,
    detectSceneTimes,
    geminiUploadVideo,
    geminiGeneratePlan,
    geminiDeleteFile,
    getAdcAuth,
    vertexGeneratePlan,
    extractDetailEvidenceJpegs,
    vertexGenerateDetailMultimodal,
    mixFrameClip,
    composeFocusClip,
};

if (process.env.GHOSTFORGE_STANDALONE === '1') {
    const PORT = 3033;
    app.listen(PORT, '127.0.0.1', () => {
        console.log(`GhostForge Backend is running on http://127.0.0.1:${PORT}`);
    });
}
