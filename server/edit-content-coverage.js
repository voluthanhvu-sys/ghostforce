// Automatic Global coverage: uncertain footage is kept; no user wait or extra AI call.
export const globalCoverageGuidance = () => `
GLOBAL CONTENT COVERAGE: Keep ALL source content by default. Only exclude clearly identified OUTRO/END-CARD or ADVERTISEMENT unrelated to the story. Uncertain content MUST stay, including final dialogue, callbacks, jokes and phone calls. Product names, props and in-story product jokes are NOT advertisements.
In this SAME JSON add top-level "excludedRanges": [{"start":<source seconds>,"end":<source seconds>,"kind":"outro" or "advertisement","confidence":"certain","reason":"concrete observed visual/audio evidence"}]. Use [] when no exclusion is certain. Do not invent evidence to justify gaps or equal part lengths. An outro range must continue to EOF. Segments must cover all remaining story in timeline order; use pieces for an episode that crosses a genuine ad.
Also report "tailEvidence":{"storyEnd":<source seconds or null>,"outroStart":<source seconds or null>,"reason":"observed evidence or empty"}. Uncertainty must not shorten the final episode.
`;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const span = (pieces) => pieces.reduce((n, p) => n + p.end - p.start, 0);
const rangesOf = (seg) => (seg.pieces?.length ? seg.pieces : seg.ranges?.length ? seg.ranges : [seg])
    .map((p) => Array.isArray(p) ? { start: p[0], end: p[1] } : { ...p });

function subtract(start, end, excluded) {
    let cursor = start;
    const kept = [];
    for (const cut of excluded) {
        if (cut.end <= cursor || cut.start >= end) continue;
        if (cut.start > cursor) kept.push({ start: cursor, end: Math.min(end, cut.start), role: 'body' });
        cursor = Math.max(cursor, Math.min(end, cut.end));
    }
    if (cursor < end) kept.push({ start: cursor, end, role: 'body' });
    return kept;
}

// Keep source-time targets aligned when new coverage shifts the concatenated local timeline.
function remapFraming(seg, oldPieces, newPieces) {
    const frames = [], track = [];
    let oldOffset = 0;
    for (const old of oldPieces) {
        let newOffset = 0;
        for (const piece of newPieces) {
            for (const w of seg.frames || []) {
                const start = Math.max(old.start, piece.start, old.start + w.a - oldOffset);
                const end = Math.min(old.end, piece.end, old.start + w.b - oldOffset);
                if (end > start) frames.push({ ...w, a: newOffset + start - piece.start, b: newOffset + end - piece.start });
            }
            for (const point of seg.track || []) {
                const sourceT = old.start + point.t - oldOffset;
                if (point.t >= oldOffset && point.t < oldOffset + old.end - old.start
                    && sourceT >= piece.start && sourceT < piece.end) track.push({ ...point, t: newOffset + sourceT - piece.start });
            }
            newOffset += piece.end - piece.start;
        }
        oldOffset += old.end - old.start;
    }
    frames.sort((a, b) => a.a - b.a);
    const covered = [];
    let cursor = 0;
    for (const frame of frames) {
        if (frame.a > cursor) covered.push({ a: cursor, b: frame.a, mode: 'contain', why: 'Restored source content; Global framing unavailable' });
        covered.push(frame);
        cursor = Math.max(cursor, frame.b);
    }
    if (cursor < span(newPieces)) covered.push({ a: cursor, b: span(newPieces), mode: 'contain', why: 'Restored source content; Global framing unavailable' });
    return { frames: covered, track: track.sort((a, b) => a.t - b.t) };
}

export function applyGlobalCoveragePolicy(plan, duration, minSec, onLog = () => {}) {
    const raw = Array.isArray(plan._raw?.excludedRanges) ? plan._raw.excludedRanges : [];
    const excluded = [];
    raw.forEach((cut, index) => {
        const reason = typeof cut?.reason === 'string' ? cut.reason.replace(/[\r\n\t]/g, ' ').trim().slice(0, 240) : '';
        const valid = cut && finite(cut.start) && finite(cut.end) && cut.start >= 0 && cut.end > cut.start && cut.end <= duration
            && ['outro', 'advertisement'].includes(cut.kind) && cut.confidence === 'certain' && reason
            && (cut.kind !== 'outro' || (Math.abs(cut.end - duration) <= 0.1
                && !(finite(plan._raw?.tailEvidence?.storyEnd) && plan._raw.tailEvidence.storyEnd > cut.start + 0.1)));
        if (valid) excluded.push({ ...cut, reason });
        onLog(`[EDIT] Coverage exclusion ${index + 1}: ${valid ? 'AI-certain candidate' : 'REJECTED; keep footage'} ${JSON.stringify({ start: cut?.start, end: cut?.end, kind: cut?.kind, reason })}`);
    });
    excluded.sort((a, b) => a.start - b.start);
    // Do not create tiny output parts which the existing >60s render gate would skip.
    // Keep original split points unless a split itself would strand a short interval.
    const minimum = Math.max(60.1, minSec);
    const ordered = [];
    for (const seg of [...plan.segments].sort((a, b) => a.start - b.start)) {
        if (!finite(seg.start) || seg.start < 0 || seg.start >= duration) continue;
        const previousStart = ordered.length <= 1 ? 0 : ordered.at(-1).start;
        if (ordered.length && seg.start - previousStart < minimum) {
            onLog(`[EDIT] Coverage: merge short/overlapping split at ${seg.start}s into preceding part; keep footage`);
        } else ordered.push(seg);
    }
    while (ordered.length > 1 && duration - ordered.at(-1).start < minimum) {
        onLog(`[EDIT] Coverage: merge short final interval at ${ordered.at(-1).start}s into preceding part; keep footage`);
        ordered.pop();
    }
    if (!ordered.length) throw new Error('Global coverage has no usable segment boundaries');
    let keptTotal = 0;
    plan.segments = ordered.map((seg, i) => {
        const start = i === 0 ? 0 : seg.start;
        const end = i + 1 < ordered.length ? ordered[i + 1].start : duration;
        const oldPieces = rangesOf(seg);
        let pieces = subtract(start, end, excluded);
        if (span(pieces) < minimum || pieces.some((p) => p.end - p.start < 0.2)) {
            pieces = [{ start, end, role: 'body' }];
            onLog(`[EDIT] Coverage Part ${i + 1}: retain interval; exclusions would make part too short`);
        }
        const unchanged = oldPieces.length === pieces.length && oldPieces.every((p, n) => p.start === pieces[n].start && p.end === pieces[n].end);
        const dur = span(pieces);
        keptTotal += dur;
        onLog(`[EDIT] Coverage Part ${i + 1}: original=${JSON.stringify(oldPieces.map((p) => [p.start, p.end]))} final=${JSON.stringify(pieces.map((p) => [p.start, p.end]))} kept=${dur.toFixed(2)}s ${unchanged ? 'unchanged' : 'reconciled before Detail'}`);
        if (unchanged) return seg;
        return {
            ...seg, start: pieces[0].start, end: pieces.at(-1).end, dur, pieces,
            ranges: pieces.map((p) => [p.start, p.end]),
            script: pieces.map((p) => `${p.role || 'body'} ${p.start}–${p.end}`).join(' > '),
            ...remapFraming(seg, oldPieces, pieces),
        };
    });
    onLog(`[EDIT] Coverage complete: source=${duration.toFixed(2)}s kept=${keptTotal.toFixed(2)}s excluded=${(duration - keptTotal).toFixed(2)}s; uncertain=KEEP; no manual wait; evidence is AI-reported`);
}
