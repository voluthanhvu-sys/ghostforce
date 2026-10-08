const finite = (value) => Number.isFinite(Number(value));

const validPieces = (part = {}) => {
  const source = Array.isArray(part.pieces) && part.pieces.length
    ? part.pieces
    : (Array.isArray(part.ranges) && part.ranges.length ? part.ranges : [[part.start, part.end]]);
  return source.map((piece) => {
    const start = Number(Array.isArray(piece) ? piece[0] : piece?.start);
    const end = Number(Array.isArray(piece) ? piece[1] : piece?.end);
    return { start, end };
  }).filter((piece) => finite(piece.start) && finite(piece.end) && piece.end > piece.start);
};

const mapSourceIntervalsToPart = (part, items, readStart, readEnd, project) => {
  const pieces = validPieces(part);
  const out = [];
  let offset = 0;
  for (const piece of pieces) {
    const pieceDuration = piece.end - piece.start;
    for (const item of Array.isArray(items) ? items : []) {
      const itemStart = Number(readStart(item));
      const itemEnd = Number(readEnd(item));
      if (!finite(itemStart) || !finite(itemEnd) || itemEnd <= itemStart) continue;
      const clippedStart = Math.max(piece.start, itemStart);
      const clippedEnd = Math.min(piece.end, itemEnd);
      if (clippedEnd <= clippedStart) continue;
      out.push(project(item, offset + clippedStart - piece.start, offset + clippedEnd - piece.start));
    }
    offset += pieceDuration;
  }
  return out.sort((a, b) => (a.t ?? a.start) - (b.t ?? b.start));
};

export const mapWordsToPartTimeline = (part, words) => mapSourceIntervalsToPart(
  part,
  words,
  (word) => word?.t ?? word?.start,
  (word) => word?.end,
  (word, t, end) => ({ ...word, t, end }),
);

export const mapDiarizationToPartTimeline = (part, turns) => mapSourceIntervalsToPart(
  part,
  turns,
  (turn) => turn?.start,
  (turn) => turn?.end,
  (turn, start, end) => ({ start, end, speakerId: String(turn?.speakerId || '') }),
).filter((turn) => turn.speakerId);

const addReason = (events, duration, time, reason) => {
  const t = Number(time);
  if (!finite(t) || !finite(duration) || duration <= 0) return;
  const safe = Math.min(Math.max(0, t), Math.max(0, duration - 0.001));
  events.push({ t: safe, reason });
};

const speechRuns = (words, gap) => {
  const valid = (Array.isArray(words) ? words : []).map((word) => ({
    start: Number(word?.t ?? word?.start),
    end: Number(word?.end),
  })).filter((word) => finite(word.start) && finite(word.end) && word.end > word.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const runs = [];
  for (const word of valid) {
    const last = runs[runs.length - 1];
    if (!last || word.start - last.end > gap) runs.push({ ...word });
    else last.end = Math.max(last.end, word.end);
  }
  return runs;
};

const mergeNearbyEvents = (events, epsilon) => {
  const sorted = events.sort((a, b) => a.t - b.t || a.reason.localeCompare(b.reason));
  const merged = [];
  for (const event of sorted) {
    const last = merged[merged.length - 1];
    if (last && event.t - last.t <= epsilon) {
      if (!last.reasons.includes(event.reason)) last.reasons.push(event.reason);
      continue;
    }
    merged.push({ t: event.t, reasons: [event.reason] });
  }
  return merged;
};

const REASON_PRIORITY = new Map([
  ['part-start', 0],
  ['part-end', 0],
  ['scene-cut-before', 1],
  ['scene-cut-after', 1],
  ['dialogue-start', 2],
  ['dialogue-end', 2],
  ['speaker-change', 3],
  ['speaker-change-before', 4],
  ['speaker-change-after', 4],
  ['periodic-safety', 5],
]);

const eventPriority = (event) => Math.min(
  ...event.reasons.map((reason) => REASON_PRIORITY.get(reason) ?? 6),
);

const evenlySelect = (events, count) => {
  if (count >= events.length) return events;
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => (
    events[Math.floor(((i + 0.5) * events.length) / count)]
  ));
};

const capEvidenceEvents = (events, maxSamples) => {
  const cap = Math.max(1, Math.floor(Number(maxSamples) || 72));
  if (events.length <= cap) return events;
  const selected = [];
  for (let priority = 0; priority <= 6 && selected.length < cap; priority += 1) {
    const group = events.filter((event) => eventPriority(event) === priority);
    selected.push(...evenlySelect(group, cap - selected.length));
  }
  return selected.sort((a, b) => a.t - b.t);
};

export const buildDetailEvidenceTimes = ({
  duration,
  sceneCuts = [],
  words = [],
  diarTurns = [],
  eventOffset = 0.2,
  dialogueGap = 0.75,
  dedupeEpsilon = 0.12,
  maxObservationGap = 6,
  maxSamples = 72,
} = {}) => {
  const dur = Number(duration);
  if (!finite(dur) || dur <= 0) return [];
  const events = [];
  addReason(events, dur, Math.min(0.05, dur / 2), 'part-start');
  addReason(events, dur, dur - Math.min(0.05, dur / 2), 'part-end');

  for (const rawCut of Array.isArray(sceneCuts) ? sceneCuts : []) {
    const cut = Number(rawCut);
    if (!finite(cut) || cut <= 0 || cut >= dur) continue;
    addReason(events, dur, cut - eventOffset, 'scene-cut-before');
    addReason(events, dur, cut + eventOffset, 'scene-cut-after');
  }

  const turns = (Array.isArray(diarTurns) ? diarTurns : []).map((turn) => ({
    start: Number(turn?.start),
    end: Number(turn?.end),
    speakerId: String(turn?.speakerId || ''),
  })).filter((turn) => finite(turn.start) && finite(turn.end) && turn.end > turn.start && turn.speakerId)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < turns.length; i += 1) {
    if (turns[i - 1].speakerId === turns[i].speakerId) continue;
    const transition = Math.max(turns[i].start, Math.min(turns[i - 1].end, turns[i].start));
    addReason(events, dur, transition - eventOffset, 'speaker-change-before');
    addReason(events, dur, transition, 'speaker-change');
    addReason(events, dur, transition + eventOffset, 'speaker-change-after');
  }

  for (const run of speechRuns(words, dialogueGap)) {
    addReason(events, dur, run.start, 'dialogue-start');
    addReason(events, dur, run.end, 'dialogue-end');
  }

  let merged = mergeNearbyEvents(events, dedupeEpsilon);
  const safety = [];
  for (let i = 1; i < merged.length; i += 1) {
    const left = merged[i - 1].t;
    const right = merged[i].t;
    const gap = right - left;
    if (gap <= maxObservationGap) continue;
    const count = Math.ceil(gap / maxObservationGap) - 1;
    const step = gap / (count + 1);
    for (let j = 1; j <= count; j += 1) addReason(safety, dur, left + step * j, 'periodic-safety');
  }
  merged = mergeNearbyEvents([...merged.flatMap((event) => event.reasons.map((reason) => ({ t: event.t, reason }))), ...safety], dedupeEpsilon);
  return capEvidenceEvents(merged, maxSamples);
};

const compactText = (value, limit) => String(value || '')
  .replace(/[\t\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

export const buildDetailMultimodalRequest = ({ prompt, evidenceText, frames } = {}) => {
  const parts = [
    { text: String(prompt || '') },
    { text: `PART-LOCAL EVIDENCE: ${compactText(evidenceText, 60000)}` },
  ];
  for (const frame of Array.isArray(frames) ? frames : []) {
    const t = Number(frame?.t);
    const jpeg = frame?.jpeg;
    if (!Number.isFinite(t) || !Buffer.isBuffer(jpeg) || !jpeg.length) continue;
    const reasons = (Array.isArray(frame.reasons) ? frame.reasons : [])
      .map((reason) => compactText(reason, 80))
      .filter(Boolean)
      .join(', ');
    parts.push({ text: `[FRAME t=${t.toFixed(3)}s reasons=${reasons || 'visual-safety'}]` });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } });
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  };
};
