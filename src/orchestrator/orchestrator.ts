import type { AgentInvocationPlan, CodingAgent } from '../agents/codingAgent.js';
import type { FactoryConfig } from '../config/factoryConfig.js';
import { InvalidTransitionError, TaskNotFoundError } from '../core/errors.js';
import type { ProjectRepository } from '../persistence/projectRepository.js';
import type { ProjectSpec } from '../project/projectSpec.js';
import { redactSecrets } from '../security/redact.js';
import { resolveCommand } from '../testing/commandPolicy.js';
import { runCommand, type CommandResult } from '../testing/commandRunner.js';
import type { ExecutionOutcome, Task } from '../tasks/task.js';
import { recordResult } from '../tasks/taskLifecycle.js';
import { evaluateEligibility, explainTasks, selectEligibleTasks, type Eligibility } from '../tasks/taskSelector.js';

export interface OrchestratorDeps {
  config: FactoryConfig;
  repository: ProjectRepository;
  agent: CodingAgent;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable command runner for tests. */
  runCommand?: typeof runCommand;
}

export interface TaskPlan {
  task: Task;
  plan: AgentInvocationPlan;
}

/**
 * Coordinates config, persisted state, task selection and the coding agent.
 *
 * Milestone 1 scope: inspect state, select eligible work, produce dry-run agent
 * plans, record results reported by an operator, and run allowlisted checks.
 * It does NOT loop, execute the agent, or deploy.
 */
export class Orchestrator {
  private readonly now: () => Date;
  private readonly run: typeof runCommand;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.run = deps.runCommand ?? runCommand;
  }

  /** Load and fully validate the project spec and task graph. */
  async load(): Promise<{ project: ProjectSpec; tasks: Task[] }> {
    const [project, tasks] = await Promise.all([this.deps.repository.loadProject(), this.deps.repository.loadTasks()]);
    return { project, tasks };
  }

  async status(): Promise<{ task: Task; eligibility: Eligibility }[]> {
    const tasks = await this.deps.repository.loadTasks();
    return explainTasks(tasks, this.deps.config.limits.maxRetries);
  }

  /** Eligible tasks, capped at `limits.maxTasksPerRun`. */
  async nextTasks(): Promise<Task[]> {
    const tasks = await this.deps.repository.loadTasks();
    const { maxRetries, maxTasksPerRun } = this.deps.config.limits;
    return selectEligibleTasks(tasks, { maxRetries, limit: maxTasksPerRun });
  }

  /**
   * Build a dry-run agent plan for `taskId`, or for the next eligible task.
   * Returns undefined when no task is eligible. Does not change any state.
   */
  async planTask(taskId?: string): Promise<TaskPlan | undefined> {
    const { project, tasks } = await this.load();
    const { maxRetries } = this.deps.config.limits;
    let task: Task | undefined;
    if (taskId === undefined) {
      task = selectEligibleTasks(tasks, { maxRetries, limit: 1 })[0];
      if (task === undefined) return undefined;
    } else {
      task = tasks.find((t) => t.id === taskId);
      if (task === undefined) throw new TaskNotFoundError(taskId);
      const eligibility = evaluateEligibility(task, new Map(tasks.map((t) => [t.id, t] as const)), maxRetries);
      if (!eligibility.eligible) {
        throw new InvalidTransitionError(`Task "${taskId}" is not eligible: ${eligibility.reason}`);
      }
    }
    const plan = this.deps.agent.plan({ project, task, workingDirectory: this.deps.config.projectRoot });
    return { task, plan };
  }

  /** Record the outcome of an attempt and persist it. */
  async recordTaskResult(
    taskId: string,
    input: { outcome: ExecutionOutcome; summary: string; error?: string; startedAt?: string },
  ): Promise<Task> {
    const tasks = await this.deps.repository.loadTasks();
    const index = tasks.findIndex((t) => t.id === taskId);
    if (index === -1) throw new TaskNotFoundError(taskId);
    const finishedAt = this.now().toISOString();
    const updated = recordResult(
      tasks[index]!,
      {
        outcome: input.outcome,
        summary: redactSecrets(input.summary),
        ...(input.error !== undefined ? { error: redactSecrets(input.error) } : {}),
        startedAt: input.startedAt ?? finishedAt,
        finishedAt,
      },
      this.deps.config.limits.maxRetries,
    );
    const next = [...tasks];
    next[index] = updated;
    await this.deps.repository.saveTasks(next);
    return updated;
  }

  /** Run a named, allowlisted command from project config (e.g. "test"). */
  async runCheck(name: string): Promise<CommandResult> {
    const command = resolveCommand(this.deps.config, name);
    return this.run(command);
  }
}
