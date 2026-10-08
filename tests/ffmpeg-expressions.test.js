import test from 'node:test';
import assert from 'node:assert/strict';
import { balancedSum, commandLineLength, fitCropBox, focusFrameGraph, holdSnapExpr, holdSnapScript, splitHalvesOverlap, enableExpr, WINDOWS_COMMAND_BUDGET, zoomCropBox } from '../server/ffmpeg-expressions.js';

const maxParenthesisDepth = (value) => {
    let depth = 0;
    let maximum = 0;
    for (const character of value) {
        if (character === '(') maximum = Math.max(maximum, ++depth);
        if (character === ')') depth -= 1;
    }
    return maximum;
};

test('balancedSum preserves one term and combines two terms', () => {
    assert.equal(balancedSum([]), '0');
    assert.equal(balancedSum(['a']), 'a');
    assert.equal(balancedSum(['a', 'b']), '(a+b)');
});

test('balancedSum forms deterministic balanced groups', () => {
    assert.equal(balancedSum(['a', 'b', 'c', 'd']), '((a+b)+(c+d))');
    assert.equal(balancedSum(['a', 'b', 'c', 'd', 'e']), '((a+b)+(c+(d+e)))');
});

test('a long crop graph is rewritten as a sendcmd file the command line can hold', () => {
    const points = Array.from({ length: 670 }, (_, index) => ({
        t: index / 5,
        cx: 0.35 + (index % 20) * 0.01,
        cy: 0.42,
        who: 'host',
    }));
    const windows = [{ a: 0, b: 134, mode: 'focus', cx: 0.5, cy: 0.42 }];
    const inline = focusFrameGraph({ srcW: 1920, srcH: 1080, windows, mainPts: points, secPts: [] });
    const prefix = ['-y', '-i', 'clip.mp4', '-filter_complex', inline.filter, '-map', '[v]'];
    assert.ok(commandLineLength(prefix) > WINDOWS_COMMAND_BUDGET);
    assert.ok(commandLineLength(prefix) > 32767);
    const filed = focusFrameGraph({
        srcW: 1920, srcH: 1080, windows, mainPts: points, secPts: [], sendcmdFile: 'gf-sc.cmd',
    });
    assert.match(filed.filter, /sendcmd=f=gf-sc\.cmd,crop@main=/);
    assert.equal(filed.filter.includes('gte(t'), false);
    assert.ok(commandLineLength(['-filter_complex', filed.filter]) < WINDOWS_COMMAND_BUDGET);
    assert.match(filed.script, /^0\.000 crop@main x \d+, crop@main y \d+;/);
    assert.match(filed.script, /\n133\.800 crop@main x \d+, crop@main y \d+;\n$/);
    const jump = holdSnapScript([
        { t: 0, cx: 0.2, cy: 0.42, who: 'a' },
        { t: 1, cx: 0.8, cy: 0.42, who: 'a' },
    ], 1920, 1080, 608, 1080);
    assert.equal(jump.includes('\n0.500 '), false);
    const pan = holdSnapScript([
        { t: 0, cx: 0.40, cy: 0.42, who: 'a' },
        { t: 1, cx: 0.46, cy: 0.42, who: 'a' },
    ], 1920, 1080, 608, 1080);
    assert.match(pan, /\n0\.500 crop@main x /);
});

test('balancedSum keeps large expression depth far below FFmpeg limit', () => {
    const expression = balancedSum(Array.from({ length: 128 }, (_, index) => `term${index}`));
    assert.equal((expression.match(/term\d+/g) || []).length, 128);
    assert.ok(maxParenthesisDepth(expression) <= 7);
});

test('fitCropBox keeps the requested aspect inside the source', () => {
    assert.deepEqual(fitCropBox(1920, 1080, 9 / 16), { w: 608, h: 1080 });
    assert.deepEqual(fitCropBox(1080, 1920, 9 / 16), { w: 1080, h: 1920 });
    assert.deepEqual(fitCropBox(1080, 1080, 9 / 16), { w: 608, h: 1080 });
    // A source narrower than 9:16 crops the height instead of the width.
    assert.deepEqual(fitCropBox(640, 1600, 9 / 16), { w: 640, h: 1138 });
    for (const box of [fitCropBox(1920, 1080, 9 / 16), fitCropBox(640, 1600, 9 / 16)]) {
        assert.equal(box.w % 2, 0);
        assert.equal(box.h % 2, 0);
    }
});

test('splitHalvesOverlap uses the real split box, not the retired inset', () => {
    const far = splitHalvesOverlap(1920, 1080, 0.15, 0.70);
    const near = splitHalvesOverlap(1920, 1080, 0.42, 0.55);
    assert.ok(far < 0.35, `far subjects must stay a split, overlap ${far}`);
    assert.ok(near > 0.35, `close subjects must collapse to focus, overlap ${near}`);
});

test('zoomCropBox zooms in on the second event instead of reusing the whole frame', () => {
    assert.deepEqual(zoomCropBox(1920, 1080, 16 / 9, 0.55), { w: 1056, h: 594 });
    // A portrait source cannot be 16:9 wider than itself, so the box fits the width.
    assert.deepEqual(zoomCropBox(1080, 1920, 16 / 9, 0.55), { w: 1080, h: 608 });
    // Never larger than the source.
    assert.deepEqual(zoomCropBox(640, 360, 16 / 9, 0.55), { w: 352, h: 198 });
    assert.deepEqual(zoomCropBox(640, 360, 16 / 9, 1), { w: 640, h: 360 });
});

test('holdSnapExpr cuts on a subject change and pans on a gradual move', () => {
    const cut = holdSnapExpr([
        { t: 0, cx: 0.2, cy: 0.4, who: 'A' },
        { t: 4, cx: 0.8, cy: 0.4, who: 'B' },
    ], 'x', 1920, 1080, 608, 1080);
    // No lerp term for a who-change jump.
    assert.ok(!cut.includes('*(t-0.000)/4.000'));
    assert.ok(cut.startsWith('trunc(('));
    assert.ok(cut.endsWith('/2)*2'));

    const pan = holdSnapExpr([
        { t: 0, cx: 0.40, cy: 0.42, who: 'ball' },
        { t: 3, cx: 0.46, cy: 0.42, who: 'ball' },
    ], 'x', 1920, 1080, 608, 1080);
    assert.ok(pan.includes('*(t-0.000)/3.000'));

    // A renamed label at the same place must not flash the crop.
    const rename = holdSnapExpr([
        { t: 0, cx: 0.40, cy: 0.42, who: 'host' },
        { t: 2, cx: 0.42, cy: 0.42, who: 'Voice A' },
    ], 'x', 1920, 1080, 608, 1080);
    assert.ok(rename.includes('*(t-0.000)/2.000'));

    assert.equal(holdSnapExpr([], 'x', 1920, 1080, 608, 1080), '0');
    assert.equal(holdSnapExpr([{ t: 0, cx: 0.5, cy: 0.5 }], 'x', 1920, 1080, 608, 1080), '656');
});

test('enableExpr joins the windows and stays empty without windows', () => {
    assert.equal(enableExpr([]), '');
    assert.equal(enableExpr([{ a: 3, b: 6 }]), 'between(t\\,3.00\\,6.00)');
    assert.equal(
        enableExpr([{ a: 3, b: 6 }, { a: 10, b: 12 }]),
        'between(t\\,3.00\\,6.00)+between(t\\,10.00\\,12.00)',
    );
    assert.equal(enableExpr([{ a: 5, b: 5 }]), '');
});

test('holdSnapExpr pans slower motion when snapAt is raised (camera 2 follows a moving subject)', () => {
    const moving = [
        { t: 0, cx: 0.30, cy: 0.40, who: 'second 1' },
        { t: 2, cx: 0.48, cy: 0.40, who: 'second 1' },
    ];
    // Main-camera default: an 0.18 cx step is a cut, so there is no lerp term.
    const cut = holdSnapExpr(moving, 'x', 1920, 1080, 608, 1080);
    assert.ok(!cut.includes('*(t-0.000)/2.000'));
    // Second camera: the same step pans, so the expression interpolates.
    const pan = holdSnapExpr(moving, 'x', 1920, 1080, 608, 1080, 0.35);
    assert.ok(pan.includes('*(t-0.000)/2.000'));
    // A large jump still cuts even for camera 2.
    const jump = holdSnapExpr([
        { t: 0, cx: 0.10, cy: 0.40, who: 'second 1' },
        { t: 2, cx: 0.85, cy: 0.40, who: 'second 1' },
    ], 'x', 1920, 1080, 608, 1080, 0.35);
    assert.ok(!jump.includes('*(t-0.000)/2.000'));
});

test('focusFrameGraph uses the second camera snap tolerance on the inset crop', () => {
    const graph = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [{ a: 0, b: 10, mode: 'pip', cx: 0.4, cy: 0.4, cx2: 0.3, cy2: 0.5 }],
        mainPts: [{ t: 0, cx: 0.4, cy: 0.4, who: 'a' }, { t: 9, cx: 0.45, cy: 0.4, who: 'a' }],
        secPts: [
            { t: 0, cx: 0.30, cy: 0.50, who: 'second 1' },
            { t: 2, cx: 0.48, cy: 0.50, who: 'second 1' },
            { t: 9, cx: 0.48, cy: 0.50, who: 'second 1' },
        ],
    });
    // The inset crop carries camera 2's own lerp for the 0-2 s pair.
    const inset = graph.filter.slice(graph.filter.indexOf('[ss]crop='));
    assert.ok(inset.includes('*(t-0.000)/2.000'));
    // The main crop is a separate expression over the main track.
    const main = graph.filter.slice(graph.filter.indexOf('[sm]crop='), graph.filter.indexOf('[ss]crop='));
    assert.ok(main.includes('*(t-0.000)/9.000'));
    assert.ok(!main.includes('*(t-0.000)/2.000'));
});

test('focusFrameGraph draws a 3:4 crop on a blurred 9:16 canvas and only adds the layers it needs', () => {
    const pts = [{ t: 0, cx: 0.4, cy: 0.42, who: 'a' }, { t: 9, cx: 0.5, cy: 0.42, who: 'a' }];
    const plain = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [{ a: 0, b: 10, mode: 'focus' }],
        mainPts: pts,
        secPts: [],
    });
    assert.deepEqual(plain.plan.mainBox, { w: 810, h: 1080 });
    assert.ok(plain.filter.includes(`crop=810:1080:x=${holdSnapExpr(pts, 'x', 1920, 1080, 810, 1080)}`));
    assert.ok(plain.filter.includes('scale=1080:1440:flags=lanczos'));
    assert.ok(plain.filter.includes('gblur=sigma=12,scale=1080:1920'));
    assert.ok(plain.filter.endsWith('overlay=(W-w)/2:(H-h)/2[v]'));
    assert.ok(!plain.filter.includes('vstack'));
    assert.equal(plain.plan.pipWindows, 0);
    assert.equal(plain.plan.splitWindows, 0);
    assert.equal(plain.plan.layers, 1);

    const both = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [
            { a: 0, b: 4, mode: 'focus' },
            { a: 4, b: 8, mode: 'pip', cx: 0.3, cy: 0.4, cx2: 0.8, cy2: 0.6 },
            { a: 8, b: 12, mode: 'split', cx: 0.3, cy: 0.4, cx2: 0.8, cy2: 0.6 },
        ],
        mainPts: [{ t: 0, cx: 0.3, cy: 0.4, who: 'a' }],
        secPts: [{ t: 4, cx: 0.8, cy: 0.6, who: 'second 1' }, { t: 12, cx: 0.8, cy: 0.6, who: 'second 1' }],
    });
    assert.ok(both.filter.includes('vstack=inputs=2'));
    assert.ok(both.filter.includes(`enable='${enableExpr([{ a: 8, b: 12 }])}'`));
    assert.ok(both.filter.includes(`enable='${enableExpr([{ a: 4, b: 8 }])}'`));
    assert.ok(both.filter.includes('drawbox=x=0:y=0:w=iw:h=ih:color=white@0.75:t=4'));
    assert.ok(both.filter.endsWith('[v]'));
    assert.equal(both.plan.pipWindows, 1);
    assert.equal(both.plan.splitWindows, 1);
    assert.equal(both.plan.layers, 3);
    assert.equal(both.plan.pipWidth, 420);
    assert.equal(both.plan.pipHeight, 236);
    // Main subject on the left half, so the inset goes to the right.
    assert.equal(both.plan.pipX, 1080 - 420 - 28);

    // Pip/split without a second-subject track degrade to focus-only.
    const degraded = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [{ a: 0, b: 6, mode: 'pip', cx: 0.5, cy: 0.4, cx2: 0.8, cy2: 0.6 }],
        mainPts: [{ t: 0, cx: 0.5, cy: 0.4, who: 'a' }],
        secPts: [],
    });
    assert.ok(degraded.filter.includes('overlay=(W-w)/2:(H-h)/2[v]'));
    assert.ok(!degraded.filter.includes('enable='));
    assert.equal(degraded.plan.pipWindows, 0);
});

test('a narrow phone panel is fitted in its half and a two-person split stays on the zoom box', () => {
    const graph = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [
            { a: 4, b: 10, mode: 'split', cx: 0.17, cy: 0.5, cx2: 0.64, cy2: 0.42, panelW: 0.24, panelTop: true },
            { a: 118, b: 121, mode: 'split', cx: 0.34, cy: 0.4, cx2: 0.70, cy2: 0.4 },
        ],
        mainPts: [{ t: 4, cx: 0.17, cy: 0.5 }, { t: 118, cx: 0.34, cy: 0.4 }],
        secPts: [
            { t: 4, cx: 0.64, cy: 0.42, who: 'second 1' },
            { t: 118, cx: 0.70, cy: 0.4, who: 'second 2' },
        ],
    });
    assert.ok(graph.filter.includes('[p0a]crop=460:648'));
    assert.ok(graph.filter.includes('pad=1080:960:(ow-iw)/2:(oh-ih)/2:color=black'));
    assert.ok(graph.filter.includes('[p0b]crop=728:648'));
    assert.ok(graph.filter.includes('[st]crop=728:648'));
    assert.ok(graph.filter.includes(`enable='${enableExpr([{ a: 4, b: 10 }])}'`));
    assert.ok(graph.filter.includes(`enable='${enableExpr([{ a: 118, b: 121 }])}'`));
    assert.equal(graph.plan.splitWindows, 2);
    assert.ok(graph.filter.endsWith('[v]'));

    const flipped = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [
            { a: 4, b: 10, mode: 'split', cx: 0.30, cy: 0.42, cx2: 0.78, cy2: 0.5, panelW: 0.24, panelTop: false },
        ],
        mainPts: [{ t: 4, cx: 0.30, cy: 0.42 }],
        secPts: [{ t: 4, cx: 0.78, cy: 0.5, who: 'second 1' }],
    });
    assert.ok(flipped.filter.includes('[p0a]crop=728:648'));
    assert.ok(flipped.filter.includes('[p0b]crop=460:648'));
    assert.ok(!flipped.filter.includes('[st]crop='));
});

test('a phone half does not copy later focus aims into its crop expression', () => {
    const far = [];
    for (let t = 20; t <= 80; t += 4) far.push({ t, cx: 0.33, cy: 0.4 });
    const graph = focusFrameGraph({
        srcW: 1920,
        srcH: 1080,
        windows: [
            { a: 4, b: 10, mode: 'split', cx: 0.17, cy: 0.5, cx2: 0.64, cy2: 0.42, panelW: 0.24, panelTop: true },
        ],
        mainPts: [{ t: 4, cx: 0.17, cy: 0.5 }, { t: 9.8, cx: 0.17, cy: 0.5 }, ...far],
        secPts: [{ t: 4, cx: 0.64, cy: 0.42, who: 'second 1' }, { t: 9.8, cx: 0.64, cy: 0.42, who: 'second 1' }],
    });
    const phone = graph.filter.split(';').find((part) => part.startsWith('[p0a]'));
    const focus = graph.filter.split(';').find((part) => part.startsWith('[sm]'));
    assert.ok(phone && !phone.includes('20.000'), phone);
    assert.ok(focus && focus.includes('20.000'));
});
