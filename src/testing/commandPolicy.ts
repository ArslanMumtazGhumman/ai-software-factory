import type { FactoryConfig } from '../config/factoryConfig.js';
import { CommandNotAllowedError } from '../core/errors.js';

/** A command that has passed policy checks and may be spawned. */
export interface ResolvedCommand {
  name: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Turn a command *name* into an executable invocation, using only the
 * project's configuration. There is intentionally no way to pass a raw command
 * string: task descriptions can never become shell commands.
 */
export function resolveCommand(config: FactoryConfig, name: string): ResolvedCommand {
  if (!Object.prototype.hasOwnProperty.call(config.commands, name)) {
    const known = Object.keys(config.commands);
    throw new CommandNotAllowedError(
      `Command "${name}" is not configured. Configured commands: ${known.length > 0 ? known.join(', ') : '(none)'}`,
    );
  }
  const spec = config.commands[name]!;
  // Re-checked at run time in case the config object was built in code.
  if (!config.allowedExecutables.includes(spec.executable)) {
    throw new CommandNotAllowedError(`Executable "${spec.executable}" for command "${name}" is not allowlisted`);
  }
  return {
    name,
    executable: spec.executable,
    args: [...spec.args],
    cwd: config.projectRoot,
    timeoutMs: spec.timeoutMs ?? config.limits.commandTimeoutMs,
    maxOutputBytes: config.limits.maxOutputBytes,
  };
}
