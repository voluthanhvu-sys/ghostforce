// Picture filter for the post-encode check. A platform re-upload quantizes harder
// than the file Unique just wrote, so the panel also measures a quiet proxy:
// libx264 crf 30, long side at most 720, never upscaled. Even dimensions stay
// even (yuv420). Pure string builder: no ffmpeg, no files.

export const HARSH_LONG_SIDE = 720;
export const HARSH_CRF = '30';

export const harshVideoFilter = (longSide = HARSH_LONG_SIDE) => {
    const side = Math.max(2, Number(longSide) - (Number(longSide) % 2));
    return `scale=w='if(gte(iw,ih),min(${side},iw),-2)':h='if(gte(iw,ih),-2,min(${side},ih))':force_divisible_by=2`;
};
