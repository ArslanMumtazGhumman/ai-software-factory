import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { GitIsolationError } from '../src/core/errors.js';
import { GitWorkspace } from '../src/git/gitWorkspace.js';
import { GOOD, STUB, git, makeFixture, type Fixture } from './gitFixture.js';
import { makeTempDir } from './helpers.js';

describe('git isolation', () => {
  let fx: Fixture | undefined;
  const extra: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await fx?.cleanup();
    fx = undefined;
    for (const c of extra.splice(0)) await c();
  });

  const workspace = (f: Fixture) => new GitWorkspace(f.config.projectRoot, f.config.dataDir);
  const wtPath = (f: Fixture, name = 'run1') => path.join(f.config.dataDir, 'worktrees', name);

  it('accepts a clean repository and ignores the factory data dir', async () => {
    fx = await makeFixture();
    // tasks.json etc. live in the untracked .factory dir; that must not count as dirty.
    assert.deepEqual(await workspace(fx).preflight(), { headCommit: fx.head });
  });

  it('refuses modified, staged and untracked user changes, and never alters them', async () => {
    fx = await makeFixture();
    const ws = workspace(fx);
    await writeFile(path.join(fx.dir, 'src', 'greet.js'), 'mine\n');
    await assert.rejects(ws.preflight(), /uncommitted changes[\s\S]*src\/greet.js/);
    git(fx.dir, 'add', 'src/greet.js');
    await assert.rejects(ws.preflight(), GitIsolationError);
    git(fx.dir, 'reset', '-q');
    await writeFile(path.join(fx.dir, 'src', 'greet.js'), STUB);
    await writeFile(path.join(fx.dir, 'scratch.txt'), 'x');
    await assert.rejects(ws.preflight(), /scratch.txt/);
    assert.equal(await readFile(path.join(fx.dir, 'scratch.txt'), 'utf8'), 'x');
  });

  it('refuses when isolation cannot be guaranteed', async () => {
    fx = await makeFixture();
    // Project root below the repository top level.
    const sub = path.join(fx.dir, 'src');
    await assert.rejects(new GitWorkspace(sub, path.join(sub, '.factory')).preflight(), /repository top level/);
    // Data dir equal to the project root.
    await assert.rejects(new GitWorkspace(fx.dir, fx.dir).preflight(), /subdirectory/);
    // Merge in progress.
    await writeFile(path.join(fx.dir, '.git', 'MERGE_HEAD'), `${fx.head}\n`);
    await assert.rejects(workspace(fx).preflight(), /MERGE_HEAD/);
    await rm(path.join(fx.dir, '.git', 'MERGE_HEAD'));

    // Not a repository / no commits.
    const { dir, cleanup } = await makeTempDir();
    extra.push(cleanup);
    await assert.rejects(new GitWorkspace(dir, path.join(dir, '.factory')).preflight(), /not inside a git repository/);
    git(dir, 'init', '-q');
    await assert.rejects(new GitWorkspace(dir, path.join(dir, '.factory')).preflight(), /no commits/);
  });

  it('creates an isolated worktree on a new branch from the base commit', async () => {
    fx = await makeFixture();
    const ws = workspace(fx);
    const wt = await ws.createWorktree(wtPath(fx), 'T1', '20260101T000000Z-00000001', fx.head);
    assert.equal(wt.branch, 'asf/T1/20260101T000000Z-00000001');
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), fx.head);
    assert.equal(git(fx.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim() !== wt.branch, true, 'user branch unchanged');
    // Changes in the worktree do not leak into the user's working tree.
    await writeFile(path.join(wt.path, 'src', 'greet.js'), GOOD);
    assert.equal(await readFile(path.join(fx.dir, 'src', 'greet.js'), 'utf8'), STUB);
    assert.deepEqual(await ws.uncommittedChanges(), []);
    // Never reuses an existing path or branch.
    await assert.rejects(ws.createWorktree(wtPath(fx), 'T1', '20260101T000000Z-00000001', fx.head), /already exists/);
    await assert.rejects(ws.createWorktree(path.join(fx.dir, 'elsewhere'), 'T1', 'x', fx.head), /outside/);
  });

  it('snapshots added, modified, deleted and ignored files with a stable tree hash', async () => {
    fx = await makeFixture();
    const ws = workspace(fx);
    const wt = await ws.createWorktree(wtPath(fx), 'T1', '20260101T000000Z-00000002', fx.head);
    await writeFile(path.join(wt.path, 'src', 'greet.js'), GOOD);
    await writeFile(path.join(wt.path, 'src', 'new.js'), 'export {};\n');
    await rm(path.join(wt.path, 'package.json'));
    await mkdir(path.join(wt.path, 'build'));
    await writeFile(path.join(wt.path, 'build', 'out.js'), '');
    const s1 = await ws.snapshot(wt.path, fx.head);
    assert.deepEqual(
      s1.changedFiles.map((f) => `${f.status} ${f.path}`).sort(),
      ['A src/new.js', 'D package.json', 'M src/greet.js'],
    );
    assert.deepEqual(s1.ignoredFiles, ['build/out.js']);
    assert.match(s1.patch, /Hello/);
    assert.equal(s1.headCommit, fx.head);
    const s2 = await ws.snapshot(wt.path, fx.head);
    assert.equal(s2.treeSha, s1.treeSha);
    await writeFile(path.join(wt.path, 'src', 'new.js'), 'export const changed = 1;\n');
    assert.notEqual((await ws.snapshot(wt.path, fx.head)).treeSha, s1.treeSha);
  });
});
