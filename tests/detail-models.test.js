import test from 'node:test';
import assert from 'node:assert/strict';
import { orderDetailModels, createOverloadCache, DETAIL_MODEL_LADDER } from '../server/detail-models.js';

test('the default Detail order starts at the measured-safe lite model', () => {
    assert.equal(orderDetailModels('gemini-3.8-flash', 'safe')[0], 'gemini-3.5-flash-lite');
    assert.deepEqual(orderDetailModels(null, 'safe'), DETAIL_MODEL_LADDER);
});

test('quality mode tries the chosen model first without duplicating it', () => {
    const order = orderDetailModels('gemini-3.8-flash', 'quality');
    assert.equal(order[0], 'gemini-3.8-flash');
    assert.equal(order.filter((model) => model === 'gemini-3.8-flash').length, 1);
    assert.ok(order.includes('gemini-3.5-flash-lite'));
    // A model outside the ladder keeps the whole ladder as the fallback list.
    const custom = orderDetailModels('gemini-2.5-pro', 'quality');
    assert.equal(custom[0], 'gemini-2.5-pro');
    assert.equal(new Set(custom).size, custom.length);
});

test('only mode returns just the chosen model and falls back to the ladder when empty', () => {
    assert.deepEqual(orderDetailModels('gemini-3.8-flash', 'only'), ['gemini-3.8-flash']);
    assert.deepEqual(orderDetailModels('', 'only'), DETAIL_MODEL_LADDER);
});

test('the overload cache skips a model for the TTL and forgets it afterwards', () => {
    let clock = 1_000_000;
    const cache = createOverloadCache({ ttlMs: 600_000, now: () => clock });
    assert.equal(cache.isOverloaded('gemini-3.8-flash'), false);
    cache.markOverloaded('gemini-3.8-flash');
    assert.equal(cache.isOverloaded('gemini-3.8-flash'), true);
    assert.deepEqual(cache.busy(['gemini-3.8-flash', 'gemini-3.5-flash-lite']), ['gemini-3.8-flash']);
    clock += 599_000;
    assert.equal(cache.isOverloaded('gemini-3.8-flash'), true);
    clock += 2_000;
    assert.equal(cache.isOverloaded('gemini-3.8-flash'), false);
    cache.markOverloaded('  ');
    assert.equal(cache.isOverloaded(''), false);
});

test('the overload cache is shared state: one mark hides the model everywhere', () => {
    const cache = createOverloadCache({ ttlMs: 60_000 });
    cache.markOverloaded('gemini-3.6-flash');
    // Any later caller (another part, another video) sees the skip immediately.
    assert.equal(cache.isOverloaded('gemini-3.6-flash'), true);
    cache.clear();
    assert.equal(cache.isOverloaded('gemini-3.6-flash'), false);
});
