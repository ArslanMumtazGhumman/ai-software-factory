import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  AgentExecutionDisabledError,
  ExecutionPolicyError,
  GitIsolationError,
  InvalidTransitionError,
  LockHeldError,
  TamperDetectedError,
  TaskNotFoundError,
  ValidationError,
} from '../src/core/errors.js';
import { GitWorkspace } from '../src/git/gitWorkspace.js';
import { ClaudeCodeAdapter } from '../src/agents/claudeCodeAdapter.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { Supervisor } from '../src/orchestrator/supervisor.js';
import { FileLock } from '../src/persistence/fileLock.js';
import { RunStore } from '../src/persistence/runStore.js';
import { explainTasks } from '../src/tasks/taskSelector.js';
import { makeTask } from './helpers.js';
import { BAD, FakeAgent, GOOD, STUB, deadPid, git, makeFixture, ok, writesFile, type AgentBehavior, type Fixture } from './gitFixture.js';

const exists = (p: string) => access(p).then(() => true, () => false);

describe('supervised execution', () => {
  let fx: Fixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  async function setup(behavior: AgentBehavior, opts: Parameters<typeof makeFixture>[0] = {}) {
    fx = await makeFixture(opts);
    const agent = new FakeAgent(behavior);
    const supervisor = new Supervisor({ config: fx.config, repository: fx.repository, agent });
    return { fx, agent, supervisor };
  }

  const taskOf = async (f: Fixture, id: string) => (await f.repository.loadTasks()).find((t) => t.id === id)!;
  const lockPath = (f: Fixture) => path.join(f.config.dataDir, 'factory.lock');

  it('runs one task in an isolated worktree, validates it and stops for review', async () => {
    const { fx, agent, supervisor } = await setup(writesFile('src/greet.js', GOOD));
    const report = await supervisor.execute('T1');

    assert.equal(report.run.outcome, 'success');
    assert.equal(report.task.status, 'awaiting_review');
    assert.equal(report.task.currentRunId, report.runId);
    // Agent ran only inside the factory-managed worktree, never in the project itself.
    assert.deepEqual(agent.calls, [path.join(fx.config.dataDir, 'worktrees', report.runId)]);
    assert.notEqual(path.resolve(agent.calls[0]!), path.resolve(fx.dir));
    assert.equal(await readFile(path.join(report.run.worktreePath!, 'src', 'greet.js'), 'utf8'), GOOD);
    // The user's working tree and branch are untouched.
    assert.equal(await readFile(path.join(fx.dir, 'src', 'greet.js'), 'utf8'), STUB);
    assert.equal(git(fx.dir, 'rev-parse', 'HEAD').trim(), fx.head);
    assert.equal(git(fx.dir, 'status', '--porcelain', '--', 'src', 'test').trim(), '');
    // Evidence.
    assert.equal(report.run.baseCommit, fx.head);
    assert.equal(report.run.validation?.[0]?.exitCode, 0);
    assert.deepEqual(report.run.review?.changedFiles.map((f) => `${f.status} ${f.path}`), ['M src/greet.js']);
    const patch = await readFile(path.join(fx.config.dataDir, 'runs', report.runId, 'diff.patch'), 'utf8');
    assert.match(patch, /\+  return `Hello, \$\{name\}!`;/);
    // Dependants stay blocked until acceptance; lock released.
    const t2 = explainTasks(await fx.repository.loadTasks(), 1).find((e) => e.task.id === 'T2')!;
    assert.equal(t2.eligibility.eligible, false);
    assert.equal(await exists(lockPath(fx)), false);
  });

  it('accept completes the task, unlocks dependants and merges nothing', async () => {
    const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
    const { run } = await supervisor.execute('T1');
    const accepted = await supervisor.accept('T1');
    assert.equal(accepted.task.status, 'completed');
    assert.equal(accepted.task.currentRunId, undefined);
    assert.equal(accepted.task.results.at(-1)?.review?.decision, 'accepted');
    assert.equal(accepted.run.state, 'accepted');
    const t2 = explainTasks(await fx.repository.loadTasks(), 1).find((e) => e.task.id === 'T2')!;
    assert.equal(t2.eligibility.eligible, true);
    assert.equal(git(fx.dir, 'rev-parse', 'HEAD').trim(), fx.head);
    assert.equal(await readFile(path.join(fx.dir, 'src', 'greet.js'), 'utf8'), STUB);
    assert.ok(await exists(run.worktreePath!));
    await assert.rejects(supervisor.accept('T1'), InvalidTransitionError);
  });

  it('reject preserves the work and counts a failed attempt', async () => {
    const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
    const { run } = await supervisor.execute('T1');
    const rejected = await supervisor.reject('T1', 'Wrong greeting style');
    assert.equal(rejected.task.status, 'failed');
    assert.equal(rejected.task.retryCount, 1);
    assert.equal(rejected.task.results.at(-1)?.review?.reason, 'Wrong greeting style');
    assert.equal(rejected.run.state, 'rejected');
    assert.equal(await readFile(path.join(run.worktreePath!, 'src', 'greet.js'), 'utf8'), GOOD);
    assert.match(git(fx.dir, 'branch', '--list', 'asf/*'), new RegExp(run.runId));
    const t2 = explainTasks(await fx.repository.loadTasks(), 1).find((e) => e.task.id === 'T2')!;
    assert.equal(t2.eligibility.eligible, false);
    await assert.rejects(supervisor.reject('T1', 'again'), InvalidTransitionError);
    await assert.rejects(supervisor.reject('T2', ' '), ValidationError);
  });

  it('a second rejection after a retry exhausts retries (needs_attention)', async () => {
    const { supervisor } = await setup(writesFile('src/greet.js', GOOD));
    await supervisor.execute('T1');
    await supervisor.reject('T1', 'first');
    await supervisor.execute('T1');
    const second = await supervisor.reject('T1', 'second');
    assert.equal(second.task.status, 'needs_attention');
    await assert.rejects(supervisor.execute('T1'), /not eligible/);
  });

  describe('tamper detection before acceptance', () => {
    it('detects worktree changes made after review', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      const { run } = await supervisor.execute('T1');
      await writeFile(path.join(run.worktreePath!, 'src', 'extra.js'), 'export const x = 1;\n');
      await assert.rejects(supervisor.accept('T1'), (err: unknown) => err instanceof TamperDetectedError && /worktree content changed/.test(err.message));
      assert.equal((await taskOf(fx, 'T1')).status, 'awaiting_review');
      assert.equal(await exists(lockPath(fx)), false);
    });

    it('detects edits to the recorded run evidence', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      const { runId } = await supervisor.execute('T1');
      const file = path.join(fx.config.dataDir, 'runs', runId, 'run.json');
      const run = JSON.parse(await readFile(file, 'utf8'));
      run.validation[0].exitCode = 0;
      run.agent.summary = 'edited';
      await writeFile(file, JSON.stringify(run));
      await assert.rejects(supervisor.accept('T1'), /evidence digest mismatch/);
      const view = await supervisor.review('T1');
      assert.ok(view.integrityProblems.some((p) => /evidence digest/.test(p)));
    });

    it('detects edits to the recorded diff', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      const { runId } = await supervisor.execute('T1');
      await writeFile(path.join(fx.config.dataDir, 'runs', runId, 'diff.patch'), 'nothing to see\n');
      await assert.rejects(supervisor.accept('T1'), /diff.patch changed/);
    });
  });

  describe('failures are recorded truthfully and the worktree is preserved', () => {
    it('agent failure skips validation', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD, { outcome: 'failure', summary: 'gave up', error: 'boom' }));
      const report = await supervisor.execute('T1');
      assert.equal(report.task.status, 'failed');
      assert.equal(report.task.retryCount, 1);
      assert.equal(report.task.currentRunId, undefined);
      assert.match(report.run.failureReason!, /Agent failed: gave up/);
      assert.deepEqual(report.run.validation, []);
      assert.ok(await exists(report.run.worktreePath!));
      assert.equal(report.task.results.at(-1)?.runId, report.runId);
      assert.equal(await exists(lockPath(fx)), false);
    });

    it('agent timeout', async () => {
      const { supervisor } = await setup(async () => ({
        outcome: 'failure',
        summary: 'Claude Code timed out after 1000 ms',
        details: { exitCode: null, timedOut: true, durationMs: 1000, truncated: false, killFailed: false, stdout: '', stderr: '' },
      }));
      const report = await supervisor.execute('T1');
      assert.equal(report.task.status, 'failed');
      assert.equal(report.run.agent?.timedOut, true);
      assert.match(report.run.failureReason!, /timed out/);
    });

    it('agent throwing unexpectedly', async () => {
      const { supervisor } = await setup(async () => {
        throw new Error('adapter exploded');
      });
      const report = await supervisor.execute('T1');
      assert.equal(report.task.status, 'failed');
      assert.match(report.run.agent!.error!, /adapter exploded/);
    });

    it('validation failure', async () => {
      const { supervisor } = await setup(writesFile('src/greet.js', BAD));
      const report = await supervisor.execute('T1');
      assert.equal(report.task.status, 'failed');
      assert.notEqual(report.run.validation?.[0]?.exitCode, 0);
      assert.match(report.run.failureReason!, /Validation failed: test/);
    });

    it('sensitive files fail the diff review even when tests pass', async () => {
      const { supervisor } = await setup(async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'greet.js'), GOOD);
        await writeFile(path.join(cwd, '.env'), 'API_KEY=x\n');
        return ok();
      });
      const report = await supervisor.execute('T1');
      assert.equal(report.run.validation?.[0]?.exitCode, 0);
      assert.equal(report.task.status, 'failed');
      assert.ok(report.run.review!.findings.some((f) => f.rule === 'sensitive-file' && f.path === '.env'));
    });

    it('deletions, protected paths and out-of-scope changes fail the review', async () => {
      const { supervisor } = await setup(
        async (cwd) => {
          await writeFile(path.join(cwd, 'src', 'greet.js'), GOOD);
          await writeFile(path.join(cwd, 'README.md'), 'scope creep\n');
          await writeFile(path.join(cwd, '.gitattributes'), '* text\n');
          const { rm } = await import('node:fs/promises');
          await rm(path.join(cwd, '.gitignore'));
          return ok();
        },
        { execution: { allowedPaths: ['src'] } },
      );
      const report = await supervisor.execute('T1');
      const rules = new Set(report.run.review!.findings.map((f) => f.rule));
      assert.ok(rules.has('deletion'));
      assert.ok(rules.has('protected-path'));
      assert.ok(rules.has('out-of-scope'));
      assert.equal(report.task.status, 'failed');
    });

    it('validation that modifies the worktree is a violation', async () => {
      const { supervisor } = await setup(writesFile('src/greet.js', GOOD), {
        config: {
          commands: {
            test: { executable: 'node', args: ['-e', "require('fs').writeFileSync('generated.txt','x')"] },
          },
        },
      });
      const report = await supervisor.execute('T1');
      assert.ok(report.run.review!.findings.some((f) => f.rule === 'validation-modified-worktree'));
      assert.equal(report.task.status, 'failed');
    });

    it('no changes is a failure', async () => {
      const { supervisor } = await setup(async () => ok('nothing to do'));
      const report = await supervisor.execute('T1');
      assert.equal(report.task.status, 'failed');
      assert.ok(report.run.review!.findings.some((f) => f.rule === 'no-changes'));
    });

    it('an unexpected error after start never leaves the task in_progress', async () => {
      fx = await makeFixture();
      class BrokenGit extends GitWorkspace {
        override async snapshot(): Promise<never> {
          throw new Error('disk on fire');
        }
      }
      const logs: string[] = [];
      const supervisor = new Supervisor({
        config: fx.config,
        repository: fx.repository,
        agent: new FakeAgent(writesFile('src/greet.js', GOOD)),
        git: new BrokenGit(fx.config.projectRoot, fx.config.dataDir),
        log: (l) => logs.push(l),
      });
      await assert.rejects(supervisor.execute('T1'), /disk on fire/);
      const t1 = await taskOf(fx, 'T1');
      assert.equal(t1.status, 'failed');
      assert.match(t1.results.at(-1)!.summary, /Unexpected error: disk on fire/);
      const runId = t1.results.at(-1)!.runId!;
      assert.equal((await new RunStore(fx.config.dataDir).load(runId)).state, 'failed');
      assert.equal(await exists(lockPath(fx)), false);
    });
  });

  describe('refusals leave state untouched', () => {
    it('unknown, invalid and ineligible tasks', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD), {
        tasks: [
          makeTask('T1'),
          makeTask('T2', { dependencies: ['T1'] }),
          makeTask('DONE', { status: 'completed' }),
          makeTask('STUCK', { status: 'needs_attention', retryCount: 5 }),
        ],
      });
      const before = await readFile(fx.repository.tasksFile, 'utf8');
      await assert.rejects(supervisor.execute('NOPE'), TaskNotFoundError);
      await assert.rejects(supervisor.execute('../../etc'), ValidationError);
      await assert.rejects(supervisor.execute('T2'), /not eligible: waiting on dependencies: T1/);
      await assert.rejects(supervisor.execute('DONE'), /not eligible: already completed/);
      await assert.rejects(supervisor.execute('STUCK'), /not eligible: needs human attention/);
      assert.equal(await readFile(fx.repository.tasksFile, 'utf8'), before);
      assert.equal(await exists(path.join(fx.config.dataDir, 'worktrees')), false);
      assert.equal(await exists(lockPath(fx)), false);
    });

    it('a task already awaiting review cannot be executed again', async () => {
      const { supervisor } = await setup(writesFile('src/greet.js', GOOD));
      await supervisor.execute('T1');
      await assert.rejects(supervisor.execute('T1'), /not eligible: awaiting human review/);
    });

    it('dirty repositories are refused without touching user changes', async () => {
      const { fx, agent, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      await writeFile(path.join(fx.dir, 'src', 'greet.js'), '// my uncommitted work\n');
      await assert.rejects(supervisor.execute('T1'), (err: unknown) => err instanceof GitIsolationError && /uncommitted changes/.test(err.message));
      assert.equal(await readFile(path.join(fx.dir, 'src', 'greet.js'), 'utf8'), '// my uncommitted work\n');
      assert.equal((await taskOf(fx, 'T1')).status, 'pending');
      assert.deepEqual(agent.calls, []);
      await writeFile(path.join(fx.dir, 'src', 'greet.js'), STUB);
      await writeFile(path.join(fx.dir, 'notes.txt'), 'untracked\n');
      await assert.rejects(supervisor.execute('T1'), /notes.txt/);
      assert.equal(await exists(lockPath(fx)), false);
    });

    it('execution must be enabled and the agent config safe', async () => {
      fx = await makeFixture({ execution: { enabled: false } });
      const make = (cfg: Fixture['config']) =>
        new Supervisor({ config: cfg, repository: fx!.repository, agent: new FakeAgent(writesFile('src/greet.js', GOOD)) });
      await assert.rejects(make(fx.config).execute('T1'), AgentExecutionDisabledError);
      const enabled = { ...fx.config, execution: { ...fx.config.execution, enabled: true } };
      await assert.rejects(make({ ...enabled, agent: { ...enabled.agent, tools: ['Read', 'Bash'] } }).execute('T1'), ExecutionPolicyError);
      await assert.rejects(make({ ...enabled, agent: { ...enabled.agent, permissionMode: 'plan' } }).execute('T1'), ExecutionPolicyError);
      await assert.rejects(make({ ...enabled, execution: { ...enabled.execution, validationCommands: [] } }).execute('T1'), ExecutionPolicyError);
      await assert.rejects(make({ ...enabled, allowedExecutables: [] }).execute('T1'), /not allowlisted/);
      assert.equal((await taskOf(fx, 'T1')).status, 'pending');
    });
  });

  describe('locking and recovery', () => {
    it('concurrent executions: exactly one runs, the other is refused', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { fx, supervisor } = await setup(async (cwd) => {
        await gate;
        return writesFile('src/greet.js', GOOD)(cwd, {});
      });
      const first = supervisor.execute('T1');
      // Wait until the first run holds the lock and is inside the agent.
      while (!(await exists(path.join(fx.config.dataDir, 'worktrees')))) await new Promise((r) => setTimeout(r, 10));
      const other = new Supervisor({ config: fx.config, repository: fx.repository, agent: new FakeAgent(writesFile('src/greet.js', GOOD)) });
      await assert.rejects(other.execute('T1'), LockHeldError);
      await assert.rejects(other.recover(), /still running/);
      release();
      const report = await first;
      assert.equal(report.task.status, 'awaiting_review');
      const t1 = await taskOf(fx, 'T1');
      assert.equal(t1.results.length, 1);
      assert.equal((await readdir(path.join(fx.config.dataDir, 'worktrees'))).length, 1);
    });

    it('a lock held by another live process blocks execute and record', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      const live = { pid: process.pid, hostname: os.hostname(), token: 'other', acquiredAt: new Date().toISOString(), command: 'execute X' };
      await writeFile(lockPath(fx), JSON.stringify(live));
      await assert.rejects(supervisor.execute('T1'), /locked by a running factory process/);
      const orchestrator = new Orchestrator({
        config: fx.config,
        repository: fx.repository,
        agent: new ClaudeCodeAdapter(fx.config.agent, fx.config.limits, fx.config.projectRoot),
        lock: new FileLock(fx.config.dataDir),
      });
      await assert.rejects(orchestrator.recordTaskResult('T1', { outcome: 'success', summary: 'x' }), LockHeldError);
      assert.equal(JSON.parse(await readFile(lockPath(fx), 'utf8')).token, 'other', 'foreign lock must not be removed');
      assert.equal((await taskOf(fx, 'T1')).status, 'pending');
    });

    it('recover fails an interrupted run and archives the dead owner\'s lock', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      // Simulate a factory process that crashed mid-run.
      const pid = deadPid();
      const runs = new RunStore(fx.config.dataDir);
      const runId = '20260101T000000Z-0badc0de';
      await runs.save({
        schemaVersion: 1,
        runId,
        taskId: 'T1',
        state: 'running',
        factoryPid: pid,
        agentPid: pid,
        hostname: os.hostname(),
        startedAt: '2026-01-01T00:00:00.000Z',
        baseCommit: fx.head,
      });
      const tasks = await fx.repository.loadTasks();
      await fx.repository.saveTasks(tasks.map((t) => (t.id === 'T1' ? { ...t, status: 'in_progress' as const, currentRunId: runId } : t)));
      await writeFile(lockPath(fx), JSON.stringify({ pid, hostname: os.hostname(), token: 'dead', acquiredAt: 'x', command: 'execute T1' }));

      await assert.rejects(supervisor.execute('T2'), /no longer running.*recover/s);
      const report = await supervisor.recover();
      assert.match(report.lock, /archived/);
      assert.ok(report.actions.some((a) => /T1: marked "failed"/.test(a)));
      const t1 = await taskOf(fx, 'T1');
      assert.equal(t1.status, 'failed');
      assert.equal(t1.currentRunId, undefined);
      assert.match(t1.results.at(-1)!.summary, /interrupted/);
      assert.equal((await runs.load(runId)).state, 'interrupted');
      assert.equal(await exists(lockPath(fx)), false);
      assert.deepEqual(await readdir(path.join(fx.config.dataDir, 'stale-locks')), ['factory.lock.dead']);
      // Task can be executed again after recovery.
      assert.equal((await supervisor.execute('T1')).task.status, 'awaiting_review');
    });

    it('recover leaves a run alone while its agent process is still alive', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      const runs = new RunStore(fx.config.dataDir);
      const runId = '20260101T000000Z-0000aaaa';
      await runs.save({
        schemaVersion: 1,
        runId,
        taskId: 'T1',
        state: 'running',
        factoryPid: deadPid(),
        agentPid: process.pid, // alive
        hostname: os.hostname(),
        startedAt: 'x',
        baseCommit: fx.head,
      });
      const tasks = await fx.repository.loadTasks();
      await fx.repository.saveTasks(tasks.map((t) => (t.id === 'T1' ? { ...t, status: 'in_progress' as const, currentRunId: runId } : t)));
      const report = await supervisor.recover();
      assert.ok(report.actions.some((a) => /still alive/.test(a)));
      assert.equal((await taskOf(fx, 'T1')).status, 'in_progress');
    });

    it('manual record refuses tasks owned by a supervised run', async () => {
      const { fx, supervisor } = await setup(writesFile('src/greet.js', GOOD));
      await supervisor.execute('T1');
      const orchestrator = new Orchestrator({
        config: fx.config,
        repository: fx.repository,
        agent: new ClaudeCodeAdapter(fx.config.agent, fx.config.limits, fx.config.projectRoot),
        lock: new FileLock(fx.config.dataDir),
      });
      await assert.rejects(orchestrator.recordTaskResult('T1', { outcome: 'success', summary: 'x' }), InvalidTransitionError);
    });
  });
});
