import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describeError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { redactSecrets } from '../security/redact.js';
import { runCommand } from '../testing/commandRunner.js';
import type { CodebaseSummary } from './codebase.js';
import type { IdeaInput, Proposal } from './model.js';
import { finalizePrompt, proposalPrompt } from './prompts.js';
import type { PlannerSettings } from './workspace.js';

export interface PlannerRequest {
  step: 'propose' | 'finalize';
  idea: IdeaInput;
  /** The approved proposal (finalize only). */
  proposal?: Proposal;
  /** Problems with the previous attempt's output, for a bounded repair. */
  previousIssues: string[];
  codebase?: CodebaseSummary;
  /** Empty working directory for a new project; the codebase itself for an existing one. */
  workingDirectory: string;
  /** Today's date, for retrieval dates of live research. */
  today: string;
}

export interface PlannerResult {
  /** Parsed JSON output, or undefined when none could be extracted. */
  output?: unknown;
  /** Why no usable output was produced. */
  error?: string;
  /** Claude Code's reported cost of this call (an estimate), when known. */
  costUsd?: number;
  /** False when the call may have spent money that was not reported. */
  costKnown: boolean;
  durationMs: number;
}

/** Turns an idea into a proposal, and an approved proposal into a full plan, as JSON. */
export interface ProductPlanner {
  readonly name: string;
  /** Whether the planner can use live web research. */
  readonly webResearch: boolean;
  run(request: PlannerRequest): Promise<PlannerResult>;
}

/** Extract the JSON object from a model's answer (plain JSON or a fenced ```json block). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the answer');
  return JSON.parse(candidate.slice(start, end + 1));
}

const HARDENING = ['--restricted', '--safe-mode', '--strict-mcp-config', '--permission-prompts', 'none', '--no-session-persistence', '--disable-slash-commands'];

/** Built-in tools the planner may get: reading an existing codebase, and optional live research. */
export function plannerTools(settings: PlannerSettings, existingCodebase: boolean): string[] {
  return [...(existingCodebase ? ['Read', 'Glob', 'Grep'] : []), ...(settings.webResearch ? ['WebSearch', 'WebFetch'] : [])];
}

/** Claude Code CLI arguments for one planner call. Never any tool that edits files or runs commands. */
export function plannerArgs(settings: PlannerSettings, tools: readonly string[]): string[] {
  const args = ['--print', '--output-format', 'json', '--permission-mode', 'dontAsk', '--tools', tools.join(',')];
  if (tools.length > 0) args.push('--allowedTools', tools.join(','));
  if (settings.model !== undefined) args.push('--model', settings.model);
  args.push(...HARDENING);
  if (settings.maxBudgetUsdPerCall !== undefined) args.push('--max-budget-usd', String(settings.maxBudgetUsdPerCall));
  return args;
}

/**
 * Planner backed by Claude Code in print mode. It has no tools that change
 * files or run commands: none for a new project, read-only file tools confined
 * to an existing codebase, and WebSearch/WebFetch only when live research is
 * enabled in the workspace. Each call is capped with --max-budget-usd.
 */
export class ClaudeCodePlanner implements ProductPlanner {
  readonly name = 'claude-code';
  readonly webResearch: boolean;
  private readonly run_: typeof runCommand;

  constructor(
    private readonly settings: PlannerSettings,
    private readonly options: { runCommand?: typeof runCommand; env?: NodeJS.ProcessEnv } = {},
  ) {
    this.webResearch = settings.webResearch;
    this.run_ = options.runCommand ?? runCommand;
  }

  async run(request: PlannerRequest): Promise<PlannerResult> {
    const tools = plannerTools(this.settings, request.codebase !== undefined);
    const source = this.options.env ?? process.env;
    const extraEnv: Record<string, string> = {};
    for (const name of this.settings.passEnv) if (source[name] !== undefined) extraEnv[name] = source[name]!;
    const secrets = Object.values(extraEnv).filter((v) => v.length > 0);
    const prompt = request.step === 'propose' ? proposalPrompt(request, this.webResearch) : finalizePrompt(request, this.webResearch);
    const result = await this.run_(
      {
        name: 'planner',
        executable: this.settings.executable,
        args: plannerArgs(this.settings, tools),
        cwd: request.workingDirectory,
        timeoutMs: this.settings.timeoutMs,
        maxOutputBytes: 4 * 1024 * 1024,
      },
      { stdin: redactSecrets(prompt, secrets), extraEnv, secrets },
    );
    const base = { durationMs: result.durationMs };
    if (result.error !== undefined) return { ...base, costKnown: true, error: `Claude Code could not be started: ${redactSecrets(result.error, secrets)}` };
    if (result.timedOut) return { ...base, costKnown: false, error: `The planner timed out after ${result.durationMs} ms` };
    if (result.truncated) return { ...base, costKnown: false, error: 'The planner output exceeded 4 MB' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { ...base, costKnown: false, error: `Claude Code exited with code ${result.exitCode} without JSON output` };
    }
    if (!isRecord(parsed)) return { ...base, costKnown: false, error: 'Claude Code output was not a JSON object' };
    const costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined;
    const withCost = { ...base, costKnown: costUsd !== undefined, ...(costUsd !== undefined ? { costUsd } : {}) };
    const text = typeof parsed.result === 'string' ? parsed.result : '';
    if (result.exitCode !== 0 || parsed.is_error === true || parsed.subtype !== 'success') {
      return { ...withCost, error: `Claude Code reported an error (${String(parsed.subtype ?? result.exitCode)}): ${redactSecrets(text, secrets).slice(0, 500)}` };
    }
    try {
      return { ...withCost, output: extractJson(redactSecrets(text, secrets)) };
    } catch (err) {
      return { ...withCost, error: `The planner's answer was not valid JSON (${describeError(err)})` };
    }
  }
}

/**
 * Deterministic planner that replays saved output (proposal.json and
 * plan.json in a directory). Used by tests and demos; it performs no AI calls
 * and costs nothing. Its documents are only as good as the saved plan.
 */
export class FixturePlanner implements ProductPlanner {
  readonly name = 'fixture';
  readonly webResearch = false;

  constructor(private readonly dir: string) {}

  async run(request: PlannerRequest): Promise<PlannerResult> {
    const file = path.join(this.dir, request.step === 'propose' ? 'proposal.json' : 'plan.json');
    try {
      return { output: JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')), costUsd: 0, costKnown: true, durationMs: 0 };
    } catch (err) {
      return { error: `Fixture planner cannot read ${path.basename(file)}: ${describeError(err)}`, costKnown: true, durationMs: 0 };
    }
  }
}

export function createPlanner(settings: PlannerSettings): ProductPlanner {
  return settings.type === 'fixture' ? new FixturePlanner(settings.fixtureDir!) : new ClaudeCodePlanner(settings);
}
