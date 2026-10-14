#!/usr/bin/env node
import path from 'node:path';
import { ClaudeCodeAdapter } from './agents/claudeCodeAdapter.js';
import { loadFactoryConfig } from './config/factoryConfig.js';
import { FactoryError, describeError } from './core/errors.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { AutonomousRunner } from './orchestrator/autonomousRunner.js';
import { Supervisor, type ExecutionReport } from './orchestrator/supervisor.js';
import type { AutoRunRecord, TaskCounts } from './persistence/autoRunStore.js';
import { FileLock } from './persistence/fileLock.js';
import { ProjectRepository } from './persistence/projectRepository.js';
import { redactSecrets } from './security/redact.js';
import { createDashboard } from './dashboard/bootstrap.js';
import { DEFAULT_PORT, startDashboardServer, type DashboardServer } from './dashboard/server.js';

const USAGE = `AI Software Factory

Usage: factory <command> [options]

Inspection (read-only):
  validate                         Validate config, project spec and task graph
  status                           List all tasks with eligibility
  next                             Show eligible tasks (up to limits.maxTasksPerRun)
  plan [taskId]                    Show the dry-run Claude Code invocation for a task
  review <taskId> [--no-diff]      Show the latest run: agent result, validation, findings, diff

Supervised execution (requires "execution.enabled": true):
  execute <taskId>                 Run ONE eligible task through Claude Code in an isolated
                                   git worktree, validate it, then stop for human review
  accept <taskId>                  Accept a reviewed result (verifies nothing changed since review)
  reject <taskId> <reason...>      Reject a reviewed result (worktree and branch are kept)
  recover                          Release a dead process's lock, fail interrupted executions and
                                   mark interrupted autonomous runs as paused

Autonomous runs (requires "autonomy.enabled": true):
  auto start [--max-tasks N] [--retry-failed]
                                   Process eligible tasks one at a time until a task needs a
                                   person, a limit is reached, or nothing is left
  auto resume [--retry-failed]     Continue a paused run (reloads and reconciles all state)
  auto pause                       Pause after the current task (from another window)
  auto stop                        Stop: no new task starts; ends a paused run
  auto status                      Current or last run: state, current/last task, next action
  auto history                     All autonomous runs
  auto show [autoRunId]            Executions and events of a run
  auto failures [autoRunId]        Failure details: agent result, checks, repairs, findings

Dashboard:
  dashboard [--port N] [--workspace <file>]
                                   Local web dashboard on http://127.0.0.1:N/ (default ${DEFAULT_PORT}).
                                   Repeat --config to show several projects. --workspace enables
                                   creating projects from ideas. Stop it with Ctrl+C.

Other:
  record <taskId> <success|failure> <summary...>
                                   Record the result of a manual attempt
  run-check <name>                 Run a command defined in config "commands"
  help                             Show this help

Options:
  --config <path>                  Config file (default: factory.config.json)
  --port <N>                       Dashboard port, 1024-65535 (dashboard only)
  --workspace <path>               factory.workspace.json for idea-to-project planning (dashboard only)
`;

interface ParsedArgs {
  command: string;
  positionals: string[];
  configPath: string;
  /** Every --config given, in order (the dashboard can show several projects). */
  configPaths: string[];
  port?: number;
  workspaceFile?: string;
  noDiff: boolean;
  maxTasks?: number;
  retryFailed: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let configPath = 'factory.config.json';
  const configPaths: string[] = [];
  let port: number | undefined;
  let workspaceFile: string | undefined;
  let noDiff = false;
  let maxTasks: number | undefined;
  let retryFailed = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--config requires a path');
      configPath = value;
      configPaths.push(value);
    } else if (arg === '--workspace') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError('--workspace requires a path');
      workspaceFile = value;
    } else if (arg === '--port') {
      const value = argv[++i];
      if (value === undefined || !/^[0-9]{4,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
        throw new UsageError('--port requires a number from 1024 to 65535');
      }
      port = Number(value);
    } else if (arg === '--no-diff') {
      noDiff = true;
    } else if (arg === '--retry-failed') {
      retryFailed = true;
    } else if (arg === '--max-tasks') {
      const value = argv[++i];
      if (value === undefined || !/^[0-9]{1,3}$/.test(value)) throw new UsageError('--max-tasks requires a whole number');
      maxTasks = Number(value);
    } else if (arg === '--help' || arg === '-h') {
      positionals.unshift('help');
    } else if (arg.startsWith('--')) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return {
    command: positionals.shift() ?? 'help',
    positionals,
    configPath,
    configPaths,
    noDiff,
    retryFailed,
    ...(maxTasks !== undefined ? { maxTasks } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(workspaceFile !== undefined ? { workspaceFile } : {}),
  };
}

class UsageError extends Error {}

const out = (line = '') => process.stdout.write(`${line}\n`);

function requireTaskId(args: ParsedArgs, usage: string): string {
  const taskId = args.positionals[0];
  if (taskId === undefined) throw new UsageError(`Usage: ${usage}`);
  return taskId;
}

function printOutcome(report: ExecutionReport): void {
  const { run, task } = report;
  out('');
  out(`Run:        ${run.runId}`);
  out(`Task:       ${task.id} -> ${task.status} (retries=${task.retryCount})`);
  out(`Worktree:   ${run.worktreePath ?? '(none)'}`);
  out(`Branch:     ${run.branch ?? '(none)'}`);
  if (run.outcome === 'success') {
    out('Result:     PASSED agent, validation and diff review. Waiting for human review.');
    out(`Next:       factory review ${task.id}   then   factory accept ${task.id}  |  factory reject ${task.id} <reason>`);
  } else {
    out(`Result:     FAILED - ${run.failureReason ?? 'unknown reason'}`);
    out(`Inspect:    factory review ${task.id}   (the worktree is preserved)`);
  }
}

function describeCounts(c: TaskCounts): string {
  return `${c.total} total: ${c.completed} completed, ${c.awaitingReview} awaiting review, ${c.failed} failed, ${c.needsAttention} need attention, ${c.inProgress} in progress, ${c.pending} pending`;
}

function printAutoRun(record: AutoRunRecord, counts?: TaskCounts, ownerAlive?: boolean): void {
  out(`Autonomous run ${record.autoRunId} (project ${record.projectId}): ${record.state.toUpperCase()}`);
  if (record.state === 'running') {
    const pid = record.owner?.pid ?? 'unknown';
    out(`Runner:     pid ${pid}${ownerAlive === false ? ' - NOT RUNNING (run "factory recover")' : ''}`);
  }
  if (record.stop) {
    out(`Stopped:    ${record.stop.reason} - ${record.stop.message}`);
    out(`Next step:  ${record.stop.action}`);
  }
  out(`Current:    ${record.currentTask ? `${record.currentTask.taskId}${record.currentTask.runId ? ` (run ${record.currentTask.runId})` : ''}` : '(none)'}`);
  out(`Last done:  ${record.lastCompletedTask ? `${record.lastCompletedTask.taskId} (accepted by ${record.lastCompletedTask.by} at ${record.lastCompletedTask.at})` : '(none)'}`);
  const summary = counts ?? record.summary;
  if (summary) out(`Tasks:      ${describeCounts(summary)}`);
  const results = record.executions.map((e) => `${e.taskId}=${e.result}`).join(', ') || '(none)';
  const repairs = record.executions.reduce((n, e) => n + e.repairs, 0);
  out(`Executions: ${record.executions.length}/${record.limits.maxTasks}: ${results}; ${repairs} repair attempt(s)`);
  out(
    `Budget:     active ${(activeMsOf(record) / 1000).toFixed(1)} s of ${record.limits.maxRunDurationMs / 1000} s; cost $${record.costUsd.toFixed(4)}${
      record.limits.maxCostUsd !== undefined ? ` of $${record.limits.maxCostUsd}` : ''
    }${record.costUnknown ? ' (some costs unknown)' : ''}`,
  );
  out(`Base:       started at ${record.initialCommit}; next task builds on ${record.tip}`);
}

/** Active time including the segment in progress (it is only persisted when a segment ends). */
function activeMsOf(record: AutoRunRecord): number {
  const segment = record.segments[record.segments.length - 1];
  if (record.state !== 'running' || segment === undefined || segment.endedAt !== undefined) return record.activeMs;
  return record.activeMs + Math.max(0, Date.now() - Date.parse(segment.startedAt));
}

function exitCodeFor(record: AutoRunRecord): number {
  const normal = ['all-complete', 'awaiting-review', 'pause-requested', 'stop-requested', 'task-limit', 'duration-limit', 'cost-limit'];
  return record.stop && normal.includes(record.stop.reason) ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if ((args.port !== undefined || args.workspaceFile !== undefined) && args.command !== 'dashboard') throw new UsageError('--port and --workspace apply to "dashboard" only');
  if (args.command === 'dashboard') return runDashboard(args);

  const config = await loadFactoryConfig(args.configPath);
  const repository = new ProjectRepository(config.dataDir);
  const lock = new FileLock(config.dataDir);
  const agent = new ClaudeCodeAdapter(config.agent, config.limits, config.projectRoot, {
    executionEnabled: config.execution.enabled,
  });
  const orchestrator = new Orchestrator({ config, repository, agent, lock });
  const log = (line: string) => out(`[factory] ${redactSecrets(line)}`);
  const supervisor = new Supervisor({ config, repository, agent, lock, log });
  const runner = new AutonomousRunner({ config, repository, supervisor, lock, log });

  switch (args.command) {
    case 'validate': {
      const { project, tasks } = await orchestrator.load();
      out(`OK: project "${project.name}" with ${tasks.length} task(s); dependency graph is valid.`);
      out(`Project root: ${config.projectRoot}`);
      out(`Data dir:     ${path.relative(config.projectRoot, config.dataDir) || '.'}`);
      out(`Execution:    ${config.execution.enabled ? `enabled (validation: ${config.execution.validationCommands.join(', ') || 'none'}; repairs: ${config.execution.maxRepairAttempts})` : 'disabled'}`);
      const auto = config.autonomy;
      out(
        `Autonomy:     ${auto.enabled ? `enabled (max ${config.limits.maxTasksPerRun} task(s)/run, ${auto.maxRunDurationMs} ms/run, ${auto.maxTaskDurationMs} ms/task${auto.maxCostUsd !== undefined ? `, $${auto.maxCostUsd}/run` : ''})` : 'disabled'}`,
      );
      out(`Auto-accept:  ${auto.autoAccept.enabled ? `tasks ${auto.autoAccept.taskIds.join(', ')} under ${auto.autoAccept.paths.join(', ')}` : 'disabled (every result waits for human review)'}`);
      return 0;
    }
    case 'status': {
      for (const { task, eligibility } of await orchestrator.status()) {
        const flag = eligibility.eligible ? 'ELIGIBLE' : eligibility.reason;
        out(`${task.id.padEnd(16)} ${task.status.padEnd(16)} retries=${task.retryCount}  ${task.title}`);
        out(`${''.padEnd(16)} -> ${flag}`);
      }
      const lockState = await lock.inspect();
      if (lockState.state === 'held') {
        out(`Lock: held by pid ${lockState.info.pid} (${lockState.info.command}), owner ${lockState.owner}.`);
      } else if (lockState.state === 'unreadable') {
        out(`Lock: unreadable (${lockState.detail}).`);
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
      out(`Directory:  ${plan.cwd}  (execute uses an isolated worktree instead)`);
      out(`Timeout:    ${plan.timeoutMs} ms`);
      out('Prompt (stdin):');
      out('----------------------------------------');
      out(plan.stdin);
      out('----------------------------------------');
      return 0;
    }
    case 'execute': {
      const taskId = requireTaskId(args, 'execute <taskId>');
      if (args.positionals.length > 1) throw new UsageError('execute runs exactly one task: execute <taskId>');
      const report = await supervisor.execute(taskId);
      printOutcome(report);
      return report.run.outcome === 'success' ? 0 : 1;
    }
    case 'review': {
      const taskId = requireTaskId(args, 'review <taskId> [--no-diff]');
      const { task, run, patch, integrityProblems } = await supervisor.review(taskId);
      out(`Task:        ${task.id} (${task.title}) - status ${task.status}`);
      out(`Run:         ${run.runId} - state ${run.state}, outcome ${run.outcome ?? 'n/a'}`);
      if (run.failureReason) out(`Failure:     ${run.failureReason}`);
      out(`Base commit: ${run.baseCommit}`);
      out(`Worktree:    ${run.worktreePath ?? '(none)'}`);
      out(`Branch:      ${run.branch ?? '(none)'}`);
      if (run.decision) out(`Decision:    ${run.decision.decision} at ${run.decision.at}${run.decision.reason ? ` - ${run.decision.reason}` : ''}`);
      if (integrityProblems.length > 0) {
        out('INTEGRITY WARNINGS:');
        for (const p of integrityProblems) out(`  ! ${p}`);
      }
      if (run.agent) {
        const a = run.agent;
        out('');
        out(`Agent:       ${a.outcome} - exit ${a.exitCode ?? 'n/a'}, ${a.durationMs} ms${a.timedOut ? ', TIMED OUT' : ''}${
          a.costUsd !== undefined ? `, $${a.costUsd.toFixed(4)}` : ''
        }${a.numTurns !== undefined ? `, ${a.numTurns} turns` : ''}${a.permissionDenials ? `, ${a.permissionDenials} permission denial(s)` : ''}`);
        if (a.error) out(`Agent error: ${a.error}`);
        out('Agent summary:');
        out(a.summary.replace(/^/gm, '  '));
      }
      for (const r of run.repairs ?? []) {
        out(
          `Repair ${r.attempt}:    after ${r.failedValidation.map((v) => `${v.name} (exit ${v.exitCode ?? 'n/a'})`).join(', ')} -> agent ${r.agent.outcome}, ${r.agent.durationMs} ms${
            r.agent.costUsd !== undefined ? `, $${r.agent.costUsd.toFixed(4)}` : ''
          }`,
        );
      }
      if (run.acceptedCommit) out(`Committed:   ${run.acceptedCommit} on ${run.branch} (accepted by ${run.decision?.by ?? 'human'})`);
      out('');
      out('Validation:');
      if (!run.validation || run.validation.length === 0) out('  (not run)');
      for (const v of run.validation ?? []) {
        out(`  ${v.name}: ${[v.executable, ...v.args].join(' ')} -> exit ${v.exitCode ?? 'n/a'}${v.timedOut ? ' (timed out)' : ''} in ${v.durationMs} ms`);
        const text = `${v.stdout}${v.stderr}`.trim();
        if (text) out(text.split('\n').slice(-15).map((l) => `    | ${l}`).join('\n'));
      }
      if (run.review) {
        out('');
        out(`Changed files (${run.review.changedFiles.length}):`);
        for (const f of run.review.changedFiles) out(`  ${f.status} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path}`);
        out('Findings:');
        if (run.review.findings.length === 0) out('  (none)');
        for (const f of run.review.findings) out(`  [${f.severity}] ${f.rule}: ${f.message}`);
        if (!args.noDiff) {
          out('');
          out('Diff:');
          out(patch || '(empty)');
        }
      }
      return 0;
    }
    case 'accept': {
      const taskId = requireTaskId(args, 'accept <taskId>');
      const { task, run } = await supervisor.accept(taskId);
      out(`Accepted ${task.id}; status is now "${task.status}". Dependent tasks may now become eligible.`);
      out(`The reviewed tree was committed as ${run.acceptedCommit} on the factory branch ${run.branch}.`);
      out('Nothing was merged into your branch. Dependent tasks build on this commit; merge it yourself when ready:');
      out(`  git merge --ff-only ${run.branch}`);
      return 0;
    }
    case 'reject': {
      const [taskId, ...reasonParts] = args.positionals;
      if (taskId === undefined || reasonParts.length === 0) throw new UsageError('Usage: reject <taskId> <reason...>');
      const { task, run } = await supervisor.reject(taskId, reasonParts.join(' '));
      out(`Rejected ${task.id}; status is now "${task.status}" (retries=${task.retryCount}).`);
      out(`The work is preserved for inspection in ${run.worktreePath} (branch ${run.branch}).`);
      return 0;
    }
    case 'recover': {
      const report = await runner.recover();
      out(`Lock: ${report.lock}`);
      for (const action of report.actions) out(`- ${action}`);
      return report.unresolved.length > 0 ? 1 : 0;
    }
    case 'auto':
      return runAuto(args, runner);
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

async function runDashboard(args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new UsageError('Usage: dashboard [--config <path>]... [--workspace <path>] [--port N]');
  const log = (line: string) => out(`[dashboard] ${redactSecrets(line)}`);
  const { service, planning, warnings } = await createDashboard({
    configPaths: args.configPaths,
    ...(args.workspaceFile !== undefined ? { workspaceFile: args.workspaceFile } : {}),
    log,
  });
  for (const w of warnings) log(w);
  const projects = service.projects;
  let dashboard: DashboardServer;
  try {
    dashboard = await startDashboardServer({ service, ...(args.port !== undefined ? { port: args.port } : {}), log });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new UsageError(`Port ${args.port ?? DEFAULT_PORT} is already in use. Is the dashboard already running? Otherwise choose another with --port.`);
    }
    throw err;
  }
  out(`AI Software Factory dashboard: ${dashboard.url}`);
  out(`Listening on 127.0.0.1 only. Projects: ${projects.map((p) => p.config.projectRoot).join(', ') || '(none yet)'}`);
  if (planning !== undefined) out(`Planning: on (planner ${planning.plannerName}; new projects go to ${planning.workspace.projectsDir}).`);
  out('Open the address above in your browser. Press Ctrl+C to stop the dashboard (runs it started keep running).');
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      out('Stopping the dashboard...');
      void dashboard.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

async function runAuto(args: ParsedArgs, runner: AutonomousRunner): Promise<number> {
  const [sub, ...rest] = args.positionals;
  switch (sub) {
    case 'start':
    case 'resume': {
      if (rest.length > 0) throw new UsageError(`Usage: auto ${sub} ${sub === 'start' ? '[--max-tasks N] ' : ''}[--retry-failed]`);
      if (sub === 'resume' && args.maxTasks !== undefined) throw new UsageError('--max-tasks applies to "auto start" only; limits are fixed per run.');
      let interrupts = 0;
      const onSigint = () => {
        interrupts += 1;
        if (interrupts === 1) {
          runner.requestPauseInProcess();
          out('[factory] Pause requested (Ctrl+C). Finishing the current task; press Ctrl+C again to abort immediately.');
        } else {
          out('[factory] Aborting. Run "factory recover" before resuming.');
          process.exit(130);
        }
      };
      process.on('SIGINT', onSigint);
      try {
        const record =
          sub === 'start'
            ? await runner.start({ retryFailed: args.retryFailed, ...(args.maxTasks !== undefined ? { maxTasks: args.maxTasks } : {}) })
            : await runner.resume({ retryFailed: args.retryFailed });
        out('');
        printAutoRun(record);
        return exitCodeFor(record);
      } finally {
        process.off('SIGINT', onSigint);
      }
    }
    case 'pause':
    case 'stop':
      out(await runner.request(sub));
      return 0;
    case 'status': {
      const { record, counts, ownerAlive } = await runner.status();
      if (record === undefined) {
        out('No autonomous runs yet. Start one with "factory auto start".');
        return 0;
      }
      printAutoRun(record, counts, ownerAlive);
      return 0;
    }
    case 'history': {
      const records = await runner.history();
      if (records.length === 0) out('No autonomous runs yet.');
      for (const r of records) {
        const results = r.executions.map((e) => `${e.taskId}=${e.result}`).join(', ') || '-';
        out(`${r.autoRunId}  ${r.state.padEnd(9)} ${(r.stop?.reason ?? '').padEnd(16)} ${r.executions.length} task(s): ${results}`);
      }
      return 0;
    }
    case 'show': {
      const record = await runner.show(rest[0]);
      printAutoRun(record);
      out('');
      out('Executions:');
      if (record.executions.length === 0) out('  (none)');
      for (const e of record.executions) {
        out(`  ${e.taskId} -> ${e.result}${e.taskStatus ? ` (task ${e.taskStatus})` : ''}  run ${e.runId ?? 'n/a'}`);
        out(`     ${e.startedAt} .. ${e.finishedAt ?? 'running'}; agent exit ${e.agentExitCode ?? 'n/a'}${e.agentTimedOut ? ' (timed out)' : ''}; repairs ${e.repairs}${e.costUsd !== undefined ? `; $${e.costUsd.toFixed(4)}` : ''}`);
        if (e.validation?.length) out(`     checks: ${e.validation.map((v) => `${v.name}=${v.timedOut ? 'timeout' : `exit ${v.exitCode ?? 'n/a'}`}`).join(', ')}`);
        if (e.branch) out(`     branch ${e.branch}${e.acceptedCommit ? `, commit ${e.acceptedCommit}` : ''}`);
        if (e.worktreePath) out(`     worktree ${e.worktreePath}`);
        if (e.failureReason) out(`     failure: ${e.failureReason}`);
        if (e.reviewReasons?.length) out(`     review policy: ${e.reviewReasons.join('; ')}`);
      }
      out('');
      out(`Events${record.droppedEvents > 0 ? ` (${record.droppedEvents} older events dropped)` : ''}:`);
      for (const ev of record.events) out(`  ${ev.at} [${ev.type}] ${ev.message}`);
      return 0;
    }
    case 'failures': {
      const { record, failures } = await runner.failures(rest[0]);
      out(`Failures in autonomous run ${record.autoRunId}:`);
      if (failures.length === 0) out('  (none)');
      for (const { entry, run } of failures) {
        out('');
        out(`${entry.taskId} -> ${entry.result}  run ${entry.runId ?? 'n/a'}`);
        if (entry.failureReason) out(`  Reason: ${entry.failureReason}`);
        if (!run) continue;
        if (run.agent) out(`  Agent: ${run.agent.outcome}, exit ${run.agent.exitCode ?? 'n/a'}${run.agent.timedOut ? ', timed out' : ''}${run.agent.error ? `; error: ${run.agent.error}` : ''}`);
        for (const repair of run.repairs ?? []) {
          out(`  Repair ${repair.attempt}: triggered by ${repair.failedValidation.map((v) => `${v.name} (exit ${v.exitCode ?? 'n/a'})`).join(', ')}; agent ${repair.agent.outcome}`);
        }
        for (const v of run.validation ?? []) {
          out(`  Check ${v.name}: exit ${v.exitCode ?? 'n/a'}${v.timedOut ? ' (timed out)' : ''}`);
          if (v.exitCode !== 0 || v.timedOut) {
            const text = `${v.stdout}${v.stderr}`.trim();
            if (text) out(text.split('\n').slice(-20).map((l) => `    | ${l}`).join('\n'));
          }
        }
        for (const f of run.review?.findings ?? []) out(`  [${f.severity}] ${f.rule}: ${f.message}`);
        out(`  Worktree (preserved): ${run.worktreePath ?? 'n/a'}`);
      }
      return 0;
    }
    default:
      throw new UsageError('Usage: auto <start|resume|pause|stop|status|history|show|failures>');
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
