import type { ClaudeCodeAgentConfig, ExecutionLimits } from '../config/factoryConfig.js';
import { AgentExecutionDisabledError } from '../core/errors.js';
import { resolveInside } from '../security/paths.js';
import type { AgentInvocationPlan, AgentRunResult, AgentTaskRequest, CodingAgent } from './codingAgent.js';
import { buildTaskPrompt } from './promptBuilder.js';

/**
 * Claude Code integration. Milestone 1 only *plans* invocations of the
 * `claude` CLI in non-interactive print mode; `execute` is deliberately
 * disabled until the execution milestone adds sandboxing and review gates.
 *
 * Planned command (no shell, prompt on stdin):
 *   claude --print --output-format json --permission-mode <mode>
 *          --allowedTools <tool,tool,...> [--model <model>]
 */
export class ClaudeCodeAdapter implements CodingAgent {
  readonly name = 'claude-code';

  constructor(
    private readonly config: ClaudeCodeAgentConfig,
    private readonly limits: ExecutionLimits,
    private readonly projectRoot: string,
  ) {}

  plan(request: AgentTaskRequest): AgentInvocationPlan {
    const cwd = resolveInside(this.projectRoot, request.workingDirectory, 'Agent working directory');
    const args = ['--print', '--output-format', 'json', '--permission-mode', this.config.permissionMode];
    if (this.config.allowedTools.length > 0) args.push('--allowedTools', this.config.allowedTools.join(','));
    if (this.config.model !== undefined) args.push('--model', this.config.model);
    return {
      agent: this.name,
      executable: this.config.executable,
      args,
      stdin: buildTaskPrompt(request.project, request.task),
      cwd,
      timeoutMs: this.limits.agentTimeoutMs,
    };
  }

  async execute(_plan: AgentInvocationPlan): Promise<AgentRunResult> {
    throw new AgentExecutionDisabledError(
      'Claude Code execution is not enabled in milestone 1. Use the plan (dry run) output to review the invocation.',
    );
  }
}
