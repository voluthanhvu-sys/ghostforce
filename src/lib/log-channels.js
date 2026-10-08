// One line belongs to one screen. The tag decides the screen, so a Unique
// run and an Edit run that overlap do not share a panel or a downloaded file.

export function logChannel(message) {
    const text = String(message || '');
    if (text.includes('[YT]')) return 'youtube';
    if (text.includes('[REFRAME]')) return 'reframe';
    if (text.includes('[EDIT]') || text.includes('[EDIT TOTAL]') || text.includes('[QA]') || text.includes('[TOPIC]')) return 'edit';
    return 'unique';
}

const FRAME_LINE = /\[FFMPEG\]/;
const FRAME_PROGRESS = /\bframe=/;

function isFrameProgress(line) {
    return FRAME_LINE.test(line) && FRAME_PROGRESS.test(line);
}

// Same bound the shared panel used: keep the recent lines, and keep one
// rolling FFmpeg progress row per clip tag instead of a new row every frame.
export function appendDisplayLog(list, msg) {
    const rows = Array.isArray(list) ? list : [];
    if (isFrameProgress(msg)) {
        const tag = (String(msg).match(/^(\[[^\]]+\])/) || [])[1] || '';
        const idx = rows.findIndex((line) =>
            (!tag || String(line).startsWith(tag)) && isFrameProgress(line)
        );
        if (idx >= 0) {
            const next = rows.slice();
            next[idx] = msg;
            return next;
        }
    }
    const next = [...rows, msg];
    if (next.length <= 500) return next;
    const kept = next.filter((line) => !isFrameProgress(line));
    const frames = next.filter((line) => isFrameProgress(line));
    return [...kept.slice(-450), ...frames.slice(-6)];
}
