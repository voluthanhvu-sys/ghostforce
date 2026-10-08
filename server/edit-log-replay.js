const sourceNameOf = (line) => {
    const match = line.match(/\[EDIT\] RUN job=\S+ source="([^"]+)"/);
    return match ? match[1] : '';
};

const basenameOf = (name) => String(name || '').replace(/^.*[\\/]/, '').trim().toLowerCase();

export const fallbackPartsFromLog = (logText, sourceName) => {
    const wanted = basenameOf(sourceName);
    if (!wanted) return [];
    const runs = [];
    let current = null;
    for (const line of String(logText || '').split(/\n/)) {
        const source = sourceNameOf(line);
        if (source) {
            current = { source, ranges: new Map(), failed: new Map() };
            runs.push(current);
            continue;
        }
        if (!current) continue;
        const segment = line.match(/Global raw segment (\d+): start=([\d.]+) end=([\d.]+)/);
        if (segment) {
            current.ranges.set(Number(segment[1]), { start: Number(segment[2]), end: Number(segment[3]) });
            continue;
        }
        const failed = line.match(/Detail PLAN (\d+)\/\d+ failed — using global PLAN fallback \(([^)]+)\)/);
        if (failed) current.failed.set(Number(failed[1]), failed[2]);
    }
    const matched = runs.filter((run) => basenameOf(run.source) === wanted);
    const run = matched[matched.length - 1];
    if (!run) return [];
    const parts = [];
    for (const [partIndex, reason] of run.failed) {
        const range = run.ranges.get(partIndex);
        if (!range || !(range.end > range.start)) continue;
        parts.push({
            partIndex,
            start: range.start,
            end: range.end,
            reason,
            name: `Part ${partIndex}`,
        });
    }
    return parts.sort((a, b) => a.partIndex - b.partIndex);
};
