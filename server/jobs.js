import { killProcessTree, planChildKill } from './process.js';

// Shared in-memory job registry and SSE lifecycle helpers.
export const jobs = new Map();

export function subscribeJob(job, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (job.streamState) {
    const state = job.streamState;
    for (const chunk of state.history) res.write(chunk);
    if (state.finished) res.end();
    else { state.clients.add(res); res.on('close', () => state.clients.delete(res)); }
    return null;
  }
  const state = job.streamState = { clients: new Set([res]), history: [], finished: false };
  job.status = 'running';
  res.on('close', () => state.clients.delete(res));
  return (type, data = {}) => {
    if (state.finished) return;
    const chunk = 'data: ' + JSON.stringify({ type, ...data }) + '\n\n';
    state.history.push(chunk);
    if (state.history.length > 2000) state.history.shift();
    for (const client of state.clients) if (!client.destroyed && !client.writableEnded) client.write(chunk);
    if (type === 'done' || type === 'error') {
      state.finished = true;
      job.status = type === 'done' ? 'done' : 'error';
      for (const client of state.clients) client.end();
      state.clients.clear();
    }
  };
}

export function ensureAbort(job) {
  if (!job) return null;
  if (!job.abortCtl) job.abortCtl = new AbortController();
  return job.abortCtl;
}

export function jobSignal(job, timeoutMs) {
  const signals = [];
  if (job) {
    const ctl = ensureAbort(job);
    if (job.cancelled) { try { ctl.abort(); } catch {} }
    signals.push(ctl.signal);
  }
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  return signals[0];
}

export function abortJob(job) {
  if (!job) return;
  job.cancelled = true;
  try { ensureAbort(job).abort(); } catch {}
  const plan = planChildKill(job);
  if (plan.mode === 'tree') killProcessTree(plan.pid);
  else if (plan.mode === 'signal') {
    try { job.ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
  }
}
