/**
 * Typed error hierarchy. Every error raised deliberately by the factory carries
 * a stable `code` so callers (CLI, future orchestration loop) can react without
 * parsing messages.
 */
export class FactoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Input data (config, spec, tasks) failed validation. */
export class ValidationError extends FactoryError {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super('VALIDATION_ERROR', issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.issues = issues;
  }
}

/** The task dependency graph is invalid (unknown ids, cycles, duplicates). */
export class DependencyError extends FactoryError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super('DEPENDENCY_ERROR', `Invalid task dependency graph:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

/** Reading or writing persisted JSON state failed. */
export class PersistenceError extends FactoryError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('PERSISTENCE_ERROR', message, options);
  }
}

/** A requested task does not exist. */
export class TaskNotFoundError extends FactoryError {
  constructor(taskId: string) {
    super('TASK_NOT_FOUND', `Task not found: ${taskId}`);
  }
}

/** A task status change is not permitted from its current state. */
export class InvalidTransitionError extends FactoryError {
  constructor(message: string) {
    super('INVALID_TRANSITION', message);
  }
}

/** A command was requested that is not configured or not allowlisted. */
export class CommandNotAllowedError extends FactoryError {
  constructor(message: string) {
    super('COMMAND_NOT_ALLOWED', message);
  }
}

/** A path escaped the directory it is required to stay inside. */
export class PathSafetyError extends FactoryError {
  constructor(message: string) {
    super('PATH_NOT_ALLOWED', message);
  }
}

/** A configured execution limit would be exceeded. */
export class LimitExceededError extends FactoryError {
  constructor(message: string) {
    super('LIMIT_EXCEEDED', message);
  }
}

/** Coding-agent execution was requested but is not enabled in this milestone. */
export class AgentExecutionDisabledError extends FactoryError {
  constructor(message: string) {
    super('AGENT_EXECUTION_DISABLED', message);
  }
}

/** Render any thrown value as a single safe message string. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
