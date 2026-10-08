import test from 'node:test';
import assert from 'node:assert/strict';
import { activeDailyExhausted, dailyQuotaKey, detailModelsForPart, detailStopReason, geminiErrorText, isDailyGeminiRequestQuota, nextGeminiDailyReset, usableDetailKeys, vietnamClockLabel } from '../server/gemini-detail-quota.js';

const dailyBody = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{
        quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
        quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
      }],
    }],
  },
};

const minuteBody = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
    details: [{
      violations: [{
        quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
        quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
      }],
    }, {
      retryDelay: '16.5s',
    }],
  },
};

test('daily request quota id is remembered', () => {
  const text = geminiErrorText(dailyBody, 429);
  assert.match(text, /GenerateRequestsPerDayPerProjectPerModel-FreeTier/);
  assert.equal(isDailyGeminiRequestQuota(text), true);
});

test('per-minute request quota on the same metric is not a daily cap', () => {
  const text = geminiErrorText(minuteBody, 429);
  assert.match(text, /free_tier_requests/);
  assert.equal(isDailyGeminiRequestQuota(text), false);
});

test('a quota message without a per-day id is not remembered', () => {
  const text = geminiErrorText({
    error: { message: 'You exceeded your current quota, please check your plan and billing details.' },
  }, 429);
  assert.equal(isDailyGeminiRequestQuota(text), false);
  assert.equal(isDailyGeminiRequestQuota('This model is currently experiencing high demand. Please try again later.'), false);
  assert.equal(isDailyGeminiRequestQuota('Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5'), false);
});

test('a multi-hour retry on a request quota counts as the daily cap', () => {
  assert.equal(isDailyGeminiRequestQuota('Quota exceeded for requests. Please retry in 23 hours.'), true);
  assert.equal(isDailyGeminiRequestQuota('RESOURCE_EXHAUSTED retryDelay 45s'), false);
});

test('daily request skip expires at the next Pacific midnight', () => {
  const duringDay = new Date('2026-09-22T08:00:00Z');
  const reset = nextGeminiDailyReset(duringDay);
  assert.equal(reset, Date.parse('2026-09-23T07:00:00Z'));
  assert.equal(vietnamClockLabel(reset), '14:00 ngày 23/09');

  const spring = nextGeminiDailyReset(new Date('2026-03-08T04:00:00Z'));
  assert.equal(spring, Date.parse('2026-03-08T08:00:00Z'));
  const afterSpring = nextGeminiDailyReset(new Date('2026-03-08T17:00:00Z'));
  assert.equal(afterSpring, Date.parse('2026-03-09T07:00:00Z'));
  const afterFall = nextGeminiDailyReset(new Date('2026-11-01T11:00:00Z'));
  assert.equal(afterFall, Date.parse('2026-11-02T08:00:00Z'));
});

test('detail pauses only when every remaining model is out of daily quota on every key', () => {
  const models = ['gemini-3.8-flash', 'gemini-3.5-flash'];
  const keys = ['key-a', 'key-b'];
  const until = Date.now() + 60_000;
  const daily = new Map(models.flatMap((model) => keys.map((key) => [dailyQuotaKey(key, model), until])));
  assert.equal(detailStopReason(models, keys, daily, new Set()), 'daily');
  assert.equal(detailStopReason(models, keys, new Map(), new Set(models)), 'overload');
  daily.delete(dailyQuotaKey('key-b', 'gemini-3.5-flash'));
  assert.equal(detailStopReason(models, keys, daily, new Set(['gemini-3.8-flash'])), '');
});

test('a daily cap blocks one key and leaves the same model open on the next key', () => {
  const until = Date.now() + 60_000;
  const daily = new Map([[dailyQuotaKey('key-a', 'gemini-3.8-flash'), until]]);
  assert.deepEqual(usableDetailKeys('gemini-3.8-flash', ['key-a', 'key-b'], daily), ['key-b']);
  assert.deepEqual(usableDetailKeys('gemini-3.7-flash', ['key-a', 'key-b'], daily), ['key-a', 'key-b']);
});

test('overload skip lasts for this video and a new video starts at the top again', () => {
  const models = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'];
  const daily = new Map();
  const thisVideo = new Set(['gemini-3.8-flash']);
  assert.deepEqual(detailModelsForPart(models, daily, thisVideo), ['gemini-3.7-flash', 'gemini-3.5-flash']);
  assert.deepEqual(detailModelsForPart(models, daily, new Set()), models);
  daily.set('gemini-3.7-flash', Date.now() + 60_000);
  assert.deepEqual(detailModelsForPart(models, daily, thisVideo), ['gemini-3.5-flash']);
});

test('a model is called again once its daily reset time has passed', () => {
  const reset = Date.parse('2026-09-23T07:00:00Z');
  const exhausted = new Map([['gemini-3.8-flash', reset]]);
  assert.equal(activeDailyExhausted(exhausted, reset - 1).has('gemini-3.8-flash'), true);
  assert.equal(activeDailyExhausted(exhausted, reset).has('gemini-3.8-flash'), false);
});
