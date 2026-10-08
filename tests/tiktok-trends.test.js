import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TREND_LIMITATION,
  TREND_MIN_DURATIONS,
  TREND_PERIODS,
  TREND_VIDEO_LIMITS,
  aggregateKeywords,
  buildTrendResult,
  createTrendService,
  extractModernRouterData,
  filterVideosByMinViews,
  filterVideos,
  formatViewsVi,
  keysFromCaption,
  normalizeHashtagEntry,
  normalizeMinViews,
  normalizeMinDuration,
  normalizeMaxViews,
  quoteBigIds,
  normalizeTrendPeriod,
  normalizeTrendRegion,
  normalizeVideoEntry,
  normalizeVideoLimit,
  parseTrendFilterConfig,
  parseTrendPage,
  parseVideoOverview,
  periodDimensionFor,
} from '../server/tiktok-trends.js';

const HASHTAG_ITEM = {
  hashtagID: '7010556633352765441',
  hashtagName: 'tiktokshop99',
  industryIDs: ['22000000000'],
  popularityCurve: [
    { timestamp: '1787875200', value: 0 },
    { timestamp: '1787961600', value: 36.06456202150339 },
    { timestamp: '1788393600', value: 100 },
  ],
  publishCnt: '2092683',
  rankIndex: '1',
  vv: '3571114383',
};

const VIDEO_ITEM = {
  contentTags: [{ contentLabelID: '11010', contentLabelName: 'Food & Beverage' }],
  itemAuthorInfo: { handlerName: 'tientai11997', nickName: 'Tài Chelsea', bio: '', avatarURI: '' },
  itemAuthorMetrics: { followers: '210527' },
  itemInfo: {
    authorID: '7449709391898476560',
    contentType: 1,
    createTime: '1786622400',
    itemID: '7673371213716262165',
    title: 'Lá trầu, lá lốt #dola #ai #vn',
    videoURL: 'https://v58.tiktokcdn.com/video/x',
  },
  itemMetrics: {
    engagementRate: 0.004419392510556676,
    organicVideoViews: '9192933',
    sixSecondsVTR: 0.18150296086586518,
    videoViews: '127240565',
    videoViewsLifeTime: '134300696',
  },
};

function routerData({ config, hashtags, videos, overview }) {
  const queries = [];
  if (overview) {
    queries.push({ queryKey: ['popular', 'videoOverview', 'VN'], state: { data: overview } });
  }
  if (config) {
    queries.push({ queryKey: ['getTrendsFilterConfig'], state: { data: config } });
  }
  if (hashtags) {
    queries.push({
      queryKey: ['popular', 'hashtags', { period: 30 }],
      state: { data: { pages: [{ data: hashtags, pagination: {} }] } },
    });
  }
  if (videos) {
    queries.push({
      queryKey: ['popular', 'videos', { periodDimension: 5 }],
      state: { data: { pages: [{ entityInfos: videos, pagination: {} }] } },
    });
  }
  return {
    loaderData: {
      'creativeCenter/trends/(tab)/page': { dehydratedState: { mutations: [], queries } },
    },
  };
}

function pageHtml(data) {
  return `<!doctype html><html><body><script type="application/json" id="__MODERN_ROUTER_DATA__">${JSON.stringify(
    data
  )}</script></body></html>`;
}

const CONFIG = {
  hashtagCountry: ['US', 'JP', 'VN', 'TH', 'ID'],
  videoCountry: ['US', 'JP', 'VN', 'TH', 'ID'],
  videoContentTags: ['11010'],
  industry: ['22000000000'],
};

test('extractModernRouterData reads the SSR payload and tolerates bad input', () => {
  assert.equal(extractModernRouterData('<html>no payload</html>'), null);
  assert.equal(extractModernRouterData('<script id="__MODERN_ROUTER_DATA__">{oops</script>'), null);
  const data = routerData({ hashtags: [HASHTAG_ITEM] });
  assert.deepEqual(extractModernRouterData(pageHtml(data)), data);
});

test('parseTrendFilterConfig lists the supported countries', () => {
  const config = parseTrendFilterConfig(routerData({ config: CONFIG }));
  assert.deepEqual(config.hashtagCountry, ['US', 'JP', 'VN', 'TH', 'ID']);
  assert.deepEqual(config.videoCountry, ['US', 'JP', 'VN', 'TH', 'ID']);
  assert.equal(parseTrendFilterConfig(routerData({ hashtags: [HASHTAG_ITEM] })), null);
});

test('normalizeHashtagEntry maps posts and views', () => {
  const entry = normalizeHashtagEntry(HASHTAG_ITEM);
  assert.equal(entry.kind, 'hashtag');
  assert.equal(entry.name, 'tiktokshop99');
  assert.equal(entry.rank, 1);
  assert.equal(entry.posts, 2092683);
  assert.equal(entry.views, 3571114383);
  assert.equal(entry.popularity, 100);
  assert.deepEqual(entry.industryIds, ['22000000000']);
  assert.equal(normalizeHashtagEntry({ hashtagName: '#' }), null);
  assert.equal(normalizeHashtagEntry(null), null);
});

test('keysFromCaption splits hashtags and keeps Vietnamese words', () => {
  const keys = keysFromCaption('Lá trầu, lá lốt #dola #AI #vn 2024 như này');
  assert.deepEqual(keys.hashtags, ['dola', 'ai', 'vn']);
  assert.ok(keys.keywords.includes('trầu'));
  assert.ok(keys.keywords.includes('lốt'));
  assert.ok(keys.keywords.includes('này'));
  assert.ok(!keys.keywords.includes('2024'), 'pure numbers are not keywords');
  assert.ok(!keys.keywords.includes('như'), 'stop words are dropped');
});

test('normalizeVideoEntry builds a watchable record', () => {
  const entry = normalizeVideoEntry(VIDEO_ITEM, 'VN');
  assert.equal(entry.id, '7673371213716262165');
  assert.equal(entry.url, 'https://www.tiktok.com/@tientai11997/video/7673371213716262165');
  assert.equal(entry.authorHandle, 'tientai11997');
  assert.equal(entry.authorFollowers, 210527);
  assert.equal(entry.views, 127240565);
  assert.equal(entry.region, 'VN');
  assert.equal(entry.createdAt, '2026-08-13T12:00:00.000Z');
  assert.deepEqual(entry.categories, ['Food & Beverage']);
  assert.deepEqual(entry.hashtags, ['dola', 'ai', 'vn']);
  assert.equal(normalizeVideoEntry({ itemInfo: {} }, 'VN'), null);
});

test('parseTrendPage picks the query that matches the requested tab', () => {
  const html = pageHtml(routerData({ config: CONFIG, hashtags: [HASHTAG_ITEM], videos: [VIDEO_ITEM] }));
  const hashtagPage = parseTrendPage(html, 'hashtag', 'VN');
  assert.equal(hashtagPage.entries.length, 1);
  assert.equal(hashtagPage.entries[0].name, 'tiktokshop99');
  assert.deepEqual(hashtagPage.config.videoCountry, CONFIG.videoCountry);

  const videoPage = parseTrendPage(html, 'video', 'VN');
  assert.equal(videoPage.entries.length, 1);
  assert.equal(videoPage.entries[0].id, '7673371213716262165');

  assert.deepEqual(parseTrendPage('<html></html>', 'video', 'VN'), {
    config: null,
    entries: [],
    overview: null,
  });
});

test('region and period normalization keeps unsupported values sane', () => {
  assert.equal(normalizeTrendRegion('vn'), 'VN');
  assert.equal(normalizeTrendRegion('Vietnam'), 'VN');
  assert.equal(normalizeTrendRegion(undefined), 'VN');
  assert.equal(normalizeTrendPeriod(7), 7);
  assert.equal(normalizeTrendPeriod('30'), 30);
  assert.equal(normalizeTrendPeriod(120), 30, '120 is not offered by the free source');
  assert.deepEqual(TREND_PERIODS, [7, 30]);
  assert.equal(normalizeMinViews('50000'), 50000);
  assert.equal(normalizeMinViews(-5), 0);
  assert.equal(normalizeMinViews('abc'), 0);
  assert.deepEqual(TREND_MIN_DURATIONS, [0, 15, 30, 60, 180]);
  assert.equal(normalizeMinDuration('60'), 60);
  assert.equal(normalizeMinDuration(''), 0);
  assert.equal(normalizeMinDuration(-30), 0);
});

test('duration filter keeps only videos long enough and reports unknown lengths', () => {
  const base = normalizeVideoEntry(VIDEO_ITEM, 'VN');
  const short = { ...base, id: 'short', durationSec: 45 };
  const long = { ...base, id: 'long', durationSec: 95 };
  const unknown = { ...base, id: 'unknown', durationSec: null };

  assert.deepEqual(
    filterVideos([short, long, unknown], { minDurationSec: 60 }).map((v) => v.id),
    ['long'],
    'a duration filter drops short clips AND clips whose length is unknown'
  );
  assert.deepEqual(
    filterVideos([short, long, unknown], { minViews: 1000, minDurationSec: 60 }).map((v) => v.id),
    ['long']
  );

  const result = buildTrendResult({
    region: 'VN',
    period: 30,
    minViews: 0,
    minDurationSec: 60,
    hashtags: [normalizeHashtagEntry(HASHTAG_ITEM)],
    videos: [short, long, unknown],
    config: CONFIG,
    fetchedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(result.minDurationSec, 60);
  assert.deepEqual(result.videos.map((v) => v.id), ['long']);
  assert.equal(result.videosBeforeFilter, 3);
  assert.ok(result.limitations.some((line) => line.includes('không đọc được thời lượng')));
});

test('createTrendService probes each video length once and caches it', async () => {
  let probes = 0;
  const second = {
    ...VIDEO_ITEM,
    itemInfo: { ...VIDEO_ITEM.itemInfo, itemID: '9999999999999999999' },
  };
  const service = createTrendService({
    fetchImpl: async (url) => {
      const data = url.includes('/trends/video')
        ? routerData({ config: CONFIG, videos: [VIDEO_ITEM, second] })
        : routerData({ config: CONFIG, hashtags: [HASHTAG_ITEM] });
      return { ok: true, status: 200, text: async () => pageHtml(data) };
    },
    probeDuration: async () => {
      probes += 1;
      return 61.5;
    },
    ttlMs: 60000,
  });

  const long = await service.get({ region: 'VN', period: 30, minViews: 0, minDurationSec: 60 });
  assert.equal(long.videos.length, 2);
  assert.equal(long.videos[0].durationSec, 61.5);
  assert.equal(probes, 2);

  const all = await service.get({ region: 'VN', period: 30, minViews: 0, minDurationSec: 0 });
  assert.equal(all.videos.length, 2);
  assert.equal(all.minDurationSec, 0);
  assert.equal(probes, 2, 'the same clip is not probed twice');
});

test('min-view filter and keyword aggregation follow the video list', () => {
  const low = normalizeVideoEntry({ ...VIDEO_ITEM, itemMetrics: { ...VIDEO_ITEM.itemMetrics, videoViews: '5000' } }, 'VN');
  const high = normalizeVideoEntry(VIDEO_ITEM, 'VN');
  assert.deepEqual(filterVideosByMinViews([low, high], 0).length, 2);
  assert.deepEqual(filterVideosByMinViews([low, high], 100000).map((v) => v.id), [high.id]);

  const keywords = aggregateKeywords([high, high]);
  const dola = keywords.find((entry) => entry.name === 'dola');
  assert.equal(dola.videoCount, 2);
  assert.equal(dola.views, high.views * 2);
  assert.equal(keywords[0].views >= keywords[keywords.length - 1].views, true);
});

test('buildTrendResult reports the source limits honestly', () => {
  const videos = [normalizeVideoEntry(VIDEO_ITEM, 'VN')];
  const result = buildTrendResult({
    region: 'VN',
    period: 30,
    minViews: 0,
    hashtags: [normalizeHashtagEntry(HASHTAG_ITEM)],
    videos,
    config: CONFIG,
    fetchedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(result.regionLabel, 'Việt Nam');
  assert.equal(result.hashtags.length, 1);
  assert.equal(result.videos.length, 1);
  assert.ok(result.limitations.includes(TREND_LIMITATION));

  const unsupported = buildTrendResult({
    region: 'DE',
    period: 7,
    minViews: 0,
    hashtags: [],
    videos: [],
    config: CONFIG,
    fetchedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.ok(unsupported.limitations.some((line) => line.includes('không có danh sách video')));

  const emptyVideoRegion = buildTrendResult({
    region: 'US',
    period: 7,
    minViews: 0,
    hashtags: [],
    videos: [],
    config: CONFIG,
    fetchedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.ok(emptyVideoRegion.limitations.some((line) => line.includes('thử lại sau')));
});

test('createTrendService fetches both tabs, caches, and survives a dead video tab', async () => {
  const calls = [];
  const service = createTrendService({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/trends/video')) throw new Error('video tab down');
      return {
        ok: true,
        status: 200,
        text: async () => pageHtml(routerData({ config: CONFIG, hashtags: [HASHTAG_ITEM] })),
      };
    },
    ttlMs: 60000,
  });

  const first = await service.get({ region: 'vn', period: 30, minViews: 0 });
  assert.equal(first.region, 'VN');
  assert.equal(first.hashtags.length, 1);
  assert.equal(first.videos.length, 0);
  assert.ok(first.limitations.some((line) => line.includes('thử lại sau')));
  assert.equal(calls.length, 2);

  const second = await service.get({ region: 'VN', period: 30, minViews: 0 });
  assert.equal(calls.length, 2, 'cached run does not refetch');
  assert.equal(second.hashtags.length, 1);
});

test('createTrendService surfaces an upstream failure', async () => {
  const service = createTrendService({
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    ttlMs: 0,
  });
  await assert.rejects(() => service.get({ region: 'VN', period: 7, minViews: 0 }), /HTTP 503/);
});

test('period dimension, video limit and overview parsing follow the source contract', () => {
  assert.equal(periodDimensionFor(7), 3);
  assert.equal(periodDimensionFor(30), 5);
  assert.equal(periodDimensionFor(120), 5);
  assert.deepEqual(TREND_VIDEO_LIMITS, [20, 50, 100]);
  assert.equal(normalizeVideoLimit(undefined), 100);
  assert.equal(normalizeVideoLimit(50), 50);
  assert.equal(normalizeVideoLimit(5), 20, 'the source never returns fewer than 20');
  assert.equal(normalizeVideoLimit(5000), 100, 'capped at the documented maximum');

  const overview = parseVideoOverview(
    routerData({ overview: { lastWeeklyEndTimestamp: '1790467200', lastDailyEndTimestamp: '1' } })
  );
  assert.equal(overview.lastWeeklyEndTimestamp, '1790467200');
  assert.equal(overview.lastDailyEndTimestamp, '1');
  assert.equal(parseVideoOverview(routerData({ hashtags: [HASHTAG_ITEM] })), null);
});

test('createTrendService pulls the longer list from the list API when signed in', async () => {
  const manyItems = Array.from({ length: 40 }, (_, index) => ({
    ...VIDEO_ITEM,
    itemInfo: { ...VIDEO_ITEM.itemInfo, itemID: `item-${index}` },
  }));
  const calls = [];
  const service = createTrendService({
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('CreativeCenterGetTopContentsList')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ entityInfos: manyItems }) };
      }
      if (url.includes('/trends/video')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            pageHtml(routerData({ config: CONFIG, videos: [VIDEO_ITEM], overview: { lastWeeklyEndTimestamp: '1790467200' } })),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => pageHtml(routerData({ config: CONFIG, hashtags: [HASHTAG_ITEM] })),
      };
    },
    getCookieHeader: async () => 'sessionid_ads=1',
    probeDuration: async () => null,
    ttlMs: 60000,
  });

  const result = await service.get({ region: 'VN', period: 30, minViews: 0, limit: 20 });
  const listCall = calls.find((url) => url.includes('CreativeCenterGetTopContentsList'));
  assert.ok(listCall, 'the list API is used');
  assert.ok(listCall.includes('periodDimension=5'), '30 days maps to dimension 5');
  assert.ok(listCall.includes('periodEndTimestamp=1790467200'), 'uses the page timestamp');
  assert.ok(listCall.includes('limit=100'), 'always asks for the maximum pool');
  assert.equal(result.videosBeforeFilter, 40);
  assert.equal(result.videosFiltered, 40);
  assert.equal(result.videos.length, 20, 'display is capped by the requested limit');
  assert.equal(result.limit, 20);
});

test('long numeric ids survive parsing so watch links stay valid', () => {
  const raw =
    '{"entityInfos":[{"itemInfo":{"itemID":7673371213716262165,"authorID":7449709391898476560}}]}';
  // What plain JSON.parse does today: the last digits are lost.
  assert.equal(JSON.parse(raw).entityInfos[0].itemInfo.itemID, 7673371213716262000);
  const fixed = JSON.parse(quoteBigIds(raw));
  assert.equal(fixed.entityInfos[0].itemInfo.itemID, '7673371213716262165');
  assert.equal(fixed.entityInfos[0].itemInfo.authorID, '7449709391898476560');
  const entry = normalizeVideoEntry(fixed.entityInfos[0], 'VN');
  assert.equal(entry.url.endsWith('/video/7673371213716262165'), true);
});

test('view range filter keeps only the requested band', () => {
  const base = normalizeVideoEntry(VIDEO_ITEM, 'VN');
  const low = { ...base, id: 'low', views: 50000 };
  const mid = { ...base, id: 'mid', views: 300000 };
  const high = { ...base, id: 'high', views: 5000000 };

  assert.deepEqual(
    filterVideos([low, mid, high], { minViews: 100000, maxViews: 1000000 }).map((v) => v.id),
    ['mid']
  );
  assert.deepEqual(
    filterVideos([low, mid, high], { maxViews: 1000000 }).map((v) => v.id),
    ['low', 'mid']
  );
  assert.equal(normalizeMaxViews('1000000'), 1000000);
  assert.equal(normalizeMaxViews(''), 0);

  const result = buildTrendResult({
    region: 'VN',
    period: 30,
    minViews: 100000,
    maxViews: 1000000,
    minDurationSec: 0,
    hashtags: [],
    videos: [low, mid, high],
    config: CONFIG,
    fetchedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(result.maxViews, 1000000);
  assert.deepEqual(result.videos.map((v) => v.id), ['mid']);
});

test('an empty result from a filter explains the source range instead of blaming the source', () => {
  const base = normalizeVideoEntry(VIDEO_ITEM, 'VN');
  const big = { ...base, id: 'big', views: 39282773 };
  const result = buildTrendResult({
    region: 'VN',
    period: 7,
    minViews: 0,
    maxViews: 1000000,
    minDurationSec: 0,
    hashtags: [],
    videos: [big],
    config: CONFIG,
    fetchedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(result.videos.length, 0);
  const line = result.limitations.find((entry) => entry.includes('khớp bộ lọc'));
  assert.ok(line, 'the filter - not the source - is blamed');
  assert.ok(line.includes('39,3 tr'), `range shown: ${line}`);
  assert.equal(result.limitations.some((entry) => entry.includes('thử lại sau')), false);
  assert.equal(result.poolViewsMin, 39282773, 'the panel can show the source range');
  assert.equal(result.poolViewsMax, 39282773);
  assert.equal(formatViewsVi(39282773), '39,3 tr');
  assert.equal(formatViewsVi(1500000000), '1,5 tỷ');
});
