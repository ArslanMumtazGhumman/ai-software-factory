import { InvalidTransitionError } from '../core/errors.js';
import type { ExecutionOutcome, ExecutionResult, Task } from './task.js';

/**
 * Pure state transitions. Each returns a new Task and never mutates its input,
 * which keeps persistence and testing straightforward.
 */

/** Move a pending or retryable task to in_progress, optionally tagging the execution run. */
export function startTask(task: Task, runId?: string): Task {
  if (task.status !== 'pending' && task.status !== 'failed') {
    throw new InvalidTransitionError(`Cannot start task "${task.id}" from status "${task.status}"`);
  }
  return { ...withoutRun(task), status: 'in_progress', ...(runId !== undefined ? { currentRunId: runId } : {}) };
}

export interface ResultInput {
  outcome: ExecutionOutcome;
  summary: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  runId?: string;
  evidenceDigest?: string;
}

function toResult(task: Task, input: ResultInput): ExecutionResult {
  return {
    attempt: task.results.length + 1,
    outcome: input.outcome,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    summary: input.summary,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.evidenceDigest !== undefined ? { evidenceDigest: input.evidenceDigest } : {}),
  };
}

function withoutRun(task: Task): Task {
  const { currentRunId: _ignored, ...rest } = task;
  return rest;
}

function failureStatus(retryCount: number, maxRetries: number): Task['status'] {
  return retryCount > maxRetries ? 'needs_attention' : 'failed';
}

/**
 * Record the result of an attempt. Success completes the task; failure bumps
 * retryCount and moves the task to `failed`, or to `needs_attention` once
 * retries are exhausted. Clears any active run reference.
 */
export function recordResult(task: Task, input: ResultInput, maxRetries: number): Task {
  if (task.status === 'completed' || task.status === 'needs_attention' || task.status === 'awaiting_review') {
    throw new InvalidTransitionError(`Cannot record a result for task "${task.id}" in status "${task.status}"`);
  }
  const result = toResult(task, input);
  const base = withoutRun(task);
  if (input.outcome === 'success') {
    return { ...base, status: 'completed', results: [...task.results, result] };
  }
  const retryCount = task.retryCount + 1;
  return { ...base, retryCount, status: failureStatus(retryCount, maxRetries), results: [...task.results, result] };
}

/**
 * A supervised execution passed agent and validation checks. The task waits
 * for a human decision; it is NOT completed, so dependants stay blocked.
 */
export function submitForReview(task: Task, input: Omit<ResultInput, 'outcome'> & { runId: string; evidenceDigest: string }): Task {
  if (task.status !== 'in_progress' || task.currentRunId !== input.runId) {
    throw new InvalidTransitionError(
      `Cannot submit task "${task.id}" for review from status "${task.status}" (run ${task.currentRunId ?? 'none'})`,
    );
  }
  return { ...task, status: 'awaiting_review', results: [...task.results, toResult(task, { ...input, outcome: 'success' })] };
}

function reviewTarget(task: Task): { index: number; result: ExecutionResult } {
  if (task.status !== 'awaiting_review' || task.currentRunId === undefined) {
    throw new InvalidTransitionError(`Task "${task.id}" is not awaiting review (status "${task.status}")`);
  }
  const index = task.results.length - 1;
  const result = task.results[index];
  if (result === undefined || result.runId !== task.currentRunId || result.review !== undefined) {
    throw new InvalidTransitionError(`Task "${task.id}" has no unreviewed result for run ${task.currentRunId}`);
  }
  return { index, result };
}

/**
 * The reviewed result was accepted (by a person, or by the explicit
 * auto-accept policy for low-risk work): the task is completed.
 */
export function acceptReview(task: Task, reviewedAt: string, decidedBy?: { by: 'policy'; reason: string }): Task {
  const { index, result } = reviewTarget(task);
  const results = [...task.results];
  results[index] = {
    ...result,
    review: { decision: 'accepted', reviewedAt, ...(decidedBy ? { by: decidedBy.by, reason: decidedBy.reason } : {}) },
  };
  return { ...withoutRun(task), status: 'completed', results };
}

/** Human rejected the reviewed result: counts as a failed attempt. */
export function rejectReview(task: Task, reason: string, reviewedAt: string, maxRetries: number): Task {
  const { index, result } = reviewTarget(task);
  const results = [...task.results];
  results[index] = { ...result, review: { decision: 'rejected', reviewedAt, reason } };
  const retryCount = task.retryCount + 1;
  return { ...withoutRun(task), status: failureStatus(retryCount, maxRetries), retryCount, results };
}
