import { ValidationError } from '../core/errors.js';
import { isRecord, readInteger, readString, readStringArray, type Issues } from '../core/validation.js';

/**
 * Lifecycle of a task:
 *   pending -> in_progress -> completed
 *                          -> failed (retryable while retryCount <= maxRetries)
 *                          -> needs_attention (retries exhausted; a human must intervene)
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'needs_attention';

export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'needs_attention'];

export type ExecutionOutcome = 'success' | 'failure';

/** Result of one attempt at a task (agent run and/or verification commands). */
export interface ExecutionResult {
  attempt: number;
  outcome: ExecutionOutcome;
  startedAt: string;
  finishedAt: string;
  summary: string;
  error?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  /** Ids of tasks that must be `completed` before this task is eligible. */
  dependencies: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  /** Number of failed attempts recorded so far. */
  retryCount: number;
  results: ExecutionResult[];
}

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate one raw task object. Missing optional fields get safe defaults. */
export function parseTask(raw: unknown, path: string, issues: Issues): Task | undefined {
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const before = issues.length;
  const id = readString(raw, 'id', path, issues);
  if (id !== undefined && !TASK_ID.test(id)) issues.push(`${path}.id "${id}" must match ${TASK_ID}`);
  const title = readString(raw, 'title', path, issues, { maxLength: 300 });
  const description = readString(raw, 'description', path, issues, { maxLength: 50_000 });
  const dependencies = readStringArray(raw, 'dependencies', path, issues, { optional: true }) ?? [];
  const acceptanceCriteria = readStringArray(raw, 'acceptanceCriteria', path, issues);
  const status = (readString(raw, 'status', path, issues, { optional: true }) ?? 'pending') as TaskStatus;
  if (!TASK_STATUSES.includes(status)) issues.push(`${path}.status must be one of ${TASK_STATUSES.join(', ')}`);
  const retryCount = readInteger(raw, 'retryCount', path, issues, { min: 0, max: 1000, optional: true }) ?? 0;
  const results = parseResults(raw.results, `${path}.results`, issues);

  if (issues.length > before) return undefined;
  return {
    id: id!,
    title: title!,
    description: description!,
    dependencies,
    acceptanceCriteria: acceptanceCriteria!,
    status,
    retryCount,
    results,
  };
}

function parseResults(raw: unknown, path: string, issues: Issues): ExecutionResult[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(`${path} must be an array`);
    return [];
  }
  const out: ExecutionResult[] = [];
  raw.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isRecord(item)) {
      issues.push(`${p} must be an object`);
      return;
    }
    const attempt = readInteger(item, 'attempt', p, issues, { min: 1, max: 1000 });
    const outcome = readString(item, 'outcome', p, issues);
    if (outcome !== undefined && outcome !== 'success' && outcome !== 'failure') {
      issues.push(`${p}.outcome must be "success" or "failure"`);
    }
    const startedAt = readString(item, 'startedAt', p, issues);
    const finishedAt = readString(item, 'finishedAt', p, issues);
    const summary = readString(item, 'summary', p, issues, { allowEmpty: true });
    const error = readString(item, 'error', p, issues, { optional: true, allowEmpty: true });
    if (attempt === undefined || startedAt === undefined || finishedAt === undefined || summary === undefined) return;
    if (outcome !== 'success' && outcome !== 'failure') return;
    out.push({ attempt, outcome, startedAt, finishedAt, summary, ...(error !== undefined ? { error } : {}) });
  });
  return out;
}

/** Validate a full task list (structure only; see dependencyGraph for graph rules). */
export function parseTaskList(raw: unknown): Task[] {
  if (!Array.isArray(raw)) throw new ValidationError('tasks must be an array');
  const issues: Issues = [];
  const tasks: Task[] = [];
  raw.forEach((item, i) => {
    const task = parseTask(item, `tasks[${i}]`, issues);
    if (task) tasks.push(task);
  });
  if (issues.length > 0) throw new ValidationError('Invalid task list', issues);
  return tasks;
}
