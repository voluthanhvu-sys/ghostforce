import test from 'node:test';
import assert from 'node:assert/strict';
import { runGoogleSttChunkWithRetry } from '../server/google-stt-retry.js';

const run = (request, extra = {}) => {
  const waits = [];
  return runGoogleSttChunkWithRetry({
    request,
    wait: async (ms) => { waits.push(ms); },
    ...extra,
  }).then((result) => ({ result, waits }));
};

test('Google STT chunk succeeds without retry', async () => {
  const { result, waits } = await run(async () => ({ ok: true, status: 200, words: ['a'] }));
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.deepEqual(waits, []);
});

test('Google STT chunk retries a fetch failure then succeeds', async () => {
  let calls = 0;
  const { result, waits } = await run(async () => {
    calls += 1;
    if (calls === 1) throw new Error('fetch failed');
    return { ok: true, status: 200 };
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test('Google STT chunk retries HTTP 429 then succeeds', async () => {
  let calls = 0;
  const { result } = await run(async () => (++calls === 1
    ? { ok: false, status: 429 }
    : { ok: true, status: 200 }));
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('Google STT chunk skips exhausted HTTP 5xx', async () => {
  let calls = 0;
  const { result, waits } = await run(async () => {
    calls += 1;
    return { ok: false, status: 503 };
  });
  assert.equal(result.skipped, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2000, 5000]);
});

test('Google STT chunk skips permanent HTTP 4xx without retry', async () => {
  let calls = 0;
  const { result } = await run(async () => {
    calls += 1;
    return { ok: false, status: 400 };
  });
  assert.equal(result.permanent, true);
  assert.equal(calls, 1);
});

test('late Google STT chunk failure preserves earlier accumulated words', async () => {
  const words = [];
  const requests = [
    async () => ({ ok: true, status: 200, words: ['early'] }),
    async () => { throw new Error('fetch failed'); },
    async () => ({ ok: true, status: 200, words: ['later'] }),
  ];
  for (const request of requests) {
    const { result } = await run(request);
    if (result.ok) words.push(...result.response.words);
  }
  assert.deepEqual(words, ['early', 'later']);
});

test('Google STT cancellation aborts immediately', async () => {
  let calls = 0;
  await assert.rejects(
    runGoogleSttChunkWithRetry({
      request: async () => { calls += 1; throw new Error('cancelled'); },
      wait: async () => {},
      isCancelled: () => true,
    }),
    /cancelled/,
  );
  assert.equal(calls, 0);
});
