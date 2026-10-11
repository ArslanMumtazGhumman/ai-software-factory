import { spawn } from 'node:child_process';
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
}

/**
 * Run an allowlisted command without a shell (`shell: false`), with a minimal
 * environment, a hard timeout and bounded, redacted output. Never throws for
 * command failures; the result describes what happened.
 *
 * Windows note: Node refuses to spawn `.cmd`/`.bat` files without a shell, so
 * allowlisted executables must be real binaries (e.g. `node`, `git`).
 */
export function runCommand(command: ResolvedCommand): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const stdout = new BoundedBuffer(command.maxOutputBytes);
    const stderr = new BoundedBuffer(command.maxOutputBytes);
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: command.name,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        stdout: redactSecrets(stdout.text()),
        stderr: redactSecrets(stderr.text()),
        truncated: stdout.truncated || stderr.truncated,
        ...(error !== undefined ? { error: redactSecrets(error) } : {}),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: buildSafeEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(null, `Failed to start "${command.executable}": ${(err as Error).message}`);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, command.timeoutMs);

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
