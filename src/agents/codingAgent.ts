import type { ProjectSpec } from '../project/projectSpec.js';
import type { Task } from '../tasks/task.js';

/** Everything an agent needs to work on one task. */
export interface AgentTaskRequest {
  project: ProjectSpec;
  task: Task;
  /** Absolute directory the agent is confined to. */
  workingDirectory: string;
  /** Present when asking the agent to repair its own work after failed checks. */
  repair?: RepairContext;
}

/** A failed, factory-run check reported back to the agent during a repair. */
export interface FailedCheck {
  name: string;
  /** The configured command line (for context only; the agent cannot run commands). */
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Redacted, size-bounded output tail. */
  output: string;
}

export interface RepairContext {
  attempt: number;
  maxAttempts: number;
  failures: FailedCheck[];
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

/** Process-level facts about an agent run, recorded as evidence. */
export interface AgentRunDetails {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  killFailed: boolean;
  costUsd?: number;
  numTurns?: number;
  permissionDenials?: number;
  /** Redacted, size-bounded output. */
  stdout: string;
  stderr: string;
}

export interface AgentRunResult {
  outcome: 'success' | 'failure';
  summary: string;
  error?: string;
  details?: AgentRunDetails;
}

export interface AgentExecutionHooks {
  /** Called with the agent's process id once it has started. */
  onSpawn?: (pid: number) => void;
}

/** Contract every coding-agent integration implements. */
export interface CodingAgent {
  readonly name: string;
  plan(request: AgentTaskRequest): AgentInvocationPlan;
  execute(plan: AgentInvocationPlan, hooks?: AgentExecutionHooks): Promise<AgentRunResult>;
}
