import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEditQaReport, pickQaFocusPoints, applyAimOverrides } from '../server/edit-qa.js';

const samples = (list) => list.map(([t, cx, inCrop, empty]) => ({ t, cx, inCrop, empty: Boolean(empty) }));

test('a well-aimed, moving crop scores high with no warnings', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push([i, 0.4 + (i % 5) * 0.02, true, false]);
  const report = buildEditQaReport({ duration: 40, samples: samples(list), coveragePct: 100, windows: [{}, {}] });
  assert.equal(report.score, 100);
  assert.equal(report.grade, 'tot');
  assert.deepEqual(report.warnings, []);
  assert.equal(report.metrics.windowCount, 2);
});

test('a crop that holds one position for a long time is flagged', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push([i, 0.5, true, false]);
  const report = buildEditQaReport({ duration: 40, samples: samples(list), coveragePct: 100 });
  assert.ok(report.metrics.longestHoldSec >= 38);
  assert.ok(report.warnings.some((w) => /đứng yên/.test(w)));
  // The hold penalty is capped at 20 points, so a frozen but otherwise clean
  // crop lands at 80 - still visibly below an aimed run.
  assert.ok(report.score <= 80);
});

test('a held crop with no motion at all is NOT flagged (talking head on a fixed camera)', () => {
  const still = [];
  for (let i = 0; i < 40; i += 1) still.push({ t: i, cx: 0.5, inCrop: true, empty: false, motion: 0.002 });
  const report = buildEditQaReport({ duration: 40, samples: still, coveragePct: 100 });
  assert.ok(!report.warnings.some((w) => /đứng yên/.test(w)));
  assert.equal(report.score, 100);
});

test('a held crop is NOT flagged while the subject itself stays put', () => {
  const still = [];
  for (let i = 0; i < 40; i += 1) still.push({ t: i, cx: 0.5, inCrop: true, empty: false, motion: 0.08, peakX: 0.5 });
  const talker = buildEditQaReport({ duration: 40, samples: still, coveragePct: 100 });
  assert.ok(!talker.warnings.some((w) => /đứng yên/.test(w)));
  // Same crop, but the subject walks 0.2 to the side → the hold is a real miss.
  const walking = [];
  for (let i = 0; i < 40; i += 1) walking.push({ t: i, cx: 0.5, inCrop: true, empty: false, motion: 0.08, peakX: 0.5 + i * 0.008 });
  const missed = buildEditQaReport({ duration: 40, samples: walking, coveragePct: 100 });
  assert.ok(missed.warnings.some((w) => /đứng yên/.test(w)));
});

test('a subject sitting just outside the crop edge is reported', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push({ t: i, cx: 0.5, inCrop: true, empty: false, edgeCut: i < 12 });
  const report = buildEditQaReport({ duration: 40, samples: list, coveragePct: 100 });
  assert.ok(report.warnings.some((w) => /bị cắt ở mép/.test(w)));
  assert.ok(report.metrics.edgeCutSec >= 10);
  assert.ok(report.score < 100);
});

test('a crop with no subject in it is the worst case', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push([i, 0.5, false, false]);
  const report = buildEditQaReport({ duration: 40, samples: samples(list), coveragePct: 100 });
  assert.ok(report.warnings.some((w) => /không có chủ thể/.test(w)));
  assert.ok(report.score <= 60);
  assert.ok(report.metrics.noSubjectSec >= 30);
});

test('dark/empty frames and edge-pinned crops are reported', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push([i, i % 2 ? 0.08 : 0.92, true, i > 20]);
  const report = buildEditQaReport({ duration: 40, samples: samples(list), coveragePct: 100 });
  assert.ok(report.warnings.some((w) => /trống\/tối/.test(w)));
  assert.ok(report.warnings.some((w) => /sát mép/.test(w)));
});

test('low coverage from the plan is reported with the repaired seconds', () => {
  const list = [];
  for (let i = 0; i < 40; i += 1) list.push([i, 0.3 + i * 0.005, true, false]);
  const report = buildEditQaReport({ duration: 40, samples: samples(list), coveragePct: 24, repairedSec: 91 });
  assert.ok(report.warnings.some((w) => /chỉ phủ 24%/.test(w)));
  assert.ok(report.warnings.some((w) => /bù 91s/.test(w)));
  assert.equal(report.metrics.repairedSec, 91);
});

test('an empty sample list still returns a usable report', () => {
  const report = buildEditQaReport({ duration: 30, samples: [], coveragePct: 100 });
  assert.equal(report.score, 100);
  assert.equal(report.metrics.samples, 0);
  assert.deepEqual(report.warnings, []);
});

test('pickQaFocusPoints takes the bad moments, spread apart and capped', () => {
  const list = samples([
    [1, 0.5, true, false],
    [5, 0.5, false, false],
    [6, 0.5, false, false],
    [20, 0.5, false, true],
    [24, 0.5, false, false],
    [40, 0.5, false, false],
    [44, 0.5, false, false],
  ]);
  const picked = pickQaFocusPoints(list, { max: 3, minGapSec: 3 });
  assert.deepEqual(picked, [5, 20, 24]);
  // An edge-cut moment is worth a second opinion too.
  const edge = pickQaFocusPoints([{ t: 8, cx: 0.5, inCrop: true, empty: false, edgeCut: true }], {});
  assert.deepEqual(edge, [8]);
  assert.deepEqual(pickQaFocusPoints(samples([[1, 0.5, true, false]]), {}), []);
});

test('applyAimOverrides replaces the aim around the corrected moment only', () => {
  const points = [
    { t: 0, cx: 0.2, cy: 0.4, who: 'a' },
    { t: 10, cx: 0.25, cy: 0.4, who: 'a' },
    { t: 11, cx: 0.3, cy: 0.4, who: 'a' },
    { t: 30, cx: 0.8, cy: 0.4, who: 'a' },
  ];
  const out = applyAimOverrides(points, [{ t: 10.5, cx: 0.7, cy: 0.5 }], 40);
  assert.ok(!out.some((p) => p.t === 10 || p.t === 11));
  const seeded = out.filter((p) => p.who === 'critic');
  assert.equal(seeded.length, 2);
  assert.deepEqual(seeded.map((p) => p.t), [9, 12]);
  assert.ok(seeded.every((p) => p.cx === 0.7 && p.cy === 0.5));
  assert.ok(out.some((p) => p.t === 0) && out.some((p) => p.t === 30));
  // The override is clamped to the part and ignores unusable input.
  const clamped = applyAimOverrides(points, [{ t: 0.5, cx: 0.6 }, { t: 12, cx: 'x' }], 40);
  assert.ok(clamped.some((p) => p.t === 0 && p.who === 'critic'));
});
