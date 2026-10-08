import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// TikTok Creative Center trends provider.
//
// Free, no-login source. The Creative Center trends pages server-render a
// react-query payload into <script id="__MODERN_ROUTER_DATA__">, and that
// payload carries the top hashtags and the top videos for one region and
// period. A logged-out visitor only receives a teaser (3 hashtags, 4 videos);
// that limit belongs to TikTok, not to this parser, so the response reports it
// in `limitations` instead of pretending the list is complete.
//
// Everything except `createTrendService` is pure so it can be unit tested
// without network access. The provider is deliberately isolated: swapping in a
// paid API or the Research API later means adding another module and mapping
// its rows into these same field names.

export const TREND_SOURCE = 'creative-center';

// Creative Center's free trends pages only honour 7 and 30 days. Asking for
// 120 silently returns the 7-day data, so it is not offered as a choice.
export const TREND_PERIODS = [7, 30];

// The list is ranked by views, so its 100 rows already start in the millions;
// the steps are chosen to be useful inside that range.
export const TREND_MIN_VIEWS = [0, 100000, 500000, 1000000, 5000000, 10000000, 50000000];

// Upper bounds for the view filter ("thấp nhất ... cao nhất ...").
export const TREND_MAX_VIEWS = [0, 1000000, 2000000, 5000000, 10000000, 20000000, 50000000, 100000000];

// Minimum video length options, in seconds. Creative Center does not publish a
// duration field, so the value comes from ffprobe on the signed CDN mp4 link
// the payload embeds (see `ffprobeDuration`).
export const TREND_MIN_DURATIONS = [0, 15, 30, 60, 180];

// How many videos one request may pull. The legacy list API accepts 100, which
// matters because a length filter drops a lot of the top clips.
export const TREND_VIDEO_LIMITS = [20, 50, 100];
export const TREND_VIDEO_LIMIT_DEFAULT = 100;
export const TREND_VIDEO_LIMIT_MAX = 100;

// The video list lives on two hosts; which one answers depends on the region
// (US: ads.us.tiktok.com, VN/JP/TH/ID: ads.tiktok.com).
const LEGACY_HOSTS = ['https://ads.tiktok.com', 'https://ads.us.tiktok.com'];

const LEGACY_LIST_HEADERS = {
  accept: 'application/json, text/plain, */*',
  referer: 'https://ads.tiktok.com/',
};

export function periodDimensionFor(period) {
  return normalizeTrendPeriod(period) === 7 ? 3 : 5;
}

export function normalizeVideoLimit(value) {
  const limit = Math.round(toNumber(value));
  if (!Number.isFinite(limit) || limit <= 0) return TREND_VIDEO_LIMIT_DEFAULT;
  return Math.min(Math.max(limit, 20), TREND_VIDEO_LIMIT_MAX);
}

// Labels for the country codes Creative Center itself advertises.
export const TREND_REGION_LABELS = {
  US: 'Hoa Kỳ',
  FR: 'Pháp',
  DE: 'Đức',
  IT: 'Ý',
  ES: 'Tây Ban Nha',
  GB: 'Anh',
  AR: 'Argentina',
  AU: 'Úc',
  BR: 'Brazil',
  CA: 'Canada',
  CO: 'Colombia',
  EG: 'Ai Cập',
  ID: 'Indonesia',
  IL: 'Israel',
  JP: 'Nhật Bản',
  KR: 'Hàn Quốc',
  MY: 'Malaysia',
  MX: 'Mexico',
  PH: 'Philippines',
  SA: 'Ả Rập Xê Út',
  SG: 'Singapore',
  ZA: 'Nam Phi',
  TW: 'Đài Loan',
  TH: 'Thái Lan',
  TR: 'Thổ Nhĩ Kỳ',
  AE: 'UAE',
  VN: 'Việt Nam',
};

export const TREND_LIMITATION =
  'Nguồn miễn phí (không đăng nhập) chỉ trả về 3 hashtag và 4 video mỗi quốc gia/khoảng ngày. Danh sách đầy đủ cần đăng nhập TikTok One hoặc một API trả phí.';

// Countries Creative Center advertises for hashtag trends, Vietnam first so the
// UI opens on the operator's market.
export const TREND_REGIONS = [
  'VN', 'US', 'JP', 'KR', 'TH', 'ID', 'PH', 'MY', 'SG', 'TW', 'AU', 'GB',
  'FR', 'DE', 'IT', 'ES', 'BR', 'MX', 'CA', 'AR', 'CO', 'SA', 'AE', 'TR',
  'EG', 'IL', 'ZA',
];

// The video tab only covers these five markets.
export const TREND_VIDEO_REGIONS = ['US', 'JP', 'VN', 'TH', 'ID'];

const TRENDS_ORIGIN = 'https://ads.tiktok.com';

// The Creative Center edge serves the full server-rendered payload only to
// browser-like requests; without these headers it returns a shell page with no
// data. Verified 2026-09-29.
const BROWSER_HEADERS = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="126", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

// Tokens too generic to read as a "hot key".
const STOP_WORDS = new Set([
  'va', 'là', 'la', 'cua', 'của', 'cho', 'voi', 'với', 'thi', 'thì', 'nay', 'kia',
  'nhung', 'những', 'cac', 'các', 'mot', 'một', 'khong', 'không', 'co', 'có', 'duoc',
  'được', 'nguoi', 'người', 'minh', 'mình', 'ban', 'bạn', 'toi', 'tôi', 'no', 'nó',
  'nhu', 'như', 'hay', 'hoac', 'hoặc', 'vao', 'vào', 'ra', 'len', 'lên', 'xuong',
  'xuống', 'rat', 'rất', 'qua', 'quá', 'the', 'the', 'and', 'for', 'you', 'with',
  'this', 'that', 'from', 'your', 'are', 'was', 'were', 'his', 'her', 'she', 'him',
  'they', 'them', 'its', 'our', 'out', 'but', 'not', 'all', 'any', 'can', 'just',
  'how', 'who', 'what', 'when', 'where', 'why', 'video', 'tiktok', 'tiktokshop',
]);

const MIN_KEYWORD_LENGTH = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How many videos may be probed for their length in one request, and how many
// probes run at once. The list is small (the free source returns 4), but a
// logged-in session can return more.
const DURATION_PROBE_LIMIT = 40;
const DURATION_PROBE_CONCURRENCY = 12;
const DURATION_PROBE_TIMEOUT_MS = 20000;

// A logged-in response is recognisable by its size: the teaser is 3 hashtags
// and 4 videos, so anything above that means the session worked.
function looksLoggedIn(pages) {
  const hashtags = pages && Array.isArray(pages.hashtags) ? pages.hashtags.length : 0;
  const videos = pages && Array.isArray(pages.videos) ? pages.videos.length : 0;
  return hashtags > 3 || videos > 3;
}

// Compact Vietnamese number for the operator-facing messages.
export function formatViewsVi(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace('.', ',')} tỷ`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} tr`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeTrendRegion(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : 'VN';
}

export function normalizeTrendPeriod(value) {
  const period = Math.round(toNumber(value));
  return TREND_PERIODS.includes(period) ? period : 30;
}

export function normalizeMinViews(value) {
  const min = Math.round(toNumber(value));
  if (!Number.isFinite(min) || min <= 0) return 0;
  return min;
}

export function normalizeMaxViews(value) {
  const max = Math.round(toNumber(value));
  return Number.isFinite(max) && max > 0 ? max : 0;
}

export function normalizeMinDuration(value) {
  const min = Math.round(toNumber(value));
  return Number.isFinite(min) && min > 0 ? min : 0;
}

export function regionLabel(code) {
  return TREND_REGION_LABELS[code] || code;
}

// Pull the server-rendered react-query payload out of the page HTML.
// TikTok returns item ids as unquoted JSON numbers in the list API, and a
// JavaScript number cannot hold 19 digits: 7673371213716262165 becomes
// ...262000, which makes every watch URL a dead link. Quote the long id fields
// before parsing so the string survives intact.
export function quoteBigIds(text) {
  return String(text || '').replace(/"([A-Za-z_]*[Ii][Dd])":\s*(\d{15,})/g, '"$1":"$2"');
}

export function extractModernRouterData(html) {
  const match = /<script[^>]*id="__MODERN_ROUTER_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(
    String(html || '')
  );
  if (!match) return null;
  try {
    return JSON.parse(quoteBigIds(match[1]));
  } catch {
    return null;
  }
}

function queriesFromRouterData(routerData) {
  const root = routerData && routerData.loaderData ? routerData.loaderData : routerData;
  if (!root || typeof root !== 'object') return [];
  if (Array.isArray(root)) return [];
  const out = [];
  for (const value of Object.values(root)) {
    if (value && value.dehydratedState && Array.isArray(value.dehydratedState.queries)) {
      out.push(...value.dehydratedState.queries);
    }
  }
  return out;
}

function entriesFromQuery(query) {
  const page = query && query.state && query.state.data && query.state.data.pages
    ? query.state.data.pages[0]
    : null;
  if (!page) return [];
  if (Array.isArray(page.data)) return page.data;
  if (Array.isArray(page.entityInfos)) return page.entityInfos;
  return [];
}

export function parseTrendFilterConfig(routerData) {
  for (const query of queriesFromRouterData(routerData)) {
    const key = Array.isArray(query.queryKey) ? query.queryKey[0] : '';
    if (key !== 'getTrendsFilterConfig') continue;
    const data = query.state && query.state.data ? query.state.data : {};
    return {
      hashtagCountry: Array.isArray(data.hashtagCountry) ? data.hashtagCountry.map(String) : [],
      videoCountry: Array.isArray(data.videoCountry) ? data.videoCountry.map(String) : [],
      videoContentTags: Array.isArray(data.videoContentTags) ? data.videoContentTags.map(String) : [],
      industry: Array.isArray(data.industry) ? data.industry.map(String) : [],
    };
  }
  return null;
}

export function normalizeHashtagEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.hashtagName || '').replace(/^#/, '').trim();
  if (!name) return null;
  const curve = Array.isArray(raw.popularityCurve)
    ? raw.popularityCurve
        .filter((point) => point && typeof point === 'object')
        .map((point) => ({ at: toNumber(point.timestamp), value: toNumber(point.value) }))
        .filter((point) => point.at > 0)
    : [];
  const last = curve.length ? curve[curve.length - 1].value : 0;
  return {
    kind: 'hashtag',
    name,
    id: String(raw.hashtagID || ''),
    rank: Math.round(toNumber(raw.rankIndex)) || null,
    posts: toNumber(raw.publishCnt),
    views: toNumber(raw.vv),
    popularity: Math.round(last * 10) / 10,
    industryIds: Array.isArray(raw.industryIDs) ? raw.industryIDs.map(String) : [],
    source: TREND_SOURCE,
  };
}

// Split a caption into hashtags and readable keyword tokens. Vietnamese text is
// kept intact because \p{L} covers the diacritics.
export function keysFromCaption(caption) {
  const text = String(caption || '');
  const hashtags = [];
  for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    const tag = match[1].toLowerCase();
    if (tag && !hashtags.includes(tag)) hashtags.push(tag);
  }
  const withoutTags = text.replace(/#[\p{L}\p{N}_]+/gu, ' ');
  const keywords = [];
  for (const token of withoutTags.split(/[^\p{L}\p{N}]+/u)) {
    const word = token.toLowerCase();
    if (word.length < MIN_KEYWORD_LENGTH) continue;
    if (/^\d+$/.test(word)) continue;
    if (STOP_WORDS.has(word)) continue;
    if (!keywords.includes(word)) keywords.push(word);
  }
  return { hashtags, keywords };
}

export function normalizeVideoEntry(raw, region) {
  if (!raw || typeof raw !== 'object') return null;
  const info = raw.itemInfo || {};
  const metrics = raw.itemMetrics || {};
  const author = raw.itemAuthorInfo || {};
  const handler = String(author.handlerName || '').replace(/^@/, '');
  const id = String(info.itemID || '');
  const title = String(info.title || '');
  if (!id) return null;
  const keys = keysFromCaption(title);
  const labels = Array.isArray(raw.contentTags)
    ? raw.contentTags
        .map((tag) => (tag && tag.contentLabelName ? String(tag.contentLabelName) : ''))
        .filter(Boolean)
    : [];
  const createTime = toNumber(info.createTime);
  return {
    kind: 'video',
    id,
    title,
    region: region || null,
    url: handler ? `https://www.tiktok.com/@${handler}/video/${id}` : `https://www.tiktok.com/video/${id}`,
    videoUrl: String(info.videoURL || ''),
    durationSec: null,
    createdAt: createTime ? new Date(createTime * 1000).toISOString() : null,
    createdAtSec: createTime || null,
    authorName: String(author.nickName || ''),
    authorHandle: handler,
    authorFollowers: toNumber((raw.itemAuthorMetrics || {}).followers),
    views: toNumber(metrics.videoViews),
    organicViews: toNumber(metrics.organicVideoViews),
    engagementRate: Number(toNumber(metrics.engagementRate).toFixed(6)),
    sixSecondsVtr: Number(toNumber(metrics.sixSecondsVTR).toFixed(6)),
    categories: labels,
    hashtags: keys.hashtags,
    keywords: keys.keywords,
    source: TREND_SOURCE,
  };
}

export function parseTrendPage(html, kind, region) {
  const routerData = extractModernRouterData(html);
  if (!routerData) return { config: null, entries: [], overview: null };
  const config = parseTrendFilterConfig(routerData);
  const overview = parseVideoOverview(routerData);
  const all = queriesFromRouterData(routerData);
  const wanted = kind === 'video' ? 'videos' : 'hashtags';
  for (const query of all) {
    const key = Array.isArray(query.queryKey) ? query.queryKey[1] : null;
    if (key !== wanted) continue;
    const raw = entriesFromQuery(query);
    const entries =
      kind === 'video'
        ? raw.map((item) => normalizeVideoEntry(item, region)).filter(Boolean)
        : raw.map(normalizeHashtagEntry).filter(Boolean);
    return { config, entries, overview };
  }
  return { config, entries: [], overview };
}

// The page carries a "data as of" timestamp per period; the legacy list API
// needs it (`periodEndTimestamp`). Only some regions publish it.
export function parseVideoOverview(routerData) {
  for (const query of queriesFromRouterData(routerData)) {
    if (Array.isArray(query.queryKey) && query.queryKey[1] === 'videoOverview') {
      const data = query.state ? query.state.data : null;
      if (data && typeof data === 'object') {
        return {
          lastDailyEndTimestamp: data.lastDailyEndTimestamp || null,
          lastWeeklyEndTimestamp: data.lastWeeklyEndTimestamp || null,
          lastMonthlyEndTimestamp: data.lastMonthlyEndTimestamp || null,
        };
      }
    }
  }
  return null;
}

export function overviewStamp(overview) {
  if (!overview) return null;
  return (
    overview.lastWeeklyEndTimestamp ||
    overview.lastDailyEndTimestamp ||
    overview.lastMonthlyEndTimestamp ||
    null
  );
}

// Keywords aggregated from the video list: how many videos used the word and
// how many views those videos collected together.
export function aggregateKeywords(videos, limit = 40) {
  const map = new Map();
  for (const video of Array.isArray(videos) ? videos : []) {
    const views = toNumber(video.views);
    for (const word of Array.isArray(video.keywords) ? video.keywords : []) {
      const entry = map.get(word) || { kind: 'keyword', name: word, videoCount: 0, views: 0, source: TREND_SOURCE };
      entry.videoCount += 1;
      entry.views += views;
      map.set(word, entry);
    }
    for (const tag of Array.isArray(video.hashtags) ? video.hashtags : []) {
      const entry = map.get(tag) || { kind: 'hashtag', name: tag, videoCount: 0, views: 0, source: TREND_SOURCE };
      entry.videoCount += 1;
      entry.views += views;
      map.set(tag, entry);
    }
  }
  return [...map.values()]
    .sort((a, b) => b.views - a.views || b.videoCount - a.videoCount || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function filterVideosByMinViews(videos, minViews) {
  return filterVideos(videos, { minViews });
}

// Minimum views and minimum length together. A length filter needs a known
// duration, so videos whose length could not be probed are excluded and counted
// separately instead of being shown as if they passed.
export function filterVideos(videos, { minViews = 0, maxViews = 0, minDurationSec = 0 } = {}) {
  const min = normalizeMinViews(minViews);
  const max = normalizeMaxViews(maxViews);
  const minDuration = normalizeMinDuration(minDurationSec);
  const list = Array.isArray(videos) ? videos : [];
  return list.filter((video) => {
    const views = toNumber(video.views);
    if (min && views < min) return false;
    if (max && views > max) return false;
    if (minDuration) {
      const duration = durationOf(video);
      if (duration === null || duration < minDuration) return false;
    }
    return true;
  });
}

// `null`/`undefined`/empty must not be read as a 0-second video.
function durationOf(video) {
  const raw = video ? video.durationSec : null;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function buildTrendResult({
  region,
  period,
  minViews,
  maxViews,
  minDurationSec,
  limit,
  sessionActive,
  sessionStale,
  hashtags,
  videos,
  config,
  fetchedAt,
}) {
  const list = Array.isArray(videos) ? videos : [];
  const filteredVideos = filterVideos(list, { minViews, maxViews, minDurationSec });
  const shownVideos = filteredVideos.slice(0, normalizeVideoLimit(limit));
  const minDuration = normalizeMinDuration(minDurationSec);
  const unknownDuration = minDuration
    ? filterVideos(list, { minViews, maxViews }).filter((video) => durationOf(video) === null).length
    : 0;
  const videoRegions = (config && config.videoCountry) || [];
  const limitations = [];
  const hashtagList = Array.isArray(hashtags) ? hashtags : [];
  // What the source actually offered this round - the operator needs it to pick
  // a view band that can match (the list is a top-N leaderboard, not a search).
  const poolViews = list.map((video) => toNumber(video.views)).filter((value) => value > 0);
  const poolViewsMin = poolViews.length ? Math.min(...poolViews) : 0;
  const poolViewsMax = poolViews.length ? Math.max(...poolViews) : 0;
  if (sessionActive) {
    if (hashtagList.length > 0 && hashtagList.length <= 3) {
      limitations.push(
        'Chỉ nhận được 3 hashtag dù đã có phiên đăng nhập - cookie có thể đã hết hạn. Đăng nhập lại: `node scripts/tiktok-session.mjs login`.'
      );
    }
  } else if (sessionStale) {
    limitations.push(
      'Phiên đăng nhập TikTok không dùng được cho lần lấy này (cookie hết hạn hoặc profile đang bị Chrome khoá). Đang hiển thị bản xem thử; đăng nhập lại bằng `node scripts/tiktok-session.mjs login`.'
    );
  } else {
    limitations.push(TREND_LIMITATION);
  }
  if (videoRegions.length && !videoRegions.includes(region)) {
    limitations.push(`Tab video chỉ hỗ trợ ${videoRegions.join(', ')}; quốc gia ${region} không có danh sách video.`);
  } else if (videoRegions.includes(region) && !list.length) {
    limitations.push(`Nguồn không trả danh sách video cho ${region} ở lần lấy này (TikTok server-render không đồng nhất); thử lại sau.`);
  } else if (!shownVideos.length && list.length) {
    // The rows exist; the chosen band excludes all of them. Say so, and say
    // what range the source actually offered, instead of blaming the source.
    const range = poolViews.length
      ? ` Nguồn lần này có ${list.length} video trong khoảng ${formatViewsVi(
          poolViewsMin
        )} - ${formatViewsVi(poolViewsMax)} view.`
      : '';
    limitations.push(`Không video nào trong ${list.length} video của nguồn khớp bộ lọc.${range}`);
  }
  if (unknownDuration) {
    limitations.push(
      `${unknownDuration} video bị loại vì không đọc được thời lượng (ffprobe không mở được link CDN).`
    );
  }
  return {
    source: TREND_SOURCE,
    region,
    regionLabel: regionLabel(region),
    period,
    minViews: normalizeMinViews(minViews),
    maxViews: normalizeMaxViews(maxViews),
    minDurationSec: minDuration,
    limit: normalizeVideoLimit(limit),
    sessionActive: Boolean(sessionActive),
    fetchedAt,
    limitations,
    hashtags: hashtagList,
    videos: shownVideos,
    poolViewsMin,
    poolViewsMax,
    videosFiltered: filteredVideos.length,
    videosBeforeFilter: list.length,
    keywords: aggregateKeywords(shownVideos),
  };
}

const DEFAULT_FFPROBE = process.env.GHOSTFORGE_FFPROBE || 'ffprobe';

// Read a media file's duration in seconds. The Creative Center video payload
// embeds a signed CDN mp4 link, and ffprobe reads its header without a full
// download. Returns null when the probe fails, so callers can report an unknown
// length instead of guessing.
export function ffprobeDuration(url, { ffprobePath = DEFAULT_FFPROBE, timeoutMs = DURATION_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    execFile(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const value = Number(String(stdout).trim());
        resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : null);
      }
    );
  });
}

export function createTrendService({
  fetchImpl = globalThis.fetch,
  probeDuration = ffprobeDuration,
  getCookieHeader = null,
  durationCachePath = null,
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
  timeoutMs = 15000,
} = {}) {
  const cache = new Map();
  const hostByRegion = new Map();
  // Video lengths never change, so they are kept across restarts: the network
  // cost of probing a clip is paid once, not once per server run.
  const durations = new Map();
  let stampCache = null;

  if (durationCachePath) {
    try {
      for (const [id, seconds] of Object.entries(JSON.parse(fs.readFileSync(durationCachePath, 'utf8')))) {
        const value = Number(seconds);
        if (id && Number.isFinite(value) && value > 0) durations.set(id, value);
      }
    } catch {
      /* no cache yet */
    }
  }

  function persistDurations() {
    if (!durationCachePath) return;
    try {
      fs.mkdirSync(path.dirname(durationCachePath), { recursive: true });
      fs.writeFileSync(durationCachePath, JSON.stringify(Object.fromEntries(durations)));
    } catch {
      /* a missing cache file is not worth failing a request over */
    }
  }

  async function fetchText(url, cookieHeader, extraHeaders = BROWSER_HEADERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { ...extraHeaders, ...(cookieHeader ? { cookie: cookieHeader } : {}) };
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`Creative Center trả về HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const fetchPageText = (url, cookieHeader) => fetchText(url, cookieHeader, BROWSER_HEADERS);

  async function fetchTab(region, period, tab, cookieHeader) {
    const url = `${TRENDS_ORIGIN}/creative/creativeCenter/trends/${tab}?region=${encodeURIComponent(region)}&period=${period}`;
    return parseTrendPage(
      await fetchPageText(url, cookieHeader),
      tab === 'video' ? 'video' : 'hashtag',
      region
    );
  }

  async function fetchAll(region, period, cookieHeader) {
    const [hashtagPage, videoPage] = await Promise.all([
      fetchTab(region, period, 'hashtag', cookieHeader),
      fetchTab(region, period, 'video', cookieHeader).catch(() => ({
        config: null,
        entries: [],
        overview: null,
      })),
    ]);
    return {
      config: videoPage.config || hashtagPage.config || null,
      hashtags: hashtagPage.entries,
      videos: videoPage.entries,
      overview: videoPage.overview || null,
    };
  }

  // `periodEndTimestamp` is a "data as of" value the list API needs. Only some
  // regions publish it on their own page, and it is a global date rather than a
  // per-region one, so a value learned from any region is reused.
  async function resolveStamp(overview, cookieHeader) {
    const own = overviewStamp(overview);
    if (own) {
      stampCache = { at: now(), value: String(own) };
      return stampCache.value;
    }
    if (stampCache && now() - stampCache.at < ttlMs) return stampCache.value;
    for (const probe of ['VN', 'JP']) {
      try {
        const page = await fetchTab(probe, 30, 'video', cookieHeader);
        const stamp = overviewStamp(page.overview);
        if (stamp) {
          stampCache = { at: now(), value: String(stamp) };
          return stampCache.value;
        }
      } catch {
        /* try the next probe region */
      }
    }
    return null;
  }

  // The page itself embeds at most 20 videos; this API returns up to 100. It
  // needs the session cookies - anonymous callers only get 4 rows.
  async function fetchVideoList({ region, period, cookieHeader, overview }) {
    if (!cookieHeader) return [];
    const stamp = await resolveStamp(overview, cookieHeader);
    if (!stamp) return [];
    const query =
      `contentLabelIDs=&countryCode=${encodeURIComponent(region)}&limit=${TREND_VIDEO_LIMIT_MAX}` +
      `&orderByMetric=1&organicOnly=false&page=1` +
      `&periodDimension=${periodDimensionFor(period)}&periodEndTimestamp=${stamp}`;
    const hosts = [hostByRegion.get(region), ...LEGACY_HOSTS].filter(Boolean);
    for (const host of hosts) {
      try {
        const text = await fetchText(
          `${host}/CreativeOne/Report/CreativeCenterGetTopContentsList?${query}`,
          cookieHeader,
          LEGACY_LIST_HEADERS
        );
        const json = JSON.parse(quoteBigIds(text));
        const items = Array.isArray(json.entityInfos) ? json.entityInfos : [];
        if (items.length) {
          hostByRegion.set(region, host);
          return items.map((item) => normalizeVideoEntry(item, region)).filter(Boolean);
        }
      } catch {
        /* try the other host */
      }
    }
    return [];
  }

  // Probe (and remember) the length of each video. Durations are cached per
  // video id inside the country+period entry, so switching the filters does not
  // re-run ffprobe on the same clip.
  async function withDurations(entry, cap) {
    const list = Array.isArray(entry.videos) ? entry.videos : [];
    const missing = list
      .filter((video) => video.videoUrl && !durations.has(video.id))
      .slice(0, cap);
    for (let i = 0; i < missing.length; i += DURATION_PROBE_CONCURRENCY) {
      const batch = missing.slice(i, i + DURATION_PROBE_CONCURRENCY);
      await Promise.all(
        batch.map(async (video) => {
          const seconds = await probeDuration(video.videoUrl);
          if (Number.isFinite(seconds) && seconds > 0) durations.set(video.id, seconds);
        })
      );
    }
    if (missing.length) persistDurations();
    return list.map((video) => ({
      ...video,
      durationSec: durations.has(video.id) ? durations.get(video.id) : null,
    }));
  }

  async function get({ region, period, minViews, maxViews, minDurationSec, limit }) {
    const code = normalizeTrendRegion(region);
    const window = normalizeTrendPeriod(period);
    const min = normalizeMinViews(minViews);
    const videoLimit = normalizeVideoLimit(limit);
    const cookieHeader = getCookieHeader ? await getCookieHeader() : '';
    const sessionActive = Boolean(cookieHeader);
    const cacheKey = `${code}:${window}:${sessionActive ? 'auth' : 'anon'}`;
    const cached = cache.get(cacheKey);
    let entry = cached && now() - cached.at < ttlMs ? cached : null;
    if (!entry) {
      let pages = await fetchAll(code, window, cookieHeader);
      // Rare transient: the page comes back with an empty payload. One retry
      // saves the operator from a blank table and a manual "Lấy lại".
      if (!pages.hashtags.length) {
        await sleep(400);
        const retry = await fetchAll(code, window, cookieHeader);
        if (retry.hashtags.length) pages = retry;
      }
      // A stale cookie looks exactly like the anonymous teaser, so refresh once
      // and retry before accepting it.
      if (sessionActive && pages.hashtags.length <= 3 && getCookieHeader) {
        const refreshed = await getCookieHeader({ force: true });
        if (refreshed && refreshed !== cookieHeader) {
          pages = await fetchAll(code, window, refreshed);
        }
      }
      // Pull the longer list from the list API; the page itself embeds at most 20.
      if (TREND_VIDEO_REGIONS.includes(code)) {
        const apiVideos = await fetchVideoList({
          region: code,
          period: window,
          cookieHeader,
          overview: pages.overview,
        }).catch(() => []);
        if (apiVideos.length > pages.videos.length) pages = { ...pages, videos: apiVideos };
      }
      entry = {
        at: now(),
        sessionActive: Boolean(cookieHeader) && looksLoggedIn(pages),
        sessionStale: Boolean(cookieHeader) && !looksLoggedIn(pages),
        config: pages.config,
        hashtags: pages.hashtags,
        videos: pages.videos,
        durations: new Map(),
      };
      cache.set(cacheKey, entry);
    }
    // A length filter needs every clip measured; without one, only the top of
    // the list is worth probing so the request stays quick.
    const probeCap = minDurationSec ? entry.videos.length : Math.min(entry.videos.length, 25);
    const videos = await withDurations(entry, probeCap);
    return buildTrendResult({
      region: code,
      period: window,
      minViews: min,
      maxViews,
      minDurationSec,
      limit: videoLimit,
      sessionActive: entry.sessionActive,
      sessionStale: entry.sessionStale,
      hashtags: entry.hashtags,
      videos,
      config: entry.config,
      fetchedAt: new Date(entry.at).toISOString(),
    });
  }

  return {
    get,
    clear() {
      cache.clear();
    },
  };
}
