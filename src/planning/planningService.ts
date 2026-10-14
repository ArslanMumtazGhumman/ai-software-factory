import { FactoryError, InvalidTransitionError, LimitExceededError, ValidationError, describeError } from '../core/errors.js';
import { defaultGitRunner, type GitRunner } from '../git/gitWorkspace.js';
import { FileLock } from '../persistence/fileLock.js';
import { newRunId } from '../persistence/runStore.js';
import { isProcessAlive } from '../security/processTree.js';
import { redactSecrets } from '../security/redact.js';
import { inspectCodebase, resolveExistingCodebase } from './codebase.js';
import { DOCUMENT_NAMES, factoryConfigFor, renderDocuments, slugify } from './documents.js';
import { chooseDestination, initializeProject } from './initializer.js';
import { ideaCheck, planCheck, proposalCheck, type IdeaInput, type ProductPlan } from './model.js';
import type { PlannerResult, ProductPlanner } from './planner.js';
import { PlanStore, WORKING_STATES, addPlanEvent, type PlanRecord, type PlanStep } from './planStore.js';
import { validate } from './schema.js';
import { validatePlan, validateProposal } from './validatePlan.js';
import type { WorkspaceConfig } from './workspace.js';

/** Documents carry the approval time, so rendering them again gives identical files. */
export function generatedAt(record: PlanRecord): string {
  return record.decision?.at ?? record.createdAt;
}

/** A request conflicts with the plan's current state. */
export class PlanConflictError extends FactoryError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

export interface PlanningServiceOptions {
  planner: ProductPlanner;
  now?: () => Date;
  git?: GitRunner;
  log?: (line: string) => void;
  /** Called once a project is created and registered (the dashboard adds it to its list). */
  onProjectReady?: (configFile: string) => Promise<void>;
}

const BUDGET_EPSILON = 1e-9;

/**
 * Idea-to-project workflow. A person approves the idea (the proposal); after
 * that the plan is finalized, validated and the project initialized without
 * further approvals. Planner calls are bounded by attempts, a per-plan call
 * cap and, when configured, a cost budget that fails closed when usage is
 * unknown. Steps run in the background in this process; the record shows
 * progress, and an interrupted step can be retried safely.
 */
export class PlanningService {
  readonly store: PlanStore;
  private readonly now: () => Date;
  private readonly git: GitRunner;
  private readonly log: (line: string) => void;
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(
    readonly workspace: WorkspaceConfig,
    private readonly options: PlanningServiceOptions,
  ) {
    this.store = new PlanStore(workspace.stateDir);
    this.now = options.now ?? (() => new Date());
    this.git = options.git ?? defaultGitRunner;
    this.log = options.log ?? (() => undefined);
  }

  get plannerName(): string {
    return this.options.planner.name;
  }

  // ------------------------------------------------------------------ reads

  /** A record plus whether its running step was interrupted (its process is gone). */
  async view(planId: string) {
    const record = await this.store.load(planId);
    return { record, interrupted: this.isInterrupted(record), running: this.jobs.has(planId) };
  }

  async list() {
    const out = [];
    for (const id of (await this.store.list()).reverse()) {
      try {
        out.push(await this.view(id));
      } catch {
        /* unreadable record: skipped in the list */
      }
    }
    return out;
  }

  plan(planId: string): Promise<ProductPlan | undefined> {
    return this.store.loadPlan(planId);
  }

  document(planId: string, name: string): Promise<string | undefined> {
    return this.store.document(planId, name);
  }

  private isInterrupted(record: PlanRecord): boolean {
    if (!WORKING_STATES.includes(record.state)) return false;
    if (this.jobs.has(record.planId)) return false;
    const job = record.job;
    if (job === undefined) return true;
    return job.pid === process.pid || !isProcessAlive(job.pid);
  }

  /** Wait for the background step of a plan (tests, CLI). */
  async settled(planId: string): Promise<void> {
    while (this.jobs.has(planId)) await this.jobs.get(planId);
  }

  // ---------------------------------------------------------------- actions

  /** Validate the idea, record it and start preparing the proposal. */
  async create(raw: unknown): Promise<PlanRecord> {
    const { value, issues } = validate(ideaCheck, raw, 'idea');
    if (value === undefined) throw new ValidationError('The idea is incomplete or invalid', issues);
    const idea: IdeaInput = { ...value, clarifications: [] };
    const at = this.now().toISOString();
    const record: PlanRecord = {
      schemaVersion: 1,
      planId: newRunId(this.now()),
      state: 'proposing',
      createdAt: at,
      updatedAt: at,
      idea,
      proposalWarnings: [],
      cost: { usd: 0, unknown: false, calls: 0 },
      attempts: { propose: 0, finalize: 0, initialize: 0 },
      events: [],
    };
    if (idea.existingCodebasePath !== '') {
      const real = await resolveExistingCodebase(idea.existingCodebasePath, this.workspace.existingProjectRoots);
      const summary = await inspectCodebase(real, this.git);
      if (summary.hasFactoryState) throw new PlanConflictError(`${real} already has factory state (.factory/project.json). Open it with "dashboard --config" instead.`);
      record.existing = summary;
      record.idea.existingCodebasePath = real;
      addPlanEvent(record, at, 'codebase', `Inspected ${real}: ${summary.isGitRepo ? `git branch ${summary.branch ?? '(detached)'}, ${summary.uncommittedChanges} uncommitted change(s)` : 'not a git repository'}.`);
      for (const p of summary.problems) addPlanEvent(record, at, 'warning', `Existing codebase: ${p}.`);
    }
    addPlanEvent(record, at, 'idea', `Idea "${idea.name}" received.`);
    await this.store.save(record);
    this.start(record.planId, 'propose');
    return record;
  }

  async approve(planId: string): Promise<PlanRecord> {
    return this.transition(planId, ['proposed'], async (record, at) => {
      record.decision = { decision: 'approved', at };
      addPlanEvent(record, at, 'approve', 'The idea was approved. Finalizing the plan.');
      return 'finalize';
    });
  }

  async reject(planId: string, reason: string): Promise<PlanRecord> {
    const text = reason.trim();
    if (text.length === 0) throw new ValidationError('A reason is required to reject an idea.');
    return this.transition(planId, ['proposed', 'needs-input', 'needs-attention', 'invalid', 'failed'], async (record, at) => {
      record.state = 'rejected';
      record.decision = { decision: 'rejected', at, reason: redactSecrets(text).slice(0, 2000) };
      addPlanEvent(record, at, 'reject', `Rejected: ${text}`);
      return undefined;
    });
  }

  /** Answer the planner's blocking question and prepare the proposal again. */
  async answer(planId: string, answer: string): Promise<PlanRecord> {
    const text = answer.trim();
    if (text.length === 0 || text.length > 5000) throw new ValidationError('An answer (1-5000 characters) is required.');
    return this.transition(planId, ['needs-input'], async (record, at) => {
      if (record.idea.clarifications.length >= 10) throw new LimitExceededError('At most 10 questions can be answered for one idea.');
      record.idea.clarifications.push({ question: record.proposal?.blockingQuestion ?? '', answer: text });
      addPlanEvent(record, at, 'answer', 'The blocking question was answered.');
      return 'propose';
    });
  }

  /** Run a failed, invalid, paused or interrupted step again. Completed steps are never repeated. */
  async retry(planId: string): Promise<PlanRecord> {
    const current = await this.view(planId);
    const interrupted = current.interrupted;
    const allowed = interrupted ? WORKING_STATES : (['failed', 'invalid', 'needs-attention'] as const);
    return this.transition(planId, [...allowed], async (record, at) => {
      const step: PlanStep =
        interrupted && record.job !== undefined ? record.job.step
        : record.state === 'failed' ? (record.failure?.step ?? 'propose')
        : record.state === 'proposing' ? 'propose'
        : record.state === 'initializing' ? 'initialize'
        : 'finalize';
      if (interrupted) await this.clearStaleLock(planId);
      addPlanEvent(record, at, 'retry', `Retrying the ${step} step${interrupted ? ' after an interruption' : ''}.`);
      return step;
    });
  }

  private async transition(planId: string, from: readonly string[], change: (record: PlanRecord, at: string) => Promise<PlanStep | undefined>): Promise<PlanRecord> {
    // Claim the plan synchronously so two requests (double clicks, two tabs) cannot both act.
    if (this.jobs.has(planId)) throw new PlanConflictError('This plan is already being worked on.');
    let release!: () => void;
    const claim = new Promise<void>((r) => (release = r));
    this.jobs.set(planId, claim);
    let started = false;
    try {
      const record = await this.store.load(planId);
      if (!from.includes(record.state)) throw new InvalidTransitionError(`The plan is ${record.state}; this action is not possible now.`);
      const at = this.now().toISOString();
      const step = await change(record, at);
      if (step !== undefined) {
        record.state = step === 'propose' ? 'proposing' : step === 'finalize' ? 'finalizing' : 'initializing';
        delete record.failure;
        delete record.attention;
      }
      await this.save(record);
      if (step !== undefined) {
        this.start(planId, step);
        started = true;
      }
      return record;
    } finally {
      if (!started) this.jobs.delete(planId);
      release();
    }
  }

  private async clearStaleLock(planId: string): Promise<void> {
    const lock = new FileLock(this.store.dir(planId));
    const state = await lock.inspect();
    if (state.state === 'held' && state.owner === 'dead') await lock.breakStaleLock();
  }

  // ------------------------------------------------------------------ steps

  private start(planId: string, step: PlanStep): void {
    const job = this.runStep(planId, step).finally(() => this.jobs.delete(planId));
    this.jobs.set(planId, job);
  }

  private async runStep(planId: string, step: PlanStep): Promise<void> {
    const lock = new FileLock(this.store.dir(planId));
    let handle;
    try {
      handle = await lock.acquire(`plan ${step}`);
    } catch (err) {
      await this.fail(planId, step, `Another process is working on this plan (${describeError(err)}).`);
      return;
    }
    try {
      const record = await this.store.load(planId);
      record.job = { step, pid: process.pid, startedAt: this.now().toISOString() };
      await this.save(record);
      if (step === 'propose') await this.propose(record);
      else if (step === 'finalize') await this.finalize(record);
      else await this.initialize(record, (await this.store.loadPlan(planId))!);
    } catch (err) {
      this.log(`Planning step ${step} of ${planId} failed: ${redactSecrets(describeError(err))}`);
      // Finalize continues into initialize; report the step that actually failed so a retry redoes only that.
      const current = await this.store.load(planId).catch(() => undefined);
      await this.fail(planId, current?.job?.step ?? step, err instanceof FactoryError ? describeError(err) : `Unexpected error: ${describeError(err)}`);
    } finally {
      await handle.release().catch(() => undefined);
    }
  }

  private async fail(planId: string, step: PlanStep, message: string): Promise<void> {
    const record = await this.store.load(planId);
    const at = this.now().toISOString();
    record.state = 'failed';
    record.failure = { step, message: redactSecrets(message).slice(0, 4000), at };
    delete record.job;
    addPlanEvent(record, at, 'failed', `${step} failed: ${message}`);
    await this.save(record);
  }

  /** Every planner call must fit the remaining budget and the call cap; unknown usage stops planning. */
  private budgetProblem(record: PlanRecord): string | undefined {
    const s = this.workspace.planner;
    if (record.cost.calls >= s.maxCallsPerPlan) return `the limit of ${s.maxCallsPerPlan} planner calls for this idea is reached (planner.maxCallsPerPlan)`;
    if (s.maxCostUsdPerPlan === undefined) return undefined;
    if (record.cost.unknown) return 'the cost of an earlier planner call is unknown, so the planning budget cannot be enforced';
    const remaining = s.maxCostUsdPerPlan - record.cost.usd;
    if (remaining + BUDGET_EPSILON < (s.maxBudgetUsdPerCall ?? Infinity)) {
      return `the planning budget is used up ($${record.cost.usd.toFixed(4)} of $${s.maxCostUsdPerPlan}; another call may cost up to $${s.maxBudgetUsdPerCall})`;
    }
    return undefined;
  }

  private async call(record: PlanRecord, step: 'propose' | 'finalize', previousIssues: string[]): Promise<PlannerResult> {
    const problem = this.budgetProblem(record);
    if (problem !== undefined) throw new LimitExceededError(`Not calling the planner: ${problem}.`);
    record.attempts[step] += 1;
    record.cost.calls += 1;
    await this.save(record);
    const result = await this.options.planner.run({
      step,
      idea: record.idea,
      ...(record.proposal !== undefined ? { proposal: record.proposal } : {}),
      previousIssues,
      ...(record.existing !== undefined ? { codebase: record.existing } : {}),
      workingDirectory: record.existing?.path ?? (await this.store.sandbox(record.planId)),
      today: this.now().toISOString().slice(0, 10),
    });
    if (result.costUsd !== undefined) record.cost.usd += result.costUsd;
    if (!result.costKnown) record.cost.unknown = true;
    addPlanEvent(
      record,
      this.now().toISOString(),
      'planner',
      `${step} call ${record.attempts[step]} (${this.options.planner.name}): ${result.error ?? 'answer received'}; ${result.costUsd !== undefined ? `estimated cost $${result.costUsd.toFixed(4)}` : result.costKnown ? 'no cost' : 'cost unknown'}.`,
    );
    await this.save(record);
    return result;
  }

  private async propose(record: PlanRecord): Promise<void> {
    let issues: string[] = [];
    for (let attempt = 1; attempt <= this.workspace.planner.maxAttemptsPerStep; attempt++) {
      const result = await this.call(record, 'propose', issues);
      if (result.output === undefined) {
        issues = [result.error ?? 'no output'];
        continue;
      }
      const parsed = validate(proposalCheck, result.output, 'proposal');
      if (parsed.value === undefined) {
        issues = parsed.issues;
        continue;
      }
      const checked = validateProposal(parsed.value, record.idea, this.workspace);
      if (checked.errors.length > 0) {
        issues = checked.errors;
        continue;
      }
      const at = this.now().toISOString();
      record.proposal = parsed.value;
      record.proposalWarnings = checked.warnings;
      delete record.job;
      if (!parsed.value.feasibility.feasible) {
        record.state = 'needs-attention';
        record.attention = { message: `The planner considers the idea not feasible as described: ${parsed.value.feasibility.issues.join('; ') || 'no details given'}`, at };
      } else if (parsed.value.blockingQuestion !== '') {
        record.state = 'needs-input';
        addPlanEvent(record, at, 'question', parsed.value.blockingQuestion);
      } else {
        record.state = 'proposed';
        addPlanEvent(record, at, 'proposal', 'Proposal ready for approval.');
      }
      await this.save(record);
      return;
    }
    throw new FactoryError('PLANNER_OUTPUT_INVALID', `The planner did not produce a usable proposal after ${this.workspace.planner.maxAttemptsPerStep} attempt(s): ${issues.slice(0, 10).join('; ')}`);
  }

  private async finalize(record: PlanRecord): Promise<void> {
    let issues: string[] = [];
    for (let attempt = 1; attempt <= this.workspace.planner.maxAttemptsPerStep; attempt++) {
      const result = await this.call(record, 'finalize', issues);
      if (result.output === undefined) {
        issues = [result.error ?? 'no output'];
        continue;
      }
      const parsed = validate(planCheck, result.output, 'plan');
      if (parsed.value === undefined) {
        issues = parsed.issues;
        continue;
      }
      const plan = parsed.value;
      const at = this.now().toISOString();
      const docs = renderDocuments(plan, record.idea, record.proposal, generatedAt(record), record.existing ? '.factory/docs' : 'docs');
      const validation = validatePlan(plan, record.idea, this.workspace, docs);
      try {
        factoryConfigFor(plan, this.workspace, { projectRoot: '.', dataDir: '.factory', configDir: this.workspace.root });
      } catch (err) {
        validation.errors.push(`generated factory config is invalid: ${describeError(err)}`);
        validation.valid = false;
      }
      record.validation = validation;
      await this.store.savePlan(record.planId, plan, docs);
      if (!plan.feasibility.feasible) {
        record.state = 'needs-attention';
        record.attention = { message: `While planning, the approved product turned out not to be feasible as approved: ${plan.feasibility.issues.join('; ') || 'no details'}. Nothing was substituted; reject the idea or retry after adjusting it.`, at };
        delete record.job;
        await this.save(record);
        return;
      }
      if (!validation.valid) {
        issues = validation.errors;
        addPlanEvent(record, at, 'validation', `The plan failed ${validation.errors.length} check(s).`);
        await this.save(record);
        continue;
      }
      addPlanEvent(record, at, 'validation', `The plan passed validation: ${plan.tasks.length} task(s), ${validation.warnings.length} warning(s).`);
      if (record.destination === undefined) {
        if (record.existing !== undefined) {
          record.destination = record.existing.path;
          record.slug = slugify(plan.product.name);
        } else {
          const registered = (await this.store.registry()).map((e) => e.root);
          const chosen = await chooseDestination(this.workspace, slugify(plan.product.name), record.planId, registered);
          record.destination = chosen.destination;
          record.slug = chosen.slug;
        }
      }
      record.state = 'initializing';
      record.job = { step: 'initialize', pid: process.pid, startedAt: at };
      await this.save(record);
      await this.initialize(record, plan);
      return;
    }
    const at = this.now().toISOString();
    record.state = 'invalid';
    delete record.job;
    addPlanEvent(record, at, 'invalid', `The plan is still invalid after ${this.workspace.planner.maxAttemptsPerStep} attempt(s).`);
    if (record.validation === undefined || record.validation.valid) {
      record.failure = { step: 'finalize', message: issues.slice(0, 20).join('; '), at };
    }
    await this.save(record);
  }

  private async initialize(record: PlanRecord, plan: ProductPlan): Promise<void> {
    record.attempts.initialize += 1;
    const result = await initializeProject(this.workspace, record, plan, this.now().toISOString(), this.git);
    const at = this.now().toISOString();
    await this.store.register({ planId: record.planId, configFile: result.configFile, root: result.root, createdAt: at });
    record.project = { root: result.root, configFile: result.configFile, initialCommit: result.initialCommit };
    for (const action of result.actions) addPlanEvent(record, at, 'initialize', action);
    if (this.options.onProjectReady !== undefined) await this.options.onProjectReady(result.configFile);
    record.state = 'ready';
    delete record.job;
    addPlanEvent(record, at, 'ready', `Project ready at ${result.root}. Start a run from its project page.`);
    await this.save(record);
  }

  private async save(record: PlanRecord): Promise<void> {
    record.updatedAt = this.now().toISOString();
    await this.store.save(record);
  }

  /** Names of the documents a plan has (for the dashboard). */
  static documentNames(): readonly string[] {
    return DOCUMENT_NAMES;
  }
}
