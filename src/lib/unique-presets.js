// Named Unique presets. A preset is a snapshot of the switches the operator
// set, kept in the browser. It does not store a seed and it does not touch files.

export const NAMED_PRESET_KEY = 'gf_named_presets';

const PLATFORMS = ['auto', 'tiktok', 'ig_reels', 'yt_shorts', 'facebook', 'generic'];
const STRENGTHS = ['light', 'standard', 'strong', 'extreme'];
const ROTATES = ['off', 'tilt0.5', 'tilt1', 'tilt2', 'tilt3', 'wob1', 'wob2', 'wob3'];
const PGD_LEVELS = ['light', 'medium', 'strong', 'extreme', 'visible'];
const ENCODERS = ['auto', 'cpu', 'nvidia', 'intel'];

const PLATFORM_TEXT = {
    auto: 'Auto (any size, full-frame unique)',
    tiktok: 'TikTok (max unique, captions readable)',
    ig_reels: 'IG Reels (warm + strong unique)',
    yt_shorts: 'YT Shorts (contrast + strong unique)',
    facebook: 'Facebook (balanced unique)',
    generic: 'Generic (strong unique)',
};

const STRENGTH_TEXT = {
    light: 'Nhẹ — gần nguồn nhất (zoom ×0.55)',
    standard: 'Chuẩn — đúng như trước 24/09 (zoom ×1)',
    strong: 'Mạnh — khác nguồn nhiều (zoom ×1.7 · màu ×1.8 · nhịp ×2)',
    extreme: 'Cực mạnh — khác tối đa (zoom ×2.3 · màu ×2.4 · nhịp ×2.8)',
};

const ROTATE_TEXT = {
    off: 'Tắt — không xoay (khuyến nghị cho clip CÓ viền)',
    'tilt0.5': 'Nghiêng tĩnh 0.5° — rất nhẹ (+8% lệch)',
    tilt1: 'Nghiêng tĩnh 1° — nhẹ (+14%)',
    tilt2: 'Nghiêng tĩnh 2° — vừa (+19%), caption nghiêng rõ',
    tilt3: 'Nghiêng tĩnh 3° — mạnh (+23%)',
    wob1: 'Đung đưa ±1° — hình chạy chậm, nhẹ mắt',
    wob2: 'Đung đưa ±2° — mắt thấy rõ, caption chạy',
    wob3: 'Đung đưa ±3° — mạnh, dễ chóng mặt',
};

const PGD_TEXT = {
    light: 'Nhẹ. CLIP ~0.96+',
    medium: 'Vừa. CLIP ~0.94-0.97',
    strong: 'Mạnh. CLIP ~0.92-0.95',
    extreme: 'Rất mạnh. CLIP ~0.85-0.92, mắt khó thấy',
    visible: 'Test thấy. PGD x12 — không xem được, chỉ test',
};

const ENCODER_TEXT = {
    auto: 'Auto (NVIDIA if available, else Intel, else CPU)',
    nvidia: 'NVIDIA NVENC',
    intel: 'Intel Quick Sync',
    cpu: 'CPU libx264 (all cores)',
};

const onOff = (value) => (value ? 'BẬT' : 'TẮT');

function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function flag(value) {
    return value === true;
}

function featherNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.min(45, Math.max(0, Math.round(n * 2) / 2));
}

export function rotatePartsFrom(mode) {
    const match = /^(tilt|wob)(0\.5|1|2|3)$/.exec(String(mode || ''));
    if (!match) return { rotate: 0, wobble: 0 };
    const value = Number(match[2]);
    return match[1] === 'tilt' ? { rotate: value, wobble: 0 } : { rotate: 0, wobble: value };
}

export function normalizeUniqueSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const enablePgd = flag(src.enablePgd);
    return {
        platformMode: oneOf(src.platformMode, PLATFORMS, 'auto'),
        uniqueStrength: oneOf(src.uniqueStrength, STRENGTHS, 'strong'),
        rotateMode: oneOf(src.rotateMode, ROTATES, 'off'),
        enableAdversarial: flag(src.enableAdversarial),
        enableAudioAttack: flag(src.enableAudioAttack),
        enableTikTokCanvas: flag(src.enableTikTokCanvas),
        featherEnabled: flag(src.featherEnabled),
        featherTop: featherNumber(src.featherTop),
        featherBottom: featherNumber(src.featherBottom),
        enableSmooth: flag(src.enableSmooth),
        smoothMode: src.smoothMode === 'ai' ? 'ai' : 'fast',
        enableCaptions: flag(src.enableCaptions),
        captionPlace: src.captionPlace === 'bottom' ? 'bottom' : 'middle',
        enablePgd,
        enablePgdOnly: enablePgd && flag(src.enablePgdOnly),
        pgdLevel: oneOf(src.pgdLevel, PGD_LEVELS, 'strong'),
        encoderMode: oneOf(src.encoderMode, ENCODERS, 'auto'),
    };
}

export function describeUniquePreset(raw) {
    const s = normalizeUniqueSettings(raw);
    const lines = [];
    lines.push(!s.enableSmooth
        ? 'Làm mịn: TẮT. Bỏ qua.'
        : s.smoothMode === 'ai'
            ? 'Làm mịn: BẬT, AI. Model video trên mọi kích thước, rồi trả về đúng kích thước gốc. Mặt người có thể bị vẽ lại. Unique vẫn thêm hạt nhiễu sau đó.'
            : 'Làm mịn: BẬT, nhanh. Video đã đủ 1080 giữ nguyên kích thước, bộ lọc nhẹ. Clip nhỏ hơn 1080 vẫn dùng model chậm. Unique vẫn thêm hạt nhiễu sau đó.');
    if (s.enablePgdOnly) {
        lines.push('Unique: bỏ qua. PGD-only đang bật, toàn bộ Unique không chạy. Các mục Unique bên dưới vẫn nằm trong preset.');
    } else {
        lines.push('Unique: chạy.');
    }
    lines.push(`Nền tảng: ${PLATFORM_TEXT[s.platformMode]}`);
    lines.push(`Độ khác biệt: ${STRENGTH_TEXT[s.uniqueStrength]}`);
    lines.push(`Kiểu xoay: ${ROTATE_TEXT[s.rotateMode]}`);
    lines.push(s.enableAdversarial
        ? 'Nhiễu nhẹ: BẬT. Xê dịch màu ±1, hue dao động, hạt nhiều hơn, hình học nhích.'
        : 'Nhiễu nhẹ: TẮT.');
    lines.push(s.enableAudioAttack
        ? 'EQ tiếng mạnh: BẬT. EQ tĩnh rộng hơn (±5,5 dB) + hiss 10–15 kHz. Không đổi cao độ, không đổi tốc độ.'
        : 'EQ tiếng mạnh: TẮT.');
    lines.push(s.enableTikTokCanvas
        ? 'TikTok 1080×1920: BẬT. Fit toàn bộ nội dung vào 1080×1920, viền đen trên/dưới.'
        : 'TikTok 1080×1920: TẮT. Giữ đúng size nguồn.');
    lines.push(s.featherEnabled
        ? `Viền mờ: BẬT. Trên ${s.featherTop}% · dưới ${s.featherBottom}%. Chỉ cho nguồn có viền mờ tĩnh.`
        : 'Viền mờ: TẮT.');
    if (!s.enablePgd) {
        lines.push('PGD: TẮT. Bỏ qua.');
    } else if (s.enablePgdOnly) {
        lines.push(`PGD: ${PGD_TEXT[s.pgdLevel]}. Chỉ PGD — bỏ toàn bộ Unique.`);
    } else {
        lines.push(`PGD: ${PGD_TEXT[s.pgdLevel]}. Chạy sau Unique.`);
    }
    const captionWhere = s.captionPlace === 'bottom' ? 'dưới, cách mép dưới 10%' : 'giữa khung';
    lines.push(s.enableCaptions
        ? `Phụ đề: BẬT, ${captionWhere}. Một từ, chữ trắng đậm, viền đen. Nghe local lấy nhịp và ngôn ngữ. Google chỉ sửa chính tả khi cùng một nhịp.`
        : 'Phụ đề: TẮT. Bỏ qua.');
    lines.push(`Encoder: ${ENCODER_TEXT[s.encoderMode]}`);
    return lines;
}

function newPresetId() {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeNamedPreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
    const id = String(raw.id || '').trim();
    if (!name || name.length > 40 || !id) return null;
    return { id, name, settings: normalizeUniqueSettings(raw.settings) };
}

export function readPresetList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const row of raw) {
        const preset = normalizeNamedPreset(row);
        if (!preset) continue;
        if (out.some((item) => item.id === preset.id || item.name.toLowerCase() === preset.name.toLowerCase())) continue;
        out.push(preset);
    }
    return out.slice(0, 40);
}

const DUPLICATE_PRESET_NAME = 'Đã có tên này. Tạo tên khác.';

function cleanedPresetName(name) {
    const trimmed = String(name || '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return { ok: false, error: 'Đặt tên preset trước.' };
    if (trimmed.length > 40) return { ok: false, error: 'Tên preset tối đa 40 ký tự.' };
    return { ok: true, name: trimmed };
}

export function createNamedPreset(name, settings, existing) {
    const cleaned = cleanedPresetName(name);
    if (!cleaned.ok) return cleaned;
    const list = Array.isArray(existing) ? existing : [];
    if (list.some((item) => String(item?.name || '').toLowerCase() === cleaned.name.toLowerCase())) {
        return { ok: false, error: DUPLICATE_PRESET_NAME };
    }
    if (list.length >= 40) return { ok: false, error: 'Đã đủ 40 preset.' };
    return {
        ok: true,
        preset: { id: newPresetId(), name: cleaned.name, settings: normalizeUniqueSettings(settings) },
    };
}

export function updateNamedPreset(id, name, settings, existing) {
    const cleaned = cleanedPresetName(name);
    if (!cleaned.ok) return cleaned;
    const list = Array.isArray(existing) ? existing : [];
    const current = list.find((item) => item && item.id === id);
    if (!current) return { ok: false, error: 'Không còn preset này.' };
    if (list.some((item) => item && item.id !== id && String(item.name || '').toLowerCase() === cleaned.name.toLowerCase())) {
        return { ok: false, error: DUPLICATE_PRESET_NAME };
    }
    return {
        ok: true,
        preset: { id, name: cleaned.name, settings: normalizeUniqueSettings(settings) },
    };
}

