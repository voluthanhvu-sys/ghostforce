import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Upload, Play, Pause, Save, RefreshCw, ShieldAlert, FileVideo, Activity, Terminal, CheckCircle2, Cpu, Settings2, VolumeX, Focus, Sparkles, Share2, Fingerprint, Hash, Server, ScanSearch, X, FolderOpen, Pencil, Monitor, GripVertical, Square, Trash2, Scissors, Layers, Clock, ArrowRight, Key, Smartphone, Download, RotateCw, TrendingUp } from 'lucide-react';
import type { PlatformMode, ProcessingStats, QueueResult, QueueClip, EditSegment, AppTab } from './types';

type UniqueLook = {
    platformMode: PlatformMode;
    uniqueStrength: 'light' | 'standard' | 'strong' | 'extreme';
    rotateMode: string;
    enableAdversarial: boolean;
    enableAudioAttack: boolean;
    enableTikTokCanvas: boolean;
    featherEnabled: boolean;
    featherTop: number;
    featherBottom: number;
    enableSmooth: boolean;
    smoothMode: 'fast' | 'ai';
    enableCaptions: boolean;
    captionPlace: 'middle' | 'bottom';
    enablePgd: boolean;
    enablePgdOnly: boolean;
    pgdLevel: 'light' | 'medium' | 'strong' | 'extreme' | 'visible';
    encoderMode: 'auto' | 'cpu' | 'nvidia' | 'intel';
};
type NamedPreset = { id: string; name: string; settings: UniqueLook };
import { fmtTs, fmtDur, formatBytes, formatDuration, shortHash, resLabel, codecLabel } from './lib/format';
import { safeFileName, newClipId } from './lib/files';
import { persistDirHandle, loadDirHandle, dirPermission } from './lib/directory-store';
import { LogViewer } from './components/LogViewer';
import { appendDisplayLog, logChannel } from './lib/log-channels.js';
import { NAMED_PRESET_KEY, createNamedPreset, describeUniquePreset, normalizeUniqueSettings, readPresetList, rotatePartsFrom, updateNamedPreset } from './lib/unique-presets.js';
import * as editProfile from './lib/edit-profile.js';
// A named import used in `typeof` is dropped by the bundler even though the
// function is called below, which leaves the Unique screen blank.
const normalizeEditProfile = editProfile.normalizeEditProfile;
type EditProfile = NonNullable<ReturnType<typeof normalizeEditProfile>>;
import { TrendsPanel } from './components/TrendsPanel';
import { YoutubeImportBox, type YoutubeImportFile } from './components/YoutubeImportBox';
// Pure helper only (no fs / no ffmpeg / no job access), shared with the backend so
// the quality-guard rule has exactly one definition and a unit test behind it.
import { SEAM_VERDICT, seamVerdict } from '../server/perceptual-hash.js';

const DEFAULT_EDIT_PROMPT = `Hãy đóng vai một biên tập viên video chuyên nghiệp. Xem và nghe toàn bộ video rồi cắt ra những phần đáng đăng nhất.
1. Tự quyết định số phần dựa trên nội dung — không cần cố định số tập. Bỏ qua đoạn không đáng xem: quảng cáo, tài trợ, intro/outro, credit, đoạn lan man, đoạn lặp.
2. Mỗi phần dài hơn 1 phút và KHÔNG có mức tối đa: phần nào hay thì để dài. Không chia đều theo đồng hồ và không tách một đoạn hay ra cho đủ số phần.
3. Mỗi phần là MỘT khúc liền mạch trên timeline, đúng thứ tự; không xáo trộn mảnh, không lấy đoạn ở phút sau làm hook.
4. Điểm cắt phải rơi đúng frame nhìn thấy trong video; rà soát kỹ timestamp để không bỏ sót nội dung và không cắt lệch.
5. Đặt tiêu đề tiếng Anh ngắn gọn (3–8 từ) cho từng phần, thể hiện đúng nội dung phần đó và không trùng nhau; kèm bản dịch tiếng Việt.
6. Nếu có yêu cầu riêng bên dưới (ví dụ tập trung cảnh hành động, giọng hài, ưu tiên một nhân vật...), ưu tiên yêu cầu đó khi chọn đoạn và đặt tiêu đề.
Tổng hợp kết quả: tiêu đề phần — thời gian bắt đầu — kết thúc — tổng thời lượng, thành bảng danh sách.`;

type ReplayPartRow = {
    id: string;
    partIndex: number;
    partName: string;
    start: number;
    end: number;
    ranges: Array<[number, number]>;
    score: number | null;
    durationSec: number;
};

type ReplayVideoRow = {
    sourcePath: string;
    sourceName: string;
    sourceAvailable: boolean;
    newestAt: string;
    parts: ReplayPartRow[];
};

const replayPartTitle = (name: string, index: number) => {
    const text = String(name || '')
        .replace(/\.(mp4|mov|webm|mkv|m4v)$/i, '')
        .replace(/^TEST Part \d+\s*-\s*/i, '')
        .replace(/^\d+\.\s*/, '')
        .trim();
    return text || `Part ${index}`;
};

const replayVideoTitle = (name: string) => String(name || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(mp4|mov|webm|mkv|m4v)$/i, '')
    .trim() || 'Video';

const replayDay = (at: string) => {
    const match = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}` : '';
};

const APP_TAB_KEY = 'gf_app_tab';
const APP_TABS: readonly AppTab[] = ['unique', 'edit', 'reframe', 'youtube', 'trends'];

function readStoredAppTab(): AppTab {
    try {
        const raw = localStorage.getItem(APP_TAB_KEY);
        if (raw && (APP_TABS as readonly string[]).includes(raw)) return raw as AppTab;
    } catch { /* a blocked store opens Unique */ }
    return 'unique';
}

export default function App() {
    const [files, setFiles] = useState<QueueClip[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [progress, setProgress] = useState(0);
    const [pgdProgress, setPgdProgress] = useState(0);
    const [pgdActive, setPgdActive] = useState(false);
    const [sidePhase, setSidePhase] = useState<'smooth' | 'caption' | ''>('');
    const [sideProgress, setSideProgress] = useState(0);
    // "Còn lại bao lâu" per phase, from the backend's etaMs (FFmpeg's own speed for the
    // encode, the frame rate of the PGD attack). null = not known yet, so the UI shows
    // nothing rather than a guess.
    const [progressEtaMs, setProgressEtaMs] = useState<number | null>(null);
    const [pgdEtaMs, setPgdEtaMs] = useState<number | null>(null);
    type LogBucket = 'unique' | 'edit' | 'reframe' | 'youtube';
    const emptyLogBuckets = (): Record<LogBucket, string[]> => ({ unique: [], edit: [], reframe: [], youtube: [] });
    const [logsByChannel, setLogsByChannel] = useState<Record<LogBucket, string[]>>(emptyLogBuckets);
    const [stats, setStats] = useState<ProcessingStats | null>(null);
    // Per-video detail popup. The panel is no longer rendered inline on the page:
    // it opens from a finished row in the Completed list, so each video keeps its
    // own numbers instead of the newest one overwriting the view.
    const [detailOpen, setDetailOpen] = useState(false);
    const [detailName, setDetailName] = useState('');
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [queueResults, setQueueResults] = useState<QueueResult[]>(() => {
        try {
            const raw = sessionStorage.getItem('gf_completed');
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    });
    const [queueIndex, setQueueIndex] = useState(0);
    const [queueTotal, setQueueTotal] = useState(0);
    const [activeQueueIds, setActiveQueueIds] = useState<string[]>([]);
    const [parallelJobs, setParallelJobs] = useState<1 | 2>(() => {
        try { return localStorage.getItem('gf_parallel') === '1' ? 1 : 2; } catch { return 2; }
    });
    
    // Advanced Feature States
    const [enableAdversarial, setEnableAdversarial] = useState(true);
    const [enableAudioAttack, setEnableAudioAttack] = useState(true);
    const [enableTikTokCanvas, setEnableTikTokCanvas] = useState(false);
    const [enablePgd, setEnablePgd] = useState(false);
    const [enablePgdOnly, setEnablePgdOnly] = useState(false);
    const [enableSmooth, setEnableSmooth] = useState(false);
    const [smoothMode, setSmoothMode] = useState<'fast' | 'ai'>('fast');
    const [enableCaptions, setEnableCaptions] = useState(false);
    const [captionPlace, setCaptionPlace] = useState<'middle' | 'bottom'>('middle');
    // Off by default: the CLIP row needs the GPU (it queues behind another video's PGD) and the
    // harsh 720 row re-encodes the whole clip, so both are the reason a finished video can sit
    // waiting for minutes. The cheap rows always run.
    const [enableFullMeasure, setEnableFullMeasure] = useState(false);
    // Session memory for the Python/CUDA check behind the PGD switch: the endpoint imports
    // torch + open_clip (~3 s), so it is called once and the answer reused.
    const pgdStatusRef = useRef<'unknown' | 'ready' | 'missing'>('unknown');
    // Default raised to strong on 2026-10-01: measured +4.7 points of post-re-encode
    // CLIP distance against medium at the SAME wall time (the attack is frame-I/O
    // bound, not step bound), so the weakest useful level is now the default.
    const [pgdLevel, setPgdLevel] = useState<'light' | 'medium' | 'strong' | 'extreme' | 'visible'>('strong');
    const [updateCopyMsg, setUpdateCopyMsg] = useState('');
    const [updateView, setUpdateView] = useState<{ label: string; text: string } | null>(null);
    const [showUpdateBar, setShowUpdateBar] = useState(() => {
        try { return localStorage.getItem('gf_hide_update_bar') === '0'; } catch { return false; }
    });
    const [unfinishedNotice, setUnfinishedNotice] = useState<string[]>(() => {
        try {
            const raw = sessionStorage.getItem('gf_unfinished');
            const names = raw ? JSON.parse(raw) : [];
            return Array.isArray(names) ? names : [];
        } catch { return []; }
    });
    const [platformMode, setPlatformMode] = useState<PlatformMode>('auto');
    const [uniqueStrength, setUniqueStrength] = useState<'light' | 'standard' | 'strong' | 'extreme'>(() => {
        try {
            const stored = localStorage.getItem('gf_unique_strength');
            return stored === 'light' || stored === 'standard' || stored === 'strong' || stored === 'extreme' ? stored : 'strong';
        } catch { return 'strong'; }
    });
    const [featherTop, setFeatherTop] = useState<number>(() => {
        try { return Number(localStorage.getItem('gf_feather_top')) || 0; } catch { return 0; }
    });
    const [featherBottom, setFeatherBottom] = useState<number>(() => {
        try { return Number(localStorage.getItem('gf_feather_bottom')) || 0; } catch { return 0; }
    });
    const [featherEnabled, setFeatherEnabled] = useState<boolean>(() => {
        try { return localStorage.getItem('gf_feather_on') === '1'; } catch { return false; }
    });
    // One control instead of two: a static tilt and a wobble are mutually exclusive
    // (wobble overrides the tilt server-side), so a single mode select avoids teaching the
    // operator an interaction rule they would have to remember.
    const [rotateMode, setRotateMode] = useState<string>(() => {
        try { return localStorage.getItem('gf_rotate_mode') || 'off'; } catch { return 'off'; }
    });
    const pgdOnlyActive = enablePgd && enablePgdOnly;
    // Named presets are snapshots. Opening the app must not re-apply one: that used to
    // write a stored "Cực mạnh" back to "Mạnh" on every mount.
    const [namedPresets, setNamedPresets] = useState<NamedPreset[]>(() => {
        try { return readPresetList(JSON.parse(localStorage.getItem(NAMED_PRESET_KEY) || '[]')) as NamedPreset[]; }
        catch { return []; }
    });
    const [presetName, setPresetName] = useState('');
    const [presetError, setPresetError] = useState('');
    const [viewPresetId, setViewPresetId] = useState('');
    const [editingPresetId, setEditingPresetId] = useState('');
    const [pickedPresetId, setPickedPresetId] = useState('');
    const [presetNotice, setPresetNotice] = useState('');
    const presetNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (presetNoticeTimer.current) clearTimeout(presetNoticeTimer.current);
    }, []);
    const showPresetNotice = (text: string) => {
        setPresetNotice(text);
        if (presetNoticeTimer.current) clearTimeout(presetNoticeTimer.current);
        presetNoticeTimer.current = setTimeout(() => {
            presetNoticeTimer.current = null;
            setPresetNotice('');
        }, 2500);
    };
    const hidePresetNotice = () => {
        if (presetNoticeTimer.current) clearTimeout(presetNoticeTimer.current);
        presetNoticeTimer.current = null;
        setPresetNotice('');
    };
    const [handoffPresetId, setHandoffPresetId] = useState(() => {
        try { return localStorage.getItem('gf_unique_handoff_preset') || ''; } catch { return ''; }
    });
    const namedPresetsRef = useRef(namedPresets);
    namedPresetsRef.current = namedPresets;
    const lookRef = useRef<UniqueLook | null>(null);
    const runPresetNameRef = useRef('');
    const runPresetMissingRef = useRef(false);
    const editRunRef = useRef<EditProfile | null>(null);
    const handoffRef = useRef<(presetId: string) => void>(() => {});
    const startUniqueRef = useRef<() => void>(() => {});
    const startEditRef = useRef<() => void>(() => {});
    const startReframeRef = useRef<() => void>(() => {});
    const saveNamedPresets = (next: NamedPreset[]) => {
        namedPresetsRef.current = next;
        setNamedPresets(next);
        try { localStorage.setItem(NAMED_PRESET_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    };
    const applyLook = (settings: UniqueLook) => {
        const next = normalizeUniqueSettings(settings) as UniqueLook;
        lookRef.current = next;
        setPlatformMode(next.platformMode);
        setUniqueStrength(next.uniqueStrength);
        setRotateMode(next.rotateMode);
        setEnableAdversarial(next.enableAdversarial);
        setEnableAudioAttack(next.enableAudioAttack);
        setEnableTikTokCanvas(next.enableTikTokCanvas);
        setFeatherEnabled(next.featherEnabled);
        setFeatherTop(next.featherTop);
        setFeatherBottom(next.featherBottom);
        setEnableSmooth(next.enableSmooth);
        setSmoothMode(next.smoothMode === 'ai' ? 'ai' : 'fast');
        setEnableCaptions(next.enableCaptions);
        setCaptionPlace(next.captionPlace === 'bottom' ? 'bottom' : 'middle');
        setEnablePgd(next.enablePgd);
        setEnablePgdOnly(next.enablePgdOnly);
        setPgdLevel(next.pgdLevel);
        setEncoderMode(next.encoderMode);
        try {
            localStorage.setItem('gf_unique_strength', next.uniqueStrength);
            localStorage.setItem('gf_rotate_mode', next.rotateMode);
            localStorage.setItem('gf_feather_on', next.featherEnabled ? '1' : '0');
            localStorage.setItem('gf_feather_top', String(next.featherTop));
            localStorage.setItem('gf_feather_bottom', String(next.featherBottom));
        } catch { /* ignore */ }
    };
    const chooseSavedPreset = (id: string) => {
        setPickedPresetId(id);
        const item = namedPresets.find((row) => row.id === id);
        if (!item) {
            if (editingPresetId) {
                setEditingPresetId('');
                setPresetName('');
                setPresetError('');
            }
            return;
        }
        applyLook(item.settings);
        if (editingPresetId && editingPresetId !== item.id) {
            setEditingPresetId('');
            setPresetName('');
            setPresetError('');
        }
        addLog(`[SYS] Đã áp preset “${item.name}” lên bảng.`);
    };
    const chooseHandoffPreset = (id: string) => {
        setHandoffPresetId(id);
        try { localStorage.setItem('gf_unique_handoff_preset', id); } catch { /* ignore */ }
    };
    // Verdict bands come from the live measurements on this project: ~5% for a mild pass,
    // ~22% for "Chuẩn", ~38-39% for "Mạnh", ~44% when the canvas changes. They describe
    // how far the picture moved, NOT whether a platform will accept the file.
    // The pHash band is deliberately separate and deliberately lax: pHash only sees
    // structure coarser than ~1/8 of the frame, so a low number is normal and must not
    // be read as "the pass did nothing" - the dHash band above is the sensitive one.
    const pHashVerdict = (() => {
        const d = stats?.perceptualPHash;
        if (typeof d !== 'number' || !Number.isFinite(d)) return null;
        if (d < 0.10) return { text: 'CẤU TRÚC LỚN GẦN NHƯ GIỮ NGUYÊN', tone: 'warn' as const };
        if (d < 0.25) return { text: 'CẤU TRÚC LỚN LỆCH VỪA', tone: 'info' as const };
        return { text: 'CẤU TRÚC LỚN LỆCH RÕ', tone: 'ok' as const };
    })();
    // Reading the grid: a high worst-cell with a low average means one region moved
    // (a seam, a caption, one object); a high average means the whole frame moved.
    const blockVerdict = (() => {
        const worst = stats?.perceptualBlockWorst;
        const mean = stats?.perceptualBlockMean;
        if (typeof worst !== 'number' || !Number.isFinite(worst)) return null;
        if (worst < 0.5) return { text: 'ÍT ĐỔI', tone: 'info' as const };
        if (typeof mean === 'number' && Number.isFinite(mean) && mean < 0.5) return { text: 'LỆCH CỤC BỘ', tone: 'warn' as const };
        return { text: 'ĐỔI RỘNG', tone: 'ok' as const };
    })();
    // Same settings run twice do NOT give the same number: the pipeline draws new
    // zoom/shake/colour/grain/encoder values per job, and repeated runs on this
    // project's own clips spread by ~3 points (worst case ~5). So a single reading
    // may not be compared against another single reading - the band is what the
    // operator should read, and a value sitting on a band edge is not a verdict.
    const PERCEPTUAL_RUN_NOISE = 0.03;
    const PERCEPTUAL_BAND_EDGES = [0.10, 0.25, 0.40];
    const perceptualVerdict = (() => {
        const d = stats?.perceptualDistance;
        if (typeof d !== 'number' || !Number.isFinite(d)) return null;
        const nearEdge = PERCEPTUAL_BAND_EDGES.some((edge) => Math.abs(d - edge) <= PERCEPTUAL_RUN_NOISE);
        const tail = nearEdge ? ' · sát ranh giới — chạy lại để chắc, đừng đổi cài đặt vì một lần chạy' : '';
        if (d < 0.10) return { text: 'RẤT GẦN NGUỒN', tone: 'warn' as const, note: 'Gần như không đổi — cân nhắc tăng Độ khác biệt' + tail, nearEdge };
        if (d < 0.25) return { text: 'KHÁC NHẸ', tone: 'warn' as const, note: 'Có khác nhưng còn nhẹ' + tail, nearEdge };
        if (d < 0.40) return { text: 'KHÁC RÕ', tone: 'ok' as const, note: 'Mức thường đạt ở thiết lập Mạnh' + tail, nearEdge };
        return { text: 'KHÁC NHIỀU', tone: 'ok' as const, note: 'Mức cao — thường do đổi canvas/bố cục' + tail, nearEdge };
    })();
    // Quality guard: a higher similarity number is not evidence that the picture is
    // usable, so the render is checked for a hard horizontal edge and compared with
    // the file that went in. A seam the source already had is reported as such, not
    // blamed on Unique.
    const seamCheck = (() => {
        if (!stats?.seamFrames) return null;
        const verdict = seamVerdict(stats.seamIn, stats.seamOut);
        if (verdict === SEAM_VERDICT.SOURCE) {
            return {
                text: 'FILE VÀO ĐÃ CÓ VẠCH',
                tone: 'warn' as const,
                note: `Vạch có sẵn trong file bạn đưa vào (${stats.seamIn} luma/1 hàng ở y≈${stats.seamInRowPct}%) — Unique không tạo ra nó. Nếu đây là clip contain/fill từ Edit thì ô LÀM MỀM VIỀN của Unique KHÔNG sửa được (cửa sổ hình di chuyển theo người nói); cần xử lý ở tab Edit.`,
            };
        }
        if (verdict === SEAM_VERDICT.ADDED) {
            return { text: 'UNIQUE TẠO VẠCH MỚI', tone: 'warn' as const, note: 'Vạch chỉ xuất hiện sau khi Unique xử lý, file vào không có — kiểm tra lại file render trước khi dùng, và báo lại vì đây là lỗi của pipeline.' };
        }
        return { text: 'KHÔNG CÓ VẠCH', tone: 'ok' as const, note: `Đã dò ${stats.seamFrames} khung, không hàng nào nhảy vọt so với hàng kề nó.` };
    })();
    // Audio rows. The picture had dHash/pHash/seam; the sound had no number at all, so a
    // run could not say whether the audio side changed or how. Two readings, both from
    // the same measured windows as the picture: the loudness per second and the energy of
    // three frequency bands per second.
    //   "lệch"  = a fixed change this pass applied (EQ tĩnh / âm lượng),
    //   "trôi"  = how much that change MOVES from second to second - the part a static
    //             EQ or a one-shot volume change cannot produce.
    // Honest limits: measured on the first ~2 minutes of the render, content dependent
    // (only output-vs-source at the same moment is comparable), and NOT a platform
    // audio-fingerprint verdict.
    const dbSigned = (value?: number | null, digits = 1) => (typeof value === 'number' && Number.isFinite(value)
        ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
        : '?');
    // "còn ~1m 20s" for the progress bars. Anything under a second is noise, so it is hidden.
    const etaLabel = (ms?: number | null) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return null;
        const totalSeconds = Math.round(ms / 1000);
        if (totalSeconds < 60) return `~${totalSeconds}s`;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `~${minutes}m ${String(seconds).padStart(2, '0')}s`;
    };
    const audioLevelVerdict = (() => {
        const drift = stats?.audioLevelDriftDb;
        if (typeof drift !== 'number' || !Number.isFinite(drift)) return null;
        if (drift >= 0.5) return { text: `MỨC TRÔI ±${drift.toFixed(2)} dB/GIÂY`, tone: 'ok' as const, note: 'Độ to đổi dần theo từng giây. Tai thường không nhận ra, nhưng dấu vân tay âm thanh phải tính lại theo thời gian.' };
        if (drift >= 0.15) return { text: `MỨC ĐỔI NHẸ ±${drift.toFixed(2)} dB/GIÂY`, tone: 'info' as const, note: 'Có nhích theo thời gian nhưng rất nhẹ — gần như chỉ là một mức âm lượng cố định.' };
        return { text: `MỨC GẦN NHƯ ĐỨNG YÊN (±${drift.toFixed(2)} dB)`, tone: 'info' as const, note: 'Lượt này chỉ đổi âm lượng ở một mức cố định, không trôi theo thời gian.' };
    })();
    const audioBandVerdict = (() => {
        const drift = stats?.audioBandDriftDb;
        if (typeof drift !== 'number' || !Number.isFinite(drift)) return null;
        if (drift >= 0.5) return { text: `PHỔ TRÔI ±${drift.toFixed(2)} dB/GIÂY`, tone: 'ok' as const, note: 'Có dải tần đổi dần theo từng giây (EQ trôi), không phải một mức EQ cố định cho cả clip.' };
        if (drift >= 0.15) return { text: `PHỔ ĐỔI NHẸ ±${drift.toFixed(2)} dB/GIÂY`, tone: 'info' as const, note: 'Phổ có nhích theo thời gian nhưng nhẹ.' };
        return { text: `PHỔ ĐỨNG YÊN (±${drift.toFixed(2)} dB)`, tone: 'info' as const, note: 'Lượt này chỉ đổi phổ ở một mức cố định (EQ tĩnh). Phổ không trôi theo thời gian.' };
    })();
    // Semantic row: CLIP embedding distance between the render and the source, measured
    // locally with the same ViT-B-32 that PGD uses (no API). dHash/pHash say how much the
    // PICTURE moved; this says how much the CONTENT moved. Bands are calibrated on this
    // project's own measurements with this exact method on a 4s 1080x1920 clip:
    // Unique Light 0.9454, PGD-only light 0.9121, Unique Strong 0.8798 (identity = 1.0000).
    const clipVerdict = (() => {
        const d = stats?.clipSimOut;
        if (typeof d !== 'number' || !Number.isFinite(d)) return null;
        if (d >= 0.98) return { text: 'NỘI DUNG GẦN NHƯ GIỐNG', tone: 'warn' as const, note: 'Hầu như không đổi nội dung - cân nhắc tăng mức khác biệt hoặc mức PGD.' };
        if (d >= 0.94) return { text: 'LỆCH NHẸ', tone: 'info' as const, note: 'Mức nhẹ - cỡ mức Khác biệt "Nhẹ" (đo được ~0.945).' };
        if (d >= 0.90) return { text: 'LỆCH VỪA', tone: 'ok' as const, note: 'Mức vừa - cỡ PGD nhẹ (đo được ~0.912).' };
        return { text: 'LỆCH RÕ', tone: 'ok' as const, note: 'Lệch nhiều - mức Khác biệt "Mạnh" đo được ~0.88.' };
    })();
    const [encoderMode, setEncoderMode] = useState<'auto' | 'cpu' | 'nvidia' | 'intel'>('auto');
    const currentLook = (): UniqueLook => normalizeUniqueSettings({
        platformMode, uniqueStrength, rotateMode,
        enableAdversarial, enableAudioAttack, enableTikTokCanvas,
        featherEnabled, featherTop, featherBottom,
        enableSmooth, smoothMode, enableCaptions, captionPlace, enablePgd, enablePgdOnly, pgdLevel, encoderMode,
    }) as UniqueLook;
    lookRef.current = currentLook();
    const [encoderCaps, setEncoderCaps] = useState<{ cpu: boolean; nvidia: boolean; intel: boolean; nvidiaListed?: boolean }>({ cpu: true, nvidia: false, intel: false });
    const [isDragging, setIsDragging] = useState(false);
    const [saveFolderName, setSaveFolderName] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renamingQueueId, setRenamingQueueId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>(() => {
        try {
            const raw = sessionStorage.getItem('gf_selected');
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    });
    const [folderReady, setFolderReady] = useState(false);
    const [saveNotice, setSaveNotice] = useState<string | null>(null);
    const [osSavePath, setOsSavePath] = useState(() => {
        try { return localStorage.getItem('gf_save_path') || ''; } catch { return ''; }
    });
    const fileInputRef = useRef<HTMLInputElement>(null);
    const saveDirRef = useRef<FileSystemDirectoryHandle | null>(null);
    const cancelRef = useRef(false);
    const pauseRef = useRef(false);
    const processingRef = useRef(false);
    const uniqueEpochRef = useRef(0);
    const claimedRef = useRef<Set<string>>(new Set());
    const queueTotalRef = useRef(0);
    const jobsRef = useRef<Set<string>>(new Set());
    const sourcesRef = useRef<Map<string, EventSource>>(new Map());
    const progressMapRef = useRef<Record<string, number>>({});
    const pgdMapRef = useRef<Record<string, number>>({});
    const dragFromRef = useRef<number | null>(null);
    const filesRef = useRef<QueueClip[]>([]);
    filesRef.current = files;

    const [appTab, setAppTab] = useState<AppTab>(readStoredAppTab);
    useEffect(() => {
        try { localStorage.setItem(APP_TAB_KEY, appTab); } catch { /* the next refresh opens Unique */ }
    }, [appTab]);
    const [editFiles, setEditFiles] = useState<QueueClip[]>([]);
    const editFilesRef = useRef<QueueClip[]>([]);
    editFilesRef.current = editFiles;
    const [editDragging, setEditDragging] = useState(false);
    const [editSplit, setEditSplit] = useState(() => {
        try {
            const n = Number(localStorage.getItem('gf_edit_split'));
            return Number.isFinite(n) && n >= 2 && n <= 12 ? n : 6;
        } catch { return 6; }
    });
    const [editMinSec, setEditMinSec] = useState(() => {
        try {
            const n = Number(localStorage.getItem('gf_edit_minsec'));
            return Number.isFinite(n) && n >= 60 && n <= 300 ? n : 60;
        } catch { return 60; }
    });
    const [editAutoParts, setEditAutoParts] = useState(() => {
        try { return localStorage.getItem('gf_edit_parts_mode') === 'auto'; } catch { return false; }
    });
    const [editFadeFx, setEditFadeFx] = useState(() => {
        try { return localStorage.getItem('gf_edit_fade') === 'true'; } catch { return false; }
    });
    const [editMode, setEditMode] = useState<'even' | 'ai'>(() => {
        try { return localStorage.getItem('gf_edit_mode') === 'even' ? 'even' : 'ai'; } catch { return 'ai'; }
    });
    const [editEncoderMode, setEditEncoderMode] = useState<'auto' | 'cpu' | 'nvidia' | 'intel'>(() => {
        try {
            const value = localStorage.getItem('gf_edit_encoder');
            return value === 'cpu' || value === 'nvidia' || value === 'intel' ? value : 'auto';
        } catch { return 'auto'; }
    });
    const [editSegments, setEditSegments] = useState<EditSegment[]>([]);
    // (B) summary of the last finished run: source, parts with their own
    // timecodes + finish clock, and every dropped stretch.
    const [editRunSummary, setEditRunSummary] = useState<{
        sourceName: string; totalSec: number; keptSec: number; droppedSec: number;
        dropped: { start: number; end: number; sec: number }[];
        parts: { partIndex: number; name: string; title: string; start: number; end: number; dur: number; qa: { score: number; grade: string; warnings: string[] } | null; detailModelUsed?: string; finishedAt: string | null; elapsedMs: number | null }[];
        totalElapsedMs: number; sttCompact?: boolean;
        detailModelsUsed?: string[];
        geminiCost?: {
            calls: number; pricedCalls: number; totalUsd: number; totalVnd: number; totalTokens: number;
            byModel: { model: string; calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; usd: number; vnd: number }[];
            byLabel: { label: string; calls: number; tokens: number; usd: number; vnd: number }[];
            unknownModels: string[];
        };
    } | null>(null);
    const [partTestHistory, setPartTestHistory] = useState<EditSegment[]>([]);
    const [replayCatalog, setReplayCatalog] = useState<ReplayVideoRow[]>([]);
    const [replayQuery, setReplayQuery] = useState('');
    const [replayOpenPath, setReplayOpenPath] = useState<string | null>(null);
    const [replayShowMissing, setReplayShowMissing] = useState(false);
    const [replaySelected, setReplaySelected] = useState<string[]>([]);
    const [replayRunId, setReplayRunId] = useState<string | null>(null);
    const [replayRunSource, setReplayRunSource] = useState('');
    const [editRenamingId, setEditRenamingId] = useState<string | null>(null);
    const [editSelectedIds, setEditSelectedIds] = useState<string[]>([]);
    const [editGroupSave, setEditGroupSave] = useState<Record<string, { folder: string; error: string; saved: number; total: number }>>({});
    const [editGroupBusyId, setEditGroupBusyId] = useState('');
    const editInputRef = useRef<HTMLInputElement>(null);
    const editDragFromRef = useRef<number | null>(null);
    const [editPrompt, setEditPrompt] = useState(() => {
        try {
            const saved = localStorage.getItem('gf_edit_prompt') || '';
            if (!saved || /Số tập do bạn quyết|không bị gán sẵn|không ép 6|KHÓA 6 TẬP|nhắm 4 mảnh|hook 2–6s/i.test(saved)) {
                return DEFAULT_EDIT_PROMPT;
            }
            return saved;
        } catch { return DEFAULT_EDIT_PROMPT; }
    });
    const [editGeminiAccounts, setEditGeminiAccounts] = useState<{ email: string; secret: string }[]>(() => {
        try {
            const saved = localStorage.getItem('gf_gemini_accounts');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length) {
                    return parsed.slice(0, 20).map((row) => ({
                        email: String(row?.email || ''),
                        secret: String(row?.secret || ''),
                    }));
                }
            }
            const main = localStorage.getItem('gf_gemini_key') || '';
            const extras = (localStorage.getItem('gf_gemini_keys_extra') || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            const secrets = [main, ...extras].map((secret) => secret.trim()).filter((secret, index, all) => secret && all.indexOf(secret) === index);
            return secrets.length ? secrets.map((secret) => ({ email: '', secret })) : [{ email: '', secret: '' }];
        } catch { return [{ email: '', secret: '' }]; }
    });
    const [geminiKeyQuota, setGeminiKeyQuota] = useState<Record<string, { models: string[]; until: number; used?: boolean }>>(() => {
        try { return JSON.parse(localStorage.getItem('gf_gemini_key_quota') || '{}'); } catch { return {}; }
    });
    const [geminiKeyIds, setGeminiKeyIds] = useState<Record<string, string>>({});
    const editGeminiAccountsRef = useRef(editGeminiAccounts);
    editGeminiAccountsRef.current = editGeminiAccounts;
    const editApiKey = editGeminiAccounts[0]?.secret || '';
    const editApiKeyRef = useRef(editApiKey);
    editApiKeyRef.current = editGeminiAccountsRef.current.map((row) => row.secret.trim()).find(Boolean) || '';
    const [editKeysPaused, setEditKeysPaused] = useState(false);
    const [editReplayLogText, setEditReplayLogText] = useState('');
    const [editReplayLogName, setEditReplayLogName] = useState('');
    const [editReplayHits, setEditReplayHits] = useState<Record<string, { partIndex: number; start: number; end: number; reason: string; name: string }[]>>({});
    useEffect(() => {
        let cancel = false;
        const secrets = editGeminiAccounts.map((row) => row.secret.trim()).filter(Boolean);
        Promise.all(secrets.map(async (secret) => {
            const bytes = new TextEncoder().encode(secret);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 10);
            return [secret, id] as const;
        })).then((pairs) => {
            if (cancel) return;
            setGeminiKeyIds(Object.fromEntries(pairs));
        }).catch(() => { /* ignore */ });
        return () => { cancel = true; };
    }, [editGeminiAccounts]);

    const editGeminiKeys = () => {
        const keys: string[] = [];
        const push = (value: string) => {
            const key = String(value || '').trim();
            if (key && !keys.includes(key)) keys.push(key);
        };
        for (const row of editGeminiAccountsRef.current) push(row.secret);
        return keys;
    };
    const rememberGeminiQuota = (keyId: string, models: string[], resetAt: number, used = false) => {
        if (!keyId) return;
        setGeminiKeyQuota((prev) => {
            const current = prev[keyId] || { models: [], until: 0 };
            const next = {
                ...prev,
                [keyId]: {
                    models: [...new Set([...current.models, ...models.filter(Boolean)])],
                    until: resetAt || current.until,
                    used: used || current.used || false,
                },
            };
            try { localStorage.setItem('gf_gemini_key_quota', JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    };
    const [editModel, setEditModel] = useState(() => {
        const allowed = new Set([
            'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash',
            'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-pro',
        ]);
        try {
            const v = localStorage.getItem('gf_gemini_model') || '';
            if (localStorage.getItem('gf_detail_model_split') !== '1') {
                localStorage.setItem('gf_detail_model_split', '1');
                return 'gemini-3.8-flash';
            }
            return allowed.has(v) ? v : 'gemini-3.8-flash';
        } catch { return 'gemini-3.8-flash'; }
    });
    const [editAutoCut, setEditAutoCut] = useState(true);
    const [editTikTokPad, setEditTikTokPad] = useState(() => {
        try { return localStorage.getItem('gf_edit_tiktok') === 'true'; } catch { return false; }
    });
    const [editTikTokMix, setEditTikTokMix] = useState(() => {
        try { return localStorage.getItem('gf_edit_tiktok_mix') === 'true'; } catch { return false; }
    });
    // Operator decision 2026-10-01: general-content 9:16 (focus/pip/split) is the
    // default Edit framing. "SML" keeps the old letterbox contain / 1:1 fill path.
    const [editFramingStyle, setEditFramingStyle] = useState<'focus' | 'sml'>(() => {
        try { return localStorage.getItem('gf_edit_framing_style') === 'sml' ? 'sml' : 'focus'; } catch { return 'focus'; }
    });
    // Detail model order on the Gemini-API-key path. `safe` is the order measured
    // on the 2026-09-23 eleven-video log (starts at 3.5-flash-lite: 41 plans and 0
    // overloads, while 3.8/3.6/3.7 were overloaded on nearly every attempt).
    // `quality` tries the MODEL above first - affordable because the server now
    // skips a model that just returned "high demand" for 10 minutes, across jobs.
    const [editDetailModelMode, setEditDetailModelMode] = useState<'safe' | 'quality' | 'only'>(() => {
        try {
            const v = localStorage.getItem('gf_edit_detail_model_mode');
            return v === 'quality' || v === 'only' ? v : 'safe';
        } catch { return 'safe'; }
    });
    // Let the app pick the detail mode from its own measured history (>=12 parts
    // per mode and a >=5 point gap). Default on - it stays quiet until the data
    // exists, and the operator can still force a mode by unticking this.
    const [editDetailModelAuto, setEditDetailModelAuto] = useState(() => {
        try { return localStorage.getItem('gf_edit_detail_model_auto') !== 'false'; } catch { return true; }
    });
    // (C) Topic routing: let the app recognise the topic, or pin it by hand so the
    // matching workflow is applied without guessing.
    const [editTopicPin, setEditTopicPin] = useState<string>(() => {
        try { return localStorage.getItem('gf_edit_topic_pin') || ''; } catch { return ''; }
    });
    const [editGeneralVideo, setEditGeneralVideo] = useState(() => {
        try { return localStorage.getItem('gf_edit_general_video') === 'true'; } catch { return false; }
    });
    const [editSpeechFraming, setEditSpeechFraming] = useState(() => {
        try { return localStorage.getItem('gf_edit_speech_framing') !== 'false'; } catch { return true; }
    });
    const [editTest1m, setEditTest1m] = useState(() => {
        try { return localStorage.getItem('gf_edit_test1m') === 'true'; } catch { return false; }
    });
    const [editLocalDetailTest, setEditLocalDetailTest] = useState(() => {
        try { return localStorage.getItem('gf_edit_local_detail_test') === 'true'; } catch { return false; }
    });
    const [editTestSeconds, setEditTestSeconds] = useState<30 | 60>(() => {
        try { return Number(localStorage.getItem('gf_edit_test_seconds')) === 30 ? 30 : 60; } catch { return 60; }
    });
    const [editLocalNewRange, setEditLocalNewRange] = useState(false);
    const [editPartFrom, setEditPartFrom] = useState(() => {
        try {
            const n = Number(localStorage.getItem('gf_edit_part_from'));
            return Number.isFinite(n) && n >= 1 && n <= 24 ? n : 1;
        } catch { return 1; }
    });
    const [editPartTo, setEditPartTo] = useState(() => {
        try {
            const n = Number(localStorage.getItem('gf_edit_part_to'));
            return Number.isFinite(n) && n >= 0 && n <= 24 ? n : 0;
        } catch { return 0; }
    });
    const [editBusy, setEditBusy] = useState(false);
    const editBusyRef = useRef(false);
    const [editProgress, setEditProgress] = useState(0);
    const [editWatchPct, setEditWatchPct] = useState(0);
    const [editPhase, setEditPhase] = useState('');
    const [editSummary, setEditSummary] = useState('');
    const fullLogsRef = useRef<Record<LogBucket, string[]>>(emptyLogBuckets());
    const [editRunTimes, setEditRunTimes] = useState<Array<{ name: string; ordinal: number; elapsed: string; status: string }>>([]);
    const [adcInfo, setAdcInfo] = useState<{ ok: boolean; project?: string; location?: string; error?: string } | null>(null);
    const editCancelRef = useRef(false);
    const editJobRef = useRef<string | null>(null);
    const [partTestBusyId, setPartTestBusyId] = useState<string | null>(null);

    const [reframeFiles, setReframeFiles] = useState<QueueClip[]>([]);
    const reframeFilesRef = useRef<QueueClip[]>([]);
    reframeFilesRef.current = reframeFiles;
    const reframeInputRef = useRef<HTMLInputElement>(null);
    const [reframeBusy, setReframeBusy] = useState(false);
    const reframeBusyRef = useRef(false);
    const reframeCancelRef = useRef(false);
    const reframeJobRef = useRef<string | null>(null);
    const [reframeProgress, setReframeProgress] = useState(0);
    const [reframeWatchPct, setReframeWatchPct] = useState(0);
    const [reframePhase, setReframePhase] = useState('');
    const [reframeAspect, setReframeAspect] = useState<'9:16' | '3:4' | '4:5' | '1:1' | '4:3' | '3:2' | '16:9'>('9:16');
    const [reframeTight, setReframeTight] = useState(1.08);
    const [reframeResults, setReframeResults] = useState<QueueResult[]>([]);
    const [reframeSelectedIds, setReframeSelectedIds] = useState<string[]>([]);
    const [reframeDragging, setReframeDragging] = useState(false);
    const youtubeKeptRef = useRef<Set<string>>(new Set());
    const editActiveClipIdRef = useRef<string | null>(null);
    const reframeActiveClipIdRef = useRef<string | null>(null);



    const BACKEND_URL = '';

    const addLog = useCallback((msg: string, channelOverride?: LogBucket) => {
        const channel = channelOverride || (logChannel(msg) as LogBucket);
        if (!(/\[FFMPEG\]/.test(msg) && /\bframe=/.test(msg))) {
            fullLogsRef.current[channel].push(`[${new Date().toISOString()}] ${msg}`);
        }
        setLogsByChannel((prev) => ({ ...prev, [channel]: appendDisplayLog(prev[channel], msg) }));
    }, []);

    const clearLogChannel = useCallback((channel: LogBucket) => {
        fullLogsRef.current[channel] = [];
        setLogsByChannel((prev) => ({ ...prev, [channel]: [] }));
    }, []);

    // Gemini keys live in a server file (uploads/gemini-keys.json). The browser
    // copy in localStorage is only a cache: it is per origin, so the keys used to
    // disappear when the app was opened from another port/profile or after
    // clearing site data, and it was only written when a run started. This block
    // must stay AFTER addLog and editModel are declared.
    const geminiLoadedRef = useRef(false);
    const editModelRef = useRef(editModel);
    editModelRef.current = editModel;
    useEffect(() => {
        let cancelled = false;
        fetch(`${BACKEND_URL}/api/gemini-keys`)
            .then((r) => r.json())
            .then((data) => {
                if (cancelled) return;
                const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
                if (accounts.length) {
                    setEditGeminiAccounts(accounts.map((row: { email?: string; secret?: string }) => ({
                        email: String(row?.email || ''),
                        secret: String(row?.secret || ''),
                    })));
                    if (data.model) setEditModel(String(data.model));
                    addLog(`[EDIT] Nạp ${accounts.length} Gemini key đã lưu trên máy (${data.file || 'uploads/gemini-keys.json'}).`);
                    return;
                }
                const local = editGeminiAccountsRef.current.filter((row) => row.secret.trim());
                if (!local.length) return;
                fetch(`${BACKEND_URL}/api/gemini-keys`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accounts: local, model: editModelRef.current }),
                })
                    .then(() => addLog(`[EDIT] Đã lưu ${local.length} Gemini key vào file trên máy để lần sau không phải nhập lại.`))
                    .catch(() => { /* the localStorage copy still works this session */ });
            })
            .catch(() => { /* no server store yet: keep the localStorage behaviour */ })
            .finally(() => { if (!cancelled) geminiLoadedRef.current = true; });
        return () => { cancelled = true; };
    }, [addLog]);
    useEffect(() => {
        if (!geminiLoadedRef.current) return;
        const timer = window.setTimeout(() => {
            const accounts = editGeminiAccounts
                .map((row) => ({ email: row.email.trim(), secret: row.secret.trim() }))
                .filter((row) => row.secret);
            fetch(`${BACKEND_URL}/api/gemini-keys`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accounts, model: editModel }),
            }).catch(() => { /* keep going; localStorage is written by persistEditPrefs */ });
        }, 600);
        return () => window.clearTimeout(timer);
    }, [editGeminiAccounts, editModel]);

    const releaseYoutubeImport = useCallback(async (
        clip: QueueClip | undefined,
        mode: 'remove' | 'done',
        pipeline: 'unique' | 'edit' | 'reframe',
    ) => {
        if (!clip || clip.source !== 'youtube' || !clip.youtubeJobId) return;
        if (mode === 'done' && pipeline === 'edit') {
            if (clip.localPath) youtubeKeptRef.current.add(clip.localPath);
            return;
        }
        if (mode === 'remove' && clip.localPath && youtubeKeptRef.current.has(clip.localPath)) {
            addLog('[YT] Giữ file để Test lại part.');
            return;
        }
        if (mode === 'remove' && (
            (pipeline === 'edit' && editActiveClipIdRef.current === clip.id)
            || (pipeline === 'reframe' && reframeActiveClipIdRef.current === clip.id)
        )) {
            addLog('[YT] Đang xử lý clip này. Giữ file nguồn.');
            return;
        }
        try {
            const res = await fetch(`${BACKEND_URL}/api/youtube-import/${clip.youtubeJobId}`, { method: 'DELETE' });
            if (!res.ok && res.status !== 404) {
                const data = await res.json().catch(() => ({}));
                addLog(`[YT] ${data.error || `Không xóa được file import (${res.status}).`}`);
            }
        } catch (err: unknown) {
            addLog(`[YT] ${err instanceof Error ? err.message : String(err)}`);
        }
    }, [addLog]);

    const appendYoutubeClip = useCallback((tab: 'unique' | 'edit' | 'reframe', file: YoutubeImportFile, youtubeJobId: string, presetId?: string, editProfile?: EditProfile | null) => {
        const name = safeFileName(file.name || 'video.mp4');
        const localPath = String(file.path || '').trim();
        if (!localPath || !youtubeJobId) return;
        const clip: QueueClip = {
            id: newClipId(),
            file: new File([], name, { type: 'video/mp4' }),
            name,
            originalName: String(file.name || name),
            localPath,
            fileSize: Number(file.size) || 0,
            source: 'youtube',
            youtubeJobId,
            handoffFrom: 'youtube',
            handoffPreset: presetId
                ? (namedPresetsRef.current.find((item) => item.id === String(presetId))?.name || '')
                : '',
            outFolder: osSavePath.trim() || undefined,
        };
        const label = tab === 'unique' ? 'Unique' : tab === 'edit' ? 'Edit' : 'Reframe';
        const current = tab === 'unique' ? filesRef.current : tab === 'edit' ? editFilesRef.current : reframeFilesRef.current;
        if (current.some((c) => c.localPath === localPath)) {
            addLog(`[YT] ${name} đã có trong hàng ${label}.`);
            return;
        }
        const busy = tab === 'unique' ? processingRef.current : tab === 'edit' ? editBusyRef.current : reframeBusyRef.current;
        const live = busy
            ? (tab === 'unique'
                ? ' Unique đang chạy — clip này xếp sau clip hiện tại.'
                : tab === 'edit'
                    ? ' Edit đang chạy — clip này xếp sau nguồn hiện tại.'
                    : ' Reframe đang chạy — clip này xếp sau nguồn hiện tại.')
            : '';
        addLog(`[YT] Đã thêm ${name} vào hàng ${label}.${live}`);
        const next = [...current, clip];
        if (tab === 'unique') {
            filesRef.current = next;
            setFiles(next);
            if (processingRef.current) {
                queueTotalRef.current += 1;
                setQueueTotal(queueTotalRef.current);
                return;
            }
            if (presetId) handoffRef.current(String(presetId));
            else {
                addLog('[YT] Unique bắt đầu với cài đặt đang mở.');
                startUniqueRef.current();
            }
            return;
        }
        if (tab === 'edit') {
            editFilesRef.current = next;
            setEditFiles(next);
            if (editBusyRef.current) {
                addLog('[EDIT] Live queue: clip mới sẽ chạy sau nguồn đang xử lý.');
                return;
            }
            if (editProfile) applySavedEdit(editProfile);
            else addLog('[YT] Edit bắt đầu với cài đặt đang mở.');
            startEditRef.current();
            return;
        }
        reframeFilesRef.current = next;
        setReframeFiles(next);
        if (reframeBusyRef.current) {
            addLog('[REFRAME] Live queue: clip mới chạy sau nguồn đang xử lý.');
            return;
        }
        addLog('[YT] Reframe bắt đầu với cài đặt đang mở.');
        startReframeRef.current();
    }, [addLog, osSavePath]);

    const setSavePathSticky = (p: string) => {
        setOsSavePath(p);
        try { localStorage.setItem('gf_save_path', p); } catch { /* ignore */ }
    };

    const loadEncoders = useCallback((fresh = false) => {
        fetch(`${BACKEND_URL}/api/encoders${fresh ? '?fresh=1' : ''}`)
            .then((r) => r.json())
            .then((caps) => {
                setEncoderCaps(caps);
                addLog(`[SYS] Encoders: CPU ${caps.cpu ? 'yes' : 'no'} · NVIDIA ${caps.nvidia ? 'yes' : (caps.nvidiaListed ? 'listed but cannot open (use Intel QSV)' : 'no')} · Intel QSV ${caps.intel ? 'yes' : 'no'}`);
                if (caps.ffmpegPath) addLog(`[SYS] ffmpeg: ${caps.ffmpegPath}`);
                if (!caps.nvidia && caps.nvidiaError) addLog(`[SYS] NVENC probe: ${caps.nvidiaError}`);
                if (caps.nvidia) {
                    setEncoderMode('nvidia');
                    addLog('[SYS] NVIDIA NVENC is usable. Encoder set to NVIDIA.');
                }
            })
            .catch(() => addLog('[SYS] Could not probe GPU encoders — CPU x264 will be used.'));
    }, [addLog]);

    useEffect(() => {
        loadEncoders(false);
    }, [loadEncoders]);

    useEffect(() => {
        try { sessionStorage.setItem('gf_completed', JSON.stringify(queueResults)); } catch { /* ignore */ }
    }, [queueResults]);

    useEffect(() => {
        const doneKeys = new Set(queueResults.filter((r) => !r.failed).map((r) => r.originalName));
        const unfinished = files.filter((c) => !doneKeys.has(c.originalName)).map((c) => c.name);
        try { sessionStorage.setItem('gf_unfinished', JSON.stringify(unfinished)); } catch { /* ignore */ }
        if (files.length > 0) setUnfinishedNotice([]);
    }, [files, queueResults]);

    useEffect(() => {
        try { sessionStorage.setItem('gf_selected', JSON.stringify(selectedIds)); } catch { /* ignore */ }
    }, [selectedIds]);

    useEffect(() => {
        let cancelled = false;
        fetch(`${BACKEND_URL}/api/unique/held`)
            .then((r) => r.json())
            .then((data) => {
                if (cancelled) return;
                const items = Array.isArray(data?.items) ? data.items : [];
                const recovered: QueueResult[] = items
                    .filter((item: { jobId?: string }) => typeof item?.jobId === 'string' && item.jobId)
                    .map((item: { jobId: string; name?: string; originalName?: string; stats?: QueueResult['stats'] }) => ({
                        name: String(item.name || item.originalName || 'video.mp4'),
                        originalName: String(item.originalName || item.name || 'video.mp4'),
                        jobId: String(item.jobId),
                        downloadUrl: `${BACKEND_URL}/api/download/${item.jobId}`,
                        stats: item.stats || undefined,
                        saved: false,
                        recovered: true,
                    }));
                setQueueResults((prev) => {
                    const heldIds = new Set(recovered.map((row) => row.jobId));
                    const kept = prev.filter((row) => !row.recovered || row.saved || heldIds.has(row.jobId));
                    const known = new Set(kept.map((row) => row.jobId));
                    const extra = recovered.filter((row) => !known.has(row.jobId));
                    return extra.length || kept.length !== prev.length ? [...extra, ...kept] : prev;
                });
                if (!recovered.length) return;
                setSelectedIds((prev) => {
                    const add = recovered.map((row) => row.jobId).filter((id) => !prev.includes(id));
                    return add.length ? [...add, ...prev] : prev;
                });
                addLog(`[SYS] Giữ lại ${recovered.length} video Unique đã xử lý nhưng chưa lưu.`);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [addLog]);

    useEffect(() => {
        fetch(`${BACKEND_URL}/api/save-dir`)
            .then((r) => r.json())
            .then((d) => {
                if (d.path) {
                    setSavePathSticky(d.path);
                    setSaveFolderName(d.name || d.path);
                    setFolderReady(true);
                    addLog(`[SYS] Save folder restored: ${d.path}`);
                }
            })
            .catch(() => {});
    }, [addLog]);

    const loadReplayCatalog = useCallback(() => {
        fetch(`${BACKEND_URL}/api/edit/qa-history`)
            .then((response) => response.json())
            .then((data) => {
                const videos = Array.isArray(data?.catalog) ? data.catalog : [];
                setReplayCatalog(videos.map((video: ReplayVideoRow) => ({
                    sourcePath: String(video?.sourcePath || ''),
                    sourceName: String(video?.sourceName || ''),
                    sourceAvailable: Boolean(video?.sourceAvailable),
                    newestAt: String(video?.newestAt || ''),
                    parts: (Array.isArray(video?.parts) ? video.parts : []).map((part) => ({
                        id: `${video.sourcePath}|${part.partIndex}|${part.start}|${part.end}`,
                        partIndex: Number(part.partIndex) || 1,
                        partName: String(part.partName || ''),
                        start: Number(part.start) || 0,
                        end: Number(part.end) || 0,
                        ranges: Array.isArray(part.ranges) ? part.ranges : [[Number(part.start) || 0, Number(part.end) || 0]],
                        score: Number.isFinite(Number(part.score)) ? Math.round(Number(part.score)) : null,
                        durationSec: Number(part.durationSec) || 0,
                    })),
                })).filter((video: ReplayVideoRow) => video.sourcePath && video.parts.length));
            })
            .catch(() => {});
    }, []);

    const replayView = React.useMemo(() => {
        const query = replayQuery.trim().toLowerCase();
        const rows = replayCatalog.flatMap((video) => {
            const title = replayVideoTitle(video.sourceName).toLowerCase();
            const nameHit = !query || title.includes(query);
            const parts = nameHit
                ? video.parts
                : video.parts.filter((part) => replayPartTitle(part.partName, part.partIndex).toLowerCase().includes(query) || String(part.partIndex) === query);
            if (!nameHit && !parts.length) return [];
            return [{ video, parts }];
        });
        return {
            ready: rows.filter((row) => row.video.sourceAvailable),
            missing: rows.filter((row) => !row.video.sourceAvailable),
        };
    }, [replayCatalog, replayQuery]);

    useEffect(() => {
        let cancelled = false;
        fetch(`${BACKEND_URL}/api/edit/held`)
            .then((response) => response.json())
            .then((data) => {
                if (cancelled) return;
                const items = Array.isArray(data?.items) ? data.items : [];
                if (!items.length) return;
                const counts = new Map<string, number>();
                for (const item of items) {
                    const key = String(item?.sourcePath || item?.sourceName || item?.jobId || '');
                    counts.set(key, (counts.get(key) || 0) + 1);
                }
                const segs: EditSegment[] = items
                    .filter((item: { jobId?: string }) => typeof item?.jobId === 'string' && item.jobId)
                    .map((item: {
                        jobId: string; sourceName?: string; sourcePath?: string; partIndex?: number; name?: string;
                        title?: string; titleVi?: string; script?: string; reason?: string; start?: number; end?: number; dur?: number;
                        ranges?: Array<[number, number]>; qa?: { score?: number; grade?: string; warnings?: string[] } | null;
                        downloadUrl?: string;
                    }) => {
                        const sourceKey = String(item.sourcePath || item.sourceName || item.jobId);
                        const score = Number(item.qa?.score);
                        const warnings = Array.isArray(item.qa?.warnings) ? item.qa.warnings.map((line) => String(line)) : [];
                        return {
                            id: `held-${item.jobId}`,
                            sourceId: `held:${sourceKey}`,
                            sourceName: String(item.sourceName || 'Video'),
                            name: safeFileName(String(item.name || 'video.mp4')),
                            title: String(item.title || item.name || ''),
                            titleVi: String(item.titleVi || ''),
                            partIndex: Number(item.partIndex) || 1,
                            parts: counts.get(sourceKey) || 1,
                            start: Number(item.start),
                            end: Number(item.end),
                            dur: Number(item.dur),
                            ranges: Array.isArray(item.ranges) ? item.ranges : undefined,
                            script: String(item.script || ''),
                            reason: String(item.reason || ''),
                            status: 'cut' as const,
                            jobId: String(item.jobId),
                            downloadUrl: item.downloadUrl
                                ? (String(item.downloadUrl).startsWith('http') ? String(item.downloadUrl) : `${BACKEND_URL}${item.downloadUrl}`)
                                : `${BACKEND_URL}/api/download/${item.jobId}`,
                            sourcePath: String(item.sourcePath || ''),
                            sourceAvailable: Boolean(item.sourcePath),
                            saved: false,
                            qa: Number.isFinite(score)
                                ? { score, grade: String(item.qa?.grade || ''), warnings }
                                : null,
                        };
                    });
                setEditSegments((prev) => {
                    const known = new Set(prev.map((row) => row.jobId).filter(Boolean));
                    const extra = segs.filter((row) => row.jobId && !known.has(row.jobId));
                    return extra.length ? [...extra, ...prev] : prev;
                });
                setEditSelectedIds((prev) => {
                    const add = segs.map((row) => row.id).filter((id) => !prev.includes(id));
                    return add.length ? [...prev, ...add] : prev;
                });
                addLog(`[EDIT] Giữ lại ${segs.length} part đã cắt nhưng chưa lưu.`);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [addLog]);

    useEffect(() => {
        fetch(`${BACKEND_URL}/api/edit/part-test/history`)
            .then((response) => response.json())
            .then((data) => {
                const run = data?.run;
                if (!run?.id || !Array.isArray(run.parts)) return;
                setReplayRunId(String(run.id));
                setReplayRunSource(String(run.sourcePath || ''));
                setPartTestHistory(run.parts.map((part: EditSegment) => ({
                    ...part,
                    id: `history-${run.id}-${part.partIndex}`,
                    sourceId: `history-${run.id}`,
                    sourceName: run.sourceName || 'Nguồn Edit gần nhất',
                    parts: run.parts.length,
                    status: 'planned' as const,
                    historyId: run.id,
                    sourceAvailable: Boolean(run.sourceAvailable),
                    jobId: undefined,
                    downloadUrl: undefined,
                })));
            })
            .catch(() => {});
    }, []);

    useEffect(() => { loadReplayCatalog(); }, [loadReplayCatalog]);

    useEffect(() => {
        (async () => {
            const dir = await loadDirHandle();
            if (!dir) return;
            saveDirRef.current = dir;
            setSaveFolderName(dir.name);
            const ok = await dirPermission(dir, false);
            setFolderReady(ok);
            addLog(ok
                ? `[SYS] Save folder restored: ${dir.name}`
                : `[SYS] Save folder remembered: ${dir.name} — click “Allow folder” once to write there`);
        })().catch(() => {});
    }, [addLog]);

    const fileKey = (f: File) => `${f.name}::${f.size}::${f.lastModified}`;

    const addFiles = useCallback((incoming: File[]) => {
        const videos = incoming.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name));
        if (videos.length === 0) {
            addLog('[SYS] ERROR: No video files in that selection.');
            return;
        }
        let joined: string[] = [];
        setFiles((prev) => {
            const have = new Set(prev.map((c) => fileKey(c.file)));
            const fresh = videos
                .filter((f) => !have.has(fileKey(f)))
                .map((f) => ({
                    id: newClipId(),
                    file: f,
                    name: safeFileName(f.name),
                    originalName: f.name,
                }));
            const skipped = videos.length - fresh.length;
            if (fresh.length === 0) {
                addLog('[SYS] Those videos are already in the queue.');
                return prev;
            }
            const next = [...prev, ...fresh];
            filesRef.current = next;
            joined = fresh.map((c) => c.name);
            addLog(`[SYS] Added ${fresh.length} video(s): ${joined.join(', ')}${skipped ? ` · skipped ${skipped} duplicate(s)` : ''}. Queue: ${next.length}`);
            return next;
        });
        if (processingRef.current && joined.length) {
            queueTotalRef.current += joined.length;
            setQueueTotal(queueTotalRef.current);
            addLog(`[SYS] Unique đang chạy — ${joined.join(', ')} xếp sau clip hiện tại.`);
        }
    }, [addLog]);

    const pickEditFromPc = async () => {
        addLog('[EDIT] Opening Windows file dialog — check the taskbar if it is behind the browser.');
        try {
            const res = await fetch(`${BACKEND_URL}/api/pick-videos`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            const list = Array.isArray(data.files) ? data.files : [];
            if (!list.length) {
                addLog('[EDIT] No videos picked.');
                return;
            }
            setEditFiles((prev) => {
                const have = new Set(prev.map((c) => c.localPath || fileKey(c.file)));
                const fresh: QueueClip[] = [];
                for (const f of list) {
                    const p = String(f.path || '');
                    if (!p || have.has(p)) continue;
                    have.add(p);
                    fresh.push({
                        id: newClipId(),
                        file: new File([], String(f.name || 'video.mp4'), { type: 'video/mp4' }),
                        name: safeFileName(String(f.name || 'video.mp4')),
                        originalName: String(f.name || 'video.mp4'),
                        localPath: p,
                        fileSize: Number(f.size) || 0,
                        outFolder: String(f.folder || '').trim() || undefined,
                    });
                }
                if (!fresh.length) {
                    addLog('[EDIT] Those videos are already in the edit queue.');
                    return prev;
                }
                addLog(`[EDIT] Added ${fresh.length} from disk. Auto-save = source folder unless you change it.`);
                fresh.forEach((c) => addLog(`[EDIT] ${c.name} → ${c.outFolder || '(no folder)'}`));
                if (editBusyRef.current) addLog('[EDIT] Live queue: clip mới sẽ chạy sau nguồn đang xử lý.');
                const next = [...prev, ...fresh];
                editFilesRef.current = next;
                return next;
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/cancel/i.test(msg)) return;
            addLog(`[EDIT] Pick videos failed: ${msg}`);
        }
    };

    const addEditFiles = useCallback((incoming: File[]) => {
        const videos = incoming.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name));
        if (videos.length === 0) {
            addLog('[EDIT] ERROR: No video files in that selection.');
            return;
        }
        setEditFiles((prev) => {
            const have = new Set(prev.map((c) => fileKey(c.file)));
            const fresh = videos
                .filter((f) => !have.has(fileKey(f)))
                .map((f) => ({
                    id: newClipId(),
                    file: f,
                    name: safeFileName(f.name),
                    originalName: f.name,
                }));
            const skipped = videos.length - fresh.length;
            if (fresh.length === 0) {
                addLog('[EDIT] Those videos are already in the edit queue.');
                return prev;
            }
            addLog(`[EDIT] Added ${fresh.length} source(s): ${fresh.map((c) => c.name).join(', ')}${skipped ? ` · skipped ${skipped} duplicate(s)` : ''}. Edit queue: ${prev.length + fresh.length}`);
            if (editBusyRef.current) addLog('[EDIT] Live queue: clip mới sẽ chạy sau nguồn đang xử lý.');
            const next = [...prev, ...fresh];
            editFilesRef.current = next;
            return next;
        });
    }, [addLog]);

    const handleEditFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            addEditFiles(Array.from(e.target.files));
        }
        e.target.value = '';
    };

    const onEditDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setEditDragging(false);
        if (e.dataTransfer.files?.length) addEditFiles(Array.from(e.dataTransfer.files));
    };

    const removeEditFile = (index: number) => {
        const removed = editFilesRef.current[index];
        setEditFiles((prev) => {
            const next = prev.filter((_, i) => i !== index);
            editFilesRef.current = next;
            addLog(`[EDIT] Removed ${removed?.name || 'video'} from edit queue.`);
            return next;
        });
        if (removed?.id) setEditSegments((prev) => prev.filter((s) => s.sourceId !== removed.id));
        void releaseYoutubeImport(removed, 'remove', 'edit');
    };

    const renameEditQueued = (id: string, raw: string) => {
        const name = safeFileName(raw);
        setEditFiles((prev) => prev.map((c) => c.id === id ? { ...c, name } : c));
    };

    const moveEditFile = (from: number, to: number) => {
        if (from === to || from < 0 || to < 0) return;
        setEditFiles((prev) => {
            if (from >= prev.length || to >= prev.length) return prev;
            const next = [...prev];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return next;
        });
    };

    useEffect(() => {
        if (appTab !== 'edit' && appTab !== 'reframe') return;
        fetch(`${BACKEND_URL}/api/edit/adc`)
            .then((r) => r.json())
            .then((d) => {
                setAdcInfo(d);
                addLog(d.ok
                    ? `[EDIT] Google Cloud ADC ready · project ${d.project}`
                    : `[EDIT] ADC: ${d.error || 'not logged in'}`);
            })
            .catch((err) => setAdcInfo({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }, [appTab, addLog]);

    editRunRef.current = normalizeEditProfile({
        mode: editMode,
        encoder: editEncoderMode,
        split: editSplit,
        minSec: editMinSec,
        autoParts: editAutoParts,
        autoCut: editAutoCut,
        fade: editFadeFx,
        prompt: editPrompt,
        model: editModel,
        tiktokPad: editTikTokPad,
        tiktokMix: editTikTokMix,
        framingStyle: editFramingStyle,
        detailModelMode: editDetailModelMode,
        detailModelAuto: editDetailModelAuto,
        topicPin: editTopicPin,
        generalVideo: editGeneralVideo,
        speechFraming: editSpeechFraming,
        test1m: editTest1m,
        localDetailTest: editLocalDetailTest,
        testSeconds: editTestSeconds,
        partFrom: editPartFrom,
        partTo: editPartTo,
    });

    const applySavedEdit = (raw: EditProfile) => {
        const next = normalizeEditProfile(raw);
        if (!next) return;
        editRunRef.current = next;
        setEditMode(next.mode);
        setEditEncoderMode(next.encoder);
        setEditSplit(next.split);
        setEditMinSec(next.minSec);
        setEditAutoParts(next.autoParts);
        setEditAutoCut(next.autoCut);
        setEditFadeFx(next.fade);
        setEditPrompt(next.prompt);
        setEditModel(next.model);
        setEditTikTokPad(next.tiktokPad);
        setEditTikTokMix(next.tiktokMix);
        setEditFramingStyle(next.framingStyle);
        setEditDetailModelMode(next.detailModelMode);
        setEditDetailModelAuto(next.detailModelAuto);
        setEditTopicPin(next.topicPin);
        setEditGeneralVideo(next.generalVideo);
        setEditSpeechFraming(next.speechFraming);
        setEditTest1m(next.test1m);
        setEditLocalDetailTest(next.localDetailTest);
        setEditTestSeconds(next.testSeconds);
        setEditPartFrom(next.partFrom);
        setEditPartTo(next.partTo);
        addLog('[YT] Edit dùng cấu hình đã gắn.');
    };

    const persistEditPrefs = () => {
        const edit = editRunRef.current;
        if (!edit) return;
        try {
            localStorage.setItem('gf_edit_split', String(edit.split));
            localStorage.setItem('gf_edit_minsec', String(edit.minSec));
            localStorage.setItem('gf_edit_mode', edit.mode);
            localStorage.setItem('gf_edit_encoder', edit.encoder);
            localStorage.setItem('gf_edit_prompt', edit.prompt);
            const accounts = editGeminiAccounts.map((row) => ({ email: row.email.trim(), secret: row.secret.trim() })).filter((row) => row.secret);
            localStorage.setItem('gf_gemini_accounts', JSON.stringify(accounts.length ? accounts : editGeminiAccounts));
            localStorage.setItem('gf_gemini_key', accounts[0]?.secret || '');
            localStorage.setItem('gf_gemini_keys_extra', accounts.slice(1).map((row) => row.secret).join('\n'));
            localStorage.setItem('gf_gemini_model', edit.model);
            localStorage.setItem('gf_edit_tiktok', String(edit.tiktokPad));
            localStorage.setItem('gf_edit_tiktok_mix', String(edit.tiktokMix));
            localStorage.setItem('gf_edit_framing_style', edit.framingStyle);
            localStorage.setItem('gf_edit_detail_model_mode', edit.detailModelMode);
            localStorage.setItem('gf_edit_detail_model_auto', String(edit.detailModelAuto));
            localStorage.setItem('gf_edit_topic_pin', edit.topicPin);
            localStorage.setItem('gf_edit_speech_framing', String(edit.speechFraming));
            localStorage.setItem('gf_edit_general_video', String(edit.generalVideo));
            localStorage.setItem('gf_edit_test1m', String(edit.test1m));
            localStorage.setItem('gf_edit_local_detail_test', String(edit.localDetailTest));
            localStorage.setItem('gf_edit_test_seconds', String(edit.testSeconds));
            localStorage.setItem('gf_edit_part_from', String(edit.partFrom));
            localStorage.setItem('gf_edit_part_to', String(edit.partTo));
            localStorage.setItem('gf_edit_auto_parts', String(edit.autoParts));
            localStorage.setItem('gf_edit_parts_mode', edit.autoParts ? 'auto' : 'fixed');
            localStorage.setItem('gf_edit_fade', String(edit.fade));
        } catch { /* ignore */ }
    };

    const runOneEdit = (clip: QueueClip, edit: EditProfile) =>
        new Promise<EditSegment[]>((resolve, reject) => {
            const tag = clip.name.replace(/\.[^.]+$/, '').slice(0, 22);
            const log = (msg: string) => addLog(`[${tag}] ${msg}`, 'edit');
            const upload = clip.localPath
                ? fetch(`${BACKEND_URL}/api/edit/job-local`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: clip.localPath,
                        mode: edit.mode,
                        encoderMode: edit.encoder,
                        maxParts: String(edit.split),
                        minSec: String(edit.minSec),
                        autoParts: String(edit.autoParts),
                        autoCut: String(edit.autoCut),
                        framingStyle: edit.framingStyle,
                        detailModelMode: edit.detailModelMode,
                        detailModelAuto: String(edit.detailModelAuto),
                        topicPin: edit.topicPin,
                        tiktokPad: String(edit.framingStyle === 'focus' || edit.tiktokPad),
                        tiktokMix: String(edit.framingStyle === 'focus' || edit.tiktokMix),
                        speechFraming: String(edit.framingStyle === 'focus' || (edit.speechFraming && edit.tiktokMix)),
                        generalVideo: String(edit.framingStyle === 'focus' || edit.generalVideo),
                        fadeFx: String(edit.fade),
                        testSec: String(edit.test1m ? edit.testSeconds : 0),
                        localDetailTest: String(edit.test1m && edit.localDetailTest),
                        localDetailNewRange: String(editLocalNewRange),
                        partFrom: String(edit.partFrom),
                        partTo: String(edit.partTo || 0),
                        prompt: edit.prompt,
                        apiKey: editApiKey,
                        apiKeys: editGeminiKeys(),
                        model: edit.model,
                    }),
                })
                : (() => {
                    const formData = new FormData();
                    formData.append('video', clip.file);
                    formData.append('mode', edit.mode);
                    formData.append('encoderMode', edit.encoder);
                    formData.append('maxParts', String(edit.split));
                    formData.append('minSec', String(edit.minSec));
                    formData.append('autoParts', String(edit.autoParts));
                    formData.append('autoCut', String(edit.autoCut));
                    formData.append('framingStyle', edit.framingStyle);
                    formData.append('detailModelMode', edit.detailModelMode);
                    formData.append('detailModelAuto', String(edit.detailModelAuto));
                    formData.append('topicPin', edit.topicPin);
                    formData.append('tiktokPad', String(edit.framingStyle === 'focus' || edit.tiktokPad));
                    formData.append('tiktokMix', String(edit.framingStyle === 'focus' || edit.tiktokMix));
                    formData.append('speechFraming', String(edit.framingStyle === 'focus' || (edit.speechFraming && edit.tiktokMix)));
                    formData.append('generalVideo', String(edit.framingStyle === 'focus' || edit.generalVideo));
                    formData.append('fadeFx', String(edit.fade));
                    formData.append('testSec', String(edit.test1m ? edit.testSeconds : 0));
                    formData.append('localDetailTest', String(edit.test1m && edit.localDetailTest));
                    formData.append('localDetailNewRange', String(editLocalNewRange));
                    formData.append('partFrom', String(edit.partFrom));
                    formData.append('partTo', String(edit.partTo || 0));
                    formData.append('prompt', edit.prompt);
                    formData.append('apiKey', editApiKey);
                    formData.append('apiKeys', JSON.stringify(editGeminiKeys()));
                    formData.append('model', edit.model);
                    return fetch(`${BACKEND_URL}/api/edit/job`, { method: 'POST', body: formData });
                })();
            log(clip.localPath
                ? `Edit from disk: ${clip.name} · auto-save ${clip.outFolder || '(none)'}`
                : `Uploading for Edit: ${clip.name}…`);

            upload
                .then(async (uploadRes) => {
                    const uploaded = await uploadRes.json().catch(() => ({}));
                    if (!uploadRes.ok) throw new Error(uploaded.error || `Upload failed ${uploadRes.status}`);
                    const { jobId } = uploaded;
                    editJobRef.current = jobId;
                    log(`Edit job ${jobId.slice(0, 8)}…`);
                    const es = new EventSource(`${BACKEND_URL}/api/edit/stream/${jobId}`);
                    let settled = false;
                    const drop = () => { es.close(); };
                    const segsAcc: EditSegment[] = [];
                    es.onmessage = (ev) => {
                        const data = JSON.parse(ev.data);
                        if (data.type === 'log') log(data.message);
                        else if (data.type === 'gemini-keys') {
                            setEditKeysPaused(true);
                            setEditPhase('keys');
                            log('[EDIT] Tạm dừng. Dán key mới vào ô Key dự phòng rồi bấm Tiếp tục.');
                        } else if (data.type === 'gemini-keys-clear') {
                            setEditKeysPaused(false);
                        } else if (data.type === 'gemini-key-quota') {
                            rememberGeminiQuota(String(data.keyId || ''), Array.isArray(data.models) ? data.models : [], Number(data.resetAt) || 0, true);
                        } else if (data.type === 'gemini-key-used') {
                            rememberGeminiQuota(String(data.keyId || ''), [], 0, true);
                        } else if (data.type === 'progress') {
                            const v = Number(data.value);
                            if (Number.isFinite(v)) setEditProgress(Math.max(0, Math.min(100, v)));
                            if (data.watch != null) setEditWatchPct(Number(data.watch) || 0);
                            if (data.phase) setEditPhase(String(data.phase));
                        } else if (data.type === 'plan') {
                            setEditSummary(String(data.summary || ''));
                            setEditWatchPct(100);
                            setEditPhase('cut');
                            setEditProgress(42);
                            const segs = (data.segments || []).map((s: { start: number; end: number; dur?: number; pieces?: EditSegment['pieces']; ranges?: EditSegment['ranges']; name: string; title?: string; titleVi?: string; reason?: string; script?: string }, i: number) => ({
                                id: newClipId(),
                                sourceId: clip.id,
                                sourceName: clip.name,
                                name: safeFileName(s.name || `${clip.name}-p${i + 1}`),
                                title: s.title || s.name,
                                titleVi: s.titleVi || '',
                                partIndex: i + 1,
                                parts: (data.segments || []).length,
                                start: s.start,
                                end: s.end,
                                dur: s.dur,
                                pieces: s.pieces,
                                ranges: s.ranges,
                                script: s.script || '',
                                reason: s.reason,
                                status: 'planned' as const,
                            }));
                            segsAcc.splice(0, segsAcc.length, ...segs);
                            setEditSegments((prev) => {
                                const keep = prev.filter((s) => s.sourceId !== clip.id);
                                const keepIds = new Set(keep.map((s) => s.id));
                                setEditSelectedIds((ids) => [
                                    ...ids.filter((id) => keepIds.has(id)),
                                    ...segs.map((s: EditSegment) => s.id),
                                ]);
                                return [...keep, ...segs];
                            });
                        } else if (data.type === 'part-done') {
                            setEditSegments((prev) => prev.map((s) =>
                                s.sourceId === clip.id && (
                                    s.partIndex === data.partIndex
                                    || (typeof data.start === 'number' && s.start === data.start)
                                    || s.name === safeFileName(data.name)
                                )
                                    ? { ...s, pieces: data.pieces || s.pieces, ranges: data.ranges || s.ranges, status: 'cut', jobId: data.jobId, downloadUrl: data.downloadUrl, name: safeFileName(data.name), qa: data.qa || s.qa }
                                    : s
                            ));
                        } else if (data.type === 'done') {
                            settled = true;
                            setEditKeysPaused(false);
                            drop();
                            const finalSegs: EditSegment[] = (data.segments || segsAcc).map((s: { start: number; end: number; dur?: number; pieces?: EditSegment['pieces']; ranges?: EditSegment['ranges']; name: string; title?: string; titleVi?: string; reason?: string; script?: string; jobId?: string; downloadUrl?: string; qa?: EditSegment['qa'] }, i: number) => ({
                                id: segsAcc[i]?.id || newClipId(),
                                sourceId: clip.id,
                                sourceName: clip.name,
                                name: safeFileName(s.name),
                                title: s.title || segsAcc[i]?.title || s.name,
                                titleVi: s.titleVi || segsAcc[i]?.titleVi || '',
                                partIndex: i + 1,
                                parts: (data.segments || segsAcc).length,
                                start: s.start,
                                end: s.end,
                                dur: s.dur ?? segsAcc[i]?.dur,
                                pieces: s.pieces ?? segsAcc[i]?.pieces,
                                ranges: s.ranges ?? segsAcc[i]?.ranges,
                                script: s.script || segsAcc[i]?.script || '',
                                reason: s.reason || segsAcc[i]?.reason,
                                status: data.cut && s.jobId ? 'cut' as const : 'planned' as const,
                                jobId: s.jobId,
                                downloadUrl: s.downloadUrl,
                                qa: s.qa || segsAcc[i]?.qa,
                            }));
                            setEditSegments((prev) => [...prev.filter((s) => s.sourceId !== clip.id), ...finalSegs]);
                            if (data.report) setEditRunSummary(data.report);
                            resolve(finalSegs);
                        } else if (data.type === 'error') {
                            settled = true;
                            setEditKeysPaused(false);
                            drop();
                            reject(new Error(data.message));
                        }
                    };
                    es.onerror = () => {
                        if (settled) return;
                        settled = true;
                        drop();
                        reject(new Error('Edit stream disconnected'));
                    };
                })
                .catch(reject);
        });

    const startEdit = async () => {
        const edit = editRunRef.current;
        if (!edit) return;
        if (editBusyRef.current) return;
        if (!editFilesRef.current.length) return;
        persistEditPrefs();
        if (edit.mode === 'ai' && !(edit.test1m && edit.localDetailTest) && !editApiKey.trim() && !adcInfo?.ok) {
            addLog('[EDIT] ERROR: Chưa ADC. Chạy gcloud auth application-default login rồi restart start.bat — hoặc dán API key.');
            return;
        }
        if (edit.mode === 'ai' && !edit.prompt.trim()) {
            addLog('[EDIT] ERROR: Viết prompt — Gemini cần biết bạn muốn cắt thế nào.');
            return;
        }
        editCancelRef.current = false;
        editBusyRef.current = true;
        setEditBusy(true);
        setEditProgress(0);
        setEditWatchPct(0);
        setEditPhase('start');
        setEditRunTimes([]);
        addLog(`[EDIT] Start ${editFilesRef.current.length} source(s) · mode ${edit.mode} · ${edit.autoParts ? 'auto from content' : `${edit.split} parts`} · min ${Math.max(60, edit.minSec)}s`);
        const processed = new Set<string>();
        try {
            while (!editCancelRef.current) {
                const clip = editFilesRef.current.find((c) => !processed.has(c.id));
                if (!clip) break;
                processed.add(clip.id);
                editActiveClipIdRef.current = clip.id;
                const videoStartedAt = Date.now();
                let videoStatus = 'SUCCESS';
                addLog(`[EDIT] ---- ${clip.name} ----`);
                setEditProgress(0);
                setEditWatchPct(0);
                setEditPhase('next');
                try {
                    const segs = await runOneEdit(clip, edit);
                    setEditSelectedIds((prev) => {
                        const ids = new Set(prev);
                        segs.filter((s) => s.status === 'cut').forEach((s) => ids.add(s.id));
                        return [...ids];
                    });
                    const dest = (editFilesRef.current.find((c) => c.id === clip.id)?.outFolder || clip.outFolder || '').trim();
                    if (dest) {
                        const ready = segs.filter((s) => s.status === 'cut' && s.jobId);
                        addLog(`[EDIT] Auto-save ${ready.length} clip(s) from ${clip.name} → ${dest}`);
                        for (const seg of ready) {
                            try {
                                const res = await fetch(`${BACKEND_URL}/api/export-copy`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ jobId: seg.jobId, name: seg.name, path: dest }),
                                });
                                const data = await res.json().catch(() => ({}));
                                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                                const where = data.folder || dest;
                                const fname = data.name || safeFileName(seg.name);
                                setEditSegments((prev) => prev.map((s) => (
                                    s.jobId === seg.jobId
                                        ? { ...s, saved: true, savedTo: where, savedFile: data.dest || s.savedFile }
                                        : s
                                )));
                                addLog(`[EDIT] SAVED: ${fname} → ${where}`);
                            } catch (saveErr: unknown) {
                                videoStatus = 'COMPLETED_WITH_SAVE_ERRORS';
                                addLog(`[EDIT] Auto-save failed ${seg.name}: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
                            }
                        }
                    } else {
                        addLog(`[EDIT] ${clip.name}: no output folder — clips wait for Save.`);
                    }
                    await releaseYoutubeImport(clip, 'done', 'edit');
                    setEditFiles((prev) => {
                        const next = prev.filter((c) => c.id !== clip.id);
                        editFilesRef.current = next;
                        return next;
                    });
                    addLog(`[EDIT] Removed ${clip.name} from waiting queue.`);
                    const waiting = editFilesRef.current.filter((c) => !processed.has(c.id));
                    if (waiting.length) addLog(`[EDIT] ${waiting.length} more in live queue: ${waiting.map((c) => c.name).join(', ')}`);
                } catch (clipErr: unknown) {
                    videoStatus = editCancelRef.current ? 'CANCELLED' : 'ERROR';
                    if (editCancelRef.current) break;
                    addLog(`[EDIT] ERROR: ${clip.name} — ${clipErr instanceof Error ? clipErr.message : String(clipErr)}`);
                    addLog('[EDIT] Keeping this clip in queue.');
                } finally {
                    if (editActiveClipIdRef.current === clip.id) editActiveClipIdRef.current = null;
                    const seconds = Math.round((Date.now() - videoStartedAt) / 1000);
                    const elapsed = `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`;
                    const ordinal = processed.size;
                    setEditRunTimes((prev) => [...prev, { name: clip.name, ordinal, elapsed, status: videoStatus }]);
                    addLog(`[EDIT TOTAL] Video ${ordinal}: ${elapsed} (${seconds}s) · ${videoStatus} · ${clip.name} · gồm upload, xử lý và auto-save; không gồm chờ queue`);
                }
            }
            addLog(editCancelRef.current ? '[EDIT] Stopped.' : '[EDIT] Queue finished.');
        } catch (err: unknown) {
            addLog(`[EDIT] ERROR: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setEditLocalNewRange(false);
            setEditKeysPaused(false);
            editBusyRef.current = false;
            setEditBusy(false);
            editJobRef.current = null;
        }
    };

    const resumeEditWithKeys = async () => {
        const id = editJobRef.current;
        const keys = editGeminiKeys();
        if (!id) return;
        if (!keys.length) {
            addLog('[EDIT] Chưa có key. Dán key mới vào ô Key dự phòng.');
            return;
        }
        persistEditPrefs();
        try {
            const res = await fetch(`${BACKEND_URL}/api/edit/gemini-keys/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKeys: keys }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            setEditKeysPaused(false);
            addLog(`[EDIT] Đã gửi ${data.added || 0} key mới. Detail chạy tiếp.`);
        } catch (err: unknown) {
            addLog(`[EDIT] Chưa nhận key: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const cancelEdit = async () => {
        const already = editCancelRef.current;
        editCancelRef.current = true;
        setEditKeysPaused(false);
        const id = editJobRef.current;
        if (id) {
            try { await fetch(`${BACKEND_URL}/api/cancel/${id}`, { method: 'POST' }); } catch { /* ignore */ }
        }
        if (!already) addLog('[EDIT] Cancel — abort Gemini ngay.');
    };

    useEffect(() => {
        const names = editFiles.map((clip) => clip.originalName || clip.name).filter(Boolean);
        if (!editReplayLogText || !names.length) {
            setEditReplayHits({});
            return;
        }
        let cancel = false;
        fetch(`${BACKEND_URL}/api/edit/log-fallback-parts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logText: editReplayLogText, sourceNames: names }),
        })
            .then((response) => response.json())
            .then((data) => {
                if (!cancel) setEditReplayHits(data?.matches || {});
            })
            .catch(() => {
                if (!cancel) setEditReplayHits({});
            });
        return () => { cancel = true; };
    }, [editReplayLogText, editFiles]);

    const replayOneLoggedPart = async (clip: QueueClip, part: { partIndex: number; start: number; end: number; name: string }) => {
        if (!clip.localPath) throw new Error('File này không có đường dẫn nguồn trên máy');
        const response = await fetch(`${BACKEND_URL}/api/edit/part-test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourcePath: clip.localPath,
                partIndex: part.partIndex,
                segment: {
                    name: part.name,
                    title: part.name,
                    partIndex: part.partIndex,
                    start: part.start,
                    end: part.end,
                    ranges: [[part.start, part.end]],
                },
                apiKey: editApiKeyRef.current,
                apiKeys: editGeminiKeys(),
                model: editModel,
                prompt: editPrompt,
                encoderMode: editEncoderMode,
                framingStyle: editFramingStyle,
                tiktokPad: String(editTikTokPad),
                tiktokMix: String(editTikTokMix),
                speechFraming: String(editSpeechFraming && editTikTokMix),
            }),
        });
        const created = await response.json().catch(() => ({}));
        if (!response.ok || !created.jobId) throw new Error(created.error || `HTTP ${response.status}`);
        editJobRef.current = created.jobId;
        return await new Promise<EditSegment>((resolve, reject) => {
            const es = new EventSource(`${BACKEND_URL}/api/edit/part-test/stream/${created.jobId}`);
            let settled = false;
            const finish = (fn: () => void) => {
                if (settled) return;
                settled = true;
                es.close();
                fn();
            };
            es.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.type === 'log') addLog(data.message, 'edit');
                else if (data.type === 'gemini-keys') {
                    setEditKeysPaused(true);
                    setEditPhase('keys');
                    addLog('[EDIT] Tạm dừng. Dán key mới vào ô Key dự phòng rồi bấm Tiếp tục.');
                } else if (data.type === 'gemini-keys-clear') {
                    setEditKeysPaused(false);
                } else if (data.type === 'gemini-key-quota') {
                    rememberGeminiQuota(String(data.keyId || ''), Array.isArray(data.models) ? data.models : [], Number(data.resetAt) || 0, true);
                } else if (data.type === 'gemini-key-used') {
                    rememberGeminiQuota(String(data.keyId || ''), [], 0, true);
                } else if (data.type === 'progress') {
                    const value = Number(data.value);
                    if (Number.isFinite(value)) setEditProgress(Math.max(0, Math.min(100, value)));
                    if (data.phase) setEditPhase(String(data.phase));
                } else if (data.type === 'done') {
                    const result: EditSegment = {
                        id: newClipId(),
                        sourceId: clip.id,
                        sourceName: clip.originalName || clip.name,
                        partIndex: part.partIndex,
                        parts: 1,
                        name: safeFileName(data.name),
                        title: data.title || data.name,
                        start: part.start,
                        end: part.end,
                        ranges: data.ranges || [[part.start, part.end]],
                        sourcePath: clip.localPath,
                        status: 'cut',
                        jobId: data.jobId,
                        downloadUrl: data.downloadUrl,
                        saved: false,
                    };
                    setEditSegments((prev) => [...prev, result]);
                    setEditSelectedIds((prev) => [...prev, result.id]);
                    finish(() => resolve(result));
                } else if (data.type === 'error') {
                    setEditKeysPaused(false);
                    finish(() => reject(new Error(data.message)));
                }
            };
            es.onerror = () => finish(() => reject(new Error('Targeted Part stream disconnected')));
        });
    };

    const replayClipParts = async (clip: QueueClip) => {
        const parts = editReplayHits[clip.originalName || clip.name] || [];
        if (!parts.length) return;
        if (!clip.localPath) {
            addLog(`[EDIT] Bỏ qua ${clip.originalName || clip.name}: chưa có đường dẫn nguồn`);
            return;
        }
        addLog(`[EDIT] Chỉ xử lý ${parts.length} part lỗi của ${clip.originalName || clip.name}`);
        const dest = (editFilesRef.current.find((item) => item.id === clip.id)?.outFolder || clip.outFolder || '').trim();
        for (const part of parts) {
            if (editCancelRef.current) throw new Error('cancelled');
            addLog(`[EDIT] Log replay Part ${part.partIndex}: ${part.start}s–${part.end}s`);
            try {
                const result = await replayOneLoggedPart(clip, part);
                if (!dest || !result?.jobId) {
                    addLog(`[EDIT] ${clip.name}: không có thư mục nguồn — file chờ Save`);
                    continue;
                }
                const res = await fetch(`${BACKEND_URL}/api/export-copy`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jobId: result.jobId, name: result.name, path: dest }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                setEditSegments((prev) => prev.map((item) => (
                    item.jobId === result.jobId ? { ...item, saved: true, savedTo: data.folder || dest, savedFile: data.dest } : item
                )));
                addLog(`[EDIT] SAVED: ${data.name || result.name} → ${data.folder || dest}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (editCancelRef.current || /cancell/i.test(message)) throw err;
                addLog(`[EDIT] Part ${part.partIndex} vẫn lỗi, sang part kế: ${message}`);
            }
        }
    };

    const beginReplay = () => {
        editCancelRef.current = false;
        editBusyRef.current = true;
        setEditBusy(true);
        setEditProgress(0);
        setEditPhase('targeted-part');
    };

    const endReplay = () => {
        editJobRef.current = null;
        editBusyRef.current = false;
        setEditBusy(false);
        setPartTestBusyId(null);
        setEditKeysPaused(false);
    };

    const replayLoggedFailures = async (clip: QueueClip) => {
        if (editBusyRef.current) return;
        beginReplay();
        try {
            await replayClipParts(clip);
        } catch (err) {
            addLog(`[EDIT] TARGETED PART TEST ERROR: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            endReplay();
        }
    };

    const replayAllLoggedFailures = async () => {
        if (editBusyRef.current) return;
        const queue = editFiles.filter((clip) => (editReplayHits[clip.originalName || clip.name] || []).length > 0);
        if (!queue.length) return;
        const partCount = queue.reduce((sum, clip) => sum + (editReplayHits[clip.originalName || clip.name] || []).length, 0);
        beginReplay();
        addLog(`[EDIT] Hàng chờ ${queue.length} video, ${partCount} part lỗi`);
        try {
            for (const clip of queue) {
                if (editCancelRef.current) throw new Error('cancelled');
                await replayClipParts(clip);
            }
            addLog('[EDIT] Hàng chờ part lỗi đã xong');
        } catch (err) {
            addLog(`[EDIT] TARGETED PART TEST ERROR: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            endReplay();
        }
    };

    const replaySegment = (video: ReplayVideoRow, part: ReplayPartRow): EditSegment => ({
        id: part.id,
        sourceId: video.sourcePath,
        sourceName: video.sourceName,
        name: part.partName || replayPartTitle(part.partName, part.partIndex),
        title: replayPartTitle(part.partName, part.partIndex),
        partIndex: part.partIndex,
        parts: video.parts.length,
        start: part.start,
        end: part.end,
        ranges: part.ranges,
        status: 'planned',
        sourcePath: video.sourcePath,
        sourceAvailable: video.sourceAvailable,
        historyId: replayRunId && video.sourcePath === replayRunSource ? replayRunId : undefined,
    });

    const testEditPart = async (seg: EditSegment, options?: { keepCancel?: boolean }) => {
        if (editBusyRef.current || (!seg.jobId && !seg.historyId && !seg.sourcePath)) return;
        const hasPieces = Boolean((seg.pieces?.length || 0) > 0 || (seg.ranges?.length || 0) > 0);
        if (!hasPieces && !(Number.isFinite(seg.start) && Number.isFinite(seg.end))) {
            addLog('[EDIT] TARGETED PART TEST ERROR: Part này thiếu pieces/ranges hoặc start/end.');
            return;
        }
        if (!options?.keepCancel) editCancelRef.current = false;
        editBusyRef.current = true;
        setEditBusy(true);
        setPartTestBusyId(seg.id);
        setEditProgress(0);
        setEditPhase('targeted-part');
        try {
            const response = await fetch(`${BACKEND_URL}/api/edit/part-test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    partJobId: seg.jobId,
                    historyId: seg.historyId,
                    sourcePath: seg.sourcePath,
                    partIndex: seg.partIndex,
                    segment: {
                        name: seg.name,
                        title: seg.title,
                        partIndex: seg.partIndex,
                        start: seg.start,
                        end: seg.end,
                        pieces: seg.pieces,
                        ranges: seg.ranges,
                    },
                    apiKey: editApiKey,
                    apiKeys: editGeminiKeys(),
                    model: editModel,
                    prompt: editPrompt,
                    encoderMode: editEncoderMode,
                    framingStyle: editFramingStyle,
                    tiktokPad: String(editTikTokPad),
                    tiktokMix: String(editTikTokMix),
                    speechFraming: String(editSpeechFraming && editTikTokMix),
                }),
            });
            const created = await response.json().catch(() => ({}));
            if (!response.ok || !created.jobId) throw new Error(created.error || `HTTP ${response.status}`);
            editJobRef.current = created.jobId;
            await new Promise<void>((resolve, reject) => {
                const es = new EventSource(`${BACKEND_URL}/api/edit/part-test/stream/${created.jobId}`);
                let settled = false;
                const finish = (fn: () => void) => {
                    if (settled) return;
                    settled = true;
                    es.close();
                    fn();
                };
                es.onmessage = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.type === 'log') addLog(data.message, 'edit');
                    else if (data.type === 'progress') {
                        const value = Number(data.value);
                        if (Number.isFinite(value)) setEditProgress(Math.max(0, Math.min(100, value)));
                        if (data.phase) setEditPhase(String(data.phase));
                    } else if (data.type === 'done') {
                        const result: EditSegment = {
                            ...seg,
                            id: newClipId(),
                            name: safeFileName(data.name),
                            title: data.title || data.name,
                            pieces: data.pieces || seg.pieces,
                            ranges: data.ranges || seg.ranges,
                            status: 'cut',
                            jobId: data.jobId,
                            historyId: seg.historyId,
                            sourcePath: data.sourcePath || seg.sourcePath,
                            sourceAvailable: true,
                            downloadUrl: data.downloadUrl,
                            saved: false,
                            savedTo: undefined,
                            savedFile: undefined,
                        };
                        setEditSegments((prev) => [...prev, result]);
                        setEditSelectedIds((prev) => [...prev, result.id]);
                        finish(resolve);
                    } else if (data.type === 'error') {
                        finish(() => reject(new Error(data.message)));
                    }
                };
                es.onerror = () => finish(() => reject(new Error('Targeted Part stream disconnected')));
            });
        } catch (err) {
            addLog(`[EDIT] TARGETED PART TEST ERROR: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            editJobRef.current = null;
            editBusyRef.current = false;
            setEditBusy(false);
            setPartTestBusyId(null);
            loadReplayCatalog();
        }
    };

    const runReplaySelected = async (video: ReplayVideoRow, parts: ReplayPartRow[]) => {
        const chosen = parts.filter((part) => replaySelected.includes(part.id));
        if (!chosen.length || editBusyRef.current) return;
        editCancelRef.current = false;
        for (const part of chosen) {
            if (editCancelRef.current) break;
            await testEditPart(replaySegment(video, part), { keepCancel: true });
        }
        setReplaySelected([]);
    };

    const addReframeFiles = useCallback((incoming: File[]) => {
        const videos = incoming.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(f.name));
        if (!videos.length) {
            addLog('[REFRAME] ERROR: No video files in that selection.');
            return;
        }
        setReframeFiles((prev) => {
            const have = new Set(prev.map((c) => fileKey(c.file)));
            const fresh = videos.filter((f) => !have.has(fileKey(f))).map((f) => ({
                id: newClipId(),
                file: f,
                name: safeFileName(f.name),
                originalName: f.name,
            }));
            if (!fresh.length) {
                addLog('[REFRAME] Those videos are already in the reframe queue.');
                return prev;
            }
            addLog(`[REFRAME] Added ${fresh.length}: ${fresh.map((c) => c.name).join(', ')}`);
            if (reframeBusyRef.current) addLog('[REFRAME] Live queue: clip mới chạy sau nguồn đang xử lý.');
            const next = [...prev, ...fresh];
            reframeFilesRef.current = next;
            return next;
        });
    }, [addLog]);

    const pickReframeFromPc = async () => {
        addLog('[REFRAME] Opening Windows file dialog — check the taskbar if it is behind the browser.');
        try {
            const res = await fetch(`${BACKEND_URL}/api/pick-videos`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            const list = Array.isArray(data.files) ? data.files : [];
            if (!list.length) {
                addLog('[REFRAME] No videos picked.');
                return;
            }
            setReframeFiles((prev) => {
                const have = new Set(prev.map((c) => c.localPath || fileKey(c.file)));
                const fresh: QueueClip[] = [];
                for (const f of list) {
                    const p = String(f.path || '');
                    if (!p || have.has(p)) continue;
                    have.add(p);
                    fresh.push({
                        id: newClipId(),
                        file: new File([], String(f.name || 'video.mp4'), { type: 'video/mp4' }),
                        name: safeFileName(String(f.name || 'video.mp4')),
                        originalName: String(f.name || 'video.mp4'),
                        localPath: p,
                        fileSize: Number(f.size) || 0,
                        outFolder: String(f.folder || '').trim() || undefined,
                    });
                }
                if (!fresh.length) {
                    addLog('[REFRAME] Those videos are already in the reframe queue.');
                    return prev;
                }
                addLog(`[REFRAME] Added ${fresh.length} from disk.`);
                if (reframeBusyRef.current) addLog('[REFRAME] Live queue: clip mới chạy sau nguồn đang xử lý.');
                const next = [...prev, ...fresh];
                reframeFilesRef.current = next;
                return next;
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/cancel/i.test(msg)) return;
            addLog(`[REFRAME] Pick videos failed: ${msg}`);
        }
    };

    const runOneReframe = (clip: QueueClip) =>
        new Promise<QueueResult>((resolve, reject) => {
            const tag = clip.name.replace(/\.[^.]+$/, '').slice(0, 22);
            const log = (msg: string) => addLog(`[${tag}] ${msg}`, 'reframe');
            const body = {
                path: clip.localPath,
                aspect: reframeAspect,
                tightness: String(reframeTight),
                apiKey: editApiKey,
                model: editModel,
            };
            const upload = clip.localPath
                ? fetch(`${BACKEND_URL}/api/reframe/job-local`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                : (() => {
                    const formData = new FormData();
                    formData.append('video', clip.file);
                    formData.append('aspect', reframeAspect);
                    formData.append('tightness', String(reframeTight));
                    formData.append('apiKey', editApiKey);
                    formData.append('model', editModel);
                    return fetch(`${BACKEND_URL}/api/reframe/job`, { method: 'POST', body: formData });
                })();
            log(clip.localPath ? `Reframe from disk: ${clip.name}` : `Uploading for Reframe: ${clip.name}…`);
            upload
                .then(async (uploadRes) => {
                    const uploaded = await uploadRes.json().catch(() => ({}));
                    if (!uploadRes.ok) throw new Error(uploaded.error || `Upload failed ${uploadRes.status}`);
                    const { jobId } = uploaded;
                    reframeJobRef.current = jobId;
                    log(`Reframe job ${String(jobId).slice(0, 8)}…`);
                    const es = new EventSource(`${BACKEND_URL}/api/reframe/stream/${jobId}`);
                    let settled = false;
                    const drop = () => { es.close(); };
                    es.onmessage = (ev) => {
                        const data = JSON.parse(ev.data);
                        if (data.type === 'log' && data.message) log(data.message);
                        if (data.type === 'progress') {
                            if (typeof data.value === 'number') setReframeProgress(data.value);
                            if (typeof data.watch === 'number') setReframeWatchPct(data.watch);
                            if (data.phase) setReframePhase(data.phase);
                        }
                        if (data.type === 'error') {
                            if (settled) return;
                            settled = true;
                            drop();
                            reject(new Error(data.message || 'Reframe failed'));
                        }
                        if (data.type === 'done') {
                            if (settled) return;
                            settled = true;
                            drop();
                            resolve({
                                name: data.name || clip.name,
                                originalName: clip.originalName,
                                jobId,
                                downloadUrl: data.downloadUrl || `/api/download/${jobId}`,
                                stats: {
                                    originalHash: '',
                                    newHash: '',
                                    platform: 'tiktok',
                                    processingTimeMs: 0,
                                    originalSize: clip.fileSize || clip.file.size || 0,
                                    newSize: 0,
                                    temporalMode: data.summary || 'AI reframe',
                                    fpsJitter: `${data.points || 0} track pts`,
                                    geometricMode: `${reframeAspect} follow speaker/action`,
                                    adversarialMode: 'off',
                                    metadataProfile: 'none',
                                    newWidth: data.width,
                                    newHeight: data.height,
                                },
                            });
                        }
                    };
                    es.onerror = () => {
                        if (settled) { drop(); return; }
                        window.setTimeout(() => {
                            if (settled) return;
                            settled = true;
                            drop();
                            reject(new Error('Reframe stream disconnected — xem log [REFRAME]'));
                        }, 800);
                    };
                })
                .catch(reject);
        });

    const startReframe = async () => {
        if (reframeBusyRef.current) return;
        if (!reframeFilesRef.current.length) return;
        if (!editApiKey.trim() && !adcInfo?.ok) {
            addLog('[REFRAME] ERROR: Chưa ADC. Chạy gcloud auth application-default login rồi restart start.bat — hoặc dán API key.');
            return;
        }
        reframeCancelRef.current = false;
        reframeBusyRef.current = true;
        setReframeBusy(true);
        setReframeProgress(0);
        setReframeWatchPct(0);
        setReframePhase('start');
        addLog(`[REFRAME] Start ${reframeFilesRef.current.length} · ${reframeAspect} · tightness ${reframeTight.toFixed(2)}`);
        const processed = new Set<string>();
        try {
            while (!reframeCancelRef.current) {
                const clip = reframeFilesRef.current.find((c) => !processed.has(c.id));
                if (!clip) break;
                processed.add(clip.id);
                reframeActiveClipIdRef.current = clip.id;
                addLog(`[REFRAME] ---- ${clip.name} ----`);
                try {
                    const item = await runOneReframe(clip);
                    setReframeResults((prev) => [item, ...prev]);
                    const dest = (reframeFilesRef.current.find((c) => c.id === clip.id)?.outFolder || clip.outFolder || osSavePath || '').trim();
                    if (dest && item.jobId) {
                        try {
                            const res = await fetch(`${BACKEND_URL}/api/export-copy`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ jobId: item.jobId, name: item.name, path: dest }),
                            });
                            const data = await res.json().catch(() => ({}));
                            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                            setReframeResults((prev) => prev.map((r) => (
                                r.jobId === item.jobId
                                    ? { ...r, saved: true, savedTo: data.folder || dest, savedFile: data.dest }
                                    : r
                            )));
                            addLog(`[REFRAME] SAVED: ${data.name || item.name} → ${data.folder || dest}`);
                        } catch (saveErr: unknown) {
                            addLog(`[REFRAME] Auto-save failed: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
                        }
                    }
                    await releaseYoutubeImport(clip, 'done', 'reframe');
                    setReframeFiles((prev) => {
                        const next = prev.filter((c) => c.id !== clip.id);
                        reframeFilesRef.current = next;
                        return next;
                    });
                    addLog(`[REFRAME] Removed ${clip.name} from waiting queue.`);
                } catch (clipErr: unknown) {
                    if (reframeCancelRef.current) break;
                    addLog(`[REFRAME] ERROR: ${clip.name} — ${clipErr instanceof Error ? clipErr.message : String(clipErr)}`);
                    addLog('[REFRAME] Keeping this clip in queue.');
                } finally {
                    if (reframeActiveClipIdRef.current === clip.id) reframeActiveClipIdRef.current = null;
                }
            }
            addLog(reframeCancelRef.current ? '[REFRAME] Stopped.' : '[REFRAME] Queue finished.');
        } finally {
            reframeBusyRef.current = false;
            setReframeBusy(false);
            reframeJobRef.current = null;
        }
    };

    const cancelReframe = async () => {
        reframeCancelRef.current = true;
        const id = reframeJobRef.current;
        if (id) {
            try { await fetch(`${BACKEND_URL}/api/cancel/${id}`, { method: 'POST' }); } catch { /* ignore */ }
        }
        addLog('[REFRAME] Cancel requested.');
    };

    const sendReframeToUnique = async () => {
        const chosen = reframeResults.filter((r) => reframeSelectedIds.includes(r.jobId) && r.downloadUrl && !r.failed);
        const list = chosen.length ? chosen : reframeResults.filter((r) => r.downloadUrl && !r.failed);
        if (!list.length) {
            addLog('[REFRAME] Chưa có clip xong để gửi Unique.');
            return;
        }
        const files: File[] = [];
        for (const item of list) {
            try {
                const res = await fetch(`${BACKEND_URL}${item.downloadUrl}?name=${encodeURIComponent(item.name)}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                files.push(new File([blob], item.name, { type: 'video/mp4' }));
            } catch (err: unknown) {
                addLog(`[REFRAME] Could not load ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const before = filesRef.current.length;
        if (files.length) addFiles(files);
        setAppTab('unique');
        addLog(`[REFRAME] Sent ${files.length} clip(s) to Unique queue.`);
        if (filesRef.current.length > before && !processingRef.current) handoffRef.current(handoffPresetId);
    };

    const sendSourcesToUnique = () => {
        if (!editFiles.length) return;
        const fromBrowser = editFiles.filter((c) => !c.localPath);
        const before = filesRef.current.length;
        if (fromBrowser.length) addFiles(fromBrowser.map((c) => c.file));
        const disk = editFiles.filter((c) => c.localPath);
        if (disk.length) addLog('[EDIT] Clip thêm bằng Add from PC: Unique tab cần add lại (browser không đọc ổ D:).');
        setAppTab('unique');
        addLog(`[EDIT] Sent ${fromBrowser.length} source video(s) to Unique queue.`);
        if (filesRef.current.length > before && !processingRef.current) handoffRef.current(handoffPresetId);
    };

    const sendCutsToUnique = async () => {
        const chosen = editSegments.filter((s) => editSelectedIds.includes(s.id) && s.status === 'cut' && s.downloadUrl);
        if (!chosen.length) {
            addLog('[EDIT] Chưa có clip đã cắt. Chạy Gemini/cắt trước, hoặc gửi source.');
            return;
        }
        const files: File[] = [];
        for (const s of chosen) {
            try {
                const res = await fetch(`${BACKEND_URL}${s.downloadUrl}?name=${encodeURIComponent(s.name)}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                files.push(new File([blob], s.name, { type: 'video/mp4' }));
            } catch (err: unknown) {
                addLog(`[EDIT] Could not load ${s.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        if (!files.length) return;
        const before = filesRef.current.length;
        addFiles(files);
        setEditSegments((prev) => prev.map((s) => chosen.some((c) => c.id === s.id) ? { ...s, status: 'sent' } : s));
        setAppTab('unique');
        addLog(`[EDIT] Sent ${files.length} cut clip(s) to Unique queue.`);
        if (filesRef.current.length > before && !processingRef.current) handoffRef.current(handoffPresetId);
    };

    const editToResult = (s: EditSegment): QueueResult | null => {
        if (!s.jobId || !s.downloadUrl || s.status === 'failed' || s.status === 'planned') return null;
        const url = s.downloadUrl.startsWith('http') ? s.downloadUrl : `${BACKEND_URL}${s.downloadUrl}`;
        return {
            name: safeFileName(s.name),
            originalName: s.name,
            jobId: s.jobId,
            downloadUrl: url,
            saved: s.saved,
            savedTo: s.savedTo,
            savedFile: s.savedFile,
        };
    };

    const saveEditItems = (ids?: string[]) => {
        const pool = ids
            ? editSegments.filter((s) => ids.includes(s.id))
            : editSegments;
        const items = pool.map(editToResult).filter((x): x is QueueResult => !!x);
        if (!items.length) {
            addLog('[EDIT] No cut clips to save yet.');
            return;
        }
        void saveAllToShared(items, 'edit');
    };

    const saveEditOneToFolder = (seg: EditSegment) => {
        const item = editToResult(seg);
        if (!item) {
            addLog('[EDIT] Clip chưa cắt xong.');
            return;
        }
        void saveOneToChosenFolder(item, 'edit');
    };

    const saveEditGroupToFolder = async (sourceId: string, sourceName: string, ids: string[]) => {
        const items = editSegments
            .filter((s) => ids.includes(s.id))
            .map(editToResult)
            .filter((item): item is QueueResult => !!item);
        if (!items.length) {
            addLog('[EDIT] Chọn part đã cắt của video này trước khi lưu.');
            return;
        }
        let dest = '';
        try {
            const picked = await pickWindowsFolder(false, 'edit');
            dest = picked.path;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/cancel/i.test(msg)) return;
            addLog(`[EDIT] Chưa chọn được thư mục: ${msg}`);
            return;
        }
        let folder = '';
        let saved = 0;
        const errors: string[] = [];
        setEditGroupBusyId(sourceId);
        setEditGroupSave((prev) => ({
            ...prev,
            [sourceId]: { folder: dest, error: '', saved: 0, total: items.length },
        }));
        addLog(`[EDIT] Lưu ${items.length} part của ${sourceName} vào thư mục con trong ${dest}`);
        try {
            for (const item of items) {
                try {
                    const res = await fetch(`${BACKEND_URL}/api/export-copy`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jobId: item.jobId,
                            name: item.name,
                            path: dest,
                            groupFolder: sourceName,
                            existingDest: item.savedFile || '',
                        }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (data.folder) folder = String(data.folder);
                    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                    saved += 1;
                    markSaved(item.jobId, data.folder || dest, data.name || safeFileName(item.name), data.dest, Boolean(data.skipped), 'edit');
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`${item.name}: ${msg}`);
                    addLog(`[EDIT] Lưu part lỗi ${item.name}: ${msg}`);
                }
            }
            const shown = folder || dest;
            const error = errors.length ? errors.join(' · ') : '';
            setEditGroupSave((prev) => ({
                ...prev,
                [sourceId]: { folder: shown, error, saved, total: items.length },
            }));
            if (folder && saved > 0) {
                try {
                    const opened = await fetch(`${BACKEND_URL}/api/open-folder`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: folder }),
                    });
                    const data = await opened.json().catch(() => ({}));
                    if (!opened.ok) addLog(`[EDIT] Không mở được thư mục: ${data.error || opened.status}`);
                    else addLog(`[EDIT] Đã mở thư mục: ${data.dir || folder}`);
                } catch (err: unknown) {
                    addLog(`[EDIT] Không mở được thư mục: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        } finally {
            setEditGroupBusyId('');
        }
    };




    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            addFiles(Array.from(e.target.files));
        }
        e.target.value = '';
    };

    const removeFile = (index: number) => {
        const removed = filesRef.current[index];
        if (!removed) return;
        if (processingRef.current && activeQueueIds.includes(removed.id)) return;
        const unclaimed = processingRef.current && !claimedRef.current.has(removed.id);
        setFiles((prev) => {
            const next = prev.filter((c) => c.id !== removed.id);
            filesRef.current = next;
            addLog(`[SYS] Removed ${removed.name} from queue. Queue: ${next.length}`);
            return next;
        });
        if (unclaimed && queueTotalRef.current > 0) {
            queueTotalRef.current -= 1;
            setQueueTotal(queueTotalRef.current);
        }
        void releaseYoutubeImport(removed, 'remove', 'unique');
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        const dropped = Array.from(e.dataTransfer.files || []);
        if (dropped.length) addFiles(dropped);
    };

    const processOneFile = (clip: QueueClip, look: UniqueLook, presetName = '') =>
        new Promise<QueueResult>((resolve, reject) => {
            const tag = clip.name.replace(/\.[^.]+$/, '').slice(0, 22);
            const log = (msg: string) => addLog(`[${tag}] ${msg}`, 'unique');
            const spin = rotatePartsFrom(look.rotateMode);
            const settings = {
                platformMode: String(look.platformMode),
                uniqueStrength: String(look.uniqueStrength),
                featherTop: String(look.featherTop),
                featherBottom: String(look.featherBottom),
                featherEnabled: String(!!look.featherEnabled),
                uniqueRotate: String(spin.rotate),
                uniqueWobble: String(spin.wobble),
                enableAdversarial: String(look.enableAdversarial),
                enableAudioAttack: String(look.enableAudioAttack),
                enableTikTokCanvas: String(look.enableTikTokCanvas),
                enablePgd: String(!!look.enablePgd),
                enablePgdOnly: String(!!(look.enablePgd && look.enablePgdOnly)),
                enableSmooth: String(!!look.enableSmooth),
                smoothMode: look.smoothMode === 'ai' ? 'ai' : 'fast',
                presetName: String(presetName || '').slice(0, 40),
                handoffFrom: clip.handoffFrom === 'youtube' ? 'youtube' : '',
                handoffPreset: String(clip.handoffPreset || '').slice(0, 40),
                enableCaptions: String(!!look.enableCaptions),
                captionPlace: look.captionPlace === 'bottom' ? 'bottom' : 'middle',
                enableFullMeasure: String(!!enableFullMeasure),
                pgdLevel: String(look.pgdLevel),
                encoderMode: String(look.encoderMode),
                outputName: String(clip.name || ''),
            };
            const epoch = uniqueEpochRef.current;
            let settled = false;
            let closeStream = () => {};
            const watch = setInterval(() => {
                if (settled || (uniqueEpochRef.current === epoch && !cancelRef.current)) return;
                settled = true;
                clearInterval(watch);
                closeStream();
                reject(new Error('cancelled'));
            }, 200);
            const succeed = (value: QueueResult) => {
                if (settled) return;
                settled = true;
                clearInterval(watch);
                resolve(value);
            };
            const fail = (err: unknown) => {
                if (settled) return;
                settled = true;
                clearInterval(watch);
                reject(err instanceof Error ? err : new Error(String(err)));
            };
            const attachStream = (jobId: string) => {
                if (settled || uniqueEpochRef.current !== epoch) return;
                log(`Job ID: ${jobId}`);
                jobsRef.current.add(jobId);
                if (pauseRef.current) {
                    void fetch(`${BACKEND_URL}/api/unique/pause/${jobId}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ paused: true }),
                    }).catch(() => {});
                }
                const eventSource = new EventSource(`${BACKEND_URL}/api/stream/${jobId}`);
                sourcesRef.current.set(jobId, eventSource);
                const drop = () => {
                    eventSource.close();
                    sourcesRef.current.delete(jobId);
                    jobsRef.current.delete(jobId);
                    delete progressMapRef.current[clip.id];
                    delete pgdMapRef.current[clip.id];
                };
                closeStream = drop;
                eventSource.onmessage = (ev) => {
                    const data = JSON.parse(ev.data);
                    if (data.type === 'log') log(data.message);
                    else if (data.type === 'progress') {
                        const eta = Number(data.etaMs);
                        if (data.phase === 'pgd') {
                            setPgdActive(true);
                            if (Number.isFinite(eta)) setPgdEtaMs(eta);
                            else if (Number(data.value) === 0) setPgdEtaMs(null);
                            pgdMapRef.current[clip.id] = Number(data.value) || 0;
                            const vals = Object.values(pgdMapRef.current);
                            setPgdProgress(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
                        } else if (data.phase === 'smooth' || data.phase === 'caption') {
                            setSidePhase(data.phase);
                            setSideProgress(Number(data.value) || 0);
                        } else {
                            setSidePhase((cur) => (cur === 'smooth' ? '' : cur));
                            if (Number.isFinite(eta)) setProgressEtaMs(eta);
                            progressMapRef.current[clip.id] = Number(data.value) || 0;
                            const vals = Object.values(progressMapRef.current);
                            setProgress(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
                        }
                    } else if (data.type === 'done') {
                        drop();
                        const latest = filesRef.current.find((c) => c.id === clip.id);
                        succeed({
                            name: safeFileName(latest?.name || clip.name),
                            originalName: clip.originalName,
                            jobId,
                            downloadUrl: `${BACKEND_URL}/api/download/${jobId}`,
                            stats: data.stats,
                            handoffNote: String(data.stats?.handoffNote || ''),
                        });
                    } else if (data.type === 'error') {
                        drop();
                        fail(new Error(data.message));
                    }
                };
                eventSource.onerror = () => {
                    if (settled) return;
                    drop();
                    fail(new Error('Telemetry stream disconnected unexpectedly.'));
                };
            };

            if (clip.localPath) {
                log(`Unique from disk: ${clip.name}`);
                fetch(`${BACKEND_URL}/api/unique/job-local`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: clip.localPath, ...settings }),
                })
                    .then(async (res) => {
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
                        if (cancelRef.current || uniqueEpochRef.current !== epoch) throw new Error('cancelled');
                        attachStream(String(data.jobId));
                    })
                    .catch(fail);
                return;
            }

            const formData = new FormData();
            formData.append('video', clip.file);
            Object.entries(settings).forEach(([key, value]) => formData.append(key, value));
            log(`Uploading ${clip.originalName} → ${clip.name}...`);
            fetch(`${BACKEND_URL}/api/upload`, { method: 'POST', body: formData })
                .then(async (uploadRes) => {
                    const uploaded = await uploadRes.json().catch(() => ({}));
                    if (!uploadRes.ok) throw new Error(uploaded.error || `Upload failed with status ${uploadRes.status}`);
                    if (cancelRef.current || uniqueEpochRef.current !== epoch) throw new Error('cancelled');
                    attachStream(String(uploaded.jobId));
                })
                .catch(fail);
        });

    const pickSaveFolder = async (channel: LogBucket = 'unique') => {
        addLog('[SYS] Opening Windows folder dialog — check the taskbar if it is behind the browser.', channel);
        try {
            const res = await fetch(`${BACKEND_URL}/api/pick-folder`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.path) {
                setSavePathSticky(data.path);
                setSaveFolderName(data.name || data.path);
                setFolderReady(true);
                addLog(`[SYS] Save folder: ${data.path}`, channel);
                return;
            }
            addLog(`[SYS] Native picker: ${data.error || res.status}. Falling back to browser picker.`, channel);
        } catch (err: unknown) {
            addLog(`[SYS] Native picker failed: ${err instanceof Error ? err.message : String(err)}`, channel);
        }
        const w = window as unknown as { showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle> };
        if (typeof w.showDirectoryPicker !== 'function') {
            addLog('[SYS] Chrome/Edge required to pick a folder. Firefox always uses Downloads.', channel);
            return;
        }
        try {
            const dir = await w.showDirectoryPicker({ mode: 'readwrite' });
            const ok = await dirPermission(dir, true);
            saveDirRef.current = dir;
            setSaveFolderName(dir.name);
            setFolderReady(ok);
            await persistDirHandle(dir);
            addLog(ok
                ? `[SYS] Save folder locked: ${dir.name} — paste full path once to Open in Explorer`
                : `[SYS] Folder picked but write not allowed: ${dir.name}`, channel);
        } catch (err: unknown) {
            if (err instanceof Error && err.name === 'AbortError') return;
            addLog(`[SYS] Folder pick failed: ${err instanceof Error ? err.message : String(err)}`, channel);
        }
    };

    const allowFolder = async () => {
        const dir = saveDirRef.current;
        if (!dir) return pickSaveFolder();
        const ok = await dirPermission(dir, true);
        setFolderReady(ok);
        addLog(ok ? `[SYS] Folder write allowed: ${dir.name}` : '[SYS] Folder permission denied');
    };

    const fetchVideoBlob = async (item: QueueResult) => {
        const filename = safeFileName(item.name);
        const res = await fetch(`${item.downloadUrl}?name=${encodeURIComponent(filename)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { blob: await res.blob(), filename };
    };

    const openSavedLocation = async (item?: QueueResult, channel: LogBucket = 'unique') => {
        const downloads = item?.savedTo === 'Downloads';
        const target = downloads ? 'Downloads' : (
            item?.savedTo && /[\\/]/.test(item.savedTo) && item.savedTo !== 'Downloads'
                ? item.savedTo
                : osSavePath.trim()
        );
        setSaveNotice(`Opening ${target || 'folder'}…`);
        addLog(`[SYS] Open folder click: ${target || '(none)'} · file ${item ? safeFileName(item.name) : ''}`, channel);
        try {
            const res = await fetch(`${BACKEND_URL}/api/open-folder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: downloads ? '' : target,
                    downloads,
                    file: item ? safeFileName(item.name) : '',
                    filePath: item?.savedFile || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                addLog(`[SYS] Open folder failed: ${data.error || res.status}`, channel);
                setSaveNotice(String(data.error || 'Open folder failed'));
                return;
            }
            const shown = data.dir || target;
            addLog(`[SYS] Explorer opened: ${shown}`, channel);
            setSaveNotice(`Opened: ${shown}`);
            window.setTimeout(() => setSaveNotice((cur) => (cur && cur.startsWith('Opened:') ? null : cur)), 5000);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addLog(`[SYS] Open folder failed: ${msg}`, channel);
            setSaveNotice(`Open folder failed: ${msg}`);
        }
    };

    const markSaved = (jobId: string, where: string, filename: string, savedFile?: string, kept = false, channel: LogBucket = 'unique') => {
        setQueueResults((prev) => prev.map((r) => (
            r.jobId === jobId ? { ...r, saved: true, savedTo: where, savedFile: savedFile || r.savedFile } : r
        )));
        setEditSegments((prev) => prev.map((s) => (
            s.jobId === jobId ? { ...s, saved: true, savedTo: where, savedFile: savedFile || s.savedFile } : s
        )));
        setReframeResults((prev) => prev.map((r) => (
            r.jobId === jobId ? { ...r, saved: true, savedTo: where, savedFile: savedFile || r.savedFile } : r
        )));
        setSaveNotice(kept ? `Đã có sẵn: ${filename}` : `Saved: ${filename} → ${where}`);
        addLog(kept ? `[SYS] Giữ file đã lưu: ${filename} → ${where}` : `[SYS] SAVED OK: ${filename} → ${where}`, channel);
        if (channel === 'unique') {
            void fetch(`${BACKEND_URL}/api/unique/held/${jobId}`, { method: 'DELETE' }).catch(() => {});
        }
        window.setTimeout(() => setSaveNotice((cur) => (cur && cur.includes(filename) ? null : cur)), 6000);
    };

    const writeToSaveFolder = async (item: QueueResult, dir?: FileSystemDirectoryHandle, destPath?: string, channel: LogBucket = 'unique') => {
        const dest = (destPath ?? osSavePath).trim();
        if (dest) {
            const res = await fetch(`${BACKEND_URL}/api/export-copy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: item.jobId,
                    name: item.name,
                    path: dest,
                    existingDest: item.savedFile || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            markSaved(item.jobId, data.folder || dest, data.name || safeFileName(item.name), data.dest, Boolean(data.skipped), channel);
            return;
        }
        if (!dir) throw new Error('No save folder');
        const { blob, filename } = await fetchVideoBlob(item);
        const handle = await dir.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        markSaved(item.jobId, dir.name, filename, undefined, false, channel);
    };

    const triggerBrowserDownload = async (item: QueueResult, channel: LogBucket = 'unique') => {
        const { blob, filename } = await fetchVideoBlob(item);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 8000);
        markSaved(item.jobId, 'Downloads', filename, undefined, false, channel);
    };

    const pickWindowsFolder = async (sticky: boolean, channel: LogBucket = 'unique') => {
        addLog('[SYS] Opening Windows folder dialog — check the taskbar if it is behind the browser.', channel);
        const start = encodeURIComponent(osSavePath.trim());
        const res = await fetch(`${BACKEND_URL}/api/pick-folder?sticky=${sticky ? '1' : '0'}&start=${start}`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.path) throw new Error(data.error || 'Folder pick cancelled');
        return data as { path: string; name: string };
    };

    const folderLabel = (p?: string) => {
        if (!p) return '';
        const t = p.replace(/[\\/]+$/, '');
        return t.split(/[\\/]/).pop() || t;
    };

    const pickEditClipFolder = async (clipId: string) => {
        try {
            const picked = await pickWindowsFolder(false, 'edit');
            setEditFiles((prev) => prev.map((c) => (c.id === clipId ? { ...c, outFolder: picked.path } : c)));
            const clip = editFilesRef.current.find((c) => c.id === clipId);
            addLog(`[EDIT] ${clip?.name || 'source'} — cuts will auto-save to ${picked.path}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/cancel/i.test(msg)) return;
            addLog(`[EDIT] Folder pick failed: ${msg}`);
        }
    };

    const clearEditClipFolder = (clipId: string) => {
        setEditFiles((prev) => prev.map((c) => (c.id === clipId ? { ...c, outFolder: undefined } : c)));
        addLog('[EDIT] Cleared output folder — this source will wait for Save.');
    };

    const saveOneToChosenFolder = async (item: QueueResult, channel: LogBucket = 'unique') => {
        try {
            const picked = await pickWindowsFolder(false, channel);
            const res = await fetch(`${BACKEND_URL}/api/export-copy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId: item.jobId,
                    name: item.name,
                    path: picked.path,
                    existingDest: item.savedFile || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            markSaved(item.jobId, data.folder || picked.path, data.name || safeFileName(item.name), data.dest, Boolean(data.skipped), channel);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/cancel/i.test(msg)) addLog('[SYS] Per-clip folder pick cancelled.', channel);
            else addLog(`[SYS] Save to folder failed: ${msg}`, channel);
        }
    };

    const saveAllToShared = async (items: QueueResult[], channel: LogBucket = 'unique') => {
        let dest = osSavePath.trim();
        if (!dest) {
            try {
                const picked = await pickWindowsFolder(true, channel);
                setSavePathSticky(picked.path);
                setSaveFolderName(picked.name);
                setFolderReady(true);
                dest = picked.path;
            } catch (err: unknown) {
                addLog(`[SYS] Need a shared folder first: ${err instanceof Error ? err.message : String(err)}`, channel);
                return;
            }
        }
        await saveItems(items, dest, channel);
    };

    const saveItems = async (items: QueueResult[], destPath?: string, channel: LogBucket = 'unique') => {
        if (!items.length) {
            addLog('[SYS] No videos selected.', channel);
            return;
        }
        const dest = (destPath ?? osSavePath).trim();
        const ready = items.filter((it) => !it.failed && it.downloadUrl);
        if (!ready.length) {
            addLog('[SYS] No successful videos to save.', channel);
            return;
        }
        const dir = saveDirRef.current;
        const canFolder = dest ? true : (dir ? await dirPermission(dir, true) : false);
        setFolderReady(canFolder);
        if (canFolder) {
            addLog(`[SYS] Saving ${ready.length} video(s) to ${dest || dir?.name}…`, channel);
            for (const item of ready) {
                try {
                    await writeToSaveFolder(item, dir || undefined, dest, channel);
                } catch (err: unknown) {
                    addLog(`[SYS] Folder write failed ${item.name}: ${err instanceof Error ? err.message : String(err)}`, channel);
                    try { await triggerBrowserDownload(item, channel); } catch { /* ignore */ }
                }
            }
            addLog('[SYS] Folder save finished.', channel);
            return;
        }
        addLog(`[SYS] Downloading ${ready.length} file(s)…`, channel);
        for (let i = 0; i < ready.length; i++) {
            try {
                await triggerBrowserDownload(ready[i], channel);
            } catch (err: unknown) {
                addLog(`[SYS] Download failed ${ready[i].name}: ${err instanceof Error ? err.message : String(err)}`, channel);
            }
            if (i < items.length - 1) await new Promise((r) => setTimeout(r, 400));
        }
    };

    const toggleSelected = (jobId: string) => {
        setSelectedIds((prev) => prev.includes(jobId) ? prev.filter((id) => id !== jobId) : [...prev, jobId]);
    };

    const renameCompleted = (jobId: string, nextName: string) => {
        const name = safeFileName(nextName);
        setQueueResults((prev) => prev.map((r) => (
            r.jobId === jobId ? { ...r, name: name || r.originalName } : r
        )));
        setReframeResults((prev) => prev.map((r) => (
            r.jobId === jobId ? { ...r, name: name || r.originalName } : r
        )));
        void fetch(`${BACKEND_URL}/api/unique/held/${jobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name || nextName }),
        }).catch(() => {});
    };

    const renameQueued = (id: string, nextName: string) => {
        setFiles((prev) => {
            const next = prev.map((c) => (
                c.id === id ? { ...c, name: safeFileName(nextName || c.originalName) } : c
            ));
            filesRef.current = next;
            return next;
        });
    };

    const removeCompleted = async (jobId: string, channel: LogBucket = 'unique') => {
        try {
            await fetch(`${BACKEND_URL}/api/job/${jobId}`, { method: 'DELETE' });
        } catch { /* still drop from UI */ }
        setQueueResults((prev) => prev.filter((r) => r.jobId !== jobId));
        setReframeResults((prev) => prev.filter((r) => r.jobId !== jobId));
        setSelectedIds((prev) => prev.filter((id) => id !== jobId));
        setReframeSelectedIds((prev) => prev.filter((id) => id !== jobId));
        addLog(`[SYS] Removed completed job ${jobId.slice(0, 8)}…`, channel);
    };

    const removeAllCompleted = async () => {
        if (!queueResults.length) return;
        const unsaved = queueResults.filter((r) => !r.failed && !r.saved).length;
        if (unsaved && !window.confirm(`${unsaved} clip chưa Save. Xóa hết danh sách Completed? File đã save trên đĩa vẫn còn.`)) return;
        await Promise.all(queueResults.map(async (r) => {
            if (String(r.jobId).startsWith('failed-')) return;
            try { await fetch(`${BACKEND_URL}/api/job/${r.jobId}`, { method: 'DELETE' }); } catch { /* ignore */ }
        }));
        setQueueResults([]);
        setSelectedIds([]);
        addLog('[SYS] Cleared completed list.');
    };

    const moveFile = (from: number, to: number) => {
        if (isProcessing || from === to || from < 0 || to < 0) return;
        setFiles((prev) => {
            if (from >= prev.length || to >= prev.length) return prev;
            const next = [...prev];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            filesRef.current = next;
            return next;
        });
    };

    const pauseProcessing = async () => {
        const next = !pauseRef.current;
        pauseRef.current = next;
        setIsPaused(next);
        addLog(next
            ? '[SYS] Tạm dừng — video đang chạy được giữ nguyên, hàng chờ không lấy clip mới.'
            : '[SYS] Tiếp tục Unique.');
        const running = [...jobsRef.current];
        await Promise.all(running.map(async (id) => {
            try {
                const res = await fetch(`${BACKEND_URL}/api/unique/pause/${id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paused: next }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || data.ok === false) {
                    addLog(`[SYS] Không ${next ? 'tạm dừng' : 'tiếp tục'} được job ${id.slice(0, 8)}.`);
                }
            } catch { /* ignore */ }
        }));
    };

    const cancelProcessing = async () => {
        uniqueEpochRef.current += 1;
        cancelRef.current = true;
        processingRef.current = false;
        pauseRef.current = false;
        setIsPaused(false);
        addLog('[SYS] Cancel — killing all running FFmpeg jobs.');
        const running = [...jobsRef.current];
        for (const es of sourcesRef.current.values()) {
            try { es.close(); } catch { /* ignore */ }
        }
        sourcesRef.current.clear();
        jobsRef.current.clear();
        progressMapRef.current = {};
        pgdMapRef.current = {};
        await Promise.all(running.map(async (id) => {
            try { await fetch(`${BACKEND_URL}/api/cancel/${id}`, { method: 'POST' }); } catch { /* ignore */ }
        }));
        setActiveQueueIds([]);
        setIsProcessing(false);
        setProgress(0);
        setPgdProgress(0);
        setPgdActive(false);
        setSidePhase('');
        setSideProgress(0);
        setProgressEtaMs(null);
        setPgdEtaMs(null);
    };

    const startProcessing = async () => {
        if (processingRef.current) return;
        if (filesRef.current.length === 0) return;
        const look = lookRef.current || currentLook();
        const presetName = runPresetNameRef.current;
        const presetMissing = runPresetMissingRef.current;
        runPresetNameRef.current = '';
        runPresetMissingRef.current = false;

        const runEpoch = uniqueEpochRef.current;
        cancelRef.current = false;
        pauseRef.current = false;
        processingRef.current = true;
        claimedRef.current = new Set();
        queueTotalRef.current = filesRef.current.length;
        setIsPaused(false);
        setIsProcessing(true);
        setProgress(0);
        setPgdProgress(0);
        setPgdActive(false);
        setSidePhase('');
        setSideProgress(0);
        setProgressEtaMs(null);
        setPgdEtaMs(null);
        setStats(null);
        setDownloadUrl(null);
        clearLogChannel('unique');
        addLog(presetName
            ? `[SYS] Preset “${presetName}”. Preset này áp cho cả hàng đang chờ.`
            : presetMissing
                ? '[SYS] Preset: không thấy preset đã chọn. Dùng công tắc đang mở trên bảng Unique.'
                : '[SYS] Preset: không chọn. Dùng công tắc đang mở trên bảng Unique.');
        progressMapRef.current = {};
        pgdMapRef.current = {};
        setQueueTotal(queueTotalRef.current);
        const conc = parallelJobs === 1 ? 1 : 2;
        addLog(`[SYS] Queue started: ${queueTotalRef.current} video(s), ${conc} at a time. Unique per clip unchanged. Có thể thả thêm video trong lúc chạy.`);
        if ((look.enablePgd || look.enableSmooth) && conc > 1) {
            addLog('[SYS] Làm mịn và PGD xếp hàng 1 video trên GPU. Phần Unique vẫn chạy song song.');
        }

        let finished = 0;
        let activeWorkers = 0;
        const takeNext = () => {
            const clip = filesRef.current.find((c) => !claimedRef.current.has(c.id));
            if (!clip) return null;
            claimedRef.current.add(clip.id);
            return clip;
        };

        const runOne = async (clip: QueueClip) => {
            const ordinal = finished + activeWorkers;
            setActiveQueueIds((prev) => prev.includes(clip.id) ? prev : [...prev, clip.id]);
            addLog(`[SYS] ---- ${ordinal}/${queueTotalRef.current}: ${clip.name} ----`);
            try {
                const result = await processOneFile(clip, look, presetName);
                if (cancelRef.current || uniqueEpochRef.current !== runEpoch) return;
                setQueueResults((prev) => [...prev, result]);
                setStats(result.stats || null);
                setDownloadUrl(result.downloadUrl);
                void fetch(`${BACKEND_URL}/api/unique/held/${result.jobId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: result.name }),
                }).catch(() => {});
                addLog(`[SYS] SUCCESS: ${result.name} complete.`);
                setSelectedIds((prev) => prev.includes(result.jobId) ? prev : [...prev, result.jobId]);
                await releaseYoutubeImport(clip, 'done', 'unique');
                setFiles((prev) => {
                    const next = prev.filter((c) => c.id !== clip.id);
                    filesRef.current = next;
                    return next;
                });
                addLog(`[SYS] Removed ${result.name} from waiting queue.`);
            } catch (clipErr: unknown) {
                if (cancelRef.current || uniqueEpochRef.current !== runEpoch) return;
                const message = clipErr instanceof Error ? clipErr.message : String(clipErr);
                addLog(`[SYS] ERROR: ${clip.name} — ${message}`);
                addLog('[SYS] Keeping this clip in queue and continuing.');
                setQueueResults((prev) => [...prev, {
                    name: safeFileName(clip.name),
                    originalName: clip.originalName,
                    jobId: `failed-${clip.id}`,
                    downloadUrl: '',
                    failed: true,
                    error: message,
                    handoffNote: clip.handoffFrom === 'youtube'
                        ? (clip.handoffPreset ? `Từ YouTube. Preset “${clip.handoffPreset}”.` : 'Từ YouTube. Không chọn preset bên YouTube.')
                        : '',
                }]);
            } finally {
                setActiveQueueIds((prev) => prev.filter((id) => id !== clip.id));
                finished += 1;
                setQueueIndex(finished);
                delete progressMapRef.current[clip.id];
            }
        };

        const waitWhilePaused = async () => {
            while (pauseRef.current && !cancelRef.current) {
                await new Promise((resolvePause) => setTimeout(resolvePause, 200));
            }
        };

        const worker = async () => {
            while (uniqueEpochRef.current === runEpoch && !cancelRef.current) {
                await waitWhilePaused();
                if (cancelRef.current || uniqueEpochRef.current !== runEpoch) return;
                const clip = takeNext();
                if (!clip) {
                    if (activeWorkers === 0) return;
                    await new Promise((resolveIdle) => setTimeout(resolveIdle, 200));
                    continue;
                }
                activeWorkers += 1;
                try {
                    await runOne(clip);
                } finally {
                    activeWorkers -= 1;
                }
            }
        };

        try {
            await Promise.all(Array.from({ length: conc }, () => worker()));
            if (!cancelRef.current) addLog('[SYS] Queue finished.');
            else addLog('[SYS] Queue stopped by user.');
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            if (cancelRef.current || /cancel/i.test(message)) addLog('[SYS] Queue stopped by user.');
            else addLog(`[SYS] ERROR: ${message}`);
        } finally {
            if (uniqueEpochRef.current !== runEpoch) return;
            jobsRef.current.clear();
            sourcesRef.current.clear();
            progressMapRef.current = {};
            setActiveQueueIds([]);
            setIsProcessing(false);
            setIsPaused(false);
            pauseRef.current = false;
            processingRef.current = false;
            claimedRef.current = new Set();
        }
    };

    startUniqueRef.current = () => { void startProcessing(); };
    startEditRef.current = () => { void startEdit(); };
    startReframeRef.current = () => { void startReframe(); };

    const beginHandoff = (presetId: string) => {
        setAppTab('unique');
        if (processingRef.current) {
            addLog('[SYS] Unique đang chạy — clip xếp sau, giữ cài đặt của lượt này.');
            return;
        }
        const preset = namedPresetsRef.current.find((item) => item.id === presetId);
        if (!preset) {
            runPresetNameRef.current = '';
            runPresetMissingRef.current = true;
            void startProcessing();
            return;
        }
        applyLook(preset.settings);
        runPresetNameRef.current = preset.name;
        runPresetMissingRef.current = false;
        void startProcessing();
    };
    handoffRef.current = beginHandoff;

    const renderHandoffSelect = () => (
        <select
            value={namedPresets.some((item) => item.id === handoffPresetId) ? handoffPresetId : ''}
            onChange={(e) => chooseHandoffPreset(e.target.value)}
            className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded-lg px-2 py-2 outline-none max-w-full"
        >
            <option value="">Chọn preset Unique</option>
            {namedPresets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
    );

    return (
        <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6 relative">
            {/* Header */}
            <header className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-gray-800 pb-6 gap-4">
                <div className="flex items-center gap-4">
                    <div className="p-3 bg-purple-500/10 rounded-xl border border-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.15)]">
                        <Sparkles className="w-8 h-8 text-purple-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-gray-100 to-gray-400">
                            GhostForge AI
                        </h1>
                        <p className="text-sm text-purple-400/80 font-mono mt-1">Unique spoof · Edit cut · AI Reframe</p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-xs font-mono px-4 py-2 rounded-full border shadow-inner transition-colors text-green-400 bg-green-900/20 border-green-800">
                        <Server className="w-4 h-4" />
                        BACKEND: READY
                    </div>
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                <div className="flex p-1 bg-gray-900/80 border border-gray-800 rounded-xl">
                    <button
                        type="button"
                        onClick={() => setAppTab('unique')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                            appTab === 'unique'
                                ? 'bg-purple-600 text-white shadow-[0_0_12px_rgba(168,85,247,0.35)]'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        <Sparkles className="w-4 h-4" />
                        Unique
                        {files.length > 0 && (
                            <span className="text-[10px] font-mono bg-black/30 px-1.5 py-0.5 rounded-full">{files.length}</span>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setAppTab('edit')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                            appTab === 'edit'
                                ? 'bg-cyan-600 text-white shadow-[0_0_12px_rgba(8,145,178,0.35)]'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        <Scissors className="w-4 h-4" />
                        Edit
                        {editFiles.length > 0 && (
                            <span className="text-[10px] font-mono bg-black/30 px-1.5 py-0.5 rounded-full">{editFiles.length}</span>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setAppTab('reframe')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                            appTab === 'reframe'
                                ? 'bg-pink-600 text-white shadow-[0_0_12px_rgba(219,39,119,0.35)]'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        <Focus className="w-4 h-4" />
                        Reframe
                        {reframeFiles.length > 0 && (
                            <span className="text-[10px] font-mono bg-black/30 px-1.5 py-0.5 rounded-full">{reframeFiles.length}</span>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setAppTab('youtube')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                            appTab === 'youtube'
                                ? 'bg-red-600 text-white shadow-[0_0_12px_rgba(220,38,38,0.35)]'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        <Download className="w-4 h-4" />
                        YouTube
                    </button>
                    <button
                        type="button"
                        onClick={() => setAppTab('trends')}
                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                            appTab === 'trends'
                                ? 'bg-orange-600 text-white shadow-[0_0_12px_rgba(234,88,12,0.35)]'
                                : 'text-gray-400 hover:text-gray-200'
                        }`}
                    >
                        <TrendingUp className="w-4 h-4" />
                        Xu hướng
                    </button>
                </div>
                <p className="text-[11px] text-gray-500 font-mono">
                    {appTab === 'unique'
                        ? 'Spoof fingerprints. Queue stays when you switch tabs.'
                        : appTab === 'edit'
                            ? 'Drop video → viết prompt → Gemini xem rồi cắt. Gửi clip sang Unique sau.'
                            : appTab === 'reframe'
                                ? 'Gemini xem + nghe → theo speaker/hành động → crop 9:16 (không Unique/PGD).'
                                : appTab === 'youtube'
                                    ? 'Dán link vào hàng chờ. Từng video tải một, file gốc vào thư mục đã chọn.'
                                    : 'Tìm hashtag và từ khoá đang hot trên TikTok theo quốc gia, số ngày gần nhất và view tối thiểu.'}
                </p>
            </div>

            {showUpdateBar && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2">
                <p className="text-sm text-amber-200 font-semibold">Cập nhật local (Save-to fix) — khung chat không gửi được file .tsx</p>
                <p className="text-[11px] text-amber-200/80">Bấm Show → Ctrl+A → Ctrl+C → dán đè file trên máy. Rồi tắt cmd, chạy lại start.bat.</p>
                <div className="flex flex-wrap gap-2">
                    {[
                        { url: '/gf-update/ghostforge-server.js', label: 'ghostforge-server.js', dest: 'cạnh start.bat' },
                        { url: '/gf-update/ghostforge-app.txt', label: 'src/ghostforge-app.tsx', dest: 'vào thư mục src/' },
                    ].map((f) => (
                        <button
                            key={f.url}
                            type="button"
                            onClick={async () => {
                                try {
                                    const text = await fetch(f.url).then((r) => {
                                        if (!r.ok) throw new Error(String(r.status));
                                        return r.text();
                                    });
                                    setUpdateView({ label: `${f.label}  →  ${f.dest}`, text });
                                    try {
                                        await navigator.clipboard.writeText(text);
                                        setUpdateCopyMsg(`Đã copy ${f.label}. Dán đè file ${f.dest}`);
                                    } catch {
                                        setUpdateCopyMsg(`Clipboard bị chặn — bôi đen ô dưới (Ctrl+A) rồi copy (Ctrl+C)`);
                                    }
                                } catch (err: unknown) {
                                    setUpdateCopyMsg(`Không tải được ${f.label}: ${err instanceof Error ? err.message : String(err)}`);
                                }
                            }}
                            className="px-3 py-2 rounded-lg bg-amber-500 text-black text-xs font-bold hover:bg-amber-400"
                        >
                            Show + copy {f.label}
                        </button>
                    ))}
                    {updateView && (
                        <button
                            type="button"
                            onClick={() => { setUpdateView(null); setUpdateCopyMsg(''); }}
                            className="px-3 py-2 rounded-lg border border-amber-500/40 text-amber-200 text-xs"
                        >
                            Đóng ô copy
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            setShowUpdateBar(false);
                            try { localStorage.setItem('gf_hide_update_bar', '1'); } catch { /* ignore */ }
                        }}
                        className="px-3 py-2 rounded-lg border border-amber-500/40 text-amber-200 text-xs"
                    >
                        Ẩn thanh này
                    </button>
                </div>
                {updateCopyMsg && <p className="text-xs text-green-300 font-mono">{updateCopyMsg}</p>}
                {updateView && (
                    <div>
                        <p className="text-[11px] text-amber-200 mb-1 font-mono">{updateView.label} · {updateView.text.length} chars</p>
                        <textarea
                            readOnly
                            value={updateView.text}
                            onFocus={(e) => e.currentTarget.select()}
                            className="w-full h-40 bg-black/70 text-[10px] text-gray-200 font-mono p-2 rounded-lg border border-amber-500/30"
                        />
                    </div>
                )}
            </div>
            )}

            {appTab === 'unique' && queueResults.some((r) => r.recovered && !r.saved && !r.failed) && (
                <div className="rounded-xl border border-green-500/40 bg-green-500/10 p-4">
                    <p className="text-sm text-green-200 font-semibold">
                        Đã giữ {queueResults.filter((r) => r.recovered && !r.saved && !r.failed).length} video xử lý xong nhưng chưa lưu
                    </p>
                    <p className="text-[11px] text-green-200/80 mt-1">
                        App tắt đột ngột hoặc mất điện vẫn còn các video này trong Completed. Bấm Save để chép ra thư mục. Xóa dòng thì bỏ bản giữ.
                    </p>
                </div>
            )}

            {appTab === 'unique' && unfinishedNotice.length > 0 && files.length === 0 && (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
                    <p className="text-sm text-amber-200 font-semibold">Queue bị gián đoạn — {unfinishedNotice.length} clip chưa xong</p>
                    <p className="text-[11px] text-amber-200/80 mt-1">Drop lại các file này rồi bấm Start. File đang chờ không giữ được sau khi tắt app. Video đã xử lý xong mà chưa Save thì vẫn còn trong Completed.</p>
                    <p className="text-[11px] font-mono text-amber-100 mt-2">{unfinishedNotice.join(' · ')}</p>
                    <button
                        type="button"
                        onClick={() => {
                            setUnfinishedNotice([]);
                            try { sessionStorage.removeItem('gf_unfinished'); } catch { /* ignore */ }
                        }}
                        className="mt-2 text-[11px] text-amber-300 underline"
                    >
                        Ẩn
                    </button>
                </div>
            )}

            {appTab === 'unique' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
                {/* Left Column: Input & Controls */}
                <div className="xl:col-span-4 space-y-6">
                    {/* Upload Zone */}
                    <div className="bg-gray-900/50 border border-gray-800 rounded-2xl p-1 backdrop-blur-sm">
                        <div
                            onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
                            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                            onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
                            onDrop={onDrop}
                            className={`
                                flex flex-col items-center justify-center w-full min-h-36
                                border-2 border-dashed rounded-xl
                                transition-all duration-300
                                ${isDragging ? 'border-purple-400 bg-purple-500/15' : files.length ? 'border-purple-500/50 bg-purple-500/5' : 'border-gray-700 hover:border-purple-500/30 hover:bg-gray-800/50'}
                            `}
                        >
                            <label className="flex flex-col items-center justify-center w-full cursor-pointer py-6 px-4 text-center">
                                <Upload className="w-10 h-10 text-purple-400 mb-3" />
                                <p className="mb-1 text-sm text-gray-300">
                                    <span className="font-semibold">Drop videos here</span> or click to browse
                                </p>
                                <p className="text-xs text-gray-600 font-mono">Browse again keeps the queue · thêm được khi đang chạy · MP4, WebM, MOV</p>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    className="hidden"
                                    accept="video/*"
                                    multiple
                                    onChange={handleFileChange}
                                />
                            </label>
                        </div>
                        {files.length > 0 && (
                            <ul className="mt-1 divide-y divide-gray-800/80 max-h-56 overflow-y-auto">
                                {files.map((clip, i) => (
                                    <li
                                        key={clip.id}
                                        draggable={!isProcessing && renamingQueueId !== clip.id}
                                        onDragStart={(e) => {
                                            e.stopPropagation();
                                            if (renamingQueueId === clip.id) {
                                                e.preventDefault();
                                                return;
                                            }
                                            dragFromRef.current = i;
                                            e.dataTransfer.effectAllowed = 'move';
                                        }}
                                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const from = dragFromRef.current;
                                            if (from == null) return;
                                            moveFile(from, i);
                                            dragFromRef.current = null;
                                        }}
                                        className={`flex items-center gap-2 px-3 py-2 text-sm ${isProcessing ? '' : 'cursor-grab active:cursor-grabbing'} ${isProcessing && activeQueueIds.includes(clip.id) ? 'bg-purple-500/10' : ''}`}
                                    >
                                        <GripVertical className="w-4 h-4 text-gray-600 shrink-0" />
                                        <span className="text-[10px] font-mono text-purple-400 w-5 shrink-0">#{i + 1}</span>
                                        <FileVideo className="w-4 h-4 text-purple-400 shrink-0" />
                                        {renamingQueueId === clip.id ? (
                                            <input
                                                autoFocus
                                                defaultValue={clip.name}
                                                className="flex-1 min-w-0 bg-gray-950 border border-purple-500 rounded px-2 py-1 text-sm text-gray-100 outline-none"
                                                onClick={(e) => e.stopPropagation()}
                                                onMouseDown={(e) => e.stopPropagation()}
                                                onBlur={(e) => {
                                                    renameQueued(clip.id, e.target.value);
                                                    setRenamingQueueId(null);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        renameQueued(clip.id, (e.target as HTMLInputElement).value);
                                                        setRenamingQueueId(null);
                                                    }
                                                    if (e.key === 'Escape') setRenamingQueueId(null);
                                                }}
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                className="text-gray-200 flex-1 text-left min-w-0"
                                                title={`${clip.name}${clip.name !== clip.originalName ? ` · file: ${clip.originalName}` : ''} — click to rename`}
                                                onClick={() => setRenamingQueueId(clip.id)}
                                            >
                                                <span className="block truncate">{clip.name}</span>
                                                {clip.name !== clip.originalName && (
                                                    <span className="block truncate text-[10px] font-mono text-gray-500">was {clip.originalName}</span>
                                                )}
                                                {clip.handoffFrom === 'youtube' && (
                                                    <span className="block truncate text-[10px] text-cyan-300/90">
                                                        {clip.handoffPreset ? `Từ YouTube. Preset “${clip.handoffPreset}”.` : 'Từ YouTube. Không chọn preset bên YouTube.'}
                                                    </span>
                                                )}
                                            </button>
                                        )}
                                        <span className="text-[10px] font-mono text-gray-500 shrink-0">{formatBytes(clip.fileSize || clip.file.size)}</span>
                                        <button
                                            type="button"
                                            onClick={() => setRenamingQueueId(clip.id)}
                                            className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-purple-300"
                                            title="Rename — completed file uses this name"
                                        >
                                            <Pencil className="w-4 h-4" />
                                        </button>
                                        <button type="button" onClick={() => moveFile(i, i - 1)} disabled={isProcessing || i === 0} className="text-gray-500 hover:text-gray-200 disabled:opacity-20 px-1">↑</button>
                                        <button type="button" onClick={() => moveFile(i, i + 1)} disabled={isProcessing || i === files.length - 1} className="text-gray-500 hover:text-gray-200 disabled:opacity-20 px-1">↓</button>
                                        <button
                                            type="button"
                                            onClick={() => removeFile(i)}
                                            disabled={isProcessing && activeQueueIds.includes(clip.id)}
                                            className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400 disabled:opacity-40"
                                            title={isProcessing && activeQueueIds.includes(clip.id) ? 'Đang xử lý' : 'Remove from queue'}
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {files.length > 0 && !isProcessing && (
                            <p className="px-3 py-2 text-[10px] text-gray-500">
                                Pencil or click the name to rename. Save uses that name.
                                {files.length > 1 ? ' Drag grip or ↑↓ — #1 runs first.' : ''}
                            </p>
                        )}
                        {isProcessing && (
                            <p className="px-3 py-2 text-[10px] text-amber-200/90">
                                Đang chạy — thả hoặc chọn thêm video. Clip mới xếp sau clip hiện tại. Cài đặt của lượt này giữ nguyên.
                            </p>
                        )}
                    </div>

                    {/* Advanced Settings Panel */}
                    <div className={`bg-gray-900/80 border border-gray-800 rounded-2xl p-5 space-y-5 shadow-lg ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}>
                        <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
                            <Settings2 className="w-5 h-5 text-gray-400" />
                            <h3 className="font-semibold text-gray-200">Semantic Pipeline Config</h3>
                        </div>

                        {pgdOnlyActive && (
                            <div className="rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-3 py-2 text-[11px] text-fuchsia-200 leading-tight">
                                <b>PGD-ONLY đang bật</b> → lượt chạy này bỏ Unique. Các mục bên dưới vẫn hiện để lưu vào preset. Làm mịn và phụ đề vẫn theo công tắc của chúng.
                            </div>
                        )}

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Sparkles className="w-3 h-3" />
                                PRESET ĐÃ LƯU
                            </label>
                            {namedPresets.length === 0 ? (
                                <p className="text-[10px] text-gray-500 leading-tight">Chưa có preset. Chỉnh các mục bên dưới, đặt tên, rồi bấm Tạo preset.</p>
                            ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                    <select
                                        aria-label="Preset đã lưu"
                                        value={namedPresets.some((item) => item.id === pickedPresetId) ? pickedPresetId : ''}
                                        onChange={(e) => chooseSavedPreset(e.target.value)}
                                        className="min-w-0 flex-1 bg-gray-950 border border-gray-700 text-gray-100 text-sm rounded-lg px-2.5 py-1.5 outline-none"
                                    >
                                        <option value="">Chọn preset</option>
                                        {namedPresets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                                    </select>
                                    <button
                                        type="button"
                                        disabled={!namedPresets.some((item) => item.id === pickedPresetId)}
                                        onClick={() => {
                                            const item = namedPresets.find((row) => row.id === pickedPresetId);
                                            if (!item) return;
                                            applyLook(item.settings);
                                            setPresetName(item.name);
                                            setPresetError('');
                                            setEditingPresetId(item.id);
                                            addLog(`[SYS] Đang sửa preset “${item.name}”. Bấm Lưu lại khi xong.`);
                                        }}
                                        className="text-[11px] font-semibold px-2 py-1.5 rounded-lg border border-purple-500/50 text-purple-200 hover:bg-purple-500/10 disabled:opacity-40 disabled:hover:bg-transparent"
                                    >
                                        Sửa
                                    </button>
                                    <button type="button" disabled={!namedPresets.some((item) => item.id === pickedPresetId)} onClick={() => { if (pickedPresetId) setViewPresetId(pickedPresetId); }} className="text-[11px] font-semibold px-2 py-1.5 rounded-lg border border-purple-500/50 text-purple-200 hover:bg-purple-500/10 disabled:opacity-40 disabled:hover:bg-transparent">Xem</button>
                                    <button type="button" disabled={!namedPresets.some((item) => item.id === pickedPresetId)} onClick={() => { const id = pickedPresetId; if (!id) return; saveNamedPresets(namedPresets.filter((row) => row.id !== id)); setPickedPresetId(''); if (viewPresetId === id) setViewPresetId(''); if (editingPresetId === id) { setEditingPresetId(''); setPresetName(''); setPresetError(''); } if (handoffPresetId === id) chooseHandoffPreset(''); }} className="text-[11px] px-2 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:text-red-300 hover:border-red-500/50 disabled:opacity-40">Xóa</button>
                                </div>
                            )}
                        </div>

                        {/* Platform Mode */}
                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Share2 className="w-3 h-3" />
                                PLATFORM-ADAPTIVE MODE
                            </label>
                            <select 
                                value={platformMode}
                                onChange={(e) => setPlatformMode(e.target.value as PlatformMode)}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none"
                            >
                                <option value="auto">Auto (any size, full-frame unique)</option>
                                <option value="tiktok">TikTok (max unique, captions readable)</option>
                                <option value="ig_reels">IG Reels (warm + strong unique)</option>
                                <option value="yt_shorts">YT Shorts (contrast + strong unique)</option>
                                <option value="facebook">Facebook (balanced unique)</option>
                                <option value="generic">Generic (strong unique)</option>
                            </select>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Sparkles className="w-3 h-3" />
                                ĐỘ KHÁC BIỆT NGUỒN
                            </label>
                            <select
                                value={uniqueStrength}
                                onChange={(e) => {
                                    const picked = e.target.value === 'light' ? 'light'
                                        : e.target.value === 'standard' ? 'standard'
                                            : e.target.value === 'extreme' ? 'extreme' : 'strong';
                                    setUniqueStrength(picked);
                                    try { localStorage.setItem('gf_unique_strength', picked); } catch { /* ignore */ }
                                }}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none"
                            >
                                <option value="light">Nhẹ — gần nguồn nhất (zoom ×0.55)</option>
                                <option value="standard">Chuẩn — đúng như trước 24/09 (zoom ×1)</option>
                                <option value="strong">Mạnh — khác nguồn nhiều (zoom ×1.7 · màu ×1.8 · nhịp ×2)</option>
                                <option value="extreme">Cực mạnh — khác tối đa (zoom ×2.3 · màu ×2.4 · nhịp ×2.8)</option>
                            </select>
                            <p className="text-[10px] text-gray-500 leading-tight">Càng mạnh càng zoom sát viền: Mạnh giữ ~78–90% khung, Cực mạnh ~73–86%. Tempo vẫn khoá chung video + audio nên giọng không lệch.</p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <RotateCw className="w-3 h-3" />
                                KIỂU XOAY KHUNG
                            </label>
                            <select
                                value={rotateMode}
                                onChange={(e) => {
                                    setRotateMode(e.target.value);
                                    try { localStorage.setItem('gf_rotate_mode', e.target.value); } catch { /* ignore */ }
                                }}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none"
                            >
                                <option value="off">Tắt — không xoay (khuyến nghị cho clip CÓ viền)</option>
                                <option value="tilt0.5">Nghiêng tĩnh 0.5° — rất nhẹ (+8% lệch)</option>
                                <option value="tilt1">Nghiêng tĩnh 1° — nhẹ (+14%)</option>
                                <option value="tilt2">Nghiêng tĩnh 2° — vừa (+19%), caption nghiêng rõ</option>
                                <option value="tilt3">Nghiêng tĩnh 3° — mạnh (+23%)</option>
                                <option value="wob1">Đung đưa ±1° — hình chạy chậm, nhẹ mắt</option>
                                <option value="wob2">Đung đưa ±2° — mắt thấy rõ, caption chạy</option>
                                <option value="wob3">Đung đưa ±3° — mạnh, dễ chóng mặt</option>
                            </select>
                            <p className="text-[10px] text-gray-500 leading-tight">
                                <b>Nghiêng tĩnh</b> = nghiêng một lần rồi đứng im (mắt quen nhanh, chỉ thấy mép bị xéo).
                                {' '}<b>Đung đưa</b> = góc đổi liên tục 1,5s/nhịp nên hình đung đưa và caption chạy — mắt thấy ngay.
                                Cả hai đều kèm zoom bù góc (~1.03–1.09×) và làm caption nghiêng/nhòe nhẹ.
                            </p>
                            {rotateMode !== 'off' && (
                                <p className="text-[10px] text-amber-400/90 leading-tight">
                                    ⚠ Clip <b>có viền mờ/letterbox</b> (output tab Edit) mà chọn xoay thì mép viền bị xéo, trông như khung lỗi → nên để <b>Tắt</b> cho những clip đó. Kiểu xoay bạn chọn sẽ <b>luôn được áp dụng</b> (không còn bị chặn tự động), log ghi <b>Rotate: …</b> hoặc <b>Wobble: …</b>.
                                </p>
                            )}
                        </div>

                        {/* Toggles */}
                        <div className="border-t border-gray-800 pt-3 text-[10px] font-mono text-gray-500 tracking-wide">LỚP LÀM KHÁC BIỆT</div>
                        <div className="space-y-4 pt-2">
                            {/* Lớp nhiễu nhẹ - NOT the CLIP-PGD attack; PGD has its own switch below. */}
                            <div className="flex items-center justify-between group">
                                <div className="pr-4">
                                    <h4 className={`text-sm font-medium flex items-center gap-2 ${enableAdversarial ? 'text-purple-400' : 'text-gray-400'}`}>
                                        <Cpu className="w-4 h-4" />
                                        Lớp nhiễu nhẹ (không phải PGD)
                                    </h4>
                                    <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">Xê dịch màu ±1, hue dao động, hạt nhiều hơn, hình học nhích. Bật kèm PGD thì thêm sọc geq nhìn thấy được và render chậm 3–5×.</p>
                                </div>
                                <button onClick={() => setEnableAdversarial(!enableAdversarial)} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enableAdversarial ? 'bg-purple-500' : 'bg-gray-700'}`}>
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enableAdversarial ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>

                            <div className="space-y-1.5 pl-6">
                                <div className="flex items-center justify-between">
                                    <label className="text-[10px] font-mono text-gray-500">LÀM MỀM VIỀN MỜ (chỉ cho nguồn có viền mờ TĨNH — nhập tay, không tự dò)</label>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = !featherEnabled;
                                            setFeatherEnabled(next);
                                            try { localStorage.setItem('gf_feather_on', next ? '1' : '0'); } catch { /* ignore */ }
                                        }}
                                        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${featherEnabled ? 'bg-teal-500' : 'bg-gray-700'}`}
                                    >
                                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${featherEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                                {featherEnabled && (
                                    <div className="space-y-1.5">
                                        <label className="text-[10px] font-mono text-gray-500">VIỀN MỜ TRÊN / DƯỚI (% chiều cao, để 0 = tự dò)</label>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number" min={0} max={45} step={0.5} value={featherTop}
                                                onChange={(e) => {
                                                    const v = Math.max(0, Math.min(45, Number(e.target.value) || 0));
                                                    setFeatherTop(v);
                                                    try { localStorage.setItem('gf_feather_top', String(v)); } catch { /* ignore */ }
                                                }}
                                                className="w-20 bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded-lg p-2 outline-none focus:border-purple-500"
                                            />
                                            <span className="text-xs text-gray-500">trên</span>
                                            <input
                                                type="number" min={0} max={45} step={0.5} value={featherBottom}
                                                onChange={(e) => {
                                                    const v = Math.max(0, Math.min(45, Number(e.target.value) || 0));
                                                    setFeatherBottom(v);
                                                    try { localStorage.setItem('gf_feather_bottom', String(v)); } catch { /* ignore */ }
                                                }}
                                                className="w-20 bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded-lg p-2 outline-none focus:border-purple-500"
                                            />
                                            <span className="text-xs text-gray-500">dưới</span>
                                        </div>
                                        <p className="text-[10px] text-gray-500 leading-tight">Đo trên khung: viền chiếm bao nhiêu % chiều cao (ví dụ trên 11% + dưới 22%). Chỉ dùng cho nguồn có viền cố định — KHÔNG áp dụng cho output của tab Edit, ở đó cửa sổ hình đổi theo người nói.</p>
                                    </div>
                                )}
                            </div>

                            {/* Stronger static audio chain - no pitch, no tempo change. */}
                            <div className="flex items-center justify-between group">
                                <div className="pr-4">
                                    <h4 className={`text-sm font-medium flex items-center gap-2 ${enableAudioAttack ? 'text-amber-400' : 'text-gray-400'}`}>
                                        <VolumeX className="w-4 h-4" />
                                        EQ tiếng mạnh hơn
                                    </h4>
                                    <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">EQ tĩnh rộng hơn (±5,5 dB) + hiss 10–15 kHz. Không đổi cao độ, không đổi tốc độ.</p>
                                </div>
                                <button onClick={() => setEnableAudioAttack(!enableAudioAttack)} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enableAudioAttack ? 'bg-amber-500' : 'bg-gray-700'}`}>
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enableAudioAttack ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>

                            {/* Rehash-style TikTok canvas */}
                            <div className="flex items-center justify-between group">
                                <div className="pr-4">
                                    <h4 className={`text-sm font-medium flex items-center gap-2 ${enableTikTokCanvas ? 'text-pink-400' : 'text-gray-400'}`}>
                                        <Smartphone className="w-4 h-4" />
                                        TikTok 1080×1920 (Rehash)
                                    </h4>
                                    <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">Fit toàn bộ nội dung vào 1080×1920, viền đen trên/dưới (720×960 → pad đen). Tắt = giữ đúng size nguồn.</p>
                                </div>
                                <button type="button" onClick={() => setEnableTikTokCanvas(!enableTikTokCanvas)} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enableTikTokCanvas ? 'bg-pink-500' : 'bg-gray-700'}`}>
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enableTikTokCanvas ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>

                            <div className="space-y-2">
                            <div className="flex items-center justify-between group">
                                <div className="pr-4">
                                    <h4 className={`text-sm font-medium flex items-center gap-2 ${enableSmooth ? 'text-cyan-300' : 'text-gray-400'}`}>
                                        <Sparkles className="w-4 h-4" />
                                        Làm mịn (trước Unique)
                                    </h4>
                                    <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">Nhanh: video đã đủ 1080 giữ nguyên kích thước, bộ lọc nhẹ. Clip nhỏ hơn 1080 vẫn dùng model. AI: model trên mọi kích thước, chậm, mặt có thể bị vẽ lại. Tắt = bỏ qua.</p>
                                </div>
                                <button type="button" onClick={() => setEnableSmooth(!enableSmooth)} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enableSmooth ? 'bg-cyan-500' : 'bg-gray-700'}`}>
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enableSmooth ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            {enableSmooth && (
                                <select
                                    aria-label="Mức làm mịn"
                                    value={smoothMode}
                                    onChange={(e) => setSmoothMode(e.target.value === 'ai' ? 'ai' : 'fast')}
                                    className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg px-2.5 py-2 outline-none"
                                >
                                    <option value="fast">Nhanh — video đủ 1080 giữ nguyên kích thước</option>
                                    <option value="ai">AI — model chậm, mặt có thể bị vẽ lại</option>
                                </select>
                            )}
                            <div className="flex items-center justify-between group">
                                <div className="pr-4">
                                    <h4 className={`text-sm font-medium flex items-center gap-2 ${enableCaptions ? 'text-amber-300' : 'text-gray-400'}`}>
                                        <Activity className="w-4 h-4" />
                                        Phụ đề từng từ (sau Unique và PGD)
                                    </h4>
                                    <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">Một từ, chữ trắng đậm, viền đen. Dưới cách mép dưới 10% chiều cao khung. Giữa là giữa khung. Nghe local lấy nhịp và ngôn ngữ. Google chỉ sửa chính tả khi cùng một nhịp. Tắt = bỏ qua.</p>
                                </div>
                                <button type="button" onClick={() => setEnableCaptions(!enableCaptions)} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enableCaptions ? 'bg-amber-500' : 'bg-gray-700'}`}>
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enableCaptions ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            {enableCaptions && (
                                <select
                                    aria-label="Vị trí phụ đề"
                                    value={captionPlace}
                                    onChange={(e) => setCaptionPlace(e.target.value === 'bottom' ? 'bottom' : 'middle')}
                                    className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg px-2.5 py-2 outline-none"
                                >
                                    <option value="middle">Giữa</option>
                                    <option value="bottom">Dưới — cách mép dưới 10%</option>
                                </select>
                            )}
                            <div className="flex items-center justify-between group">
                                <div className="pr-4">
                                    <h4 className={`text-sm font-medium flex items-center gap-2 ${enablePgd ? 'text-violet-400' : 'text-gray-400'}`}>
                                        <Sparkles className="w-4 h-4" />
                                        CLIP PGD (slow, GPU)
                                    </h4>
                                    <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">Sau Unique: CLIP PGD + EOT (nén JPEG + resize như TikTok). Chậm hơn bản cũ ~2–3×. Tắt = Unique như cũ.</p>
                                </div>
                                {/* The switch flips first and the Python/CUDA check runs behind it:
                                    awaiting /api/pgd-status (which imports torch + open_clip) made the
                                    button feel stuck for ~2-3 s. The answer is cached for the session,
                                    and a failed check turns the switch back off with a log line. */}
                                <button type="button" onClick={async () => {
                                    if (enablePgd) { setEnablePgd(false); setEnablePgdOnly(false); return; }
                                    setEnablePgd(true);
                                    if (pgdStatusRef.current === 'ready') return;
                                    try {
                                        const r = await fetch(BACKEND_URL + '/api/pgd-status');
                                        const status = await r.json();
                                        if (!status.ready) {
                                            pgdStatusRef.current = 'missing';
                                            setEnablePgd(false);
                                            setEnablePgdOnly(false);
                                            addLog('[PGD] ' + status.message);
                                            return;
                                        }
                                        pgdStatusRef.current = 'ready';
                                    } catch {
                                        pgdStatusRef.current = 'unknown';
                                        setEnablePgd(false);
                                        setEnablePgdOnly(false);
                                        addLog('[PGD] Không kiểm tra được môi trường Python. Kiểm tra backend.');
                                    }
                                }} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${enablePgd ? 'bg-violet-500' : 'bg-gray-700'}`}>
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${enablePgd ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            {enablePgd && (
                                <div className="space-y-1.5 pl-6">
                                <div className="flex items-center gap-1.5">
                                    {([
                                        { id: 'light' as const, label: 'Nhẹ' },
                                        { id: 'medium' as const, label: 'Vừa' },
                                        { id: 'strong' as const, label: 'Mạnh' },
                                        { id: 'extreme' as const, label: 'Rất mạnh' },
                                        { id: 'visible' as const, label: 'Test thấy' },
                                    ]).map((lv) => (
                                        <button
                                            key={lv.id}
                                            type="button"
                                            onClick={() => setPgdLevel(lv.id)}
                                            className={`px-2.5 py-1 rounded-md text-[10px] font-semibold border ${pgdLevel === lv.id ? 'bg-violet-600/80 border-violet-400 text-white' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'}`}
                                        >
                                            {lv.label}
                                        </button>
                                    ))}
                                    <span className="text-[10px] text-gray-500 ml-1">
                                        {pgdLevel === 'light' ? 'CLIP ~0.96+' : pgdLevel === 'strong' ? 'CLIP ~0.92-0.95' : pgdLevel === 'extreme' ? 'CLIP ~0.85-0.92, mat kho thay' : pgdLevel === 'visible' ? 'PGD x12 — khong xem duoc, chi test' : 'CLIP ~0.94-0.97'}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <p className="text-[10px] text-gray-500 pr-3">PGD only — clip đã Unique rồi: <b>bỏ toàn bộ Unique</b>, chỉ chạy PGD. Các mục Unique vẫn hiện trên bảng để lưu vào preset.</p>
                                    <button type="button" onClick={() => { const n = !enablePgdOnly; setEnablePgdOnly(n); if (n) setEnablePgd(true); }} className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enablePgdOnly ? 'bg-fuchsia-500' : 'bg-gray-700'}`}>
                                        <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${enablePgdOnly ? 'translate-x-4' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                                </div>
                            )}
                            </div>

                        </div>

                        <div className="border-t border-gray-800 pt-3 text-[10px] font-mono text-gray-500 tracking-wide">HIỆU NĂNG (không đổi hình)</div>
                        <div className="space-y-2">
                            <div className="flex items-start justify-between gap-3">
                                <p className="text-[10px] text-gray-500 pr-3 leading-tight">
                                    Đo đầy đủ sau khi xong — bật thêm 2 dòng số: <b>CLIP nội dung</b> (cần GPU, phải chờ) và <b>nén thử 720</b> (nén lại cả clip).
                                    Tắt = video xong là xong ngay. Vẫn luôn đo dHash/pHash, cảnh báo vạch, audio và thời gian từng giai đoạn.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => setEnableFullMeasure(!enableFullMeasure)}
                                    title="Bật/tắt 2 phép đo nặng trong popup kết quả"
                                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${enableFullMeasure ? 'bg-sky-500' : 'bg-gray-700'}`}
                                >
                                    <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${enableFullMeasure ? 'translate-x-4' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Monitor className="w-3 h-3" />
                                ENCODER / GPU
                            </label>
                            <select
                                value={encoderMode}
                                onChange={(e) => setEncoderMode(e.target.value as typeof encoderMode)}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none"
                            >
                                <option value="auto">Auto (NVIDIA if available, else Intel, else CPU)</option>
                                <option value="nvidia" disabled={!encoderCaps.nvidia}>NVIDIA NVENC {encoderCaps.nvidia ? '(RTX usable)' : encoderCaps.nvidiaListed ? '— driver/FFmpeg cannot open' : '— not in this FFmpeg'}</option>
                                <option value="intel" disabled={!encoderCaps.intel}>Intel Quick Sync {encoderCaps.intel ? '' : '— not in this FFmpeg'}</option>
                                <option value="cpu">CPU libx264 (all cores)</option>
                            </select>
                            <p className="text-[10px] text-gray-500 leading-tight">Filters still run on CPU. NVENC/QSV only speed up the H.264 encode. Log line “Encoder:” shows what actually ran.</p>
                            {!encoderCaps.nvidia && (
                                <button
                                    type="button"
                                    onClick={() => loadEncoders(true)}
                                    className="text-[11px] font-mono text-purple-400 hover:text-purple-300 underline"
                                >
                                    Test NVIDIA again
                                </button>
                            )}
                        </div>

                        <div className="space-y-2 border-t border-gray-800 pt-3">
                            <label className="text-xs font-mono text-gray-400">{editingPresetId ? 'SỬA PRESET' : 'TẠO PRESET'}</label>
                            <div className="flex gap-2">
                                <input
                                    value={presetName}
                                    onChange={(e) => { setPresetName(e.target.value); setPresetError(''); }}
                                    placeholder="Tên preset"
                                    maxLength={40}
                                    className="flex-1 bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg px-3 py-2 outline-none"
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (editingPresetId) {
                                            const saved = updateNamedPreset(editingPresetId, presetName, currentLook(), namedPresets);
                                            if (!saved.ok || !saved.preset) { setPresetError(saved.error || 'Không lưu được.'); hidePresetNotice(); return; }
                                            const preset = saved.preset as NamedPreset;
                                            saveNamedPresets(namedPresets.map((row) => (row.id === preset.id ? preset : row)));
                                            setPickedPresetId(preset.id);
                                            setEditingPresetId('');
                                            setPresetName('');
                                            setPresetError('');
                                            addLog(`[SYS] Đã lưu lại preset “${preset.name}”.`);
                                            showPresetNotice(`Đã lưu lại preset “${preset.name}”.`);
                                            return;
                                        }
                                        const made = createNamedPreset(presetName, currentLook(), namedPresets);
                                        if (!made.ok || !made.preset) { setPresetError(made.error || 'Không lưu được.'); hidePresetNotice(); return; }
                                        const preset = made.preset as NamedPreset;
                                        saveNamedPresets([...namedPresets, preset]);
                                        setPickedPresetId(preset.id);
                                        setPresetName('');
                                        setPresetError('');
                                        addLog(`[SYS] Đã lưu preset “${preset.name}”.`);
                                        showPresetNotice(`Đã lưu preset “${preset.name}”.`);
                                    }}
                                    className="px-3 py-2 rounded-lg text-sm font-semibold bg-purple-600 hover:bg-purple-500 text-white"
                                >
                                    {editingPresetId ? 'Lưu lại' : 'Tạo preset'}
                                </button>
                                {editingPresetId && (
                                    <button
                                        type="button"
                                        onClick={() => { setEditingPresetId(''); setPresetName(''); setPresetError(''); }}
                                        className="px-3 py-2 rounded-lg text-sm font-semibold border border-gray-700 text-gray-300 hover:bg-gray-800"
                                    >
                                        Hủy
                                    </button>
                                )}
                            </div>
                            {presetError && <p className="text-[11px] text-red-300">{presetError}</p>}
                            <p className="text-[10px] text-gray-500 leading-tight">{editingPresetId ? 'Lưu lại ghi đè đúng preset đang sửa. Tên đã có thì giữ bản cũ và báo tạo tên khác. Hủy không ghi.' : 'Lưu đúng các công tắc đang bật: Làm mịn, Unique, PGD, Phụ đề và encoder. Parallel không nằm trong preset. Xóa một preset không xóa video đã render.'}</p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">PARALLEL JOBS</label>
                            <select
                                value={parallelJobs}
                                onChange={(e) => {
                                    const n = e.target.value === '1' ? 1 : 2;
                                    setParallelJobs(n);
                                    try { localStorage.setItem('gf_parallel', String(n)); } catch { /* ignore */ }
                                }}
                                disabled={isProcessing}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-purple-500 focus:border-purple-500 block p-2.5 outline-none disabled:opacity-50"
                            >
                                <option value={1}>1 clip at a time</option>
                                <option value={2}>2 clips at a time (faster queue)</option>
                            </select>
                            <p className="text-[10px] text-gray-500 leading-tight">Two FFmpeg at once. Unique per clip is the same. Use 1 if RAM/GPU spikes.</p>
                        </div>
                    </div>

                    {presetNotice && (
                        <button
                            type="button"
                            role="status"
                            onClick={() => {
                                if (presetNoticeTimer.current) clearTimeout(presetNoticeTimer.current);
                                presetNoticeTimer.current = null;
                                setPresetNotice('');
                            }}
                            className="fixed top-4 left-1/2 z-[60] -translate-x-1/2 max-w-[90vw] rounded-xl border border-emerald-400/50 bg-gray-950 px-4 py-2 text-sm font-semibold text-emerald-100 shadow-xl"
                        >
                            {presetNotice}
                        </button>
                    )}

                    {viewPresetId && namedPresets.some((item) => item.id === viewPresetId) && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70" onClick={() => setViewPresetId('')}>
                            <div
                                role="dialog"
                                aria-label={namedPresets.find((item) => item.id === viewPresetId)?.name || 'Preset'}
                                className="max-w-lg w-full max-h-[80vh] overflow-y-auto rounded-2xl border border-purple-500/40 bg-gray-950 p-5 space-y-3 shadow-xl"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <h3 className="text-lg font-semibold text-gray-100">{namedPresets.find((item) => item.id === viewPresetId)?.name}</h3>
                                    <button type="button" onClick={() => setViewPresetId('')} className="text-gray-400 hover:text-white" aria-label="Đóng">
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                                <ul className="space-y-2 text-sm text-gray-200 leading-snug">
                                    {describeUniquePreset(namedPresets.find((item) => item.id === viewPresetId)?.settings).map((line) => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            </div>
                        </div>
                    )}

                    {/* Action Button */}
                    {isProcessing ? (
                        <div className="flex flex-col sm:flex-row gap-2">
                            <button
                                type="button"
                                onClick={pauseProcessing}
                                className={`flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg border ${
                                    isPaused
                                        ? 'bg-emerald-900/40 text-emerald-200 border-emerald-500/40 hover:bg-emerald-800/50'
                                        : 'bg-amber-900/40 text-amber-200 border-amber-500/40 hover:bg-amber-800/50'
                                }`}
                            >
                                {isPaused ? <Play className="w-5 h-5 fill-current" /> : <Pause className="w-5 h-5 fill-current" />}
                                {isPaused ? 'Tiếp tục' : 'Tạm dừng'}
                            </button>
                            <button
                                type="button"
                                onClick={cancelProcessing}
                                className="flex-1 flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg bg-red-900/40 text-red-300 border border-red-500/40 hover:bg-red-800/50"
                            >
                                <Square className="w-5 h-5 fill-current" />
                                CANCEL NOW ({queueIndex}/{queueTotal || files.length})
                            </button>
                        </div>
                    ) : (
                    <button
                        onClick={startProcessing}
                        disabled={!files.length}
                        className={`
                            w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg transition-all duration-300
                            ${!files.length ? 'bg-gray-800/50 text-gray-600 cursor-not-allowed border border-gray-800' : 
                              'bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white shadow-[0_0_20px_rgba(168,85,247,0.4)] hover:shadow-[0_0_30px_rgba(168,85,247,0.6)] border border-purple-400/50'}
                        `}
                    >
                                <Sparkles className="w-5 h-5" />
                                GENERATE UNIQUE VARIANT{files.length > 1 ? ` (${files.length})` : ''}
                    </button>
                    )}

                    {/* Progress Bar */}
                    {isProcessing && (
                        <div className="space-y-3 bg-gray-900/50 p-4 rounded-xl border border-gray-800">
                            {sidePhase === 'smooth' && (
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs font-mono text-cyan-300">
                                        <span>LÀM MỊN</span>
                                        <span>{sideProgress.toFixed(1)}%</span>
                                    </div>
                                    <div className="w-full bg-gray-950 rounded-full h-2.5 overflow-hidden border border-cyan-900/60">
                                        <div className="bg-cyan-500 h-full rounded-full transition-all duration-300" style={{ width: `${Math.min(100, sideProgress)}%` }} />
                                    </div>
                                </div>
                            )}
                            {sidePhase === 'caption' && (
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs font-mono text-amber-300">
                                        <span>PHỤ ĐỀ</span>
                                        <span>{sideProgress.toFixed(1)}%</span>
                                    </div>
                                    <div className="w-full bg-gray-950 rounded-full h-2.5 overflow-hidden border border-amber-900/60">
                                        <div className="bg-amber-500 h-full rounded-full transition-all duration-300" style={{ width: `${Math.min(100, sideProgress)}%` }} />
                                    </div>
                                </div>
                            )}
                            <div className="space-y-1.5">
                                <div className="flex justify-between text-xs font-mono text-purple-400">
                                    <span>UNIQUE (FFmpeg){isPaused ? ' · TẠM DỪNG' : ''}</span>
                                    <span>
                                        {progress.toFixed(1)}%
                                        {etaLabel(progressEtaMs) ? <span className="text-gray-400"> · còn {etaLabel(progressEtaMs)}</span> : null}
                                    </span>
                                </div>
                                <div className="w-full bg-gray-950 rounded-full h-2.5 overflow-hidden border border-gray-800">
                                    <div
                                        className="bg-gradient-to-r from-purple-500 to-blue-500 h-full rounded-full transition-all duration-300 ease-out relative"
                                        style={{ width: `${Math.min(100, progress)}%` }}
                                    >
                                        <div className={`absolute inset-0 bg-white/20 w-full ${isPaused ? '' : 'animate-[shimmer_1s_infinite]'}`}></div>
                                    </div>
                                </div>
                            </div>
                            {(pgdActive || (enablePgd && progress >= 99.5)) && (
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs font-mono text-violet-300">
                                        <span>PGD CLIP (GPU){isPaused ? ' · TẠM DỪNG' : ''}</span>
                                        <span>
                                            {pgdProgress.toFixed(1)}%
                                            {etaLabel(pgdEtaMs) ? <span className="text-gray-400"> · còn {etaLabel(pgdEtaMs)}</span> : null}
                                        </span>
                                    </div>
                                    <div className="w-full bg-gray-950 rounded-full h-2.5 overflow-hidden border border-violet-900/60">
                                        <div
                                            className="bg-gradient-to-r from-violet-500 to-fuchsia-500 h-full rounded-full transition-all duration-300 ease-out relative"
                                            style={{ width: `${Math.min(100, pgdProgress)}%` }}
                                        >
                                            <div className={`absolute inset-0 bg-white/20 w-full ${isPaused ? '' : 'animate-[shimmer_1s_infinite]'}`}></div>
                                        </div>
                                    </div>
                                    <p className="text-[10px] text-gray-500">Unique đã xong. Thanh này là PGD — chậm hơn, chạy trên RTX.</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Right Column: Terminal & Results */}
                <div className="xl:col-span-8 space-y-6">
                    {/* Terminal */}
                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden flex flex-col shadow-lg">
                        <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Terminal className="w-4 h-4 text-purple-400" />
                                <span className="text-xs font-mono text-gray-400">ghostforge_unique.log</span>
                            </div>
                            <div className="flex gap-1.5">
                                <div className="w-2.5 h-2.5 rounded-full bg-red-500/50"></div>
                                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50"></div>
                                <div className="w-2.5 h-2.5 rounded-full bg-green-500/50"></div>
                            </div>
                        </div>
                        <div className="p-2">
                            <LogViewer
                                logs={logsByChannel.unique}
                                getExportLogs={() => fullLogsRef.current.unique}
                                filePrefix="unique"
                                emptyText="Unique đang chờ."
                                onClear={() => clearLogChannel('unique')}
                            />
                        </div>
                    </div>

                    {/* Results Panel */}
                    {detailOpen && stats && (
                        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 p-2 sm:p-6" onClick={() => setDetailOpen(false)}>
                        <div className="w-full max-w-5xl bg-gray-950 border border-gray-700 rounded-2xl p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between gap-3 mb-4">
                            <div className="min-w-0">
                                <div className="text-sm font-bold text-gray-100 truncate">{detailName || 'Chi tiết video'}</div>
                                <div className="text-[11px] text-gray-500 font-mono">Thông số kỹ thuật của riêng video này · bấm ra ngoài để đóng</div>
                                {stats.handoffNote && (
                                    <div className="text-[11px] text-cyan-300 mt-1">{stats.handoffNote}</div>
                                )}
                            </div>
                            <button type="button" onClick={() => setDetailOpen(false)} className="shrink-0 text-xs font-mono px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 hover:border-red-500 hover:text-red-300">Đóng</button>
                        </div>
                        <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-6 shadow-lg">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                                <h3 className="text-xl font-bold flex items-center gap-2 text-gray-100">
                                    <CheckCircle2 className="w-6 h-6 text-green-500 drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]" />
                                    Spoofing Complete
                                </h3>
                            </div>
                            
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                                <div className="bg-gray-950/80 p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                                    <div className="absolute top-0 right-0 w-16 h-16 bg-purple-500/10 rounded-bl-full blur-xl"></div>
                                    <div className="text-xs text-gray-500 font-mono mb-1 flex items-center gap-2">
                                        <Fingerprint className="w-4 h-4" />
                                        MỨC KHÁC BIỆT ĐO ĐƯỢC
                                    </div>
                                    <div className={`text-2xl font-black mt-2 ${perceptualVerdict?.tone === 'warn' ? 'text-amber-300' : 'text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-400'}`}>
                                        {typeof stats.perceptualDistance === 'number'
                                            ? `${(stats.perceptualDistance * 100).toFixed(1)}% — ${perceptualVerdict?.text || ''}`
                                            : 'CHƯA ĐO'}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-2">
                                        {typeof stats.perceptualDistance === 'number'
                                            ? `dHash 256-bit trên ${stats.perceptualFrames || 3} khung · ${Number.isFinite(stats.perceptualBest) && Number.isFinite(stats.perceptualWorst) ? `${((stats.perceptualBest as number) * 100).toFixed(1)}–${((stats.perceptualWorst as number) * 100).toFixed(1)}% giữa các khung` : 'chỉ một khung đo được'} · luma ${Number.isFinite(stats.perceptualLumaDelta) ? ((stats.perceptualLumaDelta as number) * 100).toFixed(1) : '?'}% · ${perceptualVerdict?.note || ''}`
                                            : 'Không đo được khung đối chiếu cho clip này.'}
                                        <br />
                                        <span className="text-gray-600">Ước lượng cho người vận hành, không phải kết luận của nền tảng. SHA-256 luôn khác sau khi encode lại nên không dùng làm thước đo. dHash bão hoà quanh 40% — xem thêm pHash và ô 4×4 ở bảng dưới.</span>
                                        <br />
                                        <span className="text-amber-500/80">Chạy lại cùng cài đặt sẽ ra số KHÁC: đo trên chính clip của bạn, các lần chạy lệch ~3 điểm (cá biệt ~5). Nên <b>chênh dưới 5 điểm giữa hai cài đặt là nhiễu</b>, đừng đổi cài đặt vì một lần chạy.</span>
                                    </div>
                                </div>
                                <div className="bg-gray-950/80 p-5 rounded-xl border border-gray-800 relative overflow-hidden">
                                    <div className="absolute top-0 right-0 w-16 h-16 bg-green-500/10 rounded-bl-full blur-xl"></div>
                                    <div className="text-xs text-gray-500 font-mono mb-1 flex items-center gap-2">
                                        <ShieldAlert className="w-4 h-4" />
                                        ĐÃ ÁP DỤNG
                                    </div>
                                    <div className="text-sm font-bold text-gray-200 mt-2 space-y-1 font-mono">
                                        <div>Khác biệt: <span className="text-purple-300">{(stats.uniqueStrength || 'standard').toUpperCase()}</span></div>
                                        <div>Xoay: <span className="text-purple-300">{stats.uniqueWobble ? `Đung đưa ±${stats.uniqueWobble}°` : stats.uniqueRotate ? `Nghiêng ${stats.uniqueRotate}°` : 'Tắt'}</span></div>
                                        <div>Preset nền tảng: <span className="text-gray-400">{stats.platform.replace('_', ' ')}</span></div>
                                    </div>
                                    <div className="text-xs text-gray-500 mt-2">
                                        {stats.metadataConfirmed
                                            ? `Metadata đã ghi & xác minh: ${stats.metadataProfile}`
                                            : `Metadata đã ghi: ${stats.metadataProfile} (chưa xác minh được)`}
                                        <br />
                                        <span className="text-gray-600">Preset nền tảng chỉ chỉnh màu ~2–3%, không phải “tối ưu cho nền tảng”.</span>
                                    </div>
                                </div>
                            </div>

                            {stats.compareJobId && (
                                <div className="bg-black/50 rounded-xl border border-violet-900/50 mb-6 overflow-hidden">
                                    <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-2">
                                        <ScanSearch className="w-4 h-4 text-violet-400" />
                                        <span className="text-xs font-mono text-gray-400 tracking-wide">MẮT NGƯỜI vs MÁY THẤY — cùng 1 frame giữa clip</span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
                                        <div className="border-b sm:border-b-0 sm:border-r border-gray-800">
                                            <div className="px-3 py-2 text-[10px] font-mono text-amber-300">BẢN GỐC — cùng frame, TRƯỚC khi xử lý</div>
                                            <img alt="source frame" className="w-full aspect-[9/16] max-h-80 object-contain bg-black" src={`${BACKEND_URL}/api/compare/${stats.compareJobId}/orig`} />
                                        </div>
                                        <div className="border-b sm:border-b-0 sm:border-r border-gray-800">
                                            <div className="px-3 py-2 text-[10px] font-mono text-gray-500">MẮT NGƯỜI — {stats.temporalMode?.includes('PGD-only') ? 'PGD only (không Unique)' : stats.pgdOn ? 'sau Unique+PGD' : 'sau Unique'}</div>
                                            <img alt="processed" className="w-full aspect-[9/16] max-h-80 object-contain bg-black" src={`${BACKEND_URL}/api/compare/${stats.compareJobId}/proc`} />
                                        </div>
                                        <div>
                                            <div className="px-3 py-2 text-[10px] font-mono text-violet-300">MÁY THẤY — sóng Unique/PGD trên mặt (xám sáng = lớp; tấm xanh đặc = lỗi contrast cũ)</div>
                                            <img alt="machine diff" className="w-full aspect-[9/16] max-h-80 object-contain bg-black" src={`${BACKEND_URL}/api/compare/${stats.compareJobId}/diff`} />
                                        </div>
                                    </div>
                                    <p className="px-5 py-3 text-[11px] text-gray-500 leading-relaxed">
                                        Ảnh trái = mắt người (không sọc). Ảnh phải = tách lớp Unique/PGD trên chính frame đó (không so zoom với gốc — zoom làm mép sáng, mặt tối). <b>Ảnh phải đã được tăng cường độ tương phản</b> nên độ sáng của nó KHÔNG tỉ lệ với mức khác biệt — muốn biết mức thật thì đọc số dHash ở bảng trên.
                                        {typeof stats.clipSim === 'number' ? (
                                            <> CLIP sim <span className="text-violet-300 font-mono">{stats.clipSim.toFixed(4)}</span> — <b>càng thấp càng lệch embedding, dễ thoát unoriginal hơn</b> (1.0 = giống hệt). Mục tiêu hữu ích khoảng 0.82–0.95. Dưới ~0.80 có thể thấy nhiễu.</>
                                        ) : stats.pgdOn ? (
                                            <> PGD đã bật nhưng không ghi được CLIP sim (lỗi cuối pass). File này có thể chỉ Unique — chạy lại sau khi cập nhật pgd_clip.py.</>
                                        ) : (
                                            <> Bật CLIP PGD để có chỉ số cosine. Unique-only thì chỉ nhìn ảnh phải.</>
                                        )}
                                    </p>
                                </div>
                            )}

                            <div className="bg-black/50 rounded-xl border border-gray-800/80 mb-6 overflow-hidden">
                                <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-2">
                                    <ScanSearch className="w-4 h-4 text-purple-400" />
                                    <span className="text-xs font-mono text-gray-400 tracking-wide">ĐO ĐƯỢC SAU KHI XỬ LÝ — ước lượng, không phải kết luận nền tảng</span>
                                </div>
                                <div className="divide-y divide-gray-800/70">
                                    {[
                                        {
                                            label: 'Kiểm tra lỗi hình — vạch ngang (đo thật)',
                                            orig: Number.isFinite(stats.seamIn)
                                                ? `có vạch: ${stats.seamIn} luma/1 hàng ở y≈${stats.seamInRowPct}%`
                                                : (stats.seamFrames ? 'không có vạch' : 'file vào'),
                                            origTitle: 'Tìm hàng nhảy vọt so với hàng kề nó (đứt gãy), không phải mép nội dung dốc. Bước nhảy ≥ 25/255 và gấp ≥ 3 lần hàng kề thì coi là vạch.',
                                            spoof: Number.isFinite(stats.seamOut)
                                                ? `có vạch: ${stats.seamOut} luma/1 hàng ở y≈${stats.seamOutRowPct}%`
                                                : (stats.seamFrames ? 'không có vạch' : 'chưa đo được'),
                                            spoofTitle: 'Cùng phép đo, chạy trên file Unique trả ra.',
                                            delta: seamCheck?.text || 'n/a',
                                            tone: seamCheck?.tone || 'info',
                                            note: seamCheck?.note || 'Dò 5 khung, so file vào với file ra.',
                                        },
                                        {
                                            label: 'Khung hình — dHash 256-bit (đo thật)',
                                            orig: 'khung gốc của clip',
                                            origTitle: stats.perceptualFrames ? `${stats.perceptualFrames} khung đã đối chiếu` : '',
                                            spoof: Number.isFinite(stats.perceptualDistance)
                                                ? `${((stats.perceptualDistance as number) * 100).toFixed(1)}% bit cấu trúc · ${Number.isFinite(stats.perceptualLumaDelta) ? ((stats.perceptualLumaDelta as number) * 100).toFixed(1) : '?'}% luma`
                                                : 'chưa đo được',
                                            spoofTitle: Number.isFinite(stats.perceptualWorst)
                                                ? `khung lệch nhất: ${((stats.perceptualWorst as number) * 100).toFixed(1)}% bit`
                                                : '',
                                            delta: perceptualVerdict?.text || 'n/a',
                                            tone: perceptualVerdict?.tone || 'info',
                                            note: 'Ước lượng cho người vận hành trên vài mốc nội dung — không phải kết luận của nền tảng.',
                                        },
                                        {
                                            label: 'Cấu trúc lớn — pHash 63-bit DCT (đo thật)',
                                            orig: 'khung gốc của clip',
                                            spoof: Number.isFinite(stats.perceptualPHash)
                                                ? `${((stats.perceptualPHash as number) * 100).toFixed(1)}% bit tần số thấp${Number.isFinite(stats.perceptualPHashWorst) ? ` · khung lệch nhất ${((stats.perceptualPHashWorst as number) * 100).toFixed(1)}%` : ''}`
                                                : 'chưa đo được',
                                            delta: pHashVerdict?.text || 'n/a',
                                            tone: pHashVerdict?.tone || 'info',
                                            note: 'Bền với hạt và với đổi độ sáng; chỉ thấy cấu trúc thô hơn ~1/8 khung. Số thấp là bình thường — đọc kèm dHash ở trên.',
                                        },
                                        {
                                            label: 'Cục bộ — ô 4×4 lệch nhất (đo thật)',
                                            orig: 'khung gốc của clip',
                                            spoof: Number.isFinite(stats.perceptualBlockWorst)
                                                ? `${((stats.perceptualBlockWorst as number) * 100).toFixed(1)}% ở ô lệch nhất · trung bình ô ${Number.isFinite(stats.perceptualBlockMean) ? ((stats.perceptualBlockMean as number) * 100).toFixed(1) : '?'}%`
                                                : 'chưa đo được',
                                            delta: blockVerdict?.text || 'n/a',
                                            tone: blockVerdict?.tone || 'info',
                                            note: 'Ô lệch cao mà trung bình thấp = lệch một vùng (đường ghép, caption). Cả hai cao = đổi toàn khung. Không bão hoà như số dHash toàn cục.',
                                        },
                                        {
                                            label: 'Âm thanh — độ to theo từng giây (đo thật)',
                                            orig: Number.isFinite(stats.audioSrcRmsDb)
                                                ? `gốc: RMS ${dbSigned(stats.audioSrcRmsDb)} dB`
                                                : (Number.isFinite(stats.audioMeasuredSec) ? 'file vào không có tiếng' : 'file vào'),
                                            origTitle: 'RMS trung bình trên cùng cửa sổ đo (dBFS; càng gần 0 càng to).',
                                            spoof: Number.isFinite(stats.audioOutRmsDb)
                                                ? `ra: RMS ${dbSigned(stats.audioOutRmsDb)} dB (lệch ${dbSigned(stats.audioLevelDeltaDb)} dB)`
                                                : 'chưa đo được',
                                            spoofTitle: 'Cùng phép đo, chạy trên file Unique trả ra.',
                                            delta: audioLevelVerdict?.text || 'n/a',
                                            tone: audioLevelVerdict?.tone || 'info',
                                            note: audioLevelVerdict?.note || 'Đo mức to từng giây của file vào và file ra ở cùng mốc nội dung (đã bù tempo).',
                                        },
                                        {
                                            label: 'Âm thanh — phổ 3 dải thấp/giữa/cao (đo thật)',
                                            orig: 'khung gốc của clip',
                                            spoof: Number.isFinite(stats.audioBandLowDb)
                                                ? `thấp ${dbSigned(stats.audioBandLowDb)} · giữa ${dbSigned(stats.audioBandMidDb)} · cao ${dbSigned(stats.audioBandHighDb)} dB`
                                                : 'chưa đo được',
                                            spoofTitle: 'Lệch trung bình của từng dải so với file gốc (dB).',
                                            delta: audioBandVerdict?.text || 'n/a',
                                            tone: audioBandVerdict?.tone || 'info',
                                            note: `${audioBandVerdict?.note || 'Lệch = mức EQ cố định của lượt này; trôi = dải đó còn đổi theo thời gian.'}${Number.isFinite(stats.audioMeasuredSec) ? ` Đo trên ${stats.audioMeasuredSec} giây đầu của file ra.` : ''} Không phải kết luận nhận dạng âm thanh của nền tảng.`,
                                        },
                                        {
                                            label: 'Nội dung — CLIP sim file ra vs gốc (đo thật)',
                                            orig: 'khung gốc của clip',
                                            origTitle: `ViT-B-32 · ${stats.clipSimOutFrames || 0} khung · đo trên ${stats.clipSimOutDevice || 'gpu/cpu'}`,
                                            spoof: Number.isFinite(stats.clipSimOut)
                                                ? `${(stats.clipSimOut as number).toFixed(4)}${Number.isFinite(stats.clipSimOutWorst) ? ` · khung lệch nhất ${(stats.clipSimOutWorst as number).toFixed(4)}` : ''}`
                                                : 'đang tắt — bật "Đo đầy đủ" nếu cần số này',
                                            spoofTitle: 'Cosine similarity giữa embedding của file gốc và file ra: 1.0000 = giống hệt nội dung.',
                                            delta: clipVerdict?.text || 'n/a',
                                            tone: clipVerdict?.tone || 'info',
                                            note: `${clipVerdict?.note || ''} Đo tại máy bạn bằng ViT-B-32, không tốn API. Khác với số PGD tự báo (đo trong lúc tấn công) vì số này đo lại trên file đã render.`.trim(),
                                        },
                                        {
                                            label: 'Sau nén lại — crf 30, cạnh dài 720 (đo thật)',
                                            orig: 'file ra, nén lại im lặng',
                                            origTitle: 'libx264 crf 30, cạnh dài tối đa 720, không phóng to. File này bị xoá sau khi đo. File tải về không phải bản này.',
                                            spoof: Number.isFinite(stats.harshDistance) || Number.isFinite(stats.harshClipSim)
                                                ? `dHash ${Number.isFinite(stats.harshDistance) ? ((stats.harshDistance as number) * 100).toFixed(1) : '?'}% · pHash ${Number.isFinite(stats.harshPHash) ? ((stats.harshPHash as number) * 100).toFixed(1) : '?'}% · CLIP ${Number.isFinite(stats.harshClipSim) ? (stats.harshClipSim as number).toFixed(4) : '?'}`
                                                : 'đang tắt — bật "Đo đầy đủ" nếu cần số này',
                                            spoofTitle: Number.isFinite(stats.harshClipWorst)
                                                ? `CLIP khung lệch nhất sau nén: ${(stats.harshClipWorst as number).toFixed(4)}`
                                                : '',
                                            delta: 'SAU NÉN',
                                            tone: 'info',
                                            note: `Phần còn lại sau một lần nén mạnh. ${stats.harshFrames ? `${stats.harshFrames} khung dHash/pHash. ` : ''}So với dòng CLIP phía trên: số CLIP ở đây gần 1 hơn nghĩa là lần nén đã kéo hình về phía nguồn.`,
                                        },
                                        {
                                            label: 'SHA-256 (byte của file)',
                                            orig: shortHash(stats.originalHash),
                                            origTitle: stats.originalHash,
                                            spoof: shortHash(stats.newHash),
                                            spoofTitle: stats.newHash,
                                            delta: stats.originalHash !== stats.newHash ? 'KHÁC' : 'GIỐNG',
                                            tone: 'info',
                                            note: 'Encode lại thì hash luôn khác — không nói lên việc hình có khác hay không.',
                                        },
                                        {
                                            label: 'Dung lượng',
                                            orig: formatBytes(stats.originalSize),
                                            spoof: formatBytes(stats.newSize),
                                            delta: stats.originalSize && stats.newSize
                                                ? `${stats.newSize >= stats.originalSize ? '+' : '−'}${(Math.abs((stats.newSize - stats.originalSize) / stats.originalSize) * 100).toFixed(0)}%`
                                                : '—',
                                            tone: 'info',
                                        },
                                        {
                                            label: 'Codec',
                                            orig: codecLabel(stats.originalCodec),
                                            spoof: codecLabel(stats.newCodec),
                                            delta: (stats.originalCodec || '') !== (stats.newCodec || '') ? 'ĐỔI' : 'GIỮ NGUYÊN',
                                            tone: 'info',
                                        },
                                        {
                                            label: 'Độ phân giải',
                                            orig: resLabel(stats.originalWidth, stats.originalHeight),
                                            spoof: resLabel(stats.newWidth, stats.newHeight),
                                            delta: stats.originalWidth && stats.newWidth && (stats.originalWidth !== stats.newWidth || stats.originalHeight !== stats.newHeight) ? 'ĐỔI CỠ' : 'GIỮ NGUYÊN',
                                            tone: 'info',
                                        },
                                        {
                                            label: 'Thời lượng / FPS',
                                            orig: `${formatDuration(stats.originalDuration)} · ${stats.originalFps ?? '—'} fps`,
                                            spoof: `${formatDuration(stats.newDuration)} · ${stats.newFps ?? '—'} fps`,
                                            delta: stats.originalDuration && stats.newDuration
                                                ? `${stats.newDuration >= stats.originalDuration ? '+' : '−'}${(Math.abs((stats.newDuration - stats.originalDuration) / stats.originalDuration) * 100).toFixed(2)}% dài`
                                                : '—',
                                            tone: 'info',
                                            note: 'Tempo đổi tốc độ ±1–2% nên thời lượng lệch theo; fps giữ nguyên.',
                                        },
                                        {
                                            label: 'Metadata thiết bị',
                                            orig: 'đã xoá tag gốc',
                                            spoof: stats.metadataMake ? `${stats.metadataMake} ${stats.metadataModel}` : stats.metadataProfile,
                                            delta: stats.metadataConfirmed ? 'ĐÃ XÁC MINH' : 'CHƯA XÁC MINH',
                                            tone: stats.metadataConfirmed ? 'ok' : 'warn',
                                            note: 'Đọc lại từ file sau khi ghi, nên đây là số thật.',
                                        },
                                        {
                                            label: 'Grade màu đã áp',
                                            orig: 'nguồn',
                                            spoof: stats.colorMode || 'per-job hue · sat · gamma',
                                            delta: 'MÔ TẢ',
                                            tone: 'info',
                                            note: 'Đây là mô tả tham số đã dùng, không phải một phép đo.',
                                        },
                                    ].map((row) => (
                                        <div key={row.label} className="px-5 py-3">
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="text-xs font-mono text-gray-500">{row.label}</span>
                                                <span className={`text-[10px] font-mono font-bold ${row.tone === 'ok' ? 'text-green-400' : row.tone === 'warn' ? 'text-amber-400' : 'text-gray-400'}`}>{row.delta}</span>
                                            </div>
                                            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                                                <div>
                                                    <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-0.5">Original</div>
                                                    <div className="text-gray-300 break-all" title={row.origTitle}>{row.orig}</div>
                                                </div>
                                                <div>
                                                    <div className="text-[10px] uppercase tracking-wider text-purple-400/80 mb-0.5">Spoofed</div>
                                                    <div className="text-gray-100 break-all" title={row.spoofTitle}>{row.spoof}</div>
                                                </div>
                                            </div>
                                            {'note' in row && row.note ? (
                                                <p className="text-[10px] text-gray-600 mt-1.5 leading-tight">{row.note}</p>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                                {(stats.metadataLocation || stats.metadataTitle) && (
                                    <div className="px-5 py-3 border-t border-gray-800 text-[11px] font-mono text-gray-500 space-y-1">
                                        {stats.metadataTitle && <div>Title: <span className="text-gray-300">{stats.metadataTitle}</span></div>}
                                        {stats.metadataLocation && <div>GPS: <span className="text-gray-300">{stats.metadataLocation}</span></div>}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-3 font-mono text-xs bg-black/50 p-5 rounded-xl border border-gray-800/80 mb-6 shadow-inner">
                                <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                                    <span className="text-gray-500 flex items-center gap-1"><Hash className="w-3 h-3"/> Original SHA-256:</span>
                                    <span className="text-gray-400 break-all sm:text-right">{stats.originalHash}</span>
                                </div>
                                <div className="flex flex-col sm:flex-row sm:justify-between gap-1">
                                    <span className="text-gray-500 flex items-center gap-1"><Hash className="w-3 h-3"/> Spoofed SHA-256:</span>
                                    <span className="text-purple-400 break-all sm:text-right">{stats.newHash}</span>
                                </div>
                                <div className="flex justify-between pt-2 border-t border-gray-800/50 mt-2">
                                    <span className="text-gray-500">Temporal Shift:</span>
                                    <span className="text-gray-300">
                                        {stats.temporalMode} | FPS {stats.fpsJitter}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Geometric Shift:</span>
                                    <span className="text-gray-300">
                                        {stats.geometricMode}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Color Shift:</span>
                                    <span className="text-gray-300">
                                        {stats.colorMode || 'per-job hue / sat / gamma'}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Lớp nhiễu nhẹ (không phải PGD):</span>
                                    <span className="text-gray-300">
                                        {stats.adversarialMode}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Processing Time:</span>
                                    <span className="text-gray-300">{(stats.processingTimeMs / 1000).toFixed(2)}s</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-gray-500">Thời gian từng giai đoạn:</span>
                                    <span className="text-gray-300 text-right">
                                        {[
                                            ['chuẩn bị', stats.stagePrepMs],
                                            ['encode', stats.stageEncodeMs],
                                            ['PGD', stats.stagePgdMs],
                                            ['metadata', stats.stageMetadataMs],
                                            ['đo đạc', stats.stageMeasureMs],
                                        ]
                                            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value as number) && (value as number) > 0)
                                            .map(([label, value]) => `${label} ${((value as number) / 1000).toFixed(1)}s`)
                                            .join(' · ') || '—'}
                                    </span>
                                </div>
                            </div>

                            {(queueResults.length > 0 || downloadUrl) && (
                                <p className="text-xs text-gray-500 font-mono">Downloads are in the Completed list below.</p>
                            )}
                        </div>
                        </div>
                        </div>
                    )}

                    {queueResults.length > 0 && (
                        <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                                <h3 className="text-lg font-bold text-gray-100 flex items-center gap-2">
                                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                                    Completed ({queueResults.length})
                                    <span className="text-xs font-mono font-normal text-gray-500">
                                        {queueResults.filter((r) => r.saved).length} saved · {queueResults.filter((r) => !r.saved).length} not saved
                                    </span>
                                </h3>
                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => pickSaveFolder()}
                                        className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-gray-700 bg-gray-950 text-gray-300 hover:border-purple-500 hover:text-purple-300"
                                    >
                                        <FolderOpen className="w-4 h-4" />
                                        {saveFolderName ? `Shared: ${saveFolderName}` : 'Choose shared folder'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => openSavedLocation()}
                                        className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-gray-700 bg-gray-950 text-gray-300 hover:border-green-500 hover:text-green-300"
                                    >
                                        <FolderOpen className="w-4 h-4" />
                                        Open shared
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void removeAllCompleted()}
                                        className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-red-800 bg-red-950/40 text-red-300 hover:border-red-500 hover:text-red-200"
                                        title="Clear completed list. Saved files on disk stay."
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Remove all
                                    </button>
                                </div>
                            </div>
                            <p className={`text-[11px] mb-3 ${osSavePath ? 'text-green-400' : 'text-amber-400'}`}>
                                {osSavePath
                                    ? `Shared folder: ${osSavePath}`
                                    : 'Choose a shared folder for “Save all”. Each clip can still Save to… a different folder.'}
                            </p>
                            {saveNotice && (
                                <div className="mb-3 px-3 py-2 rounded-lg bg-green-500/15 border border-green-500/40 text-green-300 text-sm font-medium">
                                    {saveNotice}
                                </div>
                            )}
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={queueResults.length > 0 && selectedIds.length === queueResults.length}
                                        onChange={(e) => setSelectedIds(e.target.checked ? queueResults.map((r) => r.jobId) : [])}
                                    />
                                    Select all
                                </label>
                                <span className="text-[11px] font-mono text-gray-500">{selectedIds.length} selected</span>
                                <button
                                    type="button"
                                    onClick={() => saveAllToShared(queueResults.filter((r) => selectedIds.includes(r.jobId)))}
                                    disabled={selectedIds.length === 0}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-bold"
                                >
                                    <Save className="w-3.5 h-3.5" />
                                    Save selected to shared
                                </button>
                                <button
                                    type="button"
                                    onClick={() => saveAllToShared(queueResults)}
                                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-bold border border-gray-600"
                                >
                                    Save all to shared
                                </button>
                            </div>
                            <ul className="divide-y divide-gray-800">
                                {queueResults.map((item) => {
                                    const filename = safeFileName(item.name);
                                    const checked = selectedIds.includes(item.jobId);
                                    const elapsedSec = Math.round((item.stats?.processingTimeMs || 0) / 1000);
                                    const elapsedLabel = item.failed || !elapsedSec
                                        ? ''
                                        : elapsedSec >= 60
                                            ? `${Math.floor(elapsedSec / 60)}m ${String(elapsedSec % 60).padStart(2, '0')}s`
                                            : `${elapsedSec}s`;
                                    const originNote = item.handoffNote || item.stats?.handoffNote || '';
                                    const openDetail = () => {
                                        if (!item.stats || item.failed) return;
                                        setStats(item.stats);
                                        setDetailName(filename);
                                        setDetailOpen(true);
                                    };
                                    return (
                                        <li key={item.jobId} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggleSelected(item.jobId)}
                                                className="shrink-0"
                                            />
                                            <FileVideo className={`w-4 h-4 shrink-0 hidden sm:block ${item.failed ? 'text-red-400' : 'text-green-400'}`} />
                                            {renamingId === item.jobId ? (
                                                <input
                                                    autoFocus
                                                    defaultValue={filename}
                                                    className="flex-1 bg-gray-950 border border-purple-500 rounded px-2 py-1 text-sm text-gray-100 outline-none"
                                                    onBlur={(e) => {
                                                        renameCompleted(item.jobId, e.target.value);
                                                        setRenamingId(null);
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            renameCompleted(item.jobId, (e.target as HTMLInputElement).value);
                                                            setRenamingId(null);
                                                        }
                                                        if (e.key === 'Escape') setRenamingId(null);
                                                    }}
                                                />
                                            ) : (
                                                <span
                                                    className={`flex-1 min-w-0 text-sm ${item.stats && !item.failed ? 'text-gray-200 cursor-pointer hover:text-violet-300' : 'text-gray-200'}`}
                                                    onClick={openDetail}
                                                    title={item.failed ? item.error : `${item.originalName} — bấm để xem thông số`}
                                                >
                                                    <span className="block truncate">{filename}</span>
                                                    {originNote && <span className="block truncate text-[10px] text-cyan-300/90">{originNote}</span>}
                                                    {item.failed && <span className="block truncate text-[10px] text-red-400">{item.error || 'failed'}</span>}
                                                </span>
                                            )}
                                            {elapsedLabel && (
                                                <span className="text-[10px] font-mono text-gray-500 shrink-0" title="Thời gian xử lý riêng video này">{elapsedLabel}</span>
                                            )}
                                            {item.stats && !item.failed && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        openDetail();
                                                    }}
                                                    className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30"
                                                    title="Xem thông số kỹ thuật của riêng video này"
                                                >
                                                    Chi tiết
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    if (item.failed) return;
                                                    if (!item.saved) {
                                                        setSaveNotice('Save the clip first');
                                                        return;
                                                    }
                                                    void openSavedLocation(item);
                                                }}
                                                className={`text-[10px] font-mono px-2 py-0.5 rounded shrink-0 ${
                                                    item.failed
                                                        ? 'bg-red-500/20 text-red-400'
                                                        : item.saved
                                                            ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30 cursor-pointer'
                                                            : 'bg-amber-500/15 text-amber-400'
                                                }`}
                                                title={item.failed ? item.error : (item.saved ? 'Open this folder in Explorer' : 'Not saved yet')}
                                            >
                                                {item.failed ? 'FAILED' : item.saved ? `SAVED → ${item.savedTo}` : 'NOT SAVED'}
                                            </button>
                                            {item.saved && (
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        void openSavedLocation(item);
                                                    }}
                                                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-[10px] font-bold"
                                                    title="Open the folder this clip was saved to"
                                                >
                                                    <FolderOpen className="w-3.5 h-3.5" />
                                                    Open
                                                </button>
                                            )}
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => setRenamingId(item.jobId)}
                                                    className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-purple-300"
                                                    title="Rename"
                                                >
                                                    <Pencil className="w-4 h-4" />
                                                </button>
                                                {!item.failed && (
                                                <button
                                                    type="button"
                                                    onClick={() => saveAllToShared([item])}
                                                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-[10px] font-bold border border-gray-600"
                                                    title="Save into the shared folder"
                                                >
                                                    Shared
                                                </button>
                                                )}
                                                {!item.failed && (
                                                <button
                                                    type="button"
                                                    onClick={() => saveOneToChosenFolder(item)}
                                                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-white text-[10px] font-bold"
                                                    title="Pick a folder just for this clip"
                                                >
                                                    <FolderOpen className="w-3.5 h-3.5" />
                                                    Save to…
                                                </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => removeCompleted(item.jobId)}
                                                    className="p-1.5 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400"
                                                    title="Remove from list"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
            )}

            {appTab === 'edit' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
                <div className="xl:col-span-4 space-y-6">
                    <div className="bg-gray-900/50 border border-cyan-900/40 rounded-2xl p-1 backdrop-blur-sm">
                        <div
                            onDragEnter={(e) => { e.preventDefault(); setEditDragging(true); }}
                            onDragOver={(e) => { e.preventDefault(); setEditDragging(true); }}
                            onDragLeave={(e) => { e.preventDefault(); setEditDragging(false); }}
                            onDrop={onEditDrop}
                            className={`
                                flex flex-col items-center justify-center w-full min-h-36
                                border-2 border-dashed rounded-xl transition-all duration-300
                                ${editDragging ? 'border-cyan-400 bg-cyan-500/15' : editFiles.length ? 'border-cyan-500/50 bg-cyan-500/5' : 'border-gray-700 hover:border-cyan-500/30 hover:bg-gray-800/50'}
                            `}
                        >
                            <label className="flex flex-col items-center justify-center w-full cursor-pointer py-6 px-4 text-center">
                                <Scissors className="w-10 h-10 text-cyan-400 mb-3" />
                                <p className="mb-1 text-sm text-gray-300">
                                    <span className="font-semibold">Drop long videos</span> or click to browse
                                </p>
                                <p className="text-xs text-gray-600 font-mono">Drop/click = browser (không biết ổ D:). Nút dưới = Windows dialog, tự lấy thư mục nguồn.</p>
                                <input
                                    ref={editInputRef}
                                    type="file"
                                    className="hidden"
                                    accept="video/*"
                                    multiple
                                    onChange={handleEditFileChange}
                                />
                            </label>
                            <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void pickEditFromPc(); }}
                                className="mb-2 px-3 py-1.5 rounded-lg text-[11px] font-mono border border-cyan-700 bg-cyan-950/50 text-cyan-300 hover:bg-cyan-900/50"
                            >
                                Add from PC — auto source folder
                            </button>
                            <label className="mb-4 px-3 py-1.5 rounded-lg text-[11px] font-mono border border-amber-800 bg-amber-950/40 text-amber-200 cursor-pointer">
                                {editReplayLogName ? `Log: ${editReplayLogName}` : 'Chọn log .txt để lấy timestamp part lỗi'}
                                <input
                                    type="file"
                                    accept=".txt,text/plain"
                                    className="hidden"
                                    onChange={(event) => {
                                        const file = event.target.files?.[0];
                                        if (!file) return;
                                        file.text().then((text) => {
                                            setEditReplayLogText(text);
                                            setEditReplayLogName(file.name);
                                            addLog(`[EDIT] Đã đọc log ${file.name} để tìm part fallback`);
                                        }).catch(() => addLog('[EDIT] Không đọc được file log'));
                                    }}
                                />
                            </label>
                        </div>
                        {editFiles.length > 0 && (
                            <ul className="mt-1 divide-y divide-gray-800/80 max-h-56 overflow-y-auto">
                                {editFiles.map((clip, i) => (
                                    <li
                                        key={clip.id}
                                        draggable={editRenamingId !== clip.id}
                                        onDragStart={(e) => {
                                            e.stopPropagation();
                                            if (editRenamingId === clip.id) { e.preventDefault(); return; }
                                            editDragFromRef.current = i;
                                            e.dataTransfer.effectAllowed = 'move';
                                        }}
                                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const from = editDragFromRef.current;
                                            if (from == null) return;
                                            moveEditFile(from, i);
                                            editDragFromRef.current = null;
                                        }}
                                        className="flex flex-col gap-1 px-3 py-2 text-sm cursor-grab active:cursor-grabbing"
                                    >
                                    <div className="flex items-center gap-2 w-full">
                                        <GripVertical className="w-4 h-4 text-gray-600 shrink-0" />
                                        <span className="text-[10px] font-mono text-cyan-400 w-5 shrink-0">#{i + 1}</span>
                                        <FileVideo className="w-4 h-4 text-cyan-400 shrink-0" />
                                        {editRenamingId === clip.id ? (
                                            <input
                                                autoFocus
                                                defaultValue={clip.name}
                                                className="flex-1 min-w-0 bg-gray-950 border border-cyan-500 rounded px-2 py-1 text-sm text-gray-100 outline-none"
                                                onClick={(e) => e.stopPropagation()}
                                                onMouseDown={(e) => e.stopPropagation()}
                                                onBlur={(e) => {
                                                    renameEditQueued(clip.id, e.target.value);
                                                    setEditRenamingId(null);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        renameEditQueued(clip.id, (e.target as HTMLInputElement).value);
                                                        setEditRenamingId(null);
                                                    }
                                                    if (e.key === 'Escape') setEditRenamingId(null);
                                                }}
                                            />
                                        ) : (
                                            <button
                                                type="button"
                                                className="truncate text-gray-200 flex-1 text-left min-w-0"
                                                title="Click to rename"
                                                onClick={() => setEditRenamingId(clip.id)}
                                            >
                                                {clip.name}
                                            </button>
                                        )}
                                        <span className="text-[10px] font-mono text-gray-500 shrink-0">{formatBytes(clip.fileSize || clip.file.size)}</span>
                                        <button
                                            type="button"
                                            onClick={() => pickEditClipFolder(clip.id)}
                                            className={`flex items-center gap-1 max-w-[7.5rem] px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${
                                                clip.outFolder
                                                    ? 'text-cyan-300 bg-cyan-950/60 border border-cyan-800 hover:bg-cyan-900/50'
                                                    : 'text-gray-500 hover:text-cyan-300 hover:bg-gray-800'
                                            }`}
                                            title={clip.outFolder
                                                ? `Cuts auto-save to ${clip.outFolder}`
                                                : 'Chọn thư mục — 6 clip cắt xong tự lưu vào đây'}
                                        >
                                            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                                            <span className="truncate">{clip.outFolder ? folderLabel(clip.outFolder) : 'folder'}</span>
                                        </button>
                                        {clip.outFolder && (
                                            <button
                                                type="button"
                                                onClick={() => clearEditClipFolder(clip.id)}
                                                className="p-1 rounded hover:bg-gray-800 text-gray-600 hover:text-amber-300"
                                                title="Bỏ thư mục — cắt xong chờ Save thủ công"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        )}
                                        <button type="button" onClick={() => setEditRenamingId(clip.id)} className="p-1 rounded hover:bg-gray-800 text-gray-500 hover:text-cyan-300" title="Rename">
                                            <Pencil className="w-4 h-4" />
                                        </button>
                                        <button type="button" onClick={() => removeEditFile(i)} className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400" title="Remove">
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                        {(() => {
                                            const hits = editReplayHits[clip.originalName || clip.name] || [];
                                            if (!editReplayLogText || !hits.length) return null;
                                            return (
                                                <button
                                                    type="button"
                                                    disabled={editBusy || !clip.localPath}
                                                    onClick={(event) => { event.stopPropagation(); void replayLoggedFailures(clip); }}
                                                    className="self-start text-[10px] font-bold px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-gray-950"
                                                    title={clip.localPath ? hits.map((part) => `Part ${part.partIndex} ${part.start}–${part.end}s`).join(', ') : 'Dùng Add from PC để có đường dẫn nguồn'}
                                                >
                                                    Chỉ xử lý {hits.length} part lỗi
                                                </button>
                                            );
                                        })()}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {editFiles.some((clip) => (editReplayHits[clip.originalName || clip.name] || []).length > 0) && (
                            <button
                                type="button"
                                disabled={editBusy}
                                onClick={() => void replayAllLoggedFailures()}
                                className="mx-3 mb-2 w-[calc(100%-1.5rem)] py-2.5 rounded-xl text-sm font-bold bg-amber-500 text-gray-950 disabled:opacity-40"
                            >
                                Start part lỗi của mọi video
                            </button>
                        )}
                        {editFiles.length > 0 && (
                            <p className="px-3 pb-2 text-[11px] text-gray-500">
                                Mỗi video bấm <span className="text-cyan-400/80">folder</span> để chọn thư mục riêng (video 1 → A, video 2 → B). Cắt xong clip nhỏ tự lưu. Không chọn thì không tự save — đợi bạn Save.
                            </p>
                        )}
                    </div>

                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 space-y-5 shadow-lg">
                        <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
                            <Settings2 className="w-5 h-5 text-gray-400" />
                            <h3 className="font-semibold text-gray-200">Gemini + cut</h3>
                        </div>

                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <label className="text-xs font-mono text-gray-400">PROMPT KỊCH BẢN — Gemini xem video rồi dựng + đặt tiêu đề</label>
                                <button
                                    type="button"
                                    disabled={editBusy}
                                    onClick={() => setEditPrompt(DEFAULT_EDIT_PROMPT)}
                                    className="text-[10px] font-mono px-2 py-1 rounded-md border border-cyan-700 text-cyan-300 hover:bg-cyan-900/40 disabled:opacity-40"
                                >
                                    Dán prompt kịch bản
                                </button>
                            </div>
                            <textarea
                                value={editPrompt}
                                onChange={(e) => setEditPrompt(e.target.value)}
                                disabled={editBusy}
                                rows={8}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-cyan-500 focus:border-cyan-500 p-3 outline-none disabled:opacity-50"
                                placeholder="Bấm “Dán prompt kịch bản” — chia đúng 6 tập liền mạch, lấy hết nội dung trừ QC/outro…"
                            />
                            <p className="text-[11px] text-gray-600">Tiêu đề EN + VI tự sinh theo highlight đã ghép, dùng luôn làm tên file (1.Title.mp4).</p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Key className="w-3 h-3" />
                                GOOGLE CLOUD
                            </label>
                            <div className={`text-xs font-mono px-3 py-2 rounded-lg border ${
                                adcInfo?.ok
                                    ? 'text-green-400 bg-green-900/20 border-green-800'
                                    : 'text-amber-300 bg-amber-900/20 border-amber-800'
                            }`}>
                                {adcInfo == null
                                    ? 'Checking ADC…'
                                    : adcInfo.ok
                                        ? `ADC ready · ${adcInfo.project}`
                                        : `ADC missing — ${adcInfo.error || 'run gcloud auth application-default login, then restart start.bat'}`}
                            </div>
                            <p className="text-[10px] text-gray-500 leading-tight">
                                Đã login gcloud thì để trống ô key. Key chỉ cần nếu ADC không có.
                                Key và model được lưu tự động vào file trên máy (uploads/gemini-keys.json) — tắt/mở lại app không phải nhập lại.
                            </p>
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] text-gray-500">Key Gemini, mỗi key một mail</span>
                                <button
                                    type="button"
                                    disabled={(editBusy && !editKeysPaused) || editGeminiAccounts.length >= 20}
                                    onClick={() => setEditGeminiAccounts((rows) => [...rows, { email: '', secret: '' }])}
                                    className="text-[11px] text-cyan-300 border border-cyan-900 rounded px-2 py-1 disabled:opacity-40"
                                >
                                    Thêm key
                                </button>
                            </div>
                            {(['open', 'spent'] as const).map((group) => {
                                const rows = editGeminiAccounts.map((row, index) => ({ row, index })).filter(({ row }) => {
                                    const id = geminiKeyIds[row.secret.trim()];
                                    const mark = id ? geminiKeyQuota[id] : undefined;
                                    const spent = Boolean(mark && mark.until > Date.now() && mark.models.length);
                                    return group === 'spent' ? spent : !spent;
                                });
                                if (!rows.length && group === 'spent') return null;
                                return (
                                    <div key={group} className="space-y-2">
                                        <p className={`text-[11px] font-bold ${group === 'spent' ? 'text-amber-300' : 'text-emerald-300'}`}>
                                            {group === 'spent' ? `Hết request (${rows.length})` : `Còn request (${rows.filter(({ row }) => row.secret.trim()).length})`}
                                        </p>
                                        {rows.map(({ row, index }) => {
                                            const id = geminiKeyIds[row.secret.trim()];
                                            const mark = id ? geminiKeyQuota[id] : undefined;
                                            const spent = Boolean(mark && mark.until > Date.now() && mark.models.length);
                                            const resetLabel = spent
                                                ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23' }).format(mark!.until)
                                                : '';
                                            return (
                                                <div key={`gemini-key-${index}`} className="space-y-1 rounded-lg border border-gray-800 p-2">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="text-[10px] text-gray-500">Key {index + 1}{index === 0 ? ' · gọi trước' : ''}</span>
                                                        <span className={`text-[10px] ${spent ? 'text-amber-300' : mark?.used ? 'text-cyan-300' : 'text-gray-500'}`}>
                                                            {spent ? `Hết đến ${resetLabel}` : mark?.used ? 'Đã dùng, còn request' : 'Chưa dùng'}
                                                        </span>
                                                    </div>
                                                    <input
                                                        type="email"
                                                        value={row.email}
                                                        onChange={(event) => setEditGeminiAccounts((list) => list.map((item, itemIndex) => itemIndex === index ? { ...item, email: event.target.value } : item))}
                                                        disabled={editBusy && !editKeysPaused}
                                                        autoComplete="off"
                                                        placeholder="mail của key này"
                                                        className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2 outline-none disabled:opacity-50"
                                                    />
                                                    <div className="flex gap-2">
                                                        <input
                                                            type="password"
                                                            value={row.secret}
                                                            onChange={(event) => {
                                                                const parts = event.target.value.split(/[\r\n,;]+/).map((part) => part.trim()).filter(Boolean);
                                                                setEditGeminiAccounts((list) => {
                                                                    const next = [...list];
                                                                    if (parts.length <= 1) {
                                                                        next[index] = { ...next[index], secret: event.target.value };
                                                                        return next;
                                                                    }
                                                                    const added = parts.slice(0, 20 - index).map((secret) => ({ email: '', secret }));
                                                                    next.splice(index, 1, ...added);
                                                                    return next.slice(0, 20);
                                                                });
                                                            }}
                                                            disabled={editBusy && !editKeysPaused}
                                                            autoComplete="off"
                                                            placeholder="API key"
                                                            className="min-w-0 flex-1 bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2 outline-none disabled:opacity-50"
                                                        />
                                                        <button
                                                            type="button"
                                                            disabled={editBusy && !editKeysPaused}
                                                            onClick={() => setEditGeminiAccounts((list) => list.length === 1 ? [{ email: '', secret: '' }] : list.filter((_, itemIndex) => itemIndex !== index))}
                                                            className="shrink-0 text-[11px] text-gray-400 border border-gray-700 rounded px-2 disabled:opacity-40"
                                                        >
                                                            Xóa
                                                        </button>
                                                    </div>
                                                    {spent && <p className="text-[10px] text-amber-200/80">{mark!.models.join(', ')}</p>}
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                            <p className="text-[11px] text-gray-600">Điền mail để biết key nào đã thêm. Detail gọi từ key 1 trở xuống. Key nào hết request ngày thì chuyển sang hàng Hết request đến 00:00 giờ Thái Bình Dương. Quá tải không đổi key.</p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">MODEL</label>
                            <select
                                value={editModel}
                                onChange={(e) => setEditModel(e.target.value)}
                                disabled={editBusy}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5 outline-none disabled:opacity-50"
                            >
                                <option value="gemini-3.8-flash">gemini-3.8-flash (Global plan + Detail)</option>
                                <option value="gemini-3.7-flash">gemini-3.7-flash</option>
                                <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                                <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (xem kỹ hơn)</option>
                                <option value="gemini-2.5-flash">gemini-2.5-flash (cũ)</option>
                                <option value="gemini-2.5-pro">gemini-2.5-pro (cũ)</option>
                            </select>
                            <p className="text-[11px] text-gray-600">Global plan (Vertex) dùng model này. Detail qua API key thì theo ô "MODEL DETAIL" bên dưới — log 11 video cho thấy chỉ 3.5-flash-lite là gần như không bao giờ quá tải. Hết request ngày thì dùng key dự phòng cho đúng model đó. TEST dùng gemini-3.1-flash-lite.</p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">MODEL DETAIL (API KEY)</label>
                            <select
                                value={editDetailModelMode}
                                onChange={(e) => setEditDetailModelMode(e.target.value === 'quality' ? 'quality' : e.target.value === 'only' ? 'only' : 'safe')}
                                disabled={editBusy}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5 outline-none disabled:opacity-50"
                            >
                                <option value="safe">An toàn — bắt đầu 3.5-flash-lite (đo được: 41 plan, 0 quá tải)</option>
                                <option value="quality">Chất lượng — thử model trên trước, quá tải thì hạ ngay</option>
                                <option value="only">Chỉ model trên (3.8) — không hạ bậc</option>
                            </select>
                            <p className="text-[11px] text-gray-600">Model nào trả "quá tải" sẽ bị bỏ qua 10 phút cho mọi video (không thử lại từng part). Nhờ vậy chọn "Chất lượng" chỉ tốn ~1 lần gọi lỗi mỗi 10 phút, không còn vòng lặp chờ.</p>
                            <label className="flex items-start gap-2 text-xs text-emerald-200 cursor-pointer leading-tight">
                                <input type="checkbox" checked={editDetailModelAuto} disabled={editBusy} onChange={(e) => setEditDetailModelAuto(e.target.checked)} className="mt-0.5" />
                                <span>
                                    App tự chọn chế độ Detail theo số đo của chính nó (cần ≥12 part mỗi chế độ và lệch ≥5 điểm mới đổi).
                                    Bỏ tick nếu bạn muốn tự chốt.
                                </span>
                            </label>
                            <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-2 space-y-1">
                                <div className="flex items-center gap-2">
                                    <span className="text-[11px] font-mono text-gray-400">CHỦ ĐỀ</span>
                                    <select
                                        value={editTopicPin}
                                        disabled={editBusy}
                                        onChange={(e) => setEditTopicPin(e.target.value)}
                                        className="flex-1 bg-gray-950 border border-gray-700 text-cyan-200 text-[11px] rounded px-2 py-1 outline-none disabled:opacity-50"
                                    >
                                        <option value="">Tự nhận biết (AI xem 3 ảnh rồi chọn hồ sơ)</option>
                                        <option value="cops">Ghim: Cops / bodycam</option>
                                        <option value="animals">Ghim: Động vật</option>
                                        <option value="podcast">Ghim: Podcast / phỏng vấn</option>
                                        <option value="sports">Ghim: Thể thao</option>
                                        <option value="gameplay">Ghim: Game / stream</option>
                                        <option value="reaction">Ghim: Reaction / bình luận</option>
                                        <option value="product">Ghim: Sản phẩm / review</option>
                                        <option value="story">Ghim: Kể chuyện / drama</option>
                                    </select>
                                </div>
                                <p className="text-[11px] text-gray-600 leading-tight">Hồ sơ chủ đề áp cho <b>cả lúc chia part (global plan)</b> lẫn lúc chọn khung từng part (Detail). Không chắc thì dùng luật chung, không đoán bừa.</p>
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">CUT MODE</label>
                            <select
                                value={editMode}
                                onChange={(e) => setEditMode(e.target.value === 'even' ? 'even' : 'ai')}
                                disabled={editBusy}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5 outline-none disabled:opacity-50"
                            >
                                <option value="ai">Gemini xem + nghe + đọc prompt</option>
                                <option value="even">Even split (không cần API)</option>
                            </select>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">EDIT ENCODER</label>
                            <select
                                value={editEncoderMode}
                                onChange={(e) => setEditEncoderMode(e.target.value as typeof editEncoderMode)}
                                disabled={editBusy}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5 outline-none disabled:opacity-50"
                            >
                                <option value="auto">Auto (NVIDIA → Intel → CPU)</option>
                                <option value="nvidia" disabled={!encoderCaps.nvidia}>NVIDIA NVENC{encoderCaps.nvidia ? ' (usable)' : ' — unavailable'}</option>
                                <option value="intel" disabled={!encoderCaps.intel}>Intel Quick Sync{encoderCaps.intel ? '' : ' — unavailable'}</option>
                                <option value="cpu">CPU libx264</option>
                            </select>
                            <p className="text-[10px] text-gray-500 leading-tight">
                                Áp dụng cho cắt, proxy Gemini, fade, TikTok Pad và Mixed 9:16. Filter vẫn chạy CPU; nếu GPU lỗi app tự chuyển sang CPU.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">KIỂU KHUNG HÌNH</label>
                            <select
                                value={editFramingStyle}
                                disabled={editBusy}
                                onChange={(e) => setEditFramingStyle(e.target.value === 'sml' ? 'sml' : 'focus')}
                                className="w-full bg-gray-950 border border-gray-700 text-cyan-200 text-sm rounded-lg p-2.5 outline-none disabled:opacity-50"
                            >
                                <option value="focus">Tiêu điểm 9:16 — bám chủ thể, không viền (mặc định)</option>
                                <option value="sml">SML cũ — contain/fill (chỉ khi làm clip SML)</option>
                            </select>
                            {editFramingStyle === 'focus' ? (
                                <p className="text-[11px] text-gray-500 leading-tight">
                                    AI tự chia số part, mỗi part dài hơn 1 phút và không có mức tối đa; đoạn không đáng xem bị bỏ.
                                    Khung luôn kín 9:16 bám chủ thể chính. Có người/sự kiện thứ hai đáng xem thì AI chia đôi màn hình
                                    trên/dưới, mỗi bên một camera. Không còn letterbox và không còn cửa sổ nhỏ ở góc. Mỗi part được AI xem lại một lần
                                    (Detail từng part) để chia khung theo từng cú máy.
                                </p>
                            ) : (
                                <p className="text-[11px] text-amber-300/80 leading-tight">
                                    Đường SML giữ nguyên prompt SML và cách contain/fill cũ.
                                </p>
                            )}
                        </div>

                        {editFramingStyle === 'focus' ? (
                        <p className="text-[11px] text-gray-600">Số part do AI quyết định — không khóa số tập.</p>
                        ) : (<>
                        {!editAutoParts && (
                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Layers className="w-3 h-3" />
                                SỐ TẬP CỐ ĐỊNH
                            </label>
                            <div className="flex items-center gap-3">
                                <input type="range" min={2} max={12} value={editSplit} disabled={editBusy} onChange={(e) => setEditSplit(Number(e.target.value))} className="flex-1 accent-cyan-500" />
                                <span className="w-16 text-right font-mono text-cyan-300 text-sm">{editSplit}</span>
                            </div>
                        </div>
                        )}

                        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                            <input type="checkbox" checked={editAutoParts} disabled={editBusy} onChange={(e) => setEditAutoParts(e.target.checked)} />
                            Auto số tập — bỏ tick = khóa {editSplit} tập (mặc định 6)
                        </label>
                        </>)}

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">XUẤT TẬP (số file)</label>
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] text-gray-500">Từ</span>
                                <input
                                    type="number"
                                    min={1}
                                    max={24}
                                    value={editPartFrom}
                                    disabled={editBusy}
                                    onChange={(e) => setEditPartFrom(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
                                    className="w-16 bg-gray-950 border border-gray-700 text-cyan-300 text-sm rounded-lg p-2 outline-none disabled:opacity-50"
                                />
                                <span className="text-[11px] text-gray-500">đến</span>
                                <input
                                    type="number"
                                    min={0}
                                    max={24}
                                    value={editPartTo || ''}
                                    placeholder="hết"
                                    disabled={editBusy}
                                    onChange={(e) => {
                                        const n = Number(e.target.value);
                                        setEditPartTo(e.target.value === '' || !Number.isFinite(n) ? 0 : Math.max(0, Math.min(24, n)));
                                    }}
                                    className="w-16 bg-gray-950 border border-gray-700 text-cyan-300 text-sm rounded-lg p-2 outline-none disabled:opacity-50"
                                />
                            </div>
                            <p className="text-[11px] text-gray-600">
                                {editFramingStyle === 'focus' ? 'AI chia đủ số part cần thiết' : `Gemini vẫn chia đủ ${editAutoParts ? 'N' : editSplit} tập`}. Chỉ cắt + đặt tên các tập trong khoảng (vd 4–6 → 4.name.mp4). Để trống “đến” = tới tập cuối.
                            </p>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400 flex items-center gap-2">
                                <Clock className="w-3 h-3" />
                                MIN DURATION / PART
                            </label>
                            <div className="flex items-center gap-3">
                                <input type="range" min={60} max={180} step={5} value={Math.max(60, editMinSec)} disabled={editBusy} onChange={(e) => setEditMinSec(Math.max(60, Number(e.target.value)))} className="flex-1 accent-cyan-500" />
                                <span className="w-16 text-right font-mono text-cyan-300 text-sm">{Math.max(60, editMinSec)}s</span>
                            </div>
                        </div>

                        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                            <input type="checkbox" checked={editFadeFx} disabled={editBusy} onChange={(e) => setEditFadeFx(e.target.checked)} />
                            Fade in/out nhẹ mỗi tập (không zoom, không đổi tốc độ)
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                            <input type="checkbox" checked={editAutoCut} disabled={editBusy} onChange={(e) => setEditAutoCut(e.target.checked)} />
                            Cắt FFmpeg ngay sau khi Gemini trả kế hoạch
                        </label>
                        {editFramingStyle === 'sml' && (<>
                        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                            <input type="checkbox" checked={editTikTokPad} disabled={editBusy} onChange={(e) => setEditTikTokPad(e.target.checked)} />
                            Đổi sang TikTok 1080×1920 (pad, viền mờ, giữ hết nội dung)
                        </label>
                        <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={editTikTokMix}
                                disabled={editBusy}
                                onChange={(e) => {
                                    setEditTikTokMix(e.target.checked);
                                    if (e.target.checked) setEditTikTokPad(true);
                                }}
                            />
                            Mixed 9:16 — STT nghe tiếng, fill cắt đúng người nói

                        </label>
                        <p className="text-[11px] text-gray-600 -mt-1">
                            Mixed: STT (thêm API) cắt fill đúng phoneme người đang nói. 3+ rối / chip / đen = wide. Clip đã 9:16 thì bỏ qua.
                        </p>
                        {editTikTokMix && (
                            <label className="flex items-center gap-2 text-xs text-cyan-300 cursor-pointer">
                                <input type="checkbox" checked={editSpeechFraming} disabled={editBusy} onChange={(e) => setEditSpeechFraming(e.target.checked)} />
                                Khung thoại — bỏ Detail từng part. Một lần Vertex chia tập, fill/contain theo người đang nói
                            </label>
                        )}
                        <label className="flex items-center gap-2 text-xs text-amber-200 cursor-pointer">
                            <input type="checkbox" checked={editGeneralVideo} disabled={editBusy} onChange={(e) => {
                                setEditGeneralVideo(e.target.checked);
                                if (e.target.checked) setEditTikTokMix(true);
                            }} />
                            Video chung (đường SML) — highlight mọi chủ đề, mỗi part trên 1 phút, vẫn dùng khung contain/fill cũ.
                        </label>
                        </>)}
                        <label className="flex items-center gap-2 text-xs text-amber-300 cursor-pointer">
                            <input type="checkbox" checked={editTest1m} disabled={editBusy} onChange={(e) => setEditTest1m(e.target.checked)} />
                            TEST đoạn ngắn
                        </label>
                        {editTest1m && (
                            <div className="ml-5 rounded-lg border border-amber-800/50 bg-amber-950/20 p-2 space-y-2 text-[11px]">
                                <div className="flex flex-wrap items-center gap-3">
                                    <label className="flex items-center gap-1.5 text-gray-300">
                                        Độ dài
                                        <select value={editTestSeconds} disabled={editBusy} onChange={(e) => setEditTestSeconds(Number(e.target.value) === 30 ? 30 : 60)} className="bg-gray-900 border border-gray-700 rounded px-2 py-1">
                                            <option value={30}>30 giây</option>
                                            <option value={60}>60 giây</option>
                                        </select>
                                    </label>
                                    <label className="flex items-center gap-1.5 text-cyan-300 cursor-pointer">
                                        <input type="checkbox" checked={editLocalDetailTest} disabled={editBusy} onChange={(e) => setEditLocalDetailTest(e.target.checked)} />
                                        Detail Local — Qwen3-VL 2B
                                    </label>
                                </div>
                                {editLocalDetailTest ? (
                                    <div className="space-y-1 text-gray-400">
                                        <p>Không gọi Vertex/Gemini/Google STT. Lần chạy sau tự dùng lại đúng đoạn đã lưu.</p>
                                        <label className="flex items-center gap-1.5 text-amber-300 cursor-pointer">
                                            <input type="checkbox" checked={editLocalNewRange} disabled={editBusy} onChange={(e) => setEditLocalNewRange(e.target.checked)} />
                                            Đổi sang đoạn ngẫu nhiên mới ở lần chạy tới
                                        </label>
                                    </div>
                                ) : <p className="text-gray-500">Gemini TEST hiện tại; vẫn dùng Listen + STT như trước.</p>}
                            </div>
                        )}
                    </div>

                    {editKeysPaused && (
                        <div className="space-y-2 rounded-xl border border-amber-700 bg-amber-950/40 p-3">
                            <p className="text-sm text-amber-200">Mọi key đã hết request ngày. Dán key mới vào ô Key dự phòng, rồi bấm Tiếp tục. Các part đã cắt vẫn giữ nguyên.</p>
                            <button
                                type="button"
                                onClick={resumeEditWithKeys}
                                className="w-full py-3 rounded-xl font-bold bg-amber-500 text-gray-950"
                            >
                                Tiếp tục với key mới
                            </button>
                        </div>
                    )}

                    {editBusy ? (
                        <button
                            type="button"
                            onClick={cancelEdit}
                            className="w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg bg-red-900/40 text-red-300 border border-red-500/40 hover:bg-red-800/50"
                        >
                            <Square className="w-5 h-5 fill-current" />
                            STOP EDIT ({editPhase === 'watching' ? `watch ${editWatchPct.toFixed(0)}%` : `${editProgress.toFixed(0)}%`})
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={startEdit}
                            disabled={!editFiles.length}
                            className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg transition-all duration-300 ${
                                !editFiles.length
                                    ? 'bg-gray-800/50 text-gray-600 cursor-not-allowed border border-gray-800'
                                    : 'bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white border border-cyan-400/50 shadow-[0_0_20px_rgba(8,145,178,0.35)]'
                            }`}
                        >
                            <Scissors className="w-5 h-5" />
                            {editMode === 'ai'
                                ? (editTest1m && editLocalDetailTest ? 'LOCAL DETAIL TEST & RENDER' : 'GEMINI WATCH & CUT')
                                : 'EVEN SPLIT CUT'}
                            {editFiles.length ? ` (${editFiles.length})` : ''}
                        </button>
                    )}

                    {editRunTimes.length > 0 && (
                        <div className="space-y-1 rounded-xl border border-cyan-900 bg-gray-900 p-3 text-sm">
                            <p className="font-semibold text-cyan-300">Thời gian từng video</p>
                            {editRunTimes.map((run) => <p key={run.ordinal} className="text-gray-300">Video {run.ordinal}: {run.elapsed} · {run.status} · {run.name}</p>)}
                        </div>
                    )}

                    {editBusy && (
                        <div className="space-y-3 bg-gray-900/50 p-4 rounded-xl border border-gray-800">
                            {editPhase === 'watching' && (
                                <div className="space-y-1.5">
                                    <div className="flex justify-between text-xs font-mono text-amber-300">
                                        <span>GEMINI WATCHING</span>
                                        <span>{editWatchPct.toFixed(0)}%</span>
                                    </div>
                                    <div className="w-full bg-gray-950 rounded-full h-3 overflow-hidden border border-amber-800/60">
                                        <div className="bg-gradient-to-r from-amber-500 to-orange-400 h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(2, editWatchPct)}%` }} />
                                    </div>
                                </div>
                            )}
                            {editPhase === 'cut' && (
                                <p className="text-[11px] font-mono text-cyan-300">Đang cắt / pad TikTok</p>
                            )}
                            <div className="flex justify-between text-xs font-mono text-cyan-400">
                                <span>{editPhase === 'watching' ? 'OVERALL' : 'EDIT PROGRESS'}</span>
                                <span>{editProgress.toFixed(0)}%</span>
                            </div>
                            <div className="w-full bg-gray-950 rounded-full h-2.5 overflow-hidden border border-gray-800">
                                <div className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full rounded-full transition-all duration-500" style={{ width: `${editProgress}%` }} />
                            </div>
                        </div>
                    )}


                    <div className="flex flex-col sm:flex-row gap-2">
                        {renderHandoffSelect()}
                        <button
                            type="button"
                            onClick={sendSourcesToUnique}
                            disabled={!editFiles.length}
                            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm border border-purple-500/40 text-purple-300 hover:bg-purple-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <ArrowRight className="w-4 h-4" />
                            Send sources to Unique queue
                        </button>
                    </div>
                </div>

                <div className="xl:col-span-8 space-y-6">
                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden flex flex-col shadow-lg">
                        <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Terminal className="w-4 h-4 text-cyan-400" />
                                <span className="text-xs font-mono text-gray-400">ghostforge_edit.log</span>
                            </div>
                        </div>
                        <div className="p-2">
                            <LogViewer
                                logs={logsByChannel.edit}
                                getExportLogs={() => fullLogsRef.current.edit}
                                filePrefix="edit"
                                emptyText="Edit đang chờ."
                                onClear={() => clearLogChannel('edit')}
                            />
                        </div>
                    </div>

                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 shadow-lg">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                            <h3 className="text-lg font-bold text-gray-100 flex items-center gap-2">
                                <Layers className="w-5 h-5 text-cyan-400" />
                                Cut list ({editSegments.length})
                            </h3>
                            <div className="flex flex-wrap gap-2">
                                {editSegments.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const header = 'Nguồn\tTập\tTitle EN\tTiếng Việt\tStart\tEnd\tDuration';
                                            const rows = editSegments.map((s) =>
                                                `${s.sourceName}\t${s.partIndex}\t${s.title || s.name}\t${s.titleVi || ''}\t${s.script || ''}\t${fmtTs(s.start)}\t${fmtTs(s.end)}\t${s.dur != null ? s.dur : fmtDur(s.start, s.end)}`
                                            );
                                            void navigator.clipboard.writeText([header, ...rows].join('\n'));
                                            addLog('[EDIT] Copied cut table.');
                                        }}
                                        className="text-xs font-mono px-3 py-2 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800"
                                    >
                                        Copy table
                                    </button>
                                )}
                                {editSegments.some((s) => s.status === 'cut') && (
                                    <>
                                        <button
                                            type="button"
                                            onClick={() => pickSaveFolder('edit')}
                                            className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-gray-700 bg-gray-950 text-gray-300 hover:border-purple-500 hover:text-purple-300"
                                        >
                                            <FolderOpen className="w-4 h-4" />
                                            {saveFolderName ? `Shared: ${saveFolderName}` : 'Choose shared folder'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => saveEditItems(editSelectedIds)}
                                            disabled={editSelectedIds.length === 0}
                                            className="flex items-center gap-1 text-xs font-mono px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:bg-gray-800 disabled:text-gray-600 text-white"
                                        >
                                            <Save className="w-3.5 h-3.5" />
                                            Save selected
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => saveEditItems()}
                                            className="flex items-center gap-1 text-xs font-mono px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white border border-gray-600"
                                        >
                                            Save all to shared
                                        </button>
                                        {renderHandoffSelect()}
                                        <button
                                            type="button"
                                            onClick={() => void sendCutsToUnique()}
                                            className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white"
                                        >
                                            <ArrowRight className="w-4 h-4" />
                                            Send selected to Unique
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                        {editSummary && <p className="text-xs text-cyan-300/90 mb-3">{editSummary}</p>}
                        <p className={`text-[11px] mb-3 ${osSavePath ? 'text-green-400' : 'text-amber-400'}`}>
                            {osSavePath
                                ? `Shared folder: ${osSavePath}`
                                : 'Choose shared folder for Save all. Each clip can Save to… a different folder.'}
                        </p>
                        {saveNotice && (
                            <div className="mb-3 px-3 py-2 rounded-lg bg-green-500/15 border border-green-500/40 text-green-300 text-sm font-medium">
                                {saveNotice}
                            </div>
                        )}
                        {(replayCatalog.length > 0 || partTestHistory.length > 0) && (
                            <div className="mb-4 rounded-xl border border-cyan-900/70 bg-cyan-950/20 p-3">
                                <div className="flex items-center justify-between gap-2 mb-2">
                                    <div className="text-xs font-bold text-cyan-300">Part đã render</div>
                                    <div className="text-[10px] text-gray-500">{replayView.ready.length} video</div>
                                </div>
                                {replayCatalog.length > 0 && (
                                    <input
                                        value={replayQuery}
                                        onChange={(event) => setReplayQuery(event.target.value)}
                                        placeholder="Tìm video hoặc tên part"
                                        className="w-full mb-2 px-2 py-1.5 rounded bg-gray-950 border border-gray-700 text-xs text-gray-100 placeholder:text-gray-600"
                                    />
                                )}
                                <div className="max-h-72 overflow-y-auto space-y-1">
                                    {replayView.ready.map(({ video, parts }) => {
                                        const open = replayOpenPath === video.sourcePath;
                                        const chosen = parts.filter((part) => replaySelected.includes(part.id));
                                        return (
                                            <div key={video.sourcePath} className="rounded-lg border border-cyan-900/50 bg-gray-950/40">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setReplayOpenPath(open ? null : video.sourcePath);
                                                        setReplaySelected([]);
                                                    }}
                                                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
                                                >
                                                    <span className="text-cyan-400 text-[10px] w-3">{open ? '▾' : '▸'}</span>
                                                    <span className="text-xs text-gray-100 truncate flex-1" title={replayVideoTitle(video.sourceName)}>{replayVideoTitle(video.sourceName)}</span>
                                                    <span className="text-[10px] text-gray-500 shrink-0">{replayQuery.trim() && parts.length !== video.parts.length ? `${parts.length}/${video.parts.length} khớp` : `${video.parts.length} part`}{replayDay(video.newestAt) ? ` · ${replayDay(video.newestAt)}` : ''}</span>
                                                </button>
                                                {open && (
                                                    <div className="border-t border-cyan-900/40 px-2 py-1">
                                                        {chosen.length > 0 && (
                                                            <button
                                                                type="button"
                                                                onClick={() => void runReplaySelected(video, parts)}
                                                                disabled={editBusy}
                                                                className="mb-1 text-[10px] font-bold px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white"
                                                            >
                                                                Chạy {chosen.length} part đã chọn
                                                            </button>
                                                        )}
                                                        <div className="max-h-52 overflow-y-auto">
                                                            {parts.map((part) => (
                                                                <div key={part.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 min-w-0">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={replaySelected.includes(part.id)}
                                                                        onChange={() => setReplaySelected((prev) => prev.includes(part.id) ? prev.filter((id) => id !== part.id) : [...prev, part.id])}
                                                                        disabled={editBusy}
                                                                        className="accent-cyan-500"
                                                                    />
                                                                    <span className="text-[10px] font-mono text-gray-500 w-6 shrink-0">{part.partIndex}</span>
                                                                    <span className="text-[11px] text-gray-200 truncate flex-1" title={replayPartTitle(part.partName, part.partIndex)}>{replayPartTitle(part.partName, part.partIndex)}</span>
                                                                    <span className="text-[10px] font-mono text-gray-500 shrink-0">{fmtTs(part.start)}–{fmtTs(part.end)}</span>
                                                                    {part.score != null && <span className="text-[10px] font-mono text-cyan-300 w-8 text-right shrink-0">{part.score}</span>}
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void testEditPart(replaySegment(video, part))}
                                                                        disabled={editBusy}
                                                                        className="text-[10px] font-bold px-2 py-0.5 rounded bg-cyan-800 hover:bg-cyan-600 disabled:opacity-40 text-white shrink-0"
                                                                    >
                                                                        {partTestBusyId === part.id ? 'Đang test…' : 'Test lại'}
                                                                    </button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {replayCatalog.length > 0 && replayView.ready.length === 0 && (
                                        <p className="text-[11px] text-gray-500 px-1 py-2">Không có video khớp.</p>
                                    )}
                                </div>
                                {replayView.missing.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setReplayShowMissing((open) => !open)}
                                        className="mt-2 text-[10px] text-gray-500 hover:text-gray-300"
                                    >
                                        {replayShowMissing ? '▾' : '▸'} {replayView.missing.length} video không còn file nguồn
                                    </button>
                                )}
                                {replayShowMissing && (
                                    <div className="mt-1 max-h-24 overflow-y-auto">
                                        {replayView.missing.map(({ video }) => (
                                            <div key={video.sourcePath} className="text-[10px] text-gray-600 truncate py-0.5" title={replayVideoTitle(video.sourceName)}>
                                                {replayVideoTitle(video.sourceName)}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {replayCatalog.length === 0 && partTestHistory.length > 0 && (
                                    <div className="flex flex-wrap gap-2 mt-1">
                                        {partTestHistory.map((part) => (
                                            <button
                                                key={part.id}
                                                type="button"
                                                onClick={() => void testEditPart(part)}
                                                disabled={editBusy || !part.sourceAvailable}
                                                className="text-[11px] font-bold px-3 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-white"
                                                title={part.sourceAvailable ? `Test lại ${part.title || part.name}` : 'File nguồn gốc không còn tồn tại'}
                                            >
                                                Test lại Part {part.partIndex}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        {editSegments.length === 0 ? (
                            <p className="text-sm text-gray-500">
                                Thả video vào, viết yêu cầu cắt, đăng nhập ADC (hoặc dán API key), bấm GEMINI WATCH &amp; CUT.
                            </p>
                        ) : (
                            <>
                                <div className="flex items-center gap-2 mb-3">
                                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={editSegments.length > 0 && editSelectedIds.length === editSegments.length}
                                            onChange={(e) => setEditSelectedIds(e.target.checked ? editSegments.map((s) => s.id) : [])}
                                        />
                                        Select all
                                    </label>
                                    <span className="text-[11px] font-mono text-gray-500">{editSelectedIds.length} selected</span>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const ids = editSegments.map((row) => row.jobId).filter((id): id is string => Boolean(id));
                                            setEditSegments([]);
                                            setEditSummary('');
                                            setEditSelectedIds([]);
                                            for (const id of ids) {
                                                void fetch(`${BACKEND_URL}/api/edit/held/${id}`, { method: 'DELETE' }).catch(() => {});
                                            }
                                        }}
                                        className="ml-auto text-[11px] text-red-400 hover:text-red-300"
                                    >
                                        Clear
                                    </button>
                                </div>
                                <div className="rounded-xl border border-gray-800 overflow-hidden">
                                    <table className="w-full table-fixed text-left text-sm">
                                        <colgroup>
                                            <col className="w-8" />
                                            <col className="w-8" />
                                            <col />
                                            <col />
                                            <col className="w-[4.5rem]" />
                                            <col className="w-[4.5rem]" />
                                            <col className="w-[4.5rem]" />
                                            <col className="w-24" />
                                            <col className="w-[9.5rem]" />
                                        </colgroup>
                                        <thead className="bg-gray-950 text-[10px] font-mono uppercase tracking-wide text-gray-500">
                                            <tr>
                                                <th className="px-2 py-2" />
                                                <th className="px-1 py-2">#</th>
                                                <th className="px-2 py-2">Title EN</th>
                                                <th className="px-2 py-2">Tiếng Việt</th>
                                                <th className="px-1 py-2">Start</th>
                                                <th className="px-1 py-2">End</th>
                                                <th className="px-1 py-2">Dur</th>
                                                <th className="px-2 py-2">Status</th>
                                                <th className="px-2 py-2" />
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-800">
                                            {(() => {
                                                const groups: { sourceId: string; sourceName: string; items: EditSegment[] }[] = [];
                                                for (const seg of editSegments) {
                                                    let g = groups.find((x) => x.sourceId === seg.sourceId);
                                                    if (!g) {
                                                        g = { sourceId: seg.sourceId, sourceName: seg.sourceName, items: [] };
                                                        groups.push(g);
                                                    }
                                                    g.items.push(seg);
                                                }
                                                return groups.flatMap((g) => {
                                                    const groupIds = g.items.map((s) => s.id);
                                                    const allSelected = groupIds.length > 0 && groupIds.every((id) => editSelectedIds.includes(id));
                                                    const selectedCut = g.items.filter((s) => editSelectedIds.includes(s.id) && s.status === 'cut' && s.jobId);
                                                    const groupNote = editGroupSave[g.sourceId];
                                                    const groupBusy = editGroupBusyId === g.sourceId;
                                                    return [
                                                    <tr key={`src-${g.sourceId}`} className="bg-cyan-950/40">
                                                        <td colSpan={9} className="px-3 py-2">
                                                            <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
                                                                <span className="text-[11px] font-mono text-cyan-300 min-w-0">
                                                                    Nguồn: <span className="text-white font-semibold break-all">{g.sourceName}</span>
                                                                    <span className="text-gray-500"> · {g.items.length} tập</span>
                                                                </span>
                                                                <label className="flex items-center gap-1.5 text-[10px] text-gray-200 cursor-pointer shrink-0">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={allSelected}
                                                                        onChange={(event) => {
                                                                            const on = event.target.checked;
                                                                            setEditSelectedIds((prev) => {
                                                                                const rest = prev.filter((id) => !groupIds.includes(id));
                                                                                return on ? [...rest, ...groupIds] : rest;
                                                                            });
                                                                        }}
                                                                    />
                                                                    Chọn tất cả
                                                                </label>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void saveEditGroupToFolder(g.sourceId, g.sourceName, selectedCut.map((s) => s.id))}
                                                                    disabled={selectedCut.length === 0 || groupBusy}
                                                                    className="text-[10px] font-bold px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:bg-gray-800 disabled:text-gray-600 text-white shrink-0 max-w-full"
                                                                    title="Chọn thư mục cha. App tạo một thư mục con mang tên video bên trong đó, chép các part đang chọn, rồi mở thư mục đó."
                                                                >
                                                                    {groupBusy ? 'Đang lưu…' : (selectedCut.length ? `Lưu ${selectedCut.length} part` : 'Lưu riêng')}
                                                                </button>
                                                                {groupNote ? (
                                                                    <div className="w-full basis-full text-[11px] leading-snug break-all">
                                                                        <div className="text-cyan-200">Thư mục: {groupNote.folder}</div>
                                                                        {groupNote.saved > 0 ? (
                                                                            <div className="text-green-300">Đã chép {groupNote.saved}/{groupNote.total} part</div>
                                                                        ) : null}
                                                                        {groupNote.error ? (
                                                                            <div className="text-red-300">{groupNote.error}</div>
                                                                        ) : null}
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        </td>
                                                    </tr>,
                                                    ...g.items.map((seg) => (
                                                <tr key={seg.id} className="hover:bg-gray-800/40">
                                                    <td className="px-2 py-2 align-top">
                                                        <input
                                                            type="checkbox"
                                                            checked={editSelectedIds.includes(seg.id)}
                                                            onChange={() => setEditSelectedIds((prev) =>
                                                                prev.includes(seg.id) ? prev.filter((id) => id !== seg.id) : [...prev, seg.id]
                                                            )}
                                                        />
                                                    </td>
                                                    <td className="px-1 py-2 align-top font-mono text-cyan-400 text-xs">{seg.partIndex}</td>
                                                    <td className="px-2 py-2 align-top text-gray-100 font-medium leading-snug break-words">
                                                        {seg.title || seg.name}
                                                        {seg.script ? <div className="text-[10px] font-mono text-amber-400/90 mt-1 leading-snug">{seg.script}</div> : null}
                                                        {seg.qa ? (
                                                            <div className={`text-[10px] font-mono mt-1 leading-snug ${
                                                                seg.qa.score >= 85 ? 'text-emerald-300'
                                                                    : seg.qa.score >= 70 ? 'text-cyan-300'
                                                                        : seg.qa.score >= 50 ? 'text-amber-300' : 'text-red-300'
                                                            }`}>
                                                                QA {seg.qa.score}/100{seg.qa.warnings.length ? ` · ${seg.qa.warnings.join(' · ')}` : ' · không thấy vấn đề'}
                                                            </div>
                                                        ) : null}
                                                    </td>
                                                    <td className="px-2 py-2 align-top text-gray-400 leading-snug break-words">{seg.titleVi || '—'}</td>
                                                    <td className="px-1 py-2 align-top font-mono text-[11px] text-gray-300">{fmtTs(seg.start)}</td>
                                                    <td className="px-1 py-2 align-top font-mono text-[11px] text-gray-300">{fmtTs(seg.end)}</td>
                                                    <td className="px-1 py-2 align-top font-mono text-[11px] text-amber-300">{seg.dur != null ? `${seg.dur.toFixed(1)}s` : fmtDur(seg.start, seg.end)}</td>
                                                    <td className="px-2 py-2 align-top min-w-0">
                                                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded inline-block ${
                                                            seg.saved ? 'bg-green-500/20 text-green-400'
                                                            : seg.status === 'cut' ? 'bg-green-500/15 text-green-400'
                                                            : seg.status === 'sent' ? 'bg-purple-500/15 text-purple-300'
                                                            : seg.status === 'failed' ? 'bg-red-500/15 text-red-400'
                                                            : 'bg-amber-500/15 text-amber-400'
                                                        }`}>{seg.saved ? 'SAVED' : seg.status.toUpperCase()}</span>
                                                        {seg.savedTo ? (
                                                            <div className="text-[9px] text-gray-500 truncate mt-0.5" title={seg.savedTo}>{seg.savedTo}</div>
                                                        ) : null}
                                                    </td>
                                                    <td className="px-2 py-2 align-top">
                                                        <div className="flex flex-wrap gap-1">
                                                            {seg.status === 'cut' && seg.jobId && (
                                                                <>
                                                                    {((seg.pieces?.length || 0) > 0 || (seg.ranges?.length || 0) > 0 || (Number.isFinite(seg.start) && Number.isFinite(seg.end))) && (
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => void testEditPart(seg)}
                                                                            disabled={editBusy || partTestBusyId === seg.id}
                                                                            className="text-[10px] font-bold px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white"
                                                                            title="Chạy lại đúng part này từ video nguồn ngang gốc"
                                                                        >
                                                                            {partTestBusyId === seg.id ? 'Đang test…' : 'Test lại Part'}
                                                                        </button>
                                                                    )}
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => saveEditItems([seg.id])}
                                                                        className="text-[10px] font-bold px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-white border border-gray-600"
                                                                        title="Save into the shared folder"
                                                                    >
                                                                        Shared
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => saveEditOneToFolder(seg)}
                                                                        className="text-[10px] font-bold px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 text-white"
                                                                        title="Pick a folder just for this clip"
                                                                    >
                                                                        Save to…
                                                                    </button>
                                                                </>
                                                            )}
                                                            {seg.saved && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        const item = editToResult({ ...seg, status: 'cut' });
                                                                        if (item) void openSavedLocation(item, 'edit');
                                                                    }}
                                                                    className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded bg-green-700 hover:bg-green-600 text-white"
                                                                >
                                                                    <FolderOpen className="w-3 h-3" />
                                                                    Open
                                                                </button>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                                    )),
                                                    ];
                                                });
                                            })()}
                                        </tbody>
                                    </table>
                                </div>
                                {editRunSummary && (
                                    <div className="mt-3 rounded-xl border border-cyan-900/60 bg-cyan-950/20 p-3 space-y-2 text-[11px]">
                                        <p className="font-mono text-cyan-300">
                                            TỔNG KẾT · {editRunSummary.sourceName} · nguồn {fmtDur(0, editRunSummary.totalSec)} · giữ {fmtDur(0, editRunSummary.keptSec)} ({editRunSummary.parts.length} part) · bỏ {fmtDur(0, editRunSummary.droppedSec)} · tổng {(editRunSummary.totalElapsedMs / 1000).toFixed(0)}s
                                            {editRunSummary.sttCompact ? ' · STT gọn (chỉ part giữ)' : ''}
                                            {editRunSummary.geminiCost ? ` · Gemini ${Math.round(editRunSummary.geminiCost.totalVnd).toLocaleString('vi-VN')}đ (${editRunSummary.geminiCost.calls} call · ${editRunSummary.geminiCost.totalTokens.toLocaleString('vi-VN')} token)` : ''}
                                        </p>
                                        {editRunSummary.geminiCost && editRunSummary.geminiCost.byModel.length ? (
                                            <p className="font-mono text-amber-300/90">
                                                TIỀN GEMINI API · token thật từ usageMetadata × bảng giá
                                                {editRunSummary.geminiCost.byModel.map((m) => ` · ${m.model} ×${m.calls} (${(m.inputTokens + m.cachedInputTokens).toLocaleString('vi-VN')} in/${m.outputTokens.toLocaleString('vi-VN')} out) ${Math.round(m.vnd).toLocaleString('vi-VN')}đ`).join('')}
                                                {editRunSummary.geminiCost.unknownModels.length ? ` · chưa có giá: ${editRunSummary.geminiCost.unknownModels.join(', ')}` : ''}
                                            </p>
                                        ) : null}
                                        <table className="w-full text-left">
                                            <thead className="text-gray-500 uppercase text-[10px]">
                                                <tr>
                                                    <th className="py-1">#</th>
                                                    <th>Part</th>
                                                    <th>Bắt đầu–Kết thúc</th>
                                                    <th>Dài</th>
                                                    <th>Xong lúc</th>
                                                    <th>Model thật</th>
                                                    <th>QA</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-800">
                                                {editRunSummary.parts.map((part) => (
                                                    <tr key={`${part.partIndex}-${part.name}`}>
                                                        <td className="py-1 font-mono text-cyan-400">{part.partIndex}</td>
                                                        <td className="truncate max-w-[16rem] text-gray-200">{part.title || part.name}</td>
                                                        <td className="font-mono text-gray-400">{fmtTs(part.start)}–{fmtTs(part.end)}</td>
                                                        <td className="font-mono text-gray-400">{fmtDur(part.start, part.end)}</td>
                                                        <td className="font-mono text-gray-400">
                                                            {part.finishedAt ? new Date(part.finishedAt).toLocaleTimeString('vi-VN') : '—'}
                                                            {part.elapsedMs != null ? ` (+${Math.round(part.elapsedMs / 1000)}s)` : ''}
                                                        </td>
                                                        <td className="font-mono text-[10px] text-gray-400">{part.detailModelUsed || '—'}</td>
                                                        <td className={part.qa ? (part.qa.score >= 85 ? 'text-emerald-300' : part.qa.score >= 70 ? 'text-cyan-300' : 'text-amber-300') : 'text-gray-600'}>
                                                            {part.qa ? `${part.qa.score}/100` : '—'}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {editRunSummary.dropped.length > 0 && (
                                            <p className="text-amber-300/90 leading-snug">
                                                Đoạn bỏ ({editRunSummary.dropped.length}): {editRunSummary.dropped.map((d) => `${fmtTs(d.start)}–${fmtTs(d.end)} (${d.sec.toFixed(0)}s)`).join(' · ')}
                                            </p>
                                        )}
                                    </div>
                                )}
                                {editSegments.some((s) => s.reason) && (
                                    <p className="text-[10px] text-gray-600 mt-3 font-mono">
                                        {editSegments.filter((s) => s.reason).map((s) => `${s.sourceName} #${s.partIndex}: ${s.reason}`).join(' · ')}
                                    </p>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
            )}

            {appTab === 'reframe' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
                <div className="xl:col-span-4 space-y-6">
                    <div className="bg-gray-900/50 border border-pink-900/40 rounded-2xl p-1 backdrop-blur-sm">
                        <div
                            onDragEnter={(e) => { e.preventDefault(); setReframeDragging(true); }}
                            onDragOver={(e) => { e.preventDefault(); setReframeDragging(true); }}
                            onDragLeave={(e) => { e.preventDefault(); setReframeDragging(false); }}
                            onDrop={(e) => {
                                e.preventDefault();
                                setReframeDragging(false);
                                if (e.dataTransfer.files?.length) addReframeFiles(Array.from(e.dataTransfer.files));
                            }}
                            className={`flex flex-col items-center justify-center w-full min-h-36 border-2 border-dashed rounded-xl ${
                                reframeDragging ? 'border-pink-400 bg-pink-500/15' : 'border-gray-700 hover:border-pink-500/30'
                            }`}
                        >
                            <label className="flex flex-col items-center justify-center w-full cursor-pointer py-6 px-4 text-center">
                                <Focus className="w-10 h-10 text-pink-400 mb-3" />
                                <p className="mb-1 text-sm text-gray-300"><span className="font-semibold">Drop videos</span> to AI-reframe</p>
                                <p className="text-xs text-gray-600 font-mono">Gemini follow speaker / action → 9:16 crop</p>
                                <input
                                    ref={reframeInputRef}
                                    type="file"
                                    className="hidden"
                                    accept="video/*"
                                    multiple
                                    onChange={(e) => {
                                        if (e.target.files?.length) addReframeFiles(Array.from(e.target.files));
                                        e.target.value = '';
                                    }}
                                />
                            </label>
                            <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void pickReframeFromPc(); }}
                                className="mb-4 px-3 py-1.5 rounded-lg text-[11px] font-mono border border-pink-700 bg-pink-950/50 text-pink-300 hover:bg-pink-900/50"
                            >
                                Add from PC
                            </button>
                        </div>
                        {reframeFiles.length > 0 && (
                            <ul className="mt-1 divide-y divide-gray-800/80 max-h-56 overflow-y-auto">
                                {reframeFiles.map((clip, i) => (
                                    <li key={clip.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                                        <FileVideo className="w-4 h-4 text-pink-400 shrink-0" />
                                        <span className="truncate text-gray-200 flex-1">{clip.name}</span>
                                        <button type="button" onClick={() => {
                                            const removed = reframeFilesRef.current[i];
                                            setReframeFiles((prev) => {
                                                const next = prev.filter((_, idx) => idx !== i);
                                                reframeFilesRef.current = next;
                                                return next;
                                            });
                                            void releaseYoutubeImport(removed, 'remove', 'reframe');
                                        }} className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400">
                                            <X className="w-4 h-4" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 space-y-4">
                        <h3 className="font-semibold text-gray-200 flex items-center gap-2"><Focus className="w-5 h-5 text-pink-400" /> AI Auto-Reframe</h3>
                        <div className={`text-xs font-mono px-3 py-2 rounded-lg border ${
                            adcInfo?.ok ? 'text-green-400 bg-green-900/20 border-green-800' : 'text-amber-300 bg-amber-900/20 border-amber-800'
                        }`}>
                            {adcInfo?.ok ? `ADC ready · ${adcInfo.project}` : `ADC missing — ${adcInfo?.error || 'login gcloud'}`}
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">ASPECT</label>
                            <select
                                value={reframeAspect}
                                onChange={(e) => setReframeAspect(e.target.value as typeof reframeAspect)}
                                disabled={reframeBusy}
                                className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5"
                            >
                                <option value="9:16">9:16 TikTok / Reels (1080×1920) — giữ ~32% ngang</option>
                                <option value="3:4">3:4 (1080×1440) — giữ ~42% ngang</option>
                                <option value="4:5">4:5 Instagram (1080×1350) — giữ ~45% ngang</option>
                                <option value="1:1">1:1 (1080×1080) — giữ ~56% ngang</option>
                                <option value="4:3">4:3 (1440×1080) — giữ ~75% ngang</option>
                                <option value="3:2">3:2 (1620×1080) — giữ ~84% ngang</option>
                                <option value="16:9">16:9 YouTube (1920×1080) — giữ 100%, gần như không crop</option>
                            </select>
                            <p className="text-[10px] text-gray-600">Nguồn 1920×1080: tỉ lệ càng gần 16:9 thì càng ít bị cắt hai bên. Tightness kéo về 1.00 để cửa sổ rộng nhất.</p>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">TIGHTNESS {reframeTight.toFixed(2)}×</label>
                            <input type="range" min={1} max={1.4} step={0.02} value={reframeTight} disabled={reframeBusy} onChange={(e) => setReframeTight(Number(e.target.value))} className="w-full accent-pink-500" />
                            <p className="text-[10px] text-gray-600">1.00 = cửa sổ rộng nhất. 1.20–1.40 = zoom sát mặt/rối hơn.</p>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-mono text-gray-400">MODEL</label>
                            <select value={editModel} onChange={(e) => setEditModel(e.target.value)} disabled={reframeBusy} className="w-full bg-gray-950 border border-gray-700 text-gray-200 text-sm rounded-lg p-2.5">
                                <option value="gemini-3.8-flash">gemini-3.8-flash</option>
                                <option value="gemini-3.7-flash">gemini-3.7-flash</option>
                                <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                                <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (xem kỹ hơn)</option>
                                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
                            </select>
                        </div>
                        {reframeBusy ? (
                            <button type="button" onClick={cancelReframe} className="w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg bg-red-900/40 text-red-300 border border-red-500/40">
                                <Square className="w-5 h-5 fill-current" />
                                STOP REFRAME ({reframePhase === 'watching' ? `watch ${reframeWatchPct.toFixed(0)}%` : `${reframeProgress.toFixed(0)}%`})
                            </button>
                        ) : (
                            <button type="button" onClick={startReframe} disabled={!reframeFiles.length} className={`w-full flex items-center justify-center gap-2 py-4 rounded-xl font-bold text-lg ${
                                !reframeFiles.length ? 'bg-gray-800/50 text-gray-600 cursor-not-allowed' : 'bg-gradient-to-r from-pink-600 to-rose-600 text-white border border-pink-400/50'
                            }`}>
                                <Focus className="w-5 h-5" />
                                AI REFRAME {reframeFiles.length ? `(${reframeFiles.length})` : ''}
                            </button>
                        )}
                    </div>
                </div>
                <div className="xl:col-span-8 space-y-4">
                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden flex flex-col">
                        <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Terminal className="w-4 h-4 text-pink-400" />
                                <span className="text-xs font-mono text-gray-400">ghostforge_reframe.log</span>
                            </div>
                        </div>
                        <div className="p-2">
                            <LogViewer
                                logs={logsByChannel.reframe}
                                getExportLogs={() => fullLogsRef.current.reframe}
                                filePrefix="reframe"
                                emptyText="Reframe đang chờ."
                                onClear={() => clearLogChannel('reframe')}
                            />
                        </div>
                    </div>
                    {reframeBusy && (
                        <div className="bg-gray-900/50 p-4 rounded-xl border border-gray-800 space-y-1.5">
                            <div className="flex justify-between text-xs font-mono text-pink-400">
                                <span>{reframePhase === 'watching' ? 'GEMINI WATCH' : reframePhase === 'encode' ? 'FFMPEG CROP' : 'REFRAME'}</span>
                                <span>{reframePhase === 'watching' ? `${reframeWatchPct.toFixed(0)}%` : `${reframeProgress.toFixed(0)}%`}</span>
                            </div>
                            <div className="w-full bg-gray-950 rounded-full h-2.5 overflow-hidden border border-gray-800">
                                <div className="bg-gradient-to-r from-pink-500 to-rose-500 h-full rounded-full" style={{ width: `${Math.min(100, reframePhase === 'watching' ? reframeWatchPct : reframeProgress)}%` }} />
                            </div>
                            <p className="text-[10px] text-gray-500">Pro xem clip dài có thể 3–8 phút. Clip xong hiện dưới khi log có SUCCESS.</p>
                        </div>
                    )}
                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                            <h3 className="text-lg font-bold text-gray-100 flex items-center gap-2">
                                <CheckCircle2 className="w-5 h-5 text-green-500" />
                                Reframed ({reframeResults.length})
                                <span className="text-xs font-mono font-normal text-gray-500">
                                    {reframeResults.filter((r) => r.saved).length} saved · {reframeResults.filter((r) => !r.saved).length} not saved
                                </span>
                            </h3>
                            {reframeResults.length > 0 && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <button type="button" onClick={() => pickSaveFolder('reframe')} className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-gray-700 bg-gray-950 text-gray-300 hover:border-pink-500 hover:text-pink-300">
                                        <FolderOpen className="w-4 h-4" />
                                        {saveFolderName ? `Shared: ${saveFolderName}` : 'Choose shared folder'}
                                    </button>
                                    <button type="button" onClick={() => openSavedLocation(undefined, 'reframe')} className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-gray-700 bg-gray-950 text-gray-300 hover:border-green-500 hover:text-green-300">
                                        <FolderOpen className="w-4 h-4" />
                                        Open shared
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const unsaved = reframeResults.filter((r) => !r.saved).length;
                                            if (unsaved && !window.confirm(`${unsaved} clip chưa Save. Xóa hết danh sách Reframed? File đã save trên đĩa vẫn còn.`)) return;
                                            void Promise.all(reframeResults.map((r) => fetch(`${BACKEND_URL}/api/job/${r.jobId}`, { method: 'DELETE' }).catch(() => null)));
                                            setReframeResults([]);
                                            setReframeSelectedIds([]);
                                            addLog('[REFRAME] Cleared results list.');
                                        }}
                                        className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded-lg border border-red-800 bg-red-950/40 text-red-300"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Remove all
                                    </button>
                                </div>
                            )}
                        </div>
                        {saveNotice && (
                            <div className="mb-3 px-3 py-2 rounded-lg bg-green-500/15 border border-green-500/40 text-green-300 text-sm font-medium">
                                {saveNotice}
                            </div>
                        )}
                        {reframeResults.length === 0 ? (
                            <p className="text-sm text-gray-500">
                                {reframeBusy
                                    ? 'Đang chạy — chưa xong. Nút STOP + % watch nghĩa là Gemini vẫn đang xem, chưa crop.'
                                    : 'Chưa có file. Xong thì hàng này hiện tên + SAVED / NOT SAVED.'}
                            </p>
                        ) : (
                            <>
                                <div className="flex flex-wrap items-center gap-2 mb-3">
                                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={reframeResults.length > 0 && reframeSelectedIds.length === reframeResults.length}
                                            onChange={(e) => setReframeSelectedIds(e.target.checked ? reframeResults.map((r) => r.jobId) : [])}
                                        />
                                        Select all
                                    </label>
                                    <span className="text-[11px] font-mono text-gray-500">{reframeSelectedIds.length} selected</span>
                                    <button type="button" onClick={() => saveAllToShared(reframeResults.filter((r) => reframeSelectedIds.includes(r.jobId)), 'reframe')} disabled={reframeSelectedIds.length === 0} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-pink-600 hover:bg-pink-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs font-bold">
                                        <Save className="w-3.5 h-3.5" />
                                        Save selected
                                    </button>
                                    <button type="button" onClick={() => saveAllToShared(reframeResults, 'reframe')} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-xs font-bold border border-gray-600">
                                        Save all to shared
                                    </button>
                                    {renderHandoffSelect()}
                                    <button type="button" onClick={() => void sendReframeToUnique()} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-white text-xs font-bold">
                                        <ArrowRight className="w-3.5 h-3.5" />
                                        Send to Unique
                                    </button>
                                </div>
                                <ul className="divide-y divide-gray-800">
                                    {reframeResults.map((item) => {
                                        const filename = safeFileName(item.name);
                                        const checked = reframeSelectedIds.includes(item.jobId);
                                        return (
                                            <li key={item.jobId} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => setReframeSelectedIds((prev) => prev.includes(item.jobId) ? prev.filter((id) => id !== item.jobId) : [...prev, item.jobId])}
                                                    className="shrink-0"
                                                />
                                                <FileVideo className="w-4 h-4 shrink-0 hidden sm:block text-pink-400" />
                                                {renamingId === item.jobId ? (
                                                    <input
                                                        autoFocus
                                                        defaultValue={filename}
                                                        className="flex-1 bg-gray-950 border border-pink-500 rounded px-2 py-1 text-sm text-gray-100 outline-none"
                                                        onBlur={(e) => { renameCompleted(item.jobId, e.target.value); setRenamingId(null); }}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') { renameCompleted(item.jobId, (e.target as HTMLInputElement).value); setRenamingId(null); }
                                                            if (e.key === 'Escape') setRenamingId(null);
                                                        }}
                                                    />
                                                ) : (
                                                    <span className="flex-1 text-sm text-gray-200 truncate" title={item.originalName}>{filename}</span>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (!item.saved) { setSaveNotice('Save the clip first'); return; }
                                                        void openSavedLocation(item, 'reframe');
                                                    }}
                                                    className={`text-[10px] font-mono px-2 py-0.5 rounded shrink-0 ${item.saved ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30' : 'bg-amber-500/15 text-amber-400'}`}
                                                    title={item.saved ? `Open ${item.savedTo}` : 'Not saved yet'}
                                                >
                                                    {item.saved ? `SAVED → ${item.savedTo}` : 'NOT SAVED'}
                                                </button>
                                                {item.saved && (
                                                    <button type="button" onClick={() => void openSavedLocation(item, 'reframe')} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 text-white text-[10px] font-bold">
                                                        <FolderOpen className="w-3.5 h-3.5" />
                                                        Open
                                                    </button>
                                                )}
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <button type="button" onClick={() => setRenamingId(item.jobId)} className="p-1.5 rounded hover:bg-gray-800 text-gray-400 hover:text-pink-300" title="Rename">
                                                        <Pencil className="w-4 h-4" />
                                                    </button>
                                                    <button type="button" onClick={() => saveAllToShared([item], 'reframe')} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-white text-[10px] font-bold border border-gray-600">
                                                        Shared
                                                    </button>
                                                    <button type="button" onClick={() => saveOneToChosenFolder(item, 'reframe')} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-pink-700 hover:bg-pink-600 text-white text-[10px] font-bold">
                                                        Save to…
                                                    </button>
                                                    <button type="button" onClick={() => removeCompleted(item.jobId, 'reframe')} className="p-1.5 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400" title="Remove from list">
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </>
                        )}
                    </div>
                </div>
            </div>
            )}
            
            <style dangerouslySetInnerHTML={{__html: `
                @keyframes shimmer {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                }
            `}} />

            <div className={appTab === 'youtube' ? 'space-y-6' : 'hidden'}>
                <YoutubeImportBox
                    addLog={addLog}
                    onImported={appendYoutubeClip}
                    awake={appTab === 'youtube'}
                    presets={namedPresets.map((item) => ({ id: item.id, name: item.name }))}
                    presetId={namedPresets.some((item) => item.id === handoffPresetId) ? handoffPresetId : ''}
                    onPresetId={chooseHandoffPreset}
                    readEditProfile={() => editRunRef.current}
                />
                <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden flex flex-col shadow-lg">
                    <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                        <Terminal className="w-4 h-4 text-red-400" />
                        <span className="text-xs font-mono text-gray-400">ghostforge_youtube.log</span>
                    </div>
                    <div className="p-2">
                        <LogViewer
                            logs={logsByChannel.youtube}
                            getExportLogs={() => fullLogsRef.current.youtube}
                            filePrefix="youtube"
                            emptyText="YouTube đang chờ."
                            onClear={() => clearLogChannel('youtube')}
                        />
                    </div>
                </div>
            </div>

            {appTab === 'trends' && (
                <TrendsPanel />
            )}
        </div>
    );
}
