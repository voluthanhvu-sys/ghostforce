import test from 'node:test';
import assert from 'node:assert/strict';
import {
    VND_PER_USD,
    geminiPriceFor,
    usageFromMetadata,
    addUsage,
    usageCostUsd,
    usdToVnd,
    summarizeCost,
    formatVnd,
} from '../server/gemini-cost.js';

test('cached prompt tokens are split out of the input count', () => {
    const usage = usageFromMetadata({
        promptTokenCount: 6245,
        cachedContentTokenCount: 3516,
        candidatesTokenCount: 1952,
        thoughtsTokenCount: 0,
    });
    assert.deepEqual(usage, { inputTokens: 2729, cachedInputTokens: 3516, outputTokens: 1952 });
});

test('thinking tokens are billed as output', () => {
    const usage = usageFromMetadata({ promptTokenCount: 10, candidatesTokenCount: 100, thoughtsTokenCount: 900 });
    assert.equal(usage.outputTokens, 1000);
});

test('a missing or negative cache count cannot exceed the prompt', () => {
    assert.equal(usageFromMetadata({ promptTokenCount: 100 }).cachedInputTokens, 0);
    assert.equal(usageFromMetadata({ promptTokenCount: 100, cachedContentTokenCount: 500 }).inputTokens, 0);
});

test('3.8 Flash prices match the published table', () => {
    const price = geminiPriceFor('gemini-3.8-flash');
    assert.equal(price.input, 0.75);
    assert.equal(price.output, 3.75);
    assert.equal(price.cachedInput, 0.075);
});

test('one million input tokens of 3.8 Flash costs 0.75 USD', () => {
    const usd = usageCostUsd('gemini-3.8-flash', { inputTokens: 1e6, outputTokens: 0 });
    assert.equal(Math.round(usd * 1e6) / 1e6, 0.75);
});

test('cached input is billed at the cache-read rate', () => {
    const fresh = usageCostUsd('gemini-3.8-flash', { inputTokens: 1e6 });
    const cached = usageCostUsd('gemini-3.8-flash', { cachedInputTokens: 1e6 });
    assert.ok(cached < fresh);
    assert.equal(Math.round(cached * 1e6) / 1e6, 0.075);
});

test('an unknown model returns null instead of a silent zero', () => {
    assert.equal(geminiPriceFor('gemini-9.9-ultra'), null);
    assert.equal(usageCostUsd('gemini-9.9-ultra', { inputTokens: 1000 }), null);
});

test('summarizeCost totals the priced calls and names unpriced models', () => {
    const summary = summarizeCost([
        { model: 'gemini-3.8-flash', label: 'Detail 1/3', inputTokens: 12982, outputTokens: 2649 },
        { model: 'gemini-3.8-flash', label: 'Detail 2/3', inputTokens: 5000, cachedInputTokens: 3000, outputTokens: 1000 },
        { model: 'gemini-3.5-flash-lite', label: 'Detail 3/3', inputTokens: 1000, outputTokens: 500 },
        { model: 'gemini-9.9-ultra', label: 'Critic', inputTokens: 1000, outputTokens: 100 },
    ]);
    assert.equal(summary.calls, 4);
    assert.equal(summary.pricedCalls, 3);
    assert.deepEqual(summary.unknownModels, ['gemini-9.9-ultra']);
    assert.equal(summary.byModel.find((m) => m.model === 'gemini-3.8-flash').calls, 2);
    assert.equal(summary.totalTokens, 12982 + 2649 + 5000 + 3000 + 1000 + 1000 + 500 + 1000 + 100);
    assert.ok(summary.totalUsd > 0);
    assert.equal(Math.round(summary.totalVnd * 100) / 100, Math.round(usdToVnd(summary.totalUsd) * 100) / 100);
    assert.equal(VND_PER_USD, 25954);
    assert.equal(usdToVnd(1), 25954);
});

test('a measured 134s part lands at a sane dong amount (guards a 1000x unit slip)', () => {
    // Real measurement 2026-10-03: gemini-3.8-flash read the 18-152s part with
    // 12,982 input and 2,649 output tokens.
    const usd = usageCostUsd('gemini-3.8-flash', { inputTokens: 12982, outputTokens: 2649 });
    const vnd = usdToVnd(usd);
    assert.equal(Math.round(vnd), 511);
    assert.ok(vnd > 100 && vnd < 5000, `expected a few hundred dong, got ${vnd}`);
});

test('formatVnd keeps sub-dong amounts visible', () => {
    assert.equal(formatVnd(0), '0đ');
    assert.equal(formatVnd(0.42), '0.42đ');
    assert.equal(formatVnd(1530.4), '1.530đ');
});
