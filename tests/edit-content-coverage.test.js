import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyGlobalCoveragePolicy, globalCoverageGuidance } from '../server/edit-content-coverage.js';

const segment = (start, end) => ({ start, end, dur: end - start, pieces: [{ start, end }], ranges: [[start, end]], frames: [{ a: 0, b: end - start, mode: 'contain' }], track: [] });
const makePlan = () => ({ segments: [segment(0, 100), segment(100, 200)], _raw: {} });
const apply = (p, duration = 250) => applyGlobalCoveragePolicy(p, duration, 60.1);
const exclusion = (start, end, kind = 'outro') => ({ start, end, kind, confidence: 'certain', reason: 'Visible end card / unrelated commercial' });

test('uncertain omitted tail is restored automatically, raw data unchanged', () => {
    const p = makePlan();
    p._raw.tailEvidence = { storyEnd: 200, outroStart: null };
    const raw = structuredClone(p._raw);
    apply(p);
    assert.equal(p.segments[1].end, 250);
    assert.equal(p.segments[1].dur, 150);
    assert.equal(p.segments[1].frames.at(-1).b, 150);
    assert.deepEqual(p._raw, raw);
});

test('Attack Of The Nuns regression keeps unverified 673.5–725.623583 tail', () => {
    const p = { segments: [segment(0, 120), segment(120, 240), segment(240, 360), segment(360, 480), segment(480, 600), segment(600, 673.5)], _raw: {} };
    apply(p, 725.623583);
    assert.equal(p.segments.length, 6);
    assert.equal(p.segments[5].end, 725.623583);
    p._raw.excludedRanges = [exclusion(713, 725.623583)];
    apply(p, 725.623583);
    assert.equal(p.segments[5].end, 713);
});

test('only valid certain outro/ad evidence can exclude footage; conflicting story evidence keeps tail', () => {
    for (const cut of [
        { ...exclusion(200, 250), confidence: 'maybe' },
        exclusion(200, 250, 'boring dialogue'),
        { ...exclusion(200, 250), reason: '' },
        exclusion(200, 240),
        { ...exclusion(200, 250), start: '200' },
    ]) {
        const p = makePlan(); p._raw.excludedRanges = [cut]; apply(p);
        assert.equal(p.segments[1].end, 250);
    }
    const p = makePlan();
    p._raw.excludedRanges = [exclusion(200, 250)];
    p._raw.tailEvidence = { storyEnd: 220 };
    apply(p);
    assert.equal(p.segments[1].end, 250);
});

test('source gaps are restored and track/frame local time follows changed pieces', () => {
    const p = { segments: [{ ...segment(10, 150), pieces: [{ start: 10, end: 50 }, { start: 70, end: 150 }], ranges: [[10, 50], [70, 150]], frames: [{ a: 40, b: 50, mode: 'fill', cx: 0.7 }], track: [{ t: 45, who: 'Alice', cx: 0.7 }] }], _raw: {} };
    apply(p, 150);
    assert.deepEqual(p.segments[0].ranges, [[0, 150]]);
    assert.equal(p.segments[0].track[0].t, 75);
    assert.deepEqual(p.segments[0].frames.find((w) => w.mode === 'fill'), { a: 70, b: 80, mode: 'fill', cx: 0.7 });
});

test('overlapping ads are subtracted once and same-source positions stay aligned', () => {
    const p = { segments: [{ ...segment(0, 180), track: [{ t: 90, who: 'Alice', cx: 0.6 }] }], _raw: { excludedRanges: [exclusion(20, 40, 'advertisement'), exclusion(30, 50, 'advertisement')] } };
    apply(p, 180);
    assert.deepEqual(p.segments[0].ranges, [[0, 20], [50, 180]]);
    assert.equal(p.segments[0].track[0].t, 60);
    assert.equal(p.segments[0].dur, 150);
});

test('too-short exclusions and sub-0.2s pieces are retained instead of skipped/lengthened by renderer', () => {
    for (const cut of [exclusion(140, 250), exclusion(100.1, 150, 'advertisement')]) {
        const p = makePlan(); p._raw.excludedRanges = [cut]; apply(p);
        assert.deepEqual(p.segments[1].ranges, [[100, 250]]);
    }
});

test('short/duplicate split points cannot strand a skipped final part', () => {
    const p = { segments: [segment(0, 100), segment(100, 200), segment(100, 210), segment(240, 250)], _raw: {} };
    apply(p);
    assert.equal(p.segments.length, 2);
    assert.deepEqual(p.segments.map((s) => s.ranges), [[[0, 100]], [[100, 250]]]);
});

test('covered ordinary plan remains unchanged; policy is Global-only before Detail, without manual wait', () => {
    const p = makePlan(); const original = p.segments.slice(); apply(p, 200);
    assert.strictEqual(p.segments[0], original[0]);
    assert.strictEqual(p.segments[1], original[1]);
    assert.match(globalCoverageGuidance(), /Uncertain content MUST stay/);
    const src = fs.readFileSync(new URL('../ghostforge-server.js', import.meta.url), 'utf8');
    assert.ok(src.includes("!testClip && !Array.isArray(sceneCuts) ? globalCoverageGuidance() : ''"));
    assert.ok(src.includes("if (mode === 'ai' && !testSec && !generalVideo) applyGlobalCoveragePolicy"));
    assert.ok(src.indexOf('applyGlobalCoveragePolicy(plan,') < src.indexOf('const detailPlanSegmentIndexes'));
    assert.equal(src.includes('waitForTailReview'), false);
});
