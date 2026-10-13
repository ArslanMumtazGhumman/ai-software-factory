import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutoAcceptPolicy } from '../src/config/factoryConfig.js';
import type { RunRecord } from '../src/persistence/runStore.js';
import { evaluateAutoAccept } from '../src/review/autoAcceptPolicy.js';
import type { Task } from '../src/tasks/task.js';
import { makeTask } from './helpers.js';

const RUN = '20260101T000000Z-0000abcd';
const policy: AutoAcceptPolicy = { enabled: true, taskIds: ['T1'], paths: ['src', 'test'], maxChangedFiles: 3, maxDiffBytes: 1000 };
const task: Task = { ...makeTask('T1', { title: 'Implement greet', description: 'Make greet friendly' }), status: 'awaiting_review', currentRunId: RUN };

function run(overrides: Partial<RunRecord> = {}, review: Partial<NonNullable<RunRecord['review']>> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId: RUN,
    taskId: 'T1',
    state: 'awaiting_review',
    outcome: 'success',
    factoryPid: 1,
    hostname: 'h',
    startedAt: 's',
    baseCommit: 'b',
    agent: { outcome: 'success', summary: 'ok', exitCode: 0, timedOut: false, durationMs: 1, truncated: false, killFailed: false, stdout: '', stderr: '' },
    validation: [{ name: 'test', executable: 'node', args: ['--test'], exitCode: 0, timedOut: false, durationMs: 1, truncated: false, killFailed: false, stdout: '', stderr: '' }],
    review: {
      headCommit: 'b',
      treeSha: 't',
      diffSha256: 'd',
      diffBytes: 200,
      changedFiles: [{ status: 'M', path: 'src/greet.js', mode: '100644' }],
      ignoredFiles: [],
      findings: [],
      ...review,
    },
    ...overrides,
  };
}

const reasons = (r: RunRecord, t: Task = task, p: AutoAcceptPolicy = policy) => evaluateAutoAccept(p, t, r).reasons.join(' | ');

describe('auto-accept policy', () => {
  it('accepts a small, clean, listed result', () => {
    const decision = evaluateAutoAccept(policy, task, run());
    assert.equal(decision.accept, true);
    assert.match(decision.reasons.join(' '), /checks passed: test/);
  });

  it('is off unless enabled, and only for listed tasks', () => {
    assert.equal(evaluateAutoAccept({ ...policy, enabled: false }, task, run()).accept, false);
    const other = { ...task, id: 'T9' };
    assert.match(reasons(run({ taskId: 'T9' }), other), /not listed/);
  });

  it('defaults to a human for every risk signal', () => {
    const cases: [string, RunRecord, RegExp][] = [
      ['repairs', run({ repairs: [{ attempt: 1, startedAt: 's', finishedAt: 'f', failedValidation: [], agent: run().agent! }] }), /repair attempt/],
      ['warning finding', run({}, { findings: [{ severity: 'warning', rule: 'gitignore', message: 'x' }] }), /finding/],
      ['too many files', run({}, { changedFiles: ['a', 'b', 'c', 'd'].map((n) => ({ status: 'A', path: `src/${n}.js`, mode: '100644' })) }), /4 files changed/],
      ['diff size', run({}, { diffBytes: 5000 }), /diff is 5000 bytes/],
      ['deletion', run({}, { changedFiles: [{ status: 'D', path: 'src/old.js', mode: '100644' }] }), /change type D/],
      ['executable', run({}, { changedFiles: [{ status: 'A', path: 'src/run.js', mode: '100755' }] }), /file mode 100755/],
      ['outside paths', run({}, { changedFiles: [{ status: 'M', path: 'docs/readme.md', mode: '100644' }] }), /outside config.autonomy.autoAccept.paths/],
      ['sensitive path', run({}, { changedFiles: [{ status: 'A', path: 'src/auth/login.js', mode: '100644' }] }), /looks security-sensitive/],
      ['failed check', run({ validation: [{ ...run().validation![0]!, exitCode: 1 }] }), /not every configured check/],
      ['no checks', run({ validation: [] }), /not every configured check/],
      ['permission denials', run({ agent: { ...run().agent!, permissionDenials: 2 } }), /permission denial/],
      ['failed run', run({ outcome: 'failure', state: 'failed' }), /did not pass/],
    ];
    for (const [name, r, pattern] of cases) {
      const decision = evaluateAutoAccept(policy, task, r);
      assert.equal(decision.accept, false, name);
      assert.match(decision.reasons.join(' | '), pattern, name);
    }
  });

  it('security-sensitive task text needs a human', () => {
    for (const text of ['Add OAuth login', 'Rotate the API key', 'Update the deployment script', 'Encrypt stored notes', 'Change the database migration']) {
      const sensitive = { ...task, description: text };
      assert.equal(evaluateAutoAccept(policy, sensitive, run()).accept, false, text);
    }
  });
});
