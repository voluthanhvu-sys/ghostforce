import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function normalizeHashtag(value) {
  const tag = String(value || '').trim().replace(/^#/, '');
  if (!tag || tag.length > 80 || !/^[\p{L}\p{N}_.]+$/u.test(tag)) return null;
  return tag;
}

export function searchHashtag(tag, count = 30) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const localPython = path.join(root, '.venv-tiktokapi', 'Scripts', 'python.exe');
  const python = process.env.GHOSTFORGE_TIKTOK_PYTHON || (fs.existsSync(localPython) ? localPython : process.env.GHOSTFORGE_PYTHON || 'python');
  const script = path.join(root, 'tiktok_hashtag_search.py');
  return new Promise((resolve, reject) => {
    execFile(python, [script, tag, String(count)], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      let result;
      try { result = JSON.parse(stdout.trim()); } catch { /* handled below */ }
      if (error) return reject(new Error(result?.error || stderr.trim() || error.message));
      if (!Array.isArray(result?.videos)) return reject(new Error('TikTokApi did not return a video list.'));
      resolve(result.videos);
    });
  });
}
