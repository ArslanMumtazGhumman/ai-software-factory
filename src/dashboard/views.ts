import type { FactoryConfig } from '../config/factoryConfig.js';
import type { AutoRunExecution, AutoRunRecord } from '../persistence/autoRunStore.js';
import type { AgentEvidence, RunRecord, ValidationEvidence } from '../persistence/runStore.js';
import { redactSecrets } from '../security/redact.js';
import type { Task } from '../tasks/task.js';
import type { Eligibility } from '../tasks/taskSelector.js';

/**
 * Builders for what the dashboard API returns. Everything is derived from the
 * factory's own records and passed through secret redaction again. Raw agent
 * output (stdout/stderr) and environment details are never included; check
 * output is limited to a redacted tail.
 */

export const OUTPUT_TAIL_CHARS = 4000;
const SUMMARY_CHARS = 8000;

export function clean(text: string | undefined, max = SUMMARY_CHARS): string | undefined {
  if (text === undefined) return undefined;
  const redacted = redactSecrets(text);
  return redacted.length > max ? `${redacted.slice(0, max)}\n[... ${redacted.length - max} characters omitted ...]` : redacted;
}

export function tailOf(text: string, max = OUTPUT_TAIL_CHARS): string {
  const redacted = redactSecrets(text);
  return redacted.length > max ? `[... ${redacted.length - max} characters omitted ...]\n${redacted.slice(-max)}` : redacted;
}

/** Configuration a person may see. Environment variable names and values are left out. */
export function configView(config: FactoryConfig) {
  const { agent, execution, autonomy, limits } = config;
  return {
    projectRoot: config.projectRoot,
    dataDir: config.dataDir,
    limits,
    allowedExecutables: config.allowedExecutables,
    commands: Object.entries(config.commands).map(([name, spec]) => ({
      name,
      command: [spec.executable, ...spec.args].join(' '),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      timeoutMs: spec.timeoutMs ?? limits.commandTimeoutMs,
    })),
    agent: {
      type: agent.type,
      executable: agent.executable,
      model: agent.model ?? null,
      permissionMode: agent.permissionMode,
      tools: agent.tools,
      allowedTools: agent.allowedTools,
      maxBudgetUsd: agent.maxBudgetUsd ?? null,
      passEnvCount: agent.passEnv.length,
    },
    execution,
    autonomy,
  };
}

export function agentView(agent: AgentEvidence | undefined) {
  if (agent === undefined) return null;
  return {
    outcome: agent.outcome,
    exitCode: agent.exitCode,
    timedOut: agent.timedOut,
    durationMs: agent.durationMs,
    costUsd: agent.costUsd ?? null,
    numTurns: agent.numTurns ?? null,
    permissionDenials: agent.permissionDenials ?? null,
    summary: clean(agent.summary) ?? '',
    error: clean(agent.error) ?? null,
  };
}

export function validationView(v: ValidationEvidence, withOutput = true) {
  return {
    name: v.name,
    command: [v.executable, ...v.args].join(' '),
    exitCode: v.exitCode,
    timedOut: v.timedOut,
    durationMs: v.durationMs,
    passed: v.exitCode === 0 && !v.timedOut,
    error: clean(v.error) ?? null,
    ...(withOutput ? { outputTail: tailOf(`${v.stdout}${v.stderr}`.trim()), truncated: v.truncated } : {}),
  };
}

/** Best description of where an execution is, from its last saved record. */
export function stageOf(run: RunRecord): string {
  switch (run.state) {
    case 'preparing':
      return 'preparing worktree';
    case 'running': {
      const repairs = run.repairs?.length ?? 0;
      if (run.agent === undefined) return 'agent working';
      return repairs > 0 ? `repair attempt ${repairs}` : 'validating and reviewing';
    }
    case 'awaiting_review':
      return 'awaiting human review';
    default:
      return run.state;
  }
}

/** Sanitized evidence of one supervised execution. */
export function runView(run: RunRecord) {
  const calls = [run.agent, ...(run.repairs ?? []).map((r) => r.agent)].filter((a) => a !== undefined);
  return {
    runId: run.runId,
    taskId: run.taskId,
    state: run.state,
    stage: stageOf(run),
    outcome: run.outcome ?? null,
    failureReason: clean(run.failureReason) ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    baseCommit: run.baseCommit,
    branch: run.branch ?? null,
    worktreePath: run.worktreePath ?? null,
    acceptedCommit: run.acceptedCommit ?? null,
    autoRunId: run.autoRunId ?? null,
    agent: agentView(run.agent),
    validation: (run.validation ?? []).map((v) => validationView(v)),
    repairs: (run.repairs ?? []).map((r) => ({
      attempt: r.attempt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      failedChecks: r.failedValidation.map((v) => validationView(v, false)),
      agent: agentView(r.agent),
    })),
    review:
      run.review === undefined
        ? null
        : {
            changedFiles: run.review.changedFiles,
            findings: run.review.findings.map((f) => ({ ...f, message: clean(f.message) ?? '' })),
            diffBytes: run.review.diffBytes,
            diffSha256: run.review.diffSha256,
            ignoredFiles: run.review.ignoredFiles.length,
          },
    decision: run.decision === undefined ? null : { ...run.decision, reason: clean(run.decision.reason) ?? null },
    cost: {
      estimatedUsd: calls.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
      incomplete: calls.some((a) => a.costUsd === undefined),
      agentCalls: calls.length,
    },
  };
}

export function taskView(task: Task, eligibility: Eligibility) {
  const latest = task.results[task.results.length - 1];
  return {
    id: task.id,
    title: task.title,
    description: clean(task.description, 50_000) ?? '',
    acceptanceCriteria: task.acceptanceCriteria,
    dependencies: task.dependencies,
    status: task.status,
    retryCount: task.retryCount,
    currentRunId: task.currentRunId ?? null,
    eligible: eligibility.eligible,
    /** Why the task can (not) start now. */
    eligibility: eligibility.reason,
    attempts: task.results.length,
    latestResult:
      latest === undefined
        ? null
        : {
            attempt: latest.attempt,
            outcome: latest.outcome,
            finishedAt: latest.finishedAt,
            summary: clean(latest.summary, 2000) ?? '',
            error: clean(latest.error, 2000) ?? null,
            runId: latest.runId ?? null,
            review: latest.review === undefined ? null : { ...latest.review, reason: clean(latest.review.reason) ?? null },
          },
  };
}

export function taskResultsView(task: Task) {
  return task.results.map((r) => ({
    attempt: r.attempt,
    outcome: r.outcome,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    summary: clean(r.summary, 2000) ?? '',
    error: clean(r.error, 2000) ?? null,
    runId: r.runId ?? null,
    review: r.review === undefined ? null : { ...r.review, reason: clean(r.review.reason) ?? null },
  }));
}

/**
 * Cost of an autonomous run as the factory measured it: the sum of
 * `total_cost_usd` values Claude Code reported. It is an estimate, not a bill,
 * and incomplete when any call did not report its cost.
 */
export function budgetView(record: AutoRunRecord, perCallUsd: number | undefined) {
  const cap = record.limits.maxCostUsd;
  const remaining = cap === undefined || record.costUnknown ? null : Math.max(0, cap - record.costUsd);
  return {
    kind: 'estimate' as const,
    label: 'Estimated cost reported by Claude Code (not an actual charge)',
    estimatedUsd: record.costUsd,
    incomplete: record.costUnknown,
    runCapUsd: cap ?? null,
    perCallCapUsd: perCallUsd ?? null,
    remainingUsd: remaining,
    note:
      cap === undefined
        ? 'No run cost cap is configured (autonomy.maxCostUsd).'
        : record.costUnknown
          ? 'At least one agent call did not report its cost, so the remaining budget cannot be measured. The run stops before starting another task.'
          : 'Remaining = run cap minus reported cost. Another call only starts when the remainder covers a full per-call cap.',
    guarantee: 'Not a hard spending guarantee: limits rely on Claude Code honouring --max-budget-usd and on its self-reported usage.',
  };
}

export function executionView(entry: AutoRunExecution, run: RunRecord | undefined) {
  const started = Date.parse(entry.startedAt);
  const finished = entry.finishedAt !== undefined ? Date.parse(entry.finishedAt) : undefined;
  return {
    taskId: entry.taskId,
    runId: entry.runId ?? null,
    result: entry.result,
    taskStatus: entry.taskStatus ?? null,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt ?? null,
    durationMs: finished !== undefined && Number.isFinite(started) ? finished - started : null,
    agentExitCode: entry.agentExitCode ?? null,
    agentTimedOut: entry.agentTimedOut ?? false,
    validation: entry.validation ?? [],
    repairs: entry.repairs,
    costUsd: entry.costUsd ?? null,
    branch: entry.branch ?? null,
    worktreePath: entry.worktreePath ?? null,
    baseCommit: entry.baseCommit ?? null,
    acceptedCommit: entry.acceptedCommit ?? null,
    failureReason: clean(entry.failureReason) ?? null,
    reviewReasons: (entry.reviewReasons ?? []).map((r) => clean(r) ?? ''),
    run: run === undefined ? null : runView(run),
  };
}

/** Live active time (the segment in progress is only persisted when it ends). */
export function activeMsOf(record: AutoRunRecord, now: number): number {
  const segment = record.segments[record.segments.length - 1];
  if (record.state !== 'running' || segment === undefined || segment.endedAt !== undefined) return record.activeMs;
  return record.activeMs + Math.max(0, now - Date.parse(segment.startedAt));
}

export function runSummaryView(record: AutoRunRecord, now: number) {
  return {
    autoRunId: record.autoRunId,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt ?? null,
    currentTask: record.currentTask ?? null,
    lastCompletedTask: record.lastCompletedTask ?? null,
    stop: record.stop === undefined ? null : { ...record.stop, message: clean(record.stop.message) ?? '' },
    executions: record.executions.length,
    results: record.executions.map((e) => ({ taskId: e.taskId, result: e.result })),
    limits: record.limits,
    activeMs: activeMsOf(record, now),
    costUsd: record.costUsd,
    costUnknown: record.costUnknown,
  };
}
