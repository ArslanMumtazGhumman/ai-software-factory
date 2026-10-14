import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, ValidationError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } from '../persistence/jsonFile.js';
import { redactSecrets } from '../security/redact.js';
import { RUN_ID } from '../tasks/task.js';
import type { CodebaseSummary } from './codebase.js';
import { DOCUMENT_NAMES, type DocumentName } from './documents.js';
import type { IdeaInput, ProductPlan, Proposal } from './model.js';
import type { PlanValidation } from './validatePlan.js';

/**
 * proposing      the planner is preparing the proposal
 * needs-input    the planner asked one blocking question
 * proposed       waiting for the person to approve or reject the idea
 * finalizing     approved; the planner is producing the full plan
 * needs-attention the planner found the approved product infeasible (or out of scope); nothing was substituted
 * invalid        the plan failed validation after every allowed attempt
 * initializing   creating and registering the project
 * ready          the project exists and can run
 * rejected       the person rejected the idea (terminal)
 * failed         a step failed (planner unavailable, budget, git...); retryable
 */
export type PlanState =
  | 'proposing'
  | 'needs-input'
  | 'proposed'
  | 'finalizing'
  | 'needs-attention'
  | 'invalid'
  | 'initializing'
  | 'ready'
  | 'rejected'
  | 'failed';

export type PlanStep = 'propose' | 'finalize' | 'initialize';
export const WORKING_STATES: readonly PlanState[] = ['proposing', 'finalizing', 'initializing'];

export interface PlanRecord {
  schemaVersion: 1;
  planId: string;
  state: PlanState;
  createdAt: string;
  updatedAt: string;
  idea: IdeaInput;
  existing?: CodebaseSummary;
  proposal?: Proposal;
  proposalWarnings: string[];
  validation?: PlanValidation;
  /** Where the project is (or will be) created. Chosen once, so retries never create a second project. */
  destination?: string;
  slug?: string;
  project?: { root: string; configFile: string; initialCommit: string | null };
  /** The step running now (with the process doing it), if any. */
  job?: { step: PlanStep; pid: number; startedAt: string };
  failure?: { step: PlanStep; message: string; at: string };
  attention?: { message: string; at: string };
  decision?: { decision: 'approved' | 'rejected'; at: string; reason?: string };
  /** Planner usage: Claude Code's reported cost (an estimate) and whether any call's cost is unknown. */
  cost: { usd: number; unknown: boolean; calls: number };
  attempts: Record<PlanStep, number>;
  events: { at: string; type: string; message: string }[];
}

export interface RegistryEntry {
  planId: string;
  configFile: string;
  root: string;
  createdAt: string;
}

const MAX_EVENTS = 300;

export function addPlanEvent(record: PlanRecord, at: string, type: string, message: string): void {
  record.events.push({ at, type, message: redactSecrets(message).slice(0, 4000) });
  if (record.events.length > MAX_EVENTS) record.events.splice(0, record.events.length - MAX_EVENTS);
}

function parseRecord(raw: unknown): PlanRecord {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.planId !== 'string' || typeof raw.state !== 'string' || !isRecord(raw.idea)) {
    throw new ValidationError('plan record has an unexpected format');
  }
  return raw as unknown as PlanRecord;
}

/** Planning records under `<stateDir>/plans/<planId>/`, plus the registry of created projects. */
export class PlanStore {
  readonly plansDir: string;
  readonly registryFile: string;

  constructor(readonly stateDir: string) {
    this.plansDir = path.join(stateDir, 'plans');
    this.registryFile = path.join(stateDir, 'projects.json');
  }

  dir(planId: string): string {
    if (!RUN_ID.test(planId)) throw new ValidationError('Invalid plan id.');
    return path.join(this.plansDir, planId);
  }

  /** Empty folder the planner works in for a new project (it can read nothing else). */
  async sandbox(planId: string): Promise<string> {
    const dir = path.join(this.dir(planId), 'sandbox');
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async save(record: PlanRecord): Promise<void> {
    await writeJsonFileAtomic(path.join(this.dir(record.planId), 'plan-record.json'), record);
  }

  async load(planId: string): Promise<PlanRecord> {
    const record = await readJsonFile(path.join(this.dir(planId), 'plan-record.json'), parseRecord);
    if (record.planId !== planId) throw new PersistenceError(`Plan ${planId} contains a different id`);
    return record;
  }

  async list(): Promise<string[]> {
    return (await readdir(this.plansDir).catch(() => [] as string[])).filter((n) => RUN_ID.test(n)).sort();
  }

  async savePlan(planId: string, plan: ProductPlan, docs: Record<DocumentName, string>): Promise<void> {
    await writeJsonFileAtomic(path.join(this.dir(planId), 'plan.json'), plan);
    await mkdir(path.join(this.dir(planId), 'docs'), { recursive: true });
    for (const name of DOCUMENT_NAMES) await writeTextFileAtomic(path.join(this.dir(planId), 'docs', name), docs[name]);
  }

  async loadPlan(planId: string): Promise<ProductPlan | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.dir(planId), 'plan.json'), 'utf8')) as ProductPlan;
    } catch {
      return undefined;
    }
  }

  /** A rendered document of a plan (from the planning folder, before or after initialization). */
  async document(planId: string, name: string): Promise<string | undefined> {
    if (!(DOCUMENT_NAMES as readonly string[]).includes(name)) throw new ValidationError('Unknown document.');
    return readFile(path.join(this.dir(planId), 'docs', name), 'utf8').catch(() => undefined);
  }

  async registry(): Promise<RegistryEntry[]> {
    try {
      const raw = JSON.parse(await readFile(this.registryFile, 'utf8')) as unknown;
      if (!isRecord(raw) || !Array.isArray(raw.projects)) throw new Error('bad format');
      return raw.projects.filter((p): p is RegistryEntry => isRecord(p) && typeof p.configFile === 'string' && typeof p.planId === 'string' && typeof p.root === 'string');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new PersistenceError(`Cannot read the project registry ${this.registryFile}: ${(err as Error).message}`);
    }
  }

  /** Adds a project once (keyed by plan and by config file). */
  async register(entry: RegistryEntry): Promise<void> {
    const entries = await this.registry();
    const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    if (entries.some((e) => e.planId === entry.planId || same(e.configFile, entry.configFile))) return;
    await mkdir(this.stateDir, { recursive: true });
    await writeJsonFileAtomic(this.registryFile, { schemaVersion: 1, projects: [...entries, entry] });
  }

  /** Marker so a project directory is recognised as created by this plan (and never by another). */
  static originFile(dataDir: string): string {
    return path.join(dataDir, 'origin.json');
  }

  static async readOrigin(dataDir: string): Promise<{ planId: string } | undefined> {
    try {
      const raw = JSON.parse(await readFile(PlanStore.originFile(dataDir), 'utf8')) as unknown;
      return isRecord(raw) && typeof raw.planId === 'string' ? { planId: raw.planId } : undefined;
    } catch {
      return undefined;
    }
  }

  static async writeOrigin(dataDir: string, planId: string, at: string): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(PlanStore.originFile(dataDir), `${JSON.stringify({ planId, createdAt: at, createdBy: 'ai-software-factory planner' }, null, 2)}\n`);
  }
}
