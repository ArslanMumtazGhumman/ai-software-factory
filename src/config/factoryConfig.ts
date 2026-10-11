import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError, ValidationError } from '../core/errors.js';
import { isRecord, readInteger, readString, readStringArray, type Issues } from '../core/validation.js';
import { resolveInside } from '../security/paths.js';

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
  /** Timeout for a single coding-agent invocation (used once execution is enabled). */
  agentTimeoutMs: number;
}

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface ClaudeCodeAgentConfig {
  type: 'claude-code';
  executable: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  allowedTools: string[];
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
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  maxRetries: 2,
  maxTasksPerRun: 1,
  commandTimeoutMs: 5 * 60_000,
  maxOutputBytes: 64 * 1024,
  agentTimeoutMs: 30 * 60_000,
};

export const LIMIT_BOUNDS: Record<keyof ExecutionLimits, { min: number; max: number }> = {
  maxRetries: { min: 0, max: 10 },
  maxTasksPerRun: { min: 1, max: 50 },
  commandTimeoutMs: { min: 1_000, max: 60 * 60_000 },
  maxOutputBytes: { min: 1_024, max: 10 * 1024 * 1024 },
  agentTimeoutMs: { min: 10_000, max: 4 * 60 * 60_000 },
};

const PERMISSION_MODES: readonly ClaudePermissionMode[] = ['default', 'acceptEdits', 'plan'];
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** Executables are bare names like `node` or `git` — never paths or shell snippets. */
const EXECUTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

  if (issues.length > 0) throw new ValidationError('Invalid factory config', issues);

  return { version: 1, projectRoot, dataDir, limits, allowedExecutables, commands, agent };
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
  return {
    type: 'claude-code',
    executable,
    permissionMode: permissionMode as ClaudePermissionMode,
    allowedTools,
    ...(model !== undefined ? { model } : {}),
  };
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
    raw = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`Config file ${absolute} is not valid JSON: ${(err as Error).message}`);
  }
  return parseFactoryConfig(raw, path.dirname(absolute));
}
