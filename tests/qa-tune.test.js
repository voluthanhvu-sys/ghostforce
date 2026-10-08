import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQaHistory, suggestDetailConfig, summarizeQaByTopic, replayCatalog } from '../server/qa-tune.js';

const entry = (mode, score, extra = {}) => ({
  at: extra.at || new Date().toISOString(),
  score,
  framingStyle: extra.framingStyle || 'focus',
  detailModelMode: mode,
  warnings: extra.warnings || [],
  sourcePath: extra.sourcePath || `D:\\video-${Math.random()}.mp4`,
  sourceName: extra.sourceName || 'video.mp4',
  partIndex: extra.partIndex || 1,
  ranges: extra.ranges || [[0, 90]],
  topic: extra.topic || 'generic',
});

test('summarizeQaHistory averages per framing/detail mode', () => {
  const groups = summarizeQaHistory([entry('safe', 80), entry('safe', 70), entry('quality', 90)]);
  const safe = groups.find((g) => g.key === 'focus/safe');
  assert.equal(safe.parts, 2);
  assert.equal(safe.avgScore, 75);
  assert.equal(groups[0].key, 'focus/safe');
});

test('suggestDetailConfig needs enough parts and a real gap', () => {
  const few = Array.from({ length: 6 }, () => entry('safe', 70)).concat(Array.from({ length: 6 }, () => entry('quality', 90)));
  assert.equal(suggestDetailConfig(few), null);            // 6 < minParts
  const many = Array.from({ length: 12 }, () => entry('safe', 70)).concat(Array.from({ length: 12 }, () => entry('quality', 88)));
  const pick = suggestDetailConfig(many);
  assert.equal(pick.detailModelMode, 'quality');
  assert.equal(pick.gain, 18);
  const noise = Array.from({ length: 12 }, () => entry('safe', 80)).concat(Array.from({ length: 12 }, () => entry('quality', 82)));
  assert.equal(suggestDetailConfig(noise), null);          // gain 2 < minGain
});

test('a topic-specific suggestion uses only that topic\'s parts', () => {
  const entries = [
    ...Array.from({ length: 12 }, () => entry('safe', 60, { topic: 'cops' })),
    ...Array.from({ length: 12 }, () => entry('quality', 88, { topic: 'cops' })),
    ...Array.from({ length: 12 }, () => entry('safe', 90, { topic: 'animals' })),
    ...Array.from({ length: 12 }, () => entry('quality', 70, { topic: 'animals' })),
  ];
  const cops = suggestDetailConfig(entries, { topic: 'cops' });
  assert.equal(cops.detailModelMode, 'quality');
  assert.equal(cops.topic, 'cops');
  const animals = suggestDetailConfig(entries, { topic: 'animals' });
  assert.equal(animals.detailModelMode, 'safe');
  // A topic with too few parts says nothing rather than borrowing another topic.
  assert.equal(suggestDetailConfig(entries, { topic: 'product' }), null);
  // No topic filter keeps the global behaviour (the mixed pool only clears the
  // bar with a lower gain threshold, which is the point of scoping by topic).
  assert.equal(suggestDetailConfig(entries), null);
  assert.equal(suggestDetailConfig(entries, { minGain: 3 }).detailModelMode, 'quality');
});

test('summarizeQaByTopic reports per-topic averages and mode mix', () => {
  const rows = summarizeQaByTopic([
    entry('safe', 80, { topic: 'cops' }),
    entry('quality', 90, { topic: 'cops', warnings: ['x'] }),
    entry('safe', 60, { topic: 'animals' }),
  ]);
  const cops = rows.find((r) => r.topic === 'cops');
  assert.equal(cops.parts, 2);
  assert.equal(cops.avgScore, 85);
  assert.equal(cops.warnRate, 0.5);
  assert.deepEqual(cops.modes, { safe: 1, quality: 1 });
  assert.equal(rows[0].topic, 'cops');
});

test('replayCatalog groups videos and keeps the latest row of a part', () => {
  const catalog = replayCatalog([
    entry('safe', 70, { at: '2026-10-01T00:00:00.000Z', sourcePath: 'D:\\a.mp4', sourceName: 'a.mp4', partIndex: 2, ranges: [[10, 80]], partName: '2.Second.mp4' }),
    entry('safe', 90, { at: '2026-10-03T00:00:00.000Z', sourcePath: 'D:\\a.mp4', sourceName: 'a.mp4', partIndex: 2, ranges: [[10, 80]], partName: '2.Second.mp4' }),
    entry('safe', 80, { at: '2026-10-02T00:00:00.000Z', sourcePath: 'D:\\a.mp4', sourceName: 'a.mp4', partIndex: 1, ranges: [[0, 70]] }),
    entry('safe', 60, { at: '2026-10-04T00:00:00.000Z', sourcePath: 'D:\\b.mp4', sourceName: 'same.mp4', partIndex: 1, ranges: [[3, 90]] }),
    entry('safe', 60, { at: '2026-10-04T01:00:00.000Z', sourcePath: 'D:\\c.mp4', sourceName: 'same.mp4', partIndex: 1, ranges: [[4, 90]] }),
    { score: 50, sourceName: 'no-path.mp4', ranges: [[0, 10]] },
  ]);
  assert.equal(catalog.length, 3);
  assert.equal(catalog[0].sourcePath, 'D:\\c.mp4');
  assert.equal(catalog[1].sourcePath, 'D:\\b.mp4');
  const video = catalog.find((row) => row.sourcePath === 'D:\\a.mp4');
  assert.equal(video.parts.length, 2);
  assert.equal(video.parts[0].partIndex, 1);
  assert.equal(video.parts[1].score, 90);
  assert.deepEqual(video.parts[1].ranges, [[10, 80]]);
});
