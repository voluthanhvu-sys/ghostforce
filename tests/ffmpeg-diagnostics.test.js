import test from 'node:test';
import assert from 'node:assert/strict';
import { firstMeaningfulFfmpegError } from '../server/ffmpeg-diagnostics.js';

test('firstMeaningfulFfmpegError returns the earliest useful error line', () => {
    const stderr = [
        'ffmpeg version 7.1',
        'libavfilter    12.  1.101 / 12.  1.101',
        'frame=  42 fps=30 time=00:00:01.40 speed=1x',
        'Error when evaluating expression x',
        'Failed to configure input pad',
    ].join('\n');
    assert.equal(firstMeaningfulFfmpegError(stderr), 'Error when evaluating expression x');
});

test('firstMeaningfulFfmpegError ignores irrelevant progress lines', () => {
    const stderr = [
        'frame=  42 fps=30 time=00:00:01.40 speed=1x',
        'bitrate=1200.0kbits/s',
        'Invalid argument',
    ].join('\n');
    assert.equal(firstMeaningfulFfmpegError(stderr), 'Invalid argument');
});

test('firstMeaningfulFfmpegError falls back safely without a keyword', () => {
    assert.equal(firstMeaningfulFfmpegError('ffmpeg version 7.1\nconversion stopped'), 'conversion stopped');
    assert.equal(firstMeaningfulFfmpegError(''), 'ffmpeg failed without stderr output');
});
