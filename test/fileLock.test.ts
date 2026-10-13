import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LockHeldError } from '../src/core/errors.js';
import { FileLock } from '../src/persistence/fileLock.js';
import { deadPid } from './gitFixture.js';
import { makeTempDir } from './helpers.js';

const exists = (p: string) => access(p).then(() => true, () => false);
const lockModule = fileURLToPath(new URL('../src/persistence/fileLock.js', import.meta.url));

describe('cross-process file lock', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('acquires, records the owner, and releases', async () => {
    const lock = new FileLock(dir);
    const handle = await lock.acquire('execute T1');
    const state = await lock.inspect();
    assert.equal(state.state, 'held');
    if (state.state === 'held') {
      assert.equal(state.info.pid, process.pid);
      assert.equal(state.info.command, 'execute T1');
      assert.equal(state.owner, 'alive');
    }
    await handle.release();
    assert.equal((await lock.inspect()).state, 'free');
    await handle.release(); // idempotent
  });

  it('only one of many simultaneous attempts wins', async () => {
    const lock = new FileLock(dir);
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => lock.acquire(`attempt ${i}`)));
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1);
    for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof LockHeldError);
  });

  it('release never removes a lock that is no longer ours', async () => {
    const lock = new FileLock(dir);
    const handle = await lock.acquire('mine');
    await writeFile(lock.lockPath, JSON.stringify({ pid: 1, hostname: 'x', token: 'theirs', acquiredAt: 'x', command: 'x' }));
    await handle.release();
    assert.equal(JSON.parse(await readFile(lock.lockPath, 'utf8')).token, 'theirs');
  });

  it('a lock held by another process blocks acquisition until that process exits', async () => {
    const script = [
      `const { FileLock } = await import(${JSON.stringify(new URL(`file:///${lockModule.replace(/\\/g, '/')}`).href)});`,
      `const h = await new FileLock(${JSON.stringify(dir)}).acquire('child');`,
      "process.stdout.write('ACQUIRED\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (d: Buffer) => d.toString().includes('ACQUIRED') && resolve());
        child.on('exit', () => reject(new Error('child exited early')));
      });
      const lock = new FileLock(dir);
      await assert.rejects(lock.acquire('parent'), /locked by a running factory process \(pid \d+/);
      await assert.rejects(lock.breakStaleLock(), LockHeldError);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    // The child died without releasing: the lock is now stale, but still blocks.
    const lock = new FileLock(dir);
    const state = await lock.inspect();
    assert.ok(state.state === 'held' && state.owner === 'dead');
    await assert.rejects(lock.acquire('parent'), /no longer running.*recover/s);
    // Explicit recovery archives (does not delete) the stale lock.
    const archive = await lock.breakStaleLock();
    assert.ok(await exists(archive));
    const handle = await lock.acquire('parent');
    await handle.release();
  });

  it('treats dead same-host owners as stale but other hosts as unknown', async () => {
    const lock = new FileLock(dir);
    await writeFile(lock.lockPath, JSON.stringify({ pid: deadPid(), hostname: os.hostname(), token: 't1', acquiredAt: 'x', command: 'c' }));
    const s1 = await lock.inspect();
    assert.ok(s1.state === 'held' && s1.owner === 'dead');
    await writeFile(lock.lockPath, JSON.stringify({ pid: deadPid(), hostname: 'some-other-host', token: 't2', acquiredAt: 'x', command: 'c' }));
    const s2 = await lock.inspect();
    assert.ok(s2.state === 'held' && s2.owner === 'unknown-host');
    await assert.rejects(lock.breakStaleLock(), /another host/);
    await assert.rejects(lock.acquire('x'), /another host/);
  });

  it('refuses to guess about an unreadable lock file', async () => {
    const lock = new FileLock(dir);
    await writeFile(lock.lockPath, '');
    assert.equal((await lock.inspect()).state, 'unreadable');
    await assert.rejects(lock.acquire('x'), /unreadable/);
    await assert.rejects(lock.breakStaleLock(), /unreadable/);
    assert.deepEqual(await readdir(dir), ['factory.lock']);
  });
});
