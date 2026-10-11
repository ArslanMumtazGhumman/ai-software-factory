import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommandNotAllowedError } from '../src/core/errors.js';
import { redactSecrets, buildSafeEnv } from '../src/security/redact.js';
import { resolveCommand } from '../src/testing/commandPolicy.js';
import { runCommand } from '../src/testing/commandRunner.js';
import { makeConfig } from './helpers.js';

const root = process.cwd();
const config = makeConfig(root, {
  allowedExecutables: ['node'],
  commands: { version: { executable: 'node', args: ['--version'] } },
});

describe('command allowlist', () => {
  it('resolves configured commands only', () => {
    const cmd = resolveCommand(config, 'version');
    assert.equal(cmd.executable, 'node');
    assert.deepEqual(cmd.args, ['--version']);
    assert.equal(cmd.cwd, root);
    assert.equal(cmd.timeoutMs, config.limits.commandTimeoutMs);
  });

  it('rejects unknown names, including raw command strings', () => {
    for (const name of ['deploy', 'node --version', 'rm -rf .', 'toString', '__proto__']) {
      assert.throws(() => resolveCommand(config, name), CommandNotAllowedError, name);
    }
  });

  it('re-checks the allowlist at run time', () => {
    const tampered = { ...config, allowedExecutables: [] };
    assert.throws(() => resolveCommand(tampered, 'version'), /not allowlisted/);
  });
});

describe('command runner', () => {
  it('runs an allowlisted command without a shell', async () => {
    const result = await runCommand(resolveCommand(config, 'version'));
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), process.version);
    assert.equal(result.timedOut, false);
  });

  it('does not interpret shell metacharacters in arguments', async () => {
    const result = await runCommand({
      ...resolveCommand(config, 'version'),
      args: ['-e', 'console.log(process.argv[1])', 'a && echo injected'],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'a && echo injected');
  });

  it('reports non-zero exit codes without throwing', async () => {
    const result = await runCommand({ ...resolveCommand(config, 'version'), args: ['-e', 'process.exit(3)'] });
    assert.equal(result.exitCode, 3);
  });

  it('enforces the timeout', async () => {
    const result = await runCommand({
      ...resolveCommand(config, 'version'),
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 300,
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
  });

  it('truncates output beyond maxOutputBytes', async () => {
    const result = await runCommand({
      ...resolveCommand(config, 'version'),
      args: ['-e', 'process.stdout.write("x".repeat(5000))'],
      maxOutputBytes: 1024,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 1024);
  });

  it('reports a missing executable as an error result', async () => {
    const result = await runCommand({ ...resolveCommand(config, 'version'), executable: 'definitely-not-a-real-exe-asf' });
    assert.equal(result.exitCode, null);
    assert.match(result.error ?? '', /Failed to start/);
  });

  it('does not pass secrets through the environment', async () => {
    const env = buildSafeEnv({ PATH: 'p', ANTHROPIC_API_KEY: 'sk-ant-secret', GITHUB_TOKEN: 't' });
    assert.deepEqual(env, { PATH: 'p' });
  });
});

describe('secret redaction', () => {
  it('redacts common secret formats', () => {
    const text = 'key sk-ant-api03-abcdefghijklmnop token=hunter2 ghp_abcdefghijklmnopqrstuvwxyz0123 AKIAABCDEFGHIJKLMNOP';
    const out = redactSecrets(text);
    assert.doesNotMatch(out, /sk-ant-api03|hunter2|ghp_|AKIAABCD/);
  });

  it('redacts explicitly provided secret values', () => {
    assert.equal(redactSecrets('value is supersecretvalue', ['supersecretvalue']), 'value is [REDACTED]');
  });
});
