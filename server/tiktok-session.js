// Reads the TikTok Creative Center session cookies out of the repo-owned
// Chrome profile that `scripts/tiktok-session.mjs login` creates.
//
// Why a browser is involved at all: Chrome stores its cookies encrypted with
// DPAPI, so a plain Node process cannot read the profile's SQLite file. Talking
// to Chrome over the DevTools protocol is the dependency-free way to get the
// cookie header, and the answer is cached for hours because the important
// session cookies (sessionid_ads / sid_guard_ads) are long-lived.
//
// With the cookie header, the Creative Center trends pages return 20 hashtags
// and 20 videos instead of the logged-out teaser of 3 and 4.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TIKTOK_SESSION_DIR = '.tiktok-session';

export const TIKTOK_COOKIE_URL = 'https://ads.tiktok.com';

export const TIKTOK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 30000;

export function tiktokProfileDir(root) {
  return path.join(root, TIKTOK_SESSION_DIR, 'chrome-profile');
}

export function hasTiktokProfile(root) {
  return fs.existsSync(tiktokProfileDir(root));
}

export function findChrome() {
  const candidates = [
    process.env.GHOSTFORGE_CHROME,
    path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    'chrome.exe',
    'google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep) && !candidate.includes('/')) return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'chrome.exe';
}

export function cookiesToHeader(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie && cookie.name)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

// Minimal CDP client over the DevTools websocket (Node 22+ has a global WebSocket).
export function cdpSession(ws) {
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method) listeners.forEach((fn) => fn(message));
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(fn) {
      listeners.push(fn);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Launch Chrome on the session profile and hand a CDP session to `fn`.
// `headless` stays off for the interactive login, on for cookie reads.
export async function withTiktokChrome({ profileDir, headless = true, url = 'about:blank', chromePath }, fn) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${profileDir}`,
    `--user-agent=${TIKTOK_USER_AGENT}`,
    '--window-size=1400,1000',
  ];
  if (headless) {
    args.unshift('--headless=new', '--disable-gpu', '--disable-extensions');
  }
  args.push(`--remote-debugging-port=${port}`);
  const chrome = spawn(chromePath || findChrome(), args, { stdio: 'ignore', windowsHide: true });
  let ws = null;
  try {
    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      } catch {
        await sleep(250);
      }
    }
    if (!version) {
      throw new Error(
        'Chrome không mở được cổng debug. Nếu cửa sổ đăng nhập còn mở, hãy đóng nó trước.'
      );
    }
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    ).json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const session = cdpSession(ws);
    await session.send('Network.enable');
    await session.send('Page.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});",
    });
    await session.send('Network.setUserAgentOverride', {
      userAgent: TIKTOK_USER_AGENT,
      platform: 'Win32',
    });
    if (url && url !== 'about:blank') {
      await session.send('Page.navigate', { url });
    }
    return await fn(session);
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    await sleep(200);
    chrome.kill();
  }
}

export async function readProfileCookies({ profileDir, chromePath, launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS }) {
  const work = withTiktokChrome({ profileDir, chromePath }, async (session) => {
    const result = await session.send('Network.getCookies', { urls: [TIKTOK_COOKIE_URL] });
    return result.cookies || [];
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Hết thời gian đọc cookie từ Chrome.')), launchTimeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Caches the cookie header for the server session. `getCookieHeader({force})`
// refreshes on demand, which the trend provider does when the source answers
// with the logged-out teaser despite a session existing.
export function createTiktokSession({ root, chromePath, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const profileDir = tiktokProfileDir(root);
  let cached = null;

  async function refresh() {
    const cookies = await readProfileCookies({ profileDir, chromePath });
    const header = cookiesToHeader(cookies);
    const hasSession = /(^|;\s*)sessionid_ads=/.test(`; ${header}`);
    cached = { at: now(), header, cookieCount: cookies.length, hasSession };
    return cached;
  }

  return {
    profileDir,
    available() {
      return fs.existsSync(profileDir);
    },
    async getCookieHeader({ force = false } = {}) {
      if (!force && cached && now() - cached.at < ttlMs) return cached.header;
      if (!this.available()) return '';
      try {
        const value = await refresh();
        return value.header;
      } catch {
        return cached ? cached.header : '';
      }
    },
    async status() {
      if (!this.available()) return { profile: false, loggedIn: false, cookies: 0 };
      try {
        const value = cached && now() - cached.at < ttlMs ? cached : await refresh();
        return { profile: true, loggedIn: value.hasSession, cookies: value.cookieCount };
      } catch (err) {
        return { profile: true, loggedIn: false, cookies: 0, error: err.message };
      }
    },
  };
}
