import test from 'node:test';
import assert from 'node:assert/strict';
import { validSpeakerTrackPoints } from '../server/editor-plan.js';
import { mapDiarizationEvidence, fallbackSpeechForAmbiguousTurns } from '../server/local-listen-map.js';

const range = [{ start: 0, end: 20 }];

test('globally clear cluster with matching local evidence stays unchanged', () => {
  const turns = [
    { start: 0, end: 2, speakerId: 'SPEAKER_00' },
    { start: 3, end: 5, speakerId: 'SPEAKER_00' },
  ];
  const intervals = [{ start: 0, end: 5, who: 'Cody' }];
  const mapped = mapDiarizationEvidence(turns, intervals, range);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.globalMappedClusters, 1);
  assert.equal(mapped.locallyValidatedTurns, 2);
  assert.equal(mapped.localOverrides, 0);
  assert.deepEqual(mapped.mappedTurns.map((x) => x.who), ['Cody', 'Cody']);
});

test('globally clear cluster is overridden by clear different local identity', () => {
  const turns = [
    { start: 0, end: 2, speakerId: 'SPEAKER_00' },
    { start: 2, end: 10, speakerId: 'SPEAKER_00' },
  ];
  const intervals = [
    { start: 0, end: 2, who: 'Penelope' },
    { start: 2, end: 10, who: 'Brooklyn Guy' },
  ];
  const mapped = mapDiarizationEvidence(turns, intervals, range);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.globalMappedClusters, 1);
  assert.equal(mapped.locallyValidatedTurns, 2);
  assert.equal(mapped.localOverrides, 1);
  assert.deepEqual(mapped.mappedTurns.map((x) => x.who), ['Penelope', 'Brooklyn Guy']);
});

test('locally ambiguous turn stays unresolved instead of inheriting the global cluster identity', () => {
  const turns = [
    { start: 0, end: 2, speakerId: 'SPEAKER_00' },
    { start: 2, end: 10, speakerId: 'SPEAKER_00' },
  ];
  const intervals = [
    { start: 0, end: 1, who: 'Penelope' },
    { start: 1, end: 10, who: 'Brooklyn Guy' },
  ];
  const mapped = mapDiarizationEvidence(turns, intervals, range);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.globalMappedClusters, 1);
  assert.equal(mapped.locallyValidatedTurns, 1);
  assert.equal(mapped.ambiguousTurns.length, 1);
  assert.deepEqual(mapped.ambiguousTurns[0], turns[0]);
  assert.deepEqual(mapped.mappedTurns.map((x) => x.who), ['Brooklyn Guy']);
});

test('turn remains unresolved when both local and global mappings are ambiguous', () => {
  const turns = [
    { start: 0, end: 2, speakerId: 'SPEAKER_00' },
    { start: 2, end: 4, speakerId: 'SPEAKER_00' },
    { start: 4, end: 6, speakerId: 'SPEAKER_00' },
  ];
  const intervals = [
    { start: 0, end: 2, who: 'Cody' },
    { start: 2, end: 4, who: 'Junior' },
    { start: 4, end: 5, who: 'Cody' },
    { start: 5, end: 6, who: 'Junior' },
  ];
  const mapped = mapDiarizationEvidence(turns, intervals, range);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.globalMappedClusters, 0);
  assert.equal(mapped.locallyValidatedTurns, 2);
  assert.equal(mapped.ambiguousTurns.length, 1);
  assert.deepEqual(mapped.ambiguousTurns[0], turns[2]);
});

test('fallback speech is restricted to unresolved time and excludes local mapped ranges', () => {
  const fallback = [{ t: 1, end: 4, who: 'Junior', text: 'fallback' }];
  const ambiguous = [{ start: 2, end: 4, speakerId: 'SPEAKER_00' }];
  const mapped = [{ start: 0, end: 3, speakerId: 'SPEAKER_00', who: 'Cody' }];
  const result = fallbackSpeechForAmbiguousTurns(fallback, ambiguous, mapped);
  assert.deepEqual(result.map((x) => [x.t, x.end, x.who]), [[3, 4, 'Junior']]);
});

test('invalid PLAN track identity does not participate in Local Listen mapping', () => {
  const track = [{ t: 1, cx: 0.5, cy: 0.4, who: 'Puppet laughs at the TV and heads to bed' }];
  const valid = validSpeakerTrackPoints(track);
  const mapped = mapDiarizationEvidence(
    [{ start: 0, end: 2, speakerId: 'SPEAKER_00' }],
    valid,
    [{ start: 0, end: 2 }],
  );
  assert.deepEqual(valid, []);
  assert.equal(mapped.ok, false);
});
