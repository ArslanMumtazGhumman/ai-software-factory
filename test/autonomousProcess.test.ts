import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { LockHeldError } from '../src/core/errors.js';
import { AutonomousRunner } from '../src/orchestrator/autonomousRunner.js';
import { Supervisor } from '../src/orchestrator/supervisor.js';
import type { AutoRunRecord } from '../src/persistence/autoRunStore.js';
import { FileLock } from '../src/persistence/fileLock.js';
import { RunStore } from '../src/persistence/runStore.js';
import { killProcessTree } from '../src/security/processTree.js';
import { FakeAgent, chainAgent, git, makeChainFixture, type Fixture } from './gitFixture.js';
import { makeTempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'support', 'autoChild.js');
const CLI = path.join(here, '..', 'src', 'cli.js');
const exists = (p: string) => access(p).then(() => true, () => false);

async function waitFor(p: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await exists(p))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${p}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

/** Run the real CLI against a config file; never invokes the coding agent in these tests. */
function cli(configFile: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--config', configFile], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('autonomous runs across processes', () => {
  let fx: Fixture | undefined;
  let scratch: { dir: string; cleanup: () => Promise<void> } | undefined;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child?.pid !== undefined && child.exitCode === null) await killProcessTree(child.pid);
    await fx?.cleanup();
    await scratch?.cleanup();
    fx = undefined;
    scratch = undefined;
    child = undefined;
  });

  async function startChild(hold: Record<string, 'wait' | 'hang'>) {
    fx = await makeChainFixture();
    scratch = await makeTempDir();
    const signalDir = path.join(scratch.dir, 'signals');
    await mkdir(signalDir);
    // Config file outside the repository for the CLI (projectRoot absolute).
    const configFile = path.join(scratch.dir, 'factory.config.json');
    await writeFile(configFile, JSON.stringify({ ...fx.rawConfig, projectRoot: fx.dir }));
    const specFile = path.join(scratch.dir, 'spec.json');
    await writeFile(specFile, JSON.stringify({ dir: fx.dir, config: fx.rawConfig, signalDir, hold }));
    child = spawn(process.execPath, [CHILD, specFile], { stdio: 'ignore', windowsHide: true });
    return { fx, signalDir, configFile };
  }

  function inProcess(f: Fixture) {
    const lock = new FileLock(f.config.dataDir);
    const agent = new FakeAgent(chainAgent);
    const supervisor = new Supervisor({ config: f.config, repository: f.repository, agent, lock });
    return { agent, supervisor, runner: new AutonomousRunner({ config: f.config, repository: f.repository, supervisor, lock }) };
  }

  it('CLI shows the running task, refuses concurrent work, and pauses the runner at the next boundary', async () => {
    const { fx, signalDir, configFile } = await startChild({ T1: 'wait' });
    await waitFor(path.join(signalDir, 'started-T1'));

    const status = cli(configFile, 'auto', 'status');
    assert.equal(status.code, 0, status.out);
    assert.match(status.out, /: RUNNING/);
    assert.match(status.out, /Current:\s+T1 \(run \d{8}T\d{6}Z-[0-9a-f]{8}\)/);

    const execute = cli(configFile, 'execute', 'T2');
    assert.equal(execute.code, 1);
    assert.match(execute.out, /LOCK_HELD.*locked by a running factory process/s);
    const start = cli(configFile, 'auto', 'start');
    assert.equal(start.code, 1);
    assert.match(start.out, /LOCK_HELD/);

    const pause = cli(configFile, 'auto', 'pause');
    assert.match(pause.out, /Pause requested .* after the current task \(T1\)/);
    await writeFile(path.join(signalDir, 'release-T1'), '');
    assert.equal(await exited(child!), 0);

    const record = JSON.parse(await readFile(path.join(signalDir, 'result.json'), 'utf8')) as AutoRunRecord;
    assert.equal(record.state, 'paused');
    assert.equal(record.stop?.reason, 'pause-requested');
    assert.deepEqual(record.executions.map((e) => [e.taskId, e.result]), [['T1', 'auto-accepted']]);

    const after = cli(configFile, 'auto', 'status');
    assert.match(after.out, /: PAUSED/);
    assert.match(after.out, /Last done:\s+T1 \(accepted by policy/);
    assert.match(after.out, /Next step:\s+Continue with "factory auto resume"/);
    assert.match(cli(configFile, 'auto', 'history').out, /paused\s+pause-requested\s+1 task\(s\): T1=auto-accepted/);
    assert.match(cli(configFile, 'auto', 'show').out, /\[control\] pause requested/);

    // Resume in this process; the remaining tasks run on top of T1's commit.
    const resumed = await inProcess(fx).runner.resume();
    assert.equal(resumed.state, 'completed');
    assert.equal(git(fx.dir, 'show', `${resumed.tip}:src/both.js`).length > 0, true);
    const stop = cli(configFile, 'auto', 'stop');
    assert.match(stop.out, /no active autonomous run/);
  });

  it('recovers from a killed runner without duplicating or blindly repeating the interrupted task', async () => {
    const { fx, signalDir, configFile } = await startChild({ T1: 'hang' });
    await waitFor(path.join(signalDir, 'started-T1'));
    const { agent, runner } = inProcess(fx);

    // While it runs: nothing else may start or recover.
    await assert.rejects(runner.start(), LockHeldError);
    await assert.rejects(runner.recover(), /still running/);
    assert.equal((await runner.status()).ownerAlive, true);

    const killed = await killProcessTree(child!.pid!);
    assert.equal(killed.ok, true, killed.detail);
    await exited(child!);

    assert.equal((await runner.status()).ownerAlive, false);
    assert.match(cli(configFile, 'auto', 'status').out, /NOT RUNNING \(run "factory recover"\)/);
    await assert.rejects(runner.resume(), /no longer running.*recover/s);

    const recover = cli(configFile, 'recover');
    assert.equal(recover.code, 0, recover.out);
    assert.match(recover.out, /stale lock from dead pid \d+ archived/);
    assert.match(recover.out, /T1: marked "failed" \(interrupted run/);
    assert.match(recover.out, /autonomous run .*: marked paused \(interrupted\)/);

    const t1 = (await fx.repository.loadTasks()).find((t) => t.id === 'T1')!;
    assert.equal(t1.status, 'failed');
    assert.equal(t1.retryCount, 1);
    const interruptedRun = await new RunStore(fx.config.dataDir).load(t1.results.at(-1)!.runId!);
    assert.equal(interruptedRun.state, 'interrupted');
    assert.ok(await exists(interruptedRun.worktreePath!), 'worktree preserved for inspection');

    // The uncertain task is not repeated automatically.
    const paused = await runner.resume();
    assert.equal(paused.stop?.reason, 'task-failed');
    assert.equal(agent.calls.length, 0);
    assert.deepEqual(paused.executions.map((e) => e.result), ['interrupted']);

    // Only after an explicit decision.
    const done = await runner.resume({ retryFailed: true });
    assert.equal(done.state, 'completed');
    assert.deepEqual(agent.requests.map((r) => r.task.id), ['T1', 'T2', 'T3']);
    assert.deepEqual(done.executions.map((e) => [e.taskId, e.result]), [
      ['T1', 'interrupted'],
      ['T1', 'auto-accepted'],
      ['T2', 'auto-accepted'],
      ['T3', 'auto-accepted'],
    ]);
  });
});
