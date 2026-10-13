import { assertValidDependencies } from './dependencyGraph.js';
import type { Task } from './task.js';

export interface SelectionOptions {
  /** Retries allowed after the first failure (from ExecutionLimits). */
  maxRetries: number;
  /** Maximum number of tasks to return. Defaults to all eligible tasks. */
  limit?: number;
}

export type Eligibility =
  | { eligible: true; reason: 'ready' | 'retry' }
  | { eligible: false; reason: string };

/**
 * Decide whether a single task can be started now. A task is eligible when it
 * is `pending` (or `failed` with retries left) and every dependency is
 * `completed`.
 */
export function evaluateEligibility(task: Task, byId: ReadonlyMap<string, Task>, maxRetries: number): Eligibility {
  switch (task.status) {
    case 'completed':
      return { eligible: false, reason: 'already completed' };
    case 'in_progress':
      return { eligible: false, reason: 'already in progress' };
    case 'awaiting_review':
      return { eligible: false, reason: 'awaiting human review (accept or reject it)' };
    case 'needs_attention':
      return { eligible: false, reason: 'needs human attention (retries exhausted)' };
    case 'failed':
      if (task.retryCount > maxRetries) {
        return { eligible: false, reason: `retry limit reached (${task.retryCount - 1}/${maxRetries} retries used)` };
      }
      break;
    case 'pending':
      break;
  }
  const waiting = task.dependencies.filter((dep) => byId.get(dep)?.status !== 'completed');
  if (waiting.length > 0) {
    return { eligible: false, reason: `waiting on dependencies: ${waiting.join(', ')}` };
  }
  return { eligible: true, reason: task.status === 'failed' ? 'retry' : 'ready' };
}

/**
 * Return eligible tasks in file order (the order is the priority). The graph
 * is validated first, so a broken graph never silently selects work.
 */
export function selectEligibleTasks(tasks: readonly Task[], options: SelectionOptions): Task[] {
  assertValidDependencies(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const eligible = tasks.filter((t) => evaluateEligibility(t, byId, options.maxRetries).eligible);
  return options.limit === undefined ? eligible : eligible.slice(0, Math.max(0, options.limit));
}

/** Convenience: the single next task, or undefined if nothing is eligible. */
export function selectNextTask(tasks: readonly Task[], options: Omit<SelectionOptions, 'limit'>): Task | undefined {
  return selectEligibleTasks(tasks, { ...options, limit: 1 })[0];
}

/** Per-task eligibility report, for status displays. */
export function explainTasks(tasks: readonly Task[], maxRetries: number): { task: Task; eligibility: Eligibility }[] {
  assertValidDependencies(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  return tasks.map((task) => ({ task, eligibility: evaluateEligibility(task, byId, maxRetries) }));
}
