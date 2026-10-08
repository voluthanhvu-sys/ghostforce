import React, { useCallback, useEffect, useState } from 'react';
import {
    AlertTriangle,
    Calendar,
    ChevronLeft,
    ChevronRight,
    Clock,
    ExternalLink,
    Eye,
    Flame,
    Hash,
    RefreshCw,
    TrendingUp,
    Users,
} from 'lucide-react';

// TikTok trend finder. Talks to /api/trends, which wraps the free Creative
// Center source. The panel is intentionally self-contained: it owns its own
// state and never touches the processing queues.

interface TrendHashtag {
    kind: 'hashtag';
    name: string;
    id: string;
    rank: number | null;
    posts: number;
    views: number;
    popularity: number;
}

interface TrendVideo {
    kind: 'video';
    id: string;
    title: string;
    url: string;
    createdAt: string | null;
    authorName: string;
    authorHandle: string;
    authorFollowers: number;
    views: number;
    durationSec: number | null;
    engagementRate: number;
    categories: string[];
    hashtags: string[];
}

interface TrendKeyword {
    kind: 'keyword' | 'hashtag';
    name: string;
    videoCount: number;
    views: number;
}

interface TrendResult {
    source: string;
    region: string;
    regionLabel: string;
    period: number;
    minViews: number;
    maxViews: number;
    minDurationSec: number;
    fetchedAt: string;
    sessionActive: boolean;
    limitations: string[];
    hashtags: TrendHashtag[];
    videos: TrendVideo[];
    videosFiltered: number;
    videosBeforeFilter: number;
    poolViewsMin: number;
    poolViewsMax: number;
    limit: number;
    keywords: TrendKeyword[];
}

interface TrendConfig {
    periods: number[];
    minViews: number[];
    maxViews: number[];
    minDurations: number[];
    videoLimits: number[];
    regions: Array<{ code: string; label: string; video: boolean }>;
}

function formatCompact(value: number | null | undefined): string {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return `${(n / 1e9).toFixed(2).replace('.', ',')} tỷ`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} tr`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.', ',')} K`;
    return new Intl.NumberFormat('vi-VN').format(Math.round(n));
}

function formatFull(value: number | null | undefined): string {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('vi-VN').format(Math.round(n));
}

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function minViewsLabel(value: number): string {
    return value > 0 ? `${formatCompact(value)} view` : 'Tất cả';
}

function maxViewsLabel(value: number): string {
    return value > 0 ? `đến ${formatCompact(value)}` : 'không giới hạn trên';
}

function minDurationLabel(value: number): string {
    if (value <= 0) return 'Không giới hạn';
    if (value % 60 === 0) return `${value / 60} phút trở lên`;
    return `${value} giây trở lên`;
}

function formatDuration(seconds: number | null): string {
    if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '—';
    const total = Math.round(Number(seconds));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return minutes ? `${minutes}p${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

export function TrendsPanel() {
    const [hashtagInput, setHashtagInput] = useState('');
    const [hashtagError, setHashtagError] = useState('');
    const [searchedTag, setSearchedTag] = useState('');
    const [config, setConfig] = useState<TrendConfig | null>(null);
    const [region, setRegion] = useState('VN');
    const [period, setPeriod] = useState(7);
    const [minViews, setMinViews] = useState(0);
    const [maxViews, setMaxViews] = useState(0);
    const [minDuration, setMinDuration] = useState(0);
    const [page, setPage] = useState(1);
    const [data, setData] = useState<TrendResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/trends/config')
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((cfg: TrendConfig) => {
                if (!cancelled) setConfig(cfg);
            })
            .catch(() => {
                if (!cancelled) setError('Không đọc được cấu hình xu hướng từ backend.');
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError('');
        const params = new URLSearchParams({
            region,
            period: String(period),
            minViews: String(minViews),
            maxViews: String(maxViews),
            minDuration: String(minDuration),
        });
        fetch(`/api/trends?${params}`)
            .then(async (res) => {
                const body = await res.json().catch(() => null);
                if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
                return body as TrendResult;
            })
            .then((result) => {
                if (!cancelled) setData(result);
            })
            .catch((err: Error) => {
                if (!cancelled) setError(err.message || 'Không lấy được dữ liệu.');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [region, period, minViews, maxViews, minDuration, reloadKey]);

    useEffect(() => {
        setPage(1);
    }, [region, period, minViews, maxViews, minDuration]);

    const reload = useCallback(() => setReloadKey((n) => n + 1), []);
    const videoSupported = config?.regions.find((r) => r.code === region)?.video ?? false;
    const periods = config?.periods ?? [7, 30];
    const minViewsOptions = config?.minViews ?? [0, 100000, 500000, 1000000, 5000000, 10000000, 50000000];
    const maxViewsOptions = config?.maxViews ?? [0, 1000000, 2000000, 5000000, 10000000, 20000000, 50000000, 100000000];
    const minDurations = config?.minDurations ?? [0, 15, 30, 60, 180];
    const regions = config?.regions ?? [{ code: 'VN', label: 'Việt Nam', video: true }];
    const pageSize = 20;
    const pageCount = Math.max(1, Math.ceil((data?.videos.length ?? 0) / pageSize));
    const currentPage = Math.min(page, pageCount);
    const pageVideos = data ? data.videos.slice((currentPage - 1) * pageSize, currentPage * pageSize) : [];
    const hashtagVideos = searchedTag && data
        ? data.videos.filter((video) => video.hashtags.some((tag) => tag.toLocaleLowerCase() === searchedTag.toLocaleLowerCase()))
        : [];

    const searchTag = (event: React.FormEvent) => {
        event.preventDefault();
        const tag = hashtagInput.trim().replace(/^#/, '');
        if (!tag || tag.length > 80 || !/^[\p{L}\p{N}_.]+$/u.test(tag)) {
            setHashtagError('Nhập một hashtag hợp lệ (tối đa 80 ký tự).');
            setSearchedTag('');
            return;
        }
        setHashtagError('');
        setSearchedTag(tag);
    };

    return (
        <div className="space-y-4">
            <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 space-y-3">
                <h3 className="text-lg font-bold text-gray-100">Tìm video theo hashtag</h3>
                <p className="text-xs text-gray-400">Lọc hashtag trong danh sách video top Creative Center đang tải. Để xem toàn bộ hashtag, mở liên kết trên TikTok bằng profile trình duyệt truy cập được TikTok.</p>
                <form onSubmit={searchTag} className="flex gap-2">
                    <input value={hashtagInput} onChange={(event) => setHashtagInput(event.target.value)} placeholder="Ví dụ: #amthuc" maxLength={81} className="flex-1 min-w-0 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200" />
                    <button type="submit" className="px-4 py-2 rounded-lg bg-cyan-700 text-white text-sm">Lọc video</button>
                </form>
                {hashtagError && <p className="text-sm text-red-300">{hashtagError}</p>}
                {searchedTag && !hashtagError && <div className="text-xs text-gray-400 space-y-1">
                    <p>#{searchedTag}: {hashtagVideos.length} video trong danh sách top đã tải của {data?.regionLabel || region}. Đây không phải kết quả tìm kiếm toàn bộ TikTok.</p>
                    <a href={`https://www.tiktok.com/tag/${encodeURIComponent(searchedTag)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan-300 hover:underline"><ExternalLink className="w-3.5 h-3.5" />Mở toàn bộ #{searchedTag} trên TikTok</a>
                </div>}
                {hashtagVideos.map((video) => <div key={video.id} className="border-t border-gray-800 pt-2 text-sm">
                    <a href={video.url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{video.title || video.url}</a>
                    <p className="text-xs text-gray-500">@{video.authorHandle} · {formatFull(video.views)} view · {formatDuration(video.durationSec)}</p>
                </div>)}
            </div>
            <div className="bg-gray-900/80 border border-gray-800 rounded-2xl p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-lg font-bold text-gray-100 flex items-center gap-2">
                        <TrendingUp className="w-5 h-5 text-orange-400" />
                        Key đang hot trên TikTok
                    </h3>
                    <button
                        type="button"
                        onClick={reload}
                        disabled={loading}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border ${
                            loading
                                ? 'bg-gray-800/50 text-gray-600 border-gray-800 cursor-not-allowed'
                                : 'bg-gray-800 text-gray-200 border-gray-700 hover:border-orange-500/60'
                        }`}
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                        Lấy lại
                    </button>
                </div>

                <p className="text-[11px] text-gray-500 font-mono">
                    Nguồn: TikTok Creative Center (miễn phí, không cần đăng nhập). Kết quả chỉ để tham khảo, không đẩy sang Edit/Unique.
                </p>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-gray-500 font-mono">Quốc gia</span>
                        <select
                            value={region}
                            onChange={(e) => setRegion(e.target.value)}
                            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200"
                        >
                            {regions.map((r) => (
                                <option key={r.code} value={r.code}>
                                    {r.label} ({r.code}){r.video ? '' : ' · hashtag only'}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-gray-500 font-mono">Ngày đăng gần nhất</span>
                        <select
                            value={period}
                            onChange={(e) => setPeriod(Number(e.target.value))}
                            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200"
                        >
                            {periods.map((p) => (
                                <option key={p} value={p}>
                                    {p} ngày gần nhất
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-gray-500 font-mono">View thấp nhất</span>
                        <select
                            value={minViews}
                            onChange={(e) => setMinViews(Number(e.target.value))}
                            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200"
                        >
                            {minViewsOptions.map((v) => (
                                <option key={v} value={v}>
                                    {minViewsLabel(v)}
                                </option>
                            ))}
                        </select>
                    </label>

                    <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-gray-500 font-mono">View cao nhất</span>
                        <select
                            value={maxViews}
                            onChange={(e) => setMaxViews(Number(e.target.value))}
                            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200"
                        >
                            {maxViewsOptions
                                .filter((v) => v === 0 || v >= minViews)
                                .map((v) => (
                                    <option key={v} value={v}>
                                        {maxViewsLabel(v)}
                                    </option>
                                ))}
                        </select>
                    </label>

                    <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-gray-500 font-mono">Thời lượng video</span>
                        <select
                            value={minDuration}
                            onChange={(e) => setMinDuration(Number(e.target.value))}
                            className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-sm text-gray-200"
                        >
                            {minDurations.map((v) => (
                                <option key={v} value={v}>
                                    {minDurationLabel(v)}
                                </option>
                            ))}
                        </select>
                    </label>

                </div>

                {data && (
                    <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-gray-500">
                        <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5" />
                            Lấy lúc {new Date(data.fetchedAt).toLocaleTimeString('vi-VN')} {formatDate(data.fetchedAt)}
                        </span>
                        <span>
                            {data.hashtags.length} hashtag · {data.videos.length} video hiển thị
                            {data.videosFiltered !== data.videosBeforeFilter
                                ? ` (lọc còn ${data.videosFiltered}/${data.videosBeforeFilter})`
                                : ''}
                        </span>
                        <span className={data.sessionActive ? 'text-emerald-400' : 'text-amber-300'}>
                            {data.sessionActive ? 'đã đăng nhập' : 'khách (bản xem thử)'}
                        </span>
                    </div>
                )}

                {data?.limitations?.length ? (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
                        {data.limitations.map((line) => (
                            <p key={line} className="text-[11px] text-amber-200/90 flex gap-2">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span>{line}</span>
                            </p>
                        ))}
                    </div>
                ) : null}

                {error && (
                    <p className="text-sm text-red-300 bg-red-900/20 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
                )}
                {loading && !data && <p className="text-sm text-gray-400">Đang lấy dữ liệu…</p>}
            </div>

            {data && (
                <div className="grid gap-4 xl:grid-cols-2">
                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden">
                        <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                            <Hash className="w-4 h-4 text-orange-400" />
                            <span className="text-xs font-mono text-gray-400">HASHTAG ĐANG HOT · {data.regionLabel}</span>
                        </div>
                        {data.hashtags.length === 0 ? (
                            <p className="p-4 text-sm text-gray-500">Không có hashtag nào cho lựa chọn này.</p>
                        ) : (
                            <div className="divide-y divide-gray-800">
                                {data.hashtags.map((tag) => (
                                    <div key={tag.id || tag.name} className="px-4 py-3 flex items-start gap-3">
                                        <span className="text-xs font-mono text-gray-500 w-6 shrink-0 pt-0.5">#{tag.rank ?? '—'}</span>
                                        <div className="min-w-0 flex-1">
                                            <a
                                                href={`https://www.tiktok.com/tag/${encodeURIComponent(tag.name)}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-sm font-semibold text-orange-300 hover:text-orange-200 break-all"
                                            >
                                                #{tag.name}
                                            </a>
                                            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-gray-500">
                                                <span className="flex items-center gap-1">
                                                    <Users className="w-3.5 h-3.5" />
                                                    {formatCompact(tag.posts)} bài
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Eye className="w-3.5 h-3.5" />
                                                    {formatCompact(tag.views)} view
                                                </span>
                                                <span className="flex items-center gap-1 text-rose-300/80">
                                                    <Flame className="w-3.5 h-3.5" />
                                                    độ hot {tag.popularity}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {videoSupported && data.videos.length > pageSize && (
                            <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-between gap-3 bg-gray-950/60">
                                <button
                                    type="button"
                                    onClick={() => setPage(Math.max(1, currentPage - 1))}
                                    disabled={currentPage <= 1}
                                    className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                                        currentPage <= 1
                                            ? 'bg-gray-900/50 text-gray-600 border-gray-800 cursor-not-allowed'
                                            : 'bg-gray-800 text-gray-200 border-gray-700 hover:border-cyan-500/60'
                                    }`}
                                >
                                    <ChevronLeft className="w-3.5 h-3.5" />
                                    Trang trước
                                </button>
                                <span className="text-[11px] font-mono text-gray-500">
                                    Trang {currentPage}/{pageCount} ·{' '}
                                    {(currentPage - 1) * pageSize + 1}-
                                    {Math.min(currentPage * pageSize, data.videos.length)} / {data.videos.length} video
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setPage(Math.min(pageCount, currentPage + 1))}
                                    disabled={currentPage >= pageCount}
                                    className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                                        currentPage >= pageCount
                                            ? 'bg-gray-900/50 text-gray-600 border-gray-800 cursor-not-allowed'
                                            : 'bg-gray-800 text-gray-200 border-gray-700 hover:border-cyan-500/60'
                                    }`}
                                >
                                    Trang sau
                                    <ChevronRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden">
                        <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                            <Eye className="w-4 h-4 text-cyan-400" />
                            <span className="text-xs font-mono text-gray-400">
                                VIDEO TOP · {data.regionLabel}
                                {data.minViews > 0 ? ` · ≥ ${formatCompact(data.minViews)} view` : ''}
                                {data.maxViews > 0 ? ` · ≤ ${formatCompact(data.maxViews)} view` : ''}
                                {data.minDurationSec > 0 ? ` · ≥ ${minDurationLabel(data.minDurationSec)}` : ''}
                                {data.poolViewsMax > 0
                                    ? ` · nguồn ${formatCompact(data.poolViewsMin)}–${formatCompact(data.poolViewsMax)} view`
                                    : ''}
                            </span>
                        </div>
                        {videoSupported && data.videosBeforeFilter > 0 && (
                            <p className="px-4 pb-2 text-[11px] text-gray-500">
                                Đây là {data.videosBeforeFilter} video view cao nhất của nước này, không phải tìm kiếm
                                toàn bộ TikTok — nên mức "cao nhất" phải nằm trong khoảng view của nguồn.
                            </p>
                        )}
                        {!videoSupported ? (
                            <p className="p-4 text-sm text-gray-500">
                                Nguồn miễn phí chỉ có danh sách video cho US, JP, VN, TH, ID.
                            </p>
                        ) : data.videos.length === 0 ? (
                            <p className="p-4 text-sm text-gray-500">Không có video nào đạt mức view đã chọn.</p>
                        ) : (
                            <div className="divide-y divide-gray-800">
                                {pageVideos.map((video) => (
                                    <div key={video.id} className="px-4 py-3 space-y-1.5">
                                        <a
                                            href={video.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="text-sm text-gray-100 hover:text-cyan-300 line-clamp-2"
                                        >
                                            {video.title || '(không có caption)'}
                                        </a>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-gray-500">
                                            <span>@{video.authorHandle}</span>
                                            <span className="flex items-center gap-1">
                                                <Eye className="w-3.5 h-3.5" />
                                                {formatFull(video.views)} view
                                            </span>
                                            <span>{formatCompact(video.authorFollowers)} follower</span>
                                            <span className="flex items-center gap-1">
                                                <Calendar className="w-3.5 h-3.5" />
                                                {formatDate(video.createdAt)}
                                            </span>
                                            <span className="flex items-center gap-1">
                                                <Clock className="w-3.5 h-3.5" />
                                                {formatDuration(video.durationSec)}
                                            </span>
                                        </div>
                                        <a
                                            href={video.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-mono"
                                        >
                                            <ExternalLink className="w-3.5 h-3.5" />
                                            mở trên TikTok
                                        </a>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="bg-gray-900/80 border border-gray-800 rounded-2xl overflow-hidden xl:col-span-2">
                        <div className="bg-gray-950 px-4 py-3 border-b border-gray-800 flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-emerald-400" />
                            <span className="text-xs font-mono text-gray-400">
                                TỪ KHOÁ TRONG CAPTION CỦA VIDEO TOP · tổng view của các video chứa từ đó
                            </span>
                        </div>
                        {data.keywords.length === 0 ? (
                            <p className="p-4 text-sm text-gray-500">Chưa có từ khoá (cần danh sách video).</p>
                        ) : (
                            <div className="p-4 flex flex-wrap gap-2">
                                {data.keywords.map((word) => (
                                    <span
                                        key={`${word.kind}-${word.name}`}
                                        className={`px-3 py-1.5 rounded-full text-xs font-mono border ${
                                            word.kind === 'hashtag'
                                                ? 'bg-orange-500/10 border-orange-500/30 text-orange-200'
                                                : 'bg-gray-800/80 border-gray-700 text-gray-200'
                                        }`}
                                        title={`${word.videoCount} video · ${formatFull(word.views)} view`}
                                    >
                                        {word.kind === 'hashtag' ? '#' : ''}
                                        {word.name}
                                        <span className="ml-2 text-gray-500">{formatCompact(word.views)}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default TrendsPanel;
