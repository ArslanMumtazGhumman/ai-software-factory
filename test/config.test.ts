import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_LIMITS, loadFactoryConfig, parseFactoryConfig } from '../src/config/factoryConfig.js';
import { PersistenceError, ValidationError } from '../src/core/errors.js';

const base = path.resolve('fake-root');

describe('factory config', () => {
  it('applies defaults', () => {
    const config = parseFactoryConfig({ version: 1 }, base);
    assert.equal(config.projectRoot, base);
    assert.equal(config.dataDir, path.join(base, '.factory'));
    assert.deepEqual(config.limits, DEFAULT_LIMITS);
    assert.deepEqual(config.commands, {});
    assert.equal(config.agent.permissionMode, 'plan');
  });

  it('accepts allowlisted commands', () => {
    const config = parseFactoryConfig(
      { version: 1, allowedExecutables: ['node'], commands: { test: { executable: 'node', args: ['--test'] } } },
      base,
    );
    assert.deepEqual(config.commands.test, { executable: 'node', args: ['--test'] });
  });

  it('rejects commands whose executable is not allowlisted', () => {
    assert.throws(
      () => parseFactoryConfig({ version: 1, allowedExecutables: [], commands: { test: { executable: 'node' } } }, base),
      /not in config.allowedExecutables/,
    );
  });

  it('rejects executables that are paths or shell snippets', () => {
    for (const exe of ['C:\\Windows\\System32\\cmd.exe', '../bin/tool', 'rm -rf /', 'a&&b']) {
      assert.throws(
        () => parseFactoryConfig({ version: 1, allowedExecutables: [exe] }, base),
        ValidationError,
        `should reject ${exe}`,
      );
    }
  });

  it('enforces limit bounds and unknown limits', () => {
    assert.throws(() => parseFactoryConfig({ version: 1, limits: { maxRetries: 99 } }, base), /maxRetries must be between/);
    assert.throws(() => parseFactoryConfig({ version: 1, limits: { maxTasksPerRun: 0 } }, base), ValidationError);
    assert.throws(() => parseFactoryConfig({ version: 1, limits: { commandTimeoutMs: 1.5 } }, base), /integer/);
    assert.throws(() => parseFactoryConfig({ version: 1, limits: { unlimited: true } }, base), /not a known limit/);
  });

  it('keeps the data directory inside the project root', () => {
    assert.throws(() => parseFactoryConfig({ version: 1, dataDir: '../elsewhere' }, base), /must stay inside/);
  });

  it('rejects wrong versions, non-objects and bad agent settings', () => {
    assert.throws(() => parseFactoryConfig({ version: 2 }, base), /version must be 1/);
    assert.throws(() => parseFactoryConfig([], base), ValidationError);
    assert.throws(() => parseFactoryConfig({ version: 1, agent: { permissionMode: 'bypassPermissions' } }, base), /permissionMode/);
  });

  it('reports a missing config file clearly', async () => {
    await assert.rejects(loadFactoryConfig(path.join(base, 'nope.json')), PersistenceError);
  });
});
