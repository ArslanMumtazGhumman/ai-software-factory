import { ValidationError } from '../core/errors.js';
import { isRecord, readInteger, readString, readStringArray, type Issues } from '../core/validation.js';

/**
 * Lifecycle of a task:
 *   pending -> in_progress -> completed (manual `record` of a success)
 *                          -> awaiting_review (supervised execution passed) -> completed (human accept)
 *                                                                           -> failed / needs_attention (human reject)
 *                          -> failed (retryable while retryCount <= maxRetries)
 *                          -> needs_attention (retries exhausted; a human must intervene)
 *
 * Only `completed` satisfies a dependency, so work awaiting review never
 * unlocks dependants.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'awaiting_review' | 'completed' | 'failed' | 'needs_attention';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'awaiting_review',
  'completed',
  'failed',
  'needs_attention',
];

export type ExecutionOutcome = 'success' | 'failure';

export type ReviewDecision = 'accepted' | 'rejected';

/** Human review decision attached to a supervised-execution result. */
export interface ReviewRecord {
  decision: ReviewDecision;
  reviewedAt: string;
  reason?: string;
  /** Who decided: a person (default) or the configured auto-accept policy. */
  by?: 'human' | 'policy';
}

/** Result of one attempt at a task (agent run and/or verification commands). */
export interface ExecutionResult {
  attempt: number;
  outcome: ExecutionOutcome;
  startedAt: string;
  finishedAt: string;
  summary: string;
  error?: string;
  /** Supervised execution run that produced this result (see `<dataDir>/runs/<runId>`). */
  runId?: string;
  /** SHA-256 of the run's recorded evidence, used to detect tampering before acceptance. */
  evidenceDigest?: string;
  review?: ReviewRecord;
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
  /** Set while a supervised execution run is in progress or awaiting review. */
  currentRunId?: string;
}

export const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

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
  const currentRunId = readString(raw, 'currentRunId', path, issues, { optional: true });
  if (currentRunId !== undefined && !RUN_ID.test(currentRunId)) issues.push(`${path}.currentRunId has an invalid format`);

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
    ...(currentRunId !== undefined ? { currentRunId } : {}),
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
    const runId = readString(item, 'runId', p, issues, { optional: true });
    if (runId !== undefined && !RUN_ID.test(runId)) issues.push(`${p}.runId has an invalid format`);
    const evidenceDigest = readString(item, 'evidenceDigest', p, issues, { optional: true });
    const review = parseReview(item.review, `${p}.review`, issues);
    if (attempt === undefined || startedAt === undefined || finishedAt === undefined || summary === undefined) return;
    if (outcome !== 'success' && outcome !== 'failure') return;
    out.push({
      attempt,
      outcome,
      startedAt,
      finishedAt,
      summary,
      ...(error !== undefined ? { error } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(evidenceDigest !== undefined ? { evidenceDigest } : {}),
      ...(review !== undefined ? { review } : {}),
    });
  });
  return out;
}

function parseReview(raw: unknown, path: string, issues: Issues): ReviewRecord | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const decision = readString(raw, 'decision', path, issues);
  if (decision !== undefined && decision !== 'accepted' && decision !== 'rejected') {
    issues.push(`${path}.decision must be "accepted" or "rejected"`);
    return undefined;
  }
  const reviewedAt = readString(raw, 'reviewedAt', path, issues);
  const reason = readString(raw, 'reason', path, issues, { optional: true, allowEmpty: true });
  const by = readString(raw, 'by', path, issues, { optional: true });
  if (by !== undefined && by !== 'human' && by !== 'policy') issues.push(`${path}.by must be "human" or "policy"`);
  if (decision === undefined || reviewedAt === undefined) return undefined;
  return {
    decision,
    reviewedAt,
    ...(reason !== undefined ? { reason } : {}),
    ...(by === 'human' || by === 'policy' ? { by } : {}),
  };
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
