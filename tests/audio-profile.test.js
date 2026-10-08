import test from 'node:test';
import assert from 'node:assert/strict';

import {
    alignSeries,
    analyzeAudioPair,
    AUDIO_BANDS,
    bandProfileOverTime,
    compareSeries,
    fftPowerSpectrum,
    maxSampleJump,
    rmsDb,
    segmentRmsDb,
    summarizeSeries,
} from '../server/audio-profile.js';

const RATE = 16000;

const tone = (seconds, hz, amp = 0.2, rate = RATE) => {
    const n = Math.round(seconds * rate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
    return out;
};

const addInto = (target, source) => {
    const out = new Float32Array(target.length);
    for (let i = 0; i < target.length; i++) out[i] = target[i] + (source[i] || 0);
    return out;
};

test('rmsDb matches the textbook value for a full-scale sine', () => {
    const sine = tone(1, 440, 1);
    assert.ok(Math.abs(rmsDb(sine) - (-3.01)) < 0.05);
    assert.equal(rmsDb(new Float32Array(0)), null);
});

test('segmentRmsDb reads one value per second and follows a gain change', () => {
    const quiet = tone(2, 500, 0.25);
    const loud = tone(2, 500, 0.5);
    const mixed = new Float32Array(quiet.length + loud.length);
    mixed.set(quiet, 0);
    mixed.set(loud, quiet.length);
    const series = segmentRmsDb(mixed, RATE, 1);
    assert.equal(series.length, 4);
    // Second half is 2x amplitude -> +6.02 dB.
    assert.ok(Math.abs(series[3] - series[0] - 6.02) < 0.1);
});

test('fftPowerSpectrum puts the peak of a pure tone in the matching bin', () => {
    const size = 1024;
    const hz = (RATE / size) * 64; // exactly bin 64
    const frame = new Float64Array(size);
    for (let i = 0; i < size; i++) frame[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
    const power = fftPowerSpectrum(frame);
    let peak = 1;
    for (let b = 2; b < power.length; b++) if (power[b] > power[peak]) peak = b;
    assert.equal(peak, 64);
});

test('bandProfileOverTime reports a low tone in the low band and a high tone in the high band', () => {
    const bands = AUDIO_BANDS.map((band) => band.key);
    const low = bandProfileOverTime(tone(2, 200), RATE);
    const high = bandProfileOverTime(tone(2, 5000), RATE);
    const lowRow = low[0];
    const highRow = high[0];
    assert.deepEqual(bands, ['low', 'mid', 'high']);
    assert.ok(lowRow[0] > lowRow[1] + 30, `low tone should sit in the low band (${lowRow})`);
    assert.ok(highRow[2] > highRow[0] + 30, `high tone should sit in the high band (${highRow})`);
});

test('alignSeries re-indexes the source by the retime factor', () => {
    const source = [10, 11, 12, 13, 14, 15];
    assert.deepEqual(alignSeries(source, 1, 3), [10, 11, 12]);
    // speed 1.5 -> output second 2 holds source second round(3) = 13.
    assert.deepEqual(alignSeries(source, 1.5, 3), [10, 12, 13]);
    assert.deepEqual(alignSeries(source, 1, 8), [10, 11, 12, 13, 14, 15, null, null]);
});

test('compareSeries separates a fixed change from a moving one', () => {
    const source = [0, 0, 0, 0, 0, 0];
    const fixed = [2, 2, 2, 2, 2, 2];
    const moving = [0, 0, 2, 2, 0, 0];
    const fixedResult = compareSeries(source, fixed, 1);
    const movingResult = compareSeries(source, moving, 1);
    assert.ok(Math.abs(fixedResult.mean - 2) < 1e-9);
    assert.ok(fixedResult.std < 1e-9);
    assert.ok(movingResult.std > 0.9, 'a change that moves over time must show up in std');
});

test('analyzeAudioPair: same file in and out reports no change and no drift', () => {
    const samples = addInto(tone(6, 300), tone(6, 3000));
    const result = analyzeAudioPair({ sourceSamples: samples, outputSamples: samples, sampleRate: RATE });
    assert.ok(result);
    assert.ok(Math.abs(result.level.deltaDb) < 0.01);
    assert.ok(result.level.driftDb < 0.01);
    assert.ok(result.bandDriftDb < 0.01);
    assert.ok(Math.abs(result.click.ratio - 1) < 1e-6);
});

test('analyzeAudioPair measures a +6 dB static gain with no drift', () => {
    const samples = addInto(tone(6, 300), tone(6, 3000));
    const louder = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) louder[i] = samples[i] * 2;
    const result = analyzeAudioPair({ sourceSamples: samples, outputSamples: louder, sampleRate: RATE });
    assert.ok(Math.abs(result.level.deltaDb - 6.02) < 0.15, `expected +6 dB, got ${result.level.deltaDb}`);
    assert.ok(result.level.driftDb < 0.01, 'a fixed gain must not read as drift');
});

test('analyzeAudioPair catches a slow level drift (the current core behaviour)', () => {
    const seconds = 12;
    const samples = addInto(tone(seconds, 300), tone(seconds, 3000));
    const drifted = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const t = i / RATE;
        drifted[i] = samples[i] * (1 + 0.3 * Math.sin((2 * Math.PI * t) / 5));
    }
    const result = analyzeAudioPair({ sourceSamples: samples, outputSamples: drifted, sampleRate: RATE });
    assert.ok(Math.abs(result.level.deltaDb) < 0.3, `mean level should stay put, got ${result.level.deltaDb}`);
    assert.ok(result.level.driftDb > 0.8, `a +/-0.3 gain swing must show up as drift, got ${result.level.driftDb}`);
});

test('analyzeAudioPair localises a drifting band to that band', () => {
    const seconds = 12;
    const low = tone(seconds, 200, 0.25);
    const high = tone(seconds, 5000, 0.25);
    const source = addInto(low, high);
    const drifted = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) {
        const t = i / RATE;
        drifted[i] = low[i] * (1 + 0.5 * Math.sin((2 * Math.PI * t) / 5)) + high[i];
    }
    const result = analyzeAudioPair({ sourceSamples: source, outputSamples: drifted, sampleRate: RATE });
    const [lowBand, , highBand] = result.bands;
    assert.ok(lowBand.driftDb > highBand.driftDb + 0.5, `low ${lowBand.driftDb} should out-drift high ${highBand.driftDb}`);
});

test('maxSampleJump flags a one-sample click that a smooth signal does not have', () => {
    const smooth = tone(1, 1000);
    const clicked = new Float32Array(smooth);
    clicked[8000] = 1;
    assert.ok(maxSampleJump(smooth) < 0.2);
    assert.ok(maxSampleJump(clicked) > 0.8);
});

test('summarizeSeries ignores non-finite entries and reports min/max', () => {
    const summary = summarizeSeries([1, null, 3, undefined, 5, NaN]);
    assert.equal(summary.count, 3);
    assert.equal(summary.mean, 3);
    assert.equal(summary.min, 1);
    assert.equal(summary.max, 5);
    assert.equal(summarizeSeries([]), null);
});
