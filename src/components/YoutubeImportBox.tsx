import React, { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, RefreshCw, X } from 'lucide-react';
import { YoutubeChannelPanel, type ChannelEnqueue, type ChannelReceipt, type ConcatenatedFile } from './YoutubeChannelPanel';
import { normalizeEditProfile } from '../lib/edit-profile.js';
import { editFor, presetFor, readConcatConfig } from '../lib/youtube-concat-config.js';
import { YoutubeWatchLink } from './YoutubeWatchLink';

type EditProfile = NonNullable<ReturnType<typeof normalizeEditProfile>>;

type YoutubeQueue = 'unique' | 'edit' | 'reframe';
type YoutubeDest = 'save' | YoutubeQueue;
type YoutubePhase = 'info' | 'download' | 'merge';
type YoutubeQuality = 'best' | '4320' | '2160' | '1440' | '1080' | '720' | '480' | '360' | '240' | '144';

export interface YoutubeImportFile {
  name: string;
  path: string;
  folder: string;
  size: number;
}

interface Props {
  addLog: (message: string) => void;
  onImported: (tab: YoutubeQueue, file: YoutubeImportFile, jobId: string, presetId?: string, edit?: EditProfile | null) => void;
  awake: boolean;
  presets: { id: string; name: string }[];
  presetId: string;
  onPresetId: (id: string) => void;
  readEditProfile: () => EditProfile | null;
}

interface LinkAsk {
  videoId: string;
  canonicalUrl: string;
  title: string;
  at: string;
}

interface BatchItem {
  localId: string;
  url: string;
  videoId: string;
  quality: YoutubeQuality;
  dest: YoutubeDest;
  saveDir: string;
  title?: string;
  channelKey?: string;
  jobId?: string;
  presetId?: string;
}

const PHASE_LABEL: Record<YoutubePhase, string> = {
  info: 'Đang đọc thông tin',
  download: 'Đang tải',
  merge: 'Đang ghép',
};

const QUEUE_LABEL: Record<YoutubeQueue, string> = {
  unique: 'Unique',
  edit: 'Edit',
  reframe: 'Reframe',
};

const QUALITY_OPTIONS: { value: YoutubeQuality; label: string }[] = [
  { value: 'best', label: 'Tốt nhất' },
  { value: '4320', label: '4320p (8K)' },
  { value: '2160', label: '2160p (4K)' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p (mặc định)' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: '360', label: '360p' },
  { value: '240', label: '240p' },
  { value: '144', label: '144p' },
];

function isQuality(value: string): value is YoutubeQuality {
  return QUALITY_OPTIONS.some((option) => option.value === value);
}

function qualityLabel(value: YoutubeQuality): string {
  return QUALITY_OPTIONS.find((option) => option.value === value)?.label || value;
}

const CLAIM_KEY = 'gf_youtube_save_claim';
const BATCH_KEY = 'gf_youtube_batch';
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function isQueue(value: string): value is YoutubeQueue {
  return value === 'unique' || value === 'edit' || value === 'reframe';
}

function isDest(value: string): value is YoutubeDest {
  return value === 'save' || isQueue(value);
}

function savedQueue(): YoutubeDest {
  try {
    const saved = localStorage.getItem('gf_youtube_queue');
    if (saved && isDest(saved)) return saved;
  } catch { /* ignore */ }
  return 'save';
}

function savedFolder(): string {
  try { return localStorage.getItem('gf_youtube_save_dir') || ''; }
  catch { return ''; }
}

function queueLabel(tab: YoutubeDest): string {
  return tab === 'save' ? 'Chỉ lưu file' : QUEUE_LABEL[tab];
}

function previewYoutube(raw: string): { ok: true; videoId: string; canonicalUrl: string } | { ok: false; message: string } {
  let url: URL;
  try { url = new URL(String(raw || '').trim()); }
  catch { return { ok: false, message: 'Link không hợp lệ.' }; }
  if (url.username || url.password) return { ok: false, message: 'Link không hợp lệ.' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, message: 'Link không hợp lệ.' };
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!HOSTS.has(host)) return { ok: false, message: 'Chỉ nhận link YouTube (youtube.com hoặc youtu.be).' };
  const parts = url.pathname.split('/').filter(Boolean);
  const first = parts[0] || '';
  if (first === 'playlist') return { ok: false, message: 'Link playlist không được tải. Hãy dán link một video.' };
  let videoId = '';
  if (host === 'youtu.be') {
    if (parts.length === 1 && VIDEO_ID.test(parts[0])) videoId = parts[0];
  } else if (first === 'watch' || first === '') {
    const v = url.searchParams.get('v') || '';
    if (VIDEO_ID.test(v)) videoId = v;
  } else if ((first === 'embed' || first === 'shorts' || first === 'live' || first === 'v') && VIDEO_ID.test(parts[1] || '')) {
    videoId = parts[1];
  }
  if (videoId) return { ok: true, videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
  if (url.searchParams.has('list')) return { ok: false, message: 'Link playlist không được tải. Hãy dán link một video.' };
  return { ok: false, message: 'Link này không phải một video YouTube.' };
}

function isReceipt(row: unknown): row is ChannelReceipt {
  if (!row || typeof row !== 'object') return false;
  const item = row as ChannelReceipt;
  return typeof item.id === 'string'
    && typeof item.videoId === 'string'
    && typeof item.title === 'string'
    && typeof item.channelKey === 'string'
    && typeof item.saved === 'boolean';
}

function savedDay(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
  }).format(date);
}

function isBatchItem(row: unknown): row is BatchItem {
  if (!row || typeof row !== 'object') return false;
  const item = row as BatchItem;
  return typeof item.localId === 'string'
    && typeof item.url === 'string'
    && typeof item.videoId === 'string'
    && typeof item.saveDir === 'string'
    && (item.channelKey == null || typeof item.channelKey === 'string')
    && (item.title == null || typeof item.title === 'string')
    && isQuality(item.quality)
    && isDest(item.dest)
    && (item.presetId == null || typeof item.presetId === 'string');
}

function readBatch(): BatchItem[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(BATCH_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(isBatchItem).slice(0, 30);
  } catch { return []; }
}

function claimSave(jobId: string): boolean {
  try {
    const raw = JSON.parse(sessionStorage.getItem(CLAIM_KEY) || '[]');
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    if (ids.includes(jobId)) return false;
    ids.push(jobId);
    sessionStorage.setItem(CLAIM_KEY, JSON.stringify(ids.slice(-50)));
    return true;
  } catch {
    return true;
  }
}

function localId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function channelSetup(channelKey: string): { presetId: string; edit: EditProfile | null } {
  if (!channelKey) return { presetId: '', edit: null };
  try {
    const config = readConcatConfig(JSON.parse(localStorage.getItem('gf_youtube_concat') || '{}'));
    return { presetId: presetFor(config, channelKey) || '', edit: editFor(config, channelKey) || null };
  } catch {
    return { presetId: '', edit: null };
  }
}

function YoutubeThumb({ videoId }: { videoId: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span data-thumb={videoId} className="shrink-0">
      {!videoId || failed ? (
        <span className="block w-24 h-14 rounded-md bg-gray-800" />
      ) : (
        <img
          src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
          alt=""
          className="w-24 h-14 rounded-md object-cover bg-gray-800"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function YoutubeImportBox({ addLog, onImported, awake, presets, presetId, onPresetId, readEditProfile }: Props) {
  const [url, setUrl] = useState('');
  const [quality, setQuality] = useState<YoutubeQuality>('1080');
  const [dest, setDest] = useState<YoutubeDest>(savedQueue);
  const [saveDir, setSaveDir] = useState(savedFolder);
  const [toolReady, setToolReady] = useState(false);
  const [toolMessage, setToolMessage] = useState('Đang kiểm tra yt-dlp. Nếu thiếu, ứng dụng sẽ tự tải bản chính thức.');
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [targetTab, setTargetTab] = useState<YoutubeDest | null>(null);
  const [phase, setPhase] = useState<YoutubePhase | null>(null);
  const [value, setValue] = useState(0);
  const [etaMs, setEtaMs] = useState<number | null>(null);
  const [receipts, setReceipts] = useState<ChannelReceipt[]>([]);
  const [watchKey, setWatchKey] = useState('');
  const [linkAsk, setLinkAsk] = useState<LinkAsk | null>(null);
  const [channelSaved, setChannelSaved] = useState<{ key: string; videoId: string; title: string; n: number } | null>(null);
  const [batch, setBatch] = useState<BatchItem[]>(readBatch);
  const sourceRef = useRef<EventSource | null>(null);
  const openJobRef = useRef<string | null>(null);
  const batchRef = useRef<BatchItem[]>(batch);
  const pumping = useRef(false);
  const settledJobs = useRef(new Set<string>());
  const reconnects = useRef(0);
  const bootRef = useRef(false);
  const addLogRef = useRef(addLog);
  const onImportedRef = useRef(onImported);
  const saveDirRef = useRef(saveDir);
  const pumpRef = useRef<() => Promise<void>>(async () => {});
  const loadReceiptsRef = useRef<() => Promise<void>>(async () => {});
  const readStatusRef = useRef<(fresh: boolean) => Promise<{ busy?: boolean; active?: { jobId?: string; videoId?: string; targetTab?: string } }>>(async () => ({}));
  addLogRef.current = addLog;
  onImportedRef.current = onImported;
  saveDirRef.current = saveDir;

  const commit = (items: BatchItem[]) => {
    const next = items.slice(0, 30);
    batchRef.current = next;
    setBatch(next);
    try { sessionStorage.setItem(BATCH_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const loadReceipts = async () => {
    try {
      const res = await fetch('/api/youtube-receipts');
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.items)) return;
      setReceipts(data.items.filter(isReceipt));
    } catch { /* the next open of the tab reads the file again */ }
  };
  loadReceiptsRef.current = loadReceipts;

  const finishJob = (finishedId: string) => {
    if (!finishedId || settledJobs.current.has(finishedId)) return;
    settledJobs.current.add(finishedId);
    sourceRef.current?.close();
    sourceRef.current = null;
    openJobRef.current = null;
    commit(batchRef.current.filter((item) => item.jobId !== finishedId));
    pumping.current = false;
    setBusy(false);
    setCopying(false);
    setJobId(null);
    setPhase(null);
    setValue(0);
    setEtaMs(null);
    setTargetTab(null);
    void pumpRef.current();
  };

  const openStream = (id: string, item: BatchItem | null) => {
    if (openJobRef.current === id && sourceRef.current) return;
    sourceRef.current?.close();
    openJobRef.current = id;
    setJobId(id);
    setBusy(true);
    const tab = item?.dest && isDest(item.dest) ? item.dest : null;
    if (tab) setTargetTab(tab);
    const source = new EventSource(`/api/youtube-import/stream/${id}`);
    sourceRef.current = source;
    let saving = false;
    source.onmessage = (ev) => {
      let data: { type?: string; message?: string; phase?: YoutubePhase; value?: number; etaMs?: number; targetTab?: string; videoId?: string; title?: string; file?: YoutubeImportFile };
      try { data = JSON.parse(ev.data); }
      catch { return; }
      reconnects.current = 0;
      if (data.type === 'log' && data.message) addLogRef.current(data.message);
      else if (data.type === 'progress') {
        if (data.phase === 'info' || data.phase === 'download' || data.phase === 'merge') setPhase(data.phase);
        setValue(Number(data.value) || 0);
        const eta = Number(data.etaMs);
        setEtaMs(Number.isFinite(eta) ? eta : null);
      } else if (data.type === 'done' && data.file) {
        const file = data.file;
        const queued = batchRef.current.find((row) => row.jobId === id) || item;
        const landed = isDest(String(data.targetTab || queued?.dest || '')) ? String(data.targetTab || queued?.dest) as YoutubeDest : tab;
        void (async () => {
          if (!claimSave(id)) {
            finishJob(id);
            return;
          }
          saving = true;
          setCopying(true);
          const folder = (queued?.saveDir || saveDirRef.current).trim();
          const pipeline = landed && isQueue(landed) ? landed : null;
          let savedPath = '';
          let savedName = file.name;
          let copied = false;
          try {
            const res = await fetch(`/api/youtube-import/${id}/save`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                path: folder,
                removeSource: !pipeline,
                ...(queued?.channelKey ? { channelKey: queued.channelKey } : {}),
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (body.dest) {
              savedPath = String(body.dest);
              savedName = String(body.name || savedName);
            }
            copied = res.ok && Boolean(savedPath);
            if (copied) {
              setChannelSaved({
                key: queued?.channelKey || '',
                videoId: String(data.videoId || queued?.videoId || ''),
                title: queued?.title || String(data.title || ''),
                n: Date.now(),
              });
            }
            if (!copied) {
              addLogRef.current(`[YT] ${body.error || 'Không lưu được file vào thư mục đã chọn.'}`);
              addLogRef.current(`[YT] File vẫn nằm ở ${file.path}. Dòng này giữ trong danh sách để lưu về máy.`);
              if (pipeline === 'unique' || pipeline === 'reframe') {
                addLogRef.current('[YT] Unique hoặc Reframe tự chạy và xóa bản trong thư mục tải khi xong. Hãy bấm Lưu về máy trước lúc đó.');
              }
            }
          } catch {
            addLogRef.current('[YT] Không lưu được file vào thư mục đã chọn.');
            addLogRef.current(`[YT] File vẫn nằm ở ${file.path}. Dòng này giữ trong danh sách để lưu về máy.`);
          }
          const videoId = String(data.videoId || queued?.videoId || '');
          if (!copied && videoId) {
            try {
              await fetch('/api/youtube-receipts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id,
                  videoId,
                  title: queued?.title || String(data.title || savedName || videoId),
                  channelKey: queued?.channelKey || '',
                  holdPath: file.path,
                }),
              });
            } catch { /* a later Lưu về máy reads the same import file if it is still there */ }
          }
          await loadReceiptsRef.current();
          const saved = channelSetup(queued?.channelKey || '');
          const preset = pipeline === 'unique' ? (queued?.presetId || saved.presetId) : undefined;
          const edit = pipeline === 'edit' ? saved.edit : null;
          if (pipeline) onImportedRef.current(pipeline, file, id, preset, edit);
          finishJob(id);
        })();
      } else if (data.type === 'error') {
        addLogRef.current(`[YT] ${data.message || 'Tải thất bại.'}`);
        finishJob(id);
      }
    };
    source.onerror = () => {
      if (saving || settledJobs.current.has(id)) return;
      if (source.readyState !== EventSource.CLOSED) return;
      reconnects.current += 1;
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
      openJobRef.current = null;
      if (reconnects.current > 3) {
        addLogRef.current('[YT] Mất kết nối tiến trình tải.');
        finishJob(id);
        return;
      }
      void readStatusRef.current(false).then((status) => {
        if (status?.busy && String(status.active?.jobId || '') === id) return;
        addLogRef.current('[YT] Mất kết nối tiến trình tải.');
        finishJob(id);
      });
    };
  };

  const attachActive = (active: { jobId?: string; videoId?: string; targetTab?: string } | undefined) => {
    const id = String(active?.jobId || '');
    if (!id) return;
    const videoId = String(active?.videoId || '');
    const tab = isDest(String(active?.targetTab || '')) ? active?.targetTab as YoutubeDest : 'save';
    const items = batchRef.current;
    let current = items.find((row) => row.jobId === id) || null;
    if (!current && items[0] && !items[0].jobId) {
      current = { ...items[0], jobId: id, videoId: videoId || items[0].videoId };
      commit([current, ...items.slice(1)]);
    } else if (!current) {
      current = {
        localId: id,
        url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
        videoId,
        quality: '1080',
        dest: tab,
        saveDir: saveDirRef.current.trim(),
        jobId: id,
      };
      commit([current, ...items.filter((row) => row.jobId !== id)]);
    }
    pumping.current = true;
    openStream(id, current);
  };

  readStatusRef.current = async (fresh: boolean) => {
    const res = await fetch(`/api/youtube-import/status${fresh ? '?fresh=1' : ''}`);
    const data = await res.json();
    setToolReady(Boolean(data.ready));
    setToolMessage(data.ready ? '' : (data.message || 'Không cài được yt-dlp tự động. Kiểm tra mạng rồi bấm kiểm tra lại.'));
    if (data.installedNow) addLogRef.current(`[YT] Đã cài yt-dlp${data.ytDlp?.version ? ` ${data.ytDlp.version}` : ''}.`);
    if (data.busy && data.active?.jobId) attachActive(data.active);
    return data;
  };

  pumpRef.current = async () => {
    if (pumping.current) return;
    const head = batchRef.current[0];
    if (!head) return;
    pumping.current = true;
    setBusy(true);
    setTargetTab(head.dest);
    if (head.jobId) {
      openStream(head.jobId, head);
      return;
    }
    let res: Response;
    let data: { error?: string; code?: string; jobId?: string; videoId?: string } = {};
    try {
      res = await fetch('/api/youtube-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: head.url,
          quality: head.quality,
          tab: head.dest,
          ...(head.channelKey ? { channelKey: head.channelKey } : {}),
        }),
      });
      data = await res.json().catch(() => ({}));
    } catch {
      addLogRef.current('[YT] Không gửi được lượt tải.');
      commit(batchRef.current.filter((item) => item.localId !== head.localId));
      pumping.current = false;
      setBusy(false);
      void pumpRef.current();
      return;
    }
    if (!res.ok) {
      if (res.status === 409 && data.code === 'busy') {
        pumping.current = false;
        const status = await readStatusRef.current(false);
        if (!status?.busy) void pumpRef.current();
        return;
      }
      addLogRef.current(`[YT] ${data.error || 'Không tải được.'}`);
      if (data.code === 'no_ytdlp' || data.code === 'no_ffmpeg') {
        setToolReady(false);
        if (data.error) setToolMessage(data.error);
        pumping.current = false;
        setBusy(false);
        return;
      }
      commit(batchRef.current.filter((item) => item.localId !== head.localId));
      pumping.current = false;
      setBusy(false);
      void pumpRef.current();
      return;
    }
    const nextId = String(data.jobId || '');
    const stamped = { ...head, jobId: nextId, videoId: String(data.videoId || head.videoId) };
    commit(batchRef.current.map((item) => item.localId === head.localId ? stamped : item));
    openStream(nextId, stamped);
  };

  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    void loadReceiptsRef.current();
  }, []);

  useEffect(() => {
    if (bootRef.current) return;
    if (!awake && batchRef.current.length === 0) return;
    bootRef.current = true;
    readStatusRef.current(false).then((data) => {
      if (pumping.current || data?.busy) return;
      void pumpRef.current();
    }).catch(() => {
      setToolReady(false);
      setToolMessage('Không hỏi được trạng thái yt-dlp.');
    });
  }, [awake]);

  const chooseDest = (next: YoutubeDest) => {
    setDest(next);
    try { localStorage.setItem('gf_youtube_queue', next); } catch { /* ignore */ }
  };

  const chooseFolder = (next: string) => {
    setSaveDir(next);
    try { localStorage.setItem('gf_youtube_save_dir', next); } catch { /* ignore */ }
  };

  const pickFolder = async () => {
    const start = encodeURIComponent(saveDir.trim());
    try {
      const res = await fetch(`/api/pick-folder?sticky=0&start=${start}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.path) {
        addLog(`[YT] ${data.error || 'Không chọn được thư mục. Dán đường dẫn vào ô.'}`);
        return;
      }
      chooseFolder(String(data.path));
    } catch {
      addLog('[YT] Không chọn được thư mục. Dán đường dẫn vào ô.');
    }
  };

  const pushLink = (parsed: { videoId: string; canonicalUrl: string }) => {
    const folder = saveDir.trim();
    if (!folder) {
      addLog('[YT] Chọn thư mục lưu file gốc trước khi tải.');
      return;
    }
    if (batchRef.current.some((item) => item.videoId === parsed.videoId)) {
      addLog('[YT] Video này đã có trong hàng chờ.');
      return;
    }
    if (batchRef.current.length >= 30) {
      addLog('[YT] Hàng chờ đã đủ 30 video.');
      return;
    }
    try { localStorage.setItem('gf_youtube_save_dir', folder); } catch { /* ignore */ }
    commit([...batchRef.current, {
      localId: localId(),
      url: parsed.canonicalUrl,
      videoId: parsed.videoId,
      quality,
      dest,
      saveDir: folder,
      ...(dest === 'unique' && presetId ? { presetId } : {}),
    }]);
    setUrl('');
    setLinkAsk(null);
    void pumpRef.current();
  };

  const addToQueue = async () => {
    const folder = saveDir.trim();
    if (!folder) {
      addLog('[YT] Chọn thư mục lưu file gốc trước khi tải.');
      return;
    }
    const parsed = previewYoutube(url);
    if (!parsed.ok) {
      addLog(`[YT] ${parsed.message}`);
      return;
    }
    if (batchRef.current.some((item) => item.videoId === parsed.videoId)) {
      addLog('[YT] Video này đã có trong hàng chờ.');
      return;
    }
    if (batchRef.current.length >= 30) {
      addLog('[YT] Hàng chờ đã đủ 30 video.');
      return;
    }
    try {
      const res = await fetch('/api/youtube-channels/known', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [parsed.videoId] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addLog('[YT] Không kiểm tra được video đã tải.');
        return;
      }
      const known = (Array.isArray(data.videos) ? data.videos : []).find((row: { id?: string }) => row && row.id === parsed.videoId);
      if (known) {
        setLinkAsk({
          videoId: parsed.videoId,
          canonicalUrl: parsed.canonicalUrl,
          title: String(known.title || ''),
          at: String(known.at || ''),
        });
        return;
      }
    } catch {
      addLog('[YT] Không kiểm tra được video đã tải.');
      return;
    }
    pushLink(parsed);
  };

  const removeWaiting = (itemId: string) => {
    const item = batchRef.current.find((row) => row.localId === itemId);
    if (!item || item.jobId) return;
    commit(batchRef.current.filter((row) => row.localId !== itemId));
  };

  const cancel = async () => {
    if (!jobId) return;
    try { await fetch(`/api/cancel/${jobId}`, { method: 'POST' }); }
    catch { addLog('[YT] Không gửi được lệnh hủy.'); }
  };

  const enqueueChannel = (items: ChannelEnqueue[]) => {
    let added = 0;
    let leftOut = 0;
    const next = [...batchRef.current];
    for (const item of items) {
      const videoId = String(item.videoId || '');
      const folder = String(item.saveDir || '').trim();
      if (!videoId || !folder) continue;
      if (next.some((row) => row.videoId === videoId)) continue;
      if (next.length >= 30) {
        leftOut += 1;
        continue;
      }
      next.push({
        localId: localId(),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        videoId,
        title: item.title || '',
        channelKey: item.channelKey,
        quality,
        dest,
        saveDir: folder,
        ...(dest === 'unique' && presetId ? { presetId } : {}),
      });
      added += 1;
    }
    if (added) {
      commit(next);
      void pumpRef.current();
    }
    return { added, leftOut };
  };

  const redownload = async (row: ChannelReceipt) => {
    const videoId = String(row.videoId || '');
    const chosen = quality;
    if (!VIDEO_ID.test(videoId)) {
      addLog('[YT] Không tải lại được video này.');
      return;
    }
    if (batchRef.current.some((item) => item.videoId === videoId)) {
      addLog('[YT] Video này đã có trong hàng chờ.');
      return;
    }
    if (batchRef.current.length >= 30) {
      addLog('[YT] Hàng chờ đã đủ 30 video.');
      return;
    }
    let folder = '';
    if (row.channelKey) {
      try {
        const res = await fetch('/api/youtube-channels');
        const data = await res.json().catch(() => ({}));
        const channel = (Array.isArray(data.channels) ? data.channels : []).find((item: { key?: string; folder?: string }) => item && item.key === row.channelKey);
        folder = String(channel?.folder || '').trim();
      } catch { /* the shared folder below is the fallback */ }
    }
    if (!folder) folder = saveDirRef.current.trim();
    if (!folder) {
      addLog('[YT] Chọn thư mục lưu file gốc trước khi tải lại.');
      return;
    }
    if (batchRef.current.some((item) => item.videoId === videoId)) {
      addLog('[YT] Video này đã có trong hàng chờ.');
      return;
    }
    if (batchRef.current.length >= 30) {
      addLog('[YT] Hàng chờ đã đủ 30 video.');
      return;
    }
    commit([...batchRef.current, {
      localId: localId(),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId,
      title: row.title || '',
      ...(row.channelKey ? { channelKey: row.channelKey } : {}),
      quality: chosen,
      dest: 'save',
      saveDir: folder,
    }]);
    addLog(`[YT] Tải lại ${row.title || videoId}.`);
    void pumpRef.current();
  };

  const openReceiptFolder = async (row: ChannelReceipt) => {
    const folder = String(row.folder || '').trim();
    if (!row.saved || !folder) {
      addLog('[YT] Video này chưa có thư mục đã lưu.');
      return;
    }
    try {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folder }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) addLog(`[YT] ${data.error || 'Không mở được thư mục.'}`);
    } catch {
      addLog('[YT] Không mở được thư mục.');
    }
  };

  const shownReceipts = watchKey ? receipts.filter((row) => row.channelKey === watchKey) : [];

  const sendConcat = async (file: ConcatenatedFile) => {
    const how = file.mode === 'encode' ? 'đã chỉnh kích thước cho khớp' : 'giữ nguyên hình';
    addLog(`[YT] Đã ghép ${file.name}. ${how}. File gốc giữ nguyên.`);
    if (file.dest === 'save') return;
    try {
      const res = await fetch('/api/youtube-import/hold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.jobId || !data.file?.path) {
        addLog(`[YT] ${data.error || 'File ghép đã nằm trong thư mục. Chưa đẩy sang tab khác được.'}`);
        return;
      }
      onImported(file.dest, {
        name: String(data.file.name || file.name),
        path: String(data.file.path),
        folder: String(data.file.folder || ''),
        size: Number(data.file.size) || file.size,
      }, String(data.jobId), file.dest === 'unique' ? file.presetId : undefined, file.dest === 'edit' ? file.edit : null);
    } catch {
      addLog('[YT] File ghép đã nằm trong thư mục. Chưa đẩy sang tab khác được.');
    }
  };

  const saveReceipt = async (id: string, folder: string) => {
    const path = folder.trim() || saveDirRef.current.trim();
    if (!path) {
      addLog('[YT] Chọn thư mục lưu file gốc trước khi lưu.');
      return;
    }
    try {
      const res = await fetch(`/api/youtube-receipts/${encodeURIComponent(id)}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        addLog(`[YT] ${data.error || 'Không lưu được file.'}`);
        return;
      }
      addLog(`[YT] Đã lưu ${data.name || 'file'}.`);
    } catch {
      addLog('[YT] Không lưu được file.');
      return;
    }
    await loadReceipts();
  };

  const clearReceipt = async (id: string) => {
    try {
      await fetch(`/api/youtube-receipts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch { /* the list reload shows what remains */ }
    await loadReceipts();
  };

  const clearReceipts = async (channelKey: string) => {
    const query = channelKey ? `?channelKey=${encodeURIComponent(channelKey)}` : '';
    try {
      await fetch(`/api/youtube-receipts${query}`, { method: 'DELETE' });
    } catch { /* the list reload shows what remains */ }
    await loadReceipts();
  };

  const showEta = phase === 'download' && etaMs != null;
  const etaLabel = showEta ? `còn khoảng ${Math.round((etaMs || 0) / 1000)} giây` : '';
  const waitingCount = batch.filter((item) => !item.jobId).length;
  const pendingKeys = [...new Set(batch.map((item) => item.channelKey).filter((key): key is string => Boolean(key)))];
  const linkDay = linkAsk ? savedDay(linkAsk.at) : '';

  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-4 space-y-3 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-100">
          <Download className="w-5 h-5 text-red-400" />
          Tải từ YouTube
          {targetTab && busy && (
            <span className="text-[10px] font-mono text-gray-400">
              {targetTab === 'save' ? '→ chỉ lưu file' : `→ hàng ${QUEUE_LABEL[targetTab]}`}
            </span>
          )}
        </div>
        {busy && jobId && (
          <button type="button" onClick={() => void cancel()} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white">
            Hủy video này
          </button>
        )}
      </div>
      <p className="text-[11px] text-gray-500">Hàng chờ tải lần lượt từng video. GhostForge không đăng nhập YouTube.</p>
      <div className="flex flex-wrap gap-2 text-[11px] font-mono">
        <span className="px-2.5 py-1 rounded-lg bg-gray-950 border border-gray-800 text-gray-200">Danh sách: {shownReceipts.length}</span>
        <span className="px-2.5 py-1 rounded-lg bg-gray-950 border border-gray-800 text-gray-200">Hàng chờ: {batch.length}</span>
      </div>
      {!toolReady && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-amber-300">{toolMessage}</p>
          <button
            type="button"
            onClick={() => void readStatusRef.current(true).catch(() => setToolMessage('Không hỏi được trạng thái yt-dlp.'))}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-mono border border-gray-700 text-gray-300 hover:bg-gray-800"
          >
            <RefreshCw className="w-3 h-3" />
            Kiểm tra lại
          </button>
        </div>
      )}
      {toolReady && (
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={saveDir}
              onChange={(e) => chooseFolder(e.target.value)}
              placeholder="Thư mục lưu file gốc"
              className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
            />
            <button
              type="button"
              onClick={() => void pickFolder()}
              className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg text-sm font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800"
            >
              <FolderOpen className="w-4 h-4" />
              Chọn thư mục
            </button>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={url}
              onChange={(e) => { setUrl(e.target.value); setLinkAsk(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void addToQueue(); }}
              placeholder="Dán link một video YouTube"
              className="flex-1 bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
            />
            <select
              value={quality}
              onChange={(e) => { if (isQuality(e.target.value)) setQuality(e.target.value); }}
              className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
            >
              {QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              value={dest}
              onChange={(e) => { if (isDest(e.target.value)) chooseDest(e.target.value); }}
              className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
            >
              <option value="save">Chỉ lưu file</option>
              <option value="unique">Lưu và thêm vào Unique</option>
              <option value="edit">Lưu và thêm vào Edit</option>
              <option value="reframe">Lưu và thêm vào Reframe</option>
            </select>
            {dest === 'unique' && (
              <select
                value={presets.some((item) => item.id === presetId) ? presetId : ''}
                onChange={(e) => onPresetId(e.target.value)}
                className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100"
              >
                <option value="">Chọn preset Unique</option>
                {presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            )}
            <button
              type="button"
              onClick={() => void addToQueue()}
              disabled={!url.trim() || !saveDir.trim()}
              className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-500 text-white"
            >
              Thêm vào hàng chờ
            </button>
          </div>
          {linkAsk && (
            <div className="rounded-md border border-amber-900/70 bg-amber-950/30 px-2 py-1.5 space-y-1">
              <p className="text-[11px] text-amber-100">
                {linkAsk.title && linkAsk.title !== linkAsk.videoId ? `${linkAsk.title}. ` : ''}
                {linkDay
                  ? `Video này bạn đã tải vào ngày ${linkDay}. Bạn có chắc muốn tải lại?`
                  : 'Video này bạn đã tải rồi. Bạn có chắc muốn tải lại?'}
              </p>
              <div className="flex gap-1">
                <button type="button" onClick={() => pushLink(linkAsk)} className="px-2 py-1 rounded text-[11px] font-bold bg-amber-700 hover:bg-amber-600 text-white">
                  Đồng ý
                </button>
                <button type="button" onClick={() => setLinkAsk(null)} className="px-2 py-1 rounded text-[11px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800">
                  Không
                </button>
              </div>
            </div>
          )}
          <YoutubeChannelPanel
            sharedFolder={saveDir}
            qualityLabel={qualityLabel(quality)}
            destLabel={queueLabel(dest)}
            savedMark={channelSaved}
            pendingKeys={pendingKeys}
            receipts={receipts}
            addLog={addLog}
            enqueue={enqueueChannel}
            onSaveReceipt={(id, folder) => { void saveReceipt(id, folder); }}
            onClearReceipt={(id) => { void clearReceipt(id); }}
            onClearReceipts={(key) => { void clearReceipts(key); }}
            presets={presets}
            readEditProfile={readEditProfile}
            onConcatenated={(file) => { void sendConcat(file); }}
            onRedownload={(row) => { void redownload(row); }}
            onOpenFolder={(row) => { void openReceiptFolder(row); }}
            onSelectedKey={setWatchKey}
          />
        </div>
      )}
      {batch.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-gray-300">Hàng chờ ({batch.length}{waitingCount ? `, ${waitingCount} đang đợi` : ''})</p>
          <ul className="space-y-1 max-h-80 overflow-y-auto pr-1">
            {batch.map((item, index) => {
              const running = index === 0 && (busy || Boolean(item.jobId));
              return (
                <li key={item.localId} className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <YoutubeThumb videoId={item.videoId} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-gray-100 truncate">{item.title || item.videoId}</span>
                        <span className="text-[10px] font-mono text-gray-400 shrink-0">
                          {running ? (copying ? 'Đang chép file' : 'Đang tải') : 'Đang đợi'} · {qualityLabel(item.quality)} · {queueLabel(item.dest)}
                        </span>
                      </div>
                      <p className="text-[10px] font-mono text-gray-500 truncate">{item.saveDir}</p>
                    </div>
                    {!running && (
                      <button type="button" onClick={() => removeWaiting(item.localId)} className="p-1.5 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400" title="Bỏ khỏi hàng chờ">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {running && (
                    <div className="mt-2 space-y-1">
                      <div className="flex justify-between text-[11px] font-mono text-gray-400">
                        <span>{copying ? 'Đang chép file gốc vào thư mục đã chọn' : (phase ? PHASE_LABEL[phase] : 'Đang chuẩn bị')}</span>
                        <span>{copying ? '' : `${Math.round(value)}%${etaLabel ? ` · ${etaLabel}` : ''}`}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden">
                        <div className="h-full bg-red-500" style={{ width: `${copying ? 100 : Math.max(0, Math.min(100, value))}%` }} />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-gray-800 bg-gray-950/40 p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-gray-300">Danh sách đã tải</p>
          {watchKey && shownReceipts.length > 0 && (
            <button type="button" onClick={() => void clearReceipts(watchKey)} className="px-2 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800">
              Xóa hết
            </button>
          )}
        </div>
        <p className="text-[10px] text-gray-500">Chỉ hiện video của kênh đang chọn. Video đã lưu rời danh sách sau 7 ngày. Video chưa lưu được giữ lại sau khi tắt app.</p>
        {!watchKey && <p className="text-[11px] text-gray-500">Chọn một kênh để xem video đã tải.</p>}
        {watchKey && shownReceipts.length === 0 && <p className="text-[11px] text-gray-500">Chưa có video của kênh này.</p>}
        <ul className="space-y-1 max-h-60 overflow-y-auto pr-1">
          {shownReceipts.map((row) => (
            <li key={row.id} className="rounded-lg border border-gray-800 bg-gray-950/70 px-3 py-2">
              <div className="flex items-center gap-3">
                <YoutubeWatchLink videoId={row.videoId} className="flex items-center gap-3 min-w-0 flex-1">
                  <YoutubeThumb videoId={row.videoId} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-gray-100 truncate">{row.title || row.videoId}</span>
                    <span className="text-[10px] text-gray-500">{row.saved ? 'đã lưu' : 'chưa lưu'}{(row.redownloads || 0) > 0 ? ` · tải lại ${row.redownloads} lần` : ''}</span>
                  </span>
                </YoutubeWatchLink>
                {row.saved && row.folder && (
                  <button
                    type="button"
                    data-open-folder={row.videoId}
                    onClick={() => void openReceiptFolder(row)}
                    className="px-2 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 shrink-0"
                  >
                    Mở thư mục
                  </button>
                )}
                <button
                  type="button"
                  data-redownload={row.videoId}
                  onClick={() => void redownload(row)}
                  className="px-2 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 shrink-0"
                >
                  Tải lại
                </button>
                <button
                  type="button"
                  onClick={() => void saveReceipt(row.id, '')}
                  className="px-2 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 shrink-0"
                >
                  {row.saved ? 'Lưu bản sao' : 'Lưu về máy'}
                </button>
                <button type="button" onClick={() => void clearReceipt(row.id)} className="p-1.5 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400" title="Xóa khỏi danh sách">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
