export const balancedSum = (parts) => {
    if (!Array.isArray(parts) || !parts.length) return '0';
    if (parts.length === 1) return String(parts[0]);
    const middle = Math.floor(parts.length / 2);
    return `(${balancedSum(parts.slice(0, middle))}+${balancedSum(parts.slice(middle))})`;
};

// Windows CreateProcess rejects a command line past 32767 characters. FFmpeg 9
// on this machine has no -filter_complex_script, so a too-long focus graph is
// rewritten as a short crop plus a sendcmd file. The aim points stay the same.
export const WINDOWS_COMMAND_BUDGET = 24000;

export const commandLineLength = (args) => (
    Array.isArray(args) ? args.reduce((sum, arg) => sum + String(arg ?? '').length + 1, 0) : 0
);

// --- focus path: picture checks on one decoded frame (pure) -------------------

// How alike two rectangles of one frame look (1 = identical), on a luma grid.
// Used to drop a corner window that just repeats the main crop.
export const frameRegionSimilarity = (rgb, gw, gh, rectA, rectB, bins = 16) => {
    const sample = (rect) => {
        const out = new Float64Array(bins * bins);
        const counts = new Float64Array(bins * bins);
        const x0 = Math.max(0, Math.min(gw - 1, Math.floor(rect.x0 * gw)));
        const x1 = Math.max(x0 + 1, Math.min(gw, Math.ceil(rect.x1 * gw)));
        const y0 = Math.max(0, Math.min(gh - 1, Math.floor(rect.y0 * gh)));
        const y1 = Math.max(y0 + 1, Math.min(gh, Math.ceil(rect.y1 * gh)));
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const i = (y * gw + x) * 3;
                const luma = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
                const bx = Math.min(bins - 1, Math.floor(((x - x0) / (x1 - x0)) * bins));
                const by = Math.min(bins - 1, Math.floor(((y - y0) / (y1 - y0)) * bins));
                out[by * bins + bx] += luma;
                counts[by * bins + bx] += 1;
            }
        }
        for (let k = 0; k < out.length; k++) out[k] = counts[k] ? out[k] / counts[k] : 0;
        return out;
    };
    const a = sample(rectA);
    const b = sample(rectB);
    let diff = 0;
    for (let k = 0; k < a.length; k++) diff += Math.abs(a[k] - b[k]);
    return 1 - (diff / a.length) / 255;
};

// Where the most detailed spot inside a rectangle is (normalised). Used to aim a
// corner window when the plan gives its x but omits its y: measured on a real
// clip, the default y=0.5 landed on an ad's price tag instead of the host below.
export const frameRegionPeak = (rgb, gw, gh, rect, bins = 24) => {
    const x0 = Math.max(0, Math.min(gw - 1, Math.floor(rect.x0 * gw)));
    const x1 = Math.max(x0 + 1, Math.min(gw, Math.ceil(rect.x1 * gw)));
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(rect.y0 * gh)));
    const y1 = Math.max(y0 + 1, Math.min(gh, Math.ceil(rect.y1 * gh)));
    const counts = new Float64Array(bins * bins);
    const sums = new Float64Array(bins * bins);
    const sums2 = new Float64Array(bins * bins);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * gw + x) * 3;
            const luma = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
            const bx = Math.min(bins - 1, Math.floor(((x - x0) / (x1 - x0)) * bins));
            const by = Math.min(bins - 1, Math.floor(((y - y0) / (y1 - y0)) * bins));
            const k = by * bins + bx;
            counts[k] += 1;
            sums[k] += luma;
            sums2[k] += luma * luma;
        }
    }
    let best = { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2, score: 0 };
    for (let k = 0; k < counts.length; k++) {
        if (counts[k] < 4) continue;
        const mean = sums[k] / counts[k];
        const variance = Math.max(0, sums2[k] / counts[k] - mean * mean);
        if (variance <= best.score) continue;
        best = {
            x: rect.x0 + ((k % bins) + 0.5) / bins * (rect.x1 - rect.x0),
            y: rect.y0 + (Math.floor(k / bins) + 0.5) / bins * (rect.y1 - rect.y0),
            score: variance,
        };
    }
    return best;
};

// NOTE: everything below builds the "focus" 9:16 composition for the Edit
// general-content path (server/editor-plan.js focus/pip/split windows). It is
// pure string maths: no fs, no ffmpeg, no job state, so it is unit tested.

const evenPxLocal = (n) => {
    const v = Math.round(Number(n) || 0);
    return Math.max(2, v - (v % 2));
};

const clampPx = (value, max) => Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));

// Largest crop box with the requested aspect that still fits inside the source.
export const fitCropBox = (srcW, srcH, aspect) => {
    const width = evenPxLocal(srcW);
    const height = evenPxLocal(srcH);
    const ar = Number(aspect) > 0 ? Number(aspect) : 9 / 16;
    if (width / height > ar) {
        const cropH = height;
        return { w: evenPxLocal(cropH * ar), h: cropH };
    }
    const cropW = width;
    return { w: cropW, h: evenPxLocal(cropW / ar) };
};

// A centred crop box that is deliberately smaller than the source, so a
// secondary "other camera" window reads as a zoom on that event instead of a
// duplicate of the whole frame. `heightFraction` is the share of the source
// height the box may use.
export const zoomCropBox = (srcW, srcH, aspect, heightFraction = 0.55) => {
    const width = evenPxLocal(srcW);
    const height = evenPxLocal(srcH);
    const ar = Number(aspect) > 0 ? Number(aspect) : 16 / 9;
    const fraction = Math.min(1, Math.max(0.1, Number(heightFraction) || 0.55));
    let cropH = Math.min(height, evenPxLocal(height * fraction));
    let cropW = evenPxLocal(cropH * ar);
    if (cropW > width) {
        cropW = width;
        cropH = evenPxLocal(cropW / ar);
    }
    return { w: cropW, h: cropH };
};

// The crop each half of a top/bottom split actually uses. Callers that decide
// "are these two cameras the same picture?" must use this box, not the retired
// corner-window box: a 16:9 inset at 42% height accepts splits the renderer
// then paints as two wide halves of the same people.
export const splitCameraBox = (srcW, srcH, canvas = { w: 1080, h: 1920 }, splitZoom = 0.6) => {
    const halfHeight = evenPxLocal((Number(canvas?.h) || 1920) / 2);
    const aspect = (Number(canvas?.w) || 1080) / Math.max(2, halfHeight);
    return zoomCropBox(srcW, srcH, aspect, splitZoom);
};

// Share of one split half that also sits inside the other half, 0..1.
// Above ~0.35 the two halves show the same subjects.
export const splitHalvesOverlap = (srcW, srcH, cx, cx2, canvas) => {
    const a = Number(cx);
    const b = Number(cx2);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const box = splitCameraBox(srcW, srcH, canvas);
    const half = (box.w / 2) / Math.max(1, srcW);
    const overlap = Math.max(0, Math.min(a, b) + half - (Math.max(a, b) - half));
    return overlap / Math.max(0.001, half * 2);
};

const pixelOf = (point, axis, srcW, srcH, cropW, cropH) => {
    const maxX = Math.max(0, srcW - cropW);
    const maxY = Math.max(0, srcH - cropH);
    const cx = Number.isFinite(Number(point?.cx)) ? Number(point.cx) : 0.5;
    const cy = Number.isFinite(Number(point?.cy)) ? Number(point.cy) : 0.42;
    if (axis === 'x') return clampPx(cx * srcW - cropW / 2, maxX);
    return clampPx(cy * srcH - cropH / 2, maxY);
};

// FFmpeg crop x/y expression over a subject track. A subject change (or a jump
// in cx) holds the old position and cuts; a gradual move pans smoothly. That is
// the "auto theo nội dung" rule: a podcast switches speakers with a cut, a
// sports follow pans with the play.
export const holdSnapExpr = (pts, axis, srcW, srcH, cropW, cropH, snapAt = 0.10) => {
    const list = (Array.isArray(pts) ? pts : [])
        .filter((point) => point && Number.isFinite(Number(point.t)))
        .map((point) => ({ ...point, t: Number(point.t) }))
        .sort((a, b) => a.t - b.t);
    if (!list.length) return '0';
    if (list.length === 1) return String(evenPxLocal(pixelOf(list[0], axis, srcW, srcH, cropW, cropH)));
    const parts = [];
    for (let i = 0; i < list.length - 1; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (b.t - a.t < 0.02) continue;
        const va = pixelOf(a, axis, srcW, srcH, cropW, cropH);
        const vb = pixelOf(b, axis, srcW, srcH, cropW, cropH);
        const dx = Math.abs((Number(a.cx) || 0.5) - (Number(b.cx) || 0.5));
        // A different label at the same place is not a new subject. Speech lines
        // and the plan often disagree on the name while cx stays put, and treating
        // that as a cut flashed the same crop. Cut only when the aim actually moves.
        const whoChange = Boolean(a.who && b.who && a.who !== b.who);
        const jump = dx > snapAt || (whoChange && dx > 0.06);
        if (jump) {
            parts.push(`gte(t\\,${a.t.toFixed(3)})*lt(t\\,${b.t.toFixed(3)})*${va.toFixed(2)}`);
        } else {
            const dt = Math.max(0.001, b.t - a.t);
            parts.push(`gte(t\\,${a.t.toFixed(3)})*lt(t\\,${b.t.toFixed(3)})*(${va.toFixed(2)}+(${(vb - va).toFixed(2)})*`
                + `(t-${a.t.toFixed(3)})/${dt.toFixed(3)})`);
        }
    }
    if (!parts.length) return String(evenPxLocal(pixelOf(list[0], axis, srcW, srcH, cropW, cropH)));
    const last = list[list.length - 1];
    parts.push(`gte(t\\,${last.t.toFixed(3)})*${pixelOf(last, axis, srcW, srcH, cropW, cropH).toFixed(2)}`);
    return `trunc((${balancedSum(parts)})/2)*2`;
};

// Same hold-or-pan rule as holdSnapExpr, written as sendcmd lines. A jump keeps
// the old crop until the next point. A gradual move is sampled often enough
// that the crop steps by about two pixels. The file is not part of the command line.
export const holdSnapScript = (pts, srcW, srcH, cropW, cropH, target = 'crop@main', snapAt = 0.10, step = 1 / 30) => {
    const list = (Array.isArray(pts) ? pts : [])
        .filter((point) => point && Number.isFinite(Number(point.t)))
        .map((point) => ({ ...point, t: Number(point.t) }))
        .sort((a, b) => a.t - b.t);
    const lines = [];
    let lastX = null;
    let lastY = null;
    const emit = (t, cx, cy) => {
        const x = evenPxLocal(pixelOf({ cx, cy }, 'x', srcW, srcH, cropW, cropH));
        const y = evenPxLocal(pixelOf({ cx, cy }, 'y', srcW, srcH, cropW, cropH));
        if (x === lastX && y === lastY) return;
        lastX = x;
        lastY = y;
        lines.push(`${Math.max(0, t).toFixed(3)} ${target} x ${x}, ${target} y ${y};`);
    };
    if (!list.length) {
        emit(0, 0.5, 0.42);
        return `${lines.join('\n')}\n`;
    }
    if (list[0].t > 0.001) emit(0, Number(list[0].cx), Number(list[0].cy));
    for (let i = 0; i < list.length - 1; i++) {
        const a = list[i];
        const b = list[i + 1];
        if (b.t - a.t < 0.02) continue;
        const dx = Math.abs((Number(a.cx) || 0.5) - (Number(b.cx) || 0.5));
        const whoChange = Boolean(a.who && b.who && a.who !== b.who);
        const jump = dx > snapAt || (whoChange && dx > 0.06);
        emit(a.t, Number(a.cx), Number(a.cy));
        if (jump) continue;
        const dt = b.t - a.t;
        for (let t = a.t + step; t < b.t - 0.0005; t += step) {
            const u = (t - a.t) / dt;
            const cy0 = Number.isFinite(Number(a.cy)) ? Number(a.cy) : 0.42;
            const cy1 = Number.isFinite(Number(b.cy)) ? Number(b.cy) : cy0;
            emit(t, Number(a.cx) + (Number(b.cx) - Number(a.cx)) * u, cy0 + (cy1 - cy0) * u);
        }
    }
    const last = list[list.length - 1];
    emit(last.t, Number(last.cx), Number(last.cy));
    return `${lines.join('\n')}\n`;
};

// "enable" option for overlay: '+' joins the windows, so the layer shows in all
// of them and nowhere else.
export const enableExpr = (windows) => {
    const list = (Array.isArray(windows) ? windows : [])
        .filter((w) => Number.isFinite(Number(w?.a)) && Number(w?.b) > Number(w?.a))
        .sort((a, b) => Number(a.a) - Number(b.a));
    if (!list.length) return '';
    return list
        .map((w) => `between(t\\,${Number(w.a).toFixed(2)}\\,${Number(w.b).toFixed(2)})`)
        .join('+');
};

// Full filter_complex for one focus part. The canvas stays 9:16. A focus window
// is the largest 3:4 crop in the source, centred on a blurred copy of the frame,
// so the top and bottom are a soft letterbox. Split and the corner inset still
// cover that canvas while their windows are on. This function does not choose
// focus versus split.
export const focusFrameGraph = ({
    srcW,
    srcH,
    windows,
    mainPts,
    secPts,
    canvas = { w: 1080, h: 1920 },
    pipWidth = 420,
    pipZoom = 0.42,
    // The second camera usually follows something that moves (an animal, a car,
    // a second person), so a bigger step still pans instead of cutting.
    secSnapAt = 0.35,
    // Each half of a top/bottom split must ISOLATE its subject. The old box was
    // the largest crop that fits (measured on a 1920x1080 source: 1215x1080 =
    // 63 % of the frame width), so with the phone at cx 0.15 and the host at 0.65
    // both halves contained both subjects and looked like the same picture twice.
    // A fraction of the source height makes every half a real zoom instead.
    splitZoom = 0.6,
    margin = 28,
    border = 4,
    // Bare file name, no drive colon. FFmpeg 9 reads it when cwd is that folder.
    sendcmdFile = '',
}) => {
    const width = evenPxLocal(canvas?.w || 1080);
    const height = evenPxLocal(canvas?.h || 1920);
    const wins = (Array.isArray(windows) ? windows : []).filter((w) => Number(w?.b) > Number(w?.a));
    const main = (Array.isArray(mainPts) ? mainPts : []).filter((p) => p && Number.isFinite(Number(p.t)));
    const sec = (Array.isArray(secPts) ? secPts : []).filter((p) => p && Number.isFinite(Number(p.t)));

    const mainBox = fitCropBox(srcW, srcH, 3 / 4);
    const focusH = evenPxLocal(width * mainBox.h / mainBox.w);
    const blurW = 270;
    const blurH = evenPxLocal(blurW * height / width);
    const blurChain = `scale=${blurW}:${blurH}:force_original_aspect_ratio=increase,crop=${blurW}:${blurH},gblur=sigma=12,scale=${width}:${height}:flags=bilinear,setsar=1`;
    const commandFile = String(sendcmdFile || '').trim();
    const script = commandFile
        ? holdSnapScript(main, srcW, srcH, mainBox.w, mainBox.h)
        : '';
    const origin = main[0] || { cx: 0.5, cy: 0.42 };
    const mainCrop = commandFile
        ? `sendcmd=f=${commandFile},crop@main=${mainBox.w}:${mainBox.h}`
            + `:x=${evenPxLocal(pixelOf(origin, 'x', srcW, srcH, mainBox.w, mainBox.h))}`
            + `:y=${evenPxLocal(pixelOf(origin, 'y', srcW, srcH, mainBox.w, mainBox.h))}`
            + `,scale=${width}:${focusH}:flags=lanczos,setsar=1`
        : `crop=${mainBox.w}:${mainBox.h}`
            + `:x=${holdSnapExpr(main, 'x', srcW, srcH, mainBox.w, mainBox.h)}`
            + `:y=${holdSnapExpr(main, 'y', srcW, srcH, mainBox.w, mainBox.h)}`
            + `,scale=${width}:${focusH}:flags=lanczos,setsar=1`;

    const splitWins = wins.filter((w) => w.mode === 'split');
    const pipWins = wins.filter((w) => w.mode === 'pip');
    const needSplit = splitWins.length > 0 && sec.length > 0;
    const needPip = pipWins.length > 0 && sec.length > 0;
    const plan = {
        width,
        height,
        mainBox,
        splitBox: null,
        secBox: null,
        pipWidth: null,
        pipHeight: null,
        pipX: null,
        pipY: null,
        focusWindows: wins.filter((w) => w.mode === 'focus').length,
        pipWindows: needPip ? pipWins.length : 0,
        splitWindows: needSplit ? splitWins.length : 0,
        layers: 1,
    };
    if (!needSplit && !needPip) {
        return {
            filter: `[0:v]split=2[fg][bg];[bg]${blurChain}[b];[fg]${mainCrop}[f];[b][f]overlay=(W-w)/2:(H-h)/2[v]`,
            plan,
            script,
        };
    }

    const halfHeight = evenPxLocal(height / 2);
    // A portrait phone is narrower than the shared split zoom. Filling that half
    // used to scale the studio in beside the ad (measured: phone ~0.24 of the
    // frame, zoom box ~0.38). The phone half is cropped to the panel and padded;
    // the person half, and any two-person split, stay on the one zoom box.
    const splitBox = needSplit ? zoomCropBox(srcW, srcH, width / halfHeight, splitZoom) : null;
    const panelCropW = (win) => {
        const pw = Number(win?.panelW);
        if (!(pw >= 0.12 && pw <= 0.45) || !splitBox) return 0;
        const cropW = evenPxLocal(pw * srcW);
        return cropW + 8 < splitBox.w ? cropW : 0;
    };
    const panelWins = needSplit ? splitWins.filter((win) => panelCropW(win) > 0) : [];
    const fillWins = needSplit ? splitWins.filter((win) => panelCropW(win) === 0) : [];
    const labels = ['sm', 'bg'];
    if (fillWins.length) labels.push('st', 'sb');
    panelWins.forEach((_, index) => labels.push(`p${index}a`, `p${index}b`));
    if (needPip) labels.push('ss');
    const parts = [`[0:v]split=${labels.length}${labels.map((label) => `[${label}]`).join('')}`];
    parts.push(`[bg]${blurChain}[b]`);
    parts.push(`[sm]${mainCrop}[f]`);
    parts.push('[b][f]overlay=(W-w)/2:(H-h)/2[focus]');
    let current = 'focus';
    // A split overlay is on screen only inside its own windows. Copying the
    // whole focus track into every half made the filter longer than the Windows
    // command line (74 focus aims x each phone half). The half only needs the
    // points that fall inside it; outside that, the overlay is disabled.
    const pointsDuring = (pts, ranges) => {
        const list = (Array.isArray(pts) ? pts : []).filter((p) => ranges.some((w) => (
            Number(p?.t) >= Number(w.a) - 0.05 && Number(p?.t) <= Number(w.b) + 0.05
        )));
        return list.length ? list : (Array.isArray(pts) ? pts.slice(0, 1) : []);
    };
    const cropOf = (pts, box, snap) => `crop=${box.w}:${box.h}`
        + `:x=${holdSnapExpr(pts, 'x', srcW, srcH, box.w, box.h, snap)}`
        + `:y=${holdSnapExpr(pts, 'y', srcW, srcH, box.w, box.h, snap)}`;
    const fillScale = `,scale=${width}:${halfHeight}:flags=lanczos,setsar=1`;
    const fitScale = `,scale=${width}:${halfHeight}:force_original_aspect_ratio=decrease:flags=lanczos`
        + `,pad=${width}:${halfHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
    const divider = `drawbox=x=0:y=${Math.max(0, halfHeight - 3)}:w=iw:h=6:color=black@0.9:t=fill`;
    let stage = 0;
    const takeOut = () => {
        const more = needPip || stage < (fillWins.length ? 1 : 0) + panelWins.length - 1;
        if (!more) return 'v';
        stage += 1;
        return `stage${stage}`;
    };
    if (fillWins.length) {
        plan.splitBox = splitBox;
        parts.push(`[st]${cropOf(pointsDuring(main, fillWins), splitBox, 0.10)}${fillScale}[top]`);
        parts.push(`[sb]${cropOf(pointsDuring(sec, fillWins), splitBox, secSnapAt)}${fillScale}[bot]`);
        parts.push('[top][bot]vstack=inputs=2[splitStack]');
        // A thin dark divider makes the two stacked cameras read as a deliberate
        // split instead of a broken frame.
        parts.push(`[splitStack]${divider}[splitLayer]`);
        const out = takeOut();
        parts.push(`[${current}][splitLayer]overlay=0:0:enable='${enableExpr(fillWins)}'[${out}]`);
        current = out;
        plan.layers += 1;
    }
    panelWins.forEach((win, index) => {
        const tight = { w: panelCropW(win), h: splitBox.h };
        const topIsPanel = win.panelTop !== false;
        const topPts = pointsDuring(topIsPanel ? main : sec, [win]);
        const botPts = pointsDuring(topIsPanel ? sec : main, [win]);
        const topBox = topIsPanel ? tight : splitBox;
        const botBox = topIsPanel ? splitBox : tight;
        const topSnap = topIsPanel ? 0.10 : secSnapAt;
        const botSnap = topIsPanel ? secSnapAt : 0.10;
        parts.push(`[p${index}a]${cropOf(topPts, topBox, topSnap)}${topIsPanel ? fitScale : fillScale}[p${index}top]`);
        parts.push(`[p${index}b]${cropOf(botPts, botBox, botSnap)}${topIsPanel ? fillScale : fitScale}[p${index}bot]`);
        parts.push(`[p${index}top][p${index}bot]vstack=inputs=2[p${index}stack]`);
        parts.push(`[p${index}stack]${divider}[p${index}layer]`);
        const out = takeOut();
        parts.push(`[${current}][p${index}layer]overlay=0:0:enable='${enableExpr([win])}'[${out}]`);
        current = out;
        plan.layers += 1;
    });
    if (needSplit) plan.splitBox = splitBox;
    if (needPip) {
        const pipW = evenPxLocal(pipWidth);
        const pipH = evenPxLocal(pipWidth * 9 / 16);
        // A tighter box (fraction of the source height) makes whatever sits in
        // the corner window - typically a face camera - actually readable at
        // 420x236 instead of showing half the frame inside the inset.
        const secBox = zoomCropBox(srcW, srcH, 16 / 9, pipZoom);
        const meanCx = main.length
            ? main.reduce((sum, p) => sum + (Number.isFinite(Number(p.cx)) ? Number(p.cx) : 0.5), 0) / main.length
            : 0.5;
        const pipX = meanCx > 0.5 ? margin : width - pipW - margin;
        const pipY = height - pipH - margin;
        plan.secBox = secBox;
        plan.pipWidth = pipW;
        plan.pipHeight = pipH;
        plan.pipX = pipX;
        plan.pipY = pipY;
        parts.push(`[ss]crop=${secBox.w}:${secBox.h}`
            + `:x=${holdSnapExpr(sec, 'x', srcW, srcH, secBox.w, secBox.h, secSnapAt)}`
            + `:y=${holdSnapExpr(sec, 'y', srcW, srcH, secBox.w, secBox.h, secSnapAt)}`
            + `,scale=${pipW}:${pipH}:flags=lanczos,setsar=1`
            + `,drawbox=x=0:y=0:w=iw:h=ih:color=white@0.75:t=${border}[secLayer]`);
        parts.push(`[${current}][secLayer]overlay=${pipX}:${pipY}:enable='${enableExpr(pipWins)}'[v]`);
        current = 'v';
        plan.layers += 1;
    }
    if (current !== 'v') throw new Error('focus graph lost its output label');
    return { filter: parts.join(';'), plan, script };
};
