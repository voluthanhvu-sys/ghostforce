// Optional Unique steps. Pure: no ffmpeg, no GPU, no network.
// Smooth scale and the caption clock live here so a unit test can lock them
// without rendering a video. The server owns the processes.

export const SMOOTH_LONG_SIDE = 1080;
export const SMOOTH_CHUNK_FRAMES = 240;

// Same even-dimension rule as evenDim() in ghostforge-server.js.
export function evenDim(n) {
    const v = Math.round(Number(n) || 0);
    return Math.max(2, v - (v % 2));
}

// The video model only scales by 2, 3 or 4. A long side already at 1080
// uses 2, then the caller scales back to the source size. A smaller frame
// uses 3 (the scale used on the 640x360 and 480x854 checks). 4 is not used.
export function smoothScale(width, height) {
    const long = Math.max(Number(width) || 0, Number(height) || 0);
    return long >= SMOOTH_LONG_SIDE ? 2 : 3;
}

export function smoothPlan(width, height, mode) {
    const outW = evenDim(width);
    const outH = evenDim(height);
    const short = Math.min(outW, outH);
    if (mode !== 'ai' && short >= SMOOTH_LONG_SIDE) {
        return { engine: 'filter', scale: 1, outW, outH, modelW: outW, modelH: outH };
    }
    const scale = smoothScale(outW, outH);
    return { engine: 'model', scale, outW, outH, modelW: outW * scale, modelH: outH * scale };
}

// Light denoise plus a little sharpen, at the source size. No upscale.
export function smoothFilterGraph(outW, outH) {
    return `scale=${evenDim(outW)}:${evenDim(outH)}:flags=lanczos,hqdn3d=1.5:1:3:2,cas=0.4,setsar=1`;
}

// One number for the Làm mịn bar. The model still works in chunks of 240
// frames. The bar uses how many frames are already written, so it moves
// inside a chunk instead of waiting for the chunk to finish. 100 is reserved
// for the step that comes after the model.
export function smoothFrameProgress(done, total) {
    const all = Math.max(1, Number(total) || 0);
    const got = Math.max(0, Math.min(all, Number(done) || 0));
    return Math.min(99, (got / all) * 100);
}

function handoffLabel(raw) {
    return String(raw || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
}

// The line on a finished Unique video that was sent from the YouTube tab.
// `chosen` is the preset name on that tab at send time. `used` is the preset
// the Unique run actually applied. An empty string means this clip was not
// a YouTube handoff.
export function youtubeHandoffNote(settings) {
    if (String(settings?.handoffFrom || '').trim() !== 'youtube') return '';
    const chosen = handoffLabel(settings?.handoffPreset);
    const used = handoffLabel(settings?.presetName);
    if (!chosen) {
        return used
            ? `Từ YouTube. Không chọn preset bên YouTube. Lượt này dùng “${used}”.`
            : 'Từ YouTube. Không chọn preset bên YouTube.';
    }
    if (used === chosen) return `Từ YouTube. Preset “${chosen}”.`;
    if (!used) return `Từ YouTube. Preset “${chosen}” đã chọn bên YouTube. Lượt này dùng công tắc đang mở.`;
    return `Từ YouTube. Preset “${chosen}” đã chọn bên YouTube. Lượt này dùng “${used}”.`;
}

// Whisper returns ISO 639-1. Google speech:recognize wants a BCP-47 tag.
// Edit stays en-US because it does not call this. pt from the Brazil clip
// becomes pt-BR, which is the tag that spelled lindeza.
const GOOGLE_LANG = {
    af: 'af-ZA', am: 'am-ET', ar: 'ar-SA', bg: 'bg-BG', bn: 'bn-BD',
    ca: 'ca-ES', cs: 'cs-CZ', da: 'da-DK', de: 'de-DE', el: 'el-GR',
    en: 'en-US', es: 'es-ES', fa: 'fa-IR', fi: 'fi-FI', fil: 'fil-PH',
    fr: 'fr-FR', hi: 'hi-IN', hr: 'hr-HR', hu: 'hu-HU', id: 'id-ID',
    it: 'it-IT', ja: 'ja-JP', ko: 'ko-KR', ms: 'ms-MY', nl: 'nl-NL',
    pl: 'pl-PL', pt: 'pt-BR', ro: 'ro-RO', ru: 'ru-RU', sk: 'sk-SK',
    sv: 'sv-SE', th: 'th-TH', tr: 'tr-TR', uk: 'uk-UA', ur: 'ur-PK',
    vi: 'vi-VN', zh: 'cmn-Hans-CN',
};

export function googleLanguageCode(whisperCode) {
    const raw = String(whisperCode || '').trim().replace(/_/g, '-');
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower.includes('-')) {
        const [lang, region, ...rest] = lower.split('-');
        return [lang, region.toUpperCase(), ...rest].filter(Boolean).join('-');
    }
    return GOOGLE_LANG[lower] || lower;
}

export function captionDisplayText(word) {
    return String(word || '').toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
}

export function normCaptionWord(word) {
    return captionDisplayText(word).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]/g, '');
}

// Same beat: equal, a shared stem of at least 3 letters, or the same 4-letter
// start. A looser overlap of the clocks is not used. It moved words onto the
// neighbouring syllable on the Brazil clip.
export function similarCaptionWord(a, b) {
    const na = normCaptionWord(a);
    const nb = normCaptionWord(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const short = na.length <= nb.length ? na : nb;
    const long = na.length <= nb.length ? nb : na;
    if (short.length >= 3 && long.startsWith(short)) return true;
    if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
    return false;
}

// Local listen owns the clock. Google text is copied only on a similar match.
// A dissimilar substitution keeps the local word. A Google-only word is dropped
// so it is not placed on Google's clock.
export function alignCaptionWords(clockWords, spellWords) {
    const clock = Array.isArray(clockWords) ? clockWords : [];
    const spell = Array.isArray(spellWords) ? spellWords : [];
    const n = clock.length;
    const m = spell.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    const bt = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(''));
    for (let i = 1; i <= n; i++) {
        dp[i][0] = -i;
        bt[i][0] = 'W';
    }
    for (let j = 1; j <= m; j++) {
        dp[0][j] = -j;
        bt[0][j] = 'G';
    }
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const sim = similarCaptionWord(clock[i - 1].word, spell[j - 1].word);
            const scoreM = dp[i - 1][j - 1] + (sim ? 3 : -2);
            const scoreW = dp[i - 1][j] - 1;
            const scoreG = dp[i][j - 1] - 1;
            let best = scoreW;
            let how = 'W';
            if (scoreG > best) {
                best = scoreG;
                how = 'G';
            }
            if (scoreM >= best) {
                best = scoreM;
                how = sim ? 'M' : 'S';
            }
            dp[i][j] = best;
            bt[i][j] = how;
        }
    }
    const textAt = clock.map((w) => w.word);
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const how = bt[i][j];
        if (how === 'M') {
            textAt[i - 1] = spell[j - 1].word;
            i -= 1;
            j -= 1;
        } else if (how === 'S') {
            i -= 1;
            j -= 1;
        } else if (how === 'W') {
            i -= 1;
        } else if (how === 'G') {
            j -= 1;
        } else {
            break;
        }
    }
    const cues = [];
    for (let k = 0; k < n; k++) {
        const word = captionDisplayText(textAt[k]);
        const start = Number(clock[k].start);
        const end = Number(clock[k].end);
        if (!word || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        cues.push({
            word,
            start,
            end,
            replaced: word !== captionDisplayText(clock[k].word),
        });
    }
    return cues;
}

// The local clock: lowercase, punctuation stripped, a word at least 80 ms,
// and a word does not run into the next one. This is the clock that matched
// the ear on the Brazil clip. Google times are not passed through here.
export function cleanCaptionClock(words) {
    const cleaned = [];
    for (const w of words || []) {
        const word = captionDisplayText(w?.word);
        if (!word) continue;
        const start = Math.max(0, Math.round((Number(w.start) || 0) * 1000) / 1000);
        let end = Math.round((Number(w.end) || start) * 1000) / 1000;
        if (end < start + 0.08) end = Math.round((start + 0.08) * 1000) / 1000;
        cleaned.push({ word, start, end });
    }
    for (let i = 0; i < cleaned.length - 1; i++) {
        const next = cleaned[i + 1].start;
        if (cleaned[i].end > next) {
            cleaned[i].end = Math.round(Math.max(cleaned[i].start + 0.06, next - 0.02) * 1000) / 1000;
        }
    }
    return cleaned.filter((w) => w.end > w.start);
}

export function assTime(seconds) {
    const cs = Math.round(Math.max(0, Number(seconds) || 0) * 100);
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// The Brazil burn was PlayRes 1440x2562, Arial Black 150, outline 16, centred.
// Other frames scale that pair by the smaller side and stay at least 48 / 6
// so a small source is still readable.
// Bottom uses the centre column, inset by 10% of the frame so the line sits
// like a film subtitle. Middle stays on the centre. Top is not a place.
// An unknown place, including an old top value, is middle.
export function captionAnchor(place, height) {
    const h = Math.max(2, Math.round(Number(height) || 0));
    const margin = Math.max(36, Math.round(h * 0.10));
    if (place === 'bottom') return { alignment: 2, marginV: margin, label: 'dưới, cách mép dưới 10%' };
    return { alignment: 5, marginV: 0, label: 'giữa khung' };
}
export function captionStyleSize(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    const scale = Math.min(w / 1440, h / 2562);
    const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
    return {
        font: Math.max(48, Math.round(150 * factor)),
        outline: Math.max(6, Math.round(16 * factor)),
    };
}

export function buildWordAss({ width, height, cues, place }) {
    const w = Math.max(2, Math.round(Number(width) || 0));
    const h = Math.max(2, Math.round(Number(height) || 0));
    const { font, outline } = captionStyleSize(w, h);
    const anchor = captionAnchor(place, h);
    const lines = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${w}`,
        `PlayResY: ${h}`,
        'WrapStyle: 2',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Word,Arial Black,${font},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,${anchor.alignment},40,40,${anchor.marginV},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    for (const cue of cues || []) {
        const text = String(cue.word || '').replace(/[{}\\\r\n]/g, '');
        if (!text) continue;
        lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Word,,0,0,0,,${text}`);
    }
    return `${lines.join('\n')}\n`;
}

// One ffmpeg filter argument. The drive colon has to be escaped or libass
// reads it as the next option. Forward slashes avoid the shell backslash.
export function ffmpegSubtitlesArg(assPath, fontsDir) {
    const file = String(assPath || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const fonts = String(fontsDir || '').replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    if (!fonts) return `subtitles='${file}'`;
    return `subtitles='${file}':fontsdir='${fonts}'`;
}
