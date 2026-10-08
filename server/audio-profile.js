// Audio measurement helpers for the Unique result panel.
// Pure math only: no filesystem, FFmpeg or job access. The backend pipes mono PCM
// (f32le, 16 kHz) out of FFmpeg and hands the samples to these functions, so the whole
// measurement is unit-testable without any media file.
//
// Why this exists: the panel could report dHash/pHash for the picture, but the audio
// side ("am thanh khac den dau") was unmeasured - the 2026-09-27 handoff says so
// explicitly. These helpers measure the two things an audio fingerprint notices:
//   1. the loudness envelope per second (a level drift), and
//   2. the energy of three frequency bands per second (a spectral / EQ drift).
// Both are compared at the SAME content time: the Unique pass retimes by `speed`
// (source time = output time * speed), so the source series is re-indexed before the
// difference is taken. The residual (output - source) is what the pass actually added.
// These are operator estimates, not a platform audio-fingerprint verdict, and they are
// content dependent: a quiet second and a loud second are not comparable to each other,
// only output-vs-source at the same moment is.

export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_FFT_SIZE = 1024;
export const AUDIO_WINDOW_SEC = 1;
// The analysis window. The drift periods in the render are 1.4-11 s, so two minutes of
// audio shows many cycles; a longer window would only cost decode time.
export const AUDIO_MAX_SECONDS = 120;

export const AUDIO_BANDS = [
    { key: 'low', label: 'Thấp (30-400 Hz)', from: 30, to: 400 },
    { key: 'mid', label: 'Giữa (400-3000 Hz)', from: 400, to: 3000 },
    { key: 'high', label: 'Cao (3000-8000 Hz)', from: 3000, to: 8000 },
];

const finite = (value) => Number.isFinite(value);
const floorDb = (power) => 10 * Math.log10(power + 1e-12);

// Level of a block of samples, in dBFS. Silence (all zeros) returns the floor, not -Inf.
export const rmsDb = (samples) => {
    if (!samples || !samples.length) return null;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        sum += v * v;
    }
    return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
};

// Loudness per window, in dBFS - this is the "do lon theo tung giay" series.
export const segmentRmsDb = (samples, sampleRate = AUDIO_SAMPLE_RATE, windowSec = AUDIO_WINDOW_SEC) => {
    if (!samples || !samples.length) return [];
    const size = Math.max(1, Math.round(sampleRate * windowSec));
    const out = [];
    for (let start = 0; start + size <= samples.length; start += size) {
        let sum = 0;
        for (let i = start; i < start + size; i++) {
            const v = samples[i];
            sum += v * v;
        }
        out.push(20 * Math.log10(Math.sqrt(sum / size) + 1e-9));
    }
    return out;
};

const hannCache = new Map();
const hannWindow = (size) => {
    let cached = hannCache.get(size);
    if (!cached) {
        cached = new Float64Array(size);
        for (let i = 0; i < size; i++) cached[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
        hannCache.set(size, cached);
    }
    return cached;
};

// In-place iterative radix-2 FFT. `frame` must have a power-of-two length; the matching
// imaginary input is all zeros, so only the real part needs the bit-reversal shuffle.
// Returns the power (magnitude squared) of the first half of the spectrum.
export const fftPowerSpectrum = (frame) => {
    const n = frame.length;
    const re = new Float64Array(frame);
    const im = new Float64Array(n);
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const t = re[i];
            re[i] = re[j];
            re[j] = t;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = (-2 * Math.PI) / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
            let cr = 1;
            let ci = 0;
            for (let k = 0; k < half; k++) {
                const a = i + k;
                const b = a + half;
                const xr = re[b] * cr - im[b] * ci;
                const xi = re[b] * ci + im[b] * cr;
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
                const nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
    const power = new Float64Array(n >> 1);
    for (let b = 0; b < power.length; b++) power[b] = re[b] * re[b] + im[b] * im[b];
    return power;
};

const bandEnergiesDb = (power, sampleRate, bands, fftSize) => {
    const binHz = sampleRate / fftSize;
    return bands.map((band) => {
        let sum = 0;
        let count = 0;
        for (let b = 1; b < power.length; b++) {
            const f = b * binHz;
            if (f >= band.from && f < band.to) {
                sum += power[b];
                count++;
            }
        }
        return count ? floorDb(sum / count) : -120;
    });
};

// Per-window band energy, in dB per bin (mean power over the window's FFT frames, so it
// does not grow with window length). Row = one window, column = one band.
export const bandProfileOverTime = (
    samples,
    sampleRate = AUDIO_SAMPLE_RATE,
    bands = AUDIO_BANDS,
    windowSec = AUDIO_WINDOW_SEC,
    fftSize = AUDIO_FFT_SIZE,
) => {
    if (!samples || samples.length < fftSize) return [];
    const winSize = Math.max(fftSize, Math.round(sampleRate * windowSec));
    const hop = fftSize >> 1;
    const window = hannWindow(fftSize);
    const frame = new Float64Array(fftSize);
    const out = [];
    for (let wStart = 0; wStart + fftSize <= samples.length; wStart += winSize) {
        const wEnd = Math.min(samples.length, wStart + winSize);
        const acc = new Float64Array(fftSize >> 1);
        let frames = 0;
        for (let start = wStart; start + fftSize <= wEnd; start += hop) {
            for (let i = 0; i < fftSize; i++) frame[i] = samples[start + i] * window[i];
            const power = fftPowerSpectrum(frame);
            for (let b = 0; b < acc.length; b++) acc[b] += power[b];
            frames++;
        }
        if (!frames) continue;
        for (let b = 0; b < acc.length; b++) acc[b] /= frames;
        out.push(bandEnergiesDb(acc, sampleRate, bands, fftSize));
    }
    return out;
};

export const summarizeSeries = (values) => {
    const list = (values || []).filter(finite);
    if (!list.length) return null;
    const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
    const variance = list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / list.length;
    return { count: list.length, mean, std: Math.sqrt(variance), min: Math.min(...list), max: Math.max(...list) };
};

// The Unique pass retimes by `speed` (source time = output time * speed), so output
// window i holds the content of source window round(i * speed). Anything past the end of
// the source series becomes null and drops out of the comparison.
export const alignSeries = (sourceSeries, speed, outCount) => {
    const source = sourceSeries || [];
    if (!source.length) return new Array(Math.max(0, outCount)).fill(null);
    const factor = finite(speed) && speed > 0 ? speed : 1;
    const aligned = [];
    for (let i = 0; i < outCount; i++) {
        const idx = Math.round(i * factor);
        aligned.push(idx >= 0 && idx < source.length ? source[idx] : null);
    }
    return aligned;
};

// Output minus source over the aligned windows. mean = the change the pass applied,
// std = how much that change MOVES over time (a static filter gives ~0 std).
export const compareSeries = (sourceSeries, outputSeries, speed) => {
    const rows = outputSeries || [];
    const aligned = alignSeries(sourceSeries, speed, rows.length);
    const deltas = [];
    for (let i = 0; i < rows.length; i++) {
        const a = aligned[i];
        const b = rows[i];
        if (finite(a) && finite(b)) deltas.push(b - a);
    }
    const summary = summarizeSeries(deltas);
    if (!summary) return null;
    return { ...summary, absMean: deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length };
};

export const compareBandProfiles = (sourceProfile, outputProfile, speed, bands = AUDIO_BANDS) => {
    if (!sourceProfile || !outputProfile || !sourceProfile.length || !outputProfile.length) return null;
    return bands.map((band, index) => ({
        ...band,
        source: summarizeSeries(sourceProfile.map((row) => row[index])),
        output: summarizeSeries(outputProfile.map((row) => row[index])),
        delta: compareSeries(sourceProfile.map((row) => row[index]), outputProfile.map((row) => row[index]), speed),
    }));
};

// Largest sample-to-sample jump. Used as a click guard: a filter that steps its gain
// instantly (FFmpeg's `equalizer` cannot be commanded smoothly) shows up here as a jump
// the source did not have, where a smooth time-varying gain does not move it at all.
export const maxSampleJump = (samples) => {
    if (!samples || samples.length < 2) return null;
    let max = 0;
    for (let i = 1; i < samples.length; i++) {
        const jump = Math.abs(samples[i] - samples[i - 1]);
        if (jump > max) max = jump;
    }
    return max;
};

// Full measurement from the two PCM buffers. Returns null when either side is too short
// to hold even one window.
export const analyzeAudioPair = ({
    sourceSamples,
    outputSamples,
    sampleRate = AUDIO_SAMPLE_RATE,
    speed = 1,
    windowSec = AUDIO_WINDOW_SEC,
    bands = AUDIO_BANDS,
} = {}) => {
    const sourceEnv = segmentRmsDb(sourceSamples, sampleRate, windowSec);
    const outputEnv = segmentRmsDb(outputSamples, sampleRate, windowSec);
    if (!sourceEnv.length || !outputEnv.length) return null;
    const levelDelta = compareSeries(sourceEnv, outputEnv, speed);
    const sourceBands = bandProfileOverTime(sourceSamples, sampleRate, bands, windowSec);
    const outputBands = bandProfileOverTime(outputSamples, sampleRate, bands, windowSec);
    const bandColumns = compareBandProfiles(sourceBands, outputBands, speed, bands);
    const sourceJump = maxSampleJump(sourceSamples);
    const outputJump = maxSampleJump(outputSamples);
    const levelSource = summarizeSeries(sourceEnv);
    const levelOutput = summarizeSeries(outputEnv);
    return {
        sampleRate,
        windowSec,
        windows: outputEnv.length,
        sourceWindows: sourceEnv.length,
        level: {
            sourceDb: levelSource ? levelSource.mean : null,
            outputDb: levelOutput ? levelOutput.mean : null,
            deltaDb: levelDelta ? levelDelta.mean : null,
            sourceStd: levelSource ? levelSource.std : null,
            outputStd: levelOutput ? levelOutput.std : null,
            // The number that says "the level moves over time": spread of output-minus-source.
            driftDb: levelDelta ? levelDelta.std : null,
            worstDb: levelDelta ? Math.max(Math.abs(levelDelta.min), Math.abs(levelDelta.max)) : null,
        },
        bands: (bandColumns || []).map((column) => ({
            key: column.key,
            label: column.label,
            from: column.from,
            to: column.to,
            sourceDb: column.source ? column.source.mean : null,
            outputDb: column.output ? column.output.mean : null,
            deltaDb: column.delta ? column.delta.mean : null,
            driftDb: column.delta ? column.delta.std : null,
        })),
        // The largest spectral movement over time in any band: the "troy EQ" evidence.
        bandDriftDb: bandColumns && bandColumns.length
            ? Math.max(...bandColumns.map((column) => (column.delta ? column.delta.std : 0)))
            : null,
        click: {
            sourceJump,
            outputJump,
            ratio: finite(sourceJump) && finite(outputJump) && sourceJump > 1e-6 ? outputJump / sourceJump : null,
        },
    };
};
