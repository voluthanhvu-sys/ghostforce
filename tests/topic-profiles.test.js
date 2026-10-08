import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopic, topicProfile, resolveTopic, TOPIC_KEYS, TOPIC_MIN_CONFIDENCE, topicClassifierPrompt } from '../server/topic-profiles.js';

test('normalizeTopic maps model labels onto known keys and never guesses', () => {
  assert.equal(normalizeTopic('cops'), 'cops');
  assert.equal(normalizeTopic('Police Bodycam Arrest'), 'cops');
  assert.equal(normalizeTopic('động vật'), 'animals');
  assert.equal(normalizeTopic('podcast interview'), 'podcast');
  assert.equal(normalizeTopic('product review'), 'product');
  assert.equal(normalizeTopic('something nobody expected'), 'generic');
  assert.equal(normalizeTopic(''), 'generic');
});

test('every known topic has a label and an addon (generic has none)', () => {
  for (const key of TOPIC_KEYS) {
    const profile = topicProfile(key);
    assert.equal(profile.key, key);
    assert.ok(profile.label.length > 0);
    if (key === 'generic') assert.equal(profile.addon, '');
    else {
      assert.ok(profile.addon.length > 40, `${key} needs a real addon`);
      assert.ok(!/corner window/i.test(profile.addon), `${key} still asks for a retired corner window`);
    }
  }
});

test('resolveTopic trusts a confident label and falls back when unsure', () => {
  const sure = resolveTopic({ topic: 'cops', confidence: 0.9 });
  assert.equal(sure.key, 'cops');
  assert.equal(sure.pinned, false);
  const unsure = resolveTopic({ topic: 'cops', confidence: TOPIC_MIN_CONFIDENCE - 0.2 });
  assert.equal(unsure.key, 'generic');
  const missing = resolveTopic({ topic: 'animals' });
  assert.equal(missing.key, 'animals');            // no confidence given: accept a known label
  const nonsense = resolveTopic({ topic: 'zzz', confidence: 1 });
  assert.equal(nonsense.key, 'generic');
});

test('a pinned topic wins over the model and over a low confidence', () => {
  const pinned = resolveTopic({ topic: 'podcast', confidence: 0.1 }, 'animals');
  assert.equal(pinned.key, 'animals');
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.confidence, 1);
  // A pinned value that is not a real topic is ignored.
  assert.equal(resolveTopic({ topic: 'cops', confidence: 0.9 }, 'not-a-topic').key, 'cops');
});

test('the classifier prompt asks for one label plus confidence', () => {
  const prompt = topicClassifierPrompt();
  assert.ok(/Return JSON only/.test(prompt));
  assert.ok(prompt.includes('"topic"') && prompt.includes('"confidence"'));
  assert.ok(/Do not guess/.test(prompt));
});
