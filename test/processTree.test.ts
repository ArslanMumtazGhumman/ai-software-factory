import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isProcessAlive } from '../src/security/processTree.js';
import { runCommand } from '../src/testing/commandRunner.js';
import { deadPid } from './gitFixture.js';

const base = { name: 'node', executable: 'node', cwd: process.cwd(), timeoutMs: 30_000, maxOutputBytes: 64 * 1024 };
const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

describe('process supervision', () => {
  it('detects live and dead processes', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(deadPid()), false);
    assert.equal(isProcessAlive(-1), false);
  });

  it('delivers stdin and reports the spawned pid', async () => {
    let pid: number | undefined;
    const result = await runCommand(
      { ...base, args: ['-e', "process.stdin.on('data', d => process.stdout.write(d.toString().toUpperCase()))"] },
      { stdin: 'hello prompt', onSpawn: (p) => (pid = p) },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'HELLO PROMPT');
    assert.ok(typeof pid === 'number' && pid > 0);
  });

  it('passes only explicitly forwarded variables and redacts their values', async () => {
    const result = await runCommand(
      { ...base, args: ['-e', 'console.log(process.env.MY_TOKEN_VAR, process.env.HOME_SECRET ?? "absent")'] },
      { extraEnv: { MY_TOKEN_VAR: 'super-secret-value-123' }, secrets: ['super-secret-value-123'] },
    );
    assert.equal(result.stdout.trim(), '[REDACTED] absent');
  });

  it('kills the whole process tree on timeout, including grandchildren', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      'console.log(c.pid);',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const result = await runCommand({ ...base, args: ['-e', script], timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.killFailed, undefined);
    const grandchild = Number(result.stdout.trim());
    assert.ok(grandchild > 0, `expected grandchild pid, got "${result.stdout}"`);
    assert.ok(await waitFor(() => !isProcessAlive(grandchild)), `grandchild ${grandchild} survived`);
  });
});
