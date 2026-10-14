import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, ValidationError } from '../core/errors.js';
import { resolveInside } from '../security/paths.js';
import { arr, bool, int, obj, oneOf, opt, str, validate } from './schema.js';

/**
 * Factory workspace: where planned projects are created and how planning may
 * spend money. Written by a person (`factory.workspace.json`); the planner and
 * the dashboard can only read it.
 */
export interface WorkspaceConfig {
  file: string;
  /** Directory of the workspace file. */
  root: string;
  /** New projects are created as subdirectories of this directory. */
  projectsDir: string;
  /** Planning records and the project registry. */
  stateDir: string;
  /** Existing codebases may only be initialized under these directories. */
  existingProjectRoots: string[];
  planner: PlannerSettings;
  limits: { maxTasks: number };
  /** Executables generated project commands may use (bare names; real binaries, see commandRunner). */
  allowedExecutables: string[];
  /** Copied into every generated project's factory config. */
  projectDefaults: ProjectDefaults;
}

export interface PlannerSettings {
  type: 'claude-code' | 'fixture';
  executable: string;
  model?: string;
  timeoutMs: number;
  /** Cap per planner call (Claude Code --max-budget-usd). Required for a plan cost cap. */
  maxBudgetUsdPerCall?: number;
  /** Cap for all planner calls of one idea (estimated, from Claude Code's reported cost). */
  maxCostUsdPerPlan?: number;
  /** Planner calls per step (the first try plus repairs of invalid output). */
  maxAttemptsPerStep: number;
  /** Hard cap on planner calls for one idea, across all steps and retries. */
  maxCallsPerPlan: number;
  /** Lets the planner use WebSearch/WebFetch. Off by default: no live research, no extra cost. */
  webResearch: boolean;
  passEnv: string[];
  /** For type "fixture": directory with proposal.json and plan.json (replayed, no AI). */
  fixtureDir?: string;
}

export interface ProjectDefaults {
  maxTasksPerRun: number;
  maxRetries: number;
  agentTimeoutMs: number;
  commandTimeoutMs: number;
  maxRepairAttempts: number;
  agent: { model?: string; maxBudgetUsd?: number; passEnv: string[] };
  autonomy: { maxRunDurationMs: number; maxTaskDurationMs: number; maxCostUsd?: number };
  /** Auto-accept low-risk tasks without sensitive flags. Off: every result waits for a person. */
  autoAcceptLowRisk: boolean;
}

export const WORKSPACE_FILE = 'factory.workspace.json';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const EXECUTABLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const money = (min: number, max: number) => (v: unknown, p: string, issues: string[]) => {
  if (typeof v !== 'number' || !(v >= min && v <= max)) {
    issues.push(`${p} must be a number between ${min} and ${max}`);
    return undefined;
  }
  return v;
};

const workspaceCheck = obj({
  version: int(1, 1),
  projectsDir: opt(str({ max: 500 }), 'projects'),
  stateDir: opt(str({ max: 500 }), '.factory-workspace'),
  existingProjectRoots: opt(arr(str({ max: 1000 }), { max: 20 }), []),
  // Nested sections are always objects here (see withDefaults), so their own defaults apply.
  planner: obj({
    type: opt(oneOf(['claude-code', 'fixture'] as const), 'claude-code'),
    executable: opt(str({ pattern: EXECUTABLE, label: 'must be a bare executable name' }), 'claude'),
    model: opt(str({ max: 100 })),
    timeoutMs: opt(int(30_000, 60 * 60_000), 15 * 60_000),
    maxBudgetUsdPerCall: opt(money(0.01, 50)),
    maxCostUsdPerPlan: opt(money(0.01, 200)),
    maxAttemptsPerStep: opt(int(1, 5), 2),
    maxCallsPerPlan: opt(int(1, 50), 8),
    webResearch: opt(bool(), false),
    passEnv: opt(arr(str({ pattern: ENV_NAME, label: 'must be an environment variable name' }), { max: 10 }), []),
    fixtureDir: opt(str({ max: 1000 })),
  }),
  limits: obj({ maxTasks: opt(int(1, 200), 40) }),
  allowedExecutables: opt(arr(str({ pattern: EXECUTABLE, label: 'must be a bare executable name' }), { min: 1, max: 20 }), ['node']),
  projectDefaults: obj({
    maxTasksPerRun: opt(int(1, 50), 10),
    maxRetries: opt(int(0, 10), 2),
    agentTimeoutMs: opt(int(10_000, 4 * 60 * 60_000), 30 * 60_000),
    commandTimeoutMs: opt(int(1_000, 60 * 60_000), 10 * 60_000),
    maxRepairAttempts: opt(int(0, 3), 1),
    agent: obj({ model: opt(str({ max: 100 })), maxBudgetUsd: opt(money(0.01, 100)), passEnv: opt(arr(str({ pattern: ENV_NAME, label: 'must be an environment variable name' }), { max: 10 }), []) }),
    autonomy: obj({
      maxRunDurationMs: opt(int(60_000, 24 * 60 * 60_000), 2 * 60 * 60_000),
      maxTaskDurationMs: opt(int(10_000, 4 * 60 * 60_000), 45 * 60_000),
      maxCostUsd: opt(money(0.01, 500)),
    }),
    autoAcceptLowRisk: opt(bool(), false),
  }),
});

/** Apply defaults inside nested optional objects (opt() only fills missing top-level values). */
function withDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const sub = (key: string) => (typeof raw[key] === 'object' && raw[key] !== null ? (raw[key] as Record<string, unknown>) : {});
  const defaults = sub('projectDefaults');
  return {
    ...raw,
    planner: sub('planner'),
    limits: sub('limits'),
    projectDefaults: {
      ...defaults,
      agent: typeof defaults.agent === 'object' && defaults.agent !== null ? defaults.agent : {},
      autonomy: typeof defaults.autonomy === 'object' && defaults.autonomy !== null ? defaults.autonomy : {},
    },
  };
}

export function parseWorkspaceConfig(raw: unknown, file: string): WorkspaceConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError('Workspace config must be a JSON object');
  const { value, issues } = validate(workspaceCheck, withDefaults(raw as Record<string, unknown>), 'workspace');
  const root = path.dirname(file);
  if (value === undefined) throw new ValidationError('Invalid workspace config', issues);
  const problems: string[] = [];
  const inside = (p: string, label: string) => {
    try {
      return resolveInside(root, p, label);
    } catch (err) {
      problems.push((err as Error).message);
      return path.resolve(root, p);
    }
  };
  const projectsDir = inside(value.projectsDir!, 'workspace.projectsDir');
  const stateDir = inside(value.stateDir!, 'workspace.stateDir');
  const roots = value.existingProjectRoots!.map((r, i) => {
    if (!path.isAbsolute(r)) problems.push(`workspace.existingProjectRoots[${i}] must be an absolute path`);
    return path.resolve(r);
  });
  const planner = value.planner as PlannerSettings;
  if (planner.maxCostUsdPerPlan !== undefined && planner.maxBudgetUsdPerCall === undefined) {
    problems.push('workspace.planner.maxCostUsdPerPlan requires planner.maxBudgetUsdPerCall (the cap every planner call must fit into)');
  }
  if (planner.type === 'fixture' && planner.fixtureDir === undefined) problems.push('workspace.planner.fixtureDir is required for the fixture planner');
  const defaults = value.projectDefaults as ProjectDefaults;
  if (defaults.autonomy.maxCostUsd !== undefined && defaults.agent.maxBudgetUsd === undefined) {
    problems.push('workspace.projectDefaults.autonomy.maxCostUsd requires projectDefaults.agent.maxBudgetUsd');
  }
  if (problems.length > 0) throw new ValidationError('Invalid workspace config', problems);
  return {
    file,
    root,
    projectsDir,
    stateDir,
    existingProjectRoots: roots,
    planner: { ...planner, ...(planner.fixtureDir !== undefined ? { fixtureDir: path.resolve(root, planner.fixtureDir) } : {}) },
    limits: value.limits as { maxTasks: number },
    allowedExecutables: value.allowedExecutables!,
    projectDefaults: defaults,
  };
}

export async function loadWorkspaceConfig(file: string): Promise<WorkspaceConfig> {
  let absolute: string;
  try {
    absolute = await realpath(path.resolve(file));
  } catch {
    throw new PersistenceError(`Cannot open workspace file ${path.resolve(file)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse((await readFile(absolute, 'utf8')).replace(/^﻿/, ''));
  } catch (err) {
    throw new ValidationError(`Workspace file ${absolute} is not valid JSON: ${(err as Error).message}`);
  }
  return parseWorkspaceConfig(raw, absolute);
}
