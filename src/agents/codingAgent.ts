import type { ProjectSpec } from '../project/projectSpec.js';
import type { Task } from '../tasks/task.js';

/** Everything an agent needs to work on one task. */
export interface AgentTaskRequest {
  project: ProjectSpec;
  task: Task;
  /** Absolute directory the agent is confined to. */
  workingDirectory: string;
}

/**
 * A fully described, not-yet-executed agent invocation. Producing a plan has
 * no side effects, so it can be reviewed (dry run) before anything runs.
 */
export interface AgentInvocationPlan {
  agent: string;
  executable: string;
  /** Arguments passed without a shell. Never contains task text. */
  args: string[];
  /** Task prompt, delivered on stdin rather than the command line. */
  stdin: string;
  cwd: string;
  timeoutMs: number;
}

export interface AgentRunResult {
  outcome: 'success' | 'failure';
  summary: string;
  error?: string;
}

/** Contract every coding-agent integration implements. */
export interface CodingAgent {
  readonly name: string;
  plan(request: AgentTaskRequest): AgentInvocationPlan;
  execute(plan: AgentInvocationPlan): Promise<AgentRunResult>;
}
