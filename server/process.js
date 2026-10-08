import { spawn, spawnSync } from 'child_process';

export function runProcess(command, args, options = {}, hooks = {}) {
  const { onSpawn, onStdout, onStderr } = hooks || {};
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, options); }
    catch (error) { resolve({ status: -1, stdout: '', stderr: '', error }); return; }
    try { onSpawn?.(child); } catch { /* a hook must not hide the process result */ }
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on('data', (b) => {
      const text = b.toString();
      stdout += text;
      try { onStdout?.(text); } catch { /* ignore */ }
    });
    child.stderr?.on('data', (b) => {
      const text = b.toString();
      stderr += text;
      try { onStderr?.(text); } catch { /* ignore */ }
    });
    child.on('error', (error) => finish({ status: -1, stdout, stderr, error }));
    child.on('close', (status) => finish({ status, stdout, stderr }));
  });
}

export function planChildKill(job) {
  const pid = job?.ffmpeg?.pid;
  if (!pid) return { mode: 'none' };
  if (job.killTree) return { mode: 'tree', pid };
  return { mode: 'signal', pid };
}

export function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

// Unique pause. `paused` true freezes the current child; false continues it.
// No pid yet means the next Unique child must be frozen when it spawns.
// Edit and Reframe jobs are rejected because they are not uniqueRun.
export function planUniquePause(job, paused) {
  if (!job || job.uniqueRun !== true) return { action: 'reject' };
  const pid = Number(job.ffmpeg?.pid);
  const safePid = Number.isInteger(pid) && pid > 0 ? pid : 0;
  if (paused) return safePid ? { action: 'suspend', pid: safePid } : { action: 'mark' };
  return safePid ? { action: 'resume', pid: safePid } : { action: 'clear' };
}

const suspendedPids = new Set();
const suspendDesired = new Map();
const suspendQueue = new Map();

export function releaseSuspendedPid(pid) {
  const id = Number(pid);
  if (!id) return;
  suspendDesired.delete(id);
  suspendedPids.delete(id);
}

function ntSuspendScript(pid, mode) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GfProc {
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h = [GfProc]::OpenProcess(0x0800, $false, ${pid})
if ($h -eq [IntPtr]::Zero) { Write-Output 'open-fail'; exit 0 }
$code = if ('${mode}' -eq 'resume') { [GfProc]::NtResumeProcess($h) } else { [GfProc]::NtSuspendProcess($h) }
[void][GfProc]::CloseHandle($h)
if ($code -ne 0) { Write-Output "nt $code"; exit 1 }
Write-Output 'ok'
`;
}

function ntSuspend(pid, mode) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ntSuspendScript(pid, mode)], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.stdout?.on('data', (buf) => { out += buf.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', (status) => resolve(status === 0 && /ok/.test(out)));
  });
}

// Freeze or continue one process. Calls for the same pid run in order, so a
// resume that arrives while suspend is still starting still wins.
export function setProcessSuspended(pid, suspend) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve({ ok: false });
  const want = Boolean(suspend);
  suspendDesired.set(id, want);
  const prev = suspendQueue.get(id) || Promise.resolve();
  const run = prev.then(async () => {
    if (suspendDesired.get(id) !== want) return { ok: true, stale: true };
    const held = suspendedPids.has(id);
    if (want && held) return { ok: true, already: true };
    if (!want && !held) return { ok: true, already: true };
    if (process.platform !== 'win32') return { ok: false, unsupported: true };
    const ok = await ntSuspend(id, want ? 'suspend' : 'resume');
    if (!ok) return { ok: false };
    if (suspendDesired.get(id) !== want) return { ok: true, stale: true };
    if (want) suspendedPids.add(id);
    else suspendedPids.delete(id);
    return { ok: true };
  });
  suspendQueue.set(id, run.then(() => {}, () => {}));
  return run;
}
