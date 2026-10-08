import fs from 'fs';
import path from 'path';

// I/O-only store for the operator's Gemini API keys and chosen model.
//
// Why a server file: the browser copy lives in localStorage, which is per
// origin - the keys vanished whenever the app was opened from a different port
// (localhost vs 127.0.0.1 vs the Vite dev server), from another browser profile,
// or after clearing site data. The browser also only wrote them when a run
// started. This file is written as soon as the fields change, so restarting or
// updating the app no longer costs a re-entry.
//
// The file holds live API secrets in plain text, so it sits in `uploads/`
// (gitignored) and is never logged. GHOSTFORGE_SECRETS_FILE can move it out of
// the repo, for a setup where the app folder is replaced on update.
export function createGeminiSecretStore(filePath) {
    const normalize = (raw) => ({
        accounts: (Array.isArray(raw?.accounts) ? raw.accounts : [])
            .map((row) => ({
                email: String(row?.email ?? '').trim().slice(0, 120),
                secret: String(row?.secret ?? '').trim(),
            }))
            .filter((row) => row.secret)
            .slice(0, 20),
        model: String(raw?.model ?? '').trim().slice(0, 60),
    });
    return {
        read() {
            try {
                return normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            } catch {
                return { accounts: [], model: '' };
            }
        },
        write(raw) {
            const clean = normalize(raw);
            try {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, `${JSON.stringify(clean, null, 2)}\n`);
            } catch {
                // A read-only folder must not break a run; localStorage still
                // holds a copy for this browser.
            }
            return clean;
        },
        filePath,
    };
}
