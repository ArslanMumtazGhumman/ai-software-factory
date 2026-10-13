import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AgentRunResult } from '../src/agents/codingAgent.js';
import { loadFactoryConfig } from '../src/config/factoryConfig.js';
import { ExecutionPolicyError, InvalidTransitionError, LimitExceededError, LockHeldError, ValidationError } from '../src/core/errors.js';
import { AutonomousRunner } from '../src/orchestrator/autonomousRunner.js';
import { Supervisor } from '../src/orchestrator/supervisor.js';
import { AutoRunStore } from '../src/persistence/autoRunStore.js';
import { FileLock } from '../src/persistence/fileLock.js';
import { RunStore } from '../src/persistence/runStore.js';
import type { Task } from '../src/tasks/task.js';
import { makeTask } from './helpers.js';
import {
  BAD,
  CHAIN_WORK,
  FakeAgent,
  GOOD,
  STUB,
  chainAgent,
  deadPid,
  git,
  makeChainFixture,
  ok,
  type AgentBehavior,
  type Fixture,
} from './gitFixture.js';

const exists = (p: string) => access(p).then(() => true, () => false);

describe('autonomous runner', () => {
  let fx: Fixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  async function setup(behavior: AgentBehavior, overrides: Parameters<typeof makeChainFixture>[0] = {}, clock?: () => Date) {
    fx = await makeChainFixture(overrides);
    return build(fx, behavior, clock);
  }

  function build(f: Fixture, behavior: AgentBehavior, clock?: () => Date) {
    const agent = new FakeAgent(behavior);
    const lock = new FileLock(f.config.dataDir);
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const supervisor = new Supervisor({ config: f.config, repository: f.repository, agent, lock, log, ...(clock ? { now: clock } : {}) });
    const runner = new AutonomousRunner({ config: f.config, repository: f.repository, supervisor, lock, log, ...(clock ? { now: clock } : {}) });
    return { fx: f, agent, supervisor, runner, logs, lock };
  }

  /** A second, independent runner on the same project (as another process would be). */
  function other(f: Fixture) {
    return build(f, chainAgent);
  }

  const tasksOf = async (f: Fixture) => new Map((await f.repository.loadTasks()).map((t) => [t.id, t] as const));
  const taskIds = (agent: FakeAgent) => agent.requests.map((r) => r.task.id);

  describe('sequential processing', () => {
    it('processes dependent tasks in order, each building on the accepted work before it', async () => {
      const { fx, agent, runner } = await setup(chainAgent);
      const record = await runner.start();

      assert.equal(record.state, 'completed');
      assert.equal(record.stop?.reason, 'all-complete');
      assert.deepEqual(taskIds(agent), ['T1', 'T2', 'T3']);
      assert.deepEqual(record.executions.map((e) => [e.taskId, e.result]), [
        ['T1', 'auto-accepted'],
        ['T2', 'auto-accepted'],
        ['T3', 'auto-accepted'],
      ]);
      // Each task's base is the previous task's accepted commit (stacked, never merged into the user's branch).
      const [e1, e2, e3] = record.executions;
      assert.equal(e1!.baseCommit, fx.head);
      assert.equal(e2!.baseCommit, e1!.acceptedCommit);
      assert.equal(e3!.baseCommit, e2!.acceptedCommit);
      assert.equal(record.tip, e3!.acceptedCommit);
      // The final commit contains all three tasks' work, and every check ran green.
      assert.equal(git(fx.dir, 'show', `${e3!.acceptedCommit}:src/greet.js`), GOOD);
      assert.equal(git(fx.dir, 'show', `${e3!.acceptedCommit}:src/farewell.js`), CHAIN_WORK.T2!['src/farewell.js']);
      for (const e of record.executions) assert.deepEqual(e.validation?.map((v) => v.exitCode), [0]);

      const tasks = await tasksOf(fx);
      for (const id of ['T1', 'T2', 'T3']) {
        assert.equal(tasks.get(id)!.status, 'completed');
        assert.equal(tasks.get(id)!.results.at(-1)?.review?.by, 'policy');
      }
      // The user's branch and working tree are untouched; the lock is released.
      assert.equal(git(fx.dir, 'rev-parse', 'HEAD').trim(), fx.head);
      assert.equal(await readFile(path.join(fx.dir, 'src', 'greet.js'), 'utf8'), STUB);
      assert.equal(git(fx.dir, 'status', '--porcelain', '--', 'src', 'test').trim(), '');
      assert.equal(await exists(path.join(fx.config.dataDir, 'factory.lock')), false);
      // Persisted history matches what was returned.
      assert.deepEqual(await new AutoRunStore(fx.config.dataDir).load(record.autoRunId), record);
      assert.deepEqual(record.summary, { total: 3, completed: 3, awaitingReview: 0, failed: 0, needsAttention: 0, inProgress: 0, pending: 0 });
    });

    it('re-reads the persisted backlog after every task', async () => {
      let added = false;
      const { fx, agent, runner } = await setup(async (cwd, hooks, request) => {
        if (request!.task.id === 'T1' && !added) {
          added = true;
          // Someone adds a task while T1 runs; the runner must see it later.
          const tasks = await fx!.repository.loadTasks();
          await fx!.repository.saveTasks([...tasks, makeTask('T4', { title: 'Add extra', description: 'Add an extra module' })]);
        }
        if (request!.task.id === 'T4') {
          await writeFile(path.join(cwd, 'src', 'extra.js'), 'export const extra = 1;\n');
          return ok();
        }
        return chainAgent(cwd, hooks, request);
      }, { autonomy: { enabled: true, autoAccept: { enabled: true, taskIds: ['T1', 'T2', 'T3', 'T4'], paths: ['src', 'test'] } } });
      const record = await runner.start();
      assert.equal(record.state, 'completed');
      assert.deepEqual(taskIds(agent), ['T1', 'T2', 'T3', 'T4']);
      assert.equal((await tasksOf(fx)).get('T4')!.status, 'completed');
    });

    it('skips completed tasks and stops when nothing is left', async () => {
      const { fx, agent, runner } = await setup(chainAgent);
      // T1 was completed and merged by a person before this run.
      await writeFile(path.join(fx.dir, 'src', 'greet.js'), GOOD);
      git(fx.dir, 'commit', '-q', '-am', 'greet by hand');
      const tasks = await fx.repository.loadTasks();
      await fx.repository.saveTasks(tasks.map((t) => (t.id === 'T1' ? { ...t, status: 'completed' as const } : t)));

      const record = await runner.start();
      assert.equal(record.state, 'completed');
      assert.deepEqual(taskIds(agent), ['T2', 'T3']);

      const again = await runner.start();
      assert.equal(again.state, 'completed');
      assert.equal(again.executions.length, 0);
      assert.deepEqual(taskIds(agent), ['T2', 'T3']);
    });
  });

  describe('human review gate', () => {
    it('pauses at review, continues on the human-accepted commit after resume', async () => {
      const { fx, agent, supervisor, runner } = await setup(chainAgent, { autonomy: { enabled: true } });
      const first = await runner.start();
      assert.equal(first.state, 'paused');
      assert.equal(first.stop?.reason, 'awaiting-review');
      assert.match(first.stop!.action, /factory review T1/);
      assert.deepEqual(first.executions[0]!.reviewReasons, ['auto-accept is disabled (config.autonomy.autoAccept.enabled is false)']);
      assert.deepEqual(taskIds(agent), ['T1']);
      assert.equal((await tasksOf(fx)).get('T1')!.status, 'awaiting_review');
      assert.equal((await tasksOf(fx)).get('T2')!.status, 'pending');

      // Resuming without a decision does nothing new.
      const waiting = await runner.resume();
      assert.equal(waiting.stop?.reason, 'awaiting-review');
      assert.deepEqual(taskIds(agent), ['T1']);

      const accepted = await supervisor.accept('T1');
      const resumed = await runner.resume();
      assert.equal(resumed.autoRunId, first.autoRunId);
      assert.equal(resumed.stop?.reason, 'awaiting-review');
      assert.deepEqual(taskIds(agent), ['T1', 'T2']);
      assert.equal(resumed.executions[0]!.result, 'accepted');
      assert.equal(resumed.lastCompletedTask?.taskId, 'T1');
      assert.equal(resumed.lastCompletedTask?.by, 'human');
      assert.equal(resumed.executions[1]!.baseCommit, accepted.run.acceptedCommit);
      assert.equal(resumed.tip, accepted.run.acceptedCommit);
      assert.deepEqual(resumed.executions[1]!.validation?.map((v) => v.exitCode), [0]);
    });

    it('a rejected task is not retried automatically; --retry-failed allows it', async () => {
      const { agent, supervisor, runner } = await setup(chainAgent, { autonomy: { enabled: true } });
      await runner.start();
      await supervisor.reject('T1', 'Not the style we want');
      const paused = await runner.resume();
      assert.equal(paused.stop?.reason, 'task-failed');
      assert.match(paused.stop!.action, /--retry-failed/);
      assert.equal(paused.executions[0]!.result, 'rejected');
      assert.deepEqual(taskIds(agent), ['T1']);

      const retried = await runner.resume({ retryFailed: true });
      assert.equal(retried.stop?.reason, 'awaiting-review');
      assert.deepEqual(taskIds(agent), ['T1', 'T1']);
    });

    it('only listed, low-risk results are auto-accepted', async () => {
      const { fx, runner } = await setup(chainAgent, {
        autonomy: { enabled: true, autoAccept: { enabled: true, taskIds: ['T1'], paths: ['src', 'test'] } },
      });
      const record = await runner.start();
      assert.deepEqual(record.executions.map((e) => e.result), ['auto-accepted', 'awaiting-review']);
      assert.ok(record.executions[1]!.reviewReasons!.some((r) => /not listed in config.autonomy.autoAccept.taskIds/.test(r)));
      assert.equal((await tasksOf(fx)).get('T2')!.status, 'awaiting_review');
      assert.equal((await tasksOf(fx)).get('T3')!.status, 'pending');
    });

    it('security-sensitive tasks always wait for a person', async () => {
      const tasks: Task[] = [makeTask('T1', { title: 'Implement greet', description: 'Store the password hash for greet users' })];
      const { runner } = await setup(chainAgent, { tasks });
      const record = await runner.start();
      assert.equal(record.stop?.reason, 'awaiting-review');
      assert.ok(record.executions[0]!.reviewReasons!.some((r) => /security-sensitive topic \("password"\)/.test(r)));
    });
  });

  describe('failures and bounded repair', () => {
    it('agent errors stop the run without repairs or further tasks', async () => {
      const { fx, agent, runner } = await setup(async () => {
        throw new Error('agent crashed');
      }, { execution: { maxRepairAttempts: 2 } });
      const record = await runner.start();
      assert.equal(record.state, 'paused');
      assert.equal(record.stop?.reason, 'task-failed');
      assert.equal(record.executions[0]!.result, 'failed');
      assert.match(record.executions[0]!.failureReason!, /unexpected error/);
      assert.equal(agent.calls.length, 1);
      assert.equal((await tasksOf(fx)).get('T2')!.status, 'pending');
    });

    it('repairs a validation failure with the real check output, then waits for review', async () => {
      const { fx, agent, runner } = await setup(async (cwd, _hooks, request) => {
        await writeFile(path.join(cwd, 'src', 'greet.js'), request!.repair ? GOOD : BAD);
        return ok();
      }, { execution: { maxRepairAttempts: 2 } });
      const record = await runner.start();
      assert.equal(agent.calls.length, 2);
      const repair = agent.requests[1]!.repair!;
      assert.equal(repair.attempt, 1);
      assert.equal(repair.maxAttempts, 2);
      assert.equal(repair.failures[0]!.name, 'test');
      assert.match(repair.failures[0]!.output, /Hello, Ada!/);
      assert.deepEqual(agent.requests[1]!.task.acceptanceCriteria, ['greet test passes']);

      // A repaired result passed, but failed checks always go to a person.
      assert.equal(record.stop?.reason, 'awaiting-review');
      assert.equal(record.executions[0]!.repairs, 1);
      assert.ok(record.executions[0]!.reviewReasons!.some((r) => /needed 1 repair attempt/.test(r)));
      const run = await new RunStore(fx.config.dataDir).load(record.executions[0]!.runId!);
      assert.equal(run.repairs?.length, 1);
      assert.notEqual(run.repairs![0]!.failedValidation[0]!.exitCode, 0);
      assert.equal(run.validation?.[0]?.exitCode, 0);
      assert.equal(run.outcome, 'success');
    });

    it('stops after the repair limit, preserves the failed work, and never retries indefinitely', async () => {
      const { fx, agent, runner } = await setup(async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'greet.js'), BAD);
        return ok();
      }, { execution: { maxRepairAttempts: 2 } });
      const first = await runner.start();
      assert.equal(agent.calls.length, 3); // 1 attempt + 2 repairs
      assert.equal(first.stop?.reason, 'task-failed');
      assert.match(first.executions[0]!.failureReason!, /Validation failed: test \(exit 1\) \(after 2 repair attempt\(s\)\)/);
      const t1 = (await tasksOf(fx)).get('T1')!;
      assert.equal(t1.status, 'failed');
      assert.equal(t1.retryCount, 1);
      const run = await new RunStore(fx.config.dataDir).load(first.executions[0]!.runId!);
      assert.equal(run.repairs?.length, 2);
      assert.equal(await readFile(path.join(run.worktreePath!, 'src', 'greet.js'), 'utf8'), BAD);

      // Not retried automatically.
      assert.equal((await runner.resume()).stop?.reason, 'task-failed');
      assert.equal(agent.calls.length, 3);
      // An explicit retry is bounded by limits.maxRetries (1): the second failure exhausts it.
      const second = await runner.resume({ retryFailed: true });
      assert.equal(agent.calls.length, 6);
      assert.equal(second.stop?.reason, 'needs-attention');
      assert.equal((await tasksOf(fx)).get('T1')!.status, 'needs_attention');
      const third = await runner.resume({ retryFailed: true });
      assert.equal(third.stop?.reason, 'needs-attention');
      assert.equal(agent.calls.length, 6);
      assert.match(third.stop!.message, /No eligible tasks remain/);
    });

    it('policy violations are never repaired', async () => {
      const { agent, runner } = await setup(async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'greet.js'), BAD);
        await writeFile(path.join(cwd, '.gitattributes'), '* text\n');
        return ok();
      }, { execution: { maxRepairAttempts: 3 } });
      const record = await runner.start();
      assert.equal(agent.calls.length, 1);
      assert.equal(record.stop?.reason, 'task-failed');
    });

    it('a failure blocks dependants and the run reports what is blocked', async () => {
      const { fx, runner } = await setup(chainAgent);
      const tasks = await fx.repository.loadTasks();
      await fx.repository.saveTasks(tasks.map((t) => (t.id === 'T1' ? { ...t, status: 'needs_attention' as const, retryCount: 2 } : t)));
      const record = await runner.start();
      assert.equal(record.stop?.reason, 'needs-attention');
      assert.match(record.stop!.message, /T2: waiting on dependencies: T1/);
      assert.equal(record.executions.length, 0);
    });
  });

  describe('limits', () => {
    it('stops at the task limit; a stopped run cannot be resumed', async () => {
      const { fx, runner } = await setup(chainAgent);
      await assert.rejects(runner.start({ maxTasks: 11 }), ValidationError);
      const record = await runner.start({ maxTasks: 1 });
      assert.equal(record.state, 'stopped');
      assert.equal(record.stop?.reason, 'task-limit');
      assert.equal(record.executions.length, 1);
      assert.equal((await tasksOf(fx)).get('T2')!.status, 'pending');
      await assert.rejects(runner.resume(), InvalidTransitionError);
      const next = await runner.start();
      assert.notEqual(next.autoRunId, record.autoRunId);
      assert.equal(next.state, 'completed');
    });

    it('stops at the run duration limit and bounds each agent call by the task budget', async () => {
      let offset = 0;
      const clock = () => new Date(Date.UTC(2026, 0, 1) + offset);
      const { agent, runner } = await setup(async (cwd, hooks, request) => {
        offset += 20 * 60_000;
        return chainAgent(cwd, hooks, request);
      }, { autonomy: { ...AUTONOMY, maxRunDurationMs: 30 * 60_000, maxTaskDurationMs: 25 * 60_000 } }, clock);
      const record = await runner.start();
      assert.equal(record.state, 'stopped');
      assert.equal(record.stop?.reason, 'duration-limit');
      assert.deepEqual(taskIds(agent), ['T1', 'T2']);
      // Both calls fit the remaining budget, so the plan timeout (60 s) applies; the clock decides the stop.
      assert.deepEqual(agent.timeouts, [60_000, 60_000]);
      assert.ok(record.activeMs >= 40 * 60_000);
    });

    it('per-task deadline shortens the agent timeout', async () => {
      const { agent, runner } = await setup(chainAgent, { autonomy: { ...AUTONOMY, maxTaskDurationMs: 15_000 } });
      await runner.start({ maxTasks: 1 });
      assert.ok(agent.timeouts[0]! <= 15_000 && agent.timeouts[0]! > 10_000, `timeout ${agent.timeouts[0]}`);
    });

  });

  describe('cost budget', () => {
    // Each agent call may spend up to agent.maxBudgetUsd ($1); calls only start when the rest of the run budget covers that.
    const agentConfig = { permissionMode: 'dontAsk', tools: ['Read', 'Edit', 'Write'], allowedTools: ['Read', 'Edit', 'Write'], maxBudgetUsd: 1 };
    const costed = (cost: number | undefined, behavior: AgentBehavior = chainAgent): AgentBehavior => async (cwd, hooks, request) => {
      const result = await behavior(cwd, hooks, request);
      const details = { exitCode: 0, timedOut: false, durationMs: 1, truncated: false, killFailed: false, stdout: '', stderr: '' };
      return { ...result, details: cost === undefined ? details : { ...details, costUsd: cost } };
    };
    const budget = (maxCostUsd: number, execution: Record<string, unknown> = {}) => ({
      autonomy: { ...AUTONOMY, maxCostUsd },
      config: { agent: agentConfig, commands: TEST_ALL },
      execution,
    });
    const failsChecks: AgentBehavior = async (cwd) => {
      await writeFile(path.join(cwd, 'src', 'greet.js'), BAD);
      return ok();
    };

    it('stops before a task when the remaining budget cannot cover one more call', async () => {
      const { agent, runner } = await setup(costed(0.7), budget(2));
      const record = await runner.start();
      // $0.70 used: $1.30 left covers a call. $1.40 used: $0.60 left does not.
      assert.equal(agent.calls.length, 2);
      assert.equal(record.stop?.reason, 'cost-limit');
      assert.equal(record.state, 'stopped');
      assert.ok(Math.abs(record.costUsd - 1.4) < 1e-9);
      assert.ok(record.costUsd <= 2);
      assert.match(record.stop!.message, /\$0\.6000 left cannot cover another agent call \(up to \$1 each\)/);
    });

    it('allows exactly as many calls as the budget covers', async () => {
      const { agent, runner } = await setup(costed(1), budget(3));
      const record = await runner.start();
      assert.equal(agent.calls.length, 3);
      assert.equal(record.costUsd, 3);
      assert.equal(record.stop?.reason, 'all-complete');
    });

    it('checks the budget before every repair, not only between tasks', async () => {
      const { fx, agent, runner } = await setup(costed(0.9, failsChecks), budget(2, { maxRepairAttempts: 3 }));
      const record = await runner.start();
      // Call 1: $0.90 (left $1.10). Repair 1: $1.80 (left $0.20): repair 2 must not start.
      assert.equal(agent.calls.length, 2);
      assert.ok(record.costUsd <= 2);
      assert.equal(record.stop?.reason, 'task-failed');
      assert.match(record.executions[0]!.failureReason!, /after 1 repair attempt\(s\); repair stopped: run cost budget insufficient \(\$0\.2000 left/);
      const run = await new RunStore(fx.config.dataDir).load(record.executions[0]!.runId!);
      assert.equal(run.repairs?.length, 1);
    });

    it('does not repair when the cost of an earlier call is unknown', async () => {
      const { agent, runner } = await setup(costed(undefined, failsChecks), budget(3, { maxRepairAttempts: 2 }));
      const record = await runner.start();
      assert.equal(agent.calls.length, 1);
      assert.match(record.executions[0]!.failureReason!, /repair stopped: the cost of an earlier agent call is unknown/);
      assert.equal(record.costUnknown, true);
    });

    it('stops before the next task when a call did not report its cost', async () => {
      const { agent, runner } = await setup(costed(undefined), budget(3));
      const record = await runner.start();
      assert.equal(agent.calls.length, 1);
      assert.equal(record.stop?.reason, 'cost-limit');
      assert.equal(record.costUnknown, true);
      assert.match(record.stop!.message, /did not report its cost/);
    });

    it('repairs are unaffected when no run cost budget is configured', async () => {
      const { agent } = await setup(costed(0.9, failsChecks), { execution: { maxRepairAttempts: 2 } });
      const supervisor = new Supervisor({ config: fx!.config, repository: fx!.repository, agent });
      await supervisor.execute('T1');
      assert.equal(agent.calls.length, 3);
    });

    it('execute refuses, without changing anything, when the budget cannot cover the first call', async () => {
      const { fx, agent, supervisor } = await setup(costed(0.5), budget(3));
      await assert.rejects(supervisor.execute('T1', { budgetUsd: 0.5 }), (err: unknown) => err instanceof LimitExceededError && /\$0\.5000 left/.test(err.message));
      assert.equal(agent.calls.length, 0);
      assert.equal((await tasksOf(fx)).get('T1')!.status, 'pending');
      assert.equal(await exists(path.join(fx.config.dataDir, 'runs')), false);
    });
  });

  describe('pause, resume and stop', () => {
    it('pauses after the current task on request and resumes where it left off', async () => {
      let requested = '';
      const { fx, agent, runner } = await setup(async (cwd, hooks, request) => {
        if (request!.task.id === 'T1') requested = await other(fx!).runner.request('pause');
        return chainAgent(cwd, hooks, request);
      });
      const paused = await runner.start();
      assert.match(requested, /Pause requested/);
      assert.equal(paused.state, 'paused');
      assert.equal(paused.stop?.reason, 'pause-requested');
      assert.equal(paused.lastCompletedTask?.taskId, 'T1');
      assert.deepEqual(taskIds(agent), ['T1']);

      const status = await other(fx).runner.status();
      assert.equal(status.record?.state, 'paused');
      assert.equal(status.counts?.completed, 1);
      assert.match(await other(fx).runner.request('pause'), /already paused/);

      const done = await runner.resume();
      assert.equal(done.state, 'completed');
      assert.deepEqual(taskIds(agent), ['T1', 'T2', 'T3']);
      assert.equal(done.segments.length, 2);
      assert.equal(done.segments[0]!.reason, 'pause-requested');
    });

    it('stop prevents new tasks from starting', async () => {
      const { fx, agent, runner } = await setup(async (cwd, hooks, request) => {
        if (request!.task.id === 'T1') await other(fx!).runner.request('stop');
        return chainAgent(cwd, hooks, request);
      });
      const record = await runner.start();
      assert.equal(record.state, 'stopped');
      assert.equal(record.stop?.reason, 'stop-requested');
      assert.deepEqual(taskIds(agent), ['T1']);
      await assert.rejects(runner.resume(), /no paused autonomous run/);
    });

    it('stop ends a paused run; Ctrl+C (in-process request) pauses', async () => {
      let runnerRef: AutonomousRunner | undefined;
      const { fx, runner } = await setup(async (cwd, hooks, request) => {
        runnerRef!.requestPauseInProcess();
        return chainAgent(cwd, hooks, request);
      });
      runnerRef = runner;
      const paused = await runner.start();
      assert.equal(paused.stop?.reason, 'pause-requested');
      assert.match(await other(fx).runner.request('stop'), /stopped/);
      const history = await runner.history();
      assert.equal(history.length, 1);
      assert.equal(history[0]!.state, 'stopped');
      assert.match(await runner.request('pause'), /no active autonomous run/);
    });

    it('a new run cannot start while another is paused', async () => {
      const { runner } = await setup(chainAgent, { autonomy: { enabled: true } });
      await runner.start();
      await assert.rejects(runner.start(), /is paused\. Resume it/);
    });
  });

  describe('concurrency', () => {
    it('a running autonomous run blocks other runners and manual commands', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const { fx, runner } = await setup(async (cwd, hooks, request) => {
        entered();
        await gate;
        return chainAgent(cwd, hooks, request);
      });
      const running = runner.start({ maxTasks: 1 });
      await inside;
      const second = other(fx);
      await assert.rejects(second.runner.start(), LockHeldError);
      await assert.rejects(second.runner.resume(), LockHeldError);
      await assert.rejects(second.supervisor.execute('T2'), LockHeldError);
      await assert.rejects(second.runner.recover(), LockHeldError);
      const status = await second.runner.status();
      assert.equal(status.record?.state, 'running');
      assert.equal(status.ownerAlive, true);
      assert.equal(status.record?.currentTask?.taskId, 'T1');
      assert.ok(status.record?.currentTask?.runId);
      release();
      const record = await running;
      assert.equal(record.stop?.reason, 'task-limit');
      assert.equal((await tasksOf(fx)).get('T1')!.status, 'completed');
    });
  });

  describe('policy', () => {
    it('refuses to start when autonomy or safe execution is not configured', async () => {
      const off = await setup(chainAgent, { autonomy: { enabled: false } });
      await assert.rejects(off.runner.start(), ExecutionPolicyError);
      await fx!.cleanup();
      const unsafe = await setup(chainAgent, { config: { agent: { permissionMode: 'plan' }, commands: TEST_ALL } });
      await assert.rejects(unsafe.runner.start(), ExecutionPolicyError);
      await fx!.cleanup();
      const shell = await setup(chainAgent, { config: { agent: { permissionMode: 'dontAsk', tools: ['Read', 'Bash'], allowedTools: ['Read'] }, commands: TEST_ALL } });
      await assert.rejects(shell.runner.start(), /tool "Bash" is not allowed/);
    });

    it('an agent change to the factory config is a violation, so budgets cannot be raised', async () => {
      fx = await makeChainFixture();
      // Commit a config file inside the repository and load it from disk.
      const raw = { ...fx.rawConfig, autonomy: AUTONOMY };
      await writeFile(path.join(fx.dir, 'factory.config.json'), `${JSON.stringify(raw, null, 2)}\n`);
      git(fx.dir, 'add', 'factory.config.json');
      git(fx.dir, 'commit', '-q', '-m', 'config');
      const config = await loadFactoryConfig(path.join(fx.dir, 'factory.config.json'));
      const f: Fixture = { ...fx, config };
      const { runner } = build(f, async (cwd, hooks, request) => {
        await writeFile(path.join(cwd, 'factory.config.json'), JSON.stringify({ ...raw, limits: { maxRetries: 10 } }));
        return chainAgent(cwd, hooks, request);
      });
      const record = await runner.start();
      assert.equal(record.stop?.reason, 'task-failed');
      assert.match(record.executions[0]!.failureReason!, /protected-path/);
    });

    it('records are sanitized: no secrets in run history, run records or tasks', async () => {
      const secret = 'sk-ant-api03-SECRETSECRETSECRETSECRET';
      const { fx, runner } = await setup(async () => ({ outcome: 'failure', summary: `could not finish, key ${secret}`, error: `token=${secret}` }) satisfies AgentRunResult);
      const record = await runner.start();
      assert.equal(record.stop?.reason, 'task-failed');
      const files = [
        path.join(fx.config.dataDir, 'autoruns', record.autoRunId, 'autorun.json'),
        path.join(fx.config.dataDir, 'runs', record.executions[0]!.runId!, 'run.json'),
        path.join(fx.config.dataDir, 'tasks.json'),
      ];
      for (const file of files) {
        const text = await readFile(file, 'utf8');
        assert.ok(!text.includes(secret), `${file} leaks the secret`);
        assert.ok(!/"(env|environment)"/.test(text), `${file} stores an environment`);
      }
      assert.match(record.executions[0]!.failureReason!, /\[REDACTED\]/);
    });
  });

  describe('recovery', () => {
    it('reconciles a run whose runner died: interrupted task is failed, not repeated, and the run resumes', async () => {
      const { fx, agent, runner } = await setup(chainAgent);
      // Simulate a crash: an autonomous run and an execution recorded as running by a dead process.
      const store = new AutoRunStore(fx.config.dataDir);
      const started = await runner.start({ maxTasks: 1 }); // T1 completed normally
      const record = await store.load(started.autoRunId);
      record.state = 'running';
      record.owner = { pid: deadPid(), hostname: os.hostname(), since: record.updatedAt };
      record.segments.push({ startedAt: record.updatedAt });
      record.limits.maxTasks = 5;
      delete record.stop;
      record.executions.push({ taskId: 'T2', startedAt: record.updatedAt, result: 'running', repairs: 0 });
      await store.save(record);

      const status = await runner.status();
      assert.equal(status.ownerAlive, false);
      const report = await runner.recover();
      assert.ok(report.actions.some((a) => /marked paused \(interrupted\)/.test(a)), report.actions.join('\n'));
      const recovered = await store.load(started.autoRunId);
      assert.equal(recovered.state, 'paused');
      assert.equal(recovered.stop?.reason, 'interrupted');
      assert.equal(recovered.executions[1]!.result, 'interrupted');

      const resumed = await runner.resume();
      assert.equal(resumed.state, 'completed');
      assert.deepEqual(taskIds(agent), ['T1', 'T2', 'T3']);
    });
  });
});

const TEST_ALL = { test: { executable: 'node', args: ['--test'] } };
const AUTONOMY = { enabled: true, autoAccept: { enabled: true, taskIds: ['T1', 'T2', 'T3'], paths: ['src', 'test'] } };
