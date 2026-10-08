// TikTok Creative Center session helper.
//
// The free trend source only serves a teaser to logged-out visitors (3
// hashtags / 4 videos). Signing in once, in the Chrome profile that belongs to
// this repo, is what unlocks the longer lists (measured: 20 hashtags / 20
// videos for VN 30 days).
//
//   node scripts/tiktok-session.mjs login   # opens Chrome - sign in, then close the window
//   node scripts/tiktok-session.mjs check   # headless: reports what the session unlocks
//
// The profile lives in `<repo>/.tiktok-session/chrome-profile` and is gitignored
// because it holds a live TikTok session cookie. The server reads the cookie
// header from this profile through server/tiktok-session.js.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TIKTOK_USER_AGENT,
  cookiesToHeader,
  findChrome,
  hasTiktokProfile,
  readProfileCookies,
  tiktokProfileDir,
  withTiktokChrome,
} from '../server/tiktok-session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = tiktokProfileDir(ROOT);
const TRENDS_URL =
  'https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?region=VN&period=30';

async function login() {
  fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
  const chrome = spawn(
    findChrome(),
    [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--user-data-dir=${PROFILE_DIR}`,
      `--user-agent=${TIKTOK_USER_AGENT}`,
      '--window-size=1400,1000',
      TRENDS_URL,
    ],
    { stdio: 'ignore' }
  );
  console.log('Đã mở Chrome với profile riêng của app.');
  console.log('Đăng nhập TikTok trong cửa sổ đó, đợi trang Trends hiện danh sách dài hơn,');
  console.log('rồi ĐÓNG cửa sổ Chrome.');
  console.log(`Profile: ${PROFILE_DIR}`);
  await new Promise((resolve) => chrome.on('exit', resolve));
  console.log('Đã đóng cửa sổ. Chạy `node scripts/tiktok-session.mjs check` để đo.');
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result.value;
}

async function check() {
  if (!hasTiktokProfile(ROOT)) {
    console.log('Chưa có phiên đăng nhập. Chạy `node scripts/tiktok-session.mjs login` trước.');
    process.exitCode = 1;
    return;
  }

  const dom = await withTiktokChrome({ profileDir: PROFILE_DIR, url: TRENDS_URL }, (session) =>
    evaluate(
      session,
      `(() => {
        const text = document.body.innerText;
        return {
          hasLoginCta: /log in or sign up/i.test(text),
          hashtagLines: (text.match(/^#[\\w]+/gm) || []).length,
        };
      })()`
    )
  );
  const cookies = await readProfileCookies({ profileDir: PROFILE_DIR });
  const cookieHeader = cookiesToHeader(cookies);

  console.log('--- Trình duyệt ---');
  console.log('còn nút "Log in or sign up":', dom.hasLoginCta);
  console.log('dòng bắt đầu bằng #:', dom.hashtagLines);
  console.log('cookie cho ads.tiktok.com:', cookies.length);

  const headers = {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': TIKTOK_USER_AGENT,
    cookie: cookieHeader,
  };
  const videoUrl = TRENDS_URL.replace('/trends/hashtag', '/trends/video');
  const [hashtagRes, videoRes] = await Promise.all([
    fetch(TRENDS_URL, { headers }),
    fetch(videoUrl, { headers }),
  ]);
  const hashtagHtml = await hashtagRes.text();
  const videoHtml = await videoRes.text();
  const hashtags = hashtagHtml.split('hashtagName').length - 1;
  const videos = videoHtml.split('"itemID"').length - 1;

  console.log('\n--- HTTP thuần kèm cookie ---');
  console.log('hashtag:', hashtagRes.status, '·', hashtags, 'mục');
  console.log('video:  ', videoRes.status, '·', videos, 'mục');
  console.log(
    hashtags > 3
      ? '=> Phiên đăng nhập dùng được; backend đọc thẳng bằng HTTP.'
      : '=> Cookie chưa đủ; cần đọc bằng browser.'
  );
}

const mode = (process.argv[2] || '').toLowerCase();
if (mode === 'login') {
  await login();
} else if (mode === 'check') {
  await check();
} else {
  console.log('Cách dùng:');
  console.log('  node scripts/tiktok-session.mjs login   # mở Chrome để đăng nhập một lần');
  console.log('  node scripts/tiktok-session.mjs check    # đo phiên đăng nhập mở khoá được gì');
  process.exitCode = 1;
}
