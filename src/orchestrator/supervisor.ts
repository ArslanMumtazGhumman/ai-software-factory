import { readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafeAgentConfig } from '../agents/claudeCodeAdapter.js';
import type { AgentRunResult, CodingAgent, FailedCheck, RepairContext } from '../agents/codingAgent.js';
import type { FactoryConfig } from '../config/factoryConfig.js';
import {
  AgentExecutionDisabledError,
  ExecutionPolicyError,
  FactoryError,
  GitIsolationError,
  InvalidTransitionError,
  LockHeldError,
  TamperDetectedError,
  TaskNotFoundError,
  ValidationError,
  describeError,
} from '../core/errors.js';
import { GitWorkspace } from '../git/gitWorkspace.js';
import { FileLock, type LockHandle } from '../persistence/fileLock.js';
import type { ProjectRepository } from '../persistence/projectRepository.js';
import {
  RunStore,
  evidenceDigest,
  newRunId,
  sha256,
  type AgentEvidence,
  type ReviewFinding,
  type RunRecord,
  type ValidationEvidence,
} from '../persistence/runStore.js';
import type { ProjectSpec } from '../project/projectSpec.js';
import { reviewChanges } from '../review/diffReview.js';
import { isProcessAlive } from '../security/processTree.js';
import { redactSecrets } from '../security/redact.js';
import { resolveCommand, type ResolvedCommand } from '../testing/commandPolicy.js';
import { runCommand, type CommandResult } from '../testing/commandRunner.js';
import { RUN_ID, TASK_ID, type Task } from '../tasks/task.js';
import { acceptReview, recordResult, rejectReview, startTask, submitForReview } from '../tasks/taskLifecycle.js';
import { evaluateEligibility } from '../tasks/taskSelector.js';

export interface SupervisorDeps {
  config: FactoryConfig;
  repository: ProjectRepository;
  agent: CodingAgent;
  runs?: RunStore;
  lock?: FileLock;
  git?: GitWorkspace;
  runCommand?: typeof runCommand;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ExecutionReport {
  runId: string;
  task: Task;
  run: RunRecord;
}

export interface ReviewView {
  task: Task;
  run: RunRecord;
  patch: string;
  /** Integrity problems detected while loading; empty when evidence is consistent. */
  integrityProblems: string[];
}

export interface RecoveryReport {
  lock: string;
  actions: string[];
  /** Tasks left in_progress because a process that may still be working on them is alive. */
  unresolved: string[];
}

export interface ExecuteOptions {
  /** A lock the caller already holds (autonomous runner). It is verified, never acquired or released here. */
  lock?: LockHandle;
  /** Commit to build on instead of the repository HEAD (still extended with accepted dependency commits). */
  baseCommit?: string;
  /** Absolute deadline (epoch ms) for agent work on this task, including repairs. */
  deadline?: number;
  /** Autonomous run that requested this execution. */
  autoRunId?: string;
  /** Called once the run record exists and the task is in_progress. */
  onRunStarted?: (run: RunRecord) => Promise<void> | void;
}

export interface DecisionOptions {
  /** A lock the caller already holds. */
  lock?: LockHandle;
}

export interface AcceptOptions extends DecisionOptions {
  /** Set only by the autonomous runner after the auto-accept policy approved the result. */
  policyReason?: string;
}

/** Outcome of agent + checks + diff review for one attempt. */
interface Verification {
  validation: ValidationEvidence[];
  findings: ReviewFinding[];
  snapshot: Awaited<ReturnType<GitWorkspace['snapshot']>>;
  failureReason?: string;
  /** Only failed checks with a clean diff review may be repaired. */
  repairable: boolean;
}

/** Below this much remaining task time, no new agent invocation is started. */
const MIN_AGENT_TIME_MS = 10_000;

const OUTPUT_TAIL = 16 * 1024;
const DATA_DIR_GITIGNORE = [
  '# Managed by AI Software Factory: local execution state.',
  'factory.lock',
  'stale-locks/',
  'runs/',
  'worktrees/',
  'autoruns/',
  '.*.tmp',
  '',
].join('\n');

function tail(text: string, max = OUTPUT_TAIL): string {
  return text.length > max ? `[... ${text.length - max} characters omitted ...]\n${text.slice(-max)}` : text;
}

/**
 * Supervised, single-task execution with a human review gate.
 *
 *   execute <task>  lock -> validate -> git preflight -> base (HEAD + accepted dependencies)
 *                   -> worktree -> in_progress -> agent -> snapshot -> validation commands
 *                   -> diff review [-> bounded repairs] -> awaiting_review | failed / needs_attention
 *   accept/reject   lock -> integrity checks -> commit reviewed tree on the run branch -> completed
 *                   | failed
 *   recover         releases a dead owner's lock and fails interrupted runs
 *
 * Only the run's own `asf/...` branch ever receives a commit. Nothing is merged
 * into user branches, pushed, deployed or deleted. Worktrees and branches are
 * always kept for inspection.
 */
export class Supervisor {
  private readonly runs: RunStore;
  private readonly lock: FileLock;
  private readonly git: GitWorkspace;
  private readonly run: typeof runCommand;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: SupervisorDeps) {
    const { config } = deps;
    this.runs = deps.runs ?? new RunStore(config.dataDir);
    this.lock = deps.lock ?? new FileLock(config.dataDir);
    this.git = deps.git ?? new GitWorkspace(config.projectRoot, config.dataDir);
    this.run = deps.runCommand ?? runCommand;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  // ---------------------------------------------------------------- execute

  /** Policy checks that must pass before any execution starts; returns the resolved validation commands. */
  assertExecutionPolicy(): ResolvedCommand[] {
    const { config } = this.deps;
    if (!config.execution.enabled) {
      throw new AgentExecutionDisabledError(
        'Supervised execution is disabled. Set "execution": { "enabled": true, "validationCommands": [...] } in the factory config.',
      );
    }
    assertSafeAgentConfig(config.agent);
    if (config.execution.validationCommands.length === 0) {
      throw new ExecutionPolicyError('config.execution.validationCommands must name at least one configured command.');
    }
    // Allowlist enforcement happens up front so a bad config never starts a run.
    return config.execution.validationCommands.map((name) => resolveCommand(config, name));
  }

  async execute(taskId: string, options: ExecuteOptions = {}): Promise<ExecutionReport> {
    const validation = this.assertExecutionPolicy();
    if (!TASK_ID.test(taskId)) throw new ValidationError(`Invalid task id "${taskId}"`);
    return this.withLock(`execute ${taskId}`, options.lock, () => this.executeLocked(taskId, validation, options));
  }

  private async executeLocked(taskId: string, validation: ResolvedCommand[], options: ExecuteOptions): Promise<ExecutionReport> {
    const { config, repository } = this.deps;
    const [project, tasks] = await Promise.all([repository.loadProject(), repository.loadTasks()]);
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    const eligibility = evaluateEligibility(task, new Map(tasks.map((t) => [t.id, t] as const)), config.limits.maxRetries);
    if (!eligibility.eligible) throw new InvalidTransitionError(`Task "${taskId}" is not eligible: ${eligibility.reason}`);

    await this.ensureDataDirGitignore();
    const { headCommit } = await this.git.preflight();
    this.log(`Repository is clean; HEAD is ${headCommit}.`);
    const tip = options.baseCommit !== undefined ? await this.git.verifyCommit(options.baseCommit) : headCommit;
    const baseCommit = await this.resolveBase(task, tasks, tip);
    if (baseCommit !== headCommit) this.log(`Building on ${baseCommit} (includes accepted work this task depends on).`);

    const runId = newRunId(this.now());
    const run: RunRecord = {
      schemaVersion: 1,
      runId,
      taskId,
      state: 'preparing',
      factoryPid: process.pid,
      hostname: os.hostname(),
      startedAt: this.now().toISOString(),
      baseCommit,
      ...(options.autoRunId !== undefined ? { autoRunId: options.autoRunId } : {}),
    };
    await this.runs.save(run);

    try {
      const wt = await this.git.createWorktree(this.runs.worktreePath(runId), taskId, runId, baseCommit);
      run.branch = wt.branch;
      run.worktreePath = wt.path;
    } catch (err) {
      run.state = 'failed';
      run.outcome = 'failure';
      run.failureReason = `Worktree creation failed: ${describeError(err)}`;
      run.finishedAt = this.now().toISOString();
      await this.runs.save(run);
      throw err;
    }
    this.log(`Isolated worktree: ${run.worktreePath} (branch ${run.branch}).`);

    run.state = 'running';
    await this.runs.save(run);
    const started = startTask(task, runId);
    await repository.saveTasks(tasks.map((t) => (t.id === taskId ? started : t)));
    this.log(`Task ${taskId} marked in_progress (run ${runId}).`);

    try {
      await options.onRunStarted?.(run);
      return await this.runAgentAndVerify(project, started, run, validation, options.deadline);
    } catch (err) {
      await this.recordUnexpectedFailure(run, err);
      throw err;
    }
  }

  /**
   * Base commit for a task: `tip`, moved forward to include the accepted
   * (factory-committed) work of every dependency. Refuses when a dependency's
   * accepted work has diverged from the base, because the result would not
   * contain the code it depends on.
   */
  async resolveBase(task: Task, tasks: readonly Task[], tip: string): Promise<string> {
    let base = tip;
    for (const depId of task.dependencies) {
      const dep = tasks.find((t) => t.id === depId);
      const commit = dep === undefined ? undefined : await this.acceptedCommitOf(dep);
      if (commit === undefined) {
        this.log(`Note: dependency ${depId} has no factory commit (completed manually or before commits were recorded); assuming its changes are in ${base}.`);
        continue;
      }
      if (await this.git.isAncestor(commit, base)) continue;
      if (await this.git.isAncestor(base, commit)) {
        base = commit;
        continue;
      }
      throw new GitIsolationError(
        `Accepted work of dependency ${depId} (commit ${commit}) is not in base ${base} and has diverged from it. ` +
          'Merge the factory branches into your branch yourself, then try again.',
      );
    }
    return base;
  }

  /** Commit recorded when the task's latest accepted supervised result was accepted, if any. */
  async acceptedCommitOf(task: Task): Promise<string | undefined> {
    if (task.status !== 'completed') return undefined;
    const accepted = [...task.results].reverse().find((r) => r.review?.decision === 'accepted' && r.runId !== undefined);
    if (accepted?.runId === undefined) return undefined;
    try {
      return (await this.runs.load(accepted.runId)).acceptedCommit;
    } catch {
      return undefined;
    }
  }

  private async invokeAgent(
    project: ProjectSpec,
    task: Task,
    run: RunRecord,
    deadline: number | undefined,
    repair?: RepairContext,
  ): Promise<AgentRunResult> {
    const { agent } = this.deps;
    const worktree = run.worktreePath!;
    const plan = agent.plan({ project, task, workingDirectory: worktree, ...(repair !== undefined ? { repair } : {}) });
    if (deadline !== undefined) {
      const remaining = deadline - this.now().getTime();
      if (remaining < MIN_AGENT_TIME_MS) {
        return { outcome: 'failure', summary: 'Task time budget (autonomy.maxTaskDurationMs) exhausted before the agent could start' };
      }
      plan.timeoutMs = Math.min(plan.timeoutMs, remaining);
    }

    let pendingSave: Promise<void> = Promise.resolve();
    this.log(`Running ${agent.name}${repair ? ` (repair ${repair.attempt}/${repair.maxAttempts})` : ''} in ${worktree} (timeout ${plan.timeoutMs} ms)...`);
    let agentResult: AgentRunResult;
    try {
      agentResult = await agent.execute(plan, {
        onSpawn: (pid) => {
          run.agentPid = pid;
          pendingSave = pendingSave.then(() => this.runs.save(run)).catch(() => undefined);
        },
      });
    } catch (err) {
      agentResult = { outcome: 'failure', summary: 'Coding agent raised an unexpected error', error: describeError(err) };
    }
    await pendingSave;
    this.log(`Agent finished: ${agentResult.outcome} (${redactSecrets(agentResult.summary.split('\n')[0]?.slice(0, 120) ?? '')}).`);
    return agentResult;
  }

  private async runAgentAndVerify(
    project: ProjectSpec,
    task: Task,
    run: RunRecord,
    validation: ResolvedCommand[],
    deadline: number | undefined,
  ): Promise<ExecutionReport> {
    const { config } = this.deps;
    const worktree = run.worktreePath!;
    const maxRepairs = config.execution.maxRepairAttempts;

    let agentResult = await this.invokeAgent(project, task, run, deadline);
    run.agent = toAgentEvidence(agentResult);
    let verification = await this.verify(run, agentResult, validation);
    let repairNote = '';

    // Bounded repair loop: only failed checks with a clean diff review, never more than maxRepairAttempts.
    for (let attempt = 1; verification.repairable && attempt <= maxRepairs; attempt++) {
      if (deadline !== undefined && deadline - this.now().getTime() < MIN_AGENT_TIME_MS) {
        repairNote = '; repair stopped: task time budget exhausted';
        break;
      }
      const failed = verification.validation.filter(isFailedCheck);
      const startedAt = this.now().toISOString();
      run.repairs = run.repairs ?? [];
      await this.runs.save(run);
      this.log(`Validation failed; starting repair attempt ${attempt} of ${maxRepairs}.`);
      agentResult = await this.invokeAgent(project, task, run, deadline, {
        attempt,
        maxAttempts: maxRepairs,
        failures: failed.map(toFailedCheck),
      });
      run.repairs.push({ attempt, startedAt, finishedAt: this.now().toISOString(), failedValidation: failed, agent: toAgentEvidence(agentResult) });
      verification = await this.verify(run, agentResult, validation);
    }
    const repairsUsed = run.repairs?.length ?? 0;
    if (verification.failureReason !== undefined && repairsUsed > 0) {
      verification.failureReason += ` (after ${repairsUsed} repair attempt(s)${repairNote})`;
    } else if (verification.failureReason !== undefined && repairNote) {
      verification.failureReason += repairNote;
    }

    const { snapshot, findings, failureReason } = verification;
    const patch = redactSecrets(snapshot.patch);
    const diffSha256 = await this.runs.saveDiff(run.runId, patch);
    run.validation = verification.validation;
    run.review = {
      headCommit: snapshot.headCommit,
      treeSha: snapshot.treeSha,
      diffSha256,
      diffBytes: Buffer.byteLength(patch, 'utf8'),
      changedFiles: snapshot.changedFiles,
      ignoredFiles: snapshot.ignoredFiles.slice(0, 200),
      findings,
    };

    run.outcome = failureReason === undefined ? 'success' : 'failure';
    if (failureReason !== undefined) run.failureReason = redactSecrets(failureReason);
    run.state = failureReason === undefined ? 'awaiting_review' : 'failed';
    run.finishedAt = this.now().toISOString();
    await this.runs.save(run);
    const digest = evidenceDigest(run);

    const tasks = await this.deps.repository.loadTasks();
    const current = tasks.find((t) => t.id === task.id);
    if (current === undefined || current.status !== 'in_progress' || current.currentRunId !== run.runId) {
      throw new InvalidTransitionError(`Task "${task.id}" changed unexpectedly during run ${run.runId}`);
    }
    const base = { startedAt: run.startedAt, finishedAt: run.finishedAt, runId: run.runId, evidenceDigest: digest };
    const updated =
      run.failureReason === undefined
        ? submitForReview(current, { ...base, summary: redactSecrets(agentResult.summary) })
        : recordResult(
            current,
            {
              ...base,
              outcome: 'failure',
              summary: run.failureReason,
              ...(agentResult.error !== undefined ? { error: redactSecrets(agentResult.error) } : {}),
            },
            config.limits.maxRetries,
          );
    await this.deps.repository.saveTasks(tasks.map((t) => (t.id === task.id ? updated : t)));
    this.log(`Task ${task.id} is now "${updated.status}". Worktree preserved at ${worktree}.`);
    return { runId: run.runId, task: updated, run };
  }

  /** Snapshot, run the configured checks (only after a successful agent run) and review the diff. */
  private async verify(run: RunRecord, agentResult: AgentRunResult, validation: ResolvedCommand[]): Promise<Verification> {
    const { config } = this.deps;
    const worktree = run.worktreePath!;
    let snapshot = await this.git.snapshot(worktree, run.baseCommit);
    const extraFindings: ReviewFinding[] = [];
    const validationEvidence: ValidationEvidence[] = [];
    if (agentResult.outcome === 'success') {
      for (const command of validation) {
        this.log(`Validation: ${command.name} (${command.executable} ${command.args.join(' ')})...`);
        const result = await this.run({ ...command, cwd: worktree });
        validationEvidence.push(toValidationEvidence(command, result));
        this.log(`Validation: ${command.name} exit ${result.exitCode ?? 'n/a'}${result.timedOut ? ' (timed out)' : ''}.`);
      }
      const after = await this.git.snapshot(worktree, run.baseCommit);
      if (after.treeSha !== snapshot.treeSha) {
        extraFindings.push({
          severity: 'violation',
          rule: 'validation-modified-worktree',
          message: 'Validation commands changed non-ignored files in the worktree.',
        });
      }
      snapshot = after;
    }
    if (snapshot.headCommit !== run.baseCommit) {
      extraFindings.push({ severity: 'violation', rule: 'head-moved', message: `Worktree HEAD moved to ${snapshot.headCommit}.` });
    }

    const findings = [
      ...reviewChanges({
        changedFiles: snapshot.changedFiles,
        patch: snapshot.patch,
        ignoredFiles: snapshot.ignoredFiles,
        dataDirRel: this.git.dataDirRel,
        policy: { ...config.execution, protectedPaths: [...config.execution.protectedPaths, ...configFileProtection(config)] },
      }),
      ...extraFindings,
    ];

    const violations = findings.filter((f) => f.severity === 'violation');
    const failedChecks = validationEvidence.filter(isFailedCheck);
    let failureReason: string | undefined;
    if (agentResult.outcome !== 'success') failureReason = `Agent failed: ${agentResult.summary}`;
    else if (failedChecks.length > 0) failureReason = `Validation failed: ${failedChecks.map((v) => `${v.name} (exit ${v.exitCode ?? 'n/a'})`).join(', ')}`;
    else if (violations.length > 0) failureReason = `Diff review found ${violations.length} violation(s): ${[...new Set(violations.map((v) => v.rule))].join(', ')}`;
    // A check whose process tree could not be stopped, or any policy violation, is never repaired.
    const repairable =
      agentResult.outcome === 'success' && failedChecks.length > 0 && violations.length === 0 && !failedChecks.some((v) => v.killFailed);
    return {
      validation: validationEvidence,
      findings,
      snapshot,
      repairable,
      ...(failureReason !== undefined ? { failureReason } : {}),
    };
  }

  /** Best effort: never leave a task in_progress after an in-process error. */
  private async recordUnexpectedFailure(run: RunRecord, err: unknown): Promise<void> {
    run.state = 'failed';
    run.outcome = 'failure';
    run.failureReason = `Unexpected error: ${redactSecrets(describeError(err))}`;
    run.finishedAt = this.now().toISOString();
    try {
      await this.runs.save(run);
      const tasks = await this.deps.repository.loadTasks();
      const current = tasks.find((t) => t.id === run.taskId);
      if (current?.status === 'in_progress' && current.currentRunId === run.runId) {
        const updated = recordResult(
          current,
          {
            outcome: 'failure',
            summary: run.failureReason,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            runId: run.runId,
            evidenceDigest: evidenceDigest(run),
          },
          this.deps.config.limits.maxRetries,
        );
        await this.deps.repository.saveTasks(tasks.map((t) => (t.id === run.taskId ? updated : t)));
        this.log(`Recorded failure for ${run.taskId}: ${run.failureReason}`);
      }
    } catch (recordErr) {
      this.log(
        `Could not record the failure (${describeError(recordErr)}). Task ${run.taskId} may still be in_progress; run "recover".`,
      );
    }
  }

  // ----------------------------------------------------------------- review

  async review(taskId: string): Promise<ReviewView> {
    const tasks = await this.deps.repository.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    const runId = task.currentRunId ?? [...task.results].reverse().find((r) => r.runId !== undefined)?.runId;
    if (runId === undefined) throw new InvalidTransitionError(`Task "${taskId}" has no supervised execution runs.`);
    const run = await this.runs.load(runId);
    let patch = '';
    const integrityProblems: string[] = [];
    try {
      patch = await this.runs.loadDiff(runId);
      if (run.review && sha256(patch) !== run.review.diffSha256) integrityProblems.push('diff.patch does not match the recorded diff hash');
    } catch (err) {
      integrityProblems.push(`diff unavailable: ${describeError(err)}`);
    }
    const result = task.results.find((r) => r.runId === runId);
    if (result?.evidenceDigest !== undefined && result.evidenceDigest !== evidenceDigest(run)) {
      integrityProblems.push('run.json no longer matches the evidence digest recorded in tasks.json');
    }
    return { task, run, patch, integrityProblems };
  }

  /**
   * Accept a reviewed result after verifying nothing changed since review, then
   * commit exactly the reviewed tree on the run's own factory branch so
   * dependants can build on it. No user branch is merged, reset or pushed.
   */
  async accept(taskId: string, options: AcceptOptions = {}): Promise<ExecutionReport> {
    return this.withLock(`accept ${taskId}`, options.lock, async () => {
      const { task, tasks, run } = await this.loadReviewTarget(taskId);
      const problems = await this.verifyReviewedState(task, run);
      if (problems.length > 0) throw new TamperDetectedError(problems);
      const by = options.policyReason !== undefined ? 'policy' : 'human';
      const message = [
        `[asf] ${task.id}: ${task.title.replace(/\s+/g, ' ').slice(0, 120)}`,
        '',
        `Run: ${run.runId}`,
        `Accepted-by: ${by}`,
        '',
      ].join('\n');
      const commit = await this.git.commitReviewed(run.worktreePath!, run.branch!, run.review!.treeSha, run.review!.headCommit, message);
      const reviewedAt = this.now().toISOString();
      const updated =
        options.policyReason !== undefined
          ? acceptReview(task, reviewedAt, { by: 'policy', reason: redactSecrets(options.policyReason) })
          : acceptReview(task, reviewedAt);
      run.state = 'accepted';
      run.acceptedCommit = commit;
      run.decision = {
        decision: 'accepted',
        at: reviewedAt,
        by,
        ...(options.policyReason !== undefined ? { reason: redactSecrets(options.policyReason) } : {}),
      };
      await this.runs.save(run);
      await this.deps.repository.saveTasks(tasks.map((t) => (t.id === taskId ? updated : t)));
      this.log(`Accepted ${taskId}; reviewed tree committed as ${commit} on ${run.branch}.`);
      return { runId: run.runId, task: updated, run };
    });
  }

  async reject(taskId: string, reason: string, options: DecisionOptions = {}): Promise<ExecutionReport> {
    if (reason.trim().length === 0) throw new ValidationError('A rejection reason is required.');
    return this.withLock(`reject ${taskId}`, options.lock, async () => {
      const { task, tasks, run } = await this.loadReviewTarget(taskId);
      const reviewedAt = this.now().toISOString();
      const updated = rejectReview(task, redactSecrets(reason), reviewedAt, this.deps.config.limits.maxRetries);
      run.state = 'rejected';
      run.decision = { decision: 'rejected', at: reviewedAt, reason: redactSecrets(reason), by: 'human' };
      await this.runs.save(run);
      await this.deps.repository.saveTasks(tasks.map((t) => (t.id === taskId ? updated : t)));
      return { runId: run.runId, task: updated, run };
    });
  }

  private async loadReviewTarget(taskId: string): Promise<{ task: Task; tasks: Task[]; run: RunRecord }> {
    if (!TASK_ID.test(taskId)) throw new ValidationError(`Invalid task id "${taskId}"`);
    const tasks = await this.deps.repository.loadTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (task.status !== 'awaiting_review' || task.currentRunId === undefined) {
      throw new InvalidTransitionError(`Task "${taskId}" is not awaiting review (status "${task.status}").`);
    }
    return { task, tasks, run: await this.runs.load(task.currentRunId) };
  }

  /** Everything that must still match what was reviewed before a result may be accepted. */
  private async verifyReviewedState(task: Task, run: RunRecord): Promise<string[]> {
    const problems: string[] = [];
    const result = task.results[task.results.length - 1];
    if (result?.runId !== run.runId || result.evidenceDigest === undefined) {
      problems.push('tasks.json has no evidence digest for this run');
    } else if (result.evidenceDigest !== evidenceDigest(run)) {
      problems.push('run.json changed since the result was recorded (evidence digest mismatch)');
    }
    if (run.taskId !== task.id) problems.push(`run belongs to task ${run.taskId}`);
    if (run.state !== 'awaiting_review' || run.outcome !== 'success' || run.review === undefined) {
      problems.push(`run is in state "${run.state}" with outcome "${run.outcome ?? 'none'}"`);
      return problems;
    }
    const expectedPath = this.runs.worktreePath(run.runId);
    if (run.worktreePath === undefined || path.resolve(run.worktreePath) !== path.resolve(expectedPath)) {
      problems.push(`worktree path ${run.worktreePath ?? '(none)'} is not the factory-managed path ${expectedPath}`);
      return problems;
    }
    try {
      const patch = await this.runs.loadDiff(run.runId);
      if (sha256(patch) !== run.review.diffSha256) problems.push('diff.patch changed since review');
    } catch (err) {
      problems.push(`diff.patch unavailable: ${describeError(err)}`);
    }
    try {
      const snapshot = await this.git.snapshot(expectedPath, run.baseCommit);
      if (snapshot.treeSha !== run.review.treeSha) problems.push('worktree content changed since review (tree hash mismatch)');
      if (
        snapshot.headCommit !== run.review.headCommit &&
        // An earlier accept that committed the reviewed tree but could not finish recording is not tampering.
        !(await this.git.isCommitOf(expectedPath, snapshot.headCommit, run.review.treeSha, run.review.headCommit))
      ) {
        problems.push(`worktree HEAD moved to ${snapshot.headCommit}`);
      }
    } catch (err) {
      problems.push(`worktree could not be verified: ${describeError(err)}`);
    }
    return problems;
  }

  // ---------------------------------------------------------------- recover

  /**
   * Distinguish a genuinely running execution from an interrupted one:
   * a live lock owner means "running" and nothing is touched. Only when the
   * owner is confirmed dead (or no lock exists) are in_progress runs failed.
   */
  async recover(): Promise<RecoveryReport> {
    const state = await this.lock.inspect();
    let lockAction = 'no lock was held';
    if (state.state === 'unreadable') {
      throw new LockHeldError(`Lock file ${this.lock.lockPath} is unreadable (${state.detail}). Confirm no factory process is running, then move it away manually.`);
    }
    if (state.state === 'held') {
      if (state.owner === 'alive') {
        throw new LockHeldError(
          `A factory process is still running (pid ${state.info.pid}, "${state.info.command}" since ${state.info.acquiredAt}). Nothing was changed.`,
        );
      }
      if (state.owner === 'unknown-host') {
        throw new LockHeldError(`The lock is owned by host ${state.info.hostname}; its liveness cannot be checked from here. Nothing was changed.`);
      }
      const archive = await this.lock.breakStaleLock();
      lockAction = `stale lock from dead pid ${state.info.pid} archived to ${archive}`;
    }

    return this.withLock('recover', undefined, async (handle) => ({ lock: lockAction, ...(await this.reconcileInterrupted(handle)) }));
  }

  /**
   * With the lock held: fail executions whose process is gone, and leave alone
   * (reporting them as unresolved) any whose agent or factory process is alive.
   */
  async reconcileInterrupted(handle: LockHandle): Promise<{ actions: string[]; unresolved: string[] }> {
    await this.lock.assertHeld(handle.info);
    const actions: string[] = [];
    const unresolved: string[] = [];
    const tasks = await this.deps.repository.loadTasks();
    let changed = false;
    const updatedTasks: Task[] = [];
    const referenced = new Set<string>();
    for (const task of tasks) {
      if (task.status !== 'in_progress') {
        updatedTasks.push(task);
        continue;
      }
      if (task.currentRunId === undefined) {
        actions.push(`${task.id}: in_progress without an execution run (set manually); left unchanged`);
        updatedTasks.push(task);
        continue;
      }
      referenced.add(task.currentRunId);
      let run: RunRecord | undefined;
      try {
        run = await this.runs.load(task.currentRunId);
      } catch (err) {
        actions.push(`${task.id}: run record unreadable (${describeError(err)}); treating as interrupted`);
      }
      if (run?.agentPid !== undefined && isProcessAlive(run.agentPid)) {
        actions.push(
          `${task.id}: agent process ${run.agentPid} is still alive; stop it (taskkill /PID ${run.agentPid} /T /F) and run recover again. Left unchanged.`,
        );
        unresolved.push(task.id);
        updatedTasks.push(task);
        continue;
      }
      if (run !== undefined && run.hostname === os.hostname() && run.factoryPid !== process.pid && isProcessAlive(run.factoryPid)) {
        actions.push(
          `${task.id}: factory pid ${run.factoryPid} that started the run is alive but does not hold the lock (possible pid reuse). Left unchanged; retry after confirming that process is not the factory.`,
        );
        unresolved.push(task.id);
        updatedTasks.push(task);
        continue;
      }
      const at = this.now().toISOString();
      const reason = 'Execution interrupted: the factory process exited before recording a result.';
      if (run !== undefined) {
        run.state = 'interrupted';
        run.outcome = 'failure';
        run.failureReason = reason;
        run.finishedAt = run.finishedAt ?? at;
        run.decision = { decision: 'interrupted', at };
        await this.runs.save(run);
      }
      const updated = recordResult(
        task,
        {
          outcome: 'failure',
          summary: reason,
          startedAt: run?.startedAt ?? at,
          finishedAt: at,
          runId: task.currentRunId,
          ...(run !== undefined ? { evidenceDigest: evidenceDigest(run) } : {}),
        },
        this.deps.config.limits.maxRetries,
      );
      updatedTasks.push(updated);
      changed = true;
      actions.push(`${task.id}: marked "${updated.status}" (interrupted run ${task.currentRunId}; worktree preserved)`);
    }
    if (changed) await this.deps.repository.saveTasks(updatedTasks);

    // Runs that never reached in_progress (crash between steps).
    for (const runId of await this.listRunIds()) {
      if (referenced.has(runId)) continue;
      let run: RunRecord;
      try {
        run = await this.runs.load(runId);
      } catch {
        continue;
      }
      if (run.state === 'preparing' || run.state === 'running') {
        const owner = tasks.find((t) => t.id === run.taskId);
        if (owner?.currentRunId === runId) continue;
        run.state = 'interrupted';
        run.failureReason = run.failureReason ?? 'Execution interrupted before the task was updated.';
        run.finishedAt = run.finishedAt ?? this.now().toISOString();
        await this.runs.save(run);
        actions.push(`run ${runId}: marked interrupted (task ${run.taskId} was not changed)`);
      }
    }
    if (actions.length === 0) actions.push('No interrupted executions found.');
    return { actions, unresolved };
  }

  private async listRunIds(): Promise<string[]> {
    try {
      return (await readdir(this.runs.runsDir)).filter((name) => RUN_ID.test(name));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Run `fn` under the lock: a caller-held lock is verified, otherwise one is acquired and released. */
  private async withLock<T>(command: string, held: LockHandle | undefined, fn: (handle: LockHandle) => Promise<T>): Promise<T> {
    if (held !== undefined) {
      await this.lock.assertHeld(held.info);
      return fn(held);
    }
    const handle = await this.lock.acquire(command);
    try {
      return await fn(handle);
    } finally {
      await this.release(handle);
    }
  }

  private async release(handle: { release(): Promise<void> }): Promise<void> {
    try {
      await handle.release();
    } catch (err) {
      this.log(`Warning: could not release lock ${this.lock.lockPath}: ${describeError(err)}`);
    }
  }

  private async ensureDataDirGitignore(): Promise<void> {
    try {
      await writeFile(path.join(this.deps.config.dataDir, '.gitignore'), DATA_DIR_GITIGNORE, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new FactoryError('PERSISTENCE_ERROR', `Cannot create ${this.deps.config.dataDir}/.gitignore: ${describeError(err)}`);
      }
    }
  }
}

/**
 * The factory config (security policy, budgets, permissions) is protected
 * whenever it lives inside the repository, so no agent change can relax it.
 */
export function configFileProtection(config: FactoryConfig): string[] {
  if (config.configFile === undefined) return [];
  const rel = path.relative(config.projectRoot, config.configFile);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return [];
  return [rel.split(path.sep).join('/')];
}

function isFailedCheck(v: ValidationEvidence): boolean {
  return v.exitCode !== 0 || v.timedOut || v.error !== undefined;
}

function toFailedCheck(v: ValidationEvidence): FailedCheck {
  return {
    name: v.name,
    command: [v.executable, ...v.args].join(' '),
    exitCode: v.exitCode,
    timedOut: v.timedOut,
    output: `${v.stdout}\n${v.stderr}`.trim(),
  };
}

function toAgentEvidence(result: AgentRunResult): AgentEvidence {
  const d = result.details;
  return {
    outcome: result.outcome,
    summary: redactSecrets(result.summary),
    ...(result.error !== undefined ? { error: redactSecrets(result.error) } : {}),
    exitCode: d?.exitCode ?? null,
    timedOut: d?.timedOut ?? false,
    durationMs: d?.durationMs ?? 0,
    truncated: d?.truncated ?? false,
    killFailed: d?.killFailed ?? false,
    ...(d?.costUsd !== undefined ? { costUsd: d.costUsd } : {}),
    ...(d?.numTurns !== undefined ? { numTurns: d.numTurns } : {}),
    ...(d?.permissionDenials !== undefined ? { permissionDenials: d.permissionDenials } : {}),
    stdout: tail(redactSecrets(d?.stdout ?? '')),
    stderr: tail(redactSecrets(d?.stderr ?? '')),
  };
}

function toValidationEvidence(command: ResolvedCommand, result: CommandResult): ValidationEvidence {
  return {
    name: command.name,
    executable: command.executable,
    args: command.args,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    truncated: result.truncated,
    killFailed: result.killFailed === true,
    ...(result.error !== undefined ? { error: result.error } : {}),
    stdout: tail(result.stdout),
    stderr: tail(result.stderr),
  };
}
