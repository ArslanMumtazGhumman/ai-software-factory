import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ClaudeCodeAdapter } from '../src/agents/claudeCodeAdapter.js';
import {
  AgentExecutionDisabledError,
  CommandNotAllowedError,
  InvalidTransitionError,
  PathSafetyError,
  TaskNotFoundError,
} from '../src/core/errors.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ProjectRepository } from '../src/persistence/projectRepository.js';
import type { CommandResult } from '../src/testing/commandRunner.js';
import { makeConfig, makeTask, makeTempDir, sampleProject } from './helpers.js';

describe('orchestrator', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let repo: ProjectRepository;
  let orchestrator: Orchestrator;
  let ranCommands: string[];

  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    const config = makeConfig(dir, {
      limits: { maxRetries: 1, maxTasksPerRun: 2 },
      allowedExecutables: ['node'],
      commands: { test: { executable: 'node', args: ['--test'] } },
    });
    repo = new ProjectRepository(config.dataDir);
    await repo.saveProject(sampleProject);
    await repo.saveTasks([
      makeTask('A'),
      makeTask('B'),
      makeTask('C'),
      makeTask('D', { dependencies: ['A'] }),
    ]);
    ranCommands = [];
    orchestrator = new Orchestrator({
      config,
      repository: repo,
      agent: new ClaudeCodeAdapter(config.agent, config.limits, config.projectRoot),
      now: () => new Date('2026-05-01T12:00:00.000Z'),
      runCommand: async (cmd): Promise<CommandResult> => {
        ranCommands.push(`${cmd.executable} ${cmd.args.join(' ')}`);
        return { name: cmd.name, exitCode: 0, timedOut: false, durationMs: 1, stdout: '', stderr: '', truncated: false };
      },
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  it('caps next tasks at maxTasksPerRun', async () => {
    assert.deepEqual((await orchestrator.nextTasks()).map((t) => t.id), ['A', 'B']);
  });

  it('records results, persists them, and unlocks dependants', async () => {
    const updated = await orchestrator.recordTaskResult('A', { outcome: 'success', summary: 'done' });
    assert.equal(updated.status, 'completed');
    const stored = (await repo.loadTasks()).find((t) => t.id === 'A')!;
    assert.equal(stored.results[0]!.finishedAt, '2026-05-01T12:00:00.000Z');
    const status = await orchestrator.status();
    assert.equal(status.find((s) => s.task.id === 'D')!.eligibility.eligible, true);
  });

  it('enforces the retry limit across recorded failures', async () => {
    await orchestrator.recordTaskResult('A', { outcome: 'failure', summary: 'x' });
    assert.equal((await repo.loadTasks())[0]!.status, 'failed');
    const second = await orchestrator.recordTaskResult('A', { outcome: 'failure', summary: 'y' });
    assert.equal(second.status, 'needs_attention');
    assert.ok(!(await orchestrator.nextTasks()).some((t) => t.id === 'A'));
  });

  it('redacts secrets in recorded summaries', async () => {
    const t = await orchestrator.recordTaskResult('A', { outcome: 'failure', summary: 'leaked sk-ant-api03-zzzzzzzzzzzzzzzz' });
    assert.doesNotMatch(t.results[0]!.summary, /sk-ant/);
  });

  it('throws for unknown tasks', async () => {
    await assert.rejects(orchestrator.recordTaskResult('nope', { outcome: 'success', summary: 'x' }), TaskNotFoundError);
    await assert.rejects(orchestrator.planTask('nope'), TaskNotFoundError);
  });

  it('builds a dry-run plan that keeps task text out of argv', async () => {
    const result = await orchestrator.planTask();
    assert.ok(result);
    const { task, plan } = result;
    assert.equal(task.id, 'A');
    assert.equal(plan.executable, 'claude');
    assert.deepEqual(plan.args.slice(0, 5), ['--print', '--output-format', 'json', '--permission-mode', 'plan']);
    assert.ok(!plan.args.some((a) => a.includes('Description of A')));
    assert.match(plan.stdin, /Description of A/);
    assert.match(plan.stdin, /Do not delete files/);
    assert.equal(plan.cwd, dir);
  });

  it('refuses to plan an ineligible task', async () => {
    await assert.rejects(orchestrator.planTask('D'), InvalidTransitionError);
  });

  it('never executes the coding agent in this milestone', async () => {
    const adapter = new ClaudeCodeAdapter(makeConfig(dir).agent, makeConfig(dir).limits, dir);
    const plan = adapter.plan({ project: sampleProject, task: makeTask('A'), workingDirectory: dir });
    await assert.rejects(adapter.execute(plan), AgentExecutionDisabledError);
  });

  it('refuses an agent working directory outside the project', () => {
    const adapter = new ClaudeCodeAdapter(makeConfig(dir).agent, makeConfig(dir).limits, dir);
    assert.throws(
      () => adapter.plan({ project: sampleProject, task: makeTask('A'), workingDirectory: path.dirname(dir) }),
      PathSafetyError,
    );
  });

  it('runs only configured checks', async () => {
    await orchestrator.runCheck('test');
    assert.deepEqual(ranCommands, ['node --test']);
    await assert.rejects(orchestrator.runCheck('del /s /q C:\\'), CommandNotAllowedError);
    assert.equal(ranCommands.length, 1);
  });
});
