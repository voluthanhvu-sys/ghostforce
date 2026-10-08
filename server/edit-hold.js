import fs from 'fs';
import path from 'path';
import { uniqueHoldJobId } from './unique-hold.js';

// A finished Edit part stays in uploads/<jobId>_output.mp4 until it is saved or
// the cut list is cleared. The browser list does not survive a power cut, so
// this file is that list. A part is written only when its mp4 already exists,
// before the client is told. The store does not scan the uploads folder.

const MAX_ITEMS = 500;

function sidecar(uploadsDir, jobId) {
    const root = path.resolve(uploadsDir);
    const file = path.resolve(root, `${jobId}_output.mp4`);
    if (path.dirname(file) !== root) return '';
    return file;
}

function clipText(raw, max) {
    return String(raw || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanRanges(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const pair of raw) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const start = Number(pair[0]);
        const end = Number(pair[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        out.push([start, end]);
        if (out.length >= 40) break;
    }
    return out;
}

function cleanQa(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const score = Number(raw.score);
    if (!Number.isFinite(score)) return null;
    const warnings = Array.isArray(raw.warnings)
        ? raw.warnings.map((item) => clipText(item, 180)).filter(Boolean).slice(0, 12)
        : [];
    return {
        score: Math.max(0, Math.min(100, Math.round(score))),
        grade: clipText(raw.grade, 20),
        warnings,
    };
}

function cleanPart(raw, outputOf) {
    const jobId = uniqueHoldJobId(raw?.jobId);
    const output = jobId ? outputOf(jobId) : '';
    if (!jobId || !output) return null;
    try {
        if (!fs.existsSync(output) || !fs.statSync(output).isFile() || fs.statSync(output).size < 1) return null;
    } catch {
        return null;
    }
    const ranges = cleanRanges(raw.ranges);
    const start = Number(raw.start);
    const end = Number(raw.end);
    const dur = Number(raw.dur);
    return {
        jobId,
        sourceName: clipText(raw.sourceName, 180) || 'video.mp4',
        sourcePath: clipText(raw.sourcePath, 500),
        partIndex: Math.max(1, Math.round(Number(raw.partIndex) || 1)),
        name: clipText(raw.name, 180) || 'video.mp4',
        title: clipText(raw.title, 180),
        titleVi: clipText(raw.titleVi, 180),
        script: clipText(raw.script, 500),
        reason: clipText(raw.reason, 240),
        start: Number.isFinite(start) ? start : 0,
        end: Number.isFinite(end) ? end : 0,
        dur: Number.isFinite(dur) ? dur : 0,
        ranges,
        qa: cleanQa(raw.qa),
        finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : '',
    };
}

export function createEditHoldStore(filePath, { uploadsDir, maxItems = MAX_ITEMS } = {}) {
    const outputOf = (jobId) => sidecar(uploadsDir, jobId);
    const readItems = () => {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return Array.isArray(parsed?.items) ? parsed.items : [];
        } catch {
            return [];
        }
    };
    const writeItems = (items) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ items })}\n`);
        try {
            fs.renameSync(tmp, filePath);
        } catch {
            try { fs.rmSync(filePath, { force: true }); } catch { /* replace on Windows */ }
            fs.renameSync(tmp, filePath);
        }
    };
    const load = () => {
        const items = [];
        let dropped = false;
        for (const raw of readItems()) {
            const item = cleanPart(raw, outputOf);
            if (item) items.push(item);
            else dropped = true;
        }
        const cap = Math.max(1, Number(maxItems) || MAX_ITEMS);
        let capped = items;
        if (items.length > cap) {
            capped = items
                .slice()
                .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
                .slice(-cap);
            dropped = true;
        }
        if (dropped) {
            try { writeItems(capped); } catch { /* a locked file still returns the good rows */ }
        }
        return capped;
    };

    return {
        remember(part) {
            const output = outputOf(uniqueHoldJobId(part?.jobId));
            if (!output) return false;
            try {
                if (!fs.existsSync(output) || !fs.statSync(output).isFile() || fs.statSync(output).size < 1) return false;
            } catch {
                return false;
            }
            const items = load();
            const prev = items.find((item) => item.jobId === uniqueHoldJobId(part.jobId)) || null;
            const next = cleanPart({
                ...part,
                finishedAt: prev?.finishedAt || (typeof part?.finishedAt === 'string' && part.finishedAt) || new Date().toISOString(),
            }, outputOf);
            if (!next) return false;
            const rest = items.filter((item) => item.jobId !== next.jobId);
            const cap = Math.max(1, Number(maxItems) || MAX_ITEMS);
            const kept = [...rest, next]
                .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
                .slice(-cap);
            try {
                writeItems(kept);
            } catch {
                return false;
            }
            return true;
        },
        forget(jobId) {
            const id = uniqueHoldJobId(jobId);
            if (!id) return false;
            const items = load();
            const next = items.filter((item) => item.jobId !== id);
            if (next.length === items.length) return false;
            try {
                writeItems(next);
            } catch {
                return false;
            }
            return true;
        },
        list() {
            return load().slice().sort((a, b) => {
                const source = String(a.sourceName).localeCompare(String(b.sourceName));
                if (source) return source;
                return a.partIndex - b.partIndex;
            });
        },
        // Puts finished parts back so download and export-copy work after a restart.
        // streamState.finished stops a later stream open from encoding again.
        rehydrate(jobs) {
            let restored = 0;
            for (const item of load()) {
                if (jobs.has(item.jobId)) continue;
                const outputPath = outputOf(item.jobId);
                let inputPath = '';
                if (item.sourcePath) {
                    try {
                        if (fs.existsSync(item.sourcePath) && fs.statSync(item.sourcePath).isFile()) inputPath = item.sourcePath;
                    } catch { /* Test lại will say the source is gone */ }
                }
                jobs.set(item.jobId, {
                    kind: 'edit-part',
                    inputPath,
                    keepInput: true,
                    outputPath,
                    originalName: item.name,
                    status: 'done',
                    held: true,
                    streamState: { clients: new Set(), history: [], finished: true },
                });
                restored += 1;
            }
            return restored;
        },
    };
}
