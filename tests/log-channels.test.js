import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDisplayLog, logChannel } from '../src/lib/log-channels.js';

test('each function tag stays on its own log', () => {
    assert.equal(logChannel('[SYS] Added 4 videos to Unique queue'), 'unique');
    assert.equal(logChannel('[PGD] nóng: dùng model đã nạp'), 'unique');
    assert.equal(logChannel('[Cops Discover] [SYS] Source 1920x1080'), 'unique');
    assert.equal(logChannel('[Cops Discover] [FFMPEG] frame=10'), 'unique');
    assert.equal(logChannel('[EDIT] Start 4 source(s)'), 'edit');
    assert.equal(logChannel('[Hearse] [EDIT] Uploading for Edit'), 'edit');
    assert.equal(logChannel('[EDIT TOTAL] Video 1: 1s · ERROR'), 'edit');
    assert.equal(logChannel('[QA] Chất lượng part: 80/100'), 'edit');
    assert.equal(logChannel('[TOPIC] podcast (95%)'), 'edit');
    assert.equal(logChannel('[REFRAME] Start 1'), 'reframe');
    assert.equal(logChannel('[clip] [REFRAME] Probe source'), 'reframe');
    assert.equal(logChannel('[YT] Đã thêm video vào hàng Edit.'), 'youtube');
});

test('a frame progress line replaces the previous line of the same clip', () => {
    const first = appendDisplayLog(['[a] [FFMPEG] frame=1'], '[a] [FFMPEG] frame=2');
    assert.deepEqual(first, ['[a] [FFMPEG] frame=2']);
    const both = appendDisplayLog(['[a] [FFMPEG] frame=1'], '[b] [FFMPEG] frame=2');
    assert.deepEqual(both, ['[a] [FFMPEG] frame=1', '[b] [FFMPEG] frame=2']);
});

test('one channel keeps its own last 500 lines', () => {
    const seed = Array.from({ length: 500 }, (_, i) => `[SYS] ${i}`);
    const next = appendDisplayLog(seed, '[SYS] 500');
    assert.equal(next.length, 450);
    assert.equal(next[0], '[SYS] 51');
    assert.equal(next.at(-1), '[SYS] 500');
});
