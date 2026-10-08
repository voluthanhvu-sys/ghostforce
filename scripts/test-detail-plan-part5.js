import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  probeMedia,
  runEditEncode,
  detectSceneTimes,
  geminiUploadVideo,
  geminiGeneratePlan,
  geminiDeleteFile,
  getAdcAuth,
  vertexGeneratePlan,
  mixFrameClip,
} from '../ghostforge-server.js';
import { compactSceneCutHints } from '../server/editor-plan.js';

const INPUT = 'C:\\Users\\T15p\\Desktop\\sml\\5.Marvin Spikes The Drinks With NyQuil!.mp4';
const MODEL = String(process.env.GHOSTFORGE_DETAIL_MODEL || 'gemini-3.8-flash');
const USER_PROMPT = String(process.env.GHOSTFORGE_DETAIL_PROMPT || 'Create a complete, visually coherent 9:16 edit plan for this excerpt.');
const API_KEY = String(process.env.GHOSTFORGE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '').trim();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = path.join(root, 'tmp');
const runTag = `${Date.now()}-${process.pid}`;
const proxyPath = path.join(tmpDir, `detail-plan-part5-${runTag}.mp4`);
const outputPath = path.join(tmpDir, 'detail-plan-part5-render.mp4');
const job = {
  cancelled: false,
  ffmpeg: null,
  editEncoder: String(process.env.GHOSTFORGE_DETAIL_ENCODER || 'cpu'),
  editOnLog: (message) => console.log(message),
};

const fmt = (value) => Number(value).toFixed(1);

const rawFrameView = (frame, index) => ({
  index: index + 1,
  start: frame?.start ?? frame?.from ?? frame?.t0,
  end: frame?.end ?? frame?.to ?? frame?.t1,
  mode: frame?.mode ?? frame?.kind ?? frame?.framing ?? frame?.type ?? '',
  why: frame?.why ?? frame?.reason ?? '',
});

const cleanupProxyArtifacts = () => {
  const paths = [proxyPath, proxyPath.replace(/\.mp4$/i, '_small.mp4')];
  for (let index = 1; index <= 6; index++) {
    paths.push(proxyPath.replace(/\.mp4$/i, `_s${index}.mp4`));
  }
  for (const filePath of paths) {
    try { fs.unlinkSync(filePath); } catch { /* missing or already removed */ }
  }
};

const main = async () => {
  if (!fs.existsSync(INPUT)) throw new Error(`Part 5 input missing: ${INPUT}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  let uploaded = null;
  let detailPlan;
  let aiRuntimeMs = 0;
  try {
    const probe = await probeMedia(INPUT);
    const duration = Number(probe?.durationSec) || 0;
    if (!(duration > 0)) throw new Error('Could not determine Part 5 duration');

    const detailSceneCuts = compactSceneCutHints(
      await detectSceneTimes(INPUT, duration, null),
      duration,
    );

    const proxyStartedAt = performance.now();
    await runEditEncode([
      '-y', '-i', INPUT,
      '-vf', "scale='min(854,iw)':-2",
      '-r', '12',
    ], [
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-movflags', '+faststart',
      proxyPath,
    ], job, 32, true);
    const proxyRuntimeMs = performance.now() - proxyStartedAt;

    const detailMinSec = Math.max(12, Math.min(25, duration * 0.35));
    if (API_KEY) {
      uploaded = await geminiUploadVideo(API_KEY, proxyPath, 'detail-plan-part5-test');
      const startedAt = performance.now();
      try {
        detailPlan = await geminiGeneratePlan(
          API_KEY, MODEL, uploaded.uri, USER_PROMPT,
          duration, 1, detailMinSec, false, true, true, detailSceneCuts,
        );
      } finally {
        aiRuntimeMs = performance.now() - startedAt;
      }
    } else {
      const auth = await getAdcAuth();
      const startedAt = performance.now();
      try {
        detailPlan = await vertexGeneratePlan(
          auth, MODEL, proxyPath, USER_PROMPT,
          duration, 1, detailMinSec, job,
          (message) => console.log(message),
          false, true, true, 'detail AI Part 5 test', detailSceneCuts,
        );
      } finally {
        aiRuntimeMs = performance.now() - startedAt;
      }
    }

    const rawFrames = detailPlan?._raw?.segments?.[0]?.frames;
    const normalized = detailPlan?.segments?.[0]?.frames || [];
    const rawCount = Array.isArray(rawFrames) ? rawFrames.length : 0;
    const fillCount = normalized.filter((frame) => frame.mode === 'fill').length;
    const containCount = normalized.filter((frame) => frame.mode === 'contain').length;
    const durations = normalized.map((frame) => Math.max(0, Number(frame.b) - Number(frame.a)));
    const averageDuration = durations.length
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : 0;
    const longestIndex = durations.length
      ? durations.reduce((best, value, index) => value > durations[best] ? index : best, 0)
      : -1;
    const longest = longestIndex >= 0 ? normalized[longestIndex] : null;
    const boundaries = normalized.length
      ? [...new Set([normalized[0].a, ...normalized.map((frame) => frame.b)].map((value) => Number(value)))]
        .sort((a, b) => a - b)
      : [];
    const criticalBoundaries = boundaries.filter((value) => value > 30.5 && value < 79.3);
    const renderStartedAt = performance.now();
    await mixFrameClip(
      INPUT,
      outputPath,
      job,
      (message) => console.log(message),
      normalized,
      detailPlan?.segments?.[0]?.track || [],
      [],
    );
    const renderRuntimeMs = performance.now() - renderStartedAt;

    console.log('\nDETAIL PLAN PART 5');
    console.log(`transport: ${API_KEY ? 'Gemini API upload' : 'Vertex ADC'}`);
    console.log(`model: ${MODEL}`);
    console.log(`duration: ${duration.toFixed(2)}s`);
    console.log(`sceneCuts: ${detailSceneCuts.map(fmt).join(', ') || '(none)'}`);
    console.log(`proxy runtime: ${(proxyRuntimeMs / 1000).toFixed(2)}s`);
    console.log(`AI runtime: ${(aiRuntimeMs / 1000).toFixed(2)}s`);
    console.log(`raw frames count: ${rawCount}`);
    console.log(`normalized frames count: ${normalized.length}`);

    console.log('\nNORMALIZED FRAMES');
    normalized.forEach((frame, index) => {
      const cx = Number.isFinite(frame.cx) ? Number(frame.cx).toFixed(3) : '';
      const cy = Number.isFinite(frame.cy) ? Number(frame.cy).toFixed(3) : '';
      console.log(`[${index + 1}] ${fmt(frame.a)}-${fmt(frame.b)}  ${frame.mode}  why="${frame.why || ''}"  cx=${cx} cy=${cy}`);
    });

    if (rawCount !== normalized.length && Array.isArray(rawFrames)) {
      console.log('\nRAW GEMINI FRAMES (count differs after normalization)');
      rawFrames.map(rawFrameView).forEach((frame) => {
        console.log(`[${frame.index}] ${frame.start}-${frame.end}  ${frame.mode}  why="${frame.why}"`);
      });
    }

    console.log('\nSUMMARY');
    console.log(`FILL: ${fillCount}`);
    console.log(`CONTAIN: ${containCount}`);
    console.log(`total normalized windows: ${normalized.length}`);
    console.log(`average window duration: ${averageDuration.toFixed(2)}s`);
    console.log(`longest window: ${longest ? `${fmt(longest.a)}-${fmt(longest.b)} ${longest.mode} (${durations[longestIndex].toFixed(2)}s)` : '(none)'}`);
    console.log(`boundaries inside 30.5-79.3: ${criticalBoundaries.length} (${criticalBoundaries.map(fmt).join(', ') || 'none'})`);
    console.log(`BOUNDARIES: ${boundaries.map(fmt).join(', ') || '(none)'}`);
    console.log(`render runtime: ${(renderRuntimeMs / 1000).toFixed(2)}s`);
    console.log(`final output: ${outputPath}`);
  } finally {
    if (uploaded) await geminiDeleteFile(API_KEY, uploaded.name);
    cleanupProxyArtifacts();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
