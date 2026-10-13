import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ClaudeCodeAdapter } from '../src/agents/claudeCodeAdapter.js';
import { REPAIR_OUTPUT_CHARS, buildRepairPrompt } from '../src/agents/promptBuilder.js';
import { GitIsolationError } from '../src/core/errors.js';
import { GitWorkspace } from '../src/git/gitWorkspace.js';
import { Supervisor } from '../src/orchestrator/supervisor.js';
import { makeConfig, makeTask, sampleProject } from './helpers.js';
import { FakeAgent, GOOD, STUB, chainAgent, git, makeChainFixture, type Fixture } from './gitFixture.js';

describe('accepted work is committed and stacked', () => {
  let fx: Fixture | undefined;
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
  });

  it('accept commits exactly the reviewed tree on the factory branch only', async () => {
    fx = await makeChainFixture();
    const supervisor = new Supervisor({ config: fx.config, repository: fx.repository, agent: new FakeAgent(chainAgent) });
    const { run } = await supervisor.execute('T1');
    const { run: accepted } = await supervisor.accept('T1');
    const commit = accepted.acceptedCommit!;
    assert.match(commit, /^[0-9a-f]{40}$/);
    assert.equal(git(fx.dir, 'rev-parse', `${commit}^{tree}`).trim(), run.review!.treeSha);
    assert.equal(git(fx.dir, 'rev-parse', `${commit}^`).trim(), fx.head);
    assert.equal(git(fx.dir, 'rev-parse', `refs/heads/${run.branch}`).trim(), commit);
    assert.match(git(fx.dir, 'log', '-1', '--format=%s%n%b', commit), /\[asf\] T1: Implement greet[\s\S]*Accepted-by: human/);
    assert.equal(git(run.worktreePath!, 'status', '--porcelain').trim(), '');
    // The user's branch, HEAD and files are untouched.
    assert.equal(git(fx.dir, 'rev-parse', 'HEAD').trim(), fx.head);
    assert.equal(await readFile(path.join(fx.dir, 'src', 'greet.js'), 'utf8'), STUB);
  });

  it('a manual execute of a dependant builds on the dependency commit', async () => {
    fx = await makeChainFixture();
    const agent = new FakeAgent(chainAgent);
    const supervisor = new Supervisor({ config: fx.config, repository: fx.repository, agent });
    await supervisor.execute('T1');
    const { run: t1 } = await supervisor.accept('T1');
    const { run: t2 } = await supervisor.execute('T2');
    assert.equal(t2.baseCommit, t1.acceptedCommit);
    assert.equal(t2.outcome, 'success');
    // core.autocrlf may convert line endings on checkout; compare content.
    assert.equal((await readFile(path.join(t2.worktreePath!, 'src', 'greet.js'), 'utf8')).replace(/\r\n/g, '\n'), GOOD);
  });

  it('refuses to build on a base that has diverged from an accepted dependency', async () => {
    fx = await makeChainFixture();
    const supervisor = new Supervisor({ config: fx.config, repository: fx.repository, agent: new FakeAgent(chainAgent) });
    await supervisor.execute('T1');
    await supervisor.accept('T1');
    // An unrelated commit that does not contain T1's work.
    git(fx.dir, 'checkout', '-q', '-b', 'other');
    await writeFile(path.join(fx.dir, 'notes.txt'), 'x\n');
    git(fx.dir, 'add', 'notes.txt');
    git(fx.dir, 'commit', '-q', '-m', 'other work');
    const other = git(fx.dir, 'rev-parse', 'HEAD').trim();
    await assert.rejects(supervisor.execute('T2', { baseCommit: other }), (err: unknown) => err instanceof GitIsolationError && /diverged/.test(err.message));
    await assert.rejects(supervisor.execute('T2', { baseCommit: 'main' }), /not a full commit id/);
    assert.equal((await fx.repository.loadTasks()).find((t) => t.id === 'T2')!.status, 'pending');
  });

  it('accept is safe to repeat after a commit whose recording did not finish', async () => {
    fx = await makeChainFixture();
    const supervisor = new Supervisor({ config: fx.config, repository: fx.repository, agent: new FakeAgent(chainAgent) });
    const { run } = await supervisor.execute('T1');
    const gitWs = new GitWorkspace(fx.config.projectRoot, fx.config.dataDir);
    const early = await gitWs.commitReviewed(run.worktreePath!, run.branch!, run.review!.treeSha, run.baseCommit, 'partial');
    const { run: accepted } = await supervisor.accept('T1');
    assert.equal(accepted.acceptedCommit, early);
    await assert.rejects(gitWs.commitReviewed(run.worktreePath!, 'main', run.review!.treeSha, run.baseCommit, 'x'), /non-factory branch/);
  });
});

describe('repair prompt', () => {
  const task = makeTask('T1', { acceptanceCriteria: ['greet returns Hello'] });
  const repair = {
    attempt: 1,
    maxAttempts: 2,
    failures: [{ name: 'test', command: 'node --test', exitCode: 1, timedOut: false, output: 'AssertionError: expected Hello\napi_key=abcdef123456' }],
  };

  it('includes the task, its criteria, the rules and the failing output as untrusted data', () => {
    const prompt = buildRepairPrompt(sampleProject, task, repair);
    assert.match(prompt, /## Task T1/);
    assert.match(prompt, /- greet returns Hello/);
    assert.match(prompt, /## Repair attempt 1 of 2/);
    assert.match(prompt, /Check "test" \(node --test\) failed: exit code 1/);
    assert.match(prompt, /<<<CHECK_OUTPUT\nAssertionError: expected Hello/);
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /Do not delete, skip, weaken/);
    assert.doesNotMatch(prompt, /abcdef123456/);
  });

  it('bounds the output sent back', () => {
    const long = { ...repair, failures: [{ ...repair.failures[0]!, output: `${'x'.repeat(50_000)}END` }] };
    const prompt = buildRepairPrompt(sampleProject, task, long);
    assert.ok(prompt.length < REPAIR_OUTPUT_CHARS + 5000);
    assert.match(prompt, /earlier output omitted[\s\S]*END/);
  });

  it('the Claude adapter sends the repair prompt on stdin with the same hardened flags', () => {
    const config = makeConfig(path.resolve('root'), { agent: { permissionMode: 'dontAsk' } });
    const adapter = new ClaudeCodeAdapter(config.agent, config.limits, config.projectRoot);
    const normal = adapter.plan({ project: sampleProject, task, workingDirectory: config.projectRoot });
    const repairing = adapter.plan({ project: sampleProject, task, workingDirectory: config.projectRoot, repair });
    assert.deepEqual(repairing.args, normal.args);
    assert.match(repairing.stdin, /Repair attempt 1 of 2/);
    assert.doesNotMatch(normal.stdin, /Repair attempt/);
  });
});
