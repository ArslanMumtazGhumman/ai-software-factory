import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, ValidationError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { RUN_ID } from '../tasks/task.js';
import { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } from './jsonFile.js';

export const RUNS_DIR = 'runs';
export const WORKTREES_DIR = 'worktrees';

export type RunState = 'preparing' | 'running' | 'awaiting_review' | 'failed' | 'interrupted' | 'accepted' | 'rejected';

export interface AgentEvidence {
  outcome: 'success' | 'failure';
  summary: string;
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  killFailed: boolean;
  costUsd?: number;
  numTurns?: number;
  permissionDenials?: number;
  stdout: string;
  stderr: string;
}

export interface ValidationEvidence {
  name: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  killFailed: boolean;
  error?: string;
  stdout: string;
  stderr: string;
}

export interface ReviewFinding {
  severity: 'violation' | 'warning';
  rule: string;
  message: string;
  path?: string;
}

export interface ChangedFile {
  /** Git status letter: A, M, D, R, C, T. */
  status: string;
  path: string;
  oldPath?: string;
  mode: string;
}

export interface ReviewEvidence {
  headCommit: string;
  treeSha: string;
  diffSha256: string;
  diffBytes: number;
  changedFiles: ChangedFile[];
  ignoredFiles: string[];
  findings: ReviewFinding[];
}

/** Everything recorded about one supervised execution of one task. */
export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  state: RunState;
  factoryPid: number;
  hostname: string;
  agentPid?: number;
  startedAt: string;
  finishedAt?: string;
  baseCommit: string;
  branch?: string;
  worktreePath?: string;
  agent?: AgentEvidence;
  validation?: ValidationEvidence[];
  review?: ReviewEvidence;
  outcome?: 'success' | 'failure';
  failureReason?: string;
  /** Repair attempts made after validation failures, in order. */
  repairs?: RepairAttempt[];
  /** Autonomous run that started this execution, if any. */
  autoRunId?: string;
  decision?: { decision: 'accepted' | 'rejected' | 'interrupted'; at: string; reason?: string; by?: 'human' | 'policy' };
  /** Commit of the reviewed tree on the run branch, created on acceptance. */
  acceptedCommit?: string;
}

/** One bounded repair: the failing checks that triggered it and the agent's repair invocation. */
export interface RepairAttempt {
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** Validation results that failed and were sent back to the agent. */
  failedValidation: ValidationEvidence[];
  agent: AgentEvidence;
}

export function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Digest over the evidence a reviewer relies on. State and decision fields
 * are excluded so recording the decision does not change the digest.
 */
export function evidenceDigest(run: RunRecord): string {
  const evidence = {
    runId: run.runId,
    taskId: run.taskId,
    baseCommit: run.baseCommit,
    branch: run.branch ?? null,
    worktreePath: run.worktreePath ?? null,
    agent: run.agent ?? null,
    validation: run.validation ?? null,
    review: run.review ?? null,
    outcome: run.outcome ?? null,
    failureReason: run.failureReason ?? null,
    // Added only when present so digests of runs recorded before repairs existed stay valid.
    ...(run.repairs !== undefined ? { repairs: run.repairs } : {}),
    ...(run.autoRunId !== undefined ? { autoRunId: run.autoRunId } : {}),
  };
  return sha256(JSON.stringify(evidence));
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new ValidationError(`Invalid run id "${runId}"`);
}

function parseRunRecord(raw: unknown): RunRecord {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.runId !== 'string' || typeof raw.taskId !== 'string') {
    throw new ValidationError('run record has an unexpected format');
  }
  if (typeof raw.state !== 'string' || typeof raw.baseCommit !== 'string' || typeof raw.factoryPid !== 'number') {
    throw new ValidationError('run record is missing required fields');
  }
  return raw as unknown as RunRecord;
}

/** JSON storage for run records and their diffs under `<dataDir>/runs/<runId>/`. */
export class RunStore {
  readonly runsDir: string;

  constructor(readonly dataDir: string) {
    this.runsDir = path.join(dataDir, RUNS_DIR);
  }

  runDir(runId: string): string {
    assertRunId(runId);
    return path.join(this.runsDir, runId);
  }

  worktreePath(runId: string): string {
    assertRunId(runId);
    return path.join(this.dataDir, WORKTREES_DIR, runId);
  }

  async save(run: RunRecord): Promise<void> {
    await writeJsonFileAtomic(path.join(this.runDir(run.runId), 'run.json'), run);
  }

  async load(runId: string): Promise<RunRecord> {
    const run = await readJsonFile(path.join(this.runDir(runId), 'run.json'), parseRunRecord);
    if (run.runId !== runId) throw new PersistenceError(`Run record ${runId} contains a different run id (${run.runId})`);
    return run;
  }

  diffPath(runId: string): string {
    return path.join(this.runDir(runId), 'diff.patch');
  }

  /** Store the (already redacted) diff as a plain patch file; returns its SHA-256. */
  async saveDiff(runId: string, patch: string): Promise<string> {
    await writeTextFileAtomic(this.diffPath(runId), patch);
    return sha256(patch);
  }

  async loadDiff(runId: string): Promise<string> {
    const file = this.diffPath(runId);
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      throw new PersistenceError(`Cannot read ${file}`, { cause: err });
    }
  }
}
