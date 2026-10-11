import { InvalidTransitionError } from '../core/errors.js';
import type { ExecutionOutcome, Task } from './task.js';

/**
 * Pure state transitions. Each returns a new Task and never mutates its input,
 * which keeps persistence and testing straightforward.
 */

export function startTask(task: Task): Task {
  if (task.status !== 'pending' && task.status !== 'failed') {
    throw new InvalidTransitionError(`Cannot start task "${task.id}" from status "${task.status}"`);
  }
  return { ...task, status: 'in_progress' };
}

export interface ResultInput {
  outcome: ExecutionOutcome;
  summary: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * Record the result of an attempt. Success completes the task; failure bumps
 * retryCount and moves the task to `failed`, or to `needs_attention` once
 * retries are exhausted.
 */
export function recordResult(task: Task, input: ResultInput, maxRetries: number): Task {
  if (task.status === 'completed' || task.status === 'needs_attention') {
    throw new InvalidTransitionError(`Cannot record a result for task "${task.id}" in status "${task.status}"`);
  }
  const attempt = task.results.length + 1;
  const result = {
    attempt,
    outcome: input.outcome,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    summary: input.summary,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
  if (input.outcome === 'success') {
    return { ...task, status: 'completed', results: [...task.results, result] };
  }
  const retryCount = task.retryCount + 1;
  return {
    ...task,
    retryCount,
    status: retryCount > maxRetries ? 'needs_attention' : 'failed',
    results: [...task.results, result],
  };
}
