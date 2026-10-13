import os from 'node:os';
import type { FactoryConfig } from '../config/factoryConfig.js';
import {
  ExecutionPolicyError,
  FactoryError,
  InvalidTransitionError,
  LockHeldError,
  ValidationError,
  describeError,
} from '../core/errors.js';
import { GitWorkspace } from '../git/gitWorkspace.js';
import {
  AutoRunStore,
  addEvent,
  type AutoRunExecution,
  type AutoRunRecord,
  type AutoRunState,
  type StopReason,
  type TaskCounts,
} from '../persistence/autoRunStore.js';
import type { FileLock, LockHandle } from '../persistence/fileLock.js';
import type { ProjectRepository } from '../persistence/projectRepository.js';
import { RunStore, newRunId, type RunRecord } from '../persistence/runStore.js';
import { evaluateAutoAccept } from '../review/autoAcceptPolicy.js';
import { isProcessAlive } from '../security/processTree.js';
import type { Task } from '../tasks/task.js';
import { explainTasks, selectEligibleTasks } from '../tasks/taskSelector.js';
import type { RecoveryReport, Supervisor } from './supervisor.js';

export interface AutonomousRunnerDeps {
  config: FactoryConfig;
  repository: ProjectRepository;
  supervisor: Supervisor;
  lock: FileLock;
  store?: AutoRunStore;
  runs?: RunStore;
  git?: GitWorkspace;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface StartOptions {
  /** Lower the task limit for this run (cannot exceed limits.maxTasksPerRun). */
  maxTasks?: number;
  /** Allow re-running tasks that failed earlier (within limits.maxRetries). Off by default. */
  retryFailed?: boolean;
}

export interface ResumeOptions {
  retryFailed?: boolean;
}

export interface AutoRunStatus {
  record: AutoRunRecord | undefined;
  /** For a running record: whether its runner process is alive. */
  ownerAlive?: boolean;
  counts?: TaskCounts;
}

interface Stop {
  state: AutoRunState;
  reason: StopReason;
  message: string;
  action: string;
}

/** A new task is only started when at least this much of the run's time budget remains. */
const MIN_TASK_START_MS = 30_000;

/** Error codes that mean isolation, locking, policy or integrity could not be established. */
const SAFETY_CODES = new Set([
  'GIT_ISOLATION_ERROR',
  'LOCK_HELD',
  'TAMPER_DETECTED',
  'EXECUTION_POLICY_ERROR',
  'COMMAND_NOT_ALLOWED',
  'PATH_NOT_ALLOWED',
  'AGENT_EXECUTION_DISABLED',
  'DEPENDENCY_ERROR',
  'VALIDATION_ERROR',
  'PERSISTENCE_ERROR',
]);

export function countTasks(tasks: readonly Task[]): TaskCounts {
  const count = (status: Task['status']) => tasks.filter((t) => t.status === status).length;
  return {
    total: tasks.length,
    completed: count('completed'),
    awaitingReview: count('awaiting_review'),
    failed: count('failed'),
    needsAttention: count('needs_attention'),
    inProgress: count('in_progress'),
    pending: count('pending'),
  };
}

/**
 * Bounded autonomous mode: repeatedly select the next eligible task with the
 * existing selector and run it through the existing Supervisor, one at a time.
 *
 * It continues only after a task is completed (accepted by the explicit
 * auto-accept policy). Anything else — work awaiting human review, a failure,
 * a safety gate, a limit, or a pause/stop request — ends the loop with a
 * recorded reason and the action a person must take.
 *
 * The runner holds the task-store lock while it works, so no other runner or
 * manual command can change the same project concurrently. Pause and stop
 * requests arrive through a control file and are honoured between tasks.
 */
export class AutonomousRunner {
  private readonly store: AutoRunStore;
  private readonly runs: RunStore;
  private readonly git: GitWorkspace;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private pauseSignal = false;

  constructor(private readonly deps: AutonomousRunnerDeps) {
    const { config } = deps;
    this.store = deps.store ?? new AutoRunStore(config.dataDir);
    this.runs = deps.runs ?? new RunStore(config.dataDir);
    this.git = deps.git ?? new GitWorkspace(config.projectRoot, config.dataDir);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  /** In-process pause request (e.g. Ctrl+C); honoured at the next task boundary. */
  requestPauseInProcess(): void {
    this.pauseSignal = true;
  }

  private assertPolicy(): void {
    const { config } = this.deps;
    this.deps.supervisor.assertExecutionPolicy();
    if (!config.autonomy.enabled) {
      throw new ExecutionPolicyError('Autonomous mode is disabled. Set "autonomy": { "enabled": true } in the factory config.');
    }
  }

  // ------------------------------------------------------------ start/resume

  async start(options: StartOptions = {}): Promise<AutoRunRecord> {
    this.assertPolicy();
    const { config } = this.deps;
    const maxTasks = options.maxTasks ?? config.limits.maxTasksPerRun;
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > config.limits.maxTasksPerRun) {
      throw new ValidationError(`--max-tasks must be an integer between 1 and limits.maxTasksPerRun (${config.limits.maxTasksPerRun})`);
    }

    const handle = await this.deps.lock.acquire('auto start');
    try {
      const active = await this.store.findActive();
      if (active !== undefined) {
        throw new InvalidTransitionError(
          `Autonomous run ${active.autoRunId} is ${active.state}. Resume it with "auto resume" or end it with "auto stop" before starting another.`,
        );
      }
      const reconcile = await this.deps.supervisor.reconcileInterrupted(handle);
      if (reconcile.unresolved.length > 0) {
        throw new LockHeldError(`Cannot start: ${reconcile.actions.join('; ')}`);
      }
      const [project, tasks] = await Promise.all([this.deps.repository.loadProject(), this.deps.repository.loadTasks()]);
      selectEligibleTasks(tasks, { maxRetries: config.limits.maxRetries }); // validates the dependency graph
      const { headCommit } = await this.git.preflight();

      const at = this.now().toISOString();
      const record: AutoRunRecord = {
        schemaVersion: 1,
        autoRunId: newRunId(this.now()),
        projectId: project.id,
        state: 'paused',
        createdAt: at,
        updatedAt: at,
        limits: {
          maxTasks,
          maxRunDurationMs: config.autonomy.maxRunDurationMs,
          maxTaskDurationMs: config.autonomy.maxTaskDurationMs,
          maxRepairAttempts: config.execution.maxRepairAttempts,
          ...(config.autonomy.maxCostUsd !== undefined ? { maxCostUsd: config.autonomy.maxCostUsd } : {}),
        },
        initialCommit: headCommit,
        tip: headCommit,
        activeMs: 0,
        costUsd: 0,
        costUnknown: false,
        segments: [],
        executions: [],
        events: [],
        droppedEvents: 0,
      };
      addEvent(record, at, 'start', `Started on ${headCommit} with up to ${maxTasks} task(s).`);
      for (const action of reconcile.actions.filter((a) => !a.startsWith('No interrupted'))) addEvent(record, at, 'recover', action);
      this.log(`Autonomous run ${record.autoRunId} started (base ${headCommit}, max ${maxTasks} task(s)).`);
      return await this.loop(record, handle, options.retryFailed === true);
    } finally {
      await this.release(handle);
    }
  }

  async resume(options: ResumeOptions = {}): Promise<AutoRunRecord> {
    this.assertPolicy();
    const handle = await this.deps.lock.acquire('auto resume');
    try {
      const record = await this.store.findActive();
      if (record === undefined) throw new InvalidTransitionError('There is no paused autonomous run. Start one with "auto start".');
      const at = this.now().toISOString();
      if (record.state === 'running') {
        // We hold the lock, so the process that was running it is gone.
        this.markInterrupted(record, at);
      }
      const reconcile = await this.deps.supervisor.reconcileInterrupted(handle);
      for (const action of reconcile.actions.filter((a) => !a.startsWith('No interrupted'))) addEvent(record, at, 'recover', action);
      if (reconcile.unresolved.length > 0) {
        return await this.finish(record, {
          state: 'paused',
          reason: 'safety-gate',
          message: `A process may still be working on ${reconcile.unresolved.join(', ')}.`,
          action: 'Stop the listed process (see "auto show"), then run "factory recover" and "factory auto resume".',
        }, undefined);
      }
      addEvent(record, at, 'resume', `Resumed${options.retryFailed ? ' (retrying failed tasks allowed)' : ''}.`);
      this.log(`Resuming autonomous run ${record.autoRunId}.`);
      return await this.loop(record, handle, options.retryFailed === true);
    } finally {
      await this.release(handle);
    }
  }

  // -------------------------------------------------------------------- loop

  private async loop(record: AutoRunRecord, handle: LockHandle, retryFailed: boolean): Promise<AutoRunRecord> {
    const { config, repository, supervisor } = this.deps;
    const segmentStart = this.now().getTime();
    const control = await this.store.readControl(record.autoRunId);
    // A request made while nothing was running is moot once the run is resumed.
    if (control !== undefined) record.handledControlNonce = control.nonce;
    record.state = 'running';
    record.owner = { pid: process.pid, hostname: os.hostname(), since: this.now().toISOString() };
    record.segments.push({ startedAt: this.now().toISOString() });
    delete record.stop;
    delete record.finishedAt;
    await this.save(record);

    const activeMs = () => record.activeMs + (this.now().getTime() - segmentStart);
    let stop: Stop;
    try {
      for (;;) {
        await this.deps.lock.assertHeld(handle.info);
        const requested = await this.pendingControl(record);
        if (requested === 'stop') {
          stop = { state: 'stopped', reason: 'stop-requested', message: 'Stopped on request.', action: 'Start a new run with "auto start" when ready.' };
          break;
        }
        if (requested === 'pause' || this.pauseSignal) {
          this.pauseSignal = false;
          stop = { state: 'paused', reason: 'pause-requested', message: 'Paused on request.', action: 'Continue with "factory auto resume".' };
          break;
        }

        const limitStop = this.checkLimits(record, activeMs());
        if (limitStop !== undefined) {
          stop = limitStop;
          break;
        }

        await this.refreshExecutions(record);
        record.tip = await this.advanceTip(record);
        const tasks = await repository.loadTasks();
        const gate = this.gateFor(tasks, retryFailed);
        if (gate.stop !== undefined) {
          stop = gate.stop;
          break;
        }
        const next = gate.next!;

        const taskDeadline = this.now().getTime() + record.limits.maxTaskDurationMs;
        const runDeadline = this.now().getTime() + (record.limits.maxRunDurationMs - activeMs());
        const startedAt = this.now().toISOString();
        const entry: AutoRunExecution = { taskId: next.id, startedAt, result: 'running', repairs: 0, baseCommit: record.tip };
        record.executions.push(entry);
        record.currentTask = { taskId: next.id, startedAt };
        addEvent(record, startedAt, 'task', `Selected ${next.id} (${next.title}).`);
        this.log(`Selected task ${next.id}: ${next.title}`);
        await this.save(record);

        let report;
        try {
          report = await supervisor.execute(next.id, {
            lock: handle,
            baseCommit: record.tip,
            deadline: Math.min(taskDeadline, runDeadline),
            autoRunId: record.autoRunId,
            onRunStarted: async (run) => {
              entry.runId = run.runId;
              entry.baseCommit = run.baseCommit;
              if (run.branch !== undefined) entry.branch = run.branch;
              if (run.worktreePath !== undefined) entry.worktreePath = run.worktreePath;
              record.currentTask = { taskId: next.id, runId: run.runId, startedAt };
              await this.save(record);
            },
          });
        } catch (err) {
          entry.result = 'error';
          entry.finishedAt = this.now().toISOString();
          entry.failureReason = describeError(err);
          delete record.currentTask;
          stop = this.errorStop(err, `while executing ${next.id}`);
          break;
        }
        delete record.currentTask;
        this.fillEntry(record, entry, report.run, report.task);

        if (report.run.outcome !== 'success') {
          const exhausted = report.task.status === 'needs_attention';
          entry.result = exhausted ? 'needs-attention' : 'failed';
          addEvent(record, entry.finishedAt!, 'task', `${next.id} failed: ${report.run.failureReason ?? 'unknown reason'}`);
          stop = {
            state: 'paused',
            reason: exhausted ? 'needs-attention' : 'task-failed',
            message: `${next.id} failed: ${report.run.failureReason ?? 'unknown reason'}${exhausted ? ' (retries exhausted)' : ''}.`,
            action: exhausted
              ? `Inspect with "factory review ${next.id}" (worktree ${report.run.worktreePath ?? 'n/a'}). Fix the task or code yourself; the factory will not retry it.`
              : `Inspect with "factory review ${next.id}". To let the runner retry it, run "factory auto resume --retry-failed".`,
          };
          break;
        }

        const decision = evaluateAutoAccept(config.autonomy.autoAccept, report.task, report.run);
        entry.reviewReasons = decision.reasons;
        if (!decision.accept) {
          entry.result = 'awaiting-review';
          addEvent(record, entry.finishedAt!, 'review', `${next.id} passed all checks and waits for human review: ${decision.reasons.join('; ')}`);
          stop = {
            state: 'paused',
            reason: 'awaiting-review',
            message: `${next.id} passed all checks and needs human review (${decision.reasons.join('; ')}).`,
            action: `Run "factory review ${next.id}", then "factory accept ${next.id}" or "factory reject ${next.id} <reason>", then "factory auto resume".`,
          };
          break;
        }

        let accepted;
        try {
          accepted = await supervisor.accept(next.id, { lock: handle, policyReason: `auto-accept policy: ${decision.reasons.join('; ')}` });
        } catch (err) {
          entry.result = 'error';
          entry.failureReason = `Auto-accept failed: ${describeError(err)}`;
          stop = this.errorStop(err, `while auto-accepting ${next.id}`);
          break;
        }
        entry.result = 'auto-accepted';
        entry.taskStatus = accepted.task.status;
        if (accepted.run.acceptedCommit !== undefined) {
          entry.acceptedCommit = accepted.run.acceptedCommit;
          record.tip = accepted.run.acceptedCommit;
        }
        record.lastCompletedTask = { taskId: next.id, runId: accepted.runId, at: this.now().toISOString(), by: 'policy' };
        addEvent(record, this.now().toISOString(), 'accept', `${next.id} auto-accepted (${decision.reasons.join('; ')}); committed ${entry.acceptedCommit ?? 'n/a'}.`);
        this.log(`Task ${next.id} auto-accepted; continuing.`);
        await this.save(record);
      }
    } catch (err) {
      delete record.currentTask;
      stop = this.errorStop(err, 'in the autonomous loop');
    }
    return this.finish(record, stop, activeMs());
  }

  /** Decide whether to continue, and with which task. Reads only the freshly loaded backlog. */
  private gateFor(tasks: Task[], retryFailed: boolean): { next?: Task; stop?: Stop } {
    const { maxRetries } = this.deps.config.limits;
    if (tasks.length > 0 && tasks.every((t) => t.status === 'completed')) {
      return { stop: { state: 'completed', reason: 'all-complete', message: `All ${tasks.length} task(s) are completed.`, action: 'Review the factory branches and merge the work yourself.' } };
    }
    if (tasks.length === 0) {
      return { stop: { state: 'completed', reason: 'all-complete', message: 'The backlog is empty.', action: 'Add tasks to tasks.json.' } };
    }
    const inProgress = tasks.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 0) {
      return {
        stop: {
          state: 'paused',
          reason: 'safety-gate',
          message: `Task(s) ${inProgress.map((t) => t.id).join(', ')} are in_progress outside this run; their result is uncertain.`,
          action: 'Run "factory recover", inspect the result, then "factory auto resume".',
        },
      };
    }
    const waiting = tasks.filter((t) => t.status === 'awaiting_review');
    if (waiting.length > 0) {
      const ids = waiting.map((t) => t.id).join(', ');
      return {
        stop: {
          state: 'paused',
          reason: 'awaiting-review',
          message: `Waiting for human review of ${ids}.`,
          action: `Review with "factory review <id>", decide with "factory accept <id>" or "factory reject <id> <reason>", then "factory auto resume".`,
        },
      };
    }
    const eligible = selectEligibleTasks(tasks, { maxRetries });
    const next = eligible.find((t) => retryFailed || t.status !== 'failed');
    if (next !== undefined) return { next };

    const retryable = eligible.filter((t) => t.status === 'failed').map((t) => t.id);
    if (retryable.length > 0) {
      return {
        stop: {
          state: 'paused',
          reason: 'task-failed',
          message: `Only previously failed task(s) remain eligible: ${retryable.join(', ')}. Failed tasks are not retried automatically.`,
          action: `Inspect with "factory review <id>"; to retry, run "factory auto resume --retry-failed".`,
        },
      };
    }
    const attention = tasks.filter((t) => t.status === 'needs_attention').map((t) => t.id);
    const blocked = explainTasks(tasks, maxRetries)
      .filter((e) => !e.eligibility.eligible && e.task.status !== 'completed')
      .map((e) => `${e.task.id}: ${e.eligibility.reason}`);
    return {
      stop: {
        state: 'paused',
        reason: attention.length > 0 ? 'needs-attention' : 'blocked',
        message: `No eligible tasks remain. ${blocked.join('; ')}.`,
        action:
          attention.length > 0
            ? `Task(s) ${attention.join(', ')} need a person (retries exhausted). Fix them, then "factory auto resume", or "factory auto stop".`
            : 'Resolve the blocking tasks, then "factory auto resume", or "factory auto stop".',
      },
    };
  }

  private checkLimits(record: AutoRunRecord, activeMs: number): Stop | undefined {
    const { limits } = record;
    const action = 'Review the work so far; start a new run with "factory auto start" for another budget.';
    if (record.executions.length >= limits.maxTasks) {
      return { state: 'stopped', reason: 'task-limit', message: `Task limit reached (${limits.maxTasks} task execution(s)).`, action };
    }
    // Stop before starting a task that could only fail for lack of time (and use up one of its retries).
    if (limits.maxRunDurationMs - activeMs < MIN_TASK_START_MS) {
      return {
        state: 'stopped',
        reason: 'duration-limit',
        message: `Run duration limit reached (${Math.round(activeMs)} of ${limits.maxRunDurationMs} ms active used).`,
        action,
      };
    }
    if (limits.maxCostUsd !== undefined) {
      if (record.costUnknown) {
        return {
          state: 'stopped',
          reason: 'cost-limit',
          message: 'An agent invocation did not report its cost, so the cost limit can no longer be enforced.',
          action,
        };
      }
      if (record.costUsd >= limits.maxCostUsd) {
        return { state: 'stopped', reason: 'cost-limit', message: `Cost limit reached ($${record.costUsd.toFixed(4)} of $${limits.maxCostUsd}).`, action };
      }
    }
    return undefined;
  }

  private async pendingControl(record: AutoRunRecord): Promise<'pause' | 'stop' | undefined> {
    const control = await this.store.readControl(record.autoRunId);
    if (control === undefined || control.nonce === record.handledControlNonce) return undefined;
    record.handledControlNonce = control.nonce;
    addEvent(record, this.now().toISOString(), 'control', `${control.request} requested at ${control.requestedAt} by pid ${control.pid}.`);
    return control.request;
  }

  /**
   * Move the tip forward over work accepted (by the policy or by a person)
   * in this run, so later tasks build on it. Never moves backwards or across
   * diverged history; the supervisor still checks every dependency.
   */
  private async advanceTip(record: AutoRunRecord): Promise<string> {
    let tip = record.tip;
    for (const entry of record.executions) {
      const commit = entry.acceptedCommit;
      if (commit === undefined || commit === tip) continue;
      if (await this.git.isAncestor(commit, tip)) continue;
      if (await this.git.isAncestor(tip, commit)) tip = commit;
      else addEvent(record, this.now().toISOString(), 'warning', `Accepted commit ${commit} of ${entry.taskId} has diverged from ${tip}; not included.`);
    }
    if (tip !== record.tip) addEvent(record, this.now().toISOString(), 'base', `Next tasks build on ${tip}.`);
    return tip;
  }

  /** Pick up human decisions made while the run was paused. */
  private async refreshExecutions(record: AutoRunRecord): Promise<void> {
    for (const entry of record.executions) {
      if (entry.result !== 'awaiting-review' || entry.runId === undefined) continue;
      let run: RunRecord;
      try {
        run = await this.runs.load(entry.runId);
      } catch {
        continue;
      }
      if (run.state === 'accepted') {
        entry.result = 'accepted';
        if (run.acceptedCommit !== undefined) entry.acceptedCommit = run.acceptedCommit;
        record.lastCompletedTask = { taskId: entry.taskId, runId: run.runId, at: run.decision?.at ?? this.now().toISOString(), by: 'human' };
        addEvent(record, this.now().toISOString(), 'review', `${entry.taskId} was accepted by a person.`);
      } else if (run.state === 'rejected') {
        entry.result = 'rejected';
        addEvent(record, this.now().toISOString(), 'review', `${entry.taskId} was rejected by a person: ${run.decision?.reason ?? ''}`);
      }
    }
  }

  private fillEntry(record: AutoRunRecord, entry: AutoRunExecution, run: RunRecord, task: Task): void {
    entry.finishedAt = run.finishedAt ?? this.now().toISOString();
    entry.runId = run.runId;
    entry.taskStatus = task.status;
    entry.agentExitCode = run.agent?.exitCode ?? null;
    entry.agentTimedOut = run.agent?.timedOut ?? false;
    entry.validation = (run.validation ?? []).map((v) => ({ name: v.name, exitCode: v.exitCode, timedOut: v.timedOut }));
    entry.repairs = run.repairs?.length ?? 0;
    if (run.branch !== undefined) entry.branch = run.branch;
    if (run.worktreePath !== undefined) entry.worktreePath = run.worktreePath;
    entry.baseCommit = run.baseCommit;
    if (run.failureReason !== undefined) entry.failureReason = run.failureReason;
    const invocations = [run.agent, ...(run.repairs ?? []).map((r) => r.agent)].filter((a) => a !== undefined);
    let cost = 0;
    for (const agent of invocations) {
      if (agent.costUsd === undefined) record.costUnknown = true;
      else cost += agent.costUsd;
    }
    entry.costUsd = cost;
    record.costUsd += cost;
    if (entry.repairs > 0) addEvent(record, entry.finishedAt, 'repair', `${entry.taskId} used ${entry.repairs} repair attempt(s).`);
  }

  private errorStop(err: unknown, where: string): Stop {
    const code = err instanceof FactoryError ? err.code : 'UNEXPECTED_ERROR';
    const safety = SAFETY_CODES.has(code);
    return {
      state: 'paused',
      reason: safety ? 'safety-gate' : 'error',
      message: `${code} ${where}: ${describeError(err)}`,
      action: safety
        ? 'Fix the reported condition (repository state, lock, configuration or integrity), then "factory auto resume".'
        : 'Inspect with "factory auto failures", fix the cause, then "factory recover" and "factory auto resume".',
    };
  }

  private async finish(record: AutoRunRecord, stop: Stop, activeMs: number | undefined): Promise<AutoRunRecord> {
    const at = this.now().toISOString();
    if (activeMs !== undefined) record.activeMs = activeMs;
    const segment = record.segments[record.segments.length - 1];
    if (segment !== undefined && segment.endedAt === undefined) {
      segment.endedAt = at;
      segment.reason = stop.reason;
    }
    record.state = stop.state;
    record.stop = { reason: stop.reason, message: stop.message, action: stop.action, at };
    delete record.owner;
    delete record.currentTask;
    if (stop.state === 'stopped' || stop.state === 'completed') record.finishedAt = at;
    try {
      record.summary = countTasks(await this.deps.repository.loadTasks());
    } catch {
      /* keep the previous summary */
    }
    addEvent(record, at, stop.state === 'paused' ? 'pause' : stop.state === 'completed' ? 'complete' : 'stop', `${stop.reason}: ${stop.message}`);
    this.log(`Autonomous run ${record.autoRunId} ${stop.state}: ${stop.message}`);
    try {
      await this.save(record);
    } catch (err) {
      this.log(`Could not save the autonomous run record (${describeError(err)}); run "factory recover".`);
    }
    return record;
  }

  private markInterrupted(record: AutoRunRecord, at: string): void {
    const segment = record.segments[record.segments.length - 1];
    if (segment !== undefined && segment.endedAt === undefined) {
      segment.endedAt = at;
      segment.reason = 'interrupted';
      // Count the interrupted segment's time up to its last recorded update.
      record.activeMs += Math.max(0, Date.parse(record.updatedAt) - Date.parse(segment.startedAt));
    }
    for (const entry of record.executions) {
      if (entry.result === 'running') {
        entry.result = 'interrupted';
        entry.finishedAt = at;
        entry.failureReason = 'The runner process exited while this task was executing.';
      }
    }
    const pid = record.owner?.pid;
    delete record.owner;
    delete record.currentTask;
    record.state = 'paused';
    record.stop = {
      reason: 'interrupted',
      message: `The runner process${pid !== undefined ? ` (pid ${pid})` : ''} exited without pausing.`,
      action: 'Inspect with "factory auto show", then "factory auto resume". The interrupted task is not retried automatically.',
      at,
    };
    addEvent(record, at, 'interrupted', record.stop.message);
  }

  // ---------------------------------------------------------- pause / stop

  /** Ask a running runner to pause (or stop) after the current task. Never touches tasks. */
  async request(kind: 'pause' | 'stop'): Promise<string> {
    const record = await this.store.findActive();
    if (record === undefined) return 'There is no active autonomous run.';
    if (record.state === 'paused') {
      if (kind === 'pause') return `Autonomous run ${record.autoRunId} is already paused (${record.stop?.reason ?? 'unknown reason'}).`;
      const handle = await this.deps.lock.acquire('auto stop');
      try {
        const fresh = await this.store.load(record.autoRunId);
        if (fresh.state !== 'paused') throw new InvalidTransitionError(`Autonomous run ${fresh.autoRunId} is now ${fresh.state}; try again.`);
        await this.finish(fresh, { state: 'stopped', reason: 'stop-requested', message: 'Stopped while paused.', action: 'Start a new run with "factory auto start" when ready.' }, undefined);
        return `Autonomous run ${fresh.autoRunId} stopped. Its tasks, worktrees and branches are unchanged.`;
      } finally {
        await this.release(handle);
      }
    }
    const owner = record.owner;
    if (owner !== undefined && owner.hostname === os.hostname() && !isProcessAlive(owner.pid)) {
      return `The runner (pid ${owner.pid}) is no longer running. Run "factory recover", then "factory auto ${kind === 'stop' ? 'stop' : 'status'}".`;
    }
    await this.store.writeControl(record.autoRunId, kind, this.now().toISOString());
    return kind === 'pause'
      ? `Pause requested for ${record.autoRunId}. The runner pauses after the current task${record.currentTask ? ` (${record.currentTask.taskId})` : ''} finishes.`
      : `Stop requested for ${record.autoRunId}. No new task will start; the current task${record.currentTask ? ` (${record.currentTask.taskId})` : ''} finishes first.`;
  }

  // ------------------------------------------------------- recovery / views

  /** "factory recover": supervisor recovery plus autonomous runs whose runner died. */
  async recover(): Promise<RecoveryReport> {
    const report = await this.deps.supervisor.recover();
    const handle = await this.deps.lock.acquire('recover autonomous runs');
    try {
      for (const record of await this.store.loadAll()) {
        if (record.state !== 'running') continue;
        const owner = record.owner;
        if (owner !== undefined && owner.hostname === os.hostname() && owner.pid !== process.pid && isProcessAlive(owner.pid)) {
          report.actions.push(`autonomous run ${record.autoRunId}: runner pid ${owner.pid} is alive but does not hold the lock (possible pid reuse); left unchanged.`);
          report.unresolved.push(record.autoRunId);
          continue;
        }
        this.markInterrupted(record, this.now().toISOString());
        await this.save(record);
        report.actions.push(`autonomous run ${record.autoRunId}: marked paused (interrupted). Resume with "factory auto resume".`);
      }
    } finally {
      await this.release(handle);
    }
    return report;
  }

  async status(): Promise<AutoRunStatus> {
    const record = (await this.store.findActive()) ?? (await this.store.latest());
    if (record === undefined) return { record };
    let counts: TaskCounts | undefined;
    try {
      counts = countTasks(await this.deps.repository.loadTasks());
    } catch {
      /* show what we have */
    }
    const owner = record.owner;
    const ownerAlive = record.state === 'running' && owner !== undefined ? owner.hostname !== os.hostname() || isProcessAlive(owner.pid) : undefined;
    return { record, ...(ownerAlive !== undefined ? { ownerAlive } : {}), ...(counts !== undefined ? { counts } : {}) };
  }

  history(): Promise<AutoRunRecord[]> {
    return this.store.loadAll();
  }

  async show(autoRunId?: string): Promise<AutoRunRecord> {
    if (autoRunId !== undefined) return this.store.load(autoRunId);
    const record = (await this.store.findActive()) ?? (await this.store.latest());
    if (record === undefined) throw new InvalidTransitionError('No autonomous runs have been recorded yet.');
    return record;
  }

  /** Failed or errored executions of a run with their full run records (sanitized evidence). */
  async failures(autoRunId?: string): Promise<{ record: AutoRunRecord; failures: { entry: AutoRunExecution; run?: RunRecord }[] }> {
    const record = await this.show(autoRunId);
    const failures: { entry: AutoRunExecution; run?: RunRecord }[] = [];
    for (const entry of record.executions) {
      if (!['failed', 'needs-attention', 'error', 'interrupted', 'rejected'].includes(entry.result) && entry.repairs === 0) continue;
      let run: RunRecord | undefined;
      if (entry.runId !== undefined) {
        try {
          run = await this.runs.load(entry.runId);
        } catch {
          run = undefined;
        }
      }
      failures.push({ entry, ...(run !== undefined ? { run } : {}) });
    }
    return { record, failures };
  }

  // ---------------------------------------------------------------- helpers

  private async save(record: AutoRunRecord): Promise<void> {
    record.updatedAt = this.now().toISOString();
    await this.store.save(record);
  }

  private async release(handle: LockHandle): Promise<void> {
    try {
      await handle.release();
    } catch (err) {
      this.log(`Warning: could not release lock: ${describeError(err)}`);
    }
  }
}
