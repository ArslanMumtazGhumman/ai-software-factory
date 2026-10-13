import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_AUTONOMY, loadFactoryConfig, parseFactoryConfig } from '../src/config/factoryConfig.js';
import { ValidationError } from '../src/core/errors.js';
import { configFileProtection } from '../src/orchestrator/supervisor.js';
import { makeTempDir } from './helpers.js';

const base = path.resolve('fake-root');
const execution = { enabled: true, validationCommands: ['test'] };
const commands = { test: { executable: 'node', args: ['--test'] } };
const parse = (extra: Record<string, unknown>) =>
  parseFactoryConfig({ version: 1, allowedExecutables: ['node'], commands, execution, ...extra }, base);

describe('autonomy and repair config', () => {
  it('is off by default with bounded defaults', () => {
    const config = parseFactoryConfig({ version: 1 }, base);
    assert.deepEqual(config.autonomy, DEFAULT_AUTONOMY);
    assert.equal(config.autonomy.enabled, false);
    assert.equal(config.autonomy.autoAccept.enabled, false);
    assert.equal(config.execution.maxRepairAttempts, 0);
  });

  it('accepts an explicit, bounded configuration', () => {
    const config = parse({
      agent: { permissionMode: 'dontAsk', maxBudgetUsd: 1 },
      execution: { ...execution, maxRepairAttempts: 2 },
      autonomy: {
        enabled: true,
        maxRunDurationMs: 3_600_000,
        maxTaskDurationMs: 600_000,
        maxCostUsd: 5,
        autoAccept: { enabled: true, taskIds: ['T1', 'docs-2'], paths: ['src', 'docs/'], maxChangedFiles: 3, maxDiffBytes: 4000 },
      },
    });
    assert.equal(config.execution.maxRepairAttempts, 2);
    assert.equal(config.autonomy.maxCostUsd, 5);
    assert.deepEqual(config.autonomy.autoAccept.taskIds, ['T1', 'docs-2']);
  });

  it('rejects unbounded, ambiguous or bypassing settings', () => {
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['too many repairs', { execution: { ...execution, maxRepairAttempts: 4 } }, /maxRepairAttempts must be between 0 and 3/],
      ['autonomy without execution', { execution: { enabled: false }, autonomy: { enabled: true } }, /requires config.execution.enabled/],
      ['cost cap without per-call budget', { autonomy: { enabled: true, maxCostUsd: 2 } }, /requires config.agent.maxBudgetUsd/],
      ['run duration too long', { autonomy: { maxRunDurationMs: 48 * 3_600_000 } }, /maxRunDurationMs must be between/],
      ['unknown autonomy key', { autonomy: { enabled: true, unlimited: true } }, /autonomy.unlimited is not a known setting/],
      ['wildcard task ids', { autonomy: { autoAccept: { enabled: true, taskIds: ['*'], paths: ['src'] } } }, /taskIds\[0\] is not a valid task id/],
      ['whole-repo path', { autonomy: { autoAccept: { enabled: true, taskIds: ['T1'], paths: ['.'] } } }, /paths\[0\] must be a specific/],
      ['escaping path', { autonomy: { autoAccept: { enabled: true, taskIds: ['T1'], paths: ['../other'] } } }, /paths\[0\] must be a specific/],
      ['enabled without scope', { autonomy: { autoAccept: { enabled: true } } }, /requires non-empty taskIds and paths/],
      ['unknown auto-accept key', { autonomy: { autoAccept: { enabled: false, skipChecks: true } } }, /skipChecks is not a known setting/],
      ['huge auto-accept diff', { autonomy: { autoAccept: { maxDiffBytes: 10_000_000 } } }, /maxDiffBytes must be between/],
    ];
    for (const [name, extra, pattern] of bad) {
      assert.throws(() => parse(extra), (err: unknown) => err instanceof ValidationError && pattern.test(err.message), name);
    }
  });

  it('records the config file path and protects it when it is inside the project', async () => {
    const { dir, cleanup } = await makeTempDir();
    try {
      const file = path.join(dir, 'factory.config.json');
      await writeFile(file, JSON.stringify({ version: 1 }));
      const config = await loadFactoryConfig(file);
      assert.equal(config.configFile, file);
      assert.deepEqual(configFileProtection(config), ['factory.config.json']);
      assert.deepEqual(configFileProtection({ ...config, configFile: path.join(path.dirname(dir), 'outside.json') }), []);
    } finally {
      await cleanup();
    }
  });
});
