// Turn a local layout scan (faces, people, portrait panels) into focus/split
// windows. Pure: no ffmpeg, no Python, no network. The scan itself lives in
// local_layout_scan.py. Measured on the 134 s Law By Mike part (v19-B-hybrid):
// a phone ad drawn beside the host was labelled a split by the model at 45-54 s
// and then collapsed, and the same layout at 126-132 s was never split, because
// YOLOv8n does not see that graphic as a cell phone. A tall portrait panel is
// the reliable signal. A crowd (the 13-face video wall at 95 s) must stay focus.
// Two objects on a dark canvas (the scoreboard near 97 s) are a split:
// one 9:16 crop cannot hold both.

const MIN_SPLIT_SEC = 1;
const BRIDGE_SEC = 1;
const MIN_PAIR_GAP = 0.3;
const PANEL_OUTSIDE = 0.06;
// Measured on the 640px layout frames of the Law By Mike part.
// A face the camera did not focus (whip, title-card avatar) scores under 40.
// A side face has to be clearly sharp before it may pull the 9:16 crop out of
// the middle: the wide-shot host scored 500+, the avatar beside the seal scored
// under 180. A soft face near the middle still counts, so a slightly soft
// close-up is not dropped.
const FACE_SHARP_MIN = 40;
const SIDE_FACE_SHARP_MIN = 220;
const SIDE_FACE_OFFSET = 0.15;
// A cut into a still frame that has nothing to follow. Measured on the 134 s
// part, 160x90 grey: the title card at 99.5 s changes by 63, then stays under
// 21 for 1.5 s. The fish close-up changes by 45 inside the shot, and a quiet
// hold with no cut stays under 15. Those keep the previous aim. A phone card
// already has a panel, so it never enters this path.
const STILL_CUT_MIN = 40;
const STILL_HOLD_MAX = 30;
const STILL_MIN_SEC = 1;
// A box that touches the frame edge is cut off. The scoreboard's right
// monitor still ends near 0.99 and must stay a split, so only the last
// half percent counts as cut. A second title card whose edge is the frame
// itself (measured right edge 1.0) is the case this catches.
const FRAME_EDGE = 0.005;

const median = (values) => {
    const list = values.map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!list.length) return null;
    return list[Math.floor(list.length / 2)];
};

const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

const bestPanel = (sample) => {
    const list = Array.isArray(sample?.panels) ? sample.panels : [];
    let best = null;
    for (const panel of list) {
        const w = Number(panel?.w);
        if (!Number.isFinite(w) || w < 0.12 || w > 0.45) continue;
        if (!best || Number(panel.score) > Number(best.score)) best = panel;
    }
    return best;
};

const outsideOf = (boxes, panel, pad) => (Array.isArray(boxes) ? boxes : []).filter((box) => {
    const cx = Number(box?.cx);
    return Number.isFinite(cx) && Math.abs(cx - Number(panel.cx)) > Number(panel.w) / 2 + pad;
});

// YOLO sometimes draws the same torso twice. The smaller centre sits inside
// the larger box and the widths are close (0.61 inside 0.86 beside a product
// card). Two people standing apart do not contain each other. Only the
// duplicate is dropped, and only for the phone-and-person count.
const sameTorso = (people) => {
    const list = (Array.isArray(people) ? people : [])
        .filter((box) => Number(box?.w) >= 0.08 && Number.isFinite(Number(box?.cx)));
    if (list.length < 2) return list;
    const big = [...list].sort((a, b) => Number(b.w) - Number(a.w))[0];
    return list.filter((box) => {
        if (box === big) return true;
        const inside = Math.abs(Number(box.cx) - Number(big.cx)) <= Number(big.w) / 2;
        const closeSize = Number(box.w) >= Number(big.w) * 0.65;
        return !(inside && closeSize);
    });
};

// `cy` on a person box is 15% down from the top of the box, not the middle.
// Both tops in the top fifth means two arms entering an overhead table, not
// two people. A seated host's shoulders sit lower than this. A long run of
// these arms is its own split. This check only names them.
const armsOnTable = (people) => {
    const list = (Array.isArray(people) ? people : [])
        .filter((box) => Number(box?.w) >= 0.08 && Number.isFinite(Number(box?.cx)) && Number.isFinite(Number(box?.cy)));
    if (list.length !== 2) return false;
    if (!list.every((box) => Number(box.cy) <= 0.20)) return false;
    const [left, right] = [...list].sort((a, b) => Number(a.cx) - Number(b.cx));
    return Number(right.cx) - Number(left.cx) >= 0.35;
};

const realFace = (box) => {
    const w = Number(box?.w);
    return !Number.isFinite(w) || w >= 0.06;
};

const frameCut = (box) => {
    const cx = Number(box?.cx);
    const w = Number(box?.w);
    if (!Number.isFinite(cx) || !Number.isFinite(w) || w <= 0) return true;
    return cx - w / 2 < FRAME_EDGE || cx + w / 2 > 1 - FRAME_EDGE;
};

// A wide monitor can touch the frame and still be a real half (the
// scoreboard's right box is about 0.42 wide). A sliced title card is the
// narrow one, about 0.22 wide, with its far edge on the frame itself.
const slicedOff = (box) => frameCut(box) && Number(box.w) < 0.32;

// One card fully on screen, the other sliced by the frame. The sliced card
// is not a second half. The crop follows the card that is actually there.
const inFrameOfPair = (sample) => {
    if (sample?.pairKind === 'round' || sample?.pairKind === 'ink') return null;
    const pair = Array.isArray(sample?.pair) ? sample.pair : [];
    if (pair.length !== 2) return null;
    const inside = pair.filter((box) => !frameCut(box));
    if (inside.length !== 1 || pair.filter((box) => slicedOff(box)).length !== 1) return null;
    const kept = inside[0];
    const w = Number(kept.w);
    if (!(w >= 0.18 && w <= 0.60)) return null;
    return kept;
};

const runsToSplits = (hits, why, drift = 0.1) => {
    const out = [];
    let run = [];
    const flush = () => {
        if (run.length < 2) {
            run = [];
            return;
        }
        let piece = [];
        const flushPiece = () => {
            if (piece.length < 2) {
                piece = [];
                return;
            }
            const dur = piece[piece.length - 1].t - piece[0].t;
            if (dur < MIN_SPLIT_SEC) {
                piece = [];
                return;
            }
            const cx = median(piece.map((p) => p.left.cx));
            const cx2 = median(piece.map((p) => p.right.cx));
            const cy = median(piece.map((p) => p.left.cy));
            const cy2 = median(piece.map((p) => p.right.cy));
            if (cx == null || cx2 == null || cx2 - cx < MIN_PAIR_GAP) {
                piece = [];
                return;
            }
            const split = {
                a: piece[0].t,
                b: piece[piece.length - 1].t,
                cx: round3(cx),
                cy: round3(cy == null ? 0.5 : cy),
                cx2: round3(cx2),
                cy2: round3(cy2 == null ? 0.5 : cy2),
                why,
            };
            const panelWs = piece.map((p) => Number(p.panelW)).filter((n) => Number.isFinite(n) && n > 0);
            if (panelWs.length) {
                split.panelW = round3(median(panelWs));
                split.panelTop = piece.filter((p) => p.panelTop).length * 2 >= piece.length;
            }
            out.push(split);
            piece = [];
        };
        for (const sample of run) {
            const prev = piece[piece.length - 1];
            if (prev && (Math.abs(sample.left.cx - prev.left.cx) > drift || Math.abs(sample.right.cx - prev.right.cx) > drift)) {
                flushPiece();
            }
            piece.push(sample);
        }
        flushPiece();
        run = [];
    };
    for (const hit of hits) {
        if (run.length && hit.t - run[run.length - 1].t <= BRIDGE_SEC) run.push(hit);
        else {
            flush();
            run = [hit];
        }
    }
    flush();
    return out;
};

// A portrait graphic (phone ad) beside exactly one real face or person.
export const panelFaceSplits = (samples) => {
    const hits = [];
    for (const sample of Array.isArray(samples) ? samples : []) {
        const panel = bestPanel(sample);
        if (!panel || !Number.isFinite(Number(panel.cx))) continue;
        const faces = outsideOf(sample.faces, panel, PANEL_OUTSIDE);
        const people = outsideOf(sameTorso(sample.people), panel, 0.08).filter((p) => Number(p.w) >= 0.08);
        const subject = faces.length === 1 ? faces[0] : (faces.length === 0 && people.length === 1 ? people[0] : null);
        if (!subject || Math.abs(Number(subject.cx) - Number(panel.cx)) < MIN_PAIR_GAP) continue;
        // The body box stores cy at the collar. In a close-up with no face the
        // hands and the product are in the middle, so that half aims there.
        // A wide card beside those hands sits a little below the frame middle:
        // cy 0.5 cut the bottom of the card, and 0.56 held the whole card.
        // A face beside a phone keeps the face and the panel centre.
        const wideCard = faces.length === 0
            && Number(panel.w) >= 0.35
            && Number(subject.w) >= 0.55
            && Number(subject.cy) <= 0.22;
        const aimedSubject = wideCard ? { ...subject, cy: 0.5 } : subject;
        const aimedPanel = wideCard ? { ...panel, cy: 0.56 } : panel;
        const leftIsPanel = Number(panel.cx) < Number(subject.cx);
        const left = leftIsPanel ? aimedPanel : aimedSubject;
        const right = leftIsPanel ? aimedSubject : aimedPanel;
        hits.push({
            t: Number(sample.t),
            left,
            right,
            panelW: Number(panel.w),
            panelTop: leftIsPanel,
        });
    }
    return runsToSplits(prerollWideCard(stretchPanelToCut(hits, samples), samples), 'detector: điện thoại và người');
};

// A product card beside the hands can be on screen for about a second and
// still be seen at only two samples. The next sample is the cut. Ending the
// run on that cut reaches the 1 s minimum without lowering it. A short card
// with no cut after it stays too short to split.
const stretchPanelToCut = (hits, samples) => {
    if (!Array.isArray(hits) || hits.length < 2) return hits;
    const ordered = [...hits].sort((a, b) => a.t - b.t);
    const rows = (Array.isArray(samples) ? samples : [])
        .filter((sample) => Number.isFinite(Number(sample?.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
    const out = ordered.map((hit) => ({ ...hit }));
    let run = [];
    const consider = (group) => {
        if (group.length < 2) return;
        const a = group[0].t;
        const b = group[group.length - 1].t;
        if (b - a >= MIN_SPLIT_SEC) return;
        const next = rows.find((sample) => Number(sample.t) > b + 0.05);
        if (!next) return;
        const dt = Number(next.t) - b;
        if (!(Number(next.motion) >= STILL_CUT_MIN && dt <= 0.6 && Number(next.t) - a >= MIN_SPLIT_SEC)) return;
        out.push({ ...group[group.length - 1], t: Number(next.t) });
    };
    for (const hit of ordered) {
        if (run.length && hit.t - run[run.length - 1].t > BRIDGE_SEC) {
            consider(run);
            run = [hit];
        } else run.push(hit);
    }
    consider(run);
    out.sort((a, b) => a.t - b.t);
    return out;
};

// The edge detector can miss the first half-second of a wide product card.
// That sample is still the same close-up: one torso filling the frame from
// the top, no face, no panel yet. Starting the split there uses the card
// position the next sample already measured. A phone beside a face, and a
// shot that is not this close-up, are left alone.
const prerollWideCard = (hits, samples) => {
    if (!Array.isArray(hits) || !hits.length) return hits;
    const ordered = [...hits].sort((a, b) => a.t - b.t);
    const rows = (Array.isArray(samples) ? samples : [])
        .filter((sample) => Number.isFinite(Number(sample?.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
    const out = ordered.map((hit) => ({ ...hit }));
    let run = [];
    const consider = (group) => {
        const first = group[0];
        if (!(Number(first?.panelW) >= 0.35)) return;
        const sides = [first.left, first.right];
        if (!sides.some((side) => Number(side?.w) >= 0.55)) return;
        const prev = [...rows].reverse().find((sample) => Number(sample.t) < first.t - 0.05);
        if (!prev || first.t - Number(prev.t) > 0.6) return;
        const faces = (Array.isArray(prev.faces) ? prev.faces : []).filter(realFace);
        if (faces.length || bestPanel(prev)) return;
        const people = sameTorso(prev.people).filter((box) => Number(box.w) >= 0.08);
        if (people.length !== 1) return;
        const box = people[0];
        if (!(Number(box.w) >= 0.55 && Number(box.cy) <= 0.22)) return;
        out.push({ ...first, t: Number(prev.t) });
    };
    for (const hit of ordered) {
        if (run.length && hit.t - run[run.length - 1].t > BRIDGE_SEC) {
            consider(run);
            run = [hit];
        } else run.push(hit);
    }
    consider(run);
    out.sort((a, b) => a.t - b.t);
    return out;
};

// A 16:9 frame rendered to 9:16 drops the sides. Exactly two real faces open
// their own split once each half can hold one. The split half is 728 px on a
// 1920-wide frame (0.379). At a gap of 0.30 the halves share about a fifth,
// and each face still sits in its own half. Desk pairs at 0.30–0.34 on more
// than one video are this class. A gap of 0.284–0.286 stays one crop. Body
// boxes still need 0.35. The shared 0.35 gate is not lowered.
const FACE_OPEN_GAP = 0.30;
// A face pair just under that opener can stay on a split that already
// opened, when each face has barely moved. Measured: 0.296 in the middle of
// a 0.31 pair. 0.284 on the next lean does not join. A lone pair under 0.30
// still does not open one.
const FACE_KEEP_GAP = 0.29;
const FACE_HOLD_MOVE = 0.08;

// The last two-face sample can sit half a second before the cut. The faces
// stay on screen until the picture changes, and that change was measured
// 0.08–0.13 s before the next scan sample. Stopping 0.13 s short of the
// sample keeps those faces and leaves the new shot out. A side pair, a
// phone, or the overhead arms are a different shot and are not covered.
const CUT_HOLD_BACK = 0.13;
const holdTwoPersonToCut = (splits, samples) => {
    const rows = (Array.isArray(samples) ? samples : [])
        .filter((sample) => Number.isFinite(Number(sample?.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
    return splits.map((split) => {
        const next = rows.find((sample) => Number(sample.t) > Number(split.b) + 0.05);
        if (!next) return split;
        const dt = Number(next.t) - Number(split.b);
        if (!(dt <= 0.6 && Number(next.motion) >= STILL_CUT_MIN)) return split;
        if (armsOnTable(next.people) || bestPanel(next)) return split;
        if (Array.isArray(next.pair) && next.pair.length === 2) return split;
        const faces = Array.isArray(next.faces) ? next.faces : [];
        if (faces.length === 2) return split;
        const b = round3(Number(next.t) - CUT_HOLD_BACK);
        if (!(b > Number(split.b))) return split;
        return { ...split, b };
    });
};

// Exactly two comparable subjects, far enough apart that each half can hold one.
// A video wall has many faces and must not become a split. A huge host box next
// to a tiny face inside an ad fails the size ratio on purpose.
export const twoPersonSplits = (samples) => {
    const rows = (Array.isArray(samples) ? samples : [])
        .filter((sample) => Number.isFinite(Number(sample?.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
    const hits = [];
    const faceHits = [];
    for (const sample of rows) {
        const faces = Array.isArray(sample?.faces) ? sample.faces : [];
        const people = Array.isArray(sample?.people) ? sample.people : [];
        // Two faces are two people. Two body boxes count only when the frame
        // has no face: one face plus a second body is an arm or a shoulder of
        // the same close-up. Measured, that body sat at cx 0.17 beside the
        // face at 0.57 and, joined to the next two-face sample, split the
        // shoulder over the head. A frame with no face still uses the bodies.
        // Two arms lying across the top of a table are not two people, even
        // when a knuckle or a watch is detected as a face. Their box tops sit
        // in the top fifth. A seated pair sits lower and still splits.
        if (armsOnTable(people)) continue;
        const bodies = faces.length === 0 && people.length === 2 ? people : null;
        const pair = faces.length === 2 ? faces : bodies;
        if (!pair) continue;
        const [left, right] = [...pair].sort((a, b) => Number(a.cx) - Number(b.cx));
        const lw = Number(left.w) || 0;
        const rw = Number(right.w) || 0;
        if (lw < 0.06 || rw < 0.06) continue;
        if (Math.max(lw, rw) / Math.max(0.001, Math.min(lw, rw)) > 2.5) continue;
        const gap = Number(right.cx) - Number(left.cx);
        const hit = { t: Number(sample.t), left, right };
        const facePair = faces.length === 2;
        if (gap >= 0.35 || (facePair && gap >= FACE_OPEN_GAP)) {
            hits.push(hit);
            if (facePair) faceHits.push(hit);
            continue;
        }
        if (!facePair || gap < FACE_KEEP_GAP) continue;
        const prev = [...faceHits].reverse().find((item) => hit.t > item.t && hit.t - item.t <= BRIDGE_SEC);
        if (!prev) continue;
        if (Math.abs(Number(left.cx) - Number(prev.left.cx)) >= FACE_HOLD_MOVE) continue;
        if (Math.abs(Number(right.cx) - Number(prev.right.cx)) >= FACE_HOLD_MOVE) continue;
        hits.push(hit);
        faceHits.push(hit);
    }
    // A lean moves a face by about 0.15 between 2 fps samples. The shared
    // 0.1 break, used for a phone and a side pair, was dropping that pair
    // into pieces shorter than a second. 0.2 keeps the two people. A jump
    // larger than that is still a new shot. A sample between two hits that
    // changes by the cut threshold is a different picture (measured 98.9
    // with no face). A missed face inside the same shot stays under that
    // and still bridges.
    const groups = [];
    let group = [];
    for (const hit of hits) {
        const prev = group[group.length - 1];
        const crossed = prev && rows.some((sample) => {
            const t = Number(sample.t);
            return t > prev.t + 0.05 && t < hit.t - 0.05 && Number(sample.motion) >= STILL_CUT_MIN;
        });
        if (crossed) {
            groups.push(group);
            group = [hit];
        } else group.push(hit);
    }
    if (group.length) groups.push(group);
    const splits = groups.flatMap((list) => runsToSplits(list, 'detector: 2 người', 0.2));
    return holdTwoPersonToCut(splits, rows);
};

// Two arms entering an overhead table from opposite edges. One 9:16 crop
// keeps the middle and cuts both pairs of hands. Each half takes one edge.
// The cameras stay on the body boxes, so a knuckle detected as a face does
// not move them, and this run does not share a median with the seated pair
// just before the cut. The centre of the table falls outside both halves.
export const armSplits = (samples) => {
    const hits = [];
    for (const sample of Array.isArray(samples) ? samples : []) {
        const people = Array.isArray(sample?.people) ? sample.people : [];
        if (!armsOnTable(people)) continue;
        const list = people.filter((box) => Number(box?.w) >= 0.08 && Number.isFinite(Number(box?.cx)) && Number.isFinite(Number(box?.cy)));
        const [left, right] = [...list].sort((a, b) => Number(a.cx) - Number(b.cx));
        hits.push({ t: Number(sample.t), left, right });
    }
    return runsToSplits(hits, 'detector: hai tay', 0.2);
};

// Two real people on one wall, and two arms on one wooden table, score alike
// on the luma grid even though each half is a different subject. Phones, side
// pairs and ink drawings still drop. The overlap gate is separate and stays.
export const keepsLookAlikeSplit = (why) => {
    const text = String(why || '');
    return text.startsWith('detector: hai vật tròn')
        || text.startsWith('detector: 2 người')
        || text.startsWith('detector: hai tay');
};

// Two comparable objects, far enough apart that one 9:16 crop drops a side.
// `pair` is a dark canvas, two ink drawings on a light page, or two round
// objects. A bright room with a real face never arrives here. Four or more
// faces are a video wall and stay one crop.
export const sidePairSplits = (samples) => {
    const hits = [];
    for (const sample of Array.isArray(samples) ? samples : []) {
        const faces = (Array.isArray(sample?.faces) ? sample.faces : [])
            .filter((box) => Number(box?.w) >= 0.015);
        if (faces.length >= 4) continue;
        const pair = Array.isArray(sample?.pair) ? sample.pair : [];
        if (pair.length !== 2) continue;
        const [left, right] = [...pair].sort((a, b) => Number(a.cx) - Number(b.cx));
        const lw = Number(left.w) || 0;
        const rw = Number(right.w) || 0;
        if (lw < 0.18 || rw < 0.18 || lw > 0.60 || rw > 0.60) continue;
        if (Math.max(lw, rw) / Math.max(0.001, Math.min(lw, rw)) > 2.2) continue;
        if (Number(right.cx) - Number(left.cx) < 0.35) continue;
        // A second card sliced by the frame edge is a sliver, not a half.
        if (slicedOff(left) || slicedOff(right)) continue;
        hits.push({
            t: Number(sample.t),
            kind: sample?.pairKind === 'round' ? 'round' : 'side',
            left: { cx: Number(left.cx), cy: Number.isFinite(Number(left.cy)) ? Number(left.cy) : 0.45 },
            right: { cx: Number(right.cx), cy: Number.isFinite(Number(right.cy)) ? Number(right.cy) : 0.45 },
        });
    }
    // The last sample of a dark-canvas pair is still the scoreboard; the
    // next sample is the cut. Holding half a second keeps the final numbers
    // in the split. A round pair (two bowls) does not get that hold: the
    // next sample is often already a close-up of one of them.
    const finish = (list, why, extra) => runsToSplits(list, why).map((split) => ({
        ...split,
        b: round3(Number(split.b) + extra),
    }));
    return [
        ...finish(hits.filter((hit) => hit.kind !== 'round'), 'detector: hai phía', 0.45),
        ...finish(hits.filter((hit) => hit.kind === 'round'), 'detector: hai vật tròn', 0),
    ];
};

const mergeInserts = (panelSplits, personSplits) => {
    const out = panelSplits.map((split) => ({ ...split }));
    for (const split of personSplits) {
        let cursor = split.a;
        const blockers = out
            .filter((panel) => panel.b > split.a && panel.a < split.b)
            .sort((a, b) => a.a - b.a);
        for (const blocker of blockers) {
            if (blocker.a - cursor >= MIN_SPLIT_SEC) out.push({ ...split, a: cursor, b: blocker.a });
            cursor = Math.max(cursor, blocker.b);
        }
        if (split.b - cursor >= MIN_SPLIT_SEC) out.push({ ...split, a: cursor, b: split.b });
    }
    out.sort((a, b) => a.a - b.a);
    return out;
};

const sampleSupportsSplit = (sample) => {
    const panel = bestPanel(sample);
    const faces = Array.isArray(sample?.faces) ? sample.faces : [];
    const people = Array.isArray(sample?.people) ? sample.people : [];
    if (panel) {
        const faceOut = outsideOf(faces, panel, PANEL_OUTSIDE);
        const personOut = outsideOf(people, panel, 0.08).filter((p) => Number(p.w) >= 0.08);
        if ((faceOut.length >= 1 || personOut.length >= 1)
            && Math.abs(Number((faceOut[0] || personOut[0]).cx) - Number(panel.cx)) >= MIN_PAIR_GAP) {
            return true;
        }
    }
    const realFaces = faces.filter(realFace).sort((a, b) => Number(a.cx) - Number(b.cx));
    // Faces drawn on the hands of an overhead table do not support a split.
    if (!armsOnTable(people) && realFaces.length === 2 && Number(realFaces[1].cx) - Number(realFaces[0].cx) >= 0.35) return true;
    if (people.length === 2 && !armsOnTable(people)) {
        const [left, right] = [...people].sort((a, b) => Number(a.cx) - Number(b.cx));
        if (Number(right.cx) - Number(left.cx) >= 0.35 && Number(left.w) >= 0.06 && Number(right.w) >= 0.06) return true;
    }
    const pair = Array.isArray(sample?.pair) ? sample.pair : [];
    if (pair.length === 2 && pair.some((box) => slicedOff(box))) return false;
    if (pair.length === 2 && Math.abs(Number(pair[1].cx) - Number(pair[0].cx)) >= 0.35) return true;
    return false;
};

// A model split that covers a one-person shot (the chair before the ad starts)
// is not a split. Blind stretches stay as the model wrote them.
const rangeDenied = (samples, a, b) => {
    const inside = samples.filter((s) => Number(s.t) >= a - 0.05 && Number(s.t) <= b + 0.05);
    if (inside.length < 2) return false;
    const support = inside.filter(sampleSupportsSplit).length;
    return support / inside.length < 0.34;
};

const faceCenter = (samples, a, b) => {
    const faces = samples
        .filter((s) => Number(s.t) >= a - 0.05 && Number(s.t) <= b + 0.05)
        .flatMap((s) => (Array.isArray(s.faces) ? s.faces : []))
        .filter(realFace);
    const cx = median(faces.map((f) => f.cx));
    return cx == null ? 0.5 : round3(cx);
};

const demoteSplit = (window, samples) => ({
    ...window,
    mode: 'focus',
    cx: faceCenter(samples, window.a, window.b),
    cy: 0.42,
    cx2: undefined,
    cy2: undefined,
    why: `${window.why ? `${window.why} · ` : ''}không có chủ thể thứ hai → focus`,
});

const lonePanelAims = (samples, windows) => {
    const aims = [];
    let run = [];
    const flush = () => {
        if (run.length < 2) {
            run = [];
            return;
        }
        const a = run[0].t;
        const b = run[run.length - 1].t;
        if (b - a < 0.8) {
            run = [];
            return;
        }
        const insideSplit = windows.some((w) => w.mode === 'split' && w.a <= a + 0.2 && w.b >= b - 0.2);
        if (!insideSplit) {
            // A clipped second card pulls the panel median off the card that
            // is fully inside. When that card was measured in this run, it
            // wins over the wandering panel centre.
            const kept = run.map((p) => p.inFrame).filter((n) => Number.isFinite(n));
            const cx = round3(median(kept.length ? kept : run.map((p) => p.cx)));
            const cy = round3(median(run.map((p) => p.cy)) ?? 0.5);
            aims.push({ t: a, cx, cy });
            aims.push({ t: Math.max(a, b - 0.05), cx, cy });
        }
        run = [];
    };
    for (const sample of samples) {
        const panel = bestPanel(sample);
        const faces = Array.isArray(sample?.faces) ? sample.faces : [];
        const alone = panel && faces.every((face) => Math.abs(Number(face.cx) - Number(panel.cx)) <= Number(panel.w) / 2 + 0.08);
        if (alone) {
            if (run.length && Number(sample.t) - run[run.length - 1].t > BRIDGE_SEC) flush();
            const kept = inFrameOfPair(sample);
            run.push({
                t: Number(sample.t),
                cx: Number(panel.cx),
                cy: Number.isFinite(Number(panel.cy)) ? Number(panel.cy) : 0.5,
                inFrame: kept ? Number(kept.cx) : null,
            });
        } else flush();
    }
    flush();
    return aims;
};

const hasPair = (sample) => {
    const pair = sample?.pair;
    return Array.isArray(pair) ? pair.length > 0 : Boolean(pair);
};

// Nothing in the frame the other rules already follow.
const emptyFrame = (sample) => {
    const faces = Array.isArray(sample?.faces) ? sample.faces : [];
    const people = Array.isArray(sample?.people) ? sample.people : [];
    const panels = Array.isArray(sample?.panels) ? sample.panels : [];
    return faces.length === 0 && people.length === 0 && panels.length === 0 && !hasPair(sample);
};

// The crop was still on the previous person when the shot cut to a centred
// title and the scan found nothing there. Recentring every empty sample would
// also move the fish, the laptop and the gavel, so this only fires when the
// picture cuts and then holds still.
const stillCenterAims = (samples, windows) => {
    const aims = [];
    let run = [];
    const flush = () => {
        if (run.length < 2) {
            run = [];
            return;
        }
        const a = run[0].t;
        const b = run[run.length - 1].t;
        const cut = Number(run[0].motion);
        const held = run.slice(1).every((sample) => Number(sample.motion) < STILL_HOLD_MAX);
        const insideSplit = windows.some((w) => w.mode === 'split' && Number(w.a) <= a + 0.2 && Number(w.b) >= b - 0.2);
        if (b - a >= STILL_MIN_SEC && cut >= STILL_CUT_MIN && held && !insideSplit) {
            aims.push({ t: a, cx: 0.5, cy: 0.5 });
            aims.push({ t: b, cx: 0.5, cy: 0.5 });
        }
        run = [];
    };
    for (const sample of samples) {
        const motion = Number(sample?.motion);
        if (!emptyFrame(sample) || !Number.isFinite(motion)) {
            flush();
            continue;
        }
        if (run.length && Number(sample.t) - run[run.length - 1].t > BRIDGE_SEC) flush();
        run.push({ t: Number(sample.t), motion });
    }
    flush();
    return aims;
};

const outsidePanel = (box, panel, pad) => {
    if (!panel) return true;
    const cx = Number(box?.cx);
    return Number.isFinite(cx) && Math.abs(cx - Number(panel.cx)) > Number(panel.w) / 2 + pad;
};

// One subject to follow in a focus crop. A video wall (many similar faces) and
// two people far apart return null: those are not "the" person. A face wins
// over a body box. The body box is the fallback when the face is turned away.
const usableFace = (box) => {
    const sharp = Number(box?.sharp);
    if (Number.isFinite(sharp) && sharp < FACE_SHARP_MIN) return false;
    const side = Math.abs(Number(box?.cx) - 0.5) >= SIDE_FACE_OFFSET;
    if (side && Number.isFinite(sharp) && sharp < SIDE_FACE_SHARP_MIN) return false;
    return true;
};

const focusSubject = (sample) => {
    // A glimpse of two arms shorter than a split still aims at the middle, so
    // one knuckle does not become the crop. A long run is `detector: hai tay`
    // and never uses this aim.
    if (armsOnTable(sample?.people)) return { cx: 0.5, cy: 0.5 };
    const panel = bestPanel(sample);
    const rawFaces = (Array.isArray(sample?.faces) ? sample.faces : [])
        .filter((box) => Number(box?.w) >= 0.015 && Number.isFinite(Number(box?.cx)));
    // A video wall is a field of faces. The biggest tile is only a little
    // larger than the next one (0.05 vs 0.03 at 96s) and is not the subject.
    if (rawFaces.length >= 4) return { cx: 0.5, cy: 0.42 };
    // A face the camera did not focus (title-card avatar, whip) is not a
    // person to chase. Falling through to the body box would chase the same spot.
    const sharpFaces = rawFaces.filter(usableFace);
    if (rawFaces.length && !sharpFaces.length) return null;
    const faces = sharpFaces
        .filter((box) => outsidePanel(box, panel, PANEL_OUTSIDE) && Number(box.w) >= 0.03);
    // No face. A medium box is usually the back of a head beside the thing the
    // camera actually focused (a laptop, a title). Only a torso that fills the
    // frame, face already out of shot, may move the crop.
    const people = (Array.isArray(sample?.people) ? sample.people : [])
        .filter((box) => outsidePanel(box, panel, 0.08) && Number(box.w) >= 0.72 && Number(box.w) <= 0.92);
    const dominant = (boxes) => {
        if (!boxes.length) return null;
        const ranked = [...boxes].sort((a, b) => Number(b.w) - Number(a.w));
        const biggest = ranked[0];
        const next = ranked[1];
        if (!next) return biggest;
        const similar = Number(biggest.w) < Number(next.w) * 2;
        const apart = Math.abs(Number(biggest.cx) - Number(next.cx)) >= 0.35;
        if (ranked.length >= 3 && similar) return null;
        if (similar && apart) return null;
        return biggest;
    };
    const facePick = dominant(faces);
    if (!facePick && faces.length >= 3) return { cx: 0.5, cy: 0.42 };
    const subject = facePick || dominant(people);
    if (!subject || !Number.isFinite(Number(subject.cx))) return null;
    return {
        cx: Number(subject.cx),
        cy: Number.isFinite(Number(subject.cy)) ? Number(subject.cy) : 0.42,
        sharp: Number(subject.sharp),
    };
};

// Aim the focus crop at the detected person. The model often leaves cx at 0.5
// for a whole minute, and the brightness repair then walks onto a shiny prop.
// Points are thinned so the crop expression stays short: a still person is a
// few holds, a walk is a new point when the centre actually moves.
const focusSubjectAims = (samples, windows) => {
    const aims = [];
    const focus = (Array.isArray(windows) ? windows : [])
        .filter((w) => w.mode === 'focus' && Number(w.b) > Number(w.a));
    for (const window of focus) {
        const rows = samples.filter((s) => Number(s.t) >= Number(window.a) - 0.05 && Number(s.t) <= Number(window.b) + 0.05);
        let run = [];
        const flush = () => {
            // Two samples confirm a face. One sample still counts when it is a
            // sharp person standing off to the side: at 2 fps that pose often
            // lasts a single frame (the host beside BEFORE at 68s) and dropping
            // it leaves the crop on the prop.
            const only = run.length === 1 ? run[0] : null;
            const clearSide = only
                && Math.abs(only.cx - 0.5) >= SIDE_FACE_OFFSET
                && Number(only.sharp) >= SIDE_FACE_SHARP_MIN;
            if (run.length < 2 && !clearSide) {
                run = [];
                return;
            }
            const picked = [];
            const take = (point) => {
                const prev = picked[picked.length - 1];
                if (prev && Math.abs(prev.t - point.t) < 0.2 && Math.abs(prev.cx - point.cx) < 0.04) return;
                picked.push(point);
            };
            take(run[0]);
            for (let i = 1; i < run.length; i++) {
                const point = run[i];
                const prev = picked[picked.length - 1];
                if (Math.abs(point.cx - prev.cx) >= 0.04 || point.t - prev.t >= 2.8) take(point);
            }
            const end = run[run.length - 1];
            if (end.t - picked[picked.length - 1].t > 0.2) take(end);
            for (const point of picked) {
                aims.push({
                    t: Math.max(Number(window.a), point.t),
                    cx: round3(point.cx),
                    cy: round3(point.cy),
                });
            }
            const first = picked[0];
            if (first.t - Number(window.a) <= 0.6) {
                window.cx = round3(first.cx);
                window.cy = round3(first.cy);
            }
            run = [];
        };
        let followed = null;
        for (const sample of rows) {
            const subject = focusSubject(sample);
            const prev = run[run.length - 1];
            // `followed` survives a gap, so a soft face after a dropped sample
            // is still compared with the person we were on.
            const anchor = prev || followed;
            const cut = subject && anchor && (
                Number(sample.t) - anchor.t > 1
                || Math.abs(subject.cx - anchor.cx) > 0.18
            );
            if (!subject || cut) {
                flush();
                if (!subject) continue;
                // A soft face far from the person just followed is a false hit
                // on the body (84s: the crop left the head and landed on the legs).
                // A real cut to another shot is a sharp face and still goes through.
                if (anchor && Math.abs(subject.cx - anchor.cx) > 0.18
                    && Number.isFinite(Number(subject.sharp))
                    && Number(subject.sharp) < SIDE_FACE_SHARP_MIN) {
                    continue;
                }
            }
            const point = { t: Number(sample.t), cx: subject.cx, cy: subject.cy, sharp: subject.sharp };
            run.push(point);
            followed = point;
        }
        flush();
    }
    return aims;
};

// Rebuild the plan windows around detector splits. A focus stretch gains a split
// only where two subjects are actually apart. A model split keeps its own cameras
// where the scan is blind, and becomes focus where the scan sees one subject.
export const applyFocusLayout = (windows, samples) => {
    const list = Array.isArray(windows) ? windows : [];
    const rows = (Array.isArray(samples) ? samples : [])
        .filter((s) => s && Number.isFinite(Number(s.t)))
        .sort((a, b) => Number(a.t) - Number(b.t));
    if (!rows.length) return { windows: list.map((w) => ({ ...w })), aims: [] };
    const inserts = mergeInserts(
        mergeInserts(
            mergeInserts(panelFaceSplits(rows), twoPersonSplits(rows)),
            armSplits(rows),
        ),
        sidePairSplits(rows),
    );
    const out = [];
    const demoted = [];
    for (const window of list) {
        const a0 = Number(window.a) || 0;
        const b0 = Number(window.b) || 0;
        if (!(b0 > a0)) continue;
        const hits = inserts
            .map((split) => ({ ...split, a: Math.max(a0, split.a), b: Math.min(b0, split.b) }))
            .filter((split) => split.b - split.a >= 0.8);
        if (!hits.length) {
            if (window.mode === 'split' && rangeDenied(rows, a0, b0)) {
                const next = demoteSplit({ ...window, a: a0, b: b0 }, rows);
                demoted.push(next);
                out.push(next);
            } else out.push({ ...window });
            continue;
        }
        let cursor = a0;
        for (const hit of hits) {
            if (hit.a - cursor >= 0.8) {
                const gap = { ...window, a: cursor, b: hit.a };
                if (gap.mode === 'split' && rangeDenied(rows, gap.a, gap.b)) {
                    const next = demoteSplit(gap, rows);
                    demoted.push(next);
                    out.push(next);
                } else out.push(gap);
            }
            const next = {
                ...window,
                a: hit.a,
                b: hit.b,
                mode: 'split',
                cx: hit.cx,
                cy: hit.cy,
                cx2: hit.cx2,
                cy2: hit.cy2,
                why: hit.why,
            };
            if (Number.isFinite(hit.panelW)) {
                next.panelW = hit.panelW;
                next.panelTop = Boolean(hit.panelTop);
            }
            out.push(next);
            cursor = hit.b;
        }
        if (b0 - cursor >= 0.8) {
            const tail = { ...window, a: cursor, b: b0 };
            if (tail.mode === 'split' && rangeDenied(rows, tail.a, tail.b)) {
                const next = demoteSplit(tail, rows);
                demoted.push(next);
                out.push(next);
            } else out.push(tail);
        }
    }
    // The plan often stops a fraction early (measured: 132.8 s of a 134 s part).
    // The render then holds the last aim across the cut, which left the crop on
    // the phone while the next shot was two people at a desk. Samples past the
    // plan get the same face aim as any other focus stretch. A gap under 0.4 s
    // is the last sample of a window that already ended, not a new shot.
    const coveredTo = out.reduce((max, w) => Math.max(max, Number(w.b) || 0), 0);
    const lastT = Number(rows[rows.length - 1].t);
    if (lastT - coveredTo >= 0.4) {
        out.push({
            a: round3(coveredTo),
            b: round3(lastT),
            mode: 'focus',
            why: 'đuôi scan → focus',
        });
    }
    const aims = [
        ...demoted.map((w) => ({ t: w.a, cx: w.cx, cy: w.cy })),
        ...lonePanelAims(rows, out),
        ...stillCenterAims(rows, out),
        ...focusSubjectAims(rows, out),
    ];
    return { windows: out, aims };
};
