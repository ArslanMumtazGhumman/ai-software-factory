import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FactoryError } from '../core/errors.js';
import { AUTORUNS_DIR } from '../persistence/autoRunStore.js';
import { newRunId } from '../persistence/runStore.js';
import { isProcessAlive } from '../security/processTree.js';
import type { DashboardProject } from './projects.js';
import { tailOf } from './views.js';

export interface LaunchRequest {
  kind: 'start' | 'resume';
  /** Only for start; validated against limits.maxTasksPerRun by the caller and again by the runner. */
  maxTasks?: number;
  retryFailed: boolean;
}

export interface LaunchResult {
  /** running: the runner reported it is working; finished: it already ended; starting: no report yet. */
  state: 'running' | 'finished' | 'starting';
  message: string;
  pid?: number;
  autoRunId?: string;
}

/** Starts or resumes an autonomous run. The default spawns the real CLI; tests inject their own. */
export interface RunLauncher {
  launch(project: DashboardProject, request: LaunchRequest): Promise<LaunchResult>;
  /** A launched runner process that is still alive for this project, if any. */
  pendingPid?(project: DashboardProject): number | undefined;
}

/** The runner process exited without starting or resuming a run. */
export class LaunchFailedError extends FactoryError {
  constructor(message: string) {
    super('LAUNCH_FAILED', message);
  }
}

export const LAUNCH_LOG_DIR = 'dashboard-launches';

/** Fixed CLI arguments: no user text reaches the command line except validated numbers. */
export function cliArgs(configFile: string, request: LaunchRequest): string[] {
  const args = ['auto', request.kind];
  if (request.kind === 'start' && request.maxTasks !== undefined) {
    if (!Number.isInteger(request.maxTasks) || request.maxTasks < 1 || request.maxTasks > 999) throw new RangeError('maxTasks out of range');
    args.push('--max-tasks', String(request.maxTasks));
  }
  if (request.retryFailed) args.push('--retry-failed');
  args.push('--config', configFile);
  return args;
}

const DEFAULT_CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

/**
 * Runs `node dist/src/cli.js auto start|resume --config <file>` as its own
 * detached process (no shell), exactly as a person would from CMD. The run
 * keeps going if the dashboard is closed; pause and stop reach it through the
 * runner's control file. Output goes to a log file in the data directory.
 */
export class CliRunLauncher implements RunLauncher {
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly options: { cliPath?: string; waitMs?: number; pollMs?: number } = {},
  ) {}

  pendingPid(project: DashboardProject): number | undefined {
    const pid = this.pending.get(project.id);
    if (pid !== undefined && !isProcessAlive(pid)) {
      this.pending.delete(project.id);
      return undefined;
    }
    return pid;
  }

  async launch(project: DashboardProject, request: LaunchRequest): Promise<LaunchResult> {
    const { store, config } = project;
    const before = new Set(await store.list());
    const activeBefore = await store.findActive();
    const segmentsBefore = activeBefore?.segments.length ?? 0;

    const logDir = path.join(config.dataDir, AUTORUNS_DIR, LAUNCH_LOG_DIR);
    await mkdir(logDir, { recursive: true });
    const logFile = path.join(logDir, `${newRunId(new Date())}-${request.kind}.log`);
    const log = await open(logFile, 'wx');
    let child;
    try {
      child = spawn(process.execPath, [this.options.cliPath ?? DEFAULT_CLI, ...cliArgs(project.configFile, request)], {
        cwd: config.projectRoot,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      });
    } finally {
      await log.close();
    }
    let exitCode: number | null | undefined;
    let spawnError: Error | undefined;
    child.once('exit', (code) => (exitCode = code));
    child.once('error', (err) => (spawnError = err));
    child.unref();
    const pid = child.pid;
    if (pid !== undefined) this.pending.set(project.id, pid);

    const deadline = Date.now() + (this.options.waitMs ?? 20_000);
    for (;;) {
      if (spawnError !== undefined) {
        this.pending.delete(project.id);
        throw new LaunchFailedError(`Could not start the runner process: ${spawnError.message}`);
      }
      const active = await store.findActive().catch(() => undefined);
      if (active?.state === 'running' && active.owner?.pid === pid && (request.kind === 'start' ? !before.has(active.autoRunId) : true)) {
        return { state: 'running', pid, autoRunId: active.autoRunId, message: `Run ${active.autoRunId} is running (runner pid ${pid}).` };
      }
      if (exitCode !== undefined) {
        this.pending.delete(project.id);
        const record =
          request.kind === 'start'
            ? (await store.list()).filter((id) => !before.has(id)).pop()
            : activeBefore !== undefined && (await store.load(activeBefore.autoRunId)).segments.length > segmentsBefore
              ? activeBefore.autoRunId
              : undefined;
        if (record !== undefined) {
          const finished = await store.load(record);
          return {
            state: 'finished',
            autoRunId: record,
            message: `Run ${record} is ${finished.state}${finished.stop ? `: ${finished.stop.reason} - ${finished.stop.message}` : ''}`,
          };
        }
        throw new LaunchFailedError(`The runner exited without ${request.kind === 'start' ? 'starting' : 'resuming'} a run. ${await errorFrom(logFile)}`);
      }
      if (Date.now() > deadline) {
        return { state: 'starting', ...(pid !== undefined ? { pid } : {}), message: `The runner process (pid ${pid ?? '?'}) started but has not reported yet; refresh shortly.` };
      }
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 200));
    }
  }
}

/** The CLI's error line from a launch log (redacted), or its redacted tail. */
async function errorFrom(logFile: string): Promise<string> {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  const line = text.split(/\r?\n/).find((l) => l.startsWith('Error ['));
  return line !== undefined ? tailOf(line, 1000) : tailOf(text.trim(), 1000) || '(no output)';
}

/** Redacted tail of the newest launch log of a project, if any. */
export async function latestLaunchLog(project: DashboardProject): Promise<{ file: string; tail: string } | undefined> {
  const dir = path.join(project.config.dataDir, AUTORUNS_DIR, LAUNCH_LOG_DIR);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-(start|resume)\.log$/.test(n)).sort();
  const last = names[names.length - 1];
  if (last === undefined) return undefined;
  const text = await readFile(path.join(dir, last), 'utf8').catch(() => '');
  return { file: last, tail: tailOf(text, 8000) };
}
