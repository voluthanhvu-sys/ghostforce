// Turns the stored part scores into a configuration decision, without any human
// label. suggestDetailConfig says which detail mode has scored better on this
// operator's footage, and only when there are enough parts and a real gap.
// Pure: no I/O, so it is unit tested.

const groupKey = (entry) => `${entry?.framingStyle || 'focus'}/${entry?.detailModelMode || 'safe'}`;

export const summarizeQaHistory = (entries) => {
    const groups = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const score = Number(entry?.score);
        if (!Number.isFinite(score)) continue;
        const key = groupKey(entry);
        const group = groups.get(key) || { key, parts: 0, sum: 0, warned: 0 };
        group.parts += 1;
        group.sum += score;
        if (Array.isArray(entry?.warnings) && entry.warnings.length) group.warned += 1;
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((g) => ({ ...g, avgScore: Math.round((g.sum / g.parts) * 10) / 10, warnRate: Math.round((g.warned / g.parts) * 100) / 100 }))
        .sort((a, b) => b.parts - a.parts);
};

// `minParts` protects against deciding from two lucky runs; `minGain` keeps the
// app from switching a setting over noise. Both are deliberately conservative.
// `topic` narrows the evidence to one topic, so each topic tunes its own detail
// mode instead of borrowing another topic's numbers. Without it the whole
// history is used (the old behaviour).
export const suggestDetailConfig = (entries, { minParts = 12, minGain = 5, topic = null } = {}) => {
    const scoped = topic
        ? (Array.isArray(entries) ? entries : []).filter((entry) => String(entry?.topic || 'generic') === String(topic))
        : entries;
    const groups = summarizeQaHistory(scoped).filter((g) => g.parts >= minParts && g.key.startsWith('focus/'));
    if (groups.length < 2) return null;
    const ranked = [...groups].sort((a, b) => b.avgScore - a.avgScore);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best.key === worst.key) return null;
    const gain = Math.round((best.avgScore - worst.avgScore) * 10) / 10;
    if (gain < minGain) return null;
    const bestMode = best.key.split('/')[1];
    return {
        detailModelMode: bestMode,
        gain,
        reason: `${bestMode} ${best.avgScore}đ/${best.parts} part vs ${worst.key.split('/')[1]} ${worst.avgScore}đ/${worst.parts} part (lệch ${gain}đ)`,
        groups,
        topic: topic || null,
    };
};

// How each topic has actually scored so far - the operator can see whether a
// topic's own workflow is doing better or worse than the generic one.
export const summarizeQaByTopic = (entries) => {
    const topics = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const score = Number(entry?.score);
        if (!Number.isFinite(score)) continue;
        const key = String(entry?.topic || 'generic');
        const row = topics.get(key) || { topic: key, parts: 0, sum: 0, warned: 0, modes: new Map() };
        row.parts += 1;
        row.sum += score;
        if (Array.isArray(entry?.warnings) && entry.warnings.length) row.warned += 1;
        const mode = String(entry?.detailModelMode || 'safe');
        row.modes.set(mode, (row.modes.get(mode) || 0) + 1);
        topics.set(key, row);
    }
    return [...topics.values()]
        .map((row) => ({
            topic: row.topic,
            parts: row.parts,
            avgScore: Math.round((row.sum / row.parts) * 10) / 10,
            warnRate: Math.round((row.warned / row.parts) * 100) / 100,
            modes: Object.fromEntries(row.modes),
        }))
        .sort((a, b) => b.parts - a.parts);
};

// One row per source video, and one row per part inside it. A later render of
// the same part replaces the earlier row, so a 500-entry history stays a short
// list of videos. Pure: the route checks whether the source file is still there.
const replaySpan = (entry) => {
    const stored = Array.isArray(entry?.ranges) ? entry.ranges : [];
    const ranges = stored
        .map((piece) => Array.isArray(piece)
            ? [Number(piece[0]), Number(piece[1])]
            : [Number(piece?.start), Number(piece?.end)])
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
    if (ranges.length) return { start: ranges[0][0], end: ranges[ranges.length - 1][1], ranges };
    const start = Number(entry?.start);
    const end = Number(entry?.end);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end, ranges: [[start, end]] };
    return null;
};

export const replayCatalog = (entries) => {
    const videos = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const sourcePath = String(entry?.sourcePath || '').trim();
        const span = replaySpan(entry);
        if (!sourcePath || !span) continue;
        const at = String(entry?.at || '');
        const video = videos.get(sourcePath) || {
            sourcePath,
            sourceName: '',
            newestAt: '',
            parts: new Map(),
        };
        const sourceName = String(entry?.sourceName || '').trim();
        if (sourceName) video.sourceName = sourceName;
        if (at >= video.newestAt) video.newestAt = at;
        const partIndex = Math.max(1, Math.round(Number(entry?.partIndex) || 1));
        const partKey = `${partIndex}|${span.start}|${span.end}`;
        const prev = video.parts.get(partKey);
        if (!prev || at >= prev.at) {
            const score = Number(entry?.score);
            video.parts.set(partKey, {
                partIndex,
                partName: String(entry?.partName || ''),
                start: span.start,
                end: span.end,
                ranges: span.ranges,
                score: Number.isFinite(score) ? Math.round(score) : null,
                at,
                durationSec: Number(entry?.durationSec) || Math.round((span.end - span.start) * 10) / 10,
            });
        }
        videos.set(sourcePath, video);
    }
    return [...videos.values()]
        .map((video) => ({
            sourcePath: video.sourcePath,
            sourceName: video.sourceName || video.sourcePath,
            newestAt: video.newestAt,
            parts: [...video.parts.values()].sort((a, b) => a.partIndex - b.partIndex || a.start - b.start),
        }))
        .sort((a, b) => String(b.newestAt).localeCompare(String(a.newestAt)));
};

