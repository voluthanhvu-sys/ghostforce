import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const FFMPEG = 'C:\\ffmpeg\\ffmpeg.exe';
const INPUT = 'C:\\Users\\T15p\\Desktop\\sml\\5.Marvin Spikes The Drinks With NyQuil!.mp4';
const WIDTH = 96;
const HEIGHT = 54;
const FPS = 2;
const FRAME_BYTES = WIDTH * HEIGHT;
const SCENE_CANDIDATES = [0.6, 30.5, 79.3, 93.4];

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
};

const robustStats = (values) => {
  const med = median(values);
  const mad = median(values.map((value) => Math.abs(value - med)));
  return { med, scale: Math.max(1e-9, 1.4826 * mad) };
};

const normalizedProjectionDistance = (a, b) => {
  const sumA = a.reduce((sum, value) => sum + value, 0);
  const sumB = b.reduce((sum, value) => sum + value, 0);
  if (sumA <= 1e-9 && sumB <= 1e-9) return 0;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += Math.abs(a[i] / Math.max(sumA, 1e-9) - b[i] / Math.max(sumB, 1e-9));
  }
  return distance / 2;
};

const frameFeatures = (frame) => {
  const columns = new Array(WIDTH).fill(0);
  const rows = new Array(HEIGHT).fill(0);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      let edge = 0;
      if (x) edge += Math.abs(frame[i] - frame[i - 1]);
      if (y) edge += Math.abs(frame[i] - frame[i - WIDTH]);
      columns[x] += edge;
      rows[y] += edge;
    }
  }
  return { columns, rows };
};

const pairMetrics = (previous, current, previousFeatures, currentFeatures, frameIndex) => {
  let absoluteDifference = 0;
  for (let i = 0; i < FRAME_BYTES; i++) {
    absoluteDifference += Math.abs(current[i] - previous[i]);
  }
  return {
    time: frameIndex / FPS,
    pixelMad: absoluteDifference / FRAME_BYTES / 255,
    horizontalLayout: normalizedProjectionDistance(previousFeatures.columns, currentFeatures.columns),
    verticalLayout: normalizedProjectionDistance(previousFeatures.rows, currentFeatures.rows),
  };
};

const decodeFrames = () => new Promise((resolve, reject) => {
  const ffmpeg = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-i', INPUT, '-an',
    '-vf', `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=fast_bilinear,format=gray`,
    '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
  ], { windowsHide: true });
  const chunks = [];
  let stderr = '';
  ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
  ffmpeg.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  ffmpeg.on('error', reject);
  ffmpeg.on('close', (code) => {
    if (code !== 0) return reject(new Error(stderr.trim() || `FFmpeg exited ${code}`));
    const raw = Buffer.concat(chunks);
    const frameCount = Math.floor(raw.length / FRAME_BYTES);
    const frames = Array.from({ length: frameCount }, (_, index) =>
      raw.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES));
    resolve(frames);
  });
});

const selectCandidates = (rows) => {
  const pixelStats = robustStats(rows.map((row) => row.pixelMad));
  const horizontalStats = robustStats(rows.map((row) => row.horizontalLayout));
  const verticalStats = robustStats(rows.map((row) => row.verticalLayout));

  for (const row of rows) {
    const pixelZ = Math.max(0, (row.pixelMad - pixelStats.med) / pixelStats.scale);
    const horizontalZ = Math.max(0, (row.horizontalLayout - horizontalStats.med) / horizontalStats.scale);
    const verticalZ = Math.max(0, (row.verticalLayout - verticalStats.med) / verticalStats.scale);
    row.combinedScore = 0.5 * pixelZ + 0.25 * horizontalZ + 0.25 * verticalZ;
  }

  const combined = rows.map((row) => row.combinedScore);
  const combinedStats = robustStats(combined);
  const robustFloor = combinedStats.med + 3 * combinedStats.scale;
  const p95 = percentile(combined, 0.95);
  const threshold = Math.max(robustFloor, p95);

  const peakRadiusFrames = 2;
  const peaks = rows.filter((row, index) => {
    if (row.combinedScore < threshold) return false;
    const from = Math.max(0, index - peakRadiusFrames);
    const to = Math.min(rows.length - 1, index + peakRadiusFrames);
    for (let other = from; other <= to; other++) {
      if (other !== index && rows[other].combinedScore > row.combinedScore) return false;
      if (other < index && rows[other].combinedScore === row.combinedScore) return false;
    }
    return true;
  });

  const nmsSeconds = 1;
  const selected = [];
  for (const peak of [...peaks].sort((a, b) => b.combinedScore - a.combinedScore)) {
    if (selected.every((candidate) => Math.abs(candidate.time - peak.time) >= nmsSeconds)) {
      selected.push(peak);
    }
  }
  selected.sort((a, b) => a.time - b.time);
  const selectedSet = new Set(selected);
  rows.forEach((row) => { row.candidate = selectedSet.has(row); });

  return { selected, threshold, robustFloor, p95, pixelStats, horizontalStats, verticalStats };
};

const intervalsFor = (timestamps) => timestamps.slice(1).map((time, index) => time - timestamps[index]);

const mergeForReport = (scene, composition) => {
  const merged = scene.map((time) => ({ time, source: 'scene' }));
  for (const time of composition) {
    if (!merged.some((item) => Math.abs(item.time - time) <= 0.75)) {
      merged.push({ time, source: 'composition' });
    }
  }
  return merged.sort((a, b) => a.time - b.time);
};

const formatRows = (rows) => rows.map((row) => ({
  time: row.time.toFixed(1),
  pixelMad: row.pixelMad.toFixed(4),
  horizontalLayout: row.horizontalLayout.toFixed(4),
  verticalLayout: row.verticalLayout.toFixed(4),
  combinedScore: row.combinedScore.toFixed(2),
  candidate: row.candidate ? 'yes' : 'no',
}));

const main = async () => {
  const startedAt = performance.now();
  const frames = await decodeFrames();
  if (frames.length < 2) throw new Error(`Only ${frames.length} frame(s) decoded`);

  const rows = [];
  let previousFeatures = frameFeatures(frames[0]);
  for (let index = 1; index < frames.length; index++) {
    const currentFeatures = frameFeatures(frames[index]);
    rows.push(pairMetrics(frames[index - 1], frames[index], previousFeatures, currentFeatures, index));
    previousFeatures = currentFeatures;
  }

  const detection = selectCandidates(rows);
  const candidateTimes = detection.selected.map((row) => row.time);
  const gapCandidates = candidateTimes.filter((time) => time > 30.5 && time < 79.3);
  const intervals = intervalsFor(candidateTimes);
  const merged = mergeForReport(SCENE_CANDIDATES, candidateTimes);
  const topNonCandidates = rows
    .filter((row) => !row.candidate)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, 10);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const csvPath = path.join(root, 'tmp', 'part5-composition-probe.csv');
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  const csv = [
    'time,pixelMad,horizontalLayout,verticalLayout,combinedScore,candidate',
    ...rows.map((row) => [
      row.time.toFixed(3), row.pixelMad.toFixed(8), row.horizontalLayout.toFixed(8),
      row.verticalLayout.toFixed(8), row.combinedScore.toFixed(8), row.candidate ? 'yes' : 'no',
    ].join(',')),
  ].join('\n');
  fs.writeFileSync(csvPath, `${csv}\n`, 'utf8');

  console.log('\nSelected composition candidates');
  console.table(formatRows(detection.selected));
  console.log('\nTop-scoring non-candidates');
  console.table(formatRows(topNonCandidates));
  console.log('\nNoise-floor method');
  console.log(`combined = 0.50*pixelRobustZ + 0.25*horizontalRobustZ + 0.25*verticalRobustZ`);
  console.log(`threshold = max(median + 3*MADσ, p95) = max(${detection.robustFloor.toFixed(3)}, ${detection.p95.toFixed(3)}) = ${detection.threshold.toFixed(3)}`);

  const average = intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null;
  const shortest = intervals.length ? Math.min(...intervals) : null;
  const longest = intervals.length ? Math.max(...intervals) : null;
  const closeIntervals = intervals.filter((value) => value <= 1.01).length;
  const tooSparse = gapCandidates.length < 2;
  const tooNoisy = candidateTimes.length > frames.length / (FPS * 2)
    || (intervals.length > 3 && closeIntervals / intervals.length > 0.5);

  console.log('\nSummary');
  console.log(`runtime: ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
  console.log(`frames analyzed: ${frames.length} (${rows.length} consecutive pairs)`);
  console.log(`composition candidates: ${candidateTimes.length}`);
  console.log(`composition timestamps: ${candidateTimes.map((time) => time.toFixed(1)).join(', ') || '(none)'}`);
  console.log(`inside 30.5-79.3: ${gapCandidates.map((time) => time.toFixed(1)).join(', ') || '(none)'}`);
  console.log(`candidate interval avg/min/max: ${average?.toFixed(2) ?? 'n/a'} / ${shortest?.toFixed(2) ?? 'n/a'} / ${longest?.toFixed(2) ?? 'n/a'} seconds`);
  console.log(`merged scene+composition: ${merged.map((item) => `${item.time.toFixed(1)}[${item.source}]`).join(', ')}`);
  console.log(`sanity: ${tooSparse ? 'TOO SPARSE in critical gap' : 'gap recall is not obviously sparse'}; ${tooNoisy ? 'TOO NOISY' : 'not continuously noisy'}`);
  console.log(`csv: ${csvPath}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
