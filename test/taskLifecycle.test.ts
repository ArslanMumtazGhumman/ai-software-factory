import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidTransitionError, ValidationError } from '../src/core/errors.js';
import { parseTaskList } from '../src/tasks/task.js';
import { recordResult, startTask } from '../src/tasks/taskLifecycle.js';
import { makeTask } from './helpers.js';

const times = { startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z' };

describe('task lifecycle', () => {
  it('starts pending and failed tasks only', () => {
    assert.equal(startTask(makeTask('A')).status, 'in_progress');
    assert.equal(startTask(makeTask('A', { status: 'failed' })).status, 'in_progress');
    assert.throws(() => startTask(makeTask('A', { status: 'completed' })), InvalidTransitionError);
    assert.throws(() => startTask(makeTask('A', { status: 'in_progress' })), InvalidTransitionError);
  });

  it('completes a task on success and records the result', () => {
    const original = makeTask('A', { status: 'in_progress' });
    const done = recordResult(original, { outcome: 'success', summary: 'ok', ...times }, 2);
    assert.equal(done.status, 'completed');
    assert.equal(done.results.length, 1);
    assert.deepEqual(done.results[0], { attempt: 1, outcome: 'success', summary: 'ok', ...times });
    assert.equal(original.status, 'in_progress', 'input must not be mutated');
  });

  it('counts failures and escalates once retries are exhausted', () => {
    let task = makeTask('A');
    task = recordResult(task, { outcome: 'failure', summary: 'f1', error: 'boom', ...times }, 2);
    assert.equal(task.status, 'failed');
    assert.equal(task.retryCount, 1);
    assert.equal(task.results[0]!.error, 'boom');
    task = recordResult(task, { outcome: 'failure', summary: 'f2', ...times }, 2);
    assert.equal(task.status, 'failed');
    task = recordResult(task, { outcome: 'failure', summary: 'f3', ...times }, 2);
    assert.equal(task.status, 'needs_attention');
    assert.equal(task.retryCount, 3);
    assert.deepEqual(task.results.map((r) => r.attempt), [1, 2, 3]);
  });

  it('with maxRetries 0 the first failure needs attention', () => {
    const task = recordResult(makeTask('A'), { outcome: 'failure', summary: 'x', ...times }, 0);
    assert.equal(task.status, 'needs_attention');
  });

  it('rejects results for completed or needs_attention tasks', () => {
    for (const status of ['completed', 'needs_attention'] as const) {
      assert.throws(
        () => recordResult(makeTask('A', { status }), { outcome: 'success', summary: 'x', ...times }, 2),
        InvalidTransitionError,
      );
    }
  });
});

describe('task format validation', () => {
  it('applies defaults for optional fields', () => {
    const [task] = parseTaskList([{ id: 'A', title: 't', description: 'd', acceptanceCriteria: ['c'] }]);
    assert.deepEqual(task, {
      id: 'A',
      title: 't',
      description: 'd',
      dependencies: [],
      acceptanceCriteria: ['c'],
      status: 'pending',
      retryCount: 0,
      results: [],
    });
  });

  it('reports every invalid field at once', () => {
    assert.throws(
      () =>
        parseTaskList([
          { id: 'bad id!', title: '', description: 5, acceptanceCriteria: 'x', status: 'done', retryCount: -1 },
        ]),
      (err: unknown) => err instanceof ValidationError && err.issues.length >= 6,
    );
  });

  it('rejects a non-array task list and malformed results', () => {
    assert.throws(() => parseTaskList({}), ValidationError);
    assert.throws(
      () =>
        parseTaskList([
          { id: 'A', title: 't', description: 'd', acceptanceCriteria: ['c'], results: [{ attempt: 1, outcome: 'maybe' }] },
        ]),
      ValidationError,
    );
  });
});
