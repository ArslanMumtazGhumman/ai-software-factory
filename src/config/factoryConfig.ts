import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, ValidationError } from '../core/errors.js';
import { isRecord, readInteger, readString, readStringArray, type Issues } from '../core/validation.js';
import { resolveInside } from '../security/paths.js';
import { TASK_ID } from '../tasks/task.js';

/** A named command the factory may run, e.g. the project's test suite. */
export interface CommandSpec {
  /** Bare executable name; must appear in `allowedExecutables`. */
  executable: string;
  /** Arguments passed verbatim (no shell interpretation). */
  args: string[];
  description?: string;
  /** Overrides `limits.commandTimeoutMs` for this command. */
  timeoutMs?: number;
}

export interface ExecutionLimits {
  /** Retries allowed after the first failed attempt of a task. */
  maxRetries: number;
  /** Upper bound on tasks selected/handled in a single run. */
  maxTasksPerRun: number;
  /** Default timeout for configured commands. */
  commandTimeoutMs: number;
  /** Captured stdout/stderr per stream is truncated beyond this size. */
  maxOutputBytes: number;
  /** Timeout for a single coding-agent invocation. */
  agentTimeoutMs: number;
  /** Captured coding-agent stdout/stderr per stream is truncated beyond this size. */
  agentMaxOutputBytes: number;
}

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk';

export interface ClaudeCodeAgentConfig {
  type: 'claude-code';
  executable: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  /** Tools auto-approved without a prompt (--allowedTools). */
  allowedTools: string[];
  /** Built-in tools that exist for the agent at all (--tools). */
  tools: string[];
  /** Optional spend cap per invocation (--max-budget-usd). */
  maxBudgetUsd?: number;
  /** Environment variable names (e.g. ANTHROPIC_API_KEY) passed to the agent; their values are redacted from output. */
  passEnv: string[];
}

/** Supervised execution settings. Execution is off unless explicitly enabled. */
export interface ExecutionConfig {
  enabled: boolean;
  /** Names from `commands` run in the worktree after the agent exits. At least one is required to execute. */
  validationCommands: string[];
  /** If non-empty, every changed file must be under one of these repo-relative path prefixes. */
  allowedPaths: string[];
  /** Extra repo-relative path prefixes the agent must never change (built-in ones always apply). */
  protectedPaths: string[];
  maxChangedFiles: number;
  maxDiffBytes: number;
  allowDeletions: boolean;
  /** Bounded repair attempts after a validation failure (0 disables repair). */
  maxRepairAttempts: number;
}

/** Which low-risk results may be accepted without a human. Off unless explicitly enabled. */
export interface AutoAcceptPolicy {
  enabled: boolean;
  /** Only these task ids are ever auto-accepted. */
  taskIds: string[];
  /** Every changed file must be under one of these repo-relative prefixes. */
  paths: string[];
  maxChangedFiles: number;
  maxDiffBytes: number;
}

/** Bounded autonomous runs. Off unless explicitly enabled. */
export interface AutonomyConfig {
  enabled: boolean;
  /** Active (non-paused) time budget for one autonomous run. */
  maxRunDurationMs: number;
  /** Time budget for one task, including repair attempts. */
  maxTaskDurationMs: number;
  /** Total measured agent cost per autonomous run; requires agent.maxBudgetUsd. */
  maxCostUsd?: number;
  autoAccept: AutoAcceptPolicy;
}

export interface FactoryConfig {
  version: 1;
  /** Absolute path to the project the factory is allowed to operate on. */
  projectRoot: string;
  /** Absolute path to the JSON state directory (inside projectRoot). */
  dataDir: string;
  limits: ExecutionLimits;
  allowedExecutables: string[];
  commands: Record<string, CommandSpec>;
  agent: ClaudeCodeAgentConfig;
  execution: ExecutionConfig;
  autonomy: AutonomyConfig;
  /** Absolute path of the config file, when loaded from disk. Agents may never change it. */
  configFile?: string;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxRetries: 2,
  maxTasksPerRun: 1,
  commandTimeoutMs: 5 * 60_000,
  maxOutputBytes: 64 * 1024,
  agentTimeoutMs: 30 * 60_000,
  agentMaxOutputBytes: 1024 * 1024,
};

export const LIMIT_BOUNDS: Record<keyof ExecutionLimits, { min: number; max: number }> = {
  maxRetries: { min: 0, max: 10 },
  maxTasksPerRun: { min: 1, max: 50 },
  commandTimeoutMs: { min: 1_000, max: 60 * 60_000 },
  maxOutputBytes: { min: 1_024, max: 10 * 1024 * 1024 },
  agentTimeoutMs: { min: 10_000, max: 4 * 60 * 60_000 },
  agentMaxOutputBytes: { min: 64 * 1024, max: 16 * 1024 * 1024 },
};

export const DEFAULT_EXECUTION: ExecutionConfig = {
  enabled: false,
  validationCommands: [],
  allowedPaths: [],
  protectedPaths: [],
  maxChangedFiles: 50,
  maxDiffBytes: 1024 * 1024,
  allowDeletions: false,
  maxRepairAttempts: 0,
};

export const DEFAULT_AUTONOMY: AutonomyConfig = {
  enabled: false,
  maxRunDurationMs: 2 * 60 * 60_000,
  maxTaskDurationMs: 45 * 60_000,
  autoAccept: { enabled: false, taskIds: [], paths: [], maxChangedFiles: 5, maxDiffBytes: 20_000 },
};

export const MAX_REPAIR_ATTEMPTS = 3;

const PERMISSION_MODES: readonly ClaudePermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** Executables are bare names like `node` or `git` — never paths or shell snippets. */
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Validate a raw (parsed JSON) config object. Relative paths are resolved
 * against `baseDir`, normally the directory containing the config file.
 */
export function parseFactoryConfig(raw: unknown, baseDir: string): FactoryConfig {
  const issues: Issues = [];
  if (!isRecord(raw)) throw new ValidationError('Config must be a JSON object');

  if (raw.version !== 1) issues.push('config.version must be 1');

  const projectRootRaw = readString(raw, 'projectRoot', 'config', issues, { optional: true }) ?? '.';
  const projectRoot = path.resolve(baseDir, projectRootRaw);

  const dataDirRaw = readString(raw, 'dataDir', 'config', issues, { optional: true }) ?? '.factory';
  let dataDir = path.resolve(projectRoot, dataDirRaw);
  try {
    dataDir = resolveInside(projectRoot, dataDirRaw, 'config.dataDir');
  } catch (err) {
    issues.push((err as Error).message);
  }

  const limits = parseLimits(raw.limits, issues);

  const allowedExecutables = readStringArray(raw, 'allowedExecutables', 'config', issues, { optional: true }) ?? [];
  allowedExecutables.forEach((exe, i) => {
    if (!EXECUTABLE_NAME.test(exe)) {
      issues.push(`config.allowedExecutables[${i}] must be a bare executable name (got "${exe}")`);
    }
  });

  const commands = parseCommands(raw.commands, allowedExecutables, issues);
  const agent = parseAgent(raw.agent, issues);
  const execution = parseExecution(raw.execution, commands, issues);
  const autonomy = parseAutonomy(raw.autonomy, issues);
  if (autonomy.enabled && !execution.enabled) issues.push('config.autonomy.enabled requires config.execution.enabled');
  if (autonomy.maxCostUsd !== undefined && agent.maxBudgetUsd === undefined) {
    issues.push('config.autonomy.maxCostUsd requires config.agent.maxBudgetUsd, the per-call budget every call must fit into');
  }

  if (issues.length > 0) throw new ValidationError('Invalid factory config', issues);

  return { version: 1, projectRoot, dataDir, limits, allowedExecutables, commands, agent, execution, autonomy };
}

function parseLimits(raw: unknown, issues: Issues): ExecutionLimits {
  if (raw === undefined) return { ...DEFAULT_LIMITS };
  if (!isRecord(raw)) {
    issues.push('config.limits must be an object');
    return { ...DEFAULT_LIMITS };
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(raw)) {
    if (!(key in LIMIT_BOUNDS)) issues.push(`config.limits.${key} is not a known limit`);
  }
  for (const key of Object.keys(LIMIT_BOUNDS) as (keyof ExecutionLimits)[]) {
    const value = readInteger(raw, key, 'config.limits', issues, { ...LIMIT_BOUNDS[key], optional: true });
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}

function parseCommands(raw: unknown, allowedExecutables: readonly string[], issues: Issues): Record<string, CommandSpec> {
  const commands: Record<string, CommandSpec> = {};
  if (raw === undefined) return commands;
  if (!isRecord(raw)) {
    issues.push('config.commands must be an object');
    return commands;
  }
  for (const [name, spec] of Object.entries(raw)) {
    const p = `config.commands.${name}`;
    if (!COMMAND_NAME.test(name)) {
      issues.push(`${p}: command names must match ${COMMAND_NAME}`);
      continue;
    }
    if (!isRecord(spec)) {
      issues.push(`${p} must be an object`);
      continue;
    }
    const executable = readString(spec, 'executable', p, issues);
    const args = readStringArray(spec, 'args', p, issues, { optional: true }) ?? [];
    const description = readString(spec, 'description', p, issues, { optional: true });
    const timeoutMs = readInteger(spec, 'timeoutMs', p, issues, { ...LIMIT_BOUNDS.commandTimeoutMs, optional: true });
    if (executable === undefined) continue;
    if (!EXECUTABLE_NAME.test(executable)) {
      issues.push(`${p}.executable must be a bare executable name (got "${executable}")`);
      continue;
    }
    if (!allowedExecutables.includes(executable)) {
      issues.push(`${p}.executable "${executable}" is not in config.allowedExecutables`);
      continue;
    }
    commands[name] = {
      executable,
      args,
      ...(description !== undefined ? { description } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }
  return commands;
}

function parseAgent(raw: unknown, issues: Issues): ClaudeCodeAgentConfig {
  const fallback: ClaudeCodeAgentConfig = {
    type: 'claude-code',
    executable: 'claude',
    permissionMode: 'plan',
    allowedTools: ['Read', 'Glob', 'Grep'],
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    passEnv: [],
  };
  if (raw === undefined) return fallback;
  if (!isRecord(raw)) {
    issues.push('config.agent must be an object');
    return fallback;
  }
  if (raw.type !== undefined && raw.type !== 'claude-code') issues.push('config.agent.type must be "claude-code"');
  const executable = readString(raw, 'executable', 'config.agent', issues, { optional: true }) ?? fallback.executable;
  if (!EXECUTABLE_NAME.test(executable)) issues.push('config.agent.executable must be a bare executable name');
  const model = readString(raw, 'model', 'config.agent', issues, { optional: true });
  const permissionMode = readString(raw, 'permissionMode', 'config.agent', issues, { optional: true }) ?? fallback.permissionMode;
  if (!PERMISSION_MODES.includes(permissionMode as ClaudePermissionMode)) {
    issues.push(`config.agent.permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
  }
  const allowedTools = readStringArray(raw, 'allowedTools', 'config.agent', issues, { optional: true }) ?? fallback.allowedTools;
  const tools = readStringArray(raw, 'tools', 'config.agent', issues, { optional: true }) ?? fallback.tools;
  const passEnv = readStringArray(raw, 'passEnv', 'config.agent', issues, { optional: true }) ?? [];
  passEnv.forEach((name, i) => {
    if (!ENV_NAME.test(name)) issues.push(`config.agent.passEnv[${i}] is not a valid environment variable name`);
  });
  let maxBudgetUsd: number | undefined;
  if (raw.maxBudgetUsd !== undefined) {
    const value = raw.maxBudgetUsd;
    if (typeof value !== 'number' || !(value >= 0.01 && value <= 100)) {
      issues.push('config.agent.maxBudgetUsd must be a number between 0.01 and 100');
    } else {
      maxBudgetUsd = value;
    }
  }
  return {
    type: 'claude-code',
    executable,
    permissionMode: permissionMode as ClaudePermissionMode,
    allowedTools,
    tools,
    passEnv,
    ...(model !== undefined ? { model } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
}

const EXECUTION_KEYS = new Set([
  'enabled',
  'validationCommands',
  'allowedPaths',
  'protectedPaths',
  'maxChangedFiles',
  'maxDiffBytes',
  'allowDeletions',
  'maxRepairAttempts',
]);

function readBoolean(obj: Record<string, unknown>, key: string, path: string, issues: Issues): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    issues.push(`${path}.${key} must be true or false`);
    return undefined;
  }
  return value;
}

function parseExecution(raw: unknown, commands: Record<string, CommandSpec>, issues: Issues): ExecutionConfig {
  const execution: ExecutionConfig = { ...DEFAULT_EXECUTION };
  if (raw === undefined) return execution;
  const p = 'config.execution';
  if (!isRecord(raw)) {
    issues.push(`${p} must be an object`);
    return execution;
  }
  for (const key of Object.keys(raw)) {
    if (!EXECUTION_KEYS.has(key)) issues.push(`${p}.${key} is not a known setting`);
  }
  execution.enabled = readBoolean(raw, 'enabled', p, issues) ?? execution.enabled;
  execution.allowDeletions = readBoolean(raw, 'allowDeletions', p, issues) ?? execution.allowDeletions;
  execution.validationCommands = readStringArray(raw, 'validationCommands', p, issues, { optional: true }) ?? [];
  for (const name of execution.validationCommands) {
    if (!Object.prototype.hasOwnProperty.call(commands, name)) {
      issues.push(`${p}.validationCommands references unknown command "${name}"`);
    }
  }
  for (const key of ['allowedPaths', 'protectedPaths'] as const) {
    const paths = readStringArray(raw, key, p, issues, { optional: true }) ?? [];
    paths.forEach((value, i) => {
      if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        issues.push(`${p}.${key}[${i}] must be a relative path inside the repository`);
      }
    });
    execution[key] = paths;
  }
  execution.maxChangedFiles =
    readInteger(raw, 'maxChangedFiles', p, issues, { min: 1, max: 1000, optional: true }) ?? execution.maxChangedFiles;
  execution.maxDiffBytes =
    readInteger(raw, 'maxDiffBytes', p, issues, { min: 1024, max: 32 * 1024 * 1024, optional: true }) ?? execution.maxDiffBytes;
  execution.maxRepairAttempts =
    readInteger(raw, 'maxRepairAttempts', p, issues, { min: 0, max: MAX_REPAIR_ATTEMPTS, optional: true }) ?? execution.maxRepairAttempts;
  return execution;
}

const AUTONOMY_KEYS = new Set(['enabled', 'maxRunDurationMs', 'maxTaskDurationMs', 'maxCostUsd', 'autoAccept']);
const AUTO_ACCEPT_KEYS = new Set(['enabled', 'taskIds', 'paths', 'maxChangedFiles', 'maxDiffBytes']);

function parseAutonomy(raw: unknown, issues: Issues): AutonomyConfig {
  const autonomy: AutonomyConfig = { ...DEFAULT_AUTONOMY, autoAccept: { ...DEFAULT_AUTONOMY.autoAccept } };
  if (raw === undefined) return autonomy;
  const p = 'config.autonomy';
  if (!isRecord(raw)) {
    issues.push(`${p} must be an object`);
    return autonomy;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTONOMY_KEYS.has(key)) issues.push(`${p}.${key} is not a known setting`);
  }
  autonomy.enabled = readBoolean(raw, 'enabled', p, issues) ?? autonomy.enabled;
  autonomy.maxRunDurationMs =
    readInteger(raw, 'maxRunDurationMs', p, issues, { min: 60_000, max: 24 * 60 * 60_000, optional: true }) ?? autonomy.maxRunDurationMs;
  autonomy.maxTaskDurationMs =
    readInteger(raw, 'maxTaskDurationMs', p, issues, { min: 10_000, max: 4 * 60 * 60_000, optional: true }) ?? autonomy.maxTaskDurationMs;
  if (raw.maxCostUsd !== undefined) {
    const value = raw.maxCostUsd;
    if (typeof value !== 'number' || !(value >= 0.01 && value <= 500)) issues.push(`${p}.maxCostUsd must be a number between 0.01 and 500`);
    else autonomy.maxCostUsd = value;
  }
  if (raw.autoAccept !== undefined) autonomy.autoAccept = parseAutoAccept(raw.autoAccept, `${p}.autoAccept`, issues);
  return autonomy;
}

function parseAutoAccept(raw: unknown, p: string, issues: Issues): AutoAcceptPolicy {
  const policy: AutoAcceptPolicy = { ...DEFAULT_AUTONOMY.autoAccept };
  if (!isRecord(raw)) {
    issues.push(`${p} must be an object`);
    return policy;
  }
  for (const key of Object.keys(raw)) {
    if (!AUTO_ACCEPT_KEYS.has(key)) issues.push(`${p}.${key} is not a known setting`);
  }
  policy.enabled = readBoolean(raw, 'enabled', p, issues) ?? false;
  policy.taskIds = readStringArray(raw, 'taskIds', p, issues, { optional: true }) ?? [];
  policy.taskIds.forEach((id, i) => {
    if (!TASK_ID.test(id)) issues.push(`${p}.taskIds[${i}] is not a valid task id (wildcards are not supported)`);
  });
  policy.paths = readStringArray(raw, 'paths', p, issues, { optional: true }) ?? [];
  policy.paths.forEach((value, i) => {
    const clean = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || clean === '' || clean === '.') {
      issues.push(`${p}.paths[${i}] must be a specific relative directory or file inside the repository`);
    }
  });
  policy.maxChangedFiles = readInteger(raw, 'maxChangedFiles', p, issues, { min: 1, max: 50, optional: true }) ?? policy.maxChangedFiles;
  policy.maxDiffBytes = readInteger(raw, 'maxDiffBytes', p, issues, { min: 256, max: 256 * 1024, optional: true }) ?? policy.maxDiffBytes;
  if (policy.enabled && (policy.taskIds.length === 0 || policy.paths.length === 0)) {
    issues.push(`${p} requires non-empty taskIds and paths when enabled`);
  }
  return policy;
}

/** Read and validate a config file from disk. */
export async function loadFactoryConfig(configPath: string): Promise<FactoryConfig> {
  const absolute = path.resolve(configPath);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new PersistenceError(`Cannot read config file ${absolute}`, { cause: err });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new ValidationError(`Config file ${absolute} is not valid JSON: ${(err as Error).message}`);
  }
  return { ...parseFactoryConfig(raw, path.dirname(absolute)), configFile: absolute };
}
