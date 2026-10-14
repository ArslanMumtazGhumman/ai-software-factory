import { DependencyError } from '../core/errors.js';
import { findSecretLikeContent } from '../security/redact.js';
import { assertValidDependencies } from '../tasks/dependencyGraph.js';
import type { IdeaInput, ProductPlan, Proposal, SourceRef, Statement } from './model.js';
import { SENSITIVE_FLAGS } from './model.js';
import type { WorkspaceConfig } from './workspace.js';

export interface PlanEstimate {
  tasks: number;
  /** Runs needed with the configured task limit per run. */
  runs: number;
  /** Agent calls if every task needs every repair attempt. */
  maxAgentCalls: number;
  /** Upper bound of agent cost (per-call cap x calls), when a per-call cap is configured. */
  maxCostUsd: number | null;
  /** Upper bound of agent time (task time limit x tasks). */
  maxDurationMs: number;
  notes: string[];
}

export interface PlanValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  estimate: PlanEstimate;
  /** Task ids in a dependency-respecting order, grouped into waves that could start together. */
  waves: string[][];
}

/** Forms a generated validation command may take (it runs after every task, so it must be narrow). */
const NODE_ARGS = /^--(test|run)$/;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9:_-]{0,40}$/;
const FORBIDDEN_WORD = /\b(install|ci|add|publish|deploy|login|logout|adduser|push|upgrade|exec|dlx|npx|link|unpublish|release)\b/i;
const SHELL_SYNTAX = /[|&;<>`$%^"']/;
/** Extra `node --test` arguments: test files/globs or --test-* options only (no --eval, --import, --require...). */
const TEST_ARG = /^(--test-[a-z-]+(=[A-Za-z0-9_./*:-]+)?|[A-Za-z0-9_][A-Za-z0-9_./*-]*)$/;

/** Statements must say how they are known; "verified" needs a source the planner could actually check. */
export function checkStatements(statements: readonly Statement[], sources: readonly SourceRef[], webResearch: boolean, where: string, errors: string[], warnings: string[]): void {
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.id)) errors.push(`${where}: source id ${s.id} is used twice`);
    ids.add(s.id);
    if (s.kind === 'web' && !webResearch) {
      errors.push(`${where}: source ${s.id} ("${s.title}") is marked as web research, but live research is disabled; it cannot have been retrieved`);
    }
    if (s.kind === 'web' && !/^https?:\/\//i.test(s.url)) errors.push(`${where}: web source ${s.id} needs an http(s) URL`);
    if (s.kind === 'web' && s.retrievedAt === '') warnings.push(`${where}: web source ${s.id} has no retrieval date`);
  }
  const byId = new Map(sources.map((s) => [s.id, s] as const));
  statements.forEach((st, i) => {
    for (const id of st.sourceIds) if (!byId.has(id)) errors.push(`${where}: statement ${i + 1} cites unknown source ${id}`);
    if (st.basis === 'verified') {
      const checked = st.sourceIds.map((id) => byId.get(id)).filter((s) => s !== undefined && s.kind !== 'user-supplied');
      if (checked.length === 0) errors.push(`${where}: statement ${i + 1} is marked verified but cites no web or codebase source ("${st.statement.slice(0, 80)}")`);
    }
  });
}

export function validateProposal(proposal: Proposal, idea: IdeaInput, workspace: WorkspaceConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  checkStatements(proposal.statements, proposal.sources, workspace.planner.webResearch, 'proposal', errors, warnings);
  for (const p of idea.platforms) if (!proposal.platforms.includes(p)) errors.push(`proposal drops the requested platform "${p}"`);
  if (idea.existingCodebasePath !== '' && proposal.projectType !== 'existing-codebase') errors.push('proposal must plan for the existing codebase (projectType "existing-codebase")');
  if (proposal.effort.estimatedTasks > workspace.limits.maxTasks) {
    warnings.push(`estimated ${proposal.effort.estimatedTasks} tasks exceeds the workspace limit of ${workspace.limits.maxTasks}; the plan must be narrowed`);
  }
  const text = JSON.stringify(proposal);
  for (const kind of findSecretLikeContent(text)) errors.push(`proposal contains something that looks like a secret (${kind})`);
  return { errors, warnings };
}

/**
 * Validate a full plan before any project is created: structure was already
 * checked by the schema; this checks consistency between the documents, the
 * task graph, coverage of the MVP, command policy, sources and limits.
 */
export function validatePlan(plan: ProductPlan, idea: IdeaInput, workspace: WorkspaceConfig, renderedDocs: Record<string, string> = {}): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unique = (ids: string[], label: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${label} id ${id} is used more than once`);
      seen.add(id);
    }
    return seen;
  };

  const { requirements, ux, dataModel, architecture, release } = plan;
  const reqIds = unique([...requirements.functional.map((r) => r.id), ...requirements.nonFunctional.map((r) => r.id)], 'requirement');
  unique(requirements.userStories.map((s) => s.id), 'user story');
  const screenIds = unique(ux.screens.map((s) => s.id), 'screen');
  const entityNames = unique(dataModel.entities.map((e) => e.name), 'entity');
  const taskIds = unique(plan.tasks.map((t) => t.id), 'task');
  const commandNames = unique(plan.commands.map((c) => c.name), 'command');

  // References between documents.
  for (const s of requirements.userStories) for (const r of s.requirementIds) if (!reqIds.has(r)) errors.push(`user story ${s.id} refers to unknown requirement ${r}`);
  for (const s of ux.screens) for (const r of s.requirementIds) if (!reqIds.has(r)) errors.push(`screen ${s.id} refers to unknown requirement ${r}`);
  const envNames = new Set(release.environmentVariables.map((v) => v.name));
  for (const integration of architecture.integrations) {
    for (const key of integration.configKeys) {
      if (!envNames.has(key)) errors.push(`integration "${integration.name}" needs ${key}, which is not documented in the release plan's environment variables`);
    }
    if (integration.paid) warnings.push(`integration "${integration.name}" is a paid service; creating accounts or paid resources needs a person (never automated)`);
    if (!integration.verified) warnings.push(`integration "${integration.name}": API access and capabilities are not verified`);
  }
  for (const p of idea.platforms) if (!architecture.platforms.includes(p)) errors.push(`architecture drops the requested platform "${p}"`);
  if (idea.existingCodebasePath !== '' && architecture.projectType !== 'existing-codebase') errors.push('architecture must extend the existing codebase (projectType "existing-codebase")');

  // Conflicts: something both in and out of scope.
  const outOfScope = new Set(plan.product.outOfScope.map((s) => s.trim().toLowerCase()));
  for (const item of plan.product.mvpScope) if (outOfScope.has(item.trim().toLowerCase())) errors.push(`"${item}" is listed both in the MVP scope and out of scope`);
  for (const r of requirements.functional) if (r.mvp && outOfScope.has(r.title.trim().toLowerCase())) errors.push(`MVP requirement ${r.id} ("${r.title}") is also listed as out of scope`);

  // Commands: only narrow, allowlisted forms; never installs, publishes or deploys.
  for (const c of plan.commands) {
    if (!workspace.allowedExecutables.includes(c.executable)) {
      errors.push(`command "${c.name}" uses "${c.executable}", which is not in the workspace's allowedExecutables (${workspace.allowedExecutables.join(', ')})`);
    }
    if (c.executable === 'node') {
      if (!NODE_ARGS.test(c.args[0] ?? '')) errors.push(`command "${c.name}": node commands must be "node --test [files]" or "node --run <script>"`);
      if (c.args[0] === '--run' && (c.args.length !== 2 || !SCRIPT_NAME.test(c.args[1] ?? '') || FORBIDDEN_WORD.test(c.args[1] ?? ''))) {
        errors.push(`command "${c.name}": "node --run" takes exactly one package.json script name, and not an install, publish or deploy script`);
      }
      if (c.args[0] === '--test') {
        for (const a of c.args.slice(1)) if (!TEST_ARG.test(a)) errors.push(`command "${c.name}": "node --test" only takes test files and --test-* options (got "${a}")`);
      }
    } else {
      for (const a of c.args) if (FORBIDDEN_WORD.test(a)) errors.push(`command "${c.name}" has a disallowed argument "${a}" (no installs, publishing or deployment)`);
    }
    for (const a of c.args) if (SHELL_SYNTAX.test(a)) errors.push(`command "${c.name}" has shell syntax in "${a}"`);
  }
  for (const name of plan.defaultChecks) if (!commandNames.has(name)) errors.push(`defaultChecks refers to unknown command "${name}"`);

  // Tasks.
  const covered = new Set<string>();
  const usedEntities = new Set<string>();
  const usedScreens = new Set<string>();
  for (const t of plan.tasks) {
    for (const c of t.checks) if (!commandNames.has(c)) errors.push(`task ${t.id} requires check "${c}", which is not a defined command`);
    for (const r of t.covers) {
      if (!reqIds.has(r)) errors.push(`task ${t.id} covers unknown requirement ${r}`);
      covered.add(r);
    }
    for (const e of t.entities) {
      if (!entityNames.has(e)) errors.push(`task ${t.id} refers to unknown entity ${e}`);
      usedEntities.add(e);
    }
    for (const s of t.screens) {
      if (!screenIds.has(s)) errors.push(`task ${t.id} refers to unknown screen ${s}`);
      usedScreens.add(s);
    }
    const sensitive = t.riskFlags.filter((f) => SENSITIVE_FLAGS.includes(f));
    if (sensitive.length > 0 && t.risk === 'low') errors.push(`task ${t.id} is flagged ${sensitive.join(', ')} and cannot be low risk`);
    if (t.riskFlags.includes('deployment') || t.riskFlags.includes('paid-resource')) {
      warnings.push(`task ${t.id} touches ${t.riskFlags.filter((f) => f === 'deployment' || f === 'paid-resource').join(' and ')}: the factory only prepares it; a person must deploy or buy anything`);
    }
    if (t.covers.length === 0 && t.category === 'feature') warnings.push(`feature task ${t.id} does not cover any requirement`);
  }
  for (const r of requirements.functional) if (r.mvp && !covered.has(r.id)) errors.push(`MVP requirement ${r.id} ("${r.title}") is not covered by any task`);
  for (const r of requirements.nonFunctional) if (r.mvp && !covered.has(r.id)) errors.push(`MVP requirement ${r.id} (${r.category}) is not covered by any task`);
  for (const e of entityNames) if (!usedEntities.has(e)) errors.push(`entity ${e} appears in the data model but no task implements it`);
  for (const s of ux.screens) if (!usedScreens.has(s.id)) errors.push(`screen ${s.id} ("${s.name}") is in the UX plan but no task builds it`);
  for (const r of requirements.functional) if (!r.mvp && covered.has(r.id)) warnings.push(`post-MVP requirement ${r.id} is already in the backlog`);

  // Dependency graph (the existing task engine's own rules).
  const graphTasks = plan.tasks.map((t) => ({ id: t.id, title: t.title, description: t.scope, dependencies: t.dependencies, acceptanceCriteria: t.acceptanceCriteria, status: 'pending' as const, retryCount: 0, results: [] }));
  try {
    assertValidDependencies(graphTasks);
  } catch (err) {
    if (err instanceof DependencyError) errors.push(...err.issues.map((i) => `task graph: ${i}`));
    else throw err;
  }
  const waves = errors.some((e) => e.startsWith('task graph:')) ? [] : computeWaves(plan.tasks);
  if (waves.length > 0 && waves[0]!.length === 0) errors.push('task graph has no task that can start first');

  // Sources and claims.
  checkStatements(plan.statements, plan.sources, workspace.planner.webResearch, 'plan', errors, warnings);
  if (plan.openQuestions.length > 0) warnings.push(`${plan.openQuestions.length} open question(s) are recorded; defaults were assumed`);
  if (!plan.feasibility.feasible) errors.push(`planner reports the product is not feasible as approved: ${plan.feasibility.issues.join('; ') || 'no details'}`);

  // Secrets must never reach generated documents.
  for (const [name, text] of Object.entries({ plan: JSON.stringify(plan), ...renderedDocs })) {
    for (const kind of findSecretLikeContent(text)) errors.push(`${name} contains something that looks like a secret (${kind})`);
  }

  // Limits.
  const d = workspace.projectDefaults;
  if (plan.tasks.length > workspace.limits.maxTasks) {
    errors.push(`the backlog has ${plan.tasks.length} tasks; the workspace allows at most ${workspace.limits.maxTasks} (limits.maxTasks)`);
  }
  if (taskIds.size !== plan.tasks.length) errors.push('task ids must be unique');
  const callsPerTask = 1 + d.maxRepairAttempts;
  const perCall = d.agent.maxBudgetUsd;
  const estimate: PlanEstimate = {
    tasks: plan.tasks.length,
    runs: Math.ceil(plan.tasks.length / d.maxTasksPerRun),
    maxAgentCalls: plan.tasks.length * callsPerTask,
    maxCostUsd: perCall === undefined ? null : Math.round(plan.tasks.length * callsPerTask * perCall * 100) / 100,
    maxDurationMs: plan.tasks.length * d.autonomy.maxTaskDurationMs,
    notes: [
      `Upper bounds, not predictions: every task may use ${callsPerTask} agent call(s) and up to ${Math.round(d.autonomy.maxTaskDurationMs / 60000)} min.`,
      perCall === undefined
        ? 'No per-call budget is configured (projectDefaults.agent.maxBudgetUsd), so cost is not bounded per call.'
        : `Each call is capped by Claude Code at $${perCall} (its own estimate, not a bill).`,
      d.autonomy.maxCostUsd === undefined ? 'No run cost cap is configured.' : `Each run stops before a call that its $${d.autonomy.maxCostUsd} budget cannot cover.`,
      `At most ${d.maxTasksPerRun} task(s) per run and ${Math.round(d.autonomy.maxRunDurationMs / 60000)} min of active time per run.`,
    ],
  };
  if (d.autonomy.maxCostUsd !== undefined && perCall !== undefined && d.autonomy.maxCostUsd + 1e-9 < perCall) {
    errors.push(`the run budget ($${d.autonomy.maxCostUsd}) cannot cover a single agent call ($${perCall})`);
  }
  if (d.autonomy.maxTaskDurationMs > d.autonomy.maxRunDurationMs) errors.push('the task time limit is longer than the run time limit');

  return { valid: errors.length === 0, errors, warnings, estimate, waves };
}

/** Group tasks into waves: each wave only depends on earlier waves. Assumes an acyclic graph. */
export function computeWaves(tasks: readonly { id: string; dependencies: string[] }[]): string[][] {
  const level = new Map<string, number>();
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const depth = (id: string, seen: Set<string>): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = byId.get(id)?.dependencies ?? [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((x) => depth(x, seen)));
    level.set(id, d);
    return d;
  };
  for (const t of tasks) depth(t.id, new Set());
  const waves: string[][] = [];
  for (const t of tasks) (waves[level.get(t.id)!] ??= []).push(t.id);
  return waves.map((w) => w ?? []);
}
