// Gemini API-key spend accounting for one Edit job.
//
// Why this exists: the operator wants the money a finished video cost, and a
// number that is not derived from the provider's own `usageMetadata` is only a
// guess. Every successful call on the API-key path records what Gemini reported
// (prompt, cached, candidate and thinking tokens) and the run report converts
// that with the published price list below.
//
// Prices are USD per 1,000,000 tokens, paid tier, read from
// https://ai.google.dev/gemini-api/docs/pricing on 2026-10-03. 3.8/3.7/3.6 Flash
// are on an introductory rate through 2026-12-31 and double on 2027-01-01, so
// only this table changes when that happens. Free-tier keys are charged 0 USD
// (the call still consumes the free quota), which the report states separately.
//
// Thinking tokens are billed as output, so they are added to the output count.
// Requests that fail (429/503/parse) are not billed and are never recorded.

// 1 USD in VND. Checked against open.er-api.com on 2026-10-03 (25,953.96), and
// kept as a plain number so the report is reproducible. A 1000x slip here is the
// easiest way to make every cost wrong, so tests/gemini-cost.test.js pins both
// this constant and a real part's VND total.
export const VND_PER_USD = 25954;

export const GEMINI_PRICE_TABLE = {
    'gemini-3.8-flash': { input: 0.75, output: 3.75, cachedInput: 0.075, note: 'giá ưu đãi đến 31/12/2026' },
    'gemini-3.7-flash': { input: 0.75, output: 3.75, cachedInput: 0.075, note: 'giá ưu đãi đến 31/12/2026' },
    'gemini-3.6-flash': { input: 0.75, output: 3.75, cachedInput: 0.075, note: 'giá ưu đãi đến 31/12/2026' },
    'gemini-3.5-flash': { input: 1.5, output: 9, cachedInput: 0.15, note: '' },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cachedInput: 0.03, note: '' },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cachedInput: 0.025, note: 'audio tính giá riêng' },
};

export const geminiPriceFor = (model) => GEMINI_PRICE_TABLE[String(model || '').trim().toLowerCase()] || null;

export const emptyUsage = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });

// A model can report thinking tokens separately; they share the output price.
// cachedContentTokenCount is part of promptTokenCount, so it is split out to be
// billed at the cache-read rate.
export const usageFromMetadata = (usage) => {
    const prompt = Number(usage?.promptTokenCount) || 0;
    const cached = Math.max(0, Math.min(prompt, Number(usage?.cachedContentTokenCount) || 0));
    return {
        inputTokens: Math.max(0, prompt - cached),
        cachedInputTokens: cached,
        outputTokens: (Number(usage?.candidatesTokenCount) || 0) + (Number(usage?.thoughtsTokenCount) || 0),
    };
};

export const addUsage = (a, b) => ({
    inputTokens: (Number(a?.inputTokens) || 0) + (Number(b?.inputTokens) || 0),
    cachedInputTokens: (Number(a?.cachedInputTokens) || 0) + (Number(b?.cachedInputTokens) || 0),
    outputTokens: (Number(a?.outputTokens) || 0) + (Number(b?.outputTokens) || 0),
});

export const usageTokens = (usage) => (Number(usage?.inputTokens) || 0)
    + (Number(usage?.cachedInputTokens) || 0)
    + (Number(usage?.outputTokens) || 0);

// Prices are per 1M tokens. Unknown models return null instead of 0 so the
// report can say "chưa có giá" rather than silently understating the spend.
export const usageCostUsd = (model, usage) => {
    const price = geminiPriceFor(model);
    if (!price) return null;
    const input = (Number(usage?.inputTokens) || 0) / 1e6 * price.input;
    const cached = (Number(usage?.cachedInputTokens) || 0) / 1e6 * price.cachedInput;
    const output = (Number(usage?.outputTokens) || 0) / 1e6 * price.output;
    return input + cached + output;
};

export const usdToVnd = (usd) => (Number(usd) || 0) * VND_PER_USD;

// `entries` is the job's list of successful calls:
//   { model, label, inputTokens, cachedInputTokens, outputTokens }
export const summarizeCost = (entries) => {
    const list = Array.isArray(entries) ? entries : [];
    const byModel = new Map();
    const unknownModels = new Set();
    let totalUsd = 0;
    let pricedCalls = 0;
    for (const entry of list) {
        const model = String(entry?.model || '').trim();
        const usage = {
            inputTokens: entry?.inputTokens,
            cachedInputTokens: entry?.cachedInputTokens,
            outputTokens: entry?.outputTokens,
        };
        const account = byModel.get(model) || { model, calls: 0, ...emptyUsage() };
        account.calls += 1;
        const summed = addUsage(account, usage);
        account.inputTokens = summed.inputTokens;
        account.cachedInputTokens = summed.cachedInputTokens;
        account.outputTokens = summed.outputTokens;
        const usd = usageCostUsd(model, usage);
        if (usd == null) unknownModels.add(model || '(không rõ)');
        else {
            account.usd = (account.usd || 0) + usd;
            totalUsd += usd;
            pricedCalls += 1;
        }
        byModel.set(model, account);
    }
    return {
        calls: list.length,
        pricedCalls,
        totalUsd,
        totalVnd: usdToVnd(totalUsd),
        totalTokens: list.reduce((sum, entry) => sum + usageTokens(entry), 0),
        byModel: [...byModel.values()].sort((a, b) => (b.usd || 0) - (a.usd || 0)),
        unknownModels: [...unknownModels],
    };
};

export const formatVnd = (vnd) => {
    const value = Number(vnd) || 0;
    if (value > 0 && value < 1) return `${value.toFixed(2)}đ`;
    return `${Math.round(value).toLocaleString('vi-VN')}đ`;
};
