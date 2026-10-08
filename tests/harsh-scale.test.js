import test from 'node:test';
import assert from 'node:assert/strict';
import { HARSH_CRF, HARSH_LONG_SIDE, harshVideoFilter } from '../server/harsh-scale.js';

test('harsh proxy caps the long side at 720 and does not upscale', () => {
    assert.equal(HARSH_LONG_SIDE, 720);
    assert.equal(HARSH_CRF, '30');
    const filter = harshVideoFilter();
    assert.match(filter, /min\(720,iw\)/);
    assert.match(filter, /min\(720,ih\)/);
    assert.match(filter, /force_divisible_by=2/);
    assert.doesNotMatch(filter, /scale=\d+:\d+/);
});

test('harsh proxy keeps an even long side when asked', () => {
    assert.match(harshVideoFilter(721), /min\(720,iw\)/);
    assert.match(harshVideoFilter(640), /min\(640,iw\)/);
});
