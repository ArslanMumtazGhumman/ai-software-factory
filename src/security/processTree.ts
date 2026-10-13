import { spawn } from 'node:child_process';
import path from 'node:path';

export interface KillResult {
  /** True when the tree is confirmed terminated (or was already gone). */
  ok: boolean;
  detail: string;
}

/** True if a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Terminate a process and its descendants.
 *
 * Windows: `taskkill /PID <pid> /T /F` walks the parent/child tree. Descendants
 * whose parent already exited (re-parented orphans) cannot be found this way.
 * POSIX: the child must have been spawned with `detached: true` so it leads its
 * own process group, which is then killed as a whole.
 */
export function killProcessTree(pid: number): Promise<KillResult> {
  if (process.platform === 'win32') return killWindowsTree(pid);
  try {
    process.kill(-pid, 'SIGKILL');
    return Promise.resolve({ ok: true, detail: `process group ${pid} killed` });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return Promise.resolve({ ok: true, detail: 'process group already exited' });
    return Promise.resolve({ ok: false, detail: `kill(-${pid}) failed: ${code ?? String(err)}` });
  }
}

function killWindowsTree(pid: number): Promise<KillResult> {
  const taskkill = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => resolve({ ok: false, detail: `taskkill could not start: ${err.message}` }));
    child.on('close', (code) => {
      // 0 = terminated; 128 = no such process (already exited).
      if (code === 0 || code === 128) resolve({ ok: true, detail: `taskkill exit ${code}` });
      else if (!isProcessAlive(pid)) resolve({ ok: true, detail: `taskkill exit ${code}; root process is gone` });
      else resolve({ ok: false, detail: `taskkill exit ${code}: ${output.trim()}` });
    });
  });
}
