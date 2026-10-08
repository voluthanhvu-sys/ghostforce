// Detail model ordering + overload memory for the Gemini API-key path.
//
// Why the default order starts at the LITE model: the 2026-09-23 eleven-video
// log (56 accepted Detail plans) measured gemini-3.5-flash-lite answering 41
// plans with 0 overload lines, gemini-3.5-flash 11 plans with 10 overloads, and
// gemini-3.8-flash / 3.6-flash / 3.7-flash 2 / 2 / 0 plans against 11 overloads
// each. Putting a 3.8-class model first buys quality only when it happens to be
// free; when it is busy, every part pays a failed call and the ladder walks down
// anyway. `quality` mode is for the operator who wants to try, and it is cheap
// because of the overload memory below.

export const DETAIL_MODEL_LADDER = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
];

// mode: 'safe' (measured ladder, default) | 'quality' (preferred first, then the
// ladder) | 'only' (the preferred model alone, no down-step).
export const orderDetailModels = (preferred = null, mode = 'safe') => {
    const wanted = String(preferred || '').trim();
    if (mode === 'only') return wanted ? [wanted] : [...DETAIL_MODEL_LADDER];
    const list = [];
    const push = (value) => {
        const name = String(value || '').trim();
        if (name && !list.includes(name)) list.push(name);
    };
    if (mode === 'quality') push(wanted);
    for (const model of DETAIL_MODEL_LADDER) push(model);
    return list;
};

// Process-wide memory: a model that just answered "high demand" is skipped by
// every job for a while, instead of being retried once per part per video (the
// 2026-09-23 log showed a single video spending ~7 minutes re-calling models
// that had already refused). The TTL is a server-run lifetime, like the other
// per-process skips: restarting the server tries everything again.
export const createOverloadCache = ({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) => {
    const map = new Map();
    const until = (model) => Number(map.get(String(model || '').trim()) || 0);
    const isOverloaded = (model) => until(model) > now();
    return {
        isOverloaded,
        until,
        markOverloaded(model) {
            const name = String(model || '').trim();
            if (name) map.set(name, now() + ttlMs);
        },
        busy(models) {
            return (Array.isArray(models) ? models : []).filter(isOverloaded);
        },
        clear() {
            map.clear();
        },
    };
};
