import path from 'path';
import { isInsideDir } from './youtube-url.js';

const RESERVED_DIR = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// One folder segment for a source video. Slashes and ".." stay out, so the
// parts of one video cannot be written outside the folder the operator picked.
export function videoGroupFolder(raw) {
    const base = String(raw || '').split(/[/\\]/).pop() || '';
    const stem = base.replace(/\.(mp4|mov|webm|m4v|mkv)$/i, '');
    let cleaned = stem
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[.\s]+|[.\s]+$/g, '');
    if (!cleaned || cleaned === '.' || cleaned === '..') return '';
    if (RESERVED_DIR.test(cleaned)) cleaned = `video ${cleaned}`;
    return cleaned.slice(0, 80);
}

export function exportDirForGroup(destRoot, groupRaw) {
    const root = path.resolve(String(destRoot || ''));
    const group = videoGroupFolder(groupRaw);
    if (!group) return { error: 'Video name is not a folder name' };
    const dir = path.resolve(root, group);
    if (!isInsideDir(root, dir) || dir === root) return { error: 'Save name escaped the folder' };
    return { dir, group };
}

// Edit jobs live in memory. After a restart the same id still names
// uploads/<id>_output.mp4. Only 16 or 32 hex characters, and only that one file.
export function heldOutputPath(uploadsDir, jobId) {
    const id = String(jobId || '').trim();
    if (!/^[a-f0-9]{16}$/.test(id) && !/^[a-f0-9]{32}$/.test(id)) return '';
    const dir = path.resolve(String(uploadsDir || ''));
    const file = path.resolve(dir, `${id}_output.mp4`);
    if (!isInsideDir(dir, file) || file === dir) return '';
    return file;
}

// A second Save of the same job must not invent "name (1).mp4" while the first
// copy is still in the folder. A deleted copy is written again under the
// requested name. A different job that only shares the name still gets (1).
export function planExportCopy({ destRoot, filename, existingDest, exists }) {
    const root = path.resolve(String(destRoot || ''));
    const previous = String(existingDest || '').trim();
    if (previous) {
        const dest = path.resolve(previous);
        if (isInsideDir(root, dest) && exists(dest)) {
            return { skip: true, dest, name: path.basename(dest) };
        }
    }
    const parsed = path.parse(String(filename || 'video.mp4'));
    for (let n = 0; n < 10000; n++) {
        const name = n ? `${parsed.name} (${n})${parsed.ext}` : String(filename || 'video.mp4');
        const dest = path.resolve(root, name);
        if (!isInsideDir(root, dest)) return { error: 'Save name escaped the folder' };
        if (!exists(dest)) return { skip: false, dest, name };
    }
    return { error: 'Too many files with this name' };
}
