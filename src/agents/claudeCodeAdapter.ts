import type { ClaudeCodeAgentConfig, ExecutionLimits } from '../config/factoryConfig.js';
import { AgentExecutionDisabledError, ExecutionPolicyError, describeError } from '../core/errors.js';
import { isRecord } from '../core/validation.js';
import { resolveInside } from '../security/paths.js';
import { redactSecrets } from '../security/redact.js';
import { runCommand, type CommandResult } from '../testing/commandRunner.js';
import type {
  AgentExecutionHooks,
  AgentInvocationPlan,
  AgentRunDetails,
  AgentRunResult,
  AgentTaskRequest,
  CodingAgent,
} from './codingAgent.js';
import { buildRepairPrompt, buildTaskPrompt } from './promptBuilder.js';

/**
 * File tools only. No Bash/PowerShell/REPL (code execution), no WebFetch or
 * WebSearch (network), no Task/Agent (sub-agents), no MCP.
 */
export const SAFE_AGENT_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit'];

/** Permission modes that allow file edits without prompting and never bypass checks. */
export const EXECUTION_PERMISSION_MODES: readonly string[] = ['dontAsk', 'acceptEdits'];

/**
 * Flags verified against Claude Code 2.1.296 (`claude --help`):
 *  --restricted               removes command-running tools and WebFetch, ignores user/project/local
 *                             settings, confines file tools to the working directory, refuses bypassPermissions
 *  --safe-mode                disables CLAUDE.md, hooks, plugins, skills, MCP servers and custom agents
 *  --strict-mcp-config        with no --mcp-config: no MCP servers at all
 *  --tools                    the only built-in tools that exist for the session
 *  --permission-prompts none  anything that would prompt is denied automatically
 *  --no-session-persistence   no transcript written to disk
 *  --disable-slash-commands   no skills
 */
const HARDENING_FLAGS: readonly string[] = [
  '--restricted',
  '--safe-mode',
  '--strict-mcp-config',
  '--permission-prompts',
  'none',
  '--no-session-persistence',
  '--disable-slash-commands',
];

export interface ClaudeCodeAdapterOptions {
  /** Real execution happens only when true (from config.execution.enabled). */
  executionEnabled?: boolean;
  /** Injectable process runner for tests. */
  runCommand?: typeof runCommand;
  /** Source of environment values for `passEnv` (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/** Throws ExecutionPolicyError unless the agent config is safe to execute. */
export function assertSafeAgentConfig(config: ClaudeCodeAgentConfig): void {
  const problems: string[] = [];
  if (!EXECUTION_PERMISSION_MODES.includes(config.permissionMode)) {
    problems.push(`agent.permissionMode must be one of ${EXECUTION_PERMISSION_MODES.join(', ')} to execute (got "${config.permissionMode}")`);
  }
  if (config.tools.length === 0) problems.push('agent.tools must list at least one tool');
  for (const tool of [...config.tools, ...config.allowedTools]) {
    if (!SAFE_AGENT_TOOLS.includes(tool)) {
      problems.push(`tool "${tool}" is not allowed for execution (allowed: ${SAFE_AGENT_TOOLS.join(', ')})`);
    }
  }
  for (const tool of config.allowedTools) {
    if (!config.tools.includes(tool)) problems.push(`agent.allowedTools entry "${tool}" is not in agent.tools`);
  }
  if (problems.length > 0) throw new ExecutionPolicyError(`Unsafe agent configuration:\n  - ${problems.join('\n  - ')}`);
}

/**
 * Claude Code integration. Invokes the `claude` CLI non-interactively in print
 * mode, without a shell, with the prompt on stdin and the working directory
 * set explicitly. Execution is refused unless enabled in config.
 */
export class ClaudeCodeAdapter implements CodingAgent {
  readonly name = 'claude-code';
  private readonly run: typeof runCommand;

  constructor(
    private readonly config: ClaudeCodeAgentConfig,
    private readonly limits: ExecutionLimits,
    private readonly projectRoot: string,
    private readonly options: ClaudeCodeAdapterOptions = {},
  ) {
    this.run = options.runCommand ?? runCommand;
  }

  plan(request: AgentTaskRequest): AgentInvocationPlan {
    const cwd = resolveInside(this.projectRoot, request.workingDirectory, 'Agent working directory');
    const args = ['--print', '--output-format', 'json', '--permission-mode', this.config.permissionMode];
    if (this.config.allowedTools.length > 0) args.push('--allowedTools', this.config.allowedTools.join(','));
    if (this.config.model !== undefined) args.push('--model', this.config.model);
    args.push('--tools', this.config.tools.join(','), ...HARDENING_FLAGS);
    if (this.config.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    return {
      agent: this.name,
      executable: this.config.executable,
      args,
      stdin: redactSecrets(
        request.repair !== undefined
          ? buildRepairPrompt(request.project, request.task, request.repair)
          : buildTaskPrompt(request.project, request.task),
        this.passedSecrets(),
      ),
      cwd,
      timeoutMs: this.limits.agentTimeoutMs,
    };
  }

  async execute(plan: AgentInvocationPlan, hooks: AgentExecutionHooks = {}): Promise<AgentRunResult> {
    if (!this.options.executionEnabled) {
      throw new AgentExecutionDisabledError(
        'Claude Code execution is disabled. Set "execution": { "enabled": true } in the factory config to allow supervised execution.',
      );
    }
    assertSafeAgentConfig(this.config);
    for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) {
      if (!plan.args.includes(flag)) throw new ExecutionPolicyError(`Refusing to execute a plan without ${flag}`);
    }
    resolveInside(this.projectRoot, plan.cwd, 'Agent working directory');

    const extraEnv: Record<string, string> = {};
    const source = this.options.env ?? process.env;
    for (const name of this.config.passEnv) {
      const value = source[name];
      if (value !== undefined) extraEnv[name] = value;
    }
    const secrets = this.passedSecrets();

    const result = await this.run(
      {
        name: this.name,
        executable: plan.executable,
        args: plan.args,
        cwd: plan.cwd,
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: this.limits.agentMaxOutputBytes,
      },
      { stdin: plan.stdin, extraEnv, secrets, ...(hooks.onSpawn ? { onSpawn: hooks.onSpawn } : {}) },
    );
    return interpretResult(result, secrets);
  }

  private passedSecrets(): string[] {
    const source = this.options.env ?? process.env;
    return this.config.passEnv.map((name) => source[name]).filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
}

const MAX_SUMMARY = 4000;

/** Turn a raw process result into an agent outcome. Every ambiguity is a failure. */
export function interpretResult(result: CommandResult, secrets: readonly string[] = []): AgentRunResult {
  const details: AgentRunDetails = {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    truncated: result.truncated,
    killFailed: result.killFailed === true,
    stdout: redactSecrets(result.stdout, secrets),
    stderr: redactSecrets(result.stderr, secrets),
  };
  const fail = (summary: string, error?: string): AgentRunResult => ({
    outcome: 'failure',
    summary,
    ...(error !== undefined ? { error: redactSecrets(error, secrets) } : {}),
    details,
  });

  if (result.error !== undefined) return fail('Claude Code could not be started', result.error);
  if (result.timedOut) {
    return result.killFailed
      ? fail('Claude Code timed out and termination of its process tree could not be confirmed', 'check for leftover claude processes')
      : fail(`Claude Code timed out after ${result.durationMs} ms`);
  }
  if (result.truncated) return fail('Claude Code output exceeded limits.agentMaxOutputBytes; result cannot be trusted');

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return fail(`Claude Code exited with code ${result.exitCode} and did not produce JSON output`, describeError(err));
  }
  if (!isRecord(parsed)) return fail('Claude Code JSON output was not an object');
  if (typeof parsed.total_cost_usd === 'number') details.costUsd = parsed.total_cost_usd;
  if (typeof parsed.num_turns === 'number') details.numTurns = parsed.num_turns;
  if (Array.isArray(parsed.permission_denials)) details.permissionDenials = parsed.permission_denials.length;
  const text = typeof parsed.result === 'string' ? redactSecrets(parsed.result, secrets).slice(0, MAX_SUMMARY) : '';

  if (result.exitCode !== 0) return fail(`Claude Code exited with code ${result.exitCode}`, text || undefined);
  if (parsed.is_error === true || parsed.subtype !== 'success') {
    return fail(`Claude Code reported an error (${String(parsed.subtype)})`, text || undefined);
  }
  return { outcome: 'success', summary: text || '(no summary provided)', details };
}
