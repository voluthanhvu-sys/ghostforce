import fs from 'fs';
import path from 'path';

// Finished Unique renders stay in uploads/<jobId>_output.mp4 until the operator
// removes the row. The in-memory job map and the browser session do not survive
// a power cut, so this file is the list of renders that were not saved yet.
// Edit and Reframe also write <jobId>_output.mp4. This store never scans the
// folder: a video is kept only when the Unique pipeline recorded it.

export function uniqueHoldJobId(raw) {
    const id = String(raw || '');
    return /^[a-f0-9]{16,64}$/i.test(id) ? id : '';
}

export function holdDisplayName(raw, fallback = 'video.mp4') {
    const base = String(raw || '').split(/[/\\]/).pop() || '';
    let cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, ' ').replace(/^\.+/, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!cleaned) return fallback;
    if (/\.(mp4|mov|webm|m4v)$/i.test(cleaned)) {
        return cleaned.replace(/\.(mov|webm|m4v)$/i, '.mp4');
    }
    return `${cleaned}.mp4`;
}

function sidecar(uploadsDir, jobId, suffix) {
    const root = path.resolve(uploadsDir);
    const file = path.resolve(root, `${jobId}${suffix}`);
    if (path.dirname(file) !== root) return '';
    return file;
}

function plainStats(stats) {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
    try {
        const text = JSON.stringify(stats);
        if (!text || text.length > 80_000) return null;
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function createUniqueHoldStore(filePath, { uploadsDir } = {}) {
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
    const outputOf = (jobId) => sidecar(uploadsDir, jobId, '_output.mp4');
    const usable = (item) => {
        const jobId = uniqueHoldJobId(item?.jobId);
        const output = jobId ? outputOf(jobId) : '';
        if (!jobId || !output) return null;
        try {
            if (!fs.existsSync(output) || !fs.statSync(output).isFile() || fs.statSync(output).size < 1) return null;
        } catch {
            return null;
        }
        return {
            jobId,
            name: holdDisplayName(item.name, holdDisplayName(item.originalName)),
            originalName: holdDisplayName(item.originalName, holdDisplayName(item.name)),
            stats: plainStats(item.stats),
            finishedAt: typeof item.finishedAt === 'string' ? item.finishedAt : '',
        };
    };
    const load = () => {
        const items = [];
        let dropped = false;
        for (const raw of readItems()) {
            const item = usable(raw);
            if (item) items.push(item);
            else dropped = true;
        }
        if (dropped) {
            try { writeItems(items); } catch { /* a locked file still returns the good rows */ }
        }
        return items;
    };

    return {
        remember({ jobId, name, originalName, stats }) {
            const id = uniqueHoldJobId(jobId);
            const output = id ? outputOf(id) : '';
            if (!id || !output) return false;
            try {
                if (!fs.existsSync(output) || !fs.statSync(output).isFile() || fs.statSync(output).size < 1) return false;
            } catch {
                return false;
            }
            const items = load();
            const prev = items.find((item) => item.jobId === id) || null;
            const next = {
                jobId: id,
                name: holdDisplayName(name, prev?.name || holdDisplayName(originalName)),
                originalName: holdDisplayName(originalName, prev?.originalName || 'video.mp4'),
                stats: plainStats(stats) || prev?.stats || null,
                finishedAt: prev?.finishedAt || new Date().toISOString(),
            };
            const rest = items.filter((item) => item.jobId !== id);
            try {
                writeItems([...rest, next]);
            } catch {
                return false;
            }
            return true;
        },
        rename(jobId, name) {
            const id = uniqueHoldJobId(jobId);
            if (!id || !String(name || '').trim()) return false;
            const items = load();
            const prev = items.find((item) => item.jobId === id);
            if (!prev) return false;
            prev.name = holdDisplayName(name, prev.name);
            try {
                writeItems(items);
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
            return load()
                .slice()
                .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
        },
        // Puts finished renders back into the job map so download, compare and
        // export-copy work after a restart. streamState.finished stops a later
        // GET /api/stream/:jobId from encoding the file again.
        rehydrate(jobs) {
            let restored = 0;
            for (const item of load()) {
                if (jobs.has(item.jobId)) continue;
                const outputPath = outputOf(item.jobId);
                const compare = {};
                for (const kind of ['orig', 'proc', 'diff']) {
                    const file = sidecar(uploadsDir, item.jobId, `_cmp_${kind}.jpg`);
                    try {
                        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) compare[kind] = file;
                    } catch { /* a missing still just hides that compare */ }
                }
                jobs.set(item.jobId, {
                    inputPath: '',
                    originalName: item.originalName,
                    originalSize: Number(item.stats?.originalSize) || 0,
                    outputPath,
                    status: 'done',
                    held: true,
                    heldStats: item.stats,
                    settings: {},
                    ...(Object.keys(compare).length ? { compare } : {}),
                    streamState: { clients: new Set(), history: [], finished: true },
                });
                restored += 1;
            }
            return restored;
        },
    };
}
