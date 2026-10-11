#!/usr/bin/env node
import path from 'node:path';
import { ClaudeCodeAdapter } from './agents/claudeCodeAdapter.js';
import { loadFactoryConfig } from './config/factoryConfig.js';
import { FactoryError, describeError } from './core/errors.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { ProjectRepository } from './persistence/projectRepository.js';
import { redactSecrets } from './security/redact.js';

const USAGE = `AI Software Factory (milestone 1)

Usage: factory <command> [options]

Commands:
  validate                         Validate config, project spec and task graph
  status                           List all tasks with eligibility
  next                             Show eligible tasks (up to limits.maxTasksPerRun)
  plan [taskId]                    Show the dry-run Claude Code invocation for a task
  record <taskId> <success|failure> <summary...>
                                   Record the result of an attempt
  run-check <name>                 Run a command defined in config "commands"
  help                             Show this help

Options:
  --config <path>                  Config file (default: factory.config.json)
`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  configPath: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let configPath = 'factory.config.json';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--config requires a path');
      configPath = value;
    } else if (arg === '--help' || arg === '-h') {
      positionals.unshift('help');
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals.shift() ?? 'help', positionals, configPath };
}

class UsageError extends Error {}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = await loadFactoryConfig(args.configPath);
  const repository = new ProjectRepository(config.dataDir);
  const agent = new ClaudeCodeAdapter(config.agent, config.limits, config.projectRoot);
  const orchestrator = new Orchestrator({ config, repository, agent });
  const out = (line = '') => process.stdout.write(`${line}\n`);

  switch (args.command) {
    case 'validate': {
      const { project, tasks } = await orchestrator.load();
      out(`OK: project "${project.name}" with ${tasks.length} task(s); dependency graph is valid.`);
      out(`Project root: ${config.projectRoot}`);
      out(`Data dir:     ${path.relative(config.projectRoot, config.dataDir) || '.'}`);
      return 0;
    }
    case 'status': {
      for (const { task, eligibility } of await orchestrator.status()) {
        const flag = eligibility.eligible ? 'ELIGIBLE' : eligibility.reason;
        out(`${task.id.padEnd(16)} ${task.status.padEnd(16)} retries=${task.retryCount}  ${task.title}`);
        out(`${''.padEnd(16)} -> ${flag}`);
      }
      return 0;
    }
    case 'next': {
      const tasks = await orchestrator.nextTasks();
      if (tasks.length === 0) out('No eligible tasks.');
      for (const task of tasks) out(`${task.id}  ${task.title}`);
      return 0;
    }
    case 'plan': {
      const result = await orchestrator.planTask(args.positionals[0]);
      if (result === undefined) {
        out('No eligible tasks.');
        return 0;
      }
      const { task, plan } = result;
      out(`DRY RUN - nothing will be executed.`);
      out(`Task:       ${task.id} (${task.title})`);
      out(`Executable: ${plan.executable}`);
      out(`Arguments:  ${JSON.stringify(plan.args)}`);
      out(`Directory:  ${plan.cwd}`);
      out(`Timeout:    ${plan.timeoutMs} ms`);
      out('Prompt (stdin):');
      out('----------------------------------------');
      out(plan.stdin);
      out('----------------------------------------');
      return 0;
    }
    case 'record': {
      const [taskId, outcome, ...summaryParts] = args.positionals;
      if (taskId === undefined || (outcome !== 'success' && outcome !== 'failure') || summaryParts.length === 0) {
        throw new UsageError('Usage: record <taskId> <success|failure> <summary...>');
      }
      const task = await orchestrator.recordTaskResult(taskId, { outcome, summary: summaryParts.join(' ') });
      out(`Recorded ${outcome} for ${task.id}; status is now "${task.status}" (retries=${task.retryCount}).`);
      return 0;
    }
    case 'run-check': {
      const name = args.positionals[0];
      if (name === undefined) throw new UsageError('Usage: run-check <name>');
      const result = await orchestrator.runCheck(name);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.truncated) out('[output truncated by limits.maxOutputBytes]');
      if (result.error) out(`Error: ${result.error}`);
      if (result.timedOut) out(`Timed out after ${result.durationMs} ms.`);
      out(`Command "${name}" exited with code ${result.exitCode ?? 'n/a'} in ${result.durationMs} ms.`);
      return result.exitCode === 0 ? 0 : 1;
    }
    default:
      throw new UsageError(`Unknown command "${args.command}". Run "factory help".`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    const code = err instanceof FactoryError ? err.code : 'UNEXPECTED_ERROR';
    process.stderr.write(`Error [${code}]: ${redactSecrets(describeError(err))}\n`);
    process.exitCode = 1;
  },
);
