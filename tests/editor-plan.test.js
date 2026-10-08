import test from 'node:test';
import assert from 'node:assert/strict';
import { evenSplitPlan, normalizeFrameMode, parseGeminiPlan, sourceTimeForTrackPoint, shouldUsePerPartDetailPlan, mergeSegmentDetail, compactSceneCutHints, detailSceneCutGuidance, detailSemanticFramingGuidance, stitchFrames, isSpeakerIdentity, resolveSpeakerWho, parseSpeechLines, speechLinesFromDiarizedTurns, speechLinesForUnresolvedTurns, speechFramingContainReason, balanceDetailWindows, trackFillCuts, generalEditorPrompt, focusEditorPrompt, focusDetailPrompt, generalGlancePrompt, FRAME_MODES, clampPlan, parseFraming, parseSpeakerTrack, framesCoverage } from '../server/editor-plan.js';

test('framesCoverage measures the part a Detail plan really describes', () => {
  assert.equal(framesCoverage([], 100), 0);
  assert.equal(framesCoverage([{ a: 0, b: 100 }], 100), 1);
  assert.equal(framesCoverage([{ a: 0, b: 25 }], 100), 0.25);           // the measured 19-28 % case
  assert.equal(framesCoverage([{ a: 0, b: 40 }, { a: 40, b: 100 }], 100), 1);
  // Overlapping windows are counted once, and the total is clamped to the part.
  assert.equal(framesCoverage([{ a: 0, b: 60 }, { a: 40, b: 60 }], 100), 0.6);
  assert.equal(framesCoverage([{ a: 0, b: 200 }], 100), 1);
});

test('evenSplitPlan creates contiguous bounded segments', () => {
  const segs = evenSplitPlan(360, 3, 60, false);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].start, 0);
  assert.equal(segs.at(-1).end, 360);
  for (let i=1;i<segs.length;i++) assert.equal(segs[i-1].end, segs[i].start);
});

test('normalizeFrameMode accepts supported modes', () => {
  assert.equal(normalizeFrameMode('tight crop'), 'fill');
  assert.equal(normalizeFrameMode('wide fit'), 'contain');
  assert.equal(normalizeFrameMode('bad-value'), '');
});

test('normalizeFrameMode accepts the general-content 9:16 modes', () => {
  assert.equal(normalizeFrameMode('focus'), 'focus');
  assert.equal(normalizeFrameMode('9:16 subject crop'), 'focus');
  assert.equal(normalizeFrameMode('split'), 'split');
  assert.equal(normalizeFrameMode('chia đôi trên/dưới'), 'split');
  // The corner window is retired: pip wording maps onto the top/bottom split.
  assert.equal(normalizeFrameMode('pip'), 'split');
  assert.equal(normalizeFrameMode('cửa sổ phụ'), 'split');
  assert.ok(FRAME_MODES.has('focus') && FRAME_MODES.has('split'));
});

test('stitchFrames does not smear a split across the rest of the part', () => {
  const out = stitchFrames([
    { a: 4, b: 6, mode: 'split', cx: 0.2, cy: 0.4, cx2: 0.8, cy2: 0.5, why: 'two hosts' },
    { a: 14, b: 18, mode: 'focus', cx: 0.6, cy: 0.4, why: 'one host' },
  ], 20);
  const split = out.find((w) => w.mode === 'split');
  assert.ok(split);
  assert.equal(split.a, 4);
  assert.equal(split.b, 6);
  assert.ok(out.some((w) => w.mode === 'focus' && w.b === 20));
});

test('stitchFrames does not merge splits that watch different second subjects', () => {
  const out = stitchFrames([
    { a: 0, b: 4, mode: 'split', cx: 0.3, cy: 0.4, cx2: 0.8, cy2: 0.4 },
    { a: 4, b: 8, mode: 'split', cx: 0.3, cy: 0.4, cx2: 0.15, cy2: 0.7 },
  ], 8);
  assert.equal(out.length, 2);
  assert.equal(out[0].cx2, 0.8);
  assert.equal(out[1].cx2, 0.15);
});

test('stitchFrames keeps focus, pip and split windows', () => {
  const out = stitchFrames([
    { a: 0, b: 4, mode: 'focus', cx: 0.4, cy: 0.42 },
    { a: 4, b: 8, mode: 'pip', cx: 0.3, cy: 0.4, cx2: 0.8, cy2: 0.6 },
    { a: 8, b: 12, mode: 'split', cx: 0.3, cy: 0.4, cx2: 0.75, cy2: 0.55 },
  ], 12);
  assert.deepEqual(out.map((w) => w.mode), ['focus', 'pip', 'split']);
  assert.equal(out[1].cx2, 0.8);
  assert.equal(out[1].cy2, 0.6);
});

test('parseFraming carries the second-subject aim through a plan', () => {
  const frames = parseFraming({
    frames: [
      { start: 0, end: 6, mode: 'pip', cx: 0.25, cy: 0.4, cx2: 0.8, cy2: 0.6, why: 'speaker + crash' },
      { start: 6, end: 12, mode: 'focus', cx: 0.5, cy: 0.42, why: 'speaker' },
    ],
  }, 0, 12);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].mode, 'split');
  assert.equal(frames[0].cx2, 0.8);
  assert.equal(frames[0].cy2, 0.6);
});

test('parseSpeakerTrack keeps the second camera position', () => {
  const track = parseSpeakerTrack({
    track: [
      { t: 0, cx: 0.3, cy: 0.4, who: 'speaker', cx2: 0.8, cy2: 0.62, who2: 'crash' },
      { t: 5, cx: 0.35, cy: 0.4, who: 'speaker' },
    ],
  }, 0, 10);
  assert.equal(track.length, 2);
  assert.equal(track[0].cx2, 0.8);
  assert.equal(track[0].cy2, 0.62);
  assert.equal(track[0].who2, 'crash');
  assert.equal(track[1].cx2, undefined);
});

test('focus prompts describe the no-letterbox 9:16 contract', () => {
  const plan = focusEditorPrompt(600, 60, 'chỉ lấy cảnh hành động');
  assert.ok(/never letterbox/i.test(plan));
  assert.ok(/no maximum length/i.test(plan));
  assert.ok(/decide the number of parts yourself/i.test(plan));
  assert.ok(plan.includes('chỉ lấy cảnh hành động'));
  assert.ok(/pip/.test(plan) && /split/.test(plan) && /cx2,cy2/.test(plan));
  assert.ok(!/corner window \(pip\)/i.test(plan));

  const detail = focusDetailPrompt(72, 12, [12.5, 30], 'ưu tiên người nói');
  assert.ok(detail.includes('0.0 to 72.0'));
  assert.ok(detail.includes('12.5, 30.0'));
  assert.ok(detail.includes('ưu tiên người nói'));
  assert.ok(/never letterbox/i.test(detail));

  const glance = generalGlancePrompt(10, 40);
  assert.ok(/"mode":"focus"/.test(glance));
  assert.ok(!/letterbox/.test(glance.split('\n')[0])); // sanity: prompt is multi-line
  assert.ok(/Never letterbox/i.test(glance));
});

test('parseGeminiPlan repairs a trailing comma and a cut-off object', () => {
  const trailing = '{"segments":[{"start":0,"end":90},{"start":90,"end":180},]}';
  assert.ok(parseGeminiPlan(trailing, 180, 6, 60, false).segments.length >= 1);
  const cut = '{"segments":[{"start":0,"end":90},{"start":90,"end":180}';
  assert.ok(parseGeminiPlan(cut, 180, 6, 60, false).segments.length >= 1);
});

test('parseGeminiPlan reports the parser reason when repair fails', () => {
  assert.throws(() => parseGeminiPlan('{segments: broken', 180, 6, 60, false), /Gemini JSON parse failed:/);
});

test('parseGeminiPlan accepts basic JSON segment plan', () => {
  const raw = JSON.stringify({ segments: [
    { start: 0, end: 90, title: 'A' },
    { start: 90, end: 180, title: 'B' }
  ]});
  const out = parseGeminiPlan(raw, 180, 6, 60, false);
  assert.ok(Array.isArray(out.segments));
  assert.ok(out.segments.length >= 1);
});

test('sourceTimeForTrackPoint preserves one-piece mapping', () => {
  assert.equal(sourceTimeForTrackPoint([{ start: 20, end: 30 }], 4.5, 20), 24.5);
});

test('Global diagnostics expose cap exclusions without changing serialized plan shape', () => {
  const input = { segments: [
    { start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 250 },
  ] };
  const result = parseGeminiPlan(JSON.stringify(input), 270, 2, 60.1);
  assert.deepEqual(result.segments.map(({ start, end }) => [start, end]), [[0, 100], [100, 200]]);
  assert.deepEqual(result._raw, input);
  assert.equal(result._segmentDiagnostics[2].status, 'not processed: part cap 2');
  assert.equal(result._raw.segments[2].end, 250);
  assert.deepEqual(Object.keys(result), ['summary', 'segments', '_raw']);
  assert.equal(JSON.parse(JSON.stringify(result))._segmentDiagnostics, undefined);
});

test('Global diagnostics distinguish short and invalid ranges from accepted ranges', () => {
  const result = parseGeminiPlan(JSON.stringify({ segments: [
    { start: 0, end: 100 }, { start: 100, end: 150 },
    { start: 'invalid', end: 180 }, { start: 150, end: 210.05 },
    { start: 210.05, end: 280 },
  ] }), 300, 2, 60.1);
  assert.deepEqual(result._segmentDiagnostics.map((entry) => entry.status), [
    'accepted', 'dropped: duration <= 60s', 'dropped: no valid ranges',
    'dropped: duration < minSec 60.1', 'accepted',
  ]);
  assert.equal(result.segments.at(-1).end, 280);
});

test('sourceTimeForTrackPoint maps concatenated time into the second piece', () => {
  const pieces = [{ start: 10, end: 15 }, { start: 40, end: 50 }];
  assert.equal(sourceTimeForTrackPoint(pieces, 7, 10), 42);
});

test('detail scene-cut guidance is bounded and opt-in', () => {
  assert.equal(detailSceneCutGuidance(null, 120), '');
  const cuts = compactSceneCutHints([0, 5.04, 5.06, 40, 119.9, 120], 120, 2);
  assert.deepEqual(cuts, [5, 40]);
  const guidance = detailSceneCutGuidance(cuts, 120);
  assert.match(guidance, /Candidate visual shot boundaries.*5\.0, 40\.0/);
  assert.match(guidance, /Re-evaluate CONTAIN versus FILL/);
  assert.match(guidance, /Do not create more FILL merely to increase density/);
});

test('detail framing uses a semantic information-loss gate without fill quotas', () => {
  const guidance = detailSemanticFramingGuidance();
  assert.doesNotMatch(guidance, /50[–-]65%/);
  assert.doesNotMatch(guidance, /wide 2[–-]4s then fill/i);
  assert.doesNotMatch(guidance, /alternate often/i);
  assert.match(guidance, /speaker or two-shot alone determines neither FILL nor CONTAIN/i);
  assert.match(guidance, /visual-information preservation/i);
  assert.match(guidance, /reasonable subject crop preserves all information necessary to understand the current beat/i);
  assert.match(guidance, /important information necessary to understand the current shot would actually fall outside a reasonable subject crop/i);
  assert.match(guidance, /mere presence of another person, prop\/object, background context, movement, reaction, or spatial context is NOT enough/i);
});

test('detail framing rejects degenerate all-contain dialogue without a fill quota', () => {
  const guidance = detailSemanticFramingGuidance();
  assert.match(guidance, /normal dialogue with 1[–-]2 visible puppets, FILL the speaking\/focal puppet/i);
  assert.match(guidance, /three puppets alone is NOT sufficient reason for CONTAIN/i);
  assert.match(guidance, /do NOT return an all-CONTAIN plan for a normal dialogue segment/i);
  assert.match(guidance, /if frames\[\] contains zero FILL windows, re-check whether the segment truly qualifies as wide-only/i);
  assert.match(guidance, /crowd or many puppets.*establishing\/context shot.*off-camera speaker/i);
  assert.doesNotMatch(guidance, /50[–-]65%/);
});

test('detail frames require concrete reasons for contain and fill', () => {
  const guidance = detailSemanticFramingGuidance();
  assert.match(guidance, /EVERY frames\[\] object MUST include a non-empty "why"/);
  assert.match(guidance, /For CONTAIN, state exactly what important visual information a reasonable medium crop would lose/i);
  assert.match(guidance, /"Another puppet is visible" is NOT a sufficient CONTAIN reason/i);
  assert.match(guidance, /"context".*"wide shot".*"conversation".*"scene".*"multiple characters".*insufficient/i);
  assert.match(guidance, /both puppets' simultaneous reaction is required/);
  assert.match(guidance, /Jeffy is the focal speaker/);
});

test('detail guidance requires Gemini to self-segment observed visual shots', () => {
  const guidance = detailSemanticFramingGuidance();
  assert.match(guidance, /independently watch the video for every meaningful visual shot boundary/i);
  assert.match(guidance, /hard cut, camera-angle change, composition change, reaction shot, subject-layout change, insert\/object shot, or focal-subject change/i);
  assert.match(guidance, /start a NEW frames\[\] window and independently classify that new shot/i);
  assert.match(guidance, /same mode does NOT mean same shot/i);
  assert.match(guidance, /Never merge visually distinct shots merely because their framing mode is unchanged/i);
});

test('detail dialogue uses one framing window per continuous visual shot', () => {
  const guidance = detailSemanticFramingGuidance();
  assert.match(guidance, /one frames\[\] window represents ONE visually continuous shot\/composition/i);
  assert.match(guidance, /never an entire conversation, topic, or story beat/i);
  assert.match(guidance, /new camera angle, visible speaker-focus change, reaction shot, composition\/layout change, or cut to another puppet\/person MUST start a new frames\[\] window/i);
  assert.match(guidance, /"back-and-forth argument", "conversation continues", or "group discussion"/i);
  assert.match(guidance, /independently classify EACH shot as FILL or CONTAIN/i);
  assert.doesNotMatch(guidance, /maximum CONTAIN duration|target FILL ratio/i);
});

test('detail scene-cut hints remain non-mandatory re-evaluation points', () => {
  const guidance = `${detailSemanticFramingGuidance()}${detailSceneCutGuidance([4.2], 10)}`;
  assert.match(guidance, /Candidate visual shot boundaries.*4\.2/);
  assert.match(guidance, /hints, not mandatory cuts/i);
  assert.match(guidance, /At EVERY candidate scene cut, make a fresh independent framing classification/i);
  assert.match(guidance, /mode may remain the same across the cut only because the new shot independently satisfies the same decision/i);
  assert.match(guidance, /not a mandatory FILL, CONTAIN, mode change, or split/i);
  assert.match(guidance, /sceneCuts are supplementary trusted anchors.*not an exhaustive boundary list/i);
  assert.match(guidance, /boundaries that are NOT listed in sceneCuts/i);
});

test('detail framing preserves different semantic contain reasons', () => {
  const frames = stitchFrames([
    { a: 0, b: 5, mode: 'contain', why: 'two-character visual gag' },
    { a: 5, b: 10, mode: 'contain', why: 'object reveal across frame' },
  ], 10, []);
  assert.equal(frames.length, 2);
});

test('detail framing preserves a known scene-cut boundary', () => {
  const frames = stitchFrames([
    { a: 0, b: 5, mode: 'contain', why: 'same context' },
    { a: 5, b: 10, mode: 'contain', why: 'same context' },
  ], 10, [5]);
  assert.equal(frames.length, 2);
});

test('detail framing preserves every valid raw Gemini shot boundary', () => {
  const frames = stitchFrames([
    { a: 0, b: 5, mode: 'contain', why: 'same context' },
    { a: 5, b: 9, mode: 'contain', why: 'same context' },
    { a: 9, b: 14, mode: 'contain', why: 'same context' },
  ], 14, []);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((frame) => [frame.a, frame.b]), [[0, 5], [5, 9], [9, 14]]);
});

test('global framing keeps existing identical-contain merge behavior', () => {
  const frames = stitchFrames([
    { a: 0, b: 5, mode: 'contain', why: 'same context' },
    { a: 5, b: 10, mode: 'contain', why: 'same context' },
  ], 10, null);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].b, 10);
});

test('per-part detail replaces only local frames and track', () => {
  const global = {
    start: 10,
    end: 55,
    title: 'Global title',
    titleVi: 'Tiêu đề',
    pieces: [{ start: 10, end: 20 }, { start: 40, end: 55 }],
    frames: [{ a: 0, b: 25, mode: 'contain' }],
    track: [{ t: 0, who: 'Old', cx: 0.2 }],
  };
  const detail = {
    frames: [{ a: 0, b: 5, mode: 'fill' }],
    track: [{ t: 12, who: 'Junior', cx: 0.7 }],
  };
  const merged = mergeSegmentDetail(global, detail);
  assert.deepEqual(merged.frames, detail.frames);
  assert.deepEqual(merged.track, detail.track);
  assert.equal(merged.track[0].t, 12);
  assert.equal(merged.start, 10);
  assert.equal(merged.end, 55);
  assert.equal(merged.title, 'Global title');
  assert.equal(merged.titleVi, 'Tiêu đề');
  assert.deepEqual(merged.pieces, global.pieces);
  assert.equal(sourceTimeForTrackPoint(merged.pieces, merged.track[0].t, merged.start), 42);
});

test('per-part detail failure preserves global framing and track', () => {
  const global = { frames: [{ mode: 'contain' }], track: [{ t: 1, who: 'Junior' }] };
  assert.equal(mergeSegmentDetail(global, null), global);
});

test('production detail enrichment excludes TEST and single-part paths', () => {
  assert.equal(shouldUsePerPartDetailPlan({ mode: 'ai', tiktokMix: true, testSec: 0, segmentCount: 6 }), true);
  assert.equal(shouldUsePerPartDetailPlan({ mode: 'ai', tiktokMix: true, testSec: 60, segmentCount: 1 }), false);
  assert.equal(shouldUsePerPartDetailPlan({ mode: 'ai', tiktokMix: true, testSec: 0, segmentCount: 1 }), false);
  assert.equal(shouldUsePerPartDetailPlan({ mode: 'ai', tiktokMix: true, testSec: 0, segmentCount: 6, speechFraming: true }), false);
});

test('a long detail fill or contain is broken into a mix', () => {
  const balanced = balanceDetailWindows([
    { a: 0, b: 70, mode: 'fill', cx: 0.4, who: 'Marvin' },
    { a: 70, b: 150, mode: 'contain', why: 'both puppets' },
  ], [
    { t: 80, end: 92, who: 'Jeffy' },
    { t: 110, end: 130, who: 'Marvin' },
  ]);
  const fill = balanced.filter((w) => w.mode === 'fill');
  const wide = balanced.filter((w) => w.mode === 'contain');
  assert.ok(fill.length >= 3);
  assert.ok(wide.length >= 2);
  assert.ok(fill.every((w) => w.b - w.a <= 14.1));
  assert.equal(balanced.some((w) => w.a === 0 && w.b === 70), false);
});

test('a fill cuts to the new face when the model track changes speaker', () => {
  const cuts = trackFillCuts({ a: 8, b: 25 }, [
    { t: 8.1, cx: 0.44, who: 'Junior' },
    { t: 8.5, cx: 0.45, who: 'Junior' },
    { t: 10.0, cx: 0.18, who: 'Joseph' },
    { t: 10.4, cx: 0.19, who: 'Joseph' },
  ]);
  assert.equal(cuts.length, 2);
  assert.equal(cuts[0].t, 8);
  assert.equal(cuts[0].cx, 0.44);
  assert.equal(cuts[1].t, 10);
  assert.equal(cuts[1].who, 'Joseph');
  assert.equal(cuts[1].cx, 0.18);
});

test('a long detail wide uses face points and refuses an edge aim', () => {
  const track = [];
  for (let t = 40; t <= 100; t += 2) track.push({ t, cx: 0.46, who: 'Brooklyn' });
  const balanced = balanceDetailWindows([
    { a: 0, b: 10, mode: 'contain', why: 'door' },
    { a: 10, b: 108, mode: 'contain', why: 'cops at the door' },
  ], [
    { t: 12, end: 20, who: 'Rose', cx: 0.07 },
  ], track);
  assert.equal(balanced[0].b - balanced[0].a, 10);
  assert.equal(balanced[0].mode, 'contain');
  const fills = balanced.filter((w) => w.mode === 'fill');
  assert.ok(fills.length >= 3);
  assert.ok(fills.every((w) => w.cx >= 0.12 && w.cx <= 0.88 && w.b - w.a <= 12.1));
  assert.equal(fills.some((w) => w.who === 'Rose'), false);
  assert.equal(balanced.some((w) => w.a === 10 && w.b === 108), false);
});

test('general highlight plan keeps a long part and drops anything of a minute or less', () => {
  const kept = clampPlan([
    { name: 'Long rally', start: 10, end: 410 },
    { name: 'Too short', start: 420, end: 470 },
  ], 900, 6, 60, true, null, null, 15);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, 'Long rally');
  assert.ok(kept[0].dur > 60);
  const prompt = generalEditorPrompt(900, 60);
  assert.match(prompt, /longer than 60 seconds/);
  assert.doesNotMatch(prompt, /Jeffy|Brooklyn|puppet/);
});

test('speech framing contains a crowd, an existing close-up, and a prop with no face', () => {
  assert.equal(speechFramingContainReason({ peaks: [{}, {}, {}, {}, {}], closeup: false, twoShot: false, puppetRatio: 0.2, faceH: 0.3 }), 'group shot');
  assert.equal(speechFramingContainReason({ peaks: [{}, {}, {}], closeup: false, twoShot: false, puppetRatio: 0.2, faceH: 0.3 }), '');
  assert.equal(speechFramingContainReason({ peaks: [{}], closeup: true, twoShot: false, puppetRatio: 0.4, faceH: 0.7 }), 'already close-up');
  assert.equal(speechFramingContainReason({ peaks: [{}], closeup: false, twoShot: false, puppetRatio: 0.04, faceH: 0.1 }), 'no clear face');
  assert.equal(speechFramingContainReason({ peaks: [{}, {}], closeup: false, twoShot: true, puppetRatio: 0.25, faceH: 0.35 }), '');
});

test('unresolved diarized speech stays a line outside named turns', () => {
  const lines = speechLinesForUnresolvedTurns(
    [{ start: 10, end: 18, speakerId: 'SPEAKER_09' }],
    [{ start: 12, end: 13, who: 'Junior' }],
    [{ t: 10.2, end: 10.6, word: 'wait' }, { t: 14, end: 14.4, word: 'now' }],
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].who, 'Voice A');
  assert.equal(lines[0].end, 12);
  assert.equal(lines[1].t, 13);
  assert.equal(lines[1].end, 18);
  assert.match(lines[1].text, /now/);
});

test('diarized turns become speech lines when the plan has no named track', () => {
  const lines = speechLinesFromDiarizedTurns([
    { start: 1, end: 2.2, speakerId: 'SPEAKER_00' },
    { start: 2.4, end: 3.1, speakerId: 'SPEAKER_00' },
    { start: 4, end: 5.5, speakerId: 'SPEAKER_01' },
  ], [
    { t: 1.1, end: 1.4, word: 'hello' },
    { t: 4.2, end: 4.6, word: 'stop' },
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].who, 'Voice A');
  assert.equal(lines[0].end, 3.1);
  assert.match(lines[0].text, /hello/);
  assert.equal(lines[1].who, 'Voice B');
  assert.match(lines[1].text, /stop/);
  assert.equal(isSpeakerIdentity(lines[0].who), true);
});

test('speaker identity accepts normal aliases and rejects narrative text', () => {
  for (const name of ['Brooklyn Guy', 'Chef Pee Pee', "Cody's Dad", 'Brooklyn-Guy', 'Mr. Goodman']) {
    assert.equal(isSpeakerIdentity(name), true, name);
  }
  for (const sentinel of ['none', 'NONE', 'null', 'unknown', 'nobody', 'speaker', 'narrator', 'no speaker', 'no-speaker', 'no_speaker', 'not applicable', 'n/a']) {
    assert.equal(isSpeakerIdentity(sentinel), false, sentinel);
  }
  assert.equal(isSpeakerIdentity('Puppet laughs at the TV and heads to bed'), false);
  assert.equal(isSpeakerIdentity('Junior walks into the room'), false);
});

test('framing why is not promoted into speaker who', () => {
  assert.equal(resolveSpeakerWho({ why: 'Puppet laughs at the TV and heads to bed' }), undefined);
});

test('invalid PLAN speech who is removed without dropping the line', () => {
  const lines = parseSpeechLines({ lines: [{
    t: 1,
    end: 2,
    who: 'Puppet laughs at the TV and heads to bed',
    text: 'Good night',
  }] }, 10);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].who, undefined);
  assert.equal(lines[0].text, 'Good night');
});
