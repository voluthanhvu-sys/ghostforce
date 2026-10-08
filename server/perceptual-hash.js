// Perceptual (dHash) helpers for the Unique pipeline.
// Pure functions only: no filesystem, FFmpeg or job access.
//
// A dHash is a 64-bit fingerprint of a 9x8 grayscale frame: each bit compares one
// pixel with its right neighbour. It is a cheap *estimate* of how visually far the
// Unique output moved from the source. It is not a platform dedup verdict and it is
// not a substitute for CLIP similarity.

// A live 640x360 Unique pass with only Ken Burns (~1.06x) and the colour grade moved
// just 1 of 64 bits, so the classic 9x8 grid was too coarse to be a useful signal.
// 17x16 keeps the dHash "one extra column" shape at 256 bits.
export const DHASH_W = 17;
export const DHASH_H = 16;
export const DHASH_BITS = (DHASH_W - 1) * DHASH_H; // 256

const NIBBLE_BITS = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

const byteAt = (gray, index) => {
  const v = Number(gray[index]);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, v));
};

// gray: width*height raw 8-bit luminance bytes in row-major order.
// Returns a left-padded hex string (16 chars for the default 9x8 grid), or null.
export const dHashFromGray = (gray, width = DHASH_W, height = DHASH_H) => {
  if (!gray || typeof gray.length !== 'number') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 1) return null;
  if (gray.length < width * height) return null;
  let bits = '';
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      bits += byteAt(gray, y * width + x) < byteAt(gray, y * width + x + 1) ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hex;
};

// Hex hashes of equal length only; anything else returns null instead of guessing.
export const hammingDistance = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  if (!a.length || a.length !== b.length) return null;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const left = parseInt(a[i], 16);
    const right = parseInt(b[i], 16);
    // Validate before XOR: `NaN ^ n` silently coerces NaN to 0.
    if (Number.isNaN(left) || Number.isNaN(right)) return null;
    distance += NIBBLE_BITS[left ^ right];
  }
  return distance;
};

// Fraction of bits that differ, 0 (identical) .. 1 (inverted).
export const distanceRatio = (a, b) => {
  const distance = hammingDistance(a, b);
  return distance === null ? null : distance / (a.length * 4);
};

// Mean absolute luminance difference of two same-size gray frames, 0..1.
// dHash only sees structure, so a grade/zoom change can leave it almost flat; this
// catches the "the picture did change" part without claiming more than it measures.
export const meanAbsDifference = (a, b, width = DHASH_W, height = DHASH_H) => {
  if (!a || !b || typeof a.length !== 'number' || typeof b.length !== 'number') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const pixels = width * height;
  if (a.length < pixels || b.length < pixels) return null;
  let sum = 0;
  for (let i = 0; i < pixels; i++) sum += Math.abs(byteAt(a, i) - byteAt(b, i));
  return sum / pixels / 255;
};

// Matched source/output sample points. The Unique encode retimes by `speed`
// (output_time = source_time / speed), so the same content sits at a different
// timestamp on each side.
export const samplePairTimes = (outputDuration, speed = 1, count = 3) => {
  const duration = Number(outputDuration);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const n = Math.max(1, Math.min(12, Math.round(Number(count)) || 3));
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const frac = n === 1 ? 0.5 : 0.12 + (0.76 * i) / (n - 1);
    const outputT = Math.max(0, duration * frac);
    pairs.push({ outputT, sourceT: Math.max(0, outputT * rate) });
  }
  return pairs;
};

export const summarizeDistances = (ratios) => {
  const values = (ratios || []).filter((r) => Number.isFinite(r));
  if (!values.length) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { frames: values.length, mean, worst: Math.max(...values), best: Math.min(...values) };
};

// ---------------------------------------------------------------------------
// DCT pHash - the classic perceptual hash, beside the dHash above.
//
// dHash compares each pixel with the one to its right, so a uniform zoom or pan
// flips nearly every bit and the 256-bit number saturates (measured: 38-40% for
// both `strong` and `extreme`, i.e. the knob stopped being readable). pHash keeps
// only the low frequencies, so it still moves for a real layout/grade change and
// stays calm for grain. The two disagreeing is itself the useful signal: dHash
// says "pixels moved", pHash says "the picture at a glance is (not) the same".
// ---------------------------------------------------------------------------
export const PHASH_SIZE = 8; // 8x8 low-frequency block
export const PHASH_SAMPLE = 32; // DCT input grid
// DC is dropped: it is overall brightness, already covered by the luma delta.
export const PHASH_BITS = PHASH_SIZE * PHASH_SIZE - 1; // 63
// Raw frame size the caller should grab for this analysis. The DCT only needs
// 32x32, but the 4x4 grid below wants enough pixels per cell (16x16) to have a
// meaningful dHash of its own.
export const ANALYSIS_SIZE = 64;

// gray: width*height raw 8-bit luminance bytes in row-major order.
// Returns a 16-char hex string (63 bits left-aligned), or null when unusable.
export const pHashFromGray = (gray, width, height, size = PHASH_SIZE) => {
  if (!gray || typeof gray.length !== 'number') return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) return null;
  if (gray.length < width * height) return null;
  if (!Number.isInteger(size) || size < 2 || size > PHASH_SAMPLE) return null;

  const s = PHASH_SAMPLE;
  // Box-downsample to 32x32 first: the DCT is only ever asked for 8x8 coefficients,
  // and averaging is what makes pHash ignore sensor grain.
  const small = new Float64Array(s * s);
  for (let y = 0; y < s; y++) {
    const y0 = Math.min(height - 1, Math.floor((y * height) / s));
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / s));
    for (let x = 0; x < s; x++) {
      const x0 = Math.min(width - 1, Math.floor((x * width) / s));
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / s));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) {
          sum += byteAt(gray, row + xx);
          n++;
        }
      }
      small[y * s + x] = n ? sum / n : 0;
    }
  }

  // cos[u * s + i] = cos((2i + 1) * u * pi / 2s), shared by both DCT axes.
  const cos = new Float64Array(s * s);
  for (let u = 0; u < s; u++) {
    for (let i = 0; i < s; i++) cos[u * s + i] = Math.cos(((2 * i + 1) * u * Math.PI) / (2 * s));
  }

  const coeffs = new Float64Array(size * size);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      let sum = 0;
      for (let y = 0; y < s; y++) {
        const cv = cos[v * s + y];
        const row = y * s;
        for (let x = 0; x < s; x++) sum += small[row + x] * cos[u * s + x] * cv;
      }
      coeffs[v * size + u] = sum;
    }
  }

  // Threshold: the median of the AC coefficients, floored by a fraction of their
  // RMS.
  //
  // The classic `coeff > median` alone is not stable enough here. On a smooth or
  // flat frame the whole high-frequency band sits at the floating-point noise
  // floor, so the median itself is ~0 and every bit is decided by rounding: the
  // same frame hashed twice produced ~20 of 63 flipped bits, a brightness offset
  // (which mathematically only touches DC) read as a 43% change, and 3/255 of
  // grain read as 44% - the metric was reporting float noise, not structure.
  //
  // A spectrum-relative floor fixes both cases. Real coefficients on 0..255 input
  // run to 1e3-1e6 and the ramp in the tests is unaffected; grain-sized
  // coefficients (~sqrt(n) * amplitude) fall under the floor and become a
  // deterministic 0.
  let sumSquares = 0;
  let maxAbs = 0;
  const values = new Float64Array(coeffs.length - 1);
  for (let i = 1; i < coeffs.length; i++) {
    const value = coeffs[i];
    sumSquares += value * value;
    const magnitude = Math.abs(value);
    if (magnitude > maxAbs) maxAbs = magnitude;
    values[i - 1] = value;
  }
  values.sort(); // TypedArray sort is numeric, unlike Array#sort
  const mid = values.length >> 1;
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const rms = Math.sqrt(sumSquares / values.length);
  const floatFloor = 1e-9 * maxAbs + 1e-9;
  const threshold = Math.max(median, 0.25 * rms, floatFloor);

  let bits = '';
  for (let i = 1; i < coeffs.length; i++) bits += coeffs[i] > threshold ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hex;
};

// Same contract as distanceRatio, but the denominator is PHASH_BITS (63, DC
// excluded) rather than the hex length times four.
export const pHashDistanceRatio = (a, b) => {
  const distance = hammingDistance(a, b);
  if (distance === null) return null;
  return Math.min(1, distance / PHASH_BITS);
};

// ---------------------------------------------------------------------------
// Block-wise dHash: one dHash per cell of a cols x rows grid.
//
// The whole-frame number is a single average, so it cannot say *where* the two
// frames disagree. The grid can: a zoom or a reframe moves most cells, while a
// local artefact (a seam, a caption that only one side has) moves a few. The
// worst cell is the reading that does not saturate the way the global mean does.
// ---------------------------------------------------------------------------
export const GRID_COLS = 4;
export const GRID_ROWS = 4;

// Returns one distance ratio per cell (row-major, skipped cells omitted). The
// caller summarizes; a cell smaller than 2x1 has no adjacent pixel to compare
// and is skipped instead of guessed.
export const gridDHashRatios = (srcGray, outGray, width, height, cols = GRID_COLS, rows = GRID_ROWS) => {
  if (!srcGray || !outGray) return [];
  if (typeof srcGray.length !== 'number' || typeof outGray.length !== 'number') return [];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) return [];
  if (srcGray.length < width * height || outGray.length < width * height) return [];
  const c = Math.max(1, Math.min(16, Math.round(Number(cols)) || GRID_COLS));
  const r = Math.max(1, Math.min(16, Math.round(Number(rows)) || GRID_ROWS));
  const ratios = [];
  for (let ry = 0; ry < r; ry++) {
    const y0 = Math.min(height - 1, Math.floor((ry * height) / r));
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / r));
    for (let rx = 0; rx < c; rx++) {
      const x0 = Math.min(width - 1, Math.floor((rx * width) / c));
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / c));
      const cw = x1 - x0;
      const ch = y1 - y0;
      if (cw < 2 || ch < 1) continue;
      const a = new Uint8Array(cw * ch);
      const b = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        const srcRow = (y0 + y) * width + x0;
        for (let x = 0; x < cw; x++) {
          a[y * cw + x] = byteAt(srcGray, srcRow + x);
          b[y * cw + x] = byteAt(outGray, srcRow + x);
        }
      }
      const ratio = distanceRatio(dHashFromGray(a, cw, ch), dHashFromGray(b, cw, ch));
      if (ratio !== null) ratios.push(ratio);
    }
  }
  return ratios;
};

// ---------------------------------------------------------------------------
// Row-step profile - the quality guard, kept beside the hashes on purpose.
//
// Every difficulty in this project came from the same shape of failure: a layered
// or zoomed frame can introduce a hard horizontal seam (a picture-layer edge, a
// misplaced bar blend), and the hashes do not care. They average the whole frame,
// so they can read HIGHER while the picture gets WORSE - measured on a real
// regression: the broken render reported dHash 39.7 / pHash 28.0 while a clean
// one with the same gain reported 40.0 / 27.5. A number going up is not evidence
// that the picture is usable, so the panel needs a check that looks at the frame
// instead of at its average.
//
// The measurement is the largest single-row brightness jump, and where it sits.
// RAW single-row steps, deliberately: a smoothed (N-row) step inflates under zoom,
// because the window then covers fewer source rows. On a real clip that artefact
// read a clean output as a 78-unit edge when the source's own edge was 53. Raw
// steps stay comparable across a uniform scale, which is what this needs.
//
// Limits, stated rather than discovered later: columns are averaged, so a seam
// covering only part of the width is diluted; and the caller must compare the
// output against the INPUT to the same job, because a seam the source already had
// is not something this pipeline introduced.
// ---------------------------------------------------------------------------
export const ROWSTEP_W = 16;
export const ROWSTEP_H = 960;
// A single-row luma jump this large reads as a line to the eye. Calibrated on the
// project's own clips: the source's picture-layer edge measures 53, a clean pass
// leaves it at 32-37, a broken render pushed it to 73.
export const SEAM_VISIBLE_STEP = 25;
// A seam is a DISCONTINUITY, not merely a strong edge: one row that jumps far more
// than the rows beside it. A steep but continuous edge is common in real footage -
// measured on a selfie clip, the top of the frame ramps 10/13/11 luma per row for
// three rows running, which a raw threshold flags as a seam. Requiring the step to
// be this many times its neighbours' largest step separates the two.
export const SEAM_SPIKE_MIN = 3;

// gray: width*height raw 8-bit luminance bytes, row-major.
// Returns { worst, worstRow, worstRowPct, rms } or null.
export const rowStepProfile = (gray, width = ROWSTEP_W, height = ROWSTEP_H) => {
  if (!gray || typeof gray.length !== 'number') return null;
  if (!Number.isInteger(width) || width < 1) return null;
  if (!Number.isInteger(height) || height < 2) return null;
  if (gray.length < width * height) return null;

  const rows = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += byteAt(gray, y * width + x);
    rows[y] = sum / width;
  }

  const steps = new Float64Array(height);
  let worst = 0;
  let worstRow = 0;
  let sumSquares = 0;
  for (let y = 1; y < height; y++) {
    const step = rows[y] - rows[y - 1];
    steps[y] = step;
    sumSquares += step * step;
    if (Math.abs(step) > Math.abs(worst)) {
      worst = step;
      worstRow = y;
    }
  }

  // Spike ratio: how much this row's jump stands out from the rows beside it.
  let spike = 0;
  let spikeRow = worstRow;
  let spikeStep = worst;
  for (let y = 1; y < height; y++) {
    const magnitude = Math.abs(steps[y]);
    if (magnitude < SEAM_VISIBLE_STEP) continue;
    let neighbour = 0;
    for (let d = -2; d <= 2; d++) {
      if (d === 0) continue;
      const n = y + d;
      if (n < 1 || n >= height) continue;
      if (Math.abs(steps[n]) > neighbour) neighbour = Math.abs(steps[n]);
    }
    const ratio = magnitude / (neighbour + 1);
    if (ratio > spike) {
      spike = ratio;
      spikeRow = y;
      spikeStep = steps[y];
    }
  }

  return {
    worst: Number(worst.toFixed(1)),
    worstRow,
    worstRowPct: Number(((worstRow / height) * 100).toFixed(1)),
    rms: Number(Math.sqrt(sumSquares / (height - 1)).toFixed(2)),
    spike: Number(spike.toFixed(1)),
    spikeRow,
    spikeRowPct: Number(((spikeRow / height) * 100).toFixed(1)),
    spikeStep: Number(spikeStep.toFixed(1)),
    // Visible seam = big step AND isolated from its neighbours.
    visible: Math.abs(spikeStep) >= SEAM_VISIBLE_STEP && spike >= SEAM_SPIKE_MIN,
  };
};

// Verdict for the quality guard. Pure and tested here rather than inline in the
// panel, because this is the rule that decides whether the operator is told the
// render is broken - the single part of the guard most worth a test.
//   'none'   - no seam on either side (or the output came out cleaner than the input)
//   'source' - the input already had a seam, so the pipeline is not to blame
//   'added'  - the output has a seam the input did not; the pipeline made it
export const SEAM_VERDICT = { NONE: 'none', SOURCE: 'source', ADDED: 'added' };
export const seamVerdict = (inSeam, outSeam) => {
  if (!Number.isFinite(outSeam)) return SEAM_VERDICT.NONE;
  return Number.isFinite(inSeam) ? SEAM_VERDICT.SOURCE : SEAM_VERDICT.ADDED;
};
