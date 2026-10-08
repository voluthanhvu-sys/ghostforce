import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackPartsFromLog } from '../server/edit-log-replay.js';

const log = `
[2026-09-23T09:25:55.613Z] [SML Movie Attack Of Th] [EDIT] RUN job=abc source="SML Movie Attack Of The Nuns _1080p.mp4" started=2026-09-23T09:25:55.600Z
[2026-09-23T09:28:17.151Z] [SML Movie Attack Of Th] [EDIT] Global raw segment 4: start=337.5 end=440 pieces=missing -> accepted ranges=[[337.5,440]]
[2026-09-23T09:28:17.151Z] [SML Movie Attack Of Th] [EDIT] Global raw segment 5: start=440 end=570 pieces=missing -> accepted ranges=[[440,570]]
[2026-09-23T09:33:16.185Z] [SML Movie Attack Of Th] [EDIT] Detail PLAN 4/6 failed — using global PLAN fallback (Gemini JSON parse failed)
[2026-09-23T09:38:55.218Z] [SML Movie Attack Of Th] [EDIT] Detail PLAN 5/6 failed — using global PLAN fallback (fetch failed)
[2026-09-23T09:52:26.963Z] [jeffy doll] [EDIT] RUN job=def source="SML Movie： Jeffy's Doll!_1080p.mp4" started=2026-09-23T09:52:26.900Z
[2026-09-23T09:52:26.964Z] [jeffy doll] [EDIT] Global raw segment 3: start=207 end=303 pieces=missing -> accepted ranges=[[207,303]]
`;

test('fallback parts come from the matching source run only', () => {
  const parts = fallbackPartsFromLog(log, 'D:\\Tiktok\\SML Movie Attack Of The Nuns _1080p.mp4');
  assert.deepEqual(parts, [
    { partIndex: 4, start: 337.5, end: 440, reason: 'Gemini JSON parse failed', name: 'Part 4' },
    { partIndex: 5, start: 440, end: 570, reason: 'fetch failed', name: 'Part 5' },
  ]);
});

test('a source with ranges but no fallback line yields nothing', () => {
  assert.deepEqual(fallbackPartsFromLog(log, "SML Movie： Jeffy's Doll!_1080p.mp4"), []);
});

test('an unknown source yields nothing', () => {
  assert.deepEqual(fallbackPartsFromLog(log, 'other.mp4'), []);
});
