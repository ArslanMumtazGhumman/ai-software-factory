import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, ValidationError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { redactSecrets } from '../security/redact.js';
import { RUN_ID, type TaskStatus } from '../tasks/task.js';
import { readJsonFile, writeJsonFileAtomic } from './jsonFile.js';

export const AUTORUNS_DIR = 'autoruns';
/** Older events are dropped (and counted) beyond this many. */
export const MAX_EVENTS = 500;

/**
 * running   a runner process is working on it (it holds the task-store lock)
 * paused    waiting for a person (review, failure, safety gate, pause request); resumable
 * stopped   ended by a stop request or a run limit; not resumable
 * completed every task is completed
 */
export type AutoRunState = 'running' | 'paused' | 'stopped' | 'completed';

export type StopReason =
  | 'all-complete'
  | 'awaiting-review'
  | 'task-failed'
  | 'needs-attention'
  | 'blocked'
  | 'task-limit'
  | 'duration-limit'
  | 'cost-limit'
  | 'pause-requested'
  | 'stop-requested'
  | 'safety-gate'
  | 'interrupted'
  | 'error';

export interface AutoRunLimits {
  maxTasks: number;
  maxRunDurationMs: number;
  maxTaskDurationMs: number;
  maxCostUsd?: number;
  maxRepairAttempts: number;
}

export type ExecutionResultKind =
  | 'running'
  | 'auto-accepted'
  | 'awaiting-review'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'needs-attention'
  | 'interrupted'
  | 'error';

/** One task execution started by an autonomous run (details live in runs/<runId>/run.json). */
export interface AutoRunExecution {
  taskId: string;
  runId?: string;
  startedAt: string;
  finishedAt?: string;
  result: ExecutionResultKind;
  taskStatus?: TaskStatus;
  agentExitCode?: number | null;
  agentTimedOut?: boolean;
  validation?: { name: string; exitCode: number | null; timedOut: boolean }[];
  repairs: number;
  costUsd?: number;
  branch?: string;
  worktreePath?: string;
  baseCommit?: string;
  acceptedCommit?: string;
  failureReason?: string;
  /** Why the result was (not) auto-accepted. */
  reviewReasons?: string[];
}

export interface AutoRunEvent {
  at: string;
  type: string;
  message: string;
}

export interface TaskCounts {
  total: number;
  completed: number;
  awaitingReview: number;
  failed: number;
  needsAttention: number;
  inProgress: number;
  pending: number;
}

/** Persistent record of one bounded autonomous run. Designed to be read by tools (e.g. a later dashboard). */
export interface AutoRunRecord {
  schemaVersion: 1;
  autoRunId: string;
  projectId: string;
  state: AutoRunState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Present while a runner process is working on this run. */
  owner?: { pid: number; hostname: string; since: string };
  limits: AutoRunLimits;
  /** Repository HEAD when the run started. */
  initialCommit: string;
  /** Commit the next task builds on: the initial commit plus accepted work, stacked. */
  tip: string;
  /** Active (not paused) time used so far. */
  activeMs: number;
  /** Measured agent cost so far. */
  costUsd: number;
  /** True once any agent invocation finished without reporting its cost. */
  costUnknown: boolean;
  segments: { startedAt: string; endedAt?: string; reason?: StopReason }[];
  currentTask?: { taskId: string; runId?: string; startedAt: string };
  lastCompletedTask?: { taskId: string; runId?: string; at: string; by: 'policy' | 'human' };
  executions: AutoRunExecution[];
  stop?: { reason: StopReason; message: string; action: string; at: string };
  /** Nonce of the last pause/stop request that was handled. */
  handledControlNonce?: string;
  summary?: TaskCounts;
  events: AutoRunEvent[];
  droppedEvents: number;
}

export interface ControlRequest {
  request: 'pause' | 'stop';
  requestedAt: string;
  nonce: string;
  pid: number;
}

function parseAutoRun(raw: unknown): AutoRunRecord {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.autoRunId !== 'string' || typeof raw.state !== 'string') {
    throw new ValidationError('autonomous run record has an unexpected format');
  }
  if (!['running', 'paused', 'stopped', 'completed'].includes(raw.state) || !Array.isArray(raw.executions) || !Array.isArray(raw.events)) {
    throw new ValidationError('autonomous run record is missing required fields');
  }
  if (typeof raw.tip !== 'string' || !isRecord(raw.limits)) throw new ValidationError('autonomous run record is missing required fields');
  return raw as unknown as AutoRunRecord;
}

function parseControl(raw: unknown): ControlRequest {
  if (!isRecord(raw) || (raw.request !== 'pause' && raw.request !== 'stop') || typeof raw.nonce !== 'string') {
    throw new ValidationError('control request has an unexpected format');
  }
  return raw as unknown as ControlRequest;
}

function assertId(id: string): void {
  if (!RUN_ID.test(id)) throw new ValidationError(`Invalid autonomous run id "${id}"`);
}

/** Append a redacted event, keeping at most MAX_EVENTS. */
export function addEvent(record: AutoRunRecord, at: string, type: string, message: string): void {
  record.events.push({ at, type, message: redactSecrets(message) });
  if (record.events.length > MAX_EVENTS) {
    const drop = record.events.length - MAX_EVENTS;
    record.events.splice(0, drop);
    record.droppedEvents += drop;
  }
}

/** JSON storage for autonomous runs under `<dataDir>/autoruns/<autoRunId>/`. */
export class AutoRunStore {
  readonly dir: string;

  constructor(readonly dataDir: string) {
    this.dir = path.join(dataDir, AUTORUNS_DIR);
  }

  private file(id: string, name: string): string {
    assertId(id);
    return path.join(this.dir, id, name);
  }

  async save(record: AutoRunRecord): Promise<void> {
    await writeJsonFileAtomic(this.file(record.autoRunId, 'autorun.json'), record);
  }

  async load(id: string): Promise<AutoRunRecord> {
    const record = await readJsonFile(this.file(id, 'autorun.json'), parseAutoRun);
    if (record.autoRunId !== id) throw new PersistenceError(`Autonomous run ${id} contains a different id (${record.autoRunId})`);
    return record;
  }

  /** Ids, oldest first (ids start with a UTC timestamp). */
  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((name) => RUN_ID.test(name)).sort();
    } catch {
      return [];
    }
  }

  async loadAll(): Promise<AutoRunRecord[]> {
    const out: AutoRunRecord[] = [];
    for (const id of await this.list()) out.push(await this.load(id));
    return out;
  }

  /** The single running or paused run, if any. More than one is an integrity error. */
  async findActive(): Promise<AutoRunRecord | undefined> {
    const active = (await this.loadAll()).filter((r) => r.state === 'running' || r.state === 'paused');
    if (active.length > 1) {
      throw new PersistenceError(`More than one active autonomous run (${active.map((r) => r.autoRunId).join(', ')}); stop all but one with "auto stop".`);
    }
    return active[0];
  }

  async latest(): Promise<AutoRunRecord | undefined> {
    const ids = await this.list();
    const last = ids[ids.length - 1];
    return last === undefined ? undefined : this.load(last);
  }

  /** Pause/stop requests are written without the task-store lock, which the runner holds. */
  async writeControl(id: string, request: 'pause' | 'stop', at: string): Promise<ControlRequest> {
    const control: ControlRequest = { request, requestedAt: at, nonce: randomBytes(8).toString('hex'), pid: process.pid };
    await writeJsonFileAtomic(this.file(id, 'control.json'), control);
    return control;
  }

  async readControl(id: string): Promise<ControlRequest | undefined> {
    try {
      return await readJsonFile(this.file(id, 'control.json'), parseControl);
    } catch (err) {
      if (err instanceof PersistenceError && /does not exist/.test(err.message)) return undefined;
      throw err;
    }
  }
}
