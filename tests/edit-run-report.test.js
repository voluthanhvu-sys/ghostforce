import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditRunReport } from '../server/edit-run-report.js';

test('summary records elapsed time, exact quota events and per-part stages once', () => {
    let now = 1000; const lines = [];
    const report = createEditRunReport('job1', 'source.mp4', (s) => lines.push(s), () => now);
    const log = (message) => report.observe('log', { message });
    log('[EDIT] Shared Vertex cooldown set 18s after HTTP 429');
    log('[EDIT] Shared Vertex cooldown — wait 17s…');
    log('[EDIT] Vertex retry 2/3 @ global…');
    log('[EDIT] Detail PLAN 1/6 modes: raw contain=3 fill=2 · parsed contain=3 fill=2');
    report.observe('progress', { phase: 'cut', part: 1 });
    log('[EDIT TIMING] RGB/frame refinement: 12.50s');
    log('[EDIT TIMING] final FFmpeg render: 8.00s');
    log('[EDIT] Mix framing stages: initial contain=3 fill=2');
    now = 380000;
    report.finish('SUCCESS'); report.finish('SUCCESS');
    assert.equal(lines.filter((s) => s.includes('backendTotal=')).length, 1);
    assert.match(lines[0], /backendTotal=379.00s.*HTTP429=1 VertexRetries=1/);
    assert.ok(lines.some((s) => s.includes('Part 1 RGB/frame refinement=12.50s')));
    assert.ok(lines.some((s) => s.includes('Detail 1/6 modes:')));
    assert.ok(lines.some((s) => s.includes('Mix framing stages:')));
});

test('summary reports error/cancellation without requiring any phase timing', () => {
    for (const status of ['ERROR', 'CANCELLED']) {
        const lines = [];
        const report = createEditRunReport('job2', 'source', (s) => lines.push(s), () => 0);
        report.finish(status);
        assert.match(lines[0], new RegExp(`status=${status}`));
        assert.match(lines[1], /none$/);
    }
});
