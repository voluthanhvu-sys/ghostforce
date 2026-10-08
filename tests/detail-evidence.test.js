import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDetailEvidenceTimes,
  buildDetailMultimodalRequest,
  mapDiarizationToPartTimeline,
  mapWordsToPartTimeline,
} from '../server/detail-evidence.js';

test('maps words into a contiguous part-local timeline', () => {
  const words = mapWordsToPartTimeline({ start: 10, end: 20 }, [{ word: 'hi', t: 12, end: 12.4 }]);
  assert.equal(words[0].word, 'hi');
  assert.equal(words[0].t, 2);
  assert(Math.abs(words[0].end - 2.4) < 1e-9);
});

test('maps words in piece two after the accumulated first piece duration', () => {
  const part = { pieces: [{ start: 10, end: 15 }, { start: 40, end: 50 }] };
  const words = mapWordsToPartTimeline(part, [{ word: 'two', t: 42, end: 42.5 }]);
  assert.deepEqual(words, [{ word: 'two', t: 7, end: 7.5 }]);
});

test('maps anonymous diarization turns and clips a turn at piece boundaries', () => {
  const part = { pieces: [{ start: 10, end: 15 }, { start: 40, end: 45 }] };
  const turns = mapDiarizationToPartTimeline(part, [
    { start: 11, end: 12, speakerId: 'SPEAKER_00' },
    { start: 14, end: 41, speakerId: 'SPEAKER_01' },
  ]);
  assert.deepEqual(turns, [
    { start: 1, end: 2, speakerId: 'SPEAKER_00' },
    { start: 4, end: 5, speakerId: 'SPEAKER_01' },
    { start: 5, end: 6, speakerId: 'SPEAKER_01' },
  ]);
  assert.equal(turns.some((turn) => 'who' in turn), false);
});

test('samples before and after scene cuts', () => {
  const samples = buildDetailEvidenceTimes({ duration: 10, sceneCuts: [5] });
  assert(samples.some((sample) => Math.abs(sample.t - 4.8) < 1e-9 && sample.reasons.includes('scene-cut-before')));
  assert(samples.some((sample) => Math.abs(sample.t - 5.2) < 1e-9 && sample.reasons.includes('scene-cut-after')));
});

test('samples anonymous speaker-cluster transitions', () => {
  const samples = buildDetailEvidenceTimes({
    duration: 10,
    diarTurns: [
      { start: 1, end: 4, speakerId: 'SPEAKER_00' },
      { start: 4, end: 8, speakerId: 'SPEAKER_01' },
    ],
  });
  const transition = samples.find((sample) => Math.abs(sample.t - 4) < 1e-9);
  assert(transition?.reasons.includes('speaker-change'));
});

test('groups nearby words and samples dialogue-run boundaries', () => {
  const samples = buildDetailEvidenceTimes({
    duration: 12,
    words: [
      { word: 'a', t: 2, end: 2.2 },
      { word: 'b', t: 2.5, end: 2.8 },
      { word: 'c', t: 5, end: 5.3 },
    ],
  });
  assert(samples.some((sample) => sample.t === 2 && sample.reasons.includes('dialogue-start')));
  assert(samples.some((sample) => sample.t === 2.8 && sample.reasons.includes('dialogue-end')));
  assert(samples.some((sample) => sample.t === 5 && sample.reasons.includes('dialogue-start')));
});

test('periodic safety samples fill only long remaining observation gaps', () => {
  const samples = buildDetailEvidenceTimes({ duration: 20 });
  assert(samples.some((sample) => sample.reasons.includes('periodic-safety')));
  assert(Math.max(...samples.slice(1).map((sample, i) => sample.t - samples[i].t)) <= 6.001);
});

test('nearby event requests deduplicate and retain reasons', () => {
  const samples = buildDetailEvidenceTimes({ duration: 10, sceneCuts: [5], words: [{ word: 'x', t: 4.82, end: 5.18 }] });
  assert(samples.length < 8);
  assert(samples.some((sample) => sample.reasons.includes('scene-cut-before') && sample.reasons.includes('dialogue-start')));
});

test('evidence timestamps are deterministic, sorted, finite and in bounds', () => {
  const input = {
    duration: 13,
    sceneCuts: [3, Number.NaN, 8],
    words: [{ word: 'x', t: 1, end: 1.2 }],
    diarTurns: [
      { start: 0, end: 6, speakerId: 'SPEAKER_00' },
      { start: 6, end: 13, speakerId: 'SPEAKER_01' },
    ],
  };
  const first = buildDetailEvidenceTimes(input);
  const second = buildDetailEvidenceTimes(input);
  assert.deepEqual(first, second);
  assert(first.every((sample) => Number.isFinite(sample.t) && sample.t >= 0 && sample.t < input.duration));
  assert(first.every((sample, i) => i === 0 || sample.t > first[i - 1].t));
});

test('noisy evidence is deterministically capped while preserving priority events', () => {
  const input = {
    duration: 120,
    sceneCuts: [10, 30, 50, 70, 90, 110],
    words: Array.from({ length: 120 }, (_, i) => ({
      word: `word-${i}`,
      t: i + 0.2,
      end: i + 0.3,
    })),
    diarTurns: Array.from({ length: 120 }, (_, i) => ({
      start: i,
      end: i + 0.8,
      speakerId: `SPEAKER_${i % 2}`,
    })),
  };
  const first = buildDetailEvidenceTimes(input);
  const second = buildDetailEvidenceTimes(input);
  assert(first.length <= 72);
  assert.deepEqual(first, second);
  assert(first.some((sample) => sample.reasons.includes('part-start')));
  assert(first.some((sample) => sample.reasons.includes('part-end')));
  for (const cut of input.sceneCuts) {
    assert(first.some((sample) => Math.abs(sample.t - (cut - 0.2)) < 1e-9 && sample.reasons.includes('scene-cut-before')));
    assert(first.some((sample) => Math.abs(sample.t - (cut + 0.2)) < 1e-9 && sample.reasons.includes('scene-cut-after')));
  }
  assert(first.every((sample) => Number.isFinite(sample.t) && sample.t >= 0 && sample.t < input.duration));
  assert(first.every((sample, i) => i === 0 || sample.t > first[i - 1].t));
});

test('builds text plus labeled JPEG Vertex parts without video input', () => {
  const request = buildDetailMultimodalRequest({
    prompt: 'detail prompt',
    evidenceText: 'speech at 1.0s\ncluster change at 2.0s',
    frames: [
      { t: 1.25, reasons: ['dialogue-start', 'scene-cut-after'], jpeg: Buffer.from([1, 2, 3]) },
      { t: Number.NaN, reasons: ['invalid'], jpeg: Buffer.from([4]) },
    ],
  });
  assert.deepEqual(request.generationConfig, { temperature: 0, responseMimeType: 'application/json' });
  const parts = request.contents[0].parts;
  assert.equal(parts[0].text, 'detail prompt');
  assert.match(parts[1].text, /speech at 1\.0s cluster change at 2\.0s/);
  assert.match(parts[2].text, /t=1\.250s.*dialogue-start.*scene-cut-after/);
  assert.deepEqual(parts[3], { inlineData: { mimeType: 'image/jpeg', data: 'AQID' } });
  assert.equal(parts.some((part) => part.inlineData?.mimeType === 'video/mp4'), false);
  assert.equal(parts.filter((part) => part.inlineData).length, 1);
});
