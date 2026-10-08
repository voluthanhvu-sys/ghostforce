// Pure editor-plan parsing and normalization. Keep API/network/process logic out of this module.
export const evenSplitPlan = (duration, maxParts, minSec, autoParts = false) => {
    const dur = Math.max(0, Number(duration) || 0);
    const min = Math.max(8, Number(minSec) || 60);
    const cap = Math.max(1, Math.min(12, Number(maxParts) || 6));
    let n = autoParts
        ? Math.max(1, Math.min(cap, Math.max(1, Math.floor(dur / min))))
        : Math.max(1, Math.min(cap, Number(maxParts) || 6));
    while (n > 1 && dur / n < min) n -= 1;
    const len = dur / n;
    return Array.from({ length: n }, (_, i) => ({
        start: Math.round(i * len * 10) / 10,
        end: Math.round((i === n - 1 ? dur : (i + 1) * len) * 10) / 10,
        name: `part-${i + 1}`,
        reason: autoParts ? 'auto even' : 'even split',
    }));
};

export const round1 = (n) => Math.round(Number(n) * 10) / 10;

export const parseOnePiece = (r, dur) => {
    let a, b, role = '';
    if (Array.isArray(r) && r.length >= 2) {
        a = Number(r[0]); b = Number(r[1]); role = r[2] != null ? String(r[2]) : '';
    } else if (r && typeof r === 'object') {
        a = Number(r.start); b = Number(r.end); role = String(r.role || r.kind || '');
    } else return null;
    a = Math.max(0, a);
    b = Math.min(dur, b);
    if (!(b - a >= 0.4)) return null;
    return { start: round1(a), end: round1(b), role: role.replace(/\s+/g, ' ').trim().slice(0, 24) };
};

export const piecesFromSeg = (s, dur) => {
    const raw = s.pieces || s.script || s.keep || s.ranges;
    const out = [];
    if (Array.isArray(raw)) {
        for (const r of raw) {
            const p = parseOnePiece(r, dur);
            if (p) out.push(p);
        }
    }
    if (!out.length) {
        const p = parseOnePiece({ start: s.start, end: s.end }, dur);
        if (p) out.push({ ...p, role: p.role || 'body' });
    }
    return out;
};

export const scriptLabel = (pieces) => pieces.map((p) => {
    const tag = p.role ? `${p.role} ` : '';
    return `${tag}${p.start}–${p.end}`;
}).join(' > ');

const NON_SPEAKER_IDENTITIES = new Set([
    'none', 'null', 'unknown', 'nobody', 'speaker', 'narrator',
    'no speaker', 'no-speaker', 'no_speaker', 'not applicable', 'n/a',
]);

export const isSpeakerIdentity = (value) => {
    const name = String(value || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 48) return false;
    const normalized = name.toLowerCase();
    if (NON_SPEAKER_IDENTITIES.has(normalized)) return false;
    const words = name.split(' ');
    if (words.length < 1 || words.length > 4) return false;
    return words.every((word) => /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(word));
};

export const resolveSpeakerWho = ({ windowWho, trackWho } = {}) => {
    const value = [windowWho, trackWho].find(isSpeakerIdentity);
    return value == null ? undefined : String(value).trim().replace(/\s+/g, ' ');
};

// Cuts for a fill window. The first aim is the face at the window start.
// A later track point cuts at its own time when the person or the face position changes.
export const trackFillCuts = (window, track) => {
    const start = Number(window?.a);
    const end = Number(window?.b);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const points = (Array.isArray(track) ? track : [])
        .filter((point) => Number.isFinite(Number(point?.t)) && Number.isFinite(Number(point?.cx)))
        .map((point) => ({
            t: Number(point.t),
            cx: Number(point.cx),
            who: resolveSpeakerWho({ trackWho: point.who }) || '',
        }))
        .filter((point) => point.t >= start - 0.45 && point.t <= end + 0.05)
        .sort((a, b) => a.t - b.t);
    if (!points.length) return [];
    const cuts = [];
    const changed = (next, prev) => {
        if (!prev) return true;
        const whoChanged = next.who && prev.who && next.who.toLowerCase() !== prev.who.toLowerCase();
        return whoChanged || Math.abs(next.cx - prev.cx) > 0.13;
    };
    let current = null;
    const opening = [...points].reverse().find((point) => point.t <= start + 0.25);
    if (opening) {
        cuts.push({ t: start, cx: opening.cx, who: opening.who });
        current = opening;
    }
    for (const point of points) {
        if (point.t < start - 0.05) continue;
        if (!changed(point, current)) continue;
        cuts.push({ t: Math.min(end, Math.max(start, point.t)), cx: point.cx, who: point.who });
        current = point;
    }
    return cuts;
};

export const validSpeakerTrackPoints = (track) => (Array.isArray(track) ? track : [])
    .filter((point) => point && Number.isFinite(point.t) && isSpeakerIdentity(point.who));

export const shouldUsePerPartDetailPlan = ({ mode, tiktokMix, testSec, segmentCount, speechFraming } = {}) => (
    mode === 'ai' && Boolean(tiktokMix) && Number(testSec) <= 0 && Number(segmentCount) > 1 && !speechFraming
);

export const mergeSegmentDetail = (globalSegment, detailSegment) => {
    if (!globalSegment || !detailSegment) return globalSegment;
    return {
        ...globalSegment,
        frames: Array.isArray(detailSegment.frames) && detailSegment.frames.length
            ? detailSegment.frames
            : globalSegment.frames,
        track: Array.isArray(detailSegment.track) && detailSegment.track.length
            ? detailSegment.track
            : globalSegment.track,
    };
};

export const compactSceneCutHints = (sceneCuts, duration, maxHints = 80) => {
    const dur = Math.max(0, Number(duration) || 0);
    const limit = Math.max(1, Math.floor(Number(maxHints) || 80));
    const cuts = [...new Set((Array.isArray(sceneCuts) ? sceneCuts : [])
        .map((value) => Math.round(Number(value) * 10) / 10)
        .filter((value) => Number.isFinite(value) && value > 0.35 && (!dur || value < dur - 0.35)))]
        .sort((a, b) => a - b);
    if (cuts.length <= limit) return cuts;
    if (limit === 1) return [cuts[Math.floor(cuts.length / 2)]];
    return Array.from({ length: limit }, (_, index) => cuts[Math.round(index * (cuts.length - 1) / (limit - 1))]);
};

export const detailSceneCutGuidance = (sceneCuts, duration) => {
    if (!Array.isArray(sceneCuts)) return '';
    const cuts = compactSceneCutHints(sceneCuts, duration);
    const timestamps = cuts.length ? cuts.map((value) => value.toFixed(1)).join(', ') : 'none detected';
    return `
DETAIL SHOT-AWARE FRAMING:
Candidate visual shot boundaries (seconds, local to this excerpt): ${timestamps}.
These are hints, not mandatory cuts. Re-evaluate CONTAIN versus FILL at every candidate boundary and also at composition changes, reaction shots, speaker-focus changes, object reveals, visual-gag/action onset, or major camera movement.
Merge across a candidate boundary only when the crop decision remains the same AND cropping preserves the same important visual information on both sides.
Do not create more FILL merely to increase density. Use CONTAIN when cropping one subject would lose important action, reaction, object, text, joke, or spatial context. Use FILL when one subject clearly dominates and cropping loses no relevant visual information.
`;
};

export const detailSemanticFramingGuidance = () => `
FRAMING — required. 9:16 mix of WIDE vs CLOSE. Re-evaluate framing often, but let scene semantics and visual-information preservation determine the mode.
1) frames[] covers the WHOLE episode, no gaps. Same source timestamps as start/end.
   DETAIL VISUAL SHOT SEGMENTATION: independently watch the video for every meaningful visual shot boundary: hard cut, camera-angle change, composition change, reaction shot, subject-layout change, insert/object shot, or focal-subject change.
   Whenever such a meaningful visual boundary occurs, start a NEW frames[] window and independently classify that new shot as FILL or CONTAIN. The mode may remain the same across the boundary: same mode does NOT mean same shot, and same story/context does NOT mean same shot. Never merge visually distinct shots merely because their framing mode is unchanged.
   DETAIL DIALOGUE SEGMENTATION: one frames[] window represents ONE visually continuous shot/composition, never an entire conversation, topic, or story beat. During dialogue, every new camera angle, visible speaker-focus change, reaction shot, composition/layout change, or cut to another puppet/person MUST start a new frames[] window even when the topic is unchanged, the mode remains the same, or everyone remains in the same room. Never use "back-and-forth argument", "conversation continues", or "group discussion" to justify one window spanning multiple visually distinct shots. For multi-shot dialogue, independently classify EACH shot as FILL or CONTAIN.
   Candidate sceneCuts are supplementary trusted anchors for obvious cuts, not an exhaustive boundary list. Also identify meaningful visual/composition boundaries that are NOT listed in sceneCuts; visual segmentation must not depend solely on those hints.
   Boundaries must come from observed visual changes. Do not use fixed-duration slicing, arbitrary segmentation, forced alternation, a target window count, or a target FILL/CONTAIN percentage.
   contain = WIDE (full 16:9 small in 9:16 + blur bars). Use CONTAIN for crowds, inserts, CCTV/laptop/poster/calendar views, prop-only shots, source shots already visually tight, or whenever cropping would lose relevant visual information.
   fill = MEDIUM 1:1 crop (head + shoulders + chest). A speaker or two-shot alone determines neither FILL nor CONTAIN.
   FILL: choose FILL when one subject is the clear focal point of the current shot AND a reasonable subject crop preserves all information necessary to understand the current beat.
   CONTAIN: choose CONTAIN only when important information necessary to understand the current shot would actually fall outside a reasonable subject crop.
   The mere presence of another person, prop/object, background context, movement, reaction, or spatial context is NOT enough by itself to require CONTAIN. Use CONTAIN only when losing it would materially hurt understanding of the action, joke, reaction, relationship, reveal, or visual beat.
   TWO-SHOT: the two-shot alone determines neither mode. Use FILL when one person is clearly focal, the second person is not needed to understand the beat, and a reasonable crop preserves the meaning. Use CONTAIN when both expressions/actions are simultaneously necessary, their interaction is the beat/joke, important action spans both sides, or the crop would materially remove needed information.
   REACTION: use FILL for an isolated reaction when the reacting subject is clearly focal. Use CONTAIN when the reaction and its cause/action must be visible together to understand the moment.
   DIALOGUE GUARD: in normal dialogue with 1–2 visible puppets, FILL the speaking/focal puppet when a useful medium crop exists; do not mark the whole interaction CONTAIN merely because another puppet is visible. With 3 visible puppets, generally FILL the active speaker when a useful medium crop exists; three puppets alone is NOT sufficient reason for CONTAIN, and a three-shot/group shot alone is NOT sufficient reason to keep an entire dialogue sequence CONTAIN. Use CONTAIN only for the exact interval where multiple subjects, simultaneous actions, or spatial context must remain visible together. When that group beat transitions to one focal speaker or an isolated reaction, start a NEW frames[] window and use FILL when a useful medium crop exists. Do not carry CONTAIN across multiple speaker turns merely because the physical camera composition does not cut or change. Split at each meaningful focal-subject change even within the same camera shot. Preserve CONTAIN for genuine group reactions, multi-person action, CCTV/inserts, important props or weapons, and necessary spatial context.
   WIDE-ONLY EXCEPTIONS: reserve CONTAIN for genuine wide/context needs such as a crowd or many puppets whose necessary context would be lost, an establishing/context shot, CCTV/laptop/poster/calendar/prop-only insert, a genuinely off-camera speaker, or a source shot already so tight that further cropping is harmful.
   ANTI-DEGENERATE CHECK: do NOT return an all-CONTAIN plan for a normal dialogue segment. All-CONTAIN is allowed only when essentially the entire segment genuinely consists of the WIDE-ONLY EXCEPTIONS above. Before returning JSON, if frames[] contains zero FILL windows, re-check whether the segment truly qualifies as wide-only; if ordinary visible dialogue exists, create the appropriate FILL window(s).
   DETAIL WHY CONTRACT: EVERY frames[] object MUST include a non-empty "why" based on concrete visible evidence. For FILL, briefly name the focal subject or visual beat. For CONTAIN, state exactly what important visual information a reasonable medium crop would lose. "Another puppet is visible" is NOT a sufficient CONTAIN reason. Vague reasons such as "context", "wide shot", "conversation", "scene", or "multiple characters" alone are insufficient.
   Detail frames[] mini-example: [{"start":0.0,"end":4.2,"mode":"contain","why":"both puppets' simultaneous reaction is required"},{"start":4.2,"end":8.0,"mode":"fill","cx":0.73,"cy":0.40,"why":"Jeffy is the focal speaker"}]
   At EVERY candidate scene cut, make a fresh independent framing classification for the new shot itself. Do not inherit CONTAIN merely because the story or context is similar. The mode may remain the same across the cut only because the new shot independently satisfies the same decision. This requires fresh classification, not a mandatory FILL, CONTAIN, mode change, or split.
   HARD: speaker is NOT in this camera shot → CONTAIN.
   HARD: chips / cups / bottles / roulette / signage / black empty / calendar paper insert → CONTAIN.
   HARD: source already close-up / laptop / poster / CCTV → CONTAIN. Do not fill again.
   HARD: Never aim fill at a glowing laptop/monitor/flashlight/calendar. Fill a clearly dominant visible subject's FACE.
   HARD: one fill window = ONE subject. If the dominant subject changes, start a new fill window at that frame. Min fill 1.2s. Instant cut, no pan.
   HARD: contain windows stay wide. Only FILL hunts the subject.
2) track[] required: one point about every 0.4 seconds during FILL, and another point at the instant the heard speaker or the face position changes. During contain, one point about every 2 seconds is enough.
   {"t":12.4,"cx":0.22,"cy":0.44,"who":"Brooklyn"}
   cx,cy = center of the relevant subject's FACE in the SOURCE frame (0=left/top, 1=right/bottom).
   who = name of the voice you HEAR at t, not the largest puppet.
   NEVER default cx=0.5 unless that face is actually in the middle.
   NEVER set cx to a cup, bottle, chips, poster, laptop, or the brightest blob.
   Left subject ≈ 0.18–0.32, center ≈ 0.42–0.58, right ≈ 0.68–0.85.
   Different speaker = new point at that INSTANT with the NEW face. Same speaker = hold the same cx. Camera must CUT, never slide.
`;

const clipAwayRanges = (start, end, blockers) => {
    let parts = [{ start, end }];
    for (const block of blockers) {
        const next = [];
        for (const part of parts) {
            if (block.end <= part.start || block.start >= part.end) {
                next.push(part);
                continue;
            }
            if (block.start > part.start) next.push({ start: part.start, end: block.start });
            if (block.end < part.end) next.push({ start: block.end, end: part.end });
        }
        parts = next;
    }
    return parts.filter((part) => part.end - part.start >= 0.35);
};

export const speechLinesForUnresolvedTurns = (ambiguousTurns, mappedTurns, words) => {
    const blockers = (Array.isArray(mappedTurns) ? mappedTurns : [])
        .map((turn) => ({ start: Number(turn?.start), end: Number(turn?.end) }))
        .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start);
    const turns = [];
    for (const turn of Array.isArray(ambiguousTurns) ? ambiguousTurns : []) {
        const start = Number(turn?.start);
        const end = Number(turn?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || !turn?.speakerId) continue;
        for (const part of clipAwayRanges(start, end, blockers)) {
            turns.push({ start: part.start, end: part.end, speakerId: turn.speakerId });
        }
    }
    return speechLinesFromDiarizedTurns(turns, words);
};

const FILL_CX_MIN = 0.12;
const FILL_CX_MAX = 0.88;

const usableFillCx = (cx) => {
    const n = Number(cx);
    return Number.isFinite(n) && n >= FILL_CX_MIN && n <= FILL_CX_MAX ? n : null;
};

const medianCx = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
};

const trackTalkSpans = (track, window) => {
    const points = (Array.isArray(track) ? track : [])
        .filter((point) => point && Number.isFinite(Number(point.t)))
        .map((point) => ({ t: Number(point.t), who: String(point.who || '').trim(), cx: usableFillCx(point.cx) }))
        .filter((point) => point.t >= window.a - 0.2 && point.t <= window.b + 0.2 && (point.who || point.cx != null))
        .sort((a, b) => a.t - b.t);
    const spans = [];
    for (const point of points) {
        const last = spans[spans.length - 1];
        if (last && last.who === point.who && point.t - last.lastT <= 3) {
            last.lastT = point.t;
            last.end = Math.max(last.end, Math.min(window.b, point.t + 1.6));
            if (point.cx != null) last.cxs.push(point.cx);
            continue;
        }
        spans.push({
            t: Math.max(window.a, point.t),
            end: Math.min(window.b, point.t + 1.6),
            lastT: point.t,
            who: point.who,
            cxs: point.cx == null ? [] : [point.cx],
        });
    }
    return spans
        .map((span) => ({ t: span.t, end: span.end, who: span.who, cx: medianCx(span.cxs) }))
        .filter((span) => span.cx != null && span.end - span.t >= 0.65);
};

const aimForSpeechLine = (line, track) => {
    const own = usableFillCx(line.cx);
    if (own != null) return own;
    const tracked = medianCx((Array.isArray(track) ? track : [])
        .filter((point) => Number(point?.t) >= line.t - 0.2 && Number(point?.t) <= line.end + 0.2)
        .map((point) => usableFillCx(point.cx))
        .filter((cx) => cx != null));
    if (tracked != null) return tracked;
    if (!Number.isFinite(Number(line.cx))) return undefined;
    return null;
};

const containTalkSources = (window, talk, track) => {
    const spans = trackTalkSpans(track, window);
    const lines = [];
    for (const line of talk) {
        if (!(line.end > window.a + 0.3 && line.t < window.b - 0.3)) continue;
        const covered = spans.some((span) => line.end > span.t + 0.3 && line.t < span.end - 0.3);
        if (covered) continue;
        const cx = aimForSpeechLine(line, track);
        if (cx === null) continue;
        lines.push({ t: line.t, end: line.end, who: line.who, cx });
    }
    return [...spans, ...lines].sort((a, b) => a.t - b.t);
};

export const balanceDetailWindows = (windows, speech, track = []) => {
    const talk = (Array.isArray(speech) ? speech : [])
        .filter((line) => line && Number.isFinite(line.t) && Number.isFinite(line.end) && line.end - line.t >= 0.65 && line.who)
        .sort((a, b) => a.t - b.t);
    const out = [];
    const push = (window) => {
        if (window.b - window.a >= 0.45) out.push(window);
    };
    for (const window of Array.isArray(windows) ? windows : []) {
        const length = Number(window.b) - Number(window.a);
        if (!(length > 22)) {
            push(window);
            continue;
        }
        if (window.mode === 'fill') {
            let t = window.a;
            while (t < window.b - 0.4) {
                const fillEnd = Math.min(window.b, t + 14);
                push({ ...window, a: t, b: fillEnd, mode: 'fill' });
                t = fillEnd;
                if (t >= window.b - 0.4) break;
                const wideEnd = Math.min(window.b, t + 7);
                push({ ...window, a: t, b: wideEnd, mode: 'contain', who: '', why: 'balance wide' });
                t = wideEnd;
            }
            continue;
        }
        const sources = containTalkSources(window, talk, track);
        if (!sources.length) {
            push(window);
            continue;
        }
        let cursor = window.a;
        for (const line of sources) {
            let start = Math.max(window.a, cursor, line.t);
            const limit = Math.min(window.b, line.end);
            while (start < limit - 0.64) {
                const fillEnd = Math.min(limit, start + 12);
                if (fillEnd - start < 0.65) break;
                if (start - cursor >= 0.5) push({ ...window, a: cursor, b: start, mode: 'contain', who: '', why: window.why });
                const fill = { ...window, a: start, b: fillEnd, mode: 'fill', who: line.who, why: line.who || window.why };
                if (Number.isFinite(line.cx)) fill.cx = line.cx;
                push(fill);
                cursor = fillEnd;
                if (limit - cursor < 0.65) break;
                const wideEnd = Math.min(limit, cursor + 7);
                if (wideEnd - cursor < 0.5 || limit - wideEnd < 0.65) break;
                push({ ...window, a: cursor, b: wideEnd, mode: 'contain', who: '', why: 'balance wide' });
                cursor = wideEnd;
                start = cursor;
            }
        }
        if (window.b - cursor >= 0.5) push({ ...window, a: cursor, b: window.b, mode: 'contain', who: '', why: window.why });
    }
    return out;
};

export const speechFramingContainReason = (sample) => {
    if (!sample) return '';
    const peaks = Array.isArray(sample.peaks) ? sample.peaks.length : 0;
    if (peaks >= 5) return 'group shot';
    if (sample.closeup && !sample.twoShot) return 'already close-up';
    const ratio = Number(sample.puppetRatio);
    const faceH = Number(sample.faceH);
    if (Number.isFinite(ratio) && ratio < 0.08 && (!Number.isFinite(faceH) || faceH < 0.22)) return 'no clear face';
    return '';
};

export const speechLinesFromDiarizedTurns = (turns, words) => {
    const labels = new Map();
    const labelFor = (speakerId) => {
        const key = String(speakerId || '');
        if (!labels.has(key)) labels.set(key, `Voice ${String.fromCharCode(65 + labels.size)}`);
        return labels.get(key);
    };
    const lines = [];
    for (const turn of Array.isArray(turns) ? turns : []) {
        const start = Number(turn?.start);
        const end = Number(turn?.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.35 || !turn?.speakerId) continue;
        const text = (Array.isArray(words) ? words : [])
            .filter((word) => {
                const mid = (Number(word?.t) + Number(word?.end)) / 2;
                return Number.isFinite(mid) && mid >= start - 0.12 && mid <= end + 0.12;
            })
            .map((word) => String(word.word || '').trim())
            .filter(Boolean)
            .join(' ')
            .slice(0, 140);
        const previous = lines[lines.length - 1];
        const who = labelFor(turn.speakerId);
        if (previous && previous.who === who && start <= previous.end + 0.4) {
            previous.end = Math.max(previous.end, end);
            if (text) previous.text = `${previous.text} ${text}`.trim().slice(0, 140);
        } else {
            lines.push({ t: start, end, who, text });
        }
    }
    return lines;
};

export const parseSpeechLines = (parsed, duration) => {
    const arr = (parsed && (parsed.lines || parsed.speech || parsed.utterances)) || [];
    const dur = Math.max(0.2, Number(duration) || 0);
    const out = [];
    for (const line of arr) {
        if (!line) continue;
        const t = Number(line.t ?? line.start ?? line.begin);
        let end = Number(line.end ?? line.stop);
        const rawWho = String(line.who || line.speaker || '').trim().slice(0, 48);
        const who = isSpeakerIdentity(rawWho) ? rawWho : undefined;
        if (!Number.isFinite(t)) continue;
        if (!Number.isFinite(end) || end <= t) end = t + 1.4;
        const rec = {
            t: Math.max(0, Math.min(dur, t)),
            end: Math.max(0, Math.min(dur, end)),
            text: String(line.text || line.line || '').slice(0, 140),
        };
        if (who) rec.who = who;
        const cx = Number(line.cx);
        const cy = Number(line.cy);
        if (Number.isFinite(cx)) rec.cx = Math.min(0.92, Math.max(0.08, cx));
        if (Number.isFinite(cy)) rec.cy = Math.min(0.72, Math.max(0.20, cy));
        out.push(rec);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
};

export const sourceTimeForTrackPoint = (pieces, trackTime, fallbackStart = 0) => {
    const t = Number(trackTime);
    const valid = (Array.isArray(pieces) ? pieces : [])
        .map((p) => ({ start: Number(p?.start), end: Number(p?.end) }))
        .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start);
    if (!Number.isFinite(t) || valid.length <= 1) return Number(fallbackStart) + t;
    let accumulated = 0;
    for (let i = 0; i < valid.length; i++) {
        const piece = valid[i];
        const duration = piece.end - piece.start;
        if (t < accumulated + duration || (i === valid.length - 1 && t <= accumulated + duration)) {
            return piece.start + Math.max(0, t - accumulated);
        }
        accumulated += duration;
    }
    return Number(fallbackStart) + t;
};

// `contain`/`fill` are the SML framing pair (letterbox wide / 1:1 close).
// `focus`/`pip`/`split` are the general-content 9:16 framing: subject crop,
// subject crop + corner inset for a second event, and a top/bottom split.
export const FRAME_MODES = new Set(['contain', 'fill', 'focus', 'pip', 'split']);

export const normalizeFrameMode = (raw) => {
    const m = String(raw || '').toLowerCase();
    // The corner window is retired: any second person/event becomes the top/bottom
    // split (one camera per half). Older plans that still say pip are mapped to it.
    if (/split|chia đôi|chia doi|vstack|top.?bottom|trên dưới|tren duoi|2 ?cam|two.?cam/.test(m)) return 'split';
    if (/pip|picture.?in.?picture|cửa sổ|cua so|inset|inlay|second.?cam|cam phụ|cam phu/.test(m)) return 'split';
    if (/focus|tiêu điểm|tieu diem|subject|9:16|9x16|theo chủ thể|theo chu the|smart.?crop/.test(m)) return 'focus';
    if (/fill|close|tight|crop|cận|zoom/.test(m)) return 'fill';
    if (/contain|wide|fit|letter|rộng|full.?body|establish/.test(m)) return 'contain';
    return '';
};

export const stitchFrames = (windows, epDur, sceneCuts = null) => {
    const dur = Math.max(0.2, Number(epDur) || 0);
    const detailMode = Array.isArray(sceneCuts);
    const list = (Array.isArray(windows) ? windows : [])
        .filter((w) => w && FRAME_MODES.has(w.mode) && Number(w.b) - Number(w.a) >= 0.6)
        .map((w) => ({
            a: round1(w.a),
            b: round1(w.b),
            mode: w.mode,
            why: String(w.why || '').slice(0, 80),
            cx: w.cx,
            cy: w.cy,
            cx2: w.cx2,
            cy2: w.cy2,
        }))
        .sort((a, b) => a.a - b.a);
    if (!list.length) return [];
    const twoCam = (mode) => mode === 'split' || mode === 'pip';
    const out = [];
    for (const w of list) {
        const last = out[out.length - 1];
        const a = Math.max(0, w.a);
        const b = Math.min(dur, w.b);
        if (b - a < 0.7) continue;
        if (!last) {
            // A split must not be pulled back over the opening of the part.
            // Focus/contain/fill still cover from 0 so a part does not start unaimed.
            out.push({
                a: twoCam(w.mode) ? a : 0,
                b,
                mode: w.mode,
                why: w.why,
                cx: w.cx,
                cy: w.cy,
                cx2: w.cx2,
                cy2: w.cy2,
            });
            continue;
        }
        // Do not grow a split across the gap in front of the next window.
        // That turned a 2s two-shot into a split that ran until the next frame.
        if (a > last.b + 0.12 && !twoCam(last.mode)) last.b = round1(a);
        const secondClose = !twoCam(last.mode) || (
            Math.abs((Number.isFinite(Number(last.cx2)) ? Number(last.cx2) : -1) - (Number.isFinite(Number(w.cx2)) ? Number(w.cx2) : -2)) < 0.08
            && Math.abs((Number.isFinite(Number(last.cy2)) ? Number(last.cy2) : -1) - (Number.isFinite(Number(w.cy2)) ? Number(w.cy2) : -2)) < 0.08
        );
        const sameAim = last.mode === w.mode
            && last.mode !== 'fill'
            && secondClose
            && Math.abs((last.cx ?? 0.5) - (w.cx ?? 0.5)) < 0.08
            && Math.abs((last.cy ?? 0.42) - (w.cy ?? 0.42)) < 0.08;
        if (sameAim && !detailMode) {
            last.b = round1(Math.max(last.b, b));
            if (w.why && !last.why) last.why = w.why;
            // Never copy the main subject onto camera 2. A missing cx2 used to
            // become cx, so both halves framed the same person.
            if (Number.isFinite(Number(w.cx2))) last.cx2 = w.cx2;
            if (Number.isFinite(Number(w.cy2))) last.cy2 = w.cy2;
        } else {
            out.push({
                a: round1(Math.max(last.b, a)),
                b: round1(b),
                mode: w.mode,
                why: w.why,
                cx: w.cx,
                cy: w.cy,
                cx2: w.cx2,
                cy2: w.cy2,
            });
        }
    }
    if (out.length && out[out.length - 1].b < dur - 0.15 && !twoCam(out[out.length - 1].mode)) {
        out[out.length - 1].b = round1(dur);
    }
    return out.filter((w) => w.b - w.a >= 0.8);
};

export const clamp01 = (n, fallback) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    if (v > 1 && v <= 100) return Math.max(0.05, Math.min(0.95, v / 100));
    if (v < 0 || v > 1) return fallback;
    return Math.max(0.05, Math.min(0.95, v));
};

export const parseFraming = (s, epStart, epEnd, sceneCuts = null) => {
    const raw = (s && (s.frames || s.framing || s.shots || s.layout)) || [];
    if (!Array.isArray(raw) || !raw.length) return [];
    const epDur = Math.max(0.2, epEnd - epStart);
    const items = [];
    for (const f of raw) {
        let a, b, mode, why = '', cx, cy, cx2, cy2;
        if (Array.isArray(f) && f.length >= 2) {
            a = Number(f[0]); b = Number(f[1]); mode = normalizeFrameMode(f[2]); why = String(f[3] || '');
        } else if (f && typeof f === 'object') {
            a = Number(f.start ?? f.from ?? f.t0);
            b = Number(f.end ?? f.to ?? f.t1);
            mode = normalizeFrameMode(f.mode || f.kind || f.framing || f.type);
            why = String(f.why || f.reason || '');
            cx = clamp01(f.cx ?? f.x, NaN);
            cy = clamp01(f.cy ?? f.y, NaN);
            // No fallback to cx/cy: a window without an explicit second-subject
            // position must stay "no second camera", so the focus renderer can
            // degrade a pip/split window instead of aiming camera 2 at camera 1.
            cx2 = clamp01(f.cx2 ?? f.x2, NaN);
            cy2 = clamp01(f.cy2 ?? f.y2, NaN);
        } else continue;
        if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < 0.6 || !mode) continue;
        items.push({
            a, b, mode, why,
            cx: Number.isFinite(cx) ? cx : undefined,
            cy: Number.isFinite(cy) ? cy : undefined,
            cx2: Number.isFinite(cx2) ? cx2 : undefined,
            cy2: Number.isFinite(cy2) ? cy2 : undefined,
        });
    }
    if (!items.length) return [];
    const looksAbs = epStart > 1.5 && items.some((x) => x.a >= epStart - 0.6 && x.a <= epEnd + 0.6);
    const local = items.map((x) => {
        let a = x.a;
        let b = x.b;
        if (looksAbs) { a -= epStart; b -= epStart; }
        return { ...x, a: Math.max(0, a), b: Math.min(epDur, b) };
    });
    return stitchFrames(local, epDur, sceneCuts);
};

// How much of a part a Detail plan actually describes (0..1). A plan that covers
// only its opening seconds leaves the rest of the crop unaimed, which is the
// failure the operator keeps seeing (measured: 19 % of a 134 s part).
export const framesCoverage = (frames, duration) => {
    const dur = Math.max(0.001, Number(duration) || 0);
    const list = (Array.isArray(frames) ? frames : [])
        .map((frame) => ({
            a: Math.max(0, Math.min(dur, Number(frame?.a ?? frame?.start))),
            b: Math.max(0, Math.min(dur, Number(frame?.b ?? frame?.end))),
        }))
        .filter((frame) => Number.isFinite(frame.a) && Number.isFinite(frame.b) && frame.b > frame.a)
        .sort((x, y) => x.a - y.a);
    if (!list.length) return 0;
    let covered = 0;
    let cursor = 0;
    for (const frame of list) {
        const from = Math.max(cursor, frame.a);
        if (frame.b > from) {
            covered += frame.b - from;
            cursor = frame.b;
        }
    }
    return Math.max(0, Math.min(1, covered / dur));
};

export const parseSpeakerTrack = (s, epStart, epEnd) => {
    const raw = (s && (s.track || s.points || s.speakers)) || [];
    if (!Array.isArray(raw) || !raw.length) return [];
    const epDur = Math.max(0.2, epEnd - epStart);
    const items = [];
    for (const p of raw) {
        let t, cx, cy, who = '', cx2, cy2, who2 = '';
        if (Array.isArray(p) && p.length >= 3) {
            t = Number(p[0]); cx = clamp01(p[1], NaN); cy = clamp01(p[2], NaN); who = String(p[3] || '');
            cx2 = clamp01(p[4], NaN); cy2 = clamp01(p[5], NaN); who2 = String(p[6] || '');
        } else if (p && typeof p === 'object') {
            t = Number(p.t ?? p.time ?? p.start);
            cx = clamp01(p.cx ?? p.x, NaN);
            cy = clamp01(p.cy ?? p.y, NaN);
            who = String(p.who || p.speaker || p.name || '').slice(0, 24);
            cx2 = clamp01(p.cx2 ?? p.x2, NaN);
            cy2 = clamp01(p.cy2 ?? p.y2, NaN);
            who2 = String(p.who2 || p.second || p.secondWho || '').slice(0, 24);
        } else continue;
        if (!Number.isFinite(t) || !Number.isFinite(cx) || !Number.isFinite(cy)) continue;
        items.push({
            t, cx, cy, who,
            cx2: Number.isFinite(cx2) ? cx2 : undefined,
            cy2: Number.isFinite(cy2) ? cy2 : undefined,
            who2: who2 || undefined,
        });
    }
    if (!items.length) return [];
    const looksAbs = epStart > 1.5 && items.some((x) => x.t >= epStart - 0.6 && x.t <= epEnd + 0.6);
    const local = items.map((x) => ({
        t: Math.max(0, Math.min(epDur, looksAbs ? x.t - epStart : x.t)),
        cx: x.cx,
        cy: x.cy,
        who: x.who,
        cx2: x.cx2,
        cy2: x.cy2,
        who2: x.who2,
    })).sort((a, b) => a.t - b.t);
    const out = [];
    for (const p of local) {
        const last = out[out.length - 1];
        if (last && Math.abs(p.t - last.t) < 0.2) {
            out[out.length - 1] = p;
            continue;
        }
        out.push(p);
    }
    return out;
};

export const snapSpeakerTrack = (pts) => {
    if (!pts.length) return pts;
    const out = [{ ...pts[0], t: Math.max(0, pts[0].t) }];
    for (let i = 1; i < pts.length; i++) {
        const a = out[out.length - 1];
        const b = pts[i];
        const d = Math.hypot((b.cx || 0.5) - (a.cx || 0.5), (b.cy || 0.42) - (a.cy || 0.42));
        const dt = Math.max(0, b.t - a.t);
        const speakerJump = (a.who && b.who && a.who !== b.who) || d > 0.12;
        if (speakerJump && dt > 0.03) {
            out.push({ t: round1(Math.max(a.t + 0.02, b.t - 0.03)), cx: a.cx, cy: a.cy, who: a.who });
            out.push({ t: b.t, cx: b.cx, cy: b.cy, who: b.who });
        } else {
            out.push({ t: b.t, cx: b.cx, cy: b.cy, who: b.who });
        }
    }
    return out;
};

export const clampPlan = (segments, duration, maxParts, minSec, autoParts = false, sceneCuts = null, diagnostics = null, partCap = null) => {
    const dur = Math.max(0.2, Number(duration) || 0);
    const min = Math.max(8, Number(minSec) || 60);
    const cap = Number.isFinite(Number(partCap)) && Number(partCap) > 0
        ? Math.floor(Number(partCap))
        : (autoParts ? 24 : Math.max(1, Math.min(12, Number(maxParts) || 6)));
    const raw = Array.isArray(segments) ? segments : [];
    const out = [];
    for (const [rawIndex, s] of raw.entries()) {
        const record = (status, pieces) => diagnostics?.push({
            index: rawIndex + 1, status,
            ranges: pieces.map((p) => [p.start, p.end]),
        });
        let pieces = piecesFromSeg(s, dur);
        if (!pieces.length) { record('dropped: no valid ranges', pieces); continue; }
        if (pieces.length) {
            const pad = dur >= 30 ? 1.2 : 0.6;
            const last = pieces[pieces.length - 1];
            if (last.end > dur - pad) {
                last.end = round1(Math.max(last.start + 0.5, dur - pad));
                if (last.end - last.start < 0.4) pieces = pieces.slice(0, -1);
            }
        }
        const kept = pieces.reduce((acc, p) => acc + (p.end - p.start), 0);
        if (min >= 60 && kept <= 60) { record('dropped: duration <= 60s', pieces); continue; }
        if (kept < min) { record(`dropped: duration < minSec ${min}`, pieces); continue; }
        const title = String(s.name || s.title || `Part ${out.length + 1}`).replace(/\s+/g, ' ').trim().slice(0, 90);
        const titleVi = String(s.nameVi || s.titleVi || s.title_vi || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const name = title
            .replace(/[<>:"|?*\\/]/g, ' ')
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80) || `part ${out.length + 1}`;
        const start = Math.min(...pieces.map((p) => p.start));
        const end = Math.max(...pieces.map((p) => p.end));
        const durKept = round1(pieces.reduce((acc, p) => acc + (p.end - p.start), 0));
        out.push({
            start: round1(start),
            end: round1(end),
            dur: durKept,
            name,
            title,
            titleVi,
            reason: String(s.reason || '').slice(0, 200),
            script: scriptLabel(pieces),
            pieces,
            ranges: pieces.map((p) => [p.start, p.end]),
            frames: parseFraming(s, start, end, sceneCuts),
            track: parseSpeakerTrack(s, start, end),
        });
        record('accepted', pieces);
        if (out.length >= cap) {
            if (diagnostics) {
                for (let i = rawIndex + 1; i < raw.length; i++) {
                    diagnostics.push({ index: i + 1, status: `not processed: part cap ${cap}`, ranges: null });
                }
            }
            break;
        }
    }
    if (!autoParts) {
        const pieceDurSum = (pcs) => pcs.reduce((acc, p) => acc + (p.end - p.start), 0);
        const splitPiecesAt = (pcs, floor) => {
            const n = pcs.length;
            if (n < 2) return null;
            const durs = pcs.map((p) => p.end - p.start);
            const total = durs.reduce((a, b) => a + b, 0);
            if (total < floor * 2 + 0.5) return null;
            let best = null;
            for (let i = 1; i < n; i++) {
                let left = 0;
                for (let k = 0; k < i; k++) left += durs[k];
                const right = total - left;
                if (left >= floor && right >= floor) {
                    const balance = Math.abs(left - right);
                    if (!best || balance < best.balance) best = { i, balance };
                }
            }
            if (!best) return null;
            return [pcs.slice(0, best.i), pcs.slice(best.i)];
        };
        const toSeg = (base, pcs, suffix) => {
            const durKept = round1(pieceDurSum(pcs));
            const title = `${base.title}${suffix ? ` ${suffix}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 90);
            const name = `${base.name}${suffix ? ` ${suffix}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 80);
            return {
                ...base,
                start: round1(Math.min(...pcs.map((p) => p.start))),
                end: round1(Math.max(...pcs.map((p) => p.end))),
                dur: durKept,
                title,
                name,
                titleVi: base.titleVi ? `${base.titleVi}${suffix ? ` ${suffix}` : ''}`.slice(0, 120) : '',
                pieces: pcs,
                ranges: pcs.map((p) => [p.start, p.end]),
                script: scriptLabel(pcs),
            };
        };
        while (out.length < cap) {
            let idx = 0;
            for (let i = 1; i < out.length; i++) {
                if ((out[i].dur || 0) > (out[idx].dur || 0)) idx = i;
            }
            const p = out[idx];
            if (!p) break;
            const pcs = p.pieces || [];
            if (pcs.length >= 2) {
                const halves = splitPiecesAt(pcs, min);
                if (!halves) break;
                out.splice(idx, 1, toSeg(p, halves[0], '1'), toSeg(p, halves[1], '2'));
                continue;
            }
            if (pcs.length !== 1 || p.dur < min * 2 + 1) break;
            const only = pcs[0];
            const mid = round1((only.start + only.end) / 2);
            const leftDur = round1(mid - only.start);
            const rightDur = round1(only.end - mid);
            if (leftDur < min || rightDur < min) break;
            out.splice(idx, 1,
                toSeg(p, [{ start: only.start, end: mid, role: 'body' }], '1'),
                toSeg(p, [{ start: mid, end: only.end, role: 'body' }], '2'),
            );
        }
        if (out.length > cap) out.length = cap;
    }
    return out;
};

export const generalEditorPrompt = (duration, minSec = 60) => `You edit any kind of video. Watch and listen. Do not assume a specific show or cast.
Cut highlights only. Drop ads, outros, credits, and stretches that are not worth keeping.
Decide the number of parts from the content. Each part is one contiguous timeline range, in order. Do not shuffle or use a later moment as a hook.
Each part must be longer than ${Math.max(60, Number(minSec) || 60)} seconds. A part may be as long as that highlight needs. Do not split a long highlight just to keep parts similar, and do not aim for a fixed count.
Return JSON only:
{"summary":"one line","segments":[{"name":"English title","nameVi":"Vietnamese title","reason":"why this highlight","start":0.0,"end":90.0,"frames":[{"start":0.0,"end":8.0,"mode":"contain","why":"the whole field of play stays visible"},{"start":8.0,"end":20.0,"mode":"fill","cx":0.62,"cy":0.42,"why":"the player with the ball"}],"track":[{"t":8.0,"cx":0.62,"cy":0.42,"who":"player"}]}]}
name is 3–8 English words. frames cover the part with no gaps. contain = wide context, a crowd, a scoreboard, many subjects, a prop, or a shot that is already tight. fill = one person, player, animal, or object should be larger. cx,cy is that subject's center, not the brightest blob. Video duration is ${Number(duration).toFixed(1)} seconds.`;

export const generalGlancePrompt = (start, end) => `These stills are from one highlight, source time ${Number(start).toFixed(1)}s to ${Number(end).toFixed(1)}s. There is little or no speech. Label 9:16 crops for whatever the video actually shows: a person, athlete, game character, animal, product, or the whole field.
Return JSON only: {"frames":[{"start":${Number(start).toFixed(1)},"end":${Number(end).toFixed(1)},"mode":"focus","cx":0.5,"cy":0.4,"why":"who or what we follow"},{"start":0,"end":1,"mode":"split","cx":0.3,"cy":0.4,"cx2":0.8,"cy2":0.6,"why":"two different subjects far apart"}]}
Use source timestamps inside ${Number(start).toFixed(1)}–${Number(end).toFixed(1)}. focus = one main subject or action fills the whole 9:16 frame (default). split = two things worth watching at once, frame split top/bottom into equal halves with one camera each (needs cx2,cy2) - there is no corner window. Never letterbox and never show the whole source frame with bars. Do not assume any specific show, cast or character.`;

// General-content 9:16 framing. This replaces the SML contain/fill pair for
// everything that is not a SuperMarioLogan-style puppet clip: the canvas is
// ALWAYS filled by a crop on the main subject (no letterbox). A second event
// is a top/bottom split or it is left out. The corner window is retired:
// asking the model for an inset makes the renderer build a full half-frame
// on a bad coordinate (2026-10-02).
export const focusEditorPrompt = (duration, minSec = 60, userPrompt = '') => `You edit vertical 9:16 shorts out of any kind of video: podcast, talk show, interview, sports, cops/bodycam/dashcam, gameplay, vlog, news. Watch AND listen. Never assume a specific show, cast, language or character.
${String(userPrompt || '').trim() ? `Operator request — follow it when choosing parts and writing titles:\n${String(userPrompt).slice(0, 4000)}\n` : ''}
Keep only the parts worth posting. Drop ads, sponsors, outros, credits, intros, dead air, repeats and every stretch that is not worth watching. Skip boring footage instead of covering it.
Decide the number of parts yourself - it may be 1 or 20. Never aim for a fixed count, and never split one good highlight just to make parts similar.
Each part is ONE contiguous timeline range, in timeline order. Do not shuffle pieces. Do not use a later moment as a hook.
HARD: every part must be longer than ${Math.max(60, Number(minSec) || 60)} seconds. There is NO maximum length - a part may run as long as that highlight needs, so 3+ minutes is fine when the content earns it.
FRAMING is mandatory: the output is 9:16 and is ALWAYS filled edge to edge by a crop on the main subject. Never letterbox, never show the source full frame, never add bars.
Return JSON only:
{"summary":"one line","segments":[{"name":"English title","nameVi":"Tiêu đề Việt","reason":"why this part is worth posting","start":0.0,"end":96.0,"frames":[{"start":0.0,"end":14.0,"mode":"focus","cx":0.62,"cy":0.42,"why":"who or what we follow"},{"start":14.0,"end":22.0,"mode":"split","cx":0.30,"cy":0.40,"cx2":0.78,"cy2":0.58,"why":"two different subjects far apart"}],"track":[{"t":0.0,"cx":0.62,"cy":0.42,"who":"speaker"}]}]}
frames[] must cover the part with no gaps, in order, with source timestamps.
mode is the 9:16 layout for that stretch. There are only TWO modes:
- focus = ONE main subject or action fills the whole frame. This is the default: a person talking, one athlete, one car, one animal, one on-screen character. A tall 9:16 crop already holds two subjects that are separated VERTICALLY or that stand close together.
- split = two DIFFERENT things worth watching at the same moment, far apart horizontally. The frame is split top/bottom into two equal halves, one camera each: main subject on top, the second event below. Requires cx2,cy2. A split lasts only while both are on screen. Do not stretch it to fill time.
There is NO corner window any more. Never answer "pip" and never describe a small inset: a second event is either worth a half of the frame (split) or it is not worth showing (focus).
HARD SPATIAL RULE: a 9:16 crop is narrow. If the main subject and a different second event are far apart HORIZONTALLY - roughly more than one third of the frame width between them, one on the left and one on the right - one focus crop cannot hold both. For that stretch use split so both keep a camera. Do not answer focus there. Subjects stacked vertically, or standing close, stay focus.
REACTION / COMMENTARY / STREAM LAYOUTS: a small face in the corner of the game or the video is NOT a split. Focus on whichever of the content or the face carries that moment. Use split only when the face and the content are both large and far apart horizontally. If the reaction is the point, the face is the top half and the content is below.
HARD, and this is the mistake to avoid: split is ONLY for a second thing that is different from the main subject. If the "second thing" is the same person, their own hands, the product they are holding or a screen showing that same person again, do NOT split: answer focus. Never set cx2,cy2 on the main subject, on their body, or on anything already inside the main crop.
Use focus when the second person/object is only background, stands next to the main subject, or is not worth watching. Never choose split just because another person is visible.
Do NOT write cx2,cy2 on a focus window - there is no second camera there. Add cx2,cy2 only on a split window, and they must point at the real second event, not repeat cx,cy.
cx,cy = centre of the MAIN subject in the SOURCE frame (0=left/top, 1=right/bottom). cx2,cy2 = centre of the SECOND event in the SOURCE frame. Never point at empty space, a logo, a caption or the brightest blob.
track[]: one point about every 1.5 seconds, and a new point whenever the framed subject or its position changes. Keep points close and gradual while the action moves (the editor pans), and change "who" when the subject changes (the editor cuts).
Inside a split window, also put cx2,cy2 on those track points (about every 1.5 seconds) so the second camera FOLLOWS the second event instead of freezing where it started. If the second event moves, camera 2 must move with it. End the split window when the second event leaves.
name is 3-8 English words, specific to THIS part, never repeated. nameVi is its Vietnamese translation. Video duration is ${Number(duration).toFixed(1)} seconds.`;

// Per-part variant for the same framing, used by TEST / Test lại Part and by
// any future per-part Detail pass on the general-content path.
export const focusDetailPrompt = (duration, minSec = 12, sceneCuts = null, userPrompt = '') => {
    const dur = Number(duration) || 0;
    const cuts = Array.isArray(sceneCuts) ? compactSceneCutHints(sceneCuts, dur) : [];
    const cutLine = cuts.length
        ? `Candidate visual cut points in this excerpt (seconds): ${cuts.map((value) => value.toFixed(1)).join(', ')}. They are hints, not mandatory cuts.`
        : 'No candidate cut points were detected; find the visual changes yourself.';
    return `You are framing ONE vertical 9:16 short. Watch AND listen to this excerpt only (${dur.toFixed(1)} seconds). Never assume a specific show, cast, language or character.
${String(userPrompt || '').trim() ? `Operator request:\n${String(userPrompt).slice(0, 4000)}\n` : ''}
Return JSON only:
{"summary":"one line","segments":[{"name":"English title","nameVi":"Tiêu đề Việt","reason":"why","start":0.0,"end":${dur.toFixed(1)},"frames":[{"start":0.0,"end":8.0,"mode":"focus","cx":0.55,"cy":0.42,"why":"the main subject"},{"start":8.0,"end":14.0,"mode":"split","cx":0.30,"cy":0.40,"cx2":0.78,"cy2":0.58,"why":"two different subjects far apart"}],"track":[{"t":0.0,"cx":0.55,"cy":0.42,"who":"who we follow"}]}]}
Framing is mandatory: 9:16, ALWAYS filled edge to edge by a crop on the main subject. Never letterbox, never show the source full frame, never add bars.
frames[] covers 0.0 to ${dur.toFixed(1)} with NO gaps, in order, using timestamps inside this excerpt. ${cutLine}
mode per stretch (only two):
- focus = one main subject or action fills the whole frame (default). A tall 9:16 crop already holds two subjects that are stacked vertically or stand close together.
- split = two things worth watching at once: frame split top/bottom into equal halves, one camera each, main subject on top (requires cx2,cy2). There is no corner window any more.
Start a new window at every camera cut, angle or composition change, speaker change, reaction shot, insert or subject change.
HARD SPATIAL RULE: the 9:16 crop is narrow. If the main subject and a different second event sit far apart HORIZONTALLY (roughly more than one third of the frame width between them, one left and one right), one focus crop cannot hold both - use split for that stretch, do not answer focus there. Subjects stacked vertically or standing close stay focus.
REACTION / COMMENTARY LAYOUT: a small face camera in the corner is not a split and there is no corner window. Focus on the content, or focus on the face when the reaction is the point. Use split only when the face and the content are both large and far apart horizontally.
HARD: split only when the second thing is different from the main subject. If it is the same person (including that person on a screen or in an ad), their hands, the product they hold or anything already inside the main crop, answer focus. Never point cx2,cy2 at the main subject. Never answer "pip".
Do NOT write cx2,cy2 on a focus window. Use them only on a split, pointing at the real second event.
cx,cy = centre of the MAIN subject in the SOURCE frame (0=left/top, 1=right/bottom). cx2,cy2 = centre of the SECOND event. Never aim at empty space, a logo, a caption or the brightest blob.
track[]: one point about every 1.5 seconds and a new point whenever the framed subject or its position changes; who = short label. Inside a split window also put cx2,cy2 on those points so camera 2 follows the second event instead of freezing. A window lasts only as long as that shot. End a split the moment the second event leaves; do not stretch a split across the rest of the excerpt. A window may be as short as about 1 second.`;
};

const closeJson = (text) => {
    let out = '';
    const stack = [];
    let inString = false;
    let escaped = false;
    for (const ch of text) {
        out += ch;
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop();
    }
    if (inString) out += '"';
    out = out.replace(/,\s*"[^"\n]*"?\s*:?\s*$/, '').replace(/,\s*$/, '');
    while (stack.length) out += stack.pop();
    return out.replace(/,\s*([}\]])/g, '$1');
};

const parseGeminiObject = (text) => {
    const raw = String(text || '');
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fence ? fence[1] : raw).trim();
    const start = body.indexOf('{');
    if (start < 0) throw new Error('Gemini did not return JSON');
    const slice = body.slice(start);
    const end = slice.lastIndexOf('}');
    const candidates = [];
    if (end > 0) candidates.push(slice.slice(0, end + 1));
    candidates.push(closeJson(slice));
    let lastErr = null;
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
        } catch (err) {
            lastErr = err;
        }
    }
    const message = lastErr instanceof Error ? lastErr.message : 'parse failed';
    const position = Number((String(message).match(/position (\d+)/) || [])[1]);
    const near = Number.isFinite(position)
        ? slice.slice(Math.max(0, position - 50), position + 50)
        : slice.slice(0, 100);
    throw new Error(`Gemini JSON parse failed: ${message} near ${JSON.stringify(near)}`);
};

export const parseGeminiPlan = (text, duration, maxParts, minSec, autoParts = false, sceneCuts = null, partCap = null) => {
    const parsed = parseGeminiObject(text);
    const diagnostics = [];
    const segs = clampPlan(parsed.segments || parsed.clips || [], duration, maxParts, minSec, autoParts, sceneCuts, diagnostics, partCap);
    if (!segs.length) throw new Error('Gemini returned no usable segments');
    const plan = { summary: String(parsed.summary || '').slice(0, 300), segments: segs, _raw: parsed };
    Object.defineProperty(plan, '_segmentDiagnostics', { value: diagnostics });
    return plan;
};
