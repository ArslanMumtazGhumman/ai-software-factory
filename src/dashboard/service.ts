import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { FactoryError, TaskNotFoundError, ValidationError, describeError } from '../core/errors.js';
import { countTasks } from '../orchestrator/autonomousRunner.js';
import type { AutoRunRecord } from '../persistence/autoRunStore.js';
import type { LockState } from '../persistence/fileLock.js';
import type { RunRecord } from '../persistence/runStore.js';
import { isProcessAlive } from '../security/processTree.js';
import { TASK_ID, RUN_ID, type Task } from '../tasks/task.js';
import { explainTasks } from '../tasks/taskSelector.js';
import os from 'node:os';
import { latestLaunchLog, type LaunchRequest, type LaunchResult, type RunLauncher } from './launcher.js';
import type { PlanningService } from '../planning/planningService.js';
import type { DashboardProject } from './projects.js';
import {
  budgetView,
  clean,
  configView,
  executionView,
  runSummaryView,
  runView,
  taskResultsView,
  taskView,
} from './views.js';

/** A request that conflicts with the current state (duplicate start, run active, result changed...). */
export class ConflictError extends FactoryError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export class NotFoundError extends FactoryError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/** Largest diff returned to the browser in one response. */
export const MAX_PATCH_CHARS = 512 * 1024;
const MAX_ACTIVITY = 500;

export interface ControlState {
  allowed: boolean;
  reason: string;
}

export interface DashboardServiceOptions {
  launcher: RunLauncher;
  now?: () => Date;
  /** Test seam for the agent availability check (default: search PATH without running anything). */
  agentAvailable?: (executable: string) => Promise<boolean>;
  /** Idea-to-project planning (dashboard started with --workspace). */
  planning?: PlanningService;
}

/**
 * Read models and controls for the dashboard. Every read goes to the factory's
 * own files through its existing repositories and stores; every action calls
 * the same orchestrator operation as the matching CLI command. The dashboard
 * keeps no task state of its own.
 */
export class DashboardService {
  private readonly byId: Map<string, DashboardProject>;
  private readonly now: () => Date;
  private readonly agentAvailable: (executable: string) => Promise<boolean>;
  /** Projects with a start/resume request being processed (duplicate-click guard). */
  private readonly launching = new Set<string>();
  private readonly agentCache = new Map<string, boolean>();
  private readonly list: DashboardProject[];

  constructor(
    projects: readonly DashboardProject[],
    private readonly options: DashboardServiceOptions,
  ) {
    this.list = [...projects];
    this.byId = new Map(projects.map((p) => [p.id, p] as const));
    this.now = options.now ?? (() => new Date());
    this.agentAvailable = options.agentAvailable ?? findOnPath;
    this.planning = options.planning;
  }

  /** Idea-to-project planning, when the dashboard was started with a workspace. */
  readonly planning: PlanningService | undefined;

  get projects(): readonly DashboardProject[] {
    return this.list;
  }

  /** Add a project created while the dashboard runs (by planning). Adding the same project twice is a no-op. */
  addProject(project: DashboardProject): void {
    if (this.byId.has(project.id)) return;
    this.list.push(project);
    this.byId.set(project.id, project);
  }

  project(id: string): DashboardProject {
    const p = this.byId.get(id);
    if (p === undefined) throw new NotFoundError('Unknown project.');
    return p;
  }

  // ------------------------------------------------------------------ reads

  async overview() {
    const projects = await Promise.all(this.projects.map((p) => this.projectSummary(p)));
    let estimatedUsd = 0;
    let incomplete = false;
    let runsCounted = 0;
    for (const p of this.projects) {
      for (const record of await settledRead(() => p.store.loadAll()).catch(() => [] as AutoRunRecord[])) {
        estimatedUsd += record.costUsd;
        incomplete ||= record.costUnknown;
        runsCounted += 1;
      }
    }
    const active = projects.filter((p) => p.run !== null && (p.run.state === 'running' || p.run.state === 'paused'));
    return {
      projectCount: projects.length,
      projects,
      active: active.map((p) => ({ projectId: p.id, projectName: p.name, run: p.run })),
      usage: {
        actual: {
          available: false,
          note: 'Actual charges are not available: the factory has no access to Anthropic billing data. Check your Anthropic console or plan usage page.',
        },
        estimated: {
          kind: 'estimate',
          label: 'Estimated cost reported by Claude Code (total_cost_usd), autonomous runs only',
          usd: estimatedUsd,
          runsCounted,
          incomplete,
          note: incomplete
            ? 'Incomplete: at least one agent call did not report its cost, so the real usage may be higher.'
            : runsCounted === 0
              ? 'No autonomous runs recorded yet.'
              : 'Supervised single-task executions (CLI "execute") are not included.',
        },
      },
    };
  }

  private async projectSummary(p: DashboardProject) {
    const base = { id: p.id, location: p.config.projectRoot, configFile: path.basename(p.configFile) };
    try {
      const [spec, tasks] = await Promise.all([p.repository.loadProject(), p.repository.loadTasks()]);
      const counts = countTasks(tasks);
      const status = await this.runStatus(p);
      return {
        ...base,
        name: spec.name,
        status: 'ok' as const,
        error: null,
        counts,
        progress: counts.total === 0 ? 0 : counts.completed / counts.total,
        run: status.record === undefined ? null : { ...runSummaryView(status.record, this.now().getTime()), ownerAlive: status.ownerAlive ?? null },
        lastActivity: lastActivity(tasks, status.record),
      };
    } catch (err) {
      return { ...base, name: path.basename(p.config.projectRoot), status: 'error' as const, error: safeMessage(err), counts: null, progress: 0, run: null, lastActivity: null };
    }
  }

  private async runStatus(p: DashboardProject): Promise<{ record?: AutoRunRecord; ownerAlive?: boolean }> {
    const record = await settledRead(async () => (await p.store.findActive()) ?? (await p.store.latest()));
    if (record === undefined) return {};
    const owner = record.owner;
    const ownerAlive = record.state === 'running' && owner !== undefined ? owner.hostname !== os.hostname() || isProcessAlive(owner.pid) : undefined;
    return { record, ...(ownerAlive !== undefined ? { ownerAlive } : {}) };
  }

  /**
   * Cheap change detector for polling: the browser refetches a view only when
   * its project's version changes. It only lists directories and reads file
   * timestamps; it never opens the state files, so polling cannot get in the way
   * of a runner replacing them (Windows refuses to replace a file that is open).
   */
  async status() {
    const stamp = (file: string) => stat(file).then((s) => `${s.mtimeMs}:${s.size}`, () => '-');
    const projects = await Promise.all(
      this.projects.map(async (p) => {
        const runs = await Promise.all((await p.store.list()).map(async (id) => `${id}=${await stamp(path.join(p.store.dir, id, 'autorun.json'))}`));
        const parts = [await stamp(p.repository.tasksFile), await stamp(p.lock.lockPath), ...runs];
        return { id: p.id, version: createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16) };
      }),
    );
    const plans =
      this.planning === undefined
        ? []
        : await Promise.all(
            (await this.planning.store.list()).map(async (planId) => ({
              planId,
              version: await stamp(path.join(this.planning!.store.dir(planId), 'plan-record.json')),
            })),
          );
    return { serverTime: this.now().toISOString(), projects, plans };
  }

  async projectDetail(id: string) {
    const p = this.project(id);
    const [spec, tasks] = await Promise.all([p.repository.loadProject(), p.repository.loadTasks()]);
    const status = await this.runStatus(p);
    return {
      id: p.id,
      name: spec.name,
      location: p.config.projectRoot,
      configFile: p.configFile,
      spec: { ...spec, description: clean(spec.description, 20_000) ?? '' },
      counts: countTasks(tasks),
      config: configView(p.config),
      lock: lockView(await p.lock.inspect()),
      run: status.record === undefined ? null : { ...runSummaryView(status.record, this.now().getTime()), ownerAlive: status.ownerAlive ?? null },
    };
  }

  async tasks(id: string) {
    const p = this.project(id);
    const tasks = await p.repository.loadTasks();
    const views = [];
    for (const { task, eligibility } of explainTasks(tasks, p.config.limits.maxRetries)) {
      const run = await this.latestRun(p, task);
      views.push({
        ...taskView(task, eligibility),
        branch: run?.branch ?? null,
        worktreePath: run?.worktreePath ?? null,
        validation: (run?.validation ?? []).map((v) => ({ name: v.name, exitCode: v.exitCode, timedOut: v.timedOut, passed: v.exitCode === 0 && !v.timedOut })),
        blockedBy: blockers(task, tasks),
      });
    }
    return { projectId: p.id, maxRetries: p.config.limits.maxRetries, tasks: views };
  }

  async task(id: string, taskId: string) {
    const p = this.project(id);
    assertTaskId(taskId);
    const tasks = await p.repository.loadTasks();
    const entry = explainTasks(tasks, p.config.limits.maxRetries).find((e) => e.task.id === taskId);
    if (entry === undefined) throw new TaskNotFoundError(taskId);
    const run = await this.latestRun(p, entry.task);
    return {
      task: { ...taskView(entry.task, entry.eligibility), blockedBy: blockers(entry.task, tasks) },
      results: taskResultsView(entry.task),
      latestRun: run === undefined ? null : runView(run),
    };
  }

  /** Everything a person needs to decide on a result awaiting review, including the recorded diff. */
  async review(id: string, taskId: string) {
    const p = this.project(id);
    assertTaskId(taskId);
    const view = await p.supervisor.review(taskId);
    const patch = view.patch.length > MAX_PATCH_CHARS ? view.patch.slice(0, MAX_PATCH_CHARS) : view.patch;
    const awaiting = view.task.status === 'awaiting_review' && view.task.currentRunId === view.run.runId;
    return {
      task: { id: view.task.id, title: view.task.title, status: view.task.status, acceptanceCriteria: view.task.acceptanceCriteria },
      run: runView(view.run),
      integrityProblems: view.integrityProblems.map((m) => clean(m) ?? ''),
      patch,
      patchTruncated: patch.length < view.patch.length,
      decidable: awaiting && view.run.review !== undefined,
      /** Sent back with accept/reject so a decision only applies to exactly what was shown. */
      fingerprint: view.run.review === undefined ? null : { runId: view.run.runId, diffSha256: view.run.review.diffSha256 },
    };
  }

  async runs(id: string) {
    const p = this.project(id);
    const records = await settledRead(() => p.store.loadAll());
    const now = this.now().getTime();
    return { projectId: p.id, runs: records.reverse().map((r) => runSummaryView(r, now)) };
  }

  async run(id: string, autoRunId: string) {
    const p = this.project(id);
    if (!RUN_ID.test(autoRunId)) throw new ValidationError('Invalid run id.');
    const record = await p.store.load(autoRunId).catch((err) => {
      throw /does not exist/.test(describeError(err)) ? new NotFoundError('Unknown run.') : err;
    });
    const executions = [];
    for (const entry of record.executions) {
      let run: RunRecord | undefined;
      if (entry.runId !== undefined) run = await p.runs.load(entry.runId).catch(() => undefined);
      executions.push(executionView(entry, run));
    }
    const tasks = await p.repository.loadTasks().catch(() => [] as Task[]);
    const remaining = tasks.length === 0 ? [] : explainTasks(tasks, p.config.limits.maxRetries).filter((e) => e.task.status !== 'completed');
    const current = executions.find((e) => e.result === 'running');
    const status = await this.runStatus(p);
    return {
      summary: runSummaryView(record, this.now().getTime()),
      ownerAlive: status.record?.autoRunId === record.autoRunId ? (status.ownerAlive ?? null) : null,
      current: current === undefined ? null : { taskId: current.taskId, runId: current.runId, stage: current.run?.stage ?? 'starting', startedAt: current.startedAt },
      executions,
      budget: budgetView(record, p.config.agent.maxBudgetUsd),
      budgetEvents: record.events.filter((e) => /cost|budget/i.test(e.message)).map((e) => ({ ...e, message: clean(e.message) ?? '' })),
      segments: record.segments,
      events: record.events.map((e) => ({ ...e, message: clean(e.message) ?? '' })),
      droppedEvents: record.droppedEvents,
      remainingTasks: remaining.map(({ task, eligibility }) => ({ id: task.id, title: task.title, status: task.status, eligibility: eligibility.reason })),
    };
  }

  /** Readable timeline from autonomous-run events and recorded task results and decisions. */
  async activity(id: string) {
    const p = this.project(id);
    const items: { at: string; kind: string; severity: 'info' | 'warning' | 'error'; message: string; autoRunId?: string; taskId?: string }[] = [];
    for (const record of await settledRead(() => p.store.loadAll()).catch(() => [] as AutoRunRecord[])) {
      for (const e of record.events) {
        const { kind, severity } = classifyEvent(e.type, e.message);
        items.push({ at: e.at, kind, severity, message: clean(e.message, 2000) ?? '', autoRunId: record.autoRunId });
      }
    }
    for (const task of await p.repository.loadTasks().catch(() => [] as Task[])) {
      for (const r of task.results) {
        if (r.outcome === 'failure' && r.review === undefined) {
          const validation = /check|validation|test/i.test(`${r.error ?? ''} ${r.summary}`);
          items.push({
            at: r.finishedAt,
            kind: validation ? 'validation' : 'task',
            severity: 'error',
            message: `${task.id} failed (attempt ${r.attempt}): ${clean(r.error ?? r.summary, 500)}`,
            taskId: task.id,
          });
        }
        if (r.review !== undefined) {
          const by = r.review.by === 'policy' ? 'auto-accept policy' : 'a person';
          items.push({
            at: r.review.reviewedAt,
            kind: 'decision',
            severity: r.review.decision === 'accepted' ? 'info' : 'warning',
            message: `${task.id} ${r.review.decision} by ${by}${r.review.reason ? `: ${clean(r.review.reason, 500)}` : ''}`,
            taskId: task.id,
          });
        }
      }
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return { projectId: p.id, items: items.slice(0, MAX_ACTIVITY), truncated: items.length > MAX_ACTIVITY };
  }

  async launchLog(id: string) {
    const p = this.project(id);
    return { log: (await latestLaunchLog(p)) ?? null };
  }

  /**
   * Which controls are available now and why not, plus the limits a run will
   * use. Shown before a start so a person confirms the exact configured limits.
   */
  async controls(id: string) {
    return this.controlsFor(this.project(id), false);
  }

  private async controlsFor(p: DashboardProject, ownLaunch: boolean) {
    const { config } = p;
    const policy = this.policyProblem(p);
    const agentOk = await this.isAgentAvailable(config.agent.executable);
    const lock = await p.lock.inspect();
    let active: AutoRunRecord | undefined;
    let activeError: string | undefined;
    try {
      active = await settledRead(() => p.store.findActive());
    } catch (err) {
      activeError = safeMessage(err);
    }
    const pendingPid = this.options.launcher.pendingPid?.(p);
    const ownerAlive = active?.state === 'running' && active.owner !== undefined ? active.owner.hostname !== os.hostname() || isProcessAlive(active.owner.pid) : undefined;
    const lockProblem = lock.state === 'free' ? undefined : lockText(lock);
    const busy =
      !ownLaunch && this.launching.has(p.id) ? 'A start or resume request is already being processed.'
      : pendingPid !== undefined ? `A runner process (pid ${pendingPid}) launched from the dashboard is still starting.`
      : undefined;

    const deny = (...reasons: (string | undefined)[]): ControlState => {
      const reason = reasons.find((r) => r !== undefined);
      return reason === undefined ? { allowed: true, reason: '' } : { allowed: false, reason };
    };
    const recoverHint =
      active?.state === 'running' && ownerAlive === false
        ? `The runner (pid ${active.owner?.pid}) is no longer running. Run "node dist\\src\\cli.js recover --config ${p.configFile}" in CMD, then resume.`
        : undefined;

    const start = deny(
      policy,
      agentOk ? undefined : `Claude Code ("${config.agent.executable}") was not found on PATH, so a run could not call the agent.`,
      activeError,
      active !== undefined ? `Run ${active.autoRunId} is ${active.state}. Resume or stop it before starting another.` : undefined,
      busy,
      lockProblem,
    );
    const resume = deny(
      policy,
      agentOk ? undefined : `Claude Code ("${config.agent.executable}") was not found on PATH.`,
      activeError,
      active === undefined ? 'There is no paused run to resume.' : undefined,
      recoverHint,
      active?.state === 'running' ? 'The run is already running.' : undefined,
      busy,
      lockProblem,
    );
    const pause = deny(
      activeError,
      active === undefined ? 'There is no active run.' : undefined,
      active?.state === 'paused' ? 'The run is already paused.' : undefined,
      recoverHint,
    );
    const stop = deny(
      activeError,
      active === undefined ? 'There is no active run.' : undefined,
      recoverHint,
      active?.state === 'paused' ? lockProblem : undefined,
    );
    const perCall = config.agent.maxBudgetUsd;
    return {
      projectId: p.id,
      activeRun: active === undefined ? null : { autoRunId: active.autoRunId, state: active.state, ownerAlive: ownerAlive ?? null },
      lock: lockView(lock),
      controls: { start, resume, pause, stop },
      /** The limits a new run uses; they come from the config file and cannot be raised from the dashboard. */
      limits: {
        maxTasks: config.limits.maxTasksPerRun,
        maxRunDurationMs: config.autonomy.maxRunDurationMs,
        maxTaskDurationMs: config.autonomy.maxTaskDurationMs,
        agentTimeoutMs: config.limits.agentTimeoutMs,
        maxRepairAttempts: config.execution.maxRepairAttempts,
        maxRetries: config.limits.maxRetries,
        perCallBudgetUsd: perCall ?? null,
        runBudgetUsd: config.autonomy.maxCostUsd ?? null,
        autoAccept: config.autonomy.autoAccept.enabled
          ? { enabled: true, taskIds: config.autonomy.autoAccept.taskIds, paths: config.autonomy.autoAccept.paths }
          : { enabled: false, taskIds: [], paths: [] },
        validationCommands: config.execution.validationCommands,
        budgetNote:
          perCall === undefined
            ? 'No per-call budget (agent.maxBudgetUsd) is configured: agent calls are not capped in cost.'
            : config.autonomy.maxCostUsd === undefined
              ? `Each agent call is capped by Claude Code at $${perCall}; the run total is not capped.`
              : `Each agent call is capped by Claude Code at $${perCall}; a call only starts while the run's $${config.autonomy.maxCostUsd} budget still covers it. Costs are Claude Code's own estimates, not a hard guarantee.`,
      },
    };
  }

  private policyProblem(p: DashboardProject): string | undefined {
    try {
      p.supervisor.assertExecutionPolicy();
    } catch (err) {
      return safeMessage(err);
    }
    if (!p.config.autonomy.enabled) return 'Autonomous mode is disabled in this project\'s config ("autonomy": { "enabled": true }).';
    return undefined;
  }

  private async isAgentAvailable(executable: string): Promise<boolean> {
    const cached = this.agentCache.get(executable);
    if (cached === true) return true;
    const found = await this.agentAvailable(executable);
    this.agentCache.set(executable, found);
    return found;
  }

  // ---------------------------------------------------------------- actions

  async start(id: string, input: { maxTasks?: number; retryFailed: boolean }): Promise<LaunchResult> {
    const p = this.project(id);
    const max = p.config.limits.maxTasksPerRun;
    if (input.maxTasks !== undefined && (!Number.isInteger(input.maxTasks) || input.maxTasks < 1 || input.maxTasks > max)) {
      throw new ValidationError(`maxTasks must be a whole number between 1 and the configured limit (${max}).`);
    }
    return this.launch(p, { kind: 'start', retryFailed: input.retryFailed, ...(input.maxTasks !== undefined ? { maxTasks: input.maxTasks } : {}) });
  }

  async resume(id: string, input: { retryFailed: boolean }): Promise<LaunchResult> {
    return this.launch(this.project(id), { kind: 'resume', retryFailed: input.retryFailed });
  }

  private async launch(p: DashboardProject, request: LaunchRequest): Promise<LaunchResult> {
    // Claim the project synchronously so concurrent requests cannot both pass the checks below.
    if (this.launching.has(p.id)) throw new ConflictError('A start or resume request for this project is already being processed.');
    this.launching.add(p.id);
    try {
      const { controls } = await this.controlsFor(p, true);
      const state = controls[request.kind];
      if (!state.allowed) throw new ConflictError(state.reason);
      return await this.options.launcher.launch(p, request);
    } finally {
      this.launching.delete(p.id);
    }
  }

  /** Same operation as "factory auto pause|stop": a control request the runner honours between tasks. */
  async request(id: string, kind: 'pause' | 'stop'): Promise<{ message: string }> {
    const p = this.project(id);
    const { controls } = await this.controls(id);
    if (!controls[kind].allowed) throw new ConflictError(controls[kind].reason);
    return { message: clean(await p.runner.request(kind)) ?? '' };
  }

  /** "factory accept", only for exactly the result the person was shown. */
  async accept(id: string, taskId: string, input: { runId: string; diffSha256: string }) {
    const p = this.project(id);
    await this.assertShown(p, taskId, input.runId, input.diffSha256);
    const { task, run } = await p.supervisor.accept(taskId);
    return {
      message: `Accepted ${task.id}. The reviewed tree was committed as ${run.acceptedCommit} on ${run.branch}. Nothing was merged into your branch.`,
      task: { id: task.id, status: task.status },
      acceptedCommit: run.acceptedCommit ?? null,
      branch: run.branch ?? null,
    };
  }

  /** "factory reject": the worktree, branch and evidence are kept for inspection. */
  async reject(id: string, taskId: string, input: { runId: string; diffSha256: string; reason: string }) {
    const p = this.project(id);
    await this.assertShown(p, taskId, input.runId, input.diffSha256);
    const { task, run } = await p.supervisor.reject(taskId, input.reason);
    return {
      message: `Rejected ${task.id}; status is now ${task.status}. The work is preserved in ${run.worktreePath} (branch ${run.branch}).`,
      task: { id: task.id, status: task.status, retryCount: task.retryCount },
      worktreePath: run.worktreePath ?? null,
      branch: run.branch ?? null,
    };
  }

  private async assertShown(p: DashboardProject, taskId: string, runId: string, diffSha256: string): Promise<void> {
    assertTaskId(taskId);
    const task = (await p.repository.loadTasks()).find((t) => t.id === taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (task.status !== 'awaiting_review' || task.currentRunId === undefined) {
      throw new ConflictError(`Task ${taskId} is no longer awaiting review (status ${task.status}). Reload to see its current state.`);
    }
    if (task.currentRunId !== runId) throw new ConflictError(`Task ${taskId} now has a different result (run ${task.currentRunId}). Reload the review.`);
    const run = await p.runs.load(runId);
    if (run.review?.diffSha256 !== diffSha256) throw new ConflictError('The recorded diff differs from the one you reviewed. Reload the review.');
  }

  private async latestRun(p: DashboardProject, task: Task): Promise<RunRecord | undefined> {
    const runId = task.currentRunId ?? [...task.results].reverse().find((r) => r.runId !== undefined)?.runId;
    if (runId === undefined) return undefined;
    return p.runs.load(runId).catch(() => undefined);
  }
}

/**
 * A runner creates a run's directory a moment before its autorun.json appears,
 * so a read at exactly that time fails. Retry such a read briefly instead of
 * showing a transient error (the runner itself only reads under its lock).
 */
async function settledRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (attempt >= 5 || !/does not exist/.test(describeError(err))) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID.test(taskId)) throw new ValidationError('Invalid task id.');
}

/** Dependencies that are not completed yet, with their status: why a task cannot start. */
function blockers(task: Task, tasks: readonly Task[]): { id: string; status: string }[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  return task.dependencies
    .map((id) => ({ id, status: byId.get(id)?.status ?? 'missing' }))
    .filter((d) => d.status !== 'completed');
}

function lastActivity(tasks: readonly Task[], record: AutoRunRecord | undefined): string | null {
  let latest = record?.updatedAt ?? '';
  for (const t of tasks) {
    for (const r of t.results) {
      if (r.finishedAt > latest) latest = r.finishedAt;
      if (r.review && r.review.reviewedAt > latest) latest = r.review.reviewedAt;
    }
  }
  return latest === '' ? null : latest;
}

function classifyEvent(type: string, message: string): { kind: string; severity: 'info' | 'warning' | 'error' } {
  if (/cost-limit|budget/i.test(message)) return { kind: 'budget', severity: 'warning' };
  switch (type) {
    case 'start':
    case 'resume':
    case 'complete':
      return { kind: 'run', severity: 'info' };
    case 'pause':
    case 'stop':
      return { kind: 'run', severity: /task-failed|needs-attention|safety-gate|error|interrupted/.test(message) ? 'error' : 'info' };
    case 'recover':
    case 'interrupted':
      return { kind: 'recovery', severity: 'warning' };
    case 'repair':
      return { kind: 'validation', severity: 'warning' };
    case 'task':
      return { kind: 'task', severity: / failed: /.test(message) ? 'error' : 'info' };
    case 'accept':
    case 'review':
      return { kind: 'decision', severity: 'info' };
    case 'warning':
      return { kind: 'warning', severity: 'warning' };
    default:
      return { kind: type.replace(/[^a-z-]/g, '') || 'event', severity: 'info' };
  }
}

function lockText(lock: LockState): string {
  if (lock.state === 'unreadable') return 'The project lock file is unreadable; see "Recovery procedures" in the README.';
  if (lock.state !== 'held') return '';
  if (lock.owner === 'dead') return `A factory process (pid ${lock.info.pid}) exited without releasing the lock. Run "recover" from CMD first.`;
  return `Another factory process (pid ${lock.info.pid}, "${clean(lock.info.command, 80)}") is working on this project.`;
}

function lockView(lock: LockState) {
  if (lock.state === 'held') return { state: 'held', pid: lock.info.pid, command: clean(lock.info.command, 80) ?? '', since: lock.info.acquiredAt, owner: lock.owner };
  return { state: lock.state };
}

/** Messages of the factory's own errors are safe to show (redacted); anything else is not. */
export function safeMessage(err: unknown): string {
  if (err instanceof FactoryError) return clean(err.message, 4000) ?? '';
  return 'Internal error (details are in the dashboard console window).';
}

/** Whether a bare executable name resolves on PATH. Checks files only; nothing is executed. */
export async function findOnPath(executable: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(executable)) return false;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.length > 0)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const ok = await stat(path.join(dir, executable + ext)).then((s) => s.isFile(), () => false);
      if (ok) return true;
    }
  }
  return false;
}

