import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFocusLayout, panelFaceSplits, twoPersonSplits, sidePairSplits, armSplits, keepsLookAlikeSplit } from '../server/focus-layout.js';

const every = (from, to, step, make) => {
    const rows = [];
    for (let t = from; t <= to + 1e-6; t += step) rows.push(make(Math.round(t * 100) / 100));
    return rows;
};

const panel = (cx, w = 0.24) => ({ cx, cy: 0.5, w, score: 180 });
const face = (cx, cy = 0.42, w = 0.1) => ({ cx, cy, w });

test('a phone graphic beside one face becomes a split aimed at each', () => {
    const samples = every(0, 3, 0.5, (t) => ({ t, faces: [face(0.65)], people: [], panels: [panel(0.16)] }));
    const splits = panelFaceSplits(samples);
    assert.equal(splits.length, 1);
    assert.ok(splits[0].a <= 0.1 && splits[0].b >= 2.9);
    assert.ok(Math.abs(splits[0].cx - 0.16) < 0.02, splits[0].cx);
    assert.ok(Math.abs(splits[0].cx2 - 0.65) < 0.02, splits[0].cx2);
    const laid = applyFocusLayout([{ a: 0, b: 10, mode: 'focus', cx: 0.5, why: 'host' }], samples);
    const split = laid.windows.find((w) => w.mode === 'split');
    assert.ok(split);
    assert.equal(split.why, 'detector: điện thoại và người');
    assert.ok(Math.abs(split.panelW - 0.24) < 0.02, split.panelW);
    assert.equal(split.panelTop, true);
    assert.ok(laid.windows.some((w) => w.mode === 'focus' && w.a >= split.b - 0.01));
});

test('a phone graphic shorter than a second does not open a split', () => {
    const samples = every(1, 1.4, 0.2, (t) => ({ t, faces: [face(0.65)], people: [], panels: [panel(0.16)] }));
    assert.equal(panelFaceSplits(samples).length, 0);
});

test('a phone alone is an aim point, not a split', () => {
    const samples = every(123, 125, 0.5, (t) => ({ t, faces: [], people: [], panels: [panel(0.48, 0.23)] }));
    const laid = applyFocusLayout([{ a: 121, b: 132, mode: 'focus', cx: 0.5 }], samples);
    assert.equal(laid.windows.filter((w) => w.mode === 'split').length, 0);
    assert.ok(laid.aims.length >= 2);
    assert.ok(laid.aims.every((p) => Math.abs(p.cx - 0.48) < 0.02));
});

test('two people far apart inside a focus window become a split', () => {
    const samples = every(118, 121, 0.5, (t) => ({
        t,
        faces: [face(0.34, 0.32, 0.09), face(0.70, 0.33, 0.09)],
        people: [],
        panels: [],
    }));
    const laid = applyFocusLayout([{ a: 54, b: 132, mode: 'focus', cx: 0.5 }], samples);
    const split = laid.windows.find((w) => w.mode === 'split');
    assert.ok(split, JSON.stringify(laid.windows));
    assert.equal(split.why, 'detector: 2 người');
    assert.equal(split.panelW, undefined);
    assert.ok(split.cx < 0.4 && split.cx2 > 0.6);
});

test('two objects a single crop cannot hold become a split', () => {
    const pair = [
        { cx: 0.25, cy: 0.46, w: 0.38 },
        { cx: 0.74, cy: 0.39, w: 0.50 },
    ];
    const samples = every(97, 98.5, 0.5, (t) => ({
        t,
        faces: [],
        people: [{ cx: 0.59, cy: 0.45, w: 0.81 }],
        panels: [],
        pair,
    }));
    const splits = sidePairSplits(samples);
    assert.equal(splits.length, 1);
    assert.equal(splits[0].panelW, undefined);
    const laid = applyFocusLayout([{ a: 54, b: 118, mode: 'focus', cx: 0.5 }], samples);
    const split = laid.windows.find((w) => w.mode === 'split');
    assert.ok(split, JSON.stringify(laid.windows));
    assert.equal(split.why, 'detector: hai phía');
    assert.equal(split.panelW, undefined);
    assert.ok(split.cx < 0.35 && split.cx2 > 0.65, `${split.cx} ${split.cx2}`);
    assert.ok(split.a <= 97.1 && split.b >= 98.4, `${split.a}-${split.b}`);
    const during = laid.aims.filter((p) => p.t >= split.a - 0.05 && p.t <= split.b + 0.05);
    assert.ok(during.every((p) => Math.abs(p.cx - 0.59) > 0.08), JSON.stringify(during));
});

test('samples past the end of the plan still aim at the face', () => {
    const before = every(126, 132, 0.5, (t) => ({
        t,
        faces: [face(0.6, 0.4, 0.12)],
        people: [],
        panels: [],
    }));
    const after = [133, 133.5].map((t) => ({
        t,
        faces: [face(0.35, 0.3, 0.085), face(0.67, 0.34, 0.081)],
        people: [{ cx: 0.34, cy: 0.23, w: 0.35 }, { cx: 0.67, cy: 0.27, w: 0.3 }],
        panels: [],
    }));
    const laid = applyFocusLayout([{ a: 54, b: 132.8, mode: 'focus', cx: 0.5 }], [...before, ...after]);
    const tail = laid.windows.find((w) => w.mode === 'focus' && w.b >= 133.4);
    assert.ok(tail, JSON.stringify(laid.windows.map((w) => [w.mode, w.a, w.b])));
    const late = laid.aims.filter((p) => p.t >= 132.9);
    assert.ok(late.length >= 1, JSON.stringify(laid.aims));
    assert.ok(late.every((p) => Math.abs(p.cx - 0.35) < 0.04), JSON.stringify(late));
    assert.equal(laid.windows.filter((w) => w.a >= 132.8 && w.mode === 'split').length, 0);
});

test('a short side pair and a video wall stay one crop', () => {
    const flash = every(98, 98.4, 0.2, (t) => ({
        t,
        faces: [],
        people: [],
        panels: [],
        pair: [{ cx: 0.25, cy: 0.45, w: 0.3 }, { cx: 0.75, cy: 0.45, w: 0.3 }],
    }));
    assert.equal(sidePairSplits(flash).length, 0);
    const wall = every(94, 96, 0.5, (t) => ({
        t,
        faces: [0.1, 0.3, 0.5, 0.7, 0.9].map((cx) => face(cx, 0.4, 0.04)),
        people: [],
        panels: [],
        pair: [{ cx: 0.25, cy: 0.5, w: 0.3 }, { cx: 0.75, cy: 0.5, w: 0.3 }],
    }));
    const laid = applyFocusLayout([{ a: 54, b: 118, mode: 'focus', cx: 0.5 }], wall);
    assert.equal(laid.windows.filter((w) => w.mode === 'split').length, 0);
    assert.equal(laid.windows[0].cx, 0.5);
});

test('a video wall and two close people stay focus', () => {
    const wall = every(94, 96, 0.5, (t) => ({
        t,
        faces: [0.07, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((cx) => face(cx, 0.4, 0.02)),
        people: [],
        panels: [],
    }));
    assert.equal(twoPersonSplits(wall).length, 0);
    const close = every(1, 3, 0.5, (t) => ({
        t,
        faces: [],
        people: [{ cx: 0.49, cy: 0.3, w: 0.25 }, { cx: 0.51, cy: 0.4, w: 0.22 }],
        panels: [],
    }));
    assert.equal(twoPersonSplits(close).length, 0);
});

test('a model split is focus until the phone graphic actually appears', () => {
    const chair = every(45, 47, 0.5, (t) => ({ t, faces: [face(0.55)], people: [], panels: [] }));
    const ad = every(48, 53, 0.5, (t) => ({ t, faces: [face(0.65)], people: [], panels: [panel(0.16)] }));
    const laid = applyFocusLayout(
        [{ a: 45, b: 54, mode: 'split', cx: 0.15, cy: 0.5, cx2: 0.5, cy2: 0.5, why: 'model ad' }],
        [...chair, ...ad],
    );
    const first = laid.windows[0];
    assert.equal(first.mode, 'focus');
    assert.ok(first.b <= 48.1, first.b);
    assert.ok(Math.abs(first.cx - 0.55) < 0.05, first.cx);
    const split = laid.windows.find((w) => w.mode === 'split');
    assert.ok(split);
    assert.ok(split.a >= 47.5 && split.a <= 48.5, split.a);
    assert.ok(Math.abs(split.cx - 0.16) < 0.02);
    assert.ok(Math.abs(split.cx2 - 0.65) < 0.02);
    assert.ok(Math.abs(split.panelW - 0.24) < 0.02, split.panelW);
    assert.equal(split.panelTop, true);
});

test('a focus crop follows one face instead of staying at the centre', () => {
    const samples = every(54, 62, 0.5, (t) => ({
        t,
        faces: [face(0.33, 0.4, 0.08)],
        people: [{ cx: 0.30, cy: 0.45, w: 0.2 }],
        panels: [],
    }));
    const laid = applyFocusLayout([{ a: 54, b: 118, mode: 'focus', cx: 0.5, cy: 0.5 }], samples);
    assert.equal(laid.windows[0].mode, 'focus');
    assert.ok(Math.abs(laid.windows[0].cx - 0.33) < 0.03, laid.windows[0].cx);
    assert.ok(laid.aims.length >= 2);
    assert.ok(laid.aims.every((p) => Math.abs(p.cx - 0.33) < 0.03));
    assert.ok(laid.aims.length < 12, laid.aims.length);
});

test('a video wall does not pull the focus crop onto one tile', () => {
    const samples = every(94, 97, 0.5, (t) => ({
        t,
        faces: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((cx) => face(cx, 0.4, 0.04)),
        people: [],
        panels: [],
    }));
    const laid = applyFocusLayout([{ a: 54, b: 118, mode: 'focus', cx: 0.5 }], samples);
    assert.equal(laid.windows[0].cx, 0.5);
    assert.ok(laid.aims.every((p) => Math.abs(p.cx - 0.5) < 0.2));
});

test('the slightly largest tile on a wall is not the subject', () => {
    const tiles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((cx) => face(cx, 0.4, 0.03));
    tiles.push(face(0.9, 0.2, 0.05));
    const samples = every(94, 97, 0.5, (t) => ({ t, faces: tiles, people: [{ cx: 0.9, cy: 0.3, w: 0.16 }], panels: [] }));
    const laid = applyFocusLayout([{ a: 90, b: 100, mode: 'focus', cx: 0.5 }], samples);
    assert.ok(laid.aims.length >= 2);
    assert.ok(laid.aims.every((p) => Math.abs(p.cx - 0.5) < 0.05), JSON.stringify(laid.aims));
});

test('a blurred side face does not pull the crop off the graphic', () => {
    const samples = every(113, 117, 0.5, (t) => ({
        t,
        faces: [{ cx: 0.26, cy: 0.15, w: 0.1, sharp: 8 }],
        people: [{ cx: 0.28, cy: 0.4, w: 0.26 }],
        panels: [],
    }));
    const laid = applyFocusLayout([{ a: 108, b: 118, mode: 'focus', cx: 0.5 }], samples);
    assert.equal(laid.windows[0].cx, 0.5);
    assert.equal(laid.aims.length, 0);
});

test('a soft avatar beside a title stays put while a sharp side host is followed', () => {
    const avatar = every(113, 116, 0.5, (t) => ({
        t,
        faces: [{ cx: 0.25, cy: 0.3, w: 0.09, sharp: 120 }],
        people: [{ cx: 0.29, cy: 0.45, w: 0.25 }],
        panels: [],
    }));
    const laid = applyFocusLayout([{ a: 108, b: 118, mode: 'focus', cx: 0.5 }], avatar);
    assert.equal(laid.aims.length, 0);
    const host = every(56, 60, 0.5, (t) => ({
        t,
        faces: [{ cx: 0.33, cy: 0.2, w: 0.04, sharp: 700 }],
        people: [{ cx: 0.29, cy: 0.4, w: 0.16 }],
        panels: [],
    }));
    const followed = applyFocusLayout([{ a: 56, b: 70, mode: 'focus', cx: 0.5 }], host);
    assert.ok(Math.abs(followed.windows[0].cx - 0.33) < 0.03, followed.windows[0].cx);
});

test('a soft face far from the head does not pull the crop onto the legs', () => {
    const samples = [
        { t: 80, faces: [{ cx: 0.70, cy: 0.3, w: 0.06, sharp: 500 }], people: [], panels: [] },
        { t: 80.5, faces: [{ cx: 0.72, cy: 0.3, w: 0.06, sharp: 500 }], people: [], panels: [] },
        { t: 83, faces: [{ cx: 0.78, cy: 0.3, w: 0.08, sharp: 400 }], people: [], panels: [] },
        { t: 83.5, faces: [{ cx: 0.79, cy: 0.3, w: 0.08, sharp: 400 }], people: [], panels: [] },
        { t: 84, faces: [{ cx: 0.45, cy: 0.5, w: 0.06, sharp: 120 }], people: [], panels: [] },
        { t: 84.5, faces: [{ cx: 0.44, cy: 0.5, w: 0.06, sharp: 120 }], people: [], panels: [] },
    ];
    const laid = applyFocusLayout([{ a: 78, b: 90, mode: 'focus', cx: 0.5 }], samples);
    assert.ok(laid.aims.every((p) => p.cx > 0.6), JSON.stringify(laid.aims));
});

test('one sharp side face is kept when the samples around it have no face', () => {
    const samples = [
        { t: 67, faces: [{ cx: 0.55, cy: 0.3, w: 0.08, sharp: 400 }], people: [], panels: [] },
        { t: 67.5, faces: [], people: [{ cx: 0.29, cy: 0.4, w: 0.16 }], panels: [] },
        { t: 68, faces: [{ cx: 0.30, cy: 0.26, w: 0.04, sharp: 500 }], people: [], panels: [] },
        { t: 68.5, faces: [], people: [{ cx: 0.56, cy: 0.4, w: 0.23 }], panels: [] },
        { t: 69, faces: [{ cx: 0.53, cy: 0.4, w: 0.04, sharp: 400 }], people: [], panels: [] },
        { t: 69.5, faces: [{ cx: 0.54, cy: 0.4, w: 0.04, sharp: 400 }], people: [], panels: [] },
    ];
    const laid = applyFocusLayout([{ a: 54, b: 80, mode: 'focus', cx: 0.5 }], samples);
    assert.ok(laid.aims.some((p) => Math.abs(p.t - 68) < 0.05 && Math.abs(p.cx - 0.30) < 0.03), JSON.stringify(laid.aims));
});

test('only a torso that fills the frame moves the crop when the face is out of shot', () => {
    const shoulder = every(106, 110, 0.5, (t) => ({
        t, faces: [], people: [{ cx: 0.3, cy: 0.4, w: 0.6 }], panels: [],
    }));
    const wide = applyFocusLayout([{ a: 100, b: 112, mode: 'focus', cx: 0.5 }], shoulder);
    assert.equal(wide.aims.length, 0);
    const torso = every(19, 21, 0.5, (t) => ({
        t, faces: [], people: [{ cx: 0.41, cy: 0.5, w: 0.81 }], panels: [],
    }));
    const close = applyFocusLayout([{ a: 19, b: 24, mode: 'focus', cx: 0.5 }], torso);
    assert.ok(Math.abs(close.windows[0].cx - 0.41) < 0.03, close.windows[0].cx);
});

test('a still card with nobody recentres, and a moving empty shot does not', () => {
    const card = [
        { t: 98.5, faces: [], people: [{ cx: 0.59, cy: 0.2, w: 0.81 }], panels: [], motion: 10 },
        { t: 99, faces: [], people: [{ cx: 0.62, cy: 0.2, w: 0.76 }], panels: [], motion: 12 },
        { t: 99.5, faces: [], people: [], panels: [], motion: 63 },
        { t: 100, faces: [], people: [], panels: [], motion: 21 },
        { t: 100.5, faces: [], people: [], panels: [], motion: 14 },
        { t: 101, faces: [], people: [], panels: [], motion: 6 },
        { t: 101.5, faces: [face(0.51, 0.32, 0.09)], people: [], panels: [], motion: 50 },
        { t: 102, faces: [face(0.51, 0.32, 0.09)], people: [], panels: [], motion: 8 },
    ];
    const laid = applyFocusLayout([{ a: 98, b: 104, mode: 'focus', cx: 0.5 }], card);
    const mid = laid.aims.filter((p) => p.t >= 99.4 && p.t <= 101.05);
    assert.ok(mid.length >= 2, JSON.stringify(laid.aims));
    assert.ok(mid.every((p) => Math.abs(p.cx - 0.5) < 0.001), JSON.stringify(mid));
    assert.ok(laid.aims.some((p) => p.t >= 101.4 && Math.abs(p.cx - 0.51) < 0.04), JSON.stringify(laid.aims));
    assert.equal(laid.windows.filter((w) => w.mode === 'split').length, 0);

    const fish = [
        { t: 62.5, faces: [], people: [], panels: [], motion: 46 },
        { t: 63, faces: [], people: [], panels: [], motion: 12 },
        { t: 63.5, faces: [], people: [], panels: [], motion: 45 },
        { t: 64, faces: [], people: [], panels: [], motion: 9 },
    ];
    const moving = applyFocusLayout([{ a: 60, b: 66, mode: 'focus', cx: 0.55 }], fish);
    assert.equal(moving.aims.length, 0);

    const quiet = every(70.5, 72, 0.5, (t) => ({ t, faces: [], people: [], panels: [], motion: 12 }));
    const held = applyFocusLayout([{ a: 70, b: 74, mode: 'focus', cx: 0.55 }], quiet);
    assert.equal(held.aims.length, 0);

    const laptop = every(104, 106, 0.5, (t) => ({
        t, faces: [], people: [{ cx: 0.3, cy: 0.4, w: 0.4 }], panels: [], motion: t === 104 ? 70 : 5,
    }));
    const busy = applyFocusLayout([{ a: 103, b: 108, mode: 'focus', cx: 0.5 }], laptop);
    assert.equal(busy.aims.length, 0);

    const phone = every(123, 125, 0.5, (t) => ({
        t, faces: [], people: [], panels: [panel(0.48, 0.23)], motion: t === 123 ? 80 : 4,
    }));
    const ad = applyFocusLayout([{ a: 121, b: 126, mode: 'focus', cx: 0.5 }], phone);
    assert.ok(ad.aims.length >= 2);
    assert.ok(ad.aims.every((p) => Math.abs(p.cx - 0.48) < 0.02), JSON.stringify(ad.aims));
});

test('a card cut off by the frame is not a second half', () => {
    const card = (t, panelCx, pair) => ({
        t,
        faces: t === 0 ? [{ cx: 0.909, cy: 0.2, w: 0.07, sharp: 945 }] : [],
        people: [],
        panels: [{ cx: panelCx, cy: 0.5, w: 0.22, score: 100 }],
        pair,
    });
    const sliced = [{ cx: 0.516, cy: 0.5, w: 0.41 }, { cx: 0.892, cy: 0.5, w: 0.216 }];
    const samples = [
        card(0, 0.863, []),
        card(0.5, 0.445, []),
        card(1, 0.582, []),
        card(1.5, 0.588, []),
        card(2, 0.630, sliced),
        card(2.5, 0.590, sliced),
        card(3, 0.591, sliced),
    ];
    assert.equal(sidePairSplits(samples).length, 0);
    const laid = applyFocusLayout([{ a: 0, b: 8, mode: 'focus', cx: 0.5, why: 'title' }], samples);
    assert.equal(laid.windows.filter((w) => w.mode === 'split').length, 0);
    const aims = laid.aims.filter((p) => p.t <= 3.05);
    assert.ok(aims.length >= 2, JSON.stringify(laid.aims));
    assert.ok(aims.every((p) => Math.abs(p.cx - 0.516) < 0.03), JSON.stringify(aims));
});

test('two people may drift and a side pair that jumps still breaks', () => {
    const people = [
        [0, 0.08, 0.61],
        [0.5, 0.07, 0.60],
        [1.0, 0.22, 0.76],
        [1.5, 0.24, 0.78],
        [2.5, 0.50, 0.90],
    ].map(([t, left, right]) => ({
        t,
        faces: [face(left, 0.4, 0.14), face(right, 0.4, 0.14)],
        people: [],
        panels: [],
    }));
    const splits = twoPersonSplits(people);
    assert.equal(splits.length, 1, JSON.stringify(splits));
    assert.ok(splits[0].a <= 0.1 && splits[0].b >= 1.4, `${splits[0].a}-${splits[0].b}`);
    assert.ok(splits[0].cx < 0.3 && splits[0].cx2 > 0.7, `${splits[0].cx} ${splits[0].cx2}`);
    const jumping = [0, 0.5, 1.0, 1.5].map((t, i) => ({
        t,
        faces: [],
        people: [],
        panels: [],
        pair: [
            { cx: 0.25 + (i > 1 ? 0.16 : 0), cy: 0.45, w: 0.3 },
            { cx: 0.75, cy: 0.45, w: 0.3 },
        ],
    }));
    assert.equal(sidePairSplits(jumping).length, 0);
});

test('one face beside two body boxes is not two people', () => {
    const eating = [
        {
            t: 27.5,
            faces: [face(0.565, 0.513, 0.201, 58)],
            people: [{ cx: 0.172, cy: 0.368, w: 0.341 }, { cx: 0.652, cy: 0.173, w: 0.625 }],
            panels: [],
        },
        {
            t: 28.5,
            faces: [face(0.049, 0.296, 0.114, 269), face(0.546, 0.386, 0.137, 260)],
            people: [{ cx: 0.149, cy: 0.179, w: 0.298 }, { cx: 0.548, cy: 0.249, w: 0.501 }],
            panels: [],
        },
    ];
    assert.equal(twoPersonSplits(eating).length, 0);
    const bodies = [0, 1].map((t) => ({
        t,
        faces: [],
        people: [{ cx: 0.25, cy: 0.4, w: 0.2 }, { cx: 0.75, cy: 0.4, w: 0.2 }],
        panels: [],
    }));
    assert.equal(twoPersonSplits(bodies).length, 1);
});

test('two round objects are their own split and do not pad', () => {
    const samples = every(21, 22.5, 0.5, (t) => ({
        t,
        faces: [],
        people: [],
        panels: [],
        pairKind: 'round',
        pair: [
            { cx: 0.25, cy: 0.49, w: 0.24 },
            { cx: 0.75, cy: 0.49, w: 0.24 },
        ],
    }));
    const splits = sidePairSplits(samples);
    assert.equal(splits.length, 1);
    assert.equal(splits[0].why, 'detector: hai vật tròn');
    assert.equal(splits[0].panelW, undefined);
    assert.ok(Math.abs(splits[0].b - 22.5) < 0.01, splits[0].b);
});

test('one face beside a wide board is a split aimed at the face and the board', () => {
    const samples = every(10.5, 14.5, 0.5, (t) => ({
        t,
        faces: [face(0.19, 0.34, 0.13, 370), { cx: 0.79, cy: 0.46, w: 0.025, sharp: 5000 }],
        people: [{ cx: 0.18, cy: 0.23, w: 0.37 }],
        panels: [],
        pairKind: 'side',
        pair: [
            { cx: 0.19, cy: 0.34, w: 0.37 },
            { cx: 0.69, cy: 0.46, w: 0.45 },
        ],
    }));
    const splits = sidePairSplits(samples);
    assert.equal(splits.length, 1);
    assert.equal(splits[0].why, 'detector: hai phía');
    assert.ok(splits[0].cx < 0.3 && splits[0].cx2 > 0.6, `${splits[0].cx} ${splits[0].cx2}`);
    const laid = applyFocusLayout(
        [{ a: 10.5, b: 15, mode: 'split', cx: 0.45, cy: 0.4, cx2: 0.72, cy2: 0.5, why: 'model graphic' }],
        samples,
    );
    const split = laid.windows.find((w) => w.mode === 'split' && String(w.why).startsWith('detector:'));
    assert.ok(split, JSON.stringify(laid.windows));
    assert.ok(Math.abs(split.cx - 0.19) < 0.03, split.cx);
    assert.ok(Math.abs(split.cx2 - 0.69) < 0.03, split.cx2);
});

test('a speck face does not keep a model split aimed at the seam', () => {
    const samples = every(11, 14.5, 0.5, (t) => ({
        t,
        faces: [face(0.19, 0.34, 0.13, 370), { cx: 0.79, cy: 0.46, w: 0.025, sharp: 5000 }],
        people: [{ cx: 0.18, cy: 0.23, w: 0.37 }],
        panels: [],
    }));
    const laid = applyFocusLayout(
        [{ a: 11, b: 14.5, mode: 'split', cx: 0.45, cy: 0.4, cx2: 0.72, cy2: 0.5, why: 'model graphic' }],
        samples,
    );
    assert.equal(laid.windows.filter((w) => w.mode === 'split').length, 0);
    assert.ok(Math.abs(laid.windows[0].cx - 0.19) < 0.04, laid.windows[0].cx);
});

test('a short product card beside one person splits when the next sample is the cut', () => {
    const card = (t, people, motion) => ({
        t,
        faces: [],
        people,
        panels: [{ cx: 0.263, cy: 0.5, w: 0.39, score: 107 }],
        motion,
    });
    const samples = [
        // The card is already in the hands, but the edge detector has not
        // locked yet. The split still has to start on this sample.
        { t: 23.0, faces: [], people: [{ cx: 0.555, cy: 0.15, w: 0.888 }], panels: [], motion: 38 },
        card(23.5, [{ cx: 0.566, cy: 0.15, w: 0.862 }, { cx: 0.697, cy: 0.2, w: 0.606 }], 38),
        card(24.0, [{ cx: 0.597, cy: 0.15, w: 0.796 }], 30),
        { t: 24.5, faces: [], people: [], panels: [], motion: 72 },
    ];
    const splits = panelFaceSplits(samples);
    assert.equal(splits.length, 1, JSON.stringify(splits));
    assert.ok(splits[0].a <= 23.05 && splits[0].b >= 24.4, `${splits[0].a}-${splits[0].b}`);
    assert.ok(splits[0].cx < 0.4 && splits[0].cx2 > 0.5, `${splits[0].cx} ${splits[0].cx2}`);
    // The body cy is the collar. The hands stay in the middle, and the wide
    // card sits just below the middle so its bottom stays in the half.
    assert.ok(Math.abs(splits[0].cy - 0.56) < 0.02, splits[0].cy);
    assert.ok(Math.abs(splits[0].cy2 - 0.5) < 0.02, splits[0].cy2);
    const quiet = [
        card(23.5, [{ cx: 0.566, cy: 0.15, w: 0.862 }, { cx: 0.697, cy: 0.2, w: 0.606 }], 38),
        card(24.0, [{ cx: 0.597, cy: 0.15, w: 0.796 }], 30),
        { t: 24.5, faces: [], people: [{ cx: 0.597, cy: 0.15, w: 0.796 }], panels: [], motion: 8 },
    ];
    assert.equal(panelFaceSplits(quiet).length, 0);
});

test('two arms across the top of a table are their own split', () => {
    const samples = every(44, 47, 0.5, (t) => ({
        t,
        faces: t === 47 ? [face(0.21, 0.19, 0.12, 364)] : [],
        people: [{ cx: 0.17, cy: 0.07, w: 0.35 }, { cx: 0.88, cy: 0.04, w: 0.22 }],
        panels: [],
        motion: t === 44 ? 62 : 5,
    }));
    assert.equal(twoPersonSplits(samples).length, 0);
    const arms = armSplits(samples);
    assert.equal(arms.length, 1, JSON.stringify(arms));
    assert.equal(arms[0].why, 'detector: hai tay');
    assert.ok(Math.abs(arms[0].cx - 0.17) < 0.04, arms[0].cx);
    assert.ok(Math.abs(arms[0].cx2 - 0.88) < 0.04, arms[0].cx2);
    assert.ok(arms[0].cy < 0.2 && arms[0].cy2 < 0.2, `${arms[0].cy} ${arms[0].cy2}`);
    const laid = applyFocusLayout([{ a: 42, b: 50, mode: 'focus', cx: 0.32, cy: 0.4 }], samples);
    const split = laid.windows.find((w) => w.mode === 'split');
    assert.ok(split);
    assert.equal(split.why, 'detector: hai tay');
    assert.ok(split.a <= 44.05 && split.b >= 46.9, `${split.a}-${split.b}`);
});

test('a face on an arm does not pull the two-person split onto the table', () => {
    const talk = every(42, 43.5, 0.5, (t) => ({
        t,
        faces: [{ cx: 0.28, cy: 0.36, w: 0.1 }, { cx: 0.74, cy: 0.48, w: 0.09 }],
        people: [{ cx: 0.27, cy: 0.26, w: 0.45 }, { cx: 0.67, cy: 0.35, w: 0.32 }],
        panels: [],
    }));
    const table = {
        t: 44.5,
        faces: [{ cx: 0.22, cy: 0.24, w: 0.11 }, { cx: 0.88, cy: 0.21, w: 0.22 }],
        people: [{ cx: 0.18, cy: 0.07, w: 0.36 }, { cx: 0.88, cy: 0.04, w: 0.25 }],
        panels: [],
    };
    const splits = twoPersonSplits([...talk, table]);
    assert.equal(splits.length, 1, JSON.stringify(splits));
    assert.ok(splits[0].b <= 43.6, splits[0].b);
    assert.equal(armSplits([table]).length, 0);
});

test('arms on the table do not share a camera with the seated pair', () => {
    const talk = every(42, 43.5, 0.5, (t) => ({
        t,
        faces: [{ cx: 0.28 + (t - 42) * 0.01, cy: 0.36, w: 0.1 }, { cx: 0.74, cy: 0.48, w: 0.09 }],
        people: [{ cx: 0.27, cy: 0.26, w: 0.45 }, { cx: 0.67, cy: 0.35, w: 0.32 }],
        panels: [],
    }));
    const table = every(44, 47, 0.5, (t) => ({
        t,
        faces: t === 44.5 ? [face(0.22, 0.24, 0.11), face(0.88, 0.21, 0.22)] : [],
        people: [{ cx: 0.18, cy: 0.07, w: 0.36 }, { cx: 0.88, cy: 0.04, w: 0.25 }],
        panels: [],
        motion: t === 44 ? 62 : 5,
    }));
    const laid = applyFocusLayout([{ a: 40, b: 50, mode: 'focus', cx: 0.5 }], [...talk, ...table]);
    const splits = laid.windows.filter((w) => w.mode === 'split');
    assert.equal(splits.length, 2, JSON.stringify(splits));
    assert.equal(splits[0].why, 'detector: 2 người');
    assert.ok(splits[0].b <= 43.7, splits[0].b);
    assert.equal(splits[1].why, 'detector: hai tay');
    assert.ok(splits[1].a >= 43.9, splits[1].a);
    assert.ok(Math.abs(splits[1].cx - 0.18) < 0.04, splits[1].cx);
    assert.ok(Math.abs(splits[0].cx2 - splits[1].cx2) > 0.1, `${splits[0].cx2} ${splits[1].cx2}`);
});

test('a two-face split keeps one sample just under the 0.35 gap', () => {
    const pair = (t, left, right, extra = {}) => ({
        t,
        faces: [{ cx: left, cy: 0.35, w: 0.1 }, { cx: right, cy: 0.35, w: 0.09 }],
        people: [],
        panels: [],
        ...extra,
    });
    const held = [
        pair(19.5, 0.494, 0.926),
        pair(20.0, 0.492, 0.965),
        pair(21.0, 0.420, 0.798),
        pair(21.5, 0.369, 0.719),
        pair(22.0, 0.357, 0.706),
        { t: 22.5, faces: [], people: [{ cx: 0.5, cy: 0.32, w: 0.99 }], panels: [], motion: 67 },
    ];
    const splits = twoPersonSplits(held);
    assert.equal(splits.length, 1, JSON.stringify(splits));
    assert.ok(splits[0].b > 22.3 && splits[0].b < 22.42, splits[0].b);
    assert.ok(splits[0].cx < 0.5 && splits[0].cx2 > 0.7, `${splits[0].cx} ${splits[0].cx2}`);
    const desk = every(0, 2, 0.5, (t) => pair(t, 0.355, 0.698));
    const deskSplit = twoPersonSplits(desk);
    assert.equal(deskSplit.length, 1, JSON.stringify(deskSplit));
    assert.ok(deskSplit[0].a <= 0.1 && deskSplit[0].b >= 1.9, `${deskSplit[0].a}-${deskSplit[0].b}`);
    const lean = every(0, 2, 0.5, (t) => pair(t, 0.40, 0.685));
    assert.equal(twoPersonSplits(lean).length, 0);
    const dipped = [
        pair(10.0, 0.341, 0.650),
        pair(10.5, 0.343, 0.639),
        pair(11.0, 0.344, 0.641),
        pair(11.5, 0.346, 0.643),
        pair(12.0, 0.342, 0.649),
        pair(12.5, 0.390, 0.674),
    ];
    const dipSplit = twoPersonSplits(dipped);
    assert.equal(dipSplit.length, 1, JSON.stringify(dipSplit));
    assert.ok(dipSplit[0].b >= 11.9 && dipSplit[0].b < 12.2, dipSplit[0].b);
    const judges = every(31, 33, 0.5, (t) => ({
        t,
        faces: [face(0.2, 0.4, 0.08), face(0.5, 0.4, 0.08), face(0.8, 0.4, 0.08)],
        people: [],
        panels: [],
    }));
    assert.equal(twoPersonSplits(judges).length, 0);
    const scoreboard = every(52, 54, 0.5, (t) => ({
        t,
        faces: [face(0.2, 0.4, 0.09), face(0.4, 0.4, 0.02), face(0.55, 0.4, 0.02), face(0.72, 0.4, 0.09)],
        people: [],
        panels: [],
    }));
    assert.equal(twoPersonSplits(scoreboard).length, 0);
    const bodies = [
        ...every(10, 12, 0.5, (t) => ({
            t,
            faces: [],
            people: [{ cx: 0.2, cy: 0.4, w: 0.3 }, { cx: 0.7, cy: 0.4, w: 0.3 }],
            panels: [],
        })),
        {
            t: 12.5,
            faces: [],
            people: [{ cx: 0.2, cy: 0.4, w: 0.3 }, { cx: 0.549, cy: 0.4, w: 0.3 }],
            panels: [],
        },
    ];
    const bodySplit = twoPersonSplits(bodies);
    assert.equal(bodySplit.length, 1, JSON.stringify(bodySplit));
    assert.ok(bodySplit[0].b <= 12.1, bodySplit[0].b);
    const whip = [
        ...every(0, 1, 0.5, (t) => pair(t, 0.34, 0.66)),
        { t: 1.5, faces: [], people: [], panels: [], motion: 99 },
        pair(2.0, 0.36, 0.67),
        pair(2.5, 0.36, 0.67),
    ];
    const whipSplit = twoPersonSplits(whip);
    assert.equal(whipSplit.length, 1, JSON.stringify(whipSplit));
    assert.ok(whipSplit[0].b > 1.3 && whipSplit[0].b < 1.45, whipSplit[0].b);
    const missed = [
        pair(0, 0.34, 0.70),
        { t: 0.5, faces: [face(0.35, 0.35, 0.1)], people: [], panels: [], motion: 12 },
        pair(1.0, 0.34, 0.70),
    ];
    const missedSplit = twoPersonSplits(missed);
    assert.equal(missedSplit.length, 1, JSON.stringify(missedSplit));
    assert.ok(missedSplit[0].b >= 0.95, missedSplit[0].b);
});

test('two people and two arms keep a look-alike split, a phone does not', () => {
    assert.equal(keepsLookAlikeSplit('detector: 2 người'), true);
    assert.equal(keepsLookAlikeSplit('detector: hai tay'), true);
    assert.equal(keepsLookAlikeSplit('detector: hai vật tròn'), true);
    assert.equal(keepsLookAlikeSplit('detector: hai phía'), false);
    assert.equal(keepsLookAlikeSplit('detector: điện thoại và người'), false);
    assert.equal(keepsLookAlikeSplit('model'), false);
});

test('no scan leaves the plan windows untouched', () => {
    const windows = [{ a: 0, b: 10, mode: 'split', cx: 0.15, cx2: 0.7, why: 'model' }];
    const laid = applyFocusLayout(windows, []);
    assert.equal(laid.windows.length, 1);
    assert.equal(laid.windows[0].mode, 'split');
    assert.equal(laid.windows[0].cx, 0.15);
    assert.equal(laid.aims.length, 0);
});
