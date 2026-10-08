import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalDetailRequest, chooseLocalTestRange, coalesceLocalFrames, localDetailPlanFromModel, localDetailPrompt, localDetailSchema, validateLocalFraming } from '../server/local-detail.js';

test('local Detail request contains JSON mode, deterministic settings and chronological JPEGs', () => {
  const frames = [
    { t: 0.05, reasons: ['part-start'], jpeg: Buffer.from('first') },
    { t: 4.2, reasons: ['scene-cut-after'], jpeg: Buffer.from('second') },
  ];
  const body = buildLocalDetailRequest({ model: 'qwen3-vl:2b', prompt: 'frame it', frames });
  assert.equal(body.model, 'qwen3-vl:2b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.format, localDetailSchema);
  assert.equal(body.options.temperature, 0);
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.options.num_predict, 1200);
  assert.deepEqual(body.messages[0].images, frames.map((frame) => frame.jpeg.toString('base64')));
  assert.match(body.messages[0].content, /IMAGE 1: t=0\.050s/);
  assert.match(body.messages[0].content, /IMAGE 2: t=4\.200s/);
});

test('local Detail request hard-caps visual inputs for the 8K/4GB runtime', () => {
  const frames = Array.from({ length: 14 }, (_, index) => ({ t: index, jpeg: Buffer.from(String(index)) }));
  const body = buildLocalDetailRequest({ model: 'qwen3-vl:2b', prompt: 'frame it', frames });
  assert.equal(body.messages[0].images.length, 6);
  assert.match(body.messages[0].content, /IMAGE 6:/);
  assert.doesNotMatch(body.messages[0].content, /IMAGE 7:/);
});

test('saved local TEST range is reused and explicit refresh selects a new deterministic range', () => {
  const stored = { duration: 120, take: 30, start: 44.5 };
  assert.deepEqual(chooseLocalTestRange({ duration: 120, take: 30, stored, random: () => 0.9 }), { start: 44.5, take: 30, reused: true });
  assert.deepEqual(chooseLocalTestRange({ duration: 120, take: 30, stored, newRandom: true, random: () => 0.5 }), { start: 45, take: 30, reused: false });
  assert.equal(chooseLocalTestRange({ duration: 25, take: 30, stored: null }).start, 0);
});

test('local schema caps framing output so a small model cannot loop until the token limit', () => {
  const segment = localDetailSchema.properties.segments.items;
  assert.equal(segment.properties.frames.maxItems, 8);
  assert.equal(segment.properties.track.maxItems, 16);
  assert.equal(localDetailSchema.properties.summary.maxLength, 160);
  assert.equal(segment.properties.frames.items.properties.why.maxLength, 120);
});

test('local prompt is visual-only and does not claim audio access', () => {
  const prompt = localDetailPrompt({ duration: 30, userPrompt: 'SML framing', sceneCuts: [4.2] });
  assert.match(prompt, /not audio/);
  assert.match(prompt, /do not invent dialogue/);
  assert.match(prompt, /exactly one segment covering 0\.0 through 30\.0/);
  assert.match(prompt, /Candidate local scene cuts: 4\.2/);
  assert.match(prompt, /at most 8 frames/);
  assert.match(prompt, /Do not repeat a window/);
  assert.doesNotMatch(prompt, /specific visible reason/);
  assert.match(prompt, /Do not force a ratio/);
});

test('adjacent half-second local windows collapse into one excerpt-length decision', () => {
  const frames = Array.from({ length: 8 }, (_, index) => ({
    start: index * 0.5, end: (index + 1) * 0.5, mode: 'fill', why: 'central puppet',
  }));
  const merged = coalesceLocalFrames(frames, 30);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].start, 0);
  assert.equal(merged[0].end, 30);
  assert.equal(merged[0].mode, 'fill');
});

test('local plan keeps framing when the model segment is shorter than a production episode', () => {
  const text = JSON.stringify({
    summary: 'Couch puppets',
    segments: [{ name: '0-4', start: 0, end: 4, frames: [
      { start: 0, end: 4, mode: 'contain', why: 'two puppets' },
      { start: 4, end: 30, mode: 'fill', cx: 0.4, cy: 0.4, why: 'orange hair' },
    ], track: [] }],
  });
  const plan = localDetailPlanFromModel(text, 30);
  assert.equal(plan.segments.length, 1);
  assert.equal(plan.segments[0].end, 30);
  assert.equal(plan._raw.segments[0].frames.length, 2);
});

test('local render accepts positioned FILL and CONTAIN without a speaker track', () => {
  assert.doesNotThrow(() => validateLocalFraming([
    { a: 0, b: 4, mode: 'contain' },
    { a: 4, b: 12, mode: 'fill', cx: 0.7, cy: 0.4 },
  ], []));
  assert.doesNotThrow(() => validateLocalFraming([{ a: 4, b: 12, mode: 'fill' }], [
    { t: 6, cx: 0.7, cy: 0.4 },
  ]));
});

test('local render rejects missing frames or FILL with no local position evidence', () => {
  assert.throws(() => validateLocalFraming([], []), /parsed frames=0/);
  assert.throws(() => validateLocalFraming([{ a: 20, b: 30, mode: 'fill' }], [
    { t: 0, cx: 0.7, cy: 0.4 },
  ]), /lack coordinates and local track/);
});
