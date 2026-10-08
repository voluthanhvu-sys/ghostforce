// Piecewise tempo shared by the video setpts and the audio rubberband.
// Strong uses the measured 8-second shape. Lower strengths take a fraction of
// that shape. Extreme does not go past it. The constant base speed still applies.

export const TEMPO_SHAPE = [1.15, 1.15, 1.12, 0.90, 0.88, 0.87, 1.00, 1.00];

export const shapeForGain = (tempoGain, shape = TEMPO_SHAPE) => {
    const scale = Math.min(1, Math.max(0, Number(tempoGain) || 0) / 2);
    return shape.map((multiplier) => Number((1 + (multiplier - 1) * scale).toFixed(4)));
};

// Source-time seconds -> output-time seconds. `speeds[i]` covers source second i,
// repeating. Higher speed makes that second shorter.
export const outputTimeAt = (sourceSec, speeds) => {
    const n = speeds.length;
    if (!n) return Math.max(0, Number(sourceSec) || 0);
    const inv = speeds.map((speed) => 1 / speed);
    const cycle = inv.reduce((sum, value) => sum + value, 0);
    const t = Math.max(0, Number(sourceSec) || 0);
    const cycles = Math.floor(t / n);
    let pos = t - cycles * n;
    let out = cycles * cycle;
    for (let i = 0; i < n; i++) {
        if (pos <= 1) return out + pos * inv[i];
        out += inv[i];
        pos -= 1;
    }
    return out;
};

export const tempoCurve = (baseSpeed, tempoGain, durationSec, shape = TEMPO_SHAPE) => {
    const base = Number(baseSpeed);
    const safeBase = Number.isFinite(base) && base > 0 ? base : 1;
    const speeds = shapeForGain(tempoGain, shape).map((multiplier) => Number((safeBase * multiplier).toFixed(4)));
    const n = speeds.length;
    const inv = speeds.map((speed) => 1 / speed);
    const prefixes = [0];
    for (let i = 0; i < n; i++) prefixes.push(prefixes[i] + inv[i]);
    const cycle = prefixes[n];
    const mapSpeed = Number((n / cycle).toFixed(4));

    let partial = `${prefixes[n - 1].toFixed(6)}+(ld(0)-${n - 1})*${inv[n - 1].toFixed(6)}`;
    for (let i = n - 2; i >= 0; i--) {
        partial = `if(lt(ld(0),${i + 1}),${prefixes[i].toFixed(6)}+(ld(0)-${i})*${inv[i].toFixed(6)},${partial})`;
    }
    const pos = `T-floor(T/${n})*${n}`;
    const videoSetpts = `(floor(T/${n})*${cycle.toFixed(6)}+if(lt(st(0,${pos}),${n + 1}),${partial},0))/TB`
        .replace(/,/g, '\\,');

    const dur = Math.max(0, Number(durationSec) || 0);
    const count = Math.max(1, Math.ceil(dur - 1e-3));
    const bounds = [];
    for (let i = 0; i < count; i++) {
        const start = i;
        const end = Math.min(dur, i + 1);
        if (end - start < 0.05 && bounds.length) bounds[bounds.length - 1].end = end;
        else bounds.push({ start, end });
    }
    const branches = bounds.map((bound, i) => `[ts${i}]atrim=start=${bound.start.toFixed(3)}:end=${bound.end.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speeds[i % n].toFixed(4)}[tc${i}]`);
    const audioChain = tempoAudioChain(branches);

    return { speeds, mapSpeed, videoSetpts, audioChain, branches, outputTimeAt: (sourceSec) => outputTimeAt(sourceSec, speeds) };
};

// The same asplit/atrim/atempo/concat text tempoCurve builds. A long clip is
// rendered as several of these chains, each under the Windows command limit,
// and the branch text is not rewritten.
export const tempoAudioChain = (branches) => {
    const list = Array.isArray(branches) ? branches : [];
    const inputs = list.map((branch) => String(branch).slice(0, String(branch).indexOf(']') + 1)).join('');
    const outputs = list.map((branch) => String(branch).slice(String(branch).lastIndexOf('['))).join('');
    return `asplit=${list.length}${inputs};${list.join(';')};${outputs}concat=n=${list.length}:v=0:a=1`;
};

// Split the branch list so each chain stays within maxChars. Every branch is
// kept, in order, with its original atempo and trim.
export const chunkTempoBranches = (branches, maxChars) => {
    const list = Array.isArray(branches) ? branches : [];
    const limit = Math.max(1, Number(maxChars) || 0);
    const chunks = [];
    let current = [];
    for (const branch of list) {
        if (!current.length) {
            current = [branch];
            continue;
        }
        if (tempoAudioChain([...current, branch]).length > limit) {
            chunks.push(current);
            current = [branch];
        } else {
            current = [...current, branch];
        }
    }
    if (current.length) chunks.push(current);
    return chunks;
};
