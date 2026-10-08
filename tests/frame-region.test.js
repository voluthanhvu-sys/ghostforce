import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCropBox, splitHalvesOverlap, frameRegionSimilarity, frameRegionPeak } from '../server/ffmpeg-expressions.js';

// Build a synthetic frame: a dark canvas with a detailed bright patch.
const makeFrame = (gw, gh, patch) => {
  const rgb = Buffer.alloc(gw * gh * 3, 12);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = (y * gw + x) * 3;
      const inPatch = patch && x >= patch.x0 * gw && x < patch.x1 * gw && y >= patch.y0 * gh && y < patch.y1 * gh;
      const value = inPatch ? (Math.floor((x + y) / 2) % 2 ? 230 : 40) : 12;
      rgb[i] = value; rgb[i + 1] = value; rgb[i + 2] = value;
    }
  }
  return rgb;
};

test('frameRegionPeak finds the detailed patch inside a region', () => {
  const gw = 96; const gh = 54;
  const rgb = makeFrame(gw, gh, { x0: 0.72, x1: 0.95, y0: 0.55, y1: 0.95 });
  const peak = frameRegionPeak(rgb, gw, gh, { x0: 0.6, x1: 1, y0: 0.4, y1: 1 });
  assert.ok(peak.score > 100, `expected a detailed patch, score=${peak.score}`);
  assert.ok(peak.x > 0.7 && peak.x < 0.96, `x=${peak.x}`);
  assert.ok(peak.y > 0.5 && peak.y < 0.96, `y=${peak.y}`);
  // A flat region has nothing to aim at (the caller drops the popup below 12).
  const flat = frameRegionPeak(makeFrame(gw, gh, null), gw, gh, { x0: 0.2, x1: 0.5, y0: 0.2, y1: 0.8 });
  assert.ok(flat.score < 12, `flat score=${flat.score}`);
});

test('frameRegionSimilarity sees identical and different regions', () => {
  const gw = 96; const gh = 54;
  const rgb = makeFrame(gw, gh, { x0: 0.1, x1: 0.4, y0: 0.1, y1: 0.9 });
  const same = frameRegionSimilarity(rgb, gw, gh, { x0: 0.1, x1: 0.4, y0: 0, y1: 1 }, { x0: 0.1, x1: 0.4, y0: 0, y1: 1 });
  assert.equal(same, 1);
  const different = frameRegionSimilarity(rgb, gw, gh, { x0: 0.1, x1: 0.4, y0: 0, y1: 1 }, { x0: 0.6, x1: 0.9, y0: 0, y1: 1 });
  assert.ok(different < 0.85, `expected a different region, got ${different}`);
});

// The geometric gate composeFocusClip uses: overlap of the two REAL split halves.
test('a second camera inside the main crop overlaps it and must be dropped', () => {
  const share = splitHalvesOverlap(1920, 1080, 0.55, 0.35);
  assert.ok(share > 0.35, `expected a large overlap, got ${share}`);
});

test('a second camera on the other side of the frame is kept', () => {
  assert.equal(splitHalvesOverlap(1920, 1080, 0.30, 0.78), 0);
});

test('a second camera just past the main crop edge is kept', () => {
  const mainHalf = (fitCropBox(1920, 1080, 9 / 16).w / 2) / 1920;
  const far = 0.5 + mainHalf + 0.2;
  assert.ok(splitHalvesOverlap(1920, 1080, 0.5, far) < 0.35);
});
