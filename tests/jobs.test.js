import test from 'node:test';
import assert from 'node:assert/strict';
import { jobs, jobSignal, abortJob } from '../server/jobs.js';
import { planChildKill, planUniquePause, runProcess, setProcessSuspended } from '../server/process.js';

test('jobSignal returns an abortable signal', () => {
  const job = {};
  const signal = jobSignal(job, 1000);
  assert.equal(signal.aborted, false);
  abortJob(job);
  assert.equal(job.cancelled, true);
  assert.equal(job.abortCtl.signal.aborted, true);
});

test('shared job registry is a Map', () => {
  jobs.clear(); jobs.set('x', { status: 'queued' });
  assert.equal(jobs.get('x').status, 'queued'); jobs.clear();
});

test('planChildKill chooses none, signal, or tree without killing a process', () => {
  assert.deepEqual(planChildKill({}), { mode: 'none' });
  assert.deepEqual(planChildKill({ ffmpeg: { pid: 42 } }), { mode: 'signal', pid: 42 });
  assert.deepEqual(planChildKill({ ffmpeg: { pid: 42 }, killTree: true }), { mode: 'tree', pid: 42 });
});

test('planUniquePause only marks a Unique job and does not suspend anything', async () => {
  assert.deepEqual(planUniquePause({ ffmpeg: { pid: 42 } }, true), { action: 'reject' });
  assert.deepEqual(planUniquePause({ uniqueRun: true }, true), { action: 'mark' });
  assert.deepEqual(planUniquePause({ uniqueRun: true, ffmpeg: { pid: 42 } }, true), { action: 'suspend', pid: 42 });
  assert.deepEqual(planUniquePause({ uniqueRun: true, ffmpeg: { pid: 42 } }, false), { action: 'resume', pid: 42 });
  assert.deepEqual(planUniquePause({ uniqueRun: true }, false), { action: 'clear' });
  const idle = await setProcessSuspended(0, true);
  assert.equal(idle.ok, false);
  const missing = await setProcessSuspended(424242, false);
  assert.deepEqual(missing, { ok: true, already: true });
});

test('runProcess streams stdout through hooks and still returns the buffer', async () => {
  const chunks = [];
  let spawned = false;
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ab"); process.stdout.write("c\\n")'], { windowsHide: true }, {
    onSpawn() { spawned = true; },
    onStdout(text) { chunks.push(text); },
  });
  assert.equal(spawned, true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'abc\n');
  assert.equal(chunks.join(''), 'abc\n');
});
