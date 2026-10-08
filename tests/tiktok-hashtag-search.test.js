import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHashtag } from '../server/tiktok-hashtag-search.js';

test('hashtag input accepts Unicode tags and rejects invalid or excessive values', () => {
  assert.equal(normalizeHashtag(' #ẩm_thực '), 'ẩm_thực');
  assert.equal(normalizeHashtag(''), null);
  assert.equal(normalizeHashtag('a b'), null);
  assert.equal(normalizeHashtag('a'.repeat(81)), null);
});
