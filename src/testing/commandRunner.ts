import { spawn } from 'node:child_process';
import { killProcessTree } from '../security/processTree.js';
import { buildSafeEnv, redactSecrets } from '../security/redact.js';
import type { ResolvedCommand } from './commandPolicy.js';

export interface CommandResult {
  name: string;
  /** Null when the process could not start or was killed. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Set when the process could not be started at all. */
  error?: string;
  /** Set when a timed-out process tree could not be confirmed terminated. Callers must fail closed. */
  killFailed?: boolean;
}

export interface RunOptions {
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  /** Extra variables added on top of the minimal safe environment. */
  extraEnv?: Record<string, string>;
  /** Literal values to redact from captured output (e.g. passed-through keys). */
  secrets?: readonly string[];
  /** Called with the child pid as soon as it has been spawned. */
  onSpawn?: (pid: number) => void;
  /** How long to wait for exit after the tree kill before giving up (default 10s). */
  killGraceMs?: number;
}

/**
 * Run an allowlisted command without a shell (`shell: false`), with a minimal
 * environment, a hard timeout and bounded, redacted output. Never throws for
 * command failures; the result describes what happened.
 *
 * On timeout the whole process tree is terminated (see killProcessTree). If
 * that cannot be confirmed, `killFailed` is set.
 *
 * Windows note: Node refuses to spawn `.cmd`/`.bat` files without a shell, so
 * allowlisted executables must be real binaries (e.g. `node`, `git`).
 */
export function runCommand(command: ResolvedCommand, options: RunOptions = {}): Promise<CommandResult> {
  const started = Date.now();
  const secrets = options.secrets ?? [];
  return new Promise((resolve) => {
    const stdout = new BoundedBuffer(command.maxOutputBytes);
    const stderr = new BoundedBuffer(command.maxOutputBytes);
    let timedOut = false;
    let killFailed = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({
        name: command.name,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: redactSecrets(stdout.text(), secrets),
        stderr: redactSecrets(stderr.text(), secrets),
        truncated: stdout.truncated || stderr.truncated,
        ...(error !== undefined ? { error: redactSecrets(error, secrets) } : {}),
        ...(killFailed ? { killFailed: true } : {}),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...buildSafeEnv(), ...(options.extraEnv ?? {}) },
        shell: false,
        windowsHide: true,
        // On POSIX, lead a new process group so the whole tree can be killed.
        detached: process.platform !== 'win32',
        stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(null, `Failed to start "${command.executable}": ${(err as Error).message}`);
      return;
    }

    if (child.pid !== undefined) options.onSpawn?.(child.pid);

    timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      const kill = pid !== undefined ? killProcessTree(pid) : Promise.resolve({ ok: false, detail: 'no pid' });
      void kill.then((res) => {
        if (!res.ok) {
          killFailed = true;
          child.kill();
        }
        // Fail closed if the process does not report exit within the grace period.
        graceTimer = setTimeout(() => {
          killFailed = true;
          finish(null, `Process did not exit after termination (${res.detail})`);
        }, options.killGraceMs ?? 10_000);
      });
    }, command.timeoutMs);

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined); // child may exit before reading everything
      child.stdin.end(options.stdin);
    }
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err) => finish(null, `Failed to start "${command.executable}": ${err.message}`));
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.chunks.push(part);
    this.size += part.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
