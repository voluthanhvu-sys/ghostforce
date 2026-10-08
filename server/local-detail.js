import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const coordinate = { type: 'number', minimum: 0, maximum: 1 };
export const localDetailSchema = {
  type: 'object', required: ['summary', 'segments'], additionalProperties: false,
  properties: {
    summary: { type: 'string', maxLength: 160 },
    segments: {
      type: 'array', minItems: 1, maxItems: 1,
      items: {
        type: 'object', required: ['name', 'start', 'end', 'frames', 'track'], additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 80 }, start: { type: 'number' }, end: { type: 'number' },
          frames: {
            type: 'array', minItems: 1, maxItems: 8,
            items: {
              type: 'object', required: ['start', 'end', 'mode', 'why'], additionalProperties: false,
              properties: {
                start: { type: 'number' }, end: { type: 'number' },
                mode: { type: 'string', enum: ['contain', 'fill'] }, why: { type: 'string', maxLength: 120 },
                cx: coordinate, cy: coordinate,
              },
            },
          },
          track: {
            type: 'array', maxItems: 16,
            items: {
              type: 'object', required: ['t', 'cx', 'cy', 'who'], additionalProperties: false,
              properties: { t: { type: 'number' }, cx: coordinate, cy: coordinate, who: { type: 'string', maxLength: 24 } },
            },
          },
        },
      },
    },
  },
};

export function coalesceLocalFrames(frames, duration) {
  const dur = Number(duration);
  const raw = (Array.isArray(frames) ? frames : [])
    .map((frame) => ({
      start: Number(frame?.start),
      end: Number(frame?.end),
      mode: String(frame?.mode || '').toLowerCase(),
      why: frame?.why,
      cx: frame?.cx,
      cy: frame?.cy,
    }))
    .filter((frame) => Number.isFinite(frame.start) && Number.isFinite(frame.end) && frame.end > frame.start
      && (frame.mode === 'fill' || frame.mode === 'contain'))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!raw.length || !Number.isFinite(dur) || dur <= 0) return [];
  const merged = [];
  for (const frame of raw) {
    const last = merged[merged.length - 1];
    if (last && last.mode === frame.mode && frame.start <= last.end + 0.05) {
      last.end = Math.max(last.end, frame.end);
      if (String(frame.why || '').length > String(last.why || '').length) last.why = frame.why;
      if (!Number.isFinite(Number(last.cx)) && Number.isFinite(Number(frame.cx))) {
        last.cx = Number(frame.cx);
        last.cy = Number(frame.cy);
      }
    } else merged.push({ ...frame });
  }
  merged[0].start = 0;
  merged[merged.length - 1].end = dur;
  for (let i = 1; i < merged.length; i += 1) {
    if (merged[i].start > merged[i - 1].end) merged[i - 1].end = merged[i].start;
    if (merged[i].start < merged[i - 1].end) merged[i].start = merged[i - 1].end;
  }
  return merged.filter((frame) => frame.end - frame.start >= 0.8);
}

export function localDetailPlanFromModel(text, duration) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Local Detail did not return JSON');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Local Detail JSON parse failed');
  }
  const dur = Number(duration);
  // The excerpt is one segment by construction. Do not apply the production
  // minimum-part gate: a 30s test is shorter than a normal episode, and the
  // caller replaces timing with the trimmed excerpt before render.
  return {
    summary: String(parsed.summary || '').slice(0, 300),
    segments: [{ name: 'Local Detail Test', title: 'Local Detail Test', start: 0, end: dur, dur }],
    _raw: parsed,
  };
}

export function validateLocalFraming(frames, track, onLog) {
  if (!frames.length) throw new Error('Local Detail: parsed frames=0 (missing/invalid timing or mode)');
  const missingPosition = frames.filter((frame) => frame.mode === 'fill'
    && !(Number.isFinite(frame.cx) && Number.isFinite(frame.cy))
    && !track.some((point) => point.t >= frame.a && point.t <= frame.b
      && Number.isFinite(point.cx) && Number.isFinite(point.cy)));
  if (missingPosition.length) throw new Error(`Local Detail: ${missingPosition.length} FILL windows lack coordinates and local track`);
  if (!track.length) onLog?.('[EDIT] Local Detail: track empty; using frame coordinates / CONTAIN only');
}

export const localDetailPaths = (rootDir) => ({
  binary: path.join(rootDir, '.local-ai', 'ollama', 'ollama.exe'),
  models: path.join(rootDir, '.local-ai', 'models'),
});

export const chooseLocalTestRange = ({ duration, take, stored, newRandom = false, random = Math.random }) => {
  const dur = Number(duration);
  const length = Math.min(Number(take), Math.max(8, dur));
  const reusable = !newRandom && stored && Number(stored.duration) === dur && Number(stored.take) === length
    && Number.isFinite(Number(stored.start)) && Number(stored.start) >= 0 && Number(stored.start) + length <= dur + 0.01;
  if (reusable) return { start: Number(stored.start), take: length, reused: true };
  const start = dur > length + 8 ? Math.round((random() * (dur - length - 2) + 1) * 10) / 10 : 0;
  return { start, take: length, reused: false };
};

export const buildLocalDetailRequest = ({ model, prompt, frames }) => {
  const selected = (Array.isArray(frames) ? frames : []).slice(0, 6);
  return {
    model,
    stream: false,
    think: false,
    format: localDetailSchema,
    keep_alive: '5m',
    options: { temperature: 0, num_ctx: 8192, num_predict: 1200 },
    messages: [{
      role: 'user',
      content: `${prompt}\n\nThe attached JPEG images are chronological samples in this exact order:\n${selected
        .map((frame, index) => `IMAGE ${index + 1}: t=${Number(frame.t).toFixed(3)}s; evidence=${(frame.reasons || []).join(',') || 'periodic visual sample'}`)
        .join('\n')}`,
      images: selected.map((frame) => frame.jpeg.toString('base64')),
    }],
  };
};

async function available(baseUrl, model, signal) {
  const response = await fetch(`${baseUrl}/api/tags`, { signal });
  if (!response.ok) throw new Error(`Ollama status HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.models || []).some((item) => item.name === model || item.model === model);
}

export async function ensureLocalDetailRuntime({ rootDir, model, signal, onLog }) {
  const baseUrl = 'http://127.0.0.1:11435';
  try {
    if (await available(baseUrl, model, signal)) return baseUrl;
    throw new Error(`Local model ${model} is not installed`);
  } catch (initialError) {
    if (signal?.aborted) throw new Error('cancelled');
    const { binary, models } = localDetailPaths(rootDir);
    if (!fs.existsSync(binary)) throw new Error(`Local Detail runtime missing: ${binary}`);
    fs.mkdirSync(models, { recursive: true });
    const child = spawn(binary, ['serve'], {
      cwd: path.dirname(binary), windowsHide: true, detached: true, stdio: 'ignore',
      env: { ...process.env, OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: models, OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_NO_CLOUD: '1' },
    });
    child.unref();
    onLog?.('[EDIT] Local Detail: starting private Ollama runtime…');
    let lastError = initialError;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (signal?.aborted) throw new Error('cancelled');
      await sleep(500);
      try {
        if (await available(baseUrl, model, signal)) return baseUrl;
        lastError = new Error(`Local model ${model} is not installed`);
        break;
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }
}

export async function generateLocalDetail({ rootDir, model, prompt, frames, signal, onLog }) {
  const baseUrl = await ensureLocalDetailRuntime({ rootDir, model, signal, onLog });
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildLocalDetailRequest({ model, prompt, frames })), signal,
  });
  if (!response.ok) throw new Error(`Local Detail HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  const payload = await response.json();
  // Qwen3-VL's Ollama renderer may place a JSON-only answer in `thinking`
  // even when think=false; accept either response field without altering it.
  const content = String(payload?.message?.content || payload?.message?.thinking || '').trim();
  if (!content) throw new Error('Local Detail returned empty response');
  onLog?.(`[EDIT TIMING] Local Detail AI: ${((Date.now() - started) / 1000).toFixed(2)}s`);
  return { content, metrics: { totalSec: Number(payload.total_duration || 0) / 1e9, loadSec: Number(payload.load_duration || 0) / 1e9, promptTokens: Number(payload.prompt_eval_count || 0), outputTokens: Number(payload.eval_count || 0) } };
}

export const localDetailPrompt = ({ duration, userPrompt, sceneCuts }) => `
You are creating a LOCAL experimental Detail framing plan for one ${duration.toFixed(2)} second landscape-video excerpt. You receive chronological JPEG samples, not audio. Use only visible evidence; do not invent dialogue, speaker names, or unseen events.
User editing intent: ${String(userPrompt || '').slice(0, 2000)}
(Note: this is a ${duration.toFixed(0)}s test excerpt of the video; ignore any instruction to split into multiple long episodes. Output exactly one segment covering 0.0 through ${duration.toFixed(1)}.)
Candidate local scene cuts: ${(sceneCuts || []).map((t) => Number(t).toFixed(1)).join(', ') || 'none'}.

Return one JSON object, then stop. summary is one sentence of at most 20 words. Exactly one segment covering 0.0 through ${duration.toFixed(1)}. Use at least 2 and at most 8 frames. Each frame must last at least 2 seconds, with a different start and end, and together they cover the excerpt without gaps or overlap. Do not emit a series of 0.5 second slices. Do not repeat a window. A FILL frame must include finite cx and cy at the face. why must name what is visible in that window; do not copy these instructions.

frames[] must cover the entire excerpt without gaps. A window is one continuous framing decision. Split on hard cuts, composition/layout changes, meaningful focal-subject changes, reaction shots, inserts, or when the subject controlling the crop changes—even if the room/background stays the same. Do not split for tiny gestures.
FILL when one visible focal subject dominates and a useful medium crop preserves everything needed for the current visual beat. Include finite cx/cy at the center of that subject's face. CONTAIN only when a reasonable subject crop would materially lose simultaneous action/reaction, important prop/text/reveal, group/spatial context, or when the source is already too tight. Another visible subject alone is not enough for CONTAIN. Do not force a ratio or alternate modes.
track[] supplies visual position hints at every FILL start and when its focal subject/position changes. Use who="" because audio and identity are unavailable. Coordinates are normalized source-frame values 0..1. Never aim at a prop/screen. Do not claim to hear speech.
`;
