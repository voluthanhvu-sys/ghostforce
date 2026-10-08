const FFMPEG_ERROR_PATTERN = /\b(?:error|invalid|unable|failed|expression|parse|parsing|undefined|no such|option|cannot|could not)\b/i;
const FFMPEG_BANNER_PATTERN = /^(?:libavutil|libavcodec|libavformat|libavdevice|libavfilter|libswscale|libswresample)\b/i;

export const firstMeaningfulFfmpegError = (stderr) => {
    const lines = String(stderr || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const diagnosticLines = lines.filter((line) => !FFMPEG_BANNER_PATTERN.test(line));
    return diagnosticLines.find((line) => FFMPEG_ERROR_PATTERN.test(line))
        || diagnosticLines.at(-1)
        || 'ffmpeg failed without stderr output';
};
