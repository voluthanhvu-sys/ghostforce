// Post-render quality check for one Edit part (focus path).
//
// Purpose: the app cannot ask the operator "was this crop right?" after every
// video, so it measures what it CAN measure locally and for free, right after
// the render: did the crop window contain a subject, was the crop frozen while
// the picture moved, was it pinned to the frame edge, and how much of the part
// had no aim at all. The numbers are heuristics from the same column-energy
// sampling the fill path already uses (`sampleTalkerX`), not ground truth -
// they are a smoke detector, and they are stored so a trend is visible.
//
// Pure module: input is a plain sample list, output is a report. No I/O.

export const QA_WEIGHTS = {
    // score = 100 minus these, each capped (see buildEditQaReport).
    noSubjectPerSec: 90,   // per fraction of the part whose crop held no subject
    noSubjectCap: 45,
    emptyPerSec: 60,       // per fraction of very low-detail/dark samples
    emptyCap: 20,
    holdGraceSec: 12,      // a hold longer than this starts to cost
    holdPerSec: 1.2,
    holdCap: 20,
    edgePerSec: 30,        // per fraction pinned to a frame edge
    edgeCap: 10,
    edgeCutPerSec: 70,     // per fraction where the strongest subject sits just outside the crop
    edgeCutCap: 25,
    coveragePerPct: 0.4,   // per missing point of coverage percentage
    coverageCap: 15,
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;

export const buildEditQaReport = ({
    duration = 0,
    samples = [],
    coveragePct = 100,
    windows = [],
    repairedSec = 0,
} = {}) => {
    const dur = Math.max(0.001, Number(duration) || 0);
    const list = (Array.isArray(samples) ? samples : [])
        .filter((s) => s && Number.isFinite(Number(s.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
    const step = list.length > 1
        ? (Number(list[list.length - 1].t) - Number(list[0].t)) / (list.length - 1)
        : dur;
    const slot = Math.max(0.5, Number.isFinite(step) ? step : 1);

    let noSubjectSec = 0;
    let emptySec = 0;
    let edgeSec = 0;
    let edgeCutSec = 0;
    let holdSec = 0;
    let longestHoldSec = 0;
    let holdCx = null;
    let holdPeak = null;
    let cropMovedSamples = 0;
    let prevCx = null;
    for (const s of list) {
        const cx = Number.isFinite(Number(s.cx)) ? Number(s.cx) : null;
        if (!s.inCrop) noSubjectSec += slot;
        if (s.empty) emptySec += slot;
        if (cx != null && (cx <= 0.09 || cx >= 0.91)) edgeSec += slot;
        if (s.edgeCut) edgeCutSec += slot;
        if (cx != null && prevCx != null && Math.abs(cx - prevCx) > 0.02) cropMovedSamples += 1;
        if (cx != null) {
            // A talking head on a fixed camera legitimately holds one position.
            // The hold only counts against the part when the SUBJECT moves while
            // the crop does not: that is what clips a head. Frame motion alone is
            // not enough (a gesturing speaker moves a lot at a fixed position).
            const peakX = Number.isFinite(Number(s.peakX)) ? Number(s.peakX) : null;
            if (holdCx != null && Math.abs(cx - holdCx) <= 0.02) {
                if (holdPeak == null) holdPeak = peakX;
                const moving = peakX != null && holdPeak != null
                    ? Math.abs(peakX - holdPeak) > 0.08
                    : (!Number.isFinite(Number(s.motion)) || Number(s.motion) > 0.015);
                if (moving) {
                    holdSec += slot;
                    longestHoldSec = Math.max(longestHoldSec, holdSec);
                } else {
                    holdSec = 0;
                }
            } else {
                holdSec = 0;
                holdCx = cx;
                holdPeak = peakX;
            }
            prevCx = cx;
        }
    }
    const score = Math.max(0, Math.min(100, Math.round(100
        - Math.min(QA_WEIGHTS.noSubjectCap, (noSubjectSec / dur) * QA_WEIGHTS.noSubjectPerSec)
        - Math.min(QA_WEIGHTS.emptyCap, (emptySec / dur) * QA_WEIGHTS.emptyPerSec)
        - Math.min(QA_WEIGHTS.holdCap, Math.max(0, longestHoldSec - QA_WEIGHTS.holdGraceSec) * QA_WEIGHTS.holdPerSec)
        - Math.min(QA_WEIGHTS.edgeCap, (edgeSec / dur) * QA_WEIGHTS.edgePerSec)
        - Math.min(QA_WEIGHTS.edgeCutCap, (edgeCutSec / dur) * QA_WEIGHTS.edgeCutPerSec)
        - Math.min(QA_WEIGHTS.coverageCap, Math.max(0, 100 - Number(coveragePct || 0)) * QA_WEIGHTS.coveragePerPct))));

    const warnings = [];
    if (list.length && noSubjectSec >= Math.max(4, dur * 0.15)) {
        warnings.push(`crop không có chủ thể trong ${noSubjectSec.toFixed(0)}s/${dur.toFixed(0)}s`);
    }
    if (emptySec >= Math.max(3, dur * 0.1)) {
        warnings.push(`${emptySec.toFixed(0)}s khung hình trống/tối (có thể crop lệch)`);
    }
    if (longestHoldSec > 20) {
        warnings.push(`crop đứng yên ${longestHoldSec.toFixed(0)}s liền (giữ một vị trí)`);
    }
    if (edgeSec >= Math.max(4, dur * 0.15)) {
        warnings.push(`${edgeSec.toFixed(0)}s crop dính sát mép khung (chủ thể có thể ở ngoài)`);
    }
    if (edgeCutSec >= Math.max(2, dur * 0.08)) {
        warnings.push(`${edgeCutSec.toFixed(0)}s chủ thể chính bị cắt ở mép khung`);
    }
    if (Number(coveragePct) < 90) {
        warnings.push(`AI chỉ phủ ${Number(coveragePct).toFixed(0)}% thời lượng${repairedSec >= 3 ? ` (đã bù ${repairedSec.toFixed(0)}s bằng mẫu RGB)` : ''}`);
    }
    if (list.length && cropMovedSamples === 0 && dur > 20) {
        warnings.push('crop không di chuyển lần nào trong cả part');
    }

    const grade = score >= 85 ? 'tot' : score >= 70 ? 'kha' : score >= 50 ? 'trung-binh' : 'kem';
    return {
        score,
        grade,
        warnings,
        metrics: {
            sampledSec: round2(list.length ? list.length * slot : 0),
            samples: list.length,
            noSubjectSec: round2(noSubjectSec),
            emptySec: round2(emptySec),
            longestHoldSec: round2(longestHoldSec),
            edgeSec: round2(edgeSec),
            edgeCutSec: round2(edgeCutSec),
            cropMovedSamples,
            coveragePct: round2(Math.max(0, Math.min(100, Number(coveragePct) || 0))),
            repairedSec: round2(repairedSec),
            windowCount: (Array.isArray(windows) ? windows : []).length,
            durationSec: round2(dur),
        },
    };
};

// Which moments are worth a second opinion: the samples where the crop held no
// subject or the frame was empty/dark, spread out so the critic does not get
// four frames of the same bad second.
export const pickQaFocusPoints = (samples, { max = 4, minGapSec = 3 } = {}) => {
    const bad = (Array.isArray(samples) ? samples : [])
        .filter((s) => s && Number.isFinite(Number(s.t)) && (!s.inCrop || s.empty || s.edgeCut))
        .sort((a, b) => Number(a.t) - Number(b.t));
    const picked = [];
    for (const sample of bad) {
        const t = Number(sample.t);
        if (picked.some((p) => Math.abs(p - t) < minGapSec)) continue;
        picked.push(Math.round(t * 10) / 10);
        if (picked.length >= max) break;
    }
    return picked;
};

// Replace the aim around a corrected timestamp. The critic returns a position in
// SOURCE coordinates; we seed it slightly before and after the moment so the
// corrected framing holds across it instead of being interpolated away.
export const applyAimOverrides = (points, overrides, duration) => {
    const dur = Math.max(0.001, Number(duration) || 0);
    let out = (Array.isArray(points) ? points : []).map((p) => ({ ...p }));
    for (const override of Array.isArray(overrides) ? overrides : []) {
        const cx = Number(override?.cx);
        const t = Number(override?.t);
        if (!Number.isFinite(cx) || !Number.isFinite(t)) continue;
        const cy = Number.isFinite(Number(override?.cy)) ? Number(override.cy) : 0.42;
        const from = Math.max(0, t - 1.5);
        const to = Math.min(dur, t + 1.5);
        out = out.filter((p) => Number(p.t) < from || Number(p.t) > to);
        out.push({ t: from, cx, cy, who: 'critic' });
        out.push({ t: to, cx, cy, who: 'critic' });
    }
    return out.sort((a, b) => Number(a.t) - Number(b.t));
};
