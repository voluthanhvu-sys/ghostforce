// Classify Gemini generateContent failures for Detail model fallback.
// Daily request quota (RPD) stays exhausted until midnight Pacific.
// Per-minute request/token limits recover and must not be remembered.

const textOf = (value, parts, depth) => {
    if (depth > 6 || parts.length > 40) return;
    if (typeof value === 'string' || typeof value === 'number') {
        parts.push(String(value));
        return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) textOf(item, parts, depth + 1);
        return;
    }
    for (const [key, item] of Object.entries(value)) {
        if (key === '@type') continue;
        if (typeof item === 'string' || typeof item === 'number') parts.push(`${key} ${item}`);
        else textOf(item, parts, depth + 1);
    }
};

export const geminiErrorText = (body, status) => {
    const error = body && typeof body === 'object' ? body.error : null;
    const parts = [];
    if (error && typeof error.message === 'string') parts.push(error.message);
    if (error && typeof error.status === 'string') parts.push(error.status);
    if (status) parts.push(`HTTP ${status}`);
    textOf(error?.details, parts, 0);
    const text = parts.filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim();
    return (text || `Gemini generate ${status || 'error'}`).slice(0, 1500);
};

const DAILY_REQUEST = /Generate(?:Content)?Requests?PerDay|RequestsPerDay|requests per day|daily request quota/i;
const MINUTE_LIMIT = /Generate(?:Content)?Requests?PerMinute|RequestsPerMinute|requests per minute|tokens per minute|PerMinute|InputTokens/i;

const retryDelaySeconds = (text) => {
    const labeled = String(text || '').match(/retry(?:Delay|\s+in)?\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds|m|min|minutes|h|hr|hours)\b/i);
    if (!labeled) return null;
    const amount = Number(labeled[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = labeled[2].toLowerCase();
    if (unit.startsWith('h')) return amount * 3600;
    if (unit.startsWith('m')) return amount * 60;
    return amount;
};

export const isDailyGeminiRequestQuota = (msg) => {
    const text = String(msg || '');
    if (!text || MINUTE_LIMIT.test(text)) return false;
    if (DAILY_REQUEST.test(text)) return true;
    if (/per[_ ]?day/i.test(text) && /request/i.test(text) && !/token/i.test(text)) return true;
    const delay = retryDelaySeconds(text);
    return delay != null && delay >= 30 * 60 && /request/i.test(text) && !/token/i.test(text);
};

const PACIFIC = 'America/Los_Angeles';

const zoneParts = (date, timeZone) => {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const bag = {};
    for (const part of fmt.formatToParts(date)) {
        if (part.type !== 'literal') bag[part.type] = part.value;
    }
    return bag;
};

const wallTimeToUtc = (year, month, day, hour, minute, second, timeZone) => {
    const guess = Date.UTC(year, month - 1, day, hour, minute, second);
    const seen = zoneParts(new Date(guess), timeZone);
    const seenAsUtc = Date.UTC(
        Number(seen.year),
        Number(seen.month) - 1,
        Number(seen.day),
        Number(seen.hour) % 24,
        Number(seen.minute),
        Number(seen.second),
    );
    return guess - (seenAsUtc - guess);
};

// Free-tier RPD resets at midnight Pacific. No Gemini call can ask whether it reset.
export const nextGeminiDailyReset = (now = new Date()) => {
    const instant = now instanceof Date ? now : new Date(now);
    const parts = zoneParts(instant, PACIFIC);
    const nextDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
    return wallTimeToUtc(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth() + 1,
        nextDay.getUTCDate(),
        0, 0, 0,
        PACIFIC,
    );
};

export const vietnamClockLabel = (ms) => {
    const parts = zoneParts(new Date(ms), 'Asia/Ho_Chi_Minh');
    const hour = String(Number(parts.hour) % 24).padStart(2, '0');
    return `${hour}:${parts.minute} ngày ${parts.day}/${parts.month}`;
};

export const activeDailyExhausted = (exhausted, now = Date.now()) => {
    const t = now instanceof Date ? now.getTime() : Number(now);
    const active = new Map();
    for (const [model, until] of exhausted) {
        if (Number(until) > t) active.set(model, Number(until));
    }
    return active;
};

export const dailyQuotaKey = (keyId, model) => `${keyId}\0${model}`;

export class GeminiKeysExhaustedError extends Error {
    constructor() {
        super('all Gemini detail keys exceeded daily quota');
        this.name = 'GeminiKeysExhaustedError';
    }
}

export const detailStopReason = (models, keyIds, dailyExhausted, videoOverload, now = Date.now()) => {
    const overloaded = videoOverload instanceof Set ? videoOverload : new Set(videoOverload || []);
    const pending = (Array.isArray(models) ? models : []).filter((model) => !overloaded.has(model));
    if (!pending.length) return 'overload';
    const open = pending.some((model) => usableDetailKeys(model, keyIds, dailyExhausted, now).length > 0);
    return open ? '' : 'daily';
};

export const usableDetailKeys = (model, keyIds, dailyExhausted, now = Date.now()) => {
    const daily = activeDailyExhausted(dailyExhausted, now);
    return (Array.isArray(keyIds) ? keyIds : []).filter((keyId) => keyId && !daily.has(dailyQuotaKey(keyId, model)));
};

export const detailModelsForPart = (models, dailyExhausted, videoOverload, now = Date.now()) => {
    const daily = activeDailyExhausted(dailyExhausted, now);
    const overloaded = videoOverload instanceof Set ? videoOverload : new Set(videoOverload || []);
    return (Array.isArray(models) ? models : []).filter((model) => !daily.has(model) && !overloaded.has(model));
};
