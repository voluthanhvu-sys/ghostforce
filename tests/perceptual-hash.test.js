import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_SIZE,
  DHASH_BITS,
  DHASH_H,
  DHASH_W,
  GRID_COLS,
  GRID_ROWS,
  PHASH_BITS,
  PHASH_SAMPLE,
  ROWSTEP_H,
  ROWSTEP_W,
  SEAM_VERDICT,
  SEAM_VISIBLE_STEP,
  dHashFromGray,
  distanceRatio,
  gridDHashRatios,
  hammingDistance,
  meanAbsDifference,
  pHashDistanceRatio,
  pHashFromGray,
  rowStepProfile,
  samplePairTimes,
  seamVerdict,
  summarizeDistances,
} from '../server/perceptual-hash.js';

const W = DHASH_W;
const H = DHASH_H;
const ALL_ONES = 'f'.repeat(DHASH_BITS / 4);
const ALL_ZEROS = '0'.repeat(DHASH_BITS / 4);

// Gradient rising to the right: every comparison is "left < right" -> all ones.
// The step stays inside 0..255 even for the widest supported grid.
const gradient = () => {
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) buf[y * W + x] = 10 + x * 14;
  }
  return buf;
};

// Same shape falling to the right: every comparison is "left >= right" -> all zeros.
const invertedGradient = () => {
  const buf = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) buf[y * W + x] = 240 - x * 14;
  }
  return buf;
};

test('dHash of a rising gradient is all ones and a falling gradient is all zeros', () => {
  assert.equal(dHashFromGray(gradient()), ALL_ONES);
  assert.equal(dHashFromGray(invertedGradient()), ALL_ZEROS);
  assert.equal(hammingDistance(dHashFromGray(gradient()), dHashFromGray(gradient())), 0);
  assert.equal(hammingDistance(dHashFromGray(gradient()), dHashFromGray(invertedGradient())), DHASH_BITS);
});

test('dHash packs the documented bit count and rejects short or malformed buffers', () => {
  const hash = dHashFromGray(gradient());
  assert.equal(hash.length, DHASH_BITS / 4);
  assert.equal(DHASH_BITS, 256);
  assert.equal(dHashFromGray(null), null);
  assert.equal(dHashFromGray(new Uint8Array(W * H - 1)), null);
  assert.equal(dHashFromGray(gradient(), 1, 8), null);
  assert.equal(dHashFromGray(gradient(), W, 0), null);
});

test('hamming comparison refuses mismatched or invalid hashes instead of guessing', () => {
  assert.equal(hammingDistance('ffff', 'ffff'), 0);
  assert.equal(hammingDistance('ffff', 'ff00'), 8);
  assert.equal(hammingDistance('ffff', 'fff'), null);
  assert.equal(hammingDistance('', ''), null);
  assert.equal(hammingDistance('zz', 'ff'), null);
  assert.equal(hammingDistance(null, 'ff'), null);
  assert.equal(distanceRatio(ALL_ONES, ALL_ZEROS), 1);
  assert.equal(distanceRatio(ALL_ONES, ALL_ONES.slice(0, -1) + 'e'), 1 / DHASH_BITS);
});

test('mean absolute difference reports grade-level change and rejects mismatched input', () => {
  const flat = new Uint8Array(W * H).fill(100);
  const brighter = new Uint8Array(W * H).fill(125);
  assert.equal(meanAbsDifference(flat, flat), 0);
  assert.equal(Number(meanAbsDifference(flat, brighter).toFixed(6)), Number((25 / 255).toFixed(6)));
  assert.equal(meanAbsDifference(null, flat), null);
  assert.equal(meanAbsDifference(flat, new Uint8Array(W * H - 1)), null);
  assert.equal(meanAbsDifference(flat, flat, 0, H), null);
});

test('sample pairs stay inside the clip and remap source time by the speed factor', () => {
  const pairs = samplePairTimes(100, 1.1, 3);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map((p) => Number(p.outputT.toFixed(3))), [12, 50, 88]);
  for (const pair of pairs) {
    assert.ok(pair.outputT >= 0 && pair.outputT <= 100);
    assert.equal(Number((pair.sourceT / 1.1).toFixed(3)), Number(pair.outputT.toFixed(3)));
  }
  assert.deepEqual(samplePairTimes(0, 1, 3), []);
  assert.deepEqual(samplePairTimes(null, 1, 3), []);
  assert.deepEqual(samplePairTimes(10, 0, 1), [{ outputT: 5, sourceT: 5 }]);
});

test('distance summary ignores non-numeric samples and reports mean/worst/best', () => {
  assert.equal(summarizeDistances([]), null);
  assert.equal(summarizeDistances([null, undefined, Number.NaN]), null);
  const summary = summarizeDistances([0.1, 0.3, 0.2]);
  assert.equal(summary.frames, 3);
  assert.equal(Number(summary.mean.toFixed(4)), 0.2);
  assert.equal(summary.worst, 0.3);
  assert.equal(summary.best, 0.1);
});

// ---- DCT pHash -----------------------------------------------------------

const P = ANALYSIS_SIZE; // 64: pHash downsamples to 32 internally, the grid needs the detail
const ZERO_PHASH = '0'.repeat(16);

const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));

const frame = (fn) => {
  const buf = new Uint8Array(P * P);
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) buf[y * P + x] = clampByte(fn(x, y));
  }
  return buf;
};

// Smooth 2D ramp. Stays inside 0..255 even with +60 applied, so a "brightness
// offset" test does not silently clip (clipping IS a real structure change and
// would make the test pass for the wrong reason).
const rampBase = (x, y) => 20 + x * 2 + 6 * Math.sin(y / 5);

// Deterministic LCG so a grain test is reproducible.
const makeNoise = () => {
  let seed = 12345;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
};

// 16px checkerboard: its period (32px in a 64px frame) lands inside the 8x8
// low-frequency block, so pHash can actually see it.
const checker = (hi, lo) => frame((x, y) => (((x >> 4) + (y >> 4)) % 2 ? hi : lo));

test('pHash of a flat frame is all zeros and ignores brightness and grain', () => {
  const flat = frame(() => 128);
  assert.equal(pHashFromGray(flat, P, P), ZERO_PHASH);

  const ramp = frame(rampBase);
  const noise = makeNoise();
  const grainy = frame((x, y) => rampBase(x, y) + (noise() * 2 - 1) * 3);

  // A constant offset only moves the DC coefficient, which is excluded.
  assert.equal(pHashDistanceRatio(pHashFromGray(ramp, P, P), pHashFromGray(frame((x, y) => rampBase(x, y) + 30), P, P)), 0);
  assert.equal(pHashDistanceRatio(pHashFromGray(ramp, P, P), pHashFromGray(frame((x, y) => rampBase(x, y) + 60), P, P)), 0);
  // Grain is exactly what a low-frequency signature is supposed to survive.
  assert.equal(pHashDistanceRatio(pHashFromGray(ramp, P, P), pHashFromGray(grainy, P, P)), 0);
});

test('pHash separates a real layout change and packs exactly PHASH_BITS', () => {
  const ramp = frame(rampBase);
  const plain = checker(200, 40);
  const inverted = checker(40, 200);
  const rampHash = pHashFromGray(ramp, P, P);
  assert.equal(rampHash.length, 16);
  assert.equal(PHASH_BITS, 63);
  // A ramp against its own inverse is emphatically not "the same picture".
  assert.ok(pHashDistanceRatio(pHashFromGray(plain, P, P), pHashFromGray(inverted, P, P)) > 0.1);
  assert.ok(pHashDistanceRatio(rampHash, pHashFromGray(plain, P, P)) > 0.05);
  assert.equal(pHashDistanceRatio(rampHash, rampHash), 0);
});

test('pHash rejects malformed buffers and mismatched hashes instead of guessing', () => {
  const ramp = frame(rampBase);
  assert.equal(pHashFromGray(null), null);
  assert.equal(pHashFromGray(new Uint8Array(P * P - 1), P, P), null);
  assert.equal(pHashFromGray(ramp, 1, P), null);
  assert.equal(pHashFromGray(ramp, P, 0), null);
  assert.equal(pHashFromGray(ramp, P, P, 1), null);
  assert.equal(pHashFromGray(ramp, P, P, PHASH_SAMPLE + 1), null);
  assert.equal(pHashDistanceRatio('ffff', 'fff'), null);
  assert.equal(pHashDistanceRatio(null, 'ff'), null);
});

// ---- block-wise dHash ----------------------------------------------------

test('block dHash reports where two frames differ, not just that they do', () => {
  const flat = frame(() => 128);
  const quadrant = frame((x, y) => (x >= 32 && y >= 32 ? 10 + x * 3 : 128));
  const ratios = gridDHashRatios(flat, quadrant, P, P, GRID_COLS, GRID_ROWS);
  assert.equal(ratios.length, GRID_COLS * GRID_ROWS);
  const summary = summarizeDistances(ratios);
  // Only the bottom-right quadrant moved: 4 of 16 cells, and they moved fully.
  assert.equal(summary.mean, 0.25);
  assert.equal(summary.worst, 1);
  assert.equal(summary.best, 0);
  const moved = ratios.filter((r) => r > 0).length;
  assert.equal(moved, 4);

  const same = summarizeDistances(gridDHashRatios(flat, flat, P, P, GRID_COLS, GRID_ROWS));
  assert.equal(same.mean, 0);
  assert.equal(same.worst, 0);
});

test('block dHash returns nothing when the buffers cannot be compared', () => {
  const flat = frame(() => 128);
  assert.deepEqual(gridDHashRatios(null, flat, P, P), []);
  assert.deepEqual(gridDHashRatios(flat, null, P, P), []);
  assert.deepEqual(gridDHashRatios(flat, flat, 1, P), []);
  assert.deepEqual(gridDHashRatios(flat, flat, P, 0), []);
  const short = new Uint8Array(P * P - 1);
  assert.deepEqual(gridDHashRatios(flat, short, P, P), []);
});

// ---- row-step profile (the quality guard) --------------------------------

const W2 = 8;
const H2 = 200;

// Flat frame with one hard horizontal step where `jump` is applied at row `at`.
const stepped = (at, jump, base = 40) => {
  const buf = new Uint8Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    const v = y < at ? base : base + jump;
    for (let x = 0; x < W2; x++) buf[y * W2 + x] = Math.max(0, Math.min(255, v));
  }
  return buf;
};

test('row step finds a hard horizontal seam and reports where it is', () => {
  const p = rowStepProfile(stepped(50, 60), W2, H2);
  assert.equal(p.worst, 60);
  assert.equal(p.worstRow, 50);
  assert.equal(p.worstRowPct, 25);
  assert.equal(p.visible, true);

  // Same seam, darker: still found, and the sign is kept. Base 100 so the darker
  // side stays inside 0..255 and the test is not measuring byte clamping.
  const down = rowStepProfile(stepped(120, -55, 100), W2, H2);
  assert.equal(down.worst, -55);
  assert.equal(down.worstRow, 120);
  assert.equal(down.worstRowPct, 60);
});

test('row step stays quiet on a smooth frame and picks the larger of two seams', () => {
  const smooth = new Uint8Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) smooth[y * W2 + x] = 30 + y * 0.5;
  }
  const quiet = rowStepProfile(smooth, W2, H2);
  // The buffer is 8-bit, so a 0.5/row ramp quantises to alternating 0 and 1.
  assert.ok(quiet.worst <= 1, `expected a quiet frame, got ${quiet.worst}`);
  assert.equal(quiet.visible, false);

  const two = new Uint8Array(stepped(40, 30));
  for (let y = 150; y < H2; y++) {
    for (let x = 0; x < W2; x++) two[y * W2 + x] = 190;
  }
  const picked = rowStepProfile(two, W2, H2);
  assert.equal(picked.worstRow, 150);
  assert.equal(picked.worst, 120);
  assert.ok(picked.visible);
});

test('row step threshold is the documented visibility cut and input is validated', () => {
  assert.equal(SEAM_VISIBLE_STEP, 25);
  assert.equal(rowStepProfile(stepped(50, 20), W2, H2).visible, false);
  assert.equal(rowStepProfile(stepped(50, 25), W2, H2).visible, true);

  assert.equal(rowStepProfile(null), null);
  assert.equal(rowStepProfile(new Uint8Array(W2 * H2 - 1), W2, H2), null);
  assert.equal(rowStepProfile(new Uint8Array(W2 * H2), 0, H2), null);
  assert.equal(rowStepProfile(new Uint8Array(W2 * H2), W2, 1), null);
  // Defaults exist for the sizes the app actually grabs with.
  assert.equal(rowStepProfile(new Uint8Array(4), ROWSTEP_W, ROWSTEP_H), null);
});

test('seam verdict blames the pipeline only when the input was clean', () => {
  assert.equal(SEAM_VERDICT.ADDED, 'added');
  // Nothing on either side.
  assert.equal(seamVerdict(null, null), SEAM_VERDICT.NONE);
  assert.equal(seamVerdict(undefined, undefined), SEAM_VERDICT.NONE);
  // Input had a seam, output came out cleaner: good news, not a warning.
  assert.equal(seamVerdict(59.1, null), SEAM_VERDICT.NONE);
  // Both sides have one: report it as pre-existing, never as the pipeline's fault.
  assert.equal(seamVerdict(59.1, 78.4), SEAM_VERDICT.SOURCE);
  // The only case that accuses the pipeline.
  assert.equal(seamVerdict(null, 78.4), SEAM_VERDICT.ADDED);
  // The backend sends null - never 0 - when a side has no seam, so any non-finite
  // value on the input side counts as "the input was clean".
  assert.equal(seamVerdict(undefined, 78.4), SEAM_VERDICT.ADDED);
  assert.equal(seamVerdict(Number.NaN, 78.4), SEAM_VERDICT.ADDED);
});
