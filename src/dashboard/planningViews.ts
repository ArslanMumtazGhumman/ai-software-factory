import { realpath } from 'node:fs/promises';
import { DOCUMENT_NAMES } from '../planning/documents.js';
import type { PlanRecord } from '../planning/planStore.js';
import type { PlanningService } from '../planning/planningService.js';
import { computeWaves } from '../planning/validatePlan.js';
import { NotFoundError } from './service.js';
import { projectIdFor } from './projects.js';
import { clean } from './views.js';

/** Read models for the idea-to-project workflow (everything redacted again before it is sent). */

const ACTIONS: Record<string, string[]> = {
  proposing: [],
  'needs-input': ['answer', 'reject'],
  proposed: ['approve', 'reject'],
  finalizing: [],
  'needs-attention': ['retry', 'reject'],
  invalid: ['retry', 'reject'],
  initializing: [],
  ready: [],
  rejected: [],
  failed: ['retry', 'reject'],
};

async function projectLink(record: PlanRecord): Promise<{ projectId: string; root: string } | null> {
  if (record.project === undefined) return null;
  const real = await realpath(record.project.configFile).catch(() => record.project!.configFile);
  return { projectId: projectIdFor(real), root: record.project.root };
}

export function workspaceView(planning: PlanningService | undefined) {
  if (planning === undefined) {
    return { enabled: false, reason: 'Start the dashboard with --workspace <factory.workspace.json> to create projects from ideas.' };
  }
  const w = planning.workspace;
  const p = w.planner;
  return {
    enabled: true,
    projectsDir: w.projectsDir,
    existingProjects: w.existingProjectRoots.length > 0,
    existingProjectRoots: w.existingProjectRoots,
    planner: {
      name: planning.plannerName,
      model: p.model ?? null,
      webResearch: p.webResearch,
      maxBudgetUsdPerCall: p.maxBudgetUsdPerCall ?? null,
      maxCostUsdPerPlan: p.maxCostUsdPerPlan ?? null,
      maxAttemptsPerStep: p.maxAttemptsPerStep,
      maxCallsPerPlan: p.maxCallsPerPlan,
    },
    maxTasks: w.limits.maxTasks,
    research: p.webResearch
      ? 'Live web research is enabled: sources the planner retrieves are recorded with URLs and dates.'
      : 'Live research is off: the planner uses only what you supply (and an existing codebase); external facts are labelled as assumptions.',
  };
}

export async function planSummaryView(entry: { record: PlanRecord; interrupted: boolean; running: boolean }) {
  const { record } = entry;
  return {
    planId: record.planId,
    name: record.proposal?.productName ?? record.idea.name,
    state: record.state,
    interrupted: entry.interrupted,
    running: entry.running,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    existing: record.existing !== undefined,
    project: await projectLink(record),
  };
}

export async function planDetailView(planning: PlanningService, planId: string) {
  let entry;
  try {
    entry = await planning.view(planId);
  } catch {
    throw new NotFoundError('Unknown plan.');
  }
  const { record } = entry;
  const plan = await planning.plan(planId);
  const tasks =
    plan === undefined
      ? []
      : plan.tasks.map((t) => ({ id: t.id, title: t.title, category: t.category, dependencies: t.dependencies, risk: t.risk, riskFlags: t.riskFlags, checks: t.checks, covers: t.covers, acceptanceCriteria: t.acceptanceCriteria, deliverables: t.deliverables, evidence: t.evidence }));
  const documents = [];
  for (const name of DOCUMENT_NAMES) if ((await planning.document(planId, name)) !== undefined) documents.push(name);
  const actions = entry.interrupted ? ['retry'] : entry.running ? [] : (ACTIONS[record.state] ?? []);
  return {
    planId: record.planId,
    state: record.state,
    interrupted: entry.interrupted,
    running: entry.running,
    actions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    idea: { ...record.idea, idea: clean(record.idea.idea, 10_000) ?? '', research: clean(record.idea.research, 20_000) ?? '' },
    existing: record.existing ?? null,
    proposal: record.proposal ?? null,
    proposalWarnings: record.proposalWarnings,
    validation: record.validation ?? null,
    failure: record.failure === undefined ? null : { ...record.failure, message: clean(record.failure.message) ?? '' },
    attention: record.attention ?? null,
    decision: record.decision ?? null,
    destination: record.destination ?? null,
    project: await projectLink(record),
    cost: {
      ...record.cost,
      kind: 'estimate',
      label: 'Planner cost reported by Claude Code (an estimate, not a bill)',
      capUsd: planning.workspace.planner.maxCostUsdPerPlan ?? null,
      maxCalls: planning.workspace.planner.maxCallsPerPlan,
    },
    attempts: record.attempts,
    tasks,
    waves: plan === undefined ? [] : computeWaves(plan.tasks),
    documents,
    events: record.events.map((e) => ({ ...e, message: clean(e.message, 2000) ?? '' })),
  };
}
