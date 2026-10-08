import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw, X } from 'lucide-react';
import { normalizeEditProfile } from '../lib/edit-profile.js';
import {
  chainNameFor,
  editFor,
  findChain,
  presetFor,
  presetSource,
  readConcatConfig,
  saveChainEdit,
  saveChainPreset,
  saveChannelEdit,
  saveChannelPreset,
} from '../lib/youtube-concat-config.js';
import { YoutubeWatchLink } from './YoutubeWatchLink';

type EditProfile = NonNullable<ReturnType<typeof normalizeEditProfile>>;
const CONCAT_KEY = 'gf_youtube_concat';

type TabName = 'videos' | 'shorts';

interface VideoRow {
  id: string;
  title: string;
}

interface ChannelRow {
  key: string;
  channelId: string;
  title: string;
  tab: TabName;
  url: string;
  folder: string;
  anchorId: string;
  anchorTitle: string;
  downloadedCount: number;
  updatedAt: string;
}

interface Scan extends ChannelRow {
  anchorMissing: boolean;
  truncated: boolean;
  openedWithAnchor?: boolean;
  newCount: number;
  aboveCount: number;
  belowCount: number;
  newVideos: VideoRow[];
  above: VideoRow[];
  below: VideoRow[];
  first: VideoRow[];
  local?: VideoRow[];
}

export interface ConcatenatedFile {
  dest: 'save' | 'unique' | 'edit';
  path: string;
  name: string;
  folder: string;
  size: number;
  mode?: string;
  presetId?: string;
  edit?: EditProfile | null;
}

export interface ChannelEnqueue {
  videoId: string;
  title: string;
  channelKey: string;
  saveDir: string;
}

interface SavedMark {
  key: string;
  videoId: string;
  title: string;
  n: number;
}

export interface ChannelReceipt {
  id: string;
  videoId: string;
  title: string;
  channelKey: string;
  saved: boolean;
  folder?: string;
  redownloads?: number;
  at: string;
  savedAt: string;
}

interface KnownVideo {
  id: string;
  title: string;
  at: string;
}

interface RedoAsk {
  rows: VideoRow[];
  kind: string;
  known: KnownVideo[];
}

interface Props {
  sharedFolder: string;
  qualityLabel: string;
  destLabel: string;
  savedMark: SavedMark | null;
  pendingKeys: string[];
  receipts: ChannelReceipt[];
  addLog: (message: string) => void;
  enqueue: (items: ChannelEnqueue[]) => { added: number; leftOut: number };
  onSaveReceipt: (id: string, folder: string) => void;
  onClearReceipt: (id: string) => void;
  onClearReceipts: (channelKey: string) => void;
  presets: { id: string; name: string }[];
  readEditProfile: () => EditProfile | null;
  onConcatenated: (file: ConcatenatedFile) => void;
  onRedownload: (row: ChannelReceipt) => void;
  onOpenFolder: (row: ChannelReceipt) => void;
  onSelectedKey: (key: string) => void;
}

const PREVIEW = 4;

function isTab(value: string): value is TabName {
  return value === 'videos' || value === 'shorts';
}

function isChannel(row: unknown): row is ChannelRow {
  if (!row || typeof row !== 'object') return false;
  const item = row as ChannelRow;
  return typeof item.key === 'string' && typeof item.title === 'string' && isTab(item.tab);
}

function sortChannels(rows: ChannelRow[]): ChannelRow[] {
  return [...rows].sort((a, b) => {
    const title = a.title.localeCompare(b.title, 'vi', { sensitivity: 'base' });
    if (title) return title;
    if (a.tab !== b.tab) return a.tab === 'videos' ? -1 : 1;
    return a.key.localeCompare(b.key);
  });
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(30, Math.round(value)));
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

function MiniThumb({ videoId }: { videoId: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span data-thumb={videoId} className="shrink-0">
      {!videoId || failed ? (
        <span className="block w-16 h-9 rounded bg-gray-800" />
      ) : (
        <img
          src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
          alt=""
          className="w-16 h-9 rounded object-cover bg-gray-800"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function without(rows: VideoRow[], id: string): VideoRow[] {
  return rows.filter((row) => row.id !== id);
}

function stripScan(scan: Scan, videoId: string, anchor: SavedMark | null): Scan {
  const wasNew = scan.newVideos.some((row) => row.id === videoId);
  const wasAbove = scan.above.some((row) => row.id === videoId);
  const wasBelow = scan.below.some((row) => row.id === videoId);
  return {
    ...scan,
    anchorId: anchor ? anchor.videoId : scan.anchorId,
    anchorTitle: anchor?.title || scan.anchorTitle,
    newVideos: without(scan.newVideos, videoId),
    above: without(scan.above, videoId),
    below: without(scan.below, videoId),
    first: without(scan.first, videoId),
    newCount: Math.max(0, scan.newCount - (wasNew ? 1 : 0)),
    aboveCount: Math.max(0, scan.aboveCount - (wasAbove ? 1 : 0)),
    belowCount: Math.max(0, scan.belowCount - (wasBelow ? 1 : 0)),
  };
}

export function YoutubeChannelPanel({
  sharedFolder,
  qualityLabel,
  destLabel,
  savedMark,
  pendingKeys,
  receipts,
  addLog,
  enqueue,
  onSaveReceipt,
  onClearReceipt,
  onClearReceipts,
  presets,
  readEditProfile,
  onConcatenated,
  onRedownload,
  onOpenFolder,
  onSelectedKey,
}: Props) {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [scans, setScans] = useState<Record<string, Scan>>({});
  const [selectedKey, setSelectedKey] = useState('');
  const [channelUrl, setChannelUrl] = useState('');
  const [count, setCount] = useState(2);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');
  const [notice, setNotice] = useState('');
  const scanNoteKey = useRef('');
  const onSelectedKeyRef = useRef(onSelectedKey);
  onSelectedKeyRef.current = onSelectedKey;
  const [folderDraft, setFolderDraft] = useState('');
  const [confirmKey, setConfirmKey] = useState('');
  const [dismissedKey, setDismissedKey] = useState('');
  const [anchorUrl, setAnchorUrl] = useState('');
  const [anchorAsk, setAnchorAsk] = useState<{ videoId: string; title: string; savedAt: string } | null>(null);
  const [redo, setRedo] = useState<RedoAsk | null>(null);
  const [joinOrder, setJoinOrder] = useState<number[]>([]);
  const [joinDest, setJoinDest] = useState<'save' | 'unique' | 'edit'>('save');
  const [joinPreset, setJoinPreset] = useState('');
  const [chainName, setChainName] = useState('');
  const [chainAsk, setChainAsk] = useState<{ name: string; currentId: string; nextId: string } | null>(null);
  const [attachNote, setAttachNote] = useState('');
  const [joining, setJoining] = useState(false);
  const channelsRef = useRef(channels);
  const scanBusy = useRef(false);
  channelsRef.current = channels;

  const applyList = (rows: ChannelRow[]) => {
    const next = sortChannels(rows.filter(isChannel));
    setChannels(next);
    setSelectedKey((current) => (current && next.some((row) => row.key === current) ? current : (next[0]?.key || '')));
    return next;
  };

  const refresh = async () => {
    const res = await fetch('/api/youtube-channels');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Không đọc được danh sách kênh.');
    applyList(Array.isArray(data.channels) ? data.channels : []);
  };

  useEffect(() => {
    refresh().catch((err) => setNotice(err instanceof Error ? err.message : 'Không đọc được danh sách kênh.'));
  }, []);

  const pendingSig = pendingKeys.join('|');

  useEffect(() => {
    if (!savedMark?.n || !savedMark.videoId) return;
    const idle = Boolean(savedMark.key) && !pendingKeys.includes(savedMark.key);
    setScans((prev) => {
      if (idle) {
        const next = { ...prev };
        delete next[savedMark.key];
        return next;
      }
      const next: Record<string, Scan> = {};
      for (const [key, scan] of Object.entries(prev)) {
        next[key] = stripScan(scan, savedMark.videoId, key === savedMark.key ? savedMark : null);
      }
      return next;
    });
    refresh().catch(() => { /* the row updates on the next Xem kênh */ });
  }, [savedMark?.n, pendingSig]);

  const selected = channels.find((row) => row.key === selectedKey) || null;
  const scan = selected ? scans[selected.key] : null;

  useEffect(() => {
    setFolderDraft(selected?.folder || '');
    setConfirmKey('');
  }, [selected?.key, selected?.folder]);

  useEffect(() => {
    setAnchorUrl('');
    setAnchorAsk(null);
    setRedo(null);
    setJoinOrder([]);
    const config = readConcatConfig(readJoinConfig());
    setJoinPreset(selected?.key ? presetFor(config, selected.key) : '');
    setChainName(selected?.key ? chainNameFor(config, selected.key) : '');
    setAttachNote('');
    setChainAsk(null);
  }, [selected?.key]);

  const localSig = (scan?.local || []).map((row) => row.id).join('|');
  useEffect(() => {
    setJoinOrder([]);
  }, [localSig]);

  const rememberScan = (body: Scan) => {
    if (!isChannel(body)) return;
    const stamped = { ...body, openedWithAnchor: Boolean(body.anchorId) };
    setScans((prev) => ({ ...prev, [body.key]: stamped }));
    setDismissedKey('');
    setChannels((prev) => {
      const rest = prev.filter((row) => row.key !== body.key);
      const next = sortChannels([...rest, body]);
      setSelectedKey(body.key);
      return next;
    });
  };

  const scanUrl = async (raw: string) => {
    const url = raw.trim();
    if (!url || scanBusy.current) return;
    scanBusy.current = true;
    setScanning(true);
    setScanNote('');
    setNotice('');
    try {
      const res = await fetch('/api/youtube-channels/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, sharedFolder: sharedFolder.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error || 'Không đọc được kênh.');
        return;
      }
      rememberScan(data);
      scanNoteKey.current = String(data.key || '');
      setScanNote('Đã quét xong.');
      setChannelUrl('');
    } catch {
      setNotice('Không đọc được kênh.');
    } finally {
      scanBusy.current = false;
      setScanning(false);
    }
  };

  useEffect(() => {
    onSelectedKeyRef.current(selectedKey);
    setChainAsk(null);
    if (scanNoteKey.current && scanNoteKey.current !== selectedKey) {
      scanNoteKey.current = '';
      setScanNote('');
    }
  }, [selectedKey]);

  useEffect(() => {
    if (!selected?.anchorId || !selected.url || scans[selected.key] || scanBusy.current) return;
    void scanUrl(selected.url);
  }, [selected?.key, selected?.anchorId, selected?.url, scans[selected?.key || '']?.anchorId]);

  const commitFolder = async (next: string) => {
    if (!selected) return;
    const path = next.trim();
    if (path === (selected.folder || '')) return;
    setNotice('');
    try {
      const res = await fetch(`/api/youtube-channels/${encodeURIComponent(selected.key)}/folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !isChannel(data)) {
        setNotice(data.error || 'Không đặt được thư mục riêng.');
        setFolderDraft(selected.folder || '');
        return;
      }
      setChannels((prev) => prev.map((row) => (row.key === data.key ? { ...row, ...data } : row)));
      setScans((prev) => {
        const current = prev[data.key];
        return current ? { ...prev, [data.key]: { ...current, folder: data.folder } } : prev;
      });
    } catch {
      setNotice('Không đặt được thư mục riêng.');
    }
  };

  const pickOwnFolder = async () => {
    if (!selected) return;
    const start = encodeURIComponent((folderDraft || sharedFolder).trim());
    try {
      const res = await fetch(`/api/pick-folder?sticky=0&start=${start}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.path) {
        addLog(`[YT] ${data.error || 'Không chọn được thư mục. Dán đường dẫn vào ô.'}`);
        return;
      }
      setFolderDraft(String(data.path));
      await commitFolder(String(data.path));
    } catch {
      addLog('[YT] Không chọn được thư mục. Dán đường dẫn vào ô.');
    }
  };

  const placeAnchor = async (confirm: boolean) => {
    if (!selected || !anchorUrl.trim()) return;
    setNotice('');
    try {
      const res = await fetch(`/api/youtube-channels/${encodeURIComponent(selected.key)}/anchor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: anchorUrl.trim(), confirm }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error || 'Không đặt được mốc.');
        return;
      }
      if (data.needsConfirm) {
        setAnchorAsk({
          videoId: String(data.videoId || ''),
          title: String(data.title || ''),
          savedAt: String(data.savedAt || ''),
        });
        return;
      }
      setAnchorAsk(null);
      if (data.already) {
        setNotice('Video này đang là mốc.');
        return;
      }
      if (!isChannel(data) || !data.anchorId) {
        setNotice('Không đặt được mốc.');
        return;
      }
      const key = data.key;
      setChannels((prev) => prev.map((row) => (
        row.key === key
          ? { ...row, anchorId: data.anchorId, anchorTitle: data.anchorTitle || '', updatedAt: data.updatedAt || row.updatedAt }
          : row
      )));
      setScans((prev) => {
        if (!prev[key]) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setAnchorUrl('');
      setDismissedKey('');
      addLog(`[YT] Mốc mới của ${selected.title}: ${data.anchorTitle || data.anchorId}.`);
    } catch {
      setNotice('Không đặt được mốc.');
    }
  };

  const removeChannel = async () => {
    if (!selected) return;
    if (confirmKey !== selected.key) {
      setConfirmKey(selected.key);
      return;
    }
    try {
      const res = await fetch(`/api/youtube-channels/${encodeURIComponent(selected.key)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error || 'Không bỏ được kênh.');
        return;
      }
      const key = selected.key;
      setScans((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setChannels((prev) => {
        const next = prev.filter((row) => row.key !== key);
        setSelectedKey(next[0]?.key || '');
        return next;
      });
    } catch {
      setNotice('Không bỏ được kênh.');
    }
  };

  const queueRows = async (rows: VideoRow[], kind: string, force = false) => {
    if (!selected) return;
    const saveDir = (selected.folder || sharedFolder).trim();
    if (!saveDir) {
      addLog('[YT] Chọn thư mục chung, hoặc đặt thư mục riêng cho kênh.');
      return;
    }
    if (!rows.length) {
      addLog('[YT] Không còn video để tải ở hướng này.');
      return;
    }
    if (!force) {
      try {
        const res = await fetch('/api/youtube-channels/known', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: rows.map((row) => row.id) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          addLog('[YT] Không kiểm tra được video đã tải.');
          return;
        }
        const found = new Map<string, KnownVideo>();
        for (const row of Array.isArray(data.videos) ? data.videos : []) {
          if (row && typeof row.id === 'string') found.set(row.id, { id: row.id, title: String(row.title || ''), at: String(row.at || '') });
        }
        const known = rows.filter((row) => found.has(row.id)).map((row) => ({
          id: row.id,
          title: row.title || found.get(row.id)?.title || row.id,
          at: found.get(row.id)?.at || '',
        }));
        if (known.length) {
          setRedo({ rows, kind, known });
          return;
        }
      } catch {
        addLog('[YT] Không kiểm tra được video đã tải.');
        return;
      }
    }
    setRedo(null);
    const result = enqueue(rows.map((row) => ({
      videoId: row.id,
      title: row.title,
      channelKey: selected.key,
      saveDir,
    })));
    if (!result.added && !result.leftOut) addLog('[YT] Các video này đã có trong hàng chờ.');
    else if (result.leftOut) addLog(`[YT] Đã thêm ${result.added} video. Hàng chờ đủ 30, còn ${result.leftOut}.`);
    else addLog(`[YT] Đã thêm ${result.added} ${kind} của ${selected.title}.`);
    if (result.added && kind === 'video mới') setDismissedKey(selected.key);
  };

  const skipRedo = () => {
    if (!redo || !selected) return;
    const oldIds = new Set(redo.known.map((row) => row.id));
    const fresh = redo.rows.filter((row) => !oldIds.has(row.id));
    const kind = redo.kind;
    setRedo(null);
    if (fresh.length) void queueRows(fresh, kind, true);
  };

  const n = clampCount(count);
  const anchorTitle = selected?.anchorTitle || scan?.anchorTitle || '';
  const hasAnchor = Boolean(selected?.anchorId || scan?.anchorId);
  const showSides = Boolean(scan && !scan.anchorMissing && hasAnchor && scan.openedWithAnchor);
  const showNewest = Boolean(scan && !scan.anchorMissing && !hasAnchor);
  const showNew = Boolean(showSides && dismissedKey !== scan?.key);
  const preview = scan?.newVideos.slice(0, PREVIEW) || [];
  const moreNew = Math.max(0, (scan?.newCount || 0) - preview.length);
  const saveLabel = selected?.folder
    ? selected.folder
    : (sharedFolder.trim() ? `Thư mục chung · ${sharedFolder.trim()}` : 'Chưa chọn thư mục chung');
  const askedDay = anchorAsk ? savedDay(anchorAsk.savedAt) : '';
  const askedTitle = anchorAsk && anchorAsk.title && anchorAsk.title !== anchorAsk.videoId ? anchorAsk.title : '';
  const channelReceipts = selected ? receipts.filter((row) => row.channelKey === selected.key) : [];

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-950/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-gray-100">Kênh</h2>
        <p className="text-[10px] text-gray-500 truncate">Chất lượng {qualityLabel} · {destLabel}</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={channelUrl}
          onChange={(e) => setChannelUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void scanUrl(channelUrl); }}
          placeholder="Dán link kênh YouTube"
          className="flex-1 min-w-0 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100"
        />
        <button
          type="button"
          onClick={() => void scanUrl(channelUrl)}
          disabled={scanning || !channelUrl.trim()}
          className="px-3 py-1.5 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-500 text-white"
        >
          {scanning ? 'Đang quét' : 'Xem kênh'}
        </button>
      </div>
      {notice && <p className="text-[11px] text-amber-300">{notice}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(11rem,0.82fr)_minmax(0,1.18fr)] gap-2 sm:h-60">
        <div className="h-36 sm:h-full overflow-y-auto rounded-lg border border-gray-800 bg-gray-950 p-1 space-y-1">
          {channels.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-gray-500">Chưa có kênh. Dán link rồi bấm Xem kênh.</p>
          )}
          {channels.map((row) => {
            const active = row.key === selectedKey;
            const known = scans[row.key];
            const fresh = known && !known.anchorMissing ? known.newCount : 0;
            const presetLabel = presetPhrase(row.key, presets) || 'Chưa gắn preset';
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => setSelectedKey(row.key)}
                title={row.title}
                className={`w-full text-left rounded-md border border-l-4 px-2 py-1.5 ${
                  row.tab === 'shorts' ? 'border-l-amber-400' : 'border-l-red-500'
                } ${active ? 'bg-gray-800 border-gray-600' : 'bg-gray-950 border-gray-800 hover:bg-gray-900'}`}
              >
                <span className="block text-xs text-gray-100 truncate">{row.title}</span>
                <span className={`mt-0.5 block text-[10px] leading-snug ${presetLabel === 'Chưa gắn preset' ? 'text-gray-500' : 'text-emerald-200'}`} data-channel-preset={row.key}>{presetLabel}</span>
                <span className="mt-0.5 flex items-center gap-1 text-[10px] font-mono text-gray-400">
                  <span className={`px-1 rounded ${row.tab === 'shorts' ? 'bg-amber-500/15 text-amber-200' : 'bg-red-500/15 text-red-200'}`}>
                    {row.tab === 'shorts' ? 'Shorts' : 'Video'}
                  </span>
                  <span>{row.downloadedCount} đã lưu</span>
                  {row.folder ? <span className="text-emerald-300">riêng</span> : <span>chung</span>}
                  {fresh > 0 && <span className="text-sky-300">{fresh} mới</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="h-44 sm:h-full overflow-y-auto rounded-lg border border-gray-800 bg-gray-950 p-2 space-y-1.5">
          {!selected && <p className="text-[11px] text-gray-500">Chọn một kênh, hoặc dán link rồi bấm Xem kênh.</p>}
          {selected && (
            <>
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 text-xs font-semibold text-gray-100 truncate" title={selected.title}>{selected.title}</p>
                <button type="button" onClick={() => void scanUrl(selected.url)} disabled={scanning} className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40">
                  <RefreshCw className="w-3 h-3" />
                  {scanning ? 'Đang quét' : 'Quét lại'}
                </button>
                <button type="button" onClick={() => void removeChannel()} className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-400 hover:text-red-300 hover:bg-gray-800">
                  {confirmKey === selected.key ? 'Bỏ?' : 'Bỏ kênh'}
                </button>
              </div>
              <div className="flex items-center gap-2">
                {hasAnchor ? (
                  <YoutubeWatchLink videoId={selected.anchorId} className="flex items-center gap-2 min-w-0">
                    <MiniThumb videoId={selected.anchorId} />
                    <p className="min-w-0 text-[10px] text-gray-400 truncate" title={anchorTitle || ''}>
                      {`Mốc: ${anchorTitle || selected.anchorId}`}
                    </p>
                  </YoutubeWatchLink>
                ) : (
                  <p className="min-w-0 text-[10px] text-gray-400 truncate">Chưa có mốc. Lần đầu tải video mới nhất.</p>
                )}
              </div>
              <div className="flex items-center gap-1">
                <input
                  value={anchorUrl}
                  onChange={(e) => { setAnchorUrl(e.target.value); setAnchorAsk(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void placeAnchor(false); }}
                  placeholder="Dán link video làm mốc"
                  className="min-w-0 flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100"
                />
                <button
                  type="button"
                  onClick={() => void placeAnchor(false)}
                  disabled={!anchorUrl.trim()}
                  className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-40"
                >
                  Đặt mốc
                </button>
              </div>
              {anchorAsk && (
                <div className="rounded-md border border-amber-900/70 bg-amber-950/30 px-2 py-1.5 space-y-1">
                  <p className="text-[11px] text-amber-100">
                    {askedTitle ? `${askedTitle}. ` : ''}
                    {askedDay
                      ? `Video này bạn đã tải vào ngày ${askedDay}. Bạn có chắc đồng ý làm mốc mới không?`
                      : 'Video này bạn đã tải rồi. Bạn có chắc đồng ý làm mốc mới không?'}
                  </p>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => void placeAnchor(true)} className="px-2 py-1 rounded text-[11px] font-bold bg-amber-700 hover:bg-amber-600 text-white">
                      Đồng ý
                    </button>
                    <button type="button" onClick={() => setAnchorAsk(null)} className="px-2 py-1 rounded text-[11px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800">
                      Không
                    </button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-1">
                <input
                  value={folderDraft}
                  onChange={(e) => setFolderDraft(e.target.value)}
                  onBlur={() => { void commitFolder(folderDraft); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitFolder(folderDraft); }}
                  placeholder="Trống = thư mục chung"
                  title={saveLabel}
                  className="min-w-0 flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-100"
                />
                <button type="button" onClick={() => void pickOwnFolder()} className="inline-flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800">
                  <FolderOpen className="w-3 h-3" />
                  Đặt riêng
                </button>
                <button type="button" onClick={() => { setFolderDraft(''); void commitFolder(''); }} disabled={!selected.folder} className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 disabled:opacity-40">
                  Dùng chung
                </button>
              </div>
              <p className="text-[10px] font-mono text-gray-500 truncate" title={saveLabel}>{saveLabel}</p>
              {scanning && <p className="text-[11px] text-sky-200" data-scanning="1">Đang quét, vui lòng chờ.</p>}
              {!scanning && scanNote && <p className="text-[11px] text-emerald-300" data-scan-done="1">{scanNote}</p>}
              {scan?.anchorMissing && (
                <p className="text-[11px] text-amber-300">Không thấy video mốc trong 1000 video mới nhất. Hai hướng đang tắt.</p>
              )}
              {scan?.truncated && (
                <p className="text-[10px] text-gray-500">Chỉ đọc 1000 video mới nhất của tab này.</p>
              )}
              {(showSides || showNewest) && scan && (
                <div className="flex flex-wrap items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={count}
                    onChange={(e) => setCount(clampCount(Number(e.target.value)))}
                    className="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-1 text-xs text-gray-100"
                    aria-label="Số video"
                  />
                  {showSides ? (
                    <>
                      <button type="button" onClick={() => void queueRows(scan.below.slice(0, n), 'video cũ hơn')} className="px-2 py-1 rounded text-[11px] font-bold bg-gray-800 hover:bg-gray-700 text-gray-100">
                        {n} cũ hơn
                      </button>
                      <button type="button" onClick={() => void queueRows(scan.above.slice(0, n), 'video mới hơn')} className="px-2 py-1 rounded text-[11px] font-bold bg-gray-800 hover:bg-gray-700 text-gray-100">
                        {n} mới hơn
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void queueRows(scan.first.slice(0, n), 'video mới nhất')} className="px-2 py-1 rounded text-[11px] font-bold bg-red-600 hover:bg-red-500 text-white">
                      Tải {n} mới nhất
                    </button>
                  )}
                </div>
              )}
              {hasAnchor && !showSides && !scanning && (
                <p className="text-[11px] text-gray-500">Bấm Quét lại để tải video cũ hơn sát mốc.</p>
              )}
              {!scan && !hasAnchor && !scanning && <p className="text-[11px] text-gray-500">Bấm Quét lại để xem video mới và hai hướng.</p>}
              {redo && (
                <div className="rounded-md border border-amber-900/70 bg-amber-950/30 px-2 py-1.5 space-y-1">
                  {redo.known.map((row) => (
                    <p key={row.id} className="text-[11px] text-amber-100">
                      {row.title && row.title !== row.id ? `${row.title}. ` : ''}
                      {savedDay(row.at)
                        ? `Video này bạn đã tải vào ngày ${savedDay(row.at)}. Bạn có chắc muốn tải lại?`
                        : 'Video này bạn đã tải rồi. Bạn có chắc muốn tải lại?'}
                    </p>
                  ))}
                  <div className="flex gap-1">
                    <button type="button" onClick={() => void queueRows(redo.rows, redo.kind, true)} className="px-2 py-1 rounded text-[11px] font-bold bg-amber-700 hover:bg-amber-600 text-white">
                      Đồng ý
                    </button>
                    <button type="button" onClick={skipRedo} className="px-2 py-1 rounded text-[11px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800">
                      Không
                    </button>
                  </div>
                </div>
              )}
              {showNew && scan && (
                <div className="rounded-md border border-sky-900/70 bg-sky-950/30 px-2 py-1.5 space-y-1">
                  <p className="text-[11px] text-sky-100">
                    {scan.newCount > 0 ? `Có ${scan.newCount} video mới phía trước mốc.` : 'Chưa có video mới phía trước mốc.'}
                  </p>
                  {preview.length > 0 && (
                    <ul className="space-y-0.5">
                      {preview.map((row) => (
                        <li key={row.id} className="text-[10px] text-gray-300 truncate" title={row.title}>{row.title}</li>
                      ))}
                      {moreNew > 0 && <li className="text-[10px] text-gray-500">và {moreNew} video nữa</li>}
                    </ul>
                  )}
                  {scan.newCount > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {scan.newCount > scan.newVideos.length && (
                        <p className="w-full text-[10px] text-gray-400">Lần này tải {scan.newVideos.length} video gần mốc. Còn lại hỏi ở lần quét sau.</p>
                      )}
                      <button type="button" onClick={() => queueRows(scan.newVideos, 'video mới')} className="px-2 py-1 rounded text-[11px] font-bold bg-sky-700 hover:bg-sky-600 text-white">
                        Tải {scan.newVideos.length} video mới
                      </button>
                      <button type="button" onClick={() => setDismissedKey(scan.key)} className="px-2 py-1 rounded text-[11px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800">
                        Bỏ qua
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="rounded-md border border-gray-700 bg-gray-900/70 p-1.5 space-y-1">
                <div className="flex items-center justify-between gap-1">
                  <p className="text-[10px] font-semibold text-gray-200">Đã tải của kênh này</p>
                  {channelReceipts.length > 0 && (
                    <button type="button" onClick={() => onClearReceipts(selected.key)} className="px-1.5 py-0.5 rounded text-[10px] font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800">
                      Xóa hết
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-gray-500">Video đã lưu rời danh sách sau 7 ngày. Video chưa lưu được giữ lại.</p>
                {channelReceipts.length === 0 && <p className="text-[10px] text-gray-500">Chưa có video trong danh sách.</p>}
                <ul className="max-h-28 overflow-y-auto space-y-1">
                  {channelReceipts.map((row) => (
                    <li key={row.id} className="flex items-center gap-1.5">
                      <YoutubeWatchLink videoId={row.videoId} className="flex items-center gap-1.5 min-w-0 flex-1">
                        <MiniThumb videoId={row.videoId} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] text-gray-100 truncate" title={row.title}>{row.title || row.videoId}</span>
                          <span className="block text-[10px] text-gray-500">{row.saved ? 'đã lưu' : 'chưa lưu'}{(row.redownloads || 0) > 0 ? ` · tải lại ${row.redownloads} lần` : ''}</span>
                        </span>
                      </YoutubeWatchLink>
                      {row.saved && row.folder && (
                        <button
                          type="button"
                          data-open-folder={row.videoId}
                          onClick={() => onOpenFolder(row)}
                          className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 shrink-0"
                        >
                          Mở thư mục
                        </button>
                      )}
                      <button
                        type="button"
                        data-redownload={row.videoId}
                        onClick={() => onRedownload(row)}
                        className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 shrink-0"
                      >
                        Tải lại
                      </button>
                      <button
                        type="button"
                        onClick={() => onSaveReceipt(row.id, (selected.folder || sharedFolder).trim())}
                        className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800 shrink-0"
                      >
                        {row.saved ? 'Lưu bản sao' : 'Lưu về máy'}
                      </button>
                      <button type="button" onClick={() => onClearReceipt(row.id)} className="p-1 rounded text-gray-500 hover:text-red-300 hover:bg-gray-800" title="Xóa khỏi danh sách">
                        <X className="w-3 h-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
      {selected && (
        <JoinBox
          local={Array.isArray(scan?.local) ? scan.local : []}
          scanned={Boolean(scan)}
          order={joinOrder}
          dest={joinDest}
          presetId={joinPreset}
          presets={presets}
          chainName={chainName}
          joining={joining}
          scanning={scanning}
          note={joinNote(selected.key, presets)}
          attachNote={attachNote}
          onOrder={setJoinOrder}
          onDest={setJoinDest}
          onPreset={setJoinPreset}
          onChainName={setChainName}
          onAttachPreset={(kind) => attachPreset(kind)}
          onAttachEdit={(kind) => attachEdit(kind)}
          onJoin={() => { void joinVideos(); }}
        />
      )}
      {chainAsk && chainAsk.nextId === joinPreset && chainAsk.name.toLowerCase() === chainName.trim().toLowerCase() && (
        <div className="rounded-md border border-amber-900/70 bg-amber-950/30 px-2 py-1.5 space-y-1" data-chain-warn="1">
          <p className="text-[11px] text-amber-100">
            Chuỗi {chainAsk.name} đang dùng preset “{presetTitle(chainAsk.currentId)}”. Preset đang chọn là “{presetTitle(chainAsk.nextId)}”.
          </p>
          <div className="flex flex-wrap gap-1">
            <button type="button" data-chain-replace="1" onClick={() => writeChainPreset(chainAsk.nextId, false)} className="px-2 py-1 rounded text-[11px] font-bold bg-amber-700 hover:bg-amber-600 text-white">
              Đổi cả chuỗi sang “{presetTitle(chainAsk.nextId)}”
            </button>
            <button type="button" data-chain-keep="1" onClick={() => writeChainPreset(chainAsk.currentId, true)} className="px-2 py-1 rounded text-[11px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800">
              Giữ “{presetTitle(chainAsk.currentId)}”
            </button>
          </div>
        </div>
      )}
    </section>
  );

  function readJoinConfig(): unknown {
    try { return JSON.parse(localStorage.getItem(CONCAT_KEY) || '{}'); }
    catch { return {}; }
  }

  function writeJoinConfig(config: ReturnType<typeof readConcatConfig>) {
    try { localStorage.setItem(CONCAT_KEY, JSON.stringify(config)); }
    catch { /* the join still runs with the choice on screen */ }
  }

  function attachPreset(kind: 'channel' | 'chain') {
    if (!selected) return;
    if (kind === 'chain' && !chainName.trim()) {
      setNotice('Đặt tên chuỗi trước.');
      setAttachNote('');
      return;
    }
    if (!joinPreset) {
      setNotice('Chọn preset Unique trước.');
      setAttachNote('');
      return;
    }
    const current = readConcatConfig(readJoinConfig());
    if (kind === 'chain') {
      const existing = findChain(current, chainName);
      if (existing?.presetId && existing.presetId !== joinPreset) {
        setChainAsk({ name: existing.name, currentId: existing.presetId, nextId: joinPreset });
        setNotice('');
        setAttachNote('');
        return;
      }
    }
    const next = kind === 'channel'
      ? saveChannelPreset(current, selected.key, joinPreset)
      : saveChainPreset(current, selected.key, chainName, joinPreset);
    writeJoinConfig(next);
    const label = chainNameFor(next, selected.key);
    setChainName(label);
    setChainAsk(null);
    setNotice('');
    setAttachNote(savedPresetLine(kind, joinPreset, label));
    addLog(kind === 'channel'
      ? `[YT] Đã gắn preset Unique cho kênh ${selected.title}.`
      : `[YT] Đã gắn preset Unique cho chuỗi ${label}.`);
  }

  function savedPresetLine(kind: 'channel' | 'chain', presetId: string, chainLabel: string): string {
    const title = presetTitle(presetId);
    if (kind === 'channel') return `Đã gắn preset riêng “${title}”.`;
    if (chainLabel && title.toLowerCase() !== chainLabel.toLowerCase()) return `Đã gắn preset chuỗi “${chainLabel}” · “${title}”.`;
    return `Đã gắn preset chuỗi “${chainLabel || title}”.`;
  }

  function presetTitle(id: string): string {
    return presets.find((item) => item.id === id)?.name || 'preset không còn trong danh sách';
  }

  function writeChainPreset(presetId: string, kept: boolean) {
    if (!selected || !chainAsk) return;
    const current = readConcatConfig(readJoinConfig());
    const next = saveChainPreset(current, selected.key, chainAsk.name, presetId);
    writeJoinConfig(next);
    setJoinPreset(presetId);
    const label = chainNameFor(next, selected.key);
    setChainName(label);
    setChainAsk(null);
    setAttachNote(savedPresetLine('chain', presetId, label));
    const title = presetTitle(presetId);
    addLog(kept
      ? `[YT] Kênh ${selected.title} vào chuỗi ${chainAsk.name}, giữ preset “${title}”.`
      : `[YT] Chuỗi ${chainAsk.name} đổi sang preset “${title}”.`);
  }

  function attachEdit(kind: 'channel' | 'chain') {
    if (!selected) return;
    if (kind === 'chain' && !chainName.trim()) {
      setNotice('Đặt tên chuỗi trước.');
      setAttachNote('');
      return;
    }
    const profile = readEditProfile();
    if (!profile) return;
    const current = readConcatConfig(readJoinConfig());
    const next = kind === 'channel'
      ? saveChannelEdit(current, selected.key, profile)
      : saveChainEdit(current, selected.key, chainName, profile);
    writeJoinConfig(next);
    const label = chainNameFor(next, selected.key);
    setChainName(label);
    setNotice('');
    setAttachNote(kind === 'channel' ? 'Đã gắn Edit cho kênh này.' : `Đã gắn Edit cho chuỗi “${label}”.`);
    addLog(kind === 'channel'
      ? `[YT] Đã gắn cấu hình Edit đang mở cho kênh ${selected.title}.`
      : `[YT] Đã gắn cấu hình Edit đang mở cho chuỗi ${label}.`);
  }

  function presetPhrase(key: string, items: { id: string; name: string }[]): string {
    const source = presetSource(readConcatConfig(readJoinConfig()), key);
    const title = items.find((item) => item.id === source.presetId)?.name || '';
    const presetName = title || (source.presetId ? 'preset không còn trong danh sách' : '');
    if (source.kind === 'channel' && presetName) {
      return source.chainName ? `Preset riêng “${presetName}” · chuỗi “${source.chainName}”` : `Preset riêng “${presetName}”`;
    }
    if (source.kind === 'chain' && source.chainName) {
      return presetName && presetName.toLowerCase() !== source.chainName.toLowerCase()
        ? `Preset chuỗi “${source.chainName}” · “${presetName}”`
        : `Preset chuỗi “${source.chainName}”`;
    }
    return '';
  }

  function joinNote(key: string, items: { id: string; name: string }[]): string {
    const config = readConcatConfig(readJoinConfig());
    const parts: string[] = [];
    const phrase = presetPhrase(key, items);
    if (phrase) parts.push(phrase);
    if (editFor(config, key)) parts.push('cấu hình Edit đã gắn');
    return parts.length ? `${parts.join('. ')}.` : 'Chưa gắn cấu hình. Ghép sang Unique hoặc Edit sẽ dùng bảng đang mở.';
  }

  async function joinVideos() {
    if (!selected || joinOrder.length < 2 || joining) return;
    const local = Array.isArray(scan?.local) ? scan.local : [];
    const ids = joinOrder.map((index) => local[index]?.id || '');
    if (ids.some((id) => !id)) {
      setNotice('Danh sách số đã đổi. Quét lại rồi chọn lại.');
      setJoinOrder([]);
      return;
    }
    setJoining(true);
    setNotice('');
    try {
      const res = await fetch(`/api/youtube-channels/${encodeURIComponent(selected.key)}/concat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids,
          marks: joinOrder.map((index) => index + 1),
          sharedFolder: sharedFolder.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.path) {
        setNotice(data.error || 'Không ghép được.');
        return;
      }
      const config = readConcatConfig(readJoinConfig());
      onConcatenated({
        dest: joinDest,
        path: String(data.path),
        name: String(data.name || 'Ghep.mp4'),
        folder: String(data.folder || ''),
        size: Number(data.size) || 0,
        mode: data.mode === 'encode' ? 'encode' : 'copy',
        presetId: joinDest === 'unique' ? (joinPreset || presetFor(config, selected.key)) : '',
        edit: joinDest === 'edit' ? editFor(config, selected.key) : null,
      });
      setJoinOrder([]);
    } catch {
      setNotice('Không ghép được.');
    } finally {
      setJoining(false);
    }
  }
}

function JoinBox({
  local,
  scanned,
  order,
  dest,
  presetId,
  presets,
  chainName,
  joining,
  scanning,
  note,
  attachNote,
  onOrder,
  onDest,
  onPreset,
  onChainName,
  onAttachPreset,
  onAttachEdit,
  onJoin,
}: {
  local: VideoRow[];
  scanned: boolean;
  order: number[];
  dest: 'save' | 'unique' | 'edit';
  presetId: string;
  presets: { id: string; name: string }[];
  chainName: string;
  joining: boolean;
  scanning: boolean;
  note: string;
  attachNote: string;
  onOrder: (order: number[]) => void;
  onDest: (dest: 'save' | 'unique' | 'edit') => void;
  onPreset: (id: string) => void;
  onChainName: (name: string) => void;
  onAttachPreset: (kind: 'channel' | 'chain') => void;
  onAttachEdit: (kind: 'channel' | 'chain') => void;
  onJoin: () => void;
}) {
  const add = (index: number) => {
    if (order.includes(index) || order.length >= 20) return;
    onOrder([...order, index]);
  };
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/70 p-2 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold text-gray-200">Ghép video của kênh này</p>
        <p className="text-[10px] text-gray-500 truncate">1 là video mới nhất đã có file. Bấm số theo thứ tự nối.</p>
      </div>
      {local.length === 0 && (
        <p className="text-[10px] text-gray-500">{scanning ? 'Đang quét, vui lòng chờ.' : scanned ? 'Chưa có file trong thư mục của kênh.' : 'Quét lại để hiện số trên video đã có file.'}</p>
      )}
      {local.length > 0 && (
        <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">
          {local.map((row, index) => (
            <span key={row.id} className="inline-flex items-center max-w-full">
              <button
                type="button"
                data-concat={row.id}
                onClick={() => add(index)}
                className={`px-1.5 py-0.5 rounded-l text-[10px] font-semibold truncate max-w-[14rem] ${
                  order.includes(index) ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-100 hover:bg-gray-700'
                }`}
                title={row.title}
              >
                {index + 1} {row.title}
              </button>
              <YoutubeWatchLink videoId={row.id} className="px-1 py-0.5 rounded-r bg-gray-800 text-[10px] text-sky-300 hover:bg-gray-700">
                mở
              </YoutubeWatchLink>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1">
        <p className="text-[10px] text-gray-300" data-join-order={order.map((index) => index + 1).join('-') || '0'}>
          {order.length ? `Thứ tự: ${order.map((index) => index + 1).join(' → ')}` : 'Chưa chọn video.'}
        </p>
        {order.length > 0 && (
          <button type="button" onClick={() => onOrder([])} className="px-1.5 py-0.5 rounded text-[10px] border border-gray-700 text-gray-300 hover:bg-gray-800">
            Xóa thứ tự
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <select
          value={dest}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'save' || value === 'unique' || value === 'edit') onDest(value);
          }}
          className="bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-100"
          aria-label="Việc làm sau khi ghép"
        >
          <option value="save">Chỉ lưu file</option>
          <option value="unique">Đẩy sang Unique</option>
          <option value="edit">Đẩy sang Edit</option>
        </select>
        {dest === 'unique' && (
          <select
            value={presets.some((item) => item.id === presetId) ? presetId : ''}
            onChange={(e) => onPreset(e.target.value)}
            className="bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-100"
            aria-label="Preset Unique"
          >
            <option value="">Chọn preset Unique</option>
            {presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        )}
        {dest !== 'save' && (
          <input
            value={chainName}
            onChange={(e) => onChainName(e.target.value)}
            placeholder="Tên nhóm, ví dụ Violin"
            className="w-28 bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-100"
          />
        )}
        {dest === 'unique' && (
          <>
            <button type="button" onClick={() => onAttachPreset('channel')} className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800">Gắn preset cho kênh</button>
            <button type="button" onClick={() => onAttachPreset('chain')} className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800">Gắn preset cho chuỗi</button>
          </>
        )}
        {dest === 'edit' && (
          <>
            <button type="button" onClick={() => onAttachEdit('channel')} className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800">Gắn Edit cho kênh</button>
            <button type="button" onClick={() => onAttachEdit('chain')} className="px-1.5 py-1 rounded text-[10px] font-semibold border border-gray-700 text-gray-200 hover:bg-gray-800">Gắn Edit cho chuỗi</button>
          </>
        )}
        <button
          type="button"
          onClick={onJoin}
          disabled={order.length < 2 || joining}
          className="px-2 py-1 rounded text-[11px] font-bold bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-500 text-white"
        >
          {joining ? 'Đang ghép' : 'Ghép'}
        </button>
      </div>
      {attachNote && <p className="text-[11px] text-emerald-300" data-attach-note="1">{attachNote}</p>}
      <p className="text-[10px] text-gray-500" data-preset-source="1">{note} File gốc giữ nguyên. Đẩy sang Unique hoặc Edit thì tự chạy ngay, không cần bấm Start. Thư mục chung ghép được khi chưa đặt thư mục riêng.</p>
    </div>
  );
}
