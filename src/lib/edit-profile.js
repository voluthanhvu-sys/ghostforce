// A saved Edit setup for one channel or one shared chain. API keys stay on the
// Edit panel. This snapshot is the switches and the prompt.

const MODELS = new Set([
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash',
  'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-pro',
]);
const ENCODERS = new Set(['auto', 'cpu', 'nvidia', 'intel']);

export function normalizeEditProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = raw.mode === 'even' ? 'even' : 'ai';
  const encoder = ENCODERS.has(raw.encoder) ? raw.encoder : 'auto';
  const framingStyle = raw.framingStyle === 'sml' ? 'sml' : 'focus';
  const detailModelMode = raw.detailModelMode === 'quality' || raw.detailModelMode === 'only'
    ? raw.detailModelMode
    : 'safe';
  return {
    mode,
    encoder,
    split: clampInt(raw.split, 2, 12, 6),
    minSec: clampInt(raw.minSec, 60, 300, 60),
    autoParts: Boolean(raw.autoParts),
    autoCut: raw.autoCut !== false,
    fade: Boolean(raw.fade),
    prompt: clipText(raw.prompt, 20000),
    model: MODELS.has(raw.model) ? raw.model : 'gemini-3.8-flash',
    tiktokPad: Boolean(raw.tiktokPad),
    tiktokMix: Boolean(raw.tiktokMix),
    framingStyle,
    detailModelMode,
    detailModelAuto: raw.detailModelAuto !== false,
    topicPin: clipText(raw.topicPin, 80),
    generalVideo: Boolean(raw.generalVideo),
    speechFraming: raw.speechFraming !== false,
    test1m: Boolean(raw.test1m),
    localDetailTest: Boolean(raw.localDetailTest),
    testSeconds: Number(raw.testSeconds) === 30 ? 30 : 60,
    partFrom: clampInt(raw.partFrom, 1, 24, 1),
    partTo: clampInt(raw.partTo, 0, 24, 0),
  };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clipText(value, max) {
  let text = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  if ([...text].length > max) text = [...text].slice(0, max).join('');
  return text;
}
